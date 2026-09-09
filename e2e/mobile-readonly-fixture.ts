import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as nodeHttpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  type Browser,
  type BrowserContext,
  type Clock,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { MobileReadonlyCredentialsFile } from '../src/server/mobile-readonly/credentials';
import { generateCredentialsFile } from '../src/server/mobile-readonly/credentials';
import type { MobileReadonlyServiceConfig } from '../src/server/mobile-readonly/config';
import type { RunningMobileReadonlyService } from '../src/server/mobile-readonly/service';
import { startMobileReadonlyService } from '../src/server/mobile-readonly/service';
import type { ProjectStatus } from '../src/shared/ipc';
import type { MobileReadonlyOverview, MobileReadonlySnapshot } from '../src/shared/mobile-readonly';

/**
 * 移动只读 E2E 共享夹具（tasks 6.5 / 8.1-8.3）。
 *
 * - 真实服务：以 `tests/server/fixtures/tls` 的测试证书直接 HTTPS 运行
 *   `startMobileReadonlyService`（服务源码导入，数据/凭证均为合成临时目录）；
 * - 证书策略：桌面发布主进程在「真实打包 Electron 主进程」内把测试 CA 注入
 *   node:https 全局 agent（`process.getBuiltinModule('node:https')`），保持默认证书
 *   校验、不设 rejectUnauthorized:false / NODE_TLS_REJECT_UNAUTHORIZED；
 *   Chromium 端仅以 `--ignore-certificate-errors-spki-list=<测试证书 SPKI>` 精确放行
 *   本夹具证书（见 playwright.mobile-readonly.config.ts），不断言其它证书。
 * - 桌面 E2E 时钟：`WORKBENCH_E2E_MOBILE_READONLY` + 临时目录
 *   `WORKBENCH_E2E_USER_DATA_DIR` 双闸门满足时才由主进程接线创建
 *   `__workbenchMobileReadonlyE2EClock` 全局；本模块只暴露 advance/now/pending，
 *   绝不触发 checkNow（周期调度自然执行真实引擎逻辑）。
 * - 合成数据：require `scripts/mobile-readonly-synthetic.cjs`（仅脱敏合成快照）。
 */

declare function require(id: string): unknown;

