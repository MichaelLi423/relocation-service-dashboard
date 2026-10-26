import { seedHistoricalBatch } from '../helpers/historical-batch';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteActivityRepository,
  SqliteBatchRepository,
  SqliteInstrumentRepository,
  SqliteInvoiceRepository,
  SqliteLogisticsFeeRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence';
import { ValidationError } from '../../src/domain/core/errors';
import type { FinancialClosureService } from '../../src/domain/capabilities/project-financial-closure';
import type { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle';
import { ProtectedExecutionDeletionService } from '../../src/domain/capabilities/relocation-execution';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import {
  WorkbenchDeletePolicies,
  type WorkbenchDeleteContext,
} from '../../src/main/workbench-delete';
import {
  DELETE_REJECTION_CODES,
  type ProjectWizardPayload,
  type WorkbenchV2DeleteRequest,
  type WorkbenchV2MutationResult,
} from '../../src/shared/ipc';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { seedHistoricalActivity } from '../helpers/historical-activity';

/**
 * 受保护登记记录删除（v2Delete，design D3 类型分发 + 阶段 A 审计）：
 * - BEGIN IMMEDIATE 事务内核验 expectedRevision（防 TOCTOU），随后按 kind 分发到
 *   显式 type-specific policy（WorkbenchDeletePolicies），不再有「任意表」通用删除；
 * - 成功删除与最小 tombstone（record_deletion_audit）同事务原子写入；
 *   import_record_audit 保留并标记指向已删除目标（target_deleted_at /
 *   target_delete_operation_id），绝不物理擦除来源审计；拒绝路径全零写；
 * - batch 仅未开始运输/无当前仪器/无改批历史；activity 存在工作事实或维修关联拒绝
 *   （不级联清事实）；damage 仅未处理、备件未使用、无活动关联；completed ship-to 禁止；
 *   instrument 所属批次已开始运输也禁止、且保留其他依赖检查；
 * - acceptance 真正实现：有 invoice 历史拒绝，否则清空验收事实并按事实确定性回退状态；
 * - invoice 映射为撤销（不可物理删除、不写 tombstone）；project 无删除入口。
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
    customerName: '删除测试客户',
    region: 'East',
    oldSiteAddress: '旧址',
    newSiteAddress: '新址',
    instrumentCount: 1,
    siteConfirmed: false,
    ...overrides,
  };
}

async function makeCtx(): Promise<{ facade: WorkbenchFacade; db: DatabaseSync; projectId: string }> {
  const dir = makeTempDir('workbench-delete-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({
    username: '负责人',
    password: 'password1',
  });
  const facade = new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username }));
  const created = facade.v2Mutate({
    op: 'create_project',
    payload: wizard({ customerName: '删除测试客户', ecc: 'ECC-DEL-001', contractAmount: '100000' }),
  });
  const projectId = projectIdOf(created);
  // instrumentCount 只记录数量不生成仪器：显式登记一台仪器供子记录/删除测试使用。
  facade.v2Mutate({
    op: 'submit_action',
    projectId,
    action: { type: 'instrument', projectId, values: { name: '删除测试仪器', serialNo: 'SN-DEL-001', ups: false, qrRequested: false } },
  });
  return { facade, db, projectId };
}

/** 断言抛出 DomainError 且 code 为稳定拒绝码（或 message 匹配 RegExp）。 */
function expectRejected(fn: () => unknown, codeOrPattern: string | RegExp): void {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (codeOrPattern instanceof RegExp) {
      expect(e.message ?? '').toMatch(codeOrPattern);
    } else {
      expect(e.code).toBe(codeOrPattern);
    }
    return;
  }
  expect.unreachable('应当抛出拒绝错误');
}

/**
 * 直接构造 WorkbenchDeletePolicies 上下文（policy 依赖注入）：测试可注入
 * 自定义 projectService 使 clearAcceptance 抛 ACCEPTANCE_STATUS_RECALC_FAILED，
 * 验证 STATUS_RECALC 拒绝路径（生产映射保持稳定）。
 */
function makePolicyContext(db: DatabaseSync, projectService: ProjectService): WorkbenchDeleteContext {
  const account = db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: string };
  return {
    db,
    actor: () => ({ accountId: account.id, username: '负责人' }),
    parseBusinessDate: (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined),
    repositories: {
      activities: new SqliteActivityRepository(db),
      projects: new SqliteProjectRepository(db),
      batches: new SqliteBatchRepository(db),
      fees: new SqliteLogisticsFeeRepository(db),
      instruments: new SqliteInstrumentRepository(db),
      invoices: new SqliteInvoiceRepository(db),
    },
    projectService: () => projectService,
    financialService: () => ({} as FinancialClosureService),
    serviceOrderService: () => ({} as never),
    damageRepairService: () => ({} as never),
    serialAddressUpdateService: () => ({} as never),
    qrRequestService: () => ({} as never),
    shipToService: () => ({} as never),
  };
}

