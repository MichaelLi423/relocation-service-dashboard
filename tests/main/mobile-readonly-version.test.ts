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
  MOBILE_READONLY_MAX_ATTEMPTS_PER_TICK,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyPublishOutcome,
  MobileReadonlyRemote,
  MobileReadonlyRemoteFactory,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 桌面侧三分支恢复（tasks 4.4）：
 * (1) 元数据 publicationId=候选 → 确认成功并保存候选捕获时指纹；
 * (2) 元数据 currentVersion 仍=候选 expectedCurrentVersion → 原样重传（同 publicationId/内容/版本）；
 * (3) 版本前进且 publicationId 不同 → 重新取一致快照、新 publicationId、新 expected 上传；
 * 元数据读取失败 → 保留候选为未确认、不推进成功指纹；每 tick 有界重试、无死循环。
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

interface FakeServer {
  currentVersion: number;
  publicationId: string | null;
  publishedAt: string | null;
  fingerprint: MobileReadonlyFingerprint | null;
  uploadBodies: MobileReadonlyUploadBody[];
  /** 每次上传后的行为（默认 accepted 并推进服务端）。 */
  uploadHandler: (body: MobileReadonlyUploadBody) => MobileReadonlyPublishOutcome | 'accept';
  /** readMeta 附加处理（默认按服务端状态生成）。 */
  metaOverride: (() => MobileReadonlyMetaResult) | null;
}

function createServer(): FakeServer {
  return {
    currentVersion: 0,
    publicationId: null,
    publishedAt: null,
    fingerprint: null,
    uploadBodies: [],
    uploadHandler: () => 'accept',
    metaOverride: null,
  };
}

function serverMeta(server: FakeServer): MobileReadonlyMetaResult {
  if (server.publicationId === null) {
    return { ok: true, metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null } };
  }
  return {
    ok: true,
    metadata: {
      published: true,
      currentVersion: server.currentVersion,
      publicationId: server.publicationId,
      publishedAt: server.publishedAt,
      dataAsOf: FIXED_ISO,
      fingerprint: server.fingerprint,
    },
  };
}

interface EngineCtx {
  db: DatabaseSync;
  dir: string;
  runtime: MobileReadonlyPublishRuntime;
  server: FakeServer;
  close: () => void;
}

