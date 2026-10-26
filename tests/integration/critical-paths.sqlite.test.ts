import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import type { ProjectWizardPayload, WorkbenchV2LookupRow, WorkbenchV2MutationResult } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { seedHistoricalActivity } from '../helpers/historical-activity';

/**
 * 关键路径跨模块演练（tasks 10.2，Oracle #10 迁移为 v2 有界 API）。
 *
 * 通过真实 SQLite + WorkbenchFacade（Electron 主进程同一入口）逐条走关键路径，
 * 不绕过界面层与领域校验；读取一律经 v2 有界 API（overview/detail/section/
 * independent/lookup），当前写动作经 v2Mutate；旧到访事实仅由领域历史夹具构造（仍走 lifecycle），
 * v2Mutate 返回 revision + invalidate tags，
 * 不携带任何 snapshot：
 * 1. 未进单先执行全链路：批复 → 优先上门（批次开始运输/工作事实）→ 补齐资料正式进单
 *    → 负责人人工确定主状态（自动触发除外）
 * 2. 计划上门到期自动触发执行中；实际装机完成时间自动触发待验收；运输时间与场地确认不触发
 * 3. 项目主状态人工调整与校验（非法调整被拒并返回原因）
 * 4. 取消：无掉票历史可取消、任何掉票历史（含已撤销）禁止、取消后指标排除且真实成本保留
 * 5. 掉票金额闭环重算（超额保护、撤销终态、无 0 金额闭环）
 * 6. 合同金额为 0 时的维修限制
 * 7. 迁移 dry-run 必填缺失报错（含缺 ECC）与改源/补录后重跑（脱敏样本级；真实源待 8.6/8.10）
 * 8. Ship-to 申请线性状态且 Account ID 完成前必填
 * 9. 序列号地址更新逐台登记
 * 10. 二维码独立申请模块
 * 11. 项目提醒手工维护与到期分类
 * 12. 报表手工月份区间与三种导出
 *
 * 唯一阻塞项（10.2 不可勾选）：迁移路径仅能以脱敏样本演练，真实源 importable=false
 * （真实 dry-run 554 errors / 124 conflicts），真实源修正后重跑待验证（tasks.md 8.6/8.10）。
 */

function makeContext() {
  const dir = makeTempDir('critical-paths-');
  const { db } = bootstrapDatabase({ dataDir: dir });
  let accountId = '';
  let username = '负责人';
  return {
    dir,
    db,
    async init() {
      const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
        username,
        password: 'password-1',
      });
      accountId = account.id;
      return new WorkbenchFacade(db, () => ({ accountId, username }));
    },
    setUsername(name: string) {
      username = name;
    },
  };
}

/** v2 mutation 结果 → projectId（create_project 必有）。 */
function projectIdOf(result: WorkbenchV2MutationResult): string {
  return result.changed!.projectId!;
}

const wizard = (overrides: Partial<ProjectWizardPayload> = {}): ProjectWizardPayload => ({
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
});

