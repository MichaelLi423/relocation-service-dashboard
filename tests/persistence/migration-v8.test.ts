import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  INITIAL_MIGRATION,
  MIGRATIONS,
  ATTRIBUTION_MIGRATION,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { SqliteShipToRequestRepository } from '../../src/domain/capabilities/local-data-persistence/ship-to-repositories';
import { UniquenessError } from '../../src/domain/core/errors';
import { localCalendarDateOf } from '../../src/domain/capabilities/local-data-persistence/business-date';
import { cleanupTempDir, makeTempDir, makeTempDbPath } from '../helpers/tmp-db';

/**
 * schema v8 迁移（Oracle 高风险 5/6/9）：
 * - damage_repair_items.project_id 回填并 NOT NULL，无法回填即失败且保留可恢复状态；
 * - ship_to_requests trim 后同客户同新址唯一索引，存量重复即失败不静默删除；
 * - 重建表完整保留既有列/外键/CHECK/账号归属。
 */

/** 建立 v1 数据库（含 instrument + repair 数据的真实 fixture）。 */
function seedV1(db: DatabaseSync): void {
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'TP-1', 'pending_execution', 't', 't');
  db.prepare(
    'INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
  ).run('a1', 'p1', 't', 't');
  db.prepare(
    'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('i1', 'p1', '仪器A', 't', 't');
  // v1 无 project_id 列：损坏/维修事项仅关联仪器
  db.prepare(
    `INSERT INTO damage_repair_items (
       id, instrument_id, damage_reason, issue_status, close_reason,
       part_number, part_quantity, part_amount_cents, part_currency,
       part_requested_at, part_status, repair_note, registered_at, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'd1', 'i1', '运输碰撞', 'untreated', null,
    'PART-1', 1, 10000, 'USD',
    '2026-08-01T09:00:00+08:00', 'arrived', null, '2026-08-01T08:00:00+08:00', 't', 't',
  );
  db.prepare(
    'INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)',
  ).run('l1', 'a1', 'd1', 't');
}

/** 建 v2 数据库 fixture：在 v1 基础上应用 v2 归属列迁移后写入数据。 */
function seedV2(db: DatabaseSync): void {
  seedV1(db);
}

function assertMigratedToV10(db: DatabaseSync): void {
  expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
  // project_id 已按 instrument 回填
  const row = db.prepare('SELECT project_id FROM damage_repair_items WHERE id = ?').get('d1') as {
    project_id: string;
  };
  expect(row.project_id).toBe('p1');
  // 重建后 project_id NOT NULL
  const cols = db.prepare('PRAGMA table_info(damage_repair_items)').all() as {
    name: string;
    notnull: number;
  }[];
  const projectCol = cols.find((c) => c.name === 'project_id');
  expect(projectCol?.notnull).toBe(1);
  // 既有列/账号归属完整保留
  const names = cols.map((c) => c.name);
  for (const col of [
    'id', 'instrument_id', 'damage_reason', 'issue_status', 'close_reason',
    'part_number', 'part_quantity', 'part_amount_cents', 'part_currency',
    'part_requested_at', 'part_status', 'repair_note', 'registered_at',
    'project_id', 'account_id', 'username_snapshot', 'created_at', 'updated_at',
  ]) {
    expect(names).toContain(col);
  }
  // 数据完整保留（含备件信息、登记时间）；金额列按 BigInt 精确读取
  const item = db
    .prepare('SELECT part_number, part_quantity, part_amount_cents, registered_at FROM damage_repair_items WHERE id = ?')
    .get('d1') as Record<string, unknown>;
  expect(item.part_number).toBe('PART-1');
  expect(BigInt(String(item.part_amount_cents))).toBe(10000n);
  // v13 业务日期化：registered_at 已统一为 yyyy-mm-dd（冻结本机时区换算）。
  expect(item.registered_at).toBe(localCalendarDateOf(new Date('2026-08-01T08:00:00+08:00')));
  // activity_damage_links 数据与外键完整保留
  const link = db
    .prepare('SELECT activity_id, damage_item_id FROM activity_damage_links WHERE id = ?')
    .get('l1') as { activity_id: string; damage_item_id: string };
  expect(link.activity_id).toBe('a1');
  expect(link.damage_item_id).toBe('d1');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  // v7 import_source 列与 v5 归属列仍在
  const contractCols = db.prepare('PRAGMA table_info(contracts)').all() as { name: string }[];
  expect(contractCols.map((c) => c.name)).toContain('import_source_key');
  expect(contractCols.map((c) => c.name)).toContain('import_source_hash');
}

describe('schema v8：damage_repair_items.project_id 回填并 NOT NULL（Oracle 高风险 5/6）', () => {
  it('真实 v1 库（含 instrument + repair 数据）升级到 v8：project_id 回填、NOT NULL、外键/归属/来源列完整保留', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      expect(readSchemaVersion(db)).toBe(1);
      seedV1(db);

      const result = runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(result.applied.map((m) => m.version)).toEqual(MIGRATIONS.slice(1).map((m) => m.version));
      assertMigratedToV10(db);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('真实 v2 库（含 instrument + repair 数据）升级到 v8：project_id 回填、NOT NULL、外键/归属列完整保留', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION, ATTRIBUTION_MIGRATION], backupDir });
      expect(readSchemaVersion(db)).toBe(2);
      seedV2(db);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      assertMigratedToV10(db);
      // v2 归属列（v8 重建后仍保留）
      const cols = db.prepare('PRAGMA table_info(damage_repair_items)').all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('account_id');
      expect(cols.map((c) => c.name)).toContain('username_snapshot');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('多项目数据回填各自所属项目；rebuild 后事项完整保留', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      seedV1(db);
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p2', 'TP-2', 'pending_execution', 't', 't');
      db.prepare(
        'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('i2', 'p2', '仪器B', 't', 't');
      db.prepare(
        `INSERT INTO damage_repair_items (
           id, instrument_id, issue_status, part_number, part_quantity,
           part_amount_cents, part_currency, registered_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run('d2', 'i2', 'untreated', 'PART-2', 2, 20000, 'RMB', '2026-08-02', 't', 't');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      const projects = db
        .prepare('SELECT id, project_id FROM damage_repair_items ORDER BY id')
        .all() as { id: string; project_id: string }[];
      expect(projects).toEqual([
        { id: 'd1', project_id: 'p1' },
        { id: 'd2', project_id: 'p2' },
      ]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('孤儿事项（instrument 缺失）无法回填 → 迁移失败并保留可恢复状态', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      // 真实 v1 数据
      seedV1(db);
      // 注入孤儿：引用不存在的仪器（迁移阶段外关闭 FK 以模拟存量脏数据）
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare(
        `INSERT INTO damage_repair_items (
           id, instrument_id, issue_status, registered_at, created_at, updated_at
         ) VALUES (?,?,?,?,?,?)`,
      ).run('d-orphan', 'i-missing', 'untreated', 't', 't', 't');
      db.exec('PRAGMA foreign_keys = ON;');

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(8);
      expect(failure.originalVersion).toBe(1);
      expect((thrown as MigrationError).message).toContain('无法回填所属项目');

      // 回滚后 v8 未提交（v2~v7 已各自提交），孤儿行与正常行均未丢失
      expect(readSchemaVersion(db)).toBe(7);
      expect(db.prepare('SELECT COUNT(*) AS n FROM damage_repair_items').get()?.n).toBe(2);
      const orphan = db.prepare('SELECT id FROM damage_repair_items WHERE id = ?').get('d-orphan');
      expect(orphan).toBeTruthy();
      // 迁移前安全备份存在（可恢复副本）
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      closeDatabase(db);

      // 重开后数据仍在（可恢复）
      const reopened = openDatabase({ path: dbPath });
      expect(readSchemaVersion(reopened)).toBe(7);
      expect(reopened.prepare('SELECT COUNT(*) AS n FROM damage_repair_items').get()?.n).toBe(2);
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v8 重建后 project_id 缺省即拒绝（NOT NULL 生效）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('p1', 'TP-1', 'pending_execution', 't', 't');
      db.prepare(
        'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('i1', 'p1', '仪器A', 't', 't');
      expect(() =>
        db
          .prepare(
            `INSERT INTO damage_repair_items (
               id, instrument_id, issue_status, registered_at, created_at, updated_at
             ) VALUES (?,?,?,?,?,?)`,
          )
          .run('d-no-project', 'i1', 'untreated', 't', 't', 't'),
      ).toThrow();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('schema v8：ship_to_requests trim 唯一索引（Oracle 高风险 9）', () => {
  it('存量 trim 后重复 → 迁移失败并报告，不静默删除', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      db.prepare(
        `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('r1', '华东医药', '新址A', 'pending_submit', 't', 't');
      db.prepare(
        `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('r2', ' 华东医药 ', ' 新址A ', 'processing', 't', 't');

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(8);
      expect(failure.originalVersion).toBe(1);
      expect((thrown as MigrationError).message).toContain('不静默删除');

      // 原库保留（v8 未提交）、两条申请均未删除
      expect(readSchemaVersion(db)).toBe(7);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get()?.n).toBe(2);
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v8 建索引后：直接 DB 插入 trim 变体重复被拒，仓储保存重复映射为领域冲突', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      db.prepare(
        `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('r1', '华东医药', '新址A', 'pending_submit', 't', 't');

      // 绕过领域层直接插入 trim 变体重复 → 唯一索引拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run('r2', ' 华东医药 ', ' 新址A ', 'pending_submit', 't', 't'),
      ).toThrow();
      // 客户或新址不同仍允许
      expect(() =>
        db
          .prepare(
            `INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run('r3', '华北医药', '新址A', 'pending_submit', 't', 't'),
      ).not.toThrow();

      // 仓储 save 唯一冲突映射为 UniquenessError（领域冲突）
      const repo = new SqliteShipToRequestRepository(db);
      expect(() =>
        repo.save({
          id: 'r4',
          customerName: '华东医药',
          newSiteAddress: '新址A',
          accountId: null,
          status: 'pending_submit',
          submittedAt: null,
          completedAt: null,
          operatorAccountId: null,
          operatorUsername: null,
          createdAt: 't',
          updatedAt: 't',
        }),
      ).toThrow(UniquenessError);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v8 仓储 findByCustomerAndAddress 按 trim 后值命中', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const repo = new SqliteShipToRequestRepository(db);
      repo.save({
        id: 'r1',
        customerName: '华东医药',
        newSiteAddress: '新址A',
        accountId: null,
        status: 'pending_submit',
        submittedAt: null,
        completedAt: null,
        operatorAccountId: null,
        operatorUsername: null,
        createdAt: 't',
        updatedAt: 't',
      });
      expect(repo.findByCustomerAndAddress('  华东医药  ', '  新址A  ')?.id).toBe('r1');
      expect(repo.findByCustomerAndAddress('华北医药', '新址A')).toBeUndefined();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
