/**
 * control-store.test.ts（tasks 2.3 canonical 状态/队列持久化切片）
 *
 * 用真实临时 SQLite（经 control-paths prepareControlDatabasePath 产出的固定安全路径）
 * 验证 store 消费规范 consent 模型持久化 PersistedControlState：
 * - 全新目录 reopen：默认 disabled 单例，无并行 enabled 布尔、绝不自动启用；
 * - configure → confirm(exactFullConsent) → enabled；configure 输入/完整同意被
 *   canonical 严格 parse 拒绝时不落库（gate 校验在 store 内完成，非仅调用方）；
 * - A→B→A configure 相对上一持久化值仍清 consent 与队列（不恢复旧同意）；
 * - confirm 的 exactFullConsent 不匹配当前 descriptor/binding → 拒绝；
 * - localStop/invalidate 状态转换与 revision 递增；reopen 持久化；
 * - queue(contextRevision, closedMetadata)：BEGIN IMMEDIATE CAS，stale revision 拒绝；
 *   closed 元数据 unknown 键/越界/非严格 ISO/epoch·lineage 不匹配 → 拒绝；
 *   持久化只含 publicationId/epoch/lineage/sequence/createdAt（无 body/业务值）；
 * - 两个连接并发：一方 disable 后另一方 stale enqueue 拒绝；
 * - reopen 后读取损坏 state_json / 未知 user_version / 缺列 / 队列行 invariant 破坏
 *   → 打开失败且 generic CONTROL_DB_CORRUPT（无 SQL/路径/原始 cause），不自动重置；
 * - 已存在的 0 字节 control.db（正常库被截断）→ reopen 按既有损坏 CONTROL_DB_CORRUPT
 *   拒绝并保留原文件（仅当 control-paths 本次实际新建 createdDb=true 才初始化，BUG2）；
 *   集成侧「helper 先 prepare 出文件再由 store 打开」的场景只调用一次 open，不以
 *   size===0 推断是否新库。
 *
 * 全部 synthetic：target https://publish.synth.test；UUID 为合成形状；无真实端点/业务数据。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CONSENT_PROJECTION_VERSION,
  CONSENT_RETENTION_EXPLANATION_VERSION,
  fieldScopeDigest,
} from '../../src/main/remote-readonly/consent';
import {
  CONTROL_DB_NAME,
} from '../../src/main/remote-readonly/control-paths';
import {
  ControlStore,
  ControlStoreError,
  openControlStore,
  type QueueClosedMetadata,
} from '../../src/main/remote-readonly/control-store';

const SYNTH_TARGET = 'https://publish.synth.test';
const SYNTH_TARGET_B = 'https://publish-alt.synth.test';
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';
const PUBLISHER = 'pub-synth-1';

const NOW = '2026-08-11T10:00:00.000Z';

interface Fixture {
  root: string;
  privateParentDir: string;
  businessDbPath: string;
  backupDir: string;
}

const rootsToClean: string[] = [];

function makeTempRoot(): string {
  const root = join(
    realpathSync(tmpdir()),
    `control-store-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  return root;
}

function newFixture(): Fixture {
  const root = makeTempRoot();
  const privateParentDir = join(root, 'app-private');
  const businessDir = join(root, 'business');
  const backupDir = join(businessDir, 'backups');
  mkdirSync(privateParentDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const businessDbPath = join(businessDir, 'workbench.db');
  writeFileSync(businessDbPath, 'SYNTHETIC-BUSINESS-DB-BYTES-NO-REAL-VALUE');
  return { root, privateParentDir, businessDbPath, backupDir };
}

function opts(f: Fixture) {
  return {
    privateParentDir: f.privateParentDir,
    businessDbPaths: [f.businessDbPath],
    businessBackupDirs: [f.backupDir],
  };
}

function openAt(f: Fixture): ControlStore {
  return openControlStore(opts(f));
}

function dbPathOf(f: Fixture): string {
  return join(f.privateParentDir, 'remote-readonly-control', CONTROL_DB_NAME);
}

afterEach(() => {
  for (const root of rootsToClean) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
  rootsToClean.length = 0;
});

/** 与当前 descriptor/binding 匹配的合成 descriptor/binding。 */
function descriptor(target = SYNTH_TARGET) {
  return {
    targetHttpsOrigin: target,
    projectionVersion: CONSENT_PROJECTION_VERSION,
    fieldScopeDigest: fieldScopeDigest(),
    retentionExplanationVersion: CONSENT_RETENTION_EXPLANATION_VERSION,
  };
}

