# 设计：移动只读发布

## Context

需求动机见 `proposal.md`。当前架构事实（已核验）：

- 桌面是 Electron 主进程 + preload + renderer；renderer 无 Node，只能经 `window.workbench`（preload contextBridge）调 IPC；唯一 IPC 契约是 `src/shared/ipc.ts`。全部读取走主进程 `WorkbenchReadRepository`（overview/projectPage/projectDetail/sectionPage 有界读取，`withReadSnapshot` 保证单事务跨查询一致）。
- **仓库当前没有任何网络能力**：src 下零 `fetch`/`node:http`/`node:https` 引用。移动只读发布是首次引入远程传输，需明确约束到主进程新增模块；领域层/持久化层保持零网络。
- 身份与指纹基础已存在：`identity.ts` 暴露 `databaseInstanceId`/`contentGenerationId`/`businessRevision`；`content_generation_id` 是 randomUUID（不可比较新旧），恢复会轮换；`business_revision` 由业务表触发器同代际内单调递增、恢复后可以低于上次发布值。
- 金额内部为分整数（BigInt）；`formatCents(cents)` 输出**主单位固定两位小数字符串**（如 123457n → `"1234.57"`，0n → `"0.00"`），读取 DTO 已是该字符串。文档与实现统一：**金额对外即主单位两位小数字符串；快照与手机链路直接复用已格式化 DTO，禁止在发布/手机侧再次除以 100 或转 Number——`formatCents` 自身的分→主单位格式化属正常转换，不受此限**。可空金额字段未填写为 `null`；允许负值的展示字段保留负号两位小数字符串。业务日期 `yyyy-mm-dd`；审计时间 ISO。
- 手机入口复用桌面只读 DTO 的字段语义但只取白名单；手机数据经云端**有界查询端点**获得（服务端搜索/筛选/分页），不直接拿整份 JSON。
- 部署（已核验）：Alibaba Cloud Linux3 x86_64、2 核 3.5 GiB、磁盘约 30 GB 可用、Docker 26.1.3；80/443 由 1Panel 管理的 OpenResty 占用。`workbench.michaelli.site` A 记录 → 8.162.13.22（TTL 10 分钟）；证书/安全组/网络可达性列为部署闸门。
- 约束：不写回主规格基线；`verify:matrix` 不参与（只扫 `openspec/specs/` 正式基线）；本 change 只规划。

## Goals / Non-Goals

**Goals:**
- 主进程默认关闭、可显式启用的只读发布管线：单事务一致快照 + 变化检测 + single-flight 周期上传 + 状态持久化；不改变既有写入/读取/迁移路径。
- 定义云端轻量服务（单 Node 进程、文件快照、版本条件替换、有界查询端点、no-store、双凭证摘要）。
- 保证本机 SQLite 始终是唯一业务权威与唯一写入方；上传失败、结果状态文件不可写零影响本地核心业务；启用/目标配置损坏则禁用外发而非在未知授权下继续上传。
- 给出可执行验证（unit/integration/Electron E2E/360~390px 手机浏览器 + 可控时钟），全部任务 unchecked。

**Non-Goals:**
- 不做手机写入（无业务写入表单）、多用户、审计历史、附件、报表导出、数据管理、VPN/组网、云主库、双向同步、离线业务缓存、原始 DB/Excel 上传、整份 JSON 下发手机。
- 不新增领域能力或修改既有业务表结构/迁移（快照读取面复用 `WorkbenchReadRepository`）。
- 不引入同步框架、队列、历史版本存储或远程数据库。
- 本 change 不承诺生产部署与 DNS/证书切换（列为部署闸门与生产授权步骤）。

## Decisions

### D1 快照读取面复用 `WorkbenchReadRepository`，封闭白名单而非 DTO 展开

方案：主进程发布模块在**单一同步一致事务**内调用 `WorkbenchReadRepository` 的读取方法遍历全部搬迁项目与全部六类关联记录（有界分页逐页收集全部页，非首屏），并在同一事务捕获 `contentGenerationId`、`businessRevision` 与 `dataAsOf`（一致快照建立时间）。快照 JSON 仅含下文"封闭字段白名单"表格逐类列明的字段。

