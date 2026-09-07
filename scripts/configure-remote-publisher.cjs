'use strict';
/**
 * configure-remote-publisher.cjs — 受控本地配置工具：登记首次发布者凭据（secret）。
 *
 * 职责与边界（design 决策 4：首次凭据登记经隐藏本地交互输入写入 OS credential vault）：
 * - **只登记 secret**：经 main-side/native 模块写入 OS vault。登记 ≠ 知情启用——
 *   不授权真实发布/部署、不写 control-store、不连网、不触 renderer/业务 SQLite。
 * - 隐藏本地交互：只接受非敏感 `--publisher-id <id>` 与 `--help`；secret 仅通过
 *   交互式 TTY raw 无回显输入读取；不接受管道/重定向 stdin、不打印 argv 值。
 *   本工具**从不从环境变量读取 secret，也不因环境里存在任意命名键而拒绝登记**
 *   （例如不拦截无关的 GITHUB_TOKEN 等）。secret 唯一来源是交互式输入。
 * - key identity 与 main 适配器完全一致（同一 credential-vault-identity.cjs，
 *   同一 `(service, username)` 构造签名）。
 * - TTY raw 模式只在读取期间开启。读取前先把既有 data/error 监听器**临时分离**
 *   （避免它们收到 secret 输入），结束后**精确还原**：先移除本次安装的监听器、
 *   按原顺序恢复既有监听器、恢复进入前的 raw 模式与 paused/flowing 状态。
 *   所有退出路径（Enter / Ctrl+C / 控制序列 / 超长 / stdin error / 恢复失败 /
 *   stdout 写入失败）都先做该还原；还原失败则**不触碰后端**并以通用终端失败返回。
 * - 缓冲解码用 `string_decoder.StringDecoder('utf8')`，避免多字节字符跨 chunk
 *   被切断损坏；长度按 Unicode 码点计数（与 main 一致），退格删除整个码点，
 *   Ctrl+U 清空已输入内容；其余控制序列安全拒绝、不回显、不产生转义输出。
 * - 原生 @napi-rs/keyring 只在输入完整、终端已恢复后才 require（无输入不加载原生）。
 *   读取到的 secret 在用后清空引用（JS 内存无法保证零化，本工具不声称零化）。
 *
 * 退出码：成功 0；登记失败 1；用户取消（Ctrl+C）130。
 * 运行：node scripts/configure-remote-publisher.cjs --publisher-id <id>
 * CommonJS；`require.main === module` 守卫——被 import（测试 require）时不执行。
 */
const { StringDecoder } = require('node:string_decoder');
const {
  CREDENTIAL_SERVICE,
  CREDENTIAL_ID_MAX_CHARS,
  CREDENTIAL_SECRET_MAX_CHARS,
  SUPPORTED_VAULT_PLATFORMS,
  isValidPublisherId,
} = require('../src/main/remote-readonly/credential-vault-identity.cjs');

/** 固定输出文案（metadata-only；不回显 secret / argv 值 / 裸异常原文）。 */
const OUT = Object.freeze({
  SUCCESS: '发布者凭据已写入系统凭据库。',
  NOT_A_TTY: '需要交互式终端；不接受管道/重定向 stdin。',
  INVALID_PUBLISHER_ID: 'publisher id 无效：应为 ASCII 字母数字与 -_ 的受控技术标识符。',
  UNKNOWN_ARG: '未知参数；请用 --help 查看用法。',
  BACKEND_FAILURE: '无法确认凭据写入；请检查系统凭据库后重试。',
  NATIVE_UNAVAILABLE: '当前平台没有可用的系统凭据提供方。',
  CANCELLED: '已取消。',
  SECRET_OVERSIZE: 'secret 超过长度上限；已中止。',
  TERMINAL_FAILURE: '终端状态未能正确恢复；未写入凭据。',
});

const USAGE = `用法：
  node scripts/configure-remote-publisher.cjs --publisher-id <id>
  node scripts/configure-remote-publisher.cjs --help

选项：
  --publisher-id <id>  非敏感技术发布者标识符（ASCII 字母数字与 '-' '_'，3–${CREDENTIAL_ID_MAX_CHARS}
                       字符，首尾不得为 '-' '_'；仅用于定位系统凭据条目，本身不打印）
  --help               显示本帮助

说明：
  - secret 仅经交互式 TTY 隐藏输入读取（Enter 确认，Ctrl+C 取消）；本工具不从环境变量
    或命令行参数读取 secret。
  - 支持平台：${SUPPORTED_VAULT_PLATFORMS.join('/')}；不支持时 fail closed，不回退明文。
  - 本工具只登记 secret（凭据登记 ≠ 知情启用：不授权真实发布或部署）。
`;