function binding(epoch = 7, dbInstance = UUID_A, generation = UUID_B) {
  return {
    publisherId: PUBLISHER,
    authorizationEpoch: epoch,
    databaseInstanceId: dbInstance,
    contentGenerationId: generation,
  };
}

/** 队列 closed 元数据基（不含 publisherId——队列只存 epoch/lineage 等封闭字段）。 */
function queueMeta(overrides: Partial<QueueClosedMetadata> = {}): QueueClosedMetadata {
  return {
    publicationId: 'pub-q',
    authorizationEpoch: 7,
    databaseInstanceId: UUID_A,
    contentGenerationId: UUID_B,
    sequence: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function fullConsent(target = SYNTH_TARGET, epoch = 7, dbInstance = UUID_A, generation = UUID_B) {
  return {
    ...descriptor(target),
    ...binding(epoch, dbInstance, generation),
    targetConfirmed: true,
    scopeConfirmed: true,
    retentionConfirmed: true,
  };
}

function expectStoreError(fn: () => unknown, code: string): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!(threw instanceof ControlStoreError)) {
    throw new Error(`expected ControlStoreError(${code}), got: ${String(threw)}`);
  }
  expect(threw.code).toBe(code);
  // metadata-only：message 只含稳定 code 模板
  expect(threw.message).toBe(`control store ${code}`);
}

/** 打开原始库并注入损坏/未知内容后关闭；随后 openControlStore 应 fail closed。 */
function corruptDb(f: Fixture, mutate: (raw: DatabaseSync, store: ControlStore) => void): void {
  const store = openAt(f);
  const raw = new DatabaseSync(dbPathOf(f));
  mutate(raw, store);
  raw.close();
  store.close();
}

describe('control store：全新默认 disabled（reopen 不自动启用）', () => {
  it('全新目录打开后 readCurrent 为默认 disabled 单例；reopen 保持', () => {
    const f = newFixture();
    const a = openAt(f);
    const s0 = a.readCurrent();
    expect(s0.state).toBe('disabled');
    expect(s0.revision).toBe(0);
    expect(s0.descriptor).toBeNull();
    expect(s0.binding).toBeNull();
    expect(s0.consent).toBeNull();
    a.close();

    const b = openAt(f);
    const s1 = b.readCurrent();
    expect(s1.state).toBe('disabled');
    expect(s1.revision).toBe(0);
    expect(s1.descriptor).toBeNull();
    expect(s1.binding).toBeNull();
    b.close();
  });

  it('未 configure 时 confirm/queue 拒绝（gate 在 store 内，无自动启用）', () => {
    const f = newFixture();
    const store = openAt(f);
    expectStoreError(() => store.confirm(fullConsent()), 'CONTROL_STATE_CONFLICT');
    expectStoreError(
      () => store.queue(0, queueMeta({ publicationId: 'pub-1' })),
      'CONTROL_STATE_CONFLICT',
    );
    expect(store.readCurrent().state).toBe('disabled');
    store.close();
  });
});

