import { test, expect } from '@playwright/test';
import {
  advanceDesktopClock,
  assertMobileReadonlyBuildArtifacts,
  closeDesktopApp,
  closeFixtureService,
  closePublishPanel,
  configurePublish,
  createBatchQuickRecord,
  createFormalProject,
  deleteBatchRecordByCompany,
  expectProjectDetail,
  DESKTOP_PERIODIC_MS,
  MOBILE_CHECK_INTERVAL_MS,
  REMAINING_BUDGET_MS,
  TOTAL_VISIBLE_BUDGET_MS,
  firstWorkbenchWindow,
  launchMobileReadonlyElectron,
  openMobileReadonlyPage,
  openPublishPanel,
  publishPanelField,
  queryProjectsHttp,
  queryRecordsHttp,
  readEnvelopeFile,
  readEnvelopeFileBytes,
  readMetaHttp,
  renameProjectCustomer,
  sleep,
  startFixtureMobileService,
  syntheticBuilder,
  cloneSnapshot,
  trustFixtureCaInMainProcess,
  uploadSnapshotHttp,
  UPLOAD_TOKEN,
  waitForServerVersion,
  waitWorkbenchReady,
  type FixtureMobileService,
  type OpenMobilePageResult,
} from './mobile-readonly-fixture';

/**
 * 移动只读发布端到端验收（tasks 8.1-8.3，openspec change add-mobile-readonly-publication）。
 *
 * - 真实打包 Electron（先 `npm run e2e:build`）+ 真实本地 HTTPS 服务（服务源码 +
 *   tests/server/fixtures/tls 测试证书）+ 真实手机浏览器页面（dist/mobile-readonly/web 构建产物）。
 * - 发布数据一律经**真实桌面 UI**录入/改名/删除（无直接 DB/IPC 写入）；上传凭证走真实
 *   OS 安全存储（safeStorage），服务端只存 scrypt 摘要。
 * - TLS：主进程经 `process.getBuiltinModule('node:https')` 注入测试 CA（默认证书校验，
 *   无 rejectUnauthorized:false / NODE_TLS_REJECT_UNAUTHORIZED）；浏览器端 Chromium 仅以
 *   `--ignore-certificate-errors-spki-list` 精确放行本夹具证书。
 * - 时钟：桌面周期经主进程 `__workbenchMobileReadonlyE2EClock.advance`（不触发 checkNow），
 *   手机页面以 page.clock 推进；全程不手动刷新手机页面、不按检查按钮、不切前后台。
 * - 预算（design D8）按真实墙钟分段测量并断言：本地检查 ≤120s、手机相邻检查 ≤60s、
 *   其余（生成/上传/取数/渲染）合计与总可见 ≤5 分钟口径。桌面合成规模如实声明：
 *   本套用例实际只经 UI 建立 1~2 个项目与 1~3 条批次记录（非 45 项目规模）。
 */
assertMobileReadonlyBuildArtifacts();

const SERVICE_PUBLICATION_BASE = 'e2e-desktop-publish';

// 远程服务凭证与测试数据规模（桌面真实 UI 场景，如实声明小规模）。
const SERVICE_CLOCK_ISO = '2026-08-08T10:00:00.000Z';

async function openPanelAndRead(page: Parameters<typeof openPublishPanel>[0], field: string): Promise<string> {
  await openPublishPanel(page);
  const value = await publishPanelField(page, field);
  await closePublishPanel(page);
  return value;
}

async function readFieldUntil(
  page: Parameters<typeof openPublishPanel>[0],
  field: string,
  predicate: (value: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const value = await openPanelAndRead(page, field);
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`发布面板字段「${field}」未在 ${timeoutMs}ms 内满足条件，最近值：${value}`);
    }
    await sleep(300);
  }
}

/** 打开面板并等待下一轮可见时的最新状态（面板打开即读一次 IPC 状态）。 */
async function assertSuccessStatus(page: Parameters<typeof openPublishPanel>[0]): Promise<void> {
  await readFieldUntil(page, '配置情况', (value) => value === '已配置');
  await readFieldUntil(page, '发布开关', (value) => value === '已启用');
  await readFieldUntil(page, '最近成功发布', (value) => value !== '尚无记录');
  await readFieldUntil(page, '最近失败', (value) => value === '尚无记录');
}

