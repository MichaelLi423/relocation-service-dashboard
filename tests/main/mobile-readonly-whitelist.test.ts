import { describe, expect, it } from 'vitest';
import {
  MOBILE_READONLY_PROJECT_STATUSES,
  MOBILE_READONLY_RECORD_KINDS,
  MOBILE_READONLY_SCHEMA_VERSION,
  validateMobileReadonlySnapshot,
} from '../../src/shared/mobile-readonly';
import {
  makeActivityRecordFixture,
  makeBatchRecordFixture,
  makeDamageItemRecordFixture,
  makeEmptySnapshotFixture,
  makeInstrumentRecordFixture,
  makeInvoiceRecordFixture,
  makeOrderRecordFixture,
  makeSnapshotFixture,
  mutateFirstProject,
  mutateFirstRowOfKind,
  replaceFirstRowOfKind,
} from '../helpers/mobile-readonly-fixtures';

/**
 * 封闭字段白名单契约（design.md「封闭字段白名单」表 + tasks 2.1-2.3）。
 * 全部使用脱敏合成数据，快照=业务白名单层。
 */

/** 顶层/各对象的封闭键集（design.md 表逐项列明；本测试把表固化到代码防实现漂移）。 */
const SNAPSHOT_TOP_KEYS = ['schemaVersion', 'contentGenerationId', 'businessRevision', 'dataAsOf', 'overview', 'projects'];
const OVERVIEW_KEYS = ['metrics', 'stages'];
const OVERVIEW_METRICS_KEYS = ['totalProjects', 'activeProjects', 'pendingAmount', 'pendingAcceptance', 'pendingInvoice'];
const STAGE_KEYS = ['status', 'count', 'averageDays'];
const PROJECT_ROW_KEYS = [
  'id',
  'tempNo',
  'ecc',
  'customerName',
  'status',
  'region',
  'regionNeedsAdjustment',
  'entryAt',
  'planVisitAt',
  'finalAmount',
  'invoicedAmount',
  'contractAmount',
  'formallyEntered',
  'preEntryExecution',
  'records',
];
const PROJECT_RECORDS_KEYS = [...MOBILE_READONLY_RECORD_KINDS];
const RECORD_ROW_KEYS: Record<string, readonly string[]> = {
  batches: ['id', 'planTransportDate', 'transportCompany', 'startedAt', 'appliedAt'],
  instruments: ['id', 'name', 'model', 'serialNo', 'ups'],
  activities: ['id', 'visitAt', 'engineers'],
  orders: ['id', 'orderType', 'serviceOrderNo', 'orderedAt', 'engineer'],
  invoices: ['id', 'amount', 'invoicedAt', 'active', 'revokedAt'],
  damage_items: ['id', 'instrumentName', 'serialNo', 'issueStatus', 'partNumber', 'partQuantity', 'partAmount', 'partCurrency', 'registeredAt'],
};

type Jsonish = Record<string, unknown>;

