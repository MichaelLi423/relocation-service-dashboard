import { parseDecimalToCents } from '../../core/money';
import type { NormalizedRow } from './normalized-row';
import { fieldCatalogFor } from './field-catalog';
import { planDigestFromRows } from './digest';
import { MAPPING_V1, fieldByTarget, fileRouteByFileName } from './mapping';
import type { ImportConflictCandidate } from './validation-model';
import type { ImportCategory } from './workspace/workspace-model';
import { IMPORT_CATEGORIES } from './workspace/workspace-model';

/**
 * 领域内核：统一规范化行 → 七类记录计划（design D19 / tasks 8.27、8.29）。
 *
 * - 仅消费 NormalizedRow（文件/粘贴共用模型），不依赖 CLI 参数或 SourceRow；
 * - 保留七类记录计划（项目/合同、开单、掉票、物流费用、序列号地址更新、
 *   二维码申请、Ship-to 申请）与来源定位；
 * - ECC 为项目/合同聚合主键：同一 ECC 下全部执行数据聚合为一个搬迁项目；
 *   不同合法来源值进入 sourceConflicts（候选值 + 来源位置），相同规范化值不产生冲突；
 * - 供应商仅作物流参考（transport_company），不构成独立第八类记录；
 * - 金额以分整数（bigint）精确表达，来源优先级复用冻结映射 MAPPING_V1。
 */

/** 被迁移目标记录的基础形状：产生该记录的规范化行。 */
export interface PlanRecordBase {
  rows: NormalizedRow[];
}

/** 聚合后的搬迁项目（ECC 聚合主键；金额分整数）。 */
export interface PlanProject extends PlanRecordBase {
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
  /** 项目内的仪器（含序列号，供同项目唯一性与序列号匹配校验）。 */
  instruments: PlanInstrument[];
}

/** 搬迁仪器（登记时名称必填；序列号可空；按文本保留前导零）。 */
export interface PlanInstrument extends PlanRecordBase {
  name: string;
  serialNo: string | null;
}

/** 开单记录。 */
export interface PlanServiceOrder extends PlanRecordBase {
  serviceOrderNo: string;
  orderType: string;
  orderedAt: string;
  /** 参与工程师（可空，缺失或空白统一归一为 null，v20）。 */
  engineer: string | null;
  customerName: string;
  note: string | null;
}

/** 掉票记录。 */
export interface PlanInvoice extends PlanRecordBase {
  ecc: string;
  amountCents: bigint | null;
  invoicedAt: string | null;
  region: string | null;
  customerName: string | null;
}

/** 物流费用记录（运输公司仅为参考；供应商不构成独立记录）。 */
export interface PlanLogisticsFee extends PlanRecordBase {
  ecc: string | null;
  appliedAt: string | null;
  budgetPriceCents: bigint | null;
  dealPriceCents: bigint | null;
  logisticsCostCents: bigint | null;
  transportCompany: string | null;
}

/** 序列号地址更新记录（不创建/修改不可变 Ship-to 主数据）。 */
export interface PlanSerialAddressUpdate extends PlanRecordBase {
  customerName: string;
  newSiteAddress: string;
  serialNo: string;
  accountId: string;
  updatedAt: string;
}

/** 二维码申请（仅在有明确申请类型时产生有效记录；类型数量不用于猜测）。 */
export interface PlanQrRequest extends PlanRecordBase {
  applicant: string;
  requestedAt: string;
  typeCode: string | null;
  typeCount: string | null;
}

/** Ship-to 申请（独立申请记录，不强制关联 ECC）。 */
export interface PlanShipToRequest extends PlanRecordBase {
  customerName: string;
  newSiteAddress: string;
  accountId: string | null;
  requestedAt: string | null;
}

/** 供应商参考（无目标表，仅记录来源信息；实际由规范化阶段排除，恒为空）。 */
export interface PlanSupplier extends PlanRecordBase {
  transportCompany: string | null;
}

/** 项目字段多来源冲突（候选值 + 来源位置；解决前该项目字段保持空）。 */
export interface SourceConflict {
  ecc: string;
  field: string;
  fieldLabel: string;
  candidates: ImportConflictCandidate[];
  /** 涉及冲突的规范化行记录键。 */
  recordKeys: string[];
}

