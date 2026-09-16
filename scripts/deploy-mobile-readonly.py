#!/usr/bin/env python3
"""移动只读发布 · 云端部署编排（deploy-mobile-readonly）。

阶段化、幂等、只写自有资源；全部密钥只走本机 Keychain / SSH stdin / curl 配置 stdin，
绝不进入 argv、env、仓库文件、日志或错误正文。
安全约定：
- 底层执行统一 bytes 语义（输入 bytes、输出 decode utf-8, errors=replace 仅在内部白名单点使用）。
- 含密钥的命令失败只报告固定文案与退出码，不打印任何 stdout/stderr 片段。
- 冒烟/探针只读版本/计数；发布仅允许空集合冒烟且绝不在已有真实数据时覆盖。
- 对远端仅写本文件声明的自有路径；既有主域/default 配置只做 sha256 基线核对。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import shlex
import subprocess
import sys

REMOTE = "root@aliyun"
SSH_BASE = [
    "ssh", "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=yes",
]
SECURITY = "/usr/bin/security"
CURL = "/usr/bin/curl"

LOCAL_IMAGE = "relocation-mobile-readonly:1766c8f-amd64"
EXPECTED_IMAGE_ID = "sha256:ed23404960a08f17a91ef743156e15591ef038aba6c96402e53a498ebf0a1273"

CONTAINER = "relocation-mobile-readonly"
REMOTE_BASE = "/opt/relocation-mobile-readonly"
REMOTE_DATA_DIR = REMOTE_BASE + "/data"
REMOTE_CREDENTIALS = REMOTE_DATA_DIR + "/credentials.json"
MARKER_FILE = REMOTE_BASE + "/.deploy-managed"
MARKER_VALUE = "relocation-mobile-readonly"

OPENRESTY_CONTAINER = "1Panel-openresty-E57G"
NGINX_HOST = "workbench.michaelli.site"
CONF_D = "/opt/1panel/apps/openresty/openresty/conf/conf.d"
VHOST_PATH = CONF_D + "/" + NGINX_HOST + ".conf"
SITE_ROOT = "/opt/1panel/apps/openresty/openresty/www/sites/" + NGINX_HOST
SITE_ACME = SITE_ROOT + "/acme"
SITE_SSL = SITE_ROOT + "/ssl"
SITE_MARKER_FILE = SITE_ROOT + "/.deploy-managed"
SITE_MARKER_VALUE = "relocation-mobile-readonly-site"
# 服务 uid/gid（容器 --user 1000:1000）。仅凭据摘要与 data 托管标记使用该属主；
# root 服务器不创建任何宿主账号。vhost/站点/证书/challenge 保持 ssh root 属主（不传 owner）。
CREDENTIAL_OWNER = (1000, 1000)
CTR_SITE = "/www/sites/" + NGINX_HOST
CTR_ACME = CTR_SITE + "/acme"
CTR_SSL = CTR_SITE + "/ssl"
VHOST_HEADER = "# managed by deploy-mobile-readonly; do not edit manually"
ACME_RELOADCMD = ("docker exec " + OPENRESTY_CONTAINER + " nginx -t && "
                  "docker exec " + OPENRESTY_CONTAINER + " nginx -s reload")

ACME_SH = "/root/.acme.sh/acme.sh"
ACME_DOMAIN_DIR = "/root/.acme.sh/" + NGINX_HOST + "_ecc"
ACME_GLOBAL = "/root/.acme.sh/account.conf"

STATE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "relocation-mobile-readonly")
STATE_FILE = os.path.join(STATE_DIR, "baseline-checksums.json")

VIEWER_SERVICE = "relocation-workbench:" + NGINX_HOST + ":viewer"
VIEWER_ACCOUNT = "viewer"
UPLOAD_SERVICE = "relocation-workbench:" + NGINX_HOST + ":upload"
UPLOAD_ACCOUNT = "publisher"
VIEWER_USERNAME = "viewer"

SCRYPT = {"N": 16384, "r": 8, "p": 1, "keyLen": 64}
SALT_BYTES = 16
SMOKE_ID = "relocation-workbench-smoke-empty-v1"

MAIN_FILES = [
    "/opt/1panel/apps/openresty/openresty/conf/nginx.conf",
    "/opt/1panel/apps/openresty/openresty/conf/conf.d/michaelli.site.conf",
]

CONTAINER_RUN = [
    "docker", "run", "-d", "--name", CONTAINER,
    "--restart", "unless-stopped",
    "-p", "127.0.0.1:8082:8082",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "512m",
    "--cpus", "0.5",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "--user", "1000:1000",
    "--mount", "type=bind,src=" + REMOTE_DATA_DIR + ",dst=/var/lib/mobile-readonly",
    LOCAL_IMAGE,
]

# 容器现状必须匹配的 allowlist（不匹配即 STOP，不 delete/update）
CONTAINER_REQUIRED = {
    "image": EXPECTED_IMAGE_ID,
    "user": "1000:1000",
    "readonly_rootfs": True,
    "cap_drop": ["ALL"],
    "security_opt": ["no-new-privileges"],
    "memory": 512 * 1024 * 1024,
    "nano_cpus": 500_000_000,
    "pids_limit": 128,
    "restart": "unless-stopped",
    "log_type": "json-file",
    "log_max_size": "10m",
    "log_max_file": "3",
    "host_ip": "127.0.0.1",
    "host_port": "8082",
}

# docker 默认 bridge 网络自动挂载（非本部署创建，allowlist 放行）
_DOCKER_NET_MOUNTS = {"/etc/hosts", "/etc/hostname", "/etc/resolv.conf"}


class DeployError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# 底层执行（统一 bytes；失败/超时只给固定文案 + 退出码，不泄 stdout/stderr）
# ---------------------------------------------------------------------------

class ExecResult:
    def __init__(self, rc: int, out: bytes, err: bytes, timed_out: bool = False):
        self.rc = rc
        self.out = out
        self.err = err
        self.timed_out = timed_out

    def text(self) -> str:
        return self.out.decode("utf-8", "replace")


def _exec(args, stdin: bytes | None = None, timeout: int = 120, allow_fail: bool = False) -> ExecResult:
    try:
        proc = subprocess.run(args, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=timeout, check=False)
        return ExecResult(proc.returncode, proc.stdout or b"", proc.stderr or b"")
    except subprocess.TimeoutExpired as err:
        partial_out = (err.stdout or b"")
        partial_err = (err.stderr or b"")
        return ExecResult(1, partial_out, partial_err, timed_out=True)


def local_exec(args, stdin: bytes | None = None, timeout: int = 120) -> ExecResult:
    return _exec(args, stdin=stdin, timeout=timeout)


def remote_exec(shell: str, stdin: bytes | None = None, timeout: int = 120) -> ExecResult:
    return _exec(SSH_BASE + [REMOTE, shell], stdin=stdin, timeout=timeout)


def require_ok(res: ExecResult, what: str) -> None:
    if res.timed_out:
        raise DeployError(f"{what} 执行超时：远端状态不确定，请人工核查（未声称任何自动回滚）")
    if res.rc != 0:
        raise DeployError(f"{what} 失败（退出码 {res.rc}）；未输出细节，请人工核查")


def remote_ok(shell: str, timeout: int = 60) -> bool:
    res = remote_exec(shell, timeout=timeout)
    return res.rc == 0 and not res.timed_out


def remote_true(shell: str) -> str:
    res = remote_exec(shell)
    require_ok(res, "远端查询")
    return res.text().strip()


# ---------------------------------------------------------------------------
# 路径安全（拒绝符号链接 / 只允许精确常量路径；不递归 chown 既有树）
# ---------------------------------------------------------------------------

def remote_no_symlink(path: str) -> None:
    """只用 test -L 判定（不依赖 test -e：悬空链接 test -e 为假但仍是符号链接）。
    退出码判别：rc0=是链接（拒绝）；rc1=非链接或不存在（唯一放行）；
    rc2/rc255/超时=查询错误或状态未知（拒绝，不虚构为“非链接”）。"""
    res = remote_exec(f"test -L {shlex.quote(path)}")
    if res.rc == 0:
        raise DeployError(f"远端路径 {path} 是符号链接，拒绝操作")
    if res.timed_out or res.rc != 1:
        raise DeployError(f"远端路径检查失败：{path}（状态未知，拒绝操作）")


def remote_file_exists(path: str) -> bool:
    """test -f 退出码判别：rc0=存在；rc1=确定不存在；
    rc2/rc255/超时=查询错误（抛不透明 DeployError，不虚构“不存在”）。"""
    res = remote_exec(f"test -f {shlex.quote(path)}")
    if res.timed_out or res.rc not in (0, 1):
        raise DeployError(f"远端文件检查失败：{path}（状态未知，拒绝操作）")
    return res.rc == 0


def marker_content_ok(marker_path: str, expected: str) -> bool:
    remote_no_symlink(marker_path)
    if not remote_ok(f"test -f {shlex.quote(marker_path)}"):
        return False
    res = remote_exec(f"cat {shlex.quote(marker_path)}")
    return res.rc == 0 and res.text().strip() == expected


def require_marker() -> None:
    remote_no_symlink(REMOTE_BASE)
    remote_no_symlink(REMOTE_DATA_DIR)
    if not remote_ok(f"test -e {shlex.quote(REMOTE_BASE)}"):
        raise DeployError("数据目录尚未初始化（先运行 credentials）")
    if not marker_content_ok(MARKER_FILE, MARKER_VALUE):
        raise DeployError("数据目录已存在但无正确托管标记；拒绝覆盖/接管，请人工处理")


def site_managed() -> bool:
    return marker_content_ok(SITE_MARKER_FILE, SITE_MARKER_VALUE)


# 远端原子安全写入：mkstemp(同一已核验目录) + fchmod + 可选 fchown + fsync；
# exclusive=True 用硬链接原子且绝不覆盖既有目标；exclusive=False 用 os.replace 原子替换。
# 内容只经 stdin（JSON/摘要/vhost/文本均不含经 argv 的明文）。
# owner 仅用于必须由服务 uid(1000:1000) 读取的文件（credentials.json 与 data 托管标记）；
# 其余 vhost/站点 SSL/challenge 保持 ssh root 默认属主（不传 owner，绝不全局/递归 chown）。
_REMOTE_WRITE_SNIPPET = (
    "import os, sys, tempfile\n"
    "target = {target!r}\n"
    "mode = {mode!r}\n"
    "exclusive = {exclusive!r}\n"
    "owner = {owner!r}\n"
    "payload = sys.stdin.buffer.read()\n"
    "parent = os.path.dirname(target)\n"
    "fd, tmp = tempfile.mkstemp(prefix='.mr-deploy-', dir=parent)\n"
    "try:\n"
    "    view = memoryview(payload)\n"
    "    written = 0\n"
    "    while written < len(view):\n"
    "        written += os.write(fd, view[written:])\n"
    "    os.fchmod(fd, mode)\n"
    "    if owner is not None:\n"
    "        os.fchown(fd, owner[0], owner[1])\n"
    "    os.fsync(fd)\n"
    "    os.close(fd)\n"
    "    if exclusive:\n"
    "        os.link(tmp, target)\n"
    "        os.unlink(tmp)\n"
    "    else:\n"
    "        os.replace(tmp, target)\n"
    "except OSError:\n"
    "    try:\n"
    "        os.close(fd)\n"
    "    except OSError:\n"
    "        pass\n"
    "    try:\n"
    "        os.unlink(tmp)\n"
    "    except OSError:\n"
    "        pass\n"
    "    raise SystemExit(3)\n"
)


def _validate_owner(owner) -> tuple[int, int] | None:
    if owner is None:
        return None
    if (not isinstance(owner, (tuple, list)) or len(owner) != 2
            or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in owner)):
        raise DeployError("owner 必须为 (uid, gid) 非负整数元组（仅自有固定调用点使用）")
    return (int(owner[0]), int(owner[1]))


def remote_write_bytes(path: str, payload: bytes, mode: int = 0o600, exclusive: bool = False,
                       owner: tuple[int, int] | None = None) -> None:
    safe_owner = _validate_owner(owner)
    code = _REMOTE_WRITE_SNIPPET.format(target=path, mode=mode, exclusive=exclusive, owner=safe_owner)
    b64 = base64.b64encode(code.encode("utf-8")).decode("ascii")
    cmd = "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % b64)
    res = remote_exec(cmd, stdin=payload)
    require_ok(res, "远端安全写入")


# ---------------------------------------------------------------------------
# 本地 scrypt 摘要与远端验证（salt/参数与 server credentials.ts 完全一致）
# ---------------------------------------------------------------------------

def parse_digest(digest: str) -> dict | None:
    parts = digest.split("$")
    if len(parts) != 7 or parts[0] != "scrypt":
        return None
    try:
        n, r, p, klen = (int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]))
        salt = base64.b64decode(parts[5], validate=True)
        hsh = base64.b64decode(parts[6], validate=True)
    except (ValueError, TypeError):
        return None
    if n < SCRYPT["N"] or r < 1 or p < 1 or klen < 32 or len(hsh) != klen or len(salt) == 0:
        return None
    return {"n": n, "r": r, "p": p, "klen": klen, "salt": salt, "hash": hsh}


def digest_for(secret: str, parsed: dict) -> bytes:
    return hashlib.scrypt(secret.encode("utf-8"), salt=parsed["salt"], n=parsed["n"],
                          r=parsed["r"], p=parsed["p"], dklen=parsed["klen"])


def new_digest(secret: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    params = SCRYPT
    dk = hashlib.scrypt(secret.encode("utf-8"), salt=salt, n=int(params["N"]),
                        r=int(params["r"]), p=int(params["p"]), dklen=int(params["keyLen"]))
    return "scrypt${N}${r}${p}${klen}${salt}${hash}".format(
        N=params["N"], r=params["r"], p=params["p"], klen=params["keyLen"],
        salt=base64.b64encode(salt).decode(), hash=base64.b64encode(dk).decode())


def creds_matches_secret(creds: dict, viewer_secret: str, upload_secret: str) -> bool:
    vd = parse_digest(creds.get("viewer", {}).get("digest", ""))
    ud = parse_digest(creds.get("upload", {}).get("digest", ""))
    if vd is None or ud is None:
        return False
    return (digest_for(viewer_secret, vd) == vd["hash"] and
            digest_for(upload_secret, ud) == ud["hash"] and
            creds.get("viewer", {}).get("username") == VIEWER_USERNAME)


def build_new_credentials(viewer_secret: str, upload_secret: str) -> dict:
    return {
        "viewer": {"username": VIEWER_USERNAME, "digest": new_digest(viewer_secret)},
        "upload": {"digest": new_digest(upload_secret)},
    }


# ---------------------------------------------------------------------------
# 远端摘要落盘（原子安全写入、600、仅自有新文件；绝不 mv -f 覆盖未知内容）
# ---------------------------------------------------------------------------

def write_credentials_remote(creds: dict) -> None:
    # 目录：base/data 已存在且带正确托管标记时允许复用（仅 chmod/chown 目录自身，不递归）；
    # 不存在时新建并写入精确内容标记。
    remote_no_symlink(REMOTE_BASE)
    remote_no_symlink(REMOTE_DATA_DIR)
    base_existed = remote_ok(f"test -e {shlex.quote(REMOTE_BASE)}")
    if base_existed:
        require_marker()
    for path, mode in ((REMOTE_BASE, "700"), (REMOTE_DATA_DIR, "700")):
        if remote_ok(f"test -e {shlex.quote(path)}"):
            res = remote_exec(f"chmod {mode} {shlex.quote(path)} && chown 1000:1000 {shlex.quote(path)}")
        else:
            res = remote_exec(f"mkdir -p {shlex.quote(path)} && chmod {mode} {shlex.quote(path)} && chown 1000:1000 {shlex.quote(path)}")
        require_ok(res, "远端数据目录准备")
    if not base_existed:
        # 新建目录的托管标记：精确内容 + 原子新建（绝不空 touch）；属主=服务 uid 1000:1000
        remote_no_symlink(MARKER_FILE)
        remote_write_bytes(MARKER_FILE, (MARKER_VALUE + "\n").encode("utf-8"),
                           mode=0o600, exclusive=True, owner=CREDENTIAL_OWNER)
    # 新凭证摘要：目标必须尚不存在，走 credentials 复用校验路径；此处绝不覆盖。
    remote_no_symlink(REMOTE_CREDENTIALS)
    if remote_file_exists(REMOTE_CREDENTIALS):
        raise DeployError("远端摘要文件已存在（应走 credentials --reuse 校验，本写入路径不覆盖）")
    payload = (json.dumps(creds, indent=2, sort_keys=True) + "\n").encode("utf-8")
    remote_write_bytes(REMOTE_CREDENTIALS, payload, mode=0o600, exclusive=True, owner=CREDENTIAL_OWNER)
    # 终态校验：只输出元数据（uid/gid/mode），绝不打 digest 正文。
    stat_res = remote_exec(f"stat -c '%u %g %a' {shlex.quote(REMOTE_CREDENTIALS)}")
    require_ok(stat_res, "远端摘要属性确认")
    parts = stat_res.text().split()
    if len(parts) != 3 or parts[0] != "1000" or parts[1] != "1000" or parts[2] != "600":
        raise DeployError("远端摘要属性不符合预期（uid=1000 gid=1000 mode=600）；中止（仅元数据）")
    log(f"[credentials] 已写入服务器摘要 {REMOTE_CREDENTIALS}（uid=1000 gid=1000 mode=600）")


def read_remote_credentials() -> dict | None:
    """仅当远端摘要文件确定不存在时返回 None；存在但不可读/非法 JSON/非对象一律中止
    （在 Keychain 生成/写入前即失败，绝不落入覆盖路径）。"""
    if not remote_file_exists(REMOTE_CREDENTIALS):
        return None
    res = remote_exec(f"cat {shlex.quote(REMOTE_CREDENTIALS)}")
    if res.rc != 0 or res.timed_out:
        raise DeployError("远端摘要文件存在但不可读；中止（不生成、不覆盖）")
    try:
        data = json.loads(res.out.decode("utf-8", "replace"))
    except ValueError:
        raise DeployError("远端摘要文件非法（非 JSON）；中止（不生成、不覆盖）") from None
    if not isinstance(data, dict):
        raise DeployError("远端摘要文件非法（非 JSON 对象）；中止（不生成、不覆盖）") from None
    return data


# ---------------------------------------------------------------------------
# 本机 Keychain（/usr/bin/security -i 交互 stdin；绝不 -w argv）
# ---------------------------------------------------------------------------

def keychain_exists(service: str, account: str) -> bool:
    """security find-generic-password 退出码判别：rc0=存在；rc44=确定不存在（item not found）；
    其余（rc1 锁/访问失败、rc45 重复查询异常、超时等）→ 固定错误中止，不虚构“不存在/存在”。"""
    res = local_exec([SECURITY, "find-generic-password", "-s", service, "-a", account])
    if res.rc == 0:
        return True
    if res.rc == 44:
        return False
    raise DeployError("Keychain 查询失败（无法确定条目状态，非“缺失”）；请人工解锁/检查后重试，脚本不降级")


def keychain_get(service: str, account: str) -> str:
    res = local_exec([SECURITY, "find-generic-password", "-s", service, "-a", account, "-w"])
    if res.rc != 0:
        raise DeployError("Keychain 条目不可读（缺失或锁定）；请人工解锁后重试，脚本不降级")
    value = res.out.decode("utf-8").rstrip("\n")
    if not value:
        raise DeployError("Keychain 条目为空")
    return value


def keychain_add(service: str, account: str, secret: str) -> None:
    # 实际探针：/usr/bin/security -i 读一条完整命令（EOF 结束即可），
    # 绝不加 quit（会被当作 unknown command 掩盖 rc）；不用 -w argv、不用子命令 -i。
    quoted = shlex.quote(secret)
    interactive = f"add-generic-password -a {account} -s {service} -w {quoted}\n"
    res = local_exec([SECURITY, "-i"], stdin=interactive.encode("utf-8"))
    if res.rc != 0:
        # security 失败可能回显输入；只给固定文案与退出码
        raise DeployError(f"Keychain 写入失败（退出码 {res.rc}）；请人工检查钥匙串后重试")


def ensure_keychain(reuse: bool, service: str, account: str, generator) -> str:
    exists = keychain_exists(service, account)
    if exists and not reuse:
        raise DeployError(
            f"Keychain 已存在条目 {service}（不覆盖）。如需复用请显式 --reuse 并经人工确认；"
            "如确认废弃请先在钥匙串中删除后重跑。")
    if not exists:
        secret = generator()
        keychain_add(service, account, secret)
        check = keychain_get(service, account)
        if check != secret:
            raise DeployError("Keychain 回读校验不一致；已中止（不覆盖）")
        return secret
    # reuse：先可读校验（锁定即失败），随后取回内存使用
    return keychain_get(service, account)


def generate_viewer_password() -> str:
    return secrets.token_urlsafe(32)


def generate_upload_token() -> str:
    return secrets.token_urlsafe(48)


# ---------------------------------------------------------------------------
# 镜像与容器（本地校验 + 远端；已有容器必须逐项 allowlist，不 delete/update）
# ---------------------------------------------------------------------------

def local_image_id() -> str:
    res = local_exec(["docker", "image", "inspect", "--format", "{{.Id}}", LOCAL_IMAGE])
    if res.rc != 0:
        raise DeployError("本地缺少目标镜像；请先构建/加载")
    return res.text().strip()


def remote_image_id() -> str:
    res = remote_exec(f"docker image inspect --format '{{{{.Id}}}}' {LOCAL_IMAGE} 2>/dev/null")
    if res.rc != 0:
        raise DeployError("远端缺少目标镜像")
    return res.text().strip()


def transfer_image() -> None:
    log("[install] docker save | ssh docker load")
    save = subprocess.Popen(["docker", "save", LOCAL_IMAGE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    load = subprocess.Popen(SSH_BASE + [REMOTE, "docker", "load"],
                            stdin=save.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if save.stdout:
        save.stdout.close()
    _, load_err = load.communicate(timeout=900)
    _, save_err = save.communicate(timeout=60)
    if load.returncode != 0 or save.returncode != 0:
        raise DeployError("镜像传输失败；不输出细节，请人工核查 docker/ssh")


def _inspect_container_json() -> dict | None:
    """单次 docker inspect 返回完整 JSON 对象；任何失败/非单对象返回 None（不打印原始输出/Env）。"""
    res = remote_exec(f"docker inspect {shlex.quote(CONTAINER)} 2>/dev/null")
    if res.rc != 0 or res.timed_out:
        return None
    try:
        data = json.loads(res.out.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        return None
    return data[0]


def _mounts_ok(mounts, host_tmpfs) -> bool:
    """校验独立 docker inspect 的两处真实层级：
    - 顶层 data['Mounts']：恰好一个自有数据 bind（Type=bind、Source=REMOTE_DATA_DIR、
      Destination=/var/lib/mobile-readonly、RW=True），其它 Docker 附加字段忽略；
      允许（可选）至多一项纯 tmpfs 类型 /tmp；任何额外/外来 bind 即拒绝。
    - tmpfs 实际独立存放于 HostConfig.Tmpfs（{'/tmp': 'rw,noexec,nosuid,size=16m'}），
      不在顶层 Mounts 依赖；HostConfig.Binds 必须为空（null，无 legacy bind 混入）。
    """
    if not isinstance(mounts, list):
        return False
    data_binds = [m for m in mounts
                  if isinstance(m, dict) and m.get("Destination") == "/var/lib/mobile-readonly"]
    if len(data_binds) != 1:
        return False
    db = data_binds[0]
    if (db.get("Type") != "bind" or db.get("RW") is not True
            or db.get("Source") != REMOTE_DATA_DIR):
        return False
    tmpfs_mounts = [m for m in mounts
                    if isinstance(m, dict) and m.get("Type") == "tmpfs"]
    if len(tmpfs_mounts) > 1:
        return False
    for tm in tmpfs_mounts:
        if tm.get("Destination") != "/tmp":
            return False
    if len(mounts) != 1 + len(tmpfs_mounts):
        return False  # 除自有 bind 与（可选）纯 tmpfs /tmp 外不得有其它顶层挂载
    if not isinstance(host_tmpfs, dict) or list(host_tmpfs.keys()) != ["/tmp"]:
        return False
    opts = host_tmpfs.get("/tmp")
    if not isinstance(opts, str):
        return False
    return set(opts.split(",")) == {"rw", "noexec", "nosuid", "size=16m"}


def container_state_ok() -> bool:
    """已有容器必须以单次 docker inspect 的完整 JSON 逐项满足 allowlist，否则 STOP（绝不 delete/update）。"""
    data = _inspect_container_json()
    if data is None:
        return False
    try:
        cfg = data["Config"]
        host = data["HostConfig"]
        state = data["State"]
        restart = host["RestartPolicy"]
        log_cfg = host["LogConfig"] or {}
        log_opts = log_cfg.get("Config") or {}
        ports = host["PortBindings"] or {}
    except (KeyError, TypeError):
        return False
    if data.get("Image") != CONTAINER_REQUIRED["image"]:
        return False
    if cfg.get("User") != CONTAINER_REQUIRED["user"]:
        return False
    if host.get("ReadonlyRootfs") is not CONTAINER_REQUIRED["readonly_rootfs"]:
        return False
    if host.get("CapDrop") != CONTAINER_REQUIRED["cap_drop"]:
        return False
    if host.get("SecurityOpt") != CONTAINER_REQUIRED["security_opt"]:
        return False
    if host.get("Memory") != CONTAINER_REQUIRED["memory"]:
        return False
    if host.get("NanoCpus") != CONTAINER_REQUIRED["nano_cpus"]:
        return False
    if host.get("PidsLimit") != CONTAINER_REQUIRED["pids_limit"]:
        return False
    if restart.get("Name") != CONTAINER_REQUIRED["restart"]:
        return False
    if log_cfg.get("Type") != CONTAINER_REQUIRED["log_type"]:
        return False
    if log_opts.get("max-size") != CONTAINER_REQUIRED["log_max_size"]:
        return False
    if log_opts.get("max-file") != CONTAINER_REQUIRED["log_max_file"]:
        return False
    if list(ports.keys()) != ["8082/tcp"]:
        return False
    binds = ports.get("8082/tcp")
    if not isinstance(binds, list) or len(binds) != 1 or not isinstance(binds[0], dict):
        return False
    if (binds[0].get("HostIp") != CONTAINER_REQUIRED["host_ip"]
            or binds[0].get("HostPort") != CONTAINER_REQUIRED["host_port"]):
        return False
    if state.get("Running") is not True:
        return False
    # 不允许 legacy Binds（真实部署只用 --mount；--tmpfs 独立走 HostConfig.Tmpfs）
    if host.get("Binds") is not None:
        return False
    # 顶层 data['Mounts']（非 HostConfig.Mounts）才是真实挂载层
    return _mounts_ok(data.get("Mounts"), host.get("Tmpfs"))


def run_container() -> None:
    local_id = local_image_id()
    if local_id != EXPECTED_IMAGE_ID:
        raise DeployError("本地镜像 ID 与基线不一致")
    exists = remote_ok(f"docker ps -a --format '{{{{.Names}}}}' | grep -qx {shlex.quote(CONTAINER)}")
    if exists:
        if not container_state_ok():
            raise DeployError("已有容器不符合安全 allowlist（不 delete/update，人工核查后处理）")
        log("[install] 容器已存在且配置匹配；跳过 create")
        return
    verify_remote_image_id()
    cmd = shlex.join(CONTAINER_RUN)
    res = remote_exec(cmd)
    require_ok(res, "容器启动")
    log("[install] 容器已启动")


def verify_remote_image_id() -> None:
    remote_id = remote_image_id()
    if remote_id != EXPECTED_IMAGE_ID:
        raise DeployError("远端镜像 ID 与基线不一致；拒绝运行")


# ---------------------------------------------------------------------------
# curl 有界 HTTPS/HTTP 传输（配置走 stdin、默认证书校验、绝不 -L/-k；响应只在内存）
# ---------------------------------------------------------------------------

def _config_safe(kind: str, value: str) -> None:
    # curl 配置为双引号包裹值；引号/反斜杠/换行会造成解析歧义，一律拒绝。
    if any(ch in value for ch in ('"', "\\", "\r", "\n")):
        raise DeployError(f"{kind} 含 curl 配置不安全字符；拒绝请求（不回显值）")


def _split_curl_output(raw: bytes, marker: str) -> tuple[int, bytes]:
    """write-out 以 '<换行><marker>:<code>' 结尾；取最后一个 marker 之后的纯数字状态码。"""
    m = ("\n" + marker).encode("ascii")
    idx = raw.rfind(m)
    if idx < 0:
        raise DeployError("curl 输出缺少状态标记（响应被异常截断，不输出正文）")
    tail = raw[idx + len(m):]
    if not tail.startswith(b":"):
        raise DeployError("curl 状态标记异常")
    code_txt = tail[1:].strip()
    if not code_txt.isdigit():
        raise DeployError("curl 返回非数字状态码")
    return int(code_txt), raw[:idx]


def curl_request(url: str, port: int, method: str, auth: str | None,
                 body: bytes | None, timeout: int = 25) -> tuple[int, bytes]:
    marker = "MRDEPLOY%08x" % secrets.randbits(32)
    _config_safe("url", url)
    config_lines = [
        f"url = \"{url}\"",
        f"resolve = \"{NGINX_HOST}:{port}:8.162.13.22\"",
        "noproxy = \"*\"",
        f"max-time = {timeout}",
        f"request = \"{method}\"",
        "write-out = \"\\n" + marker + ":%{http_code}\"",
    ]
    if auth is not None:
        _config_safe("Authorization", auth)
        config_lines.append(f"header = \"Authorization: {auth}\"")
    if body is not None:
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            raise DeployError("请求体不是 UTF-8；拒绝发送")
        # 响应/请求体只在内存：正文经 json.dumps 转义后作为 data-binary 字符串内联，不落临时文件。
        config_lines.append('header = "Content-Type: application/json"')
        config_lines.append("data-binary = " + json.dumps(text, ensure_ascii=False))
    config = ("\n".join(config_lines) + "\n").encode("utf-8")
    res = local_exec([CURL, "-q", "--config", "-"], stdin=config, timeout=timeout + 5)
    if res.rc != 0 or res.timed_out:
        raise DeployError("本地 HTTPS/HTTP 请求失败（不输出响应细节）；请核查网络/TLS")
    return _split_curl_output(res.out, marker)


def http_challenge_get(token: str) -> bytes:
    url = f"http://{NGINX_HOST}/.well-known/acme-challenge/{token}"
    status, content = curl_request(url, 80, "GET", None, None, timeout=15)
    if status != 200:
        raise DeployError(f"ACME challenge 探测失败：HTTP {status}")
    return content


def https_get_json(path: str, auth: str | None) -> tuple[int, dict]:
    status, body = curl_request(f"https://{NGINX_HOST}{path}", 443, "GET", auth, None)
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        raise DeployError(f"远端响应({status})不是 JSON 对象；不输出正文")
    if not isinstance(data, dict):
        raise DeployError(f"远端响应({status})不是 JSON 对象；不输出正文")
    return status, data


def meta_shape_ok(meta: object) -> bool:
    """非业务版本元数据形状校验：published bool、currentVersion int>=0、
    publicationId/publicationAt/dataAsOf None 或 str、fingerprint None 或 dict。"""
    if not isinstance(meta, dict):
        return False
    published = meta.get("published")
    version = meta.get("currentVersion")
    pub_id = meta.get("publicationId")
    if not isinstance(published, bool):
        return False
    if not isinstance(version, int) or version < 0:
        return False
    if pub_id is not None and not isinstance(pub_id, str):
        return False
    for key in ("publishedAt", "dataAsOf"):
        value = meta.get(key)
        if value is not None and not isinstance(value, str):
            return False
    fp = meta.get("fingerprint")
    if fp is not None and not isinstance(fp, dict):
        return False
    return True


# ---------------------------------------------------------------------------
# probe：远端 loopback 双凭证角色（明文只经 SSH stdin，打印仅类型化标量）
# ---------------------------------------------------------------------------

PROBE_PY = r'''
import sys, base64, json, urllib.request, urllib.error

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect", headers, fp)

opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

vp = sys.stdin.readline().rstrip("\n")
up = sys.stdin.readline().rstrip("\n")

def call(path, headers=None, method="GET", body=None):
    data = None
    req_headers = dict(headers or {})
    if body is not None:
        data = body.encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request("http://127.0.0.1:8082" + path, data=data,
                                 headers=req_headers, method=method)
    try:
        with opener.open(req, timeout=10) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)

viewer = "Basic " + base64.b64encode(("viewer:" + vp).encode()).decode()
upload = "Bearer " + up

s_anon, _ = call("/api/overview")
s_view, h_view = call("/api/overview", {"Authorization": viewer})
s_up_meta, h_meta = call("/api/meta", {"Authorization": upload})
s_up_biz, _ = call("/api/overview", {"Authorization": upload})
s_view_meta, _ = call("/api/meta", {"Authorization": viewer})
s_view_pub, _ = call("/api/publish", {"Authorization": viewer}, method="PUT", body="{}")

store_view = "yes" if h_view.get("Cache-Control") == "no-store" else "no"
store_meta = "yes" if h_meta.get("Cache-Control") == "no-store" else "no"
print("PROBE_HTTP anon=%s view=%s upmeta=%s upbiz=%s viewmeta=%s viewpub=%s store_view=%s store_meta=%s"
      % (s_anon, s_view, s_up_meta, s_up_biz, s_view_meta, s_view_pub, store_view, store_meta))
'''


def probe_loopback(viewer_secret: str, upload_secret: str) -> None:
    script_b64 = base64.b64encode(PROBE_PY.encode("utf-8")).decode()
    cmd = "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % script_b64)
    payload = (viewer_secret + "\n" + upload_secret + "\n").encode("utf-8")
    res = remote_exec(cmd, stdin=payload, timeout=60)
    require_ok(res, "远端 probe")
    expected = ("anon=401 view=200 upmeta=200 upbiz=403 viewmeta=403 viewpub=403 "
                "store_view=yes store_meta=yes")
    line = next((ln.strip() for ln in res.text().splitlines() if ln.startswith("PROBE_HTTP ")), "")
    values = line.replace("PROBE_HTTP ", "")
    if values != expected:
        raise DeployError(f"凭证角色探针不满足预期（expected {expected}，got {values or '空'}）")
    log("[probe] 凭证角色符合预期（401/200/403 与 no-store）")


def https_role_probe(viewer_secret: str, upload_secret: str) -> None:
    viewer_auth = "Basic " + base64.b64encode(f"{VIEWER_USERNAME}:{viewer_secret}".encode()).decode()
    upload_auth = "Bearer " + upload_secret
    # 1) 先只读非业务 /api/meta：必须 200 且形状合法；若已发布且非本部署空冒烟 ID，
    #    立即停止——绝不先抓取 viewer 业务概览。
    s_meta, meta = https_get_json("/api/meta", upload_auth)
    if s_meta != 200:
        raise DeployError(f"HTTPS /api/meta 状态异常：{s_meta}")
    if not meta_shape_ok(meta):
        raise DeployError("版本元数据非法（HTTPS meta）")
    if meta.get("published") and meta.get("publicationId") != SMOKE_ID:
        raise DeployError("远端已发布非本部署冒烟内容；中止（不读取业务概览）")
    # 2) 角色探针（不跟随重定向）：anon=401 / viewer=200 / upload 业务=403。
    s_anon, _ = https_get_json("/api/overview", None)
    if s_anon != 401:
        raise DeployError(f"匿名访问应 401，实际 {s_anon}")
    s_view, view_data = https_get_json("/api/overview", viewer_auth)
    if s_view != 200 or not isinstance(view_data, dict):
        raise DeployError(f"viewer 访问应 200，实际 {s_view}")
    s_up, _ = https_get_json("/api/overview", upload_auth)
    if s_up != 403:
        raise DeployError(f"upload 访问业务应 403，实际 {s_up}")
    log(f"[probe-tls] meta={s_meta} anon={s_anon} viewer={s_view} upload_biz={s_up} "
        f"published={meta.get('published')} version={meta.get('currentVersion')}")


# ---------------------------------------------------------------------------
# checksums：只存 sha256；排除自有 vhost（仅此一个文件）；空/跳过哈希一律失败
# ---------------------------------------------------------------------------

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _remote_sha256(path: str) -> str:
    res = remote_exec(f"sha256sum {shlex.quote(path)}")
    if res.rc != 0 or res.timed_out:
        raise DeployError(f"无法计算配置摘要：{path}（不输出细节）")
    parts = res.text().split()
    digest = parts[0] if parts else ""
    if not _HEX64.match(digest):
        raise DeployError(f"配置摘要非法（非 64 位 hex）：{path}")
    return digest


def remote_conf_d_files() -> dict:
    """conf.d/*.conf 摘要 + 主配置 nginx.conf；key 为文件完整路径。
    仅精确排除自有托管 vhost 文件；列表为空/rc 失败/任一哈希失败都直接报错，绝不跳过。"""
    res = remote_exec(f"cd {shlex.quote(CONF_D)} && ls -1 *.conf")
    if res.rc != 0 or res.timed_out:
        raise DeployError("读取 conf.d 目录失败；不输出细节")
    names = sorted({ln.strip() for ln in res.text().splitlines() if ln.strip()})
    if not names:
        raise DeployError("conf.d 没有 *.conf；拒绝建立空基线")
    mapping: dict[str, str] = {}
    for name in names:
        full = CONF_D + "/" + name
        if full == VHOST_PATH:
            continue  # 仅允许自有托管 vhost 的新增/改动
        mapping[full] = _remote_sha256(full)
    # 主配置文件（不在 conf.d glob 内）必须存在并可哈希
    main_conf = MAIN_FILES[0]
    main_domain = MAIN_FILES[1]
    mapping[main_conf] = _remote_sha256(main_conf)
    if main_domain not in mapping:
        mapping[main_domain] = _remote_sha256(main_domain)
    return mapping


def load_baseline() -> dict | None:
    """本地基线：文件不存在返回 None；存在但非法 JSON/非对象/含非 64hex 值一律报错（绝不静默 None/重建）。"""
    if not os.path.exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        raise DeployError("本地基线文件存在但损坏/非法 JSON；人工核查后处理（绝不静默重建）") from None
    if not isinstance(data, dict) or not data:
        raise DeployError("本地基线文件为空或不是 JSON 对象；人工核查后处理（绝不静默重建）")
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, str) or not _HEX64.match(value):
            raise DeployError("本地基线内容非法（应为 路径->sha256 映射）；人工核查后处理")
    return data


def save_baseline(data: dict) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)


def checksums_verify() -> None:
    baseline = load_baseline()
    if baseline is None:
        raise DeployError("缺少基线（先运行 checksums save）；绝不静默生成新基线")
    current = remote_conf_d_files()
    if current == baseline:
        log("[checksums] 主配置摘要与基线一致")
        return
    added = sorted(k for k in current if k not in baseline)
    removed = sorted(k for k in baseline if k not in current)
    changed = sorted(k for k in baseline if k in current and baseline[k] != current[k])
    raise DeployError("nginx 主配置摘要与基线不一致；人工核查（新增: " + ",".join(added[:5]) +
                      "；删除: " + ",".join(removed[:5]) + "；改动: " + ",".join(changed[:5]) + "）")


# ---------------------------------------------------------------------------
# nginx vhost（只写自有托管文件；失败只回滚自己；超时不声称已回滚）
# ---------------------------------------------------------------------------

def vhost_initial_http() -> str:
    return "\n".join([
        VHOST_HEADER,
        "server {",
        "    listen 80;",
        "    server_name " + NGINX_HOST + ";",
        "    location ^~ /.well-known/acme-challenge/ {",
        "        alias " + CTR_ACME + "/.well-known/acme-challenge/;",
        "    }",
        "    location / { return 503; }",
        "}",
    ]) + "\n"


def vhost_https() -> str:
    return "\n".join([
        VHOST_HEADER,
        "server {",
        "    listen 80;",
        "    server_name " + NGINX_HOST + ";",
        "    location ^~ /.well-known/acme-challenge/ {",
        "        alias " + CTR_ACME + "/.well-known/acme-challenge/;",
        "    }",
        "    location / { return 308 https://$host$request_uri; }",
        "}",
        "",
        "server {",
        "    listen 443 ssl http2;",
        "    server_name " + NGINX_HOST + ";",
        "    ssl_certificate " + CTR_SSL + "/fullchain.pem;",
        "    ssl_certificate_key " + CTR_SSL + "/privkey.pem;",
        "    ssl_protocols TLSv1.2 TLSv1.3;",
        "    client_max_body_size 64m;",
        "    proxy_read_timeout 60s;",
        "    proxy_send_timeout 60s;",
        "    proxy_connect_timeout 60s;",
        "    location / {",
        "        proxy_pass http://127.0.0.1:8082;",
        "        proxy_set_header Host $host;",
        "        proxy_set_header Authorization $http_authorization;",
        "        proxy_set_header X-Forwarded-Proto $scheme;",
        "    }",
        "}",
    ]) + "\n"


def vhost_managed() -> bool:
    res = remote_exec(f"test -f {VHOST_PATH} && head -n 1 {VHOST_PATH}")
    return res.rc == 0 and res.text().strip() == VHOST_HEADER.strip()


def remote_write(path: str, content: bytes, mode: str = "600") -> None:
    """自有文件原子替换写入：写前复核非符号链接；mkstemp+os.replace（非固定 .tmp）。"""
    remote_no_symlink(path)
    remote_write_bytes(path, content, mode=int(mode, 8), exclusive=False)


def nginx_apply(content: str) -> None:
    """写自己的 vhost；先 nginx -t，失败才回滚自己的上一份。回滚结果必须确认成功，
    任何超时都视为状态不确定（绝不声称已回滚）。"""
    previous = None
    had_prev = remote_ok(f"test -f {shlex.quote(VHOST_PATH)}")
    if had_prev:
        prev_res = remote_exec(f"cat {shlex.quote(VHOST_PATH)}")
        require_ok(prev_res, "读取旧 vhost")
        previous = prev_res.out
    remote_write(VHOST_PATH, content.encode("utf-8"))
    test_res = remote_exec(f"docker exec {OPENRESTY_CONTAINER} nginx -t")
    if test_res.timed_out:
        raise DeployError("nginx -t 执行超时：vhost 状态不确定，需人工核查；未自动回滚/未触碰主配置")
    if test_res.rc != 0:
        if previous is not None:
            remote_write(VHOST_PATH, previous)  # 失败/超时即抛错，不会走到“已回滚”声明
        else:
            rm_res = remote_exec(f"rm -f {shlex.quote(VHOST_PATH)}")
            require_ok(rm_res, "回滚（删除自身 vhost）")
        raise DeployError("nginx -t 校验失败，已确认回滚自身 vhost")
    reload_res = remote_exec(f"docker exec {OPENRESTY_CONTAINER} nginx -s reload")
    if reload_res.timed_out:
        raise DeployError("nginx reload 超时：vhost 状态不确定，需人工核查")
    require_ok(reload_res, "nginx reload")


# ---------------------------------------------------------------------------
# ACME / challenge / TLS
# ---------------------------------------------------------------------------

def ensure_site_permissions() -> None:
    # 站点/ACME 需让 nginx worker 可读：0755；challenge 祖先目录一律位于
    # SITE_ACME/.well-known/acme-challenge（不是 SITE_ROOT/.well-known）；所有 chmod rc 必须通过。
    remote_no_symlink(SITE_ROOT)
    remote_no_symlink(SITE_ACME)
    remote_no_symlink(SITE_SSL)
    for p in (SITE_ROOT, SITE_ACME,
              SITE_ACME + "/.well-known",
              SITE_ACME + "/.well-known/acme-challenge"):
        res = remote_exec(f"mkdir -p {shlex.quote(p)} && chmod 0755 {shlex.quote(p)} && chown root:root {shlex.quote(p)}")
        require_ok(res, "站点/ACME 目录准备")
    # SSL 目录仅供 root（nginx master）读取；证书 key 600
    res = remote_exec(f"mkdir -p {shlex.quote(SITE_SSL)} && chmod 0700 {shlex.quote(SITE_SSL)} && chown root:root {shlex.quote(SITE_SSL)}")
    require_ok(res, "SSL 目录准备")


def challenge_probe() -> None:
    """创建随机自有 challenge token，同时验证容器内文件一致性 + 外部 HTTP 可达性，然后只删除自己的文件。"""
    token = "mrdeploy-" + secrets.token_hex(12)
    remote_path = SITE_ACME + "/.well-known/acme-challenge/" + token
    ctr_path = CTR_ACME + "/.well-known/acme-challenge/" + token
    content = "challenge-probe-" + token
    remote_no_symlink(remote_path)
    remote_write_bytes(remote_path, content.encode("utf-8"), mode=0o644, exclusive=True)
    try:
        host_res = remote_exec(f"cat {shlex.quote(remote_path)}")
        require_ok(host_res, "读取自有 token")
        ctr_res = remote_exec(f"docker exec {OPENRESTY_CONTAINER} cat {shlex.quote(ctr_path)}")
        require_ok(ctr_res, "容器内 token 读取")
        http_body = http_challenge_get(token)
        if (host_res.out != content.encode() or ctr_res.out != content.encode() or http_body != content.encode()):
            raise DeployError("challenge 文件一致性/HTTP 可达性校验失败")
        log("[tls-http] 自有 challenge 探测通过（host=container=http）")
    finally:
        remote_exec(f"rm -f {shlex.quote(remote_path)}")
        if remote_ok(f"test -e {shlex.quote(remote_path)}"):
            raise DeployError("自有 challenge token 清理失败，需人工删除（仅该文件）")


# 远端静态解析 acme 配置（只 select 4 个 hook 键，不 source/eval、不打印值）。
# 仅回传布尔/计数；Le_ReloadCmd 支持 acme.sh v3.1.4 的 base64 包装与明文等价两种写法。
_ACME_PARSE_SNIPPET = """import json, os, sys, base64
P = __DOMAIN__
G = __GLOBAL__
E = __EXPECTED__
KEYS = ("Le_PreHook", "Le_PostHook", "Le_RenewHook", "Le_ReloadCmd")
MS = "__ACME_BASE64__START_"
ME = "__ACME_BASE64__END_"


def summary(path):
    if not os.path.exists(path):
        return {"present": False}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        sys.exit(2)
    vals = {}
    for raw in text.splitlines():
        for k in KEYS:
            prefix = k + "="
            if raw.startswith(prefix):
                v = raw[len(prefix):].strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                    v = v[1:-1]
                vals[k] = v
    prepost = sum(1 for k in ("Le_PreHook", "Le_PostHook", "Le_RenewHook")
                  if vals.get(k, "") != "")
    rv = vals.get("Le_ReloadCmd")
    rp = rv is not None and rv != ""
    own = False
    if rp:
        if rv == E:
            own = True
        elif rv.startswith(MS) and rv.endswith(ME):
            b = rv[len(MS):len(rv) - len(ME)]
            try:
                own = base64.b64decode(b, validate=True).decode("utf-8") == E
            except Exception:
                sys.exit(3)
        else:
            sys.exit(3)  # 未知表达式/非法 reload 值
    return {"present": True, "prepost": prepost,
            "reload_present": rp, "reload_own": own}


print(json.dumps({"domain": summary(P), "global": summary(G)}))
"""


def acme_state_hook_safe() -> None:
    """acme.sh v3.1.4 hook 门禁（静态解析，绝不 source/eval 或打印值）：
    - 只选择 4 个 hook 键：Le_PreHook / Le_PostHook / Le_RenewHook / Le_ReloadCmd；
    - 新域 conf（仅 workbench 本域）与全局 account.conf 分开判定：
      任何非空 pre/post/renew → STOP；全局任何非空 Le_*（含 reload）→ STOP（怕继承无关 hook）；
      新域 Le_ReloadCmd 仅当 UTF-8 解码后字节 == ACME_RELOADCMD 才放行（允许旧式明文等价形式）；
    - 空 hook 值放行；不可读/格式非法/非法 base64/查询失败 → 固定错误 STOP，绝不跳过；
    - 远端仅回传 bool/计数，不回传原始值；绝不读取主域 conf、account key 或主域私钥。"""
    domain_conf = ACME_DOMAIN_DIR + "/" + NGINX_HOST + ".conf"
    template = _ACME_PARSE_SNIPPET.replace("__DOMAIN__", repr(domain_conf)) \
                                   .replace("__GLOBAL__", repr(ACME_GLOBAL)) \
                                   .replace("__EXPECTED__", repr(ACME_RELOADCMD))
    b64 = base64.b64encode(template.encode("utf-8")).decode("ascii")
    cmd = "python3 -c " + shlex.quote("import base64;exec(base64.b64decode('%s'))" % b64)
    res = remote_exec(cmd)
    if res.rc == 2:
        raise DeployError("acme 配置文件存在但不可读；停止（不输出细节）")
    if res.rc == 3:
        raise DeployError("acme 配置解析失败/非法编码/非法表达式；停止（不输出细节）")
    if res.rc != 0 or res.timed_out:
        raise DeployError("acme 配置读取失败；停止（不输出细节）")
    try:
        parsed = json.loads(res.out.decode("utf-8", "replace"))
    except ValueError:
        raise DeployError("acme 状态解析异常；停止（不输出细节）")
    g = parsed.get("global") if isinstance(parsed, dict) else None
    d = parsed.get("domain") if isinstance(parsed, dict) else None
    if not isinstance(g, dict) or not isinstance(d, dict):
        raise DeployError("acme 状态结构异常；停止（不输出细节）")
    if not g.get("present"):
        raise DeployError("acme 全局 account.conf 缺失；停止（不输出细节）")
    # 全局：任何非空 hook（含 reload）都可能是其它域继承的 → 一律 STOP
    if g.get("prepost") or g.get("reload_present"):
        raise DeployError("acme 全局 account.conf 含非空 hook；停止待父复核（不打印 hook 名/值）")
    if not d.get("present"):
        return
    if d.get("prepost"):
        raise DeployError("新域 acme conf 含 pre/post/renew hook；停止待父复核（不打印 hook 名/值）")
    if d.get("reload_present"):
        if not d.get("reload_own"):
            raise DeployError("新域 acme reload hook 与本部署不一致；停止待父复核（不打印 hook 值）")
        log("[preflight] 新域 acme reload hook=本部署（续期可用；不打印内容）")
    else:
        log("[preflight] 新域 acme conf 存在且无 reload hook（不打印内容）")


def issue_acme() -> None:
    ensure_site_permissions()
    res = remote_exec(
        f"set -eu; {ACME_SH} --issue --server letsencrypt -d {NGINX_HOST} "
        f"--webroot {shlex.quote(SITE_ACME)} --keylength ec-256",
        timeout=600,
    )
    if res.timed_out:
        raise DeployError("acme issue 超时：新域证书状态未知，人工核查后重试")
    if res.rc != 0:
        raise DeployError("acme issue 失败（不输出日志以免含账号/域信息），请按 runbook 人工核查")
    install = remote_exec(
        f"set -eu; {ACME_SH} --install-cert --ecc -d {NGINX_HOST} "
        f"--key-file {shlex.quote(SITE_SSL + '/privkey.pem')} "
        f"--fullchain-file {shlex.quote(SITE_SSL + '/fullchain.pem')} "
        f"--reloadcmd {shlex.quote(ACME_RELOADCMD)}",
        timeout=300,
    )
    if install.rc != 0:
        raise DeployError("acme install-cert 失败；请按 runbook 人工核查（不动主域配置）")
    # chmod 结果必须逐条确认（不得用 `|| true` 吞掉失败）
    for f, mode in (("fullchain.pem", "0644"), ("privkey.pem", "0600")):
        res = remote_exec(f"chmod {mode} {shlex.quote(SITE_SSL)}/{f}")
        require_ok(res, "证书文件权限设置")
    log("[acme] 证书已安装")


def cert_present() -> bool:
    return remote_ok(f"test -s {shlex.quote(SITE_SSL)}/fullchain.pem && test -s {shlex.quote(SITE_SSL)}/privkey.pem")


# ---------------------------------------------------------------------------
# 空集合冒烟（精确 publicationId 相等 + CAS；绝不覆盖真实数据）
# ---------------------------------------------------------------------------

def empty_snapshot() -> dict:
    statuses = ["pending_entry", "pending_execution", "executing", "under_repair",
                "pending_acceptance", "pending_invoice", "completed"]
    return {
        "schemaVersion": 1,
        "contentGenerationId": "deploy-smoke-generation-empty",
        "businessRevision": 0,
        "dataAsOf": "2026-01-01T00:00:00.000Z",
        "overview": {
            "metrics": {"totalProjects": 0, "activeProjects": 0, "pendingAmount": "0.00",
                        "pendingAcceptance": 0, "pendingInvoice": 0},
            "stages": [{"status": s, "count": 0, "averageDays": 0} for s in statuses],
        },
        "projects": [],
    }


def _verify_empty_overview(viewer_auth: str, expect_meta: dict) -> None:
    """业务 overview 读取仅在已确认本部署空冒烟后执行；校验查询 metadata 与 meta 完全一致 + total=0。"""
    s_view, data = https_get_json("/api/overview", viewer_auth)
    if s_view != 200:
        raise DeployError(f"读取 overview 失败 HTTP {s_view}")
    if not isinstance(data, dict):
        raise DeployError("overview 响应非 JSON 对象；中止")
    om = data.get("metadata")
    payload = data.get("data")
    if not isinstance(om, dict) or not isinstance(payload, dict):
        raise DeployError("overview 响应缺少 metadata/data；中止")
    overview = payload.get("overview")
    metrics = overview.get("metrics") if isinstance(overview, dict) else None
    total = metrics.get("totalProjects") if isinstance(metrics, dict) else None
    if not isinstance(total, int) or total != 0:
        raise DeployError("远端存在业务项目数据，中止（绝不覆盖真实发布）")
    if (om.get("currentVersion") != expect_meta.get("currentVersion")
            or om.get("publicationId") != expect_meta.get("publicationId")):
        raise DeployError("overview 查询元数据与 meta 不一致；中止")


def smoke(upload_secret: str, viewer_secret: str) -> None:
    viewer_auth = "Basic " + base64.b64encode(f"{VIEWER_USERNAME}:{viewer_secret}".encode()).decode()
    upload_auth = "Bearer " + upload_secret
    s_meta, meta = https_get_json("/api/meta", upload_auth)
    if s_meta != 200:
        raise DeployError(f"冒烟 meta HTTP {s_meta}")
    if not meta_shape_ok(meta):
        raise DeployError("版本元数据非法，中止冒烟")
    if meta.get("published"):
        if meta.get("publicationId") != SMOKE_ID:
            raise DeployError("远端已存在非冒烟发布内容（publicationId 不一致），中止")
        _verify_empty_overview(viewer_auth, meta)
        log(f"[smoke] 已是本部署空冒烟发布：published={meta.get('published')} "
            f"version={meta.get('currentVersion')} → already_done（不重复 PUT）")
        return
    # 未发布：以当前 version 为 CAS 提交空快照
    expected_version = meta["currentVersion"]  # meta_shape_ok 已保证 int>=0
    body = json.dumps({"protocol": {"publicationId": SMOKE_ID,
                                    "expectedCurrentVersion": expected_version},
                       "snapshot": empty_snapshot()}, separators=(",", ":")).encode("utf-8")
    status, _ = curl_request(f"https://{NGINX_HOST}/api/publish", 443, "PUT", upload_auth, body)
    if status == 409:
        raise DeployError("冒烟发布冲突（409：远端已前进）；安全中止，不重复 PUT、不覆盖")
    if status != 200:
        raise DeployError(f"冒烟发布异常 HTTP {status}")
    s_after, after = https_get_json("/api/meta", upload_auth)
    if s_after != 200:
        raise DeployError("冒烟后 meta 读取失败")
    if not meta_shape_ok(after):
        raise DeployError("冒烟后元数据非法；中止")
    if after.get("publicationId") != SMOKE_ID:
        raise DeployError("冒烟后 publicationId 与候选不一致；中止")
    if after.get("currentVersion") != expected_version + 1:
        raise DeployError("冒烟后 currentVersion 未精确 +1；中止")
    _verify_empty_overview(viewer_auth, after)
    log(f"[smoke] 空集合冒烟完成 published={after.get('published')} "
        f"version={after.get('currentVersion')}")


# ---------------------------------------------------------------------------
# CLI 子命令
# ---------------------------------------------------------------------------

def cmd_preflight(_args) -> int:
    # 本地镜像 ID 必须精确匹配基线（在预检即确认；install 传镜像前再确认一次）
    if local_image_id() != EXPECTED_IMAGE_ID:
        raise DeployError("本地镜像 ID 与基线不一致；拒绝")
    remote_exec("docker info >/dev/null")
    names = remote_true("docker ps -a --format '{{.Names}}'")
    if CONTAINER in names.splitlines():
        raise DeployError("远端已存在容器；请人工确认（脚本不删除/覆盖）")
    if not remote_ok(f"docker ps --format '{{{{.Names}}}}' | grep -qx {shlex.quote(OPENRESTY_CONTAINER)}"):
        raise DeployError("OpenResty 容器未运行")
    if not remote_ok(f"test -x {ACME_SH}"):
        raise DeployError("acme.sh 不可执行")
    if not remote_ok("command -v python3"):
        raise DeployError("远端缺 python3")
    acme_state_hook_safe()
    for p in (VHOST_PATH, SITE_ROOT, SITE_ACME, SITE_SSL, SITE_MARKER_FILE,
              REMOTE_BASE, REMOTE_DATA_DIR, MARKER_FILE, REMOTE_CREDENTIALS):
        remote_no_symlink(p)
    if remote_ok(f"test -e {VHOST_PATH}") and not vhost_managed():
        raise DeployError("远端存在非托管 vhost；拒绝（人工确认后处理）")
    if remote_ok(f"test -e {SITE_ROOT}") and not site_managed():
        raise DeployError("站点目录已存在且非本部署托管（缺精确托管标记）；拒绝")
    if remote_ok(f"test -e {REMOTE_BASE}"):
        require_marker()
    port_res = remote_exec(
        "python3 -c \"import socket; s=socket.socket(); r=s.connect_ex(('127.0.0.1',8082)); "
        "print('used' if r == 0 else 'free'); s.close()\"")
    if port_res.text().strip() != "free":
        raise DeployError("8082 端口被占用")
    if remote_ok(f"docker ps -a --format '{{{{.Names}}}}' | grep -qx {shlex.quote(CONTAINER)}"):
        if not container_state_ok():
            raise DeployError("已有容器配置不满足安全 allowlist（不 delete/update）")
    log("[preflight] 预检通过（只读；基线记录请另行执行 checksums save，本阶段不写任何文件）")
    return 0


def cmd_credentials(args) -> int:
    if remote_ok(f"test -e {REMOTE_BASE}"):
        require_marker()
    existing = read_remote_credentials()
    if existing is not None:
        if not args.reuse:
            raise DeployError("远端已有摘要文件；需显式 --reuse 且密钥一致才可继续（不覆盖未知内容）")
        viewer = keychain_get(VIEWER_SERVICE, VIEWER_ACCOUNT)
        upload = keychain_get(UPLOAD_SERVICE, UPLOAD_ACCOUNT)
        if creds_matches_secret(existing, viewer, upload):
            log("[credentials] 远端摘要与 Keychain 密钥一致（复用既有条目与摘要，不重新生成）")
            return 0
        raise DeployError("远端摘要与 Keychain 不一致；未覆盖（轮换需独立授权阶段）")
    if not args.reuse:
        if keychain_exists(VIEWER_SERVICE, VIEWER_ACCOUNT) or keychain_exists(UPLOAD_SERVICE, UPLOAD_ACCOUNT):
            raise DeployError("本机 Keychain 已存在条目（未 --reuse）；请人工确认或使用 --reuse")
    viewer = ensure_keychain(args.reuse, VIEWER_SERVICE, VIEWER_ACCOUNT, generate_viewer_password)
    upload = ensure_keychain(args.reuse, UPLOAD_SERVICE, UPLOAD_ACCOUNT, generate_upload_token)
    creds = build_new_credentials(viewer, upload)
    write_credentials_remote(creds)
    log("[credentials] 完成（仅摘要落盘；Keychain 条目保留）")
    return 0


def cmd_install(_args) -> int:
    require_marker()
    if local_image_id() != EXPECTED_IMAGE_ID:
        raise DeployError("本地镜像 ID 与基线不一致（传镜像前再次确认）；拒绝")
    if not remote_ok(f"test -s {REMOTE_CREDENTIALS}"):
        raise DeployError("缺少远端摘要；先运行 credentials")
    transfer_image()
    run_container()
    log("[install] 完成")
    return 0


def cmd_probe(_args) -> int:
    viewer = keychain_get(VIEWER_SERVICE, VIEWER_ACCOUNT)
    upload = keychain_get(UPLOAD_SERVICE, UPLOAD_ACCOUNT)
    probe_loopback(viewer, upload)
    return 0


def cmd_checksums(args) -> int:
    if args.action == "save":
        current = remote_conf_d_files()
        existing = load_baseline()
        if existing and existing != current:
            raise DeployError("已存在不同基线；如需新建请先人工复核/删除本地基线文件（不用部署后覆盖来掩盖变更）")
        save_baseline(current)
        log("[checksums] 基线已保存（sha256，排除自有 vhost）")
        return 0
    checksums_verify()
    return 0


def cmd_tls_http(_args) -> int:
    if remote_ok(f"test -e {VHOST_PATH}") and not vhost_managed():
        raise DeployError("已有非托管 vhost；拒绝")
    if remote_ok(f"test -e {SITE_ROOT}") and not site_managed():
        raise DeployError("站点目录已存在但非本部署托管（缺精确托管标记）；拒绝写入")
    ensure_site_permissions()
    if not remote_file_exists(SITE_MARKER_FILE):
        # 站点托管标记：精确固定内容 + 原子新建（绝不空 touch；不接管无标记目录）
        remote_no_symlink(SITE_MARKER_FILE)
        remote_write_bytes(SITE_MARKER_FILE, (SITE_MARKER_VALUE + "\n").encode("utf-8"),
                           mode=0o600, exclusive=True)
    if not vhost_managed():
        nginx_apply(vhost_initial_http())
    challenge_probe()
    log("[tls-http] 初始 vhost 就绪且 challenge 可达")
    return 0


def cmd_acme(_args) -> int:
    if not vhost_managed():
        raise DeployError("先运行 tls-http")
    if remote_ok(f"test -e {SITE_ROOT}") and not site_managed():
        raise DeployError("站点目录非本部署托管；拒绝签发")
    if cert_present():
        log("[acme] 证书已存在；跳过（不重复签发）")
        return 0
    ensure_site_permissions()
    issue_acme()
    if not cert_present():
        raise DeployError("证书文件未生成")
    log("[acme] 完成")
    return 0


def cmd_tls_https(_args) -> int:
    if not vhost_managed():
        raise DeployError("vhost 非托管")
    if not cert_present():
        raise DeployError("先运行 acme")
    nginx_apply(vhost_https())
    log("[tls-https] 完成")
    return 0


def cmd_probe_tls(args) -> int:
    viewer = keychain_get(VIEWER_SERVICE, VIEWER_ACCOUNT)
    upload = keychain_get(UPLOAD_SERVICE, UPLOAD_ACCOUNT)
    https_role_probe(viewer, upload)
    return 0


def cmd_smoke(args) -> int:
    viewer = keychain_get(VIEWER_SERVICE, VIEWER_ACCOUNT)
    upload = keychain_get(UPLOAD_SERVICE, UPLOAD_ACCOUNT)
    smoke(upload, viewer)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deploy-mobile-readonly", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("preflight")
    cred = sub.add_parser("credentials")
    cred.add_argument("--reuse", action="store_true")
    sub.add_parser("install")
    sub.add_parser("probe")
    cs = sub.add_parser("checksums")
    cs.add_argument("action", choices=["save", "verify"])
    sub.add_parser("tls-http")
    sub.add_parser("acme")
    sub.add_parser("tls-https")
    sub.add_parser("probe-tls")
    sub.add_parser("smoke")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    handlers = {
        "preflight": cmd_preflight, "credentials": cmd_credentials, "install": cmd_install,
        "probe": cmd_probe, "checksums": cmd_checksums, "tls-http": cmd_tls_http,
        "acme": cmd_acme, "tls-https": cmd_tls_https, "probe-tls": cmd_probe_tls,
        "smoke": cmd_smoke,
    }
    try:
        return int(handlers[args.command](args) or 0)
    except DeployError as err:
        print(f"[deploy] 中止：{err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
