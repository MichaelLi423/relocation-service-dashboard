/**
 * 远程只读发布：一致快照待掉票金额读取（tasks 2.2 snapshot-finance 切片）。
 *
 * - main-only 同步函数：入参为 snapshot-source 在线备份后只读打开的快照连接（回调期间有效）。
 *   不创建快照、不查活源库、不读 metadata、不上网、无业务写入。
 * - 不重复领域平衡计算：固定 SQL 只表达「项目资格 join」（合同须属仍存在未取消项目；
 *   掉票须属仍存在未取消、且合同 final 非空的项目，且未撤销），不含 final−active 平衡或
 *   合计公式；余额计算交由 shared financial-facts 的权威 computePendingAmount 裁决。
 *   entry_at 从不参与资格过滤。
 * - 排除先于数值转换：孤儿/已取消/无 final/已撤销的整行在 SQL JOIN 中被排除，其畸形金额
 *   （REAL/文本）绝不会进入 centsString 或严格 parse。null 与 0 语义不同（null 排除、
 *   0 合法零贡献）；参与行金额必须为原生 INTEGER（BigInt），经 formatCents 精确转两位
 *   小数字符串，畸形参与行仍 metadata-only 拒绝。
 * - 失败 metadata-only：DB 读取失败/异常类型抛稳定 code SnapshotFinanceError（不回显
 *   SQL/路径/值）；computePendingAmount 的严格金额拒绝原样上抛（消息同样不带值）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { prepareReadBigInt } from '../../domain/capabilities/local-data-persistence/connection';
import { DomainError } from '../../domain/core/errors';
import { formatCents } from '../../domain/core/money';
import {
  computePendingAmount,
  type PendingAmountFactsInput,
  type PendingAmountResult,
} from '../../shared/remote-readonly/financial-facts';

export const SNAPSHOT_FINANCE_ERROR_CODES = {
  /** DB 读取失败、标识列缺失或金额列不是原生 INTEGER/BigInt（REAL/文本异常不静默强转）。 */
  SNAPSHOT_FINANCE_READ_FAILED: 'SNAPSHOT_FINANCE_READ_FAILED',
} as const;
export type SnapshotFinanceErrorCode =
  (typeof SNAPSHOT_FINANCE_ERROR_CODES)[keyof typeof SNAPSHOT_FINANCE_ERROR_CODES];

/** metadata-only 快照财务读取错误：message 只含稳定 code。 */
export class SnapshotFinanceError extends DomainError {
  constructor(code: SnapshotFinanceErrorCode) {
    super(code, `snapshot finance ${code}`);
    this.name = 'SnapshotFinanceError';
  }
}

function financeError(): SnapshotFinanceError {
  return new SnapshotFinanceError('SNAPSHOT_FINANCE_READ_FAILED');
}

/** 快照只读查询（setReadBigInts 原生 BigInt）；失败 → metadata-only。 */
function allRows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  try {
    return prepareReadBigInt(db, sql).all() as Record<string, unknown>[];
  } catch {
    throw financeError();
  }
}

/** 严格标识/状态文本：缺失、非 string 或空 → metadata-only（不做 String() 强转）。 */
function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw financeError();
  return value;
}

/** 原生 INTEGER 分 → 精确两位小数字符串（仅 bigint；异常类型拒绝，不静默强转）。 */
function centsString(value: unknown): string {
  if (typeof value !== 'bigint') throw financeError();
  return formatCents(value);
}

/** 可空 INTEGER 分：null → null（不可计算 ≠ 0）；有值必须原生 bigint。 */
function nullableCentsString(value: unknown): string | null {
  return value === null ? null : centsString(value);
}

/**
 * 从一致只读快照计算待掉票金额总额。
 * 资格排除在固定 SQL JOIN 内先于数值转换完成（不含平衡/合计公式），随后把仍属参与集
 * 的事实交给 computePendingAmount 完成领域余额计算。
 */
export function readSnapshotPendingAmount(readonlySnapshotDb: DatabaseSync): PendingAmountResult {
  const projects = allRows(readonlySnapshotDb, 'SELECT id, status FROM projects');
  // 仅仍存在且未取消项目的合同（孤儿/已取消项目的 final 值不进入解析）。
  const contracts = allRows(
    readonlySnapshotDb,
    `SELECT c.project_id, c.final_confirmable_amount_cents
       FROM contracts c
       JOIN projects p ON p.id = c.project_id
      WHERE p.status <> 'cancelled'`,
  );
  // 仅仍存在、未取消、且合同 final 非空项目的未撤销掉票（其余行畸形金额不进入解析）。
  const invoices = allRows(
    readonlySnapshotDb,
    `SELECT i.id, i.project_id, i.amount_cents
       FROM invoices i
       JOIN projects p ON p.id = i.project_id
       JOIN contracts c ON c.project_id = p.id
      WHERE p.status <> 'cancelled'
        AND c.final_confirmable_amount_cents IS NOT NULL
        AND i.revoked_at IS NULL`,
  );

  const facts: PendingAmountFactsInput = {
    projects: projects.map((row) => ({
      id: requiredText(row.id),
      status: requiredText(row.status),
    })),
    contracts: contracts.map((row) => ({
      projectId: requiredText(row.project_id),
      finalAmount: nullableCentsString(row.final_confirmable_amount_cents),
    })),
    invoices: invoices.map((row) => ({
      id: requiredText(row.id),
      projectId: requiredText(row.project_id),
      amount: centsString(row.amount_cents),
      revoked: false, // SQL 已限定 revoked_at IS NULL
    })),
  };
  return computePendingAmount(facts);
}
