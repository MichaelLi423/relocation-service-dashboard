/**
 * synthetic 快照/JSONL/manifest fixture（tasks 1.4）。
 *
 * 全部内容为人工构造假数据，不包含真实客户数据。manifest 只携带谱系/发布元数据
 * 与批准实体计数；JSONL 每行只含批准字段。序列化后经投影层/解析层 round-trip。
 *
 * - 完整发布项目行 = { kind:'project', row, detail }（ONE entity；detail 为已批准
 *   详情分组）；分区行 = { kind, row }。projectRecordToJsonl/sectionRowToJsonl 均先经
 *   严格解析器校验再输出。
 * - buildSyntheticSnapshot 产生「精确 UTF-8 JSONL 字节」：
 *   * 确定性顺序：先 project 记录（传入顺序），后各分区行（固定 kind 序 + id 排序）；
 *   * 换行规则：每行以单个 \n 结尾；空快照为 ''（无内容，也无关尾换行）；
 *   * manifest.checksum.hex = sha256(该 JSONL 精确 UTF-8 字节)（manifest 自身不计入）；
 *   * entityCounts 由实际数组长度派生（projects 每完整记录计 1），与 manifest 一致。
 */
import type { RemoteProjectionManifest } from '../../../src/shared/remote-readonly/manifest';
import type {
  RemoteProjectRecord,
  RemoteProjectRow,
  RemoteSectionKind,
  RemoteSectionRow,
} from '../../../src/shared/remote-readonly/projection';
import {
  projectRecordToJsonl,
  projectRowToJsonl,
  sectionRowToJsonl,
} from '../../../src/shared/remote-readonly/jsonl';
import {
  REMOTE_MANIFEST_FORMAT,
  REMOTE_MANIFEST_VERSION,
  MANIFEST_PROJECTION_VERSION,
  sha256JsonlContent,
} from '../../../src/shared/remote-readonly/manifest';

export const SYNTHETIC_DATABASE_INSTANCE_ID = '00000000-0000-4000-8000-000000000001';
export const SYNTHETIC_GENERATION_ID = '00000000-0000-4000-8000-0000000000a1';
export const SYNTHETIC_BUSINESS_DATE = '2026-08-10';
export const SYNTHETIC_GENERATED_AT = '2026-08-10T09:00:00+08:00';
export const SYNTHETIC_SETTINGS_DIGEST =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** sha256('')：空 JSONL 内容的规范摘要（与 manifest.ts CANONICAL 空语义一致）。 */
export const EMPTY_CONTENT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** 文本的 UTF-8 字节长度（测试断言精确字节）。 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 构造 synthetic manifest（可覆写；默认全 0 计数 + 空内容摘要 = 有效空快照）。 */
export function syntheticManifest(
  overrides: Partial<Omit<RemoteProjectionManifest, 'entityCounts' | 'checksum'>> & {
    entityCounts?: Partial<RemoteProjectionManifest['entityCounts']>;
    checksum?: Partial<RemoteProjectionManifest['checksum']>;
  } = {},
): RemoteProjectionManifest {
  const scalarOverrides = { ...overrides } as Partial<Omit<RemoteProjectionManifest, 'entityCounts' | 'checksum'>>;
  const { entityCounts, checksum } = overrides;
  return {
    ...{
      format: REMOTE_MANIFEST_FORMAT,
      version: REMOTE_MANIFEST_VERSION,
      projectionVersion: MANIFEST_PROJECTION_VERSION,
      databaseInstanceId: SYNTHETIC_DATABASE_INSTANCE_ID,
      contentGenerationId: SYNTHETIC_GENERATION_ID,
      businessRevision: 7,
      businessDate: SYNTHETIC_BUSINESS_DATE,
      approvedSettingsDigest: SYNTHETIC_SETTINGS_DIGEST,
      generatedAt: SYNTHETIC_GENERATED_AT,
    },
    ...scalarOverrides,
    checksum: {
      algorithm: 'sha256',
      hex: EMPTY_CONTENT_SHA256,
      ...checksum,
    },
    entityCounts: {
      projects: 0,
      batches: 0,
      instruments: 0,
      orders: 0,
      invoices: 0,
      damageItems: 0,
      ...entityCounts,
    },
  };
}

/** 项目 JSONL 行文本（行-only 旧诊断形状，不含 detail）。 */
export function projectJsonlText(row: RemoteProjectRow): string {
  return projectRowToJsonl(row);
}

