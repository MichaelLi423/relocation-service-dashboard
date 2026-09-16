"""本地聚焦单元测试：scripts/rotate-mobile-readonly.py。

安全底线：所有用例继承 OfflineTestCase，其 setUp 把 `deploy._exec` 换成抛错桩——
任何未被用例显式 mock 的 SSH/Keychain/curl 真实出口都会立刻 AssertionError（failguard）。
远端 helper 逻辑在合成 temp 目录中以本地命令真实执行（CID/inspect/restart 均替换为本地进程）。

运行：
  python3 -m unittest discover -s tests/deployment -p 'test_mobile_readonly_rotate.py'
"""

import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO = Path(__file__).resolve().parents[2]
_ROTATE = _REPO / "scripts" / "rotate-mobile-readonly.py"


def load_rotate():
    spec = importlib.util.spec_from_file_location("mrrotate", _ROTATE)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载轮换脚本")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mrrotate"] = mod
    spec.loader.exec_module(mod)
    return mod


rot = load_rotate()
dpl = rot.deploy


class UnhandledExternal(AssertionError):
    """任何未被显式 mock 的真实外部出口（SSH/security/curl）都会触发本异常。"""


class ExecResultStub:
    def __init__(self, rc=0, out=b"", err=b"", timed_out=False):
        self.rc = rc
        self.out = out
        self.err = err
        self.timed_out = timed_out

    def text(self):
        return self.out.decode("utf-8", "replace")


def q(path):
    return shlex.quote(path)


def exact(shell):
    return lambda got: got == shell


def python_source(shell):
    import ast
    parts = shlex.split(shell)
    if len(parts) != 3 or parts[0] != "python3" or parts[1] != "-c":
        raise AssertionError("不是 python3 -c 形状: %r" % shell)
    for node in ast.walk(ast.parse(parts[2])):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "base64"
                and node.func.attr == "b64decode" and len(node.args) == 1
                and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)):
            return base64.b64decode(node.args[0].value).decode("utf-8")
    raise AssertionError("-c 源码未含 base64.b64decode 常量")


def strict_fake(handlers):
    def fake(shell, stdin=None, timeout=120):
        for matcher, result in handlers:
            if matcher(shell):
                if isinstance(result, ExecResultStub):
                    return result
                return result(shell, stdin)
        raise AssertionError("未注册的 shell: %r" % shell)
    return fake


def make_digest(secret, salt=b"0123456789abcdef", n=16384, r=8, p=1, klen=64):
    h = hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=klen)
    return "scrypt$%d$%d$%d$%d$%s$%s" % (
        n, r, p, klen, base64.b64encode(salt).decode(), base64.b64encode(h).decode())


def digest_string(salt=b"0123456789abcdef", n=16384, r=8, p=1, klen=64, hashbytes=None):
    if hashbytes is None:
        hashbytes = b"\x01" * klen
    return "scrypt$%d$%d$%d$%d$%s$%s" % (
        n, r, p, klen, base64.b64encode(salt).decode(), base64.b64encode(hashbytes).decode())


def creds_bytes(viewer_secret, upload_secret):
    return rot.new_credentials_bytes(viewer_secret, upload_secret)


class OfflineTestCase(unittest.TestCase):
    """全局离线 failguard：未显式 mock 的真实外部出口一律立即失败。"""

    def setUp(self):
        self._exec_patcher = mock.patch.object(
            dpl, "_exec", side_effect=UnhandledExternal("attempted real external exec"))
        self._exec_patcher.start()
        self.addCleanup(self._exec_patcher.stop)

    def assert_no_secret(self, secret, *texts):
        for text in texts:
            if text is None:
                continue
            if isinstance(text, bytes):
                text = text.decode("utf-8", "replace")
            self.assertNotIn(secret, text)


# ---------------------------------------------------------------------------
# helper 运行环境（合成 temp + 本地命令替换 docker）
# ---------------------------------------------------------------------------

