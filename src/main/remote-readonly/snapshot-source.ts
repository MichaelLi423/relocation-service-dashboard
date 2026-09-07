/**
 * 远程只读发布：源库在线快照（tasks 2.2 snapshot-source 切片）。
 *
 * - main-only：接收真实业务源库 DatabaseSync（bootstrap 打开、WAL、主进程自有）与
 *   已被调用方验证存在/为目录的 `privateTempParent`（同样来自 main，非 renderer）。
 * - 生命周期（成功/失败都尝试在 finally 清理本模块自有的临时产物）：
 *     1) 在 privateTempParent 下独占创建唯一临时子目录（mkdtemp，0700，绝不 chmod 既有目录）；
 *     2) runOnlineBackup(sourceDb, snapshotPath) 在线备份（node:sqlite backup，源库可继续
 *        正常读写），随后把快照文件收紧到 0600；
 *     3) 以 readOnly 打开快照文件，并用 readDatabaseIdentity 从**快照库**读取身份/业务修订
 *        —— 与快照同一份备份副本、绝不读活源库；
 *     4) 仅在 consumer 回调期间暴露内部只读 db + identity；回调返回后 close + 删除
 *        本模块自建的临时目录/文件（含只读打开可能产生的 -wal/-shm 附属）。
 * - 清理语义（诚实边界）：finally **逐个尝试** close 与删除；任一清理步骤自身失败即抛
 *   固定 SnapshotSourceError('SNAPSHOT_CLEANUP_FAILED')（metadata-only，不回显路径/底层
 *   cause），**不会**以成功返回/原错误掩盖清理失败。若 consumer 也抛错而清理又失败，
 *   SNAPSHOT_CLEANUP_FAILED 覆盖原错误（generic 清理失败优先）。OS 拒绝删除时本模块
 *   无法保证文件被移除——只保证如实报告 CLEANUP_FAILED。
 * - 错误 metadata-only：备份/权限/打开/身份读取/清理等内部失败一律抛稳定 code 的
 *   SnapshotSourceError，不回显原始路径/SQL/底层 message（runOnlineBackup 的 PersistenceError
 *   携带目标路径，必须在此拦截）。consumer 自身抛错且清理成功时原样上抛（不包装、不吞）。
 * - 非上传 API：无 network / native vault / control-store 写入；不修改源库字节与状态。
 *   快照 db 只在 callback 作用域内存在，绝不暴露给 renderer。
 */
import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../domain/core/errors';
import { runOnlineBackup } from '../../domain/capabilities/local-data-persistence/backup';
import {
  readDatabaseIdentity,
  type DatabaseIdentity,
} from '../../domain/capabilities/local-data-persistence/identity';

/** 临时目录名前缀（mkdtemp 保证唯一性，绝不复用既有目录）。 */
const SNAPSHOT_TEMP_PREFIX = 'readonly-snapshot-';
/** 快照文件名（固定叶子；目录由本模块独占新建）。 */
const SNAPSHOT_FILE_NAME = 'snapshot.db';

export const SNAPSHOT_TEMP_DIR_PERMISSION = 0o700;
export const SNAPSHOT_FILE_PERMISSION = 0o600;

export const SNAPSHOT_SOURCE_ERROR_CODES = {
  /** privateTempParent 缺失/非目录/符号链接（无法安全建临时目录）。 */
  SNAPSHOT_TEMP_PARENT_INVALID: 'SNAPSHOT_TEMP_PARENT_INVALID',
  /** 临时目录创建失败。 */
  SNAPSHOT_TEMP_DIR_CREATE_FAILED: 'SNAPSHOT_TEMP_DIR_CREATE_FAILED',
  /** 在线备份失败（runOnlineBackup 底层错误被包装为稳定 code，不泄漏路径）。 */
  SNAPSHOT_BACKUP_FAILED: 'SNAPSHOT_BACKUP_FAILED',
  /** 快照文件权限收紧失败。 */
  SNAPSHOT_PERMISSION_FAILED: 'SNAPSHOT_PERMISSION_FAILED',
  /** 快照文件只读打开失败。 */
  SNAPSHOT_OPEN_FAILED: 'SNAPSHOT_OPEN_FAILED',
  /** 从快照库读取身份/业务修订失败。 */
  SNAPSHOT_IDENTITY_FAILED: 'SNAPSHOT_IDENTITY_FAILED',
  /**
   * 清理失败（close 快照连接或删除临时目录/文件失败）：metadata-only 覆盖优先错误；
   * 本模块只保证如实报告，不保证 OS 拒绝删除时文件必然消失。
   */
  SNAPSHOT_CLEANUP_FAILED: 'SNAPSHOT_CLEANUP_FAILED',
} as const;

export type SnapshotSourceErrorCode =
  (typeof SNAPSHOT_SOURCE_ERROR_CODES)[keyof typeof SNAPSHOT_SOURCE_ERROR_CODES];

