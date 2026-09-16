import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MOBILE_READONLY_E2E_GLOBAL_KEY,
  WORKBENCH_E2E_MOBILE_READONLY_FLAG,
  WORKBENCH_E2E_USER_DATA_DIR,
  createMobileReadonlyE2eClockController,
  installMobileReadonlyE2eClockGlobal,
  isMobileReadonlyE2eClockAuthorized,
  removeMobileReadonlyE2eClockGlobal,
  type MobileReadonlyE2eClockGlobal,
} from '../../src/main/mobile-readonly/e2e-clock';
import { makeTempDir, cleanupTempDir } from '../helpers/tmp-db';

/**
 * E2E 时钟授权闸门与确定性推进（design D8 实施确认 / future 8.1、8.3 affordance）：
 * - 仅当显式 flag + userData 位于 OS 临时目录同时满足才授权；
 * - 未授权时主进程不创建任何全局（正常 renderer 无任何控制接口）；
 * - 全局仅暴露 advance/now/pending（无 token、无数据库写入等其它能力）；
 * - 注入 timer/clock 确定性：advance 触发到期调度、周期间隔可断言，不真等 2 分钟。
 */

const dirs: string[] = [];
afterEach(() => {
  removeMobileReadonlyE2eClockGlobal();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function envOf(partial: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    WORKBENCH_E2E_USER_DATA_DIR: undefined,
    WORKBENCH_E2E_MOBILE_READONLY: undefined,
    ...partial,
  } as unknown as NodeJS.ProcessEnv;
}

describe('E2E 时钟授权闸门（仅双条件同时满足）', () => {
  it('env 缺失 / 仅 flag / 非临时目录 → 全部拒绝', () => {
    const tempUserData = makeTempDir('mobile-e2e-clock-');
    dirs.push(tempUserData);

    expect(isMobileReadonlyE2eClockAuthorized(envOf({}))).toBe(false);
    // 只有 flag，没有 userData 指向临时目录
    expect(isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '1' }))).toBe(false);
    // flag + 非临时目录（生产路径、cwd、根目录）
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '1', [WORKBENCH_E2E_USER_DATA_DIR]: join(process.cwd(), 'user-data') })),
    ).toBe(false);
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '1', [WORKBENCH_E2E_USER_DATA_DIR]: '/' })),
    ).toBe(false);
  });

  it('flag + userData 为 OS 临时目录绝对后裔 → 授权', () => {
    const tempUserData = makeTempDir('mobile-e2e-clock-');
    dirs.push(tempUserData);
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '1', [WORKBENCH_E2E_USER_DATA_DIR]: tempUserData })),
    ).toBe(true);
    // flag 真值解析（非 '0'/'false' 即视为开）。
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: 'true', [WORKBENCH_E2E_USER_DATA_DIR]: tempUserData })),
    ).toBe(true);
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '0', [WORKBENCH_E2E_USER_DATA_DIR]: tempUserData })),
    ).toBe(false);
    // 相对路径（即使字面上在 tmp 内）拒绝。
    expect(
      isMobileReadonlyE2eClockAuthorized(envOf({ [WORKBENCH_E2E_MOBILE_READONLY_FLAG]: '1', [WORKBENCH_E2E_USER_DATA_DIR]: 'relative-tmp' })),
    ).toBe(false);
  });
});

describe('E2E 时钟控制器（headless，无 electron）', () => {
  it('确定性推进：到期才触发、取消即失效、pending 计数准确', async () => {
    const epochMs = Date.UTC(2026, 7, 8, 9, 0, 0);
    const controller = createMobileReadonlyE2eClockController({ epochMs });
    try {
      const fired: string[] = [];
      const handleA = controller.timer.schedule(() => fired.push('a'), 120_000);
      controller.timer.schedule(() => fired.push('b'), 120_000);
      const handleC = controller.timer.schedule(() => fired.push('c'), 240_000);
      expect(controller.pending()).toBe(3);

      await controller.advance(119_999);
      expect(fired).toEqual([]);
      expect(controller.pending()).toBe(3);
      expect(controller.clock.nowIso()).toBe(new Date(epochMs + 119_999).toISOString());

      handleA.cancel();
      handleC.cancel();
      expect(controller.pending()).toBe(1);

      await controller.advance(1);
      expect(fired).toEqual(['b']);
      expect(controller.pending()).toBe(0);
      expect(controller.clock.nowIso()).toBe(new Date(epochMs + 120_000).toISOString());
      // today 随推进更新（合成墙钟）。
      expect(controller.clock.today()).toBe(new Date(epochMs + 120_000).toISOString().slice(0, 10));
    } finally {
      controller.dispose();
    }
  });

  it('注入 timer 的周期间隔可由 advance 确定性断言（无需真等 2 分钟）', async () => {
    const controller = createMobileReadonlyE2eClockController({ epochMs: 0 });
    try {
      // 模拟引擎启动：delay 0 的启动 tick。
      const calls: number[] = [];
      controller.timer.schedule(() => calls.push(0), 0);
      await controller.advance(0);
      expect(calls).toEqual([0]);

      // 周期 ~2 分钟：推进 120000 触发一次周期回调。
      controller.timer.schedule(() => calls.push(120_000), 120_000);
      await controller.advance(119_999);
      expect(calls).toEqual([0]);
      await controller.advance(1);
      expect(calls).toEqual([0, 120_000]);
    } finally {
      controller.dispose();
    }
  });

  it('全局仅暴露 advance/now/pending，且仅在显式安装后存在（正常启动无全局）', async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    expect(globals[MOBILE_READONLY_E2E_GLOBAL_KEY]).toBeUndefined(); // 生产路径无全局

    const controller = createMobileReadonlyE2eClockController();
    installMobileReadonlyE2eClockGlobal(controller);
    const exposed = globals[MOBILE_READONLY_E2E_GLOBAL_KEY] as MobileReadonlyE2eClockGlobal;
    expect(typeof exposed.advance).toBe('function');
    expect(typeof exposed.now).toBe('function');
    expect(typeof exposed.pending).toBe('function');
    // 只暴露三个方法（无 token/数据库/网络等其它能力）。
    const keys = Object.keys(exposed).sort();
    expect(keys).toEqual(['advance', 'now', 'pending']);
    // tmpdir 相关性说明（保证 userData 规范与控制器默认路径无关）。
    expect(tmpdir().length).toBeGreaterThan(0);

    removeMobileReadonlyE2eClockGlobal();
    expect(globals[MOBILE_READONLY_E2E_GLOBAL_KEY]).toBeUndefined();
  });
});
