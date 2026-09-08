import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * 移动只读 E2E 独立配置（tasks 6.5 / 8.1-8.3；workers=1，单 worker 顺序执行）。
 *
 * - 仅收集 e2e/mobile-readonly-view.spec.ts 与 e2e/mobile-readonly-publish.spec.ts；
 *   运行：npm run test:e2e:mobile-readonly（等价
 *   `npx playwright test --config playwright.mobile-readonly.config.ts --workers=1`）。
 * - 前置构建：`npm run build:mobile-readonly`（手机静态 web）+ `npm run e2e:build`
 *   （真实打包 Electron，out/…）；产物缺失时用例明确失败而非跳过。
 * - 证书策略（只放行本夹具测试证书，非全局弱化）：把 tests/server/fixtures/tls/cert.pem
 *   的公钥 SPKI（sha256 base64）写入 Chromium `--ignore-certificate-errors-spki-list`；
 *   不使用 ignoreHTTPSErrors / NODE_TLS_REJECT_UNAUTHORIZED / rejectUnauthorized:false。
 */
const TLS_CERT_FILE = join(process.cwd(), 'tests', 'server', 'fixtures', 'tls', 'cert.pem');
function fixtureCertSpki(): string {
  const cert = new X509Certificate(readFileSync(TLS_CERT_FILE, 'utf8'));
  const der = cert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return createHash('sha256').update(der).digest('base64');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/mobile-readonly-view.spec.ts', '**/mobile-readonly-publish.spec.ts'],
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    // 精确放行本仓库移动只读服务测试证书（127.0.0.1/localhost），其它证书照常校验。
    launchOptions: {
      args: [`--ignore-certificate-errors-spki-list=${fixtureCertSpki()}`],
    },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
