import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { SystemClock } from '../../src/domain/core/time';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import {
  IPC_CHANNELS,
  type AccountSessionInfo,
  type IpcChannel,
  type WorkbenchV2MutationRequest,
  type WorkbenchV2OverviewDto,
  type WorkbenchV2ProjectPageRequest,
} from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { establishLocalSession } from '../helpers/establish-session';
import type { ImportWizardFacade } from '../../src/main/import-wizard-facade';

/**
 * Oracle #10 v2 IPC 通道：
 * - v2 读取（overview/project-page/detail/section/independent/lookup）与 v2 mutation
 *   统一经会话 + 受信主窗口守卫；
 * - v2 mutation 返回有界结果（businessRevision + invalidate tags），不携带 snapshot。
 */

function stubFacade(): ImportWizardFacade {
  const stub = new Proxy({}, {
    get: () => () => {
      throw new Error('导入向导 facade 未在测试中配置');
    },
  });
  return stub as unknown as ImportWizardFacade;
}

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: IpcChannel, senderId: number, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`未注册通道: ${channel}`);
    return handler({ sender: { id: senderId }, senderFrame: { url: 'http://localhost:3000/' } }, ...args);
  }
}

function makeContext(dir: string) {
  let db = bootstrapDatabase({ dataDir: dir }).db;
  const dbPath = join(dir, 'workbench.db');
  let session: AccountSessionInfo | null = null;
  let trustedSenderId: number | null = 100;
  const accountService = () => new LocalAccountService(new SqliteAccountRepository(db));
  const deps: IpcHandlerDeps = {
    db: () => db,
    dbPath: () => dbPath,
    dataDir: () => dir,
    accountService,
    session: () => session,
    setSession: (s) => {
      session = s;
    },
    trustedSenderId: () => trustedSenderId,
    trustedSenderOrigin: () => 'http://localhost:3000/',
    autoBackupError: () => null,
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    writeFile: async () => undefined,
    createManualBackup: () => Promise.resolve(join(dir, 'manual.db')),
    createCleanupBackup: () => Promise.resolve(join(dir, 'cleanup-backup.db')),
    restoreFromBackup: () => ({ restored: false }),
    importWizardFacade: stubFacade,
    importWizardEnabled: () => true,
    importWizardError: () => null,
  };
  return {
    db: () => db,
    deps,
    bus: new FakeBus(),
    session: () => session,
    setTrustedSender: (id: number | null) => {
      trustedSenderId = id;
    },
  };
}

/** 无密码模式：经账号服务确保本地账号并写入会话（主进程启动/恢复同款接线）。 */
async function establishSession(ctx: ReturnType<typeof makeContext>): Promise<AccountSessionInfo> {
  return establishLocalSession(ctx.deps.accountService, ctx.deps.setSession);
}

const V2_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.workbenchV2Overview,
  IPC_CHANNELS.workbenchV2ProjectPage,
  IPC_CHANNELS.workbenchV2ProjectDetail,
  IPC_CHANNELS.workbenchV2SectionPage,
  IPC_CHANNELS.workbenchV2IndependentPage,
  IPC_CHANNELS.workbenchV2LookupPage,
  IPC_CHANNELS.workbenchV2HistoryPage,
  IPC_CHANNELS.workbenchV2ReminderPage,
  IPC_CHANNELS.workbenchV2ReminderLanes,
  IPC_CHANNELS.workbenchV2Mutate,
];

