import { parseDecimalToCents } from '../../core/money';
import { createHash } from 'node:crypto';
import type { ProjectStatusOrCancelled } from '../relocation-project-lifecycle/states';
import { resolveStatus, type TransitionResult } from '../relocation-project-lifecycle/lifecycle';
import { normalizeDateValue } from './excel-date';
import {
  MAPPING_V1,
  fileRouteByFileName,
  sheetRouteOf,
  sourceFileBasename,
  type MigrationMapping,
  type SheetRole,
} from './mapping';
import {
  cellValue,
  collectMappedValues,
  idempotencyKey,
  mappedValue,
  sourceRowKey,
  type SourceRow,
} from './source-model';

/**
 * 迁移引擎（tasks 8.1~8.10 领域规则）。
 *
 * 数据流：源 Excel（readExcelFile）→ SourceRow → 按「文件 basename + sheet 名」
 * 路由（8.3/8.2）→ 必填校验（8.4）→ 冲突检测（8.5）→ dry-run（8.6，只读
 * 零写入）→ 批次事务导入（8.7）→ 确定性状态重建（8.8）→ 源业务时间保留（8.9）。
 *
 * 路由规则：
 * - 合同信息表 → project（ECC# 别名）；
 * - 项目执行表仅「搬迁项目」sheet → project；「工作表1」「MRS Node」等辅助 sheet
 *   → ignored 并带原因（不产生 error/conflict）；
 * - 工作量统计表按 sheet 分别解析：开单 → service_order、掉票 → invoice（ECC）、
 *   物流费用 → logistics_fee、地址更新 → serial_address_update、二维码 → qr_request、
 *   Ship-to申请 → ship_to_request；
 * - 物流公司信息费用表仅「物流费用表」sheet → logistics_fee；供应商主数据 sheet
 *   → supplier（不伪造费用错误）；
 * - 供应商表 → supplier（目标无供应商主数据表，按 mapping ignored/参考来源）。
 *
 * 仅 project（合同/项目）与 invoice（掉票，需项目聚合）要求 ECC；
 * 开单、二维码申请、序列地址更新、Ship-to 申请按各自业务键/独立记录，不要求 ECC。
 *
 * 错误/冲突严格不含 cell value：只定位 文件/sheet/物理行/目标字段/errorCode。
 */

/** 错误码（dry-run 报告稳定字段，避免 N/A）。 */
export type ErrorCode =
  | 'REQUIRED_FIELD_MISSING'
  | 'ECC_REQUIRED'
  | 'INVALID_AMOUNT'
  | 'INVALID_VALUE';

/** 冲突码（dry-run 报告稳定字段）。 */
export type ConflictCode =
  | 'MULTI_SOURCE_CONFLICT'
  | 'DUPLICATE_SERVICE_ORDER'
  | 'UNMAPPABLE_FILE'
  | 'QR_TYPE_COUNT_UNMAPPABLE';

/** 单条必填字段缺失错误（指明源文件、sheet、物理行、目标字段与错误码）。 */
export interface RequiredFieldError {
  errorCode: ErrorCode;
  fileName: string;
  sheet: string;
  physicalRow: number;
  /** 目标字段（如 contract.ecc）。 */
  field: string;
  /** 中文标签。 */
  fieldLabel: string;
}

/** 冲突清单条目（不含 cell value；field 为目标字段，仅定位不泄露值）。 */
export interface ConflictEntry {
  conflictCode: ConflictCode;
  fileName: string | null;
  sheet: string | null;
  physicalRow: number | null;
  /** 涉及的目标字段（如 contract.customer_name）；多来源冲突必填，其余可为 null。 */
  field: string | null;
  message: string;
}

/** dry-run 解析报告（记录数、可映射与不可映射、sheet 路由）。 */
export interface ParseReport {
  /** 源文件维度统计。 */
  files: { fileName: string; sheets: string[]; rowCount: number }[];
  /** 聚合后的项目数（ECC 聚合主键）。 */
  projectCount: number;
  /** 各类目标记录数。 */
  recordCounts: Record<string, number>;
  /** 明确忽略的 sheet（不产生 error/conflict）。 */
  ignoredSheets: { fileName: string; sheet: string; reason: string }[];
  /** 无法归属任何目标记录类型的源行数（不可映射）。 */
  unmappableRowCount: number;
}

