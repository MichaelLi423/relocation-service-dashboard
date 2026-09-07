/**
 * 远程只读发布：control 数据库路径准备（tasks 2.3 路径加固切片）。
 *
 * 独立于 control-store（后续由 store 消费本模块产出的安全路径）；本模块只做
 * 「路径构造 + 存在性/身份/包含校验 + 自有叶子创建/权限」，**不**打开 SQLite、
 * 不做凭据/native 操作。canonical consent 等其他 lane 与本模块无耦合。
 *
 * 边界与安全模型：
 * - `privateParentDir` 必须已存在且是主进程自有的应用私有根（主进程 app 路径派生，
 *   不接受 renderer/业务路径/任意用户输入）。本模块只在该父目录下创建**固定叶子**
 *   `remote-readonly-control/control.db`，不递归创建任意祖先、不 chmod 任意既有目录。
 * - 创建/打开前先做存在性/真实路径校验：
 *     - control 链上的既有祖先一律 lstat/realpath 校验（拒绝沿链 symlink/junction）；
 *     - 既有 control db 必须是普通文件、nlink === 1，并与每个业务 DB 比 dev/ino
 *       （拒绝同文件/硬链接/符号链接到业务 DB）；declared 业务 DB 的 canonical 路径
 *       不得与 control db 相同——即使该业务 DB 此刻尚不存在（最近存在祖先 + 剩余段
 *       计算 canonical）也不得命中；
 *     - 业务备份包含校验：rel === '..' 或 rel.startsWith('..' + sep) 才视为父级逃逸；
 *       '..control' 这类「以 .. 开头但仍在备份目录内」的子项必须拒绝。声明的备份目录
 *       即使尚不存在也参与包含判断（不许 realpath ENOENT 跳过）；canonical 化遇到非
 *       ENOENT 错误一律 fail closed，不 continue。
 *     - 业务 DB / 备份目录保护清单成员必须非空绝对路径（fail closed，防止 realpath('.')
 *       或相对路径拼错导致的误判/漏检）。
 * - 自有叶子身份：
 *     - control 目录不存在 → 独占创建（mkdir，0700，非 recursive——父目录已存在）；
 *     - 目录已存在 → 必须带本模块身份 marker 且只含 marker/control.db（外部内容拒绝），
 *       是普通目录且非符号链接，才允许沿用；否则拒绝（不删除、不覆盖陌生目录）。
 *     - db 文件不存在 → 独占创建（flag 'wx'，0600）；已存在 → 身份校验后沿用，
 *       绝不覆盖（nlink/普通文件/与业务 dev·ino 不同）。
 * - Unix 权限位创建后校验；Windows 无 POSIX 保证——不声称 Windows ACL 等价。
 * - 信任边界说明（不夸大）：realpath + 独占创建不能对抗同 OS 用户的并发替换攻击；
 *   本模块依赖「trusted private parent 由主进程应用私有根独占维护」这一显式前提，
 *   不宣称超越该边界的防护。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
  chmodSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  closeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DomainError } from '../../domain/core/errors';

/** control 目录固定叶子名。 */
export const CONTROL_DIR_NAME = 'remote-readonly-control';

/** control db 固定叶子名。 */
export const CONTROL_DB_NAME = 'control.db';

export const CONTROL_LEAF_DIR_PERMISSION = 0o700;
export const CONTROL_LEAF_DB_PERMISSION = 0o600;

/** 自有叶子身份 marker（写入 control 目录；仅用于目录身份识别，不含 secret/路径值）。 */
export const CONTROL_DIR_MARKER = '.remote-readonly-control';

