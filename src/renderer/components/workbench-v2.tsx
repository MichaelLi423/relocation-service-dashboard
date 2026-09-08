import {
  createContext,
  useEffect,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import ExcelJS from "exceljs";
import type {
  AccountSessionInfo,
  AdjustableProjectStatus,
  DataCleanPrepareDto,
  InstrumentBulkImportRow,
  InstrumentUpdatePayload,
  ProjectStatus,
  ProjectTagCatalogDto,
  ProjectTagGroupSummaryDto,
  ProjectTagMutationRequestDto,
  ProjectSupplementPayload,
  ProjectUpdatePayload,
  ProjectWizardPayload,
  ReportDto,
  ReportFilterDto,
  WorkbenchActionPayload,
  WorkbenchActionType,
  WorkbenchApi,
  WorkbenchProjectRow,
  WorkbenchV2IndependentKind,
  WorkbenchV2IndependentPageDto,
  WorkbenchV2HistoryKind,
  WorkbenchV2HistoryPageDto,
  WorkbenchV2HistoryRow,
  WorkbenchV2InvalidateTag,
  WorkbenchV2LookupPageDto,
  WorkbenchV2LookupRow,
  WorkbenchV2MutationRequest,
  WorkbenchV2OverviewDto,
  WorkbenchV2ProjectDetailDto,
  WorkbenchV2ProjectPageDto,
  WorkbenchV2SectionKind,
  WorkbenchV2SectionPageDto,
  WorkbenchV2SectionRow,
  WorkbenchV2DeleteRequest,
  WorkbenchV2ReminderLaneRow,
  WorkbenchV2ReminderLanesDto,
  WorkbenchV2ReminderPageDto,
} from "../../shared/ipc";
import { PROJECT_REGIONS } from "../../shared/ipc";
import { MobileReadonlyControl } from "./mobile-readonly-control";
import {
  HistoryImportWizard,
  IpcHistoryImportProvider,
} from "../history-import";

const PAGE_SIZE = 50;
const PROJECT_PAGE_SIZE = 20;
const ZERO_CONTRACT_AMOUNT_GUIDANCE = "合同金额为 0 仍可正式进单；最终可确认金额可暂空，请在首次登记掉票前补录。";
const LayerHeaderActionsContext = createContext<HTMLElement | null>(null);

function LayerHeaderAction({ children }: { children: ReactNode }): ReactNode {
  const target = useContext(LayerHeaderActionsContext);
  return target ? createPortal(children, target) : null;
}
const QR_REQUEST_TYPES = [
  { code: "A", label: "A" },
  { code: "B", label: "B" },
  { code: "C", label: "C" },
  { code: "D", label: "D" },
  {
    code: "precise_instrument_packing_only",
    label: "仅打包搬运精密仪器",
  },
  { code: "oem_equipment", label: "OEM 设备" },
  { code: "temporary_label", label: "临时标签" },
  { code: "project_acceptance_form", label: "项目验收单" },
  { code: "logistics_management", label: "物流管理" },
] as const;
const QR_REQUEST_TYPE_LABEL = new Map<string, string>(
  QR_REQUEST_TYPES.map(({ code, label }) => [code, label]),
);
const STATUS_LABEL: Record<ProjectStatus, string> = {
  pending_entry: "待进单",
  pending_execution: "待执行",
  executing: "执行中",
  under_repair: "维修中",
  pending_acceptance: "待验收",
  pending_invoice: "待掉票",
  completed: "已完成",
  cancelled: "已取消",
};
const STAGES: AdjustableProjectStatus[] = [
  "pending_entry",
  "pending_execution",
  "executing",
  "under_repair",
  "pending_acceptance",
  "pending_invoice",
  "completed",
];

function focusWorkbenchSection(id: "reminders" | "project-queue"): void {
  const target = document.getElementById(id);
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "start" });
}

const TABS = [
  "搬迁仪器",
  "物流费用登记",
  "开单记录",
  "费用与掉票",
  "申请与维修",
] as const;
type DetailTab = (typeof TABS)[number];
type DeleteInput = WorkbenchV2DeleteRequest extends infer Request
  ? Request extends { expectedRevision: number }
    ? Omit<Request, "expectedRevision">
    : never
  : never;
const TAB_SECTION: Partial<Record<DetailTab, WorkbenchV2SectionKind>> = {
  搬迁仪器: "instruments",
  物流费用登记: "batches",
  开单记录: "orders",
  费用与掉票: "invoices",
  申请与维修: "damage_items",
};
const ACTIONS: Array<{
  type: WorkbenchActionType;
  label: string;
  help: string;
}> = [
  {
    type: "batch",
    label: "物流费用登记",
    help: "可先保存现有信息，运输安排、费用日期和价格后续均可补充修改",
  },
  {
    type: "instrument",
    label: "搬迁仪器",
    help: "名称、型号、序列号与 UPS",
  },
  { type: "order", label: "开单记录", help: "四类开单均关联当前项目，并计入工程师工作量" },
  {
    type: "acceptance",
    label: "验收报告",
    help: "记录报告形成日期并进入待掉票",
  },
  { type: "invoice", label: "掉票", help: "按 ECC 登记发生日期与金额" },
  {
    type: "ship_to",
    label: "Account ID 申请",
    help: "客户名称、新址地址与线性状态",
  },
  {
    type: "damage",
    label: "损坏/维修事项",
    help: "一次损坏、一个备件与维修过程",
  },
  {
    type: "core",
    label: "补齐进单核心资料",
    help: "在原项目补齐合同、ECC 与进单日期",
  },
];

type V2Method =
  | "v2Overview"
  | "v2ProjectPage"
  | "v2ProjectDetail"
  | "v2SectionPage"
  | "v2HistoryPage"
  | "v2IndependentPage"
  | "v2LookupPage"
  | "v2ReminderPage"
  | "v2ReminderLanes"
  | "v2Mutate";
