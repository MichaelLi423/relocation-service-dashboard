import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { formatCents } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import { validateMobileReadonlySnapshot } from '../../src/shared/mobile-readonly';
import { buildMobileReadonlySnapshot } from '../../src/main/mobile-readonly/snapshot';
import {
  makeSnapshotFixture,
  seedSyntheticProject,
  seedSyntheticProjectRecords,
  overwriteProjectAmounts,
} from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 金额契约（tasks 2.4）：快照金额复用主进程已格式化 DTO 的「主单位固定两位小数字符串」，
 * 绝不在发布链路再次除以 100 或转 Number（formatCents 自身的分→主单位格式化除外）。
 * 覆盖 >2^53 分、0、null（可空字段）与允许负值字段的负号两位小数字符串。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

interface Ctx {
  db: DatabaseSync;
  close: () => void;
}

function setupDb(): Ctx {
  const dir = makeTempDir('mobile-readonly-money-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  return {
    db,
    close: () => closeDatabase(db),
  };
}

function buildSnapshot(db: DatabaseSync) {
  return buildMobileReadonlySnapshot({ db, clock: new FixedClock(FIXED_ISO) });
}

/** 取合成快照里指定项目。 */
function findProject(snapshot: ReturnType<typeof buildSnapshot>, projectId: string) {
  const project = snapshot.projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  return project;
}

describe('金额契约：快照链不经 Number/除以 100（tasks 2.4）', () => {
  it('超安全整数金额（>2^53 分）经 formatCents 输出后原样进入快照，无浮点/除以 100 失真', () => {
    const { db, close } = setupDb();
    try {
      const bigCents = BigInt('9007199254740993'); // 2^53+1，Number 表示会丢失 1 分
      const seeded = seedSyntheticProject(db, {
        index: 0,
        finalAmountCents: bigCents,
        contractAmountCents: bigCents,
      });
      seedSyntheticProjectRecords(db, seeded.projectId, { invoices: 2, damageItems: 1 });
      overwriteProjectAmounts(db, seeded.projectId, {
        invoiceAmountCents: [BigInt('123456789012345'), 0n],
      });

      const snapshot = buildSnapshot(db);
      const project = findProject(snapshot, seeded.projectId);

      // 预期值仅由分整数经 formatCents 计算，不用 Number 参与。
      expect(project.finalAmount).toBe(formatCents(bigCents));
      expect(project.contractAmount).toBe(formatCents(bigCents));
      // 累计有效掉票 = SUM(有效 invoice 金额)。
      const expectedInvoiced = formatCents(BigInt('123456789012345') + 0n);
      expect(project.invoicedAmount).toBe(expectedInvoiced);
      // section 行按 created_at DESC 排序：idx1（amount 0，已撤销）在前，idx0（大额）在后。
      expect(project.records.invoices.length).toBe(2);
      expect(project.records.invoices[0].amount).toBe('0.00');
      expect(project.records.invoices[1].amount).toBe(formatCents(BigInt('123456789012345')));

      // 大金额字符串与整份快照均能通过纯字符串格式校验。
      const validation = validateMobileReadonlySnapshot(snapshot);
      expect(validation.ok).toBe(true);

      // 概览 pendingAmount 同样是两位小数字符串。
      expect(snapshot.overview.metrics.pendingAmount).toBe(
        formatCents(bigCents - BigInt('123456789012345')),
      );
    } finally {
      close();
    }
  });

  it('amount/partAmount 输出保持 DTO 两位小数字符串；partAmount 缺省为 "0.00"', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProject(db, { index: 1, finalAmountCents: 0n });
      // part_amount_cents 为 null（seed i%3===0）→ 0.00；invoice 金额分整数。
      seedSyntheticProjectRecords(db, seeded.projectId, {
        batches: 1,
        instruments: 1,
        activities: 1,
        orders: 1,
        invoices: 3,
        damageItems: 1,
      });
      const snapshot = buildSnapshot(db);
      const project = findProject(snapshot, seeded.projectId);
      expect(project.records.invoices[0].amount).toBe('1234.56');
      expect(project.records.invoices[1].amount).toBe('1234.56');
      expect(project.records.invoices[2].amount).toBe('1234.56');
      expect(project.records.damage_items[0].partAmount).toBe('0.00');
      // 全为字符串：不允许出现 number 型金额。
      for (const invoice of project.records.invoices) {
        expect(typeof invoice.amount).toBe('string');
      }
    } finally {
      close();
    }
  });

  it('可空项目金额字段为 null 时快照保持 null（不虚构 "0.00"）', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProject(db, {
        index: 2,
        finalAmountCents: null,
        contractAmountCents: null,
      });
      const snapshot = buildSnapshot(db);
      const project = findProject(snapshot, seeded.projectId);
      expect(project.finalAmount).toBeNull();
      expect(project.contractAmount).toBeNull();
      // 非空金额字段 invoicedAmount 仍然输出 "0.00"。
      expect(project.invoicedAmount).toBe('0.00');
      const validation = validateMobileReadonlySnapshot(snapshot);
      expect(validation.ok).toBe(true);
    } finally {
      close();
    }
  });

  it('允许负值的展示字段保留负号两位小数字符串（如 "-12.34"），不经 Number 丢失符号', () => {
    const { db, close } = setupDb();
    try {
      const seeded = seedSyntheticProject(db, { index: 3, finalAmountCents: 100000n });
      seedSyntheticProjectRecords(db, seeded.projectId, { invoices: 1 });
      overwriteProjectAmounts(db, seeded.projectId, { invoiceAmountCents: [-1234n] });

      const snapshot = buildSnapshot(db);
      const project = findProject(snapshot, seeded.projectId);
      expect(project.records.invoices[0].amount).toBe('-12.34');
      expect(typeof project.records.invoices[0].amount).toBe('string');
      // 校验器对两位小数字符串按格式校验（负号保留），不对值做 Number 语义约束。
      const validation = validateMobileReadonlySnapshot(snapshot);
      expect(validation.ok).toBe(true);
    } finally {
      close();
    }
  });
});

