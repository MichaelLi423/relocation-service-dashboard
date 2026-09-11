import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { realMobileReadonlyFileIo, type MobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { readCurrentMobileReadonlyFingerprint } from '../../src/main/mobile-readonly/fingerprint';
import { buildMobileReadonlySnapshot } from '../../src/main/mobile-readonly/snapshot';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 桌面重启恢复（tasks 4.7 + issue6）：
 * - 有效启用配置下重启后先读元数据（即使持久化指纹==当前指纹也先确认远端仍发布）；
 * - 持久化指纹==当前指纹且云端已发布 → 不重复上传；
 * - 指纹不同（或云端尚未发布/远端丢数据/本地成功状态丢失）→ 保守重新生成候选发布；
 * - 目标更换使持久化成功基线失效（不只清 pending），在途旧成功不得恢复旧基线；
 * - 在途候选内容不持久化：重启后不得凭空确认成功。
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

interface RecordingServer {
  uploads: MobileReadonlyUploadBody[];
  unpublished: boolean;
  publicationId: string | null;
  fingerprint: MobileReadonlyFingerprint | null;
  metaResult: 'ok' | 'failing';
}

function createRemote(server: RecordingServer): MobileReadonlyRemote {
  return {
    async readMeta(): Promise<MobileReadonlyMetaResult> {
      if (server.metaResult === 'failing') return { ok: false, code: 'META_READ_FAILED' };
      if (server.unpublished || server.publicationId === null) {
        return { ok: true, metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null } };
      }
      return {
        ok: true,
        metadata: {
          published: true,
          currentVersion: server.uploads.length,
          publicationId: server.publicationId,
          publishedAt: FIXED_ISO,
          dataAsOf: FIXED_ISO,
          fingerprint: server.fingerprint,
        },
      };
    },
    async upload(body) {
      server.uploads.push(body);
      server.unpublished = false;
      server.publicationId = body.protocol.publicationId;
      server.fingerprint = {
        contentGenerationId: body.snapshot.contentGenerationId,
        businessRevision: body.snapshot.businessRevision,
      };
      return { kind: 'accepted' };
    },
  };
}

function makeServer(): RecordingServer {
  return { uploads: [], unpublished: true, publicationId: null, fingerprint: null, metaResult: 'ok' };
}

function makeRuntime(dir: string, db: () => DatabaseSync, server: RecordingServer): MobileReadonlyPublishRuntime {
  const remote = createRemote(server);
  const remoteFactory: MobileReadonlyRemoteFactory = () => remote;
  return createMobileReadonlyPublishRuntime({
    storageDir: dir,
    db,
    clock: new FixedClock(FIXED_ISO),
    timer: systemMobileReadonlyTimer,
    safeStorage: mockSafeStorage(),
    remoteFactory,
  });
}

