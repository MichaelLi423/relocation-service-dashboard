import { describe, expect, it } from 'vitest';
import { ServiceOrderService } from '../../src/domain/capabilities/service-order-recording/service-order-service';
import { UniquenessError } from '../../src/domain/core/errors';
import { createPendingProject } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryProjectRepository } from '../helpers/in-memory-repos';
import { InMemoryServiceOrderRepository } from '../helpers/service-order-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * service-order-recording 领域场景测试（tasks 3.8~3.10 实现，3.12 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const projects = new InMemoryProjectRepository();
  const orders = new InMemoryServiceOrderRepository();
  const orderService = new ServiceOrderService(orders, projects, CLOCK);
  return { projects, orders, orderService };
}

describe('四类开单与项目关联（3.8）', () => {
  it('搬迁开单关联对应搬迁项目', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);

    const order = orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-001',
        engineer: '工程师甲',
        customerName: '华东医药',
        projectId: project.id,
      },
      ACTOR,
    );
    expect(order.projectId).toBe(project.id);
    expect(order.orderType).toBe('relocation');
  });

  it('认证开单独立保存、不进入搬迁项目生命周期', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'certification',
        serviceOrderNo: 'ORD-002',
        engineer: '工程师乙',
        customerName: '华北医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
    expect(order.orderType).toBe('certification');
  });

  it('单寄备件开单独立保存', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'parts_by_mail',
        serviceOrderNo: 'ORD-003',
        engineer: '工程师丙',
        customerName: '华南医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
  });

  it('PM 开单独立保存', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'pm',
        serviceOrderNo: 'ORD-004',
        engineer: '工程师丁',
        customerName: '西部医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
    expect(order.orderType).toBe('pm');
  });

  it('非搬迁开单可关联项目（仅归档/查询关系），不进入搬迁生命周期', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    const beforeStatus = project.status;
    const beforeEntryAt = project.entryAt;

    const order = orderService.recordOrder(
      {
        orderType: 'pm',
        serviceOrderNo: 'ORD-005',
        engineer: '工程师',
        customerName: '客户',
        projectId: project.id,
      },
      ACTOR,
    );
    expect(order.projectId).toBe(project.id); // 归档关联：出现在该项目归档/查询中
    // 归档关联不进入搬迁生命周期：项目实体未被修改
    expect(projects.findById(project.id)!.status).toBe(beforeStatus);
    expect(projects.findById(project.id)!.entryAt).toBe(beforeEntryAt);
    // 工作量按唯一服务单号计数，不依赖项目
    expect(orderService.countWorkload().find((c) => c.orderType === 'pm')?.count).toBe(1);
  });

  it('非搬迁开单关联不存在的项目时拒绝', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        {
          orderType: 'certification',
          serviceOrderNo: 'ORD-005B',
          engineer: '工程师',
          customerName: '客户',
          projectId: 'not-exist',
        },
        ACTOR,
      ),
    ).toThrow(/项目不存在/);
  });

  it('搬迁开单引用不存在的项目时拒绝', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        {
          orderType: 'relocation',
          serviceOrderNo: 'ORD-006',
          engineer: '工程师',
          customerName: '客户',
          projectId: 'not-exist',
        },
        ACTOR,
      ),
    ).toThrow(/搬迁项目不存在/);
  });
});

describe('服务单号全局唯一（3.9 / TBD-21）', () => {
  it('重复服务单号被拒', () => {
    const { orderService } = setup();
    orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-100', engineer: '工程师甲', customerName: '客户A' },
      ACTOR,
    );
    expect(() =>
      orderService.recordOrder(
        { orderType: 'pm', serviceOrderNo: 'ORD-100', engineer: '工程师乙', customerName: '客户B' },
        ACTOR,
      ),
    ).toThrow(UniquenessError);
  });

  it('不同业务类型共用唯一空间：搬迁单号被认证开单占用拒绝', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-200',
        engineer: '工程师甲',
        customerName: '客户A',
        projectId: project.id,
      },
      ACTOR,
    );
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-200', engineer: '工程师乙', customerName: '客户B' },
        ACTOR,
      ),
    ).toThrow(/全局唯一/);
  });
});