/** dry-run 报告（8.6）：解析报告 + 冲突报告 + 必填缺失错误清单。 */
export interface DryRunReport {
  parse: ParseReport;
  conflicts: ConflictEntry[];
  errors: RequiredFieldError[];
  /** 是否可进入正式导入（errors=0 且 conflicts=0）。 */
  importable: boolean;
  /** 源内容摘要（dry-run 与源文件绑定；导入时校验源未变）。 */
  sourceDigest: string;
}

/** 被迁移目标记录的基础形状：来源行 + 导入来源键 + 源内容摘要（schema v7）。 */
export interface ImportedRecordBase {
  /** 产生该记录的全部源行。 */
  sourceRows: SourceRow[];
  /** 导入来源键（幂等/forward-fix：只更新同 source key 产生的迁移记录）。 */
  importSourceKey: string;
  /** 源内容摘要（同 source key + 同 hash = 幂等跳过；hash 变 = forward-fix 更新）。 */
  sourceHash: string;
}

/** 聚合后的目标项目（ECC 聚合主键）。 */
export interface ImportedProject extends ImportedRecordBase {
  ecc: string;
  customerName: string | null;
  usdTaxAmountCents: bigint | null;
  entryAt: string | null;
  region: string | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  actualInstallDoneAt: string | null;
  acceptanceReportDate: string | null;
  cancelledAt: string | null;
}

/** 开单记录（工作量统计表「开单记录表」）。 */
export interface ImportedServiceOrder extends ImportedRecordBase {
  serviceOrderNo: string;
  orderType: string;
  orderedAt: string;
  /** 参与工程师（可空，缺失或空白统一归一为 null，v20）。 */
  engineer: string | null;
  customerName: string;
  note: string | null;
}

/** 掉票记录（工作量统计表「掉票记录表」，按 ECC 归属项目聚合）。 */
export interface ImportedInvoice extends ImportedRecordBase {
  ecc: string;
  amountCents: bigint;
  invoicedAt: string;
  region: string | null;
  customerName: string | null;
}

/** 物流费用记录（物流费用表；含承运商/物流公司参考）。 */
export interface ImportedLogisticsFee extends ImportedRecordBase {
  ecc: string | null;
  appliedAt: string;
  budgetPriceCents: bigint;
  dealPriceCents: bigint;
  logisticsCostCents: bigint;
  transportCompany: string | null;
}

/** 序列号地址更新（搬迁地址信息表）。 */
export interface ImportedSerialAddressUpdate extends ImportedRecordBase {
  customerName: string;
  newSiteAddress: string;
  serialNo: string;
  accountId: string;
  updatedAt: string;
}

/** 二维码申请（服务二维码表；具体类型存在时方可落库）。 */
export interface ImportedQrRequest extends ImportedRecordBase {
  applicant: string;
  requestedAt: string;
  typeCodes: string[];
}

/** Ship-to 申请（Ship-to申请 / 搬迁地址信息表（原表无，待新增项））。 */
export interface ImportedShipToRequest extends ImportedRecordBase {
  customerName: string;
  newSiteAddress: string;
  accountId: string | null;
  requestedAt: string | null;
}

/** 供应商参考（供应商主数据 sheet；目标无供应商主数据表 → 仅参考，不入库）。 */
export interface ImportedSupplier extends ImportedRecordBase {
  transportCompany: string | null;
}

/** 导入计划：聚合项目 + 各类强类型目标记录 + 冲突与错误。 */
export interface ImportPlan {
  projects: ImportedProject[];
  serviceOrders: ImportedServiceOrder[];
  invoices: ImportedInvoice[];
  logisticsFees: ImportedLogisticsFee[];
  serialAddressUpdates: ImportedSerialAddressUpdate[];
  qrRequests: ImportedQrRequest[];
  shipToRequests: ImportedShipToRequest[];
  /** 供应商参考（无目标表，不入库；仅记录来源信息）。 */
  suppliers: ImportedSupplier[];
  /** 服务单号冲突（重复非空服务单号，TBD-21）：解决前该批次整批禁止导入。 */
  duplicateServiceOrders: { serviceOrderNo: string; rows: SourceRow[] }[];
  conflicts: ConflictEntry[];
  errors: RequiredFieldError[];
  /** 各角色记录数（开单/掉票/物流费用/地址更新/二维码/Ship-to 等）。 */
  recordCounts: Record<string, number>;
  /** 明确忽略的 sheet。 */
  ignoredSheets: { fileName: string; sheet: string; reason: string }[];
  /** 无法归属任何目标记录类型的源行。 */
  unmappableRows: SourceRow[];
  /** 全部源行内容摘要（dry-run 绑定；源变化时拒绝导入）。 */
  sourceDigest: string;
}

