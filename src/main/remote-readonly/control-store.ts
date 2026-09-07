/**
 * 远程只读发布：canonical control store（tasks 2.3 状态/队列持久化切片）。
 *
 * - 只持久化 consent.ts 的规范 `PersistedControlState`（无并行 enabled 布尔，state 权威）；
 *   字段级校验与状态转换唯一来源是 consent.ts 的严格 parse 与纯转换，本文件不重复任何
 *   descriptor/binding/consent 校验器，也不跑业务 SQLite / 业务迁移。
 * - 独立应用私有 SQLite（自用 schema，user_version=1，本切片未发布可自行修订）：
 *     control_state  单例行（id=1，state_json TEXT，读取时严格 parse）；
 *     control_queue  只存封闭元数据（publicationId/epoch/lineage/sequence/createdAt），
 *                    无 body/业务值/secret。
 * - 固定安全 db 路径由 control-paths lane 的 prepareControlDatabasePath() 产出（只在该
 *   dbPath 上建库，绝不回退旧的自建目录/非安全打开；路径错误原样上抛其稳定错误）。
 *   仅当该次调用实际以 'wx' 新建了 db 文件（createdDb=true）才走初始化；已存在文件一律
 *   按既有库严格校验，存在但 0 字节同样按损坏拒绝（不静默重建，BUG2）。
 * - 新文件：单事务建 schema + 默认 disabled 单例。已存在文件：严格校验 user_version /
 *   表与列 / 单例 JSON 严格 parse / 状态与队列行 invariant，未知或损坏一律 generic
 *   CONTROL_DB_CORRUPT（无 SQL/路径/原始 cause 泄漏），绝不自动重置或覆盖。
 * - 全部 read-check-write 与队列 INSERT 在 BEGIN IMMEDIATE 事务内；configure/invalidate
 *   同事务清空 consent 与队列（A→B→A 相对上一个持久化值仍视为变化，不恢复旧 consent）；
 *   队列带 contextRevision CAS，revision 过期一律拒绝；gate 校验在本 store 内完成。
 * - 运行时输入 allowlist（未知键含任何 token/password/secret 命名一律拒绝），
 *   错误 metadata-only，不回显字段值/未知键。
 */
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../domain/core/errors';
import {
  ConsentGateError,
  buildActionContext,
  configureControlState,
  confirmControlConsent,
  deriveGateState,
  initialControlState,
  invalidateControlState,
  localStopControlState,
  parsePersistedControlState,
  type PersistedControlState,
  type PublicationActionContext,
  type PublicationBinding,
} from './consent';
import { prepareControlDatabasePath } from './control-paths';

/** control store 自用 schema 版本（独立于业务迁移链；本切片首个版本）。 */
export const CONTROL_STORE_VERSION = 1 as const;

/** control_state 单例行固定主键。 */
const STATE_ROW_ID = 1;
/** 队列技术标识符长度上限（publicationId / lineage 字符串，与 consent 技术 ID 同量级）。 */
const MAX_QUEUE_ID_CHARS = 128;
/** createdAt 严格 ISO-8601（可含小数秒与 Z/±hh:mm）。 */
const STRICT_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const CONTROL_STORE_ERROR_CODES = {
  /** SQLite 打开失败（generic）。 */
  CONTROL_DB_OPEN: 'CONTROL_DB_OPEN',
  /** 全新库初始化失败（generic）。 */
  CONTROL_DB_INIT: 'CONTROL_DB_INIT',
  /** 已存在库损坏/未知版本/表列缺失/单例 JSON·状态 parse 失败/队列 invariant 失败。 */
  CONTROL_DB_CORRUPT: 'CONTROL_DB_CORRUPT',
  /** 当前状态不允许该操作（未 configure、已停用/本地停止时入队等）。 */
  CONTROL_STATE_CONFLICT: 'CONTROL_STATE_CONFLICT',
  /** 输入被严格 parse/gate 拒绝（未知键、非字面 true、与当前配置不一致等）。 */
  CONTROL_INPUT_INVALID: 'CONTROL_INPUT_INVALID',
  /** 队列 closed 元数据非法（未知键/越界/ISO 非法/epoch·lineage 不匹配当前 binding）。 */
  CONTROL_QUEUE_INVALID: 'CONTROL_QUEUE_INVALID',
  /** 队列 contextRevision CAS 过期（stale job）。 */
  CONTROL_QUEUE_STALE: 'CONTROL_QUEUE_STALE',
} as const;

