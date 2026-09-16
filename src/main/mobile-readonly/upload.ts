import { request as nodeHttpsRequest } from 'node:https';
import type {
  MobileReadonlyPublishMetadata,
  MobileReadonlyPublishResult,
  MobileReadonlyUploadBody,
} from '../../shared/mobile-readonly';
import { UNPUBLISHED_MOBILE_READONLY_METADATA } from '../../shared/mobile-readonly';
import {
  MOBILE_READONLY_REMOTE_CODES,
  type MobileReadonlyRemoteCode,
} from './errors';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyPublishOutcome,
  MobileReadonlyRemote,
  MobileReadonlyRemoteCredentials,
  MobileReadonlyRemoteFactory,
} from './remote';

/**
 * HTTPS 上传/元数据客户端（design D3/D6）。
 *
 * - 固定 HTTPS 目标（{target}/api/publish、{target}/api/meta）；
 * - TLS 正常校验（保持 node:https 默认 rejectUnauthorized=true）、禁止跟随重定向；
 * - 有限超时（timeoutMs）与响应体上限（maxResponseBytes），超限按规范化码失败；
 * - 上传请求体 {protocol, snapshot} 分层（protocol 字段不进业务白名单判定）；
 * - 传输函数可注入（单测用假传输；真实默认 node:https 仅在主进程侧使用）。
 */

export interface MobileReadonlyHttpRequest {
  method: 'GET' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MobileReadonlyHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type MobileReadonlyHttpTransport = (
  request: MobileReadonlyHttpRequest,
) => Promise<MobileReadonlyHttpResponse>;

/** 可注入的底层请求对象最小事件面（默认真实 node:https ClientRequest）。 */
export interface MobileReadonlyHttpClientRequestLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  write(chunk: string): void;
  end(): void;
  destroy(): void;
}

/** 可注入的响应对象最小事件面（默认真实 IncomingMessage）。 */
export interface MobileReadonlyHttpResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  destroy(): void;
}

export interface MobileReadonlyHttpsTransportOverrides {
  /**
   * 底层 HTTPS 请求实现。默认 node:https.request（保持 TLS 默认校验 rejectUnauthorized=true、
   * 不自动跟随重定向）；仅单测注入事件假件——生产路径从不传入。
   */
  request?: (
    options: {
      protocol: string;
      hostname: string;
      port?: number;
      path: string;
      method: string;
      headers: Record<string, string>;
    },
    responseListener: (response: MobileReadonlyHttpResponseLike) => void,
  ) => MobileReadonlyHttpClientRequestLike;
  /** 总时限计时器（默认 setTimeout/clearTimeout）；单测注入可控时钟证明「总时限」而非空闲超时。 */
  scheduleTimeout?: (callback: () => void, delayMs: number) => { cancel(): void };
}

export interface MobileReadonlyRemoteClientOptions {
  credentials: MobileReadonlyRemoteCredentials;
  /** 默认 node:https 真实传输；测试注入假传输。 */
  transport?: MobileReadonlyHttpTransport;
  /** 单请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 响应体字节上限。 */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * node:https 真实传输：TLS 默认校验、不自动跟随重定向、有限响应体上限。
 * 超时是**自请求开始的总体时限**（到期销毁底层请求并归一为 TIMEOUT），
 * 不是 `req.setTimeout` 的 socket 空闲超时——防止慢速服务器以数据滴答无限拖延。
 */
export function createDefaultHttpsTransport(
  options: { timeoutMs?: number; maxResponseBytes?: number } & MobileReadonlyHttpsTransportOverrides = {},
): MobileReadonlyHttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requestImpl =
    options.request ??
    ((requestOptions, responseListener) => {
      const req = nodeHttpsRequest(
        requestOptions as unknown as Parameters<typeof nodeHttpsRequest>[0],
        (res) => responseListener(res as unknown as MobileReadonlyHttpResponseLike),
      );
      return req as unknown as MobileReadonlyHttpClientRequestLike;
    });
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return { cancel: () => clearTimeout(handle) };
    });

  return (request) =>
    new Promise<MobileReadonlyHttpResponse>((resolve, reject) => {
      const url = new URL(request.url);
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      let settled = false;
      let timer: { cancel(): void } | null = null;

      const cleanup = (): void => {
        if (timer !== null) {
          timer.cancel();
          timer = null;
        }
      };
      const fail = (code: MobileReadonlyRemoteCode): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(code));
      };
      const succeed = (response: MobileReadonlyHttpResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };

      const req = requestImpl(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: request.headers,
        },
        (res) => {
          res.on('data', (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            total += buffer.length;
            if (total > maxResponseBytes) {
              aborted = true;
              res.destroy();
              fail(MOBILE_READONLY_REMOTE_CODES.RESPONSE_TOO_LARGE);
              return;
            }
            chunks.push(buffer);
          });
          res.on('end', () => {
            if (settled || aborted) return;
            succeed({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', () => {
            if (aborted) return;
            fail(MOBILE_READONLY_REMOTE_CODES.NETWORK_ERROR);
          });
        },
      );

      // 总时限：请求开始时即启动，到期销毁请求并归一为 TIMEOUT；所有退出路径都会清理计时器。
      timer = scheduleTimeout(() => {
        try {
          req.destroy();
        } catch {
          // 底层销毁失败不影响时限结论
        }
        fail(MOBILE_READONLY_REMOTE_CODES.TIMEOUT);
      }, timeoutMs);

      req.on('error', () => {
        // 请求级网络错误（连接拒绝/DNS/TLS 等）统一为 NETWORK_ERROR；
        // 超时分支已 settle，此回调不会改写已定结果。
        fail(MOBILE_READONLY_REMOTE_CODES.NETWORK_ERROR);
      });
      if (request.body !== undefined) {
        req.write(request.body);
      }
      req.end();
    });
}

