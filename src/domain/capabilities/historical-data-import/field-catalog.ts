import type { ImportCategory } from './workspace/workspace-model';

/**
 * 七类固定目标字段目录（tasks 8.17）。
 *
 * 为模板、文件与粘贴三种输入共用同一套目标字段定义（design D21）：
 * - 字段名（目标模型字段，如 contract.ecc / invoice.amount_cents）；
 * - 类型（text / date / datetime / money / number）；
 * - 必填/可选（目标必填缺失为阻断错误，可选允许为空）；
 * - 业务键（ECC、服务单号、Account ID、序列号；用于子记录识别与稳定源行身份）；
 * - 稳定别名（冻结；模板表头 + 旧五份来源工作簿列名共用，不做相似名称模糊匹配）；
 * - 金额币种（money 字段：USD / RMB）；
 * - 日期语义（统一 date：目标业务时间一律按业务日期 yyyy-mm-dd 处理，接受
 *   Excel serial / 纯日期 / 显式偏移 ISO / 无偏移本地 datetime；审计时间仍精确，
 *   见 design D30）；
 * - 是否允许用户编辑（工作台网格修正范围；主状态等只读字段不进入目录）。
 *
 * 主状态（project.status）由导入事实确定性重建（8.6），不提供可直接指定的
 * 目标字段，故不出现在目录中。二维码申请仅在有明确申请类型时产生有效记录，
 * 类型数量（qr_request.type_count）不用于猜测申请类型（spec「二维码类型不得由数量猜测」）。
 */

export const FIELD_CATALOG_VERSION = 1;

export type TargetFieldType = 'text' | 'date' | 'datetime' | 'money' | 'number';
export type TargetFieldCurrency = 'USD' | 'RMB';

export interface TargetFieldDef {
  /** 目标模型字段（稳定键，如 contract.ecc）。 */
  field: string;
  /** 模板表头（中文标签，唯一）。 */
  label: string;
  category: ImportCategory;
  type: TargetFieldType;
  /** 目标必填（迁移校验阶段：缺失为阻断错误；本目录只声明，不执行校验）。 */
  required: boolean;
  /** 业务键：用于子记录识别、聚合与稳定源行身份。 */
  businessKey: boolean;
  /** 稳定别名（冻结；模板/粘贴/旧五源共用，精确匹配，不模糊猜测）。 */
  aliases: readonly string[];
  /** 金额币种（type=money 时必填）。 */
  currency?: TargetFieldCurrency;
  /** 日期语义（业务时间字段统一 'date'，输出 yyyy-mm-dd；'datetime' 保留给审计等精确时间）。 */
  dateSemantics?: 'date' | 'datetime';
  /** 是否允许用户在工作台网格中编辑该字段。 */
  editable: boolean;
  /** 帮助文本（模板填写说明 / 网格字段帮助）。 */
  help?: string;
}

