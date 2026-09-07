/**
 * publication-action.test.ts（tasks 2.3 action 切片）
 *
 * runPublicationAction 编排验证（全 fake，无真实 DB/vault/network/时钟）：
 * - 门控：非 enabled → not_enabled、adapters 缺失/不可调用 → unconfigured，均零回调；
 * - pinned context 不可变：三个回调收到同一 frozen context；
 * - 每 awaited phase 后重比对：prepare 期间 stop/config 变化 → 阻止 credential+send；
 *   credential 期间变化 → 阻止 send；send 期间变化 → stale（已传输边界如实报告）；
 * - 全程外层 catch 收敛：store 在 start/prepare 后/send 后抛未知 canary → fixed failed，
 *   失败后不再调用后续回调且结果不泄露 canary；
 * - readCredential 返回空串/非 string（坏 adapter）→ failed 且不转发给 send；
 *   null/undefined → failed 零 send；adapter 抛错 → failed metadata-only；
 * - 成功全序 prepare→credential→send → completed。
 * 每 phase 停在 deferred gate，先 start 再逐 gate 放行以精确控时。全 synthetic。
 */
import { describe, expect, it } from 'vitest';
import { ControlStoreError } from '../../src/main/remote-readonly/control-store';
import type { PublicationActionContext } from '../../src/main/remote-readonly/consent';
import { runPublicationAction, type PublicationActionAdapters } from '../../src/main/remote-readonly/publication-action';

const DESCRIPTOR = Object.freeze({
  targetHttpsOrigin: 'https://publish.synth.test',
  projectionVersion: 'projection-v1',
  fieldScopeDigest: 'd'.repeat(64),
  retentionExplanationVersion: 'retention-v1',
});
const BINDING = Object.freeze({
  publisherId: 'pub-synth-1',
  authorizationEpoch: 7,
  databaseInstanceId: '00000000-0000-4000-8000-0000000000a1',
  contentGenerationId: '00000000-0000-4000-8000-0000000000b2',
});
const CTX_A: PublicationActionContext = Object.freeze({ descriptor: DESCRIPTOR, binding: BINDING, controlRevision: 4 });
/** epoch + revision 变化的 context（config 变化用）。 */
const CTX_B: PublicationActionContext = Object.freeze({
  descriptor: DESCRIPTOR,
  binding: Object.freeze({ ...BINDING, authorizationEpoch: 8 }),
  controlRevision: 5,
});

/** flush 链式 microtask，确保 run 已停在目标 phase gate。 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Harness {
  state: {
    setEnabled(c: PublicationActionContext): void;
    setNotEnabled(): void;
    /** 模拟存储层未知异常（非 CONFLICT 的 canary）。 */
    setPoisoned(): void;
  };
  recorder: {
    prepareCalls: number; credentialCalls: number; sendCalls: number;
    contexts: PublicationActionContext[]; prepared: unknown[]; secrets: string[];
  };
  gates: { prepare: ReturnType<typeof deferred<unknown>>; credential: ReturnType<typeof deferred<unknown>>; send: ReturnType<typeof deferred<void>> };
  store: { assertCurrentContext(): PublicationActionContext };
  adapters: PublicationActionAdapters;
}

function harness(): Harness {
  let current: PublicationActionContext | null = CTX_A;
  let poisoned = false;
  const state = {
    setEnabled(c: PublicationActionContext) { current = c; poisoned = false; },
    setNotEnabled() { current = null; poisoned = false; },
    setPoisoned() { poisoned = true; },
  };
  const store = {
    assertCurrentContext(): PublicationActionContext {
      if (poisoned) throw new Error('boom CANARY-STORE-9f31'); // 未知存储异常，非 ControlStoreError
      if (current === null) throw new ControlStoreError('CONTROL_STATE_CONFLICT');
      return current;
    },
  };
  const recorder = { prepareCalls: 0, credentialCalls: 0, sendCalls: 0, contexts: [] as PublicationActionContext[], prepared: [] as unknown[], secrets: [] as string[] };
  const gates = { prepare: deferred<unknown>(), credential: deferred<unknown>(), send: deferred<void>() };
  const adapters = {
    prepare: async (context: PublicationActionContext): Promise<unknown> => {
      recorder.contexts.push(context); recorder.prepareCalls += 1; return gates.prepare.promise;
    },
    // gate 承载任意运行时坏值；cast 模拟坏 adapter 违反契约。
    readCredential: async (context: PublicationActionContext): Promise<string | null | undefined> => {
      recorder.contexts.push(context); recorder.credentialCalls += 1;
      return gates.credential.promise as Promise<string | null | undefined>;
    },
    send: async (context: PublicationActionContext, prepared: unknown, secret: string): Promise<void> => {
      recorder.contexts.push(context); recorder.prepared.push(prepared); recorder.secrets.push(secret); recorder.sendCalls += 1; return gates.send.promise;
    },
  };
  return { state, recorder, gates, store, adapters };
}

