import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SystemClock } from '../../domain/core/time';
import type {
  MobileReadonlyConfigureInput,
  MobileReadonlyStatusDto,
} from '../../shared/ipc';
import { createElectronMobileReadonlySafeStorage } from './electron-safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from './runtime';
import { createDefaultRemoteFactory } from './upload';
import { MobileReadonlyPublishError, MOBILE_READONLY_LOCAL_CODES } from './errors';
import {
  createMobileReadonlyE2eClockController,
  installMobileReadonlyE2eClockGlobal,
  isMobileReadonlyE2eClockAuthorized,
  removeMobileReadonlyE2eClockGlobal,
  type MobileReadonlyE2eClockController,
} from './e2e-clock';

/**
 * 移动只读发布主进程接线（tasks 5.2 / future 8.1、8.3 affordance）。
 *
 * - storageDir 使用真实 userData 下的独立目录（与 DB、backups/、import-workspace 分离）；
 * - db 提供者经 () => DatabaseSync 回读当前 holder，恢复/清理换库后不持有陈旧句柄；
 * - 生产时钟/定时器：SystemClock + 系统定时器；发布周期不做 OS 在线预检，
 *   直接以实际 HTTPS 请求结果为准（请求失败照常记录规范化失败码并在下周期重试）；
 * - safeStorage 使用 Electron 适配器（ready gate 在运行时由引擎按 checkSafeStorage 处理）；
 * - E2E：仅当 `WORKBENCH_E2E_MOBILE_READONLY` + `WORKBENCH_E2E_USER_DATA_DIR`(临时目录)
 *   两闸门满足时才创建可控时钟/定时器并安装主进程全局；
 * - 构造失败不回退、不让本地启动失败：返回降级桥（runtime_unavailable、启停安全 no-op），
 *   不创建任何网络请求。
 */

/** 处理器可用的最小发布控制面（结构上兼容 MobileReadonlyPublishRuntime 子集）。 */
export interface MobileReadonlyPublicationControl {
  getStatus(): MobileReadonlyStatusDto;
  configure(input: MobileReadonlyConfigureInput): Promise<MobileReadonlyStatusDto>;
  setEnabled(enabled: boolean): Promise<MobileReadonlyStatusDto>;
}

export interface MobileReadonlyPublicationBridge extends MobileReadonlyPublicationControl {
  start(): void;
  stop(): void;
  /** 是否处于降级（构造失败）状态。 */
  degraded(): boolean;
}

export interface MobileReadonlyPublicationBridgeOptions {
  /** 当前 userData（realpath；在 whenReady 前已重定向 E2E 临时目录时即该目录）。 */
  userDataDir: string;
  /** 当前业务库 holder（恢复/清理后指向新 db）。 */
  db(): DatabaseSync;
}

export function createMobileReadonlyPublicationBridge(
  options: MobileReadonlyPublicationBridgeOptions,
): MobileReadonlyPublicationBridge {
  const storageDir = join(options.userDataDir, 'mobile-readonly');
  let runtime: MobileReadonlyPublishRuntime | null = null;
  let e2e: MobileReadonlyE2eClockController | null = null;
  let failed = false;

  try {
    if (isMobileReadonlyE2eClockAuthorized()) {
      e2e = createMobileReadonlyE2eClockController();
      installMobileReadonlyE2eClockGlobal(e2e);
    }
    const clock = e2e?.clock ?? new SystemClock();
    const timer = e2e?.timer ?? systemMobileReadonlyTimer;
    runtime = createMobileReadonlyPublishRuntime({
      storageDir,
      db: options.db,
      clock,
      timer,
      safeStorage: createElectronMobileReadonlySafeStorage(),
      remoteFactory: createDefaultRemoteFactory(),
      onWarning: (warning) => {
        // 桌面如实提示结果状态持久化失败（不含 secret/业务内容）。
        // 接线层不做额外记录；UI 经 getStatus().issue 呈现。
        void warning;
      },
    });
  } catch {
    failed = true;
    runtime = null;
    if (e2e) {
      e2e.dispose();
      removeMobileReadonlyE2eClockGlobal();
      e2e = null;
    }
  }

  const unavailable = (): MobileReadonlyStatusDto => ({
    configured: false,
    enabled: false,
    target: null,
    lastSuccessfulAt: null,
    lastFailedCode: null,
    lastFailedAt: null,
    issue: 'runtime_unavailable',
  });

  return {
    start() {
      if (failed || runtime === null) return;
      runtime.start();
    },
    stop() {
      if (runtime) {
        try {
          runtime.stop();
        } catch {
          // 停止失败不影响退出流程
        }
      }
      if (e2e) {
        e2e.dispose();
        removeMobileReadonlyE2eClockGlobal();
        e2e = null;
      }
    },
    degraded: () => failed || runtime === null,
    getStatus() {
      return runtime ? runtime.getStatus() : unavailable();
    },
    async configure(input) {
      if (runtime === null || failed) {
        throw new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.NOT_CONFIGURED, '移动只读发布不可用（未初始化）');
      }
      return runtime.configure(input);
    },
    async setEnabled(enabled) {
      if (runtime === null || failed) {
        throw new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.NOT_CONFIGURED, '移动只读发布不可用（未初始化）');
      }
      return runtime.setEnabled(enabled);
    },
  };
}
