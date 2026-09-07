/**
 * 远程只读发布：知情同意门与规范持久化状态模型（tasks 2.1 main gate）。
 *
 * 本模块定义 store-next 将要持久化的「规范 PersistedControlState」，并提供纯转换
 * （configure/invalidate/confirm/localStop）与主进程门控。control-store lane 持有真实
 * 存储实现；本模块不重复任何持久化/队列，只暴露模型 API（invalidation 等），
 * store 后续迁移到 parsePersistedControlState 即可，本模块不含真实 DB/vault/network。
 *
 * 模型要点：
 * - PersistedControlState = { state, revision, descriptor, binding, consent }，没有
 *   并行的 enabled 布尔；state 即权威（'disabled' | 'enabled' | 'localStopped'）。
 * - descriptor/binding 是「当前配置的目标与绑定」（负责人选定并确认的 target/白名单/
 *   保留说明版本 + 发布者绑定/谱系）；consent 是对该精确 descriptor+binding 的知情
 *   确认（三项确认必须字面 === true），只在匹配时存在。
 * - configure/invalidate：只要 descriptor OR binding 变化（即使 A→B→A 又回到 A，
 *   相对于上一个持久化值仍算变化）就 revision+1 并清空 consent；清空队列由 store
 *   owner 后续处理。disabled/localStopped 永不因存量 consent 自动恢复 enabled。
 * - 严格运行时解析：所有对象 allowlist，无「secret 黑名单」——未知键（含任何
 *   token/password/secret 命名）一律由 allowlist 拒绝，metadata-only，不重复维护黑名单。
 * - projectionVersion 必须等于已知常量（非 null）；fieldScopeDigest 必须是 64 位
 *   小写十六进制且等于当前完整白名单的 hash；retentionExplanationVersion 必须是本
 *   模块导出的单一固定常量（不接受任意字符串）；lineage 为 UUID；publisherId 等技术
 *   ID 有界（≤128）；authorizationEpoch 安全整数。
 * - action 端口收到深拷贝并冻结的受控 context {descriptor, binding, controlRevision}；
 *   永远不调用无参 outbound；无 adapter 时返回 unconfigured 而非假成功。
 * - HTTPS target 只做 origin 语法校验，不声称已验证 TLS/信任链（无 network 信任声明）。
 */
import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/core/errors';
import { PROJECTION_VERSION } from '../../shared/remote-readonly/projection';
import {
  PROJECT_ALLOWED_FIELDS,
  COUNTS_ALLOWED_FIELDS,
  NON_BLOCKING_ALLOWED_FIELDS,
  DETAIL_ALLOWED_FIELDS,
  DETAIL_CONTRACT_ALLOWED_FIELDS,
  DETAIL_FACTS_ALLOWED_FIELDS,
  DETAIL_REMINDER_ALLOWED_FIELDS,
  DETAIL_FINANCE_ALLOWED_FIELDS,
  SECTION_ALLOWED_FIELDS,
  SECTION_COMMON_ALLOWED_FIELDS,
  type RemoteSectionKind,
} from '../../shared/remote-readonly/projection';

/** 当前同意的投影契约版本（与 remote-readonly projection 同源，唯一已知常量）。 */
export const CONSENT_PROJECTION_VERSION = PROJECTION_VERSION;

/**
 * 副本保留说明的单一主控版本常量。store/persist 只能携带此值；负责人确认当前保留
 * 说明即确认该版本（不接受任意字符串）。
 */
export const CONSENT_RETENTION_EXPLANATION_VERSION = 'retention-v1';

/** 技术 ID 长度上限（publisherId / 谱系外的技术标识 ≤128 Unicode 码点）。 */
export const MAX_CONSENT_TECHNICAL_ID_CHARS = 128;

