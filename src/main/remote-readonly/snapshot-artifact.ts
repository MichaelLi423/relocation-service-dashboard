/**
 * 远程只读发布：发布工件构建（tasks 2.2 snapshot-artifact 切片）。
 *
 * 把 snapshot-source（一致只读快照 + 源身份）、snapshot-records（全量项目/分区行
 * JSONL 枚举）、snapshot-finance（快照待掉票金额）与 shared manifest 组装为单一
 * 「内部准备态」工件 { manifest, jsonl, metrics }：
 * - buildPublicationArtifact 先经 withPublicationSnapshot 拿到只读快照连接与源身份，
 *   用同一连接构造 WorkbenchReadRepository（today=Asia/Shanghai 业务日期，
 *   windowDays=0），以**无 UI 筛选**方式迭代 enumerateSnapshotRecords，逐条把已校验
 *   行追加为 LF 结尾 JSONL，同时做增量 UTF-8 字节预算（≤64 MiB，超限在 append 前
 *   拒绝；行数 100000/行 64KiB 由 snapshot-records 既有硬限保证）。
 * - 枚举前先对同一只读快照执行**固定 SQL 关联预检**（fail closed，不做任何业务写入/
 *   自动修复）：damage 行必须关联到 instrument 且二者 project_id 一致；instrument 的
 *   非空 batch_id 必须关联到同 project_id 的 batch。悬空/跨项目引用一律拒绝，错误只含
 *   稳定 code，不带任何 id/值。
 * - metrics 复用已批准的 RemoteOverviewMetrics（五键：totalProjects/activeProjects/
 *   pendingAcceptance/pendingInvoice/pendingAmount），只含该类型键，不进入 manifest；
 *   pendingAmount 完成后用快照 finance 读取。
 * - manifest 组合：format/version/projectionVersion 常量、databaseInstanceId/
 *   contentGenerationId/businessRevision **取自快照身份**（非活源库）、businessDate =
 *   generatedAt 经 asiaShanghaiBusinessDate 的 Asia/Shanghai 业务日期、approvedSettingsDigest
 *   = canonical empty（本切片无已批准设置）、entityCounts = 已枚举行计数、checksum =
 *   sha256JsonlContent(精确 JSONL 字节)；随后跑 parseRemoteProjectionManifest 严格校验，
 *   校验通过的对象即为返回的 manifest。
 * - 错误边界（oracle 2.2 修复）：无论内部抛出的是哪个 DomainError（含 source reader
 *   可能带业务/canary 消息的 ValidationError/PersistenceError），在工件构建边界一律
 *   **不穿透**原始错误/消息/cause——只按已知受控 code（本层 TOO_LARGE/ASSOCIATION_INVALID、
 *   快照 wrapper 的 CLEANUP_FAILED）重建为固定新 SnapshotArtifactError；其余一律重建为
 *   SNAPSHOT_ARTIFACT_BUILD_FAILED。返回对象/抛出的错误永不含 DB 路径/SQL/canary。
 * - 快照临时文件清理由 withPublicationSnapshot 统一负责（其 SnapshotSourceError 只被
 *   用于 code 判别后重建，不回显）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../domain/core/errors';
import { WorkbenchReadRepository } from '../../domain/capabilities/local-data-persistence/workbench-read-repository';
import type { DatabaseIdentity } from '../../domain/capabilities/local-data-persistence/identity';
import {
  CANONICAL_EMPTY_SETTINGS_DIGEST,
  MANIFEST_PROJECTION_VERSION,
  REMOTE_MANIFEST_FORMAT,
  REMOTE_MANIFEST_VERSION,
  sha256JsonlContent,
  parseRemoteProjectionManifest,
  type RemoteProjectionManifest,
  type ProjectionEntityCounts,
} from '../../shared/remote-readonly/manifest';
import { asiaShanghaiBusinessDate } from '../../remote-readonly/freshness/fingerprint';
import { withPublicationSnapshot, SnapshotSourceError } from './snapshot-source';
import { enumerateSnapshotRecords } from './snapshot-records';
import { readSnapshotPendingAmount } from './snapshot-finance';
import type { RemoteOverviewMetrics } from '../../shared/remote-readonly/projection';
import type { RemoteProjectStatus } from '../../shared/remote-readonly/projection';

/** JSONL 内容 UTF-8 总预算（design：64 MiB）。 */
export const SNAPSHOT_ARTIFACT_MAX_JSONL_BYTES = 64 * 1024 * 1024;

