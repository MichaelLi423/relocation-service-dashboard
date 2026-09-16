import { describe, expect, it } from 'vitest';
import { MAPPING_V1, SOURCE_TABLE_FILES } from '../../src/domain/capabilities/historical-data-import/mapping';
import { buildImportPlan } from '../../src/domain/capabilities/historical-data-import/engine';
import { runDryRun, runImport } from '../../src/domain/capabilities/historical-data-import/migration-service';
import type { SourceRow } from '../../src/domain/capabilities/historical-data-import/source-model';
import { bootstrapDatabase } from '../../src/domain/capabilities/local-data-persistence/bootstrap';
import { closeDatabase } from '../../src/domain/capabilities/local-data-persistence/connection';
import {
  SqliteContractRepository,
  SqliteProjectRepository,
} from '../../src/domain/capabilities/local-data-persistence/repositories';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle/project-service';
import { cleanupTempDir, makeTempDir } from '../helpers/tmp-db';

/**
 * Oracle 高风险 2/3/4 修正测试（historical-data-import 专属写入）。
 * - 高风险 2：dry-run importable = errors=0 且 conflicts=0；runImport 重新校验两者，
 *   冲突未解决绝不写入；源摘要绑定（源变化拒绝）。
 * - 高风险 3：强类型 ImportPlan 携带并落库全部已支持记录；被计数但未写入 → 导入失败。
 * - 高风险 4：forward-fix 只更新同 source key 的迁移记录，人工数据永不改删；
 *   无法安全 upsert 时报告阻塞而非删除。
 */

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

