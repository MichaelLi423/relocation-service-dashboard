import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../domain/core/time';
import { SystemClock } from '../../domain/core/time';
import type {
  MobileReadonlyFingerprint,
  MobileReadonlyPublishMetadata,
  MobileReadonlySnapshot,
  MobileReadonlyUploadBody,
} from '../../shared/mobile-readonly';
import type {
  MobileReadonlyConfigureInput,
  MobileReadonlyStatusDto,
} from '../../shared/ipc';
import {
  buildMobileReadonlySnapshot,
} from './snapshot';
import {
  createMobileReadonlyConfigStore,
  validateMobileReadonlyConfigureInput,
  type MobileReadonlyConfigStore,
} from './config';
import {
  MobileReadonlyPublishError,
  MOBILE_READONLY_LOCAL_CODES,
  MOBILE_READONLY_REMOTE_CODES,
} from './errors';
import { readCurrentMobileReadonlyFingerprint, sameMobileReadonlyFingerprint } from './fingerprint';
import { realMobileReadonlyFileIo, type MobileReadonlyFileIo } from './fs-io';
import type { MobileReadonlyRemoteFactory } from './remote';
import { checkSafeStorage, type MobileReadonlySafeStorage } from './safe-storage';
import {
  createMobileReadonlyResultsStore,
  EMPTY_MOBILE_READONLY_RESULTS,
  type MobileReadonlyResultsData,
  type MobileReadonlyResultsStore,
} from './state';

/**
 * 桌面移动只读发布运行时（design D1-D5 / tasks 3.3-4.8、5.1）。
 *
 * - 配置（enabled/target）与 token 密文、结果状态分开文件、原子写入；
 *   token 经 safeStorage 加密，Linux basic_text/unknown 拒绝，绝不明文降级；
 * - 启动检查一次 + 运行联网约每 periodicIntervalMs（默认 120_000ms≈2 分钟）周期检查；
 *   单候选 single-flight（同一时刻至多一个发布周期），新变化归下一周期；
 * - 变化检测：本地指纹 vs 持久化 lastSuccessfulFingerprint（候选捕获时指纹）；
 *   上传成功才保存指纹，绝不在上传完成后重读"最新修订"；
 * - 结果状态**绑定发布目标**（results 内 `target`）：仅当落盘结果 target 与当前配置目标一致
 *   才恢复基线/时间/错误；目标更换（含落盘失败窗口）后重启按空态保守重发；
 * - 「恢复确认」只在 本地绑定基线+远端同指纹一致 或 候选成功/幂等 后建立：单纯元数据读取成功
 *   不算确认，捕获失败后下一周期仍会重试（远端丢文件也不会被永久短路跳过）；
 * - 上传失败/冲突先读元数据三分支恢复；每 tick 重试有界、无死循环；
 * - 结果状态文件不可写 → 内存续跑并提示（state_unwritable）；
 *   配置损坏/凭证不可用 → 禁用外发（fail-closed）。
 *
 * 本模块是 headless 可测核心：network 经 remoteFactory 注入，
 * 文件 IO 经 io 注入，时钟经 clock，定时经 timer，safeStorage 经 adapter。
 */

export interface MobileReadonlyTimerHandle {
  cancel(): void;
}

export interface MobileReadonlyTimer {
  schedule(callback: () => void, delayMs: number): MobileReadonlyTimerHandle;
}

/** 真实 setTimeout/clearTimeout 定时器（仅由主进程接线使用；测试注入可控假定时器）。 */
export const systemMobileReadonlyTimer: MobileReadonlyTimer = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
};

export const MOBILE_READONLY_PERIODIC_INTERVAL_MS = 120_000;
export const MOBILE_READONLY_MAX_ATTEMPTS_PER_TICK = 4;

interface MobileReadonlyCandidate {
  publicationId: string;
  expectedCurrentVersion: number;
  snapshot: MobileReadonlySnapshot;
  /** 捕获候选时的指纹（保存成功指纹时只使用此值，不读上传后的最新修订）。 */
  fingerprint: MobileReadonlyFingerprint;
  capturedAt: string;
}

