import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade, INSTRUMENT_BULK_IMPORT_MAX_ROWS } from '../../src/main/workbench-facade';
import { WIZARD_REJECTION_CODES, type ProjectWizardPayload } from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 本批次已确认语义的后端/契约/持久化聚焦测试：
 * - 新建 payload 用 instrumentCount（正整数）不生成虚拟仪器；计划装机完成日期独立字段；
 * - 合同起止日期可空/可清除；supplement_project 原子补齐全部可后补字段 + 可选正式进单；
 * - instrument_bulk_import：5 列 append、整批事务、名称必填、payload 内及库内序列号重复报错；
 * - damage_update 复用领域方法（TBD-15 processing 语义）；
 * - 项目页 repair:'open' 伪筛选 + overview 开放维修项目数（SQL EXISTS 与 repairsPending 同口径）；
 * - 服务单快速动作从项目客户读取 customerName；物流成交价允许 0。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

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

async function makeFacade(): Promise<{ facade: WorkbenchFacade; db: import('node:sqlite').DatabaseSync; projectId: string }> {
  const dir = makeTempDir('new-batch-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  const created = facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '新批次客户', ecc: 'ECC-NEW-001', contractAmount: '100000' }) });
  return { facade, db, projectId: created.changed!.projectId! };
}

describe('新建项目：instrumentCount 正整数 + 计划装机完成日期独立字段', () => {
  it('create_project 用 instrumentCount：记录暂定数量、确认搬迁范围，不生成虚拟仪器', async () => {
    const { facade, projectId } = await makeFacade();
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentCount).toBe(1);
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.counts.instruments).toBe(0); // 不生成虚拟仪器
    expect(project.formallyEntered).toBe(true);
    expect(detail.siteConfirmed).toBe(false);
  });

  it('instrumentCount 提供非正整数被拒且不落库；未提供/0 不再必填', async () => {
    const dir = makeTempDir('new-batch-count-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    // 提供了但非法（0/负数/小数）→ 拒绝
    for (const instrumentCount of [0, -1, 1.5]) {
      expect(() =>
        facade.v2Mutate({ op: 'create_project', payload: wizard({ instrumentCount: instrumentCount as never }) }),
      ).toThrow(/instrumentCount/);
    }
    expect(facade.v2Overview().metrics.totalProjects).toBe(0);
    // 未提供 → 允许（不确认搬迁范围；正式进单不再要求搬迁范围）
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ customerName: '未提供数量客户', ecc: 'ECC-NO-COUNT', contractAmount: '1000', instrumentCount: undefined as never }),
    });
    const detail = facade.v2ProjectDetail(created.changed!.projectId!);
    expect(detail.detail!.temporaryInstrumentCount).toBeNull();
    expect(detail.project!.formallyEntered).toBe(true);
  });

  it('计划装机完成日期：可随新建/补齐/更新写入，且不触发生命周期', async () => {
    // 随新建写入
    const dir = makeTempDir('new-batch-plan-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade2 = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade2.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '计划装机客户',
        ecc: 'ECC-PLAN-001',
        contractAmount: '1000',
        plannedInstallDoneAt: '2026-08-20',
      }),
    });
    let detail = facade2.v2ProjectDetail(created.changed!.projectId!).detail!;
    expect(detail.plannedInstallDoneAt).toBe('2026-08-20');
    expect(facade2.v2ProjectDetail(created.changed!.projectId!).project!.status).toBe('pending_execution'); // 不触发待验收
    // 通过 update_project 更新并清空
    facade2.v2Mutate({ op: 'update_project', payload: { projectId: created.changed!.projectId!, plannedInstallDoneAt: '2026-09-01' } });
    detail = facade2.v2ProjectDetail(created.changed!.projectId!).detail!;
    expect(detail.plannedInstallDoneAt).toBe('2026-09-01');
    facade2.v2Mutate({ op: 'update_project', payload: { projectId: created.changed!.projectId!, plannedInstallDoneAt: null } });
    detail = facade2.v2ProjectDetail(created.changed!.projectId!).detail!;
    expect(detail.plannedInstallDoneAt).toBeNull();
  });

  it('合同起止日期可空/可清除（update_project：null/空串清空，缺省保持现值）', async () => {
    const { facade, projectId } = await makeFacade();
    // 清空开始日期
    facade.v2Mutate({ op: 'update_project', payload: { projectId, contractStartDate: null } });
    let detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.contractStartDate).toBeNull();
    expect(detail.contractEndDate).toBe('2027-07-31'); // 缺省保持现值
    // 空串同样清空
    facade.v2Mutate({ op: 'update_project', payload: { projectId, contractEndDate: '' } });
    detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.contractEndDate).toBeNull();
    // 单独补回截止不要求开始
    facade.v2Mutate({ op: 'update_project', payload: { projectId, contractEndDate: '2027-06-30' } });
    detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.contractEndDate).toBe('2027-06-30');
    expect(detail.contractStartDate).toBeNull();
    // 补回开始（不早于现有截止）
    facade.v2Mutate({ op: 'update_project', payload: { projectId, contractStartDate: '2027-05-01' } });
    detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.contractStartDate).toBe('2027-05-01');
    // 截止早于开始仍被领域拒绝
    expect(() =>
      facade.v2Mutate({ op: 'update_project', payload: { projectId, contractEndDate: '2027-04-01' } }),
    ).toThrow(/合同截止日期不得早于合同开始日期/);
  });
});