export const SNAPSHOT_ARTIFACT_ERROR_CODES = {
  /** JSONL 累计内容超过 64 MiB 预算（append 前拒绝，不产生部分工件）。 */
  SNAPSHOT_ARTIFACT_TOO_LARGE: 'SNAPSHOT_ARTIFACT_TOO_LARGE',
  /** 快照关联预检失败（damage↔instrument、instrument↔batch 悬空/跨项目）；无 id/值。 */
  SNAPSHOT_ASSOCIATION_INVALID: 'SNAPSHOT_ASSOCIATION_INVALID',
  /** 快照 wrapper 清理失败（重建固定 code；不回显原 SnapshotSourceError）。 */
  SNAPSHOT_ARTIFACT_CLEANUP_FAILED: 'SNAPSHOT_ARTIFACT_CLEANUP_FAILED',
  /** 其它 DB reader/generator/finance/原始错误（generic；不回显原因/路径/值）。 */
  SNAPSHOT_ARTIFACT_BUILD_FAILED: 'SNAPSHOT_ARTIFACT_BUILD_FAILED',
} as const;

export type SnapshotArtifactErrorCode =
  (typeof SNAPSHOT_ARTIFACT_ERROR_CODES)[keyof typeof SNAPSHOT_ARTIFACT_ERROR_CODES];

/** metadata-only 工件构建错误：message 只含稳定 code。 */
export class SnapshotArtifactError extends DomainError {
  constructor(code: SnapshotArtifactErrorCode) {
    super(code, `snapshot artifact ${code}`);
    this.name = 'SnapshotArtifactError';
  }
}

function artifactError(code: SnapshotArtifactErrorCode): SnapshotArtifactError {
  return new SnapshotArtifactError(code);
}

/** 把快照清理 code 映射为工件层固定错误（不回显原对象）。 */
function isCleanupFailure(err: unknown): boolean {
  return err instanceof SnapshotSourceError && err.code === 'SNAPSHOT_CLEANUP_FAILED';
}

/**
 * 工件构建边界收口：任何内部错误（含带 canary 消息的 ValidationError/PersistenceError/
 * 任意 DomainError/原始错误）→ 固定 SnapshotArtifactError，绝不穿透原始 message/cause。
 * 仅按「已知受控 code」保留区分：本层 TOO_LARGE/ASSOCIATION_INVALID 与 wrapper
 * CLEANUP_FAILED；其余一律 SNAPSHOT_ARTIFACT_BUILD_FAILED。
 */
function toArtifactError(err: unknown): SnapshotArtifactError {
  if (err instanceof SnapshotArtifactError) return err; // 已固定 code
  if (isCleanupFailure(err)) return artifactError('SNAPSHOT_ARTIFACT_CLEANUP_FAILED');
  return artifactError('SNAPSHOT_ARTIFACT_BUILD_FAILED');
}

export interface BuildPublicationArtifactOptions {
  /** main 自有、已验证存在/为目录的私有临时父目录（交给 withPublicationSnapshot）。 */
  privateTempParent: string;
  /** 源端生成诊断时间：带偏移严格 ISO；同时决定 Asia/Shanghai businessDate。 */
  generatedAt: string;
}

/** metrics：复用已批准的 RemoteOverviewMetrics（五键，不进入 manifest）。 */
export type PublicationMetrics = RemoteOverviewMetrics;

/** 内部准备态工件（manifest/jsonl 上传；metrics 仅发布决策用）。 */
export interface PublicationArtifact {
  manifest: RemoteProjectionManifest;
  jsonl: string;
  metrics: PublicationMetrics;
}

/** 固定 SQL 关联预检：damage→instrument、instrument→batch 必须同项目且非悬空。 */
function assertSnapshotAssociations(snapshotDb: DatabaseSync): void {
  const hasInvalid = (sql: string): boolean => {
    const row = snapshotDb.prepare(`${sql} LIMIT 1`).get() as { bad: number } | undefined;
    return row !== undefined;
  };
  // damage.instrument_id 缺失 / 悬空（LEFT JOIN 无 instrument）/ instrument.project_id
  // 为 NULL 或与 damage.project_id 不同 → 拒绝（NULL 比较一律 fail closed）。
  const damageInvalid = hasInvalid(
    `SELECT 1 AS bad FROM damage_repair_items d
     LEFT JOIN instruments i ON i.id = d.instrument_id
     WHERE d.instrument_id IS NULL OR d.project_id IS NULL
        OR i.id IS NULL OR i.project_id IS NULL OR i.project_id <> d.project_id`,
  );
  if (damageInvalid) throw artifactError('SNAPSHOT_ASSOCIATION_INVALID');
  // instrument 非空 batch_id 缺失 / 悬空 / batch.project_id 为 NULL 或与
  // instrument.project_id 不同 → 拒绝。
  const instrumentInvalid = hasInvalid(
    `SELECT 1 AS bad FROM instruments i
     LEFT JOIN batches b ON b.id = i.batch_id
     WHERE i.batch_id IS NOT NULL
       AND (b.id IS NULL OR b.project_id IS NULL OR b.project_id <> i.project_id)`,
  );
  if (instrumentInvalid) throw artifactError('SNAPSHOT_ASSOCIATION_INVALID');
}

