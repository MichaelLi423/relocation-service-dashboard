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
  applyServiceOrderEngineerNullableMigration,
  LATEST_SCHEMA_VERSION,
  SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION,
} from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v20：开单记录工程师允许空缺保存并可后续补录。
 * - service_orders.engineer 由 TEXT NOT NULL 改为 TEXT（可空），STRICT 表重建；
 * - 全部为新增可空语义，不重建表以外的结构、不改写存量业务值；
 * - 重建后恢复 3 索引（idx_service_orders_no 部分唯一、import_source_key、project_time）与 3 业务修订触发器；
 * - STRICT/CHECK/外键、foreign_key_check、触发器递增、重开保留。
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

function openV19(dir: string): { db: DatabaseSync; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 19), backupDir });
  expect(readSchemaVersion(db)).toBe(19);
  return { db, backupDir };
}

function seedData(db: DatabaseSync): void {
  const nowIso = '2026-08-01T00:00:00+08:00';
  db.exec('BEGIN');
  db.prepare('INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('account-1', '负责人', 'hash', 'salt', nowIso, nowIso);
  db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('customer-1', '迁移客户', nowIso, nowIso);
  db.prepare(`INSERT INTO projects (id, temp_no, status, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run('p1', 'TP-V20', 'executing', 'customer-1', nowIso, nowIso);
  // 旧 schema：engineer NOT NULL，必须有值
  db.prepare(
    `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, note, account_id, username_snapshot, import_source_key, import_source_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('so-1', 'relocation', 'SO-V20-1', '2026-08-10', '存量工程师', '迁移客户', 'p1', '备注A', 'account-1', '负责人', 'so|SO-V20-1', 'hash-1', nowIso, nowIso);
  db.prepare(
    `INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, note, account_id, username_snapshot, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('so-2', 'pm', 'SO-V20-2', '2026-08-11', '工程师乙', '客户乙', null, null, null, null, nowIso, nowIso);
  db.exec('COMMIT');
}

describe('schema v20：开单记录工程师可空保存并可后续补录（重建 service_orders）', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(LATEST_SCHEMA_VERSION).toBe(SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1));
      // service_orders 可空写入验证
      expectServiceOrdersIndexesAndTriggers(db);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v19→v20：service_orders 全部列/数据原样保留，STRICT/CHECK/外键保留，3索引+3触发器完整，foreign_key_check通过，engineer 可空', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV19(dir);
      seedData(db);
      expectServiceOrdersIndexesAndTriggers(db);
      // 迁移前 engineer 列 NOT NULL
      const beforeDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='service_orders'").get() as { sql: string };
      expect(beforeDef.sql).toContain('engineer TEXT NOT NULL');

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // 全部列保留
      const cols = db.prepare('PRAGMA table_info(service_orders)').all() as { name: string; notnull: number }[];
      const names = cols.map((c) => c.name);
      for (const col of ['id', 'order_type', 'service_order_no', 'ordered_at', 'engineer', 'customer_name', 'project_id', 'note', 'account_id', 'username_snapshot', 'import_source_key', 'import_source_hash', 'created_at', 'updated_at']) {
        expect(names, `应保留列 ${col}`).toContain(col);
      }
      // engineer 变为可空
      const engineerCol = cols.find((c) => c.name === 'engineer')!;
      expect(engineerCol.notnull).toBe(0);
      // 迁移后表定义不含 NOT NULL
      const afterDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='service_orders'").get() as { sql: string };
      expect(afterDef.sql).not.toContain('engineer TEXT NOT NULL');
      expect(afterDef.sql).toContain('STRICT');

      // 数据原样保留（存量非空工程师不变）
      const so1 = db.prepare('SELECT engineer, customer_name, project_id, note FROM service_orders WHERE id=?').get('so-1') as Record<string, unknown>;
      expect(so1.engineer).toBe('存量工程师');
      expect(so1.customer_name).toBe('迁移客户');
      expect(so1.project_id).toBe('p1');
      const so2 = db.prepare('SELECT engineer FROM service_orders WHERE id=?').get('so-2') as { engineer: string };
      expect(so2.engineer).toBe('工程师乙');

      // STRICT 保留：表定义含 STRICT，且 NOT NULL 约束仍生效
      expect(afterDef.sql).toContain('STRICT');
      expect(() => db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-strict-notnull', null as unknown as string, 'SO-STRICT2', '2026-08-12', null, '客户', 't', 't')).toThrow();
      // CHECK 保留：order_type 枚举拒绝
      expect(() => db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-check', 'illegal', 'SO-CHECK', '2026-08-12', '工', '客户', 't', 't')).toThrow();
      // 外键保留
      const fks = db.prepare('PRAGMA foreign_key_list(service_orders)').all() as Array<{ table: string }>;
      expect(fks.some((fk) => fk.table === 'projects')).toBe(true);
      expect(fks.some((fk) => fk.table === 'accounts')).toBe(true);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // 3索引+3触发器完整
      expectServiceOrdersIndexesAndTriggers(db);

      // engineer 可空写入
      db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-null', 'pm', 'SO-NULL', '2026-08-12', null, '客户空', 't', 't');
      expect((db.prepare('SELECT engineer FROM service_orders WHERE id=?').get('so-null') as { engineer: string | null }).engineer).toBeNull();
      // 空串归一由领域层处理，DB 接受空串但视为有值；此处验证 DB 接受 null
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v20后：engineer NULL 索引行为、触发器递增、foreign_key_check', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV19(dir);
      seedData(db);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      // 部分唯一索引允许 service_order_no null 重复但非 null 唯一
      db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-null-no', 'pm', null, '2026-08-12', null, '客户', 't', 't');
      db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-null-no2', 'pm', null, '2026-08-12', null, '客户2', 't', 't');
      expect(() => db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-dup', 'pm', 'SO-V20-1', '2026-08-12', null, '客户', 't', 't')).toThrow();

      const readRev = (): number => (db.prepare('SELECT business_revision FROM database_metadata WHERE id=1').get() as { business_revision: number }).business_revision;
      const base = readRev();
      db.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-trig', 'pm', 'SO-TRIG', '2026-08-13', null, '客户', 't', 't');
      expect(readRev()).toBe(base + 1);
      db.prepare('UPDATE service_orders SET engineer=? WHERE id=?').run('回填', 'so-trig');
      expect(readRev()).toBe(base + 2);
      db.prepare('DELETE FROM service_orders WHERE id=?').run('so-trig');
      expect(readRev()).toBe(base + 3);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('重开：关闭重开后保留 v20 数据与版本', () => {
    const dir = makeTempDir();
    try {
      const { db: first, backupDir } = openV19(dir);
      seedData(first);
      runMigrations(first, { migrations: [...MIGRATIONS], backupDir });
      first.prepare('INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('so-reopen', 'pm', 'SO-REOPEN', '2026-08-14', null, '重开客户', 't', 't');
      closeDatabase(first);

      const reopened = openDatabase({ path: `${dir}/workbench.db` });
      expect(readSchemaVersion(reopened)).toBe(LATEST_SCHEMA_VERSION);
      expect((reopened.prepare('SELECT engineer FROM service_orders WHERE id=?').get('so-reopen') as { engineer: string | null }).engineer).toBeNull();
      expect((reopened.prepare('SELECT engineer FROM service_orders WHERE id=?').get('so-1') as { engineer: string }).engineer).toBe('存量工程师');
      expectServiceOrdersIndexesAndTriggers(reopened);
      expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(reopened);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('恢复场景：schema 已重建但 user_version=19 时重跑 v20 幂等成功、数据保留', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV19(dir);
      seedData(db);
      // 模拟崩溃：手动执行 v20 重建但不写版本
      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec('BEGIN');
      applyServiceOrderEngineerNullableMigration(db);
      db.exec('COMMIT');
      db.exec('PRAGMA foreign_keys=ON;');
      expect(readSchemaVersion(db)).toBe(19);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const p = db.prepare('SELECT engineer FROM service_orders WHERE id=?').get('so-1') as { engineer: string };
      expect(p.engineer).toBe('存量工程师');
      expectServiceOrdersIndexesAndTriggers(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
