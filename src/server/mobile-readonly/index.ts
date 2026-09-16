import type { MobileReadonlyServiceConfig } from './config';
import { loadServiceConfigFromEnv } from './config';
import { startMobileReadonlyService } from './service';

/**
 * 云端轻量只读服务入口（Dockerfile.mobile-readonly 运行时 `node dist/mobile-readonly/server.cjs`）。
 *
 * - 生产：绑定 0.0.0.0（共享 Docker 内部网络），外部 HTTPS 由 1Panel/OpenResty 反代终止；
 * - 配置经环境变量（config.ts）；凭证只存摘要文件（credentials-cli.ts 生成）；
 * - 日志不打印请求体、业务内容或密钥。
 */

async function main(): Promise<void> {
  let config: MobileReadonlyServiceConfig;
  try {
    config = loadServiceConfigFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`配置加载失败：${message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const running = await startMobileReadonlyService({ config });
    console.log(
      `mobile-readonly-service 已监听 ${running.baseUrl}（snapshots=${config.dataDir}；` +
        (config.tls === null ? '内部 HTTP，外部 HTTPS 由反代终止' : '直连 HTTPS') + '）',
    );
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`收到 ${signal}，关闭服务`);
      await running.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    console.error(`服务启动失败：${message}`);
    process.exitCode = 1;
  }
}

void main();