describe('桌面重启恢复（tasks 4.7）', () => {
  it('持久化指纹==当前指纹且云端已发布 → 重启后不重复上传（先读元数据语义由周期实现）', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      runtimeA.stop();

      // 模拟重启：同一数据目录 + 同一数据库 + 同一云端状态，新建 runtime。
      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(1); // 无重复上传
      expect(runtimeB.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });

  it('重启前发生数据变化（指纹不同）→ 重启后重新生成候选发布', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      runtimeA.stop();

      // 停机期间新写入 → 本地指纹与持久化指纹不同。
      seedSyntheticProject(db, { index: 7 });

      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(2);
      const second = server.uploads[1];
      expect(second.snapshot.businessRevision).toBeGreaterThan(server.uploads[0].snapshot.businessRevision);
    } finally {
      closeDatabase(db);
    }
  });

  it('在途候选不持久化：重启后不得凭空确认成功（云端尚未发布 → 保守重新发布）', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      // 第一次周期：元数据读取失败（不可达）→ 候选留在内存中（未确认），无成功指纹。
      server.metaResult = 'failing';
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(0);
      runtimeA.stop();

      // 重启后远端恢复可达但从未成功发布 → 绝不凭空确认成功，保守重新发布。
      server.metaResult = 'ok';
      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('目标更换清空持久化成功基线（不只清 pending）；重启后对新目标尚未发布 → 保守发布', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      expect(readLastFingerprint(dir)).not.toBeNull();

      // 更换目标（模拟全新的空远端 B）：成功基线立即失效（写回空），而不只是清 pending。
      server.uploads = [];
      server.unpublished = true;
      server.publicationId = null;
      server.fingerprint = null;
      await runtimeA.configure({ target: 'https://publish-b.example.com', token: 'token-2' });
      runtimeA.stop();
      expect(readLastFingerprint(dir)).toBeNull();

      // 重启后：配置指向 B、本地数据未变，但基线为空 → 保守向空远端发布。
      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(1);
      expect(readLastFingerprint(dir)).not.toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('重启后远端丢失已发布内容 → 即使本地基线存在且数据未变也保守重发', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      runtimeA.stop();

      // 远端丢文件：重新变为 unpublished（本地基线仍在）。
      server.unpublished = true;
      server.publicationId = null;
      server.fingerprint = null;
      server.metaResult = 'ok';

      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(2);
      expect(readLastFingerprint(dir)).not.toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('本地成功状态丢失（结果文件丢失）→ 远端虽已发布同指纹也保守重发，不凭空确认', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      expect(readLastFingerprint(dir)).not.toBeNull();
      runtimeA.stop();

      // 删除本地结果状态（模拟本地成功基线丢失）；远端仍发布同一内容。
      realMobileReadonlyFileIo.remove(join(dir, 'mobile-readonly-results.json'));

      const runtimeB = makeRuntime(dir, () => db, server);
      await runtimeB.checkNow();
      // 本地基线缺失 → 绝不由远端同指纹直接确认成功：保守再发布一次。
      expect(server.uploads.length).toBe(2);
      expect(readLastFingerprint(dir)).not.toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('结果文件绑定目标：A 发布后结果写失败 + 改配 B → 重启 B（远端已发布同指纹）仍重发且不沿用 A 成功时间', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const serverA = makeServer();
      const serverB = makeServer();
      const servers: Record<string, RecordingServer> = {
        'https://a.example': serverA,
        'https://b.example': serverB,
      };
      let resultsWriteFails = false;
      const io: MobileReadonlyFileIo = {
        ...realMobileReadonlyFileIo,
        writeTextAtomic(path, text) {
          if (resultsWriteFails && path.endsWith('mobile-readonly-results.json')) {
            return { ok: false, code: 'write_error' };
          }
          return realMobileReadonlyFileIo.writeTextAtomic(path, text);
        },
      };
      const makeTargetRuntime = (): MobileReadonlyPublishRuntime =>
        createMobileReadonlyPublishRuntime({
          storageDir: dir,
          db: () => db,
          clock: new FixedClock(FIXED_ISO),
          timer: systemMobileReadonlyTimer,
          safeStorage: mockSafeStorage(),
          io,
          remoteFactory: (credentials) => createRemote(servers[credentials.target]),
        });

      const runtimeA = makeTargetRuntime();
      await runtimeA.configure({ target: 'https://a.example', token: 'token-a' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(serverA.uploads.length).toBe(1);
      expect(readLastFingerprint(dir)).not.toBeNull();
      expect(readResultsTarget(dir)).toBe('https://a.example');
      const current = readCurrentMobileReadonlyFingerprint(db);

      // 结果文件不可写期间更换目标 B：配置/凭证保存成功、内存结果清空并绑定 B；
      // 磁盘结果文件仍保留 A 绑定（旧成功指纹/时间）——重启前的真实失败窗口。
      resultsWriteFails = true;
      await runtimeA.configure({ target: 'https://b.example', token: 'token-b' });
      const mid = runtimeA.getStatus();
      expect(mid.target).toBe('https://b.example');
      expect(mid.enabled).toBe(true);
      expect(mid.lastSuccessfulAt).toBeNull();
      runtimeA.stop();
      expect(readResultsTarget(dir)).toBe('https://a.example'); // 落盘失败：旧绑定仍在
      expect(readLastFingerprint(dir)).not.toBeNull();

      // 远端 B 已发布同一指纹（非 unpublished）——最容易被旧基线跳过的最严苛情形。
      serverB.unpublished = false;
      serverB.publicationId = 'pub-b';
      serverB.fingerprint = current;

      // 重启：结果文件 target(A) != 配置(B) → 按空态恢复。
      resultsWriteFails = false;
      const runtimeB = makeTargetRuntime();
      const before = runtimeB.getStatus();
      expect(before.target).toBe('https://b.example');
      expect(before.configured).toBe(true);
      expect(before.lastSuccessfulAt).toBeNull(); // 不沿用 A 成功时间
      expect(before.lastFailedCode).toBeNull();
      expect(before.issue).toBeNull(); // 不恢复任何「无关目标」的提示/失败

      await runtimeB.checkNow();
      expect(serverB.uploads.length).toBe(1); // 尽管远端同指纹，首次周期仍保守发布新候选
      expect(readLastFingerprint(dir)).not.toBeNull();
      expect(runtimeB.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });

  it('旧格式结果文件（无 target 绑定）→ 按空态恢复：远端已发布同指纹仍保守重发、不沿用旧时间', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      // 先建立 B 配置/token 并启用（持久化 enabled=true）。setEnabled(true) 现会立即
      // 受控执行首个周期；此处令元数据读取失败以保持「不产生成功发布/结果文件」的前置，
      // 结果文件随后仍被旧格式内容覆盖。
      const runtime0 = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => createRemote(server),
      });
      await runtime0.configure({ target: 'https://b.example', token: 'token-b' });
      server.metaResult = 'failing';
      await runtime0.setEnabled(true);
      runtime0.stop();
      server.metaResult = 'ok';

      // 手工写入无 target 绑定的旧格式结果：声称成功指纹=当前、时间为更早的 T。
      const current = readCurrentMobileReadonlyFingerprint(db);
      realMobileReadonlyFileIo.writeTextAtomic(
        join(dir, 'mobile-readonly-results.json'),
        `${JSON.stringify({
          version: 1,
          lastSuccessfulFingerprint: current,
          lastSuccessfulAt: '2026-08-08T08:00:00+08:00',
          lastFailedCode: null,
          lastFailedAt: null,
        })}\n`,
      );

      // 远端 B 已发布同指纹（最严苛跳过条件）。
      server.unpublished = false;
      server.publicationId = 'pub-legacy';
      server.fingerprint = current;

      const runtimeB = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => createRemote(server),
      });
      // 前置条件：重启后配置/B 启用必须成立（旧格式结果不被绑定，但配置仍有效启用）。
      const before = runtimeB.getStatus();
      expect(before.configured).toBe(true);
      expect(before.enabled).toBe(true);
      expect(before.target).toBe('https://b.example');
      expect(before.lastSuccessfulAt).toBeNull(); // 旧格式时间不沿用
      expect(before.lastFailedCode).toBeNull();
      expect(before.issue).toBeNull();
      await runtimeB.checkNow();
      expect(server.uploads.length).toBe(1); // 保守重发
      expect(runtimeB.getStatus().lastSuccessfulAt).toBe(FIXED_ISO);
    } finally {
      closeDatabase(db);
    }
  });

  it('元数据成功但捕获失败不算确认：远端丢文件后下一周期（无本地写入）自动补发并清除错误', async () => {
    const dir = makeTempDir('mobile-readonly-restart-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const server = makeServer();
      const runtimeA = makeRuntime(dir, () => db, server);
      await runtimeA.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeA.setEnabled(true);
      await runtimeA.checkNow();
      expect(server.uploads.length).toBe(1);
      const revisionBefore = (db.prepare('SELECT business_revision AS r FROM database_metadata WHERE id = 1').get() as { r: number }).r;
      runtimeA.stop();

      // 远端丢文件（本地基线仍在、无新写入）。
      server.unpublished = true;
      server.publicationId = null;
      server.fingerprint = null;

      // 重启后首次周期：元数据读取成功（HTTP 层面）但捕获抛错。
      let buildCalls = 0;
      const runtimeB = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        remoteFactory: () => createRemote(server),
        buildSnapshot: () => {
          buildCalls += 1;
          if (buildCalls === 1) throw new Error('transient local snapshot failure');
          return buildMobileReadonlySnapshot({ db, clock: new FixedClock(FIXED_ISO) });
        },
      });
      await runtimeB.checkNow();
      expect(buildCalls).toBe(1);
      expect(runtimeB.getStatus().lastFailedCode).toBe('LOCAL_SNAPSHOT_FAILED');

      // 下一自然周期（无任何本地写入）：不再被旧指纹短路，读元数据后成功补发、错误清除。
      await runtimeB.checkNow();
      expect(buildCalls).toBe(2);
      expect(server.uploads.length).toBe(2);
      const after = runtimeB.getStatus();
      expect(after.lastFailedCode).toBeNull();
      expect(after.lastSuccessfulAt).toBe(FIXED_ISO);
      const revisionAfter = (db.prepare('SELECT business_revision AS r FROM database_metadata WHERE id = 1').get() as { r: number }).r;
      expect(revisionAfter).toBe(revisionBefore); // 补发不需要本地新写入
    } finally {
      closeDatabase(db);
    }
  });
});

function readLastFingerprint(dir: string): MobileReadonlyFingerprint | null {
  const raw = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
  return (JSON.parse(raw) as { lastSuccessfulFingerprint: MobileReadonlyFingerprint | null }).lastSuccessfulFingerprint;
}

function readResultsTarget(dir: string): string | null {
  const raw = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
  return (JSON.parse(raw) as { target: string | null }).target;
}
