import { ValidationError } from '../../core/errors';
import type { BusinessDate } from '../../core/time';
import {
  ALL_STATUSES,
  CANCELLED_STATUS,
  isCancelled,
  isLegalStatus,
  isTerminal,
  TRANSFERRED_STATUS,
  type ProjectStatusOrCancelled,
} from './states';

/**
 * 集中状态校验入口（design D4 / tasks 1.8 / 2.2）。
 *
 * 本模块（relocation-project-lifecycle）是唯一拥有主状态转换/校验入口的模块。
 * 组织方式：人工选择 + 自动触发 + 约束校验。
 *
 * 自动触发（优先于人工选择）：
 * - 标记验收报告并填写报告形成日期 → 自动置为待掉票（不要求当前状态已待验收，
 *   只要有效验收报告事实即生效；已取消拒绝；维修中除外——维修中仅由人工离开）
 * - 录入实际装机完成时间 → 自动置为待验收（TBD-07）
 * - 计划上门日期到期自动推进（today >= planVisitAt，tasks 3.1 / design D5 转换表）：
 *   仅待进单/待执行 → 执行中；执行中幂等不写、待验收/待掉票不倒退、
 *   已完成/已取消终态不变；未到期不推进、逾期（漏跑）补推进；
 *   带"未进单先执行"标签的待进单项目到期同样自动进入执行中
 * - 待掉票/执行中/已完成之间按掉票事实自动重算（已确认语义：任意成功登记一笔掉票
 *   （累计有效 > 0）即视为闭环完成；执行中仅在有有效掉票时进入已完成，撤销最后
 *   有效掉票后回到待掉票；无 0 金额闭环：最终可确认金额为空或 0 时不产生闭环判定）
 *
 * 维修中（under_repair）：旁路主状态，仅由负责人人工选择进入/离开。
 * 不新增任何自动转换；既有自动触发（计划上门到期/实际装机完成/验收报告/
 * 金额闭环）均不把项目自动推进出维修中（验收报告触发显式排除维修中）。
 *
 * 终态（已取消 cancelled、已转单 transferred）：与取消类似，均为不可自动覆盖的
 * 终态；人工进入后不可再离开，任何自动触发与事实重算均不得将其改出终态。
 * 已转单（transferred）由负责人人工选择进入，转单后不再自动推进。
 *
 * 约束校验：
 * - 目标状态必须为合法状态之一
 * - 取消约束：存在任何掉票历史（含已撤销）禁止取消；已取消不可恢复
 * - 终态约束：已取消/已转单均不可再流转，事实重算不得覆盖
 * - 金额闭环约束：无 0 金额闭环；人工调整为「已完成」必须有闭环依据
 * - 未进单先执行标签存在时主状态保持待进单（TBD-08）：带标签的待进单项目
 *   不允许按已发生事实自动跳转或人工调整离开待进单（正式进单后标签清除，
 *   主状态由负责人人工确定；实际装机完成/验收/金额闭环等明确自动触发除外）
 */

export interface AmountClosureFacts {
  /** 累计有效掉票金额（分整数）。 */
  confirmedAmountCents: bigint;
  /** 最终可确认金额（分整数）；null = 未录入。 */
  finalConfirmableAmountCents: bigint | null;
}

export interface CancelFacts {
  /** 是否存在任何掉票历史（含已撤销掉票）。 */
  hasAnyInvoiceHistory: boolean;
}

export interface TransitionContext {
  currentStatus: ProjectStatusOrCancelled;
  requestedStatus: ProjectStatusOrCancelled;
  /** 实际装机完成日期（业务日期）；null = 未录入。 */
  actualInstallDoneAt: BusinessDate | null;
  /** 验收报告形成日期（业务日期）；null = 尚未验收。 */
  acceptanceReportDate: BusinessDate | null;
  /** 计划上门日期（业务日期）；null/未提供 = 未填写。 */
  planVisitAt?: BusinessDate | null;
  /** 当前业务日期；提供时才启用计划上门日期到期自动推进。 */
  today?: BusinessDate;
  amounts: AmountClosureFacts;
  cancel: CancelFacts;
  /** 未进单先执行标签是否生效（存在时主状态保持待进单，TBD-08）。 */
  preEntryExecution?: boolean;
  /** 首次上门活动开始或首个搬迁批次开始运输（仅完成排期/工程师/运输安排不计）。 */
  executionStarted?: boolean;
  /** 是否已正式进单（entryAt 已记录；删除事实后重算的基线推导用）。 */
  formallyEntered?: boolean;
}

