import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/core/errors';
import {
  acceptSourceReport,
  activateSnapshot,
  CHALLENGE_TTL_MS,
  clockTrusted,
  evaluateSourceFreshness,
  flagClockUnhealthy,
  initialState,
  issueSourceChallenge,
  resolveClockAfterReview,
  withBlocker,
  type PublisherBinding,
  type SourceFreshnessState,
} from '../../src/remote-readonly/freshness/source-report';
import type { SourceFingerprintInput } from '../../src/remote-readonly/freshness/fingerprint';
import { buildSourceFingerprint } from '../../src/remote-readonly/freshness/fingerprint';

/**
 * tasks 5.2~5.4 纯状态机测试。暴露并钉住父级指出的缺陷：新激活未确认不得健康、
 * 无源报告超 10 分钟以激活基线转 source_unavailable、blocker 独立于快照、时钟
 * 异常时挑战失效且命中挑战必消费、lineage 必须匹配已授权绑定、now>=expiresAt 拒绝、
 * 5 分钟用 > 而 10 分钟用 >=。
 */

const T0 = '2026-09-07T00:00:00.000Z';
const BINDING: PublisherBinding = { publisherId: 'pub-1', authorizationEpoch: 5 };
const ACTIVATION = {
  snapshotId: 'snap-10',
  activationId: '3',
  databaseInstanceId: '11111111-1111-4111-8111-111111111111',
  contentGenerationId: '22222222-2222-4222-8222-222222222222',
};
const LINEAGE = { databaseInstanceId: ACTIVATION.databaseInstanceId, contentGenerationId: ACTIVATION.contentGenerationId };
const CHALLENGE = '0123456789abcdef'; // 16 字符，满足有界 token 长度
const REVIEWED = { clockReviewRequired: false };

function fpInput(overrides: Partial<SourceFingerprintInput> = {}): SourceFingerprintInput {
  return {
    lineage: LINEAGE,
    businessRevision: '42',
    businessDate: '2026-09-07',
    projectionVersion: 'v1',
    ...overrides,
  };
}

function iso(deltaMs: number): string {
  return new Date(Date.parse(T0) + deltaMs).toISOString();
}

function clockHealthyAt(t: string = iso(0)) {
  return { healthy: true, nowIso: t };
}

/** 已激活快照 + 时钟已 review（healthy 由每次调用输入决定）+ 无挑战。 */
function activeState(over: Partial<SourceFreshnessState> = {}, at = iso(0)): SourceFreshnessState {
  const s = activateSnapshot(initialState(BINDING), ACTIVATION, buildSourceFingerprint(fpInput()), at, at);
  return { ...s, ...REVIEWED, ...over };
}

function report(challengeId: string, fingerprint: SourceFingerprintInput = fpInput()) {
  return { challengeId, fingerprint };
}

function issued(state = activeState(), at = iso(0), clock = clockHealthyAt(at)) {
  return issueSourceChallenge(state, clock, { challengeId: CHALLENGE });
}

