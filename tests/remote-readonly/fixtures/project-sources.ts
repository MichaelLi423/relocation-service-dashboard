/**
 * 合成 fixture：无任何真实客户数据（tasks 1.4）。
 *
 * - 全部值均为可识别的人工构造假数据（`ACME 实验室`、`SN-SYN-*`、`TP-SYN-*`）；
 * - 不读取/记录/包含真实客户业务数据；不含地址、联系人、标签、备注、工程师等
 *   未批准字段业务值。
 * - 复用 src/shared/ipc.ts 的 source DTO 形状（WorkbenchProjectRow 允许携带
 *   未批准字段，投影层显式选择/丢弃，见 toRemoteProjectCard 等）。
 * - 详情详情 fixture 也携带未批准字段（联系人/地址/备注/原因/暂定名称型号等），
 *   由 toRemoteProjectDetail* 显式选择/丢弃。
 */
import type {
  WorkbenchProjectRow,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2SectionRow,
} from '../../../src/shared/ipc';
import type { RemoteProjectRecord } from '../../../src/shared/remote-readonly/projection';
import {
  projectRowFromWorkbench,
  toRemoteDetailGroup,
} from '../../../src/shared/remote-readonly/projection';

/** 详情 synthetic fixture（flat Workbench detail；null 表示未录入；排除字段置空）。 */
export function syntheticDetail(
  overrides: Partial<NonNullable<WorkbenchV2ProjectDetailDto['detail']>> = {},
): WorkbenchV2ProjectDetailDto['detail'] {
  const base: NonNullable<WorkbenchV2ProjectDetailDto['detail']> = {
    managerApprovalReason: null,
    managerApprovalMissing: null,
    managerApproved: null,
    projectNote: null,
    temporaryStorageAddress: null,
    isTemporaryStorage: null,
    oldSiteContact: null,
    newSiteContact: null,
    oldSiteAddress: null,
    newSiteAddress: null,
    contractStartDate: null,
    contractEndDate: null,
    planVisitAt: null,
    planTransportAt: null,
    plannedInstallAt: null,
    plannedInstallDoneAt: null,
    siteConfirmed: false,
    actualInstallDoneAt: null,
    acceptanceReport: false,
    acceptanceReportDate: null,
    cancelledAt: null,
    cancelReason: null,
    temporaryInstrumentCount: null,
    temporaryInstrumentName: null,
    temporaryInstrumentModel: null,
    temporaryHasUps: null,
    createdAt: SYNTHETIC_TECH_NOW,
    customerId: null,
    contractId: null,
  };
  return { ...base, ...overrides };
}

/** 将 overrides 收束到完整 detail 类型（undefined 键视为不覆盖）。 */
function mergeDetail(
  base: NonNullable<WorkbenchV2ProjectDetailDto['detail']>,
  overrides: Partial<NonNullable<WorkbenchV2ProjectDetailDto['detail']>> | undefined,
): NonNullable<WorkbenchV2ProjectDetailDto['detail']> {
  const out: NonNullable<WorkbenchV2ProjectDetailDto['detail']> = { ...base };
  if (!overrides) return out;
  for (const key of Object.keys(overrides) as Array<keyof NonNullable<WorkbenchV2ProjectDetailDto['detail']>>) {
    const value = overrides[key];
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value as unknown;
    }
  }
  return out;
}

export const SYNTHETIC_TECH_NOW = '2026-08-10T09:30:00+08:00';

let idSeq = 0;

