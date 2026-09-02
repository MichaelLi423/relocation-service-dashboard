import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { PNG } from 'pngjs';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteCustomerRepository,
  SqliteInvoiceReadRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import {
  SqliteBatchRepository,
  SqliteInstrumentRepository,
  SqliteLogisticsFeeRepository,
  SqliteBatchChangeHistoryRepository,
  SqliteActivityRepository,
  SqliteActivityEngineerRepository,
  SqliteWorkFactRepository,
} from '../../src/domain/capabilities/local-data-persistence/execution-repositories';
import { SqliteServiceOrderRepository } from '../../src/domain/capabilities/local-data-persistence/service-order-repositories';
import { SqliteInvoiceRepository } from '../../src/domain/capabilities/local-data-persistence/financial-repositories';
import {
  SqliteActivityDamageLinkRepository,
  SqliteContractAmountReader,
  SqliteDamageInstrumentReader,
  SqliteDamageRepairItemRepository,
  SqliteRepairActivityReader,
} from '../../src/domain/capabilities/local-data-persistence/damage-repair-repositories';
import {
  SqliteShipToAddressReader,
  SqliteShipToRepository,
  SqliteShipToRequestRepository,
} from '../../src/domain/capabilities/local-data-persistence/ship-to-repositories';
import { SqliteQrRequestRepository } from '../../src/domain/capabilities/local-data-persistence/qr-request-repositories';
import {
  SqliteInstrumentAddressReader,
  SqliteSerialAddressUpdateRepository,
} from '../../src/domain/capabilities/local-data-persistence/serial-address-update-repositories';
import { SqliteReportingFactReader } from '../../src/domain/capabilities/local-data-persistence/reporting-fact-reader';
import {
  ReportingService,
  ReportingExportService,
  pngBarLabel,
  pngBarHeight,
  type ReportModel,
} from '../../src/domain/capabilities/operational-reporting';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { CustomerService } from '../../src/domain/capabilities/relocation-project-lifecycle/customer-service';
import { FinancialClosureService } from '../../src/domain/capabilities/project-financial-closure/financial-closure-service';
import { ExecutionService } from '../../src/domain/capabilities/relocation-execution/execution-service';
import type { ExecutionLifecycleGateway } from '../../src/domain/capabilities/relocation-execution/execution-service';
import { ServiceOrderService } from '../../src/domain/capabilities/service-order-recording/service-order-service';
import { DamageRepairService } from '../../src/domain/capabilities/damage-repair-tracking/damage-repair-service';
import { ShipToService } from '../../src/domain/capabilities/ship-to-management/ship-to-service';
import { QrRequestService } from '../../src/domain/capabilities/qr-request-tracking/qr-request-service';
import { SerialAddressUpdateService } from '../../src/domain/capabilities/serial-address-update/serial-address-update-service';
import { Money } from '../../src/domain/core/money';
import { FixedClock } from '../../src/domain/core/time';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';
import { makeAccount } from '../helpers/fact-builder';

