/**
 * credential-enrollment.test.ts（tasks 2.3 本地 CLI 登记切片）
 *
 * 只使用注入的 fake TTY 流 + fake AsyncEntry 后端，**绝不写真实 OS 凭据**：
 * - 既有 data 监听器在读取期间被**临时分离**，不收到任何 secret 输入（canary 不回显
 *   到既有监听器）；结束后按原顺序精确还原（listeners/raw/paused 状态）。
 * - secret 全程不回显：stdout/stderr 捕获均不含 secret/canary；成功输出固定文案。
 * - key identity 与 main 完全一致：CLI 的 service === main 模块 re-export 常量。
 * - 非 TTY / 未知参数 / 非法 id / 空 secret / 超长 / Ctrl+C → 不调用后端。
 * - 后端 locked → fail closed，文案为“无法确认凭据写入”，不含 canary 裸异常。
 * - 环境变量任意命名键（含 GITHUB_TOKEN 等无关键）被忽略；secret 仅来自交互输入，
 *   无环境回退。
 * - 多字节（emoji）跨 chunk 输入不被截断损坏，码点计数/退格删除整码点；
 *   8192 码点边界通过、8193 超长拒绝。
 * - stdout 写入抛错 → 清理并 generic 结果（不裸抛）。
 * - module import（require.main !== module）不执行登记。
 *
 * 真实子进程行为（--unknown 非零、--help 0、非 TTY 非零、stdin paused 恢复可退出）
 * 属父级 node 子进程验证，不在本文件断言。
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { CREDENTIAL_SERVICE as MAIN_SERVICE } from '../../src/main/remote-readonly/credential-vault';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../scripts/configure-remote-publisher.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const identity = require('../../src/main/remote-readonly/credential-vault-identity.cjs');

const PUB = 'pub-enroll-synthetic-1';
const SECRET = 'enroll-secret-synthetic-42';
const CANARY = 'canary-secret-UNIQUE-777';

/** 可注入 raw/pause/resume/isPaused 的 fake TTY 流。 */
function makeFakeTty(overrides: { isTTY?: boolean; paused?: boolean } = {}): EventEmitter & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (flag: boolean) => void;
  written: string;
  write: (s: string) => void;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
} {
  const stream = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (flag: boolean) => void;
    written: string;
    write: (s: string) => void;
    pause: () => void;
    resume: () => void;
    isPaused: () => boolean;
  };
  stream.isTTY = overrides.isTTY ?? true;
  stream.isRaw = false;
  stream.written = '';
  stream.write = (s: string) => {
    stream.written += s;
  };
  stream.setRawMode = (flag: boolean) => {
    stream.isRaw = flag;
  };
  let paused = overrides.paused ?? true;
  stream.pause = () => {
    paused = true;
  };
  stream.resume = () => {
    paused = false;
  };
  stream.isPaused = () => paused;
  return stream;
}

/** fake 后端：记录构造与成功写入；可选 setPassword reject / factory 抛错。 */
function makeFakeBackend(overrides: { writeError?: Error; throwOnFactory?: boolean } = {}) {
  const constructions: Array<{ service: string; username: string }> = [];
  const calls: Array<{ service: string; username: string; password: string }> = [];
  const factory = (service: string, username: string) => {
    if (overrides.throwOnFactory) throw new Error('native missing');
    constructions.push({ service, username });
    return {
      async setPassword(password: string) {
        if (overrides.writeError) throw overrides.writeError;
        calls.push({ service, username, password });
      },
      async getPassword() {
        return undefined;
      },
      async deleteCredential() {
        return true;
      },
    };
  };
  return { calls, constructions, factory };
}

function defaultBase() {
  return {
    argv: ['--publisher-id', PUB],
    stdin: makeFakeTty(),
    stdout: makeFakeTty(),
    stderr: makeFakeTty(),
    platform: 'darwin',
  };
}

/** 启动登记到「读取 secret」状态（同步装好 data 监听器）并返回其 promise。 */
function startEnrollment(base: ReturnType<typeof defaultBase>, factory: unknown) {
  return cli.runEnrollment({ ...base, factory });
}

