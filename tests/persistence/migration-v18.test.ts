import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapDatabase,
  MIGRATIONS,
} from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, openDatabase, readSchemaVersion } from '../../src/domain/capabilities/local-data-persistence/connection';
import { runMigrations } from '../../src/domain/capabilities/local-data-persistence/migration';
import { businessRevisionTriggerName } from '../../src/domain/capabilities/local-data-persistence/schema-v10';
import { LATEST_SCHEMA_VERSION } from '../../src/domain/capabilities/local-data-persistence/schema-v20';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * schema v18：物流费用登记全部字段可选（重建 logistics_fees）。
 *
 * - applied_at / budget_price_cents / deal_price_cents / logistics_cost_cents 改 nullable；
 * - 完整保留全部列（v1 基础列 + v2 账号归属 + v7 导入来源列）、STRICT、
 *   batch_id NOT NULL UNIQUE REFERENCES batches(id)；
 * - 重建 v7 索引 idx_logistics_fees_import_source_key 与 v10 业务修订三触发器；
 * - 存量数据原样保留、不归一化。
 */

/** 建立 v17 数据库（含完整 logistics_fees 数据的真实 fixture）。 */
function openV17(dir: string): { db: DatabaseSync; backupDir: string } {
  const dbPath = `${dir}/workbench.db`;
  const backupDir = `${dir}/migration-backups`;
  const db = openDatabase({ path: dbPath });
  runMigrations(db, { migrations: MIGRATIONS.slice(0, 17), backupDir });
  expect(readSchemaVersion(db)).toBe(17);
  return { db, backupDir };
}

