import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEmptySnapshotFixture, makeSnapshotFixture } from '../helpers/mobile-readonly-fixtures';
import type { MobileReadonlySnapshot } from '../../src/shared/mobile-readonly';
import {
  createNodeEnvelopeIo,
  EnvelopeStore,
  MOBILE_READONLY_CURRENT_FILE,
  type EnvelopeIo,
  type UploadCandidate,
} from '../../src/server/mobile-readonly/store';

/**
 * 云端信封存储与版本条件替换（tasks 4.3 / 4.5 / 7.1）：
 * - current.json 一次原子 rename；启动读文件恢复；从未提交无文件无版本 0；
 * - expectedCurrentVersion 一致才提交（单调 +1）；过期拒绝并返回当前元数据；
 * - 幂等仅对当前 publicationId 生效（不改版本/publishedAt/不替换）；
 * - 写盘失败保留旧内存+文件；重启遗留临时文件不作为可读版本。
 */

const FIXED_ISO_BASE = '2026-08-08T09:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeTempDataDir(): string {
  const dir = join(tmpdir(), `mr-store-${Math.random().toString(36).slice(2, 8)}`);
  dirs.push(dir);
  return dir;
}

function snapshotsDirOf(dataDir: string): string {
  return join(dataDir, 'snapshots');
}

function clockAt(iso: string): { nowIso: () => string } {
  return { nowIso: () => iso };
}

function candidate(publicationId: string, expectedCurrentVersion: number, snapshot: MobileReadonlySnapshot): UploadCandidate {
  return { publicationId, expectedCurrentVersion, snapshot };
}

function buildAndInit(dataDir: string, nowIso = FIXED_ISO_BASE): EnvelopeStore {
  const store = new EnvelopeStore(createNodeEnvelopeIo(snapshotsDirOf(dataDir)), clockAt(nowIso));
  store.init();
  return store;
}

function readCurrentJson(dataDir: string): Buffer | null {
  try {
    return readFileSync(join(snapshotsDirOf(dataDir), MOBILE_READONLY_CURRENT_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function createSwitchableIo(base: EnvelopeIo): EnvelopeIo & { setWriteBehavior(mode: 'ok' | 'fail'): void } {
  let mode: 'ok' | 'fail' = 'ok';
  return {
    mkdirp: () => base.mkdirp(),
    list: () => base.list(),
    readCurrent: () => base.readCurrent(),
    writeAtomic: (data) => {
      if (mode === 'fail') throw new Error('模拟写盘失败');
      base.writeAtomic(data);
    },
    cleanupAbandonedTmp: () => base.cleanupAbandonedTmp(),
    setWriteBehavior(next) {
      mode = next;
    },
  };
}

describe('从未提交：无文件、无版本 0（D6/7.1）', () => {
  it('init 后不创建 current.json，元数据如实返回尚未发布（逻辑版本 0，无文件）', () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir);
    expect(store.currentEnvelope()).toBeNull();
    expect(readCurrentJson(dataDir)).toBeNull();
    expect(readdirSync(snapshotsDirOf(dataDir))).toEqual([]);
    const metadata = store.currentMetadata();
    expect(metadata.published).toBe(false);
    expect(metadata.currentVersion).toBe(0);
    expect(metadata.publicationId).toBeNull();
    expect(metadata.publishedAt).toBeNull();
    expect(metadata.dataAsOf).toBeNull();
    expect(metadata.fingerprint).toBeNull();
  });

  it('首份候选携带 expectedCurrentVersion=0 可提交为版本 1（含合法空集合快照）', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir, '2026-08-08T09:00:01.000Z');
    const outcome = await store.publish(candidate('P-empty', 0, makeEmptySnapshotFixture()));
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    expect(outcome.envelope.currentVersion).toBe(1);
    expect(outcome.envelope.publicationId).toBe('P-empty');
    expect(outcome.envelope.publishedAt).toBe('2026-08-08T09:00:01.000Z');
    expect(readCurrentJson(dataDir)).not.toBeNull();
  });
});