/** 领域内核输出：七类记录计划 + 聚合冲突 + 计划摘要。 */
export interface NormalizedImportPlan {
  projects: PlanProject[];
  serviceOrders: PlanServiceOrder[];
  invoices: PlanInvoice[];
  logisticsFees: PlanLogisticsFee[];
  serialAddressUpdates: PlanSerialAddressUpdate[];
  qrRequests: PlanQrRequest[];
  shipToRequests: PlanShipToRequest[];
  /** 供应商参考（无目标表；恒为空，仅保留类型与说明）。 */
  suppliers: PlanSupplier[];
  /** 项目字段多来源冲突（design D24 候选）。 */
  sourceConflicts: SourceConflict[];
  /** 缺少 ECC 而无法聚合的项目源行（校验阶段报必填错误）。 */
  orphanProjectRows: NormalizedRow[];
  recordCounts: Record<ImportCategory, number>;
  /** 规范化计划摘要（稳定排序；同语义文件/粘贴/不同顺序相同）。 */
  planDigest: string;
}

/** 来源位置（file#sheet#row / paste#batch#row）。 */
export function sourcePositionOf(row: NormalizedRow): string | null {
  if (row.sourceKind === 'file') {
    return row.sourceFile !== null
      ? `${row.sourceFile}#${row.sourceSheet ?? '-'}#${row.sourceRow ?? 0}`
      : null;
  }
  return `paste:${row.pasteBatch ?? '?'}#${row.sourceRow ?? 0}`;
}

/** 来源描述（展示用；粘贴无文件/表名）。 */
function sourceLabelOf(row: NormalizedRow): string {
  if (row.sourceKind === 'file') {
    return row.sourceFile ?? '文件';
  }
  return `粘贴批次 ${row.pasteBatch ?? '?'}`;
}

/** 来源优先级：复用冻结映射 MAPPING_V1（同表全部来源 ref 的最小 priority）。 */
export function sourcePriorityOf(row: NormalizedRow, field: string): number | null {
  if (row.sourceKind !== 'file' || row.sourceFile === null) return null;
  const route = fileRouteByFileName(MAPPING_V1, row.sourceFile);
  if (!route) return null;
  const mapping = fieldByTarget(MAPPING_V1, field);
  if (!mapping) return null;
  const priorities = mapping.sources.filter((s) => s.table === route.table).map((s) => s.priority);
  return priorities.length > 0 ? Math.min(...priorities) : null;
}

/** 解析金额分整数；非法/空返回 null（校验阶段以字段级错误定位）。 */
export function moneyCentsOf(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return parseDecimalToCents(value);
  } catch {
    return null;
  }
}

/** 单元格取值（规范化值；空/缺失视为 null）。 */
function cell(row: NormalizedRow, field: string): string | null {
  const v = row.cells[field];
  return v !== null && v !== undefined && v !== '' ? v : null;
}

/** 项目聚合字段（排除 ECC 聚合主键与 instrument.* 仪器字段）。 */
function aggregateFields(): readonly string[] {
  return fieldCatalogFor('project')
    .filter((f) => f.field !== 'contract.ecc' && !f.field.startsWith('instrument.'))
    .map((f) => f.field);
}

/** 聚合单个项目字段：全部非空规范化值一致 → 取值；不同 → 冲突（值置空）。 */
function aggregateProjectField(
  rows: readonly NormalizedRow[],
  field: string,
  label: string,
  conflicts: SourceConflict[],
): string | null {
  const present = rows
    .map((r) => ({ row: r, value: cell(r, field) }))
    .filter((x): x is { row: NormalizedRow; value: string } => x.value !== null);
  const distinct = [...new Set(present.map((x) => x.value))];
  if (distinct.length === 0) return null;
  if (distinct.length > 1) {
    conflicts.push({
      ecc: rows.find((r) => cell(r, 'contract.ecc') !== null)?.businessKey ?? '',
      field,
      fieldLabel: label,
      candidates: present.map((x) => ({
        value: x.value,
        sourcePosition: sourcePositionOf(x.row),
        sourcePriority: sourcePriorityOf(x.row, field),
        source: sourceLabelOf(x.row),
      })),
      recordKeys: present.map((x) => x.row.rowId),
    });
    return null;
  }
  return distinct[0];
}