/** 写入项目/批次/完整费用（含账号归属与导入来源列）。 */
function seedFeeData(db: DatabaseSync): void {
  const nowIso = '2026-08-01T00:00:00+08:00';
  db.exec('BEGIN');
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人', 'hash', 'salt', nowIso, nowIso);
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('p1', 'TP-FEE', 'pending_execution', nowIso, nowIso);
  db.prepare(
    'INSERT INTO batches (id, project_id, plan_transport_date, transport_company, original_price_cents, discounted_price_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run('b1', 'p1', '2026-08-10', '顺丰', 1200000, 1100000, nowIso, nowIso);
  db.prepare(
    `INSERT INTO logistics_fees (
       id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents,
       account_id, username_snapshot, import_source_key, import_source_hash, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'f1', 'b1', '2026-08-09', 1200000, 1100000, 1100000,
    'account-1', '负责人', 'logistics|F-1', 'src-hash-f1', nowIso, nowIso,
  );
  db.exec('COMMIT');
}

describe('schema v18：物流费用登记字段可选（重建 logistics_fees）', () => {
  it(`全新库引导到最新版本：迁移序列 1..${LATEST_SCHEMA_VERSION}、版本写入 ${LATEST_SCHEMA_VERSION}`, () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(MIGRATIONS.map((m) => m.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v17→v18：费用四业务字段改 nullable，其余列/STRICT/UNIQUE/FK 完整保留，数据原样保留', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV17(dir);
      seedFeeData(db);

      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // 全部列保留（v1 基础列 + v2 账号归属 + v7 导入来源列）
      const cols = db.prepare('PRAGMA table_info(logistics_fees)').all() as {
        name: string;
        type: string;
        notnull: number;
      }[];
      const names = cols.map((c) => c.name);
      for (const col of [
        'id', 'batch_id', 'applied_at', 'budget_price_cents', 'deal_price_cents',
        'logistics_cost_cents', 'account_id', 'username_snapshot',
        'import_source_key', 'import_source_hash', 'created_at', 'updated_at',
      ]) {
        expect(names, `应保留列 ${col}`).toContain(col);
      }
      // 业务费用字段可空；batch_id 仍 NOT NULL（每批次唯一外键）
      for (const col of ['applied_at', 'budget_price_cents', 'deal_price_cents', 'logistics_cost_cents']) {
        expect(cols.find((c) => c.name === col)?.notnull, `${col} 应为 nullable`).toBe(0);
      }
      expect(cols.find((c) => c.name === 'batch_id')?.notnull).toBe(1);
      // STRICT：非 STRICT 表插入未知类型列会静默接受；STRICT 表拒绝 TEXT 进 INTEGER 列
      expect(() => db.prepare('INSERT INTO logistics_fees (id, batch_id, deal_price_cents, created_at, updated_at) VALUES (?,?,?,?,?)').run('f-strict', 'b1', 'not-a-number', 't', 't')).toThrow();
      // 数据原样保留（金额按 BigInt 精确读取，导入来源/账号归属完整）
      const fee = db.prepare('SELECT * FROM logistics_fees WHERE id = ?').get('f1') as Record<string, unknown>;
      expect(fee.batch_id).toBe('b1');
      expect(fee.applied_at).toBe('2026-08-09');
      expect(BigInt(String(fee.budget_price_cents))).toBe(1200000n);
      expect(BigInt(String(fee.deal_price_cents))).toBe(1100000n);
      expect(BigInt(String(fee.logistics_cost_cents))).toBe(1100000n);
      expect(fee.account_id).toBe('account-1');
      expect(fee.username_snapshot).toBe('负责人');
      expect(fee.import_source_key).toBe('logistics|F-1');
      expect(fee.import_source_hash).toBe('src-hash-f1');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v18 后：UNIQUE（每批次一笔）与 FK 生效，nullable 列可存 null（部分费用）', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV17(dir);
      seedFeeData(db);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });

      // 部分费用：applied_at 与三金额均可空
      db.prepare(
        'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('b2', 'p1', 't', 't');
      db.prepare(
        'INSERT INTO logistics_fees (id, batch_id, applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run('f-partial', 'b2', null, null, 0, null, 't', 't');
      const partial = db.prepare('SELECT applied_at, deal_price_cents FROM logistics_fees WHERE id = ?').get('f-partial') as {
        applied_at: string | null;
        deal_price_cents: number | null;
      };
      expect(partial.applied_at).toBeNull();
      expect(partial.deal_price_cents).toBe(0); // 显式 0 与 null 严格区分

      // 每批次仅一笔：batch_id UNIQUE 仍生效
      expect(() =>
        db.prepare(
          'INSERT INTO logistics_fees (id, batch_id, created_at, updated_at) VALUES (?,?,?,?)',
        ).run('f-dup', 'b1', 't', 't'),
      ).toThrow();
      // FK 生效：引用不存在的批次拒绝
      expect(() =>
        db.prepare(
          'INSERT INTO logistics_fees (id, batch_id, created_at, updated_at) VALUES (?,?,?,?)',
        ).run('f-orphan', 'no-such-batch', 't', 't'),
      ).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v18 后：v7 导入来源索引与 v10 业务修订三触发器完整重建', () => {
    const dir = makeTempDir();
    try {
      const { db, backupDir } = openV17(dir);
      seedFeeData(db);
      runMigrations(db, { migrations: [...MIGRATIONS], backupDir });

      // v7 索引
      const index = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'idx_logistics_fees_import_source_key'")
        .get() as { sql: string } | undefined;
      expect(index).toBeDefined();
      expect(index!.sql).toContain('logistics_fees(import_source_key)');

      // v10 业务修订三触发器（insert/update/delete 齐全）
      for (const event of ['insert', 'update', 'delete'] as const) {
        const trigger = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
          .get(businessRevisionTriggerName('logistics_fees', event)) as { sql: string } | undefined;
        expect(trigger, `触发器 ${event} 应存在`).toBeDefined();
        expect(trigger!.sql).toContain(`ON logistics_fees`);
      }
      // 触发器实际生效：INSERT/UPDATE/DELETE 均递增 business_revision
      const readRev = (): number =>
        (db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as { business_revision: number }).business_revision;
      const base = readRev();
      db.prepare(
        'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('b3', 'p1', 't', 't');
      db.prepare(
        'INSERT INTO logistics_fees (id, batch_id, created_at, updated_at) VALUES (?,?,?,?)',
      ).run('f-trigger', 'b3', 't', 't');
      expect(readRev()).toBe(base + 2); // batches INSERT + logistics_fees INSERT
      db.prepare('UPDATE logistics_fees SET applied_at = ? WHERE id = ?').run('2026-08-01', 'f-trigger');
      expect(readRev()).toBe(base + 3);
      db.prepare('DELETE FROM logistics_fees WHERE id = ?').run('f-trigger');
      expect(readRev()).toBe(base + 4);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