describe('版本条件替换与幂等（tasks 4.3）', () => {
  it('期望版本一致则提交（版本 +1、新 publicationId、publishedAt=服务端时钟，dataAsOf 独立保留）', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir, '2026-08-08T09:00:00.000Z');
    const snapshot = makeSnapshotFixture();
    const outcome = await store.publish(candidate('P-1', 0, snapshot));
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    expect(outcome.envelope.currentVersion).toBe(1);
    expect(outcome.envelope.publicationId).toBe('P-1');
    expect(outcome.envelope.publishedAt).toBe('2026-08-08T09:00:00.000Z');
    // dataAsOf 来自快照头部，与服务端 publishedAt 分开。
    expect(outcome.envelope.snapshot.dataAsOf).toBe(snapshot.dataAsOf);

    const second = await store.publish(candidate('P-2', 1, makeSnapshotFixture()));
    expect(second.kind).toBe('committed');
    if (second.kind !== 'committed') return;
    expect(second.envelope.currentVersion).toBe(2);
    expect(second.envelope.publicationId).toBe('P-2');
  });

  it('期望版本过期则冲突并返回当前包络（不覆盖、版本不前进）', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir);
    await store.publish(candidate('P-1', 0, makeSnapshotFixture()));
    const fileBefore = readCurrentJson(dataDir);
    const outcome = await store.publish(candidate('P-2', 0, makeSnapshotFixture()));
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') return;
    expect(outcome.envelope?.publicationId).toBe('P-1');
    expect(outcome.envelope?.currentVersion).toBe(1);
    expect(store.currentEnvelope()?.currentVersion).toBe(1);
    expect(readCurrentJson(dataDir)).toEqual(fileBefore);
  });

  it('重复当前 publicationId 幂等成功：版本不变、publishedAt 不变、文件不替换', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir, '2026-08-08T09:00:00.000Z');
    await store.publish(candidate('P-dup', 0, makeSnapshotFixture()));
    const fileBefore = readCurrentJson(dataDir);
    const metadataBefore = store.currentMetadata();

    const retry = await store.publish(candidate('P-dup', 0, makeSnapshotFixture({ businessRevision: 999 })));
    expect(retry.kind).toBe('idempotent');
    if (retry.kind !== 'idempotent') return;
    expect(retry.envelope.publicationId).toBe('P-dup');
    expect(retry.envelope.currentVersion).toBe(1);
    expect(retry.envelope.publishedAt).toBe('2026-08-08T09:00:00.000Z');
    expect(store.currentMetadata()).toEqual(metadataBefore);
    expect(readCurrentJson(dataDir)).toEqual(fileBefore);
  });

  it('更早候选无历史一律按冲突处理（幂等仅对当前 publicationId 生效）', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir);
    await store.publish(candidate('P-1', 0, makeSnapshotFixture()));
    await store.publish(candidate('P-2', 1, makeSnapshotFixture()));
    // 迟到的 P-1（早于当前、期望版本也过期）按冲突处理，快照（版本 2）保持不变。
    const late = await store.publish(candidate('P-1', 1, makeSnapshotFixture()));
    expect(late.kind).toBe('conflict');
    if (late.kind !== 'conflict') return;
    expect(late.envelope?.publicationId).toBe('P-2');
    expect(late.envelope?.currentVersion).toBe(2);
  });

  it('写盘失败保留旧内存与旧文件；同一实例 IO 恢复后队列不中断、下版本恰好 +1', async () => {
    const dataDir = makeTempDataDir();
    const io = createSwitchableIo(createNodeEnvelopeIo(snapshotsDirOf(dataDir)));
    const store = new EnvelopeStore(io, clockAt(FIXED_ISO_BASE));
    store.init();
    await store.publish(candidate('P-1', 0, makeSnapshotFixture()));
    const fileBefore = readCurrentJson(dataDir);

    // 同一 store：写盘失败 → 内存缓存与文件都保留旧包络（版本 1 / P-1）。
    io.setWriteBehavior('fail');
    await expect(store.publish(candidate('P-2', 1, makeSnapshotFixture()))).rejects.toThrow('模拟写盘失败');
    expect(store.currentEnvelope()?.publicationId).toBe('P-1');
    expect(store.currentEnvelope()?.currentVersion).toBe(1);
    expect(readCurrentJson(dataDir)).toEqual(fileBefore);

    // IO 恢复后仍用同一 store 实例：队列未中断，下一提交恰好 +1（版本 2，P-3）。
    io.setWriteBehavior('ok');
    const outcome = await store.publish(candidate('P-3', 1, makeSnapshotFixture({ businessRevision: 3 })));
    expect(outcome.kind).toBe('committed');
    if (outcome.kind !== 'committed') return;
    expect(outcome.envelope.currentVersion).toBe(2);
    expect(outcome.envelope.publicationId).toBe('P-3');
    const fileAfter = readCurrentJson(dataDir);
    expect(fileAfter).not.toBeNull();
    expect(JSON.parse(fileAfter!.toString('utf8'))).toMatchObject({ currentVersion: 2, publicationId: 'P-3' });
  });
});

