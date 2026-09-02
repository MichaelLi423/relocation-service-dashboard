import { UniquenessError, ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import type { ProjectRepository } from '../relocation-project-lifecycle';
import { ORDER_TYPES, type OrderType, type ServiceOrder } from './service-order';
import type { ServiceOrderRepository } from './service-order-repositories';

/**
 * service-order-recording 领域服务（tasks 3.8~3.10）。
 *
 * - 3.8 四类开单：搬迁开单关联搬迁项目；认证/单寄备件/PM 开单可独立保存
 *   （无项目），亦可在项目上下文中归档关联当前项目——该关联仅为归档/查询
 *   关系，不进入搬迁项目生命周期；开单时间未填默认当前时间（TBD-22）。
 * - 3.9 非空服务单号全局唯一、四类共用唯一空间（TBD-21）；开单不改变项目
 *   进单状态与主状态；开单工作量按唯一服务单号计数并按四类业务分组。
 * 所有手工事实绑定当前登录账号归属（design D12）。项目补齐不创建开单；全部开单
 * 必须经本服务的独立 recordOrder 动作登记。
 */

/** 手工登记开单输入（3.8/3.9；v20 起 engineer 可空后续补录）。 */
export interface ServiceOrderInput {
  orderType: OrderType;
  /** 非空服务单号全局唯一（四类共用唯一空间）。 */
  serviceOrderNo: string;
  /** 开单日期（未填默认当天，TBD-22）。 */
  orderedAt?: BusinessDate;
  /** 参与工程师（可空，允许后续补录）。 */
  engineer?: string | null;
  /** 客户单位（必填）。 */
  customerName: string;
  /** 项目归档关联（内部 ID）：搬迁开单必填；认证/单寄备件/PM 可选（仅归档/查询关系，不进入搬迁生命周期）。 */
  projectId?: string | null;
  /** 备注可选。 */
  note?: string | null;
}

/** 开单工作量：按唯一服务单号计数、按四类业务分组（3.9）。 */
export interface OrderWorkloadRow {
  orderType: OrderType;
  count: number;
}

export class ServiceOrderService {
  constructor(
    private readonly orders: ServiceOrderRepository,
    private readonly projects?: ProjectRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * 手工登记开单记录。
   * - 搬迁开单必须关联一个已存在的搬迁项目。
   * - 认证/单寄备件/PM 开单可独立保存；提供 projectId 时仅作归档/查询关联
   *   （验证项目存在），不进入搬迁项目生命周期。
   */
  recordOrder(input: ServiceOrderInput, actor: ActorSnapshot): ServiceOrder {
    if (!(ORDER_TYPES as readonly string[]).includes(input.orderType)) {
      throw new ValidationError(
        'ILLEGAL_ORDER_TYPE',
        `开单类型仅限 ${ORDER_TYPES.join('、')}`,
      );
    }
    const orderNo = assertRequiredText(input.serviceOrderNo, '服务单号');
    const rawEngineer = input.engineer == null ? null : String(input.engineer).trim();
    const engineer = rawEngineer === '' ? null : rawEngineer;
    const customerName = assertRequiredText(input.customerName, '客户单位');
    this.assertOrderNoUnique(orderNo);

    let projectId: string | null = null;
    if (input.orderType === 'relocation') {
      projectId = assertRequiredText(input.projectId ?? null, '搬迁开单关联的搬迁项目');
      if (this.projects && !this.projects.findById(projectId)) {
        throw new ValidationError('PROJECT_NOT_FOUND', `搬迁项目不存在: ${projectId}`);
      }
    } else if (input.projectId) {
      // 认证/单寄备件/PM：可选项目归档关联（仅归档/查询关系，不进入搬迁生命周期）。
      // 提供时验证项目存在；未提供（缺省/空）保持独立保存。
      projectId = input.projectId;
      if (this.projects && !this.projects.findById(projectId)) {
        throw new ValidationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
      }
    }

    const orderedAt = input.orderedAt ?? this.today();
    assertValidBusinessDate(orderedAt, '开单时间');
    const now = this.now();
    const order: ServiceOrder = {
      id: newInternalId(),
      orderType: input.orderType,
      serviceOrderNo: orderNo,
      orderedAt,
      engineer,
      customerName,
      projectId,
      note: input.note?.trim() === '' ? null : (input.note?.trim() ?? null),
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.save(order);
    return order;
  }

  findByServiceOrderNo(serviceOrderNo: string): ServiceOrder | undefined {
    return this.orders.findByServiceOrderNo(serviceOrderNo);
  }

  /** 后补备注：备注缺失不影响记录保存，可随时补填。 */
  updateNote(orderId: string, note: string | null, actor: ActorSnapshot): ServiceOrder {
    const order = this.orders.findById(orderId);
    if (!order) {
      throw new ValidationError('ORDER_NOT_FOUND', `开单记录不存在: ${orderId}`);
    }
    order.note = note?.trim() === '' ? null : (note?.trim() ?? null);
    order.accountId = actor.accountId;
    order.usernameSnapshot = actor.username;
    order.updatedAt = this.now();
    this.orders.save(order);
    return order;
  }

  /** 后补/修改工程师：工程师允许空缺保存，保存后可随时补录或清空（v20）。 */
  updateEngineer(orderId: string, engineer: string | null, _actor: ActorSnapshot): ServiceOrder {
    const order = this.orders.findById(orderId);
    if (!order) {
      throw new ValidationError('ORDER_NOT_FOUND', `开单记录不存在: ${orderId}`);
    }
    const normalized = engineer?.trim() === '' ? null : (engineer?.trim() ?? null);
    const current = order.engineer ?? null;
    if (current === normalized) {
      return order;
    }
    order.engineer = normalized;
    // 保留创建者归属快照（accountId/usernameSnapshot），不由编辑者覆盖（v20）。
    order.updatedAt = this.now();
    this.orders.save(order);
    return order;
  }

  listOrders(): ServiceOrder[] {
    return this.orders.list();
  }

  listByProject(projectId: string): ServiceOrder[] {
    return this.orders.listByProject(projectId);
  }

  /**
   * 确认后删除一条开单记录（5.2）。
   * - 删除后该记录不再出现在开单详情、历史浏览与开单量统计（countWorkload）中；
   * - 删除 MUST NOT 删除或修改其关联搬迁项目（若存在），项目主状态与进单状态
   *   不变（本服务不调用 lifecycle，亦不触碰项目记录）。
   */
  delete(id: string): { ownedChildCount: number; projectId?: string } {
    const order = this.orders.findById(id);
    if (!order) {
      throw new ValidationError('ORDER_NOT_FOUND', `开单记录不存在: ${id}`);
    }
    this.orders.deleteById(id);
    return { ownedChildCount: 0, projectId: order.projectId ?? undefined };
  }

  /**
   * 开单工作量：按唯一服务单号计数（同一服务单关联多名工程师或多次上门仍只计
   * 一次）、按搬迁/认证/单寄备件/PM 四类业务分组（3.9 / 7.4）。
   */
  countWorkload(): OrderWorkloadRow[] {
    const counts = new Map<OrderType, number>();
    for (const order of this.orders.list()) {
      if (order.serviceOrderNo === null) continue; // 无单号不计工作量
      counts.set(order.orderType, (counts.get(order.orderType) ?? 0) + 1);
    }
    return ORDER_TYPES.filter((t) => counts.has(t)).map((t) => ({
      orderType: t,
      count: counts.get(t)!,
    }));
  }

  private assertOrderNoUnique(orderNo: string): void {
    const existing = this.orders.findByServiceOrderNo(orderNo);
    if (existing) {
      throw new UniquenessError(
        'SERVICE_ORDER_NO_UNIQUE',
        `服务单号「${orderNo}」已存在，非空服务单号全局唯一（四类业务共用唯一空间）`,
      );
    }
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
