## Context

参见 `proposal.md` 的 Why。本地 Electron 工作台和本机 SQLite 保持唯一业务事实源及唯一写入方，核心业务可离线运行。

本变更跨越桌面发布、受限云端接收/查询、独立手机入口、私有网络与远程身份认证；安全、离线、迁移和容量边界需要在编码前固定。

现有共享 IPC 契约的唯一来源仍是 `src/shared/ipc.ts`。手机不经 Electron IPC，使用独立的 `mobile-read-v1` 线协议；不得暴露整个 `WorkbenchApi`。

所有金额以分的 BigInt 语义处理，并以既有规范的精确字符串语义传输；业务日期为 `yyyy-mm-dd`，审计和技术时间为 ISO。手机投影不得把 `null` 误作 `0`。

## Goals / Non-Goals

**Goals:**

- 为负责人明确启用的发布建立可验证、可回退、无陈旧回退的只读数据流。
- 在桌面离线时保持本地核心业务可用；云端健康时手机可读 last good，云端故障时手机明确显示不可达而不提供离线缓存。
- 为一名独立远程查看者提供 WireGuard 内、受信 HTTPS 上的密码、TOTP 和离线恢复码认证。
- 限定投影字段、读取范围、容量、快照一致性和新鲜度状态，使远程端不是业务权威。
- 使手机上的概览、项目和详情行为可由独立契约测试，而非依赖桌面 IPC 或本机数据库格式。

**Non-Goals:**

- 不迁移业务权威到云端，不提供双向同步、远程写入、导入、导出、业务清理或业务恢复；显式云端投影撤回是受限控制面操作。
- 不将本机 SQLite、在线备份、SQL、schema、扩展、归档文件或用户路径交给云端。
- 不增加公开注册、多账号、RBAC、Passkey、外部身份源或外部业务系统集成。
- 不承诺既有 ECS 的容量、可用性、合规资格或公网可达性；这些是部署前人工闸门。
- 不在本变更实现未来远程写入；该能力需要新 change，且必须由云端成为唯一业务权威。

## Decisions

### 1. 分离的单向投影与模块边界

桌面是唯一写入端。负责人显式启用后，桌面从一致的 SQLite online backup 构造字段白名单 DTO，并生成 JSONL 与 manifest；云端只接收该投影。

云端在受限构建 worker 中按固定 DDL 建立自己的 SQLite 查询索引。worker 无网络、无认证 secret，并且不接收客户端 SQLite、SQL、schema、extensions、archive 或用户路径。

拟议模块边界（均非现有实现）为：主进程 desktop publisher、共享 remote-read contracts 与 projection、cloud ingest/auth/read service、独立 mobile React entry。云端不耦合 Electron dialog 或 workspace。

稳定 ID、金额精确字符串、`yyyy-mm-dd` 日期和既有 DTO 空值语义进入投影契约。money 不使用浮点数。字段白名单在 source DTO、JSONL、manifest、cloud 固定 DDL、查询结果、错误和搜索索引各层重复强制，未批准字段不得旁路出现。

替代方案是上传原始数据库并复用其 SQL。拒绝原因是暴露本地实现、不可移植 schema/扩展风险和过度数据外发。

### 2. 独立且有界的移动读取契约

定义 `mobile-read-v1`，而不是复用整个 `WorkbenchApi`。它只读取已激活投影，并以 `databaseInstanceId`、`contentGenerationId`、`businessRevision`、`activationId`、快照标识和新鲜度状态作为规范元数据。

项目列表每页 20 条；详情的 `batches`、`instruments`、`orders`、`invoices`、`damage_items` 为按需、各 20 条的有界 section。cursor 过期返回 `SNAPSHOT_EXPIRED`，客户端必须刷新整个视图，不允许无限 session pin。

概览字段为 `totalProjects`、`activeProjects`、`pendingAcceptance`、`pendingInvoice`、`pendingAmount`；总数、最近两个状态计数可触发确定性过滤，active 计数只展示。