/** 构造只读 synthetic 项目行（source 允许携带排除字段）。 */
export function makeSyntheticProject(overrides: Partial<WorkbenchProjectRow> = {}): WorkbenchProjectRow {
  idSeq += 1;
  const n = idSeq;
  const base: WorkbenchProjectRow = {
    id: `syn-project-${n}`,
    tempNo: `TP-SYN-${String(n).padStart(3, '0')}`,
    ecc: `ECC-SYN-${String(n).padStart(3, '0')}`,
    customerName: `ACME 实验室 ${n}`,
    status: 'pending_entry',
    formallyEntered: false,
    preEntryExecution: false,
    region: null,
    regionNeedsAdjustment: false,
    entryAt: null,
    planVisitAt: null,
    reminderAt: null,
    reminderNote: null,
    reminderDueClass: null,
    finalAmount: null,
    invoicedAmount: '0.00',
    contractAmount: null,
    entryAmountSnapshot: null,
    counts: { batches: 0, instruments: 0, activities: 0, orders: 0, repairs: 0, invoices: 0 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: [],
    groupedTags: [],
    updatedAt: SYNTHETIC_TECH_NOW,
  };
  return { ...base, ...overrides, counts: { ...base.counts, ...overrides.counts }, nonBlocking: { ...base.nonBlocking, ...overrides.nonBlocking } };
}

/** 已完成但仍有有效待掉票余额的项目（final=8000.00，已掉票 3000.00）。 */
export function syntheticCompletedWithBalance(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'completed',
    formallyEntered: true,
    entryAt: '2026-05-01',
    contractAmount: '10000.00',
    entryAmountSnapshot: '10000.00',
    finalAmount: '8000.00',
    invoicedAmount: '3000.00',
    counts: { batches: 2, instruments: 5, activities: 3, orders: 1, repairs: 1, invoices: 2 },
    nonBlocking: { pendingShipTo: 1, qrUnmarked: 4, repairs: 1 },
    planVisitAt: '2026-06-01',
    reminderAt: '2026-06-15',
    reminderNote: 'Synthetic 提醒备注（排除）',
    tagIds: ['tag-syn-1'],
    groupedTags: [],
  });
}

/** 已取消项目（cancelled，仍有财务历史：final=6000.00 + 有效掉票 2000.00，但取消须排除）。 */
export function syntheticCancelledProject(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'cancelled',
    formallyEntered: true,
    entryAt: '2026-03-10',
    contractAmount: '6000.00',
    entryAmountSnapshot: '6000.00',
    finalAmount: '6000.00',
    invoicedAmount: '2000.00',
    counts: { batches: 0, instruments: 0, activities: 0, orders: 0, repairs: 0, invoices: 1 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
  });
}

/** 未进单/空财务项目（仅总数列入；金额 null 显示未填写而非 0）。 */
export function syntheticPendingNoContract(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'pending_entry',
    formallyEntered: false,
    contractAmount: null,
    entryAmountSnapshot: null,
    finalAmount: null,
    invoicedAmount: '0.00',
    region: 'East',
  });
}

/** 仅孤立/脏财务事实（无任何项目时 pendingAmount 为 0，不因孤立数据变非 0）。 */
export interface SyntheticOrphanFacts {
  projectId: string;
  invoiceAmount: string;
  finalCents: string;
}

export function syntheticOrphanFinancialFacts(): SyntheticOrphanFacts[] {
  return [
    // 引用已不存在的项目：概览聚合必须忽略
    { projectId: 'orphan-project-1', invoiceAmount: '4000.00', finalCents: '5000.00' },
  ];
}

/** 零数据快照（有效空投影；零项目时 pendingAmount = '0.00'）。 */
export function syntheticNoProjects(): WorkbenchProjectRow[] {
  return [];
}

export function syntheticHistoricalRegionLegacy(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'pending_execution',
    region: '华东', // 存量 legacy 非枚举原文
    regionNeedsAdjustment: true,
  });
}

export function syntheticAllRegions(): WorkbenchProjectRow[] {
  const regions = ['East', 'South', 'West', 'Central', 'North'] as const;
  return regions.map((region) =>
    makeSyntheticProject({ region, status: 'pending_execution', customerName: `区域客户 ${region}` }),
  );
}

/** 只有手工提醒备注而无提醒日期：hasReminder=true + reminderAt=null。 */
export function syntheticReminderNoteOnly(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'executing',
    reminderAt: null,
    reminderNote: 'Synthetic 仅备注提醒',
  });
}

/** 有计划上门日期与提醒日期（排序/日期校验用）。 */
export function syntheticPlannedVisit(): WorkbenchProjectRow {
  return makeSyntheticProject({
    status: 'pending_execution',
    planVisitAt: '2026-08-20',
    reminderAt: '2026-08-15',
    reminderNote: null,
  });
}