/**
 * operational-reporting SQLite 集成（tasks 7.11）。
 * 跨模块真实 SQLite：进单快照/掉票/开单/损坏/物流/工作量统计与各模块事实联动，
 * 事后掉票编辑、撤销、取消、区域修改、账号改名快照实时反映；三种导出
 * （Excel/PNG/PDF）通过 magic header 与内容测试且与同次实时 report model 一致。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function openService(dataDir: string) {
  const { db, dbPath } = bootstrapDatabase({ dataDir });
  db.prepare(
    'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run('account-1', '负责人甲', 'hash', 'salt', 't', 't');

  const projects = new SqliteProjectRepository(db);
  const contracts = new SqliteContractRepository(db);
  const invoiceRead = new SqliteInvoiceReadRepository(db);
  const projectService = new ProjectService(projects, contracts, invoiceRead, CLOCK);
  const invoices = new SqliteInvoiceRepository(db);
  const financialGateway = {
    reevaluateStatus: (projectId: string) => {
      const project = projects.findById(projectId)!;
      projectService.adjustStatus(projectId, project.status);
    },
  } as const;
  const financial = new FinancialClosureService(
    projects,
    contracts,
    invoices,
    financialGateway,
    CLOCK,
  );

  const batches = new SqliteBatchRepository(db);
  const instruments = new SqliteInstrumentRepository(db);
  const fees = new SqliteLogisticsFeeRepository(db);
  const executionGateway: ExecutionLifecycleGateway = {
    onExecutionStarted: (pid) => {
      projectService.adjustStatus(pid, 'executing', { executionStarted: true });
    },
  };
  const execution = new ExecutionService(
    batches,
    instruments,
    new SqliteBatchChangeHistoryRepository(db),
    new SqliteActivityRepository(db),
    new SqliteActivityEngineerRepository(db),
    new SqliteWorkFactRepository(db),
    fees,
    executionGateway,
    CLOCK,
  );

  const orders = new SqliteServiceOrderRepository(db);
  const orderService = new ServiceOrderService(orders, projects, CLOCK);

  const damages = new SqliteDamageRepairItemRepository(db);
  const damageService = new DamageRepairService(
    damages,
    new SqliteActivityDamageLinkRepository(db),
    new SqliteDamageInstrumentReader(db),
    new SqliteRepairActivityReader(db),
    new SqliteContractAmountReader(db),
    CLOCK,
  );

  const shipToRequests = new SqliteShipToRequestRepository(db);
  const shipToService = new ShipToService(
    new SqliteShipToRepository(db),
    shipToRequests,
    new SqliteShipToAddressReader(db),
    CLOCK,
  );

  const qrService = new QrRequestService(new SqliteQrRequestRepository(db), CLOCK);
  const serialService = new SerialAddressUpdateService(
    new SqliteSerialAddressUpdateRepository(db),
    new SqliteInstrumentAddressReader(db),
    CLOCK,
  );

  const reader = new SqliteReportingFactReader(db);
  const reporting = new ReportingService(reader, CLOCK);
  const exporter = new ReportingExportService();

  return {
    db,
    dbPath,
    projects,
    contracts,
    invoices,
    projectService,
    financial,
    execution,
    batches,
    instruments,
    fees,
    orderService,
    damageService,
    shipToService,
    qrService,
    serialService,
    reader,
    reporting,
    exporter,
  };
}

let seq = 0;/** 正式进单项目：区域/快照/进单时间可配。 */
function seedEnteredProject(
  ctx: ReturnType<typeof openService>,
  opts: { region: string; entryAt: string; snapshot: string; ecc?: string },
): string {
  seq += 1;
  const customer = new CustomerService(new SqliteCustomerRepository(ctx.db)).register(`集成客户${seq}`);
  const projectId = ctx.projectService.createPendingProject().id;
  ctx.projectService.attachContract(projectId);
  ctx.financial.setContractUsdTaxAmount(projectId, Money.parse(opts.snapshot).cents);
  ctx.projectService.linkCustomer(projectId, customer.id);
  ctx.projectService.confirmScope(projectId);
  ctx.projectService.setRegion(projectId, opts.region);
  ctx.projectService.formalEntry(projectId, {
    ecc: opts.ecc ?? `ECC-REP-${seq}`,
    entryAt: opts.entryAt,
  });
  return projectId;
}

function seedInstrument(ctx: ReturnType<typeof openService>, projectId: string, serialNo: string): string {
  const instrument = ctx.execution.registerInstrument(
    projectId,
    { name: `仪器-${serialNo}`, serialNo },
    ACTOR,
  );
  return instrument.id;
}

/** 从 PNG 字节流中按 chunk 结构提取指定关键字的 tEXt 元数据（UTF-8）。 */
function extractPngTextChunk(pngBytes: Buffer, keyword: string): string {
  let offset = 8;
  while (offset + 8 <= pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const type = pngBytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'tEXt') {
      const data = pngBytes.subarray(offset + 8, offset + 8 + length);
      const nulIndex = data.indexOf(0);
      if (nulIndex >= 0 && data.subarray(0, nulIndex).toString('ascii') === keyword) {
        return data.subarray(nulIndex + 1).toString('utf8');
      }
    }
    offset += 12 + length;
  }
  return '';
}

