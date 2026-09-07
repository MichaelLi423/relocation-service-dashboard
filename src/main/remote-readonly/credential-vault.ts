/**
 * 远程只读发布：publisher credential OS vault（tasks 2.3 secret 切片）。
 *
 * 边界与安全模型（vault 层只做「secret」本身：不读/写业务 SQLite、不碰
 * control-store、不依赖 renderer / env / plaintext / safeStorage）：
 * - 只经 @napi-rs/keyring 原生 OS vault 保存发布者凭据 secret。入口是固定 service
 *   命名空间 + 已校验的非敏感 publisherId。key identity（service / 标识符域 /
 *   长度边界 / 支持平台）**单一来源**是 credential-vault-identity.cjs，main 适配器
 *   与本地 CLI 登记工具共用该 CJS 常量与校验，任何接入方不得自行拼 service。
 * - **原生加载是懒的**：构造 CredentialVault 不 require @napi-rs/keyring（import 本
 *   模块/测试不触发原生加载）；仅当真正需要读写（entryFor 内、且平台校验通过）才
 *   require，require/构造抛错 → NATIVE_UNAVAILABLE。平台不支持在加载前判定。
 * - 原生不可用 / 平台不支持（默认仅 macOS/Windows；Linux 未经 spec 批准）/
 *   locked / 读写删除失败一律 generic `CredentialVaultError`（metadata-only 稳定
 *   code 模板，message 不含原生错误原文 / cause / secret / 路径），fail closed：
 *   无 env / plaintext / safeStorage 回退，secret 绝不进错误 message / 日志。
 * - get：不存在 → null；后端 locked/不可读 → BACKEND_FAILURE（明确区分）。delete：
 *   成功或原本不存在 → true（原生 deleteCredential 失败以 reject 表达，不误报已删）。
 * - 绝不 findCredentials 枚举；无法注入自定义 service/username。
 * - secret 长度受控：空 / 超过 CREDENTIAL_SECRET_MAX_CHARS 拒绝，不截断。JS string
 *   无法可靠零化，本模块不声称零化。
 */
import { DomainError } from '../../domain/core/errors';
import {
  CREDENTIAL_SERVICE,
  CREDENTIAL_ID_MAX_CHARS,
  CREDENTIAL_SECRET_MAX_CHARS,
  SUPPORTED_VAULT_PLATFORMS,
} from './credential-vault-identity.cjs';

export { CREDENTIAL_SERVICE } from './credential-vault-identity.cjs';

/** secret 最大 Unicode 码点（拒绝空/超长，不截断）。 */
export const CREDENTIAL_SECRET_MAX = CREDENTIAL_SECRET_MAX_CHARS;

/** publisherId 技术标识符最大 Unicode 码点（标识符，不冒充可读业务编号）。 */
export const CREDENTIAL_ID_MAX = CREDENTIAL_ID_MAX_CHARS;

/** 默认支持的原生 OS vault 平台（Linux 需 spec 另行批准才加入）。 */
export const SUPPORTED_VAULT_PLATFORMS_SET: ReadonlySet<string> = new Set<string>(
  SUPPORTED_VAULT_PLATFORMS,
);

export const CREDENTIAL_VAULT_ERROR_CODES = {
  /** 平台不在支持集合。 */
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  /** 原生库加载失败 / 构造失败（@napi-rs/keyring 不可用）。 */
  NATIVE_UNAVAILABLE: 'NATIVE_UNAVAILABLE',
  /** 后端 locked / get·set·delete 失败。 */
  BACKEND_FAILURE: 'BACKEND_FAILURE',
  /** publisherId 非法（非 string/空/超长/字符域外）。 */
  INVALID_KEY: 'INVALID_KEY',
  /** secret 非法（非 string/空/超长）。 */
  INVALID_SECRET: 'INVALID_SECRET',
} as const;

export type CredentialVaultErrorCode =
  (typeof CREDENTIAL_VAULT_ERROR_CODES)[keyof typeof CREDENTIAL_VAULT_ERROR_CODES];

/** metadata-only vault 错误：message 只含稳定 code 模板，不回显原生错误/secret。 */
export class CredentialVaultError extends DomainError {
  constructor(code: CredentialVaultErrorCode) {
    super(code, `credential vault ${code}`);
    this.name = 'CredentialVaultError';
  }
}

function vaultError(code: CredentialVaultErrorCode): CredentialVaultError {
  return new CredentialVaultError(code);
}

/** @napi-rs/keyring 原生 AsyncEntry 的窄类型（仅 get/set/delete；无枚举面）。 */
export interface AsyncCredentialEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/** 原生构造端口：测试注入 fake AsyncEntry；缺省在 entryFor 内懒加载真实 keyring。 */
export type AsyncCredentialEntryFactory = (service: string, username: string) => AsyncCredentialEntry;

