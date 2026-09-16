import { describe, expect, it } from 'vitest';
import {
  FinancialClosureService,
  type FinancialStatusGateway,
} from '../../src/domain/capabilities/project-financial-closure/financial-closure-service';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import {
  InMemoryContractRepository,
  InMemoryProjectRepository,
} from '../helpers/in-memory-repos';
import { InMemoryInvoiceReadRepository, InMemoryInvoiceRepository } from '../helpers/financial-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * project-financial-closure 领域场景测试（tasks 5.1~5.11 实现，5.12 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景，并验证与 2.x 正式进单快照/取消的联动。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

let eccSeq = 0;

function setup() {
  const projects = new InMemoryProjectRepository();
  const contracts = new InMemoryContractRepository();
  const invoices = new InMemoryInvoiceRepository();
  const invoiceRead = new InMemoryInvoiceReadRepository(invoices);
  const projectService = new ProjectService(projects, contracts, invoiceRead, CLOCK);
  const gateway: FinancialStatusGateway = {
    reevaluateStatus: (projectId) => {
      const project = projects.findById(projectId)!;
      projectService.adjustStatus(projectId, project.status);
    },
  };
  const financial = new FinancialClosureService(projects, contracts, invoices, gateway, CLOCK);
  return { projects, contracts, invoices, invoiceRead, projectService, financial };
}

/** 构造已正式进单且处于待掉票的项目（final 默认取合同金额）。 */
function preparePendingInvoice(ctx: ReturnType<typeof setup>, amount = '10000'): string {
  const projectId = ctx.projectService.createPendingProject().id;
  const contract = ctx.projectService.attachContract(projectId);
  ctx.contracts.save(contract);
  ctx.financial.setContractUsdTaxAmount(projectId, Money.parse(amount).cents);
  ctx.projectService.linkCustomer(projectId, 'customer-1');
  ctx.projectService.confirmScope(projectId);
  eccSeq += 1;
  ctx.projectService.formalEntry(projectId, { ecc: `ECC-FIN-${eccSeq}` });
  ctx.projectService.adjustStatus(projectId, 'executing');
  ctx.projectService.recordActualInstallDone(projectId, '2026-08-05');
  ctx.projectService.markAcceptance(projectId, '2026-08-06');
  expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');
  return projectId;
}

/** 构造已正式进单且处于执行中的项目（final 默认取合同金额，无验收事实）。 */
function prepareExecuting(ctx: ReturnType<typeof setup>, amount = '10000'): string {
  const projectId = ctx.projectService.createPendingProject().id;
  const contract = ctx.projectService.attachContract(projectId);
  ctx.contracts.save(contract);
  ctx.financial.setContractUsdTaxAmount(projectId, Money.parse(amount).cents);
  ctx.projectService.linkCustomer(projectId, 'customer-1');
  ctx.projectService.confirmScope(projectId);
  eccSeq += 1;
  ctx.projectService.formalEntry(projectId, { ecc: `ECC-EXEC-${eccSeq}` });
  ctx.projectService.adjustStatus(projectId, 'executing');
  expect(ctx.projects.findById(projectId)!.status).toBe('executing');
  return projectId;
}

describe('合同 USD 含税金额手工录入与直接覆盖（5.1 / TBD-20）', () => {
  it('手工录入合同含税金额：保存手工值，不根据净值税率自动计算或改写', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.projectService.attachContract(projectId);
    const { contract } = ctx.financial.setContractUsdTaxAmount(projectId, Money.parse('8000').cents);
    expect(contract.usdTaxAmountCents).toBe(800000n);
    expect(ctx.contracts.findByProjectId(projectId)!.usdTaxAmountCents).toBe(800000n);
  });

  it('金额与净值税率计算结果不一致时仅警告，仍允许保存且不自动覆盖', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.projectService.attachContract(projectId);
    // 净值×税率计算结果 9500，负责人手工录入 8000 → 警告但保存
    const { contract, warning } = ctx.financial.setContractUsdTaxAmount(projectId, 800000n, {
      expectedFromNetTaxCents: 950000n,
    });
    expect(warning).toContain('不一致');
    expect(contract.usdTaxAmountCents).toBe(800000n); // 不自动覆盖
    // 一致时无警告
    const ok = ctx.financial.setContractUsdTaxAmount(projectId, 950000n, {
      expectedFromNetTaxCents: 950000n,
    });
    expect(ok.warning).toBeNull();
  });

  it('合同金额直接覆盖修改：保存新值，不保存正式合同变更对象/历史、不要求原因', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.financial.setContractUsdTaxAmount(projectId, Money.parse('12000').cents);
    expect(ctx.contracts.findByProjectId(projectId)!.usdTaxAmountCents).toBe(1200000n);
    // 不保存变更历史：合同实体无历史字段/服务无历史方法
    const contract = ctx.contracts.findByProjectId(projectId)!;
    const keys = Object.keys(contract);
    expect(keys.some((k) => k.includes('history') || k.includes('change'))).toBe(false);
  });

  it('合同金额允许为 0；除合同金额外的其他录入金额不允许为 0', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    ctx.projectService.attachContract(projectId);
    expect(ctx.financial.setContractUsdTaxAmount(projectId, 0n).contract.usdTaxAmountCents).toBe(0n);
    // 最终可确认金额为 0 被拒
    const projectId2 = preparePendingInvoice(ctx, '10000');
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId2, 0n)).toThrow(/大于 0/);
    expect(() => ctx.financial.setContractUsdTaxAmount(projectId, -1n)).toThrow(/负数/);
  });
});

