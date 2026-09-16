import { describe, expect, it } from 'vitest';
import type {
  MobileReadonlyHttpClientRequestLike,
  MobileReadonlyHttpRequest,
  MobileReadonlyHttpResponse,
  MobileReadonlyHttpResponseLike,
  MobileReadonlyHttpTransport,
} from '../../src/main/mobile-readonly/upload';
import { createDefaultHttpsTransport, createMobileReadonlyRemoteClient } from '../../src/main/mobile-readonly/upload';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import { makeSnapshotFixture } from '../helpers/mobile-readonly-fixtures';

/**
 * 上传客户端与协议分层（tasks 4.2）：
 * - HTTPS 固定目标、PUT /api/publish、GET /api/meta；
 * - Authorization: Bearer token；上传体 {protocol:{publicationId,expectedCurrentVersion}, snapshot:{…}} 分层；
 * - 409 冲突响应按 wire 信封 { result:'conflict', metadata } 解析（不接受裸元数据旧形状）；
 * - 传输异常只透传内部规范化码，任意其它文本（可能含 token/远端内容）一律归一 NETWORK_ERROR；
 * - 默认真实传输为「总时限」（自请求开始计时），不是 req.setTimeout 的空闲超时；可注入假件做
 *   受控时钟/数据滴答证明（生产保持 node:https 默认 TLS 校验、不跟随重定向）。
 */

const TARGET = 'https://publish.example.com';
const TOKEN = 'secret-token';

function json(status: number, body: unknown): MobileReadonlyHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function metaBody(overrides: Partial<{ published: boolean; currentVersion: number; publicationId: string | null }> = {}) {
  return {
    published: false,
    currentVersion: 0,
    publicationId: null,
    publishedAt: null,
    dataAsOf: null,
    fingerprint: null,
    ...overrides,
  };
}

function makeTransport(handler: (request: MobileReadonlyHttpRequest) => MobileReadonlyHttpResponse | Promise<MobileReadonlyHttpResponse>): MobileReadonlyHttpTransport {
  const calls: MobileReadonlyHttpRequest[] = [];
  const transport: MobileReadonlyHttpTransport = async (request) => {
    calls.push(request);
    return handler(request);
  };
  (transport as { calls?: MobileReadonlyHttpRequest[] }).calls = calls;
  return transport;
}

type AnyListener = (...args: unknown[]) => void;

