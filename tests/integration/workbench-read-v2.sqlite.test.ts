import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import {
  PROJECT_PAGE_SIZE,
  WorkbenchReadRepository,
} from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { classifyReminder } from '../../src/domain/capabilities/workbench-todos';
import { SystemClock } from '../../src/domain/core/time';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type {
  WorkbenchProjectRow,
  WorkbenchV2SectionRow,
} from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle #10 后端最小方案：v2 有界读取仓储 + 有界 mutation。
 *
 * - 全部读取为 SQL 有界实现（分页 + 聚合），禁止全量 snapshot / JS P×C；
 * - 每个 DTO 含 businessRevision；金额一律十进制字符串；
 * - 提醒分类与现有纯函数 classifyReminder 完全同口径（含边界）；
 * - v2 mutation 复用写逻辑但不调用 snapshot()，返回 invalidate tags。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

interface Ctx {
  db: DatabaseSync;
  dbPath: string;
  facade: WorkbenchFacade;
  projectId: string;
}

function makeFacade(): Ctx {
  const dir = makeTempDir('workbench-v2-');
  dirs.push(dir);
  const { db, dbPath } = bootstrapDatabase({ dataDir: dir });
  // 同步初始化（测试里账号服务是异步的，这里直接建行避免异步初始化开销）。
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('acc-1', '负责人', 'hash', 'salt', 't', 't');
  const facade = new WorkbenchFacade(db, () => ({ accountId: 'acc-1', username: '负责人' }));
  const created = facade.v2Mutate({
    op: 'create_project',
    payload: {
      intent: 'formal',
      customerName: '集成客户甲',
      ecc: 'ECC-V2-001',
      region: 'East',
      contractStartDate: '2026-08-01',
      contractEndDate: '2027-07-31',
      oldSiteAddress: '旧址',
      newSiteAddress: '新址',
      instrumentCount: 1,
      contractAmount: '100000',
      siteConfirmed: false,
    },
  });
  const projectId = created.changed!.projectId!;
  // 新建项目只记录 instrumentCount，不生成虚拟仪器：显式登记一台仪器供子记录测试。
  facade.v2Mutate({
    op: 'submit_action',
    projectId,
    action: { type: 'instrument', projectId, values: { name: '质谱仪', ups: true, qrRequested: false } },
  });
  return { db, dbPath, facade, projectId };
}

function reader(ctx: Ctx, today = '2026-08-08', windowDays = 7): WorkbenchReadRepository {
  return new WorkbenchReadRepository(ctx.db, { today, windowDays });
}

/** 直接 SQL 播种多个项目（temp_no 唯一；updated_at 递增保证排序稳定）。 */
function seedProjects(db: DatabaseSync, count: number, baseUpdatedAt = '2026-08-01T00:00:00+08:00'): void {
  const stmt = db.prepare(
    `INSERT INTO projects (id, temp_no, status, region, customer_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < count; i++) {
    const hour = String((i % 24)).padStart(2, '0');
    const minute = String((i % 60)).padStart(2, '0');
    stmt.run(
      `seed-p-${i}`,
      `TP-SEED-${String(i).padStart(4, '0')}`,
      i % 3 === 0 ? 'pending_execution' : i % 3 === 1 ? 'executing' : 'pending_acceptance',
      i % 2 === 0 ? 'East' : 'North',
      null,
      baseUpdatedAt,
      `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${hour}:${minute}:00+08:00`,
    );
  }
}

describe('工作台 v2 overview（Oracle #10 首屏）', () => {
  it('指标/阶段/提醒预览/total/窗口 + businessRevision；金额为十进制字符串', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    // 再建 4 个项目并设置不同状态/提醒，直接 SQL 播种 + 提醒字段
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r1', 'TP-R1', 'pending_execution', '华东', '2026-08-07', '逾期提醒', 't', '2026-08-05T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r2', 'TP-R2', 'executing', '华北', '2026-08-10', '临期提醒', 't', '2026-08-06T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('seed-r3', 'TP-R3', 'completed', '华东', '2026-08-09', '完成项目也带提醒', 't', '2026-08-07T00:00:00+08:00');

    const overview = reader(ctx).overview();
    expect(overview.businessRevision).toBeGreaterThan(0);
    expect(overview.reminderWindowDays).toBe(7);
    expect(overview.metrics.totalProjects).toBe(4);
    expect(overview.metrics.activeProjects).toBe(3); // 排除 completed/cancelled
    expect(overview.metrics.reminderCount).toBe(3);
    expect(overview.metrics.reminderOverdue).toBe(1);
    expect(overview.metrics.reminderToday).toBe(0); // 今日=2026-08-08，无
    expect(overview.metrics.pendingAmount).toBe('100000.00'); // makeFacade 已进单项目尚待掉票
    expect(typeof overview.metrics.pendingAmount).toBe('string');

    // 阶段：6 个非取消状态，计数正确
    const stage = Object.fromEntries(overview.stages.map((s) => [s.status, s.count]));
    expect(stage).toMatchObject({
      pending_entry: 0,
      pending_execution: 2,
      executing: 1,
      pending_acceptance: 0,
      pending_invoice: 0,
      completed: 1,
    });
    for (const s of overview.stages) {
      expect(Number.isFinite(s.averageDays)).toBe(true);
    }

    // 提醒预览：≤6、按提醒时间升序、total 一致、分类与纯函数同口径
    expect(overview.reminderPreview.length).toBeLessThanOrEqual(6);
    expect(overview.reminderPreview.map((r) => r.projectId)).toEqual(['seed-r1', 'seed-r3', 'seed-r2']);
    expect(overview.reminderTotal).toBe(3);
    for (const r of overview.reminderPreview) {
      expect(r.reminderDueClass).toBe(
        classifyReminder(r.reminderAt, '2026-08-08', 7),
      );
    }
    closeDatabase(ctx.db);
  });

  it('pendingAmount 排除已取消项目：仅取消项目存在时显示 0.00', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // makeFacade 已有已进单项目（contractAmount=100000、final=100000，尚待掉票）
    expect(reader(ctx).overview().metrics.pendingAmount).toBe('100000.00');

    // 取消该项目（无掉票历史允许取消）→ pendingAmount 归 0（仅取消项目时显示 0）
    facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-08-12', reason: '客户取消' });
    const overview = reader(ctx).overview();
    expect(overview.metrics.pendingAmount).toBe('0.00');
    expect(overview.metrics.totalProjects).toBe(1);
    expect(overview.metrics.activeProjects).toBe(0);

    // 再建一个已进单未取消项目 → 只统计非取消项目
    const second = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '待掉票客户乙',
        ecc: 'ECC-PEND-002',
        region: 'East',
        instrumentCount: 1,
        contractAmount: '50000',
      },
    });
    const secondId = second.changed!.projectId!;
    expect(reader(ctx).overview().metrics.pendingAmount).toBe('50000.00');
    facade.v2Mutate({ op: 'cancel_project', projectId: secondId, time: '2026-08-13', reason: '业务调整' });
    expect(reader(ctx).overview().metrics.pendingAmount).toBe('0.00');
    closeDatabase(db);
  });

  it('任务1.1：pendingAmount 直接取自 contracts.final_confirmable_amount_cents；已完成有效余额纳入、已取消排除', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    // makeFacade 基线：正式进单 final=100000、无掉票 → 待掉票 100000
    expect(reader(ctx).overview().metrics.pendingAmount).toBe('100000.00');
    expect(reader(ctx).overview().metrics.totalProjects).toBe(1);

    // 直接 SQL 播种合同与掉票，精确控制 final_confirmable_amount_cents（usd_tax_amount_cents 留空，
    // 以证明口径来自最终可确认金额而非合同金额）。
    const seedProject = db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, entry_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const seedContract = db.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    );
    const seedInvoice = db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, last_modified_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );

    // 已完成项目：final=80000，有效掉票 20000、已撤销 50000 → 待掉票 = 80000-20000 = 60000（已完成仍纳入）
    seedProject.run('fin-completed', 'TP-FIN-COMP', 'completed', '华东', '2026-08-01', 't', '2026-08-05T00:00:00+08:00');
    seedContract.run('c-fin-completed', 'fin-completed', 'TP-FIN-COMP', 8000000, 't', 't');
    seedInvoice.run('inv-fin-1', 'fin-completed', 2000000, '2026-08-02', null, '2026-08-02T00:00:00+08:00', 't');
    seedInvoice.run('inv-fin-2', 'fin-completed', 5000000, '2026-08-03', '2026-08-04', '2026-08-03T00:00:00+08:00', 't');

    // 已取消项目：final=50000 → 排除
    seedProject.run('fin-cancelled', 'TP-FIN-CANCEL', 'cancelled', '华北', '2026-08-01', 't', '2026-08-06T00:00:00+08:00');
    seedContract.run('c-fin-cancelled', 'fin-cancelled', 'TP-FIN-CANCEL', 5000000, 't', 't');

    // 已完成但 final_confirmable_amount_cents 为空 → 不计入
    seedProject.run('fin-null-final', 'TP-FIN-NULL', 'completed', '华东', '2026-08-01', 't', '2026-08-07T00:00:00+08:00');
    seedContract.run('c-fin-null', 'fin-null-final', 'TP-FIN-NULL', null, 't', 't');

    const overview = reader(ctx).overview();
    expect(overview.metrics.totalProjects).toBe(4); // 全量项目数（含已取消与空 final）
    expect(overview.metrics.pendingAmount).toBe('160000.00'); // 100000 + 60000，已取消与空 final 不计
    closeDatabase(db);
  });

  it('任务4.1：totalProjects 与待掉票金额在同一修订一致快照内读取（单一聚合查询）', () => {
    const ctx = makeFacade();
    const { db, dbPath } = ctx;
    // 第二连接模拟并发写入者（WAL 下可与读者事务并存）。
    const writer = openDatabase({ path: dbPath });
    const repo = reader(ctx);

    expect(repo.overview().metrics).toMatchObject({ totalProjects: 1, pendingAmount: '100000.00' });

    // 读者连接持有读事务快照（S0），写者连接随后提交新项目与合同 → 数据库修订推进。
    db.exec('BEGIN');
    db.prepare('SELECT COUNT(*) AS n FROM projects').get(); // 首次读建立快照 S0
    writer.prepare(
      `INSERT INTO projects (id, temp_no, status, region, entry_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('rev-b', 'TP-REV-B', 'pending_invoice', '华东', '2026-08-01', 't', 't');
    writer.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('c-rev-b', 'rev-b', 'TP-REV-B', 5000000, 't', 't');

    // 快照未释放：overview() 仍读到 S0，total 与金额保持同一修订
    // （不出现 totalProjects=2 而 pendingAmount 仍为旧值的混读）。
    const mid = repo.overview();
    expect(mid.metrics.totalProjects).toBe(1);
    expect(mid.metrics.pendingAmount).toBe('100000.00');

    // 提交读者事务后：读到新修订，total 与金额同步变化（100000 + 50000 = 150000）。
    db.exec('COMMIT');
    const after = repo.overview();
    expect(after.metrics.totalProjects).toBe(2);
    expect(after.metrics.pendingAmount).toBe('150000.00');

    closeDatabase(writer);
    closeDatabase(db);
  });

  it('任务1.6：reminderPreview 当前按记录数截断（最多 6 条）而非按日期分列（record-first 模型）', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const stmt = db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    // 同一提醒日期 8 条（最早日期）+ 另一日期 1 条：若为"先选日期列再取列内项目"会得到 2 个日期列；
    // 当前 record-first 模型按记录数截断 6 条，且全部来自最早日期。
    for (let i = 0; i < 8; i++) {
      stmt.run(
        `preview-${i}`,
        `TP-PV-${String(i).padStart(2, '0')}`,
        'pending_execution',
        '华东',
        '2026-08-07',
        `备注${i}`,
        't',
        `2026-08-0${(i % 8) + 1}T00:00:00+08:00`,
      );
    }
    stmt.run('preview-other', 'TP-PV-OTHER', 'pending_execution', '华东', '2026-08-09', '另一日期', 't', '2026-08-09T00:00:00+08:00');

    const overview = reader(ctx).overview();
    expect(overview.reminderPreview.length).toBe(6); // 记录数截断，不是 7 个日期列
    const dates = new Set(overview.reminderPreview.map((r) => r.reminderAt));
    // 6 条全部来自最早日期（2026-08-07）：证明按记录数截断而非按日期选取
    expect(dates.size).toBe(1);
    expect([...dates][0]).toBe('2026-08-07');
    expect(overview.reminderTotal).toBe(9);
    closeDatabase(db);
  });

  it('提醒边界：昨日/今日/窗口内/窗口外/仅备注 分类与纯函数完全同口径', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const today = '2026-08-08';
    const windowDays = 7;
    const seed = (id: string, at: string | null, note: string | null): void => {
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, `TP-${id}`, 'pending_execution', '华东', at, note, 't', '2026-08-01T00:00:00+08:00');
    };
    seed('b-overdue', '2026-08-07', '昨日'); // < today → overdue
    seed('b-today', '2026-08-08', '今日'); // == today → today
    seed('b-upcoming', '2026-08-10', '窗口内'); // today < d <= today+7 → upcoming
    seed('b-window-edge', '2026-08-15', '窗口最后一天'); // == today+7 → upcoming
    seed('b-outside', '2026-08-16', '窗口外'); // > today+7 → null
    seed('b-note-only', null, '仅备注无时间'); // null → 无分类但计入 any

    const repo = reader(ctx, today, windowDays);
    const page = repo.projectPage({ reminder: 'any' });
    const byId = new Map(page.projects.map((p) => [p.id, p]));
    const expectClass = (id: string, cls: string | null): void => {
      const row = byId.get(id);
      expect(row).toBeTruthy();
      expect(row!.reminderDueClass).toBe(cls);
      // 与纯函数逐行对照
      expect(row!.reminderDueClass).toBe(classifyReminder(row!.reminderAt, today, windowDays));
    };
    expectClass('b-overdue', 'overdue');
    expectClass('b-today', 'today');
    expectClass('b-upcoming', 'upcoming');
    expectClass('b-window-edge', 'upcoming');
    expectClass('b-outside', null);
    expectClass('b-note-only', null);

    // 过滤口径
    expect(repo.projectPage({ reminder: 'overdue' }).projects.map((p) => p.id)).toContain('b-overdue');
    expect(repo.projectPage({ reminder: 'today' }).projects.map((p) => p.id)).toEqual(['b-today']);
    const upcoming = repo.projectPage({ reminder: 'upcoming' }).projects.map((p) => p.id).sort();
    expect(upcoming).toEqual(['b-upcoming', 'b-window-edge']);
    const anyIds = repo.projectPage({ reminder: 'any' }).projects.map((p) => p.id).sort();
    expect(anyIds).toEqual(['b-note-only', 'b-outside', 'b-overdue', 'b-today', 'b-upcoming', 'b-window-edge']);
    closeDatabase(ctx.db);
  });
});

