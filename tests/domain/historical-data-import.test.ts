import { describe, expect, it } from 'vitest';
import {
  MAPPING_V1,
  SOURCE_TABLE_FILES,
} from '../../src/domain/capabilities/historical-data-import/mapping';
import {
  buildImportPlan,
  rebuildStatus,
  resolveImportedStatus,
} from '../../src/domain/capabilities/historical-data-import/engine';
import { buildPlanFromRows } from '../../src/domain/capabilities/historical-data-import/validation-kernel';
import { sourceRowKey } from '../../src/domain/capabilities/historical-data-import/source-model';
import {
  runDryRun,
  runImport,
  desensitizeAuditIdentity,
} from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import { localCalendarDateOf } from '../../src/domain/capabilities/local-data-persistence/business-date';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * historical-data-import 领域测试（tasks 8.x）。
 * 覆盖 spec 全部场景；sheet 路由按「文件 basename + sheet 名」，
 * 合同/项目表使用 ECC# 列别名，掉票表使用 ECC。
 */

/** 构造一行源记录。 */
function row(
  file: string,
  sheet: string,
  rowNumber: number,
  cells: Record<string, string | null>,
): SourceRow {
  return { file, sheet, rowNumber, cells };
}

const CONTRACT = SOURCE_TABLE_FILES['contract-info'];
const EXEC = SOURCE_TABLE_FILES['project-execution'];
const WORKLOAD = SOURCE_TABLE_FILES['workload-stats'];
const LOGISTICS = SOURCE_TABLE_FILES['logistics'];

describe('8.3 业务键与源行键识别（ECC 聚合主键）', () => {
  it('以 ECC 聚合导入全部执行数据：同一 ECC 下合同信息表 + 项目执行表「搬迁项目」聚合为一个搬迁项目', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-001', 客户名称: '华东医药', 合同USD含税金额: '10000' }),
      row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-001', 区域: '华东', 实际装机完成时间: '2026-08-01T10:00:00+08:00' }),
      row(EXEC, '搬迁项目', 3, { 'ECC#': 'ECC-001', 仪器名称: '色谱仪', 序列号: 'SN-1' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0].ecc).toBe('ECC-001');
    expect(plan.projects[0].customerName).toBe('华东医药');
    expect(plan.projects[0].region).toBe('华东');
    expect(plan.projects[0].sourceRows).toHaveLength(3);
  });

  it('服务单号等用于子记录识别，不与 ECC 同级匹配项目', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'SO-1', 开单类型: 'relocation', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '甲', 客户单位: '华东医药' }),
      row(WORKLOAD, '开单记录表', 3, { 服务单号: 'SO-2', 开单类型: 'pm', 开单时间: '2026-07-02T00:00:00+08:00', 工程师: '乙', 客户单位: '华北医药' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    // 服务单号用于子记录识别：两条不同服务单号各自成记录，不按 ECC 聚合项目
    expect(plan.projects).toHaveLength(0);
    expect(plan.duplicateServiceOrders).toHaveLength(0);
    expect(plan.recordCounts.service_order).toBe(2);
  });

  it('无业务键时用源行键：无法识别业务键的行以源文件+sheet+行号标识', () => {
    const r = row(EXEC, '搬迁项目', 7, { 'ECC#': 'ECC-002', 区域: '华南' });
    expect(sourceRowKey(r)).toBe(`${EXEC}#搬迁项目#7`);
    const plan = buildImportPlan([r], { mapping: MAPPING_V1 });
    expect(plan.projects[0].ecc).toBe('ECC-002');
  });

  it('项目执行表辅助 sheet「工作表1」「MRS Node」按 mapping ignored，不产生 error/conflict', () => {
    const rows: SourceRow[] = [
      row(EXEC, '工作表1', 2, { 备注: '辅助数据' }),
      row(EXEC, 'MRS Node', 2, { 备注: '辅助数据' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.errors).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.projects).toHaveLength(0);
    expect(plan.ignoredSheets.map((s) => s.sheet)).toEqual(['工作表1', 'MRS Node']);
  });
});

