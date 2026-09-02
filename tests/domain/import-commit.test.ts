import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapWorkspaceDatabase, closeWorkspaceDatabase } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-bootstrap';
import { WorkspaceRepository } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-repository';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { businessKeyFromCells, toAppendRowInput, type NormalizedRow } from '../../src/domain/capabilities/historical-data-import/normalized-row';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { validatePlan } from '../../src/domain/capabilities/historical-data-import/validation';
import { generateValidationSeal } from '../../src/domain/capabilities/historical-data-import/seal';
import {
  BusinessWriteCoordinator,
  CommitRejectedError,
  findRunByOperationId,
  latestRunForDraft,
} from '../../src/domain/capabilities/historical-data-import/commit-coordinator';
import type { CommitFaultPhase, CommitInput } from '../../src/domain/capabilities/historical-data-import/commit-coordinator';
import { SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import type { ImportCategory } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { IMPORT_CATEGORIES } from '../../src/domain/capabilities/historical-data-import/workspace/workspace-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 正式提交协调器测试（design D26 / tasks 8.16、8.38~8.41、8.44~8.46）。
 *
 * - import_run 运行审计（operation_id 唯一、plan digest/规则版本/七类计划与写入数、
 *   账号 ID+用户名快照、started/confirmed/committed、result、pre/post revision）；
 * - 互斥 + operation 去重（double submit 返回同一成功或 busy，不二次写）；
 * - 事务外安全快照，快照失败零业务写入；
 * - 单事务内复核草稿修订 / seal 全部分量 / 目标身份 / 唯一性/引用/目标快照；
 * - 七类 + 来源审计 + 目标快照 + 运行审计一次写入与写后对账；
 * - 中断后以成功审计判定完整成功，否则完整回滚并要求重新校验；
 * - 真实 SQLite 故障注入（七个 writer / 目标快照 / 运行审计 / 对账 / 快照 / 预审计）；
 * - revision 竞争、重复 operation、相同计划重跑、安全 forward-fix、人工修改阻塞、
 *   旧记录无基线阻塞、账号审计与业务工作量分离。
 */

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];

let seq = 0;
function nrow(
  category: ImportCategory,
  cells: Record<string, string | null>,
  extra: Partial<NormalizedRow> = {},
): NormalizedRow {
  seq += 1;
  return {
    category,
    rowId: `row-${seq}`,
    sourceRowId: null,
    businessKey: businessKeyFromCells(category, cells),
    sourceKind: 'file',
    sourceFile: '来源工作簿.xlsx',
    sourceSheet: '数据表',
    sourceRow: seq + 1,
    pasteBatch: null,
    cells,
    positionOnlyIdentity: false,
    ...extra,
  };
}

/** 固定来源位置的规范化行（forward-fix 需要与上次相同的来源键）。 */
function frow(category: ImportCategory, cells: Record<string, string | null>, file: string, sheet: string, rowNumber: number): NormalizedRow {
  return nrow(category, cells, { sourceFile: file, sourceSheet: sheet, sourceRow: rowNumber });
}

function declaredAll(data: readonly ImportCategory[]): Partial<Record<ImportCategory, 'data' | 'none'>> {
  const declared = {} as Partial<Record<ImportCategory, 'data' | 'none'>>;
  for (const c of IMPORT_CATEGORIES) declared[c] = data.includes(c) ? 'data' : 'none';
  return declared;
}

