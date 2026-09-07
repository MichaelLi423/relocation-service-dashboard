/**
 * ingest-associations.test.ts（tasks 3.2：projection-validator 切片）
 *
 * 只验证 projection-validator 与 parseManifestText：
 * - parseManifestText：strict-json 重复键/语法检测 → 闭集 manifest 解析；
 * - accept：完整 project {kind,row,detail} 或五个分区记录经 shared 严格解析器收束
 *   schema；同类型重复实体 ID、记录总数上限、row/detail counts/nonBlocking 冲突拒绝；
 * - finish：精确 manifest entityCounts、分区记录引用项目存在、instrument.batchId
 *   （非 null）与 damage.instrumentId 必须与自身同项目；引用允许前向，直到 finish
 *   才整体解析；
 * - 失败粘性：任一记录被拒绝后不再接受后续记录且 finish() 必失败；
 * - 全部错误为固定模板（不携带原始键/值/cause）。
 *
 * 全部使用 synthetic fixtures（syntheticConnectedProject/buildSyntheticSnapshot），
 * 不读取真实客户数据。边界声明：本切片不做 raw-byte checksum 证明（manifest.checksum
 * 与正文字节的交叉验证属后续 stream coordinator）。
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/core/errors';
import { sectionRowFromWorkbench } from '../../src/shared/remote-readonly/projection';
import { parseManifestText, ProjectionValidator, PROJECTION_ERROR_CODES } from '../../src/remote-readonly/ingest/projection-validator';
import {
  StrictJsonParseError,
  STRICT_JSON_ERROR_CODES,
} from '../../src/remote-readonly/ingest/strict-json';
import { syntheticConnectedProject, syntheticProjectRecord } from './fixtures/project-sources';
import { buildSyntheticSnapshot } from './fixtures/synthetic-snapshot';
import type { RemoteProjectionManifest } from '../../src/shared/remote-readonly/manifest';

/** JSON 对象（测试用宽松形状）。 */
type JsonObject = Record<string, any>;

function parseObject(line: string): JsonObject {
  return JSON.parse(line) as JsonObject;
}

/** 文本的 manifest JSON（校验不验证 checksum↔正文；字节证明属后续 coordinator）。 */
function manifestText(manifest: RemoteProjectionManifest): string {
  return JSON.stringify(manifest);
}

function parseManifestOf(manifest: RemoteProjectionManifest): RemoteProjectionManifest {
  return parseManifestText(manifestText(manifest));
}

/** 有效连接式 synthetic 快照：project 记录 + 全部分区行 + 对齐 manifest。 */
function connectedSnapshot(): { lines: string[]; manifest: RemoteProjectionManifest } {
  const connected = syntheticConnectedProject();
  const record = syntheticProjectRecord(connected);
  const sections = [
    ...connected.sections.batches.map((b) => sectionRowFromWorkbench(b)),
    ...connected.sections.instruments.map((i) => sectionRowFromWorkbench(i)),
    ...connected.sections.orders.map((o) => sectionRowFromWorkbench(o)),
    ...connected.sections.invoices.map((i) => sectionRowFromWorkbench(i)),
    ...connected.sections.damage.map((d) => sectionRowFromWorkbench(d)),
  ];
  const built = buildSyntheticSnapshot({ projects: [record], sections });
  return { lines: built.jsonl.split('\n').filter((l) => l.length > 0), manifest: built.manifest };
}

function lineKind(line: string): string {
  return parseObject(line).kind as string;
}

function rowId(line: string): string {
  return (parseObject(line).row as { id: string }).id;
}

function lineWithKind(lines: string[], kind: string): string {
  const found = lines.find((l) => lineKind(l) === kind);
  if (!found) throw new Error(`fixture 缺少 ${kind} 行`);
  return found;
}

/** 修改一行分区 JSONL 的 row（返回重新序列化的文本）。 */
function mutateRow(line: string, mutation: (row: JsonObject) => void): string {
  const obj = parseObject(line);
  mutation(obj.row as JsonObject);
  return JSON.stringify(obj);
}

