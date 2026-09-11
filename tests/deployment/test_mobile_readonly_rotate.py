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
        self.uid = os.getuid()
        self.gid = os.getgid()
        self.data = os.path.join(self.td, "data")
        os.mkdir(self.data, 0o700)
        self.snap_dir = os.path.join(self.data, "snapshots")
        os.mkdir(self.snap_dir, 0o700)
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
        self.base_marker = os.path.join(self.data, ".deploy-managed")
        self._write(self.base_marker, b"relocation-mobile-readonly\n", 0o600)
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
        return hashlib.sha256(data if data is not None else open(self.snap, "rb").read()).hexdigest()

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
        base = dict(
            container="relocation-mobile-readonly", target=self.target, target_parent=self.data,
            target_owner=(self.uid, self.gid), target_mode=0o600,
            data_base=self.data, data_marker=self.base_marker,
            data_marker_value="relocation-mobile-readonly",
            data_owner=(self.uid, self.gid), data_mode=0o700,
            snapshot=self.snap, expected_snapshot_hash=self.snapshot_hash(),
            snapshot_owner=(self.uid, self.gid), snapshot_mode=0o600,
            directory=self.rot, marker=self.marker, value="relocation-mobile-readonly-rotate",
            lock=self.lock, active=self.active, uid=self.uid,
            cid_cmd=self.cid_cmd(), inspect_cmd=self.inspect_cmd(),
        )
        base.update(over)
        return base


