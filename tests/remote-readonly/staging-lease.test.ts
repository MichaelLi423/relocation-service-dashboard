/**
 * staging-lease.test.ts（lease lane）
 *
 * 下界验证（root 校验在独立 lane，本文件假定 rootPath 已由 root lane 校验）：
 * - 生命周期：acquire → active/owner.json 固定内容/权限 → BUSY（重复/他人持有）→
 *   dispose → reacquire；dispose 幂等；markFailed 阻止活动但仍可 dispose；
 * - 不泄漏：lease 敏感字段 #private，JSON.stringify/keys 无路径/token；metadataBytes
 *   仅 root+owner 字节；
 * - 跨进程：真实 2 个 Node child 竞争同一根（用仓库既有 TypeScript 编译 lease+contract
 *   到 test 临时目录，无新依赖）只有一个 acquire 成功；SIGKILL 持有者后仍 BUSY；
 *   mkdir-only 崩溃/陈旧 mtime 的 active 一律 BUSY（无 TTL/PID/mtime 接管、不改动内容）；
 * - dispose 预检：owner 被「同字节不同 inode」/改 token/硬链接/符号链接替换，或 active
 *   被符号链接替换 → OWNER_MISMATCH 且不删除任何内容（身份校验先于 readdir，不跟随
 *   被替换的 active symlink）；active 内未知多余文件 → CLEANUP_FAILED 且全保留；
 * - guard：原始抛错（canary）收口为固定 OWNER_MISMATCH、已知 StagingError 重建保留
 *   code，acquire/assertActive/dispose 均不泄漏 canary/路径；
 * - 故障注入（Vitest 委托真实 node:fs）：unlink/rmdir 失败 → CLEANUP_FAILED 锁保留、
 *   重试安全（ownerRemoved 语义）；只清理我方 owner.json，不 rm -rf 未知内容；
 * - 权限：非 win32 断言 active 0700 / owner 0600；根内外来文件字节/权限不变。
 *
 * 全部 synthetic（临时目录），无真实业务/服务器数据；无对 root lane / 契约的修改。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import {
  acquireStagingLease,
  STAGING_ACTIVE_DIR_NAME,
  STAGING_ACTIVE_DIR_PERMISSION,
  STAGING_OWNER_FILE_NAME,
  STAGING_OWNER_FILE_PERMISSION,
  STAGING_OWNER_VERSION,
  type StagingLease,
} from '../../src/remote-readonly/ingest/staging-lease';
import { STAGING_ERROR_CODES, StagingError } from '../../src/remote-readonly/ingest/staging-contract';

const E = STAGING_ERROR_CODES;
const rootsToClean: string[] = [];

function makeRoot(): string {
  const root = join(
    realpathSync(tmpdir()),
    `staging-lease-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  return root;
}

/** 假定 root 已校验（root lane 范围之外），本文件用 no-op guard。 */
function acquireNoop(rootPath: string, rootMetadataBytes = 0): StagingLease {
  return acquireStagingLease(rootPath, rootMetadataBytes, () => undefined);
}

function activeDirOf(rootPath: string): string {
  return join(rootPath, STAGING_ACTIVE_DIR_NAME);
}

function ownerPathOf(rootPath: string): string {
  return join(activeDirOf(rootPath), STAGING_OWNER_FILE_NAME);
}

function ownerBytes(rootPath: string): string {
  return readFileSync(ownerPathOf(rootPath), 'utf8');
}

function ownerJson(rootPath: string): { version: number; token: string } {
  return JSON.parse(ownerBytes(rootPath)) as { version: number; token: string };
}

function expectFixedError(threw: unknown, code: string, markers: readonly string[] = []): void {
  expect(threw).toBeInstanceOf(StagingError);
  const err = threw as StagingError;
  expect(err.code).toBe(code);
  expect(err.message).toBe(`staging ${code}`);
  for (const marker of markers) expect(err.message).not.toContain(marker);
}

