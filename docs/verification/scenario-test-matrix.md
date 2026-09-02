# 正式规格基线的场景→测试矩阵

> 由 `npm run verify:matrix`（scripts/build-verification-matrix.mjs）自动生成，仅扫描 `openspec/specs/` 正式基线。
> 登记表：`docs/verification/scenario-map.mjs`。脚本校验每一条证据（文件存在且标题关键词出现），
> 找不到证据或证据无效时如实标记为缺口，不谎称覆盖。状态图例：✅ 有效证据 · ⏳ 待验证（真实源迁移/Windows）· ❌ 缺口。

## 汇总

| 指标 | 数量 |
| --- | --- |
| 能力 spec 数 | 15 |
| ADDED Requirements 场景总数 | 610 |
| 有有效测试证据（✅） | 598 |
| 待验证（⏳，真实源迁移 / Windows 验证） | 0 |
| 缺证据 / 证据无效（❌） | 12 |

### 待验证与阻塞项（诚实边界）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 10.4/10.5 Windows 打包验证 | ⏳ | macOS 开发机 Electron E2E 已通过（e2e/electron-smoke.spec.ts、e2e/import-wizard-flow.spec.ts、e2e/import-worker-runtime.spec.ts）；Windows 安装包与 Windows 操作系统账户保护未验证 |

## 按能力对照

### damage-repair-tracking

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 损坏/维修事项与单备件约束 | 一次损坏一条事项 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「一次损坏一条事项并关联仪器」 |  |
| 损坏/维修事项与单备件约束 | 多个备件多条事项 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「多个备件多条事项：每条事项只含一个备件」 |  |
| 事项字段与处理状态 | 字段完整记录 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「字段完整记录并保存」 |  |
| 事项字段与处理状态 | 已关闭未修复必须记录原因 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「已关闭未修复必须记录原因」 |  |
| 备件申请日期与备件处理状态 | 记录备件申请日期 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「记录备件申请时间到事项内，不建立独立备件申请对象」 |  |
| 备件申请日期与备件处理状态 | 备件处理状态流转 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「备件处理状态仅限四值流转」 |  |
| 备件申请日期与备件处理状态 | 仅已使用备件计入维修费用 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「仅已使用备件计入维修费用」<br>`tests/domain/operational-reporting.test.ts`「记录数量按事项计数，仅已使用备件金额计入维修费用」 |  |
| 数量与金额必填且大于零 | 数量与金额大于零才能保存 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「数量或金额为空、为 0 或为负数拒绝保存」 |  |
| 备件金额币种与固定汇率折算 | RMB 按固定汇率折算 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「RMB 按固定汇率 1 USD = 7.2 RMB 折算为 USD」 |  |
| 备件金额币种与固定汇率折算 | 币种边界 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「币种边界：仅限 USD 与 RMB」 |  |
| 合同金额为 0 时的维修限制 | 合同金额为 0 时仍可登记损坏 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「合同金额为 0 时仍可登记损坏，事项进入未处理」 |  |
| 合同金额为 0 时的维修限制 | 合同金额为 0 时禁止开始/完成维修 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「合同金额为 0 时禁止开始/完成维修」 |  |
| 合同金额为 0 时的维修限制 | 合同金额为 0 时禁止备件标记已使用 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「合同金额为 0 时禁止备件标记已使用」 |  |
| 合同金额为 0 时的维修限制 | 补齐正数合同金额后允许维修 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「补齐正数合同金额后允许开始/完成维修与标记已使用」 |  |
| 不阻塞项目生命周期 | 未完成处理不阻塞全流程流转 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「未完成处理不阻塞全流程流转，可在此后继续处理」 |  |
| 不阻塞项目生命周期 | 验收后继续报修/维修 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「验收后仍允许登记与继续维修，不影响验收/待掉票/完成状态」 |  |
| 维修报表统计口径 | 按事项记录数量与单条金额统计 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「按事项记录数量与单条金额统计（仅已使用计入）」 |  |
| 维修报表统计口径 | 合同占比计算 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「合同占比计算：100 ÷ 2000 = 5%」 |  |
| 维修报表统计口径 | 占比超过 100% 显示警告 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「占比超过 100% 允许如实显示并给出警告」<br>`tests/domain/operational-reporting.test.ts`「占比超过 100% 允许如实显示并给出警告」 |  |
| 维修上门活动 × 损坏/维修事项多对多关联 | 一次维修上门关联多个事项 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「一次维修上门关联多个事项，关联仅引用、不建立维修上门子记录」 |  |
| 维修上门活动 × 损坏/维修事项多对多关联 | 同一事项被多次维修上门关联 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「同一事项被多次维修上门关联」 |  |
| 维修上门活动 × 损坏/维修事项多对多关联 | 事项所属仪器不在活动仪器集合时拒绝关联 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「事项所属仪器不在活动仪器集合时拒绝关联，既有关联保持不变」 |  |
| 损坏/维修事项删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| 损坏/维修事项删除 | 未确认不删除 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 损坏/维修事项删除 | 删除时原子清理维修上门关联引用 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「确认后删除：事项从 countItems 统计消失，且仅指向该事项的维修上门关联被清理」 |  |
| 损坏/维修事项删除 | 删除不影响关联仪器与项目 | ✅ | `tests/domain/damage-repair-tracking.test.ts`「删除不影响关联仪器与搬迁项目」 |  |

### historical-data-import

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 七类历史数据完整覆盖 | 七类数据均进入导入计划 | ✅ | `tests/domain/import-validation.test.ts`「NormalizedRow → 七类记录计划」 | validatePlan 把七类规范化行构建为记录计划 |
| 七类历史数据完整覆盖 | 供应商来源并入物流类别 | ✅ | `tests/domain/import-validation.test.ts`「供应商只作物流参考」 | 供应商不构成第八类，运输公司并入物流类别 |
| 文件与粘贴输入统一规范化 | 文件与粘贴结果等价 | ✅ | `tests/domain/import-tasks.test.ts`「相同语义内容：文件与粘贴产生相同规范化计划摘要」 | 文件与粘贴共享同一规范化行模型，同内容计划摘要一致 |
| 文件与粘贴输入统一规范化 | 无业务键时使用稳定源行标识 | ✅ | `tests/domain/historical-data-import.test.ts`「无业务键时用源行键」 | 无业务键的行以源文件+sheet+行号标识（稳定源行身份） |
| 文件与粘贴输入统一规范化 | 仅有物理行位置时提示身份风险 | ✅ | `tests/domain/import-validation.test.ts`「POSITION_ONLY_IDENTITY」 | 无业务键且无 source_row_id → POSITION_ONLY_IDENTITY 警告（重排行风险） |
| ECC 聚合与来源优先级 | 同一 ECC 聚合为一个项目 | ✅ | `tests/domain/import-validation.test.ts`「同一 ECC 聚合为一个搬迁项目」 | ECC 为项目/合同聚合主键 |
| ECC 聚合与来源优先级 | 不同来源相同字段值一致 | ✅ | `tests/domain/import-validation.test.ts`「不同来源相同规范化值不产生冲突」 | 相同规范化值不产生来源冲突 |
| ECC 聚合与来源优先级 | 不同来源字段值冲突 | ✅ | `tests/domain/import-validation.test.ts`「不同合法值进入冲突并展示候选来源」 | 冲突必须显式选择或修正，不自动覆盖 |
| 错误冲突与警告分级 | 必填字段错误可定位 | ✅ | `tests/domain/import-validation.test.ts`「必填缺失可定位」 | 错误携带类别/字段/网格行/来源位置 |
| 错误冲突与警告分级 | 允许的价格异常仅警告 | ✅ | `tests/domain/import-validation.test.ts`「成交价格高于预算价格仅警告」 | 成交>预算为 warning，不阻断提交 |
| 错误冲突与警告分级 | 不允许忽略阻断项 | ✅ | `tests/domain/import-validation.test.ts`「错误或未解决冲突不得生成提交资格」 | error/conflict 阻断提交资格 |
| 关键字段和关联规则 | 缺少 ECC 阻止项目导入 | ✅ | `tests/domain/import-validation.test.ts`「缺 ECC 报必填错误并阻止导入」 | 项目缺 ECC 报必填错误 |
| 关键字段和关联规则 | 费用登记日期不可由月份推断 | ✅ | `tests/domain/import-validation.test.ts`「物流费用申请（登记）时间为目标必填」 | 仅月份无法推断具体登记日期，缺失为阻断错误 |
| 关键字段和关联规则 | 重复服务单号阻止导入 | ✅ | `tests/domain/import-validation.test.ts`「重复非空服务单号 → 冲突清单」 | 重复非空服务单号进入冲突清单 |
| 关键字段和关联规则 | 独立申请不强制关联 ECC | ✅ | `tests/domain/import-validation.test.ts`「二维码申请与 Ship-to 申请不强制关联 ECC」 | QR/Ship-to 申请无 ECC 字段不产生关联错误 |
| 关键字段和关联规则 | 二维码类型不得由数量猜测 | ✅ | `tests/domain/import-validation.test.ts`「二维码类型不得由数量猜测」 | 仅类型数量无具体类型 → 冲突 |
| 关键字段和关联规则 | 序列号地址更新不修改 Ship-to | ✅ | `tests/domain/import-validation.test.ts`「序列号地址更新不创建或修改 Ship-to」 | 地址更新只记录事实，不创建/修改 Ship-to 主数据 |
| 校验阶段零业务写入 | 反复校验不改变业务数据 | ✅ | `tests/domain/import-validation.test.ts`「反复执行不改变正式业务数据」 | 校验阶段零业务写入 |
| 校验阶段零业务写入 | 删除草稿不删除业务记录 | ✅ | `tests/integration/import-seven-category-flow.sqlite.test.ts`「删除草稿：工作区内容清除，正式业务库零接触」 | 删除草稿只清工作区，正式业务库零接触 |
| 规范化计划摘要与校验封存 | 修改单元格使封存失效 | ✅ | `tests/domain/import-seal.test.ts`「草稿单元格修改 → seal 立即失效」 | seal 绑定草稿修订，单元格修改即失效 |
| 规范化计划摘要与校验封存 | 目标数据变化使封存失效 | ✅ | `tests/domain/import-seal.test.ts`「目标业务修订变化 → seal 失效」 | 任一目标业务写入使旧 seal 无效 |
| 规范化计划摘要与校验封存 | 相同语义内容产生稳定摘要 | ✅ | `tests/domain/import-seal.test.ts`「相同语义内容产生稳定计划摘要」 | 相同语义内容产生稳定计划摘要与 seal 绑定摘要 |
| 七类数据一次原子提交 | 最后一类写入失败时全部回滚 | ✅ | `tests/domain/import-commit.test.ts`「零部分写入」 | 8.45 故障注入逐阶段验证：任一 writer 失败整体回滚零部分写入 |
| 七类数据一次原子提交 | 审计写入失败时全部回滚 | ✅ | `tests/domain/import-commit.test.ts`「零部分写入」 | 8.45 run_audit 阶段注入失败整体回滚零部分写入 |
| 七类数据一次原子提交 | 写后数量不一致时全部回滚 | ✅ | `tests/domain/import-commit.test.ts`「零部分写入」 | 8.45 reconcile 阶段对账失败整体回滚零部分写入 |
| 七类数据一次原子提交 | 安全快照失败时不得开始提交 | ✅ | `tests/domain/import-commit.test.ts`「快照失败：禁止开始业务写入」 | 快照失败禁止开始业务写入、草稿保持 sealed |
| 幂等重跑与安全修正 | 相同计划重复执行零写入 | ✅ | `tests/domain/import-commit.test.ts`「相同计划重跑：幂等跳过」 | 相同计划重跑幂等跳过、零业务写入 |
| 幂等重跑与安全修正 | 安全 forward-fix 更新目标 | ✅ | `tests/domain/import-commit.test.ts`「安全 forward-fix：同来源键修正更新目标字段」 | 同来源键 forward-fix 只更新同 source key 记录 |
| 幂等重跑与安全修正 | 人工修改目标时阻止覆盖 | ✅ | `tests/domain/import-commit.test.ts`「人工修改目标阻塞覆盖」 | 人工修改目标阻止覆盖且人工值保留 |
| 幂等重跑与安全修正 | 缺少旧目标快照时阻止覆盖 | ✅ | `tests/domain/import-commit.test.ts`「旧记录缺少可信基线阻塞覆盖」 | v9 快照缺失阻止覆盖 |
| 状态与业务日期确定性重建 | 状态由事实重建 | ✅ | `tests/integration/import-seven-category-flow.sqlite.test.ts`「主状态由导入事实确定性重建」<br>`tests/domain/historical-data-import.test.ts`「项目状态由事实推导重建」<br>`tests/domain/historical-data-import.test.ts`「导入状态真实变化与项目写入同事务记录最小转换审计」 | 主状态由导入事实确定性重建 |
| 状态与业务日期确定性重建 | 导入时间不改变统计月份 | ✅ | `tests/integration/import-seven-category-flow.sqlite.test.ts`「导入时间只进审计且不改变报表月份」 | 报表月份按源业务时间，不因导入时间改变 |
| 状态与业务日期确定性重建 | 可选源业务日期缺失保持为空 | ✅ | `tests/domain/historical-data-import.test.ts`「源业务时间缺失（可选）时保留为空」 | 可选源业务日期缺失保留为空，不用导入时间填充 |
| 本地用户审计与历史事实归属分离 | 提交审计归属本地用户 | ✅ | `tests/domain/import-commit.test.ts`「账号审计与业务工作量分离」<br>`tests/integration/import-seven-category-flow.sqlite.test.ts`「草稿创建人与最终提交人分列审计」 | import_run 记录内部本地用户 ID 与确认时用户名快照 |
| 本地用户审计与历史事实归属分离 | 导入事实不计作手工工作量 | ✅ | `tests/domain/import-commit.test.ts`「业务事实 source=history_import」 | 业务事实 source=history_import、不计 actor 手工工作量 |
| 本地用户审计与历史事实归属分离 | 会话在提交前失效 | ✅ | `tests/main/import-wizard-ipc.test.ts`「登出/恢复清空会话后 seal 失效」 | 会话失效取消活动读取并 invalidate seal |
| Excel 输入安全边界 | 公式不被执行 | ✅ | `tests/domain/import-tasks.test.ts`「DDE 与外部工作簿引用公式标记为不可安全读取」<br>`tests/security/import-malicious-workbook.test.ts`「公式安全」 | DDE/外部引用/无缓存公式不执行不联网，置空并报问题 |
| Excel 输入安全边界 | 标识符保留前导零 | ✅ | `tests/domain/import-tasks.test.ts`「按文本保留前导零」 | ECC/服务单号/Account ID/序列号按文本保留前导零 |
| Excel 输入安全边界 | 超出资源上限时安全拒绝 | ✅ | `tests/domain/import-zip-preflight.test.ts`「ZIP 炸弹」<br>`tests/domain/import-zip-preflight.test.ts`「行数超过上限拒绝」 | 有界预检按文件/entry/展开/压缩比/sheet/行列单元格上限安全拒绝 |
| 空导入与失败结果明确 | 空计划不可提交 | ✅ | `tests/domain/import-validation.test.ts`「空导入阻止提交」 | 七类均确认无数据且总数为零 → 空导入阻止提交 |
| 空导入与失败结果明确 | 提交异常退出后重新判定 | ✅ | `tests/domain/import-commit.test.ts`「无成功审计 → 完整回滚并要求重新完整校验」<br>`tests/domain/import-commit.test.ts`「成功审计与完整事务同时存在」 | 中断后按成功审计判定完整成功或完整回滚 |

