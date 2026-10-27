import type { ProjectStatus } from './ipc';

/**
 * 移动只读发布共享契约（openspec change `add-mobile-readonly-publication`）。
 *
 * 本模块是桌面端/云端服务/手机只读入口三方共用的**纯 TS** 契约层：
 * - 不 import node 内建模块，不发起任何网络请求，不依赖领域/持久化模块；
 * - v1 保留原封闭字段白名单；v2 仅扩充明确授权的联系人、地址、提醒及业务事实，
 *   其他自由备注/原因仍禁止，任何表外/嵌套未知 key 一律非法；
 * - 金额字段一律为主单位**固定两位小数字符串**（源为分整数 BigInt 经 `formatCents` 输出，如
 *   `"1234.57"`/`"0.00"`/`"-12.34"`）。发布/手机链路禁止再次除以 100 或转 Number（`formatCents`
 *   自身的分→主单位格式化除外），本模块的校验也绝不以 Number 解析金额；
 * - 业务日期一律 `yyyy-mm-dd`（真实日历日期）；快照头部 `dataAsOf` 为带偏移 ISO 审计时间；
 *   不导出任何业务记录内的审计/技术 ISO 时间。
 *
 * 分层说明（design D3/D6）：`snapshot`（业务白名单快照）与 `protocol`
 * （`publicationId`/`expectedCurrentVersion`）分层校验，互相不触发 unknown-key；
 * 服务端存储包络的 `currentVersion`/`publicationId`/`publishedAt` 属于信封层，不属于业务快照白名单。
 */

/** 当前快照格式版本（schemaVersion）。未知版本一律拒绝。 */
export const MOBILE_READONLY_SCHEMA_VERSION = 2;

/** 六类关联记录 kind（与 `WorkbenchV2SectionKind` 顺序一致；JSON 容器键含 `damage_items`）。 */
export const MOBILE_READONLY_RECORD_KINDS = [
  'batches',
  'instruments',
  'activities',
  'orders',
  'invoices',
  'damage_items',
] as const;
export type MobileReadonlyRecordKind = (typeof MOBILE_READONLY_RECORD_KINDS)[number];

/** 项目主状态（与桌面 `ProjectStatus` 同枚举；含终态 cancelled 与 transferred 及 under_repair）。 */
export const MOBILE_READONLY_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'pending_entry',
  'pending_execution',
  'executing',
  'under_repair',
  'pending_acceptance',
  'pending_invoice',
  'completed',
  'cancelled',
  'transferred',
] as const;

/** 开单类型四枚举（同 `service_orders.order_type`）。 */
export const MOBILE_READONLY_ORDER_TYPES = ['relocation', 'certification', 'parts_by_mail', 'pm'] as const;
export type MobileReadonlyOrderType = (typeof MOBILE_READONLY_ORDER_TYPES)[number];

/** 备件币种受控值（USD/RMB），与 `damage_repair_items.part_currency` 一致。 */
export const MOBILE_READONLY_PART_CURRENCIES = ['USD', 'RMB'] as const;
export type MobileReadonlyPartCurrency = (typeof MOBILE_READONLY_PART_CURRENCIES)[number];

/** 与 damage_repair_items.part_status CHECK 及领域 PART_STATUSES 一致。 */
export const MOBILE_READONLY_PART_STATUSES = ['pending_submit', 'processing', 'arrived', 'used'] as const;
export type MobileReadonlyPartStatus = (typeof MOBILE_READONLY_PART_STATUSES)[number];

// ---------------------------------------------------------------------------
// 快照业务类型（封闭白名单的逐字段形状；空集合合法，见 design D10）
// ---------------------------------------------------------------------------

export interface MobileReadonlyOverviewMetrics {
  reminderCount?: number;
  reminderOverdue?: number;
  reminderToday?: number;
  openRepairProjects?: number;
  /** OverviewDto.metrics.totalProjects 项目总数。 */
  totalProjects: number;
  /** OverviewDto.metrics.activeProjects 活跃项目数（未完成、未取消且未转单）。 */
  activeProjects: number;
  /** OverviewDto.metrics.pendingAmount 待掉票金额（主单位固定两位小数字符串，`"0.00"` 合法）。 */
  pendingAmount: string;
  /** OverviewDto.metrics.pendingAcceptance 待验收计数。 */
  pendingAcceptance: number;
  /** OverviewDto.metrics.pendingInvoice 待掉票计数。 */
  pendingInvoice: number;
}

export interface MobileReadonlyStageSummary {
  status: ProjectStatus;
  count: number;
  /** 阶段平均停留天数（快照时刻派生；可为小数）。 */
  averageDays: number;
}

export interface MobileReadonlyOverview {
  metrics: MobileReadonlyOverviewMetrics;
  stages: readonly MobileReadonlyStageSummary[];
}

