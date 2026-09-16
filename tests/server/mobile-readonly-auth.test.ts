import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCredentialsFileSync, parseCredentialsJson, generateCredentialsFile, uploadTokenMatches, viewerMatches } from '../../src/server/mobile-readonly/credentials';
import { startMobileReadonlyService } from '../../src/server/mobile-readonly/service';
import { createNodeEnvelopeIo, EnvelopeStore } from '../../src/server/mobile-readonly/store';
import { createRequestHandler, type MobileReadonlyAuthVerifier } from '../../src/server/mobile-readonly/http';
import type { Server } from 'node:http';
import * as http from 'node:http';
import { makeSnapshotFixture } from '../helpers/mobile-readonly-fixtures';
import {
  TEST_UPLOAD_TOKEN,
  TEST_VIEWER_PASSWORD,
  TEST_VIEWER_USERNAME,
  basicAuthHeader,
  bearerHeader,
  doFetch,
  makeTestCredentials,
  makeTestServiceConfig,
  startTestService,
  stopTestService,
  uploadInit,
  type StartedTestService,
} from './mobile-readonly-test-helpers';

/**
 * 双凭证隔离与摘要持久化（tasks 7.2 / 7.3）：
 * - 页面/资产与业务端点要求查看 Basic；上传端点与 /api/meta 只接受独立 Bearer token；
 * - 上传凭证不可读业务，可读非业务版本元数据；查看凭证不可上传/meta；
 * - 401/403 语义明确；全部响应 no-store；凭证只存摘要、响应与错误不回显明文。
 */

