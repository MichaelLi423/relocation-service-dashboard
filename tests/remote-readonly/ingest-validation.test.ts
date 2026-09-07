/**
 * ingest-validation.test.ts（tasks 3.2 duplicate JSON keys 切片）
 *
 * 只验证 strict-json 单行解析器（语法/结构层，不含业务 schema/金额/日期/枚举——
 * 那些仍留在 shared contract 与后续 ingest 集成 lane）。
 *
 * 覆盖：
 * - 合法嵌套 JSON（object/array/string/number/bool/null，含引号定界与转义）；
 * - 重复解码键：根层/深层/转义等价键（"a" 与 "\u0061" 解码同名、含转义字符键）；
 * - 非法语法、尾部内容、非 JSON 字面量、未转义控制字符、非法转义、畸形 \u、
 *   非法数字（前导 0、".5"、"-"、指数后无数字）；
 * - 行 UTF-8 字节上限 64 KiB（解析前拒绝）；超深输入受 128 层上限约束；
 * - 原型污染安全：__proto__ / constructor / prototype 键不污染 Object.prototype；
 * - 错误 metadata-only：不 echoing 输入或未知键内容。
 *
 * 边界声明（不虚构覆盖）：非法 UTF-8 字节序列的拒绝属于未来 streaming 边界；
 * 本函数输入为 string，若已含替换字符 U+FFFD 则视为普通合法字符，不冒充字节校验。
 * 未实现上传/网络/worker/schema 集成；parent 保留 3.2 为 incomplete 直到完整链路。
 */
import { describe, expect, it } from 'vitest';
import {
  parseStrictJsonLine,
  StrictJsonParseError,
  STRICT_JSON_ERROR_CODES,
  STRICT_JSON_MAX_LINE_BYTES,
  STRICT_JSON_MAX_DEPTH,
} from '../../src/remote-readonly/ingest/strict-json';

