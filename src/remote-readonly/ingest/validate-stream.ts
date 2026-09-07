/**
 * validate-stream（tasks 3.2 coordinator 切片）
 *
 * 把「manifest 文本 + 原始 JSONL 字节流」收束为一次完整投影校验：
 * - 1) parseManifestText 严格解析 manifest；任何解析错误（含重复 JSON 键/未知键/
 *      format/计数/日期格式等）→ INVALID_MANIFEST；
 * - 2) 在拉取任何正文 chunk 之前校验 manifest 声明实体计数总和 ≤ PROJECTION_MAX_RECORDS，
 *      超限 → LIMIT（0 pulls）；
 * - 3) 逐 chunk 预处理原始字节：必须是 Uint8Array；原始总量 ≤ 64 MiB。类型校验与总量
 *      校验都发生在 hash.update 之前——超限/非法 chunk 不会被哈希，也不会喂给 framer；
 *      sha256 累加「精确原始字节」（含 LF/CR，manifest 自身不计入）；
 * - 4) 同一字节流喂给 frameProjectionLines 切行，行文本依次经 ProjectionValidator.accept；
 * - 5) 流结束后 validator.finish()（精确计数/项目存在/引用同项目校验），随后比对
 *      sha256 hex 与 manifest.checksum.hex，不一致 → CHECKSUM_MISMATCH；
 * - 6) 成功只返回安全结果：解析后的 manifest 副本 + 原始字节数 + 已接受记录数；
 *      不含任何业务记录值/完整行/SQL/路径。
 *
 * 字节层故障优先：tap 发现非法 chunk 类型 / 原始总量超 64 MiB / 上游迭代器抛错时，
 * 先记录受控故障码（SOURCE_FAILED/LIMIT），再抛「固定内部哨兵错误」中止整个流——
 * 绝不让 framer 看到正常 EOF（否则 framer 会把未完成的行前缀当合法末行冲刷，
 * 用 INVALID_RECORDS 掩盖真实的 SOURCE_FAILED/LIMIT）。coordinator 外层 catch 优先
 * 读取故障码并重建新的 ValidateStreamError；其余到达错误按「是否已知受控码」重建，
 * 未知一律 INVALID_RECORDS。所有重建均不携带原对象的 message/cause/键/值。
 *
 * 任一环节失败整体拒绝（无部分成功）。边界声明：本切片不含 disk/HTTP/auth/worker/
 * activation；manifest 文本语法、单行 schema/重复键/引用与计数校验全部委托给
 * parseManifestText / strict-json / ProjectionValidator / frameProjectionLines。
 */
import { createHash } from 'node:crypto';
import {
  PROJECTION_ENTITY_TYPES,
  type RemoteProjectionManifest,
} from '../../shared/remote-readonly/manifest';
import { frameProjectionLines, STREAM_LINES_MAX_TOTAL_BYTES } from './stream-lines';
import {
  parseManifestText,
  ProjectionValidator,
  PROJECTION_MAX_RECORDS,
} from './projection-validator';

/** 本模块稳定错误码（值即 wire code；message 只含该全码）。 */
export const VALIDATE_STREAM_ERROR_CODES = {
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  LIMIT: 'LIMIT',
  INVALID_RECORDS: 'INVALID_RECORDS',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  SOURCE_FAILED: 'SOURCE_FAILED',
} as const;

export type ValidateStreamErrorCode =
  (typeof VALIDATE_STREAM_ERROR_CODES)[keyof typeof VALIDATE_STREAM_ERROR_CODES];

type CodeKey = keyof typeof VALIDATE_STREAM_ERROR_CODES;

/** 固定 message 错误（只含全码，无任意文本/原始输入）。 */
export class ValidateStreamError extends Error {
  constructor(readonly code: ValidateStreamErrorCode) {
    super(`validate-stream ${code}`);
    this.name = 'ValidateStreamError';
  }
}

/** 成功返回的安全结果：manifest 副本 + 字节/记录计数，无任何记录内容。 */
export interface ProjectionStreamResult {
  /** 重新严格解析的 manifest（副本，不含调用方文本引用）。 */
  manifest: RemoteProjectionManifest;
  /** 参与 sha256 的原始正文字节总数（不含 manifest）。 */
  byteLength: number;
  /** ProjectionValidator.acceptedRecords：已接受记录行数。 */
  acceptedRecords: number;
}