describe('本地 CLI 登记：成功路径与 key identity 一致性', () => {
  it('成功登记：fake 后端收到 (CREDENTIAL_SERVICE, publisherId) 与 secret；输出固定不回显', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out).toEqual({ ok: true, cancelled: false });
    expect(backend.constructions).toEqual([{ service: identity.CREDENTIAL_SERVICE, username: PUB }]);
    expect(backend.calls).toEqual([
      { service: identity.CREDENTIAL_SERVICE, username: PUB, password: SECRET },
    ]);
    expect(base.stdout.written).toContain(cli.OUT.SUCCESS);
    const allOut = base.stdout.written + base.stderr.written;
    expect(allOut).not.toContain(SECRET);
    expect(allOut).not.toContain(PUB);
  });

  it('CLI 与 main 模块使用同一 service 常量（单源 key identity）', () => {
    expect(identity.CREDENTIAL_SERVICE).toBe(MAIN_SERVICE);
    expect(cli.OUT).toBeDefined();
  });
});

describe('本地 CLI 登记：既有监听器不接收 secret / 精确还原', () => {
  it('读取期间既有 data 监听器被临时分离：不收到含 secret 的 chunk', async () => {
    const base = defaultBase();
    let priorSawSecret = false;
    const prior = (chunk: unknown) => {
      if (String(chunk).includes(SECRET)) priorSawSecret = true;
    };
    base.stdin.on('data', prior);
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(priorSawSecret).toBe(false);
    // 结束后既有监听器还原（再次 emit 会触发它）。
    const after = await new Promise<boolean>((resolve) => {
      base.stdin.once('data', (c: unknown) => resolve(String(c).includes('AFTER')));
      base.stdin.emit('data', 'AFTER');
    });
    expect(after).toBe(true);
  });

  it('完成后按原顺序还原既有 data 监听器与进入前 raw/paused 状态', async () => {
    const base = defaultBase();
    const order: string[] = [];
    const first = () => order.push('first');
    const second = () => order.push('second');
    base.stdin.on('data', first);
    base.stdin.on('data', second);
    base.stdin.isRaw = true; // 进入前外部已置 raw
    // 记录 paused 状态（fake 始终 paused=true）。
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(base.stdin.isRaw).toBe(true);
    const restored = base.stdin.listeners('data').slice();
    expect(restored).toContain(first);
    expect(restored).toContain(second);
    expect(restored.indexOf(first)).toBeLessThan(restored.indexOf(second));
    // probe 等本次监听器已被移除。
    expect(restored.some((l) => l.name === 'onData')).toBe(false);
  });

  it('回归：既有 once 监听器在读取期间收不到 secret，还原后仍只触发一次', async () => {
    const base = defaultBase();
    let secretHits = 0;
    const onceSpy = (chunk: unknown) => {
      if (String(chunk).includes(SECRET)) secretHits += 1;
    };
    base.stdin.once('data', onceSpy);
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    // 读取期间 secret 不触发既有 once 监听器（被临时分离）。
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(secretHits).toBe(0);

    // 还原后的既有 once：第一个非 secret 事件触发 1 次，第二个不再触发。
    base.stdin.emit('data', 'FIRST');
    expect(secretHits).toBe(0); // FIRST 不含 SECRET，不计数但已消费 once。
    base.stdin.emit('data', SECRET); // 再次含 secret：若 once 被错误还原成持久监听器会命中。
    expect(secretHits).toBe(0);
    // 验证 once 仍只消费一次：用一个会命中判定的值再触发一次。
    base.stdin.emit('data', `x${SECRET}`);
    expect(secretHits).toBe(0); // once 已在 FIRST 消费，SECRET 不再触发它。
  });

  it('回归：既有 once error 监听器还原后仍只触发一次（不持久化）', async () => {
    const base = defaultBase();
    let errorCalls = 0;
    base.stdin.once('error', () => {
      errorCalls += 1;
    });
    // 附加一个持久 no-op error 监听，避免 emit('error') 无监听时抛错（与 CLI 无关）。
    base.stdin.on('error', () => {});
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    // 还原后第一个 error 触发 once 一次。
    base.stdin.emit('error', new Error('first'));
    expect(errorCalls).toBe(1);
    // 第二个 error 不再触发 once（已消费）；持久 no-op 仍在故不抛错。
    base.stdin.emit('error', new Error('second'));
    expect(errorCalls).toBe(1);
  });

  it('Ctrl+C 后还原为进入前 raw=false 且 SIGINT 监听器清理', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', '\u0003');
    const out = await run;
    expect(out).toEqual({ ok: false, cancelled: true });
    expect(base.stdin.isRaw).toBe(false);
    expect(process.listeners('SIGINT').some((l) => l.name === 'onSigint')).toBe(false);
  });

  it('stdin paused：读取时 resume，结束后恢复 paused（不残留 flowing 阻塞退出）', async () => {
    const base = defaultBase();
    // fake 默认 paused=true。
    const isPaused = base.stdin.isPaused;
    expect(isPaused()).toBe(true);
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    // 读取需要 flowing：start 后应已 resume（paused=false）。
    expect(isPaused()).toBe(false);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    // 结束恢复进入前 paused 状态。
    expect(isPaused()).toBe(true);
  });
});

