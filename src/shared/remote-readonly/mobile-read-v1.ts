/**
 * mobile-read-v1 独立移动读取线协议（tasks 1.2，design 决策 2）。
 *
 * - 手机不经 Electron IPC，使用本独立只读契约；绝不暴露整个 WorkbenchApi。
 * - 读取一律绑定快照上下文：列表/详情/分区请求必须携带 `snapshotId` +
 *   `activationId`（decimal string，与投影 `RemoteEnvelope` 同类型）；cursor 只绑定
 *   该上下文 + 筛选 + 排序。概览是唯一无上下文入口（用于发现「当前」快照），
 *   显式刷新获得新上下文后再发起后续 pinned 读取。无 HTTP/URL/路由决策。
 * - 结果统一为投影层已含 `RemoteEnvelope` 的 DTO：概览→RemoteOverviewDto、
 *   列表→RemoteProjectPageDto（page: RemotePagingMeta）、分区→RemoteSectionPageDto、
 *   详情→RemoteProjectDetailDto。不再保留与本 DTO 互不兼容的扁平 result 副本。
 * - 分页固定每页 20；概览仅五键指标。搜索仅客户名称/ECC/临时编号。
 * - 区域筛选只允许五固定枚举或 null（「全部」）；「未填写/待调整」不能单独筛选。
 * - 排序仅最近更新 updatedAt DESC、planVisitAt ASC、planVisitAt DESC；空日期置后。
 * - 边界：query ≤ 256 Unicode 码点；projectId/snapshotId/activationId ≤ 128 码点；
 *   cursor ≤ 4 KiB UTF-8 字节（TextEncoder，浏览器/Node 通用，不引入 Buffer 或
 *   node:crypto）。计数/金额不做 Number 强转。
 * - 本模块为逻辑契约层：不含 HTTP/路由、持久化、认证或本机 DB，也不导入
 *   WorkbenchApi/Electron；后续云端 read service 在该契约下实现 bounded 查询。
 *
 * ## 迁移（相对旧 unpinned 原语）
 * - `normalizeProjectQuery` → `normalizeProjectListRequest`（现在必须携带
 *   snapshotId/activationId；region/status/sort/query/cursor 语义不变）。
 * - `normalizeSectionQuery` → `normalizeSectionRequest`（必须携带上下文）。
 * - `normalizeProjectIdParam` → `normalizeDetailRequest`（上下文 + projectId）。
 * - `MobileOverviewResult`/`MobileProjectListResult`/`MobileSectionResult` 现在是
 *   投影 DTO 的类型别名（携带 envelope + page），不再有扁平 total/nextCursor 等。
 * - 旧 unpinned 调用不保留静默 fallback：缺上下文在规范化入口显式拒绝。
 */
import {
  REMOTE_PROJECT_REGIONS,
  MAX_REMOTE_ID_CHARS,
  MAX_REMOTE_SEARCH_CHARS,
  MAX_REMOTE_CURSOR_BYTES,
  MOBILE_PAGE_SIZE,
  type RemoteProjectRegion,
} from './values';
import type {
  RemoteOverviewDto,
  RemoteProjectPageDto,
  RemoteSectionPageDto,
  RemoteProjectDetailDto,
  RemoteSectionKind,
} from './projection';
import { InvalidValueRejection, UnknownFieldRejection, rejectionField } from './rejection';

/** mobile-read-v1 线协议版本标识。 */
export const MOBILE_READ_V1 = 'mobile-read-v1';

/** 概览指标键（只含五键；不含阶段平均时间/提醒统计/预览）。 */
export const OVERVIEW_METRIC_KEYS = [
  'totalProjects',
  'activeProjects',
  'pendingAcceptance',
  'pendingInvoice',
  'pendingAmount',
] as const;
export type OverviewMetricKey = (typeof OVERVIEW_METRIC_KEYS)[number];

export const REMOTE_PROJECT_STATUS_FILTERS = [
  'pending_entry',
  'pending_execution',
  'executing',
  'under_repair',
  'pending_acceptance',
  'pending_invoice',
  'completed',
  'cancelled',
] as const;
export type RemoteProjectStatusFilter = (typeof REMOTE_PROJECT_STATUS_FILTERS)[number];