/** UUID 谱系标识形状（databaseInstanceId / contentGenerationId）。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 完整已批准业务字段白名单的规范锚点（发布记录 detail 分组允许字段）。 */
export const PUBLICATION_FIELD_SCOPE = {
  project: [...PROJECT_ALLOWED_FIELDS],
  counts: [...COUNTS_ALLOWED_FIELDS],
  nonBlocking: [...NON_BLOCKING_ALLOWED_FIELDS],
  detail: [...DETAIL_ALLOWED_FIELDS],
  detailContract: [...DETAIL_CONTRACT_ALLOWED_FIELDS],
  detailFacts: [...DETAIL_FACTS_ALLOWED_FIELDS],
  detailReminder: [...DETAIL_REMINDER_ALLOWED_FIELDS],
  detailFinance: [...DETAIL_FINANCE_ALLOWED_FIELDS],
  sectionCommon: [...SECTION_COMMON_ALLOWED_FIELDS],
  sections: {
    batches: [...SECTION_ALLOWED_FIELDS.batches],
    instruments: [...SECTION_ALLOWED_FIELDS.instruments],
    orders: [...SECTION_ALLOWED_FIELDS.orders],
    invoices: [...SECTION_ALLOWED_FIELDS.invoices],
    damage_items: [...SECTION_ALLOWED_FIELDS.damage_items],
  },
} as const;

export type PublicationFieldScope = typeof PUBLICATION_FIELD_SCOPE;

/** 字段白名单摘要算法（sha256；决定 scope digest 语义）。 */
export const FIELD_SCOPE_DIGEST_ALGORITHM = 'sha256';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * 计算完整已批准字段白名单的规范摘要。字段组分组键排序拼接；仅字段变化改变摘要。
 */
export function fieldScopeDigest(scope: PublicationFieldScope = PUBLICATION_FIELD_SCOPE): string {
  const sectionGroups = (Object.keys(scope.sections) as RemoteSectionKind[])
    .sort()
    .map((k) => `${k}:${scope.sections[k].join(',')}`)
    .join(';');
  const projectGroups = [
    `project:${scope.project.join(',')}`,
    `counts:${scope.counts.join(',')}`,
    `nonBlocking:${scope.nonBlocking.join(',')}`,
    `detail:${scope.detail.join(',')}`,
    `detailContract:${scope.detailContract.join(',')}`,
    `detailFacts:${scope.detailFacts.join(',')}`,
    `detailReminder:${scope.detailReminder.join(',')}`,
    `detailFinance:${scope.detailFinance.join(',')}`,
    `sectionCommon:${scope.sectionCommon.join(',')}`,
  ].join(';');
  const canonical = `${sectionGroups}\n${projectGroups}\n`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 规范类型（store-next 将持久化该形状；无并行 enabled 布尔）
// ---------------------------------------------------------------------------

export type PersistedGateState = 'disabled' | 'enabled' | 'localStopped';

export const PERSISTED_GATE_STATES: readonly PersistedGateState[] = [
  'disabled',
  'enabled',
  'localStopped',
] as const;

/** 负责人已确认的 HTTPS target 与字段范围/保留说明（全部非 secret 元数据）。 */
export interface ConsentDescriptor {
  /** 已确认 HTTPS target origin（无 userinfo/query/fragment；仅语法，无 TLS 信任声明）。 */
  targetHttpsOrigin: string;
  /** 必须 === CONSENT_PROJECTION_VERSION。 */
  projectionVersion: string;
  /** 必须 === fieldScopeDigest()（当前完整白名单 hash，64 位小写 hex）。 */
  fieldScopeDigest: string;
  /** 必须 === CONSENT_RETENTION_EXPLANATION_VERSION（单一主控常量）。 */
  retentionExplanationVersion: string;
}

/** 发布者绑定/谱系（非 secret）。 */
export interface PublicationBinding {
  /** 发布者 ID（有界技术 ID）。 */
  publisherId: string;
  /** 授权代际（安全整数）。 */
  authorizationEpoch: number;
  /** 谱系 UUID（不排序）。 */
  databaseInstanceId: string;
  /** 谱系 UUID（不排序）。 */
  contentGenerationId: string;
}

/** 知情确认（必须字面 true 的三项布尔）。 */
export interface ConsentConfirmations {
  targetConfirmed: true;
  scopeConfirmed: true;
  retentionConfirmed: true;
}

/** consent = 精确 descriptor + binding + 三项确认（全 true）。 */
export interface FullPublicationConsent
  extends ConsentDescriptor,
    PublicationBinding,
    ConsentConfirmations {}

/** 规范持久化状态（无并行 enabled 布尔；state 权威）。 */
export interface PersistedControlState {
  state: PersistedGateState;
  /** 非负安全整数；每次 configure/invalidate/confirm/localStop 变化递增。 */
  revision: number;
  descriptor: ConsentDescriptor | null;
  binding: PublicationBinding | null;
  consent: FullPublicationConsent | null;
}

/** 受控 action context（深拷贝并冻结；门放行时交给 adapter）。 */
export interface PublicationActionContext {
  readonly descriptor: Readonly<ConsentDescriptor>;
  readonly binding: Readonly<PublicationBinding>;
  readonly controlRevision: number;
}

export type GateDenyReason =
  | 'not_enabled'
  | 'local_stopped'
  | 'consent_invalid'
  | 'unconfigured';

export interface ConsentGateDecision {
  allowed: boolean;
  reason: 'consent_ok' | GateDenyReason;
  state: PersistedGateState;
  context: PublicationActionContext | null;
}

export interface OutboundAdapterResult {
  ok: boolean;
  context: PublicationActionContext;
}

/** 外发/凭据 adapter：真实接线注入；测试注入 spy 观察 context。 */
export type OutboundAdapter = (context: PublicationActionContext) => OutboundAdapterResult;
export type CredentialAdapter = (context: PublicationActionContext) => OutboundAdapterResult;

/** 当前状态端口：接线方从 control-store 读取 raw 持久化状态。 */
export interface ControlStatePort {
  readCurrent: () => unknown;
}

/** 门错误（metadata-only；message 只含稳定 code，不携带字段值/未知键/secret）。 */
export class ConsentGateError extends DomainError {
  constructor(code: string) {
    super(code, `publication consent ${code}`);
    this.name = 'ConsentGateError';
  }
}

function metadataError(code: string): ConsentGateError {
  return new ConsentGateError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePlainObject(value: unknown, code: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw metadataError(code);
  return value;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw metadataError('CONSENT_UNKNOWN_FIELD');
  }
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== 'string' || value === '') throw metadataError(code);
  return value;
}

function requireSafeInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw metadataError(code);
  }
  return value;
}

/** 只接受字面 === true（false / 字符串 'false' / 0 / null / undefined 一律拒绝）。 */
function requireLiteralTrue(value: unknown, code: string): true {
  if (value !== true) throw metadataError(code);
  return true;
}

/** 校验 HTTPS target origin 语法（无 userinfo/path/query/fragment）。不验证 TLS 信任链。 */
export function validateConsentTarget(value: unknown): string {
  const raw = requireText(value, 'CONSENT_TARGET_INVALID');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw metadataError('CONSENT_TARGET_INVALID');
  }
  if (url.protocol !== 'https:') throw metadataError('CONSENT_TARGET_INVALID');
  if (url.username !== '' || url.password !== '') throw metadataError('CONSENT_TARGET_INVALID');
  const hasPath = url.pathname !== '' && url.pathname !== '/';
  const hasQuery = url.search !== '';
  const hasHash = url.hash !== '';
  if (hasPath || hasQuery || hasHash) throw metadataError('CONSENT_TARGET_INVALID');
  if (url.hostname === '') throw metadataError('CONSENT_TARGET_INVALID');
  return url.origin;
}

// ---------------------------------------------------------------------------
// 严格运行时解析（全部 allowlist；无 secret 黑名单——未知键即拒绝）
// ---------------------------------------------------------------------------

const DESCRIPTOR_KEYS: ReadonlySet<string> = new Set<string>([
  'targetHttpsOrigin',
  'projectionVersion',
  'fieldScopeDigest',
  'retentionExplanationVersion',
]);

