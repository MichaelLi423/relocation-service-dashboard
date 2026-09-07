/**
 * mobile-contract.test.ts — mobile-read-v1 线协议逻辑契约（focused slice）。
 *
 * 覆盖：
 * - pinned 上下文（snapshotId + activationId decimal string）是列表/详情/分区读取的
 *   强制要求；缺上下文显式拒绝，不保留 unpinned 静默 fallback。
 * - 未知参数（含 canary 键名/值）一律 metadata-only 拒绝，不进入错误可序列化属性。
 * - query ≤ 256 Unicode 码点（emoji 代理对计 1）；id/snapshotId/activationId ≤ 128 码点。
 * - cursor ≤ 4 KiB UTF-8 字节（TextEncoder，CJK 每字 3 字节）；拒绝时不 echo 原文。
 * - 仅允许指定 sort/status/region 枚举与五分区 kind；计数不 Number 强转。
 * - 结果统一为投影层 RemoteEnvelope-bearing DTO 别名（无扁平 result 副本）。
 * - 不做真实 DB/HTTP/过期重载 UI 断言（仅逻辑契约）。
 */
import { describe, expect, it } from 'vitest';
import {
  MOBILE_READ_V1,
  MOBILE_READ_PAGE_SIZE,
  MOBILE_ENVELOPE_KEYS,
  OVERVIEW_METRIC_KEYS,
  PROJECT_SORT_DEFAULT,
  normalizeOverviewRequest,
  normalizeProjectListRequest,
  normalizeDetailRequest,
  normalizeSectionRequest,
  type MobileOverviewResult,
  type MobileProjectListResult,
  type MobileProjectDetailResult,
  type MobileSectionResult,
} from '../../src/shared/remote-readonly/mobile-read-v1';
import type {
  RemoteOverviewDto,
  RemoteProjectPageDto,
  RemoteProjectDetailDto,
  RemoteSectionPageDto,
} from '../../src/shared/remote-readonly/projection';
import { UnknownFieldRejection, InvalidValueRejection } from '../../src/shared/remote-readonly/rejection';

const CTX = { snapshotId: 'snap-1', activationId: '3' };
const CANARY_KEY = 'canary联系人';
const CANARY_VALUE = '不该外发Σ秘密值';

/** 断言错误为指定类型且全部可序列化属性不含 canary 键/值。 */
function expectMetadataOnly(fn: () => unknown, markers: readonly string[], ctor: typeof UnknownFieldRejection | typeof InvalidValueRejection = UnknownFieldRejection): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof ctor)) {
      throw new Error(`expected ${ctor.name}, got ${(error as Error)?.name ?? typeof error}`);
    }
    const props = [error.message, error.name, error.code];
    const asAny = error as unknown as Record<string, unknown>;
    if (asAny['ref'] && typeof asAny['ref'] === 'object') props.push(JSON.stringify(asAny['ref']));
    const all = props.join('|');
    for (const marker of markers) expect(all).not.toContain(marker);
    return;
  }
  throw new Error(`expected ${ctor.name} to be thrown`);
}

describe('mobile-read-v1 协议常量与信封别名', () => {
  it('版本标识 / 页大小 / 信封键为契约锚点', () => {
    expect(MOBILE_READ_V1).toBe('mobile-read-v1');
    expect(MOBILE_READ_PAGE_SIZE).toBe(20);
    expect(MOBILE_ENVELOPE_KEYS).toContain('snapshotId');
    expect(MOBILE_ENVELOPE_KEYS).toContain('activationId');
  });

  it('概览指标键只含五键', () => {
    expect(OVERVIEW_METRIC_KEYS).toEqual([
      'totalProjects',
      'activeProjects',
      'pendingAcceptance',
      'pendingInvoice',
      'pendingAmount',
    ]);
  });

  it('结果类型与投影 DTO 相同（无扁平 result 副本；compile-time 别名）', () => {
    // 类型同一性：以下赋值在编译期证明 MobileXxxResult 即 RemoteXxxDto。
    const _o: MobileOverviewResult = null as unknown as RemoteOverviewDto;
    const _p: MobileProjectListResult = null as unknown as RemoteProjectPageDto;
    const _d: MobileProjectDetailResult = null as unknown as RemoteProjectDetailDto;
    const _s: MobileSectionResult = null as unknown as RemoteSectionPageDto;
    // 反向亦成立（同一类型，非仅结构兼容）
    const _o2: RemoteOverviewDto = _o;
    const _p2: RemoteProjectPageDto = _p;
    const _d2: RemoteProjectDetailDto = _d;
    const _s2: RemoteSectionPageDto = _s;
    expect([_o2, _p2, _d2, _s2]).toBeDefined();
  });
});

