#!/usr/bin/env node
'use strict';

/**
 * 移动只读本地开发入口（openspec change `add-mobile-readonly-publication`）。
 *
 * - 只使用合成数据（scripts/mobile-readonly-synthetic.cjs）：无真实业务库/客户文件；
 * - 先确保编译产物（缺失时自动执行 build），再以本地 loopback HTTP 启动编译后的
 *   `dist/mobile-readonly/server.cjs`，数据目录为 OS 临时目录；
 * - 写入本地演示凭证摘要（scrypt 同 server 格式），随后用合成快照经 /api/publish
 *   完成一次初始发布（本地演示明文凭证仅在控制台输出，非生产 secret）；
 * - 停止时清理自身子进程与临时目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD_SCRIPT = path.join(__dirname, 'build-mobile-readonly.cjs');
const SERVER_BUNDLE = path.join(ROOT, 'dist', 'mobile-readonly', 'server.cjs');
const WEB_ROOT = path.join(ROOT, 'dist', 'mobile-readonly', 'web');
const synthetic = require('./mobile-readonly-synthetic.cjs');

const HOST = '127.0.0.1';

function fail(message) {
  process.stderr.write(`\ndev:mobile-readonly 失败：${message}\n`);
  process.exitCode = 1;
}

/** 编译产物缺失时自动构建；仍失败则报错退出。 */
function ensureBuilt() {
  const required = [SERVER_BUNDLE, path.join(WEB_ROOT, 'app.js'), path.join(WEB_ROOT, 'index.html')];
  if (required.every((file) => fs.existsSync(file))) return;
  console.log('[dev:mobile-readonly] 未找到编译产物，先执行 build:mobile-readonly …');
  execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error(`构建后仍缺少 ${path.relative(ROOT, file)}`);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
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
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function startServerChild(env) {
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {
    /* 由 waitForReady 监听 */
  });
  return child;
}

function waitForReady(child, onLine) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('等待服务就绪超时（8s）'));
    }, 8000);
    let buffer = '';
    const handleData = (data) => {
      buffer += String(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        onLine(line);
        if (line.includes('已监听')) {
          clearTimeout(timer);
          resolve();
        }
      }
    };
    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务进程提前退出（code=${code ?? 'signal'}）`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 捕获子进程退出/生成错误（二者只发生一次）。 */
function trackChildExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-readonly-dev-'));
  const removeTempDir = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  let child = null;
  let childExitPromise = null;
  let shutdownPromise = null;
  let shuttingDown = false;
  const SIGTERM_TIMEOUT_MS = 2500;
  const SIGKILL_GRACE_MS = 1000;

  /**
   * 一次性收敛清理：SIGINT/SIGTERM/子进程自然退出/生成错误/启动失败全部走这里，
   * 幂等且**先等子进程真正退出再删临时目录**（避免 process.exit 抢占、目录残留）。
   * 只 kill 自己 spawn 的直接子进程，绝不触碰其它进程。
   */
  const requestShutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      if (child && childExitPromise && child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // 进程可能已退出：交由 childExitPromise 收敛
        }
        const exited = await Promise.race([
          childExitPromise.then(() => true),
          delay(SIGTERM_TIMEOUT_MS).then(() => false),
        ]);
        if (!exited && child && child.exitCode === null) {
          // 有限超时后才强制终止自己的子进程（绝不波及无关进程）。
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          await Promise.race([childExitPromise.then(() => undefined), delay(SIGKILL_GRACE_MS)]);
        }
      }
      // 子进程退出/关闭完成后再清理其文件（snapshots/credentials 句柄已释放）。
      await delay(50);
      removeTempDir();
      process.stdout.write(`\n[dev:mobile-readonly] 已停止（${reason}），临时数据已清理。\n`);
    })();
    return shutdownPromise;
  };

  // 信号处理在子进程产生前注册：无论 npm 转发 SIGINT/SIGTERM 还是直接 kill，均收敛同一条清理链。
  const onSignal = (signal) => {
    void requestShutdown(signal).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    ensureBuilt();
    const port = process.env.MOBILE_READONLY_DEV_PORT
      ? Number(process.env.MOBILE_READONLY_DEV_PORT)
      : await findFreePort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOBILE_READONLY_DEV_PORT 非法');

    const credentialsFile = path.join(tempDir, 'credentials.json');
    synthetic.writeCredentialsFileSync(credentialsFile, {
      viewerUsername: synthetic.SYNTHETIC.viewerUsername,
      viewerPassword: synthetic.SYNTHETIC.viewerPassword,
      uploadToken: synthetic.SYNTHETIC.uploadToken,
    });

    const baseUrl = `http://${HOST}:${port}`;
    child = startServerChild({
      MOBILE_READONLY_HOST: HOST,
      MOBILE_READONLY_PORT: String(port),
      MOBILE_READONLY_DATA_DIR: tempDir,
      MOBILE_READONLY_CREDENTIALS_FILE: credentialsFile,
      MOBILE_READONLY_WEB_ROOT: WEB_ROOT,
    });
    childExitPromise = trackChildExit(child);
    await waitForReady(child, (line) => {
      // 只转发服务自身的普通日志，不打印任何请求体/业务内容/密钥。
      process.stdout.write(`[mobile-readonly-server] ${line}\n`);
    });
    child.stdout.removeAllListeners('data');
    child.stderr.removeAllListeners('data');
    child.stdout.on('data', (d) => process.stdout.write(`[mobile-readonly-server] ${String(d)}`));
    child.stderr.on('data', (d) => process.stderr.write(`[mobile-readonly-server] ${String(d)}`));
    // 服务意外退出：收敛清理（删临时目录）后以非零退出，而不是只设 exitCode 放任目录残留。
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      process.stderr.write(`[dev:mobile-readonly] 服务进程意外退出（code=${code ?? 'signal:' + String(signal)}）\n`);
      void requestShutdown('child-exit').finally(() => process.exit(1));
    });

    // 初始发布（合成快照：45 项目；首项目每类 25 条记录）。
    const uploadBody = synthetic.buildSyntheticUploadBody({ projectCount: 45, firstProjectRecords: 25 });
    const publish = await httpRequestJson('PUT', `${baseUrl}/api/publish`, synthetic.SYNTHETIC.uploadToken, uploadBody);
    if (publish.status < 200 || publish.status >= 300) {
      throw new Error(`初始发布失败：HTTP ${publish.status} body=${publish.bodyText.slice(0, 500)}`);
    }
    const metadata = (() => {
      try {
        return JSON.parse(publish.bodyText);
      } catch {
        return { body: publish.bodyText.slice(0, 120) };
      }
    })();
    console.log(`[dev:mobile-readonly] 初始发布成功：HTTP ${publish.status}，${JSON.stringify(metadata)}`);
    console.log('');
    console.log('移动只读本地演示已启动（loopback 仅本机）：');
    console.log(`  手机只读工作台： ${baseUrl}/   （请用手机视口或浏览器访问）`);
    console.log('  本地演示凭证（仅本地开发，非生产 secret）：');
    console.log(`    查看 Basic Auth  user: ${synthetic.SYNTHETIC.viewerUsername}  password: ${synthetic.SYNTHETIC.viewerPassword}`);
    console.log(`    上传 Bearer token: ${synthetic.SYNTHETIC.uploadToken}`);
    console.log(`    数据目录（临时，退出即清理）: ${tempDir}`);
    console.log('  按 Ctrl-C 停止。');
  } catch (error) {
    // 生成失败 / 就绪失败 / 初始发布失败：先清理（等子进程退出并删临时目录），再失败退出。
    await requestShutdown('startup-failure');
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
