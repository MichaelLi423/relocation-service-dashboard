import type { OrderType } from '../service-order-recording';

/**
 * operational-reporting 能力（运营报表）——指标口径字典与筛选（design D10 / tasks 7.1）。
 *
 * 本模块唯一拥有统计公式（spec：运营报表），从各模块事实经只读事实源实时计算、
 * 不维护业务状态、不保存历史快照；报表月份区间由负责人手工选择（无默认季度，TBD-17）。
 *
 * 指标字典给出每项指标的：中文口径说明、时间归属字段、事实来源映射与可用筛选，
 * 作为 7.1「指标字典与来源映射」测试基线。
 */

/** 报表指标键（口径字典）。 */
export const REPORT_METRIC_KEYS = [
  'project_pipeline', // 项目管道（当前状态快照，已取消/已转单排除）
  'entry_amount_by_region', // 各区域新项目进单金额（进单金额快照）
  'monthly_invoice_amount', // 月度掉票金额
  'monthly_invoice_count', // 月度掉票次数
  'monthly_service_order_count', // 月度开单量（唯一服务单号）
  'damage_repair_stats', // 损坏维修统计（仅已使用备件）
  'monthly_logistics', // 月度物流费用汇总（人民币）
  'logistics_contract_ratio', // 物流成交价合同占比
  'pending_logistics_list', // 历史异常批次（已有物流成交价但无费用记录，仅展示）
  'ship_to_request_workload', // Ship-to 申请工作量（首次实际提交）
  'qr_request_workload', // 二维码申请工作量（去重类型）
  'serial_address_update_count', // 序列号地址更新记录数
] as const;
export type ReportMetricKey = (typeof REPORT_METRIC_KEYS)[number];

/** 报表筛选字段。 */
export const REPORT_FILTER_FIELDS = [
  'monthFrom', // 月份区间起始（yyyy-mm，必填，无默认季度）
  'monthTo', // 月份区间截止（yyyy-mm，必填，无默认季度）
  'region', // 区域（去除首尾空白后精确匹配）
  'orderType', // 开单业务类型（搬迁/认证/单寄备件/PM）
  'transportCompany', // 运输公司
  'engineer', // 参与工程师（开单量可选筛选）
  'operator', // 责任人（按动作记录持久化的用户名快照筛选，工作量指标可选筛选）
  'tagIds', // 项目分类标签（多选 OR；启用时仅匹配关联项目事实）
] as const;
export type ReportFilterField = (typeof REPORT_FILTER_FIELDS)[number];

/** 报表筛选条件：月份区间必填；其余可选（null = 不筛选）。 */
export interface ReportFilter {
  /** 月份区间起始（yyyy-mm）。 */
  monthFrom: string;
  /** 月份区间截止（yyyy-mm）。 */
  monthTo: string;
  /** 区域（trim 后精确匹配；null = 全部区域）。 */
  region?: string | null;
  /** 开单业务类型（null = 全部类型）。 */
  orderType?: OrderType | null;
  /** 运输公司（null = 全部运输公司）。 */
  transportCompany?: string | null;
  /** 参与工程师（null = 全部工程师；仅开单量筛选）。 */
  engineer?: string | null;
  /** 责任人（按动作记录持久化的用户名快照 trim 后精确匹配；null = 全部责任人；仅工作量指标）。 */
  operator?: string | null;
  /** 项目分类标签多选：undefined/空数组不限制；非空按任一标签 OR 匹配。 */
  tagIds?: readonly string[];
}

/** 指标口径字典条目。 */
export interface ReportMetricDefinition {
  key: ReportMetricKey;
  /** 中文口径说明。 */
  label: string;
  /** 时间归属口径。 */
  timeAttribution: string;
  /** 事实来源映射。 */
  factSource: string;
  /** 可应用的筛选。 */
  filters: ReportFilterField[];
  /** 是否支持下钻明细（明细口径与指标口径一致）。 */
  hasDrillDown: boolean;
}