class HelperEnv:
    def __init__(self):
        self.td = tempfile.mkdtemp()
        self.root = self.td  # 受信根（替代生产 "/"；避开 macOS /var 符号链接）
        self.uid = os.getuid()
        self.gid = os.getgid()
        # 业务根 base 与 data 必须是不同目录，data 是 base 的子目录（防同目录遮 bug）
        self.base = os.path.join(self.td, "optbase")
        os.mkdir(self.base, 0o700)
        self.base_marker = os.path.join(self.base, ".deploy-managed")
        self._write(self.base_marker, b"relocation-mobile-readonly\n", 0o600)
        self.data = os.path.join(self.base, "data")
        os.mkdir(self.data, 0o700)
        self.snap_dir = os.path.join(self.data, "snapshots")
        os.mkdir(self.snap_dir, 0o755)  # 服务自建（store.ts mkdirSync 递归默认 0755）
        self.snap = os.path.join(self.snap_dir, "current.json")
        self._write(self.snap, b'{"business":"sensitive"}\n', 0o600)
        self.target = os.path.join(self.data, "credentials.json")
        self.old = b'{"old":1}\n'
        self.new = b'{"new":2}\n'
        self._write(self.target, self.old, 0o600)
        self.rot = os.path.join(self.td, "rot")
        os.mkdir(self.rot, 0o700)
        self.marker = os.path.join(self.rot, "marker")
        self._write(self.marker, b"relocation-mobile-readonly-rotate\n", 0o600)
        self.lock = os.path.join(self.rot, "lock")
        self._write(self.lock, b"", 0o600)
        self.active = os.path.join(self.rot, ".active")
        self.inspect = json.dumps([{
            "Id": "ctr123", "State": {"Status": "running"}, "Image": "img",
            "Config": {"User": "1000:1000"}, "HostConfig": {}, "Mounts": [],
        }])
        self.txn = "a" * 32
        self.restart_log = os.path.join(self.td, "restart.log")

    def _write(self, path, data, mode):
        with open(path, "wb") as fh:
            fh.write(data)
        os.chmod(path, mode)

    def config_hash(self, inspect=None):
        obj = json.loads(inspect if inspect is not None else self.inspect)[0]
        pick = {k: obj.get(k) for k in ("Image", "Config", "HostConfig", "Mounts")}
        return hashlib.sha256(json.dumps(pick, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def snapshot_hash(self, data=None):
        if data is None:
            with open(self.snap, "rb") as fh:
                data = fh.read()
        return hashlib.sha256(data).hexdigest()

    def target_hash(self, data=None):
        if data is None:
            with open(self.target, "rb") as fh:
                data = fh.read()
        return hashlib.sha256(data).hexdigest()

    def restart_cmd(self):
        return [sys.executable, "-c",
                "import sys;open(%r,'a').write('restarted\\n')" % self.restart_log]

    def cid_cmd(self, cid="ctr123"):
        return [sys.executable, "-c", "print(%r)" % cid]

    def inspect_cmd(self, inspect=None):
        return [sys.executable, "-c", "print(%r)" % (inspect if inspect is not None else self.inspect)]

    def runtime(self, status):
        obj = json.loads(self.inspect)[0]
        obj["State"]["Status"] = status
        return [sys.executable, "-c", "print(%r)" % json.dumps([obj])]

    def cleaned(self):
        import shutil
        shutil.rmtree(self.td, ignore_errors=True)

    def kwargs(self, **over):
        if "expected_snapshot_hash" in over:
            expected_snapshot_hash = over.pop("expected_snapshot_hash")
        else:
            expected_snapshot_hash = self.snapshot_hash()
        base = dict(
            container="relocation-mobile-readonly", target=self.target, target_parent=self.data,
            target_owner=(self.uid, self.gid), target_mode=0o600,
            data_base=self.base, data_marker=self.base_marker,
            data_marker_value="relocation-mobile-readonly",
            data_owner=(self.uid, self.gid), data_mode=0o700,
            snapshot=self.snap, expected_snapshot_hash=expected_snapshot_hash,
            snapshot_owner=(self.uid, self.gid), snapshot_mode=0o600,
            directory=self.rot, marker=self.marker, value="relocation-mobile-readonly-rotate",
            lock=self.lock, active=self.active, uid=self.uid, root=self.root,
            cid_cmd=self.cid_cmd(), inspect_cmd=self.inspect_cmd(),
        )
        base.update(over)
        return base


def run_remote_apply_local(env, *, mode, txn_id, expected_old, expected_new, payload,
                           restart, owner, restart_gate="apply",
                           expected_runtime="running", **over):
    """在本地真实执行远端 helper（本地命令替换 docker）。"""
    def local_remote(shell, stdin=None, timeout=120):
        proc = subprocess.run([sys.executable, "-c", python_source(shell)],
                              input=stdin, capture_output=True, timeout=timeout)
        return ExecResultStub(proc.returncode, proc.stdout, proc.stderr)
    kwargs = env.kwargs(**over)
    expected_cid = kwargs.pop("expected_cid", "ctr123")
    expected_config_hash = kwargs.pop("expected_config_hash", env.config_hash())
    snapshot_hash = kwargs.pop("expected_snapshot_hash")
    snapshot_owner = kwargs.pop("snapshot_owner")
    snapshot_mode = kwargs.pop("snapshot_mode")
    with mock.patch.object(dpl, "remote_exec", side_effect=local_remote):
        return rot.run_remote_apply(
            mode=mode, txn_id=txn_id, expected_old=expected_old, expected_new=expected_new,
            payload=payload, restart=restart, owner=owner, restart_gate=restart_gate,
            expected_runtime=expected_runtime,
            expected_cid=expected_cid, expected_config_hash=expected_config_hash,
            snapshot_hash=snapshot_hash, snapshot_owner=snapshot_owner,
            snapshot_mode=snapshot_mode, **kwargs)


def run_prepare_local(env, *, fresh_dir=None, uid=None, parent=None):
    directory = fresh_dir if fresh_dir is not None else env.rot
    code = rot.render_remote_prepare(
        directory=directory, marker=os.path.join(directory, "marker") if fresh_dir else env.marker,
        value="relocation-mobile-readonly-rotate",
        lock=os.path.join(directory, "lock") if fresh_dir else env.lock,
        parent=parent if parent is not None else os.path.dirname(directory),
        uid=uid if uid is not None else env.uid)
    b64 = base64.b64encode(code.encode()).decode()
    proc = subprocess.run([sys.executable, "-c",
                           "import base64;exec(base64.b64decode('%s'))" % b64],
                          capture_output=True, timeout=30)
    return proc.returncode, proc.stdout, proc.stderr


# ---------------------------------------------------------------------------
# 1. 离线 failguard 与摘要严格性
# ---------------------------------------------------------------------------

class OfflineGuardTests(OfflineTestCase):
    def test_unmocked_real_exec_raises(self):
        with self.assertRaises(UnhandledExternal):
            dpl.remote_exec("echo x")

    def test_unmocked_local_exec_raises(self):
        with self.assertRaises(UnhandledExternal):
            dpl.local_exec(["true"])


class DigestStrictnessTests(OfflineTestCase):
    def test_exact_accepted(self):
        d = make_digest("secret")
        self.assertTrue(rot.digest_shape_ok(d))
        self.assertTrue(rot.secret_matches_digest("secret", d))
        self.assertFalse(rot.secret_matches_digest("wrong", d))

    def test_non_exact_rejected(self):
        for d in (digest_string(n=32768), digest_string(r=4), digest_string(p=2),
                  digest_string(klen=32, hashbytes=b"\x01" * 32), digest_string(salt=b"short"),
                  digest_string(salt=b"0123456789abcdef" * 2), "", "x", None):
            self.assertFalse(rot.digest_shape_ok(d), d)
            self.assertFalse(rot.secret_matches_digest("secret", d), d)


class CredentialKeyTests(OfflineTestCase):
    def test_unknown_field_rejected(self):
        raw = json.dumps({"viewer": {"username": "viewer", "digest": make_digest("x"),
                                     "password": "leak"},
                          "upload": {"digest": make_digest("y")}}).encode()
        with self.assertRaises(rot.RotateError):
            rot.validate_credentials_bytes(raw)

    def test_unknown_top_level_rejected(self):
        raw = json.dumps({"viewer": {"username": "viewer", "digest": make_digest("x")},
                          "upload": {"digest": make_digest("y")}, "extra": 1}).encode()
        with self.assertRaises(rot.RotateError):
            rot.validate_credentials_bytes(raw)

    def test_valid_roundtrip(self):
        raw = creds_bytes("v", "u")
        self.assertEqual(rot.validate_credentials_bytes(raw)["viewer"]["username"], "viewer")

    def test_secret_chars_rejected(self):
        for bad in ("a" * 20 + "\n", "has space padding here", "short", "semi;colon" + "a" * 20):
            with self.assertRaises(rot.RotateError):
                rot._validate_secret(bad, "x")
        rot._validate_secret("Abcdefghijklmnop_-", "x")  # 不应抛

    def test_generators_distinct_and_urlsafe(self):
        v = dpl.generate_viewer_password()
        u = dpl.generate_upload_token()
        self.assertNotEqual(v, u)
        self.assertRegex(v, r"^[A-Za-z0-9_-]+$")
        self.assertRegex(u, r"^[A-Za-z0-9_-]+$")


# ---------------------------------------------------------------------------
# 2. 本地路径安全 / 未知目录不接管
# ---------------------------------------------------------------------------

class LocalPathTests(OfflineTestCase):
    def test_symlink_and_dangling_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            real = os.path.join(td, "real")
            open(real, "w").write("x")
            os.chmod(real, 0o600)
            link = os.path.join(td, "link")
            os.symlink(real, link)
            dangling = os.path.join(td, "dangling")
            os.symlink(os.path.join(td, "nope"), dangling)
            for p in (link, dangling):
                with self.assertRaises(rot.RotateError):
                    rot._assert_local_safe(p, expect_dir=False)

    def test_hardlink_and_mode_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            real = os.path.join(td, "real")
            open(real, "w").write("x")
            os.chmod(real, 0o600)
            os.link(real, os.path.join(td, "second"))
            with self.assertRaises(rot.RotateError):
                rot._assert_local_safe(real, expect_dir=False, file_mode=0o600, exact_mode=True)
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "f")
            open(p, "w").write("x")
            os.chmod(p, 0o400)  # 精确 0600 不接受 0400
            with self.assertRaises(rot.RotateError):
                rot._assert_local_safe(p, expect_dir=False, file_mode=0o600, exact_mode=True)

    def test_ancestor_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            realdir = os.path.join(td, "realdir")
            os.mkdir(realdir, 0o700)
            linkdir = os.path.join(td, "linkdir")
            os.symlink(realdir, linkdir)
            with self.assertRaises(rot.RotateError):
                rot._assert_local_safe(os.path.join(linkdir, "f"), expect_dir=False, allow_missing=True)

    def test_group_world_writable_ancestor_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            d = os.path.join(td, "d")
            os.mkdir(d, 0o700)
            os.chmod(d, 0o770)
            f = os.path.join(d, "f")
            with self.assertRaises(rot.RotateError):
                rot._assert_local_safe(f, expect_dir=False, allow_missing=True)

    def test_state_root_existing_without_marker_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root = os.path.join(td, "rotations")
            os.mkdir(root, 0o700)  # 已存在但无 marker
            with mock.patch.object(rot, "STATE_ROOT", root), \
                 mock.patch.object(rot, "STATE_MARKER", os.path.join(root, ".rotate-managed")), \
                 mock.patch.object(rot, "STATE_LOCK", os.path.join(root, ".lock")):
                with self.assertRaises(rot.RotateError):
                    rot._ensure_state_root()

    def test_existing_parent_0755_allowed_not_chmodded(self):
        # deploy.save_baseline 以默认 0755 创建 ~/.cache/relocation-mobile-readonly：不得强制 private
        with tempfile.TemporaryDirectory() as td:
            parent = os.path.join(td, "relocation-mobile-readonly")
            os.mkdir(parent, 0o755)
            root = os.path.join(parent, "rotations")
            with mock.patch.object(rot, "STATE_ROOT", root), \
                 mock.patch.object(rot, "STATE_MARKER", os.path.join(root, ".rotate-managed")), \
                 mock.patch.object(rot, "STATE_LOCK", os.path.join(root, ".lock")):
                rot._ensure_state_root()
            self.assertEqual(stat.S_IMODE(os.stat(root).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(parent).st_mode), 0o755)  # 未被 chmod

    def test_existing_parent_group_writable_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            parent = os.path.join(td, "relocation-mobile-readonly")
            os.mkdir(parent, 0o770)
            os.chmod(parent, 0o770)  # 绕开 umask
            root = os.path.join(parent, "rotations")
            with mock.patch.object(rot, "STATE_ROOT", root), \
                 mock.patch.object(rot, "STATE_MARKER", os.path.join(root, ".rotate-managed")), \
                 mock.patch.object(rot, "STATE_LOCK", os.path.join(root, ".lock")):
                with self.assertRaises(rot.RotateError):
                    rot._ensure_state_root()


class RemotePrepareTests(OfflineTestCase):
    def test_fresh_dir_initializes_marker_and_lock(self):
        with tempfile.TemporaryDirectory() as td:
            env = HelperEnv.__new__(HelperEnv)
            env.uid = os.getuid()
            fresh = os.path.join(td, "rotate")
            rc, out, err = run_prepare_local(env, fresh_dir=fresh, parent=td)
            self.assertEqual(rc, 0, err.decode())
            self.assertIn(b"PREPARE_OK", out)
            self.assertTrue(os.path.exists(os.path.join(fresh, "marker")))
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(fresh, "marker")).st_mode), 0o600)

    def test_existing_dir_without_marker_not_taken_over(self):
        with tempfile.TemporaryDirectory() as td:
            env = HelperEnv.__new__(HelperEnv)
            env.uid = os.getuid()
            existing = os.path.join(td, "rotate")
            os.mkdir(existing, 0o700)  # 已存在但无 marker
            rc, out, err = run_prepare_local(env, fresh_dir=existing, parent=td)
            self.assertNotEqual(rc, 0)
            self.assertIn(b"MARKER_MISSING", err)
            self.assertFalse(os.path.exists(os.path.join(existing, "marker")))

    def test_bad_marker_value_refused(self):
        with tempfile.TemporaryDirectory() as td:
            env = HelperEnv.__new__(HelperEnv)
            env.uid = os.getuid()
            d = os.path.join(td, "rotate")
            os.mkdir(d, 0o700)
            m = os.path.join(d, "marker")
            open(m, "w").write("wrong\n")
            os.chmod(m, 0o600)
            rc, out, err = run_prepare_local(env, fresh_dir=d, parent=td)
            self.assertNotEqual(rc, 0)

    def test_dir_mode_abnormal_refused(self):
        with tempfile.TemporaryDirectory() as td:
            env = HelperEnv.__new__(HelperEnv)
            env.uid = os.getuid()
            d = os.path.join(td, "rotate")
            os.mkdir(d, 0o755)  # group/other 可读
            rc, out, err = run_prepare_local(env, fresh_dir=d, parent=td)
            self.assertNotEqual(rc, 0)

    def test_parent_writable_refused(self):
        with tempfile.TemporaryDirectory() as td:
            env = HelperEnv.__new__(HelperEnv)
            env.uid = os.getuid()
            d = os.path.join(td, "rotate")
            os.mkdir(d, 0o700)
            os.chmod(td, 0o777)
            rc, out, err = run_prepare_local(env, fresh_dir=d, parent=td)
            self.assertNotEqual(rc, 0)


# ---------------------------------------------------------------------------
# 3. 远端只读原语：合成 subprocess 输出 -> 真实消费者 parse roundtrip（B1/B3）
# ---------------------------------------------------------------------------

def run_snippet_local(code, stdin=b""):
    proc = subprocess.run([sys.executable, "-c", code], input=stdin,
                          capture_output=True, timeout=30)
    return proc.returncode, proc.stdout, proc.stderr


class RemoteReadRoundtripTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.env = HelperEnv()
        self.addCleanup(self.env.cleaned)
        self.owner = (self.env.uid, self.env.gid)

    def _consume_read(self, path, stdout):
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(0, stdout)):
            return rot.remote_read_exact(path, owner=self.owner, mode=0o600, root=self.env.root)

    def _consume_stat(self, path, stdout):
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(0, stdout)):
            return rot.remote_stat_hash(path, owner=self.owner, mode=0o600, root=self.env.root)

    def test_read_0600_roundtrip_real_snippet(self):
        code = rot.render_remote_read(self.env.target, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, err = run_snippet_local(code)
        self.assertEqual(rc, 0, err.decode())
        data, uid, gid, mode = self._consume_read(self.env.target, out)
        self.assertEqual(data, self.env.old)
        self.assertEqual((uid, gid), self.owner)
        self.assertEqual(mode, 0o600)  # 十进制 384 必须被真实消费者解析为 0600

    def test_read_0644_roundtrip_parses_decimal(self):
        os.chmod(self.env.target, 0o644)
        code = rot.render_remote_read(self.env.target, owner=self.owner, mode=None,
                                      root=self.env.root)
        rc, out, err = run_snippet_local(code)
        self.assertEqual(rc, 0, err.decode())
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(0, out)):
            data, _uid, _gid, mode = rot.remote_read_exact(
                self.env.target, owner=self.owner, mode=0o644, root=self.env.root)
        self.assertEqual(data, self.env.old)
        self.assertEqual(mode, 0o644)  # 420 十进制 -> 0644

    def test_read_0600_consumer_rejects_0644_mode(self):
        os.chmod(self.env.target, 0o644)
        code = rot.render_remote_read(self.env.target, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertNotEqual(rc, 0, "wide mode must be rejected by snippet gate")

    def test_read_empty_roundtrip(self):
        self.env._write(self.env.target, b"", 0o600)
        code = rot.render_remote_read(self.env.target, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, err = run_snippet_local(code)
        self.assertEqual(rc, 0, err.decode())
        data, _uid, _gid, mode = self._consume_read(self.env.target, out)
        self.assertEqual(data, b"")
        self.assertEqual(mode, 0o600)

    def test_read_missing_is_none(self):
        missing = os.path.join(self.env.data, "nope.json")
        code = rot.render_remote_read(missing, owner=self.owner, mode=0o600, root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertEqual(rc, 3)
        self.assertEqual(out.decode().strip(), "MISSING")
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            self.assertIsNone(rot.remote_read_exact(missing, owner=self.owner, mode=0o600,
                                                    root=self.env.root))

    def test_read_active_empty_present_illegal(self):
        self.env._write(self.env.active, b"   \n", 0o600)
        code = rot.render_remote_read(self.env.active, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, err = run_snippet_local(code)
        self.assertEqual(rc, 0, err.decode())
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.read_remote_active(uid=self.env.uid)

    def test_read_symlink_and_dangling_rejected(self):
        link = os.path.join(self.env.data, "link.json")
        os.symlink(self.env.target, link)
        dangling = os.path.join(self.env.data, "dangling.json")
        os.symlink(os.path.join(self.env.data, "absent"), dangling)
        for p in (link, dangling):
            code = rot.render_remote_read(p, owner=self.owner, mode=0o600, root=self.env.root)
            rc, out, _err = run_snippet_local(code)
            self.assertNotEqual(rc, 0)
            self.assertIn(b"SAFE_", out)
            with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
                with self.assertRaises(rot.RotateError):
                    rot.remote_read_exact(p, owner=self.owner, mode=0o600, root=self.env.root)

    def test_read_directory_rejected(self):
        code = rot.render_remote_read(self.env.data, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertNotEqual(rc, 0)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.remote_read_exact(self.env.data, owner=self.owner, mode=0o600,
                                      root=self.env.root)

    def test_read_wrong_owner_rejected(self):
        wrong = (self.env.uid + 1, self.env.gid)
        code = rot.render_remote_read(self.env.target, owner=wrong, mode=0o600,
                                      root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertNotEqual(rc, 0)
        self.assertIn(b"SAFE_OWNER", out)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.remote_read_exact(self.env.target, owner=wrong, mode=0o600,
                                      root=self.env.root)

    def test_read_malformed_output_rejected(self):
        for bad in (b"notint 2 384 AAAA\n", b"1 2 384 !!!notbase64!!!\n",
                    b"1 2 384 AAAA trailing\n"):
            with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(0, bad)):
                with self.assertRaises(rot.RotateError):
                    rot.remote_read_exact(self.env.target, owner=self.owner, mode=0o600,
                                          root=self.env.root)

    def test_stat_roundtrip_real_snippet(self):
        code = rot.render_remote_stat(self.env.snap, owner=self.owner, mode=0o600,
                                      root=self.env.root)
        rc, out, err = run_snippet_local(code)
        self.assertEqual(rc, 0, err.decode())
        info = self._consume_stat(self.env.snap, out)
        self.assertEqual(info["hash"], self.env.snapshot_hash())
        self.assertEqual((info["uid"], info["gid"]), self.owner)
        self.assertEqual(info["mode"], 0o600)

    def test_stat_missing_and_symlink(self):
        missing = os.path.join(self.env.data, "nope.json")
        code = rot.render_remote_stat(missing, owner=self.owner, mode=0o600, root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertEqual(rc, 3)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            self.assertIsNone(rot.remote_stat_hash(missing, owner=self.owner, mode=0o600,
                                                   root=self.env.root))
        link = os.path.join(self.env.data, "snaplink.json")
        os.symlink(self.env.snap, link)
        code = rot.render_remote_stat(link, owner=self.owner, mode=0o600, root=self.env.root)
        rc, out, _err = run_snippet_local(code)
        self.assertNotEqual(rc, 0)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.remote_stat_hash(link, owner=self.owner, mode=0o600, root=self.env.root)


class RemoteProbeRoundtripTests(OfflineTestCase):
    """首次 rotate 前 opdir 只读探测：真实片段 -> 真实消费者；绝不创建/修改任何内容。"""

    def setUp(self):
        super().setUp()
        self.env = HelperEnv()
        self.addCleanup(self.env.cleaned)

    def _run_probe(self, **over):
        kwargs = dict(directory=self.env.rot, marker=self.env.marker,
                      value="relocation-mobile-readonly-rotate", active=self.env.active,
                      parent=self.env.td, uid=self.env.uid, root=self.env.root)
        kwargs.update(over)
        code = rot.render_remote_probe(**kwargs)
        return run_snippet_local(code)

    def _consume(self, rc, out):
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            return rot.read_remote_active_initialized(root=self.env.root, parent=self.env.td)

    def _tree(self):
        out = {}
        for dirpath, dirs, files in os.walk(self.env.td):
            for name in dirs + files:
                p = os.path.join(dirpath, name)
                st = os.lstat(p)
                out[os.path.relpath(p, self.env.td)] = (stat.S_IMODE(st.st_mode), st.st_size)
        return out

    def test_uninitialized_opdir_readonly(self):
        import shutil
        shutil.rmtree(self.env.rot)
        before = self._tree()
        rc, out, _err = self._run_probe()
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip(), b"PROBE_UNINITIALIZED")
        self.assertIsNone(self._consume(rc, out))
        self.assertEqual(before, self._tree(), "探测不得创建/修改任何内容")

    def test_initialized_absent_active(self):
        before = self._tree()
        rc, out, _err = self._run_probe()
        self.assertEqual(rc, 0, out)
        self.assertEqual(out.strip(), b"PROBE_ABSENT")
        self.assertIsNone(self._consume(rc, out))
        self.assertEqual(before, self._tree())

    def test_initialized_active_txn_returned(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o600)
        before = self._tree()
        rc, out, _err = self._run_probe()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self._consume(rc, out), self.env.txn)
        self.assertEqual(before, self._tree())

    def test_empty_active_illegal_not_absent(self):
        with open(self.env.active, "w") as fh:
            fh.write("   \n")
        os.chmod(self.env.active, 0o600)
        rc, out, _err = self._run_probe()
        self.assertNotEqual(rc, 0)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.read_remote_active_initialized(root=self.env.root, parent=self.env.td)

    def test_wrong_marker_rejected(self):
        with open(self.env.marker, "w") as fh:
            fh.write("wrong\n")
        os.chmod(self.env.marker, 0o600)
        rc, out, _err = self._run_probe()
        self.assertNotEqual(rc, 0)
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc, out)):
            with self.assertRaises(rot.RotateError):
                rot.read_remote_active_initialized(root=self.env.root, parent=self.env.td)

    def test_opdir_symlink_rejected(self):
        real = self.env.rot + ".real"
        os.rename(self.env.rot, real)
        os.symlink(real, self.env.rot)
        rc, out, _err = self._run_probe()
        self.assertNotEqual(rc, 0)

    def test_opdir_wrong_mode_rejected(self):
        os.chmod(self.env.rot, 0o755)
        rc, out, _err = self._run_probe()
        self.assertNotEqual(rc, 0)

    def test_active_is_directory_rejected(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.remove(self.env.active)
        os.mkdir(self.env.active, 0o700)
        rc, out, _err = self._run_probe()
        self.assertNotEqual(rc, 0)

    def test_parent_writable_rejected(self):
        os.chmod(self.env.td, 0o777)
        try:
            rc, out, _err = self._run_probe()
        finally:
            os.chmod(self.env.td, 0o700)
        self.assertNotEqual(rc, 0)


# ---------------------------------------------------------------------------
# 4. 远端 helper：路径/身份/CAS/运行态/故障注入
# ---------------------------------------------------------------------------

class RemoteApplyHelperTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        self.env = HelperEnv()
        self.addCleanup(self.env.cleaned)

    def _apply(self, **over):
        base = dict(
            mode="apply", txn_id=self.env.txn,
            expected_old=hashlib.sha256(self.env.old).hexdigest(),
            expected_new=hashlib.sha256(self.env.new).hexdigest(),
            payload=self.env.new, restart=self.env.restart_cmd(),
            owner=(self.env.uid, self.env.gid))
        base.update(over)
        return run_remote_apply_local(self.env, **base)

    def _to_new(self):
        """模拟 apply 已完成：目标已是 new，active 已属本事务。"""
        if hasattr(self, "_moved"):
            return
        self._moved = True
        with open(self.env.target, "wb") as fh:
            fh.write(self.env.new)
        os.chmod(self.env.target, 0o600)
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o600)

    def _restart(self, *, gate="stale", expected_hash=None, expected_runtime="running", **over):
        self._to_new()
        h = expected_hash or hashlib.sha256(self.env.new).hexdigest()
        return run_remote_apply_local(
            self.env, mode="restart", txn_id=self.env.txn,
            expected_old=h, expected_new=h,
            payload=b"", restart=self.env.restart_cmd(), owner=None,
            restart_gate=gate, expected_runtime=expected_runtime, **over)

    def _observe(self, *, expected_hash=None, **over):
        h = expected_hash or hashlib.sha256(self.env.old).hexdigest()
        return run_remote_apply_local(
            self.env, mode="observe", txn_id=self.env.txn,
            expected_old=h, expected_new=h, payload=b"", restart=[], owner=None,
            restart_gate="none", expected_runtime="any", **over)

    def test_apply_success(self):
        res = self._apply()
        self.assertTrue(res["ok"])
        self.assertTrue(res["changed"])
        self.assertTrue(res["restarted"])
        self.assertEqual(open(self.env.target, "rb").read(), self.env.new)
        self.assertEqual(stat.S_IMODE(os.stat(self.env.target).st_mode), 0o600)
        self.assertEqual(open(self.env.active).read().strip(), self.env.txn)
        self.assertTrue(os.path.exists(self.env.restart_log))

    def test_cas_mismatch_zero_write_zero_restart(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_old="0" * 64)
        self.assertIn("CAS_OLD_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))
        self.assertFalse(os.path.exists(self.env.active))

    def test_cid_mismatch_zero_write_zero_restart(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(cid_cmd=self.env.cid_cmd("WRONG"))
        self.assertIn("CID_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_empty_cid_not_bypass(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_cid="")
        self.assertIn("CID_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_config_hash_drift_stops(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_config_hash="0" * 64)
        self.assertIn("CONFIG_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_snapshot_hash_drift_stops(self):
        before = self.env.snapshot_hash()
        with open(self.env.snap, "wb") as fh:
            fh.write(b'{"business":"changed"}\n')
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_snapshot_hash=before)
        self.assertIn("SNAPSHOT_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_snapshot_same_hash_wide_mode_rejected(self):
        before = self.env.snapshot_hash()
        os.chmod(self.env.snap, 0o644)  # 内容 hash 不变，但属性宽
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_snapshot_hash=before)
        self.assertIn("SNAPSHOT_ATTR", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_target_mode_abnormal_stops(self):
        os.chmod(self.env.target, 0o644)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("TARGET_", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_target_owner_abnormal_stops(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(target_owner=(self.env.uid + 1, self.env.gid))
        self.assertIn("TARGET_OWNER", str(cm.exception))

    def test_unknown_dir_marker_missing_stops(self):
        os.unlink(self.env.marker)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("MARKER_MISSING", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_data_dir_wrong_mode_rejected(self):
        os.chmod(self.env.data, 0o755)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_data_dir_wrong_owner_rejected(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(data_owner=(self.env.uid + 1, self.env.gid))
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_snapshots_dir_0755_accepted(self):
        # 服务自建 snapshots 目录默认 0755：属主正确、无 group/other 写即可，不强制 0700
        self.assertEqual(stat.S_IMODE(os.stat(self.env.snap_dir).st_mode), 0o755)
        res = self._apply()
        self.assertTrue(res["ok"])

    def test_snapshots_dir_group_writable_rejected(self):
        os.chmod(self.env.snap_dir, 0o775)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_snapshots_dir_symlink_rejected(self):
        before = self.env.snapshot_hash()
        real = self.env.snap_dir + ".real"
        os.rename(self.env.snap_dir, real)
        os.symlink(real, self.env.snap_dir)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_snapshot_hash=before)
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_ancestor_symlink_rejected_zero_read_zero_replace(self):
        real = self.env.base + ".real"
        os.rename(self.env.base, real)
        os.symlink(real, self.env.base)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))
        self.assertFalse(os.path.exists(self.env.active))

    def test_ancestor_dangling_symlink_rejected(self):
        before = self.env.snapshot_hash()
        real = self.env.base + ".real"
        os.rename(self.env.base, real)
        os.symlink(os.path.join(self.env.td, "absent"), self.env.base)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_snapshot_hash=before)
        self.assertIn("DATA_DIR_BAD", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_lock_busy_stops(self):
        import fcntl
        holder = os.open(self.env.lock, os.O_RDWR)
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with self.assertRaises(rot.RotateError) as cm:
                self._apply()
            self.assertIn("LOCK_BUSY", str(cm.exception))
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            os.close(holder)

    def test_lock_wrong_mode_rejected(self):
        os.chmod(self.env.lock, 0o644)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("LOCK_ATTR", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_active_wrong_mode_rejected(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o644)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("ACTIVE_ATTR", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_active_other_stops(self):
        with open(self.env.active, "w") as fh:
            fh.write("b" * 32 + "\n")
        os.chmod(self.env.active, 0o600)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("ACTIVE_OTHER", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_active_empty_present_illegal_not_absent(self):
        # 文件存在但空/空白：非法，不得视为 absent
        with open(self.env.active, "w") as fh:
            fh.write("   \n")
        os.chmod(self.env.active, 0o600)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("ACTIVE_ATTR", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_helper_owners_use_uid(self):
        # owner 无法在 CI 内切 uid，结构性断言 LOCK/ACTIVE/MARKER 的 safe_open owner=UID
        code = rot.render_remote_apply(
            mode="apply", txn_id=self.env.txn, expected_old="a" * 64, expected_new="b" * 64,
            container="c", expected_cid="c", expected_config_hash="e" * 64,
            restart=["true"], owner=None, target_owner=(1000, 1000),
            expected_snapshot_hash="f" * 64, snapshot_owner=(1000, 1000), snapshot_mode=0o600,
            root=self.env.root, uid=1234)
        self.assertIn("so(LOCK, False, UID, 0o600)", code)
        self.assertIn("read_nofollow(ACTIVE, UID, 0o600", code)
        self.assertIn("verify_marker(MARKER, VALUE, UID)", code)

    def test_restart_gate_exited_requires_exited(self):
        # running + exited gate -> 拒绝（gate 必须 exited），零重启
        self._to_new()
        with self.assertRaises(rot.RotateError) as cm:
            self._restart(gate="exited", expected_runtime="exited",
                          inspect_cmd=self.env.runtime("running"))
        self.assertIn("RUNTIME_MISMATCH", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_restart_gate_exited_restarts(self):
        self._to_new()
        res = self._restart(gate="exited", expected_runtime="exited",
                            inspect_cmd=self.env.runtime("exited"))
        self.assertTrue(res["restarted"])
        self.assertTrue(os.path.exists(self.env.restart_log))

    def test_restart_gate_stale_requires_running(self):
        self._to_new()
        res = self._restart(gate="stale", expected_runtime="running")
        self.assertTrue(res["restarted"])

    def test_restart_gate_paused_zero_restart(self):
        self._to_new()
        with self.assertRaises(rot.RotateError) as cm:
            self._restart(gate="stale", expected_runtime="running",
                          inspect_cmd=self.env.runtime("paused"))
        self.assertIn("RUNTIME_MISMATCH", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_apply_paused_zero_replace_zero_restart(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(inspect_cmd=self.env.runtime("paused"))
        self.assertIn("RUNTIME_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_apply_dead_and_restarting_zero_replace(self):
        for status in ("dead", "restarting", "unknown"):
            with self.assertRaises(rot.RotateError):
                self._apply(inspect_cmd=self.env.runtime(status))
            self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_restart_failure_reports_changed(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(restart=[sys.executable, "-c", "raise SystemExit(3)"])
        self.assertIn("RESTART_FAIL", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.new)

    def test_clear_own_active_deleted(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o600)
        res = self._observe_clear()
        self.assertEqual(res["cleared"], "deleted")
        self.assertFalse(os.path.exists(self.env.active))

    def _observe_clear(self):
        return run_remote_apply_local(
            self.env, mode="clear", txn_id=self.env.txn, expected_old="", expected_new="",
            payload=b"", restart=[], owner=None, restart_gate="none",
            expected_runtime="any")

    def test_clear_absent_confirmed(self):
        res = self._observe_clear()
        self.assertEqual(res["cleared"], "absent")

    def test_clear_other_active_stops(self):
        with open(self.env.active, "w") as fh:
            fh.write("b" * 32 + "\n")
        os.chmod(self.env.active, 0o600)
        with self.assertRaises(rot.RotateError) as cm:
            self._observe_clear()
        self.assertIn("ACTIVE_OTHER", str(cm.exception))
        self.assertTrue(os.path.exists(self.env.active))

    def test_clear_lost_response_followup_absent_converges(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o600)
        first = self._observe_clear()  # 第一次删除了 active（模拟回包丢失后再查）
        self.assertEqual(first["cleared"], "deleted")
        second = self._observe_clear()
        self.assertEqual(second["cleared"], "absent")

    def test_payload_hash_mismatch(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(payload=b"tampered")
        self.assertIn("PAYLOAD_HASH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_observe_success_returns_limited_state(self):
        res = self._observe()
        self.assertTrue(res["ok"])
        self.assertEqual(res["runtime"], "running")
        self.assertEqual(res["targetHash"], hashlib.sha256(self.env.old).hexdigest())
        self.assertIsNone(res["active"])

    def test_observe_busy_lock_stops(self):
        import fcntl
        holder = os.open(self.env.lock, os.O_RDWR)
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with self.assertRaises(rot.RotateError) as cm:
                self._observe()
            self.assertIn("LOCK_BUSY", str(cm.exception))
        finally:
            fcntl.flock(holder, fcntl.LOCK_UN)
            os.close(holder)

    def test_observe_tree_unchanged(self):
        def tree():
            out = {}
            for dirpath, _dirs, files in os.walk(self.env.td):
                for name in files:
                    p = os.path.join(dirpath, name)
                    st = os.lstat(p)
                    out[os.path.relpath(p, self.env.td)] = (
                        stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns)
            return out
        before = tree()
        self._observe()
        self.assertEqual(before, tree())

    def test_observe_missing_lock_rejected_not_recreated(self):
        os.unlink(self.env.lock)
        with self.assertRaises(rot.RotateError) as cm:
            self._observe()
        self.assertIn("LOCK_MISSING", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.lock), "不得重建缺失的锁")

    def test_observe_missing_opdir_rejected_not_recreated(self):
        import shutil
        shutil.rmtree(self.env.rot)
        with self.assertRaises(rot.RotateError) as cm:
            self._observe()
        self.assertIn("DIR_OPEN_FAIL", str(cm.exception))
        self.assertFalse(os.path.exists(self.env.rot), "不得重建缺失的 opdir")


class RemoteApplyFaultInjectionTests(OfflineTestCase):
    """注入 write/fsync/replace/dirsync 故障：状态保留、不假成功；断言替换确已发生。"""

    def setUp(self):
        super().setUp()
        self.env = HelperEnv()
        self.addCleanup(self.env.cleaned)

    def _run_code(self, code, stdin=b""):
        proc = subprocess.run([sys.executable, "-c", code], input=stdin,
                              capture_output=True, timeout=30)
        return proc.returncode, proc.stdout, proc.stderr

    def _render(self, *, expected_old=None, payload=None):
        kwargs = self.env.kwargs()
        return rot.render_remote_apply(
            mode="apply", txn_id=self.env.txn,
            expected_old=expected_old or hashlib.sha256(self.env.old).hexdigest(),
            expected_new=hashlib.sha256(payload if payload is not None else self.env.new).hexdigest(),
            container=kwargs["container"], expected_cid="ctr123",
            expected_config_hash=self.env.config_hash(), restart=self.env.restart_cmd(),
            owner=(self.env.uid, self.env.gid), target_owner=kwargs["target_owner"],
            target=kwargs["target"], target_parent=kwargs["target_parent"],
            directory=kwargs["directory"], marker=kwargs["marker"], value=kwargs["value"],
            lock=kwargs["lock"], active=kwargs["active"], data_base=kwargs["data_base"],
            data_marker=kwargs["data_marker"], data_marker_value=kwargs["data_marker_value"],
            data_owner=kwargs["data_owner"], data_mode=kwargs["data_mode"],
            snapshot=kwargs["snapshot"], expected_snapshot_hash=kwargs["expected_snapshot_hash"],
            snapshot_owner=kwargs["snapshot_owner"], snapshot_mode=kwargs["snapshot_mode"],
            cid_cmd=kwargs["cid_cmd"], inspect_cmd=kwargs["inspect_cmd"], uid=self.env.uid,
            root=self.env.root, expected_runtime="running")

    def _json(self, out):
        return json.loads(out.decode().strip().splitlines()[-1])

    def _assert_replaced(self, original, code, needle):
        self.assertIn(needle, original, "注入锚点未在生成源码中出现")
        self.assertNotEqual(original, code, "注入 replace 未实际生效")

    def test_os_write_failure(self):
        original = self._render()
        code = original.replace("w += os.write(fd, mv[w:])", "raise OSError('inject-write')")
        self._assert_replaced(original, code, "w += os.write(fd, mv[w:])")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = self._json(out)
        self.assertFalse(data["ok"])
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_temp_file_fsync_failure(self):
        original = self._render()
        code = original.replace("                os.fsync(fd)\n            finally:",
                                "                raise OSError('inject-fsync')\n            finally:")
        self._assert_replaced(original, code, "                os.fsync(fd)\n            finally:")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = self._json(out)
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_os_replace_failure(self):
        original = self._render()
        code = original.replace(
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)",
            "raise OSError('inject-replace')")
        self._assert_replaced(original, code,
                              "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = self._json(out)
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_dirfsync_failure_after_replace(self):
        original = self._render()
        code = original.replace(
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)\n            os.fsync(dirfd)",
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)\n            raise OSError('inject-dirsync')")
        self._assert_replaced(original, code, "os.fsync(dirfd)")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = self._json(out)
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.new)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_replace_recheck_toctou(self):
        original = self._render()
        needle = "pre_hash, pst = hash_nofollow(TARGET, tuple(TARGET_OWNER), TARGET_MODE)"
        code = original.replace(
            needle,
            "open(TARGET,'wb').write(b'tampered');\n            " + needle)
        self._assert_replaced(original, code, needle)
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = self._json(out)
        self.assertEqual(data["reason"], "REPLACE_RECHECK")
        self.assertEqual(open(self.env.target, "rb").read(), b"tampered")
        self.assertFalse(os.path.exists(self.env.restart_log))



# ---------------------------------------------------------------------------
# 5-9. 编排 / txn schema / resume / rollback
# ---------------------------------------------------------------------------

def full_txn(txn_id="a" * 32, secrets=("OV", "OU", "NV", "NU"),
             old_bytes=None, new_bytes=None):
    old_v, old_u, new_v, new_u = secrets
    old_bytes = old_bytes if old_bytes is not None else creds_bytes(old_v, old_u)
    new_bytes = new_bytes if new_bytes is not None else creds_bytes(new_v, new_u)
    txn = {
        "version": rot.TX_ROTATE_VERSION,
        "transaction": txn_id,
        "domain": rot.DOMAIN,
        "container": rot.CONTAINER,
        "target": rot.REMOTE_CREDENTIALS,
        "snapshot": rot.SNAPSHOT_PATH,
        "credentials": rot.REMOTE_CREDENTIALS,
        "phase": "prepared",
        "createdAt": "2026-01-01T00:00:00Z",
        "oldCredentialsB64": base64.b64encode(old_bytes).decode(),
        "oldHash": hashlib.sha256(old_bytes).hexdigest(),
        "newCredentialsB64": base64.b64encode(new_bytes).decode(),
        "newHash": hashlib.sha256(new_bytes).hexdigest(),
        "staging": rot._stage_refs(txn_id),
        "nginxBaseline": {"/etc/nginx.conf": "e" * 64},
        "nginxVhostHash": "f" * 64,
        "snapshotHash": "d" * 64,
        "snapshotOwner": [1000, 1000],
        "snapshotMode": 0o600,
        "containerId": "ctr123",
        "containerConfigHash": "c" * 64,
    }
    return txn, (old_v, old_u, new_v, new_u), old_bytes, new_bytes


@contextlib.contextmanager
def temp_state():
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "rotations")
        patches = [
            mock.patch.object(rot, "STATE_ROOT", root),
            mock.patch.object(rot, "STATE_MARKER", os.path.join(root, ".rotate-managed")),
            mock.patch.object(rot, "STATE_LOCK", os.path.join(root, ".lock")),
        ]
        for p in patches:
            p.start()
        try:
            rot._ensure_state_root()
            yield root
        finally:
            for p in reversed(patches):
                p.stop()


@contextlib.contextmanager
def noop_lock():
    @contextlib.contextmanager
    def _lock():
        rot._ensure_state_root()
        yield
    with mock.patch.object(rot, "local_lock", _lock), \
         mock.patch.object(rot, "read_remote_active", return_value=None), \
         mock.patch.object(rot, "read_remote_active_initialized", return_value=None):
        yield


class TxnSchemaTests(OfflineTestCase):
    def test_valid(self):
        txn, _, ob, nb = full_txn()
        self.assertEqual(rot.validate_txn(txn), (ob, nb))

    def test_bad_base64_rejected(self):
        txn, _, _, _ = full_txn()
        txn["oldCredentialsB64"] = "!!!not-base64!!!"
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)

    def test_hash_mismatch_rejected(self):
        txn, _, _, _ = full_txn()
        txn["oldHash"] = "0" * 64
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)

    def test_missing_cid_rejected(self):
        txn, _, _, _ = full_txn()
        txn.pop("containerId")
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)

    def test_missing_hash_rejected(self):
        txn, _, _, _ = full_txn()
        txn.pop("snapshotHash")
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)

    def test_staging_foreign_rejected(self):
        txn, _, _, _ = full_txn()
        txn["staging"]["old_viewer"] = "other:service"
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)

    def test_cross_role_staging_secrets_rejected(self):
        # 合法长度值，确保不是被 secret 格式先挡，而是真正走到 digest 角色比较
        long_a, long_b, long_c, long_d = "A" * 20, "B" * 20, "C" * 20, "D" * 20
        txn, _, ob, nb = full_txn(secrets=(long_a, long_b, long_c, long_d))
        refs = txn["staging"]
        table = {
            refs["old_viewer"]: long_a, refs["old_upload"]: long_a,  # 串角色：upload 用 viewer 值
            refs["new_viewer"]: long_c, refs["new_upload"]: long_d,
        }

        def fake_get(service, account):
            return table[service]

        with mock.patch.object(dpl, "keychain_get", side_effect=fake_get):
            with self.assertRaises(rot.RotateError) as cm:
                rot.assert_staging_matches(txn)
        self.assertIn("摘要", str(cm.exception))

    def test_target_mutation_rejected(self):
        txn, _, _, _ = full_txn()
        txn["target"] = "/etc/passwd"
        with self.assertRaises(rot.RotateError):
            rot.validate_txn(txn)


class OrphanRecordTests(OfflineTestCase):
    def test_write_and_read_early_record(self):
        with temp_state() as root, noop_lock():
            txn_id = "a" * 32
            os.mkdir(os.path.join(root, txn_id), 0o700)
            os.chmod(os.path.join(root, txn_id), 0o700)
            rot._write_txn(rot._fresh_txn_record(txn_id, creds_bytes("ov", "ou"),
                                                 creds_bytes("nv", "nu"), {"x": "y"}))
            txn = rot._read_txn(txn_id)
            self.assertEqual(txn["phase"], "preparing")
            with self.assertRaises(rot.RotateError):
                rot.validate_txn(txn)  # 未准备完整 -> resume 拒绝

    def test_resume_refuses_unprepared(self):
        txn, secrets, ob, nb = full_txn()
        del txn["containerId"]
        txn["phase"] = "prepare_failed"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", side_effect=rot.RotateError("incomplete")), \
                 mock.patch.object(rot, "remote_prepare_dir") as prep:
                with self.assertRaises(rot.RotateError):
                    rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
        prep.assert_not_called()


class ForwardPathTests(OfflineTestCase):
    def _patch_resume(self, txn, secrets, target_hash, *, tls_exc=False, formal=None):
        if formal is None:
            formal = (secrets[0], secrets[1])
        stack = contextlib.ExitStack()
        add = stack.enter_context
        add(mock.patch.object(rot, "_read_txn", return_value=txn))
        add(mock.patch.object(rot, "validate_txn", return_value=("ob", "nb")))
        add(mock.patch.object(rot, "assert_staging_matches", return_value=secrets))
        add(mock.patch.object(rot, "formal_pair", return_value=formal))
        add(mock.patch.object(rot, "remote_observe", return_value={
            "ok": True, "runtime": "running", "targetHash": target_hash, "active": None}))
        add(mock.patch.object(rot, "_observe_expect", return_value={}))
        add(mock.patch.object(rot, "_write_txn"))
        add(mock.patch.object(rot, "remote_prepare_dir"))
        add(mock.patch.object(rot, "_apply_to_new"))
        add(mock.patch.object(rot, "_verify_against_bytes"))
        # 不整体 mock reconfirm_identity/baseline：mock 底层 inspect/hash/nginx，真实跑身份校验
        add(mock.patch.object(rot, "container_identity",
                              return_value=(txn["containerId"], txn["containerConfigHash"])))
        add(mock.patch.object(rot, "remote_stat_hash", return_value={
            "hash": txn["snapshotHash"], "uid": txn["snapshotOwner"][0],
            "gid": txn["snapshotOwner"][1], "mode": txn["snapshotMode"]}))
        add(mock.patch.object(rot, "remote_required_hash", return_value=txn["nginxVhostHash"]))
        add(mock.patch.object(rot, "verify_approved_nginx_baseline",
                              return_value=txn["nginxBaseline"]))
        add(mock.patch.object(dpl, "container_state_ok", return_value=True))
        add(mock.patch.object(rot, "keychain_update_formal"))
        add(mock.patch.object(dpl, "keychain_get",
                              side_effect=lambda service, account: secrets[2]
                              if account == dpl.VIEWER_ACCOUNT else secrets[3]))
        add(mock.patch.object(rot, "remote_clear_active", return_value={"cleared": "deleted"}))
        if tls_exc:
            add(mock.patch.object(rot, "wait_tls_matrix",
                                  side_effect=rot.RotateError("TLS 矩阵失败")))
        else:
            add(mock.patch.object(rot, "wait_tls_matrix"))
        return stack

    def test_resume_old_tls_fail_zero_formal_write(self):
        txn, secrets, ob, nb = full_txn()
        txn["phase"] = "prepared"
        events = []

        def tls_fail(*a, **k):
            events.append("tls")
            raise rot.RotateError("TLS 矩阵失败")

        with temp_state(), noop_lock():
            stack = self._patch_resume(txn, secrets, txn["oldHash"])
            with stack:
                with mock.patch.object(rot, "wait_tls_matrix", side_effect=tls_fail), \
                     mock.patch.object(rot, "keychain_update_formal") as kc:
                    with self.assertRaises(rot.RotateError):
                        rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
                # 必须真的走到 TLS 且 TLS 失败；否则这里是假阳性
                self.assertEqual(events, ["tls"])
                kc.assert_not_called()
        self.assertEqual(txn["phase"], "failed")

    def test_resume_old_success_verifies_then_commits(self):
        txn, secrets, ob, nb = full_txn()
        txn["phase"] = "prepared"
        events = []
        with temp_state(), noop_lock():
            stack = self._patch_resume(txn, secrets, txn["oldHash"],
                                       formal=(secrets[0], secrets[1]))
            with stack:
                with mock.patch.object(rot, "_apply_to_new",
                                       side_effect=lambda *a, **k: events.append("apply")), \
                     mock.patch.object(rot, "wait_tls_matrix",
                                       side_effect=lambda *a, **k: events.append("tls")), \
                     mock.patch.object(rot, "keychain_update_formal",
                                       side_effect=lambda *a, **k: events.append("formal")):
                    rc = rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertLess(events.index("apply"), events.index("tls"))
        self.assertLess(events.index("tls"), events.index("formal"))

    def test_commit_observe_expect_mismatch_blocks_formal(self):
        txn, secrets, ob, nb = full_txn()
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "remote_observe", return_value={
                    "ok": True, "runtime": "running", "targetHash": "0" * 64, "active": None}), \
                 mock.patch.object(rot, "keychain_update_formal") as kc:
                with self.assertRaises(rot.RotateError):
                    rot._commit_formal(txn, secrets, ob, nb)
        kc.assert_not_called()
        self.assertNotEqual(txn["phase"], "complete")

    def test_commit_second_update_failure_not_complete(self):
        txn, secrets, ob, nb = full_txn()
        calls = {"n": 0}

        def upd(*a, **k):
            calls["n"] += 1
            if calls["n"] == 2:
                raise rot.RotateError("second failed")

        with temp_state(), noop_lock():
            with mock.patch.object(rot, "remote_observe", return_value={
                    "ok": True, "runtime": "running", "targetHash": txn["newHash"], "active": None}), \
                 mock.patch.object(rot, "_observe_expect", return_value={}), \
                 mock.patch.object(rot, "_write_txn"), \
                 mock.patch.object(rot, "keychain_update_formal", side_effect=upd), \
                 mock.patch.object(dpl, "keychain_get",
                                   side_effect=lambda service, account: secrets[2]
                                   if account == dpl.VIEWER_ACCOUNT else secrets[3]):
                with self.assertRaises(rot.RotateError):
                    rot._commit_formal(txn, secrets, ob, nb)
        self.assertEqual(calls["n"], 2)
        self.assertNotEqual(txn["phase"], "complete")


class ResumeStateTests(OfflineTestCase):
    def _resume_new(self, *, state, full_ok, stale, target_hash=None, secrets=None, active=None,
                    formal=None, snapshot_hash=None, vhost_hash=None):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "applied"
        secrets = secrets or sec
        formal = formal if formal is not None else (secrets[0], secrets[1])
        target_hash = target_hash if target_hash is not None else txn["newHash"]
        state_box = {"full_ok": full_ok}
        events = []

        def do_restart(_t, gate, expected_hash, runtime):
            events.append(("restart", gate, runtime))
            self.assertEqual(expected_hash, txn["newHash"])
            state_box["full_ok"] = True  # 重启后容器恢复 running/allowlist

        def stat(path, **kw):
            return {"hash": snapshot_hash or txn["snapshotHash"],
                    "uid": txn["snapshotOwner"][0], "gid": txn["snapshotOwner"][1],
                    "mode": txn["snapshotMode"]}

        with temp_state(), noop_lock():
            stack = contextlib.ExitStack()
            stack.enter_context(mock.patch.object(rot, "_read_txn", return_value=txn))
            stack.enter_context(mock.patch.object(rot, "validate_txn", return_value=(ob, nb)))
            stack.enter_context(mock.patch.object(rot, "assert_staging_matches", return_value=secrets))
            stack.enter_context(mock.patch.object(rot, "formal_pair", return_value=formal))
            stack.enter_context(mock.patch.object(rot, "remote_observe", return_value={
                "ok": True, "runtime": state, "targetHash": target_hash, "active": active}))
            stack.enter_context(mock.patch.object(rot, "_observe_expect", return_value={}))
            stack.enter_context(mock.patch.object(rot, "_write_txn"))
            # 真实跑 reconfirm_identity/baseline：只 mock 底层 inspect/hash/nginx
            stack.enter_context(mock.patch.object(
                rot, "container_identity",
                return_value=(txn["containerId"], txn["containerConfigHash"])))
            stack.enter_context(mock.patch.object(rot, "remote_stat_hash", side_effect=stat))
            stack.enter_context(mock.patch.object(
                rot, "remote_required_hash", return_value=vhost_hash or txn["nginxVhostHash"]))
            stack.enter_context(mock.patch.object(
                rot, "verify_approved_nginx_baseline", return_value=txn["nginxBaseline"]))
            stack.enter_context(mock.patch.object(rot, "_restart_once", side_effect=do_restart))
            stack.enter_context(mock.patch.object(rot, "remote_prepare_dir"))
            stack.enter_context(mock.patch.object(
                rot, "wait_tls_matrix", side_effect=lambda *a: events.append("tls")))
            stack.enter_context(mock.patch.object(
                rot, "keychain_update_formal", side_effect=lambda *a: events.append("formal")))
            stack.enter_context(mock.patch.object(
                dpl, "keychain_get",
                side_effect=lambda service, account: secrets[2]
                if account == dpl.VIEWER_ACCOUNT else secrets[3]))
            stack.enter_context(mock.patch.object(rot, "remote_clear_active",
                                                  return_value={"cleared": "deleted"}))
            stack.enter_context(mock.patch.object(
                dpl, "container_state_ok", side_effect=lambda: state_box["full_ok"]))
            stack.enter_context(mock.patch.object(rot, "server_serves_old", return_value=stale))
            with stack:
                try:
                    rc = rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
                except rot.RotateError:
                    rc = None
        return txn, rc, events

    def test_running_with_stale_evidence_restarts_once(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=True)
        self.assertEqual(rc, 0)
        self.assertEqual([e for e in events if isinstance(e, tuple)],
                         [("restart", "stale", "running")])

    def test_running_without_evidence_does_not_restart(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=False)
        self.assertEqual(rc, 0)
        self.assertEqual([e for e in events if isinstance(e, tuple)], [])

    def test_running_mixed_formal_state_commits(self):
        # T921/T931：正式 Keychain 处于混合态（viewer new / upload old）也必须可继续提交
        txn, sec, ob, nb = full_txn()
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=False,
                                           formal=(sec[2], sec[1]))
        self.assertEqual(rc, 0)
        self.assertEqual([e for e in events if isinstance(e, tuple)], [])
        self.assertEqual(events.count("formal"), 2)
        self.assertEqual(txn["phase"], "complete")

    def test_exited_with_identity_restarts_once_then_tls_then_formal(self):
        # S1889 回归：容器 stopped(exited) 时 resume 必须可达，exited 重启一次 -> TLS -> formal
        txn, rc, events = self._resume_new(state="exited", full_ok=False, stale=False)
        self.assertEqual(rc, 0)
        self.assertEqual([e for e in events if isinstance(e, tuple)],
                         [("restart", "exited", "exited")])
        self.assertEqual(events.count("tls"), 1)
        self.assertEqual(events.count("formal"), 2)
        self.assertLess(events.index(("restart", "exited", "exited")), events.index("tls"))
        self.assertLess(events.index("tls"), events.index("formal"))
        self.assertEqual(txn["phase"], "complete")

    def test_identity_vhost_drift_zero_restart_zero_formal(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=True,
                                           vhost_hash="a" * 64)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_identity_snapshot_drift_zero_restart_zero_formal(self):
        txn, rc, events = self._resume_new(state="exited", full_ok=False, stale=False,
                                           snapshot_hash="b" * 64)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_unknown_state_no_restart(self):
        txn, rc, events = self._resume_new(state="unknown", full_ok=False, stale=False)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_paused_state_no_restart(self):
        txn, rc, events = self._resume_new(state="paused", full_ok=False, stale=False)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_third_state_stops(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=False,
                                           target_hash="9" * 64)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_active_mismatch_stops(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=False,
                                           active="b" * 32)
        self.assertIsNone(rc)
        self.assertEqual(events, [])

    def test_observe_failure_stops_zero_formal(self):
        # 合成“另一进程持锁/观察失败”：resume 必须在 formal 前停止
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "applied"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=(sec[0], sec[1])), \
                 mock.patch.object(rot, "remote_observe",
                                   side_effect=rot.RotateError("LOCK_BUSY")), \
                 mock.patch.object(rot, "keychain_update_formal") as kc, \
                 mock.patch.object(rot, "_write_txn"):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
        kc.assert_not_called()
        self.assertEqual(txn["phase"], "failed")


class RollbackTests(OfflineTestCase):
    def _patch_rb(self, txn, sec, ob, nb, *, target_hash, runtime="running",
                  formal=None, restart_events=None, vhost_hash=None, snapshot_hash=None):
        if formal is None:
            formal = (sec[0], sec[1])
        if restart_events is None:
            restart_events = []
        stack = contextlib.ExitStack()
        add = stack.enter_context
        add(mock.patch.object(rot, "_read_txn", return_value=txn))
        add(mock.patch.object(rot, "validate_txn", return_value=(ob, nb)))
        add(mock.patch.object(rot, "assert_staging_matches", return_value=sec))
        add(mock.patch.object(rot, "formal_pair", return_value=formal))
        add(mock.patch.object(rot, "remote_observe", return_value={
            "ok": True, "runtime": runtime, "targetHash": target_hash, "active": None}))
        add(mock.patch.object(rot, "_observe_expect", return_value={}))
        add(mock.patch.object(rot, "remote_prepare_dir"))
        # 真实跑 reconfirm_identity/baseline：只 mock 底层 inspect/hash/nginx
        add(mock.patch.object(rot, "container_identity",
                              return_value=(txn["containerId"], txn["containerConfigHash"])))
        add(mock.patch.object(rot, "remote_stat_hash", return_value={
            "hash": snapshot_hash or txn["snapshotHash"],
            "uid": txn["snapshotOwner"][0], "gid": txn["snapshotOwner"][1],
            "mode": txn["snapshotMode"]}))
        add(mock.patch.object(rot, "remote_required_hash",
                              return_value=vhost_hash or txn["nginxVhostHash"]))
        add(mock.patch.object(rot, "verify_approved_nginx_baseline",
                              return_value=txn["nginxBaseline"]))
        add(mock.patch.object(dpl, "container_state_ok", return_value=True))
        add(mock.patch.object(rot, "wait_tls_matrix"))
        add(mock.patch.object(rot, "keychain_update_formal"))
        add(mock.patch.object(dpl, "keychain_get",
                              side_effect=lambda service, account: sec[0]
                              if account == dpl.VIEWER_ACCOUNT else sec[1]))
        add(mock.patch.object(rot, "remote_clear_active", return_value={"cleared": "deleted"}))
        add(mock.patch.object(rot, "_write_txn"))
        add(mock.patch.object(
            rot, "_restart_once",
            side_effect=lambda t, gate, h, rt: restart_events.append((gate, h, rt))))
        return stack

    def test_formal_foreign_zero_server_write(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=("FOREIGN", "FOREIGN")), \
                 mock.patch.object(rot, "run_remote_apply") as rra, \
                 mock.patch.object(rot, "remote_prepare_dir") as prep:
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        rra.assert_not_called()
        prep.assert_not_called()

    def test_rollback_new_to_old_reverse_matrix(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        recorded = {}
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["newHash"])
            with stack:
                with mock.patch.object(
                        rot, "run_remote_apply",
                        side_effect=lambda **k: recorded.update(k) or {"ok": True, "changed": True}), \
                     mock.patch.object(rot, "wait_tls_matrix") as wtm:
                    rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(recorded["expected_old"], txn["newHash"])
        self.assertEqual(recorded["expected_new"], txn["oldHash"])
        self.assertEqual(recorded["payload"], ob)
        self.assertEqual(recorded["expected_runtime"], "running")
        self.assertEqual(wtm.call_args.args[0], "old")

    def test_rollback_third_state_stops(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash="9" * 64)
            with stack:
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(txn["phase"], "failed")

    def test_rollback_vhost_drift_zero_server_write(self):
        # 回滚前 reconfirm_identity 必须在任何 apply/restart/formal 前拦截 vhost 漂移
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["newHash"],
                                   vhost_hash="a" * 64)
            with stack:
                with mock.patch.object(rot, "run_remote_apply") as rra, \
                     mock.patch.object(rot, "keychain_update_formal") as kc, \
                     mock.patch.object(rot, "_restart_once") as rs:
                    with self.assertRaises(rot.RotateError):
                        rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        rra.assert_not_called()
        rs.assert_not_called()
        kc.assert_not_called()
        self.assertEqual(txn["phase"], "failed")

    def test_rollback_snapshot_drift_zero_server_write(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["oldHash"],
                                   snapshot_hash="b" * 64)
            with stack:
                with mock.patch.object(rot, "run_remote_apply") as rra, \
                     mock.patch.object(rot, "keychain_update_formal") as kc, \
                     mock.patch.object(rot, "_restart_once") as rs:
                    with self.assertRaises(rot.RotateError):
                        rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        rra.assert_not_called()
        rs.assert_not_called()
        kc.assert_not_called()

    def test_rollback_disk_old_process_new_mixed_formal(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        events = []
        with temp_state(), noop_lock():
            # 磁盘 old + 进程 new（混合正式：viewer old / upload new）
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["oldHash"],
                                   formal=(sec[0], sec[3]), restart_events=events)
            with stack:
                rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(events, [("stale", txn["oldHash"], "running")])
        self.assertEqual(txn["phase"], "rolled_back")

    def test_rollback_disk_old_process_old_mixed_formal(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        events = []
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["oldHash"],
                                   formal=(sec[2], sec[1]), restart_events=events)
            with stack:
                rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(events, [("stale", txn["oldHash"], "running")])

    def test_rollback_disk_old_exited_uses_exited_gate(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        events = []
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["oldHash"],
                                   runtime="exited", restart_events=events)
            with stack:
                rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(events, [("exited", txn["oldHash"], "exited")])

    def test_rollback_disk_old_unknown_runtime_stops(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        events = []
        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["oldHash"],
                                   runtime="unknown", restart_events=events)
            with stack:
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(events, [])
        self.assertEqual(txn["phase"], "failed")

    def test_rollback_replace_interrupted_retry(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        calls = {"n": 0}

        def ra(**k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise rot.RotateError("远端操作未成功（WRITE_FAIL）；保留恢复材料，不自动回滚")
            return {"ok": True, "changed": True}

        with temp_state(), noop_lock():
            stack = self._patch_rb(txn, sec, ob, nb, target_hash=txn["newHash"])
            with stack:
                with mock.patch.object(rot, "run_remote_apply", side_effect=ra):
                    with self.assertRaises(rot.RotateError):
                        rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
                    self.assertEqual(txn["phase"], "failed")
                    rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(txn["phase"], "rolled_back")


class RotatePreflightTests(OfflineTestCase):
    def _rotate(self, *, baseline_exc=False, online=True):
        old_v, old_u = "OV" * 8, "OU" * 8
        new_v, new_u = "NV" * 8, "NU" * 8
        ob = creds_bytes(old_v, old_u)
        events = []

        def online_effect(*a):
            if not online:
                raise rot.RotateError("online fail")
            events.append("online")

        def baseline_effect(*a):
            if baseline_exc:
                raise rot.RotateError("baseline missing")
            events.append("baseline")
            return {}

        with temp_state(), noop_lock():
            with mock.patch.object(rot, "read_remote_active", return_value=None), \
                 mock.patch.object(rot, "read_remote_credentials", return_value=(ob, 1000, 1000, 0o600)), \
                 mock.patch.object(dpl, "keychain_get", side_effect=lambda *a: old_v if "viewer" in a[0] else old_u), \
                 mock.patch.object(rot, "_verify_against_bytes"), \
                 mock.patch.object(dpl, "generate_viewer_password", return_value=new_v), \
                 mock.patch.object(dpl, "generate_upload_token", return_value=new_u), \
                 mock.patch.object(rot, "preflight_online", side_effect=online_effect), \
                 mock.patch.object(rot, "capture_baseline", side_effect=baseline_effect), \
                 mock.patch.object(rot, "keychain_add_exclusive", side_effect=lambda *a, **k: events.append("stage")), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=(old_v, old_u, new_v, new_u)), \
                 mock.patch.object(rot, "formal_pair", return_value=(old_v, old_u)), \
                 mock.patch.object(rot, "_write_txn"), \
                 mock.patch.object(rot, "remote_prepare_dir", side_effect=lambda: events.append("prepare")), \
                 mock.patch.object(rot, "_apply_to_new", side_effect=lambda *a: events.append("apply")), \
                 mock.patch.object(rot, "_verify_server", side_effect=lambda *a: events.append("tls")), \
                 mock.patch.object(rot, "_commit_formal", side_effect=lambda *a: events.append("formal")), \
                 mock.patch.object(rot, "_try_clear_active"):
                try:
                    rc = rot.cmd_rotate(None)
                except rot.RotateError as err:
                    return None, events, str(err)
        return rc, events, None

    def test_order_online_baseline_stage_prepare_apply_tls_formal(self):
        rc, events, err = self._rotate()
        self.assertEqual(rc, 0, err)
        self.assertEqual(events, ["online", "baseline"] + ["stage"] * 4
                         + ["prepare", "apply", "tls", "formal"])

    def test_preflight_online_fail_no_stage_no_server(self):
        rc, events, err = self._rotate(online=False)
        self.assertIsNone(rc)
        self.assertEqual(events, [])
        self.assertIn("online", err or "")

    def test_baseline_failure_no_stage_no_server(self):
        rc, events, err = self._rotate(baseline_exc=True)
        self.assertIsNone(rc)
        self.assertEqual(events, ["online"])
        self.assertIn("baseline", err or "")

    def _no_txn_dirs(self, root):
        return [n for n in os.listdir(root) if rot.TXID_RE.match(n)]

    def test_rotate_refuses_persistent_remote_active_before_mkdir(self):
        with temp_state() as root, noop_lock():
            with mock.patch.object(rot, "read_remote_active_initialized",
                                   return_value="b" * 32):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rotate(None)
            self.assertEqual(self._no_txn_dirs(root), [])

    def test_precheck_read_error_leaves_no_txn_dir(self):
        # B5：远端读预检失败必须发生在 mkdir 之前，不得残留空事务目录
        with temp_state() as root, noop_lock():
            with mock.patch.object(rot, "read_remote_credentials",
                                   side_effect=rot.RotateError("远端读取失败")):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rotate(None)
            self.assertEqual(self._no_txn_dirs(root), [])

    def test_precheck_missing_credentials_leaves_no_txn_dir(self):
        with temp_state() as root, noop_lock():
            with mock.patch.object(rot, "read_remote_credentials", return_value=None):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rotate(None)
            self.assertEqual(self._no_txn_dirs(root), [])

    def test_precheck_old_secret_mismatch_leaves_no_txn_dir(self):
        # 本地正式明文与远端摘要不符：同样在 mkdir 前失败
        with temp_state() as root, noop_lock():
            with mock.patch.object(rot, "read_remote_credentials",
                                   return_value=(creds_bytes("OV" * 8, "OU" * 8), 1000, 1000, 0o600)), \
                 mock.patch.object(dpl, "keychain_get",
                                   side_effect=lambda *a: "WRONGVIEWER" + "X" * 8), \
                 mock.patch.object(rot, "_verify_against_bytes",
                                   side_effect=rot.RotateError("摘要不符")):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rotate(None)
            self.assertEqual(self._no_txn_dirs(root), [])

    def test_cleanup_unconfirmed_nonzero_no_ok_line(self):
        # B5：凭证提交后 cleanup 未确认必须非零且不得打印 OK
        txn, _, _, _ = full_txn()
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with mock.patch.object(rot, "_try_clear_active", return_value=False), \
             mock.patch.object(rot, "_write_txn"):
            with redirect_stdout(buf):
                with self.assertRaises(rot.RotateError) as cm:
                    rot._finish_cleanup_or_fail(txn, "ROTATE_OK %s" % txn["transaction"])
        self.assertNotIn("ROTATE_OK", buf.getvalue())
        self.assertIn("cleanup", str(cm.exception))


class SecretLeakTests(OfflineTestCase):
    def test_remote_reason_unknown_not_echoed(self):
        with mock.patch.object(dpl, "remote_exec",
                               return_value=ExecResultStub(rc=1, out=b'{"ok":false,"reason":"LEAK SENTINEL"}', err=b"LEAK SENTINEL")):
            with self.assertRaises(rot.RotateError) as cm:
                rot.run_remote_apply(mode="apply", txn_id="a" * 32, expected_old="x",
                                     expected_new="y", payload=b"z", container="c",
                                     expected_cid="c", expected_config_hash="h", restart=["true"],
                                     owner=None, target_owner=None, snapshot_hash="s",
                                     snapshot_owner=(0, 0), snapshot_mode=0o600,
                                     restart_gate="apply")
        self.assertNotIn("LEAK SENTINEL", str(cm.exception))
        self.assertIn("UNKNOWN", str(cm.exception))

    def test_cli_main_redacts_exception(self):
        secret = "SUPERSECRET"
        with mock.patch.object(rot, "cmd_status", side_effect=RuntimeError(secret)):
            import io
            from contextlib import redirect_stderr
            buf = io.StringIO()
            with redirect_stderr(buf):
                rc = rot.main(["status", "--transaction", "a" * 32])
        self.assertEqual(rc, 2)
        self.assertNotIn(secret, buf.getvalue())

    def test_rotate_failure_no_secret_in_txn_or_output(self):
        old_v, old_u = "OLDVIEWERSECRET123", "OLDUPLOADSECRET123"
        new_v, new_u = "NEWVIEWERSECRET123", "NEWUPLOADSECRET123"
        ob = creds_bytes(old_v, old_u)
        raw_written = {}
        with temp_state() as root, noop_lock():
            def cap_write(txn):
                raw_written["raw"] = json.dumps(txn)
                raise rot.RotateError("simulated failure")
            with mock.patch.object(rot, "read_remote_active", return_value=None), \
                 mock.patch.object(rot, "read_remote_credentials", return_value=(ob, 1000, 1000, 0o600)), \
                 mock.patch.object(dpl, "keychain_get", side_effect=lambda *a: old_v if "viewer" in a[0] else old_u), \
                 mock.patch.object(rot, "_verify_against_bytes"), \
                 mock.patch.object(dpl, "generate_viewer_password", return_value=new_v), \
                 mock.patch.object(dpl, "generate_upload_token", return_value=new_u), \
                 mock.patch.object(rot, "preflight_online"), \
                 mock.patch.object(rot, "capture_baseline", side_effect=rot.RotateError("baseline")), \
                 mock.patch.object(rot, "_write_txn", side_effect=cap_write):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rotate(None)
        for secret in (old_v, old_u, new_v, new_u):
            self.assertNotIn(secret, raw_written.get("raw", ""))


class StrictJsonTests(OfflineTestCase):
    def _raw(self):
        return creds_bytes("VALIDVIEWERSECRET1", "VALIDUPLOADSECRET1")

    def test_duplicate_top_level_key_rejected_no_leak(self):
        d = json.loads(self._raw())
        raw = (
            '{"viewer": {"username": "viewer", "digest": "%s", "password": "LEAKSENTINEL"}, '
            '"viewer": {"username": "viewer", "digest": "%s"}, '
            '"upload": {"digest": "%s"}}'
            % (d["viewer"]["digest"], d["viewer"]["digest"], d["upload"]["digest"])
        ).encode()
        with self.assertRaises(rot.RotateError) as cm:
            rot.validate_credentials_bytes(raw)
        self.assertIn("重复键", str(cm.exception))
        self.assertNotIn("LEAKSENTINEL", str(cm.exception))

    def test_duplicate_nested_key_rejected_no_leak(self):
        d = json.loads(self._raw())
        raw = (
            '{"viewer": {"username": "viewer", "digest": "%s", '
            '"password": "LEAKSENTINEL", "password": "LEAKSENTINEL"}, '
            '"upload": {"digest": "%s"}}'
            % (d["viewer"]["digest"], d["upload"]["digest"])
        ).encode()
        with self.assertRaises(rot.RotateError) as cm:
            rot.validate_credentials_bytes(raw)
        self.assertNotIn("LEAKSENTINEL", str(cm.exception))

    def test_normal_material_contains_no_plaintext(self):
        v, u = "PLAINTEXTV1234567", "PLAINTEXTU1234567"
        raw = creds_bytes(v, u)
        self.assertNotIn(v.encode(), raw)
        self.assertNotIn(u.encode(), raw)
        decoded = base64.b64decode(base64.b64encode(raw))
        self.assertNotIn(v.encode(), decoded)
        self.assertNotIn(u.encode(), decoded)

    def test_cleanup_oserror_secret_not_echoed(self):
        # B6：clear 抛 OSError 时只记录固定类别，绝不回显底层异常字符串
        txn, _, _, _ = full_txn()
        sentinel = "OSERRORLEAKSENTINEL"
        with mock.patch.object(rot, "remote_clear_active",
                               side_effect=OSError(sentinel)), \
             mock.patch.object(rot, "_write_txn"), \
             mock.patch.object(rot, "log") as lg:
            active = rot._try_clear_active(txn)
        self.assertFalse(active)
        self.assertIs(txn["activeCleared"], False)
        for call in lg.call_args_list:
            self.assertNotIn(sentinel, " ".join(str(a) for a in call.args))


class LocalLockBusyTests(OfflineTestCase):
    def test_real_second_process_lock_blocks_resume_zero_formal(self):
        # B4：另一个真实进程持有本地锁时，resume 必须在任何 remote/formal 动作前停止
        txn, _, _, _ = full_txn()
        txn["phase"] = "applied"
        with temp_state() as root:
            lock_path = os.path.join(root, ".lock")
            code = (
                "import fcntl, os, sys, time\n"
                "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\n"
                "fcntl.flock(fd, fcntl.LOCK_EX)\n"
                "sys.stdout.write('ready\\n')\n"
                "sys.stdout.flush()\n"
                "time.sleep(30)\n"
            )
            proc = subprocess.Popen([sys.executable, "-c", code, lock_path],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                assert proc.stdout is not None and proc.stderr is not None
                line = proc.stdout.readline()
                self.assertEqual(line.strip(), b"ready")
                with mock.patch.object(rot, "_read_txn", return_value=txn), \
                     mock.patch.object(rot, "remote_observe") as observe, \
                     mock.patch.object(rot, "keychain_update_formal") as kc:
                    with self.assertRaises(rot.RotateError) as cm:
                        rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
                self.assertIn("锁忙", str(cm.exception))
                observe.assert_not_called()
                kc.assert_not_called()
            finally:
                proc.kill()
                proc.wait()
                if proc.stdout is not None:
                    proc.stdout.close()
                if proc.stderr is not None:
                    proc.stderr.close()


class CurlSafetyTests(OfflineTestCase):
    def _curl_capture(self, statuses):
        captured = []
        queue = list(statuses)

        def fake(args, stdin=None, timeout=120):
            captured.append({"args": list(args), "config": (stdin or b"").decode()})
            m = re.search(r'write-out = "\\n([A-Za-z0-9]+):%\{http_code\}"', captured[-1]["config"])
            if m is None:
                raise AssertionError("缺少 write-out marker")
            marker = m.group(1)
            status = queue.pop(0) if queue else 200
            return ExecResultStub(rc=0, out=("body\n" + marker + ":" + str(status)).encode())

        return captured, fake

    def test_config_stdin_head_no_put_body_devnull(self):
        captured, fake = self._curl_capture([200])
        with mock.patch.object(dpl, "local_exec", side_effect=fake):
            rot.curl_status("/", "GET", "Basic SECRET", head=True)
        self.assertEqual(captured[0]["args"], [dpl.CURL, "-q", "--config", "-"])
        config = captured[0]["config"]
        self.assertIn('\nhead\n', config)
        self.assertNotIn("head = true", config)
        self.assertIn('output = "/dev/null"', config)
        self.assertIn('noproxy = "*"', config)
        self.assertNotIn("SECRET", " ".join(captured[0]["args"]))
        self.assertNotIn("data-binary", config)
        self.assertNotIn('request = "PUT"', config)

    def test_generated_config_parses_with_real_curl(self):
        for head in (True, False):
            captured, fake = self._curl_capture([200])
            with mock.patch.object(dpl, "local_exec", side_effect=fake):
                rot.curl_status("/api/meta", "GET", "Bearer S", head=head)
            proc = subprocess.run([dpl.CURL, "-q", "--config", "-", "--version"],
                                  input=captured[0]["config"].encode(), capture_output=True, timeout=15)
            self.assertEqual(proc.returncode, 0, proc.stderr.decode())

    def test_matrix_seven_items_no_put(self):
        captured, fake = self._curl_capture([200, 401, 200, 401, 403, 403, 405])
        with mock.patch.object(dpl, "local_exec", side_effect=fake):
            rot.tls_matrix("new", "OV", "OU", "NV", "NU")
        self.assertEqual(len(captured), 7)
        joined = "\n".join(c["config"] for c in captured)
        self.assertNotIn('request = "PUT"', joined)
        self.assertNotIn("data-binary", joined)

    def test_matrix_mismatch_raises(self):
        captured, fake = self._curl_capture([500] * 7)
        with mock.patch.object(dpl, "local_exec", side_effect=fake):
            with self.assertRaises(rot.RotateError):
                rot.tls_matrix("new", "OV", "OU", "NV", "NU")

    def test_preflight_online_checks(self):
        captured, fake = self._curl_capture([200, 200])
        with mock.patch.object(dpl, "local_exec", side_effect=fake):
            rot.preflight_online("OV", "OU")
        self.assertEqual(len(captured), 2)
        captured, fake = self._curl_capture([401, 200])
        with mock.patch.object(dpl, "local_exec", side_effect=fake):
            with self.assertRaises(rot.RotateError):
                rot.preflight_online("OV", "OU")


class StatusReadOnlyTests(OfflineTestCase):
    def test_status_incomplete_and_no_write(self):
        txn, sec, ob, nb = full_txn()
        del txn["containerId"]
        txn["phase"] = "preparing"
        with temp_state() as root:
            d = os.path.join(root, txn["transaction"])
            os.makedirs(d, 0o700)
            with open(os.path.join(d, "txn.json"), "w") as fh:
                json.dump(txn, fh)
            os.chmod(os.path.join(d, "txn.json"), 0o600)
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with mock.patch.object(rot, "read_remote_credentials", return_value=(ob, 1000, 1000, 0o600)), \
                 mock.patch.object(rot, "_write_txn") as wt, \
                 mock.patch.object(rot, "local_lock") as lock, \
                 mock.patch.object(dpl, "container_state_ok", return_value=True), \
                 mock.patch.object(dpl, "keychain_exists", return_value=False):
                with redirect_stdout(buf):
                    rc = rot.cmd_status(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        wt.assert_not_called()
        lock.assert_not_called()
        self.assertIn('"identityFields": "incomplete"', buf.getvalue())

    def test_status_ssh_error_reports_unknown_not_missing(self):
        # B5：远端 SSH/读取失败必须报 unknown，绝不误报 missing
        txn, sec, ob, nb = full_txn()
        with temp_state() as root:
            d = os.path.join(root, txn["transaction"])
            os.makedirs(d, 0o700)
            with open(os.path.join(d, "txn.json"), "w") as fh:
                json.dump(txn, fh)
            os.chmod(os.path.join(d, "txn.json"), 0o600)
            import io
            from contextlib import redirect_stdout
            buf = io.StringIO()
            with mock.patch.object(rot, "_current_cred_sha",
                                   side_effect=rot.RotateError("ssh down")), \
                 mock.patch.object(dpl, "container_state_ok", return_value=True), \
                 mock.patch.object(dpl, "keychain_exists", return_value=False):
                with redirect_stdout(buf):
                    rc = rot.cmd_status(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn('"remote": "unknown"', out)
        self.assertNotIn('"remote": "missing"', out)


class CliContractTests(OfflineTestCase):
    def test_reject_force_host_path(self):
        parser = rot.build_parser()
        for bad in (["rotate", "--force"], ["status", "--host", "evil"],
                    ["resume", "--transaction", "x", "--path", "/etc/passwd"]):
            with self.assertRaises(SystemExit):
                parser.parse_args(bad)

    def test_transaction_id_strict(self):
        with self.assertRaises(rot.RotateError):
            rot._assert_txn_id("../../etc/passwd")
        self.assertEqual(rot._assert_txn_id("a" * 32), "a" * 32)

    def test_no_deploy_probe_or_smoke(self):
        with mock.patch.object(dpl, "probe_loopback") as probe, \
             mock.patch.object(dpl, "smoke") as smoke, \
             mock.patch.object(dpl, "https_role_probe") as role:
            # 仅导入/构造 parser 不应触发任何探针
            rot.build_parser()
        probe.assert_not_called()
        smoke.assert_not_called()
        role.assert_not_called()


if __name__ == "__main__":
    unittest.main()
