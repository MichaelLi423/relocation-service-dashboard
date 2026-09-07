/**
 * 移动只读投影：字段白名单与显式 source→approved-field 选择（tasks 1.3）。
 *
 * - 白名单唯一规范来源：`openspec/changes/add-remote-readonly-access/specs/
 *   mobile-readonly-workbench/spec.md` 的表（字段组/源契约列）。
 * - 本模块只声明「投影后契约」，是发布层 DTO/JSONL 与云端固定 DDL/响应共用的
 *   单一契约锚点；不授权公开整个 src/shared/ipc.ts 或本机存储结构。
 * - Source 允许含排除字段（如 WorkbenchProjectRow 携带 reminderNote、tagIds、
 *   counts.activities、nonBlocking.pendingShipTo/qrUnmarked）；投影入口显式选择
 *   （select）或显式丢弃（drop）——禁止展开透传整个 source DTO。
 * - parseStrict* 用于接收/恢复端反序列化：未知 JSON 键（含 canary）以
 *   UNKNOWN_FIELD metadata-only 错误拒绝；金额必须是精确两位小数字符串；
 *   业务日期必须是严格 yyyy-mm-dd；技术时间必须带偏移 ISO。本层不做重复 key
 *   检测（JSON.parse 无法可靠识别重复 key，全量 streaming ingress 是后续 3.x 依赖）。
 * - 不含标签/目录、联系人、地址、Ship-to、工程师/操作者姓名、运输公司、厂商、
 *   服务级别、自由备注与原因、源文件、附件、路径、导入样本、审计详情。
 * - 仅声明纯数据契约与纯函数，不依赖 WorkbenchApi / Electron / 本机 DB。
 */
import type {
  WorkbenchProjectRow,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2SectionRow,
} from '../ipc';
import { formatCents, parseDecimalToCents } from '../../domain/core/money';
import {
  assertExactCentsString,
  assertExactBusinessDate,
  assertRemoteId,
  assertFieldLength,
  toBusinessDate,
  toBoolean,
  toCount,
  toEnum,
  toExactMoney,
  toIso,
  toNullableBusinessDate,
  toNullableExactMoney,
  toNullableBoolean,
  toRequiredText,
  MOBILE_PAGE_SIZE,
  MAX_REMOTE_FIELD_CHARS,
  REMOTE_PROJECT_REGIONS,
  type RemoteProjectRegion,
} from './values';
import {
  InvalidValueRejection,
  UnknownFieldRejection,
  rejectionField,
} from './rejection';

/** 投影契约版本（manifest.projectionVersion 的规范取值）。 */
export const PROJECTION_VERSION = 'mobile-read-v1';

/** 主状态枚举（与 src/shared/ipc ProjectStatus 语义一致，供状态文本/筛选共用）。 */
export const REMOTE_PROJECT_STATUSES = [
  'pending_entry',
  'pending_execution',
  'executing',
  'under_repair',
  'pending_acceptance',
  'pending_invoice',
  'completed',
  'cancelled',
] as const;

export type RemoteProjectStatus = (typeof REMOTE_PROJECT_STATUSES)[number];

/** 开单类型枚举（service-order-recording ORDER_TYPES 同语义）。 */
export const REMOTE_ORDER_TYPES = ['relocation', 'certification', 'parts_by_mail', 'pm'] as const;
export type RemoteOrderType = (typeof REMOTE_ORDER_TYPES)[number];

/** 维修事项状态（damage-repair-tracking DAMAGE_ITEM_STATUSES 同语义）。 */
export const REMOTE_DAMAGE_STATUSES = ['untreated', 'processing', 'repaired', 'closed_unrepaired'] as const;
export type RemoteDamageStatus = (typeof REMOTE_DAMAGE_STATUSES)[number];

/** 备件处理状态（damage-repair-tracking PART_STATUSES 同语义）。 */
export const REMOTE_PART_STATUSES = ['pending_submit', 'processing', 'arrived', 'used'] as const;
export type RemotePartStatus = (typeof REMOTE_PART_STATUSES)[number];

/** 备件币种（damage-repair-tracking PART_CURRENCIES 同语义：仅 USD 与 RMB）。 */
export const REMOTE_PART_CURRENCIES = ['USD', 'RMB'] as const;
export type RemotePartCurrency = (typeof REMOTE_PART_CURRENCIES)[number];

// ---------------------------------------------------------------------------
// 读取技术信封
// ---------------------------------------------------------------------------

/**
 * 概览 DTO 信封（读取技术信封）：
 * `databaseInstanceId`/`contentGenerationId` 为谱系诊断字段（businessRevision 是
 * 同谱系单调递增序列）；`generatedAt` 为源端诊断时间（不参与授权排序）。
 */
export interface RemoteEnvelope {
  databaseInstanceId: string;
  contentGenerationId: string;
  businessRevision: number;
  snapshotId: string;
  activationId: string;
  /** 源端生成诊断时间（精确 ISO）。 */
  generatedAt: string;
  /** 云端发布（激活）时间（精确 ISO；null=未发布）。 */
  lastPublishedAt: string | null;
  /** 云端最近接受有效源报告时间（精确 ISO；null=未接受）。 */
  lastSourceSeenAt: string | null;
  /** 云端最近来源确认（源指纹==当前快照）时间（精确 ISO；null=未确认）。 */
  sourceConfirmedAt: string | null;
}

export interface RemotePagingMeta {
  /** 匹配当前筛选的全部结果数。 */
  total: number;
  /** 本页实际条数（≤ pageSize）。 */
  limit: number;
  /** 固定每页 20（mobile 分页契约，不接受客户端页大小）。 */
  pageSize: number;
  /** 下一页游标（末页为 null）。 */
  nextCursor: string | null;
}

export interface RemotePartitionRef {
  kind: RemoteSectionKind;
  projectId: string;
}

// ---------------------------------------------------------------------------
// 概览 `WorkbenchV2OverviewDto`
// ---------------------------------------------------------------------------

/**
 * 概览指标（mobile-readonly-workbench 表「概览 WorkbenchV2OverviewDto」行）。
 * 不含阶段平均时间、提醒统计或提醒预览；pendingAmount 为精确两位小数字符串。
 */
export interface RemoteOverviewMetrics {
  totalProjects: number;
  /** 未完成且未取消（只展示，不暗含多状态筛选）。 */
  activeProjects: number;
  /** 进入待验收主状态列表。 */
  pendingAcceptance: number;
  /** 进入 pending_invoice 主状态列表。 */
  pendingInvoice: number;
  /** 待掉票金额（USD；精确字符串）。 */
  pendingAmount: string;
}

/** 概览 DTO = 读取技术信封 + 五键指标（概览不是分页/分区读取）。 */
export interface RemoteOverviewDto extends RemoteEnvelope {
  metrics: RemoteOverviewMetrics;
}

// ---------------------------------------------------------------------------
// 项目识别 `WorkbenchProjectRow`
// ---------------------------------------------------------------------------

/**
 * 项目卡片/行（mobile-readonly-workbench 表「项目识别 WorkbenchProjectRow」行）。
 * 仅选择 id/customerName/ecc/tempNo/status/formallyEntered/preEntryExecution/
 * planVisitAt 与财务/进单/区域/排序/计数/提醒允许字段；显式丢弃：
 * reminderNote、reminderDueClass、tagIds、groupedTags、counts.activities、
 * nonBlocking.pendingShipTo、nonBlocking.qrUnmarked。
 */
