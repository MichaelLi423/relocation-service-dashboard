// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MobileReadonlyApp } from '../../src/mobile/App';
import { browserEnvironment, MobileReadonlyController } from '../../src/mobile/controller';
import {
  type MobileReadonlyOverview,
  type MobileReadonlyPartStatus,
  type MobileReadonlyProjectDetailFields,
  type MobileReadonlyProjectSummary,
  type MobileReadonlyPublishMetadata,
  type MobileReadonlyQueryResponse,
} from '../../src/shared/mobile-readonly';

afterEach(cleanup);

const metadataV2: MobileReadonlyPublishMetadata = {
  published: true,
  currentVersion: 2,
  publicationId: 'synthetic-v2',
  publishedAt: '2026-08-08T03:00:00Z',
  dataAsOf: '2026-08-08T02:30:00Z',
  snapshotSchemaVersion: 2,
  fingerprint: { contentGenerationId: 'synthetic', businessRevision: 2 },
};

const metadataV1: MobileReadonlyPublishMetadata = {
  published: true,
  currentVersion: 1,
  publicationId: 'synthetic-v1',
  publishedAt: '2026-08-08T01:00:00Z',
  dataAsOf: '2026-08-08T00:30:00Z',
  snapshotSchemaVersion: 1,
  fingerprint: { contentGenerationId: 'synthetic', businessRevision: 1 },
};

