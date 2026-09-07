/**
 * jsonl-output.test.ts — JSONL 序列化输出泄漏防护（focused slice）。
 *
 * 目标：JSONL 序列化器必须在 stringify 前经同一严格解析器校验整棵 approved 对象；
 * 任何顶层污染键（customerName/tagIds/groupedTags/reminderNote 等夹带业务值）或
 * 嵌套污染键（counts.activities、nonBlocking.pendingShipTo/qrUnmarked、分区行的
 * transportCompany/manufacturer/engineer/customerName/note/revokeReason/repairNote/
 * damageReason/createdAt、detail 的未批准分组/叶子如 plannedInstallDoneAt 旧别名、
 * 项目备注、联系人、地址、暂定仪器名称/型号等未批准字段）在产生任何输出字节前被拒绝。
 *
 * - 未知键错误为 metadata-only：错误 message/name/code/ref 只含受控上下文，
 *   不得携带被拒绝的 canary 键名或业务值。
 * - 合法（已投影）对象序列化后经 parseRemoteJsonlLine / parseRemoteProjectRecordJsonl
 *   完整 round-trip。
 *
 * 仅 synthetic 数据；不读取真实客户业务文件。
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  projectRecordToJsonl,
  projectRowToJsonl,
  sectionRowToJsonl,
  parseRemoteJsonlLine,
  parseRemoteProjectRecordJsonl,
} from '../../src/shared/remote-readonly/jsonl';
import {
  projectRowFromWorkbench,
  sectionRowFromWorkbench,
  type RemoteProjectRecord,
  type RemoteProjectRow,
  type RemoteSectionRow,
} from '../../src/shared/remote-readonly/projection';
import { InvalidValueRejection, UnknownFieldRejection } from '../../src/shared/remote-readonly/rejection';
import {
  parseRemoteProjectionManifest,
  sha256JsonlContent,
} from '../../src/shared/remote-readonly/manifest';
import {
  syntheticCompletedWithBalance,
  syntheticConnectedProject,
  syntheticProjectRecord,
  syntheticSections,
} from './fixtures/project-sources';
import { SYNTHETIC_DATABASE_INSTANCE_ID, buildSyntheticSnapshot } from './fixtures/synthetic-snapshot';

/** canary 业务值：若进入错误属性即证明泄漏。 */
const CANARY_CONTACT = '不该外发的联系人/Σ 秘密';
const CANARY_NOTE = '内部备注秘密值-9x';

/** 断言调用抛 UnknownFieldRejection，且全部可序列化属性不携带 canary 键/值。 */
function expectUnknownFieldRejected(fn: () => unknown, markers: readonly string[]): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof UnknownFieldRejection)) {
      throw new Error(`expected UnknownFieldRejection, got ${(error as Error)?.name ?? typeof error}`);
    }
    const props = [error.message, error.name, error.code];
    const asAny = error as unknown as Record<string, unknown>;
    if (typeof asAny['ref'] === 'object' && asAny['ref'] !== null) {
      props.push(JSON.stringify(asAny['ref']));
    }
    const all = props.join('|');
    expect(all).toMatch(/拒绝未知或未批准字段/);
    for (const marker of markers) {
      expect(all).not.toContain(marker);
    }
    return;
  }
  throw new Error('expected UnknownFieldRejection to be thrown');
}

