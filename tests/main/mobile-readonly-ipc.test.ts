import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import type { DatabaseSync } from 'node:sqlite';
import {
  MOBILE_READONLY_CHANNELS,
  type AccountSessionInfo,
  type IpcEnvelope,
  type MobileReadonlyConfigureInput,
  type MobileReadonlyStatusDto,
} from '../../src/shared/ipc';
import {
  registerIpcHandlers,
  type IpcBus,
  type IpcEvent,
  type IpcHandlerDeps,
} from '../../src/main/ipc-handlers';
import { MobileReadonlyPublishError } from '../../src/main/mobile-readonly/errors';
import type { MobileReadonlyPublicationControl } from '../../src/main/mobile-readonly/wiring';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { establishLocalSession } from '../helpers/establish-session';

/**
 * 移动只读发布 IPC（tasks 5.2 + task 1.3 完成）：
 * - 三通道与其它业务通道一致：受信主窗口 + 有效会话前置（先守卫、后触碰输入/控制面）；
 * - configure 的 token 永不回显；错误规范化（稳定 code、固定文案、不暴露栈/输入）；
 * - 未注入运行时 → 规范化不可用（绝不静默成功）；
 * - configure 不隐含启用（enabled 只由 setEnabled 变更）。
 */

interface BusResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

class FakeBus implements IpcBus {
  readonly handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  invoke(channel: string, senderId: number, ...args: unknown[]): Promise<BusResult> {
    const handler = this.handlers.get(channel);
    if (!handler) return Promise.resolve({ ok: false, error: { code: 'NOT_REGISTERED', message: `未注册通道: ${channel}` } });
    const result = handler(
      { sender: { id: senderId }, senderFrame: { url: 'http://localhost:3000/' } },
      ...args,
    ) as Promise<IpcEnvelope<unknown>> | IpcEnvelope<unknown>;
    return Promise.resolve(result).then((envelope) => (envelope as IpcEnvelope<unknown>) as BusResult);
  }
}

function makeFakeControl(): {
  control: MobileReadonlyPublicationControl;
  configureSpy: ReturnType<typeof vi.fn>;
  setEnabledSpy: ReturnType<typeof vi.fn>;
  statusSpy: ReturnType<typeof vi.fn>;
} {
  const status: MobileReadonlyStatusDto = {
    configured: true,
    enabled: false,
    target: 'https://publish.example.com',
    lastSuccessfulAt: null,
    lastFailedCode: null,
    lastFailedAt: null,
    issue: null,
  };
  const statusSpy = vi.fn(() => ({ ...status }));
  const configureSpy = vi.fn(async (input: MobileReadonlyConfigureInput) => {
    if (input.token === '') {
      throw new MobileReadonlyPublishError('EMPTY_TOKEN', '上传 token 不能为空');
    }
    return { ...status, configured: true };
  });
  const setEnabledSpy = vi.fn(async (enabled: boolean) => ({ ...status, enabled }));
  const control: MobileReadonlyPublicationControl = {
    getStatus: () => statusSpy(),
    configure: configureSpy,
    setEnabled: setEnabledSpy,
  };
  return { control, configureSpy, setEnabledSpy, statusSpy };
}

function makeContext(dir: string) {
  let db: DatabaseSync = bootstrapDatabase({ dataDir: dir }).db;
  let session: AccountSessionInfo | null = null;
  let trustedSenderId: number | null = 100;
  const accountService = () => new LocalAccountService(new SqliteAccountRepository(db));
  const controlBundle = makeFakeControl();
  let controlProvider: () => MobileReadonlyPublicationControl | null = () => controlBundle.control;
  const deps: IpcHandlerDeps = {
    db: () => db,
    dbPath: () => `${dir}/workbench.db`,
    dataDir: () => dir,
    accountService,
    session: () => session,
    setSession: (s) => {
      session = s;
    },
    trustedSenderId: () => trustedSenderId,
    trustedSenderOrigin: () => 'http://localhost:3000/',
    autoBackupError: () => null,
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    createManualBackup: vi.fn().mockResolvedValue(`${dir}/backup.db`),
    createCleanupBackup: vi.fn().mockResolvedValue(`${dir}/cleanup.db`),
    restoreFromBackup: vi.fn().mockReturnValue({ restored: false }),
    importWizardFacade: vi.fn() as unknown as () => never,
    importWizardEnabled: () => false,
    importWizardError: () => null,
    mobileReadonlyPublication: () => controlProvider(),
  };
  return {
    db,
    bus: new FakeBus(),
    deps,
    session: () => session,
    setTrustedSender: (id: number | null) => {
      trustedSenderId = id;
    },
    setSession: (s: AccountSessionInfo | null) => {
      session = s;
    },
    setControlProvider: (provider: (() => MobileReadonlyPublicationControl | null) | null) => {
      controlProvider = provider ?? (() => null);
    },
    ...controlBundle,
    close: () => closeDatabase(db),
  };
}

const STATUS_CHANNEL = MOBILE_READONLY_CHANNELS.status;
const CONFIGURE_CHANNEL = MOBILE_READONLY_CHANNELS.configure;
const SET_ENABLED_CHANNEL = MOBILE_READONLY_CHANNELS.setEnabled;
const SECRET_TOKEN = 'super-secret-upload-token-42';