describe('control store：configure→confirm 门控在 store 内完成', () => {
  it('configure 后可 confirm；false/null 确认拒绝且不落库；reopen 保持 enabled', () => {
    const f = newFixture();
    const store = openAt(f);
    const afterConfig = store.configure(descriptor(), binding());
    expect(afterConfig.state).toBe('disabled');
    expect(afterConfig.revision).toBe(1);
    expect(afterConfig.consent).toBeNull();

    // 非字面 true 任一 → canonical parse 拒绝（store 内 gate）
    expectStoreError(
      () => store.confirm({ ...fullConsent(), targetConfirmed: false }),
      'CONTROL_INPUT_INVALID',
    );
    expectStoreError(
      () => store.confirm({ ...fullConsent(), scopeConfirmed: 'true' }),
      'CONTROL_INPUT_INVALID',
    );
    expect(store.readCurrent().state).toBe('disabled');
    expect(store.readCurrent().consent).toBeNull();

    const afterConfirm = store.confirm(fullConsent());
    expect(afterConfirm.state).toBe('enabled');
    expect(afterConfirm.revision).toBe(2);
    expect(afterConfirm.consent).toMatchObject({ targetConfirmed: true, scopeConfirmed: true, retentionConfirmed: true });
    store.close();

    const b = openAt(f);
    const reopened = b.readCurrent();
    expect(reopened.state).toBe('enabled');
    expect(reopened.revision).toBe(2);
    expect(reopened.descriptor).toEqual(descriptor());
    expect(reopened.binding).toEqual(binding());
    expect(reopened.consent).not.toBeNull();
    b.close();
  });

  it('confirm 的 exactFullConsent 与当前 descriptor/binding 不一致 → 拒绝且状态不变', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    // 用了另一 target 的完整同意
    expectStoreError(() => store.confirm(fullConsent(SYNTH_TARGET_B)), 'CONTROL_INPUT_INVALID');
    // epoch 不匹配
    expectStoreError(() => store.confirm(fullConsent(SYNTH_TARGET, 99)), 'CONTROL_INPUT_INVALID');
    // lineage 不匹配
    expectStoreError(
      () => store.confirm(fullConsent(SYNTH_TARGET, 7, UUID_B, UUID_A)),
      'CONTROL_INPUT_INVALID',
    );
    expect(store.readCurrent().state).toBe('disabled');
    store.close();
  });

  it('confirm 输入含未知键（含 secret 命名）→ 拒绝且 metadata-only 不回显', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    const canary = 'CANARY-CONFIRM-SECRET-99';
    let threw: unknown;
    try {
      store.confirm({ ...fullConsent(), token: canary });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ControlStoreError);
    expect((threw as ControlStoreError).code).toBe('CONTROL_INPUT_INVALID');
    expect((threw as Error).message).not.toMatch(/CANARY/);
    expect(store.readCurrent().state).toBe('disabled');
    store.close();
  });

  it('configure 输入被严格 parse 拒绝（未知键/版本/digest 错误）→ 不落库', () => {
    const f = newFixture();
    const store = openAt(f);
    expectStoreError(() => store.configure({ ...descriptor(), token: 'CANARY' }, binding()), 'CONTROL_INPUT_INVALID');
    expectStoreError(
      () => store.configure({ ...descriptor(), projectionVersion: 'future-v2' }, binding()),
      'CONTROL_INPUT_INVALID',
    );
    expectStoreError(
      () => store.configure(descriptor(), { ...binding(), authorizationEpoch: -1 }),
      'CONTROL_INPUT_INVALID',
    );
    expect(store.readCurrent().revision).toBe(0);
    store.close();
  });
});

