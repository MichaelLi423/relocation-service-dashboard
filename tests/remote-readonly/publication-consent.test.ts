/**
 * publication-consent.test.ts（tasks 2.1 main gate，规范持久化状态模型）
 *
 * 只验证 consent.ts 纯模型 + 门控：
 * - 严格解析：descriptor/binding/consent/state 全部 allowlist；三项确认必须字面
 *   === true（false / 字符串 'false' / null / 0 一律拒绝，fail closed）；
 * - projectionVersion 必须等于已知常量；fieldScopeDigest 必须 64 位小写 hex 且等于
 *   当前完整白名单 hash；retentionExplanationVersion 只接受单一主控常量；
 * - lineage UUID；ID 有界；epoch 安全整数；revision 安全整数；无并行 enabled 布尔；
 * - deriveGateState：仅显式 state==='enabled' + 完整匹配 consent+binding 才 enabled；
 *   disabled/localStopped 永不从存量 consent 自动恢复；缺 version / 结构损坏 fail closed；
 * - configure/invalidate：descriptor/binding 变化（含 A→B→A）→ revision+1、清 consent；
 * - action 端口收到深拷贝冻结 context（不可 mutate）；无 adapter 返回 unconfigured，
 *   绝不无参调用、不假成功；
 * - 未知 canary 键（含 token/password/secret 命名）由 allowlist 拒绝且 metadata-only。
 *
 * 全部 synthetic target（https://publish.synth.test）；无真实端点/网络/vault/DB。
 */
import { describe, expect, it } from 'vitest';
import {
  CONSENT_PROJECTION_VERSION,
  CONSENT_RETENTION_EXPLANATION_VERSION,
  ConsentGateError,
  buildFullConsent,
  buildActionContext,
  configureControlState,
  confirmControlConsent,
  consentMatches,
  deriveGateState,
  fieldScopeDigest,
  initialControlState,
  invalidateControlState,
  localStopControlState,
  parseConsentDescriptor,
  parseConsentConfirmations,
  parsePersistedControlState,
  parsePublicationBinding,
  requestCredentialLookup,
  requestOutboundPublish,
  validateConsentTarget,
  type ConsentDescriptor,
  type ControlStatePort,
  type FullPublicationConsent,
  type PersistedControlState,
  type PublicationActionContext,
  type PublicationBinding,
} from '../../src/main/remote-readonly/consent';

const SYNTH_TARGET = 'https://publish.synth.test';
const SYNTH_TARGET_2 = 'https://publish-alt.synth.test';

/** 合成 UUID（非真实 endpoint/客户；lineage 仅需合法形状）。 */
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';

function syntheticDescriptor(overrides: Partial<ConsentDescriptor> = {}): ConsentDescriptor {
  return {
    targetHttpsOrigin: SYNTH_TARGET,
    projectionVersion: CONSENT_PROJECTION_VERSION,
    fieldScopeDigest: fieldScopeDigest(),
    retentionExplanationVersion: CONSENT_RETENTION_EXPLANATION_VERSION,
    ...overrides,
  };
}

function syntheticBinding(overrides: Partial<PublicationBinding> = {}): PublicationBinding {
  return {
    publisherId: 'publisher-synth',
    authorizationEpoch: 1,
    databaseInstanceId: UUID_A,
    contentGenerationId: UUID_B,
    ...overrides,
  };
}

function syntheticConfirmations(): { targetConfirmed: true; scopeConfirmed: true; retentionConfirmed: true } {
  return { targetConfirmed: true, scopeConfirmed: true, retentionConfirmed: true };
}

/** 构造完整持久化状态（默认 enabled + 匹配 consent）。 */
function enabledState(overrides: Partial<PersistedControlState> = {}): PersistedControlState {
  const descriptor = syntheticDescriptor();
  const binding = syntheticBinding();
  const base: PersistedControlState = {
    state: 'enabled',
    revision: 2,
    descriptor,
    binding,
    consent: buildFullConsent(descriptor, binding, syntheticConfirmations()),
  };
  return { ...base, ...overrides };
}

/** port 包装：readCurrent 返回给定状态。 */
function portOf(state: PersistedControlState): ControlStatePort {
  return { readCurrent: () => state };
}

function validConsentObject(): FullPublicationConsent {
  const descriptor = syntheticDescriptor();
  const binding = syntheticBinding();
  return buildFullConsent(descriptor, binding, syntheticConfirmations());
}