describe('提交成功响应丢失 + 服务重启恢复（tasks 4.5）', () => {
  it('推进到版本 8 后重启从文件恢复，同 publicationId/同候选（expected=7、同一快照）重试幂等', async () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir, '2026-08-08T09:00:00.000Z');
    let lastCandidate: UploadCandidate | null = null;
    for (let version = 1; version <= 8; version += 1) {
      const snapshot = makeSnapshotFixture({ businessRevision: version });
      lastCandidate = candidate(`P-v${version}`, version - 1, snapshot);
      const outcome = await store.publish(lastCandidate);
      expect(outcome.kind).toBe('committed');
    }
    const committedFile = readCurrentJson(dataDir);
    const committedMetadata = store.currentMetadata();
    expect(committedMetadata.currentVersion).toBe(8);
    expect(committedMetadata.publicationId).toBe('P-v8');
    expect(lastCandidate).not.toBeNull();

    // 模拟重启：新 store 从文件恢复（时钟不同也不影响已发布的 publishedAt）。
    const recovered = buildAndInit(dataDir, '2026-09-01T00:00:00.000Z');
    expect(recovered.currentMetadata().currentVersion).toBe(8);
    expect(recovered.currentMetadata().publicationId).toBe('P-v8');
    expect(recovered.currentMetadata().publishedAt).toBe(committedMetadata.publishedAt);

    // 响应丢失后桌面以「第 8 份原始候选」重试：publicationId=P-v8、expectedCurrentVersion=7、
    // 同一快照（businessRevision=8）→ 幂等成功：版本 8、publishedAt 不变、文件字节不变。
    const retry = await recovered.publish(lastCandidate!);
    expect(retry.kind).toBe('idempotent');
    if (retry.kind !== 'idempotent') return;
    expect(retry.envelope.currentVersion).toBe(8);
    expect(retry.envelope.publicationId).toBe('P-v8');
    expect(retry.envelope.publishedAt).toBe(committedMetadata.publishedAt);
    expect(retry.envelope.snapshot).toEqual(lastCandidate!.snapshot);
    expect(readCurrentJson(dataDir)).toEqual(committedFile);

    // 另一个更早候选（P-v7）按冲突返回当前版本元数据。
    const stale = await recovered.publish(candidate('P-v7', 7, makeSnapshotFixture()));
    expect(stale.kind).toBe('conflict');
    if (stale.kind !== 'conflict') return;
    expect(stale.envelope?.currentVersion).toBe(8);
    expect(stale.envelope?.publicationId).toBe('P-v8');
  });
});

describe('启动恢复与文件健壮性（tasks 7.5）', () => {
  it('重启清理本服务遗留临时文件；遗留临时文件绝不成为可读版本', () => {
    const dataDir = makeTempDataDir();
    const store = buildAndInit(dataDir);
    expect(store.currentEnvelope()).toBeNull();

    // 模拟上次写入中断遗留：一个带合法信封内容的临时文件 + 一个无关文件。
    const snapshotsDir = snapshotsDirOf(dataDir);
    mkdirSync(snapshotsDir, { recursive: true });
    const legitEnvelope = JSON.stringify({
      currentVersion: 9,
      publicationId: 'P-abandoned',
      publishedAt: FIXED_ISO_BASE,
      snapshot: makeEmptySnapshotFixture(),
    });
    writeFileSync(join(snapshotsDir, `current.json.deadbeef12ab${'.tmp'}`), legitEnvelope, 'utf8');
    writeFileSync(join(snapshotsDir, 'current.json.backup'), legitEnvelope, 'utf8');

    const recovered = buildAndInit(dataDir);
    // 遗留 tmp 不作为可读版本：从未成功提交 → 仍为尚未发布。
    expect(recovered.currentEnvelope()).toBeNull();
    const names = readdirSync(snapshotsDir).sort();
    // 只清理自己的 `.tmp`，无关 backup 保留。
    expect(names).toEqual(['current.json.backup']);
  });

  it('current.json 损坏（非 JSON / 信封非法 / 快照含嵌套未知 key）启动即失败', () => {
    const dataDir = makeTempDataDir();
    const snapshotsDir = snapshotsDirOf(dataDir);
    mkdirSync(snapshotsDir, { recursive: true });

    writeFileSync(join(snapshotsDir, MOBILE_READONLY_CURRENT_FILE), '{{{ not json', 'utf8');
    expect(() => buildAndInit(dataDir)).toThrow(/JSON/);

    writeFileSync(
      join(snapshotsDir, MOBILE_READONLY_CURRENT_FILE),
      JSON.stringify({ currentVersion: 0, publicationId: 'P', publishedAt: FIXED_ISO_BASE, snapshot: makeEmptySnapshotFixture() }),
      'utf8',
    );
    expect(() => buildAndInit(dataDir)).toThrow(/不小于 1/);

    const withUnknownKey = JSON.parse(
      JSON.stringify({
        currentVersion: 1,
        publicationId: 'P',
        publishedAt: FIXED_ISO_BASE,
        snapshot: makeEmptySnapshotFixture(),
      }),
    ) as { snapshot: { projects: Array<Record<string, unknown>> } };
    // 空快照项目为空：往 snapshot 顶层塞未知键验证嵌套校验。
    const parsed = withUnknownKey.snapshot as unknown as Record<string, unknown>;
    parsed.sneaky = 1;
    writeFileSync(join(snapshotsDir, MOBILE_READONLY_CURRENT_FILE), JSON.stringify({ ...withUnknownKey }), 'utf8');
    expect(() => buildAndInit(dataDir)).toThrow(/白名单|未知/);
  });
});
