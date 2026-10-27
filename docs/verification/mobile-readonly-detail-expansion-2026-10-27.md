# 手机只读详情扩展：v2 契约与验收记录

日期：2026-10-27。本文记录本次明确授权的字段同步边界、现行 v2 扩展白名单与本地验收证据。专项测试、构建及浏览器验证已完成；**未部署生产，也不构成生产部署授权**。未验证项与自动检查限制见文末。

## 授权与版本边界

- 本次授权非敏感业务字段，以及联系人及联系方式、搬出/搬入/暂存详细地址、提醒日期和提醒备注同步云端；所有现有 Basic Auth 查看者均可查看，保持只读。不新增编辑、导出或公开分享。
- 提醒备注是唯一自由备注例外。一般项目/业务自由备注、项目备注、开单备注、维修备注、取消原因、撤销原因、损坏原因、关闭未修复原因、经理批复原因等仍禁止外发。来源审计、账号凭证、本机路径、附件、备份与报表导出内容仍不在白名单内。联系人字段按源文本原样表达联系人及联系方式，不另行推断、拆分或新增电话字段。
- [归档 v1 封闭字段表](../../openspec/changes/archive/2026-09-12-add-mobile-readonly-publication/design.md#封闭字段白名单)保持不变，不修改归档历史 design。v2 白名单是该表加本文扩展表；归档表中对下列新增字段的排除仅描述 v1，不覆盖本次 v2 明确授权。未列出的字段仍不允许。
- 新桌面生成 `schemaVersion=2`。新服务按 v1/v2 严格分支校验封闭白名单，未知版本、嵌套未知 key、缺失 v2 必填字段均拒绝；v1 不接受 v2 扩展字段。所有扩展字段在 v2 均必填，nullable 字段以 `null` 表示未填写；数组无内容为 `[]`。旧 v1 没有扩展字段表示“当前快照未提供”，不等同于 `null`，不合并历史 v2 值。
- 新服务先部署，再升级桌面；旧服务拒绝 v2，桌面不得自动降级上传 v1。回滚旧服务不保证能读取已落盘 v2。生产部署或生产回滚须另有明确授权。

## v2 现行扩展表

以下 JSON 路径均相对上传体 `snapshot`，不是协议或查询响应包络。`date` 指真实日历业务日期字符串 `yyyy-mm-dd`；计数为非负整数。源类型来自 `src/shared/ipc.ts` 的既有 WorkbenchV2 读取面，不新建数据库字段。源读取与六类完整数组收集均在同一一致事务内完成，逐字段投影，禁止 DTO 展开；事务提交后才序列化/上传。

### 项目行与分组标签

`row` 指项目分页读取所得 `WorkbenchProjectRow`。源 `groupedTags` 为兼容旧读取面可选；生成 v2 时无标签规范化为空数组，不能省略 key，也不能展开整个源标签对象。

| JSON 路径 | 源 DTO / 字段 | 类型 / 空值 | 用途 |
|---|---|---|---|
| `projects[].reminderAt` | `WorkbenchProjectRow.reminderAt` | date \| null | 当前提醒日期 |
| `projects[].reminderDueClass` | `WorkbenchProjectRow.reminderDueClass` | `'upcoming' \| 'today' \| 'overdue' \| null` | 快照时提醒到期分类，不按手机今天重算 |
| `projects[].groupedTags` | `WorkbenchProjectRow.groupedTags` | readonly object[] | 已选标签分组摘要 |
| `projects[].groupedTags[].groupId` | `ProjectTagGroupSummaryDto.groupId` | string | 标签组标识 |
| `projects[].groupedTags[].groupName` | `ProjectTagGroupSummaryDto.groupName` | string | 标签组名称 |
| `projects[].groupedTags[].tagIds` | `ProjectTagGroupSummaryDto.tagIds` | string[] | 组内已选标签标识 |
| `projects[].groupedTags[].tagNames` | `ProjectTagGroupSummaryDto.tagNames` | string[] | 组内已选标签名称 |

### 项目详情

`detail` 源为 `reader.projectDetail(projectId)` 返回的 `WorkbenchV2ProjectDetailDto.detail`，下表 `detail.x` 均指该对象字段。`projects[].detail` 是 v2 必填的封闭对象，不允许将源对象整体复制；提醒备注源例外为 `row.reminderNote`。既有 `entryAt`、`planVisitAt` 与三项金额沿用 v1 路径，计划装机仅用现行 `plannedInstallAt`，不新增已废弃 alias `plannedInstallDoneAt`。

| JSON 路径 | 源 DTO / 字段 | 类型 / 空值 | 用途 |
|---|---|---|---|
| `projects[].detail` | `WorkbenchV2ProjectDetailDto.detail` 与 `row.reminderNote` 的逐字段投影 | object（下列 key 必填） | 仅详情读取，不进入列表响应 |
| `projects[].detail.oldSiteContact` | `detail.oldSiteContact` | string \| null | 搬出联系人及联系方式 |
| `projects[].detail.newSiteContact` | `detail.newSiteContact` | string \| null | 搬入联系人及联系方式 |
| `projects[].detail.oldSiteAddress` | `detail.oldSiteAddress` | string \| null | 搬出详细地址 |
| `projects[].detail.newSiteAddress` | `detail.newSiteAddress` | string \| null | 搬入详细地址 |
| `projects[].detail.temporaryStorageAddress` | `detail.temporaryStorageAddress` | string \| null | 暂存详细地址 |
| `projects[].detail.isTemporaryStorage` | `detail.isTemporaryStorage` | boolean \| null | 是否暂存，未填写与否不同 |
| `projects[].detail.contractStartDate` | `detail.contractStartDate` | date \| null | 合同开始日期 |
| `projects[].detail.contractEndDate` | `detail.contractEndDate` | date \| null | 合同截止日期 |
| `projects[].detail.planTransportAt` | `detail.planTransportAt` | date \| null | 计划运输日期 |
| `projects[].detail.plannedInstallAt` | `detail.plannedInstallAt` | date \| null | 计划装机日期 |
| `projects[].detail.actualInstallDoneAt` | `detail.actualInstallDoneAt` | date \| null | 实际装机完成日期 |
| `projects[].detail.acceptanceReportDate` | `detail.acceptanceReportDate` | date \| null | 验收报告形成日期 |
| `projects[].detail.cancelledAt` | `detail.cancelledAt` | date \| null | 取消日期，不含取消原因 |
| `projects[].detail.siteConfirmed` | `detail.siteConfirmed` | boolean | 场地确认事实 |
| `projects[].detail.acceptanceReport` | `detail.acceptanceReport` | boolean | 验收报告事实 |
| `projects[].detail.temporaryInstrumentCount` | `detail.temporaryInstrumentCount` | 非负整数 \| null | 暂定仪器数量，0 与未填写不同 |
| `projects[].detail.temporaryInstrumentName` | `detail.temporaryInstrumentName` | string \| null | 暂定仪器名称 |
| `projects[].detail.temporaryInstrumentModel` | `detail.temporaryInstrumentModel` | string \| null | 暂定仪器型号 |
| `projects[].detail.temporaryHasUps` | `detail.temporaryHasUps` | boolean \| null | 暂定 UPS 事实 |
| `projects[].detail.reminderNote` | `WorkbenchProjectRow.reminderNote` | string \| null | 当前提醒备注，唯一自由备注例外 |

### 关联记录

源为 `reader.sectionPage` 返回的 `WorkbenchV2SectionRow` 对应 kind 分支，仍逐页收集完整数组。扩展不增加手机记录类别。

| JSON 路径 | 源 DTO / 字段 | 类型 / 空值 | 用途 |
|---|---|---|---|
| `projects[].records.instruments[].manufacturer` | `WorkbenchV2SectionRow` instruments 分支 `.manufacturer` | string \| null | 仪器厂家 |
| `projects[].records.instruments[].serviceLevel` | instruments 分支 `.serviceLevel` | string \| null | 仪器服务级别 |
| `projects[].records.instruments[].qrRequested` | instruments 分支 `.qrRequested` | boolean | 是否已申请二维码，不含二维码 URL |
| `projects[].records.orders[].customerName` | orders 分支 `.customerName` | string | 开单所属客户名称，不替换项目客户 |
| `projects[].records.damage_items[].partStatus` | damage_items 分支 `.partStatus` | `'pending_submit' \| 'processing' \| 'arrived' \| 'used' \| null` | 备件状态（待提交/处理中/已到件/已使用） |

`partStatus` 源 DTO 声明为 `string | null`，受控值已核对 `src/domain/capabilities/damage-repair-tracking/damage-repair.ts` 的 `PART_STATUSES`；发布/服务契约不得因此允许任意字符串。仍不发布 `damageReason`、`repairNote`、`revokeReason`、`orders[].note` 等自由文本。

### 概览

| JSON 路径 | 源 DTO / 字段 | 类型 / 空值 | 用途 |
|---|---|---|---|
| `overview.metrics.reminderCount` | `WorkbenchV2OverviewDto.metrics.reminderCount` | 非负整数 | 有当前提醒（日期或备注任一）的项目数 |
| `overview.metrics.reminderOverdue` | `WorkbenchV2OverviewDto.metrics.reminderOverdue` | 非负整数 | 快照时已逾期提醒项目数 |
| `overview.metrics.reminderToday` | `WorkbenchV2OverviewDto.metrics.reminderToday` | 非负整数 | 快照时当日提醒项目数 |
| `overview.metrics.openRepairProjects` | `WorkbenchV2OverviewDto.metrics.openRepairProjects` | 非负整数 | 存在未修复且未关闭未修复事项的项目数，不是事项数 |

## 查询、状态与展示契约

- 列表响应明确投影原有列表字段及允许的行级提醒日期/分类、分组标签，不包含 `detail`、任何 detail-only 字段或 `records`。授权上传不等于允许列表返回联系人或地址。
- 详情响应追加 `recordCounts`，按当前项目完整 `records` 六类数组分别取长度（`batches`、`instruments`、`activities`、`orders`、`invoices`、`damage_items`），不是分页长度，也不盲信旧行 DTO counts。该字段是查询派生值，不新增到上传白名单。
- 项目分页追加 `total`，为搜索/筛选后的项目总数；关联记录分页 `total` 为该项目整类总数。页大小仍有界，不以返回总数为由返回全数组或整份快照。
- 非业务版本元数据追加 `snapshotSchemaVersion`（当前快照为 1 或 2，尚未发布为 null）；兼容旧服务缺少此字段。它不属于上传业务白名单，不代替单调发布版本 `currentVersion`。
- 本地发布成功状态持久化 `lastSuccessfulSchemaVersion`，与候选捕获指纹一同在成功确认后更新。已有业务指纹不变但成功 schema 缺失或非 2 时仍需发一次 v2；上传失败、拒绝或元数据无法确认不得推进。旧服务缺少 schema 元数据不是 v2 成功证据；停用仍停用，不因升级启用上传。
- 手机仅保留仪器、开单、掉票、损坏维修四类，不恢复批次/到访入口。按基础信息、完整日期、联系人地址、暂存、暂定仪器、提醒标签、金额分组展示授权字段。
- v1 缺失显示“当前快照未提供”；v2 `null` 显示“未填写”；`false` 是“否”、`0` 是零、空数组为无记录，不用真假值判断吞掉字段。金额直接展示主进程已格式化的固定两位小数字符串，禁止转 Number、浮点计算或二次除以 100。提醒分类/计数保持快照时语义，不按手机当前日期推算。
- 只读、独立凭证、no-store、上传单事务一致读取、single-flight、版本条件替换和完整包络原子提交等既有边界不变。

## 验收清单

以下勾选仅表示本次本地交付已有对应证据，不表示全仓回归或生产验收通过。测试文件与标题映射见 `scenario-map.mjs`，实际执行结果见下方日志记录。

- [x] v1 原表不变；v2 新增 key 必填、类型/日期/枚举/计数约束及嵌套未知 key 拒绝（whitelist/v2 focused 测试）。
- [x] 禁止备注/原因与其他敏感字段不能进入任意嵌套白名单；仅提醒备注例外（v2 授权投影与禁止字段回归）。
- [x] 单一事务逐字段投影并完整收集各页，无 DTO 展开、无数据库 schema 新增（实现 diff 核对及 snapshot/v2 测试）。
- [x] v1/v2 读写与重启恢复；v2 后再读 v1 不合并旧值；未知版本拒绝且保留旧包络（服务 v2/HTTP/协议回归）。
- [x] 列表无 detail-only 泄露，详情 recordCounts 来自完整数组，过滤 total 与整类 total 正确且响应有界（服务 query/v2 测试）。
- [x] schema 元数据兼容旧服务缺失；无业务修订也发一次 v2，成功推进、失败不推进、停用不启动（restart/upload 回归）。
- [x] 手机四类记录、分组详情、legacy/null/false/0、精确金额与快照时提醒语义（mobile renderer 回归、手机 E2E 与截图检查）。
- [x] 类型检查、31 文件 248 用例 focused 回归、10 项专项 E2E、移动构建与桌面打包通过；仅使用合成数据，未读取客户 xlsx/pptx。
- [x] 部署顺序与旧服务拒绝 v2/回滚限制已记录；该项为契约说明，不是部署执行证据。
- [ ] 全量 `npm test`、真实客户文件测试、生产部署均未执行。
- [ ] Skill 自动 style gate 未通过；限制及替代浏览器证据见下。

## 执行证据与限制

已核对临时日志目录 `/private/var/folders/0t/r3m9w9497zd7ctt82lb39lmc0000gn/T/opencode/mobile-expansion-final/` 的以下日志；日志为本地验收证据，不随仓库交付。

| 检查 | 结果与日志 | 边界 |
|---|---|---|
| `npm run typecheck` | PASS；`typecheck-final.log` | `tsc --noEmit`，不以打包代替类型检查 |
| mobile focused 回归 | PASS：31 文件、248 用例；`focused-vitest.log` | 覆盖本次 main/server/mobile renderer，非全量 `npm test` |
| `npm run build:mobile-readonly` | PASS；`mobile-build.log` | 服务与手机页面构建成功 |
| 桌面打包 | PASS；`e2e-build-no-invalid-agent.log` | macOS arm64；保留完整系统及包管理器检测 |
| `npm run test:e2e:mobile-readonly -- --workers=1` | PASS：10/10，1 worker；`mobile-e2e-final.log` | P1 桌面→服务→手机，P2 失败恢复及当前仪器真实 UI 删除，P3 收件协议，另 7 项手机 view |
| 实际 scope diff 空白检查 | PASS；`diff-check-final.log`（无诊断输出） | 先前 App whitespace 已解决；本次文档更新后另执行 `git diff --check` |

原 `npm run e2e:build` 在子代理环境遇到 `npm_config_user_agent=npm/undefined` 导致版本识别错误。最终使用 `env -u npm_config_user_agent node node_modules/@electron-forge/cli/dist/electron-forge.js package` 成功构建：日志包含系统检测、识别 `npm@12.2.0`、webpack 编译及打包完成；未跳过 check，也未修改全局配置。

E2E P2 原依赖已退役物流入口，本次改为现行仪器 UI 的等价删除流程并加强断言，验证失败不阻断本地、服务恢复后自动发布及删除后快照不残留；未恢复任何退役产品入口。部分旧 E2E 标题仍含“六类记录”，实际手机专项另明确验证批次/上门活动入口下线及四类记录展示，不能据旧标题理解为恢复六类入口。

浏览器视觉检查由 designer 实际执行，截图位于临时目录 `/private/var/folders/0t/r3m9w9497zd7ctt82lb39lmc0000gn/T/opencode/mobile-expansion-visual/`，主代理已抽查：360/390/768/1440 宽度无横向溢出，触控目标不小于 44px。本次沿用现有应用样式，未重设计。Skill 自动 style gate **未通过**：静态 lint 按页面规则误报既有 app 边框；inspect 受认证/TLS 限制，静态 dist 入口无 API，未得到业务页。因此不能宣称 inspect 通过；有效页面验证依据是真实 Playwright 截图与上述专项 E2E。

本次新增三个 Scenario 在 `scenario-map.mjs` 登记现有测试标题证据；“服务先升级且不自动降级”使用 `abstract: true` 指向本文的真实契约说明，不作为生产部署证据。既有 119 个矩阵缺口不在本次修复范围内。

已执行 `npm run verify:matrix`：741 场景、622 条有效证据、0 待验证、119 缺口；退出码 1，原因是既有缺口仍在，**不是全矩阵通过**。本次新增三条已登记有效证据，缺口数量从登记前 122 回到基线 119，缺口清单与 HEAD 完全相同。

未执行全量 `npm test`、真实客户文件测试或生产部署；未读取客户 xlsx/pptx。生产部署及回滚仍须另行授权。交付文档包括本文件、三份现行移动只读规格、场景登记表与生成矩阵；归档 v1 design 保持不变。