/** 批次记录（whitelist：id/planTransportDate/transportCompany/startedAt/appliedAt）。 */
export interface MobileReadonlyBatchRecord {
  id: string;
  /** 计划运输日期（业务日期 yyyy-mm-dd，可空）。 */
  planTransportDate: string | null;
  /** 运输公司展示。 */
  transportCompany: string | null;
  /** 开始运输日期（业务日期 yyyy-mm-dd，可空）。 */
  startedAt: string | null;
  /** 物流费用登记日期（业务日期 yyyy-mm-dd，可空）。 */
  appliedAt: string | null;
}

/** 仪器记录（whitelist：id/name/model/serialNo/ups）。 */
export interface MobileReadonlyInstrumentRecord {
  manufacturer?: string | null;
  serviceLevel?: string | null;
  qrRequested?: boolean;
  id: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  /** UPS 标记。 */
  ups: boolean;
}

/** 上门活动记录（whitelist：id/visitAt/engineers）。 */
export interface MobileReadonlyActivityRecord {
  id: string;
  /** 到访日期（业务日期 yyyy-mm-dd，可空）。 */
  visitAt: string | null;
  /** 参与工程师文本（可空为空串）。 */
  engineers: string;
}

/** 开单记录（whitelist：id/orderType/serviceOrderNo/orderedAt/engineer）。 */
export interface MobileReadonlyOrderRecord {
  customerName?: string;
  id: string;
  orderType: MobileReadonlyOrderType;
  serviceOrderNo: string | null;
  /** 开单日期（业务日期 yyyy-mm-dd，非空）。 */
  orderedAt: string;
  engineer: string | null;
}

/** 掉票记录（whitelist：id/amount/invoicedAt/active/revokedAt）。 */
export interface MobileReadonlyInvoiceRecord {
  id: string;
  /** 掉票金额（主单位固定两位小数字符串，非空）。 */
  amount: string;
  /** 掉票日期（业务日期 yyyy-mm-dd，非空）。 */
  invoicedAt: string;
  /** 有效（未撤销）/ 已撤销状态。 */
  active: boolean;
  /** 撤销日期（业务日期 yyyy-mm-dd，可空）。 */
  revokedAt: string | null;
}

/** 损坏/维修事项记录（whitelist：id/instrumentName/serialNo/issueStatus/partNumber/partQuantity/partAmount/partCurrency/registeredAt）。 */
export interface MobileReadonlyDamageItemRecord {
  partStatus?: MobileReadonlyPartStatus | null;
  id: string;
  /** 关联仪器名称。 */
  instrumentName: string;
  serialNo: string | null;
  /** 事项处理状态展示。 */
  issueStatus: string;
  partNumber: string;
  partQuantity: number;
  /** 备件金额（主单位固定两位小数字符串，非空；DTO 零值默认 `"0.00"`）。 */
  partAmount: string;
  partCurrency: MobileReadonlyPartCurrency | null;
  /** 登记日期（业务日期 yyyy-mm-dd，非空）。 */
  registeredAt: string;
}

export type MobileReadonlyRecordRow =
  | MobileReadonlyBatchRecord
  | MobileReadonlyInstrumentRecord
  | MobileReadonlyActivityRecord
  | MobileReadonlyOrderRecord
  | MobileReadonlyInvoiceRecord
  | MobileReadonlyDamageItemRecord;

/** 项目关联记录容器（六类均以数组键存在；无记录为空数组，键必填）。 */
export interface MobileReadonlyProjectRecords {
  batches: readonly MobileReadonlyBatchRecord[];
  instruments: readonly MobileReadonlyInstrumentRecord[];
  activities: readonly MobileReadonlyActivityRecord[];
  orders: readonly MobileReadonlyOrderRecord[];
  invoices: readonly MobileReadonlyInvoiceRecord[];
  damage_items: readonly MobileReadonlyDamageItemRecord[];
}

/**
 * 项目行（列表/详情共用字段；白名单见 design.md:154-175）。
 * 云服务对手机返回项目行/详情时**不携带 records**（见 MobileReadonlyProjectDetailData）。
 */
export interface MobileReadonlyProjectSummary {
  reminderAt?: string | null;
  reminderDueClass?: 'upcoming' | 'today' | 'overdue' | null;
  groupedTags?: readonly { groupId: string; groupName: string; tagIds: readonly string[]; tagNames: readonly string[] }[];
  id: string;
  tempNo: string;
  ecc: string | null;
  customerName: string;
  status: ProjectStatus;
  region: string | null;
  regionNeedsAdjustment: boolean;
  /** 进单日期（业务日期 yyyy-mm-dd，可空）。 */
  entryAt: string | null;
  /** 计划上门日期（业务日期 yyyy-mm-dd，可空）。 */
  planVisitAt: string | null;
  /** 最终可确认金额（主单位两位小数字符串，可空）。 */
  finalAmount: string | null;
  /** 累计有效掉票（主单位两位小数字符串，非空）。 */
  invoicedAmount: string;
  /** 合同金额（主单位两位小数字符串，可空）。 */
  contractAmount: string | null;
  formallyEntered: boolean;
  preEntryExecution: boolean;
}