export interface RemoteProjectCard {
  id: string;
  customerName: string;
  ecc: string | null;
  tempNo: string;
  status: RemoteProjectStatus;
  formallyEntered: boolean;
  preEntryExecution: boolean;
  region: RemoteProjectRegion | null;
  /** 历史待调整事实（不发布原文）。 */
  regionNeedsAdjustment: boolean;
  planVisitAt: string | null;
  /** 提醒仅投影 reminderAt 与派生 hasReminder；不投影备注/到期分类。 */
  reminderAt: string | null;
  hasReminder: boolean;
  updatedAt: string;
}

export interface RemoteProjectFinancial {
  contractAmount: string | null;
  entryAmountSnapshot: string | null;
  finalAmount: string | null;
  /** 累计有效掉票（USD；精确字符串）。 */
  invoicedAmount: string;
  entryAt: string | null;
}

export interface RemoteProjectCounts {
  batches: number;
  instruments: number;
  orders: number;
  repairs: number;
  invoices: number;
  /** 不含 activities。 */
}
export interface RemoteNonBlockingCounts {
  repairs: number;
  /** 不含 pendingShipTo / qrUnmarked。 */
}

/** 项目行卡片 = 识别 + 财务 + 关联计数 + 区域/排序（不含 activities / pendingShipTo / qrUnmarked）。 */
export interface RemoteProjectRow extends RemoteProjectCard, RemoteProjectFinancial {
  counts: RemoteProjectCounts;
  nonBlocking: RemoteNonBlockingCounts;
}

/** 项目列表页 DTO（含技术信封的谱系/诊断 + 固定分页）。 */
export interface RemoteProjectPageDto extends RemoteEnvelope {
  projects: readonly RemoteProjectRow[];
  page: RemotePagingMeta;
}

// ---------------------------------------------------------------------------
// 详情 `WorkbenchV2ProjectDetailDto.detail`（合同与计划 + 准备/范围/终态）
// ---------------------------------------------------------------------------

export interface RemoteProjectDetailContract {
  contractStartDate: string | null;
  contractEndDate: string | null;
  planVisitAt: string | null;
  planTransportAt: string | null;
  /** 计划装机日期（新契约字段；不发布旧别名 plannedInstallDoneAt）。 */
  plannedInstallAt: string | null;
  actualInstallDoneAt: string | null;
}

export interface RemoteProjectDetailFacts {
  /** 是否批复（可空三元：是/否/未填写）。 */
  managerApproved: boolean | null;
  siteConfirmed: boolean;
  isTemporaryStorage: boolean | null;
  /** 是否已有验收报告（报告文件访问不授权）。 */
  acceptanceReport: boolean;
  acceptanceReportDate: string | null;
  temporaryInstrumentCount: number | null;
  temporaryHasUps: boolean | null;
  cancelledAt: string | null;
}

export interface RemoteProjectDetailGroup {
  /** 详情技术 ID（不冒充业务编号）。 */
  id: string;
  contract: RemoteProjectDetailContract | null;
  facts: RemoteProjectDetailFacts | null;
  reminder: RemoteReminderFacts;
  counts: RemoteProjectCounts;
  nonBlocking: RemoteNonBlockingCounts;
  finance: RemoteProjectFinancial;
}

export interface RemoteReminderFacts {
  reminderAt: string | null;
  /** 本机当前提醒日期或备注任一存在（不携带备注内容）。 */
  hasReminder: boolean;
}

/** 项目详情 DTO：contract 与 facts 字段均允许为 null（未录入/不存在）。 */
export interface RemoteProjectDetailDto extends RemoteEnvelope {
  project: RemoteProjectRow | null;
  detail: {
    contract: RemoteProjectDetailContract | null;
    facts: RemoteProjectDetailFacts | null;
    reminder: RemoteReminderFacts | null;
  } | null;
}

/**
 * 项目 JSONL 完整记录 = 一个「项目实体」（ONE entity，manifest `entityCounts.projects`
 * 仍按一行计 1）：识别行 `row` + 已批准详情分组 `detail`。
 *
 * - `detail` 复用 `RemoteProjectDetailGroup`（id/合同与计划/准备范围终态/手工提醒/
 *   关联计数/非阻塞计数/财务），是发布记录中除 row 外的已批准详情分组；同一实体
 *   组内 `id` 必须与 `row.id` 一致（见 jsonl 严格解析，防跨实体拼接）。
 * - 发布记录必须携带 detail（「详情未录入」用组内 contract/facts=null 表示，不省略
 *   detail 本身）；行-only 的 `{kind,row}` 仅保留为旧诊断 helper 的线形状。
 */
export interface RemoteProjectRecord {
  kind: 'project';
  row: RemoteProjectRow;
  detail: RemoteProjectDetailGroup;
}

// ---------------------------------------------------------------------------
// `WorkbenchV2SectionRow` 五分区
// ---------------------------------------------------------------------------

export type RemoteSectionKind = 'batches' | 'instruments' | 'orders' | 'invoices' | 'damage_items';

export interface RemoteBatchRow {
  kind: 'batches';
  id: string;
  projectId: string;
  planTransportDate: string | null;
  startedAt: string | null;
  /** 物流费用登记日期（业务日期；无费用记录时 null）。 */
  appliedAt: string | null;
  /** 合同预算价（人民币；精确字符串）。 */
  originalPrice: string | null;
  /** 物流成交价（人民币；精确字符串；允许空值）。 */
  discountedPrice: string | null;
}

export interface RemoteInstrumentRow {
  kind: 'instruments';
  id: string;
  projectId: string;
  batchId: string | null;
  name: string;
  model: string | null;
  serialNo: string | null;
  ups: boolean;
  qrRequested: boolean;
}

export interface RemoteOrderRow {
  kind: 'orders';
  id: string;
  projectId: string;
  orderType: RemoteOrderType;
  serviceOrderNo: string | null;
  orderedAt: string;
}

export interface RemoteInvoiceRow {
  kind: 'invoices';
  id: string;
  projectId: string;
  amount: string;
  invoicedAt: string;
  active: boolean;
  revokedAt: string | null;
  lastModifiedAt: string;
}

export interface RemoteDamageItemRow {
  kind: 'damage_items';
  id: string;
  projectId: string;
  instrumentId: string;
  instrumentName: string;
  serialNo: string | null;
  issueStatus: RemoteDamageStatus;
  registeredAt: string;
  partNumber: string;
  partQuantity: number;
  partAmount: string;
  partCurrency: RemotePartCurrency | null;
  partStatus: RemotePartStatus | null;
}

export type RemoteSectionRow =
  | RemoteBatchRow
  | RemoteInstrumentRow
  | RemoteOrderRow
  | RemoteInvoiceRow
  | RemoteDamageItemRow;

export interface RemoteSectionPageDto extends RemoteEnvelope {
  kind: RemoteSectionKind;
  projectId: string;
  rows: readonly RemoteSectionRow[];
  page: RemotePagingMeta;
}

// ---------------------------------------------------------------------------
// 显式 source→approved-field 选择（projection 唯一入口）
// ---------------------------------------------------------------------------

/** Source 判别结果（不扩展：带 `activities` 计数、Ship-to/二维码未标、标签、备注一律视为不发布）。 */
export type ProjectSourceKind = 'desktop-workbench-v2';

export const PROJECT_SOURCE_KIND: ProjectSourceKind = 'desktop-workbench-v2';