async function establish(ctx: ReturnType<typeof makeContext>): Promise<void> {
  await establishLocalSession(ctx.deps.accountService, ctx.setSession);
}

describe('移动只读发布 IPC 通道（tasks 5.2）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  function setup(): ReturnType<typeof makeContext> {
    const dir = makeTempDir('mobile-readonly-ipc-');
    dirs.push(dir);
    const ctx = makeContext(dir);
    registerIpcHandlers(ctx.bus, ctx.deps);
    return ctx;
  }

  it('三通道统一受信 sender+会话守卫：非受信 sender 永不触碰控制面/输入', async () => {
    const ctx = setup();
    // 未建立会话、非受信 sender：先被受信主窗口守卫拒绝。
    const untrusted = await ctx.bus.invoke(CONFIGURE_CHANNEL, 999, { target: 'https://x.example', token: SECRET_TOKEN });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.error?.code).toBe('IPC_ACCESS_DENIED');
    expect(untrusted.error?.message).toContain('受信主窗口');
    expect(ctx.configureSpy).not.toHaveBeenCalled();
    expect(ctx.statusSpy).not.toHaveBeenCalled();
    expect(ctx.setEnabledSpy).not.toHaveBeenCalled();
    // 响应体（含错误信封）不含 token。
    expect(JSON.stringify(untrusted)).not.toContain(SECRET_TOKEN);

    await establish(ctx);
    const untrustedAfterSession = await ctx.bus.invoke(CONFIGURE_CHANNEL, 777, { target: 'https://x.example', token: SECRET_TOKEN });
    expect(untrustedAfterSession.ok).toBe(false);
    expect(untrustedAfterSession.error?.message).toContain('受信主窗口');
    expect(ctx.configureSpy).not.toHaveBeenCalled();
  });

  it('受信 sender 但未登录 → 拒绝，不触碰输入', async () => {
    const ctx = setup();
    const result = await ctx.bus.invoke(CONFIGURE_CHANNEL, 100, { target: 'https://x.example', token: SECRET_TOKEN });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('IPC_ACCESS_DENIED');
    expect(result.error?.message).toContain('登录状态已失效');
    expect(ctx.configureSpy).not.toHaveBeenCalled();
  });

  it('status/configure/setEnabled 在受信+会话下正常执行且响应不含 secret', async () => {
    const ctx = setup();
    await establish(ctx);
    const status = await ctx.bus.invoke(STATUS_CHANNEL, 100);
    expect(status.ok).toBe(true);
    expect(status.data).toMatchObject({ configured: true, enabled: false, target: 'https://publish.example.com' });
    expect(JSON.stringify(status)).not.toContain(SECRET_TOKEN);

    const configured = await ctx.bus.invoke(CONFIGURE_CHANNEL, 100, { target: 'https://publish.example.com', token: SECRET_TOKEN });
    expect(configured.ok).toBe(true);
    expect(ctx.configureSpy).toHaveBeenCalledWith({ target: 'https://publish.example.com', token: SECRET_TOKEN });
    expect(JSON.stringify(configured)).not.toContain(SECRET_TOKEN);
    // configure 不会隐含启用。
    expect(ctx.setEnabledSpy).not.toHaveBeenCalled();

    const enabled = await ctx.bus.invoke(SET_ENABLED_CHANNEL, 100, { enabled: true });
    expect(enabled.ok).toBe(true);
    expect(ctx.setEnabledSpy).toHaveBeenCalledWith(true);
  });

  it('运行错误规范化：稳定 code + 固定文案，不暴露 token/栈', async () => {
    const ctx = setup();
    await establish(ctx);
    // 注入一个非契约 Error（模拟任意意外异常，内容可能含输入）→ 全部净化。
    ctx.configureSpy.mockImplementationOnce(() => {
      throw new Error(`boom stack... token=${SECRET_TOKEN}`);
    });
    const rejected = await ctx.bus.invoke(CONFIGURE_CHANNEL, 100, { target: 'https://publish.example.com', token: SECRET_TOKEN });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('IPC_UNKNOWN');
    expect(rejected.error?.message).not.toContain('boom');
    expect(JSON.stringify(rejected)).not.toContain(SECRET_TOKEN);

    // 契约错误保留 code + 固定文案（不含 token）。
    const empty = await ctx.bus.invoke(CONFIGURE_CHANNEL, 100, { target: 'https://publish.example.com', token: '' });
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe('EMPTY_TOKEN');
    expect(JSON.stringify(empty)).not.toContain(SECRET_TOKEN);
  });

  it('未注入运行时（deps 返回 null）→ 规范化不可用，绝不静默成功', async () => {
    const ctx = setup();
    await establish(ctx);
    ctx.setControlProvider(() => null);
    const status = await ctx.bus.invoke(STATUS_CHANNEL, 100);
    expect(status.ok).toBe(false);
    expect(status.error?.code).toBe('MOBILE_READONLY_UNAVAILABLE');
    const configure = await ctx.bus.invoke(CONFIGURE_CHANNEL, 100, { target: 'https://publish.example.com', token: SECRET_TOKEN });
    expect(configure.ok).toBe(false);
    expect(configure.error?.code).toBe('MOBILE_READONLY_UNAVAILABLE');
    expect(JSON.stringify(configure)).not.toContain(SECRET_TOKEN);
  });
});
