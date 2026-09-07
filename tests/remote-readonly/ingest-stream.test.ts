/**
 * ingest-stream.test.ts（tasks 3.1 streaming 硬限制的 stream-lines 切片）
 *
 * 只验证 frameProjectionLines 的字节→行切分与早期硬限制，不含 JSON/schema/
 * 字段/金额/日期/枚举等业务校验（3.2 strict-json 与后续 lane 负责）。
 *
 * 覆盖：空输入/无尾 LF 末行/LF 与多字节码点跨 chunk 拆分、非法 UTF-8 致命、
 * 行首 U+FEFF 保留（ignoreBOM）、空行与纯空白行拒绝、64 KiB 单行恰好与超限、
 * 64 MiB 原始总量恰好（复用 64 KiB chunk 1024 次）与超限 chunk 在处理前拒绝、
 * 100000/100001 非空行、非法 chunk、上游普通 Error 与伪造/篡改 StreamLinesError
 * 均被 sanitize（原对象与 cause 不外泄）、取消消费停止上游、提前限流不再拉取。
 *
 * 限制类用例只计数不存行（不产生大数组）；错误断言全部走稳定 code 与固定 message。
 */
import { describe, expect, it } from 'vitest';
import {
  frameProjectionLines,
  StreamLinesError,
  StreamLinesErrorCode,
  STREAM_LINES_ERROR_CODES,
  STREAM_LINES_MAX_LINE_BYTES,
  STREAM_LINES_MAX_TOTAL_BYTES,
  STREAM_LINES_MAX_LINES,
} from '../../src/remote-readonly/ingest/stream-lines';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

/** 把内存 chunk 数组包成 async iterable（同步数组不满足 AsyncIterable 类型）。 */
async function* fromChunks(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** 收集全部行（用于小输出断言）。 */
async function collect(chunks: Uint8Array[]): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of frameProjectionLines(fromChunks(chunks))) {
    lines.push(line);
  }
  return lines;
}

interface RunOutcome {
  emitted: number;
  error: StreamLinesError | undefined;
}

/** 消费整个流：只计数产出行（不存行），返回产出数或首个受控错误。 */
async function runOutcome(chunks: AsyncIterable<Uint8Array>): Promise<RunOutcome> {
  let emitted = 0;
  try {
    for await (const _line of frameProjectionLines(chunks)) {
      emitted += 1;
    }
    return { emitted, error: undefined };
  } catch (error) {
    if (error instanceof StreamLinesError) {
      return { emitted, error };
    }
    throw error;
  }
}

async function runOutcomeFrom(chunks: Uint8Array[]): Promise<RunOutcome> {
  return runOutcome(fromChunks(chunks));
}

describe('基本切分语义', () => {
  it('空输入合法：不产出任何行', async () => {
    expect(await collect([])).toEqual([]);
  });

  it('不以 LF 结尾的末行是合法末行', async () => {
    expect(await collect([bytes('a\nb')])).toEqual(['a', 'b']);
    expect(await collect([bytes('solo')])).toEqual(['solo']);
  });

  it('LF 切分点落在 chunk 边界时仍正确分行', async () => {
    expect(await collect([bytes('aa'), bytes('\nbb'), bytes('\ncc')])).toEqual(['aa', 'bb', 'cc']);
  });

  it('保留行内容中的 CR（不归一化 CRLF，行尾 CR 亦保留）', async () => {
    expect(await collect([bytes('a\r\nb\r')])).toEqual(['a\r', 'b\r']);
  });
});