/** 七类业务 sheet 在模板中的表头顺序（与字段目录一致；source_row_id 由模板前置）。 */
export const CATEGORY_FIELDS: Record<ImportCategory, readonly TargetFieldDef[]> = {
  project: [
    {
      field: 'contract.ecc',
      label: 'ECC',
      category: 'project',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: ['ECC#', 'ECC'],
      editable: true,
      help: '项目/合同聚合主键，正式进单后的全局唯一业务编号；按文本保留前导零',
    },
    {
      field: 'contract.customer_name',
      label: '客户名称',
      category: 'project',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: ['Account name', 'Account Name', '客户单位名称'],
      editable: true,
      help: '客户唯一业务标识（去除首尾空白后全局唯一）',
    },
    {
      field: 'contract.usd_tax_amount_cents',
      label: '合同USD含税金额',
      category: 'project',
      type: 'money',
      required: false,
      businessKey: false,
      aliases: ['合同金额USD'],
      currency: 'USD',
      editable: true,
      help: '仅合同 USD 含税金额允许为 0；十进制字符串精确转为分整数',
    },
    {
      field: 'project.region',
      label: '区域',
      category: 'project',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: [],
      editable: true,
    },
    {
      field: 'project.entry_at',
      label: '进单时间',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
      help: '源业务时间保存到业务字段；导入时间只用于审计，不替代源时间',
    },
    {
      field: 'project.contract_start_date',
      label: '合同开始日期',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'project.contract_end_date',
      label: '合同截止日期',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
      help: '不得早于合同开始日期（校验阶段）',
    },
    {
      field: 'project.actual_install_done_at',
      label: '实际装机完成时间',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'project.acceptance_report_date',
      label: '验收报告形成日期',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'project.cancelled_at',
      label: '取消时间',
      category: 'project',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'instrument.name',
      label: '仪器名称',
      category: 'project',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: [],
      editable: true,
      help: '搬迁仪器登记时必填；当该行为仪器行时必填',
    },
    {
      field: 'instrument.serial_no',
      label: '序列号',
      category: 'project',
      type: 'text',
      required: false,
      businessKey: true,
      aliases: [],
      editable: true,
      help: '非空序列号在合同/项目内唯一；按文本保留前导零',
    },
  ],
  service_order: [
    {
      field: 'service_order.service_order_no',
      label: '服务单号',
      category: 'service_order',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: ['单号'],
      editable: true,
      help: '非空服务单号全局唯一（四类业务共用唯一空间）；按文本保留前导零',
    },
    {
      field: 'service_order.order_type',
      label: '开单类型',
      category: 'service_order',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: ['类型'],
      editable: true,
      help: '搬迁 / 认证 / 单寄备件 / PM',
    },
    {
      field: 'service_order.ordered_at',
      label: '开单时间',
      category: 'service_order',
      type: 'date',
      required: true,
      businessKey: false,
      aliases: ['日期'],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'service_order.engineer',
      label: '工程师',
      category: 'service_order',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: [],
      editable: true,
      help: '可空，允许后续补录；缺失或空白统一归一为 null',
    },
    {
      field: 'service_order.customer_name',
      label: '客户单位',
      category: 'service_order',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: ['客户名称', '客户单位名称'],
      editable: true,
    },
    {
      field: 'service_order.note',
      label: '备注',
      category: 'service_order',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: [],
      editable: true,
    },
  ],
  invoice: [
    {
      field: 'invoice.ecc',
      label: 'ECC',
      category: 'invoice',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: ['ECC#'],
      editable: true,
      help: '必须引用本次计划或目标库中唯一匹配的 ECC',
    },
    {
      field: 'invoice.amount_cents',
      label: '掉票金额',
      category: 'invoice',
      type: 'money',
      required: true,
      businessKey: false,
      aliases: ['金额', '金额（USD）'],
      currency: 'USD',
      editable: true,
      help: '有值必须大于 0；USD 口径',
    },
    {
      field: 'invoice.invoiced_at',
      label: '掉票时间',
      category: 'invoice',
      type: 'date',
      required: true,
      businessKey: false,
      aliases: [],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'invoice.region',
      label: '区域',
      category: 'invoice',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: [],
      editable: true,
    },
    {
      field: 'invoice.customer_name',
      label: '客户名称',
      category: 'invoice',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: ['客户单位'],
      editable: true,
    },
  ],
  logistics_fee: [
    {
      field: 'logistics_fee.ecc',
      label: 'ECC',
      category: 'logistics_fee',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: ['ECC#'],
      editable: true,
      help: '必须引用本次计划或目标库中唯一匹配的 ECC',
    },
    {
      field: 'logistics_fee.applied_at',
      label: '物流费用申请（登记）时间',
      category: 'logistics_fee',
      type: 'date',
      required: true,
      businessKey: false,
      aliases: ['申请时间', '登记时间', '物流费用申请时间', '物流费用申请登记时间'],
      dateSemantics: 'date',
      editable: true,
      help: '目标必填；只登记月份无法推断具体日期',
    },
    {
      field: 'logistics_fee.budget_price_cents',
      label: '预算价格',
      category: 'logistics_fee',
      type: 'money',
      required: true,
      businessKey: false,
      aliases: [],
      currency: 'RMB',
      editable: true,
      help: '执行前确认的预计物流成本；人民币；有值必须大于 0',
    },
    {
      field: 'logistics_fee.deal_price_cents',
      label: '成交价格',
      category: 'logistics_fee',
      type: 'money',
      required: true,
      businessKey: false,
      aliases: [],
      currency: 'RMB',
      editable: true,
      help: '批次实际执行的物流成交价格；人民币；大于预算时仅警告、允许记录',
    },
    {
      field: 'logistics_fee.logistics_cost_cents',
      label: '实际物流费用',
      category: 'logistics_fee',
      type: 'money',
      required: true,
      businessKey: false,
      aliases: ['金额'],
      currency: 'RMB',
      editable: true,
      help: '批次实际发生的物流费用；人民币；有值必须大于 0',
    },
    {
      field: 'logistics_fee.transport_company',
      label: '物流公司',
      category: 'logistics_fee',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: ['运输公司', '承运商'],
      editable: true,
      help: '供应商来源仅作运输公司参考，不构成独立第八类记录',
    },
  ],
  serial_address_update: [
    {
      field: 'serial_address_update.customer_name',
      label: '客户名称',
      category: 'serial_address_update',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: ['单位名称', '客户单位'],
      editable: true,
    },
    {
      field: 'serial_address_update.new_site_address',
      label: '新址地址',
      category: 'serial_address_update',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: [],
      editable: true,
    },
    {
      field: 'serial_address_update.serial_no',
      label: '序列号',
      category: 'serial_address_update',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: [],
      editable: true,
      help: '须与登记的搬迁仪器一致；按文本保留前导零',
    },
    {
      field: 'serial_address_update.account_id',
      label: 'Account ID',
      category: 'serial_address_update',
      type: 'text',
      required: true,
      businessKey: true,
      aliases: ['AccountID', 'account id'],
      editable: true,
      help: '逐台记录实际关联的 Ship-to；不创建或修改不可变 Ship-to 主数据',
    },
    {
      field: 'serial_address_update.updated_at',
      label: '更新时间',
      category: 'serial_address_update',
      type: 'date',
      required: true,
      businessKey: false,
      aliases: ['更新日期'],
      dateSemantics: 'date',
      editable: true,
    },
  ],
  qr_request: [
    {
      field: 'qr_request.applicant',
      label: '申请人',
      category: 'qr_request',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: [],
      editable: true,
    },
    {
      field: 'qr_request.requested_at',
      label: '申请时间',
      category: 'qr_request',
      type: 'date',
      required: true,
      businessKey: false,
      aliases: ['日期'],
      dateSemantics: 'date',
      editable: true,
    },
    {
      field: 'qr_request.type_code',
      label: '申请类型',
      category: 'qr_request',
      type: 'text',
      required: false,
      businessKey: false,
      aliases: ['类型', '具体类型'],
      editable: true,
      help: '仅在有明确申请类型时产生有效记录；不得由类型数量猜测',
    },
    {
      field: 'qr_request.type_count',
      label: '类型数量',
      category: 'qr_request',
      type: 'number',
      required: false,
      businessKey: false,
      aliases: [],
      editable: true,
      help: '不用于推断或重复生成申请类型',
    },
  ],
  ship_to_request: [
    {
      field: 'ship_to_request.customer_name',
      label: '客户名称',
      category: 'ship_to_request',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: ['客户单位名称', '单位名称'],
      editable: true,
    },
    {
      field: 'ship_to_request.new_site_address',
      label: '新址地址',
      category: 'ship_to_request',
      type: 'text',
      required: true,
      businessKey: false,
      aliases: [],
      editable: true,
    },
    {
      field: 'ship_to_request.account_id',
      label: 'Account ID',
      category: 'ship_to_request',
      type: 'text',
      required: false,
      businessKey: true,
      aliases: ['AccountID', 'account id'],
      editable: true,
      help: '独立申请记录，不因缺少 ECC 被强制关联项目',
    },
    {
      field: 'ship_to_request.requested_at',
      label: '日期',
      category: 'ship_to_request',
      type: 'date',
      required: false,
      businessKey: false,
      aliases: ['申请时间', '提交时间'],
      dateSemantics: 'date',
      editable: true,
    },
  ],
};

export function fieldCatalogFor(category: ImportCategory): readonly TargetFieldDef[] {
  return CATEGORY_FIELDS[category];
}

/**
 * 精确查找：按 字段名（field）或 模板表头（label）查找，不做相似名称模糊匹配。
 */
export function findFieldByTarget(category: ImportCategory, fieldOrLabel: string): TargetFieldDef | undefined {
  return CATEGORY_FIELDS[category].find((f) => f.field === fieldOrLabel || f.label === fieldOrLabel);
}

/** 稳定别名匹配（含 label 本身）：模板表头、粘贴表头与旧五源列名共用。 */
export function findFieldByHeader(category: ImportCategory, header: string): TargetFieldDef | undefined {
  const key = header.trim();
  if (key === '') return undefined;
  return CATEGORY_FIELDS[category].find(
    (f) =>
      f.label === key ||
      f.field === key ||
      f.aliases.some((a) => a === key),
  );
}

/** 业务键字段集合（ECC / 服务单号 / Account ID / 序列号）。 */
export function businessKeyFieldsOf(category: ImportCategory): readonly TargetFieldDef[] {
  return CATEGORY_FIELDS[category].filter((f) => f.businessKey);
}
