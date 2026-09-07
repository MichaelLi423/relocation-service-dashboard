/**
 * snapshot-records.test.ts（tasks 2.2 snapshot-records 枚举切片）
 *
 * 用 fake paged reader（内存 synthetic 数据；复用 tests fixtures 的源 DTO 形状，
 * 不含真实业务/客户值）验证 enumerateSnapshotRecords：
 * - 全部项目分页（45 个 > 固定 20/页，跨 3 页直到 nextCursor null）且不带任何 UI 筛选
 *   （status/query/reminder/sort 全缺省，pre-entry/completed/cancelled 全覆盖）；
 * - 每项目关联 detail：project.id === 行 id；五分区（不含 activities）逐行枚举；
 * - canary（置于排除字段）绝不进入任何产出行；必填字段非法/关联不一致 → fail closed，
 *   无部分成功（枚举中途抛错，不返回成功计数/不静默跳过非法行）；
 * - 分页无进展（重复游标 / 空页却声明 nextCursor）→ NO_PROGRESS 拒绝；
 * - 永不请求 activities 等未知 kind；回包 kind/行 kind/行 projectId 不匹配 → 拒绝；
 * - 实体行字节上限由实现保证（本测试不构造 >64KiB 行，64KiB/100000 属既有 design 硬限）。
 */
import { describe, expect, it } from 'vitest';
import { parseRemoteProjectRecordJsonl } from '../../src/shared/remote-readonly/jsonl';
import { InvalidValueRejection } from '../../src/shared/remote-readonly/rejection';
import type {
  WorkbenchProjectRow,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageRequest,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionKind,
  WorkbenchV2SectionPageDto,
  WorkbenchV2SectionRow,
} from '../../src/shared/ipc';
import {
  makeSyntheticProject,
  syntheticDetail,
  syntheticSections,
  SYNTHETIC_TECH_NOW,
} from './fixtures/project-sources';
import {
  enumerateSnapshotRecords,
  SnapshotRecordsError,
  SnapshotRecordsReader,
  SnapshotRecordCounts,
  SNAPSHOT_RECORDS_SECTION_KINDS,
} from '../../src/main/remote-readonly/snapshot-records';

const PAGE_SIZE = 20;

interface StoreProject {
  row: WorkbenchProjectRow;
  detail: NonNullable<WorkbenchV2ProjectDetailDto['detail']>;
  sections: Partial<Record<WorkbenchV2SectionKind, WorkbenchV2SectionRow[]>>;
}

function emptyDetail(): NonNullable<WorkbenchV2ProjectDetailDto['detail']> {
  const d = syntheticDetail();
  if (d === null) throw new Error('syntheticDetail 不应为 null');
  return d;
}

/** 复制 syntheticSections 中某 kind 的基行并覆盖 id/projectId（fixture 的 damage 键对应 damage_items）。 */
function makeSectionRow(
  kind: Exclude<WorkbenchV2SectionKind, 'activities'>,
  projectId: string,
  seed: string,
): WorkbenchV2SectionRow {
  const source = syntheticSections();
  const base = kind === 'damage_items' ? source.damage : source[kind];
  return {
    ...base,
    kind,
    id: `${seed}-${kind}`,
    projectId,
  } as WorkbenchV2SectionRow;
}

/** 构造 store 项目：45 个覆盖全部状态（含 pre-entry/completed/cancelled）。 */
function buildStoreProjects(count = 45): StoreProject[] {
  const statuses: WorkbenchProjectRow['status'][] = [
    'pending_entry',
    'pending_execution',
    'executing',
    'under_repair',
    'pending_acceptance',
    'pending_invoice',
    'completed',
    'cancelled',
  ];
  const out: StoreProject[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `p-${String(i + 1).padStart(3, '0')}`;
    out.push({
      row: makeSyntheticProject({
        id,
        tempNo: `TP-${id}`,
        ecc: `ECC-${id}`,
        customerName: `客户 ${id}`,
        status: statuses[i % statuses.length],
        updatedAt: SYNTHETIC_TECH_NOW,
      }),
      detail: emptyDetail(),
      sections: {},
    });
  }
  return out;
}