const PROMPT = '请输入发布者 secret（不回显；Enter 确认，Ctrl+C 取消）：';

/** 解析 CLI 参数：只允许 --publisher-id <value> 与 --help；其余一律 UNKNOWN_ARG。 */
function parseArgs(argv) {
  if (argv.length === 0) return { help: true };
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length === 2 && argv[0] === '--publisher-id') return { publisherId: argv[1] };
  return { error: 'UNKNOWN_ARG' };
}

/**
 * 隐藏输入读取：raw 无回显，直到 Enter / Ctrl+C / 控制序列 / 出错 / 超长取消。
 * 读取前临时分离既有 data/error 监听器，结束后精确还原（先移除本次安装的监听器、
 * 恢复既有监听器与进入前的 raw + paused/flowing 状态），全部在 resolve 前同步完成。
 * 还原或 stdout 写入失败 → { ok:false, reason:'terminal' }（调用方不得触碰后端）。
 *
 * 还原用 `rawListeners()` 快照而非 `listeners()`：`.once()` 在 Node 中以包装函数
 * 注册，`listeners()` 返回被解包的原始函数——若用 `.on()` 还原，原本只触发一次的
 * once 监听器会变成持久监听器。`rawListeners()` 返回真实包装（`wrapper.listener`
 * 指向原始函数），据此可精确还原 once 语义与注册顺序。
 */
function readSecretHidden({ stdin, stdout }) {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    const parts = [];
    let settled = false;
    const priorRaw = typeof stdin.isRaw === 'boolean' ? stdin.isRaw : false;
    const priorPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
    const priorData = stdin.rawListeners('data');
    const priorError = stdin.rawListeners('error');

    function restore() {
      let ok = true;
      try {
        stdin.removeListener('data', onData);
        stdin.removeListener('error', onError);
      } catch {
        ok = false;
      }
      try {
        process.removeListener('SIGINT', onSigint);
      } catch {
        ok = false;
      }
      for (const wrapper of priorData) {
        try {
          // wrapper 可能是真实 once 包装（listener 为原始函数）；按原样加回保持 once 语义。
          stdin.on('data', wrapper);
        } catch {
          ok = false;
        }
      }
      for (const wrapper of priorError) {
        try {
          stdin.on('error', wrapper);
        } catch {
          ok = false;
        }
      }
      if (typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(priorRaw);
        } catch {
          ok = false;
        }
      }
      if (priorPaused) {
        if (typeof stdin.pause === 'function') {
          try {
            stdin.pause();
          } catch {
            ok = false;
          }
        } else {
          ok = false;
        }
      }
      return ok;
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      parts.length = 0;
      if (!restore()) {
        resolve({ ok: false, reason: 'terminal' });
        return;
      }
      try {
        stdout.write('\n');
      } catch {
        resolve({ ok: false, reason: 'terminal' });
        return;
      }
      resolve(result);
    }

    function onSigint() {
      finish({ ok: false, reason: 'cancelled' });
    }

    function onError() {
      finish({ ok: false, reason: 'io' });
    }

    function onData(chunk) {
      if (settled) return;
      const text = decoder.write(chunk);
      for (const ch of text) {
        if (ch === '\u0003') {
          // Ctrl+C：取消。
          finish({ ok: false, reason: 'cancelled' });
          return;
        }
        if (ch === '\r' || ch === '\n') {
          // Enter 结束：空输入 → empty，否则返回已输入内容。
          const value = parts.join('');
          finish(parts.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, value });
          return;
        }
        if (ch === '\u007f' || ch === '\u0008') {
          // 退格：删除**整个**码点（对代理对安全）。
          parts.pop();
          continue;
        }
        if (ch === '\u0015') {
          // Ctrl+U：清空已输入内容。
          parts.length = 0;
          continue;
        }
        const code = ch.codePointAt(0);
        if (code !== undefined && (code < 0x20 || code === 0x7f)) {
          // 其余控制序列（ESC 等）：安全拒绝，不回显、不产生转义输出。
          finish({ ok: false, reason: 'control' });
          return;
        }
        if (parts.length >= CREDENTIAL_SECRET_MAX_CHARS) {
          // 超长：立即取消（不截断、不留半截 secret）。
          finish({ ok: false, reason: 'overlong' });
          return;
        }
        parts.push(ch);
      }
    }

    // 分离既有监听器，避免它们收到 secret 输入；结束后按原顺序恢复。
    for (const l of priorData) stdin.removeListener('data', l);
    for (const l of priorError) stdin.removeListener('error', l);
    stdin.on('data', onData);
    stdin.on('error', onError);
    process.once('SIGINT', onSigint);

    if (typeof stdin.setRawMode !== 'function') {
      // 无法无回显读取（无 raw 能力）：不冒险在回显模式下收集 secret。
      finish({ ok: false, reason: 'terminal' });
      return;
    }
    try {
      stdin.setRawMode(true);
    } catch {
      finish({ ok: false, reason: 'terminal' });
      return;
    }
    // 需要 flowing 才有 data 事件；进入前是 paused 就先 resume，退出时还原。
    if (priorPaused) {
      if (typeof stdin.resume === 'function') {
        try {
          stdin.resume();
        } catch {
          finish({ ok: false, reason: 'terminal' });
          return;
        }
      } else {
        finish({ ok: false, reason: 'terminal' });
        return;
      }
    }
    try {
      stdout.write(PROMPT);
    } catch {
      finish({ ok: false, reason: 'terminal' });
    }
  });
}

