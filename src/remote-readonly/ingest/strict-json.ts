/**
 * strict-json：JSONL 单行严格解析器（tasks 3.2 duplicate JSON keys 切片）。
 *
 * 本模块是 ingest 验证链路的「语法/结构层」：
 * - 输入为 string，先按 UTF-8 字节长度拒绝 > 64 KiB 的行（解析前拒绝，不截断）；
 * - 只接受标准 JSON grammar：object/array/string/number/true/false/null 的 RFC 8259
 *   结构，数字与字符串按标准规则严格解析，绝不 eval / new Function / 新增依赖；
 * - 递归层数有上限（防 stack abuse），原型污染安全（对象用 null-prototype 构建，
 *   __proto__/constructor/prototype 键只是普通数据键，永不写入 Object.prototype）；
 * - 在 ALL 嵌套层检测「解码后」重复的 property name（含转义等价键，如 "a" 与
 *   "\u0061"、"k\tey" 与 "k\\tey" 解码后相同）→ 结构性拒绝；
 * - 错误码固定、message 只含元数据（行字节大小/层数/错误类别/行内位置偏移），
 *   绝不回显原始输入片段或未批准键内容。
 *
 * 边界声明（不虚构覆盖）：
 * - 本文件不做上传/网络/worker/schema 验证（后续 lane 负责）——「schema 层」的
 *   业务字段/金额/日期/枚举校验不在此处；
 * - 非法 UTF-8 的字节输入由未来 streaming 边界处理；当前输入若被解码为 string，
 *   替换字符 U+FFFD 只是普通合法字符，不会错误声称「接受字节序列」。
 */
import { createHash } from 'node:crypto';

/** 单行输入 UTF-8 字节上限（后续 JSONL ingress 每行 ≤ 64 KiB）。 */
export const STRICT_JSON_MAX_LINE_BYTES = 64 * 1024;

/** 解析深度上限（防递归/栈滥用；超过即拒绝，message 只含元数据）。 */
export const STRICT_JSON_MAX_DEPTH = 128;

/** 稳定错误码：值即规范 wire code（以 STRICT_JSON_ 前缀，message 亦用全码）。 */
export const STRICT_JSON_ERROR_CODES: Record<string, string> = {
  LINE_TOO_LARGE: 'STRICT_JSON_LINE_TOO_LARGE',
  INVALID_UTF8_BYTES: 'STRICT_JSON_INVALID_UTF8_BYTES',
  INVALID_SYNTAX: 'STRICT_JSON_INVALID_SYNTAX',
  TRAILING_CONTENT: 'STRICT_JSON_TRAILING_CONTENT',
  NON_JSON_LITERAL: 'STRICT_JSON_NON_JSON_LITERAL',
  DUPLICATE_KEY: 'STRICT_JSON_DUPLICATE_KEY',
  DEPTH_EXCEEDED: 'STRICT_JSON_DEPTH_EXCEEDED',
  /** 解析器内部意外终止（不可达分支；generic）。 */
  UNEXPECTED_END: 'STRICT_JSON_UNEXPECTED_END',
} as const;

export type StrictJsonErrorCode = (typeof STRICT_JSON_ERROR_CODES)[keyof typeof STRICT_JSON_ERROR_CODES];

type StrictJsonErrorKey = keyof typeof STRICT_JSON_ERROR_CODES;

/** 短名 → 全码（strictError 统一展开，保证 error.code === STRICT_JSON_ERROR_CODES[k]）。 */
const FULL_ERROR_CODE: Record<StrictJsonErrorKey, StrictJsonErrorCode> = STRICT_JSON_ERROR_CODES;

/** metadata-only 解析错误：message 只含类别/行内位置/大小，不回显输入或键值内容。 */
export class StrictJsonParseError extends Error {
  constructor(
    readonly code: StrictJsonErrorCode,
    /** 行内 UTF-16 码元位置（诊断用；0-based，近似字节位置）。 */
    readonly position: number,
    message: string,
  ) {
    super(message);
    this.name = 'StrictJsonParseError';
  }
}

