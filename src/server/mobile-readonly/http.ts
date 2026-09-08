import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { MobileReadonlyPublishMetadata, MobileReadonlyPublishResult, MobileReadonlyRecordKind } from '../../shared/mobile-readonly';
import type { ProjectStatus } from '../../shared/ipc';
import { uploadTokenMatchesAsync, viewerMatchesAsync, type MobileReadonlyCredentialsFile } from './credentials';
import { validateUploadBody } from './protocol';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_CURSOR_LENGTH,
  MAX_FILTER_VALUE_LENGTH,
  MAX_PAGE_LIMIT,
  MOBILE_READONLY_FILTERABLE_STATUSES,
  MOBILE_READONLY_QUERYABLE_KINDS,
  buildProjectDetail,
  buildProjectListPage,
  buildRecordsPage,
  decodeCursor,
  type MobileReadonlyOverviewData,
} from './query';
import { envelopeMetadata, type EnvelopeStore } from './store';

/**
 * 云端轻量只读服务 HTTP 层（tasks 7.2/7.4/7.5）。
 *
 * - 双凭证隔离：页面/资产与全部业务端点要求查看 Basic；PUT /api/publish 与 GET /api/meta
 *   仅接受独立上传 Bearer token；不做模糊的双层 Basic。
 * - 全部响应（含静态页与错误）带 `Cache-Control: no-store`；请求体/URL/参数有界；
 *   上传中断绝不提交；响应与错误不泄漏内部堆栈/请求体/密钥。
 * - 静态资产仅来自构建产物 web 目录，拒绝路径穿越；绝不暴露 snapshots 目录。
 */

export interface MobileReadonlyHttpDeps {
  store: EnvelopeStore;
  credentials: MobileReadonlyCredentialsFile;
  /** 手机静态入口目录；null = 仅内建页模板、无文件资产。 */
  webRoot: string | null;
  maxBodyBytes: number;
  maxUrlLength: number;
  requestTimeoutMs: number;
  /** 请求路径凭证校验并发上限（活动校验达上限即 503，零排队；默认 4）。 */
  authMaxActive?: number;
  /** 可注入校验器（默认基于 credentials 的异步 scrypt；测试注入受控假实现）。 */
  authVerifier?: MobileReadonlyAuthVerifier;
}

/** 请求路径异步凭证校验器（Bearer/Basic 均走同一有界 gate）。 */
export interface MobileReadonlyAuthVerifier {
  verifyUploadToken(token: string): Promise<boolean>;
  verifyViewer(username: string, password: string): Promise<boolean>;
}

/** 默认异步校验器：基于凭证摘要做恒时 scrypt 校验。 */
export function createCredentialsAuthVerifier(credentials: MobileReadonlyCredentialsFile): MobileReadonlyAuthVerifier {
  return {
    verifyUploadToken: (token) => uploadTokenMatchesAsync(credentials, token),
    verifyViewer: (username, password) => viewerMatchesAsync(credentials, username, password),
  };
}

export const MOBILE_READONLY_AUTH_MAX_ACTIVE_DEFAULT = 4;

const BASIC_REALM = 'mobile-readonly';
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/** 内建页模板：引用 `/app.js`，含 `#root` 挂载点（与 mobile lane 的 index.html 结构一致）。 */
const BUILTIN_INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="color-scheme" content="light">',
  '<title>搬迁服务 · 只读工作台</title>',
  '</head>',
  '<body style="margin:0;background:#f4f6f8">',
  '<div id="root"></div>',
  '<noscript>本页面需要启用 JavaScript 才能加载只读数据。此页面不提供离线数据。</noscript>',
  '<script src="/app.js"></script>',
  '</body>',
  '</html>',
].join('\n');

/** 服务端错误：携带 HTTP 状态 + 规范化错误码 + 安全文案（无堆栈/请求体回显）。 */
export class MobileReadonlyHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly metadata?: MobileReadonlyPublishMetadata;
  readonly issues?: readonly { path: string; code: string; message: string }[];

  constructor(status: number, code: string, message: string, extras?: { metadata?: MobileReadonlyPublishMetadata; issues?: readonly { path: string; code: string; message: string }[] }) {
    super(message);
    this.name = 'MobileReadonlyHttpError';
    this.status = status;
    this.code = code;
    this.metadata = extras?.metadata;
    this.issues = extras?.issues;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, JSON_HEADERS);
  res.end(payload);
}

