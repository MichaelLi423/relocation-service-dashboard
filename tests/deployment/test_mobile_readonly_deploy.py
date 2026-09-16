"""本地单元测试：scripts/deploy-mobile-readonly.py（无远端/无真实 Keychain/无真实凭据）。

mock 掉所有 subprocess 出入口，只验证命令构造、错误脱敏、字节/文本一致性、
密钥不出现于 argv、redirect/证书安全、自有资源保护与 smoke CAS 行为。
运行：python3 -m unittest discover -s tests/deployment

dispatch 规则：每条 mock 都显式列出精确 shell 匹配；未匹配的命令直接抛 AssertionError，
绝不静默 `startswith` 兜底放行。
"""

import ast
import importlib.util
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO / "scripts" / "deploy-mobile-readonly.py"


def load_module():
    spec = importlib.util.spec_from_file_location("mrdeploy", _SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载部署脚本")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


dpl = load_module()


class ExecResultStub:
    def __init__(self, rc=0, out=b"", err=b"", timed_out=False):
        self.rc = rc
        self.out = out
        self.err = err
        self.timed_out = timed_out

    def text(self):
        return self.out.decode("utf-8", "replace")


class UnhandledShell(AssertionError):
    pass


def q(path):
    return shlex.quote(path)


def exact(shell: str):
    return lambda got: got == shell


def starts(shell: str):
    return lambda got: got.startswith(shell)


def python_source(shell: str) -> str:
    """还原远端 `python3 -c <code>` 的真实 -c 源码。

    与脚本 remote_write_bytes/PROBE_PY 的构造一致：shlex.split 必须恰为
    python3 / -c / 单段源码；随后 AST 定位唯一的 base64.b64decode 常量实参并解码。
    不做子串猜测——shlex.quote 会产生 '"'"' 片段，正则/`in` 都会失配或误配。
    """
    parts = shlex.split(shell)
    if len(parts) != 3 or parts[0] != "python3" or parts[1] != "-c":
        raise AssertionError(f"不是 python3 -c 形状: {shell!r}")
    code = parts[2]
    found = []
    for node in ast.walk(ast.parse(code)):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "base64"
                and node.func.attr == "b64decode"
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            found.append(node.args[0].value)
    if len(found) != 1:
        raise AssertionError(f"-c 源码应恰含一个 base64.b64decode 常量实参，实际 {len(found)}")
    return base64.b64decode(found[0]).decode("utf-8")


def strict_fake(handlers):
    """精确 dispatch：首个命中生效；无一命中即抛 UnhandledShell（禁止静默 rc=1 兜底）。"""

    def fake(shell, stdin=None, timeout=120):
        for matcher, result in handlers:
            if matcher(shell):
                if isinstance(result, ExecResultStub):
                    return result
                return result(shell, stdin)
        raise UnhandledShell(shell)

    return fake


def base_existing_marker_handlers():
    """REMOTE_BASE 已存在且托管标记精确匹配 所需的精确 shell 序列。"""
    base = q(dpl.REMOTE_BASE)
    data = q(dpl.REMOTE_DATA_DIR)
    marker = q(dpl.MARKER_FILE)
    return [
        (exact(f"test -L {base}"), ExecResultStub(rc=1)),
        (exact(f"test -L {data}"), ExecResultStub(rc=1)),
        (exact(f"test -e {base}"), ExecResultStub(rc=0)),
        (exact(f"test -L {marker}"), ExecResultStub(rc=1)),
        (exact(f"test -f {marker}"), ExecResultStub(rc=0)),
        (exact(f"cat {marker}"), ExecResultStub(rc=0, out=(dpl.MARKER_VALUE + "\n").encode())),
    ]


def creds_absent_handlers():
    return [
        (exact(f"test -f {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=1)),
    ]


def curl_fake(captured, body=b'{"ok":true}', status=200):
    """模拟 curl：从 stdin config 解析 write-out marker，返回 body + marker:status。"""

    def fake(args, stdin=None, timeout=120):
        captured["args"] = list(args)
        captured["stdin"] = stdin
        config = (stdin or b"").decode("utf-8")
        captured["config"] = config
        m = re.search(r'write-out = "\\n([A-Za-z0-9]+):%\{http_code\}"', config)
        marker = m.group(1) if m else "MRDEPLOY0"
        return ExecResultStub(rc=0, out=body + ("\n" + marker + ":" + str(status)).encode())

    return fake


class KeychainConstructionTests(unittest.TestCase):
    def test_add_uses_security_i_single_command_stdin_no_secret_in_argv(self):
        captured = {}

        def fake_local(args, stdin=None, timeout=120):
            captured["args"] = list(args)
            captured["stdin"] = stdin
            return ExecResultStub(rc=0)

        with mock.patch.object(dpl, "local_exec", side_effect=fake_local):
            dpl.keychain_add("svc-x", "acct-x", "SECRET_ABC")

        self.assertEqual(captured["args"], [dpl.SECURITY, "-i"])
        self.assertIsNotNone(captured["stdin"])
        text = captured["stdin"].decode("utf-8")
        # 单条完整命令 + 换行 + EOF；不得带 quit
        self.assertIn("add-generic-password -a acct-x -s svc-x -w SECRET_ABC", text)
        self.assertTrue(text.endswith("\n"))
        self.assertNotIn("quit", text)
        self.assertNotIn("SECRET_ABC", " ".join(captured["args"]))

    def test_add_duplicate_without_dash_u_is_treated_as_failure(self):
        with mock.patch.object(dpl, "local_exec", return_value=ExecResultStub(rc=45)):
            with self.assertRaises(dpl.DeployError):
                dpl.keychain_add("svc", "acct", "s")


class BytesTextConsistencyTests(unittest.TestCase):
    def test_remote_true_decodes_utf8_output(self):
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc=0, out="ok\n".encode())):
            self.assertEqual(dpl.remote_true("echo ok"), "ok")

    def test_error_is_opaque_even_if_output_contains_secret(self):
        secret = "SECRET_XYZ"
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc=1, err=secret.encode())):
            with self.assertRaises(dpl.DeployError) as cm:
                dpl.require_ok(dpl.remote_exec("bad"), "某操作")
        self.assertNotIn(secret, str(cm.exception))


class CurlSafetyTests(unittest.TestCase):
    def test_curl_config_rejects_redirect_and_uses_stdin(self):
        captured = {}
        with mock.patch.object(dpl, "local_exec",
                               side_effect=curl_fake(captured, body=b'{"m":1}', status=200)):
            status, body = dpl.curl_request(
                f"https://{dpl.NGINX_HOST}/api/meta", 443, "GET",
                "Bearer TOK_X", None)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"m":1}')
        # 精确 argv：curl -q --config -（-q 必须在最前）
        self.assertEqual(captured["args"], [dpl.CURL, "-q", "--config", "-"])
        config = captured["config"]
        # 无输出文件、无 -L/-k、无代理、无明文 argv
        self.assertNotIn("output =", config)
        self.assertNotIn("-L", captured["args"])
        self.assertNotIn("-k", captured["args"])
        self.assertIn(f"resolve = \"{dpl.NGINX_HOST}:443:8.162.13.22\"", config)
        self.assertIn('noproxy = "*"', config)
        self.assertNotIn("TOK_X", " ".join(captured["args"]))

    def test_curl_auth_header_only_in_stdin(self):
        captured = {}
        with mock.patch.object(dpl, "local_exec", side_effect=curl_fake(captured)):
            dpl.curl_request(f"https://{dpl.NGINX_HOST}/x", 443, "GET", "Bearer SEC", None)
        self.assertNotIn("SEC", " ".join(captured["args"]))
        self.assertIn('header = "Authorization: Bearer SEC"', captured["config"])

    def test_curl_body_inline_data_binary_never_tempfile(self):
        captured = {}
        body = json.dumps({"protocol": {"publicationId": "P", "expectedCurrentVersion": 0}}).encode()
        with mock.patch.object(dpl, "local_exec", side_effect=curl_fake(captured)):
            dpl.curl_request(f"https://{dpl.NGINX_HOST}/api/publish", 443, "PUT",
                             "Bearer SEC", body)
        config = captured["config"]
        # 正文经 json.dumps 转义内联，禁止临时文件 @路径
        self.assertNotIn("data-binary = \"@", config)
        self.assertNotIn("output =", config)
        self.assertIn("data-binary = ", config)
        self.assertIn('header = "Content-Type: application/json"', config)
        self.assertIn("P", config)  # 正文确实在 config 中
        self.assertNotIn("SEC", " ".join(captured["args"]))

    def test_curl_rejects_auth_with_quote_crlf(self):
        for bad in ('to"ken', "tok\nX", "tok\rX", "tok\\X"):
            with self.assertRaises(dpl.DeployError):
                dpl.curl_request(f"https://{dpl.NGINX_HOST}/x", 443, "GET", bad, None)

    def test_curl_parse_requires_numeric_status_suffix(self):
        captured = {}

        def fake_bad(args, stdin=None, timeout=120):
            captured["stdin"] = stdin
            m = re.search(r'"\\n([A-Za-z0-9]+):%\{http_code\}"', (stdin or b"").decode("utf-8"))
            if m is None:
                raise AssertionError("未找到 write-out marker")
            marker = m.group(1)
            return ExecResultStub(rc=0, out=b"body\n" + marker.encode() + b":abc")

        with mock.patch.object(dpl, "local_exec", side_effect=fake_bad):
            with self.assertRaises(dpl.DeployError):
                dpl.curl_request(f"https://{dpl.NGINX_HOST}/x", 443, "GET", None, None)


