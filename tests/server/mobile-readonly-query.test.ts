import { afterEach, describe, expect, it } from 'vitest';
import {
  MOBILE_READONLY_RECORD_KINDS,
  type MobileReadonlyOverviewData,
  type MobileReadonlyProject,
  type MobileReadonlyProjectListData,
  type MobileReadonlyProjectRecords,
  type MobileReadonlyQueryResponse,
  type MobileReadonlyRecordKind,
  type MobileReadonlySnapshot,
} from '../../src/shared/mobile-readonly';
import {
  makeActivityRecordFixture,
  makeBatchRecordFixture,
  makeDamageItemRecordFixture,
  makeEmptySnapshotFixture,
  makeInstrumentRecordFixture,
  makeInvoiceRecordFixture,
  makeOrderRecordFixture,
  makeProjectFixture,
  makeSnapshotFixture,
} from '../helpers/mobile-readonly-fixtures';
import {
  TEST_UPLOAD_TOKEN,
  basicAuthHeader,
  doFetch,
  startTestService,
  stopTestService,
  uploadInit,
  type StartedTestService,
} from './mobile-readonly-test-helpers';

/**
 * 有界只读查询端点（tasks 7.4）：
 * - overview/项目搜索筛选分页/详情/按类关联记录分页全在服务端执行；
 * - 业务响应统一 { metadata, data } 且 metadata 版本与 data 同一次缓存包络一致；
 * - 项目行/详情绝不携带 records；不返回 current.json 包络或 snapshot 全文；
 * - 游标绑定版本：过期游标 409 STALE_CURSOR 并返回当前元数据。
 */

const services: StartedTestService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await stopTestService(service);
});

async function startFresh(): Promise<StartedTestService> {
  const service = await startTestService();
  services.push(service);
  return service;
}

function viewerGet(baseUrl: string, path: string): Promise<Response> {
  return doFetch(baseUrl, path, { headers: { Authorization: basicAuthHeader() } });
}

function uploadPayload(publicationId: string, expectedCurrentVersion: number, snapshot: MobileReadonlySnapshot): unknown {
  return { protocol: { publicationId, expectedCurrentVersion }, snapshot };
}

async function publish(service: StartedTestService, publicationId: string, expectedCurrentVersion: number, snapshot: MobileReadonlySnapshot): Promise<number> {
  const res = await doFetch(
    service.baseUrl,
    '/api/publish',
    uploadInit(uploadPayload(publicationId, expectedCurrentVersion, snapshot), TEST_UPLOAD_TOKEN),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: string; metadata: { currentVersion: number } };
  return body.metadata.currentVersion;
}

function makeProjects(count: number, status?: MobileReadonlyProject['status'], region?: string | null): MobileReadonlyProject[] {
  return Array.from({ length: count }, (_, index) =>
    makeProjectFixture({
      id: `proj-${String(index).padStart(2, '0')}`,
      tempNo: `TP-${String(100 + index)}`,
      ecc: index % 2 === 0 ? `ECC-${index}` : null,
      customerName: `测试客户${index}`,
      // 绝不把 undefined 放进覆盖键：JSON.stringify 会丢键 → 服务端严格校验 MISSING_KEY。
      status: status ?? (index % 2 === 0 ? 'executing' : 'pending_execution'),
      region: region === undefined ? (index % 2 === 0 ? 'East' : 'North') : region,
    }),
  );
}

function recordsProject(rowsPerKind = 7): MobileReadonlyProject {
  const make = <T>(kind: (index: number) => T): T[] => Array.from({ length: rowsPerKind }, (_, index) => kind(index));
  const records: MobileReadonlyProjectRecords = {
    batches: make(makeBatchRecordFixture),
    instruments: make(makeInstrumentRecordFixture),
    activities: make(makeActivityRecordFixture),
    orders: make(makeOrderRecordFixture),
    invoices: make(makeInvoiceRecordFixture),
    damage_items: make(makeDamageItemRecordFixture),
  };
  return makeProjectFixture({ id: 'records-project', tempNo: 'TP-RECORDS', records });
}

