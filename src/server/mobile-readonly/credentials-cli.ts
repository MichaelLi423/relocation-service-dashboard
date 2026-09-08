import { CREDENTIAL_CLI_ENV, generateCredentialsFile } from './credentials';

/**
 * 凭证生成 CLI（tasks 7.2-7.3 配套）。
 *
 * 输入 SHALL 只来自 stdin 或环境变量（绝不经 argv）；输出只含摘要 JSON，绝不输出明文。
 *
 * 用法：
 *   - 环境变量方式：MOBILE_READONLY_VIEWER_USERNAME/PASSWORD、MOBILE_READONLY_UPLOAD_TOKEN
 *     全部设置后运行 `node dist/mobile-readonly/credentials.cjs`；
 *   - stdin 方式（逐行）：第一行查看密码、第二行上传 token，随后运行并重定向输出到凭证文件，
 *     如 `printf '%s\n' "$PW" "$TOKEN" | node dist/mobile-readonly/credentials.cjs > credentials.json`。
 *
 * 本模块为独立构建入口（见 webpack.mobile-readonly.config.ts 的 credentials entry），
 * 正常运行时不加载，也不被服务进程引用。
 */

async function readStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
}

function firstNonEmpty(lines: string[], fromIndex: number): string | undefined {
  for (let i = fromIndex; i < lines.length; i += 1) {
    const value = lines[i].trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

async function run(): Promise<void> {
  const username = process.env[CREDENTIAL_CLI_ENV.username]?.trim() || 'viewer';
  const envPassword = process.env[CREDENTIAL_CLI_ENV.password];
  const envToken = process.env[CREDENTIAL_CLI_ENV.uploadToken];

  let password = envPassword;
  let uploadToken = envToken;
  if (password === undefined || password.length === 0 || uploadToken === undefined || uploadToken.length === 0) {
    // 任一 secret 缺失即整体回退 stdin（密码行 + token 行）；避免混用导致漏读。
    if (!process.stdin.isTTY) {
      const lines = await readStdinLines();
      password = firstNonEmpty(lines, 0) ?? '';
      uploadToken = firstNonEmpty(lines, lines.findIndex((l) => l.trim().length > 0) + 1) ?? '';
    }
  }
  if (password === undefined || password.length === 0 || uploadToken === undefined || uploadToken.length === 0) {
    process.stderr.write(
      `用法：查看密码与上传 token 必须通过环境变量 ${CREDENTIAL_CLI_ENV.password} / ${CREDENTIAL_CLI_ENV.uploadToken}` +
        ` 或 stdin（第一行密码、第二行 token）提供；禁止经命令行参数传入。\n`,
    );
    process.exitCode = 1;
    return;
  }

  const file = generateCredentialsFile(username, password, uploadToken);
  // stdout 只输出摘要；明文输入永不回显、永不落盘。
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
  process.stderr.write(
    '凭证摘要已生成（仅输出摘要，不含明文）。请将输出重定向为凭证文件，并立即清除生成时使用的明文输入。\n',
  );
  process.exitCode = 0;
}

void run();
