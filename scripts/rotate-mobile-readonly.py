#!/usr/bin/env python3
"""移动只读发布 · 凭证轮换编排（rotate-mobile-readonly）——独立、显式、可审计。

复用 `deploy-mobile-readonly.py` 的底层（bytes 语义 SSH/远端查询、`security -i` stdin
Keychain、scrypt 摘要生成、容器 allowlist）经 importlib 加载（注册 sys.modules，无 import 副作用）。

安全约定：
- 明文口令/token 只存在于内存、`security -i` stdin、curl 配置 stdin、系统 Keychain；
  绝不进入 argv/env/普通文件/stdout/stderr/traceback（含异常字符串与 Base64 Authorization）。
- 本地事务目录 0700/文件 0600；仅存摘要 JSON 精确字节（base64）、SHA256、快照/容器/nginx 哈希与引用。
- 远端唯一替换的既有文件是 `<data>/credentials.json`；只重启 `relocation-mobile-readonly`。
- 不动 current.json 内容、主站配置/vhost/证书、镜像、DNS、防火墙。
- 任何超时/失败：停止并保留恢复材料，绝不自动重试或自动回滚，绝不假报 complete。

CLI：rotate / status --transaction ID / resume --transaction ID / rollback --transaction ID。
无 --force、无任意 host/path、无明文 argv/env 输入。
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shlex
import stat
import sys
import tempfile
import time

# ---------------------------------------------------------------------------
# 复用 deploy
# ---------------------------------------------------------------------------

def _load_deploy():
    existing = sys.modules.get("mrdeploy")
    if existing is not None:
        return existing
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "deploy-mobile-readonly.py")
    spec = importlib.util.spec_from_file_location("mrdeploy", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 deploy-mobile-readonly.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mrdeploy"] = mod
    spec.loader.exec_module(mod)
    return mod


deploy = _load_deploy()

# ---------------------------------------------------------------------------
# 固定常量
# ---------------------------------------------------------------------------

DOMAIN = deploy.NGINX_HOST
REMOTE_IP = "8.162.13.22"
CONTAINER = deploy.CONTAINER
REMOTE_CREDENTIALS = deploy.REMOTE_CREDENTIALS
REMOTE_DATA_DIR = deploy.REMOTE_DATA_DIR
REMOTE_BASE = deploy.REMOTE_BASE
REMOTE_MARKER = deploy.MARKER_FILE
REMOTE_MARKER_VALUE = deploy.MARKER_VALUE
SNAPSHOT_PATH = REMOTE_DATA_DIR + "/snapshots/current.json"
VHOST_PATH = deploy.VHOST_PATH

ROTATE_DIR_REMOTE = "/opt/.relocation-mobile-readonly-rotate"
ROTATE_MARKER_REMOTE = ROTATE_DIR_REMOTE + "/.rotate-managed"
ROTATE_MARKER_VALUE = "relocation-mobile-readonly-rotate"
ROTATE_LOCK_REMOTE = ROTATE_DIR_REMOTE + "/lock"
ROTATE_ACTIVE_REMOTE = ROTATE_DIR_REMOTE + "/.active-txn"

STATE_ROOT = os.path.join(os.path.expanduser("~"), ".cache", "relocation-mobile-readonly", "rotations")
STATE_MARKER = os.path.join(STATE_ROOT, ".rotate-managed")
STATE_MARKER_VALUE = "relocation-mobile-readonly-rotate-local"
STATE_LOCK = os.path.join(STATE_ROOT, ".lock")

STAGE_PREFIX = "relocation-workbench:" + DOMAIN + ":rotation:"
STAGE_ACCOUNTS = {"viewer": "viewer", "upload": "publisher"}

FORMAL_VIEWER = (deploy.VIEWER_SERVICE, deploy.VIEWER_ACCOUNT)
FORMAL_UPLOAD = (deploy.UPLOAD_SERVICE, deploy.UPLOAD_ACCOUNT)

SCRYPT_EXACT = {"n": 16384, "r": 8, "p": 1, "klen": 64}
SALT_BYTES = 16
TXID_RE = re.compile(r"^[0-9a-f]{32}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{16,160}\Z")
MANAGED_DIR_MODE = 0o700
MANAGED_FILE_MODE = 0o600
TX_ROTATE_VERSION = 1
TARGET_OWNER = (1000, 1000)
TARGET_MODE = 0o600
DATA_OWNER = (1000, 1000)
DATA_MODE = 0o700

PHASES = {
    "preparing", "prepared", "applying", "applied", "verifying", "verified",
    "committing", "complete", "prepare_failed", "failed",
    "rolling_back", "rollback_applied", "rolled_back",
}
TERMINAL_PHASES = {"complete", "rolled_back"}
RESUMABLE_PHASES = {
    "prepared", "applying", "applied", "verifying", "verified",
    "committing", "failed", "rolling_back", "rollback_applied",
}
# 允许显式 resume 重启前必须完整校验的远端失败原因白名单（未知一律脱敏）
REASON_ENUM = {
    "LOCK_BUSY", "LOCK_MISSING", "LOCK_ATTR", "LOCK_OPEN_FAIL",
    "DIR_OPEN_FAIL", "DIR_TYPE", "DIR_OWNER", "DIR_MODE",
    "MARKER_MISSING", "MARKER_OPEN_FAIL", "MARKER_ATTR", "MARKER_VALUE",
    "ACTIVE_ATTR", "ACTIVE_OTHER",
    "READ_OPEN_FAIL", "READ_TYPE", "READ_NLINK",
    "TARGET_MISSING", "TARGET_SYMLINK", "TARGET_TYPE", "TARGET_NLINK",
    "TARGET_OWNER", "TARGET_MODE", "CAS_OLD_MISMATCH", "PAYLOAD_HASH",
    "REPLACE_RECHECK", "WRITE_FAIL", "READBACK_MISMATCH", "TARGET_IDENTITY_AFTER",
    "CID_UNKNOWN", "CID_MISMATCH", "INSPECT_UNKNOWN", "CONFIG_MISMATCH",
    "SNAPSHOT_MISSING", "SNAPSHOT_MISMATCH", "SNAPSHOT_ATTR",
    "RESTART_FAIL", "DATA_DIR_BAD", "DATA_MARKER_BAD", "RUNTIME_MISMATCH",
    "SAFE_PATH", "SAFE_ROOT", "SAFE_MISSING", "SAFE_OPEN", "SAFE_TYPE",
    "SAFE_NLINK", "SAFE_OWNER", "SAFE_MODE",
}

# 远端 safe_open 的受信根：生产为 "/"；测试可注入临时根（macOS /var 为符号链接）。
REMOTE_ROOT = "/"


class RotateError(RuntimeError):
    """固定、脱敏错误：绝不携带明文口令/token 或 Authorization。"""


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# 本地路径安全：受信 raw 锚点 + 逐段 dir_fd O_NOFOLLOW；仅本次新建可初始化 marker
# ---------------------------------------------------------------------------

def _raw_anchors():
    anchors = []
    for base in (os.path.expanduser("~"), tempfile.gettempdir()):
        base = os.path.abspath(base)
        if base != os.sep:
            anchors.append(base.rstrip(os.sep))
    return sorted(set(anchors), key=len, reverse=True)


def _find_raw_anchor(path: str):
    for anchor in _raw_anchors():
        if path == anchor or path.startswith(anchor + os.sep):
            return anchor
    return None


def _close_all(fds):
    for fd in reversed(fds):
        try:
            os.close(fd)
        except OSError:
            pass


def _secure_walk(path: str, *, expect_dir: bool, allow_missing: bool = False,
                 file_mode: int | None = None, exact_mode: bool = False,
                 allow_group_read: bool = False):
    """逐段打开校验：锚点以上的平台前缀按 canonical 路径打开（受信），锚点以下每段
    O_NOFOLLOW 且目录不得 group/world 可写；目标文件须普通、nlink=1、属主当前用户、
    mode 精确/无 group+other 位。符号链接（含悬空）与缺失（除非 allow_missing）一律拒绝。
    返回打开的最后一个 fd 与 fstat（调用者负责关闭）；缺失且被允许返回 (None, None)。
    """
    if not isinstance(path, str) or not os.path.isabs(path):
        raise RotateError("本地路径必须为绝对路径")
    anchor = _find_raw_anchor(path)
    if anchor is None:
        raise RotateError("本地路径不在受信根下；拒绝")
    real_anchor = os.path.realpath(anchor)
    rem = os.path.relpath(path, anchor)
    parts = [] if rem == "." else rem.split(os.sep)
    if any(p in ("", "..") for p in parts):
        raise RotateError("本地路径含非法段；拒绝")
    expected_real = real_anchor if not parts else os.path.join(real_anchor, *parts)
    # 锚点以下任何符号链接（含悬空）都使 realpath 偏离；直接拒绝
    if os.path.lexists(path) and os.path.realpath(path) != expected_real:
        raise RotateError("本地路径含符号链接/悬空链接；拒绝")
    fds = []
    retained = None
    try:
        fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
        fds.append(fd)
        for comp in [c for c in real_anchor.split(os.sep) if c]:
            nfd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fds.append(nfd)
            fd = nfd
        # now fd == anchor dir (canonical); anchor itself is trusted platform boundary
        if not parts:
            if expect_dir:
                st = os.fstat(fd)
                if st.st_uid != os.getuid():
                    raise RotateError("本地目录属主不符；拒绝")
                # allow_group_read：既有父目录可能是 deploy.save_baseline 默认 0755；
                # 只拒绝 group/other 可写，不强制 0700（仅新增事务目录严格 0700）。
                if stat.S_IMODE(st.st_mode) & (0o022 if allow_group_read else 0o077):
                    raise RotateError("本地目录权限过宽；拒绝")
                retained = fd
                return fd, st
            raise RotateError("本地目标应为文件；拒绝")
        for i, comp in enumerate(parts):
            last = i == len(parts) - 1
            if last and not expect_dir:
                try:
                    nfd = os.open(comp, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if allow_missing:
                        return None, None
                    raise RotateError("本地路径缺失；拒绝") from None
                except OSError:
                    raise RotateError("本地路径是符号链接/类型不符；拒绝") from None
                fds.append(nfd)
                st = os.fstat(nfd)
                if not stat.S_ISREG(st.st_mode):
                    raise RotateError("本地目标非普通文件；拒绝")
                if st.st_nlink != 1:
                    raise RotateError("本地目标存在多个 hardlink；拒绝")
                if st.st_uid != os.getuid():
                    raise RotateError("本地文件属主不符；拒绝")
                mode = stat.S_IMODE(st.st_mode)
                if exact_mode and mode != file_mode:
                    raise RotateError("本地文件权限不符；拒绝")
                if not allow_group_read and mode & 0o077:
                    raise RotateError("本地文件权限过宽；拒绝")
                retained = nfd
                return nfd, st
            try:
                nfd = os.open(comp, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if last and allow_missing:
                    return None, None
                raise RotateError("本地路径缺失；拒绝") from None
            except OSError:
                raise RotateError("本地路径是符号链接/类型不符；拒绝") from None
            fds.append(nfd)
            st = os.fstat(nfd)
            if last and expect_dir:
                if st.st_uid != os.getuid():
                    raise RotateError("本地目录属主不符；拒绝")
                if stat.S_IMODE(st.st_mode) & (0o022 if allow_group_read else 0o077):
                    raise RotateError("本地目录权限过宽；拒绝")
                retained = nfd
                return nfd, st
            elif not last:
                if stat.S_IMODE(st.st_mode) & 0o022:
                    raise RotateError("本地祖先目录 group/other 可写；拒绝")
            else:
                raise RotateError("本地目标应为文件但为目录；拒绝")
            fd = nfd
        raise RotateError("本地路径校验异常；拒绝")
    finally:
        for fd in reversed(fds):
            if fd == retained:
                continue
            try:
                os.close(fd)
            except OSError:
                pass


def _assert_local_safe(path: str, *, expect_dir: bool, allow_missing: bool = False,
                       file_mode: int | None = None, exact_mode: bool = False,
                       allow_group_read: bool = False) -> None:
    fd, _st = _secure_walk(path, expect_dir=expect_dir, allow_missing=allow_missing,
                           file_mode=file_mode, exact_mode=exact_mode,
                           allow_group_read=allow_group_read)
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def _ensure_state_root():
    """幂等创建受管本地事务根（0700）+ 精确 marker。已存在但缺 marker 一律拒绝，绝不接管。"""
    existed = os.path.lexists(STATE_ROOT)
    if not existed:
        parent = os.path.dirname(STATE_ROOT)
        if not os.path.isdir(parent):
            grand = os.path.dirname(parent)
            _assert_local_safe(grand, expect_dir=True, allow_group_read=True)
            os.mkdir(parent, MANAGED_DIR_MODE)
        # 既有父目录可能由 deploy.save_baseline 以默认 0755 创建：只校验属主与无 group/other 写，
        # 不强制 private，也绝不 chmod/chown 既有目录。
        _assert_local_safe(parent, expect_dir=True, allow_group_read=True)
        os.mkdir(STATE_ROOT, MANAGED_DIR_MODE)
    _assert_local_safe(STATE_ROOT, expect_dir=True)
    marker_exists = os.path.lexists(STATE_MARKER)
    if not marker_exists:
        if existed:
            raise RotateError("本地事务根已存在但无 marker；拒绝接管（人工核查）")
        fd = os.open(STATE_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     MANAGED_FILE_MODE)
        try:
            os.write(fd, (STATE_MARKER_VALUE + "\n").encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
    _assert_local_safe(STATE_MARKER, expect_dir=False, file_mode=MANAGED_FILE_MODE, exact_mode=True)
    with open(STATE_MARKER, "rb") as fh:
        if fh.read().decode("utf-8", "replace").strip() != STATE_MARKER_VALUE:
            raise RotateError("本地事务根 marker 内容不符；拒绝")


def _assert_txn_id(txn_id: str) -> str:
    if not isinstance(txn_id, str) or TXID_RE.match(txn_id) is None:
        raise RotateError("事务 ID 非法（应为 32 位小写 hex）")
    return txn_id


def _txn_dir(txn_id: str) -> str:
    _assert_txn_id(txn_id)
    return os.path.join(STATE_ROOT, txn_id)


@contextlib.contextmanager
def local_lock():
    """本地 flock：非阻塞；忙一律报错，绝不破锁。锁文件已存在须精确匹配，不静默重建身份。"""
    _ensure_state_root()
    created = False
    if not os.path.lexists(STATE_LOCK):
        fd = os.open(STATE_LOCK, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     MANAGED_FILE_MODE)
        created = True
    else:
        fd = os.open(STATE_LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        _assert_local_safe(STATE_LOCK, expect_dir=False, file_mode=MANAGED_FILE_MODE, exact_mode=True)
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1
                or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != MANAGED_FILE_MODE):
            raise RotateError("本地锁文件属性不符；拒绝")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RotateError("本地锁忙（另一个轮换进程持有）；不等待、不破锁") from None
        try:
            yield
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
    finally:
        os.close(fd)
        _ = created


# ---------------------------------------------------------------------------
# 事务 schema（严格；读取后任何使用前校验）
# ---------------------------------------------------------------------------

def _b64_strict(value, what: str) -> bytes:
    if not isinstance(value, str):
        raise RotateError("事务 %s 字段缺失/类型非法；拒绝" % what)
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise RotateError("事务 %s base64 非法；拒绝" % what) from None


def _hex64(value, what: str) -> str:
    if not isinstance(value, str) or _HEX64.match(value) is None:
        raise RotateError("事务 %s 摘要非法（非 64hex）；拒绝" % what)
    return value


def _stage_refs(txn_id: str) -> dict:
    return {
        "old_viewer": "%s%s:%s:%s" % (STAGE_PREFIX, txn_id, "old", "viewer"),
        "old_upload": "%s%s:%s:%s" % (STAGE_PREFIX, txn_id, "old", "upload"),
        "new_viewer": "%s%s:%s:%s" % (STAGE_PREFIX, txn_id, "new", "viewer"),
        "new_upload": "%s%s:%s:%s" % (STAGE_PREFIX, txn_id, "new", "upload"),
    }


def validate_txn(txn: dict):
    """完整 schema 校验；返回 (old_bytes, new_bytes)。任何缺失/漂移/绕 guard 一律拒绝。"""
    if not isinstance(txn, dict):
        raise RotateError("事务文件非法；拒绝")
    txn_id: str = _assert_txn_id(txn.get("transaction", ""))
    if txn.get("version") != TX_ROTATE_VERSION:
        raise RotateError("事务版本非法；拒绝")
    if txn.get("target") != REMOTE_CREDENTIALS:
        raise RotateError("事务 target 非固定远端凭证；拒绝")
    if txn.get("snapshot") != SNAPSHOT_PATH:
        raise RotateError("事务 snapshot 非固定路径；拒绝")
    if txn.get("container") != CONTAINER:
        raise RotateError("事务 container 非固定名称；拒绝")
    if txn.get("domain") != DOMAIN:
        raise RotateError("事务 domain 非法；拒绝")
    if txn.get("phase") not in PHASES:
        raise RotateError("事务阶段非法；拒绝")
    old_bytes = _b64_strict(txn.get("oldCredentialsB64"), "oldCredentialsB64")
    new_bytes = _b64_strict(txn.get("newCredentialsB64"), "newCredentialsB64")
    if sha256_hex(old_bytes) != _hex64(txn.get("oldHash"), "oldHash"):
        raise RotateError("事务 oldHash 与内容不符；拒绝")
    if sha256_hex(new_bytes) != _hex64(txn.get("newHash"), "newHash"):
        raise RotateError("事务 newHash 与内容不符；拒绝")
    validate_credentials_bytes(old_bytes)
    validate_credentials_bytes(new_bytes)
    if txn.get("staging") != _stage_refs(txn_id):
        raise RotateError("事务 staging 引用与 ID 重建不符；拒绝")
    cid = txn.get("containerId")
    if not isinstance(cid, str) or not cid:
        raise RotateError("事务 containerId 缺失；拒绝")
    _hex64(txn.get("containerConfigHash"), "containerConfigHash")
    _hex64(txn.get("snapshotHash"), "snapshotHash")
    _hex64(txn.get("nginxVhostHash"), "nginxVhostHash")
    baseline = txn.get("nginxBaseline")
    if not isinstance(baseline, dict) or not baseline:
        raise RotateError("事务 nginxBaseline 缺失；拒绝")
    for k, v in baseline.items():
        if not isinstance(k, str) or not isinstance(v, str) or _HEX64.match(v) is None:
            raise RotateError("事务 nginxBaseline 内容非法；拒绝")
    snap_owner = txn.get("snapshotOwner")
    if (not isinstance(snap_owner, (list, tuple)) or len(snap_owner) != 2
            or any(not isinstance(x, int) or isinstance(x, bool) or x < 0 for x in snap_owner)):
        raise RotateError("事务 snapshotOwner 缺失/非法；拒绝")
    if not isinstance(txn.get("snapshotMode"), int) or isinstance(txn.get("snapshotMode"), bool):
        raise RotateError("事务 snapshotMode 缺失/非法；拒绝")
    return old_bytes, new_bytes


def _read_txn(txn_id: str) -> dict:
    _assert_txn_id(txn_id)
    d = _txn_dir(txn_id)
    if not os.path.isdir(d):
        raise RotateError("事务不存在：%s" % txn_id)
    _assert_local_safe(d, expect_dir=True)
    path = os.path.join(d, "txn.json")
    fd, _st = _secure_walk(path, expect_dir=False, file_mode=MANAGED_FILE_MODE, exact_mode=True)
    assert fd is not None
    try:
        data = os.read(fd, 4 * 1024 * 1024)
    finally:
        os.close(fd)
    try:
        txn = json.loads(data.decode("utf-8"))
    except ValueError:
        raise RotateError("事务文件损坏/非法 JSON；拒绝") from None
    if not isinstance(txn, dict) or txn.get("transaction") != txn_id:
        raise RotateError("事务文件内容非法；拒绝")
    if txn.get("version") != TX_ROTATE_VERSION:
        raise RotateError("事务版本非法；拒绝")
    return txn


def _write_txn(txn: dict) -> None:
    txn_id = _assert_txn_id(txn["transaction"])
    d = _txn_dir(txn_id)
    _assert_local_safe(d, expect_dir=True)
    payload = dict(txn)
    payload["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    blob = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    _assert_local_safe(d, expect_dir=True)
    dfd, _ = _secure_walk(d, expect_dir=True)
    assert dfd is not None
    try:
        tmp = ".txn-%s.tmp" % secrets.token_hex(4)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     MANAGED_FILE_MODE, dir_fd=dfd)
        try:
            os.write(fd, blob)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, "txn.json", src_dir_fd=dfd, dst_dir_fd=dfd)
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _active_txns() -> list:
    if not os.path.isdir(STATE_ROOT):
        return []
    out = []
    for name in sorted(os.listdir(STATE_ROOT)):
        if TXID_RE.match(name) is None:
            continue
        try:
            txn = _read_txn(name)
        except RotateError:
            out.append(name)
            continue
        if txn.get("phase") not in TERMINAL_PHASES:
            out.append(name)
    return out


def _assert_no_active_txn() -> None:
    active = _active_txns()
    if active:
        raise RotateError("存在未完成事务（持久 active txn）；拒绝启动新事务，请先 resume/rollback："
                          + ",".join(active[:3]))


# ---------------------------------------------------------------------------
# 摘要 / 凭证（严格参数与精确 key）
# ---------------------------------------------------------------------------

def digest_shape_ok(digest: str) -> bool:
    if not isinstance(digest, str):
        return False
    parts = digest.split("$")
    if len(parts) != 7 or parts[0] != "scrypt":
        return False
    try:
        n, r, p, klen = int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4])
        salt = base64.b64decode(parts[5], validate=True)
        h = base64.b64decode(parts[6], validate=True)
    except (ValueError, TypeError):
        return False
    if (n, r, p, klen) != (SCRYPT_EXACT["n"], SCRYPT_EXACT["r"],
                           SCRYPT_EXACT["p"], SCRYPT_EXACT["klen"]):
        return False
    return len(salt) == SALT_BYTES and len(h) == klen


def secret_matches_digest(secret: str, digest: str) -> bool:
    if not digest_shape_ok(digest):
        return False
    parts = digest.split("$")
    salt = base64.b64decode(parts[5], validate=True)
    expected = base64.b64decode(parts[6], validate=True)
    candidate = hashlib.scrypt(secret.encode("utf-8"), salt=salt,
                               n=SCRYPT_EXACT["n"], r=SCRYPT_EXACT["r"],
                               p=SCRYPT_EXACT["p"], dklen=SCRYPT_EXACT["klen"])
    return candidate == expected


def _reject_duplicate_keys(pairs):
    """json object_pairs_hook：任何层级出现重复键一律拒绝（普通 json.loads 会静默取后值，
    可能用后到的合法 digest 掩盖前一个携带明文 password 的重复对象）。"""
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise _DuplicateKey()
        seen.add(key)
    return dict(pairs)


class _DuplicateKey(ValueError):
    pass


def _strict_json_object(raw: bytes, what: str):
    try:
        text = raw.decode("utf-8")  # 严格 UTF-8：非法字节一律拒绝
    except UnicodeDecodeError:
        raise RotateError("%s 含非法 UTF-8 字节；停止" % what) from None
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except _DuplicateKey:
        raise RotateError("%s 含重复键；拒绝（可能掩盖明文）" % what) from None
    except ValueError:
        raise RotateError("%s 不是合法 JSON；停止" % what) from None


def validate_credentials_bytes(raw: bytes) -> dict:
    data = _strict_json_object(raw, "远端凭证")
    if not isinstance(data, dict) or set(data.keys()) != {"viewer", "upload"}:
        raise RotateError("远端凭证顶层字段非法（必须恰为 viewer/upload）；停止")
    viewer = data.get("viewer")
    upload = data.get("upload")
    if not isinstance(viewer, dict) or set(viewer.keys()) != {"username", "digest"}:
        raise RotateError("远端凭证 viewer 字段非法；停止")
    if not isinstance(upload, dict) or set(upload.keys()) != {"digest"}:
        raise RotateError("远端凭证 upload 字段非法；停止")
    if viewer.get("username") != deploy.VIEWER_USERNAME:
        raise RotateError("远端凭证 viewer 用户名非法；停止")
    vd = viewer.get("digest")
    ud = upload.get("digest")
    if not isinstance(vd, str) or not isinstance(ud, str) \
            or not digest_shape_ok(vd) or not digest_shape_ok(ud):
        raise RotateError("远端凭证摘要参数非法（非精确 scrypt 16384/8/1/64）；停止")
    return data


def new_credentials_bytes(viewer_secret: str, upload_secret: str) -> bytes:
    creds = deploy.build_new_credentials(viewer_secret, upload_secret)
    return (json.dumps(creds, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _validate_secret(secret: str, what: str) -> str:
    if not isinstance(secret, str) or _SECRET_RE.match(secret) is None:
        raise RotateError("%s 含不允许字符（仅 URL-safe 可表示字符）；拒绝" % what)
    return secret


# ---------------------------------------------------------------------------
# Keychain
# ---------------------------------------------------------------------------

def stage_service(txn_id: str, which: str, role: str) -> str:
    if which not in ("old", "new") or role not in ("viewer", "upload"):
        raise RotateError("暂存引用非法")
    _assert_txn_id(txn_id)
    return "%s%s:%s:%s" % (STAGE_PREFIX, txn_id, which, role)


def keychain_add_exclusive(service: str, account: str, secret: str) -> None:
    _validate_secret(secret, "暂存明文")
    if deploy.keychain_exists(service, account):
        if deploy.keychain_get(service, account) == secret:
            return
        raise RotateError("暂存 Keychain 条目已存在且值不符；停止（不覆盖）")
    deploy.keychain_add(service, account, secret)
    if deploy.keychain_get(service, account) != secret:
        raise RotateError("暂存 Keychain 回读不一致；停止（不覆盖）")


def keychain_update_formal(service: str, account: str, secret: str, allowed: tuple) -> None:
    _validate_secret(secret, "正式明文")
    if not deploy.keychain_exists(service, account):
        raise RotateError("正式 Keychain 条目不存在；拒绝写入")
    current = deploy.keychain_get(service, account)
    if current not in allowed:
        raise RotateError("正式 Keychain 条目值非本事务 old/new；拒绝覆盖")
    if current == secret:
        return
    quoted = shlex.quote(secret)
    interactive = "add-generic-password -a %s -s %s -w %s -U\n" % (account, service, quoted)
    res = deploy.local_exec([deploy.SECURITY, "-i"], stdin=interactive.encode("utf-8"))
    if res.rc != 0:
        raise RotateError("正式 Keychain 更新失败（退出码 %d）；请人工检查后 resume" % res.rc)
    if deploy.keychain_get(service, account) != secret:
        raise RotateError("正式 Keychain 回读不一致；停止（不声称成功）")


def stage_secrets(txn: dict):
    refs = txn["staging"]
    try:
        return (
            deploy.keychain_get(refs["old_viewer"], STAGE_ACCOUNTS["viewer"]),
            deploy.keychain_get(refs["old_upload"], STAGE_ACCOUNTS["upload"]),
            deploy.keychain_get(refs["new_viewer"], STAGE_ACCOUNTS["viewer"]),
            deploy.keychain_get(refs["new_upload"], STAGE_ACCOUNTS["upload"]),
        )
    except deploy.DeployError:
        raise RotateError("暂存 Keychain 明文不可读；停止（恢复材料不完整，不可继续）") from None


def assert_staging_matches(txn: dict) -> tuple:
    """四个暂存条目必须逐项与 old/new 摘要匹配。"""
    old_bytes, new_bytes = validate_txn(txn)
    old_v, old_u, new_v, new_u = stage_secrets(txn)
    _validate_secret(old_v, "暂存 old viewer")
    _validate_secret(old_u, "暂存 old upload")
    _validate_secret(new_v, "暂存 new viewer")
    _validate_secret(new_u, "暂存 new upload")
    _verify_against_bytes(old_v, old_bytes, "viewer", "old")
    _verify_against_bytes(old_u, old_bytes, "upload", "old")
    _verify_against_bytes(new_v, new_bytes, "viewer", "new")
    _verify_against_bytes(new_u, new_bytes, "upload", "new")
    if len({old_v, old_u, new_v, new_u}) != 4:
        raise RotateError("新旧凭证存在重复（含 viewer/upload 交叉）；拒绝")
    return old_v, old_u, new_v, new_u


def formal_pair():
    v = deploy.keychain_get(*FORMAL_VIEWER) if deploy.keychain_exists(*FORMAL_VIEWER) else None
    u = deploy.keychain_get(*FORMAL_UPLOAD) if deploy.keychain_exists(*FORMAL_UPLOAD) else None
    return v, u


# ---------------------------------------------------------------------------
# 远端安全打开原语：从受信根逐段 dir_fd O_DIRECTORY/O_NOFOLLOW（祖先绝不 follow）
# ---------------------------------------------------------------------------

_REMOTE_SAFE = (
    "import os, stat\n"
    "class SafePathError(Exception):\n"
    "    def __init__(self, kind):\n"
    "        Exception.__init__(self, kind)\n"
    "        self.kind = kind\n"
    "\n"
    "def _safe_walk(ROOT, path, is_dir, missing_ok):\n"
    "    if not isinstance(path, str) or not path.startswith('/'):\n"
    "        raise SafePathError('PATH')\n"
    "    if path != ROOT and not path.startswith(ROOT.rstrip('/') + '/'):\n"
    "        raise SafePathError('PATH')\n"
    "    try:\n"
    "        fd = os.open(ROOT, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))\n"
    "    except OSError:\n"
    "        raise SafePathError('ROOT')\n"
    "    rel = os.path.relpath(path, ROOT)\n"
    "    parts = [] if rel == '.' else [p for p in rel.split('/') if p]\n"
    "    if any(p == '..' for p in parts):\n"
    "        os.close(fd); raise SafePathError('PATH')\n"
    "    for i, comp in enumerate(parts):\n"
    "        last = i == len(parts) - 1\n"
    "        want_dir = (not last) or is_dir\n"
    "        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)\n"
    "        if want_dir:\n"
    "            flags |= getattr(os, 'O_DIRECTORY', 0)\n"
    "        try:\n"
    "            nfd = os.open(comp, flags, dir_fd=fd)\n"
    "        except FileNotFoundError:\n"
    "            os.close(fd)\n"
    "            if missing_ok and last:\n"
    "                return None, None\n"
    "            raise SafePathError('MISSING')\n"
    "        except OSError:\n"
    "            os.close(fd)\n"
    "            raise SafePathError('OPEN')\n"
    "        os.close(fd); fd = nfd\n"
    "    st = os.fstat(fd)\n"
    "    if is_dir and not stat.S_ISDIR(st.st_mode):\n"
    "        os.close(fd); raise SafePathError('TYPE')\n"
    "    if not is_dir and not stat.S_ISREG(st.st_mode):\n"
    "        os.close(fd); raise SafePathError('TYPE')\n"
    "    return fd, st\n"
    "\n"
    "def safe_open(ROOT, path, *, is_dir, owner=None, mode=None, exact_mode=True, nlink1=True, missing_ok=False):\n"
    "    fd, st = _safe_walk(ROOT, path, is_dir, missing_ok)\n"
    "    if fd is None:\n"
    "        return None, None\n"
    "    if (not is_dir) and nlink1 and st.st_nlink != 1:\n"
    "        os.close(fd); raise SafePathError('NLINK')\n"
    "    if owner is not None:\n"
    "        if isinstance(owner, (tuple, list)):\n"
    "            ok = (st.st_uid, st.st_gid) == tuple(owner)\n"
    "        else:\n"
    "            ok = st.st_uid == owner\n"
    "        if not ok:\n"
    "            os.close(fd); raise SafePathError('OWNER')\n"
    "    if mode is not None:\n"
    "        uma = stat.S_IMODE(st.st_mode)\n"
    "        if (exact_mode and uma != mode) or ((not exact_mode) and (uma & 0o077)):\n"
    "            os.close(fd); raise SafePathError('MODE')\n"
    "    return fd, st\n"
)


def _owner_repr(owner):
    if owner is None:
        return "None"
    if isinstance(owner, (tuple, list)):
        return repr(tuple(owner))
    return repr(owner)


def render_remote_read(path: str, *, owner=None, mode=None, root: str = "/") -> str:
    """渲染只读读取片段（mode 一律十进制输出，与消费者 int(...,10) 一致）。"""
    return (_REMOTE_SAFE
            + "import base64, sys\n"
            "ROOT = __ROOT__\n"
            "PATH = __PATH__\n"
            "OWNER = __OWNER__\n"
            "MODE = __MODE__\n"
            "try:\n"
            "    fd, st = safe_open(ROOT, PATH, is_dir=False, owner=OWNER, mode=MODE, missing_ok=True)\n"
            "except SafePathError as e:\n"
            "    print('SAFE_' + e.kind); sys.exit(4)\n"
            "if fd is None:\n"
            "    print('MISSING'); sys.exit(3)\n"
            "data = bytearray()\n"
            "while True:\n"
            "    b = os.read(fd, 65536)\n"
            "    if not b:\n"
            "        break\n"
            "    data.extend(b)\n"
            "os.close(fd)\n"
            "print('%d %d %d %s' % (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode), base64.b64encode(bytes(data)).decode()))\n"
            ).replace("__ROOT__", repr(root)).replace("__PATH__", repr(path)) \
             .replace("__OWNER__", _owner_repr(owner)).replace("__MODE__", repr(mode))


def render_remote_stat(path: str, *, owner=None, mode=None, root: str = "/") -> str:
    """渲染流式 sha256 + 属性片段（绝不回传正文；mode 十进制输出）。"""
    return (_REMOTE_SAFE
            + "import hashlib, sys\n"
            "ROOT = __ROOT__\n"
            "PATH = __PATH__\n"
            "OWNER = __OWNER__\n"
            "MODE = __MODE__\n"
            "try:\n"
            "    fd, st = safe_open(ROOT, PATH, is_dir=False, owner=OWNER, mode=MODE, missing_ok=True)\n"
            "except SafePathError as e:\n"
            "    print('SAFE_' + e.kind); sys.exit(4)\n"
            "if fd is None:\n"
            "    print('MISSING'); sys.exit(3)\n"
            "h = hashlib.sha256()\n"
            "while True:\n"
            "    b = os.read(fd, 65536)\n"
            "    if not b:\n"
            "        break\n"
            "    h.update(b)\n"
            "os.close(fd)\n"
            "print('%s %d %d %d' % (h.hexdigest(), st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)))\n"
            ).replace("__ROOT__", repr(root)).replace("__PATH__", repr(path)) \
             .replace("__OWNER__", _owner_repr(owner)).replace("__MODE__", repr(mode))


def _remote_cmd(code: str) -> str:
    b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
    return "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % b64)


def remote_read_exact(path: str, *, owner=None, mode=None, root=None):
    """无 follow（含祖先）读取远端文件，返回 (bytes, uid, gid, mode) 或 None（仅确定缺失）。"""
    if root is None:
        root = REMOTE_ROOT
    res = deploy.remote_exec(_remote_cmd(render_remote_read(path, owner=owner, mode=mode, root=root)),
                             timeout=60)
    if res.rc == 3 and res.text().strip() == "MISSING":
        return None
    if res.timed_out or res.rc != 0:
        raise RotateError("远端文件读取失败（非缺失）；停止")
    parts = res.text().strip().split()
    if len(parts) == 3:
        parts.append("")  # 空文件 base64 为空串，split 后仅 3 段
    if len(parts) != 4:
        raise RotateError("远端文件属性输出异常；停止")
    try:
        uid, gid, mode = int(parts[0], 10), int(parts[1], 10), int(parts[2], 10)
        data = base64.b64decode(parts[3], validate=True)
    except (ValueError, TypeError):
        raise RotateError("远端文件属性解析异常；停止") from None
    return data, uid, gid, mode


def remote_stat_hash(path: str, *, owner=None, mode=None, root=None):
    """远端流式 sha256 + 属性；仅缺失返回 None；绝不回传文件正文。"""
    if root is None:
        root = REMOTE_ROOT
    res = deploy.remote_exec(_remote_cmd(render_remote_stat(path, owner=owner, mode=mode, root=root)),
                             timeout=60)
    if res.rc == 3 and res.text().strip() == "MISSING":
        return None
    if res.timed_out or res.rc != 0:
        raise RotateError("远端摘要计算失败（非缺失）；停止")
    parts = res.text().strip().split()
    if len(parts) != 4 or _HEX64.match(parts[0]) is None:
        raise RotateError("远端摘要输出异常；停止")
    try:
        uid, gid, mode = int(parts[1], 10), int(parts[2], 10), int(parts[3], 10)
    except (ValueError, TypeError):
        raise RotateError("远端属性解析异常；停止") from None
    return {"hash": parts[0], "uid": uid, "gid": gid, "mode": mode}


def remote_required_hash(path: str, what: str, *, owner=None, mode=None) -> str:
    info = remote_stat_hash(path, owner=owner, mode=mode)
    if info is None:
        raise RotateError("远端缺少%s；停止" % what)
    return info["hash"]


def read_remote_credentials():
    """返回 (raw, uid, gid, mode) 或 None（仅确定缺失）；先做路径/属性门禁（1000:1000 精确 0600）。"""
    return remote_read_exact(REMOTE_CREDENTIALS, owner=TARGET_OWNER, mode=TARGET_MODE)


def read_remote_active(*, uid: int = 0):
    data = remote_read_exact(ROTATE_ACTIVE_REMOTE, owner=uid, mode=0o600)
    if data is None:
        return None
    raw, _uid, _gid, _mode = data
    value = raw.decode("utf-8", "replace").strip()
    if value == "":
        # 文件存在但空/全空白：非法（不得静默视为 absent）
        raise RotateError("远端 active 标记为空/空白；停止（人工核查）")
    if TXID_RE.match(value) is None:
        raise RotateError("远端 active 标记内容非法；停止")
    return value


# 首次 rotate 前只读探测：父目录安全 + opdir 精确 ENOENT=未初始化；绝不创建目录。
_REMOTE_PROBE = (
    "import sys\n"
    + _REMOTE_SAFE +
    "ROOT = __ROOT__\n"
    "PARENT = __PARENT__\n"
    "DIR = __DIR__\n"
    "MARKER = __MARKER__\n"
    "VALUE = __VALUE__\n"
    "ACTIVE = __ACTIVE__\n"
    "UID = __UID__\n"
    "\n"
    "def fail():\n"
    "    print('PROBE_BAD'); sys.exit(1)\n"
    "\n"
    "def done(marker):\n"
    "    print(marker); sys.exit(0)\n"
    "\n"
    "def read_all(fd):\n"
    "    data = bytearray()\n"
    "    while True:\n"
    "        b = os.read(fd, 65536)\n"
    "        if not b:\n"
    "            break\n"
    "        data.extend(b)\n"
    "    os.close(fd)\n"
    "    return bytes(data)\n"
    "\n"
    "try:\n"
    "    pfd, pst = safe_open(ROOT, PARENT, is_dir=True, owner=UID, mode=None)\n"
    "except SafePathError:\n"
    "    fail()\n"
    "if stat.S_IMODE(pst.st_mode) & 0o022:\n"
    "    os.close(pfd); fail()\n"
    "os.close(pfd)\n"
    "try:\n"
    "    dfd, _dst = safe_open(ROOT, DIR, is_dir=True, owner=UID, mode=0o700, missing_ok=True)\n"
    "except SafePathError:\n"
    "    fail()\n"
    "if dfd is None:\n"
    "    done('PROBE_UNINITIALIZED')\n"
    "os.close(dfd)\n"
    "try:\n"
    "    mfd, _mst = safe_open(ROOT, MARKER, is_dir=False, owner=UID, mode=0o600)\n"
    "except SafePathError:\n"
    "    fail()\n"
    "if read_all(mfd).decode('utf-8', 'replace').strip() != VALUE:\n"
    "    fail()\n"
    "try:\n"
    "    afd, _ast = safe_open(ROOT, ACTIVE, is_dir=False, owner=UID, mode=0o600, missing_ok=True)\n"
    "except SafePathError:\n"
    "    fail()\n"
    "if afd is None:\n"
    "    done('PROBE_ABSENT')\n"
    "value = read_all(afd).decode('utf-8', 'replace').strip()\n"
    "if value == '' or len(value) != 32 or any(c not in '0123456789abcdef' for c in value):\n"
    "    fail()\n"
    "print(value)\n"
)


def render_remote_probe(*, directory=ROTATE_DIR_REMOTE, marker=ROTATE_MARKER_REMOTE,
                        value=ROTATE_MARKER_VALUE, active=ROTATE_ACTIVE_REMOTE,
                        parent=os.path.dirname(ROTATE_DIR_REMOTE),
                        uid=0, root=None) -> str:
    if root is None:
        root = REMOTE_ROOT
    return (_REMOTE_PROBE
            .replace("__ROOT__", repr(root))
            .replace("__PARENT__", repr(parent))
            .replace("__DIR__", repr(directory))
            .replace("__MARKER__", repr(marker))
            .replace("__VALUE__", repr(value))
            .replace("__ACTIVE__", repr(active))
            .replace("__UID__", repr(uid)))


def read_remote_active_initialized(*, root=None, parent=None):
    """只读探测远端 opdir：父目录安全 + opdir 精确 ENOENT=未初始化（无 active）；已存在则
    严格校验 type/root 0700/marker 后读 active；symlink/权限/未知一律拒绝，绝不先创建。"""
    if root is None:
        root = REMOTE_ROOT
    if parent is None:
        parent = os.path.dirname(ROTATE_DIR_REMOTE)
    res = deploy.remote_exec(_remote_cmd(render_remote_probe(root=root, parent=parent)), timeout=60)
    if res.timed_out or res.rc != 0:
        raise RotateError("远端轮换目录探测失败（路径/权限/内容非法）；停止")
    text = res.text().strip()
    if text in ("PROBE_UNINITIALIZED", "PROBE_ABSENT"):
        return None
    if TXID_RE.match(text) is None:
        raise RotateError("远端 active 探测输出异常；停止")
    return text


# ---------------------------------------------------------------------------
# 容器与 nginx 基线
# ---------------------------------------------------------------------------

def container_identity():
    data = deploy._inspect_container_json()
    if data is None:
        raise RotateError("无法读取容器 inspect；停止")
    pick = {k: data.get(k) for k in ("Image", "Config", "HostConfig", "Mounts")}
    canon = json.dumps(pick, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return data.get("Id"), sha256_hex(canon.encode("utf-8"))


def container_runtime_state() -> str:
    data = deploy._inspect_container_json()
    if data is None:
        return "unknown"
    status = data.get("State", {}).get("Status") if isinstance(data.get("State"), dict) else None
    if status not in ("running", "exited", "paused", "dead", "restarting"):
        return "unknown"
    return status


def verify_approved_nginx_baseline() -> dict:
    # 本地基线文件本身先做 no-symlink/普通文件门禁（组/其他可读允许，但不允许跟随链接）
    if os.path.lexists(deploy.STATE_FILE):
        _assert_local_safe(deploy.STATE_FILE, expect_dir=False, allow_group_read=True)
    baseline = deploy.load_baseline()
    if baseline is None:
        raise RotateError("缺少已批准 nginx 基线；拒绝（绝不重建）")
    current = deploy.remote_conf_d_files()
    if current != baseline:
        raise RotateError("nginx 主配置与已批准基线漂移；停止（不重建）")
    return baseline


def capture_baseline(txn_id: str) -> dict:
    baseline = verify_approved_nginx_baseline()
    vhost = remote_required_hash(VHOST_PATH, "自有 vhost")
    vhost_info = remote_stat_hash(VHOST_PATH)
    if vhost_info is None:
        raise RotateError("自有 vhost 必须存在；停止")
    snap = remote_stat_hash(SNAPSHOT_PATH)
    if snap is None:
        raise RotateError("缺少快照；停止")
    if not deploy.container_state_ok():
        raise RotateError("容器现状不满足安全 allowlist；停止")
    cid, chash = container_identity()
    if not cid:
        raise RotateError("容器 ID 缺失；停止")
    return {
        "nginxBaseline": baseline,
        "nginxVhostHash": vhost,
        "snapshotHash": snap["hash"],
        "snapshotOwner": [snap["uid"], snap["gid"]],
        "snapshotMode": snap["mode"],
        "containerId": cid,
        "containerConfigHash": chash,
    }


def reconfirm_identity(txn: dict) -> None:
    """身份/config/snapshot/nginx 基线（不要求容器 running）；快照按已记录属性精确门禁。"""
    cid, chash = container_identity()
    if cid != txn.get("containerId") or chash != txn.get("containerConfigHash"):
        raise RotateError("容器身份/配置在轮换前后变化；停止（保留恢复材料）")
    snap_owner = txn.get("snapshotOwner")
    snap_mode = txn.get("snapshotMode")
    snap = remote_stat_hash(
        SNAPSHOT_PATH,
        owner=tuple(snap_owner) if isinstance(snap_owner, (list, tuple)) else None,
        mode=snap_mode if isinstance(snap_mode, int) and not isinstance(snap_mode, bool) else None)
    if snap is None:
        raise RotateError("快照缺失；停止")
    if (snap["hash"] != txn.get("snapshotHash")
            or [snap["uid"], snap["gid"]] != txn.get("snapshotOwner")
            or snap["mode"] != txn.get("snapshotMode")):
        raise RotateError("快照在轮换前后变化；停止（保留恢复材料）")
    verify_approved_nginx_baseline()
    vhost = remote_required_hash(VHOST_PATH, "自有 vhost")
    if vhost != txn.get("nginxVhostHash"):
        raise RotateError("自有 vhost 在轮换前后变化；停止（保留恢复材料）")


def reconfirm_baseline(txn: dict) -> None:
    if not deploy.container_state_ok():
        raise RotateError("容器不满足安全 allowlist；停止（保留恢复材料）")
    reconfirm_identity(txn)



# ---------------------------------------------------------------------------
# 远端受管目录（仅本次 O_EXCL 新建可初始化 marker；已存在无 marker 一律停止）
# ---------------------------------------------------------------------------

_REMOTE_PREPARE = (
    "import os, stat, sys\n"
    "DIR = __DIR__\n"
    "MARKER = __MARKER__\n"
    "VALUE = __VALUE__\n"
    "LOCK = __LOCK__\n"
    "PARENT = __PARENT__\n"
    "UID = __UID__\n"
    "\n"
    "def fail(reason):\n"
    "    sys.stderr.write(reason)\n"
    "    sys.exit(1)\n"
    "\n"
    "try:\n"
    "    pst = os.lstat(PARENT)\n"
    "except OSError:\n"
    "    fail('PARENT_BAD')\n"
    "if stat.S_ISLNK(pst.st_mode) or not stat.S_ISDIR(pst.st_mode) or pst.st_uid != UID or (stat.S_IMODE(pst.st_mode) & 0o022):\n"
    "    fail('PARENT_ATTR')\n"
    "fresh = False\n"
    "try:\n"
    "    os.mkdir(DIR, 0o700)\n"
    "    fresh = True\n"
    "except FileExistsError:\n"
    "    fresh = False\n"
    "except OSError:\n"
    "    fail('DIR_CREATE_FAIL')\n"
    "try:\n"
    "    st = os.lstat(DIR)\n"
    "except OSError:\n"
    "    fail('DIR_BAD')\n"
    "if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != UID or (stat.S_IMODE(st.st_mode) & 0o077):\n"
    "    fail('DIR_ATTR_BAD')\n"
    "marker_exists = os.path.lexists(MARKER)\n"
    "if not marker_exists:\n"
    "    if not fresh:\n"
    "        fail('MARKER_MISSING')\n"
    "    fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)\n"
    "    try:\n"
    "        os.write(fd, (VALUE + '\\n').encode('utf-8'))\n"
    "        os.fsync(fd)\n"
    "    finally:\n"
    "        os.close(fd)\n"
    "    dfd = os.open(DIR, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))\n"
    "    os.fsync(dfd)\n"
    "    os.close(dfd)\n"
    "try:\n"
    "    mst = os.lstat(MARKER)\n"
    "except OSError:\n"
    "    fail('MARKER_BAD')\n"
    "if stat.S_ISLNK(mst.st_mode) or not stat.S_ISREG(mst.st_mode) or mst.st_nlink != 1 or mst.st_uid != UID or stat.S_IMODE(mst.st_mode) != 0o600:\n"
    "    fail('MARKER_ATTR')\n"
    "with open(MARKER, 'rb') as fh:\n"
    "    if fh.read().decode('utf-8', 'replace').strip() != VALUE:\n"
    "        fail('MARKER_VALUE')\n"
    "if not os.path.lexists(LOCK):\n"
    "    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)\n"
    "    os.close(fd)\n"
    "try:\n"
    "    lst = os.lstat(LOCK)\n"
    "except OSError:\n"
    "    fail('LOCK_MISSING')\n"
    "if stat.S_ISLNK(lst.st_mode) or not stat.S_ISREG(lst.st_mode) or lst.st_nlink != 1 or lst.st_uid != UID or stat.S_IMODE(lst.st_mode) != 0o600:\n"
    "    fail('LOCK_ATTR')\n"
    "print('PREPARE_OK')\n"
)


def render_remote_prepare(*, directory=ROTATE_DIR_REMOTE, marker=ROTATE_MARKER_REMOTE,
                          value=ROTATE_MARKER_VALUE, lock=ROTATE_LOCK_REMOTE,
                          parent=os.path.dirname(ROTATE_DIR_REMOTE), uid=0) -> str:
    return (_REMOTE_PREPARE
            .replace("__DIR__", repr(directory))
            .replace("__MARKER__", repr(marker))
            .replace("__VALUE__", repr(value))
            .replace("__LOCK__", repr(lock))
            .replace("__PARENT__", repr(parent))
            .replace("__UID__", repr(uid)))


def remote_prepare_dir() -> None:
    res = deploy.remote_exec(_remote_cmd(render_remote_prepare()), timeout=60)
    if res.timed_out or res.rc != 0 or "PREPARE_OK" not in res.text():
        raise RotateError("远端轮换目录准备失败；停止（不输出细节）")


# ---------------------------------------------------------------------------
# 远端受管写入 helper（同锁内：身份/config/snapshot/基线/marker -> CAS -> 写 -> 重启）
# ---------------------------------------------------------------------------

_REMOTE_APPLY = (
    "import fcntl, hashlib, json, subprocess, sys\n"
    + _REMOTE_SAFE +
    "TARGET = __TARGET__\n"
    "TARGET_OWNER = __TARGET_OWNER__\n"
    "TARGET_MODE = __TARGET_MODE__\n"
    "TARGET_PARENT = __TARGET_PARENT__\n"
    "DIR = __DIR__\n"
    "MARKER = __MARKER__\n"
    "VALUE = __VALUE__\n"
    "LOCK = __LOCK__\n"
    "ACTIVE = __ACTIVE__\n"
    "MODE = __MODE__\n"
    "TXN_ID = __TXN_ID__\n"
    "EXPECTED_OLD = __EXPECTED_OLD__\n"
    "EXPECTED_NEW = __EXPECTED_NEW__\n"
    "DATA_BASE = __DATA_BASE__\n"
    "DATA_MARKER = __DATA_MARKER__\n"
    "DATA_MARKER_VALUE = __DATA_MARKER_VALUE__\n"
    "DATA_OWNER = __DATA_OWNER__\n"
    "DATA_MODE = __DATA_MODE__\n"
    "SNAPSHOT = __SNAPSHOT__\n"
    "EXPECTED_SNAPSHOT_HASH = __EXPECTED_SNAPSHOT_HASH__\n"
    "SNAPSHOT_OWNER = __SNAPSHOT_OWNER__\n"
    "SNAPSHOT_MODE = __SNAPSHOT_MODE__\n"
    "CID_CMD = __CID_CMD__\n"
    "INSPECT_CMD = __INSPECT_CMD__\n"
    "EXPECTED_CID = __EXPECTED_CID__\n"
    "EXPECTED_CONFIG_HASH = __EXPECTED_CONFIG_HASH__\n"
    "RESTART = __RESTART__\n"
    "OWNER = __OWNER__\n"
    "RESTART_GATE = __RESTART_GATE__\n"
    "EXPECTED_RUNTIME = __EXPECTED_RUNTIME__\n"
    "ROOT = __ROOT__\n"
    "UID = __UID__\n"
    "\n"
    "def sha(b):\n"
    "    return hashlib.sha256(b).hexdigest()\n"
    "\n"
    "def canon(obj):\n"
    "    return sha(json.dumps(obj, sort_keys=True, separators=(',', ':')).encode('utf-8'))\n"
    "\n"
    "def out(payload):\n"
    "    print(json.dumps(payload))\n"
    "    sys.exit(0 if payload.get('ok') else 1)\n"
    "\n"
    "def fail(reason, **extra):\n"
    "    payload = {'ok': False, 'reason': reason}\n"
    "    payload.update(extra)\n"
    "    out(payload)\n"
    "\n"
    "def so(path, is_dir, owner, mode, missing_ok=False):\n"
    "    return safe_open(ROOT, path, is_dir=is_dir, owner=owner, mode=mode,\n"
    "                     exact_mode=True, nlink1=True, missing_ok=missing_ok)\n"
    "\n"
    "def hash_nofollow(path, owner, mode, missing_ok=False):\n"
    "    fd, st = so(path, False, owner, mode, missing_ok=missing_ok)\n"
    "    if fd is None:\n"
    "        return None, None\n"
    "    h = hashlib.sha256()\n"
    "    while True:\n"
    "        b = os.read(fd, 65536)\n"
    "        if not b:\n"
    "            break\n"
    "        h.update(b)\n"
    "    os.close(fd)\n"
    "    return h.hexdigest(), st\n"
    "\n"
    "def read_nofollow(path, owner, mode, missing_ok=False):\n"
    "    fd, st = so(path, False, owner, mode, missing_ok=missing_ok)\n"
    "    if fd is None:\n"
    "        return None, None\n"
    "    data = bytearray()\n"
    "    while True:\n"
    "        b = os.read(fd, 65536)\n"
    "        if not b:\n"
    "            break\n"
    "        data.extend(b)\n"
    "    os.close(fd)\n"
    "    return bytes(data), st\n"
    "\n"
    "def verify_op_dir():\n"
    "    try:\n"
    "        fd, _st = so(DIR, True, UID, 0o700)\n"
    "    except SafePathError as e:\n"
    "        if e.kind in ('MISSING', 'OPEN', 'PATH', 'ROOT'):\n"
    "            fail('DIR_OPEN_FAIL')\n"
    "        if e.kind in ('TYPE', 'NLINK'):\n"
    "            fail('DIR_TYPE')\n"
    "        if e.kind == 'OWNER':\n"
    "            fail('DIR_OWNER')\n"
    "        fail('DIR_MODE')\n"
    "    os.close(fd)\n"
    "\n"
    "def verify_data_dir(path):\n"
    "    try:\n"
    "        fd, _st = so(path, True, DATA_OWNER, DATA_MODE)\n"
    "    except SafePathError:\n"
    "        fail('DATA_DIR_BAD')\n"
    "    os.close(fd)\n"
    "\n"
    "def verify_shallow_dir(path):\n"
    "    # 服务自建目录（如 snapshots，store.ts mkdirSync 递归通常 0755）：只要求属主正确、\n"
    "    # 无 group/other 写；不强制 0700，绝不 chmod/chown，也不关闭检查。\n"
    "    try:\n"
    "        fd, st = so(path, True, DATA_OWNER, None)\n"
    "    except SafePathError:\n"
    "        fail('DATA_DIR_BAD')\n"
    "    if stat.S_IMODE(st.st_mode) & 0o022:\n"
    "        os.close(fd); fail('DATA_DIR_BAD')\n"
    "    os.close(fd)\n"
    "\n"
    "def verify_marker(path, value, owner):\n"
    "    try:\n"
    "        data, st = read_nofollow(path, owner, 0o600)\n"
    "    except SafePathError as e:\n"
    "        fail('MARKER_MISSING' if e.kind == 'MISSING' else 'MARKER_ATTR')\n"
    "    if data is None:\n"
    "        fail('MARKER_MISSING')\n"
    "    if data.decode('utf-8', 'replace').strip() != value:\n"
    "        fail('MARKER_VALUE')\n"
    "\n"
    "def verify_business_base():\n"
    "    verify_data_dir(DATA_BASE)\n"
    "    verify_data_dir(TARGET_PARENT)\n"
    "    verify_shallow_dir(os.path.dirname(SNAPSHOT))\n"
    "    verify_marker(DATA_MARKER, DATA_MARKER_VALUE, DATA_OWNER)\n"
    "\n"
    "def runtime_state():\n"
    "    try:\n"
    "        proc = subprocess.run(INSPECT_CMD, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)\n"
    "    except Exception:\n"
    "        return 'unknown', None\n"
    "    if proc.returncode != 0:\n"
    "        return 'unknown', None\n"
    "    try:\n"
    "        data = json.loads(proc.stdout.decode('utf-8', 'replace'))\n"
    "    except Exception:\n"
    "        return 'unknown', None\n"
    "    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):\n"
    "        return 'unknown', None\n"
    "    return str(data[0].get('State', {}).get('Status', 'unknown')), data[0]\n"
    "\n"
    "def verify_container():\n"
    "    if not EXPECTED_CID:\n"
    "        fail('CID_MISMATCH')\n"
    "    try:\n"
    "        proc = subprocess.run(CID_CMD, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)\n"
    "    except Exception:\n"
    "        fail('CID_UNKNOWN')\n"
    "    if proc.returncode != 0 or proc.stdout.decode('utf-8', 'replace').strip() != EXPECTED_CID:\n"
    "        fail('CID_MISMATCH')\n"
    "    state, data = runtime_state()\n"
    "    if data is None:\n"
    "        fail('INSPECT_UNKNOWN')\n"
    "    pick = {k: data.get(k) for k in ('Image', 'Config', 'HostConfig', 'Mounts')}\n"
    "    if canon(pick) != EXPECTED_CONFIG_HASH:\n"
    "        fail('CONFIG_MISMATCH')\n"
    "    return state\n"
    "\n"
    "def verify_snapshot():\n"
    "    try:\n"
    "        h, st = hash_nofollow(SNAPSHOT, tuple(SNAPSHOT_OWNER), SNAPSHOT_MODE)\n"
    "    except SafePathError as e:\n"
    "        fail('SNAPSHOT_MISSING' if e.kind == 'MISSING' else 'SNAPSHOT_ATTR')\n"
    "    if h is None:\n"
    "        fail('SNAPSHOT_MISSING')\n"
    "    if h != EXPECTED_SNAPSHOT_HASH:\n"
    "        fail('SNAPSHOT_MISMATCH')\n"
    "\n"
    "def verify_target_identity():\n"
    "    try:\n"
    "        h, st = hash_nofollow(TARGET, tuple(TARGET_OWNER), TARGET_MODE)\n"
    "    except SafePathError as e:\n"
    "        if e.kind == 'MISSING':\n"
    "            fail('TARGET_MISSING')\n"
    "        if e.kind in ('OPEN', 'PATH', 'ROOT'):\n"
    "            fail('TARGET_SYMLINK')\n"
    "        if e.kind in ('TYPE', 'NLINK'):\n"
    "            fail('TARGET_NLINK' if e.kind == 'NLINK' else 'TARGET_TYPE')\n"
    "        if e.kind == 'OWNER':\n"
    "            fail('TARGET_OWNER')\n"
    "        fail('TARGET_MODE')\n"
    "    if h is None:\n"
    "        fail('TARGET_MISSING')\n"
    "    return h, st\n"
    "\n"
    "def acquire_lock():\n"
    "    try:\n"
    "        fd, st = so(LOCK, False, UID, 0o600)\n"
    "    except SafePathError as e:\n"
    "        if e.kind == 'MISSING':\n"
    "            fail('LOCK_MISSING')\n"
    "        if e.kind in ('OPEN', 'PATH', 'ROOT'):\n"
    "            fail('LOCK_OPEN_FAIL')\n"
    "        fail('LOCK_ATTR')\n"
    "    if fd is None:\n"
    "        fail('LOCK_MISSING')\n"
    "    try:\n"
    "        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
    "    except OSError:\n"
    "        os.close(fd); fail('LOCK_BUSY')\n"
    "    return fd\n"
    "\n"
    "def read_active():\n"
    "    try:\n"
    "        raw, ast_ = read_nofollow(ACTIVE, UID, 0o600, missing_ok=True)\n"
    "    except SafePathError:\n"
    "        fail('ACTIVE_ATTR')\n"
    "    if raw is None:\n"
    "        return None\n"
    "    value = raw.decode('utf-8', 'replace').strip()\n"
    "    if value == '':\n"
    "        fail('ACTIVE_ATTR')  # 存在但空/全空白：非法，不得视为 absent\n"
    "    return value\n"
    "\n"
    "verify_op_dir()\n"
    "verify_marker(MARKER, VALUE, UID)\n"
    "lock_fd = acquire_lock()\n"
    "try:\n"
    "    verify_business_base()\n"
    "    active = read_active()\n"
    "    if MODE == 'clear':\n"
    "        if active == TXN_ID:\n"
    "            os.unlink(ACTIVE)\n"
    "            dfd = os.open(DIR, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))\n"
    "            os.fsync(dfd)\n"
    "            os.close(dfd)\n"
    "            out({'ok': True, 'cleared': 'deleted'})\n"
    "        if active is None:\n"
    "            out({'ok': True, 'cleared': 'absent'})\n"
    "        fail('ACTIVE_OTHER')\n"
    "    if active is not None and active != TXN_ID:\n"
    "        fail('ACTIVE_OTHER')\n"
    "    verify_snapshot()\n"
    "    state = verify_container()\n"
    "    if EXPECTED_RUNTIME != 'any' and state != EXPECTED_RUNTIME:\n"
    "        fail('RUNTIME_MISMATCH')\n"
    "    if MODE == 'observe':\n"
    "        cur_hash, _st = verify_target_identity()\n"
    "        out({'ok': True, 'runtime': state, 'targetHash': cur_hash, 'active': active})\n"
    "    cur_hash, st = verify_target_identity()\n"
    "    if cur_hash != EXPECTED_OLD:\n"
    "        fail('CAS_OLD_MISMATCH')\n"
    "    inode = st.st_ino\n"
    "    if active is None:\n"
    "        fd = os.open(ACTIVE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)\n"
    "        os.write(fd, (TXN_ID + '\\n').encode('utf-8'))\n"
    "        os.fsync(fd)\n"
    "        os.close(fd)\n"
    "        dfd = os.open(DIR, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))\n"
    "        os.fsync(dfd)\n"
    "        os.close(dfd)\n"
    "    changed = False\n"
    "    new_hash = cur_hash\n"
    "    restarted = False\n"
    "    if MODE == 'apply':\n"
    "        payload = sys.stdin.buffer.read()\n"
    "        if sha(payload) != EXPECTED_NEW:\n"
    "            fail('PAYLOAD_HASH')\n"
    "        dirfd = os.open(TARGET_PARENT, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))\n"
    "        tmp_name = '.mr-rotate-%d.tmp' % os.getpid()\n"
    "        try:\n"
    "            fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600, dir_fd=dirfd)\n"
    "            try:\n"
    "                mv = memoryview(payload)\n"
    "                w = 0\n"
    "                while w < len(mv):\n"
    "                    w += os.write(fd, mv[w:])\n"
    "                os.fchmod(fd, TARGET_MODE)\n"
    "                if OWNER is not None:\n"
    "                    os.fchown(fd, OWNER[0], OWNER[1])\n"
    "                os.fsync(fd)\n"
    "            finally:\n"
    "                os.close(fd)\n"
    "            pre_hash, pst = hash_nofollow(TARGET, tuple(TARGET_OWNER), TARGET_MODE)\n"
    "            if pre_hash is None or pst.st_ino != inode or pre_hash != EXPECTED_OLD:\n"
    "                fail('REPLACE_RECHECK')\n"
    "            os.replace(tmp_name, os.path.basename(TARGET), src_dir_fd=dirfd, dst_dir_fd=dirfd)\n"
    "            os.fsync(dirfd)\n"
    "        except SystemExit:\n"
    "            raise\n"
    "        except OSError:\n"
    "            try:\n"
    "                os.unlink(tmp_name, dir_fd=dirfd)\n"
    "            except OSError:\n"
    "                pass\n"
    "            fail('WRITE_FAIL')\n"
    "        finally:\n"
    "            os.close(dirfd)\n"
    "        back_hash, bst = hash_nofollow(TARGET, tuple(TARGET_OWNER), TARGET_MODE)\n"
    "        if back_hash is None or back_hash != EXPECTED_NEW:\n"
    "            fail('READBACK_MISMATCH')\n"
    "        changed = True\n"
    "        new_hash = back_hash\n"
    "        gate_ok = True\n"
    "    else:\n"
    "        gate_ok = False\n"
    "        if RESTART_GATE == 'stale':\n"
    "            gate_ok = (state == 'running')\n"
    "        elif RESTART_GATE == 'exited':\n"
    "            gate_ok = (state == 'exited')\n"
    "    if MODE == 'apply' or gate_ok:\n"
    "        r = subprocess.run(RESTART, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)\n"
    "        if r.returncode != 0:\n"
    "            fail('RESTART_FAIL', changed=changed, new=new_hash)\n"
    "        restarted = True\n"
    "    out({'ok': True, 'changed': changed, 'old': cur_hash, 'new': new_hash,\n"
    "         'restarted': restarted, 'runtime': state})\n"
    "finally:\n"
    "    try:\n"
    "        os.close(lock_fd)\n"
    "    except OSError:\n"
    "        pass\n"
)


def render_remote_apply(*, mode, txn_id, expected_old, expected_new, container,
                        expected_cid, expected_config_hash, restart, owner, target_owner,
                        target=REMOTE_CREDENTIALS, target_parent=REMOTE_DATA_DIR,
                        target_mode=TARGET_MODE,
                        directory=ROTATE_DIR_REMOTE, marker=ROTATE_MARKER_REMOTE,
                        value=ROTATE_MARKER_VALUE, lock=ROTATE_LOCK_REMOTE,
                        active=ROTATE_ACTIVE_REMOTE,
                        data_base=REMOTE_BASE, data_marker=REMOTE_MARKER,
                        data_marker_value=REMOTE_MARKER_VALUE,
                        data_owner=DATA_OWNER, data_mode=DATA_MODE,
                        snapshot=SNAPSHOT_PATH, expected_snapshot_hash="",
                        snapshot_owner=(0, 0), snapshot_mode=0o600,
                        cid_cmd=None, inspect_cmd=None, restart_gate="apply", uid=0,
                        expected_runtime="running", root=None) -> str:
    if cid_cmd is None:
        cid_cmd = ["docker", "inspect", "--format", "{{.Id}}", container]
    if inspect_cmd is None:
        inspect_cmd = ["docker", "inspect", container]
    if root is None:
        root = REMOTE_ROOT
    return (_REMOTE_APPLY
            .replace("__TARGET__", repr(target))
            .replace("__TARGET_OWNER__", repr(tuple(target_owner) if target_owner is not None else None))
            .replace("__TARGET_MODE__", repr(target_mode))
            .replace("__TARGET_PARENT__", repr(target_parent))
            .replace("__DIR__", repr(directory))
            .replace("__MARKER__", repr(marker))
            .replace("__VALUE__", repr(value))
            .replace("__LOCK__", repr(lock))
            .replace("__ACTIVE__", repr(active))
            .replace("__MODE__", repr(mode))
            .replace("__TXN_ID__", repr(txn_id))
            .replace("__EXPECTED_OLD__", repr(expected_old))
            .replace("__EXPECTED_NEW__", repr(expected_new))
            .replace("__DATA_BASE__", repr(data_base))
            .replace("__DATA_MARKER__", repr(data_marker))
            .replace("__DATA_MARKER_VALUE__", repr(data_marker_value))
            .replace("__DATA_OWNER__", repr(tuple(data_owner)))
            .replace("__DATA_MODE__", repr(data_mode))
            .replace("__SNAPSHOT__", repr(snapshot))
            .replace("__EXPECTED_SNAPSHOT_HASH__", repr(expected_snapshot_hash))
            .replace("__SNAPSHOT_OWNER__", repr(tuple(snapshot_owner)))
            .replace("__SNAPSHOT_MODE__", repr(snapshot_mode))
            .replace("__CID_CMD__", repr(list(cid_cmd)))
            .replace("__INSPECT_CMD__", repr(list(inspect_cmd)))
            .replace("__EXPECTED_CID__", repr(expected_cid))
            .replace("__EXPECTED_CONFIG_HASH__", repr(expected_config_hash))
            .replace("__RESTART__", repr(list(restart)))
            .replace("__OWNER__", repr(tuple(owner) if owner is not None else None))
            .replace("__RESTART_GATE__", repr(restart_gate))
            .replace("__EXPECTED_RUNTIME__", repr(expected_runtime))
            .replace("__ROOT__", repr(root))
            .replace("__UID__", repr(uid)))


def run_remote_apply(*, mode, txn_id, expected_old, expected_new, payload, container,
                     expected_cid, expected_config_hash, restart, owner, target_owner,
                     snapshot_hash, snapshot_owner, snapshot_mode, restart_gate,
                     timeout=180, target=REMOTE_CREDENTIALS, target_parent=REMOTE_DATA_DIR,
                     target_mode=TARGET_MODE,
                     data_base=REMOTE_BASE, data_marker=REMOTE_MARKER,
                     data_marker_value=REMOTE_MARKER_VALUE, data_owner=DATA_OWNER, data_mode=DATA_MODE,
                     snapshot=SNAPSHOT_PATH,
                     directory=ROTATE_DIR_REMOTE, marker=ROTATE_MARKER_REMOTE,
                     value=ROTATE_MARKER_VALUE, lock=ROTATE_LOCK_REMOTE,
                     active=ROTATE_ACTIVE_REMOTE, uid=0,
                     cid_cmd=None, inspect_cmd=None, expected_runtime="running",
                     root=None) -> dict:
    code = render_remote_apply(mode=mode, txn_id=txn_id, expected_old=expected_old,
                               expected_new=expected_new, container=container,
                               expected_cid=expected_cid, expected_config_hash=expected_config_hash,
                               restart=restart, owner=owner, target_owner=target_owner,
                               target=target, target_parent=target_parent, target_mode=target_mode,
                               directory=directory, marker=marker, value=value, lock=lock,
                               active=active, data_base=data_base, data_marker=data_marker,
                               data_marker_value=data_marker_value, data_owner=data_owner,
                               data_mode=data_mode, snapshot=snapshot,
                               expected_snapshot_hash=snapshot_hash,
                               snapshot_owner=snapshot_owner, snapshot_mode=snapshot_mode,
                               cid_cmd=cid_cmd, inspect_cmd=inspect_cmd,
                               restart_gate=restart_gate, uid=uid,
                               expected_runtime=expected_runtime, root=root)
    res = deploy.remote_exec(_remote_cmd(code), stdin=payload, timeout=timeout)
    if res.timed_out:
        raise RotateError("远端操作超时：状态不确定；保留恢复材料，请人工核查（不自动重试/回滚）")
    data = {}
    text = res.text().strip()
    if text:
        try:
            candidate = json.loads(text.splitlines()[-1])
            if isinstance(candidate, dict):
                data = candidate
        except (ValueError, IndexError):
            data = {}
    if res.rc == 0 and data.get("ok") is True:
        return data
    raw_reason = data.get("reason")
    reason = raw_reason if isinstance(raw_reason, str) and raw_reason in REASON_ENUM else "UNKNOWN"
    raise RotateError("远端操作未成功（%s）；保留恢复材料，不自动回滚" % reason)


def remote_clear_active(txn_id: str, *, container, expected_cid, expected_config_hash,
                        snapshot_hash, snapshot_owner, snapshot_mode, uid=0) -> dict:
    return run_remote_apply(mode="clear", txn_id=txn_id, expected_old="", expected_new="",
                            payload=b"", container=container, expected_cid=expected_cid,
                            expected_config_hash=expected_config_hash, restart=[],
                            owner=None, target_owner=TARGET_OWNER, snapshot_hash=snapshot_hash,
                            snapshot_owner=snapshot_owner, snapshot_mode=snapshot_mode,
                            restart_gate="none", timeout=60, uid=uid,
                            expected_runtime="any")


def remote_observe(txn: dict, *, timeout: int = 60) -> dict:
    """只读观察：打开既有受管锁（非阻塞），完整路径/身份/hash/snapshot 校验后返回有限状态；
    绝不创建 active/目录/文件，绝不重启。用于恢复分类与正式提交前门禁。"""
    return run_remote_apply(
        mode="observe", txn_id=txn["transaction"], expected_old=txn["oldHash"],
        expected_new=txn["oldHash"], payload=b"", container=CONTAINER,
        expected_cid=txn["containerId"], expected_config_hash=txn["containerConfigHash"],
        restart=[], owner=None, target_owner=TARGET_OWNER,
        snapshot_hash=txn["snapshotHash"], snapshot_owner=txn["snapshotOwner"],
        snapshot_mode=txn["snapshotMode"], restart_gate="none",
        timeout=timeout, expected_runtime="any")


def _observe_or_stop(txn: dict) -> dict:
    try:
        return remote_observe(txn)
    except (RotateError, deploy.DeployError, OSError):
        raise RotateError("远端只读观察失败（锁忙/缺失/路径/身份不确定）；停止（不继续）") from None


def _observe_expect(txn: dict, expected_hash: str) -> dict:
    obs = _observe_or_stop(txn)
    if obs.get("targetHash") != expected_hash:
        raise RotateError("远端凭证与预期摘要不符；停止（保留恢复材料，不写正式 Keychain）")
    return obs


# ---------------------------------------------------------------------------
# 独立 TLS 探针（curl -q --config -；auth 仅 stdin；body /dev/null；仅 3 位状态）
# ---------------------------------------------------------------------------

def _config_safe(kind: str, value: str) -> None:
    if any(ch in value for ch in ('"', "\\", "\r", "\n")):
        raise RotateError("%s 含 curl 配置不安全字符；拒绝请求（不回显值）" % kind)


def _split_status(raw: bytes, marker: str) -> int:
    m = ("\n" + marker).encode("ascii")
    idx = raw.rfind(m)
    if idx < 0:
        raise RotateError("curl 输出缺少状态标记（响应异常，不输出正文）")
    tail = raw[idx + len(m):]
    if not tail.startswith(b":"):
        raise RotateError("curl 状态标记异常")
    txt = tail[1:].strip()
    if len(txt) != 3 or not txt.isdigit():
        raise RotateError("curl 返回非 3 位状态码")
    return int(txt)


def curl_status(path: str, method: str, auth: str | None, *, head: bool = False,
                timeout: int = 20) -> int:
    marker = "MRROT%08x" % secrets.randbits(32)
    _config_safe("path", path)
    lines = [
        'url = "https://%s%s"' % (DOMAIN, path),
        'resolve = "%s:443:%s"' % (DOMAIN, REMOTE_IP),
        'noproxy = "*"',
        "connect-timeout = 10",
        "max-time = %d" % timeout,
        'output = "/dev/null"',
        "silent",
        'write-out = "\\n' + marker + ':%{http_code}"',
    ]
    if head:
        lines.append("head")
    else:
        lines.append('request = "%s"' % method)
    if auth is not None:
        _config_safe("Authorization", auth)
        lines.append('header = "Authorization: %s"' % auth)
    config = ("\n".join(lines) + "\n").encode("utf-8")
    res = deploy.local_exec([deploy.CURL, "-q", "--config", "-"], stdin=config, timeout=timeout + 5)
    if res.timed_out or res.rc != 0:
        raise RotateError("本地 TLS 请求失败（不输出响应细节）；请核查网络/TLS")
    return _split_status(res.out, marker)


def _basic(secret: str) -> str:
    return "Basic " + base64.b64encode(("viewer:" + secret).encode("utf-8")).decode("ascii")


def _bearer(secret: str) -> str:
    return "Bearer " + secret


def _matrix_checks(active, old_v, old_u, new_v, new_u):
    def head(path, secret):
        return lambda: curl_status(path, "GET", _basic(secret), head=True)

    def get(path, auth):
        return lambda: curl_status(path, "GET", auth)

    if active == "new":
        return [
            ("new viewer HEAD /", head("/", new_v), 200),
            ("old viewer HEAD /", head("/", old_v), 401),
            ("new upload GET /api/meta", get("/api/meta", _bearer(new_u)), 200),
            ("old upload GET /api/meta", get("/api/meta", _bearer(old_u)), 401),
            ("new upload GET /api/overview", get("/api/overview", _bearer(new_u)), 403),
            ("new viewer GET /api/publish", get("/api/publish", _basic(new_v)), 403),
            ("new upload GET /api/publish", get("/api/publish", _bearer(new_u)), 405),
        ]
    return [
        ("old viewer HEAD /", head("/", old_v), 200),
        ("new viewer HEAD /", head("/", new_v), 401),
        ("old upload GET /api/meta", get("/api/meta", _bearer(old_u)), 200),
        ("new upload GET /api/meta", get("/api/meta", _bearer(new_u)), 401),
        ("old upload GET /api/overview", get("/api/overview", _bearer(old_u)), 403),
        ("old viewer GET /api/publish", get("/api/publish", _basic(old_v)), 403),
        ("old upload GET /api/publish", get("/api/publish", _bearer(old_u)), 405),
    ]


def tls_matrix(active, old_v, old_u, new_v, new_u) -> None:
    for name, call, expected in _matrix_checks(active, old_v, old_u, new_v, new_u):
        got = call()
        if got != expected:
            raise RotateError("TLS 角色矩阵不符（%s：期望 %d，实际 %d）；停止" % (name, expected, got))


def wait_tls_matrix(active, old_v, old_u, new_v, new_u, attempts: int = 6, delay: float = 2.0) -> None:
    last = None
    for i in range(max(1, attempts)):
        try:
            tls_matrix(active, old_v, old_u, new_v, new_u)
            return
        except RotateError as err:
            last = err
            if i + 1 < attempts:
                time.sleep(delay)
    raise last if last is not None else RotateError("TLS 矩阵未通过")


def preflight_online(old_v: str, old_u: str) -> None:
    """写前只读在线确认：旧 viewer HEAD 200、旧 upload meta 200。"""
    if curl_status("/", "GET", _basic(old_v), head=True) != 200:
        raise RotateError("旧查看凭证在线校验失败（HEAD / 非 200）；停止（未做任何写入）")
    if curl_status("/api/meta", "GET", _bearer(old_u)) != 200:
        raise RotateError("旧上传凭证在线校验失败（/api/meta 非 200）；停止（未做任何写入）")


def server_serves_old(old_v, old_u, new_v, new_u) -> bool:
    """认证对照证据：明确旧进程仍生效。任何探测异常都返回 False（不据此重启）。"""
    try:
        if curl_status("/", "GET", _basic(old_v), head=True) != 200:
            return False
        if curl_status("/", "GET", _basic(new_v), head=True) != 401:
            return False
        if curl_status("/api/meta", "GET", _bearer(old_u)) != 200:
            return False
        if curl_status("/api/meta", "GET", _bearer(new_u)) != 401:
            return False
    except RotateError:
        return False
    return True


# ---------------------------------------------------------------------------
# 阶段编排
# ---------------------------------------------------------------------------

def _restart_cmd():
    return ["docker", "restart", CONTAINER]


def _verify_against_bytes(secret: str, raw: bytes, role: str, which: str) -> None:
    data = validate_credentials_bytes(raw)
    digest = data["viewer"]["digest"] if role == "viewer" else data["upload"]["digest"]
    if not secret_matches_digest(secret, digest):
        raise RotateError("暂存 %s %s 明文与摘要不符；停止（不可继续）" % (which, role))


def _remote_new_matches(txn: dict) -> bool:
    info = read_remote_credentials()
    if info is None:
        return False
    raw, uid, gid, mode = info
    return sha256_hex(raw) == txn.get("newHash")


def _apply_to_new(txn: dict, old_v, old_u, new_v, new_u, new_bytes: bytes,
                  expected_runtime: str = "running") -> None:
    txn["phase"] = "applying"
    _write_txn(txn)
    result = run_remote_apply(
        mode="apply", txn_id=txn["transaction"], expected_old=txn["oldHash"],
        expected_new=txn["newHash"], payload=new_bytes, container=CONTAINER,
        expected_cid=txn["containerId"], expected_config_hash=txn["containerConfigHash"],
        restart=_restart_cmd(), owner=TARGET_OWNER, target_owner=TARGET_OWNER,
        snapshot_hash=txn["snapshotHash"], snapshot_owner=txn["snapshotOwner"],
        snapshot_mode=txn["snapshotMode"], restart_gate="apply",
        expected_runtime=expected_runtime)
    txn["phase"] = "applied"
    txn["remoteResult"] = {"changed": bool(result.get("changed")),
                           "restarted": bool(result.get("restarted"))}
    _write_txn(txn)


def _restart_once(txn: dict, gate: str, expected_hash: str, expected_runtime: str) -> None:
    """显式给出预期磁盘摘要与运行态：forward 用 newHash，rollback 用 oldHash；
    绝不以 newHash 去 CAS 磁盘上的 old。"""
    txn["phase"] = "verifying"
    _write_txn(txn)
    run_remote_apply(
        mode="restart", txn_id=txn["transaction"], expected_old=expected_hash,
        expected_new=expected_hash, payload=b"", container=CONTAINER,
        expected_cid=txn["containerId"], expected_config_hash=txn["containerConfigHash"],
        restart=_restart_cmd(), owner=None, target_owner=TARGET_OWNER,
        snapshot_hash=txn["snapshotHash"], snapshot_owner=txn["snapshotOwner"],
        snapshot_mode=txn["snapshotMode"], restart_gate=gate,
        expected_runtime=expected_runtime)
    txn["phase"] = "applied"
    _write_txn(txn)


def _verify_server(txn: dict, active: str, secrets) -> None:
    old_v, old_u, new_v, new_u = secrets
    txn["phase"] = "verifying"
    _write_txn(txn)
    reconfirm_baseline(txn)
    wait_tls_matrix(active, old_v, old_u, new_v, new_u)
    txn["phase"] = "verified"
    _write_txn(txn)
    log("[verify] TLS 角色矩阵与基线通过（%s 生效）" % active)


def _commit_formal(txn: dict, secrets, old_bytes: bytes, new_bytes: bytes) -> None:
    old_v, old_u, new_v, new_u = secrets
    _verify_against_bytes(old_v, old_bytes, "viewer", "old")
    _verify_against_bytes(old_u, old_bytes, "upload", "old")
    _verify_against_bytes(new_v, new_bytes, "viewer", "new")
    _verify_against_bytes(new_u, new_bytes, "upload", "new")
    # 正式提交前必须经过只读 observe（持锁、完整身份/hash/snapshot/路径门禁）
    _observe_expect(txn, txn["newHash"])
    txn["phase"] = "committing"
    _write_txn(txn)
    keychain_update_formal(FORMAL_VIEWER[0], FORMAL_VIEWER[1], new_v, (old_v, new_v))
    keychain_update_formal(FORMAL_UPLOAD[0], FORMAL_UPLOAD[1], new_u, (old_u, new_u))
    if deploy.keychain_get(*FORMAL_VIEWER) != new_v or deploy.keychain_get(*FORMAL_UPLOAD) != new_u:
        raise RotateError("正式 Keychain 回读不一致；停止（不记录 complete）")
    _observe_expect(txn, txn["newHash"])
    reconfirm_identity(txn)
    txn["phase"] = "complete"
    _write_txn(txn)
    log("[commit] 正式 Keychain 已更新并回读一致；事务完成（恢复材料保留）")


def _try_clear_active(txn: dict) -> bool:
    """clear 三态：deleted(本事务) / absent(锁内确认不存在) 视为完成；other 保留停止。"""
    try:
        result = remote_clear_active(
            txn["transaction"], container=CONTAINER, expected_cid=txn["containerId"],
            expected_config_hash=txn["containerConfigHash"], snapshot_hash=txn["snapshotHash"],
            snapshot_owner=txn["snapshotOwner"], snapshot_mode=txn["snapshotMode"])
        if result.get("cleared") in ("deleted", "absent"):
            txn["activeCleared"] = True
        else:
            txn["activeCleared"] = False
            log("[rotate] 远端 active 标记状态未确认（其他事务/未知）；保留恢复材料")
    except (RotateError, deploy.DeployError, OSError):
        # 固定错误类别，绝不插值底层异常字符串（避免路径/敏感细节外泄）
        txn["activeCleared"] = False
        log("[rotate] 警告：远端 active 标记未证实清除（固定错误类别）；保留恢复材料")
    _write_txn(txn)
    return bool(txn.get("activeCleared"))


def _finish_cleanup_or_fail(txn: dict, ok_line: str) -> int:
    """凭证已提交后仍须确认 cleanup；未确认一律非零固定报错，绝不整体 OK。"""
    if not _try_clear_active(txn):
        raise RotateError("凭证提交完成 cleanup 未确认；保留恢复材料（不整体成功）")
    print(ok_line)
    return 0


def _classify(current_sha, txn) -> str:
    if current_sha is None:
        return "missing"
    if current_sha == txn.get("oldHash"):
        return "old"
    if current_sha == txn.get("newHash"):
        return "new"
    return "third"


def _current_cred_sha():
    info = read_remote_credentials()
    if info is None:
        return None
    raw, _uid, _gid, _mode = info
    validate_credentials_bytes(raw)
    return sha256_hex(raw)


def _fresh_txn_record(txn_id, old_bytes, new_bytes, old_data) -> dict:
    return {
        "version": TX_ROTATE_VERSION,
        "transaction": txn_id,
        "domain": DOMAIN,
        "container": CONTAINER,
        "target": REMOTE_CREDENTIALS,
        "snapshot": SNAPSHOT_PATH,
        "credentials": REMOTE_CREDENTIALS,
        "phase": "preparing",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "oldCredentialsB64": base64.b64encode(old_bytes).decode("ascii"),
        "oldHash": sha256_hex(old_bytes),
        "oldDigest": old_data,
        "newCredentialsB64": base64.b64encode(new_bytes).decode("ascii"),
        "newHash": sha256_hex(new_bytes),
        "staging": _stage_refs(txn_id),
    }


def cmd_rotate(_args) -> int:
    with local_lock():
        _assert_no_active_txn()
        # 首次轮换时 opdir 尚不存在：只读探测，精确 ENOENT=未初始化（无 active），绝不先建目录。
        remote_active = read_remote_active_initialized()
        if remote_active is not None:
            raise RotateError("远端存在持久 active 事务（%s）；拒绝启动新事务" % remote_active)

        # B5：mkdir 前完成全部只读预检与本地生成；任何失败绝不留下空事务目录
        info = read_remote_credentials()
        if info is None:
            raise RotateError("远端缺少凭证；无法轮换（不做任何写入）")
        old_bytes, _uid, _gid, _mode = info
        old_data = validate_credentials_bytes(old_bytes)
        old_v = _validate_secret(deploy.keychain_get(*FORMAL_VIEWER), "旧查看明文")
        old_u = _validate_secret(deploy.keychain_get(*FORMAL_UPLOAD), "旧上传明文")
        _verify_against_bytes(old_v, old_bytes, "viewer", "old")
        _verify_against_bytes(old_u, old_bytes, "upload", "old")
        new_v = deploy.generate_viewer_password()
        new_u = deploy.generate_upload_token()
        if len({old_v, old_u, new_v, new_u}) != 4:
            raise RotateError("新旧凭证存在重复（含 viewer/upload 交叉）；拒绝（重试生成）")
        new_bytes = new_credentials_bytes(new_v, new_u)

        txn_id = secrets.token_hex(16)
        txn_dir = _txn_dir(txn_id)
        os.mkdir(txn_dir, MANAGED_DIR_MODE)
        os.chmod(txn_dir, MANAGED_DIR_MODE)
        _assert_local_safe(txn_dir, expect_dir=True)
        # mkdir 后立刻落合法初始化记录（明确未切换、不可盲 resume）；此后失败准确标 prepare_failed
        txn = _fresh_txn_record(txn_id, old_bytes, new_bytes, old_data)
        _write_txn(txn)
        log("[rotate] 事务 %s 已创建（阶段 preparing，尚未切换凭证）" % txn_id)
        try:
            preflight_online(old_v, old_u)
            txn.update(capture_baseline(txn_id))
            _write_txn(txn)
            keychain_add_exclusive(txn["staging"]["old_viewer"], STAGE_ACCOUNTS["viewer"], old_v)
            keychain_add_exclusive(txn["staging"]["old_upload"], STAGE_ACCOUNTS["upload"], old_u)
            keychain_add_exclusive(txn["staging"]["new_viewer"], STAGE_ACCOUNTS["viewer"], new_v)
            keychain_add_exclusive(txn["staging"]["new_upload"], STAGE_ACCOUNTS["upload"], new_u)
            secrets_now = assert_staging_matches(txn)
            formal_v, formal_u = formal_pair()
            if formal_v != old_v or formal_u != old_u:
                raise RotateError("正式 Keychain 已非本事务 old；停止（不动服务器）")
            txn["phase"] = "prepared"
            _write_txn(txn)
        except (RotateError, deploy.DeployError, OSError):
            txn["phase"] = "prepare_failed"
            _write_txn(txn)
            raise

        try:
            remote_prepare_dir()
            _apply_to_new(txn, old_v, old_u, new_v, new_u, new_bytes)
            _verify_server(txn, "new", secrets_now)
            _commit_formal(txn, secrets_now, old_bytes, new_bytes)
        except (RotateError, deploy.DeployError, OSError):
            txn["phase"] = "failed"
            _write_txn(txn)
            raise
        return _finish_cleanup_or_fail(txn, "ROTATE_OK %s phase=%s" % (txn_id, txn["phase"]))


def cmd_resume(args) -> int:
    txn = _read_txn(_assert_txn_id(args.transaction))
    if txn.get("phase") in TERMINAL_PHASES:
        with local_lock():
            if txn.get("activeCleared") is not True:
                if _try_clear_active(txn):
                    print("RESUME_CLEARED %s phase=%s" % (txn["transaction"], txn["phase"]))
                    return 0
                raise RotateError("active 标记未证实清除；保留恢复材料（不输出 CLEARED）")
        print("RESUME_NOOP %s phase=%s" % (txn["transaction"], txn["phase"]))
        return 0
    if txn.get("phase") not in RESUMABLE_PHASES:
        raise RotateError("事务未准备完成/不可继续（阶段 %s）；拒绝 resume" % txn.get("phase"))
    with local_lock():
        try:
            old_bytes, new_bytes = validate_txn(txn)
            secrets_now = assert_staging_matches(txn)
            old_v, old_u, new_v, new_u = secrets_now
            formal_v, formal_u = formal_pair()
            if formal_v not in (old_v, new_v) or formal_u not in (old_u, new_u):
                raise RotateError("正式 Keychain 状态未知；停止（不写服务器）")
            # B4：恢复分类前先经只读 observe（持既有锁；busy/missing/unknown 一律停止）
            obs = _observe_or_stop(txn)
            if obs.get("active") not in (None, txn["transaction"]):
                raise RotateError("远端 active 事务非本事务；拒绝 resume")
            current = obs.get("targetHash")
            kind = _classify(current, txn)
            runtime = obs.get("runtime")
            if kind in ("third", "missing"):
                raise RotateError("远端凭证为第三套/缺失；无法安全继续（人工核查）")
            # 恢复分类后、任何 apply/restart 前，只复核完整身份/config/snapshot/nginx/vhost
            # 历史基线（不要求容器 running）；从而覆盖 exited 停机的 resume 路径。
            reconfirm_identity(txn)
            if kind == "old":
                # 磁盘仍为旧凭证：必须先切到 new。apply 明确要求 running。
                if runtime != "running":
                    raise RotateError("磁盘为旧凭证但容器运行态 %s；拒绝 apply（要求 running）" % runtime)
                remote_prepare_dir()
                _apply_to_new(txn, old_v, old_u, new_v, new_u, new_bytes,
                              expected_runtime="running")
                _verify_server(txn, "new", secrets_now)
            else:
                # 磁盘已是 new：按 observe 到的运行态显式分支；未知态一律停止。
                if runtime == "exited":
                    _restart_once(txn, "exited", txn["newHash"], "exited")
                elif runtime == "running":
                    if not deploy.container_state_ok():
                        raise RotateError("容器运行但状态不满足安全 allowlist；拒绝 restart")
                    if server_serves_old(old_v, old_u, new_v, new_u):
                        _restart_once(txn, "stale", txn["newHash"], "running")
                else:
                    raise RotateError("容器运行态 %s 不接受 restart；停止" % runtime)
                # 重启后保留完整基线校验（此时容器应已 running）+ TLS，再进正式提交。
                _verify_server(txn, "new", secrets_now)
            _commit_formal(txn, secrets_now, old_bytes, new_bytes)
        except (RotateError, deploy.DeployError, OSError):
            txn["phase"] = "failed"
            _write_txn(txn)
            raise
        return _finish_cleanup_or_fail(txn, "RESUME_OK %s phase=%s" % (txn["transaction"], txn["phase"]))


def cmd_rollback(args) -> int:
    txn = _read_txn(_assert_txn_id(args.transaction))
    if txn.get("phase") == "rolled_back":
        with local_lock():
            if txn.get("activeCleared") is not True:
                cleared = _try_clear_active(txn)
                if cleared:
                    print("ROLLBACK_CLEARED %s" % txn["transaction"])
                    return 0
                raise RotateError("active 标记未证实清除；保留恢复材料")
        print("ROLLBACK_NOOP %s phase=rolled_back" % txn["transaction"])
        return 0
    if txn.get("phase") not in RESUMABLE_PHASES and txn.get("phase") != "complete":
        raise RotateError("事务未准备完成/不可回滚（阶段 %s）；拒绝 rollback" % txn.get("phase"))
    with local_lock():
        try:
            old_bytes, new_bytes = validate_txn(txn)
            secrets_now = assert_staging_matches(txn)
            old_v, old_u, new_v, new_u = secrets_now
            formal_v, formal_u = formal_pair()
            # rollback 严禁先改服务器再发现正式 foreign
            if formal_v not in (old_v, new_v) or formal_u not in (old_u, new_u):
                raise RotateError("正式 Keychain 状态未知；拒绝 rollback（不写服务器）")
            # B4：恢复分类前先经只读 observe
            obs = _observe_or_stop(txn)
            if obs.get("active") not in (None, txn["transaction"]):
                raise RotateError("远端 active 事务非本事务；拒绝 rollback")
            current = obs.get("targetHash")
            kind = _classify(current, txn)
            if kind == "third":
                raise RotateError("远端凭证为第三套；拒绝 rollback（人工核查）")
            if kind == "missing":
                raise RotateError("远端凭证缺失；无法 rollback（人工核查）")
            # 回滚分类后、任何 apply/restart 前补齐历史 nginx/vhost/身份基线门禁（不要求 running）；
            # 后置完整 reconfirm_baseline 保留。
            reconfirm_identity(txn)
            runtime = obs.get("runtime")
            txn["phase"] = "rolling_back"
            _write_txn(txn)
            remote_prepare_dir()
            if kind == "new":
                # 磁盘 new -> 写回 old；apply 需明确运行态（running/exited）
                if runtime not in ("running", "exited"):
                    raise RotateError("容器运行态 %s 不接受 restore-apply；停止" % runtime)
                run_remote_apply(
                    mode="apply", txn_id=txn["transaction"], expected_old=txn["newHash"],
                    expected_new=txn["oldHash"], payload=old_bytes, container=CONTAINER,
                    expected_cid=txn["containerId"],
                    expected_config_hash=txn["containerConfigHash"], restart=_restart_cmd(),
                    owner=TARGET_OWNER, target_owner=TARGET_OWNER,
                    snapshot_hash=txn["snapshotHash"], snapshot_owner=txn["snapshotOwner"],
                    snapshot_mode=txn["snapshotMode"], restart_gate="apply",
                    expected_runtime=runtime)
            else:
                # 磁盘已是 old：按运行态重启，显式 expected=oldHash，绝不用 newHash 去 CAS
                if runtime == "running":
                    _restart_once(txn, "stale", txn["oldHash"], "running")
                elif runtime == "exited":
                    _restart_once(txn, "exited", txn["oldHash"], "exited")
                else:
                    raise RotateError("容器运行态 %s 不接受 restart；停止" % runtime)
            txn["phase"] = "rollback_applied"
            _write_txn(txn)
            reconfirm_baseline(txn)
            wait_tls_matrix("old", old_v, old_u, new_v, new_u)
            # 正式回写前后都必须 observe 且确认磁盘/属性为 oldHash
            _observe_expect(txn, txn["oldHash"])
            keychain_update_formal(FORMAL_VIEWER[0], FORMAL_VIEWER[1], old_v, (old_v, new_v))
            keychain_update_formal(FORMAL_UPLOAD[0], FORMAL_UPLOAD[1], old_u, (old_u, new_u))
            if deploy.keychain_get(*FORMAL_VIEWER) != old_v or deploy.keychain_get(*FORMAL_UPLOAD) != old_u:
                raise RotateError("正式 Keychain 回滚回读不一致；停止（不记录 rolled_back）")
            _observe_expect(txn, txn["oldHash"])
            reconfirm_identity(txn)
            txn["phase"] = "rolled_back"
            _write_txn(txn)
        except (RotateError, deploy.DeployError, OSError):
            txn["phase"] = "failed"
            _write_txn(txn)
            raise
        return _finish_cleanup_or_fail(txn, "ROLLBACK_OK %s phase=rolled_back" % txn["transaction"])


def _safe_secret_for(txn, key):
    service = txn.get("staging", {}).get(key)
    if not service:
        return None
    account = STAGE_ACCOUNTS["viewer" if "viewer" in key else "upload"]
    try:
        if not deploy.keychain_exists(service, account):
            return None
        return deploy.keychain_get(service, account)
    except (RotateError, deploy.DeployError, OSError):
        return None


def _match_role(value, old_secret, new_secret) -> str:
    if value is None:
        return "unknown"
    if old_secret is not None and value == old_secret:
        return "old"
    if new_secret is not None and value == new_secret:
        return "new"
    return "unknown"


def cmd_status(args) -> int:
    """只读：报告实际状态；不写文件、不取锁、不生成凭证、不清锁/active。"""
    txn_id = _assert_txn_id(args.transaction)
    d = _txn_dir(txn_id)
    if not os.path.isdir(d):
        print("STATUS %s local=absent" % txn_id)
        return 0
    txn = _read_txn(txn_id)
    report = {"transaction": txn_id, "phase": txn.get("phase"), "version": txn.get("version")}
    try:
        current = _current_cred_sha()
    except (RotateError, deploy.DeployError, OSError):
        # SSH/解析/属性错误：独立 unknown，绝不误报 missing，也不据此声称 ready
        report["remote"] = "unknown"
    else:
        report["remote"] = _classify(current, txn)
    report["complete"] = "yes" if txn.get("phase") in TERMINAL_PHASES else "no"
    report["identityFields"] = "present" if all(
        k in txn for k in ("containerId", "containerConfigHash", "snapshotHash", "nginxVhostHash")) else "incomplete"
    old_v = _safe_secret_for(txn, "old_viewer")
    new_v = _safe_secret_for(txn, "new_viewer")
    old_u = _safe_secret_for(txn, "old_upload")
    new_u = _safe_secret_for(txn, "new_upload")
    try:
        fv, fu = formal_pair()
    except (RotateError, deploy.DeployError, OSError):
        fv = fu = None
    report["formalViewer"] = _match_role(fv, old_v, new_v)
    report["formalUpload"] = _match_role(fu, old_u, new_u)
    try:
        report["containerOk"] = bool(deploy.container_state_ok())
    except (RotateError, deploy.DeployError, OSError):
        report["containerOk"] = False
    print("STATUS " + json.dumps(report, sort_keys=True))
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rotate-mobile-readonly", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("rotate")
    for name in ("status", "resume", "rollback"):
        p = sub.add_parser(name)
        p.add_argument("--transaction", required=True)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {
        "rotate": cmd_rotate, "status": cmd_status,
        "resume": cmd_resume, "rollback": cmd_rollback,
    }
    try:
        return int(handlers[args.command](args) or 0)
    except RotateError as err:
        print("[rotate] 中止：%s" % err, file=sys.stderr)
        return 2
    except deploy.DeployError:
        print("[rotate] 中止：底层操作失败（细节已脱敏）", file=sys.stderr)
        return 2
    except Exception:
        print("[rotate] 中止：内部错误（细节已脱敏，无 traceback）", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
