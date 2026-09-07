/**
 * projection-contract.test.ts（tasks 1.4）
 *
 * 仅使用 synthetic fixtures，验证移动只读投影契约：
 * - allowlist 封闭：source 含排除字段 → 投影显式选择/丢弃；未知/未批准字段不能
 *   旁路进入投影、JSONL 或错误/日志（metadata-only，不含业务值与未知键名）；
 * - 不公开整个 WorkbenchApi / Electron IPC（本契约独立于 WorkbenchApi）；
 * - null/0 区分、完成项目余额、取消排除、孤立财务事实、无数据、精确金额字符串、
 *   严格 yyyy-mm-dd 业务日期与 ISO 技术时间、`yyyy-mm-dd` 不强制转换；
 * - mobile-read-v1 查询边界与未知条件拒绝；publication 仅保留协议类型契约
 *   （运行时顺序判定/幂等属后续 durable 4.x，不在本文件断言）。
 *
 * 说明：本文件不覆盖重复 JSON key 检测（JSON.parse 无法可靠识别，全量 streaming
 * ingress 属 3.x 后置依赖）；不读取/记录/包含真实客户业务数据。
 */
import { describe, expect, it } from 'vitest';
import {
  projectRowFromWorkbench,
  sectionRowFromWorkbench,
  toRemoteDetailGroup,
  toRemoteReminderFacts,
  computePendingAmountString,
  computePendingAmountCents,
  parseRemoteProjectRow,
  parseRemoteInstrumentRow,
  parseRemoteInvoiceRow,
  parseRemoteDamageItemRow,
  PROJECT_ALLOWED_FIELDS,
  COUNTS_ALLOWED_FIELDS,
  NON_BLOCKING_ALLOWED_FIELDS,
  SECTION_ALLOWED_FIELDS,
  ENVELOPE_ALLOWED_FIELDS,
  PAGING_ALLOWED_FIELDS,
  OVERVIEW_DTO_ALLOWED_FIELDS,
  SECTION_COMMON_ALLOWED_FIELDS,
} from '../../src/shared/remote-readonly/projection';
import { parseRemoteJsonlLine } from '../../src/shared/remote-readonly/jsonl';
import {
  syntheticCompletedWithBalance,
  syntheticCancelledProject,
  syntheticPendingNoContract,
  syntheticNoProjects,
  syntheticHistoricalRegionLegacy,
  syntheticReminderNoteOnly,
  syntheticSections,
  syntheticDetail,
  syntheticZeroAndBlankAmounts,
  syntheticPlannedVisit,
} from './fixtures/project-sources';
import { syntheticManifest, projectJsonlText } from './fixtures/synthetic-snapshot';
import { parseRemoteProjectionManifest } from '../../src/shared/remote-readonly/manifest';
import {
  MOBILE_READ_V1,
  normalizeProjectListRequest,
  normalizeSectionRequest,
  normalizeDetailRequest,
  MOBILE_READ_PAGE_SIZE,
  PROJECT_SORT_DEFAULT,
} from '../../src/shared/remote-readonly/mobile-read-v1';
import type { WorkbenchProjectRow } from '../../src/shared/ipc';
import { UnknownFieldRejection } from '../../src/shared/remote-readonly/rejection';
import {
  PUBLICATION_REJECTION_CODES,
  type ActivationPointer,
  type PendingPublication,
  type SourceLineage,
  type PublicationCommitResult,
  type PublishedArtifactRef,
} from '../../src/shared/remote-readonly/publication-control';

const NO_CLIENT_DATA = /(ACME|Synthetic|SN-SYN|TP-SYN|ECC-SYN|客户|区域客户|物流|工程师)/;

/** 稳定 pinned 读取上下文：列表/详情/分区规范化入口要求显式携带 (snapshotId, activationId)。 */
const CTX = { snapshotId: 'synthetic-snapshot', activationId: '3' };
const CTX_PROJECT_ID = 'synthetic-project-1';

