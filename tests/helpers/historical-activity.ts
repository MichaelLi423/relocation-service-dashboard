import type { DatabaseSync } from 'node:sqlite';
import {
  SqliteActivityEngineerRepository,
  SqliteActivityRepository,
  SqliteBatchChangeHistoryRepository,
  SqliteBatchRepository,
  SqliteContractRepository,
  SqliteInstrumentRepository,
  SqliteInvoiceReadRepository,
  SqliteLogisticsFeeRepository,
  SqliteProjectRepository,
  SqliteWorkFactRepository,
} from '../../src/domain/capabilities/local-data-persistence';
import { ProjectService } from '../../src/domain/capabilities/relocation-project-lifecycle';
import { ExecutionService, type WorkType } from '../../src/domain/capabilities/relocation-execution';

/**
 * 为历史兼容测试构造旧活动；不调用已下线的 visit 命令。
 * 经原执行领域入口保存工程师/工作事实，状态仍走 ProjectService/lifecycle，
 * 不直接改状态或跳过删除依赖保护。事务语义与旧 facade 播种保持一致。
 */
export function seedHistoricalActivity(
  db: DatabaseSync,
  projectId: string,
  visitAt: string,
  engineers: string[],
  work?: { instrumentId: string; type: WorkType; status: 'in_progress' | 'done' },
): string {
  const account = db.prepare('SELECT id, username FROM accounts LIMIT 1').get() as { id: string; username: string };
  const actor = { accountId: account.id, username: account.username };
  const projects = new ProjectService(new SqliteProjectRepository(db), new SqliteContractRepository(db), new SqliteInvoiceReadRepository(db));
  const execution = new ExecutionService(
    new SqliteBatchRepository(db), new SqliteInstrumentRepository(db), new SqliteBatchChangeHistoryRepository(db),
    new SqliteActivityRepository(db), new SqliteActivityEngineerRepository(db), new SqliteWorkFactRepository(db),
    new SqliteLogisticsFeeRepository(db),
    { onExecutionStarted: (id) => { projects.adjustStatus(id, 'executing', { executionStarted: true }); } },
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const activity = execution.createActivity(projectId, visitAt, engineers, actor);
    if (work) {
      execution.startWorkFact(activity.id, work.instrumentId, work.type, actor);
      if (work.status === 'done') execution.completeWorkFact(activity.id, work.instrumentId, work.type, actor);
    }
    db.exec('COMMIT');
    return activity.id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
