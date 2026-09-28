import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { businessRevisionTriggerName } from '../../src/domain/capabilities/local-data-persistence/schema-v10';
import {
  LATEST_SCHEMA_VERSION,
  SERVICE_ORDER_WORK_SCOPE_MIGRATION_VERSION,
} from '../../src/domain/capabilities/local-data-persistence/schema-v22';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v22：开单记录新增工作范围 work_scope（'other'|'medium_large'，默认 'other'）。
 * - service_orders 增加 work_scope 字段，STRICT 表重建；
 * - 存量数据默认填充 'other'，旧无项目记录（project_id IS NULL）不误判为中大型；
 * - 重建后恢复 3 索引（idx_service_orders_no 部分唯一、import_source_key、project_time）与 3 业务修订触发器；
 * - STRICT/CHECK/外键、foreign_key_check、唯一约束、原字段完整保留。
 */

function expectServiceOrdersIndexesAndTriggers(db: DatabaseSync): void {
  const indexes = [
    'idx_service_orders_no',
    'idx_service_orders_import_source_key',
    'idx_service_orders_project_time',
  ] as const;
  for (const idx of indexes) {
    const row = db.prepare("SELECT sql, name FROM sqlite_master WHERE type='index' AND name=?").get(idx) as { sql: string; name: string } | undefined;
    expect(row, `索引 ${idx} 应存在`).toBeDefined();
  }
  // 部分唯一索引 WHERE 条件保留
  const noSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_service_orders_no'").get() as { sql: string }).sql;
  expect(noSql).toContain('WHERE');
  expect(noSql).toContain('service_order_no IS NOT NULL');
  for (const event of ['insert', 'update', 'delete'] as const) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(businessRevisionTriggerName('service_orders', event)) as { sql: string } | undefined;
    expect(trigger, `触发器 ${event} 应存在`).toBeDefined();
    expect(trigger!.sql).toContain('ON service_orders');
  }
}

function openV21(dir: string): { db: DatabaseSync; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 21), backupDir });
  expect(readSchemaVersion(db)).toBe(21);
  return { db, backupDir };
}