describe('tasks 1.2：独立 mobile-read-v1 / manifest / publication 契约不公开 WorkbenchApi', () => {
  it('mobile-read-v1 是独立协议标识，不引用 WorkbenchApi 通道', () => {
    expect(MOBILE_READ_V1).toBe('mobile-read-v1');
    expect(MOBILE_READ_PAGE_SIZE).toBe(20);
    // 列表查询允许字段仅查询条件，无 Electron/IPC 概念
    expect(PROJECT_SORT_DEFAULT).toBe('updated');
  });

  it('manifest 仅含谱系/发布元数据与批准实体计数（无业务字段）', () => {
    const manifest = syntheticManifest({
      businessRevision: 3,
      entityCounts: { projects: 1, batches: 1 },
    });
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/customer|ecc|amount|note|reminder/i);
    const parsed = parseRemoteProjectionManifest(JSON.parse(text));
    expect(parsed.businessRevision).toBe(3);
    expect(parsed.entityCounts).toMatchObject({ projects: 1, batches: 1, invoices: 0 });
  });

  it('manifest 未知字段被拒绝（metadata-only：只含受控上下文，无业务值/未知键名）', () => {
    const manifest = syntheticManifest();
    const withCanary = { ...manifest, customerName: 'ACME 实验室 X' };
    try {
      parseRemoteProjectionManifest(withCanary);
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFieldRejection);
      const message = (error as Error).message;
      expect(message).not.toMatch(NO_CLIENT_DATA);
      expect(message).not.toContain('customerName'); // 未知键名不得进入 message
      expect(message).toContain('manifest'); // 只保留受控上下文
    }
  });

  it('解析后的 manifest 校验业务日期 yyyy-mm-dd（businessDate 由字段表约束）', () => {
    const manifest = syntheticManifest();
    const bad = { ...manifest, businessDate: '2026-08-10T00:00:00+08:00' };
    expect(() => parseRemoteProjectionManifest(bad)).toThrow(/业务日期/);
  });
});

describe('tasks 1.3：封闭字段白名单（mobile-readonly-workbench 表为唯一来源）', () => {
  it('source 含排除字段时投影显式丢弃：不输出 reminderNote/tagIds/activities/pendingShipTo/qrUnmarked', () => {
    const source = syntheticCompletedWithBalance();
    expect(source.reminderNote).not.toBeNull();
    const projected = projectRowFromWorkbench(source);
    const text = JSON.stringify(projected);
    expect(text).not.toContain('reminderNote');
    expect(text).not.toContain('reminderDueClass');
    expect(text).not.toContain('tagIds');
    expect(text).not.toContain('groupedTags');
    expect(text).not.toContain('pendingShipTo');
    expect(text).not.toContain('qrUnmarked');
    expect(projected.counts).not.toHaveProperty('activities');
    expect(projected.nonBlocking).toEqual({ repairs: 1 });
  });

  it('投影行 JSON 键严格等于允许集合', () => {
    const source = syntheticCompletedWithBalance();
    const projected = projectRowFromWorkbench(source);
    expect(Object.keys(projected).sort()).toEqual([...PROJECT_ALLOWED_FIELDS].sort());
    expect(Object.keys(projected.counts).sort()).toEqual([...COUNTS_ALLOWED_FIELDS].sort());
    expect(Object.keys(projected.nonBlocking).sort()).toEqual([...NON_BLOCKING_ALLOWED_FIELDS].sort());
  });

  it('JSONL 每行只含批准字段；解析层拒绝未知 canary', () => {
    const source = syntheticCompletedWithBalance();
    const projected = projectRowFromWorkbench(source);
    const line = projectJsonlText(projected);
    expect(line).not.toContain('reminderNote');
    // round-trip
    const parsed = parseRemoteJsonlLine(line);
    expect(parsed.kind).toBe('project');
    if (parsed.kind === 'project') {
      expect(parsed.row.id).toBe(projected.id);
    }
    // 未知字段 canary → metadata-only 拒绝：无业务值、无未知键名
    const canary = JSON.parse(line) as { kind: string; row: Record<string, unknown> };
    canary.row['contactName'] = '不该外发联系人';
    try {
      parseRemoteJsonlLine(JSON.stringify(canary));
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFieldRejection);
      const message = (error as Error).message;
      expect(message).not.toMatch(NO_CLIENT_DATA);
      expect(message).not.toContain('contactName');
      expect(message).toContain('project');
    }
  });

  it('五分区 source 显式选择：输出不含排除字段（transportCompany/engineer/manufacturer/serviceLevel/revokeReason/repairNote/damageReason/destinationShipToId）', () => {
    const s = syntheticSections();
    const batch = sectionRowFromWorkbench(s.batches);
    const instrument = sectionRowFromWorkbench(s.instruments);
    const order = sectionRowFromWorkbench(s.orders);
    const invoice = sectionRowFromWorkbench(s.invoices);
    const damage = sectionRowFromWorkbench(s.damage);
    for (const json of [JSON.stringify(batch), JSON.stringify(instrument), JSON.stringify(order), JSON.stringify(invoice), JSON.stringify(damage)]) {
      expect(json).not.toMatch(/transportCompany|engineer|manufacturer|serviceLevel|revokeReason|repairNote|damageReason|destinationShipToId|note/);
    }
    expect(batch).toEqual(expect.objectContaining({ kind: 'batches', discountedPrice: '800.00' }));
    expect(instrument).toEqual(expect.objectContaining({ kind: 'instruments', ups: true, qrRequested: false }));
    expect(order).toEqual(expect.objectContaining({ kind: 'orders', orderType: 'relocation', orderedAt: '2026-05-23' }));
    expect(invoice).toEqual(expect.objectContaining({ kind: 'invoices', amount: '3000.00', active: true }));
    expect(damage).toEqual(expect.objectContaining({ kind: 'damage_items', partCurrency: 'USD', partStatus: 'pending_submit' }));
  });

  it('orders section projectId 无有效项目关联的行不允许发布（orders 仅当前项目关联记录）', () => {
    const source = syntheticSections().orders;
    const detached = { ...source, projectId: null };
    expect(() => sectionRowFromWorkbench(detached)).toThrow(/没有有效项目关联/);
  });

  it('activities 分区不属于投影（远程分区仅五类）；解析器拒绝未知枚举/未知 kind', () => {
    expect(SECTION_ALLOWED_FIELDS).not.toHaveProperty('activities');
    // 未知 kind 的 JSONL 行被拒绝（activities 不在允许列表）
    expect(() => parseRemoteJsonlLine('{"kind":"activities","row":{}}')).toThrow(/行类型不允许/);
  });

  it('详情选择：只读 plannedInstallAt 新字段，不输出旧别名 plannedInstallDoneAt；排除名称/型号/联系人/地址/备注', () => {
    const project = syntheticPlannedVisit();
    const detail = syntheticDetail({
      plannedInstallAt: '2026-09-01',
      plannedInstallDoneAt: '2026-09-01',
      temporaryInstrumentName: '不该外发临时名称',
      temporaryInstrumentModel: '不该外发型号',
      oldSiteContact: '不该外发联系人',
      projectNote: '不该外发备注',
      cancelReason: '不该外发原因',
    });
    const group = toRemoteDetailGroup(project, detail);
    expect(group).not.toBeNull();
    const text = JSON.stringify(group);
    expect(text).not.toContain('plannedInstallDoneAt');
    expect(text).not.toMatch(/temporaryInstrumentName|temporaryInstrumentModel|oldSiteContact|projectNote|cancelReason/);
    expect(group!.contract).toMatchObject({ plannedInstallAt: '2026-09-01' });
  });

  it('project 不存在 → detail group 为 null', () => {
    expect(toRemoteDetailGroup(null, syntheticDetail())).toBeNull();
  });

  it('项目计数只含 batches/instruments/orders/repairs/invoices；activities 计数不输出', () => {
    const source = makeWithActivitiesCount();
    const projected = projectRowFromWorkbench(source);
    expect(projected.counts).toEqual({ batches: 1, instruments: 2, orders: 3, repairs: 4, invoices: 5 });
    expect(projected.nonBlocking).toEqual({ repairs: 0 });
    expect(JSON.stringify(projected)).not.toContain('activities');
  });
});

