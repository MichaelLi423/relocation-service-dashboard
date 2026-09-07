import { ValidationError } from '../../domain/core/errors';
import type { SourceFingerprint, SourceFingerprintInput } from './fingerprint';
import { buildSourceFingerprint, sameSourceFingerprint } from './fingerprint';
import { assertIsoDateTime } from '../../shared/remote-readonly/values';

/**
 * 源报告状态机（tasks 5.2~5.4 纯状态机部分）。
 *
 * 全部转移为确定性纯函数：显式传入持久化状态值 + 注入的随机挑战 token +
 * 可信 now/clock-health 输入，返回新状态。本模块不建立 HTTP/memoryMap 伪持久化，
 * 不自行生成随机数，不承诺生产熵；调用方必须自行「读状态→校验→消费/写回」在单一
 * 事务/原子步骤内完成，本模块不做持久化、不承诺重启后挑战不可重放。
 *
 * 关键语义：
 * - 挑战一次性、60s 有效（截止：now >= expiresAt 即拒绝），绑定
 *   publisherId/authorizationEpoch/lineage/activationId/snapshotId；
 * - 有效源报告更新 lastSourceSeenAt；仅当报告指纹 == 当前快照指纹才更新
 *   sourceConfirmedAt；generatedAt/lastPublishedAt 只由 activateSnapshot 写入；
 * - 报告指纹 lineage 必须等于已授权 binding/activation 的 lineage，否则拒绝——
 *   新 contentGenerationId（新代际）不是「变化的指纹」，需显式 lineage 确认；
 * - paused/awaiting_lineage/publish_failed 是独立 blocker，可独立于快照存在，
 *   心跳/报告不清除；no_snapshot 只是可用性派生，不是 blocker；
 * - 确认模型：activateSnapshot 后 sourceConfirmedAt=null（新快照未确认），直到
 *   与当前指纹匹配的 fresh 报告到达；期间 evaluate 不可能是 confirmed_current；
 * - 时钟闸门默认不健康；不健康/外部显著跳变（flagClockUnhealthy）会使全部既有
 *   挑战失效并置 clockReviewRequired，resync（healthy 输入）本身不能恢复，必须
 *   经显式 resolveClockAfterReview；now 早于 issuedAt 视为时钟故障拒绝并要求 review；
 * - 阈值文档（spec 措辞）：5 分钟为「观察到待更新超过 5 分钟 SHALL 显示延迟」
 *   → 延迟判定用严格 `> 5min`；10 分钟为「10 分钟没有有效报告 SHALL 显示源不可用」
 *   → 不可用判定用 `>= 10min`。二者阈值语义不同，故不作符号统一。
 *
 * 类型说明：activationId 对齐共享 wire 信封（RemoteEnvelope.activationId: string，
 * 另一 lane 正在统一为 string）；authorizationEpoch 沿用 publication-control 内部
 * number 类型（已选定内部类型），在此保持 number 并记录。
 */

export const CHALLENGE_TTL_MS = 60_000;
/** 待更新延迟阈值：判定延迟用严格 > 5min（spec「超过 5 分钟」）。 */
export const OBSERVED_LAG_THRESHOLD_MS = 5 * 60_000;
/** 无有效报告不可用阈值：判定不可用用 >= 10min（spec「10 分钟没有有效报告」）。 */
export const SOURCE_UNAVAILABLE_MS = 10 * 60_000;
/** 挑战 token 长度界（注入的随机 token；本模块不自行产生熵）。 */
export const CHALLENGE_TOKEN_MIN_LENGTH = 8;
export const CHALLENGE_TOKEN_MAX_LENGTH = 256;

/** 审计/技术 ISO 时间（带偏移；实存校验复用 shared values.assertIsoDateTime）。 */
export type IsoInstant = string;

export interface PublisherBinding {
  readonly publisherId: string;
  /** 发布授权顺序（沿用 publication-control 内部 number 类型）。 */
  readonly authorizationEpoch: number;
}

export interface ActivationContext {
  readonly snapshotId: string;
  /** 对齐共享 wire 信封：activationId 为 string。 */
  readonly activationId: string;
  readonly databaseInstanceId: string;
  readonly contentGenerationId: string;
}

export type FreshnessBlocker = 'paused' | 'awaiting_lineage' | 'publish_failed' | 'none';

