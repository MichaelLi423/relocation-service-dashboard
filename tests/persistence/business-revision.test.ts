import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase, MIGRATIONS } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import type { Migration } from '../../src/domain/capabilities/local-data-persistence/migration';
import { MigrationError, runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import {
  BUSINESS_TABLES,
  NON_BUSINESS_TABLES,
  businessRevisionTriggerName,
} from '../../src/domain/capabilities/local-data-persistence/schema-v10';
import {
  RELOCATION_WORKBENCH_NON_BUSINESS_TABLES,
} from '../../src/domain/capabilities/local-data-persistence/schema-v15';
import { PROJECT_TAG_BUSINESS_TABLES, projectTagBusinessRevisionTriggerName } from '../../src/domain/capabilities/local-data-persistence/schema-v17';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import {
  readBusinessRevision,
  readDatabaseIdentity,
  rotateContentGeneration,
} from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteCustomerRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { cleanupTempDir, makeTempDir, makeTempDbPath } from '../helpers/tmp-db';

/**
 * Gate1 Lane A（tasks 8.15 / design D25）：正式库业务修订触发器与数据库身份。
 *
 * - schema v10 迁移：database_metadata（instance/generation/业务修订）与相关业务表触发器；
 * - 触发器覆盖：对 sqlite_master 全表核对「业务表必有全部 3 个触发器、非业务表必无触发器」，
 *   防遗漏（R9：允许保守失效、不允许漏报）；
 * - 功能验证：每张业务表 INSERT/UPDATE/DELETE 各递增 1；账号/审计/meta 写入不递增；
 *   事务回滚后修订恢复原值；facade/仓储/迁移写入均经同一触发器递增；
 * - 迁移失败回滚：v10 失败时整体回滚、保留 v9 原库、无元数据表与触发器残留。
 */

const rev = (db: DatabaseSync): number => readBusinessRevision(db);
const ALL_NON_BUSINESS_TABLES = [
  ...NON_BUSINESS_TABLES,
  ...RELOCATION_WORKBENCH_NON_BUSINESS_TABLES,
] as const;

describe('schema v10：正式库身份与业务修订迁移（tasks 8.15 / D25）', () => {
  it('首次建库生成稳定 instance/generation，business_revision 从 0 起；关闭重开身份不变', () => {
    const dir = makeTempDir();
    try {
      const first = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(first.db)).toBe(LATEST_SCHEMA_VERSION);
      const identity = readDatabaseIdentity(first.db);
      expect(identity.databaseInstanceId).toBeTruthy();
      expect(identity.contentGenerationId).toBeTruthy();
      expect(identity.businessRevision).toBe(0);
      closeDatabase(first.db);

      // 重开：instance/generation 稳定（不重新生成），revision 仍是 0（无业务写入）
      const second = bootstrapDatabase({ dataDir: dir });
      const again = readDatabaseIdentity(second.db);
      expect(again.databaseInstanceId).toBe(identity.databaseInstanceId);
      expect(again.contentGenerationId).toBe(identity.contentGenerationId);
      expect(again.businessRevision).toBe(0);
      closeDatabase(second.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v9 存量库升级到 v10：元数据建立、业务数据保留、版本写入 10', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      // 先只应用到 v9（旧迁移序列），写入一条存量业务数据
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 9), backupDir });
      expect(readSchemaVersion(db)).toBe(9);
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-legacy',
        '存量客户',
        't',
        't',
      );

      // 升级到 v10（含后续 v11~v15）
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(readDatabaseIdentity(db).businessRevision).toBe(0);
      expect(db.prepare('SELECT name FROM customers WHERE id = ?').get('c-legacy')).toMatchObject({
        name: '存量客户',
      });
      // 存量数据是 v10 之前写入的，不要求递增；此后业务写入开始递增
      const r0 = rev(db);
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-new',
        '新客户',
        't',
        't',
      );
      expect(rev(db)).toBe(r0 + 1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('迁移失败回滚：v10 失败时整体回滚，保留 v9 原库、无元数据表与触发器残留', () => {
    const dir = makeTempDir();
    const dbPath = makeTempDbPath(dir);
    const backupDir = `${dir}/migration-backups`;
    try {
      const db = openDatabase({ path: dbPath });
      runMigrations(db, { migrations: MIGRATIONS.slice(0, 9), backupDir });
      expect(readSchemaVersion(db)).toBe(9);
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c1',
        '保留客户',
        't',
        't',
      );

      // 注入失败的 v10：先创建元数据表与触发器再抛错，验证 DDL 也随事务回滚
      const failingV10: Migration = {
        version: 10,
        name: 'failing-v10',
        up: (d: DatabaseSync) => {
          d.exec(`CREATE TABLE database_metadata (id INTEGER PRIMARY KEY CHECK (id = 1)) STRICT;`);
          d.exec(`CREATE TRIGGER trg_bad AFTER INSERT ON customers BEGIN SELECT 1; END;`);
          throw new Error('注入的 v10 迁移失败');
        },
      };

      let thrown: unknown;
      try {
        runMigrations(db, { migrations: [...MIGRATIONS.slice(0, 9), failingV10], backupDir });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MigrationError);
      const failure = (thrown as MigrationError).failure;
      expect(failure.failedVersion).toBe(10);
      expect(failure.originalVersion).toBe(9);

      // 回滚后：版本仍为 9、原数据保留、无元数据表与触发器残留
      expect(readSchemaVersion(db)).toBe(9);
      expect(db.prepare('SELECT name FROM customers WHERE id = ?').get('c1')).toMatchObject({
        name: '保留客户',
      });
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='database_metadata'")
          .get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_bad'").get(),
      ).toBeUndefined();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('迁移 DML 写入也递增业务修订（v10 之后的迁移经同一触发器）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(rev(db)).toBe(0);
      // 注：v16 已是正式迁移；用 v17 自定义迁移验证「后续迁移的 DML 也走触发器」。
      const seedLater: Migration = {
        version: LATEST_SCHEMA_VERSION + 1,
        name: 'next-seed-customer',
        up: (d: DatabaseSync) => {
          d.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
            'mig-c',
            '迁移写入客户',
            't',
            't',
          );
        },
      };
      runMigrations(db, {
        migrations: [...MIGRATIONS, seedLater],
        backupDir: `${dir}/migration-backups`,
      });
      expect(rev(db)).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('schema v10：触发器覆盖（design D25 / R9 防漏报）', () => {
  it('sqlite_master 全表核对：相关业务表全部有触发器、账号/审计/meta 均无触发器', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });

      // 全表清单与「业务 + 非业务」划分完全一致（无遗漏表、无多余表）
      const allTables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((r) => r.name)
        .sort();
      expect(allTables).toEqual([...BUSINESS_TABLES, ...PROJECT_TAG_BUSINESS_TABLES, ...ALL_NON_BUSINESS_TABLES].sort());

      // 每张业务表恰好有 insert/update/delete 三个触发器
      for (const table of BUSINESS_TABLES) {
        const triggers = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?")
            .all(table) as { name: string }[]
        ).map((r) => r.name);
        expect(triggers.sort(), `业务表 ${table} 触发器`).toEqual(
          (['insert', 'update', 'delete'] as const)
            .map((e) => businessRevisionTriggerName(table, e))
            .sort(),
        );
      }

      for (const table of PROJECT_TAG_BUSINESS_TABLES) {
        const triggers = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?")
            .all(table) as { name: string }[]
        ).map((r) => r.name);
        expect(triggers.sort(), `标签业务表 ${table} 触发器`).toEqual(
          (['insert', 'update', 'delete'] as const)
            .map((event) => projectTagBusinessRevisionTriggerName(table, event))
            .sort(),
        );
      }

      // 非业务表（账号/审计/meta）零触发器
      for (const table of ALL_NON_BUSINESS_TABLES) {
        const triggers = db
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ?")
          .all(table) as { name: string }[];
        expect(triggers, `非业务表 ${table} 不应有触发器`).toEqual([]);
      }

      // 触发器总数：既有业务表与 v17 标签业务表各有 3 个单事件触发器。
      const total = db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'")
        .get() as { n: number };
      expect(total.n).toBe((BUSINESS_TABLES.length + PROJECT_TAG_BUSINESS_TABLES.length) * 3);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('schema v10：业务修订功能（facade/仓储/直接 SQL 写入均递增）', () => {
  it('每张相关业务表 INSERT/UPDATE/DELETE 各使修订单调 +1', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(rev(db)).toBe(0);

      // 父行（供外键引用；测试行自包含，删除时不冲突）
      const parent = (sql: string, ...args: (string | number | null)[]) =>
        db.prepare(sql).run(...args);
      parent('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)', 'c1', '父客户', 't', 't');
      parent('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'p1', 'TP-1', 'pending_entry', 't', 't');
      parent('INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)', 'k1', 'p1', 'TP-1', 't', 't');
      // 合同测试行专用项目（contracts.project_id 1:1 唯一）
      parent('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)', 'p2', 'TP-2', 'pending_entry', 't', 't');
      parent('INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)', 'b1', 'p1', 't', 't');
      parent('INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', 'i1', 'p1', '仪器A', 't', 't');
      parent('INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)', 'a1', 'p1', 't', 't');
      parent('INSERT INTO damage_repair_items (id, instrument_id, issue_status, registered_at, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'd1', 'i1', 'untreated', 't', 'p1', 't', 't');
      parent('INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)', 'q1', '申请人', 't', 't');
      parent('INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)', 's1', 'ACC-1', '父客户', '新址A', 't');

      // 每张业务表：INSERT → +1；UPDATE → +1；DELETE → +1（用自包含测试行）
      // 父行本身也是业务写入（已各递增 1），测试行递增以父行创建后的修订为基数。
      const base = rev(db);
      const cases: Array<{
        table: (typeof BUSINESS_TABLES)[number];
        insert: string;
        insertArgs: (string | number | null)[];
        update: string;
        updateArgs: (string | number | null)[];
        del: string;
      }> = [
        {
          table: 'customers',
          insert: 'INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)',
          insertArgs: ['t-customers', '测试客户', 't', 't'],
          update: 'UPDATE customers SET name = ? WHERE id = ?',
          updateArgs: ['测试客户改', 't-customers'],
          del: 'DELETE FROM customers WHERE id = ?',
        },
        {
          table: 'projects',
          insert: 'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
          insertArgs: ['t-projects', 'TP-t-projects', 'pending_entry', 't', 't'],
          update: 'UPDATE projects SET status = ? WHERE id = ?',
          updateArgs: ['pending_execution', 't-projects'],
          del: 'DELETE FROM projects WHERE id = ?',
        },
        {
          table: 'contracts',
          insert: 'INSERT INTO contracts (id, project_id, temp_number, created_at, updated_at) VALUES (?,?,?,?,?)',
          insertArgs: ['t-contracts', 'p2', 'TP-t-contracts', 't', 't'],
          update: 'UPDATE contracts SET temp_number = ? WHERE id = ?',
          updateArgs: ['TP-t-contracts-改', 't-contracts'],
          del: 'DELETE FROM contracts WHERE id = ?',
        },
        {
          table: 'batches',
          insert: 'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
          insertArgs: ['t-batches', 'p1', 't', 't'],
          update: 'UPDATE batches SET transport_company = ? WHERE id = ?',
          updateArgs: ['运输公司X', 't-batches'],
          del: 'DELETE FROM batches WHERE id = ?',
        },
        {
          table: 'instruments',
          insert: 'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
          insertArgs: ['t-instruments', 'p1', '仪器测试', 't', 't'],
          update: 'UPDATE instruments SET name = ? WHERE id = ?',
          updateArgs: ['仪器测试改', 't-instruments'],
          del: 'DELETE FROM instruments WHERE id = ?',
        },
        {
          table: 'batch_change_history',
          insert: 'INSERT INTO batch_change_history (id, instrument_id, changed_at, created_at) VALUES (?,?,?,?)',
          insertArgs: ['t-batch_change_history', 'i1', 't', 't'],
          update: 'UPDATE batch_change_history SET changed_at = ? WHERE id = ?',
          updateArgs: ['2026-08-01', 't-batch_change_history'],
          del: 'DELETE FROM batch_change_history WHERE id = ?',
        },
        {
          table: 'activities',
          insert: 'INSERT INTO activities (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
          insertArgs: ['t-activities', 'p1', 't', 't'],
          update: 'UPDATE activities SET visit_at = ? WHERE id = ?',
          updateArgs: ['2026-08-01', 't-activities'],
          del: 'DELETE FROM activities WHERE id = ?',
        },
        {
          table: 'activity_engineers',
          insert: 'INSERT INTO activity_engineers (id, activity_id, engineer) VALUES (?,?,?)',
          insertArgs: ['t-activity_engineers', 'a1', '工程师甲'],
          update: 'UPDATE activity_engineers SET engineer = ? WHERE id = ?',
          updateArgs: ['工程师乙', 't-activity_engineers'],
          del: 'DELETE FROM activity_engineers WHERE id = ?',
        },
        {
          table: 'work_facts',
          insert: 'INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          insertArgs: ['t-work_facts', 'a1', 'i1', 'teardown', 'in_progress', 't', 't', 't'],
          update: 'UPDATE work_facts SET status = ? WHERE id = ?',
          updateArgs: ['done', 't-work_facts'],
          del: 'DELETE FROM work_facts WHERE id = ?',
        },
        {
          table: 'service_orders',
          insert: 'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          insertArgs: ['t-service_orders', 'relocation', 'ORD-t', 't', '工程师甲', '客户', 't', 't'],
          update: 'UPDATE service_orders SET note = ? WHERE id = ?',
          updateArgs: ['备注', 't-service_orders'],
          del: 'DELETE FROM service_orders WHERE id = ?',
        },
        {
          table: 'ship_tos',
          insert: 'INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)',
          insertArgs: ['t-ship_tos', 'ACC-t', '测试客户', '新址T', 't'],
          update: 'UPDATE ship_tos SET customer_name = ? WHERE id = ?',
          updateArgs: ['测试客户改', 't-ship_tos'],
          del: 'DELETE FROM ship_tos WHERE id = ?',
        },
        {
          table: 'ship_to_requests',
          insert: 'INSERT INTO ship_to_requests (id, customer_name, new_site_address, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
          insertArgs: ['t-ship_to_requests', '申请客户T', '申请新址T', 'pending_submit', 't', 't'],
          update: 'UPDATE ship_to_requests SET submitted_at = ? WHERE id = ?',
          updateArgs: ['2026-08-01', 't-ship_to_requests'],
          del: 'DELETE FROM ship_to_requests WHERE id = ?',
        },
        {
          table: 'serial_address_updates',
          insert: 'INSERT INTO serial_address_updates (id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?)',
          insertArgs: ['t-serial_address_updates', '客户', '新址', 'SN-t', 'ACC-t', 't', 't'],
          update: 'UPDATE serial_address_updates SET account_id = ? WHERE id = ?',
          updateArgs: ['ACC-t-改', 't-serial_address_updates'],
          del: 'DELETE FROM serial_address_updates WHERE id = ?',
        },
        {
          table: 'damage_repair_items',
          insert: 'INSERT INTO damage_repair_items (id, instrument_id, issue_status, registered_at, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          insertArgs: ['t-damage_repair_items', 'i1', 'untreated', 't', 'p1', 't', 't'],
          update: 'UPDATE damage_repair_items SET damage_reason = ? WHERE id = ?',
          updateArgs: ['运输碰撞', 't-damage_repair_items'],
          del: 'DELETE FROM damage_repair_items WHERE id = ?',
        },
        {
          table: 'activity_damage_links',
          insert: 'INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)',
          insertArgs: ['t-activity_damage_links', 'a1', 'd1', 't'],
          update: 'UPDATE activity_damage_links SET created_at = ? WHERE id = ?',
          updateArgs: ['2026-08-01T00:00:00+08:00', 't-activity_damage_links'],
          del: 'DELETE FROM activity_damage_links WHERE id = ?',
        },
        {
          table: 'qr_requests',
          insert: 'INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)',
          insertArgs: ['t-qr_requests', '申请人T', 't', 't'],
          update: 'UPDATE qr_requests SET applicant = ? WHERE id = ?',
          updateArgs: ['申请人T改', 't-qr_requests'],
          del: 'DELETE FROM qr_requests WHERE id = ?',
        },
        {
          table: 'qr_request_types',
          insert: 'INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)',
          insertArgs: ['t-qr_request_types', 'q1', 'TYPE-T'],
          update: 'UPDATE qr_request_types SET type_code = ? WHERE id = ?',
          updateArgs: ['TYPE-T-改', 't-qr_request_types'],
          del: 'DELETE FROM qr_request_types WHERE id = ?',
        },
        {
          table: 'logistics_fees',
          insert: 'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
          insertArgs: ['t-logistics_fees', 'b1', 't', 10000, 12000, 11000, 't', 't'],
          update: 'UPDATE logistics_fees SET applied_at = ? WHERE id = ?',
          updateArgs: ['2026-08-01', 't-logistics_fees'],
          del: 'DELETE FROM logistics_fees WHERE id = ?',
        },
        {
          table: 'invoices',
          insert: 'INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at) VALUES (?,?,?,?,?,?)',
          insertArgs: ['t-invoices', 'p1', 10000, 't', 't', 't'],
          update: 'UPDATE invoices SET amount_cents = ? WHERE id = ?',
          updateArgs: [20000, 't-invoices'],
          del: 'DELETE FROM invoices WHERE id = ?',
        },
      ];

      let expected = base;
      for (const c of cases) {
        expected += 1;
        db.prepare(c.insert).run(...c.insertArgs);
        expect(rev(db), `${c.table} INSERT 递增`).toBe(expected);
        expected += 1;
        db.prepare(c.update).run(...c.updateArgs);
        expect(rev(db), `${c.table} UPDATE 递增`).toBe(expected);
        expected += 1;
        db.prepare(c.del).run(c.insertArgs[0]);
        expect(rev(db), `${c.table} DELETE 递增`).toBe(expected);
      }
      expect(rev(db)).toBe(base + cases.length * 3);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('仓储写入（SqliteCustomerRepository.save）经同一触发器递增（仓储路径不可漏记）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const repo = new SqliteCustomerRepository(db);
      expect(rev(db)).toBe(0);
      repo.save({ id: 'repo-c1', name: '仓储客户', createdAt: 't' });
      expect(rev(db)).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('账号/审计/meta 写入不触发业务修订（非业务表不变化）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(rev(db)).toBe(0);

      // accounts（账号）：仅作访问门槛，不使 seal 失效
      db.prepare(
        'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('acc-1', '负责人', 'hash', 'salt', 't', 't');
      expect(rev(db)).toBe(0);
      db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run('负责人改', 'acc-1');
      expect(rev(db)).toBe(0);
      db.prepare('DELETE FROM accounts WHERE id = ?').run('acc-1');
      expect(rev(db)).toBe(0);

      // app_settings（系统设置/meta）
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)').run('upcoming_window_days', '7', 't');
      expect(rev(db)).toBe(0);
      db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('14', 'upcoming_window_days');
      expect(rev(db)).toBe(0);
      db.prepare('DELETE FROM app_settings WHERE key = ?').run('upcoming_window_days');
      expect(rev(db)).toBe(0);

      // migration_audit（迁移审计）
      db.prepare(
        'INSERT INTO migration_audit (id, batch_key, status, imported_at) VALUES (?,?,?,?)',
      ).run('ma-1', 'batch-1', 'success', 't');
      expect(rev(db)).toBe(0);
      db.prepare('UPDATE migration_audit SET operator = ? WHERE id = ?').run('运维', 'ma-1');
      expect(rev(db)).toBe(0);
      db.prepare('DELETE FROM migration_audit WHERE id = ?').run('ma-1');
      expect(rev(db)).toBe(0);

      // import_record_audit（迁移目标快照审计）
      db.prepare(
        `INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('ira-1', 'src-key-1', 'customers', 'c1', 'h1', 'h2', 't');
      expect(rev(db)).toBe(0);
      db.prepare('UPDATE import_record_audit SET target_snapshot_hash = ? WHERE id = ?').run('h3', 'ira-1');
      expect(rev(db)).toBe(0);
      db.prepare('DELETE FROM import_record_audit WHERE id = ?').run('ira-1');
      expect(rev(db)).toBe(0);

      // database_metadata（元数据自身）：轮换 generation 与直接写入均不递增修订
      const before = readDatabaseIdentity(db);
      const next = rotateContentGeneration(db);
      expect(next).not.toBe(before.contentGenerationId);
      expect(rev(db)).toBe(0);
      db.prepare('UPDATE database_metadata SET updated_at = ? WHERE id = 1').run('t2');
      expect(rev(db)).toBe(0);

      // 非业务写入后，业务写入仍正常递增（计数器未被污染）
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'c-after',
        '业务客户',
        't',
        't',
      );
      expect(rev(db)).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('事务回滚后 business_revision 恢复原值（触发器写入随事务回滚）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const r0 = rev(db);
      expect(r0).toBe(0);

      // 事务内业务写入立即递增；回滚后恢复
      db.exec('BEGIN');
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'rb-1',
        '回滚客户',
        't',
        't',
      );
      expect(rev(db)).toBe(r0 + 1);
      db.exec('ROLLBACK');
      expect(rev(db)).toBe(r0);
      expect(db.prepare('SELECT id FROM customers WHERE id = ?').get('rb-1')).toBeUndefined();

      // 提交路径正常递增并持久化
      db.exec('BEGIN');
      db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(
        'cm-1',
        '提交客户',
        't',
        't',
      );
      db.exec('COMMIT');
      expect(rev(db)).toBe(r0 + 1);

      // 关闭重开后修订保留（已提交）
      closeDatabase(db);
      const reopened = bootstrapDatabase({ dataDir: dir });
      expect(readBusinessRevision(reopened.db)).toBe(1);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
