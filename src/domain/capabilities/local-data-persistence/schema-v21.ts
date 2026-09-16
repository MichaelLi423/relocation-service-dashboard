import type { DatabaseSync } from 'node:sqlite';
import { businessRevisionTriggerName } from './schema-v10';

/**
 * schema v21：新增项目主状态「已转单」（transferred）。
 *
 * 业务语义（用户确认）：已转单是终态，转单后不再自动推进；人工进入后不可再离开。
 * 报表口径将已转单与已取消同等排除/冻结（活跃项目、管道、收入、掉票、财务冻结）。
 * 领域枚举真源在 states.ts，本迁移只放宽数据库层 projects.status 与
 * project_status_transition_audit 的 CHECK 约束以允许持久化。
 *
 * SQLite 不支持修改 CHECK 约束，故重建两张表（与 v19 同法，仅 CHECK 增加
 * 'transferred'）：
 * - projects：完整保留全部 42 列（v1 基础列 + v2/v5/v7/v14/v15/v16 追加列）、
 *   STRICT、temp_no UNIQUE、customer_id/contract_id 外键，仅 status CHECK 增加
 *   'transferred'；
 * - project_status_transition_audit：完整保留列/STRICT/外键，from_status/to_status
 *   CHECK 增加 'transferred'（状态枚举与 projects.status 一致，v15 注释口径）。
 *
 * 重建方式：projects 有 9 张子表引用，逐一重建子表不可行，故走
 * 「RENAME 旧表 → 建新表 → 拷贝 → DROP 旧表」流程。SQLite 的 PRAGMA
 * foreign_keys / legacy_alter_table 在事务内是 no-op，因此本迁移声明
 * Migration.disableForeignKeys=true，由迁移运行器在事务外设置
 * foreign_keys=OFF、legacy_alter_table=ON（使 RENAME 不改写子表外键指向），
 * 并在同一事务内完成表重建与版本号写入，提交/回滚后恢复原始 pragma 值。
 * 本函数只做表重建，不自行管理事务或 pragma。
 *
 * 重建后必须恢复随旧表 DROP 一并消失的索引与触发器：
 * - projects：v7 idx_projects_import_source_key、v12 四个读取索引、
 *   v10 业务修订三触发器（insert/update/delete）；
 * - project_status_transition_audit：v15 idx_project_status_transition_project_time。
 */
export const TRANSFERRED_STATUS_MIGRATION_VERSION = 21;

