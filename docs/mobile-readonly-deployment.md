# 移动只读发布 · 云端部署（mobile-readonly-deployment）

> 本文档与 `scripts/deploy-mobile-readonly.py` 配套（openspec tasks 9.x 部署闸门 / D9）。
> **状态：生产已上线（2026-09-09，部分完成）** —— 凭据/首容器/loopback 角色/HTTP-01 证书/TLS/首份空冒烟
> 已按本 runbook 执行并回填证据（§8）；任务 9.1/9.2 已勾选，Windows 首次真实业务发布、实体手机验收与
> **凭证轮换** 仍未完成（§9「人工待办」，任务 9.3/9.4 保持未勾选）。站点为独立 vhost + acme.sh 托管，
> **未**登记为 1Panel GUI 同域站点/证书（SSH 路径为权威）；本运行未读取安全组规则 API、无任何
> DNS/安全组/防火墙写入。
> 本机私有查看口令/上传 token **永不写入本文件**（见「凭据」）；本文件不含任何 secret。

## 0. 已核验环境事实（据上线前勘察，勿在脚本外改动）

- 远端：`ssh root@aliyun`（BatchMode、ConnectTimeout 10、StrictHostKeyChecking=yes），
  `8.162.13.22:22`，主机名 `iZn4ag1sme72dafucqhgrxZ`，Linux x86_64，Docker 26.1.3，
  磁盘约 30GB 可用、2 CPU / 3.7GB RAM。
- OpenResty 容器：`1Panel-openresty-E57G`（host 网络 80/443）。nginx 主机侧配置根
  `/opt/1panel/apps/openresty/openresty/conf`（含 `conf.d/*.conf`）；站点文件主机侧根
  `/opt/1panel/apps/openresty/openresty/www/sites` 挂载到容器 `/www/sites`。
- 现有站点仅 `michaelli.site` 主域；其 default/main 配置与证书**绝不改动**（脚本只做 sha256 前后基线核对）。
- 目标：`workbench.michaelli.site`（A 记录已指向 8.162.13.22）；端口 8082 空闲。
- acme.sh：`/root/.acme.sh/acme.sh`（root cron，支持 HTTP-01 与主域既有证书）。绝不读取/复制其 account key 或主域私钥。
- 本地镜像（已核验，勿被替换）：`relocation-mobile-readonly:1766c8f-amd64`
  ID `sha256:ed23404960a08f17a91ef743156e15591ef038aba6c96402e53a498ebf0a1273`（linux/amd64）。
- 既有 petcare 等第三方容器一律不动；脚本仅创建/管理自身命名资源。

## 1. 脚本阶段（幂等、可重复、只写自有资源）

每个阶段必须先 `python3 -m py_compile scripts/deploy-mobile-readonly.py`，并由部署负责人确认；本机对远端只执行下表明确声明路径。