function seedDataV21(db: DatabaseSync): void {
  const nowIso = '2026-08-01T00:00:00+08:00';
  db.exec('BEGIN');
  db.prepare('INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('account-1', '负责人', 'hash', 'salt', nowIso, nowIso);
  db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)')
    .run('customer-1', '迁移客户', nowIso, nowIso);
  db.prepare('INSERT INTO projects (id, temp_no, status, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('p1', 'TP-V21', 'executing', 'customer-1', nowIso, nowIso);

  // 1. 搬迁开单（关联项目）
  db.prepare(
    `INSERT INTO service_orders (
       id, order_type, service_order_no, ordered_at, engineer, customer_name,
       project_id, note, account_id, username_snapshot,
       import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('so-1', 'relocation', 'SO-V21-1', '2026-08-10', '工程师甲', '迁移客户', 'p1', '备注A', 'account-1', '负责人', 'so|SO-V21-1', 'hash-1', nowIso, nowIso);

  // 2. 旧独立无项目开单（project_id 为 NULL）——迁移后绝不得被追认为 medium_large
  db.prepare(
    `INSERT INTO service_orders (
       id, order_type, service_order_no, ordered_at, engineer, customer_name,
       project_id, note, account_id, username_snapshot, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('so-2', 'pm', 'SO-V21-2', '2026-08-11', null, '客户乙', null, null, null, null, nowIso, nowIso);

  // 3. 认证开单（归档关联项目）
  db.prepare(
    `INSERT INTO service_orders (
       id, order_type, service_order_no, ordered_at, engineer, customer_name,
       project_id, note, account_id, username_snapshot, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('so-3', 'certification', 'SO-V21-3', '2026-08-12', '工程师丙', '客户丙', 'p1', '认证备注', 'account-1', '负责人', nowIso, nowIso);

  db.exec('COMMIT');
}

describe('schema v22：开单记录新增工作范围 work_scope', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(SERVICE_ORDER_WORK_SCOPE_MIGRATION_VERSION).toBe(22);
      expect(LATEST_SCHEMA_VERSION).toBe(22);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1));
      expectServiceOrdersIndexesAndTriggers(db);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v21→v22：service_orders 全部列/数据原样保留，STRICT/CHECK/外键保留，3索引+3触发器完整，foreign_key_check通过，旧无项目记录不误判', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV21(dir);
      seedDataV21(db);
      expectServiceOrdersIndexesAndTriggers(db);

      // 迁移前没有 work_scope 列
      const beforeCols = db.prepare('PRAGMA table_info(service_orders)').all() as { name: string }[];
      expect(beforeCols.some((c) => c.name === 'work_scope')).toBe(false);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // 全部列保留且包含 work_scope
      const cols = db.prepare('PRAGMA table_info(service_orders)').all() as { name: string; notnull: number; dflt_value: string }[];
      const names = cols.map((c) => c.name);
      for (const col of [
        'id', 'order_type', 'service_order_no', 'ordered_at', 'engineer',
        'customer_name', 'project_id', 'note', 'account_id', 'username_snapshot',
        'import_source_key', 'import_source_hash', 'created_at', 'updated_at',
        'work_scope',
      ]) {
        expect(names, `应保留列 ${col}`).toContain(col);
      }

      // work_scope 列属性检查
      const workScopeCol = cols.find((c) => c.name === 'work_scope')!;
      expect(workScopeCol.notnull).toBe(1);
      expect(workScopeCol.dflt_value).toContain('other');

      // 验证表定义包含 STRICT 与 CHECK
      const def = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='service_orders'").get() as { sql: string }).sql;
      expect(def).toContain('STRICT');
      expect(def).toContain("work_scope TEXT NOT NULL DEFAULT 'other' CHECK (work_scope IN ('other', 'medium_large'))");

      // 验证存量行数据与旧无项目记录不误判
      const so1 = db.prepare('SELECT * FROM service_orders WHERE id=?').get('so-1') as Record<string, unknown>;
      expect(so1.work_scope).toBe('other');
      expect(so1.engineer).toBe('工程师甲');
      expect(so1.customer_name).toBe('迁移客户');
      expect(so1.project_id).toBe('p1');
      expect(so1.import_source_key).toBe('so|SO-V21-1');
      expect(so1.import_source_hash).toBe('hash-1');

      // 关键断言：旧无项目开单仍为 other，不因 project_id IS NULL 被追认为 medium_large
      const so2 = db.prepare('SELECT * FROM service_orders WHERE id=?').get('so-2') as Record<string, unknown>;
      expect(so2.project_id).toBeNull();
      expect(so2.work_scope).toBe('other');
      expect(so2.engineer).toBeNull();
      expect(so2.customer_name).toBe('客户乙');

      const so3 = db.prepare('SELECT * FROM service_orders WHERE id=?').get('so-3') as Record<string, unknown>;
      expect(so3.work_scope).toBe('other');
      expect(so3.project_id).toBe('p1');

      // 索引与触发器重建验证
      expectServiceOrdersIndexesAndTriggers(db);

      // 外键检查
      const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
      expect(fkViolations).toEqual([]);

      // 新增约束验证：未知 work_scope 被 CHECK 拒绝
      expect(() =>
        db.prepare(
          `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at, work_scope)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run('so-inv', 'pm', 'SO-INV', '2026-08-15', null, '客户', 't', 't', 'invalid_scope'),
      ).toThrow();

      // 允许插入 medium_large
      expect(() =>
        db.prepare(
          `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at, work_scope)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run('so-ml', 'relocation', 'SO-ML-1', '2026-08-15', null, '客户', 't', 't', 'medium_large'),
      ).not.toThrow();
      const soMl = db.prepare('SELECT work_scope FROM service_orders WHERE id=?').get('so-ml') as { work_scope: string };
      expect(soMl.work_scope).toBe('medium_large');

      // 重复服务单号仍被部分唯一索引拒绝
      expect(() =>
        db.prepare(
          `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at, work_scope)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run('so-dup', 'pm', 'SO-V21-1', '2026-08-15', null, '客户', 't', 't', 'other'),
      ).toThrow();

      // 业务修订触发器工作正常
      const revBefore = (db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as { business_revision: number }).business_revision;
      db.prepare(
        `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run('so-rev', 'pm', 'SO-REV-1', '2026-08-15', null, '客户', 't', 't');
      const revAfter = (db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as { business_revision: number }).business_revision;
      expect(revAfter).toBe(revBefore + 1);

      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
