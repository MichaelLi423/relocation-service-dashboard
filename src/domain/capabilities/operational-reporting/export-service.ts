import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PNG } from 'pngjs';
import { formatCents } from '../../core/money';
import type {
  LogisticsRatioRow,
  LogisticsSummaryRow,
  PendingLogisticsRow,
  ReportModel,
} from './reporting-service';

/**
 * operational-reporting 导出服务（tasks 7.10 / TBD-17）。
 *
 * 三种导出格式（格式已定，技术库：exceljs / pdf-lib / pngjs）：
 * - Excel（.xlsx）：多区段工作表，内容与当前筛选条件下的实时报表模型一致。
 * - PDF：pdf-lib 渲染 ASCII 区段文本（数字与指标键以 WinAnsi 可检索字节写入）。
 * - PNG：pngjs 渲染确定性位图表格/条形图（轻量 5x7 位图字体），并在 PNG
 *   tEXt 元数据块中写入当前指标与筛选值（UTF-8 JSON），不返回空图。
 *
 * 导出字节必须通过 magic header 与内容测试，且输出与同次实时 report model 一致：
 * 本服务只接受已计算好的 ReportModel，逐字节/逐值序列化，不重新计算。
 */

// ---------------------------------------------------------------------------
// 区段化（Excel/PDF/PNG 共用同一数据源，保证与 report model 一致）
// ---------------------------------------------------------------------------

export interface ExportSection {
  key: string;
  title: string;
  header: string[];
  rows: string[][];
}

const money = (cents: bigint): string => formatCents(cents);
const num = (n: number): string => String(n);
const ratio = (hundredths: bigint | null, unavailable: boolean): string =>
  unavailable ? 'N/A' : `${formatCents(hundredths ?? 0n)}%`;
/** 责任人展示：优先动作记录持久化的用户名快照，其次账号内部 ID，均无则明确提示。 */
const operatorName = (accountId: string | null, username: string | null): string =>
  username !== null && username !== '' ? username : accountId ?? '(未记录)';

// ---------------------------------------------------------------------------
// PNG 条形图金额：BigInt 定点计算（禁止先把原始金额 BigInt 转 Number）
// ---------------------------------------------------------------------------

/** floor(a / b)，b > 0：BigInt `/` 向零截断，这里补足 floor 语义（负分子向 -∞）。 */
function floorDiv(a: bigint, b: bigint): bigint {
  if (a >= 0n) return a / b;
  return -((-a + b - 1n) / b);
}

/** Math.round(a / b)（b > 0）：HALF_UP，负值与 Number 的 Math.round 语义一致。 */
function roundDiv(a: bigint, b: bigint): bigint {
  return floorDiv(a * 2n + b, b * 2n);
}

/**
 * PNG 条形标签：分 → 整数元（Math.round 语义的 BigInt HALF_UP）。
 * 0/负值稳定输出（负值按 0 处理，避免出现无效负金额标签）。
 */
export function pngBarLabel(cents: bigint): string {
  const rounded = roundDiv(cents, 100n);
  return String(rounded < 0n ? 0n : rounded);
}

/**
 * PNG 条形像素高度：round(cents / maxCents × chartH)，全程 BigInt 定点，
 * 仅在结果已约束到像素范围（[0, chartH] 的小整数）后转 number。
 * maxCents <= 0 → 0；高度钳制到 [2, chartH]（保持既有"最小 2px 可见条"视觉）。
 */
export function pngBarHeight(cents: bigint, maxCents: bigint, chartH: number): number {
  if (maxCents <= 0n) return 0;
  const px = Number(roundDiv(cents * BigInt(chartH), maxCents));
  return Math.max(2, Math.min(chartH, px));
}