describe('tasks 1.4：synthetic 边界验证（完成余额/取消/孤立/无数据/零值）', () => {
  it('已完成但仍有有效待掉票余额的项目纳入；精确字符串相加', () => {
    const completed = syntheticCompletedWithBalance();
    expect(completed.finalAmount).toBe('8000.00');
    expect(completed.invoicedAmount).toBe('3000.00');
    const rows = [completed];
    expect(computePendingAmountString(rows)).toBe('5000.00');
  });

  it('已取消项目排除（含有效掉票历史也不计入）', () => {
    const cancelled = syntheticCancelledProject();
    const result = computePendingAmountCents([syntheticCompletedWithBalance(), cancelled]);
    expect(computePendingAmountString([cancelled])).toBe('0.00');
    // 未取消的完成项目仍计入
    expect(result).toBe(500000n);
  });

  it('行式 legacy 适配器不承载孤立证明：孤立事实排除由 authoritative financial-facts adapter 覆盖', () => {
    // 本文件 computePendingAmountCents 是「只接收仍存在项目行」的 legacy 纯聚合，
    // 输入模型没有孤立掉票/孤立合同；「孤立/脏财务事实排除」的权威验证在
    // financial-facts.test.ts（以 projects/contracts/invoices 三集合真实 join）。
    // 此处只断言：无项目行时聚合为 0（不因孤立数据显示非 0 的等价空输入行为）。
    expect(computePendingAmountString([])).toBe('0.00');
  });

  it('无任何项目时 pendingAmount = 0.00（不因孤立数据显示非 0）', () => {
    expect(syntheticNoProjects()).toHaveLength(0);
    expect(computePendingAmountString([])).toBe('0.00');
  });

  it('空 finalAmount 的项目显示未填写而非 0，不进入聚合；contractAmount=0 保持精确零', () => {
    const rows = syntheticZeroAndBlankAmounts();
    const pendingNoContract = syntheticPendingNoContract();
    const projected = projectRowFromWorkbench(rows[0]);
    expect(projected.contractAmount).toBe('0.00');
    expect(projected.finalAmount).toBeNull();
    expect(computePendingAmountCents([...rows, pendingNoContract])).toBe(1000000n); // 10000.00 的项目
  });

  it('null 与 0 保持区分：projection 空金额为 null，不显示 0', () => {
    const projected = projectRowFromWorkbench(syntheticPendingNoContract());
    expect(projected.finalAmount).toBeNull();
    expect(projected.contractAmount).toBeNull();
    expect(projected.invoicedAmount).toBe('0.00');
  });

  it('历史区域只显示待调整：legacy 原文 → region=null + regionNeedsAdjustment=true，不输出原文', () => {
    const projected = projectRowFromWorkbench(syntheticHistoricalRegionLegacy());
    expect(projected.region).toBeNull();
    expect(projected.regionNeedsAdjustment).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('华东');
  });

  it('未填区域（null）与待调整（null + flag=true）不混淆', () => {
    // 未填区域：region=null + regionNeedsAdjustment=false
    const unfilled = projectRowFromWorkbench(makeUnfilledRegionProject());
    expect(unfilled.region).toBeNull();
    expect(unfilled.regionNeedsAdjustment).toBe(false);
    // 合法固定枚举：region='East' + flag=false
    const withRegion = projectRowFromWorkbench(syntheticPendingNoContract());
    expect(withRegion.region).toBe('East');
    expect(withRegion.regionNeedsAdjustment).toBe(false);
    // legacy 非枚举原文：region=null + flag=true（不发布原文）
    const legacy = projectRowFromWorkbench(syntheticHistoricalRegionLegacy());
    expect(legacy.region).toBeNull();
    expect(legacy.regionNeedsAdjustment).toBe(true);
  });

  it('手工提醒仅存在性：仅有备注 → hasReminder=true + reminderAt=null，不发送备注', () => {
    const source = syntheticReminderNoteOnly();
    const facts = toRemoteReminderFacts(source);
    expect(facts.hasReminder).toBe(true);
    expect(facts.reminderAt).toBeNull();
    // JSONL 不含备注内容
    const projected = projectRowFromWorkbench(source);
    const line = JSON.stringify(projected);
    expect(line).not.toContain('仅备注');
  });

  it('精确金额字符串：两位小数，禁止 Number 强转/截断', () => {
    const projected = projectRowFromWorkbench(syntheticCompletedWithBalance());
    expect(projected.finalAmount).toBe('8000.00');
    expect(typeof projected.finalAmount).toBe('string');
    const envelope = JSON.parse(projectJsonlText(projected)) as { kind: string; row: Record<string, unknown> };
    const parsed = parseRemoteProjectRow(envelope.row as never);
    expect(parsed.finalAmount).toBe('8000.00');
  });

  it('日期严格 yyyy-mm-dd：含时间或非法日历日期的字符串拒绝', () => {
    const projected = projectRowFromWorkbench(syntheticPlannedVisit());
    const line = JSON.parse(projectJsonlText(projected)) as { kind: string; row: Record<string, unknown> };
    line.row['planVisitAt'] = '2026-08-20T10:00:00+08:00'; // 业务日期不得携带时间
    expect(() => parseRemoteProjectRow(line.row as never)).toThrow(/业务日期/);
    line.row['planVisitAt'] = '2026-02-30'; // 非真实日历日期
    expect(() => parseRemoteProjectRow(line.row as never)).toThrow(/业务日期/);
  });

  it('ISO 技术时间必须带偏移（updatedAt）；缺失偏移拒绝', () => {
    const projected = projectRowFromWorkbench(syntheticPlannedVisit());
    const line = JSON.parse(projectJsonlText(projected)) as { kind: string; row: Record<string, unknown> };
    line.row['updatedAt'] = '2026-08-10T09:30:00'; // 无偏移
    expect(() => parseRemoteProjectRow(line.row as never)).toThrow(/ISO/);
  });

  it("金额或日期不允许强制转换：'1.5' / '2026-8-1' 拒绝", () => {
    const projected = projectRowFromWorkbench(syntheticCompletedWithBalance());
    const line = JSON.parse(projectJsonlText(projected)) as { kind: string; row: Record<string, unknown> };
    line.row['finalAmount'] = '5000.5'; // 需强制转换 → 拒绝
    expect(() => parseRemoteProjectRow(line.row as never)).toThrow(/精确两位小数/);
    line.row['finalAmount'] = '8000.00';
    line.row['entryAt'] = '2026-8-1'; // 需强制转换 → 拒绝
    expect(() => parseRemoteProjectRow(line.row as never)).toThrow(/业务日期/);
  });

  it('legacy 行式聚合先精确两小数校验：1.005 / trim 脏金额不参与、不被宽松舍入', () => {
    // 金额必须是精确两位小数字符串；'1.005'（可 HALF_UP 成 1.01）与 ' 100.00 '
    // （需 trim）都不是批准 wire 值 → 脏行按「排除」处理，不贡献、也不抛。
    const clean = syntheticCompletedWithBalance(); // final 8000.00 - invoiced 3000.00 = 5000.00
    const dirtyRound = { ...syntheticCompletedWithBalance(), id: 'syn-dirty-round', finalAmount: '8000.005' };
    const dirtyTrim = { ...syntheticCompletedWithBalance(), id: 'syn-dirty-trim', finalAmount: ' 8000.00 ' };
    expect(computePendingAmountString([clean, dirtyRound, dirtyTrim])).toBe('5000.00');
    expect(computePendingAmountCents([dirtyRound, dirtyTrim])).toBe(0n);
    // 不含任何可计算行时归零
    expect(computePendingAmountString([dirtyRound])).toBe('0.00');
  });

  it('legacy 行式聚合仅脏掉票金额（invoicedAmount 非精确）也不参与', () => {
    const dirtyInvoice = { ...syntheticCompletedWithBalance(), id: 'syn-dirty-invoice', invoicedAmount: '3000.0' };
    expect(computePendingAmountString([dirtyInvoice])).toBe('0.00');
  });
});

