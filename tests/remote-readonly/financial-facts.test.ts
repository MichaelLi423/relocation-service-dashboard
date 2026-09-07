import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/core/errors';
import {
  computePendingAmount,
  type InvoiceFact,
  type PendingAmountFactsInput,
} from '../../src/shared/remote-readonly/financial-facts';

/**
 * financial-facts（tasks 1.4）：待掉票金额纯适配器。
 * 事实经真实项目 join / invoice 关联过滤（不传预聚合 invoicedAmount）。
 */

function input(overrides: Partial<PendingAmountFactsInput> = {}): PendingAmountFactsInput {
  return {
    projects: [],
    contracts: [],
    invoices: [],
    ...overrides,
  };
}

const p = (id: string, status = 'completed') => ({ id, status });
const c = (projectId: string, final: string | null) => ({ projectId, finalAmount: final });
const inv = (id: string, projectId: string, amount: string, revoked = false): InvoiceFact => ({
  id,
  projectId,
  amount,
  revoked,
});

describe('computePendingAmount：关联 join/过滤', () => {
  it('无项目 → 0.00', () => {
    expect(computePendingAmount(input())).toEqual({ pendingAmount: '0.00', cents: 0n, contributingProjectCount: 0 });
  });

  it('完成项目 + 有效掉票：final - active，精确字符串', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed')],
        contracts: [c('p1', '8000.00')],
        invoices: [inv('i1', 'p1', '3000.00')],
      }),
    );
    expect(r).toEqual({ pendingAmount: '5000.00', cents: 500000n, contributingProjectCount: 1 });
  });

  it('已完成但仍有余额的项目计入；不按 pending_invoice 状态筛选替代', () => {
    const r = computePendingAmount(
      input({
        projects: [
          p('p1', 'completed'),
          p('p2', 'pending_entry'), // 任意非取消状态都计入（entryAt 不影响）
        ],
        contracts: [c('p1', '8000.00'), c('p2', '1000.00')],
        invoices: [inv('i1', 'p1', '8000.00'), inv('i2', 'p2', '400.00')],
      }),
    );
    expect(r).toEqual({ pendingAmount: '600.00', cents: 60000n, contributingProjectCount: 2 });
  });

  it('entryAt=null 不影响贡献（结构上通过扩展 source 行携带 entryAt=null，仅项目存在性参与过滤）', () => {
    // 领域源行可含 entryAt；投影/本适配器只消费存在性与状态，entryAt 不参与资格过滤。
    const sourceWithEntryAtNull = { ...p('p1', 'completed'), entryAt: null };
    const r = computePendingAmount(
      input({ projects: [sourceWithEntryAtNull], contracts: [c('p1', '500.00')], invoices: [] }),
    );
    expect(r.pendingAmount).toBe('500.00');
    // 已取消且 entryAt=null 仍排除（状态是唯一资格过滤，与 entryAt 无关）
    const cancelledNull = { ...p('p9', 'cancelled'), entryAt: null };
    const r2 = computePendingAmount(
      input({ projects: [cancelledNull], contracts: [c('p9', '500.00')], invoices: [] }),
    );
    expect(r2.pendingAmount).toBe('0.00');
    expect(r2.contributingProjectCount).toBe(0);
  });

  it('已取消项目排除：其合同/掉票完全不参与', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'cancelled'), p('p2', 'completed')],
        contracts: [c('p1', '9000.00'), c('p2', '1000.00')],
        invoices: [inv('i1', 'p1', '2000.00'), inv('i2', 'p2', '300.00')],
      }),
    );
    expect(r).toEqual({ pendingAmount: '700.00', cents: 70000n, contributingProjectCount: 1 });
  });

  it('孤立掉票（projectId 不在仍存在项目）join 忽略；孤立合同也忽略', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed')],
        contracts: [c('p1', '1000.00'), c('orphan-proj', '9999.00')], // 孤立合同
        invoices: [inv('i1', 'p1', '200.00'), inv('i-orphan', 'orphan-proj', '999.00'), inv('i-no-proj', 'nope', '888.00')],
      }),
    );
    expect(r).toEqual({ pendingAmount: '800.00', cents: 80000n, contributingProjectCount: 1 });
  });

  it('撤销掉票排除（领域正式规则 sumActiveInvoices）', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed')],
        contracts: [c('p1', '5000.00')],
        invoices: [
          inv('i1', 'p1', '3000.00'),
          inv('i2', 'p1', '2000.00', true), // 已撤销
          inv('i3', 'p1', '1000.00', true),
        ],
      }),
    );
    expect(r).toEqual({ pendingAmount: '2000.00', cents: 200000n, contributingProjectCount: 1 });
  });

  it('余额 <= 0 → 该项目贡献 0，合计不受负值影响', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed'), p('p2', 'completed')],
        contracts: [c('p1', '1000.00'), c('p2', '500.00')],
        invoices: [inv('i1', 'p1', '3000.00'), inv('i2', 'p2', '500.00')],
      }),
    );
    expect(r).toEqual({ pendingAmount: '0.00', cents: 0n, contributingProjectCount: 2 });
    expect(r.cents).toBeGreaterThanOrEqual(0n);
  });

  it('null final（未录入）排除；0 final 合法可计算、贡献 0 并计入项目数', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed'), p('p2', 'completed'), p('p3', 'completed')],
        contracts: [c('p1', null), c('p2', '0.00'), c('p3', '100.00')],
        invoices: [],
      }),
    );
    // p1 未录入 → 不可计算排除；p2 final=0 可计算贡献 0；p3 贡献 100.00
    expect(r).toEqual({ pendingAmount: '100.00', cents: 10000n, contributingProjectCount: 2 });
  });

  it('无关联合同项目（join 不到）排除', () => {
    const r = computePendingAmount(
      input({ projects: [p('p1', 'completed')], contracts: [], invoices: [inv('i1', 'p1', '100.00')] }),
    );
    expect(r).toEqual({ pendingAmount: '0.00', cents: 0n, contributingProjectCount: 0 });
  });

  it('重复标识（项目 id/合同 projectId/掉票 id）→ metadata-only 拒绝，不回显标识', () => {
    const cases: Array<[() => PendingAmountFactsInput, string]> = [
      [() => input({ projects: [p('p1'), p('p1')] }), 'DUPLICATE_PROJECT_ID'],
      [() => input({ projects: [p('p1')], contracts: [c('p1', '1.00'), c('p1', '2.00')] }), 'DUPLICATE_CONTRACT_PROJECT_ID'],
      [() => input({ projects: [p('p1')], contracts: [c('p1', '1.00')], invoices: [inv('i1', 'p1', '1.00'), inv('i1', 'p1', '2.00')] }), 'DUPLICATE_INVOICE_ID'],
    ];
    for (const [make, code] of cases) {
      let msg = '';
      try {
        computePendingAmount(make());
      } catch (err) {
        if (err instanceof DomainError) msg = `${err.code}:${err.message}`;
        else throw err;
      }
      expect(msg).toContain(code);
      expect(msg).not.toContain('p1');
      expect(msg).not.toContain('i1');
    }
  });

  it('相同金额但 id 不同的掉票是独立事实，照常累加（不发明金额去重）', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed')],
        contracts: [c('p1', '1000.00')],
        invoices: [inv('i1', 'p1', '300.00'), inv('i2', 'p1', '300.00'), inv('i3', 'p1', '300.00', true)],
      }),
    );
    expect(r).toEqual({ pendingAmount: '400.00', cents: 40000n, contributingProjectCount: 1 });
  });
});

