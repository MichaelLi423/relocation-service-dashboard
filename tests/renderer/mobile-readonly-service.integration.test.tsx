// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wallTimeout, clearTimeout as clearWallTimeout } from 'node:timers';
import { transferableAbortController } from 'node:util';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MobileReadonlyApp } from '../../src/mobile/App';
import { CHECK_INTERVAL_MS, MobileReadonlyController } from '../../src/mobile/controller';
import type { MobileEnvironment, MobileState } from '../../src/mobile/controller';
import type { MobileReadonlyOverviewData, MobileReadonlyProjectListData, MobileReadonlyQueryResponse } from '../../src/shared/mobile-readonly';
import { startMobileReadonlyService, type RunningMobileReadonlyService } from '../../src/server/mobile-readonly/service';
import { MOBILE_READONLY_DEFAULT_CONFIG } from '../../src/server/mobile-readonly/config';
import { generateCredentialsFile } from '../../src/server/mobile-readonly/credentials';
import { makeBatchRecordFixture, makeProjectFixture, makeSampleProjectRecordsFixture, makeSnapshotFixture } from '../helpers/mobile-readonly-fixtures';

// jsdom and undici use different AbortSignal realms. Forward cancellation, not the foreign signal.
function bridgeAbortSignal(source?: AbortSignal | null) {
  const native = transferableAbortController();
  const forward = () => native.abort(source?.reason);
  if (source?.aborted) forward();
  else source?.addEventListener('abort', forward, { once: true });
  return { signal: native.signal, dispose: () => source?.removeEventListener('abort', forward) };
}

