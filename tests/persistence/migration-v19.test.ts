import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { businessRevisionTriggerName } from '../../src/domain/capabilities/local-data-persistence/schema-v10';
import { applyUnderRepairStatusMigration } from '../../src/domain/capabilities/local-data-persistence/schema-v19';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v19：新增项目主状态「维修中」（under_repair）。
 *
 * - projects.status CHECK 增加 under_repair（重建表，完整保留全部列/STRICT/UNIQUE/外键）；
 * - project_status_transition_audit 的 from_status/to_status CHECK 增加 under_repair；
 * - 存量数据原样保留、不归一化；v7/v12 索引与 v10 业务修订触发器完整重建；
 * - 全部官方引用 projects 的子表外键仍指向 projects（不指向 projects_legacy）；
 * - 重建后 under_repair 可持久化，foreign_key_check 无违规；
 * - 恢复场景：schema 已重建但 user_version=18 时重跑 v19 幂等成功。
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

/** 建立 v18 数据库（含完整 projects 数据的真实 fixture）。 */
function openV18(dir: string): { db: DatabaseSync; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 18), backupDir });
  expect(readSchemaVersion(db)).toBe(18);
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
    'p1', 'TP-REPAIR', 'executing', 'customer-1', null, '2026-07-01', 'East',
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

describe('schema v19：新增项目主状态「维修中」（重建 projects 与状态转换审计表）', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v18→v19：projects 全部列/STRICT/UNIQUE/外键保留，数据原样保留，子表外键与索引/触发器完整', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV18(dir);
      seedData(db);

      // 迁移前：子表外键指向 projects、索引/触发器齐全
      expectChildFksPointToProjects(db);
      expectProjectsIndexesAndTriggers(db);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // 全部 42 列保留（v1 基础列 + v2/v5/v7/v14/v15/v16 追加列）
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
      // STRICT 保留：非 STRICT 表插入未知类型列会静默接受；STRICT 表拒绝 TEXT 进 INTEGER 列
      expect(() =>
        db.prepare('INSERT INTO projects (id, temp_no, status, site_confirmed, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run('p-strict', 'TP-STRICT', 'pending_entry', 'not-a-number', 't', 't'),
      ).toThrow();
      // 数据原样保留（含 v15/v16 追加列与导入来源列）
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<string, unknown>;
      expect(p.temp_no).toBe('TP-REPAIR');
      expect(p.status).toBe('executing');
      expect(p.region).toBe('East');
      expect(p.entry_at).toBe('2026-07-01');
      expect(p.reminder_account_id).toBe('account-1');
      expect(p.import_source_key).toBe('project|P-1');
      expect(p.planned_install_done_at).toBe('2026-08-10');
      expect(p.project_note).toBe('备注');
      expect(p.temporary_storage_address).toBe('暂存地址');
      expect(p.is_temporary_storage).toBe(1);
      expect(p.manager_approved).toBe(1);
      expect(p.temporary_instrument_name).toBe('质谱仪');
      expect(p.temporary_has_ups).toBe(1);
      // 子表外键仍指向 projects（不指向 projects_legacy），foreign_key_check 无违规
      expectChildFksPointToProjects(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // 索引/触发器迁移后完整保留
      expectProjectsIndexesAndTriggers(db);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v19 后：under_repair 可持久化到 projects 与状态转换审计表，触发器生效', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV18(dir);
      seedData(db);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });

      // projects.status CHECK 接受 under_repair
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('under_repair', 'p1');
      expect(db.prepare('SELECT status FROM projects WHERE id = ?').get('p1')?.status).toBe('under_repair');
      // 审计表 from/to CHECK 接受 under_repair
      db.prepare(
        `INSERT INTO project_status_transition_audit (
           id, project_id, from_status, to_status, reason, effective_business_date, source, created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      ).run('aud-2', 'p1', 'executing', 'under_repair', 'manual', '2026-08-02', 'user', '2026-08-02T00:00:00+08:00');
      const audit = db.prepare('SELECT from_status, to_status FROM project_status_transition_audit WHERE id = ?').get('aud-2') as {
        from_status: string;
        to_status: string;
      };
      expect(audit).toEqual({ from_status: 'executing', to_status: 'under_repair' });

      // v10 业务修订触发器实际生效：UPDATE 递增 business_revision
      const readRev = (): number =>
        (db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as { business_revision: number }).business_revision;
      const base = readRev();
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('pending_acceptance', 'p1');
      expect(readRev()).toBe(base + 1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复场景：schema 已重建但 user_version=18 时重跑 v19 幂等成功、数据保留', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV18(dir);
      seedData(db);

      // 模拟崩溃残留：手动执行 v19 表重建（不写 user_version），保持 user_version=18。
      // 与运行器相同的前置 pragma（事务外设置，事务内为 no-op）。
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('PRAGMA legacy_alter_table = ON;');
      db.exec('BEGIN');
      applyUnderRepairStatusMigration(db);
      db.exec('COMMIT');
      db.exec('PRAGMA legacy_alter_table = OFF;');
      db.exec('PRAGMA foreign_keys = ON;');
      expect(readSchemaVersion(db)).toBe(18); // 版本号未写入（模拟崩溃点）

      // 重跑迁移：v19 幂等重建成功，版本号写入，数据保留
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<string, unknown>;
      expect(p.temp_no).toBe('TP-REPAIR');
      expect(p.status).toBe('executing');
      expectChildFksPointToProjects(db);
      expectProjectsIndexesAndTriggers(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});