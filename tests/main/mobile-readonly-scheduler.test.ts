import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { setImmediate as nodeSetImmediate } from 'node:timers';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlyFingerprint } from '../../src/shared/mobile-readonly';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  MOBILE_READONLY_PERIODIC_INTERVAL_MS,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
  type MobileReadonlyTimer,
  type MobileReadonlyTimerHandle,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyPublishOutcome,
  MobileReadonlyRemote,
  MobileReadonlyRemoteFactory,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import type { MobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { realMobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 可注入时钟调度器（tasks 4.1）：
 * - 启动检查一次 + 运行联网约每 2 分钟检查（相邻触发间距可注入断言）；
 * - single-flight：同一时刻至多一个发布周期；
 * - 变化才上传、无变化不上传且如实保留最近发布；停止后不再触发新请求/检查。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function mockSafeStorage(): MobileReadonlySafeStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (data) => data.toString('utf8').replace(/^enc:/, ''),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ManualTimer implements MobileReadonlyTimer {
  private id = 0;
  private queue: Array<{ id: number; callback: () => void; delayMs: number; cancelled: boolean }> = [];

  schedule(callback: () => void, delayMs: number): MobileReadonlyTimerHandle {
    const entry = { id: ++this.id, callback, delayMs, cancelled: false };
    this.queue.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  get pendingCount(): number {
    return this.queue.filter((item) => !item.cancelled).length;
  }

  get pendingDelays(): number[] {
    return this.queue.filter((item) => !item.cancelled).map((item) => item.delayMs);
  }

  /** 触发最早一个未取消任务并等待其异步完成（含其触发的下一轮调度）。 */
  async fireNext(): Promise<void> {
    const next = this.queue.shift();
    if (!next) return;
    if (next.cancelled) return;
    next.callback();
    await settle();
  }

  cancelAll(): void {
    for (const item of this.queue) item.cancelled = true;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => nodeSetImmediate(resolve));
  }
}

interface RuntimeCtx {
  db: DatabaseSync;
  runtime: MobileReadonlyPublishRuntime;
  uploads: Array<{ publicationId: string }>;
  readMetaCalls: () => number;
  timer: ManualTimer;
  remote: MobileReadonlyRemote;
  close: () => void;
}

function setupRuntime(seed: (db: DatabaseSync) => void): RuntimeCtx {
  const dir = makeTempDir('mobile-readonly-scheduler-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seed(db);
  const uploads: Array<{ publicationId: string }> = [];
  let metaCalls = 0;
  let unpublished = true;
  let fingerprint: MobileReadonlyFingerprint | null = null;
  const readMeta = async (): Promise<MobileReadonlyMetaResult> => {
    metaCalls += 1;
    if (!unpublished) {
      const last = uploads[uploads.length - 1];
      return {
        ok: true,
        metadata: {
          published: true,
          currentVersion: uploads.length,
          publicationId: last.publicationId,
          publishedAt: FIXED_ISO,
          dataAsOf: FIXED_ISO,
          fingerprint,
        },
      };
    }
    return {
      ok: true,
      metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null },
    };
  };
  const remote: MobileReadonlyRemote = {
    readMeta,
    upload: async (body) => {
      uploads.push({ publicationId: body.protocol.publicationId });
      unpublished = false;
      fingerprint = {
        contentGenerationId: body.snapshot.contentGenerationId,
        businessRevision: body.snapshot.businessRevision,
      };
      return { kind: 'accepted' };
    },
  };
  const remoteFactory: MobileReadonlyRemoteFactory = () => remote;
  const timer = new ManualTimer();
  const runtime = createMobileReadonlyPublishRuntime({
    storageDir: dir,
    db: () => db,
    clock: new FixedClock(FIXED_ISO),
    timer,
    safeStorage: mockSafeStorage(),
    remoteFactory,
  });
  return {
    db,
    runtime,
    uploads,
    readMetaCalls: () => metaCalls,
    timer,
    remote,
    close: () => closeDatabase(db),
  };
}

async function enableConfigured(runtime: MobileReadonlyPublishRuntime): Promise<void> {
  await runtime.configure({ target: 'https://publish.example.com', token: 'secret-token-1' });
  await runtime.setEnabled(true);
}

describe('调度器：启动一次 + 周期 ≈2 分钟 + single-flight + 停止语义（tasks 4.1）', () => {
  it('start 触发一次立即检查（含变化时上传），随后按约 2 分钟周期调度', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      ctx.runtime.start();
      expect(ctx.timer.pendingDelays).toEqual([0]); // 启动检查一次（立即）

      await ctx.timer.fireNext();
      expect(ctx.uploads.length).toBe(1);
      expect(ctx.timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]); // ~2 分钟周期

      // 无写入 → 下一周期不重复上传（无 meta、无 upload）。
      const metaBefore = ctx.readMetaCalls();
      await ctx.timer.fireNext();
      expect(ctx.uploads.length).toBe(1);
      expect(ctx.readMetaCalls()).toBe(metaBefore);
      expect(ctx.timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);
    } finally {
      ctx.close();
    }
  });

  it('无变化不上传且如实保留最近发布（lastSuccessfulAt 不被清掉）', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(1);
      const before = ctx.runtime.getStatus();
      expect(before.lastSuccessfulAt).toBe(FIXED_ISO);

      await ctx.runtime.checkNow();
      const after = ctx.runtime.getStatus();
      expect(ctx.uploads.length).toBe(1);
      expect(after.lastSuccessfulAt).toBe(before.lastSuccessfulAt);
      expect(after.lastFailedCode).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it('首个定时周期远程传输失败如实可见，下一自动周期无需人工介入即补发布（不再有 OS 离线短路）', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      let transportFails = true;
      const healthyUpload = ctx.remote.upload;
      ctx.remote.upload = async (body) => {
        if (transportFails) return { kind: 'transport', code: 'TIMEOUT' };
        return healthyUpload(body);
      };
      ctx.runtime.start();
      expect(ctx.timer.pendingDelays).toEqual([0]);

      // 首个周期：实际传输失败（非离线预检）→ 无成功发布且失败码可见，并继续排入下一周期。
      await ctx.timer.fireNext();
      expect(ctx.uploads.length).toBe(0);
      expect(ctx.runtime.getStatus().lastFailedCode).not.toBeNull();
      expect(ctx.runtime.getStatus().lastSuccessfulAt).toBeNull();
      expect(ctx.timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);

      // 下一自动定时周期：恢复传输后自动补发布并清除失败码，无需人工 checkNow。
      transportFails = false;
      await ctx.timer.fireNext();
      expect(ctx.uploads.length).toBe(1);
      expect(ctx.runtime.getStatus().lastFailedCode).toBeNull();
      expect(ctx.runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      expect(ctx.timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);
    } finally {
      ctx.close();
    }
  });

  it('single-flight：同一时刻至多一个发布周期，新变化排队到后续周期', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      let started = deferred<void>();
      let gate = deferred<void>();
      let inflight = 0;
      let maxInflight = 0;
      let uploadCalls = 0;
      ctx.remote.upload = async () => {
        uploadCalls += 1;
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        started.resolve();
        await gate.promise;
        inflight -= 1;
        return { kind: 'accepted' };
      };

      const first = ctx.runtime.checkNow();
      await started.promise;
      const second = ctx.runtime.checkNow();
      gate.resolve();
      await first;
      await second;

      // 两个并发的周期未并发上传（上传期间 maxInflight=1，仅一次 upload 调用）；
      // 第二个排队周期结束后看到无变化，不再发起 meta/upload。
      expect(maxInflight).toBe(1);
      expect(uploadCalls).toBe(1);
      expect(ctx.readMetaCalls()).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it('stop 阻止未来检查/请求：即使已 await 的步骤随后 resolve 也不再继续', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      ctx.runtime.start();
      await ctx.timer.fireNext();
      expect(ctx.uploads.length).toBe(1);

      ctx.runtime.stop();
      // 已排定的下一周期被取消：触发也不产生任何远程调用。
      await ctx.timer.fireNext();
      expect(ctx.readMetaCalls()).toBe(1);
      // 直接 checkNow 在 stopped 状态下立即返回、不发起请求。
      await ctx.runtime.checkNow();
      expect(ctx.readMetaCalls()).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it('在途 upload 未决时 stop，旧 upload 随后 reject 不推进成功/失败，也不再续排定时器或发请求', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      const started = deferred<void>();
      const gate = deferred<MobileReadonlyPublishOutcome>();
      let uploadCalls = 0;
      const healthyUpload = ctx.remote.upload;
      ctx.remote.upload = async (body) => {
        uploadCalls += 1;
        if (uploadCalls === 1) {
          started.resolve();
          return gate.promise; // 真实未决 Promise：cycle 尚未完成
        }
        return healthyUpload(body);
      };

      ctx.runtime.start();
      expect(ctx.timer.pendingDelays).toEqual([0]);
      const fire = ctx.timer.fireNext();
      await started.promise;
      // 上传在途 → 本周期尚未完成，因此还没有续排下一周期。
      expect(ctx.timer.pendingDelays).toEqual([]);

      ctx.runtime.stop();
      gate.reject(new Error('late-stop-upload-secret'));
      await fire;
      await settle();

      const status = ctx.runtime.getStatus();
      expect(status.lastFailedCode).toBeNull(); // 旧授权异常不得写入失败
      expect(status.lastSuccessfulAt).toBeNull(); // 成功也不得推进
      expect(ctx.timer.pendingDelays).toEqual([]); // stop 后不再续排
      expect(uploadCalls).toBe(1); // 在途请求本身已发出，但无后续

      await ctx.runtime.checkNow(); // stopped → 立即返回
      expect(uploadCalls).toBe(1); // 仍无后续请求
      expect(ctx.timer.pendingDelays).toEqual([]);
    } finally {
      ctx.close();
    }
  });
});