/**
 * 同步修改 project 行的 row 与 detail 的 counts / nonBlocking
 * （两副本保持一致，绕开 row/detail 一致性检查；只用于本地构造 fixture）。
 */
function mutateProjectCounts(
  line: string,
  counts?: (counts: JsonObject) => void,
  nonBlocking?: (nonBlocking: JsonObject) => void,
): string {
  const obj = parseObject(line);
  if (counts) {
    counts(obj.row.counts as JsonObject);
    counts(obj.detail.counts as JsonObject);
  }
  if (nonBlocking) {
    nonBlocking(obj.row.nonBlocking as JsonObject);
    nonBlocking(obj.detail.nonBlocking as JsonObject);
  }
  return JSON.stringify(obj);
}

/** 把 project 行克隆为新的项目实体 id（row.id 与 detail.id 同步改，保持 detail.id===row.id）。 */
function projectLineAs(line: string, id: string): string {
  const obj = parseObject(line);
  obj.row.id = id;
  obj.detail.id = id;
  return JSON.stringify(obj);
}

function validatorOf(snap: { manifest: RemoteProjectionManifest }): ProjectionValidator {
  return new ProjectionValidator(parseManifestOf(snap.manifest));
}

/** 期望调用以固定错误（DomainError 或 strict-json 错误）拒绝并断言 code；message 不得含 markers。 */
function expectRejected(fn: () => unknown, code: string, markers: readonly string[] = []): void {
  let error: DomainError | StrictJsonParseError | undefined;
  try {
    fn();
  } catch (caught) {
    if (caught instanceof DomainError || caught instanceof StrictJsonParseError) {
      error = caught;
    } else {
      throw caught;
    }
  }
  if (!error) throw new Error(`期望拒绝 code=${code}，但没有抛出`);
  expect(error.code).toBe(code);
  for (const marker of markers) {
    expect(error.message).not.toContain(marker);
  }
}

/** 喂入全部行并收尾（不抛错即通过）。 */
function feedAll(validator: ProjectionValidator, lines: readonly string[]): void {
  for (const line of lines) validator.accept(line);
}

describe('parseManifestText：strict-json 重复键检测后闭集 manifest 解析', () => {
  it('有效 manifest 文本解析结果与直接对象解析一致', () => {
    const snap = connectedSnapshot();
    const parsed = parseManifestOf(snap.manifest);
    expect(parsed.entityCounts).toEqual(snap.manifest.entityCounts);
    expect(parsed.checksum).toEqual(snap.manifest.checksum);
    expect(parsed.businessRevision).toBe(snap.manifest.businessRevision);
  });

  it('manifest 内重复 JSON 键被 strict-json 拒绝且不回显键名', () => {
    const snap = connectedSnapshot();
    const text = manifestText(snap.manifest);
    // 在第一个 format 键前注入相同键 → 解析前重复键拒绝（不进闭集解析）。
    const dupText = text.replace('{"format":', '{"format":"remote-readonly-projection-manifest","format":');
    expectRejected(() => parseManifestText(dupText), STRICT_JSON_ERROR_CODES.DUPLICATE_KEY, ['format']);
  });

  it('闭集 manifest 拒绝未知键（canary）且 metadata-only', () => {
    const snap = connectedSnapshot();
    const obj = parseObject(manifestText(snap.manifest));
    obj.canarySecret = 'MANIFEST-CANARY-VALUE';
    expectRejected(() => parseManifestText(JSON.stringify(obj)), 'UNKNOWN_FIELD', [
      'canarySecret',
      'MANIFEST-CANARY-VALUE',
    ]);
  });
});

