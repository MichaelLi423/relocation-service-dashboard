import type { DatabaseSync } from 'node:sqlite';
import { ReportingExportService } from '../domain/capabilities/operational-reporting';
import type { LocalAccountService } from '../domain/capabilities/workbench-access';
import {
  IMPORT_WIZARD_CHANNELS,
  IPC_CHANNELS,
  MOBILE_READONLY_CHANNELS,
  type AccountSessionInfo,
  type ImportWizardCategory,
  type ImportWizardStepId,
  type MobileReadonlyConfigureInput,
  type ReportFilterDto,
  type ShipToRequestInputDto,
} from '../shared/ipc';
import { WorkbenchFacade } from './workbench-facade';
import type { ImportWizardFacade } from './import-wizard-facade';
import type { IpcEnvelope } from '../shared/ipc';
import { MobileReadonlyPublishError } from './mobile-readonly/errors';
import type { MobileReadonlyPublicationControl } from './mobile-readonly/wiring';

/**
 * 错误可跨 IPC 序列化的最小信封（ora-1：#7）。
 * 在进程内把 DomainError 转成 {ok:false,error:{code,message}} —— 绝不依赖 Error 自定义
 * 属性穿透 Electron 序列化（Electron 只保留 message）。code 保留稳定拒绝码。
 */
function toErrorBody(err: unknown): { code: string; message: string } {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' && e.code !== '' ? e.code : 'IPC_UNKNOWN';
  const message = typeof e?.message === 'string' && e.message !== '' ? e.message : String(err);
  return { code, message };
}

function runEnveloped<T>(fn: () => T): IpcEnvelope<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: toErrorBody(err) };
  }
}

async function runEnvelopedAsync<T>(fn: () => Promise<T>): Promise<IpcEnvelope<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: toErrorBody(err) };
  }
}

/**
 * IPC 通道注册（tasks 1.1 工程骨架；本模块为 main/index.ts 的可测试抽取）。
 *
 * 安全边界（Oracle 修复）：
 * - 除「账号状态/会话查询」外，所有业务通道在主进程进入 facade 之前
 *   统一校验：有效访问会话 + sender 为受信主窗口；snapshot/report/export/
 *   status mutation/业务命令/backup/restore 未登录一律拒绝，不依赖各方法的
 *   偶然 actor 调用。
 * - 金额 IPC 边界为十进制字符串，主进程用 Money 精确解析（renderer 禁止
 *   Number(value)*100 与浮点金额计算）。
 * - 手动备份/恢复由主进程负责 file dialog；无密码个人模式下主进程在启动/恢复时
 *   自动确保本地账号并建立访问会话（不提供初始化/登录/密码重置/恢复码通道）；
 *   恢复成功后重建数据库并重新取得/确保本地账号、恢复会话。
 */

/** IPC invoke 事件的最小形状（Electron IpcMainInvokeEvent 的 sender 子集）。 */
export interface IpcEvent {
  readonly sender: { readonly id: number };
  /** 发送帧 URL（Oracle 复审 #5：trusted sender 校验 webContents.id + senderFrame URL/origin）。 */
  readonly senderFrame?: { readonly url: string } | null;
}