function deriveHasReminder(source: WorkbenchProjectRow): boolean {
  return source.reminderAt !== null && source.reminderAt !== undefined
    ? true
    : source.reminderNote !== null && source.reminderNote !== undefined
      ? true
      : false;
}

// ---- 发布边界严格 helper（与 parse 边界同语义；拒绝值不进入错误 message） ----

/** 必填发布文本：非空、≤4096 Unicode 码点；空/非 string 一律拒绝（不归一）。 */
function requirePublicationText(value: string, fieldName: string): string {
  return toRequiredText(value, fieldName);
}

/** 可空发布文本：null/undefined → null；'' 拒绝（wire 未批准空文本）；≤4096 码点。 */
function requirePublicationNullableText(value: string | null, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  return toRequiredText(value, fieldName);
}

/** 必填发布标识符：非空 string，≤128 Unicode 码点（'' 拒绝，不静默归一）。 */
function requirePublicationId(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidValueRejection('REQUIRED_FIELD', `${fieldName} 必填`);
  }
  return assertRemoteId(value, fieldName) ?? value;
}

/** 可空发布标识符：null/undefined → null；'' 拒绝；≤128 Unicode 码点。 */
function requirePublicationNullableId(value: string | null, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (value === '') {
    throw new InvalidValueRejection('REQUIRED_FIELD', `${fieldName} 必填（wire 未批准空标识符）`);
  }
  return assertRemoteId(value, fieldName) ?? value;
}

/** 从源行显式选择允许字段 → 项目识别卡片。 */
export function toRemoteProjectCard(source: WorkbenchProjectRow): RemoteProjectCard {
  return {
    id: assertRemoteId(source.id, 'project.id') ?? '',
    customerName: assertFieldLength(source.customerName, 'project.customerName'),
    ecc: source.ecc === null || source.ecc === undefined ? null : assertFieldLength(source.ecc, 'project.ecc'),
    tempNo: assertFieldLength(source.tempNo, 'project.tempNo'),
    status: toEnum(source.status, REMOTE_PROJECT_STATUSES, 'project.status'),
    formallyEntered: source.formallyEntered,
    preEntryExecution: source.preEntryExecution,
    region: source.region === null || source.region === undefined ? null : projectRegionOrNull(source.region),
    regionNeedsAdjustment:
      source.region !== null && source.region !== undefined && !isRemoteFixedRegion(source.region),
    planVisitAt: toNullableBusinessDate(source.planVisitAt, 'project.planVisitAt'),
    reminderAt: toNullableBusinessDate(source.reminderAt, 'project.reminderAt'),
    hasReminder: deriveHasReminder(source),
    updatedAt: source.updatedAt,
  };
}

function isRemoteFixedRegion(region: string): boolean {
  return (REMOTE_PROJECT_REGIONS as readonly string[]).includes(region);
}

function projectRegionOrNull(region: string): RemoteProjectRegion | null {
  if (isRemoteFixedRegion(region)) return region as RemoteProjectRegion;
  // 历史原文不发布：非五枚举原值一律投影 region=null（配合 regionNeedsAdjustment=true）。
  return null;
}

/** 显式选择财务与进单字段（合同金额允许 0，精确字符串/可空）。 */
export function toRemoteProjectFinancial(source: WorkbenchProjectRow): RemoteProjectFinancial {
  return {
    contractAmount:
      source.contractAmount === null || source.contractAmount === undefined
        ? null
        : assertExactCentsString(source.contractAmount, 'project.contractAmount'),
    entryAmountSnapshot:
      source.entryAmountSnapshot === null || source.entryAmountSnapshot === undefined
        ? null
        : assertExactCentsString(source.entryAmountSnapshot, 'project.entryAmountSnapshot'),
    finalAmount:
      source.finalAmount === null || source.finalAmount === undefined
        ? null
        : assertExactCentsString(source.finalAmount, 'project.finalAmount'),
    invoicedAmount: assertExactCentsString(source.invoicedAmount, 'project.invoicedAmount'),
    entryAt:
      source.entryAt === null || source.entryAt === undefined ? null : assertExactBusinessDate(source.entryAt, 'project.entryAt'),
  };
}

/** 显式选择关联计数（只含 batches/instruments/orders/repairs/invoices，不含 activities）。 */
export function toRemoteProjectCounts(source: WorkbenchProjectRow): RemoteProjectCounts {
  return {
    batches: toCount(source.counts.batches, 'project.counts.batches'),
    instruments: toCount(source.counts.instruments, 'project.counts.instruments'),
    orders: toCount(source.counts.orders, 'project.counts.orders'),
    repairs: toCount(source.counts.repairs, 'project.counts.repairs'),
    invoices: toCount(source.counts.invoices, 'project.counts.invoices'),
  };
}

/** 显式选择非阻塞计数（仅 repairs；丢弃 pendingShipTo/qrUnmarked）。 */
export function toRemoteNonBlockingCounts(source: WorkbenchProjectRow): RemoteNonBlockingCounts {
  return {
    repairs: toCount(source.nonBlocking?.repairs ?? 0, 'project.nonBlocking.repairs'),
  };
}

/** 将桌面 WorkbenchProjectRow 投影为移动项目行（显式字段选择，未知字段随源类型被丢弃）。 */
export function projectRowFromWorkbench(source: WorkbenchProjectRow): RemoteProjectRow {
  return {
    ...toRemoteProjectCard(source),
    ...toRemoteProjectFinancial(source),
    counts: toRemoteProjectCounts(source),
    nonBlocking: toRemoteNonBlockingCounts(source),
  };
}

/**
 * 项目卡片财务/区域允许字段到 detail 分组；detail 为 null 返回 null（该分组缺省为
 * 未录入状态，但不丢失项目已存在这一事实——group.id/counts 仍在详情层）。
 */
export function toRemoteProjectDetail(
  detail: WorkbenchV2ProjectDetailDto['detail'],
): RemoteProjectDetailContract | null {
  if (!detail) return null;
  return {
    contractStartDate:
      detail.contractStartDate === null ? null : assertExactBusinessDate(detail.contractStartDate, 'detail.contractStartDate'),
    contractEndDate:
      detail.contractEndDate === null ? null : assertExactBusinessDate(detail.contractEndDate, 'detail.contractEndDate'),
    planVisitAt: detail.planVisitAt === null ? null : assertExactBusinessDate(detail.planVisitAt, 'detail.planVisitAt'),
    planTransportAt:
      detail.planTransportAt === null ? null : assertExactBusinessDate(detail.planTransportAt, 'detail.planTransportAt'),
    // 只读 plannedInstallAt（新契约字段），旧别名 plannedInstallDoneAt 不发布。
    plannedInstallAt:
      detail.plannedInstallAt === null ? null : assertExactBusinessDate(detail.plannedInstallAt, 'detail.plannedInstallAt'),
    actualInstallDoneAt:
      detail.actualInstallDoneAt === null
        ? null
        : assertExactBusinessDate(detail.actualInstallDoneAt, 'detail.actualInstallDoneAt'),
  };
}

