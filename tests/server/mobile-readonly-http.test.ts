import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { MobileReadonlyPublishResult } from '../../src/shared/mobile-readonly';
import { makeEmptySnapshotFixture, makeSnapshotFixture, mutateFirstRowOfKind } from '../helpers/mobile-readonly-fixtures';
import {
  TEST_UPLOAD_TOKEN,
  TEST_VIEWER_USERNAME,
  basicAuthHeader,
  bearerHeader,
  doFetch,
  startTestService,
  stopTestService,
  uploadInit,
  type StartedTestService,
} from './mobile-readonly-test-helpers';

/**
 * HTTP 边界与 no-store（tasks 7.5）：
 * - 全部响应（含静态页与错误）no-store；
 * - 尚未发布与已发布空快照明确区分；请求体/URL 上限、上传中断与有限超时绝不落半写；
 * - 重启遗留临时文件不作为可读版本；静态页只来自 web 目录且拒绝路径穿越。
 */

const services: StartedTestService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await stopTestService(service);
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function newTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function uploadPayload(publicationId: string, expectedCurrentVersion: number, snapshot: unknown): unknown {
  return { protocol: { publicationId, expectedCurrentVersion }, snapshot };
}

describe('no-store 与静态页/资产（7.5）', () => {
  it('内建页模板与业务/错误响应均携带 Cache-Control: no-store', async () => {
    const service = await startFresh();
    const authHeaders = { Authorization: basicAuthHeader() };

    const index = await doFetch(service.baseUrl, '/', { headers: authHeaders });
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toContain('<script src="/app.js"></script>');

    const asset = await doFetch(service.baseUrl, '/app.js', { headers: authHeaders });
    expect(asset.headers.get('cache-control')).toBe('no-store');

    const notFound = await doFetch(service.baseUrl, '/no-such-file.js', { headers: authHeaders });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('cache-control')).toBe('no-store');
  });

  it('web 目录 index.html 优先于内建模板；app.js 等资产来自 web 目录（含 content-type）', async () => {
    const webRoot = newTempDir('mr-web-');
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><html><body data-mark="custom-index">CUSTOM</body></html>', 'utf8');
    writeFileSync(join(webRoot, 'app.js'), 'console.log("mobile bundle");', 'utf8');
    writeFileSync(join(webRoot, 'styles.css'), 'body { margin: 0 }', 'utf8');
    const service = await startTestService({ webRoot });
    services.push(service);

    const authHeaders = { Authorization: basicAuthHeader() };
    const index = await doFetch(service.baseUrl, '/', { headers: authHeaders });
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('CUSTOM');

    const app = await doFetch(service.baseUrl, '/app.js', { headers: authHeaders });
    expect(app.status).toBe(200);
    expect(app.headers.get('content-type')).toContain('text/javascript');
    expect(await app.text()).toBe('console.log("mobile bundle");');

    const css = await doFetch(service.baseUrl, '/styles.css', { headers: authHeaders });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const head = await doFetch(service.baseUrl, '/app.js', { method: 'HEAD', headers: authHeaders });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
  });

  it('web 目录存在但缺 index.html 时回退内建模板（200 + #root + /app.js，不 500）', async () => {
    const webRoot = newTempDir('mr-web-noindex-');
    writeFileSync(join(webRoot, 'app.js'), 'console.log("mobile bundle");', 'utf8');
    const service = await startTestService({ webRoot });
    services.push(service);
    const authHeaders = { Authorization: basicAuthHeader() };

    const index = await doFetch(service.baseUrl, '/', { headers: authHeaders });
    expect(index.status).toBe(200); // 回归：内建模板回退不得因 header/读取问题产生 500
    expect(index.headers.get('cache-control')).toBe('no-store');
    const text = await index.text();
    expect(text).toContain('id="root"');
    expect(text).toContain('<script src="/app.js"></script>');

    const head = await doFetch(service.baseUrl, '/', { method: 'HEAD', headers: authHeaders });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(head.headers.get('content-length')).not.toBeNull();

    // 同一 webRoot：存在的资产正常返回，缺失资产 404（不 500）。
    const asset = await doFetch(service.baseUrl, '/app.js', { headers: authHeaders });
    expect(asset.status).toBe(200);
    const missing = await doFetch(service.baseUrl, '/missing.js', { headers: authHeaders });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('路径穿越与隐藏文件一律拒绝（不越过 web 目录、不暴露外部文件）', async () => {
    const webRoot = newTempDir('mr-web-traversal-');
    writeFileSync(join(webRoot, 'index.html'), '<html>ok</html>', 'utf8');
    const outside = join(webRoot, '..', `mr-outside-${Date.now()}.txt`);
    writeFileSync(outside, 'secret-outside', 'utf8');
    dirs.push(outside);
    const service = await startTestService({ webRoot });
    services.push(service);
    const authHeaders = { Authorization: basicAuthHeader() };

    for (const path of [
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fetc%2fpasswd',
      '/.%2e/.%2e/mr-outside-9999.txt',
      '/.hidden-file',
      '/app.js/..%2f..%2fpackage.json',
    ]) {
      const res = await doFetch(service.baseUrl, path, { headers: authHeaders });
      expect(res.status, path).toBe(404);
      expect((await res.text())).not.toContain('secret-outside');
    }
  });
});

describe('请求体上限与中断/超时防护（7.5）', () => {
  it('超限上传被拒 413：当前可读快照与文件保持不变、不上送整份 JSON', async () => {
    const service = await startTestService({ config: { maxBodyBytes: 800 } });
    services.push(service);
    const authHeaders = { Authorization: basicAuthHeader() };
    const res = await doFetch(
      service.baseUrl,
      '/api/publish',
      uploadInit(uploadPayload('P-big', 0, makeSnapshotFixture()), TEST_UPLOAD_TOKEN),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');

    // 未落任何版本。
    const overview = await doFetch(service.baseUrl, '/api/overview', { headers: authHeaders });
    const overviewBody = (await overview.json()) as { metadata: { published: boolean; currentVersion: number } };
    expect(overviewBody.metadata.published).toBe(false);
    expect(overviewBody.metadata.currentVersion).toBe(0);
  });

  it('上传中断不产生可读版本：服务已收到请求与部分体，旧文件/版本/业务读取保持不变，随后完整重试按规则提交', async () => {
    const service = await startFresh();
    const oldSnapshot = makeSnapshotFixture({ businessRevision: 11 });
    const firstPublish = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-old', 0, oldSnapshot), TEST_UPLOAD_TOKEN));
    expect(firstPublish.status).toBe(200);
    const currentFile = join(service.dataDir, 'snapshots', 'current.json');
    const fileBefore = readFileSync(currentFile);
    const authHeaders = { Authorization: basicAuthHeader() };
    const metaBefore = (await (await doFetch(service.baseUrl, '/api/meta', { headers: { Authorization: bearerHeader() } })).json()) as {
      published: boolean;
      currentVersion: number;
      publicationId: string;
    };
    expect(metaBefore.published).toBe(true);
    expect(metaBefore.currentVersion).toBe(1);
    expect(metaBefore.publicationId).toBe('P-old');

    // 中断上传（V2 候选，expected=1）：客户端先写出部分请求体并等待其离开 socket，
    // 之后才销毁连接 —— 保证服务端确实收到「请求 + 部分 body」才进入中断分支。
    const interrupted = await sendPartialUntilFlushed(service, 1_000_000, 'P-partial');
    expect(interrupted.bytesWritten).toBeGreaterThan(60);
    await new Promise((resolve) => setTimeout(resolve, 120)); // 服务端处理 aborted/close

    const overview = await doFetch(service.baseUrl, '/api/overview', { headers: authHeaders });
    const after = (await overview.json()) as { metadata: { published: boolean; currentVersion: number; publicationId: string } };
    expect(after.metadata.currentVersion).toBe(1);
    expect(after.metadata.publicationId).toBe('P-old');
    expect(readFileSync(currentFile)).toEqual(fileBefore); // 文件字节不变

    // 完整重试：expectedCurrentVersion=1 条件提交成功（版本 2）。
    const retry = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-retry', 1, makeSnapshotFixture()), TEST_UPLOAD_TOKEN));
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { result: string; metadata: { currentVersion: number } };
    expect(retryBody.result).toBe('committed');
    expect(retryBody.metadata.currentVersion).toBe(2);
  });

  it('有限超时：慢速悬挂上传被服务端 300ms 断开（客户端有界看门狗，不任意长等），不落半写、旧状态保留', async () => {
    const service = await startTestService({ config: { requestTimeoutMs: 300 } });
    services.push(service);
    const currentFile = join(service.dataDir, 'snapshots', 'current.json');
    const firstPublish = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-old-2', 0, makeSnapshotFixture({ businessRevision: 5 })), TEST_UPLOAD_TOKEN));
    expect(firstPublish.status).toBe(200);
    const fileBefore = readFileSync(currentFile);

    // trickle：只写部分请求体、不 destroy，等待服务端 requestTimeout=300ms 主动断开。
    const result = await sendPartialUntilServerTimeout(service, 1_000_000, 'P-trickle', 2500);
    expect(result.closed).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2000); // 有界：远小于任意真实 60s 等待

    const authHeaders = { Authorization: basicAuthHeader() };
    const overview = await doFetch(service.baseUrl, '/api/overview', { headers: authHeaders });
    const body = (await overview.json()) as { metadata: { published: boolean; currentVersion: number; publicationId: string } };
    expect(body.metadata.published).toBe(true);
    expect(body.metadata.currentVersion).toBe(1);
    expect(body.metadata.publicationId).toBe('P-old-2');
    expect(readFileSync(currentFile)).toEqual(fileBefore);
  });

  it('非 JSON 媒体类型 415、非法 JSON 400、协议/顶层非法 400、快照未知 key 422', async () => {
    const service = await startFresh();
    const token = { Authorization: bearerHeader() };

    const wrongType = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', ...token },
      body: 'hello',
    });
    expect(wrongType.status).toBe(415);

    const badJson = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...token },
      body: '{{{',
    });
    expect(badJson.status).toBe(400);

    const topLevelExtra = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...token },
      body: JSON.stringify({ protocol: { publicationId: 'P', expectedCurrentVersion: 0 }, snapshot: makeSnapshotFixture(), extra: 1 }),
    });
    expect(topLevelExtra.status).toBe(400);
    const extraBody = (await topLevelExtra.json()) as { error: { code: string } };
    expect(extraBody.error.code).toBe('INVALID_PROTOCOL');

    const emptyId = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...token },
      body: JSON.stringify({ protocol: { publicationId: '', expectedCurrentVersion: 0 }, snapshot: makeSnapshotFixture() }),
    });
    expect(emptyId.status).toBe(400);

    const mutated = mutateFirstRowOfKind(makeSnapshotFixture(), 'batches', (row) => {
      row.unknownField = true;
    });
    const unknownKey = await doFetch(service.baseUrl, '/api/publish', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...token },
      body: JSON.stringify(uploadPayload('P-bad', 0, mutated)),
    });
    expect(unknownKey.status).toBe(422);
    const unknownBody = (await unknownKey.json()) as { error: { code: string; issues: unknown[] } };
    expect(unknownBody.error.code).toBe('INVALID_SNAPSHOT');
    expect(Array.isArray(unknownBody.error.issues)).toBe(true);

    // 校验失败保留旧状态。
    const meta = await doFetch(service.baseUrl, '/api/meta', { headers: token });
    const metaBody = (await meta.json()) as { published: boolean };
    expect(metaBody.published).toBe(false);
  });

  it('空集合快照为合法发布（已发布空快照 ≠ 尚未发布）', async () => {
    const service = await startFresh();
    const res = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-empty', 0, makeEmptySnapshotFixture()), TEST_UPLOAD_TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; metadata: { currentVersion: number } };
    expect(body.result).toBe('committed');
    expect(body.metadata.currentVersion).toBe(1);
  });
});

