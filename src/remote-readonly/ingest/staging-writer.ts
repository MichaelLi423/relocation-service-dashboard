/**
 * staging-writer（tasks 3.1 bounded writer lane）。
 *
 * StagingBudget：同一 staging run 的实际内容记账容器。
 * - usedBytes = 已实际写盘字节，不含任何 reservation；close 不释放（物理占用直至文件
 *   删除，quota 释放属后续 root lane 的 lease disposal）；
 * - failed = sticky IO 故障标记，为 true 后所有后续 write 拒绝；
 * - busy = 全局写互斥：同一 budget 同时只允许一个写入在途，并发写以 WRITE_BUSY 拒绝、
 *   绝不排队（无 unbounded queue）。
 *
 * BoundedStagingWriter：只接收 root lane 传入的已打开 FileHandle（main-only），按 kind
 * 有界写入。固定顺序：状态/输入拒绝 → 同步抢 busy → per-file + 全局配额预检（BEFORE
 * 复制/写盘）→ 稳定字节副本（BEFORE 任何 await）→ fstat 守卫 → 显式 position 循环写入。
 * 预检拒绝（FILE_LIMIT_EXCEEDED/QUOTA_EXCEEDED）不污染 budget；零进展/越界 bytesWritten/
 * 底层 throw（含 ENOSPC 与 handle.stat 抛错）/fstat 守卫失败一律在固定 IO catch 内收口：
 * sticky 标记 budget.failed 并抛固定 IO_FAILED（原错误/消息/cause 不外泄）。
 * 部分写按实际正整数 bytesWritten 逐步记账并推进偏移。
 *
 * 边界声明：只做 quota/文件级有界写入，无文件名/路径/owner/远程输入；
 * BUSY/UNSAFE_PATH/OWNER_MISMATCH 保留给 staging root lane（本文件不抛出）。
 */
import type { FileHandle } from 'node:fs/promises';
import {
  STAGING_ERROR_CODES,
  STAGING_FILE_LIMITS,
  STAGING_TOTAL_LIMIT_BYTES,
  StagingError,
  type StagingFileKind,
} from './staging-contract';

/** 实际内容记账容器；同一 run 的多个 writer 共享同一实例以强制全局上限。 */
export class StagingBudget {
  private _usedBytes: number;
  private _failed = false;
  private _busy = false;

  constructor(initialBytes = 0) {
    if (
      !Number.isSafeInteger(initialBytes) ||
      initialBytes < 0 ||
      initialBytes > STAGING_TOTAL_LIMIT_BYTES
    ) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_CONFIG);
    }
    this._usedBytes = initialBytes;
  }

  get usedBytes(): number {
    return this._usedBytes;
  }

  get failed(): boolean {
    return this._failed;
  }

  /** @internal 同步抢占写锁；false=已有写入在途。 */
  _tryAcquire(): boolean {
    if (this._busy) {
      return false;
    }
    this._busy = true;
    return true;
  }

  /** @internal 释放写锁。 */
  _release(): void {
    this._busy = false;
  }

  /** @internal 按实际写盘字节记账。 */
  _account(bytes: number): void {
    this._usedBytes += bytes;
  }

  /** @internal sticky 失败。 */
  _markFailed(): void {
    this._failed = true;
  }
}

/** 有界 staging writer：单文件配额 + 共享 budget 全局配额 + 单在途写入。 */
export class BoundedStagingWriter {
  private readonly handle: FileHandle;
  private readonly kind: StagingFileKind;
  private readonly budget: StagingBudget;
  private _bytesWritten = 0;
  private closing = false;
  private closed = false;
  private inflight: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(handle: FileHandle, kind: StagingFileKind, budget: StagingBudget) {
    if (
      handle === null ||
      handle === undefined ||
      !Object.prototype.hasOwnProperty.call(STAGING_FILE_LIMITS, kind) ||
      !(budget instanceof StagingBudget) ||
      typeof handle.write !== 'function' ||
      typeof handle.stat !== 'function' ||
      typeof handle.close !== 'function'
    ) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_CONFIG);
    }
    if (budget.failed) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_STATE);
    }
    this.handle = handle;
    this.kind = kind;
    this.budget = budget;
  }

  /** 已实际写盘字节数（与实际文件 size 一致；不含 reservation）。 */
  get bytesWritten(): number {
    return this._bytesWritten;
  }

  /** 空输入是合法 no-op（不触碰文件/预算/锁）。 */
  async write(data: Uint8Array): Promise<void> {
    if (this.closed || this.closing) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_STATE);
    }
    if (!(data instanceof Uint8Array)) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_STATE);
    }
    if (this.budget.failed) {
      throw new StagingError(STAGING_ERROR_CODES.INVALID_STATE);
    }
    if (data.byteLength === 0) {
      return;
    }
    if (!this.budget._tryAcquire()) {
      throw new StagingError(STAGING_ERROR_CODES.WRITE_BUSY);
    }
    const task = this.writeLocked(data);
    this.inflight = task;
    try {
      await task;
    } finally {
      if (this.inflight === task) {
        this.inflight = null;
      }
    }
  }

  /** 幂等 close；有在途写入则先等待结算（先前写失败不跳过关闭），不释放 quota。 */
  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async writeLocked(data: Uint8Array): Promise<void> {
    try {
      // 预检必须先于复制/写盘，且全部在首个 await 前同步完成。
      if (this._bytesWritten + data.byteLength > STAGING_FILE_LIMITS[this.kind]) {
        throw new StagingError(STAGING_ERROR_CODES.FILE_LIMIT_EXCEEDED);
      }
      if (this.budget.usedBytes + data.byteLength > STAGING_TOTAL_LIMIT_BYTES) {
        throw new StagingError(STAGING_ERROR_CODES.QUOTA_EXCEEDED);
      }
      const copy = new Uint8Array(data.byteLength);
      copy.set(data); // 稳定副本：调用方复用/改写原 buffer 不影响本次写入
      await this.writeCopy(copy);
    } finally {
      this.budget._release();
    }
  }

  private async writeCopy(copy: Uint8Array): Promise<void> {
    try {
      // 受控新文件守卫（handle.stat 的原始错误也收口为固定 IO_FAILED）：
      // 常规文件、nlink===1、size===本 writer 已写字节。
      const stats = await this.handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size !== this._bytesWritten) {
        throw new StagingError(STAGING_ERROR_CODES.IO_FAILED);
      }
      let offset = 0;
      while (offset < copy.byteLength) {
        const remaining = copy.byteLength - offset;
        const { bytesWritten } = await this.handle.write(
          copy,
          offset,
          remaining,
          this._bytesWritten, // 显式 position，不依赖文件游标
        );
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
          // 零进展（含 ENOSPC）/越界报告：物理字节无法与账面对齐
          throw new StagingError(STAGING_ERROR_CODES.IO_FAILED);
        }
        this._bytesWritten += bytesWritten;
        this.budget._account(bytesWritten);
        offset += bytesWritten;
      }
    } catch {
      this.budget._markFailed();
      throw new StagingError(STAGING_ERROR_CODES.IO_FAILED);
    }
  }

  private async performClose(): Promise<void> {
    const pending = this.inflight;
    this.closing = true;
    try {
      if (pending !== null) {
        try {
          await pending;
        } catch {
          // 先前写失败已 sticky；仍须继续关闭句柄
        }
      }
    } finally {
      this.closed = true;
    }
    try {
      await this.handle.close();
    } catch {
      this.budget._markFailed();
      throw new StagingError(STAGING_ERROR_CODES.CLEANUP_FAILED);
    }
  }
}
