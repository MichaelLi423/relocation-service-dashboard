import { UniquenessError, ValidationError } from '../../core/errors';
import { assertRequiredText, normalizeBusinessId, parseProjectRegion } from '../../core/ids';
import {
  assertValidBusinessDate,
  assertValidDateOnly,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import { createPendingProject, isFormallyEntered, type Project } from './project';
import { createContract, type Contract } from './contract';
import { resolveStatus, resolveStatusAfterFactDeletion, type TransitionContext, type TransitionResult } from './lifecycle';
import { isTerminal, type ProjectStatusOrCancelled } from './states';

/**
 * 项目/合同服务（tasks 1.7 / 2.1~2.7）。
 *
 * 1.7 基础：新建待进单项目（内部 ID + 临时编号，不强制合同草稿，TBD-01）、
 * 补建合同（与项目 1:1）、ECC 唯一性校验。
 *
 * 2.x 正式进单与生命周期：
 * - 2.1 正式进单：校验合同/客户单位/搬迁范围齐备，缺任一拒绝；进单时间必填
 *   （默认当前、允许补录修正）；补充唯一 ECC；锁定进单金额快照；合同金额为 0
 *   或空时最终可确认金额必须另行录入 > 0（TBD-11）；进单后 ECC 纠错。
 * - 2.2 主状态人工调整（经 lifecycle 唯一入口校验）+ 未进单先执行标签。
 * - 2.3 执行准备（计划上门/运输时间、场地确认不触发状态流转）与实际装机完成自动待验收。
 * - 2.4 验收报告自动待掉票。
 * - 2.5 取消（约束 + 记录时间原因 + 终态不可恢复）。
 * - 2.6 项目基础字段与合同日期（截止不得早于开始）。
 * - 2.7 项目区域（trim 后精确分组）。
 */
export interface ProjectRepository {
  findById(id: string): Project | undefined;
  save(project: Project): void;
  /** 全部项目（供工作台项目提醒快速处理等只读消费方使用）。 */
  listAll(): Project[];
}

export interface ContractRepository {
  findByProjectId(projectId: string): Contract | undefined;
  findByEcc(ecc: string): Contract | undefined;
  save(contract: Contract): void;
}

/**
 * 掉票事实读取仓储（只读）。
 * 掉票记录的写入属 project-financial-closure（5.x）；本模块仅消费掉票事实
 * 用于取消约束与金额闭环校验（design D4：lifecycle 是状态校验唯一入口）。
 */
export interface InvoiceReadRepository {
  /** 累计有效（未撤销）掉票金额（分整数）。 */
  sumActiveAmounts(projectId: string): bigint;
  /** 是否存在任何掉票历史（含已撤销掉票）。 */
  hasAnyInvoiceHistory(projectId: string): boolean;
}

/** 正式进单输入（2.1）。 */
export interface FormalEntryInput {
  /** 唯一 ECC（正式进单必填，全局唯一）。 */
  ecc: string;
  /** 进单日期（业务日期）；缺省取当前日期，允许补录修正。 */
  entryAt?: BusinessDate;
  /**
   * 最终可确认金额（分）。缺省取合同 USD 含税金额；合同金额为空/0 时保持 null
   * （不要求另行录入）。有值时必须 > 0。
   */
  finalConfirmableAmountCents?: bigint | null;
}

/** 项目基础字段（2.6）：旧址/新址联系人、默认旧址/新址、合同起止日期。
 * 合同起止日期可空/可清除（补齐资料场景）：仅提交的字段生效，缺省保持现值；
 * 两者同时有值时必须校验截止不得早于开始。 */
export interface BasicInfoInput {
  oldSiteContact?: string | null;
  newSiteContact?: string | null;
  oldSiteAddress?: string | null;
  newSiteAddress?: string | null;
  /** 合同开始日期（可空/可清除；yyyy-mm-dd）。 */
  contractStartDate?: string | null;
  /** 合同截止日期（可空/可清除；yyyy-mm-dd，有值且开始有值时不得早于开始）。 */
  contractEndDate?: string | null;
}

/** 执行准备（2.3）：计划上门/运输日期与场地确认（均不触发状态流转）。 */
export interface ExecutionPreparationInput {
  planVisitAt?: BusinessDate | null;
  planTransportAt?: BusinessDate | null;
  siteConfirmed?: boolean;
}

/** 未进单先执行（2.2）：以「是否批复」boolean 事实为准，不再收集批复原因/缺失资料（0810）。 */
export interface PreEntryExecutionInput {
  /** 是否批复（可空；null = 未填写）。 */
  approved?: boolean | null;
}

/** 取消（2.5）：取消日期与原因。 */
export interface CancelInput {
  time: BusinessDate;
  reason: string;
}

/** 主状态调整的额外事实（2.2）。 */
export interface StatusAdjustFacts {
  /** 覆盖累计有效掉票金额（缺省读取掉票仓储或 0）。 */
  confirmedAmountCents?: bigint;
  /** 覆盖是否存在任何掉票历史（缺省读取掉票仓储或 false）。 */
  hasAnyInvoiceHistory?: boolean;
  /** 首次上门活动开始或首个搬迁批次开始运输（仅完成排期/工程师/运输安排不计）。 */
  executionStarted?: boolean;
  /**
   * 当前业务日期（Tasks 3.4）：提供时启用计划上门日期到期自动推进（lifecycle
   * 转换表），使人工提交的同时若项目已到期，自动触发优先于人工状态值。
   */
  today?: BusinessDate;
}

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly contracts: ContractRepository,
    private readonly invoices?: InvoiceReadRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- 1.7 基础 ----

  /** 新建待进单项目：分配内部 ID 与临时编号；合同可空、不创建合同草稿。 */
  createPendingProject(): Project {
    const project = createPendingProject();
    this.projects.save(project);
    return project;
  }

  /** 为项目建立合同（负责人决定补建；正式进单前必须补齐合同）。 */
  attachContract(projectId: string): Contract {
    const project = this.requireProject(projectId);
    const existing = this.contracts.findByProjectId(projectId);
    if (existing) {
      throw new UniquenessError(
        'CONTRACT_ALREADY_EXISTS',
        '项目已关联合同，合同与搬迁项目一一对应',
      );
    }
    const contract = createContract({ projectId });
    this.contracts.save(contract);
    project.contractId = contract.id;
    project.updatedAt = this.now();
    this.projects.save(project);
    return contract;
  }

  /** 校验 ECC 全局唯一（正式进单与进单后纠错共用）。 */
  assertEccUnique(ecc: string, exceptContractId?: string): void {
    const existing = this.contracts.findByEcc(ecc);
    if (existing && existing.id !== exceptContractId) {
      throw new UniquenessError('ECC_UNIQUE', `ECC「${ecc}」已存在，ECC 全局唯一`);
    }
  }

  // ---- 2.1 正式进单 ----

  /**
   * 正式进单：校验合同、客户单位齐备，任一缺失拒绝进单并就地提示；
   * 补充唯一 ECC；进单时间必填（缺省当前、允许补录修正）；锁定进单金额快照；
   * 最终可确认金额缺省取合同金额，合同金额为空/0 时保持 null（不再强制另行录入）；
   * 不再要求明确搬迁范围（scope）；进单后按明确自动触发重算主状态、
   * 无自动触发时基线为 pending_execution。
   */
  formalEntry(projectId: string, input: FormalEntryInput): Project {
    const project = this.requireProject(projectId);
    if (isFormallyEntered(project)) {
      throw new ValidationError('ALREADY_ENTERED', '项目已正式进单，不得重复进单');
    }
    const contract = this.contracts.findByProjectId(projectId);
    if (!contract) {
      throw new ValidationError('CONTRACT_REQUIRED', '正式进单前必须补齐合同');
    }
    if (!project.customerId) {
      throw new ValidationError('CUSTOMER_REQUIRED', '正式进单必须关联客户单位');
    }

    // ECC：必填 + 全局唯一（TBD-01/21）。
    const ecc = normalizeBusinessId(input.ecc);
    if (ecc === '') {
      throw new ValidationError('ECC_REQUIRED', '缺少 ECC，拒绝正式进单');
    }
    this.assertEccUnique(ecc, contract.id);

    // 进单时间：正式进单时必填，缺省取当前日期，允许补录或修正（保持填写值）。
    const entryAt = input.entryAt ?? this.today();
    assertValidBusinessDate(entryAt, '进单时间');

    // 最终可确认金额：缺省取合同金额；合同金额为空/0 时保持 null（不强制另行录入）。
    // 有值时必须 > 0。
    const contractAmount = contract.usdTaxAmountCents;
    let final: bigint | null;
    if (input.finalConfirmableAmountCents !== undefined && input.finalConfirmableAmountCents !== null) {
      if (input.finalConfirmableAmountCents <= 0n) {
        throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', '最终可确认金额有值时必须大于 0');
      }
      final = input.finalConfirmableAmountCents;
    } else if (contractAmount !== null && contractAmount > 0n) {
      final = contractAmount;
    } else {
      final = null;
    }

    project.entryAt = entryAt;
    project.preEntryExecution = false; // 未进单先执行在正式进单后解除
    project.updatedAt = this.now();

    contract.ecc = ecc;
    contract.eccLastModifiedAt = this.now();
    if (contract.entryAmountSnapshotCents === null && contractAmount !== null) {
      contract.entryAmountSnapshotCents = contractAmount; // 进单金额快照锁定（5.2）
    }
    contract.finalConfirmableAmountCents = final;
    contract.updatedAt = this.now();

    this.projects.save(project);
    this.contracts.save(contract);

    // 正式进单后按明确自动触发重新校验主状态（标签已清除，自动触发不再被拦截）；
    // 无自动触发时基线 pending_execution（进单即视为已进入执行准备阶段）。
    // Tasks 3.4 不倒退：仅仍在待进单（含带标签保持待进单）的项目参与重算；
    // 已在执行中或后续状态（到期/实际装机/验收/金额闭环自动推进的结果）的项目
    // 不得因进单回退，保持现状态。重算携带 today，使已到期的项目进单即自动进入执行中。
    if (project.status === 'pending_entry') {
      this.adjustStatus(projectId, 'pending_execution', { today: this.today() });
    }
    return this.requireProject(projectId);
  }

  /** 正式进单后 ECC 纠错：唯一性校验通过后保存新值并自动记录最后修改时间。 */
  updateEcc(projectId: string, newEcc: string): Contract {
    const project = this.requireProject(projectId);
    if (!isFormallyEntered(project)) {
      throw new ValidationError('NOT_ENTERED', '仅正式进单后的项目可更正 ECC');
    }
    const contract = this.contracts.findByProjectId(projectId);
    if (!contract) {
      throw new ValidationError('CONTRACT_REQUIRED', '项目未关联合同');
    }
    const ecc = normalizeBusinessId(newEcc);
    if (ecc === '') {
      throw new ValidationError('ECC_REQUIRED', 'ECC 必填');
    }
    this.assertEccUnique(ecc, contract.id);
    contract.ecc = ecc;
    contract.eccLastModifiedAt = this.now();
    contract.updatedAt = this.now();
    this.contracts.save(contract);
    return contract;
  }

  /** 进单日期补录或修正（保持填写值，不以当前日期覆盖）。 */
  setEntryAt(projectId: string, entryAt: BusinessDate): Project {
    const project = this.requireProject(projectId);
    assertValidBusinessDate(entryAt, '进单时间');
    project.entryAt = entryAt;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /** 关联客户（正式进单仅关联一个客户；待进单阶段客户可空）。 */
  linkCustomer(projectId: string, customerId: string): Project {
    const project = this.requireProject(projectId);
    project.customerId = customerId;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /** 标记搬迁范围明确（向导搬迁范围步骤至少一台仪器后调用；正式进单前必填）。 */
  confirmScope(projectId: string): Project {
    const project = this.requireProject(projectId);
    project.scopeConfirmed = true;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 2.2 主状态人工调整与未进单先执行 ----

  /**
   * 主状态人工调整：经 lifecycle 唯一校验入口校验（合法状态、取消约束、
   * 金额闭环与自动触发优先）；校验通过后落库。
   */
  adjustStatus(
    projectId: string,
    requestedStatus: ProjectStatusOrCancelled,
    facts?: StatusAdjustFacts,
  ): TransitionResult {
    const project = this.requireProject(projectId);
    const contract = project.contractId ? this.contracts.findByProjectId(projectId) : undefined;
    const invoice = this.invoiceFacts(projectId, facts);

    const context: TransitionContext = {
      currentStatus: project.status,
      requestedStatus,
      actualInstallDoneAt: project.actualInstallDoneAt,
      acceptanceReportDate: project.acceptanceReportDate,
      planVisitAt: project.planVisitAt,
      // 所有人工状态调整均以服务注入 clock 的当前业务日期参与 lifecycle 判定；
      // 调用方不能遗漏 today 而绕过计划上门到期自动推进。
      today: facts?.today ?? this.today(),
      preEntryExecution: project.preEntryExecution,
      executionStarted: facts?.executionStarted ?? false,
      amounts: {
        confirmedAmountCents: invoice.confirmedAmountCents,
        finalConfirmableAmountCents: contract?.finalConfirmableAmountCents ?? null,
      },
      cancel: { hasAnyInvoiceHistory: invoice.hasAnyInvoiceHistory },
    };

    const result = resolveStatus(context);
    if (result.ok && result.status !== project.status) {
      project.status = result.status;
      project.updatedAt = this.now();
      this.projects.save(project);
    }
    return result;
  }

  /**
   * 未进单先执行（2.2/TBD-08 / 0810）：以「是否批复」boolean 事实为准，
   * 不再收集批复原因/缺失资料（legacy 批复原因列仅保留历史可读，不写入）。
   * 主状态保持待进单。
   */
  setPreEntryExecution(projectId: string, input: PreEntryExecutionInput): Project {
    const project = this.requireProject(projectId);
    if (isFormallyEntered(project)) {
      throw new ValidationError('ALREADY_ENTERED', '已正式进单的项目不能再标记未进单先执行');
    }
    if (project.status !== 'pending_entry') {
      throw new ValidationError('LABEL_ONLY_PENDING', '未进单先执行标签仅可标记在待进单项目上');
    }
    project.preEntryExecution = true;
    project.managerApproved = input.approved ?? null;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 2.3 执行准备与待验收触发 ----

  /**
   * 更新执行准备：计划上门日期、计划运输日期、场地确认。
   * 写入后以注入时钟的当前业务日期经 lifecycle 重算，保证新建/编辑已到期
   * 的计划上门日期不会停留在待进单或待执行；状态绝不由本方法直接赋值。
   */
  updateExecutionPreparation(projectId: string, input: ExecutionPreparationInput): Project {
    const project = this.requireProject(projectId);
    if (input.planVisitAt !== undefined) {
      if (input.planVisitAt !== null) assertValidBusinessDate(input.planVisitAt, '计划上门日期');
      project.planVisitAt = input.planVisitAt;
    }
    if (input.planTransportAt !== undefined) {
      if (input.planTransportAt !== null) assertValidBusinessDate(input.planTransportAt, '计划运输日期');
      project.planTransportAt = input.planTransportAt;
    }
    if (input.siteConfirmed !== undefined) {
      project.siteConfirmed = input.siteConfirmed;
    }
    project.updatedAt = this.now();
    this.projects.save(project);
    this.adjustStatus(projectId, project.status);
    return this.requireProject(projectId);
  }

  /** 录入实际装机完成日期：lifecycle 自动置为待验收（TBD-07）。 */
  recordActualInstallDone(projectId: string, at: BusinessDate): Project {
    const project = this.requireProject(projectId);
    assertValidBusinessDate(at, '实际装机完成日期');
    project.actualInstallDoneAt = at;
    project.updatedAt = this.now();
    this.projects.save(project);
    this.adjustStatus(projectId, project.status);
    return this.requireProject(projectId);
  }

  // ---- 2.4 项目验收 ----

  /** 标记已有验收报告并填写报告形成日期 → lifecycle 自动置为待掉票（不要求客户确认）。 */
  markAcceptance(projectId: string, reportDate: string): Project {
    const project = this.requireProject(projectId);
    if (isTerminal(project.status)) {
      throw new ValidationError(
        project.status === 'cancelled' ? 'CANCELLED_PROJECT' : 'TRANSFERRED_PROJECT',
        project.status === 'cancelled' ? '已取消项目不可标记验收报告' : '已转单项目不可标记验收报告',
      );
    }
    assertValidDateOnly(reportDate, '验收报告形成日期');
    project.acceptanceReport = true;
    project.acceptanceReportDate = reportDate;
    project.updatedAt = this.now();
    this.projects.save(project);
    this.adjustStatus(projectId, project.status);
    return this.requireProject(projectId);
  }

  /**
   * 删除验收报告（受保护删除，2.4 反向操作 / Tasks 5.3）：
   * - 存在任何掉票历史（含已撤销）拒绝（掉票闭环事实不可逆回退）；
   * - 清空 acceptanceReport / acceptanceReportDate，并按「删除后剩余事实」经
   *   lifecycle 唯一入口 resolveStatusAfterFactDeletion 重算主状态（剩余验收/
   *   实际装机/执行事实/正式进单/plan visit due/金额闭环保留），绝不直接赋值状态；
   * - 重算不可靠（已取消/金额闭环完成态）→ 抛 ACCEPTANCE_STATUS_RECALC_FAILED，
   *   删除路径在删任何行前映射为 DELETE_REJECTED_STATUS_RECALC。
   */
  clearAcceptance(
    projectId: string,
    facts: { hasAnyInvoiceHistory: boolean; executionStarted: boolean },
  ): Project {
    const project = this.requireProject(projectId);
    if (isTerminal(project.status)) {
      throw new ValidationError(
        project.status === 'cancelled' ? 'CANCELLED_PROJECT' : 'TRANSFERRED_PROJECT',
        project.status === 'cancelled' ? '已取消项目不可删除验收报告' : '已转单项目不可删除验收报告',
      );
    }
    if (facts.hasAnyInvoiceHistory) {
      throw new ValidationError(
        'ACCEPTANCE_DELETE_REQUIRES_NO_INVOICE',
        '该项目存在掉票历史（含已撤销），验收报告不可删除；掉票闭环事实不可逆回退',
      );
    }
    // 先按「删除验收报告后」的剩余事实重算（经 lifecycle 唯一入口，不落库只决策）；
    // 重算不可靠 → 抛 ACCEPTANCE_STATUS_RECALC_FAILED，调用方映射为 STATUS_RECALC。
    const result = this.recomputeStatusAfterFactDeletion(projectId, {
      executionStarted: facts.executionStarted,
      acceptanceCleared: true,
    });
    if (!result.ok) {
      throw new ValidationError(
        'ACCEPTANCE_STATUS_RECALC_FAILED',
        `验收报告删除后状态重算失败：${result.errors.join('；')}`,
      );
    }
    // 重算通过后清空验收事实。重新读取已应用重算结果的项目对象再落库，
    // 避免用重算前的陈旧对象（旧 status）覆盖重算已写入的状态。
    const updated = this.requireProject(projectId);
    updated.acceptanceReport = false;
    updated.acceptanceReportDate = null;
    updated.updatedAt = this.now();
    this.projects.save(updated);
    return this.requireProject(projectId);
  }

  /**
   * 删除事实后的状态重算（Tasks 5.3）：经 lifecycle 唯一入口
   * resolveStatusAfterFactDeletion 决策「删除后」主状态。
   *
   * - facts.acceptanceCleared：重算视验收报告事实为已删除（按剩余事实推导基线）；
   * - 以「删除后剩余事实」为基线并应用前向自动触发（plan due 不倒退、金额闭环保留）；
   * - 真实状态变化才落库（revision 经 v10 触发器自然递增）；零变化零写；拒绝零写。
   */
  recomputeStatusAfterFactDeletion(
    projectId: string,
    facts: { executionStarted: boolean; acceptanceCleared?: boolean; today?: BusinessDate },
  ): TransitionResult {
    const project = this.requireProject(projectId);
    const contract = project.contractId ? this.contracts.findByProjectId(projectId) : undefined;
    const invoice = this.invoiceFacts(projectId);
    const context: TransitionContext = {
      currentStatus: project.status,
      requestedStatus: project.status,
      actualInstallDoneAt: project.actualInstallDoneAt,
      acceptanceReportDate: facts.acceptanceCleared ? null : project.acceptanceReportDate,
      planVisitAt: project.planVisitAt,
      today: facts.today,
      preEntryExecution: project.preEntryExecution,
      executionStarted: facts.executionStarted,
      formallyEntered: isFormallyEntered(project),
      amounts: {
        confirmedAmountCents: invoice.confirmedAmountCents,
        finalConfirmableAmountCents: contract?.finalConfirmableAmountCents ?? null,
      },
      cancel: { hasAnyInvoiceHistory: invoice.hasAnyInvoiceHistory },
    };
    const result = resolveStatusAfterFactDeletion(context);
    if (result.ok && result.status !== project.status) {
      project.status = result.status;
      project.updatedAt = this.now();
      this.projects.save(project);
    }
    return result;
  }

  // ---- 2.5 取消 ----

  /** 取消：通过 lifecycle 取消约束校验（任何掉票历史含已撤销禁止），记录日期与原因。 */
  cancelProject(projectId: string, input: CancelInput, facts?: StatusAdjustFacts): Project {
    assertValidBusinessDate(input.time, '取消日期');
    const reason = assertRequiredText(input.reason, '取消原因');
    const result = this.adjustStatus(projectId, 'cancelled', facts);
    if (!result.ok) {
      throw new ValidationError('CANCEL_REJECTED', result.errors.join('；'));
    }
    const cancelled = this.requireProject(projectId);
    cancelled.cancelledAt = input.time;
    cancelled.cancelReason = reason;
    cancelled.updatedAt = this.now();
    this.projects.save(cancelled);
    return cancelled;
  }

  // ---- 2.6 项目基础字段与合同日期 ----

  /**
   * 更新基础字段与合同起止日期。
   * 合同起止日期可空/可清除（补齐资料语义）：仅提交的字段生效，缺省保持现值；
   * 两者同时有值时必须校验截止不得早于开始。
   */
  updateBasicInfo(projectId: string, input: BasicInfoInput): Project {
    const project = this.requireProject(projectId);
    const start =
      input.contractStartDate !== undefined
        ? input.contractStartDate === '' ? null : input.contractStartDate
        : project.contractStartDate;
    const end =
      input.contractEndDate !== undefined
        ? input.contractEndDate === '' ? null : input.contractEndDate
        : project.contractEndDate;
    // 先校验再落库：避免校验失败产生部分写入。
    if (start !== null) assertValidDateOnly(start, '合同开始日期');
    if (end !== null) assertValidDateOnly(end, '合同截止日期');
    if (start !== null && end !== null && end < start) {
      throw new ValidationError(
        'CONTRACT_DATE_ORDER',
        '合同截止日期不得早于合同开始日期',
      );
    }
    if (input.oldSiteContact !== undefined) {
      project.oldSiteContact = input.oldSiteContact?.trim() === '' ? null : (input.oldSiteContact?.trim() ?? null);
    }
    if (input.newSiteContact !== undefined) {
      project.newSiteContact = input.newSiteContact?.trim() === '' ? null : (input.newSiteContact?.trim() ?? null);
    }
    if (input.oldSiteAddress !== undefined) {
      project.oldSiteAddress = input.oldSiteAddress?.trim() === '' ? null : (input.oldSiteAddress?.trim() ?? null);
    }
    if (input.newSiteAddress !== undefined) {
      project.newSiteAddress = input.newSiteAddress?.trim() === '' ? null : (input.newSiteAddress?.trim() ?? null);
    }
    project.contractStartDate = start;
    project.contractEndDate = end;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /** 计划装机完成日期（独立字段）：仅计划展示，不触发生命周期流转。 */
  setPlannedInstallDoneAt(projectId: string, at: BusinessDate | null): Project {
    const project = this.requireProject(projectId);
    if (at !== null) {
      assertValidBusinessDate(at, '计划装机日期');
    }
    project.plannedInstallDoneAt = at;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 2.8 项目备注 / 暂存信息 / 是否批复（0810 现场反馈，design D1） ----

  /**
   * 设置项目备注（0810）：可空，建档后补充/修改不影响主状态。
   * 去除首尾空白；空串/纯空白/显式 null = 清空。
   */
  setProjectNote(projectId: string, note: string | null): Project {
    const project = this.requireProject(projectId);
    const trimmed = note?.trim() ?? '';
    project.projectNote = trimmed === '' ? null : trimmed;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /**
   * 维护暂存信息（0810 / relocation-execution）：暂存地址与是否暂存均为
   * 负责人手工维护的执行事实，不触发主状态流转、不影响建档或正式进单。
   * 三态语义：undefined = 未提交保持现值；null = 显式清空（是否暂存 null = 未填写）。
   */
  updateTemporaryStorage(
    projectId: string,
    input: { temporaryStorageAddress?: string | null; isTemporaryStorage?: boolean | null },
  ): Project {
    const project = this.requireProject(projectId);
    if (input.temporaryStorageAddress !== undefined) {
      const trimmed = input.temporaryStorageAddress?.trim() ?? '';
      project.temporaryStorageAddress = trimmed === '' ? null : trimmed;
    }
    if (input.isTemporaryStorage !== undefined) {
      project.isTemporaryStorage = input.isTemporaryStorage;
    }
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /** 维护「是否批复」（0810）：managerApproved 替代批复原因/缺失资料；标量保存不触发主状态。 */
  setManagerApproved(projectId: string, approved: boolean | null): Project {
    const project = this.requireProject(projectId);
    project.managerApproved = approved;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /**
   * 维护项目暂定仪器范围（v16）：暂定仪器名称/型号与是否配备 UPS 均为负责人
   * 手工维护的项目级标量事实，建档与编辑资料均可填写。
   * 三态语义与 updateTemporaryStorage 一致：undefined = 未提交保持现值；
   * null = 显式清空（是否 UPS null = 未填写）。
   * 仅更新项目标量：绝不创建/修改/删除任何 instruments 行，不触发主状态流转。
   */
  updateTemporaryInstrument(
    projectId: string,
    input: {
      temporaryInstrumentName?: string | null;
      temporaryInstrumentModel?: string | null;
      temporaryHasUps?: boolean | null;
    },
  ): Project {
    const project = this.requireProject(projectId);
    if (input.temporaryInstrumentName !== undefined) {
      const trimmed = input.temporaryInstrumentName?.trim() ?? '';
      project.temporaryInstrumentName = trimmed === '' ? null : trimmed;
    }
    if (input.temporaryInstrumentModel !== undefined) {
      const trimmed = input.temporaryInstrumentModel?.trim() ?? '';
      project.temporaryInstrumentModel = trimmed === '' ? null : trimmed;
    }
    if (input.temporaryHasUps !== undefined) {
      project.temporaryHasUps = input.temporaryHasUps;
    }
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 2.7 项目区域 ----

  /**
   * 设置区域（tasks 2.4 / TBD-12）：去除首尾空白后仅允许 East、South、West、
   * Central、North 五个固定取值，非枚举值拒绝保存并提示（绝不静默写入）；
   * 空串/纯空白 = 清空区域。存量 legacy 非枚举文本保留在既有数据中、
   * 由读取/报表归入「待调整」分组，本项目写边界不做猜测映射。
   */
  setRegion(projectId: string, region: string): Project {
    const project = this.requireProject(projectId);
    const trimmed = parseProjectRegion(region);
    project.region = trimmed === '' ? null : trimmed;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 3.1 暂定仪器数量 ----

  /**
   * 记录暂定仪器数量（TBD-02 / 6.5）：仅保存数量信息，不生成任何虚拟仪器记录、
   * 不改变既有逐台仪器事实、不触发主状态流转。
   * 取值校验遵循既有输入校验规则（不小于 0 的整数），本调整不引入新格式约束。
   */
  setTemporaryInstrumentCount(projectId: string, count: number): Project {
    const project = this.requireProject(projectId);
    if (!Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        'INVALID_TEMP_COUNT',
        '暂定仪器数量必须为不小于 0 的整数',
      );
    }
    project.temporaryInstrumentCount = count;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  /** 清空暂定仪器数量（「编辑项目资料」留空保存）：只更新标量，不建仪器/不改状态。 */
  clearTemporaryInstrumentCount(projectId: string): Project {
    const project = this.requireProject(projectId);
    project.temporaryInstrumentCount = null;
    project.updatedAt = this.now();
    this.projects.save(project);
    return project;
  }

  // ---- 内部辅助 ----

  private requireProject(projectId: string): Project {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    return project;
  }

  private invoiceFacts(
    projectId: string,
    facts?: StatusAdjustFacts,
  ): { confirmedAmountCents: bigint; hasAnyInvoiceHistory: boolean } {
    if (facts?.confirmedAmountCents !== undefined || facts?.hasAnyInvoiceHistory !== undefined) {
      return {
        confirmedAmountCents: facts.confirmedAmountCents ?? 0n,
        hasAnyInvoiceHistory: facts.hasAnyInvoiceHistory ?? false,
      };
    }
    if (this.invoices) {
      return {
        confirmedAmountCents: this.invoices.sumActiveAmounts(projectId),
        hasAnyInvoiceHistory: this.invoices.hasAnyInvoiceHistory(projectId),
      };
    }
    return { confirmedAmountCents: 0n, hasAnyInvoiceHistory: false };
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