describe('ProjectionValidator：有效快照与前向引用', () => {
  it('有效快照全部接受，finish 通过（manifest counts / 引用一致）', () => {
    const snap = connectedSnapshot();
    const validator = validatorOf(snap);
    feedAll(validator, snap.lines);
    expect(() => validator.finish()).not.toThrow();
  });

  it('引用允许前向：行乱序（反向喂入）时 finish 仍通过', () => {
    const snap = connectedSnapshot();
    const reversed = [...snap.lines].reverse();
    const validator = validatorOf(snap);
    feedAll(validator, reversed);
    expect(() => validator.finish()).not.toThrow();
  });

  it('空快照（manifest 全 0、无任何记录）finish 通过', () => {
    const empty = buildSyntheticSnapshot();
    const validator = new ProjectionValidator(parseManifestOf(empty.manifest));
    expect(() => validator.finish()).not.toThrow();
  });
});

describe('ProjectionValidator：重复 ID / 结构拒绝', () => {
  it('同类型重复项目 ID 拒绝（含拒绝后不再记录成功）', () => {
    const snap = connectedSnapshot();
    const validator = validatorOf(snap);
    const projectLine = lineWithKind(snap.lines, 'project');
    validator.accept(projectLine);
    expectRejected(() => validator.accept(projectLine), PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID);
  });

  it('同类型重复分区 ID（instrument）拒绝', () => {
    const snap = connectedSnapshot();
    const validator = validatorOf(snap);
    const instrumentLine = snap.lines.find((l) => lineKind(l) === 'instruments');
    if (!instrumentLine) throw new Error('fixture 缺少 instruments 行');
    validator.accept(instrumentLine);
    expectRejected(() => validator.accept(instrumentLine), PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID);
  });

  it('不同 kind 允许共享同一 ID（batch 与 instrument 同名）且 finish 通过', () => {
    const snap = connectedSnapshot();
    // instrument2 行 id 改为 batch1 的 id（跨 kind 允许；各自 kind 内仍唯一）。
    const sharedId = 'syn-batch-conn-1';
    const instrument2 = snap.lines.find(
      (l) => lineKind(l) === 'instruments' && rowId(l) === 'syn-instrument-conn-2',
    );
    if (!instrument2) throw new Error('fixture 缺少 instrument2 行');
    const renamed = mutateRow(instrument2, (row) => {
      row.id = sharedId;
    });
    const lines = snap.lines.map((l) => (l === instrument2 ? renamed : l));
    const validator = validatorOf(snap);
    feedAll(validator, lines);
    expect(() => validator.finish()).not.toThrow();
  });

  it('缺少 detail 分组的 project 记录被拒绝（shared 解析器 REQUIRED_FIELD）', () => {
    const snap = connectedSnapshot();
    const projectLine = lineWithKind(snap.lines, 'project');
    const obj = parseObject(projectLine);
    delete obj.detail;
    const validator = validatorOf(snap);
    expectRejected(() => validator.accept(JSON.stringify(obj)), 'REQUIRED_FIELD');
  });

  it('记录行内重复 JSON 键在 strict-json 层拒绝且不回显', () => {
    const snap = connectedSnapshot();
    const batchLine = lineWithKind(snap.lines, 'batches');
    const rowText = JSON.stringify(parseObject(batchLine).row);
    const dupLine = `{"kind":"batches","kind":"batches","row":${rowText}}`;
    const validator = validatorOf(snap);
    expectRejected(() => validator.accept(dupLine), STRICT_JSON_ERROR_CODES.DUPLICATE_KEY, ['batches']);
  });

  it('row/detail 的 counts/nonBlocking 冲突拒绝（实际类型比较，不回显值）', () => {
    const snap = connectedSnapshot();
    const projectLine = lineWithKind(snap.lines, 'project');
    // row.counts.batches=2，把 detail.counts.batches 改为 42 → row/detail 冲突。
    const obj = parseObject(projectLine);
    obj.detail.counts.batches = 42;
    const line = JSON.stringify(obj);
    const validator = validatorOf(snap);
    expectRejected(() => validator.accept(line), PROJECTION_ERROR_CODES.ROW_DETAIL_COUNTS_MISMATCH, ['42']);
  });
});

