import { describe, expect, it } from 'vitest';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v14：补齐资料/批量导入新增字段。
 * - projects.planned_install_done_at（计划装机完成日期，独立字段不触发生命周期）；
 * - instruments.manufacturer / instruments.service_level（仪器批量导入 5 列中的两列）。
 * 只新增可空列，不改业务数据、不重建表；v13 存量库升级数据完整保留。
 */

describe('schema v14：补齐资料/批量导入新增字段', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}、三列已建立`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      const projectCols = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
      expect(projectCols.map((c) => c.name)).toContain('planned_install_done_at');
      const instrumentCols = db.prepare('PRAGMA table_info(instruments)').all() as { name: string }[];
      const names = instrumentCols.map((c) => c.name);
      expect(names).toContain('manufacturer');
      expect(names).toContain('service_level');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v13 存量库升级到最新版本：业务数据完整保留，新列默认为空', () => {
    const dir = makeTempDir();
    try {
      const dbPath = `${dir}/workbench.db`;
      const backupDir = `${dir}/migration-backups`;
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 13), backupDir });
      expect(readSchemaVersion(db)).toBe(13);
      const now = '2026-08-01T00:00:00+08:00';
      db.exec('BEGIN');
      db.prepare(
        `INSERT INTO projects (id, temp_no, status, entry_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('p1', 'TP-V14-1', 'pending_execution', '2026-08-01', now, now);
      db.prepare(
        `INSERT INTO instruments (id, project_id, name, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      ).run('i1', 'p1', '存量仪器', now, now);
      db.exec('COMMIT');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as {
        temp_no: string;
        entry_at: string;
        planned_install_done_at: string | null;
      };
      expect(project.temp_no).toBe('TP-V14-1');
      expect(project.entry_at).toBe('2026-08-01');
      expect(project.planned_install_done_at).toBeNull(); // 新列默认为空
      const instrument = db.prepare('SELECT * FROM instruments WHERE id = ?').get('i1') as {
        name: string;
        manufacturer: string | null;
        service_level: string | null;
      };
      expect(instrument.name).toBe('存量仪器');
      expect(instrument.manufacturer).toBeNull();
      expect(instrument.service_level).toBeNull();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
