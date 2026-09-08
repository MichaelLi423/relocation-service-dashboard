/**
 * staging-writer.test.ts（tasks 3.1 bounded writer lane tests slice）。
 *
 * 只使用合成数据与测试临时目录（os.tmpdir 下 mkdtemp，afterEach 清理），不触碰真实
 * 客户文件/OS 凭据/网络。大上限用例复用同一小 chunk 写盘，不构建/不读回大数组
 * （projection 64MiB / build 128MiB / 全局 256MiB 只断言字节数与配额记账）。
 *
 * 覆盖：真实临时 FileHandle 的内容/stat/记账一致性、manifest/projection/build 三类
 * per-file 精确封顶与超限拒绝、多真实文件共享 budget 的全局 256MiB 封顶与超限拒绝、
 * close 不返还配额；委托真实句柄的故障注入（部分写循环、零进展、部分写后 ENOSPC、
 * stat 抛错 sanitize、close 失败固定码）；延迟 stat/write 证明跨 writer 并发 WRITE_BUSY
 * 不排队、close 等待在途写入、调用方改写原 buffer 不影响已写内容；构造/输入/文件守卫
 * 的固定拒绝（null/undefined handle 是 INVALID_CONFIG 而非 TypeError）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedStagingWriter, StagingBudget } from '../../src/remote-readonly/ingest/staging-writer';
import {
  STAGING_ERROR_CODES,
  STAGING_FILE_LIMITS,
  STAGING_TOTAL_LIMIT_BYTES,
  StagingError,
  type StagingErrorCode,
  type StagingFileKind,
} from '../../src/remote-readonly/ingest/staging-contract';

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

type WriteOutcome = { bytesWritten: number; buffer: Uint8Array };
type ProbeStats = { isFile(): boolean; nlink: number; size: number };

interface HandleBehavior {
  stat?: () => Promise<ProbeStats> | ProbeStats;
  write?: (buffer: Uint8Array, offset: number, length: number, position: number) => Promise<WriteOutcome>;
  close?: () => Promise<void>;
}

/** 委托真实 FileHandle 的行为包装：可注入 stat/write/close 故障或延迟。 */
function wrapHandle(real: FileHandle, behavior: HandleBehavior = {}): FileHandle {
  return {
    stat: () => (behavior.stat !== undefined ? behavior.stat() : real.stat()),
    write: (buffer: Uint8Array, offset: number, length: number, position: number | null) =>
      behavior.write !== undefined
        ? behavior.write(buffer, offset, length, position ?? 0)
        : real.write(buffer, offset, length, position),
    close: () => (behavior.close !== undefined ? behavior.close() : real.close()),
  } as unknown as FileHandle;
}

const openHandles: FileHandle[] = [];
const tempDirs: string[] = [];