describe('确认模型：新激活在匹配报告前不可能是 confirmed_current/健康', () => {
  it('激活后（含此前有报告）未确认 → unconfirmed，即使 lastSourceSeenAt 非空', () => {
    // 先有一个匹配确认
    const first = acceptSourceReport(issued(), clockHealthyAt(), report(CHALLENGE));
    expect(first.accepted).toBe(true);
    if (!first.accepted) throw new Error('unreachable');
    expect(evaluateSourceFreshness(first.state, clockHealthyAt()).freshness).toBe('confirmed_current');

    // 发布新快照（新 activationId + 新指纹）；旧 lastSourceSeenAt 仍在
    const next = iso(5_000);
    const republished = activateSnapshot(
      first.state,
      { ...ACTIVATION, snapshotId: 'snap-11', activationId: '4' },
      buildSourceFingerprint(fpInput({ businessRevision: '43' })),
      next,
      next,
    );
    expect(republished.lastSourceSeenAt).not.toBeNull();
    expect(republished.sourceConfirmedAt).toBeNull();
    const ev = evaluateSourceFreshness(republished, clockHealthyAt(next));
    expect(ev.freshness).toBe('unconfirmed'); // 不得因 pending=null 误判 confirmed_current
    expect(ev.canClaimSourceHealthy).toBe(false);
  });

  it('新激活后收到与当前指纹匹配的 fresh 报告 → confirmed_current、可健康', () => {
    const next = iso(5_000);
    const republished = activeState(
      {
        activation: { ...ACTIVATION, snapshotId: 'snap-11', activationId: '4' },
        currentFingerprint: buildSourceFingerprint(fpInput({ businessRevision: '43' })),
        generatedAt: next,
        lastPublishedAt: next,
      },
      next,
    );
    const after = iso(6_000);
    const confirm = acceptSourceReport(
      issued(republished, after, clockHealthyAt(after)),
      clockHealthyAt(after),
      report(CHALLENGE, fpInput({ businessRevision: '43' })),
    );
    expect(confirm.accepted).toBe(true);
    if (!confirm.accepted) throw new Error('unreachable');
    expect(confirm.confirmed).toBe(true);
    const ev = evaluateSourceFreshness(confirm.state, clockHealthyAt(after));
    expect(ev.freshness).toBe('confirmed_current');
    expect(ev.canClaimSourceHealthy).toBe(true);
  });
});

describe('无源报告基线与 10 分钟不可用', () => {
  it('激活后从未收到报告：以 lastPublishedAt 为基线，>=10 分钟 → source_unavailable（非永远 unconfirmed）', () => {
    const s = activeState({}, iso(0));
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(9 * 60_000))).freshness).toBe('unconfirmed');
    // 10 分钟整点：>= 10min → source_unavailable
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(10 * 60_000))).freshness).toBe('source_unavailable');
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(11 * 60_000))).freshness).toBe('source_unavailable');
  });

  it('收到报告后超过（>=）10 分钟无新报告 → source_unavailable', () => {
    const seen = acceptSourceReport(issued(), clockHealthyAt(iso(1_000)), report(CHALLENGE));
    if (!seen.accepted) throw new Error('unreachable');
    // 最后报告在 +1s；+10min+1s-1s = +600000ms 到达 10 分钟窗口边界
    expect(evaluateSourceFreshness(seen.state, clockHealthyAt(iso(1_000 + 9 * 60_000))).freshness).toBe('confirmed_current');
    expect(evaluateSourceFreshness(seen.state, clockHealthyAt(iso(1_000 + 10 * 60_000))).freshness).toBe('source_unavailable');
  });
});

describe('60s 一次性挑战（now>=expiresAt 拒绝）', () => {
  it('签发绑定 publisher/epoch/lineage/activation；nowIso 校验为真实 ISO', () => {
    const s = issued();
    expect(s.activeChallenge).toMatchObject({ challengeId: CHALLENGE, binding: BINDING, activation: ACTIVATION });
    expect(s.activeChallenge!.expiresAt).toBe(iso(CHALLENGE_TTL_MS));
  });

  it('无快照不能签发挑战', () => {
    const init = { ...initialState(BINDING), ...REVIEWED };
    expect(() => issueSourceChallenge(init, clockHealthyAt(), { challengeId: CHALLENGE })).toThrow(
      ValidationError,
    );
  });

  it('截止边界：now 恰在 expiresAt（now>=expiresAt）拒绝并消费；早 1ms 接受', () => {
    const atTtl = issued();
    const exactly = acceptSourceReport(atTtl, clockHealthyAt(iso(CHALLENGE_TTL_MS)), report(CHALLENGE));
    expect(exactly.accepted).toBe(false);
    if (!exactly.accepted) {
      expect(exactly.code).toBe('CHALLENGE_EXPIRED');
      expect(exactly.state.activeChallenge).toBeNull();
    }
    const atTtlMinus = issued();
    const before = acceptSourceReport(atTtlMinus, clockHealthyAt(iso(CHALLENGE_TTL_MS - 1)), report(CHALLENGE));
    expect(before.accepted).toBe(true);
  });

  it('同一挑战重放拒绝（一次性消费）', () => {
    const first = acceptSourceReport(issued(), clockHealthyAt(), report(CHALLENGE));
    expect(first.accepted).toBe(true);
    if (first.accepted) {
      const replay = acceptSourceReport(first.state, clockHealthyAt(), report(CHALLENGE));
      expect(replay.accepted).toBe(false);
      if (!replay.accepted) expect(replay.code).toBe('CHALLENGE_UNKNOWN');
    }
  });

  it('未知 challengeId 拒绝且不消费现有挑战', () => {
    const bad = acceptSourceReport(issued(), clockHealthyAt(), report('some-other-token-123456'));
    expect(bad.accepted).toBe(false);
    if (!bad.accepted) expect(bad.code).toBe('CHALLENGE_UNKNOWN');
    expect(bad.state.activeChallenge).not.toBeNull();
  });
});