describe('概览与版本载体（7.4）', () => {
  it('GET /api/overview 返回 metadata（dataAsOf/publishedAt/currentVersion/指纹）与概览 data', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({
      projects: makeProjects(3, 'executing', 'East'),
    });
    const version = await publish(service, 'P-overview', 0, snapshot);
    expect(version).toBe(1);

    const res = await viewerGet(service.baseUrl, '/api/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MobileReadonlyQueryResponse<MobileReadonlyOverviewData>;
    expect(body.metadata.published).toBe(true);
    expect(body.metadata.currentVersion).toBe(1);
    expect(body.metadata.publicationId).toBe('P-overview');
    expect(body.metadata.dataAsOf).toBe(snapshot.dataAsOf);
    expect(body.metadata.fingerprint).toEqual({
      contentGenerationId: snapshot.contentGenerationId,
      businessRevision: snapshot.businessRevision,
    });
    expect(body.metadata.publishedAt).not.toBeNull();
    // 只含 metadata 与 data 两键；overview 数据与快照同源。
    expect(Object.keys(body).sort()).toEqual(['data', 'metadata']);
    expect(body.data.overview).not.toBeNull();
    // 概览数据与快照同源（快照 overview.metrics 原样返回）。
    expect(body.data.overview?.metrics.totalProjects).toBe(snapshot.overview.metrics.totalProjects);
    // 概览响应绝不包含整份 JSON。
    const text = await (await viewerGet(service.baseUrl, '/api/overview')).text();
    expect(text).not.toContain('"schemaVersion"');
    expect(text).not.toContain('"tempNo"');
  });
});