async function phoneAdvanceAndExpect(opened: OpenMobilePageResult, ms: number, text: string, absent = false, projectName = false): Promise<void> {
  await opened.clock.runFor(ms);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const locator = projectName
    ? opened.page.getByLabel('项目列表').locator('.mr-project-name').filter({ hasText: new RegExp(`^${escaped}\\s*↗?$`) })
    : opened.page.getByText(text, { exact: true });
  if (absent) {
    await expect(locator).toHaveCount(0);
  } else {
    await expect(locator).toBeVisible({ timeout: 20_000 });
  }
}

// ---------------------------------------------------------------------------
// P1：tasks 8.1 + 8.3 —— 默认关闭 → 一次性配置 → 启用 → 空首发 → 真实 UI 录入/改名
//      → 自动上传 → 手机页面（DOM）自动出现新值；5 分钟预算按真实墙钟分段测量断言。
// ---------------------------------------------------------------------------

test('P1 桌面发布端到端 + 手机自动可见（空首发→建档→改名，DOM 新值；预算实测）', async ({ browser }) => {
  test.setTimeout(600_000);
  const launched = await launchMobileReadonlyElectron();
  let service: FixtureMobileService | null = null;
  let phone: Awaited<ReturnType<typeof openMobileReadonlyPage>> | null = null;
  try {
    service = await startFixtureMobileService({ clockIso: SERVICE_CLOCK_ISO });
    const app = launched.app;
    const page = await firstWorkbenchWindow(app);
    await waitWorkbenchReady(page);
    // 真实主进程 CA 注入必须先于首次上传（周期调度自然执行，不在任何周期前发生）。
    await trustFixtureCaInMainProcess(app);

    // —— 打开发布面板：默认关闭/未配置状态断言 ——
    await openPublishPanel(page);
    const panel = page.getByRole('dialog', { name: '发布云端' });
    await expect(panel.getByText('未配置', { exact: true })).toBeVisible();
    expect(await publishPanelField(page, '配置情况')).toBe('未配置');
    expect(await publishPanelField(page, '发布开关')).toBe('已停用');
    expect(await publishPanelField(page, '发布目标')).toBe('尚未配置');
    expect(await publishPanelField(page, '最近成功发布')).toBe('尚无记录');
    expect(await publishPanelField(page, '最近失败')).toBe('尚无记录');
    await expect(panel.getByRole('button', { name: '启用发布' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '配置发布' })).toBeEnabled();
    await expect(panel.getByRole('button', { name: '新建搬迁项目' })).toHaveCount(0);

    // —— 一次性配置（HTTPS origin + 上传 token）→ 配置已保存、仍停用 ——
    await configurePublish(page, service.baseUrl, UPLOAD_TOKEN);
    expect(await publishPanelField(page, '配置情况')).toBe('已配置');
    expect(await publishPanelField(page, '发布开关')).toBe('已停用');
    expect(await publishPanelField(page, '发布目标')).toContain('https://127.0.0.1');
    // —— 显式启用 ——
    await clickEnable(page);

    // 手机页面先打开（服务尚无任何发布）—— 用于验证“未发布 → 已发布空快照”与后续自动更新
    phone = await openMobileReadonlyPage(browser, service.baseUrl, { width: 390, height: 844 });
    await expect(phone.page.getByRole('heading', { name: '尚未发布数据' })).toBeVisible();
    await closePublishPanel(page);

    // —— 空库首次发布（周期 120s 自然触发）：桌面状态最近成功 ——
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(service.baseUrl, 1, 60_000);
    await assertSuccessStatus(page);
    await expect(phone.page.getByRole('heading', { name: '尚未发布数据' })).toBeVisible();

    // 手机周期检查（≤60s 自动触发）→ 空快照已发布（与“尚未发布”区分）
    await phoneAdvanceAndExpect(phone, MOBILE_CHECK_INTERVAL_MS, '已发布 · V1');
    await expect(phone.page.getByRole('heading', { name: '已发布，暂无项目' })).toBeVisible();

    // —— 真实桌面 UI 建档（主操作流不受发布影响） ——
    const originalName = 'E2E 手机可见验收客户-原名';
    const renamedName = 'E2E 手机可见验收客户-已改名';
    await createFormalProject(page, { customer: originalName, ecc: 'E2E-MOBILE-0001' });
    await expectProjectDetail(page, originalName);

    // 自动上传（含新项目）
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(service.baseUrl, 2, 60_000);
    // 手机自动出现新项目卡片（不手动刷新/不按检查按钮）
    await phoneAdvanceAndExpect(phone, MOBILE_CHECK_INTERVAL_MS, originalName, false, true);

    // —— 真实 UI 改名：原名 → 新名（客户名称变化） ——
    await renameProjectCustomer(page, originalName, renamedName);
    await expectProjectDetail(page, renamedName);

    // —— 5 分钟可见预算：按真实墙钟分段测量（改名后 → 手机 DOM 出现新值） ——
    const budgetReport: Record<string, number | string> = {
      desktopPeriodicConfigMs: DESKTOP_PERIODIC_MS,
      phoneIntervalConfigMs: MOBILE_CHECK_INTERVAL_MS,
      remainingBudgetMs: REMAINING_BUDGET_MS,
      totalVisibleBudgetMs: TOTAL_VISIBLE_BUDGET_MS,
      scale: '1 项目 / 0 关联记录（桌面真实 UI 合成规模）',
    };
    const t0 = Date.now();
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(service.baseUrl, 3, 60_000);
    const desktopLocalCheckWallMs = Date.now() - t0; // 桌面周期自然触发 + 真实上传落盘
    const t1 = Date.now();
    await phoneAdvanceAndExpect(phone, MOBILE_CHECK_INTERVAL_MS, renamedName, false, true);
    const phoneCheckWallMs = Date.now() - t1; // 手机周期自然触发 + 取数/渲染
    const endToEndWallMs = Date.now() - t0;
    budgetReport.desktopLocalCheckWallMs = desktopLocalCheckWallMs;
    budgetReport.phoneCheckWallMs = phoneCheckWallMs;
    budgetReport.endToEndWallMs = endToEndWallMs;
    // 旧名不再出现在手机列表（已丢弃旧结果）
    await expect(phone.page.getByLabel('项目列表').locator('.mr-project-name').filter({ hasText: originalName })).toHaveCount(0);
    // 本地状态最新成功且无失败
    await assertSuccessStatus(page);

    // 预算断言：配置口径与文档一致（本地 ≤120s、手机 ≤60s、总可见 ≤5 分钟）
    expect(DESKTOP_PERIODIC_MS).toBe(120_000);
    expect(MOBILE_CHECK_INTERVAL_MS).toBe(60_000);
    expect(TOTAL_VISIBLE_BUDGET_MS).toBe(5 * 60_000);
    expect(desktopLocalCheckWallMs).toBeLessThanOrEqual(DESKTOP_PERIODIC_MS);
    expect(phoneCheckWallMs).toBeLessThanOrEqual(MOBILE_CHECK_INTERVAL_MS);
    expect(endToEndWallMs).toBeLessThanOrEqual(TOTAL_VISIBLE_BUDGET_MS);
    expect(endToEndWallMs).toBeLessThanOrEqual(REMAINING_BUDGET_MS);
    console.log('[mobile-readonly] 预算报告（tasks 8.1/8.3）', JSON.stringify(budgetReport));
  } finally {
    if (phone) {
      try {
        await phone.context.close();
      } catch {
        // 清理失败不影响断言
      }
    }
    if (service) await closeFixtureService(service);
    await closeDesktopApp(launched);
  }
});

