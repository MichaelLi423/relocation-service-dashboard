export const STAGING_TOTAL_LIMIT_BYTES = 256 * 1024 * 1024;

export const STAGING_FILES = Object.freeze({
  manifest: 'manifest.json',
  projection: 'projection.jsonl.part',
  build: 'build.sqlite.part',
});

export type StagingFileKind = keyof typeof STAGING_FILES;

export const STAGING_FILE_LIMITS = Object.freeze({
  // 技术上限，与现有 manifest 严格解析的输入上限一致。
  manifest: 64 * 1024,
  projection: 64 * 1024 * 1024,
  build: 128 * 1024 * 1024,
});

export const STAGING_ERROR_CODES = Object.freeze({
  INVALID_CONFIG: 'STAGING_INVALID_CONFIG',
  UNSAFE_PATH: 'STAGING_UNSAFE_PATH',
  BUSY: 'STAGING_BUSY',
  INVALID_STATE: 'STAGING_INVALID_STATE',
  OWNER_MISMATCH: 'STAGING_OWNER_MISMATCH',
  QUOTA_EXCEEDED: 'STAGING_QUOTA_EXCEEDED',
  FILE_LIMIT_EXCEEDED: 'STAGING_FILE_LIMIT_EXCEEDED',
  WRITE_BUSY: 'STAGING_WRITE_BUSY',
  IO_FAILED: 'STAGING_IO_FAILED',
  CLEANUP_FAILED: 'STAGING_CLEANUP_FAILED',
} as const);

export type StagingErrorCode = typeof STAGING_ERROR_CODES[keyof typeof STAGING_ERROR_CODES];
const errorCodes: readonly string[] = Object.values(STAGING_ERROR_CODES);

export class StagingError extends Error {
  readonly code: StagingErrorCode;

  constructor(code: StagingErrorCode) {
    const safeCode = errorCodes.includes(code) ? code : STAGING_ERROR_CODES.INVALID_STATE;
    super(`staging ${safeCode}`);
    this.name = 'StagingError';
    this.code = safeCode;
  }
}