export type TransitionReason =
  | 'manual'
  | 'execution_started'
  | 'plan_visit_due'
  | 'auto_install_done'
  | 'auto_acceptance'
  | 'auto_amount_closure'
  | 'cancel'
  | 'transfer'
  | 'unchanged';

export type TransitionResult =
  | { ok: true; status: ProjectStatusOrCancelled; reason: TransitionReason }
  | { ok: false; status: ProjectStatusOrCancelled; errors: string[] };

function ok(status: ProjectStatusOrCancelled, reason: TransitionReason): TransitionResult {
  return { ok: true, status, reason };
}

function reject(currentStatus: ProjectStatusOrCancelled, errors: string[]): TransitionResult {
  return { ok: false, status: currentStatus, errors };
}

/**
 * 金额闭环：final 有值且 > 0 时，任意成功登记一笔掉票（累计有效掉票 > 0）即进入
 * 已完成（已确认语义：不再等累计金额足额）；累计有效掉票归 0（撤销最后有效掉票）
 * 时回到待掉票。无 0 金额闭环：final 为空/0 时不产生任何闭环判定。
 */
function closureTarget(amounts: AmountClosureFacts): ProjectStatusOrCancelled | null {
  const final = amounts.finalConfirmableAmountCents;
  if (final === null || final <= 0n) {
    return null;
  }
  return amounts.confirmedAmountCents > 0n ? 'completed' : 'pending_invoice';
}