/** 全部七类都有数据的有效计划行（serial 与项目仪器匹配、ECC 引用闭合、QR 类型明确）。 */
function validSevenRows(): NormalizedRow[] {
  return [
    nrow('project', { 'contract.ecc': 'E-1', 'contract.customer_name': '甲', 'instrument.name': '色谱仪', 'instrument.serial_no': 'SN-1' }),
    nrow('invoice', { 'invoice.ecc': 'E-1', 'invoice.amount_cents': '5000', 'invoice.invoiced_at': '2026-01-05' }),
    nrow('logistics_fee', { 'logistics_fee.ecc': 'E-1', 'logistics_fee.applied_at': '2026-01-05', 'logistics_fee.budget_price_cents': '4000', 'logistics_fee.deal_price_cents': '3500', 'logistics_fee.logistics_cost_cents': '3000', 'logistics_fee.transport_company': '顺丰' }),
    nrow('service_order', { 'service_order.service_order_no': 'SO-1', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-01-01', 'service_order.engineer': '工', 'service_order.customer_name': '甲' }),
    nrow('serial_address_update', { 'serial_address_update.customer_name': '甲', 'serial_address_update.new_site_address': '新址', 'serial_address_update.serial_no': 'SN-1', 'serial_address_update.account_id': 'ACC-1', 'serial_address_update.updated_at': '2026-01-05' }),
    nrow('qr_request', { 'qr_request.applicant': '负责人', 'qr_request.requested_at': '2026-01-05', 'qr_request.type_code': 'service' }),
    nrow('ship_to_request', { 'ship_to_request.customer_name': '甲', 'ship_to_request.new_site_address': '新址', 'ship_to_request.account_id': 'ACC-2' }),
  ];
}

interface Env {
  repo: WorkspaceRepository;
  db: import('node:sqlite').DatabaseSync;
  coordinator: BusinessWriteCoordinator;
  close: () => void;
}

function openEnv(dir: string): Env {
  const ws = bootstrapWorkspaceDatabase({ workspaceDir: join(dir, 'ws') });
  const { db } = bootstrapDatabase({ dataDir: join(dir, 'data') });
  return {
    repo: new WorkspaceRepository(ws.db),
    db,
    coordinator: new BusinessWriteCoordinator(),
    close: () => {
      closeDatabase(db);
      closeWorkspaceDatabase(ws.db);
    },
  };
}

/** 构造 sealed 草稿（完整校验通过并生成 seal），返回 { id, rev, planDigest, declared }。 */
function sealedDraft(
  env: Env,
  rows: NormalizedRow[],
  declared: Partial<Record<ImportCategory, 'data' | 'none'>>,
): { id: string; rev: number; planDigest: string } {
  const repo = env.repo;
  const d = repo.createDraft({ name: '提交草稿', createdBy: 'acc-owner', createdByUsername: '负责人' });
  let rev = 1;
  rev = repo.transitionState(d.id, rev, 'start_parsing');
  for (const row of rows) {
    rev = repo.appendRows(d.id, rev, row.category, [toAppendRowInput(row)]);
  }
  rev = repo.transitionState(d.id, rev, 'parsing_finished');
  rev = repo.transitionState(d.id, rev, 'start_validating');
  const result = validatePlan(rows, { declared });
  expect(result.eligible, 'fixture 应完整校验通过').toBe(true);
  const planDigest = buildPlanFromRows(rows).planDigest;
  rev = generateValidationSeal(repo, { draftId: d.id, expectedRevision: rev, planDigest, problems: result.problems, targetDb: env.db });
  return { id: d.id, rev, planDigest };
}

function commitInput(
  sealed: { id: string; rev: number; planDigest: string },
  rows: NormalizedRow[],
  declared: Partial<Record<ImportCategory, 'data' | 'none'>>,
  snapshotDir: string,
  overrides: Partial<CommitInput> = {},
): CommitInput {
  const result = validatePlan(rows, { declared });
  return {
    draftId: sealed.id,
    expectedRevision: sealed.rev,
    planDigest: sealed.planDigest,
    rows,
    problems: result.problems,
    declared,
    actor: { accountId: 'acc-owner', username: '负责人' },
    snapshotDir,
    ...overrides,
  };
}

/** 业务表 + 迁移元数据（不含 import_run 审计）内容摘要：前后对比证明零部分写入。 */
function businessHash(db: import('node:sqlite').DatabaseSync): string {
  const tables = [
    'customers', 'projects', 'contracts', 'batches', 'instruments',
    'activities', 'activity_engineers', 'work_facts', 'service_orders',
    'ship_tos', 'ship_to_requests', 'serial_address_updates',
    'damage_repair_items', 'activity_damage_links', 'qr_requests', 'qr_request_types',
    'logistics_fees', 'invoices', 'migration_audit', 'import_record_audit',
  ];
  return tables
    .map((t) => `${t}:${JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// 8.16 import_run 运行审计（schema v11）
// ---------------------------------------------------------------------------
describe('8.16 import_run 运行审计（schema v11 / operation_id 唯一）', () => {
  it('v11 迁移创建 import_run：operation_id 唯一约束与审计列', () => {
    const dir = makeTempDir();
    try {
      const { db, close } = openEnv(dir);
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const cols = db.prepare('PRAGMA table_info(import_run)').all() as { name: string }[];
      const names = cols.map((c) => c.name);
      for (const col of [
        'id', 'operation_id', 'draft_id', 'plan_digest', 'template_version', 'mapping_version',
        'validation_version', 'account_id', 'username_snapshot', 'started_at', 'confirmed_at',
        'committed_at', 'status', 'plan_project', 'plan_service_order', 'plan_invoice',
        'plan_logistics_fee', 'plan_serial_address_update', 'plan_qr_request', 'plan_ship_to_request',
        'written_project', 'written_service_order', 'written_invoice', 'written_logistics_fee',
        'written_serial_address_update', 'written_qr_request', 'written_ship_to_request',
        'pre_business_revision', 'post_business_revision', 'result',
      ]) {
        expect(names).toContain(col);
      }
      // operation_id 唯一约束（双击/重复 IPC 只能产生一个成功运行）。
      db.prepare(
        `INSERT INTO import_run (id, operation_id, draft_id, plan_digest, started_at, status, created_at)
         VALUES ('r1','op-1','d-1','pd','t','running','t')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO import_run (id, operation_id, draft_id, plan_digest, started_at, status, created_at)
             VALUES ('r2','op-1','d-2','pd','t','running','t')`,
          )
          .run(),
      ).toThrow();
      close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('成功提交写入完整运行审计：operation/plan/规则版本/账号快照/时间/result/pre+post revision/七类数量', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const opId = 'op-audit-1';

      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap'), { operationId: opId }));
      expect(outcome.status).toBe('committed');

      const run = findRunByOperationId(env.db, opId)!;
      expect(run.operationId).toBe(opId);
      expect(run.draftId).toBe(sealed.id);
      expect(run.planDigest).toBe(sealed.planDigest);
      expect(run.templateVersion).toBe('1');
      expect(run.mappingVersion).toBe('1');
      expect(run.validationVersion).toBe('2');
      expect(run.accountId).toBe('acc-owner');
      expect(run.usernameSnapshot).toBe('负责人');
      expect(run.startedAt).toBeTruthy();
      expect(run.confirmedAt).toBeTruthy();
      expect(run.committedAt).toBeTruthy();
      expect(run.status).toBe('succeeded');
      expect(run.result).toBe('succeeded');
      expect(run.planCounts).toMatchObject({ project: 1, service_order: 1, invoice: 1, logistics_fee: 1, serial_address_update: 1, qr_request: 1, ship_to_request: 1 });
      expect(run.writtenCounts).toMatchObject({ project: 1, service_order: 1, invoice: 1, logistics_fee: 1, serial_address_update: 1, qr_request: 1, ship_to_request: 1 });
      expect(run.postBusinessRevision ?? 0).toBeGreaterThan(run.preBusinessRevision);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.38 互斥与 operation 去重
// ---------------------------------------------------------------------------
describe('8.38 提交互斥与 operation ID 去重', () => {
  it('同一 operation 重复提交返回同一成功结果，不二次写入', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const opId = 'op-dup-1';
      const input = commitInput(sealed, rows, declared, join(dir, 'snap'), { operationId: opId });

      const first = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, input);
      expect(first.status).toBe('committed');
      const firstRun = findRunByOperationId(env.db, opId)!;

      const second = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, input);
      expect(second.status).toBe('already_committed');
      expect(second.run?.id).toBe(firstRun.id);

      // 不二次写入：项目/合同/掉票/物流费用等数量不变。
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM logistics_fees').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM import_run').get() as { n: number }).n).toBe(1);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('进行中的同一 operation 返回 busy（双击/重复快捷键被抑制）', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const opId = 'op-busy-1';

      // 并发触发同一 operation：第二个调用在第一个的同步前缀完成（inFlight 已登记）后立即返回 busy。
      const firstPromise = env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap'), { operationId: opId }));
      const secondPromise = env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap'), { operationId: opId }));

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.status).toBe('committed');
      expect(second.status).toBe('busy');
      // 不二次写入
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.39 安全快照与失败保护
// ---------------------------------------------------------------------------
describe('8.39 导入前安全快照（事务外创建并验证；失败零写）', () => {
  it('快照创建成功：快照文件存在且完整性校验通过', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const snapDir = join(dir, 'snapshots');
      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, snapDir));
      expect(outcome.status).toBe('committed');
      const files = require('node:fs').readdirSync(snapDir) as string[];
      expect(files.some((f) => f.startsWith('import-pre-') && f.endsWith('.db'))).toBe(true);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('快照失败：禁止开始业务写入，草稿保持 sealed 可恢复', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const before = businessHash(env.db);

      await expect(
        env.coordinator.commitSealedPlanAtomically(
          env.db,
          env.repo,
          commitInput(sealed, rows, declared, join(dir, 'snap'), { injectFault: (p) => { if (p === 'snapshot') throw new Error('注入快照失败'); } }),
        ),
      ).rejects.toThrow(CommitRejectedError);

      expect(businessHash(env.db)).toBe(before); // 零业务写入
      expect(env.repo.getDraft(sealed.id)?.state).toBe('sealed'); // 草稿可恢复
      expect(env.repo.getSeal(sealed.id)?.status).toBe('valid');
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM import_run').get() as { n: number }).n).toBe(0);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.40/8.41 单事务原子写入
// ---------------------------------------------------------------------------
describe('8.40/8.41 事务内复核与一次写入七类 + 审计 + 对账', () => {
  it('成功提交：七类业务记录 + 客户/批次 + 来源审计 + 目标快照 + 运行审计一次落库', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap')));
      expect(outcome.status).toBe('committed');

      expect((env.db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM batches').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM logistics_fees').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM serial_address_updates').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM qr_requests').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM qr_request_types').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get() as { n: number }).n).toBe(1);
      // 来源审计 + 目标快照
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number }).n).toBeGreaterThan(0);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM import_record_audit').get() as { n: number }).n).toBeGreaterThan(0);
      // 草稿 succeeded
      expect(env.repo.getDraft(sealed.id)?.state).toBe('succeeded');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('revision 竞争：草稿修订变化后提交被拒，零业务写入', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);

      // 竞争：提交前草稿被修改（seal 失效、状态离开 sealed）。
      const window = env.repo.queryRows(sealed.id, { category: 'project', offset: 0, limit: 10 });
      env.repo.patchCells(sealed.id, sealed.rev, [{ rowId: window.rows[0].rowId, field: 'project.region', value: '华东' }]);
      const before = businessHash(env.db);
      await expect(
        env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap'))),
      ).rejects.toThrow(CommitRejectedError);
      expect(businessHash(env.db)).toBe(before);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('revision 竞争：旧修订号提交被拒（禁止覆盖较新草稿）', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const before = businessHash(env.db);
      await expect(
        env.coordinator.commitSealedPlanAtomically(
          env.db,
          env.repo,
          commitInput(sealed, rows, declared, join(dir, 'snap'), { expectedRevision: sealed.rev - 1 }),
        ),
      ).rejects.toThrow(CommitRejectedError);
      expect(businessHash(env.db)).toBe(before);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.44 中断后结果核对
// ---------------------------------------------------------------------------
describe('8.44 中断后以成功审计判定结果', () => {
  it('无成功审计 → 完整回滚并要求重新完整校验', () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      env.repo.transitionState(sealed.id, sealed.rev, 'start_committing'); // 提交中崩溃遗留

      const outcome = env.coordinator.settleInterruptedCommit(env.db, env.repo, sealed.id);
      expect(outcome.status).toBe('rolled_back');
      expect(outcome.runId).toBeNull();
      const draft = env.repo.getDraft(sealed.id)!;
      expect(draft.state).toBe('needs_review'); // 要求重新完整校验
      expect(env.repo.getSeal(sealed.id)?.status).toBe('invalid');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('成功审计与完整事务同时存在 → 判定完整成功', () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      env.repo.transitionState(sealed.id, sealed.rev, 'start_committing');
      // 模拟完整事务已提交：import_run 成功审计存在。
      env.db.prepare(
        `INSERT INTO import_run (id, operation_id, draft_id, plan_digest, started_at, confirmed_at, committed_at, status, plan_project, pre_business_revision, post_business_revision, result, created_at)
         VALUES ('run-succ','op-succ','${sealed.id}','pd','t','t','t','succeeded',1,0,5,'succeeded','t')`,
      ).run();

      const outcome = env.coordinator.settleInterruptedCommit(env.db, env.repo, sealed.id);
      expect(outcome.status).toBe('succeeded');
      expect(outcome.runId).toBe('run-succ');
      expect(env.repo.getDraft(sealed.id)?.state).toBe('succeeded');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.45 真实 SQLite 故障注入（零部分写入）
// ---------------------------------------------------------------------------
describe('8.45 故障注入：任一阶段失败整体回滚零部分写入', () => {
  const FAIL_PHASES: CommitFaultPhase[] = [
    'writer_project',
    'writer_service_order',
    'writer_invoice',
    'writer_logistics_fee',
    'writer_serial_address_update',
    'writer_qr_request',
    'writer_ship_to_request',
    'target_snapshot',
    'run_audit',
    'reconcile',
  ];

  for (const phase of FAIL_PHASES) {
    it(`阶段 ${phase} 失败 → 全部业务表与迁移元数据零部分写入`, async () => {
      const dir = makeTempDir();
      try {
        const env = openEnv(dir);
        const rows = validSevenRows();
        const declared = declaredAll(IMPORT_CATEGORIES);
        const sealed = sealedDraft(env, rows, declared);
        const before = businessHash(env.db);

        const outcome = await env.coordinator.commitSealedPlanAtomically(
          env.db,
          env.repo,
          commitInput(sealed, rows, declared, join(dir, 'snap'), {
            injectFault: (p) => {
              if (p === phase) throw new Error(`注入故障: ${phase}`);
            },
          }),
        );
        expect(outcome.status).toBe('failed');
        expect(businessHash(env.db)).toBe(before); // 零部分写入
        // 运行审计登记失败结果；草稿回到需重新校验
        const run = latestRunForDraft(env.db, sealed.id)!;
        expect(run.status).toBe('rolled_back');
        expect(run.result).toContain(`注入故障: ${phase}`);
        expect(env.repo.getDraft(sealed.id)?.state).toBe('needs_review');
        env.close();
      } finally {
        cleanupTempDir(dir);
      }
    });
  }

  it('快照阶段失败：抛 CommitRejectedError 且零写入、草稿保持 sealed', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      const before = businessHash(env.db);
      await expect(
        env.coordinator.commitSealedPlanAtomically(
          env.db,
          env.repo,
          commitInput(sealed, rows, declared, join(dir, 'snap'), { injectFault: (p) => { if (p === 'snapshot') throw new Error('快照故障'); } }),
        ),
      ).rejects.toThrow(CommitRejectedError);
      expect(businessHash(env.db)).toBe(before);
      expect(env.repo.getDraft(sealed.id)?.state).toBe('sealed');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.46 集成场景
// ---------------------------------------------------------------------------
describe('8.46 原子提交集成：幂等/forward-fix/人工修改/无基线/账号审计', () => {
  it('相同计划重跑：幂等跳过，零业务写入返回成功', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed1 = sealedDraft(env, rows, declared);
      const first = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed1, rows, declared, join(dir, 'snap')));
      expect(first.status).toBe('committed');

      // 第二次导入同一计划（新草稿）：全部批次幂等跳过。
      const sealed2 = sealedDraft(env, rows, declared);
      const second = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed2, rows, declared, join(dir, 'snap')));
      expect(second.status).toBe('committed');
      const run = latestRunForDraft(env.db, sealed2.id)!;
      expect(run.writtenCounts).toMatchObject({ project: 0, service_order: 0, invoice: 0, logistics_fee: 0, serial_address_update: 0, qr_request: 0, ship_to_request: 0 });
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(1);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('安全 forward-fix：同来源键修正更新目标字段', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const base = nrow('project', { 'contract.ecc': 'E-FF', 'contract.customer_name': '甲' });
      const row1 = frow('project', { 'contract.ecc': 'E-FF', 'contract.customer_name': '甲', 'project.region': '华东' }, CONTRACT, '合同信息', 2);
      const declared = declaredAll(['project']);
      const sealed1 = sealedDraft(env, [row1], declared);
      const first = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed1, [row1], declared, join(dir, 'snap')));
      expect(first.status).toBe('committed');
      expect((env.db.prepare("SELECT region FROM projects WHERE id=(SELECT project_id FROM contracts WHERE ecc='E-FF')").get() as { region: string }).region).toBe('华东');

      // 修正同一来源行（region 改为 华北）→ forward-fix 更新。
      const row2 = frow('project', { 'contract.ecc': 'E-FF', 'contract.customer_name': '甲', 'project.region': '华北' }, CONTRACT, '合同信息', 2);
      const sealed2 = sealedDraft(env, [row2], declared);
      const second = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed2, [row2], declared, join(dir, 'snap')));
      expect(second.status).toBe('committed');
      expect((env.db.prepare("SELECT region FROM projects WHERE id=(SELECT project_id FROM contracts WHERE ecc='E-FF')").get() as { region: string }).region).toBe('华北');
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      void base;
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('人工修改目标阻塞覆盖：提交失败且人工值保留', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const row1 = frow('project', { 'contract.ecc': 'E-MAN', 'contract.customer_name': '甲', 'project.region': '华东' }, CONTRACT, '合同信息', 2);
      const declared = declaredAll(['project']);
      const sealed1 = sealedDraft(env, [row1], declared);
      await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed1, [row1], declared, join(dir, 'snap')));

      // 人工修改目标（迁移后改动）。
      env.db.prepare("UPDATE projects SET region='人工改' WHERE id=(SELECT project_id FROM contracts WHERE ecc='E-MAN')").run();

      const row2 = frow('project', { 'contract.ecc': 'E-MAN', 'contract.customer_name': '甲', 'project.region': '华北' }, CONTRACT, '合同信息', 2);
      const sealed2 = sealedDraft(env, [row2], declared);
      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed2, [row2], declared, join(dir, 'snap')));
      expect(outcome.status).toBe('failed');
      // 人工值保留（不覆盖）。
      expect((env.db.prepare("SELECT region FROM projects WHERE id=(SELECT project_id FROM contracts WHERE ecc='E-MAN')").get() as { region: string }).region).toBe('人工改');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('旧记录缺少可信基线阻塞覆盖（v9 快照缺失）', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const row1 = frow('project', { 'contract.ecc': 'E-NB', 'contract.customer_name': '甲', 'project.region': '华东' }, CONTRACT, '合同信息', 2);
      const declared = declaredAll(['project']);
      const sealed1 = sealedDraft(env, [row1], declared);
      await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed1, [row1], declared, join(dir, 'snap')));

      // 删除目标快照基线（模拟 v9 前旧迁移记录）。
      env.db.prepare('DELETE FROM import_record_audit').run();

      const row2 = frow('project', { 'contract.ecc': 'E-NB', 'contract.customer_name': '甲', 'project.region': '华北' }, CONTRACT, '合同信息', 2);
      const sealed2 = sealedDraft(env, [row2], declared);
      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed2, [row2], declared, join(dir, 'snap')));
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toContain('基线');
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号审计与业务工作量分离：业务事实 source=history_import、不计 actor 手工工作量', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      const rows = validSevenRows();
      const declared = declaredAll(IMPORT_CATEGORIES);
      const sealed = sealedDraft(env, rows, declared);
      await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap')));

      // 运行审计记录确认账号。
      const run = latestRunForDraft(env.db, sealed.id)!;
      expect(run.accountId).toBe('acc-owner');
      expect(run.usernameSnapshot).toBe('负责人');

      // 业务事实标记为历史导入（import_source_key 存在），且不归属账号（account_id 为空）。
      const so = env.db.prepare("SELECT import_source_key, account_id FROM service_orders WHERE service_order_no='SO-1'").get() as { import_source_key: string | null; account_id: string | null };
      expect(so.import_source_key).toBeTruthy();
      expect(so.account_id).toBeNull();
      const inv = env.db.prepare('SELECT account_id FROM invoices LIMIT 1').get() as { account_id: string | null };
      expect(inv.account_id).toBeNull();
      const fee = env.db.prepare('SELECT account_id FROM logistics_fees LIMIT 1').get() as { account_id: string | null };
      expect(fee.account_id).toBeNull();
      const str = env.db.prepare('SELECT actor_account_id FROM ship_to_requests LIMIT 1').get() as { actor_account_id: string | null };
      expect(str.actor_account_id).toBeNull();
      // 无任何手工工作事实被创建（导入不计入 actor 手工工作量）。
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM work_facts').get() as { n: number }).n).toBe(0);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('与旧 CLI 迁移写入互不冲突：runImport 已在目标库的记录，协调器前向修复尊重来源键', async () => {
    const dir = makeTempDir();
    try {
      const env = openEnv(dir);
      // 先用 CLI runImport 导入同一 ECC 项目（旧路径）。
      runImport(env.db, {
        rows: [srow(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LEGACY', 'Account name': '甲', 合同USD含税金额: '100' })],
        mapping: (await import('../../src/domain/capabilities/historical-data-import/mapping')).MAPPING_V1,
      });
      // 协调器提交另一 ECC：两种写入路径共存且都落库。
      const rows = [frow('project', { 'contract.ecc': 'E-NEW', 'contract.customer_name': '乙' }, CONTRACT, '合同信息', 2)];
      const declared = declaredAll(['project']);
      const sealed = sealedDraft(env, rows, declared);
      const outcome = await env.coordinator.commitSealedPlanAtomically(env.db, env.repo, commitInput(sealed, rows, declared, join(dir, 'snap')));
      expect(outcome.status).toBe('committed');
      expect((env.db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(2);
      env.close();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

function srow(file: string, sheet: string, rowNumber: number, cells: Record<string, string | null>): SourceRow {
  return { file, sheet, rowNumber, cells };
}
