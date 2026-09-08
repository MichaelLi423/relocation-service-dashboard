/**
 * 远程只读 ingest：staging 根（root lane）。只做根校验/准备，不实现锁。
 *
 * - 固定叶子 `privateParentDir/remote-readonly-staging/`，根内仅允许 `.owner-marker` 与
 *   lease lane 的 `active/`。标记为显式 `{format:'remote-readonly-staging-root',version:1}`
 *   （0600，≤4KiB）；只在本次 mkdir 成功后写入，mkdir EEXIST 输家不写、不认领外部根。
 *   已存在根 → 必须同为该标记内容/0600、目录 0700 且非符号链接；一律不 chmod/reset/接管；
 *   旧版无 format 的 `{"version":1}` 标记视为外部内容拒绝。
 * - 任何创建前严格校验：parent 已存在、非符号链接、无 group/other 写位；protectedPaths
 *   非空且全绝对，配置对象未知键拒绝。受保护路径保存调用方原绝对路径副本（仅去尾部
 *   分隔符，不在 realpath 前折叠 '.'/'..'）；每次重校验都对原路径 realpath（ENOENT 时取
 *   最近已存在祖先 realpath + 剩余段普通 join），符号链接与 '..' 依真实语义解析（防别名
 *   后期重定向指向根）；与根双向重叠 → UNSAFE_PATH；非 ENOENT 一律 IO_FAILED（固定
 *   StagingError，不回显输入/路径/cause）。
 * - 捕获根 dev/ino；assertRootOwnership 闭包在 acquire/assertActive/dispose 边界重校验根
 *   身份、标记与 protections 拓扑，不再归我方 → OWNER_MISMATCH。
 * - inspect() 永不抛错：只读有界 owner.json（不碰 payload）。owner.json 须为封闭规范形
 *   （仅 version/token 两键、token 为规范 UUID、重序列化一致）→ occupied；owner 未知/不
 *   完整、根内多余条目或标记异常 → recovery_required（contentBytes=null）；绝不按
 *   time/PID 判死、绝不删 active/。tryAcquire() 原样委托 acquireStagingLease。路径与身份
 *   仅在 #private 字段/闭包，JSON 不含根路径或 token。
 */
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { STAGING_ERROR_CODES, StagingError, type StagingErrorCode } from './staging-contract';
import {
  acquireStagingLease, STAGING_ACTIVE_DIR_NAME, STAGING_OWNER_FILE_NAME,
  STAGING_OWNER_VERSION, type StagingLease,
} from './staging-lease';

export const STAGING_ROOT_DIR_NAME = 'remote-readonly-staging'; // 根固定叶子目录名
export const STAGING_ROOT_MARKER_FILE_NAME = '.owner-marker'; // 根内固定所有权标记
/** 标记显式格式标识（配合 version；旧的无 format 标记视为外部内容）。 */
export const STAGING_ROOT_MARKER_FORMAT = 'remote-readonly-staging-root';
export const STAGING_ROOT_MARKER_VERSION = 1; // 标记固定 schema version
export const STAGING_ROOT_DIR_PERMISSION = 0o700;
export const STAGING_ROOT_MARKER_PERMISSION = 0o600;

const MARKER_JSON = JSON.stringify({
  format: STAGING_ROOT_MARKER_FORMAT,
  version: STAGING_ROOT_MARKER_VERSION,
});
const MARKER_BYTES = Buffer.byteLength(MARKER_JSON, 'utf8');
const MAX_ENTRY_BYTES = 4 * 1024;
/** owner.json token 必须为规范（小写 v4）UUID。 */
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const E = STAGING_ERROR_CODES;
const stagingError = (code: StagingErrorCode): StagingError => new StagingError(code);

export interface StagingRootOptions {
  readonly privateParentDir: string;
  readonly protectedPaths: readonly string[];
}
export type StagingRootState = 'idle' | 'occupied' | 'recovery_required';
export interface StagingRootInspection {
  readonly state: StagingRootState;
  readonly contentBytes: number | null;
}
export interface StagingRoot {
  /** 原子尝试获取租约（委托 acquireStagingLease）：被占 → BUSY，根不再归我方 → OWNER_MISMATCH。 */
  tryAcquire(): Promise<StagingLease>;
  /** 只读查询状态；永不抛错、永不改动 active/。 */
  inspect(): StagingRootInspection;
}

/** 去尾部连续分隔符（保留根 '/'）。 */
function normalizePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** 先对原路径 realpath；ENOENT 时沿父级上溯到最近已存在祖先 realpath，再普通 join 剩余
 *  字面段（'.'/'..' 与符号链接的语义已在 realpath 时依真实文件系统解析）。非 ENOENT fail-closed。 */
