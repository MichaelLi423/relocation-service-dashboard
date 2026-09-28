// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unused-vars */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/app';
import type {
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2OverviewDto,
  ProjectTagCatalogDto,
} from '../../src/shared/ipc';

const tagCatalog: ProjectTagCatalogDto = {
  businessRevision: 1,
  selectedTagIds: ['tag-1'],
  groups: [
    {
      id: 'g-1',
      name: '业务标签',
      sortOrder: 0,
      tags: [{ id: 'tag-1', groupId: 'g-1', name: '暂存', sortOrder: 0 }],
    },
  ],
};

function project(): WorkbenchProjectRow {
  return {
    id: 'p-1',
    tempNo: 'TMP-000001',
    ecc: 'ECC-000001',
    customerName: '客户 1',
    status: 'executing',
    formallyEntered: true,
    preEntryExecution: false,
    region: 'East',
    regionNeedsAdjustment: false,
    entryAt: null,
    reminderAt: null,
    reminderNote: null,
    reminderDueClass: null,
    finalAmount: '100000.00',
    invoicedAmount: '0.00',
    contractAmount: '100000.00',
    entryAmountSnapshot: null,
    counts: { batches: 0, instruments: 0, activities: 0, orders: 0, repairs: 0, invoices: 0 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: ['tag-1'],
    groupedTags: [],
    updatedAt: '2026-08-08T08:00:00+08:00',
    planVisitAt: null,
  };
}

const p = project();
const overview: WorkbenchV2OverviewDto = {
  businessRevision: 1,
  generatedAt: '2026-08-08T09:00:00+08:00',
  metrics: {
    totalProjects: 1,
    activeProjects: 1,
    reminderCount: 0,
    reminderOverdue: 0,
    reminderToday: 0,
    pendingAcceptance: 0,
    pendingInvoice: 0,
    openRepairProjects: 0,
    pendingAmount: '0.00',
  },
  stages: [],
  reminderPreview: [],
  reminderTotal: 0,
  reminderWindowDays: 7,
};

function detail(): WorkbenchV2ProjectDetailDto {
  return {
    businessRevision: 1,
    project: p,
    detail: {
      managerApprovalReason: null,
      managerApprovalMissing: null,
      managerApproved: null,
      projectNote: null,
      temporaryStorageAddress: null,
      isTemporaryStorage: null,
      oldSiteContact: null,
      newSiteContact: null,
      oldSiteAddress: null,
      newSiteAddress: null,
      contractStartDate: null,
      contractEndDate: null,
      planVisitAt: null,
      planTransportAt: null,
      siteConfirmed: false,
      plannedInstallAt: null,
      plannedInstallDoneAt: null,
      actualInstallDoneAt: null,
      acceptanceReport: false,
      acceptanceReportDate: null,
      cancelledAt: null,
      cancelReason: null,
      temporaryInstrumentCount: null,
      temporaryInstrumentName: null,
      temporaryInstrumentModel: null,
      temporaryHasUps: null,
      createdAt: '2026-08-01T00:00:00Z',
      customerId: 'c1',
      contractId: 'ct1',
    },
  };
}

function mockApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
    v2Overview: vi.fn().mockResolvedValue(overview),
    v2ProjectPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      projects: [p],
      total: 1,
      nextCursor: null,
      limit: 20,
      pageSize: 20,
    } as WorkbenchV2ProjectPageDto),
    v2ProjectDetail: vi.fn().mockResolvedValue(detail()),
    v2SectionPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      kind: 'orders' as const,
      projectId: 'p-1',
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
    } as any),
    v2HistoryPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'service_order' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2ReminderPage: vi.fn().mockResolvedValue({ businessRevision: 1, rows: [], total: 0, nextCursor: null, limit: 50, sort: 'desc' as const }),
    v2ReminderLanes: vi.fn().mockResolvedValue({ businessRevision: 1, dates: [], lanes: [], lanePageSize: 50 }),
    v2TagCatalog: vi.fn().mockResolvedValue(tagCatalog),
    v2TagMutate: vi.fn().mockResolvedValue({ businessRevision: 2, group: tagCatalog.groups[0] as any, invalidated: [] }),
    v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'qr_request' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2LookupPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'customers' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    v2Delete: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    cleanPrepare: vi.fn().mockResolvedValue({ token: 't', expiresAt: Date.now() + 60000, databaseInstanceId: 'db', contentGenerationId: 'gen', revision: 1, counts: {} as any, auditCounts: {} as any }),
    cleanConfirm: vi.fn().mockResolvedValue({} as any),
    backupManual: vi.fn().mockResolvedValue({ canceled: true } as any),
    restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true } as any),
    buildReport: vi.fn().mockResolvedValue({
      range: { from: '2026-08', to: '2026-08' },
      filters: {},
      generatedAt: '2026-08-31T00:00:00Z',
      sections: [
        {
          key: 'monthly_order',
          label: '月度开单',
          rows: [{ month: '2026-08', count: 2 }],
        },
      ],
    } as any),
    drillDown: vi.fn().mockResolvedValue([
      {
        orderType: 'relocation',
        serviceOrderNo: 'SO-ML-001',
        orderedAt: '2026-08-15',
        customerName: '某重点中大型单位',
        engineer: '李工',
        workScope: 'medium_large',
      },
      {
        orderType: 'pm',
        serviceOrderNo: 'SO-OTHER-002',
        orderedAt: '2026-08-20',
        customerName: '某普通项目客户',
        engineer: '王工',
        workScope: 'other',
      },
    ]),
    exportReport: vi.fn().mockResolvedValue({ saved: true, path: '/tmp/report.xlsx' }),
    importWizard: {
      listDrafts: vi.fn().mockResolvedValue([]),
      createDraft: vi.fn(),
      openDraft: vi.fn(),
      deleteDraft: vi.fn(),
      saveStep: vi.fn(),
      downloadTemplate: vi.fn(),
      selectFiles: vi.fn(),
      pasteIntoCategory: vi.fn(),
      classifySheet: vi.fn(),
      setCategoryMode: vi.fn(),
      updateMapping: vi.fn(),
      queryRows: vi.fn(),
      patchCells: vi.fn(),
      addRow: vi.fn(),
      deleteRows: vi.fn(),
      validate: vi.fn(),
      saveConflictDecision: vi.fn(),
      cancelOperation: vi.fn(),
      summary: vi.fn(),
      commit: vi.fn(),
      settleInterrupted: vi.fn(),
      recover: vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: [] }),
      checkpoints: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      onProgress: vi.fn().mockReturnValue(() => undefined),
    },
    ...overrides,
  };
  return api as unknown as WorkbenchApi;
}

