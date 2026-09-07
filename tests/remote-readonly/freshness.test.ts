import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/core/errors';
import { CANONICAL_EMPTY_SETTINGS_DIGEST } from '../../src/shared/remote-readonly/manifest';
import {
  approvedDisplaySettingsDigest,
  asiaShanghaiBusinessDate,
  buildSourceFingerprint,
  isCurrentFingerprint,
  sameSourceFingerprint,
  SHANGHAI_DATE_FORMAT,
  type BusinessRevision,
  type SourceFingerprintInput,
} from '../../src/remote-readonly/freshness/fingerprint';

/**
 * tasks 5.1 纯函数部分：源指纹构造、canonical 空摘要、确定性、无变化不重发判定，
 * 及严格输入（metadata-only 错误、拒绝非空设置/secret/业务值）。5.2~5.4 未在本文件。
 */

const LINEAGE = {
  databaseInstanceId: '11111111-1111-4111-8111-111111111111',
  contentGenerationId: '22222222-2222-4222-8222-222222222222',
};

function fp(overrides: Partial<SourceFingerprintInput> = {}): SourceFingerprintInput {
  return {
    lineage: LINEAGE,
    businessRevision: '42',
    businessDate: '2026-09-07',
    projectionVersion: 'v1',
    ...overrides,
  };
}