列表只搜索客户名称、ECC、临时编号；区域筛选仅为“全部”及五个固定枚举，null 与历史待调整项目均包含在“全部”中，不能单独筛选；另可按状态筛选。排序仅为“最近更新”（`updatedAt DESC`）、`planVisitAt` 升序或降序，空 `planVisitAt` 始终置后。

详情按“项目概况 / 合同与掉票 / 执行与维修”纵向组织。项目卡展示标识、状态、进单前标志、区域、计划上门日期。业务显示字段的唯一规范白名单由 `mobile-readonly-workbench` 维护；本设计不复写字段清单，避免契约漂移。

提醒仅投影 `reminderAt` 和派生的 `hasReminder`；不投影备注、到期分类或自动任务。标签、联系人、地址、自由备注、操作人姓名、源文件均排除。

`pendingAmount` 财务规则复用现有正式领域规则；投影适配必须以 synthetic 验证覆盖其边界。本设计不发明工作进度或比率。`null` 与 `0` 保持不同。

替代方案是加载完整报表、全记录或导出。拒绝原因是超出只读查看和最小数据暴露边界。

### 3. 手机页面和客户端状态边界

手机入口只有“概览”和“项目”两个主入口；项目详情遵循上项分段。卡片而非表格展示，360/390 CSS px 无页面横向滚动，最小触点 44 px，正文 16 px、辅助文字 14 px。

使用现有深绿/灰视觉语言；状态除颜色外必须有语义文字。中文标签、键盘焦点和可访问语义是验收条件。

同一页面上下文钉定一个 snapshot。用户显式刷新才切换到新版本。应区分无快照、已暂停、等待 lineage、发布失败、源端不可用/可能过旧和普通加载失败。

浏览器不得持久化业务缓存或搜索历史。登出清除内存数据；bfcache 恢复时使内存状态失效并重新鉴权/读取。

替代方案是离线业务缓存或自动静默切换快照。拒绝原因是会隐藏快照边界及过期状态。

### 4. 发布 lineage、激活和并发控制

发布者使用 `publisherId` 与 `authorizationEpoch`。lineage 是 `(databaseInstanceId, contentGenerationId)`，不同 lineage 不排序；只在同一 lineage 内比较 revision。

云端在 online backup 前签发 `publicationSequence`，每个发布者仅有一个串行 job。快照使用不可变 `snapshotId`；每次激活（包括回滚）递增 `activationId`。

ingress 和 commit 同时核验当前 binding、epoch、lineage、最新签发 job、同 lineage revision 不递减，并 CAS `activationId`。相同 job 与 checksum 可幂等；相同 job 改变 body、迟到旧 job 或陈旧 binding 必须拒绝。

只有通过校验且持久化的 artifact 才能原子更新 current；失败保留 last good。第一次有效的新全量快照（包括显式空快照）才可激活。

secret 保存在 OS credential vault；非敏感发布配置和队列保存在应用私有 control store，且两者均在业务 SQLite 与业务 backup 之外。publisher 可读取完成发布所需的 binding/epoch 元数据，但不能签发、轮换或授予 epoch，也没有业务读取或认证管理权。renderer、环境变量和日志均不得含 secret。

首次发布者凭据登记采用受控本地配置工具（经 main-side/native 模块写入 OS credential vault），而非一次性设备配对或新增配对网络入口：登记经隐藏的本地交互输入完成，secret 从不进入 argv、环境变量、日志、桌面 renderer、业务 SQLite 或备份；OS vault 不可用时 fail closed，不回退明文或 safeStorage 文件。非敏感 target/binding/consent 配置仅存应用私有 control store。凭据登记本身不等于知情启用：不授权真实发布或部署，target 信任、字段范围与保留确认仍须按负责人授权完成；工具不得声称超出实际验证的 native OS 隐私保证。本地实现选用已核对发布 API 的 `@napi-rs/keyring@2.0.0`，真实系统凭据读写、Windows 与打包产物仍须独立验收。