const ENVELOPED_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.workbenchV2Delete,
  IPC_CHANNELS.dataCleanPrepare,
  IPC_CHANNELS.dataCleanConfirm,
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('Oracle #10 v2 IPC：会话 + 受信主窗口守卫', () => {
  it('未登录时全部 v2 通道被拒绝；登录后正常', async () => {
    const dir = makeTempDir('ipc-v2-guard-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);

    // 普通通道：未登录直接拒绝（rejects）。
    for (const channel of V2_CHANNELS) {
      await expect(ctx.bus.invoke(channel, 100)).rejects.toThrow(/登录状态已失效/);
    }
    // 信封通道（v2Delete/cleanPrepare/cleanConfirm）：未登录返回 {ok:false,error}，不抛错。
    for (const channel of ENVELOPED_CHANNELS) {
      const result = (await ctx.bus.invoke(channel, 100)) as { ok: false; error: { code: string; message: string } };
      expect(result.ok).toBe(false);
      expect(result.error.message).toMatch(/登录状态已失效/);
      expect(typeof result.error.code).toBe('string');
    }
    // 非受信 sender 拒绝
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 999)).rejects.toThrow(/受信主窗口/);

    await establishSession(ctx);
    const overview = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100)) as WorkbenchV2OverviewDto;
    expect(overview.businessRevision).toBe(0);
    expect(overview.metrics.totalProjects).toBe(0);
    expect(overview.reminderPreview).toEqual([]);
  });
});

