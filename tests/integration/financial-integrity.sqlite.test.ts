import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  FINANCIAL_INTEGRITY_CONFIRM_TEXT,
  FINANCIAL_INTEGRITY_REJECTION_CODES,
  FINANCIAL_INTEGRITY_SETTINGS_PREFIX,
  GOVERNANCE_REVOKE_REASON,
  FinancialIntegrityCleanupService,
  readFinancialIntegrityCounts,
  type FinancialIntegrityCounts,
  type FinancialIntegrityCleanupOptions,
} from '../../src/domain/capabilities/local-data-persistence/financial-integrity';
import { readDatabaseIdentity } from '../../src/domain/capabilities/local-data-persistence/identity';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 财务完整性：孤立财务数据只读诊断 + 治理清理两阶段服务（tasks 2.3 / 4.3 / 4.4）。
 *
 * - 4.3 只读诊断：同一只读事务返回五类固定计数（孤立合同/孤立掉票/孤立最终可确认金额
 *   事实/断裂 project/contract 链接/foreign_key_check 违规），不返回/打印 ID、客户名、
 *   金额或 foreign_key_check 原始行；孤立最终可确认金额事实 = 孤立合同且
 *   final_confirmable_amount_cents 非空；projects.contract_id NULL 不视为断裂。
 * - 4.4 治理清理（防复发）：prepare→confirm 两阶段；confirm 前置备份 + 固定确认文本；
 *   BEGIN IMMEDIATE 内复核 token/identity/generation/revision/counts；仅治理撤销活跃
 *   孤立掉票（保留原行、写固定治理原因/日期/actor、已撤销保持）；审计仅计数；
 *   结构性外键违规以 unresolved count 持续报告、不宣称归零；失败原子回滚且备份保留。
 * - 2.3 bootstrap 迁移后诊断：旧库存量结构违规不静默删、不阻断迁移，输出固定计数与
 *   治理提示；迁移自身失败仍按既有机制回滚（migration-v15 测试覆盖）。
 *
 * 脏数据一律在事务外 PRAGMA foreign_keys=OFF 写入（SQLite 事务内无法修改该 PRAGMA），
 * 避免伪测试；防复发用例在正常 foreign_keys=ON 下断言新写入被拒。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const ACCOUNT_ID = 'acc-fi';
const ACTOR = () => ({ accountId: ACCOUNT_ID, username: '负责人' });
const PREFIX = FINANCIAL_INTEGRITY_SETTINGS_PREFIX;

/** 播种后的预期五类计数（含 1 个有效项目、3 条孤立掉票、2 个孤立合同、1 条断裂链接）。 */
const EXPECTED_DIRTY_COUNTS: FinancialIntegrityCounts = {
  orphanContracts: 2,
  orphanInvoices: 3,
  orphanFinalConfirmableFacts: 1,
  brokenProjectContractLinks: 1,
  foreignKeyViolations: 6,
};

