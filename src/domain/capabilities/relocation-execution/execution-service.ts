import { UniquenessError, ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import type {
  Batch,
  BatchQuoteInput,
  Instrument,
  InstrumentBulkInput,
  InstrumentProgress,
  LogisticsFee,
  LogisticsFeeInput,
  LogisticsFeeResult,
  RegisterInstrumentInput,
  WorkFact,
  WorkType,
} from './execution-types';
import { WORK_TYPES } from './execution-types';
import type {
  ActivityEngineerRepository,
  ActivityRepository,
  BatchChangeHistoryRepository,
  BatchRepository,
  InstrumentRepository,
  LogisticsFeeRepository,
  WorkFactRepository,
} from './execution-repositories';

/**
 * 搬迁执行领域服务（tasks 3.1~3.7）。
 *
 * 模块所有权：本模块（relocation-execution）拥有批次、仪器、上门活动/工作事实
 * 与物流记录的规则；主状态转换归 relocation-project-lifecycle 唯一拥有，本模块
 * 通过 ExecutionLifecycleGateway 提供事实并调用其校验入口（首次上门活动开始或
 * 首个搬迁批次开始运输 → 执行中，design D4 / tasks 2.2），不重复定义状态。
 *
 * 所有手工事实记录均要求当前登录账号归属（actor），并持久化账号内部 ID 与
 * 用户名快照（design D12）。
 */
export interface ExecutionLifecycleGateway {
  /**
   * 首次上门活动开始或首个搬迁批次开始运输的事实。
   * 实现方调用 relocation-project-lifecycle 的唯一状态校验入口
   * （ProjectService.adjustStatus(projectId, 'executing', { executionStarted: true })），
   * 拒绝结果（如未进单先执行标签）不影响执行侧事实记录。
   */
  onExecutionStarted(projectId: string): void;
}

export class ExecutionService {
  constructor(
    private readonly batches: BatchRepository,
    private readonly instruments: InstrumentRepository,
    private readonly batchChanges: BatchChangeHistoryRepository,
    private readonly activities: ActivityRepository,
    private readonly engineers: ActivityEngineerRepository,
    private readonly workFacts: WorkFactRepository,
    private readonly fees: LogisticsFeeRepository,
    private readonly lifecycle: ExecutionLifecycleGateway,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- 3.3/3.6 搬迁批次与报价 ----

  /** 新建搬迁批次（无报价、未开始运输）。 */
  createBatch(projectId: string, actor: ActorSnapshot): Batch {
    const now = this.now();
    const batch: Batch = {
      id: newInternalId(),
      projectId,
      planTransportDate: null,
      transportCompany: null,
      originalPriceCents: null,
      discountedPriceCents: null,
      startedAt: null,
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.batches.save(batch);
    return batch;
  }

  /**
   * 记录/更新批次报价：计划运输日期、运输公司与合同预算价/物流成交价
   * （物理字段仍为 originalPriceCents/discountedPriceCents，业务术语见 execution-types）。
   * 合同预算价有值必须 > 0；物流成交价允许 0（>= 0）；报价阶段不作为客户侧物流收入（仅记录）。
   */
  updateBatchQuote(batchId: string, input: BatchQuoteInput, actor: ActorSnapshot): Batch {
    const batch = this.requireBatch(batchId);
    if (input.planTransportDate !== undefined) {
      if (input.planTransportDate !== null) {
        assertValidBusinessDate(input.planTransportDate, '计划运输日期');
      }
      batch.planTransportDate = input.planTransportDate;
    }
    if (input.transportCompany !== undefined) {
      const company = input.transportCompany?.trim() ?? '';
      batch.transportCompany = company === '' ? null : company;
    }
    if (input.originalPriceCents !== undefined) {
      if (input.originalPriceCents !== null) {
        assertPositiveAmount(input.originalPriceCents, '合同预算价');
      }
      batch.originalPriceCents = input.originalPriceCents;
    }
    if (input.discountedPriceCents !== undefined) {
      if (input.discountedPriceCents !== null) {
        assertNonNegativeAmount(input.discountedPriceCents, '物流成交价');
      }
      batch.discountedPriceCents = input.discountedPriceCents;
    }
    batch.accountId = actor.accountId;
    batch.usernameSnapshot = actor.username;
    batch.updatedAt = this.now();
    this.batches.save(batch);
    return batch;
  }

  /**
   * 批次开始运输：要求至少一台归属仪器，且该批次涉及运输的全部仪器均为该批次
   * 归属仪器（运输集合 = 批次归属仪器集合）。开始运输后触发 lifecycle
   * 「首个搬迁批次开始运输 → 执行中」。
   */
  startBatchTransport(batchId: string, actor: ActorSnapshot): Batch {
    const batch = this.requireBatch(batchId);
    const owned = this.instruments.listByBatch(batchId);
    if (owned.length === 0) {
      throw new ValidationError(
        'BATCH_EMPTY',
        '空批次不能开始运输：该批次至少需要一台归属仪器',
      );
    }
    batch.startedAt = this.today();
    batch.accountId = actor.accountId;
    batch.usernameSnapshot = actor.username;
    batch.updatedAt = this.now();
    this.batches.save(batch);
    this.lifecycle.onExecutionStarted(batch.projectId);
    return batch;
  }

  // ---- 3.1/3.2 搬迁仪器 ----

  /**
   * 登记搬迁仪器：仪器名称必填、型号选填；非空序列号在同一合同/其唯一搬迁项目
   * 内唯一（跨合同可重复）；空序列号为占位仪器；"二维码是否申请"为手工是/否字段。
   */
  registerInstrument(
    projectId: string,
    input: RegisterInstrumentInput,
    actor: ActorSnapshot,
  ): Instrument {
    const name = assertRequiredText(input.name, '仪器名称');
    // 空序列号/空白序列号 = 占位仪器；非空序列号在同一项目内唯一。
    const rawSerial = input.serialNo === undefined || input.serialNo === null
      ? null
      : input.serialNo.trim();
    const serial = rawSerial === '' ? null : rawSerial;
    if (serial !== null) {
      const existing = this.instruments.findByProjectAndSerial(projectId, serial);
      if (existing) {
        throw new UniquenessError(
          'SERIAL_UNIQUE_IN_PROJECT',
          `序列号「${serial}」在该合同/搬迁项目内已存在，跨合同可重复`,
        );
      }
    }
    if (input.batchId !== undefined && input.batchId !== null) {
      this.assertBatchInProject(input.batchId, projectId);
    }
    const now = this.now();
    const instrument: Instrument = {
      id: newInternalId(),
      projectId,
      batchId: input.batchId ?? null,
      name,
      model: input.model?.trim() === '' ? null : (input.model?.trim() ?? null),
      manufacturer: input.manufacturer?.trim() === '' ? null : (input.manufacturer?.trim() ?? null),
      serviceLevel: input.serviceLevel?.trim() === '' ? null : (input.serviceLevel?.trim() ?? null),
      serialNo: serial,
      ups: input.ups ?? false,
      qrRequested: input.qrRequested ?? false,
      destinationShipToId: null,
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.instruments.save(instrument);
    return instrument;
  }

  /**
   * 批量登记仪器（.xlsx 5 列整批提交，append 语义）：同一事务内由调用方保证原子性，
   * 本方法先完成全部行校验再逐行落库——只有仪器名称必填，其余列去除首尾空白选填；
   * 非空序列号在 payload 内不得重复（给出重复行号），且在同一项目内不得与库内已有
   * 序列号重复（与 registerInstrument 同一唯一口径）。
   */
  bulkRegisterInstruments(
    projectId: string,
    rows: InstrumentBulkInput[],
    actor: ActorSnapshot,
  ): Instrument[] {
    if (rows.length === 0) {
      throw new ValidationError('BULK_EMPTY', '批量导入至少需要一行仪器数据');
    }
    // 1) 整批预校验：名称必填 + payload 内序列号去重（清晰行号错误，不落任何行）。
    const seenSerial = new Map<string, number>();
    const normalized: Array<{ name: string; serialNo: string | null; manufacturer: string | null; model: string | null; serviceLevel: string | null }> = [];
    rows.forEach((row, index) => {
      const line = index + 1;
      const name = assertRequiredText(row.name, `第 ${line} 行仪器名称`);
      const rawSerial = row.serialNo === undefined || row.serialNo === null ? null : row.serialNo.trim();
      const serial = rawSerial === '' ? null : rawSerial;
      if (serial !== null) {
        const first = seenSerial.get(serial);
        if (first !== undefined) {
          throw new ValidationError(
            'BULK_SERIAL_DUPLICATE_IN_PAYLOAD',
            `序列号「${serial}」在导入数据中重复（第 ${first} 行与第 ${line} 行），请修正后重新提交`,
          );
        }
        seenSerial.set(serial, line);
      }
      normalized.push({
        name,
        serialNo: serial,
        manufacturer: row.manufacturer?.trim() === '' ? null : (row.manufacturer?.trim() ?? null),
        model: row.model?.trim() === '' ? null : (row.model?.trim() ?? null),
        serviceLevel: row.serviceLevel?.trim() === '' ? null : (row.serviceLevel?.trim() ?? null),
      });
    });
    // 2) 库内唯一预校验：与 registerInstrument 同一口径（同一项目内非空序列号唯一）。
    for (const row of normalized) {
      if (row.serialNo === null) continue;
      const existing = this.instruments.findByProjectAndSerial(projectId, row.serialNo);
      if (existing) {
        throw new UniquenessError(
          'SERIAL_UNIQUE_IN_PROJECT',
          `序列号「${row.serialNo}」在该合同/搬迁项目内已存在，跨合同可重复`,
        );
      }
    }
    // 3) 逐行登记（调用方整体事务；本方法不做部分写入）。
    return normalized.map((row) =>
      this.registerInstrument(projectId, { ...row, ups: false, qrRequested: false }, actor),
    );
  }

  /**
   * 更新仪器非批次字段（厂商/型号/服务级别/序列号/UPS/"二维码是否申请"）。
   * "二维码是否申请"为负责人手工维护的是/否字段，不由二维码申请记录推导（4.10）。
   * 所属批次调整走 setInstrumentBatch（保留改批历史）。
   */
  updateInstrumentFields(
    instrumentId: string,
    input: { manufacturer?: string | null; model?: string | null; serviceLevel?: string | null; serialNo?: string | null; ups?: boolean; qrRequested?: boolean },
    actor: ActorSnapshot,
  ): Instrument {
    const instrument = this.requireInstrument(instrumentId);
    if (input.manufacturer !== undefined) {
      instrument.manufacturer = input.manufacturer?.trim() === '' ? null : (input.manufacturer?.trim() ?? null);
    }
    if (input.model !== undefined) {
      instrument.model = input.model?.trim() === '' ? null : (input.model?.trim() ?? null);
    }
    if (input.serviceLevel !== undefined) {
      instrument.serviceLevel = input.serviceLevel?.trim() === '' ? null : (input.serviceLevel?.trim() ?? null);
    }
    if (input.serialNo !== undefined) {
      const serial = input.serialNo?.trim() === '' ? null : (input.serialNo?.trim() ?? null);
      if (serial !== null) {
        const existing = this.instruments.findByProjectAndSerial(instrument.projectId, serial);
        if (existing && existing.id !== instrument.id) {
          throw new UniquenessError(
            'SERIAL_UNIQUE_IN_PROJECT',
            `序列号「${serial}」在该合同/搬迁项目内已存在，跨合同可重复`,
          );
        }
      }
      instrument.serialNo = serial;
    }
    if (input.ups !== undefined) {
      instrument.ups = input.ups;
    }
    if (input.qrRequested !== undefined) {
      instrument.qrRequested = input.qrRequested;
    }
    instrument.accountId = actor.accountId;
    instrument.usernameSnapshot = actor.username;
    instrument.updatedAt = this.now();
    this.instruments.save(instrument);
    return instrument;
  }

  /**
   * 批次归属调整（TBD-03）：运输开始前可无批次或改批；每次改批保存改批历史
   * （原批次、新批次、变更时间、当前登录账号归属）；运输开始后禁止直接改批。
   */
  setInstrumentBatch(instrumentId: string, newBatchId: string | null, actor: ActorSnapshot): Instrument {
    const instrument = this.requireInstrument(instrumentId);
    const fromBatchId = instrument.batchId;

    // 未改变所属批次时不产生伪改批历史，也不改写仪器审计字段。
    if (fromBatchId === newBatchId) return instrument;

    if (fromBatchId !== null) {
      const from = this.batches.findById(fromBatchId);
      if (from?.startedAt !== null && from?.startedAt !== undefined) {
        throw new ValidationError(
          'BATCH_STARTED_NO_REBATCH',
          '运输开始后禁止直接改批：仪器所属批次已开始运输',
        );
      }
    }
    if (newBatchId !== null) {
      this.assertBatchInProject(newBatchId, instrument.projectId);
      const target = this.batches.findById(newBatchId);
      if (target?.startedAt !== null && target?.startedAt !== undefined) {
        throw new ValidationError(
          'BATCH_STARTED_NO_JOIN',
          '目标批次已开始运输，禁止将仪器改入已开始运输的批次',
        );
      }
    }

    const now = this.now();
    this.batchChanges.save({
      id: newInternalId(),
      instrumentId,
      fromBatchId,
      toBatchId: newBatchId,
      changedAt: this.today(),
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
    });
    instrument.batchId = newBatchId;
    instrument.accountId = actor.accountId;
    instrument.usernameSnapshot = actor.username;
    instrument.updatedAt = now;
    this.instruments.save(instrument);
    return instrument;
  }

  // ---- 3.4 上门活动与工作事实 ----

  /**
   * 创建上门活动并记录参与工程师（同一活动可多名工程师）。
   * 创建活动本身仅属排期/工程师安排，不触发主状态流转。
   */
  createActivity(projectId: string, visitAt: BusinessDate | null, engineerNames: string[], actor: ActorSnapshot) {
    if (visitAt !== null) {
      assertValidBusinessDate(visitAt, '到访时间');
    }
    const engineers = engineerNames.map((name) => assertRequiredText(name, '参与工程师'));
    if (engineers.length === 0) {
      throw new ValidationError('ENGINEERS_REQUIRED', '上门活动至少需要一名参与工程师');
    }
    const now = this.now();
    const activity = {
      id: newInternalId(),
      projectId,
      visitAt,
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.activities.save(activity);
    for (const engineer of engineers) {
      this.engineers.saveEngineer({ id: newInternalId(), activityId: activity.id, engineer });
    }
    return activity;
  }

  /**
   * 开始一条工作事实（活动 × 仪器 × 工作类型粒度）：创建为进行中并记录开始时间。
   * 首次上门活动开始触发 lifecycle 「→ 执行中」。
   */
  startWorkFact(
    activityId: string,
    instrumentId: string,
    workType: WorkType,
    actor: ActorSnapshot,
  ): WorkFact {
    this.assertWorkType(workType);
    const activity = this.requireActivity(activityId);
    const instrument = this.requireInstrument(instrumentId);
    if (instrument.projectId !== activity.projectId) {
      throw new ValidationError(
        'INSTRUMENT_NOT_IN_ACTIVITY_PROJECT',
        '该仪器不属于此上门活动所在搬迁项目',
      );
    }
    const existing = this.workFacts.findByKey(activityId, instrumentId, workType);
    if (existing) {
      throw new ValidationError(
        'WORK_FACT_ALREADY_EXISTS',
        existing.status === 'done'
          ? '已完成的工作事实不可重新开始'
          : '该工作事实已在进行中，无需重复开始',
      );
    }
    const now = this.now();
    const fact: WorkFact = {
      id: newInternalId(),
      activityId,
      instrumentId,
      workType,
      status: 'in_progress',
      startedAt: this.today(),
      completedAt: null,
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.workFacts.save(fact);
    this.lifecycle.onExecutionStarted(activity.projectId);
    return fact;
  }

  /** 工作事实转为已完成：记录完成时间（仅进行中的事实可完成）。 */
  completeWorkFact(
    activityId: string,
    instrumentId: string,
    workType: WorkType,
    actor: ActorSnapshot,
  ): WorkFact {
    this.assertWorkType(workType);
    const fact = this.workFacts.findByKey(activityId, instrumentId, workType);
    if (!fact) {
      throw new ValidationError(
        'WORK_FACT_NOT_FOUND',
        '不存在对应工作事实（未开始），无法转为已完成',
      );
    }
    if (fact.status === 'done') {
      throw new ValidationError('WORK_FACT_ALREADY_DONE', '该工作事实已完成');
    }
    fact.status = 'done';
    fact.completedAt = this.today();
    fact.accountId = actor.accountId;
    fact.usernameSnapshot = actor.username;
    this.workFacts.save(fact);
    return fact;
  }

  // ---- 3.5 拆装进度推导 ----

  /**
   * 拆装进度推导（不可手工维护）：不存在对应工作事实=未开始；
   * 存在已完成事实=已完成；仅存在进行中事实=进行中。
   */
  getInstrumentProgress(instrumentId: string): InstrumentProgress {
    const facts = this.workFacts.listByInstrument(instrumentId);
    const byType = new Map(facts.map((f) => [f.workType, f]));
    const teardown = byType.get('teardown');
    const install = byType.get('install');
    return {
      teardown: teardown ? (teardown.status === 'done' ? 'done' : 'in_progress') : 'not_started',
      install: install ? (install.status === 'done' ? 'done' : 'in_progress') : 'not_started',
      teardownStartedAt: teardown?.startedAt ?? null,
      teardownCompletedAt: teardown?.completedAt ?? null,
      installStartedAt: install?.startedAt ?? null,
      installCompletedAt: install?.completedAt ?? null,
    };
  }

  // ---- 3.7 实际物流费用记录 ----

  /**
   * 登记物流费用（部分费用语义）：每批次仅一笔；appliedAt/三金额均可选。
   * - appliedAt：有值校验业务日期；不提交/空 = null（不默认当天）；
   * - budgetPriceCents：有值必须 > 0；dealPriceCents/logisticsCostCents：有值 >= 0（允许 0）；
   * - logisticsCostCents 旧列现行业务与物流成交价同值，仅历史兼容。
   * 全部字段为空时调用方不应创建费用记录（仅建批次）；任一字段有值即可创建部分费用。
   * 超预算警告仅当合同预算价与物流成交价两值均存在时判定。
   */
  recordLogisticsFee(batchId: string, input: LogisticsFeeInput, actor: ActorSnapshot): LogisticsFeeResult {
    this.requireBatch(batchId);
    if (this.fees.findByBatchId(batchId)) {
      throw new ValidationError('FEE_ALREADY_EXISTS', '该批次已登记一笔物流费用，每批次仅允许一笔');
    }
    const appliedAt = input.appliedAt === undefined ? null : input.appliedAt;
    if (appliedAt !== null) {
      assertValidBusinessDate(appliedAt, '物流费用申请（登记）时间');
    }
    assertOptionalAmount(input.budgetPriceCents, assertPositiveAmount, '合同预算价');
    assertOptionalAmount(input.dealPriceCents, assertNonNegativeAmount, '物流成交价');
    assertOptionalAmount(
      input.logisticsCostCents,
      assertNonNegativeAmount,
      '实际物流费用（历史兼容，现行业务与物流成交价同值）',
    );
    const now = this.now();
    const fee: LogisticsFee = {
      id: newInternalId(),
      batchId,
      appliedAt,
      budgetPriceCents: input.budgetPriceCents ?? null,
      dealPriceCents: input.dealPriceCents ?? null,
      logisticsCostCents: input.logisticsCostCents ?? null,
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.fees.save(fee);
    return { fee, warning: this.dealOverBudgetWarning(fee) };
  }

  /**
   * 修改物流费用（部分更新语义）：undefined = 保持现值；null = 清空；有值 = 覆盖。
   * appliedAt 可补、改、清空（修改会影响报表归属月份）；logisticsCostCents 旧列
   * 为历史兼容，现行业务与 dealPriceCents 同值。
   */
  updateLogisticsFee(feeId: string, input: LogisticsFeeInput, actor: ActorSnapshot): LogisticsFeeResult {
    const fee = this.requireFee(feeId);
    if (input.appliedAt !== undefined) {
      if (input.appliedAt !== null) {
        assertValidBusinessDate(input.appliedAt, '物流费用申请（登记）时间');
      }
      fee.appliedAt = input.appliedAt;
    }
    if (input.budgetPriceCents !== undefined) {
      if (input.budgetPriceCents !== null) {
        assertPositiveAmount(input.budgetPriceCents, '合同预算价');
      }
      fee.budgetPriceCents = input.budgetPriceCents;
    }
    if (input.dealPriceCents !== undefined) {
      if (input.dealPriceCents !== null) {
        assertNonNegativeAmount(input.dealPriceCents, '物流成交价');
      }
      fee.dealPriceCents = input.dealPriceCents;
    }
    if (input.logisticsCostCents !== undefined) {
      if (input.logisticsCostCents !== null) {
        assertNonNegativeAmount(input.logisticsCostCents, '实际物流费用（历史兼容，现行业务与物流成交价同值）');
      }
      fee.logisticsCostCents = input.logisticsCostCents;
    }
    fee.accountId = actor.accountId;
    fee.usernameSnapshot = actor.username;
    fee.updatedAt = this.now();
    this.fees.save(fee);
    return { fee, warning: this.dealOverBudgetWarning(fee) };
  }

  /**
   * @deprecated 历史兼容：现行业务「物流成交价即最终实际费用」，logisticsCostCents 与
   * dealPriceCents 恒同值，本差异恒为 0；仅对历史三口径数据保留计算，不破坏调用方。
   * 部分费用（金额为空）按 0 参与计算，仅在完整费用上有业务意义。
   */
  getLogisticsFeeDifference(fee: LogisticsFee): bigint {
    return (fee.dealPriceCents ?? 0n) - (fee.logisticsCostCents ?? 0n);
  }

  // ---- 内部辅助 ----

  private requireBatch(batchId: string): Batch {
    const batch = this.batches.findById(batchId);
    if (!batch) {
      throw new ValidationError('BATCH_NOT_FOUND', `搬迁批次不存在: ${batchId}`);
    }
    return batch;
  }

  private requireInstrument(instrumentId: string): Instrument {
    const instrument = this.instruments.findById(instrumentId);
    if (!instrument) {
      throw new ValidationError('INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${instrumentId}`);
    }
    return instrument;
  }

  private assertBatchInProject(batchId: string, projectId: string): void {
    const batch = this.batches.findById(batchId);
    if (!batch) {
      throw new ValidationError('BATCH_NOT_FOUND', `搬迁批次不存在: ${batchId}`);
    }
    if (batch.projectId !== projectId) {
      throw new ValidationError('BATCH_PROJECT_MISMATCH', '批次不属于该搬迁项目');
    }
  }

  private requireActivity(activityId: string) {
    const activity = this.activities.findById(activityId);
    if (!activity) {
      throw new ValidationError('ACTIVITY_NOT_FOUND', `上门活动不存在: ${activityId}`);
    }
    return activity;
  }

  private requireFee(feeId: string): LogisticsFee {
    const fee = this.fees.findById(feeId);
    if (!fee) {
      throw new ValidationError('FEE_NOT_FOUND', `物流费用记录不存在: ${feeId}`);
    }
    return fee;
  }

  private assertWorkType(workType: string): asserts workType is WorkType {
    if (!(WORK_TYPES as readonly string[]).includes(workType)) {
      throw new ValidationError('ILLEGAL_WORK_TYPE', `工作类型仅限 ${WORK_TYPES.join('、')}`);
    }
  }

  private dealOverBudgetWarning(fee: LogisticsFee): string | null {
    // 超预算警告仅当合同预算价与物流成交价两值均存在时判定（部分费用不提示）。
    if (fee.budgetPriceCents !== null && fee.dealPriceCents !== null && fee.dealPriceCents > fee.budgetPriceCents) {
      return '物流成交价大于合同预算价，已允许保存（不自动创建项目提醒）';
    }
    return null;
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}

function assertPositiveAmount(cents: bigint | null | undefined, fieldName: string): asserts cents is bigint {
  if (cents === null || cents === undefined || cents <= 0n) {
    throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', `${fieldName} 有值时必须大于 0`);
  }
}

/** 允许 0 的金额（物流成交价/实际费用口径）：拒绝负数。 */
function assertNonNegativeAmount(cents: bigint | null | undefined, fieldName: string): asserts cents is bigint {
  if (cents === null || cents === undefined || cents < 0n) {
    throw new ValidationError('AMOUNT_NON_NEGATIVE', `${fieldName} 不得为负数`);
  }
}

/**
 * 可选金额校验：undefined / null 直接通过（不提交或清空）；有值才执行规则校验
 * （部分费用语义：空金额不得转 0、有值必须满足约束）。
 */
function assertOptionalAmount(
  cents: bigint | null | undefined,
  rule: (cents: bigint | null | undefined, fieldName: string) => asserts cents is bigint,
  fieldName: string,
): void {
  if (cents === undefined || cents === null) return;
  rule(cents, fieldName);
}