class VhostExclusionChecksumTests(unittest.TestCase):
    def _confd_handlers(self, names, digests, listing_rc=0, ls_out=None):
        """为 remote_conf_d_files 注册精确 shell 序列：ls conf.d 后，对每个非自有 conf、
        以及两处必查 MAIN_FILES（nginx.conf 与既有主域 conf）分别 sha256sum。

        digests 以文件完整路径为键；自有托管 vhost 不注册哈希（脚本不查询它，
        若误查会因无匹配抛 UnhandledShell，绝不用 startswith('sha256sum') 兜底放行）。
        """
        ls = ls_out if ls_out is not None else ("\n".join(names) + "\n").encode()
        handlers = [(exact(f"cd {q(dpl.CONF_D)} && ls -1 *.conf"), ExecResultStub(rc=listing_rc, out=ls))]
        hashed = set()
        for name in names:
            full = dpl.CONF_D + "/" + name
            if full == dpl.VHOST_PATH:
                continue  # 自有托管 vhost：两侧（current/baseline）都不进集合
            hashed.add(full)
        hashed.update(dpl.MAIN_FILES)
        for full in sorted(hashed):
            handlers.append((exact(f"sha256sum {q(full)}"),
                             ExecResultStub(rc=0, out=(digests[full] + "\n").encode())))
        return handlers

    def test_own_vhost_excluded_both_sets(self):
        names = ["other.conf", os.path.basename(dpl.VHOST_PATH)]
        other_b64 = "a" * 64
        digests = {
            dpl.CONF_D + "/other.conf": other_b64,
            dpl.MAIN_FILES[0]: "c" * 64,
            dpl.MAIN_FILES[1]: "d" * 64,
        }
        handlers = self._confd_handlers(names, digests)
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            current = dpl.remote_conf_d_files()
        # 自有 vhost 在 current 侧被排除；其余全部强制文件都在且哈希与 fixture 精确一致
        self.assertNotIn(dpl.VHOST_PATH, current)
        self.assertEqual(current, {
            dpl.CONF_D + "/other.conf": other_b64,
            dpl.MAIN_FILES[0]: digests[dpl.MAIN_FILES[0]],
            dpl.MAIN_FILES[1]: digests[dpl.MAIN_FILES[1]],
        })
        # baseline 侧同样不含自有 vhost；其它文件变化（改动 + 删除）仍必须检出
        baseline = {dpl.CONF_D + "/other.conf": "x" * 64, dpl.CONF_D + "/gone.conf": "y" * 64,
                    dpl.MAIN_FILES[0]: digests[dpl.MAIN_FILES[0]],
                    dpl.MAIN_FILES[1]: digests[dpl.MAIN_FILES[1]]}
        self.assertNotIn(dpl.VHOST_PATH, baseline)
        with mock.patch.object(dpl, "load_baseline", return_value=baseline):
            with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
                with self.assertRaises(dpl.DeployError):
                    dpl.checksums_verify()

    def test_empty_baseline_fails_verify(self):
        with mock.patch.object(dpl, "load_baseline", return_value=None):
            with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake([])):
                with self.assertRaises(dpl.DeployError):
                    dpl.checksums_verify()

    def test_confd_listing_rc_failure_raises(self):
        handlers = [(exact(f"cd {q(dpl.CONF_D)} && ls -1 *.conf"), ExecResultStub(rc=2))]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_conf_d_files()

    def test_empty_confd_listing_raises(self):
        handlers = [(exact(f"cd {q(dpl.CONF_D)} && ls -1 *.conf"), ExecResultStub(rc=0, out=b""))]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_conf_d_files()

    def test_sha256_rc_failure_raises_no_skip(self):
        names = ["other.conf"]
        handlers = [
            (exact(f"cd {q(dpl.CONF_D)} && ls -1 *.conf"), ExecResultStub(rc=0, out=b"other.conf\n")),
            (exact(f"sha256sum {q(dpl.CONF_D + '/other.conf')}"), ExecResultStub(rc=1)),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_conf_d_files()

    def test_sha256_invalid_hex_raises(self):
        names = ["other.conf"]
        handlers = [
            (exact(f"cd {q(dpl.CONF_D)} && ls -1 *.conf"), ExecResultStub(rc=0, out=b"other.conf\n")),
            (exact(f"sha256sum {q(dpl.CONF_D + '/other.conf')}"), ExecResultStub(rc=0, out=b"zzz\n")),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_conf_d_files()


class BaselineFileTests(unittest.TestCase):
    def _patch_state(self, tmpdir, content=None, write_bytes=b"{}"):
        state_dir = str(tmpdir)
        state_file = str(tmpdir / "baseline-checksums.json")
        if content is not None:
            (tmpdir / "baseline-checksums.json").write_text(content, encoding="utf-8")
        p_state_dir = mock.patch.object(dpl, "STATE_DIR", state_dir)
        p_state_file = mock.patch.object(dpl, "STATE_FILE", state_file)
        return p_state_dir, p_state_file

    def test_missing_baseline_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p1, p2 = self._patch_state(Path(td))
            p1.start(), p2.start()
            try:
                self.assertIsNone(dpl.load_baseline())
            finally:
                p1.stop(), p2.stop()

    def test_malformed_baseline_raises_not_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p1, p2 = self._patch_state(Path(td), content="{not json")
            p1.start(), p2.start()
            try:
                with self.assertRaises(dpl.DeployError):
                    dpl.load_baseline()
            finally:
                p1.stop(), p2.stop()

    def test_empty_or_nonobject_baseline_raises(self):
        import tempfile
        for content in ("{}", "[]"):
            with tempfile.TemporaryDirectory() as td:
                p1, p2 = self._patch_state(Path(td), content=content)
                p1.start(), p2.start()
                try:
                    with self.assertRaises(dpl.DeployError):
                        dpl.load_baseline()
                finally:
                    p1.stop(), p2.stop()

    def test_bad_value_baseline_raises(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p1, p2 = self._patch_state(Path(td), content=json.dumps({"/a/b": "zzz"}))
            p1.start(), p2.start()
            try:
                with self.assertRaises(dpl.DeployError):
                    dpl.load_baseline()
            finally:
                p1.stop(), p2.stop()

    def test_checksums_save_refuses_different_existing_baseline(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            p1, p2 = self._patch_state(Path(td))
            p1.start(), p2.start()
            try:
                current = {dpl.MAIN_FILES[0]: "a" * 64, dpl.CONF_D + "/michaelli.site.conf": "b" * 64}
                existing = {dpl.MAIN_FILES[0]: "c" * 64, dpl.CONF_D + "/michaelli.site.conf": "b" * 64}
                with mock.patch.object(dpl, "remote_conf_d_files", return_value=current), \
                     mock.patch.object(dpl, "load_baseline", return_value=existing), \
                     mock.patch.object(dpl, "save_baseline") as save_mock:
                    with self.assertRaises(dpl.DeployError):
                        dpl.cmd_checksums(mock.Mock(action="save"))
                save_mock.assert_not_called()
            finally:
                p1.stop(), p2.stop()


class ProbeExpectationTests(unittest.TestCase):
    def test_probe_mismatch_raises_opaque(self):
        viewer, upload = "viewer-secret-v", "upload-secret-u"
        payload = (viewer + "\n" + upload + "\n").encode()
        out = b"PROBE_HTTP anon=401 view=200 upmeta=200 upbiz=403 viewmeta=403 viewpub=200 store_view=yes store_meta=yes"
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc=0, out=out)) as m:
            with self.assertRaises(dpl.DeployError):
                dpl.probe_loopback(viewer, upload)
        shell = m.call_args.args[0]
        stdin = m.call_args.kwargs.get("stdin")
        # 明文只进 stdin，绝不出现在远端命令 argv（shell）
        self.assertEqual(stdin, payload)
        self.assertNotIn(viewer, shell)
        self.assertNotIn(upload, shell)

    def test_probe_match_passes(self):
        out = b"PROBE_HTTP anon=401 view=200 upmeta=200 upbiz=403 viewmeta=403 viewpub=403 store_view=yes store_meta=yes"
        with mock.patch.object(dpl, "remote_exec", return_value=ExecResultStub(rc=0, out=out)):
            dpl.probe_loopback("v", "u")  # 不应抛异常


class HttpsRoleProbeTests(unittest.TestCase):
    def _probe(self, responses):
        calls = []

        def fake(path, auth):
            calls.append((path, auth))
            return responses.pop(0)

        return calls, fake

    def test_meta_first_and_foreign_published_stops_before_business(self):
        meta = {"published": True, "currentVersion": 3, "publicationId": "foreign",
                "publishedAt": "2026-01-01T00:00:00.000Z", "dataAsOf": None, "fingerprint": None}
        calls, fake = self._probe([(200, meta)])
        with mock.patch.object(dpl, "https_get_json", side_effect=fake):
            with self.assertRaises(dpl.DeployError):
                dpl.https_role_probe("v", "u")
        # 业务概览绝不在 meta 门禁通过前被读取
        self.assertEqual([c[0] for c in calls], ["/api/meta"])

    def test_meta_401_raises(self):
        calls, fake = self._probe([(401, {})])
        with mock.patch.object(dpl, "https_get_json", side_effect=fake):
            with self.assertRaises(dpl.DeployError):
                dpl.https_role_probe("v", "u")

    def test_string_version_rejected(self):
        meta = {"published": False, "currentVersion": "1", "publicationId": None}
        calls, fake = self._probe([(200, meta)])
        with mock.patch.object(dpl, "https_get_json", side_effect=fake):
            with self.assertRaises(dpl.DeployError) as cm:
                dpl.https_role_probe("v", "u")
        self.assertNotIn("1", str(cm.exception))  # 不打印任意 meta 内容

    def test_own_empty_already_published_then_role_checks(self):
        meta = {"published": True, "currentVersion": 1, "publicationId": dpl.SMOKE_ID,
                "publishedAt": "2026-01-01T00:00:00.000Z", "dataAsOf": None, "fingerprint": None}
        empty_view = {"metadata": {"currentVersion": 1}, "data": {"overview": None}}
        responses = [(200, meta), (401, {}), (200, empty_view), (403, {})]
        calls, fake = self._probe(responses)
        with mock.patch.object(dpl, "https_get_json", side_effect=fake):
            dpl.https_role_probe("v", "u")  # 不应抛异常
        self.assertEqual([c[0] for c in calls],
                         ["/api/meta", "/api/overview", "/api/overview", "/api/overview"])


class SmokeProtectionTests(unittest.TestCase):
    def _meta(self, published, version, pub_id, data_as_of=None, published_at=None):
        return {"published": published, "currentVersion": version, "publicationId": pub_id,
                "publishedAt": published_at, "dataAsOf": data_as_of, "fingerprint": None}

    def _overview(self, version, pub_id, total=0):
        return {"metadata": {"currentVersion": version, "publicationId": pub_id},
                "data": {"overview": {"metrics": {"totalProjects": total},
                                      "stages": [], "schemaVersion": 1}}}

    def _patch_https(self, calls, meta, overview=None):
        def fake_https_get_json(path, auth):
            calls.append(path)
            if path == "/api/meta":
                return 200, meta
            return 200, overview or self._overview(meta["currentVersion"], meta["publicationId"])

        return fake_https_get_json

    def test_already_published_unknown_id_stops_before_overview(self):
        meta = self._meta(True, 3, "not-ours", data_as_of="x", published_at="y")
        calls = []
        with mock.patch.object(dpl, "https_get_json",
                               side_effect=self._patch_https(calls, meta)):
            with self.assertRaises(dpl.DeployError):
                dpl.smoke("up", "vw")
        self.assertEqual(calls, ["/api/meta"])

    def test_already_published_exact_id_but_business_count_stops(self):
        meta = self._meta(True, 3, dpl.SMOKE_ID, data_as_of="x", published_at="y")
        calls = []
        overview = self._overview(3, dpl.SMOKE_ID, total=5)
        with mock.patch.object(dpl, "https_get_json",
                               side_effect=self._patch_https(calls, meta, overview)):
            with self.assertRaises(dpl.DeployError):
                dpl.smoke("up", "vw")

    def test_already_done_exact_id_zero_count_no_put(self):
        meta = self._meta(True, 3, dpl.SMOKE_ID, data_as_of="x", published_at="y")
        calls = []
        overview = self._overview(3, dpl.SMOKE_ID, total=0)
        with mock.patch.object(dpl, "https_get_json",
                               side_effect=self._patch_https(calls, meta, overview)) as get_mock:
            with mock.patch.object(dpl, "curl_request") as curl_mock:
                dpl.smoke("up", "vw")
        curl_mock.assert_not_called()
        self.assertEqual(get_mock.call_count, 2)

    def test_already_done_overview_metadata_mismatch_stops(self):
        meta = self._meta(True, 3, dpl.SMOKE_ID, data_as_of="x", published_at="y")
        overview = self._overview(4, dpl.SMOKE_ID, total=0)  # 查询版本 ≠ meta 版本
        calls = []
        with mock.patch.object(dpl, "https_get_json",
                               side_effect=self._patch_https(calls, meta, overview)):
            with self.assertRaises(dpl.DeployError):
                dpl.smoke("up", "vw")

    def test_unpublished_publishes_empty_with_cas_and_version_plus_one(self):
        meta_before = self._meta(False, 0, None)
        meta_after = self._meta(True, 1, dpl.SMOKE_ID, data_as_of="x", published_at="y")
        meta_calls = [meta_before, meta_after]

        def fake_https_get_json(path, auth):
            if path == "/api/meta":
                return 200, meta_calls.pop(0)
            return 200, self._overview(1, dpl.SMOKE_ID, total=0)

        seen = {}

        def fake_curl(url, port, method, auth, body):
            seen["body"] = json.loads(body.decode())
            return 200, b"{}"

        with mock.patch.object(dpl, "https_get_json", side_effect=fake_https_get_json):
            with mock.patch.object(dpl, "curl_request", side_effect=fake_curl):
                dpl.smoke("up", "vw")

        protocol = seen["body"]["protocol"]
        self.assertEqual(protocol["publicationId"], dpl.SMOKE_ID)
        self.assertEqual(protocol["expectedCurrentVersion"], 0)
        snap = seen["body"]["snapshot"]
        self.assertEqual(snap["projects"], [])
        self.assertEqual(snap["overview"]["metrics"]["totalProjects"], 0)

    def test_unpublished_publish_409_aborts_no_success(self):
        meta_before = self._meta(False, 0, None)
        calls = []
        with mock.patch.object(dpl, "https_get_json",
                               side_effect=self._patch_https(calls, meta_before)):
            with mock.patch.object(dpl, "curl_request", return_value=(409, b"")):
                with self.assertRaises(dpl.DeployError):
                    dpl.smoke("up", "vw")
        self.assertEqual(calls, ["/api/meta"])  # 冲突后绝不 GET 业务/后置 meta

    def test_unpublished_after_version_not_plus_one_stops(self):
        meta_before = self._meta(False, 0, None)
        meta_after = self._meta(True, 5, dpl.SMOKE_ID, data_as_of="x", published_at="y")
        meta_calls = [meta_before, meta_after]

        def fake_https_get_json(path, auth):
            if path == "/api/meta":
                return 200, meta_calls.pop(0)
            return 200, self._overview(5, dpl.SMOKE_ID, total=0)

        with mock.patch.object(dpl, "https_get_json", side_effect=fake_https_get_json):
            with mock.patch.object(dpl, "curl_request", return_value=(200, b"{}")):
                with self.assertRaises(dpl.DeployError):
                    dpl.smoke("up", "vw")

    def test_unpublished_meta_non_200_aborts(self):
        def fake_https_get_json(path, auth):
            return 401, {}

        with mock.patch.object(dpl, "https_get_json", side_effect=fake_https_get_json):
            with mock.patch.object(dpl, "curl_request") as curl_mock:
                with self.assertRaises(dpl.DeployError):
                    dpl.smoke("up", "vw")
        curl_mock.assert_not_called()

    def test_unpublished_generic_string_version_rejected(self):
        def fake_https_get_json(path, auth):
            return 200, {"published": False, "currentVersion": "1", "publicationId": None}

        with mock.patch.object(dpl, "https_get_json", side_effect=fake_https_get_json):
            with self.assertRaises(dpl.DeployError):
                dpl.smoke("up", "vw")


def _container_inspect_json(image=dpl.EXPECTED_IMAGE_ID, extra_ports=False, drop_mount=False,
                            wrong_field=None, foreign_source=False, extra_mount=False,
                            no_tmpfs=False):
    """真实 inspect 层级：顶层 data['Mounts']=自有 bind（可选额外/外来 bind 用于负例）；
    HostConfig.Tmpfs 独立存放 /tmp 选项；HostConfig.Binds=null（无 legacy bind）。"""
    own_bind = {"Type": "bind", "Source": dpl.REMOTE_DATA_DIR,
                "Destination": "/var/lib/mobile-readonly", "Mode": "", "RW": True,
                "Propagation": "rprivate"}
    if foreign_source:
        own_bind = dict(own_bind, Source="/opt/unexpected/elsewhere")
    mounts = [] if drop_mount else [own_bind]
    if extra_mount:
        mounts.append({"Type": "bind", "Source": "/opt/foreign/x",
                       "Destination": "/var/lib/unexpected", "Mode": "", "RW": True,
                       "Propagation": "rprivate"})
    data = {
        "Id": "ctrid",
        "Image": image,
        "Config": {"User": "1000:1000", "Env": ["SECRET_ENV=should-not-print"]},
        "State": {"Running": True},
        "HostConfig": {
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "SecurityOpt": ["no-new-privileges"],
            "Memory": 512 * 1024 * 1024,
            "NanoCpus": 500_000_000,
            "PidsLimit": 128,
            "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
            "LogConfig": {"Type": "json-file",
                          "Config": {"max-size": "10m", "max-file": "3"}},
            "PortBindings": {"8082/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8082"}]},
            "Binds": None,
            "Tmpfs": {} if no_tmpfs else {"/tmp": "rw,noexec,nosuid,size=16m"},
        },
        "Mounts": mounts,
    }
    if extra_ports:
        data["HostConfig"]["PortBindings"]["8443/tcp"] = [{"HostIp": "127.0.0.1", "HostPort": "8443"}]
    if wrong_field:
        keys = wrong_field.split(".")
        node = data
        for k in keys[:-1]:
            node = node[k]
        node[keys[-1]] = "wrong"
    return data


