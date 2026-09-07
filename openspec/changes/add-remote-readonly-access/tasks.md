## 1. 实施准备与契约基线

- [x] 1.1 确认目标 Node 容器版本可运行 `node:sqlite`、`setReadBigInts` 与规定 scrypt 参数，并以最小 smoke 记录兼容性和 API 512 MiB／worker 256 MiB 预算验证结果。
- [x] 1.2 建立 `mobile-read-v1`、投影 manifest/JSONL 和发布控制的独立契约，验证不公开整个 `WorkbenchApi` 或 Electron IPC。
- [ ] 1.3 以 `mobile-readonly-workbench` 的表为唯一来源实现字段白名单映射，验证 DTO、JSONL、索引、响应、错误和日志均拒绝未知或未批准字段。
- [x] 1.4 建立仅含 synthetic 数据的 future fixture 和 `tests/remote-readonly/projection-contract.test.ts`，覆盖 unknown canary 字段、null/zero、完成项目余额、取消项目、孤立财务事实、无数据、精确金额字符串与 `yyyy-mm-dd`；验证 fixture 不读取、记录或包含真实客户业务数据。

## 2. 桌面只读投影与本地控制状态

- [ ] 2.1 在主进程实现默认关闭、明确知情启用的远程发布控制，验证未确认目标、字段范围和保留说明时不产生任何外发。
- [x] 2.2 从一致 SQLite online backup 构造字段白名单 DTO、JSONL 与 manifest，验证并发本地写入期间快照一致且绝不上传 SQLite、SQL、schema、扩展、归档或用户路径。
- [ ] 2.3 将 secret 存入 OS credential vault，将非敏感发布配置与队列放入业务 SQLite/backup 外的私有 control store，验证 renderer、环境变量和日志没有 secret。
- [ ] 2.4 实现发布者最小权限凭据，仅允许读取自身 binding/epoch 元数据并创建、心跳、上传、提交自身作业；验证不能读业务投影/认证管理数据或授予 authority。
- [ ] 2.5 实现单一串行 publisher、变化事件 30 秒 debounce/最大 60 秒与 60 秒 fresh challenge source report，以及桌面发布状态、立即发布、停用和独立撤回入口；验证不排队 heartbeat、普通状态读取不更新来源健康，且任务指挥台直接启动和既有主布局不被阻断。

## 3. 云端接收、构建与只读查询

- [ ] 3.1 实现 streaming ingress 的早期硬限制，验证 64 MiB、100000 实体、64 KiB 行、4096 Unicode 字符、256 MiB staging 和单一 upload/build 均拒绝而不截断或影响 last good。
- [ ] 3.2 实现严格 JSON/manifest 验证，验证拒绝重复 JSON key、同类型重复 ID、错误引用/计数/association、未知字段、枚举错误及需强制转换的金额或日期。
- [ ] 3.3 在无网络、无认证 secret 的隔离 worker 中以固定 DDL 构建云端自己的只读 SQLite 索引，验证上传方不能影响 SQL、schema、extension、archive 或路径。
- [ ] 3.4 实现有界 `mobile-read-v1` 查询，验证列表/section 每页 20、搜索 256 Unicode、ID 128、cursor 4 KiB、未知条件拒绝、5 秒 deadline 和 `SNAPSHOT_EXPIRED` 全视图重载。
- [ ] 3.5 为 ingress/build/query 新增 future focused tests `tests/remote-readonly/ingest-validation.test.ts` 与 `tests/remote-readonly/mobile-read-query.test.ts`，验证坏 payload、超限、空快照和不预加载完整快照。

## 4. 发布顺序、激活、恢复与撤回