export const MOBILE_PROJECT_SORTS = ['updated', 'plan_visit_asc', 'plan_visit_desc'] as const;
export type MobileProjectSort = (typeof MOBILE_PROJECT_SORTS)[number];

export type MobileRegionFilter = RemoteProjectRegion | null;

export const PROJECT_SORT_DEFAULT: MobileProjectSort = 'updated';

/** mobile-read-v1 固定的页面容量声明。 */
export const MOBILE_READ_PAGE_SIZE = MOBILE_PAGE_SIZE;

/** 只读技术信封键（diagnostic；供手机展示数据生成/发布/来源确认时间）。 */
export const MOBILE_ENVELOPE_KEYS = [
  'snapshotId',
  'activationId',
  'businessRevision',
  'generatedAt',
  'lastPublishedAt',
  'lastSourceSeenAt',
  'sourceConfirmedAt',
] as const;

// ---------------------------------------------------------------------------
// 快照上下文：列表/详情/分区 pinned 读取必须显式携带
// ---------------------------------------------------------------------------

/**
 * Pinned 读取上下文：客户端整视图固定同一 (snapshotId, activationId)。
 * `activationId` 为 decimal string（与投影 `RemoteEnvelope.activationId` 一致）。
 * 概览返回 `RemoteOverviewDto`（含本上下文）用于发现当前快照；显式刷新重新获取。
 */
export interface MobilePinnedContext {
  snapshotId: string;
  activationId: string;
}

export const MOBILE_CONTEXT_FIELDS: readonly string[] = ['snapshotId', 'activationId'];

// ---------------------------------------------------------------------------
// 结果：统一到投影层 RemoteEnvelope-bearing DTO（单一规范形状）
// ---------------------------------------------------------------------------

/** 概览结果 = 技术信封 + 五键指标（同 RemoteOverviewDto）。 */
export type MobileOverviewResult = RemoteOverviewDto;
/** 项目列表结果 = 信封 + projects（RemoteProjectRow）+ page（RemotePagingMeta）。 */
export type MobileProjectListResult = RemoteProjectPageDto;
/** 项目详情结果 = 信封 + project + detail（同 RemoteProjectDetailDto）。 */
export type MobileProjectDetailResult = RemoteProjectDetailDto;
/** 分区页结果 = 信封 + kind/projectId + rows + page（同 RemoteSectionPageDto）。 */
export type MobileSectionResult = RemoteSectionPageDto;

export const SECTION_KIND_VALUES: readonly RemoteSectionKind[] = [
  'batches',
  'instruments',
  'orders',
  'invoices',
  'damage_items',
];

// ---------------------------------------------------------------------------
// 稳定错误码（mobile-readonly-workbench 读取技术信封引用）。
// ---------------------------------------------------------------------------

export const MOBILE_READ_ERROR_CODES = {
  SNAPSHOT_EXPIRED: 'SNAPSHOT_EXPIRED',
  UNKNOWN_QUERY: 'UNKNOWN_QUERY',
  QUERY_TOO_LONG: 'QUERY_TOO_LONG',
  ID_TOO_LONG: 'ID_TOO_LONG',
  CURSOR_TOO_LARGE: 'CURSOR_TOO_LARGE',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
} as const;

export type MobileReadErrorCode = (typeof MOBILE_READ_ERROR_CODES)[keyof typeof MOBILE_READ_ERROR_CODES];

// ---------------------------------------------------------------------------
// 请求逻辑类型（无上下文 = 仅概览可发现当前；pinned 读取必须带上下文）
// ---------------------------------------------------------------------------

/** 概览请求：空对象（无查询参数；用于发现当前 snapshotId/activationId）。 */
export type MobileOverviewRequest = Record<string, never>;