### history-import-wizard

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 受信窗口内的唯一用户入口 | 负责人从数据管理进入 | ✅ | `tests/renderer/app.test.tsx`「历史导入返回后刷新 overview 与项目首页并恢复入口焦点」 | app 级测试：数据管理提供历史数据导入入口并以全窗口 route 打开 |
| 受信窗口内的唯一用户入口 | 非受信窗口不能进入 | ✅ | `tests/main/import-wizard-ipc.test.ts`「未登录时导入向导全部 invoke 通道拒绝」 | 非受信窗口/非受信 sender 不能进入导入向导 |
| 受信窗口内的唯一用户入口 | 非受信窗口不能调用导入能力 | ✅ | `tests/main/import-wizard-ipc.test.ts`「非受信 sender 拒绝」 | 非受信 sender 拒绝导入调用 |
| 受信窗口内的唯一用户入口 | 用户不再看到 CLI 路径 | ✅ | `tests/integration/historical-data-import.sqlite.test.ts`「外部迁移 CLI 已删除」 | 外部迁移 CLI 与构建脚本已删除，向导为唯一入口 |
| 保持工作台意图的全窗口七步向导 | 首次进入显示完整步骤 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「展示固定七步」 | 全窗口七步导航 |
| 保持工作台意图的全窗口七步向导 | 返回工作台保留导航上下文 | ✅ | `tests/renderer/app.test.tsx`「历史导入返回后刷新 overview 与项目首页并恢复入口焦点」<br>`tests/renderer/history-import-wizard.test.tsx`「展示固定七步、账号、保存状态、问题状态与返回确认焦点」 | 返回数据管理后恢复原工作台上下文与焦点 |
| 保持工作台意图的全窗口七步向导 | 步骤状态反映当前校验结果 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「展示固定七步、账号、保存状态、问题状态与返回确认焦点」 | 步骤状态按校验结果显示已阻断/通过/处理中 |
| 七类目标数据均可显式包含或跳过 | 项目与合同有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 七类步骤均可声明有数据（data）并展示专属字段 |
| 七类目标数据均可显式包含或跳过 | 项目与合同无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 七类步骤均可声明本次无数据（none） |
| 七类目标数据均可显式包含或跳过 | 开单记录有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：开单记录有数据 |
| 七类目标数据均可显式包含或跳过 | 开单记录无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：开单记录无数据 |
| 七类目标数据均可显式包含或跳过 | 掉票记录有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：掉票记录有数据 |
| 七类目标数据均可显式包含或跳过 | 掉票记录无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：掉票记录无数据 |
| 七类目标数据均可显式包含或跳过 | 物流费用有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：物流费用有数据 |
| 七类目标数据均可显式包含或跳过 | 物流费用无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：物流费用无数据 |
| 七类目标数据均可显式包含或跳过 | 序列号地址更新有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：序列号地址更新有数据 |
| 七类目标数据均可显式包含或跳过 | 序列号地址更新无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：序列号地址更新无数据 |
| 七类目标数据均可显式包含或跳过 | 二维码申请有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：二维码申请有数据 |
| 七类目标数据均可显式包含或跳过 | 二维码申请无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：二维码申请无数据 |
| 七类目标数据均可显式包含或跳过 | Ship-to 申请有数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：Ship-to 申请有数据 |
| 七类目标数据均可显式包含或跳过 | Ship-to 申请无数据 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid」 | 同 data/none 声明：Ship-to 申请无数据 |
| 版本化空白模板下载 | 下载当前版本空白模板 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「覆盖模板、文件/sheet、50k 进度取消和共用列映射」<br>`tests/domain/import-template.test.ts`「生成单个工作簿：填写说明 + 七个业务 sheet」 | 向导提供模板下载；模板生成器产出填写说明 + 七类业务 sheet |
| 版本化空白模板下载 | 选择受支持的模板版本 | ✅ | `tests/domain/import-template.test.ts`「模板版本可识别且为受支持版本」 | 当前版本模板识别为受支持 |
| 版本化空白模板下载 | 旧版本模板不能静默套用新规则 | ✅ | `tests/domain/import-tasks.test.ts`「旧版本模板识别为不支持」 | 旧版本模板报告版本问题而非静默套用新规则 |
| Excel 文件选择与工作表归类 | 选择包含七类数据的工作簿 | ✅ | `tests/domain/import-tasks.test.ts`「模板工作簿按 sheet 精确路由七类」<br>`tests/main/import-wizard-ipc.test.ts`「返回完整工作区 DTO」 | 工作簿按 sheet 路由七类并反映到工作区 DTO |
| Excel 文件选择与工作表归类 | 合并多个 Excel 文件 | ✅ | `tests/domain/import-tasks.test.ts`「两个文件合并」 | 多文件追加写入不丢失，重跑顺序无关 |
| Excel 文件选择与工作表归类 | 未知工作表需要人工决定 | ✅ | `tests/domain/import-tasks.test.ts`「未知 sheet 进入 UNKNOWN_SHEET 问题」 | 未知 sheet 待人工映射或排除，不猜测 |
| Excel 矩形区域复制粘贴 | 粘贴不含表头的矩形区域 | ✅ | `tests/domain/import-paste-parser.test.ts`「不是表头时全部行作为数据行」 | 未确认表头时全部行作为数据行 |
| Excel 矩形区域复制粘贴 | 粘贴区域可能包含表头 | ✅ | `tests/domain/import-paste-parser.test.ts`「首行表头确认：是表头时首行作为表头」 | 确认表头后首行作为表头、其余为数据行 |
| Excel 矩形区域复制粘贴 | 粘贴将覆盖已有值 | ✅ | `tests/domain/import-paste-parser.test.ts`「覆盖预检：触碰既有行范围时给出 wouldOverwrite」<br>`tests/domain/import-tasks.test.ts`「覆盖预检不通过时抛 PasteOverlayError」 | 覆盖模式预检触碰既有行给出 wouldOverwrite，超界拒绝不写入 |
| 文件与粘贴共用列映射和目标网格 | 文件列按已知字段匹配 | ✅ | `tests/domain/import-tasks.test.ts`「模板工作簿按 sheet 精确路由七类」<br>`tests/domain/historical-data-import.test.ts`「客户名称列别名」 | 已知字段按精确/别名匹配 |
| 文件与粘贴共用列映射和目标网格 | 未识别列由用户映射 | ✅ | `tests/domain/import-tasks.test.ts`「未知列进入 UNKNOWN_COLUMN 问题」 | 未识别列待人工映射或排除 |
| 文件与粘贴共用列映射和目标网格 | 文件与粘贴数据在同一网格合并 | ✅ | `tests/workspace/import-tasks-workspace.test.ts`「同一草稿先文件后粘贴」 | 同一草稿文件+粘贴两类来源在同一类别网格共存，来源定位可区分 |
| 文件与粘贴共用列映射和目标网格 | 多个来源映射到同一目标字段 | ✅ | `tests/domain/import-validation.test.ts`「不同来源相同规范化值不产生冲突」 | 多来源映射到同一目标字段，相同规范化值不冲突 |
| ECC 中心关联与独立记录边界 | 同一 ECC 聚合项目与合同来源 | ✅ | `tests/domain/import-validation.test.ts`「同一 ECC 聚合为一个搬迁项目」 | 项目与合同来源按 ECC 聚合为一个搬迁项目 |
| ECC 中心关联与独立记录边界 | 掉票和物流费用引用有效 ECC | ✅ | `tests/domain/import-validation.test.ts`「物流费用 ECC 可引用计划或目标库」 | 掉票/物流费用引用计划或目标库中唯一匹配的 ECC |
| ECC 中心关联与独立记录边界 | 必须关联的记录找不到 ECC | ✅ | `tests/domain/import-validation.test.ts`「掉票 ECC 未在计划或目标库中唯一匹配」 | 找不到唯一匹配 ECC → 阻断错误 |
| ECC 中心关联与独立记录边界 | 独立申请不被强制关联 ECC | ✅ | `tests/domain/import-validation.test.ts`「不强制关联 ECC」 | QR/Ship-to 独立申请不强制关联 ECC |
| 可编辑目标网格与局部重校验 | 在网格中修正错误单元格 | ✅ | `tests/main/import-wizard-ipc.test.ts`「patch 局部校验」 | 稀疏 cell patch 修正网格错误并触发局部重校验 |
| 可编辑目标网格与局部重校验 | 撤销网格修改 | ✅ | `tests/main/import-wizard-ipc.test.ts`「undo 整体撤销、redo 整体重做」 | 磁盘 checkpoint 支持整体 undo/redo |
| 可编辑目标网格与局部重校验 | 删除草稿行不删除业务数据 | ✅ | `tests/main/import-wizard-ipc.test.ts`「checkpoint/undo/redo 阶段正式业务库零写」<br>`tests/workspace/workspace-repository.test.ts`「删除行级联清理其单元格与问题」 | 删除草稿行只清工作区，正式业务库零写 |
| 错误、冲突与警告分层反馈 | 从问题面板定位错误单元格 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「四层问题反馈、定位和冲突候选处理」 | 问题面板定位并聚焦目标网格单元格 |
| 错误、冲突与警告分层反馈 | 定位时解除阻挡视图的筛选 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「搜索、ECC/问题筛选和错误接口驱动 provider 并聚焦目标单元格」 | 跳错误后按全部问题+空搜索重新读取窗口（不被既有筛选阻挡） |
| 错误、冲突与警告分层反馈 | 冲突要求明确决定 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「冲突候选处理」 | 冲突必须选择候选或修正 |
| 错误、冲突与警告分层反馈 | 警告不阻断提交资格 | ✅ | `tests/domain/import-validation.test.ts`「成交价格高于预算价格仅警告」<br>`tests/renderer/history-import-wizard.test.tsx`「warning 确认后只提交一次」 | warning 不阻断提交资格，确认后可提交 |
| 草稿自动保存与退出恢复 | 编辑后自动保存草稿 | ✅ | `tests/workspace/workspace-repository.test.ts`「每次自动保存返回递增修订号」 | 每次保存推进修订号与 lastSavedAt |
| 草稿自动保存与退出恢复 | 退出后继续上次导入 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「支持新建、继续、摘要和删除草稿」 | 首页支持继续上次草稿 |
| 草稿自动保存与退出恢复 | 删除草稿不影响业务数据 | ✅ | `tests/workspace/workspace-cleanup.test.ts`「用户删除草稿」 | 删除草稿连同摘要整体清除，不触碰正式业务记录 |
| 草稿自动保存与退出恢复 | 草稿保存失败时阻止误退出 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「保存失败时保留全窗口草稿并阻止误退出」 | 保存失败保留草稿并阻止误退出 |
| 会话失效后保留草稿并重新校验 | 编辑过程中会话失效 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「会话失效停止操作」 | 编辑中会话失效停止操作并保留草稿 |
| 会话失效后保留草稿并重新校验 | 会话恢复后继续草稿 | ✅ | `tests/main/import-wizard-ipc.test.ts`「重新登录后须重新完整校验」 | 会话恢复后草稿保留、seal 已失效须重新完整校验 |
| 最终摘要与明确确认 | 摘要展示七类导入范围 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「有效摘要要求范围」<br>`tests/main/import-wizard-ipc.test.ts`「返回完整工作区 DTO」 | 最终摘要展示七类导入范围与 seal 状态 |
| 最终摘要与明确确认 | 存在阻断问题时不能确认 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「seal 失效禁用」 | seal 失效/存在阻断时禁用最终确认 |
| 最终摘要与明确确认 | 用户修改数据后摘要失效 | ✅ | `tests/domain/import-seal.test.ts`「草稿单元格修改 → seal 立即失效」 | 用户修改数据使 seal/摘要失效 |
| 最终摘要与明确确认 | 用户明确确认后发起最终提交 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「warning 确认后只提交一次并展示结果」 | 明确确认后只发起一次最终提交 |
| 最终摘要与明确确认 | 最终提交失败回到可处理状态 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「提交中断后明确区分完整成功与完整回滚」 | 提交失败回到需重新校验的可处理状态 |
| 防止重复提交 | 连续触发确认导入 | ✅ | `tests/main/import-wizard-ipc.test.ts`「重复提交（同一草稿二次 submit）被拒绝」 | 重复 submit 被拒绝不二次写入 |
| 防止重复提交 | 提交期间不能继续修改草稿 | ✅ | `tests/main/import-wizard-ipc.test.ts`「提交不可取消」 | 提交（committing）期间不可取消且禁止修改 |
| 防止重复提交 | 中断后先核对再重试 | ✅ | `tests/domain/import-commit.test.ts`「无成功审计 → 完整回滚并要求重新完整校验」<br>`tests/domain/import-commit.test.ts`「成功审计与完整事务同时存在」 | 提交中断后先核对成功审计再判定，禁止自动重提 |
| 五万行输入的可观察进度与取消 | 读取五万行文件时显示进度 | ✅ | `tests/performance/import-50k-benchmark.test.ts`「50k 文件 worker：首个 progress 立即到达」 | 50k 文件 worker 持续报告阶段与行数 |
| 五万行输入的可观察进度与取消 | 取消五万行文件处理 | ✅ | `tests/performance/import-50k-benchmark.test.ts`「50k 文件 worker 中途取消」 | 50k 文件处理可取消，回滚到最后稳定修订 |
| 五万行输入的可观察进度与取消 | 取消完整校验 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「取消完整校验」 | validating 操作可取消并回到保存状态 |
| 十万行网格虚拟化的可观察可用性 | 打开十万行目标网格 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「100k 数据只通过 window provider 读取可见窗口」 | 10 万行网格只渲染可见窗口、DOM 有界 |
| 十万行网格虚拟化的可观察可用性 | 在十万行中搜索和定位错误 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「搜索、ECC/问题筛选和错误接口驱动 provider」 | 10 万行中搜索、ECC/问题筛选与定位错误 |
| 十万行网格虚拟化的可观察可用性 | 大表横向浏览保持记录身份可辨 | ✅ | `tests/performance/history-import-grid-benchmark.test.tsx`「横向冻结身份」 | 横向滚动保持行号/ECC 冻结可辨 |
| 完整键盘操作 | 仅使用键盘修正并定位错误 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「方向键、Tab/Shift+Tab、Enter/Escape 可预测」 | 方向键/Tab/Enter 键盘导航与编辑 |
| 完整键盘操作 | 键盘粘贴矩形区域 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「矩形选择与 Excel TSV 粘贴」 | Ctrl+V 粘贴矩形区域批量 patch |
| 完整键盘操作 | Escape 只取消当前编辑 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「Enter/Escape 可预测」 | Escape 只取消当前编辑不误提交 |
| 可访问的问题状态和焦点管理 | 不依赖颜色识别问题类型 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「错误与警告以文字和图标表达」 | 错误/警告以文字和图标表达，不依赖颜色 |
| 可访问的问题状态和焦点管理 | 对话内容关闭后恢复焦点 | ✅ | `tests/renderer/history-import-wizard.test.tsx`「返回确认焦点」 | 对话关闭后焦点恢复到触发元素 |
| 可访问的问题状态和焦点管理 | 异步状态可被感知且不抢夺焦点 | ✅ | `tests/renderer/history-import-virtual-grid.test.tsx`「编辑覆盖层在虚拟行卸载后仍保留焦点」 | 异步状态可感知（announcer），滚动/卸载不抢夺焦点 |

