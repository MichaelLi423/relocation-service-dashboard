/**
 * remote-readonly 值域/边界与校验原语（tasks 1.2/1.3）。
 *
 * - 金额：投影契约传输精确两位小数字符串（"1234.57"/"0.00"），禁止 Number 参与；
 *   金额文本最长 4096 字符（超出拒绝）。
 * - 业务日期：严格 `yyyy-mm-dd`（真实日历日期，含闰年校验），复用 src/domain/core/time。
 * - 审计/技术时间：严格 ISO 8601 带偏移，且必须为真实存在的日历时刻
 *   （拒绝 24:00/60 分/60 秒/2 月 30 日等仅形状匹配的值）。
 * - 校验失败抛 rejection.ts 稳定错误；message/错误属性永不携带字段值（metadata-only，
 *   只含受控字段路径模板，不允许把调用方文本折入 message）。
 * - Unicode 长度：字段按 Unicode 码点计数（`[...str].length`，4096 码点）；
 *   4 KiB UTF-8 游标字节由 mobile-read-v1 层处理（这里只给辅助）。
 * - 本模块不依赖 WorkbenchApi / Electron / 本机 DB。
 */
import { isValidBusinessDate } from '../../domain/core/time';
import { InvalidValueRejection } from './rejection';

/** 经批准的远程业务字段最大 Unicode 码点数（spec 容量：字段 4096 Unicode 字符；自由备注不发布）。 */
export const MAX_REMOTE_FIELD_CHARS = 4096;

/** 读取技术信封 ID 最大字符数（remote-readonly-access：标识符 ≤ 128）。 */
export const MAX_REMOTE_ID_CHARS = 128;

/** 搜索输入最大 Unicode 字符数（remote-readonly-access：≤ 256）。 */
export const MAX_REMOTE_SEARCH_CHARS = 256;

/** 分页游标最大字节数（remote-readonly-access：≤ 4 KiB，UTF-8 字节计）。 */
export const MAX_REMOTE_CURSOR_BYTES = 4 * 1024;

/** 每页固定 20 条（mobile-readonly-workbench 分页/分区有界契约）。 */
export const MOBILE_PAGE_SIZE = 20;

/** 消息只含受控字段路径与固定中文模板；不插值任何调用方文本（防业务值外泄）。 */
function reject(code: string, fieldName: string, template: string): InvalidValueRejection {
  return new InvalidValueRejection(code, `${fieldName} ${template}`);
}

/** Unicode 码点计数（代理对按 1 个字符计）。 */
function codePoints(value: string): number {
  return [...value].length;
}

/** 稳定业务金额格式：非负、可含 0、两位小数（"1234.57"/"0.00"），负数/空拒绝。
 *  整数位至多 4093 位，使整串（含 ".00"）不超过 4096 个 Unicode 码点（spec 字段上限）。 */
const EXACT_CENTS_PATTERN = /^(0|[1-9]\d{0,4092})\.\d{2}$/;

/** 项目区域五固定枚举（mobile-readonly-workbench 区域约束；来自 src/shared/project-fields 同源）。 */
export const REMOTE_PROJECT_REGIONS = ['East', 'South', 'West', 'Central', 'North'] as const;

export type RemoteProjectRegion = (typeof REMOTE_PROJECT_REGIONS)[number];

const REGION_SET: ReadonlySet<string> = new Set<string>(REMOTE_PROJECT_REGIONS);

export function isRemoteRegion(value: string): boolean {
  return REGION_SET.has(value);
}