function captureSync(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function captureReject(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

/** fault 注入开关（vi.mock 委托真实模块；默认关闭，仅清理失败用例置 true）。 */
const faultState = { failUnlink: false, failRmdir: false };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (faultState.failUnlink) throw new Error('injected unlink failure');
      return (actual.unlinkSync as (...a: Parameters<typeof actual.unlinkSync>) => void)(...args);
    },
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) => {
      if (faultState.failRmdir) throw new Error('injected rmdir failure');
      return (actual.rmdirSync as (...a: Parameters<typeof actual.rmdirSync>) => void)(...args);
    },
  };
});

afterEach(() => {
  faultState.failUnlink = false;
  faultState.failRmdir = false;
  for (const root of rootsToClean) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
  rootsToClean.length = 0;
});

describe('staging-lease：acquire / 生命周期', () => {
  it('acquire 创建 active(0700)+owner.json(0600) 固定内容；dispose 后释放并可 reacquire', async () => {
    const root = makeRoot();
    const rootMetadataBytes = 37;
    const lease = acquireNoop(root, rootMetadataBytes);
    lease.assertActive(); // 刚获取时活动

    const activeDir = activeDirOf(root);
    const ownerPath = ownerPathOf(root);
    expect(existsSync(activeDir)).toBe(true);
    expect(existsSync(ownerPath)).toBe(true);
    const owner = lstatSync(ownerPath);
    expect(owner.isFile()).toBe(true);
    expect(owner.isSymbolicLink()).toBe(false);
    expect(owner.nlink).toBe(1);
    const parsed = ownerJson(root);
    expect(parsed.version).toBe(STAGING_OWNER_VERSION);
    expect(typeof parsed.token).toBe('string');
    expect(parsed.token.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(ownerBytes(root), 'utf8')).toBeLessThanOrEqual(4 * 1024);
    expect(lease.metadataBytes).toBe(rootMetadataBytes + Buffer.byteLength(ownerBytes(root), 'utf8'));

    if (process.platform !== 'win32') {
      expect(statSync(activeDir).mode & 0o777).toBe(STAGING_ACTIVE_DIR_PERMISSION);
      expect(statSync(ownerPath).mode & 0o777).toBe(STAGING_OWNER_FILE_PERMISSION);
    }

    await lease.dispose();
    expect(existsSync(activeDir)).toBe(false);
    expect(existsSync(ownerPath)).toBe(false);
    // dispose 幂等
    await lease.dispose();
    expect(existsSync(activeDir)).toBe(false);
    // 释放后可 reacquire
    const lease2 = acquireNoop(root, rootMetadataBytes);
    await lease2.dispose();
  });

  it('持有期间再次 acquire → BUSY，且不触碰既有 active/owner', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const ownerBefore = ownerBytes(root);
    const stBefore = statSync(ownerPathOf(root));
    const threw = captureSync(() => acquireNoop(root));
    expectFixedError(threw, E.BUSY, [root]);
    // 已有 active 从未被接管/修改
    expect(ownerBytes(root)).toBe(ownerBefore);
    expect(statSync(ownerPathOf(root)).ino).toBe(stBefore.ino);
    lease.assertActive();
    await lease.dispose();
    acquireNoop(root); // 释放后可用
  });

  it('根内既有外来文件（root 其它条目）不被 lease 触碰', async () => {
    const root = makeRoot();
    const foreign = join(root, 'foreign-root-file.txt');
    writeFileSync(foreign, 'keep-me', 'utf8');
    let mode = 0;
    if (process.platform !== 'win32') {
      chmodSync(foreign, 0o640);
      mode = statSync(foreign).mode & 0o777;
    }
    const lease = acquireNoop(root);
    await lease.dispose();
    expect(readFileSync(foreign, 'utf8')).toBe('keep-me');
    if (process.platform !== 'win32') expect(statSync(foreign).mode & 0o777).toBe(mode);
  });

  it('lease 不外泄路径/token：#private 字段不进 JSON/keys/toString', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const token = ownerJson(root).token;
    const json = JSON.stringify(lease);
    expect(json).toBe('{}');
    expect(Object.keys(lease)).toEqual([]);
    expect(JSON.stringify(lease)).not.toContain(token);
    expect(JSON.stringify(lease)).not.toContain(root);
    expect(String(lease)).not.toContain(root);
    expect(String(lease)).not.toContain(token);
    expect(typeof lease.metadataBytes).toBe('number');
    await lease.dispose();
  });

  it('markFailed 阻止 assertActive 但 dispose 仍可清理并释放', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    lease.markFailed();
    const threw = captureSync(() => lease.assertActive());
    expectFixedError(threw, E.INVALID_STATE);
    // markFailed 幂等
    lease.markFailed();
    await lease.dispose();
    expect(existsSync(activeDirOf(root))).toBe(false);
    // 释放后 markFailed/assertActive 均拒绝
    expectFixedError(captureSync(() => lease.markFailed()), E.INVALID_STATE);
    expectFixedError(captureSync(() => lease.assertActive()), E.INVALID_STATE);
    // 锁确实释放
    const lease2 = acquireNoop(root);
    await lease2.dispose();
  });

  it('非法入参 → INVALID_CONFIG', () => {
    const root = makeRoot();
    const goodGuard = (): void => undefined;
    expectFixedError(captureSync(() => acquireStagingLease('', 0, goodGuard)), E.INVALID_CONFIG);
    expectFixedError(
      captureSync(() => acquireStagingLease(root, -1, goodGuard)),
      E.INVALID_CONFIG,
    );
    expectFixedError(
      captureSync(() => acquireStagingLease(root, 0, null as unknown as () => void)),
      E.INVALID_CONFIG,
    );
  });
});