def run_remote_apply_local(env, *, mode, txn_id, expected_old, expected_new, payload,
                           restart, owner, restart_gate="apply", **over):
    """在本地真实执行远端 helper（本地命令替换 docker）。"""
    def local_remote(shell, stdin=None, timeout=120):
        proc = subprocess.run([sys.executable, "-c", python_source(shell)],
                              input=stdin, capture_output=True, timeout=timeout)
        return ExecResultStub(proc.returncode, proc.stdout, proc.stderr)
    kwargs = env.kwargs(**over)
    with mock.patch.object(dpl, "remote_exec", side_effect=local_remote):
        return rot.run_remote_apply(
            mode=mode, txn_id=txn_id, expected_old=expected_old, expected_new=expected_new,
            payload=payload, restart=restart, owner=owner, restart_gate=restart_gate,
            expected_cid=kwargs.pop("expected_cid", "ctr123"),
            expected_config_hash=kwargs.pop("expected_config_hash", env.config_hash()),
            snapshot_hash=kwargs.pop("expected_snapshot_hash"),
            snapshot_owner=kwargs.pop("snapshot_owner"),
            snapshot_mode=kwargs.pop("snapshot_mode"),
            **kwargs)


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
# 3/4. 远端 helper：CAS/身份/故障注入
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

    def _restart(self, **over):
        self._to_new()
        return run_remote_apply_local(
            self.env, mode="restart", txn_id=self.env.txn,
            expected_old=hashlib.sha256(self.env.new).hexdigest(),
            expected_new=hashlib.sha256(self.env.new).hexdigest(),
            payload=b"", restart=self.env.restart_cmd(), owner=None,
            restart_gate="stale", **over)

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
            run_remote_apply_local(
                self.env, mode="apply", txn_id=self.env.txn, expected_old="0" * 64,
                expected_new=hashlib.sha256(self.env.new).hexdigest(),
                payload=self.env.new, restart=self.env.restart_cmd(),
                owner=(self.env.uid, self.env.gid))
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
        changed = b'{"business":"changed"}\n'
        open(self.env.snap, "wb").write(changed)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(expected_snapshot_hash=before)
        self.assertIn("SNAPSHOT_MISMATCH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_target_mode_abnormal_stops(self):
        os.chmod(self.env.target, 0o644)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("TARGET_", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_target_owner_abnormal_stops(self):
        with self.assertRaises(rot.RotateError):
            self._apply(target_owner=(self.env.uid + 1, self.env.gid))

    def test_unknown_dir_marker_missing_stops(self):
        os.unlink(self.env.marker)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("MARKER_MISSING", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

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

    def test_active_other_stops(self):
        with open(self.env.active, "w") as fh:
            fh.write("b" * 32 + "\n")
        os.chmod(self.env.active, 0o600)
        with self.assertRaises(rot.RotateError) as cm:
            self._apply()
        self.assertIn("ACTIVE_OTHER", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_restart_gate_exited_requires_exited(self):
        # running + gate exited -> 不重启也不写
        self._to_new()
        res = run_remote_apply_local(
            self.env, mode="restart", txn_id=self.env.txn,
            expected_old=hashlib.sha256(self.env.new).hexdigest(),
            expected_new=hashlib.sha256(self.env.new).hexdigest(),
            payload=b"", restart=self.env.restart_cmd(), owner=None,
            restart_gate="exited", inspect_cmd=self.env.runtime("running"))
        self.assertTrue(res["ok"])
        self.assertFalse(res["restarted"])
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_restart_gate_exited_running_restarts(self):
        self._to_new()
        res = run_remote_apply_local(
            self.env, mode="restart", txn_id=self.env.txn,
            expected_old=hashlib.sha256(self.env.new).hexdigest(),
            expected_new=hashlib.sha256(self.env.new).hexdigest(),
            payload=b"", restart=self.env.restart_cmd(), owner=None,
            restart_gate="exited", inspect_cmd=self.env.runtime("exited"))
        self.assertTrue(res["restarted"])
        self.assertTrue(os.path.exists(self.env.restart_log))

    def test_restart_gate_stale_running_restarts(self):
        res = self._restart()
        self.assertTrue(res["restarted"])

    def test_restart_failure_reports_changed(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(restart=[sys.executable, "-c", "raise SystemExit(3)"])
        self.assertIn("RESTART_FAIL", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.new)

    def test_clear_own_active(self):
        with open(self.env.active, "w") as fh:
            fh.write(self.env.txn + "\n")
        os.chmod(self.env.active, 0o600)
        res = run_remote_apply_local(
            self.env, mode="clear", txn_id=self.env.txn, expected_old="", expected_new="",
            payload=b"", restart=[], owner=None, restart_gate="none")
        self.assertTrue(res["cleared"])
        self.assertFalse(os.path.exists(self.env.active))

    def test_clear_other_active_not_cleared(self):
        with open(self.env.active, "w") as fh:
            fh.write("b" * 32 + "\n")
        os.chmod(self.env.active, 0o600)
        res = run_remote_apply_local(
            self.env, mode="clear", txn_id=self.env.txn, expected_old="", expected_new="",
            payload=b"", restart=[], owner=None, restart_gate="none")
        self.assertFalse(res["cleared"])
        self.assertTrue(os.path.exists(self.env.active))

    def test_payload_hash_mismatch(self):
        with self.assertRaises(rot.RotateError) as cm:
            self._apply(payload=b"tampered")
        self.assertIn("PAYLOAD_HASH", str(cm.exception))
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)


class RemoteApplyFaultInjectionTests(OfflineTestCase):
    """注入 write/fsync/replace/dirsync 故障：状态保留、不假成功。"""

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
            cid_cmd=kwargs["cid_cmd"], inspect_cmd=kwargs["inspect_cmd"], uid=self.env.uid)

    def test_os_write_failure(self):
        code = self._render().replace("w += os.write(fd, mv[w:])",
                                      "raise OSError('inject-write')")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = json.loads(out.decode().strip().splitlines()[-1])
        self.assertFalse(data["ok"])
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)

    def test_os_replace_failure(self):
        code = self._render().replace(
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)",
            "raise OSError('inject-replace')")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = json.loads(out.decode().strip().splitlines()[-1])
        self.assertEqual(data["reason"], "WRITE_FAIL")
        self.assertEqual(open(self.env.target, "rb").read(), self.env.old)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_dirfsync_failure_after_replace(self):
        code = self._render().replace(
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)\n            os.fsync(dirfd)",
            "os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)\n            raise OSError('inject-dirsync')")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = json.loads(out.decode().strip().splitlines()[-1])
        self.assertEqual(data["reason"], "WRITE_FAIL")
        # replace 已发生：文件为新值，但明确报告失败、不重启
        self.assertEqual(open(self.env.target, "rb").read(), self.env.new)
        self.assertFalse(os.path.exists(self.env.restart_log))

    def test_replace_recheck_toctou(self):
        code = self._render().replace(
            "pre, pst = read_nofollow(TARGET)",
            "open(TARGET,'wb').write(b'tampered');\n            pre, pst = read_nofollow(TARGET)")
        rc, out, _ = self._run_code(code, stdin=self.env.new)
        data = json.loads(out.decode().strip().splitlines()[-1])
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
         mock.patch.object(rot, "read_remote_active", return_value=None):
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
        txn, _, ob, nb = full_txn()
        refs = txn["staging"]

        def fake_get(service, account):
            table = {
                refs["old_viewer"]: "OV", refs["old_upload"]: "OV",  # 串角色：upload 用 viewer 值
                refs["new_viewer"]: "NV", refs["new_upload"]: "NU",
            }
            return table[service]

        with mock.patch.object(dpl, "keychain_get", side_effect=fake_get):
            with self.assertRaises(rot.RotateError):
                rot.assert_staging_matches(txn)

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
    def _patch_resume_common(self, txn, secrets, kind, *, tls_exc=False, formal=(None, None)):
        stack = contextlib.ExitStack()
        add = stack.enter_context
        add(mock.patch.object(rot, "_read_txn", return_value=txn))
        add(mock.patch.object(rot, "validate_txn", return_value=("ob", "nb")))
        add(mock.patch.object(rot, "assert_staging_matches", return_value=secrets))
        add(mock.patch.object(rot, "formal_pair", return_value=formal))
        add(mock.patch.object(rot, "read_remote_active", return_value=None))
        add(mock.patch.object(rot, "_current_cred_sha", return_value=kind))
        add(mock.patch.object(rot, "reconfirm_identity"))
        add(mock.patch.object(rot, "_write_txn"))
        add(mock.patch.object(rot, "remote_prepare_dir"))
        add(mock.patch.object(rot, "_apply_to_new"))
        add(mock.patch.object(rot, "_verify_against_bytes"))
        if tls_exc:
            add(mock.patch.object(rot, "wait_tls_matrix", side_effect=rot.RotateError("TLS 矩阵失败")))
        else:
            add(mock.patch.object(rot, "wait_tls_matrix"))
        add(mock.patch.object(rot, "reconfirm_baseline"))
        add(mock.patch.object(rot, "keychain_update_formal"))
        add(mock.patch.object(dpl, "keychain_get",
                              side_effect=lambda service, account: secrets[2] if account == dpl.VIEWER_ACCOUNT else secrets[3]))
        add(mock.patch.object(rot, "_remote_new_matches", return_value=True))
        add(mock.patch.object(rot, "remote_clear_active", return_value={"cleared": True}))
        return stack

    def test_resume_old_tls_fail_zero_formal_write(self):
        txn, secrets, ob, nb = full_txn()
        txn["phase"] = "prepared"
        with temp_state(), noop_lock():
            stack = self._patch_resume_common(txn, secrets, txn["oldHash"], tls_exc=True)
            with stack:
                keychain_update = mock.patch.object(rot, "keychain_update_formal")
                with keychain_update as kc:
                    with self.assertRaises(rot.RotateError):
                        rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
                kc.assert_not_called()
        self.assertEqual(txn["phase"], "failed")

    def test_resume_old_success_verifies_then_commits(self):
        txn, secrets, ob, nb = full_txn()
        txn["phase"] = "prepared"
        events = []
        with temp_state(), noop_lock():
            stack = self._patch_resume_common(txn, secrets, txn["oldHash"],
                                              formal=(secrets[0], secrets[1]))
            with stack:
                with mock.patch.object(rot, "_apply_to_new", side_effect=lambda *a, **k: events.append("apply")), \
                     mock.patch.object(rot, "wait_tls_matrix", side_effect=lambda *a, **k: events.append("tls")), \
                     mock.patch.object(rot, "keychain_update_formal", side_effect=lambda *a, **k: events.append("formal")):
                    rc = rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertLess(events.index("apply"), events.index("tls"))
        self.assertLess(events.index("tls"), events.index("formal"))

    def test_commit_checks_remote_new_before_formal(self):
        txn, secrets, ob, nb = full_txn()
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_remote_new_matches", return_value=False), \
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

        with mock.patch.object(rot, "_remote_new_matches", return_value=True), \
             mock.patch.object(rot, "keychain_update_formal", side_effect=upd), \
             mock.patch.object(dpl, "keychain_get", side_effect=lambda *a: secrets[2]), \
             mock.patch.object(rot, "reconfirm_identity"):
            with self.assertRaises(rot.RotateError):
                rot._commit_formal(txn, secrets, ob, nb)
        self.assertNotEqual(txn["phase"], "complete")