export interface MobileReadonlyRuntimeOptions {
  /** 配置/token/结果状态文件目录。 */
  storageDir: string;
  /** 当前 live SQLite 句柄提供者（每次捕获/读指纹重新解析，恢复换库不持有陈旧句柄）。 */
  db: () => DatabaseSync;
  clock: Clock;
  timer: MobileReadonlyTimer;
  safeStorage: MobileReadonlySafeStorage;
  /** 文件 IO（默认真实磁盘；测试可注入失败/内存 stub）。 */
  io?: MobileReadonlyFileIo;
  /** 远程客户端工厂（上传/元数据均只走此工厂返回的 remote）。 */
  remoteFactory: MobileReadonlyRemoteFactory;
  /** 周期检查间隔（默认 MOBILE_READONLY_PERIODIC_INTERVAL_MS）。 */
  periodicIntervalMs?: number;
  /** 每 tick 三分支重试上限（默认 MOBILE_READONLY_MAX_ATTEMPTS_PER_TICK）。 */
  maxAttemptsPerTick?: number;
  /** 可选指纹读取覆盖（默认读 database_metadata identity）。 */
  readFingerprint?: () => MobileReadonlyFingerprint;
  /** 可选快照构建覆盖（默认 buildMobileReadonlySnapshot(db(), clock)）。 */
  buildSnapshot?: () => MobileReadonlySnapshot;
  /** 发布成功后的通知（供接线层展示；不得包含 secret/业务内容）。 */
  onWarning?: (warning: string) => void;
}

export interface MobileReadonlyPublishRuntime {
  start(): void;
  stop(): void;
  /** 立即执行一次发布周期（供定时器/测试调用；幂等单飞）。 */
  checkNow(): Promise<void>;
  /** 一次性受信配置（HTTPS origin + 上传 token；保存后不回显 secret）。 */
  configure(input: MobileReadonlyConfigureInput): Promise<MobileReadonlyStatusDto>;
  setEnabled(enabled: boolean): Promise<MobileReadonlyStatusDto>;
  /** 只读状态（不含任何 secret）。 */
  getStatus(): MobileReadonlyStatusDto;
}

