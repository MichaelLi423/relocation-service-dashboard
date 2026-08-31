import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { IPC_CHANNELS, type AccountSessionInfo, type IpcChannel } from '../../src/shared/ipc';
import { registerIpcHandlers, type IpcBus, type IpcEvent, type IpcHandlerDeps } from '../../src/main/ipc-handlers';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import type { ImportWizardFacade } from '../../src/main/import-wizard-facade';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanupTempDir));

class Bus implements IpcBus {
  handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: IpcEvent, ...args: unknown[]) => unknown): void { this.handlers.set(channel, listener); }
  invoke(channel: IpcChannel, ...args: unknown[]): unknown {
    return this.handlers.get(channel)!({ sender: { id: 1 }, senderFrame: { url: 'http://localhost:3000/' } }, ...args);
  }
}

describe('记录编辑 IPC', () => {
  it('经既有 workbench v2 mutation/tag-mutate 通道分发编辑命令', async () => {
    const dir = makeTempDir('record-editing-ipc-');
    dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
    const bus = new Bus();
    const unavailable = new Proxy({}, { get: () => () => { throw new Error('unavailable'); } }) as ImportWizardFacade;
    const deps: IpcHandlerDeps = {
      db: () => db, dbPath: () => join(dir, 'workbench.db'), dataDir: () => dir,
      accountService: () => new LocalAccountService(new SqliteAccountRepository(db)),
      session: () => ({ accountId: account.id, username: account.username } satisfies AccountSessionInfo), setSession: () => undefined,
      trustedSenderId: () => 1, trustedSenderOrigin: () => 'http://localhost:3000/', autoBackupError: () => null,
      showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), writeFile: async () => undefined,
      createManualBackup: async () => '', createCleanupBackup: async () => '', restoreFromBackup: () => ({ restored: false }),
      importWizardFacade: () => unavailable, importWizardEnabled: () => true, importWizardError: () => null,
    };
    registerIpcHandlers(bus, deps);
    const created = bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'create_project', payload: { intent: 'draft', customerName: 'IPC 编辑客户', region: 'East' } }) as { changed: { projectId: string } };
    const projectId = created.changed.projectId;
    bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '仪器', serialNo: 'IPC-SN', ups: false, qrRequested: false } } });
    const instrumentId = (db.prepare('SELECT id FROM instruments').get() as { id: string }).id;
    const payload = { instrumentId, manufacturer: 'IPC 厂商', model: 'IPC-M', serviceLevel: '标准', serialNo: 'IPC-SN', ups: true, qrRequested: false, batchId: null };
    const update = bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'instrument_update', payload }) as { invalidated: string[] };
    expect(update.invalidated).toEqual(expect.arrayContaining([`project:${projectId}`, `sections:${projectId}`]));
    expect(db.prepare('SELECT model,ups FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ model: 'IPC-M', ups: 1 });
    expect(() => bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'instrument_update', payload: { ...payload, name: '越权名称' } })).toThrow(/不允许字段/);
    const instrumentRevision = readBusinessRevision(db);
    const instrumentUpdatedAt = (db.prepare('SELECT updated_at FROM instruments WHERE id=?').get(instrumentId) as { updated_at: string }).updated_at;
    const identical = bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'instrument_update', payload }) as { businessRevision: number };
    expect(identical.businessRevision).toBe(instrumentRevision);
    expect(db.prepare('SELECT updated_at FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ updated_at: instrumentUpdatedAt });
    expect(() => bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'instrument_update', payload, name: '越权名称' } as never)).toThrow(/不允许字段/);
    bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'submit_action', projectId, action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'IPC-SO-1', orderedAt: '2026-08-10', engineer: '工程师' } } });
    const orderId = (db.prepare('SELECT id FROM service_orders').get() as { id: string }).id;
    expect(() => bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'service_order_note_update', payload: { orderId, note: '备注', orderedAt: '2026-08-11' } })).toThrow(/不允许字段/);
    expect(() => bus.invoke(IPC_CHANNELS.workbenchV2Mutate, { op: 'service_order_note_update', payload: { orderId, note: '备注' }, serviceOrderNo: '越权单号' } as never)).toThrow(/不允许字段/);

    const group = bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, { command: 'create_group', payload: { name: 'IPC 原分组' } }) as { ok: true; data: { group: { id: string } } };
    const renamed = bus.invoke(IPC_CHANNELS.workbenchV2TagMutate, { command: 'rename_group', payload: { groupId: group.data.group.id, name: ' IPC 新分组 ' } }) as { ok: true; data: { group: { id: string; name: string }; invalidated: string[] } };
    expect(renamed).toMatchObject({ ok: true, data: { group: { id: group.data.group.id, name: 'IPC 新分组' }, invalidated: ['tag_catalog', 'projects', 'reminders'] } });
  });
});