/** 分区 synthetic 行（source 携带排除字段，投影显式选择）。 */
export function syntheticSections(): {
  batches: Extract<WorkbenchV2SectionRow, { kind: 'batches' }>;
  instruments: Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>;
  orders: Extract<WorkbenchV2SectionRow, { kind: 'orders' }>;
  invoices: Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
  damage: Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>;
} {
  const projectId = 'syn-project-completed';
  return {
    batches: {
      kind: 'batches',
      id: 'syn-batch-1',
      projectId,
      planTransportDate: '2026-05-20',
      transportCompany: 'Synthetic 物流（排除）',
      originalPrice: '1000.00',
      discountedPrice: '800.00',
      appliedAt: '2026-05-21',
      startedAt: '2026-05-22',
      createdAt: '2026-05-19T00:00:00+08:00',
    },
    instruments: {
      kind: 'instruments',
      id: 'syn-instrument-1',
      projectId,
      batchId: 'syn-batch-1',
      name: 'Synthetic 色谱仪',
      model: 'MODEL-SYN-1',
      manufacturer: 'Synthetic 制造商（排除）',
      serviceLevel: 'Synthetic 服务级别（排除）',
      serialNo: 'SN-SYN-0001',
      ups: true,
      qrRequested: false,
      destinationShipToId: 'syn-ship-to-1',
      createdAt: '2026-05-19T00:00:00+08:00',
    },
    orders: {
      kind: 'orders',
      id: 'syn-order-1',
      projectId,
      orderType: 'relocation',
      serviceOrderNo: 'SO-SYN-001',
      orderedAt: '2026-05-23',
      engineer: 'Synthetic 工程师（排除）',
      customerName: 'ACME 实验室',
      note: 'Synthetic note（排除）',
      createdAt: '2026-05-23T00:00:00+08:00',
    },
    invoices: {
      kind: 'invoices',
      id: 'syn-invoice-1',
      projectId,
      amount: '3000.00',
      invoicedAt: '2026-06-01',
      active: true,
      revokedAt: null,
      revokeReason: null,
      lastModifiedAt: '2026-06-01T09:00:00+08:00',
      createdAt: '2026-06-01T09:00:00+08:00',
    },
    damage: {
      kind: 'damage_items',
      id: 'syn-damage-1',
      projectId,
      instrumentId: 'syn-instrument-1',
      instrumentName: 'Synthetic 色谱仪',
      serialNo: 'SN-SYN-0001',
      damageReason: 'Synthetic 损坏原因（排除）',
      issueStatus: 'untreated',
      partNumber: 'PN-SYN-001',
      partQuantity: 1,
      partAmount: '1200.00',
      partCurrency: 'USD',
      partStatus: 'pending_submit',
      registeredAt: '2026-06-05',
      repairNote: 'Synthetic 维修备注（排除）',
      createdAt: '2026-06-05T00:00:00+08:00',
    },
  };
}

/** 零金额/空金额边界：0 合同金额、空最终可确认金额、空物流成交价。 */
export function syntheticZeroAndBlankAmounts(): WorkbenchProjectRow[] {
  return [
    makeSyntheticProject({
      status: 'pending_invoice',
      formallyEntered: true,
      entryAt: '2026-04-01',
      contractAmount: '0.00',
      entryAmountSnapshot: '0.00',
      finalAmount: null,
      invoicedAmount: '0.00',
    }),
    makeSyntheticProject({
      status: 'pending_invoice',
      formallyEntered: true,
      entryAt: '2026-04-02',
      contractAmount: '10000.00',
      entryAmountSnapshot: '10000.00',
      finalAmount: '10000.00',
      invoicedAmount: '0.00',
    }),
  ];
}

/**
 * 连接式 synthetic 项目源（tasks 1.4 快照工厂）：
 * - 项目 id 固定 `syn-project-conn`（确定性，不随 idSeq 变化）；
 * - 关联分区行引用已存在项目/batch/instrument id（batchId/instrumentId 引用真实）；
 * - 源行 counts/nonBlocking 与实际分区行数量一致（repairs=1 对应 1 条 damage，
 *   nonBlocking.repairs=1 对应未修复事项）；invoices=2 为含撤销历史的记录数；
 * - 源 detail 携带排除字段（联系人/地址/备注/原因/暂定名称型号/旧别名），
 *   由 toRemoteDetailGroup 显式选择/丢弃。
 */