function expectError(fn: () => unknown, code: string): StrictJsonParseError {
  try {
    fn();
    throw new Error('expected to throw');
  } catch (error) {
    if (error instanceof StrictJsonParseError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
}

/** 断言错误不携带输入原文（输入越界时不回显）。 */
function expectMetadataOnly(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected to throw');
  } catch (error) {
    if (error instanceof StrictJsonParseError) {
      expect(error.message).toMatch(/^strict-json STRICT_JSON_/);
      return;
    }
    throw error;
  }
}

describe('strict-json：合法嵌套行解析', () => {
  it('解析嵌套 object/array/标量并返回元数据', () => {
    const line = '{"a":{"b":[1,2,{"c":"x\\ty","d":true,"e":null,"f":-1.5e2}]}}';
    const result = parseStrictJsonLine(line);
    const value = result.value as {
      a: { b: Array<number | { c: string; d: boolean; e: null; f: number }> };
    };
    expect(value.a.b[1]).toBe(2);
    const inner = value.a.b[2] as { c: string; d: boolean; e: null; f: number };
    expect(inner.c).toBe('x\ty');
    expect(inner.d).toBe(true);
    expect(inner.e).toBeNull();
    expect(inner.f).toBe(-150);
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.depth).toBeGreaterThan(2);
    expect(result.keyCount).toBeGreaterThan(0);
    expect(result.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('解析引号定界/转义字符串：转义引号、反斜杠、斜杠、控制字符转义', () => {
    const result = parseStrictJsonLine('{"k":"a\\\"b\\\\c\\/d\\b\\f\\n\\r\\t"}');
    const value = result.value as { k: string };
    expect(value.k).toBe('a"b\\c/d\b\f\n\r\t');
  });

  it('解析 \\uXXXX 转义与代理对', () => {
    const result = parseStrictJsonLine('{"emoji":"\\u4f60\\u597d\\ud83d\\ude00"}');
    const value = result.value as { emoji: string };
    expect(value.emoji).toBe('你好😀');
  });

  it('顶层数组与标量顶层值可解析', () => {
    expect((parseStrictJsonLine('[1,2,3]').value as number[])).toEqual([1, 2, 3]);
    expect(parseStrictJsonLine('null').value).toBeNull();
    expect(parseStrictJsonLine('"text"').value).toBe('text');
    expect(parseStrictJsonLine('true').value).toBe(true);
  });
});

describe('strict-json：重复解码键检测（ALL 嵌套层）', () => {
  it('根层重复键拒绝', () => {
    expectError(() => parseStrictJsonLine('{"a":1,"a":2}'), STRICT_JSON_ERROR_CODES.DUPLICATE_KEY);
  });

  it('深层嵌套重复键拒绝', () => {
    expectError(
      () => parseStrictJsonLine('{"l1":{"l2":{"l3":{"dup":1,"dup":2}}}}'),
      STRICT_JSON_ERROR_CODES.DUPLICATE_KEY,
    );
  });

  it('数组内对象的重复键拒绝', () => {
    expectError(
      () => parseStrictJsonLine('[{"x":1},{"x":2,"x":3}]'),
      STRICT_JSON_ERROR_CODES.DUPLICATE_KEY,
    );
  });

  it('转义等价键（\\uXXXX 别名）视为重复', () => {
    expectError(() => parseStrictJsonLine('{"a":1,"\\u0061":2}'), STRICT_JSON_ERROR_CODES.DUPLICATE_KEY);
  });

  it('含转义字符的键：同一解码文本重复仍拒绝（转义别名归并到解码键）', () => {
    // JS 源中 '{"k\\tey":1,"k\\tey":2}' → JSON 文本两键都是 k\tey（\t = tab 转义），
    // 解码后同为 "k<TAB>ey" → 重复。
    expectError(() => parseStrictJsonLine('{"k\\tey":1,"k\\tey":2}'), STRICT_JSON_ERROR_CODES.DUPLICATE_KEY);
    // JS 源中 '{"k\\tey":1,"k\\\\tey":2}' → JSON 文本两键解码后不同
    // （k<TAB>ey vs k\tey 字面反斜杠）→ 不重复。
    const ok = parseStrictJsonLine('{"k\\tey":1,"k\\\\tey":2}');
    const okValue = ok.value as Record<string, number>;
    expect(Object.keys(okValue)).toHaveLength(2);
    expect(okValue['k\tey']).toBe(1);
    expect(okValue['k\\tey']).toBe(2);
  });

  it('不同转义但同解码的斜杠/大小写 \\u 别名视为重复', () => {
    expectError(
      () => parseStrictJsonLine('{"\\u0041":1,"A":2}'),
      STRICT_JSON_ERROR_CODES.DUPLICATE_KEY,
    );
  });

  it('不同解码键（含转义但不同）不误报', () => {
    const result = parseStrictJsonLine('{"a":1,"\\u0062":2,"k\\tey":3,"k\\\\tey":4}');
    const value = result.value as Record<string, number>;
    expect(value['a']).toBe(1);
    expect(value['b']).toBe(2);
    expect(value['k\tey']).toBe(3);
    expect(value['k\\tey']).toBe(4);
  });
});

describe('strict-json：无效语法/尾部/非 JSON 字面量拒绝', () => {
  it('畸形 JSON 语法拒绝（未闭合、多余逗号、键非字符串）', () => {
    expectError(() => parseStrictJsonLine('{"a":'), STRICT_JSON_ERROR_CODES.UNEXPECTED_END);
    expectError(() => parseStrictJsonLine('{a:1}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('[1,]'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('{"a":1,}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
  });

  it('尾部多余内容拒绝且不回显输入', () => {
    const err = expectError(
      () => parseStrictJsonLine('{"a":1} trailing'),
      STRICT_JSON_ERROR_CODES.TRAILING_CONTENT,
    );
    expect(err.message).not.toContain('trailing');
  });

  it('非 JSON 字面量拒绝（True/FALSE/NaN/部分 true 前缀）', () => {
    expectError(() => parseStrictJsonLine('True'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    expectError(() => parseStrictJsonLine('FALSE'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    expectError(() => parseStrictJsonLine('NaN'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    expectError(() => parseStrictJsonLine('nul'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    // 'true' 前缀成功字面量后仍有字符 → 尾部内容
    expectError(() => parseStrictJsonLine('truex'), STRICT_JSON_ERROR_CODES.TRAILING_CONTENT);
  });

  it('非法标识符起始值拒绝（undefined/单字母/数组含裸字面量）', () => {
    expectError(() => parseStrictJsonLine('undefined'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    expectError(() => parseStrictJsonLine('x'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
    expectError(() => parseStrictJsonLine('[NaN]'), STRICT_JSON_ERROR_CODES.NON_JSON_LITERAL);
  });

  it('非法数字 grammar 拒绝（不静默强转/截断）', () => {
    expectError(() => parseStrictJsonLine('01'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('-01'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('.5'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('-'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('1.'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('1e'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('1e+'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('+1'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
  });

  it('非法字符串转义/未转义控制字符/畸形 \\u 拒绝', () => {
    expectError(() => parseStrictJsonLine('{"a":"\\x"}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('{"a":"\u0001"}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('{"a":"\\u12G4"}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('{"a":"\\u123"}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('{"a" 1}'), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
  });

  it('空输入/仅空白拒绝', () => {
    expectError(() => parseStrictJsonLine(''), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
    expectError(() => parseStrictJsonLine('   '), STRICT_JSON_ERROR_CODES.INVALID_SYNTAX);
  });
});

describe('strict-json：行字节上限与深度上限', () => {
  it('> 64 KiB UTF-8 字节输入在解析前拒绝且不回显', () => {
    const big = `{"pad":"${'a'.repeat(STRICT_JSON_MAX_LINE_BYTES)}"}`;
    const err = expectError(() => parseStrictJsonLine(big), STRICT_JSON_ERROR_CODES.LINE_TOO_LARGE);
    expect(err.message).not.toContain('a'.repeat(64));
    expect(err.message).toMatch(/超过 65536/);
  });

  it('恰好 ≤ 64 KiB 的行可解析（多字节字符按 UTF-8 字节计）', () => {
    // 每个中文 3 字节：整体字节数贴近上限但不超 64KiB
    const content = '中'.repeat(21800); // 65400 bytes + 结构 < 65536
    const line = `{"pad":"${content}"}`;
    const result = parseStrictJsonLine(line);
    expect((result.value as { pad: string }).pad).toBe(content);
    expect(result.byteLength).toBeLessThanOrEqual(STRICT_JSON_MAX_LINE_BYTES);
    expect(result.byteLength).toBeGreaterThan(64 * 1000);
  });

  it('超过 128 层嵌套拒绝（深度受约束，防 stack abuse）', () => {
    const depth = STRICT_JSON_MAX_DEPTH + 5;
    const line = `${'['.repeat(depth)}0${']'.repeat(depth)}`;
    const err = expectError(() => parseStrictJsonLine(line), STRICT_JSON_ERROR_CODES.DEPTH_EXCEEDED);
    expect(err.message).not.toContain(line);
  });
});

describe('strict-json：原型污染安全与 metadata-only 错误', () => {
  it('__proto__ / constructor / prototype 键仅作普通数据键，不污染 Object.prototype', () => {
    const result = parseStrictJsonLine('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2}}');
    const value = result.value as Record<string, { polluted?: boolean }>;
    expect(value['__proto__']).toEqual({ polluted: true });
    expect(value['constructor']).toEqual({ x: 1 });
    expect(value['prototype']).toEqual({ y: 2 });
    // 不污染全局原型
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('重复 __proto__ 键仍按重复键拒绝（解码层一致）', () => {
    expectError(
      () => parseStrictJsonLine('{"__proto__":{},"__proto__":{}}'),
      STRICT_JSON_ERROR_CODES.DUPLICATE_KEY,
    );
  });

  it('错误只含元数据，绝不含输入原文/canary/未批准键内容', () => {
    const canary = 'CANARY-SECRET-VALUE-42';
    for (const bad of [
      `{"a":1,"a":${canary}}`,
      `{"a":1} ${canary}`,
      `{"secretKey":"${canary}"`,
      `[${canary}]`,
    ]) {
      expectMetadataOnly(() => parseStrictJsonLine(bad));
    }
  });

  it('duplicate-key 错误不携带重复键名称（只含键/位置元数据）', () => {
    const err = expectError(
      () => parseStrictJsonLine('{"sensitiveFieldName":1,"\\u0073ensitiveFieldName":2}'),
      STRICT_JSON_ERROR_CODES.DUPLICATE_KEY,
    );
    expect(err.message).not.toContain('sensitive');
    expect(err.position).toBeGreaterThan(0);
  });
});

describe('strict-json：结构安全与标量保真', () => {
  it('标准 JSON 数值解析为 number（与 JSON.parse 一致；schema 层负责业务强制转换校验）', () => {
    const result = parseStrictJsonLine('{"a":9007199254740993,"b":-0.5,"c":2e-3,"d":1.25E+2}');
    const value = result.value as { a: number; b: number; c: number; d: number };
    // JSON.parse 语义：超出安全范围的整数按 IEEE754 number 表达（本层不静默改写、
    // 不虚构 bigint 保真——业务金额/日期需强制转换时由 shared contract schema 拒绝）
    expect(value.a).toBe(Number('9007199254740993'));
    expect(value.b).toBe(-0.5);
    expect(value.c).toBe(0.002);
    expect(value.d).toBe(125);
  });

  it('isWellFormed 代理项扫描：孤立代理项作为输入字符存在时不错误声称接受字节', () => {
    // '\ud800' 为孤立高代理（不构成合法字符）；解析器按字符串输入处理时
    // 若直接落在字符串字面量外会因不是合法 JSON 起始而拒绝（不崩溃、不污染）。
    expectMetadataOnly(() => parseStrictJsonLine('{"a":"\ud800"}'));
  });

  it('返回对象为 null-prototype 安全容器，不暴露 Object.prototype 成员', () => {
    const result = parseStrictJsonLine('{"own":1}');
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value['toString']).toBeUndefined();
    expect(value['own']).toBe(1);
  });
});
