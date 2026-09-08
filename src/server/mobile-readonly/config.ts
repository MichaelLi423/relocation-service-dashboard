import { join } from 'node:path';

/**
 * 云端轻量只读服务配置（openspec change `add-mobile-readonly-publication`）。
 *
 * - 生产部署形态：绑定共享 Docker 内部网络主机 0.0.0.0，由 OpenResty/1Panel 反代终止
 *   HTTPS（容器内 HTTP 仅供受信内部边界访问，绝不直接暴露公网明文）；端口 8082 为候选。
 * - 也支持注入 TLS 私钥/证书直接以 HTTPS 运行（本地测试 / 无反代场景），
 *   二者由本配置统一表达。
 * - 数据目录唯一权威文件为 `<dataDir>/snapshots/current.json`（见 store.ts）。
 */
export interface MobileReadonlyServiceConfig {
  /** 监听主机；生产默认 0.0.0.0（共享 Docker 内部网络可达）。 */
  host: string;
  /** 监听端口；生产候选 8082（经 1Panel/OpenResty 反代对外 443）。 */
  port: number;
  /** 数据目录：snapshots/current.json 与凭证摘要文件所在。 */
  dataDir: string;
  /** 凭证摘要文件路径（只存密码学摘要，绝不存明文，见 credentials.ts）。 */
  credentialsFile: string;
  /** 手机静态入口目录（构建产物 dist/mobile-readonly/web）；null = 未指定。 */
  webRoot: string | null;
  /** 上传请求体上限（字节）。 */
  maxBodyBytes: number;
  /** 单请求 URL 长度上限（字节）；超出返回 414。 */
  maxUrlLength: number;
  /** 单请求整体处理超时（毫秒）；超时断开，绝不落半写。 */
  requestTimeoutMs: number;
  /** 接收请求头超时（毫秒）。 */
  headersTimeoutMs: number;
  /** HTTP keep-alive 空闲超时（毫秒）。 */
  keepAliveTimeoutMs: number;
  /**
   * 请求路径凭证校验（scrypt）并发上限（有界 auth 信号量：活动校验达上限时新请求
   * 直接 503，不排队/不堆积线程池任务；默认 4）。
   */
  authMaxActive: number;
  /** 直接 HTTPS 所需 TLS 文件；null = 仅 HTTP（受信内部/反代后）。 */
  tls: { keyFile: string; certFile: string } | null;
}

/** 默认值（端口 8082 与 design D9 候选一致）。 */
export const MOBILE_READONLY_DEFAULT_CONFIG: Readonly<Omit<MobileReadonlyServiceConfig, 'tls'>> = {
  host: '0.0.0.0',
  port: 8082,
  dataDir: 'data',
  credentialsFile: '', // 派生：join(dataDir, 'credentials.json')
  webRoot: null, // 运行时缺省取 __dirname/web
  maxBodyBytes: 64 * 1024 * 1024,
  maxUrlLength: 8192,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  authMaxActive: 4,
};

function readOptionalString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = readOptionalString(env, key);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`环境变量 ${key} 必须为十进制非负整数，实际值非法`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${key} 必须为大于 0 的整数`);
  }
  return parsed;
}

/**
 * 从环境变量读取服务配置。
 * 可用变量：MOBILE_READONLY_HOST/PORT/DATA_DIR/CREDENTIALS_FILE/WEB_ROOT/
 * MAX_BODY_BYTES/MAX_URL_LENGTH/REQUEST_TIMEOUT_MS/HEADERS_TIMEOUT_MS/KEEPALIVE_TIMEOUT_MS/
 * AUTH_MAX_ACTIVE/TLS_KEY_FILE/TLS_CERT_FILE。
 */
export function loadServiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MobileReadonlyServiceConfig {
  const dataDir = readOptionalString(env, 'MOBILE_READONLY_DATA_DIR') ?? MOBILE_READONLY_DEFAULT_CONFIG.dataDir;
  const credentialsFile =
    readOptionalString(env, 'MOBILE_READONLY_CREDENTIALS_FILE') ?? join(dataDir, 'credentials.json');
  const webRoot = readOptionalString(env, 'MOBILE_READONLY_WEB_ROOT') ?? null;

  const host = readOptionalString(env, 'MOBILE_READONLY_HOST') ?? MOBILE_READONLY_DEFAULT_CONFIG.host;
  const port = readPositiveInt(env, 'MOBILE_READONLY_PORT', MOBILE_READONLY_DEFAULT_CONFIG.port);
  if (port < 1 || port > 65535) {
    throw new Error('MOBILE_READONLY_PORT 必须在 1..65535 之间');
  }

  const tlsKeyFile = readOptionalString(env, 'MOBILE_READONLY_TLS_KEY_FILE');
  const tlsCertFile = readOptionalString(env, 'MOBILE_READONLY_TLS_CERT_FILE');
  if ((tlsKeyFile === undefined) !== (tlsCertFile === undefined)) {
    throw new Error('MOBILE_READONLY_TLS_KEY_FILE 与 MOBILE_READONLY_TLS_CERT_FILE 必须同时提供');
  }

  const authMaxActive = readPositiveInt(env, 'MOBILE_READONLY_AUTH_MAX_ACTIVE', MOBILE_READONLY_DEFAULT_CONFIG.authMaxActive);
  if (authMaxActive < 1 || authMaxActive > 64) {
    throw new Error('MOBILE_READONLY_AUTH_MAX_ACTIVE 必须在 1..64 之间');
  }

  return {
    host,
    port,
    dataDir,
    credentialsFile,
    webRoot,
    maxBodyBytes: readPositiveInt(env, 'MOBILE_READONLY_MAX_BODY_BYTES', MOBILE_READONLY_DEFAULT_CONFIG.maxBodyBytes),
    maxUrlLength: readPositiveInt(env, 'MOBILE_READONLY_MAX_URL_LENGTH', MOBILE_READONLY_DEFAULT_CONFIG.maxUrlLength),
    requestTimeoutMs: readPositiveInt(
      env,
      'MOBILE_READONLY_REQUEST_TIMEOUT_MS',
      MOBILE_READONLY_DEFAULT_CONFIG.requestTimeoutMs,
    ),
    headersTimeoutMs: readPositiveInt(
      env,
      'MOBILE_READONLY_HEADERS_TIMEOUT_MS',
      MOBILE_READONLY_DEFAULT_CONFIG.headersTimeoutMs,
    ),
    keepAliveTimeoutMs: readPositiveInt(
      env,
      'MOBILE_READONLY_KEEPALIVE_TIMEOUT_MS',
      MOBILE_READONLY_DEFAULT_CONFIG.keepAliveTimeoutMs,
    ),
    authMaxActive,
    tls: tlsKeyFile !== undefined && tlsCertFile !== undefined ? { keyFile: tlsKeyFile, certFile: tlsCertFile } : null,
  };
}
