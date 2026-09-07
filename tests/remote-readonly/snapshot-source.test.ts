/**
 * snapshot-source.test.ts（tasks 2.2 snapshot-source 切片）
 *
 * 用真实临时 WAL SQLite 源库（含 database_metadata 身份单行 + 业务表 events + v10 业务修订
 * 触发器）验证 withPublicationSnapshot 生命周期：
 * - 成功：consumer 收到只读快照 db + 与源库一致的身份；快照 = 与身份同一备份副本的
 *   一致已提交视图（不宣称精确时间点）；
 * - 并发：第二连接持有未提交事务写入身份+业务行期间执行快照 → 快照为上一已提交
 *   revision/内容；随后源库可正常 commit，且不影响已产出的快照；
 * - 只读：consumer 尝试对快照写 → SQLite 拒绝（readonly）；
 * - 失败路径：backup 失败（源库已关闭）→ metadata-only SNAPSHOT_BACKUP_FAILED，源库
 *   字节/状态不变，临时目录与快照文件被清理；consumer 自身抛错 → 原样上抛且清理发生；
 * - 清理失败（内置 fault 注入 rmSync/close）：即使 consumer 成功也抛
 *   SNAPSHOT_CLEANUP_FAILED（close 失败仍继续尝试删除；错误 metadata-only 不回显路径）；
 * - 权限：临时目录 0700、快照文件 0600（回调期间从磁盘验证）；
 * - 错误不回显路径/文件/canary。
 *
 * 全部 synthetic（无真实业务/客户值），遵循项目真实临时 SQLite 测试惯例。
 * fault 注入使用 Vitest 内置 vi.mock 委托真实模块（默认不启用、按 flag 打开），
 * 不引入生产配置选项或新抽象。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDatabaseIdentity } from '../../src/domain/capabilities/local-data-persistence/identity';
import {
  withPublicationSnapshot,
  SnapshotSourceError,
  SNAPSHOT_TEMP_DIR_PERMISSION,
  SNAPSHOT_FILE_PERMISSION,
} from '../../src/main/remote-readonly/snapshot-source';

/** fault 注入开关（vi.mock 委托真实模块；默认关闭，仅清理失败用例置 true）。 */
const faultState = { failRm: false, failClose: false };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (faultState.failRm) throw new Error('injected rm failure');
      return (actual.rmSync as (...a: Parameters<typeof actual.rmSync>) => void)(...args);
    },
  };
});

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  return {
    ...actual,
    DatabaseSync: class extends (actual.DatabaseSync as typeof DatabaseSync) {
      override close(): void {
        if (faultState.failClose) throw new Error('injected close failure');
        return super.close();
      }
    },
  };
});

const rootsToClean: string[] = [];