function canonicalResolve(p: string): string {
  let cur = p;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      if (missing.length === 0) return real;
      return join(real, ...missing.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw stagingError(E.IO_FAILED);
      const base = basename(cur);
      const parent = dirname(cur);
      if (base === cur) throw stagingError(E.IO_FAILED);
      missing.push(base);
      cur = parent;
    }
  }
}

/** 规范化绝对路径间判「p 位于 root 内或为祖先/相等」的双向重叠。 */
function overlapsRoot(p: string, rootPath: string): boolean {
  const within = (q: string, ancestor: string): boolean =>
    q === ancestor || q.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
  return within(p, rootPath) || within(rootPath, p);
}

/** parent 必须已存在、非符号链接目录、无 group/other 写位；返回其 realpath。 */
function statParent(p: string): string {
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw stagingError(E.INVALID_CONFIG);
    throw stagingError(E.IO_FAILED);
  }
  if (st.isSymbolicLink()) throw stagingError(E.UNSAFE_PATH);
  if (!st.isDirectory()) throw stagingError(E.INVALID_CONFIG);
  if ((st.mode & 0o022) !== 0) throw stagingError(E.UNSAFE_PATH);
  try {
    return realpathSync.native(p);
  } catch {
    throw stagingError(E.IO_FAILED);
  }
}

/** 返回根 dev/ino；同时一次性校验「根仍属我方」。任何不符 → OWNER_MISMATCH。 */
function statOwnedRoot(rootPath: string, markerPath: string, activePath: string): { dev: number; ino: number } {
  let st;
  let names: string[];
  try {
    st = lstatSync(rootPath);
    if (st.isSymbolicLink() || !st.isDirectory()) throw stagingError(E.OWNER_MISMATCH);
    if ((st.mode & 0o777) !== STAGING_ROOT_DIR_PERMISSION) throw stagingError(E.OWNER_MISMATCH);
    names = readdirSync(rootPath);
  } catch (err) {
    if (err instanceof StagingError) throw err;
    throw stagingError(E.OWNER_MISMATCH);
  }
  const extras = names.filter(
    (n) => n !== STAGING_ROOT_MARKER_FILE_NAME && n !== STAGING_ACTIVE_DIR_NAME,
  );
  if (extras.length > 0) throw stagingError(E.OWNER_MISMATCH); // 根内只允许标记 + active
  try {
    let mk;
    mk = lstatSync(markerPath);
    if (mk.isSymbolicLink() || !mk.isFile() || mk.nlink !== 1) throw stagingError(E.OWNER_MISMATCH);
    if ((mk.mode & 0o777) !== STAGING_ROOT_MARKER_PERMISSION) throw stagingError(E.OWNER_MISMATCH);
    if (mk.size > MAX_ENTRY_BYTES || mk.size !== MARKER_BYTES) throw stagingError(E.OWNER_MISMATCH);
    if (readFileSync(markerPath, 'utf8') !== MARKER_JSON) throw stagingError(E.OWNER_MISMATCH);
    if (names.includes(STAGING_ACTIVE_DIR_NAME)) {
      const a = lstatSync(activePath);
      if (a.isSymbolicLink() || !a.isDirectory()) throw stagingError(E.OWNER_MISMATCH);
    }
  } catch (err) {
    if (err instanceof StagingError) throw err;
    throw stagingError(E.OWNER_MISMATCH);
  }
  return { dev: st.dev, ino: st.ino };
}

/** owner.json 须为封闭规范形：仅 version/token 两键、version 匹配、token 为规范 UUID，
 *  且重序列化逐字节一致（据此拒绝重复键/空白/多余字段/坏 token）；不输出内容细节。 */
function isCanonicalOwnerJson(content: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || o.version !== STAGING_OWNER_VERSION) return false;
  if (typeof o.token !== 'string' || !CANONICAL_UUID_RE.test(o.token)) return false;
  return JSON.stringify(o) === content;
}

class StagingRootImpl implements StagingRoot {
  readonly #rootPath: string;
  readonly #activePath: string;
  readonly #assertRootOwnership: () => void;

  constructor(rootPath: string, activePath: string, assertRootOwnership: () => void) {
    this.#rootPath = rootPath;
    this.#activePath = activePath;
    this.#assertRootOwnership = assertRootOwnership;
  }