describe('control store：configure A→B→A 清 consent 与队列；localStop/invalidate', () => {
  it('enabled 后 A→B→A configure：每次变化都 revision+1 清 consent 并清队列，A→B→A 不恢复旧同意', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    expect(store.readCurrent().state).toBe('enabled');

    // 入一条当前 binding 的队列
    store.queue(store.readCurrent().revision, queueMeta({ publicationId: 'pub-1' }));

    // 变化到 B（target 不同）
    const toB = store.configure(descriptor(SYNTH_TARGET_B), binding());
    expect(toB.state).toBe('disabled');
    expect(toB.revision).toBe(3);
    expect(toB.consent).toBeNull();
    expect(store.snapshot().queued).toHaveLength(0);

    // A→B→A：再变回 A（相对上一持久化值仍变化）→ 仍清空，绝不恢复
    const backToA = store.configure(descriptor(), binding());
    expect(backToA.state).toBe('disabled');
    expect(backToA.revision).toBe(4);
    expect(backToA.consent).toBeNull();
    expect(store.readCurrent().consent).toBeNull();
    store.close();
  });

  it('configure 完全未变化 → 幂等（不递增 revision、不清队列）', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    const rev = store.readCurrent().revision;
    store.queue(rev, queueMeta({ publicationId: 'pub-1' }));
    const again = store.configure(descriptor(), binding());
    expect(again.revision).toBe(rev);
    expect(store.snapshot().queued).toHaveLength(1);
    store.close();
  });

  it('localStop 后不自动恢复；invalidate 清 consent 并清队列，reopen 持久化 localStopped', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    store.queue(store.readCurrent().revision, queueMeta({ publicationId: 'pub-1' }));

    const stopped = store.stopLocally();
    expect(stopped.state).toBe('localStopped');
    expect(stopped.revision).toBe(store.readCurrent().revision - 1 + 1);
    // localStop 保留配置与 consent（报告面），但 gate 不再放行：queue 拒绝
    expectStoreError(
      () => store.queue(stopped.revision, queueMeta({ publicationId: 'pub-2', sequence: 2 })),
      'CONTROL_STATE_CONFLICT',
    );

    // invalidate 清 consent；队列仍可能残留（同事务清空在 invalidate 内完成）
    const invalidated = store.invalidate();
    expect(invalidated.state).toBe('disabled');
    expect(invalidated.consent).toBeNull();
    expect(store.snapshot().queued).toHaveLength(0);
    store.close();

    const b = openAt(f);
    const reopened = b.readCurrent();
    expect(reopened.state).toBe('disabled');
    expect(reopened.descriptor).toEqual(descriptor());
    b.close();
  });
});