describe('computePendingAmount：严格金额（禁止静默舍入/宽松解析）', () => {
  function throwMsg(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof DomainError) return `${err.code}:${err.message}`;
      throw err;
    }
    throw new Error('expected throw');
  }

  it('参与计算的 final 非规范（需舍入/trim/多余小数）→ 拒绝，消息不含输入值', () => {
    for (const bad of ['1.5', '1.567', ' 8000.00', '8000', '1e3', '-1.00', 'abc']) {
      const msg = throwMsg(() =>
        computePendingAmount(
          input({ projects: [p('p1', 'completed')], contracts: [c('p1', bad)], invoices: [] }),
        ),
      );
      expect(msg).not.toContain(bad);
      expect(msg).toMatch(/INVALID_MONEY_FORMAT/);
    }
  });

  it('参与计算的有效掉票金额非规范 → 拒绝（不静默舍入）', () => {
    for (const bad of ['1.5', '3000', ' 3000.00', '3000.001']) {
      const msg = throwMsg(() =>
        computePendingAmount(
          input({
            projects: [p('p1', 'completed')],
            contracts: [c('p1', '8000.00')],
            invoices: [inv('i1', 'p1', bad)],
          }),
        ),
      );
      expect(msg).toMatch(/INVALID_MONEY_FORMAT/);
      expect(msg).not.toContain(bad);
    }
  });

  it('被排除事实的金额不解析：孤立/已撤销/已取消/无 final 项目的畸形金额不报错', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed'), p('p2', 'cancelled')],
        contracts: [c('p1', '8000.00')],
        invoices: [
          inv('i-orphan', 'ghost', 'not-a-number'), // 孤立
          inv('i-revoked', 'p1', 'bad!!', true), // 已撤销
          inv('i-cancelled', 'p2', 'bad!!'), // 已取消项目下
        ],
      }),
    );
    expect(r).toEqual({ pendingAmount: '8000.00', cents: 800000n, contributingProjectCount: 1 });
  });

  it('超安全整数大额精确参与（BigInt，不丢精度）', () => {
    // 9007199254740993 分 = Number.MAX_SAFE_INTEGER+1 的精确表达
    const huge = '90071992547409.93';
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed')],
        contracts: [c('p1', huge)],
        invoices: [inv('i1', 'p1', '90071992547409.92')],
      }),
    );
    expect(r.cents).toBe(1n);
    expect(r.pendingAmount).toBe('0.01');
  });

  it('多项目总额精确相加', () => {
    const r = computePendingAmount(
      input({
        projects: [p('p1', 'completed'), p('p2', 'completed'), p('p3', 'completed')],
        contracts: [c('p1', '100.01'), c('p2', '200.02'), c('p3', '300.03')],
        invoices: [inv('i1', 'p1', '0.01'), inv('i2', 'p2', '0.02'), inv('i3', 'p3', '0.03')],
      }),
    );
    expect(r.pendingAmount).toBe('600.00');
    expect(r.cents).toBe(60000n);
  });
});