理由：复用已验证的一致性读取与金额/日期契约；单事务遍历保证快照跨页/跨表一致；白名单是**设计产物**（挑字段，每个字段有用途），不是 DTO 展开，杜绝把"必要"留成实现期任意决定。

备选：直接 SQL 导全表/备份文件 → 违反白名单与"非原始库"；在实现期才定白名单 → oracle 要求契约先定。

### D2 变化检测：`contentGenerationId` + `businessRevision` 与上次成功候选指纹比较

方案：每次成功发布后持久化**该候选捕获时的指纹** `{contentGenerationId, businessRevision}`。周期检查（启动一次 + 运行联网约 2 分钟一次）读取当前元数据：同代际 `businessRevision` 增长 → 有变化；`contentGenerationId` 轮换（恢复）→ 有变化（不论新库 `businessRevision` 数值高低）。**不做** generation 之间的大小比较（randomUUID 不可比）。

理由：指纹只做相等比较（是否与上次发布内容不同），不做新旧排序；恢复轮换代际天然构成一次全量上传。

### D3 single-flight、幂等与版本条件替换（桌面 ↔ 云端）

方案：
- 桌面发布循环**同一时刻至多一个候选**（single-flight）；新变化排队到下一周期。
- **上传协议包络与业务快照分离**：上传请求体为 `{protocol, snapshot}` 两层——`protocol` 携带 `publicationId`/`expectedCurrentVersion`（协议字段，不在业务白名单内），`snapshot` 为按白名单校验的业务字段；两者分离使协议字段不会触发业务白名单的 unknown-key 冲突。
- 每个业务候选携带：捕获指纹、`dataAsOf`；信封层带独立 `publicationId`、`expectedCurrentVersion`。
- 云端**只维护一份可持久化的当前发布状态**（见 D6 信封），**无多版本历史库**；幂等判定 SHALL 只对"当前存储的 `publicationId`"生效，早于当前的候选一律按冲突处理。
- 桌面侧响应丢失/冲突后的**重试统一为三分支**（先读版本元数据）：
  1. 元数据 `publicationId` == 候选 `publicationId` → 该候选已被接受：**确认成功并保存候选捕获指纹**（更新 `lastSuccessfulFingerprint`），结束本轮；
  2. 元数据 `currentVersion` 仍 == 候选 `expectedCurrentVersion`（说明从未提交成功）→ **重传完全相同**的 `publicationId`/内容/`expectedCurrentVersion`（不得因看不到响应就另生成新候选）；
  3. 元数据 `currentVersion` 已前进且 `publicationId` 不同 → 冲突：重新取本地一致快照、生成新 `publicationId` 并以元数据当前版本为新 `expectedCurrentVersion` 上传。
- 元数据端点读取失败 → 保留该候选为**未确认**状态，进入下一周期，**不推进**成功指纹。
- 上传**成功后**保存候选捕获指纹为 `lastSuccessfulFingerprint`；**不**在上传完成后重新读取"最新修订"做指纹（上传期间新写入必须下一轮发布）。

理由：文件 + 串行 + 条件替换是单负责人场景下最简单的一致性方案；`publicationId` 仅对当前发布状态做幂等，无历史库；三分支重试使"响应丢失/冲突/服务重启"都有确定且一致的收敛路径。

备选：用 `contentGenerationId`/`businessRevision` 比较新旧 → randomUUID 不可比较、恢复后 revision 可低于历史，方向错误；为"看不到响应就生成新候选" → 会造成版本无谓前进与重复发布。

### D4 上传调度、失败处理与状态持久化

方案：发布循环在主进程独立后台运行；上传使用有限超时。桌面侧状态文件只持久化**非业务**状态：`enabled`、`configured`、`uploadTargetConfigured`、`lastSuccessfulFingerprint`（最近成功发布候选捕获指纹）、最近成功时间、最近失败规范化错误码——**不持久化整份待上传业务候选**（候选内容仅内存中保留，重启即丢弃）。失败仅记录规范化错误码，不保存任意服务响应或网络内容。
- 桌面重启且处于有效启用配置时：先读取云端**版本元数据**恢复判定（三分支重试规则 D3 复用）；若重启丢失了在途候选内容，SHALL NOT 凭空确认成功——依据持久化 `lastSuccessfulFingerprint` 与当前本地指纹比较：指纹不同（或云端尚未发布）则保守地重新生成候选并发布，指纹相同则视为已发布、不重复上传。不为此引入新框架/持久化。
- **状态损坏须区分两类，不得笼统处理**：
  - `enabled` 或目标配置（HTTPS 目标/上传凭证/configured 等）损坏 → **禁用外发**，不得在未知授权配置下继续上传；
  - 仅"结果状态"（最近成功/失败记录等）文件不可写 → 可降级为内存状态继续当前已授权的发布调度并提示，不得使业务失败或调度永久停止。
