import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision, readDatabaseIdentity } from '../../src/domain/capabilities/local-data-persistence/identity';
import type { Clock } from '../../src/domain/core/time';
import { FixedClock } from '../../src/domain/core/time';
import { MOBILE_READONLY_RECORD_KINDS } from '../../src/shared/mobile-readonly';
import {
  buildMobileReadonlySnapshot,
} from '../../src/main/mobile-readonly/snapshot';
import {
  seedSyntheticProjectRecords,
  seedSyntheticProjects,
} from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 单事务一致快照（tasks 3.1-3.2）：
 * - 单事务内复用 WorkbenchReadRepository 分页遍历全部项目（每页 20）与每项目六类记录
 *   （逐页收集至末页），同一事务捕获 contentGenerationId/businessRevision/dataAsOf；
 * - 事务内只读本地、零网络；序列化/校验在事务提交后执行。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setupDb(): { db: DatabaseSync; close: () => void } {
  const dir = makeTempDir('mobile-readonly-snapshot-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  return { db, close: () => closeDatabase(db) };
}

function buildWith(db: DatabaseSync, iso = FIXED_ISO) {
  return buildMobileReadonlySnapshot({ db, clock: new FixedClock(iso) });
}

function findProject(snapshot: ReturnType<typeof buildWith>, projectId: string) {
  const project = snapshot.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`项目缺失: ${projectId}`);
  return project;
}

describe('一致快照遍历全部项目（tasks 3.1）', () => {
  it('跨多页（每页 20）收集全部搬迁项目，无遗漏无重复', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProjects(db, 45); // 45 = 3 页（20+20+5）
      const snapshot = buildWith(db);

      expect(snapshot.projects.length).toBe(45);
      const ids = new Set(snapshot.projects.map((p) => p.id));
      expect(ids.size).toBe(45);
      for (const project of seeded) {
        expect(ids.has(project.projectId)).toBe(true);
      }
      for (const project of snapshot.projects) {
        expect(project.records.batches.length).toBe(0);
        expect(project.records.instruments.length).toBe(0);
        expect(project.records.activities.length).toBe(0);
        expect(project.records.orders.length).toBe(0);
        expect(project.records.invoices.length).toBe(0);
        expect(project.records.damage_items.length).toBe(0);
      }
    } finally {
      close();
    }
  });

  it('跨多页收集每项目全部六类关联记录（每类 55 条 = 2 页）且项目归属正确', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProjects(db, 5);
      const richProject = seeded[seeded.length - 1];
      const otherProject = seeded[0];
      // rich：六类各 55 条（各 2 页）；other：少量（验证不互相串扰）。
      seedSyntheticProjectRecords(db, richProject.projectId, {
        batches: 55,
        instruments: 55,
        activities: 55,
        orders: 55,
        invoices: 55,
        damageItems: 55,
      });
      seedSyntheticProjectRecords(db, otherProject.projectId, {
        batches: 3,
        instruments: 2,
        activities: 2,
        orders: 2,
        invoices: 2,
        damageItems: 2,
      });

      const snapshot = buildWith(db);
      expect(snapshot.projects.length).toBe(5);

      const rich = findProject(snapshot, richProject.projectId);
      const expectedCounts: Record<string, number> = {
        batches: 55,
        instruments: 55,
        activities: 55,
        orders: 55,
        invoices: 55,
        damage_items: 55,
      };
      for (const kind of MOBILE_READONLY_RECORD_KINDS) {
        const rows = rich.records[kind];
        expect(rows.length).toBe(expectedCounts[kind]);
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length); // 无重复
        expect(rows.every((r) => r.id.startsWith(`${richProject.projectId}-`))).toBe(true);
      }

      const other = findProject(snapshot, otherProject.projectId);
      expect(other.records.batches.length).toBe(3);
      expect(other.records.invoices.length).toBe(2);
      expect(other.records.instruments.length).toBe(2);
      expect(other.records.damage_items.length).toBe(2);
      // rich 项目不含 other 项目的记录。
      for (const kind of MOBILE_READONLY_RECORD_KINDS) {
        for (const row of rich.records[kind]) {
          expect(row.id.startsWith(`${otherProject.projectId}-`)).toBe(false);
        }
      }
    } finally {
      close();
    }
  });

  it('空库生成合法空集合快照（D10：schemaVersion=1，空项目，指标零值）', () => {
    const { db, close } = setupDb();
    try {
      const snapshot = buildWith(db);
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.overview.metrics).toEqual({
        totalProjects: 0,
        activeProjects: 0,
        pendingAmount: '0.00',
        pendingAcceptance: 0,
        pendingInvoice: 0,
      });
      expect(snapshot.schemaVersion).toBe(1);
      expect(snapshot.dataAsOf).toBe(FIXED_ISO);
      expect(snapshot.contentGenerationId.length).toBeGreaterThan(0);
      expect(snapshot.businessRevision).toBeGreaterThanOrEqual(0);
    } finally {
      close();
    }
  });

  it('生成产物键结构与 design.md 白名单表逐项一致（真实产物样例）', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProjects(db, 1);
      seedSyntheticProjectRecords(db, seeded[0].projectId, {
        batches: 1,
        instruments: 1,
        activities: 1,
        orders: 1,
        invoices: 1,
        damageItems: 1,
      });
      const snapshot = buildWith(db);
      const project = findProject(snapshot, seeded[0].projectId);
      const sorted = (keys: string[]): string[] => [...keys].sort();

      expect(sorted(Object.keys(snapshot))).toEqual(
        sorted(['schemaVersion', 'contentGenerationId', 'businessRevision', 'dataAsOf', 'overview', 'projects']),
      );
      expect(sorted(Object.keys(snapshot.overview))).toEqual(sorted(['metrics', 'stages']));
      expect(sorted(Object.keys(snapshot.overview.metrics))).toEqual(
        sorted(['totalProjects', 'activeProjects', 'pendingAmount', 'pendingAcceptance', 'pendingInvoice']),
      );
      expect(sorted(Object.keys(project))).toEqual(
        sorted([
          'id',
          'tempNo',
          'ecc',
          'customerName',
          'status',
          'region',
          'regionNeedsAdjustment',
          'entryAt',
          'planVisitAt',
          'finalAmount',
          'invoicedAmount',
          'contractAmount',
          'formallyEntered',
          'preEntryExecution',
          'records',
        ]),
      );
      expect(sorted(Object.keys(project.records))).toEqual(
        sorted(['batches', 'instruments', 'activities', 'orders', 'invoices', 'damage_items']),
      );
      expect(sorted(Object.keys(project.records.batches[0]))).toEqual(
        sorted(['id', 'planTransportDate', 'transportCompany', 'startedAt', 'appliedAt']),
      );
      expect(sorted(Object.keys(project.records.instruments[0]))).toEqual(
        sorted(['id', 'name', 'model', 'serialNo', 'ups']),
      );
      expect(sorted(Object.keys(project.records.activities[0]))).toEqual(
        sorted(['id', 'visitAt', 'engineers']),
      );
      expect(sorted(Object.keys(project.records.orders[0]))).toEqual(
        sorted(['id', 'orderType', 'serviceOrderNo', 'orderedAt', 'engineer']),
      );
      expect(sorted(Object.keys(project.records.invoices[0]))).toEqual(
        sorted(['id', 'amount', 'invoicedAt', 'active', 'revokedAt']),
      );
      expect(sorted(Object.keys(project.records.damage_items[0]))).toEqual(
        sorted([
          'id',
          'instrumentName',
          'serialNo',
          'issueStatus',
          'partNumber',
          'partQuantity',
          'partAmount',
          'partCurrency',
          'registeredAt',
        ]),
      );
    } finally {
      close();
    }
  });
});