describe('ProjectionValidator：未知字段与非法标量（metadata-only）', () => {
  it('分区行顶层未知键 canary → UNKNOWN_FIELD 且不回显', () => {
    const snap = connectedSnapshot();
    const orderLine = lineWithKind(snap.lines, 'orders');
    const obj = parseObject(orderLine);
    obj.canaryBillingSecret = 'TOP-CANARY-VALUE';
    const validator = validatorOf(snap);
    expectRejected(() => validator.accept(JSON.stringify(obj)), 'UNKNOWN_FIELD', [
      'canaryBillingSecret',
      'TOP-CANARY-VALUE',
    ]);
  });

  it('分区行 row 内未知键 canary → UNKNOWN_FIELD 且不回显', () => {
    const snap = connectedSnapshot();
    const batchLine = lineWithKind(snap.lines, 'batches');
    const injected = mutateRow(batchLine, (row) => {
      row.canaryTransportSecret = 'ROW-CANARY-VALUE';
    });
    const validator = validatorOf(snap);
    expectRejected(() => validator.accept(injected), 'UNKNOWN_FIELD', [
      'canaryTransportSecret',
      'ROW-CANARY-VALUE',
    ]);
  });

  it('需强制转换的金额/日期/布尔标量拒绝且错误不回显原文', () => {
    const snap = connectedSnapshot();
    const invoiceLine = lineWithKind(snap.lines, 'invoices');
    const batchLine = lineWithKind(snap.lines, 'batches');
    const instrumentLine = lineWithKind(snap.lines, 'instruments');
    // 金额必须精确两位小数字符串（不做 Number 强转/舍入）。
    const badMoney = mutateRow(invoiceLine, (row) => {
      row.amount = '1.005';
    });
    expectRejected(() => validatorOf(snap).accept(badMoney), 'INVALID_MONEY_FORMAT', ['1.005']);
    // 业务日期必须真实 yyyy-mm-dd。
    const badDate = mutateRow(batchLine, (row) => {
      row.startedAt = '2026-13-40';
    });
    expectRejected(() => validatorOf(snap).accept(badDate), 'INVALID_DATE', ['2026-13-40']);
    // 布尔不接受字符串强转。
    const badBool = mutateRow(instrumentLine, (row) => {
      row.ups = 'yes';
    });
    expectRejected(() => validatorOf(snap).accept(badBool), 'INVALID_BOOLEAN', ['yes']);
  });
});

