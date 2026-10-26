import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase, prepareReadBigInt } from '../../src/domain/capabilities/local-data-persistence/connection';
import { readBusinessRevision } from '../../src/domain/capabilities/local-data-persistence/identity';
import { buildExportSections, ReportingExportService, REPORT_FILTER_FIELDS, REPORT_METRIC_KEYS } from '../../src/domain/capabilities/operational-reporting';
import { WorkbenchFacade } from '../../src/main/workbench-facade';
import { seedHistoricalBatch } from '../helpers/historical-batch';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(cleanupTempDir));
function setup() {
  const dir = makeTempDir('logistics-retirement-');
  dirs.push(dir);
  const { db } = bootstrapDatabase({ dataDir: dir });
  db.prepare('INSERT INTO accounts (id,username,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('actor', '负责人', 'hash', 'salt', 't', 't');
  const facade = new WorkbenchFacade(db, () => ({ accountId: 'actor', username: '负责人' }));
  const projectId = facade.v2Mutate({ op: 'create_project', payload: { intent: 'formal', customerName: '下线回归客户', region: 'East', siteConfirmed: false, ecc: 'LOGISTICS-RETIRED', contractAmount: '1000', entryAt: '2026-07-01' } }).changed!.projectId!;
  const batchId = seedHistoricalBatch(db, projectId, { planTransportDate: '2026-07-10', transportCompany: '历史公司', appliedAt: '2026-07-09', budgetPrice: '100', dealPrice: '90' });
  facade.v2Mutate({ op: 'submit_action', projectId, action: { type: 'instrument', projectId, values: { name: '历史关联仪器', ups: false, qrRequested: false, batchId } } });
  const snapshot = () => ({
    batches: prepareReadBigInt(db, 'SELECT * FROM batches ORDER BY id').all(),
    fees: prepareReadBigInt(db, 'SELECT * FROM logistics_fees ORDER BY id').all(),
    instruments: prepareReadBigInt(db, 'SELECT * FROM instruments ORDER BY id').all(),
    revision: readBusinessRevision(db),
  });
  return { db, facade, projectId, batchId, snapshot };
}

describe('物流费用与运输批次功能下线', () => {
  it('公共 batch/logistics/batch_edit 全部拒绝且 revision 与历史数据零变化', () => {
    const { db, facade, projectId, batchId, snapshot } = setup();
    const before = snapshot();
    for (const type of ['batch', 'logistics'] as const) {
      expect(() => facade.v2Mutate({ op: 'submit_action', projectId, action: { type, projectId, values: { batchId, budgetPrice: '200', dealPrice: '180', cost: '180' } } })).toThrow(/已下线/);
      expect(snapshot()).toEqual(before);
    }
    expect(() => facade.v2Mutate({ op: 'batch_edit', payload: { batchId, transportCompany: '新公司', budgetPrice: '200', appliedAt: null } })).toThrow(/已下线/);
    expect(snapshot()).toEqual(before);
    closeDatabase(db);
  });

  it('项目计划运输日期可修改清空，历史批次费用与仪器关联不受影响', () => {
    const { db, facade, projectId, batchId, snapshot } = setup();
    const before = snapshot();
    facade.v2Mutate({ op: 'update_project', payload: { projectId, plannedTransportAt: '2099-08-12' } });
    expect(facade.v2ProjectDetail(projectId).detail!.planTransportAt).toBe('2099-08-12');
    facade.v2Mutate({ op: 'update_project', payload: { projectId, plannedTransportAt: null } });
    expect(facade.v2ProjectDetail(projectId).detail!.planTransportAt).toBeNull();
    const after = snapshot();
    expect(after.batches).toEqual(before.batches);
    expect(after.fees).toEqual(before.fees);
    expect(after.instruments).toEqual(before.instruments);
    expect(after.instruments[0].batch_id).toBe(batchId);
    closeDatabase(db);
  });

  it('公共报表指标下钻与 Excel PNG PDF 无物流统计区段及运输公司筛选', async () => {
    const { db, facade, snapshot } = setup();
    const before = snapshot();
    const filter = { monthFrom: '2026-07', monthTo: '2026-07', transportCompany: '历史公司' };
    const retired = ['monthly_logistics', 'logistics_contract_ratio', 'pending_logistics_list'];
    for (const key of retired) {
      expect(REPORT_METRIC_KEYS).not.toContain(key);
      expect(() => facade.drillDown(key, filter)).toThrow(/物流费用统计已下线/);
    }
    expect(REPORT_FILTER_FIELDS).not.toContain('transportCompany');
    const dto = facade.reportDto(filter);
    expect(dto.sections.some((s) => retired.includes(s.key))).toBe(false);
    expect(dto.filters).not.toHaveProperty('transportCompany');
    const report = facade.report(filter);
    expect(report.monthlyLogistics).toHaveLength(1); // 内部历史兼容结构仍可读取，绝不导出。
    expect(buildExportSections(report).some((s) => retired.includes(s.key))).toBe(false);
    const exporter = new ReportingExportService();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exporter.exportExcel(report) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const excelText = JSON.stringify(workbook.worksheets[0].getSheetValues());
    expect(excelText).not.toMatch(/物流费用|物流成交价|历史异常批次|TransportCompany|历史公司/);
    const pdf = await PDFDocument.load(await exporter.exportPdf(report));
    const png = exporter.exportPng(report);
    let pngMeta = '';
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'tEXt') {
        const chunk = png.subarray(offset + 8, offset + 8 + length).toString('utf8');
        if (chunk.startsWith('Report\0')) pngMeta = chunk.slice(7);
      }
      offset += length + 12;
    }
    expect(pngMeta).not.toBe('');
    for (const meta of [JSON.parse(pdf.getSubject()!), JSON.parse(pngMeta)]) {
      expect(meta.sections.some((s: { key: string }) => retired.includes(s.key))).toBe(false);
      expect(meta.filters).not.toHaveProperty('transportCompany');
    }
    expect(snapshot()).toEqual(before);
    closeDatabase(db);
  });
});