- 桌面 UI 经只读 IPC 读取状态（configured/启用/最近成功/最近失败码），启停与一次性配置经受信 IPC。

理由：隔离失败面；规范化错误码避免把任意远端内容当业务日志；状态文件只是旁路信息，且"配置损坏=禁发、结果不可写=内存降级"边界清晰，不扩大授权外发面。

### D5 凭证与配置（桌面端与云端一致）

方案：
- 桌面：上传凭证保存于 **OS 安全存储**（系统钥匙串/凭据管理器），不可用即禁用发布并提示，不以明文文件静默降级。一次性受信配置入口只接受固定 HTTPS 目标 + 上传 token，token 只写不回显；IPC/UI 状态仅 `configured` 等，永不返回 secret。网络固定 HTTPS 目标、正常校验证书、禁止自动重定向。
- 云端：只读浏览用 HTTPS Basic Auth 强密码（可由 OpenResty 反代终止）；上传端点校验独立上传凭证的**摘要**（恒时比较）；查看密码与上传凭证均以摘要持久化。上传端点不接受"叠加 Basic"的模糊双层认证。
- 桌面不持有 root/SSH 密钥，不用本地账号/恢复码做远程认证。

实施确认：桌面采用 Electron `safeStorage`，上传 token 加密后以密文保存在独立 userData 文件，密钥由 OS 保护；不要求 token 本身作为钥匙串条目。仅在应用 ready 且安全存储可用时使用，Linux 的 `basic_text`/`unknown` 后端拒绝使用，禁止开启明文加密降级。Windows 的 OS 保护不隔离同一系统用户下的其他进程，不宣称具有该保护能力。

理由：单负责人、无多账号；凭证职责单一（上传 token 可读版本元数据但不可读业务；查看密码不可上传）。

### D6 云端：单 Node 进程 + 文件信封快照 + 有界查询端点

方案：云端为单 Node HTTP 进程（Docker 镜像），数据目录唯一权威文件为 `snapshots/current.json`，其内容为**服务端存储包络**：

```json
{ "currentVersion": 8, "publicationId": "…", "publishedAt": "…ISO…", "snapshot": { /* 业务白名单快照，与上传 protocol 分离 */ } }
```

- 一次成功提交 = 写入新临时文件后 `rename` 原子替换 `current.json`（含递增后的 `currentVersion`、新 `publicationId`、本次 `publishedAt` 与业务 `snapshot`）；校验失败或替换失败保留旧文件。**不存在"文件版本 0"**：从未成功提交时无 `current.json`，服务启动读取文件恢复 `currentVersion`/`publicationId`/`publishedAt`/`snapshot` 到内存缓存，**内存只做缓存、不是权威**；进程重启后状态由文件恢复，提交成功响应丢失 + 服务重启后，同 `publicationId` 候选重试 SHALL 幂等成功且不递增版本、不修改 `publishedAt`（见 D3 三分支规则 1）。
- 端点：
  - `PUT /api/publish`（上传 token）：请求体 `{protocol:{publicationId,expectedCurrentVersion}, snapshot:{…业务白名单…}}` → 校验（protocol 与 snapshot 分离；snapshot 校验白名单含嵌套未知 key、金额/日期、dataAsOf；幂等仅对当前存储 `publicationId` 生效）→ 条件原子替换。
  - `GET /api/meta`（上传 token）：非业务版本元数据，**明确返回当前 `publicationId`**、`currentVersion`、`publishedAt`、发布状态、`dataAsOf`/指纹等，供桌面三分支恢复判定。
  - `GET /api/overview|projects|project|records`（查看 Basic Auth）：服务端搜索/筛选/分页；业务响应携带当前版本 + `dataAsOf`/`publishedAt` + `Cache-Control: no-store`。
