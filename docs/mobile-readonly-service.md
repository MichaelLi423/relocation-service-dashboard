# 移动只读云端服务（mobile-readonly-service）操作与线协议文档

对应 `openspec/changes/add-mobile-readonly-publication` tasks 4.3/4.5/7.1–7.6。
实现：`src/server/mobile-readonly/**`、`webpack.mobile-readonly.config.ts`、
`Dockerfile.mobile-readonly`、`tests/server/**`。

> 生产现状（2026-09-11 更新）：服务已以 `relocation-mobile-readonly:1766c8f-amd64` 容器在线运行于
> `https://workbench.michaelli.site`（内部 127.0.0.1:8082，仅自有 data bind + /tmp tmpfs）；
> 凭证/证书/TLS/受管空冒烟已执行；2026-09-09 首次上线，2026-09-11 完成两轮真实凭证轮换并经用户
> 实机确认真实业务发布，生产当前为真实业务快照（非空 V1）。本文档描述的端点/线协议不变；部署细节见
> `docs/mobile-readonly-deployment.md`，勿以旧版「服务待构建/仅本地测试」表述代替上文。

## 1. 定位与运行形态

单 Node 进程轻量服务（无数据库/Redis/队列/历史库），唯一权威数据文件为
`<dataDir>/snapshots/current.json`，内容即服务端存储包络：

```json
{
  "currentVersion": 8,
  "publicationId": "…",
  "publishedAt": "…ISO…",
  "snapshot": { "schemaVersion": 1, "contentGenerationId": "…", "businessRevision": 7, "dataAsOf": "…ISO…", "overview": {…}, "projects": […] }
}
```

- 一次成功提交 = 写同目录唯一临时文件并 `fsync` 后 `rename` 原子替换；校验失败/写盘失败保留旧包络。
- 启动读取 `current.json` 恢复；内存仅缓存、不是权威。**从未成功提交时不创建该文件、不虚构「版本 0」**
  （逻辑元数据 `currentVersion=0`、`published:false`、其余字段 `null`，见共享 `UNPUBLISHED_MOBILE_READONLY_METADATA`）。
- 上传串行处理；幂等仅对**当前存储的 `publicationId`** 生效（无历史库）。
- 上传中断/超时绝不落半写；重启遗留的本服务临时文件（`current.json.<hex>.tmp`）启动即清理、绝不作为可读版本。
- 同一时刻仅保留一份可读当前包络与一份正在校验/写入的临时候选。

部署网络形态（design D9）：

- 生产推荐：容器加入 1Panel/OpenResty 可达的**共享 Docker 内部网络**（或 host 网络/宿主机 loopback），
  默认 `MOBILE_READONLY_HOST=0.0.0.0` + `MOBILE_READONLY_PORT=8082`，**默认不发布宿主机端口**；
  外部 HTTPS 由反向代理终止，公网不暴露明文 HTTP。
- **不得用容器自身 loopback（127.0.0.1）做跨容器访问**（容器内 loopback 对其它容器不可达）。
- 需要「服务自身直接 HTTPS」（本地测试/无反代）时注入 `MOBILE_READONLY_TLS_KEY_FILE` /
  `MOBILE_READONLY_TLS_CERT_FILE`，服务改为 https 监听。

## 2. 构建与运行

```bash
# 构建（程序化 webpack API，无需 webpack-cli/额外依赖；src/mobile/** 需已存在）
npm ci
npm run build:mobile-readonly        # 等价 node scripts/build-mobile-readonly.cjs
# 产物：
#   dist/mobile-readonly/server.cjs       服务入口（npm run start:mobile-readonly / node dist/mobile-readonly/server.cjs）
#   dist/mobile-readonly/credentials.cjs  凭证摘要生成 CLI
#   dist/mobile-readonly/web/app.js       手机只读 bundle（entry: src/mobile/index.tsx）
#   dist/mobile-readonly/web/index.html   由构建脚本从 src/mobile/index.html 复制

# 本地合成开发（45 项目合成快照 + 演示凭证，loopback；退出自动清理自身临时目录）
npm run dev:mobile-readonly

# 镜像（上下文忽略文件 Dockerfile.mobile-readonly.dockerignore；若 Docker 版本不识别该命名
# ignore 文件，请把其内容合入根 .dockerignore 后执行）
docker build -f Dockerfile.mobile-readonly -t relocation-mobile-readonly:<tag> .
```

