/**
 * 主进程 ↔ 渲染进程 IPC 通道定义（tasks 1.1 工程骨架）。
 * 渲染层无 Node 访问（contextIsolation + preload contextBridge），
 * 所有数据操作经此处定义的通道由主进程执行。
 */

export const IPC_CHANNELS = {
  /** workbench-access：账号状态查询（无密码个人模式：仅供工作台展示自动备份错误等状态）。 */
  accountGetStatus: 'account:get-status',
  /** workbench-access：当前访问会话查询（主进程启动/恢复时已自动建立，无需登录）。 */
  accountGetSession: 'account:get-session',
  /** local-data-persistence：手动备份/恢复（主进程负责文件选择对话框）。 */
  backupManual: 'backup:manual',
  restoreFromBackup: 'backup:restore',
  /**
   * Oracle #10：工作台 v2 有界读取 + 有界 mutation 结果（旧 snapshot 通道已删除，
   * 工作台只经 v2 bounded API 读写；账号/备份恢复/报表/history import 仍为独立通道）。
   */
  workbenchV2Overview: 'workbench:v2:overview',
  workbenchV2ProjectPage: 'workbench:v2:project-page',
  workbenchV2ProjectDetail: 'workbench:v2:project-detail',
  workbenchV2SectionPage: 'workbench:v2:section-page',
  workbenchV2IndependentPage: 'workbench:v2:independent-page',
  workbenchV2LookupPage: 'workbench:v2:lookup-page',
  workbenchV2HistoryPage: 'workbench:v2:history-page',
  /** 完整提醒视图（tasks 7.3）：全部项目提醒 + 到期分类，按提醒日期 asc/desc（默认 desc）。 */
  workbenchV2ReminderPage: 'workbench:v2:reminder-page',
  /** 提醒泳道（tasks 7.6）：先选日期列、再按列读取项目（列可带独立 cursor，不重算日期集合）。 */
  workbenchV2ReminderLanes: 'workbench:v2:reminder-lanes',
  /** 项目分类标签目录读取（仅返回稳定排序的语义化目录，不暴露持久化表）。 */
  workbenchV2TagCatalog: 'workbench:v2:tag-catalog',
  /** 项目分类标签受控写入：创建分组、创建组内标签、replace-set 项目标签。 */
  workbenchV2TagMutate: 'workbench:v2:tag-mutate',
  workbenchV2Mutate: 'workbench:v2:mutate',
  /** 受保护登记记录删除（判别联合 + 预期业务修订防并发）。 */
  workbenchV2Delete: 'workbench:v2:delete',
  /** 「清理全部业务数据」两阶段 API：prepare 返回计数/短期 token/过期时间/revision；confirm 必须 token + 固定确认文本。 */
  dataCleanPrepare: 'data:clean:prepare',
  dataCleanConfirm: 'data:clean:confirm',
  /** ship-to-management：按 requestId 线性推进的独立命令（不重复新建、不重复计工作量）。 */
  shipToCreateRequest: 'ship-to:create-request',
  shipToSubmitRequest: 'ship-to:submit-request',
  reportBuild: 'report:build',
  reportDrillDown: 'report:drill-down',
  reportExport: 'report:export',
  /** 能力清单（工作台占位展示）。 */
  capabilitiesList: 'capabilities:list',
} as const;

/**
 * 历史数据导入向导 IPC 通道（tasks 8.47~8.53）。
 * 全部通道（除 progress 事件外）统一经 requireSessionAndSender 守卫；
 * progress 为 主进程 → 受信窗口 的只读事件，不提供渲染层反向订阅路径之外的通道。
 */
export const IMPORT_WIZARD_CHANNELS = {
  listDrafts: 'import-wizard:list-drafts',
  createDraft: 'import-wizard:create-draft',
  openDraft: 'import-wizard:open-draft',
  deleteDraft: 'import-wizard:delete-draft',
  saveStep: 'import-wizard:save-step',
  downloadTemplate: 'import-wizard:download-template',
  selectFiles: 'import-wizard:select-files',
  pasteIntoCategory: 'import-wizard:paste-into-category',
  classifySheet: 'import-wizard:classify-sheet',
  setCategoryMode: 'import-wizard:set-category-mode',
  updateMapping: 'import-wizard:update-mapping',
  queryRows: 'import-wizard:query-rows',
  patchCells: 'import-wizard:patch-cells',
  addRow: 'import-wizard:add-row',
  deleteRows: 'import-wizard:delete-rows',
  validate: 'import-wizard:validate',
  saveConflictDecision: 'import-wizard:save-conflict-decision',
  cancelOperation: 'import-wizard:cancel-operation',
  summary: 'import-wizard:summary',
  commit: 'import-wizard:commit',
  settleInterrupted: 'import-wizard:settle-interrupted',
  recover: 'import-wizard:recover',
  /** 磁盘型 undo checkpoint（tasks 8.59/8.66）：列表/撤销/重做。 */
  checkpoints: 'import-wizard:checkpoints',
  undo: 'import-wizard:undo',
  redo: 'import-wizard:redo',
  /** 主进程 → 受信窗口 的只读进度事件（progress 经受信窗口事件）。 */
  progressEvent: 'import-wizard:progress',
} as const;

export type ImportWizardChannel = (typeof IMPORT_WIZARD_CHANNELS)[keyof typeof IMPORT_WIZARD_CHANNELS];

// ---------------------------------------------------------------------------
// 历史数据导入向导 DTO（tasks 8.47~8.53）
// 金额/摘要一律为十进制字符串（分整数由主进程精确格式化），禁止 Number 参与金额运算。
// ---------------------------------------------------------------------------

/** 渲染层目标类别（与领域 7 类一一对应；供应商仅作物流参考，不构成类别）。 */
export type ImportWizardCategory =
  | 'projects'
  | 'serviceOrders'
  | 'invoices'
  | 'logistics'
  | 'serialAddresses'
  | 'qrRequests'
  | 'shipToRequests';

export type ImportWizardStepId = 'prepare' | 'projects' | 'orders' | 'finance' | 'serials' | 'requests' | 'review';
export type ImportWizardStepState = 'not_started' | 'processing' | 'passed' | 'warning' | 'blocked';
export type ImportWizardSaveState = 'saving' | 'saved' | 'failed';
export type ImportWizardCategoryMode = 'data' | 'none' | 'undecided';
export type ImportWizardIssueKind = 'error' | 'conflict' | 'warning';
export type ImportWizardSheetStatus = 'recognized' | 'unknown' | 'empty' | 'excluded';
export type ImportWizardMappingState = 'exact' | 'alias' | 'manual' | 'unused';
export type ImportWizardOperationKind = 'reading' | 'normalizing' | 'validating' | 'submitting';

export interface ImportWizardGridColumnDto {
  id: string;
  label: string;
  width?: number;
  frozen?: boolean;
  businessKey?: boolean;
  readOnly?: boolean;
}

export interface ImportWizardDraftDto {
  id: string;
  name: string;
  currentStep: ImportWizardStepId;
  totalRows: number;
  issueCount: number;
  saveState: ImportWizardSaveState;
  /** 审计/技术更新时间（精确 ISO）。 */
  updatedAt: string;
}

export interface ImportWizardCategoryDto {
  category: ImportWizardCategory;
  mode: ImportWizardCategoryMode;
  count: number;
  columns: readonly ImportWizardGridColumnDto[];
}

export interface ImportWizardStepDto {
  id: ImportWizardStepId;
  state: ImportWizardStepState;
  errorCount: number;
}

export interface ImportWizardSheetDto {
  id: string;
  fileName: string;
  sheetName: string;
  rowCount: number;
  category: ImportWizardCategory | null;
  status: ImportWizardSheetStatus;
}

export interface ImportWizardMappingDto {
  id: string;
  category: ImportWizardCategory;
  source: string;
  target: string | null;
  targetOptions: readonly { id: string; label: string }[];
  match: ImportWizardMappingState;
  sample: string;
  priority?: number;
  affectedRows?: number;
}

export interface ImportWizardCandidateDto {
  value: string;
  source: string;
}

export interface ImportWizardIssueDto {
  id: string;
  kind: ImportWizardIssueKind;
  category: ImportWizardCategory;
  step: ImportWizardStepId;
  rowIndex: number;
  columnId: string;
  field: string;
  message: string;
  source: string;
  candidates?: readonly ImportWizardCandidateDto[];
}

export interface ImportWizardEccDto {
  ecc: string;
  projects: number;
  serviceOrders: number;
  invoices: number;
  logistics: number;
  sources: number;
}

export interface ImportWizardValidationCategoryDto {
  category: ImportWizardCategory;
  add: number;
  match: number;
  correct: number;
  skip: number;
  warning: number;
  blocked: number;
}

export interface ImportWizardAmountTotalDto {
  label: string;
  value: string;
}

export interface ImportWizardFinalSummaryDto {
  categories: readonly ImportWizardValidationCategoryDto[];
  eccProjects: number;
  independentRecords: number;
  amountTotals: readonly ImportWizardAmountTotalDto[];
  excludedSources: number;
  confirmedBy: string;
  seal: string | null;
  sealValid: boolean;
  validationComplete: boolean;
  warningCount: number;
  blockingCount: number;
}

export interface ImportWizardOperationDto {
  id: string;
  kind: ImportWizardOperationKind;
  label: string;
  processed: number;
  total: number | null;
  cancelable: boolean;
}

export interface ImportWizardWorkspaceDto {
  draft: ImportWizardDraftDto;
  username: string;
  templateVersion: string;
  currentStep: ImportWizardStepId;
  steps: readonly ImportWizardStepDto[];
  categories: readonly ImportWizardCategoryDto[];
  sheets: readonly ImportWizardSheetDto[];
  mappings: readonly ImportWizardMappingDto[];
  issues: readonly ImportWizardIssueDto[];
  ecc: readonly ImportWizardEccDto[];
  summary: ImportWizardFinalSummaryDto | null;
  operation: ImportWizardOperationDto | null;
}

export interface ImportWizardSubmitResultDto {
  status: 'success' | 'failed' | 'unknown';
  title: string;
  message: string;
  importedCounts?: Partial<Record<ImportWizardCategory, number>>;
}

export interface ImportWizardGridIssueDto {
  id: string;
  kind: ImportWizardIssueKind;
  message: string;
  rowIndex: number;
  columnId: string;
  source?: string;
}

export interface ImportWizardGridRowDto {
  id: string;
  values: Record<string, string | null>;
  issues?: readonly ImportWizardGridIssueDto[];
  readOnlyColumns?: readonly string[];
}

export interface ImportWizardGridWindowDto {
  rows: readonly ImportWizardGridRowDto[];
  total: number;
  offset: number;
  limit: number;
}

export interface ImportWizardGridPatchDto {
  rowIndex: number;
  rowId?: string;
  columnId: string;
  value: string;
}

export interface ImportWizardRowWindowRequestDto {
  draftId: string;
  category: ImportWizardCategory;
  offset: number;
  limit: number;
  businessKey?: string | null;
  issueSeverity?: 'error' | 'conflict' | 'warning' | null;
}

