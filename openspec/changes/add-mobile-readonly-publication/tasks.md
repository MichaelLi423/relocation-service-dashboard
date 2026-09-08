# 任务清单：移动只读发布

> 本 change 已进入 apply 实施阶段；仅在指定行为与验证均完成后勾选任务。涉及生产部署的步骤须另行授权后执行；本地/自动化验证一律使用脱敏合成数据，禁止读取 `docs/` 下真实客户 xlsx/pptx。

## 1. 工程骨架与网络边界

- [x] 1.1 新增主进程发布模块目录 `src/main/mobile-readonly/`（config/state/snapshot/scheduler/upload/version 子模块），renderer 无 Node、领域与持久化层保持零网络；验证 `npm run typecheck` 通过（拟新增模块 + 既有模块）
- [x] 1.2 新增结构测试（拟新增路径）`tests/main/mobile-readonly-boundary.test.ts`：断言 `src/domain/**`、`src/shared/ipc.ts` 既有业务部分不 import 网络模块（fetch/node:http/node:https/node:net），网络客户端仅存在于 `src/main/mobile-readonly/`；验证 focused vitest 通过（node 环境，无 jsdom 头）
- [x] 1.3 在 `src/shared/ipc.ts` 增加发布状态（`configured`、启用、最近成功、最近失败码等，不含任何 secret）/启停/一次性配置提交的最小共享 DTO 与通道常量；验证 `npm run typecheck` 通过，且既有读取 DTO 未被改写

## 2. 封闭白名单快照（已定契约，实现非归纳）

- [x] 2.1 按 `design.md`「封闭字段白名单」表实现快照 JSON 序列化契约（schemaVersion、contentGenerationId、businessRevision、dataAsOf、overview、projects[] 及六类 records[]），每字段与表逐项一致；验证产物 schema 样例与 `design.md` 表一致（拟新增 `tests/main/mobile-readonly-whitelist.test.ts`）
- [x] 2.2 未知 key 拒绝：快照生成器与校验器对任何位置（含嵌套对象）出现表外字段判定非法；验证 `tests/main/mobile-readonly-whitelist.test.ts` 覆盖顶层、项目行与六类记录内嵌套未知 key 场景
- [x] 2.3 排除性测试：断言快照不含联系人、详细地址、自由备注、来源审计/审计时间、账号与会话、本机路径、报表导出/附件/备份内容；验证 `tests/main/mobile-readonly-whitelist.test.ts`
- [x] 2.4 金额契约（固定两位）：金额复用主进程已格式化 DTO 的主单位固定两位小数字符串（如 `"1234.57"`、`"0.00"`；可空字段未填写为 `null`，允许负值字段保留负号两位小数字符串如 `"-12.34"`）；验证 `tests/main/mobile-readonly-money.test.ts` 覆盖超安全整数金额（> 2^53 分）、0、`null` 与允许负值字段，发布与手机链路禁止再次除以 100 或转 Number（`formatCents` 自身的分→主单位格式化除外）
- [x] 2.5 日期契约：业务日期一律 `yyyy-mm-dd`，不导出审计/技术 ISO 时间；验证 `tests/main/mobile-readonly-date.test.ts`

## 3. 单事务一致快照与变化检测

- [x] 3.1 单一致事务遍历：在单一同步事务内复用 `WorkbenchReadRepository` 分页方法遍历**全部**搬迁项目与全部六类关联记录（逐页收集至最后一页，非首屏），同事务捕获 contentGenerationId/businessRevision/dataAsOf；验证 `tests/main/mobile-readonly-snapshot.test.ts`（node 环境）用多页项目与多页记录断言无遗漏
- [x] 3.2 事务边界：事务内只做本地读取与内存收集，序列化与网络上传在事务提交后执行，事务内零网络；验证结构测试 `tests/main/mobile-readonly-boundary.test.ts` 与 `tests/main/mobile-readonly-snapshot.test.ts`
- [x] 3.3 指纹捕获语义：上传成功保存**候选捕获时指纹**，不得在上传完成后再读"最新修订"做指纹；上传期间新写入归下一轮。验证 `tests/main/mobile-readonly-fingerprint.test.ts`：上传中被修改的数据不出现在本次快照指纹中，下一周期按新指纹发布
- [x] 3.4 变化检测：同代际 businessRevision 增长判定变化；contentGenerationId 轮换（恢复，含 revision 数值下降）判定变化；无写入不变化。验证 `tests/main/mobile-readonly-change-detect.test.ts`（可控时钟/内存 DB）
- [x] 3.5 首次空库与清空/恢复空库：空库首次发布生成**空集合快照**（空快照合法）；已发布后数据清空或恢复空库必须再次发布空集合，防止手机残留旧数据。验证 `tests/integration/mobile-readonly-empty.sqlite.test.ts`