- [ ] 4.1 实现 `publisherId`、`authorizationEpoch`、`databaseInstanceId`、`contentGenerationId`、`businessRevision`、`publicationSequence`、`snapshotId`、`activationId` 的契约和 CAS 提交检查，验证同 lineage 不倒退、跨 lineage 不排序。
- [ ] 4.2 实现 durable validated artifact 后原子激活、相同 job/checksum 幂等及 changed-body/迟到/陈旧 job 拒绝，验证 last good 在构建或提交失败后仍可读。
- [ ] 4.3 实现 restore 或 lineage-changing cleanup 的暂停、work 失效、显式近期 MFA lineage bind 与新 epoch，验证不会自动提升或重放陈旧队列。
- [ ] 4.4 实现本地停止、云端确认停用和显式 cloud projection withdrawal 的不同状态，验证停用不声称删除，撤回先原子停发/轮换 epoch/失效所有 queued/in-flight job 再撤销读取。
- [ ] 4.5 实现兼容历史回滚与 GC，并新增 future focused test `tests/remote-readonly/publication-ordering.test.ts`；验证新 activationId、所有同/异 lineage in-flight job 失效、GC 保留 current/前一兼容/30 分钟替换/in-flight reference、不延迟已撤销访问，以及 crash/partial upload、delete-vs-commit、rollback-vs-same-lineage commit、restore/cleanup。

## 5. 新鲜度、时间与状态语义

- [ ] 5.1 实现由 lineage、businessRevision、批准显示设置 digest、Asia/Shanghai businessDate 和 projectionVersion 组成的 source fingerprint，验证 canonical empty digest 与无变化确认不重发快照。
- [ ] 5.2 实现 `lastPublishedAt`、`generatedAt`、`lastSourceSeenAt`、`sourceConfirmedAt` 的不同含义，验证只有匹配 current snapshot 的未过期 fresh report 可更新来源确认。
- [ ] 5.3 实现 5 分钟更新延迟、10 分钟 source unavailable/maybe old、paused/awaiting lineage/publish failed/no snapshot 的独立状态，验证 heartbeat 不能清除 blocker。
- [ ] 5.4 实现时钟健康失败或显著跳变的 fail-closed 行为，并新增 future focused test `tests/remote-readonly/freshness.test.ts`；使用 fake clock 验证拒绝 TOTP/近期 MFA、challenge、无变化、配置 digest、business date/revision 与延迟状态，且重新同步并审查前不报告 source healthy。

## 6. 远程身份、会话与控制平面

- [ ] 6.1 实现受控主机的一次性 15 分钟 bootstrap token 原子 claim setup flow，验证无默认/首访管理员、无并行 secret、token 不进 URL/日志且 pending secret 使用 AEAD。
- [ ] 6.2 实现唯一 security identity 的密码 15–128 字符、版本化 scrypt（N=2^17/r=8/p=1/salt≥16/maxmem 192 MiB）和 pre-hash 限流/load gate，验证单并发且不静默降低成本。
- [ ] 6.3 实现 6 位 30 秒 ±1 TOTP 与持久原子 step 消费，验证 password-only 仅产生一次性 5 分钟、绑定 auth generation 的 MFA challenge，不能读业务。
- [ ] 6.4 实现恢复码在开始时原子消费及唯一受限 10 分钟 recovery flow，验证完成时原子检查 flow/auth generation、消费新 step、轮换全部恢复码并撤销旧 session/challenge/flow。
- [ ] 6.5 实现 opaque hashed `__Host-` cookie、idle 30 分钟/absolute 12 小时、CSRF/Origin、最近五分钟 MFA、identity/IP/challenge 失败 5 次冷却 15 分钟，验证无公开注册/RBAC/第二身份。
- [ ] 6.6 实现同一 identity 在独立 WireGuard+受信 HTTPS control page 上的近期 MFA 控制操作，验证 viewer 仅业务只读、publisher credential 无控制权、密码+恢复码不直接读业务。
- [ ] 6.7 实现受控 ops reset 与认证 backup restore 的 fail-closed 代际撤销，并新增 future focused test `tests/remote-readonly/auth-flow.test.ts`；验证并行 bootstrap/TOTP/recovery、超时、时钟异常、限流以及已用恢复码、旧 TOTP、challenge 和 session 不会复活。

## 7. 手机只读工作台与桌面边界