function setupEngine(seed: (db: DatabaseSync) => void): EngineCtx {
  const dir = makeTempDir('mobile-readonly-version-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seed(db);
  const server = createServer();
  const remote: MobileReadonlyRemote = {
    async readMeta() {
      if (server.metaOverride) return server.metaOverride();
      return serverMeta(server);
    },
    async upload(body) {
      server.uploadBodies.push(body);
      const decision = server.uploadHandler(body);
      if (decision !== 'accept') return decision;
      // 服务端接受：推进版本/记录 publicationId/指纹（publishedAt 独立记录）。
      server.currentVersion += 1;
      server.publicationId = body.protocol.publicationId;
      server.publishedAt = FIXED_ISO;
      server.fingerprint = {
        contentGenerationId: body.snapshot.contentGenerationId,
        businessRevision: body.snapshot.businessRevision,
      };
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
  return { db, dir, runtime, server, close: () => closeDatabase(db) };
}

async function enableConfigured(runtime: MobileReadonlyPublishRuntime): Promise<void> {
  await runtime.configure({ target: 'https://publish.example.com', token: 'secret-token-1' });
  await runtime.setEnabled(true);
}

function lastSuccessfulFingerprintOf(dir: string): MobileReadonlyFingerprint | null {
  const raw = readFileSync(`${dir}/mobile-readonly-results.json`, 'utf8');
  return (JSON.parse(raw) as { lastSuccessfulFingerprint: MobileReadonlyFingerprint | null }).lastSuccessfulFingerprint;
}

describe('三分支恢复与有界重试（tasks 4.4）', () => {
  it('(1) 元数据 publicationId=候选 → 确认成功并保存候选捕获指纹，不重复上传', async () => {
    const ctx = setupEngine((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      // 场景：首次上传响应丢失（transport），元数据显示该候选已被接受。
      ctx.server.metaOverride = () => serverMeta(ctx.server); // 由 uploadHandler 先推进
      const pendingPublished: FakeServer = ctx.server;
      pendingPublished.uploadHandler = (body) => {
        // 服务端已接受（版本推进）但响应丢失 → 返回 transport 让桌面读元数据。
        pendingPublished.currentVersion += 1;
        pendingPublished.publicationId = body.protocol.publicationId;
        pendingPublished.publishedAt = FIXED_ISO;
        pendingPublished.fingerprint = {
          contentGenerationId: body.snapshot.contentGenerationId,
          businessRevision: body.snapshot.businessRevision,
        };
        return { kind: 'transport', code: 'TIMEOUT' };
      };
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();

      // 只有一次 upload 尝试，且成功指纹被确认保存。
      expect(ctx.server.uploadBodies.length).toBe(1);
      expect(ctx.server.currentVersion).toBe(1);
      const saved = lastSuccessfulFingerprintOf(ctx.dir);
      expect(saved).toEqual(ctx.server.fingerprint);

      // 无变化 → 不再重复上传。
      await ctx.runtime.checkNow();
      expect(ctx.server.uploadBodies.length).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it('(2) 元数据 currentVersion 仍=候选 expectedCurrentVersion → 原样重传同一对象/ID/版本', async () => {
    const ctx = setupEngine((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      // 服务端从未提交成功（版本仍为候选 expected）且未接受 → 引擎以完全相同候选重传。
      let responded = false;
      const uploadedBodies: MobileReadonlyUploadBody[] = [];
      const remoteOverride: MobileReadonlyRemote = {
        readMeta: async () =>
          responded
            ? serverMeta(ctx.server)
            : ({
                ok: true,
                metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null },
              } as MobileReadonlyMetaResult),
        upload: async (body) => {
          uploadedBodies.push(body);
          if (!responded) {
            responded = true;
            return { kind: 'transport', code: 'TIMEOUT' }; // 第一次结果丢失
          }
          ctx.server.currentVersion += 1;
          ctx.server.publicationId = body.protocol.publicationId;
          ctx.server.publishedAt = FIXED_ISO;
          ctx.server.fingerprint = {
            contentGenerationId: body.snapshot.contentGenerationId,
            businessRevision: body.snapshot.businessRevision,
          };
          return { kind: 'accepted' };
        },
      };
      ctx.runtime = createMobileReadonlyPublishRuntime({
        storageDir: ctx.dir,
        db: () => ctx.db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remoteOverride,
      });
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();

      // 两次 upload 使用完全相同 publicationId/expectedCurrentVersion/snapshot。
      expect(uploadedBodies.length).toBe(2);
      expect(uploadedBodies[1].protocol.publicationId).toBe(uploadedBodies[0].protocol.publicationId);
      expect(uploadedBodies[1].protocol.expectedCurrentVersion).toBe(uploadedBodies[0].protocol.expectedCurrentVersion);
      expect(uploadedBodies[1].snapshot).toEqual(uploadedBodies[0].snapshot);
      expect(lastSuccessfulFingerprintOf(ctx.dir)).toEqual(ctx.server.fingerprint);
    } finally {
      ctx.close();
    }
  });

  it('(3) 元数据版本前进且 publicationId 不同 → 冲突：重新捕获新候选、新 publicationId 与 expected', async () => {
    const ctx = setupEngine((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      const uploadedBodies: MobileReadonlyUploadBody[] = [];
      let conflict = false;
      const remoteOverride: MobileReadonlyRemote = {
        readMeta: async () => {
          if (conflict) {
            return {
              ok: true,
              metadata: { published: true, currentVersion: 5, publicationId: 'other-process-pub', publishedAt: FIXED_ISO, dataAsOf: FIXED_ISO, fingerprint: null },
            } as MobileReadonlyMetaResult;
          }
          return serverMeta(ctx.server);
        },
        upload: async (body) => {
          uploadedBodies.push(body);
          if (!conflict) {
            conflict = true;
            // 首次候选返回 transport，随后元数据显示云端已被其它候选推进到 v5。
            return { kind: 'transport', code: 'TIMEOUT' };
          }
          ctx.server.currentVersion = 5;
          ctx.server.publicationId = body.protocol.publicationId;
          ctx.server.publishedAt = FIXED_ISO;
          ctx.server.fingerprint = {
            contentGenerationId: body.snapshot.contentGenerationId,
            businessRevision: body.snapshot.businessRevision,
          };
          return { kind: 'accepted' };
        },
      };
      ctx.runtime = createMobileReadonlyPublishRuntime({
        storageDir: ctx.dir,
        db: () => ctx.db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remoteOverride,
      });
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();

      expect(uploadedBodies.length).toBe(2);
      const first = uploadedBodies[0];
      const second = uploadedBodies[1];
      expect(second.protocol.publicationId).not.toBe(first.protocol.publicationId);
      expect(second.protocol.expectedCurrentVersion).toBe(5);
      expect(first.protocol.expectedCurrentVersion).not.toBe(5);
      expect(lastSuccessfulFingerprintOf(ctx.dir)).toEqual(ctx.server.fingerprint);
    } finally {
      ctx.close();
    }
  });

  it('元数据读取失败 → 候选保留未确认，不推进成功指纹，下周期继续', async () => {
    const ctx = setupEngine((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      let uploadCalls = 0;
      let metaFails = 0;
      const remoteOverride: MobileReadonlyRemote = {
        readMeta: async () => {
          metaFails += 1;
          return { ok: false, code: 'META_READ_FAILED' };
        },
        upload: async (body) => {
          uploadCalls += 1;
          void body;
          return { kind: 'transport', code: 'TIMEOUT' };
        },
      };
      ctx.runtime = createMobileReadonlyPublishRuntime({
        storageDir: ctx.dir,
        db: () => ctx.db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remoteOverride,
      });
      await enableConfigured(ctx.runtime);
      // 首次周期：元数据读取失败 → 不上传、不推进指纹。
      await ctx.runtime.checkNow();
      expect(uploadCalls).toBe(0);
      expect(metaFails).toBe(1);
      expect(lastSuccessfulFingerprintOf(ctx.dir)).toBeNull();
    } finally {
      ctx.close();
    }
  });

  it('同 tick 重试有界：transport+同版本分支反复重传不超过上限，随后 RETRY_LIMIT（无死循环）', async () => {
    const ctx = setupEngine((db) => seedSyntheticProject(db, { index: 0 }));
    try {
      const uploadBodies: MobileReadonlyUploadBody[] = [];
      const remoteOverride: MobileReadonlyRemote = {
        readMeta: async () => serverMeta(ctx.server), // 保持未发布状态（版本 0 == expected）
        upload: async (body) => {
          uploadBodies.push(body);
          return { kind: 'transport', code: 'TIMEOUT' };
        },
      };
      ctx.runtime = createMobileReadonlyPublishRuntime({
        storageDir: ctx.dir,
        db: () => ctx.db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => remoteOverride,
      });
      await enableConfigured(ctx.runtime);
      await ctx.runtime.checkNow();

      // 每次分支 2（同版本重传）消耗一次尝试，最后达到上限并停止。
      expect(uploadBodies.length).toBe(MOBILE_READONLY_MAX_ATTEMPTS_PER_TICK);
      const status = ctx.runtime.getStatus();
      expect(status.lastFailedCode).toBe('RETRY_LIMIT');
      expect(lastSuccessfulFingerprintOf(ctx.dir)).toBeNull();
    } finally {
      ctx.close();
    }
  });
});