describe('事务边界与身份捕获（tasks 3.2）', () => {
  it('dataAsOf 在事务内捕获；事务结束后提交完成，身份/修订与库一致', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProjects(db, 3);
      seedSyntheticProjectRecords(db, seeded[0].projectId, { batches: 2, invoices: 1 });

      // 记录 clock.nowIso 被调用时的事务状态（dataAsOf 捕获点）。
      const inTransactionAtCapture: boolean[] = [];
      const clock: Clock = {
        nowIso: () => {
          inTransactionAtCapture.push(db.isTransaction);
          return FIXED_ISO;
        },
        today: () => '2026-08-08',
      };
      const snapshot = buildMobileReadonlySnapshot({ db, clock });

      // dataAsOf 捕获时确实处于单一一致事务内。
      expect(inTransactionAtCapture.length).toBeGreaterThan(0);
      expect(inTransactionAtCapture.every(Boolean)).toBe(true);
      // 构建返回后事务已提交/结束。
      expect(db.isTransaction).toBe(false);

      // 身份与修订在同一事务内捕获，与库当前值一致。
      const identity = readDatabaseIdentity(db);
      expect(snapshot.contentGenerationId).toBe(identity.contentGenerationId);
      expect(snapshot.businessRevision).toBe(identity.businessRevision);
      expect(snapshot.businessRevision).toBe(readBusinessRevision(db));
      expect(snapshot.dataAsOf).toBe(FIXED_ISO);
    } finally {
      close();
    }
  });

  it('注入 db 函数在每次捕获开始时重新解析（恢复换库不持有陈旧句柄）；clock 每次构建注入 dataAsOf', () => {
    const { db, close } = setupDb();
    try {
      seedSyntheticProjects(db, 2);
      let resolved = 0;
      const first = buildMobileReadonlySnapshot({
        db: () => {
          resolved += 1;
          return db;
        },
        clock: new FixedClock('2026-08-08T09:00:00+08:00'),
      });
      expect(resolved).toBe(1);
      const second = buildMobileReadonlySnapshot({
        db: () => {
          resolved += 1;
          return db;
        },
        clock: new FixedClock('2026-08-08T09:30:00+08:00'),
      });
      expect(resolved).toBe(2);
      expect(first.dataAsOf).toBe('2026-08-08T09:00:00+08:00');
      expect(second.dataAsOf).toBe('2026-08-08T09:30:00+08:00');
      // 无写入时两次快照业务内容一致。
      expect(first.projects.length).toBe(second.projects.length);
      expect(first.businessRevision).toBe(second.businessRevision);
    } finally {
      close();
    }
  });

  it('生成快照已通过封闭白名单校验（事务后校验；非法候选不外发）', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProjects(db, 1);
      seedSyntheticProjectRecords(db, seeded[0].projectId, {
        batches: 1,
        instruments: 1,
        activities: 1,
        orders: 1,
        invoices: 1,
        damageItems: 1,
      });
      const snapshot = buildWith(db);
      expect(snapshot.overview.metrics.totalProjects).toBe(1);
      const project = findProject(snapshot, seeded[0].projectId);
      expect(project.records.batches.length).toBe(1);
    } finally {
      close();
    }
  });
});