describe('control store：queue 元数据 CAS 与 closed 校验', () => {
  it('queue 持久化 closed 元数据（无 body/业务值）；reopen 保留且仅元数据', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    const rev = store.readCurrent().revision;
    store.queue(rev, queueMeta({ publicationId: 'pub-1', sequence: 3 }));
    const snap = store.snapshot();
    expect(snap.queued).toEqual([
      {
        publicationId: 'pub-1',
        authorizationEpoch: 7,
        databaseInstanceId: UUID_A,
        contentGenerationId: UUID_B,
        sequence: 3,
        createdAt: NOW,
      },
    ]);
    store.close();

    const b = openAt(f);
    expect(b.snapshot().queued).toEqual(snap.queued);
    b.close();
  });

  it('stale contextRevision（CAS）与损坏 revision 拒绝，不插入', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    const rev = store.readCurrent().revision;
    // 过期 revision
    expectStoreError(
      () => store.queue(rev - 1, queueMeta({ publicationId: 'pub-stale' })),
      'CONTROL_QUEUE_STALE',
    );
    expectStoreError(
      () => store.queue(rev + 5, queueMeta({ publicationId: 'pub-future' })),
      'CONTROL_QUEUE_STALE',
    );
    expectStoreError(
      () => store.queue(-1, queueMeta({ publicationId: 'pub-neg' })),
      'CONTROL_QUEUE_INVALID',
    );
    expect(store.snapshot().queued).toHaveLength(0);
    store.close();
  });

  it('closed 元数据 unknown 键（含 secret 命名）/越界/非严格 ISO → 拒绝且不回显', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    store.confirm(fullConsent());
    const rev = store.readCurrent().revision;
    const canary = 'CANARY-QUEUE-SECRET-1';
    expectStoreError(
      () => store.queue(rev, { ...queueMeta({ publicationId: 'pub-1' }), token: canary }),
      'CONTROL_QUEUE_INVALID',
    );
    // epoch/lineage 与当前 binding 不一致 → 拒绝
    expectStoreError(
      () => store.queue(rev, queueMeta({ publicationId: 'pub-2', authorizationEpoch: 99 })),
      'CONTROL_QUEUE_INVALID',
    );
    expectStoreError(
      () =>
        store.queue(
          rev,
          queueMeta({ publicationId: 'pub-3', databaseInstanceId: UUID_B, contentGenerationId: UUID_A }),
        ),
      'CONTROL_QUEUE_INVALID',
    );
    // 越界 / 非严格 ISO
    expectStoreError(
      () => store.queue(rev, queueMeta({ publicationId: 'x'.repeat(200) })),
      'CONTROL_QUEUE_INVALID',
    );
    expectStoreError(
      () => store.queue(rev, queueMeta({ publicationId: 'pub-4', createdAt: '2026-08-11 10:00:00' })),
      'CONTROL_QUEUE_INVALID',
    );
    expectStoreError(
      () => store.queue(rev, queueMeta({ publicationId: 'pub-5', sequence: 1.5 })),
      'CONTROL_QUEUE_INVALID',
    );
    expect(store.snapshot().queued).toHaveLength(0);
    store.close();
  });

  it('两个连接并发：一方 invalidate 后，另一方 stale enqueue 拒绝且不插入', () => {
    const f = newFixture();
    const a = openAt(f);
    a.configure(descriptor(), binding());
    a.confirm(fullConsent());
    const revA = a.readCurrent().revision;

    // 第二个连接同时打开（同一私有根）看到相同 enabled 状态
    const b = openAt(f);
    expect(b.readCurrent().state).toBe('enabled');
    const revB = b.readCurrent().revision;
    expect(revB).toBe(revA);

    // A invalidate → disabled 且 revision 递增
    a.invalidate();
    expect(a.readCurrent().state).toBe('disabled');

    // B 仍持旧 revision 入队：B 读到已提交的 disabled（fail closed），拒绝且不插入
    // （同库互斥写 + CAS：无论先报 CONFLICT 还是 STALE，都必须拒绝陈旧上下文）。
    let rejected = false;
    try {
      b.queue(revB, queueMeta({ publicationId: 'pub-stale' }));
    } catch (err) {
      rejected = err instanceof ControlStoreError;
    }
    expect(rejected).toBe(true);
    expect(b.readCurrent().state).toBe('disabled'); // B 已看到失效后的状态
    expect(b.snapshot().queued).toHaveLength(0);
    a.close();
    b.close();
  });
});

