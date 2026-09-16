// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MobileReadonlyApp } from '../../src/mobile/App';
import { browserEnvironment, MobileReadonlyController } from '../../src/mobile/controller';
import type { MobileReadonlyQueryResponse } from '../../src/shared/mobile-readonly';
import { makeOverviewFixture, makeProjectSummaryFixture } from '../helpers/mobile-readonly-fixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('断网读取仅限内存中的当前视图', () => {
  it('已加载页失败保留数据；全新断网挂载无法加载，不读写离线存储', async () => {
    let online = true;
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.cache).toBe('no-store');
      const body: MobileReadonlyQueryResponse<unknown> = { metadata: {
        published: true, currentVersion: 1, publicationId: 'synthetic-1', publishedAt: '2026-08-08T01:00:00Z',
        dataAsOf: '2026-08-08T00:00:00Z', fingerprint: { contentGenerationId: 'synthetic', businessRevision: 1 },
      }, data: String(input) === '/api/overview' ? { overview: makeOverviewFixture() } : { items: [makeProjectSummaryFixture()], nextCursor: null } };
      return new Response(JSON.stringify(body));
    });
    const environment = { ...browserEnvironment(), isOnline: () => online, fetch: fetcher };
    const controller = new MobileReadonlyController(environment);
    const mounted = render(<MobileReadonlyApp controller={controller} />);
    await screen.findByText('移动只读合成客户');
    const checked = controller.getSnapshot().lastCheckedAt;
    online = false;
    await act(async () => controller.check());
    await screen.findByRole('alert');
    expect(screen.getByText('移动只读合成客户')).toBeTruthy();
    expect(controller.getSnapshot().lastCheckedAt).toBe(checked);
    expect(screen.getByText(/电脑断网仅影响新发布/)).toBeTruthy();
    mounted.unmount();
    const requests = fetcher.mock.calls.length;
    render(<MobileReadonlyApp controller={new MobileReadonlyController(environment)} />);
    await screen.findByRole('alert');
    expect(screen.getByText('无法连接 / 无法加载')).toBeTruthy();
    expect(screen.queryByText('移动只读合成客户')).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    online = true;
    fireEvent.click(screen.getByText('重试加载'));
    await screen.findByText('移动只读合成客户');
  });
  it('暂时的详情请求失败不清除此前完整加载的列表', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith('/api/project?')) throw new Error('synthetic failure');
      const body: MobileReadonlyQueryResponse<unknown> = { metadata: {
        published: true, currentVersion: 1, publicationId: 'synthetic-1', publishedAt: '2026-08-08T01:00:00Z',
        dataAsOf: '2026-08-08T00:00:00Z', fingerprint: { contentGenerationId: 'synthetic', businessRevision: 1 },
      }, data: String(input) === '/api/overview' ? { overview: makeOverviewFixture() } : { items: [makeProjectSummaryFixture()], nextCursor: null } };
      return new Response(JSON.stringify(body));
    });
    render(<MobileReadonlyApp controller={new MobileReadonlyController({ ...browserEnvironment(), isOnline: () => true, fetch: fetcher })} />);
    fireEvent.click(await screen.findByText('移动只读合成客户'));
    await screen.findByRole('alert');
    expect(screen.getByText('移动只读合成客户')).toBeTruthy();
    expect(screen.getByLabelText('概览指标')).toBeTruthy();
  });
});