describe('ProjectionValidator：孤儿 / 跨项目引用与计数（finish）', () => {
  it('分区记录引用不存在项目（invoice/batch orphan）→ ORPHAN_SECTION_PROJECT', () => {
    const snap = connectedSnapshot();
    const invoiceLine = lineWithKind(snap.lines, 'invoices');
    const orphanInvoice = mutateRow(invoiceLine, (row) => {
      row.projectId = 'ghost-project-1';
    });
    const batchLine = lineWithKind(snap.lines, 'batches');
    const orphanBatch = mutateRow(batchLine, (row) => {
      row.projectId = 'ghost-project-2';
    });
    const invoiceValidator = validatorOf(snap);
    feedAll(
      invoiceValidator,
      snap.lines.map((l) => (l === invoiceLine ? orphanInvoice : l)),
    );
    expectRejected(() => invoiceValidator.finish(), PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT);
    const batchValidator = validatorOf(snap);
    feedAll(
      batchValidator,
      snap.lines.map((l) => (l === batchLine ? orphanBatch : l)),
    );
    expectRejected(() => batchValidator.finish(), PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT);
  });

  it('instrument.batchId 引用不存在的批次 → INSTRUMENT_BATCH_NOT_FOUND', () => {
    const snap = connectedSnapshot();
    const instrument2 = snap.lines.find(
      (l) => lineKind(l) === 'instruments' && rowId(l) === 'syn-instrument-conn-2',
    );
    if (!instrument2) throw new Error('fixture 缺少 instrument2 行');
    const badRef = mutateRow(instrument2, (row) => {
      row.batchId = 'ghost-batch-9';
    });
    const validator = validatorOf(snap);
    feedAll(
      validator,
      snap.lines.map((l) => (l === instrument2 ? badRef : l)),
    );
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.INSTRUMENT_BATCH_NOT_FOUND);
  });

  it('instrument 与其 batch 属于不同项目 → INSTRUMENT_BATCH_PROJECT_MISMATCH', () => {
    const snap = connectedSnapshot();
    const secondProject = projectLineAs(lineWithKind(snap.lines, 'project'), 'syn-project-p2');
    const batch1 = snap.lines.find(
      (l) => lineKind(l) === 'batches' && rowId(l) === 'syn-batch-conn-1',
    );
    if (!batch1) throw new Error('fixture 缺少 batch1 行');
    const movedBatch = mutateRow(batch1, (row) => {
      row.projectId = 'syn-project-p2'; // batch 归属 p2，而 instrument1 仍属原项目
    });
    const manifest = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, projects: snap.manifest.entityCounts.projects + 1 },
    };
    const lines = [secondProject, ...snap.lines.map((l) => (l === batch1 ? movedBatch : l))];
    const validator = new ProjectionValidator(parseManifestOf(manifest));
    feedAll(validator, lines);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.INSTRUMENT_BATCH_PROJECT_MISMATCH);
  });

  it('damage.instrumentId 引用不存在的仪器 → DAMAGE_INSTRUMENT_NOT_FOUND', () => {
    const snap = connectedSnapshot();
    const damageLine = lineWithKind(snap.lines, 'damage_items');
    const badRef = mutateRow(damageLine, (row) => {
      row.instrumentId = 'ghost-instrument-7';
    });
    const validator = validatorOf(snap);
    feedAll(
      validator,
      snap.lines.map((l) => (l === damageLine ? badRef : l)),
    );
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.DAMAGE_INSTRUMENT_NOT_FOUND);
  });

  it('damage 与其 instrument 属于不同项目 → DAMAGE_INSTRUMENT_PROJECT_MISMATCH', () => {
    const snap = connectedSnapshot();
    const secondProject = projectLineAs(lineWithKind(snap.lines, 'project'), 'syn-project-p2');
    const damageLine = lineWithKind(snap.lines, 'damage_items');
    const movedDamage = mutateRow(damageLine, (row) => {
      row.projectId = 'syn-project-p2'; // damage 归 p2，而 instrument1 仍属原项目
    });
    const manifest = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, projects: snap.manifest.entityCounts.projects + 1 },
    };
    const lines = [secondProject, ...snap.lines.map((l) => (l === damageLine ? movedDamage : l))];
    const validator = new ProjectionValidator(parseManifestOf(manifest));
    feedAll(validator, lines);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.DAMAGE_INSTRUMENT_PROJECT_MISMATCH);
  });

  it('实际实体计数与 manifest.entityCounts 不符 → ENTITY_COUNT_MISMATCH', () => {
    const snap = connectedSnapshot();
    const wrongManifest = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, batches: snap.manifest.entityCounts.batches + 1 },
    };
    const validator = new ProjectionValidator(parseManifestOf(wrongManifest));
    feedAll(validator, snap.lines);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.ENTITY_COUNT_MISMATCH);
  });
});

describe('ProjectionValidator：失败粘性', () => {
  it('任一记录被拒绝后不再接受后续记录且 finish 必失败（不回退为成功）', () => {
    const snap = connectedSnapshot();
    const validator = validatorOf(snap);
    validator.accept(lineWithKind(snap.lines, 'project'));
    const invoiceLine = lineWithKind(snap.lines, 'invoices');
    const badMoney = mutateRow(invoiceLine, (row) => {
      row.amount = '9.999';
    });
    expectRejected(() => validator.accept(badMoney), 'INVALID_MONEY_FORMAT', ['9.999']);
    // 粘性：原本合法的记录与收尾都不再可能成功。
    expectRejected(() => validator.accept(lineWithKind(snap.lines, 'project')), PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED);
  });

  it('拒绝后再次喂入同一坏记录仍抛粘性错误（首个错误不覆盖）', () => {
    const snap = connectedSnapshot();
    const validator = validatorOf(snap);
    const instrumentLine = lineWithKind(snap.lines, 'instruments');
    const badBool = mutateRow(instrumentLine, (row) => {
      row.ups = 1;
    });
    expectRejected(() => validator.accept(badBool), 'INVALID_BOOLEAN');
    expectRejected(() => validator.accept(badBool), PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED);
  });
});