restore 或会导致 lineage 变化的 cleanup 时暂停并失效本地 work。新 generation 必须等待最近 MFA 确认的显式 cloud lineage bind 与新 epoch，不得自动把陈旧上传切换到新 generation。

本地暂停/离线不等于云端撤销。云端确认后轮换 epoch，保留标记 paused 的 last good。重新启用必须重新认证，不重放旧队列。

显式 cloud deletion 先原子停用发布、轮换 epoch 并使全部 queued/in-flight job 失效，再 withdraw current/history/old cursors/staging 和清除被授权保留的在线副本；GC 保留策略不得延迟访问撤销。后续发布必须由最近 MFA 的显式重新启用触发；保留本地业务数据库，且不能召回已送达响应、保证远程取证擦除或过去手机内容的清除。

回滚只允许兼容且已授权的历史，并产生新的 activationId；它使全部 in-flight job（包括同 lineage job）失效，但不自动重新授权旧 lineage。GC 保留 current、前一个兼容版本、30 分钟内被替换版本和 in-flight references。

替代方案是按客户端时间、generation 或非原子 latest 指针排序。拒绝原因是恢复、回滚与网络延迟会造成不可检测的陈旧回退。

### 5. 新鲜度的来源确认模型

cloud 记录 `lastPublishedAt` 和 current snapshot `generatedAt` 作为诊断；`lastSourceSeenAt` 只在接受 source report 后更新。仅当 source fingerprint 等于 current snapshot fingerprint 时，更新 `sourceConfirmedAt`。

fingerprint 由 lineage、businessRevision、批准显示设置 digest、固定 Asia/Shanghai 的 businessDate、projectionVersion 组成。未批准设置可使用 canonical empty digest；不得以 app settings 没有 revision 为由跳过 digest。

source 每 60 秒使用一次性、60 秒到期的 cloud challenge 和 fresh read 检查；challenge 缺失或过期不得报告 source healthy。禁止排队 heartbeat。业务变化事件 debounce 30 秒、最大延迟 60 秒。

在运行、容量与网络健康，且有效上行至少 10 Mbit/s 的测量边界内，5 分钟内可见是目标。新源数据超过 5 分钟未显示为延迟；10 分钟没有 accepted report 为 source unavailable/maybe old。heartbeat 不能清除其他 blocker。

`generatedAt` 和客户端时钟不得参与授权排序。监测 server clock；时钟健康失败或显著跳变时，拒绝依赖时间的 TOTP 与最近 MFA 控制认证，fail closed，不扩大 TOTP 窗口，也不允许密码/恢复码直接读取；在重新同步并经审查前不得报告 source healthy。

替代方案是仅用上传时间或客户端生成时间显示新鲜度。拒绝原因是不能证明当前快照仍对应源数据。

### 6. 单一远程身份和认证控制面

只有一个 remote security identity；无注册、RBAC、Account ID 或 Ship-to 身份含义。受控主机签发 15 分钟、一次性高熵 bootstrap token；没有未授权首访即管理员，只有 token 介导的受控 setup，token 不出现在 URL。

密码长度 15–128 字符，允许原样粘贴。密码哈希使用带版本 salt 的 scrypt（N=2^17、r=8、p=1、salt 至少 16 bytes、maxmem 192 MiB）；hash 前限流，hash concurrency 为 1 并设 load gate，不允许静默降低成本。

TOTP 为 6 位、30 秒、±1 window；持久化原子消费 step。TOTP secret 使用 AEAD，密钥与数据库/备份分离。恢复码为 10 个、每个至少 128 bit、仅哈希保存且仅展示一次。

密码加有效恢复码验证时，原子消费该恢复码并创建唯一、受限、10 分钟的 recovery flow；失败或过期不得使恢复码复活。完成时原子检查 flow 与 auth generation、消费新 TOTP step、替换 secret、轮换全部恢复码，并撤销全部旧 sessions、challenges 和其他 recovery flows。setup bootstrap token 原子 claim 一个 setup flow，不允许并行 secret，且随原始 15 分钟 token 到期；pending secret 以 AEAD 保存且不记日志，激活 identity 时持久化已消费的新 TOTP step。仅密码成功创建一次性、5 分钟、绑定 auth generation 的 MFA challenge，不能读取业务数据。