describe('PersistedControlState 规范形状与严格解析', () => {
  it('初始态 disabled + revision 0 + 全 null；无并行 enabled 布尔', () => {
    const init = initialControlState();
    expect(init).toEqual({
      state: 'disabled',
      revision: 0,
      descriptor: null,
      binding: null,
      consent: null,
    });
    expect(Object.keys(init).sort()).toEqual(['binding', 'consent', 'descriptor', 'revision', 'state']);
    expect(init).not.toHaveProperty('enabled');
  });

  it('parsePersistedControlState：顶层未知键 / enabled 并行布尔拒绝', () => {
    expect(() =>
      parsePersistedControlState({ ...enabledState(), enabled: true }),
    ).toThrow(ConsentGateError);
    expect(() => parsePersistedControlState({ ...enabledState(), other: 1 })).toThrow(ConsentGateError);
    // 结构损坏 → 门端 fail closed（不允许任何发布/凭据查询）
    const port = { readCurrent: () => ({ ...enabledState(), state: 'enabled', consent: null }) };
    expect(deriveGateState(parsePersistedControlState(port.readCurrent()))).toBe('disabled');
  });

  it('合法 enabled 状态 round-trip；consent 精确等于 descriptor+binding', () => {
    const parsed = parsePersistedControlState(enabledState());
    expect(parsed.state).toBe('enabled');
    expect(consentMatches(parsed.consent, parsed.descriptor, parsed.binding)).toBe(true);
    expect(parsed.revision).toBe(2);
  });

  it('descriptor：投影版本必须等于已知常量（null/任意串拒绝）', () => {
    const d = syntheticDescriptor();
    expect(parseConsentDescriptor(d).projectionVersion).toBe(CONSENT_PROJECTION_VERSION);
    for (const bad of [null, undefined, '', 'other-v2', CONSENT_PROJECTION_VERSION + '-x']) {
      expect(() => parseConsentDescriptor({ ...d, projectionVersion: bad })).toThrow(ConsentGateError);
    }
  });

  it('descriptor：fieldScopeDigest 必须 64 位小写 hex 且等于当前白名单 hash', () => {
    const d = syntheticDescriptor();
    expect(parseConsentDescriptor(d).fieldScopeDigest).toBe(fieldScopeDigest());
    for (const bad of ['nothex', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '0'.repeat(64)]) {
      // 非 64hex 或非当前 hash → 拒绝
      expect(() => parseConsentDescriptor({ ...d, fieldScopeDigest: bad })).toThrow(ConsentGateError);
    }
  });

  it('descriptor：retentionExplanationVersion 只接受单一主控常量', () => {
    const d = syntheticDescriptor();
    for (const bad of [null, '', 'retention-v2', '任意版本串', '0'.repeat(64)]) {
      expect(() => parseConsentDescriptor({ ...d, retentionExplanationVersion: bad })).toThrow(
        ConsentGateError,
      );
    }
  });

  it('binding：lineage 必须 UUID；epoch 安全整数；ID 有界', () => {
    const b = syntheticBinding();
    expect(parsePublicationBinding(b).authorizationEpoch).toBe(1);
    for (const bad of ['not-a-uuid', 'db-1', '']) {
      expect(() => parsePublicationBinding({ ...b, databaseInstanceId: bad })).toThrow(ConsentGateError);
      expect(() => parsePublicationBinding({ ...b, contentGenerationId: bad })).toThrow(ConsentGateError);
    }
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, '1', null]) {
      expect(() => parsePublicationBinding({ ...b, authorizationEpoch: bad })).toThrow(ConsentGateError);
    }
    expect(() =>
      parsePublicationBinding({ ...b, publisherId: 'p'.repeat(129) }),
    ).toThrow(ConsentGateError);
  });

  it('consent：三项确认必须字面 === true（false / 字符串 false / null / 0 拒绝）', () => {
    expect(validConsentObject().targetConfirmed).toBe(true);
    expect(parseConsentConfirmations({ targetConfirmed: true, scopeConfirmed: true, retentionConfirmed: true }))
      .toEqual({ targetConfirmed: true, scopeConfirmed: true, retentionConfirmed: true });
    for (const badValue of [false, 'false', 'true', null, 0, 1, undefined]) {
      expect(() =>
        parseConsentConfirmations({
          targetConfirmed: badValue,
          scopeConfirmed: true,
          retentionConfirmed: true,
        }),
      ).toThrow(ConsentGateError);
      expect(() =>
        parseConsentConfirmations({
          targetConfirmed: true,
          scopeConfirmed: badValue,
          retentionConfirmed: true,
        }),
      ).toThrow(ConsentGateError);
      expect(() =>
        parseConsentConfirmations({
          targetConfirmed: true,
          scopeConfirmed: true,
          retentionConfirmed: badValue,
        }),
      ).toThrow(ConsentGateError);
    }
    // 缺字段同样拒绝（不是缺省 true）
    expect(() =>
      parseConsentConfirmations({ targetConfirmed: true, scopeConfirmed: true }),
    ).toThrow(ConsentGateError);
  });

  it('未知 canary 键（含 token/password/secret 命名）由 allowlist 拒绝且 metadata-only', () => {
    const cases = [
      { ...syntheticDescriptor(), rememberMe: true },
      { ...syntheticDescriptor(), token: 'SECRET-CANARY-TOKEN' },
      { ...syntheticDescriptor(), password: 'SECRET-CANARY-PASS' },
      { ...syntheticDescriptor(), clientSecret: 'SECRET-CANARY' },
      { ...syntheticDescriptor(), userinfo: 'u:p' },
    ];
    for (const bad of cases) {
      try {
        parseConsentDescriptor(bad as unknown as ConsentDescriptor);
        throw new Error('expected ConsentGateError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConsentGateError);
        const all = `${(error as Error).message}|${(error as Error).name}|${(error as DomainErrorLike).code}`;
        expect(all).not.toContain('SECRET-CANARY');
        expect(all).not.toContain('rememberMe');
        expect(all).not.toContain('token');
        expect(all).not.toContain('password');
      }
    }
    // 顶层状态未知键同样拒绝
    expect(() => parsePersistedControlState({ ...enabledState(), secret: 'x' })).toThrow(ConsentGateError);
  });
});