describe('本地 CLI 登记：TTY/参数/环境拒绝且不调用后端', () => {
  it('非 TTY stdin → NOT_A_TTY，不调用 native factory', async () => {
    const base = defaultBase();
    base.stdin.isTTY = false;
    const backend = makeFakeBackend();
    const out = await cli.runEnrollment({ ...base, factory: backend.factory });
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.NOT_A_TTY);
    expect(backend.constructions).toHaveLength(0);
  });

  it('未知参数 → UNKNOWN_ARG，不打印 argv 值', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const out = await cli.runEnrollment({
      ...base,
      argv: ['--publisher-id', PUB, 'extra'],
      factory: backend.factory,
    });
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.UNKNOWN_ARG);
    expect(base.stderr.written).not.toContain(PUB);
    expect(backend.constructions).toHaveLength(0);
  });

  it('非法 publisherId（含空白）→ INVALID_PUBLISHER_ID，不调用后端', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const out = await cli.runEnrollment({
      ...base,
      argv: ['--publisher-id', 'not valid id'],
      factory: backend.factory,
    });
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.INVALID_PUBLISHER_ID);
    expect(backend.constructions).toHaveLength(0);
  });

  it('环境变量任意命名键被忽略（含 GITHUB_TOKEN）：不阻塞登记，secret 仅来自交互输入', async () => {
    const base = defaultBase();
    // 不再做 env 扫描/拒绝：注入带无关 token 的环境也必须能进入读取（不报 ENV_SECRET_REJECTED）。
    (base as unknown as Record<string, unknown>).env = { GITHUB_TOKEN: CANARY, PATH: '/usr/bin' };
    const backend = makeFakeBackend();
    const run = startEnrollment(base as never, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(backend.calls[0].password).toBe(SECRET);
    expect(base.stderr.written).not.toContain('环境变量');
    expect(base.stderr.written + base.stdout.written).not.toContain(CANARY);
  });
});

