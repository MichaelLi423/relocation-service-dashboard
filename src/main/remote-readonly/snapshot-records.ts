/**
 * 远程只读发布：一致快照记录枚举（tasks 2.2 snapshot-records 切片）。
 *
 * 消费 snapshot-source 提供的只读快照上的 WorkbenchReadRepository 窄面
 * （projectPage/projectDetail/sectionPage），把「全部项目 + 每项目五分区子记录」逐一
 * 投影为已批准记录并序列化为 JSONL 行。本模块不创建快照、不查活库、不上网——reader
 * 由调用方从只读快照连接构造（下一集成切片接线）。调用方在 snapshot-source 的 consumer
 * 回调内迭代本 generator，即可在一致只读视图上产出全部发布行。
 *
 * 顺序与形状：
 * - 项目全量 keyset 分页（固定 20/页），**不带任何 UI 筛选**（status/query/reminder/
 *   sort 全部缺省，绝不做默认 active-only）→ pre-entry/completed/cancelled 全覆盖；
 *   游标推进直到 nextCursor===null。
 * - 每项目先 yield 项目完整记录（row 经 projectRowFromWorkbench + detail 经
 *   toRemoteDetailGroup，再 projectRecordToJsonl 严格校验序列化），随后逐项目枚举
 *   五分区（batches/instruments/orders/invoices/damage_items）keyset 分页并逐行
 *   sectionRowFromWorkbench + sectionRowToJsonl。activities 不在投影内，永不请求。
 * - 每行 yield { kind, record|row, line, utf8Bytes }；consuming 侧据 kind/line 即可
 *   生成 JSONL 与 manifest entityCounts。
 *
 * 严格契约（fail closed，不静默丢弃/合成）：
 * - detail/section 关联不一致（detail.project 缺失/id 与行不符、行 projectId 与当前
 *   项目不符、回包 kind 与请求不符）→ 拒绝；必填字段非法由共享投影/序列化严格解析
 *   抛出（未知/污染/canary 不产出任何字节）；本模块只做跨实体关联与进度守卫。
 * - 分页无进展（下一页游标与当前相同、空页却声明 nextCursor）→ 拒绝。
 * - 实体总数（项目 + 分区行）> 100000 → 拒绝；任一行 UTF-8 > 64 KiB → 拒绝
 *   （Buffer.byteLength，as emitted）。
 * - 错误 metadata-only：本层错误只含稳定 code；共享投影/序列化的拒绝同样不回显
 *   业务值/路径（见 shared/remote-readonly/rejection）。
 */
import type { WorkbenchReadRepository } from '../../domain/capabilities/local-data-persistence/workbench-read-repository';
import { DomainError } from '../../domain/core/errors';
import type { RemoteProjectRecord, RemoteSectionRow } from '../../shared/remote-readonly/projection';
import {
  projectRecordToJsonl,
  sectionRowToJsonl,
} from '../../shared/remote-readonly/jsonl';
import {
  projectRowFromWorkbench,
  sectionRowFromWorkbench,
  toRemoteDetailGroup,
} from '../../shared/remote-readonly/projection';
import type { WorkbenchV2SectionKind } from '../../shared/ipc';

/** reader 窄面：只取三种有界读方法（不暴露 DB/连接/其它模块）。 */
export type SnapshotRecordsReader = Pick<
  WorkbenchReadRepository,
  'projectPage' | 'projectDetail' | 'sectionPage'
>;

/** 投影内五分区（不含 activities）。 */
export const SNAPSHOT_RECORDS_SECTION_KINDS: readonly WorkbenchV2SectionKind[] = [
  'batches',
  'instruments',
  'orders',
  'invoices',
  'damage_items',
] as const;

/** 可发布分区 kind（排除 activities）。 */
export type SnapshotSectionKind = Exclude<WorkbenchV2SectionKind, 'activities'>;

/** 实体总数硬上限（design：100000 行）。 */
export const SNAPSHOT_RECORDS_ENTITY_LIMIT = 100000;
/** 单行 UTF-8 字节上限（design：64 KiB）。 */
export const SNAPSHOT_RECORDS_LINE_BYTE_LIMIT = 64 * 1024;

export const SNAPSHOT_RECORDS_ERROR_CODES = {
  /** 分页无进展：游标未前移或空页却声明 nextCursor。 */
  SNAPSHOT_RECORDS_NO_PROGRESS: 'SNAPSHOT_RECORDS_NO_PROGRESS',
  /** detail/section 关联与当前行不一致或行 kind/回包 kind 与请求不符。 */
  SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH: 'SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH',
  /** 超过实体总数上限。 */
  SNAPSHOT_RECORDS_ENTITY_LIMIT: 'SNAPSHOT_RECORDS_ENTITY_LIMIT',
  /** 序列化行超过 64 KiB。 */
  SNAPSHOT_RECORDS_LINE_TOO_LARGE: 'SNAPSHOT_RECORDS_LINE_TOO_LARGE',
} as const;

export type SnapshotRecordsErrorCode =
  (typeof SNAPSHOT_RECORDS_ERROR_CODES)[keyof typeof SNAPSHOT_RECORDS_ERROR_CODES];

/** metadata-only 枚举错误：message 只含稳定 code，不回显 id/路径/业务值/底层 cause。 */
export class SnapshotRecordsError extends DomainError {
  constructor(code: SnapshotRecordsErrorCode) {
    super(code, `snapshot records ${code}`);
    this.name = 'SnapshotRecordsError';
  }
}

function recordsError(code: SnapshotRecordsErrorCode): SnapshotRecordsError {
  return new SnapshotRecordsError(code);
}

