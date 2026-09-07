/**
 * remote-readonly 稳定拒绝/错误码契约（tasks 1.2，未来 wire protocol 引用锚点）。
 *
 * - 逻辑契约层只抛本文件定义的 DomainError；业务值、客户值、金额与日期文本
 *   一律不得写入错误 message 或错误对象可序列化属性（日志/错误边界可能外泄），
 *   message 固定为中文模板。
 * - UNKNOWN_FIELD 等元数据错误只携带上下文路径（受控 allowlist 元数据），
 *   永不携带字段值；未知/攻击者键不进入任何可序列化属性（message/ref/extra）。
 * - 本模块不依赖 WorkbenchApi / Electron / renderer / 本机 DB，供后续桌面 publisher
 *   与云端 ingest/read/control 独立使用。
 */
import { DomainError } from '../../domain/core/errors';

/**
 * 受控拒绝上下文前缀（allowlist）：UnknownFieldRejection 只携带上下文路径定位，
 * 不接受未知上下文。上下文内可能嵌套固定子路径（如 manifest.entityCounts）。
 */
export const REJECTION_CONTEXTS = [
  'project',
  'project.counts',
  'project.nonBlocking',
  'batch',
  'instrument',
  'order',
  'invoice',
  'damage',
  'manifest',
  'manifest.checksum',
  'manifest.entityCounts',
  'jsonl',
  'mobile-read-v1.query',
  'mobile-read-v1.detail',
  'mobile-read-v1.section',
  'query',
  'section',
] as const;

export type RejectionContext = (typeof REJECTION_CONTEXTS)[number];

/** 拒绝路径引用：只含受控上下文与位置；不携带任何调用方输入字符串。 */
export interface RejectionFieldRef {
  /** 受控上下文（allowlist 元数据）。 */
  context: RejectionContext;
  /** 是否仅指明「存在未知/未批准字段」而不具体命名未知键。 */
  unknown: true;
}

/** 由受控上下文构造未知字段拒绝引用。field 形参保留以兼容调用方签名，但其内容被忽略。 */
export function rejectionField(context: string, field: string): RejectionFieldRef {
  void field; // 未知键不进入任何错误属性（metadata-only）；签名保留兼容既有调用方。
  if (!(REJECTION_CONTEXTS as readonly string[]).includes(context)) {
    // 上下文不受控时保守落到通用位置，且不携带调用方传入的 context/field 字符串。
    return { context: 'query', unknown: true };
  }
  return { context: context as RejectionContext, unknown: true };
}

/** 字段白名单拒绝（未知/未批准字段）：message/ref 只含受控上下文，不携带未知键与值。 */
export class UnknownFieldRejection extends DomainError {
  readonly ref: RejectionFieldRef;

  constructor(ref: RejectionFieldRef, extra?: string) {
    super('UNKNOWN_FIELD', `拒绝未知或未批准字段：${ref.context}`);
    this.name = 'UnknownFieldRejection';
    this.ref = ref;
    if (extra !== undefined && extra !== '') {
      // 只允许固定上下文内的内部定位说明；不插值调用方字符串。
      this.message = `拒绝未知或未批准字段：${ref.context}（含未批准字段）`;
    }
  }
}

/** 字段值格式/类型拒绝（金额、日期、枚举、长度、标识符）。 */
export class InvalidValueRejection extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'InvalidValueRejection';
  }
}

/** 投影/清单计数、关联、重复 ID、checksum 等结构不一致。 */
export class ContractMismatchRejection extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ContractMismatchRejection';
  }
}

/** 业务修订 / 代际 / 激活 / epoch / job 排序冲突（publication-control）。 */
export class OrderingRejection extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'OrderingRejection';
  }
}

/** 未实现/后置依赖：契约已列出但真实源接入尚未实现。 */
export class NotImplementedContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedContractError';
  }
}
