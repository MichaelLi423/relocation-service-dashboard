/**
 * snapshot-artifact.test.ts（tasks 2.2 snapshot-artifact 构建切片）
 *
 * - 用**真实** bootstrapDatabase + 实际 schema 直接 SQL 播种（非 mock reader）验证
 *   buildPublicationArtifact 端到端组装：
 * - 25 个合成项目跨 keyset 分页 + 最小有效分区（batch/instrument/order/invoice/damage）
 *   → JSONL 行可独立解析、manifest entityCounts/metrics/checksum/源身份正确；
 * - manifest 组合：identity 取自快照（与源一致）、businessDate=Asia/Shanghai、
 *   canonical empty settings digest、sha256 = 精确 JSONL UTF-8 字节；
 * - metrics = 已批准 RemoteOverviewMetrics 五键（totalProjects/activeProjects/
 *   pendingAcceptance/pendingInvoice/pendingAmount）；
 * - canary（tags/notes 等排除字段写入真实源列）绝不进入 JSONL/manifest；
 * - 无 SQLite 头部字节、无源库路径/临时路径出现在工件中；
 * - 源库活跃未提交事务（写身份+项目）在快照期间 → 工件内容/身份/修订 = 上一已提交一致
 *   状态；随后 commit 不影响已产出工件；
 * - 空库 → 0 计数 + JSONL '' + 规范空 sha256；
 * - 关联预检：damage→instrument 悬空/跨项目、instrument→batch 悬空/跨项目 → 整工件
 *   拒绝（SNAPSHOT_ASSOCIATION_INVALID，metadata-only），源关联不变；
 * - 错误边界：projectPage 抛带 canary 的 ValidationError/PersistenceError → 收口为固定
 *   SnapshotArtifactError，不透传 message/cause；必填非法值/generatedAt 非法 → 固定安全
 *   artifact code；快照临时目录清理、源库保持可写。
 *
 * 全部 synthetic（无真实业务/客户值），遵循既有真实临时 SQLite 集成测试惯例。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readDatabaseIdentity } from '../../src/domain/capabilities/local-data-persistence/identity';
import { PersistenceError, ValidationError } from '../../src/domain/core/errors';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { parseRemoteProjectRecordJsonl } from '../../src/shared/remote-readonly/jsonl';
import { parseRemoteProjectionManifest } from '../../src/shared/remote-readonly/manifest';
import { CANONICAL_EMPTY_SETTINGS_DIGEST } from '../../src/shared/remote-readonly/manifest';
import {
  buildPublicationArtifact,
  SnapshotArtifactError,
} from '../../src/main/remote-readonly/snapshot-artifact';
import { cleanupTempDir } from '../helpers/tmp-db';

const DIRS: string[] = [];
const NOW = '2026-09-01T00:00:00.000Z';
const GENERATED_AT = '2026-09-01T09:00:00+08:00';
const BUSINESS_DATE = '2026-09-01';

function newRoot(): string {
  const root = join(realpathSync(tmpdir()), `snapshot-artifact-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  DIRS.push(root);
  return root;
}

afterEach(() => {
  for (const dir of DIRS.splice(0)) cleanupTempDir(dir);
});

interface Ctx {
  db: DatabaseSync;
  dbPath: string;
  tempParent: string;
}

function bootstrapCtx(): Ctx {
  const root = newRoot();
  const { db, dbPath } = bootstrapDatabase({ dataDir: root });
  const tempParent = join(root, 'snap-tmp');
  mkdirSync(tempParent, { recursive: true, mode: 0o700 });
  return { db, dbPath, tempParent };
}

function insertCustomer(db: DatabaseSync, id: string, name: string): void {
  db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(id, name, NOW, NOW);
}

/** 用实际 schema 最小列插入项目（customer 可空；customer_id 关联可选）。 */
function insertProject(
  db: DatabaseSync,
  id: string,
  tempNo: string,
  status: string,
  customerId: string | null,
  updatedAt = NOW,
): void {
  db.prepare(
    'INSERT INTO projects (id, temp_no, status, customer_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, tempNo, status, customerId, NOW, updatedAt);
}

/** 用实际 schema 最小列播种 25 个跨分页项目（status 轮换覆盖 8 状态含 pre-entry/completed/cancelled）。 */
function seedProjects(db: DatabaseSync, count = 25, customerId: string | null = 'c1'): void {
  const statuses = [
    'pending_entry',
    'pending_execution',
    'executing',
    'under_repair',
    'pending_acceptance',
    'pending_invoice',
    'completed',
    'cancelled',
  ];
  for (let i = 0; i < count; i += 1) {
    const id = `art-p-${String(i).padStart(3, '0')}`;
    insertProject(
      db,
      id,
      `TP-ART-${String(i).padStart(3, '0')}`,
      statuses[i % statuses.length],
      customerId,
      `2026-09-01T${String(i % 10).padStart(2, '0')}:00:00.000Z`,
    );
  }
}

/** 给指定项目插入最小五分区行（各 1 条，实际 schema 列）。 */
function seedSectionsFor(db: DatabaseSync, projectId: string): void {
  db.prepare(
    'INSERT INTO batches (id, project_id, plan_transport_date, original_price_cents, discounted_price_cents, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(`${projectId}-b`, projectId, '2026-09-10', 100000, 80000, NOW, NOW);
  db.prepare(
    'INSERT INTO instruments (id, project_id, name, model, serial_no, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(`${projectId}-i`, projectId, '合成仪器', 'M-1', 'SN-1', NOW, NOW);
  db.prepare(
    'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(`${projectId}-o`, 'relocation', 'SO-ART-1', '2026-09-02', '合成工程师', '合成客户', projectId, NOW, NOW);
  db.prepare(
    'INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at) VALUES (?,?,?,?,?,?)',
  ).run(`${projectId}-inv`, projectId, 500000, '2026-09-03', NOW, NOW);
  db.prepare(
    'INSERT INTO damage_repair_items (id, project_id, instrument_id, issue_status, part_number, part_quantity, part_amount_cents, part_currency, registered_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(`${projectId}-d`, projectId, `${projectId}-i`, 'untreated', 'PN-ART-1', 1, 120000, 'USD', '2026-09-04', NOW, NOW);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('snapshot-artifact：真实库端到端组装', () => {
  it('25 项目跨页 + 分区行 → JSONL 可解析、计数/metrics/checksum/身份一致', async () => {
    const { db, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    seedProjects(db, 25, 'c1');
    // 给 p001 播种五分区，并给 p001 合同+掉票 → pendingAmount
    seedSectionsFor(db, 'art-p-001');
    db.prepare(
      'INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('ct-art', 'art-p-001', 'T-ART', 1000000, NOW, NOW);
    db.prepare(
      'INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at) VALUES (?,?,?,?,?,?)',
    ).run('inv-art', 'art-p-001', 400000, '2026-09-05', NOW, NOW);

    const sourceIdentity = readDatabaseIdentity(db);
    const artifact = await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });

    // 身份来自快照：与源库一致
    expect(artifact.manifest.databaseInstanceId).toBe(sourceIdentity.databaseInstanceId);
    expect(artifact.manifest.contentGenerationId).toBe(sourceIdentity.contentGenerationId);
    expect(artifact.manifest.businessRevision).toBe(sourceIdentity.businessRevision);
    // manifest 组合
    expect(artifact.manifest.format).toBe('remote-readonly-projection-manifest');
    expect(artifact.manifest.projectionVersion).toBe('mobile-read-v1');
    expect(artifact.manifest.businessDate).toBe(BUSINESS_DATE);
    expect(artifact.manifest.approvedSettingsDigest).toBe(CANONICAL_EMPTY_SETTINGS_DIGEST);
    expect(artifact.manifest.generatedAt).toBe(GENERATED_AT);
    // strict manifest parser 通过（manifest 是已解析后的规范对象）
    expect(parseRemoteProjectionManifest(artifact.manifest)).toEqual(artifact.manifest);

    // 计数：25 项目 + 五分区（p001 各 1）→ 5 section 行；注意 p001 额外 1 invoice
    expect(artifact.manifest.entityCounts.projects).toBe(25);
    expect(artifact.manifest.entityCounts.batches).toBe(1);
    expect(artifact.manifest.entityCounts.instruments).toBe(1);
    expect(artifact.manifest.entityCounts.orders).toBe(1);
    expect(artifact.manifest.entityCounts.damageItems).toBe(1);
    // p001 有 2 张掉票：seedSectionsFor 1 + inv-art 1 → 分区 invoices 计数 2
    expect(artifact.manifest.entityCounts.invoices).toBe(2);

    // JSONL 每行独立严格可解析（project 行带 detail；校验行数）
    const lines = artifact.jsonl === '' ? [] : artifact.jsonl.split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(25 + 1 + 1 + 1 + 2 + 1); // projects + batches + instruments + orders + invoices + damage
    for (const line of lines) {
      const obj = JSON.parse(line) as { kind: string };
      if (obj.kind === 'project') parseRemoteProjectRecordJsonl(line);
    }

    // checksum = sha256(精确 JSONL UTF-8 字节)
    expect(artifact.manifest.checksum.hex).toBe(sha256Hex(artifact.jsonl));
    // metrics：RemoteOverviewMetrics 已批准五键
    expect(Object.keys(artifact.metrics).sort()).toEqual([
      'activeProjects',
      'pendingAcceptance',
      'pendingAmount',
      'pendingInvoice',
      'totalProjects',
    ]);
    expect(artifact.metrics.totalProjects).toBe(25);
    // 手动计算 activeProjects：8 状态循环 25 个，非 completed/cancelled
    const statuses = [
      'pending_entry', 'pending_execution', 'executing', 'under_repair',
      'pending_acceptance', 'pending_invoice', 'completed', 'cancelled',
    ];
    let active = 0;
    let pa = 0;
    let pi = 0;
    for (let i = 0; i < 25; i += 1) {
      const s = statuses[i % statuses.length];
      if (s !== 'completed' && s !== 'cancelled') active += 1;
      if (s === 'pending_acceptance') pa += 1;
      if (s === 'pending_invoice') pi += 1;
    }
    expect(artifact.metrics.activeProjects).toBe(active);
    expect(artifact.metrics.pendingAcceptance).toBe(pa);
    expect(artifact.metrics.pendingInvoice).toBe(pi);
    // pendingAmount = 10000.00 - (400000+500000 分) = 1000000-900000=100000 分 = 1000.00
    expect(artifact.metrics.pendingAmount).toBe('1000.00');
    closeDatabase(db);
  });

  it('canary 排除字段（备注/tag/客户名称之外的排除列）不进工件；无 SQLite 头/路径泄漏', async () => {
    const { db, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    const CANARY = 'CANARY-EXCLUDED-SECRET-7';
    // projects.reminder_note / cancel_reason / old_site_contact 等是排除列
    db.prepare(
      `INSERT INTO projects (id, temp_no, status, customer_id, reminder_note, old_site_contact, cancel_reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('canary-p', 'TP-CANARY', 'pending_execution', 'c1', CANARY, CANARY, CANARY, NOW, NOW);
    // 合同注记是排除来源：contract 没有 note；orders.note / instrument 无额外；用 section 排除列
    db.prepare(
      'INSERT INTO service_orders (id, order_type, service_order_no, ordered_at, engineer, customer_name, note, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run('canary-o', 'relocation', 'SO-C', '2026-09-02', CANARY, '合成客户', CANARY, 'canary-p', NOW, NOW);
    db.prepare(
      'INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoke_reason, last_modified_at, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('canary-i', 'canary-p', 100, '2026-09-03', CANARY, NOW, NOW);

    const artifact = await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    expect(artifact.jsonl).not.toContain(CANARY);
    expect(JSON.stringify(artifact.manifest)).not.toContain(CANARY);
    expect(JSON.stringify(artifact.metrics)).not.toContain(CANARY);
    // 无 SQLite 二进制头 / 源路径 / 临时路径
    expect(artifact.jsonl).not.toContain('SQLite format 3');
    expect(artifact.jsonl).not.toContain('snapshot-artifact-test');
    expect(artifact.jsonl).not.toContain('snap-tmp');
    closeDatabase(db);
  });
});

describe('snapshot-artifact：空库与失败路径', () => {
  it('空库 → 0 计数、JSONL ""、规范空 sha256、pendingAmount 0.00', async () => {
    const { db, tempParent } = bootstrapCtx();
    const artifact = await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    expect(artifact.jsonl).toBe('');
    expect(artifact.manifest.entityCounts.projects).toBe(0);
    expect(artifact.manifest.entityCounts.batches).toBe(0);
    expect(artifact.manifest.entityCounts.instruments).toBe(0);
    expect(artifact.manifest.entityCounts.orders).toBe(0);
    expect(artifact.manifest.entityCounts.invoices).toBe(0);
    expect(artifact.manifest.entityCounts.damageItems).toBe(0);
    expect(artifact.manifest.checksum.hex).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('')).toBe(artifact.manifest.checksum.hex);
    expect(artifact.metrics.totalProjects).toBe(0);
    expect(artifact.metrics.activeProjects).toBe(0);
    expect(artifact.metrics.pendingAcceptance).toBe(0);
    expect(artifact.metrics.pendingInvoice).toBe(0);
    expect(artifact.metrics.pendingAmount).toBe('0.00');
    closeDatabase(db);
  });

  it('源库活跃未提交事务（新身份+新项目）在快照期间 → 工件 = 上一已提交一致状态；随后 commit 不影响工件', async () => {
    const { db, dbPath, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    insertProject(db, 'committed-1', 'TP-COMMIT-1', 'pending_execution', 'c1');
    const baseline = readDatabaseIdentity(db);

    // 活跃写者：开启未提交事务，写身份 + 插入项目 + 插入客户
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA busy_timeout = 5000;');
    writer.exec('BEGIN IMMEDIATE;');
    writer.prepare(
      'UPDATE database_metadata SET content_generation_id = ?, business_revision = business_revision + 1 WHERE id = 1',
    ).run('generation-uncommitted');
    insertProject(writer, 'uncommitted-1', 'TP-UNCOMMIT-1', 'completed', null);

    try {
      const artifact = await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
      // 身份/修订 = 上一已提交（快照一致视图，不含未提交）
      expect(artifact.manifest.databaseInstanceId).toBe(baseline.databaseInstanceId);
      expect(artifact.manifest.contentGenerationId).toBe(baseline.contentGenerationId);
      expect(artifact.manifest.businessRevision).toBe(baseline.businessRevision);
      expect(artifact.metrics.totalProjects).toBe(1);
      const lines = artifact.jsonl.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(1);
      expect(artifact.jsonl).not.toContain('uncommitted-1');
      expect(artifact.jsonl).not.toContain('TP-UNCOMMIT-1');
    } finally {
      writer.exec('COMMIT;');
      writer.close();
    }
    // commit 后源库看到未提交内容，但工件已固定（快照已清理）
    const after = readDatabaseIdentity(db);
    expect(after.contentGenerationId).toBe('generation-uncommitted');
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 });
    // 快照临时目录已被 wrapper 清理
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });

  it('必填字段非法值 → 整工件失败（固定安全 artifact code，非穿透原始拒绝）且临时目录清理', async () => {
    const { db, tempParent } = bootstrapCtx();
    // plan_visit_at 非法业务日期 → 投影严格解析拒绝（内部 InvalidValueRejection）
    db.prepare(
      'INSERT INTO projects (id, temp_no, status, plan_visit_at, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('bad-date', 'TP-BAD', 'pending_execution', 'not-a-date', NOW, NOW);
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    }
    // 边界收口为固定 SnapshotArtifactError（不改弱拒绝，只是不透传原始对象/消息）
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ARTIFACT_BUILD_FAILED');
    // metadata-only：不回显非法值/项目 id/路径/原始拒绝 code
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot artifact SNAPSHOT_ARTIFACT_BUILD_FAILED');
    expect(msg).not.toContain('not-a-date');
    expect(msg).not.toContain('bad-date');
    expect(msg).not.toContain('planVisitAt');
    expect(readdirSync(tempParent)).toEqual([]);
    // 源库未受影响仍可写
    insertProject(db, 'after-fail', 'TP-AFTER', 'completed', null);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 });
    closeDatabase(db);
  });

  it('generatedAt 非严格 ISO → 固定安全 artifact code，临时目录清理', async () => {
    const { db, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    insertProject(db, 'p-gen', 'TP-GEN', 'pending_execution', 'c1');
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: 'not-an-instant' });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ARTIFACT_BUILD_FAILED');
    // 不回显非法输入/路径
    expect((threw as Error).message).not.toContain('not-an-instant');
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });
});

describe('snapshot-artifact：错误边界收口（不透传原始 DomainError/cause/message）', () => {
  it('projectPage 抛带 canary 的 ValidationError → 固定 SNAPSHOT_ARTIFACT_BUILD_FAILED，无泄漏', async () => {
    const { db, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    insertProject(db, 'spy-p', 'TP-SPY', 'pending_execution', 'c1');
    const CANARY = 'CANARY-CUSTOMER-SECRET-1';
    const spy = vi
      .spyOn(WorkbenchReadRepository.prototype, 'projectPage')
      .mockImplementation(() => {
        throw new ValidationError('SOURCE_READ_FAILED', CANARY);
      });
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    } finally {
      spy.mockRestore();
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ARTIFACT_BUILD_FAILED');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot artifact SNAPSHOT_ARTIFACT_BUILD_FAILED');
    expect(msg).not.toContain(CANARY);
    expect(msg).not.toContain('SOURCE_READ_FAILED');
    expect(msg).not.toContain('snapshot-artifact-test');
    expect(msg).not.toContain('snap-tmp');
    // 不得携带 cause / 原错误属性
    expect((threw as { cause?: unknown }).cause).toBeUndefined();
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });

  it('projectPage 抛带 canary 的 PersistenceError → 固定 SNAPSHOT_ARTIFACT_BUILD_FAILED，无泄漏', async () => {
    const { db, tempParent } = bootstrapCtx();
    insertCustomer(db, 'c1', '合成客户甲');
    insertProject(db, 'spy-p2', 'TP-SPY2', 'pending_execution', 'c1');
    const CANARY = 'CANARY-CUSTOMER-SECRET-2';
    const spy = vi
      .spyOn(WorkbenchReadRepository.prototype, 'projectPage')
      .mockImplementation(() => {
        throw new PersistenceError('SOURCE_READ_FAILED', CANARY);
      });
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    } finally {
      spy.mockRestore();
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ARTIFACT_BUILD_FAILED');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot artifact SNAPSHOT_ARTIFACT_BUILD_FAILED');
    expect(msg).not.toContain(CANARY);
    expect(msg).not.toContain('SOURCE_READ_FAILED');
    expect(msg).not.toContain('snap-tmp');
    expect((threw as { cause?: unknown }).cause).toBeUndefined();
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });
});

describe('snapshot-artifact：快照关联预检（fail closed，不自动修复）', () => {
  /** 真实 FK 关闭时 synthetic 可写悬空引用：直接临时 PRAGMA foreign_keys=OFF。 */
  function seedProjectPair(db: DatabaseSync): { a: string; b: string } {
    insertCustomer(db, 'c1', '合成客户甲');
    const a = 'assoc-a';
    const b = 'assoc-b';
    insertProject(db, a, 'TP-A', 'pending_execution', 'c1');
    insertProject(db, b, 'TP-B', 'pending_execution', 'c1');
    return { a, b };
  }

  it('damage 引用另一项目仪器（跨项目）→ 整工件 SNAPSHOT_ASSOCIATION_INVALID，源关联不变', async () => {
    const { db, tempParent } = bootstrapCtx();
    const { a, b } = seedProjectPair(db);
    // IB 属于 B；damageA 挂在 A 上却引用 IB → 跨项目
    db.prepare(
      'INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('IB', b, 'B仪器', NOW, NOW);
    db.prepare(
      `INSERT INTO damage_repair_items (id, project_id, instrument_id, issue_status, part_number, part_quantity, part_amount_cents, registered_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('damageA', a, 'IB', 'untreated', 'PN-1', 1, 100, '2026-09-04', NOW, NOW);
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ASSOCIATION_INVALID');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot artifact SNAPSHOT_ASSOCIATION_INVALID');
    expect(msg).not.toContain('damageA');
    expect(msg).not.toContain('IB');
    expect(msg).not.toContain('assoc');
    expect(readdirSync(tempParent)).toEqual([]);
    // 源关联未被修改（无自动修复/业务写入）
    const d = db.prepare('SELECT project_id, instrument_id FROM damage_repair_items WHERE id = ?').get('damageA') as {
      project_id: string;
      instrument_id: string;
    };
    expect(d).toEqual({ project_id: a, instrument_id: 'IB' });
    closeDatabase(db);
  });

  it('damage.instrument_id 悬空引用（FK 关闭 synthetic 允许）→ SNAPSHOT_ASSOCIATION_INVALID', async () => {
    const { db, tempParent } = bootstrapCtx();
    const { a } = seedProjectPair(db);
    // FK 关闭才能写入悬空引用（模拟禁用外键的损坏源库）
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.prepare(
        `INSERT INTO damage_repair_items (id, project_id, instrument_id, issue_status, part_number, part_quantity, part_amount_cents, registered_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run('damage-orphan', a, 'NO-SUCH-INSTRUMENT', 'untreated', 'PN-1', 1, 100, '2026-09-04', NOW, NOW);
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ASSOCIATION_INVALID');
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });

  it('instrument 引用另一项目 batch（跨项目）→ SNAPSHOT_ASSOCIATION_INVALID', async () => {
    const { db, tempParent } = bootstrapCtx();
    const { a, b } = seedProjectPair(db);
    db.prepare(
      'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
    ).run('batchB', b, NOW, NOW);
    db.prepare(
      'INSERT INTO instruments (id, project_id, batch_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('IA', a, 'batchB', 'A仪器', NOW, NOW);
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ASSOCIATION_INVALID');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot artifact SNAPSHOT_ASSOCIATION_INVALID');
    expect(msg).not.toContain('batchB');
    expect(msg).not.toContain('assoc-a');
    expect(msg).not.toContain('assoc-b');
    expect(readdirSync(tempParent)).toEqual([]);
    // 源关联未被修改
    const i = db.prepare('SELECT project_id, batch_id FROM instruments WHERE id = ?').get('IA') as {
      project_id: string;
      batch_id: string;
    };
    expect(i).toEqual({ project_id: a, batch_id: 'batchB' });
    closeDatabase(db);
  });

  it('instrument.batch_id 悬空引用（FK 关闭 synthetic 允许）→ SNAPSHOT_ASSOCIATION_INVALID', async () => {
    const { db, tempParent } = bootstrapCtx();
    const { a } = seedProjectPair(db);
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.prepare(
        'INSERT INTO instruments (id, project_id, batch_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run('IA-orphan', a, 'NO-SUCH-BATCH', 'A仪器', NOW, NOW);
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
    let threw: unknown;
    try {
      await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotArtifactError);
    expect((threw as SnapshotArtifactError).code).toBe('SNAPSHOT_ASSOCIATION_INVALID');
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });

  it('正常同项目关联（damage→instrument、instrument→batch 全一致）仍成功', async () => {
    const { db, tempParent } = bootstrapCtx();
    const { a } = seedProjectPair(db);
    db.prepare(
      'INSERT INTO batches (id, project_id, created_at, updated_at) VALUES (?,?,?,?)',
    ).run('batchA', a, NOW, NOW);
    db.prepare(
      'INSERT INTO instruments (id, project_id, batch_id, name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('IA', a, 'batchA', 'A仪器', NOW, NOW);
    db.prepare(
      `INSERT INTO damage_repair_items (id, project_id, instrument_id, issue_status, part_number, part_quantity, part_amount_cents, registered_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('damageA', a, 'IA', 'untreated', 'PN-1', 1, 100, '2026-09-04', NOW, NOW);
    const artifact = await buildPublicationArtifact(db, { privateTempParent: tempParent, generatedAt: GENERATED_AT });
    expect(artifact.metrics.totalProjects).toBe(2);
    expect(artifact.manifest.entityCounts.instruments).toBe(1);
    expect(artifact.manifest.entityCounts.damageItems).toBe(1);
    expect(artifact.manifest.entityCounts.batches).toBe(1);
    expect(readdirSync(tempParent)).toEqual([]);
    closeDatabase(db);
  });
});
