/**
 * 场景→测试登记表（tasks 10.1）。
 *
 * 结构：scenarioMap[能力] = { [场景标题]: { evidence: [[测试文件, 标题关键词], ...], status?, note?, abstract? } }
 * - evidence 中每个 [file, keyword] 由 scripts/build-verification-matrix.mjs 校验：
 *   测试文件中的 keyword 必须出现在 it()/test()/describe() 标题子串；说明文档可全文匹配。
 * - status: 'pending' 表示该场景仍待验证（真实源迁移 / Windows 边界），不勾选为已覆盖。
 * - abstract: true 表示文档性/设计性场景（不要求 it/describe 关键词），
 *   证据可指向 tests/interface/README.md 等验收记录文件。
 * - note: 诚实备注（含阻塞原因）。
 *
 * 注意：只登记真实存在的测试证据；不得谎称覆盖。
 */

export const scenarioMap = {
  // ─────────────────────────── workbench-access ───────────────────────────
  'workbench-access': {
    '启动直接进入工作台': {
      evidence: [
        ['tests/renderer/app.test.tsx', '无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程'],
        ['e2e/electron-smoke.spec.ts', '空数据库启动直接进入工作台'],
      ],
    },
    '无初始化、登录与恢复码入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程'],
        ['tests/domain/access.test.ts', '自动建号不生成可用的密码/恢复码：恢复码字段为空，口令为随机秘密的派生值'],
      ],
    },
    '无多账号与角色账号': {
      evidence: [
        ['tests/domain/access.test.ts', '不提供注册/自助新增用户/角色与权限管理 API'],
        ['tests/persistence/account-persistence.test.ts', '账号表不设角色/权限列（无角色与权限管理）'],
      ],
    },
    '拒绝外部账号同步': {
      evidence: [
        ['tests/domain/access.test.ts', '无远程认证、外部身份源与账号同步：服务不暴露任何同步/导入账号能力'],
      ],
    },
    '手工录入事实归属内部本地用户': {
      evidence: [
        ['tests/domain/access.test.ts', '负责人录入外部事实归属当前登录账号：会话快照作为动作记录归属'],
        ['tests/domain/source.test.ts', '手工录入事实必须携带当前登录账号的内部 ID 与用户名快照'],
      ],
    },
    '历史统计不因改名变化': {
      evidence: [
        ['tests/domain/access.test.ts', '历史统计不因用户名修改变化：动作记录持久化当时用户名快照'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '区域修改实时重算；账号改名后历史统计仍按动作记录快照归属'],
      ],
    },
    '迁移数据不计手工录入': {
      evidence: [
        ['tests/domain/access.test.ts', '迁移数据不计手工录入：迁移导入事实不归属本地账号'],
        ['tests/domain/source.test.ts', '迁移导入事实不归属本地账号（迁移不计手工录入）'],
      ],
    },
    'SQLite 数据库文件不因本地用户加密': {
      evidence: [
        ['tests/persistence/account-persistence.test.ts', '本地账号不加密 SQLite：数据库文件为普通 SQLite 且账号数据直接可读'],
        ['tests/persistence/runtime-boundary.test.ts', '本地账号表存在但 SQLite 不加密：数据库文件为普通 SQLite、账号数据本地可读'],
      ],
    },
    'Windows 操作系统账户为主要保护边界': {
      abstract: true,
      evidence: [['docs/verification/迁移执行与运维说明.md', '无应用内访问门槛']],
      note: 'Windows 操作系统账户边界已由客户在 Windows 目标环境验收（tasks 8.85）；10.6 交付文档已明确无访问门槛、SQLite 不加密、内部本地用户不能防止直接读取数据库文件',
    },
    '负责人录入外部事实': {
      evidence: [
        ['tests/domain/access.test.ts', '负责人录入外部事实归属当前登录账号：会话快照作为动作记录归属'],
        ['tests/domain/source.test.ts', '系统自动记录事实不归属账号'],
      ],
    },
    '经理批复由负责人记录': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单'],
      ],
    },
    '工程师执行信息由负责人记录': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '多名工程师参与同一活动：保存全部参与工程师'],
      ],
    },
    '非受信窗口不能调用受保护能力': {
      evidence: [
        ['tests/main/import-wizard-ipc.test.ts', '未登录时导入向导全部 invoke 通道拒绝；非受信 sender 拒绝'],
      ],
    },
    '无外部数据同步': {
      evidence: [
        ['tests/domain/access.test.ts', '无远程认证、外部身份源与账号同步：服务不暴露任何同步/导入账号能力'],
        ['tests/persistence/runtime-boundary.test.ts', '离线无远程依赖：领域与持久化源码不导入任何网络模块'],
      ],
    },
  },

  // ─────────────────────── relocation-project-lifecycle ───────────────────
  'relocation-project-lifecycle': {
    '建档时填写可选项目备注': { evidence: [['tests/domain/relocation-fields.test.ts', '项目备注可空：建档后补充/修改/清空，不触发主状态流转']] },
    '建档后补充或修改项目备注': { evidence: [['tests/domain/relocation-fields.test.ts', '项目备注可空：建档后补充/修改/清空，不触发主状态流转']] },
    '计划上门日期到达自动进入执行中优先于人工状态值': { evidence: [['tests/domain/lifecycle.test.ts', '到期自动推进优先于人工目标值'], ['tests/integration/workbench-facade.sqlite.test.ts', '同次 create/supplement 先保存未进单先执行标签，再以到期计划上门日期经 lifecycle 推进并审计']] },
    '建档移除字段不阻塞进单': { evidence: [['tests/renderer/app.test.tsx', '新建项目由顶部主操作提交正式进单，保留 UPS 且不夹带已移除仪器范围字段']] },
    '计划上门日期到期后待进单自动进入执行中': { evidence: [['tests/domain/lifecycle.test.ts', '待进单带"未进单先执行"标签到期自动进入执行中'], ['tests/integration/workbench-facade.sqlite.test.ts', '同次 create/supplement 先保存未进单先执行标签，再以到期计划上门日期经 lifecycle 推进并审计']] },
    '已在执行中的项目正式进单不倒退': { evidence: [['tests/integration/relocation-project-lifecycle.sqlite.test.ts', '正式进单不倒退：已在执行中的项目进单后保持执行中，在原项目上完成']] },
    '计划上门日期到达待执行项目自动进入执行中': { evidence: [['tests/domain/lifecycle.test.ts', '到期：待执行 → 执行中']] },
    '计划上门日期到期待进单项目自动进入执行中': { evidence: [['tests/domain/lifecycle.test.ts', '到期：待进单 → 执行中（reason plan_visit_due）']] },
    '自动推进幂等重复检查不重复触发': { evidence: [['tests/integration/relocation-project-lifecycle.sqlite.test.ts', '重复执行幂等零写：项目/revision/audit 全零变化']] },
    '待验收与待掉票不倒退': { evidence: [['tests/domain/lifecycle.test.ts', '到期：待验收/待掉票不倒退']] },
    '终态项目不因计划上门日期改变': { evidence: [['tests/domain/lifecycle.test.ts', '到期：已完成终态不变'], ['tests/domain/lifecycle.test.ts', '到期：已取消终态不变（仍拒绝流转）']] },
    '漏跑后补推进': { evidence: [['tests/domain/lifecycle.test.ts', '逾期补推进：计划上门日期早于 today 数日（漏跑）仍自动进入执行中']] },
    '计划运输日期与场地确认不触发流转': { evidence: [['tests/integration/relocation-project-lifecycle.sqlite.test.ts', '实际装机完成自动待验收并持久化；计划时间与场地确认不触发']] },
    '旧址与新址允许建档后补充': { evidence: [['tests/integration/create-project-ecc-rules.sqlite.test.ts', '旧址/新址建档留空后可补录：不改变状态，关闭重开后保留']] },
    '区域仅五个固定选项': { evidence: [['tests/domain/relocation-fields.test.ts', '五个固定取值均可保存：去除首尾空白后保存规范化值']] },
    '非枚举区域值被拒': { evidence: [['tests/domain/relocation-fields.test.ts', '非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）']] },
    '待进单分配内部编号且合同可空': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '待进单分配稳定内部编号且合同可空（不强制合同草稿）'],
        ['tests/domain/project-contract.test.ts', '待进单项目分配稳定内部 ID 与系统临时编号，且合同可空、不强制合同草稿'],
      ],
    },
    '正式进单前必须补齐合同': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '正式进单前必须补齐合同：未关联合同拒绝进单'],
      ],
    },
    '正式进单补充 ECC': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '正式进单补充唯一 ECC，原内部 ID 与临时编号继续保留'],
      ],
    },
    '缺少 ECC 拒绝正式进单': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '缺少 ECC 拒绝正式进单'],
      ],
    },
    'ECC 全局唯一': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', 'ECC 全局唯一：两个项目使用相同 ECC 拒绝'],
        ['tests/integration/relocation-project-lifecycle.sqlite.test.ts', 'ECC 全局唯一：领域校验 + SQLite 部分唯一索引兜底'],
      ],
    },
    '进单后 ECC 纠错': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '进单后 ECC 纠错：唯一性校验通过后保存新值并自动记录最后修改时间'],
        ['tests/domain/relocation-entry.test.ts', '进单后 ECC 纠错仍受全局唯一约束'],
      ],
    },
    '待进单客户可空': {
      evidence: [
        ['tests/domain/customer.test.ts', '登记客户：trim 后保存为全局唯一业务标识'],
      ],
      note: '客户在进单时登记；待进单阶段合同/客户可空由「待进单分配内部编号且合同可空」覆盖',
    },
    '正式进单仅关联一个客户': {
      evidence: [
        ['tests/domain/project-contract.test.ts', '合同与项目 1:1 独立建模：补建合同后项目关联'],
      ],
    },
    '客户名称 trim 后全局唯一': {
      evidence: [
        ['tests/domain/customer.test.ts', '客户名称 trim 后全局唯一：重复（含首尾空白变体）拒绝保存'],
        ['tests/persistence/schema.test.ts', '客户名称 trim 后唯一：数据库层唯一约束（待进单阶段合同可空）'],
      ],
    },
    '同一客户名称关联多个 ECC 项目': {
      evidence: [
        ['tests/domain/customer.test.ts', '同一客户名称可关联多个不同 ECC 项目（客户侧允许复用）'],
      ],
    },
    '未进单先执行标签并存': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单'],
        ['tests/domain/lifecycle.test.ts', '未进单先执行标签存在时主状态保持待进单（TBD-08）'],
      ],
    },
    '取消项目进入已取消': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '取消项目进入已取消'],
        ['tests/domain/relocation-cancel.test.ts', '任一未取消主状态且无掉票历史可取消，并记录取消时间与原因'],
      ],
    },
    '负责人直接调整主状态': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '负责人直接调整主状态：待执行 → 执行中 校验通过'],
      ],
    },
    '非法状态调整被拒': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '非法状态调整被拒：待执行 → 已完成（尚无掉票闭环依据）'],
      ],
    },
    '实际装机完成日期自动进入待验收': {
      evidence: [
        ['tests/domain/lifecycle.test.ts', '自动触发 1：实际装机完成时间自动置为待验收，且优先于人工选择'],
        ['tests/domain/relocation-status.test.ts', '录入实际装机完成时间自动进入待验收（TBD-07）'],
      ],
    },
    '验收报告自动进入待掉票': {
      evidence: [
        ['tests/domain/lifecycle.test.ts', '自动触发 2：标记验收报告并填写报告形成日期自动置为待掉票（不要求客户确认）'],
      ],
    },
    '金额闭环自动重算': {
      evidence: [
        ['tests/domain/lifecycle.test.ts', '自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）'],
      ],
    },
    '填写进单日期保持填写值': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '填写进单时间保持填写值，不以当前时间覆盖'],
        ['tests/renderer/app.test.tsx', '进单日期常显但仅正式进单可编辑，切换意图保留输入并进入正式进单 payload'],
      ],
    },
    '进单日期默认当天且可补录': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '进单时间未填写默认取当前时间，并允许进单后补录或修正'],
      ],
    },
    '待进单进单日期可空': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '待进单阶段进单时间可空'],
        ['tests/renderer/app.test.tsx', '待进单保留可空进单日期，不渲染其余正式字段，未进单先执行只记录是否批复 boolean'],
      ],
    },
    '核心信息缺失拒绝进单': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '核心信息缺失拒绝进单并就地提示缺失项'],
      ],
    },
    '缺合同拒绝进单': {
      evidence: [
        ['tests/domain/relocation-entry.test.ts', '缺合同拒绝进单并提示先补齐合同'],
      ],
    },
    '批复后优先安排上门': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单'],
        ['tests/integration/critical-paths.sqlite.test.ts', '1. 未进单先执行全链路'],
      ],
    },
    '先执行后进单由负责人确定主状态': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '先执行后进单：正式进单基线待执行（无自动触发时），主状态由负责人后续确定'],
        ['tests/domain/lifecycle.test.ts', '标签清除后主状态由负责人人工确定，且明确自动触发仍生效'],
      ],
    },
    '先录入实际装机完成日期后进单自动待验收': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '先录入实际装机完成时间后进单自动待验收（TBD-07）'],
        ['tests/integration/relocation-project-lifecycle.sqlite.test.ts', '未进单先执行 → 正式进单在原项目上完成，自动触发待验收'],
      ],
    },
    '计划上门日期与运输日期分开记录': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '计划上门时间与计划运输时间分开记录'],
      ],
    },
    '场地确认不影响状态流转': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '场地确认不影响状态流转'],
      ],
    },
    '计划日期不自动流转': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '计划时间到期不自动流转（计划时间与场地确认均不触发主状态）'],
      ],
    },
    '录入实际装机完成日期自动进入待验收': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '录入实际装机完成时间自动进入待验收（TBD-07）'],
      ],
    },
    '标记验收报告进入待掉票': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '标记验收报告并填写报告形成日期 → 自动进入待掉票（不要求客户确认）'],
      ],
    },
    '验收后继续报修/维修不影响状态': {
      evidence: [
        ['tests/domain/relocation-status.test.ts', '验收后继续报修/维修不影响验收、待掉票或完成状态'],
        ['tests/domain/damage-repair-tracking.test.ts', '验收后仍允许登记与继续维修，不影响验收/待掉票/完成状态'],
      ],
    },
    '无掉票历史可取消并保留已发生工作量': {
      evidence: [
        ['tests/domain/relocation-cancel.test.ts', '任一未取消主状态且无掉票历史可取消，并记录取消时间与原因'],
        ['tests/domain/relocation-cancel.test.ts', '取消保留已发生的上门活动、物流与费用记录（取消只改变项目状态）'],
        ['tests/integration/critical-paths.sqlite.test.ts', '4. 取消'],
      ],
    },
    '有任何掉票历史不允许取消': {
      evidence: [
        ['tests/domain/relocation-cancel.test.ts', '存在任何掉票历史（含已撤销掉票）的项目禁止取消'],
        ['tests/domain/lifecycle.test.ts', '取消约束：存在任何掉票历史（含已撤销）禁止取消'],
      ],
    },
    '已取消项目不可恢复需新建项目': {
      evidence: [
        ['tests/domain/relocation-cancel.test.ts', '已取消项目不可恢复，继续工作需重新新增项目（TBD-10）'],
        ['tests/domain/lifecycle.test.ts', '已取消为终态：不可恢复、禁止继续流转'],
      ],
    },
    '取消期间冻结金额与掉票修改': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已取消项目禁止修改合同金额与最终可确认金额'],
        ['tests/integration/financial-closure.sqlite.test.ts', '已取消项目冻结金额与掉票；有掉票历史（含已撤销）禁止取消（与 2.x 联动）'],
      ],
    },
    '记录旧址与新址联系人': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '记录旧址与新址联系人（手工文本）'],
      ],
    },
    '记录项目默认旧址与新址': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '记录项目默认旧址与新址'],
      ],
    },
    '合同截止日期不得早于开始日期': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '合同截止日期早于开始日期时拒绝保存并提示'],
        ['tests/domain/relocation-fields.test.ts', '合同截止日期等于开始日期允许保存'],
      ],
    },
    '区域为自由文本': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '非枚举区域值被拒并提示（含存量 legacy 自由文本，绝不静默写入）'],
      ],
    },
    '区域修改后报表实时重算': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '区域修改后按最新值实时重算分组（不保存快照）'],
        ['tests/domain/operational-reporting.test.ts', '区域修改后历史报表实时重算（7.8）'],
      ],
    },
    '提供已进单判定事实': {
      evidence: [
        ['tests/domain/relocation-fields.test.ts', '提供已进单判定事实：正式进单后为已进单，待进单项目为未进单'],
      ],
    },
    '项目跨组多选分类标签': {
      evidence: [
        ['tests/integration/project-tags.sqlite.test.ts', '目录稳定排序、trim 校验、replace-set 去重且不触发生命周期'],
        ['tests/renderer/app.test.tsx', '新建项目按组键盘可达地同组与跨组多选，并提交全局自定义 tagIds'],
      ],
    },
    '创建自定义标签分组与标签': {
      evidence: [
        ['tests/renderer/app.test.tsx', '最新布局：顶部主导航直接显示标签库并打开全局标签库'],
        ['tests/integration/project-tags.sqlite.test.ts', '重开 SQLite 后保留自定义目录与项目关联'],
      ],
    },
    '分类标签不改变主状态或触发生命周期': {
      evidence: [
        ['tests/integration/project-tags.sqlite.test.ts', '设置和清空标签不改变项目状态、提醒、执行事实或状态转换审计'],
      ],
    },
  },

  // ────────────────────────── relocation-execution ────────────────────────
  'relocation-execution': {
    '搬迁范围记录暂存地址': { evidence: [['tests/domain/relocation-fields.test.ts', '暂存地址/是否暂存为手工维护执行事实：修改不影响主状态']] },
    '执行准备记录是否暂存': { evidence: [['tests/domain/relocation-fields.test.ts', '暂存地址/是否暂存为手工维护执行事实：修改不影响主状态']] },
    '暂存信息不触发状态流转': { evidence: [['tests/domain/relocation-fields.test.ts', '暂存地址/是否暂存为手工维护执行事实：修改不影响主状态']] },
    '记录计划装机日期': { evidence: [['tests/main/workbench-v2-ipc.test.ts', 'update_project 经 IPC：0810 标量（备注/暂存/是否批复/暂定数量/计划装机日期）保存并经 detail 回显']] },
    '计划装机日期不触发状态流转': { evidence: [['tests/integration/new-batch-behaviors.sqlite.test.ts', '计划装机完成日期：可随新建/补齐/更新写入，且不触发生命周期']] },
    '建档时填写暂定搬迁范围并持久化': { evidence: [['tests/persistence/migration-v16.test.ts', '全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过'], ['tests/renderer/app.test.tsx', '待进单通过顶部主操作提交 UPS 未填写三态，不提交已移除字段且不登记仪器']] },
    '暂定搬迁范围允许留空后补': { evidence: [['tests/integration/create-project-ecc-rules.sqlite.test.ts', '编辑资料回显：update_project 填写/修改/清空范围字段，不建仪器、不改状态']] },
    'UPS 未填写区别于否': { evidence: [['tests/persistence/migration-v16.test.ts', '全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过']] },
    '暂定搬迁范围不建仪器不改既有事实': { evidence: [['tests/domain/relocation-execution.test.ts', '项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）']] },
    '仪器数量允许建档后补充': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '编辑项目资料查看并留空暂定数量': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '编辑项目资料补录暂定数量并保存最新值': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '编辑项目资料调整暂定数量不改变既有仪器事实': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '调整暂定数量不触发状态流转': { evidence: [['tests/domain/relocation-execution.test.ts', '项目暂定仪器范围（v16：只更新项目标量，不建仪器、不触发主状态）']] },
    '补齐进单核心资料查看并留空暂定数量': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '补齐进单核心资料补录暂定数量并保存最新值': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '补齐进单核心资料调整暂定数量不改变既有仪器事实': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '建档时填写 UPS 并持久化': { evidence: [['tests/persistence/migration-v16.test.ts', '全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过'], ['tests/renderer/app.test.tsx', '待进单通过顶部主操作提交 UPS 未填写三态，不提交已移除字段且不登记仪器']] },
    '只记暂定数量不建仪器': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '只记暂定数量不建仪器：保存数量信息且不创建任何仪器记录'],
      ],
    },
    '建立无序列号占位仪器': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '建立无序列号占位仪器：序列号可空'],
      ],
    },
    '合同/项目内序列号重复被拒': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '合同/项目内序列号重复被拒'],
        ['tests/persistence/schema.test.ts', '非空序列号在同一项目内唯一、跨项目可重复（TBD-02）'],
      ],
    },
    '跨合同序列号可重复': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '跨合同序列号可重复'],
      ],
    },
    '仪器名称必填型号选填': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '仪器名称必填、型号选填'],
      ],
    },
    'UPS 标记为是或否': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', 'UPS 标记为是或否（仅限两值）'],
      ],
    },
    '二维码是否申请为手工字段': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '二维码是否申请为手工字段：默认未申请、不由申请记录推导'],
        ['tests/domain/qr-request-tracking.test.ts', '手工标记是/否：不随二维码申请记录的保存而变化'],
      ],
    },
    '运输开始前改批保留改批历史': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '运输开始前改批保留改批历史（原批次、新批次、变更时间、登录账号归属）'],
      ],
    },
    '运输开始后禁止改批': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '运输开始后禁止直接改批'],
      ],
    },
    '空批次不能开始运输': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '空批次不能开始运输：至少需要一台归属仪器'],
      ],
    },
    '运输仪器均归属该批次': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '运输仪器均归属该批次：开始运输确认运输集合与批次归属一致'],
      ],
    },
    '一次活动多类型多仪器同页记录': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '一次活动多类型多仪器同页记录'],
        ['e2e/electron-smoke.spec.ts', '空数据库启动直接进入工作台'],
      ],
    },
    '拆机事实记录拆机状态及开始/完成日期': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '拆机事实记录拆机状态及开始/完成日期'],
      ],
    },
    '其他工作类型记录各自状态与日期': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '其他工作类型记录各自状态与日期（装机/维修/其他）'],
      ],
    },
    '多名工程师参与同一活动': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '多名工程师参与同一活动：保存全部参与工程师'],
      ],
    },
    '不存在工作事实即进度未开始': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '不存在工作事实即进度未开始'],
      ],
    },
    '进行中的拆机事实不算完成': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '进行中的拆机事实不算完成'],
      ],
    },
    '已完成的拆机事实判定拆机完成': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '已完成的拆机事实判定拆机完成、装机未完成'],
      ],
    },
    '装机工作事实完成后进度更新': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '装机工作事实完成后进度更新'],
      ],
    },
    '每批次仅一笔合并记录': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '每批次仅一笔合并记录'],
        ['tests/persistence/schema.test.ts', '每批次仅一笔实际物流费用记录'],
      ],
    },
    '费用登记日期必填默认当天': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '修改金额不改申请（登记）时间与归属月份'],
      ],
    },
    '合同预算价必填且大于 0，物流成交价允许暂空或 0': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '合同预算价必填且大于 0；物流成交价允许 0（负数拒绝）'],
        ['tests/domain/relocation-execution.test.ts', '合同预算价有值必须大于 0；物流成交价允许 0（仅拒绝负数），可清空为 null'],
        ['tests/integration/new-batch-behaviors.sqlite.test.ts', '批量快速记录：物流成交价允许 0，预算价仍必须 > 0'],
      ],
    },
    '运输公司可选': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '运输公司可选：未指定运输公司仍可保存，字段为空'],
        ['tests/domain/relocation-execution.test.ts', '不同批次不同运输公司'],
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
    },
    '物流成交价大于合同预算价仅警告': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '物流成交价大于合同预算价仅警告，仍允许保存且不自动创建项目提醒'],
      ],
    },
    '物流成交价即最终实际物流费用': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '物流成交价即最终实际物流费用：无独立实际费用输入语义（写入路径成交价与实际费用同值）'],
        ['tests/integration/workbench-facade.sqlite.test.ts', '快速记录搬迁批次：原子创建批次与唯一物流费用，两个价格口径正确映射'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt'],
      ],
    },
    '从批次编辑修改运输信息与两价不改归属月份': {
      evidence: [
        ['tests/domain/relocation-execution.test.ts', '修改金额不改申请（登记）时间与归属月份'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt'],
      ],
    },
    '迁移缺费用登记日期 dry-run 报错': {
      evidence: [
        ['tests/domain/historical-data-import.test.ts', '物流费用申请（登记）时间为目标必填字段，缺失时 dry-run 报错（TBD-14）'],
        ['tests/domain/import-validation.test.ts', '物流费用申请（登记）时间为目标必填'],
      ],
    },
    '历史批次缺费用视为异常数据': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '历史异常批次（已有物流成交价无费用记录）进入清单；底层筛选保留历史兼容（补录后纳入报表）'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用'],
      ],
    },
  },

  // ───────────────────────── service-order-recording ──────────────────────
  'service-order-recording': {
    '确认后删除且不再出现在详情与统计': { evidence: [['tests/domain/service-order-recording.test.ts', '确认后删除：开单记录从列表与开单量统计中消失，其他记录不受影响']] },
    '未确认不删除': { evidence: [['tests/domain/service-order-recording.test.ts', '未确认（不存在）不删除：记录不存在时拒绝且无副作用']] },
    '删除不影响关联项目': { evidence: [['tests/domain/service-order-recording.test.ts', '删除不影响关联项目：项目保留，主状态与进单状态不变']] },
    '删除为原子操作': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'service_order 删除成功：行删除 + 来源审计保留并标记 + tombstone 原子写入 + invalidate 标签']] },
    '搬迁开单关联项目': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '搬迁开单关联对应搬迁项目'],
      ],
    },
    '非搬迁开单归档关联当前项目': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '非搬迁开单可关联项目（仅归档/查询关系），不进入搬迁生命周期'],
        ['tests/integration/service-order-recording.sqlite.test.ts', '非搬迁开单可选归档关联项目：listByProject 可见、关闭重开保留、工作量不依赖项目'],
      ],
    },
    '非搬迁开单无项目时独立保存': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '认证开单独立保存、不进入搬迁项目生命周期'],
        ['tests/integration/service-order-recording.sqlite.test.ts', '非搬迁开单可选归档关联项目：listByProject 可见、关闭重开保留、工作量不依赖项目'],
      ],
    },
    '非搬迁开单关联不存在的项目被拒': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '非搬迁开单关联不存在的项目时拒绝'],
      ],
    },
    '认证开单独立保存': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '认证开单独立保存、不进入搬迁项目生命周期'],
      ],
    },
    '单寄备件开单独立保存': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '单寄备件开单独立保存'],
      ],
    },
    'PM 开单独立保存': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', 'PM 开单独立保存'],
      ],
    },
    '重复服务单号被拒': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '重复服务单号被拒'],
        ['tests/integration/service-order-recording.sqlite.test.ts', '服务单号全局唯一：领域校验 + SQLite 部分唯一索引兜底'],
      ],
    },
    '不同业务类型共用唯一空间': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '不同业务类型共用唯一空间：搬迁单号被认证开单占用拒绝'],
      ],
    },
    '最小字段校验': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '缺少服务单号、工程师或客户单位之一拒绝保存'],
      ],
    },
    '记录全部最小字段': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '记录全部最小字段后保存，且不关联搬迁项目生命周期'],
      ],
    },
    '开单日期未填默认当天': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '开单时间未填默认当前时间'],
      ],
    },
    '后补备注': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '后补备注：备注缺失不影响保存，可后补填写'],
      ],
    },
    '开单不影响进单与主状态': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '开单不影响项目进单状态与主状态'],
      ],
    },
    '一个项目多条开单': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '一个项目可关联多条开单'],
      ],
    },
    '填写选填单号且已选工程师，项目与开单同次保存': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '填写选填单号且已选工程师：项目与开单同次保存，开单关联该项目'],
        ['tests/integration/service-order-recording.sqlite.test.ts', '向导原子保存：填写单号且已选工程师，项目与搬迁开单同次落库（事务）'],
      ],
    },
    '填写单号但未选定工程师拒绝保存整个录入': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '填写单号但未选定工程师：拒绝保存整个向导（项目与开单均不产生）'],
      ],
    },
    '开单日期默认当天': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '开单时间默认当前时间，备注可空并在后补'],
      ],
    },
    '不填写选填单号不创建': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '不填写选填单号不创建任何开单记录'],
        ['tests/integration/service-order-recording.sqlite.test.ts', '向导未填单号：只保存项目，不创建任何开单记录'],
      ],
    },
    '同项目仍可多条开单': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '同项目仍可手工关联多条开单'],
      ],
    },
    '同一服务单只计一次': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '同一服务单只计一次（服务单号唯一，关联多名工程师/多次上门仍只计一次）'],
      ],
    },
    '不同服务单分别计数': {
      evidence: [
        ['tests/domain/service-order-recording.test.ts', '不同服务单分别计数并按四类业务分组'],
      ],
    },
  },

  // ─────────────────────────── ship-to-management ─────────────────────────
  'ship-to-management': {
    '确认后删除且不再出现在详情与统计': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', '5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留']] },
    '删除非退回或取消': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'ship_to_request：删除处理中无 Account ID 的并行申请只物理删除目标，不取消或回退另一申请，仍保留 tombstone']] },
    '未完成申请直接删除': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'ship_to_request：未完成且无 Account ID 直接删除；异常未完成已有 Account ID 保守拒绝']] },
    '已完成申请对应 Ship-to 被引用时拒绝删除': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'ship_to_request：completed 对应 Ship-to 仍被仪器引用时原子拒绝；legacy 无来源也拒绝']] },
    '已完成申请对应 Ship-to 无引用时随申请清理': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'ship_to_request：completed 经 origin_request_id 证明来源，无引用随申请原子清理 Ship-to']] },
    '创建后不可修改': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '创建后不可修改：服务不提供任何修改 Ship-to 的方法'],
      ],
    },
    'Account ID 唯一标识': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', 'Account ID 唯一标识：重复创建被拒，已引用 Ship-to 不因新申请而改变'],
        ['tests/integration/ship-to-serial.sqlite.test.ts', 'Account ID 全局唯一：数据库唯一索引兜底'],
      ],
    },
    '同客户同新址只创建一条申请': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '同客户同新址一条申请，客户或新址不同分别创建'],
      ],
    },
    '申请不关联仪器、不保存地址快照': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '申请不关联仪器、不保存地址快照：仅客户名称与新址地址'],
      ],
    },
    '创建申请时 Account ID 可空': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '创建申请时 Account ID 可空，保持待提交或处理中状态'],
      ],
    },
    '外部完成后补入 Account ID 进入已完成': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '外部完成后补入 Account ID 进入已完成并创建不可变 Ship-to'],
      ],
    },
    '补入重复 Account ID 被拒': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '补入重复 Account ID 被拒，申请保持原状态不进入已完成'],
      ],
    },
    '首次实际提交计一次工作量': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '首次实际提交计一次工作量，待提交草稿不计'],
      ],
    },
    '状态线性流转不支持退回或取消': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '状态线性流转不支持退回或取消'],
      ],
    },
    '后续状态更新不重复计数': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '后续状态更新不重复计数'],
      ],
    },
    '地址变化新建申请': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '地址变化新建申请：原记录保持不变，原申请保留，新申请按首次提交计一次'],
      ],
    },
    '批次仅汇总展示所涉 Ship-to': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '批次仅汇总展示所涉 Ship-to，不为批次维护独立唯一地址'],
      ],
    },
    '项目仅汇总展示所涉 Ship-to': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '项目仅汇总展示所涉 Ship-to，不为项目维护独立唯一地址'],
      ],
    },
    '未完成申请不影响项目流转': {
      evidence: [
        ['tests/domain/ship-to-management.test.ts', '未完成申请不影响项目流转，且不自动创建项目提醒'],
      ],
    },
  },

  // ────────────────────────── serial-address-update ───────────────────────
  'serial-address-update': {
    '独立登记不关联项目或仪器': { evidence: [['tests/domain/serial-address-update.test.ts', 'instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器']] },
    '独立登记仅校验序列号非空': { evidence: [['tests/domain/serial-address-update.test.ts', 'instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器']] },
    '确认后删除且不再出现在详情与统计': { evidence: [['tests/domain/serial-address-update.test.ts', '确认后删除：更新事实从列表与按更新日期计数统计中消失']] },
    '未确认不删除': { evidence: [['tests/domain/serial-address-update.test.ts', '未确认（不存在）不删除：记录不存在时拒绝且无副作用']] },
    '删除不影响关联仪器与 Ship-to': { evidence: [['tests/domain/serial-address-update.test.ts', '删除更新事实不修改或删除关联仪器（与 Ship-to 主数据无关）']] },
    '删除后实际关联以剩余最近更新事实为准': { evidence: [['tests/domain/serial-address-update.test.ts', '删除较新更新事实后，仪器实际关联新址回退到剩余最近更新事实']] },
    '逐台创建更新事实': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '逐台创建更新事实：记录客户名称、新址地址、序列号、Account ID 与更新时间'],
      ],
    },
    '一台仪器多次地址变化': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '一台仪器多次地址变化：每次登记各创建一条，按更新时间保留可追溯'],
      ],
    },
    '项目新址仅作默认计划': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '项目新址仅作默认计划：不自动成为仪器实际关联新址'],
      ],
    },
    '更新事实表达实际关联': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '更新事实表达实际关联：以最近一条更新事实的新址为准'],
      ],
    },
    '未登记更新事实不视为已关联': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '未登记更新事实不视为已关联新址'],
      ],
    },
    '更新事实不修改 Ship-to': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '更新事实不创建、不修改也不删除任何 Ship-to 主数据'],
      ],
    },
    '创建时默认当天': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '创建时默认当前时间'],
      ],
    },
    '补录历史日期': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '补录历史时间：按所填历史时间保存并归属该月份'],
      ],
    },
    '列表展示与筛选': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '列表展示与筛选：按客户、新址地址、序列号、Account ID 或更新时间'],
      ],
    },
    '按更新日期所属月份计数': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '按更新时间所属月份计数'],
      ],
    },
    '非空字段缺失拒绝保存': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '非空字段缺失拒绝保存'],
      ],
    },
    '序列号与登记仪器一致': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '序列号与登记仪器一致：不一致拒绝保存'],
      ],
    },
    '不引入未确认序列号格式': {
      evidence: [
        ['tests/domain/serial-address-update.test.ts', '不引入未确认的序列号格式约束：仅非空与仪器一致'],
      ],
    },
  },

  // ─────────────────────────── damage-repair-tracking ─────────────────────
  'damage-repair-tracking': {
    '确认后删除且不再出现在详情与统计': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', '5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留']] },
    '未确认不删除': { evidence: [['tests/domain/damage-repair-tracking.test.ts', '未确认（不存在）不删除：记录不存在时拒绝且无副作用']] },
    '删除时原子清理维修上门关联引用': { evidence: [['tests/domain/damage-repair-tracking.test.ts', '确认后删除：事项从 countItems 统计消失，且仅指向该事项的维修上门关联被清理']] },
    '删除不影响关联仪器与项目': { evidence: [['tests/domain/damage-repair-tracking.test.ts', '删除不影响关联仪器与搬迁项目']] },
    '一次损坏一条事项': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '一次损坏一条事项并关联仪器'],
      ],
    },
    '多个备件多条事项': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '多个备件多条事项：每条事项只含一个备件'],
      ],
    },
    '字段完整记录': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '字段完整记录并保存'],
      ],
    },
    '已关闭未修复必须记录原因': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '已关闭未修复必须记录原因'],
      ],
    },
    '记录备件申请日期': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '记录备件申请时间到事项内，不建立独立备件申请对象'],
      ],
    },
    '备件处理状态流转': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '备件处理状态仅限四值流转'],
      ],
    },
    '仅已使用备件计入维修费用': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '仅已使用备件计入维修费用'],
        ['tests/domain/operational-reporting.test.ts', '记录数量按事项计数，仅已使用备件金额计入维修费用'],
      ],
    },
    '数量与金额大于零才能保存': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '数量或金额为空、为 0 或为负数拒绝保存'],
      ],
    },
    'RMB 按固定汇率折算': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', 'RMB 按固定汇率 1 USD = 7.2 RMB 折算为 USD'],
      ],
    },
    '币种边界': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '币种边界：仅限 USD 与 RMB'],
      ],
    },
    '合同金额为 0 时仍可登记损坏': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '合同金额为 0 时仍可登记损坏，事项进入未处理'],
      ],
    },
    '合同金额为 0 时禁止开始/完成维修': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '合同金额为 0 时禁止开始/完成维修'],
      ],
    },
    '合同金额为 0 时禁止备件标记已使用': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '合同金额为 0 时禁止备件标记已使用'],
      ],
    },
    '补齐正数合同金额后允许维修': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '补齐正数合同金额后允许开始/完成维修与标记已使用'],
      ],
    },
    '未完成处理不阻塞全流程流转': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '未完成处理不阻塞全流程流转，可在此后继续处理'],
      ],
    },
    '验收后继续报修/维修': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '验收后仍允许登记与继续维修，不影响验收/待掉票/完成状态'],
      ],
    },
    '按事项记录数量与单条金额统计': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '按事项记录数量与单条金额统计（仅已使用计入）'],
      ],
    },
    '合同占比计算': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '合同占比计算：100 ÷ 2000 = 5%'],
      ],
    },
    '占比超过 100% 显示警告': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '占比超过 100% 允许如实显示并给出警告'],
        ['tests/domain/operational-reporting.test.ts', '占比超过 100% 允许如实显示并给出警告'],
      ],
    },
    '一次维修上门关联多个事项': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '一次维修上门关联多个事项，关联仅引用、不建立维修上门子记录'],
      ],
    },
    '同一事项被多次维修上门关联': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '同一事项被多次维修上门关联'],
      ],
    },
    '事项所属仪器不在活动仪器集合时拒绝关联': {
      evidence: [
        ['tests/domain/damage-repair-tracking.test.ts', '事项所属仪器不在活动仪器集合时拒绝关联，既有关联保持不变'],
      ],
    },
  },

  // ─────────────────────────── qr-request-tracking ────────────────────────
  'qr-request-tracking': {
    '确认删除后不再保留': { evidence: [['tests/domain/qr-request-tracking.test.ts', '确认后删除：从申请历史与工作量统计中消失']] },
    '确认后删除且不再出现在详情与统计': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', '5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留']] },
    '未确认不删除': { evidence: [['tests/domain/qr-request-tracking.test.ts', '未确认（不存在）不删除：记录不存在时拒绝且无副作用']] },
    '删除不影响仪器标记与项目': { evidence: [['tests/domain/qr-request-tracking.test.ts', '删除不影响仪器"二维码是否申请"手工标记']] },
    '保存申请人与申请日期': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '保存申请人与申请时间并选择申请类型'],
      ],
    },
    '申请不关联仪器与项目': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '申请不关联仪器与项目'],
      ],
    },
    '申请不设状态流转': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '申请不设状态流转：一经保存即为一条完整记录'],
      ],
    },
    '一条申请多选多个类型': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '一条申请多选多个类型，允许从九类固定类型中选择'],
      ],
    },
    '类型仅作分类代码': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '类型仅作分类代码：不关联任何搬迁仪器或搬迁项目'],
      ],
    },
    '每条记录每个去重选中类型各计一次': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '每条记录每个去重选中类型各计一次，同条内相同类型只计一次'],
      ],
    },
    '不同申请分别计数': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '不同申请分别计数：相同类型不因分属不同申请而合并'],
      ],
    },
    '重复申请保留历史': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '新旧申请均保留在申请历史中，各自独立保存并计数'],
      ],
    },
    '手工标记是/否': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '手工标记是/否：不随二维码申请记录的保存而变化'],
      ],
    },
    '不保存 URL、不自动创建项目提醒': {
      evidence: [
        ['tests/domain/qr-request-tracking.test.ts', '不保存 URL、不自动创建项目提醒、不阻塞上门/运输/项目流转'],
        ['tests/integration/workbench-todos.sqlite.test.ts', '二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒'],
      ],
    },
  },

  // ───────────────────────────── workbench-todos ──────────────────────────
  'workbench-todos': {
    '查看全部跳转完整提醒视图': { evidence: [['tests/renderer/app.test.tsx', '查看全部进入完整提醒页，默认日期降序，切换升序立即首页重读并稳定翻页']] },
    '默认按提醒日期最近优先': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.3：完整提醒视图默认按提醒日期降序（最近日期优先），含到期分类，仅备注项目也计入']] },
    '可选择升序或降序排列': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立']] },
    '同一提醒日期归入同一泳道列': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列']] },
    '最多选取 7 个非连续提醒日期': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个']] },
    '首批不足时继续向未来补列': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个']] },
    '全量不足时不制造空列': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列']] },
    '每列内项目顺序稳定': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.6：列内 id 稳定 tie-breaker；按列分页携带 selectedDates 锁定日期集合、不重算不重读']] },
    '1024px 下泳道内部横向滚动且键盘可达': { evidence: [['tests/interface/layout.test.ts', '提醒泳道保留日期列头、列内加载和容器内横向滚动']] },
    '完整提醒视图保持独立默认排序': { evidence: [['tests/integration/workbench-todos.sqlite.test.ts', '任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立']] },
    '手工创建项目提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '手工创建项目提醒：保存当前提醒并显示在项目上'],
      ],
    },
    '编辑当前提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '编辑当前提醒：覆盖为新的当前提醒，不保存旧内容或完成历史'],
      ],
    },
    '清除项目提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '清除项目提醒：项目不再显示任何提醒'],
      ],
    },
    '系统不自动生成提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '系统不自动生成提醒：服务无任何自动派生规则，提醒仅由手工维护产生'],
      ],
    },
    '今日到期分类': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '截止日当天归为今日到期'],
      ],
    },
    '已逾期分类': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '超过截止日归为已逾期'],
      ],
    },
    '临期分类': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '临期窗口内且未到期的提醒归为临期'],
      ],
    },
    '无提醒不分类': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '无当前提醒的项目不进入任何到期分类'],
      ],
    },
    '默认临期窗口 7 个自然日': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '未配置时默认未来 7 个自然日'],
        ['tests/domain/workbench-todos.test.ts', '分类纯函数边界：恰好未来 7 天为临期，第 8 天起不分类'],
      ],
    },
    '临期窗口可配置并立即生效': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '配置临期窗口后立即生效于后续到期分类'],
        ['tests/integration/workbench-todos.sqlite.test.ts', '临期窗口配置经 app_settings 持久化并立即生效'],
      ],
    },
    '仅工作台内提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '提供工作台内到期分类与提醒列表，无任何外部消息渠道能力'],
      ],
    },
    '成交高于预算不自动创建提醒': {
      evidence: [
        ['tests/domain/workbench-todos.test.ts', '无关事实变动（区域、执行准备等）不改变项目提醒字段'],
        ['tests/integration/workbench-todos.sqlite.test.ts', '二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒'],
      ],
    },
    '二维码未标记不自动创建提醒': {
      evidence: [
        ['tests/integration/workbench-todos.sqlite.test.ts', '二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒'],
      ],
    },
    'Ship-to 申请未完成不自动创建提醒': {
      evidence: [
        ['tests/integration/workbench-todos.sqlite.test.ts', '二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒'],
      ],
    },
  },

  // ─────────────────────────── operational-reporting ──────────────────────
  'operational-reporting': {
    '存量非标准区域不被静默转换': { evidence: [['tests/domain/operational-reporting.test.ts', '存量非标准区域原值保留并归入「待调整」独立分组（不猜测、不置空、不丢弃）']] },
    '按进单月份与区域汇总进单金额': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按进单月份与区域汇总进单金额，每个项目只计一次，不因合同变更改变'],
      ],
    },
    '按已记录进单日期归属': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按已记录进单时间归属；补录或修正进单时间后归属实时变化'],
      ],
    },
    '同一项目跨月分次掉票分别归属': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '同一项目跨月分次掉票分别归属，金额与次数分开统计'],
      ],
    },
    '同一服务单号只计一次': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '同一服务单号关联多名工程师仍只计一次'],
      ],
    },
    'PM 作为开单业务类型分组': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按唯一服务单号计一次并按四类业务分组，PM 为并列类型'],
      ],
    },
    '按参与工程师筛选开单量（可选）': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按参与工程师筛选开单量（可选），不选择时汇总全部'],
      ],
    },
    '按事项记录数量与单条金额统计': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '记录数量按事项计数，仅已使用备件金额计入维修费用'],
      ],
    },
    'RMB 按固定汇率折算参与统计': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', 'RMB 按固定汇率折算参与统计，原币金额与币种保留用于展示'],
      ],
    },
    '计算单条事项合同占比': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '计算单条事项合同占比；合同金额为空或 0 时不可计算并明确提示'],
      ],
    },
    '事项数量与金额按登记月份归属并取责任人': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '事项数量与金额按登记月份归属并取责任人快照'],
      ],
    },
    '按运输公司与月份汇总物流费用': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按运输公司与月份汇总，展示批次数、合同预算价/物流成交价合计与差异'],
      ],
    },
    '物流成交价高于合同预算价提示计数': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按运输公司与月份汇总，展示批次数、合同预算价/物流成交价合计与差异'],
        ['tests/domain/relocation-execution.test.ts', '物流成交价大于合同预算价仅警告，仍允许保存且不自动创建项目提醒'],
      ],
    },
    '计算物流费用合同占比': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '物流成交价合同占比：RMB 按固定汇率折算 USD ÷ 最新合同金额，空/0 不可算'],
      ],
    },
    '报表导出仅展示合同预算价与物流成交价': {
      evidence: [
        ['tests/integration/operational-reporting.sqlite.test.ts', '物流报表导出 section header 精确：仅月份/运输公司/批次数/合同预算价合计/物流成交价合计/两价差异/成交>预算批次数/已取消批次数，不含旧「实际费用」列'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值'],
      ],
    },
    '历史批次缺费用视为异常数据': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '历史异常批次（已有物流成交价无费用记录）进入清单；底层筛选保留历史兼容（补录后纳入报表）'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用'],
      ],
    },
    '首次提交与后续状态更新不重复计数': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', 'Ship-to 首次提交计一次，后续状态更新不重复计数，待提交草稿不计'],
      ],
    },
    '按首次提交月份归属并取责任人': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', 'Ship-to 首次提交计一次，后续状态更新不重复计数，待提交草稿不计'],
      ],
    },
    '每条记录每个去重选中类型各计一次': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '二维码申请按去重类型计数，不同申请中的同类型分别计数'],
      ],
    },
    '不同申请中的同类型分别计数': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '二维码申请按去重类型计数，不同申请中的同类型分别计数'],
      ],
    },
    '按申请日期归属并取申请人': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '二维码申请按去重类型计数，不同申请中的同类型分别计数'],
      ],
    },
    '按更新日期与客户统计记录数': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '序列号地址更新按更新记录计数、按月份与客户分组，同一仪器多次更新分别计数'],
      ],
    },
    '同一仪器多次更新分别计数': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '序列号地址更新按更新记录计数、按月份与客户分组，同一仪器多次更新分别计数'],
      ],
    },
    '区域按去除空格后的精确值分组': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '区域按去除首尾空白后的精确值分组（7.8）'],
      ],
    },
    '区域修改后报表实时重算': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '区域修改后历史报表实时重算（7.8）'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '区域修改实时重算；账号改名后历史统计仍按动作记录快照归属'],
      ],
    },
    '工作量归属责任人取动作记录': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '事项数量与金额按登记月份归属并取责任人快照'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '区域修改实时重算；账号改名后历史统计仍按动作记录快照归属'],
      ],
    },
    '已取消项目不纳入进单金额统计': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '已取消项目不纳入进单金额统计、不参与掉票统计与项目管道'],
      ],
    },
    '已取消项目不参与掉票统计与金额闭环指标': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '已取消项目不纳入进单金额统计、不参与掉票统计与项目管道'],
      ],
    },
    '已取消项目保留物流与损坏备件真实成本并标记取消': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '取消前实际发生的物流费用与损坏备件金额作为真实成本保留并标记取消'],
      ],
    },
    '月份区间必须手工选择': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '月份区间必须手工选择：未提供时拒绝计算（无默认季度）'],
      ],
    },
    '按月份区间与区域筛选': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按月份区间与区域筛选'],
      ],
    },
    '按开单类型与运输公司筛选': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按开单业务类型筛选'],
        ['tests/domain/operational-reporting.test.ts', '按运输公司筛选物流费用'],
      ],
    },
    '按工程师筛选（可选）': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '按参与工程师筛选开单量（可选），不选择时汇总全部'],
      ],
    },
    '从掉票金额下钻到掉票记录': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '从掉票金额下钻到逐条掉票记录，明细口径与指标口径一致'],
      ],
    },
    '掉票编辑后报表实时更新': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '掉票编辑后报表实时更新（7.10）'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '事后掉票编辑与撤销实时反映到报表；关闭重开后仍一致'],
        ['tests/integration/cross-module-consistency.sqlite.test.ts', '掉票编辑/撤销后：主状态、项目提醒与报表实时一致'],
      ],
    },
    '导出 Excel（.xlsx）': {
      evidence: [
        ['tests/integration/operational-reporting.sqlite.test.ts', '导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值'],
        ['tests/integration/critical-paths.sqlite.test.ts', '12. 报表手工月份区间与三种导出'],
      ],
    },
    '导出图片（PNG）': {
      evidence: [
        ['tests/integration/operational-reporting.sqlite.test.ts', '导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值'],
      ],
    },
    '导出 PDF': {
      evidence: [
        ['tests/integration/operational-reporting.sqlite.test.ts', '导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值'],
      ],
    },
    '多选项目分类标签按 OR 匹配': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '多选标签按 OR 匹配、去重且不重复放大项目派生金额、次数或下钻'],
        ['tests/integration/operational-reporting.sqlite.test.ts', '标签筛选从唯一项目关联集合读取，OR 匹配且拒绝未知标签'],
      ],
    },
    '未选择项目分类标签不限制结果': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '未选标签不限制；标签筛选启用时排除无项目的独立工作量与 projectId 为 null 的服务单'],
      ],
    },
    '标签筛选排除不关联项目的独立记录': {
      evidence: [
        ['tests/domain/operational-reporting.test.ts', '未选标签不限制；标签筛选启用时排除无项目的独立工作量与 projectId 为 null 的服务单'],
      ],
    },
    '下钻与导出沿用标签筛选': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表标签多选将 tagIds 保留到构建、下钻和导出，清空后等价不限制'],
        ['tests/domain/operational-reporting.test.ts', '多选标签按 OR 匹配、去重且不重复放大项目派生金额、次数或下钻'],
      ],
    },
  },

  // ────────────────────────── project-financial-closure ───────────────────
  'project-financial-closure': {
    '无任何项目时待掉票金额为 0': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0']] },
    '孤立财务事实不污染指标': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '孤立排除：引用不存在项目的掉票/合同事实不计入指标']] },
    '仍存在项目的有效财务事实计入指标': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入'], ['tests/integration/workbench-read-v2.sqlite.test.ts', '任务4.1：totalProjects 与待掉票金额在同一修订一致快照内读取（单一聚合查询）']] },
    '诊断清理与防复发': { evidence: [['tests/integration/financial-integrity.sqlite.test.ts', '治理后待掉票金额指标保持正常（现有 repository 读取验证，不改其代码）'], ['tests/integration/financial-integrity.sqlite.test.ts', '防复发：正常 foreign_keys=ON 下写入无项目合同/掉票被拒；治理不产生新孤立行']] },
    '治理不改变掉票撤销终态与不可物理删除': { evidence: [['tests/integration/workbench-delete.sqlite.test.ts', 'invoice 删除映射为撤销：必填撤销日期/原因，行不物理删除']] },
    '活跃孤立掉票治理撤销保留原行': { evidence: [['tests/integration/financial-integrity.sqlite.test.ts', '治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费']] },
    '结构性外键违规持续报告且不宣称归零': { evidence: [['tests/integration/financial-integrity.sqlite.test.ts', '治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费']] },
    '手工录入合同含税金额': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '手工录入合同含税金额：保存手工值，不根据净值税率自动计算或改写'],
      ],
    },
    '金额与净值税率计算结果不一致时仅警告': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '金额与净值税率计算结果不一致时仅警告，仍允许保存且不自动覆盖'],
      ],
    },
    '合同金额直接覆盖修改': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '合同金额直接覆盖修改：保存新值，不保存正式合同变更对象/历史、不要求原因'],
      ],
    },
    '合同金额允许为 0': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '合同金额允许为 0；除合同金额外的其他录入金额不允许为 0'],
      ],
    },
    '进单时保存金额快照': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '正式进单保存金额快照，合同金额覆盖不改写快照'],
        ['tests/domain/relocation-entry.test.ts', '正式进单锁定进单金额快照（后续合同金额覆盖不改写快照，见 5.2）'],
      ],
    },
    '合同金额覆盖不改写历史进单金额': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '正式进单保存金额快照，合同金额覆盖不改写快照'],
      ],
    },
    '合同金额覆盖后进单金额不变且占比按新值重算': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '正式进单保存金额快照，合同金额覆盖不改写快照'],
        ['tests/integration/financial-closure.sqlite.test.ts', '合同金额覆盖不改写进单金额快照（2.1 快照锁定联动），最新金额用于占比重算'],
      ],
    },
    '最终可确认金额默认取合同金额并可调整': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '默认取合同金额并可调整，调整不影响原合同金额'],
        ['tests/domain/relocation-entry.test.ts', '最终可确认金额默认取合同 USD 含税金额'],
      ],
    },
    '最终可确认金额不随合同覆盖同步': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '最终可确认金额不随合同金额覆盖同步'],
      ],
    },
    '合同金额为 0 时正式进单最终可确认金额允许暂空且首次掉票前必须补录': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '合同金额为 0 时正式进单 final 保持 null（不再强制另行录入，进单后基线待执行）'],
        ['tests/domain/relocation-entry.test.ts', '合同金额为 0 时正式进单 final 保持 null，另行录入 > 0 才设值（TBD-11 更新）'],
        ['tests/renderer/app.test.tsx', '保存意图分组实时展示摘要，并在正式进单合同金额为零时提示'],
      ],
    },
    '最终可确认金额不得低于累计有效掉票金额': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '最终可确认金额不得低于累计掉票金额'],
      ],
    },
    '同一项目多次掉票': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '同一项目可多次掉票，各自记录时间与金额并分别计数'],
      ],
    },
    '掉票单笔金额必须大于 0': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '掉票单笔金额必须大于 0'],
      ],
    },
    '其他录入金额不得为 0 或负数': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '其他录入金额不得为 0 或负数'],
      ],
    },
    '金额按两位小数十进制定点四舍五入': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '金额按两位小数十进制定点四舍五入，全程不采用二进制浮点'],
        ['tests/domain/money.test.ts', '1234.567 按两位小数四舍五入为 1234.57（spec 场景）'],
      ],
    },
    '新增掉票导致累计超额被拒绝': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '新增掉票导致累计超额被拒绝，提示先调整最终可确认金额'],
        ['tests/integration/critical-paths.sqlite.test.ts', '5. 掉票金额闭环重算'],
      ],
    },
    '先调整最终可确认金额后再掉票': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '先调整最终可确认金额后再掉票'],
      ],
    },
    '覆盖修改掉票金额与日期': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '覆盖修改掉票金额与日期，不保留旧值，自动记录最后修改时间并重算'],
      ],
    },
    '已撤销掉票禁止编辑': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已撤销掉票禁止编辑'],
      ],
    },
    '编辑后重算项目状态': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '编辑后重算项目状态：任意有效掉票即已完成（不再等累计金额足额）'],
      ],
    },
    '撤销一条掉票记录': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '撤销一条掉票记录：保留记录但标记已撤销，不再计入金额与次数并重算状态'],
      ],
    },
    '掉票记录不可物理删除': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '掉票记录不可物理删除'],
      ],
    },
    '已撤销掉票禁止重复撤销': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已撤销掉票禁止重复撤销'],
      ],
    },
    '已撤销掉票禁止重新激活': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已撤销掉票禁止重新激活，更正需新增有效掉票'],
      ],
    },
    '登记任一笔有效掉票即进入已完成': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '任意成功登记一笔掉票即进入已完成（不再等累计金额足额）'],
        ['tests/domain/lifecycle.test.ts', '自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）'],
      ],
    },
    '已完成项目因撤销掉票回到待掉票': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已完成项目因撤销掉票回到待掉票'],
      ],
    },
    '非待掉票/已完成状态修改金额不改变主状态': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '非待掉票/已完成状态修改金额不改变主状态'],
      ],
    },
    '已取消项目禁止修改金额': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已取消项目禁止修改合同金额与最终可确认金额'],
      ],
    },
    '已取消项目禁止登记或修改掉票': {
      evidence: [
        ['tests/domain/financial-closure.test.ts', '已取消项目禁止新增、编辑或撤销掉票'],
      ],
    },
  },

  // ─────────────────────────── historical-data-import ─────────────────────
  'historical-data-import': {
    "七类数据均进入导入计划": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "NormalizedRow → 七类记录计划"],
      ],
      note: "validatePlan 把七类规范化行构建为记录计划",
    },
    "供应商来源并入物流类别": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "供应商只作物流参考"],
      ],
      note: "供应商不构成第八类，运输公司并入物流类别",
    },
    "文件与粘贴结果等价": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "相同语义内容：文件与粘贴产生相同规范化计划摘要"],
      ],
      note: "文件与粘贴共享同一规范化行模型，同内容计划摘要一致",
    },
    "无业务键时使用稳定源行标识": {
      evidence: [
        ["tests/domain/historical-data-import.test.ts", "无业务键时用源行键"],
      ],
      note: "无业务键的行以源文件+sheet+行号标识（稳定源行身份）",
    },
    "仅有物理行位置时提示身份风险": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "POSITION_ONLY_IDENTITY"],
      ],
      note: "无业务键且无 source_row_id → POSITION_ONLY_IDENTITY 警告（重排行风险）",
    },
    "同一 ECC 聚合为一个项目": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "同一 ECC 聚合为一个搬迁项目"],
      ],
      note: "ECC 为项目/合同聚合主键",
    },
    "不同来源相同字段值一致": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "不同来源相同规范化值不产生冲突"],
      ],
      note: "相同规范化值不产生来源冲突",
    },
    "不同来源字段值冲突": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "不同合法值进入冲突并展示候选来源"],
      ],
      note: "冲突必须显式选择或修正，不自动覆盖",
    },
    "必填字段错误可定位": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "必填缺失可定位"],
      ],
      note: "错误携带类别/字段/网格行/来源位置",
    },
    "允许的价格异常仅警告": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "成交价格高于预算价格仅警告"],
      ],
      note: "成交>预算为 warning，不阻断提交",
    },
    "不允许忽略阻断项": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "错误或未解决冲突不得生成提交资格"],
      ],
      note: "error/conflict 阻断提交资格",
    },
    "缺少 ECC 阻止项目导入": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "缺 ECC 报必填错误并阻止导入"],
      ],
      note: "项目缺 ECC 报必填错误",
    },
    "费用登记日期不可由月份推断": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "物流费用申请（登记）时间为目标必填"],
      ],
      note: "仅月份无法推断具体登记日期，缺失为阻断错误",
    },
    "重复服务单号阻止导入": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "重复非空服务单号 → 冲突清单"],
      ],
      note: "重复非空服务单号进入冲突清单",
    },
    "独立申请不强制关联 ECC": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "二维码申请与 Ship-to 申请不强制关联 ECC"],
      ],
      note: "QR/Ship-to 申请无 ECC 字段不产生关联错误",
    },
    "二维码类型不得由数量猜测": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "二维码类型不得由数量猜测"],
      ],
      note: "仅类型数量无具体类型 → 冲突",
    },
    "序列号地址更新不修改 Ship-to": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "序列号地址更新不创建或修改 Ship-to"],
      ],
      note: "地址更新只记录事实，不创建/修改 Ship-to 主数据",
    },
    "反复校验不改变业务数据": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "反复执行不改变正式业务数据"],
      ],
      note: "校验阶段零业务写入",
    },
    "删除草稿不删除业务记录": {
      evidence: [
        ["tests/integration/import-seven-category-flow.sqlite.test.ts", "删除草稿：工作区内容清除，正式业务库零接触"],
      ],
      note: "删除草稿只清工作区，正式业务库零接触",
    },
    "修改单元格使封存失效": {
      evidence: [
        ["tests/domain/import-seal.test.ts", "草稿单元格修改 → seal 立即失效"],
      ],
      note: "seal 绑定草稿修订，单元格修改即失效",
    },
    "目标数据变化使封存失效": {
      evidence: [
        ["tests/domain/import-seal.test.ts", "目标业务修订变化 → seal 失效"],
      ],
      note: "任一目标业务写入使旧 seal 无效",
    },
    "相同语义内容产生稳定摘要": {
      evidence: [
        ["tests/domain/import-seal.test.ts", "相同语义内容产生稳定计划摘要"],
      ],
      note: "相同语义内容产生稳定计划摘要与 seal 绑定摘要",
    },
    "最后一类写入失败时全部回滚": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "零部分写入"],
      ],
      note: "8.45 故障注入逐阶段验证：任一 writer 失败整体回滚零部分写入",
    },
    "审计写入失败时全部回滚": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "零部分写入"],
      ],
      note: "8.45 run_audit 阶段注入失败整体回滚零部分写入",
    },
    "写后数量不一致时全部回滚": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "零部分写入"],
      ],
      note: "8.45 reconcile 阶段对账失败整体回滚零部分写入",
    },
    "安全快照失败时不得开始提交": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "快照失败：禁止开始业务写入"],
      ],
      note: "快照失败禁止开始业务写入、草稿保持 sealed",
    },
    "相同计划重复执行零写入": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "相同计划重跑：幂等跳过"],
      ],
      note: "相同计划重跑幂等跳过、零业务写入",
    },
    "安全 forward-fix 更新目标": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "安全 forward-fix：同来源键修正更新目标字段"],
      ],
      note: "同来源键 forward-fix 只更新同 source key 记录",
    },
    "人工修改目标时阻止覆盖": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "人工修改目标阻塞覆盖"],
      ],
      note: "人工修改目标阻止覆盖且人工值保留",
    },
    "缺少旧目标快照时阻止覆盖": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "旧记录缺少可信基线阻塞覆盖"],
      ],
      note: "v9 快照缺失阻止覆盖",
    },
    "状态由事实重建": {
      evidence: [
        ["tests/integration/import-seven-category-flow.sqlite.test.ts", "主状态由导入事实确定性重建"],
        ["tests/domain/historical-data-import.test.ts", "项目状态由事实推导重建"],
        ["tests/domain/historical-data-import.test.ts", "导入状态真实变化与项目写入同事务记录最小转换审计"],
      ],
      note: "主状态由导入事实确定性重建",
    },
    "导入时间不改变统计月份": {
      evidence: [
        ["tests/integration/import-seven-category-flow.sqlite.test.ts", "导入时间只进审计且不改变报表月份"],
      ],
      note: "报表月份按源业务时间，不因导入时间改变",
    },
    "可选源业务日期缺失保持为空": {
      evidence: [
        ["tests/domain/historical-data-import.test.ts", "源业务时间缺失（可选）时保留为空"],
      ],
      note: "可选源业务日期缺失保留为空，不用导入时间填充",
    },
    "提交审计归属本地用户": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "账号审计与业务工作量分离"],
        ["tests/integration/import-seven-category-flow.sqlite.test.ts", "草稿创建人与最终提交人分列审计"],
      ],
      note: "import_run 记录内部本地用户 ID 与确认时用户名快照",
    },
    "导入事实不计作手工工作量": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "业务事实 source=history_import"],
      ],
      note: "业务事实 source=history_import、不计 actor 手工工作量",
    },
    "会话在提交前失效": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "登出/恢复清空会话后 seal 失效"],
      ],
      note: "会话失效取消活动读取并 invalidate seal",
    },
    "公式不被执行": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "DDE 与外部工作簿引用公式标记为不可安全读取"],
        ["tests/security/import-malicious-workbook.test.ts", "公式安全"],
      ],
      note: "DDE/外部引用/无缓存公式不执行不联网，置空并报问题",
    },
    "标识符保留前导零": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "按文本保留前导零"],
      ],
      note: "ECC/服务单号/Account ID/序列号按文本保留前导零",
    },
    "超出资源上限时安全拒绝": {
      evidence: [
        ["tests/domain/import-zip-preflight.test.ts", "ZIP 炸弹"],
        ["tests/domain/import-zip-preflight.test.ts", "行数超过上限拒绝"],
      ],
      note: "有界预检按文件/entry/展开/压缩比/sheet/行列单元格上限安全拒绝",
    },
    "空计划不可提交": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "空导入阻止提交"],
      ],
      note: "七类均确认无数据且总数为零 → 空导入阻止提交",
    },
    "提交异常退出后重新判定": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "无成功审计 → 完整回滚并要求重新完整校验"],
        ["tests/domain/import-commit.test.ts", "成功审计与完整事务同时存在"],
      ],
      note: "中断后按成功审计判定完整成功或完整回滚",
    },
  },
  'local-data-persistence': {
    '追加迁移不修改已发布迁移': { evidence: [['tests/persistence/migration-v15.test.ts', '全新库引导到最新版本：迁移序列 1..16、user_version=16、v15 四列已建立、审计表/索引/FK 已建、可写入最小审计事实']] },
    '旧库升级保留既有数据并初始化新字段': { evidence: [['tests/persistence/migration-v15.test.ts', 'v14 存量库升级到 v15：业务数据完整保留、legacy region 原文不变、新列空初始化、legacy origin/deleted marker 保持 null']] },
    '新增字段与受控区域值持久化': { evidence: [['tests/integration/create-project-ecc-rules.sqlite.test.ts', 'v15 新字段建档后更新并关闭重开：region 受控枚举及 null/false 语义均持久化']] },
    '迁移诊断并清理孤立财务事实': { evidence: [['tests/integration/financial-integrity.sqlite.test.ts', 'v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留'], ['tests/integration/financial-integrity.sqlite.test.ts', '治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费']] },
    '结构性外键违规持续报告且不阻断迁移': { evidence: [['tests/integration/financial-integrity.sqlite.test.ts', 'v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留']] },
    'v15 已发布库追加 v16 不修改既有迁移': { evidence: [['tests/persistence/migration-v16.test.ts', '全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过']] },
    'v15 库升级保留数据并初始化暂定范围列': { evidence: [['tests/persistence/migration-v16.test.ts', 'v15 存量库升级到 v16：业务数据完整保留、legacy region 原文不变、v15 字段原样保留、新列 null 初始化']] },
    '暂定搬迁范围字段持久化保留': { evidence: [['tests/integration/create-project-ecc-rules.sqlite.test.ts', '关闭重开持久化：建档/编辑的暂定仪器范围字段重开后保留']] },
    'v16 迁移失败保留可恢复状态': { evidence: [['tests/persistence/migration-v16.test.ts', '注入失败保留迁移前数据与可恢复状态：整体回滚、版本仍为 15、全部 v16 结构回滚、迁移前备份可恢复']] },
    '离线启动并完成核心操作': {
      evidence: [
        ['tests/persistence/runtime-boundary.test.ts', '离线可用：无任何远程服务时本机 SQLite 全流程（写入→备份→关闭→重开）正常'],
      ],
    },
    '无网络时业务不中断': {
      evidence: [
        ['tests/persistence/runtime-boundary.test.ts', '离线无远程依赖：领域与持久化源码不导入任何网络模块'],
      ],
    },
    '关闭重开后数据保留': {
      evidence: [
        ['tests/persistence/connection.test.ts', '关闭并重开应用后数据保留（真实临时 SQLite）'],
        ['tests/integration/relocation-project-lifecycle.sqlite.test.ts', '正式进单全流程落库（ECC/进单时间/快照/最终金额），关闭重开保留'],
        ['tests/integration/runtime-lifecycle.sqlite.test.ts', '启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置'],
        ['e2e/electron-smoke.spec.ts', '关闭并重开应用：无密码模式直接进入工作台，已有账号与数据保留'],
      ],
    },
    '数据保存于本机数据库': {
      evidence: [
        ['tests/persistence/connection.test.ts', '数据库位于本机数据目录（不依赖远程存储）'],
      ],
    },
    '日常使用不自动外发': {
      evidence: [
        ['tests/persistence/runtime-boundary.test.ts', '离线无远程依赖：领域与持久化源码不导入任何网络模块'],
      ],
    },
    '数据库文件不因本地用户加密': {
      evidence: [
        ['tests/persistence/account-persistence.test.ts', '本地账号不加密 SQLite：数据库文件为普通 SQLite 且账号数据直接可读'],
      ],
    },
    'Windows 操作系统账户保护数据文件与备份': {
      abstract: true,
      evidence: [['docs/verification/迁移执行与运维说明.md', '无应用内访问门槛']],
      note: 'Windows 操作系统账户边界已由客户在 Windows 目标环境验收（tasks 8.85）；10.6 交付文档已明确无访问门槛、SQLite 不加密、内部本地用户不能防止直接读取数据库文件',
    },
    '当日首次使用自动创建备份': {
      evidence: [
        ['tests/persistence/backup.test.ts', '当日首次使用创建自动备份（按本地日期命名）'],
        ['tests/integration/runtime-lifecycle.sqlite.test.ts', '启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置'],
      ],
    },
    '当日已有备份不重复创建': {
      evidence: [
        ['tests/persistence/backup.test.ts', '当日已有自动备份不重复创建'],
      ],
    },
    '轮转清理更旧自动备份': {
      evidence: [
        ['tests/persistence/backup.test.ts', '自动备份轮转：创建第 8 份时清理最早 1 份、保留最近 7 份'],
      ],
    },
    '手动备份不受数量限制': {
      evidence: [
        ['tests/persistence/backup.test.ts', '手动备份不受数量限制：自动轮转不清除手动备份'],
      ],
    },
    '手动备份到所选目录': {
      evidence: [
        ['tests/persistence/backup.test.ts', '自动备份文件可读（在线 backup 生成有效副本）'],
        ['tests/integration/workbench-facade.sqlite.test.ts', '真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请'],
      ],
      note: '手动备份目标目录参数化（createManualBackup(db, targetDir)）在 backup.test.ts 覆盖',
    },
    '确认并验证后恢复成功': {
      evidence: [
        ['tests/persistence/restore.test.ts', '确认并验证后恢复成功：恢复后数据与备份一致'],
        ['tests/integration/runtime-lifecycle.sqlite.test.ts', '启动自动备份 → 初始化 → 录入 → 关闭重开登录 → 手动备份 → 恢复 → 恢复码重置'],
      ],
    },
    '恢复失败不覆盖当前数据': {
      evidence: [
        ['tests/persistence/restore.test.ts', '备份不可读/损坏时停止恢复并保留当前数据（不覆盖）'],
      ],
    },
    '备份失败明确报错': {
      evidence: [
        ['tests/persistence/restore.test.ts', '所选备份不存在时给出明确错误'],
      ],
      note: '备份失败明确反馈由 restore/backup 的失败路径与错误类型覆盖（RestoreError 等）',
    },
    '恢复失败明确报错': {
      evidence: [
        ['tests/persistence/restore.test.ts', '备份不可读/损坏时停止恢复并保留当前数据（不覆盖）'],
        ['tests/persistence/restore.test.ts', '所选备份不存在时给出明确错误'],
      ],
    },
    '升级时迁移现有数据': {
      evidence: [
        ['tests/persistence/migration.test.ts', '升级时迁移现有数据（旧结构数据完整保留到新结构）'],
      ],
    },
    '迁移失败保留可恢复状态': {
      evidence: [
        ['tests/persistence/migration.test.ts', '迁移失败：注入失败迁移 → 整体回滚、保留原库与迁移前安全备份、返回明确恢复信息'],
      ],
    },
    '重启后保留标签库与项目关联': {
      evidence: [
        ['tests/integration/project-tags.sqlite.test.ts', '重开 SQLite 后保留自定义目录与项目关联'],
      ],
    },
    '备份恢复后保留标签库与项目关联': {
      evidence: [
        ['tests/integration/project-tags.sqlite.test.ts', '真实手动备份与恢复保留自定义标签和项目关联'],
      ],
    },
    '升级幂等初始化预设标签并保留既有数据': {
      evidence: [
        ['tests/persistence/migration-v17.test.ts', '空库引导到 v17：建立规范化三表、精确且稳定地 seed 三组七标签'],
        ['tests/persistence/migration-v17.test.ts', 'v16 存量库升级并重复 bootstrap：保留项目且不重复 seed'],
      ],
    },
  },

  // ─────────────────────────── workbench-interface ────────────────────────
  'workbench-interface': {
    '验证矩阵只读取正式规格基线': { evidence: [['scripts/build-verification-matrix.mjs', '仅扫描 `openspec/specs/` 正式基线']] },
    '测试标题演进后证据仍可校验': { evidence: [['scripts/build-verification-matrix.mjs', '测试源码仅匹配测试标题']] },
    'Active delta 通过严格 OpenSpec 验证': { evidence: [['scripts/build-verification-matrix.mjs', 'active 或 archived change 的 delta 由各自的 `openspec validate <change> --strict`']] },
    '跨平台解析正式基线 capability 路径': { evidence: [['tests/interface/build-verification-matrix.test.ts', '对 macOS 与 Windows 风格 spec 路径生成相同 capability key']] },
    '从详情编辑已有项目标签': { evidence: [['tests/renderer/app.test.tsx', '详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口']] },
    '无标签项目显示添加入口': { evidence: [['tests/renderer/app.test.tsx', '详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口']] },
    '从队列快捷入口编辑对应行项目': { evidence: [['tests/renderer/app.test.tsx', '队列标签入口固化行项目和草稿，不改变当前工作区；两个入口共享编辑器']] },
    '排除非就近录入方式与表格标签展开': { evidence: [['tests/renderer/app.test.tsx', '标签分配只提供单项目文字入口，不提供批量、右键、快速记录或表格内 picker']] },
    '两个入口打开相同编辑流程并加载现有标签': { evidence: [['tests/renderer/app.test.tsx', '队列标签入口固化行项目和草稿，不改变当前工作区；两个入口共享编辑器']] },
    '按分组调整选择后仅保存标签': { evidence: [['tests/renderer/app.test.tsx', '标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新']] },
    '无变化时不可提交': { evidence: [['tests/renderer/app.test.tsx', '标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新']] },
    '保存成功按选中目标刷新相关展示并反馈': { evidence: [['tests/renderer/app.test.tsx', '标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新']] },
    '保存失败保留可重试状态': { evidence: [['tests/renderer/app.test.tsx', '写入失败保留草稿可重试；写入成功后的刷新失败关闭并提示且不重复写入']] },
    '脏草稿关闭先确认放弃': { evidence: [['tests/renderer/app.test.tsx', '脏草稿关闭先确认放弃']] },
    '干净草稿直接关闭且 busy 禁止关闭': { evidence: [['tests/renderer/app.test.tsx', '干净草稿四种关闭渠道直接关闭；提交中四渠道均不能关闭']] },
    '内容在流程内部滚动': { evidence: [['tests/interface/layout.test.ts', '标签编辑弹窗固定头尾，仅中部选择区内部滚动并隔离滚动链']] },
    '窄窗口下入口收纳但保持可用': { evidence: [['tests/interface/layout.test.ts', '760px 下详情和队列标签入口保留稳定类、完整文字按钮及 40px 最小高度']] },
    '待掉票金额仅计入有效关联事实': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '孤立排除：引用不存在项目的掉票/合同事实不计入指标']] },
    '无项目时指标显示 0': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '零项目为 0：仅孤立/脏财务事实（无任何项目）时 pendingAmount 必为 0']] },
    '保持有效项目财务口径': { evidence: [['tests/integration/financial-closure.sqlite.test.ts', '已完成余额纳入：已完成项目仍有有效待掉票余额时按 final − 有效掉票计入'], ['tests/integration/financial-closure.sqlite.test.ts', '已取消排除：仅已取消项目存在时 pendingAmount 为 0（口径不改动为仅活跃项目）']] },
    '登记记录删除需确认': { evidence: [['tests/renderer/app.test.tsx', '删除确认取消时通用保护阻止 v2Delete 调用']] },
    '各类登记记录均提供删除入口': { evidence: [['tests/renderer/app.test.tsx', '八类登记记录逐类提供删除入口并调用对应 v2Delete kind']] },
    '搬迁项目维持取消语义': { evidence: [['tests/renderer/app.test.tsx', '项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销']] },
    '掉票记录维持撤销语义': { evidence: [['tests/renderer/app.test.tsx', '项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销']] },
    '顶栏入口跳转完整记录视图': { evidence: [['tests/renderer/app.test.tsx', '统一历史入口按日期真正跨项目读取，展示项目上下文并受保护删除']] },
    '按业务日期倒序排列': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', 'independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页']] },
    '相同业务日期稳定排序': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', 'independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页']] },
    '按客户名称或编号搜索': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND']] },
    '按白名单字段搜索命中': {
      evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '白名单逐类可命中']],
    },
    '关键词跨类型工程师命中': {
      evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '两类工程师均可命中']],
    },
    '区域筛选为固定枚举': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND']] },
    '搜索与区域筛选组合': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND']] },
    '展示项目级计划上门日期': {
      evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', 'planVisitAt 映射正确']],
    },
    '空值与一致性': {
      evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', 'planVisitAt 映射正确']],
    },
    '查看已有暂定仪器数量': { evidence: [['tests/renderer/app.test.tsx', '编辑项目资料忽略旧暂定仪器三字段，回显并保存 UPS 与其他项目资料']] },
    '暂定仪器数量允许留空': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '补录或调整后回显最新值': { evidence: [['tests/domain/relocation-execution.test.ts', '编辑项目资料维护暂定仪器数量（6.5：查看/留空/补录/调整）']] },
    '每页固定展示 20 个项目': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确']] },
    '筛选或搜索后重算总数与分页': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20']] },
    '翻页时页内顺序稳定': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确']] },
    '最后一页允许少于 20 个项目': { evidence: [['tests/integration/workbench-read-v2.sqlite.test.ts', '任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20']] },
    '不展示错误的每页数量文案': { evidence: [['tests/interface/layout.test.ts', '项目队列明确固定每页20且不存在旧文案']] },
    '滚动时头部整体固定': { evidence: [['tests/interface/layout.test.ts', '只固定顶部导航，任务区保持紧凑并随页面滚动']] },
    '固定头部不遮挡内容': { evidence: [['tests/interface/layout.test.ts', '只固定顶部导航，任务区保持紧凑并随页面滚动']] },
    '不拦截键盘焦点': { evidence: [['e2e/workbench-v2-layout.spec.ts', '最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切']] },
    '进入工作台先处理项目提醒': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '提醒与项目队列不被其他板块取代': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '顶部任务入口与运营指标': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '启动直接进入工作台': {
      evidence: [
        ['tests/renderer/app.test.tsx', '无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程'],
        ['e2e/electron-smoke.spec.ts', '空数据库启动直接进入工作台'],
      ],
    },
    '无访问门槛入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程'],
      ],
    },
    '访问门缺失不改变主结构': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '项目队列中颜色区分': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '当前上下文与吞吐板块一致区分': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '六阶段展示项目数与平均停留': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '不提供流入流出与自动瓶颈提示': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
      note: '生命周期吞吐精简：不提供流入流出（inflow/outflow）节奏指标与自动瓶颈提示（客户最终反馈 2026-08-10）',
    },
    '点击阶段筛选项目队列': {
      evidence: [
        ['tests/renderer/app.test.tsx', '阶段、提醒、区域和查询筛选下推并重置到首页 cursor'],
      ],
    },
    '随选中项目更新上下文': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '展示状态异常与当前项目提醒': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '展示金额闭环': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '展示非阻塞事项并标注不阻塞': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '展示项目分类标签': {
      evidence: [
        ['tests/renderer/app.test.tsx', '详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口'],
      ],
    },
    '点击项目选中并刷新上下文': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '点击项目提醒联动所属项目': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '点击阶段筛选并选中项目': {
      evidence: [
        ['tests/renderer/app.test.tsx', '阶段、提醒、区域和查询筛选下推并重置到首页 cursor'],
      ],
    },
    '单页分组呈现与对应字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建搬迁项目默认正式进单，保存意图及选项按要求排序'],
        ['tests/renderer/app.test.tsx', '新建搬迁项目默认正式进单，保存意图及选项按要求排序'],
      ],
    },
    '搬迁范围分组字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建搬迁项目默认正式进单，保存意图及选项按要求排序'],
      ],
    },
    '执行准备分组字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建搬迁项目默认正式进单，保存意图及选项按要求排序'],
      ],
    },
    '保存为待进单': {
      evidence: [
        ['tests/integration/workbench-facade.sqlite.test.ts', '真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请'],
      ],
      note: '单页分组录入「保存为待进单」（intent=draft）经 WorkbenchFacade（Electron 主进程入口）真实落库；正式进单/未进单先执行两个保存路径由 electron-smoke E2E 覆盖',
    },
    '正式进单': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建项目由顶部主操作提交正式进单，保留 UPS 且不夹带已移除仪器范围字段'],
      ],
    },
    '未进单先执行': {
      evidence: [
        ['e2e/electron-smoke.spec.ts', '未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）'],
      ],
    },
    '填写服务单号要求工程师并同次创建开单': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
      note: '单页录入中「服务单号必填工程师并同次保存」由领域测试 service-order-recording 3.10 覆盖，界面透传',
    },
    '可后补字段不无提示丢失且不自动生成提醒': {
      evidence: [
        ['tests/renderer/app.test.tsx', '保存意图分组实时展示摘要，并在正式进单合同金额为零时提示'],
      ],
    },
    '人工选择主状态并就地反馈': {
      evidence: [
        ['tests/integration/workbench-facade.sqlite.test.ts', '人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层'],
        ['e2e/electron-smoke.spec.ts', '未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）'],
      ],
    },
    '自动触发结果如实反映': {
      evidence: [
        ['e2e/electron-smoke.spec.ts', '未进单先执行 → 实际装机完成自动待验收 → 验收进入待掉票（核心动作补充闭环）'],
      ],
    },
    '覆盖八类业务动作': {
      evidence: [
        ['tests/renderer/app.test.tsx', '快速记录合并开单入口，八类动作均提供真实字段'],
      ],
    },
    '备件申请并入损坏/维修事项': {
      evidence: [
        ['tests/renderer/app.test.tsx', '快速记录合并开单入口，八类动作均提供真实字段'],
      ],
    },
    '二维码申请不在项目快速记录': {
      evidence: [
        ['tests/renderer/app.test.tsx', '快速记录合并开单入口，八类动作均提供真实字段'],
      ],
    },
    '批次表单字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
    },
    '物流费用并入批次表单': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
    },
    '开单表单字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单记录 tab 读取 orders，并只展示四个服务单字段'],
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
      note: '开单记录为原"上门活动"入口并入后的合并入口，表单展示开单日期、工程师、开单类型、服务单号',
    },
    '搬迁仪器表单二维码是否申请手工字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
    },
    '损坏/维修表单合同金额 0 就地反馈': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
      ],
    },
    '序列号地址更新与二维码申请独立模块入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数'],
      ],
    },
    '不用通用空表单': {
      evidence: [
        ['tests/renderer/app.test.tsx', '快速记录合并开单入口，八类动作均提供真实字段'],
      ],
    },
    '修改批次运输信息与两价': {
      evidence: [
        ['tests/renderer/app.test.tsx', '物流费用编辑回显全部五项，未改的 appliedAt 按原值提交并可清空其他字段'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt'],
      ],
    },
    '费用登记日期不可修改且归属月份不变': {
      evidence: [
        ['tests/renderer/app.test.tsx', '物流费用编辑回显全部五项，未改的 appliedAt 按原值提交并可清空其他字段'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt'],
      ],
    },
    '不提供独立物流费用补录入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '快速记录合并开单入口，八类动作均提供真实字段'],
        ['tests/integration/workbench-facade.sqlite.test.ts', 'batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用'],
      ],
      note: '快速记录菜单不出现独立「实际物流费用」动作；费用仅通过批次创建/批次编辑中的合同预算价、物流成交价维护（见「物流费用记录可预填编辑」测试）',
    },
    '项目队列行内记录入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口'],
      ],
    },
    '当前上下文就近入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口'],
      ],
    },
    '详情 tab 就近入口': {
      evidence: [
        ['tests/renderer/app.test.tsx', '队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口'],
      ],
    },
    '项目提醒直达所属项目': {
      evidence: [
        ['tests/renderer/app.test.tsx', '上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目'],
      ],
    },
    '必填与可选标识及帮助': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建搬迁项目默认正式进单，保存意图及选项按要求排序'],
      ],
    },
    '校验失败就地提示': {
      evidence: [
        ['tests/renderer/app.test.tsx', '开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈'],
        ['tests/integration/workbench-facade.sqlite.test.ts', '人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层'],
      ],
    },
    '主状态校验失败就地反馈': {
      evidence: [
        ['tests/integration/workbench-facade.sqlite.test.ts', '人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层'],
      ],
    },
    '提交中禁用防止重复': {
      evidence: [
        ['tests/renderer/app.test.tsx', '提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据'],
      ],
    },
    '成功 Toast 并同步更新': {
      evidence: [
        ['tests/renderer/app.test.tsx', '提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据'],
      ],
    },
    '导出 Excel': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示'],
        ['e2e/workbench-v2-terminal-export.spec.ts', '运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效'],
      ],
    },
    '导出 PNG': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示'],
        ['e2e/workbench-v2-terminal-export.spec.ts', '运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效'],
      ],
    },
    '导出 PDF': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示'],
        ['e2e/workbench-v2-terminal-export.spec.ts', '运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效'],
      ],
    },
    '导出失败就地提示': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示'],
      ],
    },
    '按月份与维度筛选': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表筛选贯通查询、下钻和导出，明细使用中文列名与业务值'],
      ],
    },
    '下钻明细中文展示': {
      evidence: [
        ['tests/renderer/app.test.tsx', '报表筛选贯通查询、下钻和导出，明细使用中文列名与业务值'],
      ],
    },
    'Escape 关闭当前层': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃'],
      ],
    },
    '打开后焦点移至首字段': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃'],
      ],
    },
    'label 关联可访问名称': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃'],
      ],
    },
    '字号基线': {
      evidence: [
        ['tests/interface/layout.test.ts', '正文、数据和控件使用统一的系统字体与 4px 间距基线'],
      ],
    },
    '层级与对比': {
      evidence: [
        ['tests/interface/layout.test.ts', '正文、数据和控件使用统一的系统字体与 4px 间距基线'],
      ],
    },
    '多行文本行高可读': {
      evidence: [
        ['tests/interface/layout.test.ts', '正文、数据和控件使用统一的系统字体与 4px 间距基线'],
      ],
    },
    '详情 tab 可切换展开': {
      evidence: [
        ['tests/renderer/app.test.tsx', '详情默认打开搬迁仪器并按需切换 section，不再显示项目总览 tab'],
      ],
    },
    '扩展 tab 或独立导航模块提供新增能力': {
      evidence: [
        ['tests/renderer/app.test.tsx', '独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数'],
      ],
    },
    '二维码申请模块表单多选类型': {
      evidence: [
        ['tests/renderer/app.test.tsx', '独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数'],
      ],
    },
    '项目总览展示关键事实': {
      evidence: [
        ['tests/renderer/app.test.tsx', '详情默认打开搬迁仪器并按需切换 section，不再显示项目总览 tab'],
      ],
    },
    '费用与掉票 tab 展示金额与掉票记录': {
      evidence: [
        ['tests/renderer/app.test.tsx', '费用与掉票在列表前展示金额事实，并显示掉票最后修改时间'],
      ],
    },
    '吞吐板块不复制项目看板': {
      evidence: [
        ['tests/renderer/app.test.tsx', '任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色'],
      ],
    },
    '当前上下文不挤占主队列': {
      evidence: [
        ['tests/interface/layout.test.ts', '纵向主流程依次显示提醒、单一项目工作区与项目队列'],
      ],
    },
    '维护全局标签库': {
      evidence: [
        ['tests/renderer/app.test.tsx', '最新布局：顶部主导航直接显示标签库并打开全局标签库'],
      ],
    },
    '按组多选并展示项目分类标签': {
      evidence: [
        ['tests/renderer/app.test.tsx', '新建项目按组键盘可达地同组与跨组多选，并提交全局自定义 tagIds'],
        ['tests/renderer/app.test.tsx', '详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口'],
      ],
    },
    '交换后的区域位置保持内容与联动': {
      evidence: [
        ['tests/renderer/app.test.tsx', '最新布局：提醒、项目工作区与项目队列依次显示，队列选择共享工作区状态'],
      ],
    },
    '项目工作区不重复组件或状态': {
      evidence: [
        ['tests/interface/layout.test.ts', '纵向主流程依次显示提醒、单一项目工作区与项目队列'],
      ],
    },
    '1440px 与 1024px 下布局可用': {
      evidence: [
        ['e2e/workbench-v2-layout.spec.ts', '最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切'],
      ],
    },
    '1024px 宽下核心区域可操作': {
      evidence: [
        ['tests/interface/layout.test.ts', '1024 附近不产生页面级横向溢出，宽表格在容器内滚动'],
      ],
    },
    '无页面级横向溢出': {
      evidence: [
        ['tests/interface/layout.test.ts', '1024 附近不产生页面级横向溢出，宽表格在容器内滚动'],
      ],
    },
    '1440px 为主布局基准': {
      evidence: [
        ['e2e/workbench-v2-layout.spec.ts', '最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切'],
      ],
    },
    '1190px 与 1170px 中间宽度保持可用': {
      evidence: [
        ['e2e/workbench-v2-layout.spec.ts', '最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切'],
      ],
    },
    '接近最小宽度不丢失主操作流': {
      evidence: [
        ['tests/interface/layout.test.ts', '1024 附近不产生页面级横向溢出，宽表格在容器内滚动'],
      ],
    },
    '遵循行为、结构与视觉意图': {
      abstract: true,
      evidence: [['tests/interface/README.md', '已复核选定原型的任务顺序']],
      note: '原型意图验收记录见 tests/interface/README.md',
    },
    '高保真原型仅作设计依据、生产实现重写': {
      abstract: true,
      evidence: [['tests/interface/README.md', '生产实现保留专业、克制、高密度运营语言']],
      note: '原型意图验收记录见 tests/interface/README.md',
    },
    '不复制原型技术代码': {
      abstract: true,
      evidence: [['tests/interface/README.md', '未复制原型 HTML、CSS 或 JavaScript']],
      note: '原型意图验收记录见 tests/interface/README.md',
    },
  },

  // ─────────────────────────── history-import-wizard ─────────────────────
  // 历史数据导入向导（tasks 8.47~8.66 + CLI 移除）。外部迁移 CLI 已删除，
  // 向导（import-wizard:* 通道 + 会话/受信窗口守卫）是唯一入口。
  'history-import-wizard': {
    "负责人从数据管理进入": {
      evidence: [
        ["tests/renderer/app.test.tsx", "历史导入返回后刷新 overview 与项目首页并恢复入口焦点"],
      ],
      note: "app 级测试：数据管理提供历史数据导入入口并以全窗口 route 打开",
    },
    "非受信窗口不能进入": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "未登录时导入向导全部 invoke 通道拒绝"],
      ],
      note: "非受信窗口/非受信 sender 不能进入导入向导",
    },
    "非受信窗口不能调用导入能力": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "非受信 sender 拒绝"],
      ],
      note: "非受信 sender 拒绝导入调用",
    },
    "用户不再看到 CLI 路径": {
      evidence: [
        ["tests/integration/historical-data-import.sqlite.test.ts", "外部迁移 CLI 已删除"],
      ],
      note: "外部迁移 CLI 与构建脚本已删除，向导为唯一入口",
    },
    "首次进入显示完整步骤": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "展示固定七步"],
      ],
      note: "全窗口七步导航",
    },
    "返回工作台保留导航上下文": {
      evidence: [
        ["tests/renderer/app.test.tsx", "历史导入返回后刷新 overview 与项目首页并恢复入口焦点"],
        ["tests/renderer/history-import-wizard.test.tsx", "展示固定七步、账号、保存状态、问题状态与返回确认焦点"],
      ],
      note: "返回数据管理后恢复原工作台上下文与焦点",
    },
    "步骤状态反映当前校验结果": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "展示固定七步、账号、保存状态、问题状态与返回确认焦点"],
      ],
      note: "步骤状态按校验结果显示已阻断/通过/处理中",
    },
    "项目与合同有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "七类步骤均可声明有数据（data）并展示专属字段",
    },
    "项目与合同无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "七类步骤均可声明本次无数据（none）",
    },
    "开单记录有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：开单记录有数据",
    },
    "开单记录无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：开单记录无数据",
    },
    "掉票记录有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：掉票记录有数据",
    },
    "掉票记录无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：掉票记录无数据",
    },
    "物流费用有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：物流费用有数据",
    },
    "物流费用无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：物流费用无数据",
    },
    "序列号地址更新有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：序列号地址更新有数据",
    },
    "序列号地址更新无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：序列号地址更新无数据",
    },
    "二维码申请有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：二维码申请有数据",
    },
    "二维码申请无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：二维码申请无数据",
    },
    "Ship-to 申请有数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：Ship-to 申请有数据",
    },
    "Ship-to 申请无数据": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "六个业务步骤提供七类专属字段、data/none 和 VirtualImportGrid"],
      ],
      note: "同 data/none 声明：Ship-to 申请无数据",
    },
    "下载当前版本空白模板": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "覆盖模板、文件/sheet、50k 进度取消和共用列映射"],
        ["tests/domain/import-template.test.ts", "生成单个工作簿：填写说明 + 七个业务 sheet"],
      ],
      note: "向导提供模板下载；模板生成器产出填写说明 + 七类业务 sheet",
    },
    "选择受支持的模板版本": {
      evidence: [
        ["tests/domain/import-template.test.ts", "模板版本可识别且为受支持版本"],
      ],
      note: "当前版本模板识别为受支持",
    },
    "旧版本模板不能静默套用新规则": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "旧版本模板识别为不支持"],
      ],
      note: "旧版本模板报告版本问题而非静默套用新规则",
    },
    "选择包含七类数据的工作簿": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "模板工作簿按 sheet 精确路由七类"],
        ["tests/main/import-wizard-ipc.test.ts", "返回完整工作区 DTO"],
      ],
      note: "工作簿按 sheet 路由七类并反映到工作区 DTO",
    },
    "合并多个 Excel 文件": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "两个文件合并"],
      ],
      note: "多文件追加写入不丢失，重跑顺序无关",
    },
    "未知工作表需要人工决定": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "未知 sheet 进入 UNKNOWN_SHEET 问题"],
      ],
      note: "未知 sheet 待人工映射或排除，不猜测",
    },
    "粘贴不含表头的矩形区域": {
      evidence: [
        ["tests/domain/import-paste-parser.test.ts", "不是表头时全部行作为数据行"],
      ],
      note: "未确认表头时全部行作为数据行",
    },
    "粘贴区域可能包含表头": {
      evidence: [
        ["tests/domain/import-paste-parser.test.ts", "首行表头确认：是表头时首行作为表头"],
      ],
      note: "确认表头后首行作为表头、其余为数据行",
    },
    "粘贴将覆盖已有值": {
      evidence: [
        ["tests/domain/import-paste-parser.test.ts", "覆盖预检：触碰既有行范围时给出 wouldOverwrite"],
        ["tests/domain/import-tasks.test.ts", "覆盖预检不通过时抛 PasteOverlayError"],
      ],
      note: "覆盖模式预检触碰既有行给出 wouldOverwrite，超界拒绝不写入",
    },
    "文件列按已知字段匹配": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "模板工作簿按 sheet 精确路由七类"],
        ["tests/domain/historical-data-import.test.ts", "客户名称列别名"],
      ],
      note: "已知字段按精确/别名匹配",
    },
    "未识别列由用户映射": {
      evidence: [
        ["tests/domain/import-tasks.test.ts", "未知列进入 UNKNOWN_COLUMN 问题"],
      ],
      note: "未识别列待人工映射或排除",
    },
    "文件与粘贴数据在同一网格合并": {
      evidence: [
        ["tests/workspace/import-tasks-workspace.test.ts", "同一草稿先文件后粘贴"],
      ],
      note: "同一草稿文件+粘贴两类来源在同一类别网格共存，来源定位可区分",
    },
    "多个来源映射到同一目标字段": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "不同来源相同规范化值不产生冲突"],
      ],
      note: "多来源映射到同一目标字段，相同规范化值不冲突",
    },
    "同一 ECC 聚合项目与合同来源": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "同一 ECC 聚合为一个搬迁项目"],
      ],
      note: "项目与合同来源按 ECC 聚合为一个搬迁项目",
    },
    "掉票和物流费用引用有效 ECC": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "物流费用 ECC 可引用计划或目标库"],
      ],
      note: "掉票/物流费用引用计划或目标库中唯一匹配的 ECC",
    },
    "必须关联的记录找不到 ECC": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "掉票 ECC 未在计划或目标库中唯一匹配"],
      ],
      note: "找不到唯一匹配 ECC → 阻断错误",
    },
    "独立申请不被强制关联 ECC": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "不强制关联 ECC"],
      ],
      note: "QR/Ship-to 独立申请不强制关联 ECC",
    },
    "在网格中修正错误单元格": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "patch 局部校验"],
      ],
      note: "稀疏 cell patch 修正网格错误并触发局部重校验",
    },
    "撤销网格修改": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "undo 整体撤销、redo 整体重做"],
      ],
      note: "磁盘 checkpoint 支持整体 undo/redo",
    },
    "删除草稿行不删除业务数据": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "checkpoint/undo/redo 阶段正式业务库零写"],
        ["tests/workspace/workspace-repository.test.ts", "删除行级联清理其单元格与问题"],
      ],
      note: "删除草稿行只清工作区，正式业务库零写",
    },
    "从问题面板定位错误单元格": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "四层问题反馈、定位和冲突候选处理"],
      ],
      note: "问题面板定位并聚焦目标网格单元格",
    },
    "定位时解除阻挡视图的筛选": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "搜索、ECC/问题筛选和错误接口驱动 provider 并聚焦目标单元格"],
      ],
      note: "跳错误后按全部问题+空搜索重新读取窗口（不被既有筛选阻挡）",
    },
    "冲突要求明确决定": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "冲突候选处理"],
      ],
      note: "冲突必须选择候选或修正",
    },
    "警告不阻断提交资格": {
      evidence: [
        ["tests/domain/import-validation.test.ts", "成交价格高于预算价格仅警告"],
        ["tests/renderer/history-import-wizard.test.tsx", "warning 确认后只提交一次"],
      ],
      note: "warning 不阻断提交资格，确认后可提交",
    },
    "编辑后自动保存草稿": {
      evidence: [
        ["tests/workspace/workspace-repository.test.ts", "每次自动保存返回递增修订号"],
      ],
      note: "每次保存推进修订号与 lastSavedAt",
    },
    "退出后继续上次导入": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "支持新建、继续、摘要和删除草稿"],
      ],
      note: "首页支持继续上次草稿",
    },
    "删除草稿不影响业务数据": {
      evidence: [
        ["tests/workspace/workspace-cleanup.test.ts", "用户删除草稿"],
      ],
      note: "删除草稿连同摘要整体清除，不触碰正式业务记录",
    },
    "草稿保存失败时阻止误退出": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "保存失败时保留全窗口草稿并阻止误退出"],
      ],
      note: "保存失败保留草稿并阻止误退出",
    },
    "编辑过程中会话失效": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "会话失效停止操作"],
      ],
      note: "编辑中会话失效停止操作并保留草稿",
    },
    "会话恢复后继续草稿": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "重新登录后须重新完整校验"],
      ],
      note: "会话恢复后草稿保留、seal 已失效须重新完整校验",
    },
    "摘要展示七类导入范围": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "有效摘要要求范围"],
        ["tests/main/import-wizard-ipc.test.ts", "返回完整工作区 DTO"],
      ],
      note: "最终摘要展示七类导入范围与 seal 状态",
    },
    "存在阻断问题时不能确认": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "seal 失效禁用"],
      ],
      note: "seal 失效/存在阻断时禁用最终确认",
    },
    "用户修改数据后摘要失效": {
      evidence: [
        ["tests/domain/import-seal.test.ts", "草稿单元格修改 → seal 立即失效"],
      ],
      note: "用户修改数据使 seal/摘要失效",
    },
    "用户明确确认后发起最终提交": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "warning 确认后只提交一次并展示结果"],
      ],
      note: "明确确认后只发起一次最终提交",
    },
    "最终提交失败回到可处理状态": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "提交中断后明确区分完整成功与完整回滚"],
      ],
      note: "提交失败回到需重新校验的可处理状态",
    },
    "连续触发确认导入": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "重复提交（同一草稿二次 submit）被拒绝"],
      ],
      note: "重复 submit 被拒绝不二次写入",
    },
    "提交期间不能继续修改草稿": {
      evidence: [
        ["tests/main/import-wizard-ipc.test.ts", "提交不可取消"],
      ],
      note: "提交（committing）期间不可取消且禁止修改",
    },
    "中断后先核对再重试": {
      evidence: [
        ["tests/domain/import-commit.test.ts", "无成功审计 → 完整回滚并要求重新完整校验"],
        ["tests/domain/import-commit.test.ts", "成功审计与完整事务同时存在"],
      ],
      note: "提交中断后先核对成功审计再判定，禁止自动重提",
    },
    "读取五万行文件时显示进度": {
      evidence: [
        ["tests/performance/import-50k-benchmark.test.ts", "50k 文件 worker：首个 progress 立即到达"],
      ],
      note: "50k 文件 worker 持续报告阶段与行数",
    },
    "取消五万行文件处理": {
      evidence: [
        ["tests/performance/import-50k-benchmark.test.ts", "50k 文件 worker 中途取消"],
      ],
      note: "50k 文件处理可取消，回滚到最后稳定修订",
    },
    "取消完整校验": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "取消完整校验"],
      ],
      note: "validating 操作可取消并回到保存状态",
    },
    "打开十万行目标网格": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "100k 数据只通过 window provider 读取可见窗口"],
      ],
      note: "10 万行网格只渲染可见窗口、DOM 有界",
    },
    "在十万行中搜索和定位错误": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "搜索、ECC/问题筛选和错误接口驱动 provider"],
      ],
      note: "10 万行中搜索、ECC/问题筛选与定位错误",
    },
    "大表横向浏览保持记录身份可辨": {
      evidence: [
        ["tests/performance/history-import-grid-benchmark.test.tsx", "横向冻结身份"],
      ],
      note: "横向滚动保持行号/ECC 冻结可辨",
    },
    "仅使用键盘修正并定位错误": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "方向键、Tab/Shift+Tab、Enter/Escape 可预测"],
      ],
      note: "方向键/Tab/Enter 键盘导航与编辑",
    },
    "键盘粘贴矩形区域": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "矩形选择与 Excel TSV 粘贴"],
      ],
      note: "Ctrl+V 粘贴矩形区域批量 patch",
    },
    "Escape 只取消当前编辑": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "Enter/Escape 可预测"],
      ],
      note: "Escape 只取消当前编辑不误提交",
    },
    "不依赖颜色识别问题类型": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "错误与警告以文字和图标表达"],
      ],
      note: "错误/警告以文字和图标表达，不依赖颜色",
    },
    "对话内容关闭后恢复焦点": {
      evidence: [
        ["tests/renderer/history-import-wizard.test.tsx", "返回确认焦点"],
      ],
      note: "对话关闭后焦点恢复到触发元素",
    },
    "异步状态可被感知且不抢夺焦点": {
      evidence: [
        ["tests/renderer/history-import-virtual-grid.test.tsx", "编辑覆盖层在虚拟行卸载后仍保留焦点"],
      ],
      note: "异步状态可感知（announcer），滚动/卸载不抢夺焦点",
    },
  },
};