function bridge(): WorkbenchApi | undefined {
  return (window as unknown as { workbench?: WorkbenchApi }).workbench;
}
function requireV2<K extends V2Method>(
  api: WorkbenchApi,
  name: K,
): NonNullable<WorkbenchApi[K]> {
  const method = api[name];
  if (!method)
    throw new Error(`当前工作台缺少 ${name}，已停止旧 snapshot 回退`);
  return method.bind(api) as NonNullable<WorkbenchApi[K]>;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): string {
  return messageOf(error).match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? "";
}
function mutationErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "WIZARD_DEPRECATED_FIELD") return "新建项目包含已移除字段，请关闭后重新打开表单。";
  if (code === "WIZARD_ECC_ONLY_FORMAL") return "ECC 仅可用于正式进单，请重新选择保存意图。";
  if (code === "WIZARD_ENTRY_AT_ONLY_FORMAL") return "进单日期仅可用于正式进单，请重新选择保存意图。";
  if (code === "WIZARD_CONTRACT_AMOUNT_ONLY_FORMAL") return "合同金额仅可在正式进单时提交，请重新选择保存意图。";
  const message = messageOf(error);
  return code ? message.replace(/^[A-Z][A-Z0-9_]+:\s*/, "") : message;
}
function deleteErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "DELETE_REJECTED_REVISION") return "数据已被其他操作更新，请刷新后重试。";
  if (code === "DELETE_REJECTED_NOT_FOUND") return "这条记录已不存在，列表将重新刷新。";
  if (code === "DELETE_REJECTED_DEPENDENCIES") return "这条记录已被其他业务数据使用，暂时不能删除。";
  if (code === "DELETE_REJECTED_STATUS_RECALC") return "该记录会影响项目状态，当前不支持删除。";
  if (code === "DELETE_REJECTED_INVOICE_REQUIRES_REVOKE") return "掉票记录不能直接删除，请填写日期和原因后撤销。";
  return "操作未完成，请刷新数据后重试。";
}
function cleanErrorMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "CLEAN_CONFIRM_TEXT_REQUIRED") return "确认文本不完整，请重新检查数据。";
  if (code === "CLEAN_NOT_PREPARED" || code === "CLEAN_TOKEN_MISMATCH") return "本次清理确认已失效，请重新检查数据。";
  if (code === "CLEAN_TOKEN_EXPIRED") return "本次清理确认已过期，请重新检查数据。";
  if (code === "CLEAN_REVISION_CHANGED") return "检查后业务数据发生了变化，请重新检查数据。";
  if (code === "CLEAN_BACKUP_FAILED") return "安全备份未完成，清理已停止。请重新检查数据。";
  return "清理未完成；安全备份可能已经生成，请重新检查数据后再操作。";
}
function businessDate(value?: string | null): string {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}
function todayDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function money(value: string | null, currency = "USD"): string {
  if (value === null || value === "") return "待补";
  const negative = value.startsWith("-");
  const abs = negative ? value.slice(1) : value;
  const [units, fraction = "00"] = abs.split(".");
  return `${currency} ${negative ? "-" : ""}${units.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(fraction + "00").slice(0, 2)}`;
}
function centsOf(value: string | null): bigint {
  if (!value) return 0n;
  const negative = value.startsWith("-");
  const [units = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const cents = BigInt(units || "0") * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -cents : cents;
}
function decimalOf(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function pendingInvoiceAmount(finalAmount: string | null, invoicedAmount: string): string | null {
  if (finalAmount === null || finalAmount === "") return null;
  return decimalOf(centsOf(finalAmount) > centsOf(invoicedAmount) ? centsOf(finalAmount) - centsOf(invoicedAmount) : 0n);
}
function isoDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

interface Filters {
  status: ProjectStatus | "";
  repair: "" | "open";
  reminder: "" | "any" | "overdue" | "today" | "upcoming";
  region: string;
  query: string;
}
type LayerState =
  | { kind: "new" | "quick" | "reminder" | "reminder-all" | "cancel" | "report" | "history" | "clean" | "tags" | "edit-project" | "correct-entry" }
  | {
      kind: "edit-project-tags";
      projectId: string;
      source: "detail" | "queue";
      customerName: string;
      identifier: string;
      tagIds: readonly string[];
    }
  | { kind: "action"; action: WorkbenchActionType }
  | { kind: "independent"; module: WorkbenchV2IndependentKind }
  | {
      kind: "invoice-edit" | "invoice-revoke";
      invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>;
    }
  | {
      kind: "batch-edit";
      batch: Extract<WorkbenchV2SectionRow, { kind: "batches" }>;
    }
  | {
      kind: "damage-update";
      damage: Extract<WorkbenchV2SectionRow, { kind: "damage_items" }>;
    }
  | {
      kind: "order-note-edit";
      order: Extract<WorkbenchV2SectionRow, { kind: "orders" }>;
    };

type TagRenameMutation = Extract<ProjectTagMutationRequestDto, { command: "rename_group" | "rename_tag" }>;
type InstrumentEditValues = Omit<InstrumentUpdatePayload, "instrumentId">;
type VisitSort = "asc" | "desc" | null;

function updateProjectRequest(payload: ProjectUpdatePayload): WorkbenchV2MutationRequest {
  return { op: "update_project", payload };
}

type BatchEditValues = {
  planTransportDate: string | null;
  transportCompany: string | null;
  appliedAt: string | null;
  budgetPrice: string | null;
  dealPrice: string | null;
};

function batchEditRequest(
  batchId: string,
  batchEdit: BatchEditValues,
): WorkbenchV2MutationRequest {
  return { op: "batch_edit", payload: { batchId, ...batchEdit } } as WorkbenchV2MutationRequest;
}

function instrumentBulkImportRequest(
  projectId: string,
  rows: InstrumentBulkImportRow[],
): WorkbenchV2MutationRequest {
  return { op: "instrument_bulk_import", payload: { projectId, rows } };
}

function damageUpdateRequest(
  damageId: string,
  issueStatus: string,
  closeReason?: string,
): WorkbenchV2MutationRequest {
  return {
    op: "damage_update",
    damageId,
    issueStatus,
    ...(issueStatus === "closed_unrepaired" ? { closeReason } : {}),
  };
}

export function WorkbenchV2({
  session,
  autoBackupError,
  onSessionRestored,
}: {
  session: AccountSessionInfo;
  autoBackupError?: string;
  /** 恢复备份后主进程可能改用不同账号（如备份中的既有账号），回调同步会话展示。 */
  onSessionRestored?: (session: AccountSessionInfo) => void;
}): JSX.Element {
  const [overview, setOverview] = useState<WorkbenchV2OverviewDto | null>(null);
  const [projectPage, setProjectPage] =
    useState<WorkbenchV2ProjectPageDto | null>(null);
  const [filters, setFilters] = useState<Filters>({
    status: "",
    repair: "",
    reminder: "",
    region: "",
    query: "",
  });
  const [draftFilters, setDraftFilters] = useState(filters);
  const [visitSort, setVisitSort] = useState<VisitSort>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkbenchV2ProjectDetailDto | null>(
    null,
  );
  const [tab, setTab] = useState<DetailTab>("搬迁仪器");
  const [sectionPage, setSectionPage] =
    useState<WorkbenchV2SectionPageDto | null>(null);
  const [sectionCursors, setSectionCursors] = useState<Array<string | null>>([
    null,
  ]);
  const [loading, setLoading] = useState({
    overview: true,
    projects: true,
    detail: false,
    section: false,
  });
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toast, setToast] = useState("");
  const [warningToast, setWarningToast] = useState("");
  const [layer, setLayer] = useState<LayerState | null>(null);
  const [tagEditGuard, setTagEditGuard] = useState({ dirty: false, busy: false });
  const [historyImport, setHistoryImport] = useState(false);
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [dataMenuPosition, setDataMenuPosition] = useState({ top: 0, left: 12, width: 192 });
  const [independentRefresh, setIndependentRefresh] = useState(0);
  const [reminderRefresh, setReminderRefresh] = useState(0);
  const [tagCatalog, setTagCatalog] = useState<ProjectTagCatalogDto | null>(null);
  const [tagCatalogLoading, setTagCatalogLoading] = useState(true);
  const [tagCatalogError, setTagCatalogError] = useState("");
  const revision = useRef(0);
  const requests = useRef({ projects: 0, detail: 0, section: 0, overview: 0 });
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const importTrigger = useRef<HTMLButtonElement>(null);
  const dataMenuTrigger = useRef<HTMLButtonElement>(null);
  const dataMenuPanel = useRef<HTMLDivElement>(null);
  const layerCloseRequest = useRef<(trigger?: HTMLElement | null) => void>(() => undefined);
  /** 提醒跳转/新建成功后钉住的目标项目：即使不在当前页也不被 loadProjects 重置选中。 */
  const selectionPin = useRef("");

  const currentPageIndex = cursorStack.length - 1;
  const currentSectionIndex = sectionCursors.length - 1;
  const selected =
    detail?.project ??
    projectPage?.projects.find((project) => project.id === selectedId) ??
    null;

  useEffect(() => {
    if (!dataMenuOpen || historyImport) return;
    const updatePosition = () => {
      const trigger = dataMenuTrigger.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = 192;
      setDataMenuPosition({
        top: rect.bottom + 6,
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
        width,
      });
    };
    const closeFromOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dataMenuTrigger.current?.contains(target) || dataMenuPanel.current?.contains(target)) return;
      setDataMenuOpen(false);
    };
    const closeFromKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDataMenuOpen(false);
      dataMenuTrigger.current?.focus();
    };
    updatePosition();
    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [dataMenuOpen, historyImport]);

  function acceptBusinessRevision(next: number): boolean {
    if (next < revision.current) return false;
    revision.current = Math.max(revision.current, next);
    return true;
  }

  async function loadOverview(): Promise<void> {
    const id = ++requests.current.overview;
    setLoading((old) => ({ ...old, overview: true }));
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(api, "v2Overview")();
      if (
        id === requests.current.overview &&
        acceptBusinessRevision(next.businessRevision)
      )
        setOverview(next);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (id === requests.current.overview)
        setLoading((old) => ({ ...old, overview: false }));
    }
  }

  async function loadTagCatalog(): Promise<void> {
    setTagCatalogLoading(true);
    setTagCatalogError("");
    try {
      const api = bridge();
      if (!api?.v2TagCatalog) throw new Error("当前环境暂不支持项目分类标签");
      const next = await api.v2TagCatalog();
      revision.current = Math.max(revision.current, next.businessRevision);
      setTagCatalog(next);
    } catch (cause) {
      setTagCatalogError(messageOf(cause));
    } finally {
      setTagCatalogLoading(false);
    }
  }

  async function loadProjects(
    cursor: string | null,
    pageIndex: number,
    focusId?: string,
    filterOverride?: Filters,
    propagateError = false,
  ): Promise<void> {
    const id = ++requests.current.projects;
    setLoading((old) => ({ ...old, projects: true }));
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const effective = filterOverride ?? filters;
      const next = await requireV2(
        api,
        "v2ProjectPage",
      )({
        cursor,
        status: effective.status || null,
        reminder: effective.reminder || null,
        region: effective.region.trim() || null,
        query: effective.query.trim() || null,
        repair: effective.repair || null,
        sort: visitSort ? `visit_${visitSort}` : null,
      });
      if (
        id !== requests.current.projects ||
        !acceptBusinessRevision(next.businessRevision)
      )
        return;
      setProjectPage(next);
      setSelectedId((current) => {
        if (next.projects.some((project) => project.id === current)) {
          // 目标已在当前页，解除钉住（提醒/新建跳转已完成定位）。
          if (selectionPin.current === current) selectionPin.current = "";
          return current;
        }
        if (selectionPin.current) return selectionPin.current;
        return next.projects[0]?.id ?? "";
      });
      setNotice(
        next.total
          ? `已显示第 ${pageIndex * next.limit + 1} 至 ${Math.min((pageIndex + 1) * next.limit, next.total)} 项，共 ${next.total} 项`
          : "当前筛选没有项目",
      );
      requestAnimationFrame(() => {
        const target = focusId === "__first__" || (focusId && !next.projects.some((project) => project.id === focusId)) ? next.projects[0]?.id : focusId;
        if (target) rowRefs.current.get(target)?.focus();
      });
    } catch (cause) {
      setError(messageOf(cause));
      if (propagateError) throw cause;
    } finally {
      if (id === requests.current.projects)
        setLoading((old) => ({ ...old, projects: false }));
    }
  }

  async function loadDetail(projectId: string, propagateError = false): Promise<void> {
    const id = ++requests.current.detail;
    setLoading((old) => ({ ...old, detail: true }));
    setDetailError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(api, "v2ProjectDetail")(projectId);
      if (
        id === requests.current.detail &&
        projectId === selectedId &&
        acceptBusinessRevision(next.businessRevision)
      )
        setDetail(next);
    } catch (cause) {
      if (id === requests.current.detail) setDetailError(messageOf(cause));
      if (propagateError) throw cause;
    } finally {
      if (id === requests.current.detail)
        setLoading((old) => ({ ...old, detail: false }));
    }
  }

  async function loadSection(
    projectId: string,
    kind: WorkbenchV2SectionKind,
    cursor: string | null,
  ): Promise<void> {
    const id = ++requests.current.section;
    setLoading((old) => ({ ...old, section: true }));
    setDetailError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2SectionPage",
      )({ projectId, kind, limit: PAGE_SIZE, cursor });
      if (
        id === requests.current.section &&
        projectId === selectedId &&
        TAB_SECTION[tab] === kind &&
        acceptBusinessRevision(next.businessRevision)
      ) setSectionPage(next);
    } catch (cause) {
      if (id === requests.current.section) setDetailError(messageOf(cause));
    } finally {
      if (id === requests.current.section)
        setLoading((old) => ({ ...old, section: false }));
    }
  }

  useEffect(() => {
    void loadOverview();
    void loadTagCatalog();
  }, []);
  useEffect(() => {
    setCursorStack([null]);
    void loadProjects(null, 0);
  }, [filters.status, filters.repair, filters.reminder, filters.region, filters.query, visitSort]);
  useEffect(() => {
    setDetail(null);
    setSectionPage(null);
    setSectionCursors([null]);
    setTab("搬迁仪器");
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId]);
  useEffect(() => {
    const kind = TAB_SECTION[tab];
    setSectionPage(null);
    setSectionCursors([null]);
    if (selectedId && kind) void loadSection(selectedId, kind, null);
  }, [tab, selectedId]);

  async function refreshInvalidated(
    tags: readonly WorkbenchV2InvalidateTag[],
    changedProjectId?: string,
    filterOverride?: Filters,
  ): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (tags.includes("overview")) jobs.push(loadOverview());
    if (tags.includes("projects"))
      jobs.push(
        loadProjects(
          filterOverride ? null : (cursorStack.at(-1) ?? null),
          filterOverride ? 0 : currentPageIndex,
          changedProjectId ?? selectedId,
          filterOverride,
        ),
      );
    if (
      selectedId &&
      (tags.includes("projects") || tags.includes(`project:${selectedId}`))
    )
      jobs.push(loadDetail(selectedId));
    if (
      selectedId &&
      tags.includes(`sections:${selectedId}`) &&
      TAB_SECTION[tab]
    )
      jobs.push(
        loadSection(
          selectedId,
          TAB_SECTION[tab]!,
          sectionCursors.at(-1) ?? null,
        ),
      );
    if (
      tags.includes("independent:serial_address") ||
      tags.includes("independent:qr_request")
    )
      setIndependentRefresh((value) => value + 1);
    if (tags.includes("reminders")) setReminderRefresh((value) => value + 1);
    if (tags.includes("tag_catalog")) jobs.push(loadTagCatalog());
    await Promise.all(jobs);
  }

  async function mutate(
    request: WorkbenchV2MutationRequest,
    success: string,
  ): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await requireV2(api, "v2Mutate")(request);
      revision.current = Math.max(revision.current, result.businessRevision);
      let cleared: Filters | undefined;
      if (
        request.op === "create_project" &&
        result.changed?.created &&
        result.changed.projectId
      ) {
        // 新建成功：清除可能隐藏新项目的筛选、回到首屏，并钉住返回的项目 id 自动选中。
        cleared = { status: "", repair: "", reminder: "", region: "", query: "" };
        selectionPin.current = result.changed.projectId;
        setDraftFilters(cleared);
        setFilters(cleared);
        setCursorStack([null]);
        setSelectedId(result.changed.projectId);
      }
      await refreshInvalidated(result.invalidated, result.changed?.projectId, cleared);
      setLayer(null);
      setToast(success);
      window.setTimeout(() => setToast(""), 2800);
    } catch (cause) {
      throw new Error(mutationErrorMessage(cause));
    }
  }

  async function mutateRecord(request: WorkbenchV2MutationRequest, success: string): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.v2Mutate(request);
      revision.current = Math.max(revision.current, result.businessRevision);
      const projectId = selectedId;
      await Promise.all([
        loadProjects(cursorStack.at(-1) ?? null, currentPageIndex, projectId || undefined, undefined, true),
        ...(projectId ? [loadDetail(projectId, true)] : []),
        ...(projectId && TAB_SECTION[tab]
          ? [loadSection(projectId, TAB_SECTION[tab]!, sectionCursors.at(-1) ?? null)]
          : []),
      ]);
      setLayer(null);
      setToast(success);
      window.setTimeout(() => setToast(""), 2800);
    } catch (cause) {
      throw new Error(mutationErrorMessage(cause));
    }
  }

  async function renameCatalogItem(request: TagRenameMutation): Promise<void> {
    const api = bridge();
    if (!api?.v2TagMutate) throw new Error("当前环境暂不支持维护标签库");
    try {
      const result = await api.v2TagMutate(request);
      revision.current = Math.max(revision.current, result.businessRevision);
      await refreshInvalidated(result.invalidated, selectedId || undefined);
    } catch (cause) {
      throw new Error(mutationErrorMessage(cause));
    }
  }

  function showWarning(message: string): void {
    setWarningToast(message);
    window.setTimeout(() => setWarningToast(""), 4200);
  }

  async function saveProjectTags(projectId: string, tagIds: readonly string[]): Promise<void> {
    const api = bridge();
    if (!api) throw new Error("当前环境未连接主进程");
    let result: Awaited<ReturnType<NonNullable<WorkbenchApi["v2Mutate"]>>>;
    try {
      result = await requireV2(api, "v2Mutate")(
        updateProjectRequest({ projectId, tagIds }),
      );
      revision.current = Math.max(revision.current, result.businessRevision);
    } catch (cause) {
      throw new Error(mutationErrorMessage(cause));
    }

    try {
      const jobs: Promise<void>[] = [
        loadProjects(cursorStack.at(-1) ?? null, currentPageIndex, undefined, undefined, true),
      ];
      if (projectId === selectedId) jobs.push(loadDetail(projectId, true));
      await Promise.all(jobs);
      setLayer(null);
      setToast("项目标签已保存");
      window.setTimeout(() => setToast(""), 2800);
    } catch {
      setLayer(null);
      showWarning("标签已保存，部分视图刷新失败，请使用页面中的重试操作重新读取。");
    }
  }

  async function deleteRecord(
    request: DeleteInput,
    success: string,
    closeLayer = true,
  ): Promise<void> {
    try {
      const api = bridge();
      if (!api?.v2Delete) throw new Error("当前环境暂不支持移除记录");
      const result = await api.v2Delete({ ...request, expectedRevision: revision.current } as WorkbenchV2DeleteRequest);
      revision.current = Math.max(revision.current, result.businessRevision);
      await refreshInvalidated(result.invalidated, result.changed?.projectId);
      if (closeLayer) setLayer(null);
      setToast(success);
      window.setTimeout(() => setToast(""), 2800);
    } catch (cause) {
      if (request.kind === "acceptance" && errorCode(cause) === "DELETE_REJECTED_DEPENDENCIES") {
        throw new Error("项目已有掉票历史，不能删除验收记录。");
      }
      throw new Error(deleteErrorMessage(cause));
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    selectionPin.current = "";
    setFilters({ ...draftFilters });
  }
  function resetFilters(): void {
    const next: Filters = { status: "", repair: "", reminder: "", region: "", query: "" };
    selectionPin.current = "";
    setDraftFilters(next);
    setFilters(next);
  }
  function selectReminder(item: {
    projectId: string;
    customerName: string;
    ecc: string | null;
    tempNo: string;
  }): void {
    const query = item.ecc ?? item.tempNo ?? item.customerName;
    // 钉住提醒目标：即使新筛选下不在当前页，也保持选中并继续按 id 读取详情。
    selectionPin.current = item.projectId;
    setFilters({ status: "", repair: "", reminder: "any", region: "", query });
    setDraftFilters({ status: "", repair: "", reminder: "any", region: "", query });
    setSelectedId(item.projectId);
    document.getElementById("project-queue")?.focus();
  }

  function queueKey(
    event: KeyboardEvent<HTMLTableRowElement>,
    index: number,
  ): void {
    if (event.target !== event.currentTarget) return;
    selectionPin.current = "";
    const rows = projectPage?.projects ?? [];
    if (!rows.length) return;
    let target = index;
    if (event.key === "ArrowDown")
      target = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") target = Math.max(0, index - 1);
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = rows.length - 1;
    else if (event.key === "PageDown") {
      event.preventDefault();
      void nextProjectPage(true);
      return;
    } else if (event.key === "PageUp") {
      event.preventDefault();
      void previousProjectPage(true);
      return;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSelectedId(rows[index]!.id);
      return;
    } else return;
    event.preventDefault();
    const project = rows[target]!;
    setSelectedId(project.id);
    rowRefs.current.get(project.id)?.focus();
  }

  async function nextProjectPage(focus = false): Promise<void> {
    if (!projectPage?.nextCursor) return;
    selectionPin.current = "";
    const stack = [...cursorStack, projectPage.nextCursor];
    setCursorStack(stack);
    await loadProjects(
      projectPage.nextCursor,
      stack.length - 1,
      focus ? "__first__" : undefined,
    );
  }
  async function previousProjectPage(focus = false): Promise<void> {
    if (cursorStack.length <= 1) return;
    selectionPin.current = "";
    const stack = cursorStack.slice(0, -1);
    const cursor = stack.at(-1) ?? null;
    setCursorStack(stack);
    await loadProjects(
      cursor,
      stack.length - 1,
      focus ? "__first__" : undefined,
    );
  }

  async function runBackup(): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.backupManual();
      if (!result.canceled) {
        setToast("手动备份已保存");
        window.setTimeout(() => setToast(""), 2800);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function runRestore(): Promise<void> {
    if (!window.confirm("恢复备份会用备份文件替换当前本地数据。是否继续？"))
      return;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const result = await api.restoreFromBackup();
      if (result.restored) {
        // 无密码模式：主进程恢复后已重新取得/确保本地账号并恢复会话。
        const refreshed = await api.getSession();
        if (refreshed) onSessionRestored?.(refreshed);
        // 直接重读工作台数据（恢复的库 revision 可能更低，先重置修订水位）。
        revision.current = 0;
        selectionPin.current = "";
        setLayer(null);
        setSelectedId("");
        setCursorStack([null]);
        setDetail(null);
        setSectionPage(null);
        setSectionCursors([null]);
        setTab("搬迁仪器");
        setToast("备份已恢复，数据已重新加载");
        window.setTimeout(() => setToast(""), 2800);
        void Promise.all([loadOverview(), loadProjects(null, 0), loadTagCatalog()]);
      }
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  if (historyImport) {
    return (
      <HistoryImportWizard
        provider={new IpcHistoryImportProvider()}
        username={session.username}
        onExit={() => {
          setHistoryImport(false);
          setCursorStack([null]);
          void Promise.all([loadOverview(), loadProjects(null, 0)]);
          requestAnimationFrame(() => importTrigger.current?.focus());
        }}
      />
    );
  }

  const metrics = overview
    ? [
        [
          "活跃搬迁项目",
          String(overview.metrics.activeProjects),
          `共 ${overview.metrics.totalProjects} 个项目`,
        ],
        [
          "当前项目提醒",
          String(overview.metrics.reminderCount),
          `逾期 ${overview.metrics.reminderOverdue} · 今日 ${overview.metrics.reminderToday}`,
        ],
        [
          "待掉票金额",
          money(overview.metrics.pendingAmount),
          "按最终可确认金额计算",
        ],
        [
          "待验收 / 待掉票",
          `${overview.metrics.pendingAcceptance} / ${overview.metrics.pendingInvoice}`,
          "按当前项目状态统计",
        ],
      ]
    : [];
  return (
    <div className="app-shell workbench-v2">
      <header className="topbar">
        <a className="brand" href="#main">
          <span className="brand-mark small">RW</span>
          <span>搬迁服务工作台</span>
        </a>
        <nav aria-label="主导航">
          <button onClick={() => focusWorkbenchSection("reminders")}>
            项目提醒
          </button>
          <button
            onClick={() => focusWorkbenchSection("project-queue")}
          >
            项目队列
          </button>
          <button
            onClick={() =>
              setLayer({ kind: "independent", module: "serial_address" })
            }
          >
            序列号地址更新
          </button>
          <button
            onClick={() =>
              setLayer({ kind: "independent", module: "qr_request" })
            }
          >
            二维码申请
          </button>
          <button onClick={() => setLayer({ kind: "history" })}>浏览全部记录</button>
          <button onClick={() => setLayer({ kind: "report" })}>运营报表</button>
          <button onClick={() => setLayer({ kind: "tags" })}>标签库</button>
          <MobileReadonlyControl />
          <div className="data-menu">
            <button
              ref={dataMenuTrigger}
              className="data-menu-trigger"
              type="button"
              aria-haspopup="true"
              aria-expanded={dataMenuOpen}
              onClick={() => setDataMenuOpen((open) => !open)}
            >
              数据管理
            </button>
            {dataMenuOpen && createPortal(
              <div
                ref={dataMenuPanel}
                className="data-menu-panel"
                role="region"
                aria-label="数据管理"
                style={dataMenuPosition}
              >
              <button
                ref={importTrigger}
                onClick={() => setHistoryImport(true)}
              >
                历史数据导入
              </button>
              <button onClick={() => { setDataMenuOpen(false); void runBackup(); }}>手动备份</button>
              <button className="danger-text" onClick={() => { setDataMenuOpen(false); void runRestore(); }}>
                恢复备份
              </button>
              <div className="data-menu-divider" />
              <button onClick={() => { setDataMenuOpen(false); setLayer({ kind: "tags" }); }}>
                管理标签库
              </button>
              <div className="data-menu-divider" />
              <button className="danger-text" onClick={() => { setDataMenuOpen(false); setLayer({ kind: "clean" }); }}>
                清理全部业务数据
              </button>
              </div>,
              document.body,
            )}
          </div>
        </nav>
        <div className="account-chip">
          <span aria-hidden="true">●</span>
          {session.username}
        </div>
      </header>
      <main id="main" className="page">
        <section className="command" aria-label="今日工作台">
          <div>
            <p className="overline">今日工作台</p>
            <h1>把每一次搬迁，推进得更稳</h1>
            <p>提醒、队列和关键事项，都在这里。</p>
          </div>
          <div className="row-actions">
            <button
              className="button"
              disabled={!selected}
              onClick={() => setLayer({ kind: "quick" })}
            >
              快速记录
            </button>
            <button
              className="button primary"
              onClick={() => setLayer({ kind: "new" })}
            >
              新建搬迁项目
            </button>
          </div>
        </section>
        {error && (
          <div className="page-error" role="alert">
            {error}
            <button
              onClick={() => {
                setError("");
                void Promise.all([
                  loadOverview(),
                  loadProjects(cursorStack.at(-1) ?? null, currentPageIndex),
                ]);
              }}
            >
              重试
            </button>
          </div>
        )}
        {autoBackupError && (
          <div className="inline-warning full" role="status">
            自动备份失败：{autoBackupError}
            。工作台仍可正常使用，请及时手动备份。
          </div>
        )}
        <section
          className="metrics panel"
          aria-label="关键运营指标"
          aria-busy={loading.overview}
        >
          {loading.overview && !overview && (
            <div className="metrics-loading" role="status">
              正在读取工作台概况…
            </div>
          )}
          {metrics.map(([label, value, meta]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{meta}</small>
            </div>
          ))}
        </section>
        <section className="panel lifecycle" aria-labelledby="lifecycle-title">
          <div className="panel-head">
            <div>
              <h2 id="lifecycle-title">生命周期吞吐</h2>
              <p>点击阶段筛选主项目队列</p>
            </div>
            <button
              className="text-action"
              onClick={() => {
                selectionPin.current = "";
                setDraftFilters((old) => ({ ...old, status: "", repair: "" }));
                setFilters((old) => ({ ...old, status: "", repair: "" }));
              }}
              aria-pressed={!filters.status && !filters.repair}
            >
              全部项目
            </button>
          </div>
          <div className="stages">
            {overview?.stages.map((item) => (
              <button
                key={item.status}
                className={`stage ${item.status === "pending_entry" ? "not-entered" : ""} ${filters.status === item.status ? "active" : ""}`}
                aria-pressed={filters.status === item.status}
                onClick={() => {
                  selectionPin.current = "";
                  setDraftFilters((old) => ({ ...old, status: item.status, repair: "" }));
                  setFilters((old) => ({ ...old, status: item.status, repair: "" }));
                }}
              >
                <span>{STATUS_LABEL[item.status]}</span>
                <strong>{item.count}</strong>
                <small>平均 {item.averageDays} 天</small>
              </button>
            ))}
          </div>
        </section>
        <section
          id="reminders"
          tabIndex={-1}
          className="panel reminder-panel"
          aria-labelledby="reminder-title"
        >
          <div className="panel-head">
            <div>
              <h2 id="reminder-title">
                待办提醒 {overview?.reminderTotal ?? 0}
              </h2>
              <p>按提醒日期查看需要跟进的项目</p>
            </div>
            <button
              className="text-action"
              onClick={() => setLayer({ kind: "reminder-all" })}
            >
              查看全部
            </button>
          </div>
          <ReminderLanes refreshToken={reminderRefresh} onSelect={selectReminder} />
        </section>
        <section className="project-workspace" aria-label="项目工作区">
          <ProjectContext
            project={selected}
            detail={detail}
            loading={loading.detail}
            repairOpen={filters.repair === "open"}
            openRepairProjects={overview?.metrics.openRepairProjects ?? 0}
            onQuick={() => setLayer({ kind: "quick" })}
            onReminder={() => setLayer({ kind: "reminder" })}
            onCancel={() => setLayer({ kind: "cancel" })}
            onStatus={(status) => void mutate(
              { op: "adjust_status", projectId: selectedId, status },
              "项目主状态已通过生命周期校验并更新",
            )}
            onRepairFilter={() => {
              selectionPin.current = "";
              const nextRepair = filters.repair === "open" ? "" : "open";
              setDraftFilters((old) => ({ ...old, status: "", repair: nextRepair }));
              setFilters((old) => ({ ...old, status: "", repair: nextRepair }));
            }}
          />
          <ProjectDetails
            project={selected}
            detail={detail}
            detailReady={Boolean(selected && detail?.project?.id === selected.id)}
            tab={tab}
            section={sectionPage}
            loading={loading.detail || loading.section}
            error={detailError}
            pageIndex={currentSectionIndex}
            onTab={setTab}
            onRetry={() => {
              if (!selectedId) return;
              if (detail?.project?.id !== selectedId) {
                void loadDetail(selectedId);
                return;
              }
              const kind = TAB_SECTION[tab];
              if (kind) void loadSection(selectedId, kind, sectionCursors.at(-1) ?? null);
              else void loadDetail(selectedId);
            }}
            onAction={(action) => setLayer({ kind: "action", action })}
            onEditProject={() => {
              if (!selected || detail?.project?.id !== selected.id) return;
              setLayer({ kind: "edit-project" });
            }}
            onEditTags={() => {
              if (!selected) return;
              setTagEditGuard({ dirty: false, busy: false });
              setLayer({
                kind: "edit-project-tags",
                projectId: selected.id,
                source: "detail",
                customerName: selected.customerName,
                identifier: selected.ecc || selected.tempNo,
                tagIds: [...(detail?.tagIds ?? selected.tagIds ?? [])],
              });
            }}
            onCorrectEntry={() => setLayer({ kind: "correct-entry" })}
            onCompleteEntry={() => setLayer({ kind: "action", action: "core" })}
            onNext={() => {
              if (!sectionPage?.nextCursor || !selectedId) return;
              const next = [...sectionCursors, sectionPage.nextCursor];
              setSectionCursors(next);
              void loadSection(selectedId, TAB_SECTION[tab]!, sectionPage.nextCursor);
            }}
            onPrevious={() => {
              if (sectionCursors.length <= 1 || !selectedId) return;
              const next = sectionCursors.slice(0, -1);
              setSectionCursors(next);
              void loadSection(selectedId, TAB_SECTION[tab]!, next.at(-1) ?? null);
            }}
            onInvoiceEdit={(invoice) => setLayer({ kind: "invoice-edit", invoice })}
            onInvoiceRevoke={(invoice) => setLayer({ kind: "invoice-revoke", invoice })}
            onBatchEdit={(batch) => setLayer({ kind: "batch-edit", batch })}
            onDamageUpdate={(damage) => setLayer({ kind: "damage-update", damage })}
            onInstrumentSave={(instrument, values) =>
              mutateRecord(
                { op: "instrument_update", payload: { instrumentId: instrument.id, ...values } },
                "仪器资料已更新",
              )
            }
            onOrderNoteEdit={(order) => setLayer({ kind: "order-note-edit", order })}
            onDelete={(kind, id) => {
              if (!window.confirm("删除后无法恢复，确认删除这条记录？")) return;
              void deleteRecord({ kind, id } as DeleteInput, "记录已删除").catch((cause) => setDetailError(messageOf(cause)));
            }}
          />
        </section>
        <section
          id="project-queue"
          tabIndex={-1}
          className="panel queue"
          aria-labelledby="queue-title"
        >
          <div className="panel-head queue-heading">
            <div>
              <h2 id="queue-title">
                {projectPage ? `项目队列 ${projectPage.total}` : "正在读取项目…"}
              </h2>
            </div>
            <span className="queue-range" aria-live="polite">
              {notice}
            </span>
          </div>
          <form className="queue-filters" onSubmit={applyFilters}>
            <label>
              主状态
              <select
                value={draftFilters.status}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    status: event.target.value as ProjectStatus | "",
                    repair: "",
                  }))
                }
              >
                <option value="">全部状态</option>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              提醒
              <select
                value={draftFilters.reminder}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    reminder: event.target.value as Filters["reminder"],
                  }))
                }
              >
                <option value="">全部项目</option>
                <option value="any">有提醒</option>
                <option value="overdue">已逾期</option>
                <option value="today">今日到期</option>
                <option value="upcoming">临期</option>
              </select>
            </label>
            <label>
              区域
              <select
                value={draftFilters.region}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    region: event.target.value,
                  }))
                }
              >
                <option value="">全部区域</option>
                {PROJECT_REGIONS.map((region) => <option value={region} key={region}>{region}</option>)}
              </select>
            </label>
            <label className="queue-query">
              查找项目
              <input
                type="search"
                placeholder="客户 / ECC / 临时编号等"
                title="支持客户、ECC、临时编号、单号、工程师及更多项目资料模糊查询"
                value={draftFilters.query}
                onChange={(event) =>
                  setDraftFilters((old) => ({
                    ...old,
                    query: event.target.value,
                  }))
                }
              />
            </label>
            <button className="button primary">筛选</button>
            <button className="button" type="button" onClick={resetFilters}>
              清除
            </button>
          </form>
          <div className="queue-table-wrap" aria-busy={loading.projects}>
            <table className="project-table" role="grid" aria-label="项目队列">
              <thead>
                <tr>
                  <th>客户 / ECC</th>
                  <th>主状态</th>
                  <th>区域</th>
                  <th>提醒</th>
                  <th aria-sort={visitSort === "asc" ? "ascending" : visitSort === "desc" ? "descending" : "none"}>
                    <button
                      type="button"
                      className="queue-sort-button"
                      aria-label={`上门时间，${visitSort === "asc" ? "当前升序，点击切换为降序" : visitSort === "desc" ? "当前降序，点击切换为升序" : "当前未排序，点击按升序排列"}`}
                      onClick={() => setVisitSort((current) => current === "asc" ? "desc" : "asc")}
                    >
                      <span>上门时间</span>
                      <span className={visitSort ? "sort-direction active" : "sort-direction"} aria-hidden="true">
                        {visitSort === "asc" ? "升序 ↑" : visitSort === "desc" ? "降序 ↓" : "↕"}
                      </span>
                    </button>
                  </th>
                  <th>批次 / 仪器</th>
                  <th>累计掉票</th>
                  <th>更新时间</th>
                  <th>就近录入</th>
                </tr>
              </thead>
              <tbody>
                {projectPage?.projects.map((project, index) => (
                  <tr
                    key={project.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(project.id, node);
                      else rowRefs.current.delete(project.id);
                    }}
                    className={`project-status-${project.status.replaceAll("_", "-")}`}
                    tabIndex={project.id === selectedId ? 0 : -1}
                    aria-selected={project.id === selectedId}
                    onFocus={(event) => {
                      if (event.target !== event.currentTarget) return;
                      selectionPin.current = "";
                      setSelectedId(project.id);
                    }}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "button, a, input, select, textarea",
                        )
                      )
                        return;
                      selectionPin.current = "";
                      setSelectedId(project.id);
                    }}
                    onKeyDown={(event) => queueKey(event, index)}
                  >
                    <td>
                      <strong>{project.customerName}</strong>
                      <small>{project.ecc ?? project.tempNo}</small>
                      {!project.formallyEntered && <em>未进单</em>}
                      {project.preEntryExecution && (
                        <em className="warning">未进单先执行</em>
                      )}
                      {project.nonBlocking.repairs > 0 && (
                        <span className="tag warning">未关闭维修事项 {project.nonBlocking.repairs} 条</span>
                      )}
                      <GroupedTags groups={project.groupedTags} compact />
                    </td>
                    <td>
                      <StatusBadge status={project.status} />
                    </td>
                    <td>{project.region || "待补"}{project.regionNeedsAdjustment && <span className="legacy-region-tag">待调整</span>}</td>
                    <td>
                      {project.reminderAt
                        ? businessDate(project.reminderAt)
                        : project.reminderNote || "—"}
                    </td>
                    <td>{project.planVisitAt || "—"}</td>
                    <td>
                      {project.counts.batches} / {project.counts.instruments}
                    </td>
                    <td>{money(project.invoicedAmount)}</td>
                    <td>
                      {new Date(project.updatedAt).toLocaleDateString("zh-CN")}
                    </td>
                    <td>
                      <div className="queue-row-actions queue-entry-actions">
                        <button
                          className="text-action row-quick-action"
                          aria-label={`为${project.customerName}快速记录`}
                          onClick={(event) => {
                            event.stopPropagation();
                            selectionPin.current = "";
                            setSelectedId(project.id);
                            setLayer({ kind: "quick" });
                          }}
                        >
                          记录
                        </button>
                        <button
                          className="text-action row-quick-action"
                          aria-label={`编辑${project.customerName}的项目标签`}
                          onClick={(event) => {
                            event.stopPropagation();
                            event.currentTarget.focus();
                            setTagEditGuard({ dirty: false, busy: false });
                            setLayer({
                              kind: "edit-project-tags",
                              projectId: project.id,
                              source: "queue",
                              customerName: project.customerName,
                              identifier: project.ecc || project.tempNo,
                              tagIds: [...(project.tagIds ?? [])],
                            });
                          }}
                        >
                          标签
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {projectPage?.projects.length === 0 && (
              <Empty
                title="没有符合条件的项目"
                copy="调整阶段、提醒、区域或查找条件。"
              />
            )}
          </div>
          <div className="queue-pagination">
            <button
              className="button"
              disabled={cursorStack.length <= 1 || loading.projects}
              onClick={() => void previousProjectPage()}
            >
              上一页
            </button>
            <span>
              固定每页20 · {" "}
              第 {projectPage?.total ? currentPageIndex * (projectPage.pageSize ?? projectPage.limit ?? PROJECT_PAGE_SIZE) + 1 : 0}–
              {Math.min(
                (currentPageIndex + 1) * (projectPage?.pageSize ?? projectPage?.limit ?? PROJECT_PAGE_SIZE),
                projectPage?.total ?? 0,
              )}{" "}
              项 / 共 {projectPage?.total ?? 0} 项
            </span>
            <button
              className="button"
              disabled={!projectPage?.nextCursor || loading.projects}
              onClick={() => void nextProjectPage()}
            >
              下一页
            </button>
          </div>
        </section>
      </main>
      {toast && <div className="toast success" role="status">{toast}</div>}
      {warningToast && <div className="toast warning" role="alert">{warningToast}</div>}
      {layer && (
        <Layer
          title={layerTitle(layer)}
          description={layerDescription(layer, selected)}
          className={layer.kind === "edit-project-tags" ? "project-tag-modal" : undefined}
          initialFocusSelector={layer.kind === "new"
            ? '[name="customerName"]'
            : layer.kind === "edit-project-tags"
              ? tagCatalogError
                ? "[data-tag-picker-retry]"
                : !tagCatalogLoading && !tagCatalog?.groups.length
                  ? "[data-tag-edit-cancel]"
                  : !tagCatalogLoading
                    ? 'input[type="checkbox"]:not([disabled])'
                    : undefined
              : undefined}
          side={layer.kind === "independent" || layer.kind === "report" || layer.kind === "history" || layer.kind === "reminder-all" || layer.kind === "tags"}
          protectDirty={layerRequiresDirtyProtection(layer)}
          controlledDirty={layer.kind === "edit-project-tags" ? tagEditGuard.dirty : undefined}
          busy={layer.kind === "edit-project-tags" ? tagEditGuard.busy : false}
          requestCloseRef={layerCloseRequest}
          resetDirtyKey={layer.kind === "tags" ? tagCatalog : undefined}
          onClose={() => setLayer(null)}
        >
          {layer.kind === "new" ? (
            <ProjectCreateSinglePageForm
              catalog={tagCatalog}
              catalogLoading={tagCatalogLoading}
              catalogError={tagCatalogError}
              onRetryCatalog={loadTagCatalog}
              onSave={(payload) =>
                mutate({ op: "create_project", payload }, "搬迁项目已创建")
              }
            />
          ) : layer.kind === "edit-project-tags" ? (
            <ProjectTagEditForm
              key={`${layer.source}:${layer.projectId}`}
              initialTagIds={layer.tagIds}
              catalog={tagCatalog}
              catalogLoading={tagCatalogLoading}
              catalogError={tagCatalogError}
              onRetryCatalog={loadTagCatalog}
              onGuardChange={setTagEditGuard}
              onCancel={(trigger) => layerCloseRequest.current(trigger)}
              onSave={(tagIds) => saveProjectTags(layer.projectId, tagIds)}
            />
          ) : layer.kind === "edit-project" && selected ? (
            <ProjectEditForm
              mode="project"
              project={selected}
              detail={detail?.detail ?? null}
              onSave={(payload) =>
                mutate(updateProjectRequest(payload), "项目资料已更新")
              }
            />
          ) : layer.kind === "correct-entry" && selected && selected.formallyEntered ? (
            <ProjectEditForm
              mode="entry"
              project={selected}
              detail={detail?.detail ?? null}
              onSave={(payload) =>
                mutate(updateProjectRequest(payload), "进单与合同资料已更正")
              }
            />
          ) : layer.kind === "quick" ? (
            <QuickMenu
              onChoose={(action) => setLayer({ kind: "action", action })}
            />
          ) : layer.kind === "action" && selected ? (
            <ActionFormV2
              type={layer.action}
              project={selected}
              detail={detail?.detail ?? null}
              onSave={(action) =>
                mutate(
                  { op: "submit_action", projectId: selected.id, action },
                  "业务记录已保存",
                )
              }
              onInstrumentBulkImport={(rows) =>
                mutate(
                  instrumentBulkImportRequest(selected.id, rows),
                  `已导入 ${rows.length} 台仪器`,
                )
              }
              onSupplement={(payload) =>
                mutate({ op: "supplement_project", payload }, "进单资料已补齐")
              }
              onCompleteShipTo={(requestId, accountId) =>
                mutate(
                  { op: "ship_to_complete", requestId, accountId },
                  "Account ID 申请已完成",
                )
              }
            />
          ) : layer.kind === "reminder" && selected ? (
            <ReminderFormV2
              project={selected}
              onSave={(at, note) =>
                mutate(
                  {
                    op: "set_reminder",
                    projectId: selected.id,
                    reminderAt: at,
                    reminderNote: note,
                  },
                  "项目提醒已保存",
                )
              }
              onClear={() =>
                mutate(
                  { op: "clear_reminder", projectId: selected.id },
                  "项目提醒已清除",
                )
              }
            />
          ) : layer.kind === "cancel" && selected ? (
            <CancelFormV2
              project={selected}
              onSave={(time, reason) =>
                mutate(
                  {
                    op: "cancel_project",
                    projectId: selected.id,
                    time,
                    reason,
                  },
                  "项目已取消",
                )
              }
            />
          ) : layer.kind === "independent" ? (
            <IndependentModuleV2
              kind={layer.module}
              project={selected}
              refreshToken={independentRefresh}
              onSave={(action) =>
                mutate(
                  { op: "submit_action", projectId: action.projectId, action },
                  "记录已保存",
                )
              }
              onDelete={(kind, id) => deleteRecord({ kind, id } as DeleteInput, "记录已删除")}
            />
          ) : layer.kind === "invoice-edit" ? (
            <InvoiceMutationForm
              mode="edit"
              invoice={layer.invoice}
              onSave={(values) =>
                mutate(
                  {
                    op: "invoice_edit",
                    invoiceId: layer.invoice.id,
                    invoicedAt: values.time,
                    amount: values.amount,
                  },
                  "掉票已更新",
                )
              }
            />
          ) : layer.kind === "invoice-revoke" ? (
            <InvoiceMutationForm
              mode="revoke"
              invoice={layer.invoice}
              onSave={(values) => deleteRecord({ kind: "invoice", id: layer.invoice.id, revokedAt: values.time, revokeReason: values.reason }, "掉票已撤销")}
            />
          ) : layer.kind === "batch-edit" ? (
            <BatchEditForm
              batch={layer.batch}
              onSave={(batchEdit) =>
                mutate(
                  batchEditRequest(layer.batch.id, batchEdit),
                  "物流费用记录已更新",
                )
              }
            />
          ) : layer.kind === "damage-update" ? (
            <DamageUpdateForm
              damage={layer.damage}
              onSave={(issueStatus, closeReason) =>
                mutate(
                  damageUpdateRequest(layer.damage.id, issueStatus, closeReason),
                  "维修状态已更新",
                )
              }
            />
          ) : layer.kind === "order-note-edit" ? (
            <ServiceOrderNoteForm
              order={layer.order}
              onSave={(note) => mutateRecord({ op: "service_order_note_update", payload: { orderId: layer.order.id, note } }, note ? "开单备注已保存" : "开单备注已清空")}
              onSaveEngineer={(engineer) => mutateRecord({ op: "service_order_engineer_update", payload: { orderId: layer.order.id, engineer } }, engineer ? "工程师已保存" : "工程师已清空")}
            />
          ) : layer.kind === "report" ? (
            <ReportPanelV2 catalog={tagCatalog} catalogLoading={tagCatalogLoading} catalogError={tagCatalogError} onRetryCatalog={loadTagCatalog} />
          ) : layer.kind === "tags" ? (
            <TagLibraryPanel catalog={tagCatalog} loading={tagCatalogLoading} error={tagCatalogError} onRefresh={loadTagCatalog} onRename={renameCatalogItem} />
          ) : layer.kind === "history" ? (
            <HistoryBrowserV2 onRevision={(next) => { revision.current = Math.max(revision.current, next); }} onDelete={(request, success) => deleteRecord(request, success, false)} />
          ) : layer.kind === "reminder-all" ? (
            <ReminderBrowserV2 onSelect={(item) => { setLayer(null); selectReminder(item); }} onRevision={(next) => { revision.current = Math.max(revision.current, next); }} />
          ) : layer.kind === "clean" ? (
            <DataCleanPanel onComplete={async () => {
              revision.current = 0;
              setSelectedId("");
              setDetail(null);
              setSectionPage(null);
              setCursorStack([null]);
              await Promise.all([loadOverview(), loadProjects(null, 0)]);
              setLayer(null);
              setToast("业务数据已清理，并已创建安全备份");
            }} />
          ) : null}
        </Layer>
      )}
    </div>
  );
}

