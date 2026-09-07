/**
 * 只读投影 manifest 契约（tasks 1.2/1.3）。
 *
 * - manifest 只携带谱系/发布元数据与「批准实体计数」：不含任何业务字段或业务值，
 *   是发布内容（manifest + JSONL 投影）的不可变头部。
 * - `databaseInstanceId`/`contentGenerationId` 为 UUID 谱系标识（不排序）；
 *   `businessRevision` 仅在同一谱系内单调递增。`publisherId`/`authorizationEpoch`/
 *   `publicationSequence`/`snapshotId`/`activationId` 属于 publication-control
 *   绑定/作业/激活元数据，不进入本 manifest（本模块是「发布内容契约」）。
 * - `businessDate` 固定 Asia/Shanghai 业务日期；`approvedSettingsDigest` 在未批准
 *   设置时使用 canonical empty digest（不允许跳过 digest）。
 * - checksum 采用 sha256（canonical bytes）；本契约仅声明与生成 canonical 字节，
 *     manifest↔JSONL 的交叉校验属于后续 streaming ingest（3.x）依赖。
 * - 纯数据契约，不依赖 WorkbenchApi / Electron / 本机 DB。
 */
import { createHash } from 'node:crypto';
import { InvalidValueRejection, UnknownFieldRejection, rejectionField } from './rejection';
import { toCount, toIso, toBusinessDate } from './values';

/** manifest 格式标识与版本。 */
export const REMOTE_MANIFEST_FORMAT = 'remote-readonly-projection-manifest';
export const REMOTE_MANIFEST_VERSION = 1 as const;

/** 投影契约版本（与 projection.ts 同源常量）。 */
export const MANIFEST_PROJECTION_VERSION = 'mobile-read-v1';

/** 业务日期固定时区（manifest.businessDate 由源端按该时区生成；诊断用途）。 */
export const MANIFEST_BUSINESS_TIMEZONE = 'Asia/Shanghai';

/**
 * 未批准显示设置的 canonical empty digest（不因无 revision 而跳过 digest）。
 * 常量值保持不变（与既有发布/消费方一致）；本模块只校验格式与是否允许该值。
 */
export const CANONICAL_EMPTY_SETTINGS_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** 已批准实体类型（计数键；activities/独立模块等不在投影内）。 */
export type ProjectionEntityType =
  | 'projects'
  | 'batches'
  | 'instruments'
  | 'orders'
  | 'invoices'
  | 'damageItems';

export const PROJECTION_ENTITY_TYPES: readonly ProjectionEntityType[] = [
  'projects',
  'batches',
  'instruments',
  'orders',
  'invoices',
  'damageItems',
] as const;

export type ProjectionEntityCounts = Record<ProjectionEntityType, number>;

export interface RemoteProjectionManifest {
  format: typeof REMOTE_MANIFEST_FORMAT;
  version: typeof REMOTE_MANIFEST_VERSION;
  projectionVersion: typeof MANIFEST_PROJECTION_VERSION;
  databaseInstanceId: string;
  contentGenerationId: string;
  businessRevision: number;
  /** yyyy-mm-dd（Asia/Shanghai）。 */
  businessDate: string;
  approvedSettingsDigest: string;
  /** 源端生成诊断时间（精确 ISO）。 */
  generatedAt: string;
  checksum: {
    algorithm: 'sha256';
    hex: string;
  };
  entityCounts: ProjectionEntityCounts;
}

const MANIFEST_ALLOWED_FIELDS: readonly string[] = [
  'format',
  'version',
  'projectionVersion',
  'databaseInstanceId',
  'contentGenerationId',
  'businessRevision',
  'businessDate',
  'approvedSettingsDigest',
  'generatedAt',
  'checksum',
  'entityCounts',
];

const CHECKSUM_ALLOWED_FIELDS: readonly string[] = ['algorithm', 'hex'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(obj)) {
    if (!(allowed as readonly string[]).includes(key)) {
      void key; // 未知键不进入错误（UnknownFieldRejection 只携带受控 context）。
      throw new UnknownFieldRejection(rejectionField(context, key));
    }
  }
}