export function resolveStatus(context: TransitionContext): TransitionResult {
  const { currentStatus, requestedStatus } = context;

  // 终态（已取消/已转单）：不可恢复、不可继续流转（TBD-10）。
  // 已取消/已转单均不可自动覆盖，人工进入后不可再离开；事实重算不接受改出终态。
  if (isTerminal(currentStatus)) {
    return reject(
      currentStatus,
      isCancelled(currentStatus)
        ? ['已取消项目不可恢复；如需继续工作需重新新增项目']
        : ['已转单项目为终态，不可再离开或继续流转'],
    );
  }

  // 取消请求：必须通过取消约束（任何掉票历史含已撤销禁止取消）。
  if (requestedStatus === CANCELLED_STATUS) {
    if (context.cancel.hasAnyInvoiceHistory) {
      return reject(currentStatus, [
        '存在任何掉票历史（含已撤销掉票）的项目禁止取消',
      ]);
    }
    return ok(CANCELLED_STATUS, 'cancel');
  }

  // 转单请求：人工进入终态，转单后不再自动推进；不设取消的掉票历史约束。
  if (requestedStatus === TRANSFERRED_STATUS) {
    return ok(TRANSFERRED_STATUS, 'transfer');
  }

  // 自动触发：计划上门日期到期自动推进（tasks 3.1 / design D5 转换表）。
  // 候选：today >= planVisitAt（today 未提供或计划上门日期为空时不启用）。
  // 仅待进单/待执行 → 执行中；执行中幂等不写；待验收/待掉票不倒退；
  // 已完成/已取消终态不变；未到期不推进、逾期（漏跑）补推进。
  // 放在"未进单先执行保持待进单"标签规则之前：带标签的待进单项目到期同样
  // 自动进入执行中（spec：待进单属自动推进范围，不因标签规则停留待进单）。
  // 更强事实优先：存在验收报告或实际装机完成事实时不按到期推进，交由对应自动触发。
  if (isPlanVisitDue(context)) {
    if (
      (currentStatus === 'pending_entry' || currentStatus === 'pending_execution') &&
      context.acceptanceReportDate === null &&
      context.actualInstallDoneAt === null
    ) {
      return ok('executing', 'plan_visit_due');
    }
    // 其余状态行在到期检查下保持现状：执行中幂等不写（不产生真实转换）、
    // 待验收/待掉票不倒退、已完成终态不变；已取消已在终态检查处拒绝。
    // 同状态请求（自动推进检查的典型用法）由下方 unchanged 分支返回。
  }

  // 未进单先执行标签：带标签的待进单项目主状态保持待进单（TBD-08）。
  // 取消请求已在上方处理（此处 requestedStatus 必非已取消）；正式进单
  // （service 层清除标签后再重新校验）不受此约束。
  // 保持待进单的请求返回 unchanged（即使存在实际装机完成等自动触发事实，也先保持待进单，
  // 待正式进单后由负责人确定主状态或按明确自动触发流转）。
  if (context.preEntryExecution === true && currentStatus === 'pending_entry') {
    if (requestedStatus === 'pending_entry') {
      return ok('pending_entry', 'unchanged');
    }
    return reject(currentStatus, [
      '未进单先执行标签存在时主状态保持待进单；补齐核心信息完成正式进单后再由负责人确定主状态',
    ]);
  }

  // 自动触发 1：标记验收报告并填写报告形成日期 → 待掉票（不要求客户确认）。
  // 只要存在有效验收报告事实即自动置为待掉票，不要求当前状态已处于待验收
  // （已取消在上方拒绝；带未进单先执行标签的待进单项目由上方标签规则保持待进单；
  // 待掉票/已完成之间的金额闭环重算优先于本触发，TBD-11；
  // 维修中仅由人工离开，验收报告事实不自动推进出维修中）。
  if (
    context.acceptanceReportDate !== null &&
    currentStatus !== 'pending_invoice' &&
    currentStatus !== 'completed' &&
    currentStatus !== 'under_repair'
  ) {
    return ok('pending_invoice', 'auto_acceptance');
  }

  // 自动触发 2：实际装机完成时间 → 待验收（TBD-07），优先于人工选择。
  if (
    context.actualInstallDoneAt !== null &&
    (currentStatus === 'pending_entry' ||
      currentStatus === 'pending_execution' ||
      currentStatus === 'executing')
  ) {
    return ok('pending_acceptance', 'auto_install_done');
  }

  // 自动触发 3：待掉票/执行中/已完成之间按金额闭环自动重算（TBD-11），优先于人工值。
  // 执行中项目仅在有有效掉票时进入已完成，无掉票时不回退到待掉票。
  if (currentStatus === 'pending_invoice' || currentStatus === 'completed' || currentStatus === 'executing') {
    const target = closureTarget(context.amounts);
    if (target !== null) {
      if (currentStatus === 'executing') {
        if (target === 'completed') {
          return ok('completed', 'auto_amount_closure');
        }
      } else if (target !== currentStatus) {
        return ok(target, 'auto_amount_closure');
      }
    }
  }

  // 人工选择：校验合法状态与金额闭环约束。
  if (!isLegalStatus(requestedStatus)) {
    return reject(currentStatus, [
      `目标状态「${requestedStatus}」不是合法状态之一（${ALL_STATUSES.join('、')}）`,
    ]);
  }

  if (requestedStatus === 'completed') {
    const final = context.amounts.finalConfirmableAmountCents;
    if (final === null || final <= 0n) {
      return reject(currentStatus, [
        '无法直接调整为已完成：无 0 金额闭环，须先录入大于 0 的最终可确认金额',
      ]);
    }
    if (context.amounts.confirmedAmountCents <= 0n) {
      return reject(currentStatus, [
        '无法直接调整为已完成：尚无任何有效掉票，须先登记一笔大于 0 的掉票',
      ]);
    }
    return ok('completed', 'manual');
  }

  if (requestedStatus === currentStatus) {
    return ok(currentStatus, 'unchanged');
  }

  // 首次上门活动开始或首个搬迁批次开始运输 → 执行中（TBD-08 下为人工触发的
  // 合法流转，理由标注 execution_started；仅完成排期/工程师/运输公司安排不计）。
  // 维修中仅由人工选择离开：执行事实触发（execution_started）不自动推进出维修中。
  if (currentStatus === 'under_repair' && requestedStatus === 'executing' && context.executionStarted === true) {
    return ok('under_repair', 'unchanged');
  }
  if (requestedStatus === 'executing' && context.executionStarted === true) {
    return ok('executing', 'execution_started');
  }

  return ok(requestedStatus, 'manual');
}

