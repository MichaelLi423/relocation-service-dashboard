import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const product = '搬迁服务工作台';
const packagedFolder = `${product}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const executable = join(process.cwd(), 'out', packagedFolder, `${product}.app`, 'Contents', 'MacOS', product);
test.skip(!existsSync(executable), '未找到真实打包 Electron，请先运行 npm run e2e:build');

let app: ElectronApplication | null = null;
let userDataDir: string | null = null;

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'deliver-service-e2e-iteration-'));
  app = await electron.launch({
    executablePath: executable,
    env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userDataDir },
  });
});

test.afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (userDataDir && existsSync(userDataDir)) {
    rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
  }
});

test('完整迭代真实 UI 交互核验与证据截图 (E2E)', async () => {
  test.setTimeout(180_000);
  const page = await app!.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('heading', { name: '把每一次搬迁，推进得更稳' })).toBeVisible({ timeout: 20_000 });

  const screenshotDir = join(process.cwd(), 'out', 'e2e-screenshots');
  if (!existsSync(screenshotDir)) {
    mkdirSync(screenshotDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // 1. 创建真实合成项目（正式进单）并记录一张掉票
  // -------------------------------------------------------------------------
  await page.getByRole('button', { name: '新建搬迁项目' }).click();
  const createDialog = page.getByRole('dialog', { name: '新建搬迁项目' });
  await createDialog.getByLabel('客户名称').fill('迭代真实核验客户单位');
  await createDialog.getByLabel('区域').selectOption('East');
  await createDialog.getByLabel('合同开始日期').fill('2026-07-01');
  await createDialog.getByLabel('合同截止日期').fill('2027-06-30');
  await createDialog.getByRole('radio', { name: /正式进单/ }).check();
  await createDialog.getByLabel(/^ECC/).fill('ECC-ITER-202607');
  await createDialog.locator('input[name="entryAt"]').fill('2026-07-01');
  await createDialog.getByLabel('合同 USD 含税金额').fill('100000.00');
  await createDialog.getByLabel('计划上门日期').fill('2026-08-15');
  await createDialog.getByRole('button', { name: '正式进单' }).click();
  await expect(createDialog).toBeHidden();
  await expect(page.getByText('ECC-ITER-202607').first()).toBeVisible();

  // 记录掉票（快速记录）
  await page.getByRole('button', { name: '快速记录' }).first().click();
  const quickMenu = page.getByRole('dialog', { name: '快速记录' });
  await quickMenu.getByRole('button', { name: /^掉票/ }).click();
  const invoiceDialog = page.getByRole('dialog', { name: '掉票' });
  await invoiceDialog.getByLabel('掉票日期').fill('2026-07-20');
  await invoiceDialog.getByLabel('掉票金额（USD）').fill('25000.00');
  await invoiceDialog.getByRole('button', { name: '保存记录' }).click();
  await expect(invoiceDialog).toBeHidden();

  // -------------------------------------------------------------------------
  // 2. 核验需求 2：详情关联事实中「上门活动」计数下线，计划上门日期完好保留
  // -------------------------------------------------------------------------
  await page.getByText('完整项目资料').click();
  const factsRegion = page.getByRole('region', { name: '关联登记事实' });
  await expect(factsRegion).not.toContainText('上门活动');
  await expect(factsRegion).toContainText('掉票记录1 条');
  const movePlanRegion = page.getByRole('region', { name: '搬迁安排' });
  await expect(movePlanRegion).toContainText('2026-08-15');

  // 核验历史记录浏览中无「到访记录」入口
  await page.getByRole('button', { name: '浏览全部记录' }).click();
  const historyDialog = page.getByRole('dialog', { name: '浏览往期与全部记录' });
  const kindList = historyDialog.locator('.history-kind-list');
  await expect(kindList).not.toContainText('到访记录');
  await expect(kindList).toContainText('掉票记录');
  await historyDialog.getByRole('button', { name: '关闭' }).click();
  await expect(historyDialog).toBeHidden();

  // 截图 1：项目详情与事实下线核对
  await factsRegion.scrollIntoViewIfNeeded();
  const screenshotFacts = join(screenshotDir, '01-project-facts-no-visit.png');
  await page.screenshot({ path: screenshotFacts });

  // -------------------------------------------------------------------------
  // 3. 核验需求 3：显式快照更正前后，历史月份报表进单金额变更而当前合同金额不变
  // -------------------------------------------------------------------------
  // 步骤 3.1: 检查更正前的 2026-07 报表各区域新项目进单金额 (原为 100,000.00)
  await page.getByRole('button', { name: '运营报表' }).click();
  const reportDialog = page.getByRole('dialog', { name: '运营报表' });
  await reportDialog.getByLabel('起始月份').fill('2026-07');
  await reportDialog.getByLabel('截止月份').fill('2026-07');
  await reportDialog.getByRole('button', { name: '实时计算报表' }).click();
  await expect(reportDialog.getByText('计算结果')).toBeVisible();

  const entrySectionCard = reportDialog.locator('.report-section').filter({ hasText: '各区域新项目进单金额' });
  await entrySectionCard.getByRole('button', { name: '查看明细' }).click();
  const reportDetails = reportDialog.locator('.report-details');
  await expect(reportDetails.getByRole('table')).toContainText('100000.00');
  await reportDialog.getByRole('button', { name: '关闭' }).click();
  await expect(reportDialog).toBeHidden();

  // 步骤 3.2: 项目更正进单金额快照（不修改合同金额）
  await page.getByRole('button', { name: '更正进单/合同资料' }).click();
  const entryEditDialog = page.getByRole('dialog', { name: '更正进单/合同资料' });
  await expect(entryEditDialog.getByText(/当前进单金额快照：/)).toContainText('USD 100,000.00');

  // 勾选快照更正并验证警告文案与格式校验
  const snapshotCheckbox = entryEditDialog.getByRole('checkbox', { name: '更正进单金额快照' });
  await snapshotCheckbox.check();
  await expect(entryEditDialog.getByText('更正后将重新计算原进单月份的统计，不影响当前合同金额。')).toBeVisible();

  const snapshotInput = entryEditDialog.getByRole('spinbutton', { name: /更正进单金额快照/ });
  await snapshotInput.fill('160000.00');
  // 截图 1b：显式快照更正表单与警告提示
  const screenshotSnapshot = join(screenshotDir, '01b-snapshot-correction-form.png');
  await entryEditDialog.screenshot({ path: screenshotSnapshot });

  await entryEditDialog.getByRole('button', { name: '保存更正' }).click();
  await expect(entryEditDialog).toBeHidden();

  // 验证工作台当前合同金额依然不变（100,000.00），而进单快照已更新为 160,000.00
  await expect(page.locator('.detail-money')).toContainText('USD 100,000.00');
  await page.getByRole('tab', { name: '费用与掉票' }).click();
  const factGrid = page.locator('.fact-grid[aria-label="金额摘要"]');
  await expect(factGrid).toContainText('USD 160,000.00');

  // 步骤 3.3: 再次打开报表，验证 2026-07 历史进单金额已由 100,000 变为 160,000
  await page.getByRole('button', { name: '运营报表' }).click();
  await reportDialog.getByLabel('起始月份').fill('2026-07');
  await reportDialog.getByLabel('截止月份').fill('2026-07');
  await reportDialog.getByRole('button', { name: '实时计算报表' }).click();
  await expect(reportDialog.getByText('计算结果')).toBeVisible();

  await reportDialog.locator('.report-section').filter({ hasText: '各区域新项目进单金额' }).getByRole('button', { name: '查看明细' }).click();
  await expect(reportDialog.locator('.report-details').getByRole('table')).toContainText('160000.00');
  await expect(reportDialog.locator('.report-details').getByRole('table')).not.toContainText('100000.00');

  // -------------------------------------------------------------------------
  // 4. 核验需求 4：月度掉票表按月份+区域展示金额/次数/去重项目数，且标注已撤销不计
  // -------------------------------------------------------------------------
  const invoiceCard = reportDialog.locator('.report-section').filter({ hasText: '月度掉票' });
  await invoiceCard.getByRole('button', { name: '查看明细' }).click();

  const invoiceDetailsSection = reportDialog.locator('.report-details');
  await expect(invoiceDetailsSection.getByRole('heading', { name: '月度掉票' })).toBeVisible();
  await expect(invoiceDetailsSection.locator('.notice').filter({ hasText: '已撤销不计' })).toBeVisible();

  const invoiceSummaryTable = invoiceDetailsSection.getByRole('table');
  await expect(invoiceSummaryTable).toContainText('2026-07');
  await expect(invoiceSummaryTable).toContainText('East');
  await expect(invoiceSummaryTable).toContainText('25000.00'); // 掉票金额
  await expect(invoiceSummaryTable).toContainText('1'); // 掉票次数与去重项目数

  // 截图 2a：月度掉票汇总表（按月份与区域、已撤销不计）
  await invoiceDetailsSection.scrollIntoViewIfNeeded();
  const screenshotInvoiceSummary = join(screenshotDir, '02a-report-monthly-invoice-summary.png');
  await reportDialog.screenshot({ path: screenshotInvoiceSummary });

  // 支持切换到掉票下钻明细
  const detailTab = invoiceDetailsSection.getByRole('tab', { name: /掉票下钻明细/ });
  await detailTab.click();
  await expect(invoiceDetailsSection.getByRole('table')).toContainText('25000.00');

  // 截图 2b：月度掉票下钻明细
  await invoiceDetailsSection.scrollIntoViewIfNeeded();
  const screenshotInvoiceDetail = join(screenshotDir, '02b-report-monthly-invoice-detail.png');
  await reportDialog.screenshot({ path: screenshotInvoiceDetail });
  await reportDialog.getByRole('button', { name: '关闭' }).click();
  await expect(reportDialog).toBeHidden();

  // -------------------------------------------------------------------------
  // 5. 核验需求 1：二维码多类型去重计数、月份统计及筛选联动
  // -------------------------------------------------------------------------
  await page.getByRole('button', { name: '二维码申请' }).click();
  const qrDialog = page.getByRole('dialog', { name: '二维码申请' });
  await expect(qrDialog).toBeVisible();

  // 登记第一笔申请：2026-08-01 业务申请人甲，选择 3 类（去重工作量为 3）
  await qrDialog.getByRole('textbox', { name: /申请人/ }).fill('业务申请人甲');
  await qrDialog.locator('input[name="requestedAt"]').fill('2026-08-01');
  const typeGroup = qrDialog.getByRole('group', { name: /申请类型/ });
  // 勾选 A, B, 物流管理
  await typeGroup.getByRole('checkbox', { name: 'A' }).check();
  await typeGroup.getByRole('checkbox', { name: 'B' }).check();
  await typeGroup.getByRole('checkbox', { name: '物流管理' }).check();

  // 实时预览工作量应为 3
  await expect(qrDialog.locator('.qr-workload-preview')).toContainText('3 类');
  await expect(qrDialog.locator('.qr-workload-preview')).toContainText('3');
  await qrDialog.getByRole('button', { name: '保存申请' }).click();
  await expect(page.getByText('记录已保存')).toBeVisible();

  // 重新打开二维码申请登记第二笔：2026-09-01 业务申请人乙，选择 2 类（去重工作量为 2）
  await page.getByRole('button', { name: '二维码申请' }).click();
  const qrDialog2 = page.getByRole('dialog', { name: '二维码申请' });
  const typeGroup2 = qrDialog2.getByRole('group', { name: /申请类型/ });
  await qrDialog2.getByRole('textbox', { name: /申请人/ }).fill('业务申请人乙');
  await qrDialog2.locator('input[name="requestedAt"]').fill('2026-09-01');
  await typeGroup2.getByRole('checkbox', { name: 'B' }).uncheck();
  await typeGroup2.getByRole('checkbox', { name: 'OEM 设备' }).check();
  await qrDialog2.getByRole('button', { name: '保存申请' }).click();
  await expect(page.getByText('记录已保存')).toBeVisible();

  // 重新打开查看统计与筛选联动
  await page.getByRole('button', { name: '二维码申请' }).click();
  const qrStatsDialog = page.getByRole('dialog', { name: '二维码申请' });
  const qrStats = qrStatsDialog.getByRole('region', { name: '二维码工作量统计' });
  await expect(qrStats.getByText('申请总数（当前筛选）')).toBeVisible();
  await expect(qrStats).toContainText('2 条');
  await expect(qrStats.getByText('总工作量（当前筛选）')).toBeVisible();
  await expect(qrStats).toContainText('5'); // 3 + 2 = 5
  await expect(qrStats.getByText('有申请的月份')).toBeVisible();
  await expect(qrStats).toContainText('2 个月');

  // 按申请人维度
  await qrStats.getByRole('tab', { name: /按申请人统计/ }).click();
  await expect(qrStats.getByRole('table')).toContainText('业务申请人甲');
  await expect(qrStats.getByRole('table')).toContainText('业务申请人乙');

  // 按申请月份维度
  await qrStats.getByRole('tab', { name: /按申请月份统计/ }).click();
  await expect(qrStats.getByRole('table')).toContainText('2026-08');
  await expect(qrStats.getByRole('table')).toContainText('2026-09');

  // 按类型维度
  await qrStats.getByRole('tab', { name: /按类型统计/ }).click();
  await expect(qrStats.getByRole('table')).toContainText('物流管理');
  await expect(qrStats.getByRole('table')).toContainText('OEM 设备');

  // 筛选联动：限定 2026-08 月份，统计总数应实时缩减为 1 条，工作量为 3
  await qrStatsDialog.locator('.module-search').getByLabel('起始日期').fill('2026-08-01');
  await qrStatsDialog.locator('.module-search').getByLabel('截止日期').fill('2026-08-31');
  await qrStatsDialog.locator('.module-search').getByRole('button', { name: '查找' }).click();

  await expect(qrStats).toContainText('1 条');
  await expect(qrStats).toContainText('3');

  // 截图 3：二维码独立页工作量统计与筛选联动
  const screenshotQr = join(screenshotDir, '03-qr-request-workload-stats.png');
  await qrStatsDialog.screenshot({ path: screenshotQr });
  await qrStatsDialog.getByRole('button', { name: '关闭' }).click();
  await expect(qrStatsDialog).toBeHidden();
});
