/**
 * snapshot-finance.test.ts（tasks 2.2 snapshot-finance 切片）
 *
 * 真实临时 SQLite 源库 + withPublicationSnapshot 一致只读快照验证 readSnapshotPendingAmount：
 * - 完成/任意非取消状态 + entry_at=null 仍计入（entry_at 不参与资格过滤）；
 * - 已取消/孤立/已撤销排除；null final 排除、0 final 合法零贡献并计入项目数；空库 0.00；
 * - 被排除行（孤儿/已取消/已撤销/无 final）的畸形金额（文本/REAL）在固定 SQL JOIN 排除后
 *   绝不解析，不影响好项目余额；参与行畸形金额 → metadata-only 拒绝；
 * - 超 Number.MAX_SAFE_INTEGER 分整数经原生 BigInt+formatCents 精确往返，无 Number 强转；
 * - 快照产出后源库变更不改变已备份快照结果；读取失败 → metadata-only SnapshotFinanceError。
 * 全部 synthetic（无真实业务/客户值）。期望值来自 shared financial-facts 权威口径，不复制领域公式。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../src/domain/core/errors';
import { withPublicationSnapshot } from '../../src/main/remote-readonly/snapshot-source';
import {
  readSnapshotPendingAmount,
  SnapshotFinanceError,
} from '../../src/main/remote-readonly/snapshot-finance';

const rootsToClean: string[] = [];

function newFixture() {
  const root = join(
    realpathSync(tmpdir()),
    `snapshot-finance-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  const privateTempParent = join(root, 'snapshot-temp');
  mkdirSync(privateTempParent, { recursive: true, mode: 0o700 });
  return {
    sourceDbPath: join(root, 'source.db'),
    privateTempParent,
  };
}

type P = [string, string, string | null]; // [id, status, entryAt]
type C = [string, string, bigint | null | number | string]; // [id, projectId, finalCents]
type I = [string, string, bigint | number | string, string | null]; // [id, projectId, amountCents, revokedAt]

/** 最小 domain 兼容源库（实际 schema 列名；金额列非 STRICT 以放行畸形 money fixture）。 */
function openSourceDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE database_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1), database_instance_id TEXT NOT NULL,
      content_generation_id TEXT NOT NULL, business_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE projects (id TEXT PRIMARY KEY, temp_no TEXT NOT NULL, status TEXT NOT NULL,
      entry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE contracts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
      temp_number TEXT NOT NULL, final_confirmable_amount_cents INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, invoiced_at TEXT NOT NULL, revoked_at TEXT,
      last_modified_at TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.prepare(
    `INSERT INTO database_metadata
       (id, database_instance_id, content_generation_id, business_revision, created_at, updated_at)
     VALUES (1, ?, ?, 0, ?, ?)`,
  ).run('instance-synth-f', 'generation-synth-f', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  return db;
}

function seed(db: DatabaseSync, data: { p?: P[]; c?: C[]; i?: I[] }): void {
  const insP = db.prepare(
    'INSERT INTO projects (id, temp_no, status, entry_at, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  );
  for (const [id, status, entryAt] of data.p ?? []) insP.run(id, `TP-${id}`, status, entryAt, 't', 't');
  const insC = db.prepare(
    `INSERT INTO contracts (id, project_id, temp_number, final_confirmable_amount_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const [id, projectId, finalCents] of data.c ?? []) insC.run(id, projectId, `TN-${id}`, finalCents, 't', 't');
  const insI = db.prepare(
    `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, revoked_at, last_modified_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const [id, projectId, amountCents, revokedAt] of data.i ?? []) {
    insI.run(id, projectId, amountCents, '2026-08-01', revokedAt, 't', 't');
  }
}

/** 构造源库 → 一致快照 → 回调读 pending（fn 可访问 snap 只读连接与活 source 以便备份后变更）。 */
async function onSnapshot(
  data: Parameters<typeof seed>[1],
  fn: (snap: DatabaseSync, source: DatabaseSync) => unknown,
): Promise<unknown> {
  const f = newFixture();
  const source = openSourceDb(f.sourceDbPath);
  try {
    seed(source, data);
    let out: unknown;
    await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
      out = fn(snap.db, source);
    });
    return out;
  } finally {
    source.close();
  }
}

afterEach(() => {
  for (const root of rootsToClean) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
  rootsToClean.length = 0;
});