export const CONTROL_PATHS_ERROR_CODES = {
  CONTROL_PRIVATE_PARENT_REQUIRED: 'CONTROL_PRIVATE_PARENT_REQUIRED',
  CONTROL_PRIVATE_PARENT_NOT_DIR: 'CONTROL_PRIVATE_PARENT_NOT_DIR',
  CONTROL_PRIVATE_PARENT_SYMLINK: 'CONTROL_PRIVATE_PARENT_SYMLINK',
  CONTROL_CHAIN_SYMLINK: 'CONTROL_CHAIN_SYMLINK',
  CONTROL_DIR_NOT_DIR: 'CONTROL_DIR_NOT_DIR',
  CONTROL_DIR_FOREIGN: 'CONTROL_DIR_FOREIGN',
  CONTROL_DIR_SYMLINK: 'CONTROL_DIR_SYMLINK',
  CONTROL_DB_NOT_REGULAR: 'CONTROL_DB_NOT_REGULAR',
  CONTROL_DB_HARDLINK: 'CONTROL_DB_HARDLINK',
  CONTROL_DB_SYMLINK: 'CONTROL_DB_SYMLINK',
  CONTROL_DB_EXISTS_FOREIGN: 'CONTROL_DB_EXISTS_FOREIGN',
  CONTROL_BUSINESS_DB_COLLISION: 'CONTROL_BUSINESS_DB_COLLISION',
  CONTROL_INSIDE_BACKUP: 'CONTROL_INSIDE_BACKUP',
  CONTROL_INVALID_MEMBER_PATH: 'CONTROL_INVALID_MEMBER_PATH',
  CONTROL_CREATE_FAILED: 'CONTROL_CREATE_FAILED',
  CONTROL_PERMISSION: 'CONTROL_PERMISSION',
  CONTROL_NOT_REGULAR: 'CONTROL_NOT_REGULAR',
  CONTROL_EXISTS_FOREIGN_CONTENT: 'CONTROL_EXISTS_FOREIGN_CONTENT',
} as const;

export type ControlPathsErrorCode =
  (typeof CONTROL_PATHS_ERROR_CODES)[keyof typeof CONTROL_PATHS_ERROR_CODES];

/** metadata-only 路径错误：message 只含稳定 code，绝不回显路径/业务文件名/未知值。 */
export class ControlPathsError extends DomainError {
  constructor(code: ControlPathsErrorCode) {
    super(code, `control paths ${code}`);
    this.name = 'ControlPathsError';
  }
}

function pathError(code: ControlPathsErrorCode): ControlPathsError {
  return new ControlPathsError(code);
}

/** 入参：业务 DB 与备份目录为必填（production 必须传真实清单；不接受可选绑定豁免）。 */
export interface PrepareControlDatabasePathOptions {
  /** 应用私有根（已存在、主进程自有；本模块不创建、不 chmod 它）。 */
  privateParentDir: string;
  /** 业务 SQLite 文件（绝对路径清单；至少一个）。 */
  businessDbPaths: readonly string[];
  /** 业务备份目录（绝对路径清单；至少一个）。 */
  businessBackupDirs: readonly string[];
}

export interface PreparedControlPath {
  /** 自有 control 目录（已存在或新建；owned leaf）。 */
  controlDir: string;
  /** control DB 固定叶子（已存在或新建空文件，0600；store 后续在此建库）。 */
  dbPath: string;
  /** 是否本次新建 control 目录。 */
  createdDir: boolean;
  /** 是否本次调用以独占 'wx' 实际创建了 db 文件（store 据此决定可否安全初始化）。 */
  createdDb: boolean;
}

function isSameDeviceInode(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function requireRegularFile(st: Stats): void {
  if (!st.isFile()) throw pathError('CONTROL_DB_NOT_REGULAR');
}

/** rel 是否「确实逃逸到父级之外」：'..' 或 '..' + sep。 */
function isParentEscape(relPath: string): boolean {
  return relPath === '..' || relPath.startsWith(`..${sep}`);
}

/** rel 是否「以 .. 开头但仍在内部」：'..control' 等在备份目录内的怪名。 */
function isDotDotPrefixedNonEscape(relPath: string): boolean {
  return relPath.startsWith('..') && !isParentEscape(relPath);
}

/**
 * 计算「canonical 目标路径」：沿最近存在的祖先做 realpath，再追加以文本形式保留的
 * 剩余段。这样尚不存在（ENOENT）的目标也能与真实存在的对象做同一规范空间的包含比较，
 * 避免「声明了但尚未创建的目录被 continue 跳过」造成的漏检（BUG1）。
 *
 * 失败策略（fail closed）：真实存在的祖先链上任何无法解析的错误都抛出；只有纯粹的
 * 「不存在」才走最近祖先 + 剩余段回退。Windows 的盘符卷序列不在此展开（目录必须绝对）。
 */
function canonicalPathOf(target: string): string {
  let resolvedRoot = target;
  let trailing: string[] = [];
  let pending = target;
  while (true) {
    try {
      resolvedRoot = realpathSync(pending);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const parent = dirname(pending);
        if (parent === pending) {
          // 已到文件系统根仍不存在（异常）；fail closed。
          throw pathError('CONTROL_INVALID_MEMBER_PATH');
        }
        trailing.unshift(basename(pending));
        pending = parent;
        continue;
      }
      // 非 ENOENT（权限/IO 等）→ fail closed，不跳过、不回退。
      throw pathError('CONTROL_INVALID_MEMBER_PATH');
    }
  }
  return trailing.length === 0 ? resolvedRoot : join(resolvedRoot, ...trailing);
}

