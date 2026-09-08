#!/usr/bin/env node
'use strict';

/**
 * 移动只读构建脚本（openspec change `add-mobile-readonly-publication`）。
 *
 * - 不使用 webpack-cli（仓库未安装）：程序化调用 `webpack(configs)`，构建后可靠
 *   `close()` 并给出非零退出码；
 * - 配置为 TypeScript（webpack.mobile-readonly.config.ts）：用 typescript.transpileModule
 *   转 CJS 后在 repo-root 上下文执行（module._compile 提供正确 __dirname/require 解析，
 *   不写任何临时/生成配置到仓库根或全局 env，也不做字符串替换 __dirname）；
 * - 构建成功后把 `src/mobile/index.html` 复制到 `dist/mobile-readonly/web/index.html`。
 *
 * 脚本为 repo-root 安全：路径一律由 `__dirname`（scripts/）推导，与调用 cwd 无关。
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'webpack.mobile-readonly.config.ts');
const OUTPUT_DIR = path.join(ROOT, 'dist', 'mobile-readonly');
const HTML_SOURCE = path.join(ROOT, 'src', 'mobile', 'index.html');
const HTML_TARGET = path.join(OUTPUT_DIR, 'web', 'index.html');

function fail(message) {
  process.stderr.write(`\nbuild:mobile-readonly 失败：${message}\n`);
  process.exitCode = 1;
}

/** 把 TS 配置转译为 CJS 并加载（模块上下文文件名为仓库根 webpack 配置路径）。 */
function loadWebpackConfigTs(file) {
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: false,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      skipLibCheck: true,
    },
  }).outputText;

  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(js, file);
  return mod.exports;
}

function resolveConfigs() {
  const loaded = loadWebpackConfigTs(CONFIG_FILE);
  if (Array.isArray(loaded.default)) return loaded.default;
  const named = [loaded.mobileReadonlyServerConfig, loaded.mobileReadonlyWebConfig].filter(Boolean);
  if (named.length === 0) {
    throw new Error(`webpack 配置 ${CONFIG_FILE} 未导出 default 数组或命名配置`);
  }
  return named;
}

function runWebpack(configs) {
  const webpack = require('webpack');
  const compiler = webpack(configs);
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error || closeError);
        resolve(stats.stats.map((entry) => ({ error: null, stats: entry })));
      });
    });
  });
}

function reportStats(stats) {
  if (!stats) return;
  const name = stats.compilation && stats.compilation.name ? stats.compilation.name : 'webpack';
  const summary = {
    name,
    timeMs: stats.endTime && stats.startTime ? stats.endTime - stats.startTime : undefined,
    assets: stats.toJson({ all: false, assets: true }).assets
      ? stats.toJson({ all: false, assets: true }).assets.map((a) => a.name)
      : [],
  };
  console.log(`[build:mobile-readonly] ${summary.name}：${(summary.timeMs ?? 0).toFixed(0)}ms，产物：${summary.assets.join(', ') || '（无）'}`);
}

async function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fail(`缺少 ${path.relative(ROOT, CONFIG_FILE)}`);
    return;
  }
  let configs;
  try {
    configs = resolveConfigs();
  } catch (error) {
    fail(`加载 webpack 配置失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const results = await runWebpack(configs);
    let hasError = false;
    for (const { error, stats } of results) {
      if (error) {
        hasError = true;
        process.stderr.write(`[build:mobile-readonly] 编译异常：${error.message}\n`);
        continue;
      }
      if (stats && stats.hasErrors()) {
        hasError = true;
        process.stderr.write(stats.toString({ preset: 'minimal', colors: false }));
        process.stderr.write('\n');
        continue;
      }
      reportStats(stats);
    }
    if (hasError) {
      fail('webpack 构建存在错误');
      return;
    }

    // 成功构建后复制手机 index.html（服务优先返回 web 目录文件）。
    if (!fs.existsSync(HTML_SOURCE)) {
      fail(`缺少手机入口 ${path.relative(ROOT, HTML_SOURCE)}（手机 lane 尚未提供）`);
      return;
    }
    fs.mkdirSync(path.dirname(HTML_TARGET), { recursive: true });
    fs.copyFileSync(HTML_SOURCE, HTML_TARGET);
    console.log(`[build:mobile-readonly] 已复制 ${path.relative(ROOT, HTML_SOURCE)} -> ${path.relative(ROOT, HTML_TARGET)}`);
    process.exitCode = 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

void main();