export interface ImportWizardProgressEventDto {
  draftId: string;
  operationId: string;
  kind: ImportWizardOperationKind;
  stage: string | null;
  processed: number;
  total: number | null;
  state: 'running' | 'cancelled' | 'completed' | 'failed';
}

export interface ImportWizardRecoverDto {
  recovered: Array<{ draftId: string; from: string; to: string }>;
  pendingOutcome: string[];
}

/** checkpoint 摘要 DTO（不含敏感快照值；供撤销栈展示）。 */
export interface ImportWizardCheckpointDto {
  id: string;
  kind: 'pre' | 'post' | 'manual';
  label: string | null;
  baseRevision: number;
  state: 'active' | 'undone';
  /** 审计/技术创建时间（精确 ISO）。 */
  createdAt: string;
}

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

// ---------------------------------------------------------------------------
// 移动只读发布（桌面）—— 状态/配置/启停 IPC 契约（tasks 1.3）
// 仅含非 secret 状态：configured/启用/目标 origin/最近成功/最近失败规范化码/运行提示。
// 任何 IPC 响应绝不返回上传 token 或其它 secret；接线层在后续 lane 注册处理器。
// ---------------------------------------------------------------------------

export const MOBILE_READONLY_CHANNELS = {
  /** 只读发布状态查询。 */
  status: 'mobile-readonly:status',
  /** 一次性受信配置（HTTPS 目标 + 上传 token 只写不回显）。 */
  configure: 'mobile-readonly:configure',
  /** 显式启停发布。 */
  setEnabled: 'mobile-readonly:set-enabled',
} as const;

export type MobileReadonlyChannel =
  (typeof MOBILE_READONLY_CHANNELS)[keyof typeof MOBILE_READONLY_CHANNELS];

/** 只读发布本地运行提示（非远程失败码；null=正常）。 */
export type MobileReadonlyStatusIssue =
  | 'config_corrupt'
  | 'credential_unavailable'
  | 'state_unwritable'
  | 'not_configured'
  | 'runtime_unavailable';

/** 只读发布状态 DTO（无 secret；target 仅展示 origin）。 */
export interface MobileReadonlyStatusDto {
  /** 一次性配置是否完成（固定 HTTPS 目标 + 上传凭证密文均已保存）。 */
  configured: boolean;
  /** 是否有效启用（持久化 enabled 且配置/凭证可用；配置损坏自动禁用外发）。 */
  enabled: boolean;
  /** 配置目标 origin（无尾斜杠；未配置/损坏为 null）。 */
  target: string | null;
  /** 最近成功发布时刻（ISO）；"无新发布"时保留上一次成功值。 */
  lastSuccessfulAt: string | null;
  /** 最近失败规范化错误码（失败刷新；成功后清除）。 */
  lastFailedCode: string | null;
  /** 最近失败时刻（ISO）。 */
  lastFailedAt: string | null;
  /** 本地运行提示（config/credential/state 类）；null=正常。 */
  issue: MobileReadonlyStatusIssue | null;
}

/** 一次性受信配置输入（token 只写不回显；长度由主进程校验非空）。 */
export interface MobileReadonlyConfigureInput {
  /** 固定 HTTPS origin（无凭据/query/hash/路径）。 */
  target: string;
  /** 独立上传凭证（明文只用于加密保存，永不返回/记录）。 */
  token: string;
}