/** 项目聚合：以 ECC 为聚合主键（缺 ECC 的行进入 orphanProjectRows）。 */
function aggregateProjects(rows: readonly NormalizedRow[]): {
  projects: PlanProject[];
  orphanProjectRows: NormalizedRow[];
  conflicts: SourceConflict[];
} {
  const byEcc = new Map<string, NormalizedRow[]>();
  const orphans: NormalizedRow[] = [];
  const order: string[] = [];
  for (const row of rows) {
    const ecc = cell(row, 'contract.ecc');
    if (ecc === null) {
      orphans.push(row);
      continue;
    }
    if (!byEcc.has(ecc)) {
      byEcc.set(ecc, []);
      order.push(ecc);
    }
    byEcc.get(ecc)!.push(row);
  }

  const projects: PlanProject[] = [];
  const conflicts: SourceConflict[] = [];
  for (const ecc of order) {
    const group = byEcc.get(ecc)!;
    const project: PlanProject = {
      ecc,
      rows: group,
      customerName: null,
      usdTaxAmountCents: null,
      entryAt: null,
      region: null,
      contractStartDate: null,
      contractEndDate: null,
      actualInstallDoneAt: null,
      acceptanceReportDate: null,
      cancelledAt: null,
      instruments: [],
    };
    for (const field of aggregateFields()) {
      const def = fieldCatalogFor('project').find((f) => f.field === field)!;
      const value = aggregateProjectField(group, field, def.label, conflicts);
      switch (field) {
        case 'contract.customer_name':
          project.customerName = value;
          break;
        case 'project.region':
          project.region = value;
          break;
        case 'project.entry_at':
          project.entryAt = value;
          break;
        case 'project.contract_start_date':
          project.contractStartDate = value;
          break;
        case 'project.contract_end_date':
          project.contractEndDate = value;
          break;
        case 'project.actual_install_done_at':
          project.actualInstallDoneAt = value;
          break;
        case 'project.acceptance_report_date':
          project.acceptanceReportDate = value;
          break;
        case 'project.cancelled_at':
          project.cancelledAt = value;
          break;
        case 'contract.usd_tax_amount_cents':
          project.usdTaxAmountCents = value === null ? null : moneyCentsOf(value);
          break;
        default:
          break;
      }
    }
    // 仪器行：携带任一 instrument.* 字段的项目行 → 一台仪器。
    for (const row of group) {
      const name = cell(row, 'instrument.name');
      const serialNo = cell(row, 'instrument.serial_no');
      if (name !== null || serialNo !== null) {
        project.instruments.push({ rows: [row], name: name ?? '', serialNo });
      }
    }
    projects.push(project);
  }
  return { projects, orphanProjectRows: orphans, conflicts };
}

/**
 * 领域内核：NormalizedRow → 七类记录计划（design D19 / tasks 8.27）。
 * 每类一条记录对应一个 NormalizedRow（项目按 ECC 聚合）。
 */