describe('认证、单寄备件与 PM 开单最小字段（3.8 / TBD-22 / v20 工程师可空）', () => {
  it('缺少服务单号或客户单位之一拒绝保存，工程师可空', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: '  ', engineer: '工程师', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(/服务单号/);
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-300', engineer: '  ', customerName: '客户' },
        ACTOR,
      ),
    ).not.toThrow();
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-300-B', engineer: null, customerName: '  ' },
        ACTOR,
      ),
    ).toThrow(/客户单位/);
    expect(() =>
      orderService.recordOrder(
        { orderType: 'illegal-type' as never, serviceOrderNo: 'ORD-300', engineer: '工程师', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(/开单类型/);
  });

  it('工程师可空保存并可后续补录', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-ENG-EMPTY', engineer: null, customerName: '客户' },
      ACTOR,
    );
    expect(order.engineer).toBeNull();
    const withEngineer = orderService.updateEngineer(order.id, '工程师甲', ACTOR);
    expect(withEngineer.engineer).toBe('工程师甲');
    const cleared = orderService.updateEngineer(order.id, null, ACTOR);
    expect(cleared.engineer).toBeNull();
  });

  it('后补工程师', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-ENG-002', engineer: '', customerName: '客户' },
      ACTOR,
    );
    expect(order.engineer).toBeNull();
    const updated = orderService.updateEngineer(order.id, '  工程师乙  ', ACTOR);
    expect(updated.engineer).toBe('工程师乙');
  });

  it('开单仅维护备注与工程师', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-ENG-003', engineer: null, customerName: '客户', note: '初' },
      ACTOR,
    );
    const beforeOrderedAt = order.orderedAt;
    const beforeType = order.orderType;
    const afterNote = orderService.updateNote(order.id, '改备注', ACTOR);
    expect(afterNote.note).toBe('改备注');
    expect(afterNote.orderedAt).toBe(beforeOrderedAt);
    expect(afterNote.orderType).toBe(beforeType);
    const afterEng = orderService.updateEngineer(order.id, '工', ACTOR);
    expect(afterEng.engineer).toBe('工');
    expect(afterEng.orderedAt).toBe(beforeOrderedAt);
  });

  it('运行时拒绝开单身份字段', () => {
    const { orderService } = setup();
    orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-ENG-004', engineer: null, customerName: '客户' },
      ACTOR,
    );
    // 领域服务仅暴露 note/engineer 原位维护，其他身份字段无更新入口，验证无直接 API 可改身份字段
    expect(typeof (orderService as unknown as { updateServiceOrderNo?: unknown }).updateServiceOrderNo).toBe('undefined');
  });

  it('后补工程师归一后相同值零写、保留创建者归属且不刷新更新时间', () => {
    const { orderService, orders } = setup();
    const creator = makeAccount('creator-1', '创建者');
    const editor = makeAccount('editor-1', '编辑者');
    const order = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-ENG-ZERO', engineer: '工程师甲', customerName: '客户' },
      creator,
    );
    const beforeUpdatedAt = order.updatedAt;
    const beforeAccountId = order.accountId;
    const beforeUsername = order.usernameSnapshot;
    // 相同值（含空白归一）零写：不覆盖归属、不刷新 updatedAt、不新增保存
    const same = orderService.updateEngineer(order.id, ' 工程师甲 ', editor);
    expect(same.engineer).toBe('工程师甲');
    expect(same.accountId).toBe(beforeAccountId);
    expect(same.usernameSnapshot).toBe(beforeUsername);
    expect(same.accountId).not.toBe(editor.accountId);
    expect(same.updatedAt).toBe(beforeUpdatedAt);
    expect(orders.findById(order.id)?.accountId).toBe(creator.accountId);
    // 空串归一为 null 的零写
    const nullOrder = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-ENG-ZERO-NULL', engineer: null, customerName: '客户2' },
      creator,
    );
    const beforeNullUpdatedAt = nullOrder.updatedAt;
    const sameNull = orderService.updateEngineer(nullOrder.id, '   ', editor);
    expect(sameNull.engineer).toBeNull();
    expect(sameNull.updatedAt).toBe(beforeNullUpdatedAt);
    // 真正变更时保留创建者
    const changed = orderService.updateEngineer(order.id, '工程师乙', editor);
    expect(changed.engineer).toBe('工程师乙');
    expect(changed.accountId).toBe(creator.accountId);
    expect(changed.usernameSnapshot).toBe(creator.username);
  });

  it('记录全部最小字段后保存，且不关联搬迁项目生命周期', () => {
    const { orderService, orders } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'parts_by_mail',
        serviceOrderNo: 'ORD-301',
        orderedAt: '2026-07-01',
        engineer: '工程师甲',
        customerName: '华东医药',
      },
      ACTOR,
    );
    expect(orders.findById(order.id)?.id).toBe(order.id);
    expect(order.orderedAt).toBe('2026-07-01');
    expect(order.projectId).toBeNull();
  });

  it('记录全部最小字段（工程师可空）后保存', () => {
    const { orderService, orders } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'parts_by_mail',
        serviceOrderNo: 'ORD-301B',
        orderedAt: '2026-07-01',
        engineer: null,
        customerName: '华东医药',
      },
      ACTOR,
    );
    expect(orders.findById(order.id)?.engineer).toBeNull();
  });

  it('开单时间未填默认当前时间', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-302', engineer: '工程师', customerName: '客户' },
      ACTOR,
    );
    expect(order.orderedAt).toBe('2026-08-07');
    expect(order.orderedAt.slice(0, 7)).toBe('2026-08');
  });

  it('后补备注：备注缺失不影响保存，可后补填写', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-303', engineer: '工程师', customerName: '客户' },
      ACTOR,
    );
    expect(order.note).toBeNull();

    const updated = orderService.updateNote(order.id, '认证说明', ACTOR);
    expect(updated.note).toBe('认证说明');
  });
});

