import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/core/errors';
import {
  assertExactBusinessDate,
  assertExactCentsString,
  assertIsoDateTime,
  assertNullableIsoDateTime,
  assertRemoteId,
  toBusinessDate,
  toCount,
  toEnum,
  toExactMoney,
  toIso,
  toNullableBusinessDate,
  toNullableExactMoney,
  toNullableIso,
  toOptionalText,
  toRequiredText,
} from '../../src/shared/remote-readonly/values';
import {
  UnknownFieldRejection,
  REJECTION_CONTEXTS,
  rejectionField,
} from '../../src/shared/remote-readonly/rejection';
import {
  parseRemoteProjectionManifest,
  CANONICAL_EMPTY_SETTINGS_DIGEST,
  PROJECTION_ENTITY_TYPES,
} from '../../src/shared/remote-readonly/manifest';
import { syntheticManifest } from './fixtures/synthetic-snapshot';

/**
 * contract-scalars 契约标量测试：
 * - 错误对象所有可序列化属性（message/name/code）metadata-only，未知键与业务值
 *   （含攻击者 canary）绝不进入 message 或其他公开属性；
 * - 业务日期/ISO 时间必须是真实存在的值（形状+实存），null 与 '' 语义严格区分；
 * - 计数/修订为安全整数；Unicode 长度按码点；金额为有界精确两位小数；
 * - manifest 谱系 UUID / approvedSettingsDigest / 计数严格。
 */

const CANARY_KEY = '未知键"注入\u0000ACME';
const CANARY_VALUE = '业务值>客户名称<Σ 秘密';
const CANARY_UUID = `${CANARY_VALUE}::11111111-1111-4111-8111-111111111111`;

/** 收集错误的所有可序列化公开属性文本。 */
function serializedErrorText(fn: () => unknown): { code: string; all: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) {
      const asAny = err as unknown as Record<string, unknown>;
      const parts: string[] = [err.message];
      if (typeof err.name === 'string') parts.push(err.name);
      if (typeof err.code === 'string') parts.push(err.code);
      for (const [k, v] of Object.entries(asAny)) {
        if (k === 'stack') continue;
        if (typeof v === 'string') parts.push(v);
        else if (v && typeof v === 'object') parts.push(JSON.stringify(v));
      }
      return { code: err.code, all: parts.join('|') };
    }
    throw err;
  }
  throw new Error('expected DomainError');
}

describe('错误对象 metadata-only：未知键/攻击者 canary 不进入任何公开属性', () => {
  it('rejectionField 忽略不可信 field；UnknownFieldRejection 的 message 与 ref 只含受控上下文', () => {
    const ref = rejectionField('manifest.entityCounts', CANARY_KEY);
    expect(ref.context).toBe('manifest.entityCounts');
    expect('field' in ref).toBe(false);
    expect('kind' in ref).toBe(false);
    expect(JSON.stringify(ref)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(ref)).not.toContain(CANARY_VALUE);

    const err = new UnknownFieldRejection(ref);
    expect(err.code).toBe('UNKNOWN_FIELD');
    expect(err.message).toContain('manifest.entityCounts');
    expect(err.message).not.toContain(CANARY_KEY);
    expect(err.message).not.toContain(CANARY_VALUE);
    // 公开属性 name 与 code 也不含 canary
    expect(serializedErrorText(() => {
      throw err;
    }).all).not.toContain(CANARY_KEY);
    expect(serializedErrorText(() => {
      throw err;
    }).all).not.toContain(CANARY_VALUE);
  });

  it('manifest 解析：未知键 message 不含攻击者键/值；允许的未知上下文保守回退且不泄漏', () => {
    const manifest = syntheticManifest() as unknown as Record<string, unknown>;
    manifest[CANARY_KEY] = CANARY_VALUE;
    const { all } = serializedErrorText(() => parseRemoteProjectionManifest(manifest));
    expect(all).not.toContain(CANARY_KEY);
    expect(all).not.toContain(CANARY_VALUE);
    // 未知键走 UnknownFieldRejection（UNKNOWN_FIELD）而非业务值消息
    expect(all).toContain('UNKNOWN_FIELD');

    // 未知上下文 fallback 到 'query'，不携带未知上下文原文
    const badCtx = rejectionField(`manifest.${CANARY_KEY}`, 'x');
    expect(badCtx.context).toBe('query');
    expect(JSON.stringify(badCtx)).not.toContain(CANARY_KEY);
  });

  it('rejectionField 只接受受控上下文 allowlist', () => {
    for (const ctx of REJECTION_CONTEXTS) {
      expect(rejectionField(ctx, 'whatever').context).toBe(ctx);
    }
    // 不受控上下文一律回落，不携带任意字符串
    expect(rejectionField('projectx', 'y').context).toBe('query');
    expect(rejectionField('', '').context).toBe('query');
  });
});