/** 可注入的 IPC 总线（生产为 ipcMain，测试为内存实现）。 */
export interface IpcBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: string, listener: (event: IpcEvent, ...args: any[]) => unknown): void;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<
    'openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory' | 'showHiddenFiles' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'
  >;
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/** 主进程 handler 依赖（由 main/index.ts 注入真实实现，测试注入内存实现）。 */
export interface IpcHandlerDeps {
  db(): DatabaseSync;
  dbPath(): string;
  dataDir(): string;
  accountService(): LocalAccountService;
  /** 当前访问会话（null = 未登录）。 */
  session(): AccountSessionInfo | null;
  setSession(session: AccountSessionInfo | null): void;
  /** 受信主窗口 webContents id；null = 窗口尚未创建。 */
  trustedSenderId(): number | null;
  /** 受信主窗口加载 URL 的 origin（senderFrame URL/origin 校验）。 */
  trustedSenderOrigin(): string | null;
  /** 启动时每日自动备份失败信息（不阻塞窗口打开）；null = 正常。 */
  autoBackupError(): string | null;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** 手动备份到所选目录（文件名由备份服务生成）。 */
  createManualBackup(targetDir: string): Promise<string>;
  /** 「清理全部业务数据」confirm 前安全备份（复用现有备份机制；返回备份路径）。 */
  createCleanupBackup(): Promise<string>;
  /** 从备份文件恢复；成功时内部重建数据库连接。返回是否成功恢复。 */
  restoreFromBackup(backupPath: string): { restored: boolean };
  /** 历史数据导入向导 facade（编排工作区/worker/校验/seal/提交）。 */
  importWizardFacade(): ImportWizardFacade;
  /** 工作区是否可用（损坏/版本不兼容仅禁用导入，不影响普通工作台）。 */
  importWizardEnabled(): boolean;
  /** 工作区不可用原因（enabled=false 时展示）。 */
  importWizardError(): string | null;
  /**
   * 移动只读发布控制面（可选注入；生产由 main/index 经 wiring 恒提供）。
   * 未注入/不可用 → 三个移动通道返回规范化不可用错误（绝不静默假装成功）。
   */
  mobileReadonlyPublication?: () => MobileReadonlyPublicationControl | null;
}

/** 未登录/非受信调用方被拒绝时的错误（与领域错误区分，便于界面层提示）。 */
export class IpcAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcAccessDeniedError';
  }
}

/** 受信主窗口 sender 校验：webContents.id + senderFrame URL 精确 origin/入口比较（Oracle 二次复审 #4）。
 *  web origin 用 URL 解析后精确 origin；file:// 打包用精确入口 URL/路径，拒绝 localhost.evil 类前缀攻击。 */
export function senderFrameMatches(frameUrl: string, trustedUrl: string): boolean {
  try {
    const trusted = new URL(trustedUrl);
    const frame = new URL(frameUrl);
    if (trusted.protocol === 'file:') {
      return frame.protocol === 'file:' && frame.href === trusted.href;
    }
    return frame.origin === trusted.origin;
  } catch {
    return false;
  }
}

function requireTrustedSender(event: IpcEvent, deps: IpcHandlerDeps): void {
  const trusted = deps.trustedSenderId();
  const origin = deps.trustedSenderOrigin();
  if (trusted === null || event.sender.id !== trusted) {
    throw new IpcAccessDeniedError('拒绝：IPC 调用方不是受信主窗口');
  }
  if (origin !== null) {
    const frameUrl = event.senderFrame?.url ?? '';
    if (!senderFrameMatches(frameUrl, origin)) {
      throw new IpcAccessDeniedError('拒绝：IPC 调用方不是受信主窗口（发送帧来源不匹配）');
    }
  }
}

function requireSessionAndSender(event: IpcEvent, deps: IpcHandlerDeps): AccountSessionInfo {
  requireTrustedSender(event, deps);
  const session = deps.session();
  if (!session) {
    throw new IpcAccessDeniedError('登录状态已失效，请重新登录');
  }
  return session;
}

// ---------------------------------------------------------------------------
// 移动只读发布（tasks 5.2）
// - 与其它业务通道一致：受信主窗口 + 有效会话统一前置（校验发生在读取/解析任何输入前）；
// - 错误一律规范化（稳定 code + 固定文案）：任意非预期 Error 不暴露栈/输入回显；
// - 返回信封（{ok,data}|{ok:false,error:{code,message}}），preload 用 unwrap 适配。
// ---------------------------------------------------------------------------

/** 移动只读发布通道错误规范化：只保留稳定 code 与固定消息，绝不回显输入/token/栈。 */
function toMobileReadonlyError(err: unknown): { code: string; message: string } {
  if (err instanceof MobileReadonlyPublishError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof IpcAccessDeniedError) {
    return { code: 'IPC_ACCESS_DENIED', message: err.message };
  }
  return { code: 'IPC_UNKNOWN', message: '移动只读发布请求处理失败' };
}

function runMobileReadonlyEnveloped<T>(fn: () => T | Promise<T>): Promise<IpcEnvelope<T>> {
  try {
    return Promise.resolve(fn()).then(
      (data) => ({ ok: true, data }),
      (err: unknown) => ({ ok: false, error: toMobileReadonlyError(err) }),
    );
  } catch (err) {
    return Promise.resolve({ ok: false, error: toMobileReadonlyError(err) });
  }
}