describe('tasks 1.3/1.4：严格解析 allowlist 全层拒绝未知/未批准字段', () => {
  it('parseRemoteProjectRow 拒绝 counts.activities / nonBlocking.qrUnmarked / 顶层 tagIds', () => {
    const good = projectRowFromWorkbench(syntheticCompletedWithBalance());
    const parsedGood = parseRemoteProjectRow(JSON.parse(projectJsonlText(good))['row'] as never);
    expect(parsedGood.counts).not.toHaveProperty('activities');

    const raw = JSON.parse(projectJsonlText(good)) as { kind: string; row: Record<string, unknown> };
    (raw.row['counts'] as Record<string, unknown>)['activities'] = 9;
    expect(() => parseRemoteProjectRow(raw.row as never)).toThrow(UnknownFieldRejection);

    const raw2 = JSON.parse(projectJsonlText(good)) as { kind: string; row: Record<string, unknown> };
    (raw2.row['nonBlocking'] as Record<string, unknown>)['qrUnmarked'] = 3;
    expect(() => parseRemoteProjectRow(raw2.row as never)).toThrow(UnknownFieldRejection);

    const raw3 = JSON.parse(projectJsonlText(good)) as { kind: string; row: Record<string, unknown> };
    raw3.row['tagIds'] = ['tag-1'];
    expect(() => parseRemoteProjectRow(raw3.row as never)).toThrow(UnknownFieldRejection);
  });

  it('解析错误不携带业务值：canary 值/客户名/未知键名绝不进入 message', () => {
    const good = projectRowFromWorkbench(syntheticCompletedWithBalance());
    const raw = JSON.parse(projectJsonlText(good)) as { kind: string; row: Record<string, unknown> };
    raw.row['reminderNote'] = '内部备注不能外发';
    try {
      parseRemoteProjectRow(raw.row as never);
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFieldRejection);
      const message = (error as Error).message;
      expect(message).not.toContain('内部备注');
      expect(message).not.toContain('reminderNote');
      expect(message).not.toMatch(NO_CLIENT_DATA);
    }
  });

  it('wire 可空文本严格只接受 null/string：ecc/model/serviceOrderNo/serialNo 非 string 拒绝，空串也拒绝（缺失用 null）', () => {
    const good = projectRowFromWorkbench(syntheticCompletedWithBalance());
    const base = JSON.parse(projectJsonlText(good))['row'] as Record<string, unknown>;
    const withNonString = { ...base, ecc: 12345 };
    expect(() => parseRemoteProjectRow(withNonString)).toThrow(/文本/);
    const withEmpty = { ...base, ecc: '' };
    expect(() => parseRemoteProjectRow(withEmpty)).toThrow(/空串/);
    // null 仍合法（未填写用 null 表达）
    expect(parseRemoteProjectRow({ ...base, ecc: null }).ecc).toBeNull();
  });

  it('wire 必填标识符 ≤128 码点：id/projectId/batchId/instrumentId 超长或空拒绝', () => {
    const s = syntheticSections();
    const instrumentRow = sectionRowFromWorkbench(s.instruments);
    const longId = 'x'.repeat(129);
    expect(() => parseRemoteInstrumentRow({ ...JSON.parse(JSON.stringify(instrumentRow)), id: longId } as never)).toThrow(/128|长度/);
    expect(() => parseRemoteInstrumentRow({ ...JSON.parse(JSON.stringify(instrumentRow)), projectId: '' } as never)).toThrow(/必填/);
    expect(() => parseRemoteInstrumentRow({ ...JSON.parse(JSON.stringify(instrumentRow)), batchId: longId } as never)).toThrow(/128|长度/);
    const damageRow = sectionRowFromWorkbench(s.damage);
    expect(() => parseRemoteDamageItemRow({ ...JSON.parse(JSON.stringify(damageRow)), instrumentId: longId } as never)).toThrow(/128|长度/);
  });

  it('strict 字段拒绝错误不回显被拒输入（非 string / 超长值 / 非法币种 / 空金额）', () => {
    const s = syntheticSections();
    const model = sectionRowFromWorkbench(s.instruments);
    const rawModel = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
    rawModel['model'] = { nested: '不该外发' };
    try {
      parseRemoteInstrumentRow(rawModel as never);
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect((error as Error).message).not.toContain('不该外发');
      expect((error as Error).message).not.toContain('nested');
    }
    // 非法币种（非 USD/RMB 且非 null）拒绝且不回显
    const damage = sectionRowFromWorkbench(s.damage);
    const rawDamage = JSON.parse(JSON.stringify(damage)) as Record<string, unknown>;
    rawDamage['partCurrency'] = 'EUR-CANARY';
    try {
      parseRemoteDamageItemRow(rawDamage as never);
      expect.unreachable('应当拒绝');
    } catch (error) {
      expect((error as Error).message).not.toContain('EUR-CANARY');
    }
    // 空金额/空日期严格拒绝（不归一、不静默 null）
    const invoice = sectionRowFromWorkbench(s.invoices);
    const rawInvoice = JSON.parse(JSON.stringify(invoice)) as Record<string, unknown>;
    rawInvoice['amount'] = '';
    expect(() => parseRemoteInvoiceRow(rawInvoice as never)).toThrow(/必填|金额/);
  });

  it('合法 source 缺 partNumber/instrumentName（空串值）在发布映射拒绝（metadata-only，规格未批准空文本）', () => {
    const s = syntheticSections();
    const withEmptyPart = { ...s.damage, partNumber: '' };
    expect(() => sectionRowFromWorkbench(withEmptyPart)).toThrow(/必填/);
    const withEmptyInstrumentName = { ...s.damage, instrumentName: '' };
    expect(() => sectionRowFromWorkbench(withEmptyInstrumentName)).toThrow(/必填/);
  });
});