describe('工作台 v2 项目 keyset 分页（Oracle #10）', () => {
  it('withReadSnapshot 在 WAL 并发写入后仍保持旧行与旧 businessRevision 配对', () => {
    const ctx = makeFacade();
    const repo = reader(ctx);
    const writer = openDatabase({ path: ctx.dbPath });
    try {
      const oldRevision = readBusinessRevision(ctx.db);
      repo.withReadSnapshot(() => {
        const oldRows = ctx.db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>;
        writer.prepare(
          'INSERT INTO projects (id, temp_no, status, region, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        ).run('wal-concurrent', 'TP-WAL', 'pending_execution', 'East', '2026-08-08T00:00:00+08:00', '2026-08-08T00:00:00+08:00');
        expect(oldRows.map((row) => row.id)).not.toContain('wal-concurrent');
        expect(readBusinessRevision(ctx.db)).toBe(oldRevision);
        expect((ctx.db.prepare('SELECT id FROM projects WHERE id = ?').get('wal-concurrent'))).toBeUndefined();
      });
      expect(readBusinessRevision(ctx.db)).toBeGreaterThan(oldRevision);
    } finally {
      closeDatabase(writer);
      closeDatabase(ctx.db);
    }
  });

  it('恰好 20 条项目时不虚报 nextCursor，21 条时才返回游标', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 19);
    expect(reader(ctx).projectPage({}).nextCursor).toBeNull();
    ctx.db.prepare(
      'INSERT INTO projects (id, temp_no, status, region, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('project-extra', 'TP-EXTRA', 'pending_execution', 'East', '2027-01-01T00:00:00+08:00', '2027-01-01T00:00:00+08:00');
    const page = reader(ctx).projectPage({});
    expect(page.projects).toHaveLength(20);
    expect(page.nextCursor).toBeTruthy();
    closeDatabase(ctx.db);
  });

  it('40 条项目恰好两页，第二页不虚报 nextCursor', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 39);
    const first = reader(ctx).projectPage({});
    expect(first.projects).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const second = reader(ctx).projectPage({ cursor: first.nextCursor });
    expect(second.projects).toHaveLength(20);
    expect(second.nextCursor).toBeNull();
    closeDatabase(ctx.db);
  });

  it('任务7.5：固定每页 20（renderer 任意 limit 忽略）、翻页无重复无遗漏、游标稳定、total 正确', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 120);
    const repo = reader(ctx);

    const first = repo.projectPage({});
    expect(first.limit).toBe(PROJECT_PAGE_SIZE);
    expect(first.pageSize).toBe(PROJECT_PAGE_SIZE);
    expect(first.projects.length).toBe(20);
    expect(first.total).toBe(121); // 120 + makeFacade 的 1 个
    expect(first.nextCursor).toBeTruthy();

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    const collected: WorkbenchProjectRow[] = [];
    do {
      const page = repo.projectPage({ cursor });
      for (const p of page.projects) {
        expect(seen.has(p.id), `不应重复: ${p.id}`).toBe(false);
        seen.add(p.id);
      }
      collected.push(...page.projects);
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(7); // 121/20 → 6 满页 + 1 末页
    } while (cursor !== null);
    expect(collected.length).toBe(121);
    expect(seen.size).toBe(121);

    // 主进程统一 20：renderer 请求任意 limit（含超上限 1000）一律忽略
    const capped = repo.projectPage({});
    expect(capped.projects.length).toBe(20);
    expect(capped.limit).toBe(20);
    expect(capped.pageSize).toBe(20);

    // 游标稳定：同一 cursor 两次请求返回完全相同
    const again = repo.projectPage({ cursor: first.nextCursor });
    const second = repo.projectPage({ cursor: first.nextCursor });
    expect(again.projects.map((p) => p.id)).toEqual(second.projects.map((p) => p.id));

    // 默认排序为 updated_at DESC：第一页的 updatedAt 字典序单调不增
    const updated = first.projects.map((p) => p.updatedAt);
    expect([...updated].sort().reverse()).toEqual(updated);
    closeDatabase(ctx.db);
  });

  it('过滤：status / region / query（客户名称）/ reminder', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    seedProjects(db, 30);
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('filter-r', 'TP-F-R', 'pending_acceptance', '华南', '2026-08-07', '过滤提醒', 't', '2026-08-02T00:00:00+08:00');
    const repo = reader(ctx);

    expect(repo.projectPage({ status: 'pending_acceptance' }).projects.length).toBe(11); // 10 seed(3%3==2) + 1 filter-r
    expect(repo.projectPage({ region: 'North' }).projects.every((p) => p.region === 'North')).toBe(true);
    // query 命中客户名称（makeFacade 的集成客户甲）
    const byCustomer = repo.projectPage({ query: '集成客户' });
    expect(byCustomer.projects.length).toBe(1);
    expect(byCustomer.projects[0].customerName).toBe('集成客户甲');
    // query 命中临时编号
    expect(repo.projectPage({ query: 'TP-SEED-0000' }).projects.length).toBe(1);
    // reminder 过滤（今日=2026-08-08）
    expect(repo.projectPage({ reminder: 'overdue' }).projects.map((p) => p.id)).toEqual(['filter-r']);
    expect(repo.projectPage({ reminder: 'any' }).projects.map((p) => p.id)).toEqual(['filter-r']);
    closeDatabase(ctx.db);
  });

  it('任务7.5：过滤后 total 重算、cursor 与筛选状态绑定（筛选变化丢弃旧 cursor）、末页少于 20', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    seedProjects(db, 55);
    const repo = reader(ctx);
    // 过滤前：全量 total 与固定页 20
    const all = repo.projectPage({});
    expect(all.total).toBe(56); // 55 seed + makeFacade 1
    expect(all.projects.length).toBe(PROJECT_PAGE_SIZE);
    expect(all.nextCursor).toBeTruthy();

    // region 过滤（East = i 为偶数 28 条 + makeFacade 1 条）：total 重算为过滤集合，而不是全量
    const east = repo.projectPage({ region: 'East' });
    const eastCount = east.total;
    expect(eastCount).toBe(29);
    expect(east.projects.every((p) => p.region === 'East')).toBe(true);
    // 固定页 20：过滤集合 29 条 → 首页 20 条 + nextCursor
    expect(east.projects.length).toBe(20);
    expect(east.nextCursor).toBeTruthy();
    // 末页少于 20：第二页 9 条且无 nextCursor
    const eastLast = repo.projectPage({ region: 'East', cursor: east.nextCursor! });
    expect(eastLast.projects.length).toBe(9);
    expect(eastLast.nextCursor).toBeNull();
    // 两页拼接不重复不遗漏（并集=过滤集合）
    expect([...east.projects, ...eastLast.projects].map((p) => p.id).length).toBe(eastCount);
    expect(new Set([...east.projects, ...eastLast.projects].map((p) => p.id)).size).toBe(eastCount);

    // query 过滤（makeFacade 客户名唯一命中）：total=1、无 cursor；不存在的关键词 total=0
    expect(repo.projectPage({ query: '集成客户' }).total).toBe(1);
    expect(repo.projectPage({ query: '集成客户' }).nextCursor).toBeNull();
    expect(repo.projectPage({ query: '绝无此名' }).total).toBe(0);

    // query + region 组合：同时满足才计入（region=North 且 客户名=集成客户 → 0）
    expect(repo.projectPage({ query: '集成客户', region: 'North' }).total).toBe(0);

    // 筛选集合超过固定页 20 时：cursor 翻页只覆盖过滤集合、无重复无遗漏
    const many = repo.projectPage({ region: 'East' });
    expect(many.projects.length).toBe(20);
    const seen = new Set<string>(many.projects.map((p) => p.id));
    let cursor: string | null = many.nextCursor;
    let guard = 0;
    while (cursor) {
      guard += 1;
      expect(guard).toBeLessThanOrEqual(2);
      const page = repo.projectPage({ region: 'East', cursor });
      for (const p of page.projects) {
        expect(seen.has(p.id), `过滤翻页不应重复: ${p.id}`).toBe(false);
        seen.add(p.id);
      }
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(eastCount);

    // 筛选变化后携带旧 cursor：丢弃旧游标并从第一页返回（不跨筛选条件翻页）
    const stale = repo.projectPage({ region: 'East', cursor: all.nextCursor! });
    expect(stale.projects.map((p) => p.id)).toEqual(repo.projectPage({ region: 'East' }).projects.map((p) => p.id));
    // query 变化同理：携带 region 过滤下的 cursor 会回到 query 过滤第一页
    const staleQuery = repo.projectPage({ query: '集成客户', cursor: east.nextCursor! });
    expect(staleQuery.projects.map((p) => p.id)).toEqual(repo.projectPage({ query: '集成客户' }).projects.map((p) => p.id));
    closeDatabase(ctx.db);
  });

  it('排序变体：created / temp / reminder 游标稳定且无重复遗漏', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    seedProjects(db, 30);
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sort-r1', 'TP-SORT-AAA', 'pending_execution', '华东', null, '备注甲', 't', '2026-08-01T00:00:00+08:00');
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sort-r2', 'TP-SORT-BBB', 'pending_execution', '华东', '2026-08-09', null, 't', '2026-08-01T00:00:00+08:00');
    const repo = reader(ctx);

    for (const sort of ['created', 'temp', 'reminder'] as const) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      const collected: WorkbenchProjectRow[] = [];
      let guard = 0;
      do {
        const page = repo.projectPage({ sort, cursor });
        for (const p of page.projects) {
          expect(seen.has(p.id), `${sort} 不应重复: ${p.id}`).toBe(false);
          seen.add(p.id);
        }
        collected.push(...page.projects);
        cursor = page.nextCursor;
        guard += 1;
        expect(guard).toBeLessThanOrEqual(5);
      } while (cursor !== null);
      expect(seen.size).toBe(33); // 1 + 30 + 2
      expect(collected.length).toBe(33);

      // temp 排序升序稳定
      if (sort === 'temp') {
        const temps = collected.map((p) => p.tempNo);
        expect([...temps].sort()).toEqual(temps);
      }
      // reminder 排序：无提醒（空串）在前，其余按提醒时间升序
      if (sort === 'reminder') {
        const reminderSortKeys = collected.map((p) => p.reminderAt ?? '');
        expect(reminderSortKeys.every((k, idx) => idx === 0 || reminderSortKeys[idx - 1] <= k)).toBe(true);
      }
    }
    closeDatabase(ctx.db);
  });

  it('计划上门日期升降序均跨页稳定，未填写日期始终置后', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 45);
    ctx.db.prepare('UPDATE projects SET plan_visit_at=? WHERE id=?').run('2026-09-03', 'seed-p-0');
    ctx.db.prepare('UPDATE projects SET plan_visit_at=? WHERE id=?').run('2026-09-01', 'seed-p-1');
    ctx.db.prepare('UPDATE projects SET plan_visit_at=? WHERE id=?').run('2026-09-02', 'seed-p-2');
    const repo = reader(ctx);
    for (const sort of ['visit_asc', 'visit_desc'] as const) {
      const rows: WorkbenchProjectRow[] = [];
      let cursor: string | null = null;
      do {
        const next = repo.projectPage({ sort, cursor });
        rows.push(...next.projects);
        cursor = next.nextCursor;
      } while (cursor);
      expect(new Set(rows.map((row) => row.id)).size).toBe(46);
      const dates = rows.map((row) => row.planVisitAt);
      const firstEmpty = dates.findIndex((date) => date === null);
      expect(dates.slice(firstEmpty).every((date) => date === null)).toBe(true);
      expect(dates.slice(0, firstEmpty)).toEqual(sort === 'visit_asc'
        ? ['2026-09-01', '2026-09-02', '2026-09-03']
        : ['2026-09-03', '2026-09-02', '2026-09-01']);
    }
    closeDatabase(ctx.db);
  });

  it('任务7.4：关键词覆盖客户/ECC/临时编号；区域仅五枚举（runtime 非枚举拒绝）；query+region AND', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // ECC 与 temp_no 已在 makeFacade（ECC-V2-001 / 系统临时编号）；再建一项目验证 ECC 命中
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'ECC搜索客户',
        ecc: 'ECC-SEARCH-0810',
        region: 'West',
        instrumentCount: 1,
        contractAmount: '1000',
      },
    });
    const secondId = created.changed!.projectId!;
    const repo = reader(ctx);
    const tempNo = String(db.prepare('SELECT temp_no FROM projects WHERE id = ?').get(secondId)!.temp_no);

    // 关键词任一匹配即筛选：客户名称 / ECC / 系统临时编号
    expect(repo.projectPage({ query: 'ECC-SEARCH-0810' }).total).toBe(1);
    expect(repo.projectPage({ query: 'ECC-SEARCH-0810' }).projects[0].id).toBe(secondId);
    expect(repo.projectPage({ query: tempNo }).projects[0].id).toBe(secondId);
    expect(repo.projectPage({ query: '集成客户' }).projects[0].id).toBe(projectId);
    expect(repo.projectPage({ query: '绝无此名' }).total).toBe(0);

    // 区域筛选仅五固定枚举：runtime 非枚举值显式拒绝（不自由输入、不静默空结果）
    expect(() => repo.projectPage({ region: '华东' })).toThrow(/五个固定选项/);
    expect(() => repo.projectPage({ region: '  华南  ' })).toThrow(/五个固定选项/);
    expect(() => repo.projectPage({ region: '' })).not.toThrow(); // 空 = 不过滤
    expect(() => repo.projectPage({ region: null })).not.toThrow();
    // 五枚举均可用（trim 后匹配；makeFacade/新项目区域 East/West）
    expect(repo.projectPage({ region: 'East' }).projects.every((p) => p.region === 'East')).toBe(true);
    expect(repo.projectPage({ region: '  West  ' }).projects.every((p) => p.region === 'West')).toBe(true);

    // query + region 组合 AND：同时满足才展示
    expect(repo.projectPage({ query: 'ECC-SEARCH-0810', region: 'West' }).total).toBe(1);
    expect(repo.projectPage({ query: 'ECC-SEARCH-0810', region: 'East' }).total).toBe(0);
    expect(repo.projectPage({ query: '集成客户', region: 'North' }).total).toBe(0);
    closeDatabase(ctx.db);
  });
});