const product = '搬迁服务工作台';
const packagedFolder = `${product}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
export const MOBILE_READONLY_APP_EXECUTABLE = join(
  process.cwd(),
  'out',
  packagedFolder,
  `${product}.app`,
  'Contents',
  'MacOS',
  product,
);

export const MOBILE_WEB_ROOT = join(process.cwd(), 'dist', 'mobile-readonly', 'web');
export const TLS_CERT_FILE = join(process.cwd(), 'tests', 'server', 'fixtures', 'tls', 'cert.pem');
export const TLS_KEY_FILE = join(process.cwd(), 'tests', 'server', 'fixtures', 'tls', 'key.pem');

/** 本地合成凭证（仅测试；与真实生产凭证无任何关系，摘要落盘、不落明文）。 */
export const VIEWER_USERNAME = 'mobile-e2e-viewer';
export const VIEWER_PASSWORD = 'mobile-e2e-viewer-password-K9xT2';
export const UPLOAD_TOKEN = 'mobile-e2e-upload-token-b7Fq8wZ4';

/** 预算口径（design D8）：本地周期 ≤120s、手机相邻触发 ≤60s、其余环节合计 ≤120s、总 ≤5 分钟。 */
export const DESKTOP_PERIODIC_MS = 120_000;
export const MOBILE_CHECK_INTERVAL_MS = 60_000;
export const REMAINING_BUDGET_MS = 120_000;
export const TOTAL_VISIBLE_BUDGET_MS = 5 * 60_000;

/** 测试证书 SPKI（base64 sha256），供 Chromium `--ignore-certificate-errors-spki-list` 精确放行本夹具证书。 */
export function fixtureCertSpki(): string {
  const cert = new X509Certificate(readFileSync(TLS_CERT_FILE, 'utf8'));
  const der = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('base64');
}

/** 构建产物缺失即明确失败（不 skip），并给出构建命令。 */
export function assertMobileReadonlyBuildArtifacts(): void {
  const missing: string[] = [];
  for (const file of [MOBILE_READONLY_APP_EXECUTABLE, join(MOBILE_WEB_ROOT, 'index.html'), join(MOBILE_WEB_ROOT, 'app.js')]) {
    if (!existsSync(file)) missing.push(file);
  }
  if (missing.length > 0) {
    throw new Error(
      `移动只读 E2E 缺少必需构建产物：\n${missing.join('\n')}\n` +
        '请先执行 npm run build:mobile-readonly（产出 dist/mobile-readonly/web）与 npm run e2e:build（产出真实打包 Electron）。',
    );
  }
}

// ---------------------------------------------------------------------------
// 合成数据生成器类型包装（scripts/mobile-readonly-synthetic.cjs）
// ---------------------------------------------------------------------------

interface MobileReadonlySyntheticBuilder {
  SYNTHETIC: {
    viewerUsername: string;
    viewerPassword: string;
    uploadToken: string;
    publicationId: string;
    dataAsOf: string;
    contentGenerationId: string;
  };
  PROJECT_STATUSES: readonly string[];
  STAGE_STATUSES: readonly string[];
  ORDER_TYPES: readonly string[];
  REGIONS: readonly string[];
  buildSyntheticSnapshot(options?: { projectCount?: number; firstProjectRecords?: number }): MobileReadonlySnapshot;
  buildSyntheticUploadBody(options?: {
    projectCount?: number;
    firstProjectRecords?: number;
    publicationId?: string;
    expectedCurrentVersion?: number;
  }): { protocol: { publicationId: string; expectedCurrentVersion: number }; snapshot: MobileReadonlySnapshot };
}

export const syntheticBuilder = require('../scripts/mobile-readonly-synthetic.cjs') as MobileReadonlySyntheticBuilder;

/** 复制快照为可安全修改的普通对象（不共享 builder 内部结构）。 */
export function cloneSnapshot(snapshot: MobileReadonlySnapshot): MobileReadonlySnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MobileReadonlySnapshot;
}

/** 已发布空集合快照（design D10：合法空快照 ≠ 尚未发布；独立于 builder 制造）。 */
export function makeEmptyPublishedSnapshot(extra?: Partial<MobileReadonlySnapshot>): MobileReadonlySnapshot {
  const stages = syntheticBuilder.STAGE_STATUSES.map((status) => ({ status: status as ProjectStatus, count: 0, averageDays: 0 }));
  const overview: MobileReadonlyOverview = {
    metrics: { totalProjects: 0, activeProjects: 0, pendingAmount: '0.00', pendingAcceptance: 0, pendingInvoice: 0 },
    stages,
  };
  return {
    schemaVersion: 1,
    contentGenerationId: 'synthetic-empty-e2e-0001',
    businessRevision: 0,
    dataAsOf: '2026-08-08T09:00:00.000Z',
    overview,
    projects: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 本地 HTTPS 服务（真实服务源码 + 测试证书）
// ---------------------------------------------------------------------------

export interface FixtureMobileService {
  running: RunningMobileReadonlyService;
  baseUrl: string;
  dataDir: string;
  credentials: MobileReadonlyCredentialsFile;
  webRoot: string;
  close(): Promise<void>;
}

export interface StartFixtureServiceOptions {
  dataDir?: string;
  /** 固定 publishedAt 时钟（缺省系统时钟）。 */
  clockIso?: string;
  /** 固定监听端口（缺省 0=系统随机）。重启同一 dataDir 时必须传入原端口，
   *  保证 baseUrl/桌面已保存 target 不变（桌面不重建，只等自然周期触发）。 */
  port?: number;
}

export async function startFixtureMobileService(options: StartFixtureServiceOptions = {}): Promise<FixtureMobileService> {
  if (!existsSync(TLS_CERT_FILE) || !existsSync(TLS_KEY_FILE)) {
    throw new Error(`缺少测试证书夹具：${TLS_CERT_FILE}`);
  }
  if (!existsSync(join(MOBILE_WEB_ROOT, 'index.html')) || !existsSync(join(MOBILE_WEB_ROOT, 'app.js'))) {
    throw new Error(`缺少手机静态构建产物（dist/mobile-readonly/web）；请先执行 npm run build:mobile-readonly。`);
  }
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'mr-e2e-svc-'));
  const credentials = generateCredentialsFile(VIEWER_USERNAME, VIEWER_PASSWORD, UPLOAD_TOKEN);
  const credentialsFile = join(dataDir, 'credentials.json');
  writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
  const config: MobileReadonlyServiceConfig = {
    host: '127.0.0.1',
    port: options.port ?? 0,
    dataDir,
    credentialsFile,
    webRoot: MOBILE_WEB_ROOT,
    maxBodyBytes: 32 * 1024 * 1024,
    maxUrlLength: 8192,
    requestTimeoutMs: 10_000,
    headersTimeoutMs: 5_000,
    keepAliveTimeoutMs: 5_000,
    authMaxActive: 4,
    tls: { keyFile: TLS_KEY_FILE, certFile: TLS_CERT_FILE },
  };
  const clock =
    options.clockIso === undefined ? undefined : { nowIso: () => options.clockIso as string };
  const running = await startMobileReadonlyService({ config, webRoot: MOBILE_WEB_ROOT, clock });
  return {
    running,
    baseUrl: running.baseUrl,
    dataDir,
    credentials,
    webRoot: MOBILE_WEB_ROOT,
    close: async () => {
      await running.close();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响断言
      }
    },
  };
}

export async function closeFixtureService(service: FixtureMobileService): Promise<void> {
  await service.close();
}

// ---------------------------------------------------------------------------
// 测试进程内真实 HTTPS 请求（注入测试 CA；证书校验保持正常，只是自定义信任锚）
// ---------------------------------------------------------------------------

export interface HttpJsonResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpsJson(urlText: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpJsonResponse> {
  const url = new URL(urlText);
  const ca = readFileSync(TLS_CERT_FILE, 'utf8');
  return new Promise((resolve, reject) => {
    const req = nodeHttpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        ca,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function parseJson<T>(response: HttpJsonResponse): T {
  return JSON.parse(response.body) as T;
}

export async function uploadSnapshotHttp(
  baseUrl: string,
  body: { publicationId: string; expectedCurrentVersion: number; snapshot: MobileReadonlySnapshot },
): Promise<HttpJsonResponse> {
  return httpsJson(`${baseUrl}/api/publish`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPLOAD_TOKEN}` },
    body: JSON.stringify({ protocol: { publicationId: body.publicationId, expectedCurrentVersion: body.expectedCurrentVersion }, snapshot: body.snapshot }),
  });
}