部署/上线的实际编排见 `docs/mobile-readonly-deployment.md`（阶段化子命令：preflight /
credentials / install / probe / tls-http / acme / tls-https / probe-tls / smoke）。

环境变量（`src/server/mobile-readonly/config.ts`）：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `MOBILE_READONLY_HOST` | `0.0.0.0` | 监听主机（共享 Docker 内部网络） |
| `MOBILE_READONLY_PORT` | `8082` | 监听端口 |
| `MOBILE_READONLY_DATA_DIR` | `data` | 数据目录（`snapshots/current.json` 所在） |
| `MOBILE_READONLY_CREDENTIALS_FILE` | `<dataDir>/credentials.json` | 凭证摘要文件 |
| `MOBILE_READONLY_WEB_ROOT` | `__dirname/web` | 手机静态目录 |
| `MOBILE_READONLY_MAX_BODY_BYTES` | 64 MiB | 上传/静态请求体上限 |
| `MOBILE_READONLY_MAX_URL_LENGTH` | 8192 | URL 长度上限（超出 414） |
| `MOBILE_READONLY_REQUEST_TIMEOUT_MS` | 30000 | 单请求整体超时 |
| `MOBILE_READONLY_HEADERS_TIMEOUT_MS` | 10000 | 请求头超时 |
| `MOBILE_READONLY_KEEPALIVE_TIMEOUT_MS` | 5000 | keep-alive 空闲超时 |
| `MOBILE_READONLY_TLS_KEY_FILE` / `MOBILE_READONLY_TLS_CERT_FILE` | 无 | 同时设置则以直连 HTTPS 运行 |

## 3. 凭证（只存摘要；tasks 7.2/7.3）

- 查看（浏览）凭证：HTTPS **Basic Auth** 强密码（可由反代终止）；仅存加盐 scrypt 摘要。
- 上传凭证：独立 **Bearer token**；仅存摘要，恒时比较校验。
- 上传端点校验服务自身持有的 token 摘要，**不接受/不要求「叠加 Basic」的模糊双层认证**；
  上传请求不携带查看 Basic。
- 查看凭证可浏览全部页面/资产与业务端点；**不可上传、不可读 `/api/meta`**。
  上传凭证**可上传、可读 `/api/meta`**；**不可读任何业务端点/页面/资产**。

生成凭证摘要（输入只来自 **stdin 或环境变量，绝不 argv**；输出只含摘要，绝不落盘明文）：

```bash
MOBILE_READONLY_VIEWER_USERNAME=viewer \
MOBILE_READONLY_VIEWER_PASSWORD='…强密码…' \
MOBILE_READONLY_UPLOAD_TOKEN='…高熵 token…' \
node dist/mobile-readonly/credentials.cjs > /var/lib/mobile-readonly/credentials.json
# 或 stdin（第一行密码、第二行 token）：
printf '%s\n' "$PW" "$TOKEN" | node dist/mobile-readonly/credentials.cjs > /var/lib/mobile-readonly/credentials.json
```

凭证文件示例（只含摘要）：

```json
{
  "viewer": { "username": "viewer", "digest": "scrypt$16384$8$1$64$<saltB64>$<hashB64>" },
  "upload": { "digest": "scrypt$16384$8$1$64$<saltB64>$<hashB64>" }
}
```

## 4. 认证语义