| 阶段 | 作用 | 远端写入（仅自有） |
|---|---|---|
| `preflight` | 本地镜像 ID 精确校验、远端 docker/openresty/acme/python3 就绪、8082 空闲、自建目录/容器/vhost 冲突与符号链接检查（悬空链接也拒绝） | 无（纯只读；**不保存任何基线**） |
| `checksums save` | 在 credentials/install **之前**显式建立 nginx 主配置 sha256 基线（空列表/任一哈希失败即报错；仅排除自有 vhost 一个文件） | 仅本地状态文件（显式 save 才建目录） |
| `credentials [--reuse]` | 本机 Keychain 新建/复用 viewer/upload 两条目，本地派生 scrypt 摘要并写入服务器（远程摘要文件已存在但非法/不可读 → 直接中止，不生成/不覆盖） | `/opt/relocation-mobile-readonly/{.deploy-managed,data/credentials.json}` |
| `install` | `docker save \| ssh docker load`（无 registry），本地镜像 ID 精确校验（传镜像前再次校验），受限运行容器 | `/opt/relocation-mobile-readonly/data/**`（容器运行数据） |
| `probe` | 远端 python 对 `127.0.0.1:8082` 做无凭证 401 / viewer 200 / upload 仅 meta / upload 禁业务检查 | 无 |
| `checksums verify` | nginx 主配置 sha256 与基线比对（含新增/删除/改动全部列出；自有 vhost 精确排除） | 仅本地读取 |
| `tls-http` | 初始 80 vhost（仅 ACME challenge + 503） | 新 vhost `conf.d/workbench.michaelli.site.conf`（托管头）；`…/www/sites/workbench.michaelli.site/`（含固定内容标记 `acme/.well-known/acme-challenge`） |
| `acme` | 独立签发/安装 LE ECC 证书到新 SSL 目录（hook 门禁只放行本部署 reload 值） | `…/sites/workbench.michaelli.site/ssl/{fullchain.pem,privkey.pem}` |
| `tls-https` | vhost 替换为 308 跳转 + 443 HTTPS 反代（`nginx -t` 失败自动回滚自己的 vhost；回滚结果必须确认） | 同一 vhost 文件 |
| `probe-tls` | 先 `/api/meta`（upload）形状校验；已发布且非本部署空冒烟 ID 立即停止；随后角色 401/200/403 | 无 |
| `smoke` | 仅当「从未发布」或「本部署托管空冒烟且业务计数=0」时发布**空集合**快照；CAS 冲突(409)安全中止 | 业务侧：`/api/publish`（空快照，无真实数据） |

冒烟发布物：空 `projects:[]`、metrics 全零、stages 零计数（schemaVersion=1）。若远端已有任何非托管 publicationId
或业务计数 >0，脚本安全中止且不覆盖；客户端后续首次真实发布会全量替换。

### 建议执行序列（部署负责人确认后逐条）

```bash
python3 -m py_compile scripts/deploy-mobile-readonly.py
python3 scripts/deploy-mobile-readonly.py preflight        # 只读；不保存基线
python3 scripts/deploy-mobile-readonly.py checksums save   # 先建主配置基线（credentials/install 之前）
python3 scripts/deploy-mobile-readonly.py credentials      # 首次新建两条目；重跑需 --reuse
python3 scripts/deploy-mobile-readonly.py install
python3 scripts/deploy-mobile-readonly.py probe
python3 scripts/deploy-mobile-readonly.py checksums verify # 主配置应仍与基线一致（自有 vhost 已排除）
python3 scripts/deploy-mobile-readonly.py tls-http
python3 scripts/deploy-mobile-readonly.py acme
python3 scripts/deploy-mobile-readonly.py tls-https
python3 scripts/deploy-mobile-readonly.py checksums verify # 部署前后核对（新增/删除/改动全列出）
python3 scripts/deploy-mobile-readonly.py probe-tls
python3 scripts/deploy-mobile-readonly.py smoke            # 空集合冒烟（可选、显式）
```

## 2. 凭据（本机 Keychain；绝不落明文文件/聊天/日志/argv）

新建两条 macOS Keychain generic-password（经 `/usr/bin/security -i` 交互 stdin，**禁用 `-w` argv 明文**）：

| 用途 | Service | Account |
|---|---|---|
| 查看 Basic Auth | `relocation-workbench:workbench.michaelli.site:viewer` | `viewer` |
| 上传 Bearer | `relocation-workbench:workbench.michaelli.site:upload` | `publisher` |

实测交互行为（脚本按此实现，勿改为带 `quit` 的会话）：
- `security -i` 的 stdin 为**一条完整命令 + 换行 + EOF**（如
  `add-generic-password -a viewer -s <service> -w <secret>`），不要追加 `quit`（会被当作 unknown command 掩盖成功 rc）。
- 重复 `add`（无 `-U`）返回 rc45 且**不覆盖**既有条目；缺失查询 `find` 返回 rc44；
  `find … -w` 成功时 stdout 为裸值 + 换行（rc0）。所有输出均捕获不回显。

