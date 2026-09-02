import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { Migration, MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v16';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { RELOCATION_WORKBENCH_MIGRATION_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v15';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v16：项目暂定仪器范围字段（用户确认的 v16 项目暂定仪器范围）。
 *
 * - projects.temporary_instrument_name（暂定仪器名称，可空 TEXT，trim 后保存、空串统一 null）；
 * - projects.temporary_instrument_model（暂定仪器型号，可空 TEXT，trim 后保存、空串统一 null）；
 * - projects.temporary_has_ups（是否配备 UPS，可空 INTEGER；null=未填写、0=否、1=是）。
 *
 * 仅新增可空列、不重建表、不改写存量值；legacy region 原文保留；v15 字段原样保留；
 * 暂定仪器数量（temporary_instrument_count）保持独立不变。
 * 失败整体回滚并保留迁移前安全备份（可恢复）；PRAGMA foreign_key_check 通过。
 */

describe('schema v16：项目暂定仪器范围字段', () => {
  it('全新库引导到最新版本：迁移序列包含 v16、三列已建立、三态写入与 foreign_key_check 通过', () => {
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
        'temporary_instrument_name',
        'temporary_instrument_model',
        'temporary_has_ups',
      ]) {
        expect(cols).toContain(name);
      }
      // 既有 v15 列仍在（v16 只追加）
      for (const name of [
        'project_note',
        'temporary_storage_address',
        'is_temporary_storage',
        'manager_approved',
      ]) {
        expect(cols).toContain(name);
      }
      // 暂定数量仍独立复用原字段
      expect(cols).toContain('temporary_instrument_count');

      // ---- 三态写入：null=未填写、0=否、1=是 ----
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).run('p-null', 'TP-NULL', 'pending_entry', 't', 't');
      const blank = db
        .prepare(
          'SELECT temporary_instrument_name, temporary_instrument_model, temporary_has_ups FROM projects WHERE id = ?',
        )
        .get('p-null') as {
        temporary_instrument_name: string | null;
        temporary_instrument_model: string | null;
        temporary_has_ups: number | null;
      };
      expect(blank.temporary_instrument_name).toBeNull();
      expect(blank.temporary_instrument_model).toBeNull();
      expect(blank.temporary_has_ups).toBeNull(); // 未填写 ≠ 推断「否」

      db.prepare(
        `INSERT INTO projects (id, temp_no, status, temporary_instrument_name, temporary_instrument_model, temporary_has_ups, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('p-set', 'TP-SET', 'pending_entry', '生化分析仪', 'BS-200', 1, 't', 't');
      const set = db
        .prepare(
          'SELECT temporary_instrument_name, temporary_instrument_model, temporary_has_ups FROM projects WHERE id = ?',
        )
        .get('p-set') as {
        temporary_instrument_name: string;
        temporary_instrument_model: string;
        temporary_has_ups: number;
      };
      expect(set.temporary_instrument_name).toBe('生化分析仪');
      expect(set.temporary_instrument_model).toBe('BS-200');
      expect(set.temporary_has_ups).toBe(1);

      db.prepare(
        `INSERT INTO projects (id, temp_no, status, temporary_instrument_name, temporary_instrument_model, temporary_has_ups, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('p-no-ups', 'TP-NOUPS', 'pending_entry', '离心机', 'L-50', 0, 't', 't');
      const noUps = db
        .prepare('SELECT temporary_has_ups FROM projects WHERE id = ?')
        .get('p-no-ups') as { temporary_has_ups: number };
      expect(noUps.temporary_has_ups).toBe(0); // 显式「否」

      // 暂定数量不受影响（独立复用原字段）
      db.prepare('UPDATE projects SET temporary_instrument_count = ? WHERE id = ?').run(7, 'p-set');
      const count = db
        .prepare('SELECT temporary_instrument_count FROM projects WHERE id = ?')
        .get('p-set') as { temporary_instrument_count: number };
      expect(count.temporary_instrument_count).toBe(7);

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v15 存量库升级到 v16：业务数据完整保留、legacy region 原文不变、v15 字段原样保留、新列 null 初始化', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 15), backupDir });
      expect(readSchemaVersion(db)).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      const now = '2026-08-01T00:00:00+08:00';
      db.exec('BEGIN');
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '华东医药',
        now,
        now,
      );
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, customer_id, entry_at, region, project_note,
           temporary_storage_address, is_temporary_storage, manager_approved,
           temporary_instrument_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'p1',
        'TP-V16-1',
        'pending_execution',
        'c1',
        '2026-08-01',
        '华东',
        '存量备注',
        '暂存地址A',
        1,
        1,
        9,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('k1', 'p1', 'TP-V16-1', 'ECC-V16', now, now);
      db.prepare(
        `INSERT INTO instruments (id, project_id, name, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).run('i1', 'p1', '存量仪器', now, now);
      db.exec('COMMIT');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Record<
        string,
        unknown
      >;
      // 既有业务数据完整保留
      expect(project.temp_no).toBe('TP-V16-1');
      expect(project.entry_at).toBe('2026-08-01');
      // legacy region 原文保留（非枚举文本不改写、不置空、不猜测映射）
      expect(project.region).toBe('华东');
      // v15 字段原样保留
      expect(project.project_note).toBe('存量备注');
      expect(project.temporary_storage_address).toBe('暂存地址A');
      expect(project.is_temporary_storage).toBe(1);
      expect(project.manager_approved).toBe(1);
      // 暂定数量独立保留
      expect(project.temporary_instrument_count).toBe(9);
      // v16 新列以 null 初始化
      expect(project.temporary_instrument_name).toBeNull();
      expect(project.temporary_instrument_model).toBeNull();
      expect(project.temporary_has_ups).toBeNull();

      // 升级后新列可正常录入（三态）
      db.prepare(
        'UPDATE projects SET temporary_instrument_name = ?, temporary_instrument_model = ?, temporary_has_ups = ? WHERE id = ?',
      ).run('PCR 仪', 'P-96', 1, 'p1');
      const updated = db
        .prepare(
          'SELECT temporary_instrument_name, temporary_instrument_model, temporary_has_ups FROM projects WHERE id = ?',
        )
        .get('p1') as Record<string, unknown>;
      expect(updated.temporary_instrument_name).toBe('PCR 仪');
      expect(updated.temporary_instrument_model).toBe('P-96');
      expect(updated.temporary_has_ups).toBe(1);

      // 关联业务数据完整保留
      const contract = db.prepare('SELECT ecc FROM contracts WHERE id = ?').get('k1') as {
        ecc: string;
      };
      expect(contract.ecc).toBe('ECC-V16');
      const instrument = db.prepare('SELECT name FROM instruments WHERE id = ?').get('i1') as {
        name: string;
      };
      expect(instrument.name).toBe('存量仪器');

      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('注入失败保留迁移前数据与可恢复状态：整体回滚、版本仍为 15、全部 v16 结构回滚、迁移前备份可恢复', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 15), backupDir });
      expect(readSchemaVersion(db)).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      const now = '2026-08-01T00:00:00+08:00';
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, region, project_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('p-keep', 'TP-KEEP', 'pending_execution', '华北', '存量备注', now, now);

      // 注入 v16 失败迁移：先执行真实 DDL 再抛错，验证 DDL 也被整体回滚
      const failing: Migration = {
        version: TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION,
        name: 'failing-v16',
        up: (d: DatabaseSync) => {
          d.exec('ALTER TABLE projects ADD COLUMN temporary_instrument_name TEXT;');
          throw new Error('注入的 v16 迁移失败');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, {
          migrations: [...MIGRATIONS.slice(0, 15), failing],
          backupDir,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION);
      expect(failure.originalVersion).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);

      // 整体回滚：版本仍为 15、原数据保留、失败迁移的 DDL 已回滚
      expect(readSchemaVersion(db)).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      const project = db
        .prepare('SELECT temp_no, region, project_note FROM projects WHERE id = ?')
        .get('p-keep') as { temp_no: string; region: string; project_note: string };
      expect(project.temp_no).toBe('TP-KEEP');
      expect(project.region).toBe('华北');
      expect(project.project_note).toBe('存量备注');
      const cols = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).not.toContain('temporary_instrument_name');
      expect(cols).not.toContain('temporary_instrument_model');
      expect(cols).not.toContain('temporary_has_ups');

      // 迁移前安全备份存在且可恢复（含迁移前数据、版本 15）
      expect(existsSync(failure.preMigrationBackup)).toBe(true);
      const backup = openDatabase({ path: failure.preMigrationBackup, readOnly: true });
      expect(readSchemaVersion(backup)).toBe(RELOCATION_WORKBENCH_MIGRATION_VERSION);
      const backupProject = backup
        .prepare('SELECT temp_no, region, project_note FROM projects WHERE id = ?')
        .get('p-keep') as { temp_no: string; region: string; project_note: string };
      expect(backupProject.temp_no).toBe('TP-KEEP');
      expect(backupProject.region).toBe('华北');
      expect(backupProject.project_note).toBe('存量备注');
      closeDatabase(backup);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