function reminderClassLabel(value: WorkbenchV2ReminderLaneRow["reminderDueClass"]): string {
  return value === "overdue" ? "已逾期" : value === "today" ? "今日" : value === "upcoming" ? "临期" : "未分类";
}

function ReminderLanes({
  refreshToken,
  onSelect,
}: {
  refreshToken: number;
  onSelect: (item: WorkbenchV2ReminderLaneRow) => void;
}): JSX.Element {
  const [data, setData] = useState<WorkbenchV2ReminderLanesDto | null>(null);
  const [error, setError] = useState("");
  const [loadingDate, setLoadingDate] = useState("");
  async function load(date?: string, cursor?: string | null): Promise<void> {
    setError("");
    setLoadingDate(date ?? "initial");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(api, "v2ReminderLanes")({
        ...(date && data?.dates.length ? { selectedDates: data.dates } : {}),
        ...(date ? { date, cursor: cursor ?? null } : {}),
      });
      setData((current) => {
        if (!date || !current) return next;
        const incoming = next.lanes.find((lane) => lane.date === date);
        if (!incoming) return current;
        return {
          ...next,
          dates: current.dates,
          lanes: current.lanes.map((lane) =>
            lane.date === date
              ? { ...incoming, projects: [...lane.projects, ...incoming.projects] }
              : lane,
          ),
        };
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingDate("");
    }
  }
  useEffect(() => { setData(null); void load(); }, [refreshToken]);
  if (error) return <div className="inline-error" role="alert">{error}<button className="text-action" onClick={() => void load()}>重试</button></div>;
  if (!data) return <div className="detail-loading" role="status">正在读取提醒日期…</div>;
  if (!data.dates.length) return <Empty title="暂无日期提醒" copy="设置提醒日期后会按日期出现在这里。" />;
  return (
    <div className="reminder-lane-scroll" role="region" aria-label="提醒日期泳道" tabIndex={0}>
      <div className="reminder-lanes" style={{ "--lane-count": data.dates.length } as CSSProperties}>
        {data.dates.map((date) => {
          const lane = data.lanes.find((item) => item.date === date);
          return <section className="reminder-lane" key={date} aria-labelledby={`lane-${date}`} tabIndex={0}>
            <header><time id={`lane-${date}`} dateTime={date}>{date}</time><span>{lane?.total ?? 0} 项</span></header>
            <div className="reminder-lane-stack">
              {lane?.projects.map((item) => <button className="reminder-card" key={item.projectId} onClick={() => onSelect(item)}>
                <span className={`due due-${item.reminderDueClass ?? "note"}`}>{reminderClassLabel(item.reminderDueClass)}</span>
                <strong>{item.customerName}</strong><small>{item.ecc ?? item.tempNo}</small>
                <p>{item.reminderNote || "无备注"}</p>
              </button>)}
            </div>
            {lane?.nextCursor && <button className="lane-more" disabled={loadingDate === date} onClick={() => void load(date, lane.nextCursor)}>{loadingDate === date ? "正在读取…" : "加载本列更多"}</button>}
          </section>;
        })}
      </div>
    </div>
  );
}

function ReminderBrowserV2({
  onSelect,
  onRevision,
}: {
  onSelect: (item: WorkbenchV2ReminderPageDto["rows"][number]) => void;
  onRevision: (revision: number) => void;
}): JSX.Element {
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState<WorkbenchV2ReminderPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  async function load(cursor: string | null, direction = sort): Promise<void> {
    setError("");
    try {
      const api = bridge(); if (!api) throw new Error();
      const next = await requireV2(api, "v2ReminderPage")({ sort: direction, cursor, limit: 50 });
      onRevision(next.businessRevision); setPage(next);
    } catch { setError("提醒读取失败，请重试。"); }
  }
  useEffect(() => { void load(null); }, []);
  function changeSort(direction: "asc" | "desc"): void {
    setSort(direction); setStack([null]); void load(null, direction);
  }
  return <div className="reminder-browser">
    <div className="reminder-browser-toolbar"><div><h3>全部项目提醒</h3><p>包含日期提醒与仅备注提醒，共 {page?.total ?? 0} 项。</p></div><Select name="reminderSort" label="提醒日期顺序" value={sort} onChange={(event) => changeSort(event.target.value as "asc" | "desc")} options={[["desc", "日期降序（默认）"], ["asc", "日期升序"]]} /></div>
    {error && <div className="inline-error" role="alert">{error}<button className="text-action" onClick={() => void load(stack.at(-1) ?? null)}>重试</button></div>}
    <div className="reminder-page-list">{page?.rows.map((item) => <button key={item.projectId} onClick={() => onSelect(item)}><span className={`due due-${item.reminderDueClass ?? "note"}`}>{reminderClassLabel(item.reminderDueClass)}</span><strong>{item.customerName}</strong><small>{item.ecc ?? item.tempNo}</small><time>{item.reminderAt ?? "仅备注"}</time><p>{item.reminderNote || "无备注"}</p></button>)}</div>
    {page?.rows.length === 0 && <Empty title="暂无提醒" copy="项目设置提醒后会出现在这里。" />}
    <div className="queue-pagination"><button className="button" disabled={stack.length <= 1} onClick={() => { const next = stack.slice(0, -1); setStack(next); void load(next.at(-1) ?? null); }}>上一页</button><span>本页 {page?.rows.length ?? 0} / 共 {page?.total ?? 0}</span><button className="button" disabled={!page?.nextCursor} onClick={() => { if (!page?.nextCursor) return; const next = [...stack, page.nextCursor]; setStack(next); void load(page.nextCursor); }}>下一页</button></div>
  </div>;
}

function ProjectContext({
  project,
  detail,
  loading,
  repairOpen,
  openRepairProjects,
  onQuick,
  onReminder,
  onCancel,
  onStatus,
  onRepairFilter,
}: {
  project: WorkbenchProjectRow | null;
  detail: WorkbenchV2ProjectDetailDto | null;
  loading: boolean;
  repairOpen: boolean;
  openRepairProjects: number;
  onQuick: () => void;
  onReminder: () => void;
  onCancel: () => void;
  onStatus: (status: AdjustableProjectStatus) => void;
  onRepairFilter: () => void;
}): JSX.Element {
  const [draftStatus, setDraftStatus] = useState<AdjustableProjectStatus>(
    project?.status === "cancelled" ? "completed" : project?.status ?? "pending_entry",
  );
  useEffect(() => {
    if (!project || project.status === "cancelled") return;
    setDraftStatus(project.status);
  }, [project?.id, project?.status]);
  if (!project)
    return (
      <aside className="panel context">
        <Empty title="未选择项目" copy="从项目队列选择一行查看当前上下文。" />
      </aside>
    );
  return (
    <aside
      className={`panel context ${project.formallyEntered ? "entered" : "not-entered"}`}
      aria-label="当前上下文"
      aria-busy={loading}
    >
      <div className="context-head">
        <span>当前上下文 · {project.region || "区域待补"}{project.regionNeedsAdjustment ? "（待调整）" : ""}</span>
        <h2>{project.customerName}</h2>
        <p>{project.ecc || project.tempNo}</p>
        <div className="row-actions">
          <button className="button primary small" onClick={onQuick}>
            快速记录
          </button>
          <button className="button small" onClick={onReminder}>
            维护提醒
          </button>
        </div>
      </div>
      <div className="context-section">
        <h3>项目状态</h3>
        <div className="tag-row">
          <StatusBadge status={project.status} />
          <span
            className={`entry-badge ${project.formallyEntered ? "entered" : "not-entered"}`}
          >
            {project.formallyEntered ? "已进单" : "未进单"}
          </span>
          {project.preEntryExecution && (
            <span className="tag warning">未进单先执行</span>
          )}
          {project.nonBlocking.pendingShipTo > 0 && (
            <span className="tag neutral">Account ID 待处理 {project.nonBlocking.pendingShipTo}</span>
          )}
          {project.nonBlocking.repairs > 0 && (
            <span className="tag warning">损坏/维修 {project.nonBlocking.repairs}</span>
          )}
        </div>
        <div className="concern-row">
          <span className="concern-label">事项关注</span>
          <button
            className={`text-action concern-filter ${repairOpen ? "active" : ""}`}
            aria-pressed={repairOpen}
            onClick={onRepairFilter}
          >
            未关闭维修事项 {openRepairProjects} 个项目
          </button>
        </div>
        <GroupedTags groups={detail?.groupedTags ?? project.groupedTags} />
        {project.status !== "cancelled" && (
          <div className="status-adjust">
            <label htmlFor="context-status-v2">人工调整主状态</label>
            <select
              id="context-status-v2"
              value={draftStatus}
              onChange={(event) =>
                setDraftStatus(event.target.value as AdjustableProjectStatus)
              }
            >
              {STAGES.map((status) => (
                <option value={status} key={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
            <button
              className="button small"
              onClick={() => onStatus(draftStatus)}
            >
              提交校验
            </button>
          </div>
        )}
        {project.status !== "cancelled" && (
          <div className="cancel-entry">
            <button className="button danger small" onClick={onCancel}>
              取消项目
            </button>
            <small>取消为终态，须记录时间与原因。</small>
          </div>
        )}
      </div>
      <div className="context-section">
        <h3>当前项目提醒</h3>
        <strong>
          {project.reminderAt
            ? businessDate(project.reminderAt)
            : "未设置提醒日期"}
        </strong>
        <p>{project.reminderNote || "暂无提醒备注"}</p>
      </div>
      <div className="context-section" aria-label="项目备注">
        <h3>项目备注</h3>
        <p className={`context-note ${detail?.detail?.projectNote ? "" : "is-empty"}`}>
          {detail?.detail?.projectNote || "暂无备注"}
        </p>
      </div>
      <div className="context-section">
        <h3>执行联系</h3>
        <p>
          {detail?.detail?.oldSiteContact || "旧址联系人待补"} ·{" "}
          {detail?.detail?.newSiteContact || "新址联系人待补"}
        </p>
      </div>
    </aside>
  );
}

function ProjectDetails({
  project,
  detail,
  detailReady,
  tab,
  section,
  loading,
  error,
  pageIndex,
  onTab,
  onRetry,
  onAction,
  onEditProject,
  onEditTags,
  onCorrectEntry,
  onCompleteEntry,
  onNext,
  onPrevious,
  onInvoiceEdit,
  onInvoiceRevoke,
  onBatchEdit,
  onDamageUpdate,
  onInstrumentSave,
  onOrderNoteEdit,
  onDelete,
}: {
  project: WorkbenchProjectRow | null;
  detail: WorkbenchV2ProjectDetailDto | null;
  detailReady: boolean;
  tab: DetailTab;
  section: WorkbenchV2SectionPageDto | null;
  loading: boolean;
  error: string;
  pageIndex: number;
  onTab: (tab: DetailTab) => void;
  onRetry: () => void;
  onAction: (action: WorkbenchActionType) => void;
  onEditProject: () => void;
  onEditTags: () => void;
  onCorrectEntry: () => void;
  onCompleteEntry: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onInvoiceEdit: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onInvoiceRevoke: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onBatchEdit: (
    batch: Extract<WorkbenchV2SectionRow, { kind: "batches" }>,
  ) => void;
  onDamageUpdate: (
    damage: Extract<WorkbenchV2SectionRow, { kind: "damage_items" }>,
  ) => void;
  onInstrumentSave: (
    instrument: Extract<WorkbenchV2SectionRow, { kind: "instruments" }>,
    values: InstrumentEditValues,
  ) => Promise<void>;
  onOrderNoteEdit: (
    order: Extract<WorkbenchV2SectionRow, { kind: "orders" }>,
  ) => void;
  onDelete: (kind: "service_order" | "activity" | "damage_repair_item" | "batch" | "instrument", id: string) => void;
}): JSX.Element {
  const recordFacts: Array<[string, string]> = project ? [
    ["物流费用登记", `${project.counts.batches} 条`],
    ["搬迁仪器", `${project.counts.instruments} 台`],
    ["上门活动", `${project.counts.activities} 条`],
    ["开单记录", `${project.counts.orders} 条`],
    ["损坏/维修事项", `${project.counts.repairs} 条`],
    ["掉票记录", `${project.counts.invoices} 条`],
  ] : [];
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const action: Partial<Record<DetailTab, WorkbenchActionType>> = {
    搬迁仪器: "instrument",
    物流费用登记: "batch",
    开单记录: "order",
    费用与掉票: "invoice",
    申请与维修: "damage",
  };
  return (
    <section
      className="panel detail"
      aria-labelledby="detail-title"
      aria-busy={loading}
    >
      <div className="detail-head">
        <div>
          <p className="overline">项目详情</p>
          <h2 id="detail-title">
            {project?.customerName || "未选择项目"}
          </h2>
          <span>
            {project
              ? `${project.ecc || project.tempNo} · ${project.region || "区域待补"}${project.regionNeedsAdjustment ? "（待调整）" : ""}`
              : "从项目队列选择一行，或点击项目提醒跳转对应项目"}
          </span>
        </div>
        {project && (
          <div className="detail-money">
            <div>
              <span>合同 USD 含税金额</span>
              <strong>{money(project.contractAmount)}</strong>
            </div>
            <div>
              <span>最终可确认金额</span>
              <strong>{money(project.finalAmount)}</strong>
            </div>
            <div>
              <span>累计掉票</span>
              <strong>{money(project.invoicedAmount)}</strong>
            </div>
          </div>
        )}
      </div>
      {project && (
        <>
          <div className="detail-command-bar" role="region" aria-label="项目标签">
            <div className="detail-command-tags">
              <span>项目标签</span>
              <GroupedTags groups={detail?.groupedTags ?? project.groupedTags} compact />
              {!(detail?.groupedTags ?? project.groupedTags)?.length && <small>尚未添加项目标签</small>}
            </div>
            <div className="row-actions">
              <button className="button small" aria-label={`${(detail?.groupedTags ?? project.groupedTags)?.length ? "编辑" : "添加"}${project.customerName}的项目标签`} onClick={(event) => { event.currentTarget.focus(); onEditTags(); }}>{(detail?.groupedTags ?? project.groupedTags)?.length ? "编辑标签" : "添加标签"}</button>
              <button
                className="button small"
                disabled={!detailReady}
                aria-disabled={!detailReady}
                title={!detailReady ? "正在读取项目资料" : undefined}
                onClick={onEditProject}
              >
                编辑项目资料
              </button>
              {project.formallyEntered ? (
                <button className="button small" onClick={onCorrectEntry}>更正进单/合同资料</button>
              ) : (
                <button className="button primary small" onClick={onCompleteEntry}>补齐进单核心资料</button>
              )}
            </div>
          </div>
          <div className="detail-summary" aria-label="项目关键资料">
            {[
              ["项目状态", STATUS_LABEL[project.status]],
              ["地址流向", `${detail?.detail?.oldSiteAddress || "待补"} → ${detail?.detail?.newSiteAddress || "待补"}`],
              ["计划上门", detail?.detail?.planVisitAt || "待补"],
              ["计划运输", detail?.detail?.planTransportAt || "待补"],
              ["计划装机", detail?.detail?.plannedInstallAt || "待补"],
              ["场地 / 暂存", `${detail?.detail?.siteConfirmed ? "场地已确认" : "场地未确认"} · ${detail?.detail?.isTemporaryStorage === null || detail?.detail?.isTemporaryStorage === undefined ? "暂存未填写" : detail.detail.isTemporaryStorage ? "需要暂存" : "无需暂存"}`],
            ].map(([label, value]) => <div key={label}><span>{label}</span><strong className={String(value).includes("待补") || String(value).includes("未填写") ? "is-missing" : undefined}>{value}</strong></div>)}
          </div>
          <details className="project-profile">
            <summary>完整项目资料</summary>
            <div className="overview-groups">
              {[
                ["基础资料", [["客户名称", project.customerName], ["ECC / 临时编号", project.ecc || project.tempNo], ["所属区域", `${project.region || "待补"}${project.regionNeedsAdjustment ? "（待调整）" : ""}`], ["主状态", STATUS_LABEL[project.status]], ["进单日期", project.entryAt ? businessDate(project.entryAt) : "待进单"], ["项目备注", detail?.detail?.projectNote || "无"]]],
                ["搬迁安排", [["旧址地址", detail?.detail?.oldSiteAddress || "待补"], ["新址地址", detail?.detail?.newSiteAddress || "待补"], ["计划上门日期", detail?.detail?.planVisitAt || "待补"], ["计划运输日期", detail?.detail?.planTransportAt || "待补"], ["场地确认", detail?.detail?.siteConfirmed ? "是" : "否"], ["是否暂存", detail?.detail?.isTemporaryStorage === null || detail?.detail?.isTemporaryStorage === undefined ? "未填写" : detail.detail.isTemporaryStorage ? "是" : "否"], ["暂存地址", detail?.detail?.temporaryStorageAddress || "待补"], ["计划装机日期", detail?.detail?.plannedInstallAt || "待补"], ["实际装机完成日期", detail?.detail?.actualInstallDoneAt || "待补"]]],
                ["设备与合同", [["UPS", detail?.detail?.temporaryHasUps === null || detail?.detail?.temporaryHasUps === undefined ? "未填写" : detail.detail.temporaryHasUps ? "是" : "否"], ["合同开始日期", detail?.detail?.contractStartDate || "待补"], ["合同截止日期", detail?.detail?.contractEndDate || "待补"]]],
              ].map(([group, fields]) => <section className="overview-group" aria-labelledby={`profile-${group}`} key={group as string}><h3 id={`profile-${group}`}>{group as string}</h3><dl>{(fields as string[][]).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={["待补", "未填写", "待进单"].includes(value!) ? "is-missing" : undefined}>{value}</dd></div>)}</dl></section>)}
            </div>
            <section className="overview-records" aria-labelledby="profile-records-title"><h3 id="profile-records-title">关联登记事实</h3><dl>{recordFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
          </details>
        </>
      )}
      {project && (
        <div className="tabbar">
          <div role="tablist" aria-label="项目详情">
            {TABS.map((item, index) => (
              <button
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                aria-selected={tab === item}
                aria-controls="project-detail-panel"
                tabIndex={tab === item ? 0 : -1}
                key={item}
                onClick={() => onTab(item)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : event.key === "ArrowRight"
                          ? (index + 1) % TABS.length
                          : (index - 1 + TABS.length) % TABS.length;
                  onTab(TABS[next]!);
                  tabRefs.current[next]?.focus();
                }}
              >
                {item}
              </button>
            ))}
          </div>
          {action[tab] && (
            <button
              className="button small"
              onClick={() => onAction(action[tab]!)}
            >
              就近记录
            </button>
          )}
        </div>
      )}
      <div id="project-detail-panel" className="detail-body" role="tabpanel">
        {error ? (
          <div className="page-error" role="alert">
            {error}
            <button onClick={onRetry}>重试详情</button>
          </div>
        ) : !project ? (
          <Empty
            title="未选择项目"
            copy="从项目队列选择一行，或点击项目提醒跳转对应项目。"
          />
        ) : loading ? (
          <div className="detail-loading" role="status">
            正在读取当前项目数据…
          </div>
        ) : tab === "费用与掉票" ? (
          <div className="invoice-tab-body">
            <div className="fact-grid" aria-label="金额摘要">
              <div><span>合同金额</span><strong>{money(project.contractAmount)}</strong></div>
              <div><span>进单金额快照</span><strong>{money(project.entryAmountSnapshot)}</strong></div>
              <div><span>最终可确认金额</span><strong>{money(project.finalAmount)}</strong></div>
              <div><span>尚待掉票</span><strong>{money(pendingInvoiceAmount(project.finalAmount, project.invoicedAmount))}</strong></div>
            </div>
            <SectionTable
              page={section}
              onInvoiceEdit={onInvoiceEdit}
              onInvoiceRevoke={onInvoiceRevoke}
              onBatchEdit={onBatchEdit}
              onDamageUpdate={onDamageUpdate}
              onInstrumentSave={onInstrumentSave}
              onOrderNoteEdit={onOrderNoteEdit}
              onDelete={onDelete}
            />
          </div>
        ) : (
          <SectionTable
            page={section}
            onInvoiceEdit={onInvoiceEdit}
            onInvoiceRevoke={onInvoiceRevoke}
            onBatchEdit={onBatchEdit}
            onDamageUpdate={onDamageUpdate}
            onInstrumentSave={onInstrumentSave}
            onOrderNoteEdit={onOrderNoteEdit}
            onDelete={onDelete}
          />
        )}
      </div>
      {project && (
        <div className="section-pagination">
          <button
            className="button"
            disabled={pageIndex === 0}
            onClick={onPrevious}
          >
            上一页
          </button>
          <span>
            第 {section?.total ? pageIndex * PAGE_SIZE + 1 : 0}–
            {Math.min((pageIndex + 1) * PAGE_SIZE, section?.total ?? 0)} 条 / 共{" "}
            {section?.total ?? 0} 条
          </span>
          <button
            className="button"
            disabled={!section?.nextCursor}
            onClick={onNext}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

function SectionTable({
  page,
  onInvoiceEdit,
  onInvoiceRevoke,
  onBatchEdit,
  onDamageUpdate,
  onInstrumentSave,
  onOrderNoteEdit,
  onDelete,
}: {
  page: WorkbenchV2SectionPageDto | null;
  onInvoiceEdit: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onInvoiceRevoke: (
    invoice: Extract<WorkbenchV2SectionRow, { kind: "invoices" }>,
  ) => void;
  onBatchEdit: (
    batch: Extract<WorkbenchV2SectionRow, { kind: "batches" }>,
  ) => void;
  onDamageUpdate: (
    damage: Extract<WorkbenchV2SectionRow, { kind: "damage_items" }>,
  ) => void;
  onInstrumentSave: (
    instrument: Extract<WorkbenchV2SectionRow, { kind: "instruments" }>,
    values: InstrumentEditValues,
  ) => Promise<void>;
  onOrderNoteEdit: (
    order: Extract<WorkbenchV2SectionRow, { kind: "orders" }>,
  ) => void;
  onDelete: (kind: "service_order" | "activity" | "damage_repair_item" | "batch" | "instrument", id: string) => void;
}): JSX.Element {
  const [editingId, setEditingId] = useState("");
  const [instrumentDraft, setInstrumentDraft] = useState<InstrumentEditValues | null>(null);
  const [instrumentSaving, setInstrumentSaving] = useState(false);
  const [instrumentError, setInstrumentError] = useState("");
  function startInstrumentEdit(instrument: Extract<WorkbenchV2SectionRow, { kind: "instruments" }>): void {
    setEditingId(instrument.id);
    setInstrumentDraft({
      manufacturer: instrument.manufacturer,
      model: instrument.model,
      serviceLevel: instrument.serviceLevel,
      serialNo: instrument.serialNo,
      ups: instrument.ups,
      qrRequested: instrument.qrRequested,
      batchId: instrument.batchId,
    });
    setInstrumentError("");
  }
  function cancelInstrumentEdit(): void {
    if (instrumentSaving) return;
    setEditingId("");
    setInstrumentDraft(null);
    setInstrumentError("");
  }
  async function saveInstrument(instrument: Extract<WorkbenchV2SectionRow, { kind: "instruments" }>): Promise<void> {
    if (!instrumentDraft) return;
    setInstrumentSaving(true);
    setInstrumentError("");
    try {
      await onInstrumentSave(instrument, {
        ...instrumentDraft,
        manufacturer: instrumentDraft.manufacturer?.trim() || null,
        model: instrumentDraft.model?.trim() || null,
        serviceLevel: instrumentDraft.serviceLevel?.trim() || null,
        serialNo: instrumentDraft.serialNo?.trim() || null,
      });
      setEditingId("");
      setInstrumentDraft(null);
    } catch (cause) {
      setInstrumentError(messageOf(cause));
    } finally {
      setInstrumentSaving(false);
    }
  }
  if (!page?.rows.length)
    return <Empty title="暂无记录" copy="通过就近记录入口新增业务事实。" />;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {sectionColumns(page.kind).map((column) => (
              <th key={column}>{columnLabel(column)}</th>
            ))}
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => {
            const editing = row.kind === "instruments" && row.id === editingId;
            return (
            <tr key={row.id} className={editing ? "instrument-row-editing" : undefined} onKeyDown={editing ? (event) => { if (event.key === "Escape") { event.preventDefault(); cancelInstrumentEdit(); } } : undefined}>
              {row.kind === "instruments" && editing && instrumentDraft ? (
                <>
                  <td><strong>{row.name}</strong><small className="inline-readonly-note">只读</small></td>
                  <td><input autoFocus aria-label="仪器厂商" value={instrumentDraft.manufacturer ?? ""} onChange={(event) => setInstrumentDraft({ ...instrumentDraft, manufacturer: event.target.value })} /></td>
                  <td><input aria-label="型号" value={instrumentDraft.model ?? ""} onChange={(event) => setInstrumentDraft({ ...instrumentDraft, model: event.target.value })} /></td>
                  <td><input aria-label="服务级别" value={instrumentDraft.serviceLevel ?? ""} onChange={(event) => setInstrumentDraft({ ...instrumentDraft, serviceLevel: event.target.value })} /></td>
                  <td><input aria-label="序列号" value={instrumentDraft.serialNo ?? ""} onChange={(event) => setInstrumentDraft({ ...instrumentDraft, serialNo: event.target.value })} /></td>
                  <td>{formatCell("batchId", row.batchId)}<small className="inline-readonly-note">只读</small></td>
                  <td><select aria-label="是否 UPS" value={instrumentDraft.ups ? "true" : "false"} onChange={(event) => setInstrumentDraft({ ...instrumentDraft, ups: event.target.value === "true" })}><option value="true">是</option><option value="false">否</option></select></td>
                  <td>{formatCell("qrRequested", row.qrRequested)}<small className="inline-readonly-note">只读</small></td>
                </>
              ) : sectionColumns(page.kind).map((column) => (
                  <td key={column}>{formatCell(column, sectionCellValue(row, column))}</td>
                ))}
              {row.kind === "invoices" && (
                <td>
                  {row.active ? (
                    <div className="row-actions">
                      <button
                        className="button small"
                        onClick={() => onInvoiceEdit(row)}
                      >
                        编辑
                      </button>
                      <button
                        className="button danger small"
                        onClick={() => onInvoiceRevoke(row)}
                      >
                        撤销
                      </button>
                    </div>
                  ) : (
                    <span className="terminal-note">终态 · 更正请新增</span>
                  )}
                </td>
              )}
              {row.kind === "batches" && (
                <td>
                  <div className="row-actions compact"><button className="button small" onClick={() => onBatchEdit(row)}>编辑</button><button className="button danger small" onClick={() => onDelete("batch", row.id)}>删除</button></div>
                </td>
              )}
              {row.kind === "damage_items" && (
                <td>
                  <div className="row-actions compact"><button className="button small" onClick={() => onDamageUpdate(row)}>更新维修状态</button><button className="button danger small" onClick={() => onDelete("damage_repair_item", row.id)}>删除</button></div>
                </td>
              )}
              {row.kind === "instruments" && (
                <td>
                  {editing ? (
                    <div className="instrument-inline-actions">
                      <div className="row-actions compact">
                        <button className="button primary small" disabled={instrumentSaving} onClick={() => void saveInstrument(row)}>{instrumentSaving ? "正在保存…" : "保存"}</button>
                        <button className="button small" disabled={instrumentSaving} onClick={cancelInstrumentEdit}>取消</button>
                      </div>
                      {instrumentError && <small className="instrument-inline-error" role="alert">保存失败：{instrumentError}</small>}
                    </div>
                  ) : (
                    <div className="row-actions compact">
                      <button className="button small" disabled={Boolean(editingId)} onClick={() => startInstrumentEdit(row)}>{editingId ? "正在编辑" : "编辑"}</button>
                      <button className="button danger small" onClick={() => onDelete("instrument", row.id)}>删除</button>
                    </div>
                  )}
                </td>
              )}
              {row.kind === "orders" && <td><div className="row-actions compact"><button className="button small" onClick={() => onOrderNoteEdit(row)}>{row.note ? "修改备注" : "后补备注"}</button><button className="button danger small" onClick={() => onDelete("service_order", row.id)}>删除</button></div></td>}
              {row.kind === "activities" && <td><div className="restricted-action"><button className="button danger small" onClick={() => onDelete("activity", row.id)}>删除</button><small>到访与工作事实有误时，删除后按实际情况重新登记。</small></div></td>}
            </tr>
          );})}
        </tbody>
      </table>
    </div>
  );
}

function sectionColumns(kind: WorkbenchV2SectionKind): string[] {
  return kind === "instruments"
    ? ["name", "manufacturer", "model", "serviceLevel", "serialNo", "batchId", "ups", "qrRequested"]
    : kind === "batches"
      ? [
          "planTransportDate",
          "transportCompany",
          "budgetPrice",
          "dealPrice",
          "startedAt",
        ]
      : kind === "activities"
        ? ["visitAt", "engineers"]
        : kind === "orders"
          ? ["orderedAt", "engineer", "orderType", "serviceOrderNo", "note"]
        : kind === "invoices"
          ? ["invoicedAt", "amount", "active", "revokedAt", "lastModifiedAt"]
          : kind === "damage_items"
            ? [
                "instrumentName",
                "serialNo",
                "damageReason",
                "issueStatus",
                "partNumber",
                "partAmount",
                "partStatus",
              ]
            : ["serviceOrderNo", "orderType", "orderedAt", "engineer"];
}
function columnLabel(key: string): string {
  return (
    (
      {
        name: "仪器名称",
        manufacturer: "仪器产商",
        model: "型号",
        serviceLevel: "服务级别",
        serialNo: "序列号",
        batchId: "物流费用记录",
        ups: "UPS",
        qrRequested: "二维码",
        planTransportDate: "运输日期",
        transportCompany: "运输公司",
        budgetPrice: "合同预算价",
        dealPrice: "物流成交价",
        startedAt: "运输开始日期",
        visitAt: "到访日期",
        engineers: "参与工程师",
        invoicedAt: "掉票日期",
        amount: "金额",
        active: "状态",
        revokedAt: "撤销日期",
        lastModifiedAt: "最后修改时间",
        instrumentName: "仪器名称",
        damageReason: "损坏原因",
        issueStatus: "事项状态",
        partNumber: "备件号",
        partAmount: "备件金额",
        partStatus: "备件状态",
        serviceOrderNo: "服务单号",
        orderType: "开单类型",
        orderedAt: "开单日期",
        engineer: "工程师",
        note: "备注",
      } as Record<string, string>
    )[key] || key
  );
}
function sectionCellValue(
  row: WorkbenchV2SectionRow,
  column: string,
): unknown {
  const values = row as unknown as Record<string, unknown>;
  if (row.kind === "batches" && column === "budgetPrice")
    return values.budgetPrice ?? values.originalPrice;
  if (row.kind === "batches" && column === "dealPrice")
    return values.dealPrice ?? values.discountedPrice;
  return values[column];
}
function formatCell(column: string, value: unknown): ReactNode {
  if (column === "qrRequested")
    return value
      ? <span className="record-state qr-marked" aria-label="已申请二维码">已申请</span>
      : <span className="record-state qr-unmarked">未申请</span>;
  if (column === "engineer" && (value === null || value === "")) return "待补";
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (column === "amount") return money(String(value));
  if (column === "lastModifiedAt") return isoDateTime(String(value));
  if (["planTransportDate", "startedAt", "visitAt", "invoicedAt", "revokedAt", "orderedAt"].includes(column))
    return businessDate(String(value)) || String(value);
  return String(value);
}

function ServiceOrderNoteForm({
  order,
  onSave,
  onSaveEngineer,
}: {
  order: Extract<WorkbenchV2SectionRow, { kind: "orders" }>;
  onSave: (note: string | null) => Promise<void>;
  onSaveEngineer: (engineer: string | null) => Promise<void>;
}): JSX.Element {
  const [note, setNote] = useState(order.note ?? "");
  const [engineer, setEngineer] = useState(order.engineer ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(next: string): Promise<void> {
    setBusy(true); setError("");
    try { await onSave(next.trim() || null); }
    catch (cause) { setError(messageOf(cause)); setBusy(false); }
  }
  async function saveEngineer(next: string): Promise<void> {
    setBusy(true); setError("");
    try { await onSaveEngineer(next.trim() || null); }
    catch (cause) { setError(messageOf(cause)); setBusy(false); }
  }
  return <form id="service-order-note-form" className="record-edit-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save(note); }}>
    <LayerHeaderAction><button form="service-order-note-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : order.note ? "保存修改" : "补充备注"}</button></LayerHeaderAction>
    <div className="readonly-record compact"><div><span>服务单号</span><strong>{order.serviceOrderNo || "待补"}</strong></div><div><span>工程师</span><strong>{order.engineer || "待补"}</strong></div></div>
    <Field name="engineer" label="工程师" optional value={engineer} onChange={(event) => setEngineer(event.target.value)} help="可后补或更正，清空后保存会移除工程师。" />
    <div className="form-footer"><button className="button small" type="button" disabled={busy} onClick={() => void saveEngineer(engineer)}>{order.engineer ? "保存工程师" : "补充工程师"}</button><button className="button small" type="button" disabled={busy || !order.engineer} onClick={() => { setEngineer(""); void saveEngineer(""); }}>清空工程师</button></div>
    <TextArea name="serviceOrderNote" label="备注" value={note} onChange={(event) => setNote(event.target.value)} help="可修改、后补；清空后保存会移除现有备注。" autoFocus />
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="form-footer"><button className="button" type="button" disabled={busy || !order.note} onClick={() => { setNote(""); void save(""); }}>清空备注</button></div>
  </form>;
}

function QuickMenu({
  onChoose,
}: {
  onChoose: (type: WorkbenchActionType) => void;
}): JSX.Element {
  return (
    <div>
      <p className="notice">
        这里保存的记录均关联当前项目。四类开单都会显示在项目开单记录中；认证、单寄备件和 PM 仅作项目归档，不影响搬迁进度。序列号地址更新与二维码申请位于独立导航。
      </p>
      <div className="quick-grid">
        {ACTIONS.map((action) => (
          <button key={action.type} onClick={() => onChoose(action.type)}>
            <strong>{action.label}</strong>
            <span>{action.help}</span>
            <em>继续录入</em>
          </button>
        ))}
      </div>
    </div>
  );
}

type InstrumentImportRow = {
  name: string;
  manufacturer: string;
  model: string;
  serialNo: string;
  serviceLevel: string;
};

type ProjectSupplementFormPayload = ProjectSupplementPayload & {
  /** 后端并行补充中的后补事实字段。 */
  actualInstallDoneAt?: string;
};

const INSTRUMENT_IMPORT_HEADERS: Array<[keyof InstrumentImportRow, string]> = [
  ["name", "仪器名称"],
  ["manufacturer", "仪器产商"],
  ["model", "仪器型号"],
  ["serialNo", "序列号"],
  ["serviceLevel", "服务级别"],
];

function excelText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && value && "text" in value)
    return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && value && "result" in value)
    return String((value as { result?: unknown }).result ?? "").trim();
  return String(value).trim();
}

async function parseInstrumentWorkbook(file: File): Promise<{
  rows: InstrumentImportRow[];
  errors: string[];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], errors: ["工作簿没有可读取的工作表"] };
  const expected = new Map(INSTRUMENT_IMPORT_HEADERS.map(([key, label]) => [label, key]));
  const columns = new Map<keyof InstrumentImportRow, number>();
  const headerErrors: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    const label = excelText(cell.value);
    const key = expected.get(label);
    if (!key) headerErrors.push(`第 1 行：无法识别表头“${label}”`);
    else if (columns.has(key)) headerErrors.push(`第 1 行：表头“${label}”重复`);
    else columns.set(key, column);
  });
  for (const [key, label] of INSTRUMENT_IMPORT_HEADERS) {
    if (!columns.has(key)) headerErrors.push(`第 1 行：缺少表头“${label}”`);
  }
  if (headerErrors.length) return { rows: [], errors: headerErrors };
  const rows: InstrumentImportRow[] = [];
  const errors: string[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cell = (key: keyof InstrumentImportRow): string =>
      excelText(row.getCell(columns.get(key)!).value);
    const parsed: InstrumentImportRow = {
      name: cell("name"),
      manufacturer: cell("manufacturer"),
      model: cell("model"),
      serialNo: cell("serialNo"),
      serviceLevel: cell("serviceLevel"),
    };
    if (!Object.values(parsed).some(Boolean)) continue;
    if (!parsed.name) errors.push(`第 ${rowNumber} 行：仪器名称不能为空`);
    else rows.push(parsed);
  }
  if (!rows.length && !errors.length) errors.push("文件中没有仪器数据");
  return { rows, errors };
}

