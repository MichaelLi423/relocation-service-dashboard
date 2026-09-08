import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 工程骨架与网络边界（tasks 1.1/1.2 + 3.2 结构部分）。
 *
 * - renderer 无 Node；桌面领域层（src/domain）、共享契约既有业务部分（src/shared）、
 *   preload、桌面 renderer 与主进程非发布模块保持零网络（无 node:https/node:http/node:net）；
 * - 网络客户端只允许存在于 `src/main/mobile-readonly/`；
 * - 范围说明：`src/server` 与 `src/mobile`（web）由独立授权 lane 持有各自的网络能力，
 *   不属于本结构测试的禁入集。
 */

const NETWORK_MODULES = ['node:https', 'node:http', 'node:net', 'node:tls'];
const NETWORK_IMPORT_RE = new RegExp(
  `(?:from\\s+|import\\s*\\()?['"](${NETWORK_MODULES.join('|')})['"]|require\\(['"](${NETWORK_MODULES.join('|')})['"]\\)`,
);

/** 桌面只读侧：这些目录内的任何文件都不得 import 网络模块。 */
const FORBIDDEN_DIRS = ['src/domain', 'src/shared', 'src/renderer', 'src/preload'];

/** 主进程：除 mobile-readonly 发布模块外也不得 import 网络模块。 */
const MAIN_ROOT = 'src/main';
const ALLOWED_NETWORK_DIR = 'src/main/mobile-readonly';

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function collectFiles(): { forbidden: string[]; mainOutsideModule: string[] } {
  const forbidden: string[] = [];
  for (const dir of FORBIDDEN_DIRS) {
    forbidden.push(...listSourceFiles(dir));
  }
  const mainFiles = listSourceFiles(MAIN_ROOT);
  const mainOutsideModule = mainFiles.filter((file) => !file.startsWith(ALLOWED_NETWORK_DIR));
  return { forbidden, mainOutsideModule };
}

function containsNetworkImport(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  return NETWORK_IMPORT_RE.test(text);
}

describe('移动只读桌面发布 工程网络边界（tasks 1.1/1.2）', () => {
  it('领域/共享/preload/桌面 renderer 不存在网络模块 import（fetch 也不出现于 renderer）', () => {
    const { forbidden } = collectFiles();
    const offenders = forbidden.filter(containsNetworkImport);
    expect(offenders).toEqual([]);

    // renderer 无 Node：除 import 之外也不应出现顶层 fetch( 调用（浏览器 fetch 仅云端 web 使用）。
    const rendererFiles = listSourceFiles('src/renderer');
    const fetchUsers = rendererFiles.filter((file) => /\bfetch\s*\(/.test(readFileSync(file, 'utf8')));
    expect(fetchUsers).toEqual([]);
  });

  it('主进程 src/main 中网络客户端仅存在于 src/main/mobile-readonly', () => {
    const { mainOutsideModule } = collectFiles();
    const offenders = mainOutsideModule.filter(containsNetworkImport);
    expect(offenders).toEqual([]);
  });

  it('发布模块内确实存在 node:https 网络客户端（扫描器有效性的正向样本）', () => {
    const uploadFile = join('src/main/mobile-readonly', 'upload.ts');
    const text = readFileSync(uploadFile, 'utf8');
    expect(text).toContain("from 'node:https'");
  });

  it('网络边界范围只覆盖桌面侧：显式排除独立授权的 src/server 与 src/mobile', () => {
    const serverMobile = ['src/server', 'src/mobile'].filter((dir) => {
      try {
        statSync(dir);
        return true;
      } catch {
        return false;
      }
    });
    // 说明性断言：若这些目录存在，它们不属于本结构测试的禁入集（由对应 lane 自行持有网络能力）。
    for (const dir of serverMobile) {
      const files = listSourceFiles(dir);
      for (const file of files) {
        expect(relative(process.cwd(), file)).not.toMatch(/^src\/(domain|shared|renderer|preload|main(?!\/mobile-readonly))/);
      }
    }
  });
});
