// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MobileReadonlyApp } from '../../src/mobile/App';
import { browserEnvironment, MobileReadonlyController } from '../../src/mobile/controller';
import type { CheckReason, MobileEnvironment } from '../../src/mobile/controller';
import type { MobileReadonlyQueryResponse } from '../../src/shared/mobile-readonly';
import { makeBatchRecordFixture, makeOverviewFixture, makeProjectSummaryFixture } from '../helpers/mobile-readonly-fixtures';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-10T00:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function settle() { await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); }); }
function service() {
  let version = 1;
  let online = true;
  let visible = true;
  let notify: Parameters<MobileEnvironment['subscribe']>[0] = () => {};
  const triggers: { reason: CheckReason; at: number }[] = [];
  const overview = makeOverviewFixture();
  const wrap = <T,>(data: T, v = version): Response => {
    const body: MobileReadonlyQueryResponse<T> = { metadata: {
      published: true, currentVersion: v, publicationId: `synthetic-${v}`, dataAsOf: '2026-08-08T00:00:00Z',
      publishedAt: '2026-08-08T00:01:00Z', fingerprint: { contentGenerationId: 'synthetic', businessRevision: v },
    }, data };
    return new Response(JSON.stringify(body));
  };
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'https://synthetic.invalid');
    if (url.pathname === '/api/overview') return wrap({ overview });
    const project = makeProjectSummaryFixture({ customerName: `合成版本${version}` });
    if (url.pathname === '/api/projects') return wrap({ items: [project], nextCursor: null });
    if (url.pathname === '/api/project') return wrap({ project });
    return wrap({ kind: url.searchParams.get('kind'), items: [], nextCursor: null });
  });
  const env: MobileEnvironment = {
    ...browserEnvironment(), fetch: fetcher, isOnline: () => online, isVisible: () => visible,
    subscribe: (callback) => { notify = callback; return () => { notify = () => {}; }; },
    onCheckTrigger: (reason, at) => triggers.push({ reason, at }),
  };
  const controller = new MobileReadonlyController(env);
  return { controller, fetcher, triggers, wrap,
    setVersion: (v: number) => { version = v; },
    setOnline: (v: boolean) => { online = v; },
    setVisible: (v: boolean) => { visible = v; },
    event: (event: 'online' | 'visible' | 'offline') => notify(event),
  };
}