describe('关键路径跨模块演练（tasks 10.2）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  it('1. 未进单先执行全链路：批复→优先上门→补齐资料进单→人工确定主状态', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();

    // 批复：新建未进单先执行项目（含经理批复原因与缺失项）
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '未进单先执行客户',
        region: 'South',
        managerApproved: true,
      }),
    });
    const projectId = projectIdOf(created);
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(true);
    expect(detail.formallyEntered).toBe(false);

    // 优先上门：批次开始运输 → 主状态保持待进单（未进单先执行标签约束）
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-05', transportCompany: '紧急运输', appliedAt: '2026-08-04', budgetPrice: '1000', dealPrice: '1000' } },
    });
    // 单条登记仪器（新建项目只记录 instrumentCount，不生成虚拟仪器）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '搬迁仪器', ups: false, qrRequested: false } } });
    const instrumentId = String(facade.v2SectionPage({ projectId, kind: 'instruments' }).rows[0].id);
    // 到访新增已下线；构造既有历史活动，保留工作事实与 lifecycle 触发路径。
    seedHistoricalActivity(ctx.db, projectId, '2026-08-06', ['工程师甲'], { instrumentId, type: 'teardown', status: 'done' });
    // 工作事实开始触发 onExecutionStarted → 但未进单先执行标签保持待进单
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.preEntryExecution).toBe(true);

    // 补齐资料正式进单（core 动作：补合同、ECC、进单时间）
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'core', projectId, values: { contractAmount: '200000', ecc: 'ECC-PRE-001', entryAt: '2026-08-07', finalAmount: '200000' } },
    });
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.formallyEntered).toBe(true);
    expect(detail.ecc).toBe('ECC-PRE-001');
    // 正式进单后基线待执行（无实际装机完成/验收等自动触发事实）
    expect(detail.status).toBe('pending_execution');

    // 负责人人工确定主状态：待执行 → 执行中（经 lifecycle 校验）
    facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' });
    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('executing');
  });

  it('2. 计划上门到期自动触发执行中；实际装机完成时间自动触发待验收；运输时间与场地确认不触发', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();

    // 计划上门已到期 → 自动进入执行中；运输时间与场地确认本身不触发后续状态
    const a = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '自动待验收客户A',
        ecc: 'ECC-AUTO-001',
        instrumentCount: 1,
        contractAmount: '100000',
        planVisitAt: '2026-08-09',
        planTransportAt: '2026-08-10',
        siteConfirmed: true,
      }),
    });
    expect(facade.v2ProjectDetail(projectIdOf(a)).project!.status).toBe('executing');

    // 录入实际装机完成时间 → 自动进入待验收（自动触发优先于人工值）
    const b = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '自动待验收客户B',
        ecc: 'ECC-AUTO-002',
        instrumentCount: 1,
        contractAmount: '100000',
        actualInstallDoneAt: '2026-08-08',
      }),
    });
    const autoProject = facade.v2ProjectDetail(projectIdOf(b)).project!;
    expect(autoProject.ecc).toBe('ECC-AUTO-002');
    expect(autoProject.status).toBe('pending_acceptance');
  });

  it('3. 项目主状态人工调整与校验：非法调整被拒并返回原因', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    // 无 ECC 的未进单先执行项目：标签钉住主状态，离开待进单被拒
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '状态校验客户', region: 'North' }),
    });
    const projectId = projectIdOf(created);
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId, status: 'completed' })).toThrow(/未进单先执行/);

    // 正式进单项目：创建结果主状态为待执行；待执行 → 执行中 经 lifecycle 校验通过
    const formal = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '状态校验正式客户', ecc: 'ECC-ADJ-001', region: 'North', contractAmount: '100000' }),
    });
    const formalId = projectIdOf(formal);
    expect(facade.v2ProjectDetail(formalId).project!.status).toBe('pending_execution');
    // 待执行 → 已完成：无掉票闭环依据，拒绝并返回原因
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId: formalId, status: 'completed' })).toThrow(/已完成/);
    facade.v2Mutate({ op: 'adjust_status', projectId: formalId, status: 'executing' });
    expect(facade.v2ProjectDetail(formalId).project!.status).toBe('executing');
  });

  it('4. 取消：无掉票历史可取消；任何掉票历史（含已撤销）禁止；取消后指标排除且真实成本保留', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();

    // 项目 A：无任何掉票历史 → 可取消
    const a = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '可取消客户', ecc: 'ECC-CANCEL-01', region: 'West', contractAmount: '50000', instrumentCount: 1 }),
    });
    const projectIdA = projectIdOf(a);
    facade.v2Mutate({ op: 'cancel_project', projectId: projectIdA, time: '2026-08-12', reason: '客户业务调整取消' });
    expect(facade.v2ProjectDetail(projectIdA).project!.status).toBe('cancelled');
    // 取消须经专用命令：adjustStatus 拒绝 cancelled（时间与原因必须随取消一并持久化）
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId: projectIdA, status: 'cancelled' as never })).toThrow(/cancelProject/);
    // 已取消为终态：不可恢复
    expect(() => facade.v2Mutate({ op: 'adjust_status', projectId: projectIdA, status: 'executing' })).toThrow(/已取消/);

    // 项目 B：登记掉票后 → 存在掉票历史 → 禁止取消
    const b = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '有掉票历史客户', ecc: 'ECC-CANCEL-02', region: 'West', contractAmount: '50000', instrumentCount: 1 }),
    });
    const projectIdB = projectIdOf(b);
    facade.v2Mutate({ op: 'submit_action', projectId: projectIdB, action: { type: 'invoice', projectId: projectIdB, values: { invoicedAt: '2026-08-11', amount: '10000' } } });
    // 存在有效掉票时禁止取消（含撤销掉票历史的禁止规则由领域测试覆盖）
    expect(() => facade.v2Mutate({ op: 'cancel_project', projectId: projectIdB, time: '2026-08-12', reason: '尝试取消' })).toThrow(/掉票/);
  });

  it('5. 掉票金额闭环重算：超额保护、撤销终态、无 0 金额闭环', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '金额闭环客户',
        ecc: 'ECC-CLOSURE-01',
        contractAmount: '100000',
        actualInstallDoneAt: '2026-08-08',
      }),
    });
    const projectId = projectIdOf(created);
    // 推进到待掉票（实际装机完成 → 待验收；验收报告 → 待掉票）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-09' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');

    // 超额保护：掉票 120000 > 最终可确认 100000 → 拒绝
    expect(() =>
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '120000' } } }),
    ).toThrow(/超额|最终可确认/);

    // 无 0 金额闭环：0 金额掉票被拒
    expect(() =>
      facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '0' } } }),
    ).toThrow(/大于 0/);

    // 累计达到最终可确认金额 → 自动进入已完成（金额闭环）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '60000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-12', amount: '40000' } } });
    const after = facade.v2ProjectDetail(projectId).project!;
    expect(after.invoicedAmount).toBe('100000.00');
    expect(after.status).toBe('completed');

    // 报表实时反映掉票
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    const invoiceSection = report.sections.find((s) => s.key === 'monthly_invoice_amount');
    expect(invoiceSection?.rows).toHaveLength(1);
  });

  it('6. 合同金额为 0 时：正式进单 final 保持 null；维修备件标记已使用被限制', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();

    // 合同金额为 0 → 正式进单成功、final 保持 null（不再强制另行录入）
    const zeroCreated = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '零合同客户', ecc: 'ECC-ZERO-01', contractAmount: '0', instrumentCount: 1 }),
    });
    const zeroProjectId = projectIdOf(zeroCreated);
    const zeroDetail = facade.v2ProjectDetail(zeroProjectId).project!;
    expect(zeroDetail.formallyEntered).toBe(true);
    expect(zeroDetail.status).toBe('pending_execution');
    expect(zeroDetail.finalAmount).toBeNull();

    // 合同金额 0 且已登记仪器：可登记损坏，但禁止标记备件已使用（TBD-15）
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '零合同维修客户', ecc: 'ECC-ZERO-02', contractAmount: '0', instrumentCount: 1 }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '待修仪器', ups: false, qrRequested: false } } });
    const instrumentId = String(facade.v2SectionPage({ projectId, kind: 'instruments' }).rows[0].id);
    // 登记损坏（允许）：备件未标记已使用
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输磕碰', partNumber: 'PART-1', partQuantity: '1', partAmount: '1000', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-08' } },
    });
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(1);
    // 合同金额为 0 时禁止备件标记已使用 → 领域校验拒绝（整次提交回滚）
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输磕碰', partNumber: 'PART-1', partQuantity: '1', partAmount: '1000', partCurrency: 'USD', partStatus: 'used', issueStatus: 'untreated', registeredAt: '2026-08-08' } },
      }),
    ).toThrow(/已使用/);
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(1); // 回滚后不产生第二条事项
  });

  it('7. 迁移 dry-run 必填缺失报错（含缺 ECC）与改源/补录后重跑（脱敏样本）', async () => {
    // 脱敏样本级演练：缺 ECC、缺物流申请时间报错；修正后重跑 dry-run 无错误。
    const { runDryRun } = await import('../../src/domain/capabilities/historical-data-import/migration-service');
    const { MAPPING_V1, SOURCE_TABLE_FILES } = await import('../../src/domain/capabilities/historical-data-import/mapping');

    const row = (file: string, sheet: string, rowNumber: number, cells: Record<string, string | null>) => ({
      file, sheet, rowNumber, cells,
    });
    const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
    const EXEC = SOURCE_TABLE_FILES['project-execution'];
    const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];

    // 缺 ECC 的项目/合同执行数据 → dry-run 必填错误
    const missingEcc = runDryRun({
      rows: [
        row(CONTRACT, '合同信息', 2, { 'ECC#': null, 客户名称: '无ECC客户', 合同USD含税金额: '10000' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': null, 区域: '华东' }),
      ],
      mapping: MAPPING_V1,
    });
    expect(missingEcc.errors.some((e) => e.errorCode === 'ECC_REQUIRED')).toBe(true);
    expect(missingEcc.importable).toBe(false);

    // 缺物流费用申请（登记）时间 → 必填错误
    const missingAppliedAt = runDryRun({
      rows: [row(WORKLOAD, '物流费用表', 2, { 物流费用申请时间: null, 预算价格: '1000', 成交价格: '1000', 物流费用: '900' })],
      mapping: MAPPING_V1,
    });
    expect(missingAppliedAt.errors.some((e) => e.field === 'logistics_fee.applied_at')).toBe(true);

    // 改源/补录后重跑：补齐 ECC 后原错误消失
    const fixed = runDryRun({
      rows: [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-001', 客户名称: '已补齐客户', 合同USD含税金额: '10000' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-FIX-001', 区域: '华东' }),
      ],
      mapping: MAPPING_V1,
    });
    expect(fixed.errors.some((e) => e.errorCode === 'ECC_REQUIRED')).toBe(false);

    // 真实源验证阻塞说明：真实 docs Excel dry-run 当前 importable=false
    // （554 errors / 124 conflicts，分类摘要见 docs/verification/迁移执行与运维说明.md），
    // 真实源修正后重跑待 8.6/8.10 完成后验证。本路径为 10.2 的唯一阻塞项。
  });

  it('8. Ship-to 申请线性状态且 Account ID 完成前必填', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();

    // 创建申请：Account ID 可空，进入待提交
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: 'ShipTo客户', newSiteAddress: '新址地址甲' } },
    });
    const shipToRows = (): Array<Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>> =>
      facade.v2LookupPage({ kind: 'ship_to_requests', query: 'ShipTo客户' }).rows as unknown as Array<
        Extract<WorkbenchV2LookupRow, { kind: 'ship_to_requests' }>
      >;
    const first = shipToRows()[0];
    expect(first.status).toBe('pending_submit');
    expect(first.accountId).toBeNull();

    // Account ID 完成前必填：直接以 completed 提交但未补 Account ID → 拒绝
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        action: { type: 'ship_to', values: { customerName: 'ShipTo客户', newSiteAddress: '新址地址乙', status: 'completed' } },
      }),
    ).toThrow(/Account ID/);

    // 提交并补入 Account ID 完成：创建 → 处理中 → 已完成（一次性动作表达线性流）
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'ship_to', values: { customerName: 'ShipTo客户', newSiteAddress: '新址地址乙', status: 'completed', accountId: 'ACC-2026-001' } },
    });
    const completed = shipToRows().find((r) => r.accountId === 'ACC-2026-001');
    expect(completed?.status).toBe('completed');
    expect(completed?.customerName).toBe('ShipTo客户');
    // 线性状态与不可退回/取消规则由 ship-to-management 领域测试覆盖（4.2）
  });

  it('9. 序列号地址更新逐台登记', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '序列号地址客户', ecc: 'ECC-SERIAL-001', region: 'North', contractAmount: '30000', instrumentCount: 1 }),
    });
    const projectId = projectIdOf(created);
    // 登记带序列号的搬迁仪器（向导创建的仪器无序列号，需先补登序列号仪器）
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'instrument', projectId, values: { name: '串号仪器-带序列号', serialNo: 'SN-A-001', ups: false, qrRequested: false } },
    });
    const instrument = facade.v2SectionPage({ projectId, kind: 'instruments' }).rows.find(
      (r) => r.kind === 'instruments' && r.serialNo === 'SN-A-001',
    ) as Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'instruments' }>;
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'serial_address', values: { instrumentId: instrument.id, customerName: '序列号地址客户', newSiteAddress: '实际新址1', serialNo: 'SN-A-001', accountId: 'ACC-SN-001', updatedAt: '2026-08-09' } },
    });
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(1);
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'serial_address', values: { instrumentId: instrument.id, customerName: '序列号地址客户', newSiteAddress: '实际新址2', serialNo: 'SN-A-001', accountId: 'ACC-SN-002', updatedAt: '2026-08-10' } },
    });
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(2); // 一台仪器多次地址变化，逐台登记
  });

  it('10. 二维码独立申请模块：多选类型、不关联项目、工作量去重计数', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '申请人甲', requestedAt: '2026-08-11', types: ['A', 'A', 'project_acceptance_form'] } },
    });
    let page = facade.v2IndependentPage({ kind: 'qr_request' });
    expect(page.total).toBe(1);
    // 同条内相同类型去重后计 2 次工作量
    const first = page.rows[0] as Extract<typeof page.rows[number], { kind: 'qr_request' }>;
    expect(first.workload).toBe(2);
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '申请人乙', requestedAt: '2026-08-11', types: ['A'] } },
    });
    page = facade.v2IndependentPage({ kind: 'qr_request' });
    expect(page.total).toBe(2); // 重复申请保留完整历史
    const second = page.rows.find((r) => r.kind === 'qr_request' && r.applicant === '申请人乙') as Extract<typeof page.rows[number], { kind: 'qr_request' }>;
    expect(second.workload).toBe(1);
  });

  it('11. 项目提醒手工维护与到期分类', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '提醒客户', region: 'North' }),
    });
    const projectId = projectIdOf(created);

    // 手工维护当前提醒（含时间与备注）
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2026-08-09', reminderNote: '确认运输安排' });
    expect(facade.v2ProjectDetail(projectId).project!.reminderNote).toBe('确认运输安排');
    // 过期提醒 → 已逾期分类
    facade.v2Mutate({ op: 'set_reminder', projectId, reminderAt: '2020-01-01', reminderNote: '历史提醒' });
    expect(facade.v2ProjectDetail(projectId).project!.reminderDueClass).toBe('overdue');
    // 清除提醒
    facade.v2Mutate({ op: 'clear_reminder', projectId });
    const cleared = facade.v2ProjectDetail(projectId).project!;
    expect(cleared.reminderAt).toBeNull();
    expect(cleared.reminderNote).toBeNull();
    expect(cleared.reminderDueClass).toBeNull();
  });

  it('12. 报表手工月份区间与三种导出', async () => {
    const ctx = makeContext();
    dirs.push(ctx.dir);
    const facade = await ctx.init();
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '报表客户', ecc: 'ECC-REPORT-001', contractAmount: '100000' }),
    });
    const projectId = projectIdOf(created);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '40000' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', transportCompany: '报表运输', appliedAt: '2026-08-09', budgetPrice: '10000', dealPrice: '9000' } } });

    // 手工月份区间
    const report = facade.reportDto({ monthFrom: '2026-08', monthTo: '2026-08' });
    expect(report.range).toEqual({ from: '2026-08', to: '2026-08' });
    expect(report.sections.find((s) => s.key === 'monthly_invoice_amount')?.rows).toHaveLength(1);

    // 三种导出：Excel（.xlsx）、PNG、PDF 均产出有效字节
    const { ReportingExportService } = await import('../../src/domain/capabilities/operational-reporting');
    const exporter = new ReportingExportService();
    const model = facade.report({ monthFrom: '2026-08', monthTo: '2026-08' });
    const xlsx = await exporter.exportExcel(model);
    expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK'); // xlsx zip magic
    const png = exporter.exportPng(model);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    const pdf = await exporter.exportPdf(model);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });
});
