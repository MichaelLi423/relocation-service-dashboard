/**
 * 移动只读发布主进程模块统一错误（design D4/D5/D6 桌面侧）。
 *
 * 只承载稳定 code（供 UI/IPC 稳定呈现与测试断言），message 就地提示；
 * 错误消息与日志不得包含上传 token、目标配置密文或业务快照内容。
 */

export class MobileReadonlyPublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MobileReadonlyPublishError';
  }
}

/**
 * 桌面侧规范化错误/提示码集合。
 * - config/credential/state 类为本地状态问题（不会进入 lastFailedCode）；
 * - 其余为发布周期失败码（进入 lastFailedCode，UI 呈现最近失败）。
 */
export const MOBILE_READONLY_LOCAL_CODES = {
  CONFIG_CORRUPT: 'CONFIG_CORRUPT',
  CONFIG_WRITE_FAILED: 'CONFIG_WRITE_FAILED',
  CONFIG_NOT_READABLE: 'CONFIG_NOT_READABLE',
  CREDENTIAL_UNAVAILABLE: 'CREDENTIAL_UNAVAILABLE',
  SAFE_STORAGE_UNAVAILABLE: 'SAFE_STORAGE_UNAVAILABLE',
  INVALID_TARGET: 'INVALID_TARGET',
  EMPTY_TOKEN: 'EMPTY_TOKEN',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_ENABLED: 'NOT_ENABLED',
  STATE_WRITE_FAILED: 'STATE_WRITE_FAILED',
  LOCAL_SNAPSHOT_FAILED: 'LOCAL_SNAPSHOT_FAILED',
} as const;
export type MobileReadonlyLocalCode = (typeof MOBILE_READONLY_LOCAL_CODES)[keyof typeof MOBILE_READONLY_LOCAL_CODES];

/** 发布周期失败（网络/服务/协议）规范化码（进入 lastFailedCode）。 */
export const MOBILE_READONLY_REMOTE_CODES = {
  META_READ_FAILED: 'META_READ_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TLS_ERROR: 'TLS_ERROR',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  BAD_RESPONSE: 'BAD_RESPONSE',
  SERVER_ERROR: 'SERVER_ERROR',
  RETRY_LIMIT: 'RETRY_LIMIT',
} as const;
export type MobileReadonlyRemoteCode = (typeof MOBILE_READONLY_REMOTE_CODES)[keyof typeof MOBILE_READONLY_REMOTE_CODES];

export type MobileReadonlyFailureCode = MobileReadonlyLocalCode | MobileReadonlyRemoteCode;