/** metadata-only 快照错误：message 只含稳定 code，绝不回显路径/文件名/底层 cause。 */
export class SnapshotSourceError extends DomainError {
  constructor(code: SnapshotSourceErrorCode) {
    super(code, `snapshot source ${code}`);
    this.name = 'SnapshotSourceError';
  }
}

function snapshotError(code: SnapshotSourceErrorCode): SnapshotSourceError {
  return new SnapshotSourceError(code);
}

/** consumer 在回调期间可见的只读快照上下文（内部对象，生命周期仅限回调）。 */
export interface PublicationSnapshotContext {
  /** 快照库只读连接（只在 consumer 回调期间有效；模块负责 close）。 */
  readonly db: DatabaseSync;
  /** 从快照库读取的身份/业务修订（非活源库）。 */
  readonly identity: DatabaseIdentity;
}

/** consumer：回调期间读快照；返回值透传为 withPublicationSnapshot 的结果。 */
export type PublicationSnapshotConsumer<R> = (
  snapshot: PublicationSnapshotContext,
) => R | Promise<R>;

/**
 * 生成源库的本地只读快照并仅在回调期间消费。
 * - 快照 = 与该身份读取同一份 backup 副本的**一致已提交视图**（在线备份期间源库可并发
 *   提交；SQLite backup 可能重跑步骤，因此不宣称「精确到备份开始瞬间」的时间点语义）。
 * - 成功与失败路径都**尝试**关闭快照连接并删除本模块自建的临时目录/文件；任一清理失败
 *   抛 SNAPSHOT_CLEANUP_FAILED（见头部「清理语义」），不以成功或原错误掩盖。
 * - 本模块内部的任何失败（临时目录/备份/权限/打开/身份读取/清理）抛 metadata-only
 *   SnapshotSourceError；consumer 自身抛错且清理成功时原样上抛。
 */
export async function withPublicationSnapshot<R>(
  sourceDb: DatabaseSync,
  options: { privateTempParent: string },
  consumer: PublicationSnapshotConsumer<R>,
): Promise<R> {
  const { privateTempParent } = options;
  if (!privateTempParent || typeof privateTempParent !== 'string') {
    throw snapshotError('SNAPSHOT_TEMP_PARENT_INVALID');
  }
  // 父目录必须是真实存在的普通目录、非符号链接（防止把临时目录建到不可信位置）。
  let st;
  let ls;
  try {
    st = statSync(privateTempParent);
    ls = lstatSync(privateTempParent);
  } catch {
    throw snapshotError('SNAPSHOT_TEMP_PARENT_INVALID');
  }
  if (!st.isDirectory() || ls.isSymbolicLink()) {
    throw snapshotError('SNAPSHOT_TEMP_PARENT_INVALID');
  }
  // 独占唯一目录（mkdtemp 原子创建：失败即无产物，无需回滚）。
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(privateTempParent, SNAPSHOT_TEMP_PREFIX));
  } catch {
    throw snapshotError('SNAPSHOT_TEMP_DIR_CREATE_FAILED');
  }
  const snapshotPath = join(tempDir, SNAPSHOT_FILE_NAME);
  let snapshotDb: DatabaseSync | null = null;
  try {
    // mkdtemp 模式受 umask 影响：收紧到 0700。此步在 try 内 → 失败时由统一 finally
    // 回收 tempDir（含 rm 失败如实报 CLEANUP_FAILED，不再嵌套静默回滚）。
    try {
      if (process.platform !== 'win32') chmodSync(tempDir, SNAPSHOT_TEMP_DIR_PERMISSION);
    } catch {
      throw snapshotError('SNAPSHOT_TEMP_DIR_CREATE_FAILED');
    }
    try {
      await runOnlineBackup(sourceDb, snapshotPath);
    } catch {
      throw snapshotError('SNAPSHOT_BACKUP_FAILED');
    }
    try {
      if (process.platform !== 'win32') chmodSync(snapshotPath, SNAPSHOT_FILE_PERMISSION);
    } catch {
      throw snapshotError('SNAPSHOT_PERMISSION_FAILED');
    }
    try {
      snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    } catch {
      throw snapshotError('SNAPSHOT_OPEN_FAILED');
    }
    let identity: DatabaseIdentity;
    try {
      identity = readDatabaseIdentity(snapshotDb);
    } catch {
      throw snapshotError('SNAPSHOT_IDENTITY_FAILED');
    }
    return await consumer({ db: snapshotDb, identity });
  } finally {
    // 逐个尝试且两者都执行：先 close（否则占用会阻止删除），再删除临时目录
    // （含只读打开可能产生的 -wal/-shm）。任一失败 → 固定 SNAPSHOT_CLEANUP_FAILED，
    // 覆盖 consumer/内部原错误（generic 清理失败优先），metadata-only 不回显路径/cause。
    let cleanupFailed = false;
    if (snapshotDb !== null) {
      try {
        snapshotDb.close();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw snapshotError('SNAPSHOT_CLEANUP_FAILED');
  }
}