describe('JSONL 输出泄漏防护：project 行序列化前严格校验', () => {
  const valid = projectRowFromWorkbench(syntheticCompletedWithBalance());

  it('合法已投影项目行序列化只含 kind/row，round-trip 解析一致', () => {
    const line = projectRowToJsonl(valid);
    const envelope = JSON.parse(line) as { kind: string; row: unknown };
    expect(Object.keys(envelope).sort()).toEqual(['kind', 'row']);
    expect(envelope.kind).toBe('project');
    // 输出不含被投影丢弃的字段名（含嵌套计数键）
    expect(line).not.toContain('reminderNote');
    expect(line).not.toContain('tagIds');
    expect(line).not.toContain('groupedTags');
    expect(line).not.toContain('activities');
    expect(line).not.toContain('pendingShipTo');
    expect(line).not.toContain('qrUnmarked');

    const parsed = parseRemoteJsonlLine(line);
    expect(parsed.kind).toBe('project');
    if (parsed.kind === 'project') {
      expect(parsed.row).toEqual(valid);
      expect(parsed.row.id).toBe(valid.id);
    }
  });

  it('顶层污染键（contactName 携带业务值）在 stringify 前拒绝，错误不泄漏值', () => {
    const contaminated = { ...valid, contactName: CANARY_CONTACT } as unknown as RemoteProjectRow;
    expectUnknownFieldRejected(() => projectRowToJsonl(contaminated), [CANARY_CONTACT, 'contactName']);
  });

  it('顶层污染键（tagIds/reminderNote 等被丢弃字段）在 stringify 前拒绝', () => {
    const withTags = {
      ...valid,
      tagIds: ['tag-secret-1'],
      groupedTags: [{ groupId: 'g1', groupName: '秘密组', tagIds: ['t1'], tagNames: ['秘密标签'] }],
      reminderNote: CANARY_NOTE,
    } as unknown as RemoteProjectRow;
    expectUnknownFieldRejected(() => projectRowToJsonl(withTags), [CANARY_NOTE, 'tagIds', 'reminderNote']);
  });

  it('嵌套污染 counts.activities 在 stringify 前拒绝', () => {
    const contaminated = JSON.parse(JSON.stringify(valid)) as {
      counts: Record<string, unknown>;
      nonBlocking: Record<string, unknown>;
    };
    contaminated.counts['activities'] = 99;
    expectUnknownFieldRejected(
      () => projectRowToJsonl(contaminated as unknown as RemoteProjectRow),
      ['activities'],
    );
  });

  it('嵌套污染 nonBlocking.pendingShipTo/qrUnmarked 在 stringify 前拒绝', () => {
    const contaminated = JSON.parse(JSON.stringify(valid)) as {
      counts: Record<string, unknown>;
      nonBlocking: Record<string, unknown>;
    };
    contaminated.nonBlocking['pendingShipTo'] = 7;
    contaminated.nonBlocking['qrUnmarked'] = 4;
    expectUnknownFieldRejected(
      () => projectRowToJsonl(contaminated as unknown as RemoteProjectRow),
      ['pendingShipTo', 'qrUnmarked'],
    );
  });
});

