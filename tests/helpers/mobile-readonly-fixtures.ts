import type { DatabaseSync } from 'node:sqlite';
import {
  MOBILE_READONLY_ORDER_TYPES,
  MOBILE_READONLY_PROJECT_STATUSES,
  MOBILE_READONLY_SCHEMA_VERSION,
  type MobileReadonlyActivityRecord,
  type MobileReadonlyBatchRecord,
  type MobileReadonlyDamageItemRecord,
  type MobileReadonlyInstrumentRecord,
  type MobileReadonlyInvoiceRecord,
  type MobileReadonlyOrderRecord,
  type MobileReadonlyOverview,
  type MobileReadonlyOverviewMetrics,
  type MobileReadonlyProject,
  type MobileReadonlyProjectRecords,
  type MobileReadonlyProjectSummary,
  type MobileReadonlyRecordKind,
  type MobileReadonlySnapshot,
  type MobileReadonlyStageSummary,
} from '../../src/shared/mobile-readonly';

/**
 * 移动只读快照的**合成**夹具（openspec change `add-mobile-readonly-publication`）。
 *
 * 只使用脱敏合成数据，绝不读取/触碰 `docs/` 下真实客户 xlsx/pptx：
 * - 纯对象工厂：构造符合封闭白名单的合法快照样例（供校验器 whitelist/money/date 测试改造）；
 * - SQLite 播种：向临时测试库写入合成项目与六类关联记录（供 snapshot 测试验证
 *   单事务全量遍历 / 事务边界 / 排除性 / 金额日期契约）。
 *
 * 金额一律直接写分整数（bigint/INTEGER），读取端经仓储 formatCents 输出为两位小数字符串，
 * 本夹具不做任何浮点换算；业务日期一律 yyyy-mm-dd。
 */

const SYNTHETIC_CUSTOMER_NAME = '移动只读合成客户';
const SYNTHETIC_ISO_PREFIX = '2026-08-';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 由序号生成稳定的审计 ISO（created_at/updated_at 类）。 */
function auditIso(index: number, dayOffset = 0): string {
  const day = 1 + ((index + dayOffset) % 28);
  const minute = index % 1440;
  return `${SYNTHETIC_ISO_PREFIX}${pad2(day)}T${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}:00+08:00`;
}

/** 由序号生成稳定的业务日期。 */
function businessDateAt(index: number, monthDayStart = 1): string {
  return `${SYNTHETIC_ISO_PREFIX}${pad2(monthDayStart + (index % 27))}`;
}

// ---------------------------------------------------------------------------
// 纯对象工厂（每个调用返回全新对象，测试可安全改造）
// ---------------------------------------------------------------------------

export function makeOverviewMetricsFixture(overrides: Partial<MobileReadonlyOverviewMetrics> = {}): MobileReadonlyOverviewMetrics {
  return {
    totalProjects: 2,
    activeProjects: 1,
    pendingAmount: '1234.57',
    pendingAcceptance: 0,
    pendingInvoice: 1,
    ...overrides,
  };
}

export function makeStageFixture(status: MobileReadonlyStageSummary['status'], overrides: Partial<MobileReadonlyStageSummary> = {}): MobileReadonlyStageSummary {
  return { status, count: 0, averageDays: 0, ...overrides };
}

export function makeOverviewFixture(overrides: Partial<MobileReadonlyOverview> = {}): MobileReadonlyOverview {
  const stages: MobileReadonlyStageSummary[] = MOBILE_READONLY_PROJECT_STATUSES.map((status) => makeStageFixture(status));
  return { metrics: makeOverviewMetricsFixture(), stages, ...overrides };
}

export function makeEmptySnapshotFixture(overrides: Partial<MobileReadonlySnapshot> = {}): MobileReadonlySnapshot {
  const emptyOverview: MobileReadonlyOverview = {
    metrics: makeOverviewMetricsFixture({
      totalProjects: 0,
      activeProjects: 0,
      pendingAmount: '0.00',
      pendingAcceptance: 0,
      pendingInvoice: 0,
    }),
    stages: MOBILE_READONLY_PROJECT_STATUSES.map((status) => makeStageFixture(status)),
  };
  return {
    schemaVersion: MOBILE_READONLY_SCHEMA_VERSION,
    contentGenerationId: 'synthetic-generation-empty',
    businessRevision: 0,
    dataAsOf: '2026-08-08T09:00:00+08:00',
    overview: emptyOverview,
    projects: [],
    ...overrides,
  };
}