describe('supplement_project：原子补齐全部可后补字段 + 可选正式进单', () => {
  async function makePendingProject(): Promise<{ facade: WorkbenchFacade; projectId: string }> {
    const dir = makeTempDir('new-batch-supp-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        intent: 'pre_entry_execution',
        customerName: '补齐资料客户',
        region: 'South',
        managerApproved: true,
      }),
    });
    return { facade, projectId: created.changed!.projectId! };
  }

  it('补齐资料后正式进单：全部后补字段不创建开单，独立开单动作仍可用', async () => {
    const { facade, projectId } = await makePendingProject();
    let detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.status).toBe('pending_entry');
    expect(detail.formallyEntered).toBe(false);

    const result = facade.v2Mutate({
      op: 'supplement_project',
      payload: {
        projectId,
        oldSiteContact: '旧址王工',
        newSiteContact: '新址李工',
        oldSiteAddress: '旧址路',
        newSiteAddress: '新址路',
        plannedVisitAt: '2026-08-15',
        plannedTransportAt: '2026-08-16',
        plannedInstallDoneAt: '2026-08-25',
        siteConfirmed: true,
        contractAmount: '200000',
        ecc: 'ECC-SUPP-001',
        entryAt: '2026-08-07',
        finalAmount: '200000',
      },
    });
    expect(result.changed?.projectId).toBe(projectId);
    expect(result.invalidated).toContain(`project:${projectId}`);

    detail = facade.v2ProjectDetail(projectId).project!;
    expect(detail.formallyEntered).toBe(true);
    expect(detail.ecc).toBe('ECC-SUPP-001');
    // 无实际完成/验收事实时，正式进单后基线待执行（由负责人后续人工确定主状态）
    expect(detail.status).toBe('pending_execution');
    expect(detail.preEntryExecution).toBe(false); // 正式进单清除未进单先执行标签
    const detailFull = facade.v2ProjectDetail(projectId).detail!;
    expect(detailFull.oldSiteContact).toBe('旧址王工');
    expect(detailFull.newSiteContact).toBe('新址李工');
    expect(detailFull.planVisitAt).toBe('2026-08-15');
    expect(detailFull.planTransportAt).toBe('2026-08-16');
    expect(detailFull.plannedInstallDoneAt).toBe('2026-08-25');
    expect(detailFull.siteConfirmed).toBe(true);
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(0);

    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-SUPP-001', orderedAt: '2026-08-07', engineer: '工程师甲、乙', note: '独立开单' } },
    });
    const order = facade.v2SectionPage({ projectId, kind: 'orders' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'orders' }
    >;
    expect(order.serviceOrderNo).toBe('SO-SUPP-001');
    expect(order.customerName).toBe('补齐资料客户');
    expect(order.engineer).toBe('工程师甲、乙');
    expect(order.note).toBe('独立开单');
  });

  it('supplement 补齐暂定仪器范围（v16）：名称/型号/是否 UPS 落库并回显，不建仪器、不触发正式进单', async () => {
    const { facade, projectId } = await makePendingProject();
    const result = facade.v2Mutate({
      op: 'supplement_project',
      payload: {
        projectId,
        temporaryInstrumentName: '  supplement 仪器 ',
        temporaryInstrumentModel: 'SUP-1',
        temporaryHasUps: true,
      },
    });
    expect(result.changed?.projectId).toBe(projectId);
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentName).toBe('supplement 仪器'); // trim 后保存
    expect(detail.temporaryInstrumentModel).toBe('SUP-1');
    expect(detail.temporaryHasUps).toBe(true);
    // 不创建任何仪器记录；未携带 ECC 不触发正式进单；主状态不变。
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    expect(facade.v2ProjectDetail(projectId).project!.formallyEntered).toBe(false);
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_entry');
  });

  it('supplement 旧开单字段任一有值稳定拒绝，项目与开单均零副作用', async () => {
    const { facade, projectId } = await makePendingProject();
    for (const legacy of [
      { serviceOrderNo: 'SO-SUPP-002' },
      { engineers: '工程师甲' },
      { serviceOrderNote: '旧备注' },
    ]) {
      try {
        facade.v2Mutate({
          op: 'supplement_project',
          payload: { projectId, contractAmount: '10000', ecc: 'ECC-SUPP-002', ...legacy } as never,
        });
      } catch (err) {
        expect((err as { code?: string }).code).toBe(WIZARD_REJECTION_CODES.DEPRECATED_FIELD);
        continue;
      }
      expect.unreachable('应当拒绝旧开单字段');
    }
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(0);
    expect(facade.v2ProjectDetail(projectId).project!.formallyEntered).toBe(false);
    expect(facade.v2ProjectDetail(projectId).project!.preEntryExecution).toBe(true);
  });

  it('supplement 正式进单：合同金额 0 允许（final 保持 null）；未携带 ECC 不触发正式进单', async () => {
    const { facade, projectId } = await makePendingProject();
    // 未携带 ECC → 不触发正式进单（formallyEntered=false），可仅补合同金额
    facade.v2Mutate({
      op: 'supplement_project',
      payload: { projectId, contractAmount: '0' },
    });
    expect(facade.v2ProjectDetail(projectId).project!.formallyEntered).toBe(false);
    // 合同金额 0 + ECC → 正式进单成功、final 保持 null（2.1 更新：不再强制最终可确认金额）
    const result = facade.v2Mutate({
      op: 'supplement_project',
      payload: { projectId, contractAmount: '0', ecc: 'ECC-SUPP-003' },
    });
    expect(result.changed?.projectId).toBe(projectId);
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.formallyEntered).toBe(true);
    expect(project.finalAmount).toBeNull();
    expect(project.status).toBe('pending_execution');
  });

  it('supplement 携带 instrumentCount + ECC 正式进单成功：补齐搬迁范围数量（范围不再强制）', async () => {
    const dir = makeTempDir('new-batch-supp-count-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', customerName: '补数量客户', region: 'North', managerApproved: true }),
    });
    const projectId = created.changed!.projectId!;
    // 模拟"搬迁范围未明确"的存量/导入项目：范围未确认、暂定数量为空。
    db.prepare('UPDATE projects SET scope_confirmed = 0, temporary_instrument_count = NULL WHERE id = ?').run(projectId);
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_entry');

    const result = facade.v2Mutate({
      op: 'supplement_project',
      payload: {
        projectId,
        instrumentCount: 3,
        contractAmount: '100000',
        finalAmount: '100000',
        ecc: 'ECC-SUPP-COUNT',
        entryAt: '2026-08-07',
      },
    });
    expect(result.changed?.projectId).toBe(projectId);
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.temporaryInstrumentCount).toBe(3); // 补齐数量落库
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.formallyEntered).toBe(true); // 正式进单成功（搬迁范围已非强制项）
    expect(project.ecc).toBe('ECC-SUPP-COUNT');
    // 无实际完成事实：正式进单后基线待执行
    expect(project.status).toBe('pending_execution');
  });

  it('supplement 携带 actualInstallDoneAt + ECC：正式进单后按实际装机事实自动待验收（不覆盖领域重算）', async () => {
    const { facade, projectId } = await makePendingProject();
    // 同一事务内先记录实际装机完成事实（顺序在正式进单之前），
    // formalEntry 自动重算应得到 pending_acceptance，不得被无条件覆盖为 pending_execution。
    facade.v2Mutate({
      op: 'supplement_project',
      payload: {
        projectId,
        contractAmount: '100000',
        finalAmount: '100000',
        ecc: 'ECC-SUPP-INSTALL',
        entryAt: '2026-08-07',
        actualInstallDoneAt: '2026-08-05',
      },
    });
    const project = facade.v2ProjectDetail(projectId).project!;
    expect(project.formallyEntered).toBe(true);
    expect(project.status).toBe('pending_acceptance'); // 自动待验收（实际装机完成事实）
    expect(facade.v2ProjectDetail(projectId).detail!.actualInstallDoneAt).toBe('2026-08-05');
  });

  it('supplement 非法数量回滚时 actualInstallDoneAt 一并回滚（整批原子性）', async () => {
    const { facade, projectId } = await makePendingProject();
    expect(() =>
      facade.v2Mutate({
        op: 'supplement_project',
        payload: { projectId, instrumentCount: 0 as never, actualInstallDoneAt: '2026-08-05', contractAmount: '10000', finalAmount: '10000', ecc: 'ECC-SUPP-ATOM' },
      }),
    ).toThrow(/仪器数量必须为大于 0 的整数/);
    const detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.actualInstallDoneAt).toBeNull(); // 实际装机事实未部分写入
    expect(detail.temporaryInstrumentCount).toBe(1);
    expect(facade.v2ProjectDetail(projectId).project!.formallyEntered).toBe(false);
  });

  it('supplement 非法 instrumentCount 整体回滚：数量不落库、正式进单不生效、其余字段不部分写入', async () => {
    const { facade, projectId } = await makePendingProject();
    for (const instrumentCount of [0, -1, 1.5]) {
      expect(() =>
        facade.v2Mutate({
          op: 'supplement_project',
          payload: { projectId, instrumentCount: instrumentCount as never, region: 'West', contractAmount: '10000', finalAmount: '10000', ecc: 'ECC-SUPP-BAD' },
        }),
      ).toThrow(/仪器数量必须为大于 0 的整数/);
      // 整批回滚：数量/区域/进单均未落库
      const detail = facade.v2ProjectDetail(projectId);
      expect(detail.detail!.temporaryInstrumentCount).toBe(1); // 保持创建时的数量
      expect(detail.project!.region).toBe('South'); // 区域未部分写入
      expect(detail.project!.formallyEntered).toBe(false); // 正式进单未生效
      expect(detail.project!.ecc).toBeNull();
    }
  });
});