const BINDING_KEYS: ReadonlySet<string> = new Set<string>([
  'publisherId',
  'authorizationEpoch',
  'databaseInstanceId',
  'contentGenerationId',
]);

const CONFIRMATION_KEYS: ReadonlySet<string> = new Set<string>([
  'targetConfirmed',
  'scopeConfirmed',
  'retentionConfirmed',
]);

const STATE_KEYS: ReadonlySet<string> = new Set<string>([
  'state',
  'revision',
  'descriptor',
  'binding',
  'consent',
]);

const CONSENT_KEYS: ReadonlySet<string> = new Set<string>([
  ...DESCRIPTOR_KEYS,
  ...BINDING_KEYS,
  ...CONFIRMATION_KEYS,
]);

/** 严格解析 ConsentDescriptor（未知/缺键 → 拒绝；值域严格）。 */
export function parseConsentDescriptor(input: unknown): ConsentDescriptor {
  const obj = requirePlainObject(input, 'CONSENT_INVALID');
  rejectUnknownKeys(obj, DESCRIPTOR_KEYS);
  const projectionVersion = requireText(obj['projectionVersion'], 'CONSENT_INVALID');
  if (projectionVersion !== CONSENT_PROJECTION_VERSION) {
    throw metadataError('CONSENT_PROJECTION_VERSION');
  }
  const fieldScopeDigestValue = requireText(obj['fieldScopeDigest'], 'CONSENT_INVALID');
  if (!SHA256_HEX_PATTERN.test(fieldScopeDigestValue)) throw metadataError('CONSENT_SCOPE_DIGEST_INVALID');
  if (fieldScopeDigestValue !== fieldScopeDigest()) throw metadataError('CONSENT_SCOPE_DIGEST_MISMATCH');
  const retention = requireText(obj['retentionExplanationVersion'], 'CONSENT_INVALID');
  if (retention !== CONSENT_RETENTION_EXPLANATION_VERSION) {
    throw metadataError('CONSENT_RETENTION_VERSION_INVALID');
  }
  return {
    targetHttpsOrigin: validateConsentTarget(obj['targetHttpsOrigin']),
    projectionVersion,
    fieldScopeDigest: fieldScopeDigestValue,
    retentionExplanationVersion: retention,
  };
}

/** 严格解析 PublicationBinding（UUID 谱系；ID 有界；epoch 安全整数）。 */
export function parsePublicationBinding(input: unknown): PublicationBinding {
  const obj = requirePlainObject(input, 'CONSENT_INVALID');
  rejectUnknownKeys(obj, BINDING_KEYS);
  const publisherId = requireText(obj['publisherId'], 'CONSENT_INVALID');
  if ([...publisherId].length > MAX_CONSENT_TECHNICAL_ID_CHARS) {
    throw metadataError('CONSENT_ID_TOO_LONG');
  }
  const databaseInstanceId = requireText(obj['databaseInstanceId'], 'CONSENT_INVALID');
  const contentGenerationId = requireText(obj['contentGenerationId'], 'CONSENT_INVALID');
  if (!UUID_PATTERN.test(databaseInstanceId)) throw metadataError('CONSENT_LINEAGE_INVALID');
  if (!UUID_PATTERN.test(contentGenerationId)) throw metadataError('CONSENT_LINEAGE_INVALID');
  return {
    publisherId,
    authorizationEpoch: requireSafeInt(obj['authorizationEpoch'], 'CONSENT_INVALID'),
    databaseInstanceId,
    contentGenerationId,
  };
}

/** 解析三项确认：值必须字面 === true（缺一即拒绝）。 */
export function parseConsentConfirmations(input: unknown): ConsentConfirmations {
  const obj = requirePlainObject(input, 'CONSENT_INVALID');
  rejectUnknownKeys(obj, CONFIRMATION_KEYS);
  return {
    targetConfirmed: requireLiteralTrue(obj['targetConfirmed'], 'CONSENT_CONFIRMATION_INVALID'),
    scopeConfirmed: requireLiteralTrue(obj['scopeConfirmed'], 'CONSENT_CONFIRMATION_INVALID'),
    retentionConfirmed: requireLiteralTrue(obj['retentionConfirmed'], 'CONSENT_CONFIRMATION_INVALID'),
  };
}