/** v2 授权详情；null 表示源未填写，不包含任何其他自由备注/原因。 */
export interface MobileReadonlyProjectDetailFields {
  oldSiteContact: string | null;
  newSiteContact: string | null;
  oldSiteAddress: string | null;
  newSiteAddress: string | null;
  temporaryStorageAddress: string | null;
  isTemporaryStorage: boolean | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  planTransportAt: string | null;
  plannedInstallAt: string | null;
  actualInstallDoneAt: string | null;
  acceptanceReportDate: string | null;
  cancelledAt: string | null;
  siteConfirmed: boolean;
  acceptanceReport: boolean;
  temporaryInstrumentCount: number | null;
  temporaryInstrumentName: string | null;
  temporaryInstrumentModel: string | null;
  temporaryHasUps: boolean | null;
  reminderNote: string | null;
}

/** 快照内的项目（v1 无 detail，v2 必填；全部六类关联记录）。 */
export interface MobileReadonlyProject extends MobileReadonlyProjectSummary {
  detail?: MobileReadonlyProjectDetailFields;
  records: MobileReadonlyProjectRecords;
}

/**
 * 一致只读快照（design D1/D10）。
 * 顶部捕获 contentGenerationId/businessRevision（同代际修订指纹）与 dataAsOf
 * （单事务一致读取建立时刻，带偏移 ISO）；空集合（overview 全零 + projects: []）合法。
 */
export interface MobileReadonlySnapshot {
  schemaVersion: number;
  contentGenerationId: string;
  businessRevision: number;
  /** 数据截至时间：单事务一致读取建立时刻（ISO）。 */
  dataAsOf: string;
  overview: MobileReadonlyOverview;
  projects: readonly MobileReadonlyProject[];
}

/** 桌面只生成 v2；兼容读取类型的可选字段在生成侧全部必填。 */
export type MobileReadonlySnapshotV2 = Omit<MobileReadonlySnapshot, 'schemaVersion' | 'overview' | 'projects'> & {
  schemaVersion: 2;
  overview: Omit<MobileReadonlyOverview, 'metrics'> & { metrics: Required<MobileReadonlyOverviewMetrics> };
  projects: readonly (Required<MobileReadonlyProjectSummary> & {
    detail: MobileReadonlyProjectDetailFields;
    records: Omit<MobileReadonlyProjectRecords, 'instruments' | 'orders' | 'damage_items'> & {
      instruments: readonly Required<MobileReadonlyInstrumentRecord>[];
      orders: readonly Required<MobileReadonlyOrderRecord>[];
      damage_items: readonly Required<MobileReadonlyDamageItemRecord>[];
    };
  })[];
};

// ---------------------------------------------------------------------------
// 上传/信封/元数据线协议（design D3/D6；protocol 与 snapshot 分层）
// ---------------------------------------------------------------------------

/** 变化检测指纹：仅做相等比较（同代际 businessRevision 相等；contentGenerationId 轮换视为变化）。 */
export interface MobileReadonlyFingerprint {
  contentGenerationId: string;
  businessRevision: number;
}

/** 上传请求 protocol 层（协议字段，不进业务白名单 unknown-key 判定）。 */
export interface MobileReadonlyUploadProtocol {
  publicationId: string;
  expectedCurrentVersion: number;
}

/** 上传请求体：{protocol, snapshot} 分层。 */
export interface MobileReadonlyUploadBody {
  protocol: MobileReadonlyUploadProtocol;
  snapshot: MobileReadonlySnapshot;
}

/** 服务端存储包络（snapshots/current.json；信封字段不属于业务快照白名单）。 */
export interface MobileReadonlyPublishEnvelope {
  currentVersion: number;
  publicationId: string;
  /** 服务端成功接收快照的时刻（独立于快照头部 dataAsOf）。 */
  publishedAt: string;
  snapshot: MobileReadonlySnapshot;
}

/** 版本元数据（/api/meta 与全部业务响应的 metadata 载体）。 */
export interface MobileReadonlyPublishMetadata {
  /** 旧服务缺失=未知；新服务未发布=null，已发布=实际快照版本。 */
  snapshotSchemaVersion?: number | null;
  /** true = 已成功发布（含合法空集合快照）；false = 尚未发布（无文件、无版本 0）。 */
  published: boolean;
  /** 当前发布版本；尚未发布时逻辑版本 0（不落文件）。 */
  currentVersion: number;
  publicationId: string | null;
  publishedAt: string | null;
  /** 快照头部 dataAsOf；尚未发布为 null。 */
  dataAsOf: string | null;
  fingerprint: MobileReadonlyFingerprint | null;
}

/** 尚未发布的逻辑元数据（服务端从未成功接收时返回；不创建「版本 0」文件）。 */
export const UNPUBLISHED_MOBILE_READONLY_METADATA: MobileReadonlyPublishMetadata = Object.freeze({
  published: false,
  currentVersion: 0,
  publicationId: null,
  publishedAt: null,
  dataAsOf: null,
  fingerprint: null,
  snapshotSchemaVersion: null,
});

