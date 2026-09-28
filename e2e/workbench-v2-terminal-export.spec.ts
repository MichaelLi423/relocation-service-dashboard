import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { PNG } from 'pngjs';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  APP_EXECUTABLE,
  cleanupImportE2eFiles,
  createImportE2eFiles,
  firstWindow,
  installNativeDialogStubs,
  launchImportApp,
  restoreNativeDialogStubs,
} from './import-wizard-fixture';

/**
 * 真实打包 Electron UI 冒烟补充（WorkbenchV2，macOS 开发机 · 临时 userData）。
 *
 * 覆盖两件事（全部经真实 UI + 真实 IPC，不绕过界面）：
 * 1) 界面取消项目：填写取消日期/取消原因/不可恢复确认，验证取消终态
 *    （队列状态徽标为「已取消」、取消入口消失、已取消不可恢复）。
 *    造数走当前单页四分组新建表单（保存意图「正式进单」），与 electron-smoke 同交互路径。
 * 2) 运营报表导出：依次触发 Excel/PNG/PDF 三种导出。参照
 *    e2e/import-wizard-fixture.ts 的原生 dialog stubs 方案，在 Electron main
 *    进程安全打桩 dialog.showSaveDialog 到临时路径，验证三个文件生成且
 *    magic header / 内容有效（xlsx=ZIP magic + 可读回内容、pdf=%PDF- + Info
 *    元数据、png=PNG magic + tEXt 元数据 + 非空像素）。
 *
 * 运行方式（与 Windows 打包验证无关）：
 *   1) `npm run e2e:build`（electron-forge package）
 *   2) `npm run test:e2e`（或聚焦：npx playwright test e2e/workbench-v2-terminal-export.spec.ts）
 *
 * 保持现有 UI 设计不变；测试自建临时目录并在 finally 中清理，可重复运行。
 */

test.skip(!existsSync(APP_EXECUTABLE), '未找到真实打包 Electron，请先运行 npm run e2e:build');

/** 当前自然月 YYYY-MM：进单/掉票与报表区间同月，测试自维护、不依赖固定日期。 */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 从 PNG 字节流中按 chunk 结构提取指定关键字的 tEXt 元数据（与集成测试同口径）。 */
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