describe('指纹匹配/变化与报告对时间戳的语义', () => {
  it('匹配 → lastSourceSeenAt+sourceConfirmedAt=now；不改 generatedAt/lastPublishedAt；可健康', () => {
    const at = iso(1_000);
    const res = acceptSourceReport(issued(), clockHealthyAt(at), report(CHALLENGE));
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.confirmed).toBe(true);
      expect(res.state.lastSourceSeenAt).toBe(at);
      expect(res.state.sourceConfirmedAt).toBe(at);
      expect(res.state.generatedAt).toBe(iso(0));
      expect(res.state.lastPublishedAt).toBe(iso(0));
      expect(res.state.pendingChangeObservedAt).toBeNull();
    }
    const ev = evaluateSourceFreshness(res.state, clockHealthyAt(at));
    expect(ev.freshness).toBe('confirmed_current');
    expect(ev.canClaimSourceHealthy).toBe(true);
  });

  it('同 lineage revision 前移（变化）→ 记最早待更新、confirmed=false、不更新 sourceConfirmedAt', () => {
    const at = iso(1_000);
    const res = acceptSourceReport(
      issued(),
      clockHealthyAt(at),
      report(CHALLENGE, fpInput({ businessRevision: '43' })),
    );
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.confirmed).toBe(false);
      expect(res.state.lastSourceSeenAt).toBe(at);
      expect(res.state.sourceConfirmedAt).toBeNull();
      expect(res.state.pendingChangeObservedAt).toBe(at);
      expect(res.state.generatedAt).toBe(iso(0));
    }
  });
});

describe('lineage 必须匹配已授权 binding/activation', () => {
  it('报告指纹 lineage 含新 contentGenerationId（新代际）→ LINEAGE_MISMATCH，且不更新 lastSourceSeenAt', () => {
    const res = acceptSourceReport(
      issued(),
      clockHealthyAt(iso(1_000)),
      report(CHALLENGE, {
        ...fpInput(),
        lineage: { ...LINEAGE, contentGenerationId: '99999999-9999-4999-8999-999999999999' },
      }),
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.code).toBe('LINEAGE_MISMATCH');
      expect(res.state.lastSourceSeenAt).toBeNull(); // 不被污染
      expect(res.state.activeChallenge).toBeNull(); // 已消费
    }
  });

  it('不同 databaseInstanceId → LINEAGE_MISMATCH', () => {
    const res = acceptSourceReport(
      issued(),
      clockHealthyAt(iso(1_000)),
      report(CHALLENGE, {
        ...fpInput(),
        lineage: { ...LINEAGE, databaseInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }),
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.code).toBe('LINEAGE_MISMATCH');
  });

  it('binding/activation 已轮换（epoch/activationId/snapshot 不匹配当前）→ CHALLENGE_BINDING_MISMATCH', () => {
    const switched = {
      ...issued(),
      binding: { ...BINDING, authorizationEpoch: 6 },
      activation: { ...ACTIVATION, activationId: '4', snapshotId: 'snap-11' },
    };
    const res = acceptSourceReport(switched, clockHealthyAt(), report(CHALLENGE));
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.code).toBe('CHALLENGE_BINDING_MISMATCH');
  });
});