- 长度：viewer 密码 `token_urlsafe(32)`、upload token `token_urlsafe(48)`，均为随机本地生成。
- 服务器只收到 scrypt 摘要 JSON（`credentials.json`，mode 600，owner 1000:1000）；
  摘要格式与 `src/server/mobile-readonly/credentials.ts` 完全一致（N=16384 r=8 p=1 keyLen=64）。
- 脚本先探测同名条目：存在且未 `--reuse` → 中止（绝不静默覆盖）；`--reuse` 复用时先验证可读（Keychain 解锁）再使用，
  并按既有摘要的 salt/参数在内存重算比对，不生成/覆盖新摘要。
- 远端摘要文件已存在但**不可读/非 JSON/非对象** → 在 Keychain 生成与写入前即中止（绝不落到覆盖路径）；
  新摘要安装只走「远端原子新建（mkstemp+fsync+硬链接 no-overwrite）」，绝不用 `mv -f` 覆盖既有文件。
- 远端任一步失败：保留 Keychain 条目以便续跑，**绝不删除已使用的凭据记录**。
- Keychain 不可用/锁定 = blocker；脚本无明文回退，人工解锁后重跑。

个人私密取回命令（仅在私人终端执行；**绝不可粘贴到聊天/共享环境**）：

```bash
security find-generic-password -s 'relocation-workbench:workbench.michaelli.site:viewer' -a viewer -w
security find-generic-password -s 'relocation-workbench:workbench.michaelli.site:upload' -a publisher -w
```

## 3. 容器（仅自有资源；受限运行）

- 名称：`relocation-mobile-readonly`；数据路径：`/opt/relocation-mobile-readonly`
  （`data/` 挂载到容器 `/var/lib/mobile-readonly`，rw 仅此自有目录）。
- 镜像内 Node 用户 uid 1000：以 `--user 1000:1000` 运行；不创建宿主机账号。
- 参数：`--restart unless-stopped`、`-p 127.0.0.1:8082:8082`（仅 loopback）、`--read-only`、
  `--tmpfs /tmp:rw,noexec,nosuid,size=16m`、`--cap-drop ALL`、`--security-opt no-new-privileges`、
  `--pids-limit 128`、`--memory 512m`、`--cpus 0.5`、`--log-opt max-size=10m` + `--log-opt max-file=3`。
- OpenResty（host 网络）经 loopback `127.0.0.1:8082` 反代；无需 host 网络/共享内部网络。
- 容器复用校验：单次 `docker inspect` 完整 JSON 逐项 allowlist（镜像 ID/User=1000:1000/ReadonlyRootfs/CapDrop
  =ALL/SecurityOpt no-new-privileges/Memory 512m/NanoCpus 0.5/PidsLimit 128/RestartPolicy unless-stopped/
  LogConfig 10m×3/PortBindings 仅 127.0.0.1:8082/Binds=null）；真实挂载层校验为
  **顶层 `Mounts` 恰有一个自有 data bind**（Source=…/data、Dest=/var/lib/mobile-readonly、RW=true，允许至多一项纯 tmpfs /tmp）
  且 **`HostConfig.Tmpfs` 单独含 `/tmp:rw,noexec,nosuid,size=16m`**（tmpfs 不在顶层 Mounts 上依赖；
  docker 默认 /etc 挂载不作为放行依据）；任一不符即 STOP（不 delete/update、不打印 Env/原始 inspect）。

## 4. TLS（独立新 vhost/证书，不动主域）

- 新 ACME webroot（host）：`/opt/1panel/apps/openresty/openresty/www/sites/workbench.michaelli.site/acme`
  （容器侧 `/www/sites/workbench.michaelli.site/acme`）。**不使用主域 webroot**；challenge 祖先目录一律
  `SITE_ACME/.well-known/acme-challenge`（0755，全部 rc 校验，不创建 `SITE_ROOT/.well-known`）。
