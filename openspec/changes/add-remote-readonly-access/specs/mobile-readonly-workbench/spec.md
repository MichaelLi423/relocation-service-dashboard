## Purpose

为单一远程使用者提供独立于桌面指挥台的手机只读工作台，围绕搬迁项目概览、查找和合同财务及执行详情组织信息，并通过封闭字段白名单、明确快照时效及无离线业务缓存约束保护已发布数据。

## ADDED Requirements

### Requirement: 独立的项目中心只读信息架构
手机工作台 SHALL 仅有“概览”和“项目”两个业务主导航入口；项目详情 SHALL 是从列表进入的独立页面，按“项目概况”“合同与掉票”“执行与维修”纵向分组。系统 SHALL 使用项目卡片和带字段标签的记录组，不照搬桌面常驻上下文、横向泳道或宽表格。安全与同步控制设置仅属于独立控制平面，不构成第三个业务主导航。

#### Scenario: 从概览查找并阅读项目
- **WHEN** 已认证使用者从概览进入项目列表并选择一个项目
- **THEN** 系统展示该项目的独立详情及三个纵向分组
- **AND** 返回列表时保留本次有效会话与快照内的已应用筛选、分页和阅读位置

### Requirement: 概览采用既有指标和明确下钻范围
概览 SHALL 展示项目总数、进行中项目数、待验收项目数、待掉票项目数和“待掉票金额（USD）”。项目总数 SHALL 进入全部项目，待验收与待掉票数量 SHALL 分别进入对应主状态列表；进行中数量仅展示，SHALL NOT 暗含本次未提供的多状态筛选。进行中指未完成且未取消项目，不等于财务指标的统计范围；系统 SHALL NOT 新增趋势、瓶颈判定、完成率或自动待办。

#### Scenario: 点击状态数量
- **WHEN** 使用者点击待掉票项目数
- **THEN** 项目列表应用 `pending_invoice` 主状态筛选
- **AND** 待掉票金额仍明确是独立财务口径，不冒充该状态项目的金额合计

### Requirement: 项目查询和分页仅使用批准条件
项目列表 SHALL 仅按客户名称、ECC、临时编号搜索，按单个主状态和区域筛选，提供“最近更新”“计划上门日期升序”“计划上门日期降序”排序；区域选项 SHALL 为全部区域以及 `East`、`South`、`West`、`Central`、`North`，不得新增自由文本、未填区域或待调整筛选。全部区域 SHALL 包含未填和历史待调整项目，历史区域原文不得外发。项目分页 SHALL 固定每页 20 个，显示结果总数和上一页／下一页；计划上门日期为空的项目在日期排序时置后。筛选 SHALL 具有展开标题、已应用条件、“应用筛选”“清除筛选”；变更条件后回到第一页，不在手机持久化搜索历史。

#### Scenario: 搜索与筛选共同生效
- **WHEN** 使用者输入客户名称、选择主状态及区域并应用筛选
- **THEN** 返回符合全部已应用条件的第一页且至多 20 个项目，并显示总数
- **AND** 不把当前页内过滤误当完整结果，不搜索联系人、地址、工程师或其他未批准字段

#### Scenario: 清除条件并按上门日期排序
- **WHEN** 使用者清除筛选并选择计划上门日期升序
- **THEN** 系统从全部项目第一页按计划上门日期升序展示，未填日期置后
- **AND** 卡片显示客户名称、ECC 或明确标注的临时编号、主状态、未进单／未进单先执行标识、区域和计划上门日期

### Requirement: 发布与读取遵循封闭业务字段白名单
系统 MUST 在发布投影、查询结果、搜索索引、错误和日志边界执行下表的封闭业务字段白名单；未列字段 SHALL NOT 发布或参与远程查询、搜索、错误及日志，不得先上传完整本地 DTO 再仅在 UI 隐藏。允许字段也 SHALL NOT 作为业务值写入错误或日志；查询条件的业务值同样不得记录。下表标识符为字段契约锚点，源契约位于 `src/shared/ipc.ts`，不授权公开整个 IPC 或本机存储结构。发布／认证协议自身的技术字段仅遵循 `remote-readonly-publication` 和 `remote-readonly-access` 的独立契约，不得借其携带业务字段。

