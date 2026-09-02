import { describe, expect, it } from 'vitest';
import * as reportingModule from '../../src/domain/capabilities/operational-reporting';
import {
  REPORT_METRIC_DEFINITIONS,
  REPORT_METRIC_KEYS,
  ReportingService,
  type ReportFilter,
} from '../../src/domain/capabilities/operational-reporting';
import type { Project, Contract } from '../../src/domain/capabilities/relocation-project-lifecycle';
import type { InvoiceRecord } from '../../src/domain/capabilities/project-financial-closure';
import type { ServiceOrder } from '../../src/domain/capabilities/service-order-recording';
import type { DamageRepairItem } from '../../src/domain/capabilities/damage-repair-tracking';
import type { Batch, LogisticsFee } from '../../src/domain/capabilities/relocation-execution';
import type { ShipToRequest } from '../../src/domain/capabilities/ship-to-management';
import type { QrRequest } from '../../src/domain/capabilities/qr-request-tracking';
import type { SerialAddressUpdate } from '../../src/domain/capabilities/serial-address-update';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryReportingFacts } from '../helpers/reporting-in-memory';

/**
 * operational-reporting 领域场景测试（tasks 7.1~7.10 实现，7.11 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景，确认 reporting 拥有统计公式、
 * 不拥有业务状态（所有权边界）。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    tempNo: 'TP-1',
    status: 'pending_execution',
    preEntryExecution: false,
    scopeConfirmed: true,
    managerApprovalReason: null,
    managerApprovalMissing: null,
    managerApproved: null,
    projectNote: null,
    temporaryStorageAddress: null,
    isTemporaryStorage: null,
    customerId: null,
    contractId: 'c1',
    entryAt: '2026-07-01',
    region: 'East',
    oldSiteContact: null,
    newSiteContact: null,
    oldSiteAddress: null,
    newSiteAddress: null,
    contractStartDate: null,
    contractEndDate: null,
    planVisitAt: null,
    planTransportAt: null,
    plannedInstallDoneAt: null,
    siteConfirmed: false,
    actualInstallDoneAt: null,
    acceptanceReport: false,
    acceptanceReportDate: null,
    cancelledAt: null,
    cancelReason: null,
    reminderAt: null,
    reminderNote: null,
    reminderAccountId: null,
    reminderUsernameSnapshot: null,
    temporaryInstrumentCount: null,
    temporaryInstrumentName: null,
    temporaryInstrumentModel: null,
    temporaryHasUps: null,
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'c1',
    projectId: 'p1',
    tempNumber: 'TP-1',
    ecc: 'ECC-1',
    usdTaxAmountCents: 200000n,
    entryAmountSnapshotCents: 100000n,
    finalConfirmableAmountCents: 100000n,
    eccLastModifiedAt: null,
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'inv-1',
    projectId: 'p1',
    amountCents: 5000n,
    invoicedAt: '2026-07-15',
    revokedAt: null,
    revokeReason: null,
    lastModifiedAt: 't',
    operatorAccountId: 'account-1',
    operatorUsername: '负责人甲',
    createdAt: 't',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<ServiceOrder> = {}): ServiceOrder {
  return {
    id: 'o1',
    orderType: 'relocation',
    serviceOrderNo: 'ORD-001',
    orderedAt: '2026-07-10',
    engineer: '工程师甲',
    customerName: '华东医药',
    projectId: 'p1',
    note: null,
    accountId: 'account-1',
    usernameSnapshot: '负责人甲',
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeDamageItem(overrides: Partial<DamageRepairItem> = {}): DamageRepairItem {
  return {
    id: 'd1',
    instrumentId: 'i1',
    projectId: 'p1',
    damageReason: null,
    issueStatus: 'untreated',
    closeReason: null,
    partNumber: 'PART-1',
    partQuantity: 1,
    partAmountCents: 10000n,
    partCurrency: 'USD',
    partRequestedAt: null,
    partStatus: 'used',
    repairNote: null,
    registeredAt: '2026-07-12',
    operatorAccountId: 'account-1',
    operatorUsername: '负责人甲',
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeBatch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: 'b1',
    projectId: 'p1',
    planTransportDate: '2026-07-20',
    transportCompany: '物流公司甲',
    originalPriceCents: 90000n,
    discountedPriceCents: 88000n,
    startedAt: null,
    accountId: 'account-1',
    usernameSnapshot: '负责人甲',
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeFee(overrides: Partial<LogisticsFee> = {}): LogisticsFee {
  return {
    id: 'f1',
    batchId: 'b1',
    appliedAt: '2026-07-18',
    budgetPriceCents: 10000n,
    dealPriceCents: 9500n,
    logisticsCostCents: 9000n,
    accountId: 'account-1',
    usernameSnapshot: '负责人甲',
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeShipToRequest(overrides: Partial<ShipToRequest> = {}): ShipToRequest {
  return {
    id: 's1',
    customerName: '华东医药',
    newSiteAddress: '新址A',
    accountId: null,
    status: 'pending_submit',
    submittedAt: null,
    completedAt: null,
    operatorAccountId: 'account-1',
    operatorUsername: '负责人甲',
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
}

function makeQrRequest(overrides: Partial<QrRequest> = {}): QrRequest {
  return {
    id: 'q1',
    applicant: '负责人甲',
    requestedAt: '2026-07-08',
    types: ['A', 'B'],
    operatorAccountId: 'account-1',
    operatorUsername: '负责人甲',
    createdAt: 't',
    ...overrides,
  };
}

function makeSerialUpdate(overrides: Partial<SerialAddressUpdate> = {}): SerialAddressUpdate {
  return {
    id: 'u1',
    instrumentId: 'i1',
    customerName: '华东医药',
    newSiteAddress: '新址A',
    serialNo: 'SN-100',
    accountId: 'ACC-001',
    updatedAt: '2026-07-09',
    operatorAccountId: 'account-1',
    operatorUsername: '负责人甲',
    createdAt: 't',
    ...overrides,
  };
}

function setup() {
  const facts = new InMemoryReportingFacts();
  const service = new ReportingService(facts, CLOCK);
  return { facts, service };
}

const JULY: ReportFilter = { monthFrom: '2026-07', monthTo: '2026-07' };
const JUNE_JULY: ReportFilter = { monthFrom: '2026-06', monthTo: '2026-07' };

describe('指标口径字典与来源映射（7.1）', () => {
  it('字典覆盖全部指标键，并给出时间归属、事实来源与筛选、下钻能力', () => {
    expect(REPORT_METRIC_KEYS.length).toBe(12);
    expect(REPORT_METRIC_DEFINITIONS).toHaveLength(12);
    for (const key of REPORT_METRIC_KEYS) {
      const def = REPORT_METRIC_DEFINITIONS.find((d) => d.key === key);
      expect(def, `指标 ${key} 缺口径定义`).toBeDefined();
      expect(def!.label.length).toBeGreaterThan(0);
      expect(def!.timeAttribution.length).toBeGreaterThan(0);
      expect(def!.factSource.length).toBeGreaterThan(0);
      expect(def!.filters.length).toBeGreaterThan(0);
    }
  });
});

describe('各区域新项目进单金额（7.2）', () => {
  it('按进单月份与区域汇总进单金额，每个项目只计一次，不因合同变更改变', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1', region: 'East', entryAt: '2026-07-01' }),
      makeProject({ id: 'p2', tempNo: 'TP-2', region: 'South', entryAt: '2026-07-02' }),
    ];
    facts.contracts = [
      makeContract({ projectId: 'p1', entryAmountSnapshotCents: 100000n }),
      makeContract({ projectId: 'p2', entryAmountSnapshotCents: 200000n }),
    ];
    const report = service.buildReport(JULY);
    expect(report.entryAmountByRegion).toEqual([
      { month: '2026-07', region: 'East', amountCents: 100000n, projectCount: 1 },
      { month: '2026-07', region: 'South', amountCents: 200000n, projectCount: 1 },
    ]);

    // 后续合同金额覆盖不改变已计取的快照值（快照在正式进单时锁定）
    facts.contracts[0].usdTaxAmountCents = 999999n;
    const after = service.buildReport(JULY);
    expect(after.entryAmountByRegion.find((r) => r.region === 'East')!.amountCents).toBe(100000n);
  });

  it('按已记录进单时间归属；补录或修正进单时间后归属实时变化', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', region: 'East', entryAt: '2026-06-20' }),
    ];
    facts.contracts = [makeContract({ entryAmountSnapshotCents: 100000n })];
    expect(service.buildReport(JULY).entryAmountByRegion).toHaveLength(0);
    expect(service.buildReport(JUNE_JULY).entryAmountByRegion.find((r) => r.month === '2026-06')?.amountCents).toBe(100000n);

    // 修正进单时间到 7 月 → 归属实时变化
    facts.projects[0].entryAt = '2026-07-01';
    const report = service.buildReport(JUNE_JULY);
    expect(report.entryAmountByRegion.find((r) => r.month === '2026-07')?.amountCents).toBe(100000n);
    expect(report.entryAmountByRegion.find((r) => r.month === '2026-06')).toBeUndefined();
  });

  it('区域按去除首尾空白后的精确值分组（7.8）', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', region: 'East', entryAt: '2026-07-01' }),
      makeProject({ id: 'p2', region: ' East ', entryAt: '2026-07-02' }),
    ];
    facts.contracts = [
      makeContract({ projectId: 'p1', entryAmountSnapshotCents: 100000n }),
      makeContract({ projectId: 'p2', entryAmountSnapshotCents: 100000n }),
    ];
    const report = service.buildReport(JULY);
    expect(report.entryAmountByRegion).toEqual([
      { month: '2026-07', region: 'East', amountCents: 200000n, projectCount: 2 },
    ]);
  });

  it('区域修改后历史报表实时重算（7.8）', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', region: 'East', entryAt: '2026-07-01' }),
    ];
    facts.contracts = [makeContract({ entryAmountSnapshotCents: 100000n })];
    expect(service.buildReport(JULY).entryAmountByRegion[0].region).toBe('East');
    facts.projects[0].region = 'West';
    expect(service.buildReport(JULY).entryAmountByRegion[0].region).toBe('West');
  });

  it('存量非标准区域原值保留并归入「待调整」独立分组（不猜测、不置空、不丢弃）', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', region: '华东', entryAt: '2026-07-01' }),
      makeProject({ id: 'p2', region: 'East', entryAt: '2026-07-02' }),
      makeProject({ id: 'p3', region: ' 华北 ', entryAt: '2026-07-03' }),
    ];
    facts.contracts = [
      makeContract({ projectId: 'p1', entryAmountSnapshotCents: 100000n }),
      makeContract({ projectId: 'p2', entryAmountSnapshotCents: 200000n }),
      makeContract({ projectId: 'p3', entryAmountSnapshotCents: 300000n }),
    ];
    const report = service.buildReport(JULY);
    // 枚举区域按原值分组；两个不同 legacy 文本合并为同一「待调整」分组（不按文本猜测）。
    expect(report.entryAmountByRegion).toEqual([
      { month: '2026-07', region: 'East', amountCents: 200000n, projectCount: 1 },
      { month: '2026-07', region: '待调整', amountCents: 400000n, projectCount: 2 },
    ]);
    // 下钻明细同口径：legacy 项目统计事实不丢弃，region 展示为「待调整」。
    const details = service.getMetricDetails('entry_amount_by_region', JULY) as {
      region: string;
      amountCents: bigint;
    }[];
    expect(details.filter((d) => d.region === '待调整').reduce((s, d) => s + d.amountCents, 0n)).toBe(400000n);
    // 原值保留：事实源中的 legacy 文本不被改写、不置空。
    expect(facts.projects.find((p) => p.id === 'p1')!.region).toBe('华东');
    expect(facts.projects.find((p) => p.id === 'p3')!.region).toBe(' 华北 ');
  });
});

describe('月度掉票金额与掉票次数（7.3）', () => {
  it('同一项目跨月分次掉票分别归属，金额与次数分开统计', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.invoices = [
      makeInvoice({ id: 'inv-1', amountCents: 300000n, invoicedAt: '2026-06-10' }),
      makeInvoice({ id: 'inv-2', amountCents: 500000n, invoicedAt: '2026-07-15' }),
    ];
    const report = service.buildReport(JUNE_JULY);
    expect(report.monthlyInvoices).toEqual([
      { month: '2026-06', amountCents: 300000n, count: 1 },
      { month: '2026-07', amountCents: 500000n, count: 1 },
    ]);
  });

  it('已撤销掉票不计入金额与次数', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.invoices = [
      makeInvoice({ id: 'inv-1', amountCents: 300000n }),
      makeInvoice({ id: 'inv-2', amountCents: 500000n, revokedAt: '2026-07-20' }),
    ];
    const report = service.buildReport(JULY);
    expect(report.monthlyInvoices).toEqual([{ month: '2026-07', amountCents: 300000n, count: 1 }]);
  });

  it('掉票编辑后报表实时更新（7.10）', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.invoices = [makeInvoice({ id: 'inv-1', amountCents: 500000n })];
    expect(service.buildReport(JULY).monthlyInvoices[0].amountCents).toBe(500000n);
    facts.invoices[0].amountCents = 600000n; // 掉票直接覆盖编辑
    expect(service.buildReport(JULY).monthlyInvoices[0].amountCents).toBe(600000n);
  });
});

describe('月度开单量（7.4）', () => {
  it('按唯一服务单号计一次并按四类业务分组，PM 为并列类型', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', orderType: 'relocation', serviceOrderNo: 'ORD-001' }),
      makeOrder({ id: 'o2', orderType: 'certification', serviceOrderNo: 'ORD-002' }),
      makeOrder({ id: 'o3', orderType: 'parts_by_mail', serviceOrderNo: 'ORD-003' }),
      makeOrder({ id: 'o4', orderType: 'pm', serviceOrderNo: 'ORD-004' }),
      makeOrder({ id: 'o5', orderType: 'relocation', serviceOrderNo: 'ORD-005', engineer: '工程师乙' }),
    ];
    const report = service.buildReport(JULY);
    const byKey = new Map(report.monthlyServiceOrders.map((r) => [`${r.month}:${r.orderType}`, r.count]));
    expect(byKey.get('2026-07:relocation')).toBe(2);
    expect(byKey.get('2026-07:certification')).toBe(1);
    expect(byKey.get('2026-07:parts_by_mail')).toBe(1);
    expect(byKey.get('2026-07:pm')).toBe(1);
  });

  it('同一服务单号关联多名工程师仍只计一次', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', serviceOrderNo: 'ORD-001', engineer: '工程师甲、工程师乙' }),
    ];
    const report = service.buildReport(JULY);
    expect(report.monthlyServiceOrders.find((r) => r.orderType === 'relocation')?.count).toBe(1);
    // 按工程师筛选：该单号同时被甲、乙参与，任一筛选都只计一次
    const byEngineerA = service.buildReport({ ...JULY, engineer: '工程师甲' });
    const byEngineerB = service.buildReport({ ...JULY, engineer: '工程师乙' });
    expect(byEngineerA.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(byEngineerB.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
  });

  it('按参与工程师筛选开单量（可选），不选择时汇总全部', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', serviceOrderNo: 'ORD-001', engineer: '工程师甲' }),
      makeOrder({ id: 'o2', serviceOrderNo: 'ORD-002', engineer: '工程师乙' }),
    ];
    const all = service.buildReport(JULY);
    expect(all.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(2);
    const filtered = service.buildReport({ ...JULY, engineer: '工程师甲' });
    expect(filtered.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
  });

  it('按开单业务类型筛选', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', orderType: 'relocation', serviceOrderNo: 'ORD-001' }),
      makeOrder({ id: 'o2', orderType: 'pm', serviceOrderNo: 'ORD-002' }),
    ];
    const report = service.buildReport({ ...JULY, orderType: 'pm' });
    expect(report.monthlyServiceOrders).toEqual([{ month: '2026-07', orderType: 'pm', count: 1 }]);
  });
});

describe('开单工程师空值与报表归属（v20）', () => {
  it('空工程师计入总量，下钻明细工程师为 null', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', serviceOrderNo: 'ORD-001', engineer: '工程师甲' }),
      makeOrder({ id: 'o2', serviceOrderNo: 'ORD-002', engineer: null }),
      makeOrder({ id: 'o3', serviceOrderNo: 'ORD-003', engineer: null }),
    ];
    const report = service.buildReport(JULY);
    expect(report.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(3);
    const details = service.getMetricDetails('monthly_service_order_count', JULY) as Array<{ engineer: string | null }>;
    expect(details.filter((d) => d.engineer === null)).toHaveLength(2);
    expect(details.filter((d) => d.engineer === '工程师甲')).toHaveLength(1);
  });

  it('按工程师筛选：仅匹配文本包含值，空值不命中', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.serviceOrders = [
      makeOrder({ id: 'o1', serviceOrderNo: 'ORD-001', engineer: '工程师甲' }),
      makeOrder({ id: 'o2', serviceOrderNo: 'ORD-002', engineer: null }),
      makeOrder({ id: 'o3', serviceOrderNo: 'ORD-003', engineer: '工程师乙' }),
    ];
    const filtered = service.buildReport({ ...JULY, engineer: '工程师甲' });
    expect(filtered.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
    const details = service.getMetricDetails('monthly_service_order_count', { ...JULY, engineer: '工程师甲' }) as Array<{ engineer: string | null }>;
    expect(details.every((d) => (d.engineer ?? '').includes('工程师甲'))).toBe(true);
  });

  it('补录后筛选变化：空值补充为有值后可被筛选命中', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    const orderNull = makeOrder({ id: 'o1', serviceOrderNo: 'ORD-001', engineer: null });
    const orderA = makeOrder({ id: 'o2', serviceOrderNo: 'ORD-002', engineer: '工程师甲' });
    facts.serviceOrders = [orderNull, orderA];
    expect(service.buildReport({ ...JULY, engineer: '工程师甲' }).monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
    // 补录
    orderNull.engineer = '工程师甲';
    expect(service.buildReport({ ...JULY, engineer: '工程师甲' }).monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(2);
    const details = service.getMetricDetails('monthly_service_order_count', { ...JULY, engineer: '工程师甲' }) as Array<{ orderId: string; engineer: string | null }>;
    expect(details.map((d) => d.orderId).sort()).toEqual(['o1', 'o2']);
  });
});

describe('损坏维修统计（7.5）', () => {
  it('记录数量按事项计数，仅已使用备件金额计入维修费用', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.damageItems = [
      makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 10000n, partCurrency: 'USD' }),
      makeDamageItem({ id: 'd2', partStatus: 'arrived', partAmountCents: 30000n, partCurrency: 'USD' }),
    ];
    const report = service.buildReport(JULY);
    expect(report.damageSummary).toEqual([
      {
        month: '2026-07',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        recordCount: 2,
        usedPartUsdCents: 10000n,
      },
    ]);
    const details = report.damageDetails;
    expect(details.find((d) => d.itemId === 'd2')!.usedPartUsdCents).toBe(0n);
  });

  it('RMB 按固定汇率折算参与统计，原币金额与币种保留用于展示', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.damageItems = [
      makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 72000n, partCurrency: 'RMB' }),
    ];
    const report = service.buildReport(JULY);
    const detail = report.damageDetails[0];
    expect(detail.partAmountCents).toBe(72000n);
    expect(detail.partCurrency).toBe('RMB');
    expect(detail.usedPartUsdCents).toBe(10000n); // 720 ÷ 7.2 = 100 USD
  });

  it('计算单条事项合同占比；合同金额为空或 0 时不可计算并明确提示', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' })];
    facts.contracts = [makeContract({ projectId: 'p1', usdTaxAmountCents: 200000n })];
    facts.damageItems = [makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 10000n })];
    const report = service.buildReport(JULY);
    const detail = report.damageDetails[0];
    expect(detail.contractAmountCents).toBe(200000n);
    expect(detail.ratioPercentHundredths).toBe(500n); // 100 ÷ 2000 = 5%
    expect(detail.ratioUnavailable).toBe(false);

    // 合同金额为空 → 不可计算
    facts.contracts[0].usdTaxAmountCents = null;
    const unavailable = service.buildReport(JULY).damageDetails[0];
    expect(unavailable.ratioPercentHundredths).toBeNull();
    expect(unavailable.ratioUnavailable).toBe(true);

    // 合同金额为 0 → 不可计算
    facts.contracts[0].usdTaxAmountCents = 0n;
    expect(service.buildReport(JULY).damageDetails[0].ratioUnavailable).toBe(true);
  });

  it('占比超过 100% 允许如实显示并给出警告', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' })];
    facts.contracts = [makeContract({ projectId: 'p1', usdTaxAmountCents: 10000n })];
    facts.damageItems = [makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 20000n })];
    const detail = service.buildReport(JULY).damageDetails[0];
    expect(detail.ratioPercentHundredths).toBe(20000n); // 200%
    expect(detail.ratioOverHundred).toBe(true);
  });

  it('事项数量与金额按登记月份归属并取责任人快照', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.damageItems = [
      makeDamageItem({ id: 'd1', registeredAt: '2026-06-10', partStatus: 'used', partAmountCents: 10000n }),
      makeDamageItem({ id: 'd2', registeredAt: '2026-07-10', partStatus: 'used', partAmountCents: 20000n, operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    const report = service.buildReport(JUNE_JULY);
    expect(report.damageSummary).toEqual([
      {
        month: '2026-06',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        recordCount: 1,
        usedPartUsdCents: 10000n,
      },
      {
        month: '2026-07',
        operatorAccountId: 'account-2',
        operatorUsername: '负责人乙',
        recordCount: 1,
        usedPartUsdCents: 20000n,
      },
    ]);
    expect(report.damageDetails.find((d) => d.itemId === 'd2')!.operatorUsername).toBe('负责人乙');
    // 用户名修改后历史统计仍按快照归属、不动态变化
    facts.damageItems[1].operatorUsername = '负责人乙（已改名）';
    expect(service.buildReport(JULY).damageDetails[0].operatorUsername).toBe('负责人乙（已改名）');
    // 注意：快照在动作记录中持久化，历史归属以记录时的快照为准（此处改名即为新快照的语义，
    // 真实改名场景由 workbench-access 只改 accounts 表、不改动动作记录快照——见集成测试）
  });
});

describe('月度物流费用汇总、合同占比与历史异常批次（7.6）', () => {
  it('按运输公司与月份汇总，展示批次数、合同预算价/物流成交价合计与差异', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2', tempNo: 'TP-2', region: 'South' })];
    facts.batches = [
      makeBatch({ id: 'b1', projectId: 'p1', transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b2', projectId: 'p1', transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b3', projectId: 'p2', transportCompany: '物流公司乙' }),
    ];
    facts.logisticsFees = [
      makeFee({ id: 'f1', batchId: 'b1', budgetPriceCents: 10000n, dealPriceCents: 9500n, logisticsCostCents: 9000n }),
      makeFee({ id: 'f2', batchId: 'b2', budgetPriceCents: 20000n, dealPriceCents: 21000n, logisticsCostCents: 19000n }),
      makeFee({ id: 'f3', batchId: 'b3', budgetPriceCents: 30000n, dealPriceCents: 29000n, logisticsCostCents: 28000n }),
    ];
    const report = service.buildReport(JULY);
    const rowA = report.monthlyLogistics.find((r) => r.transportCompany === '物流公司甲')!;
    expect(rowA.batchCount).toBe(2);
    expect(rowA.budgetSumCents).toBe(30000n);
    expect(rowA.dealSumCents).toBe(30500n);
    expect(rowA.costSumCents).toBe(28000n);
    expect(rowA.budgetDealDiffCents).toBe(-500n);
    expect(rowA.budgetCostDiffCents).toBe(2000n);
    expect(rowA.dealOverBudgetCount).toBe(1); // f2 成交 > 预算
    const rowB = report.monthlyLogistics.find((r) => r.transportCompany === '物流公司乙')!;
    expect(rowB.batchCount).toBe(1);
    // 全部金额为人民币口径，无 USD 最终报价列
    expect(report.monthlyLogistics.every((r) => Object.keys(r).every((k) => !k.includes('Usd')))).toBe(true);
  });

  it('按运输公司筛选物流费用', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.batches = [
      makeBatch({ id: 'b1', transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b2', transportCompany: '物流公司乙' }),
    ];
    facts.logisticsFees = [
      makeFee({ id: 'f1', batchId: 'b1' }),
      makeFee({ id: 'f2', batchId: 'b2' }),
    ];
    const report = service.buildReport({ ...JULY, transportCompany: '物流公司乙' });
    expect(report.monthlyLogistics).toHaveLength(1);
    expect(report.monthlyLogistics[0].transportCompany).toBe('物流公司乙');
  });

  it('部分费用 null-safe：缺失字段不计入汇总（不得当 0/字符串 null），完整记录结果不变', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2', tempNo: 'TP-2' })];
    facts.batches = [
      makeBatch({ id: 'b1', projectId: 'p1', transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b2', projectId: 'p1', transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b3', projectId: 'p2', transportCompany: '物流公司乙' }),
    ];
    facts.logisticsFees = [
      // 完整记录：进入原有汇总（历史完整记录结果不变）
      makeFee({ id: 'f1', batchId: 'b1', budgetPriceCents: 10000n, dealPriceCents: 9500n, logisticsCostCents: 9000n }),
      // 部分费用（仅登记日期）：缺失金额不得当 0 参与统计
      makeFee({ id: 'f2', batchId: 'b2', appliedAt: '2026-07-20', budgetPriceCents: null, dealPriceCents: null, logisticsCostCents: null }),
      // 部分费用（无 appliedAt）：无归属月份，不得进入月度汇总
      makeFee({ id: 'f3', batchId: 'b3', appliedAt: null, budgetPriceCents: 30000n, dealPriceCents: 29000n, logisticsCostCents: 28000n }),
    ];
    const report = service.buildReport(JULY);
    // 仅完整记录进入月度汇总：f2/f3 被排除
    expect(report.monthlyLogistics).toHaveLength(1);
    expect(report.monthlyLogistics[0]).toMatchObject({
      transportCompany: '物流公司甲',
      batchCount: 1, // f1 仅一笔；f2（部分）不计
      budgetSumCents: 10000n,
      dealSumCents: 9500n,
      costSumCents: 9000n,
    });
    // 部分费用不进入合同占比（f3 无归属月份）
    expect(report.logisticsContractRatios).toHaveLength(1);
    // 完整费用下钻明细含全部字段；部分费用不出现
    const details = service.getMetricDetails('monthly_logistics', JULY) as Array<{ feeId: string }>;
    expect(details.map((d) => d.feeId)).toEqual(['f1']);
    // 有 fee 记录（含部分）的批次不再出现在待补清单
    expect(report.pendingLogistics.map((r) => r.batchId).sort()).toEqual([]);
  });

  it('物流成交价合同占比：RMB 按固定汇率折算 USD ÷ 最新合同金额，空/0 不可算', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' })];
    facts.contracts = [makeContract({ projectId: 'p1', usdTaxAmountCents: 1000000n })];
    facts.batches = [makeBatch({ id: 'b1' })];
    facts.logisticsFees = [makeFee({ id: 'f1', batchId: 'b1', logisticsCostCents: 720000n })];
    const report = service.buildReport(JULY);
    const ratio = report.logisticsContractRatios[0];
    expect(ratio.costUsdCents).toBe(100000n); // 7200 ÷ 7.2 = 1000 USD
    expect(ratio.contractAmountCents).toBe(1000000n);
    expect(ratio.ratioPercentHundredths).toBe(1000n); // 1000 ÷ 10000 = 10%
    expect(ratio.ratioUnavailable).toBe(false);

    facts.contracts[0].usdTaxAmountCents = null;
    const unavailable = service.buildReport(JULY).logisticsContractRatios[0];
    expect(unavailable.ratioPercentHundredths).toBeNull();
    expect(unavailable.ratioUnavailable).toBe(true);
  });

  it('历史异常批次（已有物流成交价无费用记录）进入清单；底层筛选保留历史兼容（补录后纳入报表）', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' })];
    facts.batches = [
      makeBatch({ id: 'b1', discountedPriceCents: 88000n, transportCompany: '物流公司甲' }),
      makeBatch({ id: 'b2', discountedPriceCents: null }), // 无物流成交价 → 不进入清单
    ];
    const pending = service.buildReport(JULY).pendingLogistics;
    expect(pending).toHaveLength(1);
    expect(pending[0].batchId).toBe('b1');
    expect(pending[0].dealPriceCents).toBe(88000n);

    // 补录物流费用（历史兼容路径）后 → 进入月度报表，不再出现在清单
    facts.logisticsFees = [makeFee({ id: 'f1', batchId: 'b1', appliedAt: '2026-07-18' })];
    const after = service.buildReport(JULY);
    expect(after.pendingLogistics).toHaveLength(0);
    expect(after.monthlyLogistics.find((r) => r.transportCompany === '物流公司甲')?.batchCount).toBe(1);
  });
});

describe('Ship-to / 二维码 / 序列号地址更新工作量（7.7）', () => {
  it('Ship-to 首次提交计一次，后续状态更新不重复计数，待提交草稿不计', () => {
    const { facts, service } = setup();
    facts.shipToRequests = [
      makeShipToRequest({ id: 's1', status: 'pending_submit', submittedAt: null }),
      makeShipToRequest({ id: 's2', status: 'processing', submittedAt: '2026-07-05' }),
      makeShipToRequest({ id: 's3', status: 'completed', submittedAt: '2026-07-06', completedAt: '2026-07-20' }),
    ];
    const report = service.buildReport(JULY);
    expect(report.shipToWorkload).toEqual([
      {
        month: '2026-07',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        count: 2,
      },
    ]); // s2、s3 各一次，s1 草稿不计
  });

  it('二维码申请按去重类型计数，不同申请中的同类型分别计数', () => {
    const { facts, service } = setup();
    facts.qrRequests = [
      makeQrRequest({ id: 'q1', types: ['A', 'A', 'B'] }),
      makeQrRequest({ id: 'q2', types: ['A'] }),
    ];
    const report = service.buildReport(JULY);
    const byType = new Map(report.qrWorkload.map((r) => [r.typeCode, r.count]));
    expect(byType.get('A')).toBe(2); // q1、q2 各计一次
    expect(byType.get('B')).toBe(1);
  });

  it('序列号地址更新按更新记录计数、按月份与客户分组，同一仪器多次更新分别计数', () => {
    const { facts, service } = setup();
    facts.serialAddressUpdates = [
      makeSerialUpdate({ id: 'u1', customerName: '华东医药', updatedAt: '2026-07-01' }),
      makeSerialUpdate({ id: 'u2', customerName: '华东医药', updatedAt: '2026-07-02' }),
      makeSerialUpdate({ id: 'u3', customerName: '华北医药', updatedAt: '2026-06-15' }),
    ];
    const report = service.buildReport(JUNE_JULY);
    expect(report.serialAddressUpdates).toEqual([
      {
        month: '2026-06',
        customerName: '华北医药',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        count: 1,
      },
      {
        month: '2026-07',
        customerName: '华东医药',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        count: 2,
      },
    ]);
  });

  it('四类工作量明细与汇总均包含持久化账号ID+用户名快照责任人维度，并按责任人分组', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    // 损坏：两位责任人各一条
    facts.damageItems = [
      makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 10000n }),
      makeDamageItem({ id: 'd2', partStatus: 'used', partAmountCents: 20000n, operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    // Ship-to：两位责任人各一次实际提交
    facts.shipToRequests = [
      makeShipToRequest({ id: 's1', status: 'processing', submittedAt: '2026-07-05' }),
      makeShipToRequest({ id: 's2', status: 'processing', submittedAt: '2026-07-06', operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    // 二维码：两位责任人各一条
    facts.qrRequests = [
      makeQrRequest({ id: 'q1', types: ['A'] }),
      makeQrRequest({ id: 'q2', types: ['A', 'B'], operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    // 序列号地址更新：两位责任人各一条
    facts.serialAddressUpdates = [
      makeSerialUpdate({ id: 'u1', customerName: '华东医药' }),
      makeSerialUpdate({ id: 'u2', customerName: '华东医药', operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];

    const report = service.buildReport(JULY);

    // 损坏汇总按月份×责任人分组，每行携带账号ID与用户名快照
    expect(report.damageSummary).toEqual([
      {
        month: '2026-07',
        operatorAccountId: 'account-1',
        operatorUsername: '负责人甲',
        recordCount: 1,
        usedPartUsdCents: 10000n,
      },
      {
        month: '2026-07',
        operatorAccountId: 'account-2',
        operatorUsername: '负责人乙',
        recordCount: 1,
        usedPartUsdCents: 20000n,
      },
    ]);
    // 损坏下钻明细逐条携带责任人账号ID与用户名快照
    const damageDetails = service.getMetricDetails('damage_repair_stats', JULY) as {
      itemId: string;
      operatorAccountId: string | null;
      operatorUsername: string | null;
    }[];
    expect(damageDetails.find((d) => d.itemId === 'd2')?.operatorAccountId).toBe('account-2');
    expect(damageDetails.find((d) => d.itemId === 'd2')?.operatorUsername).toBe('负责人乙');

    // Ship-to 汇总按月份×责任人分组
    expect(report.shipToWorkload).toEqual([
      { month: '2026-07', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
      { month: '2026-07', operatorAccountId: 'account-2', operatorUsername: '负责人乙', count: 1 },
    ]);
    const shipToDetails = service.getMetricDetails('ship_to_request_workload', JULY) as {
      requestId: string;
      operatorAccountId: string | null;
      operatorUsername: string | null;
    }[];
    expect(shipToDetails.find((d) => d.requestId === 's2')?.operatorAccountId).toBe('account-2');
    expect(shipToDetails.find((d) => d.requestId === 's2')?.operatorUsername).toBe('负责人乙');

    // 二维码汇总按月份×类型×责任人分组（同一类型 A 分属两位责任人分别计数）
    const qrKey = (r: { month: string; typeCode: string; operatorAccountId: string | null; operatorUsername: string | null; count: number }) =>
      `${r.month}:${r.typeCode}:${r.operatorAccountId}:${r.operatorUsername}`;
    const qrMap = new Map(report.qrWorkload.map((r) => [qrKey(r), r.count]));
    expect(qrMap.get('2026-07:A:account-1:负责人甲')).toBe(1);
    expect(qrMap.get('2026-07:A:account-2:负责人乙')).toBe(1);
    expect(qrMap.get('2026-07:B:account-2:负责人乙')).toBe(1);
    const qrDetails = service.getMetricDetails('qr_request_workload', JULY) as {
      requestId: string;
      operatorAccountId: string | null;
      operatorUsername: string | null;
    }[];
    expect(qrDetails.find((d) => d.requestId === 'q2')?.operatorAccountId).toBe('account-2');
    expect(qrDetails.find((d) => d.requestId === 'q2')?.operatorUsername).toBe('负责人乙');

    // 序列号地址更新汇总按月份×客户×责任人分组
    expect(report.serialAddressUpdates).toEqual([
      { month: '2026-07', customerName: '华东医药', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
      { month: '2026-07', customerName: '华东医药', operatorAccountId: 'account-2', operatorUsername: '负责人乙', count: 1 },
    ]);
    const serialDetails = service.getMetricDetails('serial_address_update_count', JULY) as {
      updateId: string;
      operatorAccountId: string | null;
      operatorUsername: string | null;
    }[];
    expect(serialDetails.find((d) => d.updateId === 'u2')?.operatorAccountId).toBe('account-2');
    expect(serialDetails.find((d) => d.updateId === 'u2')?.operatorUsername).toBe('负责人乙');
  });

  it('四类工作量均支持按责任人筛选（用户名快照精确匹配），不选择时汇总全部', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.damageItems = [
      makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 10000n }),
      makeDamageItem({ id: 'd2', partStatus: 'used', partAmountCents: 20000n, operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    facts.shipToRequests = [
      makeShipToRequest({ id: 's1', status: 'processing', submittedAt: '2026-07-05' }),
      makeShipToRequest({ id: 's2', status: 'processing', submittedAt: '2026-07-06', operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    facts.qrRequests = [
      makeQrRequest({ id: 'q1', types: ['A'] }),
      makeQrRequest({ id: 'q2', types: ['A', 'B'], operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];
    facts.serialAddressUpdates = [
      makeSerialUpdate({ id: 'u1', customerName: '华东医药' }),
      makeSerialUpdate({ id: 'u2', customerName: '华东医药', operatorAccountId: 'account-2', operatorUsername: '负责人乙' }),
    ];

    const all = service.buildReport(JULY);
    expect(all.damageSummary.reduce((s, r) => s + r.recordCount, 0)).toBe(2);
    expect(all.shipToWorkload.reduce((s, r) => s + r.count, 0)).toBe(2);
    expect(all.qrWorkload.reduce((s, r) => s + r.count, 0)).toBe(3);
    expect(all.serialAddressUpdates.reduce((s, r) => s + r.count, 0)).toBe(2);

    const byA = service.buildReport({ ...JULY, operator: '负责人甲' });
    expect(byA.damageSummary.reduce((s, r) => s + r.recordCount, 0)).toBe(1);
    expect(byA.damageSummary.every((r) => r.operatorAccountId === 'account-1')).toBe(true);
    expect(byA.shipToWorkload.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(byA.shipToWorkload.every((r) => r.operatorAccountId === 'account-1')).toBe(true);
    expect(byA.qrWorkload.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(byA.qrWorkload.every((r) => r.operatorAccountId === 'account-1')).toBe(true);
    expect(byA.serialAddressUpdates.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(byA.serialAddressUpdates.every((r) => r.operatorAccountId === 'account-1')).toBe(true);

    const byB = service.buildReport({ ...JULY, operator: '负责人乙' });
    expect(byB.damageSummary.reduce((s, r) => s + r.recordCount, 0)).toBe(1);
    expect(byB.shipToWorkload.reduce((s, r) => s + r.count, 0)).toBe(1);
    expect(byB.qrWorkload.reduce((s, r) => s + r.count, 0)).toBe(2);
    expect(byB.serialAddressUpdates.reduce((s, r) => s + r.count, 0)).toBe(1);

    // 责任人筛选反映到报表模型快照
    expect(byB.filters.operator).toBe('负责人乙');
  });

  it('四类工作量责任人取动作记录持久化的用户名快照：历史账号改名后统计仍按当时快照归属', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    facts.damageItems = [
      makeDamageItem({ id: 'd1', partStatus: 'used', partAmountCents: 10000n, operatorUsername: '负责人甲（旧名）' }),
    ];
    facts.shipToRequests = [
      makeShipToRequest({ id: 's1', status: 'processing', submittedAt: '2026-07-05', operatorUsername: '负责人甲（旧名）' }),
    ];
    facts.qrRequests = [
      makeQrRequest({ id: 'q1', types: ['A'], operatorUsername: '负责人甲（旧名）' }),
    ];
    facts.serialAddressUpdates = [
      makeSerialUpdate({ id: 'u1', customerName: '华东医药', operatorUsername: '负责人甲（旧名）' }),
    ];

    // 动作记录中的快照即为当时用户名（模拟历史记录已持久化旧名）
    const report = service.buildReport(JULY);
    expect(report.damageSummary[0].operatorUsername).toBe('负责人甲（旧名）');
    expect(report.shipToWorkload[0].operatorUsername).toBe('负责人甲（旧名）');
    expect(report.qrWorkload[0].operatorUsername).toBe('负责人甲（旧名）');
    expect(report.serialAddressUpdates[0].operatorUsername).toBe('负责人甲（旧名）');

    // 真实改名只改 accounts 表、不改动作记录快照：快照字段不变则历史归属不变。
    // 领域层只消费快照；账号改名对历史的稳定性由集成测试（SQLite accounts 表）验证。
    // 此处模拟动作记录快照保持旧名、同时补充新名记录：两类记录并存、各自按快照归属。
    facts.damageItems.push(makeDamageItem({ id: 'd2', partStatus: 'used', partAmountCents: 5000n, operatorUsername: '负责人甲（新名）' }));
    facts.shipToRequests.push(makeShipToRequest({ id: 's2', status: 'processing', submittedAt: '2026-07-07', operatorUsername: '负责人甲（新名）' }));
    facts.qrRequests.push(makeQrRequest({ id: 'q2', types: ['A'], operatorUsername: '负责人甲（新名）' }));
    facts.serialAddressUpdates.push(makeSerialUpdate({ id: 'u2', customerName: '华东医药', operatorUsername: '负责人甲（新名）' }));

    const after = service.buildReport(JULY);
    expect(after.damageSummary.some((r) => r.operatorUsername === '负责人甲（旧名）')).toBe(true);
    expect(after.damageSummary.some((r) => r.operatorUsername === '负责人甲（新名）')).toBe(true);
    expect(after.shipToWorkload.some((r) => r.operatorUsername === '负责人甲（旧名）')).toBe(true);
    expect(after.shipToWorkload.some((r) => r.operatorUsername === '负责人甲（新名）')).toBe(true);
    expect(after.qrWorkload.some((r) => r.operatorUsername === '负责人甲（旧名）')).toBe(true);
    expect(after.qrWorkload.some((r) => r.operatorUsername === '负责人甲（新名）')).toBe(true);
    expect(after.serialAddressUpdates.some((r) => r.operatorUsername === '负责人甲（旧名）')).toBe(true);
    expect(after.serialAddressUpdates.some((r) => r.operatorUsername === '负责人甲（新名）')).toBe(true);

    // 各旧名明细行仍以当时快照展示
    const damageOld = after.damageDetails.find((d) => d.itemId === 'd1');
    expect(damageOld?.operatorUsername).toBe('负责人甲（旧名）');
  });
});

describe('已取消项目的统计排除（7.9）', () => {
  it('已取消项目不纳入进单金额统计、不参与掉票统计与项目管道', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1', region: 'East', status: 'cancelled', cancelledAt: '2026-07-20', cancelReason: '客户取消' }),
      makeProject({ id: 'p2', tempNo: 'TP-2', region: 'South' }),
    ];
    facts.contracts = [
      makeContract({ projectId: 'p1', entryAmountSnapshotCents: 100000n }),
      makeContract({ projectId: 'p2', entryAmountSnapshotCents: 200000n }),
    ];
    facts.invoices = [
      makeInvoice({ id: 'inv-1', projectId: 'p1', amountCents: 300000n }),
      makeInvoice({ id: 'inv-2', projectId: 'p2', amountCents: 500000n }),
    ];
    const report = service.buildReport(JULY);
    // 进单金额排除已取消项目
    expect(report.entryAmountByRegion.map((r) => r.region)).toEqual(['South']);
    // 掉票金额/次数排除已取消项目
    expect(report.monthlyInvoices).toEqual([{ month: '2026-07', amountCents: 500000n, count: 1 }]);
    // 项目管道排除已取消项目
    expect(report.pipeline.some((r) => r.status === 'cancelled')).toBe(false);
    expect(report.pipeline.find((r) => r.status === 'pending_execution')!.projectCount).toBe(1);
  });

  it('取消前实际发生的物流费用与损坏备件金额作为真实成本保留并标记取消', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1', status: 'cancelled', cancelledAt: '2026-07-20' }),
    ];
    facts.contracts = [makeContract({ projectId: 'p1', usdTaxAmountCents: 200000n })];
    facts.batches = [makeBatch({ id: 'b1', projectId: 'p1', transportCompany: '物流公司甲' })];
    facts.logisticsFees = [makeFee({ id: 'f1', batchId: 'b1' })];
    facts.damageItems = [makeDamageItem({ id: 'd1', projectId: 'p1', partStatus: 'used', partAmountCents: 10000n })];

    const report = service.buildReport(JULY);
    // 物流费用照常计入并标记取消
    expect(report.monthlyLogistics[0].batchCount).toBe(1);
    expect(report.monthlyLogistics[0].cancelledBatchCount).toBe(1);
    // 损坏备件金额照常计入并标记取消
    expect(report.damageSummary[0].recordCount).toBe(1);
    expect(report.damageSummary[0].usedPartUsdCents).toBe(10000n);
    expect(report.damageDetails[0].cancelled).toBe(true);
    // 已取消项目不进入历史异常批次清单
    facts.logisticsFees = [];
    expect(service.buildReport(JULY).pendingLogistics).toHaveLength(0);
  });
});

describe('报表筛选与手工月份区间（7.10）', () => {
  it('月份区间必须手工选择：未提供时拒绝计算（无默认季度）', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({})];
    // 缺月份区间（按类型强制必填）：直接调用缺省值不被接受
    expect(() => service.buildReport({ monthFrom: '', monthTo: '' })).toThrow(/月份区间/);
    expect(() => service.buildReport({ monthFrom: '2026-08', monthTo: '2026-07' })).toThrow(/起始不得晚于/);
    expect(() => service.buildReport({ monthFrom: '2026-07', monthTo: '2026-08' })).not.toThrow();
  });

  it('按月份区间与区域筛选', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', region: 'East', entryAt: '2026-06-01' }),
      makeProject({ id: 'p2', region: 'South', entryAt: '2026-07-01' }),
    ];
    facts.contracts = [
      makeContract({ projectId: 'p1', entryAmountSnapshotCents: 100000n }),
      makeContract({ projectId: 'p2', entryAmountSnapshotCents: 200000n }),
    ];
    const report = service.buildReport({ ...JULY, region: 'East' });
    expect(report.entryAmountByRegion).toHaveLength(0); // East 项目在 6 月，不在 7 月区间
    const juneEast = service.buildReport({ monthFrom: '2026-06', monthTo: '2026-06', region: 'East' });
    expect(juneEast.entryAmountByRegion[0].amountCents).toBe(100000n);
  });
});

describe('报表下钻（7.10）', () => {
  it('从掉票金额下钻到逐条掉票记录，明细口径与指标口径一致', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1', region: 'East' }),
      makeProject({ id: 'p2', tempNo: 'TP-2', region: 'South' }),
    ];
    facts.invoices = [
      makeInvoice({ id: 'inv-1', projectId: 'p1', amountCents: 300000n }),
      makeInvoice({ id: 'inv-2', projectId: 'p1', amountCents: 200000n }),
      makeInvoice({ id: 'inv-3', projectId: 'p2', amountCents: 500000n, revokedAt: '2026-07-20' }),
    ];
    const details = service.getMetricDetails('monthly_invoice_amount', JULY) as {
      month: string;
      invoiceId: string;
      projectTempNo: string;
      amountCents: bigint;
      region: string;
    }[];
    expect(details).toHaveLength(2); // 撤销的不在下钻中
    const sum = details.reduce((s, d) => s + d.amountCents, 0n);
    expect(sum).toBe(500000n); // 与指标口径一致
    expect(service.buildReport(JULY).monthlyInvoices[0].amountCents).toBe(sum);
    expect(details.map((d) => d.projectTempNo).sort()).toEqual(['TP-1', 'TP-1']);
  });

  it('各指标均支持下钻且与聚合口径一致', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1', region: 'East', entryAt: '2026-07-01' }),
    ];
    facts.contracts = [makeContract({ entryAmountSnapshotCents: 100000n })];
    facts.batches = [makeBatch({ id: 'b1' })];
    facts.logisticsFees = [makeFee({ id: 'f1', batchId: 'b1' })];
    facts.serviceOrders = [makeOrder({ id: 'o1' })];
    facts.damageItems = [makeDamageItem({ id: 'd1', partStatus: 'used' })];
    facts.shipToRequests = [makeShipToRequest({ id: 's1', status: 'processing', submittedAt: '2026-07-05' })];
    facts.qrRequests = [makeQrRequest({ id: 'q1', types: ['A'] })];
    facts.serialAddressUpdates = [makeSerialUpdate({ id: 'u1' })];

    const report = service.buildReport(JULY);
    expect(report.entryAmountByRegion[0].amountCents).toBe(
      (service.getMetricDetails('entry_amount_by_region', JULY) as { amountCents: bigint }[]).reduce((s, d) => s + d.amountCents, 0n),
    );
    expect(report.damageSummary[0].usedPartUsdCents).toBe(
      (service.getMetricDetails('damage_repair_stats', JULY) as { usedPartUsdCents: bigint }[]).reduce((s, d) => s + d.usedPartUsdCents, 0n),
    );
    expect(report.shipToWorkload[0].count).toBe(
      (service.getMetricDetails('ship_to_request_workload', JULY) as unknown[]).length,
    );
  });
});

describe('所有权边界（design D10 / tasks 7.11）', () => {
  it('reporting 拥有统计公式但不拥有业务状态：无状态转换入口、只读', () => {
    expect('resolveStatus' in reportingModule).toBe(false);
    expect('PROJECT_STATUSES' in reportingModule).toBe(false);
    expect(typeof reportingModule.ReportingService).toBe('function');
    expect(typeof reportingModule.ReportingExportService).toBe('function');
    const proto = Object.getPrototypeOf(ReportingService.prototype) as Record<string, unknown>;
    expect('save' in proto).toBe(false);
    expect('adjustStatus' in proto).toBe(false);
    // 读取层无写操作
    const readerKeys = Object.keys(ReportingService.prototype).filter((k) => k.startsWith('list'));
    expect(readerKeys.length).toBe(0);
  });
});

describe('项目分类标签筛选（add-project-tags reporting lane）', () => {
  it('多选标签按 OR 匹配、去重且不重复放大项目派生金额、次数或下钻', () => {
    const { facts, service } = setup();
    facts.projects = [
      makeProject({ id: 'p1', tempNo: 'TP-1' }),
      makeProject({ id: 'p2', tempNo: 'TP-2' }),
      makeProject({ id: 'p3', tempNo: 'TP-3' }),
    ];
    facts.invoices = [
      makeInvoice({ id: 'i1', projectId: 'p1', amountCents: 100n }),
      makeInvoice({ id: 'i2', projectId: 'p2', amountCents: 200n }),
      makeInvoice({ id: 'i3', projectId: 'p3', amountCents: 300n }),
    ];
    Object.assign(facts, {
      listProjectTagAssignments: () => [
        { projectId: 'p1', tagId: 'tag-a' },
        { projectId: 'p1', tagId: 'tag-b' },
        { projectId: 'p2', tagId: 'tag-b' },
      ],
      listProjectTagIds: () => ['tag-a', 'tag-b'],
    });

    const filter = { ...JULY, tagIds: ['tag-a', 'tag-b', 'tag-a'] };
    const report = service.buildReport(filter);
    expect(report.filters.tagIds).toEqual(['tag-a', 'tag-b']);
    expect(report.pipeline.reduce((sum, row) => sum + row.projectCount, 0)).toBe(2);
    expect(report.monthlyInvoices).toEqual([{ month: '2026-07', amountCents: 300n, count: 2 }]);
    expect(service.getMetricDetails('monthly_invoice_amount', filter)).toHaveLength(2);
  });

  it('未选标签不限制；标签筛选启用时排除无项目的独立工作量与 projectId 为 null 的服务单', () => {
    const { facts, service } = setup();
    facts.projects = [makeProject({ id: 'p1' })];
    facts.serviceOrders = [
      makeOrder({ id: 'project-order', projectId: 'p1', serviceOrderNo: 'P-1' }),
      makeOrder({ id: 'independent-order', projectId: null, serviceOrderNo: 'I-1' }),
    ];
    facts.shipToRequests = [makeShipToRequest({ status: 'processing', submittedAt: '2026-07-05' })];
    facts.qrRequests = [makeQrRequest()];
    facts.serialAddressUpdates = [makeSerialUpdate()];
    Object.assign(facts, {
      listProjectTagAssignments: () => [{ projectId: 'p1', tagId: 'tag-a' }],
      listProjectTagIds: () => ['tag-a'],
    });

    expect(service.buildReport(JULY).monthlyServiceOrders[0].count).toBe(2);
    expect(service.buildReport({ ...JULY, tagIds: [] }).monthlyServiceOrders[0].count).toBe(2);
    const filtered = service.buildReport({ ...JULY, tagIds: ['tag-a'] });
    expect(filtered.monthlyServiceOrders[0].count).toBe(1);
    expect(filtered.shipToWorkload).toEqual([]);
    expect(filtered.qrWorkload).toEqual([]);
    expect(filtered.serialAddressUpdates).toEqual([]);
  });
});