### local-data-persistence

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| Windows 桌面运行且不依赖远程服务 | 离线启动并完成核心操作 | ✅ | `tests/persistence/runtime-boundary.test.ts`「离线可用：无任何远程服务时本机 SQLite 全流程（写入→备份→关闭→重开）正常」 |  |
| Windows 桌面运行且不依赖远程服务 | 无网络时业务不中断 | ✅ | `tests/persistence/runtime-boundary.test.ts`「离线无远程依赖：领域与持久化源码不导入任何网络模块」 |  |
| 本机 SQLite 持久化 | 关闭重开后数据保留 | ✅ | `tests/persistence/connection.test.ts`「关闭并重开应用后数据保留（真实临时 SQLite）」<br>`tests/integration/relocation-project-lifecycle.sqlite.test.ts`「正式进单全流程落库（ECC/进单时间/快照/最终金额），关闭重开保留」<br>`tests/integration/runtime-lifecycle.sqlite.test.ts`「启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置」<br>`e2e/electron-smoke.spec.ts`「关闭并重开应用：无密码模式直接进入工作台，已有账号与数据保留」 |  |
| 本机 SQLite 持久化 | 数据保存于本机数据库 | ✅ | `tests/persistence/connection.test.ts`「数据库位于本机数据目录（不依赖远程存储）」 |  |
| 项目分类标签持久化与升级兼容 | 标签重命名保持稳定关联 | ❌ | — |  |
| 项目分类标签持久化与升级兼容 | 标签唯一性冲突零变化 | ❌ | — |  |
| 项目分类标签持久化与升级兼容 | 重命名不返回受影响项目列表 | ❌ | — |  |
| 项目分类标签持久化与升级兼容 | 重启后保留标签库与项目关联 | ✅ | `tests/integration/project-tags.sqlite.test.ts`「重开 SQLite 后保留自定义目录与项目关联」 |  |
| 项目分类标签持久化与升级兼容 | 备份恢复后保留标签库与项目关联 | ✅ | `tests/integration/project-tags.sqlite.test.ts`「真实手动备份与恢复保留自定义标签和项目关联」 |  |
| 项目分类标签持久化与升级兼容 | 升级幂等初始化预设标签并保留既有数据 | ✅ | `tests/persistence/migration-v17.test.ts`「空库引导到 v17：建立规范化三表、精确且稳定地 seed 三组七标签」<br>`tests/persistence/migration-v17.test.ts`「v16 存量库升级并重复 bootstrap：保留项目且不重复 seed」 |  |
| 不向远程发送业务数据 | 日常使用不自动外发 | ✅ | `tests/persistence/runtime-boundary.test.ts`「离线无远程依赖：领域与持久化源码不导入任何网络模块」 |  |
| 本地用户不加密 SQLite | 数据库文件不因本地用户加密 | ✅ | `tests/persistence/account-persistence.test.ts`「本地账号不加密 SQLite：数据库文件为普通 SQLite 且账号数据直接可读」 |  |
| 本地用户不加密 SQLite | Windows 操作系统账户保护数据文件与备份 | ✅ | `docs/verification/迁移执行与运维说明.md`「无应用内访问门槛」 | Windows 操作系统账户边界已由客户在 Windows 目标环境验收（tasks 8.85）；10.6 交付文档已明确无访问门槛、SQLite 不加密、内部本地用户不能防止直接读取数据库文件 |
| 每日自动备份 | 当日首次使用自动创建备份 | ✅ | `tests/persistence/backup.test.ts`「当日首次使用创建自动备份（按本地日期命名）」<br>`tests/integration/runtime-lifecycle.sqlite.test.ts`「启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置」 |  |
| 每日自动备份 | 当日已有备份不重复创建 | ✅ | `tests/persistence/backup.test.ts`「当日已有自动备份不重复创建」 |  |
| 自动备份仅保留最近 7 份 | 轮转清理更旧自动备份 | ✅ | `tests/persistence/backup.test.ts`「自动备份轮转：创建第 8 份时清理最早 1 份、保留最近 7 份」 |  |
| 自动备份仅保留最近 7 份 | 手动备份不受数量限制 | ✅ | `tests/persistence/backup.test.ts`「手动备份不受数量限制：自动轮转不清除手动备份」 |  |
| 立即手动备份 | 手动备份到所选目录 | ✅ | `tests/persistence/backup.test.ts`「自动备份文件可读（在线 backup 生成有效副本）」<br>`tests/integration/workbench-facade.sqlite.test.ts`「真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请」 | 手动备份目标目录参数化（createManualBackup(db, targetDir)）在 backup.test.ts 覆盖 |
| 从本地备份恢复 | 确认并验证后恢复成功 | ✅ | `tests/persistence/restore.test.ts`「确认并验证后恢复成功：恢复后数据与备份一致」<br>`tests/integration/runtime-lifecycle.sqlite.test.ts`「启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置」 |  |
| 从本地备份恢复 | 恢复失败不覆盖当前数据 | ✅ | `tests/persistence/restore.test.ts`「备份不可读/损坏时停止恢复并保留当前数据（不覆盖）」 |  |
| 备份/恢复失败明确反馈 | 备份失败明确报错 | ✅ | `tests/persistence/restore.test.ts`「所选备份不存在时给出明确错误」 | 备份失败明确反馈由 restore/backup 的失败路径与错误类型覆盖（RestoreError 等） |
| 备份/恢复失败明确反馈 | 恢复失败明确报错 | ✅ | `tests/persistence/restore.test.ts`「备份不可读/损坏时停止恢复并保留当前数据（不覆盖）」<br>`tests/persistence/restore.test.ts`「所选备份不存在时给出明确错误」 |  |
| schema 升级迁移本地数据 | 升级时迁移现有数据 | ✅ | `tests/persistence/migration.test.ts`「升级时迁移现有数据（旧结构数据完整保留到新结构）」 |  |
| schema 升级迁移本地数据 | 迁移失败保留可恢复状态 | ✅ | `tests/persistence/migration.test.ts`「迁移失败：注入失败迁移 → 整体回滚、保留原库与迁移前安全备份、返回明确恢复信息」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 追加迁移不修改已发布迁移 | ✅ | `tests/persistence/migration-v15.test.ts`「全新库引导到最新版本：迁移序列 1..16、user_version=16、v15 四列已建立、审计表/索引/FK 已建、可写入最小审计事实」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 旧库升级保留既有数据并初始化新字段 | ✅ | `tests/persistence/migration-v15.test.ts`「v14 存量库升级到 v15：业务数据完整保留、legacy region 原文不变、新列空初始化、legacy origin/deleted marker 保持 null」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 新增字段与受控区域值持久化 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「v15 新字段建档后更新并关闭重开：region 受控枚举及 null/false 语义均持久化」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 迁移诊断并清理孤立财务事实 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留」<br>`tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 结构性外键违规持续报告且不阻断迁移 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留」 |  |
| 追加迁移保存新增字段与枚举并兼容旧库 | 迁移失败保留可恢复状态 | ✅ | `tests/persistence/migration.test.ts`「迁移失败：注入失败迁移 → 整体回滚、保留原库与迁移前安全备份、返回明确恢复信息」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v15 已发布库追加 v16 不修改既有迁移 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v15 库升级保留数据并初始化暂定范围列 | ✅ | `tests/persistence/migration-v16.test.ts`「v15 存量库升级到 v16：业务数据完整保留、legacy region 原文不变、v15 字段原样保留、新列 null 初始化」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | 暂定搬迁范围字段持久化保留 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「关闭重开持久化：建档/编辑的暂定仪器范围字段重开后保留」 |  |
| 追加迁移 v16 保存项目暂定搬迁范围字段 | v16 迁移失败保留可恢复状态 | ✅ | `tests/persistence/migration-v16.test.ts`「注入失败保留迁移前数据与可恢复状态：整体回滚、版本仍为 15、全部 v16 结构回滚、迁移前备份可恢复」 |  |

### operational-reporting

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 各区域新项目进单金额 | 按进单月份与区域汇总进单金额 | ✅ | `tests/domain/operational-reporting.test.ts`「按进单月份与区域汇总进单金额，每个项目只计一次，不因合同变更改变」 |  |
| 各区域新项目进单金额 | 按已记录进单日期归属 | ✅ | `tests/domain/operational-reporting.test.ts`「按已记录进单时间归属；补录或修正进单时间后归属实时变化」 |  |
| 月度掉票金额与掉票次数 | 同一项目跨月分次掉票分别归属 | ✅ | `tests/domain/operational-reporting.test.ts`「同一项目跨月分次掉票分别归属，金额与次数分开统计」 |  |
| 月度开单量 | 同一服务单号只计一次 | ✅ | `tests/domain/operational-reporting.test.ts`「同一服务单号关联多名工程师仍只计一次」 |  |
| 月度开单量 | PM 作为开单业务类型分组 | ✅ | `tests/domain/operational-reporting.test.ts`「按唯一服务单号计一次并按四类业务分组，PM 为并列类型」 |  |
| 月度开单量 | 按参与工程师筛选开单量（可选） | ✅ | `tests/domain/operational-reporting.test.ts`「按参与工程师筛选开单量（可选），不选择时汇总全部」 |  |
| 损坏维修统计 | 按事项记录数量与单条金额统计 | ✅ | `tests/domain/operational-reporting.test.ts`「记录数量按事项计数，仅已使用备件金额计入维修费用」 |  |
| 损坏维修统计 | RMB 按固定汇率折算参与统计 | ✅ | `tests/domain/operational-reporting.test.ts`「RMB 按固定汇率折算参与统计，原币金额与币种保留用于展示」 |  |
| 损坏维修统计 | 计算单条事项合同占比 | ✅ | `tests/domain/operational-reporting.test.ts`「计算单条事项合同占比；合同金额为空或 0 时不可计算并明确提示」 |  |
| 损坏维修统计 | 事项数量与金额按登记月份归属并取责任人 | ✅ | `tests/domain/operational-reporting.test.ts`「事项数量与金额按登记月份归属并取责任人快照」 |  |
| 月度物流费用汇总与物流费用合同占比 | 按运输公司与月份汇总物流费用 | ✅ | `tests/domain/operational-reporting.test.ts`「按运输公司与月份汇总，展示批次数、合同预算价/物流成交价合计与差异」 |  |
| 月度物流费用汇总与物流费用合同占比 | 物流成交价高于合同预算价提示计数 | ✅ | `tests/domain/operational-reporting.test.ts`「按运输公司与月份汇总，展示批次数、合同预算价/物流成交价合计与差异」<br>`tests/domain/relocation-execution.test.ts`「物流成交价大于合同预算价仅警告，仍允许保存且不自动创建项目提醒」 |  |
| 月度物流费用汇总与物流费用合同占比 | 计算物流费用合同占比 | ✅ | `tests/domain/operational-reporting.test.ts`「物流成交价合同占比：RMB 按固定汇率折算 USD ÷ 最新合同金额，空/0 不可算」 |  |
| 月度物流费用汇总与物流费用合同占比 | 报表导出仅展示合同预算价与物流成交价 | ✅ | `tests/integration/operational-reporting.sqlite.test.ts`「物流报表导出 section header 精确：仅月份/运输公司/批次数/合同预算价合计/物流成交价合计/两价差异/成交>预算批次数/已取消批次数，不含旧「实际费用」列」<br>`tests/integration/operational-reporting.sqlite.test.ts`「导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值」 |  |
| 月度物流费用汇总与物流费用合同占比 | 历史批次缺费用视为异常数据 | ✅ | `tests/domain/operational-reporting.test.ts`「历史异常批次（已有物流成交价无费用记录）进入清单；底层筛选保留历史兼容（补录后纳入报表）」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用」 |  |
| Ship-to 申请工作量 | 首次提交与后续状态更新不重复计数 | ✅ | `tests/domain/operational-reporting.test.ts`「Ship-to 首次提交计一次，后续状态更新不重复计数，待提交草稿不计」 |  |
| Ship-to 申请工作量 | 按首次提交月份归属并取责任人 | ✅ | `tests/domain/operational-reporting.test.ts`「Ship-to 首次提交计一次，后续状态更新不重复计数，待提交草稿不计」 |  |
| 二维码申请工作量 | 每条记录每个去重选中类型各计一次 | ✅ | `tests/domain/operational-reporting.test.ts`「二维码申请按去重类型计数，不同申请中的同类型分别计数」 |  |
| 二维码申请工作量 | 不同申请中的同类型分别计数 | ✅ | `tests/domain/operational-reporting.test.ts`「二维码申请按去重类型计数，不同申请中的同类型分别计数」 |  |
| 二维码申请工作量 | 按申请日期归属并取申请人 | ✅ | `tests/domain/operational-reporting.test.ts`「二维码申请按去重类型计数，不同申请中的同类型分别计数」 |  |
| 序列号地址更新记录数 | 按更新日期与客户统计记录数 | ✅ | `tests/domain/operational-reporting.test.ts`「序列号地址更新按更新记录计数、按月份与客户分组，同一仪器多次更新分别计数」 |  |
| 序列号地址更新记录数 | 同一仪器多次更新分别计数 | ✅ | `tests/domain/operational-reporting.test.ts`「序列号地址更新按更新记录计数、按月份与客户分组，同一仪器多次更新分别计数」 |  |
| 区域维度与责任人归属 | 区域按去除空格后的精确值分组 | ✅ | `tests/domain/operational-reporting.test.ts`「区域按去除首尾空白后的精确值分组（7.8）」 |  |
| 区域维度与责任人归属 | 区域修改后报表实时重算 | ✅ | `tests/domain/operational-reporting.test.ts`「区域修改后历史报表实时重算（7.8）」<br>`tests/integration/operational-reporting.sqlite.test.ts`「区域修改实时重算；账号改名后历史统计仍按动作记录快照归属」 |  |
| 区域维度与责任人归属 | 工作量归属责任人取动作记录 | ✅ | `tests/domain/operational-reporting.test.ts`「事项数量与金额按登记月份归属并取责任人快照」<br>`tests/integration/operational-reporting.sqlite.test.ts`「区域修改实时重算；账号改名后历史统计仍按动作记录快照归属」 |  |
| 区域维度与责任人归属 | 存量非标准区域不被静默转换 | ✅ | `tests/domain/operational-reporting.test.ts`「存量非标准区域原值保留并归入「待调整」独立分组（不猜测、不置空、不丢弃）」 |  |
| 已取消项目的统计排除 | 已取消项目不纳入进单金额统计 | ✅ | `tests/domain/operational-reporting.test.ts`「已取消项目不纳入进单金额统计、不参与掉票统计与项目管道」 |  |
| 已取消项目的统计排除 | 已取消项目不参与掉票统计与金额闭环指标 | ✅ | `tests/domain/operational-reporting.test.ts`「已取消项目不纳入进单金额统计、不参与掉票统计与项目管道」 |  |
| 已取消项目的统计排除 | 已取消项目保留物流与损坏备件真实成本并标记取消 | ✅ | `tests/domain/operational-reporting.test.ts`「取消前实际发生的物流费用与损坏备件金额作为真实成本保留并标记取消」 |  |
| 报表筛选与手工月份区间 | 月份区间必须手工选择 | ✅ | `tests/domain/operational-reporting.test.ts`「月份区间必须手工选择：未提供时拒绝计算（无默认季度）」 |  |
| 报表筛选与手工月份区间 | 按月份区间与区域筛选 | ✅ | `tests/domain/operational-reporting.test.ts`「按月份区间与区域筛选」 |  |
| 报表筛选与手工月份区间 | 按开单类型与运输公司筛选 | ✅ | `tests/domain/operational-reporting.test.ts`「按开单业务类型筛选」<br>`tests/domain/operational-reporting.test.ts`「按运输公司筛选物流费用」 |  |
| 报表筛选与手工月份区间 | 按工程师筛选（可选） | ✅ | `tests/domain/operational-reporting.test.ts`「按参与工程师筛选开单量（可选），不选择时汇总全部」 |  |
| 报表筛选与手工月份区间 | 多选项目分类标签按 OR 匹配 | ✅ | `tests/domain/operational-reporting.test.ts`「多选标签按 OR 匹配、去重且不重复放大项目派生金额、次数或下钻」<br>`tests/integration/operational-reporting.sqlite.test.ts`「标签筛选从唯一项目关联集合读取，OR 匹配且拒绝未知标签」 |  |
| 报表筛选与手工月份区间 | 未选择项目分类标签不限制结果 | ✅ | `tests/domain/operational-reporting.test.ts`「未选标签不限制；标签筛选启用时排除无项目的独立工作量与 projectId 为 null 的服务单」 |  |
| 报表筛选与手工月份区间 | 标签筛选排除不关联项目的独立记录 | ✅ | `tests/domain/operational-reporting.test.ts`「未选标签不限制；标签筛选启用时排除无项目的独立工作量与 projectId 为 null 的服务单」 |  |
| 报表下钻 | 从掉票金额下钻到掉票记录 | ✅ | `tests/domain/operational-reporting.test.ts`「从掉票金额下钻到逐条掉票记录，明细口径与指标口径一致」 |  |
| 实时计算与三种导出 | 掉票编辑后报表实时更新 | ✅ | `tests/domain/operational-reporting.test.ts`「掉票编辑后报表实时更新（7.10）」<br>`tests/integration/operational-reporting.sqlite.test.ts`「事后掉票编辑与撤销实时反映到报表；关闭重开后仍一致」<br>`tests/integration/cross-module-consistency.sqlite.test.ts`「掉票编辑/撤销后：主状态、项目提醒与报表实时一致」 |  |
| 实时计算与三种导出 | 导出 Excel（.xlsx） | ✅ | `tests/integration/operational-reporting.sqlite.test.ts`「导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值」<br>`tests/integration/critical-paths.sqlite.test.ts`「12. 报表手工月份区间与三种导出」 |  |
| 实时计算与三种导出 | 导出图片（PNG） | ✅ | `tests/integration/operational-reporting.sqlite.test.ts`「导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值」 |  |
| 实时计算与三种导出 | 导出 PDF | ✅ | `tests/integration/operational-reporting.sqlite.test.ts`「导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值」 |  |
| 实时计算与三种导出 | 下钻与导出沿用标签筛选 | ✅ | `tests/renderer/app.test.tsx`「报表标签多选将 tagIds 保留到构建、下钻和导出，清空后等价不限制」<br>`tests/domain/operational-reporting.test.ts`「多选标签按 OR 匹配、去重且不重复放大项目派生金额、次数或下钻」 |  |

### project-financial-closure

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 合同 USD 含税金额手工录入与直接覆盖 | 手工录入合同含税金额 | ✅ | `tests/domain/financial-closure.test.ts`「手工录入合同含税金额：保存手工值，不根据净值税率自动计算或改写」 |  |
| 合同 USD 含税金额手工录入与直接覆盖 | 金额与净值税率计算结果不一致时仅警告 | ✅ | `tests/domain/financial-closure.test.ts`「金额与净值税率计算结果不一致时仅警告，仍允许保存且不自动覆盖」 |  |
| 合同 USD 含税金额手工录入与直接覆盖 | 合同金额直接覆盖修改 | ✅ | `tests/domain/financial-closure.test.ts`「合同金额直接覆盖修改：保存新值，不保存正式合同变更对象/历史、不要求原因」 |  |
| 合同 USD 含税金额手工录入与直接覆盖 | 合同金额允许为 0 | ✅ | `tests/domain/financial-closure.test.ts`「合同金额允许为 0；除合同金额外的其他录入金额不允许为 0」 |  |
| 进单金额快照锁定 | 进单时保存金额快照 | ✅ | `tests/domain/financial-closure.test.ts`「正式进单保存金额快照，合同金额覆盖不改写快照」<br>`tests/domain/relocation-entry.test.ts`「正式进单锁定进单金额快照（后续合同金额覆盖不改写快照，见 5.2）」 |  |
| 进单金额快照锁定 | 合同金额覆盖不改写历史进单金额 | ✅ | `tests/domain/financial-closure.test.ts`「正式进单保存金额快照，合同金额覆盖不改写快照」 |  |
| 进单金额快照锁定 | 合同金额覆盖后进单金额不变且占比按新值重算 | ✅ | `tests/domain/financial-closure.test.ts`「正式进单保存金额快照，合同金额覆盖不改写快照」<br>`tests/integration/financial-closure.sqlite.test.ts`「合同金额覆盖不改写进单金额快照（2.1 快照锁定联动），最新金额用于占比重算」 |  |
| 最终可确认金额 | 最终可确认金额默认取合同金额并可调整 | ✅ | `tests/domain/financial-closure.test.ts`「默认取合同金额并可调整，调整不影响原合同金额」<br>`tests/domain/relocation-entry.test.ts`「最终可确认金额默认取合同 USD 含税金额」 |  |
| 最终可确认金额 | 最终可确认金额不随合同覆盖同步 | ✅ | `tests/domain/financial-closure.test.ts`「最终可确认金额不随合同金额覆盖同步」 |  |
| 最终可确认金额 | 合同金额为 0 时正式进单最终可确认金额允许暂空且首次掉票前必须补录 | ✅ | `tests/domain/financial-closure.test.ts`「合同金额为 0 时正式进单 final 保持 null（不再强制另行录入，进单后基线待执行）」<br>`tests/domain/relocation-entry.test.ts`「合同金额为 0 时正式进单 final 保持 null，另行录入 > 0 才设值（TBD-11 更新）」<br>`tests/renderer/app.test.tsx`「保存意图分组实时展示摘要，并在正式进单合同金额为零时提示」 |  |
| 最终可确认金额 | 最终可确认金额不得低于累计有效掉票金额 | ✅ | `tests/domain/financial-closure.test.ts`「最终可确认金额不得低于累计掉票金额」 |  |
| 分次掉票记录 | 同一项目多次掉票 | ✅ | `tests/domain/financial-closure.test.ts`「同一项目可多次掉票，各自记录时间与金额并分别计数」 |  |
| 金额精度与录入金额正数校验 | 掉票单笔金额必须大于 0 | ✅ | `tests/domain/financial-closure.test.ts`「掉票单笔金额必须大于 0」 |  |
| 金额精度与录入金额正数校验 | 其他录入金额不得为 0 或负数 | ✅ | `tests/domain/financial-closure.test.ts`「其他录入金额不得为 0 或负数」 |  |
| 金额精度与录入金额正数校验 | 金额按两位小数十进制定点四舍五入 | ✅ | `tests/domain/financial-closure.test.ts`「金额按两位小数十进制定点四舍五入，全程不采用二进制浮点」<br>`tests/domain/money.test.ts`「1234.567 按两位小数四舍五入为 1234.57（spec 场景）」 |  |
| 超额保护 | 新增掉票导致累计超额被拒绝 | ✅ | `tests/domain/financial-closure.test.ts`「新增掉票导致累计超额被拒绝，提示先调整最终可确认金额」<br>`tests/integration/critical-paths.sqlite.test.ts`「5. 掉票金额闭环重算」 |  |
| 超额保护 | 先调整最终可确认金额后再掉票 | ✅ | `tests/domain/financial-closure.test.ts`「先调整最终可确认金额后再掉票」 |  |
| 掉票直接编辑并记录最后修改时间 | 覆盖修改掉票金额与日期 | ✅ | `tests/domain/financial-closure.test.ts`「覆盖修改掉票金额与日期，不保留旧值，自动记录最后修改时间并重算」 |  |
| 掉票直接编辑并记录最后修改时间 | 已撤销掉票禁止编辑 | ✅ | `tests/domain/financial-closure.test.ts`「已撤销掉票禁止编辑」 |  |
| 掉票直接编辑并记录最后修改时间 | 编辑后重算项目状态 | ✅ | `tests/domain/financial-closure.test.ts`「编辑后重算项目状态：任意有效掉票即已完成（不再等累计金额足额）」 |  |
| 掉票撤销终态而非删除 | 撤销一条掉票记录 | ✅ | `tests/domain/financial-closure.test.ts`「撤销一条掉票记录：保留记录但标记已撤销，不再计入金额与次数并重算状态」 |  |
| 掉票撤销终态而非删除 | 掉票记录不可物理删除 | ✅ | `tests/domain/financial-closure.test.ts`「掉票记录不可物理删除」 |  |
| 掉票撤销终态而非删除 | 已撤销掉票禁止重复撤销 | ✅ | `tests/domain/financial-closure.test.ts`「已撤销掉票禁止重复撤销」 |  |
| 掉票撤销终态而非删除 | 已撤销掉票禁止重新激活 | ✅ | `tests/domain/financial-closure.test.ts`「已撤销掉票禁止重新激活，更正需新增有效掉票」 |  |
| 待掉票与已完成状态按金额闭环重算 | 登记任一笔有效掉票即进入已完成 | ✅ | `tests/domain/financial-closure.test.ts`「任意成功登记一笔掉票即进入已完成（不再等累计金额足额）」<br>`tests/domain/lifecycle.test.ts`「自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）」 |  |
| 待掉票与已完成状态按金额闭环重算 | 已完成项目因撤销掉票回到待掉票 | ✅ | `tests/domain/financial-closure.test.ts`「已完成项目因撤销掉票回到待掉票」 |  |
| 待掉票与已完成状态按金额闭环重算 | 非待掉票/已完成状态修改金额不改变主状态 | ✅ | `tests/domain/financial-closure.test.ts`「非待掉票/已完成状态修改金额不改变主状态」 |  |
| 已取消状态金额与掉票修改被拒绝 | 已取消项目禁止修改金额 | ✅ | `tests/domain/financial-closure.test.ts`「已取消项目禁止修改合同金额与最终可确认金额」 |  |
| 已取消状态金额与掉票修改被拒绝 | 已取消项目禁止登记或修改掉票 | ✅ | `tests/domain/financial-closure.test.ts`「已取消项目禁止新增、编辑或撤销掉票」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 无任何项目时待掉票金额为 0 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 孤立财务事实不污染指标 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「孤立排除：引用不存在项目的掉票/合同事实不计入指标」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 仍存在项目的有效财务事实计入指标 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入」<br>`tests/integration/workbench-read-v2.sqlite.test.ts`「任务4.1：totalProjects 与待掉票金额在同一修订一致快照内读取（单一聚合查询）」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 诊断清理与防复发 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理后待掉票金额指标保持正常（现有 repository 读取验证，不改其代码）」<br>`tests/integration/financial-integrity.sqlite.test.ts`「防复发：正常 foreign_keys=ON 下写入无项目合同/掉票被拒；治理不产生新孤立行」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 治理不改变掉票撤销终态与不可物理删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「invoice 删除映射为撤销：必填撤销日期/原因，行不物理删除」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 活跃孤立掉票治理撤销保留原行 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |
| 待掉票金额指标仅由仍存在项目的有效财务事实计算 | 结构性外键违规持续报告且不宣称归零 | ✅ | `tests/integration/financial-integrity.sqlite.test.ts`「治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费」 |  |

### qr-request-tracking

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 独立二维码申请模块与申请记录 | 保存申请人与申请日期 | ✅ | `tests/domain/qr-request-tracking.test.ts`「保存申请人与申请时间并选择申请类型」 |  |
| 独立二维码申请模块与申请记录 | 申请不关联仪器与项目 | ✅ | `tests/domain/qr-request-tracking.test.ts`「申请不关联仪器与项目」 |  |
| 独立二维码申请模块与申请记录 | 申请不设状态流转 | ✅ | `tests/domain/qr-request-tracking.test.ts`「申请不设状态流转：一经保存即为一条完整记录」 |  |
| 申请类型固定代码与多选 | 一条申请多选多个类型 | ✅ | `tests/domain/qr-request-tracking.test.ts`「一条申请多选多个类型，允许从九类固定类型中选择」 |  |
| 申请类型固定代码与多选 | 类型仅作分类代码 | ✅ | `tests/domain/qr-request-tracking.test.ts`「类型仅作分类代码：不关联任何搬迁仪器或搬迁项目」 |  |
| 申请工作量按去重类型计数 | 每条记录每个去重选中类型各计一次 | ✅ | `tests/domain/qr-request-tracking.test.ts`「每条记录每个去重选中类型各计一次，同条内相同类型只计一次」 |  |
| 申请工作量按去重类型计数 | 不同申请分别计数 | ✅ | `tests/domain/qr-request-tracking.test.ts`「不同申请分别计数：相同类型不因分属不同申请而合并」 |  |
| 重复申请保留历史 | 重复申请保留历史 | ✅ | `tests/domain/qr-request-tracking.test.ts`「新旧申请均保留在申请历史中，各自独立保存并计数」 |  |
| 重复申请保留历史 | 确认删除后不再保留 | ✅ | `tests/domain/qr-request-tracking.test.ts`「确认后删除：从申请历史与工作量统计中消失」 |  |
| 仪器"二维码是否申请"手工字段 | 手工标记是/否 | ✅ | `tests/domain/qr-request-tracking.test.ts`「手工标记是/否：不随二维码申请记录的保存而变化」 |  |
| 仪器"二维码是否申请"手工字段 | 不保存 URL、不自动创建项目提醒 | ✅ | `tests/domain/qr-request-tracking.test.ts`「不保存 URL、不自动创建项目提醒、不阻塞上门/运输/项目流转」<br>`tests/integration/workbench-todos.sqlite.test.ts`「二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒」 |  |
| 二维码申请记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| 二维码申请记录删除 | 未确认不删除 | ✅ | `tests/domain/qr-request-tracking.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 二维码申请记录删除 | 删除不影响仪器标记与项目 | ✅ | `tests/domain/qr-request-tracking.test.ts`「删除不影响仪器"二维码是否申请"手工标记」 |  |

