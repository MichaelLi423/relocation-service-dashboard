import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase, INITIAL_MIGRATION, MIGRATIONS } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { Migration, MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { applyInitialSchema } from '../../src/domain/capabilities/local-data-persistence/schema';
import { cleanupTempDir, makeTempDir, makeTempDbPath } from '../helpers/tmp-db';

describe('schema 迁移（tasks 1.10 / D17）', () => {
  it(`成功迁移：v0 → v${LATEST_SCHEMA_VERSION} 应用初始 schema、归属快照列、迁移来源列、导入记录审计、正式库身份与业务修订触发器、v2 读取索引、业务日期化并写入 user_version`, () => {
    const dir = makeTempDir();
    try {
      const { db, migrationResult } = bootstrapDatabase({ dataDir: dir });
      expect(migrationResult.fromVersion).toBe(0);
      expect(migrationResult.toVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(migrationResult.applied).toHaveLength(MIGRATIONS.length);
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      // v2 补充的账号归属快照列存在（tasks 3.x 手工事实归属）
      const workCols = db
        .prepare('PRAGMA table_info(work_facts)')
        .all() as { name: string }[];
      expect(workCols.map((c) => c.name)).toContain('account_id');
      expect(workCols.map((c) => c.name)).toContain('username_snapshot');
      // v3 补充的归属列存在（tasks 4.x：ship_to_requests 占用 account_id 业务字段，
      // 归属列命名为 actor_account_id）
      const reqCols = db
        .prepare('PRAGMA table_info(ship_to_requests)')
        .all() as { name: string }[];
      expect(reqCols.map((c) => c.name)).toContain('actor_account_id');
      expect(reqCols.map((c) => c.name)).toContain('username_snapshot');
      const qrCols = db
        .prepare('PRAGMA table_info(qr_requests)')
        .all() as { name: string }[];
      expect(qrCols.map((c) => c.name)).toContain('account_id');
      expect(qrCols.map((c) => c.name)).toContain('username_snapshot');
      // v4 补充的归属列存在（tasks 5.x：掉票记录）
      const invCols = db
        .prepare('PRAGMA table_info(invoices)')
        .all() as { name: string }[];
      expect(invCols.map((c) => c.name)).toContain('account_id');
      expect(invCols.map((c) => c.name)).toContain('username_snapshot');
      // v5 补充的归属列存在（tasks 6.x：项目提醒操作）
      const projCols = db
        .prepare('PRAGMA table_info(projects)')
        .all() as { name: string }[];
      expect(projCols.map((c) => c.name)).toContain('reminder_account_id');
      expect(projCols.map((c) => c.name)).toContain('reminder_username_snapshot');
      // v6 补充的迁移审计摘要列存在（tasks 8.x：迁移幂等/forward-fix）
      const auditCols = db
        .prepare('PRAGMA table_info(migration_audit)')
        .all() as { name: string }[];
      expect(auditCols.map((c) => c.name)).toContain('source_hash');
      // v7 补充的导入来源列存在（tasks 8.x：迁移记录只更新同 source key）
      const contractCols = db
        .prepare('PRAGMA table_info(contracts)')
        .all() as { name: string }[];
      expect(contractCols.map((c) => c.name)).toContain('import_source_key');
      expect(contractCols.map((c) => c.name)).toContain('import_source_hash');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('幂等：已处于最新版本时不再重复迁移', () => {
    const dir = makeTempDir();
    try {
      const first = bootstrapDatabase({ dataDir: dir });
      closeDatabase(first.db);

      const second = bootstrapDatabase({ dataDir: dir });
      expect(second.migrationResult.applied).toHaveLength(0);
      expect(readSchemaVersion(second.db)).toBe(LATEST_SCHEMA_VERSION);
      closeDatabase(second.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('迁移失败：注入失败迁移 → 整体回滚、保留原库与迁移前安全备份、返回明确恢复信息', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      // 先应用 v1（初始 schema），并写入一条数据
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '华东医药',
        't',
        't',
      );

      // 注入 v2 失败迁移：先 DDL 再抛错，验证 DDL 也被回滚
      const failing: Migration = {
        version: 2,
        name: 'failing-migration',
        up: (d: DatabaseSync) => {
          d.exec('CREATE TABLE should_not_exist (id TEXT PRIMARY KEY) STRICT');
          throw new Error('注入的迁移失败');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [INITIAL_MIGRATION, failing], backupDir });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(2);
      expect(failure.originalVersion).toBe(1);

      // 数据库仍处于 v1，原数据保留，失败迁移的 DDL 已回滚
      expect(readSchemaVersion(db)).toBe(1);
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get('c1') as
        | Record<string, unknown>
        | undefined;
      expect(customer?.name).toBe('华东医药');
      const badTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'")
        .get();
      expect(badTable).toBeUndefined();

      // 迁移前安全备份存在（可恢复副本），且不静默丢弃现有数据
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      expect((thrown as MigrationError).message).toContain('迁移前安全备份');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('迁移失败后原库仍可正常关闭重开', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: [INITIAL_MIGRATION], backupDir });
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '保留客户',
        't',
        't',
      );

      const failing: Migration = {
        version: 2,
        name: 'fail-again',
        up: () => {
          throw new Error('boom');
        },
      };
      expect(() =>
        runMigrations(db, { migrations: [INITIAL_MIGRATION, failing], backupDir }),
      ).toThrow(MigrationError);
      closeDatabase(db);

      // 重开后数据仍在
      const reopened = openDatabase({ path: dbPath });
      const row = reopened.prepare('SELECT * FROM customers').get() as Record<string, unknown>;
      expect(row.name).toBe('保留客户');
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('升级时迁移现有数据（旧结构数据完整保留到新结构）', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      // 模拟旧库：无初始 schema 的表，仅有 legacy 数据表（版本 0）
      const db = openDatabase({ path: dbPath });
      db.exec('CREATE TABLE legacy_items (id TEXT PRIMARY KEY, label TEXT) STRICT');
      db.prepare('INSERT INTO legacy_items VALUES (?,?)').run('l1', '旧数据');

      // 新版本启动：v1 初始 schema + v2 迁移把 legacy 数据搬到新表
      const migrateLegacy: Migration = {
        version: 2,
        name: 'migrate-legacy',
        up: (d: DatabaseSync) => {
          applyInitialSchema(d);
          d.exec(`
            CREATE TABLE migrated_items (
              id TEXT PRIMARY KEY,
              label TEXT,
              created_at TEXT NOT NULL DEFAULT 't',
              updated_at TEXT NOT NULL DEFAULT 't'
            ) STRICT;
            INSERT INTO migrated_items (id, label) SELECT id, label FROM legacy_items;
          `);
        },
      };
      const result = runMigrations(db, { migrations: [INITIAL_MIGRATION, migrateLegacy], backupDir });
      expect(result.toVersion).toBe(2);
      const migrated = db.prepare('SELECT * FROM migrated_items').get() as Record<string, unknown>;
      expect(migrated.label).toBe('旧数据');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