export type ControlStoreErrorCode =
  (typeof CONTROL_STORE_ERROR_CODES)[keyof typeof CONTROL_STORE_ERROR_CODES];

/** metadata-only control store 错误：message 只含稳定 code 模板。 */
export class ControlStoreError extends DomainError {
  constructor(code: ControlStoreErrorCode) {
    super(code, `control store ${code}`);
    this.name = 'ControlStoreError';
  }
}

function storeError(code: ControlStoreErrorCode): ControlStoreError {
  return new ControlStoreError(code);
}

/** open 入参：原样交给 control-paths 安全路径准备。 */
export interface OpenControlStoreOptions {
  /** 已存在、主进程自有的应用私有根（绝对路径）。 */
  privateParentDir: string;
  /** 业务 SQLite 文件绝对路径清单（真实清单，至少一个）。 */
  businessDbPaths: readonly string[];
  /** 业务备份目录绝对路径清单（真实清单，至少一个）。 */
  businessBackupDirs: readonly string[];
}

/** 入队 closed 元数据（全 allowlist；epoch/lineage 必须与当前 binding 一致）。 */
export interface QueueClosedMetadata {
  publicationId: string;
  authorizationEpoch: number;
  databaseInstanceId: string;
  contentGenerationId: string;
  sequence: number;
  createdAt: string;
}

const QUEUE_META_KEYS: ReadonlySet<string> = new Set<string>([
  'publicationId',
  'authorizationEpoch',
  'databaseInstanceId',
  'contentGenerationId',
  'sequence',
  'createdAt',
]);

function queueInvalid(): ControlStoreError {
  return storeError('CONTROL_QUEUE_INVALID');
}

function requireQueueText(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw queueInvalid();
  return value;
}

function requireBoundedQueueText(value: unknown): string {
  const text = requireQueueText(value);
  if ([...text].length > MAX_QUEUE_ID_CHARS) throw queueInvalid();
  return text;
}

function requireQueueSafeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw queueInvalid();
  return value;
}

function requireStrictIso(value: unknown): string {
  const text = requireQueueText(value);
  if (!STRICT_ISO_PATTERN.test(text) || Number.isNaN(Date.parse(text))) throw queueInvalid();
  return text;
}

/** 严格解析队列 closed 元数据（未知键 → 拒绝；不泄露键名）。 */
function parseQueueMetadata(input: unknown): QueueClosedMetadata {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw queueInvalid();
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!QUEUE_META_KEYS.has(key)) throw queueInvalid();
  }
  return {
    publicationId: requireBoundedQueueText(obj['publicationId']),
    authorizationEpoch: requireQueueSafeInt(obj['authorizationEpoch']),
    databaseInstanceId: requireBoundedQueueText(obj['databaseInstanceId']),
    contentGenerationId: requireBoundedQueueText(obj['contentGenerationId']),
    sequence: requireQueueSafeInt(obj['sequence']),
    createdAt: requireStrictIso(obj['createdAt']),
  };
}

/** consent gate parse/transition 错误 → 稳定 store 错误（未 configure→CONFLICT，其余→INPUT_INVALID）。 */
function gateCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConsentGateError) {
      throw err.code === 'CONSENT_NOT_CONFIGURED'
        ? storeError('CONTROL_STATE_CONFLICT')
        : storeError('CONTROL_INPUT_INVALID');
    }
    throw err;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CREATE_SCHEMA_SQL = `
  CREATE TABLE control_state (
    id INTEGER PRIMARY KEY CHECK (id = ${STATE_ROW_ID}),
    state_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE control_queue (
    publication_id TEXT PRIMARY KEY,
    authorization_epoch INTEGER NOT NULL,
    database_instance_id TEXT NOT NULL,
    content_generation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`;

