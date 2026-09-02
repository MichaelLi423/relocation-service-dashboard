import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Money, formatCents } from '../domain/core/money';
import { ValidationError } from '../domain/core/errors';
import { SystemClock, assertValidBusinessDate } from '../domain/core/time';
import { CustomerService, ProjectService, isFormallyEntered, type ProjectStatusOrCancelled } from '../domain/capabilities/relocation-project-lifecycle';
import { ExecutionService, type BatchQuoteInput, type LogisticsFeeInput, type WorkType } from '../domain/capabilities/relocation-execution';
import { ServiceOrderService } from '../domain/capabilities/service-order-recording';
import { ReminderService } from '../domain/capabilities/workbench-todos';
import { ShipToService } from '../domain/capabilities/ship-to-management';
import { DamageRepairService, type DamageItemStatus, type PartCurrency, type PartStatus } from '../domain/capabilities/damage-repair-tracking';
import { SerialAddressUpdateService } from '../domain/capabilities/serial-address-update';
import { QrRequestService, type QrRequestTypeCode } from '../domain/capabilities/qr-request-tracking';
import { FinancialClosureService } from '../domain/capabilities/project-financial-closure';
import { ReportingService, type ReportMetricKey, type ReportModel } from '../domain/capabilities/operational-reporting';
import {
  SqliteActivityDamageLinkRepository, SqliteActivityEngineerRepository, SqliteActivityRepository,
  SqliteBatchChangeHistoryRepository, SqliteBatchRepository, SqliteContractAmountReader,
  SqliteContractRepository, SqliteCustomerRepository, SqliteDamageInstrumentReader,
  SqliteDamageRepairItemRepository, SqliteInstrumentAddressReader, SqliteInstrumentRepository,
  SqliteInvoiceReadRepository, SqliteInvoiceRepository, SqliteLogisticsFeeRepository,
  SqliteProjectRepository, SqliteQrRequestRepository, SqliteReminderSettingsRepository,
  SqliteRepairActivityReader, SqliteReportingFactReader, SqliteSerialAddressUpdateRepository,
  SqliteServiceOrderRepository, SqliteShipToAddressReader, SqliteShipToRepository,
  SqliteShipToRequestRepository, SqliteWorkFactRepository,
  DataCleanupService, type DataCleanupOptions,
  SqliteDuePlanVisitAdvancer, type DuePlanVisitAdvanceResult,
  WorkbenchReadRepository, SqliteProjectTagRepository,
} from '../domain/capabilities/local-data-persistence';
import { readBusinessRevision } from '../domain/capabilities/local-data-persistence/identity';
import { WorkbenchDeletePolicies } from './workbench-delete';
import { DELETE_REJECTION_CODES, WIZARD_REJECTION_CODES } from '../shared/ipc';
import type {
  AccountSessionInfo, BatchEditPayload, DataCleanConfirmRequestDto, DataCleanConfirmResultDto,
  DataCleanPrepareDto, InstrumentBulkImportPayload, ProjectSupplementPayload,
  ProjectUpdatePayload, ProjectWizardPayload, ReportDto, ReportFilterDto, ShipToRequestDto,
  ShipToRequestInputDto, ShipToRequestResultDto, ShipToRequestStatus, WorkbenchActionPayload,
  WorkbenchV2DeleteRequest, WorkbenchV2DeleteResult, WorkbenchV2HistoryPageDto, WorkbenchV2HistoryPageRequest,
  WorkbenchV2IndependentPageDto, WorkbenchV2IndependentPageRequest, WorkbenchV2InvalidateTag,
  WorkbenchV2LookupPageDto, WorkbenchV2LookupPageRequest, WorkbenchV2BaseMutationRequest, WorkbenchV2MutationRequest,
  WorkbenchV2MutationResult, WorkbenchV2OverviewDto, WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto, WorkbenchV2ProjectPageRequest, WorkbenchV2ReminderLanesDto,
  WorkbenchV2ReminderLanesRequest, WorkbenchV2ReminderPageDto, WorkbenchV2ReminderPageRequest,
  WorkbenchV2SectionPageDto, WorkbenchV2SectionPageRequest, ProjectTagCatalogDto,
  ProjectTagCatalogRequestDto, ProjectTagMutationRequestDto, ProjectTagMutationResultDto,
} from '../shared/ipc';
import type { ShipToRequest as ShipToRequestRecord } from '../domain/capabilities/ship-to-management/ship-to';

/** IPC 金额边界解析：renderer 提交十进制字符串（如 "1234.56"），主进程按 Money 精确解析为分
 * （HALF_UP、拒绝负数与非法格式，全程不使用二进制浮点）。空/缺失按 0 处理，
 * 是否允许 0 由各领域校验决定（仅合同 USD 含税金额允许 0）。
 */
const parseAmountInput = (value: unknown): bigint => {
  const raw = String(value ?? '').trim();
  if (raw === '') return 0n;
  return Money.parse(raw).cents;
};
/** 可选金额解析：空/缺失返回 null（不虚构 0），有值按 Money 精确解析。 */
const optionalMoney = (value: unknown): bigint | null => {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  return Money.parse(raw).cents;
};
const text = (v: unknown): string => String(v ?? '').trim();
const optional = (v: unknown): string | undefined => text(v) || undefined;
/**
 * FormData 将 checkbox 值序列化为字符串。这里只接受契约中的 boolean 和精确的
 * "true"/"false" 字符串；空值沿用登记动作的必填 boolean 默认 false 语义。
 * 绝不能使用 Boolean(value)，否则字符串 "false" 会被错误地登记为 true。
 */
const requiredBoolean = (value: unknown, fieldName: string): boolean => {
  if (value === undefined || value === null || value === '') return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ValidationError('INVALID_BOOLEAN', `${fieldName} 仅接受 true 或 false`);
};
/**
 * IPC 业务日期边界：renderer 提交 yyyy-mm-dd（business date），主进程仅校验格式后原样透传，
 * 绝不转换为 ISO（design D30：业务时间仅记录业务日期；审计/技术时间保留精确 ISO）。
 * 空/缺失返回 undefined，由调用方决定 null（清空）或 undefined（未提交）语义。
 */
const businessDate = (v: unknown, fieldName: string): string | undefined => {
  const raw = optional(v);
  if (raw === undefined) return undefined;
  assertValidBusinessDate(raw, fieldName);
  return raw;
};

/** `update_project` 中除项目分类外会进入项目写模型的已提交字段。 */
const hasProjectUpdateFields = (update: ProjectUpdatePayload): boolean => {
  const legacy = update as ProjectUpdatePayload & {
    contractStartAt?: string | null;
    contractEndAt?: string | null;
    enteredAt?: string | null;
  };
  return [
    update.customerName, update.region,
    update.contractStartDate, update.contractEndDate, legacy.contractStartAt, legacy.contractEndAt,
    update.oldSiteContact, update.newSiteContact, update.oldSiteAddress, update.newSiteAddress,
    update.plannedVisitAt, update.plannedTransportAt, update.plannedInstallAt, update.plannedInstallDoneAt,
    update.siteConfirmed, update.projectNote, update.temporaryStorageAddress, update.isTemporaryStorage,
    update.managerApproved, update.temporaryInstrumentCount, update.temporaryInstrumentName,
    update.temporaryInstrumentModel, update.temporaryHasUps, update.ecc, update.entryAt,
    legacy.enteredAt, update.contractUsdTaxAmount, update.finalConfirmableAmount,
  ].some((value) => value !== undefined);
};

/** 仪器批量导入单批最大行数（合理上限，超出要求拆分分批导入）。 */
export const INSTRUMENT_BULK_IMPORT_MAX_ROWS = 500;

export class WorkbenchFacade {
  private readonly projects: SqliteProjectRepository;
  private readonly contracts: SqliteContractRepository;
  private readonly instruments: SqliteInstrumentRepository;
  private readonly batches: SqliteBatchRepository;
  private readonly activities: SqliteActivityRepository;
  private readonly workFacts: SqliteWorkFactRepository;
  private readonly fees: SqliteLogisticsFeeRepository;
  private readonly orders: SqliteServiceOrderRepository;
  private readonly invoices: SqliteInvoiceRepository;
  private readonly damageItems: SqliteDamageRepairItemRepository;
  private readonly shipRequests: SqliteShipToRequestRepository;
  private readonly serialUpdates: SqliteSerialAddressUpdateRepository;
  private readonly qrRequests: SqliteQrRequestRepository;
  private readonly projectTags: SqliteProjectTagRepository;

  constructor(
    private readonly db: DatabaseSync,
    private readonly session: () => AccountSessionInfo,
    /** 测试/接线可注入的服务覆盖（事务感知仓储，用于验证原子性）。 */
    private readonly injected?: {
      shipToService?: ShipToService;
      /** 测试注入的二维码服务，用于验证类型行写失败时外层事务整体回滚。 */
      qrRequestService?: QrRequestService;
      /** 「清理全部业务数据」confirm 前安全备份执行器（复用现有备份机制）。 */
      cleanupBackup?: () => Promise<string>;
      /** 仅测试注入的清理测试钩子（now/rotateGeneration/onAfterDeletes/onBeforeForeignKeys）。 */
      cleanupHooks?: Partial<Pick<DataCleanupOptions, 'now' | 'rotateGeneration' | 'onAfterDeletes' | 'onBeforeForeignKeys'>>;
    },
  ) {
    this.projects = new SqliteProjectRepository(db);
    this.contracts = new SqliteContractRepository(db);
    this.instruments = new SqliteInstrumentRepository(db);
    this.batches = new SqliteBatchRepository(db);
    this.activities = new SqliteActivityRepository(db);
    this.workFacts = new SqliteWorkFactRepository(db);
    this.fees = new SqliteLogisticsFeeRepository(db);
    this.orders = new SqliteServiceOrderRepository(db);
    this.invoices = new SqliteInvoiceRepository(db);
    this.damageItems = new SqliteDamageRepairItemRepository(db);
    this.shipRequests = new SqliteShipToRequestRepository(db);
    this.serialUpdates = new SqliteSerialAddressUpdateRepository(db);
    this.qrRequests = new SqliteQrRequestRepository(db);
    this.projectTags = new SqliteProjectTagRepository(db);
  }

  // ---------------------------------------------------------------------------
  // Ship-to 申请：按 requestId 线性推进的独立命令（仅返回受影响申请，不携带任何快照）。
  // ---------------------------------------------------------------------------