### relocation-execution

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 暂定数量登记 | 只记暂定数量不建仪器 | ✅ | `tests/domain/relocation-execution.test.ts`「只记暂定数量不建仪器：保存数量信息且不创建任何仪器记录」 |  |
| 暂定数量登记 | 仪器数量允许建档后补充 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 补齐进单核心资料查看并留空暂定数量 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 补齐进单核心资料补录暂定数量并保存最新值 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 补齐进单核心资料调整暂定数量不改变既有仪器事实 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 暂定数量登记 | 调整暂定数量不触发状态流转 | ✅ | `tests/domain/relocation-execution.test.ts`「项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）」 |  |
| 占位仪器与序列号唯一性 | 建立无序列号占位仪器 | ✅ | `tests/domain/relocation-execution.test.ts`「建立无序列号占位仪器：序列号可空」 |  |
| 占位仪器与序列号唯一性 | 合同/项目内序列号重复被拒 | ✅ | `tests/domain/relocation-execution.test.ts`「合同/项目内序列号重复被拒」<br>`tests/persistence/schema.test.ts`「非空序列号在同一项目内唯一、跨项目可重复（TBD-02）」 |  |
| 占位仪器与序列号唯一性 | 跨合同序列号可重复 | ✅ | `tests/domain/relocation-execution.test.ts`「跨合同序列号可重复」 |  |
| 搬迁仪器字段 | 运行时拒绝越权字段 | ❌ | — |  |
| 搬迁仪器字段 | 仅更新允许字段 | ❌ | — |  |
| 搬迁仪器字段 | 仪器名称必填型号选填 | ✅ | `tests/domain/relocation-execution.test.ts`「仪器名称必填、型号选填」 |  |
| 搬迁仪器字段 | UPS 标记为是或否 | ✅ | `tests/domain/relocation-execution.test.ts`「UPS 标记为是或否（仅限两值）」 |  |
| 搬迁仪器字段 | 二维码是否申请为手工字段 | ✅ | `tests/domain/relocation-execution.test.ts`「二维码是否申请为手工字段：默认未申请、不由申请记录推导」<br>`tests/domain/qr-request-tracking.test.ts`「手工标记是/否：不随二维码申请记录的保存而变化」 |  |
| 批次归属与改批 | 全量无变化保存零写 | ❌ | — |  |
| 批次归属与改批 | 运输限制导致跨批保存全回滚 | ❌ | — |  |
| 批次归属与改批 | 跨项目批次导致保存全回滚 | ❌ | — |  |
| 批次归属与改批 | 运输开始前改批保留改批历史 | ✅ | `tests/domain/relocation-execution.test.ts`「运输开始前改批保留改批历史（原批次、新批次、变更时间、登录账号归属）」 |  |
| 批次归属与改批 | 运输开始后禁止改批 | ✅ | `tests/domain/relocation-execution.test.ts`「运输开始后禁止直接改批」 |  |
| 批次归属与改批 | 空批次不能开始运输 | ✅ | `tests/domain/relocation-execution.test.ts`「空批次不能开始运输：至少需要一台归属仪器」 |  |
| 批次归属与改批 | 运输仪器均归属该批次 | ✅ | `tests/domain/relocation-execution.test.ts`「运输仪器均归属该批次：开始运输确认运输集合与批次归属一致」 |  |
| 上门活动与工作事实 | 一次活动多类型多仪器同页记录 | ✅ | `tests/domain/relocation-execution.test.ts`「一次活动多类型多仪器同页记录」<br>`e2e/electron-smoke.spec.ts`「空数据库启动直接进入工作台」 |  |
| 上门活动与工作事实 | 拆机事实记录拆机状态及开始/完成日期 | ✅ | `tests/domain/relocation-execution.test.ts`「拆机事实记录拆机状态及开始/完成日期」 |  |
| 上门活动与工作事实 | 其他工作类型记录各自状态与日期 | ✅ | `tests/domain/relocation-execution.test.ts`「其他工作类型记录各自状态与日期（装机/维修/其他）」 |  |
| 上门活动与工作事实 | 多名工程师参与同一活动 | ✅ | `tests/domain/relocation-execution.test.ts`「多名工程师参与同一活动：保存全部参与工程师」 |  |
| 拆装进度推导 | 不存在工作事实即进度未开始 | ✅ | `tests/domain/relocation-execution.test.ts`「不存在工作事实即进度未开始」 |  |
| 拆装进度推导 | 进行中的拆机事实不算完成 | ✅ | `tests/domain/relocation-execution.test.ts`「进行中的拆机事实不算完成」 |  |
| 拆装进度推导 | 已完成的拆机事实判定拆机完成 | ✅ | `tests/domain/relocation-execution.test.ts`「已完成的拆机事实判定拆机完成、装机未完成」 |  |
| 拆装进度推导 | 装机工作事实完成后进度更新 | ✅ | `tests/domain/relocation-execution.test.ts`「装机工作事实完成后进度更新」 |  |
| 批次与物流费用合并记录 | 每批次仅一笔合并记录 | ✅ | `tests/domain/relocation-execution.test.ts`「每批次仅一笔合并记录」<br>`tests/persistence/schema.test.ts`「每批次仅一笔实际物流费用记录」 |  |
| 批次与物流费用合并记录 | 费用登记日期必填默认当天 | ✅ | `tests/domain/relocation-execution.test.ts`「修改金额不改申请（登记）时间与归属月份」 |  |
| 批次与物流费用合并记录 | 合同预算价必填且大于 0，物流成交价允许暂空或 0 | ✅ | `tests/domain/relocation-execution.test.ts`「合同预算价必填且大于 0；物流成交价允许 0（负数拒绝）」<br>`tests/domain/relocation-execution.test.ts`「合同预算价有值必须大于 0；物流成交价允许 0（仅拒绝负数），可清空为 null」<br>`tests/integration/new-batch-behaviors.sqlite.test.ts`「批量快速记录：物流成交价允许 0，预算价仍必须 > 0」 |  |
| 批次与物流费用合并记录 | 运输公司可选 | ✅ | `tests/domain/relocation-execution.test.ts`「运输公司可选：未指定运输公司仍可保存，字段为空」<br>`tests/domain/relocation-execution.test.ts`「不同批次不同运输公司」<br>`tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 |  |
| 批次与物流费用合并记录 | 物流成交价大于合同预算价仅警告 | ✅ | `tests/domain/relocation-execution.test.ts`「物流成交价大于合同预算价仅警告，仍允许保存且不自动创建项目提醒」 |  |
| 批次与物流费用合并记录 | 物流成交价即最终实际物流费用 | ✅ | `tests/domain/relocation-execution.test.ts`「物流成交价即最终实际物流费用：无独立实际费用输入语义（写入路径成交价与实际费用同值）」<br>`tests/integration/workbench-facade.sqlite.test.ts`「快速记录搬迁批次：原子创建批次与唯一物流费用，两个价格口径正确映射」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt」 |  |
| 批次与物流费用合并记录 | 从批次编辑修改运输信息与两价不改归属月份 | ✅ | `tests/domain/relocation-execution.test.ts`「修改金额不改申请（登记）时间与归属月份」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt」 |  |
| 批次与物流费用合并记录 | 迁移缺费用登记日期 dry-run 报错 | ✅ | `tests/domain/historical-data-import.test.ts`「物流费用申请（登记）时间为目标必填字段，缺失时 dry-run 报错（TBD-14）」<br>`tests/domain/import-validation.test.ts`「物流费用申请（登记）时间为目标必填」 |  |
| 批次与物流费用合并记录 | 历史批次缺费用视为异常数据 | ✅ | `tests/domain/operational-reporting.test.ts`「历史异常批次（已有物流成交价无费用记录）进入清单；底层筛选保留历史兼容（补录后纳入报表）」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用」 |  |
| 暂存地址与是否暂存 | 搬迁范围记录暂存地址 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 暂存地址与是否暂存 | 执行准备记录是否暂存 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 暂存地址与是否暂存 | 暂存信息不触发状态流转 | ✅ | `tests/domain/relocation-fields.test.ts`「暂存地址/是否暂存为手工维护执行事实：修改不影响主状态」 |  |
| 计划装机日期 | 记录计划装机日期 | ✅ | `tests/main/workbench-v2-ipc.test.ts`「update_project 经 IPC：0810 标量（备注/暂存/是否批复/暂定数量/计划装机日期）保存并经 detail 回显」 |  |
| 计划装机日期 | 计划装机日期不触发状态流转 | ✅ | `tests/integration/new-batch-behaviors.sqlite.test.ts`「计划装机完成日期：可随新建/补齐/更新写入，且不触发生命周期」 |  |
| 项目暂定搬迁范围字段 | 建档时填写 UPS 并持久化 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过」<br>`tests/renderer/app.test.tsx`「待进单通过顶部主操作提交 UPS 未填写三态，不提交已移除字段且不登记仪器」 |  |
| 项目暂定搬迁范围字段 | 暂定搬迁范围允许留空后补 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「编辑资料回显：update_project 填写/修改/清空范围字段，不建仪器、不改状态」 |  |
| 项目暂定搬迁范围字段 | UPS 未填写区别于否 | ✅ | `tests/persistence/migration-v16.test.ts`「全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过」 |  |
| 项目暂定搬迁范围字段 | 暂定搬迁范围不建仪器不改既有事实 | ✅ | `tests/domain/relocation-execution.test.ts`「项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）」 |  |

### relocation-project-lifecycle

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 合同可空、编号与 ECC | 待进单分配内部编号且合同可空 | ✅ | `tests/domain/relocation-entry.test.ts`「待进单分配稳定内部编号且合同可空（不强制合同草稿）」<br>`tests/domain/project-contract.test.ts`「待进单项目分配稳定内部 ID 与系统临时编号，且合同可空、不强制合同草稿」 |  |
| 合同可空、编号与 ECC | 正式进单前必须补齐合同 | ✅ | `tests/domain/relocation-entry.test.ts`「正式进单前必须补齐合同：未关联合同拒绝进单」 |  |
| 合同可空、编号与 ECC | 正式进单补充 ECC | ✅ | `tests/domain/relocation-entry.test.ts`「正式进单补充唯一 ECC，原内部 ID 与临时编号继续保留」 |  |
| 合同可空、编号与 ECC | 缺少 ECC 拒绝正式进单 | ✅ | `tests/domain/relocation-entry.test.ts`「缺少 ECC 拒绝正式进单」 |  |
| 合同可空、编号与 ECC | ECC 全局唯一 | ✅ | `tests/domain/relocation-entry.test.ts`「ECC 全局唯一：两个项目使用相同 ECC 拒绝」<br>`tests/integration/relocation-project-lifecycle.sqlite.test.ts`「ECC 全局唯一：领域校验 + SQLite 部分唯一索引兜底」 |  |
| 合同可空、编号与 ECC | 进单后 ECC 纠错 | ✅ | `tests/domain/relocation-entry.test.ts`「进单后 ECC 纠错：唯一性校验通过后保存新值并自动记录最后修改时间」<br>`tests/domain/relocation-entry.test.ts`「进单后 ECC 纠错仍受全局唯一约束」 |  |
| 客户名称唯一业务标识与关联 | 待进单客户可空 | ✅ | `tests/domain/customer.test.ts`「登记客户：trim 后保存为全局唯一业务标识」 | 客户在进单时登记；待进单阶段合同/客户可空由「待进单分配内部编号且合同可空」覆盖 |
| 客户名称唯一业务标识与关联 | 正式进单仅关联一个客户 | ✅ | `tests/domain/project-contract.test.ts`「合同与项目 1:1 独立建模：补建合同后项目关联」 |  |
| 客户名称唯一业务标识与关联 | 客户名称 trim 后全局唯一 | ✅ | `tests/domain/customer.test.ts`「客户名称 trim 后全局唯一：重复（含首尾空白变体）拒绝保存」<br>`tests/persistence/schema.test.ts`「客户名称 trim 后唯一：数据库层唯一约束（待进单阶段合同可空）」 |  |
| 客户名称唯一业务标识与关联 | 同一客户名称关联多个 ECC 项目 | ✅ | `tests/domain/customer.test.ts`「同一客户名称可关联多个不同 ECC 项目（客户侧允许复用）」 |  |
| 主状态与标签 | 未进单先执行标签并存 | ✅ | `tests/domain/relocation-status.test.ts`「未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单」<br>`tests/domain/lifecycle.test.ts`「未进单先执行标签存在时主状态保持待进单（TBD-08）」 |  |
| 主状态与标签 | 取消项目进入已取消 | ✅ | `tests/domain/relocation-status.test.ts`「取消项目进入已取消」<br>`tests/domain/relocation-cancel.test.ts`「任一未取消主状态且无掉票历史可取消，并记录取消时间与原因」 |  |
| 项目分类标签 | 项目跨组多选分类标签 | ✅ | `tests/integration/project-tags.sqlite.test.ts`「目录稳定排序、trim 校验、replace-set 去重且不触发生命周期」<br>`tests/renderer/app.test.tsx`「新建项目按组键盘可达地同组与跨组多选，并提交全局自定义 tagIds」 |  |
| 项目分类标签 | 创建自定义标签分组与标签 | ✅ | `tests/renderer/app.test.tsx`「最新布局：顶部主导航直接显示标签库并打开全局标签库」<br>`tests/integration/project-tags.sqlite.test.ts`「重开 SQLite 后保留自定义目录与项目关联」 |  |
| 项目分类标签 | 分类标签不改变主状态或触发生命周期 | ✅ | `tests/integration/project-tags.sqlite.test.ts`「设置和清空标签不改变项目状态、提醒、执行事实或状态转换审计」 |  |
| 主状态人工调整与系统校验 | 负责人直接调整主状态 | ✅ | `tests/domain/relocation-status.test.ts`「负责人直接调整主状态：待执行 → 执行中 校验通过」 |  |
| 主状态人工调整与系统校验 | 非法状态调整被拒 | ✅ | `tests/domain/relocation-status.test.ts`「非法状态调整被拒：待执行 → 已完成（尚无掉票闭环依据）」 |  |
| 主状态人工调整与系统校验 | 实际装机完成日期自动进入待验收 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 1：实际装机完成时间自动置为待验收，且优先于人工选择」<br>`tests/domain/relocation-status.test.ts`「录入实际装机完成时间自动进入待验收（TBD-07）」 |  |
| 主状态人工调整与系统校验 | 验收报告自动进入待掉票 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 2：标记验收报告并填写报告形成日期自动置为待掉票（不要求客户确认）」 |  |
| 主状态人工调整与系统校验 | 金额闭环自动重算 | ✅ | `tests/domain/lifecycle.test.ts`「自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）」 |  |
| 主状态人工调整与系统校验 | 计划上门日期到达自动进入执行中优先于人工状态值 | ✅ | `tests/domain/lifecycle.test.ts`「到期自动推进优先于人工目标值」<br>`tests/integration/workbench-facade.sqlite.test.ts`「同次 create/supplement 先保存未进单先执行标签，再以到期计划上门日期经 lifecycle 推进并审计」 |  |
| 正式进单 | 填写进单日期保持填写值 | ✅ | `tests/domain/relocation-entry.test.ts`「填写进单时间保持填写值，不以当前时间覆盖」<br>`tests/renderer/app.test.tsx`「进单日期常显但仅正式进单可编辑，切换意图保留输入并进入正式进单 payload」 |  |
| 正式进单 | 进单日期默认当天且可补录 | ✅ | `tests/domain/relocation-entry.test.ts`「进单时间未填写默认取当前时间，并允许进单后补录或修正」 |  |
| 正式进单 | 待进单进单日期可空 | ✅ | `tests/domain/relocation-entry.test.ts`「待进单阶段进单时间可空」<br>`tests/renderer/app.test.tsx`「待进单保留可空进单日期，不渲染其余正式字段，未进单先执行只记录是否批复 boolean」 |  |
| 正式进单 | 核心信息缺失拒绝进单 | ✅ | `tests/domain/relocation-entry.test.ts`「核心信息缺失拒绝进单并就地提示缺失项」 |  |
| 正式进单 | 缺合同拒绝进单 | ✅ | `tests/domain/relocation-entry.test.ts`「缺合同拒绝进单并提示先补齐合同」 |  |
| 正式进单 | 建档移除字段不阻塞进单 | ✅ | `tests/renderer/app.test.tsx`「新建项目由顶部主操作提交正式进单，保留 UPS 且不夹带已移除仪器范围字段」 |  |
| 未进单先执行 | 批复后优先安排上门 | ✅ | `tests/domain/relocation-status.test.ts`「未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单」<br>`tests/integration/critical-paths.sqlite.test.ts`「1. 未进单先执行全链路」 |  |
| 未进单先执行 | 先执行后进单由负责人确定主状态 | ✅ | `tests/domain/relocation-status.test.ts`「先执行后进单：正式进单基线待执行（无自动触发时），主状态由负责人后续确定」<br>`tests/domain/lifecycle.test.ts`「标签清除后主状态由负责人人工确定，且明确自动触发仍生效」 |  |
| 未进单先执行 | 先录入实际装机完成日期后进单自动待验收 | ✅ | `tests/domain/relocation-status.test.ts`「先录入实际装机完成时间后进单自动待验收（TBD-07）」<br>`tests/integration/relocation-project-lifecycle.sqlite.test.ts`「未进单先执行 → 正式进单在原项目上完成，自动触发待验收」 |  |
| 未进单先执行 | 计划上门日期到期后待进单自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「待进单带"未进单先执行"标签到期自动进入执行中」<br>`tests/integration/workbench-facade.sqlite.test.ts`「同次 create/supplement 先保存未进单先执行标签，再以到期计划上门日期经 lifecycle 推进并审计」 |  |
| 未进单先执行 | 已在执行中的项目正式进单不倒退 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「正式进单不倒退：已在执行中的项目进单后保持执行中，在原项目上完成」 |  |
| 执行准备与待验收触发 | 计划上门日期与运输日期分开记录 | ✅ | `tests/domain/relocation-status.test.ts`「计划上门时间与计划运输时间分开记录」 |  |
| 执行准备与待验收触发 | 场地确认不影响状态流转 | ✅ | `tests/domain/relocation-status.test.ts`「场地确认不影响状态流转」 |  |
| 执行准备与待验收触发 | 计划日期不自动流转 | ✅ | `tests/domain/relocation-status.test.ts`「计划时间到期不自动流转（计划时间与场地确认均不触发主状态）」 |  |
| 执行准备与待验收触发 | 录入实际装机完成日期自动进入待验收 | ✅ | `tests/domain/relocation-status.test.ts`「录入实际装机完成时间自动进入待验收（TBD-07）」 |  |
| 执行准备与待验收触发 | 计划上门日期到达待执行项目自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待执行 → 执行中」 |  |
| 执行准备与待验收触发 | 计划上门日期到期待进单项目自动进入执行中 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待进单 → 执行中（reason plan_visit_due）」 |  |
| 执行准备与待验收触发 | 自动推进幂等重复检查不重复触发 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「重复执行幂等零写：项目/revision/audit 全零变化」 |  |
| 执行准备与待验收触发 | 待验收与待掉票不倒退 | ✅ | `tests/domain/lifecycle.test.ts`「到期：待验收/待掉票不倒退」 |  |
| 执行准备与待验收触发 | 终态项目不因计划上门日期改变 | ✅ | `tests/domain/lifecycle.test.ts`「到期：已完成终态不变」<br>`tests/domain/lifecycle.test.ts`「到期：已取消终态不变（仍拒绝流转）」 |  |
| 执行准备与待验收触发 | 漏跑后补推进 | ✅ | `tests/domain/lifecycle.test.ts`「逾期补推进：计划上门日期早于 today 数日（漏跑）仍自动进入执行中」 |  |
| 执行准备与待验收触发 | 计划运输日期与场地确认不触发流转 | ✅ | `tests/integration/relocation-project-lifecycle.sqlite.test.ts`「实际装机完成自动待验收并持久化；计划时间与场地确认不触发」 |  |
| 项目验收 | 标记验收报告进入待掉票 | ✅ | `tests/domain/relocation-status.test.ts`「标记验收报告并填写报告形成日期 → 自动进入待掉票（不要求客户确认）」 |  |
| 项目验收 | 验收后继续报修/维修不影响状态 | ✅ | `tests/domain/relocation-status.test.ts`「验收后继续报修/维修不影响验收、待掉票或完成状态」<br>`tests/domain/damage-repair-tracking.test.ts`「验收后仍允许登记与继续维修，不影响验收/待掉票/完成状态」 |  |
| 取消 | 无掉票历史可取消并保留已发生工作量 | ✅ | `tests/domain/relocation-cancel.test.ts`「任一未取消主状态且无掉票历史可取消，并记录取消时间与原因」<br>`tests/domain/relocation-cancel.test.ts`「取消保留已发生的上门活动、物流与费用记录（取消只改变项目状态）」<br>`tests/integration/critical-paths.sqlite.test.ts`「4. 取消」 |  |
| 取消 | 有任何掉票历史不允许取消 | ✅ | `tests/domain/relocation-cancel.test.ts`「存在任何掉票历史（含已撤销掉票）的项目禁止取消」<br>`tests/domain/lifecycle.test.ts`「取消约束：存在任何掉票历史（含已撤销）禁止取消」 |  |
| 取消 | 已取消项目不可恢复需新建项目 | ✅ | `tests/domain/relocation-cancel.test.ts`「已取消项目不可恢复，继续工作需重新新增项目（TBD-10）」<br>`tests/domain/lifecycle.test.ts`「已取消为终态：不可恢复、禁止继续流转」 |  |
| 取消 | 取消期间冻结金额与掉票修改 | ✅ | `tests/domain/financial-closure.test.ts`「已取消项目禁止修改合同金额与最终可确认金额」<br>`tests/integration/financial-closure.sqlite.test.ts`「已取消项目冻结金额与掉票；有掉票历史（含已撤销）禁止取消（与 2.x 联动）」 |  |
| 项目基础字段与合同日期 | 记录旧址与新址联系人 | ✅ | `tests/domain/relocation-fields.test.ts`「记录旧址与新址联系人（手工文本）」 |  |
| 项目基础字段与合同日期 | 记录项目默认旧址与新址 | ✅ | `tests/domain/relocation-fields.test.ts`「记录项目默认旧址与新址」 |  |
| 项目基础字段与合同日期 | 合同截止日期不得早于开始日期 | ✅ | `tests/domain/relocation-fields.test.ts`「合同截止日期早于开始日期时拒绝保存并提示」<br>`tests/domain/relocation-fields.test.ts`「合同截止日期等于开始日期允许保存」 |  |
| 项目基础字段与合同日期 | 旧址与新址允许建档后补充 | ✅ | `tests/integration/create-project-ecc-rules.sqlite.test.ts`「旧址/新址建档留空后可补录：不改变状态，关闭重开后保留」 |  |
| 项目区域 | 区域为自由文本 | ✅ | `tests/domain/relocation-fields.test.ts`「非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）」 |  |
| 项目区域 | 区域修改后报表实时重算 | ✅ | `tests/domain/relocation-fields.test.ts`「区域修改后按最新值实时重算分组（不保存快照）」<br>`tests/domain/operational-reporting.test.ts`「区域修改后历史报表实时重算（7.8）」 |  |
| 项目区域 | 区域仅五个固定选项 | ✅ | `tests/domain/relocation-fields.test.ts`「五个固定取值均可保存：去除首尾空白后保存规范化值」 |  |
| 项目区域 | 非枚举区域值被拒 | ✅ | `tests/domain/relocation-fields.test.ts`「非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）」 |  |
| 未进单与已进单视觉区分 | 提供已进单判定事实 | ✅ | `tests/domain/relocation-fields.test.ts`「提供已进单判定事实：正式进单后为已进单，待进单项目为未进单」 |  |
| 项目备注 | 建档时填写可选项目备注 | ✅ | `tests/domain/relocation-fields.test.ts`「项目备注可空：建档后补充/修改/清空，不触发主状态流转」 |  |
| 项目备注 | 建档后补充或修改项目备注 | ✅ | `tests/domain/relocation-fields.test.ts`「项目备注可空：建档后补充/修改/清空，不触发主状态流转」 |  |

### serial-address-update

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 序列号地址更新事实逐台登记 | 逐台创建更新事实 | ✅ | `tests/domain/serial-address-update.test.ts`「逐台创建更新事实：记录客户名称、新址地址、序列号、Account ID 与更新时间」 |  |
| 序列号地址更新事实逐台登记 | 独立登记不关联项目或仪器 | ✅ | `tests/domain/serial-address-update.test.ts`「instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器」 |  |
| 序列号地址更新事实逐台登记 | 一台仪器多次地址变化 | ✅ | `tests/domain/serial-address-update.test.ts`「一台仪器多次地址变化：每次登记各创建一条，按更新时间保留可追溯」 |  |
| 项目新址为默认计划、更新事实表达实际关联 | 项目新址仅作默认计划 | ✅ | `tests/domain/serial-address-update.test.ts`「项目新址仅作默认计划：不自动成为仪器实际关联新址」 |  |
| 项目新址为默认计划、更新事实表达实际关联 | 更新事实表达实际关联 | ✅ | `tests/domain/serial-address-update.test.ts`「更新事实表达实际关联：以最近一条更新事实的新址为准」 |  |
| 项目新址为默认计划、更新事实表达实际关联 | 未登记更新事实不视为已关联 | ✅ | `tests/domain/serial-address-update.test.ts`「未登记更新事实不视为已关联新址」 |  |
| 不修改不可变 Ship-to | 更新事实不修改 Ship-to | ✅ | `tests/domain/serial-address-update.test.ts`「更新事实不创建、不修改也不删除任何 Ship-to 主数据」 |  |
| 更新日期必填、默认当天、可补录 | 创建时默认当天 | ✅ | `tests/domain/serial-address-update.test.ts`「创建时默认当前时间」 |  |
| 更新日期必填、默认当天、可补录 | 补录历史日期 | ✅ | `tests/domain/serial-address-update.test.ts`「补录历史时间：按所填历史时间保存并归属该月份」 |  |
| 更新事实列表、筛选与按更新日期计数 | 列表展示与筛选 | ✅ | `tests/domain/serial-address-update.test.ts`「列表展示与筛选：按客户、新址地址、序列号、Account ID 或更新时间」 |  |
| 更新事实列表、筛选与按更新日期计数 | 按更新日期所属月份计数 | ✅ | `tests/domain/serial-address-update.test.ts`「按更新时间所属月份计数」 |  |
| 非空字段与序列号校验 | 非空字段缺失拒绝保存 | ✅ | `tests/domain/serial-address-update.test.ts`「非空字段缺失拒绝保存」 |  |
| 非空字段与序列号校验 | 序列号与登记仪器一致 | ✅ | `tests/domain/serial-address-update.test.ts`「序列号与登记仪器一致：不一致拒绝保存」 |  |
| 非空字段与序列号校验 | 独立登记仅校验序列号非空 | ✅ | `tests/domain/serial-address-update.test.ts`「instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器」 |  |
| 非空字段与序列号校验 | 不引入未确认序列号格式 | ✅ | `tests/domain/serial-address-update.test.ts`「不引入未确认的序列号格式约束：仅非空与仪器一致」 |  |
| 序列号地址更新记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/domain/serial-address-update.test.ts`「确认后删除：更新事实从列表与按更新日期计数统计中消失」 |  |
| 序列号地址更新记录删除 | 未确认不删除 | ✅ | `tests/domain/serial-address-update.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 序列号地址更新记录删除 | 删除不影响关联仪器与 Ship-to | ✅ | `tests/domain/serial-address-update.test.ts`「删除更新事实不修改或删除关联仪器（与 Ship-to 主数据无关）」 |  |
| 序列号地址更新记录删除 | 删除后实际关联以剩余最近更新事实为准 | ✅ | `tests/domain/serial-address-update.test.ts`「删除较新更新事实后，仪器实际关联新址回退到剩余最近更新事实」 |  |

### service-order-recording

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 四类开单与项目关联 | 搬迁开单关联项目 | ✅ | `tests/domain/service-order-recording.test.ts`「搬迁开单关联对应搬迁项目」 |  |
| 四类开单与项目关联 | 非搬迁开单归档关联当前项目 | ✅ | `tests/domain/service-order-recording.test.ts`「非搬迁开单可关联项目（仅归档/查询关系），不进入搬迁生命周期」<br>`tests/integration/service-order-recording.sqlite.test.ts`「非搬迁开单可选归档关联项目：listByProject 可见、关闭重开保留、工作量不依赖项目」 |  |
| 四类开单与项目关联 | 非搬迁开单无项目时独立保存 | ✅ | `tests/domain/service-order-recording.test.ts`「认证开单独立保存、不进入搬迁项目生命周期」<br>`tests/integration/service-order-recording.sqlite.test.ts`「非搬迁开单可选归档关联项目：listByProject 可见、关闭重开保留、工作量不依赖项目」 |  |
| 四类开单与项目关联 | 非搬迁开单关联不存在的项目被拒 | ✅ | `tests/domain/service-order-recording.test.ts`「非搬迁开单关联不存在的项目时拒绝」 |  |
| 四类开单与项目关联 | 认证开单独立保存 | ✅ | `tests/domain/service-order-recording.test.ts`「认证开单独立保存、不进入搬迁项目生命周期」 |  |
| 四类开单与项目关联 | 单寄备件开单独立保存 | ✅ | `tests/domain/service-order-recording.test.ts`「单寄备件开单独立保存」 |  |
| 四类开单与项目关联 | PM 开单独立保存 | ✅ | `tests/domain/service-order-recording.test.ts`「PM 开单独立保存」 |  |
| 服务单号全局唯一 | 重复服务单号被拒 | ✅ | `tests/domain/service-order-recording.test.ts`「重复服务单号被拒」<br>`tests/integration/service-order-recording.sqlite.test.ts`「服务单号全局唯一：领域校验 + SQLite 部分唯一索引兜底」 |  |
| 服务单号全局唯一 | 不同业务类型共用唯一空间 | ✅ | `tests/domain/service-order-recording.test.ts`「不同业务类型共用唯一空间：搬迁单号被认证开单占用拒绝」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 开单仅维护备注与工程师 | ✅ | `tests/domain/service-order-recording.test.ts`「开单仅维护备注与工程师」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 运行时拒绝开单身份字段 | ✅ | `tests/domain/service-order-recording.test.ts`「运行时拒绝开单身份字段」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 最小字段校验 | ✅ | `tests/domain/service-order-recording.test.ts`「缺少服务单号或客户单位之一拒绝保存，工程师可空」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 记录全部最小字段 | ✅ | `tests/domain/service-order-recording.test.ts`「记录全部最小字段后保存，且不关联搬迁项目生命周期」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 开单日期未填默认当天 | ✅ | `tests/domain/service-order-recording.test.ts`「开单时间未填默认当前时间」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 后补备注 | ✅ | `tests/domain/service-order-recording.test.ts`「后补备注：备注缺失不影响保存，可后补填写」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 工程师可空保存并可后续补录 | ✅ | `tests/domain/service-order-recording.test.ts`「工程师可空保存并可后续补录」 |  |
| 四类开单最小字段（工程师可空保存并可后续补录） | 后补工程师 | ✅ | `tests/domain/service-order-recording.test.ts`「后补工程师」 |  |
| 开单记录人工备注与工程师保护导入 forward-fix | 人工备注阻止 forward-fix 覆盖 | ✅ | `tests/integration/record-editing.sqlite.test.ts`「人工备注与工程师阻止 forward-fix 覆盖」<br>`tests/integration/record-editing.sqlite.test.ts`「真实导入 forward-fix 遇到人工开单备注时阻塞并零写保留审计基线」 |  |
| 开单与进单独立 | 开单不影响进单与主状态 | ✅ | `tests/domain/service-order-recording.test.ts`「开单不影响项目进单状态与主状态」 |  |
| 开单与进单独立 | 一个项目多条开单 | ✅ | `tests/domain/service-order-recording.test.ts`「一个项目可关联多条开单」 |  |
| 开单工作量计数 | 同一服务单只计一次 | ✅ | `tests/domain/service-order-recording.test.ts`「同一服务单只计一次（服务单号唯一，关联多名工程师/多次上门仍只计一次）」 |  |
| 开单工作量计数 | 不同服务单分别计数 | ✅ | `tests/domain/service-order-recording.test.ts`「不同服务单分别计数并按四类业务分组」 |  |
| 服务单记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/domain/service-order-recording.test.ts`「确认后删除：开单记录从列表与开单量统计中消失，其他记录不受影响」 |  |
| 服务单记录删除 | 未确认不删除 | ✅ | `tests/domain/service-order-recording.test.ts`「未确认（不存在）不删除：记录不存在时拒绝且无副作用」 |  |
| 服务单记录删除 | 删除不影响关联项目 | ✅ | `tests/domain/service-order-recording.test.ts`「删除不影响关联项目：项目保留，主状态与进单状态不变」 |  |
| 服务单记录删除 | 删除为原子操作 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「service_order 删除成功：行删除 + 来源审计保留并标记 + tombstone 原子写入 + invalidate 标签」 |  |

