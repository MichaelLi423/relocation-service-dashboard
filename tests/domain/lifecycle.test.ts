import { describe, expect, it } from 'vitest';
import {
  resolveStatus,
  resolveStatusAfterFactDeletion,
  type TransitionContext,
} from '../../src/domain/capabilities/relocation-project-lifecycle/lifecycle';
import type { ProjectStatusOrCancelled } from '../../src/domain/capabilities/relocation-project-lifecycle/states';
import { isLegalStatus } from '../../src/domain/capabilities/relocation-project-lifecycle/states';
import { expectReason, expectRejected, expectStatus } from '../helpers/state-assert';

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    currentStatus: 'pending_execution',
    requestedStatus: 'executing',
    actualInstallDoneAt: null,
    acceptanceReportDate: null,
    amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: null },
    cancel: { hasAnyInvoiceHistory: false },
    ...overrides,
  };
}

describe('集中状态校验入口（tasks 1.8 / 2.2 / D4）', () => {
  it('负责人人工调整主状态：待执行 → 执行中 校验通过', () => {
    const result = resolveStatus(ctx());
    expectStatus(result, 'executing');
    expectReason(result, 'manual');
  });

  it('非法状态调整被拒：待执行 → 已完成（无任何掉票闭环依据）', () => {
    const result = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'completed' }),
    );
    expectRejected(result, '已完成');
  });

  it('人工调整为已完成需有闭环依据（累计掉票达到最终可确认金额且金额 > 0）', () => {
    const withClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 1000000n, finalConfirmableAmountCents: 1000000n },
      }),
    );
    expectStatus(withClosure, 'completed');

    const zeroClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: 0n },
      }),
    );
    expectRejected(zeroClosure, '0 金额闭环');
  });

  it('自动触发 1：实际装机完成时间自动置为待验收，且优先于人工选择', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing', // 负责人同时提交人工值
        actualInstallDoneAt: '2026-07-20',
      }),
    );
    expectStatus(result, 'pending_acceptance');
    expectReason(result, 'auto_install_done');
  });

  it('自动触发 2：标记验收报告并填写报告形成日期自动置为待掉票（不要求客户确认）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_acceptance',
        requestedStatus: 'pending_acceptance',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('自动触发 2（Oracle 修复）：验收报告事实不要求当前状态已待验收（执行中直接待掉票）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing', // 负责人同时提交人工值
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('自动触发 2 优先于实际装机完成：验收报告事实存在时跳过待验收直接待掉票', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing',
        actualInstallDoneAt: '2026-07-20',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('金额闭环区间内（待掉票/已完成）不因验收事实回退，闭环重算优先', () => {
    // 已完成项目再次标记验收报告 → 保持已完成（金额闭环优先，不退回待掉票）
    const staysCompleted = resolveStatus(
      ctx({
        currentStatus: 'completed',
        requestedStatus: 'completed',
        acceptanceReportDate: '2026-07-25',
        amounts: { confirmedAmountCents: 800000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(staysCompleted, 'completed');

    // 待掉票项目有验收事实且金额已达闭环 → 自动进入已完成（金额闭环优先于验收触发）
    const closed = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        acceptanceReportDate: '2026-07-25',
        amounts: { confirmedAmountCents: 800000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(closed, 'completed');
    expectReason(closed, 'auto_amount_closure');
  });

  it('已取消项目即使存在验收报告事实也拒绝流转（终态不可恢复）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'cancelled',
        requestedStatus: 'cancelled',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectRejected(result, '不可恢复');
  });

  it('已转单为终态：不可再离开、禁止继续流转', () => {
    const toTransferred = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'transferred' }),
    );
    expectStatus(toTransferred, 'transferred');
    expectReason(toTransferred, 'transfer');

    const leave = resolveStatus(
      ctx({ currentStatus: 'transferred', requestedStatus: 'executing' }),
    );
    expectRejected(leave, '已转单项目为终态');
  });

  it('已转单为终态：自动触发（计划上门到期/验收/装机/金额闭环）不覆盖终态', () => {
    const due = resolveStatus(
      ctx({
        currentStatus: 'transferred',
        requestedStatus: 'transferred',
        planVisitAt: '2026-07-01',
        today: '2026-07-10',
      }),
    );
    expectRejected(due, '已转单项目为终态');

    const acceptance = resolveStatus(
      ctx({
        currentStatus: 'transferred',
        requestedStatus: 'transferred',
        acceptanceReportDate: '2026-07-25',
        actualInstallDoneAt: '2026-07-20',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectRejected(acceptance, '已转单项目为终态');
  });

  it('自动触发 3：金额闭环在待掉票/已完成之间自动重算（优先于人工值）', () => {
    // 已确认语义：任意成功登记一笔掉票（累计有效 > 0）即进入已完成，不再等累计金额足额。
    const toCompleted = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(toCompleted, 'completed');
    expectReason(toCompleted, 'auto_amount_closure');

    // 撤销最后有效掉票后累计归 0 → 回到待掉票。
    const backToPending = resolveStatus(
      ctx({
        currentStatus: 'completed',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(backToPending, 'pending_invoice');
    expectReason(backToPending, 'auto_amount_closure');

    // 无 0 金额闭环：final 为空/0 时不产生闭环判定。
    const noClosure = resolveStatus(
      ctx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        amounts: { confirmedAmountCents: 500000n, finalConfirmableAmountCents: 0n },
      }),
    );
    expectStatus(noClosure, 'pending_invoice');
    expectReason(noClosure, 'unchanged');
  });

  it('金额闭环自动触发延伸至执行中：执行中项目存在有效掉票时进入已完成', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(result, 'completed');
    expectReason(result, 'auto_amount_closure');
  });

  it('执行中项目无有效掉票时不因金额闭环回退到待掉票', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'executing',
        amounts: { confirmedAmountCents: 0n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'unchanged');
  });

  it('非待掉票/已完成/执行中状态金额修改不改变主状态', () => {
    const pendingExecution = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_execution',
        amounts: { confirmedAmountCents: 500000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(pendingExecution, 'pending_execution');
    expectReason(pendingExecution, 'unchanged');

    const underRepair = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'under_repair',
        amounts: { confirmedAmountCents: 500000n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(underRepair, 'under_repair');
    expectReason(underRepair, 'unchanged');
  });

  it('取消约束：存在任何掉票历史（含已撤销）禁止取消', () => {
    const rejected = resolveStatus(
      ctx({
        currentStatus: 'executing',
        requestedStatus: 'cancelled',
        cancel: { hasAnyInvoiceHistory: true },
      }),
    );
    expectRejected(rejected, '掉票历史');

    const allowed = resolveStatus(
      ctx({ currentStatus: 'executing', requestedStatus: 'cancelled' }),
    );
    expectStatus(allowed, 'cancelled');
    expectReason(allowed, 'cancel');
  });

  it('已取消为终态：不可恢复、禁止继续流转', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'cancelled',
        requestedStatus: 'pending_execution',
      }),
    );
    expectRejected(result, '不可恢复');
  });

  it('非法状态字符串被拒', () => {
    const result = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'unknown_status' as ProjectStatusOrCancelled }),
    );
    expectRejected(result, '不是合法状态');
  });

  it('未进单先执行标签存在时主状态保持待进单（TBD-08）', () => {
    // 带标签的待进单项目不允许人工调整离开待进单（取消除外）
    const blocked = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'executing',
        preEntryExecution: true,
      }),
    );
    expectRejected(blocked, '未进单先执行');

    // 带标签时自动触发事实也不流转：保持待进单（unchanged）
    const staysPending = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        actualInstallDoneAt: '2026-07-20',
        preEntryExecution: true,
      }),
    );
    expectStatus(staysPending, 'pending_entry');
    expectReason(staysPending, 'unchanged');

    // 取消不受标签约束
    const cancelAllowed = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'cancelled',
        preEntryExecution: true,
      }),
    );
    expectStatus(cancelAllowed, 'cancelled');
  });

  it('标签清除后主状态由负责人人工确定，且明确自动触发仍生效', () => {
    // 无标签的待进单项目可人工调整
    const manual = resolveStatus(
      ctx({ currentStatus: 'pending_entry', requestedStatus: 'executing' }),
    );
    expectStatus(manual, 'executing');
    expectReason(manual, 'manual');

    // 无标签 + 已录入实际装机完成时间 → 自动待验收（先执行后进单场景）
    const auto = resolveStatus(
      ctx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        actualInstallDoneAt: '2026-07-20',
      }),
    );
    expectStatus(auto, 'pending_acceptance');
    expectReason(auto, 'auto_install_done');
  });

  it('首次上门活动开始或首个搬迁批次开始运输 → 执行中（reason 标注 execution_started）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'executing',
        executionStarted: true,
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'execution_started');
  });

  it('维修中（under_repair）为合法主状态：仅由人工选择进入/离开', () => {
    // 合法状态枚举包含维修中
    expect(isLegalStatus('under_repair')).toBe(true);

    // 人工进入：执行中 → 维修中
    const enter = resolveStatus(
      ctx({ currentStatus: 'executing', requestedStatus: 'under_repair' }),
    );
    expectStatus(enter, 'under_repair');
    expectReason(enter, 'manual');

    // 人工离开：维修中 → 执行中
    const leave = resolveStatus(
      ctx({ currentStatus: 'under_repair', requestedStatus: 'executing' }),
    );
    expectStatus(leave, 'executing');
    expectReason(leave, 'manual');
  });

  it('维修中不参与自动触发：验收报告事实不自动推进出维修中（仅人工离开）', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'under_repair',
        acceptanceReportDate: '2026-07-25',
      }),
    );
    expectStatus(result, 'under_repair');
    expectReason(result, 'unchanged');
  });

  it('维修中不参与自动触发：计划上门到期/实际装机完成/金额闭环均不自动进入或离开维修中', () => {
    // 到期自动推进仅作用于待进单/待执行，维修中不因到期推进
    const due = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'under_repair',
        today: '2026-08-10',
        planVisitAt: '2026-08-01',
      }),
    );
    expectStatus(due, 'under_repair');
    expectReason(due, 'unchanged');

    // 实际装机完成自动触发仅作用于待进单/待执行/执行中，维修中不自动进入待验收
    const install = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'under_repair',
        actualInstallDoneAt: '2026-07-20',
      }),
    );
    expectStatus(install, 'under_repair');
    expectReason(install, 'unchanged');

    // 金额闭环仅在待掉票/已完成之间重算，维修中不自动进入已完成
    const closure = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'under_repair',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(closure, 'under_repair');
    expectReason(closure, 'unchanged');
  });

  it('维修中不因执行事实触发（execution_started）自动离开，仅人工选择可离开', () => {
    // 首次上门活动/批次开始运输的执行事实触发：维修中保持
    const factTriggered = resolveStatus(
      ctx({
        currentStatus: 'under_repair',
        requestedStatus: 'executing',
        executionStarted: true,
      }),
    );
    expectStatus(factTriggered, 'under_repair');
    expectReason(factTriggered, 'unchanged');

    // 负责人人工选择离开：维修中 → 执行中（无执行事实时走人工路径）
    const manual = resolveStatus(
      ctx({ currentStatus: 'under_repair', requestedStatus: 'executing' }),
    );
    expectStatus(manual, 'executing');
    expectReason(manual, 'manual');
  });
});