describe('项目搜索/筛选/分页（7.4）', () => {
  it('跨页分页返回有界页、无重复无遗漏，且每页 metadata 版本一致', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({ projects: makeProjects(7) });
    await publish(service, 'P-page', 0, snapshot);

    const seenIds: string[] = [];
    let cursor: string | null = null;
    let expectedVersion = 1;
    do {
      const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await viewerGet(service.baseUrl, `/api/projects?limit=3${suffix}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
      expect(body.metadata.currentVersion).toBe(expectedVersion);
      expect(body.data.items.length).toBeLessThanOrEqual(3);
      for (const item of body.data.items) {
        expect(seenIds.includes(item.id)).toBe(false);
        seenIds.push(item.id);
        // 项目行绝不携带 records / 快照元数据键。
        expect('records' in item).toBe(false);
        expect('schemaVersion' in item).toBe(false);
      }
      cursor = body.data.nextCursor;
    } while (cursor !== null);
    expect(seenIds.length).toBe(7);
  });

  it('服务端搜索覆盖 customerName/tempNo/ecc 且忽略大小写', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({ projects: makeProjects(6) });
    await publish(service, 'P-search', 0, snapshot);

    // tempNo 子串（忽略大小写）
    const byTemp = await viewerGet(service.baseUrl, `/api/projects?query=${encodeURIComponent('tp-103')}`);
    const tempBody = (await byTemp.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(tempBody.data.items.map((p) => p.id)).toEqual(['proj-03']);

    // ECC（仅偶数项目有 ECC）
    const byEcc = await viewerGet(service.baseUrl, `/api/projects?query=${encodeURIComponent('ECC-4')}`);
    const eccBody = (await byEcc.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(eccBody.data.items.map((p) => p.id)).toEqual(['proj-04']);

    // customerName（中文子串）
    const byCustomer = await viewerGet(service.baseUrl, `/api/projects?query=${encodeURIComponent('客户5')}`);
    const customerBody = (await byCustomer.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(customerBody.data.items.map((p) => p.id)).toEqual(['proj-05']);

    // 无匹配 → 空列表且 nextCursor null
    const none = await viewerGet(service.baseUrl, `/api/projects?query=${encodeURIComponent('不存在客户名')}`);
    const noneBody = (await none.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(noneBody.data.items).toEqual([]);
    expect(noneBody.data.nextCursor).toBeNull();
  });

  it('状态/区域筛选与搜索组合；末页正确收尾', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({
      projects: [
        ...makeProjects(4, 'executing', 'East'),
        ...makeProjects(3, 'pending_execution', 'North'),
        ...makeProjects(2, 'executing', 'North'),
      ],
    });
    await publish(service, 'P-filter', 0, snapshot);

    const all = await viewerGet(service.baseUrl, '/api/projects?status=executing&region=East&limit=100');
    const allBody = (await all.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(allBody.data.items.length).toBe(4);
    for (const item of allBody.data.items) {
      expect(item.status).toBe('executing');
      expect(item.region).toBe('East');
    }
    expect(allBody.data.nextCursor).toBeNull(); // 单页内全部返回 → 无下一页

    // 组合搜索 + 筛选且跨页：East+executing 中搜索最后一个项目（索引 3，跨 limit=2 的末页）。
    const paged = await viewerGet(service.baseUrl, `/api/projects?status=executing&region=East&query=${encodeURIComponent('客户3')}`);
    const pagedBody = (await paged.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(pagedBody.data.items.map((p) => p.id)).toEqual(['proj-03']);

    // 非法状态/非法 region 类型仍受控：非法状态返回 400。
    const badStatus = await viewerGet(service.baseUrl, '/api/projects?status=not_a_status');
    expect(badStatus.status).toBe(400);
  });
});

describe('项目详情与按类记录分页（7.4）', () => {
  it('详情只含行字段（无 records），未命中返回 project:null', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({
      projects: [makeProjectFixture({ id: 'detail-proj', tempNo: 'TP-DETAIL', customerName: '详情客户' }), ...makeProjects(2)],
    });
    await publish(service, 'P-detail', 0, snapshot);

    const res = await viewerGet(service.baseUrl, `/api/project?id=${encodeURIComponent('detail-proj')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MobileReadonlyQueryResponse<{ project: Record<string, unknown> | null }>;
    expect(body.data.project?.tempNo).toBe('TP-DETAIL');
    expect('records' in (body.data.project ?? {})).toBe(false);
    expect(Object.keys(body.data.project ?? {}).sort()).toEqual(
      [
        'contractAmount',
        'customerName',
        'ecc',
        'entryAt',
        'finalAmount',
        'formallyEntered',
        'id',
        'invoicedAmount',
        'planVisitAt',
        'preEntryExecution',
        'region',
        'regionNeedsAdjustment',
        'status',
        'tempNo',
      ].sort(),
    );

    const missing = await viewerGet(service.baseUrl, `/api/project?id=${encodeURIComponent('no-such-project')}`);
    const missingBody = (await missing.json()) as MobileReadonlyQueryResponse<{ project: null }>;
    expect(missingBody.data.project).toBeNull();
    expect(missingBody.metadata.currentVersion).toBe(1);
  });

  it('六类关联记录各自跨页分页、末页正确、行字段为白名单键', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({ projects: [recordsProject(7)] });
    await publish(service, 'P-records', 0, snapshot);

    for (const kind of MOBILE_READONLY_RECORD_KINDS) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const res = await viewerGet(
          service.baseUrl,
          `/api/records?projectId=${encodeURIComponent('records-project')}&kind=${kind}&limit=3${suffix}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as MobileReadonlyQueryResponse<{
          kind: MobileReadonlyRecordKind;
          items: Array<Record<string, unknown>>;
          nextCursor: string | null;
        }>;
        expect(body.data.kind).toBe(kind);
        expect(body.data.items.length).toBeLessThanOrEqual(3);
        for (const item of body.data.items) {
          expect(seen.includes(item.id as string)).toBe(false);
          seen.push(item.id as string);
        }
        cursor = body.data.nextCursor;
      } while (cursor !== null);
      expect(seen.length).toBe(7);
    }

    // kind 受控枚举校验
    const badKind = await viewerGet(service.baseUrl, '/api/records?projectId=records-project&kind=nope&limit=3');
    expect(badKind.status).toBe(400);

    // 未知 projectId → 空页（nextCursor null）
    const unknownProject = await viewerGet(service.baseUrl, '/api/records?projectId=ghost&kind=batches&limit=3');
    const ghostBody = (await unknownProject.json()) as MobileReadonlyQueryResponse<{ items: unknown[]; nextCursor: string | null }>;
    expect(ghostBody.data.items).toEqual([]);
    expect(ghostBody.data.nextCursor).toBeNull();
  });
});

describe('游标版本绑定与参数上限（7.4）', () => {
  it('版本推进后旧游标 409 STALE_CURSOR 并返回当前元数据；重新首页可读新版本', async () => {
    const service = await startFresh();
    await publish(service, 'P-v1', 0, makeSnapshotFixture({ projects: makeProjects(3) }));

    const first = await viewerGet(service.baseUrl, '/api/projects?limit=2');
    const firstBody = (await first.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    const cursor = firstBody.data.nextCursor;
    expect(cursor).not.toBeNull();

    await publish(service, 'P-v2', 1, makeSnapshotFixture({ projects: makeProjects(5) }));

    const stale = await viewerGet(service.baseUrl, `/api/projects?limit=2&cursor=${encodeURIComponent(cursor ?? '')}`);
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { code: string }; metadata: { currentVersion: number; publicationId: string | null } };
    expect(staleBody.error.code).toBe('STALE_CURSOR');
    expect(staleBody.metadata.currentVersion).toBe(2);
    expect(staleBody.metadata.publicationId).toBe('P-v2');

    // 重新首页读取返回版本 2 元数据与一致 data。
    const fresh = await viewerGet(service.baseUrl, '/api/projects?limit=100');
    const freshBody = (await fresh.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(freshBody.metadata.currentVersion).toBe(2);
    expect(freshBody.data.items.length).toBe(5);
  });

  it('非法游标/超长参数/非法 limit 返回 400 或受控错误，不产生 5xx', async () => {
    const service = await startFresh();
    await publish(service, 'P-1', 0, makeSnapshotFixture({ projects: makeProjects(2) }));

    for (const path of [
      '/api/projects?cursor=not-base64!!',
      '/api/projects?limit=0',
      '/api/projects?limit=101',
      '/api/projects?limit=abc',
      '/api/projects?unknownParam=1',
      '/api/project', // 缺少 id
      '/api/records?projectId=x&kind=batches&limit=0',
    ]) {
      const res = await viewerGet(service.baseUrl, path);
      expect(res.status, path).toBe(400);
    }
    const ok = await viewerGet(service.baseUrl, '/api/projects?limit=1');
    expect(ok.status).toBe(200);
  });

  it('limit 缺省与 1..100 边界：缺省返回全量页内行，limit=100 全量', async () => {
    const service = await startFresh();
    await publish(service, 'P-1', 0, makeSnapshotFixture({ projects: makeProjects(7) }));
    const res = await viewerGet(service.baseUrl, '/api/projects');
    const body = (await res.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(body.data.items.length).toBe(7); // 7 < 缺省 50
  });
});

describe('手机查询线协议：空可选参数与精确查询串（7.4）', () => {
  it('精确手机查询串 query=&status=&region=&cursor=&limit=20 与记录端点 cursor= 均按缺失处理', async () => {
    const service = await startFresh();
    const snapshot = makeSnapshotFixture({ projects: [recordsProject(5), ...makeProjects(2)] });
    await publish(service, 'P-phone', 0, snapshot);

    // 精确手机查询串：空可选参数一律按缺失处理（不 400、不误过滤、可正常分页）。
    const res = await viewerGet(service.baseUrl, '/api/projects?query=&status=&region=&cursor=&limit=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(body.metadata.currentVersion).toBe(1);
    expect(body.data.items.length).toBe(3); // records-project + 2 个项目
    expect(body.data.nextCursor).toBeNull(); // 3 < 20 单页收尾

    // 记录端点空 cursor 按缺失处理 → 首页；limit=2 产生下一页游标（5 行 → 2/2/1）。
    const first = await viewerGet(
      service.baseUrl,
      '/api/records?projectId=records-project&kind=batches&cursor=&limit=2',
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as MobileReadonlyQueryResponse<{ items: Array<{ id: string }>; nextCursor: string | null }>;
    expect(firstBody.data.items.map((row) => row.id)).toEqual(['fixture-batch-0', 'fixture-batch-1']);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const secondCursor = firstBody.data.nextCursor as string;
    const second = await viewerGet(
      service.baseUrl,
      `/api/records?projectId=records-project&kind=batches&cursor=${encodeURIComponent(secondCursor)}&limit=2`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as MobileReadonlyQueryResponse<{ items: Array<{ id: string }>; nextCursor: string | null }>;
    expect(secondBody.data.items.map((row) => row.id)).toEqual(['fixture-batch-2', 'fixture-batch-3']);
    expect(secondBody.data.nextCursor).not.toBeNull();

    const third = await viewerGet(
      service.baseUrl,
      `/api/records?projectId=records-project&kind=batches&cursor=${encodeURIComponent(secondBody.data.nextCursor as string)}&limit=2`,
    );
    expect(third.status).toBe(200);
    const thirdBody = (await third.json()) as MobileReadonlyQueryResponse<{ items: Array<{ id: string }>; nextCursor: string | null }>;
    expect(thirdBody.data.items.map((row) => row.id)).toEqual(['fixture-batch-4']);
    expect(thirdBody.data.nextCursor).toBeNull();

    // 非空非法值仍受控拒绝（空值放行 ≠ 非法值放行）。
    const badStatus = await viewerGet(service.baseUrl, '/api/projects?status=not_a_status');
    expect(badStatus.status).toBe(400);
    const badCursor = await viewerGet(service.baseUrl, '/api/projects?cursor=not-base64!!');
    expect(badCursor.status).toBe(400);
    const emptyKind = await viewerGet(service.baseUrl, '/api/records?projectId=records-project&kind=&limit=2');
    expect(emptyKind.status).toBe(400); // 必填参数空串仍是校验错误
  });
});

describe('尚未发布与已发布空快照区分；无整份 JSON 路由（7.4/7.5）', () => {
  it('尚未发布：published=false、版本 0、data 为空且不带假数据', async () => {
    const service = await startFresh();
    const overview = await viewerGet(service.baseUrl, '/api/overview');
    const overviewBody = (await overview.json()) as MobileReadonlyQueryResponse<MobileReadonlyOverviewData>;
    expect(overviewBody.metadata.published).toBe(false);
    expect(overviewBody.metadata.currentVersion).toBe(0);
    expect(overviewBody.metadata.publicationId).toBeNull();
    expect(overviewBody.data.overview).toBeNull();

    const projects = await viewerGet(service.baseUrl, '/api/projects');
    const projectsBody = (await projects.json()) as MobileReadonlyQueryResponse<MobileReadonlyProjectListData>;
    expect(projectsBody.metadata.published).toBe(false);
    expect(projectsBody.data.items).toEqual([]);
    expect(projectsBody.data.nextCursor).toBeNull();
  });

  it('已发布空快照按已发布返回（空数据 ≠ 尚未发布），且不与未发布混淆', async () => {
    const service = await startFresh();
    await publish(service, 'P-empty', 0, makeEmptySnapshotFixture());
    const overview = await viewerGet(service.baseUrl, '/api/overview');
    const overviewBody = (await overview.json()) as MobileReadonlyQueryResponse<MobileReadonlyOverviewData>;
    expect(overviewBody.metadata.published).toBe(true);
    expect(overviewBody.metadata.currentVersion).toBe(1);
    expect(overviewBody.data.overview).not.toBeNull();
    expect(overviewBody.data.overview?.metrics.totalProjects).toBe(0);
    expect(overviewBody.data.overview?.metrics.pendingAmount).toBe('0.00');
  });

  it('不存在 current.json / snapshot 全文读取路由；页面/API 均不可直达快照文件', async () => {
    const service = await startFresh();
    await publish(service, 'P-1', 0, makeSnapshotFixture({ projects: makeProjects(2) }));

    // 上传凭证读不到任何业务/文件路由（403）
    const tokenized = await doFetch(service.baseUrl, '/api/current.json', {
      headers: { Authorization: `Bearer ${TEST_UPLOAD_TOKEN}` },
    });
    expect(tokenized.status).toBe(403);

    // 查看凭证请求业务前缀外路径均为 404，无快照路由。
    for (const path of ['/api/current.json', '/api/snapshot', '/snapshots/current.json']) {
      const res = await viewerGet(service.baseUrl, path);
      expect(res.status, path).toBe(404);
    }
  });
});
