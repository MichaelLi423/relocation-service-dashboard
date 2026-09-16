import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNPUBLISHED_MOBILE_READONLY_METADATA,
  validateMobileReadonlySnapshot,
  type MobileReadonlyPublishEnvelope,
  type MobileReadonlyPublishMetadata,
  type MobileReadonlySnapshot,
} from '../../shared/mobile-readonly';

/**
 * 云端信封存储（design D3/D6、tasks 4.3/4.5/7.1）。
 *
 * - 唯一权威文件：`<dataDir>/snapshots/current.json` =
 *   `{ currentVersion, publicationId, publishedAt, snapshot }`。
 * - 提交 = 先写同目录唯一临时文件并 fsync，再 rename 原子替换；校验失败/写盘失败保留旧包络。
 * - 同一时刻仅保留一份可读当前包络；串行处理上传（promise 队列），内存只作缓存、不是权威。
 * - 启动读文件恢复；从未成功提交时不创建文件、不虚构「版本 0」（逻辑元数据版本 0）。
 * - 重启仅清理本服务自己的遗留临时文件（`current.json.<hex>.tmp` 命名），绝不把它们当可读版本。
 */

/** 快照子目录名（唯一权威目录）。 */
export const MOBILE_READONLY_SNAPSHOTS_DIR = 'snapshots';
/** 当前包络文件名。 */
export const MOBILE_READONLY_CURRENT_FILE = 'current.json';
/** 临时文件后缀识别（仅清理本服务命名）。 */
const TMP_SUFFIX = '.tmp';
/** 校验过的 publicationId 长度上界（上传与信封恢复共用）。 */
export const MAX_PUBLICATION_ID_LENGTH = 200;
/** 包络 publishedAt 长度上界（服务端自身产出，结构校验即可）。 */
const MAX_PUBLISHED_AT_LENGTH = 64;

/** 注入时钟：publishedAt 由服务端接收时刻决定，独立于快照 dataAsOf。 */
export interface EnvelopeClock {
  nowIso(): string;
}

/** 存储 IO 抽象（默认真实文件系统；测试可注入失败以验证「失败保留旧内存+文件」）。 */
export interface EnvelopeIo {
  /** 确保快照目录存在。 */
  mkdirp(): void;
  /** 读取目录项名（不含完整路径）。 */
  list(): string[];
  /** 读取当前包络；不存在返回 null。 */
  readCurrent(): Buffer | null;
  /** 原子写入（临时文件 + rename）；抛错表示未提交成功。 */
  writeAtomic(data: Buffer): void;
  /** 清理本服务遗留的临时文件。 */
  cleanupAbandonedTmp(): void;
}