/** keyring 入口按 service 分组；username 为 account。 */
export interface CredentialVaultOptions {
  /** 原生构造注入（测试用 fake）；缺省懒加载真实 @napi-rs/keyring。 */
  entryFactory?: AsyncCredentialEntryFactory;
  /** 平台覆盖（仅测试用；缺省 process.platform）。 */
  platform?: string;
}

/**
 * 懒加载真实 keyring 构造器（**不在构造 CredentialVault 时调用**；首次 entryFor 才
 * require，保证 import 本模块/测试不触发原生加载；require/构造抛错在 entryFor 归一化）。
 */
function loadNativeFactory(): AsyncCredentialEntryFactory {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const keyring = require('@napi-rs/keyring') as {
    AsyncEntry: new (service: string, username: string) => AsyncCredentialEntry;
  };
  return (service, username) => new keyring.AsyncEntry(service, username);
}

/**
 * 校验 publisherId（与 CLI 同域约束：非空 string、无换行/控制、≤128 码点、
 * 匹配 PUBLISHER_ID_PATTERN 的 ASCII 技术标识符）。CLI 已先行校验，此处防内部误用。
 */
export function validateCredentialKey(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw vaultError('INVALID_KEY');
  if ([...value].length > CREDENTIAL_ID_MAX_CHARS) throw vaultError('INVALID_KEY');
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw vaultError('INVALID_KEY');
  // 与 credential-vault-identity.cjs 的 PUBLISHER_ID_PATTERN 完全一致（3–128，首尾非 -_）。
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,126}[A-Za-z0-9]$/.test(value)) throw vaultError('INVALID_KEY');
  return value;
}

/** 校验 secret（string、非空、≤8192 Unicode 码点；不截断）。 */
function validateSecret(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw vaultError('INVALID_SECRET');
  if ([...value].length > CREDENTIAL_SECRET_MAX_CHARS) throw vaultError('INVALID_SECRET');
  return value;
}

/** publisher secret OS vault 窄接口：get/set/delete，固定 service + 校验后的 publisherId。 */
export class CredentialVault {
  private readonly injectedFactory: AsyncCredentialEntryFactory | undefined;
  private readonly platformOk: boolean;

  constructor(options: CredentialVaultOptions = {}) {
    // 只记录注入的 fake；真实 keyring 不在构造时 require（懒加载在 entryFor）。
    this.injectedFactory = options.entryFactory;
    this.platformOk = SUPPORTED_VAULT_PLATFORMS_SET.has(options.platform ?? process.platform);
  }

  private entryFor(publisherId: unknown): AsyncCredentialEntry {
    if (!this.platformOk) throw vaultError('UNSUPPORTED_PLATFORM');
    const key = validateCredentialKey(publisherId);
    try {
      const factory = this.injectedFactory ?? loadNativeFactory();
      return factory(CREDENTIAL_SERVICE, key);
    } catch {
      throw vaultError('NATIVE_UNAVAILABLE');
    }
  }

  /** 读取 secret：不存在 → null；后端 locked/不可读 → BACKEND_FAILURE。 */
  async getSecret(publisherId: unknown): Promise<string | null> {
    try {
      const value = await this.entryFor(publisherId).getPassword();
      return value === undefined ? null : value;
    } catch (err) {
      if (err instanceof CredentialVaultError) throw err;
      throw vaultError('BACKEND_FAILURE');
    }
  }

  /** 写入/覆盖 secret：空或超长拒绝（INVALID_SECRET）；后端失败 → BACKEND_FAILURE。 */
  async setSecret(publisherId: unknown, secret: unknown): Promise<void> {
    const value = validateSecret(secret);
    try {
      await this.entryFor(publisherId).setPassword(value);
    } catch (err) {
      if (err instanceof CredentialVaultError) throw err;
      throw vaultError('BACKEND_FAILURE');
    }
  }

  /**
   * 删除（幂等成功）：无论原本是否存在都返回 true（语义 =「现在没有该凭据，且无错误」；
   * 与原生区分一致——原生失败以 reject 表达、绝不返回 false 伪装删除成功）；
   * 存在但删除失败 → BACKEND_FAILURE。
   */
  async deleteCredential(publisherId: unknown): Promise<boolean> {
    try {
      await this.entryFor(publisherId).deleteCredential();
      return true;
    } catch (err) {
      if (err instanceof CredentialVaultError) throw err;
      throw vaultError('BACKEND_FAILURE');
    }
  }
}