describe('金额契约：共享校验器只做格式校验（不经 Number/除以 100）', () => {
  function invalidateRowAmount(mutateAmount: unknown): unknown {
    const snapshot = makeSnapshotFixture();
    const project = snapshot.projects[0];
    const invoices = project.records.invoices.map((row) => ({ ...row }));
    invoices[0] = { ...invoices[0], amount: mutateAmount as never };
    return {
      ...snapshot,
      projects: [{ ...project, records: { ...project.records, invoices } }],
    };
  }

  it('接受任意大小（含超安全整数）的两位小数字符串，纯字符串路径无精度换算', () => {
    const snapshot = makeSnapshotFixture();
    const project = snapshot.projects[0];
    const invoices = project.records.invoices.map((row) => ({ ...row }));
    invoices[0] = { ...invoices[0], amount: '90071992547409.93' };
    invoices.push({ ...invoices[0], id: 'huge-2', amount: '99999999999999999999.99' });
    const mutated = {
      ...snapshot,
      projects: [{ ...project, records: { ...project.records, invoices } }],
    };
    expect(validateMobileReadonlySnapshot(mutated).ok).toBe(true);
  });

  it('拒绝非两位小数字符串与非字符串金额（Number、空串、缺小数、多余小数）', () => {
    for (const bad of [12.34, 0, '123', '1.2', '1.234', '', '.50', '1,234.00']) {
      const result = validateMobileReadonlySnapshot(invalidateRowAmount(bad));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.issues.some((i) => i.path.includes('amount'))).toBe(true);
    }
  });

  it('拒绝非可空金额字段为 null（invoicedAmount/amount/partAmount/pendingAmount）', () => {
    const snapshot = makeSnapshotFixture();
    const project = snapshot.projects[0];
    const invoices = project.records.invoices.map((row) => ({ ...row }));
    invoices[0] = { ...invoices[0], amount: null as never };
    const badInvoice = {
      ...snapshot,
      projects: [{ ...project, records: { ...project.records, invoices } }],
    };
    expect(validateMobileReadonlySnapshot(badInvoice).ok).toBe(false);

    const summaryProject = { ...project, invoicedAmount: null as never };
    expect(
      validateMobileReadonlySnapshot({ ...snapshot, projects: [summaryProject] }).ok,
    ).toBe(false);
  });

  it('接受 0 与负号两位小数（允许负值展示），但保持严格两位小数', () => {
    for (const ok of ['0.00', '-0.01', '-12.34', '123456789012345.67']) {
      const snapshot = makeSnapshotFixture();
      const project = snapshot.projects[0];
      const invoices = project.records.invoices.map((row) => ({ ...row }));
      invoices[0] = { ...invoices[0], amount: ok };
      expect(
        validateMobileReadonlySnapshot({
          ...snapshot,
          projects: [{ ...project, records: { ...project.records, invoices } }],
        }).ok,
      ).toBe(true);
    }
  });
});