describe('operational-reporting SQLite 集成（7.11）', () => {
  it('标签筛选从唯一项目关联集合读取，OR 匹配且拒绝未知标签', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const p2 = seedEnteredProject(ctx, { region: 'South', entryAt: '2026-07-02', snapshot: '20000' });
      ctx.db.prepare('INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?, ?)').run(p1, 'project-tag-project-type-relocation');
      ctx.db.prepare('INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?, ?)').run(p1, 'project-tag-service-type-storage');
      ctx.db.prepare('INSERT INTO project_tag_assignments (project_id, tag_id) VALUES (?, ?)').run(p2, 'project-tag-service-type-storage');
      ctx.financial.recordInvoice(p1, { amountCents: 100n, invoicedAt: '2026-07-15' }, ACTOR);
      ctx.financial.recordInvoice(p2, { amountCents: 200n, invoicedAt: '2026-07-15' }, ACTOR);

      const filter = { monthFrom: '2026-07', monthTo: '2026-07', tagIds: ['project-tag-project-type-relocation', 'project-tag-service-type-storage'] };
      expect(ctx.reporting.buildReport(filter).monthlyInvoices).toEqual([{ month: '2026-07', amountCents: 300n, count: 2 }]);
      expect(() => ctx.reporting.buildReport({ ...filter, tagIds: ['unknown-tag'] })).toThrow(/UNKNOWN_PROJECT_TAG_ID/);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('进单快照/掉票/开单/损坏/物流/工作量全链路在真实 SQLite 上实时统计', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const pEast = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const pSouth = seedEnteredProject(ctx, { region: 'South', entryAt: '2026-07-02', snapshot: '20000' });

      ctx.financial.recordInvoice(pEast, { amountCents: 300000n, invoicedAt: '2026-07-15' }, ACTOR);
      ctx.financial.recordInvoice(pSouth, { amountCents: 500000n, invoicedAt: '2026-06-20' }, ACTOR);

      ctx.orderService.recordOrder(
        { orderType: 'relocation', serviceOrderNo: 'ORD-001', orderedAt: '2026-07-10', engineer: '工程师甲', customerName: '华东医药', projectId: pEast },
        ACTOR,
      );
      ctx.orderService.recordOrder(
        { orderType: 'pm', serviceOrderNo: 'ORD-002', orderedAt: '2026-07-11', engineer: '工程师乙', customerName: '华南医药' },
        ACTOR,
      );

      const instrumentId = seedInstrument(ctx, pEast, 'SN-100');
      ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'PART-1', partQuantity: 1, partAmountCents: 72000n, partCurrency: 'RMB', partStatus: 'used', registeredAt: '2026-07-12' },
        ACTOR,
      );
      ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'PART-2', partQuantity: 1, partAmountCents: 30000n, partCurrency: 'USD', partStatus: 'arrived', registeredAt: '2026-07-13' },
        ACTOR,
      );

      const batchA = ctx.execution.createBatch(pEast, ACTOR);
      ctx.execution.updateBatchQuote(batchA.id, { transportCompany: '物流公司甲', planTransportDate: '2026-07-20', originalPriceCents: 100000n, discountedPriceCents: 95000n }, ACTOR);
      ctx.execution.recordLogisticsFee(
        batchA.id,
        { appliedAt: '2026-07-18', budgetPriceCents: 10000n, dealPriceCents: 12000n, logisticsCostCents: 11000n },
        ACTOR,
      );

      const shipToReq = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      ctx.shipToService.submit(shipToReq.id, ACTOR);
      // 提交时间取固定时钟（2026-08-07）；归入 7 月口径（首次实际提交时间）
      ctx.db
        .prepare('UPDATE ship_to_requests SET submitted_at = ? WHERE id = ?')
        .run('2026-07-05', shipToReq.id);

      ctx.qrService.createRequest({ applicant: '负责人甲', requestedAt: '2026-07-08', types: ['A', 'A', 'B'] }, ACTOR);
      ctx.serialService.register(instrumentId, { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-100', accountId: 'ACC-001', updatedAt: '2026-07-09' }, ACTOR);

      const report = ctx.reporting.buildReport({ monthFrom: '2026-06', monthTo: '2026-07' });

      // 进单金额快照按区域与月份汇总
      expect(report.entryAmountByRegion).toEqual([
        { month: '2026-07', region: 'East', amountCents: 1000000n, projectCount: 1 },
        { month: '2026-07', region: 'South', amountCents: 2000000n, projectCount: 1 },
      ]);
      // 掉票跨月分次归属
      expect(report.monthlyInvoices).toEqual([
        { month: '2026-06', amountCents: 500000n, count: 1 },
        { month: '2026-07', amountCents: 300000n, count: 1 },
      ]);
      // 开单量按类型分组
      const orders = new Map(report.monthlyServiceOrders.map((r) => [`${r.month}:${r.orderType}`, r.count]));
      expect(orders.get('2026-07:relocation')).toBe(1);
      expect(orders.get('2026-07:pm')).toBe(1);
      // 损坏统计：仅已使用备件（RMB 720 → USD 100）
      expect(report.damageSummary[0].recordCount).toBe(2);
      expect(report.damageSummary[0].usedPartUsdCents).toBe(10000n);
      // 物流：成交>预算提示计数
      expect(report.monthlyLogistics[0].dealOverBudgetCount).toBe(1);
      expect(report.monthlyLogistics[0].transportCompany).toBe('物流公司甲');
      // 工作量：明细与汇总均携带持久化账号ID+用户名快照责任人维度
      expect(report.shipToWorkload).toEqual([
        { month: '2026-07', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
      ]);
      const qr = new Map(report.qrWorkload.map((r) => [r.typeCode, r.count]));
      expect(qr.get('A')).toBe(1);
      expect(qr.get('B')).toBe(1);
      expect(report.serialAddressUpdates).toEqual([
        { month: '2026-07', customerName: '华东医药', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
      ]);

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('事后掉票编辑与撤销实时反映到报表；关闭重开后仍一致', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const invoice = ctx.financial.recordInvoice(p1, { amountCents: 500000n, invoicedAt: '2026-07-15' }, ACTOR);

      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      expect(ctx.reporting.buildReport(month).monthlyInvoices[0].amountCents).toBe(500000n);

      // 掉票直接覆盖编辑 → 实时更新
      ctx.financial.editInvoice(invoice.id, { amountCents: 600000n, invoicedAt: '2026-07-16' }, ACTOR);
      const afterEdit = ctx.reporting.buildReport(month);
      expect(afterEdit.monthlyInvoices[0].amountCents).toBe(600000n);

      // 撤销 → 实时排除（终态，禁止再次编辑/撤销由 financial 层校验）
      ctx.financial.revokeInvoice(invoice.id, { revokedAt: '2026-07-20', revokeReason: '重复登记' }, ACTOR);
      expect(ctx.reporting.buildReport(month).monthlyInvoices).toHaveLength(0);

      // 关闭重开后报表仍一致（实时读取落库事实）
      closeDatabase(ctx.db);
      const reopened = openService(dir);
      expect(reopened.reporting.buildReport(month).monthlyInvoices).toHaveLength(0);
      closeDatabase(reopened.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('区域修改实时重算；账号改名后历史统计仍按动作记录快照归属', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const instrumentId = seedInstrument(ctx, p1, 'SN-200');
      const item = ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'P-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD', partStatus: 'used', registeredAt: '2026-07-12' },
        ACTOR,
      );
      const month = { monthFrom: '2026-07', monthTo: '2026-07' };

      // 区域修改 → 实时重算
      expect(ctx.reporting.buildReport(month).entryAmountByRegion[0].region).toBe('East');
      ctx.projectService.setRegion(p1, 'South');
      expect(ctx.reporting.buildReport(month).entryAmountByRegion[0].region).toBe('South');

      // 账号改名（直接改 accounts 表，模拟历史用户名变化）：
      // 报表责任人仍取动作记录中持久化的用户名快照「负责人甲」
      ctx.db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run('负责人甲（新名）', 'account-1');
      const details = ctx.reporting.getMetricDetails('damage_repair_stats', month) as unknown as {
        itemId: string;
        operatorUsername: string | null;
      }[];
      expect(details.find((d) => d.itemId === item.id)!.operatorUsername).toBe('负责人甲');

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('取消项目排除收入/掉票/管道，保留物流与损坏真实成本并标记取消', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      seedEnteredProject(ctx, { region: 'South', entryAt: '2026-07-02', snapshot: '20000' });

      const instrumentId = seedInstrument(ctx, p1, 'SN-300');
      ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'P-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD', partStatus: 'used', registeredAt: '2026-07-12' },
        ACTOR,
      );
      const batch = ctx.execution.createBatch(p1, ACTOR);
      ctx.execution.updateBatchQuote(batch.id, { transportCompany: '物流公司甲' }, ACTOR);
      ctx.execution.recordLogisticsFee(
        batch.id,
        { appliedAt: '2026-07-18', budgetPriceCents: 10000n, dealPriceCents: 9500n, logisticsCostCents: 9000n },
        ACTOR,
      );

      // 取消 p1（无任何掉票历史，可取消）
      ctx.projectService.cancelProject(p1, { time: '2026-07-25', reason: '客户取消' });

      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      const report = ctx.reporting.buildReport(month);
      // 进单金额排除已取消项目
      expect(report.entryAmountByRegion.map((r) => r.region)).toEqual(['South']);
      // 项目管道排除已取消
      expect(report.pipeline.some((r) => r.status === 'cancelled')).toBe(false);
      // 物流与损坏真实成本保留并标记取消
      expect(report.monthlyLogistics[0].cancelledBatchCount).toBe(1);
      expect(report.damageSummary[0].usedPartUsdCents).toBe(10000n);
      expect(report.damageDetails[0].cancelled).toBe(true);

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('导出三种格式：magic header、内容与同次实时 report model 一致、PNG 含指标与筛选值', async () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      ctx.financial.recordInvoice(p1, { amountCents: 500000n, invoicedAt: '2026-07-15' }, ACTOR);
      const month = { monthFrom: '2026-07', monthTo: '2026-07', region: 'East' };
      const report = ctx.reporting.buildReport(month);

      // Excel：ZIP magic header + 内容与模型一致
      const xlsx = await ctx.exporter.exportExcel(report);
      expect(xlsx.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = wb.worksheets[0];
      const allTexts: string[] = [];
      for (const row of ws.getSheetValues()) {
        if (row === undefined || row === null) continue;
        for (const value of Object.values(row as object)) {
          if (value === undefined || value === null) continue;
          allTexts.push(String(value));
        }
      }
      expect(allTexts.some((t) => t.includes('2026-07'))).toBe(true);
      expect(allTexts.some((t) => t.includes('5000.00'))).toBe(true);
      expect(allTexts.some((t) => t.includes('Range: 2026-07 TO 2026-07'))).toBe(true);

      // PDF：%PDF magic header + 内容包含当前指标数值与筛选值（Info 字典元数据可读回验证）
      const pdf = await ctx.exporter.exportPdf(report);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const loadedPdf = await import('pdf-lib').then((m) => m.PDFDocument.load(pdf));
      expect(loadedPdf.getTitle()).toBe('Relocation Workbench - Operations Report');
      const pdfMeta = loadedPdf.getSubject();
      expect(pdfMeta).toContain('5000.00');
      expect(pdfMeta).toContain('monthly_invoice');
      expect(pdfMeta).toContain('"from":"2026-07"');
      expect(pdfMeta).toContain('"to":"2026-07"');

      // PNG：PNG magic header + 非空像素 + tEXt 元数据包含当前指标与筛选值
      const png = ctx.exporter.exportPng(report);
      expect(png.subarray(0, 8).toString('latin1')).toBe('\u0089PNG\r\n\u001a\n');
      const decoded = PNG.sync.read(png);
      expect(decoded.width).toBeGreaterThan(0);
      expect(decoded.height).toBeGreaterThan(0);
      let nonWhite = 0;
      for (let i = 0; i < decoded.data.length; i += 4) {
        if (decoded.data[i] !== 255 || decoded.data[i + 1] !== 255 || decoded.data[i + 2] !== 255) nonWhite += 1;
      }
      expect(nonWhite).toBeGreaterThan(100); // 非空图
      // pngjs 不解析 tEXt，按 PNG chunk 结构手工读取元数据块内容
      const pngText = extractPngTextChunk(png, 'Report');
      expect(pngText).toBeDefined();
      const meta = JSON.parse(pngText);
      expect(meta.range).toEqual({ from: '2026-07', to: '2026-07' });
      expect(meta.filters).toEqual({ region: 'East', orderType: null, transportCompany: null, engineer: null, operator: null, tagIds: [] });
      const invoiceSection = meta.sections.find((s: { key: string }) => s.key === 'monthly_invoice');
      expect(invoiceSection.rows).toContainEqual(['2026-07', '5000.00', '1']);

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('物流报表导出 section header 精确：仅月份/运输公司/批次数/合同预算价合计/物流成交价合计/两价差异/成交>预算批次数/已取消批次数，不含旧「实际费用」列', async () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const batch = ctx.execution.createBatch(p1, ACTOR);
      ctx.execution.updateBatchQuote(batch.id, { transportCompany: '物流公司甲' }, ACTOR);
      ctx.execution.recordLogisticsFee(
        batch.id,
        { appliedAt: '2026-07-18', budgetPriceCents: 10000n, dealPriceCents: 12000n, logisticsCostCents: 12000n },
        ACTOR,
      );
      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      const report = ctx.reporting.buildReport(month);
      expect(report.monthlyLogistics[0].dealOverBudgetCount).toBe(1);

      const png = ctx.exporter.exportPng(report);
      const meta = JSON.parse(extractPngTextChunk(png, 'Report'));
      const logisticsSection = meta.sections.find((s: { key: string }) => s.key === 'monthly_logistics');
      // 导出仅保留两个价格口径：合同预算价与物流成交价（物流成交价即最终实际费用），
      // 不含旧「实际费用」列（costSumCents/budgetCostDiffCents 仅为底层历史兼容列）。
      expect(logisticsSection.header).toEqual([
        '月份',
        '运输公司',
        '批次数',
        '合同预算价合计',
        '物流成交价合计',
        '合同预算价-物流成交价差异',
        '物流成交价>合同预算价批次数',
        '已取消批次数',
      ]);
      expect(logisticsSection.header.join('').includes('实际费用')).toBe(false);
      expect(logisticsSection.rows).toContainEqual(['2026-07', '物流公司甲', '1', '100.00', '120.00', '-20.00', '1', '0']);

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('跨四类工作量：多责任人分组、账号改名后历史快照稳定，三种导出内容包含责任人维度', async () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      // 合成第二账号（多责任人场景）。accounts.singleton 唯一索引是本产品"单一账号"的
      // 数据库层守卫；本测试用临时库跳过该守卫以构造第二责任人，仅影响本测试的临时数据库，
      // 不改任何 schema/迁移/领域规则。动作记录在各自表中持久化 account_id + username_snapshot，
      // 与 accounts 表当前用户名相互独立。
      ctx.db.exec('DROP INDEX IF EXISTS idx_accounts_singleton');
      ctx.db
        .prepare(
          'INSERT OR IGNORE INTO accounts (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        )
        .run('account-2', '负责人乙', 'hash', 'salt', 't', 't');
      const ACTOR_B = makeAccount('account-2', '负责人乙');

      const p1 = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      const instrumentId = seedInstrument(ctx, p1, 'SN-400');

      // 损坏：两位责任人各一条已使用备件
      ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'P-1', partQuantity: 1, partAmountCents: 10000n, partCurrency: 'USD', partStatus: 'used', registeredAt: '2026-07-12' },
        ACTOR,
      );
      ctx.damageService.registerItem(
        instrumentId,
        { partNumber: 'P-2', partQuantity: 1, partAmountCents: 20000n, partCurrency: 'USD', partStatus: 'used', registeredAt: '2026-07-13' },
        ACTOR_B,
      );

      // Ship-to：两位责任人各一次实际提交
      const sA = ctx.shipToService.createRequest({ customerName: '华东医药', newSiteAddress: '新址A' }, ACTOR);
      ctx.shipToService.submit(sA.id, ACTOR);
      const sB = ctx.shipToService.createRequest({ customerName: '华北医药', newSiteAddress: '新址B' }, ACTOR_B);
      ctx.shipToService.submit(sB.id, ACTOR_B);
      ctx.db.prepare('UPDATE ship_to_requests SET submitted_at = ? WHERE id = ?').run('2026-07-05', sA.id);
      ctx.db.prepare('UPDATE ship_to_requests SET submitted_at = ? WHERE id = ?').run('2026-07-06', sB.id);

      // 二维码：两位责任人各一条
      ctx.qrService.createRequest({ applicant: '负责人甲', requestedAt: '2026-07-08', types: ['A', 'A', 'B'] }, ACTOR);
      ctx.qrService.createRequest({ applicant: '负责人乙', requestedAt: '2026-07-09', types: ['A'] }, ACTOR_B);

      // 序列号地址更新：两位责任人各一条
      ctx.serialService.register(instrumentId, { customerName: '华东医药', newSiteAddress: '新址A', serialNo: 'SN-400', accountId: 'ACC-001', updatedAt: '2026-07-09' }, ACTOR);
      ctx.serialService.register(instrumentId, { customerName: '华东医药', newSiteAddress: '新址B', serialNo: 'SN-400', accountId: 'ACC-002', updatedAt: '2026-07-10' }, ACTOR_B);

      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      const report = ctx.reporting.buildReport(month);

      // 四类工作量汇总均按责任人分组并携带账号ID+用户名快照
      expect(report.damageSummary).toEqual([
        { month: '2026-07', operatorAccountId: 'account-1', operatorUsername: '负责人甲', recordCount: 1, usedPartUsdCents: 10000n },
        { month: '2026-07', operatorAccountId: 'account-2', operatorUsername: '负责人乙', recordCount: 1, usedPartUsdCents: 20000n },
      ]);
      expect(report.shipToWorkload).toEqual([
        { month: '2026-07', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
        { month: '2026-07', operatorAccountId: 'account-2', operatorUsername: '负责人乙', count: 1 },
      ]);
      const qrKey = (r: { month: string; typeCode: string; operatorAccountId: string | null; operatorUsername: string | null; count: number }) =>
        `${r.month}:${r.typeCode}:${r.operatorAccountId}:${r.operatorUsername}`;
      const qrMap = new Map(report.qrWorkload.map((r) => [qrKey(r), r.count]));
      expect(qrMap.get('2026-07:A:account-1:负责人甲')).toBe(1);
      expect(qrMap.get('2026-07:B:account-1:负责人甲')).toBe(1);
      expect(qrMap.get('2026-07:A:account-2:负责人乙')).toBe(1);
      expect(report.serialAddressUpdates).toEqual([
        { month: '2026-07', customerName: '华东医药', operatorAccountId: 'account-1', operatorUsername: '负责人甲', count: 1 },
        { month: '2026-07', customerName: '华东医药', operatorAccountId: 'account-2', operatorUsername: '负责人乙', count: 1 },
      ]);

      // 账号改名（只改 accounts 表，不动动作记录快照）→ 历史统计仍按当时快照归属
      ctx.db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run('负责人甲（新名）', 'account-1');
      const afterRename = ctx.reporting.buildReport(month);
      expect(afterRename.damageSummary.map((r) => r.operatorUsername)).toEqual(expect.arrayContaining(['负责人甲', '负责人乙']));
      expect(afterRename.damageSummary).toHaveLength(2);
      expect(afterRename.shipToWorkload.map((r) => r.operatorUsername)).toEqual(expect.arrayContaining(['负责人甲', '负责人乙']));
      expect(afterRename.qrWorkload.map((r) => r.operatorUsername)).toEqual(expect.arrayContaining(['负责人甲', '负责人甲', '负责人乙']));
      expect(afterRename.serialAddressUpdates.map((r) => r.operatorUsername)).toEqual(expect.arrayContaining(['负责人甲', '负责人乙']));
      const serialDetails = ctx.reporting.getMetricDetails('serial_address_update_count', month) as unknown as {
        updateId: string;
        operatorAccountId: string | null;
        operatorUsername: string | null;
      }[];
      expect(serialDetails.every((d) => d.operatorUsername === '负责人甲' || d.operatorUsername === '负责人乙')).toBe(true);
      expect(serialDetails.find((d) => d.operatorAccountId === 'account-1')?.operatorUsername).toBe('负责人甲');

      // 按责任人筛选（用户名快照精确匹配），筛选条件进入报表模型快照
      const byA = ctx.reporting.buildReport({ ...month, operator: '负责人甲' });
      expect(byA.damageSummary.reduce((s, r) => s + r.recordCount, 0)).toBe(1);
      expect(byA.shipToWorkload.reduce((s, r) => s + r.count, 0)).toBe(1);
      expect(byA.qrWorkload.reduce((s, r) => s + r.count, 0)).toBe(2);
      expect(byA.serialAddressUpdates.reduce((s, r) => s + r.count, 0)).toBe(1);
      expect(byA.filters.operator).toBe('负责人甲');

      // 导出内容与同次实时模型一致：Excel/PDF/PNG 均包含责任人维度（快照用户名）
      const model = ctx.reporting.buildReport(month);
      const xlsx = await ctx.exporter.exportExcel(model);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = wb.worksheets[0];
      const allTexts: string[] = [];
      for (const row of ws.getSheetValues()) {
        if (row === undefined || row === null) continue;
        for (const value of Object.values(row as object)) {
          if (value === undefined || value === null) continue;
          allTexts.push(String(value));
        }
      }
      expect(allTexts.some((t) => t === '负责人甲')).toBe(true);
      expect(allTexts.some((t) => t === '负责人乙')).toBe(true);

      const pdf = await ctx.exporter.exportPdf(model);
      const loadedPdf = await import('pdf-lib').then((m) => m.PDFDocument.load(pdf));
      const pdfMeta = loadedPdf.getSubject() ?? '';
      expect(pdfMeta).toContain('负责人甲');
      expect(pdfMeta).toContain('负责人乙');
      expect(pdfMeta).toContain('ship_to_request_workload');

      const png = ctx.exporter.exportPng(model);
      const pngText = extractPngTextChunk(png, 'Report');
      const meta = JSON.parse(pngText);
      expect(meta.filters).toEqual({ region: null, orderType: null, transportCompany: null, engineer: null, operator: null, tagIds: [] });
      const shipToSection = meta.sections.find((s: { key: string }) => s.key === 'ship_to_request_workload');
      expect(shipToSection.header).toEqual(['月份', '责任人', '首次提交数']);
      expect(shipToSection.rows).toContainEqual(['2026-07', '负责人甲', '1']);
      expect(shipToSection.rows).toContainEqual(['2026-07', '负责人乙', '1']);
      const serialSection = meta.sections.find((s: { key: string }) => s.key === 'serial_address_update_count');
      expect(serialSection.rows).toContainEqual(['2026-07', '华东医药', '负责人甲', '1']);
      expect(serialSection.rows).toContainEqual(['2026-07', '华东医药', '负责人乙', '1']);
      const damageSection = meta.sections.find((s: { key: string }) => s.key === 'damage_repair_stats');
      expect(damageSection.header).toEqual(['月份', '责任人', '事项记录数', '已使用备件USD']);
      expect(damageSection.rows).toContainEqual(['2026-07', '负责人乙', '1', '200.00']);

      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('开单工程师可空：空值计入总量、筛选、下钻 null，补录后筛选实时变化', () => {
    const dir = makeTempDir();
    try {
      const ctx = openService(dir);
      const p = seedEnteredProject(ctx, { region: 'East', entryAt: '2026-07-01', snapshot: '10000' });
      ctx.orderService.recordOrder({ orderType: 'relocation', serviceOrderNo: 'ORD-NULL-1', orderedAt: '2026-07-10', engineer: null, customerName: '客户A', projectId: p }, ACTOR);
      ctx.orderService.recordOrder({ orderType: 'pm', serviceOrderNo: 'ORD-VAL', orderedAt: '2026-07-11', engineer: '工程师甲', customerName: '客户B' }, ACTOR);
      ctx.orderService.recordOrder({ orderType: 'pm', serviceOrderNo: 'ORD-NULL-2', orderedAt: '2026-07-12', engineer: '   ', customerName: '客户C' }, ACTOR);
      const month = { monthFrom: '2026-07', monthTo: '2026-07' };
      const report = ctx.reporting.buildReport(month);
      expect(report.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(3);
      const details = ctx.reporting.getMetricDetails('monthly_service_order_count', month) as Array<{ engineer: string | null }>;
      expect(details.filter((d) => d.engineer === null)).toHaveLength(2);
      const filtered = ctx.reporting.buildReport({ ...month, engineer: '工程师甲' });
      expect(filtered.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(1);
      // 补录空值后筛选实时变化
      const nullOrder = ctx.orderService.listOrders().find((o) => o.serviceOrderNo === 'ORD-NULL-1')!;
      ctx.orderService.updateEngineer(nullOrder.id, '工程师甲', ACTOR);
      const after = ctx.reporting.buildReport({ ...month, engineer: '工程师甲' });
      expect(after.monthlyServiceOrders.reduce((s, r) => s + r.count, 0)).toBe(2);
      const afterDetails = ctx.reporting.getMetricDetails('monthly_service_order_count', { ...month, engineer: '工程师甲' }) as Array<{ engineer: string | null }>;
      expect(afterDetails.every((d) => (d.engineer ?? '').includes('工程师甲'))).toBe(true);
      closeDatabase(ctx.db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('PNG 导出条形图：超过 MAX_SAFE_INTEGER 金额的标签与比例精确（BigInt 定点）', () => {
  /** 构造仅含月度掉票数据的最小 ReportModel（条形图主指标）。 */
  function invoiceOnlyReport(amounts: bigint[]): ReportModel {
    return {
      range: { from: '2026-07', to: '2026-07' },
      filters: { region: null, orderType: null, transportCompany: null, engineer: null, operator: null, tagIds: [] },
      generatedAt: '2026-07-31T00:00:00+08:00',
      pipeline: [],
      entryAmountByRegion: [],
      monthlyInvoices: amounts.map((amountCents) => ({ month: '2026-07', amountCents, count: 1 })),
      monthlyServiceOrders: [],
      damageSummary: [],
      damageDetails: [],
      monthlyLogistics: [],
      logisticsContractRatios: [],
      pendingLogistics: [],
      shipToWorkload: [],
      qrWorkload: [],
      serialAddressUpdates: [],
    };
  }

  /** 从 PNG 像素中测量第 index 根条形的高度：条形右缘（避开条形标签文本）自上而下首个蓝色像素即条顶。 */
  function measureBarHeight(pngBytes: Buffer, index: number, barCount: number): number {
    const decoded = PNG.sync.read(pngBytes);
    const chartX = 40;
    const chartY = 130;
    const chartW = 300;
    const barW = Math.max(6, Math.floor(chartW / barCount) - 6);
    const bx = Math.floor(chartX + 6 + index * ((chartW - 6) / barCount));
    const sampleX = bx + Math.max(barW - 8, 4); // 条形内、条形标签文本右侧
    let top = -1;
    for (let y = 0; y < chartY; y += 1) {
      const idx = (y * decoded.width + sampleX) * 4;
      if (decoded.data[idx] === 0x2a && decoded.data[idx + 1] === 0x4a && decoded.data[idx + 2] === 0x7f) {
        top = y;
        break;
      }
    }
    return top < 0 ? 0 : chartY - top;
  }

  it('BigInt 定点标签/比例函数：超大金额不先把 BigInt 转 Number，0/负值边界稳定', () => {
    // 9007199254741049n 分：Number(bigint) 会退化为 9007199254741050 → /100=…10.5 → 旧实现标签 90071992547411
    // 精确值 …1049/100 = 90071992547410.49 → HALF_UP → 90071992547410
    expect(pngBarLabel(9007199254741049n)).toBe('90071992547410');
    expect(pngBarLabel(9007199254740993n)).toBe('90071992547410'); // Number.MAX_SAFE_INTEGER + 1
    expect(pngBarLabel(0n)).toBe('0');
    expect(pngBarLabel(-5n)).toBe('0'); // 负值边界稳定输出

    // 比例：1:1 → 120；≈1:2 → 60；2:1 钳制到 120；小金额同比例结果一致
    expect(pngBarHeight(9007199254740993n, 9007199254740993n, 120)).toBe(120);
    expect(pngBarHeight(4500000000000000n, 9007199254740993n, 120)).toBe(60);
    expect(pngBarHeight(9007199254740993n, 4500000000000000n, 120)).toBe(120);
    expect(pngBarHeight(1000n, 2000n, 120)).toBe(60);
    expect(pngBarHeight(0n, 2000n, 120)).toBe(2); // 0 值条：最小 2px 可见
    expect(pngBarHeight(-5n, 2000n, 120)).toBe(2); // 负值边界
    expect(pngBarHeight(1000n, 0n, 120)).toBe(0); // maxCents=0 → 高度 0
  });

  it('超大金额与小金额同比例渲染：第 2 根条形像素高度一致（比例无 Number 退化）', () => {
    const exporter = new ReportingExportService();
    const huge = exporter.exportPng(invoiceOnlyReport([9007199254740993n, 4500000000000000n]));
    const small = exporter.exportPng(invoiceOnlyReport([2000n, 1000n]));
    expect(measureBarHeight(huge, 1, 2)).toBe(60);
    expect(measureBarHeight(small, 1, 2)).toBe(60);
    // 确定性：同一模型两次渲染字节完全一致（输出稳定）
    expect(exporter.exportPng(invoiceOnlyReport([2000n, 1000n])).equals(small)).toBe(true);
  });
});