describe('ProjectionValidator：构造期 manifest 复制与 finish seal', () => {
  it('构造期严格解析：typed cast 的非法 manifest 直接拒绝', () => {
    expectRejected(
      () => new ProjectionValidator(null as unknown as RemoteProjectionManifest),
      'INVALID_RECORD',
    );
    expectRejected(
      () => new ProjectionValidator({ format: 'x' } as unknown as RemoteProjectionManifest),
      'INVALID_FORMAT',
    );
  });

  it('finish 校验失败即进入粘性：之后 accept/finish 均 STICKY_FAILED', () => {
    const snap = connectedSnapshot();
    const wrongManifest = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, projects: snap.manifest.entityCounts.projects + 1 },
    };
    const validator = new ProjectionValidator(wrongManifest);
    feedAll(validator, snap.lines);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.ENTITY_COUNT_MISMATCH);
    // finish 失败后不再接受记录、也不再收尾（原实现 finish 不置 failed 的回归）。
    expectRejected(
      () => validator.accept(lineWithKind(snap.lines, 'project')),
      PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED,
    );
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED);
  });

  it('构造复制 manifest：外部 entityCounts 变更无法让无效计数变有效', () => {
    const snap = connectedSnapshot();
    const manifestObj = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, projects: snap.manifest.entityCounts.projects + 1 },
    };
    const validator = new ProjectionValidator(manifestObj);
    feedAll(validator, snap.lines);
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.ENTITY_COUNT_MISMATCH);
    // 外部把 entityCounts “修正”为实际值：实例持构造期副本，仍无法通过。
    manifestObj.entityCounts.projects = snap.manifest.entityCounts.projects;
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED);
  });

  it('构造复制 manifest：外部 entityCounts 变更也无法让原本有效计数变无效', () => {
    const snap = connectedSnapshot();
    const manifestObj = { ...snap.manifest };
    const validator = new ProjectionValidator(manifestObj);
    // 构造后外部改坏 entityCounts；校验仍用构造期副本 → finish 通过。
    manifestObj.entityCounts.projects = 999;
    feedAll(validator, snap.lines);
    expect(() => validator.finish()).not.toThrow();
  });

  it('finish 成功后 seal：重复 finish 幂等成功，accept 拒绝 FINISHED 且不改动计数', () => {
    const snap = connectedSnapshot();
    const validator = new ProjectionValidator(snap.manifest);
    feedAll(validator, snap.lines);
    expect(() => validator.finish()).not.toThrow();
    expect(() => validator.finish()).not.toThrow();
    const before = validator.acceptedRecords;
    expectRejected(
      () => validator.accept(lineWithKind(snap.lines, 'project')),
      PROJECTION_ERROR_CODES.PROJECTION_FINISHED,
    );
    expect(validator.acceptedRecords).toBe(before);
  });
});