/** 详情事实（准备/范围/终态）显式选择；临时范围仅取标量，不发布名称/型号。 */
export function toRemoteProjectDetailFacts(
  detail: WorkbenchV2ProjectDetailDto['detail'],
): RemoteProjectDetailFacts | null {
  if (!detail) return null;
  return {
    managerApproved: toNullableBoolean(detail.managerApproved, 'detail.managerApproved'),
    siteConfirmed: detail.siteConfirmed,
    isTemporaryStorage: toNullableBoolean(detail.isTemporaryStorage, 'detail.isTemporaryStorage'),
    acceptanceReport: detail.acceptanceReport,
    acceptanceReportDate:
      detail.acceptanceReportDate === null
        ? null
        : assertExactBusinessDate(detail.acceptanceReportDate, 'detail.acceptanceReportDate'),
    temporaryInstrumentCount:
      detail.temporaryInstrumentCount === null || detail.temporaryInstrumentCount === undefined
        ? null
        : toCount(detail.temporaryInstrumentCount, 'detail.temporaryInstrumentCount'),
    temporaryHasUps: toNullableBoolean(detail.temporaryHasUps, 'detail.temporaryHasUps'),
    cancelledAt:
      detail.cancelledAt === null ? null : assertExactBusinessDate(detail.cancelledAt, 'detail.cancelledAt'),
  };
}

/** 提醒事实：仅 reminderAt（日期）与派生 hasReminder（不投影备注/到期分类）。 */
export function toRemoteReminderFacts(source: WorkbenchProjectRow): RemoteReminderFacts {
  return {
    reminderAt:
      source.reminderAt === null || source.reminderAt === undefined
        ? null
        : assertExactBusinessDate(source.reminderAt, 'project.reminderAt'),
    hasReminder: deriveHasReminder(source),
  };
}

/** 详情分组：project/detail 均不存在时为 null（项目不存在）。 */
export function toRemoteDetailGroup(
  project: WorkbenchProjectRow | null,
  detail: WorkbenchV2ProjectDetailDto['detail'],
): RemoteProjectDetailGroup | null {
  if (project === null) return null;
  return {
    id: project.id,
    contract: toRemoteProjectDetail(detail),
    facts: toRemoteProjectDetailFacts(detail),
    reminder: toRemoteReminderFacts(project),
    counts: toRemoteProjectCounts(project),
    nonBlocking: toRemoteNonBlockingCounts(project),
    finance: toRemoteProjectFinancial(project),
  };
}

/**
 * 待掉票金额适配（synthetic 纯函数；tasks 1.4 / mobile-readonly-workbench 财务口径）。
 *
 * 复用 project-financial-closure「待掉票金额指标仅由仍存在项目的有效财务事实计算」、
 * workbench-interface「待掉票指标仅由有效关联财务事实计算」及 operational-reporting
 * 有效掉票/取消排除口径：
 * - 项目已取消 → 排除；
 * - 项目不存在/孤立财务事实 → 排除（本函数只接收仍存在的项目；无项目时结果为 '0.00'）；
 * - 已完成但仍有有效待掉票余额 → 纳入；
 * - 不按「进行中/pending_invoice」状态筛选、不复制现有实现因条件不同而加的
 *   entry_at 等额外资格过滤；最终可确认金额为 null 的行无有效可确认金额，不计。
 * - 参与计算前金额先经 assertExactCentsString（精确两位小数 + ≤4096）校验：
 *   非法（如 '1.005'、需 trim 的 ' 1.00 '）的参与行按既有「排除脏财务事实」语义
 *   跳过——不被 parseDecimalToCents 宽松 HALF_UP 舍入成合法金额参与聚合。
 * 每项余额 = finalAmount − 累计有效掉票，仅 > 0 时计入。
 */
export function computePendingAmountCents(rows: readonly WorkbenchProjectRow[]): bigint {
  let total = 0n;
  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    if (row.finalAmount === null || row.finalAmount === undefined) continue;
    // 精确校验先行：脏金额不参与（与 authoritative financial-facts adapter 的
    // 严格两小数前置一致），避免 parseDecimalToCents 宽松舍入后计入。
    if (!isExactCentsString(row.finalAmount) || !isExactCentsString(row.invoicedAmount)) {
      continue;
    }
    const finalCents = parseDecimalToCents(row.finalAmount);
    const invoicedCents = parseDecimalToCents(row.invoicedAmount);
    const balance = finalCents - invoicedCents;
    if (balance > 0n) total += balance;
  }
  return total;
}

/** 仅供投影聚合判定：字符串是否为精确两位小数（不抛错、不回显）。 */
function isExactCentsString(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    assertExactCentsString(value, '');
    return true;
  } catch {
    return false;
  }
}

/** 概览 pendingAmount 精确字符串（复用上述口径；完成余额/取消/孤立/无数据边界）。 */
export function computePendingAmountString(rows: readonly WorkbenchProjectRow[]): string {
  return formatCents(computePendingAmountCents(rows));
}

// ---------------------------------------------------------------------------
// Section 显式选择（source 行仅取批准字段；未批准字段不随 source DTO 类型进入）
// ---------------------------------------------------------------------------

type BatchesSection = Extract<WorkbenchV2SectionRow, { kind: 'batches' }>;
type InstrumentsSection = Extract<WorkbenchV2SectionRow, { kind: 'instruments' }>;
type OrdersSection = Extract<WorkbenchV2SectionRow, { kind: 'orders' }>;
type InvoicesSection = Extract<WorkbenchV2SectionRow, { kind: 'invoices' }>;
type DamageSection = Extract<WorkbenchV2SectionRow, { kind: 'damage_items' }>;

function batchSectionRowFromWorkbench(source: BatchesSection): RemoteBatchRow {
  return {
    kind: 'batches',
    id: requirePublicationId(source.id, 'batch.id'),
    projectId: requirePublicationId(source.projectId, 'batch.projectId'),
    planTransportDate:
      source.planTransportDate === null ? null : assertExactBusinessDate(source.planTransportDate, 'batch.planTransportDate'),
    startedAt: source.startedAt === null ? null : assertExactBusinessDate(source.startedAt, 'batch.startedAt'),
    appliedAt: source.appliedAt === null ? null : assertExactBusinessDate(source.appliedAt, 'batch.appliedAt'),
    originalPrice:
      source.originalPrice === null ? null : assertExactCentsString(source.originalPrice, 'batch.originalPrice'),
    discountedPrice:
      source.discountedPrice === null ? null : assertExactCentsString(source.discountedPrice, 'batch.discountedPrice'),
  };
}

function instrumentSectionRowFromWorkbench(source: InstrumentsSection): RemoteInstrumentRow {
  return {
    kind: 'instruments',
    id: requirePublicationId(source.id, 'instrument.id'),
    projectId: requirePublicationId(source.projectId, 'instrument.projectId'),
    batchId: requirePublicationNullableId(source.batchId, 'instrument.batchId'),
    name: source.name,
    model: requirePublicationNullableText(source.model, 'instrument.model'),
    serialNo: requirePublicationNullableText(source.serialNo, 'instrument.serialNo'),
    ups: source.ups,
    qrRequested: source.qrRequested,
  };
}

function orderSectionRowFromWorkbench(source: OrdersSection): RemoteOrderRow {
  if (source.projectId === null) {
    // orders 行仅发布「当前项目关联记录」：无有效 projectId 的 source 不进入本函数。
    throw new InvalidValueRejection('ORDER_NO_PROJECT', '开单记录没有有效项目关联，不能发布');
  }
  return {
    kind: 'orders',
    id: requirePublicationId(source.id, 'order.id'),
    projectId: requirePublicationId(source.projectId, 'order.projectId'),
    orderType: toEnum(source.orderType, REMOTE_ORDER_TYPES, 'order.orderType'),
    serviceOrderNo: requirePublicationNullableText(source.serviceOrderNo, 'order.serviceOrderNo'),
    orderedAt: assertExactBusinessDate(source.orderedAt, 'order.orderedAt'),
  };
}