describe('staging-lease：既有 active 一律 BUSY（无 TTL/PID/mtime 接管）', () => {
  it('mkdir-only 崩溃（空 active/）→ BUSY，目录仍为空', () => {
    const root = makeRoot();
    const activeDir = activeDirOf(root);
    mkdirSync(activeDir, { mode: 0o700 });
    const threw = captureSync(() => acquireNoop(root));
    expectFixedError(threw, E.BUSY, [root]);
    expect(readdirSync(activeDir)).toEqual([]);
  });

  it('陈旧 mtime + 外来 owner 的崩溃残留 → BUSY；内容/inode/mtime 均不被改动', () => {
    const root = makeRoot();
    const activeDir = activeDirOf(root);
    const ownerPath = ownerPathOf(root);
    mkdirSync(activeDir, { mode: 0o700 });
    const foreignOwner = JSON.stringify({ version: 1, token: 'crashed-foreign-owner' });
    writeFileSync(ownerPath, foreignOwner, 'utf8');
    const old = new Date('2001-02-03T04:05:06.000Z');
    utimesSync(activeDir, old, old);
    utimesSync(ownerPath, old, old);
    const stBefore = statSync(activeDir);
    const ownerInoBefore = statSync(ownerPath).ino;

    const threw = captureSync(() => acquireNoop(root));
    expectFixedError(threw, E.BUSY, [root]);
    expect(readFileSync(ownerPath, 'utf8')).toBe(foreignOwner);
    expect(statSync(ownerPath).ino).toBe(ownerInoBefore);
    expect(statSync(activeDir).mtimeMs).toBe(stBefore.mtimeMs);
  });
});