| 字段组／源契约 | 唯一允许字段及约束 |
| --- | --- |
| 读取技术信封 | `snapshotId`、`activationId`、`businessRevision`、`generatedAt`、`lastPublishedAt`、`lastSourceSeenAt`、`sourceConfirmedAt`；分页 `total`、`nextCursor`、`limit`、`pageSize`；分区 `kind`、`projectId`；发布／访问状态与稳定错误码仅引用对应能力定义 |
| 概览 `WorkbenchV2OverviewDto` | `metrics.totalProjects`、`metrics.activeProjects`、`metrics.pendingAcceptance`、`metrics.pendingInvoice`、`metrics.pendingAmount`；不含阶段平均时间、提醒统计或提醒预览 |
| 项目识别 `WorkbenchProjectRow` | `id`、`customerName`、`ecc`、`tempNo`、`status`、`formallyEntered`、`preEntryExecution`、`planVisitAt`；客户名称和项目业务编号是必要识别例外 |
| 项目区域与排序 | `region` 仅允许五个固定枚举或 `null`；`regionNeedsAdjustment` 保留历史待调整事实但不发布原文；`updatedAt` 仅作技术排序／诊断，不表示关联记录全部最后更新或来源确认 |
| 项目财务与进单 | `contractAmount`、`entryAmountSnapshot`、`finalAmount`、`invoicedAmount`、`entryAt` |
| 项目关联计数 | `counts.batches`、`counts.instruments`、`counts.orders`、`counts.repairs`、`counts.invoices`、`nonBlocking.repairs`；不含 `activities`、`nonBlocking.pendingShipTo` 或 `nonBlocking.qrUnmarked` |
| `WorkbenchV2ProjectDetailDto.detail` 合同与计划 | `contractStartDate`、`contractEndDate`、`planVisitAt`、`planTransportAt`、`plannedInstallAt`、`actualInstallDoneAt`；不发布旧别名 `plannedInstallDoneAt` |
| 详情准备、范围与终态事实 | `managerApproved`、`siteConfirmed`、`isTemporaryStorage`、`acceptanceReport`、`acceptanceReportDate`、`temporaryInstrumentCount`、`temporaryHasUps`、`cancelledAt` |
| 项目手工提醒 | `reminderAt`、派生布尔值 `hasReminder`；后者仅表示本机当前提醒日期或备注任一存在，不携带备注内容 |
| `WorkbenchV2SectionRow` 公共字段 | `kind`、`id`、`projectId`；仅以下五个分区，不含独立模块或跨项目历史 |
| `batches` | `planTransportDate`、`startedAt`、`appliedAt`、`originalPrice`（合同预算价）、`discountedPrice`（物流成交价）；两项金额均为人民币 |
| `instruments` | `batchId`、`name`、`model`、`serialNo`、`ups`、`qrRequested` |
| `orders` | `orderType`、`serviceOrderNo`、`orderedAt`；仅当前项目关联记录 |
| `invoices` | `amount`、`invoicedAt`、`active`、`revokedAt`、`lastModifiedAt` |
| `damage_items` | `instrumentId`、`instrumentName`、`serialNo`、`issueStatus`、`registeredAt`、`partNumber`、`partQuantity`、`partAmount`、`partCurrency`、`partStatus` |

仪器名称、型号、序列号和备件号 SHALL 仅作为定位项目内仪器及维修事项的必要详情例外，不扩大项目搜索。技术 ID SHALL 用于关联，不冒充可读业务编号。系统 SHALL 明确排除全部标签及目录、联系人、地址、目的 Ship-to、工程师／申请人／操作者姓名、运输公司、厂商、服务级别、自由备注与原因、暂定仪器名称／型号、源文件、附件、文件路径、导入样本和审计详情；`acceptanceReport` 仅为报告是否存在的事实，不授权报告文件访问。

