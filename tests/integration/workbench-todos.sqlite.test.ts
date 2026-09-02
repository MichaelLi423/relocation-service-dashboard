import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import {
  SqliteContractRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository,
  SqliteActivityRepository,
  SqliteActivityEngineerRepository,
  SqliteWorkFactRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import { SqliteQrRequestRepository } from '../../src/domain/capabilities/local-data-persistence/qr-request-repositories';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence/ship-to-repositories';
import { SqliteReminderSettingsRepository } from '../../src/domain/capabilities/local-data-persistence/reminder-settings-repositories';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ReminderService } from '../../src/domain/capabilities/workbench-todos/reminder-service';
import { QrRequestService } from '../../src/domain/capabilities/qr-request-tracking/qr-request-service';
import { ShipToService } from '../../src/domain/capabilities/ship-to-management/ship-to-service';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import type { ExecutionLifecycleGateway } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';

/**
 * workbench-todos SQLite 集成（tasks 6.5）。
 * 验证项目提醒手工维护/到期分类/临期窗口在真实临时 SQLite 上落库、
 * 关闭重开保留、账号归属快照持久化、schema v5 迁移，以及跨模块
 * 「不自动创建提醒」边界（二维码申请、Ship-to 申请、成交>预算物流
 * 费用均不产生任何项目提醒）。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoices = new SqliteInvoiceReadRepository(db);
  const projectService = new ProjectService(projects, contracts, invoices, CLOCK);
  const settings = new SqliteReminderSettingsRepository(db);
  const reminders = new ReminderService(projects, settings, CLOCK);

  const qrService = new QrRequestService(new SqliteQrRequestRepository(db), CLOCK);
  const shipToService = new ShipToService(
    new SqliteShipToRepository(db),
    new SqliteShipToRequestRepository(db),
    new SqliteShipToAddressReader(db),
    CLOCK,
  );

  const batches = new SqliteBatchRepository(db);
  const instruments = new SqliteInstrumentRepository(db);
  const fees = new SqliteLogisticsFeeRepository(db);
  const gateway: ExecutionLifecycleGateway = {
    onExecutionStarted: (pid) => {
      projectService.adjustStatus(pid, 'executing', { executionStarted: true });
    },
  };
  const executionService = new ExecutionService(
    batches,
    instruments,
    new SqliteBatchChangeHistoryRepository(db),
    new SqliteActivityRepository(db),
    new SqliteActivityEngineerRepository(db),
    new SqliteWorkFactRepository(db),
    fees,
    gateway,
    CLOCK,
  );

  return {
    db,
    dbPath,
    projects,
    projectService,
    reminders,
    settings,
    qrService,
    shipToService,
    executionService,
    batches,
    fees,
  };
}

/** 创建并落库一个项目（返回 id）。 */
function addProject(db: DatabaseSync, id: string): void {
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run(id, `TP-${id}`, 'pending_entry', 't', 't');
}