export interface StrictJsonLineResult {
  /** 解析出的普通 JS 值（顶层 array/object 属性均为 null-prototype 安全容器）。 */
  value: unknown;
  /** 输入 UTF-8 字节长度（≤ 64 KiB 才解析）。 */
  byteLength: number;
  /** 该行包含的嵌套层级最大值（≤ STRICT_JSON_MAX_DEPTH）。 */
  depth: number;
  /** 该行 object 键总数（重复检测通过后）。 */
  keyCount: number;
  /** 内容 canonical 摘要（sha256 hex；不保存原始行，日志只记录摘要/元数据）。 */
  contentDigest: string;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** 基础对象：null-prototype，永不污染 Object.prototype。 */
type SafeObject = Record<string, unknown>;

function createSafeObject(): SafeObject {
  return Object.create(null) as SafeObject;
}

function createSafeArray(): unknown[] {
  return [];
}

/** 短名错误工厂（内部统一走这里，保证 error.code 是导出的全码
 * STRICT_JSON_ERROR_CODES[短名]，message 头部用同一全码）。 */
function strictError(kind: StrictJsonErrorKey, position: number, detail: string): StrictJsonParseError {
  const code = FULL_ERROR_CODE[kind];
  return new StrictJsonParseError(code, position, `strict-json ${code}${detail ? `: ${detail}` : ''}`);
}

/**
 * 手写递归下降 parser（RFC 8259 grammar）。
 * state 全程共享：cursor 只前移不回退；value/object/array 在跳过前置空白后读取。
 */
class StrictJsonParser {
  private readonly input: string;
  private pos = 0;
  private readonly inputLength: number;
  /** 当前最大嵌套层数（object/array 深度，不含顶层值本身）。 */
  private maxDepth = 0;
  private keyCount = 0;

  constructor(input: string) {
    this.input = input;
    this.inputLength = input.length;
  }

  parseTop(): { value: unknown; depth: number; keyCount: number } {
    this.skipWhitespace();
    if (this.pos >= this.inputLength) {
      throw strictError('INVALID_SYNTAX', 0, '空输入');
    }
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos < this.inputLength) {
      throw strictError('TRAILING_CONTENT', this.pos, '行尾存在多余内容');
    }
    return { value, depth: this.maxDepth, keyCount: this.keyCount };
  }

  private skipWhitespace(): void {
    while (this.pos < this.inputLength && isWhitespace(this.input.charCodeAt(this.pos))) {
      this.pos += 1;
    }
  }