function writeError(res: ServerResponse, error: MobileReadonlyHttpError): void {
  const body: Record<string, unknown> = {
    error: { code: error.code, message: error.message },
  };
  if (error.issues !== undefined) body.error = { code: error.code, message: error.message, issues: error.issues };
  if (error.metadata !== undefined) body.metadata = error.metadata;
  sendJson(res, error.status, body);
}

function sendUnauthorized(res: ServerResponse, scope: 'viewer' | 'upload'): void {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (scope === 'viewer') headers['WWW-Authenticate'] = `Basic realm="${BASIC_REALM}"`;
  res.writeHead(401, headers);
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '缺少或无效的访问凭证' } }));
}

function sendForbidden(res: ServerResponse): void {
  sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '该凭证无权访问此端点' } });
}

/** 解析请求认证（async：Bearer/Basic 的 scrypt 校验在受限 gate 内执行）；不合法/缺失返回 null。 */
async function authenticate(
  req: IncomingMessage,
  verifier: MobileReadonlyAuthVerifier,
): Promise<'viewer' | 'upload' | null> {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  if (bearer !== null) {
    try {
      return (await verifier.verifyUploadToken(bearer[1])) ? 'upload' : null;
    } catch {
      return null; // 校验内部异常按「无效凭证」处理，绝不 500 也不回显细节
    }
  }
  const basic = /^Basic\s+(\S+)$/i.exec(header);
  if (basic !== null) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    try {
      return (await verifier.verifyViewer(username, password)) ? 'viewer' : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? '/';
  try {
    return new URL(raw, 'http://mobile-readonly.local');
  } catch {
    return null;
  }
}

/** 参数键白名单：仅接受声明的参数，其余一律 400（严格、可预期）。 */
function requireOnlyParams(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', `不支持的查询参数：${key.length > 20 ? '…' : key}`);
    }
  }
}

function readRequiredParam(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null || value.length === 0 || value.length > MAX_FILTER_VALUE_LENGTH) {
    throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', `缺少或超长参数：${key}`);
  }
  return value;
}

function readOptionalParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  // 空字符串视为未提供（手机固定发送 query=&status=&region=&cursor=&limit=20 形式）。
  if (value === null || value.length === 0) return null;
  if (value.length > MAX_FILTER_VALUE_LENGTH) {
    throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', `参数超长：${key}`);
  }
  return value;
}

function readLimitParam(url: URL): number {
  const value = url.searchParams.get('limit');
  if (value === null || value.length === 0) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(value)) throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', 'limit 必须为十进制整数');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', `limit 必须在 1..${MAX_PAGE_LIMIT} 之间`);
  }
  return limit;
}

/** 读游标并做版本绑定：过期版本一律 409 STALE_CURSOR（随响应返回当前元数据）。 */
function readBoundCursor(url: URL, currentVersion: number, store: EnvelopeStore): number | null {
  const raw = readOptionalParam(url, 'cursor');
  if (raw === null) return null;
  if (raw.length > MAX_CURSOR_LENGTH) throw new MobileReadonlyHttpError(400, 'INVALID_CURSOR', '游标超长');
  const decoded = decodeCursor(raw);
  if (decoded === null) throw new MobileReadonlyHttpError(400, 'INVALID_CURSOR', '游标格式非法');
  if (decoded.version !== currentVersion) {
    throw new MobileReadonlyHttpError(409, 'STALE_CURSOR', '数据版本已变化，请重新加载首页', {
      metadata: envelopeMetadata(store.currentEnvelope()),
    });
  }
  return decoded.offset;
}

/** 强制端点所需凭证作用域；不满足时写出 401/403 并返回 false（调用方必须立即 return）。 */
function enforceScope(scope: 'viewer' | 'upload' | null, res: ServerResponse, required: 'viewer' | 'upload'): boolean {
  if (scope === required) return true;
  if (scope === null) {
    sendUnauthorized(res, required);
    return false;
  }
  sendForbidden(res);
  return false;
}

// ---------------------------------------------------------------------------
// 请求体（PUT /api/publish）
// ---------------------------------------------------------------------------

type BodyReadOutcome =
  | { outcome: 'ok'; text: string }
  | { outcome: 'aborted' }
  | { outcome: 'tooLarge' };

function collectBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyReadOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        finish({ outcome: 'tooLarge' });
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      finish({ outcome: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    });
    // 客户端中断/连接错误/超时销毁：绝不提交任何内容。
    req.on('aborted', () => finish({ outcome: 'aborted' }));
    req.on('error', () => finish({ outcome: 'aborted' }));
    req.on('close', () => finish({ outcome: 'aborted' }));
  });
}

async function handlePublish(req: IncomingMessage, res: ServerResponse, deps: MobileReadonlyHttpDeps): Promise<void> {
  const contentType = req.headers['content-type'];
  if (contentType !== undefined && !/^application\/json(?:;|$)/i.test(contentType)) {
    throw new MobileReadonlyHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '上传请求体必须为 application/json');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > deps.maxBodyBytes) {
    throw new MobileReadonlyHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小上限');
  }
  const read = await collectBody(req, deps.maxBodyBytes);
  if (read.outcome === 'aborted') return; // 上传中断：不响应（连接已断）、绝不提交
  if (read.outcome === 'tooLarge') {
    throw new MobileReadonlyHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    throw new MobileReadonlyHttpError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
  const validation = validateUploadBody(parsed);
  if (!validation.ok) {
    if (validation.code === 'INVALID_SNAPSHOT') {
      throw new MobileReadonlyHttpError(422, 'INVALID_SNAPSHOT', validation.message, { issues: validation.issues });
    }
    throw new MobileReadonlyHttpError(400, 'INVALID_PROTOCOL', validation.message);
  }
  const outcome = await deps.store.publish({
    publicationId: validation.body.protocol.publicationId,
    expectedCurrentVersion: validation.body.protocol.expectedCurrentVersion,
    snapshot: validation.body.snapshot,
  });
  if (outcome.kind === 'committed') {
    const body: MobileReadonlyPublishResult = { result: 'committed', metadata: envelopeMetadata(outcome.envelope) };
    sendJson(res, 200, body);
    return;
  }
  if (outcome.kind === 'idempotent') {
    const body: MobileReadonlyPublishResult = { result: 'idempotent', metadata: envelopeMetadata(outcome.envelope) };
    sendJson(res, 200, body);
    return;
  }
  // conflict：版本不匹配，随响应返回当前元数据（不覆盖新快照）。
  const body: MobileReadonlyPublishResult = { result: 'conflict', metadata: envelopeMetadata(outcome.envelope) };
  sendJson(res, 409, body);
}

// ---------------------------------------------------------------------------
// 查询端点
// ---------------------------------------------------------------------------

function handleOverview(res: ServerResponse, store: EnvelopeStore): void {
  const envelope = store.currentEnvelope();
  const data: MobileReadonlyOverviewData = { overview: envelope === null ? null : envelope.snapshot.overview };
  sendJson(res, 200, { metadata: envelopeMetadata(envelope), data });
}

function handleProjects(url: URL, res: ServerResponse, store: EnvelopeStore): void {
  requireOnlyParams(url, ['query', 'status', 'region', 'cursor', 'limit']);
  // 空字符串可选参数（query=&status=&region=&cursor=）按缺失处理（readOptionalParam 已归一）。
  const query = readOptionalParam(url, 'query') ?? '';
  const statusRaw = readOptionalParam(url, 'status');
  if (statusRaw !== null && !(MOBILE_READONLY_FILTERABLE_STATUSES as readonly string[]).includes(statusRaw)) {
    throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', 'status 不是受控枚举值');
  }
  const region = readOptionalParam(url, 'region');
  const limit = readLimitParam(url);

  const envelope = store.currentEnvelope();
  const currentVersion = envelope === null ? 0 : envelope.currentVersion;
  const cursorOffset = readBoundCursor(url, currentVersion, store);
  const snapshot = envelope === null ? null : envelope.snapshot;
  const data = buildProjectListPage(snapshot, currentVersion, {
    query,
    status: statusRaw as ProjectStatus | null,
    region,
    offset: cursorOffset,
    limit,
  });
  sendJson(res, 200, { metadata: envelopeMetadata(envelope), data });
}

function handleProject(url: URL, res: ServerResponse, store: EnvelopeStore): void {
  requireOnlyParams(url, ['id']);
  const id = readRequiredParam(url, 'id');
  const envelope = store.currentEnvelope();
  const data = buildProjectDetail(envelope === null ? null : envelope.snapshot, id);
  sendJson(res, 200, { metadata: envelopeMetadata(envelope), data });
}

