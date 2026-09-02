import { ValidationError } from '../../core/errors';
import { normalizeRegion, regionGroupKey } from '../../core/ids';
import { Money, Ratio, RMB_TO_USD_RATE } from '../../core/money';
import {
  SystemClock,
  toMonthKey,
  type BusinessDate,
  type Clock,
  type MonthKey,
} from '../../core/time';
import type { Project } from '../relocation-project-lifecycle';
import type { LogisticsFee } from '../relocation-execution';
import type { ProjectStatusOrCancelled } from '../relocation-project-lifecycle';
import type { OrderType } from '../service-order-recording';
import type { PartCurrency, PartStatus } from '../damage-repair-tracking';
import type { QrRequestTypeCode } from '../qr-request-tracking';
import type { ReportFilter, ReportMetricKey } from './metrics';
import type { ReportingFactReader } from './reporting-facts';

/**
 * operational-reporting 领域服务（tasks 7.2~7.10 / design D10）。
 *
 * 本模块唯一拥有全部统计公式，从 ReportingFactReader 实时读取原始事实，
 * 每次调用即时计算（无快照、不缓存）；掉票编辑/撤销、取消、区域修改、
 * 迁移导入等事后变更实时反映到下一次读取结果。
 *
 * 口径要点：
 * - 月份区间由负责人手工选择（无默认季度，TBD-17）；区域按去除首尾空白后的
 *   固定枚举（East/South/West/Central/North）分组、不保存快照，区域修改后
 *   历史报表实时重算；存量非枚举非空区域文本保留原值、归入「待调整」独立分组
 *   （tasks 2.4，不猜测映射、不置空、不丢弃）。
 * - 责任人归属取动作记录中持久化的账号内部 ID 与当时用户名快照，历史统计
 *   不因以后用户名修改而动态变化（7.8）。
 * - 已取消项目排除项目管道、进单金额、掉票金额/次数及金额闭环指标，但取消前
 *   实际发生的物流费用与损坏维修备件金额作为真实成本保留并标记已取消（7.9）。
 * - 下钻明细与指标计算口径一致（7.10）：本服务先计算明细、再从明细聚合。
 */

// ---------------------------------------------------------------------------
// 行类型
// ---------------------------------------------------------------------------

/** 项目管道行：当前状态快照（已取消排除）。 */
export interface ProjectPipelineRow {
  status: ProjectStatusOrCancelled;
  projectCount: number;
}

/** 各区域新项目进单金额行（7.2）。 */
export interface EntryAmountRow {
  month: string;
  region: string;
  /** 进单金额快照合计（分整数）。 */
  amountCents: bigint;
  projectCount: number;
}

/** 月度掉票金额/次数行（7.3）。 */
export interface MonthlyInvoiceRow {
  month: string;
  /** 有效掉票金额合计（分整数）。 */
  amountCents: bigint;
  /** 有效掉票次数。 */
  count: number;
}

/** 月度开单量行（7.4）：按唯一服务单号计数、按四类业务分组。 */
export interface ServiceOrderCountRow {
  month: string;
  orderType: OrderType;
  count: number;
}

/** 损坏维修统计汇总行（7.5）。 */
export interface DamageSummaryRow {
  month: string;
  /** 归属责任人：动作记录中持久化的账号快照（汇总按该维度分组）。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  /** 事项记录数量（全部事项）。 */
  recordCount: number;
  /** 仅「已使用」备件折算后 USD 金额合计（分整数）。 */
  usedPartUsdCents: bigint;
}

/** 损坏维修下钻明细（7.5/7.10）。 */
export interface DamageDetailRow {
  itemId: string;
  projectId: string;
  projectTempNo: string;
  region: string;
  registeredAt: BusinessDate;
  month: MonthKey;
  partStatus: PartStatus | null;
  partAmountCents: bigint;
  partCurrency: PartCurrency;
  /** 仅「已使用」备件折算后 USD 金额（RMB 按固定汇率折算）。 */
  usedPartUsdCents: bigint;
  /** 最新合同 USD 含税金额（分整数；null = 未录入）。 */
  contractAmountCents: bigint | null;
  /** 单条事项合同占比（百分之一为单位）；null = 合同金额为空或 0 不可计算。 */
  ratioPercentHundredths: bigint | null;
  /** 合同金额为空或 0 时占比不可计算（明确提示）。 */
  ratioUnavailable: boolean;
  /** 占比超过 100% 允许如实显示并给出警告。 */
  ratioOverHundred: boolean;
  /** 归属责任人：动作记录中持久化的账号快照。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  /** 项目已取消：真实成本保留并标记。 */
  cancelled: boolean;
}