  async tryAcquire(): Promise<StagingLease> {
    return acquireStagingLease(this.#rootPath, MARKER_BYTES, this.#assertRootOwnership);
  }

  inspect(): StagingRootInspection {
    let names: string[];
    try {
      this.#assertRootOwnership();
      names = readdirSync(this.#rootPath);
    } catch {
      return { state: 'recovery_required', contentBytes: null };
    }
    if (!names.includes(STAGING_ACTIVE_DIR_NAME)) return { state: 'idle', contentBytes: MARKER_BYTES };
    try {
      const ownerNames = readdirSync(this.#activePath);
      if (ownerNames.length !== 1 || ownerNames[0] !== STAGING_OWNER_FILE_NAME) {
        return { state: 'recovery_required', contentBytes: null };
      }
      const ownerPath = join(this.#activePath, STAGING_OWNER_FILE_NAME);
      const st = lstatSync(ownerPath);
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
        return { state: 'recovery_required', contentBytes: null };
      }
      if (st.size > MAX_ENTRY_BYTES) return { state: 'recovery_required', contentBytes: null };
      const raw = readFileSync(ownerPath, 'utf8');
      if (!isCanonicalOwnerJson(raw)) return { state: 'recovery_required', contentBytes: null };
      return { state: 'occupied', contentBytes: MARKER_BYTES + st.size };
    } catch {
      return { state: 'recovery_required', contentBytes: null };
    }
  }
}

/** 打开/准备 staging 根（不获取锁）：创建前完成全部校验，已存在内容只验证不修改。 */
export function openStagingRoot(options: StagingRootOptions): StagingRoot {
  if (typeof options !== 'object' || options === null) throw stagingError(E.INVALID_CONFIG);
  // 封闭配置：仅接受 privateParentDir + protectedPaths，未知键拒绝。
  const optionKeys = Object.keys(options);
  if (
    optionKeys.length !== 2 ||
    !optionKeys.includes('privateParentDir') ||
    !optionKeys.includes('protectedPaths')
  ) {
    throw stagingError(E.INVALID_CONFIG);
  }
  const { privateParentDir, protectedPaths } = options as StagingRootOptions;
  if (typeof privateParentDir !== 'string' || !isAbsolute(privateParentDir)) {
    throw stagingError(E.INVALID_CONFIG);
  }
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) {
    throw stagingError(E.INVALID_CONFIG);
  }
  for (const p of protectedPaths) {
    if (typeof p !== 'string' || p === '' || !isAbsolute(p)) throw stagingError(E.INVALID_CONFIG);
  }

  const rootPath = join(statParent(normalizePath(privateParentDir)), STAGING_ROOT_DIR_NAME);
  const markerPath = join(rootPath, STAGING_ROOT_MARKER_FILE_NAME);
  const activePath = join(rootPath, STAGING_ACTIVE_DIR_NAME);

  // 创建之前：保存调用方原绝对路径副本（仅去尾部分隔符，保留 '.'/'..' 字面语义），据此
  // 做双向重叠判定；后续每次重校验都重新对原路径 realpath（符号链接/'..' 依真实语义解析），
  // 防调用方改数组或受保护别名后期重定向向根。
  const protectedOriginal: string[] = [];
  for (const p of protectedPaths) {
    const np = normalizePath(p);
    if (overlapsRoot(canonicalResolve(np), rootPath)) throw stagingError(E.UNSAFE_PATH);
    protectedOriginal.push(np);
  }

  let createdHere = false;
  try {
    lstatSync(rootPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw stagingError(E.IO_FAILED);
    try {
      mkdirSync(rootPath, { mode: STAGING_ROOT_DIR_PERMISSION });
      createdHere = true;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code !== 'EEXIST') throw stagingError(E.IO_FAILED);
      // EEXIST 输家：不写标记、不认领外部根；仅当下方已有我方固定标记时才可继续。
    }
  }
  let markerPresent = true;
  try {
    lstatSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw stagingError(E.IO_FAILED);
    markerPresent = false;
  }
  if (!markerPresent) {
    // 标记只写进本次 mkdir 成功的目录；输家/已存在根缺标记即视为非我方。
    if (!createdHere) throw stagingError(E.OWNER_MISMATCH);
    try {
      writeFileSync(markerPath, MARKER_JSON, {
        encoding: 'utf8', flag: 'wx', mode: STAGING_ROOT_MARKER_PERMISSION,
      });
    } catch {
      try {
        rmdirSync(rootPath); // 仅回滚本次新建且仍为空的目录
      } catch {
        /* 非空则保留 */
      }
      throw stagingError(E.IO_FAILED);
    }
  }
  const rootIdentity = statOwnedRoot(rootPath, markerPath, activePath);

  const assertRootOwnership = (): void => {
    const now = statOwnedRoot(rootPath, markerPath, activePath);
    if (now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino) {
      throw stagingError(E.OWNER_MISMATCH);
    }
    for (const np of protectedOriginal) {
      if (overlapsRoot(canonicalResolve(np), rootPath)) throw stagingError(E.OWNER_MISMATCH);
    }
  };

  return new StagingRootImpl(rootPath, activePath, assertRootOwnership);
}