/** 在一致只读快照连接上执行 reader 构建（consumer 内私有）。 */
function buildInSnapshot(
  snapshotDb: DatabaseSync,
  identity: DatabaseIdentity,
  options: { generatedAt: string },
): { manifest: RemoteProjectionManifest; jsonl: string; metrics: PublicationMetrics } {
  const { generatedAt } = options;
  const businessDate = asiaShanghaiBusinessDate(generatedAt);
  assertSnapshotAssociations(snapshotDb);
  const reader = new WorkbenchReadRepository(snapshotDb, {
    today: businessDate,
    windowDays: 0,
  });

  const lines: string[] = [];
  let jsonlBytes = 0;
  const metrics: PublicationMetrics = {
    totalProjects: 0,
    activeProjects: 0,
    pendingAcceptance: 0,
    pendingInvoice: 0,
    pendingAmount: '0.00',
  };
  let entityCounts: ProjectionEntityCounts | null = null;

  const gen = enumerateSnapshotRecords(reader);
  while (true) {
    const { done, value } = gen.next();
    if (done) {
      entityCounts = value as ProjectionEntityCounts;
      break;
    }
    if (value.kind === 'project') {
      metrics.totalProjects += 1;
      const status: RemoteProjectStatus = value.record.row.status;
      if (status !== 'completed' && status !== 'cancelled') metrics.activeProjects += 1;
      if (status === 'pending_acceptance') metrics.pendingAcceptance += 1;
      if (status === 'pending_invoice') metrics.pendingInvoice += 1;
    }
    const lineBytes = value.utf8Bytes + 1; // +1 结尾换行符
    if (jsonlBytes + lineBytes > SNAPSHOT_ARTIFACT_MAX_JSONL_BYTES) {
      throw artifactError('SNAPSHOT_ARTIFACT_TOO_LARGE');
    }
    jsonlBytes += lineBytes;
    lines.push(value.line);
  }
  if (entityCounts === null) throw artifactError('SNAPSHOT_ARTIFACT_BUILD_FAILED');

  const jsonl = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  const finance = readSnapshotPendingAmount(snapshotDb);
  metrics.pendingAmount = finance.pendingAmount;

  const manifestInput = {
    format: REMOTE_MANIFEST_FORMAT,
    version: REMOTE_MANIFEST_VERSION,
    projectionVersion: MANIFEST_PROJECTION_VERSION,
    databaseInstanceId: identity.databaseInstanceId,
    contentGenerationId: identity.contentGenerationId,
    businessRevision: identity.businessRevision,
    businessDate,
    approvedSettingsDigest: CANONICAL_EMPTY_SETTINGS_DIGEST,
    generatedAt,
    checksum: { algorithm: 'sha256' as const, hex: sha256JsonlContent(jsonl) },
    entityCounts,
  };
  const manifest = parseRemoteProjectionManifest(manifestInput);
  return { manifest, jsonl, metrics };
}

/** 由活源库构建发布工件（不经 renderer/网络；快照生命周期由 wrapper 统一负责）。 */
export async function buildPublicationArtifact(
  sourceDb: DatabaseSync,
  options: BuildPublicationArtifactOptions,
): Promise<PublicationArtifact> {
  const { privateTempParent, generatedAt } = options;
  try {
    return await withPublicationSnapshot(
      sourceDb,
      { privateTempParent },
      ({ db, identity }) => {
        // 快照连接有效期内完成全部构建；内部错误一律收口为固定工件错误。
        try {
          return buildInSnapshot(db, identity, { generatedAt });
        } catch (err) {
          throw toArtifactError(err);
        }
      },
    );
  } catch (err) {
    // 边界收口：wrapper 自身（含清理）也只映射固定 code，绝不透传原始错误/消息。
    throw toArtifactError(err);
  }
}