/** 月度物流费用汇总行（7.6）：每家运输公司一行，人民币口径。 */
export interface LogisticsSummaryRow {
  month: string;
  transportCompany: string;
  batchCount: number;
  /** 人民币预算合计（分整数）。 */
  budgetSumCents: bigint;
  /** 人民币成交合计（分整数）。 */
  dealSumCents: bigint;
  /** 人民币实际物流费用合计（分整数）。 */
  costSumCents: bigint;
  /** 预算成交差异（预算 - 成交）。 */
  budgetDealDiffCents: bigint;
  /** 预算费用差异（预算 - 实际费用）。 */
  budgetCostDiffCents: bigint;
  /** 成交价格高于预算的批次数（单独提示计数，不影响合计）。 */
  dealOverBudgetCount: number;
  /** 其中已取消项目的批次数（真实成本保留并标记）。 */
  cancelledBatchCount: number;
}

/** 物流费用合同占比行（7.6）：按项目 × 月份。 */
export interface LogisticsRatioRow {
  projectId: string;
  projectTempNo: string;
  month: string;
  /** 实际物流费用折算 USD 合计（分整数）。 */
  costUsdCents: bigint;
  /** 最新合同 USD 含税金额（分整数）。 */
  contractAmountCents: bigint | null;
  /** 占比（百分之一为单位）；null = 合同金额为空或 0 不可计算。 */
  ratioPercentHundredths: bigint | null;
  /** 合同金额为空或 0 时不可计算（明确提示）。 */
  ratioUnavailable: boolean;
  cancelled: boolean;
}

/** 待补实际费用清单行（7.6）：已有成交价格但尚未登记实际物流费用的批次。 */
export interface PendingLogisticsRow {
  batchId: string;
  projectId: string;
  projectTempNo: string;
  transportCompany: string | null;
  planTransportDate: BusinessDate | null;
  /** 已有成交价格（批次折后价，分整数）。 */
  dealPriceCents: bigint | null;
}

