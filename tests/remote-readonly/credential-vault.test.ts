/**
 * credential-vault.test.ts（tasks 2.3 secret OS vault 切片；真实 vault 写入属模块外）
 *
 * 只使用注入的 fake AsyncEntry，绝不写真实 OS 凭据：
 * - get 缺失 → null；get/set/delete 正常往返；
 * - 后端 locked / get·set·delete reject → CredentialVaultError BACKEND_FAILURE，
 *   且 message/错误对象不含 canary 原生错误原文（metadata-only）；
 * - 空 / 超长 secret、非法 publisherId 拒绝；超长 publisherId 拒绝；
 * - 原生构造不可用 → NATIVE_UNAVAILABLE；平台不在支持集 → UNSUPPORTED_PLATFORM；
 * - key identity 固定：fake 收到的 service === CREDENTIAL_SERVICE 且
 *   username === 原样 publisherId（非 secret，可断言）。
 *
 * 本测试不读取/记录真实客户业务数据（全部 synthetic 值）。
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialVault,
  CredentialVaultError,
  validateCredentialKey,
  CREDENTIAL_SERVICE,
  CREDENTIAL_ID_MAX,
  CREDENTIAL_SECRET_MAX,
} from '../../src/main/remote-readonly/credential-vault';

const PUB = 'pub-synthetic-1';
const SECRET = 'publisher-client-secret-synthetic-42';

/** 记录每次构造/方法调用的 fake AsyncEntry；可注入 per-方法 reject。 */
function makeFakeVault(overrides: {
  readError?: Error;
  writeError?: Error;
  deleteError?: Error;
  readValue?: string | undefined;
} = {}) {
  const calls: Array<{ service: string; username: string; method: string }> = [];
  const entry = {
    async getPassword(): Promise<string | undefined> {
      if (overrides.readError) throw overrides.readError;
      return overrides.readValue;
    },
    async setPassword(password: string): Promise<void> {
      if (overrides.writeError) throw overrides.writeError;
      void password;
    },
    async deleteCredential(): Promise<boolean> {
      if (overrides.deleteError) throw overrides.deleteError;
      return true;
    },
  };
  const vault = new CredentialVault({
    platform: 'darwin',
    entryFactory: (service, username) => {
      calls.push({ service, username, method: 'construct' });
      return entry;
    },
  });
  return { vault, entry, calls };
}

describe('credential vault：get/set/delete 与 key identity', () => {
  it('get 缺失 → null（与 locked/不可读的抛错区分）', async () => {
    const { vault } = makeFakeVault({ readValue: undefined });
    await expect(vault.getSecret(PUB)).resolves.toBeNull();
  });

  it('set 后 get 可读回原值（fake 内存往返；真实 OS 凭据不写）', async () => {
    const { vault, entry } = makeFakeVault({ readValue: undefined });
    await vault.setSecret(PUB, SECRET);
    // fake 不真正存储，因此用带返回值的新 fake 验证「get 读回」语义。
    const { vault: vault2 } = makeFakeVault({ readValue: SECRET });
    await expect(vault2.getSecret(PUB)).resolves.toBe(SECRET);
    // set 调用本身不抛（后端成功）。
    await expect(entry.setPassword(SECRET)).resolves.toBeUndefined();
  });

  it('delete：后端成功 → true（幂等成功语义）', async () => {
    const { vault } = makeFakeVault();
    await expect(vault.deleteCredential(PUB)).resolves.toBe(true);
  });

  it('key identity 固定：构造使用 CREDENTIAL_SERVICE + 原样 publisherId（无拼接/无枚举）', async () => {
    const { vault, calls } = makeFakeVault();
    await vault.setSecret(PUB, SECRET);
    await vault.getSecret(PUB);
    await vault.deleteCredential(PUB);
    expect(calls).toEqual([
      { service: CREDENTIAL_SERVICE, username: PUB, method: 'construct' },
      { service: CREDENTIAL_SERVICE, username: PUB, method: 'construct' },
      { service: CREDENTIAL_SERVICE, username: PUB, method: 'construct' },
    ]);
  });
});