function handleRecords(url: URL, res: ServerResponse, store: EnvelopeStore): void {
  requireOnlyParams(url, ['projectId', 'kind', 'cursor', 'limit']);
  const projectId = readRequiredParam(url, 'projectId');
  const kind = readRequiredParam(url, 'kind');
  if (!(MOBILE_READONLY_QUERYABLE_KINDS as readonly string[]).includes(kind)) {
    throw new MobileReadonlyHttpError(400, 'INVALID_QUERY', 'kind 不是受控记录类别');
  }
  const limit = readLimitParam(url);

  const envelope = store.currentEnvelope();
  const currentVersion = envelope === null ? 0 : envelope.currentVersion;
  const cursorOffset = readBoundCursor(url, currentVersion, store);
  const snapshot = envelope === null ? null : envelope.snapshot;
  const data = buildRecordsPage(snapshot, currentVersion, {
    projectId,
    kind: kind as MobileReadonlyRecordKind,
    offset: cursorOffset,
    limit,
  });
  sendJson(res, 200, { metadata: envelopeMetadata(envelope), data });
}

// ---------------------------------------------------------------------------
// 静态资产（查看 Basic 保护；路径穿越拒绝；绝不暴露 snapshots 目录）
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 解析 web 目录内文件：拒绝 `..`/`.`/隐藏段与符号链接逃逸。 */
function resolveWebFile(webRoot: string, pathname: string): string | null {
  if (pathname.includes('\0')) return null;
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment.startsWith('.')) return null;
  }
  const target = join(webRoot, ...segments);
  const rel = relative(webRoot, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(webRoot);
    targetReal = realpathSync(target);
  } catch {
    return null;
  }
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) return null;
  return targetReal;
}

function sendStaticFile(res: ServerResponse, filePath: string, isHead: boolean, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new MobileReadonlyHttpError(404, 'NOT_FOUND', '资源不存在');
  }
  if (size > maxBytes) {
    throw new MobileReadonlyHttpError(413, 'PAYLOAD_TOO_LARGE', '静态资源超过大小上限');
  }
  const extension = filePath.slice(filePath.lastIndexOf('.')); // 取最后一个点后的扩展名
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
  let body: Buffer | undefined;
  if (!isHead) {
    try {
      body = readFileSync(filePath);
    } catch {
      // stat 与 read 之间的竞态删除：按不存在处理（404），绝不 500。
      throw new MobileReadonlyHttpError(404, 'NOT_FOUND', '资源不存在');
    }
  }
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': size,
  };
  res.writeHead(200, headers);
  res.end(body);
}

function sendIndexHtml(res: ServerResponse, deps: MobileReadonlyHttpDeps, isHead: boolean): void {
  const webRoot = deps.webRoot;
  if (webRoot !== null) {
    const indexFile = resolveWebFile(webRoot, '/index.html');
    if (indexFile !== null) {
      sendStaticFile(res, indexFile, isHead, deps.maxBodyBytes);
      return;
    }
  }
  // 内建模板回退：头部值一律非 undefined（避免 writeHead 校验失败产生 500）。
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (isHead) headers['Content-Length'] = String(Buffer.byteLength(BUILTIN_INDEX_HTML, 'utf8'));
  const body = isHead ? undefined : BUILTIN_INDEX_HTML;
  res.writeHead(200, headers);
  res.end(body);
}

function handleStatic(pathname: string, res: ServerResponse, deps: MobileReadonlyHttpDeps, isHead: boolean): void {
  if (pathname === '/index.html' || pathname === '/') {
    sendIndexHtml(res, deps, isHead);
    return;
  }
  const webRoot = deps.webRoot;
  if (webRoot === null) {
    throw new MobileReadonlyHttpError(404, 'NOT_FOUND', '资源不存在');
  }
  const filePath = resolveWebFile(webRoot, pathname);
  if (filePath === null) {
    throw new MobileReadonlyHttpError(404, 'NOT_FOUND', '资源不存在');
  }
  sendStaticFile(res, filePath, isHead, deps.maxBodyBytes);
}

// ---------------------------------------------------------------------------
// 主监听器
// ---------------------------------------------------------------------------