function invoiceSectionRowFromWorkbench(source: InvoicesSection): RemoteInvoiceRow {
  return {
    kind: 'invoices',
    id: requirePublicationId(source.id, 'invoice.id'),
    projectId: requirePublicationId(source.projectId, 'invoice.projectId'),
    amount: assertExactCentsString(source.amount, 'invoice.amount'),
    invoicedAt: assertExactBusinessDate(source.invoicedAt, 'invoice.invoicedAt'),
    active: source.active,
    revokedAt: source.revokedAt === null ? null : assertExactBusinessDate(source.revokedAt, 'invoice.revokedAt'),
    lastModifiedAt: requirePublicationText(source.lastModifiedAt, 'invoice.lastModifiedAt'),
  };
}

function damageSectionRowFromWorkbench(source: DamageSection): RemoteDamageItemRow {
  return {
    kind: 'damage_items',
    id: requirePublicationId(source.id, 'damage.id'),
    projectId: requirePublicationId(source.projectId, 'damage.projectId'),
    instrumentId: requirePublicationId(source.instrumentId, 'damage.instrumentId'),
    // instrumentName/partNumber 必填（规格未批准空文本）：源端 ''（孤立/缺件）直接
    // metadata-only 拒绝，不静默归一 null、不把空当作可发布值。
    instrumentName: requirePublicationText(source.instrumentName, 'damage.instrumentName'),
    serialNo: requirePublicationNullableText(source.serialNo, 'damage.serialNo'),
    issueStatus: toEnum(source.issueStatus, REMOTE_DAMAGE_STATUSES, 'damage.issueStatus'),
    registeredAt: assertExactBusinessDate(source.registeredAt, 'damage.registeredAt'),
    partNumber: requirePublicationText(source.partNumber, 'damage.partNumber'),
    partQuantity: toCount(source.partQuantity, 'damage.partQuantity'),
    partAmount: assertExactCentsString(source.partAmount, 'damage.partAmount'),
    partCurrency:
      source.partCurrency === null || source.partCurrency === undefined
        ? null
        : toEnum(source.partCurrency, REMOTE_PART_CURRENCIES, 'damage.partCurrency'),
    partStatus: source.partStatus === null || source.partStatus === undefined ? null : toEnum(source.partStatus, REMOTE_PART_STATUSES, 'damage.partStatus'),
  };
}

export function sectionRowFromWorkbench(source: WorkbenchV2SectionRow): RemoteSectionRow {
  switch (source.kind) {
    case 'batches':
      return batchSectionRowFromWorkbench(source);
    case 'instruments':
      return instrumentSectionRowFromWorkbench(source);
    case 'orders':
      return orderSectionRowFromWorkbench(source);
    case 'invoices':
      return invoiceSectionRowFromWorkbench(source);
    case 'damage_items':
      return damageSectionRowFromWorkbench(source);
    // activities 不在投影分区（来源行不进入本函数）。
    default:
      throw new InvalidValueRejection('UNSUPPORTED_SECTION_KIND', `不支持的分区类型`);
  }
}

/** 各分区允许字段名（strict parse 的 allowlist 锚点；供 JSONL/响应/错误边界复用）。 */
export const SECTION_ALLOWED_FIELDS: Record<RemoteSectionKind, readonly string[]> = {
  batches: ['kind', 'id', 'projectId', 'planTransportDate', 'startedAt', 'appliedAt', 'originalPrice', 'discountedPrice'],
  instruments: ['kind', 'id', 'projectId', 'batchId', 'name', 'model', 'serialNo', 'ups', 'qrRequested'],
  orders: ['kind', 'id', 'projectId', 'orderType', 'serviceOrderNo', 'orderedAt'],
  invoices: ['kind', 'id', 'projectId', 'amount', 'invoicedAt', 'active', 'revokedAt', 'lastModifiedAt'],
  damage_items: [
    'kind',
    'id',
    'projectId',
    'instrumentId',
    'instrumentName',
    'serialNo',
    'issueStatus',
    'registeredAt',
    'partNumber',
    'partQuantity',
    'partAmount',
    'partCurrency',
    'partStatus',
  ],
};

export const PROJECT_ALLOWED_FIELDS: readonly string[] = [
  'id',
  'customerName',
  'ecc',
  'tempNo',
  'status',
  'formallyEntered',
  'preEntryExecution',
  'region',
  'regionNeedsAdjustment',
  'planVisitAt',
  'reminderAt',
  'hasReminder',
  'updatedAt',
  'contractAmount',
  'entryAmountSnapshot',
  'finalAmount',
  'invoicedAmount',
  'entryAt',
  'counts',
  'nonBlocking',
];

export const COUNTS_ALLOWED_FIELDS: readonly string[] = ['batches', 'instruments', 'orders', 'repairs', 'invoices'];
export const NON_BLOCKING_ALLOWED_FIELDS: readonly string[] = ['repairs'];

/** 读取技术信封 allowlist（mobile-readonly-workbench 表「读取技术信封」行；诊断字段）。 */
export const ENVELOPE_ALLOWED_FIELDS: readonly string[] = [
  'databaseInstanceId',
  'contentGenerationId',
  'businessRevision',
  'snapshotId',
  'activationId',
  'generatedAt',
  'lastPublishedAt',
  'lastSourceSeenAt',
  'sourceConfirmedAt',
];

/** 分页 allowlist（total / nextCursor / limit / pageSize）。 */
export const PAGING_ALLOWED_FIELDS: readonly string[] = ['total', 'nextCursor', 'limit', 'pageSize'];

/** 分区 allowlist（kind / projectId）。 */
export const PARTITION_ALLOWED_FIELDS: readonly string[] = ['kind', 'projectId'];

/** 概览 DTO 顶层 allowlist（metrics/page/partition）。 */
export const OVERVIEW_DTO_ALLOWED_FIELDS: readonly string[] = [...ENVELOPE_ALLOWED_FIELDS, 'metrics'];

/** 项目列表 DTO 顶层 allowlist（envelope + projects + page）。 */
export const PROJECT_PAGE_DTO_ALLOWED_FIELDS: readonly string[] = [
  ...ENVELOPE_ALLOWED_FIELDS,
  'projects',
  'page',
];

/** 分区页 DTO 顶层 allowlist。 */
export const SECTION_PAGE_DTO_ALLOWED_FIELDS: readonly string[] = [
  ...ENVELOPE_ALLOWED_FIELDS,
  'kind',
  'projectId',
  'rows',
  'page',
];

/** `WorkbenchV2SectionRow` 公共字段 allowlist（kind/id/projectId）。 */
export const SECTION_COMMON_ALLOWED_FIELDS: readonly string[] = ['kind', 'id', 'projectId'];

export const DETAIL_ALLOWED_FIELDS: readonly string[] = [
  'id',
  'contract',
  'facts',
  'reminder',
  'counts',
  'nonBlocking',
  'finance',
];

/** detail.contract 叶子 allowlist（mobile-readonly-workbench 详情合同与计划行）。 */
export const DETAIL_CONTRACT_ALLOWED_FIELDS: readonly string[] = [
  'contractStartDate',
  'contractEndDate',
  'planVisitAt',
  'planTransportAt',
  'plannedInstallAt',
  'actualInstallDoneAt',
];

/** detail.facts 叶子 allowlist（详情准备/范围/终态事实；可空三元布尔/日期）。 */
export const DETAIL_FACTS_ALLOWED_FIELDS: readonly string[] = [
  'managerApproved',
  'siteConfirmed',
  'isTemporaryStorage',
  'acceptanceReport',
  'acceptanceReportDate',
  'temporaryInstrumentCount',
  'temporaryHasUps',
  'cancelledAt',
];