describe('8.4 目标必填字段缺失处理', () => {
  it('必填字段缺失输出源位置错误：源文件、sheet、物理行号、目标字段与错误码', () => {
    const rows: SourceRow[] = [
      row(EXEC, '搬迁项目', 5, { 区域: '华东' }), // 缺 ECC#
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.errors).toHaveLength(2); // ECC + 客户名称
    expect(plan.errors[0]).toMatchObject({
      errorCode: 'ECC_REQUIRED',
      fileName: EXEC,
      sheet: '搬迁项目',
      physicalRow: 5,
      field: 'contract.ecc',
    });
  });

  it('缺 ECC 报必填错误（TBD-18）：该行不导入', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 客户名称: '无ECC客户', 合同USD含税金额: '100' }),
    ];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(false);
    expect(dry.errors.some((e) => e.field === 'contract.ecc')).toBe(true);
  });

  it('物流费用申请（登记）时间为目标必填字段，缺失时 dry-run 报错（TBD-14）', () => {
    const rows: SourceRow[] = [
      row(LOGISTICS, '物流费用表', 2, { ECC: 'ECC-001', 预算价格: '1000', 成交价格: '1200', 实际物流费用: '1100' }),
    ];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(false);
    expect(dry.errors.some((e) => e.field === 'logistics_fee.applied_at')).toBe(true);
  });

  it('物流旧表只有月份/金额/物流公司时输出具体必填错误，不猜测', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '物流费用表', 2, { 月份: '2026-01', 金额: '3000', 物流公司: '样本运输公司' }),
    ];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(false);
    // 「月份」不得提升为具体申请/登记时间；旧表缺预算/成交仍各报必填；
    // 金额映射 logistics_cost（不再误报缺失）
    for (const field of [
      'logistics_fee.applied_at',
      'logistics_fee.budget_price_cents',
      'logistics_fee.deal_price_cents',
    ]) {
      expect(dry.errors.some((e) => e.field === field)).toBe(true);
    }
    expect(dry.errors.some((e) => e.field === 'logistics_fee.logistics_cost_cents')).toBe(false);
  });

  it('修正源 Excel 或补录模板后重跑：原错误消失，该行转为可导入', () => {
    const before: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 客户名称: '华东', 合同USD含税金额: '100' }),
    ];
    expect(runDryRun({ rows: before, mapping: MAPPING_V1 }).importable).toBe(false);
    const after: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-003', 客户名称: '华东', 合同USD含税金额: '100' }),
    ];
    const dry = runDryRun({ rows: after, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(true);
  });

  it('可选字段允许为空，缺失不构成错误', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-004', 客户名称: '华东' }), // 合同金额等可选字段为空
    ];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(true);
  });

  it('新增文件或模块不猜测映射：无法明确映射的进入冲突清单', () => {
    const rows: SourceRow[] = [row('新增模块.xlsx', 'S', 2, { 某列: '值' })];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.unmappableRows).toHaveLength(1);
    expect(plan.conflicts.some((c) => c.conflictCode === 'UNMAPPABLE_FILE')).toBe(true);
  });
});

describe('8.5 多来源冲突与重复服务单号不自动覆盖', () => {
  it('同一字段在多个来源取值冲突时不自动覆盖，生成冲突清单（不含 cell value）', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-005', 客户名称: '华东', 合同USD含税金额: '10000' }),
      row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-005', 客户名称: '华东', 合同金额USD: '20000' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    const conflict = plan.conflicts.find((c) => c.conflictCode === 'MULTI_SOURCE_CONFLICT');
    expect(conflict).toBeDefined();
    expect(conflict?.message).not.toContain('10000');
    expect(conflict?.message).not.toContain('20000');
    // 不自动覆盖：项目金额保持空（由负责人确认后再写入）
    expect(plan.projects[0].usdTaxAmountCents).toBeNull();
  });

  it('重复非空服务单号进入冲突清单，解决前该批次整批禁止导入（TBD-21）', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'SO-X', 开单类型: 'relocation', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '甲', 客户单位: '华东' }),
      row(WORKLOAD, '开单记录表', 3, { 服务单号: 'SO-X', 开单类型: 'pm', 开单时间: '2026-07-02T00:00:00+08:00', 工程师: '乙', 客户单位: '华北' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.duplicateServiceOrders).toHaveLength(1);
    expect(plan.conflicts.some((c) => c.conflictCode === 'DUPLICATE_SERVICE_ORDER')).toBe(true);
  });

  it('冲突解决后批次可导入：修正后重跑 dry-run 无错误', () => {
    const fixed: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'SO-A', 开单类型: 'relocation', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '甲', 客户单位: '华东' }),
      row(WORKLOAD, '开单记录表', 3, { 服务单号: 'SO-B', 开单类型: 'pm', 开单时间: '2026-07-02T00:00:00+08:00', 工程师: '乙', 客户单位: '华北' }),
    ];
    const dry = runDryRun({ rows: fixed, mapping: MAPPING_V1 });
    expect(dry.importable).toBe(true);
  });
});

describe('8.6 dry-run 只读预演（引擎实现）', () => {
  it('dry-run 不写数据并产出解析报告、冲突报告与必填缺失错误清单', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-010', 客户名称: '华东', 合同USD含税金额: '10000' }),
        row(EXEC, '搬迁项目', 2, { 区域: '华东' }), // 缺 ECC# → 错误
      ];
      const before = db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number };
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      const after = db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number };
      expect(before.n).toBe(after.n); // 零数据变更
      expect(dry.parse.files).toHaveLength(2);
      expect(dry.errors.length).toBeGreaterThan(0);
      expect(dry.importable).toBe(false);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('dry-run 报告定位必填字段缺失：源文件、sheet、物理行与字段', () => {
    const rows: SourceRow[] = [row(EXEC, '搬迁项目', 9, { 客户名称: '华东' })];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.errors[0]).toMatchObject({
      fileName: EXEC,
      sheet: '搬迁项目',
      physicalRow: 9,
      field: 'contract.ecc',
    });
  });

  it('二维码源只有类型数量无法还原具体类型时生成明确映射冲突（非全部工作量行冲突）', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '服务二维码表', 2, { 申请人: '甲', 申请时间: '2026-07-01T00:00:00+08:00', 类型数量: '3' }),
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'SO-1', 开单类型: 'relocation', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '甲', 客户单位: '华东' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    // 二维码行产生明确映射冲突；开单行正常解析、不产生冲突
    expect(plan.conflicts.filter((c) => c.conflictCode === 'QR_TYPE_COUNT_UNMAPPABLE')).toHaveLength(1);
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.recordCounts.qr_request).toBe(1);
  });
});