/**
 * 有界分页（云端服务对手机返回，服务端执行搜索/筛选/分页，不向手机下发整份快照 JSON）。
 * 项目行/详情与记录均排除 records 全文；记录经独立按 kind 端点分页返回。
 */
export interface MobileReadonlyQueryPage<TItem> {
  total?: number;
  items: readonly TItem[];
  nextCursor: string | null;
}

export type MobileReadonlyProjectListData = MobileReadonlyQueryPage<MobileReadonlyProjectSummary>;

export interface MobileReadonlyProjectDetailData {
  project: (MobileReadonlyProjectSummary & { detail?: MobileReadonlyProjectDetailFields }) | null;
  recordCounts?: Record<MobileReadonlyRecordKind, number>;
}

export interface MobileReadonlyRecordsPage {
  total?: number;
  kind: MobileReadonlyRecordKind;
  items: readonly MobileReadonlyRecordRow[];
  nextCursor: string | null;
}

/**
 * 业务查询响应载体：metadata（当前版本 + dataAsOf/publishedAt，手机据此做版本检查，
 * 版本检查走 Basic-Auth 概览端点而非 upload-only /meta）携带 data。
 * 规划端点：GET /api/overview、/api/projects?query&status&region&cursor&limit、
 * /api/project?id、/api/records?projectId&kind&cursor&limit。
 */
export interface MobileReadonlyQueryResponse<TData> {
  metadata: MobileReadonlyPublishMetadata;
  data: TData;
}

/**
 * 概览查询的 data 载体。`overview` 为 null 仅表示「尚未发布」（从未成功接收快照）；
 * 已发布空集合快照返回全零 `MobileReadonlyOverview`，两者不得混淆（design D10）。
 */
export interface MobileReadonlyOverviewData {
  overview: MobileReadonlyOverview | null;
}

/** 上传（PUT /api/publish）响应结果（200 提交/幂等，409 冲突；均携带当前元数据）。 */
export type MobileReadonlyPublishResultKind = 'committed' | 'idempotent' | 'conflict';

/** PUT /api/publish 响应体（wire）：{ result, metadata }。 */
export interface MobileReadonlyPublishResult {
  result: MobileReadonlyPublishResultKind;
  metadata: MobileReadonlyPublishMetadata;
}

// ---------------------------------------------------------------------------
// 封闭白名单严格校验器（纯 TS，无 Node/网络依赖）
// ---------------------------------------------------------------------------

/** 校验问题分类。 */
export const MOBILE_READONLY_VALIDATION_CODES = {
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  MISSING_KEY: 'MISSING_KEY',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
} as const;
export type MobileReadonlyValidationCode =
  (typeof MOBILE_READONLY_VALIDATION_CODES)[keyof typeof MOBILE_READONLY_VALIDATION_CODES];

export interface MobileReadonlySnapshotIssue {
  /** JSON 路径，如 `projects[0].records.damage_items[2].partCurrency`。 */
  path: string;
  code: MobileReadonlyValidationCode;
  message: string;
}

export type MobileReadonlySnapshotValidationResult =
  | { ok: true }
  | { ok: false; issues: readonly MobileReadonlySnapshotIssue[] };

/** 金额：主单位固定两位小数字符串（可带负号；不经 Number/除以 100）。 */
const MONEY_TWO_DECIMALS_RE = /^-?\d+\.\d{2}$/;
/** 业务日期 yyyy-mm-dd 外形。 */
const BUSINESS_DATE_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/**
 * dataAsOf ISO 外形：要求显式时区（`Z` 或 `±HH:MM`）。
 * 分组：1=年 2=月 3=日 4=时 5=分 6=秒（可选）7=小数秒（可选，仅随秒出现）
 *       8=时区整体（Z 或 ±HH:MM）9=偏移符号 10=偏移时 11=偏移分。
 */
