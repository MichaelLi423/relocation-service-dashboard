import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const product = '搬迁服务工作台';
const packagedFolder = `${product}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const executable = join(process.cwd(), 'out', packagedFolder, `${product}.app`, 'Contents', 'MacOS', product);
test.skip(!existsSync(executable), '未找到真实打包 Electron，请先运行 npm run e2e:build');

async function initialize(page: Page): Promise<void> {
  // 无密码个人模式：空数据库自动建号并直接进入工作台（无初始化/登录界面）。
  await page.getByRole('heading', { name: '把每一次搬迁，推进得更稳' }).waitFor();
}

async function seedReminderLanes(page: Page): Promise<void> {
  for (let index = 1; index <= 7; index += 1) {
    await page.getByRole('button', { name: '新建搬迁项目' }).click();
    const create = page.getByRole('dialog', { name: '新建搬迁项目' });
    await create.getByRole('radio', { name: /保存为待进单/ }).check();
    await create.getByLabel(/客户名称/).fill(`布局提醒客户 ${index}`);
    await create.getByLabel(/区域/).selectOption(index % 2 ? 'East' : 'North');
    await create.getByRole('button', { name: '保存为待进单' }).click();
    await expect(create).toBeHidden();
    await page.getByRole('button', { name: '维护提醒' }).click();
    const reminder = page.getByRole('dialog', { name: '维护项目提醒' });
    await reminder.getByLabel(/当前提醒日期/).fill(`2026-08-${String(11 + index).padStart(2, '0')}`);
    await reminder.getByLabel(/备注内容/).fill(`第 ${index} 列提醒`);
    await reminder.getByRole('button', { name: '保存当前提醒' }).click();
    await expect(reminder).toBeHidden();
  }
  await expect(page.getByRole('region', { name: '提醒日期泳道' })).toBeVisible();
}

async function assertViewport(page: Page, width: 1024 | 1170 | 1190 | 1440, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
  const workspaceRegion = page.getByRole('region', { name: '项目工作区' });
  await expect(workspaceRegion, `视口 ${width}px 应存在单一“项目工作区”region`).toBeVisible();
  const layout = await page.evaluate(() => {
    const queue = document.querySelector<HTMLElement>('.queue-table-wrap');
    const filters = document.querySelector<HTMLElement>('.queue-filters');
    const topbar = document.querySelector<HTMLElement>('.topbar');
    const command = document.querySelector<HTMLElement>('.command');
    const lanes = document.querySelector<HTMLElement>('.reminder-lane-scroll');
    const reminders = document.querySelector<HTMLElement>('.reminder-panel');
    const detail = document.querySelector<HTMLElement>('.detail');
    const projectQueue = document.querySelector<HTMLElement>('#project-queue');
    const context = document.querySelector<HTMLElement>('.context');
    const workspace = document.querySelector<HTMLElement>('[aria-label="项目工作区"]');
    const rect = (node: HTMLElement | null) => node ? { top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width } : null;
    return {
      scrollingElement: document.scrollingElement?.tagName ?? '',
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      queueOverflow: queue ? getComputedStyle(queue).overflowX : '',
      filtersOverflow: filters ? filters.scrollWidth - filters.clientWidth : 999,
      topbarPosition: topbar ? getComputedStyle(topbar).position : '',
      topbarTop: topbar?.getBoundingClientRect().top ?? 999,
      commandPosition: command ? getComputedStyle(command).position : '',
      laneOverflow: lanes ? getComputedStyle(lanes).overflowX : '',
      laneScrollWidth: lanes?.scrollWidth ?? 0,
      laneClientWidth: lanes?.clientWidth ?? 0,
      laneCount: lanes?.querySelectorAll('.reminder-lane').length ?? 0,
      domOrder: Boolean(reminders && workspace && projectQueue
        && (reminders.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING)
        && (workspace.compareDocumentPosition(projectQueue) & Node.DOCUMENT_POSITION_FOLLOWING)),
      workspaceOrder: Boolean(workspace && context && detail && workspace.contains(context) && workspace.contains(detail)
        && (context.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)),
      reminders: rect(reminders), workspace: rect(workspace), detail: rect(detail), projectQueue: rect(projectQueue), context: rect(context),
      detailMaxHeight: detail ? getComputedStyle(detail).maxHeight : '',
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.scrollingElement).toBe('HTML');
  expect(layout.htmlOverflowY).toBe('visible');
  expect(layout.bodyOverflowY).toBe('visible');
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.queueOverflow).toMatch(/auto|scroll/);
  expect(layout.filtersOverflow).toBeLessThanOrEqual(1);
  expect(layout.topbarPosition).toBe('sticky');
  expect(layout.topbarTop).toBeGreaterThanOrEqual(-1);
  expect(layout.commandPosition).toBe('static');
  expect(layout.laneOverflow).toMatch(/auto|scroll/);
  expect(layout.laneCount).toBe(7);
  expect(layout.domOrder).toBe(true);
  expect(layout.workspaceOrder).toBe(true);
  expect(layout.workspace).not.toBeNull();
  expect(layout.detail).not.toBeNull();
  expect(layout.projectQueue).not.toBeNull();
  expect(layout.context).not.toBeNull();
  expect(layout.reminders!.bottom).toBeLessThanOrEqual(layout.workspace!.top + 1);
  expect(layout.workspace!.bottom).toBeLessThanOrEqual(layout.projectQueue!.top + 1);
  expect(Math.abs(layout.reminders!.left - layout.workspace!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.reminders!.width - layout.workspace!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(layout.workspace!.left - layout.projectQueue!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.workspace!.width - layout.projectQueue!.width)).toBeLessThanOrEqual(2);
  expect(layout.detailMaxHeight, `视口 ${width}px 的项目详情不应受固定 max-height 裁切`).toBe('none');
  if (width === 1024) expect(layout.laneScrollWidth).toBeGreaterThan(layout.laneClientWidth);
  if (layout.laneScrollWidth > layout.laneClientWidth) {
    const laneScroll = await page.locator('.reminder-lane-scroll').evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
      return { laneLeft: node.scrollLeft, pageLeft: document.scrollingElement?.scrollLeft ?? -1 };
    });
    expect(laneScroll.laneLeft).toBeGreaterThan(0);
    expect(laneScroll.pageLeft).toBe(0);
  }
  const firstLane = page.locator('.reminder-lane').first();
  await firstLane.focus();
  await expect(firstLane).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.reminder-card').first()).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const sticky = await page.evaluate(() => ({
    windowScrollY: window.scrollY,
    rootScrollTop: document.scrollingElement?.scrollTop ?? -1,
    bodyScrollTop: document.body.scrollTop,
    topbar: document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().top ?? 999,
  }));
  expect(sticky.windowScrollY).toBeGreaterThan(0);
  expect(sticky.rootScrollTop).toBe(sticky.windowScrollY);
  expect(sticky.bodyScrollTop).toBe(0);
  expect(sticky.topbar).toBeGreaterThanOrEqual(-1);
  await page.getByRole('button', { name: '项目队列' }).click();
  const queue = page.getByRole('region', { name: /^项目队列(?: \d+)?$/ });
  await expect(queue).toBeFocused();
  const focusSeam = await queue.evaluate((node) => ({
    targetTop: node.getBoundingClientRect().top,
    topbarBottom: document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().bottom ?? 999,
  }));
  expect(focusSeam.targetTop).toBeGreaterThanOrEqual(focusSeam.topbarBottom - 1);
  await expect(page.getByRole('heading', { name: /^项目队列(?: \d+)?$/ })).toBeVisible();
  await expect(page.getByText(/第 1–7 项 \/ 共 7 项/)).toBeVisible();
  await page.screenshot({ path: screenshot, fullPage: true });
}

test('最新布局：主导航直接显示标签库并打开现有标签库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rw-v2-tag-entry-'));
  const userData = join(root, 'user-data');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userData } });
    const page = await app.firstWindow();
    await initialize(page);
    const tagManagement = page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '标签库', exact: true });
    await expect(tagManagement, '“标签库”应直接显示在顶部主导航，无需打开“数据管理”').toBeVisible();
    await tagManagement.click();
    await expect(page.getByRole('dialog', { name: '管理标签库' })).toBeVisible();
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertIndependentDrawer(
  page: Page,
  width: 720 | 820 | 1024 | 1090 | 1190,
  screenshot: string,
  seedRecord = false,
): Promise<void> {
  await page.setViewportSize({ width, height: 768 });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '序列号地址更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '序列号地址更新' });
  if (seedRecord) {
    await dialog.getByLabel(/客户名称/).fill('响应式布局测试客户');
    await dialog.getByLabel(/新址地址/).fill('上海市浦东新区测试路一百二十八号三层搬迁实验室');
    await dialog.getByLabel(/序列号/).fill('SN-LAYOUT-001');
    await dialog.getByLabel(/Account ID/).fill('ACC-LAYOUT-001');
    await dialog.getByLabel(/更新日期/).fill('2026-09-17');
    await dialog.getByRole('button', { name: '保存记录', exact: true }).click();
  }
  await expect(dialog.getByText('响应式布局测试客户')).toBeVisible();
  const layout = await page.locator('.v2-independent').evaluate((root) => {
    const columns = getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean);
    const form = root.querySelector<HTMLElement>('.serial-address-form');
    const list = root.querySelector<HTMLElement>('.module-list');
    const pagination = root.querySelector<HTMLElement>('.queue-pagination');
    const tableScroll = root.querySelector<HTMLElement>('.serial-address-table-scroll');
    const table = root.querySelector<HTMLElement>('.serial-address-table');
    const header = table?.querySelector<HTMLElement>('thead');
    const row = table?.querySelector<HTMLElement>('tbody tr');
    const address = table?.querySelector<HTMLElement>('.serial-address-address');
    const action = table?.querySelector<HTMLElement>('.serial-address-action .button');
    return {
      columns: columns.length,
      formWidth: form?.getBoundingClientRect().width ?? 0,
      listWidth: list?.getBoundingClientRect().width ?? 0,
      paginationOverflow: pagination ? pagination.scrollWidth - pagination.clientWidth : 999,
      tableOverflow: tableScroll ? tableScroll.scrollWidth - tableScroll.clientWidth : 999,
      tableDisplay: table ? getComputedStyle(table).display : '',
      headerDisplay: header ? getComputedStyle(header).display : '',
      rowDisplay: row ? getComputedStyle(row).display : '',
      addressWidth: address?.getBoundingClientRect().width ?? 0,
      actionVisible: Boolean(action && action.getBoundingClientRect().right <= (list?.getBoundingClientRect().right ?? 0) + 1),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(layout.columns).toBe(width >= 1180 ? 2 : 1);
  if (width >= 1180) {
    expect(layout.formWidth).toBeGreaterThanOrEqual(360);
    expect(layout.formWidth).toBeLessThanOrEqual(390);
    expect(layout.listWidth).toBeGreaterThanOrEqual(660);
  } else {
    expect(layout.listWidth).toBeGreaterThan(width === 720 ? 620 : 680);
  }
  expect(layout.paginationOverflow).toBeLessThanOrEqual(1);
  expect(layout.tableOverflow).toBeLessThanOrEqual(1);
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.addressWidth).toBeGreaterThan(width < 760 ? 300 : 190);
  expect(layout.actionVisible).toBe(true);
  expect(layout.tableDisplay).toBe(width < 760 ? 'block' : 'table');
  expect(layout.headerDisplay).toBe(width < 760 ? 'none' : 'table-header-group');
  expect(layout.rowDisplay).toBe(width < 760 ? 'grid' : 'table-row');
  await page.screenshot({ path: screenshot, fullPage: true });
  await dialog.getByRole('button', { name: '关闭' }).click();
}

async function assertHistoryDrawer(page: Page, width: 820 | 1024, screenshot: string): Promise<void> {
  await page.setViewportSize({ width, height: 768 });
  await page.getByRole('button', { name: '浏览全部记录' }).click();
  const dialog = page.getByRole('dialog', { name: '浏览往期与全部记录' });
  await expect(dialog.getByText('全部项目')).toBeVisible();
  await expect(dialog.getByText(/后端尚未提供|请选择项目/)).toHaveCount(0);
  await expect(dialog.getByRole('columnheader', { name: '项目 / 客户' })).toBeVisible();
  const layout = await dialog.locator('.history-browser').evaluate((root) => ({
    columns: getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean).length,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(layout.columns).toBe(width === 1024 ? 2 : 1);
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: screenshot, fullPage: true });
  await dialog.getByRole('button', { name: '关闭' }).click();
}

async function assertDeepFormFocusBelowTopbar(app: ElectronApplication, page: Page): Promise<void> {
  await page.setViewportSize({ width: 1024, height: 768 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBe(1.5);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole('button', { name: '编辑项目资料' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目资料' });
  // 等弹层的预设首焦点落定，再验证深层控件，避免与 Layer 的 0ms autofocus 竞争。
  await expect(dialog.getByLabel(/客户名称/)).toBeFocused();
  const deepControl = dialog.getByLabel(/暂存地址/);
  await deepControl.focus();
  await expect(deepControl).toBeFocused();
  const seam = await deepControl.evaluate((node) => {
    const command = document.querySelector<HTMLElement>('.command');
    const intro = command?.firstElementChild?.getBoundingClientRect();
    const actions = command?.querySelector<HTMLElement>('.row-actions')?.getBoundingClientRect();
    const target = node.getBoundingClientRect();
    return {
      zoomedViewportWidth: window.innerWidth,
      targetTop: target.top,
      targetBottom: target.bottom,
      topbarBottom: document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().bottom ?? 0,
      commandWrapped: Boolean(intro && actions && actions.top >= intro.bottom - 1),
    };
  });
  expect(seam.zoomedViewportWidth).toBeLessThanOrEqual(700);
  expect(seam.commandWrapped).toBe(true);
  expect(seam.targetTop).toBeGreaterThanOrEqual(seam.topbarBottom - 1);
  expect(seam.targetBottom).toBeLessThanOrEqual(768 + 1);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
}

test('最新布局：提醒、全宽单一项目工作区、项目队列依次排列且详情不裁切', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'rw-v2-layout-'));
  const userData = join(root, 'user-data');
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ executablePath: executable, env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userData } });
    const page = await app.firstWindow();
    await initialize(page);
    await seedReminderLanes(page);
    await assertViewport(page, 1024, testInfo.outputPath('workbench-v2-1024.png'));
    await assertViewport(page, 1170, testInfo.outputPath('workbench-v2-1170.png'));
    await assertViewport(page, 1190, testInfo.outputPath('workbench-v2-1190.png'));
    await assertViewport(page, 1440, testInfo.outputPath('workbench-v2-1440.png'));
    await assertIndependentDrawer(page, 1190, testInfo.outputPath('serial-address-drawer-1190.png'), true);
    await assertIndependentDrawer(page, 1090, testInfo.outputPath('serial-address-drawer-1090.png'));
    await assertIndependentDrawer(page, 1024, testInfo.outputPath('serial-address-drawer-1024.png'));
    await assertIndependentDrawer(page, 820, testInfo.outputPath('serial-address-drawer-820.png'));
    await assertIndependentDrawer(page, 720, testInfo.outputPath('serial-address-drawer-720.png'));
    await assertHistoryDrawer(page, 1024, testInfo.outputPath('history-drawer-1024.png'));
    await assertHistoryDrawer(page, 820, testInfo.outputPath('history-drawer-820.png'));
    await assertDeepFormFocusBelowTopbar(app, page);
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
