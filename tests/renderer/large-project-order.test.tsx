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
  WorkbenchV2SectionPageDto,
  WorkbenchV2OverviewDto,
  ProjectTagCatalogDto,
} from '../../src/shared/ipc';

const tagCatalog: ProjectTagCatalogDto = { businessRevision: 1, selectedTagIds: [], groups: [] };

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
    tagIds: [],
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
    } as WorkbenchV2SectionPageDto),
    v2HistoryPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      kind: 'service_order' as const,
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
    } as any),
    v2ReminderPage: vi.fn().mockResolvedValue({ businessRevision: 1, rows: [], total: 0, nextCursor: null, limit: 50, sort: 'desc' as const }),
    v2ReminderLanes: vi.fn().mockResolvedValue({ businessRevision: 1, dates: [], lanes: [], lanePageSize: 50 }),
    v2TagCatalog: vi.fn().mockResolvedValue(tagCatalog),
    v2TagMutate: vi.fn().mockResolvedValue({ businessRevision: 2, group: tagCatalog.groups[0] as any, invalidated: [] }),
    v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'qr_request' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2LookupPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'customers' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: ['overview'], changed: null }),
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

describe('中大型项目开单独立入口与表单交互 (Task 4.1)', () => {
  it('顶部导航“二维码申请”后紧邻展示独立开单入口，且无需选中项目即可直接使用', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    const nav = screen.getByRole('navigation', { name: '主导航' });
    const buttons = within(nav).getAllByRole('button');
    const qrIndex = buttons.findIndex((b) => b.textContent?.includes('二维码申请'));
    const largeOrderIndex = buttons.findIndex((b) => b.textContent?.includes('中大型项目开单'));

    expect(qrIndex).toBeGreaterThan(-1);
    expect(largeOrderIndex).toBe(qrIndex + 1);

    const largeOrderBtn = buttons[largeOrderIndex]!;
    expect(largeOrderBtn).not.toBeDisabled();
    fireEvent.click(largeOrderBtn);

    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/四类类型不关联搬迁项目/)).toBeInTheDocument();
  });

  it('表单展示开单类型、服务单号、开单日期、客户单位及可后补工程师，且仅有四类业务类型', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '中大型项目开单' }));
    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });

    // 开单类型选项严格为四种
    const typeSelect = within(dialog).getByLabelText(/开单类型/) as HTMLSelectElement;
    const optionValues = Array.from(typeSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(['relocation', 'certification', 'parts_by_mail', 'pm']);
    expect(optionValues).not.toContain('other_type');

    // 必填与可后补校验
    expect(within(dialog).getByLabelText(/服务单号/)).toBeRequired();
    expect(within(dialog).getByLabelText(/开单日期/)).toBeRequired();
    expect(within(dialog).getByLabelText(/客户单位/)).toBeRequired();
    const engineer = within(dialog).getByLabelText(/工程师/);
    expect(engineer).not.toBeRequired();
    expect(engineer.closest('div')?.textContent).toMatch(/可后补/);
  });

  it('打开时首字段获得焦点，干净草稿按 Escape 可直接关闭表单', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '中大型项目开单' }));
    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });

    await waitFor(() => {
      const typeSelect = within(dialog).getByLabelText(/开单类型/);
      expect(typeSelect).toHaveFocus();
    });

    // 干净未修改草稿，按 Escape 直接关闭
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '中大型项目开单' })).not.toBeInTheDocument();
    });
  });

  it('未填写客户单位或服务单号时就地提示并阻止提交', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '中大型项目开单' }));
    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });
    const form = dialog.querySelector('form')!;

    // 未填客户单位
    fireEvent.change(within(dialog).getByLabelText(/服务单号/), { target: { value: 'SO-1001' } });
    fireEvent.submit(form);

    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写客户单位');

    // 未填服务单号
    fireEvent.change(within(dialog).getByLabelText(/客户单位/), { target: { value: '某大型科技有限公司' } });
    fireEvent.change(within(dialog).getByLabelText(/服务单号/), { target: { value: '' } });
    fireEvent.submit(form);

    expect(within(dialog).getByRole('alert')).toHaveTextContent('请填写服务单号');
  });

  it('填写完整四类之一保存成功，显式传递 workScope medium_large 且不传 projectId，显示 Toast 并关闭', async () => {
    const api = mockApi();
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '中大型项目开单' }));
    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });
    const form = dialog.querySelector('form')!;

    fireEvent.change(within(dialog).getByLabelText(/开单类型/), { target: { value: 'pm' } });
    fireEvent.change(within(dialog).getByLabelText(/服务单号/), { target: { value: 'SO-PM-8899' } });
    fireEvent.change(within(dialog).getByLabelText(/开单日期/), { target: { value: '2026-09-18' } });
    fireEvent.change(within(dialog).getByLabelText(/客户单位/), { target: { value: '上海中大型研发中心' } });
    // 工程师留空
    fireEvent.change(within(dialog).getByLabelText(/工程师/), { target: { value: '   ' } });

    fireEvent.submit(form);

    await waitFor(() => {
      expect(api.v2Mutate).toHaveBeenCalledWith({
        op: 'submit_action',
        action: {
          type: 'order',
          values: {
            workScope: 'medium_large',
            orderType: 'pm',
            serviceOrderNo: 'SO-PM-8899',
            orderedAt: '2026-09-18',
            customerName: '上海中大型研发中心',
            engineer: null,
          },
        },
      });
    });

    // 成功 Toast 呈现且弹窗关闭
    expect(await screen.findByRole('status')).toHaveTextContent('中大型项目开单已保存');
    expect(screen.queryByRole('dialog', { name: '中大型项目开单' })).not.toBeInTheDocument();
  });

  it('保存失败时就地提示错误原因并不关闭弹层', async () => {
    const api = mockApi({
      v2Mutate: vi.fn().mockRejectedValue(new Error('单号 SO-DUP-001 已存在，禁止重复登记')),
    });
    Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });

    fireEvent.click(screen.getByRole('button', { name: '中大型项目开单' }));
    const dialog = await screen.findByRole('dialog', { name: '中大型项目开单' });
    const form = dialog.querySelector('form')!;

    fireEvent.change(within(dialog).getByLabelText(/服务单号/), { target: { value: 'SO-DUP-001' } });
    fireEvent.change(within(dialog).getByLabelText(/客户单位/), { target: { value: '客户单位乙' } });

    fireEvent.submit(form);

    const errorAlert = await within(dialog).findByRole('alert');
    expect(errorAlert).toHaveTextContent('单号 SO-DUP-001 已存在，禁止重复登记');
    expect(dialog).toBeInTheDocument();
  });
});
