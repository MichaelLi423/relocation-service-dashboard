/**
 * 宣传物料自动化截图脚本（全新虚构演示数据 · 真实应用截图）
 *
 * 规范与约束：
 * 1. 全新虚构演示数据（项目名称明确标注「演示示例」，物流公司使用「演示物流A/B」等通用标识，不借用真实品牌）；
 * 2. 真实构建产物运行（真实打包 Electron 桌面应用 + 真实构建移动只读端）；
 * 3. 产出 4 张清晰无遮罩截图至 docs/promotion/2026-09-23-refresh/screenshots/：
 *    - 01-workbench-overview.png: 工作台总览（今日看板、提醒泳道、项目队列）
 *    - 02-project-detail.png: 项目业务详情（华东精准医疗演示项目：物流批次、金额摘要、仪器与开单）
 *    - 03-records-ledger.png: 记录检索/业务台账（跨项目综合台账检索与明细列表）
 *    - 04-mobile-readonly.png: 手机只读 Web 端（390x844 现场查阅视图）
 */

const { _electron: electron, chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'docs', 'promotion', '2026-09-23-refresh', 'screenshots');
const APP_EXECUTABLE = path.join(
  ROOT,
  'out',
  `搬迁服务工作台-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  '搬迁服务工作台.app',
  'Contents',
  'MacOS',
  '搬迁服务工作台'
);

const SERVER_BUNDLE = path.join(ROOT, 'dist', 'mobile-readonly', 'server.cjs');
const WEB_ROOT = path.join(ROOT, 'dist', 'mobile-readonly', 'web');
const synthetic = require(path.join(ROOT, 'scripts', 'mobile-readonly-synthetic.cjs'));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function seedDesktopSyntheticData(page) {
  return page.evaluate(async () => {
    const api = window.workbench;
    if (!api) throw new Error('window.workbench 未就绪');

    // 1. 主展示项目：华东精准医疗实验中心（演示示例）—— 执行中，关联业务完整
    const p1 = await api.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '华东精准医疗实验中心（演示示例）',
        ecc: 'ECC-2026-DEMO01',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '上海市浦东新区张江示范园区科研路100号',
        newSiteAddress: '上海市临港新片区生物创新园海基六路88号',
        instrumentCount: 5,
        contractAmount: '128000.00',
        siteConfirmed: true,
        plannedTransportAt: '2026-08-15',
        plannedInstallAt: '2026-08-20',
      },
    });
    const id1 = p1.changed.projectId;

    // 关联记录：3 批次物流运输（通用标识：演示物流A/B/C）
    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'batch',
        projectId: id1,
        values: {
          planTransportDate: '2026-08-10',
          transportCompany: '演示物流A（温控专运）',
          budgetPrice: '15000',
          dealPrice: '13800',
          appliedAt: '2026-08-09',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'batch',
        projectId: id1,
        values: {
          planTransportDate: '2026-08-15',
          transportCompany: '演示物流B（气垫专车）',
          budgetPrice: '22000',
          dealPrice: '20500',
          appliedAt: '2026-08-14',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'batch',
        projectId: id1,
        values: {
          planTransportDate: '2026-08-20',
          transportCompany: '演示物流C（冷链货运）',
          budgetPrice: '12000',
          dealPrice: '11200',
          appliedAt: '2026-08-18',
        },
      },
    });

    // 关联记录：多台精密仪器
    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'instrument',
        projectId: id1,
        values: {
          name: '高分辨液相色谱质谱联用仪 (LC-MS)',
          model: 'Demo-Orbitrap-240',
          serialNo: 'SN-DEMO-MS01',
          ups: true,
          qrRequested: true,
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'instrument',
        projectId: id1,
        values: {
          name: '高通量基因测序仪系统',
          model: 'Demo-Seq-6000',
          serialNo: 'SN-DEMO-SQ02',
          ups: true,
          qrRequested: true,
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'instrument',
        projectId: id1,
        values: {
          name: '自动化生化细胞分析仪',
          model: 'Demo-Cell-LX',
          serialNo: 'SN-DEMO-CL03',
          ups: false,
          qrRequested: true,
        },
      },
    });

    // 关联记录：到访活动
    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'visit',
        projectId: id1,
        values: {
          visitAt: '2026-08-08',
          engineers: '张工程师、李工程师',
        },
      },
    });

    // 关联记录：开单记录
    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'order',
        projectId: id1,
        values: {
          orderType: 'relocation',
          serviceOrderNo: 'SO-DEMO-2026-01',
          orderedAt: '2026-08-10',
          engineer: '张工程师',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'order',
        projectId: id1,
        values: {
          orderType: 'relocation',
          serviceOrderNo: 'SO-DEMO-2026-02',
          orderedAt: '2026-08-15',
          engineer: '李工程师',
        },
      },
    });

    // 关联记录：掉票首期款
    await api.v2Mutate({
      op: 'submit_action',
      projectId: id1,
      action: {
        type: 'invoice',
        projectId: id1,
        values: {
          invoicedAt: '2026-08-12',
          amount: '64000.00',
        },
      },
    });

    // 提醒维护
    await api.v2Mutate({
      op: 'set_reminder',
      projectId: id1,
      reminderAt: '2026-08-15',
      reminderNote: '精密质谱仪气垫专车启运与温湿度监控确认',
    });

    // 推进主状态为执行中
    await api.v2Mutate({
      op: 'adjust_status',
      projectId: id1,
      status: 'executing',
    });

    // 2. 张江创新研发平台（演示示例）—— 待验收
    const p2 = await api.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '张江创新研发平台（演示示例）',
        ecc: 'ECC-2026-DEMO02',
        region: 'East',
        contractStartDate: '2026-08-01',
        contractEndDate: '2027-07-31',
        oldSiteAddress: '上海市浦东新区张江微电子港1号楼',
        newSiteAddress: '上海市张江科学城产业园3号基地',
        instrumentCount: 3,
        contractAmount: '96000.00',
        siteConfirmed: true,
        actualInstallDoneAt: '2026-08-12',
      },
    });
    const id2 = p2.changed.projectId;

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id2,
      action: {
        type: 'batch',
        projectId: id2,
        values: {
          planTransportDate: '2026-08-08',
          transportCompany: '演示物流A（温控专运）',
          budgetPrice: '18000',
          dealPrice: '16500',
          appliedAt: '2026-08-07',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id2,
      action: {
        type: 'invoice',
        projectId: id2,
        values: {
          invoicedAt: '2026-08-11',
          amount: '48000.00',
        },
      },
    });

    await api.v2Mutate({
      op: 'set_reminder',
      projectId: id2,
      reminderAt: '2026-08-18',
      reminderNote: '新址纯水供水及三相动力电验收复核',
    });

    // 3. 中关村生命智造中心（演示示例）—— 待执行
    const p3 = await api.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '中关村生命智造中心（演示示例）',
        ecc: 'ECC-2026-DEMO03',
        region: 'North',
        contractStartDate: '2026-08-05',
        contractEndDate: '2027-08-04',
        oldSiteAddress: '北京市海淀区中关村南大街1号',
        newSiteAddress: '北京市昌平区生命科学园路20号',
        instrumentCount: 6,
        contractAmount: '150000.00',
        siteConfirmed: false,
      },
    });
    const id3 = p3.changed.projectId;

    await api.v2Mutate({
      op: 'set_reminder',
      projectId: id3,
      reminderAt: '2026-08-20',
      reminderNote: '待拆装精密仪器出厂校准证书与出库审批汇总',
    });

    // 4. 西部基因测序技术中心（演示示例）—— 待掉票
    const p4 = await api.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'formal',
        customerName: '西部基因测序技术中心（演示示例）',
        ecc: 'ECC-2026-DEMO04',
        region: 'West',
        contractStartDate: '2026-07-15',
        contractEndDate: '2027-07-14',
        oldSiteAddress: '成都市高新区天府生命科技园A区',
        newSiteAddress: '成都市天府国际生物城健康小镇',
        instrumentCount: 4,
        contractAmount: '112000.00',
        siteConfirmed: true,
        actualInstallDoneAt: '2026-08-06',
      },
    });
    const id4 = p4.changed.projectId;

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id4,
      action: {
        type: 'batch',
        projectId: id4,
        values: {
          planTransportDate: '2026-08-05',
          transportCompany: '演示物流B（气垫专车）',
          budgetPrice: '20000',
          dealPrice: '19000',
          appliedAt: '2026-08-04',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id4,
      action: {
        type: 'order',
        projectId: id4,
        values: {
          orderType: 'relocation',
          serviceOrderNo: 'SO-DEMO-2026-03',
          orderedAt: '2026-08-05',
          engineer: '王工程师',
        },
      },
    });

    await api.v2Mutate({
      op: 'submit_action',
      projectId: id4,
      action: {
        type: 'acceptance',
        projectId: id4,
        values: {
          reportDate: '2026-08-10',
        },
      },
    });

    // 5. 大湾区联合检验中心（演示示例）—— 待进单草稿意向
    await api.v2Mutate({
      op: 'create_project',
      payload: {
        intent: 'draft',
        customerName: '大湾区联合检验中心（演示示例）',
        region: 'South',
        oldSiteAddress: '深圳市南山区科技园高新南一道',
        newSiteAddress: '广州市黄埔区知识城产业园区',
        instrumentCount: 2,
        siteConfirmed: true,
      },
    });

    return { success: true };
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function httpRequestJson(method, url, token, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, bodyText: text });
        });
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function captureMobileScreenshot(outputPath) {
  console.log('[4/4] 启动移动只读服务并截取手机端视图…');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-promo-'));
  const port = await findFreePort();
  const credentialsFile = path.join(tempDir, 'credentials.json');
  synthetic.writeCredentialsFileSync(credentialsFile, {
    viewerUsername: synthetic.SYNTHETIC.viewerUsername,
    viewerPassword: synthetic.SYNTHETIC.viewerPassword,
    uploadToken: synthetic.SYNTHETIC.uploadToken,
  });

  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOBILE_READONLY_HOST: '127.0.0.1',
      MOBILE_READONLY_PORT: String(port),
      MOBILE_READONLY_DATA_DIR: tempDir,
      MOBILE_READONLY_CREDENTIALS_FILE: credentialsFile,
      MOBILE_READONLY_WEB_ROOT: WEB_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('移动端服务就绪超时')), 8000);
    const onData = (data) => {
      if (String(data).includes('已监听')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`服务提前退出 code=${code}`)));
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const uploadBody = synthetic.buildSyntheticUploadBody({ projectCount: 45, firstProjectRecords: 25 });
  const publish = await httpRequestJson('PUT', `${baseUrl}/api/publish`, synthetic.SYNTHETIC.uploadToken, uploadBody);
  if (publish.status !== 200) {
    throw new Error(`移动只读初始发布失败：${publish.status} ${publish.bodyText}`);
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 1100 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      httpCredentials: {
        username: synthetic.SYNTHETIC.viewerUsername,
        password: synthetic.SYNTHETIC.viewerPassword,
      },
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.getByText('合成客户').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    await page.screenshot({ path: outputPath });
    console.log(`[✔] 手机只读端截图已保存: ${outputPath}`);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const only = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1]?.split(',') ?? null;
  ensureDir(OUTPUT_DIR);
  console.log('=== 搬迁服务工作台宣传截图自动化生成 ===');
  console.log('目标输出目录:', OUTPUT_DIR);

  if (!fs.existsSync(APP_EXECUTABLE)) {
    throw new Error(`未找到真实打包 Electron，请先运行 npm run e2e:build: ${APP_EXECUTABLE}`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-promo-data-'));
  console.log('临时数据目录:', userDataDir);

  let app;
  try {
    console.log('[1/4] 启动 Electron 应用并初始化高清视口 (1440x900)…');
    app = await electron.launch({
      executablePath: APP_EXECUTABLE,
      env: { ...process.env, WORKBENCH_E2E_USER_DATA_DIR: userDataDir },
    });

    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('heading', { name: '把每一次搬迁，推进得更稳' }).waitFor();

    console.log('注入全新虚构演示数据…');
    await seedDesktopSyntheticData(page);

    console.log('重新加载页面以拉取全量持久化业务数据…');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('heading', { name: '把每一次搬迁，推进得更稳' }).waitFor();

    console.log('断言验证：检查项目队列中是否已渲染演示项目…');
    const mainProjectText = page.getByText('华东精准医疗实验中心（演示示例）').first();
    await mainProjectText.waitFor({ state: 'visible', timeout: 10000 });

    const rows = page.locator('.project-table tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: 10000 });
    const count = await rows.count();
    console.log(`项目队列确认已渲染 ${count} 行项目数据。`);
    if (count < 5) throw new Error(`项目行数不足，预期至少 5 行，实际 ${count} 行`);

    // 等待动画与看板数值刷新
    await page.waitForTimeout(600);

    // 1. 工作台总览截图
    if (!only || only.includes('01')) {
    console.log('[1/4] 正在截取：01-workbench-overview.png (工作台总览)…');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    const overviewPath = path.join(OUTPUT_DIR, '01-workbench-overview.png');
    await page.screenshot({ path: overviewPath });
    console.log(`[✔] 工作台总览截图已保存: ${overviewPath}`);
    }

    // 2. 项目业务详情截图
    console.log('[2/4] 正在截取：02-project-detail.png (项目业务详情)…');
    // 明确按客户名选中华东精准医疗演示项目，避免因排序默认命中其他行
    const demoRow = page.locator('.project-table tbody tr').filter({ hasText: '华东精准医疗实验中心（演示示例）' });
    await demoRow.waitFor({ state: 'visible', timeout: 5000 });
    await demoRow.click();
    await page.waitForTimeout(600);

    // 切换到“物流费用登记”Tab
    const batchTab = page.locator('.project-workspace').getByRole('tab', { name: '物流费用登记' });
    await batchTab.waitFor({ state: 'visible', timeout: 5000 });
    await batchTab.click();
    await page.waitForTimeout(600);

    // 严格断言：工作区标题为华东精准医疗，且物流表格包含全部 3 条批次
    await expect(page.locator('.project-workspace').getByText('华东精准医疗实验中心（演示示例）').first()).toBeVisible();
    await expect(page.locator('.project-workspace').getByText('演示物流A（温控专运）')).toBeVisible();
    await expect(page.locator('.project-workspace').getByText('演示物流B（气垫专车）')).toBeVisible();
    await expect(page.locator('.project-workspace').getByText('演示物流C（冷链货运）')).toBeVisible();
    const batchRows = page.locator('.project-workspace .data-table tbody tr');
    const batchCount = await batchRows.count();
    console.log(`华东演示项目确认已渲染 ${batchCount} 笔物流批次记录。`);
    if (batchCount !== 3) throw new Error(`物流记录数不符，预期 3 条，实际 ${batchCount} 条`);

    // 滚动至项目工作区使得完整上下文与关联明细居中清晰呈现
    await page.locator('.project-workspace').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const detailPath = path.join(OUTPUT_DIR, '02-project-detail.png');
    await page.screenshot({ path: detailPath });
    console.log(`[✔] 项目业务详情截图已保存: ${detailPath}`);

    // 3. 记录检索/业务台账截图
    if (!only || only.includes('03')) {
    console.log('[3/4] 正在截取：03-records-ledger.png (记录检索/业务台账)…');
    // 点击主导航“浏览全部记录”
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '浏览全部记录' }).click();
    await page.waitForTimeout(800);

    // 确保弹层显示，并且显示跨项目记录
    const historyModal = page.locator('.history-browser');
    await historyModal.waitFor({ state: 'visible', timeout: 5000 });
    // 切换到“物流费用”Tab
    const logTab = historyModal.getByRole('tab', { name: '物流费用' });
    await logTab.waitFor({ state: 'visible', timeout: 5000 });
    await logTab.click();
    await page.waitForTimeout(600);

    // 严格断言台账数据表格中有记录行
    const historyRows = historyModal.locator('.data-table tbody tr');
    await historyRows.first().waitFor({ state: 'visible', timeout: 10000 });
    console.log(`台账表格确认已渲染 ${await historyRows.count()} 行历史业务记录。`);

    const ledgerPath = path.join(OUTPUT_DIR, '03-records-ledger.png');
    await page.screenshot({ path: ledgerPath });
    console.log(`[✔] 记录检索/业务台账截图已保存: ${ledgerPath}`);
    }

  } finally {
    if (app) await app.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  // 4. 手机端只读页面截图
  if (!only || only.includes('04')) {
    const mobilePath = path.join(OUTPUT_DIR, '04-mobile-readonly.png');
    await captureMobileScreenshot(mobilePath);
  }

  console.log('=== 所有宣传截图生成完毕！===');
}

main().catch((err) => {
  console.error('截图生成失败:', err);
  process.exit(1);
});

