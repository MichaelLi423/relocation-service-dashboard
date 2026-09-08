import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import { validateMobileReadonlySnapshot } from '../../src/shared/mobile-readonly';
import { buildMobileReadonlySnapshot } from '../../src/main/mobile-readonly/snapshot';
import {
  makeSnapshotFixture,
  mutateFirstRowOfKind,
  seedSyntheticProject,
  seedSyntheticProjectRecords,
} from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 日期契约（tasks 2.5）：业务日期一律 yyyy-mm-dd（真实日历日期）；快照不导出
 * 任何审计/技术 ISO 时间（dataAsOf 顶部时间除外）。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setupDb(): { db: DatabaseSync; close: () => void } {
  const dir = makeTempDir('mobile-readonly-date-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  return { db, close: () => closeDatabase(db) };
}

/** 递归收集对象键名。 */
function collectKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectKeys(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      prefix === '' ? key : `${prefix}.${key}`,
      ...collectKeys(child, prefix === '' ? key : `${prefix}.${key}`),
    ]);
  }
  return [];
}

/** 递归收集叶子字符串值。 */
function collectStringLeaves(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(collectStringLeaves);
  }
  return typeof value === 'string' ? [value] : [];
}

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe('日期契约：快照业务日期 yyyy-mm-dd 且无审计/技术 ISO 时间（tasks 2.5）', () => {
  it('业务日期原样输出（含闰日与空值），dataAsOf 由注入时钟捕获', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProject(db, { index: 0, finalAmountCents: 100000n });
      seedSyntheticProjectRecords(db, seeded.projectId, {
        batches: 2,
        instruments: 1,
        activities: 1,
        orders: 1,
        invoices: 2,
        damageItems: 1,
      });
      // 播种真实日历边界（闰年 2 月 29 日）+ 可空日期置空。
      db.prepare('UPDATE projects SET entry_at = ?, plan_visit_at = ? WHERE id = ?').run(
        '2024-02-29',
        null,
        seeded.projectId,
      );
      const invoiceRows = db
        .prepare('SELECT id FROM invoices WHERE project_id = ? ORDER BY id')
        .all(seeded.projectId) as Array<{ id: string }>;
      db.prepare('UPDATE invoices SET invoiced_at = ?, revoked_at = NULL WHERE id = ?').run(
        '2024-02-29',
        invoiceRows[0].id,
      );
      const batchRows = db
        .prepare('SELECT id FROM batches WHERE project_id = ? ORDER BY id')
        .all(seeded.projectId) as Array<{ id: string }>;
      db.prepare('UPDATE batches SET plan_transport_date = NULL WHERE id = ?').run(batchRows[1].id);

      const snapshot = buildMobileReadonlySnapshot({ db, clock: new FixedClock(FIXED_ISO) });
      const project = snapshot.projects.find((p) => p.id === seeded.projectId);
      if (!project) throw new Error('项目缺失');

      expect(snapshot.dataAsOf).toBe(FIXED_ISO);
      expect(project.entryAt).toBe('2024-02-29');
      expect(project.planVisitAt).toBeNull();
      // section 行按 created_at DESC：batch idx1（置空）在前，invoice idx0（闰日）在后。
      expect(project.records.batches[0].planTransportDate).toBeNull();
      expect(project.records.invoices[1].invoicedAt).toBe('2024-02-29');

      // 所有日期叶子均为 yyyy-mm-dd 或 null；除 dataAsOf 外没有任何 ISO 时间。
      const strings = collectStringLeaves(snapshot);
      const dateStrings = strings.filter((s) => BUSINESS_DATE_RE.test(s));
      for (const s of dateStrings) {
        expect(s).toMatch(BUSINESS_DATE_RE);
      }
      const isoLike = strings.filter((s) => ISO_DATETIME_RE.test(s));
      expect(isoLike).toEqual([FIXED_ISO]);
    } finally {
      close();
    }
  });

  it('快照对象不携带任何审计/技术字段名（含被排除的敏感文本键）', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProject(db, {
        index: 1,
        finalAmountCents: 200000n,
        withSensitive: true,
      });
      seedSyntheticProjectRecords(db, seeded.projectId, {
        batches: 1,
        instruments: 1,
        activities: 1,
        orders: 1,
        invoices: 1,
        damageItems: 1,
      });
      const snapshot = buildMobileReadonlySnapshot({ db, clock: new FixedClock(FIXED_ISO) });
      const keys = collectKeys(snapshot).map((k) => k.split('.').pop() ?? '');

      const forbiddenKeys = [
        'createdAt',
        'updatedAt',
        'lastModifiedAt',
        'generatedAt',
        'revokeReason',
        'damageReason',
        'repairNote',
        'note',
        'manufacturer',
        'serviceLevel',
        'qrRequested',
        'destinationShipToId',
        'originalPrice',
        'discountedPrice',
        'projectNote',
        'oldSiteAddress',
        'newSiteAddress',
        'oldSiteContact',
        'newSiteContact',
        'temporaryStorageAddress',
        'cancelReason',
        'managerApprovalReason',
        'accountId',
        'accountName',
        'passwordHash',
        'username',
        'session',
        'localPath',
        'filePath',
        'backupPath',
        'attachment',
        'reportData',
        'importSourceKey',
        'importSourceHash',
      ];
      for (const forbidden of forbiddenKeys) {
        expect(keys).not.toContain(forbidden);
      }
      // 敏感自由文本值绝不外泄。
      const text = JSON.stringify(snapshot);
      expect(text).not.toContain('旧址联系人');
      expect(text).not.toContain('项目备注');
      expect(text).not.toContain('维修备注');
      expect(text).not.toContain('撤销原因');
    } finally {
      close();
    }
  });
});