- 新证书目录（host）：同站点下 `ssl/`（容器侧 `/www/sites/…/ssl`）；fullchain/privkey mode 0644/0600，chmod rc 必须通过（无 `|| true`）。
- 站点/数据目录托管标记 `.deploy-managed` 均为**固定内容**文件（site: `relocation-mobile-readonly-site`；
  data: `relocation-mobile-readonly`），绝不空 touch；缺失/内容不一致即拒绝接管。
- 顺序：`tls-http`（只 challenge + 503）→ `acme`（`acme.sh --issue --server letsencrypt
  --webroot <HOST_ACME> --keylength ec-256` + `--install-cert --ecc`）→ `tls-https`。
- 若 acme.sh 提示需要注册邮箱/新 ToS 同意：**停止**并人工处理，不随机邮箱、不自动接受未知条款。
- `--reloadcmd` 使用 `docker exec … nginx -t && docker exec … nginx -s reload`；脚本内 nginx -t 失败会
  自动回滚自己的 vhost（回滚结果必须确认成功；超时视为状态不确定不声称已回滚）。主域/default 配置前后 sha256 核对必须一致。
- preflight 的 acme hook 门禁（acme.sh v3.1.4 事实适配）只对 4 个真实 hook 键做静态解析
  `Le_PreHook / Le_PostHook / Le_RenewHook / Le_ReloadCmd`（不 source/eval、不打印值、不读 account key/主域私钥）：
  - 全局 `account.conf` 出现任何非空 `Le_*` hook（含 reload，可能由其它域继承）→ 停止待部署负责人确认；
  - 新域 conf（仅 workbench 本域）出现非空 pre/post/renew → 停止；`Le_ReloadCmd` 仅当 UTF-8 解码后
    恰等于本部署 `--reloadcmd` 才放行（支持 acme 的 `__ACME_BASE64__START_…__ACME_BASE64__END_` 包装及明文等价旧式写法），
    续期后可再次 preflight；非法 base64/未知表达式/文件不可读 → 固定错误停止，绝不跳过。
- 最终 vhost：HTTP 仅 challenge + 308 跳转；443 ssl http2、TLSv1.2/1.3、`client_max_body_size 64m`、
  反代超时 60s，`proxy_set_header Host/Authorization/X-Forwarded-Proto`；不缓存、不改写 URI；
  不关闭 access_log（避免误关审计）。
- 证书续期由既有 acme cron 沿用 `--reloadcmd` 完成；不修改全局默认 CA 或主域续期配置。

## 5. 安全与探测原则

- 服务器只存摘要；日志无业务内容/密钥；错误不原样回显远端响应正文（响应/正文只在内存，不落临时文件）。
- 探针只读状态/版本/计数；`probe-tls` 先校验 `/api/meta`（200+形状），已发布且非本部署空冒烟 ID 时
  **不读取 viewer 业务概览**即停止；随后角色 anon=401/viewer=200/upload 业务=403 全量校验。
- 冒烟仅当远端从未发布（CAS=当前版本），或已是本托管空冒烟且业务计数=0——否则中止；
  上传返回 409 视为冲突安全中止；成功后再 GET meta 精确核对 ID 且版本 +1，并校验 overview 查询元数据与 meta 一致才宣布成功。
- 本地 curl/urllib 一律默认证书校验（无 `-k`/`-L`）；`curl` 调用固定 `curl -q --config -`（config 走 stdin），
  认证头/正文经 json.dumps 转义内联，绝不进 argv；探测不打印 Authorization 头与响应正文。

## 6. 计划新增远端资源清单（全部为新命名自有资源）