/** Ship-to 申请工作量行（7.7）：按首次实际提交月份 × 责任人。 */
export interface ShipToWorkloadRow {
  month: string;
  /** 归属责任人：动作记录中持久化的账号快照（汇总按该维度分组）。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  count: number;
}

/** 二维码申请工作量行（7.7）：按申请月份 × 去重类型 × 责任人。 */
export interface QrWorkloadRow {
  month: string;
  typeCode: QrRequestTypeCode;
  /** 归属责任人：动作记录中持久化的账号快照（汇总按该维度分组）。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  count: number;
}

/** 序列号地址更新记录数行（7.7）：按更新月份 × 客户 × 责任人。 */
export interface SerialAddressUpdateRow {
  month: string;
  customerName: string;
  /** 归属责任人：动作记录中持久化的账号快照（汇总按该维度分组）。 */
  operatorAccountId: string | null;
  operatorUsername: string | null;
  count: number;
}

/** 报表模型：与导出内容一致（导出必须与同次实时 report model 一致）。 */
export interface ReportModel {
  /** 月份区间（手工选择，无默认季度）。 */
  range: { from: string; to: string };
  /** 筛选条件快照。 */
  filters: {
    region: string | null;
    orderType: OrderType | null;
    transportCompany: string | null;
    engineer: string | null;
    operator: string | null;
    tagIds: readonly string[];
  };
  /** 报表生成时间（带偏移 ISO，注入时钟）。 */
  generatedAt: string;
  pipeline: ProjectPipelineRow[];
  entryAmountByRegion: EntryAmountRow[];
  monthlyInvoices: MonthlyInvoiceRow[];
  monthlyServiceOrders: ServiceOrderCountRow[];
  damageSummary: DamageSummaryRow[];
  damageDetails: DamageDetailRow[];
  monthlyLogistics: LogisticsSummaryRow[];
  logisticsContractRatios: LogisticsRatioRow[];
  pendingLogistics: PendingLogisticsRow[];
  shipToWorkload: ShipToWorkloadRow[];
  qrWorkload: QrWorkloadRow[];
  serialAddressUpdates: SerialAddressUpdateRow[];
}

/** 下钻明细（口径与指标一致，7.10）。 */
export type MetricDetailRow =
  | ProjectPipelineRow
  | EntryAmountRow
  | { month: MonthKey; invoiceId: string; projectTempNo: string; invoicedAt: BusinessDate; amountCents: bigint; region: string }
  | { month: MonthKey; orderId: string; orderType: OrderType; serviceOrderNo: string | null; orderedAt: BusinessDate; engineer: string | null; region: string | null }
  | DamageDetailRow
  | { month: MonthKey; feeId: string; batchId: string; projectTempNo: string; transportCompany: string | null; appliedAt: BusinessDate; budgetPriceCents: bigint; dealPriceCents: bigint; costCents: bigint; cancelled: boolean }
  | LogisticsRatioRow
  | PendingLogisticsRow
  | { month: MonthKey; requestId: string; customerName: string; submittedAt: BusinessDate; operatorAccountId: string | null; operatorUsername: string | null }
  | { month: MonthKey; requestId: string; applicant: string; requestedAt: BusinessDate; typeCode: QrRequestTypeCode; operatorAccountId: string | null; operatorUsername: string | null }
  | { month: MonthKey; updateId: string; customerName: string; updatedAt: BusinessDate; serialNo: string; operatorAccountId: string | null; operatorUsername: string | null };

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

export class ReportingService {
  constructor(
    private readonly facts: ReportingFactReader,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- 7.10 主入口：构建当前筛选条件下的完整报表模型（实时读取） ----

  buildReport(filter: ReportFilter): ReportModel {
    this.assertFilter(filter);
    const all = this.facts;
    const f = this.scopedFilter(all, filter);

    const invoices = this.filterInvoiceDetails(all, f);
    const orders = this.filterOrderDetails(all, f);
    const damages = this.filterDamageDetails(all, f);
    const logistics = this.filterLogisticsDetails(all, f);
    const ratios = this.logisticsRatios(all, f);
    const pending = this.pendingLogistics(all, f);

    return {
      range: { from: f.monthFrom, to: f.monthTo },
      filters: {
        region: f.region ?? null,
        orderType: f.orderType ?? null,
        transportCompany: f.transportCompany ?? null,
        engineer: f.engineer ?? null,
        operator: f.operator ?? null,
        tagIds: f.tagIds,
      },
      generatedAt: this.now(),
      pipeline: this.pipelineRows(all, f),
      entryAmountByRegion: this.entryAmountRows(all, f),
      monthlyInvoices: aggregateInvoices(invoices),
      monthlyServiceOrders: aggregateOrders(orders),
      damageSummary: aggregateDamages(damages),
      damageDetails: damages,
      monthlyLogistics: aggregateLogistics(logistics),
      logisticsContractRatios: ratios,
      pendingLogistics: pending,
      shipToWorkload: this.shipToWorkloadRows(all, f),
      qrWorkload: this.qrWorkloadRows(all, f),
      serialAddressUpdates: this.serialUpdateRows(all, f),
    };
  }

  /** 下钻明细：与指标计算口径一致（同一谓词、同一事实源、实时读取）。 */
  getMetricDetails(metricKey: ReportMetricKey, filter: ReportFilter): MetricDetailRow[] {
    this.assertFilter(filter);
    const all = this.facts;
    const f = this.scopedFilter(all, filter);
    switch (metricKey) {
      case 'project_pipeline':
        return this.pipelineRows(all, f);
      case 'entry_amount_by_region':
        return this.entryAmountRows(all, f);
      case 'monthly_invoice_amount':
      case 'monthly_invoice_count':
        return this.invoiceDetailRows(all, f);
      case 'monthly_service_order_count':
        return this.orderDetailRows(all, f);
      case 'damage_repair_stats':
        return this.filterDamageDetails(all, f);
      case 'monthly_logistics':
        return this.logisticsDetailRows(all, f);
      case 'logistics_contract_ratio':
        return this.logisticsRatios(all, f);
      case 'pending_logistics_list':
        return this.pendingLogistics(all, f);
      case 'ship_to_request_workload':
        return this.shipToDetailRows(all, f);
      case 'qr_request_workload':
        return this.qrDetailRows(all, f);
      case 'serial_address_update_count':
        return this.serialDetailRows(all, f);
    }
  }

  // ---- 7.2 各区域新项目进单金额 ----

  private entryAmountRows(all: ReportingFactReader, f: NormalizedFilter): EntryAmountRow[] {
    const contractsByProject = new Map(all.listContracts().map((c) => [c.projectId, c]));
    const groups = new Map<string, { amountCents: bigint; projectCount: number }>();
    for (const project of all.listProjects()) {
      if (project.entryAt === null) continue; // 未正式进单不计
      if (project.status === 'cancelled') continue; // 已取消排除（7.9）
      if (!this.projectInScope(project.id, f)) continue;
      if (!this.regionMatch(project, f)) continue;
      const month = toMonthKey(project.entryAt);
      if (!this.inRange(month, f)) continue;
      const contract = contractsByProject.get(project.id);
      const snapshot = contract?.entryAmountSnapshotCents ?? null;
      if (snapshot === null) continue; // 无快照不计
      const key = `${month}\u0000${this.regionKey(project)}`;
      const group = groups.get(key) ?? { amountCents: 0n, projectCount: 0 };
      group.amountCents += snapshot;
      group.projectCount += 1;
      groups.set(key, group);
    }
    return [...groups.entries()]
      .sort()
      .map(([key, g]) => {
        const [month, region] = key.split('\u0000');
        return { month, region, amountCents: g.amountCents, projectCount: g.projectCount };
      });
  }

  // ---- 7.3 月度掉票金额与掉票次数 ----

  private filterInvoiceDetails(
    all: ReportingFactReader,
    f: NormalizedFilter,
  ): InvoiceAggDetail[] {
    const projectsById = new Map(all.listProjects().map((p) => [p.id, p]));
    return all
      .listInvoices()
      .filter((inv) => inv.revokedAt === null) // 已撤销不计
      .map((inv) => ({ inv, project: projectsById.get(inv.projectId) }))
      .filter((x): x is { inv: (typeof x)['inv']; project: Project } => x.project !== undefined)
      .filter((x) => this.projectInScope(x.project.id, f))
      .filter((x) => x.project.status !== 'cancelled') // 已取消项目排除（7.9）
      .filter((x) => this.regionMatch(x.project, f))
      .filter((x) => this.inRange(toMonthKey(x.inv.invoicedAt), f))
      .map((x) => ({
        month: toMonthKey(x.inv.invoicedAt),
        invoiceId: x.inv.id,
        projectId: x.inv.projectId,
        projectTempNo: x.project.tempNo,
        region: this.regionKey(x.project),
        invoicedAt: x.inv.invoicedAt,
        amountCents: x.inv.amountCents,
      }));
  }

  private invoiceDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    return this.filterInvoiceDetails(all, f);
  }

