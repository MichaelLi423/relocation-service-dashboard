import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置（tasks 10.4）。
 *
 * 交付目标平台为 Windows 桌面（Electron），但本组 E2E 在 macOS 开发机运行
 * 真实打包产物并以临时 userData 启动（见 e2e/electron-smoke.spec.ts），
 * 验证 macOS 开发机上的可运行性，不冒充 Windows 验证。
 * 运行前置：先执行 `npm run e2e:build`（electron-forge package 产出
 * out/搬迁服务工作台-darwin-arm64/搬迁服务工作台.app）。
 */
export default defineConfig({
  testDir: './e2e',
  // 移动只读两条验收 spec 由独立配置 playwright.mobile-readonly.config.ts 运行
  // （npm run test:e2e:mobile-readonly），避免在旧 electron-smoke 项目中重复执行。
  testIgnore: ['**/mobile-readonly-view.spec.ts', '**/mobile-readonly-publish.spec.ts'],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  workers: 1,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron-smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