describe('staging-lease：dispose 预检（篡改一律拒绝且不删除）', () => {
  it('owner 被「同字节不同 inode」替换 → OWNER_MISMATCH，不删除', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const ownerPath = ownerPathOf(root);
    const original = ownerBytes(root);
    const inoBefore = statSync(ownerPath).ino;
    unlinkSync(ownerPath);
    writeFileSync(ownerPath, original, 'utf8'); // 同内容、新 inode
    expect(statSync(ownerPath).ino).not.toBe(inoBefore);

    expectFixedError(captureSync(() => lease.assertActive()), E.OWNER_MISMATCH);
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH, [root]);
    // 不删除任何内容：owner 仍在（内容未变），active 仍在 → 仍 BUSY
    expect(ownerBytes(root)).toBe(original);
    expect(existsSync(activeDirOf(root))).toBe(true);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);
  });

  it('owner token 被改动 → OWNER_MISMATCH，不删除', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const ownerPath = ownerPathOf(root);
    const original = ownerBytes(root);
    writeFileSync(ownerPath, JSON.stringify({ version: 1, token: 'tampered-token' }), 'utf8');

    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH);
    expect(readFileSync(ownerPath, 'utf8')).not.toBe(original);
    expect(existsSync(activeDirOf(root))).toBe(true);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);
  });

  it('owner 被硬链接（nlink>1）→ OWNER_MISMATCH，不删除', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const ownerPath = ownerPathOf(root);
    const extraLink = join(root, 'owner-extra-link');
    linkSync(ownerPath, extraLink);
    expect(lstatSync(ownerPath).nlink).toBe(2);

    expectFixedError(captureSync(() => lease.assertActive()), E.OWNER_MISMATCH);
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH);
    expect(existsSync(ownerPath)).toBe(true);
    expect(readdirSync(activeDirOf(root))).toEqual([STAGING_OWNER_FILE_NAME]);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);
  });

  it('owner 被符号链接替换 → OWNER_MISMATCH，目标内容不被读取/删除', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const ownerPath = ownerPathOf(root);
    const target = join(root, 'foreign-target.txt');
    writeFileSync(target, 'secret-foreign', 'utf8');
    unlinkSync(ownerPath);
    symlinkSync(target, ownerPath);

    expectFixedError(captureSync(() => lease.assertActive()), E.OWNER_MISMATCH);
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH);
    expect(lstatSync(ownerPath).isSymbolicLink()).toBe(true); // 链接本身未被删除
    expect(readFileSync(target, 'utf8')).toBe('secret-foreign');
  });

  it('active/ 被替换为指向外来目录的符号链接 → OWNER_MISMATCH（身份先于 readdir，不跟随）', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const activeDir = activeDirOf(root);
    const foreign = join(root, 'foreign-target-dir');
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, 'sentinel.txt'), 'foreign-bytes', 'utf8');
    rmSync(activeDir, { recursive: true, force: true });
    symlinkSync(foreign, activeDir);

    expectFixedError(captureSync(() => lease.assertActive()), E.OWNER_MISMATCH);
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH, [root]);
    // 若 dispose 先 readdir 就会读到 foreign 内容；此处必须在身份校验阶段拒绝
    expect(lstatSync(activeDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(foreign, 'sentinel.txt'), 'utf8')).toBe('foreign-bytes');
    expect(readdirSync(foreign)).toEqual(['sentinel.txt']);
  });

  it('active/ 内未知多余文件 → 预检拒绝（CLEANUP_FAILED）且全保留；移除后可重试', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    const activeDir = activeDirOf(root);
    const originalOwner = ownerBytes(root);
    const rogue = join(activeDir, 'rogue.txt');
    writeFileSync(rogue, 'rogue-content', 'utf8');

    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.CLEANUP_FAILED, [root]);
    // 删除前拒绝：owner 与 rogue 都原样保留，active 仍在 → BUSY
    expect(ownerBytes(root)).toBe(originalOwner);
    expect(readFileSync(rogue, 'utf8')).toBe('rogue-content');
    expect(existsSync(activeDir)).toBe(true);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);

    // 人工移除未知文件后 dispose 重试成功（不删 root 其它内容）
    unlinkSync(rogue);
    await lease.dispose();
    expect(existsSync(activeDir)).toBe(false);
    const lease2 = acquireNoop(root);
    await lease2.dispose();
  });
});