export function buildExportSections(report: ReportModel): ExportSection[] {
  const sections: ExportSection[] = [];

  sections.push({
    key: 'project_pipeline',
    title: '项目管道（当前状态快照，已取消排除）',
    header: ['状态', '项目数'],
    rows: report.pipeline.map((r) => [r.status, num(r.projectCount)]),
  });

  sections.push({
    key: 'entry_amount_by_region',
    title: '各区域新项目进单金额（进单金额快照）',
    header: ['月份', '区域', '进单金额(USD)', '项目数'],
    rows: report.entryAmountByRegion.map((r) => [
      r.month,
      r.region === '' ? '(未填区域)' : r.region,
      money(r.amountCents),
      num(r.projectCount),
    ]),
  });

  sections.push({
    key: 'monthly_invoice',
    title: '月度掉票金额与次数（已撤销不计）',
    header: ['月份', '掉票金额(USD)', '掉票次数'],
    rows: report.monthlyInvoices.map((r) => [r.month, money(r.amountCents), num(r.count)]),
  });

  sections.push({
    key: 'monthly_service_order_count',
    title: '月度开单量（唯一服务单号，四类业务分组）',
    header: ['月份', '业务类型', '开单量'],
    rows: report.monthlyServiceOrders.map((r) => [r.month, r.orderType, num(r.count)]),
  });

  sections.push({
    key: 'damage_repair_stats',
    title: '损坏维修统计（记录数量；仅已使用备件 USD）',
    header: ['月份', '责任人', '事项记录数', '已使用备件USD'],
    rows: report.damageSummary.map((r) => [
      r.month,
      operatorName(r.operatorAccountId, r.operatorUsername),
      num(r.recordCount),
      money(r.usedPartUsdCents),
    ]),
  });

  sections.push({
    key: 'monthly_logistics',
    title: '月度物流费用汇总（人民币）',
    // 业务可见列仅保留两个价格口径：合同预算价 / 物流成交价（物流成交价即最终实际费用）。
    // 底层 LogisticsSummaryRow 的 costSumCents / budgetCostDiffCents 为历史兼容列
    // （旧「实际费用」口径，现行业务与物流成交价同值），不在导出中重复展示。
    header: [
      '月份',
      '运输公司',
      '批次数',
      '合同预算价合计',
      '物流成交价合计',
      '合同预算价-物流成交价差异',
      '物流成交价>合同预算价批次数',
      '已取消批次数',
    ],
    rows: report.monthlyLogistics.map((r: LogisticsSummaryRow) => [
      r.month,
      r.transportCompany === '' ? '(未填运输公司)' : r.transportCompany,
      num(r.batchCount),
      money(r.budgetSumCents),
      money(r.dealSumCents),
      money(r.budgetDealDiffCents),
      num(r.dealOverBudgetCount),
      num(r.cancelledBatchCount),
    ]),
  });

  sections.push({
    key: 'logistics_contract_ratio',
    title: '物流成交价合同占比（物流成交价RMB÷7.2÷最新合同USD）',
    header: ['项目', '月份', '物流成交价USD', '合同USD', '占比', '不可计算', '已取消'],
    rows: report.logisticsContractRatios.map((r: LogisticsRatioRow) => [
      r.projectTempNo,
      r.month,
      money(r.costUsdCents),
      r.contractAmountCents === null ? '(空/0)' : money(r.contractAmountCents),
      ratio(r.ratioPercentHundredths, r.ratioUnavailable),
      r.ratioUnavailable ? '是' : '否',
      r.cancelled ? '是' : '否',
    ]),
  });

  sections.push({
    key: 'pending_logistics_list',
    // 历史异常批次：已有物流成交价但无物流费用记录（历史数据形态），仅展示，不提供补录指引。
    title: '历史异常批次（已有物流成交价但无物流费用记录）',
    header: ['项目', '运输公司', '计划运输日期', '物流成交价(RMB)'],
    rows: report.pendingLogistics.map((r: PendingLogisticsRow) => [
      r.projectTempNo,
      r.transportCompany ?? '',
      r.planTransportDate ?? '',
      r.dealPriceCents === null ? '' : money(r.dealPriceCents),
    ]),
  });

  sections.push({
    key: 'ship_to_request_workload',
    title: 'Account ID 申请工作量（首次实际提交）',
    header: ['月份', '责任人', '首次提交数'],
    rows: report.shipToWorkload.map((r) => [
      r.month,
      operatorName(r.operatorAccountId, r.operatorUsername),
      num(r.count),
    ]),
  });

  sections.push({
    key: 'qr_request_workload',
    title: '二维码申请工作量（申请×去重类型）',
    header: ['月份', '申请类型', '责任人', '数量'],
    rows: report.qrWorkload.map((r) => [
      r.month,
      r.typeCode,
      operatorName(r.operatorAccountId, r.operatorUsername),
      num(r.count),
    ]),
  });

  sections.push({
    key: 'serial_address_update_count',
    title: '序列号地址更新记录数',
    header: ['月份', '客户', '责任人', '记录数'],
    rows: report.serialAddressUpdates.map((r) => [
      r.month,
      r.customerName,
      operatorName(r.operatorAccountId, r.operatorUsername),
      num(r.count),
    ]),
  });

  return sections;
}

