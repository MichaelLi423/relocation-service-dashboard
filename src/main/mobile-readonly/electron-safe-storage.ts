import { safeStorage } from 'electron';
import type { MobileReadonlySafeStorage } from './safe-storage';

/**
 * Electron safeStorage 真实适配（design D5 实施确认）。
 *
 * - 只读 `safeStorage.isEncryptionAvailable()` / `getSelectedStorageBackend()` /
 *   `encryptString` / `decryptString`；**绝不**调用 `setUsePlainTextEncryption`；
 * - Linux `basic_text`/`unknown` 后端由 checkSafeStorage 统一拒绝；
 * - 本文件含 Electron 顶层 import，仅由主进程接线层引用；
 *   headless 核心单测经 ./safe-storage 注入 mock，不导入本文件。
 */
export function createElectronMobileReadonlySafeStorage(): MobileReadonlySafeStorage {
  return {
    isEncryptionAvailable: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    getSelectedStorageBackend: () => {
      try {
        return safeStorage.getSelectedStorageBackend();
      } catch {
        return 'unavailable';
      }
    },
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (data) => safeStorage.decryptString(data),
  };
}