async function clickEnable(page: Parameters<typeof openPublishPanel>[0]): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '发布云端' });
  await expect(dialog.getByRole('button', { name: '启用发布' })).toBeEnabled();
  await dialog.getByRole('button', { name: '启用发布' }).click();
  await expect(dialog.getByText(/已启用发布，后续结果会显示在这里/)).toBeVisible();
}

// ---------------------------------------------------------------------------
// P2：tasks 8.1（失败不阻断本地 + 自动恢复成功）与真实 UI 删除记录后的快照全量替换
// ---------------------------------------------------------------------------

test('P2 发布失败不阻断本地、恢复服务后自动成功；真实 UI 删除记录后新快照不含该记录', async () => {
  test.setTimeout(600_000);
  const launched = await launchMobileReadonlyElectron();
  let service: FixtureMobileService | null = null;
  let restarted: FixtureMobileService | null = null;
  const originalName = 'E2E 失败恢复客户-原名';
  const renamedName = 'E2E 失败恢复客户-已改名';
  const keepCompany = 'E2E-P2-承运-保留';
  const deleteCompany = 'E2E-P2-承运-待删除';
  try {
    service = await startFixtureMobileService({ clockIso: SERVICE_CLOCK_ISO });
    const dataDir = service.dataDir;
    const app = launched.app;
    const page = await firstWorkbenchWindow(app);
    await waitWorkbenchReady(page);
    await trustFixtureCaInMainProcess(app);

    await openPublishPanel(page);
    await configurePublish(page, service.baseUrl, UPLOAD_TOKEN);
    await clickEnable(page);
    await closePublishPanel(page);

    // 建档 + 两条物流费用记录（真实 UI）
    await createFormalProject(page, { customer: originalName, ecc: 'E2E-P2-0001' });
    await expectProjectDetail(page, originalName);
    await createBatchQuickRecord(page, { company: deleteCompany });
    await createBatchQuickRecord(page, { company: keepCompany });

    // 首次发布：项目 + 两条批次（服务在线）
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(service.baseUrl, 1, 60_000);
    const projectIdBefore = (await queryProjectsHttp(service.baseUrl, { q: originalName }))[0]!.id;
    const batchesV1 = await queryRecordsHttp(service.baseUrl, projectIdBefore, 'batches');
    expect(batchesV1.some((row) => row.transportCompany === deleteCompany)).toBeTruthy();
    await assertSuccessStatus(page);

    // 关闭服务前先固定本服务的 origin/端口：重启必须复用同一端口（桌面 target 已保存该 origin，
    // 测试不得重建/重配桌面）。
    const originalOrigin = service.baseUrl;
    const originalPort = Number(new URL(service.baseUrl).port);
    expect(Number.isFinite(originalPort) && originalPort > 0).toBeTruthy();

    // 关闭服务：桌面本地改名 → 失败周期（规范化失败码，不阻断本地）
    await service.running.close();
    await renameProjectCustomer(page, originalName, renamedName);
    await expectProjectDetail(page, renamedName);
    // 服务不可达期间再补一条本地记录（桌面主操作流不受影响）
    await createBatchQuickRecord(page, { company: 'E2E-P2-承运-断网期间新增' });
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    const failedField = await readFieldUntil(page, '最近失败', (value) => value.includes('META_READ_FAILED'));
    expect(failedField).toContain('META_READ_FAILED');
    // 最近成功时间保留（不为空），发布开关仍启用
    await readFieldUntil(page, '发布开关', (value) => value === '已启用');
    await readFieldUntil(page, '最近成功发布', (value) => value !== '尚无记录');

    // 重新打开服务（同一 dataDir + 原端口：信封从 current.json 恢复，baseUrl 不变）。
    restarted = await startFixtureMobileService({ dataDir, clockIso: SERVICE_CLOCK_ISO, port: originalPort });
    expect(restarted.baseUrl).toBe(originalOrigin);
    // 桌面未重建/未重配：面板「发布目标」（非 secret）仍是同一 origin，等待自然 120s 周期触发。
    expect(await openPanelAndRead(page, '发布目标')).toBe(originalOrigin);
    await waitForServerVersion(restarted.baseUrl, 1, 30_000); // 恢复后的当前版本仍为 1
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(restarted.baseUrl, 2, 60_000);
    const projectsAfterRecovery = await queryProjectsHttp(restarted.baseUrl, { q: renamedName });
    expect(projectsAfterRecovery.length).toBeGreaterThanOrEqual(1);
    const projectId = projectsAfterRecovery[0]!.id;
    const batchesV2 = await queryRecordsHttp(restarted.baseUrl, projectId, 'batches');
    expect(batchesV2.some((row) => row.transportCompany === keepCompany)).toBeTruthy();
    await assertSuccessStatus(page);

    // 真实 UI 删除一条批次记录（window.confirm 接受）→ 下一周期全量替换快照
    await deleteBatchRecordByCompany(page, deleteCompany);
    await advanceDesktopClock(app, DESKTOP_PERIODIC_MS);
    await waitForServerVersion(restarted.baseUrl, 3, 60_000);
    const batchesV3 = await queryRecordsHttp(restarted.baseUrl, projectId, 'batches');
    expect(batchesV3.some((row) => row.transportCompany === keepCompany)).toBeTruthy();
    expect(batchesV3.some((row) => row.transportCompany === deleteCompany)).toBeFalsy();
    await assertSuccessStatus(page);
  } finally {
    if (service) await closeFixtureService(service);
    if (restarted) await closeFixtureService(restarted);
    await closeDesktopApp(launched);
  }
});