  // ---- 7.4 月度开单量 ----

  private filterOrderDetails(all: ReportingFactReader, f: NormalizedFilter): OrderAggDetail[] {
    const projectsById = new Map(all.listProjects().map((p) => [p.id, p]));
    return all
      .listServiceOrders()
      .filter((o) => o.serviceOrderNo !== null) // 无单号不计工作量
      .filter((o) => this.inRange(toMonthKey(o.orderedAt), f))
      .filter((o) => f.orderType === null || o.orderType === f.orderType)
      .filter((o) => f.engineer === null || (o.engineer ?? '').includes(f.engineer))
      .filter((o) => o.projectId === null ? !this.tagFiltering(f) : this.projectInScope(o.projectId, f))
      .filter((o) => {
        if (f.region === null) return true;
        if (o.projectId === null) return false; // 区域筛选下无项目关联的开单不计
        const project = projectsById.get(o.projectId);
        return project !== undefined && this.regionMatch(project, f);
      })
      .map((o) => ({
        month: toMonthKey(o.orderedAt),
        orderId: o.id,
        orderType: o.orderType,
        serviceOrderNo: o.serviceOrderNo,
        orderedAt: o.orderedAt,
        engineer: o.engineer,
        region: o.projectId === null ? null : this.regionKey(projectsById.get(o.projectId)!),
      }));
  }

  private orderDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    return this.filterOrderDetails(all, f);
  }

  // ---- 7.5 损坏维修统计 ----

  private filterDamageDetails(all: ReportingFactReader, f: NormalizedFilter): DamageDetailRow[] {
    const projectsById = new Map(all.listProjects().map((p) => [p.id, p]));
    const contractsByProject = new Map(all.listContracts().map((c) => [c.projectId, c]));
    return all
      .listDamageItems()
      .map((item) => ({ item, project: projectsById.get(item.projectId) }))
      .filter((x): x is { item: (typeof x)['item']; project: Project } => x.project !== undefined)
      .filter((x) => this.projectInScope(x.project.id, f))
      .filter((x) => this.regionMatch(x.project, f))
      .filter((x) => this.inRange(toMonthKey(x.item.registeredAt), f))
      .filter((x) => this.operatorMatch(x.item.operatorUsername, f))
      .map((x) => {
        const { item, project } = x;
        const usedPartUsdCents = this.usedPartUsdCents(item.partStatus, item.partAmountCents, item.partCurrency);
        const contractAmountCents = contractsByProject.get(project.id)?.usdTaxAmountCents ?? null;
        const ratio = this.partRatio(usedPartUsdCents, contractAmountCents);
        return {
          itemId: item.id,
          projectId: project.id,
          projectTempNo: project.tempNo,
          region: this.regionKey(project),
          registeredAt: item.registeredAt,
          month: toMonthKey(item.registeredAt),
          partStatus: item.partStatus,
          partAmountCents: item.partAmountCents,
          partCurrency: item.partCurrency,
          usedPartUsdCents,
          contractAmountCents,
          ratioPercentHundredths: ratio?.hundredths ?? null,
          ratioUnavailable: ratio === null,
          ratioOverHundred: ratio !== null && ratio.isOverHundred,
          operatorAccountId: item.operatorAccountId,
          operatorUsername: item.operatorUsername,
          cancelled: project.status === 'cancelled',
        };
      });
  }

  /** 仅「已使用」备件计入维修费用；RMB 按固定汇率折算 USD（TBD-13）。 */
  private usedPartUsdCents(
    partStatus: PartStatus | null,
    partAmountCents: bigint,
    partCurrency: PartCurrency,
  ): bigint {
    if (partStatus !== 'used') return 0n;
    const money = Money.fromCents(partAmountCents);
    return partCurrency === 'RMB' ? money.toUsd().cents : money.cents;
  }

  /** 单条事项合同占比；合同金额为空或 0 时不可计算（返回 null）。 */
  private partRatio(
    usedPartUsdCents: bigint,
    contractAmountCents: bigint | null,
  ): Ratio | null {
    if (contractAmountCents === null || contractAmountCents <= 0n) return null;
    return Ratio.of(Money.fromCents(usedPartUsdCents), Money.fromCents(contractAmountCents));
  }

