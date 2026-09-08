// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MobileReadonlyApp, RECORD_LABELS } from '../../src/mobile/App';
import { browserEnvironment, MobileReadonlyController } from '../../src/mobile/controller';
import { MOBILE_READONLY_RECORD_KINDS, UNPUBLISHED_MOBILE_READONLY_METADATA } from '../../src/shared/mobile-readonly';
import type { MobileReadonlyPublishMetadata, MobileReadonlyQueryResponse } from '../../src/shared/mobile-readonly';
import { makeEmptySnapshotFixture, makeProjectSummaryFixture, makeSnapshotFixture } from '../helpers/mobile-readonly-fixtures';

afterEach(cleanup);
const metadata: MobileReadonlyPublishMetadata = {
  published: true, currentVersion: 1, publicationId: 'synthetic-1', publishedAt: '2026-08-08T03:00:00Z',
  dataAsOf: '2026-08-08T02:30:00Z', fingerprint: { contentGenerationId: 'synthetic', businessRevision: 1 },
};
function response<T>(data: T, meta = metadata) {
  const body: MobileReadonlyQueryResponse<T> = { metadata: meta, data };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('独立手机只读视图', () => {
  it('概览、服务端搜索筛选与项目分页，仅有界 GET，不加载整份快照', async () => {
    const snapshot = makeSnapshotFixture();
    const project = makeProjectSummaryFixture({ customerName: '合成客户甲' });
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://synthetic.invalid'); calls.push(url);
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      if (url.pathname === '/api/overview') return response({ overview: snapshot.overview });
      expect(url.pathname).toBe('/api/projects');
      expect(url.searchParams.get('limit')).toBe('20');
      const second = url.searchParams.get('cursor') === 'page-two';
      const filtered = url.searchParams.get('query') === 'ECC-末页';
      return response({ items: [{ ...project, customerName: filtered ? '筛选后客户' : second ? '第二页客户' : '合成客户甲' }], nextCursor: second || filtered ? null : 'page-two' });
    });
    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    await screen.findByText('合成客户甲');
    expect(screen.getByLabelText('概览指标').textContent).toContain('1234.57');
    expect(screen.getByText('快照时状态')).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText('项目翻页')).getByText('下一页 →'));
    await screen.findByText('第二页客户');
    fireEvent.click(within(screen.getByLabelText('项目翻页')).getByText('← 上一页'));
    await screen.findByText('合成客户甲');
    fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: 'ECC-末页' } });
    fireEvent.change(screen.getByLabelText('项目状态'), { target: { value: 'executing' } });
    fireEvent.change(screen.getByLabelText('区域'), { target: { value: 'East' } });
    fireEvent.click(screen.getByText('查询项目'));
    await screen.findByText('筛选后客户');
    expect(calls.at(-1)?.searchParams.get('query')).toBe('ECC-末页');
    expect(calls.at(-1)?.searchParams.get('status')).toBe('executing');
    expect(calls.at(-1)?.searchParams.get('region')).toBe('East');
    expect(calls.at(-1)?.searchParams.get('cursor')).toBe('');
    expect(screen.queryByText(/新建|删除|导出|备份|上传|登录/)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('详情展示精确金额、业务日期以及六类独立分页记录', async () => {
    const snapshot = makeSnapshotFixture();
    const project = makeProjectSummaryFixture({ finalAmount: '900719925474099312345678901.23', contractAmount: null, invoicedAmount: '-12.34' });
    const recordCalls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview: snapshot.overview });
      if (url.pathname === '/api/projects') return response({ items: [project], nextCursor: null });
      if (url.pathname === '/api/project') { expect(url.searchParams.get('id')).toBe(project.id); return response({ project }); }
      expect(url.pathname).toBe('/api/records'); recordCalls.push(url);
      const kind = MOBILE_READONLY_RECORD_KINDS.find((value) => value === url.searchParams.get('kind'))!;
      const second = url.searchParams.get('cursor') === 'record-two';
      return response({ kind, items: [{ ...snapshot.projects[0].records[kind][0], id: `${kind}-${second ? 2 : 1}` }], nextCursor: second ? null : 'record-two' });
    });
    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText(project.customerName));
    await screen.findByText(project.finalAmount!);
    expect(screen.getByText('-12.34')).toBeTruthy();
    const entryDateLabel = within(screen.getByLabelText('项目基础信息')).getByText('进单日期', { selector: 'dt' });
    expect(entryDateLabel.nextElementSibling?.tagName).toBe('DD');
    expect(entryDateLabel.nextElementSibling?.textContent).toBe('2026-08-01');
    for (const kind of MOBILE_READONLY_RECORD_KINDS) {
      fireEvent.click(within(screen.getByRole('group', { name: '记录类型' })).getByText(RECORD_LABELS[kind]));
      await screen.findByText(`${kind}-1`);
      fireEvent.click(within(screen.getByLabelText('记录翻页')).getByText('下一页 →'));
      await screen.findByText(`${kind}-2`);
      expect(screen.queryByText(`${kind}-1`)).toBeNull();
      fireEvent.click(within(screen.getByLabelText('记录翻页')).getByText('← 上一页'));
      await screen.findByText(`${kind}-1`);
    }
    for (const url of recordCalls) {
      expect(url.searchParams.get('projectId')).toBe(project.id);
      expect(url.searchParams.get('limit')).toBe('20');
    }
    expect(new Set(recordCalls.map((url) => url.searchParams.get('kind'))).size).toBe(6);
  });

  it.each([
    ['untreated', '未处理'],
    ['processing', '处理中'],
    ['repaired', '已修复'],
    ['closed_unrepaired', '已关闭未修复'],
  ])('损坏维修事项状态 %s 显示为中文 %s', async (issueStatus, label) => {
    const snapshot = makeSnapshotFixture();
    const project = makeProjectSummaryFixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://synthetic.invalid');
      if (url.pathname === '/api/overview') return response({ overview: snapshot.overview });
      if (url.pathname === '/api/projects') return response({ items: [project], nextCursor: null });
      if (url.pathname === '/api/project') return response({ project });
      expect(url.pathname).toBe('/api/records');
      const kind = url.searchParams.get('kind');
      return response({
        kind,
        items: kind === 'damage_items' ? [{ ...snapshot.projects[0].records.damage_items[0], issueStatus }] : [],
        nextCursor: null,
      });
    });
    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText(project.customerName));
    const recordTypes = await screen.findByRole('group', { name: '记录类型' });
    fireEvent.click(within(recordTypes).getByRole('button', { name: '损坏维修' }));
    const records = within(screen.getByLabelText('关联记录'));
    const statusLabel = await records.findByText('事项状态', { selector: 'dt' });
    expect(statusLabel.nextElementSibling?.tagName).toBe('DD');
    expect(statusLabel.nextElementSibling?.textContent).toBe(label);
    expect(records.queryByText(issueStatus, { exact: true })).toBeNull();
  });

  it.each([false, true])('尚未发布与已发布空快照明确区分：published=%s', async (published) => {
    const snapshot = makeEmptySnapshotFixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === '/api/overview'
      ? response({ overview: published ? snapshot.overview : null }, published ? metadata : UNPUBLISHED_MOBILE_READONLY_METADATA)
      : response({ items: [], nextCursor: null }));
    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    await screen.findByText(published ? '已发布，暂无项目' : '尚未发布数据');
    expect(screen.queryByText(published ? '尚未发布数据' : '已发布，暂无项目')).toBeNull();
    if (!published) expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