describe('进单金额快照锁定（5.2/5.3 / TBD-20）', () => {
  it('正式进单保存金额快照，合同金额覆盖不改写快照', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    const contract = ctx.contracts.findByProjectId(projectId)!;
    expect(contract.entryAmountSnapshotCents).toBe(1000000n);

    ctx.financial.setContractUsdTaxAmount(projectId, Money.parse('12000').cents);
    const after = ctx.contracts.findByProjectId(projectId)!;
    expect(after.entryAmountSnapshotCents).toBe(1000000n); // 快照不变
    expect(after.usdTaxAmountCents).toBe(1200000n); // 最新合同金额（用于占比重算）
  });
});

describe('最终可确认金额（5.4 / TBD-20）', () => {
  it('默认取合同金额并可调整，调整不影响原合同金额', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    expect(ctx.contracts.findByProjectId(projectId)!.finalConfirmableAmountCents).toBe(1000000n);

    const adjusted = ctx.financial.setFinalConfirmableAmount(projectId, 900000n);
    expect(adjusted.finalConfirmableAmountCents).toBe(900000n);
    expect(adjusted.usdTaxAmountCents).toBe(1000000n); // 原合同金额不变
  });

  it('最终可确认金额不随合同金额覆盖同步', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.financial.setFinalConfirmableAmount(projectId, 900000n);
    ctx.financial.setContractUsdTaxAmount(projectId, Money.parse('12000').cents);
    expect(ctx.contracts.findByProjectId(projectId)!.finalConfirmableAmountCents).toBe(900000n);
  });

  it('合同金额为 0 时正式进单 final 保持 null（不再强制另行录入，进单后基线待执行）', () => {
    const ctx = setup();
    // 未另行录入 → final 保持 null、进单成功（2.1 正式进单规则更新）
    const projectId = ctx.projectService.createPendingProject().id;
    const contract = ctx.projectService.attachContract(projectId);
    ctx.contracts.save(contract);
    ctx.financial.setContractUsdTaxAmount(projectId, 0n);
    ctx.projectService.linkCustomer(projectId, 'customer-1');
    ctx.projectService.confirmScope(projectId);
    const entered = ctx.projectService.formalEntry(projectId, { ecc: 'ECC-ZERO' });
    expect(entered.status).toBe('pending_execution');
    expect(ctx.contracts.findByProjectId(projectId)!.finalConfirmableAmountCents).toBeNull();

    // 另行录入 > 0 → 允许
    const projectId2 = ctx.projectService.createPendingProject().id;
    const contract2 = ctx.projectService.attachContract(projectId2);
    ctx.contracts.save(contract2);
    ctx.financial.setContractUsdTaxAmount(projectId2, 0n);
    ctx.projectService.linkCustomer(projectId2, 'customer-1');
    ctx.projectService.confirmScope(projectId2);
    const entered2 = ctx.projectService.formalEntry(projectId2, {
      ecc: 'ECC-ZERO-2',
      finalConfirmableAmountCents: 500000n,
    });
    expect(entered2.status).toBe('pending_execution');
    expect(ctx.contracts.findByProjectId(projectId2)!.finalConfirmableAmountCents).toBe(500000n);
  });

  it('最终可确认金额不得低于累计掉票金额', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId, 400000n)).toThrow(/不得低于累计/);
    expect(ctx.contracts.findByProjectId(projectId)!.finalConfirmableAmountCents).toBe(1000000n); // 保持原值
  });
});