describe('values：真实日期/时间校验（形状+实存）与 null vs 空串语义', () => {
  it('业务日期必须 yyyy-mm-dd 真实日历日期', () => {
    expect(assertExactBusinessDate('2026-08-10', 'f')).toBe('2026-08-10');
    expect(() => assertExactBusinessDate('2026-02-30', 'f')).toThrow(/不是真实业务日期/);
    expect(() => assertExactBusinessDate('2026-13-01', 'f')).toThrow(/不是真实业务日期/);
    expect(() => assertExactBusinessDate('2026-8-1', 'f')).toThrow(/不是真实业务日期/);
    expect(() => assertExactBusinessDate('', 'f')).toThrow(/必填/);
  });

  it('ISO 技术时间：形状匹配但实存非法（24:00/60 分/60 秒/2026-02-30）拒绝', () => {
    // 合法
    expect(assertIsoDateTime('2026-08-10T09:30:00+08:00', 'f')).toBe('2026-08-10T09:30:00+08:00');
    expect(assertIsoDateTime('2026-08-10T01:30:00Z', 'f')).toBe('2026-08-10T01:30:00Z');
    expect(assertIsoDateTime('2026-08-10T01:30:00.123-04:00', 'f')).toBe('2026-08-10T01:30:00.123-04:00');
    // 形状匹配但非法
    for (const bad of [
      '2026-08-10T24:00:00Z',
      '2026-08-10T23:60:00Z',
      '2026-08-10T23:59:60Z',
      '2026-08-10T10:00:00+24:00',
      '2026-02-30T09:00:00+08:00',
    ]) {
      expect(() => assertIsoDateTime(bad, 'f')).toThrow(/格式非法/);
    }
    // 无偏移本地时间拒绝
    expect(() => assertIsoDateTime('2026-08-10T09:30:00', 'f')).toThrow(/格式非法/);
    // 空/类型非法
    expect(() => assertIsoDateTime('', 'f')).toThrow(/必填/);
    expect(() => assertIsoDateTime(null, 'f')).toThrow(/必填/);
    expect(() => assertIsoDateTime(123 as unknown as string, 'f')).toThrow(/格式非法/);
  });

  it('可空 ISO/日期/文本：null/undefined → null；空串拒绝而非静默归一', () => {
    // 可空业务日期：'' 拒绝（wire 必须用 null 表示未填写）
    expect(() => toNullableBusinessDate('', 'f')).toThrow(/必填/);
    expect(toNullableBusinessDate(null, 'f')).toBeNull();
    expect(() => toNullableBusinessDate('2026-02-30', 'f')).toThrow(/不是真实业务日期/);
    // 可空 ISO：'' 拒绝
    expect(() => toNullableIso('', 'f')).toThrow(/格式非法|必填/);
    expect(toNullableIso(null, 'f')).toBeNull();
    expect(() => toNullableIso('2026-08-10T24:00:00Z', 'f')).toThrow(/格式非法/);
    // assertNullableIsoDateTime：null → null；'' 拒绝
    expect(assertNullableIsoDateTime(null, 'f')).toBeNull();
    expect(assertNullableIsoDateTime(undefined, 'f')).toBeNull();
    expect(() => assertNullableIsoDateTime('', 'f')).toThrow(/必填/);
    // 可空文本：'' → null（既有语义），但非法类型拒绝
    expect(toOptionalText('', 'f')).toBeNull();
    expect(toOptionalText(null, 'f')).toBeNull();
    expect(() => toOptionalText(7, 'f')).toThrow(/必须是文本/);
  });

  it('必填日期/ISO：空串拒绝，不视为 null', () => {
    expect(() => toBusinessDate('', 'f')).toThrow(/必填/);
    expect(() => toIso('', 'f')).toThrow(/必填/);
    expect(() => toIso(null, 'f')).toThrow(/必填/);
  });
});