describe('版本新鲜度与一致重载', () => {
  it.each(['projects', 'records'] as const)('真实 409 STALE_CURSOR：%s 自动重置首屏并显示新版本，失败请求不推进检查时间', async (page) => {
    const s = service();
    const original = s.fetcher.getMockImplementation()!;
    let changed = false;
    let staleResponses = 0;
    let releaseOverview!: () => void;
    const paths: URL[] = [];
    s.fetcher.mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'https://synthetic.invalid'); paths.push(url);
      if (url.pathname === '/api/overview' && changed) {
        await new Promise<void>((resolve) => { releaseOverview = resolve; });
        return original(input, init);
      }
      if (url.pathname === `/api/${page}` && url.searchParams.get('cursor')) {
        staleResponses++; changed = true; s.setVersion(2);
        const { metadata } = await s.wrap(null, 2).json();
        return new Response(JSON.stringify({ error: { code: 'STALE_CURSOR' }, metadata }), { status: 409 });
      }
      if (url.pathname === '/api/projects') return s.wrap({ items: [makeProjectSummaryFixture({ customerName: changed ? '新版本项目' : '旧版本项目' })], nextCursor: changed ? null : 'v1-cursor' });
      if (url.pathname === '/api/records') return s.wrap({ kind: 'batches', items: [makeBatchRecordFixture(0, { transportCompany: changed ? '新版本承运商' : '旧版本承运商' })], nextCursor: changed ? null : 'v1-cursor' });
      return original(input, init);
    });
    render(<MobileReadonlyApp controller={s.controller} />); await settle();
    if (page === 'records') { fireEvent.click(screen.getByText('旧版本项目')); await settle(); }
    const lastChecked = s.controller.getSnapshot().lastCheckedAt;
    vi.setSystemTime(Date.now() + 5_000);
    fireEvent.click(screen.getByRole('button', { name: '下一页 →' })); await settle();
    expect(staleResponses).toBe(1);
    expect(s.controller.getSnapshot().lastCheckedAt).toBe(lastChecked);
    expect(screen.queryByText(page === 'projects' ? '旧版本项目' : '旧版本承运商')).toBeNull();
    expect(screen.getByText(/已丢弃旧结果/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => releaseOverview()); await settle();
    expect(screen.getByText(page === 'projects' ? '新版本项目' : '新版本承运商')).toBeTruthy();
    expect(screen.getByText('第 1 页')).toBeTruthy();
    expect(s.controller.getSnapshot().view?.metadata.currentVersion).toBe(2);
    expect(s.controller.getSnapshot().lastCheckedAt).not.toBe(lastChecked);
    const reloaded = paths.filter((url) => url.pathname === `/api/${page}`).at(-1)!;
    expect(reloaded.searchParams.get('cursor')).toBe('');
    if (page === 'records') {
      expect(reloaded.searchParams.get('projectId')).toBe('fixture-project-1');
      expect(reloaded.searchParams.get('kind')).toBe('batches');
      expect(screen.getByText('合成版本2')).toBeTruthy();
    }
  });
  it.each([
    { error: { code: 'STALE_CURSOR' }, metadata: { currentVersion: 2 } },
    { error: { code: 'OTHER_CONFLICT' }, metadata: null },
  ])('不可信 409 不触发版本重载，保留完整旧视图', async (body) => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    const checked = s.controller.getSnapshot().lastCheckedAt;
    s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 409 }));
    fireEvent.click(screen.getByText('合成版本1')); await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('合成版本1')).toBeTruthy();
    expect(s.controller.getSnapshot().lastCheckedAt).toBe(checked);
    expect(screen.queryByText(/已丢弃旧结果/)).toBeNull();
  });
  it('打开立即检查；未等待定时器即可显示数据', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    expect(s.triggers).toEqual([{ reason: 'open', at: Date.now() }]);
    expect(screen.getByText('合成版本1')).toBeTruthy();
  });
  it.each(['visible', 'online'] as const)('%s 恢复独立立即检查，不受刚完成检查的频率限制', async (event) => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    if (event === 'visible') { s.setVisible(false); s.setVisible(true); }
    else { s.setOnline(false); act(() => s.event('offline')); s.setOnline(true); }
    s.setVersion(2);
    act(() => s.event(event)); await settle();
    expect(s.triggers.at(-1)).toEqual({ reason: event, at: Date.now() });
    expect(screen.getByText('合成版本2')).toBeTruthy();
  });
  it('实际记录相邻定时触发时间差上界 <=60000，并自动出现新值', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    s.setVersion(2);
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const times = s.triggers.filter((trigger) => trigger.reason === 'periodic').map((trigger) => trigger.at);
    expect(times).toHaveLength(4);
    for (let i = 1; i < times.length; i++) { expect(times[i] - times[i - 1]).toBeGreaterThan(0); expect(times[i] - times[i - 1]).toBeLessThanOrEqual(60_000); }
    expect(screen.getByText('合成版本2')).toBeTruthy();
    expect(screen.queryByText('合成版本1')).toBeNull();
    expect(screen.getByText(/旧结果已丢弃/)).toBeTruthy();
  });
  it('慢请求合并网络但不吞掉生命周期或定时触发，超时后继续调度', async () => {
    const s = service();
    s.fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    render(<MobileReadonlyApp controller={s.controller} />);
    act(() => { s.event('visible'); s.event('online'); });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.triggers.map((x) => x.reason)).toEqual(['open', 'visible', 'online']);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
    const times = s.triggers.filter((x) => x.reason === 'periodic').map((x) => x.at);
    expect(times).toHaveLength(4);
    times.slice(1).forEach((at, i) => expect(at - times[i]).toBeLessThanOrEqual(60_000));
    expect(screen.getByRole('alert').textContent).toContain('无法连接');
  });
  it('后台或断网不发起定时检查', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    s.setVisible(false); await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    s.setVisible(true); s.setOnline(false); await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(s.triggers.filter((x) => x.reason === 'periodic')).toHaveLength(0);
  });
  it('迟到旧详情响应被拒绝，不覆盖自动加载的新版本', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    let resolveOld!: (response: Response) => void;
    s.fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }));
    fireEvent.click(screen.getByText('合成版本1')); await settle();
    s.setVersion(2);
    act(() => s.event('online')); await settle();
    expect(screen.getByText('合成版本2')).toBeTruthy();
    await act(async () => { resolveOld(s.wrap({ project: makeProjectSummaryFixture({ customerName: '迟到的旧详情' }) }, 1)); });
    await settle();
    expect(screen.queryByText('迟到的旧详情')).toBeNull();
    expect(screen.getByText('合成版本2')).toBeTruthy();
  });
  it('关联记录发现新版本时丢弃旧详情，自动重载当前导航', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    fireEvent.click(screen.getByText('合成版本1')); await settle();
    const original = s.fetcher.getMockImplementation()!;
    s.fetcher.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/records?')) s.setVersion(2);
      return original(input, init);
    });
    fireEvent.click(screen.getByRole('button', { name: '仪器' })); await settle();
    expect(screen.getByText('合成版本2')).toBeTruthy();
    expect(screen.queryByText('合成版本1')).toBeNull();
    expect(screen.getByRole('button', { name: '仪器' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/旧结果已丢弃/)).toBeTruthy();
  });
  it('版本持续竞争仅有界重试，不形成请求风暴', async () => {
    const s = service(); render(<MobileReadonlyApp controller={s.controller} />); await settle();
    const original = s.fetcher.getMockImplementation()!;
    let version = 1;
    s.fetcher.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/project?')) s.setVersion(++version);
      return original(input, init);
    });
    const before = s.fetcher.mock.calls.length;
    fireEvent.click(screen.getByText('合成版本1')); await settle();
    expect(s.fetcher.mock.calls.length - before).toBe(5);
    expect(screen.getByRole('alert').textContent).toContain('发布版本持续变化');
    expect(screen.queryByText('合成版本1')).toBeNull();
  });
});