#### Scenario: 未批准字段不能旁路进入远程端
- **WHEN** 本机 DTO 含有联系人、地址、标签、提醒备注、操作者姓名或源文件信息
- **THEN** 发布内容和查询结果不包含这些字段或其业务值，搜索不使用它们，错误与日志也不泄露它们
- **AND** 发布载荷若携带未知业务字段则被拒绝，最后有效快照不受影响

#### Scenario: 历史区域只显示待调整
- **WHEN** 项目区域存在非空历史原文且不属于五个固定枚举
- **THEN** 发布 `region=null` 与 `regionNeedsAdjustment=true`，手机显示“待调整”且全部区域列表仍包含该项目
- **AND** 未填写区域显示“未填写”，不将二者混淆或上传历史原文

### Requirement: 财务展示保持正式领域口径与精确金额
系统 SHALL 以精确十进制金额字符串传输和展示金额，保留两位小数，金额运算 SHALL 使用精确定点语义而非二进制浮点。合同与掉票 SHALL 明示 USD，物流 SHALL 明示人民币，备件 SHALL 使用 `partCurrency` 且缺币种时明确“币种未填写”，不得猜测折算。空金额 SHALL 显示“未填写”而非 0；合同金额及物流成交价允许 0，物流成交价允许空值，遵循当前 `project-financial-closure` 与 `relocation-execution` 正式规格，不沿用旧说明收紧规则。

`pendingAmount` 与详情“尚待掉票” SHALL 复用 `project-financial-closure` 的“待掉票金额指标仅由仍存在项目的有效财务事实计算”、`workbench-interface` 的“待掉票指标仅由有效关联财务事实计算”及 `operational-reporting` 的有效掉票／取消排除口径；不得因现有实现条件不同而新增领域公式或额外资格过滤。SHALL 排除已取消项目及孤立／脏财务事实，纳入已完成但仍有有效待掉票余额的项目，不以“进行中”或 `pending_invoice` 状态筛选替代；无项目时为 0。最终可确认金额为空的详情 SHALL 显示“无法计算：最终可确认金额未填写”，概览 SHALL 明示仅汇总可计算的有效待掉票余额。投影适配的合成数据契约验证 SHALL 覆盖这些边界，而非仅比较实现输出。

#### Scenario: 零金额与未填写分别展示
- **WHEN** 当前快照含 0 合同金额、空最终可确认金额以及空或 0 物流成交价
- **THEN** 手机分别显示带币种的零金额和“未填写”，详情尚待掉票显示无法计算的原因
- **AND** 不使用合同金额替代最终可确认金额，也不把空成交价当作免费物流

#### Scenario: 完成项目余额与无效财务事实
- **WHEN** 投影适配验证包含有余额的已完成项目、已取消项目、孤立财务事实及无项目的独立用例
- **THEN** 概览保留已完成项目有效余额，排除已取消和孤立事实，无项目用例为 0
- **AND** 手机的指标标签、纳入范围与正式财务规格一致，不从桌面实现缺陷复制新规则

### Requirement: 详情业务事实不被解释为新生命周期
详情 SHALL 分别标注当前合同金额、进单金额快照、最终可确认金额、累计有效掉票。掉票记录 SHALL 显示有效／已撤销，撤销记录标注“不计入累计有效掉票”，`counts.invoices` 标注为包含撤销历史的记录数。已完成 SHALL 仅表示当前主状态，不推断全额掉票、客户开票、回款或所有现场工作完成。备件金额 SHALL 不冒充已发生维修费用，只有“已使用”备件计费的既有规则不变；`nonBlocking.repairs` SHALL 标注“未关闭维修事项”，不等同主状态“维修中”。

