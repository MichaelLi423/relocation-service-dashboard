/**
 * 远程只读发布：发布动作编排（tasks 2.3 action 切片）。
 *
 * main-only async runPublicationAction：prepare→readCredential→send 三阶段推进注入回调，
 * 唯一 store 依赖是窄端口 assertCurrentContext()（control-store enabled 门，返回深拷贝
 * 冻结的 PublicationActionContext）。start 必须 enabled，捕获冻结 context 为 pinned；每
 * 阶段 await 后重比对 controlRevision/descriptor/binding：prepare 期间变化阻止 credential+
 * send，credential 期间变化阻止 send，send 期间变化结果 stale（已传输边界不可撤销，如实
 * 报告）。
 * - adapters 缺省/缺失任一可调用函数 → unconfigured（任何 vault/network 前判定，零回调）；
 * - readCredential 只接受非空 string：坏 adapter 返回 null/undefined/空/非 string →
 *   failed，绝不转发给 send（本模块不做 secret 长度上限校验——那是受信 native 端口职责）；
 * - 全程由外层 generic catch 收敛：任何阶段未知 store/adapter 异常（含存储 canary）→
 *   fixed failed，绝不把原始 cause/raw secret 抛给桌面，失败后不再调用后续阶段回调；
 * - secret 仅函数局部并在 finally 清引用（不声称零化）；无时钟/真实网络/日志/secret 返回；
 *   结果只含固定 outcome，不声称云端已发布。
 */
import { ControlStoreError } from './control-store';
import type { PublicationActionContext } from './consent';

export type PublicationActionOutcome =
  | 'completed'
  | 'stale'
  | 'not_enabled'
  | 'unconfigured'
  | 'failed';

export interface PublicationActionResult {
  readonly outcome: PublicationActionOutcome;
}

/** 窄 store 端口：只暴露 enabled context 断言（不暴露队列/状态/路径）。 */
export interface PublicationActionStorePort {
  assertCurrentContext(): PublicationActionContext;
}

/** 注入 adapter（真实接线方提供；缺省/缺失 → unconfigured）。 */
export interface PublicationActionAdapters {
  prepare?(context: PublicationActionContext): Promise<unknown>;
  /** 非空 string 才被接受并转发给 send；null/undefined/空/非 string → failed。 */
  readCredential?(context: PublicationActionContext): Promise<string | null | undefined>;
  /** secret 为受信 native 端口取得的非空 string；绝不进入结果/日志。 */
  send?(context: PublicationActionContext, prepared: unknown, secret: string): Promise<void>;
}

/** 门放行则取 enabled context；CONFLICT(未 enabled) → null；其它异常上抛（外层收敛）。 */
function enabledContextOrNull(store: PublicationActionStorePort): PublicationActionContext | null {
  try {
    return store.assertCurrentContext();
  } catch (err) {
    if (err instanceof ControlStoreError && err.code === 'CONTROL_STATE_CONFLICT') return null;
    throw err;
  }
}

/** 当前 context 是否仍等于捕获的 pinned（controlRevision + descriptor + binding 全等）。 */
function matchesCaptured(
  store: PublicationActionStorePort,
  captured: PublicationActionContext,
): boolean {
  const current = enabledContextOrNull(store);
  if (current === null) return false;
  const a = captured.descriptor;
  const b = current.descriptor;
  const sameDescriptor =
    a.targetHttpsOrigin === b.targetHttpsOrigin &&
    a.projectionVersion === b.projectionVersion &&
    a.fieldScopeDigest === b.fieldScopeDigest &&
    a.retentionExplanationVersion === b.retentionExplanationVersion;
  const ab = captured.binding;
  const bb = current.binding;
  const sameBinding =
    ab.publisherId === bb.publisherId &&
    ab.authorizationEpoch === bb.authorizationEpoch &&
    ab.databaseInstanceId === bb.databaseInstanceId &&
    ab.contentGenerationId === bb.contentGenerationId;
  return captured.controlRevision === current.controlRevision && sameDescriptor && sameBinding;
}

/**
 * 执行一次发布动作。已知结果（unconfigured/not_enabled/stale/completed）照常返回；
 * 任何阶段未知异常 → failed（失败后不继续后续阶段回调，不泄露 canary/cause）。
 */
export async function runPublicationAction(
  store: PublicationActionStorePort,
  adapters: PublicationActionAdapters = {},
): Promise<PublicationActionResult> {
  try {
    const { prepare, readCredential, send } = adapters;
    // 任何 vault/network 调用前做 runtime 可调用性校验：缺失/坏 adapter → unconfigured。
    if (
      typeof prepare !== 'function' ||
      typeof readCredential !== 'function' ||
      typeof send !== 'function'
    ) {
      return { outcome: 'unconfigured' };
    }

    const context = enabledContextOrNull(store);
    if (context === null) return { outcome: 'not_enabled' };

    // phase 1：prepare。
    const prepared = await prepare(context);
    // prepare 期间变化 → 阻止 credential+send。
    if (!matchesCaptured(store, context)) return { outcome: 'stale' };

    // phase 2/3：readCredential → send。secret 仅局部，finally 清引用（不零化）。
    let secret: string | null | undefined;
    try {
      secret = await readCredential(context);
      // credential 期间变化 → 阻止 send（过期配置的凭据绝不可用）。
      if (!matchesCaptured(store, context)) return { outcome: 'stale' };
      // 坏 adapter 返回空/非 string → 拒绝，绝不转发给 send。
      if (typeof secret !== 'string' || secret === '') return { outcome: 'failed' };
      await send(context, prepared, secret);
    } finally {
      secret = null; // 仅清局部引用；JS 无零化，不作此声称
    }

    // send 已传输的显式边界：此刻变化无法撤销，只能如实报告 stale。
    if (!matchesCaptured(store, context)) return { outcome: 'stale' };
    return { outcome: 'completed' };
  } catch {
    return { outcome: 'failed' };
  }
}
