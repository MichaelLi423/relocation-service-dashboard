/**
 * JSONL 投影线协议契约（tasks 1.2/1.3/1.4）。
 *
 * - 每一行是一个独立 JSON 对象；行类型由顶层 `kind` 判别：
 *   - project    → 项目完整发布记录 { kind, row, detail }（ONE entity；detail =
 *     RemoteProjectDetailGroup 已批准分组；权威发布形状见 projectRecordToJsonl）
 *   - batches/instruments/orders/invoices/damage_items → 各分区行（五分区）
 * - 每行都做 allowlist 严格解析（parseRemoteProjectRow / parseRemoteSectionRow /
 *   parseRemoteDetailGroup），未知字段（含 canary）以 metadata-only UNKNOWN_FIELD
 *   拒绝，不影响 last good。
 * - 序列化（projectRecordToJsonl / sectionRowToJsonl）先经同一严格解析器验证整棵
 *   approved 对象后才 stringify：任何顶层污染键（如行内夹带 customerName/tagIds
 *   等业务值）或嵌套污染（detail 未批准分组/键、counts/nonBlocking 子对象、批次的
 *   transportCompany、仪器的 manufacturer、开单/掉票/备件的备注与原因、计划装机旧
 *   别名 plannedInstallDoneAt 等未批准字段）在产生任何输出字节前即被拒绝，杜绝
 *   「先 JSON.stringify 泄漏多余属性再校验」的旁路。
 * - 允许字段即远程端 DDL/查询/错误/日志的唯一来源，杜绝未批准字段旁路。
 * - 兼容说明：projectRowToJsonl(row)/parseRemoteJsonlLine 是行-only 旧诊断/接收
 *   契约（不携带 detail）；项目完整发布记录必须走 projectRecordToJsonl /
 *   parseRemoteProjectRecordJsonl。本模块是发布/接收的逻辑契约层，不含真实 SQLite
 *   读取、网络、流式解析或 WorkbenchApi/Electron；manifest↔JSONL 交叉计数与
 *   streaming 硬限制属 3.x 依赖。
 */
import type { RemoteProjectRow, RemoteSectionRow, RemoteSectionKind, RemoteProjectRecord } from './projection';
import {
  parseRemoteProjectRow,
  parseRemoteSectionRow,
  parseRemoteProjectRecord,
} from './projection';
import {
  InvalidValueRejection,
  UnknownFieldRejection,
  rejectionField,
} from './rejection';

export type RemoteJsonlKind = 'project' | RemoteSectionKind;

export interface RemoteJsonlEnvelope {
  /** 类型判别：project 或五个分区之一。 */
  kind: RemoteJsonlKind;
  /** 关联项目（仅批次/仪器/掉票/备件行；orders 行在分区内固定带 projectId）。 */
  projectId?: string;
  /** 该行投影对象（仅批准字段）。 */
  row: RemoteProjectRow | RemoteSectionRow;
}

/** JSONL 行对象：{ kind, row }（kind 决定 row 的严格解析器；无 detail 的旧/诊断行）。 */
export interface RemoteJsonlRecord {
  kind: RemoteJsonlKind;
  row: RemoteProjectRow | RemoteSectionRow;
}