it('真实只读服务：概览包络、空查询参数、详情记录及自动定时发布更新可见', async () => {
  // Vitest's jsdom environment retains Node fetch; fail explicitly rather than skip or mock routes.
  const nodeFetch = globalThis.fetch;
  expect(typeof nodeFetch).toBe('function');
  const directory = await mkdtemp(join(tmpdir(), 'mobile-readonly-dom-'));
  let service: RunningMobileReadonlyService | undefined;
  let controller: MobileReadonlyController | undefined;
  let now = Date.parse('2026-08-10T00:00:00Z');
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const username = 'synthetic-viewer';
  const password = 'synthetic-viewer-password';
  const uploadToken = 'synthetic-upload-token';
  const requests: URL[] = [];
  const responses: { path: string; status: number; phase: string }[] = [];
  const abortBridges = new Set<() => void>();
  let adapterFailure: unknown;
  const triggers: { reason: string; at: number }[] = [];
  function waitForView(label: string, ready: (state: MobileState) => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const model = controller!;
      let unsubscribe = () => {};
      const diagnostic = () => JSON.stringify({ label, responses, requestedPaths: requests.map((url) => url.pathname),
        busy: model.getSnapshot().busy, error: model.getSnapshot().error,
        version: model.getSnapshot().view?.metadata.currentVersion,
        page: model.getSnapshot().view?.navigation.page });
      const timeout = wallTimeout(() => { unsubscribe(); reject(new Error(`真实服务视图等待超时：${diagnostic()}`)); }, 5_000);
      const inspect = () => {
        const state = model.getSnapshot();
        if (state.error || adapterFailure) {
          clearWallTimeout(timeout); unsubscribe();
          reject(adapterFailure ?? new Error(`控制器未完成加载：${diagnostic()}`));
        } else if (!state.busy && ready(state)) {
          clearWallTimeout(timeout); unsubscribe(); resolve();
        }
      };
      unsubscribe = model.subscribe(inspect);
      inspect();
    });
  }
  try {
    service = await startMobileReadonlyService({
      config: { ...MOBILE_READONLY_DEFAULT_CONFIG, host: '127.0.0.1', port: 0,
        dataDir: directory, credentialsFile: join(directory, 'unused-credentials.json'), tls: null },
      credentials: generateCredentialsFile(username, password, uploadToken),
      webRoot: null,
      clock: { nowIso: () => new Date(now).toISOString() },
    });
    const baseUrl = service.baseUrl;
    const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    async function publish(version: number) {
      const records = makeSampleProjectRecordsFixture();
      const snapshot = makeSnapshotFixture({ businessRevision: version,
        projects: [makeProjectFixture({ customerName: `真实服务合成客户V${version}`, records: {
          ...records, batches: [makeBatchRecordFixture(0, { transportCompany: `真实服务承运商V${version}` })],
        } })],
      });
      const response = await nodeFetch(`${baseUrl}/api/publish`, {
        method: 'PUT', headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: { publicationId: `synthetic-dom-${version}`, expectedCurrentVersion: version - 1 }, snapshot }),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.metadata.currentVersion).toBe(version);
      expect(result.metadata.published).toBe(true);
    }
    await publish(1);
    // Establish the real authenticated wire contract before React/controller can normalize failures.
    const overviewResponse = await nodeFetch(`${baseUrl}/api/overview`, { headers: { Authorization: basic } });
    expect(overviewResponse.status).toBe(200);
    const overviewBody = await overviewResponse.json() as MobileReadonlyQueryResponse<MobileReadonlyOverviewData>;
    expect(overviewBody.metadata).toMatchObject({ published: true, currentVersion: 1 });
    expect(overviewBody.data.overview?.metrics.pendingAmount).toBe('1234.57');
    const projectsResponse = await nodeFetch(`${baseUrl}/api/projects?query=&status=&region=&cursor=&limit=20`, { headers: { Authorization: basic } });
    expect(projectsResponse.status).toBe(200);
    const projectsBody = await projectsResponse.json() as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(projectsBody.metadata.currentVersion).toBe(1);
    expect(projectsBody.data.items.map((project) => project.customerName)).toEqual(['真实服务合成客户V1']);
    // Prove a jsdom abort reaches actual undici fetch, including after headers/before JSON reading.
    const abortSource = new window.AbortController();
    const abortBridge = bridgeAbortSignal(abortSource.signal);
    try {
      const cancellableResponse = await nodeFetch(`${baseUrl}/api/overview`, {
        headers: { Authorization: basic }, signal: abortBridge.signal,
      });
      expect(cancellableResponse.status).toBe(200);
      const reason = new Error('synthetic-body-cancel');
      abortSource.abort(reason);
      expect(abortBridge.signal.aborted).toBe(true);
      expect(abortBridge.signal.reason).toBe(reason);
      await expect(cancellableResponse.json()).rejects.toBe(reason);
    } finally { abortBridge.dispose(); }
    const alreadyAborted = bridgeAbortSignal(abortSource.signal);
    try {
      expect(alreadyAborted.signal.aborted).toBe(true);
      await expect(nodeFetch(`${baseUrl}/api/overview`, {
        headers: { Authorization: basic }, signal: alreadyAborted.signal,
      })).rejects.toMatchObject({ message: 'synthetic-body-cancel' });
    } finally { alreadyAborted.dispose(); }
    const environment: MobileEnvironment = {
      now: () => now,
      setTimeout: (callback, delay) => {
        const id = ++nextTimer; timers.set(id, { at: now + delay, callback });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id) => { timers.delete(id as unknown as number); },
      isOnline: () => true, isVisible: () => true, subscribe: () => () => {},
      onCheckTrigger: (reason, at) => triggers.push({ reason, at }),
      fetch: async (input, init) => {
        const bridge = bridgeAbortSignal(init?.signal);
        const dispose = () => { bridge.dispose(); abortBridges.delete(dispose); };
        abortBridges.add(dispose);
        try {
          const url = new URL(String(input), baseUrl);
          expect(url.origin).toBe(baseUrl);
          requests.push(url);
          expect(init?.method).toBe('GET');
          expect(init?.cache).toBe('no-store');
          expect(init?.credentials).toBe('same-origin');
          // Test-only Basic adapter; retain the actual network Response without cloning its stream.
          const response = await nodeFetch(url.href, { ...init, signal: bridge.signal, headers: { Authorization: basic } });
          const trace = { path: url.pathname, status: response.status, phase: 'headers' };
          responses.push(trace);
          expect(response.status).toBe(200);
          expect(response.headers.get('cache-control')).toContain('no-store');
          const readJson = response.json.bind(response);
          response.json = async () => {
            try {
              const body = await readJson();
              trace.phase = 'body';
              if (url.pathname === '/api/overview') {
                const overview = body as MobileReadonlyQueryResponse<MobileReadonlyOverviewData>;
                expect(overview.data.overview?.metrics.pendingAmount).toBe('1234.57');
              }
              return body;
            } catch (error) { adapterFailure = error; throw error; }
            finally { dispose(); }
          };
          return response;
        } catch (error) {
          dispose();
          adapterFailure = error;
          throw error;
        }
      },
    };
    controller = new MobileReadonlyController(environment);
    render(<MobileReadonlyApp controller={controller} />);
    await act(async () => { await waitForView('项目首屏 V1', (state) => state.view?.metadata.currentVersion === 1 && state.view.navigation.page === 'projects'); });
    expect(screen.getByText('真实服务合成客户V1')).toBeTruthy();
    expect(within(screen.getByLabelText('概览指标')).getByText('1234.57')).toBeTruthy();
    const projectQuery = requests.find((url) => url.pathname === '/api/projects')!;
    for (const key of ['query', 'status', 'region', 'cursor']) expect(projectQuery.searchParams.get(key)).toBe('');
    expect(projectQuery.searchParams.get('limit')).toBe('20');
    fireEvent.click(screen.getByText('真实服务合成客户V1'));
    await act(async () => { await waitForView('详情记录 V1', (state) => state.view?.metadata.currentVersion === 1 && state.view.navigation.page === 'detail' && Boolean(state.view.records)); });
    expect(screen.getByText('真实服务承运商V1')).toBeTruthy();
    expect(requests.some((url) => url.pathname === '/api/project' && url.searchParams.get('id') === 'fixture-project-1')).toBe(true);
    expect(requests.some((url) => url.pathname === '/api/records' && url.searchParams.get('kind') === 'batches' && url.searchParams.get('cursor') === '')).toBe(true);
    await publish(2);
    // Advance the injected timer queue, not check()/refresh or a lifecycle event.
    act(() => {
      now += CHECK_INTERVAL_MS;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    });
    await act(async () => { await waitForView('定时更新 V2', (state) => state.view?.metadata.currentVersion === 2 && state.view.navigation.page === 'detail' && Boolean(state.view.records)); });
    expect(screen.getByText('真实服务承运商V2')).toBeTruthy();
    expect(screen.getByText('真实服务合成客户V2')).toBeTruthy();
    expect(screen.queryByText('真实服务合成客户V1')).toBeNull();
    expect(screen.queryByText('真实服务承运商V1')).toBeNull();
    expect(controller.getSnapshot().view?.metadata.currentVersion).toBe(2);
    expect(triggers.map((entry) => entry.reason)).toEqual(['open', 'periodic']);
    expect(triggers[1].at - triggers[0].at).toBeLessThanOrEqual(60_000);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(abortBridges.size).toBe(0);
  } finally {
    cleanup(); controller?.stop();
    abortBridges.forEach((dispose) => dispose());
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
