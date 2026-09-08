import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 移动只读发布配置文件系统适配（design D4/D6）。
 *
 * - 默认实现为真实磁盘（原子写：同目录临时文件 + rename，避免半写状态）；
 * - 测试可注入受控 stub 模拟缺失/读取失败/写入失败/损坏等场景；
 * - 本模块只做本地文件 IO，不含任何网络能力。
 */

export interface MobileReadonlyReadTextResult {
  ok: boolean;
  text?: string;
  code?: 'missing' | 'read_error';
}

export interface MobileReadonlyWriteResult {
  ok: boolean;
  code?: 'write_error';
}

export interface MobileReadonlyReadBinaryResult {
  ok: boolean;
  data?: Uint8Array;
  code?: 'missing' | 'read_error';
}

export interface MobileReadonlyFileIo {
  readText(path: string): MobileReadonlyReadTextResult;
  writeTextAtomic(path: string, text: string): MobileReadonlyWriteResult;
  readBinary(path: string): MobileReadonlyReadBinaryResult;
  writeBinaryAtomic(path: string, data: Uint8Array): MobileReadonlyWriteResult;
  remove(path: string): void;
  exists(path: string): boolean;
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** 真实磁盘默认实现：原子写 = 同目录临时文件 → rename 覆盖。 */
export const realMobileReadonlyFileIo: MobileReadonlyFileIo = {
  readText(path) {
    try {
      return { ok: true, text: readFileSync(path, 'utf8') };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return { ok: false, code: err?.code === 'ENOENT' ? 'missing' : 'read_error' };
    }
  },
  writeTextAtomic(path, text) {
    return atomicWrite(path, (tmp) => writeFileSync(tmp, text, 'utf8'));
  },
  readBinary(path) {
    try {
      return { ok: true, data: readFileSync(path) };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return { ok: false, code: err?.code === 'ENOENT' ? 'missing' : 'read_error' };
    }
  },
  writeBinaryAtomic(path, data) {
    return atomicWrite(path, (tmp) => writeFileSync(tmp, data));
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // 尽力清理，失败不影响已落盘目标文件
    }
  },
  exists(path) {
    return existsSync(path);
  },
};

/** 原子写：写入同目录临时文件后 rename 覆盖目标；任何失败清理临时文件并返回失败。 */
function atomicWrite(path: string, writeTemp: (tmpPath: string) => void): MobileReadonlyWriteResult {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    ensureParentDir(path);
    writeTemp(tmp);
    renameSync(tmp, path);
    return { ok: true };
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 清理失败不影响结论
    }
    return { ok: false, code: 'write_error' };
  }
}
