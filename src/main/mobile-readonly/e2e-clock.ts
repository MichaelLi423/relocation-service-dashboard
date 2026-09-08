import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { setImmediate as nodeSetImmediate } from 'node:timers';
import type { Clock } from '../../domain/core/time';
import type { MobileReadonlyTimer, MobileReadonlyTimerHandle } from './runtime';

/**
 * 主进程 E2E 时钟注入设施（design D8 实施确认；tasks 8.1/8.3 前瞻 affordance）。
 *
 * 仅当**两个闸门同时满足**才允许创建/暴露全局：
 * - 显式环境开关 `WORKBENCH_E2E_MOBILE_READONLY`（非空且非 '0'/'false'）；
 * - 既有 `WORKBENCH_E2E_USER_DATA_DIR` 为 OS 临时目录（tmpdir）的绝对后裔（非生产路径）。
 *
 * 设施只暴露 advance(ms) / now() / pending() 三个能力，不含 token、数据库写入等任何
 * 其它访问；由 Playwright `electronApp.evaluate` 在主进程侧调用。**不触发 checkNow**——
 * advance 只推进可控定时器，周期调度自然触发（跑真实引擎逻辑）。
 * 正常启动（两闸门不全满足）不创建任何全局；renderer 无任何控制 IPC。
 * 生产时钟默认系统时钟（wiring 层使用）；注入时钟为确定性合成墙钟时间（同步推进）。
 *
 * 本设施不触碰 TLS/证书校验，也不提供 safeStorage 明文回退。
 */

export const WORKBENCH_E2E_MOBILE_READONLY_FLAG = 'WORKBENCH_E2E_MOBILE_READONLY';
export const WORKBENCH_E2E_USER_DATA_DIR = 'WORKBENCH_E2E_USER_DATA_DIR';
export const MOBILE_READONLY_E2E_GLOBAL_KEY = '__workbenchMobileReadonlyE2EClock';

/** 主进程侧可被 Playwright evaluate 调用的最小全局接口（无 token/DB/网络能力）。 */
export interface MobileReadonlyE2eClockGlobal {
  /** 推进合成时间并触发到期定时器（引擎周期按自然调度执行）。 */
  advance(ms: number): Promise<void>;
  /** 当前合成墙钟时间（ISO）。 */
  now(): string;
  /** 当前待触发（未取消）定时任务数。 */
  pending(): number;
}

/** E2E 控制器接口（timer/clock 供 runtime 注入）。 */
export interface MobileReadonlyE2eClockController {
  readonly clock: Clock;
  readonly timer: MobileReadonlyTimer;
  advance(ms: number): Promise<void>;
  nowMs(): number;
  pending(): number;
  dispose(): void;
}

export interface MobileReadonlyE2eClockControllerOptions {
  /** 合成时间起点（默认当前时间，保证顺序语义一致）。 */
  epochMs?: number;
}

function envFlagOn(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/** 目标目录必须是 OS 临时目录的绝对后裔（解析符号链接后比较，拒绝生产路径/软链逃逸）。 */
function isTempDirDescendant(target: string): boolean {
  if (typeof target !== 'string' || target === '' || !isAbsolute(target)) return false;
  let realTarget: string;
  let realTmp: string;
  try {
    realTarget = realpathSync(target);
    realTmp = realpathSync(tmpdir());
  } catch {
    return false;
  }
  return realTarget === realTmp || realTarget.startsWith(`${realTmp}${sep}`);
}

/**
 * 授权闸门：两个开关必须同时满足。
 * 提取为纯函数便于 headless 测试注入 process.env 断言。
 */
export function isMobileReadonlyE2eClockAuthorized(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = env[WORKBENCH_E2E_MOBILE_READONLY_FLAG];
  const userData = env[WORKBENCH_E2E_USER_DATA_DIR];
  if (!envFlagOn(flag)) return false;
  if (!userData || !isTempDirDescendant(userData)) return false;
  return true;
}

interface PendingTask {
  id: number;
  due: number;
  callback: () => void;
  cancelled: boolean;
}

/** 创建可控定时器 + 合成时钟 + 控制器（headless 可测，无 electron 依赖）。 */
export function createMobileReadonlyE2eClockController(
  options: MobileReadonlyE2eClockControllerOptions = {},
): MobileReadonlyE2eClockController {
  const epochMs = options.epochMs ?? Date.now();
  let nowMs = epochMs;
  let nextId = 1;
  const tasks: PendingTask[] = [];

  const runDue = (): void => {
    let progressed = true;
    let guard = 0;
    while (progressed && guard < 100_000) {
      progressed = false;
      guard += 1;
      const dueTasks = tasks
        .filter((task) => !task.cancelled && task.due <= nowMs)
        .sort((a, b) => a.due - b.due || a.id - b.id);
      for (const task of dueTasks) {
        if (task.cancelled) continue;
        task.cancelled = true; // 一次性任务（runtime 每次调度新建 handle）
        try {
          task.callback();
        } catch {
          // 单任务异常不阻断后续到期任务
        }
        progressed = true;
      }
    }
  };

  const timer: MobileReadonlyTimer = {
    schedule(callback: () => void, delayMs: number): MobileReadonlyTimerHandle {
      const task: PendingTask = {
        id: nextId,
        due: nowMs + Math.max(0, delayMs),
        callback,
        cancelled: false,
      };
      nextId += 1;
      tasks.push(task);
      return {
        cancel: () => {
          task.cancelled = true;
        },
      };
    },
  };

  const clock: Clock = {
    nowIso(): string {
      return new Date(nowMs).toISOString();
    },
    today(): string {
      return new Date(nowMs).toISOString().slice(0, 10);
    },
  };

  return {
    clock,
    timer,
    nowMs: () => nowMs,
    pending: () => tasks.filter((task) => !task.cancelled).length,
    dispose: () => {
      for (const task of tasks) task.cancelled = true;
    },
    async advance(ms: number): Promise<void> {
      if (!Number.isFinite(ms) || ms < 0) return;
      nowMs += ms;
      runDue();
      // 冲刷引擎 schedule/async 微任务，使被触发的周期完成其后续调度。
      for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => nodeSetImmediate(resolve));
      }
    },
  };
}

/** 在主进程 globalThis 上安装 E2E 全局（仅授权闸门通过时由 wiring 调用）。 */
export function installMobileReadonlyE2eClockGlobal(controller: MobileReadonlyE2eClockController): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[MOBILE_READONLY_E2E_GLOBAL_KEY] = {
    advance: (ms: number) => controller.advance(ms),
    now: () => controller.clock.nowIso(),
    pending: () => controller.pending(),
  } satisfies MobileReadonlyE2eClockGlobal;
}

/** 移除 E2E 全局（wiring 释放/失败回滚时调用）。 */
export function removeMobileReadonlyE2eClockGlobal(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  delete globals[MOBILE_READONLY_E2E_GLOBAL_KEY];
}

export { isTempDirDescendant };