describe('instrument_bulk_import：5 列 append、整批事务、序列号重复报错', () => {
  it('批量导入 5 列登记（append）：仪器列表追加、返回 importedCount', async () => {
    const { facade, projectId } = await makeFacade();
    // 单条登记一台后批量 append
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '既有仪器', serialNo: 'SN-KEEP' } } });
    const result = facade.v2Mutate({
      op: 'instrument_bulk_import',
      payload: {
        projectId,
        rows: [
          { name: '仪器1', manufacturer: '厂商甲', model: 'M1', serialNo: 'SN-1', serviceLevel: '金牌' },
          { name: ' 仪器2 ', serialNo: 'SN-2' },
          { name: '仪器3' },
        ],
      },
    });
    expect(result.changed).toMatchObject({ projectId, importedCount: 3 });
    const section = facade.v2SectionPage({ projectId, kind: 'instruments' });
    expect(section.total).toBe(4); // 1 既有 + 3 批量（append 不替换）
    const byName = new Map(
      (section.rows as Array<Extract<typeof section.rows[number], { kind: 'instruments' }>>).map((r) => [r.name, r]),
    );
    expect(byName.get('仪器1')).toMatchObject({ manufacturer: '厂商甲', model: 'M1', serialNo: 'SN-1', serviceLevel: '金牌' });
    expect(byName.get('仪器2')).toMatchObject({ serialNo: 'SN-2' });
    expect(byName.get('仪器3')).toMatchObject({ manufacturer: null, serviceLevel: null });
  });

  it('名称必填 / payload 内序列号重复 / 库内序列号重复：明确报错且整批零写入', async () => {
    const { facade, projectId } = await makeFacade();
    // 库内已有一台带序列号仪器
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '库内仪器', serialNo: 'SN-IN-DB' } } });
    const before = facade.v2SectionPage({ projectId, kind: 'instruments' }).total;
    const cases: Array<{ rows: unknown[]; expect: RegExp }> = [
      { rows: [{ name: '仪器A' }, { name: '  ' }], expect: /第 2 行仪器名称/ },
      { rows: [{ name: 'A', serialNo: 'SN-DUP' }, { name: 'B', serialNo: 'SN-DUP' }], expect: /SN-DUP.*第 1 行与第 2 行/ },
      { rows: [{ name: 'C', serialNo: 'SN-IN-DB' }], expect: /SN-IN-DB.*已存在/ },
      { rows: [], expect: /至少需要一行/ },
    ];
    for (const c of cases) {
      expect(() =>
        facade.v2Mutate({ op: 'instrument_bulk_import', payload: { projectId, rows: c.rows as never } }),
      ).toThrow(c.expect);
      expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(before); // 整批零写入
    }
  });

  it('超过单批最大行数被拒，要求拆分分批导入', async () => {
    const { facade, projectId } = await makeFacade();
    const rows = Array.from({ length: INSTRUMENT_BULK_IMPORT_MAX_ROWS + 1 }, (_, i) => ({ name: `仪器${i}` }));
    expect(() =>
      facade.v2Mutate({ op: 'instrument_bulk_import', payload: { projectId, rows } }),
    ).toThrow(new RegExp(`最多 ${INSTRUMENT_BULK_IMPORT_MAX_ROWS} 行`));
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
  });
});