/** 严格解析 manifest（未知键 → UNKNOWN_FIELD；UUID 谱系/digest/计数/长度/日期/ISO 严格校验）。 */
export function parseRemoteProjectionManifest(input: unknown): RemoteProjectionManifest {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'manifest 必须是对象');
  }
  rejectUnknownKeys(input, MANIFEST_ALLOWED_FIELDS, 'manifest');
  if (input['format'] !== REMOTE_MANIFEST_FORMAT) {
    throw new InvalidValueRejection('INVALID_FORMAT', 'manifest 格式标识不允许');
  }
  if (input['version'] !== REMOTE_MANIFEST_VERSION) {
    throw new InvalidValueRejection('INVALID_MANIFEST_VERSION', 'manifest 版本不允许');
  }
  if (input['projectionVersion'] !== MANIFEST_PROJECTION_VERSION) {
    throw new InvalidValueRejection('INVALID_MANIFEST_PROJECTION_VERSION', '投影版本不允许');
  }
  const businessRevision = input['businessRevision'];
  if (
    typeof businessRevision !== 'number' ||
    !Number.isSafeInteger(businessRevision) ||
    businessRevision < 0
  ) {
    throw new InvalidValueRejection('INVALID_REVISION', 'manifest businessRevision 必须是非负安全整数');
  }
  const databaseInstanceId = input['databaseInstanceId'];
  if (typeof databaseInstanceId !== 'string' || !UUID_PATTERN.test(databaseInstanceId)) {
    throw new InvalidValueRejection('INVALID_UUID', 'manifest databaseInstanceId 必须是 UUID');
  }
  const contentGenerationId = input['contentGenerationId'];
  if (typeof contentGenerationId !== 'string' || !UUID_PATTERN.test(contentGenerationId)) {
    throw new InvalidValueRejection('INVALID_UUID', 'manifest contentGenerationId 必须是 UUID');
  }
  const approvedSettingsDigest = input['approvedSettingsDigest'];
  if (
    typeof approvedSettingsDigest !== 'string' ||
    !(approvedSettingsDigest === CANONICAL_EMPTY_SETTINGS_DIGEST || SHA256_HEX_PATTERN.test(approvedSettingsDigest))
  ) {
    throw new InvalidValueRejection(
      'INVALID_SETTINGS_DIGEST',
      'manifest approvedSettingsDigest 必须是 64 位小写十六进制或 canonical empty digest',
    );
  }
  const checksum = input['checksum'];
  if (!isPlainObject(checksum)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'manifest checksum 必须是对象');
  }
  rejectUnknownKeys(checksum, CHECKSUM_ALLOWED_FIELDS, 'manifest.checksum');
  if (checksum['algorithm'] !== 'sha256') {
    throw new InvalidValueRejection('INVALID_CHECKSUM_ALGORITHM', 'checksum 算法必须为 sha256');
  }
  if (typeof checksum['hex'] !== 'string' || !SHA256_HEX_PATTERN.test(checksum['hex'])) {
    throw new InvalidValueRejection('INVALID_CHECKSUM', 'checksum hex 必须是 64 位小写十六进制');
  }
  const counts = input['entityCounts'];
  if (!isPlainObject(counts)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'manifest entityCounts 必须是对象');
  }
  rejectUnknownKeys(counts, PROJECTION_ENTITY_TYPES, 'manifest.entityCounts');
  const entityCounts = {} as ProjectionEntityCounts;
  for (const type of PROJECTION_ENTITY_TYPES) {
    entityCounts[type] = toCount(counts[type], `manifest.entityCounts.${type}`);
  }
  return {
    format: REMOTE_MANIFEST_FORMAT,
    version: REMOTE_MANIFEST_VERSION,
    projectionVersion: MANIFEST_PROJECTION_VERSION,
    databaseInstanceId: databaseInstanceId.toLowerCase(),
    contentGenerationId: contentGenerationId.toLowerCase(),
    businessRevision,
    businessDate: toBusinessDate(input['businessDate'], 'manifest.businessDate'),
    approvedSettingsDigest,
    generatedAt: toIso(input['generatedAt'], 'manifest.generatedAt'),
    checksum: { algorithm: 'sha256', hex: checksum['hex'] as string },
    entityCounts,
  };
}

/** 创建全 0 的已批准实体计数（synthetic fixture 等显式空投影使用）。 */
export function emptyEntityCounts(): ProjectionEntityCounts {
  return {
    projects: 0,
    batches: 0,
    instruments: 0,
    orders: 0,
    invoices: 0,
    damageItems: 0,
  };
}

/**
 * 计算发布内容（JSONL 投影）的权威 sha256（hex）。
 *
 * - 唯一入参是「精确 JSONL 文本」：逐字节（按 UTF-8 编码）原样哈希，不做键重排、
 *   不删除/改写任何字符——包括实际结尾的单个换行符（每行 `\n` 结尾，空快照为
 *   `''`）；manifest 自身不参与（调用方只传入 JSONL 文本）。
 * - 这是 manifest.checksum.hex 的唯一规范取值来源；manifest↔JSONL 的交叉计数与
 *   streaming 硬限制仍属后续 3.x 依赖。
 */
export function sha256JsonlContent(jsonlText: string): string {
  return createHash('sha256').update(jsonlText, 'utf8').digest('hex');
}