class ContainerSafetyTests(unittest.TestCase):
    def _inspect_remote(self, inspect_data):
        cmd = f"docker inspect {q(dpl.CONTAINER)} 2>/dev/null"
        return [(exact(cmd), ExecResultStub(rc=0, out=(json.dumps([inspect_data])).encode()))]

    def test_container_state_ok_strict_allowlist(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(self._inspect_remote(_container_inspect_json()))):
            self.assertTrue(dpl.container_state_ok())

    def test_container_state_ok_rejects_wrong_field(self):
        for field in ("Image", "Config.User", "HostConfig.Memory", "HostConfig.NanoCpus",
                      "HostConfig.PidsLimit", "HostConfig.ReadonlyRootfs",
                      "HostConfig.RestartPolicy.Name", "State.Running",
                      "HostConfig.LogConfig.Config.max-size", "HostConfig.Binds"):
            data = _container_inspect_json()
            keys = field.split(".")
            node = data
            for k in keys[:-1]:
                node = node[k]
            node[keys[-1]] = "wrong"
            with mock.patch.object(dpl, "remote_exec",
                                   side_effect=strict_fake(self._inspect_remote(data))):
                self.assertFalse(dpl.container_state_ok(), field)

    def test_container_state_ok_rejects_extra_ports(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(
                                   self._inspect_remote(_container_inspect_json(extra_ports=True)))):
            self.assertFalse(dpl.container_state_ok())

    def test_container_state_ok_rejects_missing_data_mount(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(
                                   self._inspect_remote(_container_inspect_json(drop_mount=True)))):
            self.assertFalse(dpl.container_state_ok())

    def test_container_state_ok_rejects_foreign_bind_source(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(
                                   self._inspect_remote(_container_inspect_json(foreign_source=True)))):
            self.assertFalse(dpl.container_state_ok())

    def test_container_state_ok_rejects_extra_bind(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(
                                   self._inspect_remote(_container_inspect_json(extra_mount=True)))):
            self.assertFalse(dpl.container_state_ok())

    def test_container_state_ok_rejects_missing_tmpfs_options(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake(
                                   self._inspect_remote(_container_inspect_json(no_tmpfs=True)))):
            self.assertFalse(dpl.container_state_ok())

    def test_existing_container_with_wrong_image_fails(self):
        ps_cmd = f"docker ps -a --format '{{{{.Names}}}}' | grep -qx {q(dpl.CONTAINER)}"
        handlers = [
            (exact(ps_cmd), ExecResultStub(rc=0, out=(dpl.CONTAINER + "\n").encode())),
        ] + self._inspect_remote(_container_inspect_json(image=dpl.EXPECTED_IMAGE_ID + "XX"))
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with mock.patch.object(dpl, "local_image_id", return_value=dpl.EXPECTED_IMAGE_ID):
                with self.assertRaises(dpl.DeployError):
                    dpl.run_container()

    def test_missing_container_passes_expected_flow(self):
        ps_cmd = f"docker ps -a --format '{{{{.Names}}}}' | grep -qx {q(dpl.CONTAINER)}"
        inspect_img = f"docker image inspect --format '{{{{.Id}}}}' {dpl.LOCAL_IMAGE} 2>/dev/null"
        run_cmd = shlex.join(dpl.CONTAINER_RUN)
        handlers = [
            (exact(ps_cmd), ExecResultStub(rc=1, out=b"")),
            (exact(inspect_img), ExecResultStub(rc=0, out=(dpl.EXPECTED_IMAGE_ID + "\n").encode())),
            (exact(run_cmd), ExecResultStub(rc=0, out=b"ctrid")),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)) as m:
            with mock.patch.object(dpl, "local_image_id", return_value=dpl.EXPECTED_IMAGE_ID):
                dpl.run_container()  # 不应抛异常
        # 精确断言：run 命令经 shlex.split 还原 == CONTAINER_RUN（杜绝重复/丢参）
        run_shell = [a for a in m.call_args_list if a.args and a.args[0] == run_cmd]
        self.assertTrue(run_shell)
        self.assertEqual(shlex.split(run_cmd), dpl.CONTAINER_RUN)
        self.assertEqual(run_cmd.split()[0], "docker")
        self.assertEqual(run_cmd.split()[1], "run")