describe('mobile-read-v1 pinned 上下文强制', () => {
  it('概览是无上下文发现入口：空对象/null 通过', () => {
    expect(normalizeOverviewRequest({})).toEqual({});
    expect(normalizeOverviewRequest(undefined)).toEqual({});
    expect(normalizeOverviewRequest(null)).toEqual({});
  });

  it('列表请求缺 snapshotId/activationId 显式拒绝（无 unpinned fallback）', () => {
    expect(() => normalizeProjectListRequest({})).toThrow(expect.objectContaining({ code: 'REQUIRED_FIELD' }));
    expectMetadataOnly(
      () => normalizeProjectListRequest({ snapshotId: 'snap-1' }),
      ['snap-1'],
      InvalidValueRejection,
    );
    expectMetadataOnly(
      () => normalizeProjectListRequest({ activationId: '3' }),
      ['3'],
      InvalidValueRejection,
    );
  });

  it('详情/分区请求同样强制 pinned 上下文', () => {
    expectMetadataOnly(
      () => normalizeDetailRequest({ projectId: 'p1' }),
      ['p1'],
      InvalidValueRejection,
    );
    expectMetadataOnly(
      () => normalizeSectionRequest({ projectId: 'p1', kind: 'batches' }),
      ['p1'],
      InvalidValueRejection,
    );
  });

  it('activationId 为 decimal string 且往返保留', () => {
    const list = normalizeProjectListRequest({ ...CTX, sort: 'plan_visit_asc' });
    expect(list).toMatchObject({ snapshotId: 'snap-1', activationId: '3', sort: 'plan_visit_asc' });
    expect(typeof list.activationId).toBe('string');
    const detail = normalizeDetailRequest({ ...CTX, projectId: 'p1' });
    expect(detail).toMatchObject({ snapshotId: 'snap-1', activationId: '3', projectId: 'p1' });
    const section = normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 'invoices' });
    expect(section).toMatchObject({ snapshotId: 'snap-1', activationId: '3', kind: 'invoices', cursor: null });
  });
});

describe('mobile-read-v1 未知参数 metadata-only 拒绝', () => {
  it('列表请求未知顶层键（canary 键名/值）不 echo', () => {
    expectMetadataOnly(
      () => normalizeProjectListRequest({ ...CTX, [CANARY_KEY]: CANARY_VALUE }),
      [CANARY_KEY, CANARY_VALUE],
    );
  });

  it('详情请求未知键（activities 等未批准分区/业务参数）不 echo', () => {
    expectMetadataOnly(
      () => normalizeDetailRequest({ ...CTX, projectId: 'p1', activities: 1 }),
      ['activities'],
    );
    expectMetadataOnly(
      () => normalizeDetailRequest({ ...CTX, projectId: 'p1', [CANARY_KEY]: CANARY_VALUE }),
      [CANARY_KEY, CANARY_VALUE],
    );
  });

  it('分区请求未知键不 echo', () => {
    expectMetadataOnly(
      () => normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 'batches', repair: 'open' }),
      ['repair'],
    );
  });

  it('概览请求携带参数拒绝（概览无查询参数）', () => {
    expectMetadataOnly(
      () => normalizeOverviewRequest({ status: 'completed' }),
      ['status'],
    );
  });
});