/** 金额字符串：空（null/undefined）拒绝；必须是精确两位小数格式（至多 4096 字符）。 */
export function assertExactCentsString(value: string | null | undefined, fieldName: string): string {
  if (value === null || value === undefined || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (!EXACT_CENTS_PATTERN.test(value)) {
    throw reject('INVALID_MONEY_FORMAT', fieldName, '必须是精确两位小数字符串');
  }
  return value;
}

/** 业务日期：yyyy-mm-dd 真实日历日期（严格，不得出现时分秒/时区）。 */
export function assertExactBusinessDate(value: string | null | undefined, fieldName: string): string {
  if (value === null || value === undefined || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (!isValidBusinessDate(value)) {
    throw reject('INVALID_DATE', fieldName, '不是真实业务日期（yyyy-mm-dd）');
  }
  return value;
}

/**
 * 审计/技术 ISO 时间（带偏移或 Z）：形状 + 实存校验。
 * 除正则形状外要求真实日历日期、hh≤23、mm/ss≤59、偏移 ±00:00~±23:59（Z 时不得携带
 * 偏移），并经 Date.parse 确认解析为有限时刻。拒绝仅形状匹配的 24:00/60 分/60 秒/
 * 2026-02-30 等。消息不携带字段值。
 */
const ISO_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

function isValidIsoMoment(value: string): boolean {
  const m = ISO_TIME_PATTERN.exec(value);
  if (!m) return false;
  const [, yyyy, mo, dd, hh, mi, ss, zone, offH, offM] = m;
  if (!isValidBusinessDate(`${yyyy}-${mo}-${dd}`)) return false;
  const hour = Number(hh);
  const min = Number(mi);
  const sec = ss === undefined ? 0 : Number(ss);
  if (hour > 23 || min > 59 || sec > 59) return false;
  if (zone !== 'Z') {
    const zh = Number(offH);
    const zm = Number(offM);
    if (zh > 23 || zm > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** 审计/技术 ISO 时间（带偏移或 Z；实存校验；校验失败消息不携带字段值）。 */
export function assertIsoDateTime(value: string | null | undefined, fieldName: string): string {
  if (value === null || value === undefined || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (typeof value !== 'string' || !isValidIsoMoment(value)) {
    throw reject('INVALID_ISO', fieldName, '格式非法（需带偏移且真实存在的 ISO 时间）');
  }
  return value;
}

/** ISO 时间宽松校验（允许 null/undefined：读取信封的可空诊断字段）。 */
export function assertNullableIsoDateTime(value: string | null | undefined, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  return assertIsoDateTime(value, fieldName);
}

/**
 * 技术/审计 ISO 或业务日期的判别：业务时间必须 yyyy-mm-dd，审计/技术时间必须带偏移 ISO。
 * 注意：空串不视为「空」，必填语义下空串同样拒绝（由各自 assert 处理）。
 */
export function assertDateOrIso(value: string | null | undefined, fieldName: string, kind: 'business' | 'iso'): string | null {
  if (value === null || value === undefined) return null;
  if (kind === 'business') return assertExactBusinessDate(value, fieldName);
  return assertIsoDateTime(value, fieldName);
}

/** 标识符长度上限（技术关联 ID 不冒充可读业务编号；≤128 Unicode 码点）。 */
export function assertRemoteId(value: string | null | undefined, fieldName: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || codePoints(value) > MAX_REMOTE_ID_CHARS) {
    throw reject('ID_TOO_LONG', fieldName, '超出长度上限');
  }
  return value;
}

/** 自由文本长度上限：4096 Unicode 码点（任意自由备注不在投影内）。 */
export function assertFieldLength(value: string, fieldName: string): string {
  if (codePoints(value) > MAX_REMOTE_FIELD_CHARS) {
    throw reject('FIELD_TOO_LONG', fieldName, '超出 4096 字符上限');
  }
  return value;
}

/** 可空布尔三元（区分「是/否/未填写」，加载中不得显示为「否」）。 */
export function toNullableBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw reject('INVALID_BOOLEAN', fieldName, '必须是布尔或空');
  }
  return value;
}

/** 严格线协议布尔：必须是 JSON boolean（不接受 0/1 强转）。 */
export function toBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw reject('INVALID_BOOLEAN', fieldName, '必须是布尔');
  }
  return value;
}

/**
 * 必填数字计数（COUNT 结果等）：必须是安全整数、非负。
 * 超出 Number.MAX_SAFE_INTEGER 的计数（含 2^53 精度损失）拒绝。
 */
export function toCount(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw reject('INVALID_COUNT', fieldName, '必须是安全整数计数');
  }
  return value;
}

/** 有界必填文本（非空、Unicode 码点长度上限内；消息不携带字段值）。 */
export function toRequiredText(value: unknown, fieldName: string, max = MAX_REMOTE_FIELD_CHARS): string {
  if (typeof value !== 'string' || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (codePoints(value) > max) {
    throw reject('FIELD_TOO_LONG', fieldName, '超出长度上限');
  }
  return value;
}

/** 可空文本（null/undefined→null；空串→null 保留既有可空语义；超出码点长度拒绝）。 */
export function toOptionalText(value: unknown, fieldName: string, max = MAX_REMOTE_FIELD_CHARS): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw reject('INVALID_TEXT', fieldName, '必须是文本');
  }
  if (value === '') return null;
  if (codePoints(value) > max) {
    throw reject('FIELD_TOO_LONG', fieldName, '超出长度上限');
  }
  return value;
}

/** 固定枚举判别：值必须是枚举成员。 */
export function toEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fieldName: string,
): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw reject('INVALID_ENUM', fieldName, '枚举值不允许');
  }
  return value as T[number];
}

/** 可空精确金额：null/undefined→null；否则必须是非负精确两位小数字符串。 */
export function toNullableExactMoney(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw reject('INVALID_MONEY_FORMAT', fieldName, '必须是精确两位小数字符串');
  }
  return assertExactCentsString(value, fieldName);
}

/** 必填精确金额字符串（非负、两位小数，禁止 Number 强转/截断/舍入）。 */
export function toExactMoney(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw reject('INVALID_MONEY_FORMAT', fieldName, '必须是精确两位小数字符串');
  }
  return assertExactCentsString(value, fieldName);
}

/**
 * 可空业务日期：null/undefined→null（JSON null 是唯一合法「未填写」编码）；
 * 空串不是合法日期值 → 拒绝，不得静默归一为 null（严格契约，wire 必须发 null）。
 */
export function toNullableBusinessDate(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw reject('INVALID_DATE', fieldName, '不是真实业务日期（yyyy-mm-dd）');
  }
  return assertExactBusinessDate(value, fieldName);
}

/** 必填业务日期（yyyy-mm-dd）；空串拒绝（不视为 null）。 */
export function toBusinessDate(value: unknown, fieldName: string): string {
  if (value === null || value === undefined || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (typeof value !== 'string') {
    throw reject('INVALID_DATE', fieldName, '不是真实业务日期（yyyy-mm-dd）');
  }
  return assertExactBusinessDate(value, fieldName);
}

/**
 * 可空 ISO 技术时间：null/undefined→null；空串不视为空——空串在可空 ISO 语义下
 * 也拒绝（不存在合法的空技术时间）；必须带偏移且真实存在。
 */
export function toNullableIso(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw reject('INVALID_ISO', fieldName, '格式非法（需带偏移 ISO 时间）');
  }
  return assertIsoDateTime(value, fieldName);
}

/** 必填 ISO 技术时间（带偏移且真实存在）；空串拒绝。 */
export function toIso(value: unknown, fieldName: string): string {
  if (value === null || value === undefined || value === '') {
    throw reject('REQUIRED_FIELD', fieldName, '必填');
  }
  if (typeof value !== 'string') {
    throw reject('INVALID_ISO', fieldName, '格式非法（需带偏移 ISO 时间）');
  }
  return assertIsoDateTime(value, fieldName);
}