暂定仪器数量与实际登记数量 SHALL 分开；系统 SHALL NOT 据此生成完成率、逐台拆装进度、物流到达状态或自动义务。主状态、开单类型、维修事项和备件状态 SHALL 按既有领域含义显示中文标签，而非直接显示字段名或英文枚举。业务日期 SHALL 为 `yyyy-mm-dd`；技术时间 SHALL 有明确时区。可空布尔值 SHALL 区分“是”“否”“未填写”；加载中不得显示成“否”或“未填写”。技术更新时间不得替代业务日期或源端确认。

#### Scenario: 阅读已完成项目的掉票与维修
- **WHEN** 已完成项目仍有待掉票余额、已撤销掉票及尚未使用的备件
- **THEN** 系统保持主状态与各项财务事实分别可读，不显示“已全额回款”或把未使用备件计作已发生维修费用
- **AND** 已撤销记录及包含其历史的记录数量不会被标成有效掉票次数

### Requirement: 手工提醒仅展示日期及存在性
手机 SHALL 仅在项目详情使用 `reminderAt` 和 `hasReminder` 展示已有手工提醒；有日期显示“手工提醒日期”，仅有备注显示“有手工提醒，未填写日期；内容仅在本机查看”，无提醒显示“未设置手工提醒”。手机 SHALL NOT 发布或显示 `reminderNote`、`reminderDueClass`、临期设置、提醒统计、泳道或提醒筛选，也 SHALL NOT 根据缺字段、二维码、维修或物流费用创建提醒或自动待办。

#### Scenario: 只有备注的既有提醒
- **WHEN** 本机项目当前只有手工提醒备注而没有提醒日期
- **THEN** 投影只传递 `hasReminder=true` 和空 `reminderAt`，手机提示提醒存在但内容仅在本机查看
- **AND** 不传递备注或到期分类，不生成新的业务义务

### Requirement: 详情记录有界按需读取
项目详情的物流批次、仪器、开单、掉票和损坏／维修记录 SHALL 按需展开，各分区每页 20 条并显示数量及分页控件；系统 SHALL NOT 为概览或打开一个详情而预取全部项目或全部子记录。分区 SHALL 使用单列记录卡及带标签的字段行，不压缩大表。已展开分组、分页控件及重试动作 SHALL 有对应分区的可访问名称。

#### Scenario: 展开高记录量项目的物流记录
- **WHEN** 使用者展开包含多页记录的物流分区
- **THEN** 只读取当前快照下该分区的一页，显示总数并允许逐页阅读
- **AND** 其他尚未展开分区不会全量加载，缺失价格或日期不导致已有记录消失

### Requirement: 窄屏可读性与可访问交互
登录、概览、项目列表、详情、筛选和异常页面 SHALL 在 360px 与 390px CSS 视口宽度下无页面级横向滚动；长客户名称、ECC、序列号和金额 SHALL 可换行完整阅读。系统 SHALL 沿用现有深绿／灰白中文视觉体系，正文与输入文字至少 16px、辅助文字至少 14px、触摸目标至少 44×44px，并支持文字放大和页面缩放。状态 SHALL 同时有文字与颜色，控件 SHALL 有中文标签、可见键盘焦点和语义化展开状态，不能仅靠占位文字、悬停或图标。系统 SHALL 将详情入口焦点移至标题并在返回时恢复列表上下文，异步加载与错误 SHALL 可被辅助技术感知；不要求动画，减少动态效果偏好 SHALL 被尊重。

#### Scenario: 小屏与辅助技术阅读长内容
- **WHEN** 在 360px 和 390px 视口以长名称、长编号及大金额构造数据验证主要页面并放大文字
- **THEN** 信息不被缩成宽表或裁切，控件触摸目标达标，键盘和辅助技术能识别标签、状态、分组展开及错误
- **AND** 无需横向拖动页面才能读关键字段，固定导航不遮挡焦点或操作