/** 孤立脏数据：事务外关闭 foreign_keys 写入引用不存在项目的合同/掉票与断裂链接，写完后恢复。 */
function seedOrphanDirtyData(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('orphan-contract-a', 'no-project-A', 'TP-ORPHAN-A', 50000, 't', 't');
    db.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    ).run('orphan-contract-b', 'no-project-B', 'TP-ORPHAN-B', 't', 't');
    db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at, account_id, username_snapshot)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('orphan-invoice-active-1', 'no-project-A', 8000, '2026-08-03', 't', 't', ACCOUNT_ID, '负责人');
    db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at, account_id, username_snapshot)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('orphan-invoice-active-2', 'no-project-B', 2000, '2026-08-04', 't', 't', ACCOUNT_ID, '负责人');
    db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, revoke_reason, last_modified_at, created_at, account_id, username_snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'orphan-invoice-revoked-1',
      'no-project-C',
      1000,
      '2026-08-05',
      '2026-07-01',
      '历史撤销',
      't',
      't',
      ACCOUNT_ID,
      '负责人',
    );
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, contract_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('broken-project-1', 'TP-BROKEN', 'pending_entry', 'no-such-contract', 't', 't');
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** 播种：有效项目（final=100.00 + 有效掉票 40.00 → pendingAmount 60.00）+ 孤立脏数据。 */
function seedFiDb(dir: string): { db: DatabaseSync; repo: WorkbenchReadRepository } {
  const { db } = bootstrapDatabase({ dataDir: dir });
  const repo = new WorkbenchReadRepository(db, { today: '2026-08-08', windowDays: 7 });
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(ACCOUNT_ID, '负责人', 'h', 's', 't', 't');
  db.prepare(
    `INSERT INTO projects (id, temp_no, status, entry_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('p-valid', 'TP-VALID', 'pending_invoice', '2026-08-01', 't', 't');
  db.prepare(
    `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('c-valid', 'p-valid', 'TP-VALID', 10000, 't', 't');
  db.prepare(
    `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at, account_id, username_snapshot)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('inv-valid', 'p-valid', 4000, '2026-08-02', '2026-08-02T00:00:00+08:00', 't', ACCOUNT_ID, '负责人');
  seedOrphanDirtyData(db);
  return { db, repo };
}

function serviceFor(
  db: DatabaseSync,
  overrides?: Partial<FinancialIntegrityCleanupOptions>,
): FinancialIntegrityCleanupService {
  return new FinancialIntegrityCleanupService(db, {
    backup: () => Promise.resolve('/tmp/fi-backup.db'),
    session: ACTOR,
    ...overrides,
  });
}

/** confirm 为 async 路径：断言 Promise 拒绝（稳定错误码）。 */
async function expectRejectedAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  expect.unreachable('应当抛出拒绝错误');
}

/** 活跃孤立掉票数（治理前后断言数据是否被改写）。 */
function countActiveOrphanInvoices(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoices
       WHERE revoked_at IS NULL AND project_id NOT IN (SELECT id FROM projects)`,
    )
    .get() as { n: number };
  return row.n;
}

describe('4.3 只读孤立财务数据诊断（仅计数、无客户值、单事务一致快照）', () => {
  it('五类固定计数正确：孤立合同/孤立掉票（含已撤销）/孤立最终可确认金额事实/断裂链接/FK 违规', () => {
    const dir = makeTempDir('fi-diagnose-');
    dirs.push(dir);
    const { db, repo } = seedFiDb(dir);
    try {
      const counts = readFinancialIntegrityCounts(db);
      expect(counts).toEqual(EXPECTED_DIRTY_COUNTS);
      // 有效项目与有效掉票不计入诊断（仅引用不存在项目的财务事实）；
      // totalProjects 含断裂链接项目本身（broken-project-1 仍是项目行）
      expect(repo.overview().metrics.totalProjects).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  it('只读：不产生任何写入（业务修订不变、app_settings 无治理键、无审计行）', () => {
    const dir = makeTempDir('fi-readonly-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const before = readDatabaseIdentity(db).businessRevision;
      readFinancialIntegrityCounts(db);
      expect(readDatabaseIdentity(db).businessRevision).toBe(before);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE '${PREFIX}%'`).get()!.n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM financial_integrity_cleanup_audit').get()!.n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('仅返回五个数字计数：不返回/打印 ID、客户名、金额或 foreign_key_check 原始行', () => {
    const dir = makeTempDir('fi-counts-shape-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const counts = readFinancialIntegrityCounts(db);
      expect(Object.keys(counts).sort()).toEqual(
        [
          'brokenProjectContractLinks',
          'foreignKeyViolations',
          'orphanContracts',
          'orphanFinalConfirmableFacts',
          'orphanInvoices',
        ].sort(),
      );
      for (const value of Object.values(counts)) {
        expect(typeof value).toBe('number');
      }
      // 诊断结果不含任何字符串字段（无客户名/ID/金额文本）
      expect(Object.values(counts).some((v) => typeof v === 'string')).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  it('projects.contract_id 为 NULL 不视为断裂链接；仅非空悬空 contract_id 计数', () => {
    const dir = makeTempDir('fi-null-link-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)`,
      ).run('p-no-contract', 'TP-NO-CONTRACT', 'pending_entry', 't', 't');
      const counts = readFinancialIntegrityCounts(db);
      expect(counts.brokenProjectContractLinks).toBe(1); // 仅 broken-project-1，NULL 不计数
    } finally {
      closeDatabase(db);
    }
  });
});

describe('4.4 治理清理（两阶段 prepare/confirm，防复发）', () => {
  it('prepare 返回五类计数/短期 token/DB identity/revision，且不改变业务修订', () => {
    const dir = makeTempDir('fi-prepare-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const before = readDatabaseIdentity(db).businessRevision;
      const svc = serviceFor(db);
      const prepared = svc.prepare();
      expect(prepared.counts).toEqual(EXPECTED_DIRTY_COUNTS);
      expect(prepared.revision).toBe(before);
      expect(typeof prepared.token).toBe('string');
      expect(prepared.token.length).toBeGreaterThan(16);
      expect(prepared.expiresAt).toBeGreaterThan(Date.now());
      expect(readDatabaseIdentity(db).businessRevision).toBe(before);
      // token/identity/revision/counts 已绑定持久化（app_settings 保留表）
      const boundKeys = (
        db.prepare(`SELECT key FROM app_settings WHERE key LIKE '${PREFIX}%'`).all() as { key: string }[]
      ).map((r) => r.key);
      expect(boundKeys).toEqual(
        expect.arrayContaining([
          `${PREFIX}token`,
          `${PREFIX}expires-at`,
          `${PREFIX}revision`,
          `${PREFIX}database-instance-id`,
          `${PREFIX}content-generation-id`,
          `${PREFIX}counts`,
        ]),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('confirm 拒绝路径：未 prepare / 文本不匹配 / token 不匹配 / token 过期 / 备份失败，全部数据不动', async () => {
    const dir = makeTempDir('fi-reject-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const svc = serviceFor(db);
      // 未 prepare
      await expectRejectedAsync(
        () => svc.confirm({ token: 'x', confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.NOT_PREPARED,
      );
      const prepared = svc.prepare();
      // 确认文本不匹配（负责人固定文本前置）
      await expectRejectedAsync(
        () => svc.confirm({ token: prepared.token, confirmText: '我确定要清理' }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.CONFIRM_TEXT,
      );
      // token 不匹配
      await expectRejectedAsync(
        () => svc.confirm({ token: 'wrong-token', confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.TOKEN_MISMATCH,
      );
      // token 过期（注入过期 now）
      const expired = serviceFor(db, { now: () => prepared.expiresAt + 1 });
      await expectRejectedAsync(
        () => expired.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.TOKEN_EXPIRED,
      );
      // 备份前置失败 → 拒绝且数据未受影响
      const noBackup = new FinancialIntegrityCleanupService(db, {
        backup: () => Promise.reject(new Error('backup-io-fail')),
        session: ACTOR,
      });
      await expectRejectedAsync(
        () => noBackup.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.BACKUP_FAILED,
      );
      // 全部拒绝路径：活跃孤立掉票未被撤销、无审计行、token 未消费
      expect(countActiveOrphanInvoices(db)).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM financial_integrity_cleanup_audit').get()!.n).toBe(0);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key = '${PREFIX}token'`).get()!.n).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('TOCTOU：prepare 后业务写入（revision 变化）→ confirm 拒绝：备份已创建、数据未治理、token 未消费', async () => {
    const dir = makeTempDir('fi-revision-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      let backupCalled = false;
      const svc = new FinancialIntegrityCleanupService(db, {
        backup: () => {
          backupCalled = true;
          return Promise.resolve('/tmp/fi-revision-backup.db');
        },
        session: ACTOR,
      });
      const prepared = svc.prepare();
      // prepare 后业务写入 → business_revision 变化（TOCTOU：事务内核验捕获）
      db.prepare(
        `INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)`,
      ).run('qr-1', '申请人', '2026-08-11', 't');
      await expectRejectedAsync(
        () => svc.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.REVISION_CHANGED,
      );
      expect(backupCalled).toBe(true); // 备份已创建且保留
      expect(countActiveOrphanInvoices(db)).toBe(2); // 数据未治理
      expect(db.prepare('SELECT COUNT(*) AS n FROM financial_integrity_cleanup_audit').get()!.n).toBe(0);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key = '${PREFIX}token'`).get()!.n).toBe(1);
      expect(readDatabaseIdentity(db).contentGenerationId).toBe(prepared.contentGenerationId);
    } finally {
      closeDatabase(db);
    }
  });

  it('计数绑定复核：prepare 后计数绑定被篡改 → confirm 拒绝（COUNTS_CHANGED）且数据不动', async () => {
    const dir = makeTempDir('fi-counts-drift-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const svc = serviceFor(db);
      const prepared = svc.prepare();
      // 篡改 prepare 持久化的计数绑定（app_settings 写入不改变业务修订，仅计数复核能捕获）
      db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
        JSON.stringify({ ...EXPECTED_DIRTY_COUNTS, orphanInvoices: 99 }),
        `${PREFIX}counts`,
      );
      await expectRejectedAsync(
        () => svc.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.COUNTS_CHANGED,
      );
      expect(countActiveOrphanInvoices(db)).toBe(2); // 原子回滚，数据不动
      expect(db.prepare('SELECT COUNT(*) AS n FROM financial_integrity_cleanup_audit').get()!.n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('治理成功：仅活跃孤立掉票经既有撤销语义进入撤销终态并保留原行；已撤销保持；审计仅计数；token 消费', async () => {
    const dir = makeTempDir('fi-success-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      let backupCalled = false;
      const svc = new FinancialIntegrityCleanupService(db, {
        backup: () => {
          backupCalled = true;
          return Promise.resolve('/tmp/fi-success-backup.db');
        },
        session: ACTOR,
      });
      const prepared = svc.prepare();
      const beforeRevision = readDatabaseIdentity(db).businessRevision;

      const result = await svc.confirm({
        token: prepared.token,
        confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT,
        revokedAt: '2026-08-10',
      });

      // 备份前置已执行
      expect(backupCalled).toBe(true);
      expect(result.backupId).toBe('/tmp/fi-success-backup.db');
      // 仅治理撤销 2 条活跃孤立掉票（已撤销孤立掉票不重复撤销）
      expect(result.governanceRevokedCount).toBe(2);
      expect(result.countsBefore).toEqual(EXPECTED_DIRTY_COUNTS);
      // 结构性外键违规（含保留的已撤销孤立掉票行）以 unresolved 持续报告、不宣称归零
      expect(result.unresolvedCount).toBe(6);
      expect(result.countsAfter.foreignKeyViolations).toBe(6);
      expect(result.countsAfter.orphanInvoices).toBe(3); // 原行保留仍被计数
      // 治理是业务写入：业务修订递增
      expect(readDatabaseIdentity(db).businessRevision).toBeGreaterThan(beforeRevision);

      // 活跃孤立掉票原行保留 + 撤销终态（固定治理原因/日期/actor）
      for (const id of ['orphan-invoice-active-1', 'orphan-invoice-active-2']) {
        const row = db
          .prepare(
            'SELECT revoked_at, revoke_reason, account_id, username_snapshot FROM invoices WHERE id = ?',
          )
          .get(id) as { revoked_at: string; revoke_reason: string; account_id: string; username_snapshot: string };
        expect(row.revoked_at).toBe('2026-08-10');
        expect(row.revoke_reason).toBe(GOVERNANCE_REVOKE_REASON);
        expect(row.account_id).toBe(ACCOUNT_ID);
        expect(row.username_snapshot).toBe('负责人');
      }
      // 已撤销孤立掉票保持原样（不重复撤销）
      const revoked = db
        .prepare('SELECT revoked_at, revoke_reason FROM invoices WHERE id = ?')
        .get('orphan-invoice-revoked-1') as { revoked_at: string; revoke_reason: string };
      expect(revoked.revoked_at).toBe('2026-07-01');
      expect(revoked.revoke_reason).toBe('历史撤销');
      // 有效掉票不受影响
      const valid = db.prepare('SELECT revoked_at FROM invoices WHERE id = ?').get('inv-valid') as {
        revoked_at: string | null;
      };
      expect(valid.revoked_at).toBeNull();

      // financial_integrity_cleanup_audit：仅计数（before/after 五类 + 治理撤销 + unresolved）
      const audit = db.prepare('SELECT * FROM financial_integrity_cleanup_audit').get() as Record<string, unknown>;
      expect(audit.backup_id).toBe('/tmp/fi-success-backup.db');
      expect(audit.orphan_contracts_before_count).toBe(2);
      expect(audit.orphan_contracts_after_count).toBe(2);
      expect(audit.orphan_invoices_before_count).toBe(3);
      expect(audit.orphan_invoices_after_count).toBe(3);
      expect(audit.orphan_final_confirmable_facts_before_count).toBe(1);
      expect(audit.orphan_final_confirmable_facts_after_count).toBe(1);
      expect(audit.broken_project_links_before_count).toBe(1);
      expect(audit.broken_project_links_after_count).toBe(1);
      expect(audit.foreign_key_violations_before_count).toBe(6);
      expect(audit.foreign_key_violations_after_count).toBe(6);
      expect(audit.governance_revoked_count).toBe(2);
      expect(audit.unresolved_count).toBe(6);
      expect(audit.actor_id).toBe(ACCOUNT_ID);
      expect(audit.actor_username_snapshot).toBe('负责人');
      expect(audit.result).toBe('succeeded');

      // token 已消费：治理设置键全部清除，再次 confirm 报 NOT_PREPARED
      expect(db.prepare(`SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE '${PREFIX}%'`).get()!.n).toBe(0);
      await expectRejectedAsync(
        () => svc.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT }),
        FINANCIAL_INTEGRITY_REJECTION_CODES.NOT_PREPARED,
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('治理后待掉票金额指标保持正常（现有 repository 读取验证，不改其代码）', async () => {
    const dir = makeTempDir('fi-metric-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      const repo = new WorkbenchReadRepository(db, { today: '2026-08-08', windowDays: 7 });
      // 治理前：孤立数据不计入指标，有效项目 final=100.00 − 有效掉票 40.00 = 60.00
      expect(repo.overview().metrics.pendingAmount).toBe('60.00');
      const svc = serviceFor(db);
      const prepared = svc.prepare();
      await svc.confirm({ token: prepared.token, confirmText: FINANCIAL_INTEGRITY_CONFIRM_TEXT, revokedAt: '2026-08-10' });
      // 治理后：活跃孤立掉票已撤销（指标本就只经存在项目 JOIN，孤立事实不计入），指标不变
      expect(repo.overview().metrics.totalProjects).toBe(2); // 有效项目 + 断裂链接项目行
      expect(repo.overview().metrics.pendingAmount).toBe('60.00');
    } finally {
      closeDatabase(db);
    }
  });

  it('防复发：正常 foreign_keys=ON 下写入无项目合同/掉票被拒；治理不产生新孤立行', () => {
    const dir = makeTempDir('fi-prevent-');
    dirs.push(dir);
    const { db } = seedFiDb(dir);
    try {
      // FK ON（openDatabase 默认）：合同引用不存在项目 → 约束拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)`,
          )
          .run('prevent-c', 'ghost-x', 'TP-PREVENT', 't', 't'),
      ).toThrow();
      // 掉票引用不存在项目 → 约束拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run('prevent-i', 'ghost-x', 100, '2026-08-01', 't', 't'),
      ).toThrow();
      // 治理审计写入不新增孤立行：治理前后 foreign_key_check 违规数一致（仅存量 6）
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(6);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('2.3 bootstrap 迁移后诊断（只读计数 + 治理提示；不静默删、不阻断迁移）', () => {
  it('全新库引导：五类诊断计数全零、不输出治理提示', () => {
    const dir = makeTempDir('fi-boot-fresh-');
    dirs.push(dir);
    const logger = { warn: vi.fn() };
    try {
      const result = bootstrapDatabase({ dataDir: dir, logger });
      expect(result.integrityDiagnostics).toEqual({
        orphanContracts: 0,
        orphanInvoices: 0,
        orphanFinalConfirmableFacts: 0,
        brokenProjectContractLinks: 0,
        foreignKeyViolations: 0,
      });
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v14 存量库升级：结构违规不静默删、不阻断迁移，输出固定计数与治理提示，存量数据保留', () => {
    const dir = makeTempDir('fi-boot-v14-');
    dirs.push(dir);
    const dbPath = `${dir}/workbench.db`;
    const backupDir = `${dir}/migration-backups`;
    let db = openDatabase({ path: dbPath });
    try {
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 14), backupDir });
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(14);
      // 旧库存量脏数据：孤立合同 + 孤立掉票（引用不存在项目），事务外 FK OFF 写入
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare(
        `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('lg-contract', 'ghost-project', 'TP-LG', 99900, 't', 't');
      db.prepare(
        `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('lg-invoice', 'ghost-project', 12300, '2026-08-01', 't', 't');
      db.exec('PRAGMA foreign_keys = ON;');
      closeDatabase(db);

      // 启动（迁移 + 诊断）：迁移成功（不被结构违规阻断）、计数报告、治理提示输出
      const logger = { warn: vi.fn() };
      const result = bootstrapDatabase({ dataDir: dir, logger });
      db = result.db;
      expect(result.migrationResult.toVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(result.integrityDiagnostics).toEqual({
        orphanContracts: 1,
        orphanInvoices: 1,
        orphanFinalConfirmableFacts: 1,
        brokenProjectContractLinks: 0,
        foreignKeyViolations: 2,
      });
      // 治理提示（固定计数 + 治理路径；不宣称 FK 归零）
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const hint = logger.warn.mock.calls[0][0] as string;
      expect(hint).toContain('孤立合同=1');
      expect(hint).toContain('孤立掉票=1');
      expect(hint).toContain('结构性外键违规=2');
      expect(hint).toContain('不宣称 foreign_key_check 已归零');
      // 存量数据完整保留（未静默删除）
      expect(db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE id = ?').get('lg-contract')!.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE id = ?').get('lg-invoice')!.n).toBe(1);
    } finally {
      try {
        closeDatabase(db);
      } catch {
        // db 可能已在 closeDatabase 后未重开
      }
      cleanupTempDir(dir);
    }
  });
});
