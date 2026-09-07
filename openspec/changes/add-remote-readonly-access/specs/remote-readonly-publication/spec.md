## Purpose

在负责人明确授权时，将本机唯一权威 SQLite 的字段白名单业务投影有序发布为可撤回的远程只读快照，同时保持桌面离线业务和本机数据权威不变。

## ADDED Requirements

### Requirement: 默认关闭且经知情选择后发布
系统 MUST 默认禁用远程发布。仅在负责人对选定云端与字段白名单作出明确、知情的启用确认后，系统 SHALL 发布只读投影；系统 SHALL NOT 进行远程业务写入、导入、导出、删除本地数据、原始数据库下载或恢复。

#### Scenario: 未启用时不外发
- **WHEN** 负责人未确认启用远程发布而本机业务发生变化
- **THEN** 系统不向远程发送业务投影

#### Scenario: 启用仅发布许可字段
- **WHEN** 负责人确认选定云端与字段白名单后启用发布
- **THEN** 系统仅发布许可字段的只读投影，且本机 SQLite 仍是唯一业务事实源和唯一写入方

### Requirement: 发布数据来自一致快照且不泄露原始库
系统 SHALL 从一致的本机在线备份生成发布内容，并仅传输批准清单与 JSONL 投影 DTO；系统 MUST NOT 上传 SQLite、SQL、数据库模式、扩展、压缩归档或用户提供的文件路径。

#### Scenario: 生成发布内容
- **WHEN** 系统开始一次发布
- **THEN** 远程接收的是批准清单与 JSONL 投影而非 SQLite 或原始数据库内容

### Requirement: 投影契约和容量在入口拒绝无效内容
系统 SHALL 在流入口严格验证契约、投影与存储版本、未知字段、重复 JSON 键、枚举、类型、字符串长度、标识符、引用、计数和校验和；同类型实体标识符重复、实际实体或关联计数与清单不符、日期或金额不符合规定格式且需强制转换的内容 MUST 被拒绝。超过 64 MiB 总量、100000 条实体记录、64 KiB 单行、4096 个 Unicode 字符的自由文本字段（不含任意备注）或 256 MiB 暂存配额的内容 MUST 在早期被拒绝，且不得静默截断。系统 SHALL 一次只处理一个接收与构建作业。

#### Scenario: 超限内容被拒绝
- **WHEN** 发布流超过声明的任一容量上限
- **THEN** 系统在激活前拒绝该作业且不截断内容

#### Scenario: 未知字段被拒绝
- **WHEN** 发布流包含契约未允许的字段
- **THEN** 系统拒绝该作业并保留最后有效快照

#### Scenario: 重复键、计数不符或格式强制转换被拒绝
- **WHEN** 发布流包含重复 JSON 键、同类型重复 ID、实体或关联计数与清单不符，或需要将非严格日期或金额格式强制转换
- **THEN** 系统拒绝该作业并保留最后有效快照

### Requirement: 远程仅构建受限投影存储
云端 SHALL 在隔离且受资源上限约束的工作者中验证上传后生成固定模式的只读 SQLite 投影；上传方 SHALL 无法提供 SQL、模式、扩展、归档或路径来影响构建。投影 SHALL 使用稳定标识符和引用、精确金额字符串、`yyyy-mm-dd` 业务日期及 ISO 审计时间。

#### Scenario: 有效投影被构建
- **WHEN** 接收完整且通过所有验证的发布流
- **THEN** 云端生成固定模式的只读投影，并保留数据的稳定引用和规定日期、金额表示

### Requirement: 桌面发布身份受到最小权限隔离
桌面 SHALL 仅以独立发布者凭据执行状态、心跳、创建上传和提交其自身作业，并读取提交所必需的自身绑定元数据（包括 `publisherId` 和 `authorizationEpoch`）；该凭据 MUST NOT 读取业务投影或认证管理数据，也 MUST NOT 签发、轮换或授予 `authorizationEpoch`，或决定远程业务权威。发布配置、凭据和队列 SHALL 位于业务数据库备份与恢复范围之外。

