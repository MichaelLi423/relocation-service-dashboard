/**
 * control-paths.test.ts（remote-readonly 路径加固切片）
 *
 * 只验证 control-paths（路径构造/身份/包含/独占创建），不打开 SQLite；control-store
 * 后续消费本模块产出的安全路径。
 *
 * 用临时合成目录（os.tmpdir 下 realpath 根）覆盖：
 * - 首次创建 fixed leaf：目录 0700 + marker、db 0600 空文件、createdDir=true；reopen 幂等且 createdDir=false；
 * - 拒绝：业务 DB 文件符号链接 / 硬链接（dev/ino、nlink=1）、control 链 symlink、
 *   叶目录为符号链接、目录无我方 marker/含外部内容、control 位于业务备份目录内、
 *   '..control' 这类「以 .. 开头但仍在备份内」的伪逃逸、leaf 非普通目录；
 * - 保护清单成员必须非空绝对路径；声明的备份目录/业务 DB 尚不存在时仍参与包含/canonical
 *   校验（不许 realpath ENOENT continue 跳过）；canonical 化非 ENOENT 错误 fail closed；
 *   上述拒绝全部在任何 mkdir/chmod/open 之前完成，不留任何 control 文件；
 * - createdDir/createdDb 只在本次实际创建时为 true（reopen 恒 false）；
 * - 失败时业务 DB 字节与文件/目录权限不变、不创建备份文件、不残留 control 文件；
 * - 错误 metadata-only（message 只含稳定 code，不回显任何路径/业务文件名/值）。
 *
 * Windows 无 POSIX 权限保证：权限位断言跳过，其余断言照常。
 * 信任边界：测试的 privateParentDir 即「trusted private parent」（测试自建临时根），
 * 不声称可对抗同 OS 用户并发替换攻击。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  lstatSync,
  symlinkSync,
  linkSync,
  existsSync,
  readdirSync,
  rmSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareControlDatabasePath,
  CONTROL_DIR_NAME,
  CONTROL_DB_NAME,
  CONTROL_DIR_MARKER,
  CONTROL_LEAF_DIR_PERMISSION,
  CONTROL_LEAF_DB_PERMISSION,
  ControlPathsError,
  type PreparedControlPath,
} from '../../src/main/remote-readonly/control-paths';

interface Fixture {
  root: string;
  privateParentDir: string;
  businessDbPath: string;
  backupDir: string;
}

const rootsToClean: string[] = [];

function makeTempRoot(): string {
  const root = join(
    realpathSync(tmpdir()),
    `control-paths-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  return root;
}

function newFixture(): Fixture {
  const root = makeTempRoot();
  const privateParentDir = join(root, 'app-private');
  const businessDir = join(root, 'business');
  const backupDir = join(businessDir, 'backups');
  mkdirSync(privateParentDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const businessDbPath = join(businessDir, 'workbench.db');
  // 固定合成字节（只用于内容不变断言，无真实业务值）。
  writeFileSync(businessDbPath, 'SYNTHETIC-BUSINESS-DB-BYTES-NO-REAL-VALUE');
  return { root, privateParentDir, businessDbPath, backupDir };
}

function opts(f: Fixture) {
  return {
    privateParentDir: f.privateParentDir,
    businessDbPaths: [f.businessDbPath],
    businessBackupDirs: [f.backupDir],
  };
}

function expectRejected(fn: () => unknown, code: string): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!(threw instanceof ControlPathsError)) {
    throw new Error(`expected ControlPathsError(${code}), got: ${String(threw)}`);
  }
  expect(threw.code).toBe(code);
  // metadata-only：message 不回显路径/文件名/值
  expect(threw.message).toBe(`control paths ${code}`);
}

function expectBusinessUnchanged(f: Fixture, before: { bytes: Buffer; mode: number }): void {
  expect(readFileSync(f.businessDbPath)).toEqual(before.bytes);
  if (process.platform !== 'win32') {
    expect(statSync(f.businessDbPath).mode & 0o777).toBe(before.mode);
  }
}

function captureBusiness(f: Fixture): { bytes: Buffer; mode: number } {
  return { bytes: readFileSync(f.businessDbPath), mode: statSync(f.businessDbPath).mode & 0o777 };
}

afterEach(() => {
  for (const root of rootsToClean) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
  rootsToClean.length = 0;
});

describe('control paths：首次创建与 reopen', () => {
  it('创建 fixed leaf：目录 0700 + marker、db 0600 空文件、createdDir/createdDb 语义', () => {
    const f = newFixture();
    const result = prepareControlDatabasePath(opts(f));
    expect(result.controlDir).toBe(join(f.privateParentDir, CONTROL_DIR_NAME));
    expect(result.dbPath).toBe(join(result.controlDir, CONTROL_DB_NAME));
    expect(result.createdDir).toBe(true);
    expect(result.createdDb).toBe(true);
    expect(existsSync(result.controlDir)).toBe(true);
    expect(lstatSync(result.controlDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(result.controlDir, CONTROL_DIR_MARKER), 'utf8')).toBe(CONTROL_DIR_MARKER);
    // db 为新建空文件（store 后续在固定叶子上建库，本模块不打开）。
    expect(existsSync(result.dbPath)).toBe(true);
    expect(readFileSync(result.dbPath).length).toBe(0);
    // marker 不含路径/secret
    expect(CONTROL_DIR_MARKER).not.toContain('/');
    expect(CONTROL_DIR_MARKER).not.toContain('\\');
    if (process.platform !== 'win32') {
      const dirMode = statSync(result.controlDir).mode & 0o777;
      const dbMode = statSync(result.dbPath).mode & 0o777;
      expect(dirMode).toBe(CONTROL_LEAF_DIR_PERMISSION);
      expect(dbMode).toBe(CONTROL_LEAF_DB_PERMISSION);
    }
  });

  it('reopen 幂等：createdDir=false、createdDb=false，目录只含 marker 与 control.db', () => {
    const f = newFixture();
    prepareControlDatabasePath(opts(f));
    const second = prepareControlDatabasePath(opts(f));
    expect(second.createdDir).toBe(false);
    expect(second.createdDb).toBe(false);
    const names = readdirSync(second.controlDir).sort();
    expect(names).toEqual([CONTROL_DIR_MARKER, CONTROL_DB_NAME].sort());
  });

  it('已存在目录无我方 marker（陌生目录）→ CONTROL_DIR_FOREIGN，不 chmod/不覆盖', () => {
    const f = newFixture();
    const foreignDir = join(f.privateParentDir, CONTROL_DIR_NAME);
    mkdirSync(foreignDir, { mode: 0o755 });
    writeFileSync(join(foreignDir, 'someone.txt'), 'not-ours');
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_DIR_FOREIGN');
    if (process.platform !== 'win32') {
      // 陌生目录权限未被我们改写
      expect(statSync(foreignDir).mode & 0o777).toBe(0o755);
    }
    expect(readFileSync(join(foreignDir, 'someone.txt'), 'utf8')).toBe('not-ours');
  });

  it('目录带 marker 但混入外部条目 → CONTROL_EXISTS_FOREIGN_CONTENT，外部条目不被删除', () => {
    const f = newFixture();
    prepareControlDatabasePath(opts(f));
    const controlDir = join(f.privateParentDir, CONTROL_DIR_NAME);
    const foreign = join(controlDir, 'foreign.txt');
    writeFileSync(foreign, 'leave-me');
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_EXISTS_FOREIGN_CONTENT');
    expect(existsSync(foreign)).toBe(true);
    expect(readFileSync(foreign, 'utf8')).toBe('leave-me');
  });
});

describe('control paths：备份包含与链上符号链接', () => {
  it('control 落在业务备份目录内 → CONTROL_INSIDE_BACKUP，不产生任何 control 文件', () => {
    const f = newFixture();
    const parentInside = join(f.backupDir, 'app-private');
    mkdirSync(parentInside, { recursive: true, mode: 0o700 });
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: parentInside,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_INSIDE_BACKUP',
    );
    expect(existsSync(join(parentInside, CONTROL_DIR_NAME))).toBe(false);
    // 备份目录内不新增文件
    expect(readdirSync(f.backupDir).sort()).toEqual(['app-private']);
  });

  it("privateParentDir 是备份目录自身 → CONTROL_INSIDE_BACKUP", () => {
    const f = newFixture();
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.backupDir,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_INSIDE_BACKUP',
    );
    expect(readdirSync(f.backupDir)).toEqual([]);
  });

  it("'..control' 伪逃逸子项（'..' 开头但仍在备份内）→ CONTROL_INSIDE_BACKUP", () => {
    const f = newFixture();
    // 备份根为 backupDir；其内建一个名为 '..control' 的子目录。当 privateParentDir 位于
    // backupDir 之下时，relative(backupDir, controlDir) 形如 '..control/app-private/remote-readonly-control'
    // —— 以 '..' 开头却并未真正逃出备份区（'..' 后紧跟 'control' 而非分隔符），必须拒绝。
    const pseudo = join(f.backupDir, '..control');
    mkdirSync(pseudo, { recursive: true, mode: 0o700 });
    const deepParent = join(pseudo, 'app-private');
    mkdirSync(deepParent, { recursive: true, mode: 0o700 });
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: deepParent,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_INSIDE_BACKUP',
    );
    expect(existsSync(join(deepParent, CONTROL_DIR_NAME))).toBe(false);
  });

  it('声明的备份目录尚不存在但就是 control 固定叶 → CONTROL_INSIDE_BACKUP，不创建任何文件/目录', () => {
    const f = newFixture();
    // 备份目录声明为 parent/remote-readonly-control（此刻并不存在）：旧实现 realpath ENOENT
    // 会 continue 跳过该备份 → 漏检。现按最近存在祖先 + 剩余段计算 canonical 再比较 → 拒绝。
    const futureBackup = join(f.privateParentDir, CONTROL_DIR_NAME);
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [futureBackup],
        }),
      'CONTROL_INSIDE_BACKUP',
    );
    // 未产生任何文件/目录（包括 control 叶本身）。
    expect(readdirSync(f.privateParentDir).sort()).toEqual([]);
    expect(existsSync(futureBackup)).toBe(false);
  });

  it('声明的业务 DB 尚不存在但就是 control.db 固定叶 → CONTROL_BUSINESS_DB_COLLISION，不创建任何文件/目录', () => {
    const f = newFixture();
    // 业务 DB 声明为 parent/remote-readonly-control/control.db（此刻并不存在）：
    // canonical 比较（最近存在祖先 + 剩余段）必须仍与 control db 叶相等 → 拒绝。
    const futureDb = join(f.privateParentDir, CONTROL_DIR_NAME, CONTROL_DB_NAME);
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: [futureDb],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_BUSINESS_DB_COLLISION',
    );
    expect(readdirSync(f.privateParentDir).sort()).toEqual([]);
    expect(existsSync(futureDb)).toBe(false);
  });

  it('canonical 化遇到非 ENOENT 错误（父链落入既有普通文件）→ fail closed，不跳过', () => {
    const f = newFixture();
    // 备份声明在既有业务 DB 文件之下：realpath 抛 ENOTDIR（非 ENOENT）→ 不得像旧实现
    // 那样 continue 跳过；必须在创建任何内容之前以 CONTROL_INVALID_MEMBER_PATH 拒绝。
    const underFile = join(f.businessDbPath, 'backups');
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [underFile],
        }),
      'CONTROL_INVALID_MEMBER_PATH',
    );
    expect(readdirSync(f.privateParentDir).sort()).toEqual([]);
  });

  it('叶目录自身是符号链接 → CONTROL_DIR_SYMLINK；链接目标不被写入', () => {
    const f = newFixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(f.privateParentDir, CONTROL_DIR_NAME));
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_DIR_SYMLINK');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('privateParentDir 自身是符号链接 → CONTROL_PRIVATE_PARENT_SYMLINK', () => {
    const f = newFixture();
    const realParent = join(f.root, 'real-app-private');
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    const linkedParent = join(f.root, 'linked-app-private');
    symlinkSync(realParent, linkedParent);
    expectRejected(() => prepareControlDatabasePath({ ...opts(f), privateParentDir: linkedParent }), 'CONTROL_PRIVATE_PARENT_SYMLINK');
    expect(readdirSync(realParent)).toEqual([]);
  });
});

describe('control paths：既有 db 身份校验', () => {
  function readyLeaf(f: Fixture): string {
    prepareControlDatabasePath(opts(f));
    return join(f.privateParentDir, CONTROL_DIR_NAME);
  }

  it('control.db 是业务 DB 的符号链接 → CONTROL_DB_SYMLINK，业务字节不变', () => {
    const f = newFixture();
    const controlDir = readyLeaf(f);
    const dbPath = join(controlDir, CONTROL_DB_NAME);
    rmSync(dbPath, { force: true });
    symlinkSync(f.businessDbPath, dbPath);
    const before = captureBusiness(f);
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_DB_SYMLINK');
    expectBusinessUnchanged(f, before);
  });

  it('control.db 与业务 DB 硬链接 → CONTROL_DB_HARDLINK，业务不变', () => {
    const f = newFixture();
    const controlDir = readyLeaf(f);
    const dbPath = join(controlDir, CONTROL_DB_NAME);
    rmSync(dbPath, { force: true });
    linkSync(f.businessDbPath, dbPath);
    const before = captureBusiness(f);
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_DB_HARDLINK');
    expectBusinessUnchanged(f, before);
  });

  it('control.db 是目录（非普通文件）→ CONTROL_DB_NOT_REGULAR', () => {
    const f = newFixture();
    const controlDir = readyLeaf(f);
    const dbPath = join(controlDir, CONTROL_DB_NAME);
    rmSync(dbPath, { force: true });
    mkdirSync(dbPath, { mode: 0o700 });
    expectRejected(() => prepareControlDatabasePath(opts(f)), 'CONTROL_DB_NOT_REGULAR');
  });
});

describe('control paths：入参校验与错误 metadata-only', () => {
  it('businessDbPaths 为空清单 → CONTROL_PRIVATE_PARENT_REQUIRED', () => {
    const f = newFixture();
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: [],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_PRIVATE_PARENT_REQUIRED',
    );
  });

  it('保护清单成员必须非空绝对路径 → CONTROL_INVALID_MEMBER_PATH（不做任何创建）', () => {
    const f = newFixture();
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: ['relative/db.sqlite'],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_INVALID_MEMBER_PATH',
    );
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: f.privateParentDir,
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [''],
        }),
      'CONTROL_INVALID_MEMBER_PATH',
    );
    expect(readdirSync(f.privateParentDir).sort()).toEqual([]);
  });

  it('privateParentDir 不存在 → CONTROL_PRIVATE_PARENT_REQUIRED', () => {
    const f = newFixture();
    expectRejected(
      () =>
        prepareControlDatabasePath({
          privateParentDir: join(f.root, 'nope'),
          businessDbPaths: [f.businessDbPath],
          businessBackupDirs: [f.backupDir],
        }),
      'CONTROL_PRIVATE_PARENT_REQUIRED',
    );
  });

  it('所有拒绝消息只含稳定 code（不回显路径/业务文件名/备份名/值）', () => {
    const f = newFixture();
    const parentInside = join(f.backupDir, 'app-private');
    mkdirSync(parentInside, { recursive: true, mode: 0o700 });
    const cases: Array<{ name: string; fn: () => unknown; code: string }> = [
      {
        name: 'inside backup',
        code: 'CONTROL_INSIDE_BACKUP',
        fn: () =>
          prepareControlDatabasePath({
            privateParentDir: parentInside,
            businessDbPaths: [f.businessDbPath],
            businessBackupDirs: [f.backupDir],
          }),
      },
      {
        name: 'empty business list',
        code: 'CONTROL_PRIVATE_PARENT_REQUIRED',
        fn: () =>
          prepareControlDatabasePath({
            privateParentDir: f.privateParentDir,
            businessDbPaths: [],
            businessBackupDirs: [f.backupDir],
          }),
      },
      {
        name: 'missing parent dir',
        code: 'CONTROL_PRIVATE_PARENT_REQUIRED',
        fn: () =>
          prepareControlDatabasePath({
            privateParentDir: join(f.root, 'does-not-exist'),
            businessDbPaths: [f.businessDbPath],
            businessBackupDirs: [f.backupDir],
          }),
      },
    ];
    for (const c of cases) {
      // expectRejected 断言 err.message === `control paths ${code}`（严格等于仅含 code 的串）
      // → 已隐式保证不回显任何路径/业务文件名/备份名/值。
      expectRejected(c.fn, c.code);
    }
  });
});

describe('control paths：成功返回（store 集成就绪）', () => {
  it('返回固定 leaf 路径；db 为普通文件 nlink=1', () => {
    const f = newFixture();
    const result: PreparedControlPath = prepareControlDatabasePath(opts(f));
    const st: Stats = statSync(result.dbPath);
    expect(st.isFile()).toBe(true);
    expect(st.nlink).toBe(1);
    expect(lstatSync(result.controlDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(result.dbPath).isSymbolicLink()).toBe(false);
    expect(result.controlDir).toBe(join(f.privateParentDir, CONTROL_DIR_NAME));
    expect(result.dbPath).toBe(join(result.controlDir, CONTROL_DB_NAME));
  });
});
