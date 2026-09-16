// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/app';
import type {
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionPageDto,
  WorkbenchV2OverviewDto,
  ProjectTagCatalogDto,
} from '../../src/shared/ipc';

const tagCatalog: ProjectTagCatalogDto = { businessRevision: 1, selectedTagIds: [], groups: [] };

function createTestProject(): WorkbenchProjectRow {
  return {
    id: 'p-1',
    tempNo: 'TMP-000001',
    ecc: 'ECC-000001',
    customerName: '测试客户1',
    status: 'executing',
    formallyEntered: true,
    preEntryExecution: false,
    region: 'East',
    regionNeedsAdjustment: false,
    entryAt: '2026-08-01',
    reminderAt: null,
    reminderNote: null,
    reminderDueClass: null,
    finalAmount: '100000.00',
    invoicedAmount: '0.00',
    contractAmount: '100000.00',
    entryAmountSnapshot: null,
    counts: { batches: 0, instruments: 0, activities: 0, orders: 1, repairs: 0, invoices: 0 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: [],
    groupedTags: [],
    updatedAt: '2026-08-08T08:00:00+08:00',
    planVisitAt: null,
  };
}

const p = createTestProject();
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

function createTestDetail(): WorkbenchV2ProjectDetailDto {
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
    v2ProjectDetail: vi.fn().mockResolvedValue(createTestDetail()),
    v2SectionPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      kind: 'orders' as const,
      projectId: 'p-1',
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
    } as WorkbenchV2SectionPageDto),
    v2HistoryPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      kind: 'service_order' as const,
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
    } as any),
    v2ReminderPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
      sort: 'desc' as const,
    }),
    v2ReminderLanes: vi.fn().mockResolvedValue({ businessRevision: 1, dates: [], lanes: [], lanePageSize: 50 }),
    v2TagCatalog: vi.fn().mockResolvedValue(tagCatalog),
    v2TagMutate: vi.fn().mockResolvedValue({ businessRevision: 2, group: tagCatalog.groups[0] as any, invalidated: [] }),
    v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'serial_address' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2LookupPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'customers' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2Mutate: vi.fn().mockResolvedValue({
      businessRevision: 2,
      invalidated: ['overview', 'projects', 'project:p-1', 'sections:p-1'],
      changed: { projectId: 'p-1' },
    }),
    v2Delete: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    cleanPrepare: vi.fn().mockResolvedValue({ token: 't', expiresAt: Date.now() + 60000, databaseInstanceId: 'db', contentGenerationId: 'gen', revision: 1, counts: {} as any, auditCounts: {} as any }),
    cleanConfirm: vi.fn().mockResolvedValue({} as any),
    backupManual: vi.fn().mockResolvedValue({ canceled: true } as any),
    restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true } as any),
    buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [] } as any),
    drillDown: vi.fn().mockResolvedValue([]),
    exportReport: vi.fn().mockResolvedValue({ saved: true } as any),
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

