/**
 * 远程只读发布控制：谱系/激活/授权顺序的 wire 契约类型（tasks 1.2，design 决策 4）。
 *
 * 本模块只固定供桌面 publisher 与云端 commit 两端共用的「逻辑请求/结果类型」，
 * 供后续 durable 4.x 实现消费：
 * - `publisherId` + `authorizationEpoch` 是发布授权顺序；`databaseInstanceId` /
 *   `contentGenerationId` 是 UUID 谱系标识，不排序。`businessRevision` 只在同一
 *   谱系内单调递增；不同 lineage 的 revision 不可比（规则由 4.x 实现校验）。
 * - 快照前分配递增 `publicationSequence`；`snapshotId` 不可变；每次指针变更
 *   （含回滚）产生新的递增 `activationId`。
 * - `activationId` 使用十进制字符串 wire 类型，与投影读取信封 RemoteEnvelope 的
 *   `activationId: string` 一致（不做数值比较 helper；CAS 比较留给 4.x durable 实现）。
 * - 相同 job + 相同 checksum 的幂等 / 迟到旧 job / 陈旧 binding 等运行时判定
 *   不属于本类型层，留待 4.x durable ordering 实现。
 * - 不含 secret/凭据/网络/存储实现；不依赖 WorkbenchApi / Electron / 本机 DB。
 */

export interface PublisherBinding {
  publisherId: string;
  /** 授权代际（数字标识；单调轮换，比较规则由 4.x 实现）。 */
  authorizationEpoch: number;
}

export interface SourceLineage {
  /** UUID 谱系标识（不排序）。 */
  databaseInstanceId: string;
  /** UUID 谱系标识（不排序；restore/cleanup 会轮换）。 */
  contentGenerationId: string;
}

/** 快照前签发的串行作业号（每个 publisher 仅一个串行 job）。 */
export interface IssuedJobRef {
  publicationSequence: number;
}

/** 当前激活指针（云端 current 快照状态）。 */
export interface ActivationPointer {
  /** 不可变快照 ID。 */
  snapshotId: string;
  /**
   * 十进制字符串 wire 类型（与投影 RemoteEnvelope.activationId 一致）；
   * 每次指针变更（含回滚）递增。不做数值比较 helper。
   */
  activationId: string;
  businessRevision: number;
  lineage: SourceLineage;
}

/** 提交作业（发布方 → 云端的逻辑提交请求）。 */
export interface PendingPublication {
  /** 提交作业携带的谱系/修订。 */
  lineage: SourceLineage;
  businessRevision: number;
  publicationSequence: number;
  snapshotId: string;
  /** 作业内容 canonical sha256（幂等/内容校验依据；运行时校验由 4.x 实现）。 */
  contentChecksum: string;
  publisherId: string;
  authorizationEpoch: number;
  /** 提交时看到的当前 activationId（CAS 期望值；十进制字符串 wire 类型）。 */
  expectedActivationId: string;
}

/** 提交结果（云端 → 发布方的逻辑结果类型）。 */
export interface PublicationCommitResult {
  ok: boolean;
  /** 拒绝码（失败时；引用 PUBLICATION_REJECTION_CODES）。 */
  code?: PublicationRejectionCode;
  /** 成功时的新激活指针。 */
  activation?: ActivationPointer;
  /** metadata-only 中文说明（失败时；不回显业务值）。 */
  message?: string;
}

export const PUBLICATION_REJECTION_CODES = {
  /** 旧 authorizationEpoch / 陈旧 binding。 */
  STALE_AUTHORIZATION_EPOCH: 'STALE_AUTHORIZATION_EPOCH',
  /** 当前 binding/epoch 不匹配。 */
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  /** lineage 不匹配（提交 job 不属于当前绑定谱系）。 */
  LINEAGE_MISMATCH: 'LINEAGE_MISMATCH',
  /** 同 lineage businessRevision 递减/重复落后。 */
  REVISION_NOT_FORWARD: 'REVISION_NOT_FORWARD',
  /** 不是最新已签发作业。 */
  NOT_LATEST_JOB: 'NOT_LATEST_JOB',
  /** 相同作业但内容变化（checksum 不同）。 */
  JOB_CONTENT_CHANGED: 'JOB_CONTENT_CHANGED',
  /** CAS activationId 不匹配（并发陈旧提交）。 */
  ACTIVATION_CONFLICT: 'ACTIVATION_CONFLICT',
  /** 回滚/停用后同源旧作业。 */
  INVALIDATED_JOB: 'INVALIDATED_JOB',
  /** 需要显式 lineage 确认。 */
  REQUIRES_LINEAGE_CONFIRMATION: 'REQUIRES_LINEAGE_CONFIRMATION',
  /** 本地/云端已暂停。 */
  PAUSED: 'PAUSED',
} as const;

export type PublicationRejectionCode =
  (typeof PUBLICATION_REJECTION_CODES)[keyof typeof PUBLICATION_REJECTION_CODES];

/** 发布状态（桌面本地/云端确认分离；供状态入口引用）。 */
export type RemotePublicationState =
  | 'not_enabled'
  | 'local_stopped_cloud_unconfirmed'
  | 'cloud_paused'
  | 'publishing'
  | 'update_pending'
  | 'update_delayed'
  | 'publish_failed'
  | 'source_unavailable'
  | 'requires_lineage_confirmation'
  | 'no_snapshot'
  | 'active';

/** manifest/投影内容 checksum 与持久化 artifact 的引用（4.x durable 激活依赖）。 */
export interface PublishedArtifactRef {
  snapshotId: string;
  /** 十进制字符串 wire 类型（同 ActivationPointer.activationId）。 */
  activationId: string;
  contentChecksum: string;
  /** 持久化且验证完成的 artifact（未通过校验不激活）。 */
  durable: boolean;
}