describe('Oracle 高风险 2：dry-run importable = errors=0 且 conflicts=0；冲突绝不写入', () => {
  it('dry-run 存在冲突时 importable=false（errors=0 但 conflicts>0）', () => {
    const rows: SourceRow[] = [
      row(WORKLOAD, '开单记录表', 2, { 单号: 'SO-DUP', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '甲', 客户单位: '甲' }),
      row(WORKLOAD, '开单记录表', 3, { 单号: 'SO-DUP', 类型: 'relocation', 日期: '2026-01-02T00:00:00+08:00', 工程师: '乙', 客户单位: '乙' }),
    ];
    const dry = runDryRun({ rows, mapping: MAPPING_V1 });
    expect(dry.errors.length).toBe(0);
    expect(dry.conflicts.length).toBeGreaterThan(0);
    expect(dry.importable).toBe(false);
  });

  it('冲突未解决时 runImport 拒绝写入（零数据变更）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(WORKLOAD, '开单记录表', 2, { 单号: 'SO-DUP', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '甲', 客户单位: '甲' }),
        row(WORKLOAD, '开单记录表', 3, { 单号: 'SO-DUP', 类型: 'relocation', 日期: '2026-01-02T00:00:00+08:00', 工程师: '乙', 客户单位: '乙' }),
      ];
      const before = db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number };
      expect(() => runImport(db, { rows, mapping: MAPPING_V1 })).toThrow(/无任何错误且无冲突/);
      const after = db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number };
      expect(after.n).toBe(before.n); // 零数据变更
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('源摘要绑定：dry-run 后源文件变化 → runImport 拒绝导入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const original: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-DIG-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      const dry = runDryRun({ rows: original, mapping: MAPPING_V1 });
      expect(dry.importable).toBe(true);

      // 源变化（金额改了）
      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-DIG-1', 'Account name': '甲', 合同USD含税金额: '200' }),
      ];
      expect(() =>
        runImport(db, { rows: changed, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest }),
      ).toThrow(/源内容摘要不一致/);
      const projects = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      expect(projects.n).toBe(0); // 未写入
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('源摘要一致时 runImport 正常写入', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-DIG-2', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      const result = runImport(db, { rows, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest });
      expect(result.importedProjectCount).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle 高风险 3：强类型 ImportPlan 携带并落库全部已支持记录', () => {
  function allRolesRows(): SourceRow[] {
    return [
      row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-ALL-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      row(EXEC, '搬迁项目', 2, { 'ECC#': 'E-ALL-1', 客户单位名称: '甲' }),
      row(WORKLOAD, '开单记录表', 2, { 单号: 'SO-ALL-1', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
      row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-ALL-1', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      row(WORKLOAD, '物流费用表', 2, { ECC: 'E-ALL-1', 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30', 物流公司: '某运输' }),
      row(WORKLOAD, '搬迁地址信息表', 2, { 单位名称: '甲', 新址地址: '址A', 序列号: 'SN-1', 'Account ID': 'ACC-1', 更新日期: '2026-01-06T00:00:00+08:00' }),
      row(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 申请类型: 'A' }),
      row(WORKLOAD, 'Ship-to申请', 2, { 客户名称: '甲', 新址地址: '址B' }),
    ];
  }

  it('dry-run 报告各角色 recordCounts 与强类型 plan 记录一致', () => {
    const rows = allRolesRows();
    const plan = buildImportPlan(rows, { mapping: MAPPING_V1 });
    expect(plan.errors).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.projects).toHaveLength(1);
    expect(plan.serviceOrders).toHaveLength(1);
    expect(plan.invoices).toHaveLength(1);
    expect(plan.logisticsFees).toHaveLength(1);
    expect(plan.serialAddressUpdates).toHaveLength(1);
    expect(plan.qrRequests).toHaveLength(1);
    expect(plan.shipToRequests).toHaveLength(1);
    // 每个强类型记录都有 import_source_key / source_hash
    const all = [
      ...plan.projects,
      ...plan.serviceOrders,
      ...plan.invoices,
      ...plan.logisticsFees,
      ...plan.serialAddressUpdates,
      ...plan.qrRequests,
      ...plan.shipToRequests,
    ];
    for (const r of all) {
      expect(r.importSourceKey).toBeTruthy();
      expect(r.sourceHash).toBeTruthy();
    }
  });

  it('全部角色落库：project/contract/customer、service_order、invoice、logistics_fee、serial_address_update、qr_request、ship_to_request', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows = allRolesRows();
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      expect(dry.importable).toBe(true);
      const result = runImport(db, { rows, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest });
      expect(result.batches.every((b) => b.status === 'success')).toBe(true);
      expect(result.writtenCounts).toMatchObject({
        project: 1,
        service_order: 1,
        invoice: 1,
        logistics_fee: 1,
        serial_address_update: 1,
        qr_request: 1,
        ship_to_request: 1,
      });
      // 各目标表实际有数据
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM logistics_fees').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM serial_address_updates').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM qr_requests').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM ship_to_requests').get() as { n: number }).n).toBe(1);
      // 迁移来源列已持久化
      for (const table of ['projects', 'contracts', 'service_orders', 'invoices', 'logistics_fees', 'serial_address_updates', 'qr_requests', 'ship_to_requests']) {
        const cnt = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE import_source_key IS NOT NULL`).get() as { n: number };
        expect(cnt.n).toBeGreaterThan(0);
      }
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('只有子记录输入（无项目）不能成功空导：子记录必须落库或失败', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 只有开单记录，无任何项目输入 → 必须实际落库（不能空导成功）
      const rows: SourceRow[] = [
        row(WORKLOAD, '开单记录表', 2, { 单号: 'SO-ONLY', 类型: 'pm', 日期: '2026-01-01T00:00:00+08:00', 工程师: '工', 客户单位: '甲' }),
      ];
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      expect(dry.importable).toBe(true);
      const result = runImport(db, { rows, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest });
      expect(result.writtenCounts.service_order).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM service_orders').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('源文件非空但无可写入记录时导入失败（不能成功空导）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 只有供应商参考行（无目标表）：recordCounts 为空 → 空导保护拒绝
      const rows: SourceRow[] = [
        {
          file: SOURCE_TABLE_FILES['supplier'],
          sheet: '供应商',
          rowNumber: 2,
          cells: { 运输公司: '某运输' },
        },
      ];
      const dry = runDryRun({ rows, mapping: MAPPING_V1 });
      // 供应商参考不产生目标记录，dry-run 仍可解析（无错误/冲突）但不代表可空导
      expect(() => runImport(db, { rows, mapping: MAPPING_V1, expectedSourceDigest: dry.sourceDigest })).toThrow(/没有任何记录被成功写入/);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle 高风险 4：forward-fix 只更新迁移记录，人工数据永不改删', () => {
  it('forward-fix 更新同 source key 迁移记录，人工后续数据保留', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const wrong: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-FF-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      runImport(db, { rows: wrong, mapping: MAPPING_V1 });

      // 人工在迁移后登记一笔掉票（无 import_source_key）——必须保留
      const projectId = (db.prepare('SELECT id FROM projects WHERE import_source_key = ?').get('project|E-FF-1') as { id: string }).id;
      db.prepare(
        `INSERT INTO invoices (id, project_id, amount_cents, invoiced_at, last_modified_at, created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run('manual-invoice-1', projectId, '5000', '2026-07-01T00:00:00+08:00', 't', 't');

      // forward-fix：金额修正后同 source key 重跑 → 只更新迁移合同，人工掉票保留
      const fixed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-FF-1', 'Account name': '甲', 合同USD含税金额: '200' }),
      ];
      const result = runImport(db, { rows: fixed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('success');
      // 项目数不变（未删除重建）
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      // 迁移合同金额已修正
      const contract = db.prepare('SELECT usd_tax_amount_cents FROM contracts WHERE ecc = ?').get('E-FF-1') as { usd_tax_amount_cents: number | string };
      expect(String(contract.usd_tax_amount_cents)).toBe('20000');
      // 人工掉票保留
      const manual = db.prepare('SELECT id FROM invoices WHERE id = ?').get('manual-invoice-1') as { id: string } | undefined;
      expect(manual?.id).toBe('manual-invoice-1');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('目标已存在非迁移来源记录时报告阻塞而非删除', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 预置人工合同（无 import_source_key）
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('p-m', 'TP-M', 'pending_entry', 't', 't');
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('c-m', 'p-m', 'TP-M', 'E-BLOCK-1', 't', 't');

      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-BLOCK-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      const result = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('无法安全覆盖');
      // 人工记录未被删除
      expect((db.prepare('SELECT id FROM contracts WHERE id = ?').get('c-m') as { id: string }).id).toBe('c-m');
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('事务失败整体回滚：批次内失败不产生部分数据', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 预置人工合同（同 ECC 非迁移来源）→ 迁移批次失败整体回滚
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('p-x', 'TP-X', 'pending_entry', 't', 't');
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('c-x', 'p-x', 'TP-X', 'E-RB-1', 't', 't');

      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-RB-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      const result = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      // 无部分数据：项目数仍为 1（未新增）
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle 复审：preflight 全局零写 / 批次含子记录 / 目标快照防人工覆盖', () => {
  it('preflight：invoice 无对应项目 ECC → 零表写入失败', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-A-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        // 掉票 ECC 指向不存在的项目
        row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-NOPE', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      ];
      expect(() => runImport(db, { rows, mapping: MAPPING_V1 })).toThrow(/preflight 失败/);
      // 零表写入：项目、合同、掉票均未写入
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('preflight：前项目有效 + 后项目结构错误 → 全局零写（不部分提交）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        // 有效项目
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-VALID-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        // 后项目结构错误：掉票 ECC 无对应项目
        row(CONTRACT, '合同信息', 3, { 'ECC#': 'E-VALID-2', 'Account name': '乙', 合同USD含税金额: '200' }),
        row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-ORPHAN', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      ];
      expect(() => runImport(db, { rows, mapping: MAPPING_V1 })).toThrow(/preflight 失败/);
      // 零表写入：有效项目也不得先提交
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('只改 invoice 源时批次不误判 skipped，且更新掉票记录', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-INV-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-INV-1', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      ];
      const r1 = runImport(db, { rows: initial, mapping: MAPPING_V1 });
      expect(r1.writtenCounts.invoice).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);

      // 只改掉票金额（项目源行不变）→ 批次不得 skipped，掉票记录更新
      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-INV-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-INV-1', '金额（USD）': '88', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      ];
      const r2 = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(r2.batches.some((b) => b.status === 'success')).toBe(true);
      expect(r2.batches.some((b) => b.status === 'skipped')).toBe(false); // 不误判 skipped
      const inv = db.prepare('SELECT amount_cents FROM invoices WHERE import_source_key IS NOT NULL').get() as { amount_cents: number | string };
      expect(String(inv.amount_cents)).toBe('8800');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('手工修改已迁移目标后 forward-fix 阻塞保留（目标快照不一致）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-SNAP-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });

      // 人工修改迁移后的项目（改区域）→ 目标快照与上次迁移后不一致
      db.prepare("UPDATE projects SET region = '人工修改区域' WHERE import_source_key = 'project|E-SNAP-1'").run();

      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-SNAP-1', 'Account name': '甲', 合同USD含税金额: '200' }),
      ];
      const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('人工/外部修改');
      // 人工修改保留
      const project = db.prepare("SELECT region FROM projects WHERE import_source_key = 'project|E-SNAP-1'").get() as { region: string | null };
      expect(project.region).toBe('人工修改区域');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('人工转单后重跑导入报告人工修改冲突且不覆盖终态（零业务写入）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-XFER-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      const imported = db
        .prepare("SELECT id, status FROM projects WHERE import_source_key = 'project|E-XFER-1'")
        .get() as { id: string; status: string };
      expect(imported.status).toBe('pending_entry');

      // 负责人经唯一生命周期入口人工转单（终态）→ 目标项目被人工修改。
      const service = new ProjectService(
        new SqliteProjectRepository(db),
        new SqliteContractRepository(db),
      );
      expect(service.adjustStatus(imported.id, 'transferred')).toMatchObject({
        ok: true,
        status: 'transferred',
        reason: 'transfer',
      });
      expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(imported.id)).toMatchObject({ status: 'transferred' });

      // 重跑导入：源事实含进单/装机/验收等更强事实 → 目标快照不一致（人工修改）→ 阻塞不覆盖。
      const rerun: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-XFER-1', 'Account name': '甲', 合同USD含税金额: '200' }),
        row(EXEC, '搬迁项目', 2, {
          'ECC#': 'E-XFER-1',
          客户单位名称: '甲',
          实际装机完成时间: '2026-03-01T00:00:00+08:00',
          验收报告形成日期: '2026-03-02',
        }),
      ];
      const result = runImport(db, { rows: rerun, mapping: MAPPING_V1 });
      const failed = result.batches.find((b) => b.status === 'failed');
      expect(failed, '应存在失败批次').toBeDefined();
      expect(failed!.errorDetails).toContain('人工/外部修改');
      // 整次提交零业务写入：无成功批次、写入计数全 0。
      expect(result.batches.some((b) => b.status === 'success')).toBe(false);
      expect(result.writtenCounts).toEqual({
        project: 0,
        service_order: 0,
        invoice: 0,
        logistics_fee: 0,
        serial_address_update: 0,
        qr_request: 0,
        ship_to_request: 0,
      });

      // 终态保留、人工值保留、合同金额未被源事实覆盖、不新增项目。
      expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(imported.id)).toMatchObject({ status: 'transferred' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      const contract = db
        .prepare("SELECT usd_tax_amount_cents FROM contracts WHERE ecc = 'E-XFER-1'")
        .get() as { usd_tax_amount_cents: number | string };
      expect(String(contract.usd_tax_amount_cents)).toBe('10000');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('事务注入失败：批次内写一部分后失败 → 整体回滚零部分', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 预置人工合同（同 ECC 非迁移来源）→ 项目写入尝试失败整批回滚
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('p-tx', 'TP-TX', 'pending_entry', 't', 't');
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('c-tx', 'p-tx', 'TP-TX', 'E-TX-1', 't', 't');

      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-TX-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(EXEC, '搬迁项目', 2, { 'ECC#': 'E-TX-1', 客户单位名称: '甲' }),
      ];
      const result = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(result.batches.some((b) => b.status === 'failed')).toBe(true);
      // 项目批次失败 → 项目/合同/客户均不得部分写入（批次内零部分）
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(0);
      // 迁移审计零写入
      expect((db.prepare('SELECT COUNT(*) AS n FROM migration_audit').get() as { n: number }).n).toBe(0);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('幂等：同源重跑不重复写入（含子记录批次）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const rows: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-ID-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '掉票记录表', 2, { ECC: 'E-ID-1', '金额（USD）': '50', 掉票时间: '2026-02-01T00:00:00+08:00' }),
      ];
      runImport(db, { rows, mapping: MAPPING_V1 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      const r2 = runImport(db, { rows, mapping: MAPPING_V1 });
      expect(r2.batches.every((b) => b.status === 'skipped')).toBe(true);
      expect((db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(1);
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('Oracle 复审聚焦回归：transport_company 同步/合同金额快照/legacy 无基线/QR 类型/超安全整数快照', () => {
  it('物流源运输公司修正时 forward-fix 同步迁移创建的 batch.transport_company', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LOG-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '物流费用表', 2, { ECC: 'E-LOG-1', 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30', 物流公司: '运输A' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      const batch1 = db.prepare("SELECT transport_company FROM batches WHERE import_source_key IS NOT NULL").get() as { transport_company: string | null };
      expect(batch1.transport_company).toBe('运输A');

      // 只改物流运输公司 → 批次不得 skipped，batch.transport_company 同步更新
      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LOG-1', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '物流费用表', 2, { ECC: 'E-LOG-1', 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30', 物流公司: '运输B' }),
      ];
      const r2 = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(r2.batches.some((b) => b.status === 'success')).toBe(true);
      expect(r2.batches.some((b) => b.status === 'skipped')).toBe(false);
      const batch2 = db.prepare("SELECT transport_company FROM batches WHERE import_source_key IS NOT NULL").get() as { transport_company: string | null };
      expect(batch2.transport_company).toBe('运输B');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('人工修改迁移创建的 batch.transport_company 后 forward-fix 阻塞保留', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LOG-2', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '物流费用表', 2, { ECC: 'E-LOG-2', 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '40', 成交价格: '35', 实际物流费用: '30', 物流公司: '运输A' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      // 人工修改迁移创建的 batch.transport_company
      db.prepare("UPDATE batches SET transport_company='人工修改' WHERE import_source_key IS NOT NULL").run();

      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LOG-2', 'Account name': '甲', 合同USD含税金额: '100' }),
        row(WORKLOAD, '物流费用表', 2, { ECC: 'E-LOG-2', 物流费用申请登记时间: '2026-01-05T00:00:00+08:00', 预算价格: '41', 成交价格: '35', 实际物流费用: '30', 物流公司: '运输B' }),
      ];
      const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('人工/外部修改');
      const batch = db.prepare("SELECT transport_company FROM batches WHERE import_source_key IS NOT NULL").get() as { transport_company: string | null };
      expect(batch.transport_company).toBe('人工修改');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('合同金额人工修改后 forward-fix 阻塞（项目快照覆盖 contracts 金额）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-CA-1', 'Account name': '甲', 合同USD含税金额: '100' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      // 人工修改合同金额（projects 字段未动）
      db.prepare("UPDATE contracts SET usd_tax_amount_cents=9999 WHERE ecc='E-CA-1'").run();

      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-CA-1', 'Account name': '甲', 合同USD含税金额: '200' }),
      ];
      const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('人工/外部修改');
      // 人工金额保留
      const contract = db.prepare("SELECT usd_tax_amount_cents FROM contracts WHERE ecc='E-CA-1'").get() as { usd_tax_amount_cents: number | string };
      expect(String(contract.usd_tax_amount_cents)).toBe('9999');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('v9 前已导入的迁移记录无 audit 基线时 forward-fix 阻塞（需人工确认，不猜测）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 模拟 v9 前导入：目标行有 import_source_key 但无 import_record_audit 基线
      db.prepare('INSERT INTO projects (id, temp_no, status, created_at, updated_at, import_source_key, import_source_hash) VALUES (?,?,?,?,?,?,?)').run(
        'p-legacy', 'MIG-E-LEGACY', 'pending_entry', 't', 't', 'project|E-LEGACY', 'oldhash',
      );
      db.prepare('INSERT INTO contracts (id, project_id, temp_number, ecc, created_at, updated_at, import_source_key, import_source_hash) VALUES (?,?,?,?,?,?,?,?)').run(
        'c-legacy', 'p-legacy', 'MIG-E-LEGACY', 'E-LEGACY', 't', 't', 'contract|E-LEGACY', 'oldhash',
      );

      const changed: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-LEGACY', 'Account name': '甲', 合同USD含税金额: '200' }),
      ];
      const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('缺少目标快照基线');
      // 遗留数据未被覆盖
      const project = db.prepare("SELECT status FROM projects WHERE id='p-legacy'").get() as { status: string };
      expect(project.status).toBe('pending_entry');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('QR 类型人工修改后 forward-fix 阻塞（快照纳入 qr_request_types）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      const initial: SourceRow[] = [
        row(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 申请类型: 'A' }),
      ];
      runImport(db, { rows: initial, mapping: MAPPING_V1 });
      // 人工修改 QR 类型
      const qrId = (db.prepare("SELECT id FROM qr_requests WHERE import_source_key IS NOT NULL").get() as { id: string }).id;
      db.prepare('UPDATE qr_request_types SET type_code=? WHERE qr_request_id=?').run('C', qrId);

      const changed: SourceRow[] = [
        row(WORKLOAD, '服务二维码表', 2, { 日期: '2026-01-07T00:00:00+08:00', 申请人: '甲', 申请类型: 'B' }),
      ];
      const result = runImport(db, { rows: changed, mapping: MAPPING_V1 });
      expect(result.batches[0].status).toBe('failed');
      expect(result.batches[0].errorDetails).toContain('人工/外部修改');
      // 人工类型保留
      const type = db.prepare('SELECT type_code FROM qr_request_types WHERE qr_request_id=?').get(qrId) as { type_code: string };
      expect(type.type_code).toBe('C');
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('超安全整数（>MAX_SAFE_INTEGER 分）目标快照精确（BigInt 读取不退化 Number）', () => {
    const dir = makeTempDir();
    try {
      const { db } = bootstrapDatabase({ dataDir: dir });
      // 源金额「元」超过 Number.MAX_SAFE_INTEGER（9007199254740993 元 → 900719925474099300 分，
      // 分值远超 MAX_SAFE_INTEGER，Number 读取会丢精度/抛错），必须 BigInt 精确处理。
      const huge = '9007199254740993';
      const initial: SourceRow[] = [
        row(CONTRACT, '合同信息', 2, { 'ECC#': 'E-BIG-1', 'Account name': '甲', 合同USD含税金额: huge }),
      ];
      const r = runImport(db, { rows: initial, mapping: MAPPING_V1 });
      expect(r.batches[0].status).toBe('success');
      // 合同金额精确落库（BigInt 读取，不丢精度）：分 = 元 × 100
      const stmt = db.prepare('SELECT usd_tax_amount_cents FROM contracts WHERE ecc=?');
      stmt.setReadBigInts(true);
      const contractRow = stmt.get('E-BIG-1') as { usd_tax_amount_cents: bigint | null };
      expect(contractRow.usd_tax_amount_cents?.toString()).toBe('900719925474099300');
      // 快照审计存在且可刷新
      const audit = db.prepare("SELECT target_snapshot_hash FROM import_record_audit WHERE source_key='project|E-BIG-1'").get() as { target_snapshot_hash: string } | undefined;
      expect(audit?.target_snapshot_hash).toBeTruthy();
      closeDatabase(db);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