describe('人工调整主状态下拉新增选项交互', () => {
  it('人工调整主状态下拉包含「已转单」与「已取消」选项', async () => {
    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    const select = within(context).getByLabelText('人工调整主状态');

    const transferredOption = within(select).getByRole('option', { name: '已转单' });
    expect(transferredOption).toBeInTheDocument();
    expect(transferredOption).toHaveValue('transferred');

    const cancelledOption = within(select).getByRole('option', { name: '已取消' });
    expect(cancelledOption).toBeInTheDocument();
    expect(cancelledOption).toHaveValue('cancelled');

    // 同时验证常规状态仍存在
    expect(within(select).getByRole('option', { name: '待进单' })).toHaveValue('pending_entry');
    expect(within(select).getByRole('option', { name: '执行中' })).toHaveValue('executing');
    expect(within(select).getByRole('option', { name: '维修中' })).toHaveValue('under_repair');
    expect(within(select).getByRole('option', { name: '已完成' })).toHaveValue('completed');
  });

  it('选择「已转单」后点击提交校验，作为普通人工状态走 adjust_status 提交', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });

    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    const select = within(context).getByLabelText('人工调整主状态');

    fireEvent.change(select, { target: { value: 'transferred' } });
    expect(select).toHaveValue('transferred');

    const submitBtn = within(context).getByRole('button', { name: '提交校验' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(api.v2Mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'adjust_status',
          projectId: 'p-1',
          status: 'transferred',
        }),
      );
    });

    // 确认未打开取消弹窗，未调用 cancel_project
    expect(screen.queryByRole('dialog', { name: '取消项目' })).not.toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'cancel_project' }),
    );
  });

  it('选择「已取消」后点击提交校验打开取消流程，有必填校验，且通过后调用 cancel_project', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });

    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    const select = within(context).getByLabelText('人工调整主状态');

    fireEvent.change(select, { target: { value: 'cancelled' } });
    expect(select).toHaveValue('cancelled');

    const submitBtn = within(context).getByRole('button', { name: '提交校验' });
    fireEvent.click(submitBtn);

    // 绝不能把 cancelled 当普通 adjust_status 提交
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'adjust_status',
        status: 'cancelled',
      }),
    );

    // 打开了现有取消流程弹窗
    const dialog = await screen.findByRole('dialog', { name: '取消项目' });
    expect(dialog).toBeInTheDocument();

    const form = dialog.querySelector('form#project-cancel-form')!;
    expect(form).toBeInTheDocument();

    const timeInput = within(dialog).getByLabelText(/取消日期/);
    const reasonInput = within(dialog).getByLabelText(/取消原因/);
    const confirmCheckbox = within(dialog).getByRole('checkbox', { name: /我确认项目取消后不可恢复/ });

    // 必填校验测试 1：取消原因初始为空，直接提交应被拦截
    fireEvent.change(reasonInput, { target: { value: '   ' } });
    fireEvent.submit(form);
    expect(await within(dialog).findByText('请填写取消原因')).toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'cancel_project' }),
    );

    // 必填校验测试 2：未勾选确认不可恢复应被拦截
    fireEvent.change(reasonInput, { target: { value: '客户取消搬迁计划' } });
    expect(confirmCheckbox).not.toBeChecked();
    fireEvent.submit(form);
    expect(await within(dialog).findByText('请勾选确认不可恢复')).toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'cancel_project' }),
    );

    // 必填校验测试 3：清空取消日期应被拦截
    fireEvent.change(timeInput, { target: { value: '' } });
    fireEvent.click(confirmCheckbox);
    fireEvent.submit(form);
    expect(await within(dialog).findByText('请选择取消日期')).toBeInTheDocument();
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'cancel_project' }),
    );

    // 完整填写：取消日期、取消原因、勾选确认
    fireEvent.change(timeInput, { target: { value: '2026-08-10' } });
    fireEvent.change(reasonInput, { target: { value: '客户确认取消全部搬迁服务' } });
    if (!confirmCheckbox.matches(':checked')) {
      fireEvent.click(confirmCheckbox);
    }

    fireEvent.submit(form);

    // 验证调用 cancel_project 命令并包含时间和原因
    await waitFor(() => {
      expect(api.v2Mutate).toHaveBeenCalledWith({
        op: 'cancel_project',
        projectId: 'p-1',
        time: '2026-08-10',
        reason: '客户确认取消全部搬迁服务',
      });
    });

    // 始终未作为 adjust_status 提交
    expect(api.v2Mutate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'adjust_status',
        status: 'cancelled',
      }),
    );
  });

  it('保留原有「取消项目」按钮并同样走 cancel_project 流程', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });

    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });
    const cancelBtn = within(context).getByRole('button', { name: '取消项目' });
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);
    const dialog = await screen.findByRole('dialog', { name: '取消项目' });
    expect(dialog).toBeInTheDocument();

    const reasonInput = within(dialog).getByLabelText(/取消原因/);
    const confirmCheckbox = within(dialog).getByRole('checkbox', { name: /我确认项目取消后不可恢复/ });
    const form = dialog.querySelector('form#project-cancel-form')!;

    fireEvent.change(reasonInput, { target: { value: '项目终止' } });
    fireEvent.click(confirmCheckbox);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(api.v2Mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          op: 'cancel_project',
          projectId: 'p-1',
          reason: '项目终止',
        }),
      );
    });
  });

  it('已转单项目作为终态，隐藏人工调整主状态和取消项目入口，并保留状态 badge', async () => {
    const transferredProject: WorkbenchProjectRow = {
      ...p,
      id: 'p-transferred',
      customerName: '已转单客户',
      status: 'transferred',
    };
    const api = mockApi({
      v2ProjectPage: vi.fn().mockResolvedValue({
        businessRevision: 1,
        projects: [transferredProject],
        total: 1,
        nextCursor: null,
        limit: 20,
        pageSize: 20,
      } as WorkbenchV2ProjectPageDto),
      v2ProjectDetail: vi.fn().mockResolvedValue({
        businessRevision: 1,
        project: transferredProject,
        detail: createTestDetail().detail,
      }),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });

    render(<App />);
    const context = await screen.findByRole('complementary', { name: '当前上下文' });

    // 保留状态 badge 并展示「已转单」
    expect(within(context).getByText('已转单')).toBeInTheDocument();

    // 隐藏人工调整主状态下拉与提交校验
    expect(within(context).queryByLabelText('人工调整主状态')).not.toBeInTheDocument();
    expect(within(context).queryByRole('button', { name: '提交校验' })).not.toBeInTheDocument();

    // 隐藏取消项目按钮
    expect(within(context).queryByRole('button', { name: '取消项目' })).not.toBeInTheDocument();
  });
});