class CredentialsMarkerTests(unittest.TestCase):
    def test_remote_existing_unknown_creds_without_reuse_refused(self):
        creds = {"viewer": {"username": "viewer", "digest": "scrypt$16384$8$1$64$AAAA$BBBB"},
                 "upload": {"digest": "scrypt$16384$8$1$64$CCCC$DDDD"}}
        handlers = base_existing_marker_handlers() + [
            (exact(f"test -f {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=0)),
            (exact(f"cat {q(dpl.REMOTE_CREDENTIALS)}"),
             ExecResultStub(rc=0, out=json.dumps(creds).encode())),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.cmd_credentials(mock.Mock(reuse=False))

    def test_keychain_entry_exists_without_reuse_refused(self):
        handlers = base_existing_marker_handlers() + creds_absent_handlers()
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with mock.patch.object(dpl, "keychain_exists", return_value=True):
                with self.assertRaises(dpl.DeployError):
                    dpl.cmd_credentials(mock.Mock(reuse=False))

    def test_bad_json_creds_raises_and_no_keychain_write(self):
        handlers = base_existing_marker_handlers() + [
            (exact(f"test -f {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=0)),
            (exact(f"cat {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=0, out=b"{bad json")),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with mock.patch.object(dpl, "keychain_exists", return_value=False) as kc, \
                 mock.patch.object(dpl, "ensure_keychain") as ek, \
                 mock.patch.object(dpl, "build_new_credentials") as bn, \
                 mock.patch.object(dpl, "write_credentials_remote") as wc:
                with self.assertRaises(dpl.DeployError):
                    dpl.cmd_credentials(mock.Mock(reuse=True))
        kc.assert_not_called()
        ek.assert_not_called()
        bn.assert_not_called()
        wc.assert_not_called()

    def test_unreadable_creds_raises_and_no_keychain_write(self):
        handlers = base_existing_marker_handlers() + [
            (exact(f"test -f {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=0)),
            (exact(f"cat {q(dpl.REMOTE_CREDENTIALS)}"), ExecResultStub(rc=1)),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with mock.patch.object(dpl, "keychain_exists", return_value=False) as kc, \
                 mock.patch.object(dpl, "ensure_keychain") as ek, \
                 mock.patch.object(dpl, "write_credentials_remote") as wc:
                with self.assertRaises(dpl.DeployError):
                    dpl.cmd_credentials(mock.Mock(reuse=True))
        kc.assert_not_called()
        ek.assert_not_called()
        wc.assert_not_called()

    def test_credentials_write_is_exclusive_no_mv_f_overwrite(self):
        # 新目录场景：base 不存在 → mkdir/chmod/marker 新建/凭证 exclusive 写入
        base = q(dpl.REMOTE_BASE)
        data = q(dpl.REMOTE_DATA_DIR)
        marker = q(dpl.MARKER_FILE)
        creds = q(dpl.REMOTE_CREDENTIALS)
        handlers = [
            (exact(f"test -L {base}"), ExecResultStub(rc=1)),
            (exact(f"test -L {data}"), ExecResultStub(rc=1)),
            (exact(f"test -e {base}"), ExecResultStub(rc=1)),
            (exact(f"test -e {data}"), ExecResultStub(rc=1)),
            (exact(f"mkdir -p {data} && chmod 700 {data} && chown 1000:1000 {data}"),
             ExecResultStub(rc=0)),
            (exact(f"mkdir -p {base} && chmod 700 {base} && chown 1000:1000 {base}"),
             ExecResultStub(rc=0)),
            (exact(f"test -L {marker}"), ExecResultStub(rc=1)),
            (starts("python3 -c "), ExecResultStub(rc=0)),
            (exact(f"test -L {creds}"), ExecResultStub(rc=1)),
            (exact(f"test -f {creds}"), ExecResultStub(rc=1)),
            (starts("python3 -c "), ExecResultStub(rc=0)),
            (exact(f"stat -c '%u %g %a' {creds}"), ExecResultStub(rc=0, out=b"1000 1000 600\n")),
        ]
        creds_dict = {"viewer": {"username": "viewer", "digest": "d"},
                      "upload": {"digest": "u"}}
        seen = []  # (shell, stdin)

        def recorder(shell, stdin=None, timeout=120):
            seen.append((shell, stdin))
            for matcher, result in handlers:
                if matcher(shell):
                    if isinstance(result, ExecResultStub):
                        return result
                    return result(shell, stdin)
            raise UnhandledShell(shell)

        with mock.patch.object(dpl, "remote_exec", side_effect=recorder):
            dpl.write_credentials_remote(creds_dict)
        python_calls = [(s, si) for s, si in seen if s.startswith("python3 -c ")]
        self.assertEqual(len(python_calls), 2)  # marker + credentials
        for shell, _stdin in python_calls:
            self.assertNotIn("mv -f", shell)
            self.assertNotIn("cat >", shell)
        # 精确解码内嵌 python 源码：先 shlex 还原远端引用、再 AST 取 b64 常量（非子串猜测）
        marker_shell, marker_stdin = python_calls[0]
        creds_shell, creds_stdin = python_calls[1]
        marker_code = python_source(marker_shell)
        creds_code = python_source(creds_shell)
        # data 托管标记与凭证摘要：固定内容 + exclusive 硬链接新建 + owner=(1000,1000)
        self.assertEqual(marker_code, dpl._REMOTE_WRITE_SNIPPET.format(
            target=dpl.MARKER_FILE, mode=0o600, exclusive=True, owner=dpl.CREDENTIAL_OWNER))
        self.assertEqual(marker_stdin, (dpl.MARKER_VALUE + "\n").encode("utf-8"))
        self.assertEqual(creds_code, dpl._REMOTE_WRITE_SNIPPET.format(
            target=dpl.REMOTE_CREDENTIALS, mode=0o600, exclusive=True, owner=dpl.CREDENTIAL_OWNER))
        self.assertEqual(creds_stdin,
                         (json.dumps(creds_dict, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        # 正文只在 stdin：argv（shell）不得含标记/摘要内容
        for shell, _si in python_calls:
            self.assertNotIn(dpl.MARKER_VALUE, shell)
            self.assertNotIn('"digest"', shell)
        # AST 确认写入走 mkstemp+os.link 独占新建，无 mv -f 覆盖语义
        for code in (marker_code, creds_code):
            calls = {n.func.attr for n in ast.walk(ast.parse(code))
                     if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
            self.assertIn("mkstemp", calls)
            self.assertIn("link", calls)
            self.assertNotIn("mv", calls)


class SymlinkSafetyTests(unittest.TestCase):
    def _symlink_cmd(self, path):
        return f"test -L {q(path)}"

    def test_dangling_symlink_detected_by_test_L_directly(self):
        # 即使文件不存在，test -L 也返回 0 → 必须拒绝（旧 test -e && test -L 会漏悬空链接）
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._symlink_cmd("/x")),
                                                         ExecResultStub(rc=0))])):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_no_symlink("/x")

    def test_regular_or_missing_path_allowed(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._symlink_cmd("/x")),
                                                         ExecResultStub(rc=1))])):
            dpl.remote_no_symlink("/x")  # 不应抛异常

    def test_test_L_query_error_rc2_denies(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._symlink_cmd("/x")),
                                                         ExecResultStub(rc=2))])):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_no_symlink("/x")

    def test_marker_content_must_match_exact(self):
        marker = q(dpl.MARKER_FILE)
        handlers = [
            (exact(f"test -L {marker}"), ExecResultStub(rc=1)),
            (exact(f"test -f {marker}"), ExecResultStub(rc=0)),
            (exact(f"cat {marker}"), ExecResultStub(rc=0, out=b"wrong-content\n")),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            self.assertFalse(dpl.marker_content_ok(dpl.MARKER_FILE, dpl.MARKER_VALUE))


class RemoteWriteSafetyTests(unittest.TestCase):
    def test_remote_write_bytes_payload_via_stdin_not_argv(self):
        seen = {}

        def fake(shell, stdin=None, timeout=120):
            seen["shell"] = shell
            seen["stdin"] = stdin
            return ExecResultStub(rc=0)

        payload = ("SECRET_PAYLOAD_XYZ\n" * 3).encode("utf-8")
        with mock.patch.object(dpl, "remote_exec", side_effect=fake):
            dpl.remote_write_bytes("/opt/target.json", payload, mode=0o600, exclusive=True)
        self.assertTrue(seen["shell"].startswith("python3 -c "))
        self.assertEqual(seen["stdin"], payload)
        self.assertNotIn(b"SECRET_PAYLOAD_XYZ", seen["shell"].encode("utf-8"))
        self.assertNotIn("mv -f", seen["shell"])

    def test_remote_write_bytes_uses_unique_tmp_and_fsync(self):
        seen = {}

        def fake(shell, stdin=None, timeout=120):
            seen["shell"] = shell
            seen["stdin"] = stdin
            return ExecResultStub(rc=0)

        with mock.patch.object(dpl, "remote_exec", side_effect=fake):
            dpl.remote_write_bytes("/opt/a.json", b"{}", mode=0o600, exclusive=True)
        # 先按真实远端 shell 引用还原 -c 源码，再与本部署固定片段逐字节比对（非子串猜测）
        code = python_source(seen["shell"])
        self.assertEqual(code, dpl._REMOTE_WRITE_SNIPPET.format(
            target="/opt/a.json", mode=0o600, exclusive=True, owner=None))
        # 正文只进 stdin，不进 argv
        self.assertEqual(seen["stdin"], b"{}")
        self.assertNotIn(b"{}", seen["shell"].encode("utf-8"))
        # AST 调用级确认：唯一临时文件 mkstemp + fsync + fchmod；绝不出现 mv
        calls = {n.func.attr for n in ast.walk(ast.parse(code))
                 if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
        self.assertIn("mkstemp", calls)
        self.assertIn("fsync", calls)
        self.assertIn("fchmod", calls)
        self.assertIn("link", calls)
        self.assertIn("replace", calls)
        self.assertNotIn("mv", calls)
        self.assertIn(".mr-deploy-", code)
        self.assertNotIn(".tmp'", code)


class PreflightImageTests(unittest.TestCase):
    def test_preflight_rejects_wrong_local_image_exact(self):
        with mock.patch.object(dpl, "local_image_id", return_value=dpl.EXPECTED_IMAGE_ID + "XX"):
            with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake([])) as remote:
                with self.assertRaises(dpl.DeployError):
                    dpl.cmd_preflight(None)
        # 本地镜像不匹配时不得发起任何远端命令
        remote.assert_not_called()


class AcmeHookGateTests(unittest.TestCase):
    def _parse_cmd(self):
        domain_conf = dpl.ACME_DOMAIN_DIR + "/" + dpl.NGINX_HOST + ".conf"
        code = dpl._ACME_PARSE_SNIPPET.replace("__DOMAIN__", repr(domain_conf)) \
                                      .replace("__GLOBAL__", repr(dpl.ACME_GLOBAL)) \
                                      .replace("__EXPECTED__", repr(dpl.ACME_RELOADCMD))
        b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
        return "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % b64)

    def _run(self, payload):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0, out=payload))])):
            dpl.acme_state_hook_safe()

    def _raise_rc(self, rc):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=rc))])):
            with self.assertRaises(dpl.DeployError):
                dpl.acme_state_hook_safe()

    def _own_reload(self, encoded=True):
        if encoded:
            raw = ("__ACME_BASE64__START_"
                   + base64.b64encode(dpl.ACME_RELOADCMD.encode("utf-8")).decode("ascii")
                   + "__ACME_BASE64__END_")
        else:
            raw = dpl.ACME_RELOADCMD
        return {"domain": {"present": True, "prepost": 0, "reload_present": True, "reload_own": True},
                "global": {"present": True, "prepost": 0, "reload_present": False, "reload_own": False}}

    def _clean(self, domain_present=True):
        return {"domain": {"present": domain_present, "prepost": 0,
                           "reload_present": False, "reload_own": False},
                "global": {"present": True, "prepost": 0, "reload_present": False, "reload_own": False}}

    def test_own_encoded_reload_accepted(self):
        payload = json.dumps(self._own_reload(encoded=True)).encode()
        self._run(payload)  # 不应抛异常

    def test_own_plain_reload_legacy_accepted(self):
        payload = json.dumps(self._own_reload(encoded=False)).encode()
        self._run(payload)  # 兼容明文旧式写法

    def test_domain_absent_clean_ok(self):
        self._run(json.dumps(self._clean(domain_present=False)).encode())

    def test_untrusted_encoded_reload_rejected_without_echo(self):
        data = self._own_reload(encoded=True)
        data["domain"]["reload_own"] = False
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0,
                                                                        out=json.dumps(data).encode()))])):
            with self.assertRaises(dpl.DeployError) as cm:
                dpl.acme_state_hook_safe()
        self.assertNotIn("reload", str(cm.exception).lower().replace("reload", ""))
        # 至少保证不回显 hook 值：错误文案不含 base64/命令片段
        self.assertNotIn("docker exec", str(cm.exception))

    def test_remote_parse_malformed_exit3_rejected(self):
        self._raise_rc(3)

    def test_remote_parse_unreadable_exit2_rejected(self):
        self._raise_rc(2)

    def test_global_nonempty_hook_stops(self):
        data = self._clean()
        data["global"] = {"present": True, "prepost": 1, "reload_present": False, "reload_own": False}
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0,
                                                                        out=json.dumps(data).encode()))])):
            with self.assertRaises(dpl.DeployError):
                dpl.acme_state_hook_safe()

    def test_global_reload_nonempty_stops(self):
        data = self._clean()
        data["global"] = {"present": True, "prepost": 0, "reload_present": True, "reload_own": True}
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0,
                                                                        out=json.dumps(data).encode()))])):
            with self.assertRaises(dpl.DeployError):
                dpl.acme_state_hook_safe()

    def test_global_missing_stops(self):
        data = self._clean()
        data["global"] = {"present": False}
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0,
                                                                        out=json.dumps(data).encode()))])):
            with self.assertRaises(dpl.DeployError):
                dpl.acme_state_hook_safe()

    def test_domain_prepost_hook_stops(self):
        data = self._clean()
        data["domain"] = {"present": True, "prepost": 2, "reload_present": False, "reload_own": False}
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(self._parse_cmd()),
                                                         ExecResultStub(rc=0,
                                                                        out=json.dumps(data).encode()))])):
            with self.assertRaises(dpl.DeployError):
                dpl.acme_state_hook_safe()