/** 进入控制面前统一做会话+受信 sender 守卫；未注入控制面 → 规范化不可用（非静默成功）。 */
function mobileReadonlyFor(event: IpcEvent, deps: IpcHandlerDeps): MobileReadonlyPublicationControl {
  requireSessionAndSender(event, deps);
  const control = deps.mobileReadonlyPublication?.() ?? null;
  if (!control) {
    throw new MobileReadonlyPublishError('MOBILE_READONLY_UNAVAILABLE', '移动只读发布不可用（未初始化）');
  }
  return control;
}

export function registerIpcHandlers(bus: IpcBus, deps: IpcHandlerDeps): void {
  // 能力清单：纯元数据，无需登录。
  bus.handle(IPC_CHANNELS.capabilitiesList, () => [
    'workbench-access',
    'relocation-project-lifecycle',
    'relocation-execution',
    'service-order-recording',
    'ship-to-management',
    'serial-address-update',
    'damage-repair-tracking',
    'qr-request-tracking',
    'workbench-todos',
    'workbench-interface',
    'project-financial-closure',
    'operational-reporting',
    'historical-data-import',
    'local-data-persistence',
  ]);

  // ---- 账号状态/会话查询：无需会话，但必须是受信主窗口（Oracle 复审 #5） ----
  // 无密码个人模式：主进程在启动/恢复时已自动建立访问会话，不再提供初始化/登录/
  // 密码重置/恢复码通道（界面、preload 与共享 IPC 公共接口均不暴露）。

  bus.handle(IPC_CHANNELS.accountGetStatus, (event) => {
    requireTrustedSender(event, deps);
    return {
      initialized: deps.accountService().getStatus().initialized,
      autoBackupError: deps.autoBackupError(),
    };
  });

  bus.handle(IPC_CHANNELS.accountGetSession, (event) => {
    requireTrustedSender(event, deps);
    return deps.session();
  });

  // ---- 业务通道：进入 facade 前统一校验有效会话 + 受信主窗口 ----

  const facadeFor = (event: IpcEvent): WorkbenchFacade => {
    const session = requireSessionAndSender(event, deps);
    return new WorkbenchFacade(deps.db(), () => session, {
      cleanupBackup: () => deps.createCleanupBackup(),
    });
  };

  // ---- Oracle #10：工作台 v2 有界读取 / mutation（旧 snapshot 通道已删除，仅此入口） ----
  bus.handle(IPC_CHANNELS.workbenchV2Overview, (event) => facadeFor(event).v2Overview());
  bus.handle(IPC_CHANNELS.workbenchV2ProjectPage, (event, request) =>
    facadeFor(event).v2ProjectPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2ProjectDetail, (event, projectId: string) =>
    facadeFor(event).v2ProjectDetail(projectId),
  );
  bus.handle(IPC_CHANNELS.workbenchV2SectionPage, (event, request) =>
    facadeFor(event).v2SectionPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2IndependentPage, (event, request) =>
    facadeFor(event).v2IndependentPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2LookupPage, (event, request) =>
    facadeFor(event).v2LookupPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2HistoryPage, (event, request) =>
    facadeFor(event).v2HistoryPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2ReminderPage, (event, request) =>
    facadeFor(event).v2ReminderPage(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2ReminderLanes, (event, request) =>
    facadeFor(event).v2ReminderLanes(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2TagCatalog, (event, request) =>
    facadeFor(event).v2TagCatalog(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2TagMutate, (event, request) =>
    runEnveloped(() => facadeFor(event).v2TagMutate(request)),
  );
  bus.handle(IPC_CHANNELS.workbenchV2Mutate, (event, request) =>
    facadeFor(event).v2Mutate(request),
  );
  bus.handle(IPC_CHANNELS.workbenchV2Delete, (event, request) =>
    runEnveloped(() => facadeFor(event).v2Delete(request)),
  );
  bus.handle(IPC_CHANNELS.dataCleanPrepare, (event) =>
    runEnveloped(() => facadeFor(event).cleanPrepare()),
  );
  bus.handle(IPC_CHANNELS.dataCleanConfirm, (event, request) =>
    runEnvelopedAsync(() => facadeFor(event).cleanConfirm(request)),
  );
  bus.handle(IPC_CHANNELS.shipToCreateRequest, (event, input: ShipToRequestInputDto) =>
    facadeFor(event).createShipToRequest(input),
  );
  bus.handle(IPC_CHANNELS.shipToSubmitRequest, (event, requestId: string) =>
    facadeFor(event).submitShipToRequest(requestId),
  );
  bus.handle(IPC_CHANNELS.reportBuild, (event, filter: ReportFilterDto) =>
    facadeFor(event).reportDto(filter),
  );
  bus.handle(
    IPC_CHANNELS.reportDrillDown,
    (event, metricKey: string, filter: ReportFilterDto) =>
      facadeFor(event).drillDown(metricKey, filter),
  );
  bus.handle(
    IPC_CHANNELS.reportExport,
    async (event, format: 'xlsx' | 'png' | 'pdf', filter: ReportFilterDto) => {
      const facade = facadeFor(event);
      const report = facade.report(filter);
      const exporter = new ReportingExportService();
      const bytes =
        format === 'xlsx'
          ? await exporter.exportExcel(report)
          : format === 'pdf'
            ? await exporter.exportPdf(report)
            : exporter.exportPng(report);
      const result = await deps.showSaveDialog({
        title: '导出运营报表',
        defaultPath: `搬迁服务报表-${filter.monthFrom}-${filter.monthTo}.${format}`,
        filters: [
          {
            name: format === 'xlsx' ? 'Excel 工作簿' : format === 'png' ? 'PNG 图片' : 'PDF 文档',
            extensions: [format],
          },
        ],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      await deps.writeFile(result.filePath, bytes);
      return { saved: true, path: result.filePath };
    },
  );

  bus.handle(IPC_CHANNELS.backupManual, async (event) => {
    requireSessionAndSender(event, deps);
    const result = await deps.showOpenDialog({
      title: '选择手动备份保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const path = await deps.createManualBackup(result.filePaths[0]);
    return { canceled: false, path };
  });

  bus.handle(IPC_CHANNELS.restoreFromBackup, async (event) => {
    requireSessionAndSender(event, deps);
    const result = await deps.showOpenDialog({
      title: '选择要恢复的备份文件',
      filters: [{ name: 'SQLite 备份', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const outcome = deps.restoreFromBackup(result.filePaths[0]);
    if (outcome.restored) {
      // 恢复成功：数据库已重建。无密码个人模式下重新取得/确保本地账号并恢复会话
      // （空账号库自动建「本地用户」；已有账号沿用其 username），而不是踢到登录页。
      const session = await deps.accountService().ensureLocalSession();
      deps.setSession({ accountId: session.accountId, username: session.username });
    }
    return { canceled: false, restored: outcome.restored };
  });

  // ---- 历史数据导入向导（tasks 8.49/8.53）：统一 requireSessionAndSender + 草稿访问校验 ----

  const importWizardFor = (event: IpcEvent): ImportWizardFacade => {
    requireSessionAndSender(event, deps);
    if (!deps.importWizardEnabled()) {
      throw new Error(
        `历史数据导入工作区不可用：${deps.importWizardError() ?? '未知原因'}（普通工作台不受影响）`,
      );
    }
    return deps.importWizardFacade();
  };

  bus.handle(IMPORT_WIZARD_CHANNELS.listDrafts, (event) => importWizardFor(event).listDrafts());
  bus.handle(IMPORT_WIZARD_CHANNELS.createDraft, (event) => importWizardFor(event).createDraft());
  bus.handle(IMPORT_WIZARD_CHANNELS.openDraft, (event, draftId: string) => importWizardFor(event).openDraft(draftId));
  bus.handle(IMPORT_WIZARD_CHANNELS.deleteDraft, (event, draftId: string) => importWizardFor(event).deleteDraft(draftId));
  bus.handle(IMPORT_WIZARD_CHANNELS.saveStep, (event, draftId: string, step: ImportWizardStepId) =>
    importWizardFor(event).saveStep(draftId, step),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.downloadTemplate, (event) => importWizardFor(event).downloadTemplate());
  bus.handle(IMPORT_WIZARD_CHANNELS.selectFiles, (event, draftId: string) => importWizardFor(event).selectFiles(draftId));
  bus.handle(
    IMPORT_WIZARD_CHANNELS.pasteIntoCategory,
    (event, draftId: string, category: ImportWizardCategory, headerConfirmed: boolean) =>
      importWizardFor(event).pasteIntoCategory(draftId, category, Boolean(headerConfirmed)),
  );
  bus.handle(
    IMPORT_WIZARD_CHANNELS.classifySheet,
    (event, draftId: string, sheetId: string, category: ImportWizardCategory | 'excluded') =>
      importWizardFor(event).classifySheet(draftId, sheetId, category),
  );
  bus.handle(
    IMPORT_WIZARD_CHANNELS.setCategoryMode,
    (event, draftId: string, category: ImportWizardCategory, mode: 'data' | 'none') =>
      importWizardFor(event).setCategoryMode(draftId, category, mode),
  );
  bus.handle(
    IMPORT_WIZARD_CHANNELS.updateMapping,
    (event, draftId: string, mappingId: string, target: string | null) =>
      importWizardFor(event).updateMapping(draftId, mappingId, target),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.queryRows, (event, request) => importWizardFor(event).queryRows(request));
  bus.handle(
    IMPORT_WIZARD_CHANNELS.patchCells,
    (event, draftId: string, category: ImportWizardCategory, patches) =>
      importWizardFor(event).patchCells(draftId, category, patches),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.addRow, (event, draftId: string, category: ImportWizardCategory) =>
    importWizardFor(event).addRow(draftId, category),
  );
  bus.handle(
    IMPORT_WIZARD_CHANNELS.deleteRows,
    (event, draftId: string, category: ImportWizardCategory, rowIds: string[]) =>
      importWizardFor(event).deleteRows(draftId, category, rowIds),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.validate, (event, draftId: string) => importWizardFor(event).validate(draftId));
  bus.handle(
    IMPORT_WIZARD_CHANNELS.saveConflictDecision,
    (event, draftId: string, issueId: string, value: string) =>
      importWizardFor(event).saveConflictDecision(draftId, issueId, value),
  );
  bus.handle(
    IMPORT_WIZARD_CHANNELS.cancelOperation,
    (event, draftId: string, operationId: string) => importWizardFor(event).cancelOperation(draftId, operationId),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.summary, (event, draftId: string) => importWizardFor(event).workspace(draftId));
  bus.handle(IMPORT_WIZARD_CHANNELS.commit, (event, draftId: string, seal: string) =>
    importWizardFor(event).commit(draftId, seal),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.settleInterrupted, (event, draftId: string) =>
    importWizardFor(event).settleInterrupted(draftId),
  );
  bus.handle(IMPORT_WIZARD_CHANNELS.recover, (event) => importWizardFor(event).recover());
  bus.handle(IMPORT_WIZARD_CHANNELS.checkpoints, (event, draftId: string) => importWizardFor(event).checkpoints(draftId));
  bus.handle(IMPORT_WIZARD_CHANNELS.undo, (event, draftId: string) => importWizardFor(event).undo(draftId));
  bus.handle(IMPORT_WIZARD_CHANNELS.redo, (event, draftId: string) => importWizardFor(event).redo(draftId));

  // ---- 移动只读发布（tasks 5.2）：统一受信 sender+会话守卫，错误规范化信封 ----

  bus.handle(MOBILE_READONLY_CHANNELS.status, (event) =>
    runMobileReadonlyEnveloped(() => mobileReadonlyFor(event, deps).getStatus()),
  );
  bus.handle(MOBILE_READONLY_CHANNELS.configure, (event, input: MobileReadonlyConfigureInput) =>
    runMobileReadonlyEnveloped(() => mobileReadonlyFor(event, deps).configure(input)),
  );
  bus.handle(MOBILE_READONLY_CHANNELS.setEnabled, (event, input: { enabled: boolean }) =>
    runMobileReadonlyEnveloped(() => mobileReadonlyFor(event, deps).setEnabled(Boolean(input?.enabled))),
  );
}