function asRecord(value: unknown): Jsonish {
  return value as Jsonish;
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function expectNotOk(value: unknown): void {
  const result = validateMobileReadonlySnapshot(value);
  if (result.ok) {
    throw new Error('快照意外通过校验，但测试期望其非法');
  }
}

function expectInvalidCodes(value: unknown, code: string): void {
  const result = validateMobileReadonlySnapshot(value);
  if (result.ok) {
    throw new Error('快照意外通过校验');
  }
  expect(result.issues.some((i) => i.code === code)).toBe(true);
}

function expectHasUnknownKeyIssue(value: unknown, pathFragment: string, key = 'leak'): void {
  const result = validateMobileReadonlySnapshot(value);
  if (result.ok) {
    throw new Error('快照意外通过校验（应命中未知 key 拒绝）');
  }
  const hit = result.issues.some(
    (i) => i.code === 'UNKNOWN_KEY' && i.path.includes(pathFragment) && i.message.includes(`「${key}」`),
  );
  expect(hit).toBe(true);
}

/** 复制快照并对首个项目调用 mutate（原始类型保持，便于项目定位）。 */

describe('移动只读快照 封闭白名单结构（tasks 2.1）', () => {
  it('schemaVersion 常量为 1，默认合成快照与空快照均通过校验', () => {
    expect(MOBILE_READONLY_SCHEMA_VERSION).toBe(1);
    expect(validateMobileReadonlySnapshot(makeSnapshotFixture()).ok).toBe(true);
    expect(validateMobileReadonlySnapshot(makeEmptySnapshotFixture()).ok).toBe(true);
  });

  it('快照对象键集与 design.md 白名单表逐项一致（顶层/概览/项目行/记录）', () => {
    const snapshot = makeSnapshotFixture();
    expect(sortedKeys(snapshot)).toEqual([...SNAPSHOT_TOP_KEYS].sort());
    expect(sortedKeys(snapshot.overview)).toEqual([...OVERVIEW_KEYS].sort());
    expect(sortedKeys(snapshot.overview.metrics)).toEqual([...OVERVIEW_METRICS_KEYS].sort());
    expect(snapshot.overview.stages.length).toBe(MOBILE_READONLY_PROJECT_STATUSES.length);
    for (const stage of snapshot.overview.stages) {
      expect(sortedKeys(stage)).toEqual([...STAGE_KEYS].sort());
    }

    const project = snapshot.projects[0];
    expect(sortedKeys(project)).toEqual([...PROJECT_ROW_KEYS].sort());
    expect(sortedKeys(project.records)).toEqual([...PROJECT_RECORDS_KEYS].sort());

    const recordRowLists: Array<{ key: string; rows: readonly object[] }> = [
      { key: 'batches', rows: project.records.batches },
      { key: 'instruments', rows: project.records.instruments },
      { key: 'activities', rows: project.records.activities },
      { key: 'orders', rows: project.records.orders },
      { key: 'invoices', rows: project.records.invoices },
      { key: 'damage_items', rows: project.records.damage_items },
    ];
    for (const list of recordRowLists) {
      expect(list.rows.length).toBeGreaterThan(0);
      for (const row of list.rows) {
        expect(sortedKeys(row)).toEqual([...(RECORD_ROW_KEYS[list.key] ?? [])].sort());
      }
    }
  });

  it('六个 kind 的 JSON 容器键与枚举常量一致（含 damage_items 下划线）', () => {
    expect(MOBILE_READONLY_RECORD_KINDS).toEqual(['batches', 'instruments', 'activities', 'orders', 'invoices', 'damage_items']);
  });

  it('未知 schemaVersion 一律拒绝', () => {
    for (const version of [0, 2, 99, '1', null]) {
      expectNotOk({ ...makeSnapshotFixture(), schemaVersion: version } as unknown);
    }
  });

  it('schemaVersion 为任意合法 JSON 值时不得抛异常（报错信息不强行字符串化不可信值）', () => {
    // JSON.parse 出的对象可能无 toString/无 valueOf；旧实现 String(obj.schemaVersion) 会抛 TypeError。
    const weirdObject = JSON.parse('{"toString":null}') as unknown;
    const withObject = { ...makeSnapshotFixture(), schemaVersion: weirdObject };
    expect(() => validateMobileReadonlySnapshot(withObject as unknown)).not.toThrow();
    const result = validateMobileReadonlySnapshot(withObject as unknown);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === 'INVALID_VALUE' && i.path === 'schemaVersion')).toBe(true);

    // 嵌套再深一层也不抛（对象内的非法 schemaVersion 与项目对象同层处理）。
    const weirdSnapshot = JSON.parse(
      JSON.stringify({ ...makeSnapshotFixture(), schemaVersion: { toString: null } }),
    ) as unknown;
    expect(() => validateMobileReadonlySnapshot(weirdSnapshot)).not.toThrow();
    expect(validateMobileReadonlySnapshot(weirdSnapshot).ok).toBe(false);
  });
});