describe('Oracle #10 v2 IPC：mutation 有界结果与写后读取', () => {
  async function loggedIn() {
    const dir = makeTempDir('ipc-v2-mut-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx;
  }

  it('标签 catalog/mutate 经受信 IPC 返回信封，并刷新队列与详情摘要', async () => {
    const ctx = await loggedIn();
    const created = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project', payload: { intent: 'draft', customerName: 'IPC 标签客户', region: 'East' },
    } as WorkbenchV2MutationRequest) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const groupEnvelope = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, 100, { command: 'create_group', payload: { name: 'IPC 分组' } }) as { ok: boolean; data: { group: { id: string } } };
    expect(groupEnvelope.ok).toBe(true);
    const tagEnvelope = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, 100, { command: 'create_tag', payload: { groupId: groupEnvelope.data.group.id, name: 'IPC 标签' } }) as { ok: boolean; data: { tag: { id: string } } };
    const setEnvelope = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, 100, { command: 'replace_project_tags', payload: { projectId, tagIds: [tagEnvelope.data.tag.id] } }) as { ok: boolean; data: { groupedTags: unknown[] } };
    expect(setEnvelope).toMatchObject({ ok: true, data: { groupedTags: [{ groupName: 'IPC 分组', tagNames: ['IPC 标签'] }] } });
    const catalog = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2TagCatalog, 100, { projectId }) as { selectedTagIds: string[] };
    expect(catalog.selectedTagIds).toEqual([tagEnvelope.data.tag.id]);
    const page = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, { query: 'IPC 标签客户' }) as { projects: Array<{ groupedTags: unknown[] }> };
    expect(page.projects[0].groupedTags).toHaveLength(1);
    const detail = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectDetail, 100, projectId) as { groupedTags: unknown[] };
    expect(detail.groupedTags).toHaveLength(1);
    const unknown = await ctx.bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, 100, { command: 'replace_project_tags', payload: { projectId, tagIds: ['unknown'] } }) as { ok: boolean; error: { code: string } };
    expect(unknown).toMatchObject({ ok: false, error: { code: 'PROJECT_TAG_UNKNOWN_TAG' } });
  });

  it('v2Mutate create_project 返回 bounded 结果（revision + invalidate + changed），无 snapshot 字段', async () => {
    const ctx = await loggedIn();
    const before = readBusinessRevision(ctx.db());
    const request: WorkbenchV2MutationRequest = {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'IPC v2 客户',
        ecc: 'ECC-IPC-V2',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '100000',
        siteConfirmed: false,
      },
    };
    const result = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, request)) as Record<string, unknown>;
    // bounded：只有业务修订 + 失效标签 + 变更引用，绝不含 projects/batches/... 快照
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.invalidated).toContain('overview');
    expect(result.invalidated).toContain('projects');

    // 写后读取：v2ProjectPage / detail 可见新项目
    const pageRequest: WorkbenchV2ProjectPageRequest = { query: 'IPC v2 客户' };
    const page = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, pageRequest)) as {
      projects: Array<{ id: string; customerName: string }>;
      total: number;
      businessRevision: number;
    };
    expect(page.total).toBe(1);
    expect(page.projects[0].customerName).toBe('IPC v2 客户');
    expect(page.businessRevision).toBeGreaterThan(before);

    const detail = (await ctx.bus.invoke(
      IPC_CHANNELS.workbenchV2ProjectDetail,
      100,
      page.projects[0].id,
    )) as { project: { contractAmount: string; entryAmountSnapshot: string | null } };
    expect(detail.project.contractAmount).toBe('100000.00');
    expect(detail.project.entryAmountSnapshot).toBe('100000.00');
  });

  it('v2 mutation 后 businessRevision 递增（写后 invalidate 语义）', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '递增客户',
        ecc: 'ECC-REV-1',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '1000',
        siteConfirmed: false,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const r1 = readBusinessRevision(ctx.db());
    const reminded = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'set_reminder',
      projectId: created.changed.projectId,
      reminderAt: '2026-08-10',
      reminderNote: '跟进',
    } as WorkbenchV2MutationRequest)) as { businessRevision: number; invalidated: string[] };
    expect(reminded.businessRevision).toBeGreaterThan(r1);
    expect(reminded.invalidated).toContain(`project:${created.changed.projectId}`);
    // 页面提醒分类生效
    const page = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, {
      reminder: 'any',
    } as WorkbenchV2ProjectPageRequest)) as { projects: Array<{ reminderNote: string | null }> };
    expect(page.projects[0].reminderNote).toBe('跟进');
  });

  it('renderer FormData 形状的仪器 boolean 字符串经 facade 精确写入；非法值零写', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: { intent: 'draft', customerName: '仪器布尔客户', region: 'East' },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;

    for (const [name, ups, qrRequested] of [
      ['字符串 false', 'false', 'false'],
      ['字符串 true', 'true', 'true'],
    ] as const) {
      await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: { type: 'instrument', projectId, values: { name, ups, qrRequested } },
      } as WorkbenchV2MutationRequest);
    }
    const rows = ctx.db().prepare('SELECT ups, qr_requested FROM instruments ORDER BY rowid').all() as Array<{
      ups: number;
      qr_requested: number;
    }>;
    expect(rows).toEqual([{ ups: 0, qr_requested: 0 }, { ups: 1, qr_requested: 1 }]);

    const countBefore = (ctx.db().prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number }).n;
    await expect(ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      action: { type: 'instrument', projectId, values: { name: '非法布尔', ups: '1', qrRequested: 'false' } },
    } as WorkbenchV2MutationRequest)).rejects.toMatchObject({ code: 'INVALID_BOOLEAN' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM instruments').get() as { n: number }).n).toBe(countBefore);
  });

  it('update_project 经 IPC 通道：资料更新落库并返回 bounded 失效标签', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'IPC 更新客户',
        ecc: 'ECC-UPD-IPC',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '1000',
        siteConfirmed: false,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const before = readBusinessRevision(ctx.db());

    const result = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'update_project',
      payload: { projectId, region: 'West', oldSiteContact: '旧址王工', siteConfirmed: false },
    } as WorkbenchV2MutationRequest)) as { businessRevision: number; invalidated: string[]; changed: { projectId: string } };
    expect(Object.keys(result).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(result.businessRevision).toBeGreaterThan(before);
    expect(result.changed).toEqual({ projectId });
    expect(result.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );

    const detail = (await ctx.bus.invoke(
      IPC_CHANNELS.workbenchV2ProjectDetail,
      100,
      projectId,
    )) as { project: { region: string | null }; detail: { oldSiteContact: string | null; siteConfirmed: boolean } | null };
    expect(detail.project.region).toBe('West');
    expect(detail.detail?.oldSiteContact).toBe('旧址王工');
    expect(detail.detail?.siteConfirmed).toBe(false);
  });

  it('update_project 经 IPC：0810 标量（备注/暂存/是否批复/暂定数量/计划装机日期）保存并经 detail 回显', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'draft',
        customerName: 'IPC 标量客户',
        region: 'East',
        instrumentCount: null,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;

    const updated = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'update_project',
      payload: {
        projectId,
        projectNote: 'IPC 备注',
        temporaryStorageAddress: 'IPC 暂存仓',
        isTemporaryStorage: true,
        managerApproved: true,
        temporaryInstrumentCount: 4,
        temporaryInstrumentName: 'IPC 生化分析仪',
        temporaryInstrumentModel: 'IPC-BS200',
        temporaryHasUps: true,
        plannedInstallAt: '2026-09-15',
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    expect(updated.changed).toEqual({ projectId });

    const detail = (await ctx.bus.invoke(
      IPC_CHANNELS.workbenchV2ProjectDetail,
      100,
      projectId,
    )) as {
      project: { status: string; region: string | null; regionNeedsAdjustment: boolean };
      detail: {
        projectNote: string | null;
        temporaryStorageAddress: string | null;
        isTemporaryStorage: boolean | null;
        managerApproved: boolean | null;
        temporaryInstrumentCount: number | null;
        temporaryInstrumentName: string | null;
        temporaryInstrumentModel: string | null;
        temporaryHasUps: boolean | null;
        plannedInstallAt: string | null;
        plannedInstallDoneAt: string | null;
      } | null;
    };
    expect(detail.detail?.projectNote).toBe('IPC 备注');
    expect(detail.detail?.temporaryStorageAddress).toBe('IPC 暂存仓');
    expect(detail.detail?.isTemporaryStorage).toBe(true);
    expect(detail.detail?.managerApproved).toBe(true);
    expect(detail.detail?.temporaryInstrumentCount).toBe(4);
    expect(detail.detail?.temporaryInstrumentName).toBe('IPC 生化分析仪');
    expect(detail.detail?.temporaryInstrumentModel).toBe('IPC-BS200');
    expect(detail.detail?.temporaryHasUps).toBe(true);
    // 「计划装机日期」公开字段 + 兼容 alias 同值；主状态不被标量保存触发。
    expect(detail.detail?.plannedInstallAt).toBe('2026-09-15');
    expect(detail.detail?.plannedInstallDoneAt).toBe('2026-09-15');
    expect(detail.project.status).toBe('pending_entry');
    expect(detail.project.region).toBe('East');
    expect(detail.project.regionNeedsAdjustment).toBe(false);
  });

  it('batch 快速记录与 batch_edit 经 IPC：原子创建批次+费用、价格双口径、编辑不改变 appliedAt', async () => {
    const ctx = await loggedIn();
    const created = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: 'IPC 批次客户',
        ecc: 'ECC-BATCH-IPC',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '旧址',
        newSiteAddress: '新址',
        instrumentCount: 1,
        contractAmount: '1000',
        siteConfirmed: false,
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    const before = readBusinessRevision(ctx.db());

    // 快速记录搬迁批次：同一事务原子创建批次与物流费用（两个价格口径）
    const batched = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      projectId,
      action: {
        type: 'batch',
        projectId,
        values: {
          planTransportDate: '2026-08-10',
          transportCompany: 'IPC 运输',
          appliedAt: '2026-08-09',
          budgetPrice: '12000',
          dealPrice: '11000',
        },
      },
    } as WorkbenchV2MutationRequest)) as { businessRevision: number; invalidated: string[]; changed: { projectId: string } };
    expect(batched.businessRevision).toBeGreaterThan(before);
    expect(batched.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );

    const section = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2SectionPage, 100, {
      projectId,
      kind: 'batches',
    } as never)) as { rows: Array<{ id: string; originalPrice: string; discountedPrice: string; appliedAt: string | null }> };
    const batchId = section.rows[0].id;
    expect(section.rows[0].originalPrice).toBe('12000.00'); // 合同预算价 → batch.originalPriceCents
    expect(section.rows[0].discountedPrice).toBe('11000.00'); // 物流成交价 → batch.discountedPriceCents
    expect(section.rows[0].appliedAt).toBe('2026-08-09'); // batch row 可读 fee appliedAt（LEFT JOIN）

    const feeBefore = ctx
      .db()
      .prepare('SELECT applied_at FROM logistics_fees WHERE batch_id = ?')
      .get(batchId) as { applied_at: string };

    // batch_edit：修改批次字段与两个价格口径，返回 bounded 结果；未提交 appliedAt 保持现值
    const editBefore = readBusinessRevision(ctx.db());
    const edited = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'batch_edit',
      payload: {
        batchId,
        planTransportDate: '2026-08-12',
        transportCompany: '新运输',
        budgetPrice: '13000',
        dealPrice: '12500',
      },
    } as WorkbenchV2MutationRequest)) as {
      businessRevision: number;
      invalidated: string[];
      changed: { projectId: string; batchId: string };
    };
    expect(Object.keys(edited).sort()).toEqual(['businessRevision', 'changed', 'invalidated']);
    expect(edited.businessRevision).toBeGreaterThan(editBefore);
    expect(edited.changed).toEqual({ projectId, batchId });
    expect(edited.invalidated).toEqual(
      expect.arrayContaining(['overview', 'projects', `project:${projectId}`, `sections:${projectId}`]),
    );

    const editedSection = (await ctx.bus.invoke(IPC_CHANNELS.workbenchV2SectionPage, 100, {
      projectId,
      kind: 'batches',
    } as never)) as { rows: Array<{ originalPrice: string; discountedPrice: string }> };
    expect(editedSection.rows[0].originalPrice).toBe('13000.00');
    expect(editedSection.rows[0].discountedPrice).toBe('12500.00');

    const feeAfter = ctx
      .db()
      .prepare(
        'SELECT applied_at, budget_price_cents, deal_price_cents, logistics_cost_cents FROM logistics_fees WHERE batch_id = ?',
      )
      .get(batchId) as {
      applied_at: string;
      budget_price_cents: unknown;
      deal_price_cents: unknown;
      logistics_cost_cents: unknown;
    };
    // 未提交 appliedAt → 保持现值；dealPrice 同时覆盖 dealPriceCents 与 logisticsCostCents
    expect(feeAfter.applied_at).toBe(feeBefore.applied_at);
    expect(feeAfter.applied_at).toBe('2026-08-09');
    expect(String(feeAfter.budget_price_cents)).toBe('1300000');
    expect(String(feeAfter.deal_price_cents)).toBe('1250000');
    expect(String(feeAfter.logistics_cost_cents)).toBe('1250000');
  });
});

