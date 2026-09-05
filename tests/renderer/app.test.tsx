// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ExcelJS from 'exceljs';
import { App } from '../../src/renderer/app';
import type {
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2IndependentRow,
  WorkbenchV2HistoryRow,
  WorkbenchV2HistoryPageDto,
  WorkbenchV2OverviewDto,
  ProjectTagCatalogDto,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionPageDto,
} from '../../src/shared/ipc';

const tagCatalog: ProjectTagCatalogDto = {
  businessRevision: 1,
  selectedTagIds: [],
  groups: [
    { id: 'group-type', name: '项目类型', sortOrder: 10, tags: [{ id: 'tag-move', groupId: 'group-type', name: '搬迁', sortOrder: 10 }, { id: 'tag-pm', groupId: 'group-type', name: 'PM', sortOrder: 20 }] },
    { id: 'group-instrument', name: '特殊仪器', sortOrder: 20, tags: [{ id: 'tag-icpms', groupId: 'group-instrument', name: 'ICPMS', sortOrder: 10 }, { id: 'tag-custom', groupId: 'group-instrument', name: '重点跟进', sortOrder: 20 }] },
  ],
};

function project(index: number): WorkbenchProjectRow {
  return {
    id: `p-${index}`, tempNo: `TMP-${String(index).padStart(6, '0')}`, ecc: `ECC-${String(index).padStart(6, '0')}`,
    customerName: `客户 ${index}`, status: index % 2 ? 'executing' : 'pending_entry', formallyEntered: index % 2 === 1,
    preEntryExecution: index % 2 === 0, region: index % 2 ? 'East' : 'North', regionNeedsAdjustment: false, entryAt: null,
    reminderAt: index < 3 ? '2026-08-08' : null, reminderNote: index < 3 ? `提醒 ${index}` : null,
    reminderDueClass: index < 3 ? 'today' : null, finalAmount: '100000.00', invoicedAmount: '40000.00', contractAmount: '110000.00', entryAmountSnapshot: null,
    counts: { batches: 1, instruments: 1, activities: 1, orders: 1, repairs: 0, invoices: 1 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: index === 1 ? ['tag-move', 'tag-icpms'] : [],
    groupedTags: index === 1 ? [
      { groupId: 'group-type', groupName: '项目类型', tagIds: ['tag-move'], tagNames: ['搬迁'] },
      { groupId: 'group-instrument', groupName: '特殊仪器', tagIds: ['tag-icpms'], tagNames: ['ICPMS'] },
    ] : [],
    updatedAt: '2026-08-08T08:00:00+08:00',
    planVisitAt: index === 1 ? '2026-08-16' : null,
  };
}

const firstProjects = Array.from({ length: 20 }, (_, index) => project(index + 1));
const secondProjects = Array.from({ length: 20 }, (_, index) => project(index + 21));
const overview: WorkbenchV2OverviewDto = {
  businessRevision: 1, generatedAt: '2026-08-08T09:00:00+08:00',
  metrics: { totalProjects: 100_000, activeProjects: 99_900, reminderCount: 200, reminderOverdue: 20, reminderToday: 30, pendingAcceptance: 12, pendingInvoice: 18, openRepairProjects: 7, pendingAmount: '123456.78' },
  stages: [
    { status: 'pending_entry', count: 20_000, averageDays: 3 },
    { status: 'pending_execution', count: 20_000, averageDays: 4 },
    { status: 'executing', count: 20_000, averageDays: 5 },
    { status: 'under_repair', count: 3_000, averageDays: 1 },
    { status: 'pending_acceptance', count: 15_000, averageDays: 2 },
    { status: 'pending_invoice', count: 15_000, averageDays: 2 },
    { status: 'completed', count: 10_000, averageDays: 1 },
  ],
  reminderPreview: firstProjects.slice(0, 3).map((row) => ({ projectId: row.id, customerName: row.customerName, ecc: row.ecc, tempNo: row.tempNo, reminderAt: row.reminderAt, reminderNote: row.reminderNote, reminderDueClass: row.reminderDueClass })),
  reminderTotal: 200, reminderWindowDays: 7,
};

function page(rows = firstProjects, cursor: string | null = 'cursor-2', total = 100_000, revision = 1): WorkbenchV2ProjectPageDto {
  return { businessRevision: revision, projects: rows, total, nextCursor: cursor, limit: 20, pageSize: 20 };
}

function section(kind: WorkbenchV2SectionPageDto['kind'], projectId = 'p-1'): WorkbenchV2SectionPageDto {
  const rows: WorkbenchV2SectionPageDto['rows'] = kind === 'instruments'
    ? Array.from({ length: 25 }, (_, index) => ({ kind: 'instruments' as const, id: `i-${index}`, projectId, batchId: null, name: `仪器 ${index}`, manufacturer: `产商 ${index}`, serviceLevel: index === 0 ? '金牌' : null, model: null, serialNo: `SN-${index}`, ups: false, qrRequested: false, destinationShipToId: null, createdAt: '2026-08-08T00:00:00Z' }))
    : kind === 'batches'
      ? [{ kind: 'batches' as const, id: 'batch-1', projectId, planTransportDate: '2026-08-18', transportCompany: '华东运输', appliedAt: '2026-08-09', originalPrice: '1000.00', discountedPrice: '900.00', startedAt: null, createdAt: '2026-08-08T00:00:00Z' } as Extract<WorkbenchV2SectionPageDto['rows'][number], { kind: 'batches' }> & { appliedAt: string | null }]
      : kind === 'orders'
        ? [{ kind: 'orders' as const, id: 'order-1', projectId, orderType: 'relocation' as const, serviceOrderNo: 'SO-100', orderedAt: '2026-08-08', engineer: '工程师甲', customerName: '客户 1', note: null, createdAt: '2026-08-08T00:00:00Z' }]
      : kind === 'invoices'
        ? [{ kind: 'invoices' as const, id: 'inv-1', projectId, amount: '40000.00', invoicedAt: '2026-08-08', active: true, revokedAt: null, revokeReason: null, lastModifiedAt: '2026-08-08T00:00:00Z', createdAt: '2026-08-08T00:00:00Z' }]
        : kind === 'damage_items'
          ? [{ kind: 'damage_items' as const, id: 'damage-1', projectId, instrumentId: 'i-1', instrumentName: '质谱仪', serialNo: 'SN-1', damageReason: '运输磕碰', issueStatus: 'untreated', partNumber: 'P-1', partQuantity: 1, partAmount: '100.00', partCurrency: 'USD', partStatus: 'processing', registeredAt: '2026-08-08', repairNote: null, createdAt: '2026-08-08T00:00:00Z' }]
        : [];
  return { businessRevision: 1, kind, projectId, rows, total: rows.length, nextCursor: null, limit: 50 };
}

function detailOf(projectRow: WorkbenchProjectRow | null): WorkbenchV2ProjectDetailDto {
  return {
    businessRevision: 1,
    project: projectRow,
    detail: {
      managerApprovalReason: null, managerApprovalMissing: null, managerApproved: null,
      projectNote: null, temporaryStorageAddress: null, isTemporaryStorage: null,
      oldSiteContact: null, newSiteContact: null,
      oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null,
      planVisitAt: null, planTransportAt: null, siteConfirmed: false, plannedInstallAt: null, plannedInstallDoneAt: null, actualInstallDoneAt: null,
      acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null,
      temporaryInstrumentCount: null, temporaryInstrumentName: null, temporaryInstrumentModel: null, temporaryHasUps: null, createdAt: '2026-08-01T00:00:00Z', customerId: 'c1', contractId: 'ct1',
    },
  };
}

function mockApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
    v2Overview: vi.fn().mockResolvedValue(overview),
    v2ProjectPage: vi.fn().mockImplementation((request: { cursor?: string | null }) => Promise.resolve(request.cursor ? page(secondProjects, null) : page())),
    v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => Promise.resolve({ businessRevision: 1, project: [...firstProjects, ...secondProjects].find((row) => row.id === projectId) ?? null, detail: { managerApprovalReason: null, managerApprovalMissing: null, managerApproved: null, projectNote: null, temporaryStorageAddress: null, isTemporaryStorage: null, oldSiteContact: null, newSiteContact: null, oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null, planVisitAt: null, planTransportAt: null, siteConfirmed: false, plannedInstallAt: null, plannedInstallDoneAt: null, actualInstallDoneAt: null, acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null, temporaryInstrumentCount: null, temporaryInstrumentName: null, temporaryInstrumentModel: null, temporaryHasUps: null, createdAt: '2026-08-01T00:00:00Z', customerId: 'c1', contractId: 'ct1' } })),
    v2SectionPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2SectionPageDto['kind']; projectId: string }) => Promise.resolve(section(request.kind, request.projectId))),
    v2HistoryPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2HistoryPageDto['kind'] }) => Promise.resolve({
      businessRevision: 1, kind: request.kind, total: 1, nextCursor: null, limit: 50,
      rows: request.kind === 'service_order' ? [{ kind: 'service_order' as const, id: 'order-1', projectId: 'p-1', customerName: '客户 1', ecc: 'ECC-000001', tempNo: 'TMP-000001', orderType: 'relocation' as const, serviceOrderNo: 'SO-100', orderedAt: '2026-08-08', engineer: '工程师甲', businessDate: '2026-08-08', createdAt: '2026-08-08T00:00:00Z' }] : [],
    })),
    v2ReminderPage: vi.fn().mockImplementation((request: { sort?: 'asc' | 'desc' | null; cursor?: string | null }) => Promise.resolve({
      businessRevision: 1, rows: overview.reminderPreview, total: overview.reminderTotal, nextCursor: request.cursor ? null : 'reminder-2', limit: 50, sort: request.sort ?? 'desc',
    })),
    v2ReminderLanes: vi.fn().mockResolvedValue({
      businessRevision: 1,
      dates: ['2026-08-08'],
      lanes: [{ date: '2026-08-08', projects: overview.reminderPreview.filter((item) => item.reminderAt === '2026-08-08').map((item) => ({ ...item, reminderAt: item.reminderAt! })), total: 3, nextCursor: null, limit: 50 }],
      lanePageSize: 50,
    }),
    v2TagCatalog: vi.fn().mockResolvedValue(tagCatalog),
    v2TagMutate: vi.fn().mockResolvedValue({ businessRevision: 2, group: tagCatalog.groups[0], invalidated: ['tag_catalog', 'projects', 'reminders', 'project:p-1'] }),
    v2IndependentPage: vi.fn().mockImplementation((request: { kind: string }) => Promise.resolve({ businessRevision: 1, kind: request.kind, rows: [], total: 0, nextCursor: null, limit: 50 })),
    v2LookupPage: vi.fn().mockImplementation((request: { kind: string }) => Promise.resolve({ businessRevision: 1, kind: request.kind, rows: [], total: 0, nextCursor: null, limit: 50 })),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1', 'sections:p-1'], changed: { projectId: 'p-1' } }),
    v2Delete: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: ['overview', 'projects', 'sections:p-1'], changed: { kind: 'service_order', id: 'order-1', projectId: 'p-1' } }),
    cleanPrepare: vi.fn().mockResolvedValue({ token: 'clean-token', expiresAt: Date.now() + 60_000, databaseInstanceId: 'db', contentGenerationId: 'gen', revision: 1, counts: { customers: 2, projects: 1, contracts: 0, batches: 0, instruments: 0, batch_change_history: 0, activities: 0, activity_engineers: 0, work_facts: 0, service_orders: 1, ship_tos: 0, ship_to_requests: 0, serial_address_updates: 0, damage_repair_items: 0, activity_damage_links: 0, qr_requests: 0, qr_request_types: 0, logistics_fees: 0, invoices: 0 }, auditCounts: { migrationAudit: 0, importRecordAudit: 0, importRun: 0 } }),
    cleanConfirm: vi.fn().mockResolvedValue({ clearedBusinessRows: 4, clearedAuditRows: 0, backupPath: '/tmp/clean.db', contentGenerationId: 'next', businessRevision: 2 }),
    backupManual: vi.fn().mockResolvedValue({ canceled: false, path: '/tmp/backup.db' }), restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true, restored: false }),
    buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [] }), drillDown: vi.fn().mockResolvedValue([]), exportReport: vi.fn().mockResolvedValue({ saved: true }),
    importWizard: { listDrafts: vi.fn().mockResolvedValue([]), createDraft: vi.fn(), openDraft: vi.fn(), deleteDraft: vi.fn(), saveStep: vi.fn(), downloadTemplate: vi.fn(), selectFiles: vi.fn(), pasteIntoCategory: vi.fn(), classifySheet: vi.fn(), setCategoryMode: vi.fn(), updateMapping: vi.fn(), queryRows: vi.fn(), patchCells: vi.fn(), addRow: vi.fn(), deleteRows: vi.fn(), validate: vi.fn(), saveConflictDecision: vi.fn(), cancelOperation: vi.fn(), summary: vi.fn(), commit: vi.fn(), settleInterrupted: vi.fn(), recover: vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: [] }), checkpoints: vi.fn(), undo: vi.fn(), redo: vi.fn(), onProgress: vi.fn().mockReturnValue(() => undefined) },
    ...overrides,
  };
  return api as unknown as WorkbenchApi;
}