session 是 opaque hashed token，cookie 为 `__Host-`、Secure、HttpOnly、SameSite=Strict、Path=/；idle 30 分钟、absolute 12 小时。安全与控制面改变要求最近 5 分钟的密码加 TOTP、POST Origin 和 CSRF。

按 identity、IP、challenge 计数，5 分钟 5 次失败后 cooldown 15 分钟，无永久锁定；仅在可信 proxy 时采纳 forwarded headers。正常恢复不可用时才使用 ops recovery。

认证 backup restore 必须撤销旧 sessions、challenges、MFA/recovery generations，避免已用 recovery code 复活；故障关闭并有受控重新注册和密钥恢复方案。业务 backup 不得携带 publisher/auth key。

认证 bootstrap、恢复和 session 管理属于控制面，不是业务变更。同一单一 remote identity 在独立受信 HTTPS control page 上、于密码加 TOTP 最近五分钟内，可执行 lineage bind、disable 和 delete projection；这不是第二个管理员账号或额外 RBAC，publisher credential 也没有这些管理员权。普通 remote viewer 仅能读取业务 API，控制操作不授予业务变更。

替代方案是 Passkey、公开首访设置或把远程密码加入本地工作台。拒绝原因是与已确认密码+TOTP 选择、本地无密码边界和受控部署不兼容。

### 7. 云端部署、容量与网络隔离

现有 ECS 仅作为条件性 pilot 候选：Alibaba Linux 3 x86_64、2 vCPU、3.5 GiB（检查时约 1.7 GiB 可用）、30 GiB 空闲、Docker 26/Compose 2、6 个已有容器，80/443 OpenResty、8090 panel、8080/8081 loopback。该瞬时观察不构成容量或安全承诺。

拟议为隔离 Compose 工作负载，不引入 PostgreSQL、Redis、Kafka 或 Kubernetes。Node LTS container 的精确版本只在 `node:sqlite`/`setReadBigInts`/scrypt smoke 验证后固定，不声明最低 Node 版本。

新 API 与 builder 总预算约 768 MiB：API 512 MiB（含单次 scrypt），worker 256 MiB。CPU/网络 limits 通过测量确定，不承诺满足 SLO。

默认硬限制：ingress 64 MiB、总实体 100000 行、单行 64 KiB、字段 4096 Unicode 字符、单个 upload/build、staging 256 MiB、构建 SQLite 128 MiB、snapshot store 4 GiB。查询输入限制为搜索至多 256 Unicode 字符、ID 至多 128 字符、cursor 至多 4 KiB；未知条件拒绝，查询 deadline 为 5 秒。上传在解析前执行限制，并拒绝重复 JSON key、同实体类型的重复 ID、实际计数与 manifest/projection association 不匹配，以及需强制转换的金额或日期；金额和日期严格校验。提前验证 cardinality、引用、枚举、长度、version、checksum；checksum 不可被信任为唯一验证。超限硬拒绝，不截断、不驱逐 active 或 reader reference，且保留 old snapshot。

上传使用串行 backoff 和显式错误，禁止无限重试；staging 有明确的最大清理策略。

手机 reader 与 desktop publisher 使用不同 WireGuard peer 与 ACL。发布容器端口仅 loopback 或受保护 WireGuard，不得盲目发布 `0.0.0.0`，不得改变既有 OpenResty。

使用稳定 private DNS name 与受信 HTTPS。建议 DNS-01 续期，禁止 HTTP challenge、证书绕过或 private HTTP。验证 IPv4/IPv6 security group、netfilter、Docker forwarding 和外部 probe；firewall inactive 不等于没有规则，listening 不等于公网可达。

生产运行使用 non-root app、最小权限云角色、加密数据与认证 backup、密钥分离、证书/时钟/磁盘监控。检查时使用 SSH root 不构成运行权限。

