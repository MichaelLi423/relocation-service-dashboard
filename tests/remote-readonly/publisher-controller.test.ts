/**
 * publisher-controller.test.ts（tasks 2.3 controller 切片）
 * 真实临时 SQLite（fixture 沿用 control-store.test.ts）验证五个状态方法委托 store 并
 * 返回安全 DTO；store 损坏 → unavailable、写路径 fail closed；静态断言无 network/vault/
 * 外发面（按设计不存在）。全 synthetic。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CONSENT_PROJECTION_VERSION,
  CONSENT_RETENTION_EXPLANATION_VERSION,
  fieldScopeDigest,
} from '../../src/main/remote-readonly/consent';
import { CONTROL_DB_NAME } from '../../src/main/remote-readonly/control-paths';
import {
  ControlStoreError,
  openControlStore,
  type OpenControlStoreOptions,
} from '../../src/main/remote-readonly/control-store';
import { PublisherController } from '../../src/main/remote-readonly/controller';

const TARGET = 'https://publish.synth.test';
const TARGET_B = 'https://publish-alt.synth.test';
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';
const PUBLISHER = 'pub-synth-1';

const rootsToClean: string[] = [];
type Fixture = ReturnType<typeof newFixture>;
function newFixture() {
  const root = join(realpathSync(tmpdir()), `publisher-controller-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rootsToClean.push(root);
  const privateParentDir = join(root, 'app-private');
  const backupDir = join(root, 'business', 'backups');
  mkdirSync(privateParentDir, { recursive: true, mode: 0o700 });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const businessDbPath = join(root, 'business', 'workbench.db');
  writeFileSync(businessDbPath, 'SYNTHETIC-BUSINESS-DB-BYTES-NO-REAL-VALUE');
  return { privateParentDir, businessDbPath, backupDir };
}

function opts(f: Fixture): OpenControlStoreOptions {
  return { privateParentDir: f.privateParentDir, businessDbPaths: [f.businessDbPath], businessBackupDirs: [f.backupDir] };
}

function dbPathOf(f: Fixture): string {
  return join(f.privateParentDir, 'remote-readonly-control', CONTROL_DB_NAME);
}

function open(f: Fixture) {
  const store = openControlStore(opts(f));
  return { store, controller: new PublisherController(store) };
}

function descriptor(target: string) {
  return {
    targetHttpsOrigin: target,
    projectionVersion: CONSENT_PROJECTION_VERSION,
    fieldScopeDigest: fieldScopeDigest(),
    retentionExplanationVersion: CONSENT_RETENTION_EXPLANATION_VERSION,
  };
}

function binding(target: string) {
  return {
    publisherId: PUBLISHER,
    authorizationEpoch: 7,
    databaseInstanceId: UUID_A,
    contentGenerationId: target === TARGET ? UUID_B : UUID_A,
  };
}

function fullConsent(target = TARGET) {
  return {
    ...descriptor(target),
    ...binding(target),
    targetConfirmed: true,
    scopeConfirmed: true,
    retentionConfirmed: true,
  };
}

function expectStoreReject(fn: () => unknown, code?: string): void {
  let threw: unknown;
  try { fn(); } catch (err) { threw = err; }
  expect(threw).toBeInstanceOf(ControlStoreError);
  if (code !== undefined) expect((threw as ControlStoreError).code).toBe(code);
}

afterEach(() => {
  for (const root of rootsToClean) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  rootsToClean.length = 0;
});

describe('publisher controller：状态/配置/确认/停止/失效（安全 DTO）', () => {
  it('全新库：available + disabled + configured=false + revision 0', () => {
    const f = newFixture();
    const { store, controller } = open(f);
    expect(controller.readStatus()).toEqual({ available: true, state: 'disabled', configured: false, revision: 0 });
    store.close();
  });

  it('configure 后仍 disabled（configured=true，revision 1，不自动启用）', () => {
    const f = newFixture();
    const { store, controller } = open(f);
    const s = controller.configure(descriptor(TARGET), binding(TARGET));
    expect(s).toEqual({ available: true, state: 'disabled', configured: true, revision: 1 });
    expect(controller.readStatus()).toEqual(s); // DTO 无 consent/secret/path 面
    store.close();
  });

  it('confirmAndEnable：三项字面 true 且精确匹配才 enabled；不匹配被 store 拒绝', () => {
    const f = newFixture();
    const { store, controller } = open(f);
    controller.configure(descriptor(TARGET), binding(TARGET));
    expectStoreReject(() => controller.confirmAndEnable(fullConsent(TARGET_B)));
    expect(controller.readStatus().state).toBe('disabled');
    expect(controller.confirmAndEnable(fullConsent())).toEqual({
      available: true, state: 'enabled', configured: true, revision: 2,
    });
    store.close();
  });

  it('stopLocally 后 reopen 保持 localStopped（配置仍在，不自动恢复）', () => {
    const f = newFixture();
    const a = open(f);
    a.controller.configure(descriptor(TARGET), binding(TARGET));
    a.controller.confirmAndEnable(fullConsent());
    expect(a.controller.stopLocally()).toMatchObject({ state: 'localStopped', configured: true, revision: 3 });
    a.store.close();

    const b = open(f);
    expect(b.controller.readStatus()).toMatchObject({ state: 'localStopped', configured: true, revision: 3 });
    b.store.close();
  });

  it('binding 变化使已启用配置失效（须重新确认）；invalidateConfiguration 同样清 consent', () => {
    const f = newFixture();
    const { store, controller } = open(f);
    controller.configure(descriptor(TARGET), binding(TARGET));
    controller.confirmAndEnable(fullConsent());
    expect(controller.readStatus().state).toBe('enabled');

    expect(controller.configure(descriptor(TARGET_B), binding(TARGET_B))).toMatchObject({
      state: 'disabled', configured: true, revision: 3,
    });
    expectStoreReject(() => controller.confirmAndEnable(fullConsent(TARGET))); // 旧 consent 不匹配

    controller.confirmAndEnable(fullConsent(TARGET_B));
    expect(controller.readStatus().state).toBe('enabled');
    expect(controller.invalidateConfiguration()).toMatchObject({ state: 'disabled', configured: true, revision: 5 });
    store.close();
  });

  it('store 损坏：readStatus → unavailable；写路径 → CONTROL_DB_CORRUPT', () => {
    const f = newFixture();
    const { store, controller } = open(f);
    controller.configure(descriptor(TARGET), binding(TARGET));
    const raw = new DatabaseSync(dbPathOf(f));
    raw.prepare('UPDATE control_state SET state_json = ? WHERE id = 1').run('{not-json');
    raw.close();

    expect(controller.readStatus()).toEqual({ available: false, state: 'unavailable', configured: false, revision: 0 });
    expectStoreReject(() => controller.configure(descriptor(TARGET), binding(TARGET)), 'CONTROL_DB_CORRUPT');
    store.close();
  });
});

describe('publisher controller：无 network/vault/外发调用面（按设计不存在）', () => {
  it('controller.ts 只从 consent/control-store 导入，无 requestOutboundPublish/adapter/fetch/vault import', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'remote-readonly', 'controller.ts'), 'utf8');
    const imported = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(imported).toEqual(['./consent', './control-store']);
    expect(source).not.toMatch(/requestOutboundPublish|credential-vault|keyring|\bfetch\s*\(|node:https|OutboundAdapter/);
  });
});
