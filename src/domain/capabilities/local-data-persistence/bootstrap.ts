import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeDatabase,
  openDatabase,
  type OpenDatabaseOptions,
} from './connection';
import {
  applyInitialSchema,
  INITIAL_SCHEMA_VERSION,
} from './schema';
import { runMigrations, type Migration } from './migration';
import {
  applyAttributionColumnsMigration,
  ATTRIBUTION_MIGRATION_VERSION,
} from './schema-v2';
import {
  applyCapabilityAttributionMigration,
  CAPABILITY_ATTRIBUTION_MIGRATION_VERSION,
} from './schema-v3';
import {
  applyFinancialAttributionMigration,
  FINANCIAL_ATTRIBUTION_MIGRATION_VERSION,
} from './schema-v4';
import {
  applyReminderAttributionMigration,
  REMINDER_ATTRIBUTION_MIGRATION_VERSION,
} from './schema-v5';
import {
  applyMigrationAuditSourceHashMigration,
  MIGRATION_AUDIT_SOURCE_HASH_MIGRATION_VERSION,
} from './schema-v6';
import {
  applyImportProvenanceMigration,
  IMPORT_PROVENANCE_MIGRATION_VERSION,
} from './schema-v7';
import {
  applyIntegrityMigrations,
  INTEGRITY_MIGRATION_VERSION,
} from './schema-v8';
import {
  applyImportRecordAuditMigration,
  IMPORT_RECORD_AUDIT_MIGRATION_VERSION,
} from './schema-v9';
import {
  applyBusinessRevisionMigration,
  BUSINESS_REVISION_MIGRATION_VERSION,
} from './schema-v10';
import {
  applyImportRunAuditMigration,
  IMPORT_RUN_AUDIT_MIGRATION_VERSION,
} from './schema-v11';
import {
  applyReadIndexMigration,
  READ_INDEX_MIGRATION_VERSION,
} from './schema-v12';
import {
  applyBusinessDateMigration,
  BUSINESS_DATE_MIGRATION_VERSION,
} from './schema-v13';
import {
  applySupplementFieldsMigration,
  SUPPLEMENT_FIELDS_MIGRATION_VERSION,
} from './schema-v14';
import {
  applyRelocationWorkbenchFieldsMigration,
  RELOCATION_WORKBENCH_MIGRATION_VERSION,
} from './schema-v15';
import {
  applyTemporaryInstrumentFieldsMigration,
  TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION,
} from './schema-v16';
import {
  applyProjectTagMigration,
  PROJECT_TAG_MIGRATION_VERSION,
} from './schema-v17';
import {
  applyOptionalLogisticsFeeMigration,
  OPTIONAL_LOGISTICS_FEE_MIGRATION_VERSION,
} from './schema-v18';
import {
  applyUnderRepairStatusMigration,
  UNDER_REPAIR_STATUS_MIGRATION_VERSION,
} from './schema-v19';
import {
  applyServiceOrderEngineerNullableMigration,
  SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION,
} from './schema-v20';
import {
  buildFinancialIntegrityHint,
  hasAnyFinancialIntegrityIssue,
  readFinancialIntegrityCounts,
  type FinancialIntegrityCounts,
} from './financial-integrity';

/** 初始迁移：v1 创建覆盖 14 个能力的核心表/事实表。 */
export const INITIAL_MIGRATION: Migration = {
  version: INITIAL_SCHEMA_VERSION,
  name: 'initial-schema',
  up: (db) => applyInitialSchema(db),
};

/** v2 迁移：为手工录入事实表补充账号归属快照（tasks 3.x）。 */
export const ATTRIBUTION_MIGRATION: Migration = {
  version: ATTRIBUTION_MIGRATION_VERSION,
  name: 'execution-attribution-columns',
  up: (db) => applyAttributionColumnsMigration(db),
};

/** v3 迁移：为 4.x 能力手工事实表补充账号归属快照。 */
export const CAPABILITY_ATTRIBUTION_MIGRATION: Migration = {
  version: CAPABILITY_ATTRIBUTION_MIGRATION_VERSION,
  name: 'capability-attribution-columns',
  up: (db) => applyCapabilityAttributionMigration(db),
};

/** v4 迁移：为掉票记录补充账号归属快照（tasks 5.x）。 */
export const FINANCIAL_ATTRIBUTION_MIGRATION: Migration = {
  version: FINANCIAL_ATTRIBUTION_MIGRATION_VERSION,
  name: 'financial-attribution-columns',
  up: (db) => applyFinancialAttributionMigration(db),
};

/** v5 迁移：为项目提醒操作补充账号归属快照（tasks 6.x）。 */
export const REMINDER_ATTRIBUTION_MIGRATION: Migration = {
  version: REMINDER_ATTRIBUTION_MIGRATION_VERSION,
  name: 'reminder-attribution-columns',
  up: (db) => applyReminderAttributionMigration(db),
};