const services: StartedTestService[] = [];
const dirs: string[] = [];
const httpServers: Server[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await stopTestService(service);
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function startFresh(): Promise<StartedTestService> {
  const service = await startTestService();
  services.push(service);
  return service;
}

function publishPayload(publicationId: string, expectedCurrentVersion: number): unknown {
  return {
    protocol: { publicationId, expectedCurrentVersion },
    snapshot: makeSnapshotFixture(),
  };
}

describe('401/403 与双凭证互相隔离（tasks 7.2）', () => {
  it('无凭证访问业务/页面端点返回 401 并携带 Basic 挑战与 no-store', async () => {
    const { baseUrl } = await startFresh();
    for (const path of ['/api/overview', '/api/projects', '/app.js', '/']) {
      const res = await doFetch(baseUrl, path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('上传凭证不可读业务端点/页面（403），可读 /api/meta（非业务元数据）', async () => {
    const service = await startFresh();
    await doFetch(service.baseUrl, '/api/publish', uploadInit(publishPayload('P-1', 0), TEST_UPLOAD_TOKEN));

    for (const path of ['/api/overview', '/api/projects', '/api/project?id=x', '/api/records?projectId=x&kind=batches', '/', '/app.js']) {
      const res = await doFetch(service.baseUrl, path, { headers: { Authorization: bearerHeader() } });
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('FORBIDDEN');
    }

    const meta = await doFetch(service.baseUrl, '/api/meta', { headers: { Authorization: bearerHeader() } });
    expect(meta.status).toBe(200);
    expect(meta.headers.get('cache-control')).toBe('no-store');
    const metaBody = (await meta.json()) as {
      published: boolean;
      currentVersion: number;
      publicationId: string | null;
      publishedAt: string | null;
    };
    expect(metaBody.published).toBe(true);
    expect(metaBody.currentVersion).toBe(1);
    expect(metaBody.publicationId).toBe('P-1');
    expect(metaBody.publishedAt).not.toBeNull();
    // meta 是非业务版本元数据：绝不携带业务快照内容。
    const raw = JSON.stringify(metaBody);
    expect(raw).not.toContain('snapshot');
    expect(raw).not.toContain('projects');
  });

  it('查看凭证不可上传也不可读 /api/meta（403），但可读业务与页面', async () => {
    const { baseUrl } = await startFresh();
    const authHeaders = { Authorization: basicAuthHeader() };

    const publishWithViewer = await doFetch(baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(publishPayload('P-x', 0)),
    });
    expect(publishWithViewer.status).toBe(403);

    const metaWithViewer = await doFetch(baseUrl, '/api/meta', { headers: authHeaders });
    expect(metaWithViewer.status).toBe(403);

    const overview = await doFetch(baseUrl, '/api/overview', { headers: authHeaders });
    expect(overview.status).toBe(200);
    const index = await doFetch(baseUrl, '/', { headers: authHeaders });
    expect(index.status).toBe(200);
  });

  it('错误密码 / 错误 token 一律 401（不做模糊双层 Basic）', async () => {
    const { baseUrl } = await startFresh();
    const badBasic = await doFetch(baseUrl, '/api/overview', {
      headers: { Authorization: basicAuthHeader(TEST_VIEWER_USERNAME, 'wrong-password') },
    });
    expect(badBasic.status).toBe(401);

    const badToken = await doFetch(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer wrong-token' } });
    expect(badToken.status).toBe(401);
  });

  it('非标准/复合 Authorization 一律按缺失凭证 401；标准 Bearer 上传正常提交', async () => {
    const service = await startFresh();
    const dual = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${basicAuthHeader()}, ${bearerHeader()}`,
      },
      body: JSON.stringify(publishPayload('P-dual', 0)),
    });
    expect(dual.status).toBe(401); // 不识别复合 Authorization（按缺失凭证处理），而非模糊通过

    const ok = await doFetch(service.baseUrl, '/api/publish', uploadInit(publishPayload('P-ok', 0), TEST_UPLOAD_TOKEN));
    expect(ok.status).toBe(200);
  });

  it('业务查询、meta、上传成功与 409 冲突响应均 no-store', async () => {
    const service = await startFresh();
    const authHeaders = { Authorization: basicAuthHeader() };

    const conflict = await doFetch(service.baseUrl, '/api/publish', uploadInit(publishPayload('P-first', 0), TEST_UPLOAD_TOKEN));
    expect(conflict.status).toBe(200);
    expect(conflict.headers.get('cache-control')).toBe('no-store');

    const stale = await doFetch(service.baseUrl, '/api/publish', uploadInit(publishPayload('P-late', 0), TEST_UPLOAD_TOKEN));
    expect(stale.status).toBe(409);
    expect(stale.headers.get('cache-control')).toBe('no-store');

    const overview = await doFetch(service.baseUrl, '/api/overview', { headers: authHeaders });
    expect(overview.headers.get('cache-control')).toBe('no-store');

    const meta = await doFetch(service.baseUrl, '/api/meta', { headers: { Authorization: bearerHeader() } });
    expect(meta.headers.get('cache-control')).toBe('no-store');
  });
});

describe('凭证摘要持久化（tasks 7.3）', () => {
  it('只持久化 scrypt 摘要：落盘文件与输出不含明文密码/token，可加载并恒时校验', async () => {
    const service = await startFresh();
    const file = makeTestCredentials();
    const serialized = JSON.stringify(file);
    expect(serialized).not.toContain(TEST_VIEWER_PASSWORD);
    expect(serialized).not.toContain(TEST_UPLOAD_TOKEN);

    const path = join(service.dataDir, 'credentials.json');
    writeFileSync(path, serialized, 'utf8');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(TEST_VIEWER_PASSWORD);
    expect(raw).not.toContain(TEST_UPLOAD_TOKEN);

    const loaded = loadCredentialsFileSync(path);
    expect(loaded).toEqual(file);
    expect(parseCredentialsJson(raw)).toEqual(file);
    expect(viewerMatches(loaded, TEST_VIEWER_USERNAME, TEST_VIEWER_PASSWORD)).toBe(true);
    expect(viewerMatches(loaded, TEST_VIEWER_USERNAME, 'wrong')).toBe(false);
    expect(uploadTokenMatches(loaded, TEST_UPLOAD_TOKEN)).toBe(true);
    expect(uploadTokenMatches(loaded, 'wrong-token')).toBe(false);
  });

  it('服务从磁盘加载凭证文件（不注入 credentials）；默认注入凭证访问按未授权拒绝', async () => {
    // 写入 A 的磁盘摘要，但启动时不注入任何 credentials —— 只能从磁盘加载。
    const dataDir = mkdtempSync(join(tmpdir(), 'mr-auth-disk-'));
    dirs.push(dataDir);
    const diskPath = join(dataDir, 'credentials.json');
    const diskCredentials = generateCredentialsFile('disk-viewer', 'disk-password-7k2x9', 'disk-token-a9f0b3');
    writeFileSync(diskPath, JSON.stringify(diskCredentials), 'utf8');

    const started = await startTestService({ dataDir, config: { credentialsFile: diskPath }, injectCredentials: false });
    services.push(started);

    // 磁盘凭证有效 → 200。
    const diskOk = await doFetch(started.baseUrl, '/api/overview', {
      headers: { Authorization: `Basic ${Buffer.from('disk-viewer:disk-password-7k2x9', 'utf8').toString('base64')}` },
    });
    expect(diskOk.status).toBe(200);

    // 默认测试凭证（未落盘）不被接受 → 401（证明走的是磁盘文件而不是默认注入）。
    const defaultRejected = await doFetch(started.baseUrl, '/api/overview', {
      headers: { Authorization: basicAuthHeader() },
    });
    expect(defaultRejected.status).toBe(401);
    const diskUpload = await doFetch(started.baseUrl, '/api/meta', {
      headers: { Authorization: 'Bearer disk-token-a9f0b3' },
    });
    expect(diskUpload.status).toBe(200);
  });

  it('磁盘凭证缺失/损坏（非 JSON / 格式非法）→ 启动即失败，绝不明文降级或默认放行', async () => {
    const dirMissing = mkdtempSync(join(tmpdir(), 'mr-auth-missing-'));
    dirs.push(dirMissing);
    await expect(
      startMobileReadonlyService({ config: makeTestServiceConfig({ dataDir: dirMissing, credentialsFile: join(dirMissing, 'nope.json') }) }),
    ).rejects.toThrow();

    for (const content of ['{{{ not json', JSON.stringify({ viewer: { username: 'v', digest: 'garbage' }, upload: { digest: 'garbage' } })]) {
      const dirBad = mkdtempSync(join(tmpdir(), 'mr-auth-bad-'));
      dirs.push(dirBad);
      const badPath = join(dirBad, 'credentials.json');
      writeFileSync(badPath, content, 'utf8');
      await expect(
        startMobileReadonlyService({ config: makeTestServiceConfig({ dataDir: dirBad, credentialsFile: badPath }) }),
      ).rejects.toThrow();
    }
  });

  it('错误响应不回显业务/密钥内容（请求体只回显固定安全文案）', async () => {
    const { baseUrl } = await startFresh();
    const res = await doFetch(baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: bearerHeader() },
      body: JSON.stringify({ protocol: { publicationId: 'P', expectedCurrentVersion: 0 }, extra: TEST_UPLOAD_TOKEN }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(TEST_UPLOAD_TOKEN);
    expect(text).not.toContain(TEST_VIEWER_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// 有界 auth 并发信号量与 auth 期间请求超时（受控假校验器，无真实 scrypt 负担）
// ---------------------------------------------------------------------------

interface DirectHandlerServer {
  baseUrl: string;
  close(): Promise<void>;
}

function createControlledVerifier() {
  const uploads: Array<{ token: string; resolve: (ok: boolean) => void }> = [];
  const viewers: Array<{ username: string; password: string; resolve: (ok: boolean) => void }> = [];
  const verifier: MobileReadonlyAuthVerifier = {
    verifyUploadToken: (token) =>
      new Promise<boolean>((resolve) => {
        uploads.push({ token, resolve });
      }),
    verifyViewer: (username, password) =>
      new Promise<boolean>((resolve) => {
        viewers.push({ username, password, resolve });
      }),
  };
  return { uploads, viewers, verifier };
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2000) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startDirectHandlerServer(options: {
  authMaxActive: number;
  requestTimeoutMs: number;
  verifier: MobileReadonlyAuthVerifier;
}): Promise<DirectHandlerServer> {
  const dir = mkdtempSync(join(tmpdir(), 'mr-auth-direct-'));
  dirs.push(dir);
  const store = new EnvelopeStore(createNodeEnvelopeIo(join(dir, 'snapshots')), { nowIso: () => '2026-08-08T09:00:00.000Z' });
  store.init();
  const server = http.createServer(
    createRequestHandler({
      store,
      credentials: makeTestCredentials(),
      webRoot: null,
      maxBodyBytes: 1 << 20,
      maxUrlLength: 8192,
      requestTimeoutMs: options.requestTimeoutMs,
      authMaxActive: options.authMaxActive,
      authVerifier: options.verifier,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpServers.push(server);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((res) => server.close(() => res())) };
}

function rawHttpRequest(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; closed: boolean }> {
  return new Promise((resolve) => {
    const url = new URL(baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        method: options.method ?? 'GET',
        headers: { Connection: 'close', ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), closed: false });
        });
        res.on('close', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), closed: true });
        });
      },
    );
    req.on('error', () => resolve({ status: 0, body: '', closed: true }));
    req.end();
  });
}

describe('请求路径 auth 有界并发与超时（异步 scrypt，tasks 7.x）', () => {
  it('错误 Bearer 并发超过上限：超出者立即 503（AUTH_BUSY），无堆积计算，其余 401', async () => {
    const controlled = createControlledVerifier();
    const { baseUrl, close } = await startDirectHandlerServer({
      authMaxActive: 2,
      requestTimeoutMs: 5_000,
      verifier: controlled.verifier,
    });
    try {
      const pA = rawHttpRequest(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer wrong-A' } });
      await waitUntil(() => controlled.uploads.length >= 1, '第一个校验进入');
      const pB = rawHttpRequest(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer wrong-B' } });
      await waitUntil(() => controlled.uploads.length >= 2, '第二个校验进入');

      // 第三个请求：信号量已满 → 立即 503，且不会触发任何校验计算。
      const busy = await rawHttpRequest(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer wrong-C' } });
      expect(busy.status).toBe(503);
      expect(busy.body).toContain('AUTH_BUSY');
      expect(controlled.uploads.length).toBe(2); // 无排队计算

      // 放行前两个（均校验失败）→ 401 语义保留。
      controlled.uploads[0].resolve(false);
      controlled.uploads[1].resolve(false);
      const resA = await pA;
      const resB = await pB;
      expect([resA.status, resB.status].sort()).toEqual([401, 401]);

      // 容量释放后可正常通过校验（第二次周期真正进入计算）。
      const pOk = rawHttpRequest(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer good-token' } });
      await waitUntil(() => controlled.uploads.length >= 3, '第三个校验进入');
      controlled.uploads[2].resolve(true);
      expect((await pOk).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('校验进行中整体请求超时：连接在受限时限内断开、迟到结果不产生响应，服务仍可用', async () => {
    const controlled = createControlledVerifier();
    const { baseUrl, close } = await startDirectHandlerServer({
      authMaxActive: 1,
      requestTimeoutMs: 300,
      verifier: controlled.verifier,
    });
    try {
      const startedAt = Date.now();
      const p = rawHttpRequest(baseUrl, '/api/overview', { headers: { Authorization: basicAuthHeader() } });
      await waitUntil(() => controlled.viewers.length >= 1, 'viewer 校验进入（auth 挂起）');
      // 客户端侧安全看门狗：若超过 2000ms 仍未断开则视为失败（不放任长等待）。
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 2000);
      });
      const result = await Promise.race([p, timeoutPromise]);
      expect(result).not.toBe('timeout');
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(2000);

      // 迟到校验结果不得再向已结束连接写入（guard 负责）；释放信号量后服务仍可用。
      controlled.viewers[0].resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 30)); // 等 gate 释放
      const pOk = rawHttpRequest(baseUrl, '/api/meta', { headers: { Authorization: 'Bearer ok-after-timeout' } });
      await waitUntil(() => controlled.uploads.length >= 1, '释放后的校验进入');
      controlled.uploads[0].resolve(true);
      expect((await pOk).status).toBe(200);
    } finally {
      await close();
    }
  });
});