describe('damage_update：复用 updateIssueStatus/setPartStatus/updatePart，processing 语义（TBD-15）', () => {
  async function makeDamageItem(contractAmount: string): Promise<{ facade: WorkbenchFacade; projectId: string; instrumentId: string; damageId: string }> {
    const dir = makeTempDir('new-batch-dmg-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    const created = facade.v2Mutate({
      op: 'create_project',
      payload: wizard({
        customerName: '维修客户',
        ecc: 'ECC-DMG-001',
        contractAmount,
      }),
    });
    const projectId = created.changed!.projectId!;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '维修仪器', serialNo: 'SN-DMG' } } });
    const instrumentId = String(facade.v2SectionPage({ projectId, kind: 'instruments' }).rows[0].id);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '运输磕碰', partNumber: 'PART-1', partQuantity: '1', partAmount: '1000', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-08' } },
    });
    const damageId = String(facade.v2SectionPage({ projectId, kind: 'damage_items' }).rows[0].id);
    return { facade, projectId, instrumentId, damageId };
  }

  it('正常项目：damage_update 更新事项状态/备件状态/备件信息（经领域方法）', async () => {
    const { facade, projectId, damageId } = await makeDamageItem('10000');
    const result = facade.v2Mutate({
      op: 'damage_update',
      damageId,
      issueStatus: 'processing',
      partStatus: 'arrived',
      partNumber: 'PART-1B',
      partQuantity: 2,
      partAmount: '800',
      repairNote: '现场更换主板',
    });
    expect(result.changed?.projectId).toBe(projectId);
    const row = facade.v2SectionPage({ projectId, kind: 'damage_items' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'damage_items' }
    >;
    expect(row.issueStatus).toBe('processing');
    expect(row.partStatus).toBe('arrived');
    expect(row.partNumber).toBe('PART-1B');
    expect(row.partQuantity).toBe(2);
    expect(row.partAmount).toBe('800.00');
    expect(row.repairNote).toBe('现场更换主板');
  });

  it('processing 语义（TBD-15）：合同金额为 0 时拒绝将事项置为 processing/已修复/已使用', async () => {
    const { facade, projectId, damageId } = await makeDamageItem('0');
    expect(() => facade.v2Mutate({ op: 'damage_update', damageId, issueStatus: 'processing' })).toThrow(/补齐正数合同金额/);
    expect(() => facade.v2Mutate({ op: 'damage_update', damageId, issueStatus: 'repaired' })).toThrow(/补齐正数合同金额/);
    expect(() => facade.v2Mutate({ op: 'damage_update', damageId, partStatus: 'used' })).toThrow(/补齐正数合同金额/);
    // 未处理事项仍可登记，未受影响
    const row = facade.v2SectionPage({ projectId, kind: 'damage_items' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'damage_items' }
    >;
    expect(row.issueStatus).toBe('untreated');
  });

  it('damage_update 已关闭未修复必须记录原因；不存在的 id 明确报错', async () => {
    const { facade, projectId, damageId } = await makeDamageItem('10000');
    expect(() => facade.v2Mutate({ op: 'damage_update', damageId, issueStatus: 'closed_unrepaired' })).toThrow(/关闭原因/);
    expect(() => facade.v2Mutate({ op: 'damage_update', damageId: 'no-such', issueStatus: 'processing' })).toThrow(/不存在/);
    // 提供原因后成功
    facade.v2Mutate({ op: 'damage_update', damageId, issueStatus: 'closed_unrepaired', closeReason: '客户放弃维修' });
    const row = facade.v2SectionPage({ projectId, kind: 'damage_items' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'damage_items' }
    >;
    expect(row.issueStatus).toBe('closed_unrepaired');
  });

  it('新增损坏快速动作：issueStatus=closed_unrepaired 同样透传 closeReason（领域校验通过）', async () => {
    const { facade, projectId, instrumentId } = await makeDamageItem('10000');
    // 快速动作登记并直接置为已关闭未修复：closeReason 必须透传（缺失报错、提供则保存）
    expect(() =>
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-2', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'closed_unrepaired', registeredAt: '2026-08-09' } },
      }),
    ).toThrow(/关闭原因/);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-2', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'closed_unrepaired', closeReason: '客户放弃维修', registeredAt: '2026-08-09' } },
    });
    const rows = facade.v2SectionPage({ projectId, kind: 'damage_items' }).rows as Array<Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'damage_items' }
    >>;
    const closed = rows.find((r) => r.partNumber === 'P-2')!;
    expect(closed.issueStatus).toBe('closed_unrepaired');
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(2); // 第一条（无原因）回滚未产生记录
  });
});