export interface SyntheticConnectedProject {
  project: WorkbenchProjectRow;
  detail: NonNullable<WorkbenchV2ProjectDetailDto['detail']>;
  sections: {
    batches: Array<Extract<WorkbenchV2SectionRow, { kind: 'batches' }>>;
    instruments: Array<Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>>;
    orders: Array<Extract<WorkbenchV2SectionRow, { kind: 'orders' }>>;
    invoices: Array<Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>>;
    damage: Array<Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>>;
  };
}

export const SYNTHETIC_CONNECTED_PROJECT_ID = 'syn-project-conn';
export const SYNTHETIC_CONNECTED_BATCH_IDS = ['syn-batch-conn-1', 'syn-batch-conn-2'] as const;
export const SYNTHETIC_CONNECTED_INSTRUMENT_IDS = ['syn-instrument-conn-1', 'syn-instrument-conn-2'] as const;

export function syntheticConnectedProject(
  overrides: {
    project?: Partial<WorkbenchProjectRow>;
    detail?: Partial<NonNullable<WorkbenchV2ProjectDetailDto['detail']>>;
  } = {},
): SyntheticConnectedProject {
  const projectId = SYNTHETIC_CONNECTED_PROJECT_ID;
  const batchId1 = SYNTHETIC_CONNECTED_BATCH_IDS[0];
  const batchId2 = SYNTHETIC_CONNECTED_BATCH_IDS[1];
  const instrumentId1 = SYNTHETIC_CONNECTED_INSTRUMENT_IDS[0];
  const instrumentId2 = SYNTHETIC_CONNECTED_INSTRUMENT_IDS[1];
  const project: WorkbenchProjectRow = {
    ...makeSyntheticProject({
      id: projectId,
      status: 'completed',
      formallyEntered: true,
      tempNo: 'TP-SYN-CONN',
      ecc: 'ECC-SYN-CONN',
      customerName: 'ACME 实验室（连接）',
      entryAt: '2026-05-01',
      planVisitAt: '2026-06-01',
      contractAmount: '10000.00',
      entryAmountSnapshot: '10000.00',
      finalAmount: '8000.00',
      invoicedAmount: '3000.00',
      counts: { batches: 2, instruments: 2, activities: 99, orders: 1, repairs: 1, invoices: 2 },
      nonBlocking: { pendingShipTo: 1, qrUnmarked: 2, repairs: 1 },
    }),
    ...overrides.project,
    id: overrides.project?.id ?? projectId,
  };
  if (overrides.project?.counts) {
    project.counts = { ...project.counts, ...overrides.project.counts };
  }
  if (overrides.project?.nonBlocking) {
    project.nonBlocking = { ...project.nonBlocking, ...overrides.project.nonBlocking };
  }

  const baseDetail = syntheticDetail({
    contractStartDate: '2026-05-01',
    contractEndDate: '2026-07-31',
    planVisitAt: '2026-06-01',
    planTransportAt: '2026-05-28',
    plannedInstallAt: '2026-06-10',
    plannedInstallDoneAt: '2026-06-10', // 旧别名（排除）
    siteConfirmed: true,
    actualInstallDoneAt: '2026-06-12',
    managerApproved: true,
    acceptanceReport: true,
    acceptanceReportDate: '2026-06-15',
    cancelledAt: null,
    temporaryInstrumentCount: 1,
    temporaryHasUps: true,
    temporaryInstrumentName: 'Synthetic 暂定名称（排除）',
    temporaryInstrumentModel: 'Synthetic 暂定型号（排除）',
    oldSiteContact: 'Synthetic 旧址联系人（排除）',
    newSiteAddress: 'Synthetic 新址地址（排除）',
    projectNote: 'Synthetic 项目备注（排除）',
    cancelReason: null,
    managerApprovalReason: 'Synthetic 批复原因（排除）',
  });
  // syntheticDetail 恒返回非空对象；此处仅在类型层面收窄（不吞 null 语义）。
  if (baseDetail === null) {
    throw new Error('syntheticConnectedProject: syntheticDetail 不应为 null');
  }
  const detail = mergeDetail(baseDetail, overrides.detail);

  const sections: SyntheticConnectedProject['sections'] = {
    batches: [
      {
        kind: 'batches' as const,
        id: batchId1,
        projectId,
        planTransportDate: '2026-05-28',
        transportCompany: 'Synthetic 物流（排除）',
        originalPrice: '1000.00',
        discountedPrice: '800.00',
        appliedAt: '2026-05-29',
        startedAt: '2026-05-30',
        createdAt: '2026-05-27T00:00:00+08:00',
      },
      {
        kind: 'batches' as const,
        id: batchId2,
        projectId,
        planTransportDate: '2026-06-02',
        transportCompany: null,
        originalPrice: null,
        discountedPrice: null,
        appliedAt: null,
        startedAt: null,
        createdAt: '2026-06-01T00:00:00+08:00',
      },
    ],
    instruments: [
      {
        kind: 'instruments' as const,
        id: instrumentId1,
        projectId,
        batchId: batchId1,
        name: 'Synthetic 色谱仪 A',
        model: 'MODEL-SYN-CONN-1',
        manufacturer: 'Synthetic 制造商（排除）',
        serviceLevel: 'Synthetic 服务级别（排除）',
        serialNo: 'SN-SYN-CONN-001',
        ups: true,
        qrRequested: false,
        destinationShipToId: 'syn-ship-to-conn-1',
        createdAt: '2026-05-27T00:00:00+08:00',
      },
      {
        kind: 'instruments' as const,
        id: instrumentId2,
        projectId,
        batchId: batchId2,
        name: 'Synthetic 离心机 B',
        model: null,
        manufacturer: null,
        serviceLevel: null,
        serialNo: null,
        ups: false,
        qrRequested: true,
        destinationShipToId: null,
        createdAt: '2026-06-01T00:00:00+08:00',
      },
    ],
    orders: [
      {
        kind: 'orders' as const,
        id: 'syn-order-conn-1',
        projectId,
        orderType: 'relocation',
        serviceOrderNo: 'SO-SYN-CONN-001',
        orderedAt: '2026-05-23',
        engineer: 'Synthetic 工程师（排除）',
        customerName: 'ACME 实验室（连接）',
        note: null,
        createdAt: '2026-05-23T00:00:00+08:00',
      },
    ],
    invoices: [
      {
        kind: 'invoices' as const,
        id: 'syn-invoice-conn-1',
        projectId,
        amount: '3000.00',
        invoicedAt: '2026-06-01',
        active: true,
        revokedAt: null,
        revokeReason: null,
        lastModifiedAt: '2026-06-01T09:00:00+08:00',
        createdAt: '2026-06-01T09:00:00+08:00',
      },
      {
        kind: 'invoices' as const,
        id: 'syn-invoice-conn-2',
        projectId,
        amount: '1000.00',
        invoicedAt: '2026-06-05',
        active: false,
        revokedAt: '2026-06-06',
        revokeReason: 'Synthetic 撤销原因（排除）',
        lastModifiedAt: '2026-06-06T10:00:00+08:00',
        createdAt: '2026-06-05T09:00:00+08:00',
      },
    ],
    damage: [
      {
        kind: 'damage_items' as const,
        id: 'syn-damage-conn-1',
        projectId,
        instrumentId: instrumentId1,
        instrumentName: 'Synthetic 色谱仪 A',
        serialNo: 'SN-SYN-CONN-001',
        issueStatus: 'untreated',
        damageReason: 'Synthetic 损坏原因（排除）',
        registeredAt: '2026-06-05',
        partNumber: 'PN-SYN-CONN-001',
        partQuantity: 1,
        partAmount: '1200.00',
        partCurrency: 'USD',
        partStatus: 'pending_submit',
        repairNote: null,
        createdAt: '2026-06-05T00:00:00+08:00',
      },
    ],
  };
  return { project, detail, sections };
}

/**
 * 项目完整 synthetic 记录（已投影，detail 分组与 row 来自同一 source id）。
 * 仅用已批准字段；被丢弃的排除字段（源 fixture 内的标签/备注/联系人等）不会进入。
 */
export function syntheticProjectRecord(connected: SyntheticConnectedProject): RemoteProjectRecord {
  const { project, detail } = connected;
  const group = toRemoteDetailGroup(project, detail);
  if (group === null) {
    // project fixture 恒非空；此处防御（不把 null 静默当作缺省分组发布）。
    throw new Error('syntheticProjectRecord: 项目 fixture 为空');
  }
  return { kind: 'project', row: projectRowFromWorkbench(project), detail: group };
}