  /** 创建 Ship-to 申请：同客户同新址已有申请时返回既有记录（不自动 submit、不重复创建）。 */
  createShipToRequest(input: ShipToRequestInputDto): ShipToRequestResultDto {
    const request = this.shipToService().createRequest(input, this.actor());
    return { request: serializeShipToRequest(request) };
  }
  /** 提交既有申请：待提交 → 处理中（记录首次提交时间，计一次工作量）。 */
  submitShipToRequest(requestId: string): ShipToRequestResultDto {
    const request = this.shipToService().submit(requestId, this.actor());
    return { request: serializeShipToRequest(request) };
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：工作台 v2 有界读取（snapshot 已删除，工作台只经 v2 读取）。
  // 全部读取经 WorkbenchReadRepository 的 SQL 有界实现（分页 + 聚合，禁止全量扫描）。
  // ---------------------------------------------------------------------------

  private v2Reader(): WorkbenchReadRepository {
    const reminder = this.reminderService();
    return new WorkbenchReadRepository(this.db, {
      today: new SystemClock().today(),
      windowDays: reminder.getUpcomingWindowDays(),
    });
  }

  v2Overview(): WorkbenchV2OverviewDto {
    return this.v2Reader().overview();
  }

  v2ProjectPage(request: WorkbenchV2ProjectPageRequest): WorkbenchV2ProjectPageDto {
    return this.v2Reader().projectPage(request);
  }

  v2ProjectDetail(projectId: string): WorkbenchV2ProjectDetailDto {
    return this.v2Reader().projectDetail(projectId);
  }

  v2SectionPage(request: WorkbenchV2SectionPageRequest): WorkbenchV2SectionPageDto {
    return this.v2Reader().sectionPage(request);
  }

  v2IndependentPage(request: WorkbenchV2IndependentPageRequest): WorkbenchV2IndependentPageDto {
    return this.v2Reader().independentPage(request);
  }

  v2LookupPage(request: WorkbenchV2LookupPageRequest): WorkbenchV2LookupPageDto {
    return this.v2Reader().lookupPage(request);
  }

  v2HistoryPage(request: WorkbenchV2HistoryPageRequest): WorkbenchV2HistoryPageDto {
    return this.v2Reader().historyPage(request);
  }

  /** 完整提醒视图（tasks 7.3）：全部项目提醒 + 到期分类，sort asc/desc 默认 desc。 */
  v2ReminderPage(request: WorkbenchV2ReminderPageRequest): WorkbenchV2ReminderPageDto {
    return this.v2Reader().reminderPage(request);
  }

  /** 提醒泳道（tasks 7.6）：先按日期选列、再按列读取项目（列 cursor 不重算日期集合）。 */
  v2ReminderLanes(request: WorkbenchV2ReminderLanesRequest): WorkbenchV2ReminderLanesDto {
    return this.v2Reader().reminderLanes(request);
  }

  v2TagCatalog(request: ProjectTagCatalogRequestDto = {}): ProjectTagCatalogDto {
    return this.projectTags.catalog(request.projectId);
  }

  v2TagMutate(request: ProjectTagMutationRequestDto): ProjectTagMutationResultDto {
    let result!: ProjectTagMutationResultDto;
    this.transaction(() => {
      switch (request.command) {
        case 'create_group': result = { businessRevision: 0, group: this.projectTags.createGroup(request.payload), invalidated: ['tag_catalog'] }; break;
        case 'create_tag': { const created = this.projectTags.createTag(request.payload); result = { businessRevision: 0, ...created, invalidated: ['tag_catalog'] }; break; }
        case 'rename_group': {
          const group = this.projectTags.renameGroup(request.payload.groupId, request.payload);
          result = { businessRevision: 0, group, invalidated: ['tag_catalog', 'projects', 'reminders'] };
          break;
        }
        case 'rename_tag': {
          const tag = this.projectTags.renameTag(request.payload.tagId, request.payload);
          result = { businessRevision: 0, tag, invalidated: ['tag_catalog', 'projects', 'reminders'] };
          break;
        }
        case 'replace_project_tags': { const assigned = this.projectTags.replaceSet(request.payload.projectId, request.payload.tagIds); result = { businessRevision: 0, projectId: request.payload.projectId, ...assigned, invalidated: ['tag_catalog', 'projects', 'reminders', `project:${request.payload.projectId}`] }; break; }
      }
    });
    return { ...result, businessRevision: readBusinessRevision(this.db) } as ProjectTagMutationResultDto;
  }

  // ---------------------------------------------------------------------------
  // 「清理全部业务数据」两阶段 API（prepare → confirm）。
  // 备份执行器由接线层注入（复用现有备份机制）；token 绑定 DB identity/generation/revision。
  // ---------------------------------------------------------------------------

  cleanPrepare(): DataCleanPrepareDto {
    return this.cleanupService().prepare();
  }

  cleanConfirm(request: DataCleanConfirmRequestDto): Promise<DataCleanConfirmResultDto> {
    return this.cleanupService().confirm(request);
  }

  private cleanupService(): DataCleanupService {
    return new DataCleanupService(this.db, {
      backup: () => {
        if (!this.injected?.cleanupBackup) {
          throw new ValidationError('CLEAN_BACKUP_UNAVAILABLE', '未配置清理前安全备份执行器');
        }
        return this.injected.cleanupBackup();
      },
      ...(this.injected?.cleanupHooks ?? {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：普通写动作的 v2 有界 mutation 入口。
  // 复用下方 write* 写逻辑（与 v1 完全一致），但绝不调用 snapshot()——
  // 返回 businessRevision + invalidate tags + 受影响的实体引用（bounded）。
  // ---------------------------------------------------------------------------

  v2Mutate(request: WorkbenchV2MutationRequest): WorkbenchV2MutationResult {
    let changed: WorkbenchV2MutationResult['changed'] = null;
    let extraTags: WorkbenchV2InvalidateTag[] = [];
    switch (request.op) {
      case 'create_project': {
        const ref = this.writeCreateProject(request.payload as ProjectWizardPayload);
        changed = { projectId: ref.projectId, created: true };
        break;
      }
      case 'update_project': {
        const update = request.payload as ProjectUpdatePayload;
        const ref = this.writeUpdateProject(update.projectId, update);
        changed = { projectId: ref.projectId };
        if (update.customerName !== undefined) {
          // 客户重关联可能登记新客户，客户 lookup 需要重读。
          extraTags.push('lookup:customers');
        }
        break;
      }
      case 'supplement_project': {
        const supplement = request.payload as ProjectSupplementPayload;
        const ref = this.writeSupplementProject(supplement);
        changed = { projectId: ref.projectId };
        if (supplement.customerName !== undefined) {
          extraTags.push('lookup:customers');
        }
        break;
      }
      case 'submit_action': {
        const action = request.action!;
        // 请求顶层 projectId 未写入 action 时补齐（writeSubmitAction 以 payload.projectId 为归属）。
        if (action.projectId === undefined && request.projectId) {
          action.projectId = request.projectId;
        }
        const ref = this.writeSubmitAction(action);
        changed = { projectId: ref.projectId };
        switch (action.type) {
          case 'serial_address':
            extraTags.push('independent:serial_address');
            break;
          case 'qr_request':
            extraTags.push('independent:qr_request');
            break;
          case 'ship_to':
            extraTags.push('lookup:ship_to_requests');
            break;
          default:
            break;
        }
        break;
      }
      case 'set_reminder':
        this.writeSetReminder(request.projectId!, request.reminderAt ?? null, request.reminderNote ?? null);
        changed = { projectId: request.projectId };
        extraTags.push('reminders');
        break;
      case 'clear_reminder':
        this.writeClearReminder(request.projectId!);
        changed = { projectId: request.projectId };
        extraTags.push('reminders');
        break;
      case 'adjust_status':
        this.writeAdjustStatus(request.projectId!, request.status!);
        changed = { projectId: request.projectId, status: request.status };
        break;
      case 'cancel_project':
        this.writeCancelProject(request.projectId!, request.time!, request.reason!);
        changed = { projectId: request.projectId, status: 'cancelled' };
        break;
      case 'ship_to_complete': {
        const record = this.writeCompleteShipToRequest(request.requestId!, request.accountId!);
        extraTags.push('lookup:ship_to_requests');
        changed = {
          requestId: record.id,
          status: record.status,
          accountId: record.accountId,
        };
        break;
      }
      case 'invoice_edit': {
        const ref = this.writeEditInvoice(request.invoiceId!, request.invoicedAt!, request.amount!);
        changed = { projectId: ref.projectId, invoiceId: ref.invoiceId };
        break;
      }
      case 'invoice_revoke': {
        const ref = this.writeRevokeInvoice(request.invoiceId!, request.time!, request.reason!);
        changed = { projectId: ref.projectId, invoiceId: ref.invoiceId, status: 'revoked' };
        break;
      }
      case 'batch_edit': {
        const edit = request.payload as BatchEditPayload;
        const ref = this.writeEditBatch(edit);
        changed = { projectId: ref.projectId, batchId: ref.batchId };
        break;
      }
      case 'instrument_bulk_import': {
        const bulk = request.payload as InstrumentBulkImportPayload;
        const ref = this.writeInstrumentBulkImport(bulk.projectId, bulk.rows);
        changed = { projectId: ref.projectId, importedCount: ref.count };
        break;
      }
      case 'damage_update': {
        const ref = this.writeDamageUpdate(request);
        if (ref.projectId) {
          changed = { projectId: ref.projectId };
        }
        break;
      }
      case 'instrument_update': {
        this.assertRecordEditingRequestShape(request);
        const ref = this.writeInstrumentUpdate(request);
        changed = { projectId: ref.projectId };
        break;
      }
      case 'service_order_note_update': {
        this.assertRecordEditingRequestShape(request);
        const ref = this.writeServiceOrderNoteUpdate(request);
        changed = ref.projectId ? { projectId: ref.projectId } : {};
        break;
      }
      case 'service_order_engineer_update': {
        this.assertRecordEditingRequestShape(request);
        const ref = this.writeServiceOrderEngineerUpdate(request);
        changed = ref.projectId ? { projectId: ref.projectId } : {};
        break;
      }
      default:
        throw new ValidationError('V2_MUTATION_UNKNOWN', `未知的 v2 mutation 操作: ${String((request as { op?: unknown }).op)}`);
    }
    const tags: WorkbenchV2InvalidateTag[] = ['overview', 'projects'];
    if (changed?.projectId) {
      tags.push(`project:${changed.projectId}`, `sections:${changed.projectId}`);
    }
    tags.push(...extraTags);
    return {
      businessRevision: readBusinessRevision(this.db),
      invalidated: [...new Set(tags)],
      changed,
    };
  }

  // ---------------------------------------------------------------------------
  // 受保护登记记录删除（判别联合 + 预期业务修订防并发）。
  // - BEGIN IMMEDIATE 事务内核验 expectedRevision（防 TOCTOU：BEGIN IMMEDIATE 之前
  //   发生的写入也会被拒绝），随后按 kind 分发到显式 type-specific policy
  //   （WorkbenchDeletePolicies，design D3）；
  // - 成功删除与最小 tombstone（record_deletion_audit）同事务原子写入；
  //   import_record_audit 保留并标记指向已删除目标（target_deleted_at /
  //   target_delete_operation_id），绝不物理擦除来源审计；拒绝路径零写；
  // - 现有各类型行为保持不变：batch 仅未开始运输/无当前仪器/无改批历史；
  //   activity 存在工作事实或维修关联拒绝（不级联清事实）；damage 删除其拥有的
  //   活动关联；Ship-to 未完成且无 Account ID 可删除，已完成时须有来源证明且无仪器
  //   引用；instrument 所属批次已开始运输也禁止；acceptance 有 invoice 历史拒绝，
  //   否则清空验收事实并按事实确定性回退状态；invoice 映射到现有 revoke（必填撤销
  //   日期/原因），绝不物理删除。
  // ---------------------------------------------------------------------------

  v2Delete(request: WorkbenchV2DeleteRequest): WorkbenchV2DeleteResult {
    const state: {
      changed: { kind: WorkbenchV2DeleteRequest['kind']; id: string; projectId?: string } | null;
      extraTags: WorkbenchV2InvalidateTag[];
    } = { changed: null, extraTags: [] };
    this.transactionImmediate(() => {
      // 事务内核验 expectedRevision（BEGIN IMMEDIATE 锁下防并发竞态）。
      const currentRevision = readBusinessRevision(this.db);
      if (request.expectedRevision !== currentRevision) {
        throw new ValidationError(
          DELETE_REJECTION_CODES.REVISION_MISMATCH,
          `业务修订已变化（预期 ${request.expectedRevision}，当前 ${currentRevision}），请刷新后重试`,
        );
      }
      const outcome = this.deletePolicies().execute(request);
      state.changed = outcome.changed;
      state.extraTags = outcome.extraTags;
    });
    const tags: WorkbenchV2InvalidateTag[] = ['overview', 'projects'];
    if (state.changed?.projectId) {
      tags.push(`project:${state.changed.projectId}`, `sections:${state.changed.projectId}`);
    }
    tags.push(...state.extraTags);
    return {
      businessRevision: readBusinessRevision(this.db),
      invalidated: [...new Set(tags)],
      changed: state.changed,
    };
  }

  // ---------------------------------------------------------------------------
  // 计划上门日期到期自动推进（Tasks 3.2/3.3 应用操作）：
  // 幂等、审计、事务内重查 + CAS，复用 lifecycle 唯一入口（见 due-plan-visit-advancer）。
  // 由主进程接线层在迁移后/首个工作台读取前、app activate、powerMonitor resume 与
  // 跨本地业务日期边界时触发；桌面关闭期间不承诺运行，下次 catch-up 用 <= 补跑。
  // ---------------------------------------------------------------------------

  advanceDuePlanVisits(today: string): DuePlanVisitAdvanceResult {
    const d = businessDate(today, '当前业务日期');
    if (d === undefined) {
      throw new ValidationError('REQUIRED_FIELD', '当前业务日期必填');
    }
    return new SqliteDuePlanVisitAdvancer(this.db).advanceDuePlanVisits(d);
  }

  // ---------------------------------------------------------------------------
  // Oracle #10：写逻辑抽取（v1 snapshot 与 v2 mutation 共用，v2 路径不调用 snapshot()）。
  // 旧 API 仅为 UI 迁移暂留，后续随旧 UI 一并删除。
  // ---------------------------------------------------------------------------

  private writeCreateProject(input: ProjectWizardPayload): { projectId: string } {
    // 契约收紧（ora-1 / tasks 2.5 / 6.4）：废弃字段有值即稳定拒绝（绝不静默忽略）。
    // 建档公开类型已移除 finalAmount/serviceOrderNo/engineers/serviceOrderNote/missingItems
    // （approvalReason 亦被 managerApproved 替代、不再收集），但外部 JS/旧调用仍可能传入
    // 有值 → 经运行时探测形状检查并返回既有 WIZARD_REJECTION_CODES，绝不静默丢弃。
    const legacy = input as ProjectWizardPayload & {
      finalAmount?: unknown;
      serviceOrderNo?: unknown;
      engineers?: unknown;
      serviceOrderNote?: unknown;
      missingItems?: unknown;
    };
    const deprecatedFields: Array<[string, unknown]> = [
      ['finalAmount', legacy.finalAmount],
      ['serviceOrderNo', legacy.serviceOrderNo],
      ['engineers', legacy.engineers],
      ['serviceOrderNote', legacy.serviceOrderNote],
      ['missingItems', legacy.missingItems],
      // 0810：未进单先执行以 managerApproved boolean 事实为准，不再收集批复原因。
      ['approvalReason', input.approvalReason],
    ];
    for (const [name, value] of deprecatedFields) {
      if (String(value ?? '').trim() !== '') {
        throw new ValidationError(
          WIZARD_REJECTION_CODES.DEPRECATED_FIELD,
          `新建项目已不再支持字段「${name}」（值「${String(value)}」已被拒绝，未静默忽略）；请经正式进单/补齐资料或独立动作提交`,
        );
      }
    }
    // 仅 formal 允许携带 ECC/进单日期/合同金额；非 formal 有值即稳定拒绝。
    if (input.intent !== 'formal') {
      if (text(input.ecc) !== '') {
        throw new ValidationError(WIZARD_REJECTION_CODES.ECC_ONLY_FORMAL, 'ECC 仅允许 intent=formal 新建项目携带；draft/pre_entry_execution 请先建草稿再经正式进单');
      }
      if (input.entryAt !== undefined && input.entryAt !== '') {
        throw new ValidationError(WIZARD_REJECTION_CODES.ENTRY_AT_ONLY_FORMAL, '进单日期仅允许 intent=formal 新建项目携带；draft/pre_entry_execution 请先建草稿再经正式进单');
      }
      if (text(input.contractAmount) !== '') {
        throw new ValidationError(WIZARD_REJECTION_CODES.CONTRACT_AMOUNT_ONLY_FORMAL, '合同金额仅允许 intent=formal 新建项目携带；draft/pre_entry_execution 请先建草稿再经正式进单');
      }
    }
    let projectId = '';
    this.transaction(() => {
      const projectService = this.projectService();
      const customerRepo = new SqliteCustomerRepository(this.db);
      const customer = customerRepo.findByName(input.customerName.trim()) ?? new CustomerService(customerRepo).register(input.customerName);
      const project = projectService.createPendingProject();
      projectId = project.id;
      projectService.linkCustomer(project.id, customer.id);
      projectService.setRegion(project.id, input.region);
      projectService.updateBasicInfo(project.id, { oldSiteContact: input.oldSiteContact, newSiteContact: input.newSiteContact, oldSiteAddress: input.oldSiteAddress ?? null, newSiteAddress: input.newSiteAddress ?? null, contractStartDate: input.contractStartDate ?? null, contractEndDate: input.contractEndDate ?? null });
      // 先记录未进单先执行事实，再写可能已到期的计划上门日期。到期自动推进后
      // 项目已是 executing，反过来再设置标签会被 LABEL_ONLY_PENDING 错误拒绝。
      if (input.intent === 'pre_entry_execution') {
        projectService.setPreEntryExecution(project.id, { approved: input.managerApproved });
      }
      this.updateExecutionPreparationWithDueAudit(project.id, {
        planVisitAt: input.planVisitAt ? businessDate(input.planVisitAt, '计划上门日期') ?? null : null,
        planTransportAt: input.planTransportAt ? businessDate(input.planTransportAt, '计划运输日期') ?? null : null,
        siteConfirmed: input.siteConfirmed ?? false,
      });
      // 计划装机日期（「计划装机完成日期」更名；公开契约字段 plannedInstallAt，
      // 兼容 alias plannedInstallDoneAt 同值）：独立字段，不触发生命周期。
      const plannedInstallRaw = input.plannedInstallAt ?? input.plannedInstallDoneAt;
      if (plannedInstallRaw) {
        projectService.setPlannedInstallDoneAt(project.id, businessDate(plannedInstallRaw, '计划装机日期') ?? null);
      }
      // 项目备注（可空；不影响主状态）。
      if (input.projectNote !== undefined) {
        projectService.setProjectNote(project.id, input.projectNote ?? null);
      }
      // 暂存信息（手工维护执行事实，不触发主状态流转）。
      if (input.temporaryStorageAddress !== undefined || input.isTemporaryStorage !== undefined) {
        projectService.updateTemporaryStorage(project.id, {
          temporaryStorageAddress: input.temporaryStorageAddress,
          isTemporaryStorage: input.isTemporaryStorage,
        });
      }
      // 暂定仪器范围（v16 手工维护项目级标量事实：名称/型号/是否配备 UPS；
      // 不创建/删除/修改任何 instruments 行，不触发主状态流转）。
      if (
        input.temporaryInstrumentName !== undefined ||
        input.temporaryInstrumentModel !== undefined ||
        input.temporaryHasUps !== undefined
      ) {
        projectService.updateTemporaryInstrument(project.id, {
          temporaryInstrumentName: input.temporaryInstrumentName,
          temporaryInstrumentModel: input.temporaryInstrumentModel,
          temporaryHasUps: input.temporaryHasUps,
        });
      }
      // 暂定仪器数量（正整数，可空）：有值（正整数）才记录数量并确认搬迁范围，
      // 不生成虚拟仪器；未提供/0/空则不确定范围（正式进单已不再要求搬迁范围）。
      const instrumentCount = input.instrumentCount;
      if (instrumentCount === undefined || instrumentCount === null) {
        // 未提供：不确认搬迁范围。
      } else if (!Number.isInteger(instrumentCount) || instrumentCount <= 0) {
        throw new ValidationError('INSTRUMENT_COUNT_REQUIRED', '仪器数量必须为大于 0 的整数（instrumentCount），或留空表示暂不确定范围');
      } else {
        projectService.setTemporaryInstrumentCount(project.id, instrumentCount);
        projectService.confirmScope(project.id);
      }

      // intent 决定是否正式进单（不再由 ECC 推断）：
      // - formal：补建合同、设置合同金额（optional money parser：空字符串保持 null，
      //   绝不虚构 0）、formalEntry（ECC/合同/客户/进单日期必填，缺任一由领域校验拒绝）；
      // - draft：仅创建待进单草稿项目（不补建合同、不设置 ECC）；
      // - pre_entry_execution：待进单 + 未进单先执行（经理批复原因必填，沿用既有校验）。
      if (input.intent === 'formal') {
        projectService.attachContract(project.id);
        const contractAmount = optionalMoney(input.contractAmount);
        if (contractAmount !== null) {
          this.financialService().setContractUsdTaxAmount(project.id, contractAmount);
        }
        projectService.formalEntry(project.id, {
          ecc: text(input.ecc),
          entryAt: businessDate(input.entryAt, '进单日期'),
        });
      }
      // intent='draft'：仅待进单草稿（无合同、无 ECC、不正式进单）。
      if (input.actualInstallDoneAt) projectService.recordActualInstallDone(project.id, businessDate(input.actualInstallDoneAt, '实际装机完成日期') ?? '');
      if (input.tagIds !== undefined) this.projectTags.replaceSet(project.id, input.tagIds);
    });
    return { projectId };
  }

  /**
   * 更新项目资料（v2 update_project）：同一事务内复用现有领域命令原子落库。
   * - 普通资料（客户重关联/区域/联系人/地址/合同起止/计划上门运输/现场确认）任何状态可更新；
   * - ECC / 进单时间 / 合同金额 / 最终可确认金额更正仅允许已正式进单项目（待进单项目必须走
   *   core/formalEntry 语义，update_project 不绕过正式进单校验，避免绕过财务闭环）；
   * - 已取消项目禁止资料更新（终态），但仅替换分类标签不进入项目写模型；
   * - 三态输入：undefined=未提交、null=显式清空（仅可空字段；ECC/进单时间 null 视为未提交，
   *   金额 null 解析为 0 交由领域校验决定是否接受）、有值=覆盖；布尔显式传 false。
   */
  private writeUpdateProject(projectId: string, update: ProjectUpdatePayload): { projectId: string } {
    this.transaction(() => {
      const projectService = this.projectService();
      const project = this.projects.findById(projectId);
      if (!project) {
        throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
      }
      const hasFields = hasProjectUpdateFields(update);
      // 标签是独立分类关联：仅提交 tagIds 时只验证项目/标签并在本事务 replace-set，
      // 不触发项目标量更新、lifecycle、提醒或状态转换审计；已取消项目亦可维护。
      if (update.tagIds !== undefined && !hasFields) {
        this.projectTags.replaceSet(projectId, update.tagIds);
        return;
      }
      // 空 patch 仅完成项目存在性校验，不写入任何业务记录。
      if (!hasFields) return;
      if (project.status === 'cancelled') {
        throw new ValidationError('CANCELLED_PROJECT', '已取消项目禁止修改项目资料');
      }
      const formallyEntered = isFormallyEntered(project);

      // 客户重关联：按去除首尾空白后的名称全局唯一匹配，不存在则登记新客户并关联。
      if (update.customerName !== undefined) {
        const name = update.customerName.trim();
        if (name === '') {
          throw new ValidationError('CUSTOMER_NAME_REQUIRED', '客户名称必填');
        }
        const customerRepo = new SqliteCustomerRepository(this.db);
        const customer = customerRepo.findByName(name) ?? new CustomerService(customerRepo).register(name);
        projectService.linkCustomer(projectId, customer.id);
      }

      // 基础字段与合同起止日期（可空/可清除：null 或空串 = 清空；缺省合并现值；
      // 截止不得早于开始由领域校验）。
      // 字段名兼容：renderer 新契约使用 contractStartDate/contractEndDate，旧名 contractStartAt/
      // contractEndAt 继续接受（保留既有调用方）。
      const contractStartDate = update.contractStartDate !== undefined
        ? update.contractStartDate
        : (update as ProjectUpdatePayload & { contractStartAt?: string | null }).contractStartAt;
      const contractEndDate = update.contractEndDate !== undefined
        ? update.contractEndDate
        : (update as ProjectUpdatePayload & { contractEndAt?: string | null }).contractEndAt;
      if (
        update.oldSiteContact !== undefined || update.newSiteContact !== undefined ||
        update.oldSiteAddress !== undefined || update.newSiteAddress !== undefined ||
        contractStartDate !== undefined || contractEndDate !== undefined
      ) {
        const current = this.projects.findById(projectId)!;
        projectService.updateBasicInfo(projectId, {
          oldSiteContact: update.oldSiteContact !== undefined ? update.oldSiteContact : current.oldSiteContact,
          newSiteContact: update.newSiteContact !== undefined ? update.newSiteContact : current.newSiteContact,
          oldSiteAddress: update.oldSiteAddress !== undefined ? update.oldSiteAddress : current.oldSiteAddress,
          newSiteAddress: update.newSiteAddress !== undefined ? update.newSiteAddress : current.newSiteAddress,
          contractStartDate: contractStartDate === undefined ? current.contractStartDate : (contractStartDate === '' ? null : contractStartDate),
          contractEndDate: contractEndDate === undefined ? current.contractEndDate : (contractEndDate === '' ? null : contractEndDate),
        });
      }

      if (update.region !== undefined) projectService.setRegion(projectId, update.region);

      // 执行准备：计划上门/运输日期（null=清空，业务日期 yyyy-mm-dd）、计划装机日期
      // （「计划装机完成日期」更名，独立字段不触发生命周期；公开字段 plannedInstallAt、
      //  兼容 alias plannedInstallDoneAt 同值）与现场确认（显式 false=清除）。
      if (
        update.plannedVisitAt !== undefined || update.plannedTransportAt !== undefined ||
        update.plannedInstallAt !== undefined || update.plannedInstallDoneAt !== undefined ||
        update.siteConfirmed !== undefined
      ) {
        this.updateExecutionPreparationWithDueAudit(projectId, {
          planVisitAt: update.plannedVisitAt === undefined ? undefined : update.plannedVisitAt === null ? null : businessDate(update.plannedVisitAt, '计划上门日期'),
          planTransportAt: update.plannedTransportAt === undefined ? undefined : update.plannedTransportAt === null ? null : businessDate(update.plannedTransportAt, '计划运输日期'),
          siteConfirmed: update.siteConfirmed,
        });
      }
      const plannedInstallRaw =
        update.plannedInstallAt !== undefined ? update.plannedInstallAt : update.plannedInstallDoneAt;
      if (plannedInstallRaw !== undefined) {
        projectService.setPlannedInstallDoneAt(
          projectId,
          plannedInstallRaw === null || plannedInstallRaw === ''
            ? null
            : (businessDate(plannedInstallRaw, '计划装机日期') ?? null),
        );
      }

      // 0810 标量事实（tasks 2.5 / 6.4 / 6.5）：项目备注、暂存信息、是否批复与
      // 暂定仪器数量。均只更新项目标量：不创建/删除/修改任何仪器记录、
      // 不触发主状态流转（无 lifecycle/status 副作用）。
      if (update.projectNote !== undefined) {
        projectService.setProjectNote(projectId, update.projectNote ?? null);
      }
      if (update.temporaryStorageAddress !== undefined || update.isTemporaryStorage !== undefined) {
        projectService.updateTemporaryStorage(projectId, {
          temporaryStorageAddress: update.temporaryStorageAddress,
          isTemporaryStorage: update.isTemporaryStorage,
        });
      }
      if (update.managerApproved !== undefined) {
        projectService.setManagerApproved(projectId, update.managerApproved ?? null);
      }
      if (update.temporaryInstrumentCount !== undefined) {
        if (update.temporaryInstrumentCount === null) {
          projectService.clearTemporaryInstrumentCount(projectId);
        } else {
          projectService.setTemporaryInstrumentCount(projectId, update.temporaryInstrumentCount);
        }
      }
      // 暂定仪器范围（v16）：名称/型号/是否配备 UPS，三态输入与暂存信息同语义
      // （undefined=未提交、null=清空、有值=覆盖）；只更新项目标量，不建仪器、
      // 不触发主状态流转。
      if (
        update.temporaryInstrumentName !== undefined ||
        update.temporaryInstrumentModel !== undefined ||
        update.temporaryHasUps !== undefined
      ) {
        projectService.updateTemporaryInstrument(projectId, {
          temporaryInstrumentName: update.temporaryInstrumentName,
          temporaryInstrumentModel: update.temporaryInstrumentModel,
          temporaryHasUps: update.temporaryHasUps,
        });
      }

      // 以下更正仅允许已正式进单项目；待进单项目必须走 core/formalEntry 语义。
      // 进单日期字段名兼容：新契约 entryAt，旧名 enteredAt 继续接受。
      const entryAt = update.entryAt !== undefined
        ? update.entryAt
        : (update as ProjectUpdatePayload & { enteredAt?: string | null }).enteredAt;
      if (
        !formallyEntered &&
        (update.ecc !== undefined || entryAt !== undefined || update.contractUsdTaxAmount !== undefined || update.finalConfirmableAmount !== undefined)
      ) {
        throw new ValidationError(
          'UPDATE_REQUIRES_FORMAL_ENTRY',
          'ECC、进单日期、合同金额与最终可确认金额更正仅允许已正式进单项目；待进单项目请使用正式进单/补齐核心资料',
        );
      }

      // ECC/进单日期为必填业务字段，null 视为未提交（不可清空）。
      if (update.ecc != null) projectService.updateEcc(projectId, update.ecc);
      if (entryAt != null && entryAt !== '') projectService.setEntryAt(projectId, businessDate(entryAt, '进单日期') ?? '');
      // 合同金额允许 0、拒绝负数（领域 5.1）；最终可确认金额必须 > 0 且不低于累计有效掉票（领域 5.4），
      // 空串/null 解析为 0，由领域校验拒绝非法清空。
      if (update.contractUsdTaxAmount !== undefined) this.financialService().setContractUsdTaxAmount(projectId, parseAmountInput(update.contractUsdTaxAmount));
      if (update.finalConfirmableAmount !== undefined) this.financialService().setFinalConfirmableAmount(projectId, parseAmountInput(update.finalConfirmableAmount));
      if (update.tagIds !== undefined) this.projectTags.replaceSet(projectId, update.tagIds);
    });
    return { projectId };
  }

  /**
   * 补齐资料（v2 supplement_project）：面向尚未正式进单项目，同一事务内补齐新建项目
   * 全部可后补字段，并支持可选正式进单（携带非空 ECC）。开单只能由独立动作创建。
   * 全部经现有领域校验入口落库，不绕过正式进单校验（缺合同/客户/搬迁范围时 formalEntry
   * 按领域规则拒绝并整体回滚）。
   */
  private writeSupplementProject(input: ProjectSupplementPayload): { projectId: string } {
    // 旧补齐 IPC 曾将开单字段混入同次保存。公开 DTO 已移除它们，但旧 renderer/外部
    // JS 仍可能带入运行时形状；任一有值必须在事务前稳定拒绝，保证项目与开单零副作用。
    const legacy = input as ProjectSupplementPayload & {
      serviceOrderNo?: unknown;
      engineers?: unknown;
      serviceOrderNote?: unknown;
    };
    for (const [name, value] of [
      ['serviceOrderNo', legacy.serviceOrderNo],
      ['engineers', legacy.engineers],
      ['serviceOrderNote', legacy.serviceOrderNote],
    ] as const) {
      if (text(value) !== '') {
        throw new ValidationError(
          WIZARD_REJECTION_CODES.DEPRECATED_FIELD,
          `补齐资料已不再支持字段「${name}」；请通过独立开单动作提交`,
        );
      }
    }
    const { projectId } = input;
    this.transaction(() => {
      const projectService = this.projectService();
      const project = this.projects.findById(projectId);
      if (!project) {
        throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
      }
      if (project.status === 'cancelled') {
        throw new ValidationError('CANCELLED_PROJECT', '已取消项目禁止修改项目资料');
      }

      // 客户重关联：按去除首尾空白后的名称全局唯一匹配，不存在则登记新客户并关联。
      if (input.customerName !== undefined) {
        const name = input.customerName.trim();
        if (name === '') {
          throw new ValidationError('CUSTOMER_NAME_REQUIRED', '客户名称必填');
        }
        const customerRepo = new SqliteCustomerRepository(this.db);
        const customer = customerRepo.findByName(name) ?? new CustomerService(customerRepo).register(name);
        projectService.linkCustomer(projectId, customer.id);
      }

      // 基础字段与合同起止日期（null/空串 = 清空；缺省保持现值；截止不得早于开始由领域校验）。
      if (
        input.oldSiteContact !== undefined || input.newSiteContact !== undefined ||
        input.oldSiteAddress !== undefined || input.newSiteAddress !== undefined ||
        input.contractStartDate !== undefined || input.contractEndDate !== undefined
      ) {
        const current = this.projects.findById(projectId)!;
        projectService.updateBasicInfo(projectId, {
          oldSiteContact: input.oldSiteContact !== undefined ? input.oldSiteContact : current.oldSiteContact,
          newSiteContact: input.newSiteContact !== undefined ? input.newSiteContact : current.newSiteContact,
          oldSiteAddress: input.oldSiteAddress !== undefined ? input.oldSiteAddress : current.oldSiteAddress,
          newSiteAddress: input.newSiteAddress !== undefined ? input.newSiteAddress : current.newSiteAddress,
          contractStartDate: input.contractStartDate === undefined ? current.contractStartDate : (input.contractStartDate === '' ? null : input.contractStartDate),
          contractEndDate: input.contractEndDate === undefined ? current.contractEndDate : (input.contractEndDate === '' ? null : input.contractEndDate),
        });
      }

      if (input.region !== undefined) projectService.setRegion(projectId, input.region);

      // 执行准备：计划上门/运输日期与现场确认；计划装机日期为独立字段不触发生命周期
      // （「计划装机完成日期」更名；公开字段 plannedInstallAt、兼容 alias plannedInstallDoneAt 同值）。
      if (
        input.plannedVisitAt !== undefined || input.plannedTransportAt !== undefined ||
        input.siteConfirmed !== undefined
      ) {
        // 同 create：先记录标签，避免已到期日期把状态推进后标签无法再保存。
        if (!isFormallyEntered(this.projects.findById(projectId)!)) {
          if (input.managerApproved !== undefined) {
            projectService.setPreEntryExecution(projectId, { approved: input.managerApproved });
          } else if (input.approvalReason !== undefined && (input.approvalReason ?? '').trim() !== '') {
            projectService.setPreEntryExecution(projectId, { approved: true });
          }
        }
        this.updateExecutionPreparationWithDueAudit(projectId, {
          planVisitAt: input.plannedVisitAt === undefined ? undefined : input.plannedVisitAt === null ? null : businessDate(input.plannedVisitAt, '计划上门日期'),
          planTransportAt: input.plannedTransportAt === undefined ? undefined : input.plannedTransportAt === null ? null : businessDate(input.plannedTransportAt, '计划运输日期'),
          siteConfirmed: input.siteConfirmed,
        });
      }
      const plannedInstallRaw =
        input.plannedInstallAt !== undefined ? input.plannedInstallAt : input.plannedInstallDoneAt;
      if (plannedInstallRaw !== undefined) {
        projectService.setPlannedInstallDoneAt(
          projectId,
          plannedInstallRaw === null || plannedInstallRaw === ''
            ? null
            : (businessDate(plannedInstallRaw, '计划装机日期') ?? null),
        );
      }

      // 补齐搬迁范围数量：提供时必须为正整数；记录暂定数量并确认搬迁范围
      // （与 create_project 的 instrumentCount 同口径），确保随后的可选正式进单
      // （携带 ECC）能通过 SCOPE_REQUIRED 校验；未提供时保持现值。
      if (input.instrumentCount !== undefined) {
        const instrumentCount = input.instrumentCount;
        if (!Number.isInteger(instrumentCount) || instrumentCount <= 0) {
          throw new ValidationError('INSTRUMENT_COUNT_REQUIRED', '补齐资料：仪器数量必须为大于 0 的整数（instrumentCount）');
        }
        projectService.setTemporaryInstrumentCount(projectId, instrumentCount);
        projectService.confirmScope(projectId);
      }

      // 暂定仪器范围（v16）：名称/型号/是否配备 UPS，三态输入与暂存信息同语义；
      // 只更新项目标量，不建仪器、不触发主状态流转。
      if (
        input.temporaryInstrumentName !== undefined ||
        input.temporaryInstrumentModel !== undefined ||
        input.temporaryHasUps !== undefined
      ) {
        projectService.updateTemporaryInstrument(projectId, {
          temporaryInstrumentName: input.temporaryInstrumentName,
          temporaryInstrumentModel: input.temporaryInstrumentModel,
          temporaryHasUps: input.temporaryHasUps,
        });
      }

      // 实际装机完成日期：先于正式进单记录实际装机事实（null/空串 = 保持现值），
      // 使 formalEntry 重算能按既有实际完成/验收事实得出主状态（如自动待验收）。
      if (input.actualInstallDoneAt !== undefined && input.actualInstallDoneAt !== null && input.actualInstallDoneAt !== '') {
        projectService.recordActualInstallDone(projectId, businessDate(input.actualInstallDoneAt, '实际装机完成日期') ?? '');
      }

      const ecc = (input.ecc ?? '').trim() || null;
      const formallyEntered = isFormallyEntered(this.projects.findById(projectId)!);
      if (ecc !== null && ecc !== '' && !formallyEntered) {
        // 可选正式进单：补建合同（正式进单前置校验要求）并设置合同金额后执行 formalEntry。
        // 不无条件推进 pending_execution：formalEntry 内部按既有实际完成/验收事实重算主状态，
        // 主状态保持领域重算结果（明确自动触发除外；待进单项目由负责人后续人工确定）。
        if (!this.contracts.findByProjectId(projectId)) {
          projectService.attachContract(projectId);
        }
        if (input.contractAmount !== undefined) {
          this.financialService().setContractUsdTaxAmount(projectId, parseAmountInput(input.contractAmount));
        }
        projectService.formalEntry(projectId, {
          ecc,
          entryAt: input.entryAt && input.entryAt !== '' ? businessDate(input.entryAt, '进单日期') : undefined,
          finalConfirmableAmountCents: (input.finalAmount ?? '') === '' ? undefined : parseAmountInput(input.finalAmount),
        });
      } else if (input.contractAmount !== undefined) {
        // 尚未正式进单也允许先补合同金额（不触发正式进单）。
        if (!this.contracts.findByProjectId(projectId)) {
          projectService.attachContract(projectId);
        }
        this.financialService().setContractUsdTaxAmount(projectId, parseAmountInput(input.contractAmount));
      }

      // 未进单先执行：仅对待进单项目生效（正式进单后忽略）。
      // 0810：以「是否批复」boolean 事实为准（managerApproved 显式提供优先）；
      // 旧调用仅传 approvalReason（非空）视为已批复，不再收集批复原因/缺失资料。
      if (!isFormallyEntered(this.projects.findById(projectId)!)) {
        if (input.managerApproved !== undefined && !this.projects.findById(projectId)!.preEntryExecution) {
          projectService.setPreEntryExecution(projectId, { approved: input.managerApproved });
        } else if (input.approvalReason !== undefined && (input.approvalReason ?? '').trim() !== '') {
          projectService.setPreEntryExecution(projectId, { approved: true });
        }
      }

    });
    return { projectId };
  }

  /**
   * 仪器批量导入（v2 instrument_bulk_import）：.xlsx 5 列（名称/厂商/型号/序列号/服务级别）
   * 整批 append 登记，同一事务内原子落库——任一行为空名称、payload 内或库内序列号重复
   * 均整体失败（不产生部分写入）。最多合理行数由常量限制。
   */
  private writeInstrumentBulkImport(
    projectId: string,
    rows: InstrumentBulkImportPayload['rows'],
  ): { projectId: string; count: number } {
    let count = 0;
    this.transaction(() => {
      const list = rows as InstrumentBulkImportPayload['rows'];
      if (list.length === 0) {
        throw new ValidationError('BULK_EMPTY', '批量导入至少需要一行仪器数据');
      }
      if (list.length > INSTRUMENT_BULK_IMPORT_MAX_ROWS) {
        throw new ValidationError(
          'BULK_TOO_MANY_ROWS',
          `批量导入最多 ${INSTRUMENT_BULK_IMPORT_MAX_ROWS} 行，本次 ${list.length} 行；请拆分后分批导入`,
        );
      }
      const imported = this.executionService().bulkRegisterInstruments(projectId, list as never, this.actor());
      count = imported.length;
    });
    return { projectId, count };
  }

  /** 仪器可编辑字段与改批在同一事务内提交；改批失败时字段更新一并回滚。 */
  private writeInstrumentUpdate(input: Extract<WorkbenchV2MutationRequest, { op: 'instrument_update' }>): { projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const payload = this.recordEditingPayload(input.payload, ['instrumentId', 'manufacturer', 'model', 'serviceLevel', 'serialNo', 'ups', 'qrRequested', 'batchId']) as unknown as typeof input.payload;
      if (typeof payload.instrumentId !== 'string' || (payload.manufacturer !== null && typeof payload.manufacturer !== 'string') || (payload.model !== null && typeof payload.model !== 'string') || (payload.serviceLevel !== null && typeof payload.serviceLevel !== 'string') || (payload.serialNo !== null && typeof payload.serialNo !== 'string') || typeof payload.ups !== 'boolean' || typeof payload.qrRequested !== 'boolean' || (payload.batchId !== null && typeof payload.batchId !== 'string')) {
        throw new ValidationError('V2_MUTATION_PAYLOAD_INVALID', '仪器编辑字段格式不正确');
      }
      const instrumentId = payload.instrumentId;
      const instrument = this.instruments.findById(instrumentId);
      if (!instrument) throw new ValidationError('INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${instrumentId}`);
      projectId = instrument.projectId;
      if (
        instrument.manufacturer === (payload.manufacturer?.trim() === '' ? null : (payload.manufacturer?.trim() ?? null)) &&
        instrument.model === (payload.model?.trim() === '' ? null : (payload.model?.trim() ?? null)) &&
        instrument.serviceLevel === (payload.serviceLevel?.trim() === '' ? null : (payload.serviceLevel?.trim() ?? null)) &&
        instrument.serialNo === (payload.serialNo?.trim() === '' ? null : (payload.serialNo?.trim() ?? null)) &&
        instrument.ups === payload.ups &&
        instrument.qrRequested === payload.qrRequested &&
        instrument.batchId === payload.batchId
      ) {
        return;
      }
      const execution = this.executionService();
      if (
        instrument.manufacturer !== (payload.manufacturer?.trim() === '' ? null : (payload.manufacturer?.trim() ?? null)) ||
        instrument.model !== (payload.model?.trim() === '' ? null : (payload.model?.trim() ?? null)) ||
        instrument.serviceLevel !== (payload.serviceLevel?.trim() === '' ? null : (payload.serviceLevel?.trim() ?? null)) ||
        instrument.serialNo !== (payload.serialNo?.trim() === '' ? null : (payload.serialNo?.trim() ?? null)) ||
        instrument.ups !== payload.ups ||
        instrument.qrRequested !== payload.qrRequested
      ) {
        execution.updateInstrumentFields(instrumentId, {
          manufacturer: payload.manufacturer,
          model: payload.model,
          serviceLevel: payload.serviceLevel,
          serialNo: payload.serialNo,
          ups: payload.ups,
          qrRequested: payload.qrRequested,
        }, this.actor());
      }
      if (instrument.batchId !== payload.batchId) execution.setInstrumentBatch(instrumentId, payload.batchId, this.actor());
    });
    return { projectId };
  }

  /** 服务单仅后补/清空备注，不触碰身份字段、生命周期或工作量。 */
  private writeServiceOrderNoteUpdate(input: Extract<WorkbenchV2MutationRequest, { op: 'service_order_note_update' }>): { projectId?: string } {
    let projectId: string | undefined;
    this.transaction(() => {
      const payload = this.recordEditingPayload(input.payload, ['orderId', 'note']) as unknown as typeof input.payload;
      if (typeof payload.orderId !== 'string' || (payload.note !== null && typeof payload.note !== 'string')) {
        throw new ValidationError('V2_MUTATION_PAYLOAD_INVALID', '服务单备注编辑字段格式不正确');
      }
      const order = new ServiceOrderService(this.orders, this.projects).updateNote(payload.orderId, payload.note, this.actor());
      projectId = order.projectId ?? undefined;
    });
    return projectId ? { projectId } : {};
  }

  /** 服务单工程师补录：工程师可空，允许后续补录或清空（v20）。 */
  private writeServiceOrderEngineerUpdate(input: Extract<WorkbenchV2MutationRequest, { op: 'service_order_engineer_update' }>): { projectId?: string } {
    let projectId: string | undefined;
    this.transaction(() => {
      const payload = this.recordEditingPayload(input.payload, ['orderId', 'engineer']) as unknown as typeof input.payload;
      if (typeof payload.orderId !== 'string' || (payload.engineer !== null && typeof payload.engineer !== 'string')) {
        throw new ValidationError('V2_MUTATION_PAYLOAD_INVALID', '服务单工程师编辑字段格式不正确');
      }
      const order = new ServiceOrderService(this.orders, this.projects).updateEngineer(payload.orderId, payload.engineer, this.actor());
      projectId = order.projectId ?? undefined;
    });
    return projectId ? { projectId } : {};
  }

  /**
   * 损坏/维修事项更新（v2 damage_update）：复用 updateIssueStatus / setPartStatus /
   * updatePart 领域方法，不绕过领域校验（TBD-15：processing/repaired/closed_unrepaired
   * 与备件 used 均要求合同 USD 含税金额为正数；已关闭未修复必须记录关闭原因）。
   * 同一事务内原子落库。
   */
  private writeDamageUpdate(request: WorkbenchV2BaseMutationRequest): { projectId?: string } {
    let projectId: string | undefined;
    this.transaction(() => {
      const service = this.damageService();
      const actor = this.actor();
      const damageId = request.damageId;
      if (damageId === undefined || damageId === '') {
        throw new ValidationError('DAMAGE_ITEM_NOT_FOUND', '损坏/维修事项不存在: 缺少 damageId');
      }
      const item = this.damageItems.findById(damageId);
      if (!item) {
        throw new ValidationError('DAMAGE_ITEM_NOT_FOUND', `损坏/维修事项不存在: ${damageId}`);
      }
      projectId = item.projectId;
      if (request.issueStatus !== undefined) {
        service.updateIssueStatus(damageId, request.issueStatus as DamageItemStatus, request.closeReason ?? null, actor);
      }
      if (request.partStatus !== undefined) {
        service.setPartStatus(damageId, request.partStatus as PartStatus, actor);
      }
      if (
        request.partNumber !== undefined || request.partQuantity !== undefined ||
        request.partAmount !== undefined || request.partCurrency !== undefined ||
        request.partRequestedAt !== undefined || request.repairNote !== undefined
      ) {
        service.updatePart(damageId, {
          partNumber: request.partNumber,
          partQuantity: request.partQuantity,
          partAmountCents: request.partAmount === undefined ? undefined : parseAmountInput(request.partAmount),
          partCurrency: request.partCurrency as PartCurrency | undefined,
          partRequestedAt: request.partRequestedAt === undefined ? undefined : request.partRequestedAt === null ? null : (businessDate(request.partRequestedAt, '备件申请日期') ?? null),
          repairNote: request.repairNote,
        }, actor);
      }
    });
    return projectId ? { projectId } : {};
  }

  /** IPC 边界不信任 TypeScript：记录编辑只能携带契约明示字段。 */
  private assertRecordEditingRequestShape(request: unknown): void {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new ValidationError('V2_MUTATION_REQUEST_INVALID', '记录编辑请求必须是对象');
    }
    const extra = Object.keys(request).filter((key) => key !== 'op' && key !== 'payload');
    if (extra.length > 0) {
      throw new ValidationError('V2_MUTATION_FIELDS_FORBIDDEN', `记录编辑不允许字段: ${extra.join('、')}`);
    }
  }

  private recordEditingPayload(payload: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('V2_MUTATION_PAYLOAD_INVALID', '记录编辑请求 payload 必须是对象');
    }
    const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
    if (extra.length > 0) {
      throw new ValidationError('V2_MUTATION_FIELDS_FORBIDDEN', `记录编辑不允许字段: ${extra.join('、')}`);
    }
    return payload as Record<string, unknown>;
  }

  private writeSubmitAction(payload: WorkbenchActionPayload): { projectId?: string } {
    const v = payload.values; const actor = this.actor(); const projectId = payload.projectId ?? '';
    // 二维码申请与多选类型由外层 BEGIN IMMEDIATE 原子提交；仓储不自行管理事务。
    if (payload.type === 'qr_request') {
      this.transactionImmediate(() => {
        this.qrRequestService().createRequest({
          applicant: text(v.applicant),
          requestedAt: businessDate(v.requestedAt, '申请日期') ?? '',
          types: (Array.isArray(v.types) ? v.types : []) as QrRequestTypeCode[],
        }, actor);
      });
      return {};
    }
    this.transaction(() => {
      switch (payload.type) {
        case 'batch': {
          // 快速记录搬迁批次（全部字段可选）：同一事务原子创建批次；任一费用字段
          // 有值（非空串）时创建该批次唯一一笔（可部分）物流费用，全空时仅建批次。
          // 仅两个价格口径——budgetPrice=合同预算价 → batch.originalPriceCents + fee.budgetPriceCents；
          // dealPrice=物流成交价 → batch.discountedPriceCents + fee.dealPriceCents +
          // fee.logisticsCostCents（物流成交价即最终实际费用）。
          // 空金额不得转 0、空日期不得默认当天（undefined/null/空串 = 未填写）。
          const execution = this.executionService();
          const batch = execution.createBatch(projectId, actor);
          const quote: BatchQuoteInput = {};
          const feeInput: LogisticsFeeInput = {};
          const planTransportDate = businessDate(v.planTransportDate, '计划运输日期');
          if (planTransportDate !== undefined) {
            quote.planTransportDate = planTransportDate;
          }
          if (optional(v.transportCompany) !== undefined) {
            quote.transportCompany = optional(v.transportCompany) ?? null;
          }
          const budgetPriceRaw = optional(v.budgetPrice);
          if (budgetPriceRaw !== undefined) {
            const budgetPriceCents = parseAmountInput(budgetPriceRaw);
            if (budgetPriceCents <= 0n) {
              throw new ValidationError('LOGISTICS_BUDGET_PRICE_REQUIRED', '快速记录搬迁批次：合同预算价有值时必须大于 0');
            }
            quote.originalPriceCents = budgetPriceCents;
            feeInput.budgetPriceCents = budgetPriceCents;
          }
          const dealPriceRaw = optional(v.dealPrice);
          if (dealPriceRaw !== undefined) {
            const dealPriceCents = parseAmountInput(dealPriceRaw);
            if (dealPriceCents < 0n) {
              throw new ValidationError('LOGISTICS_DEAL_PRICE_REQUIRED', '快速记录搬迁批次：物流成交价有值时不得为负数');
            }
            quote.discountedPriceCents = dealPriceCents;
            // 人工录入始终 deal_price 与 logistics_cost 同步（物流成交价即最终实际费用）。
            feeInput.dealPriceCents = dealPriceCents;
            feeInput.logisticsCostCents = dealPriceCents;
          }
          const appliedAt = businessDate(v.appliedAt, '物流费用申请（登记）日期');
          if (appliedAt !== undefined) {
            feeInput.appliedAt = appliedAt;
          }
          if (Object.values(feeInput).some((value) => value !== undefined && value !== null)) {
            execution.recordLogisticsFee(batch.id, feeInput, actor);
          }
          execution.updateBatchQuote(batch.id, quote, actor);
          break;
        }
        case 'instrument': this.executionService().registerInstrument(projectId,{name:text(v.name),manufacturer:optional(v.manufacturer),model:optional(v.model),serviceLevel:optional(v.serviceLevel),serialNo:optional(v.serialNo),batchId:optional(v.batchId),ups:requiredBoolean(v.ups, 'UPS'),qrRequested:requiredBoolean(v.qrRequested, '二维码申请')},actor); break;
        case 'visit': { const e=text(v.engineers).split(/[、,，]/).filter(Boolean); const a=this.executionService().createActivity(projectId,businessDate(v.visitAt,'到访日期')??null,e,actor); const ids=Array.isArray(v.instrumentIds)?v.instrumentIds.map(String):[text(v.instrumentId)].filter(Boolean); const types=Array.isArray(v.workTypes)?v.workTypes as WorkType[]:[text(v.workType) as WorkType]; for(const id of ids) for(const type of types){this.executionService().startWorkFact(a.id,id,type,actor); if(v.status==='done')this.executionService().completeWorkFact(a.id,id,type,actor);} break; }
        case 'order': {
          // 合并服务单四字段后 UI 不再传 customerName：relocation/certification/
          // parts_by_mail/pm 四种类型都从当前项目关联客户派生客户单位。
          // 项目上下文中的四类开单均归档关联当前项目并显示在该项目 orders
          // section；非 relocation 的项目关联仅为归档/查询关系，不进入搬迁
          // 生命周期。无项目上下文时（projectId 为空）非搬迁开单独立保存，
          // relocation 仍由领域服务强制要求项目。
          const orderType = text(v.orderType) as 'relocation' | 'certification' | 'parts_by_mail' | 'pm';
          let orderCustomerName = text(v.customerName);
          const orderProject = projectId ? this.projects.findById(projectId) : undefined;
          const orderCustomer = orderProject?.customerId
            ? new SqliteCustomerRepository(this.db).findById(orderProject.customerId)
            : undefined;
          if (orderCustomer) {
            orderCustomerName = orderCustomer.name;
          }
          if (orderCustomerName === '') {
            throw new ValidationError('CUSTOMER_NAME_REQUIRED', '开单客户信息从项目客户读取失败，请先关联客户');
          }
          new ServiceOrderService(this.orders, this.projects).recordOrder({orderType,serviceOrderNo:text(v.serviceOrderNo),orderedAt:businessDate(v.orderedAt,'开单日期') ?? '',engineer:text(v.engineer) === '' ? null : text(v.engineer),customerName:orderCustomerName,projectId:projectId || null,note:optional(v.note)},actor); break;
        }
        case 'logistics': {
          // 记录物流费用（部分费用语义）：全部字段可选；空金额不得转 0、空日期不得
          // 默认当天；dealPrice 有值时与 logisticsCost 同步（物流成交价即最终实际费用）。
          const feeInput: LogisticsFeeInput = {};
          const appliedAt = businessDate(v.appliedAt, '物流费用申请（登记）日期');
          if (appliedAt !== undefined) {
            feeInput.appliedAt = appliedAt;
          }
          const budgetPriceRaw = optional(v.budgetPrice);
          if (budgetPriceRaw !== undefined) {
            const budgetPriceCents = parseAmountInput(budgetPriceRaw);
            if (budgetPriceCents <= 0n) {
              throw new ValidationError('LOGISTICS_BUDGET_PRICE_REQUIRED', '记录物流费用：合同预算价有值时必须大于 0');
            }
            feeInput.budgetPriceCents = budgetPriceCents;
          }
          const dealPriceRaw = optional(v.dealPrice);
          if (dealPriceRaw !== undefined) {
            const dealPriceCents = parseAmountInput(dealPriceRaw);
            if (dealPriceCents < 0n) {
              throw new ValidationError('LOGISTICS_DEAL_PRICE_REQUIRED', '记录物流费用：物流成交价有值时不得为负数');
            }
            feeInput.dealPriceCents = dealPriceCents;
            feeInput.logisticsCostCents = dealPriceCents;
          }
          if (!Object.values(feeInput).some((value) => value !== undefined && value !== null)) {
            throw new ValidationError('LOGISTICS_FEE_EMPTY', '记录物流费用：至少需要填写一项费用信息');
          }
          this.executionService().recordLogisticsFee(text(v.batchId), feeInput, actor);
          break;
        }
        case 'acceptance': this.projectService().markAcceptance(projectId,text(v.reportDate)); break;
        case 'invoice': this.financialService().recordInvoice(projectId,{invoicedAt:businessDate(v.invoicedAt,'掉票日期') ?? '',amountCents:parseAmountInput(v.amount)},actor); break;
        case 'ship_to': {
          const service=this.shipToService();
          const request=service.createRequest({customerName:text(v.customerName),newSiteAddress:text(v.newSiteAddress)},actor);
          const target=text(v.status) as ShipToRequestStatus;
          // 幂等组合推进（以持久化后的最新状态为准，不依赖本地陈旧对象）：
          // pending 才 submit；processing 只允许 complete（需 Account ID）；completed 只返回不回退。
          if(request.status==='pending_submit'&&target==='processing') service.submit(request.id,actor);
          if(request.status==='pending_submit'&&target==='completed'){ service.submit(request.id,actor); service.complete(request.id,text(v.accountId),actor); }
          if(request.status==='processing'&&target==='completed') service.complete(request.id,text(v.accountId),actor);
          break;
        }
        case 'damage': { const service=this.damageService(); const item=service.registerItem(text(v.instrumentId),{damageReason:optional(v.damageReason),partNumber:text(v.partNumber),partQuantity:Number(v.partQuantity),partAmountCents:parseAmountInput(v.partAmount),partCurrency:text(v.partCurrency) as PartCurrency,partRequestedAt:businessDate(v.partRequestedAt,'备件申请日期') ?? null,partStatus:text(v.partStatus) as PartStatus,repairNote:optional(v.repairNote),registeredAt:businessDate(v.registeredAt,'事项登记日期') ?? ''},actor); const status=text(v.issueStatus) as DamageItemStatus; if(status&&status!=='untreated')service.updateIssueStatus(item.id,status,optional(v.closeReason)??null,actor); if(v.partStatus==='used')service.setPartStatus(item.id,'used',actor); break; }
        case 'core': { const ps=this.projectService(); if(!this.contracts.findByProjectId(projectId)) ps.attachContract(projectId); this.financialService().setContractUsdTaxAmount(projectId,parseAmountInput(v.contractAmount)); ps.formalEntry(projectId,{ecc:text(v.ecc),entryAt:businessDate(v.entryAt,'进单日期') ?? '',finalConfirmableAmountCents:optional(v.finalAmount)?parseAmountInput(v.finalAmount):undefined}); break; }
        case 'serial_address': new SerialAddressUpdateService(this.serialUpdates,new SqliteInstrumentAddressReader(this.db)).register(optional(v.instrumentId),{customerName:text(v.customerName),newSiteAddress:text(v.newSiteAddress),serialNo:text(v.serialNo),accountId:text(v.accountId),updatedAt:businessDate(v.updatedAt,'更新日期') ?? ''},actor); break;
        case 'qr_request': break;
      }
    });
    return projectId ? { projectId } : {};
  }

  private writeSetReminder(projectId: string, at: string | null, note: string | null): void {
    this.reminderService().setReminder(projectId, { at: at ? businessDate(at, '提醒日期') ?? null : null, note }, this.actor());
  }

  private writeClearReminder(projectId: string): void {
    this.reminderService().clearReminder(projectId, this.actor());
  }

  private writeAdjustStatus(projectId: string, status: ProjectStatusOrCancelled): void {
    if (status === 'cancelled') {
      throw new ValidationError('CANCEL_VIA_COMMAND', '取消项目请使用 cancelProject 命令（须填写取消时间与原因）');
    }
    // 人工主状态调整：同一事务内先读 before，经 lifecycle 唯一入口落库，仅真实状态
    // 变化时追加一条 source=user 的状态转换审计；审计插入失败使项目状态更新整体回滚。
    this.transaction(() => {
      const before = this.projects.findById(projectId);
      if (!before) {
        throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
      }
      const result = this.projectService().adjustStatus(projectId, status);
      if (!result.ok) throw new Error(result.errors.join('；'));
      // 相同状态（含自动触发不推进）不写审计，避免重复。
      if (before.status === result.status) return;
      this.writeManualStatusAudit(projectId, before.status, result.status, result.reason);
    });
  }

  /** 人工主状态调整的真实转换审计（source=user；与项目状态更新同事务原子）。 */
  private writeManualStatusAudit(projectId: string, fromStatus: string, toStatus: string, reason: string): void {
    const actor = this.actor();
    this.db
      .prepare(
        `INSERT INTO project_status_transition_audit (
           id, project_id, from_status, to_status, reason,
           effective_business_date, source, actor_id, actor_username_snapshot, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        projectId,
        fromStatus,
        toStatus,
        reason,
        new SystemClock().today(),
        'user',
        actor.accountId,
        actor.username,
        new SystemClock().nowIso(),
      );
  }

  private writeCancelProject(projectId: string, time: string, reason: string): void {
    this.transaction(() => {
      this.projectService().cancelProject(projectId, { time: businessDate(time, '取消日期') ?? '', reason });
    });
  }

  private writeCompleteShipToRequest(requestId: string, accountId: string): ShipToRequestRecord {
    let request: ShipToRequestRecord | null = null;
    this.transaction(() => {
      request = this.shipToService().complete(requestId, accountId, this.actor());
    });
    return request!;
  }

  /**
   * 编辑搬迁批次（v2 batch_edit，同一事务内原子落库）：
   * - 计划运输日期/运输公司写批次（undefined=保持；null/空串=清空）；
   * - 合同预算价 → batch.originalPriceCents + fee.budgetPriceCents（undefined=保持；null=清空）；
   * - 物流成交价 → batch.discountedPriceCents + fee.dealPriceCents + fee.logisticsCostCents
   *   （物流成交价即最终实际费用；undefined=保持；null=清空）；
   * - appliedAt（费用登记日期）可补、改、清空（修改影响报表归属月份）；
   * - 费用 upsert seam：缺 fee 时按需创建部分费用（仅提交 null/undefined 时不虚构记录），
   *   已有 fee 时部分更新（undefined 字段保持现值）。
   */
  private writeEditBatch(edit: BatchEditPayload): { projectId: string; batchId: string } {
    let projectId = '';
    this.transaction(() => {
      const execution = this.executionService();
      const actor = this.actor();
      const batch = this.batches.findById(edit.batchId);
      if (!batch) {
        throw new ValidationError('BATCH_NOT_FOUND', `搬迁批次不存在: ${edit.batchId}`);
      }
      projectId = batch.projectId;
      const quote: BatchQuoteInput = {};
      const feeInput: LogisticsFeeInput = {};
      if (edit.planTransportDate !== undefined) {
        const raw = text(edit.planTransportDate);
        quote.planTransportDate = raw === '' ? null : raw;
      }
      if (edit.transportCompany !== undefined) {
        quote.transportCompany = edit.transportCompany === null ? null : text(edit.transportCompany);
      }
      if (edit.budgetPrice !== undefined) {
        // 空串视为缺失报错（不得静默当 0）；null = 清空；有值覆盖（> 0 由领域校验）。
        if (String(edit.budgetPrice).trim() === '') {
          throw new ValidationError('LOGISTICS_BUDGET_PRICE_REQUIRED', '编辑搬迁批次：合同预算价有值时必须大于 0');
        }
        const budgetPriceCents = edit.budgetPrice === null ? null : parseAmountInput(edit.budgetPrice);
        quote.originalPriceCents = budgetPriceCents;
        feeInput.budgetPriceCents = budgetPriceCents;
      }
      if (edit.dealPrice !== undefined) {
        if (String(edit.dealPrice).trim() === '') {
          throw new ValidationError('DEAL_PRICE_REQUIRED', '编辑搬迁批次：物流成交价有值时必须显式填写（允许为 0）');
        }
        const dealPriceCents = edit.dealPrice === null ? null : parseAmountInput(edit.dealPrice);
        quote.discountedPriceCents = dealPriceCents;
        // 人工录入始终 deal_price 与 logistics_cost 同步（null/0/具体值）。
        feeInput.dealPriceCents = dealPriceCents;
        feeInput.logisticsCostCents = dealPriceCents;
      }
      if (edit.appliedAt !== undefined) {
        const raw = text(edit.appliedAt);
        feeInput.appliedAt = raw === '' ? null : raw;
      }
      const hasFeeFields = edit.appliedAt !== undefined || edit.budgetPrice !== undefined || edit.dealPrice !== undefined;
      if (hasFeeFields) {
        const existing = this.fees.findByBatchId(batch.id);
        const hasFeeValue = Object.values(feeInput).some((value) => value !== undefined && value !== null);
        if (!existing) {
          // 缺 fee：仅当至少一个费用字段有实际值时才创建（部分费用），否则不虚构记录。
          if (hasFeeValue) {
            execution.recordLogisticsFee(batch.id, feeInput, actor);
          }
        } else {
          execution.updateLogisticsFee(existing.id, feeInput, actor);
        }
      }
      execution.updateBatchQuote(batch.id, quote, actor);
    });
    return { projectId, batchId: edit.batchId };
  }

  private writeEditInvoice(invoiceId: string, invoicedAt: string, amount: string): { invoiceId: string; projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const invoice = this.financialService().editInvoice(invoiceId, { invoicedAt: businessDate(invoicedAt, '掉票日期') ?? '', amountCents: parseAmountInput(amount) }, this.actor());
      projectId = invoice.projectId;
    });
    return { invoiceId, projectId };
  }

  private writeRevokeInvoice(invoiceId: string, revokedAt: string, reason: string): { invoiceId: string; projectId: string } {
    let projectId = '';
    this.transaction(() => {
      const invoice = this.financialService().revokeInvoice(invoiceId, { revokedAt: businessDate(revokedAt, '撤销日期') ?? '', revokeReason: reason }, this.actor());
      projectId = invoice.projectId;
    });
    return { invoiceId, projectId };
  }

  report(filter:ReportFilterDto):ReportModel { return new ReportingService(new SqliteReportingFactReader(this.db)).buildReport(filter); }
  reportDto(filter:ReportFilterDto):ReportDto { return serializeReport(this.report(filter)); }
  drillDown(metric:string,filter:ReportFilterDto):Array<Record<string,string|number|boolean|null>> { return serializeRows(new ReportingService(new SqliteReportingFactReader(this.db)).getMetricDetails(metric as ReportMetricKey,filter)); }

  private actor(){const s=this.session();return{accountId:s.accountId,username:s.username};}
  /**
   * 日期编辑/同次建档统一经 ProjectService 的 lifecycle 判定；仅 plan_visit_due 的真实
   * 转换在同一外层事务追加系统审计，因此 projects 更新、business revision 与审计同生共灭。
   */
  private updateExecutionPreparationWithDueAudit(projectId: string, input: Parameters<ProjectService['updateExecutionPreparation']>[1]): void {
    const before = this.projects.findById(projectId)!;
    this.projectService().updateExecutionPreparation(projectId, input);
    const after = this.projects.findById(projectId)!;
    if (before.status === after.status) return;
    const today = new SystemClock().today();
    if (after.planVisitAt === null || after.planVisitAt > today) return;
    this.db.prepare(
      `INSERT INTO project_status_transition_audit (
         id, project_id, from_status, to_status, reason,
         effective_business_date, source, created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), projectId, before.status, after.status, 'plan_visit_due', today, 'system', new SystemClock().nowIso());
  }
  private projectService(){return new ProjectService(this.projects,this.contracts,new SqliteInvoiceReadRepository(this.db));}
  private reminderService(){return new ReminderService(this.projects,new SqliteReminderSettingsRepository(this.db));}
  private executionService(){return new ExecutionService(this.batches,this.instruments,new SqliteBatchChangeHistoryRepository(this.db),this.activities,new SqliteActivityEngineerRepository(this.db),this.workFacts,this.fees,{onExecutionStarted:(id)=>{this.projectService().adjustStatus(id,'executing',{executionStarted:true});}});}
  private financialService(){return new FinancialClosureService(this.projects,this.contracts,this.invoices,{reevaluateStatus:(id)=>{this.projectService().adjustStatus(id,this.projects.findById(id)?.status??'pending_entry');}});}
  private shipToService(){return this.injected?.shipToService ?? new ShipToService(new SqliteShipToRepository(this.db),this.shipRequests,new SqliteShipToAddressReader(this.db));}
  private qrRequestService(){return this.injected?.qrRequestService ?? new QrRequestService(this.qrRequests);}
  private damageService(){return new DamageRepairService(this.damageItems,new SqliteActivityDamageLinkRepository(this.db),new SqliteDamageInstrumentReader(this.db),new SqliteRepairActivityReader(this.db),new SqliteContractAmountReader(this.db));}
  /** 受保护删除策略分发器（design D3）：类型分发 + tombstone/import marker 原子审计。 */
  private deletePolicies(): WorkbenchDeletePolicies {
    return new WorkbenchDeletePolicies({
      db: this.db,
      actor: () => this.actor(),
      parseBusinessDate: businessDate,
      repositories: {
        activities: this.activities,
        projects: this.projects,
        batches: this.batches,
        fees: this.fees,
        instruments: this.instruments,
        invoices: this.invoices,
      },
      projectService: () => this.projectService(),
      financialService: () => this.financialService(),
      serviceOrderService: () => new ServiceOrderService(this.orders, this.projects),
      damageRepairService: () => this.damageService(),
      serialAddressUpdateService: () => new SerialAddressUpdateService(this.serialUpdates, new SqliteInstrumentAddressReader(this.db)),
      qrRequestService: () => this.qrRequestService(),
      shipToService: () => this.shipToService(),
    });
  }
  private transaction(work:()=>void){this.db.exec('BEGIN');try{work();this.db.exec('COMMIT');}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
  /** BEGIN IMMEDIATE 事务（v2Delete 等防并发/TOCTOU 的写路径专用）。 */
  private transactionImmediate(work:()=>void){this.db.exec('BEGIN IMMEDIATE');try{work();this.db.exec('COMMIT');}catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}}
}

/**
 * ReportModel → IPC DTO 的显式序列化器：递归把所有 bigint 转换为十进制字符串，
 * 禁止依赖 structured clone 直接传 bigint、也不允许 Number(bigint) 精度退化；
 * 计数/百分比保持 number。导出仍消费领域 ReportModel（内部 BigInt），不受此序列化影响。
 */
function deepSerialize(value: unknown): unknown {
  if (typeof value === 'bigint') return formatCents(value);
  if (Array.isArray(value)) return value.map(deepSerialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepSerialize(v)]),
    );
  }
  return value;
}
function serializeRows(rows: unknown[]): Array<Record<string,string|number|boolean|null>> {
  return rows.map((row) => deepSerialize(row) as Record<string,string|number|boolean|null>);
}
function serializeShipToRequest(r:ShipToRequestRecord):ShipToRequestDto {
  return {id:r.id,customerName:r.customerName,newSiteAddress:r.newSiteAddress,accountId:r.accountId,status:r.status,submittedAt:r.submittedAt,completedAt:r.completedAt};
}
function serializeReport(report:ReportModel):ReportDto {
  const section=(key:string,label:string,rows:unknown[])=>({key,label,rows:serializeRows(rows)});
  return {range:report.range,filters:report.filters,generatedAt:report.generatedAt,sections:[section('project_pipeline','项目管道',report.pipeline),section('entry_amount_by_region','各区域新项目进单金额',report.entryAmountByRegion),section('monthly_invoice_amount','月度掉票',report.monthlyInvoices),section('monthly_service_order_count','月度开单量',report.monthlyServiceOrders),section('damage_repair_stats','损坏维修统计',report.damageSummary),section('monthly_logistics','月度物流费用',report.monthlyLogistics),section('ship_to_request_workload','Account ID 申请工作量',report.shipToWorkload),section('qr_request_workload','二维码申请工作量',report.qrWorkload),section('serial_address_update_count','序列号地址更新记录数',report.serialAddressUpdates)]};
}