// ---------------------------------------------------------------------------
// P3：tasks 8.2 —— 云端收件协议 e2e（真实 HTTP + current.json 原子信封）
//      版本递增、幂等（同 publicationId 不改版本/publishedAt/文件）、过期期望拒绝、
//      服务重启后同候选重试幂等（版本 8 场景）、删除记录后新快照不含该记录（全量替换）。
//      本用例以真实 HTTP 协议级执行，不替代 P1/P2 的桌面路径证据。
// ---------------------------------------------------------------------------

test('P3 云端收件协议 e2e：原子信封/幂等/过期拒绝/重启幂等版本8/删除记录全量替换', async () => {
  test.setTimeout(120_000);
  const started = await startFixtureMobileService({ clockIso: SERVICE_CLOCK_ISO });
  const dataDir = started.dataDir;
  let active: FixtureMobileService = started;
  const snapshot = cloneSnapshot(
    syntheticBuilder.buildSyntheticSnapshot({ projectCount: 1, firstProjectRecords: 1 }),
  );
  const snapshotAfterDelete = cloneSnapshot(snapshot);
  {
    const records = snapshotAfterDelete.projects[0]!.records as unknown as { batches: unknown[] };
    records.batches.splice(0, 1); // 模拟删除该条批次记录后的全量替换内容
  }

  try {
    const baseUrl = started.baseUrl;
    // 首次提交 v1（含一条批次记录）
    const committed1 = await uploadSnapshotHttp(baseUrl, {
      publicationId: `${SERVICE_PUBLICATION_BASE}-v1`,
      expectedCurrentVersion: 0,
      snapshot,
    });
    expect(committed1.status).toBe(200);
    expect(JSON.parse(committed1.body).result).toBe('committed');
    const envelope1 = readEnvelopeFile(dataDir);
    expect(envelope1.currentVersion).toBe(1);
    expect(envelope1.publicationId).toBe(`${SERVICE_PUBLICATION_BASE}-v1`);
    expect(envelope1.publishedAt.length).toBeGreaterThan(0);
    const bytesAfterV1 = readEnvelopeFileBytes(dataDir);
    expect(bytesAfterV1.length).toBeGreaterThan(0);

    // 重复当前 publicationId → 幂等成功，版本/文件/时间不变
    const dup1 = await uploadSnapshotHttp(baseUrl, {
      publicationId: `${SERVICE_PUBLICATION_BASE}-v1`,
      expectedCurrentVersion: 1,
      snapshot,
    });
    expect(dup1.status).toBe(200);
    expect(JSON.parse(dup1.body).result).toBe('idempotent');
    const metaAfterDup1 = await readMetaHttp(baseUrl);
    expect(metaAfterDup1?.currentVersion).toBe(1);
    expect(metaAfterDup1?.publicationId).toBe(`${SERVICE_PUBLICATION_BASE}-v1`);
    expect(readEnvelopeFileBytes(dataDir).equals(bytesAfterV1)).toBeTruthy();

    // 过期期望版本（新 ID + 错误 expected）→ 409 conflict，文件保持
    const stale1 = await uploadSnapshotHttp(baseUrl, {
      publicationId: `${SERVICE_PUBLICATION_BASE}-stale`,
      expectedCurrentVersion: 0,
      snapshot,
    });
    expect(stale1.status).toBe(409);
    expect(JSON.parse(stale1.body).result).toBe('conflict');
    expect(readEnvelopeFileBytes(dataDir).equals(bytesAfterV1)).toBeTruthy();

    // v2 = 删除批次记录后的快照（全量替换语义：新快照不含该记录）
    const committed2 = await uploadSnapshotHttp(baseUrl, {
      publicationId: `${SERVICE_PUBLICATION_BASE}-v2`,
      expectedCurrentVersion: 1,
      snapshot: snapshotAfterDelete,
    });
    expect(committed2.status).toBe(200);
    expect(JSON.parse(committed2.body).result).toBe('committed');
    const metaAfterV2 = await readMetaHttp(baseUrl);
    expect(metaAfterV2?.currentVersion).toBe(2);
    expect(metaAfterV2?.publicationId).toBe(`${SERVICE_PUBLICATION_BASE}-v2`);
    const batchesAfterV2 = (readEnvelopeFile(dataDir).snapshot.projects[0]!.records as unknown as { batches: unknown[] }).batches;
    expect(batchesAfterV2).toHaveLength(0);

    // 连续推进至版本 8，记录第 8 版候选
    let version = 3;
    let lastPubId = '';
    while (version <= 8) {
      const id = `${SERVICE_PUBLICATION_BASE}-seq-${version}`;
      const res = await uploadSnapshotHttp(baseUrl, {
        publicationId: id,
        expectedCurrentVersion: version - 1,
        snapshot,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).result).toBe('committed');
      lastPubId = id;
      version += 1;
    }
    const metaBeforeRestart = await readMetaHttp(baseUrl);
    expect(metaBeforeRestart?.currentVersion).toBe(8);
    expect(metaBeforeRestart?.publicationId).toBe(lastPubId);
    const bytesBeforeRestart = readEnvelopeFileBytes(dataDir);
    const publishedAtBeforeRestart = metaBeforeRestart?.publishedAt ?? '';

    // 服务重启：同一数据目录从 current.json 恢复（先只关闭监听，保留信封目录）
    await started.running.close();
    const restarted = await startFixtureMobileService({ dataDir, clockIso: SERVICE_CLOCK_ISO });
    active = restarted;
    const metaAfterRestart = await readMetaHttp(restarted.baseUrl);
    expect(metaAfterRestart?.currentVersion).toBe(8);
    expect(metaAfterRestart?.publicationId).toBe(lastPubId);
    expect(metaAfterRestart?.publishedAt).toBe(publishedAtBeforeRestart);
    // 同候选原样重试 → 幂等成功：版本保持 8、publishedAt 不变、文件字节不变
    const idempotentRetry = await uploadSnapshotHttp(restarted.baseUrl, {
      publicationId: lastPubId,
      expectedCurrentVersion: 8,
      snapshot,
    });
    expect(idempotentRetry.status).toBe(200);
    expect(JSON.parse(idempotentRetry.body).result).toBe('idempotent');
    const metaAfterIdempotent = await readMetaHttp(restarted.baseUrl);
    expect(metaAfterIdempotent?.currentVersion).toBe(8);
    expect(metaAfterIdempotent?.publicationId).toBe(lastPubId);
    expect(metaAfterIdempotent?.publishedAt).toBe(publishedAtBeforeRestart);
    expect(readEnvelopeFileBytes(dataDir).equals(bytesBeforeRestart)).toBeTruthy();
  } finally {
    await closeFixtureService(active);
  }
});