/** 项目列表请求（原始入参；snapshotId/activationId 必填 = pinned 读取）。 */
export interface MobileProjectListRequest extends MobilePinnedContext {
  /** 客户名称 / ECC / 临时编号（≤ 256 Unicode 码点）。 */
  query?: string | null;
  /** 单主状态筛选。 */
  status?: RemoteProjectStatusFilter | null;
  /** 区域：null=「全部」（含未填写与待调整项目）。 */
  region?: MobileRegionFilter;
  /** 排序（缺省 updated）。 */
  sort?: MobileProjectSort | null;
  /** 上一页 nextCursor（首页为空）。 */
  cursor?: string | null;
}

/** 项目详情请求（pinned）：上下文 + projectId。 */
export interface MobileDetailRequest extends MobilePinnedContext {
  projectId: string;
}

/** 分区请求（pinned）：上下文 + projectId + kind + 可选 cursor。 */
export interface MobileSectionRequest extends MobilePinnedContext {
  projectId: string;
  kind: RemoteSectionKind;
  /** 上一页 nextCursor（首页为空）。 */
  cursor?: string | null;
}

/** 规范化后项目列表请求（默认值已填充；含 pinned 上下文）。 */
export interface NormalizedProjectListRequest extends MobilePinnedContext {
  query: string | null;
  status: RemoteProjectStatusFilter | null;
  region: MobileRegionFilter;
  sort: MobileProjectSort;
  cursor: string | null;
}

/** 规范化后详情请求。 */
export interface NormalizedDetailRequest extends MobilePinnedContext {
  projectId: string;
}

/** 规范化后分区请求。 */
export interface NormalizedSectionRequest extends MobilePinnedContext {
  projectId: string;
  kind: RemoteSectionKind;
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// allowlist（未知/未批准参数一律 metadata-only 拒绝）
// ---------------------------------------------------------------------------

export const OVERVIEW_REQUEST_ALLOWED_FIELDS: readonly string[] = [];
export const PROJECT_LIST_REQUEST_ALLOWED_FIELDS: readonly string[] = [
  ...MOBILE_CONTEXT_FIELDS,
  'query',
  'status',
  'region',
  'sort',
  'cursor',
];
export const DETAIL_REQUEST_ALLOWED_FIELDS: readonly string[] = [...MOBILE_CONTEXT_FIELDS, 'projectId'];
export const SECTION_REQUEST_ALLOWED_FIELDS: readonly string[] = [
  ...MOBILE_CONTEXT_FIELDS,
  'projectId',
  'kind',
  'cursor',
];

// ---------------------------------------------------------------------------
// 规范化与校验（未知条件拒绝；错误 metadata-only，不预加载完整快照）
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!(allowed as readonly string[]).includes(key)) {
      // 未知键名/值不进入错误属性（rejection.ts 受控上下文 + metadata-only）。
      throw new UnknownFieldRejection(rejectionField(context, key));
    }
  }
}

/** Unicode 码点计数（代理对按 1 个字符计，符合「≤ 256 Unicode 字符」规格）。 */
function codePoints(value: string): number {
  return [...value].length;
}

/** UTF-8 字节长度（浏览器/Node 通用 TextEncoder；不引入 Buffer/node:crypto）。 */
function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/** 受控标识符校验：非空、≤ 128 Unicode 码点（snapshotId/activationId/projectId 共用）。 */
function normalizeIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidValueRejection('REQUIRED_FIELD', `${fieldName} 必填`);
  }
  if (codePoints(value) > MAX_REMOTE_ID_CHARS) {
    throw new InvalidValueRejection('ID_TOO_LONG', `${fieldName} 超出 128 字符上限`);
  }
  return value;
}

/** 从同一入参对象中提取并校验 pinned 上下文。 */
function requirePinnedContext(record: Record<string, unknown>): MobilePinnedContext {
  return {
    snapshotId: normalizeIdentifier(record['snapshotId'], 'snapshotId'),
    activationId: normalizeIdentifier(record['activationId'], 'activationId'),
  };
}