beforeEach(() => {
  Object.defineProperty(window, 'workbench', { value: mockApi(), configurable: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('报表工作范围筛选与排除反馈 (Task 4.3)', () => {
  it('报表提供全部工作范围/其他或既有/中大型筛选控件，且计算时透传工作范围', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    // 验证筛选下拉选项
    const scopeSelect = within(dialog).getByLabelText(/工作范围/) as HTMLSelectElement;
    expect(scopeSelect).toBeInTheDocument();
    const options = Array.from(scopeSelect.options).map((o) => ({ value: o.value, text: o.text }));
    expect(options).toEqual([
      { value: '', text: '全部工作范围' },
      { value: 'other', text: '其他/既有' },
      { value: 'medium_large', text: '中大型' },
    ]);

    // 选择月份与中大型筛选
    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.change(scopeSelect, { target: { value: 'medium_large' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

    await waitFor(() => {
      expect(api.buildReport).toHaveBeenCalledWith(
        expect.objectContaining({
          monthFrom: '2026-08',
          monthTo: '2026-08',
          workScope: 'medium_large',
        }),
      );
    });
  });

  it('选择区域或项目分类标签时展示排除独立记录反馈提示', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    // 初始未选区域与标签，不应有排除提示
    expect(dialog.querySelector('.report-exclusion-notice')).not.toBeInTheDocument();

    // 输入区域
    const regionInput = within(dialog).getByLabelText(/区域/);
    fireEvent.change(regionInput, { target: { value: 'East' } });

    // 应展示说明提示
    const notice = dialog.querySelector('.report-exclusion-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/中大型项目开单/);
    expect(notice).toHaveTextContent(/排除在统计/);

    // 清空区域后选择项目分类标签
    fireEvent.change(regionInput, { target: { value: '' } });
    const tagCheckbox = within(dialog).getByRole('checkbox', { name: '暂存' });
    fireEvent.click(tagCheckbox);

    const tagNotice = dialog.querySelector('.report-exclusion-notice');
    expect(tagNotice).toBeInTheDocument();
    expect(tagNotice).toHaveTextContent(/不关联项目的独立记录（含中大型项目开单）会被排除/);
  });

  it('下钻明细展示工作范围标识中文映射与客户单位', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

    await within(dialog).findByText('计算结果');
    const drillBtn = within(dialog).getByRole('button', { name: '查看明细' });
    fireEvent.click(drillBtn);

    // 查看下钻明细表格
    await within(dialog).findByText('下钻明细');
    const detailsTable = within(dialog).getByRole('table');
    expect(within(detailsTable).getByText('工作范围')).toBeInTheDocument();
    expect(within(detailsTable).getByText('中大型')).toBeInTheDocument();
    expect(within(detailsTable).getByText('其他/既有')).toBeInTheDocument();
    expect(within(detailsTable).getByText('某重点中大型单位')).toBeInTheDocument();
  });

  it('导出操作携带当前工作范围筛选参数', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/工作范围/), { target: { value: 'medium_large' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

    await within(dialog).findByText('计算结果');
    fireEvent.click(within(dialog).getByRole('button', { name: '导出 Excel' }));

    await waitFor(() => {
      expect(api.exportReport).toHaveBeenCalledWith(
        'xlsx',
        expect.objectContaining({
          workScope: 'medium_large',
        }),
      );
    });
  });

  it('开单指标显眼展示 rows[].count 合计单量而非仅显示分组行数，普通指标保持行数', async () => {
    const api = mockApi({
      buildReport: vi.fn().mockResolvedValue({
        range: { from: '2026-08', to: '2026-08' },
        filters: {},
        generatedAt: '2026-08-31T00:00:00Z',
        sections: [
          {
            key: 'monthly_service_order_count',
            label: '月度开单量',
            // 2 个分组行，但 count 分别是 8 和 12，总计 20 单
            rows: [
              { month: '2026-08', orderType: 'relocation', count: 8 },
              { month: '2026-08', orderType: 'pm', count: 12 },
            ],
          },
          {
            key: 'monthly_invoice_count',
            label: '月度掉票次数',
            // 2 个分组行，普通指标保持显示行数
            rows: [
              { month: '2026-08', count: 5 },
              { month: '2026-08', count: 7 },
            ],
          },
        ],
      } as any),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

    await within(dialog).findByText('计算结果');

    // 验证月度开单量指标：显眼展示合计 20 单，且包含 2 组分类
    const cards = dialog.querySelectorAll('.report-section');
    expect(cards[0]).toHaveTextContent('月度开单量');
    expect(cards[0]).toHaveTextContent('20');
    expect(cards[0]).toHaveTextContent('单');
    expect(cards[0]).toHaveTextContent('共 2 组分类');
    expect(cards[0]).not.toHaveTextContent('2 行');

    // 对照组：普通指标显示 2 行
    expect(cards[1]).toHaveTextContent('月度掉票次数');
    expect(cards[1]).toHaveTextContent('2 行');
  });

  it('默认全部范围或other下仅改region/tag/月份/范围均触发待应用锁定，旧下钻隐藏且重新计算恢复', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
    const dialog = await screen.findByRole('dialog', { name: '运营报表' });

    // 1. 默认全部范围（workScope 未选）初次计算报表
    fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-08' } });
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

    await within(dialog).findByText('计算结果');
    const drillBtn = within(dialog).getByRole('button', { name: '查看明细' });
    const exportBtn = within(dialog).getByRole('button', { name: '导出 Excel' });
    expect(drillBtn).not.toBeDisabled();
    expect(exportBtn).not.toBeDisabled();

    // 点击查看明细，下钻出现
    fireEvent.click(drillBtn);
    await within(dialog).findByText('下钻明细');
    expect(dialog.querySelector('.report-details')).toBeInTheDocument();

    // 2. 仅改 region：触发 isStale
    const regionInput = within(dialog).getByLabelText(/区域/);
    fireEvent.change(regionInput, { target: { value: 'East' } });

    // 验证排除提示显示待应用口径
    const exclusionNotice = dialog.querySelector('.report-exclusion-notice')!;
    expect(exclusionNotice).toHaveTextContent('点击计算后应用筛选');
    expect(exclusionNotice).toHaveTextContent(/中大型项目开单/);

    // 验证下钻按钮与导出按钮均被禁用，旧下钻隐藏，失效锁定横幅显示
    expect(drillBtn).toBeDisabled();
    expect(exportBtn).toBeDisabled();
    expect(dialog.querySelector('.report-details')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/筛选条件已更改，点击计算后应用筛选；当前旧结果、明细与导出已锁定/)).toBeVisible();

    // 重新计算后恢复
    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    await waitFor(() => {
      expect(drillBtn).not.toBeDisabled();
      expect(exportBtn).not.toBeDisabled();
    });

    // 3. 仅改 tagIds：勾选标签
    const tagCheckbox = within(dialog).getByRole('checkbox', { name: '暂存' });
    fireEvent.click(tagCheckbox);
    expect(drillBtn).toBeDisabled();
    expect(exportBtn).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    await waitFor(() => {
      expect(drillBtn).not.toBeDisabled();
      expect(exportBtn).not.toBeDisabled();
    });

    // 4. 仅改月份：修改截止月份
    fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-09' } });
    expect(drillBtn).toBeDisabled();
    expect(exportBtn).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    await waitFor(() => {
      expect(drillBtn).not.toBeDisabled();
      expect(exportBtn).not.toBeDisabled();
    });

    // 5. 切换到 other 范围
    fireEvent.change(within(dialog).getByLabelText(/工作范围/), { target: { value: 'other' } });
    expect(drillBtn).toBeDisabled();
    expect(exportBtn).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));
    await waitFor(() => {
      expect(api.buildReport).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workScope: 'other',
        }),
      );
      expect(drillBtn).not.toBeDisabled();
      expect(exportBtn).not.toBeDisabled();
    });
  });
});