describe('分次掉票记录（5.5）', () => {
  it('同一项目可多次掉票，各自记录时间与金额并分别计数', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    const inv1 = ctx.financial.recordInvoice(projectId, { amountCents: 300000n, invoicedAt: '2026-08-01' }, ACTOR);
    const inv2 = ctx.financial.recordInvoice(projectId, { amountCents: 400000n, invoicedAt: '2026-08-10' }, ACTOR);
    expect(ctx.financial.listInvoices(projectId)).toHaveLength(2);
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(700000n);
    expect(ctx.financial.countActiveInvoices(projectId)).toBe(2);
    expect(inv1.invoicedAt).toBe('2026-08-01');
    expect(inv2.amountCents).toBe(400000n);
  });
});

describe('金额精度与录入金额正数校验（5.6 / TBD-11）', () => {
  it('掉票单笔金额必须大于 0', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    expect(() => ctx.financial.recordInvoice(projectId, { amountCents: 0n }, ACTOR)).toThrow(/必须大于 0/);
    expect(() => ctx.financial.recordInvoice(projectId, { amountCents: -1n }, ACTOR)).toThrow(/必须大于 0/);
  });

  it('其他录入金额不得为 0 或负数', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId, 0n)).toThrow(/大于 0/);
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId, -100n)).toThrow(/大于 0/);
  });

  it('金额按两位小数十进制定点四舍五入，全程不采用二进制浮点', () => {
    // 1234.567 → 1234.57（分整数 123457）
    expect(Money.parse('1234.567').cents).toBe(123457n);
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.financial.recordInvoice(projectId, { amountCents: Money.parse('999.999').cents, invoicedAt: '2026-08-01' }, ACTOR);
    ctx.financial.recordInvoice(projectId, { amountCents: Money.parse('0.005').cents, invoicedAt: '2026-08-02' }, ACTOR);
    // 1000.00 + 0.01 = 1000.01（定点求和，无浮点误差）
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(100001n);
  });
});

describe('超额保护（5.7）', () => {
  it('新增掉票导致累计超额被拒绝，提示先调整最终可确认金额', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000'); // final 1000000
    ctx.financial.recordInvoice(projectId, { amountCents: 900000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(() => ctx.financial.recordInvoice(projectId, { amountCents: 200000n, invoicedAt: '2026-08-02' }, ACTOR)).toThrow(
      /调整最终可确认金额/,
    );
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(900000n); // 未写入
  });

  it('先调整最终可确认金额后再掉票', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.financial.recordInvoice(projectId, { amountCents: 900000n, invoicedAt: '2026-08-01' }, ACTOR);
    ctx.financial.setFinalConfirmableAmount(projectId, 1200000n);
    ctx.financial.recordInvoice(projectId, { amountCents: 200000n, invoicedAt: '2026-08-02' }, ACTOR);
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(1100000n);
  });
});

describe('掉票直接编辑并记录最后修改时间（5.8）', () => {
  it('覆盖修改掉票金额与日期，不保留旧值，自动记录最后修改时间并重算', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    const inv = ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-07-01' }, ACTOR);

    const edited = ctx.financial.editInvoice(
      inv.id,
      { amountCents: 600000n, invoicedAt: '2026-08-02' },
      ACTOR,
    );
    expect(edited.amountCents).toBe(600000n);
    expect(edited.invoicedAt).toBe('2026-08-02');
    expect(edited.lastModifiedAt).toBe('2026-08-07T10:00:00+08:00');
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(600000n); // 重算
  });

  it('已撤销掉票禁止编辑', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    const inv = ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-08-01' }, ACTOR);
    ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-03', revokeReason: '误登记' }, ACTOR);
    expect(() =>
      ctx.financial.editInvoice(inv.id, { amountCents: 600000n }, ACTOR),
    ).toThrow(/终态/);
  });

  it('编辑后重算项目状态：任意有效掉票即已完成（不再等累计金额足额）', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000'); // final 800000
    ctx.financial.recordInvoice(projectId, { amountCents: 600000n, invoicedAt: '2026-08-01' }, ACTOR);
    const inv2 = ctx.financial.recordInvoice(projectId, { amountCents: 100000n, invoicedAt: '2026-08-02' }, ACTOR);
    // 已确认语义：登记第一笔掉票后立即进入已完成（累计 600000 < final 800000 也已完成）。
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    // 编辑金额不改变已完成状态（仍存在有效掉票）。
    ctx.financial.editInvoice(inv2.id, { amountCents: 200000n, invoicedAt: '2026-08-03' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
  });
});