describe('日期契约：校验器对非法日历日期与审计 ISO 拒绝（tasks 2.5）', () => {
  function expectDateInvalid(value: unknown, pathFragment: string): void {
    const result = validateMobileReadonlySnapshot(value);
    if (result.ok) {
      throw new Error(`快照意外通过校验：应拒绝 ${pathFragment}`);
    }
    const hit = result.issues.some(
      (i) => i.code === 'INVALID_VALUE' && i.path.includes(pathFragment) && (i.message.includes('yyyy-mm-dd') || i.message.includes('ISO')),
    );
    expect(hit).toBe(true);
  }

  it('非真实日历日期被拒（2 月 30 日、13 月、非闰年 2 月 29 日）', () => {
    for (const bad of ['2023-02-30', '2026-13-01', '2023-02-29', '2026-00-10']) {
      expectDateInvalid(
        mutateFirstRowOfKind(makeSnapshotFixture(), 'batches', (row) => {
          row.planTransportDate = bad;
        }),
        'batches[0]',
      );
    }
    for (const bad of ['2026-02-30', '2025-02-29']) {
      expectDateInvalid(
        mutateFirstRowOfKind(makeSnapshotFixture(), 'orders', (row) => {
          row.orderedAt = bad;
        }),
        'orders[0]',
      );
    }
  });

  it('日历边界合法（2024-02-29 闰日、12-31、01-01）通过，且可空日期为 null 通过', () => {
    const snapshot = makeSnapshotFixture();
    for (const ok of ['2024-02-29', '2026-12-31', '2026-01-01']) {
      const candidate = mutateFirstRowOfKind(snapshot, 'invoices', (row) => {
        row.invoicedAt = ok;
      });
      expect(validateMobileReadonlySnapshot(candidate).ok).toBe(true);
    }
    const candidate = mutateFirstRowOfKind(snapshot, 'batches', (row) => {
      row.planTransportDate = null;
    });
    expect(validateMobileReadonlySnapshot(candidate).ok).toBe(true);
  });

  it('空字符串日期与带时间/时区的非业务日期在业务日期字段上被拒', () => {
    const fixtures = [
      ['batches', 'planTransportDate', ''],
      ['activities', 'visitAt', '2026-08-08T09:00:00+08:00'],
      ['invoices', 'revokedAt', '2026/08/08'],
      ['invoices', 'invoicedAt', '2026-8-8'],
      ['damage_items', 'registeredAt', 'not-a-date'],
    ] as const;
    for (const [kind, field, value] of fixtures) {
      expectDateInvalid(
        mutateFirstRowOfKind(makeSnapshotFixture(), kind, (row) => {
          row[field] = value;
        }),
        `${kind}[0]`,
      );
    }
  });

  it('顶层 dataAsOf 必须是带偏移/合法 ISO，缺失或非法被拒', () => {
    const snapshot = makeSnapshotFixture();
    for (const bad of ['2026-08-08', 'not-iso', 123, null]) {
      const result = validateMobileReadonlySnapshot({ ...snapshot, dataAsOf: bad });
      expect(result.ok).toBe(false);
    }
    expect(validateMobileReadonlySnapshot({ ...snapshot, dataAsOf: '2026-08-08T09:00:00Z' }).ok).toBe(true);
  });

  it('dataAsOf 拒绝不存在的日历日期/时间/偏移与缺失时区（回归：不靠 Date.parse 归一化）', () => {
    const snapshot = makeSnapshotFixture();
    const badValues = [
      '2026-02-30T09:00:00+08:00', // 不存在的日历日期（2 月 30 日）
      '2026-02-30T99:99:99+99:99', // 阻塞示例：日历日期 + 时间 + 偏移全部非法
      '2026-08-08T09:00:00', // 阻塞示例：缺失时区（无 Z / 无显式偏移）
      '2026-08-08T25:00:00+08:00', // 小时越界
      '2026-08-08T09:60:00+08:00', // 分钟越界
      '2026-08-08T09:00:60+08:00', // 秒越界（拒绝闰秒 60）
      '2026-08-08T09:00:00+99:99', // 偏移小时/分越界
      '2026-08-08T09:00:00-24:00', // 偏移小时越界（负数侧）
      '2026-08-08T09:00:00+08:60', // 偏移分越界
      '2026-08-08T09:00:00+08', // 偏移缺分
      '2026-13-01T09:00:00Z', // 月份非法
    ];
    for (const bad of badValues) {
      const result = validateMobileReadonlySnapshot({ ...snapshot, dataAsOf: bad });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`dataAsOf 意外通过校验：${bad}`);
    }
  });

  it('dataAsOf 接受合法 UTC 与显式偏移（含闰日、小数秒 .sssZ、分钟精度与非整点偏移）', () => {
    const snapshot = makeSnapshotFixture();
    const goodValues = [
      '2024-02-29T09:00:00+08:00', // 闰日 + 显式偏移
      '2026-08-08T09:00:00.123Z', // UTC 小数秒（.sssZ 保留）
      '2026-08-08T09:00Z', // UTC 分钟精度
      '2026-08-08T09:30:00+05:45', // 非整点偏移（+05:45）
      '2026-08-08T23:59:59Z', // 时间边界
      '2026-08-08T09:00:00-12:00', // 负偏移
    ];
    for (const good of goodValues) {
      const result = validateMobileReadonlySnapshot({ ...snapshot, dataAsOf: good });
      if (!result.ok) throw new Error(`dataAsOf 意外被拒：${good}`);
      expect(result.ok).toBe(true);
    }
  });
});