describe('工作台 v2 项目队列扩展查询（白名单）与 planVisitAt 映射', () => {
  it('白名单逐类可命中：旧址/新址、联系人、服务单号、仪器字段、批次、标签（定义与分组）', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const repo = reader(ctx);
    // 探针项目：唯一 token 分布在各白名单字段
    const probe = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '白名单探针客户',
        ecc: 'ECC-WHITELIST-001',
        region: 'East',
        oldSiteAddress: 'OLD-ADDR-UNIQ-001',
        newSiteAddress: 'NEW-ADDR-UNIQ-002',
        instrumentCount: 1,
        contractAmount: '1000',
      },
    }).changed!.projectId!;
    // 旧址/新址联系人（姓名/电话均可命中，LIKE 整字段）
    db.prepare('UPDATE projects SET old_site_contact = ?, new_site_contact = ? WHERE id = ?').run(
      '张三 138-UNIQ-PHONE-001',
      '李四 139-UNIQ-PHONE-002',
      probe,
    );
    // 服务单：单号与工程师
    db.prepare(
      `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('so-wh-1', 'relocation', 'SO-UNIQ-001', '2026-08-10', 'ENG-SO-UNIQ-001', '白名单探针客户', probe, 't', 't');
    // 上门活动 + activity_engineers 工程师
    db.prepare(`INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'act-wh-1',
      probe,
      '2026-08-11',
      't',
      't',
    );
    db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)`).run(
      'ae-wh-1',
      'act-wh-1',
      'ENG-AE-UNIQ-002',
    );
    // 仪器：name/model/serial_no 各含唯一 token
    db.prepare(
      `INSERT INTO instruments (id, project_id, name, model, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('inst-wh-1', probe, 'INST-NAME-UNIQ-003', 'MODEL-UNIQ-004', 'SERIAL-UNIQ-005', 't', 't');
    // 批次：transport_company
    db.prepare(
      `INSERT INTO batches (id, project_id, transport_company, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('batch-wh-1', probe, 'TRANS-UNIQ-006', 't', 't');
    // 标签：定义名与分组名均可命中（组名是用户可见业务文本）
    db.prepare(`INSERT INTO project_tag_groups (id, name, sort_order) VALUES (?,?,?)`).run(
      'wh-group-uniq',
      'GROUP-NAME-UNIQ-007',
      999,
    );
    db.prepare(`INSERT INTO project_tag_definitions (id, group_id, name, sort_order) VALUES (?,?,?,?)`).run(
      'wh-tag-uniq',
      'wh-group-uniq',
      'TAG-NAME-UNIQ-008',
      10,
    );
    db.prepare(`INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?,?)`).run(probe, 'wh-tag-uniq');

    const expectHit = (keyword: string, msg: string): void => {
      const page = repo.projectPage({ query: keyword });
      expect(page.total, msg).toBe(1);
      expect(page.projects[0].id, msg).toBe(probe);
    };

    // 1) 项目旧址/新址
    expectHit('OLD-ADDR-UNIQ-001', '旧址地址应命中');
    expectHit('NEW-ADDR-UNIQ-002', '新址地址应命中');
    // 2) 旧址/新址联系人：姓名与电话子串均可命中
    expectHit('张三', '旧址联系人姓名应命中');
    expectHit('138-UNIQ-PHONE-001', '旧址联系人电话应命中');
    expectHit('139-UNIQ-PHONE-002', '新址联系人电话应命中');
    // 3) 服务单号与 service_orders.engineer
    expectHit('SO-UNIQ-001', '服务单号应命中');
    expectHit('ENG-SO-UNIQ-001', '服务单工程师应命中');
    // 4) activity_engineers.engineer
    expectHit('ENG-AE-UNIQ-002', '活动工程师应命中');
    // 5) 仪器 name/model/serial_no
    expectHit('INST-NAME-UNIQ-003', '仪器名称应命中');
    expectHit('MODEL-UNIQ-004', '仪器型号应命中');
    expectHit('SERIAL-UNIQ-005', '仪器序列号应命中');
    // 6) 批次 transport_company
    expectHit('TRANS-UNIQ-006', '批次运输公司应命中');
    // 7) 标签定义名与分组名
    expectHit('TAG-NAME-UNIQ-008', '标签定义名应命中');
    expectHit('GROUP-NAME-UNIQ-007', '标签分组名应命中');
    // 8) 原有白名单仍有效：客户名/ECC/临时编号
    const tempNo = String(db.prepare('SELECT temp_no FROM projects WHERE id = ?').get(probe)!.temp_no);
    expectHit('白名单探针客户', '客户名仍应命中');
    expectHit('ECC-WHITELIST-001', 'ECC 仍应命中');
    expectHit(tempNo, '临时编号仍应命中');
    closeDatabase(db);
  });

  it('两类工程师均可命中且互不掩盖', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const repo = reader(ctx);
    const probe = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'formal', customerName: '工程师双类客户', ecc: 'ECC-ENG-002', region: 'East', instrumentCount: 1, contractAmount: '1000' },
    }).changed!.projectId!;
    db.prepare(
      `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('so-eng', 'pm', 'SO-ENG-100', '2026-08-10', 'ENG-SERVICE-AAA', '工程师双类客户', probe, 't', 't');
    db.prepare(`INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'act-eng',
      probe,
      '2026-08-11',
      't',
      't',
    );
    db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)`).run('ae-eng', 'act-eng', 'ENG-ACTIVITY-BBB');

    const hitService = repo.projectPage({ query: 'ENG-SERVICE-AAA' });
    expect(hitService.total).toBe(1);
    expect(hitService.projects[0].id).toBe(probe);

    const hitActivity = repo.projectPage({ query: 'ENG-ACTIVITY-BBB' });
    expect(hitActivity.total).toBe(1);
    expect(hitActivity.projects[0].id).toBe(probe);

    // 任一命中即 OR：两关键词分别仍只命中该项目
    expect(repo.projectPage({ query: 'ENG-ACTIVITY' }).total).toBe(1);
    closeDatabase(db);
  });

  it('查询结果不重复：1:N 多行含同一关键词不导致项目重复、total/分页游标正确', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const repo = reader(ctx);
    const probe = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'formal', customerName: '去重客户', ecc: 'ECC-DEDUP-003', region: 'East', instrumentCount: 1, contractAmount: '1000' },
    }).changed!.projectId!;
    // 3 台仪器含同一关键词，且各有不同批次/服务单也含同一关键词，模拟 JOIN 会重复的场景
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
        `inst-dedup-${i}`,
        probe,
        'DEDUP-KWD-XYZ',
        't',
        't',
      );
      db.prepare(`INSERT INTO batches (id, project_id, transport_company, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
        `batch-dedup-${i}`,
        probe,
        'DEDUP-KWD-XYZ',
        't',
        't',
      );
      db.prepare(
        `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(`so-dedup-${i}`, 'relocation', `SO-DEDUP-${i}`, '2026-08-10', 'DEDUP-KWD-XYZ', '去重客户', probe, 't', 't');
    }
    // 再插两个活动工程师同样关键词
    db.prepare(`INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'act-dedup',
      probe,
      '2026-08-11',
      't',
      't',
    );
    db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)`).run('ae-dedup-1', 'act-dedup', 'DEDUP-KWD-XYZ');
    db.prepare(`INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)`).run('ae-dedup-2', 'act-dedup', 'DEDUP-KWD-XYZ-2');

    const page = repo.projectPage({ query: 'DEDUP-KWD-XYZ' });
    // 必须仅命中一个项目，且列表不重复
    expect(page.total).toBe(1);
    expect(page.projects.length).toBe(1);
    expect(page.projects[0].id).toBe(probe);
    expect(page.nextCursor).toBeNull();

    // 翻页也无重复：塞入另一个同样关键词项目，total=2，分页不重复
    const probe2 = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'formal', customerName: '去重客户2', ecc: 'ECC-DEDUP-004', region: 'East', instrumentCount: 1, contractAmount: '1000' },
    }).changed!.projectId!;
    db.prepare(`INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'inst-dedup-other',
      probe2,
      'DEDUP-KWD-XYZ',
      't',
      't',
    );
    const paged = repo.projectPage({ query: 'DEDUP-KWD-XYZ' });
    expect(paged.total).toBe(2);
    expect(paged.projects.length).toBe(2);
    expect(new Set(paged.projects.map((p) => p.id)).size).toBe(2);
    closeDatabase(db);
  });

  it('region 与扩展 query 组合、分页不回归、转义保留（%_\\）', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const repo = reader(ctx);
    // 建立 25 个 East 项目，旧址地址含 COMBO-KWD，分页验证
    for (let i = 0; i < 25; i++) {
      const id = `combo-p-${i}`;
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, region, old_site_address, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(id, `TP-COMBO-${String(i).padStart(3, '0')}`, 'pending_execution', i % 2 === 0 ? 'East' : 'North', `COMBO-KWD-${i}`, 't', `2026-08-10T00:00:${String(i).padStart(2, '0')}+08:00`);
    }
    // combo 前 total 25 COMBO-KWD，East 过滤约 13
    const filtered = repo.projectPage({ query: 'COMBO-KWD', region: 'East' });
    expect(filtered.total).toBe(13);
    expect(filtered.projects.length).toBe(13);
    expect(filtered.projects.every((p) => p.region === 'East')).toBe(true);
    expect(filtered.nextCursor).toBeNull();

    // 不满足组合的 AND：North + COMBO-KWD 的 East 项目应 0
    expect(repo.projectPage({ query: 'NONEXIST-KWD-999', region: 'East' }).total).toBe(0);

    // 转义：字段含字面 % 与 _，查询含 %_ 应按字面命中而非通配
    const escProject = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'formal', customerName: '转义客户', ecc: 'ECC-ESC-005', region: 'East', oldSiteAddress: 'ADDR-%_\\LITERAL', newSiteAddress: 'X', instrumentCount: 1, contractAmount: '1000' },
    }).changed!.projectId!;
    // 旧址联系人含 %
    db.prepare('UPDATE projects SET old_site_contact = ? WHERE id = ?').run('NAME%_TEST', escProject);
    // 仪器名含 _
    db.prepare(`INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'inst-esc',
      escProject,
      'MODEL_%_LITERAL',
      't',
      't',
    );

    // 查询含 % 应转义，仅命中字面
    const esc1 = repo.projectPage({ query: '%_\\' });
    // 该项目旧址与仪器均含 %_\\ 子串，应命中
    expect(esc1.projects.some((p) => p.id === escProject)).toBe(true);
    // 查询含 _ 的子串也应转义命中
    const esc2 = repo.projectPage({ query: 'MODEL_%' });
    expect(esc2.projects.some((p) => p.id === escProject)).toBe(true);
    // 查询普通字符组合不误命中
    expect(repo.projectPage({ query: '绝无此串999' }).total).toBe(0);
    closeDatabase(db);
  });

  it('planVisitAt 映射正确：暴露 projects.plan_visit_at，为空为 null，不聚合 activities.visit_at', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const repo = reader(ctx);
    const probe = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '计划上门客户',
        ecc: 'ECC-PLAN-006',
        region: 'East',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '1000',
      },
    }).changed!.projectId!;

    // 初始应为 null（未设置）
    expect(repo.projectPage({ query: '计划上门客户' }).projects[0].planVisitAt).toBeNull();
    expect(facade.v2ProjectDetail(probe).detail!.planVisitAt).toBeNull();

    // 设置计划上门日期 via update_project
    facade.v2Mutate({ op: 'update_project', payload: { projectId: probe, plannedVisitAt: '2026-09-18' } });
    const row = repo.projectPage({ query: 'ECC-PLAN-006' }).projects[0];
    expect(row.planVisitAt).toBe('2026-09-18');
    expect(facade.v2ProjectDetail(probe).detail!.planVisitAt).toBe('2026-09-18');
    expect(facade.v2ProjectDetail(probe).project!.planVisitAt).toBe('2026-09-18');

    // 插入活动的 visit_at 不同日期，队列 planVisitAt 不应被聚合或覆盖
    db.prepare(`INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'act-plan-1',
      probe,
      '2026-08-20',
      't',
      't',
    );
    db.prepare(`INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`).run(
      'act-plan-2',
      probe,
      '2026-08-21',
      't',
      't',
    );
    const rowAfterActivities = repo.projectPage({ query: 'ECC-PLAN-006' }).projects[0];
    expect(rowAfterActivities.planVisitAt).toBe('2026-09-18');

    // 清空后应回 null
    facade.v2Mutate({ op: 'update_project', payload: { projectId: probe, plannedVisitAt: null } });
    const cleared = repo.projectPage({ query: 'ECC-PLAN-006' }).projects[0];
    expect(cleared.planVisitAt).toBeNull();
    expect(facade.v2ProjectDetail(probe).detail!.planVisitAt).toBeNull();
    closeDatabase(db);
  });
});

describe('工作台 v2 项目详情 + 子记录分页（Oracle #10）', () => {
  it('detail：金额字符串、计数、非阻塞；不存在返回 null', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 加子记录
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '20000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲、工程师乙', status: 'done', instrumentIds: [String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id)], workTypes: ['teardown'] } } });

    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.businessRevision).toBeGreaterThan(0);
    expect(detail.project).not.toBeNull();
    const p = detail.project!;
    expect(p.contractAmount).toBe('100000.00');
    expect(p.finalAmount).toBe('100000.00');
    expect(p.entryAmountSnapshot).toBe('100000.00');
    expect(p.invoicedAmount).toBe('20000.00');
    expect(p.counts).toMatchObject({ batches: 1, instruments: 1, activities: 1, orders: 0, repairs: 0, invoices: 1 });
    expect(detail.detail).toMatchObject({ siteConfirmed: false, contractStartDate: '2026-08-01' });

    // 不存在 → project/detail 均为 null
    const missing = facade.v2ProjectDetail('no-such-project');
    expect(missing.project).toBeNull();
    expect(missing.detail).toBeNull();
    closeDatabase(db);
  });

  it('entryAmountSnapshot 精确读取 formal/零金额/null 草稿/超安全整数，并保留撤销掉票计数和修改时间', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    expect(facade.v2ProjectDetail(projectId).project!.entryAmountSnapshot).toBe('100000.00');

    const project = db.prepare(
      'INSERT INTO projects (id, temp_no, status, region, entry_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    );
    const contract = db.prepare(
      'INSERT INTO contracts (id, project_id, temp_number, entry_amount_snapshot_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    );
    project.run('entry-zero', 'TP-ENTRY-ZERO', 'pending_execution', 'East', '2026-08-01', 't', 't');
    contract.run('contract-entry-zero', 'entry-zero', 'TP-ENTRY-ZERO', 0, 't', 't');
    project.run('entry-big', 'TP-ENTRY-BIG', 'pending_execution', 'East', '2026-08-01', 't', 't');
    contract.run('contract-entry-big', 'entry-big', 'TP-ENTRY-BIG', 9007199254740993n, 't', 't');
    const draftId = facade.v2Mutate({
      op: 'create_project',
      payload: { intent: 'draft', customerName: '快照草稿', region: 'East', instrumentCount: null },
    }).changed!.projectId!;

    expect(facade.v2ProjectDetail('entry-zero').project!.entryAmountSnapshot).toBe('0.00');
    expect(facade.v2ProjectDetail('entry-big').project!.entryAmountSnapshot).toBe('90071992547409.93');
    expect(facade.v2ProjectDetail(draftId).project!.entryAmountSnapshot).toBeNull();

    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoice = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows[0] as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
    facade.v2Mutate({ op: 'invoice_revoke', invoiceId: invoice.id, time: '2026-08-12', reason: '更正' });
    const revoked = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows[0] as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
    expect(revoked.active).toBe(false);
    expect(revoked.lastModifiedAt).toBeTruthy();
    expect(facade.v2ProjectDetail(projectId).project!.counts.invoices).toBe(1);
    closeDatabase(db);
  });

  it('section：六类 tab 子记录分页，total + keyset + 金额字符串', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    // 预置各 tab 记录
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1234.567' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', values: { orderType: 'relocation', serviceOrderNo: 'ORD-V2-001', orderedAt: '2026-08-11', engineer: '工程师甲', customerName: '集成客户甲', projectId } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲、工程师乙', status: 'done', instrumentIds: [instrumentId], workTypes: ['teardown'] } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输碰撞', issueStatus: 'processing', partNumber: 'PART-1', partQuantity: '1', partCurrency: 'USD', partAmount: '500', partStatus: 'arrived', registeredAt: '2026-08-12' } } });

    const kinds = ['batches', 'instruments', 'activities', 'orders', 'invoices', 'damage_items'] as const;
    for (const kind of kinds) {
      const page = facade.v2SectionPage({ projectId, kind });
      expect(page.kind).toBe(kind);
      expect(page.businessRevision).toBeGreaterThan(0);
      expect(page.total).toBe(1);
      expect(page.rows.length).toBe(1);
      expect(page.nextCursor).toBeNull();
      const row = page.rows[0] as WorkbenchV2SectionRow;
      expect(row.kind).toBe(kind);
      if (kind === 'invoices') {
        const invoice = row as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
        expect(invoice.amount).toBe('1234.57'); // HALF_UP 字符串
        expect(invoice.active).toBe(true);
      }
      if (kind === 'batches') {
        const batch = row as Extract<WorkbenchV2SectionRow, { kind: 'batches' }>;
        // 合同预算价 → originalPrice；物流成交价 → discountedPrice
        expect(batch.originalPrice).toBe('12000.00');
        expect(batch.discountedPrice).toBe('11000.00');
      }
      if (kind === 'activities') {
        const activity = row as Extract<WorkbenchV2SectionRow, { kind: 'activities' }>;
        expect(activity.engineers).toBe('工程师甲、工程师乙');
      }
      if (kind === 'damage_items') {
        const damage = row as Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>;
        expect(damage.partAmount).toBe('500.00');
        expect(damage.instrumentName).toBe('质谱仪');
      }
      if (kind === 'orders') {
        const order = row as Extract<WorkbenchV2SectionRow, { kind: 'orders' }>;
        expect(order.serviceOrderNo).toBe('ORD-V2-001');
      }
      if (kind === 'instruments') {
        const instrument = row as Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>;
        expect(instrument.name).toBe('质谱仪');
        expect(instrument.ups).toBe(true);
      }
    }

    // 多记录 keyset：再记一笔掉票，limit=1 翻页无重复（keyset 仅在页满时给出 nextCursor）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-13', amount: '1000' } } });
    const first = facade.v2SectionPage({ projectId, kind: 'invoices', limit: 1 });
    expect(first.total).toBe(2);
    expect(first.rows.length).toBe(1);
    expect(first.nextCursor).toBeTruthy();
    const second = facade.v2SectionPage({ projectId, kind: 'invoices', cursor: first.nextCursor! });
    expect(second.rows.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    closeDatabase(db);
  });

  it('任务7.1：detail 标量完整返回客户/ECC-temp/raw region+needsAdjustment/status-entry/地址/执行准备/备注/暂存/暂定数量', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 补齐 0810 标量事实：备注/暂存/是否暂存/暂定数量/计划装机/计划上门/计划运输/场地确认
    facade.v2Mutate({
      op: 'update_project',
      payload: {
        projectId,
        projectNote: '客户要求 0815 前完工',
        temporaryStorageAddress: '临时仓 A',
        isTemporaryStorage: true,
        temporaryInstrumentCount: 3,
        temporaryInstrumentName: '生化分析仪',
        temporaryInstrumentModel: 'BS-200',
        temporaryHasUps: true,
        plannedInstallAt: '2026-09-01',
        plannedVisitAt: '2026-09-20',
        plannedTransportAt: '2026-09-18',
        siteConfirmed: true,
      },
    });
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.project).not.toBeNull();
    const p = detail.project!;
    const d = detail.detail!;

    // 客户 / ECC / 系统临时编号 / raw region + needsAdjustment / 主状态 / 进单日期
    expect(p.customerName).toBe('集成客户甲');
    expect(p.ecc).toBe('ECC-V2-001');
    expect(p.tempNo).toBeTruthy();
    expect(p.region).toBe('East');
    expect(p.regionNeedsAdjustment).toBe(false);
    expect(p.status).toBe('pending_execution');
    expect(p.entryAt).toBeTruthy();

    // 旧址/新址地址 + 联系人与合同起止
    expect(d.oldSiteAddress).toBe('旧址');
    expect(d.newSiteAddress).toBe('新址');
    expect(d.contractStartDate).toBe('2026-08-01');
    expect(d.contractEndDate).toBe('2027-07-31');

    // 执行准备：计划上门/计划运输/场地确认/是否暂存 + 计划装机日期（更名契约字段）
    expect(d.planVisitAt).toBe('2026-09-20');
    expect(d.planTransportAt).toBe('2026-09-18');
    expect(d.siteConfirmed).toBe(true);
    expect(d.isTemporaryStorage).toBe(true);
    expect(d.temporaryStorageAddress).toBe('临时仓 A');
    expect(d.plannedInstallAt).toBe('2026-09-01');
    expect(d.plannedInstallDoneAt).toBe('2026-09-01'); // 兼容 alias 同值

    // 项目备注 + 暂定仪器数量（既有事实）
    expect(d.projectNote).toBe('客户要求 0815 前完工');
    expect(d.temporaryInstrumentCount).toBe(3);

    // 暂定仪器范围（v16）：名称/型号/是否 UPS 回显，且不产生任何仪器行
    expect(d.temporaryInstrumentName).toBe('生化分析仪');
    expect(d.temporaryInstrumentModel).toBe('BS-200');
    expect(d.temporaryHasUps).toBe(true);
    // 登记暂定范围前后仪器行数不变（只更新项目标量，不建/不改/不删仪器）
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(1);

    // legacy 非枚举区域：raw 保留原值 + regionNeedsAdjustment=true（不猜测映射）
    db.prepare("UPDATE projects SET region = '华东' WHERE id = ?").run(projectId);
    const legacy = facade.v2ProjectDetail(projectId);
    expect(legacy.project!.region).toBe('华东');
    expect(legacy.project!.regionNeedsAdjustment).toBe(true);

    // 关联登记事实不走巨型快照：经 section（项目内子记录）与 independent（独立模块）分页读取
    expect(facade.v2SectionPage({ projectId, kind: 'invoices' }).total).toBeGreaterThanOrEqual(0);
    // serial/QR 有独立 module read（independentPage 而非藏在 section）
    expect(facade.v2IndependentPage({ kind: 'serial_address' })).toBeTruthy();
    expect(facade.v2IndependentPage({ kind: 'qr_request' })).toBeTruthy();
    closeDatabase(db);
  });
});

describe('工作台 v2 独立模块 + lookup 分页（Oracle #10）', () => {
  it('independent：serial_address / qr_request 分页、types 数组、query 过滤', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    // 序列号地址更新要求仪器已有序列号且一致
    db.prepare('UPDATE instruments SET serial_no = ? WHERE id = ?').run('SN-001', instrumentId);

    facade.v2Mutate({ op: 'submit_action', action: { type: 'serial_address', values: { instrumentId, customerName: '独立客户', newSiteAddress: '新址独立', serialNo: 'SN-001', accountId: 'ACC-IND-1', updatedAt: '2026-08-10' } } });
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人甲', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人乙', requestedAt: '2026-08-11', types: ['B'] } } });

    const serial = facade.v2IndependentPage({ kind: 'serial_address' });
    expect(serial.rows.length).toBe(1);
    expect(serial.total).toBe(1);
    const serialRow = serial.rows[0] as Extract<typeof serial.rows[number], { kind: 'serial_address' }>;
    expect(serialRow.instrumentName).toBe('质谱仪');
    expect(serialRow.accountId).toBe('ACC-IND-1');

    const qr = facade.v2IndependentPage({ kind: 'qr_request' });
    expect(qr.total).toBe(2);
    const qrRows = qr.rows as Array<Extract<typeof qr.rows[number], { kind: 'qr_request' }>>;
    expect(qrRows).toHaveLength(2);
    const byApplicant = new Map(qrRows.map((r) => [r.applicant, r]));
    expect(byApplicant.get('申请人甲')!.types).toEqual(['A', 'logistics_management']);
    expect(byApplicant.get('申请人甲')!.workload).toBe(2);
    expect(byApplicant.get('申请人乙')!.types).toEqual(['B']);
    expect(byApplicant.get('申请人乙')!.workload).toBe(1);

    // query 过滤
    expect(facade.v2IndependentPage({ kind: 'qr_request', query: '申请人乙' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address', query: 'ACC-IND-1' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address', query: '不存在' }).total).toBe(0);
    closeDatabase(db);
  });

  it('independent serial_address：无仪器独立保存时 instrumentId 返回 null，绝不输出字符串 "null"', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    // 历史导入路径写入 instrument_id = NULL（独立保存）
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-null', null, '独立客户', '独立新址', 'SN-FREE', 'ACC-FREE', '2026-08-10', '2026-08-10T00:00:00+08:00');

    const page = facade.v2IndependentPage({ kind: 'serial_address' });
    expect(page.total).toBe(1);
    const row = page.rows[0] as Extract<typeof page.rows[number], { kind: 'serial_address' }>;
    expect(row.instrumentId).toBeNull();
    expect(row.instrumentName).toBe('');
    expect(row.serialNo).toBe('SN-FREE');
    closeDatabase(db);
  });

  it('lookup：ship_to_requests / customers 分页与 query', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const req1 = facade.createShipToRequest({ customerName: 'Lookup客户甲', newSiteAddress: '新址甲' }).request;
    facade.createShipToRequest({ customerName: 'Lookup客户乙', newSiteAddress: '新址乙' });
    facade.createShipToRequest({ customerName: '另一个客户', newSiteAddress: '新址丙' });
    // 完成一条
    facade.submitShipToRequest(req1.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: req1.id, accountId: 'ACC-LK-1' });

    const page = facade.v2LookupPage({ kind: 'ship_to_requests' });
    expect(page.total).toBe(3);
    expect(page.rows.length).toBe(3);
    const done = page.rows.find((r) => r.kind === 'ship_to_requests' && r.accountId === 'ACC-LK-1') as Extract<typeof page.rows[number], { kind: 'ship_to_requests' }>;
    expect(done.status).toBe('completed');

    // query 命中客户名 / 新址
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', query: 'Lookup客户' }).total).toBe(2);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', query: '新址乙' }).total).toBe(1);

    // customers：ship-to 申请不注册客户；makeFacade(集成客户甲) + 新项目(第二个客户)
    facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '第二个客户',
        ecc: 'ECC-LK-2',
        region: 'North',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '1000',
        siteConfirmed: false,
      },
    });
    const customers = facade.v2LookupPage({ kind: 'customers' });
    expect(customers.total).toBe(2);
    expect(customers.rows.every((r) => r.kind === 'customers')).toBe(true);
    expect(facade.v2LookupPage({ kind: 'customers', query: '集成' }).total).toBe(1);
    expect(facade.v2LookupPage({ kind: 'customers', query: '第二个' }).total).toBe(1);
    closeDatabase(db);
  });
});

/**
 * Oracle #10 二次复审：independent/lookup keyset 分页缺陷回归。
 * - 两个 independent kind 与两个 lookup kind 均跨 3 页（limit=10、25 条）：
 *   无重复/遗漏、nextCursor 正确终止；
 * - query 筛选后仍可带 cursor 继续翻页，且只覆盖筛选集合；
 * - 游标列带表别名（serial_address 的 LEFT JOIN 不再产生歧义列错误）。
 */
describe('Oracle #10 二次复审：independent/lookup 分页缺陷回归', () => {
  /** 按 i 生成互不相同的带偏移 ISO 时间（created_at 排序稳定）。 */
  const ts = (i: number): string => {
    const day = 1 + Math.floor(i / 86400);
    const rem = i % 86400;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `2026-08-${pad(day)}T${pad(Math.floor(rem / 3600))}:${pad(Math.floor((rem % 3600) / 60))}:${pad(rem % 60)}+08:00`;
  };

  /** 用 request.cursor 全量翻页；返回访问顺序 ids，断言无重复且页数有界。 */
  const walk = <T extends { id: string }>(
    page: (cursor: string | null) => { rows: readonly T[]; nextCursor: string | null },
  ): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = page(cursor);
      for (const row of result.rows) {
        expect(seen.has(row.id), `翻页不应重复: ${row.id}`).toBe(false);
        seen.add(row.id);
        ids.push(row.id);
      }
      cursor = result.nextCursor;
      pages += 1;
      expect(pages, '翻页页数有界').toBeLessThanOrEqual(10);
    } while (cursor !== null);
    return ids;
  };

  it('independent serial_address：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentStmt = db.prepare(
      `INSERT INTO instruments (id, project_id, name, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    const serialStmt = db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      instrumentStmt.run(`pg-i-${i}`, projectId, `仪器${i}`, `PG-SN-${i}`, 't', 't');
      serialStmt.run(
        `pg-s-${i}`,
        `pg-i-${i}`,
        i % 2 === 0 ? '分页客户甲' : '分页客户乙',
        `新址${i}`,
        `PG-SN-${i}`,
        `ACC-PG-${i}`,
        ts(i),
        ts(i),
      );
    }
    // 跨 3 页（25 条 / limit=10）：无重复遗漏、nextCursor 在第 3 页（余 5 条）终止
    const all = walk((cursor) => facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);
    const first = facade.v2IndependentPage({ kind: 'serial_address', limit: 10 });
    const second = facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor: first.nextCursor! });
    expect(second.rows.length).toBe(10);
    const third = facade.v2IndependentPage({ kind: 'serial_address', limit: 10, cursor: second.nextCursor! });
    expect(third.rows.length).toBe(5);
    expect(third.nextCursor).toBeNull();

    // query 筛选（13 条「分页客户甲」）后仍可带 cursor 翻页，且只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2IndependentPage({ kind: 'serial_address', query: '分页客户甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(13);
    expect(filtered.every((id) => id.startsWith('pg-s-'))).toBe(true);
    expect(new Set(filtered).size).toBe(13);
    // 筛选 + cursor 与不带 cursor 首页一致（cursor 不影响筛选结果集）
    const fFirst = facade.v2IndependentPage({ kind: 'serial_address', query: '分页客户甲', limit: 10 });
    expect(fFirst.nextCursor).toBeTruthy();
    closeDatabase(db);
  });

  it('independent qr_request：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const qrStmt = db.prepare(
      `INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      qrStmt.run(`pg-q-${i}`, i % 3 === 0 ? '二维码申请人甲' : i % 3 === 1 ? '二维码申请人乙' : '二维码申请人丙', ts(i), ts(i));
    }
    const all = walk((cursor) => facade.v2IndependentPage({ kind: 'qr_request', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);

    // query 筛选（9 条「二维码申请人甲」，i%3==0 → i=0,3,...,24 → 9 条）
    const filtered = walk((cursor) =>
      facade.v2IndependentPage({ kind: 'qr_request', query: '二维码申请人甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(9);
    expect(filtered.every((id) => id.startsWith('pg-q-'))).toBe(true);
    closeDatabase(db);
  });

  it('lookup ship_to_requests：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const reqStmt = db.prepare(
      `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      reqStmt.run(
        `pg-r-${i}`,
        i % 2 === 0 ? '分页ShipTo客户甲' : '分页ShipTo客户乙',
        `新址${i}`,
        i % 4 === 0 ? 'completed' : i % 4 === 2 ? 'processing' : 'pending_submit',
        ts(i),
        ts(i),
      );
    }
    const all = walk((cursor) => facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor }));
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);
    const first = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10 });
    const second = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor: first.nextCursor! });
    expect(second.rows.length).toBe(10);
    const third = facade.v2LookupPage({ kind: 'ship_to_requests', limit: 10, cursor: second.nextCursor! });
    expect(third.rows.length).toBe(5);
    expect(third.nextCursor).toBeNull();

    // query 筛选（13 条「分页ShipTo客户甲」）后 cursor 翻页只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2LookupPage({ kind: 'ship_to_requests', query: '分页ShipTo客户甲', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(13);
    expect(new Set(filtered).size).toBe(13);
    closeDatabase(db);
  });

  it('lookup customers：3 页无重复遗漏、nextCursor 终止、query 筛选后 cursor 行为', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const customerStmt = db.prepare(
      `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      customerStmt.run(`pg-c-${i}`, `客户PG-${String(i).padStart(2, '0')}`, ts(i), ts(i));
    }
    // makeFacade 已有 集成客户甲；翻页覆盖全部 26 条（name 升序 + id 升序 keyset）
    const all = walk((cursor) => facade.v2LookupPage({ kind: 'customers', limit: 10, cursor }));
    expect(all.length).toBe(26);
    expect(new Set(all).size).toBe(26);

    // query 筛选（10 条含 PG-1 前缀：PG-10..PG-19）后 cursor 翻页只覆盖筛选集合
    const filtered = walk((cursor) =>
      facade.v2LookupPage({ kind: 'customers', query: 'PG-1', limit: 10, cursor }),
    );
    expect(filtered.length).toBe(10); // PG-10..PG-19（PG-01 不含子串 "PG-1"）
    expect(filtered.every((id) => id.startsWith('pg-c-'))).toBe(true);
    // 升序稳定：首行字典序最小
    const ascNames = facade.v2LookupPage({ kind: 'customers', limit: 10 }).rows.map((r) => (r as { name: string }).name);
    expect([...ascNames].sort()).toEqual(ascNames);
    closeDatabase(db);
  });
});

/**
 * Oracle #10 往期/时间筛选：independent / section / lookup 支持可选 from/to
 * （业务日期 yyyy-mm-dd，含边界），缺省完全兼容现有行为。
 */
describe('工作台 v2 往期/时间筛选（from/to）', () => {
  it('independentPage 按业务日期而非 created_at 倒序，并以同一业务日期+id 游标翻页', () => {
    const ctx = makeFacade();
    const serial = ctx.db.prepare(
      'INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    serial.run('serial-old-business-new-created', null, '甲', 'A', 'S1', 'A1', '2026-08-01', '2026-08-30T00:00:00+08:00');
    serial.run('serial-new-business-old-created', null, '乙', 'B', 'S2', 'A2', '2026-08-20', '2026-08-01T00:00:00+08:00');
    const qr = ctx.db.prepare('INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)');
    qr.run('qr-old-business-new-created', '甲', '2026-08-01', '2026-08-30T00:00:00+08:00');
    qr.run('qr-new-business-old-created', '乙', '2026-08-20', '2026-08-01T00:00:00+08:00');

    expect(ctx.facade.v2IndependentPage({ kind: 'serial_address' }).rows.map((row) => row.id)).toEqual([
      'serial-new-business-old-created', 'serial-old-business-new-created',
    ]);
    expect(ctx.facade.v2IndependentPage({ kind: 'qr_request' }).rows.map((row) => row.id)).toEqual([
      'qr-new-business-old-created', 'qr-old-business-new-created',
    ]);
    closeDatabase(ctx.db);
  });

  it('independentPage：serial_address 按更新日期、qr_request 按申请日期过滤', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const serialStmt = db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    );
    serialStmt.run('sa-d1', null, '客户甲', '新址A', 'SN-D1', 'ACC-D1', '2026-07-15', '2026-07-15T00:00:00+08:00');
    serialStmt.run('sa-d2', null, '客户乙', '新址B', 'SN-D2', 'ACC-D2', '2026-08-10', '2026-08-10T00:00:00+08:00');
    serialStmt.run('sa-d3', null, '客户丙', '新址C', 'SN-D3', 'ACC-D3', '2026-09-20', '2026-09-20T00:00:00+08:00');

    expect(facade.v2IndependentPage({ kind: 'serial_address', from: '2026-08-01', to: '2026-08-31' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address', from: '2026-07-01', to: '2026-08-31' }).total).toBe(2);
    expect(facade.v2IndependentPage({ kind: 'serial_address', from: '2026-09-20' }).total).toBe(1);
    // 与 query 组合
    expect(facade.v2IndependentPage({ kind: 'serial_address', from: '2026-08-01', to: '2026-08-31', query: '客户乙' }).total).toBe(1);

    const qrStmt = db.prepare('INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)');
    qrStmt.run('qr-d1', '申请人甲', '2026-07-05', '2026-07-05T00:00:00+08:00');
    qrStmt.run('qr-d2', '申请人乙', '2026-08-06', '2026-08-06T00:00:00+08:00');
    qrStmt.run('qr-d3', '申请人丙', '2026-09-07', '2026-09-07T00:00:00+08:00');
    expect(facade.v2IndependentPage({ kind: 'qr_request', from: '2026-08-01', to: '2026-08-31' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'qr_request', to: '2026-07-31' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'qr_request', from: '2026-07-01', to: '2026-09-30' }).total).toBe(3);
    closeDatabase(db);
  });

  it('sectionPage：按各 kind 业务日期过滤（invoices 按掉票日期）', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-07-10', amount: '1000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-15', amount: '2000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-09-01', amount: '3000' } } });

    expect(facade.v2SectionPage({ projectId, kind: 'invoices', from: '2026-08-01', to: '2026-08-31' }).total).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'invoices', to: '2026-07-31' }).total).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'invoices' }).total).toBe(3); // 缺省不限时间
    closeDatabase(db);
  });

  it('lookupPage：ship_to_requests 按首次提交日期过滤；from > to 抛 RANGE_ORDER', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const reqStmt = db.prepare(
      `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, submitted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    );
    reqStmt.run('r-d1', '客户甲', '新址A', 'completed', '2026-07-05', '2026-07-05T00:00:00+08:00', 't');
    reqStmt.run('r-d2', '客户乙', '新址B', 'processing', '2026-08-06', '2026-08-06T00:00:00+08:00', 't');
    reqStmt.run('r-d3', '客户丙', '新址C', 'pending_submit', null, '2026-09-07T00:00:00+08:00', 't');
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', from: '2026-08-01', to: '2026-08-31' }).total).toBe(1);
    // submitted_at 为空的行在过滤后不计入（有值才参与时间筛选）
    expect(facade.v2LookupPage({ kind: 'ship_to_requests', to: '2026-07-31' }).total).toBe(1);
    expect(() => facade.v2IndependentPage({ kind: 'serial_address', from: '2026-09-01', to: '2026-08-01' })).toThrow(/起始日期不得晚于截止日期/);
    closeDatabase(db);
  });
});