class AcmeParseSnippetLocalTests(unittest.TestCase):
    """真实执行 _ACME_PARSE_SNIPPET（本机 subprocess，不触远端）验证 base64/引号/计数解析。"""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.domain = os.path.join(self._dir.name, "domain.conf")
        self.global_c = os.path.join(self._dir.name, "account.conf")

    def tearDown(self):
        self._dir.cleanup()

    def _write(self, path, content):
        if content is None:
            if os.path.exists(path):
                os.unlink(path)
            return
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)

    def _run(self, domain=None, global_conf=None, preserve=False):
        if not preserve:
            self._write(self.domain, domain)
            self._write(self.global_c, global_conf)
        code = dpl._ACME_PARSE_SNIPPET.replace("__DOMAIN__", repr(self.domain)) \
                                      .replace("__GLOBAL__", repr(self.global_c)) \
                                      .replace("__EXPECTED__", repr(dpl.ACME_RELOADCMD))
        b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
        proc = subprocess.run([sys.executable, "-c",
                               "import base64;exec(base64.b64decode('%s'))" % b64],
                              capture_output=True, timeout=30)
        out = proc.stdout.decode("utf-8", "replace")
        return proc.returncode, out

    @staticmethod
    def _b64_wrap(text):
        return ("__ACME_BASE64__START_"
                + base64.b64encode(text.encode("utf-8")).decode("ascii")
                + "__ACME_BASE64__END_")

    def test_own_encoded_reload_accepted_by_snippet(self):
        domain = ("Le_ReloadCmd='" + self._b64_wrap(dpl.ACME_RELOADCMD) + "'\n")
        global_conf = "AUTO_UPGRADE='1'\n"
        rc, out = self._run(domain, global_conf)
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertTrue(data["domain"]["reload_own"])
        self.assertEqual(data["global"]["prepost"], 0)
        self.assertFalse(data["global"]["reload_present"])

    def test_untrusted_encoded_reload_not_own(self):
        domain = ("Le_ReloadCmd='" + self._b64_wrap("docker exec evil nginx -s reload") + "'\n")
        global_conf = None
        rc, out = self._run(domain, global_conf)
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertTrue(data["domain"]["reload_present"])
        self.assertFalse(data["domain"]["reload_own"])

    def test_malformed_b64_exits_3(self):
        domain = "Le_ReloadCmd='__ACME_BASE64__START_!!!not-b64!!!__ACME_BASE64__END_'\n"
        rc, _ = self._run(domain, "AUTO_UPGRADE='1'\n")
        self.assertEqual(rc, 3)

    def test_unknown_encoded_variable_ignored(self):
        domain = "Le_Preferred_Chain='__ACME_BASE64__START_QUJD__ACME_BASE64__END_'\n"
        global_conf = "AUTO_UPGRADE='1'\n"
        rc, out = self._run(domain, global_conf)
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertFalse(data["domain"]["reload_present"])
        self.assertEqual(data["domain"]["prepost"], 0)

    def test_empty_hooks_ok(self):
        domain = "Le_ReloadCmd=''\nLe_PreHook=''\n"
        global_conf = "AUTO_UPGRADE='1'\n"
        rc, out = self._run(domain, global_conf)
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertEqual(data["domain"]["prepost"], 0)
        self.assertFalse(data["domain"]["reload_present"])

    def test_global_prepost_counted(self):
        domain = None
        global_conf = "Le_PreHook='__ACME_BASE64__START_QUJD__ACME_BASE64__END_'\n"
        rc, out = self._run(domain, global_conf)
        self.assertEqual(rc, 0)
        data = json.loads(out)
        self.assertEqual(data["global"]["prepost"], 1)

    def test_unreadable_file_exits_2(self):
        domain = "Le_ReloadCmd=''\n"
        global_conf = "AUTO_UPGRADE='1'\n"
        self._write(self.domain, domain)
        self._write(self.global_c, global_conf)
        os.chmod(self.domain, 0o000)
        try:
            rc, _ = self._run(preserve=True)
            self.assertEqual(rc, 2)
        finally:
            os.chmod(self.domain, 0o600)


