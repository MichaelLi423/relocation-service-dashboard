import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  assertMobileReadonlyBuildArtifacts,
  closeFixtureService,
  cloneSnapshot,
  makeEmptyPublishedSnapshot,
  openMobileReadonlyPage,
  syntheticBuilder,
  startFixtureMobileService,
  uploadSnapshotHttp,
  type FixtureMobileService,
} from './mobile-readonly-fixture';

/**
 * 手机只读浏览器独立 E2E 路径（tasks 6.5；另含 6.4 状态区分/断网语义的浏览器层证据）。
 *
 * - 真实本地 HTTPS 服务 + 真实构建产物 dist/mobile-readonly/web（先 `npm run
 *   build:mobile-readonly`）；产物缺失时测试**失败**而非跳过。
 * - 合成规模：45 个项目（首个项目每类关联记录 ≥25），浏览器端以服务端有界查询
 *   分页（limit=20，手机控制器固定）翻到末页/第二页验证。
 * - 视口分别 360px 与 390px；每步验证无页面级横向溢出
 *   （documentElement.scrollWidth <= window.innerWidth）。
 * - 证书：Chromium 由 mobile-readonly 配置以 `--ignore-certificate-errors-spki-list`
 *   精确放行 `tests/server/fixtures/tls/cert.pem`（仅本测试证书），不使用
 *   ignoreHTTPSErrors / NODE_TLS_REJECT_UNAUTHORIZED / rejectUnauthorized:false。
 * - 全部断言走手机页面 DOM 与服务端有界 GET；未发布/已发布空快照/断网完整刷新
 *   由单独用例覆盖。
 */
assertMobileReadonlyBuildArtifacts();

const VIEW_PUBLICATION_ID = 'synthetic-e2e-view-0001';
const LONG_CUSTOMER_NAME = `合成客户-44-超长文本${'ABCDE'.repeat(60)}`;

function buildViewSnapshot() {
  const base = cloneSnapshot(
    syntheticBuilder.buildSyntheticSnapshot({ projectCount: 45, firstProjectRecords: 25 }),
  );
  const projects = base.projects.slice();
  const last = projects[44]!;
  projects[44] = { ...last, customerName: LONG_CUSTOMER_NAME };
  return { ...base, projects };
}

async function startPublishedViewService() {
  const service = await startFixtureMobileService({ clockIso: '2026-08-08T10:00:00.000Z' });
  const response = await uploadSnapshotHttp(service.baseUrl, {
    publicationId: VIEW_PUBLICATION_ID,
    expectedCurrentVersion: 0,
    snapshot: buildViewSnapshot(),
  });
  if (response.status !== 200) {
    await closeFixtureService(service);
    throw new Error(`上传合成快照失败：HTTP ${response.status} ${response.body.slice(0, 300)}`);
  }
  return service;
}

async function closeService(service: FixtureMobileService): Promise<void> {
  await closeFixtureService(service);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth, `页面出现横向溢出：scrollWidth=${metrics.scrollWidth} innerWidth=${metrics.innerWidth}`).toBeLessThanOrEqual(metrics.innerWidth);
}

// 项目列表项目卡：App.tsx 卡片是 <button class="mr-project-card">，其 .mr-project-name
// 内含装饰性 <span aria-hidden>↗</span>（不计入可访问名称）。因此不能对客户名使用
// 页面级 getByText exact——改用「项目列表 section 内 role=button 的可访问名称」做正则
// 匹配（转义 + 数字/字母/连字符后置否定，避免匹配到更长编号的假阳性），再在卡片内的
// .mr-project-name 上精确核对客户名内容（去装饰）。缺失客户仍会使断言失败。
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function projectCardNamePattern(customer: string): RegExp {
  // 可访问名称形如 "TP-SYN-00 待进单 合成客户-00 ECC …"；前置要求词界起始/非 ASCII 词符，
  // 后置 (?![-0-9A-Za-z]) 确保不是更长编号（如 合成客户-001/合成客户-44-…）的一部分。
  return new RegExp(`(^|[^0-9A-Za-z-])${escapeRegExp(customer)}(?![0-9A-Za-z-])`);
}
function projectListSection(page: Page): Locator {
  return page.getByLabel('项目列表');
}
function projectCardByName(page: Page, customer: string): Locator {
  return projectListSection(page).getByRole('button', { name: projectCardNamePattern(customer) });
}
function projectCardCount(page: Page): Locator {
  return projectListSection(page).locator('button.mr-project-card');
}
async function expectProjectCard(page: Page, customer: string): Promise<void> {
  await expect(projectCardByName(page, customer)).toBeVisible();
  await expect(projectCardByName(page, customer).locator('.mr-project-name')).toContainText(customer);
}

