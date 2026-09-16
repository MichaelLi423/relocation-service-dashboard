import { describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { ContractService } from '../../src/domain/capabilities/relocation-project-lifecycle/contract-service';
import { FixedClock } from '../../src/domain/core/time';
import { Money } from '../../src/domain/core/money';
import { expectRejected, expectReason, expectStatus } from '../helpers/state-assert';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';

/**
 * tasks 2.2 主状态人工调整与未进单先执行、2.3 执行准备与待验收触发、
 * 2.4 项目验收（relocation-project-lifecycle spec）。
 */

function setup(iso = '2026-08-07T10:00:00+08:00') {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const service = new ProjectService(projects, contracts, undefined, new FixedClock(iso));
  return { projects, contracts, service };
}

function prepareEnterableProject(
  service: ProjectService,
  amount = '10000',
  customerId = 'customer-1',
): string {
  const project = service.createPendingProject();
  const contract = service.attachContract(project.id);
  new ContractService().setUsdTaxAmount(contract, Money.parse(amount));
  service.linkCustomer(project.id, customerId);
  service.confirmScope(project.id);
  return project.id;
}

describe('主状态与标签（2.2）', () => {
  it('未进单先执行标签与主状态并存：记录「是否批复」boolean 事实，主状态保持待进单', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setPreEntryExecution(projectId, { approved: true });
    const project = projects.findById(projectId)!;
    expect(project.preEntryExecution).toBe(true);
    expect(project.managerApproved).toBe(true);
    // 0810：不再收集批复原因/缺失资料（legacy 列保持可读历史，不写入）。
    expect(project.managerApprovalReason).toBeNull();
    expect(project.managerApprovalMissing).toBeNull();
    expect(project.status).toBe('pending_entry');
  });

  it('未进单先执行「是否批复」可留空（boolean 事实为空 = 未填写，标签仍生效）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setPreEntryExecution(projectId, { approved: null });
    const project = projects.findById(projectId)!;
    expect(project.preEntryExecution).toBe(true);
    expect(project.managerApproved).toBeNull();
    expect(project.status).toBe('pending_entry');
  });

  it('取消项目进入已取消', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.cancelProject(projectId, {
      time: '2026-08-07',
      reason: '客户取消搬迁计划',
    });
    expect(projects.findById(projectId)!.status).toBe('cancelled');
  });

  it('负责人可人工调整主状态为已转单（终态）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    const result = service.adjustStatus(projectId, 'transferred');
    expectStatus(result, 'transferred');
    expectReason(result, 'transfer');
    expect(projects.findById(projectId)!.status).toBe('transferred');
  });

  it('已转单项目不可再离开终态：人工调整与自动触发均被拒绝', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'transferred');

    const manual = service.adjustStatus(projectId, 'executing');
    expectRejected(manual, '已转单项目为终态');
    expect(projects.findById(projectId)!.status).toBe('transferred');

    // 自动触发（实际装机完成/执行事实）也不覆盖终态
    const auto = service.adjustStatus(projectId, 'pending_acceptance', { executionStarted: true });
    expectRejected(auto, '已转单项目为终态');
    expect(projects.findById(projectId)!.status).toBe('transferred');
  });
});

describe('主状态人工调整与系统校验（2.2 / TBD-09）', () => {
  it('负责人直接调整主状态：待执行 → 执行中 校验通过', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'pending_execution'); // 人工先移至待执行
    const result = service.adjustStatus(projectId, 'executing');
    expectStatus(result, 'executing');
    expectReason(result, 'manual');
    expect(projects.findById(projectId)!.status).toBe('executing');
  });

  it('非法状态调整被拒：待执行 → 已完成（尚无掉票闭环依据）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'pending_execution');
    const result = service.adjustStatus(projectId, 'completed');
    expectRejected(result, '已完成');
    expect(projects.findById(projectId)!.status).toBe('pending_execution');
  });

  it('首次上门活动开始或首个搬迁批次开始运输 → 执行中（仅完成排期/工程师/运输安排不计）', () => {
    const { service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'pending_execution');
    const result = service.adjustStatus(projectId, 'executing', { executionStarted: true });
    expectStatus(result, 'executing');
    expectReason(result, 'execution_started');
  });

  it('未进单先执行期间主状态保持待进单（TBD-08）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.setPreEntryExecution(projectId, { approved: true });
    const result = service.adjustStatus(projectId, 'executing');
    expectRejected(result, '未进单先执行');
    expect(projects.findById(projectId)!.status).toBe('pending_entry');
  });

  it('先执行后进单：正式进单基线待执行（无自动触发时），主状态由负责人后续确定', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.setPreEntryExecution(projectId, { approved: true });

    // 正式进单（在原项目上完成、不新建项目）
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    const afterEntry = projects.findById(projectId)!;
    expect(afterEntry.entryAt).not.toBeNull();
    expect(afterEntry.preEntryExecution).toBe(false);
    // 进单后基线待执行（无实际装机完成/验收等自动触发事实）
    expect(afterEntry.status).toBe('pending_execution');

    // 由负责人人工确定主状态
    const result = service.adjustStatus(projectId, 'executing');
    expectStatus(result, 'executing');
    expect(projects.findById(projectId)!.status).toBe('executing');
  });

  it('先录入实际装机完成时间后进单自动待验收（TBD-07）', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.setPreEntryExecution(projectId, { approved: true });

    // 带标签期间录入实际装机完成时间：主状态保持待进单
    service.recordActualInstallDone(projectId, '2026-07-20');
    expect(projects.findById(projectId)!.status).toBe('pending_entry');

    // 正式进单后按明确自动触发 → 待验收
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    expect(projects.findById(projectId)!.status).toBe('pending_acceptance');
  });
});