/** detail.reminder 叶子 allowlist（手工提醒仅日期 + 派生存在性）。 */
export const DETAIL_REMINDER_ALLOWED_FIELDS: readonly string[] = ['reminderAt', 'hasReminder'];

/** detail.finance 叶子 allowlist（财务/进单；同 row 的 RemoteProjectFinancial）。 */
export const DETAIL_FINANCE_ALLOWED_FIELDS: readonly string[] = [
  'contractAmount',
  'entryAmountSnapshot',
  'finalAmount',
  'invoicedAmount',
  'entryAt',
];

// ---------------------------------------------------------------------------
// 严格解析：JSON 键 allowlist（未知/重复结构字段拒绝；金额/日期严格格式）
// 说明：本层不检测重复 JSON key（JSON.parse 无法可靠识别；全量 streaming ingress
// 是任务 3.1/3.2 的后置实现依赖，此处不虚构覆盖）。
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], kind: string): void {
  for (const key of Object.keys(obj)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new UnknownFieldRejection(rejectionField(kind, key));
    }
  }
}

/** 必填标识符字段：非空 string，且 ≤128 Unicode 码点（技术 ID 不冒充业务编号）。 */
function requireIdField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidValueRejection('REQUIRED_FIELD', `${key} 必填`);
  }
  return assertRemoteId(value, key) ?? value;
}

/** 必填字符串字段（id/编号等）：非空 string；≤128 码点（标识符语义）。 */
export function requireStringField(record: Record<string, unknown>, key: string): string {
  return requireIdField(record, key);
}

/**
 * wire 可空文本：严格只接受 null/string。
 * - null/undefined → null（缺失的唯一合法编码）；
 * - 非 string（number/object/boolean）→ metadata-only 拒绝（不做任意类型强转）；
 * - '' → metadata-only 拒绝（投影层无「批准空文本」字段；源 DTO 缺失一律 nullString
 *   → null，wire 未填写必须发 null，不得用空串）；
 * - string 非空 → ≤4096 Unicode 码点。
 */
function nullableText(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new InvalidValueRejection('INVALID_TEXT', `${fieldName} 必须是文本或空`);
  }
  if (value === '') {
    throw new InvalidValueRejection('INVALID_TEXT', `${fieldName} 不允许空串（缺失请用 null）`);
  }
  if ([...value].length > MAX_REMOTE_FIELD_CHARS) {
    throw new InvalidValueRejection('FIELD_TOO_LONG', `${fieldName} 超出长度上限`);
  }
  return value;
}

/**
 * wire 可空标识符：严格只接受 null/string；缺失用 null；''/非 string 拒绝；
 * 长度 ≤128 Unicode 码点（技术 ID 不冒充业务编号）。
 */
function nullableIdentifier(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new InvalidValueRejection('INVALID_ID', `${fieldName} 必须是文本或空`);
  }
  if (value === '') {
    throw new InvalidValueRejection('INVALID_ID', `${fieldName} 不允许空串（缺失请用 null）`);
  }
  return assertRemoteId(value, fieldName) ?? value;
}

export function parseRemoteProjectRow(input: unknown): RemoteProjectRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '项目行必须是对象');
  }
  rejectUnknownKeys(input, PROJECT_ALLOWED_FIELDS, 'project');
  const countsRaw = input['counts'];
  const nonBlockingRaw = input['nonBlocking'];
  if (!isPlainObject(countsRaw)) {
    throw new InvalidValueRejection('INVALID_RECORD', '项目 counts 必须是对象');
  }
  if (!isPlainObject(nonBlockingRaw)) {
    throw new InvalidValueRejection('INVALID_RECORD', '项目 nonBlocking 必须是对象');
  }
  rejectUnknownKeys(countsRaw, COUNTS_ALLOWED_FIELDS, 'project.counts');
  rejectUnknownKeys(nonBlockingRaw, NON_BLOCKING_ALLOWED_FIELDS, 'project.nonBlocking');

  const regionRaw = input['region'];
  if (regionRaw !== null && regionRaw !== undefined) {
    if (typeof regionRaw !== 'string' || !(REMOTE_PROJECT_REGIONS as readonly string[]).includes(regionRaw)) {
      throw new InvalidValueRejection('INVALID_REGION', 'project.region 只允许五个固定枚举或 null');
    }
  }

  return {
    id: requireStringField(input, 'id'),
    customerName: toRequiredText(input['customerName'], 'project.customerName'),
    ecc: nullableText(input['ecc'], 'project.ecc'),
    tempNo: toRequiredText(input['tempNo'], 'project.tempNo'),
    status: toEnum(input['status'], REMOTE_PROJECT_STATUSES, 'project.status'),
    formallyEntered: toBoolean(input['formallyEntered'], 'project.formallyEntered'),
    preEntryExecution: toBoolean(input['preEntryExecution'], 'project.preEntryExecution'),
    region: (regionRaw ?? null) as RemoteProjectRegion | null,
    regionNeedsAdjustment: toBoolean(input['regionNeedsAdjustment'], 'project.regionNeedsAdjustment'),
    planVisitAt: toNullableBusinessDate(input['planVisitAt'], 'project.planVisitAt'),
    reminderAt: toNullableBusinessDate(input['reminderAt'], 'project.reminderAt'),
    hasReminder: toBoolean(input['hasReminder'], 'project.hasReminder'),
    updatedAt: toIso(input['updatedAt'], 'project.updatedAt'),
    contractAmount: toNullableExactMoney(input['contractAmount'], 'project.contractAmount'),
    entryAmountSnapshot: toNullableExactMoney(input['entryAmountSnapshot'], 'project.entryAmountSnapshot'),
    finalAmount: toNullableExactMoney(input['finalAmount'], 'project.finalAmount'),
    invoicedAmount: toExactMoney(input['invoicedAmount'], 'project.invoicedAmount'),
    entryAt: toNullableBusinessDate(input['entryAt'], 'project.entryAt'),
    counts: {
      batches: toCount(countsRaw['batches'], 'project.counts.batches'),
      instruments: toCount(countsRaw['instruments'], 'project.counts.instruments'),
      orders: toCount(countsRaw['orders'], 'project.counts.orders'),
      repairs: toCount(countsRaw['repairs'], 'project.counts.repairs'),
      invoices: toCount(countsRaw['invoices'], 'project.counts.invoices'),
    },
    nonBlocking: {
      repairs: toCount(nonBlockingRaw['repairs'], 'project.nonBlocking.repairs'),
    },
  };
}

/**
 * 严格解析 detail.contract（合同与计划）叶子。
 * - contract 本身可为 null（未录入）；但若对象存在则键必须精确等于叶子 allowlist
 *   （未知/未批准键如 plannedInstallDoneAt 旧别名 → UNKNOWN_FIELD 拒绝）。
 */