export interface BuildPlanOptions {
  mapping?: MigrationMapping;
}

/**
 * 目标业务日期字段（design D30：业务时间统一为 yyyy-mm-dd）。
 * 引擎路径与向导规范化路径同口径：接受 Excel serial / 纯日期 / 显式偏移 ISO /
 * 无偏移本地 datetime，输出 yyyy-mm-dd；非法值保留原文（校验阶段定位，不猜测）。
 * 日期系统按模板工作簿 1900 系统（旧五份来源 Excel 日期单元格已在读取层转为
 * 本地墙钟文本，serial 文本按 1900 系统解释，确定性可复现）。
 */
const BUSINESS_DATE_TARGETS = new Set<string>([
  'project.entry_at',
  'project.contract_start_date',
  'project.contract_end_date',
  'project.actual_install_done_at',
  'project.acceptance_report_date',
  'project.cancelled_at',
  'service_order.ordered_at',
  'invoice.invoiced_at',
  'logistics_fee.applied_at',
  'serial_address_update.updated_at',
  'qr_request.requested_at',
  'ship_to_request.requested_at',
]);

/** 业务日期字段规范化：→ yyyy-mm-dd；非法/无法解释保留原文由校验定位。 */
function normalizeBusinessDateValue(value: string): string {
  const canonical = normalizeDateValue(value, '1900', 'date');
  return canonical ?? value;
}

/** 目标项目字段赋值辅助（空串视为清除为 null；业务日期字段统一为 yyyy-mm-dd）。 */
function applyProjectField(
  project: ImportedProject,
  target: string,
  value: string,
): void {
  const cleared = value === '' ? null : value;
  const v =
    cleared === null
      ? null
      : BUSINESS_DATE_TARGETS.has(target)
        ? normalizeBusinessDateValue(cleared)
        : cleared;
  switch (target) {
    case 'contract.customer_name':
      project.customerName = v;
      break;
    case 'project.region':
      project.region = v;
      break;
    case 'project.entry_at':
      project.entryAt = v;
      break;
    case 'project.contract_start_date':
      project.contractStartDate = v;
      break;
    case 'project.contract_end_date':
      project.contractEndDate = v;
      break;
    case 'project.actual_install_done_at':
      project.actualInstallDoneAt = v;
      break;
    case 'project.acceptance_report_date':
      project.acceptanceReportDate = v;
      break;
    case 'project.cancelled_at':
      project.cancelledAt = v;
      break;
    default:
      break;
  }
}

/** 各角色必填目标字段（仅 project/invoice 要求 ECC；v20 起 service_order.engineer 可空）。 */
const ROLE_REQUIRED_FIELDS: Record<Exclude<SheetRole, 'ignored'>, string[]> = {
  project: ['contract.ecc', 'contract.customer_name'],
  service_order: [
    'service_order.service_order_no',
    'service_order.order_type',
    'service_order.ordered_at',
    'service_order.customer_name',
  ],
  invoice: ['invoice.ecc', 'invoice.amount_cents', 'invoice.invoiced_at'],
  logistics_fee: [
    'logistics_fee.applied_at',
    'logistics_fee.budget_price_cents',
    'logistics_fee.deal_price_cents',
    'logistics_fee.logistics_cost_cents',
  ],
  serial_address_update: [
    'serial_address_update.customer_name',
    'serial_address_update.new_site_address',
    'serial_address_update.serial_no',
    'serial_address_update.account_id',
    'serial_address_update.updated_at',
  ],
  qr_request: ['qr_request.applicant', 'qr_request.requested_at'],
  ship_to_request: ['ship_to_request.customer_name', 'ship_to_request.new_site_address'],
  supplier: [],
  // unmappable 与 ignored 已在路由阶段处理，此处占位（不会被访问）。
  unmappable: [],
};