class FakeSocketLike {
  private listeners = new Map<string, AnyListener[]>();
  destroyed = false;
  on(event: string, listener: AnyListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  protected emit(event: string, ...args: unknown[]): void {
    const arr = this.listeners.get(event) ?? [];
    for (const listener of [...arr]) listener(...args);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeResponse extends FakeSocketLike implements MobileReadonlyHttpResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined> = {};
  pushData(chunk: Buffer | string): void {
    this.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  finish(): void {
    this.emit('end');
  }
}

class FakeRequest extends FakeSocketLike implements MobileReadonlyHttpClientRequestLike {
  written: string[] = [];
  ended = false;
  write(chunk: string): void {
    this.written.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
}

/**
 * 默认真实传输的受控测试假件：注入 fake request 实现 + 手动推进计时器，
 * 只驱动事件面（on/write/end/destroy），生产路径从不使用。
 */
function createHttpHarness(timeoutMs: number): {
  transport: MobileReadonlyHttpTransport;
  advance(ms: number): void;
  respond(status: number, body?: unknown): FakeResponse;
  calls: Array<{ options: Record<string, unknown>; request: FakeRequest }>;
  requestDestroyed: () => boolean;
  timersPending: () => number;
} {
  let now = 0;
  const timers: Array<{ due: number; fired: boolean; cancelled: boolean; callback: () => void }> = [];
  const calls: Array<{ options: Record<string, unknown>; request: FakeRequest }> = [];
  let responseListener: ((response: FakeResponse) => void) | null = null;

  const scheduleTimeout = (callback: () => void, delayMs: number) => {
    const entry = { due: now + delayMs, fired: false, cancelled: false, callback };
    timers.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  const transport = createDefaultHttpsTransport({
    timeoutMs,
    request: (options, listener) => {
      const request = new FakeRequest();
      calls.push({ options: options as unknown as Record<string, unknown>, request });
      responseListener = listener as (response: FakeResponse) => void;
      return request;
    },
    scheduleTimeout,
  });

  return {
    transport,
    advance(ms: number) {
      now += ms;
      const due = timers
        .filter((entry) => !entry.cancelled && !entry.fired && entry.due <= now)
        .sort((a, b) => a.due - b.due);
      for (const entry of due) {
        if (entry.cancelled) continue;
        entry.fired = true;
        entry.callback();
      }
    },
    respond(status: number, body?: unknown) {
      const response = new FakeResponse();
      response.statusCode = status;
      response.headers = { 'content-type': 'application/json' };
      responseListener?.(response);
      if (body !== undefined) response.pushData(JSON.stringify(body));
      return response;
    },
    calls,
    requestDestroyed: () => calls.length > 0 && calls.every((call) => call.request.destroyed),
    timersPending: () => timers.filter((entry) => !entry.cancelled && !entry.fired).length,
  };
}

function metaOf(fingerprint: { contentGenerationId: string; businessRevision: number }) {
  return {
    published: true,
    currentVersion: 1,
    publicationId: 'pub-x',
    publishedAt: '2026-08-08T09:00:00+08:00',
    dataAsOf: '2026-08-08T09:00:00+08:00',
    fingerprint,
  };
}

describe('上传/元数据客户端（tasks 4.2）', () => {
  it('readMeta 走 GET {target}/api/meta 并携带 Bearer token', async () => {
    const transport = makeTransport((request) => {
      expect(request.method).toBe('GET');
      expect(request.url).toBe(`${TARGET}/api/meta`);
      return json(200, metaBody());
    });
    const client = createMobileReadonlyRemoteClient({
      credentials: { target: TARGET, token: TOKEN },
      transport,
    });
    const result = await client.readMeta();
    expect(result.ok).toBe(true);
    const calls = (transport as unknown as { calls: MobileReadonlyHttpRequest[] }).calls;
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('upload 走 PUT {target}/api/publish，body 为 {protocol, snapshot} 分层且协议字段不进业务快照', async () => {
    const snapshot = makeSnapshotFixture();
    let captured: MobileReadonlyUploadBody | null = null;
    const transport = makeTransport((request) => {
      expect(request.method).toBe('PUT');
      expect(request.url).toBe(`${TARGET}/api/publish`);
      expect(request.headers['Content-Type']).toBe('application/json');
      captured = JSON.parse(request.body ?? '') as MobileReadonlyUploadBody;
      return json(200, {});
    });
    const client = createMobileReadonlyRemoteClient({
      credentials: { target: TARGET, token: TOKEN },
      transport,
    });
    const outcome = await client.upload({
      protocol: { publicationId: 'pub-1', expectedCurrentVersion: 3 },
      snapshot,
    });
    expect(outcome.kind).toBe('accepted');
    expect(captured).not.toBeNull();
    expect(captured!.protocol).toEqual({ publicationId: 'pub-1', expectedCurrentVersion: 3 });
    expect(captured!.snapshot).toEqual(snapshot);
    // 协议字段不得混入业务快照层。
    expect('publicationId' in captured!.snapshot).toBe(false);
    expect('expectedCurrentVersion' in captured!.snapshot).toBe(false);
  });

  it('409 wire 信封 → conflict（{result:"conflict", metadata} 携带元数据供三分支恢复）', async () => {
    const transport = makeTransport((request) => {
      if (request.method === 'PUT') {
        return json(409, {
          result: 'conflict',
          metadata: metaBody({ published: true, currentVersion: 9, publicationId: 'other-pub' }),
        });
      }
      return json(200, metaBody());
    });
    const client = createMobileReadonlyRemoteClient({ credentials: { target: TARGET, token: TOKEN }, transport });
    const outcome = await client.upload({
      protocol: { publicationId: 'mine', expectedCurrentVersion: 8 },
      snapshot: makeSnapshotFixture(),
    });
    expect(outcome).toEqual({
      kind: 'conflict',
      metadata: expect.objectContaining({ published: true, currentVersion: 9, publicationId: 'other-pub' }),
    });
  });

  it('409 裸元数据（旧/错位形状）不做双形兼容 → transport BAD_RESPONSE（不会误判冲突）', async () => {
    const transport = makeTransport(() => json(409, metaBody({ published: true, currentVersion: 9, publicationId: 'other-pub' })));
    const client = createMobileReadonlyRemoteClient({ credentials: { target: TARGET, token: TOKEN }, transport });
    const outcome = await client.upload({
      protocol: { publicationId: 'mine', expectedCurrentVersion: 8 },
      snapshot: makeSnapshotFixture(),
    });
    expect(outcome).toEqual({ kind: 'transport', code: 'BAD_RESPONSE' });
  });

  it('401/403 → rejected UNAUTHORIZED；400/422 → rejected UPLOAD_REJECTED', async () => {
    for (const [status, code] of [
      [401, 'UNAUTHORIZED'],
      [403, 'UNAUTHORIZED'],
      [400, 'UPLOAD_REJECTED'],
      [422, 'UPLOAD_REJECTED'],
    ] as const) {
      const transport = makeTransport(() => json(status, { message: 'no' }));
      const client = createMobileReadonlyRemoteClient({ credentials: { target: TARGET, token: TOKEN }, transport });
      const outcome = await client.upload({
        protocol: { publicationId: 'p', expectedCurrentVersion: 0 },
        snapshot: makeSnapshotFixture(),
      });
      expect(outcome).toEqual({ kind: 'rejected', code });
    }
  });

  it('3xx（重定向）不跟随并以 transport REDIRECT_REFUSED 处理；5xx → SERVER_ERROR', async () => {
    for (const [status, code] of [
      [301, 'REDIRECT_REFUSED'],
      [302, 'REDIRECT_REFUSED'],
      [500, 'SERVER_ERROR'],
    ] as const) {
      const transport = makeTransport(() => json(status, {}));
      const client = createMobileReadonlyRemoteClient({ credentials: { target: TARGET, token: TOKEN }, transport });
      const outcome = await client.upload({
        protocol: { publicationId: 'p', expectedCurrentVersion: 0 },
        snapshot: makeSnapshotFixture(),
      });
      expect(outcome).toEqual({ kind: 'transport', code });
    }
  });

  it('传输异常只透传内部规范化码；任意其它文本（可能含 token/远端内容）一律归一 NETWORK_ERROR', async () => {
    // 内部白名单码透传：TIMEOUT/TLS_ERROR/REDIRECT_REFUSED 等被保留（不进任意文本）。
    for (const message of ['TIMEOUT', 'TLS_ERROR', 'REDIRECT_REFUSED', 'NETWORK_ERROR', 'RESPONSE_TOO_LARGE']) {
      const client = createMobileReadonlyRemoteClient({
        credentials: { target: TARGET, token: TOKEN },
        transport: async () => {
          throw new Error(message);
        },
      });
      expect(await client.readMeta()).toEqual({ ok: false, code: message });
      const outcome = await client.upload({
        protocol: { publicationId: 'p', expectedCurrentVersion: 0 },
        snapshot: makeSnapshotFixture(),
      });
      expect(outcome).toEqual({ kind: 'transport', code: message });
    }

    // 非白名单文本（系统错误码/远端回显/疑似泄漏/空消息）一律 NETWORK_ERROR，且绝不把文本带回。
    const secret = 'remote-echo-TOP-SECRET-upload-token';
    for (const message of ['ECONNREFUSED', secret, 'DEPTH_ZERO_SELF_SIGNED_CERT', '']) {
      const client = createMobileReadonlyRemoteClient({
        credentials: { target: TARGET, token: TOKEN },
        transport: async () => {
          throw message === '' ? new Error() : new Error(message);
        },
      });
      const result = await client.readMeta();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NETWORK_ERROR');
        expect(result.code).not.toContain(secret);
      }
      expect(JSON.stringify(result)).not.toContain(secret);
      const outcome = await client.upload({
        protocol: { publicationId: 'p', expectedCurrentVersion: 0 },
        snapshot: makeSnapshotFixture(),
      });
      expect(outcome).toEqual({ kind: 'transport', code: 'NETWORK_ERROR' });
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });

  it('响应体超过上限 → RESPONSE_TOO_LARGE（不解析为元数据/不接受）', async () => {
    const huge = 'x'.repeat(1000);
    const transport = makeTransport(() => json(200, { body: huge }));
    const client = createMobileReadonlyRemoteClient({
      credentials: { target: TARGET, token: TOKEN },
      transport,
      maxResponseBytes: 100,
    });
    const meta = await client.readMeta();
    expect(meta).toEqual({ ok: false, code: 'RESPONSE_TOO_LARGE' });
  });

  it('缺时区/非法元数据响应体 → BAD_RESPONSE（不会误判为接受）', async () => {
    const transport = makeTransport(() => ({ status: 200, headers: {}, body: 'not-json' }));
    const client = createMobileReadonlyRemoteClient({ credentials: { target: TARGET, token: TOKEN }, transport });
    expect(await client.readMeta()).toEqual({ ok: false, code: 'BAD_RESPONSE' });
  });

  it('默认真实事件传输：正常完成返回原始 HTTP 响应（https 请求选项/方法/路径/Bearer 正确，TLS 由 node 默认）', async () => {
    const harness = createHttpHarness(1000);
    const meta = metaOf({ contentGenerationId: 'g-1', businessRevision: 2 });
    const promise = harness.transport({
      method: 'GET',
      url: `${TARGET}/api/meta`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(harness.calls).toHaveLength(1);
    const { options, request } = harness.calls[0];
    expect(options.protocol).toBe('https:');
    expect(options.hostname).toBe('publish.example.com');
    expect(options.path).toBe('/api/meta');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const response = harness.respond(200, meta);
    response.finish();
    const result = await promise;
    expect(result.status).toBe(200);
    expect(result.body).toBe(JSON.stringify(meta));
    expect(request.destroyed).toBe(false);
    // end 先于 deadline：计时器清理；推进远超时限也不再有动作。
    expect(harness.timersPending()).toBe(0);
    harness.advance(5000);
  });

  it('默认真实传输是「总时限」而非空闲超时：数据持续滴答跨过时限仍终止并归一 TIMEOUT', async () => {
    const harness = createHttpHarness(1000);
    const promise = harness.transport({
      method: 'GET',
      url: `${TARGET}/api/meta`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const response = harness.respond(200); // 有响应头但 body 永不结束（慢速服务器）

    // 数据在总时限内持续滴答到达（若只是 socket 空闲超时则不会触发）。
    harness.advance(300);
    response.pushData('a');
    harness.advance(300);
    response.pushData('b');
    harness.advance(300);
    response.pushData('c'); // 累计 900ms，数据仍在流动
    harness.advance(200); // 到达请求开始后 1000ms → 到期销毁并 TIMEOUT

    expect(harness.requestDestroyed()).toBe(true);
    await expect(promise).rejects.toThrow('TIMEOUT');
  });
});