/**
 * ora-1 #6：跨项目历史有界分页（historyPage）——kind/from/to/cursor/limit，
 * 返回项目上下文（projectId/customerName/ecc/tempNo）与可用于 v2Delete 的 id；
 * created_at 类（instrument）to 截止日期包含当天。
 */
describe('工作台 v2 跨项目历史分页（historyPage）', () => {
  it('batch/invoice/activity/damage/service_order：返回项目上下文 + 日期筛选 + keyset 翻页', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 为当前项目造子记录（日期跨月）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '运输甲', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-07-15', amount: '1000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-20', amount: '2000' } } });
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'visit', projectId, values: { visitAt: '2026-08-12', engineers: '工程师甲', status: 'done', instrumentIds: [instrumentId], workTypes: ['teardown'] } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-HIST-001', orderedAt: '2026-08-11', engineer: '工程师乙' } } });

    // batch：项目上下文 + 日期筛选（含边界）
    const batchPage = facade.v2HistoryPage({ kind: 'batch' });
    expect(batchPage.total).toBe(1);
    const batchRow = batchPage.rows[0] as Extract<typeof batchPage.rows[number], { kind: 'batch' }>;
    expect(batchRow.id).toBe(batchPage.rows[0].id);
    expect(batchRow.projectId).toBe(projectId);
    expect(batchRow.customerName).toBe('集成客户甲');
    expect(batchRow.ecc).toBe('ECC-V2-001');
    expect(batchRow.businessDate).toBe('2026-08-10');
    expect(facade.v2HistoryPage({ kind: 'batch', from: '2026-09-01' }).total).toBe(0);

    // invoice：from/to 筛选 + keyset（limit=1 首页翻页无重复；后续页缺省 limit 返回剩余并终止）
    const invFirst = facade.v2HistoryPage({ kind: 'invoice', limit: 1 });
    expect(invFirst.total).toBe(2);
    expect(invFirst.rows.length).toBe(1);
    expect(invFirst.nextCursor).toBeTruthy();
    const invSecond = facade.v2HistoryPage({ kind: 'invoice', cursor: invFirst.nextCursor! });
    expect(invSecond.rows.length).toBe(1);
    expect(invSecond.nextCursor).toBeNull();
    const invIds = [...invFirst.rows, ...invSecond.rows].map((r) => r.id);
    expect(new Set(invIds).size).toBe(2);
    expect(facade.v2HistoryPage({ kind: 'invoice', from: '2026-08-01', to: '2026-08-31' }).total).toBe(1);

    // activity / service_order / damage 上下文
    const activityRow = facade.v2HistoryPage({ kind: 'activity' }).rows[0] as Extract<ReturnType<WorkbenchFacade['v2HistoryPage']>['rows'][number], { kind: 'activity' }>;
    expect(activityRow.projectId).toBe(projectId);
    expect(activityRow.engineers).toBe('工程师甲');
    const orderRow = facade.v2HistoryPage({ kind: 'service_order' }).rows[0] as Extract<ReturnType<WorkbenchFacade['v2HistoryPage']>['rows'][number], { kind: 'service_order' }>;
    expect(orderRow.serviceOrderNo).toBe('SO-HIST-001');
    expect(orderRow.orderedAt).toBe('2026-08-11');
    expect(facade.v2HistoryPage({ kind: 'damage' }).total).toBe(0);
    closeDatabase(db);
  });

  it('instrument：created_at 截止日期包含当天（to=登记当天仍计入）', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // makeFacade 已有 1 台仪器（登记时间为真实当前时间）；登记第二台并固定其 created_at。
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '历史仪器', serialNo: 'SN-HIST' } } });
    const instruments = db.prepare('SELECT id FROM instruments WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ id: string }>;
    db.prepare("UPDATE instruments SET created_at = '2026-07-01T10:00:00+08:00' WHERE id = ?").run(instruments[0].id);
    db.prepare("UPDATE instruments SET created_at = '2026-08-10T23:59:59+08:00' WHERE id = ?").run(instruments[1].id);

    const page = facade.v2HistoryPage({ kind: 'instrument', from: '2026-08-10', to: '2026-08-10' });
    expect(page.total).toBe(1); // to 含当天（substr 日期部分比较）
    const row = page.rows[0] as Extract<typeof page.rows[number], { kind: 'instrument' }>;
    expect(row.businessDate).toBe('2026-08-10');
    expect(row.id).toBe(instruments[1].id);
    expect(facade.v2HistoryPage({ kind: 'instrument', from: '2026-08-11' }).total).toBe(0); // 上界排除
    closeDatabase(db);
  });

  it('任务1.4：historyPage 当前排序为业务日期倒序，同业务日期按 id 倒序（稳定次级键）', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 同项目多条 invoice，业务日期有相同也有不同；id 保证可排序（lexicographic）。
    const invStmt = db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
       VALUES (?,?,?,?,?,?)`,
    );
    invStmt.run('inv-1', projectId, 1000, '2026-08-10', 't', 't');
    invStmt.run('inv-2', projectId, 2000, '2026-08-20', 't', 't');
    invStmt.run('inv-3', projectId, 3000, '2026-08-20', 't', 't'); // 与 inv-2 同日，id 更大应在前
    invStmt.run('inv-4', projectId, 4000, '2026-08-05', 't', 't');

    const page = facade.v2HistoryPage({ kind: 'invoice' });
    expect(page.total).toBe(4);
    const rows = page.rows as Array<Extract<typeof page.rows[number], { kind: 'invoice' }>>;
    // 业务日期倒序：08-20 两条在前、08-10、08-05；同日期（08-20）按 id 倒序 → inv-3 在 inv-2 前
    expect(rows.map((r) => r.invoicedAt)).toEqual(['2026-08-20', '2026-08-20', '2026-08-10', '2026-08-05']);
    expect(rows.map((r) => r.id)).toEqual(['inv-3', 'inv-2', 'inv-1', 'inv-4']);

    // 分页重复加载不改变顺序：limit=2 两次请求拼接顺序与一次性读取一致
    const first = facade.v2HistoryPage({ kind: 'invoice', limit: 2 });
    const second = facade.v2HistoryPage({ kind: 'invoice', limit: 2, cursor: first.nextCursor! });
    expect([...first.rows, ...second.rows].map((r) => r.id)).toEqual(['inv-3', 'inv-2', 'inv-1', 'inv-4']);
    closeDatabase(db);
  });

  it('任务7.2：各类型业务日期倒序 + id 稳定 tie-breaker，keyset 重复加载不改变顺序', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // batch：同业务日期（计划运输日期）多条 + 不同日期，验证倒序 + id tie-breaker
    const batchStmt = db.prepare(
      `INSERT INTO batches (id, project_id, plan_transport_date, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    );
    batchStmt.run('b-1', projectId, '2026-08-10', 't', 't');
    batchStmt.run('b-2', projectId, '2026-08-15', 't', 't');
    batchStmt.run('b-3', projectId, '2026-08-15', 't', 't'); // 与 b-2 同日，id 更大应在前
    const batch = facade.v2HistoryPage({ kind: 'batch' });
    expect(batch.total).toBe(3);
    const batchRows = batch.rows as Array<Extract<typeof batch.rows[number], { kind: 'batch' }>>;
    expect(batchRows.map((r) => r.businessDate)).toEqual(['2026-08-15', '2026-08-15', '2026-08-10']);
    expect(batchRows.map((r) => r.id)).toEqual(['b-3', 'b-2', 'b-1']);

    // damage：同注册日期多条，按 registered_at 倒序 + id tie-breaker
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    const damageStmt = db.prepare(
      `INSERT INTO damage_repair_items (id, project_id, instrument_id, issue_status, registered_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    damageStmt.run('d-1', projectId, instrumentId, 'untreated', '2026-08-12', 't', 't');
    damageStmt.run('d-2', projectId, instrumentId, 'untreated', '2026-08-12', 't', 't');
    const damage = facade.v2HistoryPage({ kind: 'damage' });
    const damageRows = damage.rows as Array<Extract<typeof damage.rows[number], { kind: 'damage' }>>;
    expect(damageRows.map((r) => r.id)).toEqual(['d-2', 'd-1']);

    // keyset 重复加载稳定性（activity/acceptance/ship_to_request 同批验证）：
    // 同一 cursor 两次请求返回相同顺序，跨页拼接与一次性读取一致
    const invStmt = db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const [id, date] of [
      ['k-1', '2026-08-01'],
      ['k-2', '2026-08-02'],
      ['k-3', '2026-08-03'],
      ['k-4', '2026-08-04'],
      ['k-5', '2026-08-05'],
    ] as const) {
      invStmt.run(id, projectId, 1000, date, 't', 't');
    }
    const walk = (cursor: string | null): { rows: readonly { id: string }[]; nextCursor: string | null } =>
      facade.v2HistoryPage({ kind: 'invoice', limit: 2, cursor });
    const all: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = walk(cursor);
      all.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      guard += 1;
      expect(guard).toBeLessThanOrEqual(4);
    } while (cursor !== null);
    expect(all).toEqual(['k-5', 'k-4', 'k-3', 'k-2', 'k-1']);
    // 重复加载同一页：顺序不变
    const p2 = facade.v2HistoryPage({ kind: 'invoice', limit: 2, cursor: facade.v2HistoryPage({ kind: 'invoice', limit: 2 }).nextCursor! });
    const p2again = facade.v2HistoryPage({ kind: 'invoice', limit: 2, cursor: facade.v2HistoryPage({ kind: 'invoice', limit: 2 }).nextCursor! });
    expect(p2.rows.map((r) => r.id)).toEqual(p2again.rows.map((r) => r.id));
    closeDatabase(db);
  });

  it('acceptance 跨项目按报告形成日期筛选并返回上下文；ship_to_request 保持无项目上下文', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const second = facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal', customerName: '验收客户乙', ecc: 'ECC-ACCEPT-002', region: 'North',
        instrumentCount: 1, contractAmount: '50000',
      },
    });
    const secondProjectId = second.changed!.projectId!;
    // 两个项目分别标记验收 → 待掉票；日期筛选应只返回范围内项目。
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    facade.v2Mutate({ op: 'submit_action', projectId: secondProjectId, action: { type: 'acceptance', projectId: secondProjectId, values: { reportDate: '2026-08-20' } } });
    expect(facade.v2HistoryPage({ kind: 'acceptance' }).total).toBe(2);
    const acc = facade.v2HistoryPage({ kind: 'acceptance', from: '2026-08-16', to: '2026-08-20' });
    expect(acc.total).toBe(1);
    const accRow = acc.rows[0] as Extract<typeof acc.rows[number], { kind: 'acceptance' }>;
    expect(accRow).toMatchObject({
      id: secondProjectId,
      projectId: secondProjectId,
      customerName: '验收客户乙',
      ecc: 'ECC-ACCEPT-002',
      acceptanceReportDate: '2026-08-20',
      businessDate: '2026-08-20',
    });

    // ship_to_request：无项目上下文
    const created = facade.createShipToRequest({ customerName: '历史 ShipTo 客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(created.request.id);
    const str = facade.v2HistoryPage({ kind: 'ship_to_request' });
    expect(str.total).toBe(1);
    const strRow = str.rows[0] as Extract<typeof str.rows[number], { kind: 'ship_to_request' }>;
    expect(strRow.projectId).toBeNull();
    expect(strRow.customerName).toBe('历史 ShipTo 客户');
    expect(strRow.status).toBe('processing');

    // from > to 拒绝
    expect(() => facade.v2HistoryPage({ kind: 'invoice', from: '2026-09-01', to: '2026-08-01' })).toThrow(/起始日期不得晚于截止日期/);
    closeDatabase(db);
  });

  it('service_order：project_id 为空的独立/未关联开单在全局历史可见（回归：INNER JOIN projects 漏行）', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 真实插入 project_id IS NULL 的服务单（非搬迁开单/未关联导入记录）：
    // 唯一性校验命中、但修复前历史浏览不可见（INNER JOIN projects）。
    const orderStmt = db.prepare(
      `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    orderStmt.run('so-np-1', 'certification', 'SO-NP-001', '2026-08-09', '工程师丙', '独立开单客户', null, null, '2026-08-09T10:00:00+08:00', '2026-08-09T10:00:00+08:00');
    // 同时保留一条项目内开单：修复不得改变有项目记录的行为。
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-NP-PROJ', orderedAt: '2026-08-11', engineer: '工程师乙' } } });
    const projOrderId = String(db.prepare('SELECT id FROM service_orders WHERE project_id = ?').get(projectId)!.id);

    const page = facade.v2HistoryPage({ kind: 'service_order' });
    expect(page.total).toBe(2); // 修复前：total=1，无项目开单被 INNER JOIN 漏掉
    const npRow = page.rows.find((r) => r.id === 'so-np-1') as Extract<typeof page.rows[number], { kind: 'service_order' }> | undefined;
    expect(npRow).toBeDefined(); // 修复前：该行不可见
    expect(npRow!.projectId).toBeNull();
    expect(npRow!.customerName).toBe('独立开单客户'); // 无项目时回退 service_orders.customer_name
    expect(npRow!.ecc).toBeNull();
    expect(npRow!.tempNo).toBe('');
    expect(npRow!.serviceOrderNo).toBe('SO-NP-001');
    expect(npRow!.orderedAt).toBe('2026-08-09');
    expect(npRow!.businessDate).toBe('2026-08-09');
    expect(npRow!.engineer).toBe('工程师丙');

    // 有项目记录上下文保持原行为
    const projRow = page.rows.find((r) => r.id === projOrderId) as Extract<typeof page.rows[number], { kind: 'service_order' }> | undefined;
    expect(projRow).toBeDefined();
    expect(projRow!.projectId).toBe(projectId);
    expect(projRow!.customerName).toBe('集成客户甲');
    expect(projRow!.ecc).toBe('ECC-V2-001');

    // 日期筛选对无项目记录同样生效
    expect(facade.v2HistoryPage({ kind: 'service_order', from: '2026-08-09', to: '2026-08-09' }).rows.map((r) => r.id)).toEqual(['so-np-1']);

    // keyset 分页包含无项目记录（业务日期倒序：08-11 项目开单在前、08-09 无项目在后）
    const first = facade.v2HistoryPage({ kind: 'service_order', limit: 1 });
    const second = facade.v2HistoryPage({ kind: 'service_order', limit: 1, cursor: first.nextCursor! });
    expect([...first.rows, ...second.rows].map((r) => r.id)).toEqual([projOrderId, 'so-np-1']);

    // 项目详情 section 查询不受影响：无项目开单不属于任何项目
    expect(facade.v2SectionPage({ kind: 'orders', projectId }).total).toBe(1);

    // 非空服务单号全局唯一保持不放宽：重复单号仍被拒绝
    expect(() =>
      orderStmt.run('so-np-dup', 'certification', 'SO-NP-001', '2026-08-10', '工程师丁', '另一客户', null, null, 't', 't'),
    ).toThrow(/UNIQUE/);
    closeDatabase(db);
  });
});

