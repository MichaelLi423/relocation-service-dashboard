import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { MobileReadonlyServiceConfig } from './config';
import { loadCredentialsFileSync, type MobileReadonlyCredentialsFile } from './credentials';
import { createRequestHandler } from './http';
import {
  MOBILE_READONLY_SNAPSHOTS_DIR,
  createNodeEnvelopeIo,
  EnvelopeStore,
  type EnvelopeClock,
} from './store';

/**
 * 云端服务装配与启动（tasks 7.1/7.6）。
 *
 * - 单 Node 进程，无数据库/Redis/队列；HTTP/HTTPS 由同一监听器处理；
 * - 生产形态监听 0.0.0.0（共享 Docker 内部网络），由反代终止外部 HTTPS；
 *   注入 TLS 选项时直接以 HTTPS 运行（本地测试/无反代）；
 * - 启动即从文件恢复信封；凭证摘要文件缺失/非法立即失败（不降级、不带明文启动）。
 */

export interface StartMobileReadonlyServiceOptions {
  config: MobileReadonlyServiceConfig;
  /** 凭证摘要对象；缺省从 config.credentialsFile 读取。 */
  credentials?: MobileReadonlyCredentialsFile;
  /** 预构建 store（已 init）；缺省按 config.dataDir 构建并恢复。 */
  store?: EnvelopeStore;
  /** 覆盖静态目录；缺省 = config.webRoot ?? 构建产物 `__dirname/web`。 */
  webRoot?: string | null;
  /** 注入时钟（publishedAt 用）；缺省系统时钟。 */
  clock?: EnvelopeClock;
}

export interface RunningMobileReadonlyService {
  server: http.Server | https.Server;
  baseUrl: string;
  store: EnvelopeStore;
  /** 关闭监听并断开连接。 */
  close(): Promise<void>;
}

function buildDefaultStore(config: MobileReadonlyServiceConfig, clock: EnvelopeClock): EnvelopeStore {
  const io = createNodeEnvelopeIo(join(config.dataDir, MOBILE_READONLY_SNAPSHOTS_DIR));
  const store = new EnvelopeStore(io, clock);
  store.init();
  return store;
}

interface HttpServerTimeouts {
  requestTimeout: number;
  headersTimeout: number;
  keepAliveTimeout: number;
}

function createConfiguredServer(
  config: MobileReadonlyServiceConfig,
  listener: http.RequestListener,
): http.Server | https.Server {
  if (config.tls !== null) {
    const key = readFileSync(config.tls.keyFile, 'utf8');
    const cert = readFileSync(config.tls.certFile, 'utf8');
    const server = https.createServer({ key, cert }, listener);
    const timeouts = server as unknown as HttpServerTimeouts;
    timeouts.requestTimeout = config.requestTimeoutMs;
    timeouts.headersTimeout = config.headersTimeoutMs;
    timeouts.keepAliveTimeout = config.keepAliveTimeoutMs;
    return server;
  }
  const server = http.createServer(listener);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  return server;
}

function listenAsync(server: http.Server | https.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function closeAsync(server: http.Server | https.Server): Promise<void> {
  return new Promise((resolve) => {
    const closer = server as unknown as { closeAllConnections?: () => void };
    if (typeof closer.closeAllConnections === 'function') closer.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 启动云端只读服务（init store -> 装配 -> 监听）。 */
export async function startMobileReadonlyService(
  options: StartMobileReadonlyServiceOptions,
): Promise<RunningMobileReadonlyService> {
  const config = options.config;
  const clock: EnvelopeClock = options.clock ?? { nowIso: () => new Date().toISOString() };
  const store = options.store ?? buildDefaultStore(config, clock);
  const credentials = options.credentials ?? loadCredentialsFileSync(config.credentialsFile);
  const webRoot = options.webRoot !== undefined ? options.webRoot : (config.webRoot ?? join(__dirname, 'web'));

  const listener = createRequestHandler({
    store,
    credentials,
    webRoot,
    maxBodyBytes: config.maxBodyBytes,
    maxUrlLength: config.maxUrlLength,
    requestTimeoutMs: config.requestTimeoutMs,
    authMaxActive: config.authMaxActive,
  });
  const server = createConfiguredServer(config, listener);
  await listenAsync(server, config.host, config.port);

  const address = server.address();
  const resolvedPort = typeof address === 'object' && address !== null ? (address as AddressInfo).port : config.port;
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const scheme = config.tls === null ? 'http' : 'https';

  return {
    server,
    baseUrl: `${scheme}://${displayHost}:${resolvedPort}`,
    store,
    close: () => closeAsync(server),
  };
}
