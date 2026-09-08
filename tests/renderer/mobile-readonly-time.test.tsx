// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MobileReadonlyApp, displayTime } from '../../src/mobile/App';
import { browserEnvironment, MobileReadonlyController } from '../../src/mobile/controller';
import type { MobileReadonlyPublishMetadata, MobileReadonlyQueryResponse } from '../../src/shared/mobile-readonly';
import { makeOverviewFixture, makeProjectSummaryFixture } from '../helpers/mobile-readonly-fixtures';

afterEach(cleanup);
describe('三时间语义与快照时状态', () => {
  it('分别显示数据截至、发布完成、最近成功检查，失败不推进检查时间', async () => {
    let now = Date.parse('2026-08-11T00:00:00Z');
    let failure = false;
    const metadata: MobileReadonlyPublishMetadata = {
      published: true, currentVersion: 8, publicationId: 'synthetic-8', dataAsOf: '2026-08-08T01:00:00Z',
      publishedAt: '2026-08-08T01:02:00Z', fingerprint: { contentGenerationId: 'synthetic', businessRevision: 8 },
    };
    const overview = makeOverviewFixture({ stages: [{ status: 'executing', count: 1, averageDays: 2.75 }] });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (failure) throw new Error('synthetic offline');
      const body: MobileReadonlyQueryResponse<unknown> = { metadata, data: String(input) === '/api/overview' ? { overview } : { items: [makeProjectSummaryFixture()], nextCursor: null } };
      return new Response(JSON.stringify(body));
    });
    const controller = new MobileReadonlyController({ ...browserEnvironment(), now: () => now, isOnline: () => true, fetch: fetcher });
    render(<MobileReadonlyApp controller={controller} />);
    await screen.findByText('移动只读合成客户');
    const times = within(screen.getByLabelText('数据时间'));
    expect(times.getByText('数据截至时间').nextElementSibling?.querySelector('time')?.dateTime).toBe(metadata.dataAsOf);
    expect(times.getByText('发布完成时间').nextElementSibling?.querySelector('time')?.dateTime).toBe(metadata.publishedAt);
    const checked = times.getByText('最近成功检查').nextElementSibling?.querySelector('time');
    expect(checked?.dateTime).toBe('2026-08-11T00:00:00.000Z');
    expect(screen.getByText('平均 2.75 天')).toBeTruthy();
    expect(screen.getByText(/平均天数直接来自本次快照/)).toBeTruthy();
    now += 30_000; failure = true;
    await act(async () => controller.check());
    await screen.findByRole('alert');
    expect(checked?.dateTime).toBe('2026-08-11T00:00:00.000Z');
    expect(controller.getSnapshot().lastCheckedAt).toBe('2026-08-11T00:00:00.000Z');
    expect(controller.getSnapshot().failedAt).toBe('2026-08-11T00:00:30.000Z');
    expect(screen.getByText('移动只读合成客户')).toBeTruthy();
    failure = false; now += 30_000;
    await act(async () => controller.check());
    expect(controller.getSnapshot().lastCheckedAt).toBe('2026-08-11T00:01:00.000Z');
    expect(controller.getSnapshot().view?.metadata.dataAsOf).toBe(metadata.dataAsOf);
    expect(controller.getSnapshot().view?.metadata.publishedAt).toBe(metadata.publishedAt);
    expect(screen.queryByText(/发布版本已改变/)).toBeNull();
  });
  it('固定北京时间展示审计时间，空时间不是当前时间', () => {
    expect(displayTime(null)).toBe('尚无');
    expect(displayTime('2026-08-08T01:02:03Z')).toContain('09:02:03');
  });
});
