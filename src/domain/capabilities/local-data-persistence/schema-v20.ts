import type { DatabaseSync } from 'node:sqlite';
import { businessRevisionTriggerName } from './schema-v10';

/**
 * schema v20：开单记录工程师允许空缺保存并可后续补录。
 *
 * 业务语义：开单记录的参与工程师在创建时可空（未填表示待补录），后续可通过
 * 独立补录动作补充或清空；空缺不影响记录保存、后续补录不触发搬迁项目生命周期。
 *
 * 持久化：service_orders.engineer 由 TEXT NOT NULL 改为 TEXT（可空），STRICT 表需重建。
 * 全部为新增可空语义，不重建表以外的结构、不改写存量业务值；存量非空工程师原样保留。
 *
 * 重建后必须恢复随旧表 DROP 一并消失的索引与触发器：
 * - 索引：idx_service_orders_no（部分唯一）、idx_service_orders_import_source_key、
 *   idx_service_orders_project_time（v12）；
 * - 业务修订触发器：service_orders 的 insert/update/delete 三触发器（v10）。
 */
export const SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION = 20;

/** 当前最新 schema 版本（统一 latest，v20）。 */
export const LATEST_SCHEMA_VERSION = SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION;

export function applyServiceOrderEngineerNullableMigration(db: DatabaseSync): void {
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
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  db.exec(`
    INSERT INTO service_orders (
      id, order_type, service_order_no, ordered_at, engineer, customer_name,
      project_id, note, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at
    )
    SELECT
      id, order_type, service_order_no, ordered_at, engineer, customer_name,
      project_id, note, account_id, username_snapshot,
      import_source_key, import_source_hash, created_at, updated_at
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