/** 持久化状态值（调用方存储；本模块只读它并返回新值）。 */
export interface SourceFreshnessState {
  readonly binding: PublisherBinding;
  readonly activation: ActivationContext | null;
  /** 当前激活快照的源指纹；null = 无快照。 */
  readonly currentFingerprint: SourceFingerprint | null;
  readonly generatedAt: IsoInstant | null;
  readonly lastPublishedAt: IsoInstant | null;
  readonly lastSourceSeenAt: IsoInstant | null;
  /** 最近一次「指纹 == 当时当前快照」的报告时间；activateSnapshot 时置 null（新快照未确认）。 */
  readonly sourceConfirmedAt: IsoInstant | null;
  /** 观察到指纹变化（与当前快照不一致）的最早时间；null=无待更新。 */
  readonly pendingChangeObservedAt: IsoInstant | null;
  /** 独立 blocker（与快照可用性无关）。 */
  readonly blocker: FreshnessBlocker;
  readonly activeChallenge: {
    readonly challengeId: string;
    readonly issuedAt: IsoInstant;
    readonly expiresAt: IsoInstant;
    readonly binding: PublisherBinding;
    readonly activation: ActivationContext;
  } | null;
  /** 时钟曾被判定不健康/显著跳变；必须显式 review 清除，resync 不足够。 */
  readonly clockReviewRequired: boolean;
}

export interface ClockHealthInput {
  readonly healthy: boolean;
  readonly nowIso: IsoInstant;
}

export interface ChallengeIssueInput {
  /** 调用方注入的有界随机 token（如 crypto.randomUUID()）。 */
  readonly challengeId: string;
}

export interface SourceFreshnessReport {
  readonly challengeId: string;
  readonly fingerprint: SourceFingerprintInput;
}

export type SourceReportResult =
  | { readonly accepted: true; readonly state: SourceFreshnessState; readonly confirmed: boolean }
  | {
      readonly accepted: false;
      readonly state: SourceFreshnessState;
      readonly code:
        | 'CHALLENGE_UNKNOWN'
        | 'CHALLENGE_EXPIRED'
        | 'CLOCK_UNHEALTHY'
        | 'CHALLENGE_BINDING_MISMATCH'
        | 'LINEAGE_MISMATCH'
        | 'INVALID_FINGERPRINT';
    };

export type FreshnessKind =
  | 'no_snapshot'
  | 'unconfirmed'
  | 'updating'
  | 'updating_lag'
  | 'source_unavailable'
  | 'confirmed_current';

export interface FreshnessEvaluation {
  readonly hasSnapshot: boolean;
  /** 独立 blocker（与可用性分开；不再因无快照被改写）。 */
  readonly blocker: FreshnessBlocker;
  readonly clockHealthy: boolean;
  readonly clockReviewRequired: boolean;
  readonly freshness: FreshnessKind;
  /** 满足全部条件才允许把新鲜度表述为健康：有快照、无 blocker、时钟可信且已 review、当前快照已获匹配确认。 */
  readonly canClaimSourceHealthy: boolean;
}

/** 时钟/挑战相关错误使用固定中文模板，不携带调用方输入（含 token）。 */
function invalid(code: string): ValidationError {
  return new ValidationError(code, '操作不合法');
}

function toValidIso(value: IsoInstant, field: string): IsoInstant {
  try {
    return assertIsoDateTime(value, field);
  } catch {
    throw new ValidationError('INVALID_INSTANT', `${field} 不是真实存在的带偏移 ISO 时间`);
  }
}

function ms(iso: IsoInstant): number {
  return Date.parse(iso);
}

function addMs(iso: IsoInstant, delta: number): IsoInstant {
  return new Date(ms(iso) + delta).toISOString();
}

function assertToken(challengeId: string): void {
  if (
    typeof challengeId !== 'string' ||
    challengeId.length < CHALLENGE_TOKEN_MIN_LENGTH ||
    challengeId.length > CHALLENGE_TOKEN_MAX_LENGTH
  ) {
    throw invalid('INVALID_CHALLENGE'); // 通用错误，不回显 token
  }
}

/** 初始状态：未激活任何快照、无 blocker、无挑战、时钟默认不健康（需显式 review）。 */
export function initialState(binding: PublisherBinding): SourceFreshnessState {
  return {
    binding,
    activation: null,
    currentFingerprint: null,
    generatedAt: null,
    lastPublishedAt: null,
    lastSourceSeenAt: null,
    sourceConfirmedAt: null,
    pendingChangeObservedAt: null,
    blocker: 'none',
    activeChallenge: null,
    clockReviewRequired: true,
  };
}

/**
 * 激活快照（发布/激活/回滚路径；与心跳无关）。写入 generatedAt/lastPublishedAt，
 * 使 sourceConfirmedAt=null（新快照未确认）并清空待更新与挑战。
 * lastSourceSeenAt 保留（旧报告仍是真实观察），但不再足以让新快照被当作已确认。
 */