class ResumeStateTests(OfflineTestCase):
    def _resume_new(self, *, state, full_ok, stale, formal=None, secrets=None):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "applied"
        secrets = secrets or sec
        events = []
        with temp_state(), noop_lock():
            stack = contextlib.ExitStack()
            stack.enter_context(mock.patch.object(rot, "_read_txn", return_value=txn))
            stack.enter_context(mock.patch.object(rot, "validate_txn", return_value=(ob, nb)))
            stack.enter_context(mock.patch.object(rot, "assert_staging_matches", return_value=secrets))
            stack.enter_context(mock.patch.object(rot, "formal_pair", return_value=(secrets[0], secrets[1])))
            stack.enter_context(mock.patch.object(rot, "read_remote_active", return_value=None))
            stack.enter_context(mock.patch.object(rot, "_current_cred_sha", return_value=txn["newHash"]))
            stack.enter_context(mock.patch.object(rot, "_write_txn"))
            stack.enter_context(mock.patch.object(rot, "reconfirm_identity"))
            stack.enter_context(mock.patch.object(
                rot, "_restart_once",
                side_effect=lambda *a, **k: events.append(("restart", a[1]))))
            stack.enter_context(mock.patch.object(rot, "remote_prepare_dir"))
            stack.enter_context(mock.patch.object(rot, "wait_tls_matrix"))
            stack.enter_context(mock.patch.object(rot, "reconfirm_baseline"))
            stack.enter_context(mock.patch.object(rot, "keychain_update_formal"))
            stack.enter_context(mock.patch.object(
                dpl, "keychain_get",
                side_effect=lambda service, account: secrets[2] if account == dpl.VIEWER_ACCOUNT else secrets[3]))
            stack.enter_context(mock.patch.object(rot, "_remote_new_matches", return_value=True))
            stack.enter_context(mock.patch.object(rot, "remote_clear_active", return_value={"cleared": True}))
            stack.enter_context(mock.patch.object(dpl, "container_state_ok", return_value=full_ok))
            stack.enter_context(mock.patch.object(rot, "container_runtime_state", return_value=state))
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
        self.assertEqual([e[1] for e in events], ["stale"])

    def test_running_without_evidence_does_not_restart(self):
        txn, rc, events = self._resume_new(state="running", full_ok=True, stale=False)
        self.assertEqual(rc, 0)
        self.assertEqual(events, [])

    def test_exited_with_identity_restarts_gate_exited(self):
        txn, rc, events = self._resume_new(state="exited", full_ok=False, stale=False)
        self.assertEqual(rc, 0)
        self.assertEqual([e[1] for e in events], ["exited"])

    def test_unknown_state_no_restart(self):
        txn, _, _ = self._resume_new(state="unknown", full_ok=False, stale=False)
        self.assertEqual(txn["phase"], "failed")

    def test_third_state_stops(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "applied"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=(sec[0], sec[1])), \
                 mock.patch.object(rot, "read_remote_active", return_value=None), \
                 mock.patch.object(rot, "_current_cred_sha", return_value="9" * 64), \
                 mock.patch.object(rot, "_write_txn"):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(txn["phase"], "failed")

    def test_active_mismatch_stops(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "applied"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=(sec[0], sec[1])), \
                 mock.patch.object(rot, "read_remote_active", return_value="b" * 32):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_resume(mock.Mock(transaction=txn["transaction"]))