describe('staging-lease：guard 错误收口', () => {
  it('acquire 时 guard 原始抛错（canary）→ 固定 OWNER_MISMATCH，且不创建 active', () => {
    const root = makeRoot();
    const canary = 'CANARY-GUARD-ACQUIRE-99';
    const guard = (): void => {
      throw new Error(canary);
    };
    const threw = captureSync(() => acquireStagingLease(root, 0, guard));
    expectFixedError(threw, E.OWNER_MISMATCH, [canary, root]);
    expect(existsSync(activeDirOf(root))).toBe(false);
  });

  it('acquire 时 guard 抛已知 StagingError → 重建保留原 code', () => {
    const root = makeRoot();
    const guard = (): never => {
      throw new StagingError(E.UNSAFE_PATH);
    };
    const threw = captureSync(() => acquireStagingLease(root, 0, guard));
    expectFixedError(threw, E.UNSAFE_PATH, [root]);
    expect(existsSync(activeDirOf(root))).toBe(false);
  });

  it('assertActive/dispose 时 guard 晚抛原始错误 → 固定 OWNER_MISMATCH 无 canary；已知 code 保留', async () => {
    const root = makeRoot();
    const canary = 'CANARY-GUARD-LATE-42';
    let calls = 0;
    const guard = (): void => {
      calls += 1;
      if (calls > 1) throw new Error(canary);
    };
    const lease = acquireStagingLease(root, 0, guard); // 第 1 次 guard 通过
    expectFixedError(captureSync(() => lease.assertActive()), E.OWNER_MISMATCH, [canary, root]);
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.OWNER_MISMATCH, [canary, root]);

    // 已知 code 保留（重建而非吞成其它 code）
    const root2 = makeRoot();
    let calls2 = 0;
    const guard2 = (): void => {
      calls2 += 1;
      if (calls2 > 1) throw new StagingError(E.INVALID_STATE);
    };
    const lease2 = acquireStagingLease(root2, 0, guard2);
    expectFixedError(captureSync(() => lease2.assertActive()), E.INVALID_STATE);
    await lease2.dispose().catch(() => undefined); // guard 已坏，dispose 也会固定报错，交由 afterEach 清理
  });
});

describe('staging-lease：dispose 故障注入（锁保留 / 重试安全）', () => {
  it('unlink owner 失败 → CLEANUP_FAILED 锁保留；恢复后可重试并释放', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    faultState.failUnlink = true;
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.CLEANUP_FAILED);
    // owner 与 active 都保留 → 锁仍在（BUSY）
    expect(existsSync(ownerPathOf(root))).toBe(true);
    expect(existsSync(activeDirOf(root))).toBe(true);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);

    faultState.failUnlink = false;
    await lease.dispose(); // 重试成功
    expect(existsSync(activeDirOf(root))).toBe(false);
    const lease2 = acquireNoop(root);
    await lease2.dispose();
  });

  it('rmdir active 失败（owner 已删）→ CLEANUP_FAILED 锁保留；重试完成释放（ownerRemoved 语义）', async () => {
    const root = makeRoot();
    const lease = acquireNoop(root);
    faultState.failRmdir = true;
    const threw = await captureReject(() => lease.dispose());
    expectFixedError(threw, E.CLEANUP_FAILED);
    // owner 已删除、active 仍存在（空）→ 后续 BUSY（mkdir-only 同类崩溃状态）
    expect(existsSync(ownerPathOf(root))).toBe(false);
    expect(existsSync(activeDirOf(root))).toBe(true);
    expect(readdirSync(activeDirOf(root))).toEqual([]);
    expectFixedError(captureSync(() => acquireNoop(root)), E.BUSY);

    faultState.failRmdir = false;
    await lease.dispose(); // 重试：跳过 owner，直接 rmdir
    expect(existsSync(activeDirOf(root))).toBe(false);
    const lease2 = acquireNoop(root);
    await lease2.dispose();
  });
});

