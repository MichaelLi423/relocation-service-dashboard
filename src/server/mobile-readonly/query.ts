import {
  MOBILE_READONLY_PROJECT_STATUSES,
  MOBILE_READONLY_RECORD_KINDS,
  type MobileReadonlyProject,
  type MobileReadonlyProjectListData,
  type MobileReadonlyProjectRecords,
  type MobileReadonlyProjectSummary,
  type MobileReadonlyQueryPage,
  type MobileReadonlyRecordKind,
  type MobileReadonlyRecordRow,
  type MobileReadonlySnapshot,
} from '../../shared/mobile-readonly';

/**
 * 有界只读查询（design D6 / tasks 7.4）。
 *
 * - 服务端执行搜索/筛选/分页；绝不向手机返回整份快照 JSON、`current.json` 包络或 `snapshot` 全文；
 * - 每页游标绑定当前版本（cursor 内嵌 currentVersion），版本变化后旧游标一律 409 STALE_CURSOR，
 *   并随响应返回当前元数据供手机丢弃旧结果重新加载；
 * - 单页上限与默认值明确：limit 1..100，缺省 50。
 */

/** 单页行数上界。 */
export const MAX_PAGE_LIMIT = 100;
/** 缺省单页行数。 */
export const DEFAULT_PAGE_LIMIT = 50;
/** 游标串长度上界。 */
export const MAX_CURSOR_LENGTH = 512;
/** 查询/筛选参数值长度上界。 */
export const MAX_FILTER_VALUE_LENGTH = 256;

/** 概览响应 data（共享线协议类型；尚未发布 overview 为 null，与已发布空快照区分）。 */
export type { MobileReadonlyOverviewData } from '../../shared/mobile-readonly';

export interface DecodedCursor {
  version: number;
  offset: number;
}

/** 游标 = base64url({v: currentVersion, o: offset})；offset 相对「同版本同筛选」后的稳定列表。 */
export function encodeCursor(version: number, offset: number): string {
  return Buffer.from(JSON.stringify({ v: version, o: offset }), 'utf8').toString('base64url');
}

/** 严格解码游标；格式非法/越界返回 null。 */
export function decodeCursor(raw: string): DecodedCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const version = record.v;
  const offset = record.o;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  return { version, offset };
}

export interface ProjectListQuery {
  /** 搜索关键字（customerName/tempNo/ecc 子串，忽略大小写；空 = 不过滤）。 */
  query: string;
  /** 状态筛选；null = 不过滤。 */
  status: MobileReadonlyProjectSummary['status'] | null;
  /** 区域筛选（trim 后忽略大小写精确匹配）；null = 不过滤。 */
  region: string | null;
  /** 上一页末偏移（来自游标）；null = 首页。 */
  offset: number | null;
  limit: number;
}

function normalizeText(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function matchesSearch(project: MobileReadonlyProject, keyword: string): boolean {
  if (keyword.length === 0) return true;
  const kw = normalizeText(keyword);
  if (normalizeText(project.customerName).includes(kw)) return true;
  if (normalizeText(project.tempNo).includes(kw)) return true;
  return project.ecc !== null && normalizeText(project.ecc).includes(kw);
}

function matchesFilters(project: MobileReadonlyProject, status: MobileReadonlyProjectSummary['status'] | null, region: string | null): boolean {
  if (status !== null && project.status !== status) return false;
  if (region === null) return true;
  if (project.region === null) return false;
  return normalizeText(project.region) === normalizeText(region);
}

/** 挑出项目行（不含 records，绝不外发 records 全文）。 */
function toProjectSummary(project: MobileReadonlyProject): MobileReadonlyProjectSummary {
  return {
    id: project.id,
    tempNo: project.tempNo,
    ecc: project.ecc,
    customerName: project.customerName,
    status: project.status,
    region: project.region,
    regionNeedsAdjustment: project.regionNeedsAdjustment,
    entryAt: project.entryAt,
    planVisitAt: project.planVisitAt,
    finalAmount: project.finalAmount,
    invoicedAmount: project.invoicedAmount,
    contractAmount: project.contractAmount,
    formallyEntered: project.formallyEntered,
    preEntryExecution: project.preEntryExecution,
  };
}

function toPage<T>(items: readonly T[], offset: number, limit: number, version: number, total: number): MobileReadonlyQueryPage<T> {
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const nextCursor = nextOffset < total ? encodeCursor(version, nextOffset) : null;
  return { items: pageItems, nextCursor };
}

/** 项目搜索/筛选/分页（仅当前版本快照内执行）。 */
export function buildProjectListPage(
  snapshot: MobileReadonlySnapshot | null,
  currentVersion: number,
  query: ProjectListQuery,
): MobileReadonlyProjectListData {
  if (snapshot === null) return { items: [], nextCursor: null };
  const offset = query.offset ?? 0;
  const filtered: MobileReadonlyProject[] = [];
  for (const project of snapshot.projects) {
    if (!matchesSearch(project, query.query)) continue;
    if (!matchesFilters(project, query.status, query.region)) continue;
    filtered.push(project);
  }
  const items = filtered.map(toProjectSummary);
  return toPage(items, offset, query.limit, currentVersion, filtered.length);
}

/** 项目详情（id 精确匹配；未命中返回 project:null；不含 records）。 */
export function buildProjectDetail(snapshot: MobileReadonlySnapshot | null, projectId: string): { project: MobileReadonlyProjectSummary | null } {
  if (snapshot === null) return { project: null };
  const project = snapshot.projects.find((p) => p.id === projectId);
  return { project: project === undefined ? null : toProjectSummary(project) };
}

export interface RecordsQuery {
  projectId: string;
  kind: MobileReadonlyRecordKind;
  offset: number | null;
  limit: number;
}

function recordsOf(project: MobileReadonlyProject, kind: MobileReadonlyRecordKind): readonly MobileReadonlyRecordRow[] {
  const records: MobileReadonlyProjectRecords = project.records;
  switch (kind) {
    case 'batches':
      return records.batches;
    case 'instruments':
      return records.instruments;
    case 'activities':
      return records.activities;
    case 'orders':
      return records.orders;
    case 'invoices':
      return records.invoices;
    case 'damage_items':
      return records.damage_items;
  }
}

/** 单项目单 kind 关联记录分页（projectId/kind 非法即空页；kind 枚举已在 HTTP 层校验）。 */
export function buildRecordsPage(
  snapshot: MobileReadonlySnapshot | null,
  currentVersion: number,
  query: RecordsQuery,
): { kind: MobileReadonlyRecordKind; items: readonly MobileReadonlyRecordRow[]; nextCursor: string | null } {
  if (snapshot === null) return { kind: query.kind, items: [], nextCursor: null };
  const project = snapshot.projects.find((p) => p.id === query.projectId);
  if (project === undefined) return { kind: query.kind, items: [], nextCursor: null };
  const rows = recordsOf(project, query.kind);
  const page = toPage(rows, query.offset ?? 0, query.limit, currentVersion, rows.length);
  return { kind: query.kind, items: page.items, nextCursor: page.nextCursor };
}

/** 合法状态筛选值集合（供 HTTP 层校验 status 参数）。 */
export const MOBILE_READONLY_FILTERABLE_STATUSES: readonly string[] = [...MOBILE_READONLY_PROJECT_STATUSES];

/** 合法记录 kind 值集合（供 HTTP 层校验 kind 参数）。 */
export const MOBILE_READONLY_QUERYABLE_KINDS: readonly string[] = [...MOBILE_READONLY_RECORD_KINDS];
