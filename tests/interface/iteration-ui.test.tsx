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
  WorkbenchV2IndependentRow,
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

function project(overrides: Partial<WorkbenchProjectRow> = {}): WorkbenchProjectRow {
  return {
    id: 'p-1',
    tempNo: 'TMP-000001',
    ecc: 'ECC-000001',
    customerName: '某重点客户单位',
    status: 'executing',
    formallyEntered: true,
    preEntryExecution: false,
    region: 'East',
    regionNeedsAdjustment: false,
    entryAt: '2026-07-15',
    reminderAt: null,
    reminderNote: null,
    reminderDueClass: null,
    finalAmount: '120000.00',
    invoicedAmount: '20000.00',
    contractAmount: '120000.00',
    entryAmountSnapshot: '100000.00',
    counts: { batches: 1, instruments: 2, activities: 3, orders: 4, repairs: 0, invoices: 1 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: ['tag-1'],
    groupedTags: [],
    updatedAt: '2026-08-08T08:00:00+08:00',
    planVisitAt: '2026-08-15',
    ...overrides,
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

function detail(proj: WorkbenchProjectRow = p): WorkbenchV2ProjectDetailDto {
  return {
    businessRevision: 1,
    project: proj,
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
      planVisitAt: proj.planVisitAt,
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
  const currentProject = overrides.v2ProjectPage ? p : p;
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
    v2Overview: vi.fn().mockResolvedValue(overview),
    v2ProjectPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      projects: [currentProject],
      total: 1,
      nextCursor: null,
      limit: 20,
      pageSize: 20,
    } as WorkbenchV2ProjectPageDto),
    v2ProjectDetail: vi.fn().mockResolvedValue(detail(currentProject)),
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
    v2IndependentPage: vi.fn().mockResolvedValue({
      businessRevision: 1,
      kind: 'qr_request' as const,
      rows: [],
      total: 0,
      nextCursor: null,
      limit: 50,
    } as any),
    v2LookupPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'customers' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    v2Delete: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    cleanPrepare: vi.fn().mockResolvedValue({ token: 't', expiresAt: Date.now() + 60000, databaseInstanceId: 'db', contentGenerationId: 'gen', revision: 1, counts: {} as any, auditCounts: {} as any }),
    cleanConfirm: vi.fn().mockResolvedValue({} as any),
    backupManual: vi.fn().mockResolvedValue({ canceled: true } as any),
    restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true } as any),
    buildReport: vi.fn().mockResolvedValue({
      range: { from: '2026-07', to: '2026-08' },
      filters: {},
      generatedAt: '2026-08-31T00:00:00Z',
      sections: [],
    } as any),
    drillDown: vi.fn().mockResolvedValue([]),
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

describe('本次迭代 UI 界面与交互回归', () => {
  describe('需求 1：二维码独立页统计与筛选联动', () => {
    it('二维码独立页展示申请人/申请月份/类型工作量统计与申请条数，且统计联动筛选', async () => {
      const qrRows: WorkbenchV2IndependentRow[] = [
        {
          kind: 'qr_request',
          id: 'qr-1',
          applicant: '张主管',
          requestedAt: '2026-07-10',
          types: ['A', 'B'],
          workload: 2,
          createdAt: '2026-07-10T08:00:00Z',
        },
        {
          kind: 'qr_request',
          id: 'qr-2',
          applicant: '李工程师',
          requestedAt: '2026-08-01',
          types: ['A', 'logistics_management'],
          workload: 2,
          createdAt: '2026-08-01T09:00:00Z',
        },
      ];

      const qrStats = {
        requestCount: 2,
        workload: 4,
        byApplicant: [
          { applicant: '张主管', requestCount: 1, workload: 2 },
          { applicant: '李工程师', requestCount: 1, workload: 2 },
        ],
        byMonth: [
          { month: '2026-07', requestCount: 1, workload: 2 },
          { month: '2026-08', requestCount: 1, workload: 2 },
        ],
        byType: [
          { typeCode: 'A', count: 2 },
          { typeCode: 'B', count: 1 },
          { typeCode: 'logistics_management', count: 1 },
        ],
      };

      const api = mockApi({
        v2IndependentPage: vi.fn().mockResolvedValue({
          businessRevision: 1,
          kind: 'qr_request',
          rows: qrRows,
          total: 2,
          nextCursor: null,
          limit: 50,
          qrStats,
        }),
      });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });

      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      fireEvent.click(screen.getByRole('button', { name: '二维码申请' }));
      const dialog = await screen.findByRole('dialog', { name: '二维码申请' });

      // 验证统计总览
      const statsRegion = within(dialog).getByRole('region', { name: '二维码工作量统计' });
      expect(statsRegion).toHaveTextContent('申请总数（当前筛选）');
      expect(statsRegion).toHaveTextContent('2 条');
      expect(statsRegion).toHaveTextContent('总工作量（当前筛选）');
      expect(statsRegion).toHaveTextContent('4');
      expect(statsRegion).toHaveTextContent('申请人数量');
      expect(statsRegion).toHaveTextContent('2 人');
      expect(statsRegion).toHaveTextContent('有申请的月份');
      expect(statsRegion).toHaveTextContent('2 个月');

      // 验证申请人统计表
      expect(within(statsRegion).getByText('按申请人统计 (2)')).toBeInTheDocument();
      expect(within(statsRegion).getByText('张主管')).toBeInTheDocument();
      expect(within(statsRegion).getByText('李工程师')).toBeInTheDocument();

      // 切换到申请月份统计
      fireEvent.click(within(statsRegion).getByRole('tab', { name: /按申请月份统计/ }));
      expect(within(statsRegion).getByText('2026-07')).toBeInTheDocument();
      expect(within(statsRegion).getByText('2026-08')).toBeInTheDocument();

      // 切换到类型统计
      fireEvent.click(within(statsRegion).getByRole('tab', { name: /按类型统计/ }));
      expect(within(statsRegion).getByText('物流管理')).toBeInTheDocument();

      // 筛选联动验证：输入查询条件并查找
      const searchBox = within(dialog).getByRole('searchbox', { name: '查找记录' });
      fireEvent.change(searchBox, { target: { value: '张主管' } });
      fireEvent.change(within(dialog).getByLabelText('起始日期'), { target: { value: '2026-07-01' } });
      fireEvent.change(within(dialog).getByLabelText('截止日期'), { target: { value: '2026-07-31' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '查找' }));

      await waitFor(() => {
        expect(api.v2IndependentPage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            kind: 'qr_request',
            query: '张主管',
            from: '2026-07-01',
            to: '2026-07-31',
          }),
        );
      });
    });
  });

  describe('需求 2：下线到访记录入口与计数', () => {
    it('项目详情关联登记事实中不再展示上门活动计数，保留其他各项事实', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      // 点击展开完整项目资料
      const detailsToggle = screen.getByText('完整项目资料');
      fireEvent.click(detailsToggle);

      const facts = screen.getByRole('region', { name: '关联登记事实' });
      expect(facts).not.toHaveTextContent('上门活动');
      expect(facts).toHaveTextContent('物流费用登记1 条');
      expect(facts).toHaveTextContent('搬迁仪器2 台');
      expect(facts).toHaveTextContent('开单记录4 条');
      expect(facts).toHaveTextContent('掉票记录1 条');

      // 计划上门日期正常显示且未被移除
      expect(screen.getByText('计划上门日期')).toBeInTheDocument();
      expect(screen.getAllByText('2026-08-15').length).toBeGreaterThan(0);
    });

    it('历史浏览分类列表中已下线到访记录入口，但历史格式化安全兼容', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      fireEvent.click(screen.getByRole('button', { name: '浏览全部记录' }));
      const dialog = await screen.findByRole('dialog', { name: '浏览往期与全部记录' });

      // 验证历史分类中不再包含「到访记录」
      const kindList = dialog.querySelector('.history-kind-list')!;
      expect(kindList).not.toHaveTextContent('到访记录');
      expect(kindList).toHaveTextContent('物流费用');
      expect(kindList).toHaveTextContent('搬迁仪器');
      expect(kindList).toHaveTextContent('开单记录');
      expect(kindList).toHaveTextContent('掉票记录');
      expect(kindList).toHaveTextContent('损坏维修');
    });
  });

  describe('需求 3：显式快照更正 UI', () => {
    it('进单资料更正表单默认不提交快照更正，空值不会被覆盖为0，勾选显式更正后提示回溯影响并提交USD值', async () => {
      const api = mockApi();
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });

      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      // 处于正式进单状态，点击「更正进单/合同资料」
      fireEvent.click(screen.getByRole('button', { name: '更正进单/合同资料' }));
      const dialog = await screen.findByRole('dialog', { name: '更正进单/合同资料' });

      // 检查当前快照展示
      expect(within(dialog).getByText(/当前进单金额快照：/)).toBeInTheDocument();
      expect(within(dialog).getByText(/USD 100,000.00/)).toBeInTheDocument();

      // 1. 普通进单更正：仅修改 ECC，不勾选快照更正
      const form1 = document.getElementById('entry-correction-form') as HTMLFormElement;
      const eccInput = within(dialog).getByLabelText(/^ECC/);
      fireEvent.change(eccInput, { target: { value: 'ECC-UPDATED-001' } });
      fireEvent.submit(form1);

      await waitFor(() => {
        expect(api.v2Mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            op: 'update_project',
            payload: expect.objectContaining({
              projectId: 'p-1',
              ecc: 'ECC-UPDATED-001',
            }),
          }),
        );
      });
      // 确认 payload 中没有 entryAmountSnapshot
      const firstCallPayload = (api.v2Mutate as any).mock.calls[0][0].payload;
      expect(firstCallPayload.entryAmountSnapshot).toBeUndefined();

      // 2. 重新打开表单，勾选「更正进单金额快照」
      fireEvent.click(screen.getByRole('button', { name: '更正进单/合同资料' }));
      const reopenDialog = await screen.findByRole('dialog', { name: '更正进单/合同资料' });
      const form2 = document.getElementById('entry-correction-form') as HTMLFormElement;
      const checkbox = within(reopenDialog).getByRole('checkbox', { name: '更正进单金额快照' });
      fireEvent.click(checkbox);

      // 应出现明确的回溯影响警告
      expect(within(reopenDialog).getByText(/更正后将重新计算原进单月份的统计，不影响当前合同金额。/)).toBeInTheDocument();

      // 3. 空值校验：清空输入提交阻止保存
      const snapshotInput = within(reopenDialog).getByRole('spinbutton', { name: /更正进单金额快照/ });
      fireEvent.change(snapshotInput, { target: { value: '' } });
      fireEvent.submit(form2);
      expect(within(reopenDialog).getByText(/更正进单金额快照时，金额不能为空/)).toBeInTheDocument();

      // 4. 输入有效金额保存
      fireEvent.change(snapshotInput, { target: { value: '115000.00' } });
      fireEvent.submit(form2);

      await waitFor(() => {
        expect(api.v2Mutate).toHaveBeenCalledWith(
          expect.objectContaining({
            op: 'update_project',
            payload: expect.objectContaining({
              projectId: 'p-1',
              entryAmountSnapshot: '115000.00',
            }),
          }),
        );
      });
    });
  });

  describe('需求 4：运营报表月度掉票与二维码申请人视图', () => {
    it('月度掉票按月份+区域展示金额/次数/去重项目数，且标注已撤销不计并支持切换明细', async () => {
      const monthlyInvoiceRows = [
        { month: '2026-07', region: '华东', projectCount: 2, amountCents: '20000.00', count: 3 },
        { month: '2026-08', region: '华北', projectCount: 1, amountCents: '15000.00', count: 1 },
      ];

      const invoiceDetails = [
        {
          month: '2026-07',
          invoiceId: 'inv-1',
          projectId: 'p-1',
          projectTempNo: 'TMP-001',
          region: '华东',
          invoicedAt: '2026-07-20',
          amountCents: '10000.00',
        },
      ];

      const api = mockApi({
        buildReport: vi.fn().mockResolvedValue({
          range: { from: '2026-07', to: '2026-08' },
          filters: {},
          generatedAt: '2026-08-31T00:00:00Z',
          sections: [
            {
              key: 'monthly_invoice_amount',
              label: '月度掉票',
              rows: monthlyInvoiceRows,
            },
          ],
        }),
        drillDown: vi.fn().mockResolvedValue(invoiceDetails),
      });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });

      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
      const dialog = await screen.findByRole('dialog', { name: '运营报表' });

      fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } });
      fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

      await within(dialog).findByText('计算结果');
      const invoiceCard = within(dialog).getByText('月度掉票').closest<HTMLElement>('.report-section')!;
      fireEvent.click(within(invoiceCard).getByRole('button', { name: '查看明细' }));

      // 检查月度掉票汇总表展示
      await waitFor(() => expect(dialog.querySelector('.report-details')).not.toBeNull());
      const detailsSection = dialog.querySelector<HTMLElement>('.report-details')!;
      expect(within(detailsSection).getByRole('heading', { name: '月度掉票' })).toBeInTheDocument();
      expect(within(dialog).getAllByText(/已撤销不计/).length).toBeGreaterThan(0);
      const table = within(detailsSection).getByRole('table');
      for (const heading of ['月份', '区域', '掉票金额（USD）', '掉票次数', '去重项目数']) {
        expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
      }
      expect(table).toHaveTextContent('华东');
      expect(table).toHaveTextContent('20000.00');
      expect(table).toHaveTextContent('3');
      expect(table).toHaveTextContent('2');

      // 切换到掉票下钻明细视图
      const detailTab = within(dialog).getByRole('tab', { name: /掉票下钻明细/ });
      fireEvent.click(detailTab);
      const detailTable = within(dialog).getByRole('table');
      expect(within(detailTable).getByRole('columnheader', { name: '掉票记录编号' })).toBeInTheDocument();
      expect(detailTable).toHaveTextContent('inv-1');
    });

    it('运营报表支持二维码申请人统计与申请类型工作量视图', async () => {
      const applicantWorkloadRows = [
        { month: '2026-07', applicant: '业务专员甲', requestCount: 3, workload: 6 },
      ];
      const applicantTypeRows = [
        { month: '2026-07', applicant: '业务专员甲', typeCode: 'A', count: 3 },
        { month: '2026-07', applicant: '业务专员甲', typeCode: 'logistics_management', count: 3 },
      ];

      const api = mockApi({
        buildReport: vi.fn().mockResolvedValue({
          range: { from: '2026-07', to: '2026-08' },
          filters: {},
          generatedAt: '2026-08-31T00:00:00Z',
          sections: [
            {
              key: 'qr_applicant_workload',
              label: '二维码申请人统计',
              rows: applicantWorkloadRows,
            },
            {
              key: 'qr_applicant_type_workload',
              label: '二维码申请类型工作量',
              rows: applicantTypeRows,
            },
          ],
        }),
      });
      Object.defineProperty(window, 'workbench', { value: api, configurable: true });

      render(<App />);
      await screen.findByRole('heading', { name: /项目队列/ });

      fireEvent.click(screen.getByRole('button', { name: '运营报表' }));
      const dialog = await screen.findByRole('dialog', { name: '运营报表' });

      fireEvent.change(within(dialog).getByLabelText(/起始月份/), { target: { value: '2026-07' } });
      fireEvent.change(within(dialog).getByLabelText(/截止月份/), { target: { value: '2026-08' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '实时计算报表' }));

      await within(dialog).findByText('计算结果');

      // 1. 点击二维码申请人统计卡片的查看明细
      const applicantCard = within(dialog).getByText('二维码申请人统计').closest<HTMLElement>('.report-section')!;
      fireEvent.click(within(applicantCard).getByRole('button', { name: '查看明细' }));

      const applicantDetails = dialog.querySelector<HTMLElement>('.report-details')!;
      expect(within(applicantDetails).getByRole('heading', { name: '二维码申请人统计' })).toBeInTheDocument();
      expect(within(applicantDetails).getByText(/申请人是业务申请人，非后台操作人/)).toBeInTheDocument();
      let table = within(applicantDetails).getByRole('table');
      for (const heading of ['月份', '申请人', '申请条数', '工作量']) {
        expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
      }
      expect(table).toHaveTextContent('业务专员甲');
      expect(table).toHaveTextContent('3');
      expect(table).toHaveTextContent('6');

      // 2. 点击二维码申请类型工作量卡片的查看明细
      const typeCard = within(dialog).getByText('二维码申请类型工作量').closest<HTMLElement>('.report-section')!;
      fireEvent.click(within(typeCard).getByRole('button', { name: '查看明细' }));

      const typeDetails = dialog.querySelector<HTMLElement>('.report-details')!;
      expect(within(typeDetails).getByRole('heading', { name: '二维码申请类型工作量' })).toBeInTheDocument();
      table = within(typeDetails).getByRole('table');
      expect(within(table).getByRole('columnheader', { name: '二维码申请类型' })).toBeInTheDocument();
      expect(table).toHaveTextContent('物流管理');
      expect(table).toHaveTextContent('3');
    });
  });
});