/** 当前最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = TRANSFERRED_STATUS_MIGRATION_VERSION;

const PROJECT_STATUS_CHECK = `status TEXT NOT NULL CHECK (status IN (
      'pending_entry','pending_execution','executing','under_repair','pending_acceptance','pending_invoice','completed','cancelled','transferred'
    ))`;

const PROJECT_COLUMNS = `
    id TEXT PRIMARY KEY,
    temp_no TEXT NOT NULL UNIQUE,
    ${PROJECT_STATUS_CHECK},
    pre_entry_execution INTEGER NOT NULL DEFAULT 0,
    scope_confirmed INTEGER NOT NULL DEFAULT 0,
    customer_id TEXT REFERENCES customers(id),
    contract_id TEXT REFERENCES contracts(id),
    entry_at TEXT,
    region TEXT,
    old_site_contact TEXT,
    new_site_contact TEXT,
    old_site_address TEXT,
    new_site_address TEXT,
    contract_start_date TEXT,
    contract_end_date TEXT,
    plan_visit_at TEXT,
    plan_transport_at TEXT,
    site_confirmed INTEGER NOT NULL DEFAULT 0,
    actual_install_done_at TEXT,
    acceptance_report INTEGER NOT NULL DEFAULT 0,
    acceptance_report_date TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT,
    reminder_at TEXT,
    reminder_note TEXT,
    temporary_instrument_count INTEGER,
    manager_approval_reason TEXT,
    manager_approval_missing TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reminder_account_id TEXT REFERENCES accounts(id),
    reminder_username_snapshot TEXT,
    import_source_key TEXT,
    import_source_hash TEXT,
    planned_install_done_at TEXT,
    project_note TEXT,
    temporary_storage_address TEXT,
    is_temporary_storage INTEGER,
    manager_approved INTEGER,
    temporary_instrument_name TEXT,
    temporary_instrument_model TEXT,
    temporary_has_ups INTEGER
  `;

const PROJECT_INSERT_COLUMNS = `
    id, temp_no, status, pre_entry_execution, scope_confirmed, customer_id, contract_id,
    entry_at, region, old_site_contact, new_site_contact, old_site_address, new_site_address,
    contract_start_date, contract_end_date, plan_visit_at, plan_transport_at, site_confirmed,
    actual_install_done_at, acceptance_report, acceptance_report_date, cancelled_at, cancel_reason,
    reminder_at, reminder_note, temporary_instrument_count, manager_approval_reason, manager_approval_missing,
    created_at, updated_at, reminder_account_id, reminder_username_snapshot, import_source_key, import_source_hash,
    planned_install_done_at, project_note, temporary_storage_address, is_temporary_storage, manager_approved,
    temporary_instrument_name, temporary_instrument_model, temporary_has_ups
  `;

export function applyTransferredStatusMigration(db: DatabaseSync): void {
  // 运行器已按 Migration.disableForeignKeys 在事务外设置 foreign_keys=OFF 与
  // legacy_alter_table=ON；本函数在运行器事务内执行，只做表重建与索引/触发器重建。

  // ---- 1. 重建 projects：status CHECK 增加 transferred ----
  db.exec('ALTER TABLE projects RENAME TO projects_legacy;');
  db.exec(`CREATE TABLE projects (${PROJECT_COLUMNS}) STRICT;`);
  db.exec(
    `INSERT INTO projects (${PROJECT_INSERT_COLUMNS})
     SELECT ${PROJECT_INSERT_COLUMNS} FROM projects_legacy;`,
  );
  db.exec('DROP TABLE projects_legacy;');

  // 重建随旧表 DROP 消失的索引（v7 导入来源 + v12 读取索引）。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_import_source_key ON projects(import_source_key);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_region ON projects(region, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_projects_reminder ON projects(reminder_at);
  `);

  // 重建 v10 业务修订三触发器（RENAME 后旧触发器随 legacy 表 DROP 删除）。
  for (const event of ['insert', 'update', 'delete'] as const) {
    db.exec(
      `CREATE TRIGGER ${businessRevisionTriggerName('projects', event)}
       AFTER ${event.toUpperCase()} ON projects
       BEGIN
         UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1;
       END;`,
    );
  }

  // ---- 2. 重建 project_status_transition_audit：状态 CHECK 增加 transferred ----
  db.exec('ALTER TABLE project_status_transition_audit RENAME TO project_status_transition_audit_legacy;');
  db.exec(`
    CREATE TABLE project_status_transition_audit (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      from_status TEXT CHECK (from_status IN (
        'pending_entry','pending_execution','executing','under_repair','pending_acceptance','pending_invoice','completed','cancelled','transferred'
      )),
      to_status TEXT NOT NULL CHECK (to_status IN (
        'pending_entry','pending_execution','executing','under_repair','pending_acceptance','pending_invoice','completed','cancelled','transferred'
      )),
      reason TEXT,
      effective_business_date TEXT,
      source TEXT,
      actor_id TEXT REFERENCES accounts(id),
      actor_username_snapshot TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  db.exec(`
    INSERT INTO project_status_transition_audit (
      id, project_id, from_status, to_status, reason,
      effective_business_date, source, actor_id, actor_username_snapshot, created_at
    )
    SELECT
      id, project_id, from_status, to_status, reason,
      effective_business_date, source, actor_id, actor_username_snapshot, created_at
    FROM project_status_transition_audit_legacy;
  `);
  db.exec('DROP TABLE project_status_transition_audit_legacy;');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_status_transition_project_time
      ON project_status_transition_audit(project_id, created_at, id);
  `);
}