describe('意外异常固定 500 安全响应（不泄漏内部信息）', () => {
  it('未规范化异常一律 500 INTERNAL 固定文案：响应不含异常 message/哨兵，正常错误不受影响', async () => {
    const service = await startFresh();
    const sentinel = 'sentinel-secret-9f8e7d2c-should-never-leak';
    // 注入未规范化异常：模拟 store 内部意外抛错（非 MobileReadonlyHttpError）。
    service.running.store.currentEnvelope = () => {
      throw new Error(`unexpected internal failure: ${sentinel}`);
    };

    const res = await doFetch(service.baseUrl, '/api/overview', { headers: { Authorization: basicAuthHeader() } });
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = await res.text();
    expect(raw).not.toContain(sentinel);
    expect(raw).not.toContain('unexpected internal failure');
    expect(raw).not.toContain('internal failure');
    const body = JSON.parse(raw) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('服务器内部错误');
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);

    // 正常规范化错误不受影响：未知接口仍按原 code/message 返回 404。
    const notFound = await doFetch(service.baseUrl, '/api/no-such-endpoint', { headers: { Authorization: basicAuthHeader() } });
    expect(notFound.status).toBe(404);
    const notFoundBody = (await notFound.json()) as { error: { code: string; message: string } };
    expect(notFoundBody.error.code).toBe('NOT_FOUND');
    expect(notFoundBody.error.message).toBe('接口不存在');
  });
});