/**
 * 单次登记流程（顶层 CLI 调用；测试注入 fake 参数/流/后端）。
 * 返回 { ok, cancelled }；任何输出都经固定 OUT 文案，不含 secret/argv 值/裸异常。
 */
async function runEnrollment(overrides = {}) {
  const argv = overrides.argv ?? process.argv.slice(2);
  const stdin = overrides.stdin ?? process.stdin;
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;
  const platform = overrides.platform ?? process.platform;
  // factory: (service, username) => AsyncEntry。默认真实 keyring 懒加载。
  const factory = overrides.factory ?? loadNativeFactory;

  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return { ok: true, cancelled: false };
  }
  if (parsed.error) {
    stderr.write(OUT.UNKNOWN_ARG + '\n');
    return { ok: false, cancelled: false };
  }
  if (!isValidPublisherId(parsed.publisherId)) {
    stderr.write(OUT.INVALID_PUBLISHER_ID + '\n');
    return { ok: false, cancelled: false };
  }
  if (!SUPPORTED_VAULT_PLATFORMS.includes(platform)) {
    stderr.write(OUT.NATIVE_UNAVAILABLE + '\n');
    return { ok: false, cancelled: false };
  }
  if (
    typeof stdin.isTTY !== 'boolean' ||
    !stdin.isTTY ||
    typeof stdout.isTTY !== 'boolean' ||
    !stdout.isTTY
  ) {
    stderr.write(OUT.NOT_A_TTY + '\n');
    return { ok: false, cancelled: false };
  }

  const read = await readSecretHidden({ stdin, stdout });
  if (!read.ok) {
    const text =
      read.reason === 'overlong'
        ? OUT.SECRET_OVERSIZE
        : read.reason === 'terminal' || read.reason === 'io'
          ? OUT.TERMINAL_FAILURE
          : OUT.CANCELLED;
    stderr.write(text + '\n');
    return { ok: false, cancelled: read.reason === 'cancelled' };
  }

  // 输入完整、终端已恢复 → 现在才触碰原生 vault（懒 require）。
  let entry;
  try {
    entry = factory(CREDENTIAL_SERVICE, parsed.publisherId);
  } catch {
    read.value = '';
    stderr.write(OUT.NATIVE_UNAVAILABLE + '\n');
    return { ok: false, cancelled: false };
  }
  try {
    await entry.setPassword(read.value);
  } catch {
    // 写入是否生效无法确认：不声称“未写入”，提示检查系统凭据库。
    read.value = '';
    stderr.write(OUT.BACKEND_FAILURE + '\n');
    return { ok: false, cancelled: false };
  }
  read.value = '';
  try {
    stdout.write(OUT.SUCCESS + '\n');
  } catch {
    stderr.write(OUT.BACKEND_FAILURE + '\n');
    return { ok: false, cancelled: false };
  }
  return { ok: true, cancelled: false };
}

/** 真实 keyring 构造端口：(service, username) => AsyncEntry。仅在登记路径调用（懒加载）。 */
function loadNativeFactory(service, username) {
  // eslint-disable-next-line global-require
  const keyring = require('@napi-rs/keyring');
  return new keyring.AsyncEntry(service, username);
}

if (require.main === module) {
  runEnrollment()
    .then((result) => {
      if (!result.ok) process.exitCode = result.cancelled ? 130 : 1;
    })
    .catch(() => {
      // 极外层兜底：固定文案，不打印裸异常/secret。
      try {
        process.stderr.write(OUT.BACKEND_FAILURE + '\n');
      } catch {
        // 忽略 stderr 写入失败。
      }
      process.exitCode = 1;
    });
}

module.exports = { runEnrollment, parseArgs, OUT, USAGE };
