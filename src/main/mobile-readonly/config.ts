import { join } from 'node:path';
import type { MobileReadonlyFileIo } from './fs-io';
import type { MobileReadonlySafeStorage } from './safe-storage';
import { checkSafeStorage } from './safe-storage';

/**
 * 桌面发布配置存储（design D4/D5 实施确认）。
 *
 * - `mobile-readonly-config.json`：{ version, enabled, target }（不含 token）；
 * - token 密文独立文件 `mobile-readonly-token.enc`（safeStorage 加密，密钥由 OS 保护）；
 * - 两文件与「结果状态文件」（state.ts）分离；本地写入一律原子；
 * - 配置损坏/不可读 → 视为未配置并禁用外发（fail-closed）；写入失败如实返回失败码；
 * - 落盘的 target 复用「严格 HTTPS origin」校验器：文件里出现带路径/query/hash/凭据/非法
 *   origin 的 target 一律视为损坏（不是"宽松字符串"），绝不据其外发。
 */

export const MOBILE_READONLY_CONFIG_VERSION = 1 as const;

export interface MobileReadonlyConfigData {
  version: typeof MOBILE_READONLY_CONFIG_VERSION;
  /** 负责人显式启停（持久化）；有效启用另需配置与凭证可用。 */
  enabled: boolean;
  /** 规范化 HTTPS origin（无尾斜杠、无路径/查询/凭据）；null=未配置。 */
  target: string | null;
}

export const DEFAULT_MOBILE_READONLY_CONFIG: MobileReadonlyConfigData = Object.freeze({
  version: MOBILE_READONLY_CONFIG_VERSION,
  enabled: false,
  target: null,
});

export interface MobileReadonlyConfigLoadResult {
  data: MobileReadonlyConfigData;
  missing: boolean;
  /** JSON 解析失败/结构非法（fail-closed：不得在未知授权配置下继续上传）。 */
  corrupt: boolean;
}

export type MobileReadonlyConfigMutationResult =
  | { ok: true }
  | { ok: false; code: 'write_failed' | 'safe_storage_unavailable' | 'read_failed' };

export type MobileReadonlyTokenReadResult =
  | { ok: true; token: string }
  | { ok: false; code: 'missing' | 'decrypt_failed' | 'safe_storage_unavailable' };

export interface MobileReadonlyConfigStoreOptions {
  io: MobileReadonlyFileIo;
  storageDir: string;
  safeStorage: MobileReadonlySafeStorage;
}

export interface MobileReadonlyConfigStore {
  readonly configFilePath: string;
  readonly tokenFilePath: string;
  load(): MobileReadonlyConfigLoadResult;
  isTokenPresent(): boolean;
  persistTargetAndEnabled(target: string | null, enabled: boolean): MobileReadonlyConfigMutationResult;
  persistEnabled(enabled: boolean): MobileReadonlyConfigMutationResult;
  /** 加密保存 token（safeStorage 不可用直接失败，不落明文）。 */
  storeToken(token: string): MobileReadonlyConfigMutationResult;
  readToken(): MobileReadonlyTokenReadResult;
  /** 移除 token 密文（如配置保存失败回滚）。 */
  clearToken(): void;
}

