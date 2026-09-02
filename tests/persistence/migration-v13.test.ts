import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { localCalendarDateOf } from '../../src/domain/capabilities/local-data-persistence/business-date';
import {
  projectSnapshotHash,
  targetSnapshotHash,
} from '../../src/domain/capabilities/local-data-persistence/target-snapshot';
import { BUSINESS_DATE_COLUMNS } from '../../src/domain/capabilities/local-data-persistence/schema-v13';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v13：业务日期化（design D30）。
 *
 * - 白名单业务日期字段统一为 yyyy-mm-dd：纯日期原样保留、带 Z/显式偏移 ISO 按
 *   冻结本机 IANA 时区换算、无偏移 datetime 取本地墙钟日期部分；
 * - 非法值报 table/id/column 并依赖外层迁移事务整体回滚（零残留）；
 * - 审计/技术字段绝不改变：import_record_audit 只刷新 target_snapshot_hash，
 *   import_source_hash 与 imported_at 保持不变；
 * - 刷新目标快照基线后 forward-fix 不再把 v13 自身的值变化误判为人工修改。
 */

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];

function srow(cells: Record<string, string>): SourceRow {
  return { file: CONTRACT, sheet: '合同信息', rowNumber: 2, cells };
}

/** 预置一个 v12 库（供 v13 升级）。 */
function openV12(dir: string): { db: DatabaseSync; dbPath: string; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 12), backupDir });
  expect(readSchemaVersion(db)).toBe(12);
  return { db, dbPath, backupDir };
}