class SitePermissionTests(unittest.TestCase):
    def test_challenge_dirs_under_acme_not_site_root(self):
        seen = []
        all_handlers = []
        for p in (dpl.SITE_ROOT, dpl.SITE_ACME, dpl.SITE_SSL,
                  dpl.SITE_MARKER_FILE):
            all_handlers.append((exact(f"test -L {q(p)}"), ExecResultStub(rc=1)))
        for p in (dpl.SITE_ROOT, dpl.SITE_ACME,
                  dpl.SITE_ACME + "/.well-known",
                  dpl.SITE_ACME + "/.well-known/acme-challenge"):
            cmd = f"mkdir -p {q(p)} && chmod 0755 {q(p)} && chown root:root {q(p)}"
            all_handlers.append((exact(cmd), ExecResultStub(rc=0)))
        cmd_ssl = f"mkdir -p {q(dpl.SITE_SSL)} && chmod 0700 {q(dpl.SITE_SSL)} && chown root:root {q(dpl.SITE_SSL)}"
        all_handlers.append((exact(cmd_ssl), ExecResultStub(rc=0)))

        def recorder(shell, stdin=None, timeout=120):
            # 实际 callable recorder：记录每条命令并按注册结果返回；
            # 未命中一律 UnhandledShell（禁止把 ExecResultStub 当函数调用、也不静默 rc0 兜底）。
            seen.append(shell)
            for matcher, result in all_handlers:
                if matcher(shell):
                    if isinstance(result, ExecResultStub):
                        return result
                    return result(shell, stdin)
            raise UnhandledShell(shell)

        with mock.patch.object(dpl, "remote_exec", side_effect=recorder):
            dpl.ensure_site_permissions()
        joined = "\n".join(seen)
        acme_wk = dpl.SITE_ACME + "/.well-known"
        acme_ch = acme_wk + "/acme-challenge"
        # 逐命令 rc：test -L 守卫必须 rc1（非符号链接=安全），mkdir/chmod 必须 rc0；
        # 若把 test -L 也放行成 rc0 就等于模拟“是符号链接”而错误拒绝（当前 fixture 保证分离）。
        self.assertIn(f"test -L {q(dpl.SITE_ROOT)}", joined)
        # ACME challenge 祖先目录：位于 SITE_ACME/.well-known 下（非 SITE_ROOT/.well-known），mode 0755
        self.assertIn(f"mkdir -p {q(acme_wk)} && chmod 0755 {q(acme_wk)} && chown root:root {q(acme_wk)}",
                      joined)
        self.assertIn(f"mkdir -p {q(acme_ch)} && chmod 0755 {q(acme_ch)} && chown root:root {q(acme_ch)}",
                      joined)
        self.assertIn(q(acme_ch), joined)
        # SSL 目录仅供 root：mode 0700（区别于 challenge 目录 0755）
        self.assertIn(f"mkdir -p {q(dpl.SITE_SSL)} && chmod 0700 {q(dpl.SITE_SSL)} && chown root:root {q(dpl.SITE_SSL)}",
                      joined)
        # 绝不创建 SITE_ROOT/.well-known（整串校验，不会把 /acme/.../.well-known 误当根下路径）
        self.assertNotIn(q(dpl.SITE_ROOT + "/.well-known"), joined)
        # 不存在 `|| true` 吞错
        self.assertNotIn("|| true", joined)