const REQUIRED_TABLES: ReadonlyArray<{ name: string; columns: readonly string[] }> = [
  { name: 'control_state', columns: ['id', 'state_json'] },
  {
    name: 'control_queue',
    columns: [
      'publication_id',
      'authorization_epoch',
      'database_instance_id',
      'content_generation_id',
      'sequence',
      'created_at',
    ],
  },
];

/** JSON.parse + canonical 严格 parse；任一失败 → CORRUPT（fail closed）。 */
function jsonParseState(raw: string): PersistedControlState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw storeError('CONTROL_DB_CORRUPT');
  }
  if (!isPlainObject(parsed)) throw storeError('CONTROL_DB_CORRUPT');
  try {
    return parsePersistedControlState(parsed);
  } catch {
    throw storeError('CONTROL_DB_CORRUPT');
  }
}

function requireStateRowCount(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM control_state')
    .get() as { n: number };
  if (row.n !== 1) throw storeError('CONTROL_DB_CORRUPT');
}

function readStateRow(db: DatabaseSync): PersistedControlState {
  requireStateRowCount(db);
  const row = db
    .prepare('SELECT state_json FROM control_state WHERE id = ?')
    .get(STATE_ROW_ID) as { state_json: string } | undefined;
  if (row === undefined) throw storeError('CONTROL_DB_CORRUPT');
  return jsonParseState(row.state_json);
}

function checkTableColumns(db: DatabaseSync, name: string, expected: readonly string[]): void {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: unknown }>;
  const actual = rows.map((r) => String(r.name));
  for (const col of expected) {
    if (!actual.includes(col)) throw storeError('CONTROL_DB_CORRUPT');
  }
}

/** SQL 行(snake_case) → closed 元数据对象(camelCase)；损坏 → CORRUPT。 */
function rowToQueueMeta(row: Record<string, unknown>): QueueClosedMetadata {
  return parseQueueMetadata({
    publicationId: row['publication_id'],
    authorizationEpoch: row['authorization_epoch'],
    databaseInstanceId: row['database_instance_id'],
    contentGenerationId: row['content_generation_id'],
    sequence: row['sequence'],
    createdAt: row['created_at'],
  });
}

/** 校验队列行完整性 + 与当前 binding 的 epoch/lineage invariant（损坏 → CORRUPT）。 */
function validateQueueRows(db: DatabaseSync, current: PersistedControlState): void {
  const rows = db.prepare('SELECT * FROM control_queue').all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return;
  const binding = current.binding;
  if (binding === null) throw storeError('CONTROL_DB_CORRUPT');
  for (const row of rows) {
    let meta: QueueClosedMetadata;
    try {
      meta = rowToQueueMeta(row);
    } catch {
      throw storeError('CONTROL_DB_CORRUPT');
    }
    if (
      meta.authorizationEpoch !== binding.authorizationEpoch ||
      meta.databaseInstanceId !== binding.databaseInstanceId ||
      meta.contentGenerationId !== binding.contentGenerationId
    ) {
      throw storeError('CONTROL_DB_CORRUPT');
    }
  }
}

export class ControlStore {
  private constructor(
    private readonly db: DatabaseSync,
    readonly dbPath: string,
  ) {}

  /** 工厂：安全路径准备 → 打开 → 新建初始化（单事务默认 disabled）/既有严格校验。 */
  static open(options: OpenControlStoreOptions): ControlStore {
    const prepared = prepareControlDatabasePath(options);
    const dbPath = prepared.dbPath;
    // 仅当 control-paths 本次以独占 'wx' 实际创建了 db 文件才可安全初始化新库；
    // 已存在文件一律按既有库严格校验。存在但 0 字节 = 被截断/损坏，绝不能按「新文件」
    // 静默重建覆盖（BUG2：此前 size===0 会吞掉截断的既有库）。
    const createdDb = prepared.createdDb;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch {
      throw storeError('CONTROL_DB_OPEN');
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    try {
      if (createdDb) {
        initializeFreshStore(db);
      } else {
        validateExistingStore(db);
      }
    } catch (err) {
      db.close();
      if (err instanceof ControlStoreError) throw err;
      throw storeError(createdDb ? 'CONTROL_DB_INIT' : 'CONTROL_DB_CORRUPT');
    }
    return new ControlStore(db, dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 事务包装：所有读-检查-写与队列 INSERT 走 BEGIN IMMEDIATE。 */
  private inImmediateTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 保留原始错误
      }
      throw err;
    }
  }