/**
 * 校验 control 链上既有段：沿 canonical parent 到固定 leaf 逐段 lstat，拒绝 symlink；
 * 中间段必须已存在且为目录；仅允许「叶子段尚不存在」（由本模块随后独占创建）。
 * privateParentDir 已由调用方保证存在、非符号链接且为目录。
 */
function assertNoSymlinkAlongControlChain(parentReal: string, controlDir: string): void {
  const relPath = relative(parentReal, controlDir);
  if (relPath === '') throw pathError('CONTROL_DIR_NOT_DIR');
  const segments = relPath.split(sep).filter(Boolean);
  let cursor = parentReal;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = join(cursor, segments[i]);
    const isLeaf = i === segments.length - 1;
    let existing = false;
    let ls: Stats | undefined;
    try {
      existing = existsSync(cursor);
      if (existing) ls = lstatSync(cursor);
    } catch {
      throw pathError('CONTROL_DIR_NOT_DIR');
    }
    if (existing && ls) {
      if (ls.isSymbolicLink()) {
        throw pathError(isLeaf ? 'CONTROL_DIR_SYMLINK' : 'CONTROL_CHAIN_SYMLINK');
      }
      if (!ls.isDirectory()) throw pathError('CONTROL_DIR_NOT_DIR');
    } else {
      // 中间段不存在：只允许最后一个叶子段（由本模块随后独占创建）。
      if (!isLeaf) throw pathError('CONTROL_DIR_NOT_DIR');
    }
  }
}

/**
 * control 目录/control db 是否落在任一业务备份目录内。
 *
 * 备份目录即便尚不存在也要参与包含判断（BUG1：声明了但未创建的备份目录此前被
 * realpath ENOENT `continue` 跳过 → 漏检）。两侧都统一到 canonical 路径再做包含，
 * 避免 /tmp -> /private/tmp 拼写误判；canonical 化失败一律 fail closed。
 */
function assertNotInsideAnyBackup(controlDir: string, businessBackupDirs: readonly string[]): void {
  for (const backupDir of businessBackupDirs) {
    const backupReal = canonicalPathOf(backupDir);
    const relPath = relative(backupReal, controlDir);
    if (relPath === '') throw pathError('CONTROL_INSIDE_BACKUP');
    if (isDotDotPrefixedNonEscape(relPath)) throw pathError('CONTROL_INSIDE_BACKUP');
    if (!isParentEscape(relPath)) throw pathError('CONTROL_INSIDE_BACKUP');
  }
}

/** 在 mkdir/chmod/open 之前校验：本模块固定 db 叶子的 canonical 路径不得与任一声明业务 DB 相同。 */
function assertDbPathNotAnyBusinessDb(dbPath: string, businessDbPaths: readonly string[]): void {
  const dbCanonical = canonicalPathOf(dbPath);
  for (const businessPath of businessDbPaths) {
    if (canonicalPathOf(businessPath) === dbCanonical) {
      throw pathError('CONTROL_BUSINESS_DB_COLLISION');
    }
  }
}

/** 保护清单成员要求非空且为绝对路径；业务备份目录额外要求非空（防 realpath('.') 误伤）。 */
function assertProtectionMembers(businessDbPaths: readonly string[], businessBackupDirs: readonly string[]): void {
  for (const businessPath of businessDbPaths) {
    if (typeof businessPath !== 'string' || businessPath === '' || !isAbsolute(businessPath)) {
      throw pathError('CONTROL_INVALID_MEMBER_PATH');
    }
  }
  for (const backupDir of businessBackupDirs) {
    if (typeof backupDir !== 'string' || backupDir === '' || !isAbsolute(backupDir)) {
      throw pathError('CONTROL_INVALID_MEMBER_PATH');
    }
  }
}

