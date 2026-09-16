import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import type { MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyConfigStore,
} from '../../src/main/mobile-readonly/config';
import {
  createMobileReadonlyResultsStore,
  type MobileReadonlyResultsStore,
} from '../../src/main/mobile-readonly/state';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import { createMobileReadonlyRemoteClient } from '../../src/main/mobile-readonly/upload';
import type { MobileReadonlyRemote } from '../../src/main/mobile-readonly/remote';
import type { MobileReadonlyFingerprint } from '../../src/shared/mobile-readonly';
import type { MobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { realMobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 状态持久化（tasks 4.6）：
 * - 结果状态文件持久化 configured/启用/最近成功/最近失败与 lastSuccessfulFingerprint，
 *   不持久化整份待上传候选/快照；
 * - config（enabled/target）+ token 密文 与 results 分开；原子写；
 * - 配置损坏/不可读/落盘 target 非法 → 禁用外发（fail-closed）；
 * - 仅结果文件不可写 → 内存降级继续并提示。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

/** 测试用固定 AES-256-GCM 密钥（恰好 32 字节）；生产 electron-safe-storage.ts 完全不受影响。 */
const TEST_STORAGE_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

/**
 * 「不透明可逆」测试安全存储：AES-256-GCM（固定测试密钥 + 每次随机 IV）。
 * 密文字节与明文无文本关联（"file 不含明文 token"断言真实有效），且无进程内共享状态，
 * 重启/换 runtime 实例仍可解密同一落盘密文。
 */
function mockSafeStorage(): MobileReadonlySafeStorage {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', TEST_STORAGE_KEY, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
    },
    decryptString: (data) => {
      const iv = data.subarray(0, 12);
      const tag = data.subarray(data.length - 16);
      const body = data.subarray(12, data.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', TEST_STORAGE_KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function makeStores(dir: string, io: MobileReadonlyFileIo = realMobileReadonlyFileIo) {
  const config = createMobileReadonlyConfigStore({ io, storageDir: dir, safeStorage: mockSafeStorage() });
  const results = createMobileReadonlyResultsStore({ io, storageDir: dir });
  return { config, results };
}

function autoAcceptRemote() {
  let published = false;
  let fingerprint: MobileReadonlyFingerprint | null = null;
  const remote: MobileReadonlyRemote = {
    readMeta: async () => {
      if (!published) {
        return { ok: true, metadata: { published: false, currentVersion: 0, publicationId: null, publishedAt: null, dataAsOf: null, fingerprint: null } };
      }
      return {
        ok: true,
        metadata: { published: true, currentVersion: 1, publicationId: 'pub-x', publishedAt: FIXED_ISO, dataAsOf: FIXED_ISO, fingerprint },
      };
    },
    upload: async (body) => {
      published = true;
      fingerprint = { contentGenerationId: body.snapshot.contentGenerationId, businessRevision: body.snapshot.businessRevision };
      return { kind: 'accepted' };
    },
  };
  return { remote, fingerprint: () => fingerprint };
}

function makeEngine(dir: string, db: DatabaseSync, io: MobileReadonlyFileIo = realMobileReadonlyFileIo): MobileReadonlyPublishRuntime {
  const remote = autoAcceptRemote();
  return createMobileReadonlyPublishRuntime({
    storageDir: dir,
    db: () => db,
    clock: new FixedClock(FIXED_ISO),
    timer: systemMobileReadonlyTimer,
    safeStorage: mockSafeStorage(),
    io,
    remoteFactory: () => remote.remote,
  });
}

function openDb(): { db: DatabaseSync; dir: string } {
  const dir = makeTempDir('mobile-readonly-state-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seedSyntheticProject(db, { index: 0 });
  return { db, dir };
}

describe('状态与配置持久化（tasks 4.6）', () => {
  it('成功发布后持久化 lastSuccessfulFingerprint/时间，文件不含候选快照与 token；config/token/results 分开', async () => {
    const { db, dir } = openDb();
    try {
      const runtime = makeEngine(dir, db);
      await runtime.configure({ target: 'https://publish.example.com', token: 'top-secret-token' });
      await runtime.setEnabled(true);
      await runtime.checkNow();

      const config = readFileSync(join(dir, 'mobile-readonly-config.json'), 'utf8');
      const configParsed = JSON.parse(config) as { version: number; enabled: boolean; target: string };
      expect(configParsed.enabled).toBe(true);
      expect(configParsed.target).toBe('https://publish.example.com');

      const tokenFile = join(dir, 'mobile-readonly-token.enc');
      expect(existsSync(tokenFile)).toBe(true);
      const tokenCipher = readFileSync(tokenFile);
      // 密文文件不是明文 token。
      expect(tokenCipher.toString('utf8')).not.toContain('top-secret-token');

      const results = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
      expect(results).not.toContain('snapshot');
      expect(results).not.toContain('top-secret-token');
      expect(results).not.toContain('publicationId');
      const resultsParsed = JSON.parse(results) as {
        lastSuccessfulFingerprint: MobileReadonlyFingerprint;
        lastSuccessfulAt: string;
        lastFailedCode: string | null;
      };
      expect(resultsParsed.lastSuccessfulFingerprint.contentGenerationId.length).toBeGreaterThan(0);
      expect(resultsParsed.lastSuccessfulAt).toBe(FIXED_ISO);
      expect(resultsParsed.lastFailedCode).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('配置损坏 → fail-closed：configured/enabled=false 且 issue=config_corrupt，checkNow 不发请求', async () => {
    const { db, dir } = openDb();
    try {
      const io = realMobileReadonlyFileIo;
      io.writeTextAtomic(join(dir, 'mobile-readonly-config.json'), '{ broken json');
      let remoteCalls = 0;
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io,
        remoteFactory: () => ({
          readMeta: async () => {
            remoteCalls += 1;
            return { ok: false, code: 'META_READ_FAILED' };
          },
          upload: async () => {
            remoteCalls += 1;
            return { kind: 'rejected', code: 'UPLOAD_REJECTED' };
          },
        }),
      });
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('config_corrupt');
      await runtime.checkNow();
      expect(remoteCalls).toBe(0);

      // configure 也拒绝（fail-closed）。
      await expect(runtime.configure({ target: 'https://publish.example.com', token: 't' })).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
    } finally {
      closeDatabase(db);
    }
  });

  it('token 缺失/凭证不可用 → 禁用外发且 issue=credential_unavailable', async () => {
    const { db, dir } = openDb();
    try {
      const stores = makeStores(dir);
      expect(stores.config.persistEnabled(true).ok).toBe(true);
      // 先写好 target，但没有 token 文件。
      stores.config.persistTargetAndEnabled('https://publish.example.com', true);
      expect(stores.config.isTokenPresent()).toBe(false);

      const runtime = makeEngine(dir, db);
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('credential_unavailable');
      await expect(runtime.setEnabled(true)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    } finally {
      closeDatabase(db);
    }
  });

  it('结果状态文件不可写 → 内存继续（保留最近成功）并提示 state_unwritable，可恢复后自动清除提示', async () => {
    const { db, dir } = openDb();
    try {
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
      const runtime = makeEngine(dir, db, io);
      await runtime.configure({ target: 'https://publish.example.com', token: 't' });
      await runtime.setEnabled(true);

      // 第一次成功发布（结果可写）→ 结果文件落盘。
      await runtime.checkNow();
      expect(runtime.getStatus().issue).toBeNull();
      const oldResults = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');

      // 结果文件不可写期间仍完成第二次成功发布：内存保留最近成功 + issue=state_unwritable。
      seedSyntheticProject(db, { index: 5 });
      resultsWriteFails = true;
      await runtime.checkNow();
      const status = runtime.getStatus();
      expect(status.lastSuccessfulAt).toBe(FIXED_ISO);
      expect(status.issue).toBe('state_unwritable');
      // 磁盘结果仍是旧内容（内存续跑，不因写失败回滚成功状态）。
      expect(readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8')).toBe(oldResults);

      // 结果文件恢复可写后，下一次发布成功自动清除 state_unwritable 提示。
      seedSyntheticProject(db, { index: 6 });
      resultsWriteFails = false;
      await runtime.checkNow();
      expect(runtime.getStatus().issue).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('配置/结果分开可读写并原子保存（启用/目标/token 均入独立文件）', () => {
    const dir = makeTempDir('mobile-readonly-state-store-');
    dirs.push(dir);
    const { config, results } = makeStores(dir);
    const res = results as MobileReadonlyResultsStore;

    expect(config.load().missing).toBe(true);
    expect(config.load().corrupt).toBe(false);
    expect(config.storeToken('tok-1').ok).toBe(true);
    expect(config.persistTargetAndEnabled('https://x.example', false).ok).toBe(true);
    const afterWrite = config.load();
    expect(afterWrite.data.target).toBe('https://x.example');
    expect(afterWrite.data.enabled).toBe(false);
    expect(config.readToken()).toEqual({ ok: true, token: 'tok-1' });

    const fp: MobileReadonlyFingerprint = { contentGenerationId: 'g-1', businessRevision: 3 };
    expect(
      res
        .save({ version: 1, target: 'https://x.example', lastSuccessfulFingerprint: fp, lastSuccessfulAt: FIXED_ISO, lastFailedCode: null, lastFailedAt: null })
        .ok,
    ).toBe(true);
    expect(res.load().data.lastSuccessfulFingerprint).toEqual(fp);
    expect(res.load().data.target).toBe('https://x.example');
  });

  it('落盘 target 非严格 HTTPS origin（路径/query/hash/凭据/非法串）→ fail-closed：config_corrupt、绝不外发', async () => {
    const { db, dir } = openDb();
    try {
      let remoteCalls = 0;
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io: realMobileReadonlyFileIo,
        remoteFactory: () => ({
          readMeta: async () => {
            remoteCalls += 1;
            return { ok: false, code: 'META_READ_FAILED' };
          },
          upload: async () => ({ kind: 'rejected', code: 'UPLOAD_REJECTED' }),
        }),
      });
      for (const poisoned of [
        'https://publish.example.com/path',
        'https://publish.example.com?x=1',
        'https://publish.example.com#frag',
        'https://user:pass@publish.example.com',
        'http://publish.example.com',
        'not-a-url',
        '',
      ]) {
        const raw = JSON.stringify({ version: 1, enabled: true, target: poisoned }, null, 2);
        realMobileReadonlyFileIo.writeTextAtomic(join(dir, 'mobile-readonly-config.json'), `${raw}\n`);
        const status = runtime.getStatus();
        expect(status.configured).toBe(false);
        expect(status.enabled).toBe(false);
        expect(status.issue).toBe('config_corrupt');
        const callsBefore = remoteCalls;
        await runtime.checkNow();
        expect(remoteCalls).toBe(callsBefore);
      }
      await expect(runtime.configure({ target: 'https://ok.example', token: 't' })).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
    } finally {
      closeDatabase(db);
    }
  });

  it('配置不可读（read_error）→ 不静默当全新配置：config_corrupt、启用被拒、绝不外发', async () => {
    const { db, dir } = openDb();
    try {
      let remoteCalls = 0;
      const io: MobileReadonlyFileIo = {
        ...realMobileReadonlyFileIo,
        readText(path) {
          if (path.endsWith('mobile-readonly-config.json')) {
            return { ok: false, code: 'read_error' };
          }
          return realMobileReadonlyFileIo.readText(path);
        },
      };
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io,
        remoteFactory: () => ({
          readMeta: async () => {
            remoteCalls += 1;
            return { ok: false, code: 'META_READ_FAILED' };
          },
          upload: async () => ({ kind: 'rejected', code: 'UPLOAD_REJECTED' }),
        }),
      });
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('config_corrupt');
      await runtime.checkNow();
      expect(remoteCalls).toBe(0);
      await expect(runtime.setEnabled(true)).rejects.toMatchObject({ code: 'CONFIG_CORRUPT' });
    } finally {
      closeDatabase(db);
    }
  });

  it('启动元数据读取阶段：传输抛含 token 文本 → 精确阶段码 META_READ_FAILED，无泄漏、指纹不推进', async () => {
    const { db, dir } = openDb();
    try {
      const secretToken = 'leakable-super-secret-token';
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io: realMobileReadonlyFileIo,
        remoteFactory: (credentials) =>
          createMobileReadonlyRemoteClient({
            credentials,
            transport: async () => {
              // 任意路线都抛含 token 的远端文本（GET /api/meta 阶段失败）。
              throw new Error(`upstream echoed ${credentials.token} (raw GET secret)`);
            },
          }),
      });
      await runtime.configure({ target: 'https://publish.example.com', token: secretToken });
      await runtime.setEnabled(true);
      await runtime.checkNow();

      // 阶段语义：周期起始的元数据读不到 → 归一为 META_READ_FAILED（不是任意文本/不是 NETWORK_ERROR）。
      const status = runtime.getStatus();
      expect(status.lastFailedCode).toBe('META_READ_FAILED');
      expect(JSON.stringify(status)).not.toContain(secretToken);
      expect(JSON.stringify(status)).not.toContain('upstream echoed');
      const results = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
      expect(results).not.toContain(secretToken);
      expect(results).not.toContain('upstream echoed');
      const parsed = JSON.parse(results) as {
        lastFailedCode: string;
        lastSuccessfulFingerprint: MobileReadonlyFingerprint | null;
        lastSuccessfulAt: string | null;
      };
      expect(parsed.lastFailedCode).toBe('META_READ_FAILED');
      // 从未进入发布分支：成功基线不推进。
      expect(parsed.lastSuccessfulFingerprint).toBeNull();
      expect(parsed.lastSuccessfulAt).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('发布阶段：PUT 抛含 token 文本 + 恢复元数据读取失败 → 归一 NETWORK_ERROR（精确阶段码）、指纹不推进', async () => {
    const { db, dir } = openDb();
    try {
      const secretToken = 'leakable-super-secret-token';
      let getCalls = 0;
      let putCalls = 0;
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io: realMobileReadonlyFileIo,
        remoteFactory: (credentials) =>
          createMobileReadonlyRemoteClient({
            credentials,
            transport: async (request) => {
              if (request.method === 'PUT') {
                putCalls += 1;
                throw new Error(`upstream echoed ${credentials.token} (raw PUT secret)`);
              }
              getCalls += 1;
              if (getCalls > 1) {
                // 上传结果不确定后的恢复元数据也失败 → 归一 NETWORK_ERROR 并原样进入失败码。
                throw new Error(`upstream echoed ${credentials.token} (raw GET secret)`);
              }
              // 启动元数据读取成功：有效裸元数据（尚未发布）。
              return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  published: false,
                  currentVersion: 0,
                  publicationId: null,
                  publishedAt: null,
                  dataAsOf: null,
                  fingerprint: null,
                }),
              };
            },
          }),
      });
      await runtime.configure({ target: 'https://publish.example.com', token: secretToken });
      // setEnabled(true) 现会立即受控执行首个周期（不再额外 checkNow 造成双重周期）。
      await runtime.setEnabled(true);

      // 上传阶段传输失败 + 恢复读取失败 → 归一化底层码 NETWORK_ERROR（非任意文本、非启动阶段码）。
      const status = runtime.getStatus();
      expect(status.lastFailedCode).toBe('NETWORK_ERROR');
      expect(JSON.stringify(status)).not.toContain(secretToken);
      expect(JSON.stringify(status)).not.toContain('upstream echoed');
      expect(JSON.stringify(status)).not.toContain('raw PUT secret');
      const results = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
      expect(results).not.toContain(secretToken);
      expect(results).not.toContain('upstream echoed');
      const parsed = JSON.parse(results) as {
        lastFailedCode: string;
        lastSuccessfulFingerprint: MobileReadonlyFingerprint | null;
        lastSuccessfulAt: string | null;
      };
      expect(parsed.lastFailedCode).toBe('NETWORK_ERROR');
      // 服务端从未收到/确认成功：成功基线不推进。
      expect(putCalls).toBe(1);
      expect(getCalls).toBe(2);
      expect(parsed.lastSuccessfulFingerprint).toBeNull();
      expect(parsed.lastSuccessfulAt).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it('发布阶段：PUT 抛含 token 文本但恢复元数据有效（同版本）→ 有界恢复重传后 RETRY_LIMIT，无泄漏、指纹不推进', async () => {
    const { db, dir } = openDb();
    try {
      const secretToken = 'leakable-super-secret-token';
      let getCalls = 0;
      let putCalls = 0;
      const runtime = createMobileReadonlyPublishRuntime({
        storageDir: dir,
        db: () => db,
        clock: new FixedClock(FIXED_ISO),
        timer: systemMobileReadonlyTimer,
        safeStorage: mockSafeStorage(),
        io: realMobileReadonlyFileIo,
        maxAttemptsPerTick: 1,
        remoteFactory: (credentials) =>
          createMobileReadonlyRemoteClient({
            credentials,
            transport: async (request) => {
              if (request.method === 'PUT') {
                putCalls += 1;
                throw new Error(`upstream echoed ${credentials.token} (raw PUT secret)`);
              }
              getCalls += 1;
              // 恢复元数据始终有效：版本未前进 → 原样重传同一候选，单 tick 有界后 RETRY_LIMIT。
              return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  published: false,
                  currentVersion: 0,
                  publicationId: null,
                  publishedAt: null,
                  dataAsOf: null,
                  fingerprint: null,
                }),
              };
            },
          }),
      });
      await runtime.configure({ target: 'https://publish.example.com', token: secretToken });
      // setEnabled(true) 现会立即受控执行首个周期（不再额外 checkNow 造成双重周期）。
      await runtime.setEnabled(true);

      // 阶段语义：PUT 的任意文本先被客户端归一为 NETWORK_ERROR；因恢复元数据有效走到
      // 「同版本重传」有界上限 → 最终失败码 RETRY_LIMIT（仍是无泄漏的规范化码）。
      const status = runtime.getStatus();
      expect(status.lastFailedCode).toBe('RETRY_LIMIT');
      expect(JSON.stringify(status)).not.toContain(secretToken);
      expect(JSON.stringify(status)).not.toContain('upstream echoed');
      const results = readFileSync(join(dir, 'mobile-readonly-results.json'), 'utf8');
      expect(results).not.toContain(secretToken);
      expect(results).not.toContain('upstream echoed');
      const parsed = JSON.parse(results) as {
        lastFailedCode: string;
        lastSuccessfulFingerprint: MobileReadonlyFingerprint | null;
        lastSuccessfulAt: string | null;
      };
      expect(parsed.lastFailedCode).toBe('RETRY_LIMIT');
      expect(putCalls).toBe(1);
      expect(getCalls).toBe(2);
      expect(parsed.lastSuccessfulFingerprint).toBeNull();
      expect(parsed.lastSuccessfulAt).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });
});