/** 由 descriptor+binding+确认构造 full consent（复制，不共享引用）。 */
export function buildFullConsent(
  descriptor: ConsentDescriptor,
  binding: PublicationBinding,
  confirmations: ConsentConfirmations,
): FullPublicationConsent {
  return {
    ...descriptor,
    ...binding,
    ...confirmations,
  };
}

function sameDescriptor(a: ConsentDescriptor | null, b: ConsentDescriptor | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.targetHttpsOrigin === b.targetHttpsOrigin &&
    a.projectionVersion === b.projectionVersion &&
    a.fieldScopeDigest === b.fieldScopeDigest &&
    a.retentionExplanationVersion === b.retentionExplanationVersion
  );
}

function sameBinding(a: PublicationBinding | null, b: PublicationBinding | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.publisherId === b.publisherId &&
    a.authorizationEpoch === b.authorizationEpoch &&
    a.databaseInstanceId === b.databaseInstanceId &&
    a.contentGenerationId === b.contentGenerationId
  );
}

/** consent 是否精确匹配给定 descriptor+binding（缺任一/值不同 → false）。 */
export function consentMatches(
  consent: FullPublicationConsent | null,
  descriptor: ConsentDescriptor | null,
  binding: PublicationBinding | null,
): boolean {
  if (consent === null || descriptor === null || binding === null) return false;
  return (
    consent.targetHttpsOrigin === descriptor.targetHttpsOrigin &&
    consent.projectionVersion === descriptor.projectionVersion &&
    consent.fieldScopeDigest === descriptor.fieldScopeDigest &&
    consent.retentionExplanationVersion === descriptor.retentionExplanationVersion &&
    consent.publisherId === binding.publisherId &&
    consent.authorizationEpoch === binding.authorizationEpoch &&
    consent.databaseInstanceId === binding.databaseInstanceId &&
    consent.contentGenerationId === binding.contentGenerationId &&
    consent.targetConfirmed === true &&
    consent.scopeConfirmed === true &&
    consent.retentionConfirmed === true
  );
}

/**
 * 严格解析整个 PersistedControlState。
 * - 顶层只允许 state/revision/descriptor/binding/consent（无并行 enabled 布尔）；
 * - consent 非 null 时必须精确等于 descriptor+binding+三项确认；
 * - state 与 consent 的结构不一致（如 enabled 却无 consent）此处不抛，
 *   由 deriveGateState 判定 fail closed（读端容忍，门端拒绝）。
 */
export function parsePersistedControlState(input: unknown): PersistedControlState {
  const obj = requirePlainObject(input, 'CONSENT_INVALID');
  rejectUnknownKeys(obj, STATE_KEYS);
  const state = requireText(obj['state'], 'CONSENT_INVALID');
  if (!(PERSISTED_GATE_STATES as readonly string[]).includes(state)) {
    throw metadataError('CONSENT_STATE_INVALID');
  }
  const descriptor =
    obj['descriptor'] === null || obj['descriptor'] === undefined
      ? null
      : parseConsentDescriptor(obj['descriptor']);
  const binding =
    obj['binding'] === null || obj['binding'] === undefined
      ? null
      : parsePublicationBinding(obj['binding']);
  const rawConsent = obj['consent'];
  let consent: FullPublicationConsent | null = null;
  if (rawConsent !== null && rawConsent !== undefined) {
    const consentObj = requirePlainObject(rawConsent, 'CONSENT_INVALID');
    rejectUnknownKeys(consentObj, CONSENT_KEYS);
    // 合成对象是 descriptor+binding+确认 的并集：先按各自键子集切分再分别严格解析。
    const descriptorPart: Record<string, unknown> = {};
    const bindingPart: Record<string, unknown> = {};
    const confirmationPart: Record<string, unknown> = {};
    for (const key of Object.keys(consentObj)) {
      if (DESCRIPTOR_KEYS.has(key)) descriptorPart[key] = consentObj[key];
      else if (BINDING_KEYS.has(key)) bindingPart[key] = consentObj[key];
      else confirmationPart[key] = consentObj[key];
    }
    const parsedConsent = buildFullConsent(
      parseConsentDescriptor(descriptorPart),
      parsePublicationBinding(bindingPart),
      parseConsentConfirmations(confirmationPart),
    );
    // 与 descriptor/binding 一致性（未知键已在上层拒绝）。
    if (!consentMatches(parsedConsent, descriptor, binding)) {
      throw metadataError('CONSENT_CONSENT_MISMATCH');
    }
    consent = parsedConsent;
  }
  return {
    state: state as PersistedGateState,
    revision: requireSafeInt(obj['revision'], 'CONSENT_INVALID'),
    descriptor,
    binding,
    consent,
  };
}