describe('readSnapshotPendingAmount：领域口径经真实一致快照', () => {
  it('完成 + entry_at=null 计入余额；任意非取消状态都参与', async () => {
    const r = await onSnapshot(
      {
        p: [['p1', 'completed', null], ['p2', 'pending_invoice', null]],
        c: [['c1', 'p1', 800000n], ['c2', 'p2', 100000n]], // final 8000.00 / 1000.00
        i: [['i1', 'p1', 300000n, null]], // active 3000.00
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({ pendingAmount: '6000.00', cents: 600000n, contributingProjectCount: 2 });
  });

  it('已取消项目、孤立掉票/孤立合同、已撤销掉票全部排除', async () => {
    const r = await onSnapshot(
      {
        p: [['p1', 'completed', '2026-08-01'], ['p2', 'cancelled', '2026-08-01']],
        c: [
          ['c1', 'p1', 500000n], // final 5000.00
          ['c2', 'p2', 300000n], // cancelled → 排除
          ['c-orphan', 'ghost', 888800n], // 孤立合同 → 排除
        ],
        i: [
          ['i1', 'p1', 200000n, null], // active 2000.00
          ['i2', 'p1', 50000n, '2026-08-02'], // revoked → 排除
          ['i3', 'p2', 50000n, null], // cancelled 下 → 排除
          ['i-orphan', 'ghost', 99900n, null], // 孤立掉票 → 排除
        ],
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({ pendingAmount: '3000.00', cents: 300000n, contributingProjectCount: 1 }); // 仅 p1 5000−2000
  });

  it('null final 排除、0 final 合法零贡献并计入项目数；空库 0.00', async () => {
    const r = await onSnapshot(
      {
        p: [
          ['p1', 'completed', '2026-08-01'],
          ['p2', 'completed', '2026-08-01'],
          ['p3', 'completed', '2026-08-01'],
        ],
        c: [
          ['c1', 'p1', null], // 未录入 → 排除
          ['c2', 'p2', 0n], // final 0 → 可计算零贡献
          ['c3', 'p3', 10000n], // final 100.00
        ],
        i: [['i1', 'p1', 10000n, null]], // 无 final 项目下行 → 排除
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({ pendingAmount: '100.00', cents: 10000n, contributingProjectCount: 2 });

    const empty = await onSnapshot({}, (snap) => readSnapshotPendingAmount(snap));
    expect(empty).toEqual({ pendingAmount: '0.00', cents: 0n, contributingProjectCount: 0 });
  });
});

describe('readSnapshotPendingAmount：被排除行畸形金额不解析', () => {
  it('孤儿/已取消/已撤销/无 final 行的文本或 REAL 畸形金额被 SQL 排除，好项目余额不受影响', async () => {
    const r = await onSnapshot(
      {
        p: [
          ['p-good', 'completed', '2026-08-01'],
          ['p-cancelled', 'cancelled', '2026-08-01'],
          ['p-nofinal', 'completed', '2026-08-01'],
        ],
        c: [
          ['c-good', 'p-good', 800000n], // final 8000.00
          ['c-cancelled', 'p-cancelled', 'not-an-int'], // cancelled 项目合同 final 畸形 → 排除
          ['c-orphan', 'ghost', 12345.5], // 孤儿合同 final REAL → 排除
          ['c-nofinal', 'p-nofinal', null], // 无 final → 项目不参与（含畸形掉票随行排除）
        ],
        i: [
          ['i1', 'p-good', 300000n, null], // active 3000.00 → 好项目余额 5000.00
          ['i-orphan', 'ghost', 'bad-text', null], // 孤儿掉票文本畸形 → 排除
          ['i-orphan2', 'ghost', 70000.5, null], // 孤儿掉票 REAL → 排除
          ['i-revoked', 'p-good', 'not-parseable', '2026-08-02'], // 已撤销畸形 → 排除
          ['i-cancelled', 'p-cancelled', 'bad!!', null], // cancelled 下畸形 → 排除
          ['i-nofinal', 'p-nofinal', 123.5, null], // 无 final 项目下畸形 → 排除
        ],
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({ pendingAmount: '5000.00', cents: 500000n, contributingProjectCount: 1 });
  });

  it('参与行（有效项目 + final 有值 + 未撤销）的畸形金额 → metadata-only 拒绝', async () => {
    const malformed: Array<Parameters<typeof seed>[1]> = [
      { p: [['p1', 'completed', '2026-08-01']], c: [['c1', 'p1', 800000n]], i: [['i1', 'p1', 'oops', null]] },
      { p: [['p1', 'completed', '2026-08-01']], c: [['c1', 'p1', 800000n]], i: [['i1', 'p1', 123.45, null]] },
      { p: [['p1', 'completed', '2026-08-01']], c: [['c1', 'p1', 'bad-final', 't'] as unknown as C], i: [] },
    ];
    for (const data of malformed) {
      let threw: unknown = null;
      await onSnapshot(data, (snap) => {
        try {
          readSnapshotPendingAmount(snap);
        } catch (err) {
          threw = err;
        }
        return undefined;
      });
      expect(threw).toBeInstanceOf(DomainError);
      if (threw instanceof DomainError) {
        // 参与行畸形 → computePendingAmount 严格金额拒绝；不静默舍入/强转
        expect(['INVALID_MONEY_FORMAT', 'SNAPSHOT_FINANCE_READ_FAILED']).toContain(threw.code);
      }
    }
  });
});

describe('readSnapshotPendingAmount：原生 BigInt 精确与一致性', () => {
  it('超 Number.MAX_SAFE_INTEGER 分整数精确往返，逐项目 max 与合计不丢精度', async () => {
    const r = await onSnapshot(
      {
        p: [['p1', 'completed', '2026-08-01'], ['p2', 'completed', '2026-08-01']],
        // 9007199254740993 分 = Number.MAX_SAFE_INTEGER + 1 的精确表达
        c: [['c1', 'p1', 9007199254740993n], ['c2', 'p2', 9007199254740993n]],
        i: [['i1', 'p1', 9007199254740992n, null]], // p1 余额恰 1 分；p2 全额贡献
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({
      pendingAmount: '90071992547409.94', // 1 + 9007199254740993 分
      cents: 9007199254740994n,
      contributingProjectCount: 2,
    });
  });

  it('余额为 0 或掉票超过 final 的项目贡献 0（max 下限），合计不含负值', async () => {
    const r = await onSnapshot(
      {
        p: [['p1', 'completed', '2026-08-01'], ['p2', 'completed', '2026-08-01']],
        c: [['c1', 'p1', 100000n], ['c2', 'p2', 50000n]], // final 1000.00 / 500.00
        i: [
          ['i1', 'p1', 100000n, null], // 正好掉完
          ['i2', 'p2', 80000n, null], // 超过 final（脏事实按 max(·,0) 截 0）
        ],
      },
      (snap) => readSnapshotPendingAmount(snap),
    );
    expect(r).toEqual({ pendingAmount: '0.00', cents: 0n, contributingProjectCount: 2 });
    expect((r as { cents: bigint }).cents).toBeGreaterThanOrEqual(0n);
  });

  it('快照产出后源库变更不改变已备份快照的读取结果', async () => {
    const reads = (await onSnapshot(
      {
        p: [['p1', 'completed', '2026-08-01']],
        c: [['c1', 'p1', 800000n]], // final 8000.00
        i: [['i1', 'p1', 300000n, null]], // active 3000.00
      },
      (snap, source) => {
        const first = readSnapshotPendingAmount(snap);
        // 备份已完成：对活源库追加掉票并改 final → 已备份快照不受影响
        seed(source, { i: [['i-after', 'p1', 400000n, null]] });
        source.prepare('UPDATE contracts SET final_confirmable_amount_cents = ? WHERE id = ?').run(900000n, 'c1');
        return [first, readSnapshotPendingAmount(snap)];
      },
    )) as ReturnType<typeof readSnapshotPendingAmount>[];
    const expected = { pendingAmount: '5000.00', cents: 500000n, contributingProjectCount: 1 };
    expect(reads[0]).toEqual(expected);
    expect(reads[1]).toEqual(expected); // 同一快照两次读取一致
  });
});

describe('readSnapshotPendingAmount：失败 metadata-only', () => {
  it('缺表读取失败 → SnapshotFinanceError，message 不含 SQL/路径', async () => {
    const f = newFixture();
    const source = openSourceDb(f.sourceDbPath);
    try {
      source.exec('DROP TABLE contracts'); // 快照只读无法写；先缺表再备份 → 读取失败
      let threw: unknown;
      await withPublicationSnapshot(source, { privateTempParent: f.privateTempParent }, (snap) => {
        try {
          readSnapshotPendingAmount(snap.db);
        } catch (err) {
          threw = err;
        }
      });
      expect(threw).toBeInstanceOf(SnapshotFinanceError);
      const err = threw as SnapshotFinanceError;
      expect(err.code).toBe('SNAPSHOT_FINANCE_READ_FAILED');
      expect(err.message).toBe('snapshot finance SNAPSHOT_FINANCE_READ_FAILED');
      expect(err.message).not.toMatch(/no such table|contracts|snapshot\.db/i);
    } finally {
      source.close();
    }
  });
});