describe('未知 key 拒绝（tasks 2.2：顶层与嵌套对象）', () => {
  it('顶层未知 key 被拒', () => {
    expectHasUnknownKeyIssue(asRecord({ ...makeSnapshotFixture(), leak: 1 }), '');
  });

  it('overview 对象与 metrics 内未知 key 被拒（含被排除的桌面概览字段）', () => {
    expectHasUnknownKeyIssue(
      { ...makeSnapshotFixture(), overview: { ...makeSnapshotFixture().overview, leak: 1 } },
      'overview',
    );
    for (const excluded of ['reminderCount', 'reminderOverdue', 'reminderToday', 'openRepairProjects', 'generatedAt', 'businessRevision']) {
      const snapshot = makeSnapshotFixture();
      expectHasUnknownKeyIssue(
        {
          ...snapshot,
          overview: { ...snapshot.overview, metrics: { ...asRecord(snapshot.overview.metrics), [excluded]: 0 } },
        },
        'overview.metrics',
        excluded,
      );
    }
  });

  it('overview.stages 条目内未知 key 被拒', () => {
    const snapshot = makeSnapshotFixture();
    const stages = snapshot.overview.stages.map((stage) => asRecord(stage));
    stages[0].leak = 1;
    expectHasUnknownKeyIssue({ ...snapshot, overview: { ...snapshot.overview, stages } }, 'overview.stages[0]');
  });

  it('项目行内未知 key 被拒（含被排除的桌面项目行字段）', () => {
    expectHasUnknownKeyIssue(
      mutateFirstProject(makeSnapshotFixture(), (project) => {
        project.leak = 1;
      }),
      'projects[0]',
    );

    for (const excluded of [
      'updatedAt',
      'reminderAt',
      'reminderNote',
      'reminderDueClass',
      'counts',
      'nonBlocking',
      'tagIds',
      'groupedTags',
      'entryAmountSnapshot',
      'projectNote',
      'oldSiteAddress',
      'oldSiteContact',
      'newSiteAddress',
      'newSiteContact',
    ]) {
      expectHasUnknownKeyIssue(
        mutateFirstProject(makeSnapshotFixture(), (project) => {
          project[excluded] = '敏感内容';
        }),
        'projects[0]',
        excluded,
      );
    }
  });

  it('records 容器内未知 key 被拒', () => {
    expectHasUnknownKeyIssue(
      mutateFirstProject(makeSnapshotFixture(), (project) => {
        asRecord(project.records).qr_requests = [];
      }),
      'projects[0].records',
      'qr_requests',
    );
  });

  it('六类关联记录行内嵌套未知 key 均被拒（design.md 注列明的排除字段）', () => {
    const cases: Array<{ kind: string; excluded: string[] }> = [
      { kind: 'batches', excluded: ['originalPrice', 'discountedPrice', 'projectId', 'createdAt'] },
      { kind: 'instruments', excluded: ['manufacturer', 'serviceLevel', 'qrRequested', 'destinationShipToId', 'batchId', 'projectId', 'createdAt'] },
      { kind: 'activities', excluded: ['projectId', 'createdAt'] },
      { kind: 'orders', excluded: ['note', 'customerName', 'projectId', 'createdAt'] },
      { kind: 'invoices', excluded: ['revokeReason', 'lastModifiedAt', 'projectId', 'createdAt'] },
      { kind: 'damage_items', excluded: ['damageReason', 'repairNote', 'partStatus', 'instrumentId', 'projectId', 'createdAt'] },
    ];
    for (const c of cases) {
      for (const excluded of c.excluded) {
        expectHasUnknownKeyIssue(
          mutateFirstRowOfKind(makeSnapshotFixture(), c.kind, (row) => {
            row[excluded] = 'x';
          }),
          `projects[0].records.${c.kind}`,
          excluded,
        );
      }
    }
  });

  it('六类记录行的「kind」技术字段不被快照携带', () => {
    for (const kind of MOBILE_READONLY_RECORD_KINDS) {
      expectHasUnknownKeyIssue(
        mutateFirstRowOfKind(makeSnapshotFixture(), kind, (row) => {
          row.kind = kind;
        }),
        `projects[0].records.${kind}`,
        'kind',
      );
    }
  });
});

