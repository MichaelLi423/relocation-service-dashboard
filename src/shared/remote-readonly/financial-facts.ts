import { ValidationError } from '../../domain/core/errors';
import { formatCents } from '../../domain/core/money';
import { assertExactCentsString } from './values';

/**
 * 待掉票金额纯适配器（tasks 1.4 缺失切片）。
 *
 * 口径镜像 project-financial-closure 领域正式规则与 mobile-readonly-workbench 的
 * 「待掉票金额指标仅由仍存在项目的有效财务事实计算」：
 * - 仅未取消（status !== 'cancelled'）项目贡献；其余主状态不因状态被排除
 *   （不以 pending_invoice 等状态筛选替代；entryAt 不参与过滤）。
 * - 关联合同 finalAmount 有值（null ≠ 0；0 为合法可计算值、贡献 0）才进入可计算集合；
 *   null/无关联合同/孤立合同 → 该项目排除（无法计算，不虚构）。
 * - 掉票仅计入该项目的未撤销（revoked=false）行；撤销行按领域 sumActiveInvoices 排除。
 * - 孤立 invoice（projectId 不在可计算项目集合）随 join 自然忽略。
 * - 项目贡献 = max(finalAmount − 累计有效掉票, 0)；合计为总待掉票金额。
 *
 * 输入完整性（前置、metadata-only，不回显标识值）：
 * - 项目 id / 合同 projectId / 掉票 id 各自必须唯一；重复 → 拒绝（避免重复计数）。
 * - 相同金额但 id 不同的多笔掉票是独立事实，照常累加（不发明金额去重）。
 *
 * 脏/畸形数据：
 * - 孤立合同/孤立掉票/已取消项目 = spec「孤立/脏财务事实」，排除（join 过滤），不拒绝；
 * - 参与计算事实的金额必须先通过严格精确两位小数校验再转 BigInt（禁止
 *   parseDecimalToCents 宽松 HALF_UP/trim/多余小数位），非法即 metadata-only 拒绝，
 *   不静默舍入；被排除事实（已撤销/孤立/已取消/无 final）的金额不解析，畸形也不报错。
 *
 * 复杂度：O(projects + contracts + invoices)（先建可计算项目集合与一次掉票按项目聚合）。
 *
 * 窄服务端内部输入类型：不扩展业务 wire DTO，不发布 invoice 全量元数据。
 */

export interface ProjectFact {
  readonly id: string;
  /** 领域主状态（含 cancelled）。 */
  readonly status: string;
}

export interface ContractFinalFact {
  readonly projectId: string;
  /** 最终可确认金额：严格两位小数字符串或 null（未录入）。 */
  readonly finalAmount: string | null;
}

export interface InvoiceFact {
  readonly id: string;
  readonly projectId: string;
  /** 掉票金额：严格两位小数字符串。 */
  readonly amount: string;
  /** 已撤销（撤销后为终态，不计入有效掉票）。 */
  readonly revoked: boolean;
}

export interface PendingAmountFactsInput {
  readonly projects: readonly ProjectFact[];
  readonly contracts: readonly ContractFinalFact[];
  readonly invoices: readonly InvoiceFact[];
}

export interface PendingAmountResult {
  /** 精确两位小数字符串（"5000.00"；无贡献项目时为 "0.00"）。 */
  readonly pendingAmount: string;
  /** 分整数合计（≥ 0）。 */
  readonly cents: bigint;
  /** 实际纳入计算的项目数（可计算余额或 0 余额均计入）。 */
  readonly contributingProjectCount: number;
}

function duplicate(code: string): ValidationError {
  return new ValidationError(code, '输入事实标识重复'); // 不回显具体标识
}

/** 严格两位小数字符串 → 分（先 assertExactCentsString，无舍入/trim）。 */
function exactToCents(amount: string, field: string): bigint {
  assertExactCentsString(amount, field); // metadata-only；非法即抛
  const [intPart, fracPart] = amount.split('.');
  return BigInt(intPart) * 100n + BigInt(fracPart);
}

/**
 * 经真实关联 join/过滤计算待掉票金额总额。
 * 前置唯一性校验 → 建立「仍存在、未取消、有 final」的可计算项目集合 →
 * 单趟按项目聚合有效掉票 → 逐项目求 max(final−active, 0) 合计。
 */
export function computePendingAmount(input: PendingAmountFactsInput): PendingAmountResult {
  // 1) 唯一性（项目/合同/掉票标识全局唯一，防重复计数）。
  const projectIds = new Set<string>();
  for (const project of input.projects) {
    if (projectIds.has(project.id)) throw duplicate('DUPLICATE_PROJECT_ID');
    projectIds.add(project.id);
  }
  const contractProjectIds = new Set<string>();
  for (const contract of input.contracts) {
    if (contractProjectIds.has(contract.projectId)) throw duplicate('DUPLICATE_CONTRACT_PROJECT_ID');
    contractProjectIds.add(contract.projectId);
  }
  const invoiceIds = new Set<string>();
  for (const invoice of input.invoices) {
    if (invoiceIds.has(invoice.id)) throw duplicate('DUPLICATE_INVOICE_ID');
    invoiceIds.add(invoice.id);
  }

  // 2) 可计算项目集合：仍存在、未取消、关联合同 finalAmount 有值（null ≠ 0）。
  const finalByProject = new Map<string, string>();
  for (const contract of input.contracts) {
    finalByProject.set(contract.projectId, contract.finalAmount ?? '');
  }
  const computable = new Set<string>();
  for (const project of input.projects) {
    if (project.status === 'cancelled') continue; // spec：排除已取消
    const finalRaw = finalByProject.get(project.id);
    if (finalRaw === undefined || finalRaw === '') continue; // 无关联/孤立/未录入 → 排除
    computable.add(project.id);
  }

  // 3) 单趟掉票聚合：仅累加「可计算项目 + 未撤销」的有效事实；其余金额不解析。
  const activeSumByProject = new Map<string, bigint>();
  for (const invoice of input.invoices) {
    if (invoice.revoked || !computable.has(invoice.projectId)) continue;
    const cents = exactToCents(invoice.amount, 'invoice.amount');
    activeSumByProject.set(invoice.projectId, (activeSumByProject.get(invoice.projectId) ?? 0n) + cents);
  }

  // 4) 逐可计算项目求贡献（0 final 合法：贡献 0；仍计入可计算项目数）。
  let total = 0n;
  for (const projectId of computable) {
    const finalCents = exactToCents(finalByProject.get(projectId)!, 'finalAmount');
    const active = activeSumByProject.get(projectId) ?? 0n;
    const balance = finalCents - active;
    if (balance > 0n) total += balance;
  }
  return {
    pendingAmount: formatCents(total),
    cents: total,
    contributingProjectCount: computable.size,
  };
}