/** 项目完整发布记录 JSONL 行文本（{ kind:'project', row, detail }）。 */
export function projectRecordJsonlText(record: RemoteProjectRecord): string {
  return projectRecordToJsonl(record);
}

/** 分区 JSONL 行文本。 */
export function sectionJsonlText(row: RemoteSectionRow): string {
  return sectionRowToJsonl(row);
}

/** 构造一份 JSONL 文本流（project 行-only + 分区行）。保留给旧行-only 断言。 */
export function syntheticSnapshotJsonl(rows: {
  projects: readonly RemoteProjectRow[];
  sections: readonly RemoteSectionRow[];
}): string {
  const lines: string[] = [];
  for (const project of rows.projects) lines.push(projectJsonlText(project));
  for (const section of rows.sections) lines.push(sectionJsonlText(section));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** 固定分区序列顺序（确定性：kind 序 + 组内 id 升序）。 */
const SECTION_KIND_ORDER: readonly RemoteSectionKind[] = [
  'batches',
  'instruments',
  'orders',
  'invoices',
  'damage_items',
];

/**
 * 按固定 kind 序 + 组内 id 升序稳定排序分区行（输入数组顺序不影响输出字节）。
 */
function orderSections(sections: readonly RemoteSectionRow[]): RemoteSectionRow[] {
  return [...sections].sort((a, b) => {
    const ak = SECTION_KIND_ORDER.indexOf(a.kind);
    const bk = SECTION_KIND_ORDER.indexOf(b.kind);
    if (ak !== bk) return ak - bk;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface SyntheticSnapshotInput {
  /** 项目完整发布记录（顺序保留；每条计 1 个 projects）。 */
  projects?: readonly RemoteProjectRecord[];
  /** 各分区行（顺序无关；工厂按确定性 kind+id 排序）。 */
  sections?: readonly RemoteSectionRow[];
}

export interface SyntheticSnapshotResult {
  /** 精确 JSONL 文本（空快照为 ''）。 */
  jsonl: string;
  /** 精确 UTF-8 字节长度。 */
  byteLength: number;
  /** sha256(jsonl 精确 UTF-8 字节)；即 manifest.checksum.hex。 */
  contentSha256: string;
  /** entityCounts 与 checksum 均已对齐该内容的 manifest。 */
  manifest: RemoteProjectionManifest;
}

/** 从计数派生已批准实体计数（不信任调用方计数，避免与数组不一致）。 */
function deriveEntityCounts(
  projects: readonly RemoteProjectRecord[],
  sections: readonly RemoteSectionRow[],
): RemoteProjectionManifest['entityCounts'] {
  const counts: RemoteProjectionManifest['entityCounts'] = {
    projects: projects.length,
    batches: 0,
    instruments: 0,
    orders: 0,
    invoices: 0,
    damageItems: 0,
  };
  for (const section of sections) {
    if (section.kind === 'damage_items') counts.damageItems += 1;
    else counts[section.kind] += 1;
  }
  return counts;
}

/**
 * 构造完整 synthetic 快照（确定性内容 + 对齐 manifest）。
 * - 确定性顺序 + 换行：project 记录（传入序）在前，分区行固定 kind 序 + id 升序；
 *   每行以单个 \n 结尾；空快照为 ''。
 * - checksum = sha256(JSONL 精确 UTF-8 字节)，manifest 自身不参与（排除 manifest）。
 */
export function buildSyntheticSnapshot(input: SyntheticSnapshotInput = {}): SyntheticSnapshotResult {
  const projects = input.projects ?? [];
  const sections = orderSections(input.sections ?? []);
  const lines: string[] = [];
  for (const record of projects) lines.push(projectRecordJsonlText(record));
  for (const section of sections) lines.push(sectionJsonlText(section));
  const jsonl = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  // 权威 checksum：直接调 shared manifest 的 sha256JsonlContent（与发布端同一实现）。
  const contentSha256 = sha256JsonlContent(jsonl);
  const manifest = syntheticManifest({
    entityCounts: deriveEntityCounts(projects, sections),
    checksum: { algorithm: 'sha256', hex: contentSha256 },
  });
  return {
    jsonl,
    byteLength: utf8ByteLength(jsonl),
    contentSha256,
    manifest,
  };
}