/**
 * 创建远程客户端。transport 未注入时使用 node:https 真实传输
 * （仅由主进程接线层在运行时构造；headless 测试总是注入假传输）。
 */
export function createMobileReadonlyRemoteClient(
  options: MobileReadonlyRemoteClientOptions,
): MobileReadonlyRemote {
  const { credentials } = options;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const transport = options.transport ?? createDefaultHttpsTransport({ timeoutMs: options.timeoutMs, maxResponseBytes });
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${credentials.token}`,
    'Content-Type': 'application/json',
  };

  function isOversized(bodyLength: number): boolean {
    return bodyLength > maxResponseBytes;
  }

  return {
    async readMeta(): Promise<MobileReadonlyMetaResult> {
      const response = await runTransport(transport, {
        method: 'GET',
        url: `${credentials.target}/api/meta`,
        headers: { Authorization: authHeaders.Authorization },
      });
      if (!response.ok) {
        return { ok: false, code: response.code };
      }
      if (isOversized(response.response.body.length)) {
        return { ok: false, code: MOBILE_READONLY_REMOTE_CODES.RESPONSE_TOO_LARGE };
      }
      if (response.response.status === 200) {
        const metadata = parseMetadata(response.response.body);
        return metadata ? { ok: true, metadata } : { ok: false, code: MOBILE_READONLY_REMOTE_CODES.BAD_RESPONSE };
      }
      if (response.response.status === 401 || response.response.status === 403) {
        return { ok: false, code: MOBILE_READONLY_REMOTE_CODES.UNAUTHORIZED };
      }
      return { ok: false, code: mapHttpFailure(response.response.status) };
    },
    async upload(body: MobileReadonlyUploadBody): Promise<MobileReadonlyPublishOutcome> {
      const response = await runTransport(transport, {
        method: 'PUT',
        url: `${credentials.target}/api/publish`,
        headers: authHeaders,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return { kind: 'transport', code: response.code };
      }
      if (isOversized(response.response.body.length)) {
        return { kind: 'transport', code: MOBILE_READONLY_REMOTE_CODES.RESPONSE_TOO_LARGE };
      }
      const status = response.response.status;
      if (status >= 200 && status < 300) {
        return { kind: 'accepted' };
      }
      if (status === 409) {
        // wire：409 响应体为 { result: 'conflict', metadata } 信封；裸元数据（旧/错位形状）一律拒绝。
        const publishResult = parsePublishResult(response.response.body);
        if (publishResult === null || publishResult.result !== 'conflict') {
          return { kind: 'transport', code: MOBILE_READONLY_REMOTE_CODES.BAD_RESPONSE };
        }
        return { kind: 'conflict', metadata: publishResult.metadata };
      }
      if (status === 401 || status === 403) {
        return { kind: 'rejected', code: MOBILE_READONLY_REMOTE_CODES.UNAUTHORIZED };
      }
      if (status >= 400 && status < 500) {
        return { kind: 'rejected', code: MOBILE_READONLY_REMOTE_CODES.UPLOAD_REJECTED };
      }
      // 3xx/5xx：结果不确定（不跟随重定向、服务端错误）→ transport 分支，走元数据恢复。
      return { kind: 'transport', code: mapHttpFailure(status) };
    },
  };
}

export function createDefaultRemoteFactory(
  options: Pick<MobileReadonlyRemoteClientOptions, 'timeoutMs' | 'maxResponseBytes'> = {},
): MobileReadonlyRemoteFactory {
  const transport = createDefaultHttpsTransport(options);
  return (credentials) => createMobileReadonlyRemoteClient({ credentials, transport });
}

type TransportRunResult =
  | { ok: true; response: MobileReadonlyHttpResponse }
  | { ok: false; code: string };

/** 传输层内部规范化码白名单：只透传这些码，其它任意文本（可能含远端/token 内容）一律 NETWORK_ERROR。 */
const INTERNAL_TRANSPORT_CODES: ReadonlySet<string> = new Set(Object.values(MOBILE_READONLY_REMOTE_CODES));

async function runTransport(
  transport: MobileReadonlyHttpTransport,
  request: MobileReadonlyHttpRequest,
): Promise<TransportRunResult> {
  try {
    const response = await transport(request);
    return { ok: true, response };
  } catch (error) {
    // 统一为规范化码；上层不接触原始网络错误细节（不记录任意服务响应/网络内容）。
    const message = error instanceof Error ? error.message : '';
    const code =
      message !== '' && INTERNAL_TRANSPORT_CODES.has(message)
        ? message
        : MOBILE_READONLY_REMOTE_CODES.NETWORK_ERROR;
    return { ok: false, code };
  }
}

function mapHttpFailure(status: number): MobileReadonlyRemoteCode {
  if (status >= 300 && status < 400) return MOBILE_READONLY_REMOTE_CODES.REDIRECT_REFUSED;
  if (status >= 500) return MOBILE_READONLY_REMOTE_CODES.SERVER_ERROR;
  return MOBILE_READONLY_REMOTE_CODES.BAD_RESPONSE;
}

/** 解析 /api/meta 响应体（裸元数据 JSON；最小形状校验；不展开业务快照）。 */
function parseMetadata(text: string): MobileReadonlyPublishMetadata | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parseMetadataObject(parsed);
  } catch {
    return null;
  }
}

/**
 * 解析 PUT /api/publish 响应体信封（wire）：{ result: 'committed'|'idempotent'|'conflict', metadata }。
 * 409 分支要求 result === 'conflict' 且 metadata 形状合法；不做裸元数据的双形兼容。
 */
function parsePublishResult(text: string): MobileReadonlyPublishResult | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as { result?: unknown; metadata?: unknown };
    if (value.result !== 'committed' && value.result !== 'idempotent' && value.result !== 'conflict') {
      return null;
    }
    const metadata = parseMetadataObject(value.metadata);
    return metadata === null ? null : { result: value.result, metadata };
  } catch {
    return null;
  }
}

function parseMetadataObject(value: unknown): MobileReadonlyPublishMetadata | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as {
    published?: unknown;
    currentVersion?: unknown;
    publicationId?: unknown;
    publishedAt?: unknown;
    dataAsOf?: unknown;
    fingerprint?: unknown;
  };
  if (typeof candidate.published !== 'boolean') return null;
  if (
    typeof candidate.currentVersion !== 'number' ||
    !Number.isInteger(candidate.currentVersion) ||
    candidate.currentVersion < 0
  ) {
    return null;
  }
  const fingerprint =
    candidate.fingerprint === null
      ? null
      : isValidFingerprint(candidate.fingerprint)
        ? {
            contentGenerationId: candidate.fingerprint.contentGenerationId,
            businessRevision: candidate.fingerprint.businessRevision,
          }
        : null;
  const unpublished = !candidate.published && candidate.currentVersion === 0;
  if (unpublished && candidate.fingerprint === null) {
    return { ...UNPUBLISHED_MOBILE_READONLY_METADATA };
  }
  return {
    published: candidate.published,
    currentVersion: candidate.currentVersion,
    publicationId: nullableString(candidate.publicationId),
    publishedAt: nullableString(candidate.publishedAt),
    dataAsOf: nullableString(candidate.dataAsOf),
    fingerprint,
  };
}

function isValidFingerprint(value: unknown): value is { contentGenerationId: string; businessRevision: number } {
  if (typeof value !== 'object' || value === null) return false;
  const fp = value as { contentGenerationId?: unknown; businessRevision?: unknown };
  return typeof fp.contentGenerationId === 'string' && typeof fp.businessRevision === 'number';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