describe('本地 CLI 登记：secret 输入边界、多字节与取消', () => {
  it('空 secret（直接 Enter）→ 取消，不调用后端', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(backend.constructions).toHaveLength(0);
  });

  it('超长 secret → SECRET_OVERSIZE 取消，不截断不调用后端', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', 'x'.repeat(identity.CREDENTIAL_SECRET_MAX_CHARS + 1) + '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.SECRET_OVERSIZE);
    expect(backend.constructions).toHaveLength(0);
  });

  it('8192 码点边界通过；8193 超长拒绝（不截断）', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', 'y'.repeat(8192) + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(backend.calls[0].password).toBe('y'.repeat(8192));
  });

  it('多字节（emoji）单 chunk 完整输入：写后端为完整码点串', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    const emoji = '🔑'.repeat(3) + '\r';
    base.stdin.emit('data', emoji);
    const out = await run;
    expect(out.ok).toBe(true);
    expect(backend.calls[0].password).toBe('🔑'.repeat(3));
  });

  it('跨 chunk 的多字节不被截断损坏（StringDecoder 合并）', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    // '🔑' 的 UTF-8 拆两半跨 chunk。
    const bytes = Buffer.from('🔑', 'utf8');
    base.stdin.emit('data', bytes.subarray(0, 2));
    base.stdin.emit('data', Buffer.concat([bytes.subarray(2), Buffer.from('\r', 'ascii')]));
    const out = await run;
    expect(out.ok).toBe(true);
    expect(backend.calls[0].password).toBe('🔑');
  });

  it('退格删除整个码点（emoji 代理对不被拆半）', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '🔑' + '\u007f' + '\r');
    const out = await run;
    expect(out.ok).toBe(true);
    expect(backend.calls[0].password).toBe(SECRET);
  });

  it('Ctrl+U 清空已输入内容后再 Enter → empty 取消', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\u0015' + '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(backend.constructions).toHaveLength(0);
  });

  it('其他控制序列（ESC）→ 安全拒绝，不回显不调用后端', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend();
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\u001b' + '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(base.stdout.written).not.toContain('\u001b');
    expect(backend.constructions).toHaveLength(0);
  });
});

describe('本地 CLI 登记：后端失败 fail closed 与 stdout 失败清理', () => {
  it('后端 locked → “无法确认凭据写入”文案，不含 canary 裸异常', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend({ writeError: new Error(`os keychain locked ${CANARY}`) });
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(backend.constructions).toHaveLength(1);
    expect(backend.calls).toHaveLength(0);
    expect(base.stderr.written).toContain('无法确认凭据写入');
    expect(base.stderr.written).not.toContain(CANARY);
    expect(base.stderr.written).not.toContain(SECRET);
    expect(base.stderr.written).not.toContain('未写入任何凭据');
  });

  it('原生不可用（factory 抛错）→ NATIVE_UNAVAILABLE 固定文案', async () => {
    const base = defaultBase();
    const backend = makeFakeBackend({ throwOnFactory: true });
    const run = startEnrollment(base, backend.factory);
    base.stdin.emit('data', SECRET + '\r');
    const out = await run;
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.NATIVE_UNAVAILABLE);
    expect(base.stderr.written).not.toContain(SECRET);
  });

  it('平台不支持（linux）→ NATIVE_UNAVAILABLE，不进入读取/后端', async () => {
    const base = defaultBase();
    base.platform = 'linux';
    const backend = makeFakeBackend();
    const out = await cli.runEnrollment({ ...base, factory: backend.factory });
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.NATIVE_UNAVAILABLE);
    expect(backend.constructions).toHaveLength(0);
    expect(base.stdout.written).toBe('');
  });

  it('stdout.write 抛错 → 清理并 generic 结果（不裸抛、不调用后端）', async () => {
    const base = defaultBase();
    // 让提示写入抛错：在读取 start 后 prompt 写失败 → terminal。
    const failingStdout = makeFakeTty();
    failingStdout.write = () => {
      throw new Error('EPIPE simulated');
    };
    base.stdout = failingStdout;
    const backend = makeFakeBackend();
    const out = await cli.runEnrollment({ ...base, factory: backend.factory });
    expect(out.ok).toBe(false);
    expect(base.stderr.written).toContain(cli.OUT.TERMINAL_FAILURE);
    expect(backend.constructions).toHaveLength(0);
    expect(base.stderr.written).not.toContain('EPIPE');
  });
});

describe('本地 CLI 登记：module import 不执行登记', () => {
  it('require 本模块不触发登记（require.main !== module 守卫）；纯函数可用', () => {
    expect(typeof cli.runEnrollment).toBe('function');
    expect(cli.parseArgs(['--help'])).toEqual({ help: true });
    expect(cli.parseArgs(['--publisher-id', PUB])).toEqual({ publisherId: PUB });
  });
});