class RollbackTests(OfflineTestCase):
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
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=(sec[0], sec[1])), \
                 mock.patch.object(rot, "read_remote_active", return_value=None), \
                 mock.patch.object(rot, "_current_cred_sha", return_value=txn["newHash"]), \
                 mock.patch.object(rot, "reconfirm_identity"), \
                 mock.patch.object(rot, "run_remote_apply", side_effect=lambda **k: recorded.update(k) or {"ok": True, "changed": True}), \
                 mock.patch.object(rot, "remote_prepare_dir"), \
                 mock.patch.object(rot, "reconfirm_baseline"), \
                 mock.patch.object(rot, "wait_tls_matrix") as wtm, \
                 mock.patch.object(rot, "keychain_update_formal"), \
                 mock.patch.object(dpl, "keychain_get", side_effect=lambda service, account: sec[0] if account == dpl.VIEWER_ACCOUNT else sec[1]), \
                 mock.patch.object(rot, "remote_clear_active", return_value={"cleared": True}), \
                 mock.patch.object(rot, "_write_txn"):
                rc = rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))
        self.assertEqual(rc, 0)
        self.assertEqual(recorded["expected_old"], txn["newHash"])
        self.assertEqual(recorded["expected_new"], txn["oldHash"])
        self.assertEqual(recorded["payload"], ob)
        self.assertEqual(wtm.call_args.args[0], "old")

    def test_rollback_third_state_stops(self):
        txn, sec, ob, nb = full_txn()
        txn["phase"] = "complete"
        with temp_state(), noop_lock():
            with mock.patch.object(rot, "_read_txn", return_value=txn), \
                 mock.patch.object(rot, "validate_txn", return_value=(ob, nb)), \
                 mock.patch.object(rot, "assert_staging_matches", return_value=sec), \
                 mock.patch.object(rot, "formal_pair", return_value=(sec[0], sec[1])), \
                 mock.patch.object(rot, "read_remote_active", return_value=None), \
                 mock.patch.object(rot, "_current_cred_sha", return_value="9" * 64):
                with self.assertRaises(rot.RotateError):
                    rot.cmd_rollback(mock.Mock(transaction=txn["transaction"]))


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