/** 供各模块引用的校验辅助：目标状态是否为合法状态。 */
export function assertLegalStatus(status: string): asserts status is ProjectStatusOrCancelled {
  if (!isLegalStatus(status)) {
    throw new ValidationError('ILLEGAL_STATUS', `非法状态: ${status}`);
  }
}

/**
 * 计划上门日期是否已到期（today >= planVisitAt）。
 * today 未提供或计划上门日期为空时视为未启用（不触发到期自动推进），
 * 保证既有调用方在不提供 today 时行为不变。
 */
function isPlanVisitDue(context: TransitionContext): boolean {
  const { planVisitAt, today } = context;
  return (
    today !== undefined &&
    planVisitAt !== null &&
    planVisitAt !== undefined &&
    today >= planVisitAt
  );
}

/**
 * 删除执行/验收事实后的状态重算（Tasks 5.3）：经 lifecycle 唯一入口的显式重算。
 *
 * - 终态（已取消）与财务闭环完成态（completed）无法可靠反向重算 → 拒绝
 *   （调用方须在删除任何行前把该拒绝映射为 DELETE_REJECTED_STATUS_RECALC，
 *   绝不直接赋值状态）；
 * - 其余：由「剩余事实」推导确定性基线（remaining acceptance → actual install →
 *   未正式进单/已正式进单 → 已开始执行或 plan visit due → 执行中，否则待执行），
 *   再经 resolveStatus 前向引擎应用更强事实与自动触发（plan due 不倒退、
 *   金额闭环完成态保留 completed），结果即删除后的主状态；
 * - 真实状态变化由调用方决定落库与审计；本函数只决策、不写库。
 */
export function resolveStatusAfterFactDeletion(context: TransitionContext): TransitionResult {
  const { currentStatus } = context;

  // 终态：已取消/已转单不可恢复，删除事实后无可靠主状态可重算。
  if (isTerminal(currentStatus)) {
    return reject(
      currentStatus,
      isCancelled(currentStatus)
        ? ['已取消项目为终态，删除执行/验收事实后无法可靠重算主状态']
        : ['已转单项目为终态，删除执行/验收事实后无法可靠重算主状态'],
    );
  }
  // 财务闭环完成态：只能经掉票撤销路径回退，删除执行/验收事实的反向重算不可靠。
  if (currentStatus === 'completed') {
    return reject(currentStatus, ['项目已通过金额闭环进入已完成，删除执行/验收事实后无法可靠重算主状态']);
  }
  // 维修中仅由人工选择离开：删除执行/验收事实的重算不自动推进出维修中。
  if (currentStatus === 'under_repair') {
    return ok('under_repair', 'unchanged');
  }

  const baseline = deletionBaseline(context);
  // 以剩余事实基线为现状态/目标状态，经前向引擎应用更强事实与自动触发。
  return resolveStatus({ ...context, currentStatus: baseline, requestedStatus: baseline });
}

/**
 * 从剩余事实推导删除后的确定性基线（反向重算）：
 * - 金额闭环完成态（累计有效掉票 > 0 且最终可确认金额 > 0）保留 completed
 *   （关闭态只经掉票撤销路径回退，不因删除执行/验收事实回归）；
 * - 剩余验收报告事实 → 待掉票；剩余实际装机完成事实 → 待验收；
 * - 未正式进单（含未进单先执行标签）→ 待进单；
 * - 已正式进单：已开始执行 或 计划上门日期已到期 → 执行中（plan due 不倒退），
 *   否则待执行基线。
 */
function deletionBaseline(context: TransitionContext): ProjectStatusOrCancelled {
  const {
    acceptanceReportDate,
    actualInstallDoneAt,
    planVisitAt,
    today,
    executionStarted,
    formallyEntered,
  } = context;
  const final = context.amounts.finalConfirmableAmountCents;
  if (final !== null && final > 0n && context.amounts.confirmedAmountCents > 0n) {
    return 'completed';
  }
  if (acceptanceReportDate !== null) return 'pending_invoice';
  if (actualInstallDoneAt !== null) return 'pending_acceptance';
  if (!formallyEntered) return 'pending_entry';
  if (executionStarted) return 'executing';
  if (today !== undefined && planVisitAt !== null && planVisitAt !== undefined && today >= planVisitAt) {
    return 'executing';
  }
  return 'pending_execution';
}
