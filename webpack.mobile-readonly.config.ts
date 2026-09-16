import path from 'node:path';
import type { Configuration } from 'webpack';

/**
 * 移动只读独立构建配置（openspec change `add-mobile-readonly-publication`）。
 *
 * 与 Electron Forge 桌面构建完全独立；一次执行产出两类产物：
 *
 * 1. 云端服务（target node，外部化 node 内建模块）：
 *    - `dist/mobile-readonly/server.cjs`       —— entry src/server/mobile-readonly/index.ts
 *    - `dist/mobile-readonly/credentials.cjs`  —— 凭证摘要生成 CLI（凭证明文只走 stdin/env）
 * 2. 手机只读 web（target web）：
 *    - `dist/mobile-readonly/web/app.js`       —— entry src/mobile/index.tsx
 *
 * 运行方式：`node scripts/build-mobile-readonly.cjs`（程序化调用 webpack API，
 * 无需 webpack-cli；本配置 TS 由构建脚本经 typescript.transpileModule 转 CJS 后执行）。
 *
 * CSS 沿用既有 style-loader/css-loader（style-loader 运行时注入，不产出独立 CSS 文件）；
 * ts-loader 沿用 transpileOnly 惯例，类型正确性由 `npm run typecheck` 单独保证。
 * `src/mobile/index.html` 由构建脚本复制到 `dist/mobile-readonly/web/index.html`。
 */

const tsLoaderRule = {
  test: /\.tsx?$/,
  exclude: /(node_modules|\.webpack|dist)/,
  use: {
    loader: 'ts-loader',
    options: { transpileOnly: true },
  },
};

const cssRule = {
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
};

const commonResolve: Configuration['resolve'] = {
  extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  alias: {
    '@': path.resolve(__dirname, 'src'),
  },
};

/** 云端服务（含凭证 CLI）：Node 目标，内建模块 external，两个自包含 entry。 */
export const mobileReadonlyServerConfig: Configuration = {
  name: 'mobile-readonly-server',
  mode: 'production',
  target: 'node',
  context: __dirname,
  devtool: false,
  entry: {
    server: './src/server/mobile-readonly/index.ts',
    credentials: './src/server/mobile-readonly/credentials-cli.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/mobile-readonly'),
    filename: '[name].cjs',
    clean: false,
  },
  externalsPresets: { node: true },
  module: {
    rules: [tsLoaderRule],
  },
  resolve: commonResolve,
  optimization: {
    // 每个 entry 自包含（server.cjs / credentials.cjs 不依赖兄弟 chunk，便于 Docker 单独拷贝运行）。
    splitChunks: false,
  },
};

/** 手机只读 web：浏览器目标，产物 /app.js（index.html 由构建脚本复制到 web 目录）。 */
export const mobileReadonlyWebConfig: Configuration = {
  name: 'mobile-readonly-web',
  mode: 'production',
  target: 'web',
  context: __dirname,
  devtool: false,
  entry: './src/mobile/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/mobile-readonly/web'),
    filename: 'app.js',
    publicPath: '/',
    clean: false,
  },
  module: {
    rules: [tsLoaderRule, cssRule],
  },
  resolve: commonResolve,
  optimization: {
    splitChunks: false,
  },
};

export default [mobileReadonlyServerConfig, mobileReadonlyWebConfig];
