import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle #10 性能测试：100k 项目 + 大量子记录。
 *
 * - 首屏返回固定页（overview 提醒预览 ≤6、项目页固定每页 20 行，legacy limit 忽略），不随数据规模放大；
 * - keyset 翻页无重复遗漏、游标稳定；查询计划实际使用 v12 索引；
 * - DTO / structuredClone 有界（页大小固定、序列化体积有界）；
 * - v2 mutation 返回有界结果、绝不调用 snapshot；BigInt 金额精确；提醒边界正确。
 */

/** 让出事件循环：同步大量 SQL 期间保持 vitest worker RPC 存活。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

interface Ctx {
  db: DatabaseSync;
  facade: WorkbenchFacade;
  repo: WorkbenchReadRepository;
}

function makeCtx(): Ctx {
  const dir = makeTempDir('workbench-v2-perf-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('acc-perf', '负责人', 'hash', 'salt', 't', 't');
  const facade = new WorkbenchFacade(db, () => ({ accountId: 'acc-perf', username: '负责人' }));
  const repo = new WorkbenchReadRepository(db, { today: '2026-08-08', windowDays: 7 });
  return { db, facade, repo };
}

/** 批量播种：100k 项目 + 大量子记录（直接 SQL、单事务、走业务修订触发器）。 */
async function seedBulk(db: DatabaseSync, projectCount = 100_000): Promise<void> {
  const stamp = (day: number, hour: number, minute = 0, second = 0): string =>
    `2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+08:00`;
  // 业务日期（yyyy-mm-dd）：业务时间字段一律业务日期（design D30），审计/技术字段保持 stamp 精确 ISO。
  const bday = (day: number): string => `2026-08-${String(day).padStart(2, '0')}`;

  db.exec('BEGIN');
  const insertProject = db.prepare(
    `INSERT INTO projects (id, temp_no, status, region, entry_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < projectCount; i++) {
    // 前 1000 个项目挂合同并已进单（pendingAmount 有确定值）；其余未进单
    const entryAt = i < 1_000 ? '2026-08-01' : null;
    insertProject.run(
      `bulk-p-${i}`,
      `TP-BULK-${String(i).padStart(6, '0')}`,
      i % 4 === 0 ? 'pending_entry' : i % 4 === 1 ? 'pending_execution' : i % 4 === 2 ? 'executing' : 'pending_acceptance',
      i % 3 === 0 ? '华东' : i % 3 === 1 ? '华北' : '华南',
      entryAt,
      stamp((i % 28) + 1, (i * 7) % 24, i % 60),
      stamp((i % 28) + 1, (i * 13) % 24, (i * 3) % 60, i % 60),
    );
    if (i % 25_000 === 0) await tick();
  }

  const insertBatch = db.prepare(
    `INSERT INTO batches (id, project_id, transport_company, plan_transport_date, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 10_000; i++) {
    insertBatch.run(`bulk-b-${i}`, `bulk-p-${i}`, `运输公司${i % 50}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, stamp(1, 1), stamp(1, 1));
  }

  const insertInstrument = db.prepare(
    `INSERT INTO instruments (id, project_id, name, model, serial_no, ups, qr_requested, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < projectCount; i++) {
    insertInstrument.run(
      `bulk-i-${i}`,
      `bulk-p-${i}`,
      `仪器${i}`,
      `M-${i % 20}`,
      i % 10 === 0 ? null : `SN-BULK-${i}`,
      i % 2,
      i % 5 === 0 ? 1 : 0,
      stamp(1, 1),
      stamp(1, 1),
    );
    if (i % 25_000 === 0) await tick();
  }

  const insertActivity = db.prepare(
    `INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)`,
  );
  for (let i = 0; i < 5_000; i++) {
    insertActivity.run(`bulk-a-${i}`, `bulk-p-${(i * 7) % projectCount}`, bday((i % 28) + 1), stamp(1, 1), stamp(1, 1));
  }

  const insertInvoice = db.prepare(
    `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, last_modified_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 334; i < 10_000; i++) { // i*3 >= 1002 全部落在未挂合同项目，pendingAmount 可确定
    insertInvoice.run(
      `bulk-inv-${i}`,
      `bulk-p-${(i * 3) % projectCount}`,
      String((i % 1000) + 1),
      bday((i % 28) + 1),
      i % 5 === 0 ? bday((i % 28) + 1) : null, // 20% 已撤销（活跃索引路径）
      stamp(1, 1),
      stamp(1, 1),
    );
  }

  const insertContract = db.prepare(
    `INSERT INTO contracts (id, project_id, temp_number, usd_tax_amount_cents, final_confirmable_amount_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 1_000; i++) {
    insertContract.run(`bulk-c-${i}`, `bulk-p-${i}`, `TP-BULK-${String(i).padStart(6, '0')}`, '100000000', '90000000', stamp(1, 1), stamp(1, 1));
  }

  const insertDamage = db.prepare(
    `INSERT INTO damage_repair_items (id, instrument_id, project_id, issue_status, registered_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 5_000; i++) {
    insertDamage.run(`bulk-d-${i}`, `bulk-i-${i}`, `bulk-p-${i}`, i % 3 === 0 ? 'processing' : 'repaired', bday((i % 28) + 1), stamp(1, 1), stamp(1, 1));
  }

  const insertSerial = db.prepare(
    `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 1_000; i++) {
    insertSerial.run(`bulk-s-${i}`, `bulk-i-${i * 10}`, `批量客户${i % 100}`, `新址${i % 100}`, `SN-BULK-${i * 10}`, `ACC-BULK-${i}`, bday((i % 28) + 1), stamp(1, 1));
  }

  const insertQr = db.prepare(
    `INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)`,
  );
  for (let i = 0; i < 1_000; i++) {
    insertQr.run(`bulk-q-${i}`, `申请人${i % 100}`, bday((i % 28) + 1), stamp(1, 1));
  }
  const insertQrType = db.prepare(
    `INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)`,
  );
  for (let i = 0; i < 1_000; i++) {
    insertQrType.run(`bulk-qt-${i}`, `bulk-q-${i}`, 'A');
    insertQrType.run(`bulk-qt-${i}-2`, `bulk-q-${i}`, 'logistics_management');
  }

  const insertShipReq = db.prepare(
    `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (let i = 0; i < 2_000; i++) {
    insertShipReq.run(
      `bulk-req-${i}`,
      `分页客户${i % 50}`,
      `分页新址${i}`, // 同客户同新址唯一索引：地址按 i 唯一
      i % 3 === 0 ? 'pending_submit' : i % 3 === 1 ? 'processing' : 'completed',
      stamp(1, 1),
      stamp(1, 1),
    );
  }

  const insertCustomer = db.prepare(
    `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
  );
  for (let i = 0; i < 5_000; i++) {
    insertCustomer.run(`bulk-cu-${i}`, `批量客户${String(i).padStart(4, '0')}`, stamp(1, 1), stamp(1, 1));
  }
  db.exec('COMMIT');
}

describe('Oracle #10 性能：100k 项目 + 大量子记录', () => {
  it('首屏返回固定页：overview 固定预览 + 项目页固定每页 20 行（legacy limit 忽略），SQL 索引生效，DTO 有界', { timeout: 180_000 }, async () => {
    const ctx = makeCtx();
    await seedBulk(ctx.db);
    const t0 = Date.now();
    const overview = ctx.repo.overview();
    const t1 = Date.now();
    const page = ctx.repo.projectPage({});
    const t2 = Date.now();

    // 首屏聚合正确（100k 规模）
    expect(overview.metrics.totalProjects).toBe(100_000);
    expect(overview.metrics.activeProjects).toBe(100_000);
    expect(overview.metrics.pendingAcceptance).toBe(25_000); // i%4==3
    expect(overview.metrics.pendingAmount).toBe('900000000.00'); // 1000 合同 × 900000.00 元，未挂票
    // 提醒预览固定 ≤6（种子无提醒）
    expect(overview.reminderPreview.length).toBeLessThanOrEqual(6);
    expect(overview.stages).toHaveLength(7);

    // 项目页固定每页 20 行（tasks 7.5）：limit: 50 属 legacy limit 被忽略；total 全量；页数据不因数据规模放大
    expect(page.projects.length).toBe(20);
    expect(page.limit).toBe(20);
    expect(page.pageSize).toBe(20);
    expect(page.total).toBe(100_000);
    const serialized = JSON.stringify(page);
    expect(serialized.length).toBeLessThan(200_000);
    const clone = structuredClone(page) as unknown as { projects: unknown[] };
    expect(clone.projects.length).toBe(20);

    // 耗时粗边界：100k 规模首屏 + 分页应在秒级内完成（防退化回归）
    expect(t1 - t0).toBeLessThan(5_000);
    expect(t2 - t1).toBeLessThan(2_000);

    // SQL 索引生效（查询计划使用 idx_projects_updated）
    const plan = ctx.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT p.id, p.temp_no FROM projects p
         LEFT JOIN contracts c ON c.project_id = p.id
         LEFT JOIN customers cu ON cu.id = p.customer_id
         ORDER BY p.updated_at DESC, p.id DESC LIMIT 20`,
      )
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join('\n')).toContain('idx_projects_updated');

    closeDatabase(ctx.db);
  });

  it('keyset 翻页：100k 规模连续翻页无重复遗漏、游标稳定', { timeout: 180_000 }, async () => {
    const ctx = makeCtx();
    await seedBulk(ctx.db);

    // 全量翻页（legacy limit=100 忽略、固定每页 20 → 5000 页）：无重复无遗漏、total 精确
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = ctx.repo.projectPage({ cursor });
      for (const p of page.projects) {
        expect(seen.has(p.id), `翻页不应重复: ${p.id}`).toBe(false);
        seen.add(p.id);
      }
      cursor = page.nextCursor;
      pages += 1;
      expect(pages, '100k/20 页上界').toBeLessThanOrEqual(5_001);
      if (pages % 100 === 0) await tick();
    } while (cursor !== null);
    expect(seen.size).toBe(100_000);
    // 100k/20 恰好 5000 满页；多取一条探测后末页不再虚报游标。
    expect(pages).toBe(5_000);

    // 游标稳定：同一 cursor 两次返回相同顺序
    const first = ctx.repo.projectPage({});
    const again = ctx.repo.projectPage({ cursor: first.nextCursor });
    expect(again.projects.map((p) => p.id)).toEqual(
      ctx.repo.projectPage({ cursor: first.nextCursor }).projects.map((p) => p.id),
    );

    // 尾部页：游标推进到最后一页后 nextCursor 为 null
    let lastCursor = first.nextCursor;
    let guard = 0;
    while (lastCursor !== null) {
      const next = ctx.repo.projectPage({ cursor: lastCursor });
      lastCursor = next.nextCursor;
      guard += 1;
      expect(guard).toBeLessThanOrEqual(5_100); // 100k/20 页上界
      if (guard % 200 === 0) await tick();
    }
    closeDatabase(ctx.db);
  });

  it('写后 invalidate + mutation 无 snapshot + BigInt + 提醒边界', { timeout: 180_000 }, async () => {
    const ctx = makeCtx();
    await seedBulk(ctx.db);

    // mutation：有界结果，不含 snapshot 字段；写后 revision 递增且页面可见
    const before = readBusinessRevision(ctx.db);
    const result = ctx.facade.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '性能场景新项目',
        ecc: 'ECC-PERF-NEW',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '90071992547409.93',
        siteConfirmed: false,
      },
    });
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.invalidated).toContain('overview');
    const page = ctx.repo.projectPage({ query: '性能场景新项目' });
    expect(page.total).toBe(1);

    // BigInt 金额精确（detail）
    ctx.facade.v2Mutate({
      op: 'submit_action',
      projectId: result.changed!.projectId!,
      action: {
        type: 'invoice',
        projectId: result.changed!.projectId!,
        values: { invoicedAt: '2026-08-11', amount: '90071992547409.93' },
      },
    });
    const detail = ctx.facade.v2ProjectDetail(result.changed!.projectId!);
    expect(detail.project!.invoicedAmount).toBe('90071992547409.93');

    // 提醒边界（固定 today=2026-08-08, window=7）：today-1/今日/窗口内/窗口外
    const insertReminder = ctx.db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const reminderCases: Array<[string, string | null]> = [
      ['perf-rem-overdue', '2026-08-07'],
      ['perf-rem-today', '2026-08-08'],
      ['perf-rem-upcoming', '2026-08-10'],
      ['perf-rem-outside', '2026-08-16'],
    ];
    for (const [id, at] of reminderCases) {
      insertReminder.run(id, `TP-${id}`, 'pending_entry', '华东', at, '边界提醒', 't', '2026-08-01T00:00:00+08:00');
    }
    const expectIds = (reminder: 'overdue' | 'today' | 'upcoming', ids: string[]): void => {
      const got = ctx.repo.projectPage({ reminder }).projects.map((p) => p.id).sort();
      expect(got, reminder).toEqual(ids.slice().sort());
    };
    expectIds('overdue', ['perf-rem-overdue']);
    expectIds('today', ['perf-rem-today']);
    expectIds('upcoming', ['perf-rem-upcoming']);
    // 窗口外（2026-08-16 > today+7）不进入任何分类
    expect(ctx.repo.projectPage({ reminder: 'upcoming' }).projects.map((p) => p.id)).not.toContain('perf-rem-outside');

    // 大数据下计数正确（100k 项目的子记录计数经有界 IN 聚合）
    const detailBulk = ctx.repo.projectDetail('bulk-p-0');
    expect(detailBulk.project!.counts.instruments).toBe(1);
    expect(detailBulk.project!.counts.activities).toBe(1); // bulk-a-0 落在 bulk-p-0
    expect(detailBulk.project!.nonBlocking.qrUnmarked).toBe(0); // bulk-i-0 的 qr_requested=1
    const detailBulk1 = ctx.repo.projectDetail('bulk-p-1');
    expect(detailBulk1.project!.counts.instruments).toBe(1);
    expect(detailBulk1.project!.nonBlocking.qrUnmarked).toBe(1); // bulk-i-1 的 qr_requested=0
    closeDatabase(ctx.db);
  });

  it('independent/lookup 分页：大数据量跨页无重复遗漏、query 筛选后 cursor 行为、DTO 有界', { timeout: 180_000 }, async () => {
    const ctx = makeCtx();
    await seedBulk(ctx.db);
    const walk = async <T extends { id: string }>(
      page: (cursor: string | null) => { rows: readonly T[]; nextCursor: string | null; total: number },
    ): Promise<{ ids: string[]; pages: number; total: number }> => {
      const ids: string[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      let total = 0;
      do {
        const result = page(cursor);
        if (pages === 0) total = result.total;
        for (const row of result.rows) {
          expect(seen.has(row.id), `翻页不应重复: ${row.id}`).toBe(false);
          seen.add(row.id);
          ids.push(row.id);
        }
        cursor = result.nextCursor;
        pages += 1;
        expect(pages, '翻页页数有界').toBeLessThanOrEqual(100);
        if (pages % 20 === 0) await tick();
      } while (cursor !== null);
      return { ids, pages, total };
    };

    // serial_address 1000 条 / limit 100 → 10 页：无重复遗漏、nextCursor 终止
    const serial = await walk((cursor) => ctx.repo.independentPage({ kind: 'serial_address', limit: 100, cursor }));
    expect(serial.ids.length).toBe(1_000);
    expect(serial.total).toBe(1_000);
    expect(new Set(serial.ids).size).toBe(1_000);
    // 多取一条探测后，恰好 10 页时末页直接终止。
    expect(serial.pages).toBe(10);

    // qr_request 1000 条：同样全量翻页（含类型装配）
    const qr = await walk((cursor) => ctx.repo.independentPage({ kind: 'qr_request', limit: 100, cursor }));
    expect(qr.ids.length).toBe(1_000);
    expect(qr.total).toBe(1_000);
    expect(new Set(qr.ids).size).toBe(1_000);
    expect(qr.pages).toBe(10);

    // lookup ship_to_requests 2000 条 / limit 100 → 20 页：无重复遗漏
    const reqs = await walk((cursor) => ctx.repo.lookupPage({ kind: 'ship_to_requests', limit: 100, cursor }));
    expect(reqs.ids.length).toBe(2_000);
    expect(reqs.total).toBe(2_000);
    expect(new Set(reqs.ids).size).toBe(2_000);
    expect(reqs.pages).toBe(20);

    // lookup customers 5000 条（name 升序 keyset）
    const customers = await walk((cursor) => ctx.repo.lookupPage({ kind: 'customers', limit: 100, cursor }));
    expect(customers.ids.length).toBe(5_000);
    expect(customers.total).toBe(5_000);
    expect(new Set(customers.ids).size).toBe(5_000);
    expect(customers.pages).toBe(50);

    // query 筛选后 cursor 行为：分页客户1 命中 分页客户1/10..19/100..199/1000..1999
    const filtered = await walk((cursor) =>
      ctx.repo.lookupPage({ kind: 'ship_to_requests', query: '分页客户1', limit: 100, cursor }),
    );
    const fTotal = ctx.repo.lookupPage({ kind: 'ship_to_requests', query: '分页客户1', limit: 1 }).total;
    expect(filtered.ids.length).toBe(fTotal);
    expect(new Set(filtered.ids).size).toBe(fTotal);
    expect(filtered.pages).toBeGreaterThan(1); // 确为多页翻页

    // DTO 有界：单页序列化体积不随数据规模放大
    const page = ctx.repo.independentPage({ kind: 'qr_request', limit: 100 });
    expect(page.rows.length).toBe(100);
    expect(JSON.stringify(page).length).toBeLessThan(200_000);
    closeDatabase(ctx.db);
  });
});
