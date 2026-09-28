import type { DatabaseSync } from 'node:sqlite';
import { businessRevisionTriggerName } from './schema-v10';

/**
 * schema v22：开单记录新增工作范围 work_scope。
 *
 * 业务语义：开单记录具备工作范围维度（区分其他/既有 'other' 与中大型项目 'medium_large'）；
 * 中大型项目工作范围为与四类开单类型正交的维度，中大型四类开单均保持 project_id 为 NULL。
 * 存量开单记录默认值为 'other'，不因 project_id IS NULL 被追认为中大型。
 *
 * 持久化：service_orders 增加 work_scope TEXT NOT NULL DEFAULT 'other' CHECK (work_scope IN ('other', 'medium_large'))。
 * STRICT 表重建：完整保留全部 14 列，新增 work_scope 列，恢复 3 索引与 3 业务修订触发器。
 */
export const SERVICE_ORDER_WORK_SCOPE_MIGRATION_VERSION = 22;

/** 当前最新 schema 版本（统一 latest，v22）。 */
export const LATEST_SCHEMA_VERSION = SERVICE_ORDER_WORK_SCOPE_MIGRATION_VERSION;

export function applyServiceOrderWorkScopeMigration(db: DatabaseSync): void {
  db.exec('ALTER TABLE service_orders RENAME TO service_orders_legacy;');

  db.exec(`
    CREATE TABLE service_orders (
      id TEXT PRIMARY KEY,
      order_type TEXT NOT NULL CHECK (order_type IN ('relocation','certification','parts_by_mail','pm')),
      service_order_no TEXT,
      ordered_at TEXT NOT NULL,
      engineer TEXT,
      customer_name TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id),
      note TEXT,
      account_id TEXT REFERENCES accounts(id),
      username_snapshot TEXT,
      import_source_key TEXT,
      import_source_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      work_scope TEXT NOT NULL DEFAULT 'other' CHECK (work_scope IN ('other', 'medium_large'))
    ) STRICT;
  `);

  db.exec(`
    INSERT INTO service_orders (
      id, order_type, service_order_no, ordered_at, engineer, customer_name,
      project_id, note, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at,
      work_scope
    )
    SELECT
      id, order_type, service_order_no, ordered_at, engineer, customer_name,
      project_id, note, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at,
      'other'
    FROM service_orders_legacy;
  `);

  db.exec('DROP TABLE service_orders_legacy;');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_no
      ON service_orders(service_order_no) WHERE service_order_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_service_orders_import_source_key ON service_orders(import_source_key);
    CREATE INDEX IF NOT EXISTS idx_service_orders_project_time ON service_orders(project_id, created_at, id);
  `);

  for (const event of ['insert', 'update', 'delete'] as const) {
    db.exec(
      `CREATE TRIGGER ${businessRevisionTriggerName('service_orders', event)}
       AFTER ${event.toUpperCase()} ON service_orders
       BEGIN
         UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1;
       END;`,
    );
  }
}