/** 单页四分组新建表单正式进单一个 ECC 项目（与 electron-smoke 同交互路径）。 */
async function createFormalProject(
  page: Page,
  customerName: string,
  ecc: string,
  region = 'East',
  contractAmount?: string,
): Promise<void> {
  await page.getByRole('button', { name: '新建搬迁项目' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('客户名称').fill(customerName);
  await dialog.getByLabel('区域').selectOption(region);
  await dialog.getByLabel('合同开始日期').fill('2026-08-01');
  await dialog.getByLabel('合同截止日期').fill('2027-07-31');
  // 保存意图选「正式进单」：ECC/进单日期/合同金额仅随正式进单提交
  await dialog.getByRole('radio', { name: /正式进单/ }).check();
  await dialog.getByLabel(/^ECC/).fill(ecc);
  if (contractAmount !== undefined) {
    // 合同金额为空时正式进单须另行录入最终可确认金额 > 0（领域校验）；
    // 当前表单不再录入最终可确认金额，正式进单默认取合同金额，故此处必填正数合同金额。
    await dialog.getByLabel('合同 USD 含税金额').fill(contractAmount);
  }
  await dialog.getByRole('button', { name: '正式进单' }).click();
  await expect(page.getByText(ecc).first()).toBeVisible();
}

/** Excel 导出：ZIP magic + 可读回内容（区间标题行 + 本月掉票金额）。 */
async function assertXlsx(path: string, month: string): Promise<void> {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004'); // xlsx = ZIP magic header
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const texts: string[] = [];
  for (const row of workbook.worksheets[0].getSheetValues()) {
    if (row === null || row === undefined) continue;
    for (const value of Object.values(row as object)) {
      if (value !== null && value !== undefined) texts.push(String(value));
    }
  }
  expect(texts.some((t) => t.includes(`Range: ${month} TO ${month}`))).toBe(true);
  expect(texts).toContain('40000.00'); // 本月掉票金额与实时报表模型一致
}

/** PDF 导出：%PDF- magic + Info 字典元数据可读回（标题/区间/指标）。 */
async function assertPdf(path: string, month: string): Promise<void> {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pdf = await import('pdf-lib').then((m) => m.PDFDocument.load(bytes));
  expect(pdf.getTitle()).toBe('Relocation Workbench - Operations Report');
  const subject = pdf.getSubject() ?? '';
  expect(subject).toContain(`"from":"${month}"`);
  expect(subject).toContain(`"to":"${month}"`);
  expect(subject).toContain('40000.00');
}

/** PNG 导出：PNG magic + 非空像素 + tEXt 元数据（range/月度掉票）。 */
function assertPng(path: string, month: string): void {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString('latin1')).toBe('\u0089PNG\r\n\u001a\n');
  const decoded = PNG.sync.read(bytes);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
  let nonWhite = 0;
  for (let i = 0; i < decoded.data.length; i += 4) {
    if (decoded.data[i] !== 255 || decoded.data[i + 1] !== 255 || decoded.data[i + 2] !== 255) nonWhite += 1;
  }
  expect(nonWhite).toBeGreaterThan(100); // 非空图
  const meta = JSON.parse(extractPngTextChunk(bytes, 'Report')) as {
    range: { from: string; to: string };
    filters: Record<string, unknown>;
    sections: Array<{ key: string; rows: Array<Array<string | number | boolean | null>> }>;
  };
  expect(meta.range).toEqual({ from: month, to: month });
  expect(meta.filters.orderType).toBeNull();
  const invoice = meta.sections.find((s) => s.key === 'monthly_invoice');
  expect(invoice?.rows).toContainEqual([month, '40000.00', '1']);
}

test.describe('真实打包 Electron UI 冒烟补充（WorkbenchV2 · 临时 userData）', () => {
  test('界面取消项目：取消日期/原因/不可恢复确认 → 取消终态', async () => {
    const files = createImportE2eFiles();
    let app: ElectronApplication | null = null;
    try {
      app = await launchImportApp(files.userData);
      const page = await firstWindow(app);
      await expect(page.getByRole('button', { name: '新建搬迁项目' })).toBeVisible();

      // 正式进单一个无任何掉票历史的项目（有掉票历史禁止取消）。
      // 合同金额为空时正式进单必须另行录入最终可确认金额 > 0（领域校验）。
      await createFormalProject(page, 'E2E 取消终态客户', 'E2E-CANCEL-0001', 'East', '100000');

      // 选中项目 → 当前上下文出现取消入口
      const row = page
        .getByRole('grid', { name: '项目队列' })
        .getByRole('row')
        .filter({ hasText: 'E2E 取消终态客户' });
      await row.click();
      await page.getByRole('button', { name: '取消项目' }).click();

      // 填写取消日期/取消原因/不可恢复确认
      const cancelDialog = page.getByRole('dialog');
      await cancelDialog.getByLabel('取消日期').fill(`${currentMonth()}-10`);
      await cancelDialog.getByLabel('取消原因').fill('E2E 客户业务调整，取消搬迁');
      await cancelDialog.getByLabel('我确认项目取消后不可恢复').check();
      await cancelDialog.getByRole('button', { name: '确认取消项目' }).click();

      // 取消终态：提示、队列状态徽标「已取消」、取消入口消失（终态不可再次取消）
      await expect(page.getByText('项目已取消')).toBeVisible();
      await expect(
        page
          .getByRole('grid', { name: '项目队列' })
          .getByRole('row')
          .filter({ hasText: 'E2E 取消终态客户' })
          .getByText('已取消'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '取消项目' })).toHaveCount(0);
    } finally {
      if (app) {
        await restoreNativeDialogStubs(app).catch(() => undefined);
        await app.close().catch(() => undefined);
      }
      cleanupImportE2eFiles(files);
    }
  });

  test('运营报表导出 Excel/PNG/PDF：main 侧 showSaveDialog 打桩 → 三文件 magic/content 有效', async () => {
    test.setTimeout(240_000);
    const files = createImportE2eFiles();
    const month = currentMonth();
    const exports = {
      xlsx: join(files.root, 'E2E-运营报表.xlsx'),
      png: join(files.root, 'E2E-运营报表.png'),
      pdf: join(files.root, 'E2E-运营报表.pdf'),
    };
    let app: ElectronApplication | null = null;
    try {
      app = await launchImportApp(files.userData);
      const page = await firstWindow(app);
      // 主进程侧打桩 showSaveDialog（复用导入向导 fixture 的原生 dialog stubs 方案）
      await installNativeDialogStubs(app, { savePath: exports.xlsx, openPaths: [] });
      await expect(page.getByRole('button', { name: '新建搬迁项目' })).toBeVisible();

      // 造数：正式进单项目 + 本月一张掉票（报表 monthly_invoice / 条形图有数据）
      await createFormalProject(page, 'E2E 报表导出客户', 'E2E-EXPORT-0001', 'East', '100000');
      await page.getByRole('button', { name: '快速记录', exact: false }).first().click();
      await page.getByRole('dialog').getByRole('button', { name: /^掉票/ }).click();
      const invoiceDialog = page.getByRole('dialog');
      await invoiceDialog.getByLabel('掉票日期').fill(`${month}-11`);
      await invoiceDialog.getByLabel('掉票金额（USD）').fill('40000');
      await invoiceDialog.getByRole('button', { name: '保存记录' }).click();

      // 运营报表：本月区间 → 实时计算 → 依次导出三种格式
      await page.getByRole('button', { name: '运营报表' }).click();
      const reportDialog = page.getByRole('dialog');
      await reportDialog.getByLabel('起始月份').fill(month);
      await reportDialog.getByLabel('截止月份').fill(month);

      // 工作范围筛选控件存在，选择区域时给出排除提示
      await expect(reportDialog.getByLabel('工作范围')).toBeVisible();
      await reportDialog.getByLabel('区域').fill('East');
      await expect(reportDialog.getByText(/不关联项目的独立记录（含中大型项目开单）会被排除/)).toBeVisible();
      await reportDialog.getByLabel('区域').fill('');

      await reportDialog.getByRole('button', { name: '实时计算报表' }).click();
      await expect(reportDialog.getByText('月度掉票').first()).toBeVisible();

      // Excel
      await reportDialog.getByRole('button', { name: '导出 Excel' }).click();
      await expect.poll(() => existsSync(exports.xlsx)).toBe(true);
      await assertXlsx(exports.xlsx, month);

      // PNG（重新打桩到 png 路径）
      await installNativeDialogStubs(app, { savePath: exports.png, openPaths: [] });
      await reportDialog.getByRole('button', { name: '导出 PNG' }).click();
      await expect.poll(() => existsSync(exports.png)).toBe(true);
      assertPng(exports.png, month);

      // PDF（重新打桩到 pdf 路径）
      await installNativeDialogStubs(app, { savePath: exports.pdf, openPaths: [] });
      await reportDialog.getByRole('button', { name: '导出 PDF' }).click();
      await expect.poll(() => existsSync(exports.pdf)).toBe(true);
      await assertPdf(exports.pdf, month);
    } finally {
      if (app) {
        await restoreNativeDialogStubs(app).catch(() => undefined);
        await app.close().catch(() => undefined);
      }
      cleanupImportE2eFiles(files);
    }
  });
});