手机浏览器经这些查询端点取数，**不直接下发 `current.json` 包络**（更不下发 `snapshot` 全文）。

理由：单负责人低频小快照规模下"单文件信封 + 原子 rename"即存储与一致性；包络使发布元数据与业务快照一同原子落盘并在重启后恢复，无多版本历史；上传协议与业务白名单分层避免 unknown-key 冲突；服务端过滤使手机不持有整份 JSON。

### D7 手机入口：独立只读 web + 前台定时检查 + 三时间语义

方案：手机工作台为独立 web（不依赖 `window.workbench`，不复用桌面 `workbench-v2.tsx`）。**轮询措辞精确定义**：页面处于前台可见且网络正常时，定时版本检查的相邻触发间隔 SHALL NOT 超过 60 秒；打开页面、切回前台与联网恢复触发的**立即检查不受该定时频率限制**。时间语义：
- `dataAsOf` = 快照的数据库一致读取建立时刻（快照头部，随查询响应/版本元数据提供）；
- `publishedAt` = 云端成功接收快照的时刻（服务端包络字段）；
- `lastCheckedAt` = 手机最近**成功**完成版本检查的时刻（页面本地维护，失败不推进）。
页面任何派生信息（阶段停留天数、到期分类）按快照时刻数据计算并标明为快照时状态。断网：内存中已展示内容在检查失败时保留并提示；完整刷新/重新打开且断网时无法加载（no-store、无离线缓存）——与电脑断网（只影响新发布）分开表述。

理由：手机无 preload 桥；"相邻触发间隔不超过 60 秒"是可测的定时约束，立即检查（打开/回前台/联网恢复）与定时轮询解耦；三时间语义如实反映数据生命周期。

### D8 5 分钟可见预算

方案：验收目标"正常联网且应用运行，修改后 5 分钟内手机可见"分解为上限预算（声明适用支持数据规模与正常网络）：**本地变化检查上限 ≤ 120 秒**（周期约 2 分钟）+ **手机侧检查上限 ≤ 60 秒**（前台相邻触发间隔不超过 60 秒）+ **其余环节（快照生成、上传提交、手机取数与渲染）合计 ≤ 120 秒**内完成。三段合计 ≤ 5 分钟。E2E 以可控时钟推进并依赖**自动定时触发**（不手动刷新页面、不人为切换前后台），在**手机页面 DOM 断言出现修改后的新值**（不只断言上传成功）。若数据规模超出单请求体上限或网络不可达，系统如实标记而不承诺 5 分钟。

理由：把模糊的"5 分钟"拆成可测的上限预算；E2E 仅凭自动定时与 DOM 新值证明端到端可见，避免人为刷新/切前台引入假阳性。

实施确认：允许为真实打包 Electron 新增受限的主进程 E2E 时钟注入设施，仅在显式 E2E 开关且使用临时 userData 时启用。正常 renderer 不暴露时钟控制接口，正常启动不启用该设施；测试不得借此跳过 HTTPS 或凭证校验。验收仍以推进时钟后自动调度引发的手机 DOM 新值为准，不以缩短轮询周期替代可控时钟验证。

### D9 部署边界与生产闸门（含 Docker 网络模式）

方案：生产部署拆为受控闸门任务：公网安全组放行、`workbench.michaelli.site` A 记录（TTL 10 分钟）、1Panel 反代新站点 + 独立 LE 证书、OpenResty 容器到内部服务的网络可达性、凭证生成与轮换。预上线阶段仅以**新子域名定向解析**做验证测试，不触碰既有 `michaelli.site`/`www` 记录与既有站点。**Docker 网络模式须明确**：服务须加入 1Panel/OpenResty 可访问的**共享 Docker 内部网络**，或使用 **host 网络/宿主机 loopback** 地址；不得绑定在容器自身 loopback（容器内 127.0.0.1 对 OpenResty 容器不可达，跨容器 loopback 不成立）。迁移未来仅改 `workbench` A 记录指向新服务器：先在新机备好服务/凭证/证书再切 DNS，保留旧服务等待缓存过渡（不宣称保留生产业务快照历史，云端服务本就只存当前一份快照）。闸门不自动通过。