/** GET /api/meta（上传凭证）：版本元数据；返回 null 表示解析失败。 */
export async function readMetaHttp(baseUrl: string): Promise<{
  published: boolean;
  currentVersion: number;
  publicationId: string | null;
  publishedAt: string | null;
  dataAsOf: string | null;
} | null> {
  const response = await httpsJson(`${baseUrl}/api/meta`, {
    headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
  });
  if (response.status !== 200) return null;
  const parsed = JSON.parse(response.body) as {
    published?: unknown;
    currentVersion?: unknown;
    publicationId?: unknown;
    publishedAt?: unknown;
    dataAsOf?: unknown;
  };
  if (typeof parsed.published !== 'boolean' || typeof parsed.currentVersion !== 'number') return null;
  return {
    published: parsed.published,
    currentVersion: parsed.currentVersion,
    publicationId: typeof parsed.publicationId === 'string' ? parsed.publicationId : null,
    publishedAt: typeof parsed.publishedAt === 'string' ? parsed.publishedAt : null,
    dataAsOf: typeof parsed.dataAsOf === 'string' ? parsed.dataAsOf : null,
  };
}

export async function queryProjectsHttp(
  baseUrl: string,
  query: { q?: string; status?: string; region?: string } = {},
): Promise<Array<{ id: string; tempNo: string; ecc: string | null; customerName: string; status: string; region: string | null }>> {
  const params = new URLSearchParams();
  if (query.q) params.set('query', query.q);
  if (query.status) params.set('status', query.status);
  if (query.region) params.set('region', query.region);
  params.set('limit', '100');
  const auth = `Basic ${Buffer.from(`${VIEWER_USERNAME}:${VIEWER_PASSWORD}`, 'utf8').toString('base64')}`;
  const response = await httpsJson(`${baseUrl}/api/projects?${params}`, { headers: { Authorization: auth } });
  if (response.status !== 200) throw new Error(`查询 /api/projects 失败：HTTP ${response.status}`);
  const parsed = parseJson<{ data: { items: Array<Record<string, unknown>> } }>(response);
  return parsed.data.items.map((item) => ({
    id: String(item.id),
    tempNo: String(item.tempNo),
    ecc: item.ecc === null ? null : String(item.ecc),
    customerName: String(item.customerName),
    status: String(item.status),
    region: item.region === null ? null : String(item.region),
  }));
}