/** 放行 prepare 并停在 credential gate（credential 已调用）。 */
async function reachCredential(h: Harness) {
  h.gates.prepare.resolve('PREPARED-SYNTH');
  await tick();
  expect(h.recorder.credentialCalls).toBe(1);
}

/** 放行 credential 并停在 send gate（send 已调用）。 */
async function reachSend(h: Harness) {
  await reachCredential(h);
  h.gates.credential.resolve('SECRET-SYNTH');
  await tick();
  expect(h.recorder.sendCalls).toBe(1);
}

/** 断言结果 fixed failed 且不泄露 canary（metadata-only）。 */
async function expectFailedNoLeak(run: Promise<{ outcome: string }>) {
  const result = await run;
  expect(result.outcome).toBe('failed');
  expect(JSON.stringify(result)).not.toMatch(/CANARY/);
}

describe('runPublicationAction：门控与 adapter 缺失', () => {
  it('非 enabled → not_enabled，零回调', async () => {
    const h = harness();
    h.state.setNotEnabled();
    await expect(runPublicationAction(h.store, h.adapters)).resolves.toEqual({ outcome: 'not_enabled' });
    expect(h.recorder).toMatchObject({ prepareCalls: 0, credentialCalls: 0, sendCalls: 0 });
  });

  it('adapters 缺省/缺失/不可调用 → unconfigured，零回调', async () => {
    const h = harness();
    const { prepare, readCredential, send } = h.adapters;
    const variants: PublicationActionAdapters[] = [
      {}, // 全缺
      { prepare, readCredential }, // 缺 send
      { prepare, send }, // 缺 readCredential
      { prepare: undefined, readCredential: undefined, send: undefined }, // 全部 undefined
    ];
    for (const adapters of variants) {
      await expect(runPublicationAction(h.store, adapters)).resolves.toEqual({ outcome: 'unconfigured' });
    }
    // 缺省第二参同样 unconfigured。
    await expect(runPublicationAction(h.store)).resolves.toEqual({ outcome: 'unconfigured' });
    expect(h.recorder).toMatchObject({ prepareCalls: 0, credentialCalls: 0, sendCalls: 0 });
  });
});

describe('runPublicationAction：pinned context 与成功全序', () => {
  it('三回调同一 frozen context；全序 → completed', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    expect(h.recorder.prepareCalls).toBe(1); // 已同步停在 prepare gate
    h.gates.prepare.resolve('PREPARED-SYNTH');
    await tick();
    expect(h.recorder.credentialCalls).toBe(1); // 已停在 credential gate
    h.gates.credential.resolve('SECRET-SYNTH');
    await tick();
    expect(h.recorder.sendCalls).toBe(1); // 已停在 send gate
    h.gates.send.resolve();
    await expect(run).resolves.toEqual({ outcome: 'completed' });
    expect(h.recorder).toMatchObject({ prepareCalls: 1, credentialCalls: 1, sendCalls: 1 });
    expect(h.recorder.prepared).toEqual(['PREPARED-SYNTH']);
    expect(h.recorder.secrets).toEqual(['SECRET-SYNTH']);
    expect(h.recorder.contexts).toHaveLength(3);
    expect(new Set(h.recorder.contexts).size).toBe(1); // pinned
    expect(Object.isFrozen(h.recorder.contexts[0])).toBe(true);
    expect(h.recorder.contexts.map((c) => c.controlRevision)).toEqual([4, 4, 4]);
  });
});