describe('JSONL 输出泄漏防护：五分区序列化前严格校验', () => {
  const sections = syntheticSections();
  const cases: Array<{ name: string; row: RemoteSectionRow; excludedKey: string; canary: string }> = [
    { name: 'batches', row: sectionRowFromWorkbench(sections.batches), excludedKey: 'transportCompany', canary: '秘密物流公司' },
    { name: 'instruments', row: sectionRowFromWorkbench(sections.instruments), excludedKey: 'manufacturer', canary: '秘密制造商' },
    { name: 'orders', row: sectionRowFromWorkbench(sections.orders), excludedKey: 'engineer', canary: '秘密工程师' },
    { name: 'invoices', row: sectionRowFromWorkbench(sections.invoices), excludedKey: 'revokeReason', canary: '秘密撤销原因' },
    { name: 'damage_items', row: sectionRowFromWorkbench(sections.damage), excludedKey: 'repairNote', canary: '秘密维修备注' },
  ];

  for (const c of cases) {
    it(`${c.name}：合法行 round-trip；污染键 ${c.excludedKey} 在 stringify 前拒绝`, () => {
      const line = sectionRowToJsonl(c.row);
      const envelope = JSON.parse(line) as { kind: string; row: unknown };
      expect(Object.keys(envelope).sort()).toEqual(['kind', 'row']);
      expect(envelope.kind).toBe(c.name);
      // 输出不含该分区被排除的字段名
      expect(line).not.toContain(c.excludedKey);

      const parsed = parseRemoteJsonlLine(line);
      expect(parsed.kind).toBe(c.name);
      if (parsed.kind === c.name) {
        expect(parsed.row).toEqual(c.row);
      }

      // 污染 → 拒绝且不泄漏 canary
      const contaminated = {
        ...(JSON.parse(line) as { row: Record<string, unknown> }).row,
        [c.excludedKey]: c.canary,
      } as unknown as RemoteSectionRow;
      expectUnknownFieldRejected(() => sectionRowToJsonl(contaminated), [c.canary, c.excludedKey]);
    });
  }

  it('orders 行夹带 customerName/note 业务值在 stringify 前拒绝', () => {
    const valid = sectionRowFromWorkbench(sections.orders);
    const contaminated = {
      ...valid,
      customerName: CANARY_CONTACT,
      note: CANARY_NOTE,
    } as unknown as RemoteSectionRow;
    expectUnknownFieldRejected(() => sectionRowToJsonl(contaminated), [CANARY_CONTACT, CANARY_NOTE, 'note']);
  });

  it('damage_items 行夹带 damageReason/instrumentName 之外备注在 stringify 前拒绝', () => {
    const valid = sectionRowFromWorkbench(sections.damage);
    const contaminated = {
      ...valid,
      damageReason: CANARY_NOTE,
      createdAt: '2026-06-05T00:00:00+08:00',
    } as unknown as RemoteSectionRow;
    expectUnknownFieldRejected(() => sectionRowToJsonl(contaminated), [CANARY_NOTE, 'damageReason', 'createdAt']);
  });
});

