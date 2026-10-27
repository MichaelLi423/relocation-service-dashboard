import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { WorkbenchReadRepository } from '../../src/domain/capabilities/local-data-persistence/workbench-read-repository';
import { FixedClock } from '../../src/domain/core/time';
import { buildMobileReadonlySnapshot } from '../../src/main/mobile-readonly/snapshot';
import { validateMobileReadonlySnapshot } from '../../src/shared/mobile-readonly';
import { makeSnapshotFixture, makeSnapshotV2Fixture, seedSyntheticProject, seedSyntheticProjectRecords } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) cleanupTempDir(dir); });

describe('v1/v2 严格白名单', () => {
  it('开发合成脚本默认 v2，并可显式生成旧 v1；两者均符合严格契约', () => {
    const { buildSyntheticSnapshot } = require('../../scripts/mobile-readonly-synthetic.cjs');
    for (const schemaVersion of [1, 2]) {
      const snapshot = buildSyntheticSnapshot({ schemaVersion, projectCount: 2, firstProjectRecords: 2 });
      expect(snapshot.schemaVersion).toBe(schemaVersion);
      expect(validateMobileReadonlySnapshot(snapshot)).toEqual({ ok: true });
    }
    expect(buildSyntheticSnapshot().schemaVersion).toBe(2);
  });
  it('v1 原字段仍合法，v2 授权字段不会反向进入 v1 白名单', () => {
    expect(validateMobileReadonlySnapshot(makeSnapshotFixture())).toEqual({ ok: true });
    expect(validateMobileReadonlySnapshot(makeSnapshotV2Fixture())).toEqual({ ok: true });
    expect(validateMobileReadonlySnapshot({ ...makeSnapshotV2Fixture(), schemaVersion: 1 }).ok).toBe(false);
    expect(validateMobileReadonlySnapshot({ ...makeSnapshotFixture(), schemaVersion: 2 }).ok).toBe(false);
  });

  it('v2 每个新增必填字段缺失或 undefined 均拒绝，null 与未知不互转', () => {
    const sample = makeSnapshotV2Fixture();
    const targets = [
      [sample.overview.metrics, ['reminderCount', 'reminderOverdue', 'reminderToday', 'openRepairProjects']],
      [sample.projects[0], ['detail', 'reminderAt', 'reminderDueClass', 'groupedTags']],
      [sample.projects[0].detail, Object.keys(sample.projects[0].detail)],
      [sample.projects[0].records.instruments[0], ['manufacturer', 'serviceLevel', 'qrRequested']],
      [sample.projects[0].records.orders[0], ['customerName']],
      [sample.projects[0].records.damage_items[0], ['partStatus']],
    ] as const;
    for (const [target, keys] of targets) for (const key of keys) {
      const record = target as unknown as Record<string, unknown>;
      const original = record[key];
      delete record[key];
      expect(validateMobileReadonlySnapshot(sample).ok, `missing ${key}`).toBe(false);
      record[key] = undefined;
      expect(validateMobileReadonlySnapshot(sample).ok, `undefined ${key}`).toBe(false);
      record[key] = original;
    }
    expect(validateMobileReadonlySnapshot(sample).ok).toBe(true);
  });

  it('嵌套标签未知 key、错误数组/标量/日期类型拒绝', () => {
    const mutations = [
      (s: any) => { s.projects[0].groupedTags[0].leak = '禁止文本哨兵'; },
      (s: any) => { s.projects[0].groupedTags[0].tagIds = [42]; },
      (s: any) => { s.projects[0].groupedTags[0].tagNames = null; },
      (s: any) => { s.projects[0].detail.isTemporaryStorage = 'false'; },
      (s: any) => { s.projects[0].detail.temporaryInstrumentCount = -1; },
      (s: any) => { s.projects[0].detail.contractEndDate = '2026-02-30'; },
      (s: any) => { s.projects[0].reminderDueClass = 'other'; },
      (s: any) => { s.projects[0].records.instruments[0].qrRequested = null; },
      (s: any) => { s.projects[0].records.damage_items[0].partStatus = 'arbitrary'; },
    ];
    for (const mutate of mutations) {
      const sample = makeSnapshotV2Fixture(); mutate(sample);
      expect(validateMobileReadonlySnapshot(sample).ok).toBe(false);
    }
  });

  it.each([1, 2])('v%s 禁止其他自由备注及原因，即使值是普通字符串也拒绝', version => {
    const paths = ['projectNote', 'cancelReason', 'managerApprovalReason', 'note', 'repairNote', 'damageReason', 'revokeReason'];
    for (const key of paths) {
      const sample = version === 1 ? makeSnapshotFixture() : makeSnapshotV2Fixture();
      for (const target of [sample.projects[0], sample.projects[0].detail, sample.projects[0].records.orders[0], sample.projects[0].records.damage_items[0], sample.projects[0].records.invoices[0]]) {
        if (!target) continue;
        (target as unknown as Record<string, unknown>)[key] = '禁止文本哨兵';
        expect(validateMobileReadonlySnapshot(sample).ok).toBe(false);
        delete (target as unknown as Record<string, unknown>)[key];
      }
    }
  });
});

