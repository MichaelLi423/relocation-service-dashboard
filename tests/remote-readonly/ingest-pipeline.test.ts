/**
 * ingest-pipeline.test.ts（tasks 3.2 coordinator 切片）
 *
 * 只验证 validateProjectionStream（manifest 文本 + 原始 JSONL 字节流 → 完整校验）：
 * - manifest 严格解析（parseManifestText）；拉正文前校验声明计数总和 ≤ 100000（0 pulls）；
 * - 原始字节 tap：sha256 精确累加（含 LF/CR），同一字节流经 frameProjectionLines 切行，
 *   行文本逐条 ProjectionValidator.accept，流结束 finish 后比对 checksum；
 * - 成功只返回安全计数（manifest 副本 + byteLength + acceptedRecords），无记录内容；
 * - 错误一律折叠为本模块固定码 INVALID_MANIFEST / LIMIT / INVALID_RECORDS /
 *   CHECKSUM_MISMATCH / SOURCE_FAILED，message 只含全码，不回显 canary/键/值/cause。
 *
 * 全部使用 synthetic fixtures（syntheticConnectedProject/buildSyntheticSnapshot），
 * 不读取真实客户数据。不含 disk/HTTP/auth/worker/activation 集成。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  validateProjectionStream,
  ValidateStreamError,
  VALIDATE_STREAM_ERROR_CODES,
  type ProjectionStreamResult,
} from '../../src/remote-readonly/ingest/validate-stream';
import {
  PROJECTION_MAX_RECORDS,
  ProjectionValidator,
} from '../../src/remote-readonly/ingest/projection-validator';
import { STREAM_LINES_MAX_TOTAL_BYTES } from '../../src/remote-readonly/ingest/stream-lines';
import { sectionRowFromWorkbench } from '../../src/shared/remote-readonly/projection';
import {
  PROJECTION_ENTITY_TYPES,
  type RemoteProjectionManifest,
} from '../../src/shared/remote-readonly/manifest';
import { syntheticConnectedProject, syntheticProjectRecord } from './fixtures/project-sources';
import { buildSyntheticSnapshot, syntheticManifest } from './fixtures/synthetic-snapshot';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

async function* fromChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** 有效连接式 synthetic fixture：确定性顺序 + 对齐 manifest（正文含多字节中文）。 */
function connectedFixture(): { lines: string[]; body: string; manifest: RemoteProjectionManifest } {
  const connected = syntheticConnectedProject();
  const record = syntheticProjectRecord(connected);
  const sections = [
    ...connected.sections.batches.map((b) => sectionRowFromWorkbench(b)),
    ...connected.sections.instruments.map((i) => sectionRowFromWorkbench(i)),
    ...connected.sections.orders.map((o) => sectionRowFromWorkbench(o)),
    ...connected.sections.invoices.map((i) => sectionRowFromWorkbench(i)),
    ...connected.sections.damage.map((d) => sectionRowFromWorkbench(d)),
  ];
  const built = buildSyntheticSnapshot({ projects: [record], sections });
  return {
    lines: built.jsonl.split('\n').filter((l) => l.length > 0),
    body: built.jsonl,
    manifest: built.manifest,
  };
}

/** 期望 validateProjectionStream 拒绝并返回固定 ValidateStreamError。 */
async function rejectionOf(
  manifestText: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<ValidateStreamError> {
  try {
    await validateProjectionStream(manifestText, chunks);
  } catch (error) {
    if (error instanceof ValidateStreamError) {
      return error;
    }
    throw error;
  }
  throw new Error('期望 validateProjectionStream 拒绝但成功返回');
}

async function codeOfArray(manifestText: string, chunks: readonly Uint8Array[]): Promise<string> {
  const error = await rejectionOf(manifestText, fromChunks(chunks));
  return error.code;
}

function declaredTotal(manifest: RemoteProjectionManifest): number {
  let total = 0;
  for (const type of PROJECTION_ENTITY_TYPES) {
    total += manifest.entityCounts[type];
  }
  return total;
}

/** 宽松 JSON 行（测试用 fixture 编辑）。 */
type JsonObject = Record<string, unknown>;

function parseObject(line: string): JsonObject {
  return JSON.parse(line) as JsonObject;
}

/** 对指定 kind 的行做 JSON 编辑并重建完整正文（其余行文本不变）。 */
function mutateKindLines(body: string, kind: string, mutate: (obj: JsonObject) => void): string {
  const lines = body.split('\n').filter((l) => l.length > 0);
  const next = lines.map((line) => {
    const obj = parseObject(line);
    if (obj.kind === kind) {
      mutate(obj);
      return JSON.stringify(obj);
    }
    return line;
  });
  return `${next.join('\n')}\n`;
}

describe('validateProjectionStream：有效正文', () => {
  it('整段喂入有效连接式正文通过，只返回安全计数', async () => {
    const fx = connectedFixture();
    const result = await validateProjectionStream(JSON.stringify(fx.manifest), fromChunks([bytes(fx.body)]));
    expect(result.acceptedRecords).toBe(declaredTotal(fx.manifest));
    expect(result.byteLength).toBe(bytes(fx.body).byteLength);
    expect(result.manifest.checksum.hex).toBe(fx.manifest.checksum.hex);
    expect(result.manifest.databaseInstanceId).toBe(fx.manifest.databaseInstanceId);
  });

  it('碎片化（每 2 字节，拆分多字节码点/LF 边界）喂入同样通过', async () => {
    const fx = connectedFixture();
    const bodyBytes = bytes(fx.body);
    expect(bodyBytes.length).toBeGreaterThan(64); // 含中文多字节内容
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bodyBytes.length; i += 2) {
      chunks.push(bodyBytes.subarray(i, i + 2));
    }
    const result: ProjectionStreamResult = await validateProjectionStream(
      JSON.stringify(fx.manifest),
      fromChunks(chunks),
    );
    expect(result.acceptedRecords).toBe(declaredTotal(fx.manifest));
    expect(result.byteLength).toBe(bodyBytes.length);
  });

  it('空正文（0 字节）合法：全零计数 + 空内容摘要通过', async () => {
    const manifestText = JSON.stringify(syntheticManifest());
    const result = await validateProjectionStream(manifestText, fromChunks([]));
    expect(result.acceptedRecords).toBe(0);
    expect(result.byteLength).toBe(0);
    expect(result.manifest.entityCounts.projects).toBe(0);
  });
});