- 401：无凭证或凭证错误（查看端点带 `WWW-Authenticate: Basic realm="mobile-readonly"`）。
- 403：凭证正确但作用域不符（如用上传 Bearer 请求业务/页面；用查看 Basic 请求 upload/meta）。
- 全部响应（含静态页、401/403、413/409 等错误）均带 `Cache-Control: no-store`。

## 5. 端点与线协议

### 5.1 `PUT /api/publish`（上传 Bearer）

请求体 `Content-Type: application/json`；严格两层：

```json
{
  "protocol": { "publicationId": "urn:uuid:…", "expectedCurrentVersion": 8 },
  "snapshot": { "schemaVersion": 1, "contentGenerationId": "…", "businessRevision": 7, "dataAsOf": "…", "overview": {…}, "projects": […] }
}
```

- protocol 严格键集 `publicationId`（非空、≤200 字符）与 `expectedCurrentVersion`（非负安全整数）；
  协议字段不进业务白名单 unknown-key 判定。
- snapshot 以共享严格校验器校验：封闭白名单（含嵌套未知 key 拒绝）、金额固定两位小数字符串、
  业务日期 `yyyy-mm-dd`、`dataAsOf` 带偏移 ISO；首版空集合快照合法（D10）。
- 决策（串行）：`expectedCurrentVersion == 当前版本` → 原子替换为 `currentVersion+1`；
  重复**当前** `publicationId` → 幂等成功（版本/`publishedAt`/文件不变）；
  其余过期候选 → 409 冲突并返回当前元数据。
- 有限请求体上限（默认 64 MiB，超限 413）、整体超时（默认 30s）、上传中断不提交。
- 响应体为共享 wire 类型 `MobileReadonlyPublishResult = { result: 'committed' | 'idempotent' | 'conflict', metadata: MobileReadonlyPublishMetadata }`。

成功（提交）：`200`

```json
{ "result": "committed", "metadata": { "published": true, "currentVersion": 9, "publicationId": "…", "publishedAt": "…", "dataAsOf": "…", "fingerprint": { "contentGenerationId": "…", "businessRevision": 8 } } }
```

重复当前候选幂等：`200` `{ "result": "idempotent", "metadata": {…同 currentVersion/publishedAt…} }`

版本冲突：`409`

```json
{ "result": "conflict", "metadata": { "published": true, "currentVersion": 9, "publicationId": "…", "publishedAt": "…", "dataAsOf": "…", "fingerprint": {…} } }
```

校验失败：`400 INVALID_PROTOCOL` / `422 INVALID_SNAPSHOT`（issues 有界回显前 20 条、单条 ≤160 字符）/
`413 PAYLOAD_TOO_LARGE` / `415 UNSUPPORTED_MEDIA_TYPE` / `400 BAD_JSON`。

### 5.2 `GET /api/meta`（上传 Bearer；桌面三分支恢复）

响应即非业务版本元数据（**无任何业务内容**）：

```json
{ "published": true, "currentVersion": 9, "publicationId": "…", "publishedAt": "…", "dataAsOf": "…", "fingerprint": { "contentGenerationId": "…", "businessRevision": 8 } }
```

尚未发布：`{ "published": false, "currentVersion": 0, "publicationId": null, "publishedAt": null, "dataAsOf": null, "fingerprint": null }`（不创建版本 0 文件）。

### 5.3 业务查询端点（查看 Basic）

统一响应载体 `{ "metadata": MobileReadonlyPublishMetadata, "data": … }`；
metadata 与 data 取自**同一次缓存包络捕获**（同版本、不混新旧）。**绝不返回 current.json 包络或 snapshot 全文。**

- `GET /api/overview`（手机版本检查 + 概览，无额外 viewer 级 meta 端点）
  - data：共享 wire 类型 `MobileReadonlyOverviewData = { overview: MobileReadonlyOverview | null }`
    （尚未发布为 `null`；已发布空快照为全零 overview，两者区分）