function response<T>(data: T, meta = metadataV2) {
  const body: MobileReadonlyQueryResponse<T> = { metadata: meta, data };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('独立手机只读视图扩展测试（v2 现行扩展与边界）', () => {
  it('概览展示新增指标（提醒项目/今日到期/逾期/有未结维修）与项目列表卡片多维信息（含远期提醒）', async () => {
    const overview: MobileReadonlyOverview = {
      metrics: {
        totalProjects: 10,
        activeProjects: 8,
        pendingAmount: '9999.00',
        pendingAcceptance: 2,
        pendingInvoice: 1,
        reminderCount: 5,
        reminderToday: 2,
        reminderOverdue: 1,
        openRepairProjects: 3,
      },
      stages: [],
    };
    const projectSummary: MobileReadonlyProjectSummary = {
      id: 'proj-01',
      tempNo: 'TP-EXP-01',
      ecc: 'ECC-EXP-01',
      customerName: '扩展客户甲<script>alert(1)</script>',
      status: 'executing',
      region: 'East',
      regionNeedsAdjustment: true,
      entryAt: '2026-08-01',
      planVisitAt: '2026-08-05',
      finalAmount: '1234567890123456789.99',
      invoicedAmount: '0.00',
      contractAmount: '2000000.00',
      formallyEntered: false,
      preEntryExecution: true,
      reminderAt: '2026-08-08',
      reminderDueClass: 'overdue',
      groupedTags: [
        { groupId: 'g1', groupName: '科室', tagIds: ['t1'], tagNames: ['重点科室'] },
        { groupId: 'g2', groupName: '难度', tagIds: ['t2'], tagNames: ['高难度搬迁'] },
      ],
    };
    const projectSummaryFuture: MobileReadonlyProjectSummary = {
      id: 'proj-02-future',
      tempNo: 'TP-EXP-02',
      ecc: null,
      customerName: '远期提醒客户',
      status: 'pending_execution',
      region: null,
      regionNeedsAdjustment: false,
      entryAt: null,
      planVisitAt: null,
      finalAmount: null,
      invoicedAmount: '0.00',
      contractAmount: null,
      formallyEntered: true,
      preEntryExecution: false,
      reminderAt: '2026-10-15',
      reminderDueClass: null,
    };

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview });
      if (url.pathname === '/api/projects') {
        return response({ total: 10, items: [projectSummary, projectSummaryFuture], nextCursor: null });
      }
      throw new Error(`Unexpected url: ${url.pathname}`);
    });

    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    await screen.findByText('扩展客户甲<script>alert(1)</script>');

    // 概览新增指标：准确口径
    const overviewSection = screen.getByLabelText('概览指标');
    const reminderCountDt = within(overviewSection).getByText('提醒项目', { selector: 'dt' });
    expect(reminderCountDt.nextElementSibling?.textContent).toBe('5');
    const reminderTodayDt = within(overviewSection).getByText('今日到期', { selector: 'dt' });
    expect(reminderTodayDt.nextElementSibling?.textContent).toBe('2');
    const reminderOverdueDt = within(overviewSection).getByText('逾期提醒', { selector: 'dt' });
    expect(reminderOverdueDt.nextElementSibling?.textContent).toBe('1');
    const openRepairDt = within(overviewSection).getByText('有未结维修', { selector: 'dt' });
    expect(openRepairDt.nextElementSibling?.textContent).toBe('3');

    // 卡片展示与远期提醒展示
    expect(screen.getByText('区域待调整')).toBeTruthy();
    expect(screen.getByText('未进单先执行')).toBeTruthy();
    expect(screen.getByText('提醒 2026-08-08 · 已逾期（快照时）')).toBeTruthy();
    expect(screen.getByText('提醒 2026-10-15 · 远期（快照时）')).toBeTruthy();
    expect(screen.getByText('重点科室')).toBeTruthy();
    expect(screen.getByText('高难度搬迁')).toBeTruthy();
    expect(screen.getByText(/合同 2000000.00/)).toBeTruthy();
    expect(screen.getByText(/可确认 1234567890123456789.99/)).toBeTruthy();
    expect(screen.getByText(/共 10 条/)).toBeTruthy();
  });

  it('详情页展示全部分组字段、正确术语文案、null/false/0与长多行文本，并支持分组导航跳转', async () => {
    const overview: MobileReadonlyOverview = {
      metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
      stages: [],
    };
    const detailFields: MobileReadonlyProjectDetailFields = {
      oldSiteContact: '张三 13900000000',
      newSiteContact: null,
      oldSiteAddress: '上海市浦东新区张江高科南路 100 号 3 幢 201 室',
      newSiteAddress: null,
      temporaryStorageAddress: '昆山市花桥经济开发区仓库 A 区 1 号库',
      isTemporaryStorage: true,
      contractStartDate: '2026-07-01',
      contractEndDate: '2026-12-31',
      planTransportAt: '2026-08-02',
      plannedInstallAt: '2026-08-03',
      actualInstallDoneAt: null,
      acceptanceReportDate: null,
      cancelledAt: null,
      siteConfirmed: false,
      acceptanceReport: false,
      temporaryInstrumentCount: 0,
      temporaryInstrumentName: '超低温离心机',
      temporaryInstrumentModel: 'CR22N',
      temporaryHasUps: false,
      reminderNote: '第一行备注内容\n第二行包含特殊字符 <>&"\'\n第三行持续跟进中',
    };
    const project = {
      id: 'proj-02',
      tempNo: 'TP-EXP-02',
      ecc: null,
      customerName: '苏州生物医药实验中心',
      status: 'pending_execution' as const,
      region: null,
      regionNeedsAdjustment: false,
      entryAt: '2026-07-28',
      planVisitAt: '2026-08-02',
      finalAmount: '0.00',
      invoicedAmount: '0.00',
      contractAmount: null,
      formallyEntered: true,
      preEntryExecution: false,
      reminderAt: '2026-08-02',
      reminderDueClass: 'upcoming' as const,
      groupedTags: [],
      detail: detailFields,
    };

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview });
      if (url.pathname === '/api/projects') return response({ total: 1, items: [project], nextCursor: null });
      if (url.pathname === '/api/project') {
        return response({
          project,
          recordCounts: { instruments: 1, orders: 1, invoices: 1, damage_items: 1, batches: 0, activities: 0 },
        });
      }
      if (url.pathname === '/api/records') {
        return response({
          kind: 'instruments',
          total: 1,
          items: [{
            id: 'inst-01',
            name: '高分辨质谱仪',
            model: 'Q-Exactive',
            serialNo: 'SN-0099',
            manufacturer: '赛默飞',
            serviceLevel: 'S-Level',
            qrRequested: true,
            ups: false,
          }],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected url: ${url.pathname}`);
    });

    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText('苏州生物医药实验中心'));
    await screen.findByRole('heading', { name: '项目详情' });

    // 分组导航锚点存在
    const nav = screen.getByLabelText('详情分组快速导航');
    expect(within(nav).getByRole('link', { name: '基本信息' })).toHaveAttribute('href', '#group-basic');
    expect(within(nav).getByRole('link', { name: '日程与合同' })).toHaveAttribute('href', '#group-dates');
    expect(within(nav).getByRole('link', { name: '搬迁与暂存' })).toHaveAttribute('href', '#group-relocation');
    expect(within(nav).getByRole('link', { name: '暂定仪器' })).toHaveAttribute('href', '#group-temp-instrument');
    expect(within(nav).getByRole('link', { name: '提醒与标签' })).toHaveAttribute('href', '#group-reminder');
    expect(within(nav).getByRole('link', { name: '金额与结算' })).toHaveAttribute('href', '#group-money');
    expect(within(nav).getByRole('link', { name: '关联记录' })).toHaveAttribute('href', '#group-records');

    // 基本信息与规范术语
    const basicSec = screen.getByLabelText('基本信息');
    const siteConfirmedDt = within(basicSec).getByText('场地已确认', { selector: 'dt' });
    expect(siteConfirmedDt.nextElementSibling?.textContent).toBe('否');
    const acceptanceReportDt = within(basicSec).getByText('已形成验收报告', { selector: 'dt' });
    expect(acceptanceReportDt.nextElementSibling?.textContent).toBe('否');

    // 日程与合同（术语：计划装机/实际装机完成）
    const datesSec = screen.getByLabelText('执行日程与合同日期');
    expect(within(datesSec).getByText('2026-07-01')).toBeTruthy();
    expect(within(datesSec).getByText('2026-12-31')).toBeTruthy();
    const planVisitDt = within(datesSec).getByText('计划上门日期', { selector: 'dt' });
    expect(planVisitDt.nextElementSibling?.textContent).toBe('2026-08-02');
    const planTransportDt = within(datesSec).getByText('计划运输日期', { selector: 'dt' });
    expect(planTransportDt.nextElementSibling?.textContent).toBe('2026-08-02');
    const planInstallDt = within(datesSec).getByText('计划装机日期', { selector: 'dt' });
    expect(planInstallDt.nextElementSibling?.textContent).toBe('2026-08-03');
    const actualInstallDt = within(datesSec).getByText('实际装机完成日期', { selector: 'dt' });
    expect(actualInstallDt.nextElementSibling?.textContent).toBe('未填写');

    // 搬迁与暂存
    const relocSec = screen.getByLabelText('搬出搬入联系与地址');
    expect(within(relocSec).getByText('张三 13900000000')).toBeTruthy();
    expect(within(relocSec).getByText('上海市浦东新区张江高科南路 100 号 3 幢 201 室')).toBeTruthy();
    const newSiteContactDt = within(relocSec).getByText('搬入联系人', { selector: 'dt' });
    expect(newSiteContactDt.nextElementSibling?.textContent).toBe('未填写');
    expect(within(relocSec).getByText('昆山市花桥经济开发区仓库 A 区 1 号库')).toBeTruthy();
    const isTempStorageDt = within(relocSec).getByText('是否暂存', { selector: 'dt' });
    expect(isTempStorageDt.nextElementSibling?.textContent).toBe('是');

    // 暂定仪器（术语：暂定配备 UPS）
    const tempInstSec = screen.getByLabelText('暂定仪器');
    const tempCountDt = within(tempInstSec).getByText('暂定仪器数量', { selector: 'dt' });
    expect(tempCountDt.nextElementSibling?.textContent).toBe('0');
    expect(within(tempInstSec).getByText('超低温离心机')).toBeTruthy();
    expect(within(tempInstSec).getByText('CR22N')).toBeTruthy();
    const tempUpsDt = within(tempInstSec).getByText('暂定配备 UPS', { selector: 'dt' });
    expect(tempUpsDt.nextElementSibling?.textContent).toBe('否');

    // 提醒与长文本安全展示
    const reminderSec = screen.getByLabelText('提醒与分类标签');
    expect(within(reminderSec).getByText('即将到期（快照时）')).toBeTruthy();
    expect(within(reminderSec).getByText(/第一行备注内容/)).toBeTruthy();
    expect(within(reminderSec).getByText(/特殊字符 <>&"' /)).toBeTruthy();

    // 仪器记录扩展字段（已申请二维码）
    const recordSec = screen.getByLabelText('关联记录');
    expect(within(recordSec).getByText('赛默飞')).toBeTruthy();
    expect(within(recordSec).getByText('S-Level')).toBeTruthy();
    const qrDt = within(recordSec).getByText('已申请二维码', { selector: 'dt' });
    expect(qrDt.nextElementSibling?.textContent).toBe('是');
  });

  it('旧 v1 快照缺少扩展字段时友好提示“当前快照未提供”，不冒充 null 或 0', async () => {
    const overview: MobileReadonlyOverview = {
      metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '100.00', pendingAcceptance: 0, pendingInvoice: 0 },
      stages: [],
    };
    const projectV1 = {
      id: 'proj-legacy',
      tempNo: 'TP-LEGACY',
      ecc: 'ECC-LEGACY',
      customerName: '历史快照客户',
      status: 'completed' as const,
      region: 'North',
      regionNeedsAdjustment: false,
      entryAt: '2026-05-01',
      planVisitAt: '2026-05-10',
      finalAmount: '5000.00',
      invoicedAmount: '5000.00',
      contractAmount: '5000.00',
      formallyEntered: true,
      preEntryExecution: false,
    };

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview }, metadataV1);
      if (url.pathname === '/api/projects') return response({ items: [projectV1], nextCursor: null }, metadataV1);
      if (url.pathname === '/api/project') return response({ project: projectV1 }, metadataV1);
      if (url.pathname === '/api/records') {
        return response({
          kind: 'instruments',
          items: [{
            id: 'legacy-inst-1',
            name: '老式烘箱',
            model: 'BOX-01',
            serialNo: 'SN-OLD',
            ups: true,
          }],
          nextCursor: null,
        }, metadataV1);
      }
      throw new Error(`Unexpected url: ${url.pathname}`);
    });

    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText('历史快照客户'));
    await screen.findByRole('heading', { name: '项目详情' });

    const basicSec = screen.getByLabelText('基本信息');
    const siteConfirmedDt = within(basicSec).getByText('场地已确认', { selector: 'dt' });
    expect(siteConfirmedDt.nextElementSibling?.textContent).toBe('当前快照未提供');

    const relocSec = screen.getByLabelText('搬出搬入联系与地址');
    const oldContactDt = within(relocSec).getByText('搬出联系人', { selector: 'dt' });
    expect(oldContactDt.nextElementSibling?.textContent).toBe('当前快照未提供');

    const tempInstSec = screen.getByLabelText('暂定仪器');
    const tempCountDt = within(tempInstSec).getByText('暂定仪器数量', { selector: 'dt' });
    expect(tempCountDt.nextElementSibling?.textContent).toBe('当前快照未提供');

    const reminderSec = screen.getByLabelText('提醒与分类标签');
    const reminderStatusDt = within(reminderSec).getByText('提醒到期状态', { selector: 'dt' });
    expect(reminderStatusDt.nextElementSibling?.textContent).toBe('当前快照未提供');

    const recordsSec = screen.getByLabelText('关联记录');
    const mfgDt = within(recordsSec).getByText('生产厂家', { selector: 'dt' });
    expect(mfgDt.nextElementSibling?.textContent).toBe('当前快照未提供');
    const qrDt = within(recordsSec).getByText('已申请二维码', { selector: 'dt' });
    expect(qrDt.nextElementSibling?.textContent).toBe('当前快照未提供');
  });

  it('开单记录展示 customerName；损坏维修备件状态 4 种合法枚举正确映射为中文', async () => {
    const partStatusCases: Array<[MobileReadonlyPartStatus, string]> = [
      ['pending_submit', '待提交'],
      ['processing', '处理中'],
      ['arrived', '已到件'],
      ['used', '已使用'],
    ];

    for (const [partStatus, expectedLabel] of partStatusCases) {
      cleanup();
      const overview: MobileReadonlyOverview = {
        metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
        stages: [],
      };
      const project = {
        id: `proj-part-${partStatus}`,
        tempNo: 'TP-REC',
        ecc: 'ECC-REC',
        customerName: `备件测试-${partStatus}`,
        status: 'executing' as const,
        region: 'Central',
        regionNeedsAdjustment: false,
        entryAt: '2026-08-01',
        planVisitAt: '2026-08-02',
        finalAmount: '1000.00',
        invoicedAmount: '0.00',
        contractAmount: '1000.00',
        formallyEntered: true,
        preEntryExecution: false,
      };

      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input), 'https://synthetic.invalid');
        if (url.pathname === '/api/overview') return response({ overview });
        if (url.pathname === '/api/projects') return response({ items: [project], nextCursor: null });
        if (url.pathname === '/api/project') {
          return response({
            project,
            recordCounts: { instruments: 0, orders: 1, invoices: 0, damage_items: 1, batches: 0, activities: 0 },
          });
        }
        if (url.pathname === '/api/records') {
          const kind = url.searchParams.get('kind');
          if (kind === 'orders') {
            return response({
              kind: 'orders',
              total: 1,
              items: [{
                id: 'ord-01',
                customerName: '独立客户名称ABC',
                orderType: 'relocation' as const,
                serviceOrderNo: 'SO-100',
                orderedAt: '2026-08-05',
                engineer: '李工',
              }],
              nextCursor: null,
            });
          }
          if (kind === 'damage_items') {
            return response({
              kind: 'damage_items',
              total: 1,
              items: [{
                id: `dmg-${partStatus}`,
                instrumentName: '核磁共振仪',
                serialNo: 'SN-NMR-01',
                issueStatus: 'processing',
                partStatus,
                partNumber: 'PN-PART-01',
                partQuantity: 1,
                partAmount: '8000.00',
                partCurrency: 'RMB' as const,
                registeredAt: '2026-08-06',
              }],
              nextCursor: null,
            });
          }
          return response({ kind: 'instruments', total: 0, items: [], nextCursor: null });
        }
        throw new Error(`Unexpected url: ${url.pathname}`);
      });

      render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
      fireEvent.click(await screen.findByText(`备件测试-${partStatus}`));
      await screen.findByRole('heading', { name: '项目详情' });

      const recordTypes = await screen.findByRole('group', { name: '记录类型' });

      // 开单客户名称验证
      fireEvent.click(within(recordTypes).getByRole('button', { name: /开单/ }));
      const recordSec = screen.getByLabelText('关联记录');
      expect(await within(recordSec).findByText('独立客户名称ABC')).toBeTruthy();

      // 损坏维修备件状态映射验证
      fireEvent.click(within(recordTypes).getByRole('button', { name: /损坏维修/ }));
      const partStatusDt = await within(recordSec).findByText('备件状态', { selector: 'dt' });
      expect(partStatusDt.nextElementSibling?.textContent).toBe(expectedLabel);
    }
  });
});