/** 记录查询返回行（宽松行对象；批次行含 transportCompany，调用方按其业务类别取值）。 */
export async function queryRecordsHttp(baseUrl: string, projectId: string, kind: string): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams({ projectId, kind, limit: '100' });
  const auth = `Basic ${Buffer.from(`${VIEWER_USERNAME}:${VIEWER_PASSWORD}`, 'utf8').toString('base64')}`;
  const response = await httpsJson(`${baseUrl}/api/records?${params}`, { headers: { Authorization: auth } });
  if (response.status !== 200) throw new Error(`查询 /api/records 失败：HTTP ${response.status}`);
  const parsed = parseJson<{ data: { items: Array<Record<string, unknown>> } }>(response);
  return parsed.data.items;
}

// ---------------------------------------------------------------------------
// current.json 信封（磁盘真实读取）
// ---------------------------------------------------------------------------

export interface EnvelopeFileShape {
  currentVersion: number;
  publicationId: string;
  publishedAt: string;
  snapshot: MobileReadonlySnapshot;
}

export function readEnvelopeFile(dataDir: string): EnvelopeFileShape {
  const file = join(dataDir, 'snapshots', 'current.json');
  return JSON.parse(readFileSync(file, 'utf8')) as EnvelopeFileShape;
}

export function readEnvelopeFileBytes(dataDir: string): Buffer {
  return readFileSync(join(dataDir, 'snapshots', 'current.json'));
}

// ---------------------------------------------------------------------------
// 真实打包 Electron（双闸门时钟）
// ---------------------------------------------------------------------------

export interface LaunchedDesktopApp {
  app: ElectronApplication;
  userDataDir: string;
  root: string;
}

export async function launchMobileReadonlyElectron(): Promise<LaunchedDesktopApp> {
  assertMobileReadonlyBuildArtifacts();
  const root = mkdtempSync(join(tmpdir(), 'mr-e2e-desktop-'));
  const userDataDir = join(root, 'user-data');
  mkdirSync(userDataDir, { recursive: true });
  const app = await electron.launch({
    executablePath: MOBILE_READONLY_APP_EXECUTABLE,
    env: {
      ...process.env,
      WORKBENCH_E2E_MOBILE_READONLY: '1',
      WORKBENCH_E2E_USER_DATA_DIR: userDataDir,
    },
  });
  return { app, userDataDir, root };
}

export async function closeDesktopApp(launched: LaunchedDesktopApp): Promise<void> {
  try {
    await launched.app.close();
  } catch {
    // 关闭失败不影响清理
  }
  try {
    rmSync(launched.root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言
  }
}

/** 桌面主进程 E2E 时钟接口（仅这两个闸门满足时才存在；见 src/main/mobile-readonly/e2e-clock.ts）。 */
interface DesktopE2eClockGlobal {
  advance(ms: number): Promise<void>;
  now(): string;
  pending(): number;
}

/**
 * 推进桌面合成时钟并自然触发到期定时器（真实引擎周期，绝不触发 checkNow）。
 * advance 内部会冲刷多轮 setImmediate，但真实网络上传在其后继续，因此调用方随后应
 * 通过真实 HTTP /api/meta 或桌面状态面板轮询结果。
 */
export async function advanceDesktopClock(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(async ({}, value) => {
    const g = (globalThis as unknown as Record<string, unknown>).__workbenchMobileReadonlyE2EClock as
      | DesktopE2eClockGlobal
      | undefined;
    if (!g) {
      throw new Error(
        '主进程未安装移动只读 E2E 时钟：须同时满足 WORKBENCH_E2E_MOBILE_READONLY=1 与指向 OS 临时目录的 WORKBENCH_E2E_USER_DATA_DIR。',
      );
    }
    await g.advance(value);
  }, ms);
}

export async function desktopClockNow(app: ElectronApplication): Promise<string> {
  return app.evaluate(async () => {
    const g = (globalThis as unknown as Record<string, unknown>).__workbenchMobileReadonlyE2EClock as
      | DesktopE2eClockGlobal
      | undefined;
    if (!g) throw new Error('主进程未安装移动只读 E2E 时钟（双闸门）。');
    return g.now();
  });
}

export async function desktopClockPending(app: ElectronApplication): Promise<number> {
  return app.evaluate(async () => {
    const g = (globalThis as unknown as Record<string, unknown>).__workbenchMobileReadonlyE2EClock as
      | DesktopE2eClockGlobal
      | undefined;
    if (!g) throw new Error('主进程未安装移动只读 E2E 时钟（双闸门）。');
    return g.pending();
  });
}

export async function firstWorkbenchWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return window;
}

