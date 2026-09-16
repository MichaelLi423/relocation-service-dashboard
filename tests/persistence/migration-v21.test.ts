import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { MigrationError, runMigrations, type Migration } from '../../src/domain/capabilities/local-data-persistence/migration';
import { businessRevisionTriggerName } from '../../src/domain/capabilities/local-data-persistence/schema-v10';
import {
  applyTransferredStatusMigration,
  LATEST_SCHEMA_VERSION,
  TRANSFERRED_STATUS_MIGRATION_VERSION,
} from '../../src/domain/capabilities/local-data-persistence/schema-v21';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v21：新增项目主状态「已转单」（transferred）。
 *
 * - projects.status CHECK 增加 transferred（重建表，完整保留全部列/STRICT/UNIQUE/外键）；
 * - project_status_transition_audit 的 from_status/to_status CHECK 增加 transferred；
 * - 存量数据原样保留、不归一化；v7/v12 索引与 v10 业务修订触发器完整重建；
 * - 全部官方引用 projects 的子表外键仍指向 projects（不指向 projects_legacy）；
 * - 重建后 transferred 可持久化，foreign_key_check 无违规；
 * - 恢复场景：schema 已重建但 user_version=20 时重跑 v21 幂等成功。
 */

/** 官方引用 projects(id) 的全部子表（v1 基础 + v3/v15/v17 追加）。 */
const CHILD_TABLES = [
  'contracts',
  'batches',
  'instruments',
  'activities',
  'service_orders',
  'invoices',
  'damage_repair_items',
  'project_tag_assignments',
  'project_status_transition_audit',
] as const;

/** projects 的官方索引（v7 导入来源 + v12 读取索引）与审计表索引（v15）。 */
const PROJECT_INDEXES = [
  'idx_projects_import_source_key',
  'idx_projects_status',
  'idx_projects_updated',
  'idx_projects_region',
  'idx_projects_reminder',
] as const;
const AUDIT_INDEX = 'idx_project_status_transition_project_time';

/** 读取布尔型 PRAGMA 当前值（foreign_keys / legacy_alter_table，返回 0/1）。 */
function readPragma(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return row[name];
}

function expectChildFksPointToProjects(db: DatabaseSync): void {
  for (const table of CHILD_TABLES) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
    expect(fks.some((fk) => fk.table === 'projects'), `${table} 应引用 projects`).toBe(true);
    expect(fks.some((fk) => fk.table === 'projects_legacy'), `${table} 不应引用 projects_legacy`).toBe(false);
  }
}

function expectProjectsIndexesAndTriggers(db: DatabaseSync): void {
  for (const index of [...PROJECT_INDEXES, AUDIT_INDEX]) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get(index) as { sql: string } | undefined;
    expect(row, `索引 ${index} 应存在`).toBeDefined();
  }
  for (const event of ['insert', 'update', 'delete'] as const) {
    const trigger = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
      .get(businessRevisionTriggerName('projects', event)) as { sql: string } | undefined;
    expect(trigger, `触发器 ${event} 应存在`).toBeDefined();
    expect(trigger!.sql).toContain('ON projects');
  }
}

/** 建立 v20 数据库（含完整 projects 数据的真实 fixture）。 */
function openV20(dir: string): { db: DatabaseSync; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 20), backupDir });
  expect(readSchemaVersion(db)).toBe(20);
  return { db, backupDir };
}