const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 真实日历日期校验（含闰年/大小月），与领域 core/time 同口径。 */
function isRealCalendarDate(value: string): boolean {
  const match = BUSINESS_DATE_SHAPE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

const isMoneyString = (value: unknown): value is string => typeof value === 'string' && MONEY_TWO_DECIMALS_RE.test(value);
const isBusinessDateString = (value: unknown): value is string => typeof value === 'string' && isRealCalendarDate(value);

/**
 * dataAsOf 严格校验：不依赖 Date.parse（其会归一化非法值）。
 * 要求：真实日历日期（复用 isRealCalendarDate）、时 00-23 / 分 00-59 / 秒 00-59、
 * 时区必填（Z 或 ±HH:MM，偏移小时 00-23、偏移分 00-59）。
 * 保留合法 UTC `…T09:00:00.123Z` 与显式偏移（如 +08:00 / +05:45）格式。
 */
function isIsoDateTimeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATETIME_RE.exec(value);
  if (!match) return false;
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? undefined : Number(match[6]);
  const zone = match[8];
  const offsetHour = Number(match[10]);
  const offsetMinute = Number(match[11]);
  if (!isRealCalendarDate(`${year}-${month}-${day}`)) return false;
  if (hour > 23 || minute > 59) return false;
  if (second !== undefined && second > 59) return false;
  if (zone !== 'Z' && (offsetHour > 23 || offsetMinute > 59)) return false;
  return true;
}
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isAnyString = (value: unknown): value is string => typeof value === 'string';
const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function issue(
  issues: MobileReadonlySnapshotIssue[],
  path: string,
  code: MobileReadonlyValidationCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

/** 字段值类别（用于非对象标量字段的逐项校验）。 */
type ValueCheck =
  | { kind: 'nonEmptyString' }
  | { kind: 'string' }
  | { kind: 'nullableString' }
  | { kind: 'boolean' }
  | { kind: 'nullableBoolean' }
  | { kind: 'nullableNonNegativeInt' }
  | { kind: 'nonNegativeInt' }
  | { kind: 'nonNegativeNumber' }
  | { kind: 'money' }
  | { kind: 'nullableMoney' }
  | { kind: 'date' }
  | { kind: 'nullableDate' }
  | { kind: 'iso' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'nullableEnum'; values: readonly string[] };

const NON_NULLABLE_VALUE_CHECKS: ReadonlySet<ValueCheck['kind']> = new Set([
  'nonEmptyString',
  'string',
  'boolean',
  'nonNegativeInt',
  'nonNegativeNumber',
  'money',
  'date',
  'iso',
  'enum',
]);

/** 校验单一标量字段；null 仅在允许可空类别下通过。 */
function checkValue(
  issues: MobileReadonlySnapshotIssue[],
  path: string,
  value: unknown,
  check: ValueCheck,
): void {
  if (value === null) {
    if (!NON_NULLABLE_VALUE_CHECKS.has(check.kind)) return;
    issue(issues, path, 'INVALID_TYPE', `不允许为 null，应为 ${describeValueCheck(check)}`);
    return;
  }
  switch (check.kind) {
    case 'nonEmptyString':
      if (!isNonEmptyString(value)) issue(issues, path, 'INVALID_TYPE', `应为非空字符串`);
      return;
    case 'string':
      if (!isAnyString(value)) issue(issues, path, 'INVALID_TYPE', '应为字符串');
      return;
    case 'nullableString':
      if (!isAnyString(value)) issue(issues, path, 'INVALID_TYPE', '应为字符串或 null');
      return;
    case 'boolean':
    case 'nullableBoolean':
      if (typeof value !== 'boolean') issue(issues, path, 'INVALID_TYPE', '应为布尔值');
      return;
    case 'nonNegativeInt':
    case 'nullableNonNegativeInt':
      if (!isNonNegativeSafeInteger(value)) issue(issues, path, 'INVALID_VALUE', '应为不小于 0 的整数');
      return;
    case 'nonNegativeNumber':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        issue(issues, path, 'INVALID_VALUE', '应为不小于 0 的数字');
      }
      return;
    case 'money':
      if (!isMoneyString(value)) {
        issue(issues, path, 'INVALID_VALUE', '金额必须是主单位固定两位小数字符串（如 "12.34"/"0.00"），不得为 Number 或经除以 100/转 Number');
      }
      return;
    case 'nullableMoney':
      if (value !== null && !isMoneyString(value)) {
        issue(issues, path, 'INVALID_VALUE', '金额必须是主单位固定两位小数字符串或 null，不得为 Number 或经除以 100/转 Number');
      }
      return;
    case 'date':
      if (!isBusinessDateString(value)) {
        issue(issues, path, 'INVALID_VALUE', '业务日期必须是真实日历日期 yyyy-mm-dd');
      }
      return;
    case 'nullableDate':
      if (value !== null && !isBusinessDateString(value)) {
        issue(issues, path, 'INVALID_VALUE', '业务日期必须是真实日历日期 yyyy-mm-dd 或 null');
      }
      return;
    case 'iso':
      if (!isIsoDateTimeString(value)) issue(issues, path, 'INVALID_VALUE', 'dataAsOf 必须为带偏移 ISO 时间');
      return;
    case 'enum': {
      if (!isNonEmptyString(value) || !(check.values as readonly string[]).includes(value)) {
        issue(issues, path, 'INVALID_VALUE', `必须为受控枚举值之一：${check.values.join(' / ')}`);
      }
      return;
    }
    case 'nullableEnum': {
      if (value !== null && (!isNonEmptyString(value) || !(check.values as readonly string[]).includes(value))) {
        issue(issues, path, 'INVALID_VALUE', `必须为受控枚举值之一或 null：${check.values.join(' / ')}`);
      }
      return;
    }
  }
}