export function parseRemoteDetailContract(input: unknown): RemoteProjectDetailContract | null {
  if (input === null || input === undefined) return null;
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.contract 必须是对象');
  }
  rejectDetailUnknownKeys(input, DETAIL_CONTRACT_ALLOWED_FIELDS);
  return {
    contractStartDate: toNullableBusinessDate(input['contractStartDate'], 'project.detail.contract.contractStartDate'),
    contractEndDate: toNullableBusinessDate(input['contractEndDate'], 'project.detail.contract.contractEndDate'),
    planVisitAt: toNullableBusinessDate(input['planVisitAt'], 'project.detail.contract.planVisitAt'),
    planTransportAt: toNullableBusinessDate(input['planTransportAt'], 'project.detail.contract.planTransportAt'),
    plannedInstallAt: toNullableBusinessDate(input['plannedInstallAt'], 'project.detail.contract.plannedInstallAt'),
    actualInstallDoneAt: toNullableBusinessDate(input['actualInstallDoneAt'], 'project.detail.contract.actualInstallDoneAt'),
  };
}

/**
 * 严格解析 detail.facts（准备/范围/终态事实）叶子。
 * - 未知键（managerApprovalReason/projectNote/temporaryStorageAddress/cancelReason/
 *   temporaryInstrumentName/Model 等未批准字段）一律 UNKNOWN_FIELD 拒绝；
 * - 可空布尔三元/null 与计数/日期沿用严格 scalar（未知值不 echo）。
 */
export function parseRemoteDetailFacts(input: unknown): RemoteProjectDetailFacts | null {
  if (input === null || input === undefined) return null;
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.facts 必须是对象');
  }
  rejectDetailUnknownKeys(input, DETAIL_FACTS_ALLOWED_FIELDS);
  return {
    managerApproved: toNullableBoolean(input['managerApproved'], 'project.detail.facts.managerApproved'),
    siteConfirmed: toBoolean(input['siteConfirmed'], 'project.detail.facts.siteConfirmed'),
    isTemporaryStorage: toNullableBoolean(input['isTemporaryStorage'], 'project.detail.facts.isTemporaryStorage'),
    acceptanceReport: toBoolean(input['acceptanceReport'], 'project.detail.facts.acceptanceReport'),
    acceptanceReportDate: toNullableBusinessDate(
      input['acceptanceReportDate'],
      'project.detail.facts.acceptanceReportDate',
    ),
    temporaryInstrumentCount:
      input['temporaryInstrumentCount'] === null || input['temporaryInstrumentCount'] === undefined
        ? null
        : toCount(input['temporaryInstrumentCount'], 'project.detail.facts.temporaryInstrumentCount'),
    temporaryHasUps: toNullableBoolean(input['temporaryHasUps'], 'project.detail.facts.temporaryHasUps'),
    cancelledAt: toNullableBusinessDate(input['cancelledAt'], 'project.detail.facts.cancelledAt'),
  };
}

/** 严格解析 detail.reminder 叶子（仅 reminderAt + 派生 hasReminder）。 */
export function parseRemoteDetailReminder(input: unknown): RemoteReminderFacts {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.reminder 必须是对象');
  }
  rejectDetailUnknownKeys(input, DETAIL_REMINDER_ALLOWED_FIELDS);
  return {
    reminderAt: toNullableBusinessDate(input['reminderAt'], 'project.detail.reminder.reminderAt'),
    hasReminder: toBoolean(input['hasReminder'], 'project.detail.reminder.hasReminder'),
  };
}

/** 严格解析 detail.finance 叶子（财务/进单；同 row 财务字段但独立 allowlist）。 */
export function parseRemoteDetailFinance(input: unknown): RemoteProjectFinancial {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.finance 必须是对象');
  }
  rejectDetailUnknownKeys(input, DETAIL_FINANCE_ALLOWED_FIELDS);
  return {
    contractAmount: toNullableExactMoney(input['contractAmount'], 'project.detail.finance.contractAmount'),
    entryAmountSnapshot: toNullableExactMoney(
      input['entryAmountSnapshot'],
      'project.detail.finance.entryAmountSnapshot',
    ),
    finalAmount: toNullableExactMoney(input['finalAmount'], 'project.detail.finance.finalAmount'),
    invoicedAmount: toExactMoney(input['invoicedAmount'], 'project.detail.finance.invoicedAmount'),
    entryAt: toNullableBusinessDate(input['entryAt'], 'project.detail.finance.entryAt'),
  };
}

/** detail 相关未知键统一收束到受控上下文 'project'（rejection 模块 allowlist 不含 detail 组）。 */
function rejectDetailUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  rejectUnknownKeys(obj, allowed, 'project');
}

/**
 * 严格解析项目完整 JSONL 记录的 detail 分组（批准分组 ONLY）：
 * - `detail` 顶层键精确等于 DETAIL_ALLOWED_FIELDS（未知分组 → UNKNOWN_FIELD 拒绝）；
 * - 组内叶子同上；`counts`/`nonBlocking` 复用 row 级严格解析（不含 activities /
 *   pendingShipTo / qrUnmarked）；
 * - contract/facts 允许 null（未录入）；reminder/counts/nonBlocking/finance 必填对象。
 */
export function parseRemoteDetailGroup(input: unknown): RemoteProjectDetailGroup {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail 必须是对象');
  }
  rejectDetailUnknownKeys(input, DETAIL_ALLOWED_FIELDS);
  const countsRaw = input['counts'];
  const nonBlockingRaw = input['nonBlocking'];
  if (!isPlainObject(countsRaw)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.counts 必须是对象');
  }
  if (!isPlainObject(nonBlockingRaw)) {
    throw new InvalidValueRejection('INVALID_RECORD', 'project.detail.nonBlocking 必须是对象');
  }
  rejectDetailUnknownKeys(countsRaw, COUNTS_ALLOWED_FIELDS);
  rejectDetailUnknownKeys(nonBlockingRaw, NON_BLOCKING_ALLOWED_FIELDS);
  return {
    id: requireStringField(input, 'id'),
    contract: parseRemoteDetailContract(input['contract']),
    facts: parseRemoteDetailFacts(input['facts']),
    reminder: parseRemoteDetailReminder(input['reminder']),
    counts: {
      batches: toCount(countsRaw['batches'], 'project.detail.counts.batches'),
      instruments: toCount(countsRaw['instruments'], 'project.detail.counts.instruments'),
      orders: toCount(countsRaw['orders'], 'project.detail.counts.orders'),
      repairs: toCount(countsRaw['repairs'], 'project.detail.counts.repairs'),
      invoices: toCount(countsRaw['invoices'], 'project.detail.counts.invoices'),
    },
    nonBlocking: {
      repairs: toCount(nonBlockingRaw['repairs'], 'project.detail.nonBlocking.repairs'),
    },
    finance: parseRemoteDetailFinance(input['finance']),
  };
}

/**
 * 严格解析项目完整发布记录（{kind:'project', row, detail}）：
 * - 发布记录必须携带 detail 分组（对象）——拒绝「发布记录缺 detail」的退化行；
 * - 顶层仅允许 kind/row/detail（未知键 → UNKNOWN_FIELD 拒绝）；
 * - row 经 parseRemoteProjectRow；detail 经 parseRemoteDetailGroup；
 * - 组间一致性：detail.id 必须与 row.id 完全一致（同一项目实体，防跨实体拼接）。
 */
export function parseRemoteProjectRecord(input: unknown): RemoteProjectRecord {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '项目记录必须是对象');
  }
  rejectUnknownKeys(input, PROJECT_RECORD_ALLOWED_FIELDS, 'jsonl');
  if (input['kind'] !== 'project') {
    throw new InvalidValueRejection('INVALID_ENUM', 'project.kind 必须为 project');
  }
  const detailRaw = input['detail'];
  if (!isPlainObject(detailRaw)) {
    throw new InvalidValueRejection('REQUIRED_FIELD', 'project 发布记录必须携带 detail 分组');
  }
  const row = parseRemoteProjectRow(input['row']);
  const detail = parseRemoteDetailGroup(detailRaw);
  if (detail.id !== row.id) {
    throw new InvalidValueRejection('DETAIL_ID_MISMATCH', 'detail.id 与 row.id 必须一致');
  }
  return { kind: 'project', row, detail };
}