  // ---- 7.6 月度物流费用汇总与合同占比、待补清单 ----

  private filterLogisticsDetails(all: ReportingFactReader, f: NormalizedFilter): LogisticsAggDetail[] {
    const batchesById = new Map(all.listBatches().map((b) => [b.id, b]));
    const projectsById = new Map(all.listProjects().map((p) => [p.id, p]));
    return all
      .listLogisticsFees()
      .map((fee) => {
        const batch = batchesById.get(fee.batchId);
        const project = batch ? projectsById.get(batch.projectId) : undefined;
        return { fee, batch, project };
      })
      .filter((x): x is {
        fee: LogisticsFee & {
          appliedAt: BusinessDate;
          budgetPriceCents: bigint;
          dealPriceCents: bigint;
          logisticsCostCents: bigint;
        };
        batch: NonNullable<(typeof x)['batch']>;
        project: Project;
      } =>
        x.batch !== undefined &&
        x.project !== undefined &&
        // 部分费用 null-safe：仅完整费用记录（申请时间 + 三金额均非空）进入原有汇总，
        // 缺失字段绝不当 0 或字符串 null 参与统计（历史完整记录结果不变）。
        x.fee.appliedAt !== null &&
        x.fee.budgetPriceCents !== null &&
        x.fee.dealPriceCents !== null &&
        x.fee.logisticsCostCents !== null,
      )
      .filter((x) => this.projectInScope(x.project.id, f))
      .filter((x) => this.regionMatch(x.project, f))
      .filter((x) => f.transportCompany === null || (x.batch.transportCompany?.trim() ?? '') === f.transportCompany.trim())
      .filter((x) => this.inRange(toMonthKey(x.fee.appliedAt), f))
      .map((x) => ({
        month: toMonthKey(x.fee.appliedAt),
        feeId: x.fee.id,
        batchId: x.batch.id,
        projectId: x.project.id,
        projectTempNo: x.project.tempNo,
        transportCompany: x.batch.transportCompany,
        appliedAt: x.fee.appliedAt,
        budgetPriceCents: x.fee.budgetPriceCents,
        dealPriceCents: x.fee.dealPriceCents,
        costCents: x.fee.logisticsCostCents,
        dealOverBudget: x.fee.dealPriceCents > x.fee.budgetPriceCents,
        cancelled: x.project.status === 'cancelled',
      }));
  }

  private logisticsDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    return this.filterLogisticsDetails(all, f);
  }

  /** 物流费用合同占比：实际费用（RMB ÷ 7.2 → USD）÷ 最新合同 USD 含税金额。 */
  private logisticsRatios(all: ReportingFactReader, f: NormalizedFilter): LogisticsRatioRow[] {
    const contractsByProject = new Map(all.listContracts().map((c) => [c.projectId, c]));
    const rows = this.filterLogisticsDetails(all, f);
    const groups = new Map<string, { costCents: bigint; projectTempNo: string; cancelled: boolean }>();
    for (const row of rows) {
      const key = `${row.projectId}\u0000${row.month}`;
      const g = groups.get(key) ?? { costCents: 0n, projectTempNo: row.projectTempNo, cancelled: row.cancelled };
      g.costCents += row.costCents;
      g.cancelled = g.cancelled || row.cancelled;
      groups.set(key, g);
    }
    return [...groups.entries()]
      .sort()
      .map(([key, g]) => {
        const [projectId, month] = key.split('\u0000');
        const costUsdCents = Money.fromCents(g.costCents).toUsd().cents;
        const contractAmountCents = contractsByProject.get(projectId)?.usdTaxAmountCents ?? null;
        const ratio =
          contractAmountCents !== null && contractAmountCents > 0n
            ? Ratio.of(Money.fromCents(costUsdCents), Money.fromCents(contractAmountCents))
            : null;
        return {
          projectId,
          projectTempNo: g.projectTempNo,
          month,
          costUsdCents,
          contractAmountCents,
          ratioPercentHundredths: ratio?.hundredths ?? null,
          ratioUnavailable: ratio === null,
          cancelled: g.cancelled,
        };
      });
  }

  /** 待补实际费用清单：已有成交价格（折后价）但无物流费用记录的批次；已取消项目排除。 */
  private pendingLogistics(all: ReportingFactReader, f: NormalizedFilter): PendingLogisticsRow[] {
    const projectsById = new Map(all.listProjects().map((p) => [p.id, p]));
    const feeBatchIds = new Set(all.listLogisticsFees().map((fee) => fee.batchId));
    return all
      .listBatches()
      .filter((b) => b.discountedPriceCents !== null) // 已有成交价格
      .filter((b) => !feeBatchIds.has(b.id)) // 尚未登记实际物流费用
      .map((b) => ({ batch: b, project: projectsById.get(b.projectId) }))
      .filter((x): x is { batch: (typeof x)['batch']; project: Project } => x.project !== undefined)
      .filter((x) => x.project.status !== 'cancelled') // 已取消项目排除（不进入清单）
      .filter((x) => this.projectInScope(x.project.id, f))
      .filter((x) => this.regionMatch(x.project, f))
      .filter(
        (x) =>
          f.transportCompany === null ||
          (x.batch.transportCompany?.trim() ?? '') === f.transportCompany.trim(),
      )
      .map((x) => ({
        batchId: x.batch.id,
        projectId: x.project.id,
        projectTempNo: x.project.tempNo,
        transportCompany: x.batch.transportCompany,
        planTransportDate: x.batch.planTransportDate,
        dealPriceCents: x.batch.discountedPriceCents,
      }));
  }

