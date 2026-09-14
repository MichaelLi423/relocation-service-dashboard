import { describe, expect, it } from 'vitest';
import { SerialAddressUpdateService } from '../../src/domain/capabilities/serial-address-update/serial-address-update-service';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryInstrumentRepository } from '../helpers/execution-in-memory';
import { InMemorySerialAddressUpdateRepository } from '../helpers/capability-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * serial-address-update 领域场景测试（tasks 4.3 实现，4.12 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const instruments = new InMemoryInstrumentRepository();
  const updates = new InMemorySerialAddressUpdateRepository();
  const service = new SerialAddressUpdateService(updates, instruments, CLOCK);
  return { instruments, updates, service };
}

/** 在当前测试上下文中登记一台带序列号的搬迁仪器。 */
function addInstrument(ctx: ReturnType<typeof setup>, serialNo = 'SN-100', projectId = 'p1'): string {
  const id = `i-${serialNo}`;
  ctx.instruments.save({
    id,
    projectId,
    batchId: null,
    name: `仪器-${serialNo}`,
    model: null,
    manufacturer: null,
    serviceLevel: null,
    serialNo,
    ups: false,
    qrRequested: false,
    destinationShipToId: null,
    accountId: null,
    usernameSnapshot: null,
    createdAt: 't',
    updatedAt: 't',
  });
  return id;
}

const BASE = { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-001' };

describe('序列号地址更新事实逐台登记（4.3）', () => {
  it('逐台创建更新事实：记录客户名称、新址地址、序列号、Account ID 与更新时间', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(
      instrumentId,
      { ...BASE, updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(update.instrumentId).toBe(instrumentId);
    expect(update.customerName).toBe('华东医药');
    expect(update.newSiteAddress).toBe('新址A');
    expect(update.serialNo).toBe('SN-100');
    expect(update.accountId).toBe('ACC-001');
    expect(update.updatedAt).toBe('2026-08-01');
    expect(ctx.updates.all).toHaveLength(1);
  });

  it('一台仪器多次地址变化：每次登记各创建一条，按更新时间保留可追溯', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址A', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址B', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.updates.all).toHaveLength(2);
    expect(ctx.updates.all.map((u) => u.newSiteAddress).sort()).toEqual(['新址A', '新址B']);
  });
});

describe('项目新址为默认计划、更新事实表达实际关联（4.3）', () => {
  it('项目新址仅作默认计划：不自动成为仪器实际关联新址', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    // 项目级新址（project.newSiteAddress）不作为本服务输入，未登记更新事实 → 未关联
    expect(ctx.service.getActualAddress(instrumentId)).toBeNull();
  });

  it('更新事实表达实际关联：以最近一条更新事实的新址为准', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '旧地址', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '实际新址', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.service.getActualAddress(instrumentId)!.newSiteAddress).toBe('实际新址');
    expect(ctx.service.getActualAddress(instrumentId)!.accountId).toBe('ACC-002');
  });

  it('未登记更新事实不视为已关联新址', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    expect(ctx.service.getActualAddress(instrumentId)).toBeNull();
  });
});

describe('不修改不可变 Ship-to（4.3）', () => {
  it('更新事实不创建、不修改也不删除任何 Ship-to 主数据', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    // 服务签名不依赖任何 Ship-to 仓储，注册只写更新事实
    const proto = Object.getPrototypeOf(ctx.service) as Record<string, unknown>;
    for (const name of ['createShipTo', 'updateShipTo', 'deleteShipTo']) {
      expect(name in proto).toBe(false);
    }
    const update = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(update.accountId).toBe('ACC-001');
    // 仪器记录未被触碰
    expect(ctx.instruments.findById(instrumentId)!.destinationShipToId).toBeNull();
  });
});