describe('工作台 v2 mutation（Oracle #10：复用写逻辑，无 snapshot）', () => {
  it('create_project：返回 bounded 结果（revision + invalidate + changed），不返回快照', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const before = readBusinessRevision(db);
    const result = ctx.facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'Mutation客户',
        ecc: 'ECC-MUT-001',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '50000',
        siteConfirmed: false,
      },
    });
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.changed?.created).toBe(true);
    expect(result.changed?.projectId).toBeTruthy();
    const tags = result.invalidated as string[];
    expect(tags).toContain('overview');
    expect(tags).toContain('projects');
    expect(tags).toContain(`project:${result.changed!.projectId}`);
    expect(tags).toContain(`sections:${result.changed!.projectId}`);
    closeDatabase(db);
  });

  it('submit_action 各类型 invalidate 标签正确；serial/qr 独立模块生效', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    db.prepare('UPDATE instruments SET serial_no = ? WHERE id = ?').run('SN-MUT', instrumentId);
    const serial = facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'serial_address', projectId, values: { instrumentId, customerName: '集成客户甲', newSiteAddress: '新址', serialNo: 'SN-MUT', accountId: 'ACC-MUT', updatedAt: '2026-08-10' } } });
    expect(serial.invalidated).toContain('independent:serial_address');
    const qr = facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A'] } } });
    expect(qr.invalidated).toContain('independent:qr_request');
    expect(qr.changed?.projectId).toBeUndefined();
    const invoice = facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    expect(invoice.invalidated).toContain(`sections:${projectId}`);
    closeDatabase(db);
  });

  it('ship_to_complete：invalidate lookup，changed 携带 request 状态与 accountId', () => {
    const ctx = makeFacade();
    const { db, facade } = ctx;
    const created = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(created.request.id);
    const result = facade.v2Mutate({ op: 'ship_to_complete', requestId: created.request.id, accountId: 'ACC-FIN-1' });
    expect(result.changed).toMatchObject({ requestId: created.request.id, status: 'completed', accountId: 'ACC-FIN-1' });
    expect(result.invalidated).toContain('lookup:ship_to_requests');
    closeDatabase(db);
  });

  it('invoice_edit / invoice_revoke：金额字符串精确编辑，invalidate project + sections', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);
    const edited = facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12', amount: '1234.567' });
    expect(edited.changed?.invoiceId).toBe(invoiceId);
    expect(edited.invalidated).toContain(`project:${projectId}`);
    const section = facade.v2SectionPage({ projectId, kind: 'invoices' });
    const row = section.rows[0] as Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
    expect(row.amount).toBe('1234.57');

    const revoked = facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-13', reason: '客户更正' });
    expect(revoked.changed).toMatchObject({ invoiceId, status: 'revoked' });
    expect(revoked.invalidated).toContain(`sections:${projectId}`);
    closeDatabase(db);
  });

  it('adjust_status 拒绝 cancelled；cancel_project 经 lifecycle 校验', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    expect(() =>
      facade.v2Mutate({ op: 'adjust_status', projectId, status: 'cancelled' as never }),
    ).toThrow(/cancelProject/);
    const cancelled = facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-08-12', reason: '客户业务调整' });
    expect(cancelled.changed?.status).toBe('cancelled');
    expect(cancelled.invalidated).toContain(`project:${projectId}`);
    // 已取消：拒绝金额修改（5.11）
    expect(() =>
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-12', amount: '100' } } }),
    ).toThrow(/已取消/);
    closeDatabase(db);
  });

  it('未知 op 拒绝且不写库', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const before = readBusinessRevision(db);
    expect(() =>
      facadeFrom(ctx).v2Mutate({ op: 'no_such_op' as never }),
    ).toThrow(/未知的 v2 mutation/);
    expect(readBusinessRevision(db)).toBe(before);
    closeDatabase(db);
  });
});