## 4. single-flight、周期上传与失败处理

- [x] 4.1 可注入时钟调度器：启动检查一次、运行联网约每 2 分钟检查、single-flight（同刻至多一个候选）、变化才上传、无变化不上传且如实标记最近发布；验证 `tests/main/mobile-readonly-scheduler.test.ts`（可控时钟推进，不真等 2 分钟）
- [x] 4.2 上传客户端与协议分层：有限超时、HTTPS 固定目标、正常校验证书、禁止自动重定向；上传请求体 `{protocol:{publicationId,expectedCurrentVersion}, snapshot:{…}}` 分层，协议字段不进业务白名单校验；验证 `tests/main/mobile-readonly-upload.test.ts`（注入 mock 传输）
- [x] 4.3 服务端信封存储与版本条件替换：`current.json` 包络 `{currentVersion,publicationId,publishedAt,snapshot}` 一次原子 rename；启动读文件恢复（内存仅缓存）；从未提交无文件无版本 0；期望版本一致才提交、过期期望版本拒绝并返回元数据；幂等仅对当前存储 `publicationId` 生效；验证 `tests/server/mobile-readonly-service.test.ts`（node 环境）
- [x] 4.4 桌面侧三分支恢复：响应丢失/冲突后先读版本元数据——(1) 元数据 publicationId=候选 → 确认成功并保存候选捕获指纹；(2) 版本仍=候选 expectedCurrentVersion → 以相同 publicationId/内容/expectedCurrentVersion 原样重传；(3) 版本前进且 publicationId 不同 → 重新取一致快照生成新 publicationId 与新 expected；元数据读取失败保留未确认且不推进指纹。验证 `tests/main/mobile-readonly-version.test.ts`（mock 传输 + 版本元数据端点）
- [x] 4.5 提交成功响应丢失 + 服务重启恢复：服务接受 publicationId=P（版本 8、publishedAt 已记录）后重启，桌面以相同 P 重试 → 幂等成功且版本保持 8、publishedAt 不变；验证 `tests/server/mobile-readonly-service.test.ts`（重启后从文件恢复再处理同候选重试）
- [x] 4.6 状态持久化与 lastSuccessfulFingerprint：状态文件持久化 configured/启用/最近成功/最近失败规范化错误码与 `lastSuccessfulFingerprint`（不持久化整份待上传候选）；`enabled` 或目标配置损坏 → 禁用外发；仅结果状态文件不可写 → 内存降级继续调度并提示，不阻断业务或永久停止调度。验证 `tests/main/mobile-readonly-state.test.ts`
- [x] 4.7 桌面重启恢复：有效启用配置下重启后先读元数据，结合持久化 `lastSuccessfulFingerprint` 与当前本地指纹保守恢复（指纹相同视为已发布不重复上传；不同则重新生成候选发布）；在途候选内容丢失不得凭空确认成功。验证 `tests/main/mobile-readonly-restart.test.ts`
- [x] 4.8 失败不阻断本地：上传超时/失败不向业务路径传播，下一周期自动重试成功并刷新状态；验证 `tests/main/mobile-readonly-retry.test.ts`

## 5. 凭证与桌面配置（不含业务写入表单）

