import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyPublishOutcome,
  MobileReadonlyRemote,
} from '../../src/main/mobile-readonly/remote';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 失败不阻断本地（tasks 4.8）：
 * 上传超时/失败不向业务路径传播；下一周期自动重试成功并刷新状态（失败码清除）。
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

interface RemoteHealth {
  uploadFails: boolean;
  metaFails: boolean;
  published: boolean;
  lastFingerprint: { contentGenerationId: string; businessRevision: number } | null;
  uploadCalls: number;
}

function makeRemote(health: RemoteHealth): MobileReadonlyRemote {
  return {
    async readMeta(): Promise<MobileReadonlyMetaResult> {
      if (health.metaFails) return { ok: false, code: 'META_READ_FAILED' };
      if (!health.published) {
        return { ok: true, metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null } };
      }
      return {
        ok: true,
        metadata: { published: true, currentVersion: 1, publicationId: 'pub-retry', publishedAt: FIXED_ISO, dataAsOf: FIXED_ISO, fingerprint: health.lastFingerprint },
      };
    },
    async upload(): Promise<MobileReadonlyPublishOutcome> {
      health.uploadCalls += 1;
      if (health.uploadFails) {
        return { kind: 'transport', code: 'TIMEOUT' };
      }
      health.published = true;
      return { kind: 'accepted' };
    },
  };
}

describe('失败不阻断本地，下一周期自动重试（tasks 4.8）', () => {
  it('上传失败期间本地业务可继续写入；恢复后下一周期自动成功并刷新失败状态', async () => {
    const dir = makeTempDir('mobile-readonly-retry-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const health: RemoteHealth = { uploadFails: false, metaFails: false, published: false, lastFingerprint: null, uploadCalls: 0 };
      const remote = makeRemote(health);
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtime.setEnabled(true);

      // 上传失败周期：记录失败码，不影响本地继续写业务。
      health.uploadFails = true;
      health.metaFails = true;
      await runtime.checkNow();
      expect(runtime.getStatus().lastFailedCode).toBe('META_READ_FAILED');
      expect(runtime.getStatus().lastSuccessfulAt).toBeNull();

      // 失败期间本地业务照常工作（读取与写入均正常）。
      const countBefore = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      seedSyntheticProject(db, { index: 4 });
      const countAfter = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      expect(countAfter.n).toBe(countBefore.n + 1);

      // 恢复后下一周期自动重试成功，失败码清除、成功时间刷新。
      health.uploadFails = false;
      health.metaFails = false;
      await runtime.checkNow();
      const status = runtime.getStatus();
      expect(status.lastFailedCode).toBeNull();
      expect(status.lastSuccessfulAt).toBe(FIXED_ISO);
      expect(health.uploadCalls).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('多次失败不产生无限循环（每 tick 有界），且不会向业务路径抛错', async () => {
    const dir = makeTempDir('mobile-readonly-retry-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const health: RemoteHealth = { uploadFails: true, metaFails: true, published: false, lastFingerprint: null, uploadCalls: 0 };
      const remote = makeRemote(health);
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remote,
      });
      await runtime.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtime.setEnabled(true);

      // 连续多个失败周期都不抛异常（本地业务不被破坏）。
      for (let i = 0; i < 3; i += 1) {
        await expect(runtime.checkNow()).resolves.toBeUndefined();
      }
      expect(runtime.getStatus().lastFailedCode).toBe('META_READ_FAILED');
    } finally {
      closeDatabase(db);
    }
  });
});
