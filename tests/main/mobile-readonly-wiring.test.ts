import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import type {
  MobileReadonlyMetaResult,
  MobileReadonlyPublishOutcome,
  MobileReadonlyRemote,
} from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyUploadBody } from '../../src/shared/mobile-readonly';
import {
  createMobileReadonlyPublicationBridge,
} from '../../src/main/mobile-readonly/wiring';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 生产接线不再依据 OS 在线状态阻止请求（bounded 修复 A）：
 *
 * 历史上 `wiring.ts` 以 Electron `net.isOnline()` 做发布前预检，若系统误报离线但实际
 * HTTPS 可用，发布会被静默跳过。本测试用假 electron（`net.isOnline` 恒 false）与假 HTTP
 * 远程成功客户端驱动**生产接线**，证明：即使 OS 报离线，实际请求成功即可发布；
 * `net.isOnline` 不再被调用。
 */

const harness = vi.hoisted(() => {
  const netIsOnline = vi.fn(() => false);
  const uploads: MobileReadonlyUploadBody[] = [];
  let published = false;
  const remote: MobileReadonlyRemote = {
    async readMeta(): Promise<MobileReadonlyMetaResult> {
      if (!published) {
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
          publishedAt: null,
          dataAsOf: null,
          fingerprint: {
            contentGenerationId: last.snapshot.contentGenerationId,
            businessRevision: last.snapshot.businessRevision,
          },
        },
      };
    },
    async upload(body: MobileReadonlyUploadBody): Promise<MobileReadonlyPublishOutcome> {
      uploads.push(body);
      published = true;
      return { kind: 'accepted' };
    },
  };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (data: Buffer) => data.toString('utf8').replace(/^enc:/, ''),
  };
  return {
    netIsOnline,
    uploads,
    remote,
    safeStorage,
    reset() {
      uploads.length = 0;
      published = false;
    },
  };
});

vi.mock('electron', () => ({
  net: { isOnline: harness.netIsOnline },
  safeStorage: harness.safeStorage,
}));

vi.mock('../../src/main/mobile-readonly/upload', () => ({
  createDefaultRemoteFactory: () => () => harness.remote,
}));

const dirs: string[] = [];
afterEach(() => {
  harness.reset();
  harness.netIsOnline.mockClear();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待发布完成超时');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function setupDb(seed: (db: DatabaseSync) => void): { db: DatabaseSync; dir: string } {
  const dir = makeTempDir('mobile-readonly-wiring-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seed(db);
  return { db, dir };
}

describe('生产接线不依赖 OS 在线状态（bounded 修复 A）', () => {
  it('模拟 OS 离线但假 HTTPS 成功：启用即时检查后，生产默认定时器在业务变化时增量发布，且不调用 net.isOnline', async () => {
    harness.reset();
    const { db, dir } = setupDb((database) => seedSyntheticProject(database, { index: 0 }));
    let bridge: ReturnType<typeof createMobileReadonlyPublicationBridge> | null = null;
    try {
      bridge = createMobileReadonlyPublicationBridge({ userDataDir: dir, db: () => db });
      expect(bridge.degraded()).toBe(false);
      await bridge.configure({ target: 'https://publish.example.com', token: 'token-wiring-prod' });

      // 用户显式启用即受控执行一次检查：记录即时结果与基线上传数（避免用已成立条件等待）。
      const enabled = await bridge.setEnabled(true);
      expect(enabled.lastSuccessfulAt).not.toBeNull();
      const uploadsAfterEnable = harness.uploads.length;
      expect(uploadsAfterEnable).toBe(1);

      // 产生一笔合成业务变化，随后启动**生产默认定时器**（非手动 timer），
      // 等待默认路径的启动即时任务真正把上传数推到严格大于基线。
      seedSyntheticProject(db, { index: 4 });
      bridge.start();
      await waitFor(() => harness.uploads.length > uploadsAfterEnable);

      expect(harness.uploads.length).toBe(uploadsAfterEnable + 1);
      expect(harness.netIsOnline).not.toHaveBeenCalled();
      expect(bridge.getStatus().lastSuccessfulAt).not.toBeNull();
      expect(bridge.getStatus().lastFailedCode).toBeNull();
    } finally {
      bridge?.stop();
      closeDatabase(db);
    }
  });
});