describe('缺失必填 key 拒绝（tasks 2.2：嵌套每个对象）', () => {
  it('顶层缺任一 key → 拒绝', () => {
    for (const key of SNAPSHOT_TOP_KEYS) {
      const value = asRecord(makeSnapshotFixture());
      delete value[key];
      expectInvalidCodes(value, 'MISSING_KEY');
    }
  });

  it('overview/metrics/stages 条目缺任一 key → 拒绝', () => {
    for (const key of OVERVIEW_KEYS) {
      const value = asRecord(makeSnapshotFixture());
      delete asRecord(value.overview)[key];
      expectInvalidCodes(value, 'MISSING_KEY');
    }
    for (const key of OVERVIEW_METRICS_KEYS) {
      const value = asRecord(makeSnapshotFixture());
      delete asRecord(asRecord(value.overview).metrics)[key];
      expectInvalidCodes(value, 'MISSING_KEY');
    }
    const valueNoStages = asRecord(makeSnapshotFixture());
    delete asRecord(valueNoStages.overview).stages;
    expectInvalidCodes(valueNoStages, 'MISSING_KEY');
    for (const key of STAGE_KEYS) {
      const snapshot = makeSnapshotFixture();
      const stages = snapshot.overview.stages.map((s) => asRecord(s));
      delete stages[0][key];
      expectInvalidCodes({ ...snapshot, overview: { ...snapshot.overview, stages } }, 'MISSING_KEY');
    }
  });

  it('项目行缺任一 key（含 records）→ 拒绝', () => {
    for (const key of PROJECT_ROW_KEYS) {
      const value = asRecord(makeSnapshotFixture());
      const projects = value.projects as Jsonish[];
      delete projects[0][key];
      expectInvalidCodes(value, 'MISSING_KEY');
    }
  });

  it('records 容器缺任一 kind → 拒绝', () => {
    for (const key of PROJECT_RECORDS_KEYS) {
      const snapshot = makeSnapshotFixture();
      expectInvalidCodes(
        mutateFirstProject(snapshot, (project) => {
          delete asRecord(project.records)[key];
        }),
        'MISSING_KEY',
      );
    }
  });

  it('六类记录行缺任一白名单字段 → 拒绝', () => {
    const makeRowFor = (kind: string): Jsonish => {
      switch (kind) {
        case 'batches':
          return asRecord(makeBatchRecordFixture(0));
        case 'instruments':
          return asRecord(makeInstrumentRecordFixture(0));
        case 'activities':
          return asRecord(makeActivityRecordFixture(0));
        case 'orders':
          return asRecord(makeOrderRecordFixture(0));
        case 'invoices':
          return asRecord(makeInvoiceRecordFixture(0));
        case 'damage_items':
          return asRecord(makeDamageItemRecordFixture(0));
        default:
          throw new Error(`未知 kind: ${kind}`);
      }
    };
    for (const kind of MOBILE_READONLY_RECORD_KINDS) {
      for (const key of RECORD_ROW_KEYS[kind]) {
        const row = makeRowFor(kind);
        delete row[key];
        expectInvalidCodes(replaceFirstRowOfKind(makeSnapshotFixture(), kind, row), 'MISSING_KEY');
      }
    }
  });
});

describe('默认不导出字段的排除语义（tasks 2.3，合成对象层）', () => {
  it('默认不导出字段（联系人/地址/备注/审计时间/标签/来源）在项目行任一位置以 unknown key 拒绝', () => {
    const forbidden = [
      'oldSiteContact',
      'newSiteContact',
      'oldSiteAddress',
      'newSiteAddress',
      'projectNote',
      'temporaryStorageAddress',
      'cancelReason',
      'managerApprovalReason',
      'managerApproved',
      'createdAt',
      'updatedAt',
      'importSourceKey',
      'importSourceHash',
    ];
    for (const field of forbidden) {
      expectHasUnknownKeyIssue(
        mutateFirstProject(makeSnapshotFixture(), (project) => {
          project[field] = '敏感内容';
        }),
        'projects[0]',
        field,
      );
    }
  });

  it('合法的空集合快照通过，且缺 projects 键的空表达方式被拒绝', () => {
    const empty = makeEmptySnapshotFixture();
    expect(validateMobileReadonlySnapshot(empty).ok).toBe(true);
    expect(empty.projects).toEqual([]);
    const broken = asRecord(empty);
    delete broken.projects;
    expectInvalidCodes(broken, 'MISSING_KEY');
  });
});
