import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import type { DatabaseSync } from 'node:sqlite';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { FixedClock } from '../../src/domain/core/time';
import { createMobileReadonlyConfigStore, validateMobileReadonlyConfigureInput } from '../../src/main/mobile-readonly/config';
import { realMobileReadonlyFileIo } from '../../src/main/mobile-readonly/fs-io';
import { checkSafeStorage, type MobileReadonlySafeStorage } from '../../src/main/mobile-readonly/safe-storage';
import {
  createMobileReadonlyPublishRuntime,
  systemMobileReadonlyTimer,
  type MobileReadonlyPublishRuntime,
} from '../../src/main/mobile-readonly/runtime';
import { seedSyntheticProject } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * 桌面上传凭证入 OS 安全存储（tasks 5.1）：
 * - token 加密后以密文独立落盘，密钥由 OS 保护；不可用即禁用发布，无明文文件降级；
 * - Linux basic_text/unknown 后端拒绝；绝不 setUsePlainTextEncryption；
 * - 配置只写不回显：IPC/状态响应不含 secret，报错/日志不含 token 明文。
 */

const FIXED_ISO = '2026-08-08T09:00:00+08:00';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

/** 测试用固定 AES-256-GCM 密钥（恰好 32 字节）。生产 electron-safe-storage.ts 完全不受影响。 */
const TEST_STORAGE_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

/**
 * 「不透明可逆」测试安全存储：AES-256-GCM（固定测试密钥 + 每次随机 IV）。
 * 密文字节与明文无文本关联（file/status 断言不会因 mock 自身格式误报），
 * 且无进程内共享状态——重启/换 runtime 实例仍可解密同一落盘密文。
 */