describe('项目页 repair:"open" 伪筛选 + overview 开放维修项目数（EXISTS 口径）', () => {
  it('repair:open 过滤存在开放维修事项的项目；概览给出开放维修项目数', async () => {
    const dir = makeTempDir('new-batch-repair-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
    // 项目一：登记开放维修事项；项目二：无维修事项
    const repairProject = facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '维修项目客户', ecc: 'ECC-REP-001', contractAmount: '10000' }) }).changed!.projectId!;
    facade.v2Mutate({ op: 'create_project', payload: wizard({ customerName: '无维修客户', ecc: 'ECC-CLEAN-001', contractAmount: '1000' }) });
    facade.v2Mutate({ op: 'submit_action', projectId: repairProject, action: { type: 'instrument', projectId: repairProject, values: { name: '维修仪器', serialNo: 'SN-REP' } } });
    const instrumentId = String(facade.v2SectionPage({ projectId: repairProject, kind: 'instruments' }).rows[0].id);
    expect(facade.v2ProjectPage({ repair: 'open' }).total).toBe(0); // 尚未登记维修事项

    // 登记开放维修事项（untreated）→ 该项目进入 repair:open
    facade.v2Mutate({
      op: 'submit_action',
      projectId: repairProject,
      action: { type: 'damage', projectId: repairProject, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-1', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-08' } },
    });
    const openPage = facade.v2ProjectPage({ repair: 'open' });
    expect(openPage.total).toBe(1);
    expect(openPage.projects[0].id).toBe(repairProject);
    expect(facade.v2ProjectPage({ repair: 'open' }).projects[0].nonBlocking.repairs).toBe(1); // 与 repairsPending 同口径
    const overview = facade.v2Overview();
    expect(overview.metrics.openRepairProjects).toBe(1);

    // 事项修复后不再属于开放维修 → 移出筛选
    const damageId = String(facade.v2SectionPage({ projectId: repairProject, kind: 'damage_items' }).rows[0].id);
    facade.v2Mutate({ op: 'damage_update', damageId, issueStatus: 'repaired' });
    expect(facade.v2ProjectPage({ repair: 'open' }).total).toBe(0);
    expect(facade.v2Overview().metrics.openRepairProjects).toBe(0);
  });
});