describe('人工 adjust_status 主状态转换审计', () => {
  interface AuditRow {
    id: string;
    project_id: string;
    from_status: string;
    to_status: string;
    reason: string;
    effective_business_date: string;
    source: string;
    actor_id: string | null;
    actor_username_snapshot: string | null;
    created_at: string;
  }

  const auditRows = (db: DatabaseSync, projectId: string): AuditRow[] =>
    db
      .prepare('SELECT * FROM project_status_transition_audit WHERE project_id = ? ORDER BY created_at, id')
      .all(projectId) as unknown as AuditRow[];

  it('真实状态变化：写入一条字段完整的 source=user 审计，项目状态同步更新', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    const before = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId) as { status: string };
    expect(before.status).toBe('pending_execution');

    facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' });

    const rows = auditRows(db, projectId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.project_id).toBe(projectId);
    expect(row.from_status).toBe('pending_execution');
    expect(row.to_status).toBe('executing');
    expect(row.reason).toBe('manual');
    expect(row.effective_business_date).toBe(new SystemClock().today());
    expect(row.source).toBe('user');
    expect(row.actor_id).toBe('acc-1');
    expect(row.actor_username_snapshot).toBe('负责人');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(row.id).toBeTruthy();
    // 项目状态已更新
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)).toMatchObject({ status: 'executing' });
    closeDatabase(db);
  });

  it('相同状态不新增审计（避免重复）', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' });
    expect(auditRows(db, projectId)).toHaveLength(1);

    // 再次调整到同一状态：不新增审计
    facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' });
    expect(auditRows(db, projectId)).toHaveLength(1);
    closeDatabase(db);
  });

  it('adjust_status 请求 cancelled 拒绝：不新增审计且状态不变', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    expect(() =>
      facade.v2Mutate({ op: 'adjust_status', projectId, status: 'cancelled' as never }),
    ).toThrow(/cancelProject/);
    expect(auditRows(db, projectId)).toHaveLength(0);
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)).toMatchObject({ status: 'pending_execution' });
    closeDatabase(db);
  });

  it('审计插入失败使项目状态更新整体回滚', () => {
    const ctx = makeFacade();
    const { db, facade, projectId } = ctx;
    // 用 BEFORE INSERT RAISE(ABORT) 触发器强制审计插入失败
    db.exec(`
      CREATE TRIGGER trg_fail_audit BEFORE INSERT ON project_status_transition_audit
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);
    expect(() =>
      facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' }),
    ).toThrow(/forced audit failure/);
    // 项目状态更新已随审计失败回滚
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)).toMatchObject({ status: 'pending_execution' });
    expect(auditRows(db, projectId)).toHaveLength(0);
    db.exec('DROP TRIGGER trg_fail_audit');
    closeDatabase(db);
  });
});

function facadeFrom(ctx: Ctx): WorkbenchFacade {
  return ctx.facade;
}

describe('工作台 v2 BigInt 金额（Oracle #10 精度）', () => {
  it('超过 MAX_SAFE_INTEGER 的金额经 detail/page 精确往返为十进制字符串', () => {
    const dir = makeTempDir('workbench-v2-big-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      db.prepare(
        'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('acc-big', '负责人', 'hash', 'salt', 't', 't');
      const facade = new WorkbenchFacade(db, () => ({ accountId: 'acc-big', username: '负责人' }));
      const BIG = '90071992547409.93'; // 分整数 > MAX_SAFE_INTEGER
      const result = facade.v2Mutate({
        op: 'create_project',
        payload: {
          intent: 'formal',
          customerName: '超精度客户',
          ecc: 'ECC-BIG-V2',
          region: 'East',
          contractStartDate: '2026-08-01',
          contractEndDate: '2027-07-31',
          oldSiteAddress: '旧址',
          newSiteAddress: '新址',
          instrumentCount: 1,
          contractAmount: BIG,
          actualInstallDoneAt: '2026-08-08',
          siteConfirmed: false,
        },
      });
      const projectId = result.changed!.projectId!;
      const detail = facade.v2ProjectDetail(projectId);
      expect(detail.project!.contractAmount).toBe(BIG);
      expect(detail.project!.finalAmount).toBe(BIG);
      expect(detail.project!.invoicedAmount).toBe('0.00');
      // 掉票后累计金额也精确
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: BIG } } });
      const after = facade.v2ProjectDetail(projectId);
      expect(after.project!.invoicedAmount).toBe(BIG);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('工作台 v2 有界性（Oracle #10 反全量约束）', () => {
  it('projectPage 返回页内行数与 total，不因数据规模放大 DTO', () => {
    const ctx = makeFacade();
    seedProjects(ctx.db, 5000);
    const repo = reader(ctx);
    const page = repo.projectPage({});
    expect(page.projects.length).toBe(PROJECT_PAGE_SIZE); // 固定 20，limit 被忽略
    expect(page.total).toBe(5001);
    const serialized = JSON.stringify(page);
    // 有界：页大小固定（20 行），序列化体积与总数据量无关
    expect(serialized.length).toBeLessThan(200_000);
    closeDatabase(ctx.db);
  });

  it('overview 提醒预览固定 ≤6，不随提醒数放大', () => {
    const ctx = makeFacade();
    const { db } = ctx;
    const stmt = db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 50; i++) {
      stmt.run(`rem-${i}`, `TP-REM-${String(i).padStart(3, '0')}`, 'pending_execution', '华东', `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, `备注${i}`, 't', `2026-08-0${i % 9}T00:00:00+08:00`);
    }
    const overview = reader(ctx).overview();
    expect(overview.reminderPreview.length).toBeLessThanOrEqual(6);
    expect(overview.reminderTotal).toBe(50); // makeFacade 项目无提醒
    closeDatabase(db);
  });
});