describe('计划上门日期到期自动推进（tasks 3.1 / design D5 转换表）', () => {
  const dueCtx = (overrides: Partial<TransitionContext> = {}) =>
    ctx({
      today: '2026-08-10',
      planVisitAt: '2026-08-10', // today >= plan_visit_date：已到期
      ...overrides,
    });

  it('到期：待进单 → 执行中（reason plan_visit_due）', () => {
    const result = resolveStatus(
      dueCtx({ currentStatus: 'pending_entry', requestedStatus: 'pending_entry' }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'plan_visit_due');
  });

  it('到期：待执行 → 执行中', () => {
    const result = resolveStatus(
      dueCtx({ currentStatus: 'pending_execution', requestedStatus: 'pending_execution' }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'plan_visit_due');
  });

  it('到期：执行中幂等不写（保持执行中）', () => {
    const result = resolveStatus(
      dueCtx({ currentStatus: 'executing', requestedStatus: 'executing' }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'unchanged');
  });

  it('到期：待验收/待掉票不倒退', () => {
    const acceptance = resolveStatus(
      dueCtx({ currentStatus: 'pending_acceptance', requestedStatus: 'pending_acceptance' }),
    );
    expectStatus(acceptance, 'pending_acceptance');
    expectReason(acceptance, 'unchanged');

    const invoice = resolveStatus(
      dueCtx({ currentStatus: 'pending_invoice', requestedStatus: 'pending_invoice' }),
    );
    expectStatus(invoice, 'pending_invoice');
    expectReason(invoice, 'unchanged');
  });

  it('到期：已完成终态不变', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'completed',
        requestedStatus: 'completed',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 100n },
      }),
    );
    expectStatus(result, 'completed');
  });

  it('到期：已取消终态不变（仍拒绝流转）', () => {
    const result = resolveStatus(
      dueCtx({ currentStatus: 'cancelled', requestedStatus: 'cancelled' }),
    );
    expectRejected(result, '不可恢复');
  });

  it('未到期不推进：today < planVisitAt 时保持现状', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_execution',
        today: '2026-08-10',
        planVisitAt: '2026-08-20',
      }),
    );
    expectStatus(result, 'pending_execution');
    expectReason(result, 'unchanged');
  });

  it('逾期补推进：计划上门日期早于 today 数日（漏跑）仍自动进入执行中', () => {
    const result = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_execution',
        today: '2026-08-10',
        planVisitAt: '2026-07-01',
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'plan_visit_due');
  });

  it('到期自动推进优先于人工目标值', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_acceptance', // 负责人同时提交其他人工状态值
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'plan_visit_due');
  });

  it('待进单带"未进单先执行"标签到期自动进入执行中', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        preEntryExecution: true,
      }),
    );
    expectStatus(result, 'executing');
    expectReason(result, 'plan_visit_due');
  });

  it('更强事实优先：到期但存在实际装机完成事实 → 待验收', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_execution',
        actualInstallDoneAt: '2026-08-09',
      }),
    );
    expectStatus(result, 'pending_acceptance');
    expectReason(result, 'auto_install_done');
  });

  it('更强事实优先：到期但存在验收报告事实 → 待掉票', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'pending_entry',
        requestedStatus: 'pending_entry',
        acceptanceReportDate: '2026-08-05',
      }),
    );
    expectStatus(result, 'pending_invoice');
    expectReason(result, 'auto_acceptance');
  });

  it('更强事实优先：待掉票到期且金额已达闭环 → 已完成（金额闭环优先）', () => {
    const result = resolveStatus(
      dueCtx({
        currentStatus: 'pending_invoice',
        requestedStatus: 'pending_invoice',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 800000n },
      }),
    );
    expectStatus(result, 'completed');
    expectReason(result, 'auto_amount_closure');
  });

  it('未提供 today 或计划上门日期为空时不启用到期推进', () => {
    const noToday = resolveStatus(
      ctx({
        currentStatus: 'pending_execution',
        requestedStatus: 'pending_execution',
        planVisitAt: '2026-08-01',
      }),
    );
    expectStatus(noToday, 'pending_execution');
    expectReason(noToday, 'unchanged');

    const noPlan = resolveStatus(
      ctx({ currentStatus: 'pending_execution', requestedStatus: 'pending_execution', today: '2026-08-10' }),
    );
    expectStatus(noPlan, 'pending_execution');
    expectReason(noPlan, 'unchanged');
  });
});