/** 写入账号/客户/项目/合同/批次（子表外键引用 projects）与一条状态转换审计。 */
function seedData(db: DatabaseSync): void {
  const nowIso = '2026-08-01T00:00:00+08:00';
  db.exec('BEGIN');
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人', 'hash', 'salt', nowIso, nowIso);
  db.prepare(
    'INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)',
  ).run('customer-1', '迁移客户', nowIso, nowIso);
  db.prepare(
    `INSERT INTO projects (
       id, temp_no, status, customer_id, contract_id, entry_at, region,
       reminder_account_id, reminder_username_snapshot, import_source_key, import_source_hash,
       planned_install_done_at, project_note, temporary_storage_address, is_temporary_storage,
       manager_approved, temporary_instrument_name, temporary_instrument_model, temporary_has_ups,
       created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'p1', 'TP-TRANSFER', 'executing', 'customer-1', null, '2026-07-01', 'East',
    'account-1', '负责人', 'project|P-1', 'src-hash-p1',
    '2026-08-10', '备注', '暂存地址', 1, 1, '质谱仪', 'TOF', 1,
    nowIso, nowIso,
  );
  db.prepare(
    'INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('ct1', 'p1', 'T-1', nowIso, nowIso);
  db.prepare(
    'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
  ).run('b1', 'p1', nowIso, nowIso);
  db.prepare(
    `INSERT INTO project_status_transition_audit (
       id, project_id, from_status, to_status, reason, effective_business_date, source, created_at
     ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run('aud-1', 'p1', 'pending_execution', 'executing', 'manual', '2026-07-02', 'user', nowIso);
  db.exec('COMMIT');
}

describe('schema v21：新增项目主状态「已转单」（重建 projects 与状态转换审计表）', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBe(21);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v20→v21：projects 全部列/STRICT/UNIQUE/外键保留，数据原样保留，子表外键与索引/触发器完整', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV20(dir);
      seedData(db);

      expectChildFksPointToProjects(db);
      expectProjectsIndexesAndTriggers(db);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      const cols = db.prepare('PRAGMA table_info(projects)').all() as {
        name: string;
        type: string;
        notnull: number;
      }[];
      const names = cols.map((c) => c.name);
      for (const col of [
        'id', 'temp_no', 'status', 'pre_entry_execution', 'scope_confirmed', 'customer_id', 'contract_id',
        'entry_at', 'region', 'old_site_contact', 'new_site_contact', 'old_site_address', 'new_site_address',
        'contract_start_date', 'contract_end_date', 'plan_visit_at', 'plan_transport_at', 'site_confirmed',
        'actual_install_done_at', 'acceptance_report', 'acceptance_report_date', 'cancelled_at', 'cancel_reason',
        'reminder_at', 'reminder_note', 'temporary_instrument_count', 'manager_approval_reason', 'manager_approval_missing',
        'created_at', 'updated_at', 'reminder_account_id', 'reminder_username_snapshot',
        'import_source_key', 'import_source_hash', 'planned_install_done_at',
        'project_note', 'temporary_storage_address', 'is_temporary_storage', 'manager_approved',
        'temporary_instrument_name', 'temporary_instrument_model', 'temporary_has_ups',
      ]) {
        expect(names, `应保留列 ${col}`).toContain(col);
      }
      expect(() =>
        db.prepare('INSERT INTO projects (id, temp_no, status, site_confirmed, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run('p-strict', 'TP-STRICT', 'pending_entry', 'not-a-number', 't', 't'),
      ).toThrow();

      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<string, unknown>;
      expect(p.temp_no).toBe('TP-TRANSFER');
      expect(p.status).toBe('executing');
      expect(p.region).toBe('East');
      expect(p.entry_at).toBe('2026-07-01');
      expect(p.import_source_key).toBe('project|P-1');
      expect(p.manager_approved).toBe(1);

      expectChildFksPointToProjects(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expectProjectsIndexesAndTriggers(db);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v21 后：transferred 可持久化到 projects 与状态转换审计表，触发器生效', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV20(dir);
      seedData(db);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });

      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('transferred', 'p1');
      expect(db.prepare('SELECT status FROM projects WHERE id = ?').get('p1')?.status).toBe('transferred');
      db.prepare(
        `INSERT INTO project_status_transition_audit (
           id, project_id, from_status, to_status, reason, effective_business_date, source, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      ).run('aud-2', 'p1', 'executing', 'transferred', 'transfer', '2026-08-02', 'user', '2026-08-02T00:00:00+08:00');
      const audit = db.prepare('SELECT from_status, to_status FROM project_status_transition_audit WHERE id = ?').get('aud-2') as {
        from_status: string;
        to_status: string;
      };
      expect(audit).toEqual({ from_status: 'executing', to_status: 'transferred' });

      const readRev = (): number =>
        (db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as { business_revision: number }).business_revision;
      const base = readRev();
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('completed', 'p1');
      expect(readRev()).toBe(base + 1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复场景：schema 已重建但 user_version=20 时重跑 v21 幂等成功、数据保留', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV20(dir);
      seedData(db);

      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('PRAGMA legacy_alter_table = ON;');
      db.exec('BEGIN');
      applyTransferredStatusMigration(db);
      db.exec('COMMIT');
      db.exec('PRAGMA legacy_alter_table = OFF;');
      db.exec('PRAGMA foreign_keys = ON;');
      expect(readSchemaVersion(db)).toBe(20);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<string, unknown>;
      expect(p.temp_no).toBe('TP-TRANSFER');
      expect(p.status).toBe('executing');
      expectChildFksPointToProjects(db);
      expectProjectsIndexesAndTriggers(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('注入失败：apply 中途抛错整体回滚，user_version/旧表结构与数据/索引/触发器/外键/pragma 恢复，随后重跑成功', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV20(dir);
      seedData(db);
      const fkBefore = readPragma(db, 'foreign_keys');
      const legacyBefore = readPragma(db, 'legacy_alter_table');
      expect(fkBefore).toBe(1);
      expect(legacyBefore).toBe(0);
      const projectsSqlBefore = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get() as { sql: string }
      ).sql;

      // 注入 v21 失败迁移：先执行真实的表重建 DDL（RENAME/建表/拷贝/DROP），再抛错，
      // 验证运行器事务内的 DDL 也被整体回滚，且事务外切换的 pragma 被恢复。
      const failing: Migration = {
        version: TRANSFERRED_STATUS_MIGRATION_VERSION,
        name: 'failing-v21',
        disableForeignKeys: true,
        up: (d: DatabaseSync) => {
          applyTransferredStatusMigration(d);
          throw new Error('注入的 v21 迁移失败');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS.slice(0, 20), failing], backupDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(TRANSFERRED_STATUS_MIGRATION_VERSION);
      expect(failure.originalVersion).toBe(20);

      // user_version 回滚到 20。
      expect(readSchemaVersion(db)).toBe(20);
      // 旧 projects.status CHECK 恢复：transferred 被旧 CHECK 拒绝。
      expect(() => db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('transferred', 'p1')).toThrow();
      // 旧项目状态转换审计表 CHECK 恢复：transferred 被拒绝。
      expect(() =>
        db
          .prepare(
            `INSERT INTO project_status_transition_audit (id, project_id, from_status, to_status, created_at)
             VALUES (?,?,?,?,?)`,
          )
          .run('aud-injected', 'p1', 'executing', 'transferred', 't'),
      ).toThrow();
      // 重建过程无遗留临时表。
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name IN ('projects_legacy','project_status_transition_audit_legacy')")
          .all(),
      ).toEqual([]);
      // 表结构原样恢复（DDL 文本一致）。
      const projectsSqlAfter = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get() as { sql: string }
      ).sql;
      expect(projectsSqlAfter).toBe(projectsSqlBefore);

      // 数据原样保留。
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<string, unknown>;
      expect(p.temp_no).toBe('TP-TRANSFER');
      expect(p.status).toBe('executing');
      expect(p.import_source_key).toBe('project|P-1');
      expect((db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n).toBe(1);

      // 索引/触发器/子表外键恢复且无外键违规。
      expectProjectsIndexesAndTriggers(db);
      expectChildFksPointToProjects(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // 事务外切换的 pragma 恢复到原始值。
      expect(readPragma(db, 'foreign_keys')).toBe(fkBefore);
      expect(readPragma(db, 'legacy_alter_table')).toBe(legacyBefore);

      // 迁移前安全备份存在且可恢复（版本 20）。
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      const backup = openDatabase({ path: failure.preMigrationBackup, readOnly: true });
      expect(readSchemaVersion(backup)).toBe(20);
      closeDatabase(backup);

      // 随后正常重跑 v21 成功：版本 21、数据保留、transferred 可持久化。
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare('SELECT status, temp_no FROM projects WHERE id = ?').get('p1')).toMatchObject({
        status: 'executing',
        temp_no: 'TP-TRANSFER',
      });
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('transferred', 'p1');
      expect(db.prepare('SELECT status FROM projects WHERE id = ?').get('p1')).toMatchObject({ status: 'transferred' });
      expectProjectsIndexesAndTriggers(db);
      expectChildFksPointToProjects(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