describe('UTF-8 解码', () => {
  it('多字节码点跨 chunk 拆分时正确还原', async () => {
    const all = bytes('a中\nb');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += 2) {
      chunks.push(all.subarray(i, i + 2)); // 会切开 '中' 的码点与 LF
    }
    expect(await collect(chunks)).toEqual(['a中', 'b']);
  });

  it('非法 UTF-8 致命拒绝：行内无效字节与 EOF 截断多字节', async () => {
    let r = await runOutcomeFrom([Uint8Array.of(0x41, 0xff, 0x42, 0x0a)]);
    expect(r.emitted).toBe(0);
    expect(r.error?.code).toBe(STREAM_LINES_ERROR_CODES.INVALID_UTF8);

    r = await runOutcomeFrom([bytes('ok\n'), Uint8Array.of(0xe4, 0xb8)]);
    expect(r.emitted).toBe(1);
    expect(r.error?.code).toBe(STREAM_LINES_ERROR_CODES.INVALID_UTF8);
  });

  it('行首 U+FEFF 保留不剥离（ignoreBOM；含拆分 BOM 与后续行）', async () => {
    expect(await collect([bytes('\uFEFFok\n')])).toEqual(['\uFEFFok']);
    expect(await collect([bytes('\uFEFFa\n\uFEFFb\n')])).toEqual(['\uFEFFa', '\uFEFFb']);

    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    expect(await collect([bom.subarray(0, 1), bom.subarray(1), bytes('x\n')])).toEqual([
      '\uFEFFx',
    ]);
  });
});

describe('行内容与行数硬限制', () => {
  it('空行/纯空白行拒绝（含行尾空行与 EOF 纯空白尾段）', async () => {
    for (const input of ['\n', '   \n', '\t\n', '\r\n', 'a\n\n', 'ok\n   ']) {
      const { error } = await runOutcomeFrom([bytes(input)]);
      expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.BLANK_LINE);
    }
  });

  it('单行恰好 64 KiB 内容通过（整段与跨 chunk 拼接）', async () => {
    const content = 'a'.repeat(STREAM_LINES_MAX_LINE_BYTES);
    expect(await collect([bytes(content + '\n')])).toEqual([content]);

    const half = Math.floor(STREAM_LINES_MAX_LINE_BYTES / 2);
    expect(await collect([bytes(content.slice(0, half)), bytes(content.slice(half) + '\n')])).toEqual(
      [content],
    );
  });

  it('单行超过 64 KiB 拒绝（单 chunk 与跨 chunk 累计）', async () => {
    let r = await runOutcomeFrom([bytes('a'.repeat(STREAM_LINES_MAX_LINE_BYTES + 1) + '\n')]);
    expect(r.emitted).toBe(0);
    expect(r.error?.code).toBe(STREAM_LINES_ERROR_CODES.LINE_TOO_LARGE);

    r = await runOutcomeFrom([
      bytes('a'.repeat(STREAM_LINES_MAX_LINE_BYTES)),
      bytes('a\n'),
    ]);
    expect(r.emitted).toBe(0);
    expect(r.error?.code).toBe(STREAM_LINES_ERROR_CODES.LINE_TOO_LARGE);
  }, 30_000);

  it('非空行恰好 100000 条全部产出', async () => {
    const r = await runOutcomeFrom([bytes('x\n'.repeat(STREAM_LINES_MAX_LINES))]);
    expect(r.error).toBeUndefined();
    expect(r.emitted).toBe(STREAM_LINES_MAX_LINES);
  }, 30_000);

  it('第 100001 个非空行在产出前拒绝', async () => {
    const r = await runOutcomeFrom([bytes('x\n'.repeat(STREAM_LINES_MAX_LINES + 1))]);
    expect(r.error?.code).toBe(STREAM_LINES_ERROR_CODES.TOO_MANY_LINES);
    expect(r.emitted).toBe(STREAM_LINES_MAX_LINES);
  }, 30_000);
});

describe('原始总量 64 MiB 硬限制', () => {
  it('恰好 64 MiB 通过；多余字节在该 chunk 处理前拒绝（复用同一 chunk，只计数）', async () => {
    // 每 chunk 64 KiB（65535 内容 + LF），1024 个恰好 64 MiB
    const chunk = bytes('a'.repeat(STREAM_LINES_MAX_LINE_BYTES - 1) + '\n');
    const repeats = STREAM_LINES_MAX_TOTAL_BYTES / chunk.byteLength;
    expect(Number.isInteger(repeats)).toBe(true);

    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < repeats; i += 1) {
        yield chunk;
      }
      yield bytes('\n'); // 若被处理会是空行错误；应在此 chunk 进入处理前以总量超限拒绝
    }

    const { emitted, error } = await runOutcome(source());
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.TOTAL_TOO_LARGE);
    expect(emitted).toBe(repeats);
  }, 30_000);
});