export function activateSnapshot(
  state: SourceFreshnessState,
  activation: ActivationContext,
  fingerprint: SourceFingerprint,
  generatedAt: IsoInstant,
  lastPublishedAt: IsoInstant,
): SourceFreshnessState {
  toValidIso(generatedAt, 'generatedAt');
  toValidIso(lastPublishedAt, 'lastPublishedAt');
  return {
    ...state,
    activation,
    currentFingerprint: fingerprint,
    generatedAt,
    lastPublishedAt,
    sourceConfirmedAt: null,
    pendingChangeObservedAt: null,
    activeChallenge: null,
  };
}

/** 设置/清除独立 blocker；允许与快照存在性无关（控制面转移，心跳不触碰）。 */
export function withBlocker(state: SourceFreshnessState, blocker: FreshnessBlocker): SourceFreshnessState {
  return { ...state, blocker };
}

/**
 * 签发一次性挑战：要求时钟可信（healthy 且已 review）；替换既有挑战并使其失效，
 * 绑定当前 binding+activation。token 只做有界/类型校验（注入的随机值），
 * 不做生产熵承诺。
 */
export function issueSourceChallenge(
  state: SourceFreshnessState,
  clock: ClockHealthInput,
  input: ChallengeIssueInput,
): SourceFreshnessState {
  assertToken(input.challengeId);
  const nowIso = toValidIso(clock.nowIso, 'nowIso');
  if (!clock.healthy || state.clockReviewRequired) {
    throw invalid('CLOCK_UNHEALTHY');
  }
  const activation = state.activation;
  if (activation === null) {
    throw new ValidationError('NO_SNAPSHOT', '未激活快照不能签发挑战');
  }
  return {
    ...state,
    activeChallenge: {
      challengeId: input.challengeId,
      issuedAt: nowIso,
      expiresAt: addMs(nowIso, CHALLENGE_TTL_MS),
      binding: state.binding,
      activation,
    },
  };
}

/**
 * 时钟被外部判定不健康/显著跳变：使全部既有挑战失效并置需 review（本模块不自选阈值）。
 */
export function flagClockUnhealthy(state: SourceFreshnessState): SourceFreshnessState {
  return { ...state, clockReviewRequired: true, activeChallenge: null };
}

/** 显式 review 后清除标记并作废此前挑战（旧挑战可能在时钟异常期间签发）；resync 不足够。 */
export function resolveClockAfterReview(state: SourceFreshnessState): SourceFreshnessState {
  return { ...state, clockReviewRequired: false, activeChallenge: null };
}

/**
 * 接受源报告。校验顺序（任一失败即拒绝，metadata-only）：
 * 1) 呈现的 challengeId == 当前活动挑战 → 否则 CHALLENGE_UNKNOWN（不消费）；
 * 2) 时钟必须 healthy 且已 review；否则 CLOCK_UNHEALTHY，且「命中当前挑战即消费」
 *    ——本路径也消费所呈现的挑战；若 now 早于 issuedAt 视为时钟故障，同 CLOCK_UNHEALTHY
 *    （避免负年龄被当作健康），并要求 review；
 * 3) 挑战未过期：now >= expiresAt → CHALLENGE_EXPIRED（60s deadline 截止即拒，消费）；
 * 4) 指纹可解析 → INVALID_FINGERPRINT（消费，无业务值入消息）；
 * 5) 报告指纹 lineage 必须等于已授权 binding/activation 的 lineage（数据库实例与
 *    contentGenerationId）→ 否则 LINEAGE_MISMATCH（消费，绝不让任意新代际被当作
 *    「变化的指纹」从而污染 lastSourceSeenAt）；
 * 6) 活动挑战的 binding/activation == 状态当前值 → CHALLENGE_BINDING_MISMATCH（消费）。
 *
 * 命中当前挑战即一次性消费。接受成功后才更新 lastSourceSeenAt；指纹 == 当前快照 →
 * sourceConfirmedAt=now、confirmed=true；否则记最早 pendingChangeObservedAt、confirmed=false。
 * 绝不改写 generatedAt/lastPublishedAt；不接受排队心跳（每 60s 新挑战）。
 */
