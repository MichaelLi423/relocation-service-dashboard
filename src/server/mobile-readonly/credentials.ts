import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * 云端凭证摘要（design D5 / tasks 7.2-7.3）。
 *
 * - 只读浏览 Basic Auth：查看用户名 + 强密码；密码只存加盐 scrypt 摘要。
 * - 上传独立 Bearer token：只存摘要，校验恒时比较。
 * - 生成函数/CLI 的输入只来自 stdin 或环境变量（绝不经 argv），输出只含摘要，绝不落盘明文。
 * - 服务端校验查看密码与上传凭证摘要；上传端点不接受「叠加 Basic」的模糊双层认证（见 http.ts）。
 */

/** scrypt 默认参数（node:crypto 默认同源：N=16384/r=8/p=1）。 */
export const SCRYPT_DEFAULT = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 64 });
/** 摘要中允许的 N 上界（防篡改凭证文件引发超量计算）。 */
const SCRYPT_MAX_N = 1 << 17;
/** 密钥长度下界（防弱化）。 */
const SCRYPT_MIN_KEY_LEN = 32;

/** 查看凭证。 */
export interface MobileReadonlyViewerCredential {
  /** Basic Auth 用户名。 */
  username: string;
  /** 密码 scrypt 摘要（格式见 deriveScryptDigest）。 */
  digest: string;
}

/** 凭证文件（只含摘要）。 */
export interface MobileReadonlyCredentialsFile {
  viewer: MobileReadonlyViewerCredential;
  upload: { digest: string };
}

export interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

export interface ParsedScryptDigest extends ScryptOptions {
  salt: Buffer;
  hash: Buffer;
}

const DEFAULT_VIEWER_USERNAME = 'viewer';
const SALT_BYTES = 16;

/**
 * 生成加盐 scrypt 摘要。格式：
 * `scrypt$<N>$<r>$<p>$<keyLen>$<saltB64>$<hashB64>`（base64 不含 `$`，可安全 split）。
 * 输出只含摘要；调用方负责保管盐/参数与结果。
 */
