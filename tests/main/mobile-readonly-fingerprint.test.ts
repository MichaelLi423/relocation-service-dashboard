import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlyFingerprint } from '../../src/shared/mobile-readonly';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyRemote,
  MobileReadonlyRemoteFactory,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 指纹捕获语义（tasks 3.3）：
 * - 上传成功保存**候选捕获时**指纹；绝不在上传完成后重读"最新修订"做指纹；
 * - 上传期间新写入归下一轮（下一周期按新指纹发布）。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockSafeStorage(backend = 'gnome_libsecret'): MobileReadonlySafeStorage {
  return {
    isEncryptionAvailable: () => backend !== 'basic_text' && backend !== 'unknown',
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (data) => data.toString('utf8').replace(/^enc:/, ''),
  };
}

interface ServerState {
  currentVersion: number;
  publicationId: string | null;
  publishedAt: string | null;
  fingerprint: MobileReadonlyFingerprint | null;
  uploads: MobileReadonlyUploadBody[];
}

function unpubMeta(): MobileReadonlyMetaResult {
  return {
    ok: true,
    metadata: {
      published: false,
      currentVersion: 0,
      publicationId: null,
      publishedAt: null,
      dataAsOf: null,
      fingerprint: null,
    },
  };
}

function metaOf(server: ServerState): MobileReadonlyMetaResult {
  if (server.publicationId === null) return unpubMeta();
  return {
    ok: true,
    metadata: {
      published: true,
      currentVersion: server.currentVersion,
      publicationId: server.publicationId,
      publishedAt: server.publishedAt,
      dataAsOf: '2026-08-08T09:00:00+08:00',
      fingerprint: server.fingerprint,
    },
  };
}

interface RuntimeCtx {
  db: DatabaseSync;
  dir: string;
  runtime: MobileReadonlyPublishRuntime;
  server: ServerState;
  /** 下一次 upload 被调用的信号（便于在候选捕获后、上传完成前插入写入）。 */
  nextUploadStarted: () => Promise<void>;
  /** 挂起下一次 upload 直到 resolve（默认不挂起）。 */
  blockUpload: () => { resolve: () => void };
  remote: MobileReadonlyRemote;
  close: () => void;
}