export function createMobileReadonlyPublishRuntime(
  options: MobileReadonlyRuntimeOptions,
): MobileReadonlyPublishRuntime {
  const io: MobileReadonlyFileIo = options.io ?? realMobileReadonlyFileIo;
  const clock: Clock = options.clock ?? new SystemClock();
  const periodicIntervalMs = options.periodicIntervalMs ?? MOBILE_READONLY_PERIODIC_INTERVAL_MS;
  const maxAttemptsPerTick = options.maxAttemptsPerTick ?? MOBILE_READONLY_MAX_ATTEMPTS_PER_TICK;

  const config: MobileReadonlyConfigStore = createMobileReadonlyConfigStore({
    io,
    storageDir: options.storageDir,
    safeStorage: options.safeStorage,
  });
  const resultsStore: MobileReadonlyResultsStore = createMobileReadonlyResultsStore({
    io,
    storageDir: options.storageDir,
  });

  const readFingerprint = options.readFingerprint ?? (() => readCurrentMobileReadonlyFingerprint(options.db()));
  const buildSnapshot = options.buildSnapshot ?? (() => buildMobileReadonlySnapshot({ db: options.db(), clock }));

  /** 结果状态只对「当前配置目标」可信：仅当配置非损坏且落盘结果绑定同一规范化 origin 时才恢复。 */
  const initialConfigView = config.load();
  const initialResults = resultsStore.load();
  const resultsBoundToConfig =
    !initialConfigView.corrupt &&
    initialConfigView.data.target !== null &&
    initialResults.data.target === initialConfigView.data.target;
  let memoryResults: MobileReadonlyResultsData = resultsBoundToConfig
    ? { ...EMPTY_MOBILE_READONLY_RESULTS, ...initialResults.data }
    : { ...EMPTY_MOBILE_READONLY_RESULTS };
  let resultsPersistFailed = false;

  let pending: MobileReadonlyCandidate | null = null;
  let stopped = false;
  let started = false;
  let timerHandle: MobileReadonlyTimerHandle | null = null;
  let chain: Promise<void> = Promise.resolve();
  /** 授权代际：configure/setEnabled 每次使授权工作集变化（目标/token/启停）即递增；
   *  在途周期在每次 await 后校验代际，代际不符立即中止，不再发起新请求/重试/写入旧结果。 */
  let authorizationGeneration = 0;
  /**
   * 「恢复已确认」：只有本地绑定基线+远端发布同指纹达成一致，或当前捕获候选已成功/幂等后才为 true。
   * 单纯元数据读取成功（HTTP 200 但远端未发布/同版本待重传）不算确认——否则捕获失败一次后
   * 本地旧指纹不变会让下一周期被短路跳过、永不补发（例如远端丢文件）。启动/重启首次周期
   * 即使本地指纹与持久化一致也先读元数据确认。
   */
  let recoveryConfirmed = false;

  function recordAccepted(fingerprint: MobileReadonlyFingerprint): void {
    recoveryConfirmed = true;
    memoryResults = {
      ...memoryResults,
      lastSuccessfulFingerprint: fingerprint,
      lastSuccessfulAt: clock.nowIso(),
      lastFailedCode: null,
      lastFailedAt: null,
    };
    persistResults();
  }

  function recordFailure(code: string): void {
    memoryResults = {
      ...memoryResults,
      lastFailedCode: code,
      lastFailedAt: clock.nowIso(),
    };
    persistResults();
  }

  /** 结果文件始终绑定当前配置 target（persist 前读取，configure 已先落盘新目标）。 */
  function currentBindingTarget(): string | null {
    const view = config.load();
    return view.corrupt ? null : view.data.target;
  }

  function persistResults(): void {
    const boundTarget = currentBindingTarget();
    memoryResults = { ...memoryResults, target: boundTarget };
    const result = resultsStore.save(memoryResults);
    resultsPersistFailed = !result.ok;
    if (resultsPersistFailed) {
      try {
        options.onWarning?.('MOBILE_READONLY_STATE_UNWRITABLE');
      } catch {
        // 通知回调失败（如不可写的外部提示通道）不影响业务状态与周期调度。
      }
    }
  }

  function captureCandidate(expectedCurrentVersion: number): MobileReadonlyCandidate {
    let snapshot: MobileReadonlySnapshot;
    try {
      snapshot = buildSnapshot();
    } catch (error) {
      throw new MobileReadonlyPublishError(
        MOBILE_READONLY_LOCAL_CODES.LOCAL_SNAPSHOT_FAILED,
        `本地一致快照生成失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      publicationId: randomUUID(),
      expectedCurrentVersion,
      snapshot,
      fingerprint: {
        contentGenerationId: snapshot.contentGenerationId,
        businessRevision: snapshot.businessRevision,
      },
      capturedAt: clock.nowIso(),
    };
  }

  function uploadBody(candidate: MobileReadonlyCandidate): MobileReadonlyUploadBody {
    return {
      protocol: {
        publicationId: candidate.publicationId,
        expectedCurrentVersion: candidate.expectedCurrentVersion,
      },
      snapshot: candidate.snapshot,
    };
  }

  /** 当前授权/配置/凭证综合视图（status 与调度共用同一事实来源）。 */
  function authorizationState(): {
    corrupt: boolean;
    configured: boolean;
    enabled: boolean;
    target: string | null;
    /** 已解密且非空的可用上传 token；不可用/缺失/解密失败/为空均为 null。 */
    token: string | null;
    issue: MobileReadonlyStatusDto['issue'] | null;
  } {
    const view = config.load();
    const storage = checkSafeStorage(options.safeStorage);
    if (view.corrupt) {
      return { corrupt: true, configured: false, enabled: false, target: null, token: null, issue: 'config_corrupt' };
    }
    const targetConfigured = view.data.target !== null;
    const tokenPresent = config.isTokenPresent();
    const partlyConfigured = targetConfigured || tokenPresent;

    let issue: MobileReadonlyStatusDto['issue'] | null = resultsPersistFailed ? 'state_unwritable' : null;
    if (!storage.available && partlyConfigured) issue = issue ?? 'credential_unavailable';

    // 必须真实解密并校验非空，才能算"凭证可用"（token 文件存在但解密失败/为空 → 不可用）。
    let token: string | null = null;
    if (storage.available && targetConfigured && tokenPresent) {
      const read = config.readToken();
      if (read.ok && read.token !== '') token = read.token;
    }
    // 目标已配但凭证缺失/不可用 → 视为凭证不可用（配置不完整即禁用外发）。
    if (targetConfigured && token === null) issue = issue ?? 'credential_unavailable';

    const configured = targetConfigured && token !== null;
    const enabled = !view.corrupt && view.data.enabled && configured && storage.available;
    return { corrupt: false, configured, enabled, target: view.data.target, token, issue };
  }

  /** 启用被拒时的稳定错误（code/文案不得含 secret；与配置校验同一事实来源）。 */
  function enableFailureError(): MobileReadonlyPublishError | null {
    const view = config.load();
    if (view.corrupt) {
      return new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.CONFIG_CORRUPT, '发布配置损坏，拒绝启用（fail-closed）');
    }
    const storage = checkSafeStorage(options.safeStorage);
    if (!storage.available) {
      return new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.SAFE_STORAGE_UNAVAILABLE, 'OS 安全存储不可用，拒绝启用发布');
    }
    if (view.data.target === null || !config.isTokenPresent()) {
      return new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.NOT_CONFIGURED, '尚未完成一次性配置，无法启用发布');
    }
    const tokenRead = config.readToken();
    if (!tokenRead.ok || tokenRead.token === '') {
      return new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.CREDENTIAL_UNAVAILABLE, '上传凭证不可用，拒绝启用发布');
    }
    return null;
  }

  /** 每次网络 await 之后：代际未变、未停止、且当前授权仍有效（enabled 且 token 可用）才继续。 */
  function isAuthorizationCurrent(generation: number): boolean {
    if (stopped) return false;
    if (authorizationGeneration !== generation) return false;
    return authorizationState().enabled;
  }

  function buildStatus(): MobileReadonlyStatusDto {
    const auth = authorizationState();
    return {
      configured: auth.configured,
      enabled: auth.enabled,
      target: auth.target,
      lastSuccessfulAt: memoryResults.lastSuccessfulAt,
      lastFailedCode: memoryResults.lastFailedCode,
      lastFailedAt: memoryResults.lastFailedAt,
      issue: auth.issue,
    };
  }

  async function performCycle(): Promise<void> {
    if (stopped) return;

    const auth = authorizationState();
    if (!auth.enabled) return;
    const generation = authorizationGeneration;

    try {
      // 不做 OS 在线预检：直接发起实际请求，以真实 HTTPS 结果为准（联网判断由请求本身决定）。
      const remote = options.remoteFactory({ target: auth.target as string, token: auth.token as string });

      let currentFingerprint: MobileReadonlyFingerprint;
      try {
        currentFingerprint = readFingerprint();
      } catch {
        // 本地指纹读取失败：不读元数据/不上传/不推进成功指纹；授权仍当前时如实记录，
        // 不持久化原始异常（message/业务内容/路径），下一周期可恢复。
        if (isAuthorizationCurrent(generation)) {
          recordFailure(MOBILE_READONLY_LOCAL_CODES.LOCAL_SNAPSHOT_FAILED);
        }
        return;
      }

      const baselineMatches =
        pending === null &&
        sameMobileReadonlyFingerprint(memoryResults.lastSuccessfulFingerprint, currentFingerprint);

      // 无在途候选、本地基线一致且本实例已「恢复确认」→ 周期无变化，不打扰远端
      // （如实保留最近发布状态；确认只由 基线+远端同指纹一致 或 候选成功/幂等 建立）。
      if (recoveryConfirmed && baselineMatches) {
        return;
      }

      // 启动/重启/恢复一律先读非业务版本元数据（三分支恢复的前提）；即使持久化指纹与当前一致，
      // 也要确认远端仍发布了同一指纹（远端丢文件/清空必须保守重发，含空集合）。
      // 注意：元数据读取成功本身不构成确认（远端可能尚未发布/同版本待重传）。
      const metaResult = await remote.readMeta();
      if (!isAuthorizationCurrent(generation)) return;
      if (!metaResult.ok) {
        recordFailure(MOBILE_READONLY_REMOTE_CODES.META_READ_FAILED);
        return; // 保留 pending/未确认，下一周期再试，不推进成功指纹
      }
      const metadata = metaResult.metadata;

      // 本地基线==当前指纹 且 远端仍发布同一指纹 → 一致：无需上传，也不改写最近成功状态。
      if (baselineMatches && metadata.published && sameMobileReadonlyFingerprint(metadata.fingerprint, currentFingerprint)) {
        recoveryConfirmed = true;
        return;
      }
      // 其余情形（远端尚未发布/远端丢数据/本地持久化基线缺失或不同）→ 保守捕获当前快照并发布。
      // 绝不因「远端刚好同指纹」就在没有本地持久化成功/在途候选时凭空确认成功。

      let candidate = pending;
      if (candidate === null) {
        if (!isAuthorizationCurrent(generation)) return;
        candidate = tryCapture(metadata.currentVersion);
        if (candidate === null) return;
      }
      // 进入上传前即持有候选：即使 remote.upload 意外 reject，也保留下轮以同一 publicationId/
      // 内容/expectedCurrentVersion 读取元数据幂等恢复，不生成第三候选。
      pending = candidate;
      let attempts = 0;
      while (attempts < maxAttemptsPerTick) {
        attempts += 1;
        const outcome = await remote.upload(uploadBody(candidate));
        if (!isAuthorizationCurrent(generation)) return;

        if (outcome.kind === 'accepted') {
          pending = null;
          recordAccepted(candidate.fingerprint);
          return;
        }
        if (outcome.kind === 'rejected') {
          pending = candidate;
          recordFailure(outcome.code);
          return;
        }

        // transport（结果不确定）先读元数据；conflict 已携带元数据。
        let reconcile: MobileReadonlyPublishMetadata;
        if (outcome.kind === 'conflict') {
          reconcile = outcome.metadata;
        } else {
          const meta2 = await remote.readMeta();
          if (!isAuthorizationCurrent(generation)) return;
          if (!meta2.ok) {
            pending = candidate;
            recordFailure(meta2.code);
            return;
          }
          reconcile = meta2.metadata;
        }

        // 三分支：
        if (reconcile.publicationId === candidate.publicationId) {
          // (1) 已被接受：确认成功并保存候选捕获时指纹。
          pending = null;
          recordAccepted(candidate.fingerprint);
          return;
        }
        if (reconcile.currentVersion === candidate.expectedCurrentVersion) {
          // (2) 版本未前进 → 原样重传同一候选（publicationId/内容/expectedCurrentVersion 不变）。
          continue;
        }
        // (3) 版本前进且 publicationId 不同 → 冲突：重新捕获候选、以元数据当前版本为新 expected。
        if (!isAuthorizationCurrent(generation)) return;
        const fresh = tryCapture(reconcile.currentVersion);
        if (fresh === null) return;
        candidate = fresh;
        pending = candidate;
      }
      if (!isAuthorizationCurrent(generation)) return;
      // 单 tick 内达到有界重试上限：保留候选（未确认），下周期再试，不产生死循环。
      pending = candidate;
      recordFailure(MOBILE_READONLY_REMOTE_CODES.RETRY_LIMIT);
    } catch {
      // 未分类异常（remoteFactory/上传/元数据等意外 reject）：仅在授权代际仍当前（未停止/未停用/
      // 目标与 token 未变）时记录固定本地兜底码，不保存原始 message/error.code/业务内容；
      // 保留 pending 候选供下周期按 meta 幂等恢复，旧授权异常绝不污染新配置状态。
      if (isAuthorizationCurrent(generation)) {
        recordFailure(MOBILE_READONLY_LOCAL_CODES.LOCAL_PUBLICATION_FAILED);
      }
    }
  }

  /** 捕获候选失败（本地读取问题）→ 记录失败并返回 null（不外发任何内容）。 */
  function tryCapture(expectedCurrentVersion: number): MobileReadonlyCandidate | null {
    try {
      return captureCandidate(expectedCurrentVersion);
    } catch (error) {
      recordFailure(
        error instanceof MobileReadonlyPublishError ? error.code : MOBILE_READONLY_LOCAL_CODES.LOCAL_SNAPSHOT_FAILED,
      );
      return null;
    }
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timerHandle = options.timer.schedule(() => {
      timerHandle = null;
      if (stopped) return;
      void runCycle();
    }, delayMs);
  }

  async function runCycle(): Promise<void> {
    try {
      await runtime.checkNow();
    } catch {
      // 单次周期异常不属业务结果；不阻断后续周期调度，也不产生未处理拒绝。
    } finally {
      if (!stopped) scheduleNext(periodicIntervalMs);
    }
  }

  const runtime: MobileReadonlyPublishRuntime = {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      scheduleNext(0);
    },
    stop() {
      stopped = true;
      timerHandle?.cancel();
      timerHandle = null;
    },
    async checkNow(): Promise<void> {
      if (stopped) return;
      const run = chain.then(() => performCycle());
      chain = run.catch(() => {
        // 周期链不因单次异常中断
      });
      await run;
    },
    async configure(input: MobileReadonlyConfigureInput): Promise<MobileReadonlyStatusDto> {
      const validation = validateMobileReadonlyConfigureInput(input);
      if (!validation.ok) {
        throw new MobileReadonlyPublishError(
          validation.code === 'empty_token' ? MOBILE_READONLY_LOCAL_CODES.EMPTY_TOKEN : MOBILE_READONLY_LOCAL_CODES.INVALID_TARGET,
          validation.code === 'empty_token' ? '上传 token 不能为空' : '目标必须为固定 HTTPS origin（无凭据/query/hash/路径）',
        );
      }
      const current = config.load();
      if (current.corrupt) {
        throw new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.CONFIG_CORRUPT, '发布配置损坏，拒绝写入（fail-closed）');
      }
      const stored = config.storeToken(input.token);
      if (!stored.ok) {
        throw new MobileReadonlyPublishError(
          stored.code === 'safe_storage_unavailable' ? MOBILE_READONLY_LOCAL_CODES.SAFE_STORAGE_UNAVAILABLE : MOBILE_READONLY_LOCAL_CODES.CONFIG_WRITE_FAILED,
          stored.code === 'safe_storage_unavailable' ? 'OS 安全存储不可用，拒绝保存上传凭证（无明文降级）' : '保存上传凭证密文失败',
        );
      }
      const targetChanged = current.data.target !== validation.origin;
      const persisted = config.persistTargetAndEnabled(validation.origin, current.data.enabled);
      if (!persisted.ok) {
        config.clearToken();
        throw new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.CONFIG_WRITE_FAILED, '保存发布目标配置失败，已回滚凭证（fail-closed）');
      }
      pending = null;
      const hasPriorTargetState =
        memoryResults.lastSuccessfulFingerprint !== null ||
        memoryResults.lastSuccessfulAt !== null ||
        memoryResults.lastFailedCode !== null ||
        memoryResults.lastFailedAt !== null;
      if (targetChanged && hasPriorTargetState) {
        // 目标更换后旧结果状态（成功基线/最近成功/最近失败）不再可信：立即按内存清空
        // 并绑定新目标（即使落盘失败也保守偏向重发；磁盘旧目标绑定会在重启加载时被丢弃）。
        memoryResults = {
          ...memoryResults,
          target: validation.origin,
          lastSuccessfulFingerprint: null,
          lastSuccessfulAt: null,
          lastFailedCode: null,
          lastFailedAt: null,
        };
        persistResults();
      } else {
        // 无既有目标状态或目标未变时也同步绑定 target，保证后续落盘/内存一致。
        memoryResults = { ...memoryResults, target: validation.origin };
      }
      authorizationGeneration += 1;
      // 目标/token 变更后需重新建立「恢复确认」（下一次周期重新读元数据核对远端）。
      recoveryConfirmed = false;
      return runtime.getStatus();
    },
    async setEnabled(enabled: boolean): Promise<MobileReadonlyStatusDto> {
      if (enabled) {
        const failure = enableFailureError();
        if (failure) throw failure;
      }
      const persisted = config.persistEnabled(enabled);
      if (!persisted.ok) {
        throw new MobileReadonlyPublishError(MOBILE_READONLY_LOCAL_CODES.CONFIG_WRITE_FAILED, '保存启用状态失败（fail-closed）');
      }
      if (!enabled) pending = null;
      authorizationGeneration += 1;
      if (enabled) {
        // 重新启用视为一次新的外发窗口：先读元数据核对远端（避免停机期间远端丢数据不被发现）。
        recoveryConfirmed = false;
        // 用户显式启用后立即受控执行一次检查：让 IPC 在返回前同步等到首个
        // success/failure 状态，UI 无需依赖后续 120s 后台周期才有可观测结果。
        // - setEnabled 不在周期串行链上，checkNow 会排在链尾等待在途周期，顺序正常；
        // - 网络单请求有界（内建 30s 超时）且失败以内建码返回而非抛出，等待时间有界；
        // - 等待期间用户若停用/换目标/换 token，authorizationGeneration 递增使在途检查
        //   不写入旧授权状态，最终返回 runtime.getStatus() 的当前状态；
        // - 本调用不触碰既有 120s 定时器（checkNow 不取消也不重复 scheduleNext），
        //   启动时已启用不额外触发（仅用户显式启用走此路径）。
        await runtime.checkNow();
      }
      return runtime.getStatus();
    },
    getStatus(): MobileReadonlyStatusDto {
      return buildStatus();
    },
  };
  return runtime;
}
