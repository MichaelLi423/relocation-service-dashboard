import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir, makeTempDbPath } from '../helpers/tmp-db';

/**
 * schema v12（Oracle #10）：工作台 v2 有界读取的支撑索引。
 *
 * - 只加索引、不重建表/不改数据；v11 存量库升级后数据完整保留；
 * - 查询计划测试：EXPLAIN QUERY PLAN 验证分页/过滤/聚合实际使用 v12 索引
 *   （SQL 有界实现依赖这些索引，禁止全量扫描 + JS P×C）。
 */

const V12_INDEXES = [
  'idx_projects_status',
  'idx_projects_updated',
  'idx_projects_region',
  'idx_projects_reminder',
  'idx_batches_project_time',
  'idx_instruments_project_time',
  'idx_activities_project_time',
  'idx_service_orders_project_time',
  'idx_damage_repair_project_time',
  'idx_invoices_project_active',
  'idx_invoices_project_time',
  'idx_serial_address_updates_time',
  'idx_qr_requests_time',
  'idx_ship_to_requests_customer_time',
  'idx_customers_name',
];

function indexNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** 预置一个有存量数据的 v11 库。 */
function seedV11(dir: string): { db: DatabaseSync; dbPath: string } {
  const dbPath = makeTempDbPath(dir);
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 11), backupDir });
  expect(readSchemaVersion(db)).toBe(11);
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, region, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('p-legacy', 'TP-LEGACY', 'pending_execution', '华东', '2026-01-01T00:00:00+08:00', '2026-08-01T00:00:00+08:00');
  return { db, dbPath };
}

describe('schema v12：只加支撑索引的迁移（Oracle #10）', () => {
  it('v11 存量库升级到最新版本：版本写入最新、数据完整保留、15 个索引全部建立', () => {
    const dir = makeTempDir();
    try {
      const { db } = seedV11(dir);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir: `${dir}/migration-backups` });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const row = db
        .prepare('SELECT status, region FROM projects WHERE id = ?')
        .get('p-legacy') as { status: string; region: string };
      expect(row.status).toBe('pending_execution');
      expect(row.region).toBe('华东');

      const names = indexNames(db);
      for (const idx of V12_INDEXES) {
        expect(names, `索引 ${idx} 应存在`).toContain(idx);
      }
      // 既有唯一索引仍保留（不因 v12 丢失）
      expect(names).toContain('idx_contracts_ecc');
      expect(names).toContain('idx_instruments_project_serial');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('全新库直接引导到最新版本：迁移序列为 1..最新', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      expect(namesOf(db).length).toBeGreaterThanOrEqual(V12_INDEXES.length);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  function namesOf(db: DatabaseSync): string[] {
    return indexNames(db);
  }
});

describe('schema v12：查询计划实际使用索引（Oracle #10 有界读取依赖）', () => {
  function seedPlanner(db: DatabaseSync): void {
    db.exec('BEGIN');
    const insertProject = db.prepare(
      `INSERT INTO projects (id, temp_no, status, region, reminder_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 2000; i++) {
      insertProject.run(
        `p-${i}`,
        `TP-${String(i).padStart(4, '0')}`,
        i % 3 === 0 ? 'pending_execution' : i % 3 === 1 ? 'executing' : 'pending_acceptance',
        i % 2 === 0 ? '华东' : '华北',
        i % 5 === 0 ? `2026-08-${String((i % 28) + 1).padStart(2, '0')}` : null,
        `2026-01-01T00:00:00+08:00`,
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${String((i % 24)).padStart(2, '0')}:00:00+08:00`,
      );
    }
    // 一个项目的多条仪器/掉票（验证子表与活跃掉票索引路径）
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('p-multi', 'TP-MULTI', 'pending_invoice', '2026-01-01T00:00:00+08:00', '2026-08-01T00:00:00+08:00');
    const insertInstrument = db.prepare(
      `INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`,
    );
    for (let i = 0; i < 60; i++) {
      insertInstrument.run(`i-${i}`, 'p-multi', `仪器${i}`, '2026-01-01T00:00:00+08:00', `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+08:00`);
    }
    db.prepare(
      `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run('c-multi', 'p-multi', 'TP-MULTI', 10000000, '2026-01-01T00:00:00+08:00', '2026-08-01T00:00:00+08:00');
    const insertInvoice = db.prepare(
      `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 40; i++) {
      insertInvoice.run(`inv-${i}`, 'p-multi', 100000, '2026-08-01', '2026-08-01T00:00:00+08:00', `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+08:00`);
    }
    db.exec('COMMIT');
  }

  it('项目默认分页 ORDER BY updated_at DESC 使用 idx_projects_updated', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      seedPlanner(db);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT p.id, p.temp_no FROM projects p
           LEFT JOIN contracts c ON c.project_id = p.id
           LEFT JOIN customers cu ON cu.id = p.customer_id
           ORDER BY p.updated_at DESC, p.id DESC LIMIT 50`,
        )
        .all() as { detail: string }[];
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toContain('idx_projects_updated');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('状态过滤 + updated 排序使用 idx_projects_status', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      seedPlanner(db);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT p.id FROM projects p
           WHERE p.status = 'executing'
           ORDER BY p.updated_at DESC, p.id DESC LIMIT 50`,
        )
        .all() as { detail: string }[];
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toContain('idx_projects_status');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('活跃掉票聚合（未撤销）使用 idx_invoices_project_active', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      seedPlanner(db);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT project_id, SUM(amount_cents) AS total FROM invoices
           WHERE revoked_at IS NULL GROUP BY project_id`,
        )
        .all() as { detail: string }[];
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toContain('idx_invoices_project_active');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('单项目子表分页（仪器 tab）使用 idx_instruments_project_time', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      seedPlanner(db);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT i.id FROM instruments i
           WHERE i.project_id = 'p-multi'
           ORDER BY i.created_at DESC, i.id DESC LIMIT 50`,
        )
        .all() as { detail: string }[];
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toContain('idx_instruments_project_time');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