function describeValueCheck(check: ValueCheck): string {
  switch (check.kind) {
    case 'nonEmptyString':
      return '非空字符串';
    case 'string':
      return '字符串';
    case 'nullableString':
      return '字符串或 null';
    case 'boolean':
    case 'nullableBoolean':
      return '布尔值';
    case 'nonNegativeInt':
    case 'nullableNonNegativeInt':
      return '不小于 0 的整数';
    case 'nonNegativeNumber':
      return '不小于 0 的数字';
    case 'money':
      return '固定两位小数字符串';
    case 'nullableMoney':
      return '固定两位小数字符串或 null';
    case 'date':
      return 'yyyy-mm-dd 日期';
    case 'nullableDate':
      return 'yyyy-mm-dd 日期或 null';
    case 'iso':
      return '带偏移 ISO 时间';
    case 'enum':
      return `受控枚举（${(check.values as readonly string[]).join('/')}）`;
    case 'nullableEnum':
      return `受控枚举或 null（${(check.values as readonly string[]).join('/')}）`;
  }
}

interface ObjectSpec {
  keys: readonly string[];
  values: Record<string, ValueCheck>;
}

/** 校验「恰好为白名单键集」的对象（缺键/未知键/标量类型与取值）。 */
function checkObject(
  issues: MobileReadonlySnapshotIssue[],
  path: string,
  value: unknown,
  spec: ObjectSpec,
  nested?: (issues: MobileReadonlySnapshotIssue[], path: string, value: Record<string, unknown>) => void,
): void {
  if (!isPlainObject(value)) {
    issue(issues, path, 'INVALID_TYPE', '应为对象');
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(spec.keys as readonly string[]).includes(key)) {
      issue(issues, path, 'UNKNOWN_KEY', `字段「${key}」不在封闭白名单内（含嵌套未知 key 一律非法）`);
    }
  }
  for (const key of spec.keys) {
    if (!(key in value)) {
      issue(issues, path, 'MISSING_KEY', `缺少必填字段「${key}」`);
      continue;
    }
    const check = spec.values[key];
    if (check) {
      checkValue(issues, path === '' ? key : `${path}.${key}`, value[key], check);
    }
  }
  if (nested) nested(issues, path, value);
}

const PROJECT_STATUS_ENUM: ValueCheck = { kind: 'enum', values: [...MOBILE_READONLY_PROJECT_STATUSES] };
const ORDER_TYPE_ENUM: ValueCheck = { kind: 'enum', values: [...MOBILE_READONLY_ORDER_TYPES] };
const PART_CURRENCY_ENUM: ValueCheck = { kind: 'nullableEnum', values: [...MOBILE_READONLY_PART_CURRENCIES] };

const METRICS_SPEC: ObjectSpec = {
  keys: ['totalProjects', 'activeProjects', 'pendingAmount', 'pendingAcceptance', 'pendingInvoice'],
  values: {
    totalProjects: { kind: 'nonNegativeInt' },
    activeProjects: { kind: 'nonNegativeInt' },
    pendingAmount: { kind: 'money' },
    pendingAcceptance: { kind: 'nonNegativeInt' },
    pendingInvoice: { kind: 'nonNegativeInt' },
  },
};

const STAGE_SPEC: ObjectSpec = {
  keys: ['status', 'count', 'averageDays'],
  values: { status: PROJECT_STATUS_ENUM, count: { kind: 'nonNegativeInt' }, averageDays: { kind: 'nonNegativeNumber' } },
};

const OVERVIEW_SPEC: ObjectSpec = {
  keys: ['metrics', 'stages'],
  values: {},
};

const RECORD_KIND_CHECK: Record<MobileReadonlyRecordKind, ObjectSpec> = {
  batches: {
    keys: ['id', 'planTransportDate', 'transportCompany', 'startedAt', 'appliedAt'],
    values: {
      id: { kind: 'nonEmptyString' },
      planTransportDate: { kind: 'nullableDate' },
      transportCompany: { kind: 'nullableString' },
      startedAt: { kind: 'nullableDate' },
      appliedAt: { kind: 'nullableDate' },
    },
  },
  instruments: {
    keys: ['id', 'name', 'model', 'serialNo', 'ups'],
    values: {
      id: { kind: 'nonEmptyString' },
      name: { kind: 'nonEmptyString' },
      model: { kind: 'nullableString' },
      serialNo: { kind: 'nullableString' },
      ups: { kind: 'boolean' },
    },
  },
  activities: {
    keys: ['id', 'visitAt', 'engineers'],
    values: {
      id: { kind: 'nonEmptyString' },
      visitAt: { kind: 'nullableDate' },
      engineers: { kind: 'string' },
    },
  },
  orders: {
    keys: ['id', 'orderType', 'serviceOrderNo', 'orderedAt', 'engineer'],
    values: {
      id: { kind: 'nonEmptyString' },
      orderType: ORDER_TYPE_ENUM,
      serviceOrderNo: { kind: 'nullableString' },
      orderedAt: { kind: 'date' },
      engineer: { kind: 'nullableString' },
    },
  },
  invoices: {
    keys: ['id', 'amount', 'invoicedAt', 'active', 'revokedAt'],
    values: {
      id: { kind: 'nonEmptyString' },
      amount: { kind: 'money' },
      invoicedAt: { kind: 'date' },
      active: { kind: 'boolean' },
      revokedAt: { kind: 'nullableDate' },
    },
  },
  damage_items: {
    keys: [
      'id',
      'instrumentName',
      'serialNo',
      'issueStatus',
      'partNumber',
      'partQuantity',
      'partAmount',
      'partCurrency',
      'registeredAt',
    ],
    values: {
      id: { kind: 'nonEmptyString' },
      instrumentName: { kind: 'nonEmptyString' },
      serialNo: { kind: 'nullableString' },
      issueStatus: { kind: 'string' },
      partNumber: { kind: 'string' },
      partQuantity: { kind: 'nonNegativeInt' },
      partAmount: { kind: 'money' },
      partCurrency: PART_CURRENCY_ENUM,
      registeredAt: { kind: 'date' },
    },
  },
};