- [x] 5.1 桌面上传凭证入 OS 安全存储，不可用即禁用发布并提示，无明文文件降级；验证 `tests/main/mobile-readonly-credential.test.ts`（mock 安全存储可用/不可用分支）
- [x] 5.2 一次性受信配置入口：HTTPS 目标 + 只写 token 不回显；IPC 与 UI 状态仅 `configured` 等非 secret，任何 IPC 响应不含凭证明文；桌面不持有 root/SSH、不用本地账号/恢复码做远程认证。验证 `tests/main/mobile-readonly-ipc.test.ts`（含非受信 sender 拒绝）
- [x] 5.3 桌面发布控制与状态入口（workbench-interface delta）：非干扰呈现启用/停用/configured/最近成功/最近失败码；入口不含任何业务写入表单；新增 `tests/renderer/mobile-readonly-control.test.tsx`（文件顶部 `@vitest-environment jsdom`）
- [x] 5.4 renderer 回归：既有 `tests/renderer/app.test.tsx` 桌面主结构用例继续通过，发布入口不改变项目提醒快速处理与项目队列主导结构（不弱化断言）

## 6. 手机只读入口（mobile-readonly-workbench）

- [x] 6.1 独立手机只读 web（不依赖 `window.workbench`、不复用 `workbench-v2.tsx`）：概览、项目搜索/筛选/列表、详情与六类关联记录分页展示；页面无任何业务写入表单，仅查询输入（搜索/筛选）；用脱敏合成快照驱动本地开发服务。验证 `tests/renderer/mobile-readonly-view.test.tsx`（jsdom 头）
- [x] 6.2 版本与重载语义：打开/回前台/联网恢复立即查版本（不受定时频率限制）；前台可见且网络正常时定时检查的**相邻触发间隔不超过 60 秒**（以相邻触发时间差上界断言，不使用"每 60 秒一次"类频率表述）；详情后续请求版本改变时提示丢弃旧结果并重新加载，不混用新旧版本。验证 `tests/renderer/mobile-readonly-freshness.test.tsx`（jsdom 头）
- [x] 6.3 三时间语义：展示 dataAsOf（数据截至）、publishedAt（发布完成）、lastCheckedAt（最近成功检查，失败不推进）；派生信息按快照时刻计算并标明。验证 `tests/renderer/mobile-readonly-time.test.tsx`（jsdom 头）
- [x] 6.4 断网语义：内存中页面检查失败保留已展示数据并提示；完整刷新/重新打开且断网时显示无法连接（no-store 无离线缓存）；"尚未发布"与"已发布空快照"明确区分。验证 `tests/renderer/mobile-readonly-offline.test.tsx`（jsdom 头）
- [x] 6.5 手机浏览器独立 E2E 路径（360/390px）：独立 playwright project 或独立脚本运行 `e2e/mobile-readonly-view.spec.ts`，分别用 360px 与 390px 视口验证概览、搜索、筛选、分页、详情与关联记录可操作且无页面级横向溢出（先 `npm run e2e:build`，workers=1 已在配置）

## 7. 云端轻量只读服务（mobile-readonly-service）

- [x] 7.1 实现服务（无数据库/Redis/队列，单进程 + `snapshots/current.json` 文件包络 `{currentVersion,publicationId,publishedAt,snapshot}` 一次原子 rename；启动读文件恢复，内存仅缓存，从未提交无文件无版本 0）：上传端点按 protocol/snapshot 分层校验（snapshot 封闭白名单含嵌套未知 key、金额/日期格式、dataAsOf；expectedCurrentVersion 条件替换；幂等仅对当前 publicationId）后替换；失败保留旧版本；验证 `tests/server/mobile-readonly-service.test.ts`
- [x] 7.2 上传端点仅接受独立上传凭证（摘要 + 恒时比较）、浏览端点接受 HTTPS Basic Auth（可由反代终止），不做模糊双层 Basic；上传凭证不可读业务数据但可读非业务版本元数据端点（明确返回当前 `publicationId`、currentVersion、publishedAt、发布状态、dataAsOf 等）；验证 `tests/server/mobile-readonly-auth.test.ts`（401/403 与两凭证互相隔离）
- [x] 7.3 凭证摘要持久化：查看密码与上传 token 只存密码学摘要；日志不含业务内容或任何密钥；验证 `tests/server/mobile-readonly-auth.test.ts`
- [x] 7.4 有界查询端点：overview/项目搜索筛选分页/详情/按类关联记录分页在服务端执行，不向手机返回整份 JSON（也不返回 `current.json` 包络或 `snapshot` 全文）；所有业务响应携带当前版本 + `dataAsOf`/`publishedAt` + `Cache-Control: no-store`；验证 `tests/server/mobile-readonly-query.test.ts`（多页项目、每类记录多页、末页搜索、请求间版本变化场景）
- [x] 7.5 no-store、尚未发布与已发布空快照区分、请求体上限、上传中断不留半写、重启遗留临时文件不作为可读版本；验证 `tests/server/mobile-readonly-http.test.ts` 与 `tests/server/mobile-readonly-service.test.ts`
- [x] 7.6 Docker 化：服务绑定于 OpenResty/1Panel 可达的**共享 Docker 内部网络**或 host 网络/宿主机 loopback；文档明确不得用容器自身 loopback 跨容器；Dockerfile 构建成功即验证（不执行生产部署）