describe('上传响应线类型 { result, metadata }（7.1/共享 wire）', () => {
  it('committed 200 / 幂等 200 / conflict 409 均为共享 MobileReadonlyPublishResult 形状', async () => {
    const service = await startFresh();

    const first = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-wire', 0, makeSnapshotFixture()), TEST_UPLOAD_TOKEN));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as MobileReadonlyPublishResult;
    expect(Object.keys(firstBody).sort()).toEqual(['metadata', 'result']);
    expect(firstBody.result).toBe('committed');
    expect(firstBody.metadata.currentVersion).toBe(1);
    expect(firstBody.metadata.publicationId).toBe('P-wire');
    expect(firstBody.metadata.published).toBe(true);

    // 重复当前 publicationId → 幂等成功：result=idempotent、版本/publishedAt 不变。
    const retry = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-wire', 0, makeSnapshotFixture()), TEST_UPLOAD_TOKEN));
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as MobileReadonlyPublishResult;
    expect(retryBody.result).toBe('idempotent');
    expect(retryBody.metadata.currentVersion).toBe(1);
    expect(retryBody.metadata.publishedAt).toBe(firstBody.metadata.publishedAt);

    // 过期期望版本 → 409 conflict + 当前元数据（不覆盖）。
    const stale = await doFetch(service.baseUrl, '/api/publish', uploadInit(uploadPayload('P-stale', 0, makeSnapshotFixture()), TEST_UPLOAD_TOKEN));
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as MobileReadonlyPublishResult;
    expect(staleBody.result).toBe('conflict');
    expect(staleBody.metadata.currentVersion).toBe(1);
    expect(staleBody.metadata.publicationId).toBe('P-wire');
  });
});