/** 默认文件系统 IO。 */
export function createNodeEnvelopeIo(snapshotsDir: string): EnvelopeIo {
  const currentPath = join(snapshotsDir, MOBILE_READONLY_CURRENT_FILE);
  const isOwnTmp = (name: string): boolean =>
    name.startsWith(`${MOBILE_READONLY_CURRENT_FILE}.`) && name.endsWith(TMP_SUFFIX);
  return {
    mkdirp(): void {
      mkdirSync(snapshotsDir, { recursive: true });
    },
    list(): string[] {
      return readdirSync(snapshotsDir);
    },
    readCurrent(): Buffer | null {
      try {
        return readFileSync(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    writeAtomic(data: Buffer): void {
      const tmpPath = join(snapshotsDir, `${MOBILE_READONLY_CURRENT_FILE}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`);
      try {
        writeFileSync(tmpPath, data, { encoding: 'utf8', flag: 'wx' });
        // 先 fsync 再 rename，尽量保证崩溃后 rename 内容完整（原子性由 rename 保证）。
        const fd = openSync(tmpPath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, currentPath);
      } catch (error) {
        // 保留任何部分写入的临时文件供启动清理策略处理；rename 未发生则当前文件不变。
        try {
          unlinkSync(tmpPath);
        } catch {
          // 忽略清理失败
        }
        throw error;
      }
    },
    cleanupAbandonedTmp(): void {
      for (const name of this.list()) {
        if (!isOwnTmp(name)) continue;
        try {
          unlinkSync(join(snapshotsDir, name));
        } catch {
          // 忽略（可能已被并发清理）
        }
      }
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSnapshot(value: unknown): MobileReadonlySnapshot {
  // 已通过共享严格校验器（含 schemaVersion/嵌套未知 key/金额/日期）。
  return value as MobileReadonlySnapshot;
}

/**
 * 校验并解析「服务端存储包络」。
 * currentVersion/publicationId/publishedAt 属于信封层（不属于业务快照白名单）；
 * snapshot 层以共享严格校验器深校验。非法即抛错（启动时失败快速、绝不降级服务脏数据）。
 */
export function parseStoredEnvelope(value: unknown): MobileReadonlyPublishEnvelope {
  if (!isPlainObject(value)) {
    throw new Error('current.json 不是对象');
  }
  const keys = Object.keys(value).sort();
  const expected = ['currentVersion', 'publishedAt', 'publicationId', 'snapshot'].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new Error(`current.json 信封键集不合法（应为 currentVersion/publicationId/publishedAt/snapshot）`);
  }
  const currentVersion = value.currentVersion;
  if (typeof currentVersion !== 'number' || !Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new Error('current.json 的 currentVersion 必须为不小于 1 的安全整数（无版本 0 文件）');
  }
  const publicationId = value.publicationId;
  if (typeof publicationId !== 'string' || publicationId.length === 0 || publicationId.length > MAX_PUBLICATION_ID_LENGTH) {
    throw new Error('current.json 的 publicationId 必须为非空且有界的字符串');
  }
  const publishedAt = value.publishedAt;
  if (typeof publishedAt !== 'string' || publishedAt.length === 0 || publishedAt.length > MAX_PUBLISHED_AT_LENGTH) {
    throw new Error('current.json 的 publishedAt 必须为非空字符串');
  }
  const validation = validateMobileReadonlySnapshot(value.snapshot);
  if (!validation.ok) {
    const sample = validation.issues
      .slice(0, 3)
      .map((i) => `[${i.path || '<root>'}] ${i.code}`)
      .join('；');
    throw new Error(`current.json 内快照未通过封闭白名单校验：${sample}`);
  }
  return {
    currentVersion,
    publicationId,
    publishedAt,
    snapshot: asSnapshot(value.snapshot),
  };
}

/** 序列化包络为落盘 Buffer（键序固定：currentVersion/publicationId/publishedAt/snapshot）。 */
export function serializeEnvelope(envelope: MobileReadonlyPublishEnvelope): Buffer {
  const payload = {
    currentVersion: envelope.currentVersion,
    publicationId: envelope.publicationId,
    publishedAt: envelope.publishedAt,
    snapshot: envelope.snapshot,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/** 已校验的上传候选。 */
export interface UploadCandidate {
  publicationId: string;
  expectedCurrentVersion: number;
  snapshot: MobileReadonlySnapshot;
}

/** 上传决策结果（幂等/冲突语义见 design D3）。 */
export type PublishOutcome =
  | { kind: 'committed'; envelope: MobileReadonlyPublishEnvelope }
  | { kind: 'idempotent'; envelope: MobileReadonlyPublishEnvelope }
  | { kind: 'conflict'; envelope: MobileReadonlyPublishEnvelope | null };

/** 由当前包络推导非业务版本元数据（尚未发布用共享冻结常量语义，返回全新对象防外部改写）。 */
export function envelopeMetadata(envelope: MobileReadonlyPublishEnvelope | null): MobileReadonlyPublishMetadata {
  if (envelope === null) {
    return { ...UNPUBLISHED_MOBILE_READONLY_METADATA };
  }
  return {
    published: true,
    currentVersion: envelope.currentVersion,
    publicationId: envelope.publicationId,
    publishedAt: envelope.publishedAt,
    dataAsOf: envelope.snapshot.dataAsOf,
    fingerprint: {
      contentGenerationId: envelope.snapshot.contentGenerationId,
      businessRevision: envelope.snapshot.businessRevision,
    },
  };
}

/**
 * 信封存储：串行提交 + 内存缓存。启动 init() 从文件恢复；从未成功提交保持 null（不造文件/版本 0）。
 */
export class EnvelopeStore {
  private envelope: MobileReadonlyPublishEnvelope | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: EnvelopeIo,
    private readonly clock: EnvelopeClock,
  ) {}

  /** 启动恢复：清理本服务遗留临时文件，再读 current.json；文件非法即抛错（快速失败）。 */
  init(): void {
    this.io.mkdirp();
    this.io.cleanupAbandonedTmp();
    const raw = this.io.readCurrent();
    if (raw === null) {
      this.envelope = null; // 从未成功提交：无文件、无版本 0
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('current.json 不是合法 JSON（拒绝以损坏包络启动）');
    }
    this.envelope = parseStoredEnvelope(parsed);
  }

  /** 当前内存缓存包络（null = 尚未发布）。 */
  currentEnvelope(): MobileReadonlyPublishEnvelope | null {
    return this.envelope;
  }

  /** 当前非业务版本元数据。 */
  currentMetadata(): MobileReadonlyPublishMetadata {
    return envelopeMetadata(this.envelope);
  }

  /**
   * 串行条件替换/幂等/冲突决策（校验由调用方在入队前完成）。
   * 写盘失败抛错：内存与文件都保持旧值，不留半写。
   */
  publish(candidate: UploadCandidate): Promise<PublishOutcome> {
    const run = this.tail.then(() => this.publishSerialized(candidate));
    // 失败不中断后续串行提交。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private publishSerialized(candidate: UploadCandidate): PublishOutcome {
    const current = this.envelope;
    // 幂等仅对「当前存储 publicationId」生效（无历史库；重复当前 ID 不改版本/publishedAt/不替换）。
    if (current !== null && current.publicationId === candidate.publicationId) {
      return { kind: 'idempotent', envelope: current };
    }
    const expected = current === null ? 0 : current.currentVersion;
    if (candidate.expectedCurrentVersion !== expected) {
      // 过期/超前期望版本一律冲突：返回当前元数据（未发布即逻辑版本 0），绝不覆盖新快照。
      return { kind: 'conflict', envelope: current };
    }
    const next: MobileReadonlyPublishEnvelope = {
      currentVersion: expected + 1,
      publicationId: candidate.publicationId,
      publishedAt: this.clock.nowIso(),
      snapshot: candidate.snapshot,
    };
    // 先落盘成功才更新内存缓存；失败则内存仍为旧包络。
    this.io.writeAtomic(serializeEnvelope(next));
    this.envelope = next;
    return { kind: 'committed', envelope: next };
  }
}
