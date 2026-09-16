import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, prepareReadBigInt } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence';
import {
  SqliteActivityEngineerRepository,
  SqliteActivityRepository,
  SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
  SqliteWorkFactRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { ShipToService, type ShipToRepository } from '../../src/domain/capabilities/ship-to-management';
import { QrRequestService, type QrRequestRepository } from '../../src/domain/capabilities/qr-request-tracking';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type {
  ProjectWizardPayload,
  WorkbenchV2LookupRow,
  WorkbenchV2MutationResult,
  WorkbenchV2SectionRow,
} from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 工作台 application facade → 领域服务 → SQLite（Oracle #10 迁移为 v2 有界 API）：
 * 写动作一律经 v2Mutate（不携带 snapshot），读取经 v2Overview/detail/section/
 * independent/lookup；Ship-to 申请仍为独立 requestId 线性命令（仅返回受影响申请）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function projectIdOf(result: WorkbenchV2MutationResult): string {
  return result.changed!.projectId!;
}

function wizard(overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload {
  return {
    intent: 'formal',
    customerName: '客户',
    region: 'East',
    contractStartDate: '2026-08-01',
    contractEndDate: '2027-07-31',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentCount: 1,
    siteConfirmed: false,
    ...overrides,
  };
}

async function makeFacade(): Promise<{ facade: WorkbenchFacade; db: import('node:sqlite').DatabaseSync; accountId: string }> {
  const dir = makeTempDir('workbench-facade-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  return { facade, db, accountId: account.id };
}

describe('工作台 application facade → 领域服务 → SQLite（v2 有界 API）', () => {
  it('同次 create/supplement 先保存未进单先执行标签，再以到期计划上门日期经 lifecycle 推进并审计', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '同次新建先执行客户',
        managerApproved: true,
        planVisitAt: '2000-01-01',
      }),
    });
    const createdId = projectIdOf(created);
    expect(facade.v2ProjectDetail(createdId).project).toMatchObject({
      status: 'executing', preEntryExecution: true,
    });

    const draft = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'draft', customerName: '同次补齐先执行客户' }),
    });
    const supplementedId = projectIdOf(draft);
    facade.v2Mutate({
      op: 'supplement_project',
      payload: { projectId: supplementedId, managerApproved: true, plannedVisitAt: '2000-01-01' },
    });
    expect(facade.v2ProjectDetail(supplementedId).project).toMatchObject({
      status: 'executing', preEntryExecution: true,
    });
    const audits = db.prepare(
      "SELECT project_id, reason, source FROM project_status_transition_audit WHERE reason = 'plan_visit_due' ORDER BY project_id",
    ).all() as Array<{ project_id: string; reason: string; source: string }>;
    expect(audits).toEqual(expect.arrayContaining([
      { project_id: createdId, reason: 'plan_visit_due', source: 'system' },
      { project_id: supplementedId, reason: 'plan_visit_due', source: 'system' },
    ]));
  });

  it('二维码类型写入失败：外层 BEGIN IMMEDIATE 整体回滚，不留下申请或类型行', async () => {
    const dir = makeTempDir('workbench-qr-atomic-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const failingTypes: QrRequestRepository = {
      findById: () => undefined,
      listAll: () => [],
      deleteById: () => undefined,
      save: (request) => {
        db.prepare('INSERT INTO qr_requests (id, applicant, requested_at, created_at) VALUES (?,?,?,?)')
          .run(request.id, request.applicant, request.requestedAt, request.createdAt);
        db.prepare('INSERT INTO qr_request_types (id, qr_request_id, type_code) VALUES (?,?,?)')
          .run(`${request.id}:A`, request.id, 'A');
        throw new Error('injected-qr-type-write-failure');
      },
    };
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }), {
      qrRequestService: new QrRequestService(failingTypes),
    });

    expect(() => facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A'] } },
    })).toThrow('injected-qr-type-write-failure');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_requests').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_request_types').get()!.n).toBe(0);
  });

  it('真实保存项目、项目提醒、十类动作中的核心记录及独立二维码申请', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '集成测试客户',
        ecc: 'ECC-UI-001',
        contractAmount: '100000',
        instrumentCount: 1,
        oldSiteContact: '旧址王工',
        newSiteContact: '新址李工',
      }),
    });
    const projectId = projectIdOf(created);
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.formallyEntered).toBe(true);
    expect(detail.ecc).toBe('ECC-UI-001');
    expect(facade.v2ProjectDetail(projectId).detail).toMatchObject({ oldSiteContact: '旧址王工', newSiteContact: '新址李工' });
    // 搬迁开单经独立 submit_action（create_project 不再消费 serviceOrderNo/engineers/note）
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-WIZ-001', orderedAt: '2026-08-11', engineer: '工程师甲、乙', note: '现场提前联系' } },
    });
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).rows[0]).toMatchObject({ serviceOrderNo: 'SO-WIZ-001', engineer: '工程师甲、乙', note: '现场提前联系' });
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-09', reminderNote: '确认运输安排' });
    expect(facade.v2ProjectDetail(projectId).project!.reminderNote).toBe('确认运输安排');
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '测试运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } },
    });
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(1);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '20000' } },
    });
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('20000.00');
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '负责人', requestedAt: '2026-08-11', types: ['A', 'logistics_management'] } },
    });
    const qr = facade.v2IndependentPage({ kind: 'qr_request' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2IndependentPage']>['rows'][number],
      { kind: 'qr_request' }
    >;
    expect(qr.workload).toBe(2);
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    expect(report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows).toHaveLength(1);
  });

  it('人工主状态必须经过 lifecycle 校验并将拒绝原因返回界面层', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '待进单客户', region: 'North' }),
    });
    const projectId = projectIdOf(created);
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId, status: 'completed' })).toThrow();
  });

  it('已转单终态：经 adjust_status 持久化并写入审计，冻结项目资料与后续状态流转', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '转单客户', region: 'East', ecc: 'ECC-TRANSFER-1', contractAmount: '1000' }),
    });
    const projectId = projectIdOf(created);

    const transferred = facade.v2Mutate({ op: 'adjust_status', projectId, status: 'transferred' });
    expect(transferred.changed).toMatchObject({ projectId, status: 'transferred' });
    // v21 SQLite CHECK 接受 transferred
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)).toMatchObject({ status: 'transferred' });
    expect(
      db.prepare('SELECT to_status, reason FROM project_status_transition_audit WHERE project_id = ?').get(projectId),
    ).toMatchObject({ to_status: 'transferred', reason: 'transfer' });

    // 终态不可再离开：人工调整与自动触发均拒绝
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' })).toThrow(/已转单项目为终态/);
    // 终态冻结项目资料更新
    expect(() => facade.v2Mutate({ op: 'update_project', payload: { projectId, region: 'North' } })).toThrow(/已转单项目禁止修改项目资料/);
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)).toMatchObject({ status: 'transferred' });
  });

  it('Ship-to 申请按 requestId 线性推进：创建草稿→提交→完成；重复创建/重复推进不重复申请与工作量', async () => {    const { facade } = await makeFacade();
    // 创建草稿：API 返回该记录（不自动 submit），无提交时间不计工作量
    const created = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址甲' });
    expect(created.request.status).toBe('pending_submit');
    expect(created.request.submittedAt).toBeNull();
    // 有界结果：仅受影响申请，不携带任何快照
    expect(Object.keys(created)).toEqual(['request']);
    const requestId = created.request.id;
    // 重复创建同客户同地址：返回既有申请，不新建
    const again = facade.createShipToRequest({ customerName: 'ShipTo客户', newSiteAddress: '新址甲' });
    expect(again.request.id).toBe(requestId);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    // 提交：pending → processing（记录首次提交时间）
    const submitted = facade.submitShipToRequest(requestId);
    expect(submitted.request.status).toBe('processing');
    expect(submitted.request.submittedAt).toBeTruthy();
    // 重复提交：领域拒绝（线性流转不可退回）
    expect(() => facade.submitShipToRequest(requestId)).toThrow(/不可退回|已提交/);
    // 完成：processing → completed（v2 mutation，补入 Account ID）
    const completed = facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-900' });
    expect(completed.changed).toMatchObject({ requestId, status: 'completed', accountId: 'ACC-900' });
    // 完成态不回退：再次提交/完成均被领域拒绝
    expect(() => facade.submitShipToRequest(requestId)).toThrow(/不可再次提交/);
    expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-901' })).toThrow(/仅处理中/);
    // 工作量：仅首次提交计一次（草稿与后续状态更新不重复计数）
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const workload = report.sections.find((s) => s.key === 'ship_to_request_workload')?.rows ?? [];
    expect(workload).toHaveLength(1);
    expect(workload[0]).toMatchObject({ count: 1 });
  });

  it('Ship-to 组合快速动作幂等：pending 才 submit、processing 只允许 complete、completed 只返回不回退', async () => {
    const { facade } = await makeFacade();
    // 组合动作创建并推进到 completed（一次调用）
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'completed', accountId: 'ACC-IDEM-1' } },
    });
    const shipToRows = (): Array<Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>> =>
      facade.v2LookupPage({ kind: 'ship_to_requests' }).rows as unknown as Array<
        Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>
      >;
    const request = shipToRows().find((r) => r.accountId === 'ACC-IDEM-1');
    expect(request?.status).toBe('completed');
    // 重复调用同客户同地址：返回既有已完成申请，不新建、不回退、不重复计工作量
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'completed', accountId: 'ACC-IDEM-1' } },
    });
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    expect(shipToRows()[0].status).toBe('completed');
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const workload = report.sections.find((s) => s.key === 'ship_to_request_workload')?.rows ?? [];
    expect(workload).toHaveLength(1);
    expect(workload[0]).toMatchObject({ count: 1 });
    // 已完成申请再次以 pending_submit 调用也不会回退
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: '幂等客户', newSiteAddress: '新址幂等', status: 'pending_submit' } },
    });
    expect(shipToRows()[0].status).toBe('completed');
  });

  it('掉票编辑/撤销：金额字符串精确编辑并更新报表/状态；撤销为终态；取消项目被拒', async () => {
    const { facade } = await makeFacade();
    // 正式进单 + 实际装机完成 + 验收 → 待掉票（金额闭环可重算）
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '掉票编辑客户',
        ecc: 'ECC-INV-EDIT',
        contractAmount: '2000',
        actualInstallDoneAt: '2026-08-08',
        instrumentCount: 1,
      }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-09' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    let invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].amount).toBe('1000.00'); // 金额为十进制字符串，不引入 Number 精度
    expect(invoices[0].active).toBe(true);
    const invoiceId = invoices[0].id;

    // 编辑：1234.567 → 123457 分（HALF_UP），金额字符串 '1234.57'
    facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12', amount: '1234.567' });
    invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].amount).toBe('1234.57');
    expect(facade.v2ProjectDetail(projectId).project!.invoicedAmount).toBe('1234.57');

    // 编辑至累计达到最终可确认金额 → 自动进入已完成（金额闭环）
    facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-12', amount: '2000' });
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('2000.00');
    expect(detail.status).toBe('completed');
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const invRow = report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows?.[0] as Record<string, unknown>;
    expect(invRow.amountCents).toBe('2000.00'); // 报表 IPC 序列化：bigint → 十进制字符串

    // 撤销：撤销后为终态，不计入金额，状态回退到待掉票
    facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-13', reason: '客户更正' });
    invoices = facade.v2SectionPage({ projectId, kind: 'invoices' }).rows as Array<
      Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'invoices' }>
    >;
    expect(invoices[0].active).toBe(false);
    expect(invoices[0].revokedAt).toBeTruthy();
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.invoicedAmount).toBe('0.00');
    expect(detail.status).toBe('pending_invoice');

    // 重复撤销 / 撤销后编辑：终态拒绝
    expect(() => facade.v2Mutate({ op: 'invoice_revoke', invoiceId, time: '2026-08-14', reason: '再次撤销' })).toThrow(/终态/);
    expect(() => facade.v2Mutate({ op: 'invoice_edit', invoiceId, invoicedAt: '2026-08-14', amount: '2000' })).toThrow(/终态/);

    // 取消项目：任何掉票历史（含已撤销）禁止取消
    expect(() => facade.v2Mutate({ op: 'cancel_project', projectId, time: '2026-08-15', reason: '客户取消' })).toThrow(/掉票/);
  });

  it('Ship-to complete 原子性：第二步不可变 Ship-to 落库失败时整体回滚，申请保持 processing 且无 Ship-to', async () => {
    const dir = makeTempDir('workbench-shipto-atomic-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
      // 注入第二步失败的 ShipToRepository（真实 SQLite：请求落库成功、Ship-to 创建失败）
      const realShipTos = new SqliteShipToRepository(db);
      const failingShipTos: ShipToRepository = {
        findById: (id) => realShipTos.findById(id),
        findByAccountId: (acc) => realShipTos.findByAccountId(acc),
        save: () => {
          throw new Error('第二步：不可变 Ship-to 落库失败');
        },
        listAll: () => realShipTos.listAll(),
      };
      const service = new ShipToService(failingShipTos, new SqliteShipToRequestRepository(db), new SqliteShipToAddressReader(db));
      const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }), { shipToService: service });
      const created = facade.createShipToRequest({ customerName: '原子客户', newSiteAddress: '新址原子' });
      const requestId = created.request.id;
      expect(created.request.status).toBe('pending_submit');
      expect(facade.submitShipToRequest(requestId).request.status).toBe('processing');
      // 完成：请求状态保存成功但第二步 Ship-to 落库失败 → 同一 SQLite 事务整体回滚
      expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-ATOMIC-1' })).toThrow(/第二步/);
      const row = db.prepare('SELECT status, account_id FROM ship_to_requests WHERE id = ?').get(requestId) as { status: string; account_id: string | null };
      expect(row.status).toBe('processing');
      expect(row.account_id).toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('Ship-to complete 唯一冲突：目标 Account ID 已存在时拒绝，申请保持 processing 且不产生新 Ship-to', async () => {
    const dir = makeTempDir('workbench-shipto-conflict-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
      const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
      // 预置一条不可变 Ship-to（系统外已占用该 Account ID）
      db.prepare('INSERT INTO ship_tos (id, account_id, customer_name, new_site_address, created_at) VALUES (?,?,?,?,?)').run('ghost', 'ACC-CONFLICT', '其他客户', '其他地址', 't');
      const created = facade.createShipToRequest({ customerName: '冲突客户', newSiteAddress: '新址冲突' });
      const requestId = created.request.id;
      facade.submitShipToRequest(requestId);
      expect(() => facade.v2Mutate({ op: 'ship_to_complete', requestId, accountId: 'ACC-CONFLICT' })).toThrow(/已存在/);
      const row = db.prepare('SELECT status FROM ship_to_requests WHERE id = ?').get(requestId) as { status: string };
      expect(row.status).toBe('processing');
      expect((db.prepare('SELECT COUNT(*) AS n FROM ship_tos').get() as { n: number }).n).toBe(1); // 仅预置那条，未产生新的
    } finally {
      closeDatabase(db);
    }
  });

  it('update_project 普通资料更新落库：区域/联系人/地址/合同起止/计划时间/现场确认，返回完整 invalidation tags', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'draft',
        instrumentCount: undefined,
        customerName: '资料更新客户',
        region: 'East',
        oldSiteContact: '旧址王工',
        newSiteContact: '新址李工',
        oldSiteAddress: '旧址甲',
        newSiteAddress: '新址乙',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        planVisitAt: '2026-08-10',
        planTransportAt: '2026-08-12',
        siteConfirmed: true,
      }),
    });
    const projectId = projectIdOf(created);

    const result = facade.v2Mutate({
      op: 'update_project',
      payload: {
        projectId,
        region: 'South',
        oldSiteContact: '新旧址张工',
        newSiteContact: '新新址刘工',
        oldSiteAddress: '旧址丙',
        newSiteAddress: '新址丁',
        contractStartDate: '2026-09-01',
        contractEndDate: '2027-08-31',
        plannedVisitAt: '2026-09-05',
        plannedTransportAt: null, // 显式清空
        siteConfirmed: false, // 显式 false，不允许 truthy 丢失
      },
    });
    // 失效标签覆盖 projects/overview/project/sections
    expect(result.changed).toMatchObject({ projectId });
    expect(result.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.project!.region).toBe('South');
    expect(detail.detail).toMatchObject({
      oldSiteContact: '新旧址张工',
      newSiteContact: '新新址刘工',
      oldSiteAddress: '旧址丙',
      newSiteAddress: '新址丁',
      contractStartDate: '2026-09-01',
      contractEndDate: '2027-08-31',
      planVisitAt: '2026-09-05',
      planTransportAt: null,
      siteConfirmed: false,
    });
  });

  it('update_project 客户重关联：按名称匹配既有客户或登记新客户；区域空串=清空，联系人 null=清空', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '原客户', region: 'East', oldSiteContact: '旧址王工' }),
    });
    const projectId = projectIdOf(created);

    // 重关联到新名称：登记新客户并刷新 lookup 标签
    const relinked = facade.v2Mutate({
      op: 'update_project',
      payload: { projectId, customerName: '新客户甲', oldSiteContact: null },
    });
    expect(relinked.invalidated).toContain('lookup:customers');
    expect(facade.v2ProjectDetail(projectId).project!.customerName).toBe('新客户甲');
    expect(facade.v2ProjectDetail(projectId).detail!.oldSiteContact).toBeNull();

    // 重关联到已存在的客户名称：不重复登记，仅改挂
    facade.v2Mutate({ op: 'update_project', payload: { projectId, customerName: '新客户甲' } });
    expect(facade.v2ProjectDetail(projectId).project!.customerName).toBe('新客户甲');
    // 区域空串 = 清空
    facade.v2Mutate({ op: 'update_project', payload: { projectId, region: '' } });
    expect(facade.v2ProjectDetail(projectId).project!.region).toBeNull();
  });

  it('update_project 正式进单后更正 ECC/进单日期/合同金额/最终可确认金额', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '金额更正客户',
        ecc: 'ECC-UPD-1',
        entryAt: '2026-08-01',
        contractAmount: '100000',
      }),
    });
    const projectId = projectIdOf(created);
    const detail = facade.v2ProjectDetail(projectId);
    expect(detail.project!.formallyEntered).toBe(true);

    facade.v2Mutate({
      op: 'update_project',
      payload: {
        projectId,
        ecc: 'ECC-UPD-2',
        entryAt: '2026-08-15',
        contractUsdTaxAmount: '2000',
        finalConfirmableAmount: '1500',
      },
    });
    const after = facade.v2ProjectDetail(projectId);
    expect(after.project!.ecc).toBe('ECC-UPD-2');
    expect(after.project!.entryAt).toBe('2026-08-15');
    expect(after.project!.contractAmount).toBe('2000.00');
    expect(after.project!.finalAmount).toBe('1500.00');
  });

  it('update_project 待进单项目拒绝财务/业务标识更正，不绕过正式进单语义', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '待进单更正客户' }),
    });
    const projectId = projectIdOf(created);
    expect(() =>
      facade.v2Mutate({ op: 'update_project', payload: { projectId, contractUsdTaxAmount: '5000' } }),
    ).toThrow(/仅允许已正式进单项目/);
    expect(() =>
      facade.v2Mutate({ op: 'update_project', payload: { projectId, ecc: 'ECC-X' } }),
    ).toThrow(/仅允许已正式进单项目/);
    // 普通资料仍可更新
    facade.v2Mutate({ op: 'update_project', payload: { projectId, region: 'North' } });
    expect(facade.v2ProjectDetail(projectId).project!.region).toBe('North');
  });

  it('update_project 不变量错误不部分落库：区域修改已写入后金额不合法，整体回滚', async () => {
    const { facade } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '原子更正客户',
        ecc: 'ECC-ATOMIC',
        contractAmount: '2000',
      }),
    });
    const projectId = projectIdOf(created);
    // 掉票 1000 → 最终可确认金额不得低于累计有效掉票
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    expect(facade.v2ProjectDetail(projectId).project!.invoicedAmount).toBe('1000.00');

    // 同一次调用：区域已提交（事务内先写）但 finalAmount 低于累计掉票被领域拒绝 → 整体回滚
    expect(() =>
      facade.v2Mutate({
        op: 'update_project',
        payload: { projectId, region: 'West', finalConfirmableAmount: '500' },
      }),
    ).toThrow(/不得低于累计有效掉票/);
    const after = facade.v2ProjectDetail(projectId);
    expect(after.project!.region).toBe('East');
    expect(after.project!.finalAmount).toBe('2000.00');
  });

  it('update_project 尊重不变量：ECC 全局唯一冲突拒绝，且已取消项目禁止任何更新', async () => {
    const { facade } = await makeFacade();
    const first = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '唯一客户一', ecc: 'ECC-UNIQUE-1', contractAmount: '1000' }),
    });
    const second = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '唯一客户二', ecc: 'ECC-UNIQUE-2', contractAmount: '1000' }),
    });
    // ECC 冲突：拒绝且原值保持不变
    expect(() =>
      facade.v2Mutate({ op: 'update_project', payload: { projectId: projectIdOf(second), ecc: 'ECC-UNIQUE-1' } }),
    ).toThrow(/ECC.*已存在/);
    expect(facade.v2ProjectDetail(projectIdOf(second)).project!.ecc).toBe('ECC-UNIQUE-2');

    // 已取消项目：终态禁止任何资料更新
    facade.v2Mutate({ op: 'cancel_project', projectId: projectIdOf(first), time: '2026-08-15', reason: '客户取消' });
    expect(() =>
      facade.v2Mutate({ op: 'update_project', payload: { projectId: projectIdOf(first), region: 'North' } }),
    ).toThrow(/已取消项目禁止修改项目资料/);
    expect(facade.v2ProjectDetail(projectIdOf(first)).project!.region).toBe('East');
  });

  // ---- 快速记录搬迁批次：批次 + 物流费用同一事务原子创建 ----

  it('快速记录搬迁批次：原子创建批次与唯一物流费用，两个价格口径正确映射', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '批次快速记录客户' }),
    });
    const projectId = projectIdOf(created);

    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: {
        type: 'batch',
        projectId,
        values: {
          planTransportDate: '2026-08-10',
          transportCompany: '测试运输',
          appliedAt: '2026-08-09',
          budgetPrice: '12000',
          dealPrice: '11000',
        },
      },
    });

    const batch = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    // 合同预算价 → batch.originalPriceCents；物流成交价 → batch.discountedPriceCents
    expect(batch).toMatchObject({
      planTransportDate: '2026-08-10',
      transportCompany: '测试运输',
      originalPrice: '12000.00',
      discountedPrice: '11000.00',
    });

    // 费用记录同批落库：budgetPrice → fee.budgetPriceCents；dealPrice → dealPriceCents + logisticsCostCents
    const fee = prepareReadBigInt(
      db,
      'SELECT applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents FROM logistics_fees WHERE batch_id = ?',
    ).get(batch.id) as {
      applied_at: string;
      budget_price_cents: bigint;
      deal_price_cents: bigint;
      logistics_cost_cents: bigint;
    };
    expect(fee.applied_at).toBe('2026-08-09');
    expect(fee.budget_price_cents).toBe(1200000n); // 12000 元
    expect(fee.deal_price_cents).toBe(1100000n);
    expect(fee.logistics_cost_cents).toBe(1100000n); // 物流成交价即最终实际费用
  });

  it('快速记录搬迁批次：全空仅建批次、单字段建部分费用、非法值全部回滚', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '原子批次客户' }),
    });
    const projectId = projectIdOf(created);

    // 全空费用字段：仅建批次、不建物流费用（空金额不得转 0、空日期不得默认当天）
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '', transportCompany: '', appliedAt: '', budgetPrice: '', dealPrice: '' } },
    });
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(1);
    const emptyBatch = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(emptyBatch.originalPrice).toBeNull();
    expect(emptyBatch.discountedPrice).toBeNull();
    expect(emptyBatch.appliedAt).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get(emptyBatch.id) as { n: number },
    ).toMatchObject({ n: 0 });

    // 单字段创建部分费用：仅 appliedAt 有值 → 建部分费用，金额全空
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '', transportCompany: '', appliedAt: '2026-08-09', budgetPrice: '', dealPrice: '' } },
    });
    // 同毫秒创建的批次 created_at 相同，rows 排序按随机 id 决胜，不能依赖 rows[0]；
    // 按费用记录定位该批次，再经真实 section 链路读取行 DTO。
    const feeBatch = db
      .prepare('SELECT batch_id FROM logistics_fees WHERE applied_at = ? AND batch_id IN (SELECT id FROM batches WHERE project_id = ?)')
      .get('2026-08-09', projectId) as { batch_id: string } | undefined;
    expect(feeBatch).toBeTruthy();
    const partialBatch = facade.v2SectionPage({ projectId, kind: 'batches' }).rows.find(
      (r) => r.id === feeBatch!.batch_id,
    ) as Extract<WorkbenchV2SectionRow, { kind: 'batches' }>;
    expect(partialBatch.appliedAt).toBe('2026-08-09');
    const partialFee = prepareReadBigInt(
      db,
      'SELECT applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents FROM logistics_fees WHERE batch_id = ?',
    ).get(partialBatch.id) as {
      applied_at: string | null;
      budget_price_cents: bigint | null;
      deal_price_cents: bigint | null;
      logistics_cost_cents: bigint | null;
    };
    expect(partialFee.applied_at).toBe('2026-08-09');
    expect(partialFee.budget_price_cents).toBeNull();
    expect(partialFee.deal_price_cents).toBeNull();
    expect(partialFee.logistics_cost_cents).toBeNull();

    // 非法价格：预算价 0 报错；成交价 -1 报错；均原子回滚不落库
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', appliedAt: '2026-08-09', budgetPrice: '0', dealPrice: '11000' } },
      }),
    ).toThrow(/合同预算价/);
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '-1' } },
      }),
    ).toThrow(/物流成交价|不得为负数/);

    // 原子性：批次已创建后报价校验失败（日期格式非法）→ 同一事务整体回滚
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'batch', projectId, values: { planTransportDate: '2026-8-1', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } },
      }),
    ).toThrow(/计划运输日期 格式非法/);

    // 失败均未产生任何额外批次或费用（仅前面两个合法批次）
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(2);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM logistics_fees').get() as { n: number },
    ).toMatchObject({ n: 1 }); // 仅部分费用那一笔
  });

  // ---- batch_edit：编辑批次与费用，不允许修改 appliedAt ----

  it('batch_edit 修改计划运输日期/运输公司/合同预算价/物流成交价，不改变 appliedAt', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '批次编辑客户' }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '原公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } },
    });
    const before = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    const appliedAtBefore = prepareReadBigInt(db, 'SELECT applied_at FROM logistics_fees WHERE batch_id = ?').get(
      before.id,
    ) as { applied_at: string };

    const result = facade.v2Mutate({
      op: 'batch_edit',
      payload: {
        batchId: before.id,
        planTransportDate: '2026-08-12',
        transportCompany: '新公司',
        budgetPrice: '13000',
        dealPrice: '12500',
      },
    });
    expect(result.changed).toMatchObject({ projectId, batchId: before.id });
    expect(result.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );

    const after = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(after).toMatchObject({
      planTransportDate: '2026-08-12',
      transportCompany: '新公司',
      originalPrice: '13000.00',
      discountedPrice: '12500.00',
    });

    const fee = prepareReadBigInt(
      db,
      'SELECT applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents FROM logistics_fees WHERE batch_id = ?',
    ).get(before.id) as {
      applied_at: string;
      budget_price_cents: bigint;
      deal_price_cents: bigint;
      logistics_cost_cents: bigint;
    };
    // 未提交 appliedAt → 保持原值；dealPrice 同时覆盖 dealPriceCents 与 logisticsCostCents
    expect(fee.applied_at).toBe(appliedAtBefore.applied_at);
    expect(fee.applied_at).toBe('2026-08-09');
    // dealPrice 同时覆盖 dealPriceCents 与 logisticsCostCents（物流成交价即最终实际费用）
    expect(fee.budget_price_cents).toBe(1300000n);
    expect(fee.deal_price_cents).toBe(1250000n);
    expect(fee.logistics_cost_cents).toBe(1250000n);
  });

  it('batch_edit 可修改/清空 appliedAt（影响报表归属月份），行 DTO 实时反映', async () => {
    const { facade, db } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '批次日期客户' }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' } },
    });
    const batchRow = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(batchRow.appliedAt).toBe('2026-08-09');

    // 修改 appliedAt：行 DTO 与费用记录同步更新
    facade.v2Mutate({ op: 'batch_edit', payload: { batchId: batchRow.id, appliedAt: '2026-08-15' } });
    const modified = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(modified.appliedAt).toBe('2026-08-15');
    expect(prepareReadBigInt(db, 'SELECT applied_at FROM logistics_fees WHERE batch_id = ?').get(batchRow.id)).toMatchObject({
      applied_at: '2026-08-15',
    });

    // 清空 appliedAt：null
    facade.v2Mutate({ op: 'batch_edit', payload: { batchId: batchRow.id, appliedAt: null } });
    const cleared = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(cleared.appliedAt).toBeNull();
    expect(prepareReadBigInt(db, 'SELECT applied_at FROM logistics_fees WHERE batch_id = ?').get(batchRow.id)).toMatchObject({
      applied_at: null,
    });
  });

  it('batch_edit 历史批次无 fee：编辑价格按需创建部分费用，仅批次字段不虚构费用', async () => {
    const { facade, db, accountId } = await makeFacade();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '历史批次客户' }),
    });
    const projectId = projectIdOf(created);

    // 构造历史批次：仅有批次报价、无物流费用记录（旧数据形态）
    const actor = { accountId, username: '负责人' };
    const service = new ExecutionService(
      new SqliteBatchRepository(db),
      new SqliteInstrumentRepository(db),
      new SqliteBatchChangeHistoryRepository(db),
      new SqliteActivityRepository(db),
      new SqliteActivityEngineerRepository(db),
      new SqliteWorkFactRepository(db),
      new SqliteLogisticsFeeRepository(db),
      { onExecutionStarted: () => undefined },
    );
    const batch = service.createBatch(projectId, actor);
    service.updateBatchQuote(
      batch.id,
      { planTransportDate: '2026-08-10', transportCompany: '历史运输', originalPriceCents: 1200000n, discountedPriceCents: 1100000n },
      actor,
    );

    // 编辑价格：缺 fee 按需创建部分费用（含 appliedAt 补录），成交价与实际费用同步
    facade.v2Mutate({
      op: 'batch_edit',
      payload: { batchId: batch.id, appliedAt: '2026-08-09', budgetPrice: '13000', dealPrice: '12500' },
    });
    const fee = prepareReadBigInt(
      db,
      'SELECT applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents FROM logistics_fees WHERE batch_id = ?',
    ).get(batch.id) as {
      applied_at: string | null;
      budget_price_cents: bigint | null;
      deal_price_cents: bigint | null;
      logistics_cost_cents: bigint | null;
    };
    expect(fee.applied_at).toBe('2026-08-09');
    expect(fee.budget_price_cents).toBe(1300000n);
    expect(fee.deal_price_cents).toBe(1250000n);
    expect(fee.logistics_cost_cents).toBe(1250000n); // 成交价与实际费用同步
    const afterCreate = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(afterCreate.originalPrice).toBe('13000.00');
    expect(afterCreate.discountedPrice).toBe('12500.00');
    expect(afterCreate.appliedAt).toBe('2026-08-09');

    // 仅批次字段（计划运输日期/运输公司）编辑：不虚构费用记录
    const feeCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get(batch.id) as { n: number }).n;
    facade.v2Mutate({ op: 'batch_edit', payload: { batchId: batch.id, planTransportDate: '2026-08-15', transportCompany: '新运输' } });
    const edited = facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as Extract<
      WorkbenchV2SectionRow,
      { kind: 'batches' }
    >;
    expect(edited).toMatchObject({ planTransportDate: '2026-08-15', transportCompany: '新运输', originalPrice: '13000.00' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get(batch.id) as { n: number }).n).toBe(feeCountBefore);
  });

  it('batch_edit 不存在的批次明确报错', async () => {
    const { facade } = await makeFacade();
    expect(() =>
      facade.v2Mutate({ op: 'batch_edit', payload: { batchId: 'no-such-batch', planTransportDate: '2026-08-12' } }),
    ).toThrow(/搬迁批次不存在/);
  });
});