describe('ProjectionValidator：项目声明计数与实际子记录一致', () => {
  it('row 与 detail 声明同错误的 counts（manifest 全局计数正确）→ PROJECT_COUNTS_MISMATCH', () => {
    const snap = connectedSnapshot();
    const projectLine = lineWithKind(snap.lines, 'project');
    // row/detail 都声称 batches=3（实际子记录 2）：两副本一致绕开一致性检查，
    // manifest.entityCounts.batches 仍为 2（正确）→ 只有项目级计数不符。
    const inflated = mutateProjectCounts(projectLine, (counts) => {
      counts.batches = 3;
    });
    const validator = new ProjectionValidator(snap.manifest);
    feedAll(
      validator,
      snap.lines.map((l) => (l === projectLine ? inflated : l)),
    );
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.PROJECT_COUNTS_MISMATCH);
  });

  it('待修计数 nonBlocking.repairs 错误 → PROJECT_COUNTS_MISMATCH', () => {
    const snap = connectedSnapshot();
    const projectLine = lineWithKind(snap.lines, 'project');
    // 实际未关闭 damage=1（untreated）；row/detail 都声称 2 → 不符。
    const inflated = mutateProjectCounts(projectLine, undefined, (nonBlocking) => {
      nonBlocking.repairs = 2;
    });
    const validator = new ProjectionValidator(snap.manifest);
    feedAll(
      validator,
      snap.lines.map((l) => (l === projectLine ? inflated : l)),
    );
    expectRejected(() => validator.finish(), PROJECTION_ERROR_CODES.PROJECT_COUNTS_MISMATCH);
  });

  it('repaired/closed_unrepaired 不计入待修但仍计入 repairs 总数；撤销掉票计入 invoices → finish 通过', () => {
    const snap = connectedSnapshot();
    const projectLine = lineWithKind(snap.lines, 'project');
    const damageLine = lineWithKind(snap.lines, 'damage_items');
    // 项目声明：全部 damage=2、待修=0（repaired + closed_unrepaired 均关闭）；
    // row/detail 两副本同步改。
    const projectAdjusted = mutateProjectCounts(
      projectLine,
      (counts) => {
        counts.repairs = 2;
      },
      (nonBlocking) => {
        nonBlocking.repairs = 0;
      },
    );
    const repaired = mutateRow(damageLine, (row) => {
      row.issueStatus = 'repaired';
    });
    const closedUnrepaired = mutateRow(damageLine, (row) => {
      row.id = 'syn-damage-conn-2';
      row.issueStatus = 'closed_unrepaired';
    });
    const manifest = {
      ...snap.manifest,
      entityCounts: { ...snap.manifest.entityCounts, damageItems: snap.manifest.entityCounts.damageItems + 1 },
    };
    const lines: string[] = [];
    for (const l of snap.lines) {
      if (l === projectLine) lines.push(projectAdjusted);
      else if (l === damageLine) {
        lines.push(repaired, closedUnrepaired);
      } else {
        lines.push(l);
      }
    }
    const validator = new ProjectionValidator(manifest);
    feedAll(validator, lines);
    expect(() => validator.finish()).not.toThrow();
  });

  it('撤销掉票行仍计入 invoices 声明计数（含撤销历史，不按 active 过滤）', () => {
    const snap = connectedSnapshot();
    // connected fixture 中 invoice2 已是撤销行；再把 invoice1 也改为撤销 →
    // 两条掉票均 active=false，仍须全部计入声明 invoices=2。
    const invoice1 = snap.lines.find(
      (l) => lineKind(l) === 'invoices' && rowId(l) === 'syn-invoice-conn-1',
    );
    if (!invoice1) throw new Error('fixture 缺少 invoice1 行');
    const revoked = mutateRow(invoice1, (row) => {
      row.active = false;
      row.revokedAt = '2026-06-07';
    });
    const validator = new ProjectionValidator(snap.manifest);
    feedAll(
      validator,
      snap.lines.map((l) => (l === invoice1 ? revoked : l)),
    );
    expect(() => validator.finish()).not.toThrow();
  });

  it('前向引用/跨 kind 共享 ID 的有效 fixture 在本计数校验下仍通过', () => {
    const snap = connectedSnapshot();
    const sharedId = 'syn-batch-conn-1';
    const instrument2 = snap.lines.find(
      (l) => lineKind(l) === 'instruments' && rowId(l) === 'syn-instrument-conn-2',
    );
    if (!instrument2) throw new Error('fixture 缺少 instrument2 行');
    const renamed = mutateRow(instrument2, (row) => {
      row.id = sharedId;
    });
    // 反向喂入（引用前向），并让 instrument2 复用 batch 的 ID（跨 kind）。
    const reversed = [...snap.lines].reverse().map((l) => (l === instrument2 ? renamed : l));
    const validator = new ProjectionValidator(snap.manifest);
    feedAll(validator, reversed);
    expect(() => validator.finish()).not.toThrow();
  });
});