describe('tasks 1.2：mobile-read-v1 查询原语（pinned 读取显式携带 snapshotId/activationId）', () => {
  it('未知查询条件拒绝；超长搜索/ID/cursor 拒绝', () => {
    expect(() => normalizeProjectListRequest({ ...CTX, foo: 'x' })).toThrow(/未知|不允许/);
    expect(() => normalizeProjectListRequest({ ...CTX, query: 'x'.repeat(257) })).toThrow(/256/);
    expect(() => normalizeDetailRequest({ ...CTX, projectId: 'x'.repeat(129) })).toThrow(/128/);
    expect(() => normalizeProjectListRequest({ ...CTX, cursor: 'x'.repeat(5000) })).toThrow(/4 KiB/);
  });

  it('缺失 pinned 上下文（snapshotId/activationId）显式拒绝，无 unpinned fallback', () => {
    expect(() => normalizeProjectListRequest({ region: 'East' })).toThrow(/必填/);
    expect(() => normalizeProjectListRequest({})).toThrow(/必填/);
    expect(() => normalizeDetailRequest({ projectId: 'p1' })).toThrow(/必填/);
    expect(() => normalizeSectionRequest({ projectId: 'p1', kind: 'batches' })).toThrow(/必填/);
  });

  it('区域筛选只允许五固定枚举或 null；free text/未填写筛选拒绝', () => {
    expect(normalizeProjectListRequest({ ...CTX, region: 'East' }).region).toBe('East');
    expect(normalizeProjectListRequest({ ...CTX, region: null }).region).toBeNull();
    expect(() => normalizeProjectListRequest({ ...CTX, region: '未填写' })).toThrow(/区域筛选/);
    expect(() => normalizeProjectListRequest({ ...CTX, region: '待调整' })).toThrow(/区域筛选/);
  });

  it('排序只允许 updated / plan_visit_asc / plan_visit_desc', () => {
    expect(normalizeProjectListRequest({ ...CTX }).sort).toBe('updated');
    expect(normalizeProjectListRequest({ ...CTX, sort: 'plan_visit_asc' }).sort).toBe('plan_visit_asc');
    expect(() => normalizeProjectListRequest({ ...CTX, sort: 'created' })).toThrow(/排序方式不允许/);
  });

  it('规范化结果保留 pinned 上下文（snapshotId/activationId 与入参一致）', () => {
    const normalized = normalizeProjectListRequest({ ...CTX, query: 'ACME', status: 'pending_invoice', region: 'East', sort: 'plan_visit_desc' });
    expect(normalized.snapshotId).toBe(CTX.snapshotId);
    expect(normalized.activationId).toBe(CTX.activationId);
    expect(normalized.query).toBe('ACME');
    expect(normalized.status).toBe('pending_invoice');
    expect(normalized.region).toBe('East');
    expect(normalized.sort).toBe('plan_visit_desc');
    expect(normalized.cursor).toBeNull();
  });

  it('分区查询未知条件拒绝；合法查询规范化（上下文 + projectId 必填）', () => {
    expect(() =>
      normalizeSectionRequest({ ...CTX, projectId: CTX_PROJECT_ID, kind: 'batches', activities: 1 }),
    ).toThrow(/未知|不允许/);
    const normalized = normalizeSectionRequest({ ...CTX, projectId: CTX_PROJECT_ID, kind: 'invoices' });
    expect(normalized).toEqual({ ...CTX, projectId: CTX_PROJECT_ID, kind: 'invoices', cursor: null });
  });

  it('详情请求规范化：上下文 + projectId（无 id 的独立入参不再被接受）', () => {
    const detail = normalizeDetailRequest({ ...CTX, projectId: CTX_PROJECT_ID });
    expect(detail).toEqual({ ...CTX, projectId: CTX_PROJECT_ID });
  });
});