describe('SQLite v2 逐字段授权投影', () => {
  it('同事务读取真实 DTO 的联系人地址、提醒和记录字段，禁止备注不外发', () => {
    const dir = makeTempDir('mobile-v2-'); dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      const { projectId } = seedSyntheticProject(db, { index: 0 });
      db.prepare('INSERT INTO project_tag_groups (id, name, sort_order) VALUES (?, ?, ?)')
        .run('mobile-v2-group', '合成数据库标签组', 999);
      db.prepare('INSERT INTO project_tag_definitions (id, group_id, name, sort_order) VALUES (?, ?, ?, ?)')
        .run('mobile-v2-tag', 'mobile-v2-group', '合成数据库标签', 10);
      db.prepare('INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?, ?)')
        .run(projectId, 'mobile-v2-tag');
      seedSyntheticProjectRecords(db, projectId, { instruments: 1, orders: 1, damageItems: 1, invoices: 2 });
      db.prepare(`UPDATE projects SET old_site_contact = ?, temporary_storage_address = ?, reminder_at = ?, reminder_note = ?, project_note = ? WHERE id = ?`)
        .run('合成联系人 13800000000', '合成暂存详细地址', '2026-08-08', '授权提醒哨兵', '禁止文本哨兵', projectId);
      db.prepare(`UPDATE instruments SET manufacturer = '合成厂家', service_level = '合成等级' WHERE project_id = ?`).run(projectId);
      db.prepare(`UPDATE projects SET is_temporary_storage = 1, contract_start_date = '2026-08-01',
        contract_end_date = '2026-08-31', plan_transport_at = '2026-08-09', planned_install_done_at = '2026-08-10',
        actual_install_done_at = '2026-08-11', site_confirmed = 1, acceptance_report = 1,
        acceptance_report_date = '2026-08-12', cancelled_at = '2026-08-13', temporary_instrument_count = 3,
        temporary_instrument_name = '合成暂定仪器', temporary_instrument_model = '合成暂定型号', temporary_has_ups = 0 WHERE id = ?`).run(projectId);
      const original = WorkbenchReadRepository.prototype.projectDetail;
      const calls: boolean[] = [];
      vi.spyOn(WorkbenchReadRepository.prototype, 'projectDetail').mockImplementation(function (this: WorkbenchReadRepository, id) {
        calls.push(db.isTransaction); return original.call(this, id);
      });
      const snapshot = buildMobileReadonlySnapshot({ db, clock: new FixedClock('2026-08-08T09:00:00Z') });
      expect(calls).toEqual([true]);
      const project = snapshot.projects[0];
      expect(project.groupedTags).toEqual([{
        groupId: 'mobile-v2-group', groupName: '合成数据库标签组',
        tagIds: ['mobile-v2-tag'], tagNames: ['合成数据库标签'],
      }]);
      expect(project.detail.oldSiteContact).toBe('合成联系人 13800000000');
      expect(project.detail.temporaryStorageAddress).toBe('合成暂存详细地址');
      expect(project.detail.reminderNote).toBe('授权提醒哨兵');
      expect(project.detail).toEqual({
        oldSiteContact: '合成联系人 13800000000', newSiteContact: '新址联系人-0',
        oldSiteAddress: '旧址地址-0 号', newSiteAddress: '新址地址-0 号', temporaryStorageAddress: '合成暂存详细地址',
        isTemporaryStorage: true, contractStartDate: '2026-08-01', contractEndDate: '2026-08-31',
        planTransportAt: '2026-08-09', plannedInstallAt: '2026-08-10', actualInstallDoneAt: '2026-08-11',
        siteConfirmed: true, acceptanceReport: true, acceptanceReportDate: '2026-08-12', cancelledAt: '2026-08-13',
        temporaryInstrumentCount: 3, temporaryInstrumentName: '合成暂定仪器', temporaryInstrumentModel: '合成暂定型号',
        temporaryHasUps: false, reminderNote: '授权提醒哨兵',
      });
      expect(project.reminderAt).toBe('2026-08-08');
      expect(project.reminderDueClass).toBe('today');
      expect(snapshot.overview.metrics.reminderToday).toBe(1);
      expect(project.records.instruments[0]).toMatchObject({ manufacturer: '合成厂家', serviceLevel: '合成等级', qrRequested: true });
      expect(project.records.orders[0].customerName).toBe('移动只读合成客户');
      expect(project.records.damage_items[0].partStatus).toBe('processing');
      const text = JSON.stringify(snapshot);
      for (const forbidden of ['禁止文本哨兵', '维修备注-', '损坏原因-', '撤销原因-', '备注-']) expect(text).not.toContain(forbidden);
    } finally { closeDatabase(db); }
  });

  it('详情缺失直接失败，不伪造 null', () => {
    const dir = makeTempDir('mobile-v2-missing-'); dirs.push(dir);
    const { db } = bootstrapDatabase({ dataDir: dir });
    try {
      seedSyntheticProject(db, { index: 0 });
      const original = WorkbenchReadRepository.prototype.projectDetail;
      vi.spyOn(WorkbenchReadRepository.prototype, 'projectDetail').mockImplementation(function (this: WorkbenchReadRepository, id) {
        return { ...original.call(this, id), detail: null };
      });
      expect(() => buildMobileReadonlySnapshot({ db, clock: new FixedClock('2026-08-08T09:00:00Z') })).toThrow('项目详情缺失');
    } finally { closeDatabase(db); }
  });
});
