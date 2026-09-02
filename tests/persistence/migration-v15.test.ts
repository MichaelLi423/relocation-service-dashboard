import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { Migration, MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { RELOCATION_WORKBENCH_MIGRATION_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v15';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v15：搬迁工作台 0810 现场反馈新增字段（design D1）+ 后续 Tasks
 * 3.2/4.4/5.1/5.4 的最小持久化支撑。
 *
 * - projects.project_note（项目备注）、temporary_storage_address（暂存地址）、
 *   is_temporary_storage（是否暂存，可空表示"未填写"而非推断"否"）、
 *   manager_approved（是否批复，承接 legacy 批复原因/缺失资料的"是否批复"语义）；
 * - "计划装机日期"复用既有 planned_install_done_at（v14 已建），不新建计划装机列；
 * - 只新增可空列、不重建表、不改写存量值；legacy region 原文保留；
 * - 新增三张审计表（project_status_transition_audit / record_deletion_audit /
 *   financial_integrity_cleanup_audit）、import_record_audit deleted marker、
 *   ship_tos.origin_request_id（可空 REFERENCES + 部分唯一索引，legacy 保持 null）；
 * - 失败整体回滚并保留迁移前安全备份（可恢复）；PRAGMA foreign_key_check 通过。
 */

const NEW_AUDIT_TABLES = [
  'project_status_transition_audit',
  'record_deletion_audit',
  'financial_integrity_cleanup_audit',
] as const;

function tableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function indexRows(db: DatabaseSync): { name: string; tbl_name: string; sql: string | null }[] {
  return db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string; tbl_name: string; sql: string | null }[];
}

describe('schema v15：搬迁工作台新增字段 + 审计结构最小持久化支撑', () => {
  it('全新库引导到最新版本：迁移序列 1..16、user_version=16、v15 四列已建立、审计表/索引/FK 已建、可写入最小审计事实', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      for (const name of [
        'project_note',
        'temporary_storage_address',
        'is_temporary_storage',
        'manager_approved',
      ]) {
        expect(cols).toContain(name);
      }
      // 计划装机日期复用 v14 既有列：列已存在、不新建计划装机列
      expect(cols).toContain('planned_install_done_at');
      expect(cols.filter((c) => c.startsWith('planned_install'))).toHaveLength(1);
      // 新列可正常录入
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, project_note, temporary_storage_address, is_temporary_storage, manager_approved, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run('p-new', 'TP-NEW', 'pending_entry', '项目备注', '暂存地址A', 1, 0, 't', 't');
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('p-new') as Record<
        string,
        unknown
      >;
      expect(row.project_note).toBe('项目备注');
      expect(row.temporary_storage_address).toBe('暂存地址A');
      expect(row.is_temporary_storage).toBe(1);
      expect(row.manager_approved).toBe(0);
      // 可空语义：未填写时保持 NULL（"未填写"而非推断"否"）
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p-null', 'TP-NULL', 'pending_entry', 't', 't');
      const blank = db
        .prepare('SELECT is_temporary_storage, manager_approved FROM projects WHERE id = ?')
        .get('p-null') as { is_temporary_storage: number | null; manager_approved: number | null };
      expect(blank.is_temporary_storage).toBeNull();
      expect(blank.manager_approved).toBeNull();

      // ---- 新增审计结构：三张审计表已建 ----
      const tables = tableNames(db);
      for (const t of NEW_AUDIT_TABLES) {
        expect(tables).toContain(t);
      }

      // ---- import_record_audit 可空 deleted marker 列已建 ----
      const iraCols = (
        db.prepare('PRAGMA table_info(import_record_audit)').all() as { name: string }[]
      ).map((c) => c.name);
      expect(iraCols).toContain('target_deleted_at');
      expect(iraCols).toContain('target_delete_operation_id');

      // ---- ship_tos.origin_request_id 列 + 唯一 partial 索引 + FK ----
      const stCols = (db.prepare('PRAGMA table_info(ship_tos)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(stCols).toContain('origin_request_id');
      const originIdx = indexRows(db).find((i) => i.name === 'idx_ship_tos_origin_request');
      expect(originIdx).toBeDefined();
      expect(originIdx?.sql).toContain('UNIQUE');
      expect(originIdx?.sql).toContain('WHERE origin_request_id IS NOT NULL');
      const stFks = db.prepare('PRAGMA foreign_key_list(ship_tos)').all() as {
        from: string;
        table: string;
      }[];
      expect(stFks).toContainEqual(
        expect.objectContaining({ from: 'origin_request_id', table: 'ship_to_requests' }),
      );
      // 状态转换审计索引已建
      const idxNames = indexRows(db).map((i) => i.name);
      expect(idxNames).toContain('idx_project_status_transition_project_time');
      expect(idxNames).toContain('idx_record_deletion_audit_record');
      expect(idxNames).toContain('idx_record_deletion_audit_operation');

      // ---- 可写入最小审计事实 ----
      db.prepare(
        'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('acc-1', 'admin', 'h', 's', 't', 't');
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p-audit', 'TP-AUDIT', 'executing', 't', 't');

      // 1) 项目状态转换审计：真实转换一行（from/to/reason/业务日期/source/actor）
      db.prepare(
        `INSERT INTO project_status_transition_audit
           (id, project_id, from_status, to_status, reason, effective_business_date, source, actor_id, actor_username_snapshot, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'tr1',
        'p-audit',
        'pending_execution',
        'executing',
        '计划上门日期到期自动推进',
        '2026-08-10',
        'plan_visit_due',
        'acc-1',
        '负责人甲',
        '2026-08-10T09:00:00+08:00',
      );
      const tr = db
        .prepare('SELECT * FROM project_status_transition_audit WHERE id = ?')
        .get('tr1') as Record<string, unknown>;
      expect(tr.from_status).toBe('pending_execution');
      expect(tr.to_status).toBe('executing');
      expect(tr.effective_business_date).toBe('2026-08-10');
      expect(tr.source).toBe('plan_visit_due');
      expect(tr.actor_id).toBe('acc-1');
      expect(tr.actor_username_snapshot).toBe('负责人甲');

      // 2) 通用记录删除审计：最小事实（record type/id + operation + 计数，无客户值）
      db.prepare(
        `INSERT INTO record_deletion_audit
           (id, operation_id, record_type, record_id, owned_child_count, actor_id, actor_username_snapshot, deleted_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('del1', 'op-del-1', 'qr_request', 'qr-1', 2, 'acc-1', '负责人甲', '2026-08-10T09:30:00+08:00');
      const del = db
        .prepare('SELECT * FROM record_deletion_audit WHERE id = ?')
        .get('del1') as Record<string, unknown>;
      expect(del.operation_id).toBe('op-del-1');
      expect(del.record_type).toBe('qr_request');
      expect(del.record_id).toBe('qr-1');
      expect(del.owned_child_count).toBe(2);
      expect(del.deleted_at).toBe('2026-08-10T09:30:00+08:00');

      // 3) 财务完整性清理审计：仅计数（before/after 五类 + 治理撤销 + unresolved + backup）
      db.prepare(
        `INSERT INTO financial_integrity_cleanup_audit
           (id, operation_id, backup_id,
            orphan_contracts_before_count, orphan_contracts_after_count,
            orphan_invoices_before_count, orphan_invoices_after_count,
            orphan_final_confirmable_facts_before_count, orphan_final_confirmable_facts_after_count,
            broken_project_links_before_count, broken_project_links_after_count,
            foreign_key_violations_before_count, foreign_key_violations_after_count,
            governance_revoked_count, unresolved_count,
            actor_id, actor_username_snapshot, result, cleaned_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'cln1',
        'op-clean-1',
        'backup-1',
        2,
        0,
        3,
        1,
        1,
        0,
        2,
        0,
        0,
        0,
        1,
        2,
        'acc-1',
        '负责人甲',
        'succeeded',
        '2026-08-10T10:00:00+08:00',
      );
      const cln = db
        .prepare('SELECT * FROM financial_integrity_cleanup_audit WHERE id = ?')
        .get('cln1') as Record<string, unknown>;
      expect(cln.backup_id).toBe('backup-1');
      expect(cln.orphan_contracts_before_count).toBe(2);
      expect(cln.orphan_contracts_after_count).toBe(0);
      expect(cln.governance_revoked_count).toBe(1);
      expect(cln.unresolved_count).toBe(2);
      expect(cln.result).toBe('succeeded');

      // 4) import_record_audit deleted marker 可写入（标记指向已删除记录而非擦除）
      db.prepare(
        `INSERT INTO import_record_audit
           (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at, target_deleted_at, target_delete_operation_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        'audit1',
        'sk-1',
        'service_orders',
        'o1',
        'src-hash',
        'tgt-hash',
        '2026-08-01T00:00:00+08:00',
        '2026-08-10T09:30:00+08:00',
        'op-del-1',
      );
      const auditRow = db
        .prepare('SELECT target_deleted_at, target_delete_operation_id FROM import_record_audit WHERE id = ?')
        .get('audit1') as { target_deleted_at: string | null; target_delete_operation_id: string | null };
      expect(auditRow.target_deleted_at).toBe('2026-08-10T09:30:00+08:00');
      expect(auditRow.target_delete_operation_id).toBe('op-del-1');

      // 5) ship_tos.origin_request_id：来源关联、部分唯一（非空来源唯一、NULL legacy 允许多行）
      db.prepare(
        `INSERT INTO ship_to_requests (id, customer_name, new_site_address, account_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('req1', '华东医药', '新址A', 'ACC-001', 'completed', '2026-08-01', '2026-08-01');
      db.prepare(
        `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at, origin_request_id)
         VALUES (?,?,?,?,?,?)`,
      ).run('st1', 'ACC-001', '华东医药', '新址A', 't', 'req1');
      const linked = db
        .prepare('SELECT origin_request_id FROM ship_tos WHERE id = ?')
        .get('st1') as { origin_request_id: string | null };
      expect(linked.origin_request_id).toBe('req1');
      // 重复非空来源被部分唯一索引拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at, origin_request_id)
             VALUES (?,?,?,?,?,?)`,
          )
          .run('st2', 'ACC-002', '华东医药', '新址A', 't', 'req1'),
      ).toThrow();
      // 指向不存在申请被 FK 拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at, origin_request_id)
             VALUES (?,?,?,?,?,?)`,
          )
          .run('st-bad', 'ACC-BAD', '华东医药', '新址A', 't', 'no-such-request'),
      ).toThrow();
      // NULL 来源（legacy）允许多行
      db.prepare(
        `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)`,
      ).run('st3', 'ACC-003', '华东医药', '新址A', 't');
      db.prepare(
        `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)`,
      ).run('st4', 'ACC-004', '华东医药', '新址B', 't');

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v14 存量库升级到 v15：业务数据完整保留、legacy region 原文不变、新列空初始化、legacy origin/deleted marker 保持 null', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 14), backupDir });
      expect(readSchemaVersion(db)).toBe(14);
      const now = '2026-08-01T00:00:00+08:00';
      db.exec('BEGIN');
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '华东医药',
        now,
        now,
      );
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, customer_id, entry_at, region, planned_install_done_at, manager_approval_reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'p1',
        'TP-V15-1',
        'pending_execution',
        'c1',
        '2026-08-01',
        '华东',
        '2026-08-15',
        '历史批复原因',
        now,
        now,
      );
      db.prepare(
        `INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('k1', 'p1', 'TP-V15-1', 'ECC-V15', now, now);
      db.prepare(
        `INSERT INTO instruments (id, project_id, name, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).run('i1', 'p1', '存量仪器', now, now);
      // 升级前 legacy Ship-to 主数据/申请与 import_record_audit 记录
      db.prepare(
        `INSERT INTO ship_to_requests (id, customer_name, new_site_address, account_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('req-legacy', '华东医药', '旧址A', 'ACC-LEGACY', 'completed', '2026-07-01', '2026-07-01');
      db.prepare(
        `INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)`,
      ).run('st-legacy', 'ACC-LEGACY', '华东医药', '旧址A', now);
      db.prepare(
        `INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('audit-legacy', 'sk-legacy', 'projects', 'p1', 'h1', 'h2', now);
      db.exec('COMMIT');

      runMigrations(db, { migrations: MIGRATIONS.slice(0, 15), backupDir });
      expect(readSchemaVersion(db)).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<
        string,
        unknown
      >;
      // 既有业务数据完整保留
      expect(project.temp_no).toBe('TP-V15-1');
      expect(project.entry_at).toBe('2026-08-01');
      // legacy region 原文保留（非枚举文本不改写、不置空、不猜测映射）
      expect(project.region).toBe('华东');
      // 计划装机日期复用 v14 列，原值保留
      expect(project.planned_install_done_at).toBe('2026-08-15');
      // legacy 批复原因/缺失资料保留可读（不因新增 manager_approved 而改写）
      expect(project.manager_approval_reason).toBe('历史批复原因');
      // 新列以空/兼容默认值初始化
      expect(project.project_note).toBeNull();
      expect(project.temporary_storage_address).toBeNull();
      expect(project.is_temporary_storage).toBeNull();
      expect(project.manager_approved).toBeNull();
      // 关联业务数据完整保留
      const contract = db.prepare('SELECT ecc FROM contracts WHERE id = ?').get('k1') as {
        ecc: string;
      };
      expect(contract.ecc).toBe('ECC-V15');
      const instrument = db.prepare('SELECT name FROM instruments WHERE id = ?').get('i1') as {
        name: string;
      };
      expect(instrument.name).toBe('存量仪器');

      // ---- 升级后新增审计结构已建，legacy 行保持 null（不按 Account ID 猜测回填）----
      const tables = tableNames(db);
      for (const t of NEW_AUDIT_TABLES) {
        expect(tables).toContain(t);
      }
      const legacyShipTo = db
        .prepare('SELECT origin_request_id FROM ship_tos WHERE id = ?')
        .get('st-legacy') as { origin_request_id: string | null };
      expect(legacyShipTo.origin_request_id).toBeNull();
      const legacyAudit = db
        .prepare('SELECT target_deleted_at, target_delete_operation_id FROM import_record_audit WHERE id = ?')
        .get('audit-legacy') as {
        target_deleted_at: string | null;
        target_delete_operation_id: string | null;
      };
      expect(legacyAudit.target_deleted_at).toBeNull();
      expect(legacyAudit.target_delete_operation_id).toBeNull();

      // 升级后新列可正常录入
      db.prepare(
        'UPDATE projects SET project_note = ?, temporary_storage_address = ?, is_temporary_storage = ?, manager_approved = ? WHERE id = ?',
      ).run('备注', '暂存地址A', 1, 1, 'p1');
      const updated = db
        .prepare(
          'SELECT project_note, temporary_storage_address, is_temporary_storage, manager_approved FROM projects WHERE id = ?',
        )
        .get('p1') as Record<string, unknown>;
      expect(updated.project_note).toBe('备注');
      expect(updated.temporary_storage_address).toBe('暂存地址A');
      expect(updated.is_temporary_storage).toBe(1);
      expect(updated.manager_approved).toBe(1);
      // 升级后 legacy 行可回填来源/标记（可写）
      db.prepare('UPDATE ship_tos SET origin_request_id = ? WHERE id = ?').run('req-legacy', 'st-legacy');
      db.prepare('UPDATE import_record_audit SET target_deleted_at = ?, target_delete_operation_id = ? WHERE id = ?').run(
        now,
        'op-x',
        'audit-legacy',
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('注入失败保留迁移前数据与可恢复状态：整体回滚、版本仍为 14、全部 v15 结构回滚、迁移前备份可恢复', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 14), backupDir });
      expect(readSchemaVersion(db)).toBe(14);
      const now = '2026-08-01T00:00:00+08:00';
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, region, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('p-keep', 'TP-KEEP', 'pending_execution', '华北', now, now);

      // 注入 v15 失败迁移：先执行真实 DDL 再抛错，验证 DDL 也被整体回滚
      const failing: Migration = {
        version: RELOCATION_WORKBENCH_MIGRATION_VERSION,
        name: 'failing-v15',
        up: (d: DatabaseSync) => {
          d.exec('ALTER TABLE projects ADD COLUMN project_note TEXT;');
          throw new Error('注入的 v15 迁移失败');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, {
          migrations: [...MIGRATIONS.slice(0, 14), failing],
          backupDir,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      expect(failure.originalVersion).toBe(14);

      // 整体回滚：版本仍为 14、原数据保留、失败迁移的 DDL 已回滚
      expect(readSchemaVersion(db)).toBe(14);
      const project = db.prepare('SELECT temp_no, region FROM projects WHERE id = ?').get('p-keep') as {
        temp_no: string;
        region: string;
      };
      expect(project.temp_no).toBe('TP-KEEP');
      expect(project.region).toBe('华北');
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).not.toContain('project_note');

      // v15 全部结构随事务回滚：无新审计表、无新列、无新索引
      const tables = tableNames(db);
      for (const t of NEW_AUDIT_TABLES) {
        expect(tables).not.toContain(t);
      }
      const stCols = (db.prepare('PRAGMA table_info(ship_tos)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(stCols).not.toContain('origin_request_id');
      const iraCols = (
        db.prepare('PRAGMA table_info(import_record_audit)').all() as { name: string }[]
      ).map((c) => c.name);
      expect(iraCols).not.toContain('target_deleted_at');
      expect(iraCols).not.toContain('target_delete_operation_id');
      const idxNames = indexRows(db).map((i) => i.name);
      expect(idxNames).not.toContain('idx_ship_tos_origin_request');

      // 迁移前安全备份存在且可恢复（含迁移前数据、版本 14）
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      const backup = openDatabase({ path: failure.preMigrationBackup, readOnly: true });
      expect(readSchemaVersion(backup)).toBe(14);
      const backupProject = backup
        .prepare('SELECT temp_no, region FROM projects WHERE id = ?')
        .get('p-keep') as { temp_no: string; region: string };
      expect(backupProject.temp_no).toBe('TP-KEEP');
      expect(backupProject.region).toBe('华北');
      closeDatabase(backup);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
