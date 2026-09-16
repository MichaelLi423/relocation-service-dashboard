import {
  validateMobileReadonlySnapshot,
  type MobileReadonlySnapshot,
  type MobileReadonlySnapshotIssue,
  type MobileReadonlyUploadBody,
  type MobileReadonlyUploadProtocol,
} from '../../shared/mobile-readonly';

/**
 * 上传请求体分层校验（design D3/D6 / tasks 7.1）。
 *
 * - 请求体顶层严格键集 = { protocol, snapshot }；protocol = { publicationId,
 *   expectedCurrentVersion }（协议字段，不进业务白名单 unknown-key 判定）；
 * - snapshot = 业务白名单快照，以共享严格校验器深校验（含嵌套未知 key/金额/日期/dataAsOf）；
 * - 校验先于一切写盘决策；报告给客户端的内容有界（条数/长度截断）。
 */

/** publicationId 非空且有界。 */
export const MAX_PUBLICATION_ID_LENGTH = 200;
/** 校验问题向客户端回显的上界（防超长响应）。 */
export const MAX_SNAPSHOT_ISSUES_REPORTED = 20;
/** 单条 issue message 回显长度上界。 */
export const MAX_ISSUE_MESSAGE_LENGTH = 160;

export type UploadBodyValidation =
  | { ok: true; body: MobileReadonlyUploadBody }
  | { ok: false; code: 'INVALID_PROTOCOL' | 'INVALID_SNAPSHOT'; message: string; issues?: readonly MobileReadonlySnapshotIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** protocol 层严格校验：恰好 publicationId/expectedCurrentVersion 两键。 */
function checkProtocol(value: unknown): MobileReadonlyUploadProtocol | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'expectedCurrentVersion' || keys[1] !== 'publicationId') return null;
  const publicationId = value.publicationId;
  const expectedCurrentVersion = value.expectedCurrentVersion;
  if (typeof publicationId !== 'string' || publicationId.length === 0 || publicationId.length > MAX_PUBLICATION_ID_LENGTH) {
    return null;
  }
  if (typeof expectedCurrentVersion !== 'number' || !Number.isSafeInteger(expectedCurrentVersion) || expectedCurrentVersion < 0) {
    return null;
  }
  return { publicationId, expectedCurrentVersion };
}

function truncateMessage(message: string): string {
  return message.length <= MAX_ISSUE_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)}…`;
}

/** 校验完整上传请求体（分层）。校验通过返回可直接入队提交的候选。 */
export function validateUploadBody(value: unknown): UploadBodyValidation {
  if (!isPlainObject(value)) {
    return { ok: false, code: 'INVALID_PROTOCOL', message: '请求体应为对象（{protocol, snapshot}）' };
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'protocol' || keys[1] !== 'snapshot') {
    return { ok: false, code: 'INVALID_PROTOCOL', message: '请求体顶层键必须恰为 protocol 与 snapshot' };
  }
  const protocol = checkProtocol(value.protocol);
  if (protocol === null) {
    return {
      ok: false,
      code: 'INVALID_PROTOCOL',
      message: 'protocol 必须恰含非空有界 publicationId 与非负安全整数 expectedCurrentVersion',
    };
  }
  const validation = validateMobileReadonlySnapshot(value.snapshot);
  if (!validation.ok) {
    const issues = validation.issues.slice(0, MAX_SNAPSHOT_ISSUES_REPORTED).map((issue) => ({
      ...issue,
      message: truncateMessage(issue.message),
    }));
    return {
      ok: false,
      code: 'INVALID_SNAPSHOT',
      message: `快照未通过封闭白名单校验（共 ${validation.issues.length} 项，回显前 ${issues.length} 项）`,
      issues,
    };
  }
  const snapshot = value.snapshot as unknown as MobileReadonlySnapshot;
  return {
    ok: true,
    body: { protocol, snapshot },
  };
}