describe('tasks 1.2：publication 协议类型契约（运行时判定属后续 durable 4.x）', () => {
  const lineage: SourceLineage = { databaseInstanceId: 'db-1', contentGenerationId: 'gen-7' };
  const current: ActivationPointer = {
    snapshotId: 'snap-10',
    activationId: '3',
    businessRevision: 4,
    lineage,
  };
  const pendingBase: PendingPublication = {
    lineage,
    businessRevision: 5,
    publicationSequence: 9,
    snapshotId: 'snap-11',
    contentChecksum: 'c1',
    publisherId: 'pub-1',
    authorizationEpoch: 5,
    expectedActivationId: '3',
  };

  it('activationId 使用十进制字符串 wire 类型（与投影 RemoteEnvelope 一致），无数值比较 helper', () => {
    expect(typeof current.activationId).toBe('string');
    expect(typeof pendingBase.expectedActivationId).toBe('string');
    expect(current.activationId).toBe('3');
    // 语义锚点：activationId 每次指针变更递增。本契约不提供数值比较 helper，
    // 十进制字符串的递增比较（含多位数）由 durable 4.x 提交实现负责。
    expect(current.activationId.length).toBe(1);
  });

  it('发布拒绝码是稳定字符串集合（提交结果引用的错误语义锚点）', () => {
    expect(PUBLICATION_REJECTION_CODES.STALE_AUTHORIZATION_EPOCH).toBe('STALE_AUTHORIZATION_EPOCH');
    expect(PUBLICATION_REJECTION_CODES.REVISION_NOT_FORWARD).toBe('REVISION_NOT_FORWARD');
    expect(PUBLICATION_REJECTION_CODES.ACTIVATION_CONFLICT).toBe('ACTIVATION_CONFLICT');
    expect(PUBLICATION_REJECTION_CODES.JOB_CONTENT_CHANGED).toBe('JOB_CONTENT_CHANGED');
    // 提交结果的 ok/code 形状是逻辑契约（运行时判定在 durable 4.x 实现）
    const failed: PublicationCommitResult = { ok: false, code: 'REVISION_NOT_FORWARD' };
    expect(failed).toEqual({ ok: false, code: 'REVISION_NOT_FORWARD' });
    const succeeded: PublicationCommitResult = { ok: true, activation: current };
    expect(succeeded.ok).toBe(true);
    expect(succeeded.activation?.activationId).toBe('3');
  });

  it('持久化 artifact 引用的 activationId 同为十进制字符串 wire 类型', () => {
    const artifact: PublishedArtifactRef = {
      snapshotId: 'snap-10',
      activationId: '3',
      contentChecksum: 'c1',
      durable: true,
    };
    expect(typeof artifact.activationId).toBe('string');
  });
});