export function makeBatchRecordFixture(index = 0, overrides: Partial<MobileReadonlyBatchRecord> = {}): MobileReadonlyBatchRecord {
  return {
    id: `fixture-batch-${index}`,
    planTransportDate: businessDateAt(index),
    transportCompany: index % 2 === 0 ? `承运商-${index}` : null,
    startedAt: index % 3 === 0 ? businessDateAt(index + 3) : null,
    appliedAt: index % 2 === 0 ? businessDateAt(index + 5) : null,
    ...overrides,
  };
}

export function makeInstrumentRecordFixture(index = 0, overrides: Partial<MobileReadonlyInstrumentRecord> = {}): MobileReadonlyInstrumentRecord {
  return {
    id: `fixture-instrument-${index}`,
    name: `仪器-${index}`,
    model: index % 2 === 0 ? `型号-${index}` : null,
    serialNo: index % 3 === 0 ? null : `SN-FIX-${index}`,
    ups: index % 2 === 0,
    ...overrides,
  };
}

export function makeActivityRecordFixture(index = 0, overrides: Partial<MobileReadonlyActivityRecord> = {}): MobileReadonlyActivityRecord {
  return {
    id: `fixture-activity-${index}`,
    visitAt: index % 4 === 0 ? null : businessDateAt(index + 2),
    engineers: index % 2 === 0 ? '工程师甲、工程师乙' : '工程师甲',
    ...overrides,
  };
}

export function makeOrderRecordFixture(index = 0, overrides: Partial<MobileReadonlyOrderRecord> = {}): MobileReadonlyOrderRecord {
  return {
    id: `fixture-order-${index}`,
    orderType: MOBILE_READONLY_ORDER_TYPES[index % MOBILE_READONLY_ORDER_TYPES.length],
    serviceOrderNo: index % 2 === 0 ? `SON-FIX-${index}` : null,
    orderedAt: businessDateAt(index + 1),
    engineer: index % 3 === 0 ? null : `工程师-${index}`,
    ...overrides,
  };
}

export function makeInvoiceRecordFixture(index = 0, overrides: Partial<MobileReadonlyInvoiceRecord> = {}): MobileReadonlyInvoiceRecord {
  const revoked = index % 4 === 1;
  return {
    id: `fixture-invoice-${index}`,
    amount: '1234.56',
    invoicedAt: businessDateAt(index + 4),
    active: !revoked,
    revokedAt: revoked ? businessDateAt(index + 6) : null,
    ...overrides,
  };
}

export function makeDamageItemRecordFixture(index = 0, overrides: Partial<MobileReadonlyDamageItemRecord> = {}): MobileReadonlyDamageItemRecord {
  return {
    id: `fixture-damage-${index}`,
    instrumentName: `仪器-${index}`,
    serialNo: index % 2 === 0 ? `SN-DMG-${index}` : null,
    issueStatus: index % 2 === 0 ? 'processing' : 'repaired',
    partNumber: `PN-${index}`,
    partQuantity: index % 2 === 0 ? 1 : 0,
    partAmount: '0.00',
    partCurrency: index % 2 === 0 ? 'USD' : null,
    registeredAt: businessDateAt(index + 7),
    ...overrides,
  };
}

/** 各记录数组每类一条的示例 records 容器。 */
export function makeSampleProjectRecordsFixture(): MobileReadonlyProjectRecords {
  return {
    batches: [makeBatchRecordFixture(0)],
    instruments: [makeInstrumentRecordFixture(0)],
    activities: [makeActivityRecordFixture(0)],
    orders: [makeOrderRecordFixture(0)],
    invoices: [makeInvoiceRecordFixture(0)],
    damage_items: [makeDamageItemRecordFixture(0)],
  };
}

/** 每类均为空数组的 records 容器。 */
export function makeEmptyProjectRecordsFixture(): MobileReadonlyProjectRecords {
  return { batches: [], instruments: [], activities: [], orders: [], invoices: [], damage_items: [] };
}

export function makeProjectSummaryFixture(overrides: Partial<MobileReadonlyProjectSummary> = {}): MobileReadonlyProjectSummary {
  return {
    id: 'fixture-project-1',
    tempNo: 'TP-FIXTURE-001',
    ecc: 'ECC-FIXTURE-001',
    customerName: SYNTHETIC_CUSTOMER_NAME,
    status: 'executing',
    region: 'East',
    regionNeedsAdjustment: false,
    entryAt: '2026-08-01',
    planVisitAt: '2026-08-10',
    finalAmount: '100000.00',
    invoicedAmount: '2000.00',
    contractAmount: '100000.00',
    formallyEntered: true,
    preEntryExecution: false,
    ...overrides,
  };
}

