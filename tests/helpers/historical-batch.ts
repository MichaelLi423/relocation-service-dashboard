import type { DatabaseSync } from 'node:sqlite';
import {
  SqliteActivityEngineerRepository, SqliteActivityRepository, SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository, SqliteContractRepository, SqliteInstrumentRepository,
  SqliteInvoiceReadRepository, SqliteLogisticsFeeRepository, SqliteProjectRepository, SqliteWorkFactRepository,
} from '../../src/domain/capabilities/local-data-persistence';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle';
import { ExecutionService, type BatchQuoteInput, type LogisticsFeeInput } from '../../src/domain/capabilities/relocation-execution';
import { Money } from '../../src/domain/core/money';

/** 只为历史兼容用例构造批次/费用；不调用已下线的公共登记命令，不改 schema/状态校验。 */
export function seedHistoricalBatch(db: DatabaseSync, projectId: string, values: Record<string, unknown>): string {
  const account = db.prepare('SELECT id, username FROM accounts LIMIT 1').get() as { id: string; username: string };
  const actor = { accountId: account.id, username: account.username };
  const projects = new ProjectService(new SqliteProjectRepository(db), new SqliteContractRepository(db), new SqliteInvoiceReadRepository(db));
  const execution = new ExecutionService(
    new SqliteBatchRepository(db), new SqliteInstrumentRepository(db), new SqliteBatchChangeHistoryRepository(db),
    new SqliteActivityRepository(db), new SqliteActivityEngineerRepository(db), new SqliteWorkFactRepository(db),
    new SqliteLogisticsFeeRepository(db),
    { onExecutionStarted: (id) => { projects.adjustStatus(id, 'executing', { executionStarted: true }); } },
  );
  const present = (key: string) => values[key] != null && String(values[key]).trim() !== '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const batch = execution.createBatch(projectId, actor);
    const quote: BatchQuoteInput = {};
    const fee: LogisticsFeeInput = {};
    if (present('planTransportDate')) quote.planTransportDate = String(values.planTransportDate);
    if (present('transportCompany')) quote.transportCompany = String(values.transportCompany);
    if (present('appliedAt')) fee.appliedAt = String(values.appliedAt);
    if (present('budgetPrice')) {
      quote.originalPriceCents = fee.budgetPriceCents = Money.parse(String(values.budgetPrice)).cents;
    }
    if (present('dealPrice')) {
      quote.discountedPriceCents = fee.dealPriceCents = fee.logisticsCostCents = Money.parse(String(values.dealPrice)).cents;
    }
    if (Object.keys(fee).length > 0) execution.recordLogisticsFee(batch.id, fee, actor);
    execution.updateBatchQuote(batch.id, quote, actor);
    db.exec('COMMIT');
    return batch.id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