- `GET /api/projects?query=&status=&region=&cursor=&limit=`
  - 参数严格白名单；**可选参数空字符串一律按缺失处理**（手机固定发送
    `query=&status=&region=&cursor=&limit=20` 形式；必填 `id`/`projectId`/`kind` 空串仍是 400）；
    `query` 服务端在 **customerName/tempNo/ecc** 上做忽略大小写子串搜索；
    `status` 为受控枚举（非空非法值 400）；`region` 忽略大小写精确匹配；`limit` 1..100，缺省 50。
  - data 用共享导出：`MobileReadonlyProjectListData = { items: MobileReadonlyProjectSummary[], nextCursor: string | null }`
  - 项目行**不含 records**、不含任何快照元数据键。
- `GET /api/project?id=`
  - data：`{ "project": MobileReadonlyProjectSummary | null }`（未命中 null；**不带 records**）
- `GET /api/records?projectId=&kind=&cursor=&limit=`
  - `kind` ∈ `batches|instruments|activities|orders|invoices|damage_items`；仅返回当前页行。
  - data：`{ "kind": MobileReadonlyRecordKind, "items": MobileReadonlyRecordRow[], "nextCursor": string | null }`

查询默认值（文档口径）：单页上限 `limit ≤ 100`，缺省 `50`（projects 与 records 一致）。

**游标版本绑定**：游标内嵌 `currentVersion`（base64url `{"v":版本,"o":偏移}`）；请求时版本已变化 →
`409 { "error": { "code": "STALE_CURSOR", … }, "metadata": {…当前…} }`，手机据此丢弃旧结果重新加载。

示例 `GET /api/overview`（Basic）：

```json
{
  "metadata": { "published": true, "currentVersion": 9, "publicationId": "…", "publishedAt": "…", "dataAsOf": "…", "fingerprint": { "contentGenerationId": "…", "businessRevision": 8 } },
  "data": { "overview": { "metrics": { "totalProjects": 5, "activeProjects": 3, "pendingAmount": "1234.57", "pendingAcceptance": 1, "pendingInvoice": 1 }, "stages": [ … ] } }
}
```

示例 `GET /api/projects?query=%E5%BC%A0%E4%B8%89&status=executing&limit=2`：

```json
{
  "metadata": { "published": true, "currentVersion": 9, "publicationId": "…", "publishedAt": "…", "dataAsOf": "…", "fingerprint": {…} },
  "data": {
    "items": [ { "id": "…", "tempNo": "TP-…", "ecc": "…", "customerName": "…", "status": "executing", "region": "…", "regionNeedsAdjustment": false, "entryAt": "2026-08-01", "planVisitAt": null, "finalAmount": "1000.00", "invoicedAmount": "200.00", "contractAmount": "1000.00", "formallyEntered": true, "preEntryExecution": false } ],
    "nextCursor": "…"
  }
}
```

## 6. 页面与静态资产

- 手机入口与静态资源由服务托管（全部要求查看 Basic，`no-store`）。
- 根路径 `/`：优先返回 `webRoot/index.html`（若存在，mobile lane 可自行提供），否则使用服务内建
  模板（引用 `<script src="/app.js"></script>`）。
- bundle 约定：`webpack.mobile-readonly.config.ts` 的 web 目标产出 `dist/mobile-readonly/web/app.js`
  （entry `src/mobile/index.tsx`）；CSS 沿用 style-loader/css-loader（style-loader 运行时注入，**无独立 CSS 文件**）。
- 仅服务 `webRoot` 目录内文件；拒绝 `..`/`.`/隐藏段/符号链接逃逸；`snapshots` 目录永不暴露。
- 不存在任何「整份 snapshot / current.json」读取路由。

## 7. 尚未发布 vs 已发布空快照

- 尚未发布：metadata `published:false`、`currentVersion:0`、`dataAsOf/publicationId/publishedAt` 均为 `null`，
  概览 data `overview:null`、列表/记录为空。