export function acceptSourceReport(
  state: SourceFreshnessState,
  clock: ClockHealthInput,
  report: SourceFreshnessReport,
): SourceReportResult {
  const active = state.activeChallenge;
  if (active === null || report.challengeId !== active.challengeId) {
    return { accepted: false, state, code: 'CHALLENGE_UNKNOWN' };
  }
  const consumed: SourceFreshnessState = { ...state, activeChallenge: null };
  const now = toValidIso(clock.nowIso, 'nowIso');
  const nowMs = ms(now);
  if (!clock.healthy || state.clockReviewRequired) {
    return { accepted: false, state: flagClockUnhealthy(consumed), code: 'CLOCK_UNHEALTHY' };
  }
  if (nowMs < ms(active.issuedAt)) {
    // now 早于签发时刻 → 时钟故障，拒绝并要求 review，避免负年龄被当作健康。
    return { accepted: false, state: flagClockUnhealthy(consumed), code: 'CLOCK_UNHEALTHY' };
  }
  if (nowMs >= ms(active.expiresAt)) {
    return { accepted: false, state: consumed, code: 'CHALLENGE_EXPIRED' };
  }
  let fingerprint: SourceFingerprint;
  try {
    fingerprint = buildSourceFingerprint(report.fingerprint);
  } catch {
    return { accepted: false, state: consumed, code: 'INVALID_FINGERPRINT' };
  }
  const activation = state.activation;
  const lineageMatches =
    activation !== null &&
    fingerprint.lineage.databaseInstanceId === activation.databaseInstanceId &&
    fingerprint.lineage.contentGenerationId === activation.contentGenerationId;
  if (!lineageMatches) {
    return { accepted: false, state: consumed, code: 'LINEAGE_MISMATCH' };
  }
  const bindingMatch =
    active.binding.publisherId === state.binding.publisherId &&
    active.binding.authorizationEpoch === state.binding.authorizationEpoch &&
    activation !== null &&
    active.activation.activationId === activation.activationId &&
    active.activation.snapshotId === activation.snapshotId &&
    active.activation.databaseInstanceId === activation.databaseInstanceId &&
    active.activation.contentGenerationId === activation.contentGenerationId;
  if (!bindingMatch) {
    return { accepted: false, state: consumed, code: 'CHALLENGE_BINDING_MISMATCH' };
  }
  const current = state.currentFingerprint;
  const matches = current !== null && sameSourceFingerprint(current, fingerprint);
  if (matches) {
    return {
      accepted: true,
      confirmed: true,
      state: { ...consumed, lastSourceSeenAt: now, sourceConfirmedAt: now, pendingChangeObservedAt: null },
    };
  }
  return {
    accepted: true,
    confirmed: false,
    state: {
      ...consumed,
      lastSourceSeenAt: now,
      pendingChangeObservedAt: consumed.pendingChangeObservedAt ?? now,
    },
  };
}

/**
 * 派生展示状态（纯读，不改状态——普通状态读取/GET 不更新来源健康）。
 *
 * 确认要求：当前快照必须已获「指纹匹配」报告（sourceConfirmedAt != null 且无待更新）
 * 才算 confirmed_current；新激活未确认 → unconfirmed。从未有过源报告时，以
 * lastPublishedAt（激活发布基线）为起点，超过 10 分钟仍未收到任何有效报告 →
 * source_unavailable（不是永远 no_source_report）。
 * blocker 独立返回，不因无快照被改写为 no_snapshot。
 */
export function evaluateSourceFreshness(
  state: SourceFreshnessState,
  clock: ClockHealthInput,
): FreshnessEvaluation {
  toValidIso(clock.nowIso, 'nowIso');
  const hasSnapshot = state.activation !== null && state.currentFingerprint !== null;
  const clockHealthy = clock.healthy && !state.clockReviewRequired;
  const nowMs = ms(clock.nowIso);

  let freshness: FreshnessKind;
  if (!hasSnapshot) {
    freshness = 'no_snapshot';
  } else if (state.lastSourceSeenAt === null) {
    const baseline = state.lastPublishedAt ?? state.generatedAt;
    if (baseline === null || nowMs - ms(baseline) >= SOURCE_UNAVAILABLE_MS) {
      freshness = 'source_unavailable';
    } else {
      freshness = 'unconfirmed';
    }
  } else if (nowMs - ms(state.lastSourceSeenAt) >= SOURCE_UNAVAILABLE_MS) {
    freshness = 'source_unavailable';
  } else if (state.pendingChangeObservedAt !== null) {
    freshness =
      nowMs - ms(state.pendingChangeObservedAt) > OBSERVED_LAG_THRESHOLD_MS ? 'updating_lag' : 'updating';
  } else if (state.sourceConfirmedAt === null) {
    // 新激活后尚无匹配报告：即使 lastSourceSeenAt 有旧值也不算已确认。
    freshness = 'unconfirmed';
  } else {
    freshness = 'confirmed_current';
  }

  const canClaimSourceHealthy =
    hasSnapshot &&
    state.blocker === 'none' &&
    clockHealthy &&
    freshness === 'confirmed_current';
  return {
    hasSnapshot,
    blocker: state.blocker,
    clockHealthy,
    clockReviewRequired: state.clockReviewRequired,
    freshness,
    canClaimSourceHealthy,
  };
}

/**
 * 窄时钟可信闸门：供后续 auth lane 的 TOTP/recent-MFA 时间依赖判定接入。
 * 仅导出判定与状态转移，不在本模块内做任何 TOTP/MFA 集成。
 */
export function clockTrusted(clockHealthy: boolean, clockReviewRequired: boolean): boolean {
  return clockHealthy && !clockReviewRequired;
}