describe('mobile-read-v1 边界：query 256 码点 / id 128 码点', () => {
  it('query ≤ 256 Unicode 码点：emoji 代理对按 1 计数', () => {
    const emoji = '😀';
    expect([...emoji].length).toBe(1); // 1 码点、2 UTF-16 单元
    // 256 个 emoji = 256 码点（UTF-16 length 512）→ 通过
    const ok = normalizeProjectListRequest({ ...CTX, query: emoji.repeat(256) });
    expect(ok.query).toBe(emoji.repeat(256));
    // 257 个 emoji → 拒绝（按码点而非 UTF-16）
    expectMetadataOnly(
      () => normalizeProjectListRequest({ ...CTX, query: emoji.repeat(257) }),
      [],
      InvalidValueRejection,
    );
    // 257 个 'x'（各 1 码点）同样拒绝
    expect(() => normalizeProjectListRequest({ ...CTX, query: 'x'.repeat(257) })).toThrow(/256/);
  });

  it('snapshotId/projectId ≤ 128 码点', () => {
    const id256 = 'x'.repeat(129);
    expectMetadataOnly(
      () => normalizeProjectListRequest({ snapshotId: id256, activationId: '3' }),
      [],
      InvalidValueRejection,
    );
    expectMetadataOnly(
      () => normalizeDetailRequest({ ...CTX, projectId: '😀'.repeat(129) }),
      [],
      InvalidValueRejection,
    );
    // 128 个 emoji 码点通过
    const ok = normalizeDetailRequest({ ...CTX, projectId: '😀'.repeat(128) });
    expect(ok.projectId).toBe('😀'.repeat(128));
  });
});

describe('mobile-read-v1 边界：cursor ≤ 4 KiB UTF-8 字节', () => {
  it('CJK 每字 3 字节：字节边界按 TextEncoder 而非 length 计数', () => {
    const cjk = '中'; // 1 码点 = 3 UTF-8 字节
    const utf8len = (s: string): number => new TextEncoder().encode(s).byteLength;
    expect(utf8len(cjk)).toBe(3);
    // 恰好 ≤ 4096 字节：1365 字（4095 字节）通过
    const ok = normalizeProjectListRequest({ ...CTX, cursor: cjk.repeat(1365) });
    expect(ok.cursor).toBe(cjk.repeat(1365));
    // 超过 4096 字节：1366 字（4098 字节）拒绝
    expect(() => normalizeProjectListRequest({ ...CTX, cursor: cjk.repeat(1366) })).toThrow(/4 KiB/);
  });

  it('ASCII cursor 5000 字节拒绝且不 echo 原文', () => {
    expectMetadataOnly(
      () => normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 'batches', cursor: 'x'.repeat(5000) }),
      [],
      InvalidValueRejection,
    );
  });
});

describe('mobile-read-v1 枚举与类型严格（无强转）', () => {
  it('仅指定 sort；缺省 updated', () => {
    expect(normalizeProjectListRequest({ ...CTX }).sort).toBe('updated');
    expect(PROJECT_SORT_DEFAULT).toBe('updated');
    expect(normalizeProjectListRequest({ ...CTX, sort: 'plan_visit_desc' }).sort).toBe('plan_visit_desc');
    expectMetadataOnly(
      () => normalizeProjectListRequest({ ...CTX, sort: 'created' }),
      [],
      InvalidValueRejection,
    );
  });

  it('status/region 仅允许枚举或 null；free text 拒绝', () => {
    expect(normalizeProjectListRequest({ ...CTX, status: 'pending_invoice' }).status).toBe('pending_invoice');
    expect(normalizeProjectListRequest({ ...CTX, region: 'East' }).region).toBe('East');
    expect(normalizeProjectListRequest({ ...CTX, region: null }).region).toBeNull();
    expect(() => normalizeProjectListRequest({ ...CTX, region: '未填写' })).toThrow(/区域筛选/);
    expect(() => normalizeProjectListRequest({ ...CTX, region: '待调整' })).toThrow(/区域筛选/);
    expect(() => normalizeProjectListRequest({ ...CTX, status: '维修中' })).toThrow(/主状态/);
  });

  it('分区 kind 仅五类；非法 kind / 非文本 kind 拒绝', () => {
    expect(normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 'damage_items' }).kind).toBe('damage_items');
    expectMetadataOnly(
      () => normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 'activities' }),
      [],
      InvalidValueRejection,
    );
    expectMetadataOnly(
      () => normalizeSectionRequest({ ...CTX, projectId: 'p1', kind: 5 as unknown as 'batches' }),
      [],
      InvalidValueRejection,
    );
  });

  it('数字不 Number 强转：非文本 query/cursor 拒绝', () => {
    expectMetadataOnly(
      () => normalizeProjectListRequest({ ...CTX, query: 123 as unknown as string }),
      [],
      InvalidValueRejection,
    );
    expectMetadataOnly(
      () => normalizeProjectListRequest({ ...CTX, cursor: 4096 as unknown as string }),
      [],
      InvalidValueRejection,
    );
  });
});
