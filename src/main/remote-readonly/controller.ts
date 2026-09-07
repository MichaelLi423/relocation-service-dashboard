/**
 * 远程只读发布：publisher 控制控制器（tasks 2.3 controller 切片）。
 *
 * 极窄编排：把桌面状态入口的意图映射到 control-store 的既有事务方法
 * （readCurrent/configure/confirm/stopLocally/invalidate）。canonical 输入校验与状态
 * 转换唯一来源是 consent.ts + control-store.ts，本模块不重复任何 validator，也不提供
 * 异步外发/发布占位与伪造成功（无 network/vault/Electron/UI 依赖，无 requestPublish）。
 * - readStatus：安全本地状态 {state/available/configured/revision}，无路径/secret/原始
 *   cause；store 读取失败 → 固定 'unavailable'，不 throw 到桌面。
 * - 变更方法成功返回同构状态；store 拒绝/损坏时抛 metadata-only ControlStoreError
 *   （由接线层统一转码，本模块不吞错、不捕获后伪装成功）。
 */
import { deriveGateState, type PersistedControlState, type PersistedGateState } from './consent';
import {
  ControlStore,
  ControlStoreError,
  openControlStore,
  type OpenControlStoreOptions,
} from './control-store';

/** 安全状态 DTO（desktop 入口只消费本地状态；unavailable = store 读取失败）。 */
export interface PublisherControllerStatus {
  available: boolean;
  state: PersistedGateState | 'unavailable';
  /** 是否已配置（descriptor+binding 非空），不区分是否已确认。 */
  configured: boolean;
  revision: number;
}

/** store 读取失败时返回的固定状态（不带原始 cause/路径）。 */
const UNAVAILABLE_STATUS: PublisherControllerStatus = {
  available: false,
  state: 'unavailable',
  configured: false,
  revision: 0,
};

function toStatus(state: PersistedControlState): PublisherControllerStatus {
  return {
    available: true,
    state: deriveGateState(state),
    configured: state.descriptor !== null && state.binding !== null,
    revision: state.revision,
  };
}

/** 控制器所需的最小 store 面（仅五个既有方法；保持 store 内校验不重复）。 */
type ControlStorePort = Pick<
  ControlStore,
  'readCurrent' | 'configure' | 'confirm' | 'stopLocally' | 'invalidate'
>;

export class PublisherController {
  /** 工厂：经 openControlStore 建库并包装（真实接线入口）。 */
  static open(options: OpenControlStoreOptions): PublisherController {
    return new PublisherController(openControlStore(options));
  }

  constructor(private readonly store: ControlStorePort) {}

  /** 安全状态读取；store 读取失败 → unavailable（不 throw 到桌面）。 */
  readStatus(): PublisherControllerStatus {
    try {
      return toStatus(this.store.readCurrent());
    } catch (err) {
      if (err instanceof ControlStoreError) return UNAVAILABLE_STATUS;
      throw err;
    }
  }

  /** 配置发布目标/binding（非法输入由 store 严格 parse 拒绝，本层不重复校验）。 */
  configure(descriptorInput: unknown, bindingInput: unknown): PublisherControllerStatus {
    return toStatus(this.store.configure(descriptorInput, bindingInput));
  }

  /** 知情确认：exactFullConsent 必须与当前配置精确一致且三项字面 true，才置 enabled。 */
  confirmAndEnable(exactFullConsentInput: unknown): PublisherControllerStatus {
    return toStatus(this.store.confirm(exactFullConsentInput));
  }

  /** 本地停止新工作（保留配置与 consent 报告面；gate 不再放行）。 */
  stopLocally(): PublisherControllerStatus {
    return toStatus(this.store.stopLocally());
  }

  /** 配置失效：清 consent 回 disabled（保留配置；须重新知情确认），同事务清队列。 */
  invalidateConfiguration(): PublisherControllerStatus {
    return toStatus(this.store.invalidate());
  }
}