describe('序列号地址更新记录删除（5.2）', () => {
  it('确认后删除：更新事实从列表与按更新日期计数统计中消失', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const first = ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址A', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '新址B', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.service.list()).toHaveLength(2);
    ctx.service.delete(first.id);
    expect(ctx.service.list()).toHaveLength(1);
    expect(ctx.service.list().every((u) => u.id !== first.id)).toBe(true);
    expect(ctx.service.countByMonth()).toEqual([{ month: '2026-08', count: 1 }]);
  });

  it('未确认（不存在）不删除：记录不存在时拒绝且无副作用', () => {
    const ctx = setup();
    expect(() => ctx.service.delete('no-such-update')).toThrow(/序列号地址更新记录不存在/);
    expect(ctx.updates.all).toHaveLength(0);
  });

  it('删除较新更新事实后，仪器实际关联新址回退到剩余最近更新事实', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '旧地址', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    const newer = ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '较新地址', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(ctx.service.getActualAddress(instrumentId)!.newSiteAddress).toBe('较新地址');
    // 删除较新一条 → 实际关联回退到剩余最近更新事实，不因删除而失去全部地址表达
    ctx.service.delete(newer.id);
    const actual = ctx.service.getActualAddress(instrumentId);
    expect(actual).not.toBeNull();
    expect(actual!.newSiteAddress).toBe('旧地址');
    expect(actual!.accountId).toBe('ACC-001');
  });

  it('删除更新事实不修改或删除关联仪器（与 Ship-to 主数据无关）', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(instrumentId, BASE, ACTOR);
    ctx.service.delete(update.id);
    expect(ctx.instruments.findById(instrumentId)).toBeDefined(); // 仪器保留
    expect(ctx.instruments.findById(instrumentId)!.destinationShipToId).toBeNull();
  });

  it('同一仪器多事实按更新日期+createdAt+id 稳定排序：同日登记仍确定唯一最近事实', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    // 同一更新日期、同一 createdAt（FixedClock）：仅 id 不同 → 稳定排序由 id 决胜
    const a = ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '地址A', accountId: 'ACC-A', updatedAt: '2026-08-01' },
      ACTOR,
    );
    const b = ctx.service.register(
      instrumentId,
      { ...BASE, newSiteAddress: '地址B', accountId: 'ACC-B', updatedAt: '2026-08-01' },
      ACTOR,
    );
    const expectedLatest = a.id > b.id ? a : b;
    expect(ctx.service.getActualAddress(instrumentId)!.id).toBe(expectedLatest.id);
    // 再次计算结果稳定（不随遍历顺序变化）
    expect(ctx.service.getActualAddress(instrumentId)!.id).toBe(expectedLatest.id);
  });
});

describe('更新时间必填、默认当前、可补录（4.3）', () => {
  it('创建时默认当前时间', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(update.updatedAt).toBe('2026-08-07');
  });

  it('补录历史时间：按所填历史时间保存并归属该月份', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    const update = ctx.service.register(instrumentId, { ...BASE, updatedAt: '2026-03-15' }, ACTOR);
    expect(update.updatedAt).toBe('2026-03-15');
    expect(ctx.service.countByMonth()).toEqual([{ month: '2026-03', count: 1 }]);
  });
});

