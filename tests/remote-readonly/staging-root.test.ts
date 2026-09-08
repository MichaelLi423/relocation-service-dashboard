/**
 * staging-root.test.ts（root lane 聚焦单测；只写本文件与 staging-root.ts）
 *
 * - 真实私有临时 parent（mkdtemp 0700）+ 受保护哨兵目录/文件；POSIX 权限/符号链接/
 *   硬链接断言仅对当前非 win32 平台（套件整体 skipIf(win32)，不在 Windows 声称 ACL）。
 * - 覆盖：创建/重开（显式 format 标记、根 0700/标记 0600、nlink=1、不重写）；已存在外部
 *   根缺标记/错标记与模拟 mkdir EEXIST 输家 → 拒绝且零写入零 chmod；双向重叠（含未来
 *   缺路径与字面 '..'、`symlink/../` 的 realpath 真实语义）；非 ENOENT fail-closed；parent/root/marker 符号链接与 marker
 *   硬链接拒绝；受保护别名后期重定向向根、调用方改配置数组不影响原保护；inspect 各状态
 *   只读：idle/occupied/空 active/未知条目/坏 owner/被篡改标记 → 固定 recovery_required，
 *   不删除不修复；JSON/keys/toString 不含根路径与 token；原生错误一律固定 StagingError，
 *   消息不回显输入路径。
 * - lease 的原子 claim / 跨进程竞态由 staging-lease.test.ts 覆盖，本文件不重复（仅验证
 *   tryAcquire 委托后的稳定核心接口）。全部 synthetic 临时目录，无真实业务数据。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  openStagingRoot,
  STAGING_ROOT_DIR_NAME,
  STAGING_ROOT_MARKER_FILE_NAME,
  STAGING_ROOT_MARKER_FORMAT,
  STAGING_ROOT_MARKER_VERSION,
  STAGING_ROOT_DIR_PERMISSION,
  STAGING_ROOT_MARKER_PERMISSION,
} from '../../src/remote-readonly/ingest/staging-root';
import {
  STAGING_ACTIVE_DIR_NAME,
  STAGING_OWNER_FILE_NAME,
  STAGING_OWNER_VERSION,
} from '../../src/remote-readonly/ingest/staging-lease';
import { STAGING_ERROR_CODES, StagingError } from '../../src/remote-readonly/ingest/staging-contract';

const E = STAGING_ERROR_CODES;
const MARKER_TEXT = JSON.stringify({
  format: STAGING_ROOT_MARKER_FORMAT,
  version: STAGING_ROOT_MARKER_VERSION,
});
const LEGACY_MARKER = '{"version":1}';
const UUID = '11111111-2222-4333-8444-555555555555'; // 规范小写 v4

const toClean: string[] = [];

afterEach(() => {
  for (const p of toClean) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
  toClean.length = 0;
});

function fresh(): { temp: string; protectedDir: string; sentinel: string; sentinelBytes: Buffer } {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'staging-root-test-'));
  toClean.push(temp);
  const protectedDir = join(temp, 'protected-a');
  mkdirSync(protectedDir, { mode: 0o700 });
  const sentinel = join(protectedDir, 'sentinel.bin');
  const sentinelBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  writeFileSync(sentinel, sentinelBytes);
  return { temp, protectedDir, sentinel, sentinelBytes };
}

const rootDirOf = (temp: string): string => join(temp, STAGING_ROOT_DIR_NAME);
const markerOf = (temp: string): string =>
  join(rootDirOf(temp), STAGING_ROOT_MARKER_FILE_NAME);
const activeOf = (rootDir: string): string => join(rootDir, STAGING_ACTIVE_DIR_NAME);
const ownerOf = (rootDir: string): string => join(activeOf(rootDir), STAGING_OWNER_FILE_NAME);

function expectFixedError(threw: unknown, code: string, noLeak: readonly string[] = []): void {
  expect(threw).toBeInstanceOf(StagingError);
  const err = threw as StagingError;
  expect(err.code).toBe(code);
  expect(err.message).toBe(`staging ${code}`);
  for (const m of noLeak) expect(err.message).not.toContain(m);
}

function captureSync(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function captureReject(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

/** 重叠场景统一断言：UNSAFE_PATH，且失败发生在任何创建之前。 */
function expectOverlapRejected(parentDir: string, protectedPaths: readonly string[]): void {
  const rootDir = rootDirOf(parentDir);
  const threw = captureSync(() => openStagingRoot({ privateParentDir: parentDir, protectedPaths }));
  expectFixedError(threw, E.UNSAFE_PATH, [parentDir]);
  expect(existsSync(rootDir)).toBe(false);
}