### ship-to-management

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| Ship-to 不可变主数据与 Account ID | 创建后不可修改 | ✅ | `tests/domain/ship-to-management.test.ts`「创建后不可修改：服务不提供任何修改 Ship-to 的方法」 |  |
| Ship-to 不可变主数据与 Account ID | Account ID 唯一标识 | ✅ | `tests/domain/ship-to-management.test.ts`「Account ID 唯一标识：重复创建被拒，已引用 Ship-to 不因新申请而改变」<br>`tests/integration/ship-to-serial.sqlite.test.ts`「Account ID 全局唯一：数据库唯一索引兜底」 |  |
| Ship-to 申请按客户与新址地址创建 | 同客户同新址只创建一条申请 | ✅ | `tests/domain/ship-to-management.test.ts`「同客户同新址一条申请，客户或新址不同分别创建」 |  |
| Ship-to 申请按客户与新址地址创建 | 申请不关联仪器、不保存地址快照 | ✅ | `tests/domain/ship-to-management.test.ts`「申请不关联仪器、不保存地址快照：仅客户名称与新址地址」 |  |
| Account ID 创建时可空、外部完成后补入并进入已完成 | 创建申请时 Account ID 可空 | ✅ | `tests/domain/ship-to-management.test.ts`「创建申请时 Account ID 可空，保持待提交或处理中状态」 |  |
| Account ID 创建时可空、外部完成后补入并进入已完成 | 外部完成后补入 Account ID 进入已完成 | ✅ | `tests/domain/ship-to-management.test.ts`「外部完成后补入 Account ID 进入已完成并创建不可变 Ship-to」 |  |
| Account ID 创建时可空、外部完成后补入并进入已完成 | 补入重复 Account ID 被拒 | ✅ | `tests/domain/ship-to-management.test.ts`「补入重复 Account ID 被拒，申请保持原状态不进入已完成」 |  |
| 申请线性状态与首次提交工作量 | 首次实际提交计一次工作量 | ✅ | `tests/domain/ship-to-management.test.ts`「首次实际提交计一次工作量，待提交草稿不计」 |  |
| 申请线性状态与首次提交工作量 | 状态线性流转不支持退回或取消 | ✅ | `tests/domain/ship-to-management.test.ts`「状态线性流转不支持退回或取消」 |  |
| 申请线性状态与首次提交工作量 | 后续状态更新不重复计数 | ✅ | `tests/domain/ship-to-management.test.ts`「后续状态更新不重复计数」 |  |
| 目的地址变化重新申请 | 地址变化新建申请 | ✅ | `tests/domain/ship-to-management.test.ts`「地址变化新建申请：原记录保持不变，原申请保留，新申请按首次提交计一次」 |  |
| 批次与项目仅汇总展示所涉 Ship-to | 批次仅汇总展示所涉 Ship-to | ✅ | `tests/domain/ship-to-management.test.ts`「批次仅汇总展示所涉 Ship-to，不为批次维护独立唯一地址」 |  |
| 批次与项目仅汇总展示所涉 Ship-to | 项目仅汇总展示所涉 Ship-to | ✅ | `tests/domain/ship-to-management.test.ts`「项目仅汇总展示所涉 Ship-to，不为项目维护独立唯一地址」 |  |
| 申请未完成不阻塞项目 | 未完成申请不影响项目流转 | ✅ | `tests/domain/ship-to-management.test.ts`「未完成申请不影响项目流转，且不自动创建项目提醒」 |  |
| Ship-to 申请记录删除 | 确认后删除且不再出现在详情与统计 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留」 |  |
| Ship-to 申请记录删除 | 删除非退回或取消 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：删除处理中无 Account ID 的并行申请只物理删除目标，不取消或回退另一申请，仍保留 tombstone」 |  |
| Ship-to 申请记录删除 | 未完成申请直接删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：未完成且无 Account ID 直接删除；异常未完成已有 Account ID 保守拒绝」 |  |
| Ship-to 申请记录删除 | 已完成申请对应 Ship-to 被引用时拒绝删除 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：completed 对应 Ship-to 仍被仪器引用时原子拒绝；legacy 无来源也拒绝」 |  |
| Ship-to 申请记录删除 | 已完成申请对应 Ship-to 无引用时随申请清理 | ✅ | `tests/integration/workbench-delete.sqlite.test.ts`「ship_to_request：completed 经 origin_request_id 证明来源，无引用随申请原子清理 Ship-to」 |  |