/** 创建/校验自有 control 叶子目录并写入身份 marker（仅本模块固定叶子）。返回是否新建。 */
function ensureOwnControlDir(controlDir: string): boolean {
  if (existsSync(controlDir)) {
    let ls: Stats;
    let st: Stats;
    try {
      ls = lstatSync(controlDir);
      st = statSync(controlDir);
    } catch {
      throw pathError('CONTROL_DIR_FOREIGN');
    }
    if (ls.isSymbolicLink()) throw pathError('CONTROL_DIR_SYMLINK');
    if (!st.isDirectory()) throw pathError('CONTROL_DIR_NOT_DIR');
    // 已存在目录必须带我方身份 marker，且只含我方已知物（marker 与 control.db）。
    const markerPath = join(controlDir, CONTROL_DIR_MARKER);
    if (!existsSync(markerPath)) throw pathError('CONTROL_DIR_FOREIGN');
    let markerContent = '';
    try {
      markerContent = readFileSync(markerPath, 'utf8');
    } catch {
      throw pathError('CONTROL_DIR_FOREIGN');
    }
    if (markerContent !== CONTROL_DIR_MARKER) throw pathError('CONTROL_DIR_FOREIGN');
    let childNames: string[] = [];
    try {
      childNames = readdirSync(controlDir);
    } catch {
      throw pathError('CONTROL_DIR_FOREIGN');
    }
    for (const name of childNames) {
      if (name === CONTROL_DIR_MARKER || name === CONTROL_DB_NAME) continue;
      throw pathError('CONTROL_EXISTS_FOREIGN_CONTENT');
    }
    // Unix 收紧目录权限为 0700（仅自有 leaf）。
    if (process.platform !== 'win32') {
      try {
        chmodSync(controlDir, CONTROL_LEAF_DIR_PERMISSION);
      } catch {
        throw pathError('CONTROL_PERMISSION');
      }
    }
    return false;
  }

  // 不存在 → 独占创建（父目录必须已存在；只建固定 leaf，mkdir 非 recursive）。
  try {
    if (dirname(controlDir) === '' || dirname(controlDir) === controlDir) {
      throw pathError('CONTROL_DIR_NOT_DIR');
    }
    mkdirSync(controlDir, { mode: CONTROL_LEAF_DIR_PERMISSION });
  } catch (err) {
    if (err instanceof ControlPathsError) throw err;
    throw pathError('CONTROL_CREATE_FAILED');
  }
  try {
    // mkdir mode 受 umask 影响：显式收紧到 0700（仅自有 leaf）。
    if (process.platform !== 'win32') chmodSync(controlDir, CONTROL_LEAF_DIR_PERMISSION);
  } catch {
    throw pathError('CONTROL_PERMISSION');
  }
  try {
    const fd = openSync(join(controlDir, CONTROL_DIR_MARKER), 'wx', CONTROL_LEAF_DIR_PERMISSION);
    try {
      writeFileSync(fd, CONTROL_DIR_MARKER, { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
    // marker 文件权限收紧到 0600（受 umask 影响，创建后统一设置）。
    if (process.platform !== 'win32') {
      chmodSync(join(controlDir, CONTROL_DIR_MARKER), CONTROL_LEAF_DB_PERMISSION);
    }
  } catch (err) {
    if (err instanceof ControlPathsError) throw err;
    throw pathError('CONTROL_CREATE_FAILED');
  }
  return true;
}

/** 校验既有 control db：普通文件、nlink===1、非符号链接、与业务 DB 不同 dev/ino。 */
function assertSafeExistingDb(dbPath: string, businessDbPaths: readonly string[]): void {
  if (!existsSync(dbPath)) return;
  let ls: Stats;
  let st: Stats;
  try {
    ls = lstatSync(dbPath);
    st = statSync(dbPath);
  } catch {
    throw pathError('CONTROL_DB_EXISTS_FOREIGN');
  }
  if (ls.isSymbolicLink()) throw pathError('CONTROL_DB_SYMLINK');
  requireRegularFile(st);
  if (st.nlink !== 1) throw pathError('CONTROL_DB_HARDLINK');
  for (const businessPath of businessDbPaths) {
    if (!existsSync(businessPath)) continue;
    let bst: Stats;
    try {
      bst = statSync(businessPath);
    } catch {
      continue;
    }
    if (!bst.isFile()) throw pathError('CONTROL_NOT_REGULAR');
    if (isSameDeviceInode(st, bst)) throw pathError('CONTROL_BUSINESS_DB_COLLISION');
  }
}

/** 独占创建 db 文件（'wx'，0600）：已存在即校验后沿用，绝不覆盖。返回是否本次新建。 */
function ensureDbFileExists(dbPath: string, businessDbPaths: readonly string[]): boolean {
  if (existsSync(dbPath)) {
    assertSafeExistingDb(dbPath, businessDbPaths);
    return false;
  }
  try {
    const fd = openSync(dbPath, 'wx', CONTROL_LEAF_DB_PERMISSION);
    closeSync(fd);
  } catch {
    throw pathError('CONTROL_DB_EXISTS_FOREIGN');
  }
  return true;
}

function assertLeafPermissions(controlDir: string, dbPath: string): void {
  if (process.platform === 'win32') return; // Windows 无 POSIX 权限位保证
  let dirSt: Stats;
  let dbSt: Stats;
  try {
    dirSt = statSync(controlDir);
    dbSt = statSync(dbPath);
  } catch {
    throw pathError('CONTROL_PERMISSION');
  }
  if ((dirSt.mode & 0o777) !== CONTROL_LEAF_DIR_PERMISSION) throw pathError('CONTROL_PERMISSION');
  if ((dbSt.mode & 0o777) !== CONTROL_LEAF_DB_PERMISSION) throw pathError('CONTROL_PERMISSION');
}

/**
 * 准备并返回安全 control 数据库路径（不打开 SQLite；store 后续使用本路径建库）。
 * 返回前：逐级校验 trusted private parent → control leaf 无 symlink；校验保护清单成员
 * 非空绝对、canonical 化的 db 不得与任一业务 DB 相同、备份包含（声明但未创建的备份目录
 * 也参与判断）——以上全部在任何 mkdir/chmod/open 之前完成（fail closed）；
 * 独占创建自有 control 叶子目录（0700 + 身份 marker）与 control.db（0600，wx）；
 * 既有 db 校验普通文件/nlink=1/与业务 DB dev·ino 不同。
 */
export function prepareControlDatabasePath(
  options: PrepareControlDatabasePathOptions,
): PreparedControlPath {
  const { privateParentDir, businessDbPaths, businessBackupDirs } = options;
  if (
    typeof privateParentDir !== 'string' ||
    privateParentDir === '' ||
    !Array.isArray(businessDbPaths) ||
    businessDbPaths.length === 0 ||
    !Array.isArray(businessBackupDirs) ||
    businessBackupDirs.length === 0
  ) {
    throw pathError('CONTROL_PRIVATE_PARENT_REQUIRED');
  }
  assertProtectionMembers(businessDbPaths, businessBackupDirs);
  if (!existsSync(privateParentDir)) throw pathError('CONTROL_PRIVATE_PARENT_REQUIRED');
  let parentStat: Stats;
  let parentLs: Stats;
  let parentReal: string;
  try {
    parentStat = statSync(privateParentDir);
    parentLs = lstatSync(privateParentDir);
    parentReal = realpathSync(privateParentDir);
  } catch {
    throw pathError('CONTROL_PRIVATE_PARENT_REQUIRED');
  }
  if (!parentStat.isDirectory()) throw pathError('CONTROL_PRIVATE_PARENT_NOT_DIR');
  if (parentLs.isSymbolicLink()) throw pathError('CONTROL_PRIVATE_PARENT_SYMLINK');
  // 统一到 realpath 根（如 macOS /tmp -> /private/tmp）：本模块只在该 canonical 根下创建固定叶子。
  const controlDir = join(parentReal, CONTROL_DIR_NAME);
  const dbPath = join(controlDir, CONTROL_DB_NAME);

  // 任何 mkdir/chmod/open 之前完成全部路径保护校验（fail closed）。
  assertNoSymlinkAlongControlChain(parentReal, controlDir);
  assertNotInsideAnyBackup(controlDir, businessBackupDirs);
  // db 尚不存在（将独占创建）时：canonical 化的 db 路径不得与任一声明业务 DB 相同——
  // 即使该业务 DB 此刻不存在（最近存在祖先 + 剩余段比较）。db 已存在走既有身份校验
  // （assertSafeExistingDb：symlink/hardlink/普通文件/dev·ino 冲突），保持原错误语义。
  if (!existsSync(dbPath)) {
    assertDbPathNotAnyBusinessDb(dbPath, businessDbPaths);
  }
  const createdDir = ensureOwnControlDir(controlDir);
  const createdDb = ensureDbFileExists(dbPath, businessDbPaths);
  assertLeafPermissions(controlDir, dbPath);

  return { controlDir, dbPath, createdDir, createdDb };
}