describe('values：精确金额、计数与 Unicode 边界', () => {
  it('金额为精确两位小数；禁止 Number/强转/截断；消息不含字段值', () => {
    expect(toExactMoney('0.00', 'f')).toBe('0.00');
    expect(toExactMoney('1234.57', 'f')).toBe('1234.57');
    expect(() => toExactMoney('1234.5', 'f')).toThrow(/精确两位小数/);
    expect(() => toExactMoney('1234', 'f')).toThrow(/精确两位小数/);
    expect(() => toExactMoney('1e3', 'f')).toThrow(/精确两位小数/);
    expect(() => toExactMoney(-1 as unknown as string, 'f')).toThrow(/精确两位小数/);
    expect(() => toExactMoney('', 'f')).toThrow(/必填/);
    expect(() => toNullableExactMoney('', 'f')).toThrow(/必填/);
    expect(toNullableExactMoney(null, 'f')).toBeNull();
    expect(() => toNullableExactMoney('12.345', 'f')).toThrow(/精确两位小数/);
    // 消息不携带被拒绝的值
    const { all } = serializedErrorText(() => toExactMoney('1234567.890', 'f'));
    expect(all).not.toContain('1234567.890');
  });

  it('计数/数字必须安全整数：超出 Number.MAX_SAFE_INTEGER 拒绝（不能携带不可信数字进消息）', () => {
    expect(toCount(0, 'f')).toBe(0);
    expect(toCount(100000, 'f')).toBe(100000);
    expect(toCount(Number.MAX_SAFE_INTEGER, 'f')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => toCount(Number.MAX_SAFE_INTEGER + 1, 'f')).toThrow(/安全整数/);
    expect(() => toCount(1.5, 'f')).toThrow(/安全整数/);
    expect(() => toCount(-1, 'f')).toThrow(/安全整数/);
    expect(() => toCount('3' as unknown as number, 'f')).toThrow(/安全整数/);
    expect(() => toCount(Number.NaN, 'f')).toThrow(/安全整数/);
  });

  it('Unicode 长度按码点（代理对计 1）；超出 4096 拒绝', () => {
    const emoji = '😀'; // 1 码点，2 UTF-16 单元
    expect(toRequiredText(emoji.repeat(4096), 'f')).toBe(emoji.repeat(4096));
    expect(() => toRequiredText(emoji.repeat(4097), 'f')).toThrow(/长度上限/);
    // 4096 个 emoji 在 UTF-16 长度 8192 但码点 4096 → 通过
    expect(assertExactCentsString('1234.57', 'f')).toBe('1234.57');
    expect(() => toRequiredText('x'.repeat(4097), 'f')).toThrow(/长度上限/);
  });

  it('金额码点长度边界：整串 ≤4096 码点（最多 4093 位整数 + .00）', () => {
    const atBound = `${'9'.repeat(4093)}.00`;
    expect([...atBound].length).toBe(4096);
    expect(() => assertExactCentsString(atBound, 'f')).not.toThrow();
    const overBound = `${'9'.repeat(4094)}.00`;
    expect([...overBound].length).toBe(4097);
    expect(() => assertExactCentsString(overBound, 'f')).toThrow(/精确两位小数/);
    // toExactMoney 同样拒绝超长
    expect(() => toExactMoney(overBound, 'f')).toThrow(/精确两位小数/);
  });

  it('assertRemoteId / 枚举：类型与长度严格；消息不含输入', () => {
    expect(assertRemoteId('ab-cd', 'f')).toBe('ab-cd');
    expect(assertRemoteId('', 'f')).toBeNull();
    expect(() => assertRemoteId('x'.repeat(129), 'f')).toThrow(/长度上限/);
    const { all } = serializedErrorText(() => assertRemoteId('客户名称😀'.repeat(40), 'f'));
    expect(all).not.toContain('客户名称');
    expect(toEnum('a', ['a', 'b'], 'f')).toBe('a');
    expect(() => toEnum('c', ['a', 'b'], 'f')).toThrow(/枚举值不允许/);
  });
});