理由：DNS/证书/安全组现状未验证；既有 `michaelli.site` 业务不可影响；容器 loopback 不跨容器是常见部署坑。

### D10 首版空快照与空集合合法

方案：首次发布允许空集合快照（空库也发布一份空快照，使手机明确"已发布但无数据"）；已发布后数据清空或恢复空库必须再发布空集合，防止手机看到残留旧数据。云端"尚未发布（从未成功接收）"与"已发布空集合"是两个状态。

理由：空库/清空是合法业务状态；区分两个状态避免手机把"已发布无数据"误读成"尚未发布"。

## 封闭字段白名单

下表是唯一权威白名单（JSON 路径 / 源读取面字段 / 类型与空值 / 用途），约束上传包络中 `snapshot` 这一层（业务快照）。**服务端存储包络字段 `currentVersion`/`publicationId`/`publishedAt` 属于信封层（见 D6），不属于业务快照白名单**；上传请求 `protocol` 层的 `publicationId`/`expectedCurrentVersion` 同样不进业务快照，二者分层校验，互不触发 unknown-key。快照（`snapshot`）任何位置出现表外字段（含嵌套）→ 非法。字段按"手机入口既定功能所需"逐个挑选：概览（指标/阶段）、项目搜索/列表/详情（主状态、金额、日期）、六类关联记录展示。**默认不包含**：联系人（旧址/新址联系人）、详细地址、自由备注/说明类文本、来源审计/审计时间、账号与会话、本机路径、二维码 URL、Ship-to 地址、附件与报表导出数据。金额字段一律为"主单位固定两位小数字符串"（源为分整数 BigInt 经格式化函数输出，如 `"1234.57"`；**可空金额字段未填写为 `null`；允许负值的字段保留负号两位小数字符串如 `"-12.34"`**），日期一律 `yyyy-mm-dd`；不导出任何审计/技术 ISO 时间。

### 快照顶层与元数据

| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `schemaVersion` | 常量 | number | 快照格式版本，未知版本拒绝 |
| `contentGenerationId` | identity.ts `contentGenerationId` | string | 代际指纹（恢复后轮换） |
| `businessRevision` | identity.ts `businessRevision` | number | 同代际修订指纹 |
| `dataAsOf` | 一致快照事务建立时刻 | ISO string | 数据截至时间（展示语义） |
| `overview` | 见下 | object | 概览 |
| `projects` | 见下 | object[] | 项目列表/详情与关联记录 |

### 概览（`overview`）

| JSON 路径 | 源 DTO 字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `overview.metrics.totalProjects` | OverviewDto.metrics.totalProjects | number | 项目总数展示 |
| `overview.metrics.activeProjects` | OverviewDto.metrics.activeProjects | number | 活跃项目展示 |
| `overview.metrics.pendingAmount` | OverviewDto.metrics.pendingAmount | string（两位小数字符串，`"0.00"` 合法） | 待掉票金额展示 |
| `overview.metrics.pendingAcceptance` | OverviewDto.metrics.pendingAcceptance | number | 待验收计数展示 |
| `overview.metrics.pendingInvoice` | OverviewDto.metrics.pendingInvoice | number | 待掉票计数展示 |
| `overview.stages[]` | OverviewDto.stages | `{status: ProjectStatus, count: number, averageDays: number}[]` | 阶段分布（快照时刻派生） |

### 项目行/详情（`projects[]`，项目在快照中同时承载列表所需与详情所需字段）

列表/搜索/筛选需要：`id`、`tempNo`、`ecc`、`customerName`、`status`、`region`、`regionNeedsAdjustment`、`entryAt`、`planVisitAt`、`finalAmount`、`invoicedAmount`、`contractAmount`、`formallyEntered`、`preEntryExecution`。