- 已发布空集合：metadata `published:true`、版本 ≥1，概览返回全零 metrics 空 stages/projects，
  **不得误读为尚未发布**。

## 8. 安全与运维要点

- 日志不含业务内容/密钥；错误响应不回显请求体、内部堆栈与凭证明文。
- 凭证文件损坏/缺失 → 启动快速失败，不静默降级。
- `current.json` 损坏 → 启动快速失败（拒绝以损坏包络服务）。
- 上传 token 仅能上传 + 读 meta，不能浏览业务；查看 Basic 不能上传。生产建议单独轮换任一凭证。
- 备份/恢复快照 = 仅保留一份 `current.json`（本服务不保留历史）。
- 请求路径凭证校验使用**异步 scrypt**（不占用事件循环），并以**有界 auth 并发**保护：
  同一时刻活动校验不超过 `MOBILE_READONLY_AUTH_MAX_ACTIVE`（默认 4，范围 1..64）；
  达到上限后的新请求立即返回 `503 AUTH_BUSY`（零排队、不堆积线程池任务），
  连接在整体 `MOBILE_READONLY_REQUEST_TIMEOUT_MS` 内超时断开；校验期间超时丢弃迟到结果，绝不向已结束连接再写响应。
  摘要生成/CLI（一次性）仍使用同步 scrypt。

## 9. 部署使用步骤
已部署并完成在线联调/验收
服务地址：https://workbench.michaelli.site
- HTTPS 证书有效，已配置自动续期（公网入口 TLS 在 OpenResty 终止，后端仅 127.0.0.1:8082）。
- 生产已发布真实业务快照（2026-09-11 用户实机确认）；最初用于冒烟验证的空 V1 只是历史状态。
- 不需要你调整防火墙或 DNS，也不要开放 8082。
- UI 曾重点复核（128 项测试、3 项发布 E2E、22 项真实键鼠检查通过，历史记录）。
- 相关改动已推送到 dev；当前最新提交为 3ad6e76（本说明更新前），此前 UI 改动提交为 8fd445d。
1. 取用两份凭证
在当前这台 Mac 的“钥匙串访问”中搜索 workbench.michaelli.site，分别查看：
用途	钥匙串服务名称
手机查看密码	relocation-workbench:workbench.michaelli.site:viewer
Windows 上传 token	relocation-workbench:workbench.michaelli.site:upload
不要把密码或 token 发到聊天中。 将它们通过你自己的安全渠道带到对应设备，两者不能混用。
上表两条为**正式**条目（日常读写应使用它们）。凭证轮换事务可能另建临时 Keychain 条目并保留用于恢复，那些**不是**日常使用条目，不要误用。
2. 配置 Windows
拉取最新 dev 后，以 Squirrel Setup（当前版本 0.1.1）覆盖安装/升级：
1. 打开 数据管理 → 发布云端 → 配置发布。
2. HTTPS 服务地址填写：
https://workbench.michaelli.site
3. “独立上传凭证”填写 upload 条目的 token。
4. 保存配置，再点击 启用发布；启用会立即检查一次并返回成功/失败状态。
5. 保持桌面程序运行、电脑联网，等待“最近成功发布”出现时间。
保存配置本身不会自动启用发布；启用后约每 2 分钟继续检查一次变化。
3. 用手机验证
打开上述地址，浏览器提示认证时输入：
- 用户名：*viewer*
- 密码：钥匙串 viewer 条目的密码
若生产尚未发布或为空集合，看到“已发布，暂无项目”是正常的；当前生产已发布真实业务数据。发布成功后，请用一条合成测试数据验证：桌面修改后，手机保持前台，不手动刷新，能自动看到更新。
完成后告诉我两项结果即可：
- Windows 是否出现最近成功发布时间；若失败，只提供错误码。
- 手机是否能登录，并自动看到测试数据更新。