describe('schema v13：业务日期化迁移（design D30）', () => {
  it(`全新库引导到最新版本：白名单字段声明完整、迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      // 白名单覆盖 D30 全部业务时间字段（projects 提醒/执行字段、各子表业务日期）。
      const cols = new Set(BUSINESS_DATE_COLUMNS.map((c) => `${c.table}.${c.column}`));
      for (const key of [
        'projects.entry_at',
        'projects.contract_start_date',
        'projects.plan_visit_at',
        'projects.actual_install_done_at',
        'projects.acceptance_report_date',
        'projects.cancelled_at',
        'projects.reminder_at',
        'batches.plan_transport_date',
        'batches.started_at',
        'activities.visit_at',
        'work_facts.completed_at',
        'service_orders.ordered_at',
        'invoices.invoiced_at',
        'invoices.revoked_at',
        'logistics_fees.applied_at',
        'serial_address_updates.updated_at',
        'damage_repair_items.registered_at',
        'damage_repair_items.part_requested_at',
        'qr_requests.requested_at',
        'ship_to_requests.submitted_at',
        'ship_to_requests.completed_at',
      ]) {
        expect(cols, `白名单应包含 ${key}`).toContain(key);
      }
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('纯日期原样保留；无偏移本地 datetime 取本地墙钟日期部分；带偏移/Z ISO 按冻结本机时区换算', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV12(dir);
      const nowIso = '2026-08-01T00:00:00+08:00';
      db.exec('BEGIN');
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, created_at, updated_at,
           entry_at, contract_start_date, contract_end_date, acceptance_report_date, reminder_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'p-dates', 'TP-DATES', 'pending_execution', nowIso, nowIso,
        '2026-08-07',              // 纯日期 → 原样保留
        '2026-08-07 10:30:00',     // 无偏移本地 datetime → 取日期部分
        '2026-08-09T23:30:00+08:00', // 显式偏移 ISO → 冻结本机时区换算
        '2026-08-10T01:00:00Z',    // Z ISO → 冻结本机时区换算
        '2026-08-11T09:00:00',     // 无偏移 ISO（T 分隔）→ 取日期部分
      );
      db.exec('COMMIT');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('p-dates') as Record<string, string | null>;
      expect(row.entry_at).toBe('2026-08-07');
      expect(row.contract_start_date).toBe('2026-08-07');
      expect(row.contract_end_date).toBe(localCalendarDateOf(new Date('2026-08-09T23:30:00+08:00')));
      expect(row.acceptance_report_date).toBe(localCalendarDateOf(new Date('2026-08-10T01:00:00Z')));
      expect(row.reminder_at).toBe('2026-08-11');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('非法值报 table/id/column，外层迁移事务整体回滚（零残留）', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV12(dir);
      const nowIso = '2026-08-01T00:00:00+08:00';
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, created_at, updated_at, entry_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('p-bad', 'TP-BAD', 'pending_execution', nowIso, nowIso, '仅月份');

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(13);
      expect(failure.originalVersion).toBe(12);
      expect((thrown as MigrationError).message).toContain('projects.entry_at');
      expect((thrown as MigrationError).message).toContain('p-bad');
      // 整体回滚：版本仍为 12、业务数据未改变、无部分转换残留。
      expect(readSchemaVersion(db)).toBe(12);
      const row = db.prepare('SELECT entry_at FROM projects WHERE id = ?').get('p-bad') as { entry_at: string };
      expect(row.entry_at).toBe('仅月份');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('审计技术字段绝不改变：import_record_audit 只刷新 target_snapshot_hash，import_source_hash/imported_at 保持原值', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV12(dir);
      // 模拟 v9 导入形成的审计记录（v12 存量库）。
      db.exec('BEGIN');
      db.prepare(
        `INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
      ).run('c1', '客户甲', 't', 't');
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, customer_id, entry_at, import_source_key, import_source_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        'p1', 'MIG-E-1', 'pending_execution', 'c1', '2026-05-01T08:00:00+08:00', 'project|E-1', 'src-hash-1', 't', 't',
      );
      db.prepare(
        `INSERT INTO contracts (id, project_id, temp_number, ecc, import_source_key, import_source_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('ct1', 'p1', 'MIG-E-1', 'E-1', 'contract|E-1', 'src-hash-1', 't', 't');
      db.prepare(
        `INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        'aud-1', 'project|E-1', 'projects', 'p1', 'src-hash-1', 'old-baseline', '2026-07-01T10:00:00+08:00',
      );
      db.exec('COMMIT');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });

      // 业务字段已转换；审计技术字段不变；target_snapshot_hash 刷新为当前目标快照。
      const project = db.prepare('SELECT entry_at FROM projects WHERE id = ?').get('p1') as { entry_at: string };
      expect(project.entry_at).toBe(localCalendarDateOf(new Date('2026-05-01T08:00:00+08:00')));
      const audit = db.prepare('SELECT * FROM import_record_audit WHERE source_key = ?').get('project|E-1') as {
        import_source_hash: string;
        imported_at: string;
        target_snapshot_hash: string;
      };
      expect(audit.import_source_hash).toBe('src-hash-1');
      expect(audit.imported_at).toBe('2026-07-01T10:00:00+08:00');
      expect(audit.target_snapshot_hash).not.toBe('old-baseline');
      expect(audit.target_snapshot_hash).toBe(projectSnapshotHash(db, 'p1'));
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('刷新目标快照基线后 forward-fix 不再误判人工修改（避免 v13 假冲突）', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV12(dir);
      // 首轮导入：业务日期化引擎已写入 yyyy-mm-dd；再模拟「v13 前旧语义存量」：
      // 把业务字段改回 datetime，并把审计基线改回按 datetime 计算的历史值。
      runImport(db, {
        rows: [srow({ 'ECC#': 'E-FX', 客户名称: '华东', 进单时间: '2026-05-01T00:00:00+08:00' })],
        mapping: MAPPING_V1,
      });
      const before = db.prepare('SELECT id, entry_at FROM projects WHERE temp_no = ?').get('MIG-E-FX') as {
        id: string;
        entry_at: string;
      };
      expect(before.entry_at).toBe(localCalendarDateOf(new Date('2026-05-01T00:00:00+08:00')));
      const legacyDatetime = '2026-05-01T00:00:00+08:00';
      db.prepare('UPDATE projects SET entry_at = ? WHERE id = ?').run(legacyDatetime, before.id);
      const legacyHash = targetSnapshotHash({
        status: 'pending_execution',
        customer_id: db.prepare('SELECT customer_id FROM projects WHERE id = ?').get(before.id)!.customer_id as string | null,
        entry_at: legacyDatetime,
        region: null,
        contract_start_date: null,
        contract_end_date: null,
        actual_install_done_at: null,
        acceptance_report: 0,
        acceptance_report_date: null,
        cancelled_at: null,
        usd_tax_amount_cents: null,
        entry_amount_snapshot_cents: null,
        final_confirmable_amount_cents: null,
      });
      db.prepare('UPDATE import_record_audit SET target_snapshot_hash = ? WHERE source_key = ?').run(
        legacyHash,
        'project|E-FX',
      );

      // 升级到 v13：entry_at 统一为业务日期，目标快照基线同步刷新。
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      const after = db.prepare('SELECT entry_at FROM projects WHERE temp_no = ?').get('MIG-E-FX') as { entry_at: string };
      expect(after.entry_at).toBe(localCalendarDateOf(new Date(legacyDatetime)));

      // forward-fix（同 source key、修正区域）：目标快照一致 → 不误判人工修改，成功更新。
      const result = runImport(db, {
        rows: [srow({ 'ECC#': 'E-FX', 客户名称: '华东', 进单时间: '2026-05-01T00:00:00+08:00', 区域: '华东' })],
        mapping: MAPPING_V1,
      });
      expect(result.batches.some((b) => b.status === 'success')).toBe(true);
      expect(result.batches.some((b) => (b.errorDetails ?? '').includes('目标快照不一致'))).toBe(false);
      const fixed = db.prepare('SELECT region FROM projects WHERE temp_no = ?').get('MIG-E-FX') as { region: string | null };
      expect(fixed.region).toBe('华东');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
