import type { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../../domain/core/errors';
import type { Clock } from '../../domain/core/time';
import {
  SqliteReminderSettingsRepository,
} from '../../domain/capabilities/local-data-persistence/reminder-settings-repositories';
import { readDatabaseIdentity } from '../../domain/capabilities/local-data-persistence/identity';
import {
  WorkbenchReadRepository,
} from '../../domain/capabilities/local-data-persistence/workbench-read-repository';
import { DEFAULT_UPCOMING_WINDOW_DAYS } from '../../domain/capabilities/workbench-todos/reminder';
import type {
  WorkbenchProjectRow,
  WorkbenchV2OverviewDto,
  WorkbenchV2SectionKind,
  WorkbenchV2SectionRow,
} from '../../shared/ipc';
import {
  MOBILE_READONLY_RECORD_KINDS,
  MOBILE_READONLY_SCHEMA_VERSION,
  validateMobileReadonlySnapshot,
  type MobileReadonlyActivityRecord,
  type MobileReadonlyBatchRecord,
  type MobileReadonlyDamageItemRecord,
  type MobileReadonlyInstrumentRecord,
  type MobileReadonlyInvoiceRecord,
  type MobileReadonlyOrderRecord,
  type MobileReadonlyOverview,
  type MobileReadonlyProject,
  type MobileReadonlyProjectRecords,
  type MobileReadonlyProjectSummary,
  type MobileReadonlyRecordKind,
  type MobileReadonlySnapshot,
  type MobileReadonlyStageSummary,
} from '../../shared/mobile-readonly';

/**
 * 移动只读一致快照生成（design D1 / tasks 3.1-3.2）。
 *
 * - 在**单一同步一致事务**内复用 `WorkbenchReadRepository` 的有界分页方法遍历
 *   全部搬迁项目（固定每页 20，逐页收集至末页）与每项目的全部六类关联记录
 *   （sectionPage 逐页收集，非首屏），同一事务捕获
 *   contentGenerationId/businessRevision（identity）与 dataAsOf（一致读取建立时刻）。
 * - 事务内只做本地读取与内存收集，零网络；序列化/白名单校验在事务提交后执行。
 * - 快照字段按 `design.md`「封闭字段白名单」表逐项挑选（非 DTO 展开）；产出后以
 *   共享严格校验器校验最终候选，失败即抛错（不外发任何部分内容）。
 * - 金额/日期值直接复用主进程已格式化 DTO 字符串（分整数→两位小数字符串已由
 *   formatCents 完成），本模块绝不再次除以 100 或转 Number。
 *
 * 本模块无任何网络导入/调用；网络仅存在于发布模块的 upload 子模块（后续任务）。
 */

/** 单次快照生成的依赖与选项。 */
export interface BuildMobileReadonlySnapshotOptions {
  /**
   * 当前 live SQLite 句柄。传函数时每次捕获开始时重新解析，
   * 避免恢复换库后持有陈旧句柄；传实例则直接使用该实例。
   */
  db: DatabaseSync | (() => DatabaseSync);
  /** 注入时钟：nowIso() 提供 dataAsOf，today() 作为 WorkbenchReadRepository 读者业务日期。 */
  clock: Clock;
  /**
   * 读者临期窗口天数（桌面 facade 经 ReminderService/SqliteReminderSettingsRepository
   * 读取的 reminder_upcoming_window_days，缺省默认 7 个自然日）。快照白名单不含提醒字段，
   * 该值仅与既有桌面读取口径保持一致。
   */
  windowDays?: number;
  /** sectionPage 遍历页大小（缺省沿用仓储默认 50；测试可注入小值制造多页）。 */
  sectionPageSize?: number;
}

interface CapturedResult {
  dataAsOf: string;
  contentGenerationId: string;
  businessRevision: number;
  overview: MobileReadonlyOverview;
  projects: readonly MobileReadonlyProject[];
}

/**
 * 在单一同步一致事务内生成完整只读快照（schemaVersion=1，见 MOBILE_READONLY_SCHEMA_VERSION）。
 * 事务提交后对最终候选执行封闭白名单校验，非法即抛 ValidationError。
 */
export function buildMobileReadonlySnapshot(options: BuildMobileReadonlySnapshotOptions): MobileReadonlySnapshot {
  const db = resolveDb(options.db);
  const clock = options.clock;
  const reader = new WorkbenchReadRepository(db, {
    today: clock.today(),
    windowDays: options.windowDays ?? readUpcomingWindowDays(db),
  });
  const sectionPageSize = options.sectionPageSize;

  const captured = reader.withReadSnapshot<CapturedResult>(() => {
    // dataAsOf = 一致快照读取建立时刻（事务首个操作）。
    const dataAsOf = clock.nowIso();
    const identity = readDatabaseIdentity(db);
    const overviewDto = reader.overview();
    const projects = collectAllProjects(reader, sectionPageSize);
    return {
      dataAsOf,
      contentGenerationId: identity.contentGenerationId,
      businessRevision: identity.businessRevision,
      overview: mapOverview(overviewDto),
      projects,
    };
  });

  const snapshot: MobileReadonlySnapshot = {
    schemaVersion: MOBILE_READONLY_SCHEMA_VERSION,
    contentGenerationId: captured.contentGenerationId,
    businessRevision: captured.businessRevision,
    dataAsOf: captured.dataAsOf,
    overview: captured.overview,
    projects: captured.projects,
  };

  // 事务提交后的序列化前校验（最终候选；拒绝即不外发）。
  const validation = validateMobileReadonlySnapshot(snapshot);
  if (!validation.ok) {
    const sample = validation.issues
      .slice(0, 5)
      .map((i) => `[${i.path || '<root>'}] ${i.code}: ${i.message}`)
      .join('；');
    throw new ValidationError(
      'MOBILE_READONLY_SNAPSHOT_INVALID',
      `生成的移动只读快照未通过封闭白名单校验（共 ${validation.issues.length} 项）：${sample}`,
    );
  }
  return snapshot;
}

function resolveDb(db: DatabaseSync | (() => DatabaseSync)): DatabaseSync {
  return typeof db === 'function' ? db() : db;
}

/** 读取桌面提醒「临期窗口」配置（与 WorkbenchFacade.v2Reader 同口径）。 */
function readUpcomingWindowDays(db: DatabaseSync): number {
  return new SqliteReminderSettingsRepository(db).getUpcomingWindowDays() ?? DEFAULT_UPCOMING_WINDOW_DAYS;
}

function collectAllProjects(reader: WorkbenchReadRepository, sectionPageSize: number | undefined): MobileReadonlyProject[] {
  const projects: MobileReadonlyProject[] = [];
  let cursor: string | null | undefined;
  do {
    const page = reader.projectPage({ cursor: cursor ?? undefined });
    for (const row of page.projects) {
      projects.push({
        ...mapProjectSummary(row),
        records: collectProjectRecords(reader, row.id, sectionPageSize),
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return projects;
}

function collectProjectRecords(
  reader: WorkbenchReadRepository,
  projectId: string,
  sectionPageSize: number | undefined,
): MobileReadonlyProjectRecords {
  const limit = sectionPageSize === undefined || !Number.isInteger(sectionPageSize) || sectionPageSize <= 0
    ? undefined
    : sectionPageSize;
  const result: MobileReadonlyProjectRecords = {
    batches: [],
    instruments: [],
    activities: [],
    orders: [],
    invoices: [],
    damage_items: [],
  };
  for (const kind of MOBILE_READONLY_RECORD_KINDS) {
    const rows = collectSectionRows(reader, projectId, kind, limit);
    assignRecordRows(result, kind, rows);
  }
  return result;
}

function collectSectionRows(
  reader: WorkbenchReadRepository,
  projectId: string,
  kind: MobileReadonlyRecordKind,
  limit: number | undefined,
): WorkbenchV2SectionRow[] {
  const rows: WorkbenchV2SectionRow[] = [];
  let cursor: string | null | undefined;
  do {
    const page = reader.sectionPage({ projectId, kind: kind as WorkbenchV2SectionKind, cursor: cursor ?? undefined, limit });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return rows;
}

function assignRecordRows(
  records: MobileReadonlyProjectRecords,
  kind: MobileReadonlyRecordKind,
  rows: WorkbenchV2SectionRow[],
): void {
  // 仓储按 request.kind 返回同一种类的行（WorkbenchV2SectionRow 判别联合），
  // 按 kind 收窄到对应变体再映射白名单字段。
  switch (kind) {
    case 'batches':
      records.batches = (rows as Extract<WorkbenchV2SectionRow, { kind: 'batches' }>[]).map(toMobileBatchRecord);
      return;
    case 'instruments':
      records.instruments = (rows as Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>[]).map(toMobileInstrumentRecord);
      return;
    case 'activities':
      records.activities = (rows as Extract<WorkbenchV2SectionRow, { kind: 'activities' }>[]).map(toMobileActivityRecord);
      return;
    case 'orders':
      records.orders = (rows as Extract<WorkbenchV2SectionRow, { kind: 'orders' }>[]).map(toMobileOrderRecord);
      return;
    case 'invoices':
      records.invoices = (rows as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>[]).map(toMobileInvoiceRecord);
      return;
    case 'damage_items':
      records.damage_items = (rows as Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>[]).map(toMobileDamageItemRecord);
      return;
  }
}

// ---- 白名单映射（只挑字段；金额/日期复用主进程已格式化 DTO 字符串） ----

function mapOverview(dto: WorkbenchV2OverviewDto): MobileReadonlyOverview {
  return {
    metrics: {
      totalProjects: dto.metrics.totalProjects,
      activeProjects: dto.metrics.activeProjects,
      pendingAmount: dto.metrics.pendingAmount,
      pendingAcceptance: dto.metrics.pendingAcceptance,
      pendingInvoice: dto.metrics.pendingInvoice,
    },
    stages: dto.stages.map(
      (stage): MobileReadonlyStageSummary => ({
        status: stage.status,
        count: stage.count,
        averageDays: stage.averageDays,
      }),
    ),
  };
}

function mapProjectSummary(row: WorkbenchProjectRow): MobileReadonlyProjectSummary {
  return {
    id: row.id,
    tempNo: row.tempNo,
    ecc: row.ecc,
    customerName: row.customerName,
    status: row.status,
    region: row.region,
    regionNeedsAdjustment: row.regionNeedsAdjustment,
    entryAt: row.entryAt,
    planVisitAt: row.planVisitAt,
    finalAmount: row.finalAmount,
    invoicedAmount: row.invoicedAmount,
    contractAmount: row.contractAmount,
    formallyEntered: row.formallyEntered,
    preEntryExecution: row.preEntryExecution,
  };
}

function toMobileBatchRecord(row: Extract<WorkbenchV2SectionRow, { kind: 'batches' }>): MobileReadonlyBatchRecord {
  return {
    id: row.id,
    planTransportDate: row.planTransportDate,
    transportCompany: row.transportCompany,
    startedAt: row.startedAt,
    appliedAt: row.appliedAt,
  };
}

function toMobileInstrumentRecord(row: Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>): MobileReadonlyInstrumentRecord {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    serialNo: row.serialNo,
    ups: row.ups,
  };
}

function toMobileActivityRecord(row: Extract<WorkbenchV2SectionRow, { kind: 'activities' }>): MobileReadonlyActivityRecord {
  return {
    id: row.id,
    visitAt: row.visitAt,
    engineers: row.engineers,
  };
}

function toMobileOrderRecord(row: Extract<WorkbenchV2SectionRow, { kind: 'orders' }>): MobileReadonlyOrderRecord {
  return {
    id: row.id,
    orderType: row.orderType,
    serviceOrderNo: row.serviceOrderNo,
    orderedAt: row.orderedAt,
    engineer: row.engineer,
  };
}

function toMobileInvoiceRecord(row: Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>): MobileReadonlyInvoiceRecord {
  return {
    id: row.id,
    amount: row.amount,
    invoicedAt: row.invoicedAt,
    active: row.active,
    revokedAt: row.revokedAt,
  };
}

function toMobileDamageItemRecord(
  row: Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>,
): MobileReadonlyDamageItemRecord {
  // damage_repair_items.part_currency 由 DB CHECK(IN ('USD','RMB')) 约束；收窄到受控枚举。
  const partCurrency = row.partCurrency === 'USD' || row.partCurrency === 'RMB' ? row.partCurrency : null;
  return {
    id: row.id,
    instrumentName: row.instrumentName,
    serialNo: row.serialNo,
    issueStatus: row.issueStatus,
    partNumber: row.partNumber,
    partQuantity: row.partQuantity,
    partAmount: row.partAmount,
    partCurrency,
    registeredAt: row.registeredAt,
  };
}
