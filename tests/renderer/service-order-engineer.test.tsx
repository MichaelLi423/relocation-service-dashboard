// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-unused-vars */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../src/renderer/app';
import type { WorkbenchApi, WorkbenchProjectRow, WorkbenchV2ProjectDetailDto, WorkbenchV2ProjectPageDto, WorkbenchV2SectionPageDto, WorkbenchV2OverviewDto, ProjectTagCatalogDto } from '../../src/shared/ipc';

const tagCatalog: ProjectTagCatalogDto = { businessRevision: 1, selectedTagIds: [], groups: [] };

function project(): WorkbenchProjectRow {
  return {
    id: 'p-1', tempNo: 'TMP-000001', ecc: 'ECC-000001', customerName: '客户 1', status: 'executing', formallyEntered: true,
    preEntryExecution: false, region: 'East', regionNeedsAdjustment: false, entryAt: null,
    reminderAt: null, reminderNote: null, reminderDueClass: null, finalAmount: '100000.00', invoicedAmount: '0.00', contractAmount: '100000.00', entryAmountSnapshot: null,
    counts: { batches: 0, instruments: 0, activities: 0, orders: 1, repairs: 0, invoices: 0 },
    nonBlocking: { pendingShipTo: 0, qrUnmarked: 0, repairs: 0 },
    tagIds: [], groupedTags: [], updatedAt: '2026-08-08T08:00:00+08:00', planVisitAt: null,
  };
}

const p = project();
const overview: WorkbenchV2OverviewDto = {
  businessRevision: 1, generatedAt: '2026-08-08T09:00:00+08:00',
  metrics: { totalProjects: 1, activeProjects: 1, reminderCount: 0, reminderOverdue: 0, reminderToday: 0, pendingAcceptance: 0, pendingInvoice: 0, openRepairProjects: 0, pendingAmount: '0.00' },
  stages: [], reminderPreview: [], reminderTotal: 0, reminderWindowDays: 7,
};

function detail(): WorkbenchV2ProjectDetailDto {
  return {
    businessRevision: 1, project: p,
    detail: {
      managerApprovalReason: null, managerApprovalMissing: null, managerApproved: null,
      projectNote: null, temporaryStorageAddress: null, isTemporaryStorage: null,
      oldSiteContact: null, newSiteContact: null, oldSiteAddress: null, newSiteAddress: null,
      contractStartDate: null, contractEndDate: null, planVisitAt: null, planTransportAt: null, siteConfirmed: false,
      plannedInstallAt: null, plannedInstallDoneAt: null, actualInstallDoneAt: null,
      acceptanceReport: false, acceptanceReportDate: null, cancelledAt: null, cancelReason: null,
      temporaryInstrumentCount: null, temporaryInstrumentName: null, temporaryInstrumentModel: null, temporaryHasUps: null,
      createdAt: '2026-08-01T00:00:00Z', customerId: 'c1', contractId: 'ct1',
    },
  };
}

function mockApi(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue([]),
    getAccountStatus: vi.fn().mockResolvedValue({ initialized: true, autoBackupError: null }),
    getSession: vi.fn().mockResolvedValue({ accountId: 'a1', username: '负责人' }),
    v2Overview: vi.fn().mockResolvedValue(overview),
    v2ProjectPage: vi.fn().mockResolvedValue({ businessRevision: 1, projects: [p], total: 1, nextCursor: null, limit: 20, pageSize: 20 } as WorkbenchV2ProjectPageDto),
    v2ProjectDetail: vi.fn().mockResolvedValue(detail()),
    v2SectionPage: vi.fn().mockImplementation((_req: { kind: WorkbenchV2SectionPageDto['kind'] }) => {
      return Promise.resolve({
        businessRevision: 1, kind: 'orders' as const, projectId: 'p-1',
        rows: [{ kind: 'orders' as const, id: 'order-1', projectId: 'p-1', orderType: 'relocation' as const, serviceOrderNo: 'SO-1', orderedAt: '2026-08-08', engineer: null, customerName: '客户 1', note: null, createdAt: '2026-08-08T00:00:00Z' }],
        total: 1, nextCursor: null, limit: 50,
      } as WorkbenchV2SectionPageDto);
    }),
    v2HistoryPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'service_order' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2ReminderPage: vi.fn().mockResolvedValue({ businessRevision: 1, rows: [], total: 0, nextCursor: null, limit: 50, sort: 'desc' as const }),
    v2ReminderLanes: vi.fn().mockResolvedValue({ businessRevision: 1, dates: [], lanes: [], lanePageSize: 50 }),
    v2TagCatalog: vi.fn().mockResolvedValue(tagCatalog),
    v2TagMutate: vi.fn().mockResolvedValue({ businessRevision: 2, group: tagCatalog.groups[0] as any, invalidated: [] }),
    v2IndependentPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'serial_address' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2LookupPage: vi.fn().mockResolvedValue({ businessRevision: 1, kind: 'customers' as const, rows: [], total: 0, nextCursor: null, limit: 50 } as any),
    v2Mutate: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: ['overview', 'projects', 'project:p-1', 'sections:p-1'], changed: { projectId: 'p-1' } }),
    v2Delete: vi.fn().mockResolvedValue({ businessRevision: 2, invalidated: [], changed: null }),
    cleanPrepare: vi.fn().mockResolvedValue({ token: 't', expiresAt: Date.now()+60000, databaseInstanceId: 'db', contentGenerationId: 'gen', revision: 1, counts: {} as any, auditCounts: {} as any }),
    cleanConfirm: vi.fn().mockResolvedValue({} as any),
    backupManual: vi.fn().mockResolvedValue({ canceled: true } as any), restoreFromBackup: vi.fn().mockResolvedValue({ canceled: true } as any),
    buildReport: vi.fn().mockResolvedValue({ range: { from: '2026-07', to: '2026-08' }, filters: {}, generatedAt: '', sections: [] } as any), drillDown: vi.fn().mockResolvedValue([]), exportReport: vi.fn().mockResolvedValue({ saved: true } as any),
    importWizard: { listDrafts: vi.fn().mockResolvedValue([]), createDraft: vi.fn(), openDraft: vi.fn(), deleteDraft: vi.fn(), saveStep: vi.fn(), downloadTemplate: vi.fn(), selectFiles: vi.fn(), pasteIntoCategory: vi.fn(), classifySheet: vi.fn(), setCategoryMode: vi.fn(), updateMapping: vi.fn(), queryRows: vi.fn(), patchCells: vi.fn(), addRow: vi.fn(), deleteRows: vi.fn(), validate: vi.fn(), saveConflictDecision: vi.fn(), cancelOperation: vi.fn(), summary: vi.fn(), commit: vi.fn(), settleInterrupted: vi.fn(), recover: vi.fn().mockResolvedValue({ recovered: [], pendingOutcome: [] }), checkpoints: vi.fn(), undo: vi.fn(), redo: vi.fn(), onProgress: vi.fn().mockReturnValue(() => undefined) },
    ...overrides,
  };
  return api as unknown as WorkbenchApi;
}