const unpublishedMetaResult = (): MobileReadonlyMetaResult => ({
  ok: true,
  metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null },
});

function fingerprintOfSnapshot(body: MobileReadonlyUploadBody): MobileReadonlyFingerprint {
  return {
    contentGenerationId: body.snapshot.contentGenerationId,
    businessRevision: body.snapshot.businessRevision,
  };
}

describe('结果不可写/通知抛错不阻断周期调度（tasks 4.6 + issue9）', () => {
  it('onWarning 抛错 + 结果不可写 → 周期照常发布并继续调度后续周期', async () => {
    const dir = makeTempDir('mobile-readonly-sched-warn-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      const io: MobileReadonlyFileIo = {
        ...realMobileReadonlyFileIo,
        writeTextAtomic(path, text) {
          if (path.endsWith('mobile-readonly-results.json')) {
            return { ok: false, code: 'write_error' };
          }
          return realMobileReadonlyFileIo.writeTextAtomic(path, text);
        },
      };
      const uploads: string[] = [];
      let published = false;
      let fingerprint: MobileReadonlyFingerprint | null = null;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          if (!published) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: 1,
              publicationId: 'warn-pub',
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint,
            },
          };
        },
        upload: async (body) => {
          uploads.push(body.protocol.publicationId);
          published = true;
          fingerprint = fingerprintOfSnapshot(body);
          return { kind: 'accepted' };
        },
      };
      const timer = new ManualTimer();
      const warnings: string[] = [];
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer,
        safeStorage: mockSafeStorage(),
        io,
        remoteFactory: () => remote,
        onWarning: (warning) => {
          warnings.push(warning);
          throw new Error('notification sink is down');
        },
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'token-warn' });
      await runtime.setEnabled(true);

      runtime.start();
      expect(timer.pendingDelays).toEqual([0]);
      await timer.fireNext();
      expect(uploads.length).toBe(1);
      expect(warnings).toContain('MOBILE_READONLY_STATE_UNWRITABLE');
      expect(runtime.getStatus().issue).toBe('state_unwritable');
      // 通知回调抛错不得阻断调度：仍排入下一周期。
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);

      // 有新写入 → 后续周期照常发布成功。
      seedSyntheticProject(db, { index: 4 });
      await timer.fireNext();
      expect(uploads.length).toBe(2);
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('授权变更在途周期失效（issue5）', () => {
  it('disable 发生在在途元数据读取期间 → 周期中止：不再捕获/上传、不写失败或成功状态', async () => {
    const dir = makeTempDir('mobile-readonly-auth-disable-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      let metaCalls = 0;
      let uploadCalls = 0;
      const metaGate = deferred<MobileReadonlyMetaResult>();
      let metaStartedResolve!: () => void;
      const metaStarted = new Promise<void>((resolve) => {
        metaStartedResolve = resolve;
      });
      const remote: MobileReadonlyRemote = {
        readMeta: () => {
          metaCalls += 1;
          metaStartedResolve();
          return metaGate.promise;
        },
        upload: async () => {
          uploadCalls += 1;
          return { kind: 'accepted' };
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'tok' });
      await runtime.setEnabled(true);

      const cycle = runtime.checkNow();
      await metaStarted;
      await runtime.setEnabled(false);
      metaGate.resolve(unpublishedMetaResult());
      await cycle;

      expect(uploadCalls).toBe(0);
      expect(metaCalls).toBe(1);
      const status = runtime.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.lastFailedCode).toBeNull();
      expect(status.lastSuccessfulAt).toBeNull();
      const before = metaCalls;
      await runtime.checkNow();
      expect(metaCalls).toBe(before);
    } finally {
      closeDatabase(db);
    }
  });

  it('disable 发生在在途上传期间 → 周期中止；旧成功不落盘，重新启用后再发布', async () => {
    const dir = makeTempDir('mobile-readonly-auth-disable-upload-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      let serverPublished = false;
      let serverFingerprint: MobileReadonlyFingerprint | null = null;
      const uploads: MobileReadonlyUploadBody[] = [];
      let gate: Promise<void> = Promise.resolve();
      let startedResolve: (() => void) | null = null;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          if (!serverPublished) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: serverFingerprint,
            },
          };
        },
        upload: async (body) => {
          startedResolve?.();
          await gate;
          uploads.push(body);
          serverPublished = true;
          serverFingerprint = fingerprintOfSnapshot(body);
          return { kind: 'accepted' };
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'tok' });
      await runtime.setEnabled(true);
      await runtime.checkNow();
      expect(uploads.length).toBe(1);
      const firstFingerprint = readFingerprintFile(dir);
      expect(firstFingerprint).not.toBeNull();

      // 本地变化 → 第二周期候选；挂起 upload 制造 in-flight。
      seedSyntheticProject(db, { index: 1 });
      let unblock!: () => void;
      gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let startedWaiterResolve!: () => void;
      const startedWait = new Promise<void>((resolve) => {
        startedWaiterResolve = resolve;
      });
      startedResolve = startedWaiterResolve;

      const cycle = runtime.checkNow();
      await startedWait;
      // 上传已发出（不可撤销），此刻 disable → 代际失效。
      await runtime.setEnabled(false);
      unblock();
      await cycle;

      expect(uploads.length).toBe(2); // 在途请求本身已发出
      const status = runtime.getStatus();
      expect(status.enabled).toBe(false);
      // disable 不清成功基线；但旧在途成功绝不覆盖/推进它。
      expect(readFingerprintFile(dir)).toEqual(firstFingerprint);
      const uploadsBefore = uploads.length;
      await runtime.checkNow(); // 已禁用 → 不再发起任何上传
      expect(uploads.length).toBe(uploadsBefore);

      // 重新启用 → 基线（fp1）与当前指纹（fp2）不同 → 重新发布并推进基线。
      await runtime.setEnabled(true);
      await runtime.checkNow();
      expect(uploads.length).toBe(3);
      expect(readFingerprintFile(dir)).toEqual(fingerprintOfSnapshot(uploads[2]));
    } finally {
      closeDatabase(db);
    }
  });

  it('disable/重新启用之间配置与 token 仍有效；reconfigure 后新周期针对新目标发布', async () => {
    const dir = makeTempDir('mobile-readonly-auth-reconfig-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      let serverPublished = false;
      let serverFingerprint: MobileReadonlyFingerprint | null = null;
      const uploads: MobileReadonlyUploadBody[] = [];
      let gate: Promise<void> = Promise.resolve();
      let startedResolve: (() => void) | null = null;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          if (!serverPublished) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: serverFingerprint,
            },
          };
        },
        upload: async (body) => {
          startedResolve?.();
          await gate;
          uploads.push(body);
          serverPublished = true;
          serverFingerprint = fingerprintOfSnapshot(body);
          return { kind: 'accepted' };
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://a.example', token: 'tok-a' });
      await runtime.setEnabled(true);
      await runtime.checkNow();
      expect(uploads.length).toBe(1);
      expect(readFingerprintFile(dir)).not.toBeNull();

      // 本地变化 → 第二周期候选；挂起 upload 制造 in-flight。
      seedSyntheticProject(db, { index: 1 });
      let unblock!: () => void;
      gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let startedWaiterResolve!: () => void;
      const startedWait = new Promise<void>((resolve) => {
        startedWaiterResolve = resolve;
      });
      startedResolve = startedWaiterResolve;

      const cycle = runtime.checkNow();
      await startedWait;
      // upload 已发出（不可撤销），此刻更换目标 → 代际失效。
      await runtime.configure({ target: 'https://b.example', token: 'tok-b' });
      unblock();
      await cycle;

      expect(uploads.length).toBe(2); // 在途请求本身已发出
      const after = runtime.getStatus();
      expect(after.target).toBe('https://b.example');
      expect(after.enabled).toBe(true);
      // 旧基线已被目标更换清空；在途旧成功绝不覆盖新配置状态。
      expect(readFingerprintFile(dir)).toBeNull();
      expect(after.lastSuccessfulAt).toBeNull();

      // 下一周期针对新目标正常发布并建立新基线。
      await runtime.checkNow();
      expect(uploads.length).toBe(3);
      expect(readFingerprintFile(dir)).toEqual(fingerprintOfSnapshot(uploads[2]));
    } finally {
      closeDatabase(db);
    }
  });

  it('在途元数据读取期间 token 解密失败 → 周期中止、credential_unavailable 且不外发', async () => {
    const dir = makeTempDir('mobile-readonly-auth-decrypt-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      const state = { failDecrypt: false };
      const storage: MobileReadonlySafeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (data) => {
          if (state.failDecrypt) throw new Error('decrypt failed');
          return data.toString('utf8').replace(/^enc:/, '');
        },
      };
      let metaCalls = 0;
      let uploadCalls = 0;
      const metaGate = deferred<MobileReadonlyMetaResult>();
      let metaStartedResolve!: () => void;
      const metaStarted = new Promise<void>((resolve) => {
        metaStartedResolve = resolve;
      });
      const remote: MobileReadonlyRemote = {
        readMeta: () => {
          metaCalls += 1;
          metaStartedResolve();
          return metaGate.promise;
        },
        upload: async () => {
          uploadCalls += 1;
          return { kind: 'accepted' };
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: storage,
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'tok-decrypt' });
      await runtime.setEnabled(true);

      const cycle = runtime.checkNow();
      await metaStarted;
      state.failDecrypt = true;
      metaGate.resolve(unpublishedMetaResult());
      await cycle;

      expect(uploadCalls).toBe(0);
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('credential_unavailable');

      // 恢复解密能力后回到已配置可用（启停不丢；凭证只是暂时不可用）。
      state.failDecrypt = false;
      const recovered = runtime.getStatus();
      expect(recovered.configured).toBe(true);
      expect(recovered.enabled).toBe(true);
      expect(recovered.issue).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('在途元数据读取期间加密后端不可用 → 周期中止、credential_unavailable 且不外发', async () => {
    const dir = makeTempDir('mobile-readonly-auth-storage-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    seedSyntheticProject(db, { index: 0 });
    try {
      const state = { available: true };
      const storage: MobileReadonlySafeStorage = {
        isEncryptionAvailable: () => state.available,
        getSelectedStorageBackend: () => (state.available ? 'gnome_libsecret' : 'unavailable'),
        encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptString: (data) => data.toString('utf8').replace(/^enc:/, ''),
      };
      let metaCalls = 0;
      let uploadCalls = 0;
      const metaGate = deferred<MobileReadonlyMetaResult>();
      let metaStartedResolve!: () => void;
      const metaStarted = new Promise<void>((resolve) => {
        metaStartedResolve = resolve;
      });
      const remote: MobileReadonlyRemote = {
        readMeta: () => {
          metaCalls += 1;
          metaStartedResolve();
          return metaGate.promise;
        },
        upload: async () => {
          uploadCalls += 1;
          return { kind: 'accepted' };
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: storage,
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'tok-storage' });
      await runtime.setEnabled(true);

      const cycle = runtime.checkNow();
      await metaStarted;
      state.available = false;
      metaGate.resolve(unpublishedMetaResult());
      await cycle;

      expect(uploadCalls).toBe(0);
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('credential_unavailable');
    } finally {
      closeDatabase(db);
    }
  });
});

function readFingerprintFile(dir: string): MobileReadonlyFingerprint | null {
  const raw = readFileSync(`${dir}/mobile-readonly-results.json`, 'utf8');
  return (JSON.parse(raw) as { lastSuccessfulFingerprint: MobileReadonlyFingerprint | null }).lastSuccessfulFingerprint;
}