describe('5.1 源指纹构造与规范化', () => {
  it('同一输入构造结果确定性一致：canonical 与逐分量相等', () => {
    const a = buildSourceFingerprint(fp());
    const b = buildSourceFingerprint(fp());
    expect(sameSourceFingerprint(a, b)).toBe(true);
    expect(a.canonical).toBe(b.canonical);
    expect(a.businessRevision).toBe('42');
    expect(a.lineage).toEqual(LINEAGE);
    expect(a.businessDate).toBe('2026-09-07');
    expect(a.projectionVersion).toBe('v1');
  });

  it('canonical 编码分量有序且等号边界不丢失；空摘要为 shared 64 位 hex', () => {
    const f = buildSourceFingerprint(fp());
    expect(f.approvedSettingsDigest).toBe(CANONICAL_EMPTY_SETTINGS_DIGEST);
    expect(f.approvedSettingsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.canonical).toBe(
      [
        LINEAGE.databaseInstanceId,
        LINEAGE.contentGenerationId,
        '42',
        CANONICAL_EMPTY_SETTINGS_DIGEST,
        '2026-09-07',
        'v1',
      ].join('\u0000'),
    );
  });

  it('fingerprint 缺省 digest 与显式 canonical empty 一致；与显式 hex 不同', () => {
    const empty = buildSourceFingerprint(fp());
    const emptyExplicit = buildSourceFingerprint(
      fp({ approvedSettingsDigest: CANONICAL_EMPTY_SETTINGS_DIGEST }),
    );
    const hex = buildSourceFingerprint(fp({ approvedSettingsDigest: 'a'.repeat(64) }));
    expect(empty.canonical).toBe(emptyExplicit.canonical);
    expect(sameSourceFingerprint(empty, hex)).toBe(false);
  });

  it('指纹包含 lineage 二元组：databaseInstanceId 或 contentGenerationId 变化即不同', () => {
    const base = buildSourceFingerprint(fp());
    const otherDb = buildSourceFingerprint(
      fp({ lineage: { ...LINEAGE, databaseInstanceId: '33333333-3333-4333-8333-333333333333' } }),
    );
    const otherGen = buildSourceFingerprint(
      fp({ lineage: { ...LINEAGE, contentGenerationId: '44444444-4444-4444-8444-444444444444' } }),
    );
    expect(sameSourceFingerprint(base, otherDb)).toBe(false);
    expect(sameSourceFingerprint(base, otherGen)).toBe(false);
  });

  it('lineage 为谱系标识而非排序依据：真实 hex UUID 大写字面量规范为小写并等价', () => {
    const upper = buildSourceFingerprint(
      fp({
        lineage: {
          databaseInstanceId: 'ABCDEF12-3456-4ABC-8DEF-1234567890AB',
          contentGenerationId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    );
    expect(upper.lineage.databaseInstanceId).toBe('abcdef12-3456-4abc-8def-1234567890ab');
    const lower = buildSourceFingerprint(
      fp({
        lineage: {
          databaseInstanceId: 'abcdef12-3456-4abc-8def-1234567890ab',
          contentGenerationId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    );
    expect(upper.canonical).toBe(lower.canonical);
  });

  it('businessRevision 精确比较：同一 lineage 内 7 与 7 一致、与 8 不同', () => {
    const r7 = buildSourceFingerprint(fp({ businessRevision: 7 }));
    expect(sameSourceFingerprint(r7, buildSourceFingerprint(fp({ businessRevision: '7' })))).toBe(true);
    expect(sameSourceFingerprint(r7, buildSourceFingerprint(fp({ businessRevision: 8 })))).toBe(false);
  });

  it('businessRevision 精确语义：number 与 bigint 同值同指纹，超安全整数精确区分', () => {
    const asNum = buildSourceFingerprint(fp({ businessRevision: 9007199254740991 }));
    const asBig = buildSourceFingerprint(fp({ businessRevision: 9007199254740991n }));
    const beyond = buildSourceFingerprint(fp({ businessRevision: 9007199254740993n }));
    expect(sameSourceFingerprint(asNum, asBig)).toBe(true);
    expect(sameSourceFingerprint(asNum, beyond)).toBe(false);
  });

  it('businessDate 变化改变指纹（跨日即新指纹）', () => {
    expect(
      sameSourceFingerprint(
        buildSourceFingerprint(fp()),
        buildSourceFingerprint(fp({ businessDate: '2026-09-08' })),
      ),
    ).toBe(false);
  });

  it('projectionVersion 参与指纹', () => {
    expect(
      sameSourceFingerprint(
        buildSourceFingerprint(fp()),
        buildSourceFingerprint(fp({ projectionVersion: 'v2' })),
      ),
    ).toBe(false);
  });
});

describe('5.1 严格输入：错误 metadata-only（固定消息与代码，不携带任何输入值）', () => {
  /** 完整序列化错误消息（整条，不只正则匹配）。 */
  function entireMessage(fn: () => unknown): { code: string; message: string } {
    try {
      fn();
    } catch (err) {
      if (err instanceof ValidationError) {
        return { code: err.code, message: err.message };
      }
      throw err;
    }
    throw new Error('expected ValidationError');
  }

  it('非法非空 UUID/日期/版本/摘要/时刻：固定模板消息与稳定 code，不含非空 canary', () => {
    const canary = '项目-Σ秘密\u0000客户名';
    const cases: Array<[() => unknown, string, RegExp]> = [
      [
        () => buildSourceFingerprint(fp({ lineage: { ...LINEAGE, databaseInstanceId: canary } })),
        'INVALID_LINEAGE_UUID',
        /^databaseInstanceId 不合法$/,
      ],
      [
        () => buildSourceFingerprint(fp({ lineage: { ...LINEAGE, contentGenerationId: canary } })),
        'INVALID_LINEAGE_UUID',
        /^contentGenerationId 不合法$/,
      ],
      [() => buildSourceFingerprint(fp({ businessDate: canary })), 'INVALID_BUSINESS_DATE', /^businessDate 不合法$/],
      [() => buildSourceFingerprint(fp({ projectionVersion: canary })), 'INVALID_PROJECTION_VERSION', /^projectionVersion 不合法$/],
      [() => buildSourceFingerprint(fp({ approvedSettingsDigest: canary })), 'INVALID_SETTINGS_DIGEST', /^approvedSettingsDigest 不合法$/],
      [() => asiaShanghaiBusinessDate(canary), 'INVALID_INSTANT_ISO', /^instantIso 不合法$/],
    ];
    for (const [fn, code, re] of cases) {
      const { code: gotCode, message } = entireMessage(fn);
      expect(gotCode).toBe(code);
      expect(message).toMatch(re);
      expect(message).not.toContain(canary);
    }
  });

  it('非法非空 revision（负数/前导零/非十进制/超安全整数）：固定消息不含输入值', () => {
    const canary = '042';
    for (const v of [-1, '042', 'abc', 9007199254740993] as BusinessRevision[]) {
      const { code, message } = entireMessage(() => buildSourceFingerprint(fp({ businessRevision: v })));
      expect(code).toBe('INVALID_BUSINESS_REVISION');
      expect(message).toBe('businessRevision 不合法');
      expect(message).not.toContain(canary);
      expect(message).not.toContain(String(v));
    }
  });

  it('空/undefined 输入：固定 code 与消息（不依赖逐字插值断言）', () => {
    for (const [fn, code] of [
      [() => buildSourceFingerprint(fp({ businessRevision: '' })), 'INVALID_BUSINESS_REVISION'],
      [() => buildSourceFingerprint(fp({ businessDate: '' })), 'INVALID_BUSINESS_DATE'],
      [() => buildSourceFingerprint(fp({ projectionVersion: '' })), 'INVALID_PROJECTION_VERSION'],
      [() => asiaShanghaiBusinessDate(''), 'INVALID_INSTANT_ISO'],
    ] as Array<[() => unknown, string]>) {
      const { code: gotCode, message } = entireMessage(fn);
      expect(gotCode).toBe(code);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('businessDate 非法非空值（闰日/越界/自由文本）拒绝且消息不含输入', () => {
    for (const bad of ['2026-02-30', '2026-13-01', 'abc', '客户名']) {
      const { code, message } = entireMessage(() =>
        buildSourceFingerprint(fp({ businessDate: bad })),
      );
      expect(code).toBe('INVALID_BUSINESS_DATE');
      expect(message).toBe('businessDate 不合法');
      expect(message).not.toContain(bad);
    }
  });

  it('非字符串任意对象/null/undefined 输入不会因正则强制转换产生歧义或崩溃', () => {
    expect(() =>
      buildSourceFingerprint({ ...fp(), businessRevision: {} as unknown as BusinessRevision }),
    ).toThrow(ValidationError);
    expect(() =>
      buildSourceFingerprint({ ...fp(), businessRevision: null as unknown as BusinessRevision }),
    ).toThrow(ValidationError);
    expect(() => buildSourceFingerprint(fp({ businessDate: undefined as unknown as string }))).toThrow(
      ValidationError,
    );
    expect(() => buildSourceFingerprint(fp({ projectionVersion: undefined as unknown as string }))).toThrow(
      ValidationError,
    );
  });
});

describe('5.1 已批准设置白名单为空：拒绝一切非空设置，不发明未来设置', () => {
  it('空设置列表 → canonical empty（shared 64 位 hex），且与缺省等价', () => {
    expect(approvedDisplaySettingsDigest([])).toBe(CANONICAL_EMPTY_SETTINGS_DIGEST);
    const fpWith = buildSourceFingerprint(fp({ approvedSettingsDigest: approvedDisplaySettingsDigest([]) }));
    expect(fpWith.canonical).toBe(buildSourceFingerprint(fp()).canonical);
  });

  it('任意非空设置（含 secret、客户名、未知键）一律拒绝', () => {
    for (const settings of [
      [['secret', 'xxx']],
      [['customer', '某客户']],
      [['theme', 'green']],
      [['theme', '】\u0000']],
    ] as ReadonlyArray<readonly [string, string]>[]) {
      expect(() => approvedDisplaySettingsDigest(settings)).toThrow(ValidationError);
    }
  });

  it('设置拒绝消息不携带被拒绝的设置内容', () => {
    const canary = '某客户Σ';
    let code = '';
    let msg = '';
    try {
      approvedDisplaySettingsDigest([['customer', canary]]);
    } catch (err) {
      if (err instanceof ValidationError) {
        code = err.code;
        msg = err.message;
      }
    }
    expect(code).toBe('INVALID_SETTINGS');
    expect(msg).toBe('当前没有已批准的显示设置，不接受任何设置输入');
    expect(msg).not.toContain(canary);
  });
});

describe('5.1 Asia/Shanghai 业务时区 businessDate 边界', () => {
  it('UTC 日界与上海日界：UTC 16:00 正落在上海新一天起点', () => {
    expect(asiaShanghaiBusinessDate('2026-09-06T16:00:00Z')).toBe('2026-09-07');
    expect(asiaShanghaiBusinessDate('2026-09-06T15:59:59Z')).toBe('2026-09-06');
  });

  it('同一时刻的 Z / 正偏移 / 负偏移等价表达 → 同一上海业务日期（符号正确处理）', () => {
    // 2026-09-06T16:00:00Z = 2026-09-07T00:00:00+08:00 = 2026-09-06T12:00:00-04:00
    expect(asiaShanghaiBusinessDate('2026-09-06T16:00:00Z')).toBe('2026-09-07');
    expect(asiaShanghaiBusinessDate('2026-09-07T00:00:00+08:00')).toBe('2026-09-07');
    expect(asiaShanghaiBusinessDate('2026-09-06T12:00:00-04:00')).toBe('2026-09-07');
    // 负偏移落点：2026-09-07T08:00:00-04:00 = 12:00Z = 上海 20:00 同一天
    expect(asiaShanghaiBusinessDate('2026-09-07T08:00:00-04:00')).toBe('2026-09-07');
    expect(asiaShanghaiBusinessDate('2026-09-07T12:00:00Z')).toBe('2026-09-07');
  });

  it('闰日边界在 Z/正偏移间一致', () => {
    // 2024-02-29T16:00:00Z = 2024-03-01T00:00:00+08:00
    expect(asiaShanghaiBusinessDate('2024-02-29T16:00:00Z')).toBe('2024-03-01');
    expect(asiaShanghaiBusinessDate('2024-03-01T00:00:00+08:00')).toBe('2024-03-01');
    // 2024-02-29T15:59:59Z = 2024-02-29T23:59:59+08:00（仍是 02-29）
    expect(asiaShanghaiBusinessDate('2024-02-29T15:59:59Z')).toBe('2024-02-29');
    expect(asiaShanghaiBusinessDate('2024-02-29T23:59:59+08:00')).toBe('2024-02-29');
  });

  it('历史年份必须是 4 位数字输入；输出年份 pad 至 4 位', () => {
    expect(asiaShanghaiBusinessDate('0999-02-03T00:00:00+08:00')).toBe('0999-02-03');
    // 3 位年份输入非法（非 yyyy）
    expect(() => asiaShanghaiBusinessDate('999-02-03T00:00:00+08:00')).toThrow(ValidationError);
  });

  it('带小数秒的合法时刻被接受（Date.parse 处理小数秒）', () => {
    expect(asiaShanghaiBusinessDate('2026-09-06T16:00:00.500Z')).toBe('2026-09-07');
  });

  it('输出与 Intl 具名时区结果一致（真实时区数据，非恒定 UTC+8 假设）', () => {
    const viaIntl = SHANGHAI_DATE_FORMAT.formatToParts(new Date('2026-09-06T16:30:00Z'));
    const pick = (t: string): string => viaIntl.find((p) => p.type === t)!.value;
    expect(asiaShanghaiBusinessDate('2026-09-06T16:30:00Z')).toBe(`${pick('year')}-${pick('month')}-${pick('day')}`);
  });

  it('非法时刻严格拒绝：24:00、分钟/秒越界、偏移越界、无偏移本地时间、非法日历、3 位年份', () => {
    const bad = [
      '2026-09-06T24:00:00Z',
      '2026-09-06T23:60:00Z',
      '2026-09-06T23:59:60Z',
      '2026-09-06T23:59:00+24:00',
      '2026-09-06T10:00:00', // 无偏移（本地时间，宿主时区歧义）
      '2026-02-30T10:00:00Z', // 非法日历
      '2026-09-06T25:00:00+08:00',
      '999-02-03T00:00:00+08:00',
    ];
    for (const s of bad) {
      expect(() => asiaShanghaiBusinessDate(s)).toThrow(ValidationError);
    }
  });

  it('非字符串 instant 输入拒绝', () => {
    expect(() => asiaShanghaiBusinessDate(20260907 as unknown as string)).toThrow(ValidationError);
  });
});

describe('5.1 无变化不重新发布判定', () => {
  it('观察与当前一致 → 无变化（不触发重新发布）', () => {
    const current = buildSourceFingerprint(fp());
    expect(isCurrentFingerprint(current, fp())).toBe(true);
    expect(isCurrentFingerprint(current, fp({ businessDate: '2026-09-07', businessRevision: '42' }))).toBe(true);
  });

  it('非法观察输入被拒绝（抛 ValidationError，而非静默判不同）', () => {
    const current = buildSourceFingerprint(fp());
    expect(() => isCurrentFingerprint(current, fp({ businessDate: '2026-02-30' }))).toThrow(ValidationError);
    expect(() => isCurrentFingerprint(current, fp({ businessRevision: -1 }))).toThrow(ValidationError);
  });

  it('任一分量变化（revision/date/generation/settings 摘要/版本）→ 需要新发布', () => {
    const current = buildSourceFingerprint(fp());
    const cases: SourceFingerprintInput[] = [
      fp({ businessRevision: '43' }),
      fp({ businessDate: '2026-09-08' }),
      fp({ lineage: { ...LINEAGE, contentGenerationId: '44444444-4444-4444-8444-444444444444' } }),
      fp({ approvedSettingsDigest: 'b'.repeat(64) }),
      fp({ projectionVersion: 'v2' }),
    ];
    for (const changed of cases) {
      expect(isCurrentFingerprint(current, changed)).toBe(false);
    }
  });
});