describe('开单与进单独立（3.9）', () => {
  it('开单不影响项目进单状态与主状态', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    const beforeStatus = project.status;
    const beforeEntryAt = project.entryAt;

    orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-400',
        engineer: '工程师',
        customerName: '客户',
        projectId: project.id,
      },
      ACTOR,
    );
    // 项目实体未被修改（开单不改变进单状态与主状态）
    expect(project.status).toBe(beforeStatus);
    expect(project.entryAt).toBe(beforeEntryAt);
  });

  it('一个项目可关联多条开单', () => {
    const { orderService, projects, orders } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-401', engineer: '工程师甲', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-402', engineer: '工程师乙', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    expect(orders.listByProject(project.id)).toHaveLength(2);
  });
});

describe('服务单记录删除（5.2）', () => {
  it('确认后删除：开单记录从列表与开单量统计中消失，其他记录不受影响', () => {
    const { orderService, orders } = setup();
    const removed = orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-DEL-001', engineer: '工程师甲', customerName: '客户A' },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-DEL-002', engineer: '工程师乙', customerName: '客户B' },
      ACTOR,
    );
    orderService.delete(removed.id);
    expect(orders.findById(removed.id)).toBeUndefined();
    expect(orders.all).toHaveLength(1);
    const counts = orderService.countWorkload();
    expect(counts.find((c) => c.orderType === 'certification')).toBeUndefined();
    expect(counts.find((c) => c.orderType === 'pm')?.count).toBe(1);
  });

  it('删除不影响关联项目：项目保留，主状态与进单状态不变', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    const beforeStatus = project.status;
    const beforeEntryAt = project.entryAt;
    const order = orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-DEL-003',
        engineer: '工程师甲',
        customerName: '客户A',
        projectId: project.id,
      },
      ACTOR,
    );
    orderService.delete(order.id);
    // 项目行保留，主状态与进单状态不被删除改变
    expect(projects.findById(project.id)).toBeDefined();
    expect(projects.findById(project.id)!.status).toBe(beforeStatus);
    expect(projects.findById(project.id)!.entryAt).toBe(beforeEntryAt);
  });

  it('未确认（不存在）不删除：记录不存在时拒绝且无副作用', () => {
    const { orderService, orders } = setup();
    expect(() => orderService.delete('no-such-order')).toThrow(/开单记录不存在/);
    expect(orders.all).toHaveLength(0);
  });
});

describe('开单工作量计数（3.9）', () => {
  it('同一服务单只计一次（服务单号唯一，关联多名工程师/多次上门仍只计一次）', () => {
    const { orders, projects, orderService } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-600', engineer: '工程师甲、工程师乙', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    expect(orders.all).toHaveLength(1);

    const counts = orderService.countWorkload();
    const relocation = counts.find((c) => c.orderType === 'relocation');
    expect(relocation?.count).toBe(1);
  });

  it('不同服务单分别计数并按四类业务分组', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-700', engineer: '工程师甲', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-701', engineer: '工程师乙', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-702', engineer: '工程师丙', customerName: '客户' },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-703', engineer: '工程师丁', customerName: '客户' },
      ACTOR,
    );

    const counts = orderService.countWorkload();
    expect(counts.find((c) => c.orderType === 'relocation')?.count).toBe(2);
    expect(counts.find((c) => c.orderType === 'certification')?.count).toBe(1);
    expect(counts.find((c) => c.orderType === 'pm')?.count).toBe(1);
    expect(counts.find((c) => c.orderType === 'parts_by_mail')).toBeUndefined();
  });
});
