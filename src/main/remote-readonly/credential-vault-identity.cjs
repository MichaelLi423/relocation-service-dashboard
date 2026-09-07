'use strict';
/**
 * credential-vault-identity.cjs
 *
 * 远程只读发布：credential vault **key identity** 与边界常量/校验的单一来源。
 * 这是 main TS 适配器（credential-vault.ts）与本地 CLI 登记工具
 * （scripts/configure-remote-publisher.cjs）之间保证「vault key 完全一致」的
 * 共享 CommonJS 模块（无 TS 运行时加载器 / 无新依赖）。
 *
 * 本模块只含常量与纯函数，不含 secret、不含原生 @napi-rs/keyring import、
 * 不含 vault/文件/网络操作：
 * - CREDENTIAL_SERVICE：唯一 keyring service 命名空间（不得由接入方拼接）。
 * - PUBLISHER_ID_PATTERN / isValidPublisherId：非敏感技术 publisherId 的受控
 *   字符域（ASCII 字母数字 + '-_'，3–128 码点，不以 '-'/'_' 开头结尾），不含
 *   换行/控制字符；CLI 只接受满足该约束的标识符。
 * - CREDENTIAL_ID_MAX_CHARS / CREDENTIAL_SECRET_MAX_CHARS：边界常量。
 * - SUPPORTED_VAULT_PLATFORMS：默认支持 darwin/win32；linux 需 spec 另行批准。
 *
 * 发布者凭据 secret 只在 CLI 经 TTY 隐藏输入进入内存、再写入 OS vault；本模块
 * 任何导出都不接受、不返回、不持久化 secret 值。
 */
const CREDENTIAL_SERVICE = 'relocation-service-workbench.remote-readonly.publisher';

const CREDENTIAL_ID_MAX_CHARS = 128;
const CREDENTIAL_SECRET_MAX_CHARS = 8192;

// 非敏感技术标识符：ASCII 字母数字与 '-_'，3–128 码点，首尾不得为 '-_'，
// 不含空白/换行/控制字符。不使用 Unicode 类别放宽（防止视觉混淆/控制注入）。
const PUBLISHER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,126}[A-Za-z0-9]$/;

const SUPPORTED_VAULT_PLATFORMS = ['darwin', 'win32'];

/**
 * 校验 publisherId 是否为受控非敏感技术标识符（string 且匹配 PUBLISHER_ID_PATTERN）。
 * 永不抛错：非法返回 false，调用方决定错误文案。
 */
function isValidPublisherId(value) {
  return typeof value === 'string' && PUBLISHER_ID_PATTERN.test(value);
}

module.exports = {
  CREDENTIAL_SERVICE,
  CREDENTIAL_ID_MAX_CHARS,
  CREDENTIAL_SECRET_MAX_CHARS,
  PUBLISHER_ID_PATTERN,
  SUPPORTED_VAULT_PLATFORMS,
  isValidPublisherId,
};