describe('target 校验（仅 HTTPS origin 语法，无 TLS 信任声明）', () => {
  it('接受合法 origin；拒绝 userinfo/path/query/fragment/http/非 URL', () => {
    expect(validateConsentTarget('https://publish.synth.test')).toBe('https://publish.synth.test');
    expect(validateConsentTarget('https://publish.synth.test:8443')).toBe('https://publish.synth.test:8443');
    for (const bad of [
      'http://publish.synth.test',
      'https://user:pass@publish.synth.test',
      'https://publish.synth.test/path',
      'https://publish.synth.test/?a=1',
      'https://publish.synth.test/#frag',
      'not a url',
      '',
    ]) {
      expect(() => validateConsentTarget(bad)).toThrow(ConsentGateError);
    }
  });

  it('绝不把 origin 语法校验夸大为 TLS/信任链已验证', () => {
    // 语法校验只接受 origin 形状，不代表已验证 TLS/信任链。本模型无证书/信任字段：
    // descriptor/binding/consent 的 allowlist 均不含 tls/certificate/ca/chain 等键。
    const allowed = new Set([
      'targetHttpsOrigin',
      'projectionVersion',
      'fieldScopeDigest',
      'retentionExplanationVersion',
      'publisherId',
      'authorizationEpoch',
      'databaseInstanceId',
      'contentGenerationId',
      'targetConfirmed',
      'scopeConfirmed',
      'retentionConfirmed',
    ]);
    expect([...allowed].some((k) => /tls|certificate|chain|trust/.test(k))).toBe(false);
    // target 只允许 https:// origin（语法），任何信任链验证属未来接线实现，本模块不声明。
    expect(() => validateConsentTarget('https://trusted.synth.test')).not.toThrow();
  });
});