/** 构造 fake reader：从内存 store 切片；记录每次 projectPage/sectionPage 请求。 */
function buildFakeReader(store: StoreProject[]): {
  reader: SnapshotRecordsReader;
  requestedProjectFilters: WorkbenchV2ProjectPageRequest[];
  requestedSectionKinds: WorkbenchV2SectionKind[];
} {
  const requestedProjectFilters: WorkbenchV2ProjectPageRequest[] = [];
  const requestedSectionKinds: WorkbenchV2SectionKind[] = [];
  const api: SnapshotRecordsReader = {
    projectPage(request: WorkbenchV2ProjectPageRequest): WorkbenchV2ProjectPageDto {
      requestedProjectFilters.push(request);
      // 固定 20/页 keyset：游标为不透明页码字符串。
      const cursorIndex = request.cursor === null || request.cursor === undefined ? 0 : Number(request.cursor);
      const start = cursorIndex * PAGE_SIZE;
      const pageRows = store.slice(start, start + PAGE_SIZE).map((p) => p.row);
      const hasMore = start + PAGE_SIZE < store.length;
      return {
        businessRevision: 0,
        projects: pageRows,
        total: store.length,
        nextCursor: hasMore ? String(cursorIndex + 1) : null,
        limit: PAGE_SIZE,
        pageSize: PAGE_SIZE,
      };
    },
    projectDetail(projectId: string): WorkbenchV2ProjectDetailDto {
      const sp = store.find((p) => p.row.id === projectId);
      if (!sp) return { businessRevision: 0, project: null, detail: null };
      return { businessRevision: 0, project: sp.row, tagIds: [], groupedTags: [], detail: sp.detail };
    },
    sectionPage(request: { projectId: string; kind: WorkbenchV2SectionKind; cursor?: string | null; from?: string | null; to?: string | null; limit?: number }): WorkbenchV2SectionPageDto {
      requestedSectionKinds.push(request.kind);
      const sp = store.find((p) => p.row.id === request.projectId);
      const rows = sp?.sections[request.kind] ?? [];
      return {
        businessRevision: 0,
        kind: request.kind,
        projectId: request.projectId,
        rows,
        total: rows.length,
        nextCursor: null,
        limit: 50,
      };
    },
  };
  return { reader: api, requestedProjectFilters, requestedSectionKinds };
}

/** 收集 generator 全部 yield + return 计数。 */
function collectAll(reader: SnapshotRecordsReader): {
  items: Array<{ kind: string; line: string }>;
  counts: SnapshotRecordCounts;
} {
  const gen = enumerateSnapshotRecords(reader);
  const items: Array<{ kind: string; line: string }> = [];
  let counts: SnapshotRecordCounts | undefined;
  while (true) {
    const { done, value } = gen.next();
    if (done) {
      counts = value as SnapshotRecordCounts;
      break;
    }
    items.push({ kind: value.kind, line: value.line });
  }
  if (counts === undefined) throw new Error('generator 未返回计数');
  return { items, counts };
}

describe('snapshot-records：全量项目分页与无筛选', () => {
  it('45 项目跨 3 页全部枚举；请求不带任何 UI 筛选（status/query/reminder/sort 缺省）', () => {
    const store = buildStoreProjects(45);
    const f = buildFakeReader(store);
    const { items, counts } = collectAll(f.reader);
    // 全部状态项目都被产出（含 pre-entry/completed/cancelled）
    expect(counts.projects).toBe(45);
    const projectLines = items.filter((i) => i.kind === 'project');
    expect(projectLines).toHaveLength(45);
    const statusesIn = new Set(store.map((p) => p.row.status));
    expect(statusesIn.has('pending_entry')).toBe(true);
    expect(statusesIn.has('completed')).toBe(true);
    expect(statusesIn.has('cancelled')).toBe(true);
    // 项目分页请求无任何筛选字段
    expect(f.requestedProjectFilters.length).toBeGreaterThanOrEqual(3);
    for (const req of f.requestedProjectFilters) {
      expect(req.status).toBeUndefined();
      expect(req.query).toBeUndefined();
      expect(req.reminder).toBeUndefined();
      expect(req.sort).toBeUndefined();
      expect(req.region).toBeUndefined();
    }
  });

  it('每项目关联同一 detail：project.id === 行 id（解析权威 JSONL 行校验）', () => {
    const store = buildStoreProjects(5);
    const f = buildFakeReader(store);
    const { items } = collectAll(f.reader);
    for (const item of items.filter((i) => i.kind === 'project')) {
      const record = parseRemoteProjectRecordJsonl(item.line);
      expect(record.kind).toBe('project');
      expect(record.detail.id).toBe(record.row.id);
    }
  });
});