describe('validateProjectionStream：manifest 与早期限制', () => {
  it('manifest 文本非法（重复 JSON 键 / 未知键）折叠为 INVALID_MANIFEST', async () => {
    const dupText = JSON.stringify(syntheticManifest()).replace(
      '{"format"',
      '{"format":"x","format"',
    );
    expect(await codeOfArray(dupText, [bytes('x\n')])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_MANIFEST,
    );

    const withUnknown = { ...syntheticManifest(), sneakyManifestField: 1 };
    expect(await codeOfArray(JSON.stringify(withUnknown), [bytes('x\n')])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_MANIFEST,
    );
  });

  it('manifest 声明计数总和超限：拉取任何正文 chunk 前以 LIMIT 拒绝（0 pulls）', async () => {
    const tooBig = syntheticManifest({
      entityCounts: { projects: PROJECTION_MAX_RECORDS, batches: 1 },
    });
    let pulls = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulls += 1;
        yield bytes('x\n');
      }
    }
    const error = await rejectionOf(JSON.stringify(tooBig), source());
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.LIMIT);
    expect(pulls).toBe(0);
  });
});

describe('validateProjectionStream：checksum 精确字节证明', () => {
  it('语义等价但插入空白的字节 → CHECKSUM_MISMATCH（message 固定不回显）', async () => {
    const fx = connectedFixture();
    const alt = fx.body.replace('{', '{ ');
    expect(alt).not.toBe(fx.body);
    const error = await rejectionOf(JSON.stringify(fx.manifest), fromChunks([bytes(alt)]));
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.CHECKSUM_MISMATCH);
    expect(error.message).toMatch(/^validate-stream /);
  });

  it('去掉正文末尾可选 LF（其余字节不变）→ CHECKSUM_MISMATCH', async () => {
    const fx = connectedFixture();
    expect(fx.body.endsWith('\n')).toBe(true);
    const withoutLf = fx.body.slice(0, -1);
    expect(await codeOfArray(JSON.stringify(fx.manifest), [bytes(withoutLf)])).toBe(
      VALIDATE_STREAM_ERROR_CODES.CHECKSUM_MISMATCH,
    );
  });
});

describe('validateProjectionStream：整体拒绝（无部分成功）', () => {
  it('迟到的不合法记录导致整体失败并关闭上游（不再拉取后续 chunk）', async () => {
    const fx = connectedFixture();
    // 最后一行（damage_items 分区）注入未知顶层键：accept 阶段拒绝。
    const lines = [...fx.lines];
    const last = parseObject(lines[lines.length - 1] as string);
    last.sneakField = true;
    lines[lines.length - 1] = JSON.stringify(last);

    const chunks = lines.map((l) => bytes(`${l}\n`));
    chunks.push(bytes('never-consumed\n'));

    let pulls = 0;
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (const chunk of chunks) {
          pulls += 1;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    }
    const error = await rejectionOf(JSON.stringify(fx.manifest), source());
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS);
    expect(error.message).not.toContain('sneakField');
    expect(pulls).toBe(lines.length); // 故障行之后的 extra chunk 未被拉取
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
  });

  it('畸形 UTF-8 / 重复 JSON 键 / 未知字段 / 引用未解析均折叠为 INVALID_RECORDS', async () => {
    const fx = connectedFixture();
    const manifestText = JSON.stringify(fx.manifest);

    // a) 正文末尾追加非法 UTF-8 字节（framer 致命）。
    const validBytes = bytes(fx.body);
    const malformed = new Uint8Array(validBytes.length + 1);
    malformed.set(validBytes, 0);
    malformed.set([0xff], validBytes.length);
    expect(await codeOfArray(manifestText, [malformed])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS,
    );

    // b) 行内重复 JSON 键（strict-json 拒绝，不回显值）。
    const dupBody = fx.body.replace('{"kind":"', '{"kind":"dup","kind":"');
    expect(await codeOfArray(manifestText, [bytes(dupBody)])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS,
    );

    // c) instruments 行 row 内未知键（schema 拒绝）。
    const unknownBody = mutateKindLines(fx.body, 'instruments', (obj) => {
      (obj.row as JsonObject).notApprovedField = 'x';
    });
    expect(await codeOfArray(manifestText, [bytes(unknownBody)])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS,
    );

    // d) damage_items 引用不存在的 instrumentId（finish 引用校验失败）。
    const refBody = mutateKindLines(fx.body, 'damage_items', (obj) => {
      (obj.row as JsonObject).instrumentId = 'syn-instrument-conn-3';
    });
    expect(await codeOfArray(manifestText, [bytes(refBody)])).toBe(
      VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS,
    );
  });

  it('上游抛错被 sanitize 为 SOURCE_FAILED（canary 不回显、无 cause、原对象不外泄）', async () => {
    const fx = connectedFixture();
    const canary = new Error('canary-secret-token');
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bytes(fx.body);
      throw canary;
    }
    const error = await rejectionOf(JSON.stringify(fx.manifest), source());
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED);
    expect(error).not.toBe(canary);
    expect(error.message).not.toContain('canary');
    expect(error.cause).toBeUndefined();
  });
});

