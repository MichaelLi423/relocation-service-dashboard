/**
 * stream-lines（tasks 3.1 切片）：把 ingress 原始字节流按 LF 切成投影行字符串。
 *
 * 早期硬限制，超限整体拒绝、绝不静默截断：
 * - 原始总量 ≤ 64 MiB：处理每个 chunk 之前校验（累计超限即拒绝该 chunk）；
 * - 单行内容 ≤ 64 KiB（不含 LF）：跨 chunk 累计时先校验再复制；
 * - 非空行 ≤ 100000 行：第 100001 个非空行在产出前拒绝。
 *
 * 语义：行缓冲存原始字节直到 LF 才解码，跨 chunk 拆分的码点/行均能还原；
 * 非法 UTF-8 致命；空行或纯空白行拒绝；空流合法（不产出）；不以 LF 结尾的
 * 末段是合法末行；CR/首尾空白保留在行文本中（只在整行纯空白时拒绝）。
 * TextDecoder 使用 ignoreBOM：行首 U+FEFF 保留在行文本中，由 strict-json 层
 * 判定拒绝，本切片不静默剥离。
 *
 * 错误：StreamLinesError 的 message 只由稳定全码生成（固定文本、无任意入参），
 * 绝不回显原始输入或 cause。外层 catch 对任何到达错误一律重建为受控错误——
 * 即便上游抛的是伪造/篡改 message、cause 的 StreamLinesError：code 为已知码则
 * 按该码重建固定文本，未知码一律 SOURCE_FAILED；原错误对象永不外泄。
 *
 * 边界声明：本切片只做字节→行切分与上述硬限制，不含 JSON/schema/字段/金额/
 * 日期/枚举/哈希/HTTP/磁盘/认证。
 */
export const STREAM_LINES_MAX_LINE_BYTES = 64 * 1024; // 单行内容 ≤ 64 KiB（不含 LF）
export const STREAM_LINES_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 原始总量 ≤ 64 MiB
export const STREAM_LINES_MAX_LINES = 100_000; // 非空行上限

/** 稳定错误码：值即规范 wire code（message 亦只含该全码）。 */
export const STREAM_LINES_ERROR_CODES = {
  INVALID_CHUNK: 'STREAM_LINES_INVALID_CHUNK',
  TOTAL_TOO_LARGE: 'STREAM_LINES_TOTAL_TOO_LARGE',
  LINE_TOO_LARGE: 'STREAM_LINES_LINE_TOO_LARGE',
  TOO_MANY_LINES: 'STREAM_LINES_TOO_MANY_LINES',
  BLANK_LINE: 'STREAM_LINES_BLANK_LINE',
  INVALID_UTF8: 'STREAM_LINES_INVALID_UTF8',
  SOURCE_FAILED: 'STREAM_LINES_SOURCE_FAILED',
} as const;

export type StreamLinesErrorCode =
  (typeof STREAM_LINES_ERROR_CODES)[keyof typeof STREAM_LINES_ERROR_CODES];

type ErrorKind = keyof typeof STREAM_LINES_ERROR_CODES;

/** 固定 message 错误：message === `stream-lines ${code}`，杜绝任意文本/输入回显。 */
export class StreamLinesError extends Error {
  constructor(readonly code: StreamLinesErrorCode) {
    super(`stream-lines ${code}`);
    this.name = 'StreamLinesError';
  }
}

const LF = 0x0a; // 唯一行定界符；CR 保留为行内容

/** code 全码 → 类别（用于外层 catch 校验 code 是否已知并重建受控错误）。 */
const KIND_BY_CODE: Readonly<Record<string, ErrorKind>> = (() => {
  const map: Record<string, ErrorKind> = {};
  for (const kind of Object.keys(STREAM_LINES_ERROR_CODES) as ErrorKind[]) {
    map[STREAM_LINES_ERROR_CODES[kind]] = kind;
  }
  return map;
})();

export async function* frameProjectionLines(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const lineBuffer = new Uint8Array(STREAM_LINES_MAX_LINE_BYTES);
  let bufferLen = 0;
  let totalBytes = 0;
  let emitted = 0;

  const fail = (kind: ErrorKind): StreamLinesError =>
    new StreamLinesError(STREAM_LINES_ERROR_CODES[kind]);

  /** 复制到行缓冲前先校验余量（放不下即拒绝，不截断）。 */
  const append = (segment: Uint8Array): void => {
    if (bufferLen + segment.byteLength > STREAM_LINES_MAX_LINE_BYTES) {
      throw fail('LINE_TOO_LARGE');
    }
    if (segment.byteLength > 0) {
      lineBuffer.set(segment, bufferLen);
      bufferLen += segment.byteLength;
    }
  };

  /** 行缓冲已完整（LF 结束或 EOF 尾段）：解码并校验，返回行文本。 */
  const finalize = (): string => {
    let text: string;
    try {
      text = decoder.decode(lineBuffer.subarray(0, bufferLen));
    } catch {
      throw fail('INVALID_UTF8');
    }
    bufferLen = 0;
    if (text.trim().length === 0) {
      throw fail('BLANK_LINE');
    }
    if (emitted >= STREAM_LINES_MAX_LINES) {
      throw fail('TOO_MANY_LINES');
    }
    emitted += 1;
    return text;
  };

  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        throw fail('INVALID_CHUNK');
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > STREAM_LINES_MAX_TOTAL_BYTES) {
        throw fail('TOTAL_TOO_LARGE');
      }
      let offset = 0;
      for (;;) {
        const lf = chunk.indexOf(LF, offset);
        if (lf === -1) {
          // 未完成的尾部字节留在行缓冲，等待后续 chunk 补全或 EOF
          append(chunk.subarray(offset));
          break;
        }
        append(chunk.subarray(offset, lf));
        offset = lf + 1;
        yield finalize();
      }
    }
    if (bufferLen > 0) {
      yield finalize(); // 不以 LF 结尾的末段是合法末行
    }
  } catch (error) {
    // 一律重建受控错误：code 已知按原 code，未知（含非 StreamLinesError）一律
    // SOURCE_FAILED；丢弃原对象（含被篡改的 message/cause），绝不透传。
    const code = error instanceof StreamLinesError ? error.code : undefined;
    const kind =
      typeof code === 'string' ? (KIND_BY_CODE[code] ?? 'SOURCE_FAILED') : 'SOURCE_FAILED';
    throw fail(kind);
  }
}