describe('独立 blocker（与快照无关；评估不改写）', () => {
  it('无快照也能设置 paused/awaiting_lineage/publish_failed；evaluate 保留 blocker，可用性另算 no_snapshot', () => {
    for (const blocker of ['paused', 'awaiting_lineage', 'publish_failed'] as const) {
      const s = withBlocker({ ...initialState(BINDING), ...REVIEWED }, blocker);
      expect(s.blocker).toBe(blocker);
      const ev = evaluateSourceFreshness(s, clockHealthyAt());
      expect(ev.blocker).toBe(blocker); // 不再被改写为 no_snapshot
      expect(ev.freshness).toBe('no_snapshot'); // 可用性独立派生
      expect(ev.canClaimSourceHealthy).toBe(false);
    }
  });

  it('报告不清除 blocker；evaluate 以 blocker 门控健康声明', () => {
    for (const blocker of ['paused', 'awaiting_lineage', 'publish_failed'] as const) {
      const s = withBlocker(activeState({}, iso(0)), blocker);
      const i = issueSourceChallenge(s, clockHealthyAt(), { challengeId: CHALLENGE });
      const res = acceptSourceReport(i, clockHealthyAt(), report(CHALLENGE));
      expect(res.state.blocker).toBe(blocker);
      expect(res.state.activeChallenge).toBeNull();
      const ev = evaluateSourceFreshness(res.state, clockHealthyAt());
      expect(ev.blocker).toBe(blocker);
      expect(ev.canClaimSourceHealthy).toBe(false);
    }
  });
});

describe('时钟闸门：默认不健康、挑战失效、命中必消费、负年龄拒绝', () => {
  it('签发挑战要求时钟可信：默认不健康/未 review → 拒绝签发（通用错误，不回显 token）', () => {
    const init = initialState(BINDING); // clockReviewRequired=true
    expect(() => issueSourceChallenge(init, clockHealthyAt(), { challengeId: CHALLENGE })).toThrow(
      /不合法|操作/,
    );
    expect(() =>
      issueSourceChallenge({ ...init, clockReviewRequired: false }, { healthy: false, nowIso: T0 }, {
        challengeId: CHALLENGE,
      }),
    ).toThrow(ValidationError);
  });

  it('token 有界且类型校验：过短/超长/非字符串 → 通用错误不回显 token', () => {
    const reviewed = activeState();
    for (const bad of ['short', 'x'.repeat(257), 123, null, undefined]) {
      let msg = '';
      try {
        issueSourceChallenge(reviewed, clockHealthyAt(), {
          challengeId: bad as unknown as string,
        });
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toBe('操作不合法');
      expect(msg).not.toContain('short');
    }
    // 合法有界 token
    expect(issueSourceChallenge(reviewed, clockHealthyAt(), { challengeId: CHALLENGE }).activeChallenge).not.toBeNull();
  });

  it('healthy 但未 review → 报告拒绝并消费挑战；resync 本身不能恢复', () => {
    // 挑战在 review 通过后签发，随后时钟被判定不健康（reviewRequired=true）
    const issuedHealthy = issued();
    const needReview = { ...issuedHealthy, clockReviewRequired: true };
    const res = acceptSourceReport(needReview, { healthy: true, nowIso: T0 }, report(CHALLENGE));
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.code).toBe('CLOCK_UNHEALTHY');
      expect(res.state.clockReviewRequired).toBe(true);
      expect(res.state.activeChallenge).toBeNull(); // 命中即消费
    }
    // resync（healthy=true）后 reviewRequired 仍在 → 仍不健康
    expect(evaluateSourceFreshness(res.state, { healthy: true, nowIso: T0 }).clockHealthy).toBe(false);
    const reviewed = resolveClockAfterReview(res.state);
    expect(reviewed.clockReviewRequired).toBe(false);
    expect(reviewed.activeChallenge).toBeNull(); // review 同时作废旧挑战
  });

  it('时钟不健康输入 → 拒绝、标记 review、命中挑战即消费', () => {
    const res = acceptSourceReport(issued(), { healthy: false, nowIso: T0 }, report(CHALLENGE));
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.code).toBe('CLOCK_UNHEALTHY');
      expect(res.state.clockReviewRequired).toBe(true);
      expect(res.state.activeChallenge).toBeNull();
    }
  });

  it('now 早于挑战 issuedAt → 时钟故障拒绝并要求 review，不产生负年龄健康', () => {
    const s = issued(); // issuedAt = T0
    const res = acceptSourceReport(s, clockHealthyAt(iso(-1_000)), report(CHALLENGE));
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.code).toBe('CLOCK_UNHEALTHY');
      expect(res.state.clockReviewRequired).toBe(true);
      expect(res.state.activeChallenge).toBeNull();
    }
  });

  it('flagClockUnhealthy 使全部挑战失效；resolveClockAfterReview 也作废旧挑战', () => {
    const s = issued();
    const flagged = flagClockUnhealthy(s);
    expect(flagged.clockReviewRequired).toBe(true);
    expect(flagged.activeChallenge).toBeNull();
    const resolved = resolveClockAfterReview(s);
    expect(resolved.clockReviewRequired).toBe(false);
    expect(resolved.activeChallenge).toBeNull();
  });

  it('时钟可信窄闸门 clockTrusted', () => {
    expect(clockTrusted(true, false)).toBe(true);
    expect(clockTrusted(false, false)).toBe(false);
    expect(clockTrusted(true, true)).toBe(false);
  });
});