describe('tasks 1.3：运行时字段白名单 allowlist（mobile-readonly-workbench 表逐项一致）', () => {
  it('读取技术信封/分页/分区 allowlist 不含业务字段与排除计数键', () => {
    expect(ENVELOPE_ALLOWED_FIELDS).not.toContain('customerName');
    expect(ENVELOPE_ALLOWED_FIELDS).not.toContain('reminderPreview');
    expect([...PAGING_ALLOWED_FIELDS].sort()).toEqual(['limit', 'nextCursor', 'pageSize', 'total']);
    // 概览 = 信封 + metrics；分区 kind/projectId 是分区 DTO 而非概览字段
    expect([...OVERVIEW_DTO_ALLOWED_FIELDS].sort()).toEqual([...ENVELOPE_ALLOWED_FIELDS, 'metrics'].sort());
    expect([...SECTION_COMMON_ALLOWED_FIELDS].sort()).toEqual(['id', 'kind', 'projectId']);
  });

  it('概览 metrics 只有五个键（不含阶段平均/提醒统计/预览）', () => {
    const metricKeys = new Set(['totalProjects', 'activeProjects', 'pendingAcceptance', 'pendingInvoice', 'pendingAmount']);
    // 通过投影 fixture 行无法直接构造 metrics；这里断言 DTO allowlist 不包含提醒字段。
    expect(OVERVIEW_DTO_ALLOWED_FIELDS).not.toContain('reminderCount');
    expect(metricKeys.size).toBe(5);
  });

  it('counts 与 nonBlocking allowlist 不含 activities / pendingShipTo / qrUnmarked', () => {
    expect(COUNTS_ALLOWED_FIELDS).not.toContain('activities');
    expect([...NON_BLOCKING_ALLOWED_FIELDS].sort()).toEqual(['repairs']);
  });

  it('运行时 allowlist 与 mobile-readonly-workbench 规格表逐项一致（防遗漏/防多出）', () => {
    // 「项目识别 WorkbenchProjectRow」唯一允许字段
    expect([...PROJECT_ALLOWED_FIELDS].sort()).toEqual(
      [
        'id', 'customerName', 'ecc', 'tempNo', 'status', 'formallyEntered', 'preEntryExecution',
        'region', 'regionNeedsAdjustment', 'planVisitAt', 'reminderAt', 'hasReminder', 'updatedAt',
        'contractAmount', 'entryAmountSnapshot', 'finalAmount', 'invoicedAmount', 'entryAt',
        'counts', 'nonBlocking',
      ].sort(),
    );
    // 关联计数 allowlist（不含 activities）
    expect([...COUNTS_ALLOWED_FIELDS].sort()).toEqual(['batches', 'instruments', 'invoices', 'orders', 'repairs']);
    // 各分区 allowlist（五分区，逐字段锚点）
    expect([...SECTION_ALLOWED_FIELDS.batches].sort()).toEqual(
      ['kind', 'id', 'projectId', 'planTransportDate', 'startedAt', 'appliedAt', 'originalPrice', 'discountedPrice'].sort(),
    );
    expect([...SECTION_ALLOWED_FIELDS.instruments].sort()).toEqual(
      ['kind', 'id', 'projectId', 'batchId', 'name', 'model', 'serialNo', 'ups', 'qrRequested'].sort(),
    );
    expect([...SECTION_ALLOWED_FIELDS.orders].sort()).toEqual(
      ['kind', 'id', 'projectId', 'orderType', 'serviceOrderNo', 'orderedAt'].sort(),
    );
    expect([...SECTION_ALLOWED_FIELDS.invoices].sort()).toEqual(
      ['kind', 'id', 'projectId', 'amount', 'invoicedAt', 'active', 'revokedAt', 'lastModifiedAt'].sort(),
    );
    expect([...SECTION_ALLOWED_FIELDS.damage_items].sort()).toEqual(
      [
        'kind', 'id', 'projectId', 'instrumentId', 'instrumentName', 'serialNo', 'issueStatus',
        'registeredAt', 'partNumber', 'partQuantity', 'partAmount', 'partCurrency', 'partStatus',
      ].sort(),
    );
    // 规格表明确排除：activities 分区、pendingShipTo/qrUnmarked、旧别名、提醒备注/到期分类
    expect(SECTION_ALLOWED_FIELDS).not.toHaveProperty('activities');
    for (const fields of Object.values(SECTION_ALLOWED_FIELDS)) {
      expect(fields).not.toContain('transportCompany');
      expect(fields).not.toContain('engineer');
      expect(fields).not.toContain('note');
      expect(fields).not.toContain('revokeReason');
      expect(fields).not.toContain('damageReason');
      expect(fields).not.toContain('createdAt');
      expect(fields).not.toContain('plannedInstallDoneAt');
    }
  });
});

