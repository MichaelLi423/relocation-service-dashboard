/**
 * 项目主状态（tasks 1.8 / design D4）。
 *
 * 主状态依次为：待进单、待执行、执行中、维修中、待验收、待掉票、已完成；
 * 终止项目标记为已取消或已转单。状态转换/校验入口由本能力（relocation-project-lifecycle）
 * 唯一拥有，其他模块（todos / reporting / interface / financial）只消费校验结果，
 * 不维护状态副本。
 *
 * 维修中（under_repair）为人工维护的旁路主状态：仅由负责人人工选择进入/离开，
 * 不参与任何自动触发（计划上门到期/实际装机完成/验收报告/金额闭环均不自动进入或离开）。
 *
 * 终态（已取消 cancelled、已转单 transferred）：不可自动覆盖，人工进入后不可再离开；
 * 事实重算/历史导入等自动路径不得将其改出终态。
 */

export const PROJECT_STATUSES = [
  'pending_entry', // 待进单
  'pending_execution', // 待执行
  'executing', // 执行中
  'under_repair', // 维修中（仅人工进入/离开）
  'pending_acceptance', // 待验收
  'pending_invoice', // 待掉票
  'completed', // 已完成
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 终止状态：已取消（不可恢复，继续工作需重新新增项目）。 */
export const CANCELLED_STATUS = 'cancelled' as const;

/** 终止状态：已转单（终态，转单后不再自动推进，人工进入后不可再离开）。 */
export const TRANSFERRED_STATUS = 'transferred' as const;

/** 不可自动覆盖的终态集合（与领域真源一致）。 */
export const TERMINAL_STATUSES = [CANCELLED_STATUS, TRANSFERRED_STATUS] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export type ProjectStatusOrCancelled = ProjectStatus | TerminalStatus;

export const ALL_STATUSES: readonly ProjectStatusOrCancelled[] = [
  ...PROJECT_STATUSES,
  ...TERMINAL_STATUSES,
];

/** 未进单先执行：独立标签，与主状态并存；存在该标签时主状态保持待进单。 */
export interface PreEntryExecutionLabel {
  approved: boolean;
  reason: string | null;
  missingItems: string | null;
}

/** 状态显示名（语义展示用，不涉及视觉样式）。 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatusOrCancelled, string> = {
  pending_entry: '待进单',
  pending_execution: '待执行',
  executing: '执行中',
  under_repair: '维修中',
  pending_acceptance: '待验收',
  pending_invoice: '待掉票',
  completed: '已完成',
  cancelled: '已取消',
  transferred: '已转单',
};

export function isCancelled(status: ProjectStatusOrCancelled): boolean {
  return status === CANCELLED_STATUS;
}

export function isTransferred(status: ProjectStatusOrCancelled): boolean {
  return status === TRANSFERRED_STATUS;
}

/** 终态（已取消/已转单）：不可自动覆盖，人工进入后不可再离开。 */
export function isTerminal(status: ProjectStatusOrCancelled): status is TerminalStatus {
  return isCancelled(status) || isTransferred(status);
}

export function isLegalStatus(status: string): status is ProjectStatusOrCancelled {
  return (ALL_STATUSES as readonly string[]).includes(status);
}