### workbench-access

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 无应用内访问门槛，启动直接进入工作台 | 启动直接进入工作台 | ✅ | `tests/renderer/app.test.tsx`「无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程」<br>`e2e/electron-smoke.spec.ts`「空数据库启动直接进入工作台」 |  |
| 无应用内访问门槛，启动直接进入工作台 | 无初始化、登录与恢复码入口 | ✅ | `tests/renderer/app.test.tsx`「无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程」<br>`tests/domain/access.test.ts`「自动建号不生成可用的密码/恢复码：恢复码字段为空，口令为随机秘密的派生值」 |  |
| 无多账号、角色与权限管理 | 无多账号与角色账号 | ✅ | `tests/domain/access.test.ts`「不提供注册/自助新增用户/角色与权限管理 API」<br>`tests/persistence/account-persistence.test.ts`「账号表不设角色/权限列（无角色与权限管理）」 |  |
| 无多账号、角色与权限管理 | 拒绝外部账号同步 | ✅ | `tests/domain/access.test.ts`「无远程认证、外部身份源与账号同步：服务不暴露任何同步/导入账号能力」 |  |
| 手工录入事实与工作量归属内部本地用户 | 手工录入事实归属内部本地用户 | ✅ | `tests/domain/access.test.ts`「负责人录入外部事实归属当前登录账号：会话快照作为动作记录归属」<br>`tests/domain/source.test.ts`「手工录入事实必须携带当前登录账号的内部 ID 与用户名快照」 |  |
| 手工录入事实与工作量归属内部本地用户 | 历史统计不因改名变化 | ✅ | `tests/domain/access.test.ts`「历史统计不因用户名修改变化：动作记录持久化当时用户名快照」<br>`tests/integration/operational-reporting.sqlite.test.ts`「区域修改实时重算；账号改名后历史统计仍按动作记录快照归属」 |  |
| 手工录入事实与工作量归属内部本地用户 | 迁移数据不计手工录入 | ✅ | `tests/domain/access.test.ts`「迁移数据不计手工录入：迁移导入事实不归属本地账号」<br>`tests/domain/source.test.ts`「迁移导入事实不归属本地账号（迁移不计手工录入）」 |  |
| 无应用内认证且 SQLite 不加密 | SQLite 数据库文件不因本地用户加密 | ✅ | `tests/persistence/account-persistence.test.ts`「本地账号不加密 SQLite：数据库文件为普通 SQLite 且账号数据直接可读」<br>`tests/persistence/runtime-boundary.test.ts`「本地账号表存在但 SQLite 不加密：数据库文件为普通 SQLite、账号数据本地可读」 |  |
| 无应用内认证且 SQLite 不加密 | Windows 操作系统账户为主要保护边界 | ✅ | `docs/verification/迁移执行与运维说明.md`「无应用内访问门槛」 | Windows 操作系统账户边界已由客户在 Windows 目标环境验收（tasks 8.85）；10.6 交付文档已明确无访问门槛、SQLite 不加密、内部本地用户不能防止直接读取数据库文件 |
| 搬迁负责人维护全部数据 | 负责人录入外部事实 | ✅ | `tests/domain/access.test.ts`「负责人录入外部事实归属当前登录账号：会话快照作为动作记录归属」<br>`tests/domain/source.test.ts`「系统自动记录事实不归属账号」 |  |
| 搬迁负责人维护全部数据 | 迁移数据不计手工录入 | ✅ | `tests/domain/access.test.ts`「迁移数据不计手工录入：迁移导入事实不归属本地账号」<br>`tests/domain/source.test.ts`「迁移导入事实不归属本地账号（迁移不计手工录入）」 |  |
| 外部角色无独立入口 | 经理批复由负责人记录 | ✅ | `tests/domain/relocation-status.test.ts`「未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单」 |  |
| 外部角色无独立入口 | 工程师执行信息由负责人记录 | ✅ | `tests/domain/relocation-execution.test.ts`「多名工程师参与同一活动：保存全部参与工程师」 |  |
| 受保护操作仅对受信窗口开放 | 非受信窗口不能调用受保护能力 | ✅ | `tests/main/import-wizard-ipc.test.ts`「未登录时导入向导全部 invoke 通道拒绝；非受信 sender 拒绝」 |  |
| 不集成外部系统 | 无外部数据同步 | ✅ | `tests/domain/access.test.ts`「无远程认证、外部身份源与账号同步：服务不暴露任何同步/导入账号能力」<br>`tests/persistence/runtime-boundary.test.ts`「离线无远程依赖：领域与持久化源码不导入任何网络模块」 |  |