#### Scenario: 发布者请求越权数据
- **WHEN** 发布者凭据请求读取业务投影或认证管理数据
- **THEN** 系统拒绝该请求

### Requirement: 有序谱系和快照防止旧作业覆盖
系统 SHALL 将 `publisherId` 与 `authorizationEpoch` 用作发布授权顺序，并将 `databaseInstanceId`、`contentGenerationId` 作为 UUID 谱系标识而非排序依据；`businessRevision` 仅可在同一谱系内递增。系统 SHALL 在快照前分配递增的 `publicationSequence`，使 `snapshotId` 不可变，并为每次指针变更（包括回滚）分配递增的 `activationId`。

#### Scenario: 旧授权作业提交
- **WHEN** 已轮换 `authorizationEpoch` 的旧作业尝试提交
- **THEN** 系统拒绝该作业且不改变当前激活指针

#### Scenario: 同一谱系业务版本倒退
- **WHEN** 作业的 businessRevision 小于当前同谱系版本
- **THEN** 系统拒绝作业并保留最后有效快照

### Requirement: 提交和激活具备并发安全与幂等性
系统 SHALL 在接收和提交时强制当前 `publisherId`、`authorizationEpoch`、谱系、最新已签发作业及非递减 `businessRevision`，并以期望 `activationId` 进行比较交换。相同作业和校验和的重试 SHALL 幂等成功；相同作业但不同内容 MUST 被拒绝；系统 SHALL 在持久化和验证完成后原子切换当前指针，陈旧作业不得覆盖当前快照。

#### Scenario: 相同作业重试
- **WHEN** 已提交作业以相同校验和重试
- **THEN** 系统返回同一结果且不创建额外激活

#### Scenario: 并发陈旧提交
- **WHEN** 陈旧作业在更新后的 activationId 上尝试提交
- **THEN** 系统拒绝该提交并保持当前快照

### Requirement: 备份恢复和谱系确认阻止自动提升
本机恢复或清理 SHALL 先暂停并取消本地作业；恢复或清理任一操作产生新 `contentGenerationId` 时 MUST 标记为 `REQUIRES_LINEAGE_CONFIRMATION`。独立远程安全身份以近期 MFA 显式确认新谱系后，系统 SHALL 轮换 `authorizationEpoch` 使旧作业失效；系统 MUST NOT 从上传内容自动提升任何新代际。

#### Scenario: 恢复或清理后存在待上传代际
- **WHEN** 本机恢复或清理成功并产生新的 `contentGenerationId`
- **THEN** 系统不自动激活该代际，直到近期 MFA 明确确认并轮换 `authorizationEpoch`

### Requirement: 激活、回滚和保留最后有效快照
系统 SHALL 仅在完整快照有效后激活它，并在失败、磁盘空间不足或不兼容版本时拒绝新作业且保留最后有效快照；有意清空时，空快照也必须作为完整有效快照。系统 SHALL 保留当前快照、前一个兼容快照、替换后至少 30 分钟的快照及进行中引用，并以配额和垃圾回收回收其他内容。

#### Scenario: 构建失败
- **WHEN** 新快照未完成验证或云端磁盘空间不足
- **THEN** 系统拒绝激活并继续提供最后有效快照

#### Scenario: 兼容历史回滚
- **WHEN** 受授权的控制操作回滚到兼容历史快照
- **THEN** 系统创建新的 `activationId`，并使所有进行中作业（包括同一源谱系作业）无效，且不重新授权旧谱系

#### Scenario: 回滚后同源旧作业提交
- **WHEN** 回滚前已开始的同一 `contentGenerationId` 作业尝试提交
- **THEN** 系统拒绝该作业且不改变新的 `activationId`

