import { ValidationError } from '../../domain/core/errors';
import { isValidBusinessDate } from '../../domain/core/time';
import { CANONICAL_EMPTY_SETTINGS_DIGEST } from '../../shared/remote-readonly/manifest';

/**
 * 远程只读源指纹（tasks 5.1 纯函数部分）。
 *
 * 指纹 = (databaseInstanceId, contentGenerationId, businessRevision,
 * approvedDisplaySettingsDigest, businessDate[Asia/Shanghai], projectionVersion)。
 * 相等判定用于「仅匹配当前快照指纹的源报告才更新 sourceConfirmedAt」与
 * 「无变化确认不重新发布」。5.2~5.4（挑战/心跳/时间推进/状态/时钟闸门）不在本文件。
 *
 * 注意：本文件不 import 未完成的共享契约 lane 的其他内容；canonical empty digest
 * 常量取自 shared manifest（已存在且 read-only 检查过）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_RE = /^(0|[1-9]\d*)$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 本切片内没有任何已批准的业务显示设置（白名单为空）。 */
export const APPROVED_DISPLAY_SETTING_KEYS: readonly string[] = [];

export interface SourceLineage {
  readonly databaseInstanceId: string;
  readonly contentGenerationId: string;
}

export type BusinessRevision = number | bigint | string;

export interface SourceFingerprintInput {
  readonly lineage: SourceLineage;
  readonly businessRevision: BusinessRevision;
  /** 已批准设置摘要（64 位小写十六进制）或规范空摘要。 */
  readonly approvedSettingsDigest?: string;
  /** Asia/Shanghai 业务日期 yyyy-mm-dd。 */
  readonly businessDate: string;
  readonly projectionVersion: string;
}

export interface SourceFingerprint {
  readonly lineage: { readonly databaseInstanceId: string; readonly contentGenerationId: string };
  readonly businessRevision: string;
  readonly approvedSettingsDigest: string;
  readonly businessDate: string;
  readonly projectionVersion: string;
  readonly canonical: string;
}

/** 错误消息只含稳定代码与字段名，永不插值调用方输入。 */
function invalid(field: string, code: string): ValidationError {
  return new ValidationError(code, `${field} 不合法`);
}

function toCanonicalUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw invalid(field, 'INVALID_LINEAGE_UUID');
  }
  return value.toLowerCase();
}

function toCanonicalRevision(value: BusinessRevision): string {
  if (typeof value === 'bigint') {
    if (value < 0n) throw invalid('businessRevision', 'INVALID_BUSINESS_REVISION');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid('businessRevision', 'INVALID_BUSINESS_REVISION');
    return String(value);
  }
  if (typeof value !== 'string' || !REVISION_RE.test(value)) {
    throw invalid('businessRevision', 'INVALID_BUSINESS_REVISION');
  }
  return value;
}

function toCanonicalDigest(value: unknown): string {
  // 无已批准设置 → shared manifest 规范空摘要（sha256('[]')，64 位小写 hex）。
  if (value === undefined || value === null || value === '') return CANONICAL_EMPTY_SETTINGS_DIGEST;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalid('approvedSettingsDigest', 'INVALID_SETTINGS_DIGEST');
  }
  return value;
}

function toCanonicalVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) {
    throw invalid('projectionVersion', 'INVALID_PROJECTION_VERSION');
  }
  return value;
}

export function buildSourceFingerprint(input: SourceFingerprintInput): SourceFingerprint {
  const databaseInstanceId = toCanonicalUuid(input.lineage.databaseInstanceId, 'databaseInstanceId');
  const contentGenerationId = toCanonicalUuid(input.lineage.contentGenerationId, 'contentGenerationId');
  const businessRevision = toCanonicalRevision(input.businessRevision);
  const approvedSettingsDigest = toCanonicalDigest(input.approvedSettingsDigest);
  const businessDate = input.businessDate;
  if (typeof businessDate !== 'string' || !isValidBusinessDate(businessDate)) {
    throw invalid('businessDate', 'INVALID_BUSINESS_DATE');
  }
  const projectionVersion = toCanonicalVersion(input.projectionVersion);
  const canonical = [
    databaseInstanceId,
    contentGenerationId,
    businessRevision,
    approvedSettingsDigest,
    businessDate,
    projectionVersion,
  ].join('\u0000');
  return {
    lineage: { databaseInstanceId, contentGenerationId },
    businessRevision,
    approvedSettingsDigest,
    businessDate,
    projectionVersion,
    canonical,
  };
}

export function sameSourceFingerprint(a: SourceFingerprint, b: SourceFingerprint): boolean {
  return a.canonical === b.canonical;
}

export function isCurrentFingerprint(
  current: SourceFingerprint,
  observed: SourceFingerprintInput,
): boolean {
  return sameSourceFingerprint(current, buildSourceFingerprint(observed));
}

/**
 * 批准显示设置摘要。本切片已批准白名单为空，因此：
 * - 空输入 → shared 规范空摘要（sha256('[]')）；
 * - 任何非空输入 → 拒绝（无已批准 key/value，防止 secret/业务值/未知键进入指纹）。
 */
export function approvedDisplaySettingsDigest(
  settings: ReadonlyArray<readonly [string, string]>,
): string {
  if (settings.length === 0) return CANONICAL_EMPTY_SETTINGS_DIGEST;
  throw new ValidationError('INVALID_SETTINGS', '当前没有已批准的显示设置，不接受任何设置输入');
}

/**
 * Asia/Shanghai 业务日期：经 Intl.DateTimeFormat 具名时区转换，不依赖「该时区恒为
 * UTC+8」的假设（历史上存在夏令时）。入参必须是含偏移或 Z 的严格 ISO 时刻：
 * 先逐分量校验（真实日历日期、hh≤23、mi≤59、ss≤59、偏移 ±00:00~±23:59 或 Z），
 * 再交 Date.parse 处理 Z/带符号偏移/小数秒并断言结果有限。不做「换算后 UTC 分量
 * 与原始本地分量」的比较（带偏移输入二者本就不等，比较会误拒合法输入）。
 */

/** 具名 Asia/Shanghai 日期格式化器（en-CA 提供 yyyy-mm-dd 组件）。 */
export const SHANGHAI_DATE_FORMAT: Intl.DateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

function throwInvalidInstant(): never {
  throw invalid('instantIso', 'INVALID_INSTANT_ISO');
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  const found = parts.find((p) => p.type === type);
  if (!found) throwInvalidInstant();
  return found.value;
}

export function asiaShanghaiBusinessDate(instantIso: string): string {
  if (typeof instantIso !== 'string') throwInvalidInstant();
  const m = INSTANT_RE.exec(instantIso);
  if (!m) throwInvalidInstant();
  const [, yyyy, mo, dd, hh, mi, ss, zone, offH, offM] = m;
  // 严格校验原始分量；Date.parse 负责偏移符号与小数秒。
  if (!isValidBusinessDate(`${yyyy}-${mo}-${dd}`)) throwInvalidInstant();
  const hour = Number(hh);
  const min = Number(mi);
  const sec = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || min > 59 || sec > 59) throwInvalidInstant();
  if (zone !== 'Z') {
    const zh = Number(offH);
    const zm = Number(offM);
    if (zh > 23 || zm > 59) throwInvalidInstant();
  }
  const epochMs = Date.parse(instantIso);
  if (!Number.isFinite(epochMs)) throwInvalidInstant();
  const parts = SHANGHAI_DATE_FORMAT.formatToParts(new Date(epochMs));
  const year = part(parts, 'year').padStart(4, '0');
  return `${year}-${part(parts, 'month')}-${part(parts, 'day')}`;
}