function extendSpec(base: ObjectSpec, values: Record<string, ValueCheck>, nested: string[] = []): ObjectSpec {
  return { keys: [...base.keys, ...Object.keys(values), ...nested], values: { ...base.values, ...values } };
}

const METRICS_V2_SPEC = extendSpec(METRICS_SPEC, {
  reminderCount: { kind: 'nonNegativeInt' }, reminderOverdue: { kind: 'nonNegativeInt' },
  reminderToday: { kind: 'nonNegativeInt' }, openRepairProjects: { kind: 'nonNegativeInt' },
});
const RECORD_V2_VALUES: Partial<Record<MobileReadonlyRecordKind, Record<string, ValueCheck>>> = {
  instruments: { manufacturer: { kind: 'nullableString' }, serviceLevel: { kind: 'nullableString' }, qrRequested: { kind: 'boolean' } },
  orders: { customerName: { kind: 'string' } },
  damage_items: { partStatus: { kind: 'nullableEnum', values: MOBILE_READONLY_PART_STATUSES } },
};
const DETAIL_VALUES: Record<keyof MobileReadonlyProjectDetailFields, ValueCheck> = {
  oldSiteContact: { kind: 'nullableString' }, newSiteContact: { kind: 'nullableString' },
  oldSiteAddress: { kind: 'nullableString' }, newSiteAddress: { kind: 'nullableString' },
  temporaryStorageAddress: { kind: 'nullableString' }, isTemporaryStorage: { kind: 'nullableBoolean' },
  contractStartDate: { kind: 'nullableDate' }, contractEndDate: { kind: 'nullableDate' },
  planTransportAt: { kind: 'nullableDate' }, plannedInstallAt: { kind: 'nullableDate' },
  actualInstallDoneAt: { kind: 'nullableDate' }, acceptanceReportDate: { kind: 'nullableDate' },
  cancelledAt: { kind: 'nullableDate' }, siteConfirmed: { kind: 'boolean' }, acceptanceReport: { kind: 'boolean' },
  temporaryInstrumentCount: { kind: 'nullableNonNegativeInt' }, temporaryInstrumentName: { kind: 'nullableString' },
  temporaryInstrumentModel: { kind: 'nullableString' }, temporaryHasUps: { kind: 'nullableBoolean' },
  reminderNote: { kind: 'nullableString' },
};
const DETAIL_SPEC: ObjectSpec = { keys: Object.keys(DETAIL_VALUES), values: DETAIL_VALUES };
const TAG_GROUP_SPEC: ObjectSpec = {
  keys: ['groupId', 'groupName', 'tagIds', 'tagNames'],
  values: { groupId: { kind: 'nonEmptyString' }, groupName: { kind: 'string' } },
};

function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function checkRecordKindList(
  issues: MobileReadonlySnapshotIssue[],
  path: string,
  value: unknown,
  kind: MobileReadonlyRecordKind,
  version: number,
): void {
  if (!Array.isArray(value)) {
    issue(issues, path, 'INVALID_TYPE', `「${kind}」应为数组`);
    return;
  }
  const spec = version === 2 ? extendSpec(RECORD_KIND_CHECK[kind], RECORD_V2_VALUES[kind] ?? {}) : RECORD_KIND_CHECK[kind];
  value.forEach((row, index) => {
    checkObject(issues, `${path}[${index}]`, row, spec);
  });
}

function checkProjectRecords(issues: MobileReadonlySnapshotIssue[], path: string, value: Record<string, unknown>, version: number): void {
  for (const kind of MOBILE_READONLY_RECORD_KINDS) {
    checkRecordKindList(issues, childPath(path, kind), value[kind], kind, version);
  }
}

const PROJECT_RECORDS_SPEC: ObjectSpec = {
  keys: [...MOBILE_READONLY_RECORD_KINDS],
  values: {},
};