export function buildPlanFromRows(rows: readonly NormalizedRow[]): NormalizedImportPlan {
  const serviceOrders: PlanServiceOrder[] = [];
  const invoices: PlanInvoice[] = [];
  const logisticsFees: PlanLogisticsFee[] = [];
  const serialAddressUpdates: PlanSerialAddressUpdate[] = [];
  const qrRequests: PlanQrRequest[] = [];
  const shipToRequests: PlanShipToRequest[] = [];

  for (const row of rows) {
    switch (row.category) {
      case 'project':
        break; // 项目在下方按 ECC 聚合
      case 'service_order': {
        const rawEngineer = cell(row, 'service_order.engineer');
        const engineer = rawEngineer === null ? null : rawEngineer.trim() === '' ? null : rawEngineer.trim();
        serviceOrders.push({
          rows: [row],
          serviceOrderNo: cell(row, 'service_order.service_order_no') ?? '',
          orderType: cell(row, 'service_order.order_type') ?? '',
          orderedAt: cell(row, 'service_order.ordered_at') ?? '',
          engineer,
          customerName: cell(row, 'service_order.customer_name') ?? '',
          note: cell(row, 'service_order.note'),
        });
        break;
      }
      case 'invoice':
        invoices.push({
          rows: [row],
          ecc: cell(row, 'invoice.ecc') ?? '',
          amountCents: moneyCentsOf(cell(row, 'invoice.amount_cents')),
          invoicedAt: cell(row, 'invoice.invoiced_at'),
          region: cell(row, 'invoice.region'),
          customerName: cell(row, 'invoice.customer_name'),
        });
        break;
      case 'logistics_fee':
        logisticsFees.push({
          rows: [row],
          ecc: cell(row, 'logistics_fee.ecc'),
          appliedAt: cell(row, 'logistics_fee.applied_at'),
          budgetPriceCents: moneyCentsOf(cell(row, 'logistics_fee.budget_price_cents')),
          dealPriceCents: moneyCentsOf(cell(row, 'logistics_fee.deal_price_cents')),
          logisticsCostCents: moneyCentsOf(cell(row, 'logistics_fee.logistics_cost_cents')),
          transportCompany: cell(row, 'logistics_fee.transport_company'),
        });
        break;
      case 'serial_address_update':
        serialAddressUpdates.push({
          rows: [row],
          customerName: cell(row, 'serial_address_update.customer_name') ?? '',
          newSiteAddress: cell(row, 'serial_address_update.new_site_address') ?? '',
          serialNo: cell(row, 'serial_address_update.serial_no') ?? '',
          accountId: cell(row, 'serial_address_update.account_id') ?? '',
          updatedAt: cell(row, 'serial_address_update.updated_at') ?? '',
        });
        break;
      case 'qr_request':
        qrRequests.push({
          rows: [row],
          applicant: cell(row, 'qr_request.applicant') ?? '',
          requestedAt: cell(row, 'qr_request.requested_at') ?? '',
          typeCode: cell(row, 'qr_request.type_code'),
          typeCount: cell(row, 'qr_request.type_count'),
        });
        break;
      case 'ship_to_request':
        shipToRequests.push({
          rows: [row],
          customerName: cell(row, 'ship_to_request.customer_name') ?? '',
          newSiteAddress: cell(row, 'ship_to_request.new_site_address') ?? '',
          accountId: cell(row, 'ship_to_request.account_id'),
          requestedAt: cell(row, 'ship_to_request.requested_at'),
        });
        break;
      default: {
        const _exhaustive: never = row.category;
        void _exhaustive;
      }
    }
  }

  const { projects: aggregated, orphanProjectRows, conflicts: sourceConflicts } = aggregateProjects(
    rows.filter((r) => r.category === 'project'),
  );

  const recordCounts = {} as Record<ImportCategory, number>;
  for (const c of IMPORT_CATEGORIES) recordCounts[c] = 0;
  for (const row of rows) {
    recordCounts[row.category] += 1;
  }

  return {
    projects: aggregated,
    serviceOrders,
    invoices,
    logisticsFees,
    serialAddressUpdates,
    qrRequests,
    shipToRequests,
    suppliers: [],
    sourceConflicts,
    orphanProjectRows,
    recordCounts,
    planDigest: planDigestFromRows(rows),
  };
}

/**
 * 幂等/forward-fix 来源键（与 migration-service 的 idempotencyKey 同构，供目标冲突匹配）：
 * 文件 = file#sheet#row|suffix（suffix 如 so|单号、invoice|ECC、lf、sau、qr、str）；
 * 粘贴使用 paste 定位（无历史基线，仅用于区分来源）。
 */
export function planSourceKey(suffix: string, row: NormalizedRow): string {
  const location =
    row.sourceKind === 'file'
      ? `${row.sourceFile ?? '-'}#${row.sourceSheet ?? '-'}#${row.sourceRow ?? 0}`
      : `paste:${row.pasteBatch ?? '?'}#${row.sourceRow ?? 0}`;
  return `${location}|${suffix}`;
}