export function makeProjectFixture(overrides: Partial<MobileReadonlyProject> = {}): MobileReadonlyProject {
  const { records: recordsOverride, ...summaryOverrides } = overrides;
  return {
    ...makeProjectSummaryFixture(summaryOverrides),
    records: recordsOverride ?? makeSampleProjectRecordsFixture(),
  };
}

export function makeSnapshotFixture(overrides: Partial<MobileReadonlySnapshot> = {}): MobileReadonlySnapshot {
  return {
    schemaVersion: MOBILE_READONLY_SCHEMA_VERSION,
    contentGenerationId: 'fixture-generation-1',
    businessRevision: 7,
    dataAsOf: '2026-08-08T10:30:00+08:00',
    overview: makeOverviewFixture(),
    projects: [makeProjectFixture()],
    ...overrides,
  };
}

/** 深度冻结（防测试改动泄漏到后续用例的兜底，不做为唯一防篡改手段）。 */
export function freezeSnapshot(snapshot: MobileReadonlySnapshot): MobileReadonlySnapshot {
  return structuredClone(snapshot);
}

// ---------------------------------------------------------------------------
// 快照改造辅助（validator 测试用；返回 unknown 供 validate 直接消费）
// ---------------------------------------------------------------------------

type Jsonish = Record<string, unknown>;

function asRecord(value: unknown): Jsonish {
  return value as Jsonish;
}

/** 复制快照并对首个项目调用 mutate（结果返回 unknown，便于校验改造后的候选）。 */
export function mutateFirstProject(
  snapshot: MobileReadonlySnapshot,
  mutate: (project: Jsonish) => void,
): unknown {
  const raw = asRecord(snapshot);
  const projects = (raw.projects as Jsonish[]).map((p) => ({ ...p }));
  mutate(projects[0]);
  return { ...raw, projects };
}

/** 在首个项目的 records 上按 kind 改造首行（返回 unknown 候选）。 */
export function mutateFirstRowOfKind(
  snapshot: MobileReadonlySnapshot,
  kind: string,
  mutate: (row: Jsonish) => void,
): unknown {
  return mutateFirstProject(snapshot, (project) => {
    const records = asRecord(project.records);
    const rows = (records[kind] as Jsonish[]).map((row) => ({ ...row }));
    mutate(rows[0]);
    records[kind] = rows;
  });
}

/** 整体替换首个项目的某 kind 首行（供缺键用例）。 */
export function replaceFirstRowOfKind(snapshot: MobileReadonlySnapshot, kind: string, row: Jsonish): unknown {
  return mutateFirstProject(snapshot, (project) => {
    const records = asRecord(project.records);
    records[kind] = [row];
  });
}

// ---------------------------------------------------------------------------
// SQLite 播种（仅合成数据；金额写分整数，日期 yyyy-mm-dd，审计 ISO 保留）
// ---------------------------------------------------------------------------

/** 按 kind 在单项目内播种的合成记录数量。 */
export interface SyntheticRecordCounts {
  batches?: number;
  instruments?: number;
  activities?: number;
  orders?: number;
  invoices?: number;
  damageItems?: number;
}

export interface SyntheticProjectOptions {
  index: number;
  status?: MobileReadonlyProjectSummary['status'];
  region?: string | null;
  entryAt?: string | null;
  planVisitAt?: string | null;
  finalAmountCents?: bigint | null;
  contractAmountCents?: bigint | null;
  /** 填充敏感字段（联系人/地址/备注），用于排除性断言。 */
  withSensitive?: boolean;
}

export interface SeededProject {
  projectId: string;
  tempNo: string;
  ecc: string;
}

