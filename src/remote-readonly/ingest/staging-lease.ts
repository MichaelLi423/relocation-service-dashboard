/**
 * 远程只读 ingest：staging 跨进程租约（lease lane；当前只含 owner.json，无 openFile）。
 *
 * - `acquireStagingLease(rootPath, rootMetadataBytes, assertRootOwnership)` 仅供 root
 *   lane（已校验的 trusted staging 根）内部调用，uploader 不得自行构造 lease。
 *   `assertRootOwnership()` 由 root lane 提供，在 acquire/assertActive/dispose 三个
 *   边界校验「根仍属我方」，不满足即抛固定 StagingError。
 * - 锁 = `join(rootPath, 'active')` 的原子 mkdir(0700)。目录已存在（无论空/崩溃残留/
 *   他人持有）→ BUSY；无 TTL/PID/mtime 接管、不自动恢复、不删除他人内容。
 * - 持锁后独占写 owner.json（'wx'，0600）：固定 `{version:1, token:randomUUID()}`，
 *   ≤4KiB。owner 写/权限收紧/身份采集任一失败都保留 active/（后续继续 BUSY），不做
 *   任何清理、不接管既有 active。
 * - guard 回调（root lane）任何抛错都在此收口：StagingError → 重建保留原 code；
 *   原始错误 → 固定 OWNER_MISMATCH。一律 metadata-only，绝不回显 canary/路径/cause。
 * - lease 敏感字段（路径/token/owner 字节/dev·ino）一律 `#private`；对外仅暴露
 *   metadataBytes（root 元数据字节 + owner 字节）与状态方法，JSON/状态不含路径/token。
 * - assertActive：非 failed/released 才继续，随后 guard + active/owner dev·ino 精确
 *   校验（owner 必须普通文件、nlink=1、≤4KiB、字节精确一致）。markFailed 阻止活动但
 *   允许 dispose。
 * - dispose 顺序（身份校验必须先于任何 readdir，避免跟随被替换的 active 符号链接）：
 *   1) guard + root/active/owner 身份校验；2) active/ 只允许我方 owner.json，多余条目
 *   在删除前拒绝（固定 CLEANUP_FAILED，锁保留，任何内容都不删）；3) unlink owner.json；
 *   4) 最后 rmdir active/。删除失败一律 CLEANUP_FAILED，锁不被窃取；已释放再次调用
 *   幂等；owner 已删而 rmdir 失败时可安全重试。
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { STAGING_ERROR_CODES, StagingError, type StagingErrorCode } from './staging-contract';

/** active/ 锁目录固定名（staging 根内）。 */
export const STAGING_ACTIVE_DIR_NAME = 'active';
/** active/ 内租约 owner 文件固定名。 */
export const STAGING_OWNER_FILE_NAME = 'owner.json';
/** owner.json 固定 schema version。 */
export const STAGING_OWNER_VERSION = 1;
export const STAGING_ACTIVE_DIR_PERMISSION = 0o700;
export const STAGING_OWNER_FILE_PERMISSION = 0o600;

/** owner.json 读取/写入边界（≤4KiB；超出视为非我方内容/不可写）。 */
const OWNER_MAX_BYTES = 4 * 1024;
/** Windows 无 POSIX 权限位语义；不声明 ACL 等价。 */
const IS_WINDOWS = process.platform === 'win32';

const E = STAGING_ERROR_CODES;