- [ ] 7.1 实现独立手机入口的“概览/项目”两主导航、项目卡片和三个纵向详情组，验证不引入桌面宽表、提醒泳道、全记录/报表/导出/打印/分享或业务写入口。
- [ ] 7.2 实现概览指标、项目搜索、五个固定区域筛选、指定三种排序、20 条分页和按需 section，验证不搜索未批准字段、null/待调整只在“全部”中且空计划日期置后。
- [ ] 7.3 实现字段白名单内的金额、空值、中文业务状态与手工提醒显示，验证不生成提醒/待办、不过度解释生命周期，且 `pendingAmount` 覆盖完成余额/取消/孤立/无数据边界。
- [ ] 7.4 实现 snapshot-pinned 浏览、显式刷新、late old response 抑制、过期 cursor 整体重载和状态区分，验证云端 last good 可读不等于手机离线缓存、云端不可达明确提示。
- [ ] 7.5 实现 `Cache-Control: no-store`、内存清除、登出/过期/bfcache/cross-tab 撤销后的重鉴权，并新增 future DOM test `tests/renderer/mobile-readonly-workbench.test.tsx`（文件顶部使用 `@vitest-environment jsdom`）；验证不使用 HTTP 业务缓存、localStorage、IndexedDB、Service Worker 或持久搜索历史，以及筛选、快照切换、会话清除、中文可访问标签与异常状态。
- [ ] 7.6 使用项目既有浏览器自动化工具链对 360/390 CSS px 执行 future fixture 验证，检查无页面横滚、44px 触点、16/14px 文本、键盘焦点、语义状态和 bfcache；若 mobile web 无现成 harness，明确单列其 automation 接入而不伪称 Electron E2E 已覆盖。

## 8. 部署前人工闸门与运行验证

- [ ] 8.1 在获得明确实施授权及覆盖服务器、网络和共享环境影响的部署授权后，以隔离 Compose/non-root 运行时部署，验证不改动既有 OpenResty、不发布 `0.0.0.0`、不引入 PostgreSQL/Redis/Kafka/Kubernetes；本次规划及既有 SSH 只读授权不构成部署授权。
- [ ] 8.2 配置 desktop publisher 与 phone reader 的独立 WireGuard peer/ACL、private DNS、受信 HTTPS 和 DNS-01 续期，验证无证书绕过、无 private HTTP、无公网 IPv4/IPv6 业务读取/上传可达。
- [ ] 8.3 人工验证真实 SG、host netfilter、Docker forwarding、端口监听与外部 probe，并测试实际手机、WireGuard key 丢失、证书/时钟/磁盘配额监控；不得将 firewall inactive 或监听状态当作安全结论。
- [ ] 8.4 验证加密认证 backup、密钥隔离、撤销安全恢复和有限 provider retention，确认业务 projection 默认不备份、任何 cloud deletion 不删除本地业务数据库或承诺召回已送达内容。
- [ ] 8.5 对现有 ECS 并存容器测量 CPU、内存、磁盘、网络、64 MiB/100k 行和认证 hash+build 负载；在有效上行至少 10 Mbit/s 下测量 5 分钟目标，未达标则阻止启用或经明确决策调整限额。
- [ ] 8.6 在启用前取得域名/信任链、IPv4/IPv6 网络证据、生产隔离决策和地区/ICP 合规确认；没有这些证据不得声称已部署或将 private VPN 视为自动豁免。

## 9. 后续自动化与交付证据

- [ ] 9.1 实现完成后分别运行 `npm run typecheck`，验证类型检查独立于 build；不得以打包成功代替类型正确。
- [ ] 9.2 上述拟议测试文件实现后运行 focused 验证：`npx vitest run tests/remote-readonly/projection-contract.test.ts tests/remote-readonly/ingest-validation.test.ts tests/remote-readonly/mobile-read-query.test.ts tests/remote-readonly/publication-ordering.test.ts tests/remote-readonly/freshness.test.ts tests/remote-readonly/auth-flow.test.ts tests/renderer/mobile-readonly-workbench.test.tsx`，记录实际结果而非预填通过；如新增端到端覆盖，先运行 `npm run e2e:build`，再运行 `npm run test:e2e -- --workers=1`，且 build 前的 skip 不算成功。
- [ ] 9.3 apply 后汇集每项场景到测试或人工闸门的实际证据；当前规划阶段只做 `openspec validate add-remote-readonly-access --strict` 与文档 diff，不运行 `verify:matrix`、不重写 matrix、也不登记虚假实现证据。