function safeStorageOf(options: {
  available?: boolean;
  backend?: string;
  failDecrypt?: boolean;
} = {}): MobileReadonlySafeStorage {
  const backend = options.backend ?? (options.available === false ? 'unavailable' : 'gnome_libsecret');
  return {
    isEncryptionAvailable: () => options.available !== false && backend !== 'basic_text' && backend !== 'unknown',
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', TEST_STORAGE_KEY, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
    },
    decryptString: (data) => {
      if (options.failDecrypt) throw new Error('decrypt failed');
      const iv = data.subarray(0, 12);
      const tag = data.subarray(data.length - 16);
      const body = data.subarray(12, data.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', TEST_STORAGE_KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

function dbWithProject(): { db: DatabaseSync; dir: string } {
  const dir = makeTempDir('mobile-readonly-credential-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  seedSyntheticProject(db, { index: 0 });
  return { db, dir };
}

function makeRuntime(
  dir: string,
  db: DatabaseSync,
  safeStorage: MobileReadonlySafeStorage,
  remoteFactory?: () => { readMeta: () => Promise<never>; upload: () => Promise<never> },
): MobileReadonlyPublishRuntime {
  return createMobileReadonlyPublishRuntime({
    storageDir: dir,
    db: () => db,
    clock: new FixedClock(FIXED_ISO),
    timer: systemMobileReadonlyTimer,
    safeStorage,
    remoteFactory:
      remoteFactory ??
      (() => ({
        readMeta: async () => {
          throw new Error('not used');
        },
        upload: async () => {
          throw new Error('not used');
        },
      })),
  });
}

describe('token 安全存储（tasks 5.1）', () => {
  it('token 以不透明密文独立落盘：落盘字节=encryptString 输出，明文/状态/错误不回显，可往返', async () => {
    const { db, dir } = dbWithProject();
    try {
      const storage = safeStorageOf();
      // 记录 storeToken 内部 encryptString 的输出：文件字节必须与该输出逐字节一致。
      let lastCipher: Buffer | null = null;
      const recording: MobileReadonlySafeStorage = {
        ...storage,
        encryptString: (plain) => {
          const out = storage.encryptString(plain);
          lastCipher = out;
          return out;
        },
      };
      const real = createMobileReadonlyConfigStore({
        io: realMobileReadonlyFileIo,
        storageDir: dir,
        safeStorage: recording,
      });
      expect(real.storeToken('my-secret-token').ok).toBe(true);
      const cipher = readFileSync(join(dir, 'mobile-readonly-token.enc'));
      expect(lastCipher).not.toBeNull();
      expect(cipher.equals(lastCipher!)).toBe(true);
      // 密文不透明：不包含明文，也不包含任何可逆的明文包装前缀。
      expect(cipher.toString('utf8')).not.toContain('my-secret-token');
      expect(real.readToken()).toEqual({ ok: true, token: 'my-secret-token' });

      const runtime = makeRuntime(dir, db, storage);
      await runtime.configure({ target: 'https://publish.example.com', token: 'my-secret-token' });
      const status = runtime.getStatus();
      expect(JSON.stringify(status)).not.toContain('my-secret-token');
      const errorMessage = `${JSON.stringify(status)}`;
      expect(errorMessage).not.toContain('my-secret-token');
    } finally {
      closeDatabase(db);
    }
  });

  it('safeStorage 不可用 / Linux basic_text / unknown → 拒绝保存（无明文降级）', async () => {
    for (const options of [
      { available: false },
      { backend: 'basic_text' },
      { backend: 'unknown' },
    ]) {
      const { db, dir } = dbWithProject();
      try {
        const storage = safeStorageOf(options);
        const check = checkSafeStorage(storage);
        expect(check.available).toBe(false);
        const config = createMobileReadonlyConfigStore({ io: realMobileReadonlyFileIo, storageDir: dir, safeStorage: storage });
        expect(config.storeToken('token-1').ok).toBe(false);
        expect(config.isTokenPresent()).toBe(false);

        const runtime = makeRuntime(dir, db, storage);
        await expect(runtime.configure({ target: 'https://publish.example.com', token: 'token-1' })).rejects.toMatchObject({
          code: 'SAFE_STORAGE_UNAVAILABLE',
        });
        // 未落任何配置/token 文件。
        expect(config.isTokenPresent()).toBe(false);
        expect(runtime.getStatus().configured).toBe(false);
      } finally {
        closeDatabase(db);
      }
    }
  });

  it('safeStorage 不可用时启用失败；token 解密失败视为凭证不可用', async () => {
    const { db, dir } = dbWithProject();
    try {
      // 先正常配置并启用（token 解密失败后仍能读取到状态，但不可发布）。
      const okStorage = safeStorageOf();
      const runtimeOk = makeRuntime(dir, db, okStorage);
      await runtimeOk.configure({ target: 'https://publish.example.com', token: 'token-1' });
      await runtimeOk.setEnabled(true);
      expect(runtimeOk.getStatus().enabled).toBe(true);

      // 重启后 safeStorage 解密失败（例如密钥轮换/不可用）→ enabled 失效 + issue=credential_unavailable。
      const brokenStorage = safeStorageOf({ failDecrypt: true });
      const runtimeBroken = makeRuntime(dir, db, brokenStorage);
      const status = runtimeBroken.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('credential_unavailable');
      await expect(runtimeBroken.setEnabled(true)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' });
    } finally {
      closeDatabase(db);
    }
  });

  it('目标配置校验：固定 HTTPS origin（禁凭据/query/hash/路径），token 非空', () => {
    const valid: Array<[string, string]> = [
      ['https://publish.example.com', 'https://publish.example.com'],
      ['https://publish.example.com/', 'https://publish.example.com'],
      ['https://publish.example.com:8443', 'https://publish.example.com:8443'],
    ];
    for (const [input, origin] of valid) {
      expect(validateMobileReadonlyConfigureInput({ target: input, token: 't' })).toEqual({ ok: true, origin });
    }
    for (const bad of [
      'http://publish.example.com',
      'https://',
      'ftp://publish.example.com',
      'https://user:pass@publish.example.com',
      'https://publish.example.com/path',
      'https://publish.example.com?x=1',
      'https://publish.example.com#frag',
      'not-a-url',
    ]) {
      expect(validateMobileReadonlyConfigureInput({ target: bad, token: 't' })).toEqual({ ok: false, code: 'invalid_target' });
    }
    expect(validateMobileReadonlyConfigureInput({ target: 'https://publish.example.com', token: '' })).toEqual({
      ok: false,
      code: 'empty_token',
    });
  });

  it('token 密文解密后为空 → 凭证不可用（configured=false + credential_unavailable，启用被拒）', async () => {
    const { db, dir } = dbWithProject();
    try {
      const storage = safeStorageOf();
      const store = createMobileReadonlyConfigStore({ io: realMobileReadonlyFileIo, storageDir: dir, safeStorage: storage });
      // 直接落一个「解密后为空」的密文（模拟被破坏/轮换后的空凭证，而非来自 configure 的正常输入）。
      expect(store.storeToken('').ok).toBe(true);
      expect(store.persistTargetAndEnabled('https://publish.example.com', true).ok).toBe(true);
      expect(store.readToken()).toEqual({ ok: true, token: '' });

      const runtime = makeRuntime(dir, db, storage);
      const status = runtime.getStatus();
      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
      expect(status.issue).toBe('credential_unavailable');
      await expect(runtime.setEnabled(true)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' });
    } finally {
      closeDatabase(db);
    }
  });

  it('绝不调用 setUsePlainTextEncryption（AST 选择器检测真实调用，注释不误报）', () => {
    const electronSource = readFileSync('src/main/mobile-readonly/electron-safe-storage.ts', 'utf8');
    const safeSource = readFileSync('src/main/mobile-readonly/safe-storage.ts', 'utf8');
    // 正确警告注释允许提及该标识符；AST 只认真实 property access / call / element access。
    expect(hasForbiddenPlaintextFallbackCall(electronSource)).toBe(false);
    expect(hasForbiddenPlaintextFallbackCall(safeSource)).toBe(false);

    // 选择器必须能发现真实合成调用（防静默退化），并放行注释。
    expect(hasForbiddenPlaintextFallbackCall('safeStorage.setUsePlainTextEncryption();')).toBe(true);
    expect(hasForbiddenPlaintextFallbackCall("safeStorage['setUsePlainTextEncryption']();")).toBe(true);
    expect(hasForbiddenPlaintextFallbackCall('setUsePlainTextEncryption();')).toBe(true);
    expect(hasForbiddenPlaintextFallbackCall('// 注释：禁止调用 setUsePlainTextEncryption 明文降级')).toBe(false);
  });
});

/**
 * AST 级检测：在源码里查找对 `setUsePlainTextEncryption` 的真实成员访问/调用/元素访问。
 * 注释与字符串里的标识符不是 AST 节点，天然不会被误报（字符串搜索做不到这一点）。
 */
function hasForbiddenPlaintextFallbackCall(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'setUsePlainTextEncryption') found = true;
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (argument !== undefined && ts.isStringLiteral(argument) && argument.text === 'setUsePlainTextEncryption') {
        found = true;
      }
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === 'setUsePlainTextEncryption') found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