/** 报表筛选与主指标摘要（PNG tEXt 元数据 / 导出一致性测试）。 */
export function reportSummaryJson(report: ReportModel): string {
  const sections = buildExportSections(report);
  return JSON.stringify({
    range: report.range,
    filters: report.filters,
    generatedAt: report.generatedAt,
    sections: sections.map((s) => ({ key: s.key, title: s.title, header: s.header, rows: s.rows })),
  });
}

/** 过滤首行标题行（用于每张工作表/每页标题）。 */
function headerLines(report: ReportModel): string[] {
  const f = report.filters;
  const parts = [
    `Range: ${report.range.from} TO ${report.range.to}`,
    `Region: ${f.region ?? 'ALL'}`,
    `OrderType: ${f.orderType ?? 'ALL'}`,
    `TransportCompany: ${f.transportCompany ?? 'ALL'}`,
    `Engineer: ${f.engineer ?? 'ALL'}`,
    `Operator: ${f.operator ?? 'ALL'}`,
    `WorkScope: ${f.workScope ?? 'ALL'}`,
  ];
  return parts;
}

// ---------------------------------------------------------------------------
// Excel（.xlsx）
// ---------------------------------------------------------------------------

async function renderExcel(report: ReportModel): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('运营报表');
  sheet.columns = [{ width: 22 }, { width: 18 }, { width: 18 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }];

  const title = sheet.addRow(['搬迁服务工作台 · 运营报表']);
  title.font = { bold: true, size: 14 };
  for (const line of headerLines(report)) {
    sheet.addRow([line]);
  }
  sheet.addRow([]);

  for (const section of buildExportSections(report)) {
    const headerRow = sheet.addRow([section.title]);
    headerRow.font = { bold: true };
    sheet.addRow(section.header.map((h) => (h.length > 0 ? h : '')));
    for (const row of section.rows) {
      sheet.addRow(row.map((cell, i) => (i < section.header.length ? cell : cell)));
    }
    sheet.addRow([]);
  }

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const ASCII_SAFE = /[^\x20-\x7E]/g;

function sanitizeAscii(text: string): string {
  return text.replace(ASCII_SAFE, '?');
}