describe('执行准备与待验收触发（2.3）', () => {
  it('计划上门时间与计划运输时间分开记录', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateExecutionPreparation(projectId, {
      planVisitAt: '2026-08-10',
      planTransportAt: '2026-08-11',
    });
    const project = projects.findById(projectId)!;
    expect(project.planVisitAt).toBe('2026-08-10');
    expect(project.planTransportAt).toBe('2026-08-11');
  });

  it('场地确认不影响状态流转', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.updateExecutionPreparation(projectId, { siteConfirmed: true });
    const project = projects.findById(projectId)!;
    expect(project.siteConfirmed).toBe(true);
    expect(project.status).toBe('pending_entry');
  });

  it('计划时间到期不自动流转（计划时间与场地确认均不触发主状态）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'executing');
    service.updateExecutionPreparation(projectId, {
      planVisitAt: '2026-08-01', // 已到期
      planTransportAt: '2026-08-02',
      siteConfirmed: true,
    });
    expect(projects.findById(projectId)!.status).toBe('executing');
  });

  it('录入实际装机完成时间自动进入待验收（TBD-07）', () => {
    const { projects, service } = setup();
    const projectId = service.createPendingProject().id;
    service.adjustStatus(projectId, 'executing');
    service.recordActualInstallDone(projectId, '2026-08-05');
    const project = projects.findById(projectId)!;
    expect(project.actualInstallDoneAt).toBe('2026-08-05');
    expect(project.status).toBe('pending_acceptance');
  });
});

describe('项目验收（2.4 / TBD-07）', () => {
  /** 构造处于待验收的项目：进单 → 执行 → 实际装机完成自动待验收。 */
  function preparePendingAcceptance(service: ProjectService): string {
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.adjustStatus(projectId, 'executing');
    service.recordActualInstallDone(projectId, '2026-08-05');
    return projectId;
  }

  it('标记验收报告并填写报告形成日期 → 自动进入待掉票（不要求客户确认）', () => {
    const { projects, service } = setup();
    const projectId = preparePendingAcceptance(service);
    expect(projects.findById(projectId)!.status).toBe('pending_acceptance');
    service.markAcceptance(projectId, '2026-08-06');
    const project = projects.findById(projectId)!;
    expect(project.acceptanceReport).toBe(true);
    expect(project.acceptanceReportDate).toBe('2026-08-06');
    expect(project.status).toBe('pending_invoice');
  });

  it('验收报告事实不要求当前状态已待验收：执行中直接标记验收自动进入待掉票', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.adjustStatus(projectId, 'executing');
    expect(projects.findById(projectId)!.status).toBe('executing');
    service.markAcceptance(projectId, '2026-08-06');
    const project = projects.findById(projectId)!;
    expect(project.acceptanceReport).toBe(true);
    expect(project.status).toBe('pending_invoice');
  });

  it('未进单先执行项目标记验收报告保持待进单，正式进单后自动进入待掉票', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.setPreEntryExecution(projectId, { approved: true });
    service.markAcceptance(projectId, '2026-08-06');
    expect(projects.findById(projectId)!.status).toBe('pending_entry'); // 标签约束保持待进单
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    expect(projects.findById(projectId)!.status).toBe('pending_invoice'); // 进单后验收事实自动生效
  });

  it('已取消项目拒绝标记验收报告', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.adjustStatus(projectId, 'executing');
    service.cancelProject(projectId, { time: '2026-08-07', reason: '客户取消搬迁计划' });
    expect(projects.findById(projectId)!.status).toBe('cancelled');
    expect(() => service.markAcceptance(projectId, '2026-08-06')).toThrow(/已取消/);
    const project = projects.findById(projectId)!;
    expect(project.acceptanceReport).toBe(false); // 拒绝后不写入验收事实
  });

  it('验收后继续报修/维修不影响验收、待掉票或完成状态', () => {
    const { projects, service } = setup();
    const projectId = preparePendingAcceptance(service);
    service.markAcceptance(projectId, '2026-08-06');
    expect(projects.findById(projectId)!.status).toBe('pending_invoice');

    // 损坏/维修事项不是 lifecycle 的输入事实：登记/继续维修不改变主状态
    const stable = service.adjustStatus(projectId, 'pending_invoice');
    expectStatus(stable, 'pending_invoice');
    expectReason(stable, 'unchanged');
  });
});