describe('staging-lease：跨进程竞争（真实 2 个 Node child）', () => {
  function compileChildModules(outDir: string): string {
    const ingestDir = join(process.cwd(), 'src', 'remote-readonly', 'ingest');
    const options: ts.TranspileOptions = {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    };
    const contractCode = readFileSync(join(ingestDir, 'staging-contract.ts'), 'utf8');
    writeFileSync(join(outDir, 'staging-contract.js'), ts.transpileModule(contractCode, options).outputText, 'utf8');
    const leaseCode = readFileSync(join(ingestDir, 'staging-lease.ts'), 'utf8');
    const leaseJsPath = join(outDir, 'staging-lease.js');
    writeFileSync(leaseJsPath, ts.transpileModule(leaseCode, options).outputText, 'utf8');
    return leaseJsPath;
  }

  function writeChildRunner(outDir: string, leaseJsPath: string): string {
    const runner = `'use strict';
const { acquireStagingLease } = require(${JSON.stringify(leaseJsPath)});
const cfg = JSON.parse(process.argv[2]);
try {
  acquireStagingLease(cfg.rootPath, cfg.rootMetadataBytes, () => {});
  console.log('ACQUIRED');
  setInterval(() => {}, 1 << 30);
} catch (err) {
  console.log('REJECTED:' + err.code);
  process.exit(0);
}
`;
    const runnerPath = join(outDir, 'runner.cjs');
    writeFileSync(runnerPath, runner, 'utf8');
    return runnerPath;
  }

  interface SpawnedChild {
    child: ChildProcess;
    output: () => string;
    exited: Promise<number | null>;
  }

  function spawnAcquireChild(
    runnerPath: string,
    cfg: { rootPath: string; rootMetadataBytes: number },
  ): SpawnedChild {
    const child = spawn(process.execPath, [runnerPath, JSON.stringify(cfg)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      out += `[stderr]${chunk}`;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
    });
    return { child, output: () => out, exited };
  }

  async function killChild(c: SpawnedChild): Promise<void> {
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await c.exited;
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitUntil timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function childEnv(root: string): { rootPath: string; rootMetadataBytes: number } {
    return { rootPath: root, rootMetadataBytes: 0 };
  }

  it('两个真实 child 竞争同一根：仅一个 ACQUIRED，另一个 STAGING_BUSY', async () => {
    const work = makeRoot();
    const rootPath = join(work, 'root');
    mkdirSync(rootPath, { mode: 0o700 });
    const outDir = join(work, 'out');
    mkdirSync(outDir, { mode: 0o700 });
    const leaseJsPath = compileChildModules(outDir);
    const runnerPath = writeChildRunner(outDir, leaseJsPath);
    const cfg = childEnv(rootPath);

    const a = spawnAcquireChild(runnerPath, cfg);
    const b = spawnAcquireChild(runnerPath, cfg);
    try {
      await waitUntil(() => a.output() !== '' && b.output() !== '');
    } finally {
      await killChild(a);
      await killChild(b);
    }
    const combined = a.output() + b.output();
    const acquired = (a.output().includes('ACQUIRED') ? 1 : 0) + (b.output().includes('ACQUIRED') ? 1 : 0);
    const rejectedBusy =
      (a.output().includes('REJECTED:STAGING_BUSY') ? 1 : 0) +
      (b.output().includes('REJECTED:STAGING_BUSY') ? 1 : 0);
    expect(combined).not.toContain(rootPath);
    expect(acquired).toBe(1);
    expect(rejectedBusy).toBe(1);
  }, 30000);

  it('SIGKILL 持有者后 active/owner 残留 → 再次 acquire BUSY；残留内容未被改写', async () => {
    const work = makeRoot();
    const rootPath = join(work, 'root');
    mkdirSync(rootPath, { mode: 0o700 });
    const outDir = join(work, 'out');
    mkdirSync(outDir, { mode: 0o700 });
    const leaseJsPath = compileChildModules(outDir);
    const runnerPath = writeChildRunner(outDir, leaseJsPath);

    const holder = spawnAcquireChild(runnerPath, childEnv(rootPath));
    await waitUntil(() => holder.output().includes('ACQUIRED'));
    const ownerBefore = readFileSync(ownerPathOf(rootPath), 'utf8');
    const ownerInoBefore = statSync(ownerPathOf(rootPath)).ino;
    await killChild(holder); // SIGKILL：无任何清理
    expect(existsSync(activeDirOf(rootPath))).toBe(true);
    expect(existsSync(ownerPathOf(rootPath))).toBe(true);

    const threw = captureSync(() => acquireNoop(rootPath));
    expectFixedError(threw, E.BUSY, [rootPath]);
    expect(readFileSync(ownerPathOf(rootPath), 'utf8')).toBe(ownerBefore);
    expect(statSync(ownerPathOf(rootPath)).ino).toBe(ownerInoBefore);
  }, 30000);
});