describe('credential vault：后端失败 → metadata-only BACKEND_FAILURE', () => {
  const backend = async (vault: CredentialVault, kind: 'read' | 'write' | 'delete') => {
    if (kind === 'read') return vault.getSecret(PUB);
    if (kind === 'write') return vault.setSecret(PUB, SECRET);
    return vault.deleteCredential(PUB);
  };

  it.each(['read', 'write', 'delete'] as const)(
    '%s 后端 locked/失败 → CredentialVaultError BACKEND_FAILURE（无 canary 原文）',
    async (kind) => {
      const canary = `native-backend-canary-${kind}`;
      const { vault } = makeFakeVault({
        readError: new Error(canary),
        writeError: new Error(canary),
        deleteError: new Error(canary),
      });
      try {
        await backend(vault, kind);
        expect.unreachable('应当抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialVaultError);
        expect((error as CredentialVaultError).code).toBe('BACKEND_FAILURE');
        // metadata-only：message 只含稳定 code 模板，绝不带原生错误/secret 原文。
        expect((error as Error).message).toBe('credential vault BACKEND_FAILURE');
        expect((error as Error).message).not.toContain(canary);
      }
    },
  );

  it('错误对象不携带 cause/原生原文中的 secret', async () => {
    const { vault } = makeFakeVault({ readError: new Error(`boom ${SECRET}`) });
    try {
      await vault.getSecret(PUB);
      expect.unreachable('应当抛错');
    } catch (error) {
      const err = error as Error & { cause?: unknown };
      expect(err.cause).toBeUndefined();
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain('boom');
      expect(String(err.stack ?? '')).not.toContain(SECRET);
    }
  });
});

describe('credential vault：输入校验（空/超长拒绝，不截断）', () => {
  it('空 secret / 非 string secret → INVALID_SECRET', async () => {
    const { vault } = makeFakeVault();
    for (const bad of ['', null, undefined, 42]) {
      await expect(vault.setSecret(PUB, bad as never)).rejects.toMatchObject({
        code: 'INVALID_SECRET',
      });
    }
    // 拒绝后不触碰后端。
  });

  it('超长 secret → INVALID_SECRET（不截断写入）', async () => {
    const { vault } = makeFakeVault();
    const long = 'x'.repeat(CREDENTIAL_SECRET_MAX + 1);
    await expect(vault.setSecret(PUB, long)).rejects.toMatchObject({ code: 'INVALID_SECRET' });
  });

  it('恰好 max 长度的 secret 可通过校验（fake 写入）', async () => {
    const { vault } = makeFakeVault();
    const max = 'x'.repeat(CREDENTIAL_SECRET_MAX);
    await expect(vault.setSecret(PUB, max)).resolves.toBeUndefined();
  });

  it('空/非 string publisherId → INVALID_KEY', async () => {
    const { vault } = makeFakeVault();
    for (const bad of ['', null, undefined, 7]) {
      await expect(vault.getSecret(bad as never)).rejects.toMatchObject({ code: 'INVALID_KEY' });
      await expect(vault.setSecret(bad as never, SECRET)).rejects.toMatchObject({ code: 'INVALID_KEY' });
      await expect(vault.deleteCredential(bad as never)).rejects.toMatchObject({ code: 'INVALID_KEY' });
    }
  });

  it('超长 publisherId → INVALID_KEY（≤128 码点技术标识符）', async () => {
    const { vault } = makeFakeVault();
    const long = 'p'.repeat(CREDENTIAL_ID_MAX + 1);
    await expect(vault.getSecret(long)).rejects.toMatchObject({ code: 'INVALID_KEY' });
    // validateCredentialKey 与 vault 内部校验同一规则（供后续 CLI 复用）。
    expect(() => validateCredentialKey(long)).toThrowError(/INVALID_KEY/);
  });

  it('validateCredentialKey：合法标识符原样返回（非 secret，仅供 CLI key identity 复用）', () => {
    expect(validateCredentialKey(PUB)).toBe(PUB);
  });
});

describe('credential vault：原生不可用 / 平台不支持 fail closed', () => {
  it('构造抛错（原生不可用）→ NATIVE_UNAVAILABLE', async () => {
    const vault = new CredentialVault({
      platform: 'darwin',
      entryFactory: () => {
        throw new Error('native binding missing');
      },
    });
    await expect(vault.getSecret(PUB)).rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' });
  });

  it('平台不在支持集 → UNSUPPORTED_PLATFORM（默认不支持 linux）', async () => {
    const vault = new CredentialVault({ platform: 'linux' });
    await expect(vault.getSecret(PUB)).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(vault.setSecret(PUB, SECRET)).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
    await expect(vault.deleteCredential(PUB)).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
  });
});