beforeEach(() => { Object.defineProperty(window, 'workbench', { value: mockApi(), configurable: true }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('开单工程师补录 renderer', () => {
  it('工程师空值显示待补，补录表单展示待补并可后补或清空', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('tab', { name: '开单记录' }));
    const detailRegion = await screen.findByRole('region', { name: '客户 1' });
    const table = await within(detailRegion).findByRole('table');
    expect(within(table).getByText('待补')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: '后补备注' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('待补')).toBeInTheDocument();
    const engineerInput = within(dialog).getByLabelText(/工程师/) as HTMLInputElement;
    expect(engineerInput).toBeInTheDocument();
    expect(engineerInput.value).toBe('');
    expect(within(dialog).getByRole('button', { name: '补充工程师' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '清空工程师' })).toBeDisabled();
    fireEvent.change(engineerInput, { target: { value: '工程师甲' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '补充工程师' }));
    await waitFor(() => expect(api.v2Mutate).toHaveBeenCalledWith({ op: 'service_order_engineer_update', payload: { orderId: 'order-1', engineer: '工程师甲' } }));
  });

  it('快速记录开单工程师字段为可后补非必填', async () => {
    const api = mockApi(); Object.defineProperty(window, 'workbench', { value: api, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getAllByRole('button', { name: '快速记录' })[0]!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /开单记录/ }));
    const dialog = screen.getByRole('dialog');
    const engineer = within(dialog).getByLabelText(/工程师/);
    expect(engineer).not.toBeRequired();
    expect(engineer.closest('div')?.textContent).toMatch(/可后补/);
    expect(within(dialog).getByLabelText(/工程师/).closest('div')?.textContent).not.toMatch(/必填/);
  });

  it('有值工程师可更正并可清空', async () => {
    const apiWithEngineer = mockApi({
      v2SectionPage: vi.fn().mockImplementation((_req: { kind: WorkbenchV2SectionPageDto['kind'] }) => Promise.resolve({
        businessRevision: 1, kind: 'orders' as const, projectId: 'p-1',
        rows: [{ kind: 'orders' as const, id: 'order-1', projectId: 'p-1', orderType: 'relocation' as const, serviceOrderNo: 'SO-1', orderedAt: '2026-08-08', engineer: '工程师甲', customerName: '客户 1', note: '备注', createdAt: '2026-08-08T00:00:00Z' }],
        total: 1, nextCursor: null, limit: 50,
      } as WorkbenchV2SectionPageDto)),
    });
    Object.defineProperty(window, 'workbench', { value: apiWithEngineer, configurable: true });
    render(<App />);
    await screen.findByRole('heading', { name: /项目队列/ });
    fireEvent.click(screen.getByRole('tab', { name: '开单记录' }));
    const detailRegion = await screen.findByRole('region', { name: '客户 1' });
    const table = await within(detailRegion).findByRole('table');
    expect(within(table).getByText('工程师甲')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: '修改备注' }));
    const dialog = await screen.findByRole('dialog');
    const engineerInput = within(dialog).getByLabelText(/工程师/) as HTMLInputElement;
    expect(engineerInput.value).toBe('工程师甲');
    expect(within(dialog).getByRole('button', { name: '保存工程师' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '清空工程师' })).not.toBeDisabled();
    fireEvent.change(engineerInput, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '清空工程师' }));
    await waitFor(() => expect(apiWithEngineer.v2Mutate).toHaveBeenCalledWith({ op: 'service_order_engineer_update', payload: { orderId: 'order-1', engineer: null } }));
  });
});