const JSONL_ALLOWED_FIELDS: readonly string[] = ['kind', 'row'];
const PROJECT_RECORD_JSONL_ALLOWED_FIELDS: readonly string[] = ['kind', 'row', 'detail'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 权威项目发布序列化：项目完整记录 { kind:'project', row, detail } 为 ONE entity。
 * - detail 为已批准详情分组（RemoteProjectDetailGroup）；「详情未录入」必须显式
 *   contract/facts=null，不省略 detail → 本 API 拒绝缺 detail 的行-only 对象；
 * - 先经 parseRemoteProjectRecord 严格校验整棵 approved 对象（未知键/值在产出任何
 *   字节前拒绝），再 JSON.stringify（键序与输入一致、无多余空白）。
 */
export function projectRecordToJsonl(record: RemoteProjectRecord): string {
  const validated = parseRemoteProjectRecord(record);
  return JSON.stringify(validated);
}

/** 严格解析项目完整发布 JSONL 行文本 → RemoteProjectRecord（缺 detail → 拒绝）。 */
export function parseRemoteProjectRecordJsonl(line: string): RemoteProjectRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new InvalidValueRejection('INVALID_JSON_LINE', 'JSONL 行不是合法 JSON 对象');
  }
  if (!isPlainObject(parsed)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'JSONL 行必须是对象');
  }
  for (const key of Object.keys(parsed)) {
    if (!(PROJECT_RECORD_JSONL_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new UnknownFieldRejection(rejectionField('jsonl', key));
    }
  }
  return parseRemoteProjectRecord(parsed);
}

/** 将已投影的项目行序列化为 JSONL 一行。先经严格解析校验整棵对象（含未知键/污染值
 *  一律拒绝，不产生任何输出），再 canonical JSON.stringify（无多余空白；仅批准字段）。
 *  @deprecated 行-only 诊断形状：不携带已批准 detail 分组。完整发布记录使用
 *  projectRecordToJsonl（detail 必填；不静默补默认空详情）。 */
export function projectRowToJsonl(row: RemoteProjectRow): string {
  // 序列化前经严格 allowlist 解析：顶层/嵌套未知或未批准键（含 canary 键与值）在此抛出，
  // JSON.stringify 永不看到污染对象 → 不会把多余属性带进输出字节。
  const validated = parseRemoteProjectRow(row);
  return JSON.stringify({ kind: 'project', row: validated });
}

/** 将已投影的分区行序列化为 JSONL 一行。同样先经对应分区的严格解析器校验后才 stringify。 */
export function sectionRowToJsonl(row: RemoteSectionRow): string {
  // 先严格解析：分区未知键/未批准字段（transportCompany、manufacturer、engineer、
  // customerName、note、revokeReason、repairNote、damageReason、createdAt 等）在此拒绝。
  const validated = parseRemoteSectionRow(row, row.kind);
  return JSON.stringify({ kind: validated.kind, row: validated });
}

/** 判别 kind 是 project 还是某分区。 */
export function isProjectJsonlKind(kind: unknown): kind is 'project' {
  return kind === 'project';
}

export function isSectionJsonlKind(kind: unknown): kind is RemoteSectionKind {
  return (
    kind === 'batches' ||
    kind === 'instruments' ||
    kind === 'orders' ||
    kind === 'invoices' ||
    kind === 'damage_items'
  );
}

/**
 * 严格解析一行 JSONL 文本 → { kind, row }。
 * 未知键（含 canary/未批准字段）一律 UNKNOWN_FIELD 拒绝。
 */
export function parseRemoteJsonlLine(line: string): RemoteJsonlRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new InvalidValueRejection('INVALID_JSON_LINE', 'JSONL 行不是合法 JSON 对象');
  }
  if (!isPlainObject(parsed)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'JSONL 行必须是对象');
  }
  for (const key of Object.keys(parsed)) {
    if (!(JSONL_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new UnknownFieldRejection(rejectionField('jsonl', key));
    }
  }
  const kind = parsed['kind'];
  if (!isProjectJsonlKind(kind) && !isSectionJsonlKind(kind)) {
    throw new InvalidValueRejection('INVALID_JSONL_KIND', 'JSONL 行类型不允许');
  }
  const rowRaw = parsed['row'];
  if (!isPlainObject(rowRaw)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'JSONL 行 row 必须是对象');
  }
  if (isProjectJsonlKind(kind)) {
    return { kind, row: parseRemoteProjectRow(rowRaw) };
  }
  return { kind, row: parseRemoteSectionRow(rowRaw, kind) };
}