describe('control store：损坏/未知 schema 严格拒绝（fail closed，不自动重置）', () => {
  it('user_version 未知 → open 失败 CONTROL_DB_CORRUPT（generic，无 SQL/路径原文）', () => {
    const f = newFixture();
    corruptDb(f, (raw) => {
      raw.exec('PRAGMA user_version = 999;');
    });
    expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
  });

  it('state_json 损坏（非法 JSON / 未知键 / state 非法 / revision 非法）→ open 失败且不重置', () => {
    for (const badJson of [
      '{not-json',
      JSON.stringify({
        state: 'disabled',
        revision: 1,
        descriptor: null,
        binding: null,
        consent: null,
        extraTopLevelKey: true, // 未知顶层键 → parse 拒绝
      }),
      JSON.stringify({ state: 'purple', revision: 0, descriptor: null, binding: null, consent: null }),
      JSON.stringify({ state: 'disabled', revision: -3, descriptor: null, binding: null, consent: null }),
    ]) {
      const f = newFixture();
      corruptDb(f, (raw) => {
        raw.prepare('UPDATE control_state SET state_json = ? WHERE id = 1').run(badJson);
      });
      expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
      // 关闭后未重置：再次 open 仍失败
      expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
    }
  });

  it('control_state 单例行缺失/重复 → open 失败 CONTROL_DB_CORRUPT', () => {
    const f = newFixture();
    corruptDb(f, (raw) => {
      raw.prepare('DELETE FROM control_state').run();
    });
    expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
  });

  it('缺列/缺表 → open 失败 CONTROL_DB_CORRUPT', () => {
    const f = newFixture();
    corruptDb(f, (raw) => {
      raw.exec('ALTER TABLE control_queue DROP COLUMN created_at;');
    });
    expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');

    const g = newFixture();
    corruptDb(g, (raw) => {
      raw.exec('DROP TABLE control_queue;');
    });
    expectRejectedOpen(g, 'CONTROL_DB_CORRUPT');
  });

  it('队列行 epoch/lineage invariant 与当前 binding 不一致 → open 失败 CONTROL_DB_CORRUPT', () => {
    const f = newFixture();
    corruptDb(f, (raw) => {
      // 先写入 enabled 状态再破坏队列 invariant
      raw
        .prepare(
          `UPDATE control_state SET state_json = ? WHERE id = 1`,
        )
        .run(
          JSON.stringify({
            state: 'enabled',
            revision: 2,
            descriptor: descriptor(),
            binding: binding(),
            consent: fullConsent(),
          }),
        );
      raw
        .prepare(
          `INSERT INTO control_queue (
             publication_id, authorization_epoch, database_instance_id,
             content_generation_id, sequence, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('pub-bad', 999, UUID_A, UUID_B, 1, NOW);
    });
    expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
  });

  it('错误 generic：message 只含稳定 code，不回显 SQL/路径/原始 cause', () => {
    const f = newFixture();
    corruptDb(f, (raw) => {
      raw.exec('PRAGMA user_version = 999;');
    });
    let threw: unknown;
    try {
      openAt(f);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(ControlStoreError);
    const err = threw as ControlStoreError;
    expect(err.code).toBe('CONTROL_DB_CORRUPT');
    expect(err.message).toBe('control store CONTROL_DB_CORRUPT');
    expect(err.message).not.toMatch(/sqlite|SQL|remote-readonly-control|control\.db|999/i);
  });

  it('db 文件不存在但私有根存在 → 默认 disabled（缺失 fail closed 而非损坏）', () => {
    const f = newFixture();
    const store = openAt(f);
    expect(store.readCurrent().state).toBe('disabled');
    store.close();
    expect(existsSync(dbPathOf(f))).toBe(true);
  });

  it('正常 store 关闭后外部把 control.db 截断为 0 字节 → reopen 拒绝 CONTROL_DB_CORRUPT 且保留 0 字节', () => {
    const f = newFixture();
    const store = openAt(f);
    store.configure(descriptor(), binding());
    expect(store.readCurrent().state).toBe('disabled');
    store.close();
    // 模拟崩溃/截断：正常库被外部清空为 0 字节（内容已毁，非「未初始化新文件」）。
    const dbPath = dbPathOf(f);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
    writeFileSync(dbPath, '');
    expect(statSync(dbPath).size).toBe(0);
    // 旧实现会因 size===0 误判为「新文件」并静默重建；新实现必须按既有损坏拒绝，绝不覆盖。
    expectRejectedOpen(f, 'CONTROL_DB_CORRUPT');
    expect(statSync(dbPath).size).toBe(0);
  });
});

/** 断言 openAt(f) 抛 CONTROL_DB_CORRUPT 且不再残留可打开状态。 */
function expectRejectedOpen(f: Fixture, code: string): void {
  expectStoreError(() => openAt(f), code);
  // 再次 open 同样失败（无自动重置）
  expectStoreError(() => openAt(f), code);
}