function makeRoot(): string {
  const root = join(
    realpathSync(tmpdir()),
    `snapshot-source-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  return root;
}

interface Fixture {
  root: string;
  sourceDbPath: string;
  privateTempParent: string;
}

/** 最小真实 WAL 源库：database_metadata 身份单行 + 业务表 events + v10 修订触发器。 */
function openSourceDb(f: Fixture): DatabaseSync {
  const db = new DatabaseSync(f.sourceDbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE database_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      database_instance_id TEXT NOT NULL,
      content_generation_id TEXT NOT NULL,
      business_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL
    ) STRICT;
  `);
  db.prepare(
    `INSERT INTO database_metadata
       (id, database_instance_id, content_generation_id, business_revision, created_at, updated_at)
     VALUES (1, ?, ?, 0, ?, ?)`,
  ).run('instance-synth-1', 'generation-synth-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  // v10 业务修订触发器：任何 events 写入单调递增 business_revision。
  db.exec(`
    CREATE TRIGGER trg_business_revision_events_insert
      AFTER INSERT ON events
      BEGIN UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1; END;
    CREATE TRIGGER trg_business_revision_events_update
      AFTER UPDATE ON events
      BEGIN UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1; END;
    CREATE TRIGGER trg_business_revision_events_delete
      AFTER DELETE ON events
      BEGIN UPDATE database_metadata SET business_revision = business_revision + 1 WHERE id = 1; END;
  `);
  // e1 使业务修订 0 → 1
  db.prepare('INSERT INTO events VALUES (?, ?)').run('e1', 'baseline');
  return db;
}

function newFixture(): Fixture {
  const root = makeRoot();
  const privateTempParent = join(root, 'snapshot-temp');
  mkdirSync(privateTempParent, { recursive: true, mode: 0o700 });
  return { root, sourceDbPath: join(root, 'source.db'), privateTempParent };
}

function tempDirsIn(f: Fixture): string[] {
  if (!existsSync(f.privateTempParent)) return [];
  return readdirSync(f.privateTempParent).filter((n) => n.startsWith('readonly-snapshot-'));
}

function expectStoreSnapshotError(threw: unknown, code: string): void {
  expect(threw).toBeInstanceOf(SnapshotSourceError);
  expect((threw as SnapshotSourceError).code).toBe(code);
  expect((threw as Error).message).toBe(`snapshot source ${code}`);
}

afterEach(() => {
  faultState.failRm = false;
  faultState.failClose = false;
  for (const root of rootsToClean) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
  rootsToClean.length = 0;
});

describe('snapshot-source：成功快照与身份一致性', () => {
  it('consumer 收到只读快照：身份与源一致，快照=已提交内容；快照后源可继续写', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    // e2 → 修订 2
    source.prepare('INSERT INTO events VALUES (?, ?)').run('e2', 'second');
    const before = readDatabaseIdentity(source);
    expect(before.businessRevision).toBe(2);

    let sawIdentity = false;
    await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
      // 身份从快照读取，与源库一致
      expect(snap.identity).toEqual(before);
      sawIdentity = true;
      const events = snap.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(events.n).toBe(2);
      const rev = snap.db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as {
        business_revision: number;
      };
      expect(rev.business_revision).toBe(2);
    });
    expect(sawIdentity).toBe(true);
    // 回调后仍可继续写源库（快照不阻塞源）；修订 3
    source.prepare('INSERT INTO events VALUES (?, ?)').run('e3', 'after');
    expect(readDatabaseIdentity(source).businessRevision).toBe(3);
    // finally 已清理临时目录/快照
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });

  it('回调期间快照 db 为只读：尝试写被 SQLite 拒绝', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    let rejected = false;
    await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
      expect(() => snap.db.exec('CREATE TABLE injected (x TEXT);')).toThrow(/readonly/i);
      rejected = true;
    });
    expect(rejected).toBe(true);
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });

  it('consumer 返回值透传为结果', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const result = await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
      const rev = (snap.db.prepare('SELECT business_revision FROM database_metadata WHERE id = 1').get() as {
        business_revision: number;
      }).business_revision;
      return { rev };
    });
    expect(result).toEqual({ rev: 1 });
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });

  it('临时目录 0700、快照文件 0600（回调期间磁盘验证）', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    if (process.platform === 'win32') {
      // Windows 无 POSIX 权限位保证
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => undefined);
      source.close();
      return;
    }
    let dirMode: number | null = null;
    let fileMode: number | null = null;
    await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => {
      const dirs = tempDirsIn(f);
      expect(dirs).toHaveLength(1);
      const tempDir = join(f.privateTempParent, dirs[0]);
      dirMode = statSync(tempDir).mode & 0o777;
      fileMode = statSync(join(tempDir, 'snapshot.db')).mode & 0o777;
    });
    expect(dirMode).toBe(SNAPSHOT_TEMP_DIR_PERMISSION);
    expect(fileMode).toBe(SNAPSHOT_FILE_PERMISSION);
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });
});

describe('snapshot-source：与活跃未提交写入的并发一致性', () => {
  it('第二连接未提交事务写入期间执行快照 → 快照=上一已提交状态；源 commit 不影响已产出快照', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    // committed-1 → 修订 2；内容仍在 WAL 未 checkpoint
    source.prepare('INSERT INTO events VALUES (?, ?)').run('committed-1', 'committed');
    const baseline = readDatabaseIdentity(source);
    expect(baseline.businessRevision).toBe(2);
    expect(baseline.contentGenerationId).toBe('generation-synth-1');

    // 活跃写者：开启未提交事务（写身份 + 插入行）
    const writer = new DatabaseSync(f.sourceDbPath);
    writer.exec('PRAGMA busy_timeout = 5000;');
    writer.exec('BEGIN IMMEDIATE;');
    writer
      .prepare(
        'UPDATE database_metadata SET content_generation_id = ?, business_revision = business_revision + 1 WHERE id = 1',
      )
      .run('generation-uncommitted');
    writer.prepare('INSERT INTO events VALUES (?, ?)').run('uncommitted-1', 'not-yet-committed');

    try {
      // 备份期间第二连接保持事务打开 → 快照只含已提交状态（修订 2、2 行、旧 generation）
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
        expect(snap.identity.contentGenerationId).toBe('generation-synth-1');
        expect(snap.identity.businessRevision).toBe(2);
        const events = snap.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
        expect(events.n).toBe(2);
        expect(
          (snap.db.prepare("SELECT id FROM events WHERE id = 'uncommitted-1'").get()),
        ).toBeUndefined();
      });
    } finally {
      writer.exec('COMMIT;');
      writer.close();
    }
    // commit 后源库看到新 generation 与更高修订（metadata 更新 +1、行插入 +1）
    const after = readDatabaseIdentity(source);
    expect(after.contentGenerationId).toBe('generation-uncommitted');
    expect(after.businessRevision).toBe(4);
    expect(source.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 3 });
    // 已产出快照已被清理（临时目录为空）
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });
});