export function deriveScryptDigest(secret: string, options: Partial<ScryptOptions> = {}): string {
  const opts: ScryptOptions = { ...SCRYPT_DEFAULT, ...options };
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(secret, salt, opts.keyLen, { N: opts.N, r: opts.r, p: opts.p });
  return `scrypt$${opts.N}$${opts.r}$${opts.p}$${opts.keyLen}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** 解析摘要；格式非法或参数越界返回 null。 */
export function parseScryptDigest(digest: string): ParsedScryptDigest | null {
  if (typeof digest !== 'string') return null;
  const parts = digest.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keyLen = Number(parts[4]);
  if (![N, r, p, keyLen].every(Number.isSafeInteger)) return null;
  if (N < SCRYPT_DEFAULT.N || N > SCRYPT_MAX_N || r < 1 || p < 1) return null;
  if (keyLen < SCRYPT_MIN_KEY_LEN || keyLen > 128) return null;
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(parts[5], 'base64');
    hash = Buffer.from(parts[6], 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length !== keyLen) return null;
  return { N, r, p, keyLen, salt, hash };
}

/** 校验明文 secret 是否匹配存储摘要（恒时比较；格式非法直接 false）。 */
export function verifyScryptDigest(secret: string, storedDigest: string): boolean {
  if (typeof secret !== 'string') return false;
  const parsed = parseScryptDigest(storedDigest);
  if (parsed === null) return false;
  const candidate = scryptSync(secret, parsed.salt, parsed.keyLen, { N: parsed.N, r: parsed.r, p: parsed.p });
  return timingSafeEqual(candidate, parsed.hash);
}

/**
 * 异步 scrypt 派生（请求路径用；避免同步 scryptSync 长时间占用事件循环/线程池）。
 * 生成/CLI 仍保留同步路径（deriveScryptDigest）。
 */
function scryptDeriveAsync(secret: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(secret, salt, keyLen, { N: options.N, r: options.r, p: options.p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** 异步恒时校验（请求路径用）；与 verifyScryptDigest 同语义、同格式。 */
export async function verifyScryptDigestAsync(secret: string, storedDigest: string): Promise<boolean> {
  if (typeof secret !== 'string') return false;
  const parsed = parseScryptDigest(storedDigest);
  if (parsed === null) return false;
  try {
    const candidate = await scryptDeriveAsync(secret, parsed.salt, parsed.keyLen, parsed);
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

/** 异步查看凭证校验（Basic：用户名比对 + 密码摘要恒时校验）。 */
export async function viewerMatchesAsync(
  file: MobileReadonlyCredentialsFile,
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== file.viewer.username) return false;
  return verifyScryptDigestAsync(password, file.viewer.digest);
}

/** 异步上传 Bearer 校验（恒时比较）。 */
export async function uploadTokenMatchesAsync(file: MobileReadonlyCredentialsFile, token: string): Promise<boolean> {
  return verifyScryptDigestAsync(token, file.upload.digest);
}

/**
 * 生成凭证摘要文件对象（用于落盘/输出）。绝不把明文密码/token 放进结果。
 * 输入参数即「生成时刻的受信输入」（来自 CLI 的 stdin/env，见 credentials-cli.ts）。
 */
export function generateCredentialsFile(
  viewerUsername: string,
  viewerPassword: string,
  uploadToken: string,
): MobileReadonlyCredentialsFile {
  const username = viewerUsername.length === 0 ? DEFAULT_VIEWER_USERNAME : viewerUsername;
  if (typeof viewerPassword !== 'string' || viewerPassword.length === 0) {
    throw new Error('查看密码不能为空');
  }
  if (typeof uploadToken !== 'string' || uploadToken.length === 0) {
    throw new Error('上传凭证不能为空');
  }
  return {
    viewer: { username, digest: deriveScryptDigest(viewerPassword) },
    upload: { digest: deriveScryptDigest(uploadToken) },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCredentialsFile(value: unknown): MobileReadonlyCredentialsFile {
  if (!isPlainObject(value)) throw new Error('凭证文件不是对象');
  const viewer = value.viewer;
  if (!isPlainObject(viewer)) throw new Error('凭证文件缺少 viewer');
  const username = viewer.username;
  if (typeof username !== 'string' || username.length === 0 || username.length > 100) {
    throw new Error('凭证文件 viewer.username 非法');
  }
  const viewerDigest = viewer.digest;
  const upload = value.upload;
  const uploadDigest = isPlainObject(upload) ? upload.digest : undefined;
  if (typeof viewerDigest !== 'string' || parseScryptDigest(viewerDigest) === null) {
    throw new Error('凭证文件 viewer.digest 非法');
  }
  if (typeof uploadDigest !== 'string' || parseScryptDigest(uploadDigest) === null) {
    throw new Error('凭证文件 upload.digest 非法');
  }
  return {
    viewer: { username, digest: viewerDigest },
    upload: { digest: uploadDigest },
  };
}

/** 解析凭证文件 JSON（供启动加载；非法即抛错快速失败）。 */
export function parseCredentialsJson(raw: string): MobileReadonlyCredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('凭证文件不是合法 JSON');
  }
  return asCredentialsFile(parsed);
}

/** 从磁盘读取凭证摘要文件。 */
export function loadCredentialsFileSync(credentialsFile: string): MobileReadonlyCredentialsFile {
  const raw = readFileSync(credentialsFile, 'utf8');
  return parseCredentialsJson(raw);
}

/** 校验 Basic 查看凭证（用户名比对 + 密码摘要恒时校验）。 */
export function viewerMatches(file: MobileReadonlyCredentialsFile, username: string, password: string): boolean {
  if (username !== file.viewer.username) return false;
  return verifyScryptDigest(password, file.viewer.digest);
}

/** 校验上传 Bearer token（摘要恒时校验）。 */
export function uploadTokenMatches(file: MobileReadonlyCredentialsFile, token: string): boolean {
  return verifyScryptDigest(token, file.upload.digest);
}

/** CLI 使用的环境变量名（secret 输入只走这里或 stdin，绝不 argv）。 */
export const CREDENTIAL_CLI_ENV = {
  username: 'MOBILE_READONLY_VIEWER_USERNAME',
  password: 'MOBILE_READONLY_VIEWER_PASSWORD',
  uploadToken: 'MOBILE_READONLY_UPLOAD_TOKEN',
} as const;