### Requirement: 数据时间明确区分生成发布与来源确认
业务页面 SHALL 显示当前 `snapshotId` 对应的“数据生成时间”`generatedAt`、“云端发布时间”`lastPublishedAt`、“最近来源报告”`lastSourceSeenAt` 和“当前数据来源确认时间”`sourceConfirmedAt`，后两项不得混用；技术详情可收起但入口 SHALL 可见。生成时间仅为来源诊断，发布时间仅表示云端激活，来源报告表示云端接受过新鲜源报告，来源确认只表示当前快照匹配最新源指纹。缺失时间 SHALL 明示未确认，不使用手机时间、本地项目更新时间或普通请求时间补齐。

每 60 秒源检查及无变化确认 SHALL 遵循 `remote-readonly-publication`，普通云端／手机 GET 不得更新来源健康。无变化报告确认当前快照 SHALL 不要求重新发布；指纹中的业务日期或批准设置不授权新增手机提醒到期分类或设置功能。

#### Scenario: 无业务变化的来源确认
- **WHEN** 云端接受匹配当前快照的新鲜源报告且没有数据变化
- **THEN** 来源报告与来源确认时间按契约更新，数据生成和云端发布时间保持原义，不产生新发布
- **AND** 仅刷新手机页面不会再次推进来源报告或来源确认时间

### Requirement: 同一阅读上下文固定快照并由用户切换
概览、列表、详情和分区分页 SHALL 绑定同一 `snapshotId`。检测到新版本 SHALL 仅提示“有新数据可查看”并提供“刷新到新数据”，不得自动替换当前业务视图；新版本的生成、发布或来源确认时间 SHALL NOT 移贴到仍在阅读的旧快照上。用户明确刷新成功后 SHALL 清除旧游标和分区数据，保留可复用的筛选并从新版本第一页读取；失败不得混合版本。`SNAPSHOT_EXPIRED` SHALL 显示“当前数据版本已不可用，请刷新”，停止旧上下文继续查询并要求整体重载，而非把新详情补入旧列表。

#### Scenario: 阅读期间发布新快照
- **WHEN** 使用者正在阅读旧快照详情且云端激活新版本
- **THEN** 页面提示可刷新但当前指标、列表、详情及分页继续绑定原版本
- **AND** 仅在明确刷新后整体切换；已过期快照则明确要求重载，不静默续用新游标

### Requirement: 时效与可用性状态不混淆
手机 SHALL 采用下表的独立状态及普通中文提示；有最后有效云端快照时，发布失败、桌面暂停或来源失联不等于无业务数据。健康条件下变化 5 分钟可见的目标及部署前提 SHALL 引用 `remote-readonly-publication`，不得宣称已通过性能验证；观察到新源待发布超过 5 分钟 SHALL 标记更新延迟，超过 10 分钟无有效报告 SHALL 标记“来源失联，数据可能过期”，不得断言桌面关机。暂停、来源代际待确认、发布失败和无快照 SHALL 不被健康心跳清除。

| 状态 | 必须可观察的反馈与行为 |
| --- | --- |
| 初次加载 | “正在读取项目…”；不抢先显示零结果或未填写字段 |
| 有效空快照 | “当前数据中暂无搬迁项目。”；不显示新建入口 |
| 筛选无结果 | “没有符合条件的项目。”并提供“清除筛选” |
| 分区无记录 | “当前数据中暂无掉票记录。”等对应记录说明，不引导手机录入 |
| 分区请求失败 | “掉票记录读取失败，请重试。”；保留同版本已成功读取分区，不显示为空 |
| 尚未发布 | “尚未发布可查看的数据，请在电脑端启用并发布。”；区别于有效空快照 |
| 服务或网络不可达 | “暂时无法连接，请检查网络和 WireGuard 后重试。”；不提供离线业务浏览或归因电脑关机 |
| 更新中／更新延迟 | 显示正在更新；待更新超过 5 分钟显示“更新延迟”，仍标明正在阅读的版本和时间 |
| 来源失联 | 超过 10 分钟无有效报告显示“来源失联，数据可能过期”；云端可达时仍可读最后有效快照 |
| 云端已确认暂停 | 明示“同步已暂停”；不暗示删除既有快照，不能从来源失联推断桌面已执行本地停止；本地已停止但云端未确认由桌面设置展示 |
| 来源代际待确认 | “来源已变化，等待确认。”；不自动切换，最后有效版本的时间继续展示 |
| 发布失败 | “新数据发布失败，正在显示上次有效数据。”；首次发布失败则同时显示尚无快照 |
| 项目不存在 | “当前数据中未找到该项目。”并提供返回列表，不伪装为服务故障 |