describe('更新事实列表、筛选与按更新时间计数（4.3）', () => {
  function seed() {
    const ctx = setup();
    const i1 = addInstrument(ctx, 'SN-100');
    const i2 = addInstrument(ctx, 'SN-200');
    ctx.service.register(
      i1,
      { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-001', updatedAt: '2026-07-01' },
      ACTOR,
    );
    ctx.service.register(
      i2,
      { customerName: '华北医药', newSiteAddress: '新址B', serialNo: 'SN-200', accountId: 'ACC-002', updatedAt: '2026-08-01' },
      ACTOR,
    );
    return ctx;
  }

  it('列表展示与筛选：按客户、新址地址、序列号、Account ID 或更新时间', () => {
    const ctx = seed();
    expect(ctx.service.list()).toHaveLength(2);
    expect(ctx.service.list({ customerName: '华东' })).toHaveLength(1);
    expect(ctx.service.list({ newSiteAddress: '新址B' })).toHaveLength(1);
    expect(ctx.service.list({ serialNo: 'SN-200' })).toHaveLength(1);
    expect(ctx.service.list({ accountId: 'ACC-001' })).toHaveLength(1);
    expect(ctx.service.list({ updatedAt: '2026-08' })).toHaveLength(1);
    expect(ctx.service.list({ updatedAt: '2026-07-01' })).toHaveLength(1);
  });

  it('按更新时间所属月份计数', () => {
    const ctx = seed();
    expect(ctx.service.countByMonth()).toEqual([
      { month: '2026-07', count: 1 },
      { month: '2026-08', count: 1 },
    ]);
  });
});

describe('非空字段与序列号校验（4.3）', () => {
  it('instrumentId 可空：不传（null/undefined/空串）时独立保存，不关联搬迁仪器', () => {
    const ctx = setup();
    // 不传 instrumentId → 独立保存（不校验仪器）
    const update = ctx.service.register(
      null,
      { customerName: '独立客户', newSiteAddress: '独立新址', serialNo: 'SN-IND', accountId: 'ACC-IND', updatedAt: '2026-08-01' },
      ACTOR,
    );
    expect(update.instrumentId).toBeNull();
    expect(update.serialNo).toBe('SN-IND');
    expect(ctx.updates.all).toHaveLength(1);

    // undefined / 空串同样独立保存
    const u2 = ctx.service.register(
      undefined,
      { customerName: '独立客户2', newSiteAddress: '新址2', serialNo: 'SN-IND-2', accountId: 'ACC-IND-2' },
      ACTOR,
    );
    expect(u2.instrumentId).toBeNull();
    const u3 = ctx.service.register(
      '   ',
      { customerName: '独立客户3', newSiteAddress: '新址3', serialNo: 'SN-IND-3', accountId: 'ACC-IND-3' },
      ACTOR,
    );
    expect(u3.instrumentId).toBeNull();
    expect(ctx.updates.all).toHaveLength(3);
  });

  it('instrumentId 传值：保留「仪器存在 + 序列号一致」校验', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx, 'SN-100');
    // 不一致拒绝
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, serialNo: 'SN-999' }, ACTOR),
    ).toThrow(/不一致/);
    expect(ctx.updates.all).toHaveLength(0);
    // 一致允许
    const ok = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(ok.instrumentId).toBe(instrumentId);
    expect(ok.serialNo).toBe('SN-100');
    // 仪器不存在拒绝
    expect(() =>
      ctx.service.register('no-such-instrument', { ...BASE }, ACTOR),
    ).toThrow(/搬迁仪器不存在/);
    expect(ctx.updates.all).toHaveLength(1);
  });

  it('非空字段缺失拒绝保存', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, customerName: '  ' }, ACTOR),
    ).toThrow(/客户名称/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, newSiteAddress: '  ' }, ACTOR),
    ).toThrow(/新址地址/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, serialNo: '  ' }, ACTOR),
    ).toThrow(/序列号/);
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, accountId: '  ' }, ACTOR),
    ).toThrow(/Account ID/);
    // 不产生部分保存的更新事实
    expect(ctx.service.list()).toHaveLength(0);
  });

  it('序列号与登记仪器一致：不一致拒绝保存', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx, 'SN-100');
    expect(() =>
      ctx.service.register(instrumentId, { ...BASE, serialNo: 'SN-999' }, ACTOR),
    ).toThrow(/不一致/);
    expect(ctx.updates.all).toHaveLength(0);
    // 一致才允许保存
    const ok = ctx.service.register(instrumentId, BASE, ACTOR);
    expect(ok.serialNo).toBe('SN-100');
  });

  it('仪器登记序列号含首尾空白时按归一化值比较：提交无空白序列号可成功登记', () => {
    const ctx = setup();
    ctx.instruments.save({
      id: 'i-ws',
      projectId: 'p1',
      batchId: null,
      name: '仪器-SN-100',
      model: null,
      manufacturer: null,
      serviceLevel: null,
      serialNo: '  SN-100  ',
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    const update = ctx.service.register('i-ws', { ...BASE, serialNo: 'SN-100' }, ACTOR);
    expect(update.instrumentId).toBe('i-ws');
    expect(update.serialNo).toBe('SN-100');
    expect(ctx.updates.all).toHaveLength(1);
    expect(ctx.updates.all[0].serialNo).toBe('SN-100');
  });

  it('仪器登记序列号按分组空格录入时：提交连续字符串可成功登记且保存提交值', () => {
    const ctx = setup();
    ctx.instruments.save({
      id: 'i-grouped',
      projectId: 'p1',
      batchId: null,
      name: '仪器-分组序列号',
      model: null,
      manufacturer: null,
      serviceLevel: null,
      serialNo: 'DEBAV06313 DEBA414152 DEBAQ07911 DEBAX06001 DEJAA01413',
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    const continuous = 'DEBAV06313DEBA414152DEBAQ07911DEBAX06001DEJAA01413';
    const update = ctx.service.register('i-grouped', { ...BASE, serialNo: continuous }, ACTOR);
    expect(update.instrumentId).toBe('i-grouped');
    // 保存的是提交字符串本身（连续、内部无空白），未按仪器分组空格改写
    expect(update.serialNo).toBe(continuous);
    expect(ctx.updates.all).toHaveLength(1);
    expect(ctx.updates.all[0].serialNo).toBe(continuous);
    // 移除空白后仍有字符差异时，仍由既有不一致校验拒绝
    expect(() =>
      ctx.service.register('i-grouped', { ...BASE, serialNo: 'DEBAV06313DEBA414152DEBAQ07911DEBAX06001DEJAA01414' }, ACTOR),
    ).toThrow(/不一致/);
    expect(ctx.updates.all).toHaveLength(1);
  });

  it('不引入未确认的序列号格式约束：仅非空与仪器一致', () => {
    const ctx = setup();
    const instrumentId = addInstrument(ctx, 'SN-100-XYZ/01');
    const update = ctx.service.register(
      instrumentId,
      { ...BASE, serialNo: 'SN-100-XYZ/01' },
      ACTOR,
    );
    expect(update.serialNo).toBe('SN-100-XYZ/01');
  });

  it('占位仪器（无序列号）无法登记序列号地址更新', () => {
    const ctx = setup();
    ctx.instruments.save({
      id: 'i-ph',
      projectId: 'p1',
      batchId: null,
      name: '占位仪器',
      model: null,
      manufacturer: null,
      serviceLevel: null,
      serialNo: null,
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    expect(() =>
      ctx.service.register('i-ph', { ...BASE, serialNo: 'SN-X' }, ACTOR),
    ).toThrow(/尚无序列号/);
  });
});