  private loadState(): PersistedControlState {
    return readStateRow(this.db);
  }

  /** 读取当前 canonical 状态（严格 parse；fail closed 已由 open/写路径保证）。 */
  readCurrent(): PersistedControlState {
    return this.loadState();
  }

  /** 快照别名：当前状态 + 队列行只读数组。 */
  snapshot(): { state: PersistedControlState; queued: readonly QueueClosedMetadata[] } {
    const state = this.loadState();
    const queued = this.readQueueUnsafe();
    return { state, queued };
  }

  private saveState(next: PersistedControlState): void {
    this.db
      .prepare('UPDATE control_state SET state_json = ? WHERE id = ?')
      .run(JSON.stringify(next), STATE_ROW_ID);
  }

  private clearQueueUnsafe(): void {
    this.db.prepare('DELETE FROM control_queue').run();
  }

  private readQueueUnsafe(): QueueClosedMetadata[] {
    const rows = this.db
      .prepare(
        `SELECT publication_id, authorization_epoch, database_instance_id,
                content_generation_id, sequence, created_at
         FROM control_queue ORDER BY created_at ASC, publication_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      try {
        return rowToQueueMeta(r);
      } catch {
        throw storeError('CONTROL_DB_CORRUPT');
      }
    });
  }

  private expectEnabled(): PersistedControlState {
    const current = this.loadState();
    if (deriveGateState(current) !== 'enabled') throw storeError('CONTROL_STATE_CONFLICT');
    return current;
  }

  /**
   * configure：写入 descriptor/binding。
   * - 与上一个持久化值相比 descriptor 或 binding 任一变化（含 A→B→A）→ revision+1、
   *   consent 清空、state=disabled，同事务清空队列（须重新知情确认，不重放旧队列）；
   * - 完全未变化 → 幂等返回原状态（不递增 revision、不清队列）。
   */
  configure(descriptorInput: unknown, bindingInput: unknown): PersistedControlState {
    return this.inImmediateTransaction(() => {
      const prev = this.loadState();
      const next = gateCall(() => configureControlState(prev, descriptorInput, bindingInput));
      if (next === prev) return prev;
      this.saveState(next);
      this.clearQueueUnsafe();
      return next;
    });
  }

  /**
   * confirm：负责人提交「exactFullConsent」（descriptor+binding+三项确认的对象）。
   * 必须已 configure；本方法在事务内用 consent.ts 规范解析器校验该对象与当前
   * descriptor+binding 完全一致且三项字面 true（gate 校验在 store 内完成，非仅调用方），
   * 一致才置 enabled。不一致/未配置 → CONFLICT/INPUT_INVALID，不落任何状态。
   */
  confirm(exactFullConsentInput: unknown): PersistedControlState {
    return this.inImmediateTransaction(() => {
      const prev = this.loadState();
      if (deriveGateState(prev) !== 'disabled' || prev.descriptor === null || prev.binding === null) {
        throw storeError('CONTROL_STATE_CONFLICT');
      }
      // 用同一 canonical parser 校验完整同意对象必须精确匹配当前 descriptor+binding。
      gateCall(() =>
        parsePersistedControlState({
          state: prev.state,
          revision: prev.revision,
          descriptor: prev.descriptor,
          binding: prev.binding,
          consent: exactFullConsentInput,
        }),
      );
      const obj = exactFullConsentInput as Record<string, unknown>;
      const next = gateCall(() =>
        confirmControlConsent(prev, {
          targetConfirmed: obj['targetConfirmed'],
          scopeConfirmed: obj['scopeConfirmed'],
          retentionConfirmed: obj['retentionConfirmed'],
        }),
      );
      this.saveState(next);
      return next;
    });
  }

  /** invalidate：consent 失效回 disabled（保留 descriptor/binding）；同事务清空队列。 */
  invalidate(): PersistedControlState {
    return this.inImmediateTransaction(() => {
      const prev = this.loadState();
      const next = invalidateControlState(prev);
      if (next === prev) return prev;
      this.saveState(next);
      this.clearQueueUnsafe();
      return next;
    });
  }

  /** localStop：本地停止新工作（state=localStopped；保留配置与 consent 报告面）。 */
  stopLocally(): PersistedControlState {
    return this.inImmediateTransaction(() => {
      const prev = this.loadState();
      const next = localStopControlState(prev);
      if (next === prev) return prev;
      this.saveState(next);
      return next;
    });
  }

  /** 队列入队 closed 元数据：仅当 contextRevision 与当前 revision 一致（CAS）。 */
  queue(contextRevision: number, closedMetadataInput: unknown): QueueClosedMetadata {
    if (typeof contextRevision !== 'number' || !Number.isSafeInteger(contextRevision) || contextRevision < 0) {
      throw storeError('CONTROL_QUEUE_INVALID');
    }
    const meta = parseQueueMetadata(closedMetadataInput);
    this.inImmediateTransaction(() => {
      const current = this.expectEnabled();
      if (contextRevision !== current.revision) throw storeError('CONTROL_QUEUE_STALE');
      const binding = current.binding as PublicationBinding;
      if (
        meta.authorizationEpoch !== binding.authorizationEpoch ||
        meta.databaseInstanceId !== binding.databaseInstanceId ||
        meta.contentGenerationId !== binding.contentGenerationId
      ) {
        throw storeError('CONTROL_QUEUE_INVALID');
      }
      try {
        this.db
          .prepare(
            `INSERT INTO control_queue (
               publication_id, authorization_epoch, database_instance_id,
               content_generation_id, sequence, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            meta.publicationId,
            meta.authorizationEpoch,
            meta.databaseInstanceId,
            meta.contentGenerationId,
            meta.sequence,
            meta.createdAt,
          );
      } catch {
        throw storeError('CONTROL_QUEUE_INVALID');
      }
    });
    return meta;
  }

  /**
   * 断言当前 context 可继续（供控制器在异步工作前使用）：仅 deriveGateState
   * === 'enabled' 才返回冻结 context；否则 generic CONFLICT（fail closed，不假成功）。
   */
  assertCurrentContext(): PublicationActionContext {
    const current = this.expectEnabled();
    return buildActionContext(current);
  }
}