  private parseValue(depth: number): unknown {
    if (depth > STRICT_JSON_MAX_DEPTH) {
      throw strictError('DEPTH_EXCEEDED', this.pos, `嵌套深度超过 ${STRICT_JSON_MAX_DEPTH}`);
    }
    if (this.pos >= this.inputLength) {
      throw strictError('UNEXPECTED_END', this.pos, '值未结束');
    }
    const code = this.input.charCodeAt(this.pos);
    switch (code) {
      case 0x7b: // {
        return this.parseObject(depth);
      case 0x5b: // [
        return this.parseArray(depth);
      case 0x22: // "
        return this.parseString();
      case 0x74: // t
        this.parseLiteral('true');
        return true;
      case 0x66: // f
        this.parseLiteral('false');
        return false;
      case 0x6e: // n
        this.parseLiteral('null');
        return null;
      case 0x2d: // -
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        return this.parseNumber();
      default:
        // 字母开头不可能是合法 JSON 值起始：按「非 JSON 字面量」类别拒绝
        // （区分纯结构性语法错误，两者均不回显输入）。
        if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
          throw strictError('NON_JSON_LITERAL', this.pos, '非 JSON 字面量');
        }
        throw strictError('INVALID_SYNTAX', this.pos, '非法的值起始字符');
    }
  }

  private parseLiteral(literal: string): void {
    if (this.input.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return;
    }
    throw strictError('NON_JSON_LITERAL', this.pos, '非法字面量');
  }

  private parseObject(depth: number): SafeObject {
    const start = this.pos;
    this.pos += 1; // consume '{'
    const container: SafeObject = createSafeObject();
    const seen = new Set<string>();
    const childDepth = depth + 1;
    if (childDepth > STRICT_JSON_MAX_DEPTH) {
      throw strictError('DEPTH_EXCEEDED', start, `嵌套深度超过 ${STRICT_JSON_MAX_DEPTH}`);
    }
    this.maxDepth = Math.max(this.maxDepth, childDepth);
    this.skipWhitespace();
    if (this.pos < this.inputLength && this.input.charCodeAt(this.pos) === 0x7d /* } */) {
      this.pos += 1;
      return container;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.inputLength) {
        throw strictError('UNEXPECTED_END', this.pos, '对象未闭合');
      }
      if (this.input.charCodeAt(this.pos) !== 0x22 /* " */) {
        throw strictError('INVALID_SYNTAX', this.pos, '对象键必须是字符串');
      }
      const rawKey = this.parseString();
      const decodedKey = rawKey; // parseString 已做完整转义解码
      if (seen.has(decodedKey)) {
        throw strictError('DUPLICATE_KEY', this.pos, `重复对象键`);
      }
      seen.add(decodedKey);
      this.keyCount += 1;
      this.skipWhitespace();
      if (this.pos >= this.inputLength) {
        throw strictError('UNEXPECTED_END', this.pos, '对象键后缺少冒号');
      }
      if (this.input.charCodeAt(this.pos) !== 0x3a /* : */) {
        throw strictError('INVALID_SYNTAX', this.pos, '对象键后缺少冒号');
      }
      this.pos += 1;
      this.skipWhitespace();
      container[decodedKey] = this.parseValue(childDepth);
      this.skipWhitespace();
      if (this.pos >= this.inputLength) {
        throw strictError('UNEXPECTED_END', this.pos, '对象未闭合');
      }
      const commaOrEnd = this.input.charCodeAt(this.pos);
      if (commaOrEnd === 0x2c /* , */) {
        this.pos += 1;
        continue;
      }
      if (commaOrEnd === 0x7d /* } */) {
        this.pos += 1;
        return container;
      }
      throw strictError('INVALID_SYNTAX', this.pos, '对象成员间缺少逗号或右花括号');
    }
  }

  private parseArray(depth: number): unknown[] {
    const start = this.pos;
    this.pos += 1; // consume '['
    const container = createSafeArray();
    const childDepth = depth + 1;
    if (childDepth > STRICT_JSON_MAX_DEPTH) {
      throw strictError('DEPTH_EXCEEDED', start, `嵌套深度超过 ${STRICT_JSON_MAX_DEPTH}`);
    }
    this.maxDepth = Math.max(this.maxDepth, childDepth);
    this.skipWhitespace();
    if (this.pos < this.inputLength && this.input.charCodeAt(this.pos) === 0x5d /* ] */) {
      this.pos += 1;
      return container;
    }
    for (;;) {
      this.skipWhitespace();
      container.push(this.parseValue(childDepth));
      this.skipWhitespace();
      if (this.pos >= this.inputLength) {
        throw strictError('UNEXPECTED_END', this.pos, '数组未闭合');
      }
      const commaOrEnd = this.input.charCodeAt(this.pos);
      if (commaOrEnd === 0x2c /* , */) {
        this.pos += 1;
        continue;
      }
      if (commaOrEnd === 0x5d /* ] */) {
        this.pos += 1;
        return container;
      }
      throw strictError('INVALID_SYNTAX', this.pos, '数组成员间缺少逗号或右方括号');
    }
  }

  /**
   * 严格 JSON 字符串解析：
   * - 未转义控制字符 U+0000..U+001F 直接拒绝；
   * - 转义仅允许 " \ / b f n r t uXXXX；未知转义拒绝；
   * - \uXXXX 必须是 4 位十六进制；孤立代理项按标准语义保留（不自动配对，
   *   非法 4 位十六进制才拒绝）——不静默截断或改写；
   * - 返回解码后文本（转义等价键由此天然归并到同一 decoded key）。
   */
  private parseString(): string {
    // caller 已确认当前字符是 '"'
    this.pos += 1;
    let result = '';
    for (;;) {
      if (this.pos >= this.inputLength) {
        throw strictError('UNEXPECTED_END', this.pos, '字符串未闭合');
      }
      const code = this.input.charCodeAt(this.pos);
      if (code === 0x22 /* " */) {
        this.pos += 1;
        return result;
      }
      if (code === 0x5c /* \ */) {
        this.pos += 1;
        if (this.pos >= this.inputLength) {
          throw strictError('UNEXPECTED_END', this.pos, '字符串转义未结束');
        }
        const esc = this.input.charCodeAt(this.pos);
        this.pos += 1;
        switch (esc) {
          case 0x22: result += '"'; break;
          case 0x5c: result += '\\'; break;
          case 0x2f: result += '/'; break;
          case 0x62: result += '\b'; break;
          case 0x66: result += '\f'; break;
          case 0x6e: result += '\n'; break;
          case 0x72: result += '\r'; break;
          case 0x74: result += '\t'; break;
          case 0x75: {
            if (this.pos + 4 > this.inputLength) {
              throw strictError('INVALID_SYNTAX', this.pos - 2, '\\u 转义不完整');
            }
            const hex = this.input.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw strictError('INVALID_SYNTAX', this.pos - 2, '\\u 转义必须是 4 位十六进制');
            }
            const codePoint = Number.parseInt(hex, 16);
            result += String.fromCharCode(codePoint);
            this.pos += 4;
            break;
          }
          default:
            throw strictError('INVALID_SYNTAX', this.pos - 2, '非法转义序列');
        }
        continue;
      }
      if (code < 0x20) {
        throw strictError('INVALID_SYNTAX', this.pos, '字符串含未转义控制字符');
      }
      result += this.input[this.pos];
      this.pos += 1;
    }
  }

  /** 严格 JSON number grammar（RFC 8259）。 */
  private parseNumber(): number {
    const start = this.pos;
    if (this.pos < this.inputLength && this.input.charCodeAt(this.pos) === 0x2d /* - */) {
      this.pos += 1;
    }
    // int
    if (this.pos >= this.inputLength) {
      throw strictError('INVALID_SYNTAX', start, '数字不完整');
    }
    const first = this.input.charCodeAt(this.pos);
    if (first === 0x30 /* 0 */) {
      this.pos += 1;
      // 前导零后紧跟数字（如 01、-01）非法
      if (this.pos < this.inputLength && isDigit(this.input.charCodeAt(this.pos))) {
        throw strictError('INVALID_SYNTAX', this.pos - 1, '数字不允许前导零');
      }
    } else if (first >= 0x31 && first <= 0x39 /* 1-9 */) {
      this.pos += 1;
      while (this.pos < this.inputLength && isDigit(this.input.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    } else {
      throw strictError('INVALID_SYNTAX', start, '非法数字起始');
    }
    // frac
    if (this.pos < this.inputLength && this.input.charCodeAt(this.pos) === 0x2e /* . */) {
      this.pos += 1;
      if (this.pos >= this.inputLength || !isDigit(this.input.charCodeAt(this.pos))) {
        throw strictError('INVALID_SYNTAX', this.pos - 1, '数字小数点后必须跟数字');
      }
      while (this.pos < this.inputLength && isDigit(this.input.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    // exp
    if (this.pos < this.inputLength) {
      const e = this.input.charCodeAt(this.pos);
      if (e === 0x65 /* e */ || e === 0x45 /* E */) {
        this.pos += 1;
        if (this.pos < this.inputLength) {
          const sign = this.input.charCodeAt(this.pos);
          if (sign === 0x2b /* + */ || sign === 0x2d /* - */) {
            this.pos += 1;
          }
        }
        if (this.pos >= this.inputLength || !isDigit(this.input.charCodeAt(this.pos))) {
          throw strictError('INVALID_SYNTAX', this.pos, '指数后必须跟数字');
        }
        while (this.pos < this.inputLength && isDigit(this.input.charCodeAt(this.pos))) {
          this.pos += 1;
        }
      }
    }
    const raw = this.input.slice(start, this.pos);
    // 标准 JSON 数值 → Number（与 JSON.parse 语义一致）。极小/极大数字可能超出
    // 精确整数范围——本层不静默改写；业务金额/日期等需强制转换的校验留在 shared
    // contract schema 层，这里只按标准 grammar 保真产出 number。
    return Number(raw);
  }
}

/** 复制结果：普通 Object/Array 深拷贝为 null-prototype/普通容器，其余值原样。 */
function cloneSafe(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneSafe(item));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as SafeObject;
    const out = createSafeObject();
    for (const key of Object.keys(record)) {
      out[key] = cloneSafe(record[key]);
    }
    return out;
  }
  return value;
}

function isWellFormedUtf16(value: string): boolean {
  // ES2022 target 无 String.isWellFormed；手写代理项扫描。
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function byteLengthUtf8(input: string): number {
  const encoder = new TextEncoder();
  return encoder.encode(input).length;
}

function digestOf(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 严格解析单行 JSON：
 * 1) UTF-8 字节长度 > 64 KiB → LINE_TOO_LARGE（解析前拒绝，不截断）；
 * 2) 代理项断裂等畸形 UTF-16 → 该输入不应作为合法 string 进入（未来 streaming
 *    边界负责字节校验；此处不错误声称接受原始字节）；
 * 3) 语法/重复键/深度错误 → metadata-only StrictJsonParseError；
 * 4) 成功返回 value + 元数据（byteLength/depth/keyCount/contentDigest）。
 */
export function parseStrictJsonLine(input: string): StrictJsonLineResult {
  if (typeof input !== 'string') {
    throw strictError('INVALID_SYNTAX', 0, '输入必须是 string');
  }
  const bytes = byteLengthUtf8(input);
  if (bytes > STRICT_JSON_MAX_LINE_BYTES) {
    throw new StrictJsonParseError(
      STRICT_JSON_ERROR_CODES.LINE_TOO_LARGE,
      0,
      `strict-json STRICT_JSON_LINE_TOO_LARGE: 输入 UTF-8 字节长度 ${bytes} 超过 ${STRICT_JSON_MAX_LINE_BYTES}`,
    );
  }
  if (!isWellFormedUtf16(input)) {
    throw strictError('INVALID_UTF8_BYTES', 0, '输入含畸形 UTF-16 代理项，不应作为字符串输入');
  }
  const parser = new StrictJsonParser(input);
  const { value, depth, keyCount } = parser.parseTop();
  return {
    value: cloneSafe(value),
    byteLength: bytes,
    depth,
    keyCount,
    contentDigest: digestOf(input),
  };
}
