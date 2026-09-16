import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { rotateContentGeneration } from '../../src/domain/capabilities/local-data-persistence/identity';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import type {
  MobileReadonlyRemote,
  MobileReadonlyRemoteFactory,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlySnapshot } from '../../src/shared/mobile-readonly';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 首次空库 / 清空 / 恢复空库（tasks 3.5，真实 SQLite 集成）：
 * - 空库首次发布生成**空集合快照**（空快照合法，schemaVersion=1）；
 * - 已发布后数据清空或恢复空库必须再次发布空集合，防止手机残留旧数据；
 * - 云端「尚未发布」与「已发布空集合」是两个状态。
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

interface Server {
  published: boolean;
  snapshots: MobileReadonlySnapshot[];
}

function makeServer(): Server {
  return { published: false, snapshots: [] };
}

function setup(db: DatabaseSync, server: Server): MobileReadonlyPublishRuntime {
  const remote: MobileReadonlyRemote = {
    async readMeta() {
      if (!server.published) {
        return { ok: true, metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null } };
      }
      const last = server.snapshots[server.snapshots.length - 1];
      return {
        ok: true,
        metadata: {
          published: true,
          currentVersion: server.snapshots.length,
          publicationId: 'pub-empty-test',
          publishedAt: FIXED_ISO,
          dataAsOf: last.dataAsOf,
          fingerprint: { contentGenerationId: last.contentGenerationId, businessRevision: last.businessRevision },
        },
      };
    },
    async upload(body) {
      server.snapshots.push(body.snapshot);
      server.published = true;
      return { kind: 'accepted' };
    },
  };
  const remoteFactory: MobileReadonlyRemoteFactory = () => remote;
  const storageDir = makeTempDir('mobile-readonly-empty-');
  dirs.push(storageDir);
  return createMobileReadonlyPublishRuntime({
    storageDir,
    db: () => db,
    clock: new FixedClock(FIXED_ISO),
    timer: systemMobileReadonlyTimer,
    safeStorage: mockSafeStorage(),
    remoteFactory,
  });
}

describe('空库/清空/恢复空库（tasks 3.5，真实 SQLite）', () => {
  it('空库首次发布生成空集合快照；数据清空/恢复空库后再次发布空集合', async () => {
    const dir = makeTempDir('mobile-readonly-empty-db-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const server = makeServer();
      const runtime = setup(db, server);
      await runtime.configure({ target: 'https://publish.example.com', token: 'token-empty' });
      await runtime.setEnabled(true);

      // 1) 首次空库：合法空集合快照。
      await runtime.checkNow();
      expect(server.published).toBe(true);
      expect(server.snapshots.length).toBe(1);
      expect(server.snapshots[0].schemaVersion).toBe(1);
      expect(server.snapshots[0].projects).toEqual([]);
      expect(server.snapshots[0].overview.metrics.totalProjects).toBe(0);

      // 2) 有数据后发布非空快照。
      seedSyntheticProject(db, { index: 1 });
      seedSyntheticProject(db, { index: 2 });
      await runtime.checkNow();
      expect(server.snapshots.length).toBe(2);
      expect(server.snapshots[1].projects.length).toBe(2);
      expect(server.snapshots[1].overview.metrics.totalProjects).toBe(2);

      // 3) 清空所有业务数据 → 必须再发布一次空集合（手机不残留旧数据）。
      db.prepare('DELETE FROM contracts').run();
      db.prepare('DELETE FROM projects').run();
      await runtime.checkNow();
      expect(server.snapshots.length).toBe(3);
      expect(server.snapshots[2].projects).toEqual([]);
      expect(server.snapshots[2].overview.metrics.totalProjects).toBe(0);
      expect(server.snapshots[2].businessRevision).toBeGreaterThan(server.snapshots[1].businessRevision);

      // 4) 恢复空库（content_generation_id 轮换）→ 仍再次发布空集合，代际为新值。
      const rotated = rotateContentGeneration(db);
      await runtime.checkNow();
      expect(server.snapshots.length).toBe(4);
      expect(server.snapshots[3].contentGenerationId).toBe(rotated);
      expect(server.snapshots[3].projects).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  it('「尚未发布」与「已发布空集合」是两个状态（云端元数据区分）', async () => {
    const dir = makeTempDir('mobile-readonly-empty-db-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const server = makeServer();
      expect(server.published).toBe(false);

      const runtime = setup(db, server);
      await runtime.configure({ target: 'https://publish.example.com', token: 'token-empty' });
      await runtime.setEnabled(true);
      await runtime.checkNow();
      // 首次即发布空集合：已发布但无数据。
      expect(server.published).toBe(true);
      expect(server.snapshots.length).toBe(1);
      expect(server.snapshots[0].projects).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});