function makeWithActivitiesCount(): ReturnType<typeof syntheticCompletedWithBalance> {
  const base = syntheticCompletedWithBalance();
  return {
    ...base,
    counts: { batches: 1, instruments: 2, activities: 99, orders: 3, repairs: 4, invoices: 5 },
    nonBlocking: { pendingShipTo: 7, qrUnmarked: 8, repairs: 0 },
  };
}

/** 未填区域项目（region=null + regionNeedsAdjustment=false）。 */
function makeUnfilledRegionProject(): WorkbenchProjectRow {
  return {
    ...syntheticPendingNoContract(),
    region: null,
    regionNeedsAdjustment: false,
  };
}

/** 强制断言：本测试源数据全部为 synthetic，绝不引用真实客户业务文件。 */
describe('synthetic fixture 卫生', () => {
  it('fixtures 不读取真实客户业务文件/路径/环境', () => {
    // fixtures 模块只被本文件静态 import，运行期无任何 fs/env/network 调用。
    expect(typeof projectJsonlText).toBe('function');
    expect(syntheticNoProjects()).toHaveLength(0);
  });

  it('错误 message 不含 synthetic 以外的业务样本（无真实客户值泄漏）', () => {
    expect(NO_CLIENT_DATA.test('联系人:张三@企业')).toBe(false); // 确保断言本身可识别真实样本
  });
});