describe('deriveGateState：仅显式 enabled + 完整匹配 consent 才放行', () => {
  it('disabled/localStopped 永不从存量 consent 自动恢复 enabled', () => {
    const disabledWithConsent = { ...enabledState(), state: 'disabled' as const };
    const stoppedWithConsent = { ...enabledState(), state: 'localStopped' as const };
    expect(deriveGateState(disabledWithConsent)).toBe('disabled');
    expect(deriveGateState(stoppedWithConsent)).toBe('localStopped');
  });

  it('enabled 但缺 descriptor/binding/consent / consent 不匹配 → disabled（fail closed）', () => {
    const d = syntheticDescriptor();
    const b = syntheticBinding();
    const base = enabledState();
    // 缺 consent
    expect(deriveGateState({ ...base, consent: null })).toBe('disabled');
    // 缺 descriptor/binding
    expect(deriveGateState({ ...base, descriptor: null })).toBe('disabled');
    expect(deriveGateState({ ...base, binding: null })).toBe('disabled');
    // consent 与 descriptor 不匹配（不同 target）
    const mismatchedConsent = buildFullConsent(
      syntheticDescriptor({ targetHttpsOrigin: SYNTH_TARGET_2 }),
      b,
      syntheticConfirmations(),
    );
    expect(deriveGateState({ ...base, consent: mismatchedConsent })).toBe('disabled');
    // 绑定变化但 consent 仍旧绑定 → disabled
    const staleConsent = buildFullConsent(d, b, syntheticConfirmations());
    expect(
      deriveGateState({ ...base, binding: { ...b, authorizationEpoch: 2 }, consent: staleConsent }),
    ).toBe('disabled');
  });

  it('null 版本 / 结构损坏 → 门端 fail closed（requestOutboundPublish 不假成功）', () => {
    // descriptor.projectionVersion null 无法直接构造（解析拒绝）；用损坏 raw 断言门拒绝
    const corruptPort = { readCurrent: () => ({ state: 'enabled', revision: 1 }) };
    expect(requestOutboundPublish(corruptPort)).toEqual({
      allowed: false,
      reason: 'consent_invalid',
      state: 'disabled',
      context: null,
    });
    expect(requestCredentialLookup(corruptPort)).toEqual({
      allowed: false,
      reason: 'consent_invalid',
      state: 'disabled',
      context: null,
    });
  });
});

describe('action 端口：context 深拷贝冻结；无 adapter 不假成功', () => {
  it('放行时 adapter 收到 {descriptor,binding,controlRevision}（深拷贝冻结）', () => {
    const state = enabledState();
    const holder: { ctx: PublicationActionContext | null } = { ctx: null };
    const outbound = requestOutboundPublish(portOf(state), (ctx) => {
      holder.ctx = ctx;
      return { ok: true, context: ctx };
    });
    expect(outbound.allowed).toBe(true);
    expect(outbound.reason).toBe('consent_ok');
    expect(holder.ctx?.controlRevision).toBe(2);
    expect(holder.ctx?.descriptor.targetHttpsOrigin).toBe(SYNTH_TARGET);
    expect(holder.ctx?.binding.authorizationEpoch).toBe(1);
  });

  it('action context 不可 mutate（冻结且独立于源对象）', () => {
    const state = enabledState();
    const holder: { ctx: PublicationActionContext | null } = { ctx: null };
    requestOutboundPublish(portOf(state), (ctx) => {
      holder.ctx = ctx;
      return { ok: true, context: ctx };
    });
    const ctx = holder.ctx;
    expect(ctx).not.toBeNull();
    if (ctx === null) throw new Error('expected context');
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.descriptor)).toBe(true);
    expect(Object.isFrozen(ctx.binding)).toBe(true);
    expect(() => {
      (ctx.binding as { authorizationEpoch: number }).authorizationEpoch = 99;
    }).toThrow();
    // 修改源状态不影响已发出的 context
    const original = state.binding?.authorizationEpoch;
    state.binding = { ...(state.binding as PublicationBinding), authorizationEpoch: 99 };
    expect(ctx.binding.authorizationEpoch).toBe(original);
  });

  it('无 adapter → unconfigured（不假成功、不无参调用）', () => {
    const state = enabledState();
    const result = requestOutboundPublish(portOf(state));
    expect(result).toEqual({
      allowed: false,
      reason: 'unconfigured',
      state: 'enabled',
      context: expect.objectContaining({ controlRevision: 2 }),
    });
  });

  it('未启用状态 → 不调用 adapter', () => {
    let called = 0;
    const result = requestOutboundPublish(portOf(initialControlState()), () => {
      called += 1;
      return { ok: true, context: buildActionContext(enabledState()) };
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_enabled');
    expect(called).toBe(0);
  });

  it('credential lookup 同门控：enabled 放行，disabled/localStopped 拒绝', () => {
    let called = 0;
    const ok = requestCredentialLookup(portOf(enabledState()), () => {
      called += 1;
      return { ok: true, context: buildActionContext(enabledState()) };
    });
    expect(ok.allowed).toBe(true);
    expect(called).toBe(1);
    expect(
      requestCredentialLookup(portOf({ ...enabledState(), state: 'localStopped' })).allowed,
    ).toBe(false);
    expect(
      requestCredentialLookup(portOf({ ...enabledState(), state: 'disabled' })).allowed,
    ).toBe(false);
  });
});