| JSON 路径 | 源 DTO 字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].id` | WorkbenchProjectRow.id | string | 详情/记录关联 |
| `projects[].tempNo` | WorkbenchProjectRow.tempNo | string | 列表展示与搜索（临时编号） |
| `projects[].ecc` | WorkbenchProjectRow.ecc | string \| null | 列表展示与搜索（ECC） |
| `projects[].customerName` | WorkbenchProjectRow.customerName | string | 列表展示与搜索（客户名称） |
| `projects[].status` | WorkbenchProjectRow.status | ProjectStatus 枚举 | 列表筛选/展示与阶段归属 |
| `projects[].region` | WorkbenchProjectRow.region | string \| null | 列表筛选/展示（区域） |
| `projects[].regionNeedsAdjustment` | WorkbenchProjectRow.regionNeedsAdjustment | boolean | 区域待调整标记展示 |
| `projects[].entryAt` | WorkbenchProjectRow.entryAt | string \| null（yyyy-mm-dd） | 进单日期展示 |
| `projects[].planVisitAt` | WorkbenchProjectRow.planVisitAt | string \| null（yyyy-mm-dd） | 计划上门日期展示 |
| `projects[].finalAmount` | WorkbenchProjectRow.finalAmount | string \| null（两位小数） | 最终可确认金额展示 |
| `projects[].invoicedAmount` | WorkbenchProjectRow.invoicedAmount | string（两位小数） | 累计有效掉票展示 |
| `projects[].contractAmount` | WorkbenchProjectRow.contractAmount | string \| null（两位小数） | 合同金额展示 |
| `projects[].formallyEntered` | WorkbenchProjectRow.formallyEntered | boolean | 已进单判定展示（未进单/已进单区分） |
| `projects[].preEntryExecution` | WorkbenchProjectRow.preEntryExecution | boolean | "未进单先执行"标记展示 |

注：`WorkbenchProjectRow.counts`、`nonBlocking`、`reminder*`、`groupedTags/tagIds`、`updatedAt` 及旧址/新址地址与联系人、备注均**不导出**（非列表/详情核心只读所需或含敏感文本）。项目详情展示仅含上述行字段（含客户名称/ECC/临时编号/主状态/区域/进单日期/计划上门日期/三项金额）；不导出审计/技术时间、项目备注、暂存地址、是否暂存、暂定搬迁范围、场地确认等执行准备细节与取消原因/经理批复原因等文本。

### 六类关联记录

服务端按类分页返回；每类行仅下列字段。

**批次（batches）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.batches[].id` | sectionRow.batches.id | string | 行标识 |
| `projects[].records.batches[].planTransportDate` | planTransportDate | string \| null（yyyy-mm-dd） | 计划运输日期展示 |
| `projects[].records.batches[].transportCompany` | transportCompany | string \| null | 运输公司展示 |
| `projects[].records.batches[].startedAt` | startedAt | string \| null（yyyy-mm-dd） | 开始运输日期展示 |
| `projects[].records.batches[].appliedAt` | appliedAt | string \| null（yyyy-mm-dd） | 物流费用登记日期展示 |

注：批次的价格（预算价/物流成交价）与费用明细**不导出**（非只读展示必需且可省），如需后续新增必须改白名单。

**仪器（instruments）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.instruments[].id` | sectionRow.instruments.id | string | 行标识 |
| `projects[].records.instruments[].name` | name | string | 仪器名称展示 |
| `projects[].records.instruments[].model` | model | string \| null | 仪器型号展示 |
| `projects[].records.instruments[].serialNo` | serialNo | string \| null | 序列号展示/识别 |
| `projects[].records.instruments[].ups` | ups | boolean | UPS 标记展示 |

注：manufacturer、serviceLevel、qrRequested、destinationShipToId、createdAt **不导出**。

**上门活动（activities）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.activities[].id` | sectionRow.activities.id | string | 行标识 |
| `projects[].records.activities[].visitAt` | visitAt | string \| null（yyyy-mm-dd） | 到访日期展示 |
| `projects[].records.activities[].engineers` | engineers | string（参与工程师文本） | 参与工程师展示 |

注：createdAt 不导出。