/** 发布启停输入。 */
export interface MobileReadonlySetEnabledInput {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// 项目区域固定枚举（唯一共享来源：src/shared/project-fields.ts，tasks 2.4/2.5）。
// 领域写边界 trim + 严格校验（parseProjectRegion）；存量 legacy 非枚举区域
// 保留原值并以 regionNeedsAdjustment 显式标记（不猜测映射）。
// ---------------------------------------------------------------------------
export {
  PROJECT_REGIONS,
  REGION_PENDING_ADJUSTMENT,
  isProjectRegion,
} from './project-fields';
export type { ProjectRegion } from './project-fields';

/** 访问会话的对外形状（不暴露口令与恢复码派生值）。 */
export interface AccountSessionInfo {
  accountId: string;
  username: string;
}

export type ProjectStatus =
  | 'pending_entry'
  | 'pending_execution'
  | 'executing'
  | 'under_repair'
  | 'pending_acceptance'
  | 'pending_invoice'
  | 'completed'
  | 'cancelled';

/**
 * 人工主状态调整可选的七种非终止状态。
 * 取消（cancelled）只能通过 cancelProject 专用命令（须提供取消时间与原因），
 * adjustStatus 拒绝 cancelled。
 * 维修中（under_repair）仅由人工选择进入/离开，不参与自动触发。
 */
export type AdjustableProjectStatus = Exclude<ProjectStatus, 'cancelled'>;

/** 手动备份/恢复结果（主进程 file dialog；canceled = 用户取消对话框）。 */
export interface BackupManualResult {
  canceled: boolean;
  /** 手动备份文件完整路径（canceled 时为空）。 */
  path?: string;
}

export interface RestoreResultDto {
  canceled: boolean;
  /**
   * 恢复成功（此时主进程已重建数据库，并重新取得/确保本地账号、恢复访问会话；
   * 无密码个人模式下不要求重新登录）。
   */
  restored?: boolean;
}

/** Ship-to 申请线性状态（待提交 → 处理中 → 已完成，不支持退回或取消）。 */
export type ShipToRequestStatus = 'pending_submit' | 'processing' | 'completed';

/** Ship-to 申请 DTO（typed IPC 返回，供表单展示返回/当前状态）。 */
export interface ShipToRequestDto {
  id: string;
  customerName: string;
  newSiteAddress: string;
  /** 创建时可空；进入已完成前必填，补入后全局唯一。 */
  accountId: string | null;
  status: ShipToRequestStatus;
  /** 首次实际提交日期（业务日期 yyyy-mm-dd，计一次工作量的归属月份）。 */
  submittedAt: string | null;
  /** 完成日期（业务日期 yyyy-mm-dd）。 */
  completedAt: string | null;
}

/** Ship-to 申请创建输入：仅客户名称与新址地址（不关联搬迁仪器、不保存地址快照）。 */
export interface ShipToRequestInputDto {
  customerName: string;
  newSiteAddress: string;
}

/** Ship-to 申请操作结果：仅返回受影响申请记录（Oracle #10 起不携带任何工作台快照）。 */
export interface ShipToRequestResultDto {
  request: ShipToRequestDto;
}

export interface WorkbenchProjectRow {
  id: string;
  tempNo: string;
  ecc: string | null;
  customerName: string;
  status: ProjectStatus;
  formallyEntered: boolean;
  preEntryExecution: boolean;
  /** 区域原值（trim 后保存的规范化枚举；存量 legacy 非枚举文本保留原文）。 */
  region: string | null;
  /** 存量 legacy 非枚举区域显式标记：true = 原值不属于五个固定枚举、归入「待调整」（不猜测映射）。 */
  regionNeedsAdjustment: boolean;
  /** 进单日期（业务日期 yyyy-mm-dd）。 */
  entryAt: string | null;
  /** 项目级计划上门日期（业务日期 yyyy-mm-dd；直接映射 projects.plan_visit_at，不聚合 activities.visit_at）。 */
  planVisitAt: string | null;
  /** 项目提醒日期（业务日期 yyyy-mm-dd）。 */
  reminderAt: string | null;
  reminderNote: string | null;
  reminderDueClass: 'upcoming' | 'today' | 'overdue' | null;
  /**
   * 金额一律为十进制字符串（如 "1234.57"、"0.00"），由主进程以分整数精确格式化；
   * 禁止渲染层用 Number 参与金额计算（计数/百分比除外）。
   */
  finalAmount: string | null;
  invoicedAmount: string;
  contractAmount: string | null;
  /** 正式进单时固化的合同金额快照；草稿或未录金额时为 null。 */
  entryAmountSnapshot: string | null;
  /** invoices 包含已撤销的掉票历史，供关联事实浏览。 */
  counts: { batches: number; instruments: number; activities: number; orders: number; repairs: number; invoices: number };
  nonBlocking: { pendingShipTo: number; qrUnmarked: number; repairs: number };
  /** 项目分类标签 ID；缺省表示由旧实现返回，空数组表示项目未关联分类标签。 */
  tagIds?: readonly string[];
  /** 项目分类标签的轻量按组摘要；顺序与标签目录一致，不包含目录中未选标签。 */
  groupedTags?: readonly ProjectTagGroupSummaryDto[];
  /** 审计/技术更新时间（精确 ISO）。 */
  updatedAt: string;
}

/** 提醒到期分类（与 workbench-todos classifyReminder 同口径）。 */
export type WorkbenchReminderDueClass = 'upcoming' | 'today' | 'overdue';

// ---------------------------------------------------------------------------
// Oracle #10：工作台 v2 有界读取 / mutation DTO
// - 每个 v2 响应 DTO 均携带 businessRevision（database_metadata 业务修订）；
// - 金额一律十进制字符串（主进程分整数精确格式化，禁止 Number 参与金额运算）；
// - 读取全部为有界分页（keyset id 游标 + total），禁止全量快照与 JS P×C。
// ---------------------------------------------------------------------------

/** 全局标签分组定义；catalog 中 groups 按 sortOrder、id 稳定排序。 */
export interface ProjectTagGroupDto {
  id: string;
  name: string;
  sortOrder: number;
  /** 组内 tags 按 sortOrder、id 稳定排序。 */
  tags: readonly ProjectTagDto[];
}

/** 全局可复用的组内标签定义。 */
export interface ProjectTagDto {
  id: string;
  groupId: string;
  name: string;
  sortOrder: number;
}

/** 项目已关联标签的轻量按组展示摘要；不携带目录排序或未选标签。 */
export interface ProjectTagGroupSummaryDto {
  groupId: string;
  groupName: string;
  tagIds: readonly string[];
  tagNames: readonly string[];
}

/** 标签目录读取；提供 projectId 时同时返回该项目当前的选中 tagIds。 */
export interface ProjectTagCatalogRequestDto {
  projectId?: string | null;
}

/** 标签目录读取结果；groups 与其 tags 均为稳定顺序。 */
export interface ProjectTagCatalogDto {
  businessRevision: number;
  groups: readonly ProjectTagGroupDto[];
  /** projectId 未提供时为空数组；提供时为该项目已关联标签的稳定排序 ID 集合。 */
  selectedTagIds: readonly string[];
}

/** 创建全局标签分组（名称由主进程 trim 后校验；未指定排序时追加到末尾）。 */
export interface CreateProjectTagGroupRequestDto {
  name: string;
  sortOrder?: number;
}

/** 在指定全局分组中创建标签（名称由主进程 trim 后校验；未指定排序时追加到末尾）。 */
export interface CreateProjectTagRequestDto {
  groupId: string;
  name: string;
  sortOrder?: number;
}

/** replace-set 项目标签：最终关联严格等于去重、验证后的 tagIds 集合。 */
export interface ReplaceProjectTagSetRequestDto {
  projectId: string;
  tagIds: readonly string[];
}

/** 重命名全局标签分组；稳定 ID 和排序均保持不变。 */
export interface RenameProjectTagGroupRequestDto {
  groupId: string;
  name: string;
}

/** 重命名全局标签；稳定 ID、所属分组和排序均保持不变。 */
export interface RenameProjectTagRequestDto {
  tagId: string;
  name: string;
}

/** 标签写入命令；仅支持创建、重命名及项目 replace-set，不支持删除、移动或重排。 */
export type ProjectTagMutationRequestDto =
  | { command: 'create_group'; payload: CreateProjectTagGroupRequestDto }
  | { command: 'create_tag'; payload: CreateProjectTagRequestDto }
  | { command: 'rename_group'; payload: RenameProjectTagGroupRequestDto }
  | { command: 'rename_tag'; payload: RenameProjectTagRequestDto }
  | { command: 'replace_project_tags'; payload: ReplaceProjectTagSetRequestDto };

/** 创建全局标签分组后的结果。 */
export interface CreateProjectTagGroupResultDto {
  businessRevision: number;
  group: ProjectTagGroupDto;
  invalidated: readonly WorkbenchV2InvalidateTag[];
}

/** 创建组内标签后的结果。 */
export interface CreateProjectTagResultDto {
  businessRevision: number;
  group: ProjectTagGroupDto;
  tag: ProjectTagDto;
  invalidated: readonly WorkbenchV2InvalidateTag[];
}

/** replace-set 后的规范化项目标签视图，供队列、详情和当前上下文刷新。 */
export interface ReplaceProjectTagSetResultDto {
  businessRevision: number;
  projectId: string;
  tagIds: readonly string[];
  groupedTags: readonly ProjectTagGroupSummaryDto[];
  invalidated: readonly WorkbenchV2InvalidateTag[];
}

/** 分组重命名后的有界结果。 */
export interface RenameProjectTagGroupResultDto {
  businessRevision: number;
  group: ProjectTagGroupDto;
  invalidated: readonly WorkbenchV2InvalidateTag[];
}

export interface RenameProjectTagResultDto {
  businessRevision: number;
  tag: ProjectTagDto;
  invalidated: readonly WorkbenchV2InvalidateTag[];
}

export type ProjectTagMutationResultDto =
  | CreateProjectTagGroupResultDto
  | CreateProjectTagResultDto
  | ReplaceProjectTagSetResultDto
  | RenameProjectTagGroupResultDto
  | RenameProjectTagResultDto;

/** 项目分类标签写入失败稳定错误码；IPC 通过 IpcEnvelope 序列化。 */
export const PROJECT_TAG_REJECTION_CODES = {
  GROUP_NAME_EMPTY: 'PROJECT_TAG_GROUP_NAME_EMPTY',
  GROUP_NAME_DUPLICATE: 'PROJECT_TAG_GROUP_NAME_DUPLICATE',
  TAG_NAME_EMPTY: 'PROJECT_TAG_NAME_EMPTY',
  TAG_NAME_DUPLICATE: 'PROJECT_TAG_NAME_DUPLICATE',
  UNKNOWN_GROUP: 'PROJECT_TAG_UNKNOWN_GROUP',
  UNKNOWN_TAG: 'PROJECT_TAG_UNKNOWN_TAG',
  UNKNOWN_PROJECT: 'PROJECT_TAG_UNKNOWN_PROJECT',
} as const;

export type ProjectTagRejectionCode = (typeof PROJECT_TAG_REJECTION_CODES)[keyof typeof PROJECT_TAG_REJECTION_CODES];

/** v2 分页请求公共字段：默认 50，最大 100。 */
export interface WorkbenchV2PageRequest {
  limit?: number;
  /** 上一页返回的 nextCursor（首页为空）。 */
  cursor?: string | null;
}

/**
 * 项目 keyset 分页请求（tasks 7.5 / design D9）。
 * 主进程固定每页 20 个；运行时结构化 IPC 会忽略 legacy 多余字段，新 UI 不应提交。
 * sort 默认 updated（稳定 id 游标）。
 */
export interface WorkbenchV2ProjectPageRequest {
  /** 上一页返回的 nextCursor（首页为空）。 */
  cursor?: string | null;
  status?: ProjectStatus | null;
  region?: string | null;
  /** 客户名称 / 临时编号 / ECC 模糊查询。 */
  query?: string | null;
  /** 提醒过滤：any=有提醒；overdue/today/upcoming=到期分类（与纯函数同口径）。 */
  reminder?: 'any' | 'overdue' | 'today' | 'upcoming' | null;
  /**
   * 维修伪筛选：open=存在开放维修事项（与项目行 repairsPending 同口径：
   * 事项状态未修复且未关闭未修复），不是项目主状态。
   */
  repair?: 'open' | null;
  /** visit_asc / visit_desc 按计划上门日期排序，未填写日期始终置后。 */
  sort?: 'updated' | 'created' | 'temp' | 'reminder' | 'visit_asc' | 'visit_desc' | null;
}

export interface WorkbenchV2ProjectPageDto {
  businessRevision: number;
  projects: readonly WorkbenchProjectRow[];
  total: number;
  nextCursor: string | null;
  /** 固定每页 20（主进程统一；renderer 请求的 limit 被忽略）。 */
  limit: number;
  /** 固定每页 20 的显式契约字段（与 limit 同值；新 UI 可优先使用）。 */
  pageSize?: number;
}

/** 首页/概览 DTO（bounded：提醒预览最多 6 条，其余为聚合指标）。 */
export interface WorkbenchV2OverviewDto {
  businessRevision: number;
  /** 审计/技术生成时间（精确 ISO）。 */
  generatedAt: string;
  metrics: {
    totalProjects: number;
    /** 未完成且未取消。 */
    activeProjects: number;
    /** 有当前提醒（时间或备注任一）的项目数。 */
    reminderCount: number;
    reminderOverdue: number;
    reminderToday: number;
    pendingAcceptance: number;
    pendingInvoice: number;
    /** 存在开放维修事项（事项状态未修复且未关闭未修复）的项目数（EXISTS 口径）。 */
    openRepairProjects: number;
    /** 待掉票金额（已进单且未取消项目 最终可确认金额-累计有效掉票 之和），十进制字符串。 */
    pendingAmount: string;
  };
  stages: Array<{ status: ProjectStatus; count: number; averageDays: number }>;
  reminderPreview: Array<{
    projectId: string;
    customerName: string;
    ecc: string | null;
    tempNo: string;
    /** 项目提醒日期（业务日期 yyyy-mm-dd）。 */
    reminderAt: string | null;
    reminderNote: string | null;
    reminderDueClass: WorkbenchReminderDueClass | null;
  }>;
  reminderTotal: number;
  reminderWindowDays: number;
}

export interface WorkbenchV2ProjectDetailDto {
  businessRevision: number;
  project: WorkbenchProjectRow | null;
  /** 详情/当前上下文的规范化标签视图；兼容旧返回时可从 project 同名字段读取。 */
  tagIds?: readonly string[];
  groupedTags?: readonly ProjectTagGroupSummaryDto[];
  detail: {
    managerApprovalReason: string | null;
    managerApprovalMissing: string | null;
    /** 是否批复（v15 新增可空 boolean 事实；空 = 未填写）。 */
    managerApproved: boolean | null;
    /** 项目备注（可空；建档后补充/修改不影响主状态）。 */
    projectNote: string | null;
    /** 暂存地址（可空；手工维护执行事实，不触发主状态流转）。 */
    temporaryStorageAddress: string | null;
    /** 是否暂存（可空；空表示「未填写」而非推断「否」）。 */
    isTemporaryStorage: boolean | null;
    oldSiteContact: string | null;
    newSiteContact: string | null;
    oldSiteAddress: string | null;
    newSiteAddress: string | null;
    /** 合同开始日期（业务日期 yyyy-mm-dd）。 */
    contractStartDate: string | null;
    /** 合同截止日期（业务日期 yyyy-mm-dd）。 */
    contractEndDate: string | null;
    /** 计划上门日期（业务日期 yyyy-mm-dd）。 */
    planVisitAt: string | null;
    /** 计划运输日期（业务日期 yyyy-mm-dd）。 */
    planTransportAt: string | null;
    /** 计划装机日期（业务日期 yyyy-mm-dd；独立字段，不触发生命周期）。
     *  公开字段名（「计划装机日期」更名后的契约字段）。 */
    plannedInstallAt: string | null;
    /** @deprecated 兼容读取 alias：同 plannedInstallAt（「计划装机完成日期」旧名）；
     *  新 UI 应使用 plannedInstallAt。 */
    plannedInstallDoneAt: string | null;
    siteConfirmed: boolean;
    /** 实际装机完成日期（业务日期 yyyy-mm-dd）。 */
    actualInstallDoneAt: string | null;
    acceptanceReport: boolean;
    /** 验收报告形成日期（业务日期 yyyy-mm-dd）。 */
    acceptanceReportDate: string | null;
    /** 取消日期（业务日期 yyyy-mm-dd）。 */
    cancelledAt: string | null;
    cancelReason: string | null;
    temporaryInstrumentCount: number | null;
    /** 暂定仪器范围：暂定仪器名称（可空；手工维护标量事实，不建仪器、不触发主状态）。 */
    temporaryInstrumentName: string | null;
    /** 暂定仪器范围：暂定仪器型号（可空；手工维护标量事实，不建仪器、不触发主状态）。 */
    temporaryInstrumentModel: string | null;
    /** 暂定仪器范围：是否配备 UPS（可空；null=未填写、false=否、true=是）。 */
    temporaryHasUps: boolean | null;
    /** 审计/技术创建时间（精确 ISO）。 */
    createdAt: string;
    customerId: string | null;
    contractId: string | null;
  } | null;
}

/** 项目详情当前 tab 的子记录类型。 */
export type WorkbenchV2SectionKind =
  | 'batches'
  | 'instruments'
  | 'activities'
  | 'orders'
  | 'invoices'
  | 'damage_items';

export interface WorkbenchV2SectionPageRequest extends WorkbenchV2PageRequest {
  projectId: string;
  kind: WorkbenchV2SectionKind;
  /**
   * 往期/时间筛选：起止业务日期（yyyy-mm-dd，含边界）。
   * 按各 kind 的业务日期过滤：batches→计划运输日期、instruments→登记时间（created_at）、
   * activities→到访日期、orders→开单日期、invoices→掉票日期、damage_items→事项登记日期。
   * 缺省（均未提供）时保持当前行为（不限时间）。
   */
  from?: string | null;
  to?: string | null;
}

export type WorkbenchV2SectionRow =
  | {
      kind: 'batches';
      id: string;
      projectId: string;
      /** 计划运输日期（业务日期 yyyy-mm-dd）。 */
      planTransportDate: string | null;
      transportCompany: string | null;
      originalPrice: string | null;
      discountedPrice: string | null;
      /**
       * 物流费用申请（登记）日期（业务日期 yyyy-mm-dd）；LEFT JOIN 取该批次唯一
       * 费用记录，无费用记录时 null（有界读取不因缺 fee 漏行）。
       */
      appliedAt: string | null;
      /** 开始运输日期（业务日期 yyyy-mm-dd；null = 未开始）。 */
      startedAt: string | null;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'instruments';
      id: string;
      projectId: string;
      batchId: string | null;
      name: string;
      model: string | null;
      manufacturer: string | null;
      serviceLevel: string | null;
      serialNo: string | null;
      ups: boolean;
      qrRequested: boolean;
      destinationShipToId: string | null;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'activities';
      id: string;
      projectId: string;
      /** 到访日期（业务日期 yyyy-mm-dd）。 */
      visitAt: string | null;
      engineers: string;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'orders';
      id: string;
      projectId: string | null;
      orderType: 'relocation' | 'certification' | 'parts_by_mail' | 'pm';
      serviceOrderNo: string | null;
      /** 开单日期（业务日期 yyyy-mm-dd）。 */
      orderedAt: string;
      /** 参与工程师（可空，允许后续补录）。 */
      engineer: string | null;
      customerName: string;
      note: string | null;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'invoices';
      id: string;
      projectId: string;
      amount: string;
      /** 掉票日期（业务日期 yyyy-mm-dd）。 */
      invoicedAt: string;
      active: boolean;
      /** 撤销日期（业务日期 yyyy-mm-dd）。 */
      revokedAt: string | null;
      revokeReason: string | null;
      /** 审计/技术最后修改时间（精确 ISO）。 */
      lastModifiedAt: string;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'damage_items';
      id: string;
      projectId: string;
      instrumentId: string;
      instrumentName: string;
      serialNo: string | null;
      damageReason: string | null;
      issueStatus: string;
      partNumber: string;
      partQuantity: number;
      partAmount: string;
      partCurrency: string | null;
      partStatus: string | null;
      /** 事项登记日期（业务日期 yyyy-mm-dd）。 */
      registeredAt: string;
      repairNote: string | null;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    };

export interface WorkbenchV2SectionPageDto {
  businessRevision: number;
  kind: WorkbenchV2SectionKind;
  projectId: string;
  rows: readonly WorkbenchV2SectionRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** 独立模块（序列号地址更新 / 二维码申请）记录类型。 */
export type WorkbenchV2IndependentKind = 'serial_address' | 'qr_request';

export interface WorkbenchV2IndependentPageRequest extends WorkbenchV2PageRequest {
  kind: WorkbenchV2IndependentKind;
  query?: string | null;
  /**
   * 往期/时间筛选：起止业务日期（yyyy-mm-dd，含边界）。
   * serial_address 按更新日期（updated_at）、qr_request 按申请日期（requested_at）。
   * 缺省（均未提供）时保持当前行为（不限时间）。
   */
  from?: string | null;
  to?: string | null;
}

export type WorkbenchV2IndependentRow =
  | {
      kind: 'serial_address';
      id: string;
      /** 关联搬迁仪器；独立保存（无仪器）时 null，绝不输出字符串 "null"。 */
      instrumentId: string | null;
      /** 关联仪器名称；独立保存（无仪器）时为空串。 */
      instrumentName: string;
      serialNo: string;
      customerName: string;
      newSiteAddress: string;
      accountId: string;
      /** 业务更新日期（yyyy-mm-dd；序列号地址更新为业务事实，非审计时间）。 */
      updatedAt: string;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'qr_request';
      id: string;
      applicant: string;
      /** 申请日期（业务日期 yyyy-mm-dd）。 */
      requestedAt: string;
      types: readonly string[];
      workload: number;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    };

export interface WorkbenchV2IndependentPageDto {
  businessRevision: number;
  kind: WorkbenchV2IndependentKind;
  rows: readonly WorkbenchV2IndependentRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** lookup 分页（Ship-to 申请按客户 / 客户按名称）。 */
export type WorkbenchV2LookupKind = 'ship_to_requests' | 'customers';

export interface WorkbenchV2LookupPageRequest extends WorkbenchV2PageRequest {
  kind: WorkbenchV2LookupKind;
  query?: string | null;
  /**
   * 往期/时间筛选：起止业务日期（yyyy-mm-dd，含边界）。
   * ship_to_requests 按首次实际提交日期（submitted_at）、customers 按登记时间（created_at）。
   * 缺省（均未提供）时保持当前行为（不限时间）。
   */
  from?: string | null;
  to?: string | null;
}

export type WorkbenchV2LookupRow =
  | {
      kind: 'ship_to_requests';
      id: string;
      customerName: string;
      newSiteAddress: string;
      accountId: string | null;
      status: ShipToRequestStatus;
      /** 首次实际提交日期（业务日期 yyyy-mm-dd）。 */
      submittedAt: string | null;
      /** 完成日期（业务日期 yyyy-mm-dd）。 */
      completedAt: string | null;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    }
  | {
      kind: 'customers';
      id: string;
      name: string;
      /** 审计/技术创建时间（精确 ISO）。 */
      createdAt: string;
    };

export interface WorkbenchV2LookupPageDto {
  businessRevision: number;
  kind: WorkbenchV2LookupKind;
  rows: readonly WorkbenchV2LookupRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

// ---------------------------------------------------------------------------
// 跨项目历史有界分页（ora-1：#6 真正的跨项目历史浏览，不做「选项目切换」全量）
// - 覆盖快速记录当前模块：batch / instrument / activity / service_order / invoice /
//   damage，以及可行的 acceptance（项目验收）与 ship_to_request（Ship-to 申请）；
// - 支持 kind / from / to（业务日期 yyyy-mm-dd，含边界；created_at 类按日期部分
//   比较，保证 to 截止日期包含当天）/ cursor / limit；
// - 每行返回项目标识/客户名/ECC 等可读上下文，以及可直接用于 v2Delete 的 id。
// ---------------------------------------------------------------------------

export type WorkbenchV2HistoryKind =
  | 'batch'
  | 'instrument'
  | 'activity'
  | 'service_order'
  | 'invoice'
  | 'damage'
  | 'acceptance'
  | 'ship_to_request';

export interface WorkbenchV2HistoryPageRequest extends WorkbenchV2PageRequest {
  kind: WorkbenchV2HistoryKind;
  /** 起止业务日期（yyyy-mm-dd，含边界）；缺省不限时间。 */
  from?: string | null;
  to?: string | null;
}

export type WorkbenchV2HistoryRow =
  | {
      kind: 'batch';
      /** 可用于 v2Delete 的记录 id。 */
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      planTransportDate: string | null;
      transportCompany: string | null;
      startedAt: string | null;
      businessDate: string | null;
      createdAt: string;
    }
  | {
      kind: 'instrument';
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      name: string;
      model: string | null;
      serialNo: string | null;
      /** 登记日期（created_at 的日期部分，yyyy-mm-dd）。 */
      businessDate: string;
      createdAt: string;
    }
  | {
      kind: 'activity';
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      visitAt: string | null;
      engineers: string;
      businessDate: string | null;
      createdAt: string;
    }
  | {
      kind: 'service_order';
      id: string;
      /** 项目关联开单为项目 id；未关联项目的开单（project_id 为空）为 null。 */
      projectId: string | null;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      orderType: 'relocation' | 'certification' | 'parts_by_mail' | 'pm';
      serviceOrderNo: string | null;
      orderedAt: string;
      /** 参与工程师（可空，允许后续补录）。 */
      engineer: string | null;
      businessDate: string;
      createdAt: string;
    }
  | {
      kind: 'invoice';
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      amount: string;
      invoicedAt: string;
      active: boolean;
      businessDate: string;
      createdAt: string;
    }
  | {
      kind: 'damage';
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      instrumentName: string;
      issueStatus: string;
      registeredAt: string;
      businessDate: string;
      createdAt: string;
    }
  | {
      kind: 'acceptance';
      /** 项目 id（v2Delete acceptance 使用 projectId）。 */
      id: string;
      projectId: string;
      customerName: string;
      ecc: string | null;
      tempNo: string;
      acceptanceReportDate: string;
      businessDate: string;
      createdAt: string;
    }
  | {
      kind: 'ship_to_request';
      id: string;
      projectId: string | null;
      customerName: string;
      ecc: null;
      tempNo: string;
      newSiteAddress: string;
      status: ShipToRequestStatus;
      submittedAt: string | null;
      businessDate: string | null;
      createdAt: string;
    };

export interface WorkbenchV2HistoryPageDto {
  businessRevision: number;
  kind: WorkbenchV2HistoryKind;
  rows: readonly WorkbenchV2HistoryRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

// ---------------------------------------------------------------------------
// 完整提醒视图与提醒泳道（tasks 7.3 / 7.6，design D6/D9）
// - reminderPage：完整提醒视图，全部带当前提醒项目 + 到期分类，按提醒日期
//   asc/desc 排序（未选择时默认 desc = 最近日期优先），与泳道排序独立；
// - reminderLanes：泳道「先日期后项目」有界读取——先按提醒日期升序选取最多 7 个
//   不同非空日期（不要求连续自然日、全量不足仅返回已有），再按列读取项目；
//   MUST NOT 先按记录数截断再分组；列内 id 稳定 tie-breaker，高量日期列可带
//   独立 column cursor/page size，推进某列携带 selectedDates 锁定日期集合。
// ---------------------------------------------------------------------------

/** 完整提醒视图分页请求。 */
export interface WorkbenchV2ReminderPageRequest {
  /** 排序方向：'asc' 升序 / 'desc' 降序；缺省 desc（最近日期优先）。 */
  sort?: 'asc' | 'desc' | null;
  /** 上一页返回的 nextCursor（首页为空）。 */
  cursor?: string | null;
  limit?: number;
}

export interface WorkbenchV2ReminderPageRow {
  projectId: string;
  customerName: string;
  ecc: string | null;
  tempNo: string;
  /** 项目提醒日期（业务日期 yyyy-mm-dd；仅备注无日期时为 null）。 */
  reminderAt: string | null;
  reminderNote: string | null;
  reminderDueClass: WorkbenchReminderDueClass | null;
  /** 当前上下文候选项目的轻量项目分类标签摘要。 */
  tagIds?: readonly string[];
  groupedTags?: readonly ProjectTagGroupSummaryDto[];
}

export interface WorkbenchV2ReminderPageDto {
  businessRevision: number;
  rows: readonly WorkbenchV2ReminderPageRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
  sort: 'asc' | 'desc';
}

/** 提醒泳道请求。 */
export interface WorkbenchV2ReminderLanesRequest {
  /**
   * 已锁定的日期列（业务日期 yyyy-mm-dd，升序，最多 7）。
   * 首次请求可不传（主进程计算）；推进某列时必须回传以锁定日期集合，
   * 主进程不得重算或改变该集合。
   */
  selectedDates?: readonly string[] | null;
  /** 要推进的日期列（必须属于 selectedDates）；缺省 = 全部列取首页。 */
  date?: string | null;
  /** 推进该列时的列内 keyset 游标（首页为空）。 */
  cursor?: string | null;
  /** 列内每页大小（可选；主进程有界，默认 50、上限 100）。 */
  limit?: number;
}

/** 泳道列内项目（同一日期列内 reminderAt 非空）。 */
export interface WorkbenchV2ReminderLaneRow {
  projectId: string;
  customerName: string;
  ecc: string | null;
  tempNo: string;
  /** 所在日期列的业务日期（yyyy-mm-dd，非空）。 */
  reminderAt: string;
  reminderNote: string | null;
  reminderDueClass: WorkbenchReminderDueClass | null;
  /** 当前上下文候选项目的轻量项目分类标签摘要。 */
  tagIds?: readonly string[];
  groupedTags?: readonly ProjectTagGroupSummaryDto[];
}

export interface WorkbenchV2ReminderLane {
  date: string;
  projects: readonly WorkbenchV2ReminderLaneRow[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

export interface WorkbenchV2ReminderLanesDto {
  businessRevision: number;
  /** 已选日期列（升序；最多 7；全量提醒不足时仅已有非空日期列）。 */
  dates: readonly string[];
  /** 各日期列项目（列内稳定顺序；推进列返回后续页、其余列返回首页）。 */
  lanes: readonly WorkbenchV2ReminderLane[];
  /** 列内每页大小（有界）。 */
  lanePageSize: number;
}

// ---------------------------------------------------------------------------
// 受保护登记记录删除（判别联合 API）
// - 预期业务修订（expectedRevision）防并发：不等于当前 business_revision 时整体拒绝；
// - invoice 不可物理删除：删除必须携带撤销日期与原因，映射到现有 revoke；
// - 数据模型无法可靠重算的类型（acceptance）明确拒绝，返回稳定错误码；
// - 全部删除在同一事务内原子完成（含导入审计联动）。
// ---------------------------------------------------------------------------

export type WorkbenchV2DeleteKind =
  | 'service_order'
  | 'activity'
  | 'acceptance'
  | 'damage_repair_item'
  | 'serial_address'
  | 'qr_request'
  | 'batch'
  | 'instrument'
  | 'ship_to_request'
  | 'invoice';

export type WorkbenchV2DeleteRequest =
  | { kind: 'service_order'; id: string; expectedRevision: number }
  | { kind: 'activity'; id: string; expectedRevision: number }
  | { kind: 'acceptance'; projectId: string; expectedRevision: number }
  | { kind: 'damage_repair_item'; id: string; expectedRevision: number }
  | { kind: 'serial_address'; id: string; expectedRevision: number }
  | { kind: 'qr_request'; id: string; expectedRevision: number }
  | { kind: 'batch'; id: string; expectedRevision: number }
  | { kind: 'instrument'; id: string; expectedRevision: number }
  | { kind: 'ship_to_request'; id: string; expectedRevision: number }
  | {
      kind: 'invoice';
      id: string;
      expectedRevision: number;
      /** 撤销日期（业务日期 yyyy-mm-dd，必填）。 */
      revokedAt: string;
      /** 撤销原因（必填）。 */
      revokeReason: string;
    };

/** 删除失败稳定错误码（renderer 按 code 精确提示，不依赖错误消息文本）。 */
export const DELETE_REJECTION_CODES = {
  REVISION_MISMATCH: 'DELETE_REJECTED_REVISION',
  NOT_FOUND: 'DELETE_REJECTED_NOT_FOUND',
  DEPENDENCIES: 'DELETE_REJECTED_DEPENDENCIES',
  STATUS_RECALC_UNRELIABLE: 'DELETE_REJECTED_STATUS_RECALC',
  INVOICE_REQUIRES_REVOKE: 'DELETE_REJECTED_INVOICE_REQUIRES_REVOKE',
} as const;

export type DeleteRejectionCode = (typeof DELETE_REJECTION_CODES)[keyof typeof DELETE_REJECTION_CODES];

/**
 * 新建项目（create_project）拒绝稳定错误码（ora-1）：
 * - 废弃字段（finalAmount/serviceOrderNo/engineers/serviceOrderNote/missingItems）有值即拒绝，
 *   绝不静默忽略；
 * - 仅 intent='formal' 允许携带 ECC/进单日期/合同金额；draft/pre_entry_execution 有值即拒绝。
 */
export const WIZARD_REJECTION_CODES = {
  DEPRECATED_FIELD: 'WIZARD_DEPRECATED_FIELD',
  ECC_ONLY_FORMAL: 'WIZARD_ECC_ONLY_FORMAL',
  ENTRY_AT_ONLY_FORMAL: 'WIZARD_ENTRY_AT_ONLY_FORMAL',
  CONTRACT_AMOUNT_ONLY_FORMAL: 'WIZARD_CONTRACT_AMOUNT_ONLY_FORMAL',
} as const;

export type WizardRejectionCode = (typeof WIZARD_REJECTION_CODES)[keyof typeof WIZARD_REJECTION_CODES];

export interface WorkbenchV2DeleteResult {
  businessRevision: number;
  invalidated: readonly WorkbenchV2InvalidateTag[];
  changed: { kind: WorkbenchV2DeleteKind; id: string; projectId?: string } | null;
}

// ---------------------------------------------------------------------------
// 错误可跨 IPC 序列化的最小信封（ora-1：#7）
// - v2Delete / cleanPrepare / cleanConfirm 一律返回 {ok:true,data}|{ok:false,error:{code,message}}；
// - handler 在进程内把 DomainError 转成信封（绝不依赖 Error 自定义属性穿透 Electron）；
// - error.code 为稳定拒绝码（DELETE_REJECTION_CODES / CLEAN_REJECTION_CODES）。
// ---------------------------------------------------------------------------

export type IpcEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type WorkbenchV2DeleteEnvelope = IpcEnvelope<WorkbenchV2DeleteResult>;
export type DataCleanPrepareEnvelope = IpcEnvelope<DataCleanPrepareDto>;
export type DataCleanConfirmEnvelope = IpcEnvelope<DataCleanConfirmResultDto>;
/** 项目分类标签目录写入在线上使用的可序列化错误信封。 */
export type ProjectTagMutationEnvelope = IpcEnvelope<ProjectTagMutationResultDto>;

// ---------------------------------------------------------------------------
// 「清理全部业务数据」两阶段 API（prepare → confirm）
// - prepare 返回各业务表计数、短期 token、过期时间与当前业务修订；
// - confirm 必须携带 token + 固定确认文本「清理全部业务数据」；token 绑定 DB
//   identity/generation/revision，任何变化（含期间业务写入）整体拒绝；
// - confirm 执行前创建安全备份，BEGIN IMMEDIATE 原子清理业务表与导入审计，
//   保留 accounts/app_settings/database_metadata/备份/独立导入工作区，轮换 contentGenerationId。
// ---------------------------------------------------------------------------

/** 清理确认固定文本（renderer 展示；不匹配即拒绝）。 */
export const CLEAN_ALL_CONFIRM_TEXT = '清理全部业务数据';

/** 「清理全部业务数据」confirm 拒绝稳定错误码（renderer 按 code 精确提示）。 */
export const CLEAN_REJECTION_CODES = {
  CONFIRM_TEXT: 'CLEAN_CONFIRM_TEXT_REQUIRED',
  NOT_PREPARED: 'CLEAN_NOT_PREPARED',
  TOKEN_MISMATCH: 'CLEAN_TOKEN_MISMATCH',
  TOKEN_EXPIRED: 'CLEAN_TOKEN_EXPIRED',
  REVISION_CHANGED: 'CLEAN_REVISION_CHANGED',
  BACKUP_FAILED: 'CLEAN_BACKUP_FAILED',
} as const;

export type CleanRejectionCode = (typeof CLEAN_REJECTION_CODES)[keyof typeof CLEAN_REJECTION_CODES];

/** 业务表（与 schema-v10 BUSINESS_TABLES 同口径，供 prepare 计数）。 */
export type CleanableTable =
  | 'customers'
  | 'projects'
  | 'contracts'
  | 'batches'
  | 'instruments'
  | 'batch_change_history'
  | 'activities'
  | 'activity_engineers'
  | 'work_facts'
  | 'service_orders'
  | 'ship_tos'
  | 'ship_to_requests'
  | 'serial_address_updates'
  | 'damage_repair_items'
  | 'activity_damage_links'
  | 'qr_requests'
  | 'qr_request_types'
  | 'logistics_fees'
  | 'invoices';

export interface DataCleanPrepareDto {
  /** 短期清理 token（一次性；confirm 时校验）。 */
  token: string;
  /** token 过期时间（epoch 毫秒）。 */
  expiresAt: number;
  /** prepare 时刻的数据库实例 ID（token 绑定）。 */
  databaseInstanceId: string;
  /** prepare 时刻的 content generation（token 绑定）。 */
  contentGenerationId: string;
  /** prepare 时刻的业务修订（token 绑定；期间业务写入会使 confirm 拒绝）。 */
  revision: number;
  /** 当前各业务表计数（准备清理前快照）。 */
  counts: Record<CleanableTable, number>;
  /** 计入的独立导入审计记录数（migration_audit / import_record_audit / import_run）。 */
  auditCounts: { migrationAudit: number; importRecordAudit: number; importRun: number };
}

export interface DataCleanConfirmRequestDto {
  token: string;
  /** 必须等于固定文本「清理全部业务数据」，否则拒绝。 */
  confirmText: string;
}

export interface DataCleanConfirmResultDto {
  /** 已清理的业务表行数合计（不含审计表）。 */
  clearedBusinessRows: number;
  /** 已清理的导入审计行数合计。 */
  clearedAuditRows: number;
  /** 清理前安全备份文件路径。 */
  backupPath: string;
  /** 清理后轮换的新 content generation。 */
  contentGenerationId: string;
  businessRevision: number;
}

/**
 * v2 普通写动作（复用现有写逻辑，绝不调用 snapshot；返回有界 mutation 结果）。
 * 覆盖：新建项目 / 资料更新 / 补齐资料 / 提交动作 / 提醒 / 状态 / 取消 / Ship-to
 * complete / 掉票编辑与撤销 / 搬迁批次编辑（batch_edit）/ 仪器批量导入 /
 * 损坏事项更新（damage_update）。
 */
export type WorkbenchV2MutationOp =
  | 'create_project'
  | 'update_project'
  | 'supplement_project'
  | 'submit_action'
  | 'set_reminder'
  | 'clear_reminder'
  | 'adjust_status'
  | 'cancel_project'
  | 'ship_to_complete'
  | 'invoice_edit'
  | 'invoice_revoke'
  | 'batch_edit'
  | 'instrument_bulk_import'
  | 'damage_update';

/** 写后失效标签：告知新 UI 哪些有界缓存需重读。 */
export type WorkbenchV2InvalidateTag =
  | 'overview'
  | 'projects'
  | 'reminders'
  | 'tag_catalog'
  | `project:${string}`
  | `sections:${string}`
  | 'independent:serial_address'
  | 'independent:qr_request'
  | 'lookup:ship_to_requests'
  | 'lookup:customers';

export interface WorkbenchV2BaseMutationRequest {
  op: WorkbenchV2MutationOp;
  /** submit_action / adjust_status / cancel_project / set_reminder 等需要。 */
  projectId?: string;
  /** create_project（ProjectWizardPayload）/ update_project（ProjectUpdatePayload）/
   *  supplement_project（ProjectSupplementPayload）/ batch_edit（BatchEditPayload）/
   *  instrument_bulk_import（InstrumentBulkImportPayload）。 */
  payload?: ProjectWizardPayload | ProjectUpdatePayload | ProjectSupplementPayload | BatchEditPayload | InstrumentBulkImportPayload;
  /** submit_action。 */
  action?: WorkbenchActionPayload;
  /** set_reminder：提醒日期（业务日期 yyyy-mm-dd）。 */
  reminderAt?: string | null;
  reminderNote?: string | null;
  /** adjust_status（拒绝 cancelled，取消走 cancel_project）。 */
  status?: AdjustableProjectStatus;
  /** cancel_project：取消日期（业务日期 yyyy-mm-dd）。 */
  time?: string;
  reason?: string;
  /** ship_to_complete。 */
  requestId?: string;
  accountId?: string;
  /** invoice_edit / invoice_revoke。 */
  invoiceId?: string;
  /** invoice_edit：掉票日期（业务日期 yyyy-mm-dd）。 */
  invoicedAt?: string;
  amount?: string;
  /** damage_update：损坏/维修事项更新（复用 updateIssueStatus/setPartStatus/updatePart）。 */
  damageId?: string;
  /** damage_update：事项处理状态（未处理/处理中/已修复/已关闭未修复）。 */
  issueStatus?: string;
  /** damage_update：已关闭未修复的关闭原因（必填）。 */
  closeReason?: string | null;
  /** damage_update：备件处理状态（待提交/处理中/已到件/已使用）。 */
  partStatus?: string;
  /** damage_update：备件号（updatePart）。 */
  partNumber?: string;
  /** damage_update：备件数量（正整数）。 */
  partQuantity?: number;
  /** damage_update：备件金额（十进制字符串，> 0）。 */
  partAmount?: string;
  /** damage_update：备件币种（USD/RMB）。 */
  partCurrency?: string;
  /** damage_update：备件申请日期（业务日期 yyyy-mm-dd）。 */
  partRequestedAt?: string | null;
  /** damage_update：维修过程备注（null = 清空）。 */
  repairNote?: string | null;
}

/**
 * 仪器批量导入行（.xlsx 5 列：仪器名称/厂商/型号/序列号/服务级别）。
 * renderer 解析 Excel 后经强类型 mutation 整批提交；只有仪器名称必填，
 * 其余列选填并去除首尾空白；非空序列号在 payload 内与库内同一项目均不得重复。
 */
export interface InstrumentBulkImportRow {
  /** 仪器名称（必填）。 */
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNo?: string | null;
  serviceLevel?: string | null;
}

/** 仪器批量导入请求：append 语义（追加登记，不替换既有仪器），整批事务原子落库。 */
export interface InstrumentBulkImportPayload {
  projectId: string;
  rows: readonly InstrumentBulkImportRow[];
}

/** 仪器行内编辑允许修改清单字段；名称、二维码标记和所属批次保持只读。 */
export interface InstrumentUpdatePayload {
  instrumentId: string;
  manufacturer: string | null;
  model: string | null;
  serviceLevel: string | null;
  serialNo: string | null;
  ups: boolean;
  qrRequested: boolean;
  batchId: string | null;
}

/** 服务单编辑仅允许修改备注；null 或空白均表示清空。 */
export interface ServiceOrderNoteUpdatePayload {
  orderId: string;
  note: string | null;
}

/** 服务单工程师补录：工程师可空，允许后续补录或清空（v20）。 */
export interface ServiceOrderEngineerUpdatePayload {
  orderId: string;
  /** 参与工程师（可空，空白统一清空为 null）。 */
  engineer: string | null;
}

/** 记录编辑一律用 payload 承载，防止身份字段混入普通 mutation 顶层。 */
export type WorkbenchV2RecordEditingMutationRequest =
  | { op: 'instrument_update'; payload: InstrumentUpdatePayload }
  | { op: 'service_order_note_update'; payload: ServiceOrderNoteUpdatePayload }
  | { op: 'service_order_engineer_update'; payload: ServiceOrderEngineerUpdatePayload };

export type WorkbenchV2MutationRequest = WorkbenchV2BaseMutationRequest | WorkbenchV2RecordEditingMutationRequest;

export interface WorkbenchV2MutationResult {
  businessRevision: number;
  invalidated: readonly WorkbenchV2InvalidateTag[];
  changed: {
    projectId?: string;
    requestId?: string;
    invoiceId?: string;
    batchId?: string;
    status?: string;
    accountId?: string | null;
    created?: boolean;
    /** instrument_bulk_import：实际登记仪器数。 */
    importedCount?: number;
  } | null;
}

export interface ProjectWizardPayload {
  /**
   * 新建项目意图（intent 决定是否正式进单，不再由 ECC 推断）：
   * - 'formal'：正式进单（必填合同/客户/ECC/进单日期；旧址/新址/仪器数量可空，
   *   正式进单不再要求搬迁范围或最终可确认金额，合同金额为空/0 时 final 保持 null，
   *   进单后基线 pending_execution）；
   * - 'draft'：创建待进单草稿项目（不补建合同、不设置 ECC、不触发正式进单）；
   * - 'pre_entry_execution'：待进单 + 未进单先执行（经理批复原因必填）。
   */
  intent: 'draft' | 'formal' | 'pre_entry_execution';
  customerName: string;
  /**
   * 仅 intent='formal' 允许携带；draft/pre_entry_execution 携带非空值 → 稳定拒绝
   * （WIZARD_ECC_ONLY_FORMAL，绝不静默丢弃）。
   */
  ecc?: string;
  /**
   * 进单日期（业务日期 yyyy-mm-dd；正式进单必填，缺省当前日期）。
   * 仅 intent='formal' 允许携带；非 formal 有值 → 稳定拒绝（WIZARD_ENTRY_AT_ONLY_FORMAL）。
   */
  entryAt?: string;
  region: string;
  oldSiteContact?: string;
  newSiteContact?: string;
  /** 合同开始日期（业务日期 yyyy-mm-dd；可空/可清除，后补字段）。 */
  contractStartDate?: string | null;
  /** 合同截止日期（业务日期 yyyy-mm-dd；可空/可清除，后补字段）。 */
  contractEndDate?: string | null;
  /** 项目默认旧址地址（可空；有值才写入，无值保持空）。 */
  oldSiteAddress?: string | null;
  /** 项目默认新址地址（可空；有值才写入，无值保持空）。 */
  newSiteAddress?: string | null;
  /**
   * 暂定仪器数量（正整数，可空）：有值（正整数）才记录数量并确认搬迁范围
   * （confirmScope），不生成虚拟仪器；未提供/0/空则不确定范围（正式进单已不再要求范围）。
   */
  instrumentCount?: number | null;
  /**
   * 合同 USD 含税金额：十进制字符串（如 "100000.50"），由主进程按 Money 精确解析为分。
   * 仅 intent='formal' 允许携带；非 formal 有值 → 稳定拒绝（WIZARD_CONTRACT_AMOUNT_ONLY_FORMAL）。
   * 空字符串/未提供 = 未录入（合同金额保持 null，绝不虚构 0）。
   */
  contractAmount?: string;
  /** 项目备注（可空；建档时填写或建档后补充，不影响主状态）。 */
  projectNote?: string | null;
  /** 暂存地址（可空；手工维护执行事实，不触发主状态流转）。 */
  temporaryStorageAddress?: string | null;
  /** 是否暂存（可空；空表示「未填写」而非推断「否」，不触发主状态流转）。 */
  isTemporaryStorage?: boolean | null;
  /** 暂定仪器范围：暂定仪器名称（可空；建档时填写，trim 后保存、空串统一 null；不建仪器、不触发主状态）。 */
  temporaryInstrumentName?: string | null;
  /** 暂定仪器范围：暂定仪器型号（可空；trim 后保存、空串统一 null；不建仪器、不触发主状态）。 */
  temporaryInstrumentModel?: string | null;
  /** 暂定仪器范围：是否配备 UPS（可空；null=未填写、false=否、true=是；不触发主状态）。 */
  temporaryHasUps?: boolean | null;
  /** 计划上门日期（业务日期 yyyy-mm-dd）。 */
  planVisitAt?: string;
  /** 计划运输日期（业务日期 yyyy-mm-dd）。 */
  planTransportAt?: string;
  /** 计划装机日期（业务日期 yyyy-mm-dd；「计划装机完成日期」更名后的公开契约字段，独立字段不触发生命周期）。 */
  plannedInstallAt?: string;
  /** @deprecated 兼容既有 renderer 编译：与 plannedInstallAt 同值（「计划装机完成日期」旧名）；新 UI 应提交 plannedInstallAt。 */
  plannedInstallDoneAt?: string;
  siteConfirmed?: boolean;
  /** 实际装机完成日期（业务日期 yyyy-mm-dd）。 */
  actualInstallDoneAt?: string;
  /**
   * @deprecated 后端拒绝该字段（有值即 WIZARD_DEPRECATED_FIELD）：未进单先执行
   * 以 managerApproved 是否批复为事实，不再收集批复原因。保留字段仅为兼容既有
   * renderer 编译；新 UI 不应提交。
   */
  approvalReason?: string;
  /**
   * 未进单先执行（intent='pre_entry_execution'）的「是否批复」boolean 事实：
   * managerApproved 替代原批复原因/缺失资料；不再收集原因与缺失项。
   */
  managerApproved?: boolean | null;
  /** 可选项目分类标签；创建项目时与项目事实在同一原子保存中关联。 */
  tagIds?: readonly string[];
}

/**
 * 项目资料更新输入（v2 update_project，随请求 payload 提交，renderer 契约字段名）。
 *
 * 三态语义（明确区分“未提交”与“清空”，禁止 truthy 判断丢失 false/空值）：
 * - `undefined` = 未提交该字段，保持现值；
 * - `null` = 显式清空（仅允许可空字段：联系人/地址/计划时间/区域空串；
 *   ECC/进单时间等业务必填字段不可清空，null 视为未提交）；
 * - 有值 = 覆盖（`siteConfirmed` 等布尔字段必须显式传 false 表示清除）。
 *
 * 已正式进单项目才可更正 ECC / 进单时间 / 合同金额 / 最终可确认金额；待进单项目
 * 保留现有 core/formalEntry 语义，update_project 不绕过正式进单校验。
 * 不提供仪器名称 / 序列号 / 服务单号修改。
 */
export interface ProjectUpdatePayload {
  /** 目标项目 id（renderer 打包进 payload，与请求顶层 projectId 等价）。 */
  projectId: string;
  /** 客户重关联：按去除首尾空白后的名称全局唯一匹配，不存在则登记新客户并关联。 */
  customerName?: string;
  /** 区域：去除首尾空白后精确分组；空串 = 清空区域。 */
  region?: string;
  /** 合同开始日期（yyyy-mm-dd；可空/可清除，null 或空串 = 清空；与截止同有值时不得早于截止）。 */
  contractStartDate?: string | null;
  /** 合同截止日期（yyyy-mm-dd；可空/可清除，null 或空串 = 清空）。 */
  contractEndDate?: string | null;
  /** 旧址联系人；null = 清空。 */
  oldSiteContact?: string | null;
  /** 新址联系人；null = 清空。 */
  newSiteContact?: string | null;
  /** 项目默认旧址地址；null = 清空。 */
  oldSiteAddress?: string | null;
  /** 项目默认新址地址；null = 清空。 */
  newSiteAddress?: string | null;
  /** 计划上门日期（yyyy-mm-dd）；null = 清空。 */
  plannedVisitAt?: string | null;
  /** 计划运输日期（yyyy-mm-dd）；null = 清空。 */
  plannedTransportAt?: string | null;
  /** 计划装机日期（yyyy-mm-dd；「计划装机完成日期」更名后的公开契约字段，独立字段不触发生命周期）；null = 清空。 */
  plannedInstallAt?: string | null;
  /** @deprecated 兼容读取 alias：同 plannedInstallAt（「计划装机完成日期」旧名）；新 UI 应提交 plannedInstallAt。 */
  plannedInstallDoneAt?: string | null;
  /** 场地确认状态；显式 false = 清除确认。 */
  siteConfirmed?: boolean;
  /** 项目备注（可空；null = 清空；不影响主状态）。 */
  projectNote?: string | null;
  /** 暂存地址（可空；null = 清空；手工维护执行事实，不触发主状态流转）。 */
  temporaryStorageAddress?: string | null;
  /** 是否暂存（可空；null = 未填写，不触发主状态流转）。 */
  isTemporaryStorage?: boolean | null;
  /** 是否批复（可空；null = 未填写；managerApproved 替代原批复原因/缺失资料）。 */
  managerApproved?: boolean | null;
  /**
   * 暂定仪器数量（可空整数）：查看/补录/调整均经本字段；null = 留空。
   * 只更新项目标量，不创建/删除/修改任何仪器记录，不触发主状态流转；
   * 取值校验遵循既有 setTemporaryInstrumentCount 规则（不小于 0 的整数）。
   */
  temporaryInstrumentCount?: number | null;
  /** 暂定仪器范围：暂定仪器名称（可空；null 或空串 = 清空；不建仪器、不触发主状态）。 */
  temporaryInstrumentName?: string | null;
  /** 暂定仪器范围：暂定仪器型号（可空；null 或空串 = 清空；不建仪器、不触发主状态）。 */
  temporaryInstrumentModel?: string | null;
  /** 暂定仪器范围：是否配备 UPS（可空；null = 未填写、false = 否、true = 是；不触发主状态）。 */
  temporaryHasUps?: boolean | null;
  /** 已正式进单项目更正：ECC（去除首尾空白后全局唯一，必填非空；null 视为未提交）。 */
  ecc?: string | null;
  /** 已正式进单项目更正：进单日期（业务日期 yyyy-mm-dd，允许补录修正；null 视为未提交）。 */
  entryAt?: string | null;
  /**
   * 已正式进单项目更正：合同 USD 含税金额（十进制字符串，允许 0、拒绝负数，
   * 由主进程按 Money 精确解析为分；渲染层禁止 Number 参与金额计算）。
   * 空串/null = 0（合同金额允许 0，由领域校验决定是否接受）。
   */
  contractUsdTaxAmount?: string | null;
  /** 已正式进单项目更正：最终可确认金额（十进制字符串，必须 > 0 且不低于累计有效掉票；
   *  空串/null = 0，由领域校验拒绝非法清空）。 */
  finalConfirmableAmount?: string | null;
  /** 可选项目分类标签 replace-set；undefined 保持现有关联，空数组清空全部关联。 */
  tagIds?: readonly string[];
}

/**
 * 补齐资料输入（v2 supplement_project，随请求 payload 提交）。
 *
 * 面向尚未正式进单（待进单/未进单先执行）项目补齐新建项目全部可后补字段，
 * 并在同一事务内支持可选正式进单（携带非空 ECC → formalEntry）。开单必须经独立
 * quick record/detail 动作提交，补齐资料绝不创建开单记录。
 *
 * 三态语义与 update_project 一致：`undefined` = 未提交保持现值；`null` = 显式清空
 * （仅可空字段）；有值 = 覆盖。全部经现有领域校验入口落库，不绕过正式进单校验
 * （缺合同/客户/搬迁范围时 formalEntry 按领域规则拒绝）。
 */
export interface ProjectSupplementPayload {
  /** 目标项目 id。 */
  projectId: string;
  /** 客户重关联：按去除首尾空白后的名称全局唯一匹配，不存在则登记新客户并关联。 */
  customerName?: string;
  /** 区域：去除首尾空白后精确分组；空串 = 清空区域。 */
  region?: string;
  /** 合同开始日期（yyyy-mm-dd；null 或空串 = 清空）。 */
  contractStartDate?: string | null;
  /** 合同截止日期（yyyy-mm-dd；null 或空串 = 清空）。 */
  contractEndDate?: string | null;
  oldSiteContact?: string | null;
  newSiteContact?: string | null;
  oldSiteAddress?: string | null;
  newSiteAddress?: string | null;
  /** 计划上门日期（yyyy-mm-dd）；null = 清空。 */
  plannedVisitAt?: string | null;
  /** 计划运输日期（yyyy-mm-dd）；null = 清空。 */
  plannedTransportAt?: string | null;
  /** 计划装机日期（yyyy-mm-dd；「计划装机完成日期」更名后的公开契约字段，独立字段不触发生命周期）；null = 清空。 */
  plannedInstallAt?: string | null;
  /** @deprecated 兼容读取 alias：同 plannedInstallAt（「计划装机完成日期」旧名）；新 UI 应提交 plannedInstallAt。 */
  plannedInstallDoneAt?: string | null;
  /**
   * 实际装机完成日期（yyyy-mm-dd）：在正式进单之前记录实际装机事实并触发
   * 正常状态重算（formalEntry 后按既有实际完成/验收事实得出主状态，例如自动待验收）。
   * null 或空串 = 未提交保持现值（实际装机完成事实不可清除，仅可补录/修正日期）。
   */
  actualInstallDoneAt?: string | null;
  /** 场地确认状态；显式 false = 清除确认。 */
  siteConfirmed?: boolean;
  /**
   * 补齐搬迁范围数量（正整数）：提供时必须为正整数，调用现有
   * setTemporaryInstrumentCount 记录暂定数量并确认搬迁范围（confirmScope），
   * 确保同一事务内随后的可选正式进单（携带 ECC）能通过 SCOPE_REQUIRED 校验；
   * 未提供时保持现值。
   */
  instrumentCount?: number;
  /** 暂定仪器范围：暂定仪器名称（可空；null 或空串 = 清空；不建仪器、不触发主状态）。 */
  temporaryInstrumentName?: string | null;
  /** 暂定仪器范围：暂定仪器型号（可空；null 或空串 = 清空；不建仪器、不触发主状态）。 */
  temporaryInstrumentModel?: string | null;
  /** 暂定仪器范围：是否配备 UPS（可空；null = 未填写、false = 否、true = 是；不触发主状态）。 */
  temporaryHasUps?: boolean | null;
  /** 未进单先执行经理批复原因（携带时 setPreEntryExecution；正式进单后忽略）。 */
  approvalReason?: string | null;
  missingItems?: string | null;
  /** 未进单先执行「是否批复」boolean 事实（managerApproved 替代批复原因/缺失资料；正式进单后忽略）。 */
  managerApproved?: boolean | null;
  /**
   * 可选正式进单：携带非空 ECC → 同一事务内完成正式进单（补建合同、校验
   * 客户/搬迁范围、锁定金额快照、清除未进单先执行标签）；缺合同/客户/范围时
   * 由领域校验拒绝，不绕过。null 或空串 = 不执行正式进单。
   */
  ecc?: string | null;
  /** 进单日期（业务日期 yyyy-mm-dd；正式进单时缺省当前日期）。 */
  entryAt?: string | null;
  /** 合同 USD 含税金额（十进制字符串，允许 0、拒绝负数；先于正式进单设置）。 */
  contractAmount?: string | null;
  /** 最终可确认金额（十进制字符串；缺省取合同金额，由领域校验决定）。 */
  finalAmount?: string | null;
}

/**
 * 搬迁批次编辑输入（v2 batch_edit，随请求 payload 提交）。
 *
 * 仅两个价格口径（与快速记录搬迁批次一致）：
 * - `budgetPrice`=合同预算价 → 双写 batch.originalPriceCents 与 fee.budgetPriceCents；
 * - `dealPrice`=物流成交价 → 双写 batch.discountedPriceCents、fee.dealPriceCents 与
 *   fee.logisticsCostCents（物流成交价即最终实际费用）。
 *
 * 全部字段三态语义：`undefined` = 未提交保持现值；`null` = 显式清空；有值 = 覆盖。
 * - 计划运输日期/运输公司/费用登记日期：null 或空串 = 清空；
 * - 价格字段：null = 清空；有值 = 覆盖（合同预算价必须 > 0；物流成交价允许显式 0）；
 *   空串视为缺失报错、不得静默当 0，由主进程/领域校验。
 * `appliedAt`（物流费用申请/登记时间）可补、改、清空（修改会影响报表归属月份）。
 * 历史批次无 fee 时按需创建部分费用记录；仅提交 null/undefined 时不虚构费用记录。
 */
export interface BatchEditPayload {
  /** 目标批次 id。 */
  batchId: string;
  /** 计划运输日期（业务日期 yyyy-mm-dd）；null 或空串 = 清空。 */
  planTransportDate?: string | null;
  /** 运输公司；null = 清空。 */
  transportCompany?: string | null;
  /** 合同预算价（十进制字符串，有值必须 > 0）→ batch.originalPriceCents + fee.budgetPriceCents；null = 清空。 */
  budgetPrice?: string | null;
  /** 物流成交价（十进制字符串，有值允许显式 0）→ batch.discountedPriceCents + fee.dealPriceCents + fee.logisticsCostCents；null = 清空。 */
  dealPrice?: string | null;
  /** 物流费用申请（登记）日期（业务日期 yyyy-mm-dd）；null 或空串 = 清空；undefined = 保持现值。 */
  appliedAt?: string | null;
}

export type WorkbenchActionType =
  | 'batch' | 'instrument' | 'visit' | 'order' | 'logistics'
  | 'acceptance' | 'invoice' | 'ship_to' | 'damage' | 'core'
  | 'serial_address' | 'qr_request';

export interface WorkbenchActionPayload {
  type: WorkbenchActionType;
  projectId?: string;
  /**
   * 业务动作字段值。金额字段（budgetPrice/dealPrice/logisticsCost/amount/contractAmount/
   * finalAmount/partAmount）为十进制字符串，由主进程按 Money 精确解析；渲染层禁止
   * Number(value)*100 与浮点金额计算。
   * 业务日期字段（planTransportDate/visitAt/orderedAt/appliedAt/invoicedAt/requestedAt/
   * registeredAt/partRequestedAt/entryAt/updatedAt/reportDate 等）一律为 yyyy-mm-dd，
   * 由主进程校验后透传，绝不转换为 ISO；审计/技术时间不在此提交。
   * 快速记录搬迁批次（type='batch'）提交 planTransportDate/transportCompany/appliedAt/
   * budgetPrice/dealPrice（全部可选，空串=未填写），主进程在同一事务内原子创建批次；
   * 任一费用字段有值时创建该批次唯一一笔（可部分）物流费用，全空时仅建批次。
   * 仅两个价格口径：budgetPrice=合同预算价 → batch.originalPriceCents +
   * fee.budgetPriceCents；dealPrice=物流成交价 → batch.discountedPriceCents +
   * fee.dealPriceCents + fee.logisticsCostCents（物流成交价即最终实际费用）。
   */
  values: Record<string, string | number | boolean | string[] | null>;
}

export interface ReportFilterDto {
  monthFrom: string;
  monthTo: string;
  region?: string | null;
  orderType?: 'relocation' | 'certification' | 'parts_by_mail' | 'pm' | null;
  transportCompany?: string | null;
  engineer?: string | null;
  /** 可选项目分类标签多选：undefined 或空数组不限制；非空按任一标签（OR）匹配。 */
  tagIds?: readonly string[];
}

/** 报表已应用筛选的可序列化形状（含项目分类标签）。 */
export type ReportFiltersDto = Record<string, string | null | readonly string[]>;

export interface ReportDto {
  range: { from: string; to: string };
  filters: ReportFiltersDto;
  /** 审计/技术生成时间（精确 ISO）。 */
  generatedAt: string;
  sections: Array<{ key: string; label: string; rows: Array<Record<string, string | number | boolean | null>> }>;
}

/** preload 暴露给渲染层的 API 形状（Oracle #10：工作台只走 v2 有界读取/mutation，无 snapshot）。 */
export interface WorkbenchApi {
  getCapabilities(): Promise<string[]>;
  getAccountStatus(): Promise<{ initialized: boolean; autoBackupError: string | null }>;
  getSession(): Promise<AccountSessionInfo | null>;
  // ---- Oracle #10：工作台 v2 有界读取 / mutation（旧 snapshot API 已删除，仅此入口） ----
  v2Overview(): Promise<WorkbenchV2OverviewDto>;
  v2ProjectPage(request: WorkbenchV2ProjectPageRequest): Promise<WorkbenchV2ProjectPageDto>;
  v2ProjectDetail(projectId: string): Promise<WorkbenchV2ProjectDetailDto>;
  v2SectionPage(request: WorkbenchV2SectionPageRequest): Promise<WorkbenchV2SectionPageDto>;
  v2IndependentPage(request: WorkbenchV2IndependentPageRequest): Promise<WorkbenchV2IndependentPageDto>;
  v2LookupPage(request: WorkbenchV2LookupPageRequest): Promise<WorkbenchV2LookupPageDto>;
  /** 跨项目历史有界分页：按 kind/from/to/cursor/limit 浏览快速记录模块（含项目上下文与可删除 id）。 */
  v2HistoryPage(request: WorkbenchV2HistoryPageRequest): Promise<WorkbenchV2HistoryPageDto>;
  /** 完整提醒视图（tasks 7.3）：全部项目提醒 + 到期分类，sort asc/desc 默认 desc（与泳道排序独立）。 */
  v2ReminderPage(request: WorkbenchV2ReminderPageRequest): Promise<WorkbenchV2ReminderPageDto>;
  /** 提醒泳道（tasks 7.6）：先按日期选列、再按列读取项目；列可带独立 cursor，推进列不重算日期集合。 */
  v2ReminderLanes(request: WorkbenchV2ReminderLanesRequest): Promise<WorkbenchV2ReminderLanesDto>;
  /** 读取稳定排序的全局项目分类标签目录，可选携带项目当前选中标签。 */
  v2TagCatalog(request?: ProjectTagCatalogRequestDto): Promise<ProjectTagCatalogDto>;
  /** 标签语义化写入；preload 将失败信封适配为含稳定 code 的 Error。 */
  v2TagMutate(request: ProjectTagMutationRequestDto): Promise<ProjectTagMutationResultDto>;
  /** 有界 mutation：复用现有写逻辑，返回 businessRevision + invalidate tags（不含快照）。 */
  v2Mutate(request: WorkbenchV2MutationRequest): Promise<WorkbenchV2MutationResult>;
  /**
   * 受保护登记记录删除：判别联合 + 预期业务修订防并发（invoice 映射为撤销）。
   * IPC 线上为 IpcEnvelope（{ok,data}|{ok:false,error:{code,message}}，错误可靠序列化）；
   * preload 适配为「成功返回 data，失败抛出 message 含稳定 code 的 Error」（既有 UI 契约）。
   */
  v2Delete(request: WorkbenchV2DeleteRequest): Promise<WorkbenchV2DeleteResult>;
  /** 「清理全部业务数据」prepare（IPC 线上为 IpcEnvelope；preload 适配同 v2Delete）。 */
  cleanPrepare(): Promise<DataCleanPrepareDto>;
  /** 「清理全部业务数据」confirm（IPC 线上为 IpcEnvelope；preload 适配同 v2Delete）。 */
  cleanConfirm(request: DataCleanConfirmRequestDto): Promise<DataCleanConfirmResultDto>;
  /**
   * 创建 Ship-to 申请：同客户同新址地址已有申请（任一状态）时返回既有记录，不自动 submit、
   * 不重复创建；首次实际提交才计一次工作量。
   */
  createShipToRequest(input: ShipToRequestInputDto): Promise<ShipToRequestResultDto>;
  /** 按 requestId 推进：待提交 → 处理中（记录首次提交时间，计一次工作量）。 */
  submitShipToRequest(requestId: string): Promise<ShipToRequestResultDto>;
  buildReport(filter: ReportFilterDto): Promise<ReportDto>;
  drillDown(metricKey: string, filter: ReportFilterDto): Promise<Array<Record<string, string | number | boolean | null>>>;
  exportReport(format: 'xlsx' | 'png' | 'pdf', filter: ReportFilterDto): Promise<{ saved: boolean; path?: string }>;
  /** 手动备份：主进程弹出目录选择框并生成 manual-*.db。 */
  backupManual(): Promise<BackupManualResult>;
  /** 恢复备份：主进程弹出文件选择框；成功时重建数据库并重新取得/确保本地账号、恢复会话。 */
  restoreFromBackup(): Promise<RestoreResultDto>;
  /** 历史数据导入向导：最小化 IPC 语义 API（主进程编排工作区/worker/校验/封存/提交）。 */
  importWizard: ImportWizardApi;
  // ---- 移动只读发布（桌面侧任务指挥台发布入口；UI 由 mobile-readonly 控制入口调用） ----
  /** 只读发布状态查询（configured/启用/最近成功/最近失败规范化码/运行提示；不含任何 secret）。 */
  mobileReadonlyStatus(): Promise<MobileReadonlyStatusDto>;
  /** 一次性受信配置：HTTPS 目标 + 上传 token（只写不回显）；返回保存后状态。 */
  mobileReadonlyConfigure(input: MobileReadonlyConfigureInput): Promise<MobileReadonlyStatusDto>;
  /** 显式启停发布；返回保存后状态。 */
  mobileReadonlySetEnabled(input: MobileReadonlySetEnabledInput): Promise<MobileReadonlyStatusDto>;
}

/**
 * 历史数据导入向导 IPC API（tasks 8.48：preload 只暴露最小语义，无路径/fs/db/worker）。
 * dialog 只返回展示元数据/结果，不返回可复用的任意本地路径；金额一律十进制字符串。
 */
export interface ImportWizardApi {
  listDrafts(): Promise<readonly ImportWizardDraftDto[]>;
  createDraft(): Promise<ImportWizardWorkspaceDto>;
  openDraft(draftId: string): Promise<ImportWizardWorkspaceDto>;
  deleteDraft(draftId: string): Promise<void>;
  /** 保存当前步骤并返回刷新后工作区（步骤在会话/工作区持久化）。 */
  saveStep(draftId: string, step: ImportWizardStepId): Promise<ImportWizardWorkspaceDto>;
  /** 生成当前版本空白模板并弹出保存对话框（不返回路径）。 */
  downloadTemplate(): Promise<{ saved: boolean; version: string }>;
  /** 弹出文件选择框并立即启动 worker 读取/规范化（返回展示元数据，不返回路径）。 */
  selectFiles(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 主进程读取剪贴板纯文本并在 worker 中规范化粘贴到指定类别。 */
  pasteIntoCategory(draftId: string, category: ImportWizardCategory, headerConfirmed: boolean): Promise<ImportWizardWorkspaceDto>;
  classifySheet(draftId: string, sheetId: string, category: ImportWizardCategory | 'excluded'): Promise<ImportWizardWorkspaceDto>;
  setCategoryMode(draftId: string, category: ImportWizardCategory, mode: 'data' | 'none'): Promise<ImportWizardWorkspaceDto>;
  updateMapping(draftId: string, mappingId: string, target: string | null): Promise<ImportWizardWorkspaceDto>;
  /** 网格窗口查询（renderer 不持有整份大草稿）。 */
  queryRows(request: ImportWizardRowWindowRequestDto): Promise<ImportWizardGridWindowDto>;
  patchCells(draftId: string, category: ImportWizardCategory, patches: readonly ImportWizardGridPatchDto[]): Promise<ImportWizardWorkspaceDto>;
  addRow(draftId: string, category: ImportWizardCategory): Promise<ImportWizardWorkspaceDto>;
  deleteRows(draftId: string, category: ImportWizardCategory, rowIds: readonly string[]): Promise<ImportWizardWorkspaceDto>;
  /** 完整校验（可取消）；通过后生成 validation seal。 */
  validate(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 保存冲突决定并把选定值写回单元格（局部重校验）。 */
  saveConflictDecision(draftId: string, issueId: string, value: string): Promise<ImportWizardWorkspaceDto>;
  cancelOperation(draftId: string, operationId: string): Promise<ImportWizardWorkspaceDto>;
  summary(draftId: string): Promise<ImportWizardWorkspaceDto>;
  /** 提交封存计划（operation 去重；提交不可取消为部分业务状态）。 */
  commit(draftId: string, seal: string): Promise<ImportWizardSubmitResultDto>;
  /** committing 中断后的结果核对（成功审计 + 完整事务同时存在才判成功）。 */
  settleInterrupted(draftId: string): Promise<ImportWizardSubmitResultDto>;
  /** 启动/恢复时的工作区运行态恢复。 */
  recover(): Promise<ImportWizardRecoverDto>;
  /** 列出磁盘型 checkpoint 摘要（undo 栈；不含敏感值）。 */
  checkpoints(draftId: string): Promise<readonly ImportWizardCheckpointDto[]>;
  /** 撤销到最近一个 pre checkpoint（新修订 + seal 失效；无可撤销返回 null）。 */
  undo(draftId: string): Promise<ImportWizardWorkspaceDto | null>;
  /** 重做成对 post checkpoint（新修订 + seal 失效；无可重做返回 null）。 */
  redo(draftId: string): Promise<ImportWizardWorkspaceDto | null>;
  /** 订阅主进程进度事件；返回取消订阅函数。 */
  onProgress(callback: (event: ImportWizardProgressEventDto) => void): () => void;
}