- 目录：`/opt/relocation-mobile-readonly/{,data}`（+ 标记 `.deploy-managed`）
- 站点/证书：`/opt/1panel/apps/openresty/openresty/www/sites/workbench.michaelli.site/{acme,ssl,.deploy-managed}`
- vhost：`/opt/1panel/apps/openresty/openresty/conf/conf.d/workbench.michaelli.site.conf`
- 容器：`relocation-mobile-readonly`（loopback 127.0.0.1:8082）
- acme 新域状态：`/root/.acme.sh/workbench.michaelli.site_ecc/**`（仅本域；preflight 只静态解析 4 个真实 hook 键而不打印值：
  全局 account.conf 任何非空 hook 停止；新域仅放行 UTF-8 解码后恰等于本部署 `--reloadcmd` 的 `Le_ReloadCmd`，
  其它非空 hook/非法 base64/不可读 一律停止待部署负责人确认）
- 本地 Keychain：上文两条 generic-password

## 7. 回滚（仅自身资源；保留数据与 Keychain）

- 停用/移除容器与绑定：`docker stop/rm relocation-mobile-readonly`（不动 `data/`）。
- 恢复 vhost：脚本托管头文件可直接移除（nginx -t 后 reload）或从 `/root/mobile-readonly-backups/`
  恢复脚本阶段自己的备份（若有）；**不触碰** michaelli.site/default 配置与证书。
- 数据：`/opt/relocation-mobile-readonly/data` 保留（可复用续跑；credentials.json 仅摘要）。
- 本机 Keychain 两条目保留（供重部署续用或轮换授权阶段）。
- 说明：云端服务本就只保留当前一份 `current.json`，回滚不宣称保留业务快照历史。

## 8. 生产证据模板（2026-09-09 实测回填；未执行为 PENDING/待部署负责人确认）

| 项目 | 预期 | 结果 |
|---|---|---|
| 本地镜像 ID | `sha256:ed23404960a08f17a91ef743156e15591ef038aba6c96402e53a498ebf0a1273` | DONE（tag `relocation-mobile-readonly:1766c8f-amd64`，linux/amd64；desktop UI 后续 8fd445d 不影响 server/web） |
| 远端镜像 ID | 同上（load 后 inspect 一致） | DONE（direct `docker save \| ssh docker load`，无公开 registry） |
| 容器 | `relocation-mobile-readonly` running、受限参数齐全 | DONE（user 1000:1000、read-only、cap-drop ALL、no-new-privileges、512MiB、0.5 CPU、128 pids、log 3×10MiB、restart unless-stopped、bind 127.0.0.1:8082 仅此端口、data rw 目录 700/凭证 600） |
| probe（loopback） | anon=401、viewer=200、upload_meta=200、upload 业务=403 | DONE |
| nginx 主配置 sha256 前后 | 一致 | DONE（4 份主配置基线不变；root cron 与 petcare 等既有容器未动） |
| 证书 | LE ECC、SAN 仅 `workbench.michaelli.site`、有效期内 | DONE（acme.sh v3.1.4 HTTP-01 standalone 新域，SAN 仅 workbench，有效期至 2026-12-08、LE Y1；privkey 600/fullchain 644/ssl 目录 700；公私钥哈希匹配；主域证书未改） |
| probe-tls | anon=401、viewer=200、published/版本合理 | DONE（正常 LE 信任，curl-json/redirect no-follow 通过；HTTP-01 challenge host=容器=外部一致后 308→HTTPS，仅优雅 reload、无容器重启） |
| smoke（空集合） | 仅空数据；返回 metadata/version | DONE（首版 415 缺 JSON Content-Type 已修并有回归断言；重试 CAS 0→V1 空集合、受管 SMOKE_ID、全指标/项目 0；真实生产 HTTPS 390px Playwright 截图 V1 空数据 10 项 DOM 断言通过，本地 DNS 映射非 TLS 绕过） |
| DNS（workbench.michaelli.site） | A `8.162.13.22`、TTL 600（权威 10 分钟）；无 AAAA/CNAME | DONE（2026-09-09 实测：权威 NS `dns31.hichina.com`=120.76.107.59，RD=0 且 AA=True 的 A 记录 `8.162.13.22`、TTL 600 精确等于配置值（非缓存），AAAA/CNAME 均无；80/443 外部真实可达——外部 HTTP-01 challenge 与正常 HTTPS 浏览器均成功；本运行未读取安全组规则 API，也未做任何 DNS/安全组/防火墙写入） |
| 凭据 | Keychain 两条目存在；远端仅有 digest | DONE（本机 Keychain 两条目；服务器仅 scrypt 摘要，无明文） |