describe('IPC：受保护删除（v2Delete）与清理全部业务数据（cleanPrepare/cleanConfirm）', () => {
  async function loggedIn() {
    const dir = makeTempDir('ipc-delete-clean-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx;
  }

  it('v2Delete 经 IPC：成功返回 {ok:true,data}，删除二维码申请并返回 bounded 结果', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      action: { type: 'qr_request', values: { applicant: '申请人', requestedAt: '2026-08-10', types: ['A'] } },
    } as WorkbenchV2MutationRequest);
    const qrPage = (await bus.invoke(IPC_CHANNELS.workbenchV2IndependentPage, 100, { kind: 'qr_request' })) as {
      rows: Array<{ id: string }>;
    };
    const qrId = qrPage.rows[0].id;
    const revision = readBusinessRevision(ctx.db());
    const result = (await bus.invoke(IPC_CHANNELS.workbenchV2Delete, 100, {
      kind: 'qr_request',
      id: qrId,
      expectedRevision: revision,
    })) as { ok: true; data: { invalidated: string[]; changed: { kind: string } } };
    // 错误信封契约：成功路径为 { ok: true, data }
    expect(result.ok).toBe(true);
    expect(result.data.changed.kind).toBe('qr_request');
    expect(result.data.invalidated).toContain('independent:qr_request');
    const after = (await bus.invoke(IPC_CHANNELS.workbenchV2IndependentPage, 100, { kind: 'qr_request' })) as {
      total: number;
    };
    expect(after.total).toBe(0);
  });

  it('v2Delete 经 IPC：拒绝路径返回 {ok:false,error:{code,message}}（不依赖 Error 自定义属性穿透）', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    const result = (await bus.invoke(IPC_CHANNELS.workbenchV2Delete, 100, {
      kind: 'qr_request',
      id: 'whatever',
      expectedRevision: 12345,
    })) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('DELETE_REJECTED_REVISION');
    expect(typeof result.error.message).toBe('string');
    // 信封不含自定义 Error 属性：只有 {ok,error:{code,message}}
    expect(Object.keys(result.error).sort()).toEqual(['code', 'message']);
  });

  it('cleanPrepare/cleanConfirm 经 IPC：prepare 返回 {ok:true,data}，confirm 固定文本清理并保留账号', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '清理 IPC 客户',
        ecc: 'ECC-CLEAN-IPC',
        region: 'East',
        instrumentCount: 1,
        contractAmount: '1000',
      },
    } as WorkbenchV2MutationRequest);
    const prepared = (await bus.invoke(IPC_CHANNELS.dataCleanPrepare, 100)) as {
      ok: true;
      data: { token: string; revision: number; counts: Record<string, number> };
    };
    expect(prepared.ok).toBe(true);
    expect(prepared.data.counts.projects).toBe(1);
    const result = (await bus.invoke(IPC_CHANNELS.dataCleanConfirm, 100, {
      token: prepared.data.token,
      confirmText: '清理全部业务数据',
    })) as { ok: true; data: { clearedBusinessRows: number; contentGenerationId: string } };
    expect(result.ok).toBe(true);
    expect(result.data.clearedBusinessRows).toBeGreaterThan(0);
    const overview = (await bus.invoke(IPC_CHANNELS.workbenchV2Overview, 100)) as { metrics: { totalProjects: number } };
    expect(overview.metrics.totalProjects).toBe(0);
    // 账号保留（可继续会话）
    expect(ctx.session()).not.toBeNull();
  });

  it('cleanConfirm 经 IPC：错误 token 返回 {ok:false,error:{code}}（稳定错误码）', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    await bus.invoke(IPC_CHANNELS.dataCleanPrepare, 100);
    const result = (await bus.invoke(IPC_CHANNELS.dataCleanConfirm, 100, {
      token: 'wrong-token',
      confirmText: '清理全部业务数据',
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CLEAN_TOKEN_MISMATCH');
  });
});