function InstrumentRecordForm({
  project,
  onSave,
  onBulkImport,
}: {
  project: WorkbenchProjectRow;
  onSave: (action: WorkbenchActionPayload) => Promise<void>;
  onBulkImport: (rows: InstrumentImportRow[]) => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<InstrumentImportRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function selectFile(file?: File): Promise<void> {
    setFileName(file?.name ?? "");
    setRows([]);
    setErrors([]);
    setError("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setErrors(["请选择 .xlsx 文件"]);
      return;
    }
    try {
      const parsed = await parseInstrumentWorkbook(file);
      setRows(parsed.rows);
      setErrors(parsed.errors);
    } catch (cause) {
      setErrors([`文件读取失败：${messageOf(cause)}`]);
    }
  }
  async function submitSingle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await onSave({
        type: "instrument",
        projectId: project.id,
        values: {
          name: String(data.get("name") || "").trim(),
          manufacturer: String(data.get("manufacturer") || "").trim(),
          model: String(data.get("model") || "").trim(),
          serialNo: String(data.get("serialNo") || "").trim(),
          serviceLevel: String(data.get("serviceLevel") || "").trim(),
          ups: data.get("ups") === "true",
        },
      });
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }
  async function submitBulk(): Promise<void> {
    if (!rows.length || errors.length) return;
    setBusy(true);
    setError("");
    try { await onBulkImport(rows); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }
  return (
    <div className="instrument-record-form">
      <div className="mode-switch" role="tablist" aria-label="仪器录入方式">
        <button type="button" role="tab" aria-selected={mode === "single"} onClick={() => setMode("single")}>单条录入</button>
        <button type="button" role="tab" aria-selected={mode === "bulk"} onClick={() => setMode("bulk")}>Excel 批量导入</button>
      </div>
      {mode === "single" ? (
        <form id="instrument-record-form" onSubmit={(event) => void submitSingle(event)}>
          <LayerHeaderAction><button form="instrument-record-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存记录"}</button></LayerHeaderAction>
          <div className="form-grid">
            <Field name="name" label="仪器名称" required autoFocus />
            <Field name="manufacturer" label="仪器产商" optional />
            <Field name="model" label="型号" optional />
            <Field name="serialNo" label="序列号" optional />
            <Field name="serviceLevel" label="服务级别" optional />
            <Select name="ups" label="UPS" required options={[["false", "否"], ["true", "是"]]} />
          </div>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="form-footer"><span>保存一台仪器</span></div>
        </form>
      ) : (
        <section className="bulk-import" aria-label="Excel 批量导入">
          <LayerHeaderAction><button type="button" className="button primary" disabled={busy || !rows.length || errors.length > 0} onClick={() => void submitBulk()}>{busy ? "正在导入…" : `确认导入 ${rows.length} 行`}</button></LayerHeaderAction>
          <p className="notice">首行只识别：仪器名称、仪器产商、仪器型号、序列号、服务级别。顺序不限，仅仪器名称必填。</p>
          <label className="file-picker">
            <span>选择 .xlsx 文件</span>
            <input type="file" accept=".xlsx" onChange={(event) => void selectFile(event.target.files?.[0])} />
          </label>
          {fileName && <div className="import-summary" role="status"><strong>{fileName}</strong><span>有效行数：{rows.length}</span></div>}
          {errors.length > 0 && <div className="import-errors" role="alert"><strong>请修正文件后重新选择</strong><ul>{errors.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="form-footer"><span>确认后整批提交，不逐行保存。</span></div>
        </section>
      )}
    </div>
  );
}

function ActionFormV2({
  type,
  project,
  detail,
  onSave,
  onCompleteShipTo,
  onInstrumentBulkImport,
  onSupplement,
}: {
  type: WorkbenchActionType;
  project: WorkbenchProjectRow;
  detail: WorkbenchV2ProjectDetailDto["detail"];
  onSave: (action: WorkbenchActionPayload) => Promise<void>;
  onCompleteShipTo: (requestId: string, accountId: string) => Promise<void>;
  onInstrumentBulkImport: (rows: InstrumentImportRow[]) => Promise<void>;
  onSupplement: (payload: ProjectSupplementFormPayload) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [damageStatus, setDamageStatus] = useState("untreated");
  const submitLock = useRef(false);
  const optionKind: WorkbenchV2SectionKind | null = [
    "visit",
    "damage",
  ].includes(type)
    ? "instruments"
    : null;
  const [optionId, setOptionId] = useState("");
  const [shipTo, setShipTo] = useState<Extract<
    WorkbenchV2LookupRow,
    { kind: "ship_to_requests" }
  > | null>(null);
  if (type === "instrument") {
    return (
      <InstrumentRecordForm
        project={project}
        onSave={onSave}
        onBulkImport={onInstrumentBulkImport}
      />
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const values: WorkbenchActionPayload["values"] = {};
    data.forEach((value, key) => {
      if (key === "workTypes" || key === "instrumentIds") {
        const current = values[key];
        values[key] = [
          ...(Array.isArray(current) ? current : []),
          String(value),
        ];
      } else values[key] = String(value);
    });
    if (optionKind === "instruments" && optionId) {
      values.instrumentId = optionId;
      values.instrumentIds = [optionId];
    }
    if (optionKind === "batches" && optionId) values.batchId = optionId;
    if (type === "core" && data.get("siteConfirmed") === "on") values.siteConfirmed = true;
    try {
      if (type === "ship_to" && shipTo)
        await onCompleteShipTo(shipTo.id, String(values.accountId || ""));
      else if (type === "core") {
        const optional = (key: string): string | undefined =>
          String(values[key] || "").trim() || undefined;
        const payload: ProjectSupplementFormPayload = { projectId: project.id };
        const set = <K extends keyof ProjectSupplementFormPayload>(
          key: K,
          value: ProjectSupplementFormPayload[K] | undefined,
        ): void => {
          if (value !== undefined) Object.assign(payload, { [key]: value });
        };
        for (const key of [
          "customerName", "region", "contractStartDate", "contractEndDate",
          "oldSiteContact", "newSiteContact", "oldSiteAddress", "newSiteAddress",
          "plannedVisitAt", "plannedTransportAt", "plannedInstallDoneAt", "actualInstallDoneAt",
          "approvalReason", "missingItems", "ecc", "entryAt", "contractAmount", "finalAmount",
        ] as const) set(key, optional(key));
        const instrumentCount = optional("instrumentCount");
        if (instrumentCount) set("instrumentCount", Number(instrumentCount));
        if (values.siteConfirmed === true) set("siteConfirmed", true);
        await onSupplement(payload);
      } else await onSave({ type, projectId: project.id, values });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      id="action-record-form"
      onSubmit={(event) => void submit(event)}
      onChange={(event) => {
        if (type !== "batch") return;
        const data = new FormData(event.currentTarget);
        try {
          const budget = String(data.get("budgetPrice") || "");
          const deal = String(data.get("dealPrice") || "");
          setWarning(budget && deal && centsOf(deal) > centsOf(budget) ? "物流成交价高于合同预算价，可以保存，请确认差额。" : "");
        } catch {
          setWarning("");
        }
      }}
    >
      <LayerHeaderAction><button form="action-record-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存记录"}</button></LayerHeaderAction>
      <p className="notice">
        {ACTIONS.find((action) => action.type === type)?.help}
        。选项按当前项目分页读取，不加载全量记录。
      </p>
      <div className="form-grid">
        {optionKind && (
          <BoundedSectionPicker
            projectId={project.id}
            kind={optionKind}
            value={optionId}
            onChange={setOptionId}
            required
          />
        )}
        {type === "ship_to" && (
          <BoundedShipToPicker value={shipTo?.id || ""} onChange={setShipTo} />
        )}
        {actionFields(type, project, shipTo, detail, damageStatus, setDamageStatus)}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {warning && <div className="inline-warning" role="status">{warning}</div>}
      <div className="form-footer">
        <span>保存后仅刷新受影响的项目和当前详情</span>
      </div>
    </form>
  );
}

function BatchEditForm({
  batch,
  onSave,
}: {
  batch: Extract<WorkbenchV2SectionRow, { kind: "batches" }>;
  onSave: (values: BatchEditValues) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitLock = useRef(false);
  const values = batch as unknown as Record<string, unknown>;
  const budgetPrice = String(values.budgetPrice ?? values.originalPrice ?? "");
  const dealPrice = String(values.dealPrice ?? values.discountedPrice ?? "");
  const appliedAt = String(values.appliedAt ?? "");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await onSave({
        planTransportDate: String(data.get("planTransportDate") ?? "").trim() || null,
        transportCompany: String(data.get("transportCompany") ?? "").trim() || null,
        appliedAt: String(data.get("appliedAt") ?? "").trim() || null,
        budgetPrice: String(data.get("budgetPrice") ?? "").trim() || null,
        dealPrice: String(data.get("dealPrice") ?? "").trim() || null,
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  return (
    <form id="batch-edit-form" className="project-edit-form" onSubmit={(event) => void submit(event)}>
      <LayerHeaderAction><button form="batch-edit-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存批次修改"}</button></LayerHeaderAction>
      <p className="notice">
        可补充、修改或清空本条物流费用信息。修改费用登记日期会影响报表归属月份。
      </p>
      <div className="edit-form-sections">
        <fieldset className="edit-form-section">
          <legend>运输安排</legend>
          <div className="form-grid">
            <Field
              name="planTransportDate"
              label="运输日期"
              type="date"
              defaultValue={batch.planTransportDate ?? ""}
              optional
              help="可留空；填写时请选择有效日期。"
              autoFocus
            />
            <Field
              name="transportCompany"
              label="运输公司"
              defaultValue={batch.transportCompany ?? ""}
              optional
            />
            <Field
              name="appliedAt"
              label="费用登记日期"
              type="date"
              defaultValue={appliedAt}
              optional
              help="可留空；填写时请选择有效日期。修改后会影响报表归属月份。"
            />
          </div>
        </fieldset>
        <fieldset className="edit-form-section">
          <legend>价格</legend>
          <div className="form-grid">
            <Field
              name="budgetPrice"
              label="合同预算价"
              type="number"
              step="0.01"
              defaultValue={budgetPrice}
              optional
              help="可留空；填写时请输入大于 0 的金额。"
            />
            <Field
              name="dealPrice"
              label="物流成交价"
              type="number"
              step="0.01"
              defaultValue={dealPrice}
              optional
              help="可留空；填写时请输入不小于 0 的金额。"
            />
          </div>
        </fieldset>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-footer">
        <span>保存后刷新当前项目的物流费用记录。</span>
      </div>
    </form>
  );
}

function DamageUpdateForm({
  damage,
  onSave,
}: {
  damage: Extract<WorkbenchV2SectionRow, { kind: "damage_items" }>;
  onSave: (issueStatus: string, closeReason?: string) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issueStatus, setIssueStatus] = useState(damage.issueStatus);
  return (
    <form id="damage-update-form" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBusy(true);
      setError("");
      void onSave(issueStatus, String(data.get("closeReason") || "").trim() || undefined)
        .catch((cause) => setError(messageOf(cause)))
        .finally(() => setBusy(false));
    }}>
      <LayerHeaderAction><button form="damage-update-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存维修状态"}</button></LayerHeaderAction>
      <p className="notice">{damage.instrumentName || "仪器名称待补"} · {damage.serialNo || "无序列号"}</p>
      <div className="form-grid">
        <Select name="issueStatus" label="维修状态" value={issueStatus} onChange={(event) => setIssueStatus(event.target.value)} required autoFocus options={[
          ["untreated", "未处理"],
          ["processing", "维修中"],
          ["repaired", "已修复"],
          ["closed_unrepaired", "未修复关闭"],
        ]} />
        {issueStatus === "closed_unrepaired" && (
          <Field name="closeReason" label="关闭原因" required />
        )}
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-footer"><span>更新当前损坏事项</span></div>
    </form>
  );
}

function actionFields(
  type: WorkbenchActionType,
  project: WorkbenchProjectRow,
  shipTo: Extract<
    WorkbenchV2LookupRow,
    { kind: "ship_to_requests" }
  > | null,
  detail: WorkbenchV2ProjectDetailDto["detail"],
  damageStatus: string,
  onDamageStatus: (status: string) => void,
): ReactNode {
  if (type === "batch")
    return (
      <>
        <Field
          name="planTransportDate"
          label="运输日期"
          type="date"
          optional
          help="可留空；填写时请选择有效日期。"
          autoFocus
        />
        <Field name="transportCompany" label="运输公司" optional />
        <Field
          name="appliedAt"
          label="费用登记日期"
          type="date"
          optional
          help="可留空；填写时请选择有效日期。填写后用于报表归属月份，后续修改会改变归属月份。"
        />
        <Field
          name="budgetPrice"
          label="合同预算价"
          type="number"
          step="0.01"
          optional
          help="可留空；填写时请输入大于 0 的金额。"
        />
        <Field
          name="dealPrice"
          label="物流成交价"
          type="number"
          step="0.01"
          optional
          help="可留空；填写时请输入不小于 0 的金额。高于合同预算价时会提示确认，但仍允许记录。"
        />
      </>
    );
  if (type === "visit")
    return (
      <>
        <Field
          name="visitAt"
          label="到访日期"
          type="date"
          autoFocus
          optional
        />
        <Field name="engineers" label="参与工程师" required />
        <Select
          name="status"
          label="工作事实状态"
          required
          options={[
            ["in_progress", "进行中"],
            ["done", "已完成"],
          ]}
        />
        <div className="field full" role="group" aria-labelledby="v2-work-types-label">
          <span className="field-label" id="v2-work-types-label">
            工作类型 <b>必填</b>
          </span>
          <div className="choice-grid">
            {[
              ["teardown", "拆机"],
              ["install", "装机"],
              ["repair", "维修"],
              ["other", "其他"],
            ].map(([value, label], index) => (
              <label key={value}>
                <input type="checkbox" name="workTypes" value={value} defaultChecked={index === 0} />
                {label}
              </label>
            ))}
          </div>
        </div>
      </>
    );
  if (type === "order")
    return (
      <>
        <Select
          name="orderType"
          label="开单类型"
          help="认证、单寄备件和 PM 仅作项目归档，不影响搬迁进度。"
          options={[
            ["relocation", "搬迁"],
            ["certification", "认证"],
            ["parts_by_mail", "单寄备件"],
            ["pm", "PM"],
          ]}
        />
        <Field name="serviceOrderNo" label="服务单号" required help="保存后可在当前项目的开单记录中查看。" />
        <Field
          name="orderedAt"
          label="开单日期"
          type="date"
          required
        />
        <Field name="engineer" label="工程师" optional help="可留空后补；保存后关联当前项目，并计入该工程师工作量。" />
      </>
    );
  if (type === "acceptance")
    return (
      <Field
        name="reportDate"
        label="验收报告形成日期"
        type="date"
        required
        autoFocus
      />
    );
  if (type === "invoice")
    return (
      <>
        <Field
          name="invoicedAt"
          label="掉票日期"
          type="date"
          required
          autoFocus
        />
        <Field
          name="amount"
          label="掉票金额（USD）"
          type="number"
          step="0.01"
          required
        />
      </>
    );
  if (type === "ship_to")
    return (
      <>
        <Field
          key={`customer-${shipTo?.id || "new"}`}
          name="customerName"
          label="客户名称"
          defaultValue={shipTo?.customerName || project.customerName}
          required
          autoFocus
          disabled={Boolean(shipTo)}
        />
        <Field
          key={`address-${shipTo?.id || "new"}`}
          name="newSiteAddress"
          label="新址地址"
          defaultValue={shipTo?.newSiteAddress || ""}
          required
          disabled={Boolean(shipTo)}
        />
        {!shipTo && (
          <Select
            name="status"
            label="推进到"
            options={[
              ["pending_submit", "待提交"],
              ["processing", "处理中"],
              ["completed", "已完成"],
            ]}
          />
        )}
        <Field
          name="accountId"
          label="Account ID"
          defaultValue={shipTo?.accountId || ""}
          required={Boolean(shipTo)}
        />
      </>
    );
  if (type === "damage")
    return (
      <>
        <Field name="damageReason" label="损坏原因" required help="一个事项只对应一个备件；多个备件请分别建立事项。" />
        <Field name="partNumber" label="备件号" required />
        <Field
          name="partQuantity"
          label="数量"
          type="number"
          min="1"
          required
        />
        <Field
          name="partAmount"
          label="备件金额"
          type="number"
          step="0.01"
          min="0.01"
          required
          help="仅备件状态为“已使用”时计入维修费用；合同金额为 0 时占比不可计算。"
        />
        <Select
          name="partCurrency"
          label="币种"
          options={[
            ["RMB", "RMB"],
            ["USD", "USD"],
          ]}
        />
        <Select
          name="partStatus"
          label="备件状态"
          options={[
            ["pending_submit", "待提交"],
            ["processing", "处理中"],
            ["arrived", "已到件"],
            ["used", "已使用"],
          ]}
        />
        <Select
          name="issueStatus"
          label="事项处理状态"
          value={damageStatus}
          onChange={(event) => onDamageStatus(event.target.value)}
          options={[
            ["untreated", "未处理"],
            ["processing", "维修中"],
            ["repaired", "已修复"],
            ["closed_unrepaired", "未修复关闭"],
          ]}
        />
        {damageStatus === "closed_unrepaired" && (
          <Field name="closeReason" label="关闭原因" required />
        )}
        <Field
          name="registeredAt"
          label="登记日期"
          type="date"
          required
        />
      </>
    );
  return (
    <>
      <div className="form-group-title full">项目与进单</div>
      <Field name="customerName" label="客户名称" defaultValue={project.customerName} optional />
      <Field name="region" label="区域" defaultValue={project.region || ""} optional />
      <Field
        name="ecc"
        label="ECC"
        defaultValue={project.ecc || ""}
        optional
        autoFocus
      />
      <Field name="entryAt" label="进单日期" type="date" defaultValue={businessDate(project.entryAt)} optional />
      <Field name="contractStartDate" label="合同开始日期" type="date" defaultValue={detail?.contractStartDate ?? ""} optional />
      <Field name="contractEndDate" label="合同截止日期" type="date" defaultValue={detail?.contractEndDate ?? ""} optional />
      <Field
        name="contractAmount"
        label="合同 USD 含税金额"
        type="number"
        step="0.01"
        help={ZERO_CONTRACT_AMOUNT_GUIDANCE}
        defaultValue={project.contractAmount ?? ""}
        optional
      />
      <Field
        name="finalAmount"
        label="最终可确认金额"
        type="number"
        step="0.01"
        defaultValue={project.finalAmount ?? ""}
        optional
      />
      <Field name="instrumentCount" label="仪器数量" type="number" min="1" step="1" defaultValue={detail?.temporaryInstrumentCount ?? ""} optional />
      <div className="form-group-title full">地点与联系人</div>
      <Field name="oldSiteContact" label="旧址联系人" defaultValue={detail?.oldSiteContact ?? ""} optional />
      <Field name="newSiteContact" label="新址联系人" defaultValue={detail?.newSiteContact ?? ""} optional />
      <Field name="oldSiteAddress" label="旧址地址" defaultValue={detail?.oldSiteAddress ?? ""} optional />
      <Field name="newSiteAddress" label="新址地址" defaultValue={detail?.newSiteAddress ?? ""} optional />
      <div className="form-group-title full">执行准备</div>
      <Field name="plannedVisitAt" label="计划上门日期" type="date" defaultValue={businessDate(detail?.planVisitAt)} optional />
      <Field name="plannedTransportAt" label="计划运输日期" type="date" defaultValue={businessDate(detail?.planTransportAt)} optional />
      <Field name="plannedInstallDoneAt" label="计划装机日期" type="date" defaultValue={businessDate(detail?.plannedInstallAt ?? detail?.plannedInstallDoneAt)} optional />
      <Field name="actualInstallDoneAt" label="实际装机完成日期" type="date" defaultValue={businessDate(detail?.actualInstallDoneAt)} optional />
      <label className="confirm-check full"><input name="siteConfirmed" type="checkbox" defaultChecked={detail?.siteConfirmed ?? false} />现场条件已确认</label>
    </>
  );
}

function BoundedSectionPicker({
  projectId,
  kind,
  value,
  onChange,
  onSelect,
  required = false,
}: {
  projectId: string;
  kind: "instruments" | "batches";
  value: string;
  onChange: (value: string) => void;
  onSelect?: (row: WorkbenchV2SectionPageDto["rows"][number] | null) => void;
  required?: boolean;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2SectionPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2SectionPage",
      )({ projectId, kind, cursor, limit: 25 });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    setStack([null]);
    void load(null);
  }, [projectId, kind]);
  useEffect(() => {
    if (required && !value && page?.rows[0]) onChange(page.rows[0].id);
  }, [page, required, value]);
  return (
    <div className="field full bounded-picker">
      <label htmlFor={`v2-${kind}-picker`}>
        {kind === "instruments" ? "搬迁仪器" : "物流费用记录"}{" "}
        {required && <b>必填</b>}
      </label>
      <select
        id={`v2-${kind}-picker`}
        value={value}
        required={required}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          onSelect?.(page?.rows.find((row) => row.id === nextValue) ?? null);
        }}
      >
        <option value="">请选择当前页记录</option>
        {page?.rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.kind === "instruments"
              ? `${row.serialNo || "无序列号"} · ${row.name}`
              : row.kind === "batches"
                ? `${row.transportCompany || "运输公司待补"} · ${row.planTransportDate || "日期待补"}`
                : row.id}
          </option>
        ))}
      </select>
      <div className="picker-pagination">
        <span>
          本页 {page?.rows.length ?? 0} / 共 {page?.total ?? 0}
        </span>
        <button
          type="button"
          disabled={stack.length <= 1}
          onClick={() => {
            const next = stack.slice(0, -1);
            setStack(next);
            void load(next.at(-1) ?? null);
          }}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!page?.nextCursor}
          onClick={() => {
            if (!page?.nextCursor) return;
            const next = [...stack, page.nextCursor];
            setStack(next);
            void load(page.nextCursor);
          }}
        >
          下一页
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function BoundedShipToPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (
    row: Extract<WorkbenchV2LookupRow, { kind: "ship_to_requests" }> | null,
  ) => void;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2LookupPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2LookupPage",
      )({
        kind: "ship_to_requests",
        query: query.trim() || null,
        cursor,
        limit: 25,
      });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    void load(null);
  }, []);
  const rows =
    page?.rows.filter(
      (
        row,
      ): row is Extract<WorkbenchV2LookupRow, { kind: "ship_to_requests" }> =>
        row.kind === "ship_to_requests",
    ) ?? [];
  return (
    <div className="field full bounded-picker">
      <label htmlFor="v2-ship-to-request">已有 Account ID 申请</label>
      <div className="lookup-search">
        <input
          aria-label="查找 Account ID 申请"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="客户名称或新址"
        />
        <button
          type="button"
          onClick={() => {
            setStack([null]);
            void load(null);
          }}
        >
          查找
        </button>
      </div>
      <select
        id="v2-ship-to-request"
        value={value}
        onChange={(event) =>
          onChange(rows.find((row) => row.id === event.target.value) ?? null)
        }
      >
        <option value="">新建申请</option>
        {rows.map((row) => (
          <option value={row.id} key={row.id}>
            {row.customerName} · {row.newSiteAddress} · {row.status}
          </option>
        ))}
      </select>
      <small>Account ID 主数据不在这里直接改写；申请资料有误时，请按正确客户与新址重新发起申请。</small>
      <div className="picker-pagination">
        <span>
          本页 {rows.length} / 共 {page?.total ?? 0}
        </span>
        <button
          type="button"
          disabled={stack.length <= 1}
          onClick={() => {
            const next = stack.slice(0, -1);
            setStack(next);
            void load(next.at(-1) ?? null);
          }}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!page?.nextCursor}
          onClick={() => {
            if (!page?.nextCursor) return;
            const next = [...stack, page.nextCursor];
            setStack(next);
            void load(page.nextCursor);
          }}
        >
          下一页
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function IndependentModuleV2({
  kind,
  project,
  refreshToken,
  onSave,
  onDelete,
}: {
  kind: WorkbenchV2IndependentKind;
  project: WorkbenchProjectRow | null;
  refreshToken: number;
  onSave: (action: WorkbenchActionPayload) => Promise<void>;
  onDelete: (kind: "serial_address" | "qr_request", id: string) => Promise<void>;
}): JSX.Element {
  const [page, setPage] = useState<WorkbenchV2IndependentPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [instrumentId, setInstrumentId] = useState("");
  const [serialNo, setSerialNo] = useState("");
  const [qrTypes, setQrTypes] = useState<string[]>(["A", "B"]);
  const sequence = useRef(0);
  async function load(cursor: string | null): Promise<void> {
    const id = ++sequence.current;
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const next = await requireV2(
        api,
        "v2IndependentPage",
      )({ kind, query: query.trim() || null, from: from || null, to: to || null, limit: 50, cursor });
      if (id === sequence.current) setPage(next);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  useEffect(() => {
    setStack([null]);
    void load(null);
  }, [kind, refreshToken]);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const values: WorkbenchActionPayload["values"] = {};
    data.forEach((value, key) => {
      if (key !== "types") values[key] = String(value);
    });
    if (kind === "qr_request") values.types = [...new Set(qrTypes)];
    if (kind === "serial_address") values.instrumentId = instrumentId;
    try {
      if (kind === "qr_request" && qrTypes.length === 0) {
        throw new Error("请至少选择一种二维码申请类型");
      }
      await onSave({
        type: kind,
        projectId: kind === "serial_address" ? project?.id : undefined,
        values,
      });
      await load(stack.at(-1) ?? null);
      if (kind === "qr_request") setQrTypes(["A", "B"]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`module-layout v2-independent ${kind === "qr_request" ? "qr-request-module" : ""}`}
    >
      <form
        id="independent-record-form"
        className={kind === "qr_request" ? "qr-request-form" : undefined}
        onSubmit={(event) => void submit(event)}
      >
        <LayerHeaderAction><button form="independent-record-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : kind === "qr_request" ? "保存申请" : "保存记录"}</button></LayerHeaderAction>
        <div className="form-grid">
          {kind === "serial_address" ? (
            <>
              {project ? (
                <div className="optional-link full">
                  <span>可选关联</span>
                  <BoundedSectionPicker
                    projectId={project.id}
                    kind="instruments"
                    value={instrumentId}
                    onChange={setInstrumentId}
                    onSelect={(row) => setSerialNo(row?.kind === "instruments" ? row.serialNo ?? "" : "")}
                  />
                  <small>可关联当前项目仪器，也可以留空独立登记。</small>
                </div>
              ) : (
                <p className="notice full">
                  无需选择项目或仪器，直接填写下面的业务信息即可。
                </p>
              )}
              <Field
                name="customerName"
                label="客户名称"
                defaultValue={project?.customerName || ""}
                required
              />
              <Field name="newSiteAddress" label="新址地址" required />
              <Field
                name="serialNo"
                label="序列号"
                value={serialNo}
                onChange={(event) => setSerialNo(event.target.value)}
                required
              />
              <Field name="accountId" label="Account ID" required />
              <Field
                name="updatedAt"
                label="更新日期"
                type="date"
                defaultValue={todayDate()}
                required
              />
            </>
          ) : (
            <>
              <Field
                name="applicant"
                label="申请人"
                defaultValue="搬迁负责人"
                required
                autoFocus
              />
              <Field
                name="requestedAt"
                label="申请日期"
                type="date"
                defaultValue={todayDate()}
                required
              />
              <div className="field full" role="group" aria-labelledby="v2-qr-types-label">
                <span className="field-label" id="v2-qr-types-label">
                  申请类型 <b>至少一类</b>
                </span>
                <div className="choice-grid qr-type-grid">
                  {QR_REQUEST_TYPES.map(({ code, label }) => (
                    <label key={code}>
                      <input
                        type="checkbox"
                        name="types"
                        value={code}
                        checked={qrTypes.includes(code)}
                        onChange={(event) =>
                          setQrTypes((current) =>
                            event.target.checked
                              ? [...current, code]
                              : current.filter((item) => item !== code),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <small>
                  类型只用于分类和计数；同一条记录内去重，不关联搬迁仪器或搬迁项目。
                </small>
              </div>
              <div className="field full qr-workload-preview" aria-live="polite">
                <div>
                  <span>本条记录</span>
                  <strong>1 条</strong>
                </div>
                <div>
                  <span>去重类型</span>
                  <strong>{new Set(qrTypes).size} 类</strong>
                </div>
                <div>
                  <span>计入工作量</span>
                  <strong>{new Set(qrTypes).size}</strong>
                </div>
              </div>
            </>
          )}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-footer">
          <span>
            {kind === "qr_request"
              ? "每条记录按去重后的选中类型计工作量"
              : "保存后仅刷新当前独立模块"}
          </span>
        </div>
      </form>
      <section className="module-list">
        {kind === "qr_request" && (
          <div className="module-list-heading">
            <div>
              <h3>申请记录</h3>
              <p>重复申请独立保留并分别计入工作量。</p>
            </div>
            <span>{page?.total ?? 0} 条</span>
          </div>
        )}
        <form
          className="module-search"
          onSubmit={(event) => {
            event.preventDefault();
            setStack([null]);
            void load(null);
          }}
        >
          <label>
            查找记录
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>起始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>截止日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <button className="button">查找</button>
        </form>
        <DataRows kind={kind} rows={page?.rows ?? []} onDelete={(id) => {
          if (!window.confirm("删除后无法恢复，确认删除这条记录？")) return;
          void onDelete(kind, id).then(() => load(stack.at(-1) ?? null)).catch((cause) => setError(messageOf(cause)));
        }} />
        <div className="queue-pagination">
          <button
            className="button"
            disabled={stack.length <= 1}
            onClick={() => {
              const next = stack.slice(0, -1);
              setStack(next);
              void load(next.at(-1) ?? null);
            }}
          >
            上一页
          </button>
          <span>
            本页 {page?.rows.length ?? 0} / 共 {page?.total ?? 0}
          </span>
          <button
            className="button"
            disabled={!page?.nextCursor}
            onClick={() => {
              if (!page?.nextCursor) return;
              const next = [...stack, page.nextCursor];
              setStack(next);
              void load(page.nextCursor);
            }}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  );
}

function DataRows({
  kind,
  rows,
  onDelete,
}: {
  kind: WorkbenchV2IndependentKind;
  rows: WorkbenchV2IndependentPageDto["rows"];
  onDelete: (id: string) => void;
}): JSX.Element {
  if (!rows.length)
    return <Empty title="暂无记录" copy="使用左侧表单新增记录。" />;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
            <tr>
              {kind === "qr_request" ? <><th>申请人</th><th>申请日期</th><th>申请类型</th><th className="numeric">工作量</th></> : <><th>客户 / 序列号</th><th>新址</th><th>Account ID</th><th>更新日期</th></>}
              <th>操作</th>
            </tr>
          </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === "qr_request" ? (
              <tr key={row.id}>
                <td><strong>{row.applicant}</strong></td>
                <td>{businessDate(row.requestedAt)}</td>
                <td className="qr-type-list">
                  {row.types.map(
                    (type) => QR_REQUEST_TYPE_LABEL.get(type) ?? type,
                  ).join("、")}
                </td>
                <td className="numeric qr-workload-cell">{row.workload}</td>
                <td><div className="restricted-action"><button className="button danger small" onClick={() => onDelete(row.id)}>删除</button><small>申请内容有误时，删除后重新登记。</small></div></td>
              </tr>
            ) : (
              <tr key={row.id}>
                <td>
                  <strong>{row.customerName}</strong>
                  <small>{row.serialNo}</small>
                </td>
                <td>{row.newSiteAddress}</td>
                <td>{row.accountId}</td>
                <td>{businessDate(row.updatedAt)}</td>
                <td><div className="restricted-action"><button className="button danger small" onClick={() => onDelete(row.id)}>删除</button><small>地址事实有误时，删除后按最新资料重新登记。</small></div></td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

type TagCatalogProps = {
  catalog: ProjectTagCatalogDto | null;
  catalogLoading: boolean;
  catalogError: string;
  onRetryCatalog: () => Promise<void>;
};

function validCatalogTagIds(catalog: ProjectTagCatalogDto, selected: readonly string[]): string[] {
  const selectedSet = new Set(selected);
  return catalog.groups.flatMap((group) => group.tags.map((tag) => tag.id)).filter((tagId) => selectedSet.has(tagId));
}

function GroupedTagPicker({
  catalog,
  loading,
  error,
  selected,
  onChange,
  onRetry,
  legend = "项目分类标签",
  disabled = false,
}: {
  catalog: ProjectTagCatalogDto | null;
  loading: boolean;
  error: string;
  selected: readonly string[];
  onChange: (tagIds: string[]) => void;
  onRetry: () => void;
  legend?: string;
  disabled?: boolean;
}): JSX.Element {
  const selectedSet = new Set(selected);
  function toggle(tagId: string): void {
    onChange(selectedSet.has(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]);
  }
  return (
    <fieldset className="tag-picker full" disabled={disabled}>
      <legend>{legend}</legend>
      <p>可在同一组或不同组中多选；分类不会改变项目主状态。</p>
      {loading ? <div className="tag-catalog-state" role="status">正在读取项目分类标签…</div>
        : error ? <div className="inline-error" role="alert">{error}<button className="text-action" type="button" data-tag-picker-retry onClick={onRetry}>重试</button></div>
          : !catalog?.groups.length ? <div className="tag-catalog-state">标签库暂无内容，请先到“项目分类标签库”创建分组和标签。</div>
            : <div className="tag-picker-groups">{catalog.groups.map((group) => (
              <fieldset key={group.id} className="tag-picker-group">
                <legend>{group.name}</legend>
                {group.tags.length ? <div className="tag-options">{group.tags.map((tag) => (
                  <label key={tag.id} className={selectedSet.has(tag.id) ? "selected" : ""}>
                    <input type="checkbox" name="tagIds" value={tag.id} checked={selectedSet.has(tag.id)} onChange={() => toggle(tag.id)} />
                    <span>{tag.name}</span>
                  </label>
                ))}</div> : <span className="tag-group-empty">暂无标签</span>}
              </fieldset>
            ))}</div>}
    </fieldset>
  );
}

function GroupedTags({ groups, compact = false }: { groups?: readonly ProjectTagGroupSummaryDto[]; compact?: boolean }): JSX.Element | null {
  if (!groups?.length) return null;
  return <div className={`project-tags ${compact ? "compact" : ""}`} aria-label="项目分类标签">
    {groups.map((group) => <div className="project-tag-group" key={group.groupId}>
      <span>{group.groupName}</span>
      <div>{group.tagNames.map((name, index) => <b key={group.tagIds[index] ?? name}>{name}</b>)}</div>
    </div>)}
  </div>;
}

function normalizedTagIds(catalog: ProjectTagCatalogDto, selected: readonly string[]): string[] {
  return validCatalogTagIds(catalog, [...new Set(selected)]);
}

function sameTagSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function ProjectTagEditForm({
  initialTagIds,
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  onGuardChange,
  onCancel,
  onSave,
}: TagCatalogProps & {
  initialTagIds: readonly string[];
  onGuardChange: (guard: { dirty: boolean; busy: boolean }) => void;
  onCancel: (trigger: HTMLElement) => void;
  onSave: (tagIds: readonly string[]) => Promise<void>;
}): JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([...initialTagIds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const normalizedInitial = catalog ? normalizedTagIds(catalog, initialTagIds) : [];
  const normalizedSelected = catalog ? normalizedTagIds(catalog, selectedTagIds) : [];
  const dirty = Boolean(catalog) && !sameTagSet(normalizedInitial, normalizedSelected);
  const unavailable = catalogLoading || Boolean(catalogError) || !catalog;

  useEffect(() => {
    onGuardChange({ dirty, busy });
  }, [dirty, busy, onGuardChange]);

  useEffect(() => {
    if (catalogLoading) return;
    const target = catalogError
      ? formRef.current?.querySelector<HTMLElement>("[data-tag-picker-retry]")
      : !catalog?.groups.length
        ? formRef.current?.querySelector<HTMLElement>("[data-tag-edit-cancel]")
        : formRef.current?.querySelector<HTMLElement>('input[type="checkbox"]:not([disabled])');
    window.setTimeout(() => target?.focus(), 0);
  }, [catalogLoading, catalogError, catalog]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dirty || unavailable || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(normalizedSelected);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  }

  return (
    <form id="project-tag-edit-form" ref={formRef} className="project-tag-edit" aria-busy={busy} onSubmit={(event) => void submit(event)}>
      <LayerHeaderAction><button form="project-tag-edit-form" className="button primary" disabled={!dirty || unavailable || busy}>{busy ? "正在保存…" : "保存标签"}</button></LayerHeaderAction>
      <div className="project-tag-edit-scroll">
        <GroupedTagPicker
          catalog={catalog}
          loading={catalogLoading}
          error={catalogError}
          selected={selectedTagIds}
          onChange={(tagIds) => { setSelectedTagIds(tagIds); setError(""); }}
          onRetry={() => void onRetryCatalog()}
          legend="选择项目标签"
          disabled={busy}
        />
        {!catalogLoading && !catalogError && !catalog?.groups.length && (
          <p className="tag-library-guidance">标签库暂无内容。请取消后从顶部“标签库”进入“管理标签库”。</p>
        )}
      </div>
      {error && <div className="inline-error project-tag-edit-error" role="alert">{error}</div>}
      <footer className="project-tag-edit-footer">
        <span>已选择 <b>{normalizedSelected.length}</b> 个标签</span>
        <div className="row-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            data-tag-edit-cancel
            onClick={(event) => onCancel(event.currentTarget)}
          >
            取消
          </button>
        </div>
      </footer>
    </form>
  );
}

function TagLibraryPanel({ catalog, loading, error, onRefresh, onRename }: { catalog: ProjectTagCatalogDto | null; loading: boolean; error: string; onRefresh: () => Promise<void>; onRename: (request: TagRenameMutation) => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState<"group" | "tag" | "">("");
  const [mutationError, setMutationError] = useState("");
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState<{ kind: "group" | "tag"; id: string; name: string } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>, command: "create_group" | "create_tag"): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const groupId = String(data.get("groupId") ?? "");
    setBusy(command === "create_group" ? "group" : "tag"); setMutationError(""); setNotice("");
    try {
      const api = bridge();
      if (!api?.v2TagMutate) throw new Error("当前环境暂不支持维护标签库");
      await api.v2TagMutate(command === "create_group" ? { command, payload: { name } } : { command, payload: { groupId, name } });
      form.reset();
      await onRefresh();
      setNotice(command === "create_group" ? "标签分组已创建" : "组内标签已创建，可供全部项目选择");
    } catch (cause) { setMutationError(messageOf(cause)); }
    finally { setBusy(""); }
  }
  async function rename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!renaming) return;
    const name = String(new FormData(event.currentTarget).get("rename") ?? "").trim();
    if (!name || name === renaming.name) return;
    setBusy(renaming.kind); setMutationError(""); setNotice("");
    try {
      await onRename(renaming.kind === "group"
        ? { command: "rename_group", payload: { groupId: renaming.id, name } }
        : { command: "rename_tag", payload: { tagId: renaming.id, name } });
      setNotice(renaming.kind === "group" ? "分组名称已更新，所有使用位置已同步" : "标签名称已更新，所有使用位置已同步");
      setRenaming(null);
    } catch (cause) { setMutationError(messageOf(cause)); }
    finally { setBusy(""); }
  }
  return <div className="tag-library">
    <section className="tag-library-intro"><p className="overline">全局分类</p><h3>维护所有项目共用的分类标签</h3><p>创建分组及组内标签，供所有搬迁项目复用。</p></section>
    <div className="tag-library-create">
      <form onSubmit={(event) => void create(event, "create_group")}><h4>新建分组</h4><div className="field"><label htmlFor="tag-group-name">分组名称 <b>必填</b></label><input id="tag-group-name" name="name" placeholder="例如：项目优先级" required /></div><button className="button primary" disabled={Boolean(busy)}>{busy === "group" ? "正在创建…" : "创建分组"}</button></form>
      <form onSubmit={(event) => void create(event, "create_tag")}><h4>添加组内标签</h4><Select name="groupId" label="所属分组" required defaultValue="" options={[["", "请选择分组"], ...(catalog?.groups.map((group) => [group.id, group.name] as [string, string]) ?? [])]} /><div className="field"><label htmlFor="tag-item-name">标签名称 <b>必填</b></label><input id="tag-item-name" name="name" placeholder="例如：重点跟进" required /></div><button className="button primary" disabled={Boolean(busy) || !catalog?.groups.length}>{busy === "tag" ? "正在添加…" : "添加标签"}</button></form>
    </div>
    {notice && <div className="inline-success" role="status">{notice}</div>}
    {(error || mutationError) && <div className="inline-error" role="alert">{mutationError || error}<button className="text-action" type="button" onClick={() => void onRefresh()}>重试读取</button></div>}
    <section className="tag-library-catalog" aria-busy={loading}><div className="report-section-head"><div><p className="overline">当前标签库</p><h3>{catalog?.groups.length ?? 0} 个分组</h3></div></div>
      {loading ? <div className="tag-catalog-state" role="status">正在读取标签库…</div> : !catalog?.groups.length ? <Empty title="还没有标签分组" copy="先创建分组，再向分组中添加标签。" /> : <div className="tag-library-groups">{catalog.groups.map((group) => <article key={group.id}>
        <div className="tag-library-group-head"><h4>{group.name}</h4><button className="text-action" type="button" onClick={() => setRenaming({ kind: "group", id: group.id, name: group.name })}>重命名分组</button></div>
        {renaming?.kind === "group" && renaming.id === group.id && <form className="rename-form" onSubmit={(event) => void rename(event)}><Field name="rename" label="新的分组名称" defaultValue={renaming.name} required autoFocus /><small>保存后会影响所有项目中的分组名称。</small><div className="row-actions"><button className="button" type="button" onClick={() => setRenaming(null)}>取消</button><button className="button primary" disabled={Boolean(busy)}>保存名称</button></div></form>}
        {group.tags.length ? <div className="tag-library-tags">{group.tags.map((tag) => <div className="tag-library-tag" key={tag.id}><span>{tag.name}</span><button type="button" aria-label={`重命名标签${tag.name}`} onClick={() => setRenaming({ kind: "tag", id: tag.id, name: tag.name })}>重命名</button>{renaming?.kind === "tag" && renaming.id === tag.id && <form className="rename-form tag-rename-form" onSubmit={(event) => void rename(event)}><Field name="rename" label="新的标签名称" defaultValue={renaming.name} required autoFocus /><small>保存后会影响所有已使用该标签的位置。</small><div className="row-actions"><button className="button" type="button" onClick={() => setRenaming(null)}>取消</button><button className="button primary" disabled={Boolean(busy)}>保存名称</button></div></form>}</div>)}</div> : <p>暂无标签，可在上方添加。</p>}
      </article>)}</div>}
    </section>
  </div>;
}

function ProjectRegionSelect({
  value,
  legacy = false,
  onChange,
  required = true,
}: {
  value: string;
  legacy?: boolean;
  onChange?: (value: string) => void;
  required?: boolean;
}): JSX.Element {
  return <div className="field region-field">
    <label htmlFor="v2-region">区域 {required && <b>必填</b>}</label>
    {legacy && <div className="legacy-region-warning" role="status"><strong>待调整</strong><span>原区域“{value}”仅保留显示，请明确选择新的五区域后再保存。</span></div>}
    <select id="v2-region" name="region" value={value} required={required} onChange={(event) => onChange?.(event.target.value)}>
      <option value="" disabled>请选择区域</option>
      {legacy && value && <option value={value} disabled>{value}（待调整）</option>}
      {PROJECT_REGIONS.map((region) => <option value={region} key={region}>{region}</option>)}
    </select>
  </div>;
}

function ProjectEditForm({
  mode,
  project,
  detail,
  onSave,
}: {
  mode: "project" | "entry";
  project: WorkbenchProjectRow;
  detail: NonNullable<WorkbenchV2ProjectDetailDto["detail"]> | null;
  onSave: (payload: ProjectUpdatePayload) => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [region, setRegion] = useState(project.region ?? "");
  const nullable = (data: FormData, name: string): string | null => {
    const value = String(data.get(name) ?? "").trim();
    return value || null;
  };
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setError("");
    setNotice("");
    const patch: ProjectUpdatePayload = { projectId: project.id };
    function addIfChanged<K extends keyof ProjectUpdatePayload>(
      key: K,
      current: ProjectUpdatePayload[K],
      initial: ProjectUpdatePayload[K],
    ): void {
      if (current !== initial) patch[key] = current;
    }
    if (mode === "project") {
      addIfChanged("customerName", String(data.get("customerName") ?? "").trim(), project.customerName.trim());
      addIfChanged("region", String(data.get("region") ?? "").trim(), project.region ?? "");
      addIfChanged("contractStartDate", nullable(data, "contractStartDate"), detail?.contractStartDate ?? null);
      addIfChanged("contractEndDate", nullable(data, "contractEndDate"), detail?.contractEndDate ?? null);
      addIfChanged("oldSiteContact", nullable(data, "oldSiteContact"), detail?.oldSiteContact ?? null);
      addIfChanged("newSiteContact", nullable(data, "newSiteContact"), detail?.newSiteContact ?? null);
      addIfChanged("oldSiteAddress", nullable(data, "oldSiteAddress"), detail?.oldSiteAddress ?? null);
      addIfChanged("newSiteAddress", nullable(data, "newSiteAddress"), detail?.newSiteAddress ?? null);
      addIfChanged("plannedVisitAt", nullable(data, "plannedVisitAt"), detail?.planVisitAt ?? null);
      addIfChanged("plannedTransportAt", nullable(data, "plannedTransportAt"), detail?.planTransportAt ?? null);
      addIfChanged("plannedInstallAt", nullable(data, "plannedInstallAt"), detail?.plannedInstallAt ?? null);
      addIfChanged("siteConfirmed", data.has("siteConfirmed"), detail?.siteConfirmed ?? false);
      addIfChanged("projectNote", nullable(data, "projectNote"), detail?.projectNote ?? null);
      addIfChanged("temporaryStorageAddress", nullable(data, "temporaryStorageAddress"), detail?.temporaryStorageAddress ?? null);
      addIfChanged("isTemporaryStorage", data.get("isTemporaryStorage") === "" ? null : data.get("isTemporaryStorage") === "true", detail?.isTemporaryStorage ?? null);
      addIfChanged("temporaryHasUps", data.get("temporaryHasUps") === "" ? null : data.get("temporaryHasUps") === "true", detail?.temporaryHasUps ?? null);
    } else {
      addIfChanged("ecc", nullable(data, "ecc"), project.ecc);
      addIfChanged("entryAt", nullable(data, "entryAt"), businessDate(project.entryAt) || null);
      addIfChanged("contractUsdTaxAmount", nullable(data, "contractUsdTaxAmount"), project.contractAmount);
      addIfChanged("finalConfirmableAmount", nullable(data, "finalConfirmableAmount"), project.finalAmount);
    }
    if (Object.keys(patch).length === 1) {
      setNotice("没有需要保存的更改。");
      return;
    }
    setBusy(true);
    try {
      await onSave(patch);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }
  if (mode === "entry") {
    return (
      <form id="entry-correction-form" className="project-edit-form" onSubmit={(event) => void submit(event)} onChange={() => setNotice("")}>
        <LayerHeaderAction><button form="entry-correction-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存更正"}</button></LayerHeaderAction>
        <p className="notice">
          仅用于更正已经正式进单项目的识别与金额资料。合同金额是当前合同值；进单金额快照保留正式进单当时的口径，不会因本次更正自动改写。
        </p>
        <div className="edit-form-sections">
          <fieldset className="edit-form-section">
            <legend>进单识别</legend>
            <div className="form-grid">
              <Field name="ecc" label="ECC" defaultValue={project.ecc ?? ""} required autoFocus />
              <Field name="entryAt" label="进单日期" type="date" defaultValue={businessDate(project.entryAt)} required />
            </div>
          </fieldset>
          <fieldset className="edit-form-section">
            <legend>当前合同与闭环金额</legend>
            <div className="form-grid">
              <Field name="contractUsdTaxAmount" label="合同 USD 含税金额" type="number" step="0.01" min="0" defaultValue={project.contractAmount ?? ""} optional help="这是当前合同金额；允许为 0，不会覆盖正式进单时保存的进单金额快照。" />
              <Field name="finalConfirmableAmount" label="最终可确认金额（USD）" type="number" step="0.01" min="0.01" defaultValue={project.finalAmount ?? ""} optional help="用于当前掉票金额闭环；清空时由业务校验决定是否允许。" />
            </div>
          </fieldset>
        </div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="form-footer">
          <span>不会修改仪器、序列号或服务单资料。</span>
        </div>
      </form>
    );
  }
  return (
    <form
      id="project-edit-form"
      className="project-edit-form"
      onSubmit={(event) => void submit(event)}
      onChange={() => setNotice("")}
    >
      <LayerHeaderAction><button form="project-edit-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存项目资料"}</button></LayerHeaderAction>
      <p className="notice">维护项目级资料；逐台仪器、序列号和服务单请在各自业务入口维护。</p>
      <div className="edit-form-sections">
        <fieldset className="edit-form-section">
          <legend>基本信息</legend>
          <div className="form-grid">
            <Field name="customerName" label="客户名称" defaultValue={project.customerName} required autoFocus />
            <ProjectRegionSelect value={region} legacy={project.regionNeedsAdjustment} onChange={setRegion} />
            <Field name="contractStartDate" label="合同开始日期" type="date" defaultValue={detail?.contractStartDate ?? ""} optional />
            <Field name="contractEndDate" label="合同截止日期" type="date" defaultValue={detail?.contractEndDate ?? ""} optional />
            <TextArea name="projectNote" label="项目备注" defaultValue={detail?.projectNote ?? ""} optional />
          </div>
        </fieldset>
        <fieldset className="edit-form-section">
          <legend>地点与联系人</legend>
          <div className="form-grid">
            <Field name="oldSiteAddress" label="旧址地址" defaultValue={detail?.oldSiteAddress ?? ""} optional />
            <Field name="newSiteAddress" label="新址地址" defaultValue={detail?.newSiteAddress ?? ""} optional />
            <Field name="oldSiteContact" label="旧址联系人" defaultValue={detail?.oldSiteContact ?? ""} optional />
            <Field name="newSiteContact" label="新址联系人" defaultValue={detail?.newSiteContact ?? ""} optional />
          </div>
        </fieldset>
        <fieldset className="edit-form-section">
          <legend>设备范围</legend>
          <div className="form-grid">
            <Select name="temporaryHasUps" label="UPS" defaultValue={detail?.temporaryHasUps === null || detail?.temporaryHasUps === undefined ? "" : String(detail.temporaryHasUps)} options={[["", "未填写"], ["true", "是"], ["false", "否"]]} help="仅记录项目暂定范围，不代表逐台仪器事实。" />
          </div>
        </fieldset>
        <fieldset className="edit-form-section">
          <legend>执行准备</legend>
          <div className="form-grid">
            <Field name="plannedVisitAt" label="计划上门日期" type="date" defaultValue={businessDate(detail?.planVisitAt)} optional />
            <Field name="plannedTransportAt" label="计划运输日期" type="date" defaultValue={businessDate(detail?.planTransportAt)} optional />
            <Field name="plannedInstallAt" label="计划装机日期" type="date" defaultValue={businessDate(detail?.plannedInstallAt)} optional />
            <Select name="isTemporaryStorage" label="是否暂存" defaultValue={detail?.isTemporaryStorage === null || detail?.isTemporaryStorage === undefined ? "" : String(detail.isTemporaryStorage)} options={[["", "未填写"], ["false", "否"], ["true", "是"]]} />
            <Field name="temporaryStorageAddress" label="暂存地址" defaultValue={detail?.temporaryStorageAddress ?? ""} optional />
            <label className="confirm-check full">
              <input name="siteConfirmed" type="checkbox" defaultChecked={detail?.siteConfirmed ?? false} />
              现场条件已确认
            </label>
          </div>
        </fieldset>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="form-footer">
        <span>保存后刷新当前项目资料。</span>
      </div>
    </form>
  );
}

function ProjectCreateSinglePageForm({ catalog, catalogLoading, catalogError, onRetryCatalog, onSave }: TagCatalogProps & { onSave: (payload: ProjectWizardPayload) => Promise<void> }): JSX.Element {
  const [intent, setIntent] = useState<ProjectWizardPayload["intent"]>("formal");
  const [region, setRegion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [summary, setSummary] = useState({
    customerName: "", oldSiteAddress: "", newSiteAddress: "",
    temporaryHasUps: "",
    planVisitAt: "", planTransportAt: "", contractAmount: "",
  });
  const summaryText = (value: string): string => value.trim() || "未填写";
  const intentLabel: Record<ProjectWizardPayload["intent"], string> = {
    draft: "保存为待进单",
    pre_entry_execution: "未进单先执行",
    formal: "正式进单",
  };
  const summaryItems: Array<[string, string]> = [
    ["客户名称", summary.customerName],
    ["所属区域", region],
    ["旧址地址", summary.oldSiteAddress],
    ["新址地址", summary.newSiteAddress],
    ["UPS", summary.temporaryHasUps === "true" ? "是" : summary.temporaryHasUps === "false" ? "否" : ""],
    ["计划上门日期", summary.planVisitAt],
    ["计划运输日期", summary.planTransportAt],
    ["保存意图", intentLabel[intent]],
  ];
  const contractAmountIsZero = summary.contractAmount.trim() !== "" && centsOf(summary.contractAmount) === 0n;
  const updateSummary = (event: FormEvent<HTMLFormElement>): void => {
    const data = new FormData(event.currentTarget);
    const text = (name: string): string => String(data.get(name) ?? "");
    setSummary({
      customerName: text("customerName"), oldSiteAddress: text("oldSiteAddress"), newSiteAddress: text("newSiteAddress"),
      temporaryHasUps: text("temporaryHasUps"),
      planVisitAt: text("planVisitAt"), planTransportAt: text("planTransportAt"), contractAmount: text("contractAmount"),
    });
  };
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => String(data.get(key) || "").trim();
    if (intent === "formal" && !value("ecc")) { setError("正式进单必须填写 ECC。"); return; }
    setBusy(true); setError("");
    try {
      await onSave({
        intent, customerName: value("customerName"), region,
        contractStartDate: value("contractStartDate") || null, contractEndDate: value("contractEndDate") || null,
        ...(intent === "formal" ? { ecc: value("ecc"), entryAt: value("entryAt") || undefined, contractAmount: value("contractAmount") } : {}),
        oldSiteAddress: value("oldSiteAddress") || null,
        newSiteAddress: value("newSiteAddress") || null, oldSiteContact: value("oldSiteContact"), newSiteContact: value("newSiteContact"),
        temporaryHasUps: value("temporaryHasUps") === "" ? null : value("temporaryHasUps") === "true",
        projectNote: value("projectNote") || null,
        temporaryStorageAddress: value("temporaryStorageAddress") || null,
        isTemporaryStorage: value("isTemporaryStorage") === "" ? null : value("isTemporaryStorage") === "true",
        planVisitAt: value("planVisitAt"), planTransportAt: value("planTransportAt"), plannedInstallAt: value("plannedInstallAt"), actualInstallDoneAt: value("actualInstallDoneAt"),
        siteConfirmed: data.get("siteConfirmed") === "on",
        managerApproved: intent === "pre_entry_execution" ? value("managerApproved") === "true" : undefined,
        ...(catalog ? { tagIds: validCatalogTagIds(catalog, selectedTagIds) } : {}),
      });
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }
  const intents: Array<[ProjectWizardPayload["intent"], string, string]> = [
    ["formal", "正式进单", "明确使用 ECC 和进单日期完成进单"],
    ["draft", "保存为待进单", "先建项目，资料稍后补齐"],
    ["pre_entry_execution", "未进单先执行", "记录是否批复，项目仍保持待进单"],
  ];
  return <form id="project-create-form" className="project-create-form" onSubmit={(event) => void submit(event)} onChange={updateSummary}>
    <LayerHeaderAction><button form="project-create-form" className="button primary" disabled={busy}>{busy ? "正在保存…" : intentLabel[intent]}</button></LayerHeaderAction>
    <p className="notice">先明确保存意图。旧址、新址和设备范围均可后补，不影响建立项目。</p>
    <div className="create-form-sections">
      <fieldset className="edit-form-section"><legend>保存意图</legend><div className="form-grid">
        <div className="intent-choices full" role="radiogroup" aria-label="保存意图">{intents.map(([value,label,copy]) => <label key={value} className={intent === value ? "selected" : ""}><input type="radio" name="projectIntent" value={value} checked={intent === value} onChange={() => { setIntent(value); setError(""); }} /><strong>{label}</strong><span>{copy}</span></label>)}</div>
        {intent === "pre_entry_execution" && <div className="approval-fields full" role="group" aria-label="未进单先执行批复"><Select name="managerApproved" label="是否批复" required defaultValue="" options={[["", "请选择"], ["true", "是"], ["false", "否"]]} help="只记录是否批复，不收集原因或缺失资料。" /></div>}
        <div className="summary-grid full" aria-label="保存摘要">{summaryItems.map(([label, value]) => <div key={label}><span>{label}</span><strong>{summaryText(value)}</strong></div>)}</div>
        <div className="form-footer full"><span>{intent === "draft" ? "项目将保持待进单" : intent === "formal" ? "将按正式进单意图校验" : "将标记为未进单先执行"}</span></div>
      </div></fieldset>
      <fieldset className="edit-form-section"><legend>项目与进单</legend><div className="form-grid">
        <Field name="customerName" label="客户名称" required autoFocus /><ProjectRegionSelect value={region} onChange={setRegion} />
        <Field name="oldSiteContact" label="旧址联系人" optional /><Field name="newSiteContact" label="新址联系人" optional />
        <Field name="contractStartDate" label="合同开始日期" type="date" optional /><Field name="contractEndDate" label="合同截止日期" type="date" optional />
        <TextArea name="projectNote" label="项目备注" optional />
        <Field name="entryAt" label="进单日期" type="date" optional disabled={intent !== "formal"} help={intent === "formal" ? "可留空，系统将使用当天日期。" : "仅正式进单时可填写；切换为正式进单后启用。"} />
        {intent === "formal" && <div className="formal-intent-fields full" role="group" aria-label="正式进单资料"><div className="wizard-section-head"><div><h3>正式进单资料</h3><p>仅在正式进单时保存 ECC 和合同金额；进单日期留空时由系统按当天日期处理。</p></div><span>正式进单专属</span></div><div className="form-grid"><Field name="ecc" label="ECC" required /><Field name="contractAmount" label="合同 USD 含税金额" type="number" min="0" step="any" optional help="可留空后补；新建时不录最终可确认金额。" /></div>{contractAmountIsZero && <div className="inline-warning" role="status">{ZERO_CONTRACT_AMOUNT_GUIDANCE}</div>}</div>}
      </div></fieldset>
      <fieldset className="edit-form-section"><legend>搬迁范围（均可后补）</legend><div className="form-grid">
        <Field name="oldSiteAddress" label="旧址地址" optional /><Field name="newSiteAddress" label="新址地址" optional />
        <Select name="temporaryHasUps" label="UPS" defaultValue="" options={[["", "未填写"], ["true", "是"], ["false", "否"]]} help="仅记录项目暂定范围，不代表逐台仪器事实。" />
        <Field name="temporaryStorageAddress" label="暂存地址" optional />
        <p className="notice full">UPS 信息仅作为项目范围记录，不会生成仪器记录，可后补。</p>
      </div></fieldset>
      <fieldset className="edit-form-section"><legend>执行准备</legend><div className="form-grid">
        <Field name="planVisitAt" label="计划上门日期" type="date" optional /><Field name="planTransportAt" label="计划运输日期" type="date" optional />
        <Field name="plannedInstallAt" label="计划装机日期" type="date" optional /><Field name="actualInstallDoneAt" label="实际装机完成日期" type="date" optional />
        <Select name="isTemporaryStorage" label="是否暂存" defaultValue="" options={[["", "未填写"], ["false", "否"], ["true", "是"]]} />
        <label className="confirm-check full"><input name="siteConfirmed" type="checkbox" />场地已确认</label>
      </div></fieldset>
      <GroupedTagPicker catalog={catalog} loading={catalogLoading} error={catalogError} selected={selectedTagIds} onChange={setSelectedTagIds} onRetry={() => void onRetryCatalog()} />
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
  </form>;
}

function ReminderFormV2({
  project,
  onSave,
  onClear,
}: {
  project: WorkbenchProjectRow;
  onSave: (at: string | null, note: string | null) => Promise<void>;
  onClear: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      id="reminder-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave(
          String(data.get("at") || "") || null,
          String(data.get("note") || "") || null,
        ).catch((cause) => setError(messageOf(cause)));
      }}
    >
      <LayerHeaderAction><button form="reminder-edit-form" className="button primary">保存当前提醒</button></LayerHeaderAction>
      <p className="notice">
        项目只保留一个当前提醒，可编辑或清除，不保存提醒完成历史。
      </p>
      <div className="form-grid">
        <Field
          name="at"
          label="当前提醒日期"
          type="date"
          defaultValue={businessDate(project.reminderAt)}
        />
        <Field
          name="note"
          label="备注内容"
          defaultValue={project.reminderNote || ""}
        />
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <button
          type="button"
          className="button danger"
          onClick={() =>
            void onClear().catch((cause) => setError(messageOf(cause)))
          }
        >
          清除提醒
        </button>
      </div>
    </form>
  );
}
function CancelFormV2({
  project,
  onSave,
}: {
  project: WorkbenchProjectRow;
  onSave: (time: string, reason: string) => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      id="project-cancel-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave(String(data.get("time")), String(data.get("reason"))).catch(
          (cause) => setError(messageOf(cause)),
        );
      }}
    >
      <LayerHeaderAction><button form="project-cancel-form" className="button danger">确认取消项目</button></LayerHeaderAction>
      <p className="notice danger-notice">
        取消为终态不可恢复；存在任何掉票历史（含已撤销）的项目禁止取消。
      </p>
      <div className="form-grid">
        <Field
          name="time"
          label="取消日期"
          type="date"
          defaultValue={todayDate()}
          required
          autoFocus
        />
        <Field name="reason" label="取消原因" required />
        <label className="confirm-check full">
          <input type="checkbox" required />
          我确认项目取消后不可恢复
        </label>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>{project.customerName}</span>
      </div>
    </form>
  );
}
function InvoiceMutationForm({
  mode,
  invoice,
  onSave,
}: {
  mode: "edit" | "revoke";
  invoice:
    | Extract<WorkbenchV2SectionRow, { kind: "invoices" }>
    | Extract<WorkbenchV2HistoryRow, { kind: "invoice" }>;
  onSave: (values: {
    time: string;
    amount: string;
    reason: string;
  }) => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState("");
  return (
    <form
      id={`invoice-${mode}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSave({
          time: String(data.get("time")),
          amount: String(data.get("amount") || ""),
          reason: String(data.get("reason") || ""),
        }).catch((cause) => setError(messageOf(cause)));
      }}
    >
      <LayerHeaderAction>
        <button form={`invoice-${mode}-form`} className={`button ${mode === "revoke" ? "danger" : "primary"}`}>
          {mode === "edit" ? "保存修改" : "确认撤销掉票"}
        </button>
      </LayerHeaderAction>
      <p className={`notice ${mode === "revoke" ? "danger-notice" : ""}`}>
        {mode === "revoke"
          ? "撤销后为不可恢复终态，更正需新增有效掉票。"
          : "仅有效掉票可以直接编辑。"}
      </p>
      <div className="form-grid">
        <Field
          name="time"
          label={mode === "edit" ? "掉票日期" : "撤销日期"}
          type="date"
          defaultValue={mode === "edit" ? businessDate(invoice.invoicedAt) : todayDate()}
          required
          autoFocus
        />
        {mode === "edit" ? (
          <Field
            name="amount"
            label="掉票金额（USD）"
            type="number"
            step="any"
            defaultValue={invoice.amount}
            required
          />
        ) : (
          <>
            <Field name="reason" label="撤销原因" required />
            <label className="confirm-check full">
              <input type="checkbox" required />
              我确认撤销后不可恢复
            </label>
          </>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-footer">
        <span>{invoice.id}</span>
      </div>
    </form>
  );
}

type HistoryKind = WorkbenchV2HistoryKind | WorkbenchV2IndependentKind;
const HISTORY_KINDS: Array<[HistoryKind, string]> = [
  ["batch", "物流费用"], ["instrument", "搬迁仪器"], ["activity", "到访记录"], ["service_order", "开单记录"],
  ["invoice", "掉票记录"], ["damage", "损坏维修"], ["acceptance", "验收报告"], ["ship_to_request", "Account ID 申请"],
  ["serial_address", "序列号地址更新"], ["qr_request", "二维码申请"],
];

function historyDeleteRequest(row: WorkbenchV2HistoryRow): DeleteInput | null {
  if (row.kind === "invoice") return null;
  if (row.kind === "acceptance") return { kind: "acceptance", projectId: row.projectId };
  if (row.kind === "damage") return { kind: "damage_repair_item", id: row.id };
  return { kind: row.kind, id: row.id } as DeleteInput;
}

function historyRecordText(row: WorkbenchV2HistoryRow): string {
  if (row.kind === "batch") return row.transportCompany || "运输安排";
  if (row.kind === "instrument") return `${row.name}${row.serialNo ? ` · ${row.serialNo}` : ""}`;
  if (row.kind === "activity") return row.engineers || "到访活动";
  if (row.kind === "service_order") return `${row.serviceOrderNo || "服务单号待补"} · ${row.engineer || "工程师待补"}`;
  if (row.kind === "invoice") return money(row.amount);
  if (row.kind === "damage") return `${row.instrumentName} · ${row.issueStatus}`;
  if (row.kind === "acceptance") return "验收报告";
  return `${row.newSiteAddress} · ${row.status}`;
}

function HistoryBrowserV2({ onDelete, onRevision }: {
  onDelete: (request: DeleteInput, success: string) => Promise<void>;
  onRevision: (revision: number) => void;
}): JSX.Element {
  const [kind, setKind] = useState<HistoryKind>("service_order");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [page, setPage] = useState<WorkbenchV2HistoryPageDto | WorkbenchV2IndependentPageDto | null>(null);
  const [stack, setStack] = useState<Array<string | null>>([null]);
  const [error, setError] = useState("");
  const [revoke, setRevoke] = useState<Extract<WorkbenchV2HistoryRow, { kind: "invoice" }> | null>(null);
  const independent = kind === "serial_address" || kind === "qr_request";
  async function load(cursor: string | null): Promise<void> {
    setError("");
    try {
      const api = bridge(); if (!api) throw new Error();
      const range = { from: from || null, to: to || null, cursor, limit: 50 };
      const next = independent
        ? await requireV2(api, "v2IndependentPage")({ ...range, kind })
        : await requireV2(api, "v2HistoryPage")({ ...range, kind });
      onRevision(next.businessRevision);
      setPage(next);
    } catch { setError("历史记录读取失败，请调整日期后重试。"); }
  }
  useEffect(() => { setStack([null]); setRevoke(null); void load(null); }, [kind]);
  const rows = page?.rows ?? [];
  async function remove(request: DeleteInput, success = "记录已删除"): Promise<boolean> {
    try { await onDelete(request, success); await load(stack.at(-1) ?? null); return true; }
    catch (cause) { setError(messageOf(cause)); return false; }
  }
  return <div className="history-browser">
    <div className="history-kind-list" role="tablist" aria-label="记录类型">{HISTORY_KINDS.map(([value,label], index) => <button key={value} role="tab" aria-selected={kind === value} tabIndex={kind === value ? 0 : -1} onClick={() => setKind(value)} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? HISTORY_KINDS.length - 1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % HISTORY_KINDS.length : (index - 1 + HISTORY_KINDS.length) % HISTORY_KINDS.length;
      setKind(HISTORY_KINDS[next]![0]);
      const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      window.setTimeout(() => tabs?.[next]?.focus(), 0);
    }}>{label}</button>)}</div>
    <section className="history-content">
      <form className="history-filters" onSubmit={(event) => { event.preventDefault(); setStack([null]); void load(null); }}>
        <div className="history-scope"><strong>{independent ? "独立登记" : "全部项目"}</strong><span>{independent ? "按登记业务日期汇总" : "跨项目汇总并保留项目上下文"}</span></div>
        <label>起始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>截止日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="button primary">查看记录</button>
      </form>
      {revoke && <div className="history-inline-action"><InvoiceMutationForm mode="revoke" invoice={revoke} onSave={async (values) => { if (await remove({ kind: "invoice", id: revoke.id, revokedAt: values.time, revokeReason: values.reason }, "掉票已撤销")) setRevoke(null); }} /></div>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="history-table table-scroll"><table className="data-table"><thead><tr><th>项目 / 客户</th><th>业务记录</th><th>业务日期</th><th>操作</th></tr></thead><tbody>{rows.map((row) => {
        if (row.kind === "serial_address" || row.kind === "qr_request") {
          const context = row.kind === "serial_address" ? row.customerName : "独立二维码申请";
          const record = row.kind === "serial_address" ? `${row.serialNo} · ${row.accountId}` : `${row.applicant} · ${row.types.map((type) => QR_REQUEST_TYPE_LABEL.get(type) ?? type).join("、")}`;
          const date = row.kind === "serial_address" ? row.updatedAt : row.requestedAt;
          return <tr key={row.id}><td><strong>{context}</strong><small>独立登记</small></td><td>{record}</td><td>{businessDate(date)}</td><td><div className="restricted-action"><button className="button danger small" onClick={() => { if (window.confirm("删除后无法恢复，确认删除这条记录？")) void remove({ kind: row.kind, id: row.id }); }}>删除</button><small>{row.kind === "serial_address" ? "地址事实有误时，删除后重新登记。" : "申请内容有误时，删除后重新登记。"}</small></div></td></tr>;
        }
        const request = historyDeleteRequest(row);
        return <tr key={row.id}><td><strong>{row.customerName}</strong><small>{row.ecc ?? row.tempNo}</small></td><td>{historyRecordText(row)}</td><td>{row.businessDate || "—"}</td><td>{row.kind === "invoice" ? (row.active ? <button className="button danger small" onClick={() => setRevoke(row)}>撤销</button> : <span className="terminal-note">已撤销；如需更正，请新增有效掉票。</span>) : <div className="restricted-action"><button className="button danger small" onClick={() => { if (request && window.confirm("删除后无法恢复，确认删除这条记录？")) void remove(request); }}>删除</button>{row.kind === "activity" && <small>到访或工作事实有误时，删除后重新登记。</small>}{row.kind === "acceptance" && <small>验收已有后续依赖时应保留原事实，当前不支持原位修改。</small>}{row.kind === "ship_to_request" && <small>申请资料有误时，按正确客户与新址重新发起。</small>}</div>}</td></tr>;
      })}</tbody></table>{rows.length === 0 && <Empty title="暂无记录" copy="调整记录类型或日期范围后再试。" />}</div>
      <div className="queue-pagination"><button className="button" disabled={stack.length <= 1} onClick={() => { const next = stack.slice(0,-1); setStack(next); void load(next.at(-1) ?? null); }}>上一页</button><span>本页 {rows.length} / 共 {page?.total ?? 0}</span><button className="button" disabled={!page?.nextCursor} onClick={() => { if (!page?.nextCursor) return; const next = [...stack,page.nextCursor]; setStack(next); void load(page.nextCursor); }}>下一页</button></div>
    </section>
  </div>;
}

function DataCleanPanel({ onComplete }: { onComplete: () => Promise<void> }): JSX.Element {
  const [prepared, setPrepared] = useState<DataCleanPrepareDto | null>(null);
  const [confirmText, setConfirmText] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [needsRecheck, setNeedsRecheck] = useState(false);
  const labels: Record<keyof DataCleanPrepareDto["counts"], string> = {
    customers: "客户", projects: "项目", contracts: "合同", batches: "搬迁批次", instruments: "仪器",
    batch_change_history: "批次变更记录", activities: "到访活动", activity_engineers: "活动工程师", work_facts: "工作事实",
    service_orders: "开单", ship_tos: "Account ID 地址", ship_to_requests: "Account ID 申请", serial_address_updates: "序列号地址更新",
    damage_repair_items: "损坏维修事项", activity_damage_links: "活动维修关联", qr_requests: "二维码申请", qr_request_types: "二维码申请类型",
    logistics_fees: "物流费用", invoices: "掉票",
  };
  async function prepare(): Promise<void> {
    setBusy(true); setError("");
    try { const api = bridge(); if (!api?.cleanPrepare) throw new Error(); setPrepared(await api.cleanPrepare()); setNeedsRecheck(false); setConfirmText(""); }
    catch (cause) { setPrepared(null); setNeedsRecheck(true); setError(cleanErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function clean(): Promise<void> {
    if (!prepared) return;
    setBusy(true); setError("");
    try { const api = bridge(); if (!api?.cleanConfirm) throw new Error(); await api.cleanConfirm({ token: prepared.token, confirmText }); await onComplete(); }
    catch (cause) { setPrepared(null); setConfirmText(""); setNeedsRecheck(true); setError(cleanErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  const total = prepared ? Object.values(prepared.counts).reduce((sum, count) => sum + count, 0) : 0;
  return <div className="clean-panel"><div className="danger-zone"><p className="overline">危险操作区</p><h3>清理全部业务数据</h3><p>账号、应用设置和已有备份会保留。确认清理前还会再创建一份安全备份。</p></div>
    {!prepared ? <button className={`button ${needsRecheck ? "primary" : "danger"}`} disabled={busy} onClick={() => void prepare()}>{busy ? "正在检查…" : needsRecheck ? "重新检查数据" : "先检查将清理的数据"}</button> : <><div className="clean-summary"><strong>将清理 {total} 行业务数据</strong><dl>{Object.entries(prepared.counts).filter(([,count]) => count > 0).map(([table,count]) => <div key={table}><dt>{labels[table as keyof typeof labels] ?? table}</dt><dd>{count}</dd></div>)}</dl><p>另含导入审计 {prepared.auditCounts.migrationAudit + prepared.auditCounts.importRecordAudit + prepared.auditCounts.importRun} 行。账号、设置、备份不会清理。</p></div><label className="field full"><span>输入“清理全部业务数据”确认</span><input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoFocus /></label><button className="button danger" disabled={busy || confirmText !== "清理全部业务数据"} onClick={() => void clean()}>{busy ? "正在备份并清理…" : "创建安全备份并清理"}</button></>}
    {error && <div className="inline-error clean-recheck-error" role="alert">{error}</div>}</div>;
}

function ReportPanelV2({ catalog, catalogLoading, catalogError, onRetryCatalog }: TagCatalogProps): JSX.Element {
  const [draftFilter, setDraftFilter] = useState<ReportFilterDto>({
    monthFrom: "",
    monthTo: "",
    region: null,
    orderType: null,
    transportCompany: null,
    engineer: null,
  });
  const [appliedFilter, setAppliedFilter] = useState<ReportFilterDto | null>(null);
  const [report, setReport] = useState<ReportDto | null>(null);
  const [details, setDetails] = useState<Array<Record<string, string | number | boolean | null>>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"build" | "xlsx" | "png" | "pdf" | "">("");
  async function build(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy("build");
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      const nextReport = await api.buildReport(draftFilter);
      setReport(nextReport);
      setAppliedFilter({ ...draftFilter, ...(draftFilter.tagIds ? { tagIds: [...draftFilter.tagIds] } : {}) });
      setDetails([]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }
  async function drill(key: string): Promise<void> {
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      if (!appliedFilter) return;
      setDetails(await api.drillDown(key, appliedFilter));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  async function exportFile(format: "xlsx" | "png" | "pdf"): Promise<void> {
    setBusy(format);
    setError("");
    try {
      const api = bridge();
      if (!api) throw new Error("当前环境未连接主进程");
      if (!appliedFilter) return;
      const result = await api.exportReport(format, appliedFilter);
      if (!result.saved) setError("已取消保存，未生成导出文件。");
    } catch (cause) {
      setError(`导出失败：${messageOf(cause)}`);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="report">
      <section className="report-intro"><p className="overline">运营视图</p><h3>按业务月份查看结果，再下钻核对明细</h3><p>筛选只改变统计范围，不改变现有业务口径。</p></section>
      <form className="report-filter" onSubmit={(event) => void build(event)}>
        <Field
          name="monthFrom"
          label="起始月份"
          type="month"
          required
          value={draftFilter.monthFrom}
          onChange={(event) =>
            setDraftFilter((old) => ({ ...old, monthFrom: event.target.value }))
          }
        />
        <Field
          name="monthTo"
          label="截止月份"
          type="month"
          required
          value={draftFilter.monthTo}
          onChange={(event) =>
            setDraftFilter((old) => ({ ...old, monthTo: event.target.value }))
          }
        />
        <Field name="reportRegion" label="区域" placeholder="全部区域" help="留空表示全部区域" value={draftFilter.region ?? ""}
          onChange={(event) => setDraftFilter((old) => ({ ...old, region: event.target.value || null }))} />
        <Select name="reportOrderType" label="开单类型" value={draftFilter.orderType ?? ""}
          options={[["", "全部开单类型"], ["relocation", "搬迁"], ["certification", "认证"], ["parts_by_mail", "单寄备件"], ["pm", "PM"]]}
          onChange={(event) => setDraftFilter((old) => ({ ...old, orderType: (event.target.value || null) as ReportFilterDto["orderType"] }))} />
        <Field name="reportTransportCompany" label="运输公司" placeholder="全部运输公司" help="留空表示全部运输公司" value={draftFilter.transportCompany ?? ""}
          onChange={(event) => setDraftFilter((old) => ({ ...old, transportCompany: event.target.value || null }))} />
        <Field name="reportEngineer" label="工程师" placeholder="全部工程师" help="留空表示全部工程师" value={draftFilter.engineer ?? ""}
          onChange={(event) => setDraftFilter((old) => ({ ...old, engineer: event.target.value || null }))} />
        <div className="report-tag-filter full">
          <GroupedTagPicker catalog={catalog} loading={catalogLoading} error={catalogError} selected={draftFilter.tagIds ?? []} onChange={(tagIds) => setDraftFilter((old) => ({ ...old, tagIds }))} onRetry={() => void onRetryCatalog()} legend="按项目分类标签筛选" />
          <div className="report-tag-filter-footer"><span>{draftFilter.tagIds?.length ? `已选择 ${draftFilter.tagIds.length} 个标签，匹配任一标签` : "未选择标签，不限制报表结果"}</span><button className="text-action" type="button" disabled={!draftFilter.tagIds?.length} onClick={() => setDraftFilter((old) => ({ ...old, tagIds: [] }))}>清空标签筛选</button></div>
        </div>
        <button className="button primary" disabled={Boolean(busy)}>{busy === "build" ? "正在计算…" : "实时计算报表"}</button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {report && (
        <section className="report-results">
          <div className="report-section-head"><div><p className="overline">计算结果</p><h3>{report.range.from} 至 {report.range.to}</h3></div><span>{report.sections.length} 项指标</span></div>
          <div className="report-metric-grid">{report.sections.map((section) => (
            <article className="report-section" key={section.key}>
              <span>指标</span><strong>{section.label.replaceAll("Ship-to", "Account ID")}</strong>
              <b>{section.rows.length}<small> 行</small></b>
              <button className="button small" onClick={() => void drill(section.key)}>查看明细</button>
            </article>
          ))}</div>
          <div className="report-export"><div><strong>导出当前结果</strong><span>使用同一筛选范围生成文件</span></div><div className="row-actions">
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("xlsx")}>
              {busy === "xlsx" ? "正在导出…" : "导出 Excel"}
            </button>
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("png")}>
              {busy === "png" ? "正在导出…" : "导出 PNG"}
            </button>
            <button className="button" disabled={Boolean(busy)} onClick={() => void exportFile("pdf")}>
              {busy === "pdf" ? "正在导出…" : "导出 PDF"}
            </button>
          </div></div>
        </section>
      )}
      {details.length > 0 && (
        <section className="report-details">
          <div className="report-section-head"><div><p className="overline">核对数据</p><h3>下钻明细</h3></div><span>{details.length} 行</span></div>
          <div className="table-scroll"><table className="data-table"><thead><tr>{Object.keys(details[0] ?? {}).map((key) => <th key={key}>{reportColumnLabel(key)}</th>)}</tr></thead><tbody>{details.map((row, index) => <tr key={String(row.id ?? index)}>{Object.entries(row).map(([key,value]) => <td key={key}>{reportCellText(key, value)}</td>)}</tr>)}</tbody></table></div>
        </section>
      )}
    </div>
  );
}

function reportColumnLabel(key: string): string {
  const labels: Record<string, string> = {
    id: "记录编号", itemId: "维修事项编号", projectId: "项目编号", projectTempNo: "项目临时编号",
    invoiceId: "掉票记录编号", orderId: "开单记录编号", feeId: "物流费用编号", batchId: "搬迁批次编号",
    requestId: "申请记录编号", updateId: "更新记录编号", customerName: "客户名称", ecc: "ECC",
    region: "区域", status: "项目状态", projectCount: "项目数", amount: "金额", amountCents: "金额（USD）",
    count: "数量", month: "月份", date: "日期", engineer: "工程师", transportCompany: "运输公司",
    orderType: "开单类型", serviceOrderNo: "服务单号", orderedAt: "开单日期", invoicedAt: "掉票日期",
    registeredAt: "事项登记日期", partStatus: "备件状态", partAmountCents: "备件金额", partCurrency: "备件币种",
    usedPartUsdCents: "已使用备件金额（USD）", contractAmountCents: "合同金额（USD）",
    ratioPercentHundredths: "合同占比（%）", ratioUnavailable: "合同占比不可计算", ratioOverHundred: "合同占比超过 100%",
    operatorAccountId: "责任人账号编号", operatorUsername: "责任人", cancelled: "项目已取消",
    appliedAt: "费用登记日期", budgetPriceCents: "合同预算价（RMB）", dealPriceCents: "物流成交价（RMB）",
    costCents: "实际物流费用（RMB）", costUsdCents: "物流费用（USD）", dealOverBudget: "成交价超过预算",
    planTransportDate: "计划运输日期", submittedAt: "提交日期", applicant: "申请人", requestedAt: "申请日期",
    typeCode: "二维码申请类型", updatedAt: "更新日期", serialNo: "序列号",
  };
  return labels[key] ?? "其他信息";
}

function reportCellText(key: string, value: string | number | boolean | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  const text = String(value);
  const enumLabels: Record<string, Record<string, string>> = {
    status: { ...STATUS_LABEL },
    orderType: { relocation: "搬迁", certification: "认证", parts_by_mail: "单寄备件", pm: "PM" },
    partStatus: { pending_submit: "待提交", processing: "处理中", arrived: "已到件", used: "已使用" },
    typeCode: Object.fromEntries(QR_REQUEST_TYPE_LABEL),
  };
  if (key in enumLabels) return enumLabels[key]?.[text] ?? "其他";
  if (reportColumnLabel(key) === "其他信息" && (/^[a-z]+(?:_[a-z0-9]+)+$/.test(text) || /[a-z][A-Z]/.test(text))) return "其他";
  return text;
}

function layerRequiresDirtyProtection(layer: LayerState): boolean {
  return [
    "new",
    "edit-project",
    "correct-entry",
    "action",
    "reminder",
    "cancel",
    "independent",
    "invoice-edit",
    "invoice-revoke",
    "batch-edit",
    "damage-update",
    "order-note-edit",
    "tags",
    "edit-project-tags",
  ].includes(layer.kind);
}

function Layer({
  title,
  description,
  className,
  initialFocusSelector,
  side = false,
  protectDirty = false,
  controlledDirty,
  busy = false,
  requestCloseRef,
  resetDirtyKey,
  onClose,
  children,
}: {
  title: string;
  description: string;
  className?: string;
  initialFocusSelector?: string;
  side?: boolean;
  protectDirty?: boolean;
  controlledDirty?: boolean;
  busy?: boolean;
  requestCloseRef?: MutableRefObject<(trigger?: HTMLElement | null) => void>;
  resetDirtyKey?: unknown;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const panel = useRef<HTMLElement>(null);
  const discardPanel = useRef<HTMLElement>(null);
  const discardTrigger = useRef<HTMLElement | null>(null);
  const lastPanelFocus = useRef<HTMLElement | null>(null);
  const restoreDiscardFocus = useRef(false);
  const dirty = useRef(false);
  const controlledDirtyRef = useRef(controlledDirty);
  const busyRef = useRef(busy);
  const protectDirtyRef = useRef(protectDirty);
  const onCloseRef = useRef(onClose);
  const discardOpenRef = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [headerActions, setHeaderActions] = useState<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  controlledDirtyRef.current = controlledDirty;
  busyRef.current = busy;
  protectDirtyRef.current = protectDirty;
  onCloseRef.current = onClose;
  useEffect(() => {
    dirty.current = false;
  }, [resetDirtyKey]);
  function closeDiscard(): void {
    discardOpenRef.current = false;
    restoreDiscardFocus.current = true;
    setDiscardOpen(false);
  }
  function requestClose(trigger?: HTMLElement | null): void {
    if (busyRef.current) return;
    const hasChanges = controlledDirtyRef.current ?? dirty.current;
    if (!protectDirtyRef.current || !hasChanges) {
      onCloseRef.current();
      return;
    }
    const requested = trigger ?? (document.activeElement as HTMLElement | null);
    discardTrigger.current = requested && panel.current?.contains(requested)
      ? requested
      : lastPanelFocus.current;
    discardOpenRef.current = true;
    setDiscardOpen(true);
    window.setTimeout(() => discardPanel.current?.querySelector<HTMLElement>("button")?.focus(), 0);
  }
  useEffect(() => {
    if (discardOpen || !restoreDiscardFocus.current) return;
    restoreDiscardFocus.current = false;
    const target = discardTrigger.current;
    window.requestAnimationFrame(() => {
      if (target?.isConnected && !target.matches(":disabled")) target.focus();
    });
  }, [discardOpen]);
  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = (trigger) => requestClose(trigger ?? document.activeElement as HTMLElement | null);
    return () => { requestCloseRef.current = () => undefined; };
  }, [requestCloseRef]);
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const focusables = (scope: HTMLElement = root) =>
      Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      );
    const autofocusTimer = window.setTimeout(() => {
      const preferred = (initialFocusSelector
        ? root.querySelector<HTMLElement>(initialFocusSelector)
        : null) ?? root.querySelector<HTMLElement>(
          '[autofocus],input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
        );
      (preferred ?? focusables()[0])?.focus();
    }, 0);
    function key(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        if (discardOpenRef.current) closeDiscard();
        else if (!busyRef.current) requestClose(document.activeElement as HTMLElement | null);
        return;
      }
      if (event.key === "Tab") {
        const scope = discardOpenRef.current ? discardPanel.current : root;
        if (!scope) return;
        const items = focusables(scope);
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      window.clearTimeout(autofocusTimer);
      document.removeEventListener("keydown", key);
      opener.current?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className={`overlay ${side ? "side" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget)
          requestClose(document.activeElement as HTMLElement | null);
      }}
    >
      <section
        ref={panel}
        className={`${side ? "drawer wide-drawer" : "modal"}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="layer-title-v2"
        aria-hidden={discardOpen || undefined}
        onFocusCapture={(event) => {
          lastPanelFocus.current = event.target as HTMLElement;
        }}
        onInputCapture={(event) => {
          if (protectDirty) dirty.current = true;
          lastPanelFocus.current = event.target as HTMLElement;
        }}
        onChangeCapture={(event) => {
          if (protectDirty) dirty.current = true;
          lastPanelFocus.current = event.target as HTMLElement;
        }}
      >
        <header className="layer-head">
          <div className="layer-heading">
            <h2 id="layer-title-v2">{title}</h2>
            <p>{description}</p>
          </div>
          <div className="layer-head-actions">
            <div className="layer-header-actions" ref={setHeaderActions} />
            <button
              className="icon-button"
              disabled={busy}
              onClick={(event) => requestClose(event.currentTarget)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        </header>
        <LayerHeaderActionsContext.Provider value={headerActions}>
          <div className="layer-body">{children}</div>
        </LayerHeaderActionsContext.Provider>
      </section>
      {discardOpen && (
        <div
          className="discard-guard"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDiscard();
          }}
        >
          <section
            ref={discardPanel}
            className="discard-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            aria-describedby="discard-description"
          >
            <p className="overline">尚未保存</p>
            <h2 id="discard-title">放弃本次修改？</h2>
            <p id="discard-description">关闭后，当前填写内容不会保留。</p>
            <div className="discard-actions">
              <button className="button primary" onClick={closeDiscard}>
                继续编辑
              </button>
              <button className="button danger" onClick={onClose}>
                放弃修改
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function Field({
  name,
  label,
  required = false,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
} & React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={`v2-${name}`}>
        {label} {required ? <b>必填</b> : optional ? <em>可后补</em> : null}
      </label>
      <input id={`v2-${name}`} name={name} required={required} aria-describedby={helpId} {...props} />
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function Select({
  name,
  label,
  options,
  required = false,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  options: Array<[string, string]>;
  required?: boolean;
  optional?: boolean;
  help?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field">
      <label htmlFor={`v2-${name}`}>{label} {required ? <b>必填</b> : optional ? <em>可后补</em> : null}</label>
      <select id={`v2-${name}`} name={name} required={required} aria-describedby={helpId} {...props}>
        {options.map(([value, text]) => (
          <option value={value} key={value}>
            {text}
          </option>
        ))}
      </select>
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function TextArea({
  name,
  label,
  optional = false,
  help,
  ...props
}: {
  name: string;
  label: string;
  optional?: boolean;
  help?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  const helpId = help ? `v2-${name}-help` : undefined;
  return (
    <div className="field full">
      <label htmlFor={`v2-${name}`}>{label} {optional ? <em>可后补</em> : null}</label>
      <textarea id={`v2-${name}`} name={name} aria-describedby={helpId} {...props} />
      {help && <small id={helpId}>{help}</small>}
    </div>
  );
}
function StatusBadge({ status }: { status: ProjectStatus }): JSX.Element {
  return (
    <span className={`status status-${status}`}>
      <span aria-hidden="true">
        {status === "pending_entry" ? "○" : status === "completed" ? "✓" : "◆"}
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}
function Empty({ title, copy }: { title: string; copy: string }): JSX.Element {
  return (
    <div className="empty">
      <span aria-hidden="true">—</span>
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}
function layerTitle(layer: LayerState): string {
  if (layer.kind === "new") return "新建搬迁项目";
  if (layer.kind === "edit-project") return "编辑项目资料";
  if (layer.kind === "edit-project-tags") return "编辑项目标签";
  if (layer.kind === "correct-entry") return "更正进单/合同资料";
  if (layer.kind === "quick") return "快速记录";
  if (layer.kind === "reminder") return "维护项目提醒";
  if (layer.kind === "reminder-all") return "全部项目提醒";
  if (layer.kind === "cancel") return "取消项目";
  if (layer.kind === "report") return "运营报表";
  if (layer.kind === "history") return "浏览往期与全部记录";
  if (layer.kind === "clean") return "清理全部业务数据";
  if (layer.kind === "tags") return "管理标签库";
  if (layer.kind === "independent")
    return layer.module === "serial_address" ? "序列号地址更新" : "二维码申请";
  if (layer.kind === "invoice-edit") return "编辑掉票";
  if (layer.kind === "invoice-revoke") return "撤销掉票";
  if (layer.kind === "batch-edit") return "编辑物流费用记录";
  if (layer.kind === "damage-update") return "更新维修状态";
  if (layer.kind === "order-note-edit") return "维护开单备注";
  if (layer.kind === "action")
    return (
      ACTIONS.find((action) => action.type === layer.action)?.label ||
      "记录业务事实"
    );
  return "记录业务事实";
}
function layerDescription(
  layer: LayerState,
  project: WorkbenchProjectRow | null,
): string {
  if (layer.kind === "new") return "四组资料在同一页完成";
  if (layer.kind === "edit-project") return project ? `${project.customerName} · 项目级资料` : "项目级资料";
  if (layer.kind === "edit-project-tags") return `${layer.customerName} · ${layer.identifier}`;
  if (layer.kind === "correct-entry") return project ? `${project.customerName} · 已正式进单项目` : "已正式进单项目";
  if (layer.kind === "report") return "手工月份区间与有界导出";
  if (layer.kind === "history") return "统一按类型、项目和日期查找业务记录";
  if (layer.kind === "reminder-all") return "按提醒日期查看全部项目与到期分类";
  if (layer.kind === "clean") return "先检查数量，再输入固定文本确认";
  if (layer.kind === "tags") return "所有项目共用的分组与标签";
  if (layer.kind === "order-note-edit") return `${layer.order.serviceOrderNo || "服务单号待补"} · 可修改、后补或清空`;
  if (layer.kind === "independent") return "独立模块 · 记录按页读取";
  if (layer.kind === "cancel") return "记录取消日期与原因（终态，不可恢复）";
  return project
    ? `${project.customerName} · ${project.ecc || project.tempNo}`
    : "选择需要记录的动作";
}
