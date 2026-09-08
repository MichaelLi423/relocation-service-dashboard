import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MobileReadonlyServiceConfig } from '../../src/server/mobile-readonly/config';
import {
  generateCredentialsFile,
  type MobileReadonlyCredentialsFile,
} from '../../src/server/mobile-readonly/credentials';
import {
  startMobileReadonlyService,
  type RunningMobileReadonlyService,
} from '../../src/server/mobile-readonly/service';

/**
 * tests/server 共用辅助（全部为脱敏合成数据；绝不触碰 docs/ 真实客户文件）。
 */

/** 合成查看密码 / 上传 token（仅测试用；与真实生产凭证无任何关系）。 */
export const TEST_VIEWER_USERNAME = 'viewer';
export const TEST_VIEWER_PASSWORD = 'test-only-viewer-password-9f8e7d2c';
export const TEST_UPLOAD_TOKEN = 'test-only-upload-token-4b2a1d9e0f';

export function makeTestCredentials(): MobileReadonlyCredentialsFile {
  return generateCredentialsFile(TEST_VIEWER_USERNAME, TEST_VIEWER_PASSWORD, TEST_UPLOAD_TOKEN);
}

export function basicAuthHeader(username: string = TEST_VIEWER_USERNAME, password: string = TEST_VIEWER_PASSWORD): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function bearerHeader(): string {
  return `Bearer ${TEST_UPLOAD_TOKEN}`;
}

/** 测试用默认配置（绑定 loopback + 随机端口；请求/参数上限可按需覆盖）。 */
export function makeTestServiceConfig(overrides: Partial<MobileReadonlyServiceConfig> = {}): MobileReadonlyServiceConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    credentialsFile: '',
    webRoot: null,
    maxBodyBytes: 1 << 20,
    maxUrlLength: 8192,
    requestTimeoutMs: 10_000,
    headersTimeoutMs: 5_000,
    keepAliveTimeoutMs: 5_000,
    authMaxActive: 4,
    tls: null,
    ...overrides,
  };
}

export interface StartedTestService {
  running: RunningMobileReadonlyService;
  baseUrl: string;
  dataDir: string;
  webRoot: string | null;
  credentials: MobileReadonlyCredentialsFile;
}

export interface StartTestServiceOptions {
  dataDir?: string;
  webRoot?: string | null;
  credentials?: MobileReadonlyCredentialsFile;
  config?: Partial<MobileReadonlyServiceConfig>;
  /** true=把 credentials 作为启动参数注入（既有行为）；false=只写盘并依赖服务从磁盘加载。 */
  injectCredentials?: boolean;
}

/** 启动真实临时服务（http，127.0.0.1，随机端口）；dataDir/webRoot 为临时目录。 */
export async function startTestService(options: StartTestServiceOptions = {}): Promise<StartedTestService> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'mr-svc-data-'));
  const webRoot = options.webRoot === undefined ? mkdtempSync(join(tmpdir(), 'mr-svc-web-')) : options.webRoot;
  const credentials = options.credentials ?? makeTestCredentials();
  const config = makeTestServiceConfig({
    dataDir,
    credentialsFile: join(dataDir, 'credentials.json'),
    webRoot,
    ...options.config,
  });
  const injectCredentials = options.injectCredentials !== false;
  const started = injectCredentials
    ? await startMobileReadonlyService({ config, credentials, webRoot })
    : // 不注入：服务必须自行从 config.credentialsFile 加载磁盘摘要（需先写盘）。
      await startMobileReadonlyService({ config, webRoot });
  return { running: started, baseUrl: started.baseUrl, dataDir, webRoot, credentials };
}

export async function stopTestService(service: StartedTestService): Promise<void> {
  await service.running.close();
  const dirs = [service.dataDir];
  if (service.webRoot !== null) dirs.push(service.webRoot);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
}

/** 通用 fetch：path 需以 / 开头。 */
export function doFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

/** 上传 JSON 请求体（协议与快照分层）。 */
export function uploadInit(payload: unknown, token: string): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  };
}