// ---------------------------------------------------------------------------
// 门状态派生与请求
// ---------------------------------------------------------------------------

/**
 * 状态派生（fail closed）：
 * - localStopped / disabled 永不因存量 consent 自动恢复 enabled；
 * - 只有显式 state==='enabled' 且存在与 descriptor+binding 精确匹配的完整 consent
 *   才返回 'enabled'；否则 disabled。
 */
export function deriveGateState(current: PersistedControlState): PersistedGateState {
  if (current.state === 'localStopped') return 'localStopped';
  if (current.state !== 'enabled') return 'disabled';
  if (current.descriptor === null || current.binding === null) return 'disabled';
  if (current.consent === null) return 'disabled';
  if (!consentMatches(current.consent, current.descriptor, current.binding)) return 'disabled';
  return 'enabled';
}

function parseOrNull(input: unknown): PersistedControlState | null {
  try {
    return parsePersistedControlState(input);
  } catch {
    return null; // 结构损坏 → 门端 fail closed（不假成功）
  }
}

/** 构造深拷贝并冻结的 action context。 */
export function buildActionContext(current: PersistedControlState): PublicationActionContext {
  const descriptor: ConsentDescriptor = { ...(current.descriptor as ConsentDescriptor) };
  const binding: PublicationBinding = { ...(current.binding as PublicationBinding) };
  const context: PublicationActionContext = {
    descriptor: Object.freeze(descriptor),
    binding: Object.freeze(binding),
    controlRevision: current.revision,
  };
  return Object.freeze(context);
}

/**
 * 请求外发发布：解析 raw（损坏 → fail closed）→ derive → 仅 enabled 才放行。
 * - 放行时把深拷贝冻结 context 交给 adapter（绝不调用无参 outbound）；
 * - 无 adapter（未接线真实发布引擎）→ 返回 unconfigured，不伪装成功。
 */
export function requestOutboundPublish(
  port: ControlStatePort,
  adapter?: OutboundAdapter,
): ConsentGateDecision {
  const raw = port.readCurrent();
  const parsed = parseOrNull(raw);
  if (parsed === null) {
    return { allowed: false, reason: 'consent_invalid', state: 'disabled', context: null };
  }
  const state = deriveGateState(parsed);
  if (state !== 'enabled') {
    const reason: GateDenyReason =
      state === 'localStopped'
        ? 'local_stopped'
        : parsed.state === 'enabled'
          ? 'consent_invalid'
          : 'not_enabled';
    return { allowed: false, reason, state, context: null };
  }
  const context = buildActionContext(parsed);
  if (!adapter) {
    return { allowed: false, reason: 'unconfigured', state: 'enabled', context };
  }
  const result = adapter(context);
  return {
    allowed: result.ok,
    reason: result.ok ? 'consent_ok' : 'unconfigured',
    state: 'enabled',
    context: result.context,
  };
}