### Requirement: 停用和云端删除具有独立确认状态
停用发布时，本地 SHALL 立即停止新发布，但离线时 MUST NOT 承诺远程已撤销；系统 SHALL 分别显示本地已停止与云端已确认状态。云端确认停用 SHALL 轮换 `authorizationEpoch`、阻止旧作业并保留标记为暂停的最后有效快照；重新启用 MUST 重新认证且不得重放旧队列。本地清理不等于云端删除。

#### Scenario: 离线停用
- **WHEN** 负责人在云端不可达时停用发布
- **THEN** 系统立即停止本地新发布并显示云端撤销尚未确认

#### Scenario: 再次启用
- **WHEN** 已确认停用后负责人重新启用发布
- **THEN** 系统要求新的认证，且不重放停用前队列

### Requirement: 云端子集删除和撤回需要明确确认
系统 SHALL 提供独立的、明确确认的云端子集删除/撤回控制；该控制在近期 MFA 后 MUST 原子禁用发布、轮换 `authorizationEpoch` 并使所有排队和进行中作业失效，随后撤回当前和历史版本、阻止新读取并撤销游标、URL 与暂存访问；垃圾回收和保留期不得延迟访问撤销。系统 SHALL 按已定义保留期清除暂存、服务端留存副本和备份；重新发布 MUST 等待近期 MFA 的显式重新启用。系统 MUST 告知不能撤回已送达手机数据或截图、不能擦除保留期未满的提供商备份，且不得承诺磁盘取证擦除。

#### Scenario: 确认云端撤回
- **WHEN** 负责人以近期 MFA 明确确认云端子集删除
- **THEN** 系统撤回所有远程版本并撤销其访问游标和 URL，同时报告保留期限制

#### Scenario: 删除与上传提交竞争
- **WHEN** 云端子集删除完成后，先前排队或进行中的上传作业尝试提交
- **THEN** 系统拒绝提交，当前快照仍保持已撤回状态

### Requirement: 新鲜度仅来自已验证的当前源
云端 SHALL 记录激活时的 `lastPublishedAt`、有效源端报告时的 `lastSourceSeenAt`，并仅在源指纹与当前快照匹配时更新 `sourceConfirmedAt`。源指纹 SHALL 包含 `databaseInstanceId`、`contentGenerationId`、`businessRevision`、批准显示设置摘要、固定业务时区的 businessDate 及 projectionVersion；系统每 60 秒以 60 秒过期的一次性云端挑战要求桌面进行新鲜读取，且不得以排队心跳重放确认。无变化确认 SHALL 不重新发布；时钟健康失效或出现显著跳变时，系统 MUST NOT 将新鲜度表述为健康，直至时间已校正并重新验证。

#### Scenario: 匹配当前快照的源确认
- **WHEN** 桌面在未过期挑战后报告与当前源指纹一致的新鲜读取
- **THEN** 云端更新 sourceConfirmedAt 而不创建新的发布

#### Scenario: 过期挑战报告
- **WHEN** 桌面使用已过期或已使用的挑战报告源状态
- **THEN** 系统不更新 sourceConfirmedAt

#### Scenario: 时钟健康失效
- **WHEN** 云端或桌面检测到显著时钟跳变或时钟健康失效
- **THEN** 系统不将新鲜度标记为健康，直到时间校正并完成新的有效验证

### Requirement: 新鲜度状态和交付目标不夸大运行状况
新源 SHALL 显示为更新中；观察到待更新超过 5 分钟 SHALL 显示延迟；10 分钟没有有效报告 SHALL 显示源不可用或可能陈旧，且不得断言桌面已关闭。暂停、谱系待确认、发布失败和无快照 SHALL 为独立状态且不得被心跳清除。健康条件下变更可见目标为 5 分钟，仅适用于桌面运行、容量被接受、网络至少 10 Mbit/s 且已验证 ECS 资源；部署负载测试 SHALL 是启用闸门而非已达成声明。

#### Scenario: 长时间没有有效源报告
- **WHEN** lastSourceSeenAt 后超过 10 分钟没有有效报告
- **THEN** 系统显示源不可用或可能陈旧，且不将其描述为桌面已关闭