/** 项目/记录 kind 与移动端展示标签的对应（服务端 kind 即快照六类键）。 */
const RECORD_KINDS = [
  ['batches', '批次'],
  ['instruments', '仪器'],
  ['activities', '上门活动'],
  ['orders', '开单'],
  ['invoices', '掉票'],
  ['damage_items', '损坏维修'],
] as const;

async function verifySixRecordKindsSecondPage(page: Page): Promise<void> {
  const recordTypes = page.getByRole('group', { name: '记录类型' });
  for (const [kind, label] of RECORD_KINDS) {
    await recordTypes.getByRole('button', { name: label }).click();
    const pagination = page.getByLabel('记录翻页');
    await expect(pagination.getByText('第 1 页')).toBeVisible();
    await expect(page.getByText(`p0-${kind}-0`, { exact: true }).first()).toBeVisible();
    await pagination.getByRole('button', { name: '下一页 →' }).click();
    await expect(pagination.getByText('第 2 页')).toBeVisible();
    await expect(page.getByText(`p0-${kind}-24`, { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
}

async function runFullViewPath(browser: Browser, width: number, baseUrl: string): Promise<void> {
  const opened = await openMobileReadonlyPage(browser, baseUrl, { width, height: 844 });
  const page = opened.page;
  try {
    // —— 概览 + 已发布标签（metadata 当前版本随响应载体而来） ——
    await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
    await expect(page.getByText('已发布 · V1', { exact: true })).toBeVisible();
    const overview = page.getByLabel('概览指标');
    await expect(overview).toContainText('项目总数');
    await expect(overview).toContainText('45');
    await expectNoHorizontalOverflow(page);

    // —— 搜索：客户名称（子串，服务端执行；仅命中项目 31，卡片唯一） ——
    const query = page.getByLabel('搜索项目');
    await query.fill('合成客户-31');
    await page.getByRole('button', { name: '查询项目' }).click();
    await expectProjectCard(page, '合成客户-31');
    await expect(projectCardCount(page)).toHaveCount(1);
    await expect(projectCardByName(page, '合成客户-00')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // 临时编号搜索（TP-SYN-00 只有项目 00）
    await query.fill('TP-SYN-00');
    await page.getByRole('button', { name: '查询项目' }).click();
    await expectProjectCard(page, '合成客户-00');
    await expect(projectCardCount(page)).toHaveCount(1);

    // ECC 搜索（ECC-SYN-01 只有正式进单项目 01）
    await query.fill('ECC-SYN-01');
    await page.getByRole('button', { name: '查询项目' }).click();
    await expectProjectCard(page, '合成客户-01');
    await expect(projectCardCount(page)).toHaveCount(1);
    await expect(projectCardByName(page, '合成客户-00')).toHaveCount(0);

    // 重置回全量
    await page.getByRole('button', { name: '重置条件' }).click();
    await expectProjectCard(page, '合成客户-00');

    // —— 状态筛选：已完成（idx 6/14/22/30/38 共 5 项，单页且无下一页） ——
    await page.getByLabel('项目状态').selectOption('completed');
    await page.getByRole('button', { name: '查询项目' }).click();
    await expectProjectCard(page, '合成客户-06');
    await expectProjectCard(page, '合成客户-38');
    await expect(projectCardCount(page)).toHaveCount(5);
    await expect(projectCardByName(page, '合成客户-00')).toHaveCount(0);
    await expect(page.getByLabel('项目翻页').getByRole('button', { name: '下一页 →' })).toBeDisabled();
    await page.getByRole('button', { name: '重置条件' }).click();
    await expectProjectCard(page, '合成客户-00');

    // —— 区域筛选（忽略大小写精确匹配 East；命中含项目 00，不命中项目 01） ——
    await page.getByLabel('区域').fill('east');
    await page.getByRole('button', { name: '查询项目' }).click();
    await expectProjectCard(page, '合成客户-00');
    await expect(projectCardByName(page, '合成客户-01')).toHaveCount(0);
    await page.getByRole('button', { name: '重置条件' }).click();

    // —— 分页到最后一页（45 项目 / limit=20 => 第 3 页为 40..44；第 44 个为超长名称） ——
    const projectNav = page.getByLabel('项目翻页');
    await expect(projectNav.getByText('第 1 页')).toBeVisible();
    await projectNav.getByRole('button', { name: '下一页 →' }).click();
    await expect(projectNav.getByText('第 2 页')).toBeVisible();
    await projectNav.getByRole('button', { name: '下一页 →' }).click();
    await expect(projectNav.getByText('第 3 页')).toBeVisible();
    await expectProjectCard(page, LONG_CUSTOMER_NAME);
    await expect(projectNav.getByRole('button', { name: '下一页 →' })).toBeDisabled();
    await expectNoHorizontalOverflow(page);

    // 回第 1 页并打开首个项目详情
    await projectNav.getByRole('button', { name: '← 上一页' }).click();
    await projectNav.getByRole('button', { name: '← 上一页' }).click();
    await expect(projectNav.getByText('第 1 页')).toBeVisible();
    await expectProjectCard(page, '合成客户-00');
    await projectCardByName(page, '合成客户-00').click();

    // —— 详情：项目基础信息与默认记录类（批次） ——
    await expect(page.getByRole('heading', { name: '项目详情' })).toBeVisible();
    const baseInfo = page.getByLabel('项目基础信息');
    await expect(baseInfo).toContainText('TP-SYN-00');
    await expect(baseInfo).toContainText('synthetic-project-00');
    await expect(baseInfo).toContainText('East');
    await expect(baseInfo).toContainText('合成客户-00');
    // 六类关联记录各自翻到第 2 页
    await verifySixRecordKindsSecondPage(page);

    // —— 返回列表后保持无页面级横向溢出 ——
    await page.getByRole('button', { name: '← 返回项目列表' }).click();
    await expect(page.getByRole('heading', { name: '项目工作台' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await opened.context.close();
  }
}

for (const width of [360, 390]) {
  test(`手机只读工作台 ${width}px：概览/客户·ECC·临时编号搜索/状态·区域筛选/末页分页/项目详情六类记录第2页 无横向溢出（tasks 6.5）`, async ({ browser }) => {
    test.setTimeout(120_000);
    const service = await startPublishedViewService();
    try {
      await runFullViewPath(browser, width, service.baseUrl);
    } finally {
      await closeService(service);
    }
  });
}

test('尚未发布与已发布空快照在手机页面明确区分（未发布含 "尚未发布数据"，不显示任何写入表单）', async ({ browser }) => {
  test.setTimeout(60_000);
  // 场景一：服务已启动但从未成功接收发布 => 尚未发布
  const unpublishedService = await startFixtureMobileService({ clockIso: '2026-08-08T10:00:00.000Z' });
  try {
    const opened = await openMobileReadonlyPage(browser, unpublishedService.baseUrl, { width: 390 });
    const page = opened.page;
    try {
      await expect(page.getByText('尚未发布', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '尚未发布数据' })).toBeVisible();
      await expect(page.getByText('已发布，暂无项目')).toHaveCount(0);
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /新建|删除|导出|备份|上传|登录/ })).toHaveCount(0);
    } finally {
      await opened.context.close();
    }
  } finally {
    await closeService(unpublishedService);
  }

  // 场景二：已发布空集合快照 => 版本 ≥1、显示空快照提示（与尚未发布区分）
  const emptyService = await startFixtureMobileService({ clockIso: '2026-08-08T10:00:00.000Z' });
  try {
    const emptySnapshot = makeEmptyPublishedSnapshot();
    const response = await uploadSnapshotHttp(emptyService.baseUrl, {
      publicationId: 'synthetic-e2e-empty-0001',
      expectedCurrentVersion: 0,
      snapshot: emptySnapshot,
    });
    expect(response.status).toBe(200);
    const opened = await openMobileReadonlyPage(browser, emptyService.baseUrl, { width: 390 });
    const page = opened.page;
    try {
      await expect(page.getByText('已发布 · V1', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '已发布，暂无项目' })).toBeVisible();
      await expect(page.getByText('尚未发布数据')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    } finally {
      await opened.context.close();
    }
  } finally {
    await closeService(emptyService);
  }
});

test('完整刷新且服务不可达时浏览器页面不可用（no-store 无离线缓存，不伪造内容）', async ({ browser }) => {
  test.setTimeout(60_000);
  let service: FixtureMobileService | null = null;
  try {
    service = await startPublishedViewService();
    const opened = await openMobileReadonlyPage(browser, service.baseUrl, { width: 390 });
    const page = opened.page;
    // 先正常加载（服务可达、内容在内存中）
    await expect(page.getByText('已发布 · V1', { exact: true })).toBeVisible();
    await expectProjectCard(page, '合成客户-00');
    // 关闭服务后完整刷新：浏览器页面不可用（连接被拒绝），而非用缓存/内存恢复旧内容
    await service.close();
    service = null;
    await expect(page.reload({ waitUntil: 'domcontentloaded' })).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    await opened.context.close();
  } finally {
    if (service) await closeFixtureService(service);
  }
});