private WireGuard 不自动取得 ICP 豁免；地区、域名和合规性为部署闸门。业务投影默认不备份；认证配置可提议 7 天有限加密备份，并须满足上述撤销安全。删除清理在线副本，并按已批准的有限策略使 provider backup 到期。

替代方案包括云端权威全迁移、桌面网络暴露、远程桌面和双向同步。分别拒绝，因为前者是新权威迁移，后者扩大攻击面或不提供受限的可验证读取路径。

## Risks / Trade-offs

- [字段遗漏或搜索旁路泄露未批准数据] → 在 source、artifact、DDL、索引、响应和错误路径执行 allowlist 正反向契约测试。
- [online backup 与本地写入并发导致不一致] → 仅从一致 backup 构造 DTO，并以并发写入 synthetic test 验证。
- [迟到 job 或恢复后旧队列覆盖 current] → epoch/binding/lineage/job/CAS 全链路检查，恢复和 cleanup 轮换 epoch。
- [失败构建损坏当前可读性] → durable validated artifact 后原子激活，始终保留 last good。
- [5 分钟目标超出小型 ECS 或实际网络能力] → 在 10 Mbit/s 和限额条件下测量；不能满足则阻止上线或经明确决定调整限额，不声称已达成。
- [单一身份的 scrypt 造成资源争用] → hash 前限流、单并发、load gate 和容器内存预算。
- [认证 backup 恢复使凭据复活] → 代际撤销、受控重新注册及密钥恢复，fail closed。
- [手机缓存或 bfcache 显示已撤回数据] → 无持久业务缓存，登出/恢复时清空内存并重鉴权。
- [现有服务器端口和 Docker 规则造成意外暴露] → 不修改现有服务；以 SG、netfilter、forwarding 与外部 probe 作为人工闸门。
- [显式删除被误解为端到端取证擦除] → 明确只清理授权在线副本与有限 provider retention，不保证历史手机内容或取证副本。

## Migration Plan

1. 先实现并以 synthetic 数据运行合同、allowlist、负向字段、并发一致 backup、坏 payload/容量、epoch/迟到 job、restore/cleanup、原子 commit/崩溃/回滚/GC、TOTP 并发重放/恢复过期、fake clock 新鲜度和无变化测试。
2. 部署隔离的 cloud workload，但不导入真实业务数据；完成 Node/scrypt smoke、容量测量、WireGuard、私有 DNS、受信 HTTPS、IPv4/IPv6 与端口拒绝验证。
3. 在 360/390 CSS px 浏览器和实际手机上检查触摸、焦点、中文标签、bfcache、认证清空和公开网络拒绝；E2E 遵循先 build、再单 worker 的既有流程。
4. 仅在负责人明确授权后启用真实数据发布；先观察 source confirmation、5/10 分钟状态和 last-good 行为，再允许手机读取。
5. 若需回滚，停用发布以保留桌面核心；撤回远程 projection、撤销认证和清理授权在线副本。绝不从云端恢复到本机 SQLite。
6. 后续远程写入只能通过新 change，先定义云端单一业务权威及迁移方案；不得在此数据流上叠加双主。

本设计后的实现验证至少包括拟议 focused Vitest 文件和 `npm run typecheck`；既有 E2E 的 build 后单 worker 流程是未来实现闸门，不在当前执行。在 apply 前不得伪造验证证据。`verify:matrix` 仅扫描正式 main specs 并重写已跟踪 matrix；active change 应独立执行 `openspec validate add-remote-readonly-access --strict`。只有 archive 后同步 main specs，才应更新 matrix。

## Open Questions

- 域名所有权、受信 HTTPS 信任链和 DNS-01 操作责任尚待部署证据确认。
- IPv4/IPv6 security group、netfilter、Docker forwarding、WireGuard ACL 与实际外部 probe 的结果尚待确认。
- 现有 ECS 在并存容器下的 CPU、内存、磁盘、网络及 5 分钟目标测量尚待确认。
- pilot 使用既有服务器与生产隔离部署之间的最终决策尚待确认。
