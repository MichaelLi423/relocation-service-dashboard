/**
 * Type declarations for credential-vault-identity.cjs.
 * 使 main TS（credential-vault.ts）在 moduleResolution: Bundler 下获得与 CLI 同一
 * CJS 模块的常量/纯函数类型（单一 key identity 来源）。
 */
export const CREDENTIAL_SERVICE: string;
export const CREDENTIAL_ID_MAX_CHARS: number;
export const CREDENTIAL_SECRET_MAX_CHARS: number;
export const PUBLISHER_ID_PATTERN: RegExp;
export const SUPPORTED_VAULT_PLATFORMS: readonly string[];

/** 校验 publisherId 是否为受控非敏感技术标识符（string 且匹配 PUBLISHER_ID_PATTERN）。 */
export function isValidPublisherId(value: unknown): boolean;