/** 产出单元：项目完整记录或单条分区行（均已严格校验 + 已序列化权威行）。 */
export type SnapshotRecordYield =
  | { kind: 'project'; record: RemoteProjectRecord; line: string; utf8Bytes: number }
  | { kind: SnapshotSectionKind; row: RemoteSectionRow; line: string; utf8Bytes: number };

export type SnapshotRecordCounts = {
  projects: number;
  batches: number;
  instruments: number;
  orders: number;
  invoices: number;
  damageItems: number;
};

/** 空页且声明更多 = 无进展；游标重复 = 无进展。 */
function assertProgress(previous: string | null, next: string | null, rowCount: number): void {
  if (next === null) return;
  if (rowCount === 0 || next === previous) throw recordsError('SNAPSHOT_RECORDS_NO_PROGRESS');
}

function assertLineSize(line: string): number {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > SNAPSHOT_RECORDS_LINE_BYTE_LIMIT) {
    throw recordsError('SNAPSHOT_RECORDS_LINE_TOO_LARGE');
  }
  return bytes;
}

/**
 * 枚举一致快照的全部项目与五分区子记录。
 * 返回 generator：逐条 yield 已校验的 {record|row, line, utf8Bytes}；完整消费后
 * return 实体计数（供 manifest entityCounts）。任一行失败即抛（fail closed）。
 * 行序：第一页项目行 → 每项目紧跟其五分区子记录 → 第二页项目行……
 */
export function* enumerateSnapshotRecords(
  reader: SnapshotRecordsReader,
): Generator<SnapshotRecordYield, SnapshotRecordCounts, void> {
  const counts: SnapshotRecordCounts = {
    projects: 0,
    batches: 0,
    instruments: 0,
    orders: 0,
    invoices: 0,
    damageItems: 0,
  };
  let entityTotal = 0;

  const bump = (kind: keyof SnapshotRecordCounts, payload: SnapshotRecordYield): SnapshotRecordYield => {
    entityTotal += 1;
    if (entityTotal > SNAPSHOT_RECORDS_ENTITY_LIMIT) {
      throw recordsError('SNAPSHOT_RECORDS_ENTITY_LIMIT');
    }
    counts[kind] += 1;
    return payload;
  };

  let projectCursor: string | null = null;
  let projectPages = 0;
  const maxProjectPages = Math.ceil(SNAPSHOT_RECORDS_ENTITY_LIMIT / 20) + 1;
  while (true) {
    if (projectPages >= maxProjectPages) throw recordsError('SNAPSHOT_RECORDS_NO_PROGRESS');
    projectPages += 1;
    // 不带任何 UI 筛选：status/query/reminder/sort 全缺省（覆盖 pre-entry/completed/cancelled）。
    const page = reader.projectPage({ cursor: projectCursor });
    assertProgress(projectCursor, page.nextCursor, page.projects.length);
    projectCursor = page.nextCursor;

    for (const projectRow of page.projects) {
      // 详情来自只读快照的同一 reader：project 必须仍存在且 id 与行一致。
      const detailDto = reader.projectDetail(projectRow.id);
      if (
        detailDto.project === null ||
        detailDto.detail === null ||
        detailDto.project.id !== projectRow.id
      ) {
        throw recordsError('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
      }
      const group = toRemoteDetailGroup(detailDto.project, detailDto.detail);
      if (group === null) {
        throw recordsError('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
      }
      const record: RemoteProjectRecord = {
        kind: 'project',
        row: projectRowFromWorkbench(projectRow),
        detail: group,
      };
      const line = projectRecordToJsonl(record);
      yield bump('projects', { kind: 'project', record, line, utf8Bytes: assertLineSize(line) });

      // 该项目五分区子记录。
      for (const sec of sectionRowsOf(reader, projectRow.id)) {
        yield bump(sec.kind === 'damage_items' ? 'damageItems' : sec.kind, sec);
      }
    }
    if (projectCursor === null) break;
  }
  return counts;
}

/** 枚举单项目的五分区（batches→instruments→orders→invoices→damage_items）。 */
function* sectionRowsOf(
  reader: SnapshotRecordsReader,
  projectId: string,
): Generator<
  { kind: SnapshotSectionKind; row: RemoteSectionRow; line: string; utf8Bytes: number },
  void,
  void
> {
  for (const kind of SNAPSHOT_RECORDS_SECTION_KINDS) {
    const sectionKind = kind as SnapshotSectionKind;
    let cursor: string | null = null;
    let pages = 0;
    // 50/页 × 实体上限仅防御死循环；正常远小于此。
    const maxPages = Math.ceil(SNAPSHOT_RECORDS_ENTITY_LIMIT / 50) + 1;
    while (true) {
      if (pages >= maxPages) throw recordsError('SNAPSHOT_RECORDS_NO_PROGRESS');
      pages += 1;
      const dto = reader.sectionPage({ projectId, kind, cursor });
      if (dto.kind !== kind || dto.projectId !== projectId) {
        throw recordsError('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
      }
      assertProgress(cursor, dto.nextCursor, dto.rows.length);
      cursor = dto.nextCursor;
      for (const sourceRow of dto.rows) {
        if (sourceRow.kind !== kind) {
          throw recordsError('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
        }
        const pid = (sourceRow as { projectId: string | null }).projectId;
        if (pid !== projectId) {
          throw recordsError('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
        }
        const row = sectionRowFromWorkbench(sourceRow);
        const line = sectionRowToJsonl(row);
        yield { kind: sectionKind, row, line, utf8Bytes: assertLineSize(line) };
      }
      if (cursor === null) break;
    }
  }
}