#### Scenario: 桌面不可用但云端仍有有效快照
- **WHEN** 超过 10 分钟无有效源报告而手机仍能访问云端有效快照
- **THEN** 手机保留云端查询能力并显示来源失联及数据时间，不以普通读取恢复来源健康
- **AND** 不推断电脑已关闭，也不将旧快照视作手机离线缓存

#### Scenario: 发布失败与空结果分别处理
- **WHEN** 新发布失败而当前有效快照恰好没有项目或当前筛选没有结果
- **THEN** 发布失败状态与对应空结果分别可见，不将失败吞成零统计
- **AND** 来源代际待确认或暂停状态也不会被一次健康报告清除

### Requirement: 认证入口不扩大业务权限
手机 SHALL 仅在 WireGuard 与受信 HTTPS 均满足时进入 `remote-readonly-access` 的密码加 TOTP 流程，不提供证书错误绕过、纯 HTTP 或仅 VPN 的替代入口。密码与“动态验证码” SHALL 有可访问中文标签并允许粘贴；仅密码成功不得显示业务数据。密码加离线恢复码 SHALL 仅进入受限 TOTP 重新登记，未完成新 TOTP 验证不得读取业务；忘记密码遵循受控主机恢复，不新增短信、邮件或其他登录方式。

#### Scenario: 密码或恢复码步骤尚未完成正常认证
- **WHEN** 使用者仅完成密码，或以密码与恢复码进入 TOTP 重新登记
- **THEN** 页面仅展示相应受限认证步骤，不展示概览或预取业务数据
- **AND** 无受信 HTTPS 或 WireGuard 时不提供绕过验证继续的按钮

### Requirement: 无业务写入口和无手机离线业务副本
手机 SHALL NOT 提供新建、编辑、删除、撤销、审批、提醒完成、标签管理、导入、备份恢复、数据清理、独立客户／Ship-to／二维码／地址模块、跨项目历史、报表制作、业务导出、打印、下载或分享入口，也不得调用相应业务变更接口。登录、恢复、安全与同步控制平面是唯一非业务例外，不授权业务变更或云端数据成为业务权威；明确撤回云端投影不等于删除业务记录。

业务响应 SHALL 使用 `Cache-Control: no-store`；浏览器 SHALL NOT 在 HTTP 缓存、localStorage、IndexedDB、Service Worker、持久化搜索历史或日志中保存业务内容。仅不含业务数据或凭据的技术静态资源可缓存。登出或会话过期 SHALL 清除业务内存与展示，提示“登录已过期，请重新登录”或已退出；页面离开及历史／bfcache 恢复 SHALL 使旧业务展示失效，恢复时先验证会话再重新读取，不显示历史业务页。系统 SHALL NOT 承诺擦除已截图或已送达设备的外部副本。

#### Scenario: 退出后使用浏览器返回
- **WHEN** 使用者退出、会话过期或恢复历史／bfcache 页面
- **THEN** 旧业务展示不可直接恢复；恢复路径先校验会话，仅在有效认证后重新读取
- **AND** 不以持久化业务缓存或搜索历史恢复内容，不承诺删除截图

#### Scenario: 查找桌面业务操作或离线功能
- **WHEN** 使用者在手机查看业务详情或断开网络后寻找编辑、导出、打印或离线浏览
- **THEN** 系统不提供这些入口或业务接口能力
- **AND** 安全与同步控制页面的存在不改变此业务只读边界
