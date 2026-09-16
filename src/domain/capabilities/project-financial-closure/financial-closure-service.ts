import { ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import type { Contract, ContractRepository, Project, ProjectRepository } from '../relocation-project-lifecycle';
import { isTerminal } from '../relocation-project-lifecycle';
import {
  countActiveInvoices,
  hasAnyInvoiceHistory,
  isInvoiceRevoked,
  sumActiveInvoices,
  type InvoiceInput,
  type InvoiceRecord,
  type InvoiceRepository,
  type InvoiceRevokeInput,
} from './invoice';

/**
 * project-financial-closure 领域服务（tasks 5.1~5.9 / 5.11）。
 *
 * - 5.1 合同 USD 含税金额手工录入与直接覆盖：允许 0、负数拒绝、不保存变更历史、
 *   不要求原因（TBD-20）；与净值×税率计算值不一致时仅警告（expectedFromNetTaxCents）。
 * - 5.2/5.3 进单金额快照由正式进单（relocation-project-lifecycle 2.1）锁定，
 *   本服务覆盖合同金额时不改写快照、不同步最终可确认金额。
 * - 5.4 最终可确认金额：默认取合同金额（2.1 落实）、可调整；必须 > 0 且
 *   不得低于累计有效掉票；调整不影响原合同金额。
 * - 5.5~5.9 掉票：分次记录（金额 > 0、超额保护）；有效记录可直接覆盖编辑并
 *   自动记录最后修改时间；不可物理删除；撤销须记录时间与原因，撤销后为终态
 *   （禁止编辑/重复撤销/重新激活，更正需新增有效掉票）。
 * - 5.10 待掉票/已完成之间按累计金额与最终可确认金额经 lifecycle 唯一校验入口
 *   重算；其他状态金额修改不改变主状态。
 * - 5.11 已取消状态期间拒绝修改合同金额、最终可确认金额与掉票记录
 *   （已取消状态事实由 lifecycle 拥有，本服务引用而不重新定义）。
 *
 * 掉票记录为手工录入事实，绑定当前登录账号归属快照（design D12）。
 */
export interface FinancialStatusGateway {
  /** 经 lifecycle 唯一校验入口重算主状态（金额闭环自动触发，TBD-11）。 */
  reevaluateStatus(projectId: string): void;
}

/** 合同金额设置结果（5.1）：含净值×税率不一致时的警告，警告不阻塞保存。 */
export interface ContractAmountResult {
  contract: Contract;
  warning: string | null;
}

export class FinancialClosureService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly contracts: ContractRepository,
    private readonly invoices: InvoiceRepository,
    private readonly lifecycle: FinancialStatusGateway,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  // ---- 5.1 合同 USD 含税金额手工录入与直接覆盖 ----

  /**
   * 手工录入/直接覆盖合同 USD 含税金额。
   * - 允许 0（仅合同金额允许 0），负数拒绝；不保存正式合同变更对象/历史、不要求原因。
   * - expectedFromNetTaxCents 为调用方（录入表单/导入）按净值×税率计算的结果，
   *   不一致时仅警告并保存手工值，不自动覆盖。
   */
  setContractUsdTaxAmount(
    projectId: string,
    amountCents: bigint,
    options?: { expectedFromNetTaxCents?: bigint },
  ): ContractAmountResult {
    const project = this.requireProject(projectId);
    this.assertNotCancelled(project);
    if (amountCents < 0n) {
      throw new ValidationError('AMOUNT_NEGATIVE', '金额不得为负数');
    }
    const contract = this.requireContract(projectId);
    contract.usdTaxAmountCents = amountCents; // 直接覆盖，不保留变更历史
    contract.updatedAt = this.now();
    this.contracts.save(contract);

    let warning: string | null = null;
    if (options?.expectedFromNetTaxCents !== undefined && options.expectedFromNetTaxCents !== amountCents) {
      warning = '合同 USD 含税金额与按净值、税率计算的结果不一致，已按手工录入值保存（不自动覆盖）';
    }
    this.recomputeClosure(project);
    return { contract, warning };
  }

  // ---- 5.4 最终可确认金额 ----

  /**
   * 调整最终可确认金额：必须 > 0 且不得低于累计有效掉票金额；
   * 调整不影响原合同 USD 含税金额。
   */
  setFinalConfirmableAmount(projectId: string, amountCents: bigint): Contract {
    const project = this.requireProject(projectId);
    this.assertNotCancelled(project);
    if (amountCents <= 0n) {
      throw new ValidationError('AMOUNT_MUST_BE_POSITIVE', '最终可确认金额有值时必须大于 0');
    }
    const contract = this.requireContract(projectId);
    const activeSum = this.sumActiveAmounts(projectId);
    if (amountCents < activeSum) {
      throw new ValidationError(
        'FINAL_BELOW_CONFIRMED',
        `最终可确认金额不得低于累计有效掉票金额（当前累计 ${activeSum} 分）`,
      );
    }
    contract.finalConfirmableAmountCents = amountCents;
    contract.updatedAt = this.now();
    this.contracts.save(contract);
    this.recomputeClosure(project);
    return contract;
  }

  // ---- 5.5~5.9 掉票记录 ----

  /** 分次掉票：金额必须 > 0，累计不得超过最终可确认金额（超额保护）。 */
  recordInvoice(projectId: string, input: InvoiceInput, actor: ActorSnapshot): InvoiceRecord {
    const project = this.requireProject(projectId);
    this.assertNotCancelled(project);
    if (input.amountCents <= 0n) {
      throw new ValidationError('INVOICE_AMOUNT_POSITIVE', '掉票金额必须大于 0');
    }
    const contract = this.requireContract(projectId);
    const final = contract.finalConfirmableAmountCents;
    if (final === null) {
      throw new ValidationError('FINAL_AMOUNT_REQUIRED', '登记掉票前必须先确定大于 0 的最终可确认金额');
    }
    const activeSum = this.sumActiveAmounts(projectId);
    const newSum = activeSum + input.amountCents;
    if (newSum > final) {
      throw new ValidationError(
        'INVOICE_OVER_FINAL',
        `新增掉票后累计掉票金额 ${newSum} 分将超过最终可确认金额 ${final} 分；请先调整最终可确认金额再登记掉票`,
      );
    }
    const invoicedAt = input.invoicedAt ?? this.today();
    assertValidBusinessDate(invoicedAt, '掉票时间');
    const now = this.now();
    const invoice: InvoiceRecord = {
      id: newInternalId(),
      projectId,
      amountCents: input.amountCents,
      invoicedAt,
      revokedAt: null,
      revokeReason: null,
      lastModifiedAt: now,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
    };
    this.invoices.save(invoice);
    this.recomputeClosure(project);
    return invoice;
  }

  /**
   * 直接覆盖编辑有效掉票的金额与日期：不保留旧值与更正原因，自动记录最后修改时间；
   * 编辑后按累计金额与最终可确认金额重算统计与状态。已撤销掉票禁止编辑。
   */
  editInvoice(invoiceId: string, input: InvoiceInput, actor: ActorSnapshot): InvoiceRecord {
    const invoice = this.requireInvoice(invoiceId);
    this.assertNotCancelled(this.requireProject(invoice.projectId));
    if (isInvoiceRevoked(invoice)) {
      throw new ValidationError(
        'REVOKED_INVOICE_IMMUTABLE',
        '已撤销掉票为终态，禁止编辑；更正需新增有效掉票',
      );
    }
    if (input.amountCents <= 0n) {
      throw new ValidationError('INVOICE_AMOUNT_POSITIVE', '掉票金额必须大于 0');
    }
    const contract = this.requireContract(invoice.projectId);
    const final = contract.finalConfirmableAmountCents;
    if (final === null) {
      throw new ValidationError('FINAL_AMOUNT_REQUIRED', '登记掉票前必须先确定大于 0 的最终可确认金额');
    }
    const otherActive = this.sumActiveAmounts(invoice.projectId) - invoice.amountCents;
    if (otherActive + input.amountCents > final) {
      throw new ValidationError(
        'INVOICE_OVER_FINAL',
        '编辑后累计掉票金额将超过最终可确认金额；请先调整最终可确认金额',
      );
    }
    const invoicedAt = input.invoicedAt ?? invoice.invoicedAt;
    assertValidBusinessDate(invoicedAt, '掉票时间');
    invoice.amountCents = input.amountCents;
    invoice.invoicedAt = invoicedAt;
    invoice.lastModifiedAt = this.now();
    invoice.operatorAccountId = actor.accountId;
    invoice.operatorUsername = actor.username;
    this.invoices.save(invoice);
    this.recomputeClosure(this.requireProject(invoice.projectId));
    return invoice;
  }

  /**
   * 撤销掉票：须记录撤销时间与原因；撤销后为终态（禁止编辑、重复撤销或重新激活，
   * 更正需新增有效掉票），撤销后不计入金额与次数并重算统计与状态。
   */
  revokeInvoice(invoiceId: string, input: InvoiceRevokeInput, actor: ActorSnapshot): InvoiceRecord {
    const invoice = this.requireInvoice(invoiceId);
    this.assertNotCancelled(this.requireProject(invoice.projectId));
    if (isInvoiceRevoked(invoice)) {
      throw new ValidationError(
        'REVOKED_INVOICE_TERMINAL',
        '已撤销掉票为终态，禁止重复撤销；更正需新增有效掉票',
      );
    }
    assertValidBusinessDate(input.revokedAt, '撤销时间');
    const reason = assertRequiredText(input.revokeReason, '撤销原因');
    invoice.revokedAt = input.revokedAt;
    invoice.revokeReason = reason;
    invoice.lastModifiedAt = this.now();
    invoice.operatorAccountId = actor.accountId;
    invoice.operatorUsername = actor.username;
    this.invoices.save(invoice);
    this.recomputeClosure(this.requireProject(invoice.projectId));
    return invoice;
  }

  // ---- 只读统计（供 reporting 消费） ----

  listInvoices(projectId: string): InvoiceRecord[] {
    return this.invoices.listByProject(projectId);
  }

  /** 累计有效掉票金额（已撤销不计）。 */
  sumActiveAmounts(projectId: string): bigint {
    return sumActiveInvoices(this.invoices.listByProject(projectId));
  }

  /** 有效掉票次数（已撤销不计）。 */
  countActiveInvoices(projectId: string): number {
    return countActiveInvoices(this.invoices.listByProject(projectId));
  }

  /** 是否存在任何掉票历史（含已撤销掉票；供取消约束口径引用）。 */
  hasAnyInvoiceHistory(projectId: string): boolean {
    return hasAnyInvoiceHistory(this.invoices.listByProject(projectId));
  }

  // ---- 内部辅助 ----

  private recomputeClosure(project: Project): void {
    // 待掉票/执行中/已完成之间按金额闭环重算；其他状态金额修改不改变主状态（5.10 / 回归：执行中掉票自动已完成）。
    if (project.status === 'pending_invoice' || project.status === 'executing' || project.status === 'completed') {
      this.lifecycle.reevaluateStatus(project.id);
    }
  }

  private requireProject(projectId: string): Project {
    const project = this.projects.findById(projectId);
    if (!project) {
      throw new ValidationError('PROJECT_NOT_FOUND', `搬迁项目不存在: ${projectId}`);
    }
    return project;
  }

  private requireContract(projectId: string): Contract {
    const contract = this.contracts.findByProjectId(projectId);
    if (!contract) {
      throw new ValidationError('CONTRACT_REQUIRED', `项目未关联合同: ${projectId}`);
    }
    return contract;
  }

  private requireInvoice(invoiceId: string): InvoiceRecord {
    const invoice = this.invoices.findById(invoiceId);
    if (!invoice) {
      throw new ValidationError('INVOICE_NOT_FOUND', `掉票记录不存在: ${invoiceId}`);
    }
    return invoice;
  }

  /**
   * 终态（已取消/已转单）期间禁止金额与掉票修改（5.11，状态事实由 lifecycle 拥有）。
   * 已转单与已取消同等冻结：终态项目不再参与后续财务修改。
   */
  private assertNotCancelled(project: Project): void {
    if (!isTerminal(project.status)) return;
    if (project.status === 'cancelled') {
      throw new ValidationError(
        'CANCELLED_FINANCIAL_FROZEN',
        '已取消项目禁止修改合同金额、最终可确认金额与掉票记录',
      );
    }
    throw new ValidationError(
      'TRANSFERRED_FINANCIAL_FROZEN',
      '已转单项目禁止修改合同金额、最终可确认金额与掉票记录',
    );
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