describe('删除执行/验收事实后的状态重算（resolveStatusAfterFactDeletion，Tasks 5.3）', () => {
  const base = (overrides: Partial<TransitionContext> = {}) =>
    ctx({
      acceptanceReportDate: null,
      actualInstallDoneAt: null,
      executionStarted: false,
      formallyEntered: true,
      ...overrides,
    });

  it('删除验收报告（已正式进单、无实际装机/执行事实）→ 待执行基线', () => {
    const result = resolveStatusAfterFactDeletion(base({ currentStatus: 'pending_invoice' }));
    expectStatus(result, 'pending_execution');
  });

  it('剩余实际装机完成事实 → 待验收', () => {
    const result = resolveStatusAfterFactDeletion(
      base({ currentStatus: 'pending_invoice', actualInstallDoneAt: '2026-07-20' }),
    );
    expectStatus(result, 'pending_acceptance');
  });

  it('已开始执行（剩余工作事实/批次开始运输）→ 执行中', () => {
    const result = resolveStatusAfterFactDeletion(
      base({ currentStatus: 'pending_invoice', executionStarted: true }),
    );
    expectStatus(result, 'executing');
  });

  it('plan visit due 不倒退：到期项目删除验收后仍为执行中', () => {
    // 基线已按到期推导为执行中，前向引擎保持执行中（reason unchanged）；
    // 语义是「不因删除验收事实回退」，以状态为准。
    const result = resolveStatusAfterFactDeletion(
      base({
        currentStatus: 'pending_invoice',
        planVisitAt: '2026-08-01',
        today: '2026-08-07',
      }),
    );
    expectStatus(result, 'executing');
  });

  it('未正式进单（含未进单先执行标签）→ 待进单', () => {
    const result = resolveStatusAfterFactDeletion(
      base({
        currentStatus: 'pending_entry',
        formallyEntered: false,
        preEntryExecution: true,
      }),
    );
    expectStatus(result, 'pending_entry');
  });

  it('剩余验收报告事实仍保留 → 待掉票（如删除的是其他执行事实）', () => {
    const result = resolveStatusAfterFactDeletion(
      base({ currentStatus: 'pending_invoice', acceptanceReportDate: '2026-08-01' }),
    );
    expectStatus(result, 'pending_invoice');
  });

  it('金额闭环完成态保留（防御分支）：存在有效掉票与最终可确认金额时仍为已完成', () => {
    const result = resolveStatusAfterFactDeletion(
      base({
        currentStatus: 'executing',
        amounts: { confirmedAmountCents: 1000n, finalConfirmableAmountCents: 1000n },
      }),
    );
    expectStatus(result, 'completed');
  });

  it('已取消终态无法可靠重算 → 拒绝', () => {
    const result = resolveStatusAfterFactDeletion(base({ currentStatus: 'cancelled' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('；')).toContain('已取消');
  });

  it('已转单终态无法可靠重算 → 拒绝（删除事实不覆盖终态）', () => {
    const result = resolveStatusAfterFactDeletion(
      base({ currentStatus: 'transferred', acceptanceReportDate: '2026-08-01' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('；')).toContain('已转单');
  });

  it('财务闭环完成态无法可靠反向重算 → 拒绝', () => {
    const result = resolveStatusAfterFactDeletion(
      base({
        currentStatus: 'completed',
        amounts: { confirmedAmountCents: 100n, finalConfirmableAmountCents: 100n },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('；')).toContain('已完成');
  });

  it('维修中删除执行/验收事实后保持不变（仅人工离开）', () => {
    const result = resolveStatusAfterFactDeletion(
      base({
        currentStatus: 'under_repair',
        acceptanceReportDate: '2026-08-01',
        actualInstallDoneAt: '2026-07-20',
        executionStarted: true,
      }),
    );
    expectStatus(result, 'under_repair');
    expectReason(result, 'unchanged');
  });
});