  // ---- 7.7 工作量：Ship-to 申请 / 二维码申请 / 序列号地址更新 ----

  private shipToWorkloadRows(all: ReportingFactReader, f: NormalizedFilter): ShipToWorkloadRow[] {
    if (this.tagFiltering(f)) return [];
    const counts = new Map<string, number>();
    for (const request of all.listShipToRequests()) {
      if (request.submittedAt === null) continue; // 待提交草稿不计
      if (!this.inRange(toMonthKey(request.submittedAt), f)) continue;
      if (!this.operatorMatch(request.operatorUsername, f)) continue;
      const key = `${toMonthKey(request.submittedAt)}\u0000${operatorKey(request.operatorAccountId, request.operatorUsername)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort()
      .map(([key, count]) => {
        const [month, accountId, username] = key.split('\u0000');
        return {
          month,
          operatorAccountId: accountId === '' ? null : accountId,
          operatorUsername: username === '' ? null : username,
          count,
        };
      });
  }

  private shipToDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    if (this.tagFiltering(f)) return [];
    return all
      .listShipToRequests()
      .filter((r) => r.submittedAt !== null)
      .filter((r) => this.inRange(toMonthKey(r.submittedAt!), f))
      .filter((r) => this.operatorMatch(r.operatorUsername, f))
      .map((r) => ({
        month: toMonthKey(r.submittedAt!),
        requestId: r.id,
        customerName: r.customerName,
        submittedAt: r.submittedAt!,
        operatorAccountId: r.operatorAccountId,
        operatorUsername: r.operatorUsername,
      }));
  }

  private qrWorkloadRows(all: ReportingFactReader, f: NormalizedFilter): QrWorkloadRow[] {
    if (this.tagFiltering(f)) return [];
    const counts = new Map<string, number>();
    for (const request of all.listQrRequests()) {
      if (!this.inRange(toMonthKey(request.requestedAt), f)) continue;
      if (!this.operatorMatch(request.operatorUsername, f)) continue;
      for (const typeCode of new Set(request.types)) {
        const key = `${toMonthKey(request.requestedAt)}\u0000${typeCode}\u0000${operatorKey(request.operatorAccountId, request.operatorUsername)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort()
      .map(([key, count]) => {
        const [month, typeCode, accountId, username] = key.split('\u0000');
        return {
          month,
          typeCode: typeCode as QrRequestTypeCode,
          operatorAccountId: accountId === '' ? null : accountId,
          operatorUsername: username === '' ? null : username,
          count,
        };
      });
  }

  private qrDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    if (this.tagFiltering(f)) return [];
    return all
      .listQrRequests()
      .filter((r) => this.inRange(toMonthKey(r.requestedAt), f))
      .filter((r) => this.operatorMatch(r.operatorUsername, f))
      .flatMap((r) =>
        new Set(r.types).size === 0
          ? []
          : [...new Set(r.types)].map((typeCode) => ({
              month: toMonthKey(r.requestedAt),
              requestId: r.id,
              applicant: r.applicant,
              requestedAt: r.requestedAt,
              typeCode,
              operatorAccountId: r.operatorAccountId,
              operatorUsername: r.operatorUsername,
            })),
      );
  }

  private serialUpdateRows(all: ReportingFactReader, f: NormalizedFilter): SerialAddressUpdateRow[] {
    if (this.tagFiltering(f)) return [];
    const counts = new Map<string, number>();
    for (const update of all.listSerialAddressUpdates()) {
      if (!this.inRange(toMonthKey(update.updatedAt), f)) continue;
      if (!this.operatorMatch(update.operatorUsername, f)) continue;
      const key = `${toMonthKey(update.updatedAt)}\u0000${update.customerName}\u0000${operatorKey(update.operatorAccountId, update.operatorUsername)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort()
      .map(([key, count]) => {
        const [month, customerName, accountId, username] = key.split('\u0000');
        return {
          month,
          customerName,
          operatorAccountId: accountId === '' ? null : accountId,
          operatorUsername: username === '' ? null : username,
          count,
        };
      });
  }

  private serialDetailRows(all: ReportingFactReader, f: NormalizedFilter): MetricDetailRow[] {
    if (this.tagFiltering(f)) return [];
    return all
      .listSerialAddressUpdates()
      .filter((u) => this.inRange(toMonthKey(u.updatedAt), f))
      .filter((u) => this.operatorMatch(u.operatorUsername, f))
      .map((u) => ({
        month: toMonthKey(u.updatedAt),
        updateId: u.id,
        customerName: u.customerName,
        updatedAt: u.updatedAt,
        serialNo: u.serialNo,
        operatorAccountId: u.operatorAccountId,
        operatorUsername: u.operatorUsername,
      }));
  }

  // ---- 7.9 项目管道（当前状态快照，已取消排除） ----

  private pipelineRows(all: ReportingFactReader, f: NormalizedFilter): ProjectPipelineRow[] {
    const counts = new Map<ProjectStatusOrCancelled, number>();
    for (const project of all.listProjects()) {
      if (project.status === 'cancelled') continue; // 已取消排除（7.9）
      if (!this.projectInScope(project.id, f)) continue;
      if (!this.regionMatch(project, f)) continue;
      counts.set(project.status, (counts.get(project.status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([status, projectCount]) => ({ status, projectCount }));
  }

  // ---- 内部辅助 ----

  private assertFilter(filter: ReportFilter): void {
    if (!MONTH_PATTERN.test(filter.monthFrom) || !MONTH_PATTERN.test(filter.monthTo)) {
      throw new ValidationError(
        'INVALID_MONTH_RANGE',
        '月份区间必填且格式为 yyyy-mm（无默认季度，由负责人手工选择）',
      );
    }
    if (filter.monthFrom > filter.monthTo) {
      throw new ValidationError(
        'INVALID_MONTH_RANGE',
        '月份区间起始不得晚于截止',
      );
    }
  }

  private normalizeFilter(filter: ReportFilter): NormalizedFilter {
    return {
      monthFrom: filter.monthFrom,
      monthTo: filter.monthTo,
      region: filter.region && filter.region.trim() !== '' ? filter.region.trim() : null,
      orderType: filter.orderType ?? null,
      transportCompany:
        filter.transportCompany && filter.transportCompany.trim() !== ''
          ? filter.transportCompany.trim()
          : null,
      engineer: filter.engineer && filter.engineer.trim() !== '' ? filter.engineer.trim() : null,
      operator: filter.operator && filter.operator.trim() !== '' ? filter.operator.trim() : null,
      tagIds: [...new Set(filter.tagIds ?? [])],
      matchingProjectIds: null,
    };
  }

  /** 一次读取关联构造唯一项目范围，避免多标签项目在任一事实聚合中重复计数。 */
  private scopedFilter(all: ReportingFactReader, filter: ReportFilter): NormalizedFilter {
    const f = this.normalizeFilter(filter);
    if (!this.tagFiltering(f)) return f;
    const assignments = all.listProjectTagAssignments?.() ?? [];
    const known = new Set(all.listProjectTagIds?.() ?? assignments.map((assignment) => assignment.tagId));
    for (const tagId of f.tagIds) {
      if (!known.has(tagId)) {
        throw new ValidationError('UNKNOWN_PROJECT_TAG_ID', `UNKNOWN_PROJECT_TAG_ID: ${tagId}`);
      }
    }
    const selected = new Set(f.tagIds);
    f.matchingProjectIds = new Set(
      assignments.filter((assignment) => selected.has(assignment.tagId)).map((assignment) => assignment.projectId),
    );
    return f;
  }

  private tagFiltering(f: NormalizedFilter): boolean {
    return f.tagIds.length > 0;
  }

  private projectInScope(projectId: string, f: NormalizedFilter): boolean {
    return f.matchingProjectIds === null || f.matchingProjectIds.has(projectId);
  }

  /**
   * 区域分组键（读取/报表消费口径，tasks 2.4）：空 → 无区域分组；
   * 五个枚举 → 规范化原值；存量非枚举非空文本 → 「待调整」独立分组
   * （不猜测映射、不置空、不丢弃，区域修改后实时重算）。
   */
  private regionKey(project: Project): string {
    return regionGroupKey(project.region);
  }

  private regionMatch(project: Project, f: NormalizedFilter): boolean {
    if (f.region === null) return true;
    return normalizeRegion(project.region ?? '') === f.region;
  }

  /** 责任人筛选：按动作记录持久化的用户名快照（trim 后精确匹配）。 */
  private operatorMatch(username: string | null, f: NormalizedFilter): boolean {
    if (f.operator === null) return true;
    return (username ?? '').trim() === f.operator;
  }

  private inRange(month: string, f: NormalizedFilter): boolean {
    return month >= f.monthFrom && month <= f.monthTo;
  }

  private now(): string {
    return this.clock.nowIso();
  }
}

// ---------------------------------------------------------------------------
// 聚合（从明细聚合，保证明细口径与指标口径一致）
// ---------------------------------------------------------------------------

interface InvoiceAggDetail {
  month: MonthKey;
  invoiceId: string;
  projectId: string;
  projectTempNo: string;
  region: string;
  invoicedAt: BusinessDate;
  amountCents: bigint;
}

function aggregateInvoices(details: InvoiceAggDetail[]): MonthlyInvoiceRow[] {
  const groups = new Map<string, { amountCents: bigint; count: number }>();
  for (const d of details) {
    const g = groups.get(d.month) ?? { amountCents: 0n, count: 0 };
    g.amountCents += d.amountCents;
    g.count += 1;
    groups.set(d.month, g);
  }
  return [...groups.entries()]
    .sort()
    .map(([month, g]) => ({ month, amountCents: g.amountCents, count: g.count }));
}

interface OrderAggDetail {
  month: MonthKey;
  orderId: string;
  orderType: OrderType;
  serviceOrderNo: string | null;
  orderedAt: BusinessDate;
  engineer: string | null;
  region: string | null;
}

function aggregateOrders(details: OrderAggDetail[]): ServiceOrderCountRow[] {
  const groups = new Map<string, { seen: Set<string> }>();
  for (const d of details) {
    const key = `${d.month}\u0000${d.orderType}`;
    const g = groups.get(key) ?? { seen: new Set<string>() };
    g.seen.add(d.serviceOrderNo ?? d.orderId); // 同一服务单号只计一次（null 单号按记录计）
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort()
    .map(([key, g]) => {
      const [month, orderType] = key.split('\u0000');
      return { month, orderType: orderType as OrderType, count: g.seen.size };
    });
}

function aggregateDamages(details: DamageDetailRow[]): DamageSummaryRow[] {
  const groups = new Map<string, { recordCount: number; usedPartUsdCents: bigint }>();
  for (const d of details) {
    const key = `${d.month}\u0000${operatorKey(d.operatorAccountId, d.operatorUsername)}`;
    const g = groups.get(key) ?? { recordCount: 0, usedPartUsdCents: 0n };
    g.recordCount += 1;
    g.usedPartUsdCents += d.usedPartUsdCents;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort()
    .map(([key, g]) => {
      const [month, accountId, username] = key.split('\u0000');
      return {
        month,
        operatorAccountId: accountId === '' ? null : accountId,
        operatorUsername: username === '' ? null : username,
        recordCount: g.recordCount,
        usedPartUsdCents: g.usedPartUsdCents,
      };
    });
}

interface LogisticsAggDetail {
  month: MonthKey;
  feeId: string;
  batchId: string;
  projectId: string;
  projectTempNo: string;
  transportCompany: string | null;
  appliedAt: BusinessDate;
  budgetPriceCents: bigint;
  dealPriceCents: bigint;
  costCents: bigint;
  dealOverBudget: boolean;
  cancelled: boolean;
}

function aggregateLogistics(details: LogisticsAggDetail[]): LogisticsSummaryRow[] {
  const groups = new Map<
    string,
    {
      batchCount: number;
      budgetSumCents: bigint;
      dealSumCents: bigint;
      costSumCents: bigint;
      dealOverBudgetCount: number;
      cancelledBatchCount: number;
    }
  >();
  for (const d of details) {
    const company = d.transportCompany?.trim() ?? '';
    const key = `${d.month}\u0000${company}`;
    const g =
      groups.get(key) ??
      {
        batchCount: 0,
        budgetSumCents: 0n,
        dealSumCents: 0n,
        costSumCents: 0n,
        dealOverBudgetCount: 0,
        cancelledBatchCount: 0,
      };
    g.batchCount += 1;
    g.budgetSumCents += d.budgetPriceCents;
    g.dealSumCents += d.dealPriceCents;
    g.costSumCents += d.costCents;
    if (d.dealOverBudget) g.dealOverBudgetCount += 1;
    if (d.cancelled) g.cancelledBatchCount += 1;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort()
    .map(([key, g]) => {
      const [month, transportCompany] = key.split('\u0000');
      return {
        month,
        transportCompany,
        batchCount: g.batchCount,
        budgetSumCents: g.budgetSumCents,
        dealSumCents: g.dealSumCents,
        costSumCents: g.costSumCents,
        budgetDealDiffCents: g.budgetSumCents - g.dealSumCents,
        budgetCostDiffCents: g.budgetSumCents - g.costSumCents,
        dealOverBudgetCount: g.dealOverBudgetCount,
        cancelledBatchCount: g.cancelledBatchCount,
      };
    });
}

interface NormalizedFilter {
  monthFrom: string;
  monthTo: string;
  region: string | null;
  orderType: OrderType | null;
  transportCompany: string | null;
  engineer: string | null;
  operator: string | null;
  tagIds: readonly string[];
  matchingProjectIds: Set<string> | null;
}

/** 责任人分组键：账号内部 ID + 用户名快照（空值归一为空串以便分组排序）。 */
function operatorKey(accountId: string | null, username: string | null): string {
  return `${accountId ?? ''}\u0000${username ?? ''}`;
}

/** 固定汇率（1 USD = 7.2 RMB）导出为常量，供引用与测试基线。 */
export { RMB_TO_USD_RATE };