/** 项目完整发布记录顶层 allowlist（kind/row/detail）。 */
const PROJECT_RECORD_ALLOWED_FIELDS: readonly string[] = ['kind', 'row', 'detail'];

export function parseRemoteBatchRow(input: unknown): RemoteBatchRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '批次行必须是对象');
  }
  rejectUnknownKeys(input, SECTION_ALLOWED_FIELDS.batches, 'batch');
  if (input['kind'] !== 'batches') {
    throw new InvalidValueRejection('INVALID_ENUM', 'batch.kind 必须为 batches');
  }
  return {
    kind: 'batches',
    id: requireStringField(input, 'id'),
    projectId: requireStringField(input, 'projectId'),
    planTransportDate: toNullableBusinessDate(input['planTransportDate'], 'batch.planTransportDate'),
    startedAt: toNullableBusinessDate(input['startedAt'], 'batch.startedAt'),
    appliedAt: toNullableBusinessDate(input['appliedAt'], 'batch.appliedAt'),
    originalPrice: toNullableExactMoney(input['originalPrice'], 'batch.originalPrice'),
    discountedPrice: toNullableExactMoney(input['discountedPrice'], 'batch.discountedPrice'),
  };
}

export function parseRemoteInstrumentRow(input: unknown): RemoteInstrumentRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '仪器行必须是对象');
  }
  rejectUnknownKeys(input, SECTION_ALLOWED_FIELDS.instruments, 'instrument');
  if (input['kind'] !== 'instruments') {
    throw new InvalidValueRejection('INVALID_ENUM', 'instrument.kind 必须为 instruments');
  }
  return {
    kind: 'instruments',
    id: requireStringField(input, 'id'),
    projectId: requireStringField(input, 'projectId'),
    batchId: nullableIdentifier(input['batchId'], 'instrument.batchId'),
    name: toRequiredText(input['name'], 'instrument.name'),
    model: nullableText(input['model'], 'instrument.model'),
    serialNo: nullableText(input['serialNo'], 'instrument.serialNo'),
    ups: toBoolean(input['ups'], 'instrument.ups'),
    qrRequested: toBoolean(input['qrRequested'], 'instrument.qrRequested'),
  };
}

export function parseRemoteOrderRow(input: unknown): RemoteOrderRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '开单行必须是对象');
  }
  rejectUnknownKeys(input, SECTION_ALLOWED_FIELDS.orders, 'order');
  if (input['kind'] !== 'orders') {
    throw new InvalidValueRejection('INVALID_ENUM', 'order.kind 必须为 orders');
  }
  return {
    kind: 'orders',
    id: requireStringField(input, 'id'),
    projectId: requireStringField(input, 'projectId'),
    orderType: toEnum(input['orderType'], REMOTE_ORDER_TYPES, 'order.orderType'),
    serviceOrderNo: nullableText(input['serviceOrderNo'], 'order.serviceOrderNo'),
    orderedAt: toBusinessDate(input['orderedAt'], 'order.orderedAt'),
  };
}

export function parseRemoteInvoiceRow(input: unknown): RemoteInvoiceRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '掉票行必须是对象');
  }
  rejectUnknownKeys(input, SECTION_ALLOWED_FIELDS.invoices, 'invoice');
  if (input['kind'] !== 'invoices') {
    throw new InvalidValueRejection('INVALID_ENUM', 'invoice.kind 必须为 invoices');
  }
  return {
    kind: 'invoices',
    id: requireStringField(input, 'id'),
    projectId: requireStringField(input, 'projectId'),
    amount: toExactMoney(input['amount'], 'invoice.amount'),
    invoicedAt: toBusinessDate(input['invoicedAt'], 'invoice.invoicedAt'),
    active: toBoolean(input['active'], 'invoice.active'),
    revokedAt: toNullableBusinessDate(input['revokedAt'], 'invoice.revokedAt'),
    lastModifiedAt: toIso(input['lastModifiedAt'], 'invoice.lastModifiedAt'),
  };
}

export function parseRemoteDamageItemRow(input: unknown): RemoteDamageItemRow {
  if (!isPlainObject(input)) {
    throw new InvalidValueRejection('INVALID_RECORD', '备件事项行必须是对象');
  }
  rejectUnknownKeys(input, SECTION_ALLOWED_FIELDS.damage_items, 'damage');
  if (input['kind'] !== 'damage_items') {
    throw new InvalidValueRejection('INVALID_ENUM', 'damage.kind 必须为 damage_items');
  }
  return {
    kind: 'damage_items',
    id: requireStringField(input, 'id'),
    projectId: requireStringField(input, 'projectId'),
    instrumentId: requireStringField(input, 'instrumentId'),
    instrumentName: toRequiredText(input['instrumentName'], 'damage.instrumentName'),
    serialNo: nullableText(input['serialNo'], 'damage.serialNo'),
    issueStatus: toEnum(input['issueStatus'], REMOTE_DAMAGE_STATUSES, 'damage.issueStatus'),
    registeredAt: toBusinessDate(input['registeredAt'], 'damage.registeredAt'),
    partNumber: toRequiredText(input['partNumber'], 'damage.partNumber'),
    partQuantity: toCount(input['partQuantity'], 'damage.partQuantity'),
    partAmount: toExactMoney(input['partAmount'], 'damage.partAmount'),
    partCurrency: nullableEnum(input['partCurrency'], REMOTE_PART_CURRENCIES, 'damage.partCurrency'),
    partStatus: nullableEnum(input['partStatus'], REMOTE_PART_STATUSES, 'damage.partStatus'),
  };
}

function nullableEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fieldName: string,
): T[number] | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new InvalidValueRejection('INVALID_ENUM', `${fieldName} 枚举值不允许`);
  }
  if (value === '') {
    throw new InvalidValueRejection('INVALID_ENUM', `${fieldName} 不允许空串（缺失请用 null）`);
  }
  return toEnum(value, allowed, fieldName);
}

export function parseRemoteSectionRow(input: unknown, kind: RemoteSectionKind): RemoteSectionRow {
  switch (kind) {
    case 'batches':
      return parseRemoteBatchRow(input);
    case 'instruments':
      return parseRemoteInstrumentRow(input);
    case 'orders':
      return parseRemoteOrderRow(input);
    case 'invoices':
      return parseRemoteInvoiceRow(input);
    case 'damage_items':
      return parseRemoteDamageItemRow(input);
    default:
      throw new InvalidValueRejection('UNSUPPORTED_SECTION_KIND', `不支持的分区类型`);
  }
}

export const PROJECTION_METADATA = {
  /** 读取技术信封（diagnostic）。 */
  envelope: {
    businessRevision: 'monotonic within lineage',
    generatedAt: 'source diagnostic time',
    lastPublishedAt: 'cloud activation time',
    lastSourceSeenAt: 'accepted source report time',
    sourceConfirmedAt: 'source fingerprint == current snapshot time',
  },
  sourceKind: PROJECT_SOURCE_KIND,
  money: 'exact 2-decimal strings; no Number coercion',
  businessDate: 'yyyy-mm-dd strict',
  technicalTime: 'ISO 8601 with offset',
} as const;

export { MOBILE_PAGE_SIZE };