## 9. 生产现状与人工待办（2026-09-09）

**部署形态边界**
- 站点以独立 nginx vhost + acme.sh 托管并交由既有 cron 续期，**不要**再创建同名的
  1Panel GUI 站点/证书（避免冲突）；本文档 SSH 路径为权威。同域站点/证书由 OpenResty vhost +
  acme.sh 原生托管，功能等价的反代/证书/网络可达性已验收（任务 9.2），但这**不**代表创建过
  1Panel GUI 管理的站点/证书条目（不虚构 GUI API 行为）。
- 权威 DNS 与公网可达性已实测（见 §8 DNS 行）：A `8.162.13.22`、TTL 600 为权威应答（非缓存），
  AAAA/CNAME 无；80/443 外部可达。**无需再做 DNS/安全组/防火墙改动**；本运行未读取安全组规则 API。
- 8082 仅绑定 `127.0.0.1` loopback 供本机 OpenResty 反代，公网**无需也不应**放行 8082。
- 桌面生产发布通道尚未启用：Windows 编译安装后需在「数据管理 → 发布云端 → 配置发布」
  填写 URL `https://workbench.michaelli.site`（origin，不带 /api）与 **upload token**（非 viewer 密码），
  保存后再显式启用并保持运行在线；手机 Basic 用户 `viewer` + viewer 密码（非 token）。
  首个真实发布前手机预期为空 V1。手动检查只查看最近成功/失败等非 secret 状态，不取回密码/项目业务值。

**cmd_preflight 为「首次安装专用」**
- 当前实现会**有意拒绝已存在的自有容器**（即使配置匹配也 STOP），这是 first-install 闸门，
  不是在线健康检查。上线后的健康检查请使用
  `python3 scripts/deploy-mobile-readonly.py probe`、
  `probe-tls`、`checksums verify`；**不要**把 `preflight` 当作 live 健康命令重跑。
- `install` 对既有容器仅在独立完整 allowlist 校验通过时跳过 create，属安全幂等路径；
  不承诺一般化自动升级。容器自有校验逻辑当前正确。

**凭证轮换（未实现/未执行）**
- 「未实现」指**部署助手没有自动化轮换子命令**、且轮换流程尚未演练；这不是说服务本身无法轮换——
  服务支持管理员经人工授权后替换 digest 并仅重启自有服务/更新本机 Keychain。本文不提供未受保护的现成命令。
- 轮换需人工授权 + 人工操作：先验证当前可用，再替换远端 digest（仅自有 credentials.json
  与 Keychain 更新），只允许对自有服务执行，严禁覆盖未知 digest、把生产密钥写入 argv/chat/仓库。
- 本阶段不提供、也不建议「直接覆盖/再生成生产摘要」的自动化捷径。
- 部署验证：本地 93 项 Python mock 用例通过、真实 curl/redirect 校验通过、凭据/容器/loopback/
  TLS/首份空冒烟通过；最新 UI 类型检查与 3 项发布者 E2E 等见 `docs/mobile-readonly-acceptance.md`。

> 以上证据只标记实际完成项；未执行/待部署负责人确认项保持 PENDING/未勾选，不因上线而假装全部完成。
> 明文/密钥禁止出现在本文件、聊天或仓库；私密取回命令仅在受信本机终端执行并注意终端会打印明文。
