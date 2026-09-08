import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { rotateContentGeneration } from '../../src/domain/capabilities/local-data-persistence/identity';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlyFingerprint } from '../../src/shared/mobile-readonly';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  hasMobileReadonlyBusinessChange,
  readCurrentMobileReadonlyFingerprint,
  sameMobileReadonlyFingerprint,
} from '../../src/main/mobile-readonly/fingerprint';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyRemote,
  MobileReadonlyRemoteFactory,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 变化检测（tasks 3.4）：
 * - 同代际 businessRevision 增长 → 判定变化；
 * - contentGenerationId 轮换（恢复，含 revision 数值下降）→ 判定变化；
 * - 无写入不变化（指纹相等不发布）。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function mockSafeStorage(backend = 'gnome_libsecret'): MobileReadonlySafeStorage {
  return {
    isEncryptionAvailable: () => backend !== 'basic_text' && backend !== 'unknown',
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (data) => data.toString('utf8').replace(/^enc:/, ''),
  };
}

interface RuntimeCtx {
  db: DatabaseSync;
  runtime: MobileReadonlyPublishRuntime;
  uploads: MobileReadonlyUploadBody[];
  close: () => void;
}

function setupRuntime(seed: (db: DatabaseSync) => void): RuntimeCtx {
  const dir = makeTempDir('mobile-readonly-change-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seed(db);
  const uploads: MobileReadonlyUploadBody[] = [];
  let unpublished = true;
  const readMeta = async (): Promise<{ ok: true; metadata: { published: boolean; currentVersion: number; publicationId: string | null; publishedAt: string | null; dataAsOf: string | null; fingerprint: MobileReadonlyFingerprint | null } }> => {
    if (unpublished) {
      return {
        ok: true,
        metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null },
      };
    }
    const last = uploads[uploads.length - 1];
    return {
      ok: true,
      metadata: {
        published: true,
        currentVersion: uploads.length,
        publicationId: last.protocol.publicationId,
        publishedAt: FIXED_ISO,
        dataAsOf: last.snapshot.dataAsOf,
        fingerprint: {
          contentGenerationId: last.snapshot.contentGenerationId,
          businessRevision: last.snapshot.businessRevision,
        },
      },
    };
  };
  const remote: MobileReadonlyRemote = {
    readMeta,
    upload: async (body) => {
      uploads.push(body);
      unpublished = false;
      return { kind: 'accepted' };
    },
  };
  const remoteFactory: MobileReadonlyRemoteFactory = () => remote;
  const runtime = createMobileReadonlyPublishRuntime({
    storageDir: dir,
    db: () => db,
    clock: new FixedClock(FIXED_ISO),
    timer: systemMobileReadonlyTimer,
    safeStorage: mockSafeStorage(),
    remoteFactory,
  });
  return { db, runtime, uploads, close: () => closeDatabase(db) };
}

async function enableConfigured(runtime: MobileReadonlyPublishRuntime): Promise<void> {
  await runtime.configure({ target: 'https://publish.example.com', token: 'secret-token-1' });
  await runtime.setEnabled(true);
}

describe('指纹判定纯函数（tasks 3.4）', () => {
  it('无上次指纹视为变化；指纹相等视为无变化；修订/代际任一不同视为变化', () => {
    const fp: MobileReadonlyFingerprint = { contentGenerationId: 'gen-1', businessRevision: 3 };
    expect(hasMobileReadonlyBusinessChange(null, fp)).toBe(true);
    expect(hasMobileReadonlyBusinessChange(undefined, fp)).toBe(true);
    expect(hasMobileReadonlyBusinessChange(fp, fp)).toBe(false);
    expect(sameMobileReadonlyFingerprint(fp, fp)).toBe(true);
    expect(sameMobileReadonlyFingerprint(null, fp)).toBe(false);

    // 同代际修订增长 → 变化
    expect(hasMobileReadonlyBusinessChange(fp, { ...fp, businessRevision: 4 })).toBe(true);
    // 代际轮换（恢复）：即使修订数值下降也是变化
    expect(hasMobileReadonlyBusinessChange(fp, { contentGenerationId: 'gen-2', businessRevision: 1 })).toBe(true);
    // 代际轮换 + 修订相同也是变化
    expect(hasMobileReadonlyBusinessChange(fp, { contentGenerationId: 'gen-2', businessRevision: 3 })).toBe(true);
    // 同代际修订下降（不应发生但保守判为不同）
    expect(hasMobileReadonlyBusinessChange(fp, { ...fp, businessRevision: 2 })).toBe(true);
  });

  it('同代际修订增长触发发布；无写入不变化（无重复上传）', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(1);
      const fp1 = ctx.uploads[0].snapshot;

      // 同代际写入使 businessRevision 增长 → 下一周期判定变化并上传。
      seedSyntheticProject(ctx.db, { index: 1 });
      const revisionBefore = readCurrentRevision(ctx.db);
      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(2);
      expect(ctx.uploads[1].snapshot.businessRevision).toBeGreaterThan(fp1.businessRevision);
      expect(ctx.uploads[1].snapshot.businessRevision).toBe(revisionBefore);

      // 无新写入 → 下一周期不重复上传。
      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(2);
    } finally {
      ctx.close();
    }
  });

  it('contentGenerationId 轮换（恢复）即使修订数值低于历史也触发发布', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(1);

      // 记录当前指纹（高修订）；随后追加写入制造更高修订。
      const beforeRotate = readCurrentMobileReadonlyFingerprint(ctx.db);
      seedSyntheticProject(ctx.db, { index: 3 });
      // 轮换代际（模拟恢复），并手动把修订写回一个更低数值（可能低于历史）。
      const rotated = rotateContentGeneration(ctx.db);
      ctx.db.prepare('UPDATE database_metadata SET business_revision = ? WHERE id = 1').run(beforeRotate.businessRevision - 1);

      const nowFp = readCurrentMobileReadonlyFingerprint(ctx.db);
      expect(nowFp.contentGenerationId).toBe(rotated);
      expect(nowFp.businessRevision).toBeLessThan(beforeRotate.businessRevision);

      await ctx.runtime.checkNow();
      expect(ctx.uploads.length).toBe(2);
      expect(ctx.uploads[1].snapshot.contentGenerationId).toBe(rotated);
      expect(ctx.uploads[1].snapshot.businessRevision).toBe(beforeRotate.businessRevision - 1);
    } finally {
      ctx.close();
    }
  });
});

function readCurrentRevision(db: DatabaseSync): number {
  const row = db.prepare('SELECT business_revision AS r FROM database_metadata WHERE id = 1').get() as { r: number };
  return row.r;
}