/** 在系统临时目录创建受控新文件（'w' 截断空文件）；目录/句柄由 afterEach 清理。 */
async function makeTempFile(): Promise<{ path: string; real: FileHandle }> {
  const dir = await mkdtemp(join(tmpdir(), 'staging-writer-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'staging.bin');
  const real = await open(path, 'w');
  openHandles.push(real);
  return { path, real };
}

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    await handle.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function patternChunk(size: number, fill = 0x61): Uint8Array {
  const chunk = new Uint8Array(size);
  chunk.fill(fill);
  return chunk;
}

async function errorOf(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectFixed(error: unknown, code: StagingErrorCode): void {
  expect(error).toBeInstanceOf(StagingError);
  expect((error as StagingError).code).toBe(code);
  expect((error as StagingError).message).toBe(`staging ${code}`);
}

describe('真实临时文件：内容与记账', () => {
  it('写入内容落盘，stat/bytesWritten/usedBytes 一致；close 不释放 quota', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    const a = patternChunk(7, 0x61);
    const b = patternChunk(5, 0x62);
    await w.write(a);
    await w.write(b);
    expect(w.bytesWritten).toBe(12);
    expect(budget.usedBytes).toBe(12);
    expect((await real.stat()).size).toBe(12);
    expect((await stat(path)).size).toBe(12);
    await w.close();
    // close 不返还配额：物理文件删除前占用仍计入（quota 释放属 root lane）。
    expect(budget.usedBytes).toBe(12);
    const content = await readFile(path);
    const expected = Buffer.concat([Buffer.from(a), Buffer.from(b)]);
    expect(content.equals(expected)).toBe(true);
  });
});

describe('真实临时文件：per-file 上限（复用同一 chunk 精确封顶 + 超限）', () => {
  it('manifest：复用 chunk 精确填满 64KiB；+1 字节在写盘前被 FILE_LIMIT_EXCEEDED 拒绝且文件不变', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    const chunk = patternChunk(4096);
    const repeats = STAGING_FILE_LIMITS.manifest / chunk.byteLength;
    for (let i = 0; i < repeats; i += 1) {
      await w.write(chunk);
    }
    expect(w.bytesWritten).toBe(STAGING_FILE_LIMITS.manifest);
    expect(budget.usedBytes).toBe(STAGING_FILE_LIMITS.manifest);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.manifest);
    await expect(w.write(patternChunk(1))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.FILE_LIMIT_EXCEEDED,
    });
    expect(budget.failed).toBe(false); // 配额预检拒绝不污染 budget
    expect(w.bytesWritten).toBe(STAGING_FILE_LIMITS.manifest);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.manifest);
    await w.close();
  });

  it('manifest：超 64KiB 的单次写入在复制/写盘前拒绝（文件保持 0 字节）', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    await expect(w.write(patternChunk(STAGING_FILE_LIMITS.manifest + 1))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.FILE_LIMIT_EXCEEDED,
    });
    expect(budget.usedBytes).toBe(0);
    expect(budget.failed).toBe(false);
    expect((await stat(path)).size).toBe(0);
    await w.close();
  });

  it('projection：复用 1MiB chunk 精确填满 64MiB；+1 字节被 FILE_LIMIT_EXCEEDED 拒绝', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'projection', budget);
    const chunk = patternChunk(MIB);
    const repeats = STAGING_FILE_LIMITS.projection / chunk.byteLength;
    for (let i = 0; i < repeats; i += 1) {
      await w.write(chunk);
    }
    expect(w.bytesWritten).toBe(STAGING_FILE_LIMITS.projection);
    expect(budget.usedBytes).toBe(STAGING_FILE_LIMITS.projection);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.projection);
    await expect(w.write(patternChunk(1))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.FILE_LIMIT_EXCEEDED,
    });
    expect(budget.failed).toBe(false);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.projection);
    await w.close();
  }, 120_000);

  it('build：复用 1MiB chunk 精确填满 128MiB；+1 字节被 FILE_LIMIT_EXCEEDED 拒绝', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'build', budget);
    const chunk = patternChunk(MIB);
    const repeats = STAGING_FILE_LIMITS.build / chunk.byteLength;
    for (let i = 0; i < repeats; i += 1) {
      await w.write(chunk);
    }
    expect(w.bytesWritten).toBe(STAGING_FILE_LIMITS.build);
    expect(budget.usedBytes).toBe(STAGING_FILE_LIMITS.build);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.build);
    await expect(w.write(patternChunk(1))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.FILE_LIMIT_EXCEEDED,
    });
    expect(budget.failed).toBe(false);
    expect((await stat(path)).size).toBe(STAGING_FILE_LIMITS.build);
    await w.close();
  }, 120_000);
});

describe('真实临时文件：全局 256MiB（多真实受控文件共享 budget）', () => {
  it('2×projection + 1×build 精确封顶 256MiB；新 writer 再写被 QUOTA_EXCEEDED 拒绝；close 无配额返还', async () => {
    const f1 = await makeTempFile();
    const f2 = await makeTempFile();
    const f3 = await makeTempFile();
    const f4 = await makeTempFile();
    const budget = new StagingBudget();
    // writer-unit 在单 run 内可同类多个（root lane 后续收紧为每类一个）。
    const p1 = new BoundedStagingWriter(f1.real, 'projection', budget);
    const p2 = new BoundedStagingWriter(f2.real, 'projection', budget);
    const b1 = new BoundedStagingWriter(f3.real, 'build', budget);
    const chunk = patternChunk(MIB);
    for (let i = 0; i < STAGING_FILE_LIMITS.projection / MIB; i += 1) {
      await p1.write(chunk);
    }
    for (let i = 0; i < STAGING_FILE_LIMITS.projection / MIB; i += 1) {
      await p2.write(chunk);
    }
    for (let i = 0; i < STAGING_FILE_LIMITS.build / MIB; i += 1) {
      await b1.write(chunk);
    }
    expect(budget.usedBytes).toBe(STAGING_TOTAL_LIMIT_BYTES);
    expect((await stat(f1.path)).size).toBe(STAGING_FILE_LIMITS.projection);
    expect((await stat(f2.path)).size).toBe(STAGING_FILE_LIMITS.projection);
    expect((await stat(f3.path)).size).toBe(STAGING_FILE_LIMITS.build);
    await p1.close();
    await p2.close();
    await b1.close();
    expect(budget.usedBytes).toBe(STAGING_TOTAL_LIMIT_BYTES); // close 不返还配额
    // 第 4 个 writer：per-file 仍有余量，但全局已满 → 写盘前 QUOTA_EXCEEDED。
    const p3 = new BoundedStagingWriter(f4.real, 'projection', budget);
    await expect(p3.write(patternChunk(1))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.QUOTA_EXCEEDED,
    });
    expect(budget.failed).toBe(false);
    expect((await stat(f4.path)).size).toBe(0);
    await p3.close();
  }, 120_000);
});