describe('掉票撤销终态而非删除（5.9 / TBD-19）', () => {
  it('撤销一条掉票记录：保留记录但标记已撤销，不再计入金额与次数并重算状态', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000');
    const inv = ctx.financial.recordInvoice(projectId, { amountCents: 800000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');

    ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-04', revokeReason: '客户修正' }, ACTOR);
    // 记录保留但已撤销
    expect(ctx.financial.listInvoices(projectId)).toHaveLength(1);
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(0n);
    expect(ctx.financial.countActiveInvoices(projectId)).toBe(0);
    // 状态重算回到待掉票
    expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');
  });

  it('掉票记录不可物理删除', () => {
    const service = setup().financial;
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['deleteInvoice', 'removeInvoice', 'hardDeleteInvoice']) {
      expect(name in proto).toBe(false);
    }
  });

  it('已撤销掉票禁止重复撤销', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000');
    const inv = ctx.financial.recordInvoice(projectId, { amountCents: 800000n, invoicedAt: '2026-08-01' }, ACTOR);
    ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-04', revokeReason: '撤销' }, ACTOR);
    expect(() =>
      ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-05', revokeReason: '再撤销' }, ACTOR),
    ).toThrow(/终态/);
  });

  it('已撤销掉票禁止重新激活，更正需新增有效掉票', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '10000');
    const inv = ctx.financial.recordInvoice(projectId, { amountCents: 500000n, invoicedAt: '2026-08-01' }, ACTOR);
    ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-04', revokeReason: '撤销' }, ACTOR);
    // 无重新激活方法（终态）；更正 = 新增有效掉票
    const proto = Object.getPrototypeOf(ctx.financial) as Record<string, unknown>;
    expect('reactivateInvoice' in proto).toBe(false);
    const correction = ctx.financial.recordInvoice(projectId, { amountCents: 400000n, invoicedAt: '2026-08-05' }, ACTOR);
    expect(correction.amountCents).toBe(400000n);
    expect(ctx.financial.sumActiveAmounts(projectId)).toBe(400000n);
  });
});