class NginxApplyRollbackTests(unittest.TestCase):
    def test_nginx_t_timeout_no_rollback_claimed(self):
        had_prev_cmd = f"test -f {q(dpl.VHOST_PATH)}"
        cat_old = f"cat {q(dpl.VHOST_PATH)}"
        test_L = f"test -L {q(dpl.VHOST_PATH)}"
        nginx_t = f"docker exec {dpl.OPENRESTY_CONTAINER} nginx -t"
        seen = []

        def fake(shell, stdin=None, timeout=120):
            seen.append(shell)
            if shell == had_prev_cmd:
                return ExecResultStub(rc=0)
            if shell == test_L:
                return ExecResultStub(rc=1)
            if shell == cat_old:
                return ExecResultStub(rc=0, out=b"# old vhost\n")
            if shell.startswith("python3 -c "):  # remote_write（写新 vhost）
                return ExecResultStub(rc=0)
            if shell == nginx_t:
                return ExecResultStub(rc=0, out=b"", timed_out=True)
            raise UnhandledShell(shell)

        with mock.patch.object(dpl, "remote_exec", side_effect=fake):
            with self.assertRaises(dpl.DeployError) as cm:
                dpl.nginx_apply("server{}")
        self.assertIn("未自动回滚", str(cm.exception))

    def test_nginx_t_fail_rollback_result_checked(self):
        had_prev_cmd = f"test -f {q(dpl.VHOST_PATH)}"
        cat_old = f"cat {q(dpl.VHOST_PATH)}"
        test_L = f"test -L {q(dpl.VHOST_PATH)}"
        nginx_t = f"docker exec {dpl.OPENRESTY_CONTAINER} nginx -t"
        # 既有 vhost 是精确的本部署托管旧值：回滚必须重写这一份原字节
        old_vhost = (dpl.VHOST_HEADER + "\nserver { old_value; }\n").encode("utf-8")
        writes = []  # (shell, stdin)

        def fake_remote(shell, stdin=None, timeout=120):
            if shell == had_prev_cmd:
                return ExecResultStub(rc=0)
            if shell == cat_old:
                return ExecResultStub(rc=0, out=old_vhost)
            if shell == test_L:
                return ExecResultStub(rc=1)
            if shell.startswith("python3 -c "):
                writes.append((shell, stdin))
                if len(writes) == 1:
                    return ExecResultStub(rc=0)  # 写入新 vhost 成功
                return ExecResultStub(rc=1)      # 回滚写旧 vhost 失败 → 必须被确认
            if shell == nginx_t:
                return ExecResultStub(rc=1)
            raise UnhandledShell(shell)

        with mock.patch.object(dpl, "remote_exec", side_effect=fake_remote):
            with self.assertRaises(dpl.DeployError) as cm:
                dpl.nginx_apply("server{}")
        # 恰好两次安全写入：新 vhost 与回滚旧 vhost
        self.assertEqual(len(writes), 2)
        new_shell, new_stdin = writes[0]
        rb_shell, rb_stdin = writes[1]
        expected_code = dpl._REMOTE_WRITE_SNIPPET.format(
            target=dpl.VHOST_PATH, mode=0o600, exclusive=False, owner=None)
        # 新内容先写；回滚必须把被覆盖前的精确旧值原样写回（仅经 stdin，非任意假 cat）
        self.assertEqual(new_stdin, b"server{}")
        self.assertEqual(python_source(new_shell), expected_code)
        self.assertEqual(rb_stdin, old_vhost)
        self.assertEqual(python_source(rb_shell), expected_code)
        self.assertNotIn("已回滚", str(cm.exception))