describe('validateProjectionStream：字节层故障优先中止（不伪造 EOF）', () => {
  const incompletePrefix = bytes('{"kind":"project"'); // 无 LF，且不是完整 JSON 行

  async function rejectionWithoutAcceptedPrefix(
    run: () => Promise<ValidateStreamError>,
  ): Promise<{ error: ValidateStreamError; acceptCalls: number }> {
    const acceptSpy = vi.spyOn(ProjectionValidator.prototype, 'accept');
    try {
      const error = await run();
      return { error, acceptCalls: acceptSpy.mock.calls.length };
    } finally {
      acceptSpy.mockRestore();
    }
  }

  it('不完整 JSON 前缀后上游抛错：SOURCE_FAILED 优先，framer 不冲刷末行前缀', async () => {
    const fx = connectedFixture();
    const canary = new Error('prefix-canary-secret');
    let pulls = 0;
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        pulls += 1;
        yield incompletePrefix;
        throw canary;
      } finally {
        closed = true;
      }
    }

    const { error, acceptCalls } = await rejectionWithoutAcceptedPrefix(() =>
      rejectionOf(JSON.stringify(fx.manifest), source()),
    );
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED);
    expect(error.message).not.toContain('prefix-canary-secret');
    expect(error.cause).toBeUndefined();
    expect(acceptCalls).toBe(0);
    expect(pulls).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
  });

  it('不完整 JSON 前缀后出现非法 chunk：SOURCE_FAILED，不拉取后续 chunk', async () => {
    const fx = connectedFixture();
    let pulls = 0;
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        pulls += 1;
        yield incompletePrefix;
        pulls += 1;
        yield 'invalid-chunk-canary' as unknown as Uint8Array;
        pulls += 1;
        yield bytes('never-pulled\n');
      } finally {
        closed = true;
      }
    }

    const { error, acceptCalls } = await rejectionWithoutAcceptedPrefix(() =>
      rejectionOf(JSON.stringify(fx.manifest), source()),
    );
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED);
    expect(error.message).not.toContain('invalid-chunk-canary');
    expect(acceptCalls).toBe(0);
    expect(pulls).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
  });

  it('不完整 JSON 前缀后总量超 64 MiB：LIMIT 在 hash 前中止，framer 不冲刷前缀', async () => {
    const fx = connectedFixture();
    // 第一个 prefix 已计入总量；第二块会让累计值恰好超过 64 MiB 1 byte。
    const overBudget = new Uint8Array(
      STREAM_LINES_MAX_TOTAL_BYTES - incompletePrefix.byteLength + 1,
    );
    let pulls = 0;
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        pulls += 1;
        yield incompletePrefix;
        pulls += 1;
        yield overBudget;
        pulls += 1;
        yield bytes('never-pulled\n');
      } finally {
        closed = true;
      }
    }

    const { error, acceptCalls } = await rejectionWithoutAcceptedPrefix(() =>
      rejectionOf(JSON.stringify(fx.manifest), source()),
    );
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.LIMIT);
    expect(acceptCalls).toBe(0);
    expect(pulls).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(true);
  }, 30_000);

  it('首个 chunk 即为非法类型：SOURCE_FAILED 固定消息不回显 canary', async () => {
    const fx = connectedFixture();
    async function* source(): AsyncGenerator<Uint8Array> {
      yield 'direct-chunk-canary' as unknown as Uint8Array;
    }
    const error = await rejectionOf(JSON.stringify(fx.manifest), source());
    expect(error.code).toBe(VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED);
    expect(error.message).not.toContain('direct-chunk-canary');
    expect(error.cause).toBeUndefined();
  });
});