describe('snapshot-records：每项目五分区子记录', () => {
  it('枚举全部五个分区（不含 activities）；行 projectId 关联当前项目', () => {
    const store = buildStoreProjects(3);
    // 给第二个项目每个分区 1 行；第三项目仅 batches 2 行（跨页不必要，>0 即可）。
    const pid2 = store[1].row.id;
    const pid3 = store[2].row.id;
    for (const kind of SNAPSHOT_RECORDS_SECTION_KINDS) {
      store[1].sections[kind] = [makeSectionRow(kind as never, pid2, `p2-${kind}`)];
    }
    store[2].sections.batches = [
      makeSectionRow('batches', pid3, 'p3-b-1'),
      makeSectionRow('batches', pid3, 'p3-b-2'),
    ];
    const f = buildFakeReader(store);
    const { items, counts } = collectAll(f.reader);
    expect(counts.projects).toBe(3);
    expect(counts.batches).toBe(3); // pid2 1 + pid3 2
    expect(counts.instruments).toBe(1);
    expect(counts.orders).toBe(1);
    expect(counts.invoices).toBe(1);
    expect(counts.damageItems).toBe(1);
    const sectionLines = items.filter((i) => i.kind !== 'project');
    expect(sectionLines).toHaveLength(7);
    // 所有 section JSONL 行的 row.projectId 均关联其项目行
    for (const item of sectionLines) {
      const parsed = JSON.parse(item.line) as { kind: string; row: { projectId: string } };
      const projectId = parsed.row.projectId;
      const project = store.find((p) => p.row.id === projectId);
      expect(project).toBeDefined();
    }
    // 从未请求 activities
    expect(f.requestedSectionKinds).not.toContain('activities');
    for (const kind of f.requestedSectionKinds) {
      expect(SNAPSHOT_RECORDS_SECTION_KINDS).toContain(kind);
    }
  });

  it('分区 >50 行跨页枚举：游标推进直到 nextCursor null', () => {
    const store = buildStoreProjects(1);
    const pid = store[0].row.id;
    // 55 条 batches 行（>50 默认分页大小，跨 2 页）
    store[0].sections.batches = Array.from({ length: 55 }, (_, k) =>
      makeSectionRow('batches', pid, `multi-${k}`),
    );
    const requestedCursors: Array<string | null | undefined> = [];
    const f = buildFakeReader(store);
    // 覆写 sectionPage：用 cursor 序号切页返回
    const pagedSection = {
      ...f.reader,
      sectionPage(request: { projectId: string; kind: WorkbenchV2SectionKind; cursor?: string | null; from?: string | null; to?: string | null; limit?: number }): WorkbenchV2SectionPageDto {
        if (request.kind !== 'batches') {
          const sp = store.find((p) => p.row.id === request.projectId);
          const rows = sp?.sections[request.kind] ?? [];
          return { businessRevision: 0, kind: request.kind, projectId: request.projectId, rows, total: rows.length, nextCursor: null, limit: 50 };
        }
        requestedCursors.push(request.cursor ?? null);
        const idx = request.cursor === null || request.cursor === undefined ? 0 : Number(request.cursor);
        const rows = store[0].sections.batches!.slice(idx * 50, (idx + 1) * 50);
        return {
          businessRevision: 0,
          kind: 'batches',
          projectId: request.projectId,
          rows,
          total: 55,
          nextCursor: idx === 0 ? '1' : null,
          limit: 50,
        };
      },
    };
    const { counts } = collectAll(pagedSection);
    expect(counts.batches).toBe(55);
    expect(requestedCursors).toEqual([null, '1']);
  });

  it('分页响应 kind 与请求不符 → ASSOCIATION_MISMATCH', () => {
    const store = buildStoreProjects(2);
    const f = buildFakeReader(store);
    // 篡改 reader：对 batches 请求返回 activities kind（模块在进入行级前即拒绝）。
    const broken = {
      ...f.reader,
      sectionPage: (request: Parameters<SnapshotRecordsReader['sectionPage']>[0]): WorkbenchV2SectionPageDto => {
        const kind = request.kind === 'batches' ? 'activities' : request.kind;
        return {
          businessRevision: 0,
          kind,
          projectId: request.projectId,
          rows: [],
          total: 0,
          nextCursor: null,
          limit: 50,
        };
      },
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SnapshotRecordsError);
    expect((threw as SnapshotRecordsError).code).toBe('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
  });

  it('分区行 projectId 与当前项目不符 → ASSOCIATION_MISMATCH（行级不静默跳过）', () => {
    const store = buildStoreProjects(2);
    const f = buildFakeReader(store);
    const otherProjectId = store[1].row.id;
    // 篡改 reader：batches 请求返回 projectId 属于另一项目的行（kind 仍为 batches）。
    const broken = {
      ...f.reader,
      sectionPage: (request: Parameters<SnapshotRecordsReader['sectionPage']>[0]): WorkbenchV2SectionPageDto => {
        if (request.kind !== 'batches') {
          const sp = store.find((p) => p.row.id === request.projectId);
          const rows = sp?.sections[request.kind] ?? [];
          return { businessRevision: 0, kind: request.kind, projectId: request.projectId, rows, total: rows.length, nextCursor: null, limit: 50 };
        }
        const foreignRow = makeSectionRow('batches', otherProjectId, 'foreign');
        return {
          businessRevision: 0,
          kind: 'batches',
          projectId: request.projectId,
          rows: [foreignRow],
          total: 1,
          nextCursor: null,
          limit: 50,
        };
      },
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SnapshotRecordsError);
    expect((threw as SnapshotRecordsError).code).toBe('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
  });
});

describe('snapshot-records：canary 排除与严格 fail-closed', () => {
  it('canary 置于排除字段（提醒备注/标签/运输公司/工程师/制造商/撤销原因/维修备注）绝不进入任何行', () => {
    const CANARY = 'CANARY-SECRET-42';
    const store = buildStoreProjects(2);
    // 排除字段放 canary：项目行 tagIds/reminderNote、detail 备注、五个分区的排除字段。
    store[0].row.reminderNote = CANARY;
    store[0].row.tagIds = ['tag-1'];
    if (store[0].detail) store[0].detail.projectNote = CANARY;
    const pid0 = store[0].row.id;
    const batches = makeSectionRow('batches', pid0, 'c0');
    (batches as { transportCompany: string | null }).transportCompany = CANARY;
    store[0].sections.batches = [batches];
    const instruments = makeSectionRow('instruments', pid0, 'c0');
    (instruments as { manufacturer: string | null }).manufacturer = CANARY;
    store[0].sections.instruments = [instruments];
    const orders = makeSectionRow('orders', pid0, 'c0');
    (orders as { engineer: string | null }).engineer = CANARY;
    store[0].sections.orders = [orders];
    const invoices = makeSectionRow('invoices', pid0, 'c0');
    (invoices as { revokeReason: string | null }).revokeReason = CANARY;
    store[0].sections.invoices = [invoices];
    const damage = makeSectionRow('damage_items', pid0, 'c0');
    (damage as { repairNote: string | null }).repairNote = CANARY;
    (damage as { damageReason: string | null }).damageReason = CANARY;
    store[0].sections.damage_items = [damage];
    const f = buildFakeReader(store);
    const { items } = collectAll(f.reader);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.line).not.toContain(CANARY);
    }
  });

  it('必填字段非法（非法 status）→ 严格解析抛出；无部分成功（不产出成功计数/不静默跳过）', () => {
    const store = buildStoreProjects(3);
    const invalidRow = store[1].row;
    (invalidRow as { status: string }).status = 'purple';
    const f = buildFakeReader(store);
    let threw: unknown;
    try {
      collectAll(f.reader);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(InvalidValueRejection);
    expect((threw as InvalidValueRejection).code).toBe('INVALID_ENUM');
    // metadata-only：错误 message 不回显非法值 / 项目 id
    expect((threw as Error).message).not.toContain('purple');
    expect((threw as Error).message).not.toContain('p-002');
  });

  it('projectDetail 缺失/关联项目 id 与行不符 → ASSOCIATION_MISMATCH', () => {
    const store = buildStoreProjects(2);
    const f = buildFakeReader(store);
    const missingId = store[1].row.id;
    const broken = {
      ...f.reader,
      projectDetail: (id: string): WorkbenchV2ProjectDetailDto => {
        if (id === missingId) return { businessRevision: 0, project: null, detail: null };
        const sp = store.find((p) => p.row.id === id);
        return sp ? { businessRevision: 0, project: sp.row, detail: sp.detail } : { businessRevision: 0, project: null, detail: null };
      },
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SnapshotRecordsError);
    expect((threw as SnapshotRecordsError).code).toBe('SNAPSHOT_RECORDS_ASSOCIATION_MISMATCH');
  });
});

describe('snapshot-records：分页进度守卫', () => {
  it('重复游标（无进展）→ NO_PROGRESS', () => {
    const store = buildStoreProjects(2);
    const f = buildFakeReader(store);
    // projectPage 永远返回 nextCursor='x'（第二页起与请求游标相同）。
    const broken: SnapshotRecordsReader = {
      projectPage(request: WorkbenchV2ProjectPageRequest): WorkbenchV2ProjectPageDto {
        const row = store[0].row;
        return {
          businessRevision: 0,
          projects: [row],
          total: store.length,
          nextCursor: request.cursor === null || request.cursor === undefined ? 'x' : 'x',
          limit: PAGE_SIZE,
          pageSize: PAGE_SIZE,
        };
      },
      projectDetail: f.reader.projectDetail,
      sectionPage: f.reader.sectionPage,
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SnapshotRecordsError);
    expect((threw as SnapshotRecordsError).code).toBe('SNAPSHOT_RECORDS_NO_PROGRESS');
    expect((threw as Error).message).toBe('snapshot records SNAPSHOT_RECORDS_NO_PROGRESS');
  });

  it('空页却声明 nextCursor（无进展）→ NO_PROGRESS', () => {
    const store = buildStoreProjects(1);
    const f = buildFakeReader(store);
    const broken: SnapshotRecordsReader = {
      projectPage(): WorkbenchV2ProjectPageDto {
        return {
          businessRevision: 0,
          projects: [],
          total: 1,
          nextCursor: 'x',
          limit: PAGE_SIZE,
          pageSize: PAGE_SIZE,
        };
      },
      projectDetail: f.reader.projectDetail,
      sectionPage: f.reader.sectionPage,
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SnapshotRecordsError);
    expect((threw as SnapshotRecordsError).code).toBe('SNAPSHOT_RECORDS_NO_PROGRESS');
  });

  it('错误 metadata-only：message 只含稳定 code，不回显 id/值', () => {
    const store = buildStoreProjects(2);
    const f = buildFakeReader(store);
    const broken: SnapshotRecordsReader = {
      projectPage(): WorkbenchV2ProjectPageDto {
        return { businessRevision: 0, projects: [], total: 1, nextCursor: 'x', limit: 20, pageSize: 20 };
      },
      projectDetail: f.reader.projectDetail,
      sectionPage: f.reader.sectionPage,
    };
    let threw: unknown;
    try {
      collectAll(broken);
    } catch (e) {
      threw = e;
    }
    const msg = (threw as Error).message;
    expect(msg).toBe('snapshot records SNAPSHOT_RECORDS_NO_PROGRESS');
    expect(msg).not.toMatch(/p-0\d\d|x/i);
  });
});