const PROJECT_SPEC: ObjectSpec = {
  keys: [
    'id',
    'tempNo',
    'ecc',
    'customerName',
    'status',
    'region',
    'regionNeedsAdjustment',
    'entryAt',
    'planVisitAt',
    'finalAmount',
    'invoicedAmount',
    'contractAmount',
    'formallyEntered',
    'preEntryExecution',
    'records',
  ],
  values: {
    id: { kind: 'nonEmptyString' },
    tempNo: { kind: 'nonEmptyString' },
    ecc: { kind: 'nullableString' },
    customerName: { kind: 'string' },
    status: PROJECT_STATUS_ENUM,
    region: { kind: 'nullableString' },
    regionNeedsAdjustment: { kind: 'boolean' },
    entryAt: { kind: 'nullableDate' },
    planVisitAt: { kind: 'nullableDate' },
    finalAmount: { kind: 'nullableMoney' },
    invoicedAmount: { kind: 'money' },
    contractAmount: { kind: 'nullableMoney' },
    formallyEntered: { kind: 'boolean' },
    preEntryExecution: { kind: 'boolean' },
  },
};

function checkProjects(issues: MobileReadonlySnapshotIssue[], value: unknown, version: number): void {
  if (!Array.isArray(value)) {
    issue(issues, 'projects', 'INVALID_TYPE', '「projects」应为数组');
    return;
  }
  value.forEach((project, index) => {
    const path = `projects[${index}]`;
    const spec = version === 2 ? extendSpec(PROJECT_SPEC, {
      reminderAt: { kind: 'nullableDate' },
      reminderDueClass: { kind: 'nullableEnum', values: ['upcoming', 'today', 'overdue'] },
    }, ['groupedTags', 'detail']) : PROJECT_SPEC;
    checkObject(issues, path, project, spec, (issues, path, obj) => {
      checkObject(issues, childPath(path, 'records'), obj.records, PROJECT_RECORDS_SPEC,
        (issues, path, records) => checkProjectRecords(issues, path, records, version));
      if (version === 2) {
        checkObject(issues, childPath(path, 'detail'), obj.detail, DETAIL_SPEC);
        if (!Array.isArray(obj.groupedTags)) {
          issue(issues, childPath(path, 'groupedTags'), 'INVALID_TYPE', '应为数组');
        } else obj.groupedTags.forEach((tag, index) => {
          checkObject(issues, `${path}.groupedTags[${index}]`, tag, TAG_GROUP_SPEC, (issues, path, group) => {
            for (const key of ['tagIds', 'tagNames']) {
              if (!Array.isArray(group[key]) || !group[key].every(isAnyString)) {
                issue(issues, childPath(path, key), 'INVALID_TYPE', '应为字符串数组');
              }
            }
          });
        });
      }
    });
  });
}

function checkOverview(issues: MobileReadonlySnapshotIssue[], value: unknown, version: number): void {
  if (!isPlainObject(value)) {
    issue(issues, 'overview', 'INVALID_TYPE', '「overview」应为对象');
    return;
  }
  checkObject(issues, 'overview', value, OVERVIEW_SPEC, (issues, path, obj) => {
    checkObject(issues, childPath(path, 'metrics'), obj.metrics, version === 2 ? METRICS_V2_SPEC : METRICS_SPEC);
    if (!Array.isArray(obj.stages)) {
      issue(issues, childPath(path, 'stages'), 'INVALID_TYPE', '「overview.stages」应为数组');
      return;
    }
    obj.stages.forEach((stage, index) => {
      checkObject(issues, `${childPath(path, 'stages')}[${index}]`, stage, STAGE_SPEC);
    });
  });
}

const SNAPSHOT_TOP_SPEC: ObjectSpec = {
  keys: ['schemaVersion', 'contentGenerationId', 'businessRevision', 'dataAsOf', 'overview', 'projects'],
  values: {
    schemaVersion: { kind: 'nonNegativeInt' },
    contentGenerationId: { kind: 'nonEmptyString' },
    businessRevision: { kind: 'nonNegativeInt' },
    dataAsOf: { kind: 'iso' },
  },
};

/** 校验快照 JSON（业务白名单层）；任何位置未知 key/缺键/格式非法均返回失败。 */
export function validateMobileReadonlySnapshot(value: unknown): MobileReadonlySnapshotValidationResult {
  const issues: MobileReadonlySnapshotIssue[] = [];
  if (!isPlainObject(value)) {
    issues.push({ path: '', code: 'INVALID_TYPE', message: '快照应为对象' });
    return { ok: false, issues };
  }
  checkObject(issues, '', value, SNAPSHOT_TOP_SPEC, (issues, path, obj) => {
    if (obj.schemaVersion !== 1 && obj.schemaVersion !== 2) {
      // 报错信息不得对不可信值做字符串强转（schemaVersion 可能来自 JSON.parse，
      // 对象/toString 缺失会抛 TypeError）；使用固定安全文案。
      issue(
        issues,
        childPath(path, 'schemaVersion'),
        'INVALID_VALUE',
        '不支持的快照 schemaVersion；当前仅支持版本 1 / 2',
      );
    }
  });
  checkOverview(issues, value.overview, value.schemaVersion as number);
  checkProjects(issues, value.projects, value.schemaVersion as number);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
