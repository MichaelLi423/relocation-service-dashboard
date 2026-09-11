import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { readCurrentMobileReadonlyFingerprint } from '../../src/main/mobile-readonly/fingerprint';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 静默路径兜底（bounded 修复 B/C）：
 * - readFingerprint 抛错 → LOCAL_SNAPSHOT_FAILED，不发 meta/upload、不推进成功指纹、不泄漏原始异常；
 * - remoteFactory/readMeta/upload 意外 reject → LOCAL_PUBLICATION_FAILED 固定兜底码；
 * - 意外 reject 时保留 pending 候选（同一 publicationId/内容/expectedCurrentVersion）供下轮幂等恢复；
 * - 停用/换目标后旧 Promise 的拒绝不写入新授权状态。
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

function unpublishedMetaResult(): MobileReadonlyMetaResult {
  return {
    ok: true,
    metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null },
  };
}

function fingerprintOf(body: MobileReadonlyUploadBody): MobileReadonlyFingerprint {
  return { contentGenerationId: body.snapshot.contentGenerationId, businessRevision: body.snapshot.businessRevision };
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

/** 可手动触发定时任务（start/fireNext），验证真实自动周期而非人工 checkNow。 */
class ManualTimer implements MobileReadonlyTimer {
  private id = 0;
  private queue: Array<{ id: number; callback: () => void; delayMs: number; cancelled: boolean }> = [];

  schedule(callback: () => void, delayMs: number): MobileReadonlyTimerHandle {
    const entry = { id: ++this.id, callback, delayMs, cancelled: false };
    this.queue.push(entry);
    return { cancel: () => { entry.cancelled = true; } };
  }

  get pendingDelays(): number[] {
    return this.queue.filter((item) => !item.cancelled).map((item) => item.delayMs);
  }

  /** 触发最早一个未取消任务并等待其异步完成（含其触发的下一轮调度）。 */
  async fireNext(): Promise<void> {
    const next = this.queue.shift();
    if (!next || next.cancelled) return;
    next.callback();
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => nodeSetImmediate(resolve));
  }
}