describe('IPC：固定每页 20 与完整提醒/泳道读取（tasks 7.3/7.5/7.6）', () => {
  async function loggedIn() {
    const dir = makeTempDir('ipc-reminder-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx;
  }

  it('v2ProjectPage 经 IPC：固定每页 20（任意 limit 忽略），DTO 返回 pageSize=20', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    // 播种 25 个项目（直接 SQL，temp_no 唯一）
    const stmt = ctx.db().prepare(
      `INSERT INTO projects (id, temp_no, status, region, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 25; i++) {
      stmt.run(`ipc-p-${i}`, `TP-IPC-${String(i).padStart(3, '0')}`, 'pending_execution', 'East', 't', `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+08:00`);
    }
    // 任意 limit（含超大值）一律忽略，返回固定 20
    const page = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, {
      limit: 1000,
    } as never)) as { projects: unknown[]; total: number; limit: number; pageSize: number; nextCursor: string | null };
    expect(page.projects.length).toBe(20);
    expect(page.limit).toBe(20);
    expect(page.pageSize).toBe(20);
    expect(page.total).toBe(25);
    expect(page.nextCursor).toBeTruthy();
    // 第二页 5 条（末页少于 20）
    const last = (await bus.invoke(IPC_CHANNELS.workbenchV2ProjectPage, 100, {
      cursor: page.nextCursor,
    } as never)) as { projects: unknown[]; nextCursor: string | null };
    expect(last.projects.length).toBe(5);
    expect(last.nextCursor).toBeNull();
  });

  it('v2ReminderPage 经 IPC：默认降序、切换升序、keyset 分页', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    const seed = (id: string, at: string | null): void => {
      ctx.db().prepare(
        `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, `TP-${id}`, 'pending_execution', 'East', at, '备注', 't', 't');
    };
    seed('rm-1', '2026-08-05');
    seed('rm-2', '2026-08-10');
    seed('rm-3', '2026-08-16');

    const desc = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderPage, 100, {})) as {
      sort: string;
      rows: Array<{ projectId: string }>;
      total: number;
      nextCursor: string | null;
    };
    expect(desc.sort).toBe('desc');
    expect(desc.total).toBe(3);
    expect(desc.rows.map((r) => r.projectId)).toEqual(['rm-3', 'rm-2', 'rm-1']);

    const asc = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderPage, 100, { sort: 'asc' })) as {
      sort: string;
      rows: Array<{ projectId: string }>;
    };
    expect(asc.sort).toBe('asc');
    expect(asc.rows.map((r) => r.projectId)).toEqual(['rm-1', 'rm-2', 'rm-3']);

    // keyset 分页稳定：limit=2 拼接与一次性一致
    const first = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderPage, 100, { limit: 2 })) as {
      rows: Array<{ projectId: string }>;
      nextCursor: string | null;
    };
    const second = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderPage, 100, {
      limit: 2,
      cursor: first.nextCursor,
    })) as { rows: Array<{ projectId: string }> };
    expect([...first.rows, ...second.rows].map((r) => r.projectId)).toEqual(['rm-3', 'rm-2', 'rm-1']);
  });

  it('v2ReminderLanes 经 IPC：先日期后项目、同日归列、列内稳定、按列分页不改日期集合', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    const seed = (id: string, at: string): void => {
      ctx.db().prepare(
        `INSERT INTO projects (id, temp_no, status, region, reminder_at, reminder_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, `TP-${id}`, 'pending_execution', 'East', at, '备注', 't', 't');
    };
    for (let i = 0; i < 25; i++) {
      seed(`lane-${String(i).padStart(2, '0')}`, '2026-08-01');
    }
    seed('lane-other', '2026-08-10');

    const first = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderLanes, 100, { limit: 10 })) as {
      dates: string[];
      lanes: Array<{ date: string; projects: Array<{ projectId: string }>; total: number; nextCursor: string | null }>;
      lanePageSize: number;
    };
    expect(first.dates).toEqual(['2026-08-01', '2026-08-10']);
    expect(first.lanePageSize).toBe(10);
    const col = first.lanes.find((l) => l.date === '2026-08-01')!;
    expect(col.total).toBe(25);
    expect(col.projects.map((p) => p.projectId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `lane-${String(i).padStart(2, '0')}`),
    );

    const next = (await bus.invoke(IPC_CHANNELS.workbenchV2ReminderLanes, 100, {
      selectedDates: first.dates,
      date: '2026-08-01',
      cursor: col.nextCursor,
      limit: 10,
    })) as {
      dates: string[];
      lanes: Array<{ date: string; projects: Array<{ projectId: string }> }>;
    };
    expect(next.dates).toEqual(first.dates); // 推进列不改日期集合
    const nextCol = next.lanes.find((l) => l.date === '2026-08-01')!;
    expect(nextCol.projects.map((p) => p.projectId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `lane-${String(i + 10).padStart(2, '0')}`),
    );
  });
});

describe('IPC：中大型项目开单独立提交与非法关联（task 2.2）', () => {
  async function loggedIn() {
    const dir = makeTempDir('ipc-ml-order-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    await establishSession(ctx);
    return ctx;
  }

  it('submit_action 经 IPC：中大型开单独立提交（无 projectId）成功，省略日期默认业务当天，显式日期保持', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;
    const today = new SystemClock().today();

    // 1. 独立中大型开单提交：成功路径无任何 projectId，省略 orderedAt 默认业务当天
    const result = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      action: {
        type: 'order',
        values: {
          workScope: 'medium_large',
          orderType: 'relocation',
          serviceOrderNo: 'ML-IPC-001',
          customerName: '中大型客户IPC',
          engineer: '工程师甲',
        },
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId?: string } };
    expect(result.changed?.projectId).toBeUndefined();

    // 数据库校验：project_id 为 null，work_scope 为 medium_large，ordered_at 为业务当天
    const row = ctx.db().prepare('SELECT * FROM service_orders WHERE service_order_no = ?').get('ML-IPC-001') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.project_id).toBeNull();
    expect(row.work_scope).toBe('medium_large');
    expect(row.customer_name).toBe('中大型客户IPC');
    expect(row.ordered_at).toBe(today);

    // 历史分页查询：返回该中大型开单，workScope 为 medium_large，客户名为中大型客户IPC，businessDate 为业务当天
    const history = (await bus.invoke(IPC_CHANNELS.workbenchV2HistoryPage, 100, {
      kind: 'service_order',
    })) as { rows: Array<{ serviceOrderNo: string | null; workScope: string; customerName: string; projectId: string | null; businessDate: string }> };
    const histRow = history.rows.find((r) => r.serviceOrderNo === 'ML-IPC-001');
    expect(histRow).toBeDefined();
    expect(histRow!.workScope).toBe('medium_large');
    expect(histRow!.customerName).toBe('中大型客户IPC');
    expect(histRow!.projectId).toBeNull();
    expect(histRow!.businessDate).toBe(today);

    // 2. 显式提供日期保持
    await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'submit_action',
      action: {
        type: 'order',
        values: {
          workScope: 'medium_large',
          orderType: 'certification',
          serviceOrderNo: 'ML-IPC-002',
          customerName: '显式日期客户',
          orderedAt: '2026-08-15',
        },
      },
    } as WorkbenchV2MutationRequest);
    const row2 = ctx.db().prepare('SELECT ordered_at FROM service_orders WHERE service_order_no = ?').get('ML-IPC-002') as { ordered_at: string };
    expect(row2.ordered_at).toBe('2026-08-15');
  });

  it('submit_action 经 IPC：顶层请求携带 projectId、action 携带 projectId 或缺少客户单位被拒绝且失败零写入', async () => {
    const ctx = await loggedIn();
    const bus = ctx.bus;

    // 先创建一个真实项目供测试注入关联
    const created = (await bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '项目客户IPC',
        ecc: 'ECC-IPC-ORD',
        region: 'East',
        instrumentCount: 1,
        contractAmount: '1000',
      },
    } as WorkbenchV2MutationRequest)) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;

    const countBefore = (ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n;

    // 1. 顶层请求携带 projectId 配合 medium_large：不静默丢弃，领域服务拒绝且零写入
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        projectId,
        action: {
          type: 'order',
          values: {
            workScope: 'medium_large',
            orderType: 'relocation',
            serviceOrderNo: 'FAIL-IPC-TOP',
            customerName: '某客户',
            orderedAt: '2026-08-11',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'LARGE_PROJECT_ORDER_NO_PROJECT' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);

    // 2. action 显式塞入 projectId 配合 medium_large：领域服务拒绝且零写入
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: {
          type: 'order',
          projectId,
          values: {
            workScope: 'medium_large',
            orderType: 'relocation',
            serviceOrderNo: 'FAIL-IPC-ACT',
            customerName: '某客户',
            orderedAt: '2026-08-11',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'LARGE_PROJECT_ORDER_NO_PROJECT' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);

    // 3. medium_large 缺少客户单位：IPC 拒绝
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: {
          type: 'order',
          values: {
            workScope: 'medium_large',
            orderType: 'relocation',
            serviceOrderNo: 'FAIL-IPC-NAME',
            customerName: '',
            orderedAt: '2026-08-11',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NAME_REQUIRED' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);

    // 4. 显式空字符串 workScope: ''：由领域校验拒绝且零写入
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: {
          type: 'order',
          values: {
            workScope: '',
            orderType: 'pm',
            serviceOrderNo: 'FAIL-IPC-EMPTY-SCOPE',
            customerName: '某客户',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'ILLEGAL_WORK_SCOPE' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);

    // 5. 显式 null workScope: null：由领域校验拒绝且零写入
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: {
          type: 'order',
          values: {
            workScope: null,
            orderType: 'pm',
            serviceOrderNo: 'FAIL-IPC-NULL-SCOPE',
            customerName: '某客户',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'ILLEGAL_WORK_SCOPE' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);

    // 6. 显式非法字符串 workScope: 'illegal'：由领域校验拒绝且零写入
    await expect(
      bus.invoke(IPC_CHANNELS.workbenchV2Mutate, 100, {
        op: 'submit_action',
        action: {
          type: 'order',
          values: {
            workScope: 'illegal_scope',
            orderType: 'pm',
            serviceOrderNo: 'FAIL-IPC-VAL-SCOPE',
            customerName: '某客户',
          },
        },
      } as WorkbenchV2MutationRequest),
    ).rejects.toMatchObject({ code: 'ILLEGAL_WORK_SCOPE' });
    expect((ctx.db().prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(countBefore);
  });
});