describe('workbench-todos SQLite 集成（6.5）', () => {
  it(`schema v${LATEST_SCHEMA_VERSION}：项目提醒归属快照列存在并随迁移写入 user_version=${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const cols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('reminder_account_id');
      expect(cols.map((c) => c.name)).toContain('reminder_username_snapshot');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('提醒创建→编辑→清除落库，关闭重开保留当前提醒与归属快照', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');

      ctx.reminders.setReminder('p1', { at: '2026-08-10', note: '补齐资料' }, ACTOR);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const stored = reopened.projects.findById('p1')!;
      expect(stored.reminderAt).toBe('2026-08-10');
      expect(stored.reminderNote).toBe('补齐资料');
      expect(stored.reminderAccountId).toBe('account-1');
      expect(stored.reminderUsernameSnapshot).toBe('负责人甲');
      expect(reopened.reminders.classifyProject(stored)).toBe('upcoming');

      // 编辑：覆盖为新的当前提醒（不保存旧内容/完成历史）
      reopened.reminders.setReminder('p1', { at: '2026-08-12', note: '新备注' }, ACTOR);
      const edited = reopened.projects.findById('p1')!;
      expect(edited.reminderAt).toBe('2026-08-12');
      expect(edited.reminderNote).toBe('新备注');
      expect(reopened.reminders.classifyProject(edited)).toBe('upcoming');

      // 清除：项目不再显示任何提醒
      reopened.reminders.clearReminder('p1', ACTOR);
      const cleared = reopened.projects.findById('p1')!;
      expect(cleared.reminderAt).toBeNull();
      expect(cleared.reminderNote).toBeNull();
      expect(reopened.reminders.classifyProject(cleared)).toBeNull();
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('临期窗口配置经 app_settings 持久化并立即生效', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      // 未配置默认 7 个自然日
      expect(ctx.reminders.getUpcomingWindowDays()).toBe(7);
      expect(ctx.reminders.classifyAt('2026-08-14')).toBe('upcoming');
      expect(ctx.reminders.classifyAt('2026-08-15')).toBeNull();

      ctx.reminders.setUpcomingWindowDays(3);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      expect(reopened.reminders.getUpcomingWindowDays()).toBe(3);
      // 配置立即生效：第 4 天起不再临期
      expect(reopened.reminders.classifyAt('2026-08-10')).toBe('upcoming');
      expect(reopened.reminders.classifyAt('2026-08-11')).toBeNull();
      const row = reopened.db
        .prepare("SELECT value FROM app_settings WHERE key = 'reminder_upcoming_window_days'")
        .get() as { value: string };
      expect(row.value).toBe('3');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('listReminders 供工作台展示：按当前提醒列出项目与到期分类，关闭重开仍可列出', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');
      addProject(ctx.db, 'p2');
      ctx.reminders.setReminder('p1', { at: '2026-08-07', note: '今日' }, ACTOR);
      ctx.reminders.setReminder('p2', { at: '2026-08-05', note: '逾期' }, ACTOR);
      closeDatabase(ctx.db);

      const reopened = openService(dir);
      const reminders = reopened.reminders.listReminders();
      const dueMap = new Map(reminders.map((r) => [r.project.id, r.dueClass]));
      expect(dueMap.get('p1')).toBe('today');
      expect(dueMap.get('p2')).toBe('overdue');
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('二维码申请、Ship-to 申请与成交高于预算物流费用均不自动创建项目提醒', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      addProject(ctx.db, 'p1');

      // 二维码申请（独立模块）保存后：项目提醒保持为空
      ctx.qrService.createRequest({ applicant: '负责人甲', types: ['A', 'B'] }, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();

      // Ship-to 申请未完成：不自动创建项目提醒
      const request = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      ctx.shipToService.submit(request.id, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderAt).toBeNull();
      expect(ctx.projects.findById('p1')!.reminderNote).toBeNull();

      // 批次成交价格高于预算：仅警告，不自动创建项目提醒
      ctx.db
        .prepare('INSERT INTO batches (id, project_id, plan_transport_date, transport_company, original_price_cents, discounted_price_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('b1', 'p1', '2026-08-10', '物流公司甲', 10000, 9000, 't', 't');
      const feeResult = ctx.executionService.recordLogisticsFee(
        'b1',
        { appliedAt: '2026-08-07', budgetPriceCents: 10000n, dealPriceCents: 12000n, logisticsCostCents: 11000n },
        ACTOR,
      );
      expect(feeResult.warning).toContain('不自动创建项目提醒');
      const project = ctx.projects.findById('p1')!;
      expect(project.reminderAt).toBeNull();
      expect(project.reminderNote).toBeNull();
      expect(ctx.reminders.listReminders()).toHaveLength(0);

      // 负责人手工维护后才有提醒（系统绝不由上述事实推导）
      ctx.reminders.setReminder('p1', { at: '2026-08-09', note: '手工跟进' }, ACTOR);
      expect(ctx.projects.findById('p1')!.reminderNote).toBe('手工跟进');
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

/**
 * tasks 7.3 / 7.6：完整提醒视图与提醒泳道读取模型。
 * - reminderPage：全部项目提醒 + 到期分类，sort asc/desc 默认 desc（最近日期优先）；
 * - reminderLanes：先按提醒日期升序选取最多 7 个不同非空日期（无连续日要求、
 *   全量不足仅返回已有），再按列读取项目；列内 id 稳定 tie-breaker；推进某列
 *   携带 selectedDates 锁定日期集合、不得重算。
 */
describe('完整提醒视图与提醒泳道读取模型（tasks 7.3 / 7.6）', () => {
  const TODAY = '2026-08-08';
  const WINDOW = 7;

  function reminderDb(dataDir: string): DatabaseSync {
    const { db } = bootstrapDatabase({ dataDir });
    db.prepare(
      'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');
    return db;
  }

  function seed(db: DatabaseSync, id: string, date: string | null, note: string | null): void {
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, `TP-${id}`, 'pending_execution', 'East', date, note, 't', 't');
  }

  function repo(db: DatabaseSync): WorkbenchReadRepository {
    return new WorkbenchReadRepository(db, { today: TODAY, windowDays: WINDOW });
  }

  it('任务7.3：完整提醒视图默认按提醒日期降序（最近日期优先），含到期分类，仅备注项目也计入', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      seed(db, 'r-1', '2026-08-05', '逾期');
      seed(db, 'r-2', '2026-08-10', '临期');
      seed(db, 'r-3', '2026-08-16', '窗口外');
      seed(db, 'r-4', null, '仅备注无日期');

      const page = repo(db).reminderPage({});
      expect(page.sort).toBe('desc');
      expect(page.total).toBe(4);
      // 降序：有日期按提醒日期倒序（最近日期优先），无日期（COALESCE ''）排最后
      expect(page.rows.map((r) => r.projectId)).toEqual(['r-3', 'r-2', 'r-1', 'r-4']);
      const byId = new Map(page.rows.map((r) => [r.projectId, r.reminderDueClass]));
      expect(byId.get('r-1')).toBe('overdue');
      expect(byId.get('r-2')).toBe('upcoming');
      expect(byId.get('r-3')).toBeNull(); // 超出临期窗口
      expect(byId.get('r-4')).toBeNull(); // 仅备注无日期不分类

      // 降序 keyset 分页重复加载稳定
      const first = repo(db).reminderPage({ limit: 2 });
      const second = repo(db).reminderPage({ limit: 2, cursor: first.nextCursor! });
      expect([...first.rows, ...second.rows].map((r) => r.projectId)).toEqual(['r-3', 'r-2', 'r-1', 'r-4']);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('任务7.3：切换升序立即生效；asc/desc 与泳道（7.6）排序独立', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      seed(db, 'r-1', '2026-08-05', '逾期');
      seed(db, 'r-2', '2026-08-10', '临期');
      seed(db, 'r-3', '2026-08-16', '窗口外');

      const asc = repo(db).reminderPage({ sort: 'asc' });
      expect(asc.sort).toBe('asc');
      // 升序：最早日期在前；无日期（COALESCE ''）在最前（与项目队列 reminder 排序同口径）
      expect(asc.rows.map((r) => r.projectId)).toEqual(['r-1', 'r-2', 'r-3']);

      // 排序选择立即生效于同一读取模型；泳道升序不影响完整提醒默认降序
      expect(repo(db).reminderPage({}).rows.map((r) => r.projectId)).toEqual(['r-3', 'r-2', 'r-1']);
      expect(repo(db).reminderLanes({}).dates[0]).toBe('2026-08-05'); // 泳道升序
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('任务7.6：同日归列、非连续日期只取有提醒的日期、首批最多 7 个日期、全量不足不制造空列', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      // 4 个不同日期、日期之间有无提醒的自然日间隔；同日多条
      seed(db, 'd-1', '2026-08-01', '逾期1');
      seed(db, 'd-2', '2026-08-01', '逾期2');
      seed(db, 'd-3', '2026-08-01', '逾期3');
      seed(db, 'e-1', '2026-08-10', '临期');
      seed(db, 'e-2', '2026-08-10', '临期2');
      seed(db, 'f-1', '2026-08-20', '未来');
      seed(db, 'g-1', '2026-08-25', '未来2');

      const lanes = repo(db).reminderLanes({});
      // 日期升序、无连续日要求（08-02..08-09 无提醒不占用列）
      expect(lanes.dates).toEqual(['2026-08-01', '2026-08-10', '2026-08-20', '2026-08-25']);
      expect(lanes.lanes.map((l) => l.date)).toEqual(lanes.dates);

      // 同一提醒日期归入同一列
      const sameDay = lanes.lanes.find((l) => l.date === '2026-08-01')!;
      expect(sameDay.total).toBe(3);
      expect(sameDay.projects.length).toBe(3);
      expect(sameDay.projects.map((p) => p.projectId).sort()).toEqual(['d-1', 'd-2', 'd-3']);

      // 全量不足 7 个日期：仅返回已有非空日期列，不制造空列
      expect(lanes.dates.length).toBe(4);
      expect(lanes.lanes.every((l) => l.projects.length > 0)).toBe(true);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('任务7.6：首批不足 7 个不同日期继续向未来补列；超过 7 个时只取最早 7 个', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      // 10 个不同日期（08-01..08-10）→ 只取最早 7 个
      for (let i = 1; i <= 10; i++) {
        const day = String(i).padStart(2, '0');
        seed(db, `n-${i}`, `2026-08-${day}`, `备注${i}`);
      }
      const lanes = repo(db).reminderLanes({});
      expect(lanes.dates).toEqual([
        '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04',
        '2026-08-05', '2026-08-06', '2026-08-07',
      ]);
      expect(lanes.lanes).toHaveLength(7);
      closeDatabase(db);

      // 首批不足 7 个不同日期：仅返回已有的非空日期列
      const dir2 = makeTempDir('reminder-sparse-');
      try {
        const db2 = reminderDb(dir2);
        seed(db2, 'x-1', '2026-08-03', 'a');
        seed(db2, 'x-2', '2026-08-09', 'b');
        const sparse = repo(db2).reminderLanes({});
        expect(sparse.dates).toEqual(['2026-08-03', '2026-08-09']);
        expect(sparse.lanes).toHaveLength(2);
        closeDatabase(db2);
      } finally {
        cleanupTempDir(dir2);
      }
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('任务7.6：列内 id 稳定 tie-breaker；按列分页携带 selectedDates 锁定日期集合、不重算不重读', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      // 高量日期列：2026-08-01 共 25 个项目；另两列各 1 个
      for (let i = 0; i < 25; i++) {
        seed(db, `c-${String(i).padStart(2, '0')}`, '2026-08-01', '高量');
      }
      seed(db, 'other-1', '2026-08-10', '另一日期');
      seed(db, 'other-2', '2026-08-15', '再一日期');

      const first = repo(db).reminderLanes({ limit: 10 });
      expect(first.dates).toEqual(['2026-08-01', '2026-08-10', '2026-08-15']);
      const col = first.lanes.find((l) => l.date === '2026-08-01')!;
      expect(col.total).toBe(25);
      expect(col.projects.length).toBe(10);
      // 列内稳定：id 升序（c-00..c-09）
      expect(col.projects.map((p) => p.projectId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `c-${String(i).padStart(2, '0')}`),
      );

      // 推进该列：携带 selectedDates 锁定日期集合，不得重算或改变
      const next = repo(db).reminderLanes({
        selectedDates: first.dates,
        date: '2026-08-01',
        cursor: col.nextCursor!,
        limit: 10,
      });
      expect(next.dates).toEqual(first.dates); // 日期集合不变
      const nextCol = next.lanes.find((l) => l.date === '2026-08-01')!;
      expect(nextCol.projects.length).toBe(10);
      expect(nextCol.projects.map((p) => p.projectId)).toEqual(
        Array.from({ length: 10 }, (_, i) => `c-${String(i + 10).padStart(2, '0')}`),
      );
      // 其它列仍在响应中（首页），未因推进某列被丢弃
      expect(next.lanes.map((l) => l.date)).toEqual(first.dates);

      // 列内不重复：首页 + 推进页拼接无重复
      const ids = [...col.projects, ...nextCol.projects].map((p) => p.projectId);
      expect(new Set(ids).size).toBe(20);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reminderLanes：WAL 并发写入不会混合日期列、列 total 与 businessRevision', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      seed(db, 'snapshot-old', '2026-08-10', '旧快照');
      const oldRevision = readBusinessRevision(db);
      const writer = openDatabase({ path: `${dir}/workbench.db` });
      const originalPrepare = db.prepare.bind(db);
      let injected = false;

      // 日期集合首次查询完成后才提交写入。若 reminderLanes 未包住整个 DTO，
      // 随后的列查询/total/revision 将读到新修订，形成 dates 与 total/revision 混读。
      (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (!sql.includes('SELECT DISTINCT substr(reminder_at, 1, 10) AS d')) return statement;
        return new Proxy(statement, {
          get(target, property, receiver) {
            if (property !== 'all') return Reflect.get(target, property, receiver);
            return (...args: Parameters<typeof target.all>) => {
              const rows = target.all(...args);
              writer.prepare(
                `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
              ).run('snapshot-new', 'TP-snapshot-new', 'pending_execution', 'East', '2026-08-10', '并发新增', 't', 't');
              injected = true;
              return rows;
            };
          },
        });
      }) as typeof db.prepare;

      try {
        const lanes = repo(db).reminderLanes({});
        expect(injected).toBe(true);
        expect(lanes.dates).toEqual(['2026-08-10']);
        expect(lanes.lanes[0]).toMatchObject({ total: 1, projects: [{ projectId: 'snapshot-old' }] });
        expect(lanes.businessRevision).toBe(oldRevision);
      } finally {
        (db as { prepare: typeof db.prepare }).prepare = originalPrepare;
        closeDatabase(writer);
      }
      expect(readBusinessRevision(db)).toBeGreaterThan(oldRevision);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reminder 分页与泳道仅在存在额外行时返回游标，并拒绝篡改的锁定集合/列游标', () => {
    const dir = makeTempDir();
    try {
      const db = reminderDb(dir);
      for (let i = 0; i < 20; i++) seed(db, `exact-${String(i).padStart(2, '0')}`, '2026-08-10', '精确页');

      const page = repo(db).reminderPage({ limit: 20 });
      expect(page.rows).toHaveLength(20);
      expect(page.nextCursor).toBeNull();

      const lanes = repo(db).reminderLanes({ limit: 20 });
      const lane = lanes.lanes[0];
      expect(lane.projects).toHaveLength(20);
      expect(lane.nextCursor).toBeNull();
      expect(() => repo(db).reminderLanes({ selectedDates: [] })).toThrow(/1 至 7/);
      expect(() => repo(db).reminderLanes({ selectedDates: ['2026-08-11', '2026-08-10'] })).toThrow(/严格升序/);
      expect(() => repo(db).reminderLanes({ selectedDates: ['2026-08-10'], date: '2026-08-11' })).toThrow(/必须属于/);

      seed(db, 'extra', '2026-08-10', '额外行');
      const first = repo(db).reminderLanes({ limit: 20 });
      const cursor = first.lanes[0].nextCursor!;
      expect(cursor).toBeTruthy();
      expect(() => repo(db).reminderLanes({ selectedDates: ['2026-08-10'], date: '2026-08-10', cursor: `${cursor}x` })).toThrow(/游标/);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