## 8. 端到端验收（本地自动化，脱敏数据）

- [x] 8.1 Electron E2E（先 `npm run e2e:build`）：`e2e/mobile-readonly-publish.spec.ts` 以临时 userData 启动真实产物，启用发布 → 录入变化 → 可控时钟推进检查点 → 断言本地状态（configured/成功/失败码/最近成功时间）与桌面主操作流不受影响
- [x] 8.2 云端收件 E2E：发布连接本地最小服务端，断言 current.json 包络原子替换（版本/`publicationId`/`publishedAt` 同文件落盘）、删除记录后新快照不含该记录（全量替换）、重复当前 publicationId 幂等且不改版本/publishedAt、过期期望版本拒绝、服务重启后同候选重试幂等
- [x] 8.3 手机可见验收（可控时钟，DOM 为准）：E2E 以注入时钟推进（桌面周期检查 + 手机前台定时检查间隔 ≤60s），**依赖自动定时触发、不手动刷新页面也不人为切换前后台**，在**手机页面 DOM 断言出现修改后的新值**（而非仅断言上传成功）；对照 5 分钟预算（本地检查 ≤120s + 手机检查 ≤60s + 生成/上传/取数/渲染合计 ≤120s，声明支持数据规模与正常网络）记录实际分段与配置；无真机/真实网络依赖，仅本地合成数据
- [x] 8.4 回归验证：`npm run typecheck` 通过；聚焦用例全通过：`npx vitest run tests/main/mobile-readonly-*.test.ts tests/server/ tests/renderer/mobile-readonly-*.test.tsx tests/integration/mobile-readonly-empty.sqlite.test.ts`；既有 `tests/renderer/app.test.tsx` 等无回归
- [x] 8.5 明确不运行 `verify:matrix`（只扫 `openspec/specs/` 正式基线；本 change delta 由 `openspec validate <change> --strict` 独立验证）

## 9. 部署闸门与生产发布（另需授权）

- [ ] 9.1 预上线定向解析测试：仅以新子域名 `workbench.michaelli.site` 预先定向解析做验证测试，`michaelli.site`/`www` 既有记录与既有站点保持不变；本地/测试不接触真实业务域名流量
- [ ] 9.2 生产部署闸门核对（不自动通过、另行授权后执行）：公网安全组放行、`workbench.michaelli.site` A 记录（8.162.13.22，TTL 10 分钟）、1Panel 反代站点 + 独立 LE 证书、OpenResty 容器到内部服务（8082 为待检查候选）网络可达性逐项实际验收并记录
- [ ] 9.3 生产凭证生成与轮换：查看 Basic Auth 强密码 + 独立上传 token，二者以摘要落盘并演练职责隔离（上传不能读业务、查看不能写）；桌面上传 token 走 OS 安全存储一次性配置；不含 root/SSH 密钥
- [ ] 9.4 生产发布执行：构建/推送镜像、启动服务、发布首份脱敏冒烟快照、手机真实浏览器验收（dataAsOf/publishedAt/lastCheckedAt、断网语义、版本重载提示）后切换 DNS；旧服务保留至缓存过渡期结束，云端服务本就不保留业务快照历史，不宣称保留生产历史快照
- [x] 9.5 验证本 change 未改动正式基线 `openspec/specs/`、未触碰 `docs/issue/`、`docs/training/vibe-coding/` 与真实客户文件；交付最终 diff 供复核