describe('URL/方法边界与重启遗留临时文件（7.5）', () => {  it('URL 超长 414；方法不当 405；快照文件路径不可直达', async () => {
    const service = await startTestService({ config: { maxUrlLength: 200 } });
    services.push(service);
    const authHeaders = { Authorization: basicAuthHeader() };
    const longUrl = await doFetch(service.baseUrl, `/api/projects?query=${'a'.repeat(300)}`, { headers: authHeaders });
    expect(longUrl.status).toBe(414);

    const wrongMethod = await doFetch(service.baseUrl, '/api/overview', { method: 'POST', headers: authHeaders });
    expect(wrongMethod.status).toBe(405);

    const publishGet = await doFetch(service.baseUrl, '/api/publish', { headers: { Authorization: bearerHeader() } });
    expect(publishGet.status).toBe(405);
  });

  it('重启仅清理本服务遗留临时文件：含合法内容的遗留 tmp 不作为可读版本', async () => {
    const dataDir = newTempDir('mr-restart-');
    const snapshotsDir = join(dataDir, 'snapshots');
    mkdirSync(snapshotsDir, { recursive: true });
    const abandonedEnvelope = JSON.stringify({
      currentVersion: 5,
      publicationId: 'P-leftover',
      publishedAt: '2026-08-08T09:00:00.000Z',
      snapshot: makeSnapshotFixture(),
    });
    writeFileSync(join(snapshotsDir, `current.json.a1b2c3d4e5f6${'.tmp'}`), abandonedEnvelope, 'utf8');

    const service = await startTestService({ dataDir });
    services.push(service);
    // 遗留 tmp 不成为可读版本：服务如实报告尚未发布。
    const meta = await doFetch(service.baseUrl, '/api/meta', { headers: { Authorization: bearerHeader() } });
    const body = (await meta.json()) as { published: boolean; currentVersion: number };
    expect(body.published).toBe(false);
    expect(body.currentVersion).toBe(0);
    expect(readdirSync(snapshotsDir)).toEqual([]); // 已清理自己的 tmp
  });
});