describe('删除验收报告（clearAcceptance，2.4 反向操作）：按事实确定性回退状态', () => {
  it('有掉票历史（含已撤销）拒绝；无掉票历史时清空验收事实并按事实回退', () => {
    const { projects, service } = setup();
    const projectId = prepareEnterableProject(service);
    service.formalEntry(projectId, { ecc: 'ECC-001' });
    service.markAcceptance(projectId, '2026-08-06');
    expect(projects.findById(projectId)!.status).toBe('pending_invoice');

    // 有掉票历史 → 拒绝且验收事实保留
    expect(() =>
      service.clearAcceptance(projectId, { hasAnyInvoiceHistory: true, executionStarted: false }),
    ).toThrow(/掉票历史/);
    expect(projects.findById(projectId)!.acceptanceReport).toBe(true);

    // 无掉票历史 → 清空并回退到正式进单基线（无实际装机/执行事实）
    service.clearAcceptance(projectId, { hasAnyInvoiceHistory: false, executionStarted: false });
    const cleared = projects.findById(projectId)!;
    expect(cleared.acceptanceReport).toBe(false);
    expect(cleared.acceptanceReportDate).toBeNull();
    expect(cleared.status).toBe('pending_execution');
  });

  it('已实际装机完成 → 回退到待验收；已开始执行 → 回退到执行中', () => {
    const { projects, service } = setup();
    // 已实际装机完成
    const p1 = prepareEnterableProject(service);
    service.recordActualInstallDone(p1, '2026-07-20');
    service.markAcceptance(p1, '2026-08-06');
    expect(projects.findById(p1)!.status).toBe('pending_invoice');
    service.clearAcceptance(p1, { hasAnyInvoiceHistory: false, executionStarted: false });
    expect(projects.findById(p1)!.status).toBe('pending_acceptance');

    // 已开始执行（但未实际装机完成）
    const p2 = prepareEnterableProject(service);
    service.formalEntry(p2, { ecc: 'ECC-002' });
    service.adjustStatus(p2, 'executing', { executionStarted: true });
    service.markAcceptance(p2, '2026-08-06');
    expect(projects.findById(p2)!.status).toBe('pending_invoice');
    service.clearAcceptance(p2, { hasAnyInvoiceHistory: false, executionStarted: true });
    expect(projects.findById(p2)!.status).toBe('executing');
  });

  it('未进单先执行标签存在 → 回退到待进单（标签规则）；已取消项目拒绝', () => {
    const { projects, service } = setup();
    // 未进单先执行：验收报告可标记但主状态保持待进单
    const p1 = service.createPendingProject().id;
    service.attachContract(p1);
    service.linkCustomer(p1, 'customer-1');
    service.setPreEntryExecution(p1, { approved: true });
    service.markAcceptance(p1, '2026-08-06');
    expect(projects.findById(p1)!.status).toBe('pending_entry');
    service.clearAcceptance(p1, { hasAnyInvoiceHistory: false, executionStarted: false });
    expect(projects.findById(p1)!.status).toBe('pending_entry');

    // 已取消项目拒绝
    const p2 = prepareEnterableProject(service);
    service.cancelProject(p2, { time: '2026-08-07', reason: '取消' });
    expect(() =>
      service.clearAcceptance(p2, { hasAnyInvoiceHistory: false, executionStarted: false }),
    ).toThrow(/已取消/);
  });
});