function stagingError(code: StagingErrorCode): StagingError {
  return new StagingError(code);
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/** guard 回调错误收口：已知 StagingError 重建保留 code；原始错误固定 OWNER_MISMATCH。 */
function fixedGuardError(err: unknown): StagingError {
  if (err instanceof StagingError) return new StagingError(err.code);
  return stagingError(E.OWNER_MISMATCH);
}

export interface StagingLease {
  /** root 元数据字节 + 当前 owner 字节（不含路径/token）。 */
  readonly metadataBytes: number;
  /** 租约仍有效（未 failed/released）且锁仍归我方；否则抛固定 StagingError。 */
  assertActive(): void;
  /** 标记失败：阻止后续活动，但 dispose 仍可清理。 */
  markFailed(): void;
  /** 释放锁（只清理我方 owner.json 与 active/）；已释放再次调用幂等。 */
  dispose(): Promise<void>;
}

interface LeaseContext {
  rootMetadataBytes: number;
  assertRootOwnership: () => void;
  activeDir: string;
  ownerPath: string;
  ownerJson: string;
  activeDev: number;
  activeIno: number;
  ownerDev: number;
  ownerIno: number;
}

class StagingLeaseImpl implements StagingLease {
  readonly #ctx: LeaseContext;
  #ownerRemoved = false;
  #failed = false;
  #released = false;

  constructor(ctx: LeaseContext) {
    this.#ctx = ctx;
  }

  get metadataBytes(): number {
    return this.#ctx.rootMetadataBytes + Buffer.byteLength(this.#ctx.ownerJson, 'utf8');
  }

  assertActive(): void {
    if (this.#released || this.#failed) throw stagingError(E.INVALID_STATE);
    this.#assertOwned();
  }

  markFailed(): void {
    if (this.#released) throw stagingError(E.INVALID_STATE);
    this.#failed = true;
  }

  async dispose(): Promise<void> {
    if (this.#released) return;
    try {
      // 先身份校验（guard + active/owner dev·ino + 精确 owner 字节），后 readdir：
      // active 被替换为符号链接时在此拒绝，绝不跟随读取外来内容。
      this.#assertOwned();
      this.#assertOnlyOwnerJson();
      if (!this.#ownerRemoved) {
        try {
          unlinkSync(this.#ctx.ownerPath);
        } catch {
          throw stagingError(E.CLEANUP_FAILED);
        }
        this.#ownerRemoved = true;
      }
      try {
        rmdirSync(this.#ctx.activeDir);
      } catch {
        throw stagingError(E.CLEANUP_FAILED);
      }
      this.#released = true;
    } catch (err) {
      this.#failed = true;
      if (err instanceof StagingError) throw err;
      throw stagingError(E.CLEANUP_FAILED);
    }
  }

  /** guard 后校验 active/owner 身份（dev·ino 精确比较）与精确 owner 字节。 */
  #assertOwned(): void {
    try {
      this.#ctx.assertRootOwnership();
    } catch (err) {
      throw fixedGuardError(err);
    }
    try {
      const active = lstatSync(this.#ctx.activeDir);
      if (active.isSymbolicLink() || !active.isDirectory()) throw stagingError(E.OWNER_MISMATCH);
      if (active.dev !== this.#ctx.activeDev || active.ino !== this.#ctx.activeIno) {
        throw stagingError(E.OWNER_MISMATCH);
      }
      if (!this.#ownerRemoved) {
        const owner = lstatSync(this.#ctx.ownerPath);
        if (owner.isSymbolicLink() || !owner.isFile() || owner.nlink !== 1) {
          throw stagingError(E.OWNER_MISMATCH);
        }
        if (owner.size > OWNER_MAX_BYTES) throw stagingError(E.OWNER_MISMATCH);
        if (owner.dev !== this.#ctx.ownerDev || owner.ino !== this.#ctx.ownerIno) {
          throw stagingError(E.OWNER_MISMATCH);
        }
        if (readFileSync(this.#ctx.ownerPath, 'utf8') !== this.#ctx.ownerJson) {
          throw stagingError(E.OWNER_MISMATCH);
        }
      }
    } catch (err) {
      if (err instanceof StagingError) throw err;
      throw stagingError(E.OWNER_MISMATCH);
    }
  }

  /** active/ 只允许我方 owner.json；多余条目在删除前拒绝（固定 CLEANUP_FAILED，锁保留）。 */
  #assertOnlyOwnerJson(): void {
    let names: string[];
    try {
      names = readdirSync(this.#ctx.activeDir);
    } catch {
      throw stagingError(E.OWNER_MISMATCH);
    }
    const extras = names.filter((n) => n !== STAGING_OWNER_FILE_NAME);
    if (extras.length > 0) throw stagingError(E.CLEANUP_FAILED);
    if (!this.#ownerRemoved && names.length === 0) throw stagingError(E.OWNER_MISMATCH);
    if (this.#ownerRemoved && names.length > 0) throw stagingError(E.CLEANUP_FAILED);
  }
}

/**
 * 在已校验的 staging 根上原子获取跨进程租约（root lane 内部调用）。
 * guard 在 mkdir 之前执行（错误收口为固定 StagingError）；mkdir EEXIST → BUSY；
 * mkdir 后任一失败（chmod/owner 生成/超界/写入/身份采集）都保留 active/，后续 BUSY。
 */
export function acquireStagingLease(
  rootPath: string,
  rootMetadataBytes: number,
  assertRootOwnership: () => void,
): StagingLease {
  if (
    typeof rootPath !== 'string' ||
    rootPath === '' ||
    typeof assertRootOwnership !== 'function' ||
    !Number.isSafeInteger(rootMetadataBytes) ||
    rootMetadataBytes < 0
  ) {
    throw stagingError(E.INVALID_CONFIG);
  }
  // guard BEFORE mkdir：根不再属我方时不创建锁（错误固定化，无 canary）。
  try {
    assertRootOwnership();
  } catch (err) {
    throw fixedGuardError(err);
  }
  const activeDir = join(rootPath, STAGING_ACTIVE_DIR_NAME);
  try {
    mkdirSync(activeDir, { mode: STAGING_ACTIVE_DIR_PERMISSION });
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw stagingError(E.BUSY);
    throw stagingError(E.IO_FAILED);
  }
  try {
    // 收紧本函数刚创建的 active/ 到 0700（不受 umask 影响；绝不触碰外来对象）。
    if (!IS_WINDOWS) chmodSync(activeDir, STAGING_ACTIVE_DIR_PERMISSION);
  } catch {
    throw stagingError(E.IO_FAILED);
  }
  let ownerJson: string;
  try {
    ownerJson = JSON.stringify({
      version: STAGING_OWNER_VERSION,
      token: randomUUID(),
    });
  } catch {
    throw stagingError(E.IO_FAILED);
  }
  if (Buffer.byteLength(ownerJson, 'utf8') > OWNER_MAX_BYTES) throw stagingError(E.IO_FAILED);
  const ownerPath = join(activeDir, STAGING_OWNER_FILE_NAME);
  try {
    writeFileSync(ownerPath, ownerJson, {
      encoding: 'utf8',
      flag: 'wx',
      mode: STAGING_OWNER_FILE_PERMISSION,
    });
    // 收紧本函数刚创建的 owner.json 到 0600。
    if (!IS_WINDOWS) chmodSync(ownerPath, STAGING_OWNER_FILE_PERMISSION);
  } catch {
    // 写入/收紧失败：保留 active/owner（后续 acquire 持续 BUSY），不做清理、不接管。
    throw stagingError(E.IO_FAILED);
  }
  let activeSt;
  let ownerSt;
  try {
    activeSt = lstatSync(activeDir);
    ownerSt = lstatSync(ownerPath);
  } catch {
    // 身份采集失败：不伪造成功；active/owner 已落盘 → 后续 acquire BUSY。
    throw stagingError(E.IO_FAILED);
  }
  return new StagingLeaseImpl({
    rootMetadataBytes,
    assertRootOwnership,
    activeDir,
    ownerPath,
    ownerJson,
    activeDev: activeSt.dev,
    activeIno: activeSt.ino,
    ownerDev: ownerSt.dev,
    ownerIno: ownerSt.ino,
  });
}