describe('runPublicationAction：phase 间变化（stop/config/epoch）', () => {
  it('prepare 期间 stop/config 变化 → stale，阻止 credential+send', async () => {
    const changes: Array<(h: Harness) => void> = [
      (h) => h.state.setNotEnabled(),
      (h) => h.state.setEnabled(CTX_B),
    ];
    for (const change of changes) {
      const h = harness();
      const run = runPublicationAction(h.store, h.adapters);
      expect(h.recorder.prepareCalls).toBe(1); // 已同步停在 prepare gate
      change(h); // prepare 尚未返回：变化落在 prepare 期间
      h.gates.prepare.resolve('PREPARED');
      await expect(run).resolves.toEqual({ outcome: 'stale' });
      expect(h.recorder).toMatchObject({ credentialCalls: 0, sendCalls: 0 });
    }
  });

  it('credential 期间变化 → stale，阻止 send', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    await reachCredential(h);
    h.state.setEnabled(CTX_B); // credential 尚未返回：变化在 credential 期间
    h.gates.credential.resolve('SECRET');
    await expect(run).resolves.toEqual({ outcome: 'stale' });
    expect(h.recorder).toMatchObject({ credentialCalls: 1, sendCalls: 0 });
  });

  it('send 期间变化 → stale（已传输边界，send 已调用）', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    await reachSend(h);
    h.state.setNotEnabled(); // send 尚未返回：变化在 send 期间
    h.gates.send.resolve();
    await expect(run).resolves.toEqual({ outcome: 'stale' });
    expect(h.recorder.sendCalls).toBe(1);
  });
});

describe('runPublicationAction：store 异常收敛（fixed failed，不泄露）', () => {
  it('store 在 start 抛 canary → failed，零回调', async () => {
    const h = harness();
    h.state.setPoisoned();
    await expectFailedNoLeak(runPublicationAction(h.store, h.adapters));
    expect(h.recorder).toMatchObject({ prepareCalls: 0, credentialCalls: 0, sendCalls: 0 });
  });

  it('store 在 prepare 后重检抛 canary → failed，阻止 credential+send', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    expect(h.recorder.prepareCalls).toBe(1); // 已停在 prepare gate
    h.state.setPoisoned(); // prepare 后重检会遇到存储异常
    h.gates.prepare.resolve('PREPARED');
    await expectFailedNoLeak(run);
    expect(h.recorder).toMatchObject({ credentialCalls: 0, sendCalls: 0 });
  });

  it('store 在 send 后最终重检抛 canary → failed（send 已执行，结果不泄露）', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    await reachSend(h);
    h.state.setPoisoned(); // send 期间/最终重检时存储异常
    h.gates.send.resolve();
    await expectFailedNoLeak(run);
    expect(h.recorder.sendCalls).toBe(1);
  });
});

describe('runPublicationAction：credential/adapter 失败（metadata-only）', () => {
  it('readCredential 返回 null/undefined/空串/非 string → failed 且零 send（坏值不转发）', async () => {
    const badValues: unknown[] = [null, undefined, '', 42];
    for (const bad of badValues) {
      const h = harness();
      const run = runPublicationAction(h.store, h.adapters);
      await reachCredential(h);
      h.gates.credential.resolve(bad as string | null | undefined);
      await expect(run).resolves.toEqual({ outcome: 'failed' });
      expect(h.recorder).toMatchObject({ prepareCalls: 1, sendCalls: 0, secrets: [] });
    }
  });

  it('send 抛 canary → failed 且结果不泄露（metadata-only）', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    await reachSend(h);
    h.gates.send.reject(new Error('boom CANARY-SECRET-9c2f'));
    await expectFailedNoLeak(run);
    expect(h.recorder.sendCalls).toBe(1);
  });

  it('prepare 抛错 → failed，credential/send 零调用', async () => {
    const h = harness();
    const run = runPublicationAction(h.store, h.adapters);
    expect(h.recorder.prepareCalls).toBe(1);
    h.gates.prepare.reject(new Error('prepare blew up'));
    await expectFailedNoLeak(run);
    expect(h.recorder).toMatchObject({ credentialCalls: 0, sendCalls: 0 });
  });
});