/** 把测试 CA 注入主进程 node:https 全局 agent（正常证书校验 + 自定义信任锚；非绕过）。 */
export async function trustFixtureCaInMainProcess(app: ElectronApplication): Promise<void> {
  const caPem = readFileSync(TLS_CERT_FILE, 'utf8');
  await app.evaluate(async (_electron, pem) => {
    const https = process.getBuiltinModule('node:https') as {
      globalAgent: { options: { ca?: Array<string | Buffer> } };
    };
    const agent = https.globalAgent;
    agent.options.ca = [...(agent.options.ca ?? []), pem];
    return true;
  }, caPem);
}

// ---------------------------------------------------------------------------
// 手机页面（真实服务 HTTPS + Basic Auth）
// ---------------------------------------------------------------------------

export interface OpenMobilePageResult {
  context: BrowserContext;
  page: Page;
  clock: Clock;
}

export async function openMobileReadonlyPage(
  browser: Browser,
  baseUrl: string,
  options: { width?: number; height?: number } = {},
): Promise<OpenMobilePageResult> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 390, height: options.height ?? 844 },
    httpCredentials: { username: VIEWER_USERNAME, password: VIEWER_PASSWORD },
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return { context, page, clock: page.clock };
}

export async function closeMobilePage(opened: OpenMobilePageResult): Promise<void> {
  try {
    await opened.context.close();
  } catch {
    // 关闭失败不影响清理
  }
}

// ---------------------------------------------------------------------------
// 桌面 UI 辅助（移动只读发布面板 / 项目表单 / 快速记录 / 详情编辑与删除）
// ---------------------------------------------------------------------------

export async function openPublishPanel(page: Page): Promise<Page> {
  await page.getByRole('button', { name: '数据管理', exact: true }).click();
  await page.getByRole('region', { name: '数据管理', exact: true }).getByRole('button', { name: '发布云端', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  await dialog.waitFor();
  return page;
}

export async function closePublishPanel(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  if (await dialog.count()) {
    await page.getByRole('button', { name: '关闭发布云端' }).click();
    await expectDialogClosed(dialog);
  }
}

async function expectDialogClosed(dialog: ReturnType<Page['getByRole']>): Promise<void> {
  await dialog.waitFor({ state: 'detached' });
}

/** 读取发布面板某一行的 dd 文本（如「配置情况 / 最近成功发布 / 最近失败」）。 */
export async function publishPanelField(page: Page, dtLabel: string): Promise<string> {
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  const dd = dialog.getByText(dtLabel, { exact: true }).locator('xpath=following-sibling::dd[1]');
  return ((await dd.textContent()) ?? '').trim();
}

/** 一次性配置（保存不会自动启用）。 */
export async function configurePublish(page: Page, target: string, token: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  await dialog.getByRole('button', { name: '配置发布' }).click();
  await dialog.getByLabel('HTTPS 服务地址').fill(target);
  await dialog.getByLabel('独立上传凭证').fill(token);
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await expect(dialog.getByText(/发布配置已保存/)).toBeVisible();
}

export async function clickEnablePublish(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  const enable = dialog.getByRole('button', { name: '启用发布' });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(dialog.getByText(/已启用发布，后续结果会显示在这里/)).toBeVisible();
}

export async function waitWorkbenchReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '把每一次搬迁，推进得更稳', exact: true })).toBeVisible();
}