/** v6 迁移：migration_audit 补充 source_hash（迁移幂等/forward-fix，tasks 8.x）。 */
export const MIGRATION_AUDIT_SOURCE_HASH_MIGRATION: Migration = {
  version: MIGRATION_AUDIT_SOURCE_HASH_MIGRATION_VERSION,
  name: 'migration-audit-source-hash',
  up: (db) => applyMigrationAuditSourceHashMigration(db),
};

/** v7 迁移：迁移目标表补充 import_source_key/hash（tasks 8.x，forward-fix 只更新迁移记录）。 */
export const IMPORT_PROVENANCE_MIGRATION: Migration = {
  version: IMPORT_PROVENANCE_MIGRATION_VERSION,
  name: 'import-provenance-columns',
  up: (db) => applyImportProvenanceMigration(db),
};

/** v8 迁移：Oracle 高风险 5/6/9 —— 事项回填 project_id 并 NOT NULL、Ship-to 申请 trim 唯一索引。 */
export const INTEGRITY_MIGRATION: Migration = {
  version: INTEGRITY_MIGRATION_VERSION,
  name: 'integrity-project-not-null-and-request-unique',
  up: (db) => applyIntegrityMigrations(db),
};

/** v9 迁移：import_record_audit 目标快照（forward-fix 防覆盖人工修改，tasks 8.x）。 */
export const IMPORT_RECORD_AUDIT_MIGRATION: Migration = {
  version: IMPORT_RECORD_AUDIT_MIGRATION_VERSION,
  name: 'import-record-audit',
  up: (db) => applyImportRecordAuditMigration(db),
};

/** v10 迁移：正式库身份 + 业务修订触发器（tasks 8.15 / design D25）。 */
export const BUSINESS_REVISION_MIGRATION: Migration = {
  version: BUSINESS_REVISION_MIGRATION_VERSION,
  name: 'business-revision-and-db-identity',
  up: (db) => applyBusinessRevisionMigration(db),
};

/** v11 迁移：正式迁移运行审计 import_run（tasks 8.16 / design D27）。 */
export const IMPORT_RUN_AUDIT_MIGRATION: Migration = {
  version: IMPORT_RUN_AUDIT_MIGRATION_VERSION,
  name: 'import-run-audit',
  up: (db) => applyImportRunAuditMigration(db),
};

/** v12 迁移：工作台 v2 有界读取支撑索引（Oracle #10，只加索引不改数据）。 */
export const READ_INDEX_MIGRATION: Migration = {
  version: READ_INDEX_MIGRATION_VERSION,
  name: 'workbench-read-indexes',
  up: (db) => applyReadIndexMigration(db),
};

/** v13 迁移：业务日期化（design D30，业务时间统一 yyyy-mm-dd；审计技术字段不变）。 */
export const BUSINESS_DATE_MIGRATION: Migration = {
  version: BUSINESS_DATE_MIGRATION_VERSION,
  name: 'business-date-normalization',
  up: (db) => applyBusinessDateMigration(db),
};

/** v14 迁移：补齐资料/批量导入新增字段（计划装机完成日期、仪器厂商与服务级别）。 */
export const SUPPLEMENT_FIELDS_MIGRATION: Migration = {
  version: SUPPLEMENT_FIELDS_MIGRATION_VERSION,
  name: 'supplement-and-bulk-import-fields',
  up: (db) => applySupplementFieldsMigration(db),
};

/** v15 迁移：搬迁工作台 0810 反馈新增字段（项目备注、暂存地址、是否暂存、是否批复；计划装机日期复用 v14 列）。 */
export const RELOCATION_WORKBENCH_MIGRATION: Migration = {
  version: RELOCATION_WORKBENCH_MIGRATION_VERSION,
  name: 'relocation-workbench-fields',
  up: (db) => applyRelocationWorkbenchFieldsMigration(db),
};

/** v16 迁移：项目暂定仪器范围字段（暂定仪器名称/型号/是否配备 UPS；只加可空列不改业务数据）。 */
export const TEMPORARY_INSTRUMENT_FIELDS_MIGRATION: Migration = {
  version: TEMPORARY_INSTRUMENT_FIELDS_MIGRATION_VERSION,
  name: 'temporary-instrument-fields',
  up: (db) => applyTemporaryInstrumentFieldsMigration(db),
};

/** v17 迁移：全局项目分类标签分组、定义及项目多对多关联。 */
export const PROJECT_TAG_MIGRATION: Migration = {
  version: PROJECT_TAG_MIGRATION_VERSION,
  name: 'project-tags',
  up: (db) => applyProjectTagMigration(db),
};

/** v18 迁移：物流费用登记全部字段可选（重建 logistics_fees 使业务费用字段可空）。 */
export const OPTIONAL_LOGISTICS_FEE_MIGRATION: Migration = {
  version: OPTIONAL_LOGISTICS_FEE_MIGRATION_VERSION,
  name: 'optional-logistics-fee-fields',
  up: (db) => applyOptionalLogisticsFeeMigration(db),
};