describe('JSONL 完整发布记录：{ kind:project, row, detail } 严格 round-trip（approved detail 分组）', () => {
  const connected = syntheticConnectedProject();
  const record = syntheticProjectRecord(connected);

  it('发布序列化只含 kind/row/detail；round-trip 解析一致（含各已批准详情分组）', () => {
    const line = projectRecordToJsonl(record);
    const envelope = JSON.parse(line) as { kind: string; row: unknown; detail: unknown };
    expect(Object.keys(envelope).sort()).toEqual(['detail', 'kind', 'row']);
    expect(envelope.kind).toBe('project');
    // detail 已批准分组键
    expect(Object.keys(envelope.detail as Record<string, unknown>).sort()).toEqual([
      'contract',
      'counts',
      'facts',
      'finance',
      'id',
      'nonBlocking',
      'reminder',
    ]);
    // 输出不含任何被丢弃的详情字段名（源 detail 携带：联系人/地址/备注/原因/暂定名称型号/旧别名）
    expect(line).not.toContain('projectNote');
    expect(line).not.toContain('oldSiteContact');
    expect(line).not.toContain('newSiteAddress');
    expect(line).not.toContain('cancelReason');
    expect(line).not.toContain('managerApprovalReason');
    expect(line).not.toContain('temporaryInstrumentName');
    expect(line).not.toContain('temporaryInstrumentModel');
    expect(line).not.toContain('plannedInstallDoneAt');

    const parsed = parseRemoteProjectRecordJsonl(line);
    expect(parsed).toEqual(record);
    // detail.id 与 row.id 同一实体
    expect(parsed.detail.id).toBe(parsed.row.id);
    expect(parsed.detail.counts).toEqual(parsed.row.counts);
    expect(parsed.detail.nonBlocking).toEqual(parsed.row.nonBlocking);
  });

  it('detail 每个已批准分组均 round-trip 保真（contract/facts/reminder/finance 标量）', () => {
    const line = projectRecordToJsonl(record);
    const parsed = parseRemoteProjectRecordJsonl(line);
    expect(parsed.detail.contract).toEqual({
      contractStartDate: '2026-05-01',
      contractEndDate: '2026-07-31',
      planVisitAt: '2026-06-01',
      planTransportAt: '2026-05-28',
      plannedInstallAt: '2026-06-10',
      actualInstallDoneAt: '2026-06-12',
    });
    expect(parsed.detail.facts).toEqual({
      managerApproved: true,
      siteConfirmed: true,
      isTemporaryStorage: null,
      acceptanceReport: true,
      acceptanceReportDate: '2026-06-15',
      temporaryInstrumentCount: 1,
      temporaryHasUps: true,
      cancelledAt: null,
    });
    expect(parsed.detail.reminder).toEqual({ reminderAt: null, hasReminder: false });
    expect(parsed.detail.finance).toEqual({
      contractAmount: '10000.00',
      entryAmountSnapshot: '10000.00',
      finalAmount: '8000.00',
      invoicedAmount: '3000.00',
      entryAt: '2026-05-01',
    });
    // reminder/finance/counts 与 row 投影语义一致（同一 source 行投影而来）
    expect(parsed.detail.finance.invoicedAmount).toBe(parsed.row.invoicedAmount);
  });

  it('contract/facts 组允许 null（详情未录入在 detail 分组内显式表示）', () => {
    // 详情未录入：contract/facts 分组为 null（已批准 wire 语义），但记录必含 detail。
    const row = record.row;
    const recordNullDetail: RemoteProjectRecord = {
      kind: 'project',
      row,
      detail: {
        id: row.id,
        contract: null,
        facts: null,
        reminder: { reminderAt: null, hasReminder: false },
        counts: row.counts,
        nonBlocking: row.nonBlocking,
        finance: {
          contractAmount: row.contractAmount,
          entryAmountSnapshot: row.entryAmountSnapshot,
          finalAmount: row.finalAmount,
          invoicedAmount: row.invoicedAmount,
          entryAt: row.entryAt,
        },
      },
    };
    const parsed = parseRemoteProjectRecordJsonl(projectRecordToJsonl(recordNullDetail));
    expect(parsed.detail.contract).toBeNull();
    expect(parsed.detail.facts).toBeNull();
    // 未录入 ≠ 丢失实体存在事实：reminder/counts/nonBlocking/finance 仍在组内
    expect(parsed.detail.counts).toEqual(row.counts);
    expect(parsed.detail.nonBlocking).toEqual(row.nonBlocking);
    expect(parsed.detail.finance.invoicedAmount).toBe(row.invoicedAmount);
  });

  it('detail.contract 内污染旧别名 plannedInstallDoneAt 在 stringify 前拒绝，不泄漏值', () => {
    const contaminated = JSON.parse(projectRecordToJsonl(record)) as {
      detail: Record<string, Record<string, unknown>>;
    };
    contaminated.detail['contract']['plannedInstallDoneAt'] = CANARY_NOTE;
    expectUnknownFieldRejected(
      () => projectRecordToJsonl(contaminated as never),
      [CANARY_NOTE, 'plannedInstallDoneAt'],
    );
  });

  it('detail.facts 内污染项目备注/联系人/原因在 stringify 前拒绝', () => {
    const contaminated = JSON.parse(projectRecordToJsonl(record)) as {
      detail: Record<string, Record<string, unknown>>;
    };
    contaminated.detail['facts']['projectNote'] = CANARY_NOTE;
    contaminated.detail['facts']['oldSiteContact'] = CANARY_CONTACT;
    expectUnknownFieldRejected(() => projectRecordToJsonl(contaminated as never), [CANARY_NOTE, CANARY_CONTACT]);
  });

  it('detail 顶层未知分组/未知键在 stringify 前拒绝', () => {
    const contaminated = JSON.parse(projectRecordToJsonl(record)) as {
      detail: Record<string, unknown>;
    };
    contaminated.detail['tags'] = { groupId: 'g1' };
    contaminated.detail['shipTo'] = { id: 's1' };
    expectUnknownFieldRejected(() => projectRecordToJsonl(contaminated as never), []);
  });

  it('unknown 值不能作为已批准字段值泄漏（enum/布尔/日期/金额 严格校验）', () => {
    const badStatus = JSON.parse(projectRecordToJsonl(record)) as {
      row: Record<string, unknown>;
      detail: Record<string, unknown>;
    };
    // status 非法枚举（值携带 canary）→ 拒绝且 message 不携带值
    badStatus.row['status'] = CANARY_NOTE;
    expectInvalidValueRejected(() => projectRecordToJsonl(badStatus as never), [CANARY_NOTE]);
    // detail.facts.managerApproved 非法类型（值 = canary 字符串）→ 拒绝且不泄漏
    const badManager = JSON.parse(projectRecordToJsonl(record)) as {
      detail: { facts: Record<string, unknown> };
    };
    badManager.detail.facts['managerApproved'] = CANARY_NOTE;
    expectInvalidValueRejected(() => projectRecordToJsonl(badManager as never), [CANARY_NOTE]);
  });

  it('detail 缺省/行-only 对象不能经发布序列化：拒绝缺 detail（不静默填默认空详情）', () => {
    // 行-only（旧诊断形状）不可作为权威发布记录
    const rowOnly = JSON.parse(projectRecordToJsonl(record)) as Record<string, unknown>;
    delete rowOnly['detail'];
    let thrown: unknown;
    try {
      projectRecordToJsonl(rowOnly as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidValueRejection);
    expect((thrown as Error).message).toMatch(/必须携带 detail/);
  });

  it('detail.id 与 row.id 不一致（跨实体拼接）被拒绝', () => {
    const contaminated = JSON.parse(projectRecordToJsonl(record)) as {
      detail: { id: string };
    };
    contaminated.detail.id = 'syn-project-OTHER';
    expect(() => projectRecordToJsonl(contaminated as never)).toThrow(/detail.id 与 row.id/);
  });

  it('parseRemoteProjectRecordJsonl 拒绝缺少 detail 的文本行', () => {
    const rowOnlyLine = projectRowToJsonl(record.row);
    expect(() => parseRemoteProjectRecordJsonl(rowOnlyLine)).toThrow(/必须携带 detail/);
  });

  it('detail.counts 不含 activities；污染 activities/pendingShipTo/qrUnmarked 拒绝', () => {
    const parsed = parseRemoteProjectRecordJsonl(projectRecordToJsonl(record));
    expect(parsed.detail.counts).toEqual(parsed.row.counts);
    expect(parsed.detail.counts).not.toHaveProperty('activities');
    const contaminated = JSON.parse(projectRecordToJsonl(record)) as {
      detail: { counts: Record<string, unknown>; nonBlocking: Record<string, unknown> };
    };
    contaminated.detail.counts['activities'] = 99;
    expectUnknownFieldRejected(() => projectRecordToJsonl(contaminated as never), ['activities']);
    contaminated.detail.counts['activities'] = 0;
    contaminated.detail.nonBlocking['qrUnmarked'] = 4;
    expectUnknownFieldRejected(() => projectRecordToJsonl(contaminated as never), ['qrUnmarked']);
  });
});

describe('synthetic 快照工厂：连接 ID/分区/计数/SHA256 严格', () => {
  it('连接式 fixture：分区行引用已存在 project/batch/instrument；计数与 manifest 一致', () => {
    const connected = syntheticConnectedProject();
    // 引用完整性：所有 section.projectId 指向 fixture 项目
    for (const section of [
      ...connected.sections.batches,
      ...connected.sections.instruments,
      ...connected.sections.orders,
      ...connected.sections.invoices,
      ...connected.sections.damage,
    ]) {
      expect(section.projectId).toBe(connected.project.id);
    }
    // 引用完整性：damage.instrumentId / instruments.batchId 指向已存在行
    const instrumentIds = new Set(connected.sections.instruments.map((i) => i.id));
    for (const damage of connected.sections.damage) {
      expect(instrumentIds.has(damage.instrumentId)).toBe(true);
    }
    const batchIds = new Set(connected.sections.batches.map((b) => b.id));
    for (const instrument of connected.sections.instruments) {
      if (instrument.batchId !== null) expect(batchIds.has(instrument.batchId)).toBe(true);
    }

    const record = syntheticProjectRecord(connected);
    const built = buildSyntheticSnapshot({
      projects: [record],
      sections: [
        ...connected.sections.batches.map((b) => sectionRowFromWorkbench(b)),
        ...connected.sections.instruments.map((i) => sectionRowFromWorkbench(i)),
        ...connected.sections.orders.map((o) => sectionRowFromWorkbench(o)),
        ...connected.sections.invoices.map((i) => sectionRowFromWorkbench(i)),
        ...connected.sections.damage.map((d) => sectionRowFromWorkbench(d)),
      ],
    });
    // counts 与源行/实际分区一致（repairs=1 对 1 条 damage；nonBlocking.repairs=1）
    expect(record.row.counts.batches).toBe(2);
    expect(record.row.counts.instruments).toBe(2);
    expect(record.row.counts.orders).toBe(1);
    expect(record.row.counts.repairs).toBe(1);
    expect(record.row.counts.invoices).toBe(2);
    expect(record.row.nonBlocking.repairs).toBe(1);
    expect(record.detail.counts).toEqual(record.row.counts);
    // manifest.entityCounts = 实际实体行数（projects 每条记录计 1）
    expect(built.manifest.entityCounts).toEqual({
      projects: 1,
      batches: 2,
      instruments: 2,
      orders: 1,
      invoices: 2,
      damageItems: 1,
    });
  });

  it('快照字节确定性 + sha256：相同输入同字节；manifest checksum 为 JSONL UTF-8 摘要', () => {
    const connected = syntheticConnectedProject();
    const record = syntheticProjectRecord(connected);
    const sectionRows: RemoteSectionRow[] = [
      ...connected.sections.batches.map((b) => sectionRowFromWorkbench(b)),
      ...connected.sections.instruments.map((i) => sectionRowFromWorkbench(i)),
      ...connected.sections.orders.map((o) => sectionRowFromWorkbench(o)),
      ...connected.sections.invoices.map((i) => sectionRowFromWorkbench(i)),
      ...connected.sections.damage.map((d) => sectionRowFromWorkbench(d)),
    ];
    // 顺序无关：乱序传入，输出字节一致（工厂按确定性 kind+id 排序）
    expect(sectionRows).toHaveLength(8);
    const shuffled = [sectionRows[6], sectionRows[0], sectionRows[2], sectionRows[1], sectionRows[3], sectionRows[5], sectionRows[4], sectionRows[7]];
    const a = buildSyntheticSnapshot({ projects: [record], sections: sectionRows });
    const b = buildSyntheticSnapshot({ projects: [record], sections: shuffled });
    expect(b.jsonl).toBe(a.jsonl);
    expect(b.contentSha256).toBe(a.contentSha256);
    // checksum === sha256(精确 UTF-8 JSONL 字节)（manifest 自身不参与）
    expect(a.contentSha256).toBe(sha256HexOfText(a.jsonl));
    expect(a.manifest.checksum.hex).toBe(a.contentSha256);
    expect(a.manifest.checksum.algorithm).toBe('sha256');
    // 每行一个 \n 结尾；非空首尾可解析
    const lines = a.jsonl.split('\n');
    expect(lines[lines.length - 1]).toBe('');
    const parsed = lines.filter((l) => l.length > 0).map((l) => JSON.parse(l) as { kind: string });
    expect(parsed[0].kind).toBe('project');
    // project 记录固定前置；分区固定顺序 batches→instruments→orders→invoices→damage_items
    const sectionKinds = parsed.slice(1).map((l) => l.kind);
    expect(sectionKinds).toEqual([
      'batches',
      'batches',
      'instruments',
      'instruments',
      'orders',
      'invoices',
      'invoices',
      'damage_items',
    ]);
  });

  it('工厂 manifest 可被严格解析器接受（UUID 谱系/digest/计数/checksum 一致）', () => {
    const built = buildSyntheticSnapshot({ projects: [syntheticProjectRecord(syntheticConnectedProject())] });
    const parsed = parseRemoteProjectionManifest(JSON.parse(JSON.stringify(built.manifest)));
    expect(parsed.checksum).toEqual({ algorithm: 'sha256', hex: built.contentSha256 });
    expect(parsed.entityCounts.projects).toBe(1);
    expect(parsed.approvedSettingsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.databaseInstanceId).toBe(SYNTHETIC_DATABASE_INSTANCE_ID);
  });

  it('空快照：JSONL 为 ""；sha256 为 sha256(空) 规范摘要；字节长度 0', () => {
    const empty = buildSyntheticSnapshot();
    expect(empty.jsonl).toBe('');
    expect(empty.byteLength).toBe(0);
    expect(empty.contentSha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(empty.manifest.entityCounts).toEqual({
      projects: 0,
      batches: 0,
      instruments: 0,
      orders: 0,
      invoices: 0,
      damageItems: 0,
    });
    expect(empty.manifest.checksum).toEqual({ algorithm: 'sha256', hex: empty.contentSha256 });
  });
});

describe('manifest 权威 checksum helper：sha256JsonlContent 原样哈希精确 JSONL 文本', () => {
  it('对同一文本输出等于独立 createHash 复算（非同一实现，防同源掩盖）', () => {
    const text = '{"kind":"project"}\n{"kind":"batches"}\n';
    expect(sha256JsonlContent(text)).toBe(sha256HexOfText(text));
  });

  it('保留结尾换行符：有无尾部 \n 是不同的内容/摘要（原样哈希不改写）', () => {
    const withNewline = '{"kind":"project","row":{"id":"a"}}\n';
    const withoutNewline = withNewline.slice(0, -1);
    expect(withNewline).not.toBe(withoutNewline);
    expect(sha256JsonlContent(withNewline)).not.toBe(sha256JsonlContent(withoutNewline));
    // 与独立复算一致
    expect(sha256JsonlContent(withNewline)).toBe(sha256HexOfText(withNewline));
    expect(sha256JsonlContent(withoutNewline)).toBe(sha256HexOfText(withoutNewline));
  });

  it('空字符串摘要 = sha256 空内容规范值（不因空输入产生别名/跳过）', () => {
    expect(sha256JsonlContent('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256JsonlContent('')).toBe(sha256HexOfText(''));
  });

  it('非 ASCII 内容按 UTF-8 字节编码哈希（CJK/emoji 与原样字节一致）', () => {
    const text = '{"customerName":"ACME 实验室😀"}\n';
    // 独立 oracle：Buffer.from(text,'utf8') 显式编码后逐字节哈希
    const oracle = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(sha256JsonlContent(text)).toBe(oracle);
    expect(sha256JsonlContent(text)).toBe(sha256HexOfText(text));
  });
});

function sha256HexOfText(text: string): string {
  // 独立复算（不同实现路径，防同源 helper 掩盖 bug）：直接对精确 JSONL 文本
  // 按 UTF-8 编码原样哈希——与 manifest.sha256JsonlContent 的实现互相独立。
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 断言抛 InvalidValueRejection，且错误属性不携带 canary 值。 */
function expectInvalidValueRejected(fn: () => unknown, markers: readonly string[]): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof InvalidValueRejection)) {
      throw new Error(`expected InvalidValueRejection, got ${(error as Error)?.name ?? typeof error}`);
    }
    const props = [error.message, error.name, error.code];
    const all = props.join('|');
    for (const marker of markers) {
      expect(all).not.toContain(marker);
    }
    return;
  }
  throw new Error('expected InvalidValueRejection to be thrown');
}