const fail = (kind: CodeKey): ValidateStreamError =>
  new ValidateStreamError(VALIDATE_STREAM_ERROR_CODES[kind]);

/** 已知受控码集合：只允许重建本模块自己的码，防伪造 code 混入。 */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>(Object.values(VALIDATE_STREAM_ERROR_CODES));

function reconstructCode(code: unknown): ValidateStreamErrorCode {
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as ValidateStreamErrorCode)
    : VALIDATE_STREAM_ERROR_CODES.INVALID_RECORDS;
}

function declaredRecordTotal(manifest: RemoteProjectionManifest): number {
  let total = 0;
  for (const type of PROJECTION_ENTITY_TYPES) {
    total += manifest.entityCounts[type];
  }
  return total;
}

/**
 * 校验一次完整投影流。任一错误整体拒绝（抛 ValidateStreamError，无部分成功）。
 */
export async function validateProjectionStream(
  manifestText: string,
  rawChunks: AsyncIterable<Uint8Array>,
): Promise<ProjectionStreamResult> {
  let manifest: RemoteProjectionManifest;
  try {
    manifest = parseManifestText(manifestText);
  } catch {
    throw fail('INVALID_MANIFEST');
  }
  if (declaredRecordTotal(manifest) > PROJECTION_MAX_RECORDS) {
    // 拉取正文前拒绝：rawChunks 不被触碰。
    throw fail('LIMIT');
  }

  let validator: ProjectionValidator;
  try {
    validator = new ProjectionValidator(manifest);
  } catch {
    throw fail('INVALID_MANIFEST');
  }

  const hash = createHash('sha256');
  let totalBytes = 0;
  // 字节层故障状态（可变对象，跨嵌套 generator/外层 catch 读取）：
  // 先记录受控码，再抛固定内部哨兵中止，绝不让 framer 正常 EOF 冲刷未完成前缀。
  const faultState: { code: ValidateStreamErrorCode | null } = { code: null };
  // 固定内部哨兵：错误对象本身不含任何原始数据，仅用于中止字节流。
  const rawAbort = new Error('validate-stream raw abort');

  // 字节预处理 tap：类型/总量校验 → hash.update → 原样喂给 framer。
  const tapped = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of rawChunks) {
        if (!(chunk instanceof Uint8Array)) {
          faultState.code = VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED;
          throw rawAbort;
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > STREAM_LINES_MAX_TOTAL_BYTES) {
          // hash.update 之前拒绝：该 chunk 不会被哈希。
          faultState.code = VALIDATE_STREAM_ERROR_CODES.LIMIT;
          throw rawAbort;
        }
        hash.update(chunk);
        yield chunk;
      }
    } catch (error) {
      if (error !== rawAbort) {
        // 上游迭代器自身抛错（含伪造/篡改错误）→ sanitize 为 SOURCE_FAILED。
        faultState.code = VALIDATE_STREAM_ERROR_CODES.SOURCE_FAILED;
      }
      throw rawAbort;
    }
  })();

  try {
    for await (const line of frameProjectionLines(tapped)) {
      validator.accept(line);
    }
    validator.finish();
    const actualHex = hash.digest('hex');
    if (actualHex !== manifest.checksum.hex) {
      throw fail('CHECKSUM_MISMATCH');
    }
    return {
      manifest,
      byteLength: totalBytes,
      acceptedRecords: validator.acceptedRecords,
    };
  } catch (error) {
    if (faultState.code !== null) {
      // 字节层故障优先：无论 framer 如何折叠哨兵错误，都重建真实故障码。
      throw new ValidateStreamError(faultState.code);
    }
    // 其余到达错误按受控码重建：已知码保留，未知/非本模块码一律 INVALID_RECORDS；
    // 原错误对象（含伪造 message/cause）永不外泄。
    const code = error instanceof ValidateStreamError ? error.code : undefined;
    throw new ValidateStreamError(reconstructCode(code));
  }
}