describe('错误 sanitize 与消费控制', () => {
  it('非 Uint8Array 的 chunk 拒绝且消息不回显原始值', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes('ok\n');
      yield 'secret-payload' as unknown as Uint8Array;
      yield bytes('extra\n');
    }
    const { emitted, error } = await runOutcome(source());
    expect(emitted).toBe(1);
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.INVALID_CHUNK);
    expect(error?.message).not.toContain('secret-payload');
    expect(error?.message).toMatch(/^stream-lines STREAM_LINES_/);
  });

  it('上游抛普通 Error：sanitize 为 SOURCE_FAILED，不保留 cause 与 canary', async () => {
    const canary = new Error('canary-secret-token');
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes('a\n');
      throw canary;
    }
    const { emitted, error } = await runOutcome(source());
    expect(emitted).toBe(1);
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.SOURCE_FAILED);
    expect(error).not.toBe(canary);
    expect(error?.message).not.toContain('canary');
    expect(error?.cause).toBeUndefined();
  });

  it('上游抛未知 code 的伪造 StreamLinesError：sanitize 为 SOURCE_FAILED', async () => {
    const forged = new StreamLinesError('STREAM_LINES_FORGED_CANARY' as StreamLinesErrorCode);
    forged.message = 'canary-secret-token';
    forged.cause = new Error('canary-cause');
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes('a\n');
      throw forged;
    }
    const { emitted, error } = await runOutcome(source());
    expect(emitted).toBe(1);
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.SOURCE_FAILED);
    expect(error).not.toBe(forged);
    expect(error?.message).not.toContain('canary');
    expect(error?.cause).toBeUndefined();
  });

  it('上游抛已知 code 但篡改 message/cause 的 StreamLinesError：重建固定文本，原对象不外泄', async () => {
    const forged = new StreamLinesError(STREAM_LINES_ERROR_CODES.TOTAL_TOO_LARGE);
    forged.message = 'canary-secret-token';
    forged.cause = new Error('canary-cause');
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes('a\n');
      throw forged;
    }
    const { emitted, error } = await runOutcome(source());
    expect(emitted).toBe(1);
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.TOTAL_TOO_LARGE);
    expect(error).not.toBe(forged);
    expect(error?.message).toBe(`stream-lines ${STREAM_LINES_ERROR_CODES.TOTAL_TOO_LARGE}`);
    expect(error?.message).not.toContain('canary');
    expect(error?.cause).toBeUndefined();
  });

  it('消费方提前取消会停止拉取上游并触发其 finally', async () => {
    let pulls = 0;
    let closed = false;
    const source = (async function* () {
      try {
        for (let i = 0; i < 3; i += 1) {
          pulls += 1;
          yield bytes('line\n');
        }
      } finally {
        closed = true;
      }
    })();

    const got: string[] = [];
    for await (const line of frameProjectionLines(source)) {
      got.push(line);
      if (got.length === 2) {
        break;
      }
    }
    expect(got).toEqual(['line', 'line']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBe(2);
    expect(closed).toBe(true);
  });

  it('行超限提前拒绝后不再拉取更多上游 chunk', async () => {
    let pulls = 0;
    let closed = false;
    const source = (async function* () {
      try {
        pulls += 1;
        yield bytes('a'.repeat(STREAM_LINES_MAX_LINE_BYTES + 1));
        pulls += 1;
        yield bytes('never\n');
      } finally {
        closed = true;
      }
    })();
    const { emitted, error } = await runOutcome(source);
    expect(emitted).toBe(0);
    expect(error?.code).toBe(STREAM_LINES_ERROR_CODES.LINE_TOO_LARGE);
    expect(pulls).toBe(1);
    expect(closed).toBe(true);
  }, 30_000);
});