describe('受保护登记记录删除（v2Delete，ora-1 严格守卫）', () => {
  it('执行领域删除入口拥有活动依赖检查及工程师子记录清理，facade 仅协调审计', async () => {
    const ctx = await makeCtx();
    const { db, projectId } = ctx;
    seedHistoricalActivity(db, projectId, '2026-08-13', ['工程师甲', '工程师乙']);
    const activityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    const executionDeletes = new ProtectedExecutionDeletionService(
      db,
      new SqliteActivityRepository(db),
      new SqliteBatchRepository(db),
      new SqliteInstrumentRepository(db),
      new SqliteLogisticsFeeRepository(db),
    );

    expect(executionDeletes.deleteActivity(activityId)).toMatchObject({ projectId, ownedChildCount: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get(activityId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_engineers WHERE activity_id = ?').get(activityId)!.n).toBe(0);
    // 领域入口本身不拥有工作台 tombstone；经 facade 的删除路径才写审计协调事实。
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit').get()!.n).toBe(0);
  });

  it('expectedRevision 不匹配当前业务修订时整体拒绝且不写库（事务内核验）', async () => {
    const ctx = await makeCtx();
    const revision = readBusinessRevision(ctx.db);
    // 写一次改变 revision
    ctx.facade.v2Mutate({ op: 'set_reminder', projectId: ctx.projectId, reminderAt: '2026-08-09', reminderNote: 'x' });
    const after = readBusinessRevision(ctx.db);
    expect(after).toBeGreaterThan(revision);
    expectRejected(
      () => ctx.facade.v2Delete({ kind: 'qr_request', id: 'whatever', expectedRevision: revision }),
      DELETE_REJECTION_CODES.REVISION_MISMATCH,
    );
    expect(readBusinessRevision(ctx.db)).toBe(after);
  });

  it('service_order 删除成功：行删除 + 来源审计保留并标记 + tombstone 原子写入 + invalidate 标签', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-DEL-001', orderedAt: '2026-08-11', engineer: '工程师甲' } },
    });
    const orderId = String(db.prepare('SELECT id FROM service_orders WHERE service_order_no = ?').get('SO-DEL-001')!.id);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-so', 'so-1', 'service_orders', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(orderId);

    const revision = readBusinessRevision(db);
    const result = facade.v2Delete({ kind: 'service_order', id: orderId, expectedRevision: revision });
    expect(result.changed).toMatchObject({ kind: 'service_order', id: orderId, projectId });
    expect(result.invalidated).toContain(`project:${projectId}`);
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(0);
    // 来源审计保留（不物理删除）且标记指向已删除目标
    const audit = db.prepare('SELECT * FROM import_record_audit WHERE id = ?').get('audit-so') as {
      target_table: string;
      target_id: string;
      target_deleted_at: string | null;
      target_delete_operation_id: string | null;
    };
    expect(audit).toBeDefined();
    expect(audit.target_table).toBe('service_orders');
    expect(audit.target_id).toBe(orderId);
    expect(audit.target_deleted_at).not.toBeNull();
    expect(audit.target_delete_operation_id).not.toBeNull();
    // 最小 tombstone 同事务原子写入：record_type/record_id/owned_child_count/操作者/operation_id 关联
    const tomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('service_order', orderId) as {
      operation_id: string;
      owned_child_count: number;
      actor_username_snapshot: string | null;
      deleted_at: string | null;
    };
    expect(tomb).toBeDefined();
    expect(tomb.owned_child_count).toBe(0);
    expect(tomb.actor_username_snapshot).toBe('负责人');
    expect(tomb.deleted_at).not.toBeNull();
    expect(tomb.operation_id).toBe(audit.target_delete_operation_id);
  });

  it('activity：存在工作事实 → 拒绝（不级联清事实）；空活动（无事实/无维修关联）→ 删除成功', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 有工作事实的活动 → 拒绝
    seedHistoricalActivity(db, projectId, '2026-08-12', ['工程师甲'], { instrumentId, type: 'teardown', status: 'done' });
    const factActivityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    expectRejected(
      () => facade.v2Delete({ kind: 'activity', id: factActivityId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 工作事实未被级联删除
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_facts WHERE activity_id = ?').get(factActivityId)!.n).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'activities' }).total).toBe(1);

    // 空活动（无工作事实、无维修关联）→ 删除成功（参与工程师属活动记录，随活动删除）
    seedHistoricalActivity(db, projectId, '2026-08-13', ['工程师甲', '工程师乙']);
    const emptyActivityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ? AND id <> ?').get(projectId, factActivityId)!.id);
    const result = facade.v2Delete({ kind: 'activity', id: emptyActivityId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('activity');
    expect(facade.v2SectionPage({ projectId, kind: 'activities' }).total).toBe(1); // 仅剩有工作事实的活动
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_engineers WHERE activity_id = ?').get(emptyActivityId)!.n).toBe(0);
  });

  it('acceptance：有 invoice 历史拒绝；无 invoice 时清空验收事实并按事实确定性回退状态', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 无掉票历史 → 删除验收 → 回退到正式进单基线（pending_execution）
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');
    const result = facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed).toMatchObject({ kind: 'acceptance', id: projectId, projectId });
    let detail = facade.v2ProjectDetail(projectId).detail!;
    expect(detail.acceptanceReport).toBe(false);
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_execution'); // 无实际装机/执行事实 → 正式进单基线

    // 已实际装机完成 → 回退到待验收
    const ctx2 = await makeCtx();
    const p2 = ctx2.projectId;
    ctx2.facade.v2Mutate({ op: 'submit_action', projectId: p2, action: { type: 'acceptance', projectId: p2, values: { reportDate: '2026-08-15' } } });
    ctx2.db.prepare('UPDATE projects SET actual_install_done_at = ? WHERE id = ?').run('2026-08-10', p2);
    ctx2.facade.v2Delete({ kind: 'acceptance', projectId: p2, expectedRevision: readBusinessRevision(ctx2.db) });
    expect(ctx2.facade.v2ProjectDetail(p2).project!.status).toBe('pending_acceptance');

    // 有掉票历史（含已撤销）→ 拒绝，验收事实保留
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-20' } } });
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-21', amount: '1000' } } });
    expectRejected(
      () => facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(facade.v2ProjectDetail(projectId).detail!.acceptanceReport).toBe(true);
  });

  it('acceptance：删除引起真实状态变化写 transition audit（source=user）；零变化不写', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_invoice');

    // 真实状态变化：待掉票 → 待执行（正式进单基线，无实际装机/执行事实）→ 写审计
    facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2ProjectDetail(projectId).project!.status).toBe('pending_execution');
    const audits = db.prepare('SELECT * FROM project_status_transition_audit').all() as Array<
      Record<string, unknown>
    >;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      project_id: projectId,
      from_status: 'pending_invoice',
      to_status: 'pending_execution',
      reason: 'acceptance_deleted',
      source: 'user',
    });
    expect(audits[0].effective_business_date).toBeTruthy();
    expect(audits[0].actor_username_snapshot).toBe('负责人');

    // 零变化：未进单先执行项目验收报告删除保持待进单 → 不写审计
    const dir2 = makeTempDir('workbench-delete-zero-');
    dirs.push(dir2);
    const { db: db2 } = bootstrapDatabase({ dataDir: dir2 });
    const { account: account2 } = await new LocalAccountService(new SqliteAccountRepository(db2)).initialize({
      username: '负责人2',
      password: 'password1',
    });
    const facade2 = new WorkbenchFacade(db2, () => ({ accountId: account2.id, username: account2.username }));
    const created2 = facade2.v2Mutate({
      op: 'create_project',
      payload: wizard({ intent: 'pre_entry_execution', managerApproved: true, customerName: '零变化客户' }),
    });
    const p2 = projectIdOf(created2);
    facade2.v2Mutate({ op: 'submit_action', projectId: p2, action: { type: 'acceptance', projectId: p2, values: { reportDate: '2026-08-15' } } });
    expect(facade2.v2ProjectDetail(p2).project!.status).toBe('pending_entry'); // 标签保持待进单
    facade2.v2Delete({ kind: 'acceptance', projectId: p2, expectedRevision: readBusinessRevision(db2) });
    expect(facade2.v2ProjectDetail(p2).project!.status).toBe('pending_entry');
    expect(db2.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get()!.n).toBe(0);
  });

  it('acceptance：lifecycle 重算不可靠（stub clearAcceptance 抛 ACCEPTANCE_STATUS_RECALC_FAILED）→ STATUS_RECALC 拒绝且零写', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    expect(facade.v2ProjectDetail(projectId).detail!.acceptanceReport).toBe(true);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-acc-stub', 'a-stub', 'projects', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(projectId);
    const revisionBefore = readBusinessRevision(db);

    // policy 依赖注入：stub projectService 使 clearAcceptance 抛重算失败。
    const failingService = {
      clearAcceptance: () => {
        throw new ValidationError('ACCEPTANCE_STATUS_RECALC_FAILED', '重算失败（测试注入）');
      },
    } as unknown as ProjectService;
    const policies = new WorkbenchDeletePolicies(makePolicyContext(db, failingService));
    expectRejected(
      () => policies.execute({ kind: 'acceptance', projectId, expectedRevision: revisionBefore }),
      DELETE_REJECTION_CODES.STATUS_RECALC_UNRELIABLE,
    );
    // 业务行零写：验收事实保留、主状态不变
    expect(db.prepare('SELECT acceptance_report, status FROM projects WHERE id = ?').get(projectId)).toMatchObject({
      acceptance_report: 1,
      status: 'pending_invoice',
    });
    // tombstone 零写
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit').get()!.n).toBe(0);
    // import marker 零写（来源审计原样保留、无删除标记）
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE id = ? AND target_deleted_at IS NULL').get('audit-acc-stub')!.n).toBe(1);
    // revision 零写
    expect(readBusinessRevision(db)).toBe(revisionBefore);
  });

  it('activity：存在维修上门活动关联（downstream fact）→ 事务内 DEPENDENCIES 拒绝且零写', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    // 空活动（无工作事实）+ 一条指向它的维修关联
    seedHistoricalActivity(db, projectId, '2026-08-13', ['工程师甲']);
    const activityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-L', partQuantity: '1', partAmount: '10', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-12' } },
    });
    const damageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ?').get(projectId)!.id);
    db.prepare('INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)').run('link-act', activityId, damageId, 't');

    const revision = readBusinessRevision(db);
    expectRejected(
      () => facade.v2Delete({ kind: 'activity', id: activityId, expectedRevision: revision }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 拒绝零写：活动/事项/关联均保留
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get(activityId)!.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links WHERE id = ?').get('link-act')!.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit').get()!.n).toBe(0);
    expect(readBusinessRevision(db)).toBe(revision);
  });

  it('activity：可删除活动（无 work/downstream facts）删除后项目主状态不变且不写 transition audit', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    // 项目进入执行中（人工调整，不经活动承载状态事实）
    facade.v2Mutate({ op: 'adjust_status', projectId, status: 'executing' });
    expect(String(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)!.status)).toBe('executing');
    // 空活动（无工作事实/维修关联，仅参与工程师）
    seedHistoricalActivity(db, projectId, '2026-08-13', ['工程师甲', '工程师乙']);
    const activityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    const auditsBefore = db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get()!.n;

    const result = facade.v2Delete({ kind: 'activity', id: activityId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('activity');
    // 状态不变：可删除活动仅含参与工程师（非状态相关事实）；「已开始执行」只由
    // work_facts / 批次开始运输驱动，删除空活动不影响该判定 → 无需 lifecycle 重算。
    expect(String(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)!.status)).toBe('executing');
    // 零状态变化 → 不写 transition audit
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get()!.n).toBe(auditsBefore);
  });

  it('5.6 汇总：批次/仪器/开单/验收/Ship-to/损坏/序列号/二维码成功删除后从可观察读取表面消失，tombstone 保留', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // ---- 预置各类型记录 ----
    seedHistoricalBatch(db, projectId, { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' });
    const batchId = String(db.prepare('SELECT id FROM batches WHERE project_id = ?').get(projectId)!.id);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-56', orderedAt: '2026-08-11', engineer: '工程师甲' } } });
    const orderId = String(db.prepare('SELECT id FROM service_orders WHERE service_order_no = ?').get('SO-56')!.id);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'acceptance', projectId, values: { reportDate: '2026-08-15' } } });
    const shipTo = facade.createShipToRequest({ customerName: 'ShipTo 56', newSiteAddress: '新址56' });
    facade.submitShipToRequest(shipTo.request.id);
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-56', partQuantity: '1', partAmount: '10', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-12' } } });
    const damageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ?').get(projectId)!.id);
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-56', null, '独立客户', '新址', 'SN-56', 'ACC-56', '2026-08-10', 't');
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'B'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);

    // ---- 删除前各自可观察 ----
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(1);
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(1);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(1);
    expect(facade.v2ProjectDetail(projectId).detail!.acceptanceReport).toBe(true);
    expect(facade.v2HistoryPage({ kind: 'batch' }).total).toBe(1);

    // ---- 逐个删除（damage 先于 instrument；均无跨记录依赖）----
    facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
    facade.v2Delete({ kind: 'serial_address', id: 'sa-56', expectedRevision: readBusinessRevision(db) });
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(0);
    facade.v2Delete({ kind: 'service_order', id: orderId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).total).toBe(0);
    expect(facade.v2HistoryPage({ kind: 'service_order' }).total).toBe(0);
    facade.v2Delete({ kind: 'damage_repair_item', id: damageId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(0);
    expect(facade.v2HistoryPage({ kind: 'damage' }).total).toBe(0);
    facade.v2Delete({ kind: 'ship_to_request', id: shipTo.request.id, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(0);
    expect(facade.v2HistoryPage({ kind: 'ship_to_request' }).total).toBe(0);
    facade.v2Delete({ kind: 'batch', id: batchId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(0);
    expect(facade.v2HistoryPage({ kind: 'batch' }).total).toBe(0);
    facade.v2Delete({ kind: 'instrument', id: instrumentId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(0);
    expect(facade.v2HistoryPage({ kind: 'instrument' }).total).toBe(0);
    facade.v2Delete({ kind: 'acceptance', projectId, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2ProjectDetail(projectId).detail!.acceptanceReport).toBe(false);
    expect(facade.v2HistoryPage({ kind: 'acceptance' }).total).toBe(0);

    // ---- 每个成功删除的 kind 都保留 tombstone（审计保留）----
    const kinds = ['qr_request', 'serial_address', 'service_order', 'damage_repair_item', 'ship_to_request', 'batch', 'instrument', 'acceptance'];
    for (const kind of kinds) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit WHERE record_type = ?').get(kind) as { n: number };
      expect(row.n, `kind ${kind} 应保留 tombstone`).toBeGreaterThan(0);
    }
  });

  it('damage：确认后删除（含已处理），同事务仅清理指向该事项的维修上门关联、不删活动/仪器/项目', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 已处理 + 已使用备件 + 维修上门关联 → 按 5.2 口径仍可确认删除
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-1', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'used', issueStatus: 'processing', registeredAt: '2026-08-12' } },
    });
    const damageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE project_id = ?').get(projectId)!.id);
    // 另一台仪器上再建一条事项（保留其关联，验证仅指向被删事项的关联被清理）
    db.prepare('INSERT INTO instruments (id, project_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').run('i-other', projectId, '其他仪器', 't', 't');
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId: 'i-other', damageReason: '磕碰2', partNumber: 'P-2', partQuantity: '1', partAmount: '50', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-13' } },
    });
    const otherDamageId = String(db.prepare('SELECT id FROM damage_repair_items WHERE id <> ? AND project_id = ?').get(damageId, projectId)!.id);
    // 构造维修上门活动 + 维修工作事实 + 事项关联（活动属执行事实，应保留）
    db.prepare('INSERT INTO activities (id, project_id, visit_at, created_at, updated_at) VALUES (?,?,?,?,?)').run('act-repair', projectId, '2026-08-13', 't', 't');
    db.prepare('INSERT INTO work_facts (id, activity_id, instrument_id, work_type, status, started_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('wf-repair', 'act-repair', instrumentId, 'repair', 'done', 't', 't', 't');
    db.prepare('INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)').run('link-1', 'act-repair', damageId, 't');
    db.prepare('INSERT INTO activity_damage_links (id, activity_id, damage_item_id, created_at) VALUES (?,?,?,?)').run('link-2', 'act-repair', otherDamageId, 't');

    const result = facade.v2Delete({ kind: 'damage_repair_item', id: damageId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('damage_repair_item');
    // 事项已删除；仅指向该事项的关联被清理，其他事项的关联与活动本身保留
    expect(db.prepare('SELECT COUNT(*) AS n FROM damage_repair_items WHERE id = ?').get(damageId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links WHERE damage_item_id = ?').get(damageId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity_damage_links WHERE id = ?').get('link-2')!.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get('act-repair')!.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_facts WHERE activity_id = ?').get('act-repair')!.n).toBe(1);
    // 仪器与项目保留、状态不变
    expect(db.prepare('SELECT COUNT(*) AS n FROM instruments WHERE id = ?').get(instrumentId)!.n).toBe(1);
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId)!.status).toBe('pending_execution');
    expect(facade.v2SectionPage({ projectId, kind: 'damage_items' }).total).toBe(1); // 仅剩其他事项
    // tombstone：owned_child_count = 原子清理的关联数（1）
    const tomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('damage_repair_item', damageId) as { owned_child_count: number };
    expect(tomb).toBeDefined();
    expect(tomb.owned_child_count).toBe(1);
  });

  it('serial_address 独立记录删除成功（instrumentId 为 null）', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-del', null, '独立客户', '新址', 'SN-DEL', 'ACC-DEL', '2026-08-10', 't');
    const result = facade.v2Delete({ kind: 'serial_address', id: 'sa-del', expectedRevision: readBusinessRevision(db) });
    expect(result.invalidated).toContain('independent:serial_address');
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(0);
  });

  it('qr_request 删除成功：多选类型一并清理', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(qrId)!.n).toBe(2);
    const result = facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    expect(result.invalidated).toContain('independent:qr_request');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qr_request_types WHERE qr_request_id = ?').get(qrId)!.n).toBe(0);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
  });

  it('batch：已开始运输/有当前仪器/有改批历史 → 拒绝；空批次（未开始、无仪器、无历史）→ 删除成功（含唯一物流费用）', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 空批次（未开始、无仪器、无历史，但带唯一物流费用）→ 删除成功（费用随批次删除）
    seedHistoricalBatch(db, projectId, { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' });
    const batchId = String(db.prepare('SELECT id FROM batches WHERE project_id = ?').get(projectId)!.id);
    const feeId = String(db.prepare('SELECT id FROM logistics_fees WHERE batch_id = ?').get(batchId)!.id);
    const result = facade.v2Delete({ kind: 'batch', id: batchId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('batch');
    expect(facade.v2SectionPage({ projectId, kind: 'batches' }).total).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE batch_id = ?').get(batchId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM logistics_fees WHERE id = ?').get(feeId)!.n).toBe(0);

    // 已绑定仪器 → 拒绝
    seedHistoricalBatch(db, projectId, { planTransportDate: '2026-08-11', transportCompany: 'T', appliedAt: '2026-08-09', budgetPrice: '1000', dealPrice: '1000' });
    const batch2 = String(db.prepare('SELECT id FROM batches WHERE project_id = ? AND id <> ?').get(projectId, batchId)!.id);
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    db.prepare('UPDATE instruments SET batch_id = ? WHERE id = ?').run(batch2, instrumentId);
    expectRejected(
      () => facade.v2Delete({ kind: 'batch', id: batch2, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    db.prepare('UPDATE instruments SET batch_id = NULL WHERE id = ?').run(instrumentId);

    // 已开始运输 → 拒绝
    db.prepare('UPDATE batches SET started_at = ? WHERE id = ?').run('2026-08-12', batch2);
    expectRejected(
      () => facade.v2Delete({ kind: 'batch', id: batch2, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
  });

  it('instrument：所属批次已开始运输/存在依赖记录 → 拒绝；无依赖 → 删除成功', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 有损坏事项 → 拒绝
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-1', partQuantity: '1', partAmount: '10', partCurrency: 'USD', partStatus: 'pending_submit', issueStatus: 'untreated', registeredAt: '2026-08-12' } },
    });
    expectRejected(
      () => facade.v2Delete({ kind: 'instrument', id: instrumentId, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(facade.v2SectionPage({ projectId, kind: 'instruments' }).total).toBe(1);

    // 无依赖 → 删除成功
    const cleanCtx = await makeCtx();
    const cleanInstrumentId = String(cleanCtx.db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(cleanCtx.projectId)!.id);
    const result = cleanCtx.facade.v2Delete({ kind: 'instrument', id: cleanInstrumentId, expectedRevision: readBusinessRevision(cleanCtx.db) });
    expect(result.changed?.kind).toBe('instrument');
    expect(cleanCtx.facade.v2SectionPage({ projectId: cleanCtx.projectId, kind: 'instruments' }).total).toBe(0);

    // 所属批次已开始运输 → 拒绝
    const ctx2 = await makeCtx();
    const { db: db2, projectId: p2 } = ctx2;
    const i2 = String(db2.prepare('SELECT id FROM instruments WHERE project_id = ?').get(p2)!.id);
    seedHistoricalBatch(ctx2.db, p2, { planTransportDate: '2026-08-10', transportCompany: 'T', appliedAt: '2026-08-09', budgetPrice: '1000', dealPrice: '1000' });
    const b2 = String(db2.prepare('SELECT id FROM batches WHERE project_id = ?').get(p2)!.id);
    db2.prepare('UPDATE instruments SET batch_id = ? WHERE id = ?').run(b2, i2);
    db2.prepare('UPDATE batches SET started_at = ? WHERE id = ?').run('2026-08-12', b2);
    expectRejected(
      () => ctx2.facade.v2Delete({ kind: 'instrument', id: i2, expectedRevision: readBusinessRevision(db2) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
  });

  it('ship_to_request：未完成且无 Account ID 直接删除；异常未完成已有 Account ID 保守拒绝', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    // 待提交（未补入 Account ID）→ 直接删除
    const pending = facade.createShipToRequest({ customerName: 'ShipTo 客户', newSiteAddress: '新址' });
    const r1 = facade.v2Delete({ kind: 'ship_to_request', id: pending.request.id, expectedRevision: readBusinessRevision(db) });
    expect(r1.invalidated).toContain('lookup:ship_to_requests');
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(0);

    // 处理中（未补入 Account ID）→ 直接删除
    const processing = facade.createShipToRequest({ customerName: 'ShipTo 客户乙', newSiteAddress: '新址乙' });
    facade.submitShipToRequest(processing.request.id);
    facade.v2Delete({ kind: 'ship_to_request', id: processing.request.id, expectedRevision: readBusinessRevision(db) });
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(0);

    // 异常未完成但已补入 Account ID → 保守拒绝（无安全证明未产生主数据）
    const abnormal = facade.createShipToRequest({ customerName: 'ShipTo 客户丙', newSiteAddress: '新址丙' });
    facade.submitShipToRequest(abnormal.request.id);
    db.prepare('UPDATE ship_to_requests SET account_id = ? WHERE id = ?').run('ACC-ABNORMAL', abnormal.request.id);
    expectRejected(
      () => facade.v2Delete({ kind: 'ship_to_request', id: abnormal.request.id, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1); // 拒绝零写
  });

  it('ship_to_request：删除处理中无 Account ID 的并行申请只物理删除目标，不取消或回退另一申请，仍保留 tombstone', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const target = facade.createShipToRequest({ customerName: '待删除并行申请', newSiteAddress: '目标新址' });
    const untouched = facade.createShipToRequest({ customerName: '保留并行申请', newSiteAddress: '保留新址' });
    facade.submitShipToRequest(target.request.id);
    facade.submitShipToRequest(untouched.request.id);
    expect(db.prepare('SELECT status, account_id FROM ship_to_requests WHERE id = ?').get(target.request.id)).toMatchObject({
      status: 'processing',
      account_id: null,
    });

    facade.v2Delete({ kind: 'ship_to_request', id: target.request.id, expectedRevision: readBusinessRevision(db) });
    // 目标行物理消失；删除不是取消/退回命令。
    expect(db.prepare('SELECT id FROM ship_to_requests WHERE id = ?').get(target.request.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM ship_to_requests WHERE status IN ('cancelled', 'pending_submit')").get()!.n).toBe(0);
    // 并行申请仍在处理中，且可沿唯一线性路径继续完成。
    expect(db.prepare('SELECT status, account_id FROM ship_to_requests WHERE id = ?').get(untouched.request.id)).toMatchObject({
      status: 'processing',
      account_id: null,
    });
    facade.v2Mutate({ op: 'ship_to_complete', requestId: untouched.request.id, accountId: 'ACC-PARALLEL-001' });
    expect(db.prepare('SELECT status, account_id FROM ship_to_requests WHERE id = ?').get(untouched.request.id)).toMatchObject({
      status: 'completed',
      account_id: 'ACC-PARALLEL-001',
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('ship_to_request', target.request.id)!.n,
    ).toBe(1);
  });

  it('ship_to_request：completed 经 origin_request_id 证明来源，无引用随申请原子清理 Ship-to', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const pending = facade.createShipToRequest({ customerName: 'ShipTo 完成客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(pending.request.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: pending.request.id, accountId: 'ACC-DONE' });
    // 完成生成的不可变 Ship-to 记录来源申请
    const shipToRow = db.prepare('SELECT id, origin_request_id FROM ship_tos WHERE account_id = ?').get('ACC-DONE') as { id: string; origin_request_id: string | null };
    expect(shipToRow).toBeDefined();
    expect(shipToRow.origin_request_id).toBe(pending.request.id);

    // 无任何引用且仅由该申请产生 → 同事务先删 Ship-to 再删申请，不留孤立
    const revision = readBusinessRevision(db);
    facade.v2Delete({ kind: 'ship_to_request', id: pending.request.id, expectedRevision: revision });
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ship_tos WHERE id = ?').get(shipToRow.id)!.n).toBe(0);
    // tombstone：owned_child_count=1（原子清理的 Ship-to 主数据）
    const tomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('ship_to_request', pending.request.id) as { owned_child_count: number };
    expect(tomb).toBeDefined();
    expect(tomb.owned_child_count).toBe(1);
  });

  it('ship_to_request：completed 对应 Ship-to 仍被仪器引用时原子拒绝；legacy 无来源也拒绝', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);

    // 引用拒绝：已完成申请产生的 Ship-to 被仪器 destination_ship_to_id 引用
    const referenced = facade.createShipToRequest({ customerName: 'ShipTo 引用客户', newSiteAddress: '新址引用' });
    facade.submitShipToRequest(referenced.request.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: referenced.request.id, accountId: 'ACC-REF' });
    const shipToId = String(db.prepare('SELECT id FROM ship_tos WHERE account_id = ?').get('ACC-REF')!.id);
    db.prepare('UPDATE instruments SET destination_ship_to_id = ? WHERE id = ?').run(shipToId, instrumentId);
    expectRejected(
      () => facade.v2Delete({ kind: 'ship_to_request', id: referenced.request.id, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 申请与 Ship-to 均保持不变（拒绝零写）
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ship_tos WHERE id = ?').get(shipToId)!.n).toBe(1);
    db.prepare('UPDATE instruments SET destination_ship_to_id = NULL WHERE id = ?').run(instrumentId);

    // legacy 拒绝：completed 申请对应 Ship-to 无 origin_request_id（无法证明来源）
    const legacy = facade.createShipToRequest({ customerName: 'ShipTo legacy 客户', newSiteAddress: '新址 legacy' });
    facade.submitShipToRequest(legacy.request.id);
    facade.v2Mutate({ op: 'ship_to_complete', requestId: legacy.request.id, accountId: 'ACC-LEGACY' });
    db.prepare('UPDATE ship_tos SET origin_request_id = NULL WHERE account_id = ?').run('ACC-LEGACY');
    expectRejected(
      () => facade.v2Delete({ kind: 'ship_to_request', id: legacy.request.id, expectedRevision: readBusinessRevision(db) }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 拒绝零写：申请与 Ship-to 均保留
    expect(facade.v2LookupPage({ kind: 'ship_to_requests' }).total).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ship_tos WHERE account_id = ?').get('ACC-LEGACY')!.n).toBe(1);
  });

  it('invoice 删除映射为撤销：必填撤销日期/原因，行不物理删除', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);

    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '', revokeReason: '' }),
      DELETE_REJECTION_CODES.INVOICE_REQUIRES_REVOKE,
    );

    const result = facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '2026-08-13', revokeReason: '客户更正' });
    // 删除结果信封：changed 回显 invoice 的 kind/id/projectId，businessRevision 与库一致
    expect(result.changed).toMatchObject({ kind: 'invoice', id: invoiceId, projectId });
    expect(result.invalidated).toContain(`project:${projectId}`);
    expect(result.invalidated).toContain(`sections:${projectId}`);
    expect(result.businessRevision).toBe(readBusinessRevision(db));
    const row = db.prepare('SELECT revoked_at, revoke_reason FROM invoices WHERE id = ?').get(invoiceId) as { revoked_at: string; revoke_reason: string };
    expect(row.revoked_at).toBe('2026-08-13'); // 物理行保留（撤销终态）
    expect(row.revoke_reason).toBe('客户更正');
    // 物理行不删除：掉票记录仅可撤销（撤销终态行仍保留在 invoices 表中）
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE id = ?').get(invoiceId)!.n).toBe(1);
    expect(facade.v2SectionPage({ projectId, kind: 'invoices' }).rows[0]).toMatchObject({ active: false });
  });

  it('删除失败整体回滚：invoice 重复撤销被领域拒绝时事务回滚', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'invoice', projectId, values: { invoicedAt: '2026-08-11', amount: '1000' } } });
    const invoiceId = String(db.prepare('SELECT id FROM invoices WHERE project_id = ?').get(projectId)!.id);
    const revisionBefore = readBusinessRevision(db);
    facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: revisionBefore, revokedAt: '2026-08-12', revokeReason: '第一次撤销' });
    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: invoiceId, expectedRevision: readBusinessRevision(db), revokedAt: '2026-08-13', revokeReason: '再次撤销' }),
      /撤销/,
    );
    const row = db.prepare('SELECT revoked_at, revoke_reason FROM invoices WHERE id = ?').get(invoiceId) as { revoked_at: string; revoke_reason: string };
    expect(row.revoked_at).toBe('2026-08-12'); // 保持首次撤销终态
    expect(row.revoke_reason).toBe('第一次撤销');
  });

  it('命令形状：未知 recordType 稳定拒绝（DELETE_UNKNOWN_KIND），expectedRevision 校验先于类型分发', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const revision = readBusinessRevision(db);
    // expectedRevision 在 BEGIN IMMEDIATE 事务内核验、类型分发之前 → 未知 kind 带过期修订仍先报修订不匹配
    expectRejected(
      () =>
        facade.v2Delete({
          kind: 'unknown_kind',
          id: 'whatever',
          expectedRevision: revision - 1,
        } as unknown as WorkbenchV2DeleteRequest),
      DELETE_REJECTION_CODES.REVISION_MISMATCH,
    );
    // 修订一致才进入类型分发：未知 kind 走默认分支拒绝（非稳定码，属程序错误边界，不误伤既有类型）
    expectRejected(
      () =>
        facade.v2Delete({
          kind: 'unknown_kind',
          id: 'whatever',
          expectedRevision: revision,
        } as unknown as WorkbenchV2DeleteRequest),
      'DELETE_UNKNOWN_KIND',
    );
    // 两次拒绝均无副作用：修订不变、无记录被删
    expect(readBusinessRevision(db)).toBe(revision);
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
  });

  it('稳定拒绝码：不存在的记录统一返回 NOT_FOUND（acceptance 以 projectId 寻址），且不写库', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    const revision = readBusinessRevision(db);
    expectRejected(
      () => facade.v2Delete({ kind: 'service_order', id: 'so-missing', expectedRevision: revision }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    // acceptance 命令形状差异：以 projectId（而非 id）寻址
    expectRejected(
      () => facade.v2Delete({ kind: 'acceptance', projectId: 'proj-missing', expectedRevision: revision }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    // invoice 先校验存在性：即使携带合法撤销字段，记录不存在仍 NOT_FOUND（不落入撤销语义）
    expectRejected(
      () => facade.v2Delete({ kind: 'invoice', id: 'inv-missing', expectedRevision: revision, revokedAt: '2026-08-13', revokeReason: '客户更正' }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    expect(readBusinessRevision(db)).toBe(revision);
  });

  it('删除结果信封：项目关联型成功删除返回 businessRevision/invalidated/changed，修订单调递增且与库一致', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-ENV-001', orderedAt: '2026-08-11', engineer: '工程师甲' } },
    });
    const orderId = String(db.prepare('SELECT id FROM service_orders WHERE service_order_no = ?').get('SO-ENV-001')!.id);
    const revision = readBusinessRevision(db);
    const result = facade.v2Delete({ kind: 'service_order', id: orderId, expectedRevision: revision });
    // 信封仅三个字段
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(revision);
    expect(result.businessRevision).toBe(readBusinessRevision(db));
    // changed 回显请求形状：kind/id/projectId
    expect(result.changed).toEqual({ kind: 'service_order', id: orderId, projectId });
    // invalidated：overview + projects + project:X + sections:X（唯一去重后的精确集合）
    expect(result.invalidated).toEqual(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]);
  });

  it('删除结果信封：独立/查询型 changed 不含 projectId，携带独立/查询失效标签', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;

    // 二维码申请（独立）：changed 无 projectId，失效标签为 independent:qr_request
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);
    const qrResult = facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    expect(qrResult.changed).toEqual({ kind: 'qr_request', id: qrId });
    expect(qrResult.changed?.projectId).toBeUndefined();
    expect(qrResult.invalidated).toEqual(['overview', 'projects', 'independent:qr_request']);

    // 独立序列号地址更新（instrumentId 为 null）：changed 同样无 projectId
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-env', null, '独立客户', '新址', 'SN-ENV', 'ACC-ENV', '2026-08-10', 't');
    const saResult = facade.v2Delete({ kind: 'serial_address', id: 'sa-env', expectedRevision: readBusinessRevision(db) });
    expect(saResult.changed?.projectId).toBeUndefined();
    expect(saResult.invalidated).toEqual(['overview', 'projects', 'independent:serial_address']);

    // Ship-to 申请（查询型）：changed 无 projectId，失效标签为 lookup:ship_to_requests
    const pending = facade.createShipToRequest({ customerName: 'ShipTo 信封客户', newSiteAddress: '新址' });
    facade.submitShipToRequest(pending.request.id);
    const stResult = facade.v2Delete({ kind: 'ship_to_request', id: pending.request.id, expectedRevision: readBusinessRevision(db) });
    expect(stResult.changed).toEqual({ kind: 'ship_to_request', id: pending.request.id });
    expect(stResult.invalidated).toEqual(['overview', 'projects', 'lookup:ship_to_requests']);
  });

  it('原子审计联动：成功删除保留来源审计并标记（批次+唯一物流费用），tombstone 同事务原子写入；拒绝路径全零写', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // 批次 + 唯一物流费用均挂 import_record_audit → 删除时来源审计保留并标记（不物理擦除）
    seedHistoricalBatch(db, projectId, { planTransportDate: '2026-08-10', transportCompany: '运输公司', appliedAt: '2026-08-09', budgetPrice: '12000', dealPrice: '11000' });
    const batchId = String(db.prepare('SELECT id FROM batches WHERE project_id = ?').get(projectId)!.id);
    const feeId = String(db.prepare('SELECT id FROM logistics_fees WHERE batch_id = ?').get(batchId)!.id);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-batch', 'b-1', 'batches', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(batchId);
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-fee', 'f-1', 'logistics_fees', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(feeId);
    const result = facade.v2Delete({ kind: 'batch', id: batchId, expectedRevision: readBusinessRevision(db) });
    expect(result.changed?.kind).toBe('batch');
    // 来源审计行保留（未物理删除）且两个目标均标记指向已删除目标
    const batchAudit = db.prepare('SELECT * FROM import_record_audit WHERE id = ?').get('audit-batch') as {
      target_deleted_at: string | null;
      target_delete_operation_id: string | null;
    };
    const feeAudit = db.prepare('SELECT * FROM import_record_audit WHERE id = ?').get('audit-fee') as {
      target_deleted_at: string | null;
      target_delete_operation_id: string | null;
    };
    expect(batchAudit.target_deleted_at).not.toBeNull();
    expect(feeAudit.target_deleted_at).not.toBeNull();
    // tombstone：批次 owned_child_count=1（唯一物流费用原子清理）；operation_id 与全部 import marker 一致
    const tomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('batch', batchId) as {
      operation_id: string;
      owned_child_count: number;
    };
    expect(tomb).toBeDefined();
    expect(tomb.owned_child_count).toBe(1);
    expect(tomb.operation_id).toBe(batchAudit.target_delete_operation_id);
    expect(tomb.operation_id).toBe(feeAudit.target_delete_operation_id);

    // 拒绝路径：业务行、tombstone、import marker 全零写（来源审计原样保留、无标记）
    // 用 instrument（存在损坏事项依赖，任务 5.3 保留的依赖拒绝）作为拒绝样例；
    // damage 已按 5.2 口径放开为确认后删除，不再作为拒绝样例。
    const instrumentId = String(db.prepare('SELECT id FROM instruments WHERE project_id = ?').get(projectId)!.id);
    facade.v2Mutate({
      op: 'submit_action',
      projectId,
      action: { type: 'damage', projectId, values: { instrumentId, damageReason: '磕碰', partNumber: 'P-3', partQuantity: '1', partAmount: '100', partCurrency: 'USD', partStatus: 'arrived', issueStatus: 'untreated', registeredAt: '2026-08-12' } },
    });
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-instrument', 'ins-1', 'instruments', ?, 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run(instrumentId);
    const revisionAtReject = readBusinessRevision(db);
    expectRejected(
      () => facade.v2Delete({ kind: 'instrument', id: instrumentId, expectedRevision: revisionAtReject }),
      DELETE_REJECTION_CODES.DEPENDENCIES,
    );
    // 业务行仍在（未被级联删除）
    expect(db.prepare('SELECT COUNT(*) AS n FROM instruments WHERE id = ?').get(instrumentId)!.n).toBe(1);
    // import marker 未被写入（target_deleted_at 仍为 NULL，审计原样保留）
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE id = ? AND target_deleted_at IS NULL').get('audit-instrument')!.n).toBe(1);
    // 拒绝路径不写任何 tombstone
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('instrument', instrumentId)!.n).toBe(0);
    expect(readBusinessRevision(db)).toBe(revisionAtReject);
  });

  it('类型分发：各 kind 成功删除写入对应 record_type 的 tombstone（owned_child_count 记录原子清理子记录数）', async () => {
    const ctx = await makeCtx();
    const { facade, db, projectId } = ctx;

    // qr_request：多选类型（2 条）随申请原子清理 → owned_child_count=2
    facade.v2Mutate({ op: 'submit_action', action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A', 'logistics_management'] } } });
    const qrId = String(db.prepare('SELECT id FROM qr_requests LIMIT 1').get()!.id);
    facade.v2Delete({ kind: 'qr_request', id: qrId, expectedRevision: readBusinessRevision(db) });
    const qrTomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('qr_request', qrId) as {
      operation_id: string;
      owned_child_count: number;
    };
    expect(qrTomb).toBeDefined();
    expect(qrTomb.owned_child_count).toBe(2);

    // activity：参与工程师（2 名）随活动原子清理 → owned_child_count=2
    seedHistoricalActivity(db, projectId, '2026-08-13', ['工程师甲', '工程师乙']);
    const activityId = String(db.prepare('SELECT id FROM activities WHERE project_id = ?').get(projectId)!.id);
    facade.v2Delete({ kind: 'activity', id: activityId, expectedRevision: readBusinessRevision(db) });
    const activityTomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('activity', activityId) as {
      operation_id: string;
      owned_child_count: number;
    };
    expect(activityTomb).toBeDefined();
    expect(activityTomb.owned_child_count).toBe(2);

    // 独立 serial_address：无子记录 → owned_child_count=0，且为独立 kind 的 tombstone
    db.prepare(
      `INSERT INTO serial_address_updates (id, instrument_id, customer_name, new_site_address, serial_no, account_id, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('sa-dispatch', null, '独立客户', '新址', 'SN-D', 'ACC-D', '2026-08-10', 't');
    facade.v2Delete({ kind: 'serial_address', id: 'sa-dispatch', expectedRevision: readBusinessRevision(db) });
    const saTomb = db.prepare('SELECT * FROM record_deletion_audit WHERE record_type = ? AND record_id = ?').get('serial_address', 'sa-dispatch') as {
      operation_id: string;
      owned_child_count: number;
    };
    expect(saTomb).toBeDefined();
    expect(saTomb.owned_child_count).toBe(0);

    // 每次 v2Delete 调用共享独立 operation_id（tombstone 一一对应，互不串用）
    const opIds = [qrTomb.operation_id, activityTomb.operation_id, saTomb.operation_id];
    expect(new Set(opIds).size).toBe(3);
    // 记录已从读取模型消失（分发正确）
    expect(facade.v2IndependentPage({ kind: 'qr_request' }).total).toBe(0);
    expect(facade.v2IndependentPage({ kind: 'serial_address' }).total).toBe(0);
    expect(facade.v2SectionPage({ projectId, kind: 'activities' }).total).toBe(0);
  });

  it('拒绝路径全零写：NOT_FOUND/未知 kind 不写业务行、tombstone 与 import marker', async () => {
    const ctx = await makeCtx();
    const { facade, db } = ctx;
    db.prepare(
      "INSERT INTO import_record_audit (id, source_key, target_table, target_id, import_source_hash, target_snapshot_hash, imported_at) VALUES ('audit-missing', 'm-1', 'service_orders', 'so-missing', 'h', 'h', '2026-08-11T00:00:00+08:00')",
    ).run();
    const revision = readBusinessRevision(db);

    // NOT_FOUND：拒绝且 import marker 不写入（target_deleted_at 保持 NULL）
    expectRejected(
      () => facade.v2Delete({ kind: 'service_order', id: 'so-missing', expectedRevision: revision }),
      DELETE_REJECTION_CODES.NOT_FOUND,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM import_record_audit WHERE id = ? AND target_deleted_at IS NULL').get('audit-missing')!.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit').get()!.n).toBe(0);

    // 未知 kind：稳定拒绝，同样零写
    expectRejected(
      () =>
        facade.v2Delete({
          kind: 'unknown_kind',
          id: 'whatever',
          expectedRevision: revision,
        } as unknown as WorkbenchV2DeleteRequest),
      'DELETE_UNKNOWN_KIND',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM record_deletion_audit').get()!.n).toBe(0);
    expect(readBusinessRevision(db)).toBe(revision);
  });
});