function setupRuntime(seed: (db: DatabaseSync) => void): RuntimeCtx {
  const dir = makeTempDir('mobile-readonly-fp-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seed(db);
  const server: ServerState = {
    currentVersion: 0,
    publicationId: null,
    publishedAt: null,
    fingerprint: null,
    uploads: [],
  };
  let startedWaiters: Array<() => void> = [];
  let gatePromise: Promise<void> = Promise.resolve();
  const nextUploadStarted = (): Promise<void> =>
    new Promise<void>((resolve) => {
      startedWaiters.push(resolve);
    });
  const blockUpload = (): { resolve: () => void } => {
    const deferredBlock = deferred<void>();
    gatePromise = deferredBlock.promise;
    return { resolve: () => deferredBlock.resolve() };
  };
  const remote: MobileReadonlyRemote = {
    readMeta: () => Promise.resolve(metaOf(server)),
    upload: async (body) => {
      const waiters = startedWaiters;
      startedWaiters = [];
      for (const waiter of waiters) waiter();
      await gatePromise;
      server.currentVersion += 1;
      server.publicationId = body.protocol.publicationId;
      server.publishedAt = FIXED_ISO;
      server.fingerprint = {
        contentGenerationId: body.snapshot.contentGenerationId,
        businessRevision: body.snapshot.businessRevision,
      };
      server.uploads.push(body);
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
  return {
    db,
    dir,
    runtime,
    server,
    nextUploadStarted,
    blockUpload,
    remote,
    close: () => closeDatabase(db),
  };
}

async function enableConfigured(runtime: MobileReadonlyPublishRuntime): Promise<void> {
  await runtime.configure({ target: 'https://publish.example.com', token: 'secret-token-1' });
  await runtime.setEnabled(true);
}

function readResultsFile(dir: string): { lastSuccessfulFingerprint: MobileReadonlyFingerprint | null; lastSuccessfulAt: string | null; lastFailedCode: string | null } {
  const raw = readFileSync(`${dir}/mobile-readonly-results.json`, 'utf8');
  return JSON.parse(raw) as {
    lastSuccessfulFingerprint: MobileReadonlyFingerprint | null;
    lastSuccessfulAt: string | null;
    lastFailedCode: string | null;
  };
}

describe('指纹捕获语义（tasks 3.3）', () => {
  it('上传成功保存的是候选捕获时指纹（≠上传完成后的最新修订）', async () => {
    const seed = (db: DatabaseSync): void => {
      seedSyntheticProject(db, { index: 0 });
    };
    const ctx = setupRuntime(seed);
    try {
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();
      expect(ctx.server.uploads.length).toBe(1);
      const firstUpload = ctx.server.uploads[0];

      // 状态文件保存的指纹 = 本次候选捕获时指纹。
      let results = readResultsFile(ctx.dir);
      expect(results.lastSuccessfulFingerprint).toEqual({
        contentGenerationId: firstUpload.snapshot.contentGenerationId,
        businessRevision: firstUpload.snapshot.businessRevision,
      });
      expect(results.lastSuccessfulAt).toBe(FIXED_ISO);

      // 第二周期开始时先写入新数据 → 新候选指纹已含该写入。
      seedSyntheticProject(ctx.db, { index: 1 });
      const blocker = ctx.blockUpload();
      const run = ctx.runtime.checkNow();
      await ctx.nextUploadStarted();
      // 上传 in-flight 期间再写入一批数据（属于下一轮），
      // 本次候选仍携带 in-flight 开始前的捕获指纹。
      seedSyntheticProject(ctx.db, { index: 2 });
      blocker.resolve();
      await run;

      expect(ctx.server.uploads.length).toBe(2);
      const secondUpload = ctx.server.uploads[1];
      results = readResultsFile(ctx.dir);
      // 第二周期保存指纹 = 捕获（上传开始）时的指纹，而非上传完成后的最新修订。
      expect(results.lastSuccessfulFingerprint).toEqual({
        contentGenerationId: secondUpload.snapshot.contentGenerationId,
        businessRevision: secondUpload.snapshot.businessRevision,
      });
      // 上传完成后的最新修订更高（期间新增了 index=2 项目）。
      const latest = readResultsFile(ctx.dir).lastSuccessfulFingerprint!;
      expect(latest.businessRevision).toBeLessThan(readCurrentRevision(ctx.db));

      // 第三周期：新写入（index=2）按新指纹再次发布。
      await ctx.runtime.checkNow();
      expect(ctx.server.uploads.length).toBe(3);
      const thirdUpload = ctx.server.uploads[2];
      expect(readResultsFile(ctx.dir).lastSuccessfulFingerprint).toEqual({
        contentGenerationId: thirdUpload.snapshot.contentGenerationId,
        businessRevision: thirdUpload.snapshot.businessRevision,
      });
    } finally {
      ctx.close();
    }
  });

  it('上传失败/未确认不推进成功指纹；无变化不上传（保留最近成功）', async () => {
    const ctx = setupRuntime((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();
      expect(ctx.server.uploads.length).toBe(1);
      const fpAfterFirst = readResultsFile(ctx.dir).lastSuccessfulFingerprint;
      expect(fpAfterFirst).not.toBeNull();

      // 制造变化后让每次上传都走「transport 不确定 + 元数据同版本」→ 有界重传 → RETRY_LIMIT。
      seedSyntheticProject(ctx.db, { index: 9 });
      const originalUpload = ctx.remote.upload.bind(ctx.remote);
      ctx.remote.upload = async () => ({ kind: 'transport', code: 'TIMEOUT' });
      await ctx.runtime.checkNow();
      // 上传从未被服务端接受 → 成功指纹不被推进。
      expect(readResultsFile(ctx.dir).lastSuccessfulFingerprint).toEqual(fpAfterFirst);
      expect(ctx.server.uploads.length).toBe(1);
      expect(readResultsFile(ctx.dir).lastFailedCode).toBe('RETRY_LIMIT');

      // 恢复远程后下一周期成功：刷新指纹（含 index=9 的变化）。
      ctx.remote.upload = originalUpload;
      await ctx.runtime.checkNow();
      expect(ctx.server.uploads.length).toBe(2);
      const fpAfterRetry = readResultsFile(ctx.dir).lastSuccessfulFingerprint;
      expect(fpAfterRetry?.businessRevision).toBeGreaterThan(fpAfterFirst?.businessRevision ?? -1);

      // 无变化周期：不发起任何请求，且不改变最近成功指纹/时间。
      const uploadsBefore = ctx.server.uploads.length;
      const successfulBefore = readResultsFile(ctx.dir).lastSuccessfulAt;
      await ctx.runtime.checkNow();
      expect(ctx.server.uploads.length).toBe(uploadsBefore);
      expect(readResultsFile(ctx.dir).lastSuccessfulAt).toBe(successfulBefore);
    } finally {
      ctx.close();
    }
  });
});

function readCurrentRevision(db: DatabaseSync): number {
  const row = db.prepare('SELECT business_revision AS r FROM database_metadata WHERE id = 1').get() as { r: number };
  return row.r;
}