/** 源行内容摘要（规范化：cells 按键排序，保证同内容行得到相同摘要）。 */
export function contentHash(row: SourceRow): string {
  const cells: Record<string, string | null> = {};
  for (const key of Object.keys(row.cells).sort()) {
    cells[key] = row.cells[key];
  }
  const canonical = JSON.stringify({
    file: row.file,
    sheet: row.sheet,
    rowNumber: row.rowNumber,
    cells,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 全部源行摘要（dry-run 绑定；源内容变化时摘要不同，拒绝导入）。 */
export function sourceRowsDigest(rows: readonly SourceRow[]): string {
  const canonical = rows
    .map((r) => contentHash(r))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 解析源行并按「文件 basename + sheet」路由聚合为导入计划。
 */
export function buildImportPlan(
  sourceRows: readonly SourceRow[],
  options: BuildPlanOptions = {},
): ImportPlan {
  const mapping = options.mapping ?? MAPPING_V1;
  const projectsByEcc = new Map<string, ImportedProject>();
  const projectOrder: string[] = [];
  const serviceOrders: ImportedServiceOrder[] = [];
  const invoices: ImportedInvoice[] = [];
  const logisticsFees: ImportedLogisticsFee[] = [];
  const serialAddressUpdates: ImportedSerialAddressUpdate[] = [];
  const qrRequests: ImportedQrRequest[] = [];
  const shipToRequests: ImportedShipToRequest[] = [];
  const suppliers: ImportedSupplier[] = [];
  const duplicateServiceOrders: { serviceOrderNo: string; rows: SourceRow[] }[] = [];
  const serviceOrderByNo = new Map<string, SourceRow[]>();
  const errors: RequiredFieldError[] = [];
  const conflicts: ConflictEntry[] = [];
  const ignoredSheets: { fileName: string; sheet: string; reason: string }[] = [];
  const unmappableRows: SourceRow[] = [];
  const recordCounts: Record<string, number> = {};

  const addRecord = (kind: string): void => {
    recordCounts[kind] = (recordCounts[kind] ?? 0) + 1;
  };

  /** 构建导入来源键（幂等/forward-fix 用）：源行键 + 业务键。 */
  const makeImportSourceKey = (row: SourceRow, businessKey: string): string =>
    idempotencyKey(row, businessKey);

  /** 必填字段缺失校验辅助（8.4）；ECC 缺失使用 ECC_REQUIRED 错误码。 */
  const requireField = (
    row: SourceRow,
    target: string,
    fieldLabel: string,
    requireEccCode: boolean,
  ): boolean => {
    const value = mappedValue(row, target, mapping);
    if (value === null) {
      errors.push({
        errorCode: requireEccCode ? 'ECC_REQUIRED' : 'REQUIRED_FIELD_MISSING',
        fileName: row.file,
        sheet: row.sheet,
        physicalRow: row.rowNumber,
        field: target,
        fieldLabel,
      });
      return false;
    }
    return true;
  };

  for (const row of sourceRows) {
    const fileRoute = fileRouteByFileName(mapping, row.file);
    const fileNameBase = sourceFileBasename(row.file);

    // 无法归属任何源文件 → 不可映射（新增文件/模块不猜测映射）。
    if (!fileRoute) {
      unmappableRows.push(row);
      if (!conflicts.some((c) => c.conflictCode === 'UNMAPPABLE_FILE' && c.fileName === fileNameBase)) {
        conflicts.push({
          conflictCode: 'UNMAPPABLE_FILE',
          fileName: fileNameBase,
          sheet: row.sheet,
          physicalRow: row.rowNumber,
          field: null,
          message: `无法将源文件「${fileNameBase}」映射到任何目标模型（不猜测映射）`,
        });
      }
      continue;
    }

    const route = sheetRouteOf(fileRoute, row.sheet) ?? {
      role: fileRoute.defaultRole,
      ignoreReason: fileRoute.defaultIgnoreReason,
    };

    // 明确忽略的 sheet：不产生 error/conflict（如 项目执行表「工作表1」「MRS Node」）。
    if (route.role === 'ignored') {
      const reason = route.ignoreReason ?? fileRoute.defaultIgnoreReason;
      if (!ignoredSheets.some((s) => s.fileName === row.file && s.sheet === row.sheet)) {
        ignoredSheets.push({ fileName: row.file, sheet: row.sheet, reason });
      }
      continue;
    }

    // 未配置的 sheet（默认 unmappable）：不猜测映射，报告冲突（按 文件+sheet 去重，
    // 单个 sheet 不可映射不影响同文件其他 sheet 的独立解析）。
    if (route.role === 'unmappable') {
      unmappableRows.push(row);
      if (!conflicts.some(
        (c) => c.conflictCode === 'UNMAPPABLE_FILE' && c.fileName === fileNameBase && c.sheet === row.sheet,
      )) {
        conflicts.push({
          conflictCode: 'UNMAPPABLE_FILE',
          fileName: fileNameBase,
          sheet: row.sheet,
          physicalRow: row.rowNumber,
          field: null,
          message: `源文件「${fileNameBase}」的 sheet「${row.sheet}」未配置映射，不猜测映射`,
        });
      }
      continue;
    }

    const role = route.role;
    const requiredTargets = ROLE_REQUIRED_FIELDS[role];
    const requireEcc = role === 'project' || role === 'invoice';

    // supplier：目标无供应商主数据表 → 仅记录参考来源（不入库，不产生错误/记录数）。
    if (role === 'supplier') {
      suppliers.push({
        sourceRows: [row],
        importSourceKey: makeImportSourceKey(row, 'supplier'),
        sourceHash: contentHash(row),
        transportCompany: mappedValue(row, 'logistics_fee.transport_company', mapping),
      });
      continue;
    }

    // 必填校验（按角色）。
    for (const target of requiredTargets) {
      const field = mapping.fields.find((f) => f.target === target);
      requireField(row, target, field?.label ?? target, requireEcc && target.endsWith('.ecc'));
    }

    switch (role) {
      case 'project': {
        // 项目级记录：以 ECC 为聚合主键（TBD-18）。
        const ecc = mappedValue(row, 'contract.ecc', mapping);
        if (ecc === null) {
          // ECC 必填错误已在上方必填校验输出，此处跳过聚合。
          break;
        }
        let project = projectsByEcc.get(ecc);
        if (!project) {
          project = {
            ecc,
            customerName: null,
            usdTaxAmountCents: null,
            entryAt: null,
            region: null,
            contractStartDate: null,
            contractEndDate: null,
            actualInstallDoneAt: null,
            acceptanceReportDate: null,
            cancelledAt: null,
            sourceRows: [],
            importSourceKey: makeImportSourceKey(row, `project|${ecc}`),
            sourceHash: '',
          };
          projectsByEcc.set(ecc, project);
          projectOrder.push(ecc);
        }
        project.sourceRows.push(row);

        // 来源优先级取值；同一行内多来源取值不同 → 冲突清单，不自动覆盖（8.5）。
        const applyField = (target: string, fieldLabel: string): void => {
          const values = collectMappedValues(row, target, mapping);
          if (values.length === 0) return;
          const distinct = [...new Set(values)];
          if (distinct.length > 1) {
            conflicts.push({
              conflictCode: 'MULTI_SOURCE_CONFLICT',
              fileName: row.file,
              sheet: row.sheet,
              physicalRow: row.rowNumber,
              field: target,
              message: `目标字段「${fieldLabel}」（${target}）在多个来源取值不同，不自动覆盖，需负责人确认`,
            });
            return;
          }
          applyProjectField(project!, target, distinct[0]);
        };

        applyField('contract.customer_name', '客户名称');
        applyField('project.region', '区域');
        applyField('project.entry_at', '进单时间');
        applyField('project.contract_start_date', '合同开始日期');
        applyField('project.contract_end_date', '合同截止日期');
        applyField('project.actual_install_done_at', '实际装机完成时间');
        applyField('project.acceptance_report_date', '验收报告形成日期');
        applyField('project.cancelled_at', '取消时间');

        // 合同金额：转为分整数（有值必须 ≥ 0，仅合同金额允许 0；负数/非法值报错）。
        const amountValues = collectMappedValues(row, 'contract.usd_tax_amount_cents', mapping);
        if (amountValues.length > 0) {
          const distinctAmounts = [...new Set(amountValues)];
          if (distinctAmounts.length > 1) {
            conflicts.push({
              conflictCode: 'MULTI_SOURCE_CONFLICT',
              fileName: row.file,
              sheet: row.sheet,
              physicalRow: row.rowNumber,
              field: 'contract.usd_tax_amount_cents',
              message: `目标字段「合同USD含税金额」（contract.usd_tax_amount_cents）在多个来源取值不同，不自动覆盖，需负责人确认`,
            });
          } else {
            try {
              project.usdTaxAmountCents = parseDecimalToCents(distinctAmounts[0]);
            } catch {
              errors.push({
                errorCode: 'INVALID_AMOUNT',
                fileName: row.file,
                sheet: row.sheet,
                physicalRow: row.rowNumber,
                field: 'contract.usd_tax_amount_cents',
                fieldLabel: '合同USD含税金额不是合法金额',
              });
            }
          }
        }

        addRecord('project');
        break;
      }
      case 'service_order': {
        const serviceOrderNo = mappedValue(row, 'service_order.service_order_no', mapping);
        if (serviceOrderNo !== null) {
          const existing = serviceOrderByNo.get(serviceOrderNo) ?? [];
          existing.push(row);
          serviceOrderByNo.set(serviceOrderNo, existing);
          const rawEngineer = mappedValue(row, 'service_order.engineer', mapping);
          const engineer = rawEngineer === null ? null : rawEngineer.trim() === '' ? null : rawEngineer.trim();
          serviceOrders.push({
            sourceRows: [row],
            importSourceKey: makeImportSourceKey(row, `so|${serviceOrderNo}`),
            sourceHash: contentHash(row),
            serviceOrderNo,
            orderType: mappedValue(row, 'service_order.order_type', mapping) ?? '',
            orderedAt: normalizeBusinessDateValue(mappedValue(row, 'service_order.ordered_at', mapping) ?? ''),
            engineer,
            customerName: mappedValue(row, 'service_order.customer_name', mapping) ?? '',
            note: mappedValue(row, 'service_order.note', mapping),
          });
        }
        addRecord('service_order');
        break;
      }
      case 'invoice': {
        const ecc = mappedValue(row, 'invoice.ecc', mapping) ?? '';
        const amountValue = mappedValue(row, 'invoice.amount_cents', mapping);
        let amountCents: bigint | null = null;
        if (amountValue !== null) {
          try {
            amountCents = parseDecimalToCents(amountValue);
          } catch {
            errors.push({
              errorCode: 'INVALID_AMOUNT',
              fileName: row.file,
              sheet: row.sheet,
              physicalRow: row.rowNumber,
              field: 'invoice.amount_cents',
              fieldLabel: '掉票金额不是合法金额',
            });
          }
        }
        invoices.push({
          sourceRows: [row],
          importSourceKey: makeImportSourceKey(row, `invoice|${ecc}`),
          sourceHash: contentHash(row),
          ecc,
          amountCents: amountCents ?? 0n,
          invoicedAt: normalizeBusinessDateValue(mappedValue(row, 'invoice.invoiced_at', mapping) ?? ''),
          region: mappedValue(row, 'invoice.region', mapping),
          customerName: mappedValue(row, 'invoice.customer_name', mapping),
        });
        addRecord('invoice');
        break;
      }
      case 'logistics_fee': {
        const parseAmount = (target: string): bigint => {
          const v = mappedValue(row, target, mapping);
          if (v === null) return 0n;
          try {
            return parseDecimalToCents(v);
          } catch {
            return 0n;
          }
        };
        logisticsFees.push({
          sourceRows: [row],
          importSourceKey: makeImportSourceKey(row, 'lf'),
          sourceHash: contentHash(row),
          ecc: mappedValue(row, 'invoice.ecc', mapping),
          appliedAt: normalizeBusinessDateValue(mappedValue(row, 'logistics_fee.applied_at', mapping) ?? ''),
          budgetPriceCents: parseAmount('logistics_fee.budget_price_cents'),
          dealPriceCents: parseAmount('logistics_fee.deal_price_cents'),
          logisticsCostCents: parseAmount('logistics_fee.logistics_cost_cents'),
          transportCompany: mappedValue(row, 'logistics_fee.transport_company', mapping),
        });
        addRecord('logistics_fee');
        break;
      }
      case 'serial_address_update': {
        serialAddressUpdates.push({
          sourceRows: [row],
          importSourceKey: makeImportSourceKey(row, 'sau'),
          sourceHash: contentHash(row),
          customerName: mappedValue(row, 'serial_address_update.customer_name', mapping) ?? '',
          newSiteAddress: mappedValue(row, 'serial_address_update.new_site_address', mapping) ?? '',
          serialNo: mappedValue(row, 'serial_address_update.serial_no', mapping) ?? '',
          accountId: mappedValue(row, 'serial_address_update.account_id', mapping) ?? '',
          updatedAt: normalizeBusinessDateValue(mappedValue(row, 'serial_address_update.updated_at', mapping) ?? ''),
        });
        addRecord('serial_address_update');
        break;
      }
      case 'qr_request': {
        // 二维码申请：独立申请记录；源只有类型数量、无法还原具体类型时生成明确映射冲突。
        const typeCode = mappedValue(row, 'qr_request.type_code', mapping);
        const typeCodes = typeCode === null ? [] : [typeCode];
        if (typeCode === null) {
          conflicts.push({
            conflictCode: 'QR_TYPE_COUNT_UNMAPPABLE',
            fileName: row.file,
            sheet: row.sheet,
            physicalRow: row.rowNumber,
            field: 'qr_request.type_code',
            message: '二维码申请源仅含类型数量、无法还原具体申请类型，需负责人确认映射',
          });
        }
        qrRequests.push({
          sourceRows: [row],
          importSourceKey: makeImportSourceKey(row, 'qr'),
          sourceHash: contentHash(row),
          applicant: mappedValue(row, 'qr_request.applicant', mapping) ?? '',
          requestedAt: normalizeBusinessDateValue(mappedValue(row, 'qr_request.requested_at', mapping) ?? ''),
          typeCodes,
        });
        addRecord('qr_request');
        break;
      }
      case 'ship_to_request': {
        shipToRequests.push({
          sourceRows: [row],
          importSourceKey: makeImportSourceKey(row, 'str'),
          sourceHash: contentHash(row),
          customerName: mappedValue(row, 'ship_to_request.customer_name', mapping) ?? '',
          newSiteAddress: mappedValue(row, 'ship_to_request.new_site_address', mapping) ?? '',
          accountId: mappedValue(row, 'ship_to_request.account_id', mapping),
          requestedAt:
            mappedValue(row, 'ship_to_request.requested_at', mapping) === null
              ? null
              : normalizeBusinessDateValue(mappedValue(row, 'ship_to_request.requested_at', mapping)!),
        });
        addRecord('ship_to_request');
        break;
      }
      default: {
        const _exhaustive: never = role;
        void _exhaustive;
      }
    }
  }

  // 重复非空服务单号冲突（TBD-21）：进入冲突清单，解决前该批次整批禁止导入。
  // 冲突不含具体单号值（只定位 文件/sheet/物理行/目标字段/conflictCode）。
  for (const [serviceOrderNo, rows] of serviceOrderByNo) {
    if (rows.length > 1) {
      duplicateServiceOrders.push({ serviceOrderNo, rows });
      conflicts.push({
        conflictCode: 'DUPLICATE_SERVICE_ORDER',
        fileName: rows[0].file,
        sheet: rows[0].sheet,
        physicalRow: rows[0].rowNumber,
        field: 'service_order.service_order_no',
        message: '不同源记录存在重复的非空服务单号，解决前该批次整批禁止导入（需负责人确认具体单号）',
      });
    }
  }

  // 聚合级多来源冲突（8.5）：同一字段在多个来源表取值不同 → 冲突清单，不自动覆盖。
  const crossSourceFields = [
    'contract.customer_name',
    'contract.usd_tax_amount_cents',
    'project.region',
    'project.entry_at',
    'project.contract_start_date',
    'project.contract_end_date',
  ];
  for (const project of projectsByEcc.values()) {
    for (const target of crossSourceFields) {
      const field = mapping.fields.find((f) => f.target === target);
      if (!field) continue;
      const distinct = [...new Set(
        project.sourceRows.flatMap((r) => collectMappedValues(r, target, mapping)),
      )];
      if (distinct.length > 1) {
        const already = conflicts.some(
          (c) => c.conflictCode === 'MULTI_SOURCE_CONFLICT' && c.field === target,
        );
        if (!already) {
          conflicts.push({
            conflictCode: 'MULTI_SOURCE_CONFLICT',
            fileName: project.sourceRows[0].file,
            sheet: project.sourceRows[0].sheet,
            physicalRow: project.sourceRows[0].rowNumber,
            field: target,
            message: `目标字段「${field.label}」（${target}）在多个来源表取值不同，不自动覆盖，需负责人确认`,
          });
        }
        // 不自动覆盖：冲突确认前该字段保持空（不写入目标数据）。
        applyProjectField(project, target, '');
        if (target === 'contract.usd_tax_amount_cents') {
          project.usdTaxAmountCents = null;
        }
      }
    }
  }

  const projects = projectOrder.map((ecc) => projectsByEcc.get(ecc)!);
  // 项目聚合后计算源内容摘要（forward-fix/幂等用）。
  for (const project of projects) {
    project.sourceHash = sourceRowsDigest(project.sourceRows);
  }

  return {
    projects,
    serviceOrders,
    invoices,
    logisticsFees,
    serialAddressUpdates,
    qrRequests,
    shipToRequests,
    suppliers,
    duplicateServiceOrders,
    conflicts,
    errors,
    recordCounts,
    ignoredSheets,
    unmappableRows,
    sourceDigest: sourceRowsDigest(sourceRows),
  };
}

/** 幂等键（8.7）：源行键 + 业务键；供导入方落库审计。 */
export function idempotencyKeysForProject(project: ImportedProject): string[] {
  return project.sourceRows.map((row) => idempotencyKey(row, project.ecc));
}

export { idempotencyKey, sourceRowKey, cellValue };

/** 供 CLI 与测试复用的源行类型导出。 */
export type { SourceRow };

/** 确定性状态重建（8.8）的输入事实。 */
export interface StateRebuildFacts {
  entryAt: string | null;
  executionStarted: boolean;
  actualInstallDoneAt: string | null;
  acceptanceReportDate: string | null;
  cancelledAt: string | null;
}

/**
 * 导入状态重建必须经过 lifecycle 的唯一转换入口，不能维护一套平行优先级。
 * 导入没有计划上门日期和掉票闭环事实；终态取消与验收/装机等更强事实仍由
 * resolveStatus 的既有优先级决定。
 */
export function resolveImportedStatus(
  facts: StateRebuildFacts,
  currentStatus?: ProjectStatusOrCancelled,
): TransitionResult {
  // 维修中为人工维护状态：任何导入事实（含已取消）均不得覆盖，保持维修中。
  if (currentStatus === 'under_repair') {
    return resolveStatus({
      currentStatus: 'under_repair',
      requestedStatus: 'under_repair',
      actualInstallDoneAt: facts.actualInstallDoneAt,
      acceptanceReportDate: facts.acceptanceReportDate,
      executionStarted: facts.executionStarted,
      formallyEntered: facts.entryAt !== null,
      amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: null },
      cancel: { hasAnyInvoiceHistory: false },
    });
  }
  const baseline: ProjectStatusOrCancelled = facts.entryAt === null ? 'pending_entry' : 'pending_execution';
  // requestedStatus 始终由本次导入后的完整事实推导；currentStatus 仅供 lifecycle
  // 应用终态与自动触发约束，绝不能反过来吞掉新增取消/进单事实。
  const factTarget: ProjectStatusOrCancelled = facts.cancelledAt !== null
    ? 'cancelled'
    : facts.executionStarted
      ? 'executing'
      : baseline;
  const requestedStatus = currentStatus !== undefined &&
    statusRank(currentStatus) > statusRank(factTarget)
    ? currentStatus
    : factTarget;
  return resolveStatus({
    currentStatus: currentStatus ?? baseline,
    requestedStatus,
    actualInstallDoneAt: facts.actualInstallDoneAt,
    acceptanceReportDate: facts.acceptanceReportDate,
    executionStarted: facts.executionStarted,
    formallyEntered: facts.entryAt !== null,
    amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: null },
    cancel: { hasAnyInvoiceHistory: false },
  });
}

/** 导入仅以前进事实推进既有项目；较强已持久化状态不因较弱源事实倒退。 */
function statusRank(status: ProjectStatusOrCancelled): number {
  switch (status) {
    case 'pending_entry': return 0;
    case 'pending_execution': return 1;
    case 'executing': return 2;
    case 'under_repair': return 3; // 维修中为人工维护状态，导入事实不覆盖
    case 'pending_acceptance': return 4;
    case 'pending_invoice': return 5;
    case 'completed': return 6;
    case 'cancelled': return 7;
  }
}

/** 从导入事实确定性重建主状态（兼容既有调用方）。 */
export function rebuildStatus(facts: StateRebuildFacts): ProjectStatusOrCancelled {
  const result = resolveImportedStatus(facts);
  if (!result.ok) {
    throw new Error(`导入项目状态重建失败：${result.errors.join('；')}`);
  }
  return result.status;
}