### workbench-interface

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 任务优先的主工作台 | 进入工作台先处理项目提醒 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 任务优先的主工作台 | 提醒与项目队列不被其他板块取代 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 任务优先的主工作台 | 顶部任务入口与运营指标 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 无应用内访问门槛，启动直接进入工作台 | 启动直接进入工作台 | ✅ | `tests/renderer/app.test.tsx`「无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程」<br>`e2e/electron-smoke.spec.ts`「空数据库启动直接进入工作台」 |  |
| 无应用内访问门槛，启动直接进入工作台 | 无访问门槛入口 | ✅ | `tests/renderer/app.test.tsx`「无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程」 |  |
| 无应用内访问门槛，启动直接进入工作台 | 访问门缺失不改变主结构 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 未进单与已进单视觉区分 | 项目队列中颜色区分 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 未进单与已进单视觉区分 | 当前上下文与吞吐板块一致区分 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 生命周期吞吐 | 六阶段展示项目数与平均停留 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 生命周期吞吐 | 点击阶段筛选项目队列 | ✅ | `tests/renderer/app.test.tsx`「阶段、提醒、区域和查询筛选下推并重置到首页 cursor」 |  |
| 生命周期吞吐 | 不提供流入流出与自动瓶颈提示 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 | 生命周期吞吐精简：不提供流入流出（inflow/outflow）节奏指标与自动瓶颈提示（客户最终反馈 2026-08-10） |
| 项目分类标签库维护与按组多选展示 | 标签重命名后粗粒度刷新 | ❌ | — |  |
| 项目分类标签库维护与按组多选展示 | 维护全局标签库 | ✅ | `tests/renderer/app.test.tsx`「最新布局：顶部主导航直接显示标签库并打开全局标签库」 |  |
| 项目分类标签库维护与按组多选展示 | 按组多选并展示项目分类标签 | ✅ | `tests/renderer/app.test.tsx`「新建项目按组键盘可达地同组与跨组多选，并提交全局自定义 tagIds」<br>`tests/renderer/app.test.tsx`「详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口」 |  |
| 正式规格基线的验证矩阵来源与证据校验 | 验证矩阵只读取正式规格基线 | ✅ | `scripts/build-verification-matrix.mjs`「仅扫描 `openspec/specs/` 正式基线」 |  |
| 正式规格基线的验证矩阵来源与证据校验 | 测试标题演进后证据仍可校验 | ✅ | `scripts/build-verification-matrix.mjs`「测试源码仅匹配测试标题」 |  |
| 正式规格基线的验证矩阵来源与证据校验 | Active delta 通过严格 OpenSpec 验证 | ✅ | `scripts/build-verification-matrix.mjs`「active 或 archived change 的 delta 由各自的 `openspec validate <change> --strict`」 |  |
| 正式规格基线的验证矩阵来源与证据校验 | 跨平台解析正式基线 capability 路径 | ✅ | `tests/interface/build-verification-matrix.test.ts`「对 macOS 与 Windows 风格 spec 路径生成相同 capability key」 |  |
| 项目详情与队列的项目标签就近编辑入口 | 从详情编辑已有项目标签 | ✅ | `tests/renderer/app.test.tsx`「详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口」 |  |
| 项目详情与队列的项目标签就近编辑入口 | 无标签项目显示添加入口 | ✅ | `tests/renderer/app.test.tsx`「详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口」 |  |
| 项目详情与队列的项目标签就近编辑入口 | 从队列快捷入口编辑对应行项目 | ✅ | `tests/renderer/app.test.tsx`「队列标签入口固化行项目和草稿，不改变当前工作区；两个入口共享编辑器」 |  |
| 项目详情与队列的项目标签就近编辑入口 | 排除非就近录入方式与表格标签展开 | ✅ | `tests/renderer/app.test.tsx`「标签分配只提供单项目文字入口，不提供批量、右键、快速记录或表格内 picker」 |  |
| 共享的轻量项目标签编辑流程 | 两个入口打开相同编辑流程并加载现有标签 | ✅ | `tests/renderer/app.test.tsx`「队列标签入口固化行项目和草稿，不改变当前工作区；两个入口共享编辑器」 |  |
| 共享的轻量项目标签编辑流程 | 按分组调整选择后仅保存标签 | ✅ | `tests/renderer/app.test.tsx`「标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新」 |  |
| 共享的轻量项目标签编辑流程 | 无变化时不可提交 | ✅ | `tests/renderer/app.test.tsx`「标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新」 |  |
| 共享的轻量项目标签编辑流程 | 保存成功按选中目标刷新相关展示并反馈 | ✅ | `tests/renderer/app.test.tsx`「标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新」 |  |
| 共享的轻量项目标签编辑流程 | 保存失败保留可重试状态 | ✅ | `tests/renderer/app.test.tsx`「写入失败保留草稿可重试；写入成功后的刷新失败关闭并提示且不重复写入」 |  |
| 项目标签编辑流程的可访问关闭与窄窗口可用性 | 脏草稿关闭先确认放弃 | ✅ | `tests/renderer/app.test.tsx`「脏草稿关闭先确认放弃」 |  |
| 项目标签编辑流程的可访问关闭与窄窗口可用性 | 干净草稿直接关闭且 busy 禁止关闭 | ✅ | `tests/renderer/app.test.tsx`「干净草稿四种关闭渠道直接关闭；提交中四渠道均不能关闭」 |  |
| 项目标签编辑流程的可访问关闭与窄窗口可用性 | 内容在流程内部滚动 | ✅ | `tests/interface/layout.test.ts`「标签编辑弹窗固定头尾，仅中部选择区内部滚动并隔离滚动链」 |  |
| 项目标签编辑流程的可访问关闭与窄窗口可用性 | 窄窗口下入口收纳但保持可用 | ✅ | `tests/interface/layout.test.ts`「760px 下详情和队列标签入口保留稳定类、完整文字按钮及 40px 最小高度」 |  |
| 当前上下文 | 随选中项目更新上下文 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 当前上下文 | 展示状态异常与当前项目提醒 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 当前上下文 | 展示项目分类标签 | ✅ | `tests/renderer/app.test.tsx`「详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口」 |  |
| 当前上下文 | 展示金额闭环 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 当前上下文 | 展示非阻塞事项并标注不阻塞 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 当前上下文与项目详情位置交换 | 交换后的区域位置保持内容与联动 | ✅ | `tests/renderer/app.test.tsx`「最新布局：提醒、项目工作区与项目队列依次显示，队列选择共享工作区状态」 |  |
| 当前上下文与项目详情位置交换 | 项目工作区不重复组件或状态 | ✅ | `tests/interface/layout.test.ts`「纵向主流程依次显示提醒、单一项目工作区与项目队列」 |  |
| 当前上下文与项目详情位置交换 | 1440px 与 1024px 下布局可用 | ✅ | `e2e/workbench-v2-layout.spec.ts`「最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切」 |  |
| 项目与提醒联动 | 点击项目选中并刷新上下文 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 项目与提醒联动 | 点击项目提醒联动所属项目 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 项目与提醒联动 | 点击阶段筛选并选中项目 | ✅ | `tests/renderer/app.test.tsx`「阶段、提醒、区域和查询筛选下推并重置到首页 cursor」 |  |
| 单页分组录入创建搬迁项目 | 单页分组呈现与对应字段 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目默认正式进单，保存意图及选项按要求排序」<br>`tests/renderer/app.test.tsx`「新建搬迁项目默认正式进单，保存意图及选项按要求排序」 |  |
| 单页分组录入创建搬迁项目 | 搬迁范围分组字段 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目默认正式进单，保存意图及选项按要求排序」 |  |
| 单页分组录入创建搬迁项目 | 执行准备分组字段 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目默认正式进单，保存意图及选项按要求排序」 |  |
| 单页分组录入创建搬迁项目 | 保存为待进单 | ✅ | `tests/integration/workbench-facade.sqlite.test.ts`「真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请」 | 单页分组录入「保存为待进单」（intent=draft）经 WorkbenchFacade（Electron 主进程入口）真实落库；正式进单/未进单先执行两个保存路径由 electron-smoke E2E 覆盖 |
| 单页分组录入创建搬迁项目 | 正式进单 | ✅ | `tests/renderer/app.test.tsx`「新建项目由顶部主操作提交正式进单，保留 UPS 且不夹带已移除仪器范围字段」 |  |
| 单页分组录入创建搬迁项目 | 未进单先执行 | ✅ | `e2e/electron-smoke.spec.ts`「未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）」 |  |
| 单页分组录入创建搬迁项目 | 填写服务单号要求工程师并同次创建开单 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 | 单页录入中「服务单号必填工程师并同次保存」由领域测试 service-order-recording 3.10 覆盖，界面透传 |
| 单页分组录入创建搬迁项目 | 可后补字段不无提示丢失且不自动生成提醒 | ✅ | `tests/renderer/app.test.tsx`「保存意图分组实时展示摘要，并在正式进单合同金额为零时提示」 |  |
| 项目主状态人工选择与校验反馈 | 人工选择主状态并就地反馈 | ✅ | `tests/integration/workbench-facade.sqlite.test.ts`「人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层」<br>`e2e/electron-smoke.spec.ts`「未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）」 |  |
| 项目主状态人工选择与校验反馈 | 自动触发结果如实反映 | ✅ | `e2e/electron-smoke.spec.ts`「未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）」 |  |
| 快速记录入口与动作表单 | 覆盖八类业务动作 | ✅ | `tests/renderer/app.test.tsx`「快速记录合并开单入口，八类动作均提供真实字段」 |  |
| 快速记录入口与动作表单 | 备件申请并入损坏/维修事项 | ✅ | `tests/renderer/app.test.tsx`「快速记录合并开单入口，八类动作均提供真实字段」 |  |
| 快速记录入口与动作表单 | 二维码申请不在项目快速记录 | ✅ | `tests/renderer/app.test.tsx`「快速记录合并开单入口，八类动作均提供真实字段」 |  |
| 快速记录入口与动作表单 | 批次表单字段 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 |  |
| 快速记录入口与动作表单 | 物流费用并入批次表单 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 |  |
| 快速记录入口与动作表单 | 开单表单字段 | ✅ | `tests/renderer/app.test.tsx`「开单记录 tab 读取 orders，并只展示四个服务单字段」<br>`tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 | 开单记录为原"上门活动"入口并入后的合并入口，表单展示开单日期、工程师、开单类型、服务单号 |
| 快速记录入口与动作表单 | 搬迁仪器表单二维码是否申请手工字段 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 |  |
| 快速记录入口与动作表单 | 损坏/维修表单合同金额 0 就地反馈 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」 |  |
| 快速记录入口与动作表单 | 序列号地址更新与二维码申请独立模块入口 | ✅ | `tests/renderer/app.test.tsx`「独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数」 |  |
| 快速记录入口与动作表单 | 不用通用空表单 | ✅ | `tests/renderer/app.test.tsx`「快速记录合并开单入口，八类动作均提供真实字段」 |  |
| 搬迁批次编辑 | 修改批次运输信息与两价 | ✅ | `tests/renderer/app.test.tsx`「物流费用编辑回显全部五项，未改的 appliedAt 按原值提交并可清空其他字段」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt」 |  |
| 搬迁批次编辑 | 费用登记日期不可修改且归属月份不变 | ✅ | `tests/renderer/app.test.tsx`「物流费用编辑回显全部五项，未改的 appliedAt 按原值提交并可清空其他字段」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt」 |  |
| 搬迁批次编辑 | 不提供独立物流费用补录入口 | ✅ | `tests/renderer/app.test.tsx`「快速记录合并开单入口，八类动作均提供真实字段」<br>`tests/integration/workbench-facade.sqlite.test.ts`「batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用」 | 快速记录菜单不出现独立「实际物流费用」动作；费用仅通过批次创建/批次编辑中的合同预算价、物流成交价维护（见「物流费用记录可预填编辑」测试） |
| 就近录入与提醒直达 | 项目队列行内记录入口 | ✅ | `tests/renderer/app.test.tsx`「队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口」 |  |
| 就近录入与提醒直达 | 当前上下文就近入口 | ✅ | `tests/renderer/app.test.tsx`「队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口」 |  |
| 就近录入与提醒直达 | 详情 tab 就近入口 | ✅ | `tests/renderer/app.test.tsx`「队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口」 |  |
| 就近录入与提醒直达 | 项目提醒直达所属项目 | ✅ | `tests/renderer/app.test.tsx`「上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目」 |  |
| 表单行为与提交反馈 | 必填与可选标识及帮助 | ✅ | `tests/renderer/app.test.tsx`「新建搬迁项目默认正式进单，保存意图及选项按要求排序」 |  |
| 表单行为与提交反馈 | 校验失败就地提示 | ✅ | `tests/renderer/app.test.tsx`「开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈」<br>`tests/integration/workbench-facade.sqlite.test.ts`「人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层」 |  |
| 表单行为与提交反馈 | 主状态校验失败就地反馈 | ✅ | `tests/integration/workbench-facade.sqlite.test.ts`「人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层」 |  |
| 表单行为与提交反馈 | 提交中禁用防止重复 | ✅ | `tests/renderer/app.test.tsx`「提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据」 |  |
| 表单行为与提交反馈 | 成功 Toast 并同步更新 | ✅ | `tests/renderer/app.test.tsx`「提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据」 |  |
| 报表筛选与中文下钻展示 | 按月份与维度筛选 | ✅ | `tests/renderer/app.test.tsx`「报表筛选贯通查询、下钻和导出，明细使用中文列名与业务值」 |  |
| 报表筛选与中文下钻展示 | 下钻明细中文展示 | ✅ | `tests/renderer/app.test.tsx`「报表筛选贯通查询、下钻和导出，明细使用中文列名与业务值」 |  |
| 报表导出 | 导出 Excel | ✅ | `tests/renderer/app.test.tsx`「报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示」<br>`e2e/workbench-v2-terminal-export.spec.ts`「运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效」 |  |
| 报表导出 | 导出 PNG | ✅ | `tests/renderer/app.test.tsx`「报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示」<br>`e2e/workbench-v2-terminal-export.spec.ts`「运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效」 |  |
| 报表导出 | 导出 PDF | ✅ | `tests/renderer/app.test.tsx`「报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示」<br>`e2e/workbench-v2-terminal-export.spec.ts`「运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效」 |  |
| 报表导出 | 导出失败就地提示 | ✅ | `tests/renderer/app.test.tsx`「报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示」 |  |
| 导航与键盘可达性 | Escape 关闭当前层 | ✅ | `tests/renderer/app.test.tsx`「新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃」 |  |
| 导航与键盘可达性 | 打开后焦点移至首字段 | ✅ | `tests/renderer/app.test.tsx`「新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃」 |  |
| 导航与键盘可达性 | label 关联可访问名称 | ✅ | `tests/renderer/app.test.tsx`「新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃」 |  |
| 视觉可读性与层级 | 字号基线 | ✅ | `tests/interface/layout.test.ts`「正文、数据和控件使用统一的系统字体与 4px 间距基线」 |  |
| 视觉可读性与层级 | 层级与对比 | ✅ | `tests/interface/layout.test.ts`「正文、数据和控件使用统一的系统字体与 4px 间距基线」 |  |
| 视觉可读性与层级 | 多行文本行高可读 | ✅ | `tests/interface/layout.test.ts`「正文、数据和控件使用统一的系统字体与 4px 间距基线」 |  |
| 详情 tab 按需展开与独立模块 | 详情 tab 可切换展开 | ✅ | `tests/renderer/app.test.tsx`「详情默认打开搬迁仪器并按需切换 section，不再显示项目总览 tab」 |  |
| 详情 tab 按需展开与独立模块 | 扩展 tab 或独立导航模块提供新增能力 | ✅ | `tests/renderer/app.test.tsx`「独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数」 |  |
| 详情 tab 按需展开与独立模块 | 二维码申请模块表单多选类型 | ✅ | `tests/renderer/app.test.tsx`「独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数」 |  |
| 详情 tab 按需展开与独立模块 | 项目总览展示关键事实 | ✅ | `tests/renderer/app.test.tsx`「详情默认打开搬迁仪器并按需切换 section，不再显示项目总览 tab」 |  |
| 详情 tab 按需展开与独立模块 | 费用与掉票 tab 展示金额与掉票记录 | ✅ | `tests/renderer/app.test.tsx`「费用与掉票在列表前展示金额事实，并显示掉票最后修改时间」 |  |
| 信息层级与主操作流保持 | 吞吐板块不复制项目看板 | ✅ | `tests/renderer/app.test.tsx`「任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色」 |  |
| 信息层级与主操作流保持 | 当前上下文不挤占主队列 | ✅ | `tests/interface/layout.test.ts`「纵向主流程依次显示提醒、单一项目工作区与项目队列」 |  |
| 桌面可用性 | 1024px 宽下核心区域可操作 | ✅ | `tests/interface/layout.test.ts`「1024 附近不产生页面级横向溢出，宽表格在容器内滚动」 |  |
| 桌面可用性 | 无页面级横向溢出 | ✅ | `tests/interface/layout.test.ts`「1024 附近不产生页面级横向溢出，宽表格在容器内滚动」 |  |
| 桌面可用性 | 1440px 为主布局基准 | ✅ | `e2e/workbench-v2-layout.spec.ts`「最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切」 |  |
| 桌面可用性 | 1190px 与 1170px 中间宽度保持可用 | ✅ | `e2e/workbench-v2-layout.spec.ts`「最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切」 |  |
| 桌面可用性 | 接近最小宽度不丢失主操作流 | ✅ | `tests/interface/layout.test.ts`「1024 附近不产生页面级横向溢出，宽表格在容器内滚动」 |  |
| 原型作为设计依据而非生产实现 | 遵循行为、结构与视觉意图 | ✅ | `tests/interface/README.md`「已复核选定原型的任务顺序」 | 原型意图验收记录见 tests/interface/README.md |
| 原型作为设计依据而非生产实现 | 高保真原型仅作设计依据、生产实现重写 | ✅ | `tests/interface/README.md`「生产实现保留专业、克制、高密度运营语言」 | 原型意图验收记录见 tests/interface/README.md |
| 原型作为设计依据而非生产实现 | 不复制原型技术代码 | ✅ | `tests/interface/README.md`「未复制原型 HTML、CSS 或 JavaScript」 | 原型意图验收记录见 tests/interface/README.md |
| 待掉票指标仅由有效关联财务事实计算 | 待掉票金额仅计入有效关联事实 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「孤立排除：引用不存在项目的掉票/合同事实不计入指标」 |  |
| 待掉票指标仅由有效关联财务事实计算 | 无项目时指标显示 0 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0」 |  |
| 待掉票指标仅由有效关联财务事实计算 | 保持有效项目财务口径 | ✅ | `tests/integration/financial-closure.sqlite.test.ts`「已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入」<br>`tests/integration/financial-closure.sqlite.test.ts`「已取消排除：仅已取消项目存在时 pendingAmount 为 0（口径不改动为仅活跃项目）」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 不可编辑事实提供正确更正路径 | ❌ | — |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 有下游依赖的事实删除被拒绝 | ❌ | — |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 撤销掉票的终态提示 | ❌ | — |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 登记记录删除需确认 | ✅ | `tests/renderer/app.test.tsx`「删除确认取消时通用保护阻止 v2Delete 调用」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 各类登记记录均提供删除入口 | ✅ | `tests/renderer/app.test.tsx`「八类登记记录逐类提供删除入口并调用对应 v2Delete kind」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 搬迁项目维持取消语义 | ✅ | `tests/renderer/app.test.tsx`「项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销」 |  |
| 登记记录带确认的删除入口与项目/掉票语义保持 | 掉票记录维持撤销语义 | ✅ | `tests/renderer/app.test.tsx`「项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 顶栏入口跳转完整记录视图 | ✅ | `tests/renderer/app.test.tsx`「统一历史入口按日期真正跨项目读取，展示项目上下文并受保护删除」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 按业务日期倒序排列 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页」 |  |
| 顶栏浏览全部记录入口与业务日期倒序 | 相同业务日期稳定排序 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页」 |  |
| 项目队列关键词搜索与固定区域筛选 | 按客户名称或编号搜索 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 项目队列关键词搜索与固定区域筛选 | 按白名单字段搜索命中 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「白名单逐类可命中」 |  |
| 项目队列关键词搜索与固定区域筛选 | 区域筛选为固定枚举 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 项目队列关键词搜索与固定区域筛选 | 搜索与区域筛选组合 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND」 |  |
| 项目队列关键词搜索与固定区域筛选 | 关键词跨类型工程师命中 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「两类工程师均可命中」 |  |
| 项目队列行计划上门日期 | 展示项目级计划上门日期 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「planVisitAt 映射正确」 |  |
| 项目队列行计划上门日期 | 空值与一致性 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「planVisitAt 映射正确」 |  |
| 补齐进单核心资料维护暂定仪器数量 | 查看已有暂定仪器数量 | ✅ | `tests/renderer/app.test.tsx`「编辑项目资料忽略旧暂定仪器三字段，回显并保存 UPS 与其他项目资料」 |  |
| 补齐进单核心资料维护暂定仪器数量 | 暂定仪器数量允许留空 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 补齐进单核心资料维护暂定仪器数量 | 补录或调整后回显最新值 | ✅ | `tests/domain/relocation-execution.test.ts`「编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）」 |  |
| 高密度项目队列固定每页 20 个项目 | 每页固定展示 20 个项目 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确」 |  |
| 高密度项目队列固定每页 20 个项目 | 筛选或搜索后重算总数与分页 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20」 |  |
| 高密度项目队列固定每页 20 个项目 | 翻页时页内顺序稳定 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确」 |  |
| 高密度项目队列固定每页 20 个项目 | 最后一页允许少于 20 个项目 | ✅ | `tests/integration/workbench-read-v2.sqlite.test.ts`「任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20」 |  |
| 高密度项目队列固定每页 20 个项目 | 不展示错误的每页数量文案 | ✅ | `tests/interface/layout.test.ts`「项目队列明确固定每页20且不存在旧文案」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 滚动时头部整体固定 | ✅ | `tests/interface/layout.test.ts`「只固定顶部导航，任务区保持紧凑并随页面滚动」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 固定头部不遮挡内容 | ✅ | `tests/interface/layout.test.ts`「只固定顶部导航，任务区保持紧凑并随页面滚动」 |  |
| 页面滚动时顶部导航与任务指挥台固定头部 | 不拦截键盘焦点 | ✅ | `e2e/workbench-v2-layout.spec.ts`「最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切」 |  |
| 开单工程师可空保存、空值展示与报表归属（v20） | 空工程师计入总量与下钻 | ✅ | `tests/domain/operational-reporting.test.ts`「空工程师计入总量，下钻明细工程师为 null」<br>`tests/integration/operational-reporting.sqlite.test.ts`「开单工程师可空：空值计入总量、筛选、下钻 null」 |  |
| 开单工程师可空保存、空值展示与报表归属（v20） | 按工程师筛选 | ✅ | `tests/domain/operational-reporting.test.ts`「按工程师筛选：仅匹配文本包含值，空值不命中」<br>`tests/integration/operational-reporting.sqlite.test.ts`「开单工程师可空：空值计入总量、筛选、下钻 null」 |  |
| 开单工程师可空保存、空值展示与报表归属（v20） | 下钻明细含空工程师 | ✅ | `tests/domain/operational-reporting.test.ts`「空工程师计入总量，下钻明细工程师为 null」<br>`tests/integration/operational-reporting.sqlite.test.ts`「开单工程师可空：空值计入总量、筛选、下钻 null」 |  |
| 开单工程师可空保存、空值展示与报表归属（v20） | 补录后筛选变化 | ✅ | `tests/domain/operational-reporting.test.ts`「补录后筛选变化：空值补充为有值后可被筛选命中」<br>`tests/integration/operational-reporting.sqlite.test.ts`「开单工程师可空：空值计入总量、筛选、下钻 null，补录后筛选实时变化」 |  |

### workbench-todos

| Requirement | Scenario | 状态 | 测试证据 | 备注 |
| --- | --- | --- | --- | --- |
| 项目提醒手工维护 | 手工创建项目提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「手工创建项目提醒：保存当前提醒并显示在项目上」 |  |
| 项目提醒手工维护 | 编辑当前提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「编辑当前提醒：覆盖为新的当前提醒，不保存旧内容或完成历史」 |  |
| 项目提醒手工维护 | 清除项目提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「清除项目提醒：项目不再显示任何提醒」 |  |
| 项目提醒手工维护 | 系统不自动生成提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「系统不自动生成提醒：服务无任何自动派生规则，提醒仅由手工维护产生」 |  |
| 提醒到期分类 | 今日到期分类 | ✅ | `tests/domain/workbench-todos.test.ts`「截止日当天归为今日到期」 |  |
| 提醒到期分类 | 已逾期分类 | ✅ | `tests/domain/workbench-todos.test.ts`「超过截止日归为已逾期」 |  |
| 提醒到期分类 | 临期分类 | ✅ | `tests/domain/workbench-todos.test.ts`「临期窗口内且未到期的提醒归为临期」 |  |
| 提醒到期分类 | 无提醒不分类 | ✅ | `tests/domain/workbench-todos.test.ts`「无当前提醒的项目不进入任何到期分类」 |  |
| 临期窗口可配置、默认 7 个自然日 | 默认临期窗口 7 个自然日 | ✅ | `tests/domain/workbench-todos.test.ts`「未配置时默认未来 7 个自然日」<br>`tests/domain/workbench-todos.test.ts`「分类纯函数边界：恰好未来 7 天为临期，第 8 天起不分类」 |  |
| 临期窗口可配置、默认 7 个自然日 | 临期窗口可配置并立即生效 | ✅ | `tests/domain/workbench-todos.test.ts`「配置临期窗口后立即生效于后续到期分类」<br>`tests/integration/workbench-todos.sqlite.test.ts`「临期窗口配置经 app_settings 持久化并立即生效」 |  |
| 提醒仅工作台内展示 | 仅工作台内提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「提供工作台内到期分类与提醒列表，无任何外部消息渠道能力」 |  |
| 不自动创建提醒的场景 | 成交高于预算不自动创建提醒 | ✅ | `tests/domain/workbench-todos.test.ts`「无关事实变动（区域、执行准备等）不改变项目提醒字段」<br>`tests/integration/workbench-todos.sqlite.test.ts`「二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒」 |  |
| 不自动创建提醒的场景 | 二维码未标记不自动创建提醒 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒」 |  |
| 不自动创建提醒的场景 | Ship-to 申请未完成不自动创建提醒 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒」 |  |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 查看全部跳转完整提醒视图 | ✅ | `tests/renderer/app.test.tsx`「查看全部进入完整提醒页，默认日期降序，切换升序立即首页重读并稳定翻页」 |  |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 默认按提醒日期最近优先 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：完整提醒视图默认按提醒日期降序（最近日期优先），含到期分类，仅备注项目也计入」 |  |
| 查看全部跳转完整提醒视图并按提醒日期排序 | 可选择升序或降序排列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 同一提醒日期归入同一泳道列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 最多选取 7 个非连续提醒日期 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 首批不足时继续向未来补列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 全量不足时不制造空列 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 每列内项目顺序稳定 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.6：列内 id 稳定 tie-breaker；按列分页携带 selectedDates 锁定日期集合、不重算不重读」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 1024px 下泳道内部横向滚动且键盘可达 | ✅ | `tests/interface/layout.test.ts`「提醒泳道保留日期列头、列内加载和容器内横向滚动」 |  |
| 项目提醒快速处理按提醒日期展示非空泳道 | 完整提醒视图保持独立默认排序 | ✅ | `tests/integration/workbench-todos.sqlite.test.ts`「任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立」 |  |

## 缺口清单（缺证据或证据无效的场景）

| 能力 | Scenario | 问题 |
| --- | --- | --- |
| local-data-persistence | 标签重命名保持稳定关联 | 未登记 |
| local-data-persistence | 标签唯一性冲突零变化 | 未登记 |
| local-data-persistence | 重命名不返回受影响项目列表 | 未登记 |
| relocation-execution | 运行时拒绝越权字段 | 未登记 |
| relocation-execution | 仅更新允许字段 | 未登记 |
| relocation-execution | 全量无变化保存零写 | 未登记 |
| relocation-execution | 运输限制导致跨批保存全回滚 | 未登记 |
| relocation-execution | 跨项目批次导致保存全回滚 | 未登记 |
| workbench-interface | 标签重命名后粗粒度刷新 | 未登记 |
| workbench-interface | 不可编辑事实提供正确更正路径 | 未登记 |
| workbench-interface | 有下游依赖的事实删除被拒绝 | 未登记 |
| workbench-interface | 撤销掉票的终态提示 | 未登记 |