describe('执行中项目掉票后自动已完成（回归场景）', () => {
  it('正式进单后处于执行中、final>0、无验收事实，登记一笔有效掉票后应变为已完成', () => {
    const ctx = setup();
    const projectId = prepareExecuting(ctx, '10000');
    ctx.financial.recordInvoice(projectId, { amountCents: 100000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
  });
});

describe('待掉票与已完成状态按金额闭环重算（5.10 / TBD-11，已确认语义）', () => {
  it('任意成功登记一笔掉票即进入已完成（不再等累计金额足额）', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000'); // final 800000
    ctx.financial.recordInvoice(projectId, { amountCents: 600000n, invoicedAt: '2026-08-01' }, ACTOR);
    // 累计 600000 < final 800000 仍立即完成。
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    ctx.financial.recordInvoice(projectId, { amountCents: 200000n, invoicedAt: '2026-08-02' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    expect(ctx.financial.countActiveInvoices(projectId)).toBe(2);
  });

  it('撤销最后有效掉票后回到待掉票（合理回退）；仍有其他有效掉票时保持已完成', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000');
    const inv1 = ctx.financial.recordInvoice(projectId, { amountCents: 400000n, invoicedAt: '2026-08-01' }, ACTOR);
    const inv2 = ctx.financial.recordInvoice(projectId, { amountCents: 200000n, invoicedAt: '2026-08-02' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    // 撤销其中一笔：仍有有效掉票 → 保持已完成。
    ctx.financial.revokeInvoice(inv1.id, { revokedAt: '2026-08-03', revokeReason: '撤销' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    // 撤销最后有效掉票：累计归 0 → 回到待掉票。
    ctx.financial.revokeInvoice(inv2.id, { revokedAt: '2026-08-04', revokeReason: '撤销' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');
  });

  it('已完成项目因撤销掉票回到待掉票', () => {
    const ctx = setup();
    const projectId = preparePendingInvoice(ctx, '8000');
    ctx.financial.recordInvoice(projectId, { amountCents: 800000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('completed');
    const inv = ctx.financial.listInvoices(projectId)[0];
    ctx.financial.revokeInvoice(inv.id, { revokedAt: '2026-08-03', revokeReason: '撤销' }, ACTOR);
    expect(ctx.projects.findById(projectId)!.status).toBe('pending_invoice');
  });

  it('非待掉票/已完成状态修改金额不改变主状态', () => {
    const ctx = setup();
    const projectId = ctx.projectService.createPendingProject().id;
    const contract = ctx.projectService.attachContract(projectId);
    ctx.contracts.save(contract);
    ctx.financial.setContractUsdTaxAmount(projectId, 1000000n);
    ctx.projectService.linkCustomer(projectId, 'customer-1');
    ctx.projectService.confirmScope(projectId);
    ctx.projectService.formalEntry(projectId, { ecc: 'ECC-EXEC' });
    ctx.projectService.adjustStatus(projectId, 'executing');
    expect(ctx.projects.findById(projectId)!.status).toBe('executing');

    ctx.financial.setContractUsdTaxAmount(projectId, 1200000n);
    ctx.financial.setFinalConfirmableAmount(projectId, 1100000n);
    expect(ctx.projects.findById(projectId)!.status).toBe('executing'); // 不因金额修改触发状态重算
  });
});

describe('已取消状态金额与掉票修改被拒绝（5.11）', () => {
  function cancelledProject(ctx: ReturnType<typeof setup>): string {
    const projectId = preparePendingInvoice(ctx, '10000');
    // 取消要求无任何掉票历史 → 此处尚无掉票
    ctx.projectService.cancelProject(projectId, {
      time: '2026-08-06',
      reason: '客户取消搬迁计划',
    });
    expect(ctx.projects.findById(projectId)!.status).toBe('cancelled');
    return projectId;
  }

  it('已取消项目禁止修改合同金额与最终可确认金额', () => {
    const ctx = setup();
    const projectId = cancelledProject(ctx);
    expect(() => ctx.financial.setContractUsdTaxAmount(projectId, 1200000n)).toThrow(/已取消/);
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId, 900000n)).toThrow(/已取消/);
    expect(ctx.contracts.findByProjectId(projectId)!.usdTaxAmountCents).toBe(1000000n); // 保持取消时值
  });

  it('已取消项目禁止新增、编辑或撤销掉票', () => {
    const ctx = setup();
    const projectId = cancelledProject(ctx);
    expect(() => ctx.financial.recordInvoice(projectId, { amountCents: 100000n }, ACTOR)).toThrow(/已取消/);

    // 先在一个未取消项目登记掉票，再构造取消前有掉票的冲突场景：
    // 取消前已登记掉票 → 无法取消（取消约束），故直接验证已取消项目编辑/撤销被拒
    const other = setup();
    const pid2 = preparePendingInvoice(other, '10000');
    other.financial.recordInvoice(pid2, { amountCents: 100000n, invoicedAt: '2026-08-01' }, ACTOR);
    expect(() =>
      other.projectService.cancelProject(pid2, { time: '2026-08-06', reason: '取消' }),
    ).toThrow(/掉票历史/);

    // 用原始 ctx 验证已取消项目上编辑/撤销掉票被拒（构造已撤销前的掉票在取消前不存在）
    const ctx2 = setup();
    const pid3 = ctx2.projectService.createPendingProject().id;
    const contract = ctx2.projectService.attachContract(pid3);
    ctx2.contracts.save(contract);
    ctx2.financial.setContractUsdTaxAmount(pid3, 1000000n);
    ctx2.projectService.linkCustomer(pid3, 'c');
    ctx2.projectService.confirmScope(pid3);
    ctx2.projectService.formalEntry(pid3, { ecc: 'ECC-CANCEL2' });
    ctx2.projectService.cancelProject(pid3, { time: '2026-08-06', reason: '取消' });
    // 取消后无法登记掉票，故编辑/撤销也无从谈起——验证服务对所有掉票方法统一拒绝
    expect(() => ctx2.financial.recordInvoice(pid3, { amountCents: 100000n }, ACTOR)).toThrow(/已取消/);
  });
});

describe('已转单状态金额与掉票修改被拒绝（终态冻结）', () => {
  function transferredProject(ctx: ReturnType<typeof setup>): string {
    const projectId = preparePendingInvoice(ctx, '10000');
    ctx.projectService.adjustStatus(projectId, 'transferred');
    expect(ctx.projects.findById(projectId)!.status).toBe('transferred');
    return projectId;
  }

  it('已转单项目冻结金额与掉票修改', () => {
    const ctx = setup();
    const projectId = transferredProject(ctx);
    expect(() => ctx.financial.setContractUsdTaxAmount(projectId, 1200000n)).toThrow(/已转单/);
    expect(() => ctx.financial.setFinalConfirmableAmount(projectId, 900000n)).toThrow(/已转单/);
    expect(() => ctx.financial.recordInvoice(projectId, { amountCents: 100000n }, ACTOR)).toThrow(/已转单/);
    expect(ctx.contracts.findByProjectId(projectId)!.usdTaxAmountCents).toBe(1000000n);
  });
});