/** 指标口径字典（7.1 测试基线；统计公式由 operational-reporting 唯一拥有）。 */
export const REPORT_METRIC_DEFINITIONS: readonly ReportMetricDefinition[] = [
  {
    key: 'project_pipeline',
    label: '项目管道',
    timeAttribution: '当前状态快照（不按月归属；已取消项目排除）',
    factSource: 'relocation-project-lifecycle 项目主状态（消费校验结果，不维护状态）',
    filters: ['region', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'entry_amount_by_region',
    label: '各区域新项目进单金额',
    timeAttribution: '正式进单时保存的合同 USD 含税金额快照，按已记录进单时间所属月份归属',
    factSource: 'contracts.entry_amount_snapshot_cents（正式进单锁定）+ projects.entry_at / region',
    filters: ['monthFrom', 'monthTo', 'region', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'monthly_invoice_amount',
    label: '月度掉票金额',
    timeAttribution: '掉票时间（invoiced_at）所属月份；已撤销不计',
    factSource: 'invoices（有效记录，revoked_at IS NULL）',
    filters: ['monthFrom', 'monthTo', 'region', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'monthly_invoice_count',
    label: '月度掉票次数',
    timeAttribution: '掉票时间（invoiced_at）所属月份；已撤销不计',
    factSource: 'invoices（有效记录计数）',
    filters: ['monthFrom', 'monthTo', 'region', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'monthly_service_order_count',
    label: '月度开单量',
    timeAttribution: '开单时间（ordered_at，未填默认当前时间）所属月份',
    factSource: 'service_orders（按唯一非空服务单号计一次，四类业务分组）',
    filters: ['monthFrom', 'monthTo', 'region', 'orderType', 'engineer', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'damage_repair_stats',
    label: '损坏维修统计',
    timeAttribution: '事项登记时间（registered_at）所属月份',
    factSource: 'damage_repair_items（记录数量；仅已使用备件折算 USD 金额；最新合同 USD 含税金额占比；按登记时持久化的账号内部 ID 与用户名快照归属责任人）',
    filters: ['monthFrom', 'monthTo', 'region', 'operator', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'monthly_logistics',
    label: '月度物流费用汇总',
    timeAttribution: '实际物流费用申请（登记）时间（applied_at）所属月份',
    factSource: 'logistics_fees（合同预算价/物流成交价；实际费用旧列与物流成交价同值，仅历史兼容）按 batches.transport_company 分组',
    filters: ['monthFrom', 'monthTo', 'region', 'transportCompany', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'logistics_contract_ratio',
    label: '物流成交价合同占比',
    timeAttribution: '实际物流费用申请（登记）时间所属月份',
    factSource: 'logistics_fees 物流成交价（即最终实际费用）÷ 固定汇率 7.2 折算 USD ÷ 最新合同 USD 含税金额',
    filters: ['monthFrom', 'monthTo', 'region', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'pending_logistics_list',
    label: '历史异常批次',
    timeAttribution: '不按月归属（当前清单）；已取消项目排除',
    factSource: 'batches（已有物流成交价 discounted_price_cents 且无 logistics_fees 记录；历史数据形态，仅展示不提供补录指引）',
    filters: ['region', 'transportCompany', 'tagIds'],
    hasDrillDown: false,
  },
  {
    key: 'ship_to_request_workload',
    label: 'Account ID 申请工作量',
    timeAttribution: '首次实际提交时间（submitted_at）所属月份；待提交草稿不计、状态更新不重复计数',
    factSource: 'ship_to_requests（首次提交记录；按提交时持久化的账号内部 ID 与用户名快照归属责任人）',
    filters: ['monthFrom', 'monthTo', 'operator', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'qr_request_workload',
    label: '二维码申请工作量',
    timeAttribution: '申请时间（requested_at）所属月份',
    factSource: 'qr_requests × 去重后选中类型（不按仪器/项目计数；按申请时持久化的账号内部 ID 与用户名快照归属责任人）',
    filters: ['monthFrom', 'monthTo', 'operator', 'tagIds'],
    hasDrillDown: true,
  },
  {
    key: 'serial_address_update_count',
    label: '序列号地址更新记录数',
    timeAttribution: '更新时间（updated_at）所属月份',
    factSource: 'serial_address_updates（逐条记录计数，可按客户分组；按登记时持久化的账号内部 ID 与用户名快照归属责任人）',
    filters: ['monthFrom', 'monthTo', 'operator', 'tagIds'],
    hasDrillDown: true,
  },
];

/** 指标口径字典：按键索引。 */
export const REPORT_METRIC_BY_KEY: ReadonlyMap<ReportMetricKey, ReportMetricDefinition> = new Map(
  REPORT_METRIC_DEFINITIONS.map((d) => [d.key, d]),
);
