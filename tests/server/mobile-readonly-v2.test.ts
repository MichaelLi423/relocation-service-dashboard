import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProjectDetail, buildProjectListPage, buildRecordsPage } from '../../src/server/mobile-readonly/query';
import { createNodeEnvelopeIo, EnvelopeStore } from '../../src/server/mobile-readonly/store';
import { makeSnapshotFixture, makeSnapshotV2Fixture } from '../helpers/mobile-readonly-fixtures';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) cleanupTempDir(dir); });

describe('真实磁盘 v1/v2 启动恢复及替换', () => {
  it('从旧 v1 文件启动，提交 v2 后重启恢复详情，再合法替换为 v1 不残留详情', async () => {
    const dir = makeTempDir('mobile-v2-store-'); dirs.push(dir);
    const snapshotsDir = join(dir, 'snapshots');
    const currentFile = join(snapshotsDir, 'current.json');
    const v1 = makeSnapshotFixture();
    const originalEnvelope = {
      currentVersion: 7, publicationId: 'old-v1-on-disk', publishedAt: '2026-08-08T09:00:00Z', snapshot: v1,
    };
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(currentFile, JSON.stringify(originalEnvelope));
    const restart = () => {
      const store = new EnvelopeStore(createNodeEnvelopeIo(snapshotsDir), { nowIso: () => '2026-08-08T10:00:00Z' });
      store.init();
      return store;
    };
    const first = restart();
    expect(first.currentEnvelope()).toEqual(originalEnvelope);
    expect(first.currentMetadata().snapshotSchemaVersion).toBe(1);
    expect(buildProjectDetail(first.currentEnvelope()!.snapshot, v1.projects[0].id).project).not.toHaveProperty('detail');

    const v2 = makeSnapshotV2Fixture();
    const committed = await first.publish({ publicationId: 'upgrade-v2', expectedCurrentVersion: 7, snapshot: v2 });
    expect(committed.kind).toBe('committed');
    const second = restart();
    expect(second.currentEnvelope()).toEqual(JSON.parse(readFileSync(currentFile, 'utf8')));
    expect(second.currentMetadata()).toMatchObject({ currentVersion: 8, snapshotSchemaVersion: 2, publicationId: 'upgrade-v2' });
    const detail = buildProjectDetail(second.currentEnvelope()!.snapshot, v2.projects[0].id);
    expect(detail.project?.detail).toEqual(v2.projects[0].detail);
    expect(detail.recordCounts).toEqual({ batches: 1, instruments: 1, activities: 1, orders: 1, invoices: 1, damage_items: 1 });

    const replaced = await second.publish({ publicationId: 'later-v1', expectedCurrentVersion: 8, snapshot: v1 });
    expect(replaced.kind).toBe('committed');
    const third = restart();
    expect(third.currentMetadata()).toMatchObject({ currentVersion: 9, snapshotSchemaVersion: 1, publicationId: 'later-v1' });
    expect(third.currentEnvelope()!.snapshot).toEqual(v1);
    const restoredDetail = buildProjectDetail(third.currentEnvelope()!.snapshot, v1.projects[0].id);
    expect(restoredDetail.project).not.toHaveProperty('detail');
    expect(restoredDetail.project).not.toHaveProperty('reminderAt');
    const text = readFileSync(currentFile, 'utf8');
    for (const sensitive of ['oldSiteContact', 'reminderNote', '合成联系人 13800000000', '合成提醒备注']) expect(text).not.toContain(sensitive);
  });
});

describe('v1/v2 查询隔离和有界计数', () => {
  it.each([1, 2])('v%s 详情计数取完整数组，分页 total 不受 limit 影响，列表不泄漏 detail', version => {
    const snapshot = version === 1 ? makeSnapshotFixture() : makeSnapshotV2Fixture();
    const first = snapshot.projects[0];
    first.records.instruments = Array.from({ length: 3 }, (_, index) => ({
      ...first.records.instruments[0], id: `instrument-${index}`,
    }));
    snapshot.projects = [first, { ...first, id: 'second', customerName: 'other' }];
    const list = buildProjectListPage(snapshot, 1, { query: '', status: null, region: null, offset: null, limit: 1 });
    expect(list.total).toBe(2); expect(list.items).toHaveLength(1); expect(list.nextCursor).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain('oldSiteContact');
    expect(JSON.stringify(list)).not.toContain('reminderNote');
    expect(list.items[0]).not.toHaveProperty('detail');
    const filtered = buildProjectListPage(snapshot, 1, { query: 'other', status: null, region: null, offset: null, limit: 1 });
    expect(filtered.total).toBe(1);
    const detail = buildProjectDetail(snapshot, first.id);
    expect(detail.recordCounts).toEqual({ batches: 1, instruments: 3, activities: 1, orders: 1, invoices: 1, damage_items: 1 });
    if (version === 1) {
      expect(detail.project).not.toHaveProperty('detail');
      expect(list.items[0]).not.toHaveProperty('reminderAt');
    } else {
      expect(detail.project?.detail?.oldSiteContact).toBe('合成联系人 13800000000');
      expect(list.items[0].reminderAt).toBe('2026-08-08');
    }
    for (let offset = 0; offset < 3; offset += 1) {
      const page = buildRecordsPage(snapshot, 1, { projectId: first.id, kind: 'instruments', offset, limit: 1 });
      expect(page.total).toBe(3); expect(page.items).toHaveLength(1);
      expect(page.items[0].id).toBe(`instrument-${offset}`);
      expect(page.nextCursor === null).toBe(offset === 2);
    }
    expect(buildProjectDetail(snapshot, 'missing')).toEqual({ project: null });
    expect(buildRecordsPage(snapshot, 1, { projectId: 'missing', kind: 'orders', offset: null, limit: 1 }).total).toBe(0);
  });
});