/** v19 迁移：新增项目主状态「维修中」（重建 projects 与状态转换审计表放宽 status CHECK）。 */
export const UNDER_REPAIR_STATUS_MIGRATION: Migration = {
  version: UNDER_REPAIR_STATUS_MIGRATION_VERSION,
  name: 'under-repair-project-status',
  disableForeignKeys: true,
  up: (db) => applyUnderRepairStatusMigration(db),
};

/** v20 迁移：开单记录工程师允许空缺保存并可后续补录（重建 service_orders 使 engineer 可空）。 */
export const SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION: Migration = {
  version: SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION_VERSION,
  name: 'service-order-engineer-nullable',
  up: (db) => applyServiceOrderEngineerNullableMigration(db),
};

/** 当前迁移序列（后续 schema 升级追加新 Migration，不修改已发布迁移）。 */
export const MIGRATIONS: readonly Migration[] = [
  INITIAL_MIGRATION,
  ATTRIBUTION_MIGRATION,
  CAPABILITY_ATTRIBUTION_MIGRATION,
  FINANCIAL_ATTRIBUTION_MIGRATION,
  REMINDER_ATTRIBUTION_MIGRATION,
  MIGRATION_AUDIT_SOURCE_HASH_MIGRATION,
  IMPORT_PROVENANCE_MIGRATION,
  INTEGRITY_MIGRATION,
  IMPORT_RECORD_AUDIT_MIGRATION,
  BUSINESS_REVISION_MIGRATION,
  IMPORT_RUN_AUDIT_MIGRATION,
  READ_INDEX_MIGRATION,
  BUSINESS_DATE_MIGRATION,
  SUPPLEMENT_FIELDS_MIGRATION,
  RELOCATION_WORKBENCH_MIGRATION,
  TEMPORARY_INSTRUMENT_FIELDS_MIGRATION,
  PROJECT_TAG_MIGRATION,
  OPTIONAL_LOGISTICS_FEE_MIGRATION,
  UNDER_REPAIR_STATUS_MIGRATION,
  SERVICE_ORDER_ENGINEER_NULLABLE_MIGRATION,
];

export interface BootstrapOptions {
  /** 数据目录（默认 userData/data）。 */
  dataDir: string;
  /** 迁移前安全备份目录（默认 {dataDir}/migration-backups）。 */
  backupDir?: string;
  openOptions?: Omit<OpenDatabaseOptions, 'path'>;
  now?: () => Date;
  /** 迁移后孤立财务数据诊断输出（缺省 console.warn；测试可注入固定 logger 断言治理提示）。 */
  logger?: { warn: (message: string) => void };
}

export interface BootstrapResult {
  db: DatabaseSync;
  dbPath: string;
  migrationResult: ReturnType<typeof runMigrations>;
  /**
   * 迁移后/启动孤立财务数据诊断计数（tasks 2.3/4.3 同源实现）。
   * 只读、仅计数（不返回/打印客户值）、不静默删除任何财务记录；结构性外键违规
   * 以 foreignKeyViolations 持续报告、不阻断迁移、不宣称 foreign_key_check 归零。
   */
  integrityDiagnostics: FinancialIntegrityCounts;
}

/**
 * 打开本地数据库并执行 schema 迁移（tasks 1.9/1.10）。
 * - 数据库文件：{dataDir}/workbench.db
 * - WAL/foreign_keys/busy_timeout 由 openDatabase 配置
 * - 迁移失败保留原库与迁移前安全备份（MigrationError 携带恢复信息）
 * - 迁移成功后执行只读孤立财务数据诊断（仅计数，不静默删除；存在计数时输出治理清理提示）。
 */
export function bootstrapDatabase(options: BootstrapOptions): BootstrapResult {
  const dbPath = join(options.dataDir, 'workbench.db');
  const backupDir = options.backupDir ?? join(options.dataDir, 'migration-backups');
  const db = openDatabase({ path: dbPath, ...options.openOptions });
  try {
    const migrationResult = runMigrations(db, {
      migrations: MIGRATIONS,
      backupDir,
      now: options.now,
    });
    // 迁移后/启动诊断（tasks 2.3）：只读计数，旧库存量结构违规不静默删、不阻断迁移。
    const integrityDiagnostics = readFinancialIntegrityCounts(db);
    if (hasAnyFinancialIntegrityIssue(integrityDiagnostics)) {
      const hint = buildFinancialIntegrityHint(integrityDiagnostics);
      if (hint !== null) {
        (options.logger?.warn ?? console.warn)(hint);
      }
    }
    return { db, dbPath, migrationResult, integrityDiagnostics };
  } catch (err) {
    closeDatabase(db);
    throw err;
  }
}