export function createMobileReadonlyConfigStore(options: MobileReadonlyConfigStoreOptions): MobileReadonlyConfigStore {
  const configFilePath = join(options.storageDir, 'mobile-readonly-config.json');
  const tokenFilePath = join(options.storageDir, 'mobile-readonly-token.enc');
  const { io, safeStorage } = options;

  return {
    configFilePath,
    tokenFilePath,
    load(): MobileReadonlyConfigLoadResult {
      const raw = io.readText(configFilePath);
      if (!raw.ok) {
        if (raw.code === 'read_error') {
          // 文件存在但不可读 → 不静默当"全新配置"（fail-closed，明确损坏，绝不放行外发）。
          return { data: { ...DEFAULT_MOBILE_READONLY_CONFIG }, missing: false, corrupt: true };
        }
        return { data: { ...DEFAULT_MOBILE_READONLY_CONFIG }, missing: true, corrupt: false };
      }
      try {
        const parsed: unknown = JSON.parse(raw.text ?? '');
        const shape = parseStoredConfig(parsed);
        if (shape.ok) {
          return {
            data: {
              version: MOBILE_READONLY_CONFIG_VERSION,
              enabled: shape.enabled,
              target: shape.target,
            },
            missing: false,
            corrupt: false,
          };
        }
        return { data: { ...DEFAULT_MOBILE_READONLY_CONFIG }, missing: false, corrupt: true };
      } catch {
        return { data: { ...DEFAULT_MOBILE_READONLY_CONFIG }, missing: false, corrupt: true };
      }
    },
    isTokenPresent() {
      return io.exists(tokenFilePath);
    },
    persistTargetAndEnabled(target, enabled) {
      const current = this.load();
      if (current.corrupt) {
        return { ok: false, code: 'read_failed' };
      }
      return writeConfig(io, configFilePath, {
        version: MOBILE_READONLY_CONFIG_VERSION,
        enabled,
        target,
      });
    },
    persistEnabled(enabled) {
      const current = this.load();
      if (current.corrupt) {
        return { ok: false, code: 'read_failed' };
      }
      return writeConfig(io, configFilePath, {
        version: MOBILE_READONLY_CONFIG_VERSION,
        enabled,
        target: current.data.target,
      });
    },
    storeToken(token) {
      const check = checkSafeStorage(safeStorage);
      if (!check.available) {
        return { ok: false, code: 'safe_storage_unavailable' };
      }
      let cipher: Buffer;
      try {
        cipher = safeStorage.encryptString(token);
      } catch {
        return { ok: false, code: 'safe_storage_unavailable' };
      }
      const result = io.writeBinaryAtomic(tokenFilePath, cipher);
      return result.ok ? { ok: true } : { ok: false, code: 'write_failed' };
    },
    readToken(): MobileReadonlyTokenReadResult {
      if (!io.exists(tokenFilePath)) {
        return { ok: false, code: 'missing' };
      }
      const check = checkSafeStorage(safeStorage);
      if (!check.available) {
        return { ok: false, code: 'safe_storage_unavailable' };
      }
      const raw = io.readBinary(tokenFilePath);
      if (!raw.ok || !raw.data) {
        return { ok: false, code: 'missing' };
      }
      try {
        return { ok: true, token: safeStorage.decryptString(Buffer.from(raw.data)) };
      } catch {
        return { ok: false, code: 'decrypt_failed' };
      }
    },
    clearToken() {
      io.remove(tokenFilePath);
    },
  };
}

function writeConfig(
  io: MobileReadonlyFileIo,
  path: string,
  data: MobileReadonlyConfigData,
): MobileReadonlyConfigMutationResult {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const result = io.writeTextAtomic(path, text);
  return result.ok ? { ok: true } : { ok: false, code: 'write_failed' };
}

/**
 * 解析落盘配置 JSON：版本/启用类型合法，且 target 必须为 null 或通过「严格 HTTPS origin」
 * 校验（文件里出现空串/任意路径/query/hash/凭据/非法 origin 一律视为损坏）。
 */
function parseStoredConfig(
  value: unknown,
): { ok: true; enabled: boolean; target: string | null } | { ok: false } {
  if (typeof value !== 'object' || value === null) return { ok: false };
  const candidate = value as { version?: unknown; enabled?: unknown; target?: unknown };
  if (candidate.version !== MOBILE_READONLY_CONFIG_VERSION) return { ok: false };
  if (typeof candidate.enabled !== 'boolean') return { ok: false };
  const target = candidate.target;
  if (target === null) return { ok: true, enabled: candidate.enabled, target: null };
  if (typeof target !== 'string' || target === '') return { ok: false };
  const validated = validateMobileReadonlyTarget(target);
  return validated.ok
    ? { ok: true, enabled: candidate.enabled, target: validated.origin }
    : { ok: false };
}

/** 目标 origin 严格校验（不含 token 维度）：固定 HTTPS origin、无凭据/query/hash/路径。 */
export function validateMobileReadonlyTarget(
  target: string,
): { ok: true; origin: string } | { ok: false; code: 'invalid_target' } {
  if (typeof target !== 'string') {
    return { ok: false, code: 'invalid_target' };
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, code: 'invalid_target' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, code: 'invalid_target' };
  if (parsed.hostname === '') return { ok: false, code: 'invalid_target' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, code: 'invalid_target' };
  if (parsed.search !== '' || parsed.hash !== '') return { ok: false, code: 'invalid_target' };
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '') return { ok: false, code: 'invalid_target' };
  return { ok: true, origin: `${parsed.protocol}//${parsed.host}` };
}

/**
 * 配置输入校验（一次性受信配置入口语义）：
 * - target：固定 HTTPS origin——不允许凭据/query/hash/任意 path（复用 validateMobileReadonlyTarget）；
 * - token：非空即可（password 风格由 UI 层不回显，不在此做长度猜测）。
 */
export function validateMobileReadonlyConfigureInput(input: {
  target: string;
  token: string;
}): { ok: true; origin: string } | { ok: false; code: 'invalid_target' | 'empty_token' } {
  if (typeof input.token !== 'string' || input.token.length === 0) {
    return { ok: false, code: 'empty_token' };
  }
  return validateMobileReadonlyTarget(input.target);
}