/** 概览请求校验：仅允许空对象（无上下文入口；用于发现当前快照上下文）。 */
export function normalizeOverviewRequest(input: unknown): MobileOverviewRequest {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '概览请求必须是对象');
  }
  rejectUnknownKeys(input, OVERVIEW_REQUEST_ALLOWED_FIELDS, 'mobile-read-v1.query');
  return {};
}

function normalizeSearchQuery(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new InvalidValueRejection('QUERY_NOT_TEXT', '搜索条件必须是文本');
  }
  if (codePoints(value) > MAX_REMOTE_SEARCH_CHARS) {
    throw new InvalidValueRejection('QUERY_TOO_LONG', '搜索条件超出 256 字符上限');
  }
  return value;
}

function normalizeCursor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new InvalidValueRejection('CURSOR_NOT_TEXT', '游标必须是文本');
  }
  if (utf8ByteLength(value) > MAX_REMOTE_CURSOR_BYTES) {
    throw new InvalidValueRejection('CURSOR_TOO_LARGE', '游标超出 4 KiB 上限');
  }
  return value;
}

function normalizeStatus(value: unknown): RemoteProjectStatusFilter | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !(REMOTE_PROJECT_STATUS_FILTERS as readonly string[]).includes(value)) {
    throw new InvalidValueRejection('INVALID_ENUM', '主状态筛选值不允许');
  }
  return value as RemoteProjectStatusFilter;
}

function normalizeRegion(value: unknown): MobileRegionFilter {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !(REMOTE_PROJECT_REGIONS as readonly string[]).includes(value)) {
    throw new InvalidValueRejection('INVALID_REGION', '区域筛选只允许五个固定枚举或全部');
  }
  return value as RemoteProjectRegion;
}

function normalizeSort(value: unknown): MobileProjectSort {
  if (value === null || value === undefined || value === '') return PROJECT_SORT_DEFAULT;
  if (typeof value !== 'string' || !(MOBILE_PROJECT_SORTS as readonly string[]).includes(value)) {
    throw new InvalidValueRejection('INVALID_ENUM', '排序方式不允许');
  }
  return value as MobileProjectSort;
}

/** 规范化并校验项目列表请求（pinned：snapshotId + activationId 必填）。 */
export function normalizeProjectListRequest(input: unknown): NormalizedProjectListRequest {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '列表请求必须是对象');
  }
  rejectUnknownKeys(input, PROJECT_LIST_REQUEST_ALLOWED_FIELDS, 'mobile-read-v1.query');
  const context = requirePinnedContext(input);
  return {
    ...context,
    query: normalizeSearchQuery(input['query']),
    status: normalizeStatus(input['status']),
    region: normalizeRegion(input['region']),
    sort: normalizeSort(input['sort']),
    cursor: normalizeCursor(input['cursor']),
  };
}

/** 规范化并校验项目详情请求（pinned：上下文 + projectId ≤ 128 码点）。 */
export function normalizeDetailRequest(input: unknown): NormalizedDetailRequest {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '详情请求必须是对象');
  }
  rejectUnknownKeys(input, DETAIL_REQUEST_ALLOWED_FIELDS, 'mobile-read-v1.detail');
  const context = requirePinnedContext(input);
  return {
    ...context,
    projectId: normalizeIdentifier(input['projectId'], 'projectId'),
  };
}

/** 规范化并校验分区请求（pinned：上下文 + projectId + kind + cursor）。 */
export function normalizeSectionRequest(input: unknown): NormalizedSectionRequest {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '分区请求必须是对象');
  }
  rejectUnknownKeys(input, SECTION_REQUEST_ALLOWED_FIELDS, 'mobile-read-v1.section');
  const context = requirePinnedContext(input);
  const kindRaw = input['kind'];
  if (typeof kindRaw !== 'string' || !(SECTION_KIND_VALUES as readonly string[]).includes(kindRaw)) {
    throw new InvalidValueRejection('INVALID_ENUM', '分区类型不允许');
  }
  return {
    ...context,
    projectId: normalizeIdentifier(input['projectId'], 'projectId'),
    kind: kindRaw as RemoteSectionKind,
    cursor: normalizeCursor(input['cursor']),
  };
}
