import { describe, expect, it } from 'vitest';
import { CAPABILITY_NAMES, CAPABILITY_OWNERSHIP } from '../../src/shared/capabilities';
import * as lifecycle from '../../src/domain/capabilities/relocation-project-lifecycle';
import * as execution from '../../src/domain/capabilities/relocation-execution';
import * as serviceOrder from '../../src/domain/capabilities/service-order-recording';
import * as shipTo from '../../src/domain/capabilities/ship-to-management';
import * as serialAddress from '../../src/domain/capabilities/serial-address-update';
import * as damageRepair from '../../src/domain/capabilities/damage-repair-tracking';
import * as qrRequest from '../../src/domain/capabilities/qr-request-tracking';
import * as todos from '../../src/domain/capabilities/workbench-todos';
import * as reporting from '../../src/domain/capabilities/operational-reporting';
import * as interfaceModule from '../../src/domain/capabilities/workbench-interface';
import * as financial from '../../src/domain/capabilities/project-financial-closure';
import * as persistence from '../../src/domain/capabilities/local-data-persistence';
import * as historicalImport from '../../src/domain/capabilities/historical-data-import';

/**
 * 所有权边界测试（design D4/D9/D10/D14；tasks 1.8）。
 * 强制「lifecycle 拥有状态转换/校验、todos/reporting/interface 只消费」。
 */
describe('模块所有权边界', () => {
  it('14 个 capability 模块目录齐全', () => {
    expect(CAPABILITY_NAMES).toHaveLength(14);
    expect(Object.keys(CAPABILITY_OWNERSHIP)).toHaveLength(14);
  });

  it('relocation-project-lifecycle 唯一导出主状态转换/校验入口', () => {
    expect(typeof lifecycle.resolveStatus).toBe('function');
    expect(lifecycle.PROJECT_STATUSES).toEqual([
      'pending_entry',
      'pending_execution',
      'executing',
      'under_repair',
      'pending_acceptance',
      'pending_invoice',
      'completed',
    ]);
  });

  it('relocation-execution 拥有批次/仪器/工作事实/物流规则，不重复定义状态转换', () => {
    expect('resolveStatus' in execution).toBe(false);
    expect(typeof execution.ExecutionService).toBe('function');
    // 通过 lifecycle 网关消费状态校验入口，而非自行定义状态枚举
    expect('PROJECT_STATUSES' in execution).toBe(false);
  });

  it('service-order-recording 拥有四类独立开单，不重复定义状态转换', () => {
    expect('resolveStatus' in serviceOrder).toBe(false);
    expect(typeof serviceOrder.ServiceOrderService).toBe('function');
    expect('ProjectWizardService' in serviceOrder).toBe(false);
  });

  it('ship-to-management 拥有 Ship-to 不可变主数据与线性申请，不触碰项目生命周期', () => {
    expect('resolveStatus' in shipTo).toBe(false);
    expect(typeof shipTo.ShipToService).toBe('function');
    expect('PROJECT_STATUSES' in shipTo).toBe(false);
  });

  it('serial-address-update 只登记逐台更新事实，不创建/修改 Ship-to', () => {
    expect('resolveStatus' in serialAddress).toBe(false);
    expect(typeof serialAddress.SerialAddressUpdateService).toBe('function');
    expect('createShipTo' in serialAddress.SerialAddressUpdateService.prototype).toBe(false);
  });

  it('damage-repair-tracking 唯一拥有维修上门 × 事项关联规则，不阻塞/不定义生命周期', () => {
    expect('resolveStatus' in damageRepair).toBe(false);
    expect('PROJECT_STATUSES' in damageRepair).toBe(false);
    expect(typeof damageRepair.DamageRepairService).toBe('function');
  });

  it('qr-request-tracking 独立申请不设状态流转、不关联仪器/项目', () => {
    expect('resolveStatus' in qrRequest).toBe(false);
    expect(typeof qrRequest.QrRequestService).toBe('function');
    expect(qrRequest.QR_REQUEST_TYPE_CODES).toHaveLength(9);
  });

  it('workbench-todos 只消费项目提醒字段，不导出状态转换', () => {
    expect('resolveStatus' in todos).toBe(false);
    expect('transition' in todos).toBe(false);
    expect(todos.DEFAULT_UPCOMING_WINDOW_DAYS).toBe(7);
    expect(typeof todos.ReminderService).toBe('function');
    expect(typeof todos.classifyReminder).toBe('function');
    // 提醒维护不触碰主状态：领域服务无任何生命周期转换入口
    const proto = Object.getPrototypeOf(todos.ReminderService.prototype) as Record<string, unknown>;
    expect('resolveStatus' in proto).toBe(false);
    expect('adjustStatus' in proto).toBe(false);
  });

  it('operational-reporting 只定义统计指标字典，不拥有业务状态', () => {
    expect('resolveStatus' in reporting).toBe(false);
    expect('PROJECT_STATUSES' in reporting).toBe(false);
    expect(reporting.REPORT_METRIC_KEYS.length).toBeGreaterThan(0);
    expect(typeof reporting.ReportingService).toBe('function');
    expect(typeof reporting.ReportingExportService).toBe('function');
    // 统计公式归属 reporting：服务提供 buildReport/getMetricDetails 只读计算，无状态写入
    const proto = Object.getPrototypeOf(reporting.ReportingService.prototype) as Record<string, unknown>;
    expect('save' in proto).toBe(false);
    expect('adjustStatus' in proto).toBe(false);
  });

  it('workbench-interface 只定义录入入口，不重复业务状态与金额校验', () => {
    expect('resolveStatus' in interfaceModule).toBe(false);
    // 快速记录九类动作（实际物流费用已并入「搬迁批次」原子创建，不设独立入口）
    expect(interfaceModule.QUICK_RECORD_ACTIONS).toHaveLength(9);
  });

  it('project-financial-closure 只消费 lifecycle 校验结果，不重新定义状态', () => {
    expect('resolveStatus' in financial).toBe(false);
    expect('PROJECT_STATUSES' in financial).toBe(false);
    expect(typeof financial.sumActiveInvoices).toBe('function');
    expect(typeof financial.FinancialClosureService).toBe('function');
  });

  it('local-data-persistence 拥有本地存储、备份与恢复能力', () => {
    expect(typeof persistence.runMigrations).toBe('function');
    expect(typeof persistence.createAutoBackupIfNeeded).toBe('function');
    expect(typeof persistence.restoreFromBackup).toBe('function');
    expect(typeof persistence.openDatabase).toBe('function');
  });

  it('historical-data-import 拥有迁移规则（ECC 聚合/dry-run/幂等/状态重建），不重复定义主状态转换', () => {
    expect('resolveStatus' in historicalImport).toBe(false);
    expect('PROJECT_STATUSES' in historicalImport).toBe(false);
    expect(typeof historicalImport.buildImportPlan).toBe('function');
    expect(typeof historicalImport.runDryRun).toBe('function');
    expect(typeof historicalImport.runImport).toBe('function');
    // 状态重建消费 lifecycle 事实推导，不在本模块重复定义状态枚举
    expect(historicalImport.rebuildStatus({ entryAt: null, executionStarted: false, actualInstallDoneAt: null, acceptanceReportDate: null, cancelledAt: null })).toBe('pending_entry');
  });
});