describe('直连 HTTPS（注入 TLS 选项，tasks 7.6 配套）', () => {
  it('配置 TLS 私钥/证书后服务以 HTTPS 监听，标准证书校验 + Basic 可用', async () => {
    const certFile = join(process.cwd(), 'tests', 'server', 'fixtures', 'tls', 'cert.pem');
    const keyFile = join(process.cwd(), 'tests', 'server', 'fixtures', 'tls', 'key.pem');
    const service = await startTestService({ config: { tls: { keyFile, certFile } } });
    services.push(service);

    expect(service.baseUrl.startsWith('https://')).toBe(true);
    const ca = readFileSync(certFile);
    const url = new URL('/api/overview', service.baseUrl);
    const result = await httpsJsonRequest(url, { Authorization: basicAuthHeader() }, ca);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { metadata: { published: boolean; currentVersion: number } };
    expect(body.metadata.published).toBe(false);
    expect(body.metadata.currentVersion).toBe(0);
    expect(result.noStore).toBe(true);

    const badAuth = await httpsJsonRequest(url, { Authorization: basicAuthHeader(TEST_VIEWER_USERNAME, 'wrong') }, ca);
    expect(badAuth.status).toBe(401);
  });
});

function httpsJsonRequest(
  url: URL,
  headers: Record<string, string>,
  ca: Buffer,
): Promise<{ status: number; body: string; noStore: boolean }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, port: Number(url.port), path: `${url.pathname}${url.search}`, method: 'GET', headers, ca, rejectUnauthorized: true },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            noStore: res.headers['cache-control'] === 'no-store',
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

async function startFresh(): Promise<StartedTestService> {
  const service = await startTestService();
  services.push(service);
  return service;
}

/** 写出一部分请求体并等它离开客户端 socket 后再销毁：保证服务端确实收到「请求+部分体」。 */
function sendPartialUntilFlushed(service: StartedTestService, declaredLength: number, publicationId: string): Promise<{ bytesWritten: number }> {
  return new Promise((resolve) => {
    const url = new URL('/api/publish', service.baseUrl);
    const req = http.request({
      host: url.hostname,
      port: Number(url.port),
      method: 'PUT',
      path: '/api/publish',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_UPLOAD_TOKEN}`,
        'Content-Length': String(declaredLength),
        Connection: 'close',
      },
    });
    req.on('error', () => {
      resolve({ bytesWritten: 0 });
    });
    const prefix = `{"protocol":{"publicationId":"${publicationId}","expectedCurrentVersion":1},"snapshot":{`;
    req.write(prefix, 'utf8', () => {
      const bytesWritten = req.socket ? req.socket.bytesWritten : prefix.length;
      // 数据已离开客户端 socket；给服务端极短处理窗口后销毁（绝不写完成整个请求）。
      setTimeout(() => {
        req.destroy();
        resolve({ bytesWritten });
      }, 40);
    });
  });
}

/** 只写部分请求体、不主动 end/destroy：等待服务端 requestTimeout 主动断开；带客户端安全看门狗。 */
function sendPartialUntilServerTimeout(
  service: StartedTestService,
  declaredLength: number,
  publicationId: string,
  watchdogMs: number,
): Promise<{ closed: boolean; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/publish', service.baseUrl);
    const req = http.request({
      host: url.hostname,
      port: Number(url.port),
      method: 'PUT',
      path: '/api/publish',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_UPLOAD_TOKEN}`,
        'Content-Length': String(declaredLength),
        Connection: 'close',
      },
    });
    const startedAt = Date.now();
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve({ closed, elapsedMs: Date.now() - startedAt });
    };
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        // ignore
      }
      reject(new Error(`客户端安全看门狗超时（${watchdogMs}ms）：服务端未在时限内断开连接`));
    }, watchdogMs);
    req.on('error', () => finish(true));
    req.on('close', () => finish(true));
    req.write(`{"protocol":{"publicationId":"${publicationId}","expectedCurrentVersion":1},"snapshot":{`);
    // 不 end：保持连接悬挂，等待服务端整体超时主动断开。
  });
}
