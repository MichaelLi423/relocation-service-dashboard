/**
 * 移动只读上传 token 的 OS 安全存储抽象（design D5 实施确认）。
 *
 * - 桌面采用 Electron `safeStorage`：上传 token 加密后以密文保存在独立 userData 文件，
 *   密钥由 OS 保护；不要求 token 本身作为钥匙串条目；
 * - 仅在应用 ready 且安全存储可用时使用；Linux 的 `basic_text`/`unknown` 后端拒绝使用；
 * - **禁止**调用 `setUsePlainTextEncryption`（不做明文加密降级）；
 * - 本抽象保持无 Electron 依赖，便于 headless 单测注入 mock；
 *   真实适配在 electron-safe-storage.ts（仅由后续接线层导入）。
 */

import type { Buffer } from 'node:buffer';

export interface MobileReadonlySafeStorage {
  /** Electron safeStorage.isEncryptionAvailable()。 */
  isEncryptionAvailable(): boolean;
  /** Electron safeStorage.getSelectedStorageBackend()；不可用时返回 'unavailable'。 */
  getSelectedStorageBackend(): string;
  /** 加密明文为密文（Electron encryptString）。 */
  encryptString(plain: string): Buffer;
  /** 解密密文为明文（Electron decryptString）。 */
  decryptString(data: Buffer): string;
}

export interface MobileReadonlySafeStorageCheck {
  available: boolean;
  backend: string;
}

/** 统一后端检测（basic_text/unknown 一律不可用；getSelectedStorageBackend 抛错视为不可用）。 */
export function checkSafeStorage(storage: MobileReadonlySafeStorage): MobileReadonlySafeStorageCheck {
  let backend = 'unavailable';
  try {
    backend = storage.getSelectedStorageBackend();
  } catch {
    backend = 'unavailable';
  }
  let available = false;
  try {
    available = storage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown';
  } catch {
    available = false;
  }
  return { available, backend };
}