/** 创建 HTTP/HTTPS 共用请求监听器（全部响应 no-store；双凭证隔离；错误有界；auth 有界并发）。 */
export function createRequestHandler(deps: MobileReadonlyHttpDeps): RequestListener {
  const authVerifier = deps.authVerifier ?? createCredentialsAuthVerifier(deps.credentials);
  const maxAuthActive = Math.max(1, deps.authMaxActive ?? MOBILE_READONLY_AUTH_MAX_ACTIVE_DEFAULT);
  let authActive = 0;
  /** 零排队有界信号量：满员返回 null（调用方立即 503），成功返回释放函数。 */
  const acquireAuth = (): (() => void) | null => {
    if (authActive >= maxAuthActive) return null;
    authActive += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      authActive -= 1;
    };
  };
  return (req, res) => {
    void handleRequest(req, res, deps, acquireAuth, authVerifier);
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MobileReadonlyHttpDeps,
  acquireAuth: () => (() => void) | null,
  authVerifier: MobileReadonlyAuthVerifier,
): Promise<void> {
  // 有限整体超时：超时销毁连接（含 auth 校验进行中），绝不落半写（collectBody 以 aborted 收敛）。
  const timer = setTimeout(() => {
    if (!res.writableEnded) res.destroy();
    req.destroy();
  }, deps.requestTimeoutMs);
  res.on('close', () => clearTimeout(timer));
  res.on('finish', () => clearTimeout(timer));

  try {
    const rawUrl = req.url ?? '/';
    if (rawUrl.length > deps.maxUrlLength) {
      throw new MobileReadonlyHttpError(414, 'URI_TOO_LONG', '请求 URL 过长');
    }
    const url = readUrl(req);
    if (url === null) {
      throw new MobileReadonlyHttpError(400, 'BAD_REQUEST', '请求 URL 非法');
    }
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // 有界 auth 信号量：超过并发上限立即 503（零等待/零排队），绝不堆积 scrypt 线程池工作。
    const ticket = acquireAuth();
    if (ticket === null) {
      sendJson(res, 503, { error: { code: 'AUTH_BUSY', message: '凭证校验繁忙，请稍后重试' } });
      return;
    }
    let scope: 'viewer' | 'upload' | null = null;
    try {
      scope = await authenticate(req, authVerifier);
    } finally {
      ticket();
    }
    // 校验期间连接已被整体超时/客户端中止销毁：忽略迟到结果，绝不在已结束响应上再发送。
    if (res.writableEnded || res.destroyed) return;

    const isUploadRoute = pathname === '/api/publish' || pathname === '/api/meta';
    if (isUploadRoute) {
      if (!enforceScope(scope, res, 'upload')) return;
      if (pathname === '/api/meta') {
        if (method !== 'GET') {
          throw new MobileReadonlyHttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
        }
        sendJson(res, 200, deps.store.currentMetadata());
        return;
      }
      // /api/publish
      if (method !== 'PUT') {
        throw new MobileReadonlyHttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 PUT');
      }
      await handlePublish(req, res, deps);
      return;
    }

    // 其余一切（业务查询 + 静态页面/资产）要求查看 Basic。
    if (!enforceScope(scope, res, 'viewer')) return;

    if (pathname.startsWith('/api/')) {
      if (method !== 'GET') {
        throw new MobileReadonlyHttpError(405, 'METHOD_NOT_ALLOWED', '该端点仅支持 GET');
      }
      switch (pathname) {
        case '/api/overview':
          handleOverview(res, deps.store);
          return;
        case '/api/projects':
          handleProjects(url, res, deps.store);
          return;
        case '/api/project':
          handleProject(url, res, deps.store);
          return;
        case '/api/records':
          handleRecords(url, res, deps.store);
          return;
        default:
          throw new MobileReadonlyHttpError(404, 'NOT_FOUND', '接口不存在');
      }
    }

    if (method !== 'GET' && method !== 'HEAD') {
      throw new MobileReadonlyHttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET/HEAD');
    }
    handleStatic(pathname, res, deps, method === 'HEAD');
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof MobileReadonlyHttpError) {
      writeError(res, error);
      // 请求体未消费完（超限/超长等）时该连接不能安全复用：响应后立即断开，防止残留字节被当新请求解析。
      if (!req.complete && (error.status === 413 || error.status === 414 || error.status === 415)) {
        res.on('finish', () => req.destroy());
      }
      return;
    }
    // 意外错误：不向客户端泄漏堆栈/请求体；日志只给规范化错误（无业务内容/密钥）。
    if (!res.writableEnded) {
      const safeMessage = error instanceof Error && error.message.length > 0 ? error.message : '未知错误';
      writeError(res, new MobileReadonlyHttpError(500, 'INTERNAL', `服务器内部错误：${safeMessage.slice(0, 80)}`));
    }
  }
}