async function renderPdf(report: ReportModel): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  let page = pdfDoc.addPage([595, 842]);
  let y = 810;

  const draw = (text: string, size = 9): void => {
    if (y < 30) {
      page = pdfDoc.addPage([595, 842]);
      y = 810;
    }
    page.drawText(sanitizeAscii(text), {
      x: 40,
      y,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    y -= size + 4;
  };

  draw('Relocation Workbench - Operations Report', 14);
  for (const line of headerLines(report)) {
    draw(line);
  }
  draw('');
  for (const section of buildExportSections(report)) {
    draw(`[${section.key}] ${sanitizeAscii(section.title)}`, 10);
    draw(section.header.join(' | '));
    for (const row of section.rows) {
      draw(row.join(' | '));
    }
    draw('');
  }

  // 元数据：当前指标与筛选值写入 PDF Info 字典（未压缩），
  // 保证导出字节内容可检索、与同次实时 report model 一致。
  pdfDoc.setTitle('Relocation Workbench - Operations Report');
  pdfDoc.setSubject(reportSummaryJson(report));

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// PNG（pngjs：确定性位图表格 + 条形图 + tEXt 元数据）
// ---------------------------------------------------------------------------

/** 5x7 轻量位图字体（经典 5x7 font）：每字符 7 行 × 5 位 bitmask。 */
const FONT5X7: Record<string, number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x01, 0x01, 0x01, 0x01, 0x11, 0x11, 0x0e],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '_': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '=': [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
  '<': [0x02, 0x04, 0x08, 0x10, 0x08, 0x04, 0x02],
  '|': [0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '[': [0x0e, 0x08, 0x08, 0x08, 0x08, 0x08, 0x0e],
  ']': [0x0e, 0x02, 0x02, 0x02, 0x02, 0x02, 0x0e],
  '/': [0x01, 0x02, 0x04, 0x08, 0x10, 0x00, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  '%': [0x13, 0x14, 0x08, 0x10, 0x01, 0x0a, 0x0c],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

const PNG_WIDTH = 900;
const PNG_HEIGHT = 640;

function renderPng(report: ReportModel): Buffer {
  const png = new PNG({ width: PNG_WIDTH, height: PNG_HEIGHT });
  // 背景：白色
  for (let i = 0; i < PNG_WIDTH * PNG_HEIGHT; i += 1) {
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255;
    png.data[i * 4 + 3] = 255;
  }

  const drawText = (text: string, x: number, y: number, scale = 2, color: [number, number, number] = [0, 0, 0]): number => {
    let cursor = x;
    const upper = text.toUpperCase();
    for (const ch of upper) {
      const glyph = FONT5X7[ch] ?? FONT5X7['?'];
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col += 1) {
          if (((bits >> (4 - col)) & 1) === 1) {
            for (let dy = 0; dy < scale; dy += 1) {
              for (let dx = 0; dx < scale; dx += 1) {
                const px = cursor + col * scale + dx;
                const py = y + row * scale + dy;
                if (px >= 0 && px < PNG_WIDTH && py >= 0 && py < PNG_HEIGHT) {
                  const idx = (py * PNG_WIDTH + px) * 4;
                  png.data[idx] = color[0];
                  png.data[idx + 1] = color[1];
                  png.data[idx + 2] = color[2];
                }
              }
            }
          }
        }
      }
      cursor += (5 + 1) * scale;
    }
    return cursor;
  };

  const fillRect = (x: number, y: number, w: number, h: number, color: [number, number, number]): void => {
    for (let py = y; py < y + h && py < PNG_HEIGHT; py += 1) {
      for (let px = x; px < x + w && px < PNG_WIDTH; px += 1) {
        const idx = (py * PNG_WIDTH + px) * 4;
        png.data[idx] = color[0];
        png.data[idx + 1] = color[1];
        png.data[idx + 2] = color[2];
      }
    }
  };

  const lines: string[] = [];
  lines.push('RELOCATION WORKBENCH - OPERATIONS REPORT');
  lines.push(`RANGE: ${report.range.from} TO ${report.range.to}`);
  const f = report.filters;
  lines.push(
    `FILTERS: REGION=${f.region ?? 'ALL'} ORDERTYPE=${f.orderType ?? 'ALL'} TRANSPORT=${f.transportCompany ?? 'ALL'} ENGINEER=${f.engineer ?? 'ALL'} OPERATOR=${f.operator ?? 'ALL'} WORKSCOPE=${f.workScope ?? 'ALL'}`,
  );
  lines.push('');

  // 条形图：月度掉票金额（主指标；无数据时用进单金额，仍为空则跳过）。
  // 金额全程保持 bigint（分）：比例与标签经 BigInt 定点计算，禁止先把金额 BigInt 转 Number。
  const barData = report.monthlyInvoices.map((r) => ({ label: r.month, cents: r.amountCents }));
  const barSource = barData.length > 0 ? 'MONTHLY_INVOICE_AMOUNT' : 'ENTRY_AMOUNT_BY_REGION';
  const fallbackBarData =
    barData.length > 0
      ? barData
      : report.entryAmountByRegion.map((r) => ({ label: r.month, cents: r.amountCents }));
  const maxCents = fallbackBarData.reduce((m, d) => (d.cents > m ? d.cents : m), 0n);
  if (fallbackBarData.length > 0) {
    lines.push(`BAR CHART: ${barSource}`);
    const chartX = 40;
    const chartY = 130;
    const chartW = 300;
    const chartH = 120;
    fillRect(chartX, chartY, chartW, 2, [0, 0, 0]); // 横轴
    fillRect(chartX, chartY - chartH, 2, chartH, [0, 0, 0]); // 纵轴
    const barW = Math.max(6, Math.floor(chartW / fallbackBarData.length) - 6);
    fallbackBarData.forEach((d, i) => {
      const h = pngBarHeight(d.cents, maxCents, chartH);
      const bx = chartX + 6 + i * ((chartW - 6) / fallbackBarData.length);
      fillRect(bx, chartY - h, barW, h, [0x2a, 0x4a, 0x7f]);
      drawText(pngBarLabel(d.cents), bx, chartY - h - 14, 1, [0x2a, 0x4a, 0x7f]);
      drawText(d.label, bx, chartY + 6, 1);
    });
  } else {
    lines.push('BAR CHART: (NO DATA IN RANGE)');
  }
  lines.push('');
  lines.push('METRIC TABLE (CURRENT FILTERED RESULT):');
  for (const section of buildExportSections(report)) {
    const isEmpty = section.rows.length === 0;
    lines.push(`[${section.key}]${isEmpty ? ' (EMPTY)' : ''}`);
    if (!isEmpty) {
      lines.push(section.header.join(' | '));
      for (const row of section.rows) {
        lines.push(row.join(' | '));
      }
    }
  }

  let y = 18;
  for (const line of lines) {
    drawText(line, 14, y, 2);
    y += 16;
    if (y > PNG_HEIGHT - 8) break;
  }

  // tEXt 元数据：当前指标与筛选值（UTF-8 JSON），保证导出内容可检索
  const raw = PNG.sync.write(png);
  return insertTextChunk(raw, 'Report', reportSummaryJson(report));
}

/** PNG CRC32（zlib 多项式 0xEDB88320）。 */
function crc32(buf: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0; // CRC-32 为无符号 32 位，writeUInt32BE 需要非负值
}

const crcTable: number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 在 IEND 前插入 tEXt 元数据块（keyword\0text）：按 PNG chunk 结构逐块解析定位 IEND。 */
function insertTextChunk(pngBytes: Buffer, keyword: string, text: string): Buffer {
  const signature = pngBytes.subarray(0, 8);
  const chunks: Buffer[] = [signature];
  let offset = 8;
  while (offset + 8 <= pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset);
    const type = pngBytes.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = pngBytes.subarray(offset, offset + 12 + length);
    if (type === 'IEND') {
      const textBytes = Buffer.from(text, 'utf8');
      const data = Buffer.concat([Buffer.from(keyword, 'ascii'), Buffer.from([0]), textBytes]);
      const lengthBuf = Buffer.alloc(4);
      lengthBuf.writeUInt32BE(data.length, 0);
      const typeBuf = Buffer.from('tEXt', 'ascii');
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
      chunks.push(Buffer.concat([lengthBuf, typeBuf, data, crcBuf]));
      chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    chunks.push(chunk);
    offset += 12 + length;
  }
  return pngBytes;
}

/** 导出服务入口：同一 ReportModel → 三种格式字节，内容与实时报表模型一致。 */
export class ReportingExportService {
  async exportExcel(report: ReportModel): Promise<Buffer> {
    return renderExcel(report);
  }

  async exportPdf(report: ReportModel): Promise<Buffer> {
    return renderPdf(report);
  }

  exportPng(report: ReportModel): Buffer {
    return renderPng(report);
  }
}