**开单（orders）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.orders[].id` | sectionRow.orders.id | string | 行标识 |
| `projects[].records.orders[].orderType` | orderType | `'relocation'\|'certification'\|'parts_by_mail'\|'pm'` | 开单类型展示 |
| `projects[].records.orders[].serviceOrderNo` | serviceOrderNo | string \| null | 服务单号展示/识别 |
| `projects[].records.orders[].orderedAt` | orderedAt | string（yyyy-mm-dd） | 开单日期展示 |
| `projects[].records.orders[].engineer` | engineer | string \| null | 参与工程师展示 |

注：note、customerName（项目行已含）、createdAt 不导出。

**掉票（invoices）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.invoices[].id` | sectionRow.invoices.id | string | 行标识 |
| `projects[].records.invoices[].amount` | amount | string（两位小数） | 掉票金额展示 |
| `projects[].records.invoices[].invoicedAt` | invoicedAt | string（yyyy-mm-dd） | 掉票日期展示 |
| `projects[].records.invoices[].active` | active | boolean | 有效/已撤销状态展示 |
| `projects[].records.invoices[].revokedAt` | revokedAt | string \| null（yyyy-mm-dd） | 撤销日期展示 |

注：revokeReason、lastModifiedAt、createdAt 不导出。

**损坏/维修事项（damage_items）**
| JSON 路径 | 源字段 | 类型/空值 | 用途 |
|---|---|---|---|
| `projects[].records.damage_items[].id` | sectionRow.damage_items.id | string | 行标识 |
| `projects[].records.damage_items[].instrumentName` | instrumentName | string | 关联仪器名称展示 |
| `projects[].records.damage_items[].serialNo` | serialNo | string \| null | 序列号展示/识别 |
| `projects[].records.damage_items[].issueStatus` | issueStatus | string | 事项处理状态展示 |
| `projects[].records.damage_items[].partNumber` | partNumber | string | 备件编号展示 |
| `projects[].records.damage_items[].partQuantity` | partQuantity | number | 备件数量展示 |
| `projects[].records.damage_items[].partAmount` | partAmount | string（两位小数） | 备件金额展示 |
| `projects[].records.damage_items[].partCurrency` | partCurrency | string \| null（受控值 USD/RMB） | 币种展示 |
| `projects[].records.damage_items[].registeredAt` | registeredAt | string（yyyy-mm-dd） | 登记日期展示 |

注：damageReason、repairNote 等自由文本与审计时间不导出；partStatus 仅在展示所需时按受控枚举列入并同步更新本表。

> 白名单为封闭契约：新增任何字段须先更新本表并通过校验与测试，不得在实现期随意放行。

## Risks / Trade-offs

- [单文件快照 + 服务端过滤，多端同时读受单文件尺寸/请求体上限限制] → 单负责人场景 + 请求体上限，超限拒绝并规范化记录；不上送整份 JSON 给手机。
- [上传在公网 HTTPS，凭证被窃取风险] → 双凭证职责分离 + 摘要持久化 + no-store + 日志不含业务/密钥 + 固定目标证书校验；查看密码可单独轮换。
- [恢复空库/清空数据后手机残留旧数据] → D10：清空后必须发布空集合，已发布空集合 ≠ 尚未发布。
- [`businessRevision` 在无写入时不变化，周期检查空转] → 检查成本极低；无变化即不上传，桌面/手机如实标记"最近发布"时间。
- [断网语义被误读为"可离线缓存"] → D7/D6：no-store、完整刷新断网不可载；内存中已展示内容保留并提示，二者分开。
- [版本条件替换与幂等增加一点协议复杂度] → 以 `expectedCurrentVersion` 相等比较 + `publicationId` 幂等实现，无历史/队列，比"指纹新旧排序"简单且正确。
- [主进程新增网络传输被渲染层滥用] → 网络仅存在于发布模块后台任务；renderer 无网络能力；IPC 只暴露启停/状态（不含 secret）。
- [MODIFIED delta 与主规格长期共存，归档时须人工合并] → 规格/实现冲突以规格为准，delta 已在 specs 中以 MODIFIED/ADDED 明示，不写回正式基线。

## Migration Plan

- 无数据库迁移、无既有表结构变化；发布模块为新增主进程代码与新增独立小配置文件/OS 安全存储条目（可安全删除/禁用，不影响业务库）。
- 手机/云服务为新部署产物；生产发布按部署闸门步骤执行，不自动进行。
- 回滚：停用发布即停止外发；删除配置与云快照即移除远程副本；桌面本地与既有验证不受影响。