describe('8.7 批次事务与幂等重跑（SQLite 集成）', () => {
  it('成功批次同源重跑不重复写入（幂等键：源文件+sheet+行号+业务键）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-020', 客户名称: '华东', 合同USD含税金额: '10000' }),
      ];
      const first = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(first.importedProjectCount).toBe(1);
      const projectsAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };

      const second = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(second.importedProjectCount).toBe(0);
      expect(second.batches[0].status).toBe('skipped');
      const projectsAfterSecond = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      expect(projectsAfterSecond.n).toBe(projectsAfterFirst.n); // 不重复写入

      // 审计记录含 source_hash 与导入时间审计字段；ECC 已脱敏（Oracle 复审 #7）。
      const audit = db.prepare('SELECT * FROM migration_audit WHERE ecc = ?').all(desensitizeAuditIdentity('ECC-020')) as Record<string, unknown>[];
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].source_hash).toBeTruthy();
      expect(audit[0].imported_at).toBeTruthy();
      expect(JSON.stringify(db.prepare('SELECT * FROM migration_audit').all())).not.toContain('ECC-020');
      expect(JSON.stringify(db.prepare('SELECT * FROM migration_audit').all())).not.toContain(CONTRACT);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('批次整批事务：任一记录失败整体回滚、不产生部分数据', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-021', 客户名称: '华东', 合同USD含税金额: '10000' }),
      ];
      // 预置同 ECC 合同，使导入触发唯一约束失败 → 整批回滚
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('p-x', 'TP-X', 'pending_entry', 't', 't');
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('c-x', 'p-x', 'TP-X', 'ECC-021', 't', 't');

      const result = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      // 无部分数据：没有第二个项目/合同写入
      const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      expect(projects.n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('已提交错误数据仅 forward-fix 修正：修正源后按幂等键重跑，不重复写入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const wrong: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-022', 客户名称: '华东', 合同USD含税金额: '10000' }),
      ];
      runImport(db, { rows: wrong, mapping: MAPPING_V1 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);

      // 修正源数据（金额变更），同源重跑 → forward-fix 更新
      const fixed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-022', 客户名称: '华东', 合同USD含税金额: '20000' }),
      ];
      const result = runImport(db, { rows: fixed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('success');
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1); // 不重复写入
      const contract = db.prepare('SELECT usd_tax_amount_cents FROM contracts WHERE ecc = ?').get('ECC-022') as { usd_tax_amount_cents: number | string };
      expect(String(contract.usd_tax_amount_cents)).toBe('2000000'); // 修正生效（20000 元 = 2000000 分）
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('8.8 确定性状态重建', () => {
  it('状态决策复用 lifecycle：验收事实优先于执行事实', () => {
    expect(resolveImportedStatus({
      entryAt: '2026-07-01', executionStarted: true,
      actualInstallDoneAt: '2026-07-10', acceptanceReportDate: '2026-07-15', cancelledAt: null,
    })).toMatchObject({ ok: true, status: 'pending_invoice', reason: 'auto_acceptance' });
  });

  it('维修中（under_repair）不被任何导入事实覆盖（含已取消）', () => {
    // 已取消事实：仍保持维修中
    const cancelled = resolveImportedStatus({
      entryAt: '2026-07-01', executionStarted: true,
      actualInstallDoneAt: '2026-07-10', acceptanceReportDate: '2026-07-15', cancelledAt: '2026-07-20',
    }, 'under_repair');
    expect(cancelled).toMatchObject({ ok: true, status: 'under_repair', reason: 'unchanged' });

    // 执行/验收/装机等前进事实：仍保持维修中
    const advanced = resolveImportedStatus({
      entryAt: '2026-07-01', executionStarted: true,
      actualInstallDoneAt: '2026-07-10', acceptanceReportDate: '2026-07-15', cancelledAt: null,
    }, 'under_repair');
    expect(advanced).toMatchObject({ ok: true, status: 'under_repair', reason: 'unchanged' });

    // 无任何事实：仍保持维修中
    const plain = resolveImportedStatus({
      entryAt: null, executionStarted: false,
      actualInstallDoneAt: null, acceptanceReportDate: null, cancelledAt: null,
    }, 'under_repair');
    expect(plain).toMatchObject({ ok: true, status: 'under_repair', reason: 'unchanged' });
  });

  it('导入状态真实变化与项目写入同事务记录最小转换审计', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-IMPORT-STATUS', 客户名称: '导入状态客户', 进单时间: '2026-07-01T00:00:00+08:00' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-IMPORT-STATUS', 客户单位名称: '导入状态客户', 仪器名称: '状态仪器', 序列号: 'STATUS-SN', 验收报告形成日期: '2026-07-15T00:00:00+08:00' }),
      ];
      expect(runDryRun({ rows, mapping: MAPPING_V1 }).errors).toEqual([]);
      runImport(db, { rows, mapping: MAPPING_V1 });
      expect(db.prepare('SELECT status FROM projects').get()).toMatchObject({ status: 'pending_invoice' });
      expect(db.prepare('SELECT from_status, to_status, reason, source FROM project_status_transition_audit').get())
        .toEqual({ from_status: 'pending_entry', to_status: 'pending_invoice', reason: 'auto_acceptance', source: 'import' });
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('forward-fix 以真实已取消状态进入 lifecycle，不恢复终态也不追加伪转换审计', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-CANCELLED', 客户名称: '终态客户', 合同USD含税金额: '100' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-FIX-CANCELLED', 客户单位名称: '终态客户', 取消时间: '2026-07-15T00:00:00+08:00' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      const auditsBefore = (db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n;
      const corrected = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-CANCELLED', 客户名称: '终态客户', 合同USD含税金额: '200' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-FIX-CANCELLED', 客户单位名称: '终态客户' }),
      ];
      runImport(db, { rows: corrected, mapping: MAPPING_V1 });
      expect(db.prepare('SELECT status, cancelled_at FROM projects').get()).toMatchObject({ status: 'cancelled' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n).toBe(auditsBefore);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('forward-fix 新增取消事实：真实 pending_execution 经 lifecycle 进入 cancelled 并审计', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const base = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-NEW-CANCEL', 客户名称: '新增取消客户', 进单时间: '2026-07-01T00:00:00+08:00' }),
      ];
      runImport(db, { rows: base, mapping: MAPPING_V1 });
      const before = (db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n;
      runImport(db, {
        rows: [...base, row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-FIX-NEW-CANCEL', 客户单位名称: '新增取消客户', 取消时间: '2026-07-15T00:00:00+08:00' })],
        mapping: MAPPING_V1,
      });
      expect(db.prepare('SELECT status FROM projects').get()).toMatchObject({ status: 'cancelled' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n).toBe(before + 1);
      expect(db.prepare(
        "SELECT from_status, to_status, reason FROM project_status_transition_audit WHERE from_status='pending_execution' AND to_status='cancelled'",
      ).get()).toEqual({ from_status: 'pending_execution', to_status: 'cancelled', reason: 'cancel' });
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('forward-fix 补进单日期：真实 pending_entry 经 lifecycle 进入 pending_execution 并审计', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const base = [row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-ENTRY', 客户名称: '补进单客户' })];
      runImport(db, { rows: base, mapping: MAPPING_V1 });
      const before = (db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n;
      runImport(db, {
        rows: [row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-ENTRY', 客户名称: '补进单客户', 进单时间: '2026-07-01T00:00:00+08:00' })],
        mapping: MAPPING_V1,
      });
      expect(db.prepare('SELECT status FROM projects').get()).toMatchObject({ status: 'pending_execution' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n).toBe(before + 1);
      expect(db.prepare(
        "SELECT from_status, to_status, reason FROM project_status_transition_audit WHERE from_status='pending_entry' AND to_status='pending_execution'",
      ).get()).toEqual({ from_status: 'pending_entry', to_status: 'pending_execution', reason: 'manual' });
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('forward-fix 不倒退 pending_invoice，并在新验收事实时记录 lifecycle 的真实 from/to/reason', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const base = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-LIFECYCLE', 客户名称: '审计客户', 进单时间: '2026-07-01T00:00:00+08:00' }),
      ];
      runImport(db, { rows: base, mapping: MAPPING_V1 });
      const auditsBeforeAcceptance = (db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n;
      const withAcceptance = [
        ...base,
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'ECC-FIX-LIFECYCLE', 客户单位名称: '审计客户', 验收报告形成日期: '2026-07-15T00:00:00+08:00' }),
      ];
      runImport(db, { rows: withAcceptance, mapping: MAPPING_V1 });
      expect(db.prepare('SELECT status FROM projects').get()).toMatchObject({ status: 'pending_invoice' });
      const acceptanceAudits = db.prepare(
        `SELECT from_status, to_status, reason FROM project_status_transition_audit
         WHERE from_status = 'pending_execution' AND to_status = 'pending_invoice' AND reason = 'auto_acceptance'`,
      ).all();
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n)
        .toBe(auditsBeforeAcceptance + 1);
      expect(acceptanceAudits).toEqual([
        { from_status: 'pending_execution', to_status: 'pending_invoice', reason: 'auto_acceptance' },
      ]);

      const corrected = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-FIX-LIFECYCLE', 客户名称: '审计客户', 进单时间: '2026-07-01T00:00:00+08:00', 合同USD含税金额: '200' }),
      ];
      runImport(db, { rows: corrected, mapping: MAPPING_V1 });
      expect(db.prepare('SELECT status FROM projects').get()).toMatchObject({ status: 'pending_invoice' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM project_status_transition_audit').get() as { n: number }).n)
        .toBe(auditsBeforeAcceptance + 1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('项目状态由事实推导重建，缺失事实不产生猜测状态', () => {
    expect(rebuildStatus({ entryAt: null, executionStarted: false, actualInstallDoneAt: null, acceptanceReportDate: null, cancelledAt: null })).toBe('pending_entry');
    expect(rebuildStatus({ entryAt: '2026-07-01T00:00:00+08:00', executionStarted: false, actualInstallDoneAt: null, acceptanceReportDate: null, cancelledAt: null })).toBe('pending_execution');
    expect(rebuildStatus({ entryAt: '2026-07-01T00:00:00+08:00', executionStarted: true, actualInstallDoneAt: null, acceptanceReportDate: null, cancelledAt: null })).toBe('executing');
    expect(rebuildStatus({ entryAt: '2026-07-01T00:00:00+08:00', executionStarted: true, actualInstallDoneAt: '2026-07-10T00:00:00+08:00', acceptanceReportDate: null, cancelledAt: null })).toBe('pending_acceptance');
    expect(rebuildStatus({ entryAt: '2026-07-01T00:00:00+08:00', executionStarted: true, actualInstallDoneAt: '2026-07-10T00:00:00+08:00', acceptanceReportDate: '2026-07-15', cancelledAt: null })).toBe('pending_invoice');
    expect(rebuildStatus({ entryAt: '2026-07-01T00:00:00+08:00', executionStarted: true, actualInstallDoneAt: '2026-07-10T00:00:00+08:00', acceptanceReportDate: '2026-07-15', cancelledAt: '2026-07-20T00:00:00+08:00' })).toBe('cancelled');
  });
});

describe('8.9 源业务时间保留（导入时间只作审计字段）', () => {
  it('源业务时间（进单时间）映射到业务字段，不替代为导入时间', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-030', 客户名称: '华东', 进单时间: '2026-05-01T00:00:00+08:00' }),
      ];
      runImport(db, { rows, mapping: MAPPING_V1 });
      const project = db.prepare('SELECT entry_at FROM projects WHERE temp_no = ?').get('MIG-ECC-030') as { entry_at: string };
      // 业务日期化（design D30）：源进单时间按冻结本机 IANA 时区转为业务日期 yyyy-mm-dd；
      // 导入时间只作审计字段，绝不替代源业务日期。
      expect(project.entry_at).toBe(localCalendarDateOf(new Date('2026-05-01T00:00:00+08:00')));
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('源业务时间缺失（可选）时保留为空，不用导入时间填充', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'ECC-031', 客户名称: '华东' }),
      ];
      runImport(db, { rows, mapping: MAPPING_V1 });
      const project = db.prepare('SELECT entry_at FROM projects WHERE temp_no = ?').get('MIG-ECC-031') as { entry_at: string | null };
      expect(project.entry_at).toBeNull();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('必填业务时间（物流费用申请/登记时间）缺失由 dry-run 报错且该行不导入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(LOGISTICS, '物流费用表', 2, { ECC: 'ECC-032', 预算价格: '1000', 成交价格: '1200', 实际物流费用: '1100' }),
      ];
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      expect(dry.importable).toBe(false);
      expect(() => runImport(db, { rows, mapping: MAPPING_V1 })).toThrow(/dry-run 必须无任何错误/);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('回归 fixture：真实 workbook 路由与列别名', () => {
  const DIR = '/data/存量迁移/2026';
  const WDIR = '/data/存量迁移\\2026'; // Windows 分隔符

  it('sources 传绝对/相对带目录路径均正确路由（兼容 posix/Windows 分隔符与 Unicode）', () => {
    const rows: SourceRow[] = [
      row(`${DIR}/${CONTRACT}`, '合同信息', 2, { 'ECC#': 'E-1', 客户名称: '甲' }),
      row(`${WDIR}\\${EXEC}`, '搬迁项目', 2, { 'ECC#': 'E-1', 客户名称: '甲' }),
      row(`${DIR}/${WORKLOAD}`, '开单记录表', 2, { 服务单号: 'S-1', 开单类型: 'pm', 开单时间: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.projects).toHaveLength(1);
    expect(plan.errors).toHaveLength(0);
    expect(plan.unmappableRows).toHaveLength(0);
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.ignoredSheets).toHaveLength(0);
  });

  it('客户名称列别名：合同信息表 Account name、项目执行 客户单位名称 均映射 contract.customer_name', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-2', 'Account name': '华东医药' }),
      row(EXEC, '搬迁项目', 2, { 'ECC#': 'E-2', 客户单位名称: '华东医药' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.errors).toHaveLength(0);
    expect(plan.projects[0].customerName).toBe('华东医药');
  });

  it('工作量统计 6 个已知 sheet 按各 role 解析（不 ignored）；ignored 仅项目执行辅助 sheet', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'S-1', 开单类型: 'relocation', 开单时间: '2026-01-01T00:00:00+08:00', 工程师: '工甲', 客户单位: '甲' }),
      row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-1', 掉票金额: '100', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      row(WORKLOAD, '物流费用表', 2, { 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '100', 成交价格: '90', 实际物流费用: '88' }),
      row(WORKLOAD, '搬迁地址信息表', 2, { 客户名称: '甲', 新址地址: '址A', 序列号: 'SN-1', 'Account ID': 'ACC-1', 更新时间: '2026-01-06T00:00:00+08:00' }),
      row(WORKLOAD, '服务二维码表', 2, { 申请人: '甲', 申请时间: '2026-01-07T00:00:00+08:00', 申请类型: 'A' }),
      row(WORKLOAD, 'Ship-to申请', 2, { 客户名称: '甲', 新址地址: '址B' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.ignoredSheets).toHaveLength(0);
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.recordCounts.invoice).toBe(1);
    expect(plan.recordCounts.logistics_fee).toBe(1);
    expect(plan.recordCounts.serial_address_update).toBe(1);
    expect(plan.recordCounts.qr_request).toBe(1);
    expect(plan.recordCounts.ship_to_request).toBe(1);
  });

  it('errors/conflicts 仅出现真实不完整映射（物流必填、QR 类型数量）；开单/掉票/地址更新/Ship-to 明确映射不误报', () => {
    const rows: SourceRow[] = [
      // 物流旧表：只有月份/金额/物流公司 → 具体必填错误（不猜测；金额映射 logistics_cost）
      row(WORKLOAD, '物流费用表', 2, { 月份: '2026-01', 金额: '100', 物流公司: '某运输' }),
      // 二维码：只有类型数量 → 明确映射冲突（requested_at 由「日期」映射，不误报）
      row(WORKLOAD, '服务二维码表', 2, { 申请人: '甲', 日期: '2026-01-07T00:00:00+08:00', 类型数量: '3' }),
      // 明确可映射：开单 / 掉票 / 地址更新 / Ship-to 不误报
      row(WORKLOAD, '开单记录表', 2, { 单号: 'S-1', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
      row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-1', '金额（USD）': '100', 掉票时间: '2026-02-01T00:00:00+08:00', 区域: '华东', 客户名称: '甲' }),
      row(WORKLOAD, '搬迁地址信息表', 2, { 单位名称: '甲', 新址地址: '址A', 序列号: 'SN-1', 'Account ID': 'ACC-1', 更新日期: '2026-01-06T00:00:00+08:00' }),
      row(WORKLOAD, '搬迁地址信息表（原表无，待新增项）', 2, { 客户单位名称: '甲', 日期: '2026-01-08T00:00:00+08:00', 'Account ID': 'ACC-2' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    // 物流必填 3 个具体字段错误（applied_at/budget/deal；logistics_cost 由金额映射不报缺）
    expect(
      plan.errors.filter((e) => e.field.startsWith('logistics_fee.')),
    ).toHaveLength(3);
    expect(plan.errors.some((e) => e.field === 'logistics_fee.logistics_cost_cents')).toBe(false);
    // QR 类型数量明确冲突仅 1 条（requested_at 不误报）
    expect(
      plan.conflicts.filter((c) => c.conflictCode === 'QR_TYPE_COUNT_UNMAPPABLE'),
    ).toHaveLength(1);
    expect(plan.errors.some((e) => e.field === 'qr_request.requested_at')).toBe(false);
    // 开单/掉票/地址更新不产生错误；Ship-to（待新增项，缺新址地址）仅报新址必填
    expect(
      plan.errors.some((e) => e.field.startsWith('service_order.') || e.field.startsWith('invoice.') || e.field.startsWith('serial_address_update.')),
    ).toBe(false);
    expect(
      plan.errors.filter((e) => e.field === 'ship_to_request.new_site_address'),
    ).toHaveLength(1);
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.recordCounts.invoice).toBe(1);
    expect(plan.recordCounts.serial_address_update).toBe(1);
    expect(plan.recordCounts.ship_to_request).toBe(1);
    // 错误/冲突不含 cell value
    for (const e of plan.errors) {
      expect(JSON.stringify(e)).not.toContain('100');
      expect(JSON.stringify(e)).not.toContain('某运输');
    }
  });

  it('已知 sheet 与未知 sheet 共存：未知仅 1 条冲突且不阻断同文件其他 sheet 解析', () => {
    const rows: SourceRow[] = [
      // 未知 sheet（同一文件内，未配置）
      row(WORKLOAD, '未知统计表', 2, { 某列: 'x' }),
      row(WORKLOAD, '未知统计表', 3, { 某列: 'y' }),
      // 已知 sheet「开单记录表」正常解析
      row(WORKLOAD, '开单记录表', 2, { 服务单号: 'S-1', 开单类型: 'pm', 开单时间: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
      row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-1', 掉票金额: '100', 掉票时间: '2026-02-01T00:00:00+08:00' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    // 未知 sheet：仅 1 条 UNMAPPABLE_FILE 冲突（按 文件+sheet 去重），不阻塞其他 sheet
    expect(plan.conflicts.filter((c) => c.conflictCode === 'UNMAPPABLE_FILE')).toHaveLength(1);
    // 已知 sheet 仍全部解析
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.recordCounts.invoice).toBe(1);
    expect(plan.unmappableRows).toHaveLength(2);
  });

  it('MULTI_SOURCE_CONFLICT 必须给出具体 target field（非空）且不含 value', () => {
    const rows: SourceRow[] = [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-9', 'Account name': '甲', 合同USD含税金额: '100' }),
      row(EXEC, '搬迁项目', 2, { 'ECC#': 'E-9', 客户单位名称: '乙', 合同金额USD: '200' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    const multi = plan.conflicts.filter((c) => c.conflictCode === 'MULTI_SOURCE_CONFLICT');
    expect(multi.length).toBeGreaterThan(0);
    for (const c of multi) {
      expect(c.field).toBeTruthy(); // field 非空
      expect(JSON.stringify(c)).not.toContain('甲');
      expect(JSON.stringify(c)).not.toContain('100');
    }
  });

  it('实际表头逐字段映射：各 sheet 使用真实中文表头不误报，仅保留真正缺失', () => {
    const rows: SourceRow[] = [
      // 开单记录表：日期/单号/类型/工程师/客户单位/备注 → 全部映射，无错误
      row(WORKLOAD, '开单记录表', 2, { 日期: '2026-01-01T00:00:00+08:00', 单号: 'SO-1', 类型: 'relocation', 工程师: '工甲', 客户单位: '甲', 备注: '备' }),
      // 掉票记录表：掉票时间/ECC/区域/客户名称/金额（USD）→ 全部映射
      row(WORKLOAD, '掉票记录表', 2, { 掉票时间: '2026-02-01T00:00:00+08:00', ECC: 'E-1', 区域: '华东', 客户名称: '甲', '金额（USD）': '100' }),
      // 物流费用表：月份/金额/物流公司 → applied_at/budget/deal 必填错误，logistics_cost 由金额映射
      row(WORKLOAD, '物流费用表', 2, { 月份: '2026-01', 金额: '300', 物流公司: '某运输' }),
      // 搬迁地址信息表：单位名称/新址地址/序列号/Account ID/更新日期 → 全部映射
      row(WORKLOAD, '搬迁地址信息表', 2, { 单位名称: '甲', 新址地址: '址A', 序列号: 'SN-1', 'Account ID': 'ACC-1', 更新日期: '2026-01-06T00:00:00+08:00' }),
      // 服务二维码表：日期/申请人/类型数量 → QR 类型数量冲突，requested_at 不误报
      row(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 类型数量: '3' }),
      // 搬迁地址信息表（原表无，待新增项）：日期/客户单位名称/Account ID → 缺新址必填，不误报其他
      row(WORKLOAD, '搬迁地址信息表（原表无，待新增项）', 2, { 日期: '2026-01-08T00:00:00+08:00', 客户单位名称: '甲', 'Account ID': 'ACC-2' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    // 开单/掉票/地址更新：无错误
    expect(plan.errors.some((e) => e.field.startsWith('service_order.'))).toBe(false);
    expect(plan.errors.some((e) => e.field.startsWith('invoice.'))).toBe(false);
    expect(plan.errors.some((e) => e.field.startsWith('serial_address_update.'))).toBe(false);
    // 物流：仅 applied_at/budget/deal 必填（月份不得提升为日期；logistics_cost 由金额映射）
    const logisticsErrors = plan.errors.filter((e) => e.field.startsWith('logistics_fee.'));
    expect(logisticsErrors.map((e) => e.field).sort()).toEqual([
      'logistics_fee.applied_at',
      'logistics_fee.budget_price_cents',
      'logistics_fee.deal_price_cents',
    ]);
    // QR：requested_at 不误报，仅类型数量冲突
    expect(plan.errors.some((e) => e.field === 'qr_request.requested_at')).toBe(false);
    expect(plan.conflicts.filter((c) => c.conflictCode === 'QR_TYPE_COUNT_UNMAPPABLE')).toHaveLength(1);
    // Ship-to（待新增项）：仅缺新址必填，其余字段映射不误报
    expect(plan.errors.filter((e) => e.field === 'ship_to_request.new_site_address')).toHaveLength(1);
    expect(plan.errors.some((e) => e.field === 'ship_to_request.customer_name')).toBe(false);
    // 错误/冲突不含 cell value
    for (const e of plan.errors) {
      expect(JSON.stringify(e)).not.toContain('某运输');
      expect(JSON.stringify(e)).not.toContain('300');
    }
    // recordCounts 各角色正确
    expect(plan.recordCounts.service_order).toBe(1);
    expect(plan.recordCounts.invoice).toBe(1);
    expect(plan.recordCounts.logistics_fee).toBe(1);
    expect(plan.recordCounts.serial_address_update).toBe(1);
    expect(plan.recordCounts.qr_request).toBe(1);
    expect(plan.recordCounts.ship_to_request).toBe(1);
  });

  it('重复非空服务单号冲突：按 service_order_no（含 单号 别名）识别并进入冲突清单', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 单号: 'SO-DUP', 类型: 'relocation', 日期: '2026-01-01T00:00:00+08:00', 工程师: '甲', 客户单位: '甲' }),
      row(WORKLOAD, '开单记录表', 3, { 单号: 'SO-DUP', 类型: 'pm', 日期: '2026-01-02T00:00:00+08:00', 工程师: '乙', 客户单位: '乙' }),
    ];
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.duplicateServiceOrders).toHaveLength(1);
    expect(plan.duplicateServiceOrders[0].serviceOrderNo).toBe('SO-DUP');
    const conflict = plan.conflicts.find((c) => c.conflictCode === 'DUPLICATE_SERVICE_ORDER');
    expect(conflict?.field).toBe('service_order.service_order_no');
    expect(JSON.stringify(conflict)).not.toContain('SO-DUP');
  });
});

describe('v20 工程师可空导入（缺失/空白统一 null、重跑/forward-fix 快照回归）', () => {
  it('历史导入链路缺失/空白工程师统一归一为 null 且 dry-run 仍可导入', () => {
    const missing: SourceRow[] = [row(WORKLOAD, '开单记录表', 2, { 服务单号: 'SO-NULL-1', 开单类型: 'pm', 开单时间: '2026-07-01T00:00:00+08:00', 客户单位: '甲' })];
    const blank: SourceRow[] = [row(WORKLOAD, '开单记录表', 3, { 服务单号: 'SO-NULL-2', 开单类型: 'pm', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '   ', 客户单位: '甲' })];
    const withVal: SourceRow[] = [row(WORKLOAD, '开单记录表', 4, { 服务单号: 'SO-VAL', 开单类型: 'pm', 开单时间: '2026-07-01T00:00:00+08:00', 工程师: '工甲', 客户单位: '甲' })];
    const planMissing = buildImportPlan(missing, { mapping: MAPPING_V1 });
    const planBlank = buildImportPlan(blank, { mapping: MAPPING_V1 });
    const planVal = buildImportPlan(withVal, { mapping: MAPPING_V1 });
    expect(planMissing.errors).toHaveLength(0);
    expect(planBlank.errors).toHaveLength(0);
    expect(planMissing.serviceOrders[0].engineer).toBeNull();
    expect(planBlank.serviceOrders[0].engineer).toBeNull();
    expect(planVal.serviceOrders[0].engineer).toBe('工甲');
    expect(runDryRun({ rows: missing, mapping: MAPPING_V1 }).importable).toBe(true);
    expect(runDryRun({ rows: blank, mapping: MAPPING_V1 }).importable).toBe(true);
  });

  it('缺失/空白导入落库为 NULL，重跑幂等跳过，forward-fix 快照一致', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const workload = WORKLOAD;
      const initial: SourceRow[] = [row(workload, '开单记录表', 2, { 单号: 'SO-IMP-NULL', 类型: 'pm', 日期: '2026-08-10T00:00:00+08:00', 客户单位: '导入客户' })];
      const first = runImport(db, { rows: initial, mapping: MAPPING_V1 });
      expect(first.batches[0].status).toBe('success');
      const row1 = db.prepare('SELECT engineer, import_source_hash FROM service_orders WHERE service_order_no=?').get('SO-IMP-NULL') as { engineer: string | null };
      expect(row1.engineer).toBeNull();
      // 空白归一后与缺失同为 null：重跑空白应成功（源 hash 变化但目标快照相同，归一后无冲突）
      const blank: SourceRow[] = [row(workload, '开单记录表', 2, { 单号: 'SO-IMP-NULL', 类型: 'pm', 日期: '2026-08-10T00:00:00+08:00', 工程师: '   ', 客户单位: '导入客户' })];
      const second = runImport(db, { rows: blank, mapping: MAPPING_V1 });
      expect(['success', 'skipped']).toContain(second.batches[0].status);
      expect((db.prepare('SELECT engineer FROM service_orders WHERE service_order_no=?').get('SO-IMP-NULL') as { engineer: string | null }).engineer).toBeNull();
      // forward-fix：补充工程师后快照刷新
      const withEngineer: SourceRow[] = [row(workload, '开单记录表', 2, { 单号: 'SO-IMP-NULL', 类型: 'pm', 日期: '2026-08-10T00:00:00+08:00', 工程师: '补录工', 客户单位: '导入客户' })];
      const third = runImport(db, { rows: withEngineer, mapping: MAPPING_V1 });
      expect(third.batches[0].status).toBe('success');
      expect((db.prepare('SELECT engineer FROM service_orders WHERE service_order_no=?').get('SO-IMP-NULL') as { engineer: string | null }).engineer).toBe('补录工');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('向导内核 NormalizedRow 缺失/空白工程师统一归一为 null', () => {
    const missing = buildPlanFromRows([
      { category: 'service_order', rowId: 'r1', sourceRowId: null, businessKey: 'SO-K-1', sourceKind: 'file', sourceFile: 'f.xlsx', sourceSheet: 's', sourceRow: 2, pasteBatch: null, cells: { 'service_order.service_order_no': 'SO-K-1', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-07-01', 'service_order.customer_name': '甲' }, positionOnlyIdentity: false },
    ]);
    const blank = buildPlanFromRows([
      { category: 'service_order', rowId: 'r2', sourceRowId: null, businessKey: 'SO-K-2', sourceKind: 'file', sourceFile: 'f.xlsx', sourceSheet: 's', sourceRow: 3, pasteBatch: null, cells: { 'service_order.service_order_no': 'SO-K-2', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-07-01', 'service_order.engineer': '   ', 'service_order.customer_name': '甲' }, positionOnlyIdentity: false },
    ]);
    const withVal = buildPlanFromRows([
      { category: 'service_order', rowId: 'r3', sourceRowId: null, businessKey: 'SO-K-3', sourceKind: 'file', sourceFile: 'f.xlsx', sourceSheet: 's', sourceRow: 4, pasteBatch: null, cells: { 'service_order.service_order_no': 'SO-K-3', 'service_order.order_type': 'pm', 'service_order.ordered_at': '2026-07-01', 'service_order.engineer': '工甲', 'service_order.customer_name': '甲' }, positionOnlyIdentity: false },
    ]);
    expect(missing.serviceOrders[0].engineer).toBeNull();
    expect(blank.serviceOrders[0].engineer).toBeNull();
    expect(withVal.serviceOrders[0].engineer).toBe('工甲');
  });
});
