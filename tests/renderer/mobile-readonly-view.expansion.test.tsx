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
      projectNote: '重点项目执行备注：\n第一行现场勘验完毕\n第二行包含特殊字符 <script>console.log("xss")</script> & <b>粗体标签</b>\n第三行持续跟进中',
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
    const projectNoteLabel = within(basicSec).getByText('项目备注');
    expect(projectNoteLabel).toBeTruthy();
    expect(within(basicSec).getByText(/重点项目执行备注：/)).toBeTruthy();
    expect(within(basicSec).getByText(/第一行现场勘验完毕/)).toBeTruthy();
    expect(within(basicSec).getByText(/<script>console.log\("xss"\)<\/script> & <b>粗体标签<\/b>/)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();

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
    const projectNoteLabel = within(basicSec).getByText('项目备注');
    expect(projectNoteLabel.nextElementSibling?.textContent).toBe('当前快照未提供');

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

  it('项目备注 + 提醒（日期与备注） + 双联系人双地址同时可见，且长多行安全转义保留换行不注入 HTML', async () => {
    const overview: MobileReadonlyOverview = {
      metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
      stages: [],
    };
    const detailFields: MobileReadonlyProjectDetailFields = {
      projectNote: '重点项目备注：\n第一行搬迁前置条件\n第二行安全警示 <img src=x onerror=alert("hacked") />\n第三行结束',
      oldSiteContact: '搬出方-张主管 13900001111',
      newSiteContact: '搬入方-李经理 13800002222',
      oldSiteAddress: '北京市海淀区中关村南大街 1 号科研楼 A 座 101',
      newSiteAddress: '北京市昌平区生命科学园生命路 2 号 B 栋 202',
      temporaryStorageAddress: null,
      isTemporaryStorage: false,
      contractStartDate: '2026-08-01',
      contractEndDate: '2026-10-01',
      planTransportAt: '2026-08-10',
      plannedInstallAt: '2026-08-12',
      actualInstallDoneAt: null,
      acceptanceReportDate: null,
      cancelledAt: null,
      siteConfirmed: true,
      acceptanceReport: false,
      temporaryInstrumentCount: null,
      temporaryInstrumentName: null,
      temporaryInstrumentModel: null,
      temporaryHasUps: null,
      reminderNote: '提醒备注：\n提前申请出入证并报备车牌号',
    };
    const project: MobileReadonlyProjectSummary & { detail: MobileReadonlyProjectDetailFields } = {
      id: 'proj-simultaneous-01',
      tempNo: 'TP-SIM-01',
      ecc: 'ECC-SIM-01',
      customerName: '北京前沿生命科学研究所',
      status: 'executing',
      region: 'North',
      regionNeedsAdjustment: false,
      entryAt: '2026-08-01',
      planVisitAt: '2026-08-10',
      finalAmount: '8888.00',
      invoicedAmount: '0.00',
      contractAmount: '10000.00',
      formallyEntered: true,
      preEntryExecution: false,
      reminderAt: '2026-08-15',
      reminderDueClass: 'upcoming',
      groupedTags: [],
      detail: detailFields,
    };

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview });
      if (url.pathname === '/api/projects') return response({ total: 1, items: [project], nextCursor: null });
      if (url.pathname === '/api/project') return response({ project });
      if (url.pathname === '/api/records') return response({ kind: 'instruments', total: 0, items: [], nextCursor: null });
      throw new Error(`Unexpected url: ${url.pathname}`);
    });

    const { container } = render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText('北京前沿生命科学研究所'));
    await screen.findByRole('heading', { name: '项目详情' });

    // 1. 项目备注可见
    const basicSec = screen.getByLabelText('基本信息');
    expect(within(basicSec).getByText('项目备注')).toBeTruthy();
    expect(within(basicSec).getByText(/重点项目备注：/)).toBeTruthy();
    expect(within(basicSec).getByText(/第一行搬迁前置条件/)).toBeTruthy();
    expect(within(basicSec).getByText(/第二行安全警示 <img src=x onerror=alert\("hacked"\) \/>/)).toBeTruthy();
    expect(within(basicSec).getByText(/第三行结束/)).toBeTruthy();

    // 安全性验证：HTML 标签未被注入为 DOM 节点
    expect(container.querySelector('img')).toBeNull();

    // 2. 双联系人、双地址同时可见
    const relocSec = screen.getByLabelText('搬出搬入联系与地址');
    expect(within(relocSec).getByText('搬出方-张主管 13900001111')).toBeTruthy();
    expect(within(relocSec).getByText('搬入方-李经理 13800002222')).toBeTruthy();
    expect(within(relocSec).getByText('北京市海淀区中关村南大街 1 号科研楼 A 座 101')).toBeTruthy();
    expect(within(relocSec).getByText('北京市昌平区生命科学园生命路 2 号 B 栋 202')).toBeTruthy();

    // 3. 提醒日期与提醒备注同时可见
    const reminderSec = screen.getByLabelText('提醒与分类标签');
    expect(within(reminderSec).getByText('2026-08-15')).toBeTruthy();
    expect(within(reminderSec).getByText('即将到期（快照时）')).toBeTruthy();
    expect(within(reminderSec).getByText(/提醒备注：/)).toBeTruthy();
    expect(within(reminderSec).getByText(/提前申请出入证并报备车牌号/)).toBeTruthy();
  });

  it('项目备注为 null 或空串时明确展示“未填写”', async () => {
    for (const noteValue of [null, '']) {
      cleanup();
      const overview: MobileReadonlyOverview = {
        metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
        stages: [],
      };
      const detailFields: MobileReadonlyProjectDetailFields = {
        projectNote: noteValue,
        oldSiteContact: '联系人A',
        newSiteContact: '联系人B',
        oldSiteAddress: '地址A',
        newSiteAddress: '地址B',
        temporaryStorageAddress: null,
        isTemporaryStorage: false,
        contractStartDate: null,
        contractEndDate: null,
        planTransportAt: null,
        plannedInstallAt: null,
        actualInstallDoneAt: null,
        acceptanceReportDate: null,
        cancelledAt: null,
        siteConfirmed: false,
        acceptanceReport: false,
        temporaryInstrumentCount: null,
        temporaryInstrumentName: null,
        temporaryInstrumentModel: null,
        temporaryHasUps: null,
        reminderNote: null,
      };
      const project: MobileReadonlyProjectSummary & { detail: MobileReadonlyProjectDetailFields } = {
        id: `proj-note-${noteValue === null ? 'null' : 'empty'}`,
        tempNo: 'TP-NOTE-01',
        ecc: null,
        customerName: '空备注测试客户',
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
        detail: detailFields,
      };

      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input), 'https://synthetic.invalid');
        if (url.pathname === '/api/overview') return response({ overview });
        if (url.pathname === '/api/projects') return response({ total: 1, items: [project], nextCursor: null });
        if (url.pathname === '/api/project') return response({ project });
        if (url.pathname === '/api/records') return response({ kind: 'instruments', total: 0, items: [], nextCursor: null });
        throw new Error(`Unexpected url: ${url.pathname}`);
      });

      render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
      fireEvent.click(await screen.findByText('空备注测试客户'));
      await screen.findByRole('heading', { name: '项目详情' });

      const basicSec = screen.getByLabelText('基本信息');
      const noteLabel = within(basicSec).getByText('项目备注');
      expect(noteLabel.nextElementSibling?.textContent).toBe('未填写');
    }
  });

  it('兼容 legacy v2 快照（缺失 projectNote 即 undefined），友好提示“当前快照未提供”，不影响地址、联系人与提醒正常展示', async () => {
    const overview: MobileReadonlyOverview = {
      metrics: { totalProjects: 1, activeProjects: 1, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
      stages: [],
    };
    // 模拟旧 v2 detail：无 projectNote 属性
    const legacyV2Detail: MobileReadonlyProjectDetailFields = {
      oldSiteContact: '旧v2搬出联系人 021-12345678',
      newSiteContact: '旧v2搬入联系人 010-87654321',
      oldSiteAddress: '上海市徐汇区宜山路 100 号',
      newSiteAddress: '北京市朝阳区酒仙桥路 200 号',
      temporaryStorageAddress: null,
      isTemporaryStorage: false,
      contractStartDate: '2026-06-01',
      contractEndDate: '2026-12-31',
      planTransportAt: null,
      plannedInstallAt: null,
      actualInstallDoneAt: null,
      acceptanceReportDate: null,
      cancelledAt: null,
      siteConfirmed: true,
      acceptanceReport: true,
      temporaryInstrumentCount: null,
      temporaryInstrumentName: null,
      temporaryInstrumentModel: null,
      temporaryHasUps: null,
      reminderNote: '旧v2提醒备注依然完好',
    };
    const project: MobileReadonlyProjectSummary & { detail: MobileReadonlyProjectDetailFields } = {
      id: 'proj-legacy-v2',
      tempNo: 'TP-V2-01',
      ecc: 'ECC-V2-01',
      customerName: '历史v2客户',
      status: 'executing',
      region: 'East',
      regionNeedsAdjustment: false,
      entryAt: '2026-06-01',
      planVisitAt: '2026-06-10',
      finalAmount: '6666.00',
      invoicedAmount: '0.00',
      contractAmount: '8888.00',
      formallyEntered: true,
      preEntryExecution: false,
      reminderAt: '2026-06-15',
      reminderDueClass: 'overdue',
      detail: legacyV2Detail,
    };

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview }, metadataV2);
      if (url.pathname === '/api/projects') return response({ total: 1, items: [project], nextCursor: null }, metadataV2);
      if (url.pathname === '/api/project') return response({ project }, metadataV2);
      if (url.pathname === '/api/records') return response({ kind: 'instruments', total: 0, items: [], nextCursor: null }, metadataV2);
      throw new Error(`Unexpected url: ${url.pathname}`);
    });

    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText('历史v2客户'));
    await screen.findByRole('heading', { name: '项目详情' });

    // 项目备注缺失 -> 友好展示“当前快照未提供”
    const basicSec = screen.getByLabelText('基本信息');
    const noteLabel = within(basicSec).getByText('项目备注');
    expect(noteLabel.nextElementSibling?.textContent).toBe('当前快照未提供');

    // 搬出搬入联系人与地址不受任何影响
    const relocSec = screen.getByLabelText('搬出搬入联系与地址');
    expect(within(relocSec).getByText('旧v2搬出联系人 021-12345678')).toBeTruthy();
    expect(within(relocSec).getByText('旧v2搬入联系人 010-87654321')).toBeTruthy();
    expect(within(relocSec).getByText('上海市徐汇区宜山路 100 号')).toBeTruthy();
    expect(within(relocSec).getByText('北京市朝阳区酒仙桥路 200 号')).toBeTruthy();

    // 提醒日期与提醒备注不受任何影响
    const reminderSec = screen.getByLabelText('提醒与分类标签');
    expect(within(reminderSec).getByText('2026-06-15')).toBeTruthy();
    expect(within(reminderSec).getByText('已逾期（快照时）')).toBeTruthy();
    expect(within(reminderSec).getByText('旧v2提醒备注依然完好')).toBeTruthy();
  });
});