/** 通过真实桌面 UI 新建正式进单项目。 */
export async function createFormalProject(
  page: Page,
  values: { customer: string; ecc: string; region?: string; amount?: string },
): Promise<void> {
  await page.getByRole('button', { name: '新建搬迁项目' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('客户名称').fill(values.customer);
  await dialog.getByLabel('区域').selectOption(values.region ?? 'East');
  await dialog.getByLabel('合同开始日期').fill('2026-08-01');
  await dialog.getByLabel('合同截止日期').fill('2027-07-31');
  await dialog.getByRole('radio', { name: /^正式进单/ }).check();
  await dialog.getByLabel(/^ECC/).fill(values.ecc);
  await dialog.getByLabel(/^进单日期/).fill('2026-08-01');
  await dialog.getByLabel('合同 USD 含税金额').fill(values.amount ?? '80000');
  await dialog.getByRole('button', { name: '正式进单' }).click();
  await expect(page.getByRole('heading', { name: '把每一次搬迁，推进得更稳', exact: true })).toBeVisible();
}

/** 当前选中项目是否已在详情面板出现（客户名作为详情标题）。 */
export async function expectProjectDetail(page: Page, customer: string): Promise<void> {
  await expect(page.getByText(customer, { exact: true }).first()).toBeVisible();
}

/** 通过真实桌面 UI 把选中项目的客户名称改名为新值（编辑项目资料）。 */
export async function renameProjectCustomer(page: Page, oldName: string, newName: string): Promise<void> {
  await page.getByRole('button', { name: '编辑项目资料' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('客户名称')).toHaveValue(oldName);
  await dialog.getByLabel('客户名称').fill(newName);
  await dialog.getByRole('button', { name: '保存项目资料' }).click();
  await expect(page.getByText(newName, { exact: true }).first()).toBeVisible();
}

/** 通过真实桌面 UI 快速记录一条物流费用登记（搬迁批次）。 */
export async function createBatchQuickRecord(
  page: Page,
  values: { company: string; transportDate?: string; appliedAt?: string },
): Promise<void> {
  await page.getByRole('button', { name: '快速记录', exact: false }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^物流费用登记/ }).click();
  await dialog.getByLabel('运输日期').fill(values.transportDate ?? '2026-08-12');
  await dialog.getByLabel('运输公司').fill(values.company);
  await dialog.getByLabel('费用登记日期').fill(values.appliedAt ?? '2026-08-11');
  await dialog.getByLabel('合同预算价').fill('12000');
  await dialog.getByLabel('物流成交价').fill('11000');
  await dialog.getByRole('button', { name: '保存记录' }).click();
}

/** 在「物流费用登记」记录页删除含指定运输公司文本的记录（真实 UI + window.confirm）。 */
export async function deleteBatchRecordByCompany(page: Page, company: string): Promise<void> {
  await page.getByRole('tab', { name: '物流费用登记' }).first().click();
  const tabpanel = page.getByRole('tabpanel').filter({ hasText: company });
  const row = tabpanel.getByRole('row').filter({ hasText: company });
  await expect(row).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到满足条件（真实墙钟毫秒）。 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs: number; stepMs?: number; message?: string },
): Promise<T> {
  const step = options.stepMs ?? 200;
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - started >= options.timeoutMs) {
      throw new Error(options.message ?? '轮询超时');
    }
    await sleep(step);
  }
}

/** 等待服务端发布版本达到 expectedVersion（真实 HTTP /api/meta）。 */
export async function waitForServerVersion(baseUrl: string, expectedVersion: number, timeoutMs = 60_000): Promise<void> {
  await pollUntil(
    async () => (await readMetaHttp(baseUrl))?.currentVersion ?? 0,
    (version) => version === expectedVersion,
    { timeoutMs, message: `服务端发布版本未在 ${timeoutMs}ms 内达到 ${expectedVersion}` },
  );
}