/** 请求读取发布者凭据：与发布同门控（secret 查询不得绕过同意）。 */
export function requestCredentialLookup(
  port: ControlStatePort,
  adapter?: CredentialAdapter,
): ConsentGateDecision {
  const raw = port.readCurrent();
  const parsed = parseOrNull(raw);
  if (parsed === null) {
    return { allowed: false, reason: 'consent_invalid', state: 'disabled', context: null };
  }
  const state = deriveGateState(parsed);
  if (state !== 'enabled') {
    const reason: GateDenyReason =
      state === 'localStopped'
        ? 'local_stopped'
        : parsed.state === 'enabled'
          ? 'consent_invalid'
          : 'not_enabled';
    return { allowed: false, reason, state, context: null };
  }
  const context = buildActionContext(parsed);
  if (!adapter) {
    return { allowed: false, reason: 'unconfigured', state: 'enabled', context };
  }
  const result = adapter(context);
  return {
    allowed: result.ok,
    reason: result.ok ? 'consent_ok' : 'unconfigured',
    state: 'enabled',
    context: result.context,
  };
}

// ---------------------------------------------------------------------------
// 纯转换（store-next 用；队列清除属 store owner，此处只更新模型）
// ---------------------------------------------------------------------------

/** 初始（从未配置）：disabled + revision 0，全 null。 */
export function initialControlState(): PersistedControlState {
  return {
    state: 'disabled',
    revision: 0,
    descriptor: null,
    binding: null,
    consent: null,
  };
}

/**
 * configure：写入当前 descriptor/binding。
 * - descriptor/binding 任一相对上一个持久化值变化（即使 A→B→A）→ revision+1、
 *   consent 清空、state=disabled（须重新知情确认；队列失效由 store owner 处理）；
 * - 完全未变化 → 返回原状态（幂等，不递增 revision）。
 */
export function configureControlState(
  prev: PersistedControlState,
  descriptorInput: unknown,
  bindingInput: unknown,
): PersistedControlState {
  const descriptor = parseConsentDescriptor(descriptorInput);
  const binding = parsePublicationBinding(bindingInput);
  if (sameDescriptor(prev.descriptor, descriptor) && sameBinding(prev.binding, binding)) {
    return prev;
  }
  return {
    state: 'disabled',
    revision: prev.revision + 1,
    descriptor,
    binding,
    consent: null,
  };
}

/**
 * confirm：负责人对「当前 descriptor+binding」明确知情确认（三项必须字面 true）。
 * 只有先 configure 才可 confirm；成功 → state=enabled、revision+1、写入完整 consent。
 */
export function confirmControlConsent(
  prev: PersistedControlState,
  confirmationsInput: unknown,
): PersistedControlState {
  const confirmations = parseConsentConfirmations(confirmationsInput);
  if (prev.descriptor === null || prev.binding === null) {
    throw metadataError('CONSENT_NOT_CONFIGURED');
  }
  return {
    state: 'enabled',
    revision: prev.revision + 1,
    descriptor: prev.descriptor,
    binding: prev.binding,
    consent: buildFullConsent(prev.descriptor, prev.binding, confirmations),
  };
}

/**
 * invalidate：使 consent 失效并回到 disabled（队列清除由 store owner 后续处理）。
 * 保留 descriptor/binding（配置仍在，只是须重新知情确认）。
 */
export function invalidateControlState(prev: PersistedControlState): PersistedControlState {
  if (prev.state === 'disabled' && prev.consent === null) return prev;
  return {
    state: 'disabled',
    revision: prev.revision + 1,
    descriptor: prev.descriptor,
    binding: prev.binding,
    consent: null,
  };
}

/** localStop：本地停止新工作（报告 localStopped，不伪装 cloud disabled/deleted）。 */
export function localStopControlState(prev: PersistedControlState): PersistedControlState {
  if (prev.state === 'localStopped') return prev;
  return {
    state: 'localStopped',
    revision: prev.revision + 1,
    descriptor: prev.descriptor,
    binding: prev.binding,
    consent: prev.consent,
  };
}
