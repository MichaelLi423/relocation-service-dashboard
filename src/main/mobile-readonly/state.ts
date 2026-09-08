import { join } from 'node:path';
import type { MobileReadonlyFingerprint } from '../../shared/mobile-readonly';
import type { MobileReadonlyFileIo } from './fs-io';

/**
 * 桌面发布「结果状态」持久化（design D4）。
 *
 * - 独立于 config（enabled/target/token）的文件 `mobile-readonly-results.json`；
 * - 只持久化最近成功（lastSuccessfulFingerprint + 最近成功时间）与最近失败规范化错误码，
 *   **绝不持久化整份待上传候选/快照**；上传凭证永不进入本文件；
 * - **结果绑定发布目标**：文件记录 `target`（规范化 HTTPS origin）。启动恢复时仅当落盘 `target`
 *   与当前配置目标完全一致才恢复基线/时间/错误；缺失 target 的旧格式或目标不匹配一律按空态
 *   处理（保守重发）。配置目标更换后内存结果立即清空并绑定新目标；
 * - 结果文件损坏/不可读/旧格式 → 内存空态继续（结果状态只是旁路信息）；
 *   结果文件不可写 → 内存继续维护并如实报告（state_unwritable），不阻断发布调度。
 */

export const MOBILE_READONLY_RESULTS_VERSION = 1 as const;

export interface MobileReadonlyResultsData {
  version: typeof MOBILE_READONLY_RESULTS_VERSION;
  /** 结果所属发布目标（规范化 HTTPS origin）；null=未绑定（旧格式/从未落盘）。 */
  target: string | null;
  /** 最近成功发布候选捕获时的指纹（仅相等比较；非「上传完成时最新修订」）。 */
  lastSuccessfulFingerprint: MobileReadonlyFingerprint | null;
  lastSuccessfulAt: string | null;
  lastFailedCode: string | null;
  lastFailedAt: string | null;
}

export const EMPTY_MOBILE_READONLY_RESULTS: MobileReadonlyResultsData = Object.freeze({
  version: MOBILE_READONLY_RESULTS_VERSION,
  target: null,
  lastSuccessfulFingerprint: null,
  lastSuccessfulAt: null,
  lastFailedCode: null,
  lastFailedAt: null,
});

export interface MobileReadonlyResultsStoreOptions {
  io: MobileReadonlyFileIo;
  storageDir: string;
}

export interface MobileReadonlyResultsStore {
  readonly resultsFilePath: string;
  /** 启动/读取恢复；损坏/不可读按空态处理并如实标记（不视为配置损坏）。 */
  load(): { data: MobileReadonlyResultsData; unreadable: boolean };
  /** 保存：失败返回 ok:false（调用方内存降级 + state_unwritable 提示）。 */
  save(data: MobileReadonlyResultsData): { ok: boolean };
}

export function createMobileReadonlyResultsStore(options: MobileReadonlyResultsStoreOptions): MobileReadonlyResultsStore {
  const resultsFilePath = join(options.storageDir, 'mobile-readonly-results.json');
  const { io } = options;

  return {
    resultsFilePath,
    load() {
      const raw = io.readText(resultsFilePath);
      if (!raw.ok) {
        return { data: { ...EMPTY_MOBILE_READONLY_RESULTS }, unreadable: raw.code === 'read_error' };
      }
      try {
        const parsed: unknown = JSON.parse(raw.text ?? '');
        const data = parseResults(parsed);
        return { data, unreadable: false };
      } catch {
        return { data: { ...EMPTY_MOBILE_READONLY_RESULTS }, unreadable: true };
      }
    },
    save(data) {
      const text = `${JSON.stringify(data, null, 2)}\n`;
      const result = io.writeTextAtomic(resultsFilePath, text);
      return result.ok ? { ok: true } : { ok: false };
    },
  };
}

function parseResults(value: unknown): MobileReadonlyResultsData {
  if (typeof value !== 'object' || value === null) {
    throw new Error('结果状态非对象');
  }
  const candidate = value as {
    version?: unknown;
    target?: unknown;
    lastSuccessfulFingerprint?: unknown;
    lastSuccessfulAt?: unknown;
    lastFailedCode?: unknown;
    lastFailedAt?: unknown;
  };
  if (candidate.version !== MOBILE_READONLY_RESULTS_VERSION) {
    throw new Error('结果状态版本不支持');
  }
  // 旧格式（无 target 绑定）不可信：按损坏处理，仅以空态恢复（保守重发）。
  if (!('target' in candidate)) {
    throw new Error('结果状态缺少目标绑定（旧格式），按空态恢复');
  }
  const target = candidate.target;
  if (target !== null && (typeof target !== 'string' || target === '')) {
    throw new Error('结果状态目标绑定非法');
  }
  const fp = candidate.lastSuccessfulFingerprint;
  const fingerprint =
    fp === null || fp === undefined
      ? null
      : isFingerprint(fp)
        ? { contentGenerationId: fp.contentGenerationId, businessRevision: fp.businessRevision }
        : null;
  return {
    version: MOBILE_READONLY_RESULTS_VERSION,
    target,
    lastSuccessfulFingerprint: fingerprint,
    lastSuccessfulAt: nullableString(candidate.lastSuccessfulAt),
    lastFailedCode: nullableString(candidate.lastFailedCode),
    lastFailedAt: nullableString(candidate.lastFailedAt),
  };
}

function isFingerprint(value: unknown): value is { contentGenerationId: string; businessRevision: number } {
  if (typeof value !== 'object' || value === null) return false;
  const fp = value as { contentGenerationId?: unknown; businessRevision?: unknown };
  return (
    typeof fp.contentGenerationId === 'string' &&
    typeof fp.businessRevision === 'number' &&
    Number.isInteger(fp.businessRevision)
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