describe('阈值措辞：待更新延迟用严格 >5min，无报告不可用用 >=10min', () => {
  it('待更新在 5 分钟整点仍是 updating；超过 5 分钟（>5min）才 updating_lag', () => {
    const pendAt = iso(1_000);
    const s = activeState({ pendingChangeObservedAt: pendAt, lastSourceSeenAt: pendAt });
    // 5 分钟整点：now - pend = 5min → 不大于阈值 → updating（spec「超过 5 分钟」才延迟）
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(1_000 + 5 * 60_000))).freshness).toBe('updating');
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(1_000 + 5 * 60_000 + 1))).freshness).toBe('updating_lag');
    expect(evaluateSourceFreshness(s, clockHealthyAt(iso(1_000 + 5 * 60_000))).canClaimSourceHealthy).toBe(false);
  });

  it('匹配确认后可健康；5 分钟整点 updating 不因确认被跳过', () => {
    const at = iso(1_000);
    const s = activeState({ pendingChangeObservedAt: at, lastSourceSeenAt: at });
    const ev5 = evaluateSourceFreshness(s, clockHealthyAt(iso(1_000 + 5 * 60_000)));
    expect(ev5.freshness).toBe('updating');
    expect(ev5.canClaimSourceHealthy).toBe(false);
  });
});

describe('时间戳校验：非真实/非带偏移 ISO 拒绝', () => {
  it('activateSnapshot/accept/issue 的 now 与时间入参必须是真实带偏移 ISO', () => {
    const reviewed = activeState();
    expect(() =>
      activateSnapshot(reviewed, ACTIVATION, buildSourceFingerprint(fpInput()), '2026-02-30T00:00:00Z', T0),
    ).toThrow(ValidationError);
    expect(() =>
      activateSnapshot(reviewed, ACTIVATION, buildSourceFingerprint(fpInput()), '2026-09-07T10:00:00', T0),
    ).toThrow(ValidationError);
    expect(() =>
      issueSourceChallenge(reviewed, clockHealthyAt('2026-09-07T25:00:00Z'), {
        challengeId: CHALLENGE,
      }),
    ).toThrow(ValidationError);
    expect(() => evaluateSourceFreshness(reviewed, clockHealthyAt('not-a-time'))).toThrow(ValidationError);
  });

  it('evaluate 不更新任何状态（纯读；普通 GET 不推进来源健康）', () => {
    const seen = acceptSourceReport(issued(), clockHealthyAt(iso(1_000)), report(CHALLENGE));
    if (!seen.accepted) throw new Error('unreachable');
    const before = JSON.stringify(seen.state);
    evaluateSourceFreshness(seen.state, clockHealthyAt(iso(2_000)));
    expect(JSON.stringify(seen.state)).toBe(before);
  });
});
