import type {
  MobileReadonlyPublishMetadata,
  MobileReadonlyUploadBody,
} from '../../shared/mobile-readonly';

/**
 * 云端远程（upload/meta）客户端契约（design D3/D6；桌面侧）。
 *
 * - readMeta：GET {target}/api/meta —— 上传凭证可读、非业务版本元数据（含 publicationId）；
 * - upload：PUT {target}/api/publish —— 请求体 {protocol:{publicationId,expectedCurrentVersion}, snapshot} 分层；
 * - 结果分类为 accepted / conflict（服务端明确版本冲突并携带元数据）/ rejected（鉴权/校验拒绝）/
 *   transport（网络/超时/重定向/TLS/响应异常——结果不确定，须按三分支读取元数据恢复）。
 */

export type MobileReadonlyMetaResult =
  | { ok: true; metadata: MobileReadonlyPublishMetadata }
  | { ok: false; code: string };

export type MobileReadonlyPublishOutcome =
  | { kind: 'accepted' }
  | { kind: 'conflict'; metadata: MobileReadonlyPublishMetadata }
  | { kind: 'rejected'; code: string }
  | { kind: 'transport'; code: string };

export interface MobileReadonlyRemote {
  readMeta(): Promise<MobileReadonlyMetaResult>;
  upload(body: MobileReadonlyUploadBody): Promise<MobileReadonlyPublishOutcome>;
}

export interface MobileReadonlyRemoteCredentials {
  /** 规范化 HTTPS origin。 */
  target: string;
  /** 上传 token（仅用于请求头，不记录/不持久化/不随状态返回）。 */
  token: string;
}

export type MobileReadonlyRemoteFactory = (credentials: MobileReadonlyRemoteCredentials) => MobileReadonlyRemote;
