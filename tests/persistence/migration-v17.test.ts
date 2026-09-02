import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bootstrapDatabase, MIGRATIONS } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { MigrationError, runMigrations, type Migration } from '../../src/domain/capabilities/local-data-persistence/migration';
import { TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v16';
import { PROJECT_TAG_MIGRATION_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v17';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

describe('schema v17：项目分类标签', () => {
  it('空库引导到 v17：建立规范化三表、精确且稳定地 seed 三组七标签', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 最新版本（含 v18 物流费用字段可选迁移）；v17 标签迁移版本号仍为 17。
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(PROJECT_TAG_MIGRATION_VERSION).toBe(17);
      expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
      );

      const groups = db
        .prepare('SELECT id, name, sort_order FROM project_tag_groups ORDER BY sort_order, id')
        .all();
      expect(groups).toEqual([
        { id: 'project-tag-group-project-type', name: '项目类型', sort_order: 10 },
        { id: 'project-tag-group-service-type', name: '服务类型', sort_order: 20 },
        { id: 'project-tag-group-special-instrument', name: '特殊仪器', sort_order: 30 },
      ]);
      expect(
        db
          .prepare(
            `SELECT group_id, id, name FROM project_tag_definitions
             ORDER BY group_id, sort_order, id`,
          )
          .all(),
      ).toEqual([
        { group_id: 'project-tag-group-project-type', id: 'project-tag-project-type-relocation', name: '搬迁' },
        { group_id: 'project-tag-group-project-type', id: 'project-tag-project-type-pm', name: 'PM' },
        { group_id: 'project-tag-group-project-type', id: 'project-tag-project-type-certification', name: '认证' },
        { group_id: 'project-tag-group-service-type', id: 'project-tag-service-type-storage', name: '暂存' },
        { group_id: 'project-tag-group-special-instrument', id: 'project-tag-special-instrument-lcms-tof-65', name: 'LCMS TOF（65系列）' },
        { group_id: 'project-tag-group-special-instrument', id: 'project-tag-special-instrument-bso', name: 'BSO' },
        { group_id: 'project-tag-group-special-instrument', id: 'project-tag-special-instrument-icpms', name: 'ICPMS' },
      ]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v16 存量库升级并重复 bootstrap：保留项目且不重复 seed', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 16), backupDir });
      expect(readSchemaVersion(db)).toBe(TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION);
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(
        'v16-project',
        'TP-V17',
        'pending_entry',
        't',
        't',
      );

      runMigrations(db, { migrations: MIGRATIONS, backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION); // v17 升级后再到 v18
      expect(db.prepare('SELECT temp_no FROM projects WHERE id = ?').get('v16-project')).toMatchObject({
        temp_no: 'TP-V17',
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_tag_groups').get()).toMatchObject({ count: 3 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_tag_definitions').get()).toMatchObject({ count: 7 });
      closeDatabase(db);

      const reopened = bootstrapDatabase({ dataDir: dir });
      expect(reopened.migrationResult.applied).toHaveLength(0);
      expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM project_tag_groups').get()).toMatchObject({ count: 3 });
      expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM project_tag_definitions').get()).toMatchObject({ count: 7 });
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('执行 trim 唯一性、外键和 v17 表的业务修订触发器', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(() =>
        db.prepare('INSERT INTO project_tag_groups (id, name, sort_order) VALUES (?,?,?)').run(
          'custom-blank',
          ' 自定义 ',
          40,
        ),
      ).toThrow();
      db.prepare('INSERT INTO project_tag_groups (id, name, sort_order) VALUES (?,?,?)').run(
        'custom',
        '自定义',
        40,
      );
      expect(() =>
        db.prepare('INSERT INTO project_tag_groups (id, name, sort_order) VALUES (?,?,?)').run(
          'custom-duplicate',
          '自定义',
          50,
        ),
      ).toThrow();
      expect(() =>
        db.prepare('INSERT INTO project_tag_definitions (id, group_id, name, sort_order) VALUES (?,?,?,?)').run(
          'orphan-tag',
          'missing-group',
          '标签',
          10,
        ),
      ).toThrow();
      expect(() =>
        db.prepare('INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?,?)').run(
          'missing-project',
          'project-tag-project-type-relocation',
        ),
      ).toThrow();

      const before = db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as {
        business_revision: number;
      };
      db.prepare('INSERT INTO project_tag_definitions (id, group_id, name, sort_order) VALUES (?,?,?,?)').run(
        'custom-tag',
        'custom',
        '标签',
        10,
      );
      db.prepare('UPDATE project_tag_definitions SET sort_order = ? WHERE id = ?').run(20, 'custom-tag');
      db.prepare('DELETE FROM project_tag_definitions WHERE id = ?').run('custom-tag');
      const after = db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as {
        business_revision: number;
      };
      expect(after.business_revision).toBe(before.business_revision + 3);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v17 失败时回滚全部新结构并保留 v16 可恢复备份', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 16), backupDir });
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(
        'preserved-project',
        'TP-PRESERVED',
        'pending_entry',
        't',
        't',
      );
      const failing: Migration = {
        version: PROJECT_TAG_MIGRATION_VERSION,
        name: 'failing-v17',
        up: (migrationDb: DatabaseSync) => {
          migrationDb.exec('CREATE TABLE project_tag_groups (id TEXT PRIMARY KEY) STRICT;');
          throw new Error('injected v17 failure');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS.slice(0, 16), failing], backupDir });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(PROJECT_TAG_MIGRATION_VERSION);
      expect(failure.originalVersion).toBe(TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION);
      expect(readSchemaVersion(db)).toBe(TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_tag_groups'").get()).toBeUndefined();
      expect(db.prepare('SELECT temp_no FROM projects WHERE id = ?').get('preserved-project')).toMatchObject({
        temp_no: 'TP-PRESERVED',
      });
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      const backup = openDatabase({ path: failure.preMigrationBackup, readOnly: true });
      expect(readSchemaVersion(backup)).toBe(TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION);
      expect(backup.prepare('SELECT temp_no FROM projects WHERE id = ?').get('preserved-project')).toMatchObject({
        temp_no: 'TP-PRESERVED',
      });
      closeDatabase(backup);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
