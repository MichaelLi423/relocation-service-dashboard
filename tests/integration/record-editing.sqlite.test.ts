import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { SqliteAccountRepository } from '../../src/domain/capabilities/local-data-persistence/repositories';
import { LocalAccountService } from '../../src/domain/capabilities/workbench-access';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import { runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanupTempDir));

async function setup() {
  const dir = makeTempDir('record-editing-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  const { account } = await new LocalAccountService(new SqliteAccountRepository(db)).initialize({ username: '负责人', password: 'password1' });
  return { db, facade: new WorkbenchFacade(db, () => ({ accountId: account.id, username: account.username })) };
}

describe('记录编辑 SQLite 集成', () => {
  it('仪器编辑原子更新字段和批次，同批次不新增改批历史，失败全回滚', async () => {
    const { db, facade } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '仪器编辑客户', region: 'East' } }).changed!.projectId!;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'batch', projectId, values: { planTransportDate: '2026-08-10', appliedAt: '2026-08-09', budgetPrice: '10', dealPrice: '0' } } });
    const batchId = (facade.v2SectionPage({ projectId, kind: 'batches' }).rows[0] as { id: string }).id;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '名称不可改', serialNo: 'SN-1', ups: false, qrRequested: false } } });
    const instrumentId = (facade.v2SectionPage({ projectId, kind: 'instruments' }).rows[0] as { id: string }).id;

    facade.v2Mutate({ op: 'instrument_update', payload: { instrumentId, manufacturer: ' 厂商甲 ', model: ' M-1 ', serviceLevel: ' 金牌 ', serialNo: ' SN-2 ', ups: true, qrRequested: true, batchId } });
    const beforeNoop = readBusinessRevision(db);
    const timestampBeforeNoop = (db.prepare('SELECT updated_at FROM instruments WHERE id=?').get(instrumentId) as { updated_at: string }).updated_at;
    const noop = facade.v2Mutate({ op: 'instrument_update', payload: { instrumentId, manufacturer: '厂商甲', model: 'M-1', serviceLevel: '金牌', serialNo: 'SN-2', ups: true, qrRequested: true, batchId } });
    expect(db.prepare('SELECT name,manufacturer,service_level,serial_no,model,ups,qr_requested,batch_id FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ name: '名称不可改', manufacturer: '厂商甲', service_level: '金牌', serial_no: 'SN-2', model: 'M-1', ups: 1, qr_requested: 1, batch_id: batchId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM batch_change_history WHERE instrument_id=?').get(instrumentId)).toMatchObject({ n: 1 });
    expect(noop.businessRevision).toBe(beforeNoop);
    expect(db.prepare('SELECT updated_at FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ updated_at: timestampBeforeNoop });

    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '另一台仪器', serialNo: 'SN-DUP', ups: false, qrRequested: false } } });
    expect(() => facade.v2Mutate({ op: 'instrument_update', payload: { instrumentId, manufacturer: '厂商甲', model: 'M-1', serviceLevel: '金牌', serialNo: 'SN-DUP', ups: true, qrRequested: true, batchId } })).toThrow(/序列号.*已存在/);
    expect(db.prepare('SELECT serial_no FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ serial_no: 'SN-2' });

    const full = (batch: string | null, model = '不应保存') => ({ op: 'instrument_update' as const, payload: { instrumentId, manufacturer: '不应保存', model, serviceLevel: '不应保存', serialNo: 'SN-3', ups: true, qrRequested: true, batchId: batch } });
    expect(() => facade.v2Mutate(full('missing-batch'))).toThrow(/批次不存在/);
    const otherProjectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '跨项目客户', region: 'East' } }).changed!.projectId!;
    facade.v2Mutate({ op: 'submit_action', projectId: otherProjectId, action: { type: 'batch', projectId: otherProjectId, values: { planTransportDate: '2026-08-10', appliedAt: '2026-08-09', budgetPrice: '10', dealPrice: '0' } } });
    const foreignBatchId = (facade.v2SectionPage({ projectId: otherProjectId, kind: 'batches' }).rows[0] as { id: string }).id;
    expect(() => facade.v2Mutate(full(foreignBatchId))).toThrow(/不属于该搬迁项目/);
    db.prepare('UPDATE batches SET started_at=? WHERE id=?').run('2026-08-10', batchId);
    expect(() => facade.v2Mutate(full(null))).toThrow(/运输开始后禁止直接改批/);
    expect(db.prepare('SELECT model FROM instruments WHERE id=?').get(instrumentId)).toMatchObject({ model: 'M-1' });
  });

  it('服务单仅更新备注且不刷新导入审计；标签重命名保持 ID/排序并粗粒度失效', async () => {
    const { db, facade } = await setup();
    const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'draft', customerName: '标签客户', region: 'East' } }).changed!.projectId!;
    facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'order', projectId, values: { orderType: 'relocation', serviceOrderNo: 'SO-EDIT-1', orderedAt: '2026-08-10', engineer: '工程师' } } });
    const order = facade.v2SectionPage({ projectId, kind: 'orders' }).rows[0] as { id: string; orderType: string; serviceOrderNo: string };
    db.prepare('UPDATE service_orders SET import_source_hash=? WHERE id=?').run('source-hash', order.id);
    db.prepare('INSERT INTO import_record_audit (id,source_key,target_table,target_id,import_source_hash,target_snapshot_hash,imported_at) VALUES (?,?,?,?,?,?,?)').run('audit-order', 'order-source', 'service_orders', order.id, 'source-hash', 'snapshot-hash', '2026-08-10T00:00:00Z');
    facade.v2Mutate({ op: 'service_order_note_update', payload: { orderId: order.id, note: '  新备注  ' } });
    facade.v2Mutate({ op: 'service_order_note_update', payload: { orderId: order.id, note: null } });
    expect(facade.v2SectionPage({ projectId, kind: 'orders' }).rows[0]).toMatchObject({ id: order.id, orderType: 'relocation', serviceOrderNo: 'SO-EDIT-1', note: null });
    expect(db.prepare('SELECT import_source_hash FROM service_orders WHERE id=?').get(order.id)).toMatchObject({ import_source_hash: 'source-hash' });
    expect(db.prepare('SELECT import_source_hash,target_snapshot_hash FROM import_record_audit WHERE id=?').get('audit-order')).toMatchObject({ import_source_hash: 'source-hash', target_snapshot_hash: 'snapshot-hash' });

    const group = (facade.v2TagMutate({ command: 'create_group', payload: { name: '原分组' } }) as { group: { id: string; sortOrder: number } }).group;
    const tag = (facade.v2TagMutate({ command: 'create_tag', payload: { groupId: group.id, name: '原标签' } }) as { tag: { id: string; groupId: string; sortOrder: number } }).tag;
    facade.v2TagMutate({ command: 'replace_project_tags', payload: { projectId, tagIds: [tag.id] } });
    const renamedGroup = facade.v2TagMutate({ command: 'rename_group', payload: { groupId: group.id, name: ' 新分组 ' } });
    const renamedTag = facade.v2TagMutate({ command: 'rename_tag', payload: { tagId: tag.id, name: ' 新标签 ' } });
    expect(renamedGroup).toMatchObject({ group: { id: group.id, sortOrder: group.sortOrder, name: '新分组' }, invalidated: ['tag_catalog', 'projects', 'reminders'] });
    expect(renamedTag).toMatchObject({ tag: { id: tag.id, groupId: group.id, sortOrder: tag.sortOrder, name: '新标签' }, invalidated: ['tag_catalog', 'projects', 'reminders'] });
    expect(() => facade.v2TagMutate({ command: 'rename_tag', payload: { tagId: tag.id, name: '   ' } })).toThrow(/不能为空/);
    const otherGroup = (facade.v2TagMutate({ command: 'create_group', payload: { name: '另一分组' } }) as { group: { id: string } }).group;
    const otherTag = (facade.v2TagMutate({ command: 'create_tag', payload: { groupId: otherGroup.id, name: '新标签' } }) as { tag: { id: string } }).tag;
    expect(otherTag.id).toBeTruthy(); // 跨组同名允许
    facade.v2TagMutate({ command: 'create_tag', payload: { groupId: group.id, name: '组内冲突' } });
    expect(() => facade.v2TagMutate({ command: 'rename_group', payload: { groupId: otherGroup.id, name: '新分组' } })).toThrow(/已存在/);
    expect(() => facade.v2TagMutate({ command: 'rename_tag', payload: { tagId: tag.id, name: '组内冲突' } })).toThrow(/已存在/);
    expect(facade.v2TagCatalog().groups.map((item) => item.name)).toEqual(expect.arrayContaining(['新分组', '另一分组']));
  });

  it('真实导入 forward-fix 遇到人工开单备注时阻塞并零写保留审计基线', async () => {
    const { db, facade } = await setup();
    const workload = SOURCE_TABLE_FILES['workload-stats'];
    const initial: SourceRow[] = [{
      file: workload,
      sheet: '开单记录表',
      rowNumber: 2,
      cells: { 单号: 'SO-FORWARD-FIX', 类型: 'pm', 日期: '2026-08-10T00:00:00+08:00', 工程师: '导入工程师', 客户单位: '导入客户', 备注: '导入原备注' },
    }];
    expect(runImport(db, { rows: initial, mapping: MAPPING_V1 }).batches).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'success' })]));
    const imported = db.prepare('SELECT id,note,engineer,import_source_key,import_source_hash FROM service_orders WHERE service_order_no=?').get('SO-FORWARD-FIX') as {
      id: string; note: string | null; engineer: string; import_source_key: string; import_source_hash: string;
    };
    const auditBefore = db.prepare('SELECT import_source_hash,target_snapshot_hash FROM import_record_audit WHERE source_key=?').get(imported.import_source_key) as {
      import_source_hash: string; target_snapshot_hash: string;
    };

    facade.v2Mutate({ op: 'service_order_note_update', payload: { orderId: imported.id, note: '人工备注保留' } });
    const changed: SourceRow[] = [{
      ...initial[0],
      cells: { ...initial[0].cells, 工程师: '来源修正工程师', 备注: '来源修正备注' },
    }];
    const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });

    expect(result.batches).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed', importedCount: 0, errorDetails: expect.stringMatching(/人工\/外部修改|TARGET_CONFLICT/) }),
    ]));
    expect(db.prepare('SELECT note,engineer,import_source_hash FROM service_orders WHERE id=?').get(imported.id)).toEqual({
      note: '人工备注保留', engineer: '导入工程师', import_source_hash: imported.import_source_hash,
    });
    expect(db.prepare('SELECT import_source_hash,target_snapshot_hash FROM import_record_audit WHERE source_key=?').get(imported.import_source_key)).toEqual(auditBefore);
  });
});