describe('故障注入：委托真实句柄', () => {
  it('部分写循环按实际字节记账，落盘内容完整一致', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    let call = 0;
    const probe = wrapHandle(real, {
      write: async (buffer, offset, length, position) => {
        call += 1;
        const take = call === 1 ? Math.min(3, length) : length;
        return real.write(buffer, offset, take, position);
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    await w.write(encoder.encode('hello'));
    expect(call).toBe(2);
    expect(w.bytesWritten).toBe(5);
    expect(budget.usedBytes).toBe(5);
    expect((await stat(path)).size).toBe(5);
    await w.close();
    const content = await readFile(path);
    expect(content.equals(Buffer.from('hello'))).toBe(true);
  });

  it('零进展写入 → sticky IO_FAILED（固定消息），后续写入拒绝', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const probe = wrapHandle(real, {
      write: async () => ({ bytesWritten: 0, buffer: new Uint8Array(0) }),
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    const err = await errorOf(w.write(encoder.encode('x')));
    expectFixed(err, STAGING_ERROR_CODES.IO_FAILED);
    expect(budget.failed).toBe(true);
    expect(w.bytesWritten).toBe(0);
    expect((await stat(path)).size).toBe(0);
    await expect(w.write(encoder.encode('y'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.INVALID_STATE,
    });
    await w.close(); // 先前的写失败不跳过 close
  });

  it('部分写后 ENOSPC：已记账/落盘部分保留，错误固定且消息脱敏', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    let call = 0;
    const probe = wrapHandle(real, {
      write: async (buffer, offset, length, position) => {
        call += 1;
        if (call === 1) {
          return real.write(buffer, offset, Math.min(2, length), position);
        }
        const fault = new Error('enospc-canary-secret') as Error & { code?: string };
        fault.code = 'ENOSPC';
        throw fault;
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    const err = await errorOf(w.write(encoder.encode('hello')));
    expectFixed(err, STAGING_ERROR_CODES.IO_FAILED);
    expect(budget.failed).toBe(true);
    expect(w.bytesWritten).toBe(2);
    expect(budget.usedBytes).toBe(2);
    expect((await stat(path)).size).toBe(2);
    await w.close();
  });

  it('handle.stat 抛错 → 固定 IO_FAILED + sticky（raw 错误不外泄）', async () => {
    const { real } = await makeTempFile();
    const budget = new StagingBudget();
    const probe = wrapHandle(real, {
      stat: async () => {
        throw new Error('stat-canary-secret');
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    const err = await errorOf(w.write(encoder.encode('x')));
    expectFixed(err, STAGING_ERROR_CODES.IO_FAILED);
    expect(budget.failed).toBe(true);
    expect(w.bytesWritten).toBe(0);
    await w.close();
  });

  it('handle.close 抛错 → 固定 CLEANUP_FAILED + budget failed；重复 close 幂等', async () => {
    const { real } = await makeTempFile();
    const budget = new StagingBudget();
    const probe = wrapHandle(real, {
      close: async () => {
        throw new Error('close-canary-secret');
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    await w.write(encoder.encode('x'));
    const err = await errorOf(w.close());
    expectFixed(err, STAGING_ERROR_CODES.CLEANUP_FAILED);
    expect(budget.failed).toBe(true);
    const again = await errorOf(w.close());
    expectFixed(again, STAGING_ERROR_CODES.CLEANUP_FAILED);
  });

  it('共享 budget 的任一 writer IO 故障 sticky 后，其他 writer 写入被拒', async () => {
    const f1 = await makeTempFile();
    const f2 = await makeTempFile();
    const budget = new StagingBudget();
    const bad = wrapHandle(f1.real, {
      write: async () => ({ bytesWritten: 0, buffer: new Uint8Array(0) }),
    });
    const w1 = new BoundedStagingWriter(bad, 'projection', budget);
    const w2 = new BoundedStagingWriter(f2.real, 'projection', budget);
    await expect(w1.write(encoder.encode('x'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.IO_FAILED,
    });
    await expect(w2.write(encoder.encode('y'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.INVALID_STATE,
    });
    expect((await stat(f2.path)).size).toBe(0);
    await w1.close();
    await w2.close();
  });
});

describe('延迟 stat/write：跨 writer 并发、close 等待与缓冲区复用', () => {
  function deferred(): { gate: Promise<void>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  }

  it('写盘挂起时，共享 budget 的另一 writer 并发写 → WRITE_BUSY（不排队）', async () => {
    const f1 = await makeTempFile();
    const f2 = await makeTempFile();
    const budget = new StagingBudget();
    const { gate, release } = deferred();
    const probe = wrapHandle(f1.real, {
      write: async (buffer, offset, length, position) => {
        await gate;
        return f1.real.write(buffer, offset, length, position);
      },
    });
    const w1 = new BoundedStagingWriter(probe, 'projection', budget);
    const w2 = new BoundedStagingWriter(f2.real, 'projection', budget);
    const first = w1.write(encoder.encode('aaaaa'));
    const err = await errorOf(w2.write(encoder.encode('bbbbb')));
    expectFixed(err, STAGING_ERROR_CODES.WRITE_BUSY);
    release();
    await first;
    expect((await stat(f1.path)).size).toBe(5);
    await w1.close();
    await w2.write(encoder.encode('ok')); // w1 结算后 w2 可正常写入
    await w2.close();
  });

  it('stat 挂起期间，共享 budget 的并发写同样被 WRITE_BUSY 拒绝', async () => {
    const f1 = await makeTempFile();
    const f2 = await makeTempFile();
    const budget = new StagingBudget();
    const { gate, release } = deferred();
    const probe = wrapHandle(f1.real, {
      stat: async () => {
        await gate;
        return f1.real.stat();
      },
    });
    const w1 = new BoundedStagingWriter(probe, 'projection', budget);
    const w2 = new BoundedStagingWriter(f2.real, 'projection', budget);
    const first = w1.write(encoder.encode('aaaaa'));
    const err = await errorOf(w2.write(encoder.encode('bbbbb')));
    expectFixed(err, STAGING_ERROR_CODES.WRITE_BUSY);
    release();
    await first;
    await w1.close();
    await w2.close();
  });

  it('close 等待在途写入结算后才关闭底层句柄', async () => {
    const { real } = await makeTempFile();
    const budget = new StagingBudget();
    let closeCalls = 0;
    const { gate, release } = deferred();
    const probe = wrapHandle(real, {
      write: async (buffer, offset, length, position) => {
        await gate;
        return real.write(buffer, offset, length, position);
      },
      close: async () => {
        closeCalls += 1;
        return real.close();
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    const pendingWrite = w.write(encoder.encode('pending'));
    const pendingClose = w.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeCalls).toBe(0); // 在途写入未结算前不关闭句柄
    release();
    await pendingWrite;
    await pendingClose;
    expect(closeCalls).toBe(1);
    await expect(w.write(encoder.encode('x'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.INVALID_STATE,
    });
  });

  it('调用方在写盘前改写原 buffer 不影响已写入内容（稳定副本）', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const { gate, release } = deferred();
    const probe = wrapHandle(real, {
      write: async (buffer, offset, length, position) => {
        await gate;
        return real.write(buffer, offset, length, position);
      },
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    const data = patternChunk(6, 0x41); // 'AAAAAA'
    const pendingWrite = w.write(data);
    data.fill(0x5a); // 'ZZZZZZ'：写盘前改写原 buffer
    release();
    await pendingWrite;
    await w.close();
    const content = await readFile(path);
    expect(content.equals(Buffer.from([0x41, 0x41, 0x41, 0x41, 0x41, 0x41]))).toBe(true);
  });
});

describe('构造校验与状态拒绝', () => {
  it('StagingBudget 非法 initialBytes → INVALID_CONFIG；边界值合法', () => {
    for (const bad of [-1, 1.5, NaN, STAGING_TOTAL_LIMIT_BYTES + 1]) {
      expect(() => new StagingBudget(bad)).toThrowError(STAGING_ERROR_CODES.INVALID_CONFIG);
    }
    expect(new StagingBudget(0).usedBytes).toBe(0);
    expect(new StagingBudget(STAGING_TOTAL_LIMIT_BYTES).usedBytes).toBe(STAGING_TOTAL_LIMIT_BYTES);
    expect(new StagingBudget(7).usedBytes).toBe(7);
  });

  it('writer 构造：null/undefined/缺方法 handle、非法 kind、非 StagingBudget → INVALID_CONFIG', () => {
    const budget = new StagingBudget();
    expect(() => new BoundedStagingWriter(null as unknown as FileHandle, 'manifest', budget)).toThrowError(
      STAGING_ERROR_CODES.INVALID_CONFIG,
    );
    expect(() => new BoundedStagingWriter(undefined as unknown as FileHandle, 'manifest', budget)).toThrowError(
      STAGING_ERROR_CODES.INVALID_CONFIG,
    );
    const fake = {
      write: async () => ({ bytesWritten: 0, buffer: new Uint8Array(0) }),
      stat: async () => ({ isFile: () => true, nlink: 1, size: 0 }),
      close: async () => undefined,
    } as unknown as FileHandle;
    expect(() => new BoundedStagingWriter(fake, 'manifest', {} as StagingBudget)).toThrowError(
      STAGING_ERROR_CODES.INVALID_CONFIG,
    );
    expect(() => new BoundedStagingWriter(fake, 'upload' as unknown as StagingFileKind, budget)).toThrowError(
      STAGING_ERROR_CODES.INVALID_CONFIG,
    );
    expect(() => new BoundedStagingWriter({} as FileHandle, 'manifest', budget)).toThrowError(
      STAGING_ERROR_CODES.INVALID_CONFIG,
    );
    expect(() => new BoundedStagingWriter(fake, 'manifest', new StagingBudget(0))).not.toThrow();
  });

  it('非 Uint8Array chunk → INVALID_STATE（不触碰文件，不污染 budget）', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    const err = await errorOf(w.write('not-bytes' as unknown as Uint8Array));
    expectFixed(err, STAGING_ERROR_CODES.INVALID_STATE);
    expect(budget.failed).toBe(false);
    expect((await stat(path)).size).toBe(0);
    await w.close();
  });

  it('空 chunk 是合法 no-op：不写盘、不记账', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    await w.write(new Uint8Array(0));
    expect(w.bytesWritten).toBe(0);
    expect(budget.usedBytes).toBe(0);
    expect((await stat(path)).size).toBe(0);
    await w.write(new Uint8Array(0)); // 可重复
    await w.close();
  });

  it('close 后 write 拒绝（INVALID_STATE）；重复 close 幂等', async () => {
    const { real } = await makeTempFile();
    const budget = new StagingBudget();
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    await w.write(encoder.encode('ab'));
    await w.close();
    await w.close(); // 幂等
    await expect(w.write(encoder.encode('c'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.INVALID_STATE,
    });
  });
});

describe('受控新文件守卫：写前拒绝', () => {
  it('fstat 非常规文件 → IO_FAILED + sticky，写前拒绝', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const probe = wrapHandle(real, {
      stat: async () => ({ isFile: () => false, nlink: 1, size: 0 }),
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    await expect(w.write(patternChunk(4))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.IO_FAILED,
    });
    expect(budget.failed).toBe(true);
    expect((await stat(path)).size).toBe(0);
    await w.close();
  });

  it('fstat nlink !== 1 → IO_FAILED + sticky，写前拒绝', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    const probe = wrapHandle(real, {
      stat: async () => ({ isFile: () => true, nlink: 2, size: 0 }),
    });
    const w = new BoundedStagingWriter(probe, 'manifest', budget);
    await expect(w.write(patternChunk(4))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.IO_FAILED,
    });
    expect(budget.failed).toBe(true);
    expect((await stat(path)).size).toBe(0);
    await w.close();
  });

  it('文件已有外部字节（size !== bytesWritten）→ 写前拒绝，原内容不被覆盖', async () => {
    const { path, real } = await makeTempFile();
    const budget = new StagingBudget();
    await real.writeFile(Buffer.from('hello'));
    const w = new BoundedStagingWriter(real, 'manifest', budget);
    await expect(w.write(encoder.encode('x'))).rejects.toMatchObject({
      code: STAGING_ERROR_CODES.IO_FAILED,
    });
    expect(budget.failed).toBe(true);
    expect((await stat(path)).size).toBe(5);
    const content = await readFile(path);
    expect(content.equals(Buffer.from('hello'))).toBe(true);
    await w.close();
  });
});