/** 播种一个合成项目（客户名称共享；正式进单带 ECC/合同/进单日期）。 */
export function seedSyntheticProject(db: DatabaseSync, options: SyntheticProjectOptions): SeededProject {
  const index = options.index;
  const projectId = `mr-project-${index}`;
  const tempNo = `TP-MR-${pad2(index)}`;
  const ecc = `ECC-MR-${pad2(index)}`;

  db.prepare(
    `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name_key) DO NOTHING`,
  ).run('mr-customer-1', SYNTHETIC_CUSTOMER_NAME, auditIso(0), auditIso(0));
  const customerRow = db.prepare('SELECT id FROM customers WHERE name = ?').get(SYNTHETIC_CUSTOMER_NAME) as { id: string };
  const customerId = customerRow.id;

  const status = options.status ?? MOBILE_READONLY_PROJECT_STATUSES[index % 4];
  const region = options.region ?? (index % 2 === 0 ? 'East' : 'North');
  const entryAt = options.entryAt ?? businessDateAt(index);
  const planVisitAt = options.planVisitAt ?? (index % 2 === 0 ? businessDateAt(index + 5) : null);
  // null = 显式无金额（可空字段保持 null）；undefined = 用默认合成值。
  const finalAmountCents = options.finalAmountCents !== undefined ? options.finalAmountCents : 500000n;
  const contractAmountCents = options.contractAmountCents !== undefined ? options.contractAmountCents : finalAmountCents;

  db.prepare(
    `INSERT INTO projects (
       id, temp_no, status, pre_entry_execution, customer_id, entry_at, region,
       old_site_contact, new_site_contact, old_site_address, new_site_address,
       plan_visit_at, project_note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    tempNo,
    status,
    options.withSensitive === false ? 0 : 1,
    customerId,
    entryAt,
    region,
    options.withSensitive === false ? null : `旧址联系人-${index}`,
    options.withSensitive === false ? null : `新址联系人-${index}`,
    options.withSensitive === false ? null : `旧址地址-${index} 号`,
    options.withSensitive === false ? null : `新址地址-${index} 号`,
    planVisitAt,
    options.withSensitive === false ? null : `项目备注-${index}`,
    auditIso(index),
    auditIso(index),
  );

  db.prepare(
    `INSERT INTO contracts (id, project_id, temp_number, ecc, usd_tax_amount_cents, final_confirmable_amount_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `mr-contract-${index}`,
    projectId,
    tempNo,
    ecc,
    contractAmountCents,
    finalAmountCents,
    auditIso(index),
    auditIso(index),
  );

  return { projectId, tempNo, ecc };
}

/** 播种 N 个合成项目（created_at 递增保证排序稳定）。 */
export function seedSyntheticProjects(db: DatabaseSync, count: number, options: Partial<SyntheticProjectOptions> = {}): SeededProject[] {
  const results: SeededProject[] = [];
  for (let index = 0; index < count; index += 1) {
    results.push(seedSyntheticProject(db, { ...options, index }));
  }
  return results;
}

/**
 * 向项目播种六类关联记录。金额写分整数；damage 事项引用同项目 instruments
 * （不足时自动补建 instruments，保证 instrument_name 非空且 FK 成立）。
 */
export function seedSyntheticProjectRecords(db: DatabaseSync, projectId: string, counts: SyntheticRecordCounts): void {
  const batches = counts.batches ?? 0;
  const requestedInstruments = counts.instruments ?? 0;
  const damageItems = counts.damageItems ?? 0;
  const instruments = Math.max(requestedInstruments, damageItems);
  const activities = counts.activities ?? 0;
  const orders = counts.orders ?? 0;
  const invoices = counts.invoices ?? 0;

  for (let i = 0; i < batches; i += 1) {
    db.prepare(
      `INSERT INTO batches (id, project_id, plan_transport_date, transport_company, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${projectId}-batch-${i}`,
      projectId,
      i % 2 === 0 ? businessDateAt(i) : null,
      i % 2 === 0 ? `承运商-${i}` : null,
      i % 3 === 0 ? businessDateAt(i + 2) : null,
      auditIso(i),
      auditIso(i),
    );
  }

  const instrumentIds: string[] = [];
  for (let i = 0; i < instruments; i += 1) {
    const instrumentId = `${projectId}-instrument-${i}`;
    instrumentIds.push(instrumentId);
    db.prepare(
      `INSERT INTO instruments (id, project_id, name, model, serial_no, ups, qr_requested, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instrumentId,
      projectId,
      `仪器-${i}`,
      i % 2 === 0 ? `型号-${i}` : null,
      i % 3 === 0 ? null : `${projectId}-SN-${i}`,
      i % 2 === 0 ? 1 : 0,
      i % 2 === 0 ? 1 : 0,
      auditIso(i),
      auditIso(i),
    );
  }

  for (let i = 0; i < activities; i += 1) {
    const activityId = `${projectId}-activity-${i}`;
    db.prepare(
      `INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(activityId, projectId, i % 4 === 0 ? null : businessDateAt(i + 2), auditIso(i), auditIso(i));
    // 两条参与工程师（GROUP_CONCAT '、'），含一条缺省验证 engineers 文本。
    db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?, ?, ?)`).run(
      `${activityId}-e1`,
      activityId,
      `工程师-${i}-甲`,
    );
    if (i % 2 === 0) {
      db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?, ?, ?)`).run(
        `${activityId}-e2`,
        activityId,
        `工程师-${i}-乙`,
      );
    }
  }

  for (let i = 0; i < orders; i += 1) {
    db.prepare(
      `INSERT INTO service_orders (
         id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${projectId}-order-${i}`,
      MOBILE_READONLY_ORDER_TYPES[i % MOBILE_READONLY_ORDER_TYPES.length],
      i % 2 === 0 ? `${projectId}-SON-${i}` : null,
      businessDateAt(i + 1),
      i % 3 === 0 ? null : `工程师-${i}`,
      SYNTHETIC_CUSTOMER_NAME,
      projectId,
      i % 2 === 0 ? `备注-${i}` : null,
      auditIso(i),
      auditIso(i),
    );
  }

  for (let i = 0; i < invoices; i += 1) {
    const revoked = i % 4 === 1;
    db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, revoke_reason, last_modified_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${projectId}-invoice-${i}`,
      projectId,
      123456n,
      businessDateAt(i + 4),
      revoked ? businessDateAt(i + 6) : null,
      revoked ? `撤销原因-${i}` : null,
      auditIso(i),
      auditIso(i),
    );
  }

  for (let i = 0; i < damageItems; i += 1) {
    const instrumentId = instrumentIds[i % instrumentIds.length];
    db.prepare(
      `INSERT INTO damage_repair_items (
         id, instrument_id, issue_status, part_number, part_quantity, part_amount_cents,
         part_currency, part_status, damage_reason, repair_note, registered_at, project_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${projectId}-damage-${i}`,
      instrumentId,
      i % 2 === 0 ? 'processing' : 'repaired',
      `PN-${i}`,
      i % 2 === 0 ? 1 : 0,
      i % 3 === 0 ? null : 250000n,
      i % 2 === 0 ? 'USD' : null,
      i % 2 === 0 ? 'processing' : 'used',
      `损坏原因-${i}`,
      `维修备注-${i}`,
      businessDateAt(i + 7),
      projectId,
      auditIso(i),
      auditIso(i),
    );
  }
}

/** 覆盖指定项目的合同/掉票金额（分整数；供金额契约测试直接播种大数/清空为 null）。 */
export function overwriteProjectAmounts(
  db: DatabaseSync,
  projectId: string,
  amounts: { finalAmountCents?: bigint | null; contractAmountCents?: bigint | null; invoiceAmountCents?: bigint[] },
): void {
  const contract = db
    .prepare('SELECT id FROM contracts WHERE project_id = ?')
    .get(projectId) as { id: string } | undefined;
  if (contract) {
    if (amounts.finalAmountCents !== undefined) {
      db.prepare('UPDATE contracts SET final_confirmable_amount_cents = ? WHERE id = ?').run(
        amounts.finalAmountCents,
        contract.id,
      );
    }
    if (amounts.contractAmountCents !== undefined) {
      db.prepare('UPDATE contracts SET usd_tax_amount_cents = ? WHERE id = ?').run(
        amounts.contractAmountCents,
        contract.id,
      );
    }
  }
  if (amounts.invoiceAmountCents !== undefined) {
    const rows = db
      .prepare('SELECT id FROM invoices WHERE project_id = ? ORDER BY id ASC')
      .all(projectId) as Array<{ id: string }>;
    rows.forEach((row, i) => {
      const cents = amounts.invoiceAmountCents![i] ?? 0n;
      db.prepare('UPDATE invoices SET amount_cents = ? WHERE id = ?').run(cents, row.id);
    });
  }
}

/** 汇总统计快照内各 kind 的记录 id（供遍历完整性断言）。 */
export function collectRecordKindCounts(records: MobileReadonlyProjectRecords): Record<MobileReadonlyRecordKind, number> {
  return {
    batches: records.batches.length,
    instruments: records.instruments.length,
    activities: records.activities.length,
    orders: records.orders.length,
    invoices: records.invoices.length,
    damage_items: records.damage_items.length,
  };
}