describe('服务单快速动作 customerName 从项目客户读取 + 物流成交价允许 0', () => {
  it('type=order 不传 customerName：四种类型都从项目客户派生客户单位并关联当前项目', async () => {
    const { facade, db, projectId } = await makeFacade();
    // relocation：客户从项目读取，关联 projectId
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-NO-CUSTOMER', orderedAt: '2026-08-11', engineer: '工程师甲' } },
    });
    const order = facade.v2SectionPage({ projectId, kind: 'orders' }).rows[0] as Extract<
      ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number],
      { kind: 'orders' }
    >;
    expect(order.customerName).toBe('新批次客户'); // 从项目客户读取
    expect(order.projectId).toBe(projectId);

    // 其余三类：客户同样从项目客户派生，并归档关联当前项目（仅归档/查询关系，
    // 不进入搬迁生命周期）——DB 中 project_id 为当前项目
    for (const [orderType, no] of [
      ['certification', 'SO-NO-CUST-2'],
      ['parts_by_mail', 'SO-NO-CUST-3'],
      ['pm', 'SO-NO-CUST-4'],
    ] as const) {
      facade.v2Mutate({
        op: 'submit_action',
        projectId,
        action: { type: 'order', projectId, values: { orderType, serviceOrderNo: no, orderedAt: '2026-08-11', engineer: '工程师甲' } },
      });
      const row = db.prepare('SELECT customer_name, project_id FROM service_orders WHERE service_order_no = ?').get(no) as {
        customer_name: string;
        project_id: string | null;
      };
      expect(row.customer_name).toBe('新批次客户'); // 客户从项目读取/派生
      expect(row.project_id).toBe(projectId); // 归档关联当前项目（修复前为 null，被丢弃）
    }
    // 四类开单都显示在该项目 orders section
    const section = facade.v2SectionPage({ projectId, kind: 'orders' });
    expect(section.total).toBe(4);
    const nos = (section.rows as Array<Extract<ReturnType<WorkbenchFacade['v2SectionPage']>['rows'][number], { kind: 'orders' }>>)
      .map((r) => r.serviceOrderNo)
      .sort();
    expect(nos).toEqual(['SO-NO-CUST-2', 'SO-NO-CUST-3', 'SO-NO-CUST-4', 'SO-NO-CUSTOMER']);
    // 项目既无客户又未提供 customerName 时明确报错
    const dir = makeTempDir('new-batch-order-');
    dirs.push(dir);
    const { db: db2 } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db2)).initialize({
      username: '负责人',
      password: 'password1',
    });
    const facade2 = new WorkbenchFacade(db2, () => ({ accountId: account.id, username: account.username }));
    const created = facade2.v2Mutate({ op: 'create_project', payload: wizard({ intent: 'pre_entry_execution', customerName: '无客户关联', region: 'North', managerApproved: true }) });
    const pid2 = created.changed!.projectId!;
    db2.prepare('UPDATE projects SET customer_id = NULL WHERE id = ?').run(pid2);
    expect(() =>
      facade2.v2Mutate({
        op: 'submit_action',
        projectId: pid2,
        action: { type: 'order', projectId: pid2, values: { orderType: 'certification', serviceOrderNo: 'SO-NO-CUST-5', orderedAt: '2026-08-11', engineer: '工程师甲' } },
      }),
    ).toThrow(/客户信息从项目客户读取失败/);
  });

  it('无项目上下文提交非搬迁开单仍独立保存（project_id 为空），工作量不依赖项目', async () => {
    const { facade, db } = await makeFacade();
    // 不带 payload.projectId：独立保存路径（customerName 由调用方提供）
    facade.v2Mutate({
      op: 'submit_action',
      action: { type: 'order', values: { orderType: 'certification', serviceOrderNo: 'SO-IND-001', orderedAt: '2026-08-11', engineer: '工程师甲', customerName: '独立客户' } },
    });
    const row = db.prepare('SELECT project_id, customer_name FROM service_orders WHERE service_order_no = ?').get('SO-IND-001') as {
      project_id: string | null;
      customer_name: string;
    };
    expect(row.project_id).toBeNull(); // 无项目 → 独立保存
    expect(row.customer_name).toBe('独立客户');
    // 归档关联（有项目）与独立保存（无项目）的开单均计入工作量
    facade.v2Mutate({
      op: 'submit_action',
      projectId: facade.v2ProjectPage({}).projects[0]!.id,
      action: { type: 'order', values: { orderType: 'certification', serviceOrderNo: 'SO-IND-002', orderedAt: '2026-08-11', engineer: '工程师乙', customerName: '独立客户乙' } },
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number },
    ).toMatchObject({ n: 2 });
  });

  it('批量快速记录：物流成交价允许 0，预算价仍必须 > 0', async () => {
    const { facade, db, projectId } = await makeFacade();
    const revision = facade.v2Overview().businessRevision;
    for (const dealPrice of ['0', '', '-1']) {
      expect(() => facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { budgetPrice: '12000', dealPrice } } })).toThrow(/已下线/);
    }
    expect(() => facade.v2Mutate({ op: 'batch_edit', payload: { batchId: 'historical', dealPrice: null } })).toThrow(/已下线/);
    expect(facade.v2Overview().businessRevision).toBe(revision);
    expect(db.prepare('SELECT COUNT(*) AS n FROM batches').get()!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees').get()!.n).toBe(0);
  });
});