/** 便捷工厂（与 ControlStore.open 等价）。 */
export function openControlStore(options: OpenControlStoreOptions): ControlStore {
  return ControlStore.open(options);
}

/** 单事务初始化：建表 + 默认 disabled 单例 + user_version。 */
function initializeFreshStore(db: DatabaseSync): void {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(CREATE_SCHEMA_SQL);
    db.prepare('INSERT INTO control_state (id, state_json) VALUES (?, ?)').run(
      STATE_ROW_ID,
      JSON.stringify(initialControlState()),
    );
    db.exec(`PRAGMA user_version = ${CONTROL_STORE_VERSION};`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始失败
    }
    throw err;
  }
}

/** 既有库严格校验：版本/表列/单例 JSON·状态 parse/队列 invariant；损坏一律 CORRUPT。 */
function validateExistingStore(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (versionRow.user_version !== CONTROL_STORE_VERSION) throw storeError('CONTROL_DB_CORRUPT');
  const tableRows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  const tableNames = tableRows.map((r) => r.name);
  for (const table of REQUIRED_TABLES) {
    if (!tableNames.includes(table.name)) throw storeError('CONTROL_DB_CORRUPT');
    checkTableColumns(db, table.name, table.columns);
  }
  const current = readStateRow(db);
  validateQueueRows(db, current);
}