describe('configure/confirm/invalidate：revision 递增与 consent 失效', () => {
  it('configure 变化（含 A→B→A）→ revision+1 + 清 consent + disabled', () => {
    const a = syntheticDescriptor();
    const b = syntheticBinding();
    const init = configureControlState(initialControlState(), a, b);
    expect(init.state).toBe('disabled');
    expect(init.revision).toBe(1);
    expect(init.consent).toBeNull();
    // 确认后 enabled
    const confirmed = confirmControlConsent(init, syntheticConfirmations());
    expect(confirmed.state).toBe('enabled');
    expect(confirmed.revision).toBe(2);
    // A→B：descriptor 变化 → revision+1 清 consent
    const changed = configureControlState(
      confirmed,
      syntheticDescriptor({ targetHttpsOrigin: SYNTH_TARGET_2 }),
      b,
    );
    expect(changed.state).toBe('disabled');
    expect(changed.revision).toBe(3);
    expect(changed.consent).toBeNull();
    // B→A：相对上一个持久化值仍是变化（A→B→A 不复活旧 consent）
    const backToA = configureControlState(changed, a, b);
    expect(backToA.state).toBe('disabled');
    expect(backToA.revision).toBe(4);
    expect(backToA.consent).toBeNull();
    expect(backToA.descriptor).toEqual(a);
  });

  it('configure 无变化 → 幂等（不递增 revision）', () => {
    const a = syntheticDescriptor();
    const b = syntheticBinding();
    const configured = configureControlState(initialControlState(), a, b);
    const again = configureControlState(configured, a, b);
    expect(again).toBe(configured);
    expect(again.revision).toBe(1);
  });

  it('binding epoch/lineage 变化 → 同样失效并清 consent', () => {
    const d = syntheticDescriptor();
    const b1 = syntheticBinding();
    const enabled = confirmControlConsent(configureControlState(initialControlState(), d, b1), syntheticConfirmations());
    expect(enabled.state).toBe('enabled');
    // epoch 变化
    const epochChanged = configureControlState(enabled, d, { ...b1, authorizationEpoch: 2 });
    expect(epochChanged.state).toBe('disabled');
    expect(epochChanged.consent).toBeNull();
    expect(epochChanged.revision).toBe(3);
    // lineage 变化
    const lineageChanged = configureControlState(enabled, d, {
      ...b1,
      databaseInstanceId: '11111111-1111-4111-8111-111111111111',
    });
    expect(lineageChanged.state).toBe('disabled');
    expect(lineageChanged.consent).toBeNull();
  });

  it('confirm 必须先 configure（descriptor/binding 缺失 → 拒绝）', () => {
    expect(() => confirmControlConsent(initialControlState(), syntheticConfirmations())).toThrow(
      ConsentGateError,
    );
  });

  it('invalidate：清 consent 回 disabled；已失效时幂等；保留 descriptor/binding', () => {
    const enabled = enabledState();
    const invalidated = invalidateControlState(enabled);
    expect(invalidated.state).toBe('disabled');
    expect(invalidated.consent).toBeNull();
    expect(invalidated.revision).toBe(enabled.revision + 1);
    expect(invalidated.descriptor).toEqual(enabled.descriptor);
    // 再次 invalidate 幂等
    expect(invalidateControlState(invalidated)).toBe(invalidated);
  });

  it('localStop：state=localStopped + revision+1；保留 consent 但不自动恢复', () => {
    const enabled = enabledState();
    const stopped = localStopControlState(enabled);
    expect(stopped.state).toBe('localStopped');
    expect(stopped.revision).toBe(enabled.revision + 1);
    expect(stopped.consent).not.toBeNull();
    expect(deriveGateState(stopped)).toBe('localStopped');
    // 幂等
    expect(localStopControlState(stopped)).toBe(stopped);
  });
});

interface DomainErrorLike {
  code?: string;
}