describe('manifest 严格标量', () => {
  it('谱系 UUID 必须是 UUID；业务值/攻击者字符串不能作为 UUID 携带', () => {
    const base = syntheticManifest();
    // 合法（含大写 → 规范小写）
    const ok = parseRemoteProjectionManifest({ ...base, databaseInstanceId: 'ABCDEF12-3456-4ABC-8DEF-1234567890AB' });
    expect(ok.databaseInstanceId).toBe('abcdef12-3456-4abc-8def-1234567890ab');
    // 非法：业务值、脏 UUID、null
    for (const bad of [CANARY_UUID, 'not-a-uuid', 'db-1', 123, null, undefined, '']) {
      const m = { ...base, databaseInstanceId: bad };
      expect(() => parseRemoteProjectionManifest(m)).toThrow(/databaseInstanceId 必须是 UUID/);
    }
    for (const bad of [CANARY_UUID, 'gen-a', '', null]) {
      const m = { ...base, contentGenerationId: bad };
      expect(() => parseRemoteProjectionManifest(m)).toThrow(/contentGenerationId 必须是 UUID/);
    }
    // UUID 错误消息不携带被拒绝值
    const { all } = serializedErrorText(() => parseRemoteProjectionManifest({ ...base, databaseInstanceId: CANARY_UUID }));
    expect(all).not.toContain(CANARY_VALUE);
  });

  it('approvedSettingsDigest 必须是 64 位小写 hex 或 canonical empty；业务文本拒绝', () => {
    const base = syntheticManifest();
    expect(parseRemoteProjectionManifest({ ...base, approvedSettingsDigest: CANONICAL_EMPTY_SETTINGS_DIGEST }).approvedSettingsDigest).toBe(CANONICAL_EMPTY_SETTINGS_DIGEST);
    expect(parseRemoteProjectionManifest({ ...base, approvedSettingsDigest: 'a'.repeat(64) }).approvedSettingsDigest).toBe('a'.repeat(64));
    for (const bad of [CANARY_VALUE, '客户名称', 'A'.repeat(64), 'nothex', '', null, undefined]) {
      expect(() => parseRemoteProjectionManifest({ ...base, approvedSettingsDigest: bad })).toThrow(/approvedSettingsDigest 必须是 64 位小写十六进制/);
    }
    const { all } = serializedErrorText(() => parseRemoteProjectionManifest({ ...base, approvedSettingsDigest: CANARY_VALUE }));
    expect(all).not.toContain(CANARY_VALUE);
  });

  it('businessRevision / entityCounts 必须安全整数（不得出现不可信计数/超出 2^53）', () => {
    const base = syntheticManifest();
    expect(parseRemoteProjectionManifest({ ...base, businessRevision: 0 }).businessRevision).toBe(0);
    expect(parseRemoteProjectionManifest({ ...base, businessRevision: Number.MAX_SAFE_INTEGER }).businessRevision).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '5', null]) {
      expect(() => parseRemoteProjectionManifest({ ...base, businessRevision: bad })).toThrow(/businessRevision 必须是非负安全整数/);
    }
    for (const type of PROJECTION_ENTITY_TYPES) {
      const counts = { projects: 0, batches: 0, instruments: 0, orders: 0, invoices: 0, damageItems: 0, [type]: Number.MAX_SAFE_INTEGER + 1 };
      expect(() => parseRemoteProjectionManifest({ ...base, entityCounts: counts })).toThrow(/安全整数/);
    }
    expect(() => parseRemoteProjectionManifest({ ...base, entityCounts: { ...base.entityCounts, projects: -1 } })).toThrow(/安全整数/);
  });

  it('generatedAt 与 businessDate 走严格时间/日期（实存校验）；未知计数键拒绝', () => {
    const base = syntheticManifest();
    expect(() => parseRemoteProjectionManifest({ ...base, generatedAt: '2026-08-10T24:00:00Z' })).toThrow(/格式非法/);
    expect(() => parseRemoteProjectionManifest({ ...base, generatedAt: '2026-08-10T09:30:00' })).toThrow(/格式非法/);
    expect(() => parseRemoteProjectionManifest({ ...base, businessDate: '2026-02-30' })).toThrow(/业务日期/);
    const badCounts = { ...base.entityCounts, activities: 9 };
    expect(() => parseRemoteProjectionManifest({ ...base, entityCounts: badCounts })).toThrow(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
  });
});