describe('snapshot-source：失败路径与清理', () => {
  it('privateTempParent 不存在 → metadata-only SNAPSHOT_TEMP_PARENT_INVALID，无任何创建', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const missing = join(f.root, 'no-such-temp');
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: missing }, () => undefined);
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_TEMP_PARENT_INVALID');
    expect(existsSync(missing)).toBe(false);
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });

  it('privateTempParent 是符号链接 → SNAPSHOT_TEMP_PARENT_INVALID，链接目标不被写入', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const realParent = join(f.root, 'real-temp');
    mkdirSync(realParent, { recursive: true, mode: 0o700 });
    const linked = join(f.root, 'linked-temp');
    symlinkSync(realParent, linked);
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: linked }, () => undefined);
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_TEMP_PARENT_INVALID');
    expect(readdirSync(realParent)).toEqual([]);
    source.close();
  });

  it('backup 失败（源库已关闭）→ metadata-only SNAPSHOT_BACKUP_FAILED；源库字节/状态不变，临时目录清理', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    // 先提交并读取基线
    source.prepare('INSERT INTO events VALUES (?, ?)').run('e-before-close', 'x');
    const baselineIdentity = readDatabaseIdentity(source);
    source.close();
    const bytesBefore = readFileSync(f.sourceDbPath);

    let threw: unknown;
    try {
      // 源库已关闭 → runOnlineBackup 的 node:sqlite backup 抛 "database is not open"
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => undefined);
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_BACKUP_FAILED');
    // 源库文件字节未变；重新打开状态完好
    expect(readFileSync(f.sourceDbPath)).toEqual(bytesBefore);
    const reopened = new DatabaseSync(f.sourceDbPath);
    reopened.exec('PRAGMA journal_mode = WAL;');
    expect(readDatabaseIdentity(reopened)).toEqual(baselineIdentity);
    reopened.close();
    // 临时目录被清理
    expect(tempDirsIn(f)).toEqual([]);
  });

  it('consumer 抛错 → 原样上抛（携带 canary），快照与临时目录已清理，源库不受影响', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const canary = 'CANARY-CONSUMER-THROW-77';
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => {
        throw new Error(canary);
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toBe(canary);
    expect(threw).not.toBeInstanceOf(SnapshotSourceError);
    expect(tempDirsIn(f)).toEqual([]);
    // 源库状态未受影响（修订 1）
    expect(readDatabaseIdentity(source).businessRevision).toBe(1);
    source.close();
  });

  it('错误 metadata-only：message 只含稳定 code，不回显路径/文件/canary', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const missing = join(f.root, 'no-such-temp');
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: missing }, () => undefined);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SnapshotSourceError);
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot source SNAPSHOT_TEMP_PARENT_INVALID');
    expect(msg).not.toMatch(/snapshot\.db|source\.db|readonly-snapshot|no-such-temp/i);
    source.close();
  });
});

describe('snapshot-source：清理失败（fault 注入）如实报 CLEANUP_FAILED', () => {
  it('consumer 成功但 rmSync 失败 → 抛 SNAPSHOT_CLEANUP_FAILED，metadata-only 不回显路径', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    faultState.failRm = true;
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => 'ok');
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_CLEANUP_FAILED');
    // 不泄露被注入失败路径名/底层 message/临时路径
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot source SNAPSHOT_CLEANUP_FAILED');
    expect(msg).not.toMatch(/rmSync|injected|snapshot\.db|readonly-snapshot|source\.db/i);
    // rmSync 全程被替换 → 真实删除未执行，目录残留由 afterEach 清理
    faultState.failRm = false;
    source.close();
  });

  it('close 失败 → 抛 SNAPSHOT_CLEANUP_FAILED，但仍尝试删除临时目录（无残留）', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    faultState.failClose = true;
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => 'ok');
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_CLEANUP_FAILED');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot source SNAPSHOT_CLEANUP_FAILED');
    expect(msg).not.toMatch(/close|injected|snapshot\.db|readonly-snapshot|source\.db/i);
    // close 失败仍继续 rmSync → 临时目录已删除
    faultState.failClose = false;
    expect(tempDirsIn(f)).toEqual([]);
    source.close();
  });

  it('consumer 抛错且清理也失败 → generic CLEANUP_FAILED 覆盖原 canary', async () => {
    const f = newFixture();
    const source = openSourceDb(f);
    const canary = 'CANARY-CONSUMER-THROW-99';
    faultState.failRm = true;
    let threw: unknown;
    try {
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, () => {
        throw new Error(canary);
      });
    } catch (err) {
      threw = err;
    }
    expectStoreSnapshotError(threw, 'SNAPSHOT_CLEANUP_FAILED');
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot source SNAPSHOT_CLEANUP_FAILED');
    expect(msg).not.toMatch(/canary|CANARY|rmSync|injected|snapshot\.db/i);
    faultState.failRm = false;
    source.close();
  });
});