function setupDb(): { db: DatabaseSync; dir: string } {
  const dir = makeTempDir('mobile-readonly-fallback-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seedSyntheticProject(db, { index: 0 });
  return { db, dir };
}

async function enableConfigured(runtime: ReturnType<typeof createMobileReadonlyPublishRuntime>, target = 'https://publish.example.com'): Promise<void> {
  await runtime.configure({ target, token: 'token-fallback' });
  await runtime.setEnabled(true);
}

function resultsText(dir: string): string {
  return readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
}

/** 结果文件可能因「旧授权异常不应写任何状态」而不存在；存在时才校验无泄漏。 */
function resultsTextIfPresent(dir: string): string {
  try {
    return resultsText(dir);
  } catch {
    return '';
  }
}

describe('readFingerprint 抛错兜底（bounded 修复 B）', () => {
  it('抛错时记录 LOCAL_SNAPSHOT_FAILED、不发 meta/upload 且不泄漏原始内容，下周期恢复', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'fingerprint-raw-secret';
      let fingerprintCalls = 0;
      let metaCalls = 0;
      const uploads: MobileReadonlyUploadBody[] = [];
      let published = false;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          metaCalls += 1;
          if (!published) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: fingerprintOf(uploads[uploads.length - 1]),
            },
          };
        },
        upload: async (body) => {
          uploads.push(body);
          published = true;
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
        readFingerprint: () => {
          fingerprintCalls += 1;
          if (fingerprintCalls === 1) throw new Error(rawSecret);
          return readCurrentMobileReadonlyFingerprint(db);
        },
      });
      await enableConfigured(runtime);

      await runtime.checkNow();
      const failed = runtime.getStatus();
      expect(failed.lastFailedCode).toBe('LOCAL_SNAPSHOT_FAILED');
      expect(failed.lastFailedAt).toBe(FIXED_ISO);
      expect(failed.lastSuccessfulAt).toBeNull();
      expect(metaCalls).toBe(0);
      expect(uploads.length).toBe(0);
      expect(JSON.stringify(failed)).not.toContain(rawSecret);
      expect(resultsText(dir)).not.toContain(rawSecret);

      // 下一周期无需本地写入即可恢复：读元数据、捕获并成功发布。
      await runtime.checkNow();
      expect(uploads.length).toBe(1);
      const recovered = runtime.getStatus();
      expect(recovered.lastFailedCode).toBeNull();
      expect(recovered.lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('未分类异常固定兜底码（bounded 修复 C）', () => {
  it('remoteFactory 抛错 → LOCAL_PUBLICATION_FAILED，自动排入 120000 且下一 timer 成功清除失败', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'factory-raw-secret';
      let factoryCalls = 0;
      let metaCalls = 0;
      const uploads: MobileReadonlyUploadBody[] = [];
      let published = false;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          metaCalls += 1;
          if (!published) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: fingerprintOf(uploads[uploads.length - 1]),
            },
          };
        },
        upload: async (body) => {
          uploads.push(body);
          published = true;
          return { kind: 'accepted' };
        },
      };
      const timer = new ManualTimer();
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => {
          factoryCalls += 1;
          if (factoryCalls === 1) throw new Error(rawSecret);
          return remote;
        },
      });
      await enableConfigured(runtime);
      runtime.start();
      expect(timer.pendingDelays).toEqual([0]);

      // 首个自动周期：factory 抛错 → 固定兜底码，且未阻断后续调度。
      await timer.fireNext();
      expect(runtime.getStatus().lastFailedCode).toBe('LOCAL_PUBLICATION_FAILED');
      expect(metaCalls).toBe(0);
      expect(JSON.stringify(runtime.getStatus())).not.toContain(rawSecret);
      expect(resultsText(dir)).not.toContain(rawSecret);
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);

      // 下一自动周期（无人工 checkNow）：factory 恢复 → 成功发布并清除失败码。
      await timer.fireNext();
      expect(uploads.length).toBe(1);
      expect(runtime.getStatus().lastFailedCode).toBeNull();
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);
    } finally {
      closeDatabase(db);
    }
  });

  it('readMeta reject → LOCAL_PUBLICATION_FAILED，自动排入 120000 且下一 timer 成功清除失败', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'meta-raw-secret';
      let metaCalls = 0;
      let published = false;
      const uploads: MobileReadonlyUploadBody[] = [];
      const remote: MobileReadonlyRemote = {
        readMeta: async () => {
          metaCalls += 1;
          if (metaCalls === 1) throw Object.assign(new Error(rawSecret), { code: 'RAW_CODE' });
          if (!published) return unpublishedMetaResult();
          return {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: fingerprintOf(uploads[uploads.length - 1]),
            },
          };
        },
        upload: async (body) => {
          uploads.push(body);
          published = true;
          return { kind: 'accepted' };
        },
      };
      const timer = new ManualTimer();
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await enableConfigured(runtime);
      runtime.start();
      expect(timer.pendingDelays).toEqual([0]);

      // 首个自动周期：readMeta 意外 reject → 固定兜底码且不保存原始 message/code。
      await timer.fireNext();
      expect(runtime.getStatus().lastFailedCode).toBe('LOCAL_PUBLICATION_FAILED');
      expect(JSON.stringify(runtime.getStatus())).not.toContain(rawSecret);
      expect(JSON.stringify(runtime.getStatus())).not.toContain('RAW_CODE');
      expect(resultsText(dir)).not.toContain(rawSecret);
      expect(resultsText(dir)).not.toContain('RAW_CODE');
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);

      // 下一自动周期（无人工 checkNow）：元数据恢复 → 成功发布并清除失败码。
      await timer.fireNext();
      expect(uploads.length).toBe(1);
      expect(runtime.getStatus().lastFailedCode).toBeNull();
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      expect(timer.pendingDelays).toEqual([MOBILE_READONLY_PERIODIC_INTERVAL_MS]);
    } finally {
      closeDatabase(db);
    }
  });

  it('upload 意外 reject → 固定兜底码，候选 publicationId/expectedVersion 保留并在下轮幂等重传，不生成新候选', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'upload-raw-secret';
      const uploads: MobileReadonlyUploadBody[] = [];
      let uploadShouldThrow = true;
      let published = false;
      const remote: MobileReadonlyRemote = {
        // 服务端始终未接受：版本保持 0，publicationId 为 null。
        readMeta: async (): Promise<MobileReadonlyMetaResult> =>
          published
            ? {
                ok: true,
                metadata: {
                  published: true,
                  currentVersion: uploads.length,
                  publicationId: uploads[uploads.length - 1].protocol.publicationId,
                  publishedAt: FIXED_ISO,
                  dataAsOf: FIXED_ISO,
                  fingerprint: fingerprintOf(uploads[uploads.length - 1]),
                },
              }
            : unpublishedMetaResult(),
        upload: async (body): Promise<MobileReadonlyPublishOutcome> => {
          uploads.push(body);
          if (uploadShouldThrow) throw new Error(rawSecret);
          published = true;
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
      await enableConfigured(runtime);

      // 周期 1：捕获候选 P1 后 upload 意外 reject。
      await runtime.checkNow();
      expect(runtime.getStatus().lastFailedCode).toBe('LOCAL_PUBLICATION_FAILED');
      expect(uploads.length).toBe(1);
      const originalBody = uploads[0];
      const publicationId = originalBody.protocol.publicationId;
      const expectedCurrentVersion = originalBody.protocol.expectedCurrentVersion;
      const originalFingerprint = fingerprintOf(originalBody);

      // reject 后本地业务继续写入：重传必须仍是**原候选完整内容**（同 publicationId + 同快照），
      // 不能把业务新变化并进在途候选，也不能另生成新候选。
      seedSyntheticProject(db, { index: 1 });

      // 周期 2：仍异常 → 原样重传同一候选人（深比较整个 body）。
      await runtime.checkNow();
      expect(uploads.length).toBe(2);
      expect(uploads[1]).toEqual(originalBody);
      expect(uploads[1].protocol.publicationId).toBe(publicationId);
      expect(uploads[1].protocol.expectedCurrentVersion).toBe(expectedCurrentVersion);
      expect(runtime.getStatus().lastFailedCode).toBe('LOCAL_PUBLICATION_FAILED');

      // 周期 3：恢复后同一候选被接受，成功指纹推进为**捕获时**指纹（非新写入后指纹）。
      uploadShouldThrow = false;
      await runtime.checkNow();
      expect(uploads.length).toBe(3);
      expect(uploads[2]).toEqual(originalBody);
      expect(runtime.getStatus().lastFailedCode).toBeNull();
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      const persisted = JSON.parse(resultsText(dir)) as { lastSuccessfulFingerprint: MobileReadonlyFingerprint };
      expect(persisted.lastSuccessfulFingerprint).toEqual(originalFingerprint);
      expect(resultsText(dir)).not.toContain(rawSecret);

      // 周期 4：本地新变化（周期 1 后写入）直到此刻才形成新候选发布。
      await runtime.checkNow();
      expect(uploads.length).toBe(4);
      expect(uploads[3].protocol.publicationId).not.toBe(publicationId);
      expect(uploads[3].snapshot.businessRevision).toBeGreaterThan(originalBody.snapshot.businessRevision);
    } finally {
      closeDatabase(db);
    }
  });

  it('停用发生在在途 upload 意外 reject 前：旧异常不写失败状态、不发后续，重新启用后新周期成功', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'late-raw-secret';
      const uploads: MobileReadonlyUploadBody[] = [];
      const started = deferred<void>();
      const gate = deferred<MobileReadonlyPublishOutcome>();
      let uploadCalls = 0;
      let published = false;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => (published ? {
          ok: true,
          metadata: {
            published: true,
            currentVersion: uploads.length,
            publicationId: uploads[uploads.length - 1].protocol.publicationId,
            publishedAt: FIXED_ISO,
            dataAsOf: FIXED_ISO,
            fingerprint: fingerprintOf(uploads[uploads.length - 1]),
          },
        } : unpublishedMetaResult()),
        upload: async (body) => {
          uploads.push(body);
          uploadCalls += 1;
          if (uploadCalls === 1) {
            started.resolve();
            return gate.promise;
          }
          published = true;
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
      await enableConfigured(runtime);

      const cycle = runtime.checkNow();
      await started.promise;
      await runtime.setEnabled(false);
      gate.reject(new Error(rawSecret));
      await cycle;

      const status = runtime.getStatus();
      expect(status.enabled).toBe(false);
      expect(status.lastFailedCode).toBeNull();
      expect(status.lastSuccessfulAt).toBeNull();
      expect(resultsTextIfPresent(dir)).not.toContain(rawSecret);

      const uploadsBefore = uploads.length;
      await runtime.checkNow();
      expect(uploads.length).toBe(uploadsBefore);

      // 重新启用：旧候选已被停用清除，新周期按当前状态重新捕获（新 publicationId）并成功。
      const oldPublicationId = uploads[0].protocol.publicationId;
      await runtime.setEnabled(true);
      await runtime.checkNow();
      expect(uploads.length).toBe(uploadsBefore + 1);
      expect(uploads[uploadsBefore].protocol.publicationId).not.toBe(oldPublicationId);
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });

  it('更换目标发生在在途 upload 意外 reject 前：旧目标异常不写新状态，新目标周期成功', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'late-target-raw-secret';
      const uploads: MobileReadonlyUploadBody[] = [];
      const targets: string[] = [];
      const started = deferred<void>();
      const gate = deferred<MobileReadonlyPublishOutcome>();
      let uploadCalls = 0;
      let published = false;
      const remoteFactory: MobileReadonlyRemoteFactory = (credentials) => {
        targets.push(credentials.target);
        return {
          readMeta: async () => (published ? {
            ok: true,
            metadata: {
              published: true,
              currentVersion: uploads.length,
              publicationId: uploads[uploads.length - 1].protocol.publicationId,
              publishedAt: FIXED_ISO,
              dataAsOf: FIXED_ISO,
              fingerprint: fingerprintOf(uploads[uploads.length - 1]),
            },
          } : unpublishedMetaResult()),
          upload: async (body) => {
            uploads.push(body);
            uploadCalls += 1;
            if (uploadCalls === 1) {
              started.resolve();
              return gate.promise;
            }
            published = true;
            return { kind: 'accepted' };
          },
        };
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory,
      });
      await runtime.configure({ target: 'https://a.example', token: 'tok-a' });
      await runtime.setEnabled(true);

      const cycle = runtime.checkNow();
      await started.promise;
      await runtime.configure({ target: 'https://b.example', token: 'tok-b' });
      gate.reject(new Error(rawSecret));
      await cycle;

      const status = runtime.getStatus();
      expect(status.target).toBe('https://b.example');
      expect(status.lastFailedCode).toBeNull();
      expect(status.lastSuccessfulAt).toBeNull();
      expect(resultsTextIfPresent(dir)).not.toContain(rawSecret);

      // 换目标后旧在途候选不得复用：新目标周期必须生成新 publicationId。
      const oldPublicationId = uploads[0].protocol.publicationId;
      await runtime.checkNow();
      expect(uploads.length).toBe(2);
      expect(targets[1]).toBe('https://b.example');
      expect(uploads[1].protocol.publicationId).not.toBe(oldPublicationId);
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });

  it('仅更换 token（同目标）在途旧 upload reject → 旧结果不入新状态，新周期 factory 收到新 token 且候选 ID 不同', async () => {
    const { db, dir } = setupDb();
    try {
      const rawSecret = 'late-token-raw-secret';
      const target = 'https://publish.example.com';
      const factoryCredentials: Array<{ target: string; token: string }> = [];
      const uploads: MobileReadonlyUploadBody[] = [];
      const started = deferred<void>();
      const gate = deferred<MobileReadonlyPublishOutcome>();
      let uploadCalls = 0;
      let published = false;
      const remote: MobileReadonlyRemote = {
        readMeta: async () => (published ? {
          ok: true,
          metadata: {
            published: true,
            currentVersion: uploads.length,
            publicationId: uploads[uploads.length - 1].protocol.publicationId,
            publishedAt: FIXED_ISO,
            dataAsOf: FIXED_ISO,
            fingerprint: fingerprintOf(uploads[uploads.length - 1]),
          },
        } : unpublishedMetaResult()),
        upload: async (body) => {
          uploads.push(body);
          uploadCalls += 1;
          if (uploadCalls === 1) {
            started.resolve();
            return gate.promise;
          }
          published = true;
          return { kind: 'accepted' };
        },
      };
      const remoteFactory: MobileReadonlyRemoteFactory = (credentials) => {
        factoryCredentials.push({ target: credentials.target, token: credentials.token });
        return remote;
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory,
      });
      await runtime.configure({ target, token: 'token-old' });
      await runtime.setEnabled(true);

      const cycle = runtime.checkNow();
      await started.promise;
      // 同目标、仅换 token → 代际失效；在途旧 upload 随后 reject 不得写入新状态。
      await runtime.configure({ target, token: 'token-new' });
      gate.reject(new Error(rawSecret));
      await cycle;

      const status = runtime.getStatus();
      expect(status.target).toBe(target);
      expect(status.enabled).toBe(true);
      expect(status.lastFailedCode).toBeNull();
      expect(status.lastSuccessfulAt).toBeNull();
      expect(resultsTextIfPresent(dir)).not.toContain(rawSecret);

      const oldPublicationId = uploads[0].protocol.publicationId;
      await runtime.checkNow();
      expect(uploads.length).toBe(2);
      expect(factoryCredentials[factoryCredentials.length - 1]).toEqual({ target, token: 'token-new' });
      expect(uploads[1].protocol.publicationId).not.toBe(oldPublicationId);
      expect(runtime.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
      expect(resultsText(dir)).not.toContain('token-old');
    } finally {
      closeDatabase(db);
    }
  });
});