describe.skipIf(process.platform === 'win32')('staging-root：创建与重开', () => {
  it('首次 open 创建 0700 根 + 显式 format 标记(0600/nlink1)；inspect idle；不动受保护哨兵', () => {
    const { temp, protectedDir, sentinel, sentinelBytes } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });

    const rootDir = rootDirOf(temp);
    const st = lstatSync(rootDir);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.mode & 0o777).toBe(STAGING_ROOT_DIR_PERMISSION);
    expect(readdirSync(rootDir)).toEqual([STAGING_ROOT_MARKER_FILE_NAME]);

    const mk = statSync(markerOf(temp));
    expect(mk.isFile()).toBe(true);
    expect(mk.nlink).toBe(1);
    expect(mk.mode & 0o777).toBe(STAGING_ROOT_MARKER_PERMISSION);
    expect(mk.size).toBeLessThanOrEqual(4 * 1024);
    expect(readFileSync(markerOf(temp), 'utf8')).toBe(MARKER_TEXT);

    expect(root.inspect()).toEqual({ state: 'idle', contentBytes: mk.size });

    // 受保护哨兵与权限原样
    expect(readFileSync(sentinel)).toEqual(sentinelBytes);
    expect(statSync(protectedDir).mode & 0o777).toBe(0o700);
  });

  it('重开已属我方的根：标记不重写（inode/内容/权限不变）', () => {
    const { temp, protectedDir } = fresh();
    openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const markerPath = markerOf(temp);
    const before = statSync(markerPath);

    const reopened = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const after = statSync(markerPath);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(markerPath, 'utf8')).toBe(MARKER_TEXT);
    expect(after.mode & 0o777).toBe(STAGING_ROOT_MARKER_PERMISSION);
    expect(reopened.inspect()).toEqual({ state: 'idle', contentBytes: after.size });
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：既有外部根拒绝且零写入', () => {
  it('缺标记的外部根 → OWNER_MISMATCH，不写标记、目录保持原样', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    mkdirSync(rootDir, { mode: 0o700 });
    chmodSync(rootDir, 0o700);
    const markerPath = markerOf(temp);

    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp, rootDir]);
    expect(existsSync(markerPath)).toBe(false);
    expect(readdirSync(rootDir)).toEqual([]);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
  });

  it('旧版无 format 标记 `{"version":1}` → OWNER_MISMATCH，不改写/不 chmod', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    mkdirSync(rootDir, { mode: 0o700 });
    const markerPath = markerOf(temp);
    writeFileSync(markerPath, LEGACY_MARKER, { encoding: 'utf8', mode: STAGING_ROOT_MARKER_PERMISSION });
    chmodSync(rootDir, 0o700);
    const before = statSync(markerPath);

    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp, rootDir]);
    const after = statSync(markerPath);
    expect(readFileSync(markerPath, 'utf8')).toBe(LEGACY_MARKER);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(STAGING_ROOT_MARKER_PERMISSION);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(rootDir)).toEqual([STAGING_ROOT_MARKER_FILE_NAME]);
  });

  it('模拟 mkdir EEXIST 输家（竞态外部根已存在、无我方标记）→ OWNER_MISMATCH，不留标记', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    mkdirSync(rootDir, { mode: 0o700 }); // 相当于并发“赢家”刚创建的目录
    const markerPath = markerOf(temp);

    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(existsSync(markerPath)).toBe(false);
    expect(readdirSync(rootDir)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：受保护路径重叠（双向/未来缺路径/..）', () => {
  it('受保护路径是根的祖先/相等 → UNSAFE_PATH 且不创建', () => {
    const { temp, protectedDir } = fresh();
    expectOverlapRejected(temp, [temp]); // parent 本身（祖先）
    expectOverlapRejected(temp, [dirname(temp)]); // 更上层祖先
    expectOverlapRejected(temp, [rootDirOf(temp)]); // 相等（叶尚不存在）
    void protectedDir;
  });

  it('受保护路径位于未来根之内（含尚不存在）→ UNSAFE_PATH', () => {
    const { temp } = fresh();
    expectOverlapRejected(temp, [join(temp, STAGING_ROOT_DIR_NAME, 'cache', 'db')]);
    expectOverlapRejected(temp, [join(temp, STAGING_ROOT_DIR_NAME, 'x', '..', 'db')]);
  });

  it("受保护路径用 '..' 引用候选根/根内（真实目录，无符号链接）→ UNSAFE_PATH", () => {
    const { temp } = fresh();
    const inside = join(temp, 'alias-a');
    mkdirSync(inside, { mode: 0o700 });
    // join() 已把 alias-a/.. 折叠；语义 = <temp>/remote-readonly-staging
    expectOverlapRejected(temp, [join(inside, '..', STAGING_ROOT_DIR_NAME)]);
  });

  it('字面 `${alias}/../${ROOT_NAME}`：symlink+.. 物理目标恰是候选根 → UNSAFE_PATH，创建前拒绝', () => {
    const { temp } = fresh();
    const privateParent = join(temp, 'private-parent');
    mkdirSync(privateParent, { mode: 0o700 });
    const child = join(privateParent, 'child');
    mkdirSync(child, { mode: 0o700 });
    // alias 位于 privateParent 外，词法折叠会错误地把保护目标算到 temp 下。
    const alias = join(temp, 'alias-link');
    symlinkSync(child, alias); // alias -> <privateParent>/child
    const literal = `${alias}/../${STAGING_ROOT_DIR_NAME}`; // 保留字面 '..'，不可用 path.join
    expectOverlapRejected(privateParent, [literal]);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it('字面 `${alias}/../${ROOT_NAME}`：symlink 目标在外部 → 物理目标根外，放行且不创建外部目标', () => {
    const { temp, protectedDir } = fresh();
    const outside = mkdtempSync(join(dirname(temp), 'staging-root-outside-'));
    toClean.push(outside);
    const child = join(outside, 'child');
    mkdirSync(child, { mode: 0o700 });
    const alias = join(temp, 'alias-out');
    symlinkSync(child, alias); // alias -> <外部>/child
    const literal = `${alias}/../${STAGING_ROOT_DIR_NAME}`; // 词法看似 temp/root，实际解析到外部
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [literal, protectedDir] });
    expect(root.inspect().state).toBe('idle');
    expect(existsSync(rootDirOf(temp))).toBe(true);
    expect(existsSync(join(outside, STAGING_ROOT_DIR_NAME))).toBe(false); // 不创建外部目标
  });

  it('不相交的未来缺路径（受保护目录下）放行', () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({
      privateParentDir: temp,
      protectedPaths: [protectedDir, join(protectedDir, 'future', 'sub')],
    });
    expect(root.inspect().state).toBe('idle');
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：非 ENOENT fail-closed', () => {
  it('受保护路径中间组件是普通文件 → IO_FAILED，不创建根', () => {
    const { temp, protectedDir } = fresh();
    const afile = join(temp, 'afile');
    writeFileSync(afile, 'plain', 'utf8');
    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [join(afile, 'sub')] }),
    );
    expectFixedError(threw, E.IO_FAILED, [temp]);
    expect(existsSync(rootDirOf(temp))).toBe(false);
    expect(readFileSync(afile, 'utf8')).toBe('plain');
    void protectedDir;
  });

  it('根位置是普通文件 → IO_FAILED（ENOTDIR），文件原样、无标记', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    writeFileSync(rootDir, 'i-am-a-file', 'utf8');
    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.IO_FAILED, [temp, rootDir]);
    expect(readFileSync(rootDir, 'utf8')).toBe('i-am-a-file');
    expect(existsSync(markerOf(temp))).toBe(false);
  });

  it('parent 不存在 / 是普通文件 → INVALID_CONFIG', () => {
    const { temp, protectedDir } = fresh();
    expectFixedError(
      captureSync(() =>
        openStagingRoot({ privateParentDir: join(temp, 'missing'), protectedPaths: [protectedDir] }),
      ),
      E.INVALID_CONFIG,
      [temp],
    );
    const fileParent = join(temp, 'parent-file');
    writeFileSync(fileParent, 'plain', 'utf8');
    expectFixedError(
      captureSync(() =>
        openStagingRoot({ privateParentDir: fileParent, protectedPaths: [protectedDir] }),
      ),
      E.INVALID_CONFIG,
      [temp],
    );
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：符号链接/硬链接拒绝', () => {
  it('parent 为符号链接 → UNSAFE_PATH', () => {
    const { temp, protectedDir } = fresh();
    const target = join(temp, 'real-parent');
    mkdirSync(target, { mode: 0o700 });
    const alias = join(temp, 'alias-parent');
    symlinkSync(target, alias);
    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: alias, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.UNSAFE_PATH, [temp]);
  });

  it('root 为符号链接（指向含我方标记的目录）→ OWNER_MISMATCH，目标不动', () => {
    const { temp, protectedDir } = fresh();
    const target = join(temp, 'foreign-root');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, STAGING_ROOT_MARKER_FILE_NAME), MARKER_TEXT, {
      encoding: 'utf8',
      mode: STAGING_ROOT_MARKER_PERMISSION,
    });
    const rootDir = rootDirOf(temp);
    symlinkSync(target, rootDir);
    const targetBefore = readFileSync(join(target, STAGING_ROOT_MARKER_FILE_NAME), 'utf8');

    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(lstatSync(rootDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, STAGING_ROOT_MARKER_FILE_NAME), 'utf8')).toBe(targetBefore);
  });

  it('marker 为符号链接 → OWNER_MISMATCH，目标内容不被读取写入', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    mkdirSync(rootDir, { mode: 0o700 });
    const real = join(temp, 'real-marker.txt');
    writeFileSync(real, MARKER_TEXT, { encoding: 'utf8', mode: STAGING_ROOT_MARKER_PERMISSION });
    symlinkSync(real, markerOf(temp));
    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(lstatSync(markerOf(temp)).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(MARKER_TEXT);
  });

  it('marker 为硬链接（nlink>1）→ OWNER_MISMATCH', () => {
    const { temp, protectedDir } = fresh();
    const rootDir = rootDirOf(temp);
    mkdirSync(rootDir, { mode: 0o700 });
    const markerPath = markerOf(temp);
    writeFileSync(markerPath, MARKER_TEXT, { encoding: 'utf8', mode: STAGING_ROOT_MARKER_PERMISSION });
    linkSync(markerPath, join(temp, 'marker-extra-link'));
    expect(statSync(markerPath).nlink).toBe(2);
    const threw = captureSync(() =>
      openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] }),
    );
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(statSync(markerPath).nlink).toBe(2);
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：受保护别名重定向与配置数组变更', () => {
  it('open 后受保护目录被替换为指向根的符号链接 → acquire/inspect 拒绝，无 active 残留', async () => {
    const { temp, protectedDir } = fresh();
    const arr = [protectedDir];
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: arr });

    // 调用方后续变更数组（清空并加入根自身）不影响已保存的保护副本
    arr.length = 0;
    arr.push(rootDirOf(temp));
    // 原保护路径被重定向指向根
    rmSync(protectedDir, { recursive: true, force: true });
    symlinkSync(rootDirOf(temp), protectedDir);

    const threw = await captureReject(() => root.tryAcquire());
    expectFixedError(threw, E.OWNER_MISMATCH, [temp, rootDirOf(temp)]);
    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
    expect(existsSync(activeOf(rootDirOf(temp)))).toBe(false);
    expect(lstatSync(protectedDir).isSymbolicLink()).toBe(true);
  });

  it('配置数组被篡改为根自身但原保护未动 → 仍可正常 acquire/dispose（基于原路径副本）', async () => {
    const { temp, protectedDir } = fresh();
    const arr = [protectedDir];
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: arr });
    arr.length = 0;
    arr.push(rootDirOf(temp)); // 仅改调用方数组，不落地

    const lease = await root.tryAcquire();
    expect(typeof lease.metadataBytes).toBe('number');
    lease.assertActive();
    expect(root.inspect().state).toBe('occupied');
    await lease.dispose();
    expect(root.inspect().state).toBe('idle');
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：inspect 只读状态机', () => {
  it('真实租约占用 → occupied（字节=标记+owner），dispose 后回 idle', async () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    const lease = await root.tryAcquire();

    const ownerSize = statSync(ownerOf(rootDir)).size;
    const markerSize = statSync(markerOf(temp)).size;
    expect(root.inspect()).toEqual({ state: 'occupied', contentBytes: markerSize + ownerSize });

    // lease 不外泄路径/token（细节由 lease lane 用例覆盖）
    expect(JSON.stringify(lease)).not.toContain(temp);
    await lease.dispose();
    expect(root.inspect()).toEqual({ state: 'idle', contentBytes: statSync(markerOf(temp)).size });
  });

  it('空 active/（mkdir 后崩溃残留）→ recovery_required，目录仍存在且为空', () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    mkdirSync(activeOf(rootDir), { mode: 0o700 });

    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
    expect(existsSync(activeOf(rootDir))).toBe(true);
    expect(readdirSync(activeOf(rootDir))).toEqual([]);
  });

  it('active/ 内未知文件（无 owner）→ recovery_required，内容保留', () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    const activeDir = activeOf(rootDir);
    mkdirSync(activeDir, { mode: 0o700 });
    writeFileSync(join(activeDir, 'rogue.bin'), 'rogue', 'utf8');

    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
    expect(readdirSync(activeDir)).toEqual(['rogue.bin']);
    expect(readFileSync(join(activeDir, 'rogue.bin'), 'utf8')).toBe('rogue');
  });

  it('坏 owner 各形态 → recovery_required，且文件原样不被删除', () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    const activeDir = activeOf(rootDir);
    const ownerPath = ownerOf(rootDir);
    mkdirSync(activeDir, { mode: 0o700 });

    const badOwners = [
      `{"version":1,"token":"not-a-uuid"}`,
      `{"version":1,"token":"11111111-2222-1333-8444-555555555555"}`,
      `{"version":2,"token":"${UUID}"}`,
      `{"version":1}`,
      `{"token":"${UUID}"}`,
      `{"version":1,"token":"${UUID}","extra":1}`,
      `{"version":1,"token":"${UUID}","token":"${UUID}"}`,
      `{"version":1,"version":1,"token":"${UUID}"}`,
      `{"version": 1, "token": "${UUID}"}`,
      `not json at all`,
    ];
    for (const bad of badOwners) {
      writeFileSync(ownerPath, bad, 'utf8');
      expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
      expect(readFileSync(ownerPath, 'utf8')).toBe(bad); // 未删除/未改写
    }
  });

  it('owner 缺失（active 内空）→ recovery_required；随后合法 owner → occupied', () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    const activeDir = activeOf(rootDir);
    mkdirSync(activeDir, { mode: 0o700 });
    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });

    writeFileSync(ownerOf(rootDir), JSON.stringify({ version: STAGING_OWNER_VERSION, token: UUID }));
    expect(root.inspect().state).toBe('occupied');
  });

  it('根内多余未知条目 → recovery_required；inspect 不删除、acquire 被 guard 拒绝', async () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const rootDir = rootDirOf(temp);
    const rogue = join(rootDir, 'rogue.bin');
    writeFileSync(rogue, 'rogue', 'utf8');

    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
    expect(readFileSync(rogue, 'utf8')).toBe('rogue');
    const threw = await captureReject(() => root.tryAcquire());
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(existsSync(activeOf(rootDir))).toBe(false);
  });

  it('标记被篡改 → recovery_required（只读，不修复）；acquire 拒绝且不建 active', async () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    const markerPath = markerOf(temp);
    writeFileSync(markerPath, '{"format":"tampered"}', 'utf8'); // 原位改写（inode 不变）

    expect(root.inspect()).toEqual({ state: 'recovery_required', contentBytes: null });
    expect(readFileSync(markerPath, 'utf8')).toBe('{"format":"tampered"}'); // 未自我修复
    const threw = await captureReject(() => root.tryAcquire());
    expectFixedError(threw, E.OWNER_MISMATCH, [temp]);
    expect(existsSync(activeOf(rootDirOf(temp)))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('staging-root：入参/错误收口与不泄漏', () => {
  it('封闭配置：未知键/相对/空入参 → INVALID_CONFIG', () => {
    const { temp, protectedDir } = fresh();
    const good = { privateParentDir: temp, protectedPaths: [protectedDir] };
    expectFixedError(
      captureSync(() =>
        openStagingRoot({ ...good, extra: 1 } as unknown as Parameters<typeof openStagingRoot>[0]),
      ),
      E.INVALID_CONFIG,
      [temp],
    );
    expectFixedError(
      captureSync(() =>
        openStagingRoot({ privateParentDir: 'relative', protectedPaths: [protectedDir] }),
      ),
      E.INVALID_CONFIG,
    );
    expectFixedError(
      captureSync(() =>
        openStagingRoot({ privateParentDir: temp, protectedPaths: [] }),
      ),
      E.INVALID_CONFIG,
    );
    expectFixedError(
      captureSync(() => openStagingRoot(null as unknown as Parameters<typeof openStagingRoot>[0])),
      E.INVALID_CONFIG,
    );
    expectFixedError(
      captureSync(() => openStagingRoot({ privateParentDir: temp, protectedPaths: ['relative'] })),
      E.INVALID_CONFIG,
    );
  });

  it('root/lease 的 JSON/keys/toString 不含根路径或 token', async () => {
    const { temp, protectedDir } = fresh();
    const root = openStagingRoot({ privateParentDir: temp, protectedPaths: [protectedDir] });
    expect(JSON.stringify(root)).toBe('{}');
    expect(Object.keys(root)).toEqual([]);
    const text = JSON.stringify({ root });
    expect(text).not.toContain(temp);
    expect(text).not.toContain(STAGING_ROOT_DIR_NAME);

    const lease = await root.tryAcquire();
    const json = JSON.stringify({ root, lease });
    expect(json).not.toContain(temp);
    expect(json).not.toContain(STAGING_ROOT_DIR_NAME);
    expect(String(lease)).not.toContain(temp);
    expect(Object.keys(lease)).toEqual([]);
    await lease.dispose();
  });
});