beforeEach(() => { Object.defineProperty(window, 'workbench', { value: mockApi(), configurable: true }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openQuickAction(label: string): Promise<HTMLElement> {
  await screen.findByRole('row', { name: /^客户 1 / });
  fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
  const menu = screen.getByRole('dialog');
  fireEvent.click(within(menu).getByRole('button', { name: new RegExp(label) }));
  return screen.getByRole('dialog');
}

/** 二维码表单实时预览中「本条记录 / 去重类型 / 计入工作量」三个统计行的文本。 */
function qrStat(dialog: HTMLElement, label: string): string | null {
  return within(dialog).getByText(label).parentElement?.textContent ?? null;
}

describe('Oracle #10 bounded workbench renderer', () => {
  it('无密码模式渲染启动直接进入工作台：不出现初始化/登录界面，会话来自主进程', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '把每一次搬迁，推进得更稳' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '首次使用初始化' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '登录本地工作台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '使用恢复码重置密码' })).not.toBeInTheDocument();
    expect(api.getSession).toHaveBeenCalled();
  });

  it('100k total 只渲染当前固定 20 项', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    expect(await screen.findByRole('heading', { name: '项目队列 100000' })).toBeInTheDocument();
    expect(within(screen.getByRole('grid', { name: '项目队列' })).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('固定每页20 · 第 1–20 项 / 共 100000 项')).toBeInTheDocument();
    expect(screen.queryByText(/每页最多50项/)).not.toBeInTheDocument();
    expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.not.objectContaining({ limit: expect.anything() }));
  });

  it('项目队列显示上门时间列、日期与空值，并提供紧凑的完整查询提示', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const grid = await screen.findByRole('grid', { name: '项目队列' });
    expect(within(grid).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      '客户 / ECC', '主状态', '区域', '提醒', '上门时间↕', '批次 / 仪器', '累计掉票', '更新时间', '就近录入',
    ]);
    expect(within(await within(grid).findByRole('row', { name: /^客户 1 / })).getByText('2026-08-16')).toBeInTheDocument();
    expect(within(await within(grid).findByRole('row', { name: /^客户 2 / })).getByText('—')).toBeInTheDocument();
    expect(screen.getByLabelText('查找项目')).toHaveAttribute('placeholder', '客户 / ECC / 临时编号等');
    expect(screen.getByLabelText('查找项目')).toHaveAttribute('title', '支持客户、ECC、临时编号、单号、工程师及更多项目资料模糊查询');
  });

  it('上门时间表头可用键盘切换升降序，方向清晰且空值排序由主进程处理', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const grid = await screen.findByRole('grid', { name: '项目队列' });
    const header = within(grid).getByRole('columnheader', { name: /上门时间/ });
    const sort = within(header).getByRole('button', { name: /当前未排序/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    sort.focus(); fireEvent.keyDown(sort, { key: 'Enter' }); fireEvent.click(sort);
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, sort: 'visit_asc' })));
    expect(header).toHaveAttribute('aria-sort', 'ascending'); expect(sort).toHaveTextContent('升序 ↑');
    fireEvent.click(sort);
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, sort: 'visit_desc' })));
    expect(header).toHaveAttribute('aria-sort', 'descending'); expect(sort).toHaveTextContent('降序 ↓');
  });

  it('最新布局：顶部主导航直接显示标签库并打开全局标签库', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    const tagManagement = within(navigation).getByRole('button', { name: '标签库' });
    expect(tagManagement).toBeVisible();
    fireEvent.click(tagManagement);
    const dialog = screen.getByRole('dialog', { name: '管理标签库' });
    expect(await within(dialog).findByText('重点跟进')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/分组名称/), { target: { value: '客户层级' } }); fireEvent.click(within(dialog).getByRole('button', { name: '创建分组' }));
    await waitFor(() => expect(api.v2TagMutate).toHaveBeenCalledWith({ command: 'create_group', payload: { name: '客户层级' } }));
    await waitFor(() => expect(api.v2TagCatalog).toHaveBeenCalledTimes(2));
    fireEvent.change(within(dialog).getByLabelText(/所属分组/), { target: { value: 'group-type' } }); fireEvent.change(within(dialog).getByLabelText(/标签名称/), { target: { value: '重点项目' } }); fireEvent.click(within(dialog).getByRole('button', { name: '添加标签' }));
    await waitFor(() => expect(api.v2TagMutate).toHaveBeenCalledWith({ command: 'create_tag', payload: { groupId: 'group-type', name: '重点项目' } }));
    await waitFor(() => expect(api.v2TagCatalog).toHaveBeenCalledTimes(3));
  });

  it('标签分组和标签重命名使用稳定 ID payload，并按 bounded invalidation 刷新目录、队列、详情和提醒', async () => {
    let groupRenamed = false; let tagRenamed = false;
    const currentGroups = () => tagCatalog.groups.map((group) => group.id === 'group-type' ? {
      ...group,
      name: groupRenamed ? '业务类型' : group.name,
      tags: group.tags.map((tag) => tag.id === 'tag-move' ? { ...tag, name: tagRenamed ? '设备搬迁' : tag.name } : tag),
    } : group);
    const currentProject = () => ({
      ...project(1),
      groupedTags: [
        { groupId: 'group-type', groupName: groupRenamed ? '业务类型' : '项目类型', tagIds: ['tag-move'], tagNames: [tagRenamed ? '设备搬迁' : '搬迁'] },
        { groupId: 'group-instrument', groupName: '特殊仪器', tagIds: ['tag-icpms'], tagNames: ['ICPMS'] },
      ],
    });
    const api = mockApi({
      v2TagCatalog: vi.fn().mockImplementation(() => Promise.resolve({ businessRevision: tagRenamed ? 3 : groupRenamed ? 2 : 1, selectedTagIds: [], groups: currentGroups() })),
      v2ProjectPage: vi.fn().mockImplementation((request: { cursor?: string | null }) => Promise.resolve(request.cursor ? page(secondProjects, null) : page([currentProject(), ...firstProjects.slice(1)], 'cursor-2', 100_000, tagRenamed ? 3 : groupRenamed ? 2 : 1))),
      v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => {
        const row = projectId === 'p-1' ? currentProject() : [...firstProjects, ...secondProjects].find((item) => item.id === projectId) ?? null;
        return Promise.resolve({ ...detailOf(row), businessRevision: tagRenamed ? 3 : groupRenamed ? 2 : 1, groupedTags: row?.groupedTags ?? [] });
      }),
      v2TagMutate: vi.fn().mockImplementation((request: { command: string }) => {
        if (request.command === 'rename_group') groupRenamed = true; else tagRenamed = true;
        const groups = currentGroups();
        return Promise.resolve(request.command === 'rename_group'
          ? { businessRevision: 2, group: groups[0], invalidated: ['tag_catalog', 'projects', 'reminders'] }
          : { businessRevision: 3, tag: groups[0]!.tags[0], invalidated: ['tag_catalog', 'projects', 'reminders'] });
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('region', { name: '客户 1' }); fireEvent.click(screen.getByRole('button', { name: '标签库' }));
    const dialog = screen.getByRole('dialog', { name: '管理标签库' }); const groupCard = within(dialog).getByRole('heading', { name: '项目类型' }).closest('article')!;
    const queue = screen.getByRole('grid', { name: '项目队列' }); const context = screen.getByRole('complementary', { name: '当前上下文' }); const detail = screen.getByRole('region', { name: '客户 1' }); const detailTags = within(detail).getByRole('region', { name: '项目标签' });
    expect(within(groupCard).getByText('搬迁')).toBeInTheDocument(); expect(within(queue).getByRole('row', { name: /^客户 1 / })).toHaveTextContent('项目类型搬迁'); expect(context).toHaveTextContent('项目类型搬迁'); expect(detailTags).toHaveTextContent('项目类型搬迁');
    const catalogReads = vi.mocked(api.v2TagCatalog).mock.calls.length; const projectReads = vi.mocked(api.v2ProjectPage).mock.calls.length; const detailReads = vi.mocked(api.v2ProjectDetail).mock.calls.length; const reminderReads = vi.mocked(api.v2ReminderLanes).mock.calls.length;
    fireEvent.click(within(groupCard).getByRole('button', { name: '重命名分组' })); fireEvent.change(within(groupCard).getByLabelText(/新的分组名称/), { target: { value: '业务类型' } }); fireEvent.click(within(groupCard).getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(api.v2TagMutate).toHaveBeenCalledWith({ command: 'rename_group', payload: { groupId: 'group-type', name: '业务类型' } }));
    await waitFor(() => expect(vi.mocked(api.v2TagCatalog).mock.calls.length).toBeGreaterThan(catalogReads)); expect(vi.mocked(api.v2ProjectPage).mock.calls.length).toBeGreaterThan(projectReads); expect(vi.mocked(api.v2ProjectDetail).mock.calls.length).toBeGreaterThan(detailReads); expect(vi.mocked(api.v2ReminderLanes).mock.calls.length).toBeGreaterThan(reminderReads);
    await waitFor(() => { expect(within(dialog).getByRole('heading', { name: '业务类型' })).toBeInTheDocument(); expect(within(queue).getByRole('row', { name: /^客户 1 / })).toHaveTextContent('业务类型搬迁'); expect(context).toHaveTextContent('业务类型搬迁'); expect(detailTags).toHaveTextContent('业务类型搬迁'); });
    const moveTag = within(dialog).getByText('搬迁').closest('.tag-library-tag')!; fireEvent.click(within(moveTag as HTMLElement).getByRole('button', { name: '重命名标签搬迁' })); fireEvent.change(within(moveTag as HTMLElement).getByLabelText(/新的标签名称/), { target: { value: '设备搬迁' } }); fireEvent.click(within(moveTag as HTMLElement).getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(api.v2TagMutate).toHaveBeenCalledWith({ command: 'rename_tag', payload: { tagId: 'tag-move', name: '设备搬迁' } }));
    await waitFor(() => { const catalogGroup = within(dialog).getByRole('heading', { name: '业务类型' }).closest('article')!; expect(within(catalogGroup).getByText('设备搬迁')).toBeInTheDocument(); expect(within(queue).getByRole('row', { name: /^客户 1 / })).toHaveTextContent('业务类型设备搬迁'); expect(context).toHaveTextContent('业务类型设备搬迁'); expect(detailTags).toHaveTextContent('业务类型设备搬迁'); });
  });

  it('数据管理浮层脱离横向滚动导航，并支持 Escape 与外部点击关闭', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    const trigger = within(navigation).getByRole('button', { name: '数据管理' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ x: 640, y: 0, left: 640, top: 0, right: 730, bottom: 60, width: 90, height: 60, toJSON: () => ({}) });
    fireEvent.click(trigger);
    const menu = screen.getByRole('region', { name: '数据管理' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(navigation).not.toContainElement(menu);
    expect(menu).toHaveClass('data-menu-panel');
    await waitFor(() => expect(menu).toHaveStyle({ top: '66px', left: '640px', width: '192px' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: '数据管理' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('region', { name: '数据管理' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('region', { name: '数据管理' })).not.toBeInTheDocument();
  });

  it('新建项目按组键盘可达地同组与跨组多选，并提交全局自定义 tagIds', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' }); fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '标签客户' } }); fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    for (const name of ['搬迁', 'PM', '重点跟进']) { const checkbox = within(dialog).getByRole('checkbox', { name }); checkbox.focus(); expect(checkbox).toHaveFocus(); fireEvent.click(checkbox); }
    fireEvent.click(within(dialog).getByRole('radio', { name: /保存为待进单/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存为待进单' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project', payload: expect.objectContaining({ tagIds: ['tag-move', 'tag-pm', 'tag-custom'] }) })));
  });

  it('最新布局：提醒、项目工作区与项目队列依次显示，队列选择共享工作区状态', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const queue = await screen.findByRole('region', { name: /项目队列/ });
    const reminders = screen.getByRole('region', { name: /待办提醒/ });
    const workspace = screen.getByRole('region', { name: '项目工作区' });
    const context = await within(workspace).findByRole('complementary', { name: '当前上下文' });
    const detailTabs = within(workspace).getByRole('tablist', { name: '项目详情' });
    const detail = within(workspace).getByRole('region', { name: '客户 1' });
    expect(reminders.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(workspace.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(detailTabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const region of [queue, detail, context]) { expect(within(region).getByLabelText('项目分类标签')).toHaveTextContent('项目类型'); expect(within(region).getByLabelText('项目分类标签')).toHaveTextContent('ICPMS'); }
    expect(within(detail).queryByRole('tab', { name: '项目总览' })).not.toBeInTheDocument(); expect(within(detail).getByRole('tab', { name: '搬迁仪器' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(detail).getByRole('button', { name: '编辑客户 1的项目标签' })); const dialog = screen.getByRole('dialog', { name: '编辑项目标签' }); fireEvent.click(within(dialog).getByRole('checkbox', { name: '搬迁' })); fireEvent.click(within(dialog).getByRole('checkbox', { name: '重点跟进' })); fireEvent.click(within(dialog).getByRole('button', { name: '保存标签' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'update_project', payload: { projectId: 'p-1', tagIds: ['tag-icpms', 'tag-custom'] } }));
    const firstRow = within(queue).getByRole('row', { name: /^客户 1 / }); fireEvent.keyDown(firstRow, { key: 'ArrowDown' }); await waitFor(() => expect(workspace).toHaveTextContent('客户 2'));
    fireEvent.click(within(reminders).getByRole('button', { name: /客户 1/ }));
    await waitFor(() => expect(workspace).toHaveTextContent('客户 1'));
    fireEvent.click(screen.getByRole('button', { name: /执行中.*20000.*平均 5 天/ }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'executing' })));
  });

  it('切换项目后人工状态控件同步为当前项目状态', async () => {
    render(<App />);
    const queue = await screen.findByRole('region', { name: /项目队列/ });
    const status = await screen.findByLabelText('人工调整主状态');
    expect(status).toHaveValue('executing');
    fireEvent.change(status, { target: { value: 'pending_invoice' } });
    fireEvent.click(within(queue).getByRole('row', { name: /^客户 2 / }));
    await waitFor(() => expect(screen.getByLabelText('人工调整主状态')).toHaveValue('pending_entry'));
  });

  it('当前上下文标题为「项目状态」，人工调整下拉包含维修中选项', async () => {
    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    expect(within(context).getByRole('heading', { name: '项目状态' })).toBeInTheDocument();
    const status = within(context).getByLabelText('人工调整主状态');
    expect(within(status).getByRole('option', { name: '维修中' })).toBeInTheDocument();
    expect(within(status).getByRole('option', { name: '执行中' })).toBeInTheDocument();
  });

  it('编辑项目无任何变化时不发送空更新并给出正常反馈', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const detail = await screen.findByRole('region', { name: '客户 1' }); fireEvent.click(within(detail).getByRole('button', { name: '编辑项目资料' }));
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' }); fireEvent.click(within(dialog).getByRole('button', { name: '保存项目资料' }));
    expect(await within(dialog).findByText('没有需要保存的更改。')).toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalled();
  });

  it('恢复数据库会关闭旧状态并刷新标签目录，后续编辑不会清除恢复标签', async () => {
    const oldCatalog: ProjectTagCatalogDto = { businessRevision: 1, selectedTagIds: [], groups: [{ id: 'old-group', name: '旧分组', sortOrder: 1, tags: [{ id: 'old-tag', groupId: 'old-group', name: '旧目录标签', sortOrder: 1 }] }] };
    const restoredCatalog: ProjectTagCatalogDto = { businessRevision: 1, selectedTagIds: [], groups: [{ id: 'restored-group', name: '恢复分组', sortOrder: 1, tags: [{ id: 'restored-tag', groupId: 'restored-group', name: '恢复标签', sortOrder: 1 }] }] };
    const oldRow = { ...project(1), tagIds: ['old-tag'], groupedTags: [{ groupId: 'old-group', groupName: '旧分组', tagIds: ['old-tag'], tagNames: ['旧目录标签'] }] };
    const restoredRow = { ...project(1), customerName: '恢复客户', tagIds: ['restored-tag'], groupedTags: [{ groupId: 'restored-group', groupName: '恢复分组', tagIds: ['restored-tag'], tagNames: ['恢复标签'] }] };
    let restored = false;
    const api = mockApi({
      v2TagCatalog: vi.fn().mockImplementation(() => Promise.resolve(restored ? restoredCatalog : oldCatalog)),
      v2ProjectPage: vi.fn().mockImplementation(() => Promise.resolve(page([restored ? restoredRow : oldRow], null, 1))),
      v2ProjectDetail: vi.fn().mockImplementation(() => Promise.resolve({ ...detailOf(restored ? restoredRow : oldRow), tagIds: restored ? ['restored-tag'] : ['old-tag'], groupedTags: restored ? restoredRow.groupedTags : oldRow.groupedTags })),
      restoreFromBackup: vi.fn().mockImplementation(() => { restored = true; return Promise.resolve({ canceled: false, restored: true }); }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); vi.spyOn(window, 'confirm').mockReturnValue(true); render(<App />);
    await screen.findByRole('region', { name: '客户 1' }); fireEvent.click(screen.getByRole('button', { name: '标签库' }));
    const oldLibrary = screen.getByRole('dialog', { name: '管理标签库' }); expect(await within(oldLibrary).findByText('旧目录标签')).toBeInTheDocument(); fireEvent.click(within(oldLibrary).getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '数据管理' })); fireEvent.click(screen.getByRole('button', { name: '恢复备份' }));
    await waitFor(() => expect(api.v2TagCatalog).toHaveBeenCalledTimes(2));
    await screen.findByRole('region', { name: '恢复客户' }); fireEvent.click(screen.getByRole('button', { name: '标签库' }));
    const library = screen.getByRole('dialog', { name: '管理标签库' }); expect(await within(library).findByText('恢复标签')).toBeInTheDocument(); expect(within(library).queryByText('旧目录标签')).not.toBeInTheDocument(); fireEvent.click(within(library).getByRole('button', { name: '关闭' }));
    const editProject = screen.getByRole('button', { name: '编辑项目资料' });
    await waitFor(() => expect(editProject).not.toBeDisabled());
    fireEvent.click(editProject);
    const edit = screen.getByRole('dialog', { name: '编辑项目资料' }); expect(within(edit).queryByText('项目分类标签')).not.toBeInTheDocument(); expect(within(edit).queryByRole('checkbox', { name: '恢复标签' })).not.toBeInTheDocument(); fireEvent.change(within(edit).getByLabelText(/客户名称/), { target: { value: '恢复客户已核对' } }); fireEvent.click(within(edit).getByRole('button', { name: '保存项目资料' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'update_project', payload: { projectId: 'p-1', customerName: '恢复客户已核对' } }));
  });

  describe('八类登记记录逐类提供删除入口并调用对应 v2Delete kind', () => {
  const detailDeleteCases = [
    ['batch', '物流费用登记', 'batch-1'],
    ['instrument', '搬迁仪器', 'i-0'],
    ['service_order', '开单记录', 'order-1'],
    ['damage_repair_item', '申请与维修', 'damage-1'],
  ] as const;

  it.each(detailDeleteCases)('详情模块 %s 显示删除入口并调用正确 v2Delete kind/id', async (kind, tab, id) => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    const detailRegion = await screen.findByRole('region', { name: project(1).customerName });
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    const table = await within(detailRegion).findByRole('table');
    fireEvent.click(within(table).getAllByRole('button', { name: '删除' })[0]!);
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith({ kind, id, expectedRevision: 1 }));
  });

  const independentDeleteCases: ReadonlyArray<{
    kind: 'serial_address' | 'qr_request';
    label: string;
    id: string;
    row: WorkbenchV2IndependentRow;
  }> = [
    {
      kind: 'serial_address', label: '序列号地址更新', id: 'serial-1',
      row: { kind: 'serial_address', id: 'serial-1', instrumentId: null, instrumentName: '', serialNo: 'SN-1', customerName: '独立客户', newSiteAddress: '新址 A', accountId: 'AC-1', updatedAt: '2026-08-08', createdAt: '2026-08-08T00:00:00Z' },
    },
    {
      kind: 'qr_request', label: '二维码申请', id: 'qr-1',
      row: { kind: 'qr_request', id: 'qr-1', applicant: '负责人甲', requestedAt: '2026-08-08', types: ['A'], workload: 1, createdAt: '2026-08-08T00:00:00Z' },
    },
  ];

  it.each(independentDeleteCases)('独立模块 $kind 显示删除入口并调用正确 v2Delete kind/id', async ({ kind, label, id, row }) => {
    const api = mockApi({
      v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind, rows: [row], total: 1, nextCursor: null, limit: 50 }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: label }));
    const dialog = screen.getByRole('dialog', { name: label });
    fireEvent.click(await within(dialog).findByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith({ kind, id, expectedRevision: 1 }));
  });

  const historyDeleteCases: ReadonlyArray<{
    kind: 'acceptance' | 'ship_to_request';
    label: string;
    row: WorkbenchV2HistoryRow;
    request: Record<string, unknown>;
  }> = [
    {
      kind: 'acceptance', label: '验收报告',
      row: { kind: 'acceptance', id: 'p-1', projectId: 'p-1', customerName: '客户 1', ecc: 'ECC-000001', tempNo: 'TMP-000001', acceptanceReportDate: '2026-08-09', businessDate: '2026-08-09', createdAt: '2026-08-09T00:00:00Z' },
      request: { kind: 'acceptance', projectId: 'p-1', expectedRevision: 7 },
    },
    {
      kind: 'ship_to_request', label: 'Account ID 申请',
      row: { kind: 'ship_to_request', id: 'ship-1', projectId: 'p-1', customerName: '客户 1', ecc: null, tempNo: 'TMP-000001', newSiteAddress: '新址 A', status: 'processing', submittedAt: '2026-08-10', businessDate: '2026-08-10', createdAt: '2026-08-10T00:00:00Z' },
      request: { kind: 'ship_to_request', id: 'ship-1', expectedRevision: 7 },
    },
  ];

  it.each(historyDeleteCases)('历史抽屉 $kind 显示删除入口并调用正确 v2Delete kind/id', async ({ kind, label, row, request }) => {
    const api = mockApi({
      v2HistoryPage: vi.fn().mockImplementation((input: { kind: string }) => Promise.resolve({ businessRevision: 7, kind: input.kind, rows: input.kind === kind ? [row] : [], total: input.kind === kind ? 1 : 0, nextCursor: null, limit: 50 })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    fireEvent.click(within(dialog).getByRole('tab', { name: label }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith(request));
  });
  });

  it('阶段、提醒、区域和查询筛选下推并重置到首页 cursor', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /执行中.*20000.*平均 5 天/ }, { timeout: 5_000 }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: 'executing' })));
    fireEvent.change(screen.getByLabelText('提醒'), { target: { value: 'overdue' } }); fireEvent.change(screen.getByLabelText('区域'), { target: { value: 'East' } }); fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: 'ECC-9' } }); fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: 'executing', reminder: 'overdue', region: 'East', query: 'ECC-9' })));
  });

  it('未关闭维修事项作为独立筛选移到当前上下文的事项关注区，点击发送 repair open', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    expect(within(context).getByText('事项关注')).toBeInTheDocument();
    const repair = within(context).getByRole('button', { name: /未关闭维修事项.*7.*个项目/ });
    expect(repair).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(repair);
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: null, repair: 'open' })));
    expect(repair).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '全部项目' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('点击维修中主状态阶段发送 status=under_repair，与未关闭维修事项筛选互斥', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const stage = await screen.findByRole('button', { name: /维修中.*3000.*平均 1 天/ });
    fireEvent.click(stage);
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: 'under_repair' })));
    expect(stage).toHaveAttribute('aria-pressed', 'true');
    // 主状态阶段与独立事项筛选互斥：生命周期阶段行不再包含未关闭维修事项按钮
    expect(screen.queryByRole('button', { name: /未关闭维修事项.*独立事项筛选/ })).not.toBeInTheDocument();
    const context = screen.getByRole('complementary', { name: '当前上下文' });
    expect(within(context).getByRole('button', { name: /未关闭维修事项.*7.*个项目/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('项目列表仅在未关闭维修事项大于 0 时显示对应标签，且不影响主状态 badge', async () => {
    const rowWithRepair = { ...project(2), nonBlocking: { ...project(2).nonBlocking, repairs: 3 } };
    const api = mockApi({ v2ProjectPage: vi.fn().mockResolvedValue(page([project(1), rowWithRepair], null, 2)) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const grid = await screen.findByRole('grid', { name: '项目队列' });
    const rowWith = within(grid).getByRole('row', { name: /^客户 2 / });
    expect(within(rowWith).getByText('未关闭维修事项 3 条')).toBeInTheDocument();
    expect(within(rowWith).getByText('待进单')).toBeInTheDocument();
    const rowWithout = within(grid).getByRole('row', { name: /^客户 1 / });
    expect(within(rowWithout).queryByText(/未关闭维修事项/)).not.toBeInTheDocument();
  });

  it('项目分页使用 cursor 栈，旧页响应不能覆盖新筛选结果', async () => {
    const resolvers: Array<(value: WorkbenchV2ProjectPageDto) => void> = [];
    const api = mockApi({ v2ProjectPage: vi.fn().mockImplementation(() => new Promise<WorkbenchV2ProjectPageDto>((resolve) => resolvers.push(resolve))) }); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await waitFor(() => expect(resolvers).toHaveLength(1)); fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: '最新' } }); fireEvent.click(screen.getByRole('button', { name: '筛选' })); await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(page([project(999)], null, 1, 2)); expect((await screen.findAllByText('客户 999')).length).toBeGreaterThan(0); resolvers[0]!(page(firstProjects, 'cursor-2', 100_000, 1)); await new Promise((resolve) => setTimeout(resolve, 0)); expect(within(screen.getByRole('grid')).queryByText('客户 1')).not.toBeInTheDocument();
  });

  it('详情默认打开搬迁仪器并按需切换 section，不再显示项目总览 tab', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-1'));
    expect(screen.queryByRole('tab', { name: '项目总览' })).not.toBeInTheDocument(); expect(screen.getByRole('tab', { name: '搬迁仪器' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'instruments', limit: 50 })));
    fireEvent.click(screen.getByRole('tab', { name: '开单记录' })); await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'orders', limit: 50 })));
  });

  it('开单记录 tab 读取 orders，并只展示四个服务单字段', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('tab', { name: '开单记录' }));
    await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'orders' })));
    const table = screen.getByRole('columnheader', { name: '开单日期' }).closest('table')!;
    for (const name of ['开单日期', '工程师', '开单类型', '服务单号']) expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    expect(table).toHaveTextContent('SO-100'); expect(table).toHaveTextContent('工程师甲');
    expect(within(table).queryByRole('columnheader', { name: '客户名称' })).not.toBeInTheDocument();
  });

  it('费用与掉票在列表前展示金额事实，并显示掉票最后修改时间', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('tab', { name: '费用与掉票' }));
    const facts = await screen.findByLabelText('金额摘要');
    expect(facts).toHaveTextContent('合同金额USD 110,000.00');
    expect(facts).toHaveTextContent('进单金额快照待补');
    expect(facts).toHaveTextContent('最终可确认金额USD 100,000.00');
    expect(facts).toHaveTextContent('尚待掉票USD 60,000.00');
    const table = screen.getByRole('columnheader', { name: '最后修改时间' }).closest('table')!;
    expect(table).toHaveTextContent('2026/8/8');
  });

  it('Tab 上方常显关键摘要，完整项目资料默认折叠且保留全部分组与关联统计', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    const row = await screen.findByRole('row', { name: /^客户 1 / });
    fireEvent.click(within(row).getByText('客户 1'));
    const detail = screen.getByRole('region', { name: '客户 1' }); const summary = within(detail).getByLabelText('项目关键资料'); expect(summary).toHaveTextContent('项目状态执行中'); expect(summary).toHaveTextContent('地址流向待补 → 待补');
    const profile = within(detail).getByText('完整项目资料').closest('details')!; expect(profile).not.toHaveAttribute('open'); expect(profile.compareDocumentPosition(within(detail).getByRole('tablist', { name: '项目详情' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const group of ['基础资料', '搬迁安排', '设备与合同']) expect(within(profile).getByRole('region', { name: group })).toBeInTheDocument();
    expect(within(profile).getByRole('region', { name: '基础资料' })).toHaveTextContent('客户名称客户 1'); expect(within(profile).getByRole('region', { name: '搬迁安排' })).toHaveTextContent('旧址地址待补'); expect(within(profile).getByRole('region', { name: '设备与合同' })).toHaveTextContent('合同开始日期待补');
    const facts = within(profile).getByRole('region', { name: '关联登记事实' });
    for (const label of ['物流费用登记1 条', '搬迁仪器1 台', '上门活动1 条', '开单记录1 条', '损坏/维修事项0 条', '掉票记录1 条']) expect(facts).toHaveTextContent(label);
    expect(screen.queryByText(/序列号地址更新与二维码申请在独立模块按需加载/)).not.toBeInTheDocument();
    expect(screen.queryByText(/选择项目后，上方工作区会显示对应资料与记录/)).not.toBeInTheDocument();
  });

  it('仪器列表展示厂商和服务级别，便于核对导入结果', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('tab', { name: '搬迁仪器' }));
    const table = (await screen.findByRole('columnheader', { name: '仪器产商' })).closest('table')!;
    expect(within(table).getByRole('columnheader', { name: '服务级别' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: '二维码是否申请' })).not.toBeInTheDocument();
    expect(table).toHaveTextContent('产商 0'); expect(table).toHaveTextContent('金牌');
  });

  it('项目队列移除详情列，点击行直接切换下方项目详情', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const grid = await screen.findByRole('grid', { name: '项目队列' });
    const row = await within(grid).findByRole('row', { name: /^客户 2 / });
    expect(within(grid).queryByRole('columnheader', { name: '详情' })).not.toBeInTheDocument();
    expect(within(grid).queryByRole('button', { name: /查看.*详情/ })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByText('客户 2'));
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-2'));
    expect(screen.getByRole('region', { name: '客户 2' })).toHaveTextContent('ECC-000002');
  });

  it('mutation 仅走 v2Mutate，并按 tags 局部刷新', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); const beforeOverview = vi.mocked(api.v2Overview!).mock.calls.length; const beforeProjects = vi.mocked(api.v2ProjectPage!).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '维护提醒' })); fireEvent.change(screen.getByLabelText('备注内容'), { target: { value: '局部刷新' } }); fireEvent.click(screen.getByRole('button', { name: '保存当前提醒' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'set_reminder', projectId: 'p-1', reminderNote: '局部刷新' }))); await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(beforeOverview)); expect(vi.mocked(api.v2ProjectPage!).mock.calls.length).toBeGreaterThan(beforeProjects);
  });

  it('mutation 后项目被当前筛选移除时稳定选择并聚焦下一行', async () => {
    let reads = 0;
    const api = mockApi({ v2ProjectPage: vi.fn().mockImplementation(() => Promise.resolve(reads++ === 0 ? page([project(1)], null, 1) : page([project(2)], null, 1, 2))) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await within(await screen.findByRole('grid')).findByText('客户 1');
    fireEvent.click(screen.getByRole('button', { name: '维护提醒' })); fireEvent.change(screen.getByLabelText('备注内容'), { target: { value: '触发筛出' } }); fireEvent.click(screen.getByRole('button', { name: '保存当前提醒' }));
    const nextRow = await screen.findByRole('row', { name: /客户 2/ }); await waitFor(() => expect(nextRow).toHaveAttribute('aria-selected', 'true')); await waitFor(() => expect(nextRow).toHaveFocus());
  });

  it('动作选项只加载当前项目有界 section 页', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]); fireEvent.click(within(screen.getByRole('dialog')).getByText('损坏/维修事项', { selector: 'strong' }).closest('button')!);
    await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-1', kind: 'instruments', limit: 25 }))); expect(within(screen.getByRole('dialog')).getByLabelText(/搬迁仪器/).querySelectorAll('option').length).toBeLessThanOrEqual(26);
  });

  it('项目队列支持 roving focus 与方向/Home/End/Enter/Space/PageDown', async () => {
    render(<App />); const grid = await screen.findByRole('grid', { name: '项目队列' }); const rows = within(grid).getAllByRole('row').slice(1); rows[0]!.focus(); fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(rows[1]).toHaveFocus(); fireEvent.keyDown(rows[1]!, { key: 'Enter' }); expect(rows[1]).toHaveAttribute('aria-selected', 'true'); fireEvent.keyDown(rows[1]!, { key: 'End' }); expect(rows.at(-1)).toHaveFocus(); fireEvent.keyDown(rows.at(-1)!, { key: 'Home' }); expect(rows[0]).toHaveFocus(); fireEvent.keyDown(rows[0]!, { key: ' ' }); expect(rows[0]).toHaveAttribute('aria-selected', 'true'); fireEvent.keyDown(rows[0]!, { key: 'PageDown' }); expect(await screen.findByText('客户 21')).toBeInTheDocument();
  });

  it('仪器单行行内编辑五个字段，明确保存；失败保留编辑态并就地提示，成功退出', async () => {
    const api = mockApi(); vi.mocked(api.v2Mutate).mockRejectedValueOnce(new Error('序列号重复')); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const instrumentTable = (await screen.findByRole('columnheader', { name: '二维码' })).closest('table')!;
    fireEvent.click(within(instrumentTable).getAllByRole('button', { name: '编辑' })[0]!);
    expect(screen.queryByRole('dialog', { name: '编辑仪器资料' })).not.toBeInTheDocument();
    const row = within(instrumentTable).getByRole('row', { name: /仪器 0/ });
    expect(within(row).queryByRole('textbox', { name: '仪器名称' })).not.toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText('仪器厂商'), { target: { value: '新厂商' } });
    fireEvent.change(within(row).getByLabelText('型号'), { target: { value: '7900X' } });
    fireEvent.change(within(row).getByLabelText('服务级别'), { target: { value: '白金' } });
    fireEvent.change(within(row).getByLabelText('序列号'), { target: { value: 'SN-NEW' } });
    fireEvent.change(within(row).getByLabelText('是否 UPS'), { target: { value: 'true' } });
    fireEvent.blur(within(row).getByLabelText('型号')); expect(api.v2Mutate).not.toHaveBeenCalled();
    expect(within(instrumentTable).getAllByRole('button', { name: '正在编辑' })[0]).toBeDisabled();
    fireEvent.click(within(row).getByRole('button', { name: '保存' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('保存失败：序列号重复');
    expect(within(row).getByLabelText('序列号')).toHaveValue('SN-NEW');
    fireEvent.click(within(row).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenLastCalledWith({ op: 'instrument_update', payload: { instrumentId: 'i-0', manufacturer: '新厂商', model: '7900X', serviceLevel: '白金', serialNo: 'SN-NEW', ups: true, qrRequested: false, batchId: null } }));
    await waitFor(() => expect(within(instrumentTable).queryByLabelText('型号')).not.toBeInTheDocument());
  });

  it('开单编辑只发送备注，并支持清空已有备注', async () => {
    const orderPage = section('orders'); const notedPage = { ...orderPage, rows: orderPage.rows.map((row) => row.kind === 'orders' ? { ...row, note: '原备注' } : row) } as WorkbenchV2SectionPageDto;
    const api = mockApi({ v2SectionPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2SectionPageDto['kind']; projectId: string }) => Promise.resolve(request.kind === 'orders' ? notedPage : section(request.kind, request.projectId))) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('tab', { name: '开单记录' }));
    const orderTable = (await screen.findByRole('columnheader', { name: '备注' })).closest('table')!; fireEvent.click(within(orderTable).getByRole('button', { name: '修改备注' }));
    let dialog = screen.getByRole('dialog', { name: '维护开单备注' }); fireEvent.change(within(dialog).getByLabelText('备注'), { target: { value: '补充后的备注' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'service_order_note_update', payload: { orderId: 'order-1', note: '补充后的备注' } }));
    fireEvent.click(screen.getByRole('tab', { name: '开单记录' })); const refreshedTable = (await screen.findByRole('columnheader', { name: '备注' })).closest('table')!; fireEvent.click(within(refreshedTable).getByRole('button', { name: '修改备注' }));
    dialog = screen.getByRole('dialog', { name: '维护开单备注' }); fireEvent.click(within(dialog).getByRole('button', { name: '清空备注' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenLastCalledWith({ op: 'service_order_note_update', payload: { orderId: 'order-1', note: null } }));
  });

  it('验收事实不提供原位编辑，有后续依赖时明确保留原事实', async () => {
    const acceptance: WorkbenchV2HistoryRow = { kind: 'acceptance', id: 'p-1', projectId: 'p-1', customerName: '客户 1', ecc: 'ECC-000001', tempNo: 'TMP-000001', acceptanceReportDate: '2026-08-08', businessDate: '2026-08-08', createdAt: '2026-08-08T00:00:00Z' };
    const api = mockApi({ v2HistoryPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2HistoryPageDto['kind'] }) => Promise.resolve({ businessRevision: 1, kind: request.kind, rows: request.kind === 'acceptance' ? [acceptance] : [], total: request.kind === 'acceptance' ? 1 : 0, nextCursor: null, limit: 50 })) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' })); const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' }); fireEvent.click(within(dialog).getByRole('tab', { name: '验收报告' }));
    const row = await within(dialog).findByRole('row', { name: /客户 1.*验收报告/ }); expect(within(row).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument(); expect(row).toHaveTextContent('验收已有后续依赖时应保留原事实，当前不支持原位修改。'); expect(row).not.toHaveTextContent('从项目资料继续更正');
  });

  it('历史导入返回后刷新 overview 与项目首页并恢复入口焦点', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByText('数据管理')); const entry = screen.getByRole('button', { name: '历史数据导入' }); fireEvent.click(entry); expect(await screen.findByRole('heading', { name: '把旧数据整理成一份可核对的导入计划' })).toBeInTheDocument(); const before = vi.mocked(api.v2Overview!).mock.calls.length; fireEvent.click(screen.getByRole('button', { name: /返回数据管理/ })); await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(before)); await waitFor(() => expect(screen.getByRole('button', { name: '历史数据导入' })).toHaveFocus()); expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  });

  it('任务入口、运营指标、提醒、吞吐、上下文与队列形成分区，并显示项目状态色', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: '把每一次搬迁，推进得更稳' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今日工作台' })).toHaveTextContent('提醒、队列和关键事项，都在这里。');
    await waitFor(() => expect(screen.getByRole('region', { name: '关键运营指标' })).toHaveTextContent('活跃搬迁项目99900'));
    const lifecycle = screen.getByRole('region', { name: '生命周期吞吐' });
    expect(lifecycle).not.toHaveTextContent('当前瓶颈');
    expect(within(lifecycle).getByRole('button', { name: /待进单.*20000/ })).toHaveClass('stage', 'not-entered');
    expect(within(lifecycle).queryByText('客户 1')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '待办提醒 200' })).toHaveTextContent('按提醒日期查看需要跟进的项目');
    expect(screen.getByRole('grid', { name: '项目队列' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '当前上下文' })).toHaveClass('entered');
    expect(within(screen.getByRole('grid', { name: '项目队列' })).getByRole('row', { name: /^客户 1 / })).toHaveClass('project-status-executing');
  });

  it('上下文同时联动状态异常、提醒、项目备注与非阻塞事项，提醒可直达对应项目', async () => {
    const row = { ...project(1), preEntryExecution: true, reminderNote: '先联系现场', nonBlocking: { pendingShipTo: 2, qrUnmarked: 1, repairs: 3 } };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue({ businessRevision: 1, project: row, detail: { managerApprovalReason: null, managerApprovalMissing: null, managerApproved: null, projectNote: '客户要求周末作业', temporaryStorageAddress: null, isTemporaryStorage: null, oldSiteContact: null, newSiteContact: null, oldSiteAddress: null, newSiteAddress: null, contractStartDate: null, contractEndDate: null, planVisitAt: null, planTransportAt: null, siteConfirmed: false, plannedInstallAt: null, plannedInstallDoneAt: null, actualInstallDoneAt: null, acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null, temporaryInstrumentCount: null, temporaryInstrumentName: null, temporaryInstrumentModel: null, temporaryHasUps: null, createdAt: '', customerId: 'c1', contractId: 'ct1' } }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    expect(context).toHaveTextContent('未进单先执行');
    expect(context).toHaveTextContent('先联系现场');
    expect(context).toHaveTextContent('Account ID 待处理 2');
    expect(context).not.toHaveTextContent('二维码待标记');
    expect(context).toHaveTextContent('损坏/维修 3');
    expect(context).toHaveTextContent('2026-08-08');
    expect(context).not.toHaveTextContent('09:00');
    await waitFor(() => expect(within(context).getByLabelText('项目备注')).toHaveTextContent('客户要求周末作业'));
    fireEvent.click(within(screen.getByRole('region', { name: /待办提醒/ })).getByRole('button', { name: /客户 1/ }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ reminder: 'any', query: 'ECC-000001' })));
    expect(screen.getByRole('region', { name: /项目队列/ })).toHaveFocus();
  });

  it('项目备注为空时上下文卡片显示暂无备注', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    expect(within(context).getByLabelText('项目备注')).toHaveTextContent('暂无备注');
  });

  it('关闭项目弹层归还入口焦点，但不要求浏览器滚动页面', async () => {
    render(<App />);
    const opener = await screen.findByRole('button', { name: '新建搬迁项目' });
    await screen.findByRole('heading', { name: /项目队列/ });
    opener.focus();
    const focus = vi.spyOn(opener, 'focus');
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    await waitFor(() => expect(within(dialog).getByLabelText(/客户名称/)).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it('新建项目未修改时可直接关闭，修改后 Escape 先确认是否放弃', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    const customer = within(dialog).getByRole('textbox', { name: /客户名称.*必填/ });
    await waitFor(() => expect(customer).toHaveFocus());
    expect(within(dialog).getByText(/旧址、新址和设备范围均可后补/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radiogroup', { name: '保存意图' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /正式进单/ })).toBeChecked();
    expect(within(dialog).getByLabelText(/^ECC/)).toBeInTheDocument();
    const entryAt = within(dialog).getByLabelText(/^进单日期/);
    expect(entryAt).not.toBeDisabled();
    expect(entryAt).toHaveAccessibleDescription(/可留空.*当天日期/);
    expect(within(dialog).getByRole('spinbutton', { name: /合同 USD 含税金额/ })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/最终可确认金额/)).not.toBeInTheDocument();
    fireEvent.change(customer, { target: { value: '尚未保存的客户' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    const guard = screen.getByRole('alertdialog', { name: '放弃本次修改？' });
    await waitFor(() => expect(within(guard).getByRole('button', { name: '继续编辑' })).toHaveFocus());
    fireEvent.click(within(guard).getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(customer).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '放弃修改' }));
    expect(screen.queryByRole('dialog', { name: '新建搬迁项目' })).not.toBeInTheDocument();
  });

  it('新建搬迁项目默认正式进单，保存意图及选项按要求排序', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    const groups = ['保存意图', '项目与进单', '搬迁范围（均可后补）', '执行准备'].map((name) => within(dialog).getByRole('group', { name }));
    for (let index = 0; index < groups.length - 1; index += 1) expect(groups[index]!.compareDocumentPosition(groups[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const intentOptions = within(within(dialog).getByRole('radiogroup', { name: '保存意图' })).getAllByRole('radio');
    expect(intentOptions.map((option) => option.getAttribute('value'))).toEqual(['formal', 'draft', 'pre_entry_execution']);
    expect(intentOptions[0]).toBeChecked();
    const scope = within(dialog).getByRole('group', { name: '搬迁范围（均可后补）' });
    expect(within(scope).queryByLabelText(/暂定仪器名称/)).not.toBeInTheDocument();
    expect(within(scope).queryByLabelText(/暂定仪器数量/)).not.toBeInTheDocument();
    expect(within(scope).queryByLabelText(/暂定型号/)).not.toBeInTheDocument();
    expect(within(scope).getByRole('combobox', { name: /^UPS/ })).toHaveValue('');
    expect(within(scope).getByText('UPS 信息仅作为项目范围记录，不会生成仪器记录，可后补。')).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: '正式进单' });
    expect(save.closest('.layer-head')).not.toBeNull();
    expect(save).toHaveAttribute('form', 'project-create-form');
    expect(within(dialog).getByLabelText(/^计划装机日期/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('计划装机完成日期');
    expect(within(dialog).getByLabelText(/实际装机完成日期/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('后续通过搬迁仪器记录保存');
    expect(within(dialog).queryByRole('button', { name: '下一步' })).not.toBeInTheDocument();
  });

  it('保存意图分组实时展示摘要，并在正式进单合同金额为零时提示', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    const summary = within(dialog).getByLabelText('保存摘要');
    expect(summary).toHaveTextContent('客户名称未填写');
    expect(summary).toHaveTextContent('保存意图正式进单');
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '摘要客户' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^UPS/ }), { target: { value: 'true' } });
    expect(summary).toHaveTextContent('摘要客户');
    expect(summary).toHaveTextContent('UPS是');
    expect(summary).not.toHaveTextContent('暂定仪器');
    fireEvent.click(within(dialog).getByRole('radio', { name: /正式进单/ }));
    fireEvent.change(within(dialog).getByLabelText(/合同 USD 含税金额/), { target: { value: '0' } });
    const warning = within(dialog).getByRole('status');
    expect(warning).toHaveTextContent(/合同金额为 0 仍可正式进单/);
    expect(warning).toHaveTextContent(/最终可确认金额可暂空/);
    expect(warning).toHaveTextContent(/首次登记掉票前补录/);
    expect(warning).not.toHaveTextContent(/正式进单须另填/);
  });

  it('进单日期常显但仅正式进单可编辑，切换意图保留输入并进入正式进单 payload', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '意图切换客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    const entryAt = within(dialog).getByLabelText(/^进单日期/);
    expect(entryAt).not.toBeDisabled();
    expect(entryAt).toHaveAccessibleDescription(/可留空.*当天日期/);
    fireEvent.change(entryAt, { target: { value: '2026-08-09' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /保存为待进单/ }));
    expect(entryAt).toBeDisabled();
    expect(entryAt).toHaveValue('2026-08-09');
    expect(entryAt).toHaveAccessibleDescription(/仅正式进单时可填写/);
    fireEvent.click(within(dialog).getByRole('radio', { name: /正式进单/ }));
    expect(entryAt).not.toBeDisabled();
    expect(entryAt).toHaveValue('2026-08-09');
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-INTENT-DATE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '正式进单' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project', payload: expect.objectContaining({ intent: 'formal', entryAt: '2026-08-09' }) })));
  });

  it('正式进单可保留空进单日期，使后端按当天日期默认处理', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '默认日期客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /正式进单/ }));
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-DEFAULT-DATE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '正式进单' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project', payload: expect.objectContaining({ entryAt: undefined }) })));
  });

  it('新建项目由顶部主操作提交正式进单，保留 UPS 且不夹带已移除仪器范围字段', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });

    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '向导客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    fireEvent.change(within(dialog).getByLabelText(/旧址联系人/), { target: { value: '旧址王工' } });
    fireEvent.change(within(dialog).getByLabelText(/新址联系人/), { target: { value: '新址李工' } });
    fireEvent.change(within(dialog).getByLabelText(/旧址地址/), { target: { value: '旧址 A' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '新址 B' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^UPS/ }), { target: { value: 'true' } });

    expect(within(dialog).queryByLabelText(/服务单号|工程师|开单备注|缺失资料|最终可确认金额/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: /正式进单/ }));
    expect(within(dialog).getByRole('group', { name: '正式进单资料' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-WIZ-001' } });
    fireEvent.change(within(dialog).getByLabelText(/^进单日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(within(dialog).getByLabelText(/合同 USD 含税金额/), { target: { value: '120000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '正式进单' }));

    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'create_project',
      payload: expect.objectContaining({
        intent: 'formal', customerName: '向导客户', entryAt: '2026-08-09',
        oldSiteContact: '旧址王工', newSiteContact: '新址李工', contractStartDate: null, contractEndDate: null, ecc: 'ECC-WIZ-001',
        temporaryHasUps: true,
      }),
    })));
    const payload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload as unknown as Record<string, unknown>;
    for (const key of ['instrumentCount', 'temporaryInstrumentName', 'temporaryInstrumentCount', 'temporaryInstrumentModel']) expect(key in payload).toBe(false);
    expect(api.v2Mutate).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'instrument' }) }));
  });

  it('待进单通过顶部主操作提交 UPS 未填写三态，不提交已移除字段且不登记仪器', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '待进单范围客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'South' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /保存为待进单/ }));
    const save = within(dialog).getByRole('button', { name: '保存为待进单' });
    expect(save.closest('.layer-head')).not.toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'create_project',
      payload: expect.objectContaining({ intent: 'draft', temporaryHasUps: null }),
    })));
    const payload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload as unknown as Record<string, unknown>;
    for (const key of ['instrumentCount', 'temporaryInstrumentName', 'temporaryInstrumentCount', 'temporaryInstrumentModel']) expect(key in payload).toBe(false);
    expect(api.v2Mutate).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'instrument' }) }));
  });

  it('待进单保留可空进单日期，不渲染其余正式字段，未进单先执行只记录是否批复 boolean', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '待进单客户' } }); fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /保存为待进单/ }));
    expect(within(dialog).queryByRole('textbox', { name: /^ECC/ })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^进单日期/)).toBeDisabled();
    expect(within(dialog).queryByRole('spinbutton', { name: /合同 USD 含税金额/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: /未进单先执行/ }));
    const approval = within(dialog).getByRole('combobox', { name: /是否批复/ });
    expect(approval).toBeRequired();
    expect(within(dialog).queryByLabelText(/批复说明|缺失资料/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^UPS/ }), { target: { value: 'false' } });
    fireEvent.change(approval, { target: { value: 'false' } }); fireEvent.click(within(dialog).getByRole('button', { name: '未进单先执行' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project', payload: expect.objectContaining({ intent: 'pre_entry_execution', managerApproved: false, temporaryHasUps: false }) })));
    const payload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload as unknown as Record<string, unknown>;
    for (const key of ['ecc', 'entryAt', 'contractAmount', 'finalAmount', 'serviceOrderNo', 'engineers', 'serviceOrderNote', 'missingItems', 'instrumentCount', 'temporaryInstrumentName', 'temporaryInstrumentCount', 'temporaryInstrumentModel']) expect(key in payload).toBe(false);
  });

  it('新建契约拒绝只展示稳定中文，不暴露技术错误码', async () => {
    const api = mockApi({ v2Mutate: vi.fn().mockRejectedValue(new Error('WIZARD_CONTRACT_AMOUNT_ONLY_FORMAL: invalid payload')) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' }); fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '错误客户' } }); fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } }); fireEvent.click(within(dialog).getByRole('radio', { name: /保存为待进单/ })); fireEvent.click(within(dialog).getByRole('button', { name: '保存为待进单' }));
    const alert = await within(dialog).findByRole('alert'); expect(alert).toHaveTextContent('合同金额仅可在正式进单时提交'); expect(alert).not.toHaveTextContent('WIZARD_');
  });

  it('快速记录合并开单入口，八类动作均提供真实字段', async () => {
    render(<App />); await screen.findByRole('row', { name: /^客户 1 / });
    const labels = ['物流费用登记', '搬迁仪器', '开单记录', '验收报告', '掉票', 'Account ID 申请', '损坏/维修事项', '补齐进单核心资料'];
    for (const label of labels) {
      fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
      const menu = screen.getByRole('dialog');
      expect(within(menu).getAllByRole('button')).toHaveLength(9);
      expect(menu).toHaveTextContent('这里保存的记录均关联当前项目');
      expect(menu).toHaveTextContent('四类开单都会显示在项目开单记录中');
      expect(menu).toHaveTextContent('认证、单寄备件和 PM 仅作项目归档，不影响搬迁进度');
      expect(menu).not.toHaveTextContent('实际物流费用');
      expect(within(menu).queryByRole('button', { name: '二维码申请' })).not.toBeInTheDocument();
      expect(within(menu).getByText(/二维码申请位于独立导航/)).toBeInTheDocument();
      if (label === '搬迁仪器') expect(menu).toHaveTextContent('名称、型号、序列号与 UPS');
      fireEvent.click(within(menu).getByText(label, { selector: 'strong' }).closest('button')!);
      const form = screen.getByRole('dialog');
      expect(form.querySelectorAll('input,select').length, label).toBeGreaterThan(0);
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('物流费用登记五项均可留空保存，空金额按空值提交而不是 0', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const dialog = await openQuickAction('物流费用登记');
    expect(dialog).toHaveTextContent('可先保存现有信息');
    for (const label of ['运输日期', '运输公司', '费用登记日期', '合同预算价', '物流成交价']) {
      const field = within(dialog).getByLabelText(new RegExp(label));
      expect(field).not.toBeRequired();
      expect(field).not.toHaveAttribute('min');
    }
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'submit_action', action: {
        type: 'batch', projectId: 'p-1', values: { planTransportDate: '', transportCompany: '', appliedAt: '', budgetPrice: '', dealPrice: '' },
      },
    })));
    const values = (vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0] as unknown as { action?: { values: Record<string, unknown> } }).action?.values;
    expect(values?.budgetPrice).not.toBe(0); expect(values?.dealPrice).not.toBe(0);
  });

  it('开单、合并批次、仪器与损坏维修表单给出对应字段约束和就地反馈', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    let dialog = await openQuickAction('开单记录');
    const orderNo = within(dialog).getByRole('textbox', { name: /服务单号.*必填/ }); const engineer = within(dialog).getByRole('textbox', { name: /工程师.*可后补/ });
    expect(orderNo).toHaveAccessibleDescription(/当前项目的开单记录/); expect(engineer).toHaveAccessibleDescription(/可留空后补/);
    expect(within(dialog).getByLabelText(/开单类型/)).toHaveAccessibleDescription(/仅作项目归档，不影响搬迁进度/);
    expect(within(dialog).getByLabelText(/开单类型/).querySelectorAll('option')).toHaveLength(4);
    for (const label of ['搬迁', '认证', '单寄备件', 'PM']) expect(within(dialog).getByRole('option', { name: label })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/客户名称|客户单位/)).not.toBeInTheDocument();
    fireEvent.change(orderNo, { target: { value: 'SO-100' } }); fireEvent.change(engineer, { target: { value: '工程师甲' } }); fireEvent.change(within(dialog).getByLabelText(/开单日期/), { target: { value: '2026-08-08' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'order', values: expect.objectContaining({ serviceOrderNo: 'SO-100', engineer: '工程师甲' }) }) })));
    dialog = await openQuickAction('物流费用登记');
    const planDate = within(dialog).getByLabelText(/运输日期.*可后补/);
    const company = within(dialog).getByLabelText(/运输公司.*可后补/);
    const appliedAt = within(dialog).getByLabelText(/费用登记日期.*可后补/);
    const budget = within(dialog).getByRole('spinbutton', { name: /合同预算价.*可后补/ });
    const deal = within(dialog).getByRole('spinbutton', { name: /物流成交价.*可后补/ });
    expect(planDate).not.toBeRequired(); expect(company).not.toBeRequired(); expect(appliedAt).not.toBeRequired();
    expect(budget).not.toBeRequired(); expect(deal).not.toBeRequired(); expect(budget).not.toHaveAttribute('min'); expect(deal).not.toHaveAttribute('min');
    expect(budget).toHaveAccessibleDescription(/大于 0/); expect(deal).toHaveAccessibleDescription(/不小于 0/);
    fireEvent.change(company, { target: { value: '华东运输' } }); fireEvent.change(budget, { target: { value: '100' } }); fireEvent.change(deal, { target: { value: '120' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('物流成交价高于合同预算价');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'submit_action', action: {
        type: 'batch', projectId: 'p-1', values: { planTransportDate: '', transportCompany: '华东运输', appliedAt: '', budgetPrice: '100', dealPrice: '120' },
      },
    })));
    dialog = await openQuickAction('搬迁仪器');
    expect(within(dialog).queryByLabelText(/二维码是否申请/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/仪器名称.*必填/), { target: { value: '质谱仪' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({
      op: 'submit_action', action: expect.objectContaining({ type: 'instrument', values: expect.not.objectContaining({ qrRequested: expect.anything() }) }),
    })));
    fireEvent.keyDown(document, { key: 'Escape' });
    dialog = await openQuickAction('损坏/维修事项');
    expect(within(dialog).getByRole('spinbutton', { name: /备件金额.*必填/ })).toHaveAccessibleDescription(/合同金额为 0 时占比不可计算/);
  });

  it('搬迁仪器严格解析中文表头并整批提交有效 Excel 行', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('仪器');
    sheet.addRow(['序列号', '仪器名称', '服务级别', '仪器产商', '仪器型号']);
    sheet.addRow(['SN-1', '质谱仪', '金牌', '产商甲', 'MS-9']);
    const buffer = await workbook.xlsx.writeBuffer();
    const file = new File([buffer], '仪器清单.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockResolvedValue(buffer) });
    const dialog = await openQuickAction('搬迁仪器');
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Excel 批量导入' }));
    fireEvent.change(within(dialog).getByLabelText('选择 .xlsx 文件'), { target: { files: [file] } });
    expect(await within(dialog).findByText('有效行数：1')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认导入 1 行' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'instrument_bulk_import', payload: { projectId: 'p-1', rows: [{ name: '质谱仪', manufacturer: '产商甲', model: 'MS-9', serialNo: 'SN-1', serviceLevel: '金牌' }] } }));
  });

  it('损坏事项保留名称和序列号，并可逐行更新维修状态', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('row', { name: /^客户 1 / });
    fireEvent.click(screen.getByRole('tab', { name: '申请与维修' }));
    const update = await screen.findByRole('button', { name: '更新维修状态' });
    expect(update.closest('tr')).toHaveTextContent('质谱仪'); expect(update.closest('tr')).toHaveTextContent('SN-1');
    fireEvent.click(update);
    const dialog = screen.getByRole('dialog', { name: '更新维修状态' });
    fireEvent.change(within(dialog).getByLabelText(/维修状态/), { target: { value: 'processing' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存维修状态' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'damage_update', damageId: 'damage-1', issueStatus: 'processing' }));
  });

  it('更新损坏事项为未修复关闭时必须提交关闭原因', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('row', { name: /^客户 1 / }); fireEvent.click(screen.getByRole('tab', { name: '申请与维修' }));
    fireEvent.click(await screen.findByRole('button', { name: '更新维修状态' }));
    const dialog = screen.getByRole('dialog', { name: '更新维修状态' });
    fireEvent.change(within(dialog).getByLabelText(/维修状态/), { target: { value: 'closed_unrepaired' } });
    const reason = within(dialog).getByLabelText(/关闭原因.*必填/); expect(reason).toBeRequired();
    fireEvent.change(reason, { target: { value: '客户决定不再维修' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存维修状态' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'damage_update', damageId: 'damage-1', issueStatus: 'closed_unrepaired', closeReason: '客户决定不再维修' }));
  });

  it('新增损坏事项选择未修复关闭时要求关闭原因并随动作提交', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const dialog = await openQuickAction('损坏/维修事项');
    fireEvent.change(within(dialog).getByLabelText(/损坏原因/), { target: { value: '运输磕碰' } });
    fireEvent.change(within(dialog).getByLabelText(/备件号/), { target: { value: 'P-2' } });
    fireEvent.change(within(dialog).getByLabelText(/^数量/), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByLabelText(/备件金额/), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText(/登记日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(within(dialog).getByLabelText(/事项处理状态/), { target: { value: 'closed_unrepaired' } });
    const reason = within(dialog).getByLabelText(/关闭原因.*必填/); fireEvent.change(reason, { target: { value: '无维修价值' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'damage', values: expect.objectContaining({ issueStatus: 'closed_unrepaired', closeReason: '无维修价值' }) }) })));
  });

  it('补齐进单资料使用原子 supplement_project，不夹带独立开单字段', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const dialog = await openQuickAction('补齐进单核心资料');
    const contractAmount = within(dialog).getByLabelText(/合同 USD/);
    expect(contractAmount).toHaveAccessibleDescription(/合同金额为 0 仍可正式进单/);
    expect(contractAmount).toHaveAccessibleDescription(/最终可确认金额可暂空/);
    expect(contractAmount).toHaveAccessibleDescription(/首次登记掉票前补录/);
    expect(dialog).not.toHaveTextContent(/正式进单须另填/);
    fireEvent.change(within(dialog).getByLabelText(/仪器数量/), { target: { value: '8' } });
    fireEvent.change(within(dialog).getByLabelText(/^计划装机日期/), { target: { value: '2026-09-01' } });
    fireEvent.change(within(dialog).getByLabelText(/实际装机完成日期/), { target: { value: '2026-09-02' } });
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-8' } });
    fireEvent.change(within(dialog).getByLabelText(/进单日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(contractAmount, { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记录' }));
    expect(within(dialog).queryByLabelText(/服务单号|工程师|开单备注/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'supplement_project', payload: expect.objectContaining({ projectId: 'p-1', instrumentCount: 8, plannedInstallDoneAt: '2026-09-01', actualInstallDoneAt: '2026-09-02', ecc: 'ECC-8' }) })));
    const payload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload;
    expect(payload).toBeDefined();
    if (!payload) throw new Error('缺少 supplement payload');
    for (const key of ['oldSiteContact', 'newSiteContact', 'oldSiteAddress', 'newSiteAddress', 'plannedVisitAt', 'plannedTransportAt', 'siteConfirmed', 'serviceOrderNo', 'engineers', 'serviceOrderNote']) expect(key in payload).toBe(false);
  });

  it('队列行、上下文和详情 Tab 都提供绑定当前项目的就近录入入口', async () => {
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '为客户 2快速记录' }));
    expect(screen.getByRole('dialog', { name: '快速记录' })).toHaveTextContent('这里保存的记录均关联当前项目');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(screen.getByRole('grid', { name: '项目队列' })).getByRole('row', { name: /^客户 2 / })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(screen.getByRole('complementary', { name: '当前上下文' })).getByRole('button', { name: '快速记录' }));
    expect(screen.getByRole('dialog', { name: '快速记录' })).toBeInTheDocument(); fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('tab', { name: '搬迁仪器' })); await waitFor(() => expect(screen.getByRole('tab', { name: '搬迁仪器' })).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByRole('button', { name: '就近记录' }));
    expect(screen.getByRole('dialog', { name: '搬迁仪器' })).toBeInTheDocument();
  });

  it('提交期间禁用并拦截重复保存，成功后显示 toast 且同步刷新失效数据', async () => {
    let resolveMutation!: (value: Awaited<ReturnType<NonNullable<WorkbenchApi['v2Mutate']>>>) => void;
    const api = mockApi({ v2Mutate: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; })) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const dialog = await openQuickAction('物流费用登记'); const save = within(dialog).getByRole('button', { name: '保存记录' }); const form = document.getElementById(save.getAttribute('form')!) as HTMLFormElement;
    expect(save.closest('.layer-head')).not.toBeNull();
    expect(form).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/运输日期/), { target: { value: '2026-08-18' } });
    fireEvent.change(within(dialog).getByLabelText(/费用登记日期/), { target: { value: '2026-08-09' } });
    fireEvent.change(within(dialog).getByLabelText(/合同预算价/), { target: { value: '100' } });
    fireEvent.change(within(dialog).getByLabelText(/物流成交价/), { target: { value: '90' } });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.v2Mutate).toHaveBeenCalledTimes(1); expect(save).toBeDisabled();
    const before = vi.mocked(api.v2Overview!).mock.calls.length;
    resolveMutation({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1'], changed: { projectId: 'p-1' } });
    expect(await screen.findByText('业务记录已保存')).toHaveAttribute('role', 'status');
    await waitFor(() => expect(vi.mocked(api.v2Overview!).mock.calls.length).toBeGreaterThan(before));
  });

  it('物流费用编辑回显全部五项，未改的 appliedAt 按原值提交并可清空其他字段', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('row', { name: /^客户 1 / });
    fireEvent.click(screen.getByRole('tab', { name: '物流费用登记' }));
    const budgetHeading = await screen.findByRole('columnheader', { name: '合同预算价' });
    const table = budgetHeading.closest('table')!;
    expect(table).toHaveTextContent('合同预算价'); expect(table).toHaveTextContent('物流成交价');
    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑物流费用记录' });
    expect(dialog).not.toHaveTextContent('费用登记日期保持首次登记月份');
    expect(dialog).toHaveTextContent('修改费用登记日期会影响报表归属月份');
    expect(within(dialog).getByLabelText(/运输日期/)).toHaveValue('2026-08-18');
    expect(within(dialog).getByLabelText(/运输公司/)).toHaveValue('华东运输');
    expect(within(dialog).getByLabelText(/费用登记日期/)).toHaveValue('2026-08-09');
    expect(within(dialog).getByLabelText(/合同预算价/)).toHaveValue(1000);
    expect(within(dialog).getByLabelText(/物流成交价/)).toHaveValue(900);
    fireEvent.change(within(dialog).getByLabelText(/运输日期/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/运输公司/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/合同预算价/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/物流成交价/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次修改' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'batch_edit', payload: { batchId: 'batch-1', planTransportDate: null, transportCompany: null, appliedAt: '2026-08-09', budgetPrice: null, dealPrice: null },
    }));
  });

  it('物流费用编辑兼容 null 回显并可补录全部五项', async () => {
    const nullableBatchPage = { ...section('batches'), rows: [{ kind: 'batches', id: 'batch-1', projectId: 'p-1', planTransportDate: null, transportCompany: null, appliedAt: null, originalPrice: null, discountedPrice: null, startedAt: null, createdAt: '2026-08-08T00:00:00Z' }] } as unknown as WorkbenchV2SectionPageDto;
    const api = mockApi({ v2SectionPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2SectionPageDto['kind']; projectId: string }) => Promise.resolve(request.kind === 'batches' ? nullableBatchPage : section(request.kind, request.projectId))) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('row', { name: /^客户 1 / }); fireEvent.click(screen.getByRole('tab', { name: '物流费用登记' }));
    const table = (await screen.findByRole('columnheader', { name: '合同预算价' })).closest('table')!; fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑物流费用记录' });
    for (const label of ['运输日期', '运输公司', '费用登记日期', '合同预算价', '物流成交价']) expect(within(dialog).getByLabelText(new RegExp(label))).toHaveValue(label.includes('价') ? null : '');
    fireEvent.change(within(dialog).getByLabelText(/运输日期/), { target: { value: '2026-08-20' } }); fireEvent.change(within(dialog).getByLabelText(/运输公司/), { target: { value: '华南运输' } }); fireEvent.change(within(dialog).getByLabelText(/费用登记日期/), { target: { value: '2026-09-01' } }); fireEvent.change(within(dialog).getByLabelText(/合同预算价/), { target: { value: '1100' } }); fireEvent.change(within(dialog).getByLabelText(/物流成交价/), { target: { value: '950' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次修改' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'batch_edit', payload: { batchId: 'batch-1', planTransportDate: '2026-08-20', transportCompany: '华南运输', appliedAt: '2026-09-01', budgetPrice: '1100', dealPrice: '950' } }));
  });

  it('物流费用编辑可显式清空费用登记日期', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('row', { name: /^客户 1 / }); fireEvent.click(screen.getByRole('tab', { name: '物流费用登记' }));
    const table = (await screen.findByRole('columnheader', { name: '合同预算价' })).closest('table')!; fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = screen.getByRole('dialog', { name: '编辑物流费用记录' }); fireEvent.change(within(dialog).getByLabelText(/费用登记日期/), { target: { value: '' } }); fireEvent.click(within(dialog).getByRole('button', { name: '保存批次修改' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'batch_edit', payload: { batchId: 'batch-1', planTransportDate: '2026-08-18', transportCompany: '华东运输', appliedAt: null, budgetPrice: '1000.00', dealPrice: '900.00' } }));
  });

  it('报表提供 Excel、PNG、PDF 导出，并将导出失败留在当前抽屉提示', async () => {
    const api = mockApi({
      buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [{ key: 'account', label: 'Ship-to 申请', rows: [] }] }),
      exportReport: vi.fn().mockImplementation((format: string) => format === 'png' ? Promise.reject(new Error('磁盘不可写')) : Promise.resolve({ saved: true })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '运营报表' })); const dialog = screen.getByRole('dialog', { name: '运营报表' });
    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } }); fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } }); fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    expect(await within(dialog).findByRole('button', { name: '导出 Excel' })).toBeInTheDocument();
    expect(within(dialog).getByText('Account ID 申请')).toBeInTheDocument(); expect(within(dialog).queryByText('Ship-to 申请')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '导出 PNG' })).toBeInTheDocument(); expect(within(dialog).getByRole('button', { name: '导出 PDF' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 PNG' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('导出失败：磁盘不可写');
  });

  it('报表筛选贯通查询、下钻和导出，明细使用中文列名与业务值', async () => {
    const detailRows = [{
      status: 'completed', orderType: 'parts_by_mail', partStatus: 'used', operatorUsername: null,
      typeCode: 'logistics_management', cancelled: false, unknownField: 'future_status',
    }];
    const api = mockApi({
      buildReport: vi.fn().mockResolvedValue({
        range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '',
        sections: [{ key: 'monthly_service_order_count', label: '月度开单量', rows: detailRows }],
      }),
      drillDown: vi.fn().mockResolvedValue(detailRows),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = screen.getByRole('dialog', { name: '运营报表' });
    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText('区域'), { target: { value: '华东' } });
    fireEvent.change(within(dialog).getByLabelText('开单类型'), { target: { value: 'parts_by_mail' } });
    fireEvent.change(within(dialog).getByLabelText('运输公司'), { target: { value: '华东运输' } });
    fireEvent.change(within(dialog).getByLabelText('工程师'), { target: { value: '工程师甲' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    const expectedFilter = {
      monthFrom: '2026-07', monthTo: '2026-08', region: '华东', orderType: 'parts_by_mail',
      transportCompany: '华东运输', engineer: '工程师甲',
    };
    await waitFor(() => expect(api.buildReport).toHaveBeenCalledWith(expectedFilter));
    fireEvent.change(within(dialog).getByLabelText('区域'), { target: { value: '华北' } });
    fireEvent.click(await within(dialog).findByRole('button', { name: '查看明细' }));
    await waitFor(() => expect(api.drillDown).toHaveBeenCalledWith('monthly_service_order_count', expectedFilter));
    const table = within(dialog).getByRole('table');
    for (const heading of ['项目状态', '开单类型', '备件状态', '责任人', '二维码申请类型', '项目已取消', '其他信息']) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    expect(table).toHaveTextContent('已完成');
    expect(table).toHaveTextContent('单寄备件');
    expect(table).toHaveTextContent('已使用');
    expect(table).toHaveTextContent('物流管理');
    expect(table).toHaveTextContent('否');
    expect(table).toHaveTextContent('—');
    expect(table).toHaveTextContent('其他');
    expect(table).not.toHaveTextContent('completed');
    expect(table).not.toHaveTextContent('parts_by_mail');
    expect(table).not.toHaveTextContent('future_status');
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 Excel' }));
    await waitFor(() => expect(api.exportReport).toHaveBeenCalledWith('xlsx', expectedFilter));
  });

  it('报表标签多选将 tagIds 保留到构建、下钻和导出，清空后等价不限制', async () => {
    const api = mockApi({ buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [{ key: 'monthly_invoice', label: '月度掉票', rows: [] }] }) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = screen.getByRole('dialog', { name: '运营报表' }); fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } }); fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } }); fireEvent.click(within(dialog).getByRole('checkbox', { name: '搬迁' })); fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ICPMS' })); fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    const selectedFilter = { monthFrom: '2026-07', monthTo: '2026-08', region: null, orderType: null, transportCompany: null, engineer: null, tagIds: ['tag-move', 'tag-icpms'] };
    await waitFor(() => expect(api.buildReport).toHaveBeenCalledWith(selectedFilter));
    fireEvent.click(await within(dialog).findByRole('button', { name: '查看明细' })); await waitFor(() => expect(api.drillDown).toHaveBeenCalledWith('monthly_invoice', selectedFilter));
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 PDF' })); await waitFor(() => expect(api.exportReport).toHaveBeenCalledWith('pdf', selectedFilter));
    fireEvent.click(within(dialog).getByRole('button', { name: '清空标签筛选' })); expect(within(dialog).getByText('未选择标签，不限制报表结果')).toBeInTheDocument(); fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    await waitFor(() => expect(api.buildReport).toHaveBeenLastCalledWith(expect.objectContaining({ tagIds: [] })));
  });

  it('独立导航打开序列号地址更新与二维码申请，二维码支持九类多选并实时预览去重计数', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '序列号地址更新' })); let dialog = screen.getByRole('dialog', { name: '序列号地址更新' });
    expect(within(dialog).getByRole('combobox', { name: '搬迁仪器' })).not.toBeRequired(); expect(within(dialog).getByRole('textbox', { name: /序列号.*必填/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '保存记录' })).not.toBeDisabled();
    expect(within(dialog).getByLabelText(/更新日期/)).toHaveAttribute('type', 'date');
    fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.click(screen.getByRole('button', { name: '二维码申请' })); dialog = screen.getByRole('dialog', { name: '二维码申请' });
    expect(within(dialog).getByLabelText(/申请日期/)).toHaveAttribute('type', 'date');
    const group = within(dialog).getByRole('group', { name: /申请类型/ });
    const typeLabels = ['A', 'B', 'C', 'D', '仅打包搬运精密仪器', 'OEM 设备', '临时标签', '项目验收单', '物流管理'];
    expect(within(group).getAllByRole('checkbox')).toHaveLength(typeLabels.length);
    for (const label of typeLabels) expect(within(group).getByRole('checkbox', { name: label })).toBeInTheDocument();
    expect(within(group).getByRole('checkbox', { name: 'A' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'B' })).toBeChecked();
    expect(qrStat(dialog, '本条记录')).toBe('本条记录1 条');
    expect(qrStat(dialog, '去重类型')).toBe('去重类型2 类');
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量2');
    fireEvent.click(within(group).getByRole('checkbox', { name: 'C' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: '仅打包搬运精密仪器' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: '物流管理' }));
    await waitFor(() => expect(qrStat(dialog, '去重类型')).toBe('去重类型5 类'));
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量5');
    expect(qrStat(dialog, '本条记录')).toBe('本条记录1 条');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /申请人.*必填/ }), { target: { value: '负责人' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存申请' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'qr_request', values: expect.objectContaining({ types: ['A', 'B', 'C', 'precise_instrument_packing_only', 'logistics_management'] }) }) })));
    expect(await screen.findByText('记录已保存')).toHaveAttribute('role', 'status');
  });

  it('选择搬迁仪器后自动回填序列号，仍可手工编辑并在清空选择时清空', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '序列号地址更新' }));
    const dialog = screen.getByRole('dialog', { name: '序列号地址更新' });
    const instrumentPicker = within(dialog).getByRole('combobox', { name: '搬迁仪器' });
    const serialInput = within(dialog).getByRole('textbox', { name: /序列号.*必填/ });
    await within(dialog).findByRole('option', { name: 'SN-1 · 仪器 1' });
    fireEvent.change(instrumentPicker, { target: { value: 'i-1' } });
    expect(serialInput).toHaveValue('SN-1');
    fireEvent.change(serialInput, { target: { value: '手工序列号' } });
    expect(serialInput).toHaveValue('手工序列号');
    fireEvent.change(instrumentPicker, { target: { value: '' } });
    expect(serialInput).toHaveValue('');
  });

  it('二维码申请不选任何类型时阻止提交并就地提示', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '二维码申请' }));
    const dialog = screen.getByRole('dialog', { name: '二维码申请' });
    const group = within(dialog).getByRole('group', { name: /申请类型/ });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'A' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'B' }));
    await waitFor(() => expect(qrStat(dialog, '去重类型')).toBe('去重类型0 类'));
    expect(qrStat(dialog, '计入工作量')).toBe('计入工作量0');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存申请' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请至少选择一种二维码申请类型');
    expect(api.v2Mutate).not.toHaveBeenCalled();
  });

  it('二维码申请列表展示去重类型与工作量列，重复申请独立保留', async () => {
    const rows: WorkbenchV2IndependentRow[] = [
      { kind: 'qr_request', id: 'qr-1', applicant: '负责人甲', requestedAt: '2026-08-01', types: ['A', 'logistics_management'], workload: 2, createdAt: '2026-08-01T09:00:00+08:00' },
      { kind: 'qr_request', id: 'qr-2', applicant: '负责人乙', requestedAt: '2026-08-02', types: ['precise_instrument_packing_only', 'oem_equipment', 'temporary_label'], workload: 3, createdAt: '2026-08-02T10:00:00+08:00' },
    ];
    const api = mockApi({ v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'qr_request', rows, total: 2, nextCursor: null, limit: 50 }) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '二维码申请' }));
    const dialog = screen.getByRole('dialog', { name: '二维码申请' });
    expect(within(dialog).getByRole('heading', { name: '申请记录' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('重复申请独立保留并分别计入工作量。');
    expect(await within(dialog).findByText('2 条')).toBeInTheDocument();
    const table = within(dialog).getByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    for (const header of ['申请人', '申请日期', '申请类型', '工作量']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const tableRows = within(table).getAllByRole('row');
    expect(tableRows).toHaveLength(3);
    expect(within(tableRows[1]!).getByText('负责人甲')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByText('2026-08-01')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByText('A、物流管理')).toBeInTheDocument();
    expect(within(tableRows[1]!).getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(within(tableRows[2]!).getByText('仅打包搬运精密仪器、OEM 设备、临时标签')).toBeInTheDocument();
    expect(within(tableRows[2]!).getByRole('cell', { name: '3' })).toBeInTheDocument();
  });

  it('统一历史入口按日期真正跨项目读取，展示项目上下文并受保护删除', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    expect(within(dialog).getByText('全部项目')).toBeInTheDocument();
    expect(within(dialog).queryByText(/后端尚未提供|请选择项目/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('起始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2026-08-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '查看记录' }));
    await waitFor(() => expect(api.v2HistoryPage).toHaveBeenLastCalledWith({ kind: 'service_order', from: '2026-08-01', to: '2026-08-31', cursor: null, limit: 50 }));
    expect(within(dialog).getByText('客户 1')).toBeInTheDocument();
    expect(within(dialog).getByText('ECC-000001')).toBeInTheDocument();
    expect(within(dialog).getByText('2026-08-08')).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith({ kind: 'service_order', id: 'order-1', expectedRevision: 1 }));
  });

  it('历史侧栏提供验收报告入口，并按报告形成日期范围查询跨项目记录', async () => {
    const acceptance: WorkbenchV2HistoryRow = {
      kind: 'acceptance', id: 'p-acceptance', projectId: 'p-acceptance', customerName: '验收客户',
      ecc: 'ECC-ACCEPTANCE', tempNo: 'TMP-ACCEPTANCE', acceptanceReportDate: '2026-08-18',
      businessDate: '2026-08-18', createdAt: '2026-08-18T00:00:00Z',
    };
    const api = mockApi({
      v2HistoryPage: vi.fn().mockImplementation((request: { kind: WorkbenchV2HistoryPageDto['kind'] }) => Promise.resolve({
        businessRevision: 4, kind: request.kind, rows: request.kind === 'acceptance' ? [acceptance] : [],
        total: request.kind === 'acceptance' ? 1 : 0, nextCursor: null, limit: 50,
      })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '验收报告' }));
    fireEvent.change(within(dialog).getByLabelText('起始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2026-08-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '查看记录' }));

    await waitFor(() => expect(api.v2HistoryPage).toHaveBeenLastCalledWith({
      kind: 'acceptance', from: '2026-08-01', to: '2026-08-31', cursor: null, limit: 50,
    }));
    const row = await within(dialog).findByRole('row', { name: /验收客户.*ECC-ACCEPTANCE.*验收报告.*2026-08-18/ });
    expect(row).toBeInTheDocument();
  });

  it('历史抽屉明确列出八类删除记录并分别走关联与独立读取路由', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    for (const label of ['物流费用', '搬迁仪器', '开单记录', '验收报告', 'Account ID 申请', '损坏维修', '序列号地址更新', '二维码申请']) {
      expect(within(dialog).getByRole('tab', { name: label })).toBeInTheDocument();
    }
    await waitFor(() => expect(api.v2HistoryPage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'service_order' })));
    fireEvent.click(within(dialog).getByRole('tab', { name: '序列号地址更新' }));
    await waitFor(() => expect(api.v2IndependentPage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'serial_address' })));
  });

  it('删除确认取消时通用保护阻止 v2Delete 调用', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '删除' }));
    expect(api.v2Delete).not.toHaveBeenCalled();
  });

  it('验收历史支持删除，并将已有掉票依赖拒绝翻译为中文', async () => {
    const api = mockApi({
      v2HistoryPage: vi.fn().mockResolvedValue({ businessRevision: 3, kind: 'acceptance', total: 1, nextCursor: null, limit: 50, rows: [{ kind: 'acceptance', id: 'p-1', projectId: 'p-1', customerName: '客户 1', ecc: 'ECC-000001', tempNo: 'TMP-000001', acceptanceReportDate: '2026-08-09', businessDate: '2026-08-09', createdAt: '2026-08-09T00:00:00Z' }] }),
      v2Delete: vi.fn().mockRejectedValue(new Error('DELETE_REJECTED_DEPENDENCIES: 项目已有掉票历史')),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />); await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
    const dialog = screen.getByRole('dialog', { name: '浏览往期与全部记录' });
    fireEvent.click(within(dialog).getByRole('tab', { name: '验收报告' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '删除' }));
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith({ kind: 'acceptance', projectId: 'p-1', expectedRevision: 3 }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('项目已有掉票历史，不能删除验收记录');
  });

  it('掉票删除明确走撤销并收集撤销日期和原因', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('row', { name: /^客户 1 / });
    fireEvent.click(screen.getByRole('tab', { name: '费用与掉票' }));
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
    const dialog = screen.getByRole('dialog', { name: '撤销掉票' });
    fireEvent.change(within(dialog).getByLabelText(/撤销原因/), { target: { value: '金额登记有误' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销掉票' }));
    await waitFor(() => expect(api.v2Delete).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invoice', id: 'inv-1', expectedRevision: 1, revokeReason: '金额登记有误' })));
  });

  it('清理全部业务数据先展示计数，再要求固定文本并调用两阶段契约', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByText('数据管理'));
    fireEvent.click(screen.getByRole('button', { name: '清理全部业务数据' }));
    const dialog = screen.getByRole('dialog', { name: '清理全部业务数据' });
    fireEvent.click(within(dialog).getByRole('button', { name: '先检查将清理的数据' }));
    expect(await within(dialog).findByText('将清理 4 行业务数据')).toBeInTheDocument();
    const clean = within(dialog).getByRole('button', { name: '创建安全备份并清理' });
    expect(clean).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '清理全部业务数据' } });
    fireEvent.click(clean);
    await waitFor(() => expect(api.cleanConfirm).toHaveBeenCalledWith({ token: 'clean-token', confirmText: '清理全部业务数据' }));
  });

  it('清理确认过期后清空旧计数并提供重新检查路径', async () => {
    const api = mockApi({ cleanConfirm: vi.fn().mockRejectedValue(new Error('CLEAN_TOKEN_EXPIRED: token expired')) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ }); fireEvent.click(screen.getByText('数据管理')); fireEvent.click(screen.getByRole('button', { name: '清理全部业务数据' }));
    const dialog = screen.getByRole('dialog', { name: '清理全部业务数据' }); fireEvent.click(within(dialog).getByRole('button', { name: '先检查将清理的数据' }));
    await within(dialog).findByText('将清理 4 行业务数据'); fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '清理全部业务数据' } }); fireEvent.click(within(dialog).getByRole('button', { name: '创建安全备份并清理' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('已过期，请重新检查数据');
    expect(within(dialog).queryByText('将清理 4 行业务数据')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '重新检查数据' })).toBeInTheDocument();
  });

  it('项目总览编辑资料预填分组字段，显式提交 false/空值并在成功后关闭刷新详情', async () => {
    const row = { ...project(1), customerName: '预填客户', region: 'East' };
    const loaded = detailOf(row);
    loaded.detail = {
      ...loaded.detail!, contractStartDate: '2026-01-01', contractEndDate: '2026-12-31',
      oldSiteContact: '旧址王工', newSiteContact: '新址李工', oldSiteAddress: '旧址 A', newSiteAddress: '新址 B',
      planVisitAt: '2026-08-10', planTransportAt: '2026-08-11', siteConfirmed: true,
    };
    let detailReads = 0;
    let resolveMutation!: (value: { businessRevision: number; invalidated: string[]; changed: { projectId: string } }) => void;
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockImplementation(() => Promise.resolve({ ...loaded, businessRevision: ++detailReads > 1 ? 2 : 1 })),
      v2Mutate: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: '预填客户' });
    const editProject = screen.getByRole('button', { name: '编辑项目资料' });
    await waitFor(() => expect(editProject).not.toBeDisabled());
    fireEvent.click(editProject);
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(dialog).getByRole('group', { name: '基本信息' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '地点与联系人' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '执行准备' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/客户名称/)).toHaveValue('预填客户');
    await waitFor(() => expect(within(dialog).getByLabelText(/客户名称/)).toHaveFocus());
    expect(within(dialog).getByLabelText(/合同开始日期/)).toHaveValue('2026-01-01');
    expect(within(dialog).getByLabelText(/计划上门日期/)).toHaveValue('2026-08-10');
    const siteConfirmed = within(dialog).getByRole('checkbox', { name: '现场条件已确认' });
    expect(siteConfirmed).toBeChecked();
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '  更新客户  ' } });
    fireEvent.change(within(dialog).getByLabelText(/新址联系人/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/计划上门日期/), { target: { value: '' } });
    fireEvent.click(siteConfirmed);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存项目资料' }));
    expect(within(dialog).getByRole('button', { name: '正在保存…' })).toBeDisabled();
    expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'update_project',
      payload: {
        projectId: 'p-1', customerName: '更新客户', newSiteContact: null,
        newSiteAddress: null, plannedVisitAt: null, siteConfirmed: false,
      },
    });
    resolveMutation({ businessRevision: 2, invalidated: ['project:p-1'], changed: { projectId: 'p-1' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledTimes(2));
  });

  it('编辑项目资料忽略旧暂定仪器三字段，回显并保存 UPS 与其他项目资料', async () => {
    const row = { ...project(1), customerName: '基线客户' };
    const loaded = detailOf(row);
    loaded.detail = { ...loaded.detail!, temporaryInstrumentName: '质谱仪', temporaryInstrumentCount: 12, temporaryInstrumentModel: 'MS-12', temporaryHasUps: true };
    let detailReads = 0;
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockImplementation(() => Promise.resolve({ ...loaded, businessRevision: ++detailReads > 1 ? 2 : 1 })),
      v2Mutate: vi.fn().mockImplementation((request: { op: string; payload?: Record<string, unknown> }) => {
        if (request.op === 'update_project' && request.payload && loaded.detail) loaded.detail = { ...loaded.detail, ...request.payload };
        return Promise.resolve({ businessRevision: 2, invalidated: ['project:p-1'], changed: { projectId: 'p-1' } });
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('region', { name: '基线客户' });

    // 底层读模型仍可携带旧字段，但新界面不再展示或回写它们。
    expect(loaded.detail!.temporaryInstrumentCount).toBe(12);
    expect(row).not.toHaveProperty('temporaryInstrumentCount');

    const editProject = screen.getByRole('button', { name: '编辑项目资料' });
    await waitFor(() => expect(editProject).not.toBeDisabled());
    fireEvent.click(editProject);
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    for (const name of ['基本信息', '地点与联系人', '设备范围', '执行准备']) expect(within(dialog).getByRole('group', { name })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/暂定仪器名称/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/暂定仪器数量/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/暂定型号/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /^UPS/ })).toHaveValue('true');
    expect(within(dialog).getByLabelText(/项目备注/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/暂存地址/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/是否暂存/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/^计划装机日期/)).toHaveValue('');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /^UPS/ }), { target: { value: 'false' } });
    fireEvent.change(within(dialog).getByLabelText(/项目备注/), { target: { value: '需避开周末' } });
    fireEvent.change(within(dialog).getByLabelText(/暂存地址/), { target: { value: '中转仓 A' } });
    fireEvent.change(within(dialog).getByLabelText(/是否暂存/), { target: { value: 'true' } });
    fireEvent.change(within(dialog).getByLabelText(/^计划装机日期/), { target: { value: '2026-09-03' } });

    // 保存复用既有 v2Mutate update_project 刷新路径：关闭弹层并重新读取详情回显项目数据。
    fireEvent.click(within(dialog).getByRole('button', { name: '保存项目资料' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'update_project', payload: expect.objectContaining({ projectId: 'p-1', temporaryHasUps: false, projectNote: '需避开周末', temporaryStorageAddress: '中转仓 A', isTemporaryStorage: true, plannedInstallAt: '2026-09-03' }) }));
    const firstPayload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload as unknown as Record<string, unknown>;
    for (const key of ['temporaryInstrumentName', 'temporaryInstrumentCount', 'temporaryInstrumentModel']) expect(key in firstPayload).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());
    await waitFor(() => expect(vi.mocked(api.v2ProjectDetail!).mock.calls.length).toBeGreaterThan(1));
    const overviewRegion = screen.getByRole('region', { name: '基线客户' });
    expect(overviewRegion).not.toHaveTextContent('质谱仪');
    expect(overviewRegion).not.toHaveTextContent('12 台');
    expect(overviewRegion).not.toHaveTextContent('MS-12');
    expect(overviewRegion).toHaveTextContent('UPS否');

    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    const reopened = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(reopened).queryByLabelText(/暂定仪器名称/)).not.toBeInTheDocument();
    expect(within(reopened).queryByLabelText(/暂定仪器数量/)).not.toBeInTheDocument();
    expect(within(reopened).queryByLabelText(/暂定型号/)).not.toBeInTheDocument();
    expect(within(reopened).getByRole('combobox', { name: /^UPS/ })).toHaveValue('false');
    fireEvent.change(within(reopened).getByRole('combobox', { name: /^UPS/ }), { target: { value: '' } });
    fireEvent.click(within(reopened).getByRole('button', { name: '保存项目资料' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenLastCalledWith({ op: 'update_project', payload: expect.objectContaining({ temporaryHasUps: null }) }));
    const lastPayload = vi.mocked(api.v2Mutate!).mock.calls.at(-1)![0].payload as unknown as Record<string, unknown>;
    for (const key of ['temporaryInstrumentName', 'temporaryInstrumentCount', 'temporaryInstrumentModel']) expect(key in lastPayload).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument());
    await waitFor(() => expect(overviewRegion).toHaveTextContent('UPS未填写'));
    expect(api.v2Mutate).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'submit_action', action: expect.objectContaining({ type: 'instrument' }) }));
  });

  it('项目 detail 未就绪时禁用编辑资料，加载完成后可打开且只回显保留字段', async () => {
    let resolveDetail!: (value: WorkbenchV2ProjectDetailDto) => void;
    const row = { ...project(1), customerName: '延迟详情客户' };
    const loaded = detailOf(row);
    loaded.detail = { ...loaded.detail!, temporaryInstrumentName: '延迟质谱仪', temporaryInstrumentCount: 6, temporaryInstrumentModel: '旧型号', temporaryHasUps: true };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockImplementation(() => new Promise<WorkbenchV2ProjectDetailDto>((resolve) => { resolveDetail = resolve; })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-1'));
    const edit = screen.getByRole('button', { name: '编辑项目资料' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(edit);
    expect(screen.queryByRole('dialog', { name: '编辑项目资料' })).not.toBeInTheDocument();
    resolveDetail(loaded);
    await waitFor(() => expect(edit).not.toBeDisabled());
    fireEvent.click(edit);
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(dialog).queryByLabelText(/暂定仪器名称/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/暂定仪器数量/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/暂定型号/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /^UPS/ })).toHaveValue('true');
    expect(within(dialog).getByLabelText(/客户名称/)).toHaveValue('延迟详情客户');
  });

  it('编辑资料打开后无关 section 刷新不会清空未保存输入', async () => {
    let resolveSection!: (value: WorkbenchV2SectionPageDto) => void;
    const api = mockApi({
      v2SectionPage: vi.fn().mockImplementation(() => new Promise<WorkbenchV2SectionPageDto>((resolve) => { resolveSection = resolve; })),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    const detail = await screen.findByRole('region', { name: '客户 1' });
    const edit = within(detail).getByRole('button', { name: '编辑项目资料' });
    await waitFor(() => expect(edit).not.toBeDisabled());
    fireEvent.click(edit);
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    const customer = within(dialog).getByLabelText(/客户名称/);
    fireEvent.change(customer, { target: { value: '尚未保存的客户名称' } });
    resolveSection(section('instruments', 'p-1'));
    await waitFor(() => expect(api.v2SectionPage).toHaveBeenCalled());
    expect(customer).toHaveValue('尚未保存的客户名称');
    expect(screen.getByRole('dialog', { name: '编辑项目资料' })).toBeInTheDocument();
  });

  it('正式进单项目谨慎更正进单合同资料，预填金额并在错误时保留表单反馈', async () => {
    const row = { ...project(1), entryAt: '2026-08-01', contractAmount: '0.00', finalAmount: '125000.50' };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([row], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue(detailOf(row)),
      v2Mutate: vi.fn().mockRejectedValue(new Error('ECC 已存在，未保存更正')),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: row.customerName });
    fireEvent.click(screen.getByRole('button', { name: '更正进单/合同资料' }));
    const dialog = screen.getByRole('dialog', { name: '更正进单/合同资料' });
    expect(dialog).toHaveTextContent('进单金额快照保留正式进单当时的口径');
    expect(within(dialog).getByLabelText(/^ECC/)).toHaveValue(row.ecc);
    expect(within(dialog).getByLabelText(/进单日期/)).toHaveValue('2026-08-01');
    expect(within(dialog).getByLabelText(/合同 USD 含税金额/)).toHaveValue(0);
    expect(within(dialog).getByLabelText(/最终可确认金额/)).toHaveValue(125000.5);
    expect(within(dialog).queryByLabelText(/仪器名称|序列号|服务单号/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/最终可确认金额/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更正' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('ECC 已存在，未保存更正'));
    expect(screen.getByRole('dialog', { name: '更正进单/合同资料' })).toBeInTheDocument();
    expect(api.v2Mutate).toHaveBeenCalledWith({
      op: 'update_project',
      payload: { projectId: 'p-1', finalConfirmableAmount: null },
    });
  });

  it('待进单项目不显示更正入口，继续使用补齐进单核心资料路径', async () => {
    const pending = { ...project(2), formallyEntered: false, status: 'pending_entry' as const, ecc: null, entryAt: null };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([pending], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue(detailOf(pending)),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: pending.customerName });
    expect(screen.queryByRole('button', { name: '更正进单/合同资料' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '补齐进单核心资料' }));
    expect(screen.getByRole('dialog', { name: '补齐进单核心资料' })).toBeInTheDocument();
  });

  it('提醒跨页选择且详情失败时详情面板不消失，稳定显示错误与重试并可在重试后恢复', async () => {
    const crossRow = { ...project(51), id: 'p-51', customerName: '跨页客户', ecc: 'ECC-000051', status: 'pending_entry' as const };
    const findProject = (id: string): WorkbenchProjectRow | null =>
      id === 'p-51' ? crossRow : [...firstProjects, ...secondProjects].find((row) => row.id === id) ?? null;
    let detailFailed = false;
    const api = mockApi({
      v2Overview: vi.fn().mockResolvedValue({
        ...overview,
        reminderPreview: [{
          projectId: 'p-51', customerName: '跨页客户', ecc: 'ECC-000051', tempNo: 'TMP-000051',
          reminderAt: '2026-08-08', reminderNote: '跨页提醒', reminderDueClass: 'today' as const,
        }],
      }),
      v2ReminderLanes: vi.fn().mockResolvedValue({
        businessRevision: 1, dates: ['2026-08-08'], lanePageSize: 50,
        lanes: [{ date: '2026-08-08', total: 1, nextCursor: null, limit: 50, projects: [{ projectId: 'p-51', customerName: '跨页客户', ecc: 'ECC-000051', tempNo: 'TMP-000051', reminderAt: '2026-08-08', reminderNote: '跨页提醒', reminderDueClass: 'today' as const }] }],
      }),
      // 新筛选（ECC-000051）下项目不在当前页，用于复现 detail 为空且 selectedId 不在页内时面板消失。
      v2ProjectPage: vi.fn().mockImplementation((request: { cursor?: string | null; query?: string | null }) =>
        request.query === 'ECC-000051'
          ? Promise.resolve(page([], null, 0))
          : Promise.resolve(request.cursor ? page(secondProjects, null) : page()),
      ),
      v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => {
        if (projectId === 'p-51' && !detailFailed) {
          detailFailed = true;
          return Promise.reject(new Error('详情读取失败'));
        }
        return Promise.resolve(detailOf(findProject(projectId)));
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(within(screen.getByRole('region', { name: /待办提醒/ })).getByRole('button', { name: /跨页客户/ }));

    // 原症状：详情请求失败 + 项目不在当前页时，整个面板（含错误与重试）消失。
    expect(await screen.findByText('详情读取失败')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试详情' });
    expect(screen.getByRole('heading', { name: '未选择项目' })).toBeInTheDocument();

    // 重试仍按选中 id 重新读取详情，成功后跨页展示项目详情。
    fireEvent.click(retry);
    expect(await screen.findByRole('region', { name: '跨页客户' })).toBeInTheDocument();
    expect(vi.mocked(api.v2ProjectDetail!).mock.calls.filter(([id]) => id === 'p-51')).toHaveLength(2);
  });

  it('新建项目成功后清除隐藏筛选、回到首屏、刷新列表并自动选中新项目', async () => {
    const created = { ...project(1), id: 'p-new', customerName: '新建客户', ecc: 'ECC-NEW-001', status: 'pending_entry' as const };
    let projectCreated = false;
    const api = mockApi({
      // 创建前：普通查询返回首页，'隐藏条件' 查询返回空页；创建后：新项目出现在首页首位（revision 跟随 mutation）。
      v2ProjectPage: vi.fn().mockImplementation((request: { query?: string | null }) => {
        if (projectCreated) return Promise.resolve(page([created, ...firstProjects], null, 51, 2));
        if (request.query === '隐藏条件') return Promise.resolve(page([], null, 0));
        return Promise.resolve(page(firstProjects, null, 100_000));
      }),
      v2ProjectDetail: vi.fn().mockImplementation((projectId: string) => {
        const row = projectId === 'p-new' ? created : [...firstProjects, ...secondProjects].find((r) => r.id === projectId) ?? null;
        return Promise.resolve({ ...detailOf(row), businessRevision: projectCreated ? 2 : 1 });
      }),
      v2Mutate: vi.fn().mockImplementation(() => {
        projectCreated = true;
        return Promise.resolve({
          businessRevision: 2,
          invalidated: ['overview', 'projects', 'project:p-new', 'sections:p-new'],
          changed: { projectId: 'p-new', created: true },
        });
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    // 先设置会隐藏新项目的查询筛选。
    fireEvent.change(screen.getByLabelText('查找项目'), { target: { value: '隐藏条件' } });
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ query: '隐藏条件' })));

    fireEvent.click(screen.getByRole('button', { name: '新建搬迁项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建搬迁项目' });
    fireEvent.change(within(dialog).getByLabelText(/客户名称/), { target: { value: '新建客户' } });
    fireEvent.change(within(dialog).getByLabelText(/区域/), { target: { value: 'East' } });
    fireEvent.change(within(dialog).getByLabelText(/旧址地址/), { target: { value: '旧址 A' } });
    fireEvent.change(within(dialog).getByLabelText(/新址地址/), { target: { value: '新址 B' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /正式进单/ }));
    fireEvent.change(within(dialog).getByLabelText(/^ECC/), { target: { value: 'ECC-NEW-001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '正式进单' }));

    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith(expect.objectContaining({ op: 'create_project' })));
    // 弹层关闭，筛选清除并回到首屏。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建搬迁项目' })).not.toBeInTheDocument());
    await waitFor(() => expect(api.v2ProjectPage).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null, status: null, reminder: null, region: null, query: null })));
    // 新项目可见、被选中且详情按返回的 id 加载。
    const newRow = await screen.findByRole('row', { name: /新建客户/ });
    await waitFor(() => expect(newRow).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledWith('p-new'));
    expect(await screen.findByRole('region', { name: '新建客户' })).toBeInTheDocument();
  });

  it('区域在新建、编辑与队列均为五选项，legacy 原文醒目标记且未显式选择不发送更新', async () => {
    const legacy = { ...project(1), region: '华东旧区', regionNeedsAdjustment: true };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue(page([legacy], null, 1)),
      v2ProjectDetail: vi.fn().mockResolvedValue(detailOf(legacy)),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: legacy.customerName });
    expect(screen.getByText('待调整', { selector: '.legacy-region-tag' })).toBeInTheDocument();
    const queueRegion = screen.getByLabelText('区域');
    expect(within(queueRegion).getAllByRole('option').map((item) => item.textContent)).toEqual(['全部区域', 'East', 'South', 'West', 'Central', 'North']);
    fireEvent.click(screen.getByRole('button', { name: '编辑项目资料' }));
    const dialog = screen.getByRole('dialog', { name: '编辑项目资料' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('原区域“华东旧区”');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存项目资料' }));
    expect(await within(dialog).findByText('没有需要保存的更改。')).toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalled();
  });

  it('提醒泳道按最多七个日期列读取，同日纵向堆叠且列加载更多保持 selectedDates', async () => {
    const dates = Array.from({ length: 7 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`);
    const laneApi = vi.fn().mockImplementation((request: { selectedDates?: readonly string[]; date?: string; cursor?: string | null }) => Promise.resolve({
      businessRevision: 1, dates, lanePageSize: 2,
      lanes: dates.map((date, index) => ({
        date, total: index === 0 ? 3 : 1, limit: 2, nextCursor: date === dates[0] && !request.cursor ? 'lane-next' : null,
        projects: date === dates[0]
          ? (request.cursor ? [{ projectId: 'p-3', customerName: '同日客户 3', ecc: null, tempNo: 'TMP-3', reminderAt: date, reminderNote: null, reminderDueClass: 'overdue' as const }] : [{ projectId: 'p-1', customerName: '同日客户 1', ecc: null, tempNo: 'TMP-1', reminderAt: date, reminderNote: null, reminderDueClass: 'overdue' as const }, { projectId: 'p-2', customerName: '同日客户 2', ecc: null, tempNo: 'TMP-2', reminderAt: date, reminderNote: null, reminderDueClass: 'overdue' as const }])
          : [{ projectId: `lane-${index}`, customerName: `日期客户 ${index}`, ecc: null, tempNo: `TMP-${index}`, reminderAt: date, reminderNote: null, reminderDueClass: 'upcoming' as const }],
      })),
    }));
    const api = mockApi({ v2ReminderLanes: laneApi }); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    const lanes = await screen.findByRole('region', { name: '提醒日期泳道' });
    expect(lanes.querySelectorAll('.reminder-lane')).toHaveLength(7);
    const firstLane = lanes.querySelector<HTMLElement>('.reminder-lane')!;
    expect(within(firstLane).getAllByRole('button', { name: /同日客户/ })).toHaveLength(2);
    fireEvent.click(within(firstLane).getByRole('button', { name: '加载本列更多' }));
    await waitFor(() => expect(laneApi).toHaveBeenLastCalledWith({ selectedDates: dates, date: dates[0], cursor: 'lane-next' }));
    expect(within(firstLane).getAllByRole('button', { name: /同日客户/ })).toHaveLength(3);
  });

  it('查看全部进入完整提醒页，默认日期降序，切换升序立即首页重读并稳定翻页', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('button', { name: '查看全部' }));
    const dialog = screen.getByRole('dialog', { name: '全部项目提醒' });
    await waitFor(() => expect(api.v2ReminderPage).toHaveBeenCalledWith({ sort: 'desc', cursor: null, limit: 50 }));
    fireEvent.change(within(dialog).getByLabelText('提醒日期顺序'), { target: { value: 'asc' } });
    await waitFor(() => expect(api.v2ReminderPage).toHaveBeenLastCalledWith({ sort: 'asc', cursor: null, limit: 50 }));
    fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(api.v2ReminderPage).toHaveBeenLastCalledWith({ sort: 'asc', cursor: 'reminder-2', limit: 50 }));
  });

  it('项目仅有取消入口且无物理删除，掉票只提供撤销并在终态禁编辑和重复撤销', async () => {
    const activeInvoice = section('invoices').rows[0]!;
    const api = mockApi({ v2SectionPage: vi.fn().mockResolvedValue({ ...section('invoices'), rows: [activeInvoice, { kind: 'invoices' as const, id: 'inv-revoked', projectId: 'p-1', amount: '10.00', invoicedAt: '2026-08-01', active: false, revokedAt: '2026-08-02', revokeReason: '重复登记', lastModifiedAt: '2026-08-02T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' }] }) });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true }); render(<App />);
    await screen.findByRole('region', { name: project(1).customerName });
    expect(screen.getByRole('button', { name: '取消项目' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除项目/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '费用与掉票' }));
    expect(await screen.findByText('终态 · 更正请新增')).toBeInTheDocument();
    const invoiceTable = screen.getByRole('columnheader', { name: '掉票日期' }).closest('table')!;
    expect(within(invoiceTable).getByRole('button', { name: '撤销' })).toBeInTheDocument();
    expect(within(invoiceTable).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    expect(within(within(invoiceTable).getAllByRole('row')[2]!).queryByRole('button', { name: /编辑|撤销|删除/ })).not.toBeInTheDocument();
  });

  describe('项目标签就近编辑', () => {
    it('详情保持标签区域；无标签显示添加入口，已有标签显示编辑入口', async () => {
      const api = mockApi();
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const tags = within(detail).getByRole('region', { name: '项目标签' });
      expect(tags).toHaveTextContent('项目类型');
      expect(within(tags).getByRole('button', { name: '编辑客户 1的项目标签' })).toBeInTheDocument();

      fireEvent.click(within(screen.getByRole('grid', { name: '项目队列' })).getByRole('row', { name: /^客户 2 / }));
      const customerTwoDetail = await screen.findByRole('region', { name: '客户 2' });
      const emptyTags = await within(customerTwoDetail).findByRole('region', { name: '项目标签' });
      expect(emptyTags).toHaveTextContent('尚未添加项目标签');
      expect(within(emptyTags).getByRole('button', { name: '添加客户 2的项目标签' })).toBeInTheDocument();
    });

    it('队列标签入口固化行项目和草稿，不改变当前工作区；两个入口共享编辑器', async () => {
      const api = mockApi();
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const workspace = await screen.findByRole('region', { name: '项目工作区' });
      const queue = screen.getByRole('grid', { name: '项目队列' });
      const trigger = within(queue).getByRole('button', { name: '编辑客户 2的项目标签' });
      const projectPageCallsBeforeSave = vi.mocked(api.v2ProjectPage!).mock.calls.length;
      const currentProjectDetailCallsBeforeSave = vi.mocked(api.v2ProjectDetail!).mock.calls
        .filter(([projectId]) => projectId === 'p-1').length;
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      expect(dialog).toHaveTextContent('客户 2');
      expect(within(dialog).getByRole('checkbox', { name: '搬迁' })).not.toBeChecked();
      expect(workspace).toHaveTextContent('客户 1');
      expect(within(queue).getByRole('row', { name: /^客户 1 / })).toHaveAttribute('aria-selected', 'true');
      fireEvent.click(within(dialog).getByRole('checkbox', { name: 'PM' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '保存标签' }));
      await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'update_project', payload: { projectId: 'p-2', tagIds: ['tag-pm'] } }));
      await waitFor(() => expect(vi.mocked(api.v2ProjectPage!).mock.calls.length).toBeGreaterThan(projectPageCallsBeforeSave));
      expect(api.v2ProjectDetail).not.toHaveBeenCalledWith('p-2');
      expect(vi.mocked(api.v2ProjectDetail!).mock.calls.filter(([projectId]) => projectId === 'p-1')).toHaveLength(currentProjectDetailCallsBeforeSave);
      expect(workspace).toHaveTextContent('客户 1');
      expect(within(queue).getByRole('row', { name: /^客户 1 / })).toHaveAttribute('aria-selected', 'true');

      const detailTrigger = within(screen.getByRole('region', { name: '客户 1' })).getByRole('button', { name: '编辑客户 1的项目标签' });
      fireEvent.click(detailTrigger);
      expect(screen.getByRole('dialog', { name: '编辑项目标签' })).toHaveTextContent('客户 1');
    });

    it('标签保存只发送 tagIds，支持清空、改回原值和选中目标的详情刷新', async () => {
      const api = mockApi();
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const trigger = within(detail).getByRole('button', { name: '编辑客户 1的项目标签' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      const move = within(dialog).getByRole('checkbox', { name: '搬迁' });
      const icpms = within(dialog).getByRole('checkbox', { name: 'ICPMS' });
      const save = within(dialog).getByRole('button', { name: '保存标签' });
      expect(save).toBeDisabled();
      fireEvent.click(move);
      expect(save).not.toBeDisabled();
      fireEvent.click(move);
      expect(save).toBeDisabled();
      fireEvent.click(move);
      fireEvent.click(icpms);
      fireEvent.click(save);
      await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'update_project', payload: { projectId: 'p-1', tagIds: [] } }));
      await waitFor(() => expect(api.v2ProjectDetail).toHaveBeenCalledTimes(2));
    });

    it('目录加载、空和失败时阻止保存，并保持稳定的标签编辑结构', async () => {
      let rejectCatalog!: (reason?: unknown) => void;
      const pendingCatalog = new Promise<ProjectTagCatalogDto>((_, reject) => { rejectCatalog = reject; });
      const api = mockApi({ v2TagCatalog: vi.fn().mockReturnValue(pendingCatalog) });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      fireEvent.click(within(detail).getByRole('button', { name: '编辑客户 1的项目标签' }));
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      expect(within(dialog).getByRole('status')).toHaveTextContent('正在读取项目分类标签');
      expect(within(dialog).getByRole('button', { name: '保存标签' })).toBeDisabled();
      expect(dialog.querySelector('.project-tag-edit-scroll')).toBeInTheDocument();
      rejectCatalog(new Error('目录读取失败'));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('目录读取失败');
      expect(within(dialog).getByRole('button', { name: '保存标签' })).toBeDisabled();
    });

    it('空目录给出管理指引；干净关闭归还焦点，脏 Escape 请求放弃确认', async () => {
      const emptyCatalog = { ...tagCatalog, groups: [] };
      const api = mockApi({ v2TagCatalog: vi.fn().mockResolvedValue(emptyCatalog) });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const trigger = within(detail).getByRole('button', { name: '编辑客户 1的项目标签' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      expect(await within(dialog).findByText('标签库暂无内容。请取消后从顶部“标签库”进入“管理标签库”。')).toBeInTheDocument();
      const cancel = within(dialog).getByRole('button', { name: '取消' });
      await waitFor(() => expect(cancel).toHaveFocus());
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(trigger).toHaveFocus());

      const normalApi = mockApi();
      Object.defineProperty(window, 'workbench', { value: normalApi, configurable: true });
      cleanup();
      render(<App />);
      const normalDetail = await screen.findByRole('region', { name: '客户 1' });
      fireEvent.click(within(normalDetail).getByRole('button', { name: '编辑客户 1的项目标签' }));
      const editable = screen.getByRole('dialog', { name: '编辑项目标签' });
      fireEvent.click(within(editable).getByRole('checkbox', { name: '搬迁' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(await screen.findByRole('alertdialog', { name: '放弃本次修改？' })).toBeInTheDocument();
    });

    describe('脏草稿关闭先确认放弃', () => {
    it.each([
      ['取消', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))],
      ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
      ['遮罩', () => fireEvent.mouseDown(document.querySelector('.overlay')!)],
      ['关闭图标', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))],
    ])('脏草稿经%s关闭时确认放弃，继续编辑保留草稿并恢复关闭控件焦点', async (_channel, close) => {
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const opener = within(detail).getByRole('button', { name: '编辑客户 1的项目标签' });
      fireEvent.click(opener);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      const changed = within(dialog).getByRole('checkbox', { name: '搬迁' });
      fireEvent.click(changed);
      close(dialog);
      const guard = await screen.findByRole('alertdialog', { name: '放弃本次修改？' });
      const continueEditing = within(guard).getByRole('button', { name: '继续编辑' });
      fireEvent.click(continueEditing);
      expect(changed).not.toBeChecked();
      await waitFor(() => expect(document.activeElement).toBe(
        _channel === '取消' ? within(dialog).getByRole('button', { name: '取消' })
          : _channel === '关闭图标' ? within(dialog).getByRole('button', { name: '关闭' })
            : changed,
      ));
      close(dialog);
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '放弃修改' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目标签' })).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
    });
    });

    it('干净草稿四种关闭渠道直接关闭；提交中四渠道均不能关闭', async () => {
      let resolveSave!: (value: { businessRevision: number; invalidated: string[]; changed: { projectId: string } }) => void;
      const api = mockApi({ v2Mutate: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; })) });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const opener = within(detail).getByRole('button', { name: '编辑客户 1的项目标签' });
      for (const close of [
        () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })),
        () => fireEvent.keyDown(document, { key: 'Escape' }),
        () => fireEvent.mouseDown(document.querySelector('.overlay')!),
        () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' })),
      ]) {
        fireEvent.click(opener);
        close();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目标签' })).not.toBeInTheDocument());
      }
      fireEvent.click(opener);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      fireEvent.click(within(dialog).getByRole('checkbox', { name: '搬迁' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '保存标签' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: '正在保存…' })).toBeDisabled());
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.mouseDown(document.querySelector('.overlay')!);
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.getByRole('dialog', { name: '编辑项目标签' })).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog', { name: '放弃本次修改？' })).not.toBeInTheDocument();
      resolveSave({ businessRevision: 2, invalidated: ['projects'], changed: { projectId: 'p-1' } });
    });

    it('标签分配只提供单项目文字入口，不提供批量、右键、快速记录或表格内 picker', async () => {
      render(<App />);
      const queue = await screen.findByRole('grid', { name: '项目队列' });
      expect(within(queue).queryByRole('button', { name: /批量.*标签|标签.*批量/ })).not.toBeInTheDocument();
      expect(within(queue).queryByRole('menu')).not.toBeInTheDocument();
      expect(within(queue).queryByRole('checkbox')).not.toBeInTheDocument();
      const quick = screen.getAllByRole('button', { name: '快速记录' })[0]!;
      fireEvent.click(quick);
      const quickMenu = screen.getByRole('dialog');
      expect(within(quickMenu).queryByRole('button', { name: /标签/ })).not.toBeInTheDocument();
      expect(within(quickMenu).queryByRole('checkbox', { name: /搬迁|PM|ICPMS|重点跟进/ })).not.toBeInTheDocument();
    });

    it('写入失败保留草稿可重试；写入成功后的刷新失败关闭并提示且不重复写入', async () => {
      let writes = 0;
      let failRefresh = false;
      const api = mockApi({
        v2Mutate: vi.fn().mockImplementation(() => {
          writes += 1;
          return writes === 1
            ? Promise.reject(new Error('保存失败'))
            : Promise.resolve({ businessRevision: 2, invalidated: ['projects', 'project:p-1'], changed: { projectId: 'p-1' } });
        }),
        v2ProjectPage: vi.fn().mockImplementation(() => failRefresh ? Promise.reject(new Error('刷新失败')) : Promise.resolve(page())),
      });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });
      render(<App />);
      const detail = await screen.findByRole('region', { name: '客户 1' });
      const trigger = within(detail).getByRole('button', { name: '编辑客户 1的项目标签' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: '编辑项目标签' });
      fireEvent.click(within(dialog).getByRole('checkbox', { name: '搬迁' }));
      fireEvent.click(within(dialog).getByRole('button', { name: '保存标签' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('保存失败');
      expect(within(dialog).getByRole('checkbox', { name: '搬迁' })).not.toBeChecked();
      failRefresh = true;
      fireEvent.click(within(dialog).getByRole('button', { name: '保存标签' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑项目标签' })).not.toBeInTheDocument());
      expect(await screen.findByText('标签已保存，部分视图刷新失败，请使用页面中的重试操作重新读取。')).toHaveAttribute('role', 'alert');
      expect(api.v2Mutate).toHaveBeenCalledTimes(2);
    });
  });
});