class CredentialOwnerWriteTests(unittest.TestCase):
    """凭证文件写入必须带 owner=(1000,1000)（fchown 仅在指定时执行）；
    vhost/站点文件不传 owner（保持 ssh root 属主）；owner 值必须先本地校验。"""

    def _expected_cmd(self, target, mode, exclusive, owner):
        code = dpl._REMOTE_WRITE_SNIPPET.format(target=target, mode=mode,
                                                exclusive=exclusive, owner=owner)
        b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
        return "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % b64), code

    def test_credentials_owner_embedded_and_payload_only_stdin(self):
        seen = {}
        payload = b'{"viewer": {"username": "viewer"}}\n'

        def fake(shell, stdin=None, timeout=120):
            seen["shell"] = shell
            seen["stdin"] = stdin
            return ExecResultStub(rc=0)

        with mock.patch.object(dpl, "remote_exec", side_effect=fake):
            dpl.remote_write_bytes(dpl.REMOTE_CREDENTIALS, payload, mode=0o600,
                                   exclusive=True, owner=dpl.CREDENTIAL_OWNER)
        expected_cmd, code = self._expected_cmd(dpl.REMOTE_CREDENTIALS, 0o600, True,
                                                dpl.CREDENTIAL_OWNER)
        self.assertEqual(seen["shell"], expected_cmd)
        self.assertEqual(seen["stdin"], payload)
        self.assertIn("os.fchown(fd, owner[0], owner[1])", code)
        self.assertIn("owner = (1000, 1000)", code)
        self.assertNotIn(payload.decode(), seen["shell"])

    def test_no_owner_for_vhost_write(self):
        seen = {}

        def fake(shell, stdin=None, timeout=120):
            seen["shell"] = shell
            seen["stdin"] = stdin
            return ExecResultStub(rc=0)

        with mock.patch.object(dpl, "remote_exec", side_effect=fake):
            dpl.remote_write_bytes(dpl.VHOST_PATH, b"server{}\n", mode=0o600, exclusive=False)
        expected_cmd, code = self._expected_cmd(dpl.VHOST_PATH, 0o600, False, None)
        self.assertEqual(seen["shell"], expected_cmd)
        # 无 owner：fchown 分支保留但 owner 为 None（不全局/递归 chown）
        self.assertIn("owner = None", code)
        self.assertIn("if owner is not None:", code)
        self.assertNotIn("os.walk", code)
        self.assertNotIn("os.chown(", code)

    def test_invalid_owner_rejected_before_remote(self):
        with mock.patch.object(dpl, "remote_exec") as remote:
            for bad in ((1000,), (1000, -1), ("1000", 1000), (-1, 1000)):
                with self.assertRaises(dpl.DeployError):
                    dpl.remote_write_bytes("/opt/x", b"{}", owner=bad)
            remote.assert_not_called()


class RemoteFileStatusTests(unittest.TestCase):
    """remote_file_exists：rc0=True、rc1=False；rc255/超时=查询错误必须抛错，不得当作缺失。"""

    def test_rc0_true(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(f"test -f {q('/x')}"),
                                                         ExecResultStub(rc=0))])):
            self.assertTrue(dpl.remote_file_exists("/x"))

    def test_rc1_false(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(f"test -f {q('/x')}"),
                                                         ExecResultStub(rc=1))])):
            self.assertFalse(dpl.remote_file_exists("/x"))

    def test_rc255_raises(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(f"test -f {q('/x')}"),
                                                         ExecResultStub(rc=255))])):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_file_exists("/x")

    def test_timeout_raises(self):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(f"test -f {q('/x')}"),
                                                         ExecResultStub(rc=1, timed_out=True))])):
            with self.assertRaises(dpl.DeployError):
                dpl.remote_file_exists("/x")


class SymlinkErrorStatusTests(unittest.TestCase):
    """remote_no_symlink 仅 rc1 放行；rc0=链接拒绝；rc255/2/超时=查询错误拒绝。"""

    def _check(self, rc, timed_out=False, should_pass=False):
        with mock.patch.object(dpl, "remote_exec",
                               side_effect=strict_fake([(exact(f"test -L {q('/x')}"),
                                                         ExecResultStub(rc=rc, timed_out=timed_out))])):
            if should_pass:
                dpl.remote_no_symlink("/x")  # 不应抛异常
            else:
                with self.assertRaises(dpl.DeployError):
                    dpl.remote_no_symlink("/x")

    def test_only_rc1_allowed(self):
        self._check(1, should_pass=True)

    def test_rc255_rejected(self):
        self._check(255)

    def test_timeout_rejected(self):
        self._check(1, timed_out=True)


class KeychainStatusTests(unittest.TestCase):
    """keychain_exists：rc0=True、rc44=False（item not found）；其余(1/45/超时)=查询错误，
    不得虚构“不存在”而触发新增。"""

    def _patch_rc(self, rc, timed_out=False):
        return mock.patch.object(dpl, "local_exec",
                                 return_value=ExecResultStub(rc=rc, timed_out=timed_out))

    def test_rc0_true_rc44_false(self):
        with self._patch_rc(0):
            self.assertTrue(dpl.keychain_exists("s", "a"))
        with self._patch_rc(44):
            self.assertFalse(dpl.keychain_exists("s", "a"))

    def test_rc1_rc45_timeout_are_errors(self):
        for rc, timed in ((1, False), (45, False), (1, True)):
            with self._patch_rc(rc, timed):
                with self.assertRaises(dpl.DeployError):
                    dpl.keychain_exists("s", "a")


class RemoteCredentialProbeErrorTests(unittest.TestCase):
    """凭证路径查询 SSH 错误(rc255/超时)必须在任何 Keychain 操作前中止；
    不得把“查询失败”当作“远端无摘要”而生成/写入。"""

    def _run(self, creds_rc, creds_timed_out):
        handlers = base_existing_marker_handlers() + [
            (exact(f"test -f {q(dpl.REMOTE_CREDENTIALS)}"),
             ExecResultStub(rc=creds_rc, timed_out=creds_timed_out)),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with mock.patch.object(dpl, "keychain_exists") as kc, \
                 mock.patch.object(dpl, "ensure_keychain") as ek, \
                 mock.patch.object(dpl, "build_new_credentials") as bn, \
                 mock.patch.object(dpl, "write_credentials_remote") as wc:
                with self.assertRaises(dpl.DeployError):
                    dpl.cmd_credentials(mock.Mock(reuse=True))
        kc.assert_not_called()
        ek.assert_not_called()
        bn.assert_not_called()
        wc.assert_not_called()

    def test_creds_query_rc255_no_keychain_ops(self):
        self._run(255, False)

    def test_creds_query_timeout_no_keychain_ops(self):
        self._run(1, True)


class KeychainVerificationTests(unittest.TestCase):
    def test_reuse_matches_existing_digest_via_stored_salt(self):
        import base64 as b64
        import hashlib
        salt = b"0123456789abcdef"
        viewer_secret = "viewer-secret"
        h = hashlib.scrypt(viewer_secret.encode(), salt=salt, n=dpl.SCRYPT["N"],
                           r=dpl.SCRYPT["r"], p=dpl.SCRYPT["p"], dklen=dpl.SCRYPT["keyLen"])
        digest = "scrypt$%d$%d$%d$%d$%s$%s" % (
            dpl.SCRYPT["N"], dpl.SCRYPT["r"], dpl.SCRYPT["p"], dpl.SCRYPT["keyLen"],
            b64.b64encode(salt).decode(), b64.b64encode(h).decode())
        creds = {"viewer": {"username": "viewer", "digest": digest}, "upload": {"digest": digest}}
        self.assertTrue(dpl.creds_matches_secret(creds, viewer_secret, viewer_secret))
        self.assertFalse(dpl.creds_matches_secret(creds, "wrong-secret", viewer_secret))


class MarkerFileContentTests(unittest.TestCase):
    def test_site_marker_missing_or_wrong_not_managed(self):
        marker = q(dpl.SITE_MARKER_FILE)
        handlers = [
            (exact(f"test -L {marker}"), ExecResultStub(rc=1)),
            (exact(f"test -f {marker}"), ExecResultStub(rc=1)),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            self.assertFalse(dpl.site_managed())

    def test_cmd_tls_http_requires_managed_site_before_writing(self):
        # SITE_ROOT 已存在但无精确托管标记 → 拒绝，且不得执行任何 mkdir/write
        root_exists = f"test -e {q(dpl.SITE_ROOT)}"
        vhost_exists = f"test -e {q(dpl.VHOST_PATH)}"
        marker = q(dpl.SITE_MARKER_FILE)
        handlers = [
            (exact(vhost_exists), ExecResultStub(rc=1)),
            (exact(root_exists), ExecResultStub(rc=0)),
            (exact(f"test -L {marker}"), ExecResultStub(rc=1)),
            (exact(f"test -f {marker}"), ExecResultStub(rc=1)),
        ]
        with mock.patch.object(dpl, "remote_exec", side_effect=strict_fake(handlers)):
            with self.assertRaises(dpl.DeployError):
                dpl.cmd_tls_http(None)


if __name__ == "__main__":
    unittest.main()
