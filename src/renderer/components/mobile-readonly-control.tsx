import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { MobileReadonlyStatusDto, WorkbenchApi } from "../../shared/ipc";

export type MobileReadonlyControlApi = Partial<Pick<WorkbenchApi,
  "mobileReadonlyStatus" | "mobileReadonlyConfigure" | "mobileReadonlySetEnabled"
>>;
export const PUBLICATION_STATUS_POLL_MS = 15_000;

// Only known codes may enter the UI. Never display an IPC exception's message.
const FAILURE_LABELS: Record<string, string> = {
  CONFIG_CORRUPT: "发布配置损坏，请重新配置",
  CONFIG_WRITE_FAILED: "无法保存发布配置，请检查本机存储权限",
  CONFIG_NOT_READABLE: "无法读取发布配置",
  CREDENTIAL_UNAVAILABLE: "上传凭证不可用，请重新配置",
  SAFE_STORAGE_UNAVAILABLE: "系统安全存储不可用，不能保存凭证或启用发布",
  INVALID_TARGET: "请输入不含路径、账号或查询参数的 HTTPS 服务地址",
  EMPTY_TOKEN: "请输入独立上传凭证",
  NOT_CONFIGURED: "请先配置发布目标和上传凭证",
  NOT_ENABLED: "发布尚未启用",
  STATE_WRITE_FAILED: "发布结果无法保存到本机，当前状态仅保留在内存中",
  LOCAL_SNAPSHOT_FAILED: "本次只读快照生成失败",
  META_READ_FAILED: "无法读取云端发布版本",
  UNAUTHORIZED: "上传凭证校验失败，请检查配置",
  UPLOAD_REJECTED: "云端未接受本次发布",
  VERSION_CONFLICT: "云端版本已变化，发布程序将重新检查",
  TIMEOUT: "发布请求超时，将在后续周期重试",
  NETWORK_ERROR: "无法连接发布服务，请检查网络",
  TLS_ERROR: "服务证书校验失败，请检查 HTTPS 配置",
  REDIRECT_REFUSED: "服务地址发生跳转，请检查固定发布目标",
  RESPONSE_TOO_LARGE: "服务响应超出允许大小",
  BAD_RESPONSE: "服务响应格式不符合约定",
  SERVER_ERROR: "发布服务暂时不可用",
  RETRY_LIMIT: "本轮重试已暂停，将在后续周期重新检查",
};
const ISSUE_LABELS: Record<NonNullable<MobileReadonlyStatusDto["issue"]>, string> = {
  config_corrupt: "发布配置损坏，已停止外发。请重新配置。",
  credential_unavailable: "系统安全存储或上传凭证不可用，无法启用发布。不会以明文保存凭证。",
  state_unwritable: "发布结果无法持久保存，当前状态仅保留在内存中；已授权的发布可继续，不影响本地业务。",
  not_configured: "尚未配置发布目标和上传凭证，当前不会向外发布。",
  runtime_unavailable: "发布服务尚未就绪，暂不可用。本地工作台仍可正常使用。",
};
function knownFailure(code: unknown): string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(FAILURE_LABELS, code)
    ? `${FAILURE_LABELS[code]}（${code}）`
    : "发布操作未成功，请检查配置或稍后重试。";
}
function exceptionLabel(error: unknown): string {
  return knownFailure(error && typeof error === "object" && "code" in error ? error.code : null);
}
function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch { return null; }
}
function timestamp(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function PublicationPanel({ api, close, returnFocus }: { api?: MobileReadonlyControlApi; close: () => void; returnFocus: HTMLButtonElement | null }) {
  const [status, setStatus] = useState<MobileReadonlyStatusDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [token, setToken] = useState("");
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const available = typeof api?.mobileReadonlyStatus === "function"
    && typeof api?.mobileReadonlyConfigure === "function" && typeof api?.mobileReadonlySetEnabled === "function";

  async function refresh() {
    if (!available || inFlight.current || !active.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await api!.mobileReadonlyStatus!();
      if (active.current) { setStatus(result); setError(null); }
    } catch {
      if (active.current) setError("无法读取发布状态。请重试；本地工作台仍可正常使用。");
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  useEffect(() => {
    active.current = true;
    closeButton.current?.focus();
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, PUBLICATION_STATUS_POLL_MS);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node)) closeButton.current?.focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      active.current = false;
      clearInterval(timer);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      returnFocus?.focus();
    };
  }, [api]);

  async function mutate(operation: () => Promise<MobileReadonlyStatusDto>, message: string, configuration = false) {
    if (!active.current || inFlight.current) return;
    inFlight.current = true; setPending(true); setError(null); setNotice(null);
    try {
      const result = await operation();
      if (!active.current) return;
      setStatus(result); setNotice(message);
      if (configuration) { setToken(""); setTarget(""); setConfigurationOpen(false); }
    } catch (failure) {
      if (active.current) setError(exceptionLabel(failure));
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  function configure(event: FormEvent) {
    event.preventDefault();
    if (!available || pending || status?.enabled) return;
    const origin = httpsOrigin(target);
    if (!origin) { setError(knownFailure("INVALID_TARGET")); return; }
    if (!token.trim()) { setError(knownFailure("EMPTY_TOKEN")); return; }
    void mutate(() => api!.mobileReadonlyConfigure!({ target: origin, token }), "发布配置已保存。保存配置不会自动启用发布。", true);
  }
  const canEnable = status?.configured && (status.issue === null || status.issue === "state_unwritable");
  return createPortal(<div className="mrp-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="mrp-panel" role="dialog" aria-modal="true" aria-labelledby="mrp-title" aria-describedby="mrp-description" ref={panel}>
      <header className="mrp-header"><div><p>电脑发布 · 手机只读</p><h2 id="mrp-title">发布云端</h2></div><button ref={closeButton} className="button" type="button" aria-label="关闭发布云端" onClick={() => { setToken(""); close(); }}>关闭</button></header>
      <div className="mrp-body">
        <p id="mrp-description" className="mrp-description">默认关闭。配置后需单独启用，才会把只读快照发布到指定服务。发布失败不影响本地录入和查看。</p>
        {!available ? <p role="status" className="mrp-warning">当前版本未提供发布接口，暂不可用。未读取到配置或启用状态。</p> : <>
          {pending && <p role="status" className="mrp-hint">正在读取或保存发布状态…</p>}
          {error && <div role="alert" className="mrp-error">{error}</div>}
          {notice && <p role="status" className="mrp-success">{notice}</p>}
          <div className="mrp-status-heading"><h3>发布状态</h3><button className="button" type="button" disabled={pending} onClick={() => void refresh()}>刷新状态</button></div>
          {status ? <>
            <dl className="mrp-status">
              <div><dt>配置情况</dt><dd>{status.configured ? "已配置" : "未配置"}</dd></div>
              <div><dt>发布开关</dt><dd className={status.enabled ? "mrp-enabled" : ""}>{status.enabled ? "已启用" : "已停用"}</dd></div>
              <div><dt>发布目标</dt><dd>{status.target ? httpsOrigin(status.target) ?? "目标不可显示，请重新配置" : "尚未配置"}</dd></div>
              <div><dt>最近成功发布</dt><dd>{timestamp(status.lastSuccessfulAt)}</dd></div>
              <div><dt>最近失败</dt><dd>{status.lastFailedCode ? knownFailure(status.lastFailedCode) : "尚无记录"}</dd></div>
              {status.lastFailedAt && <div><dt>失败时间</dt><dd>{timestamp(status.lastFailedAt)}</dd></div>}
            </dl>
            {status.issue && <p className="mrp-warning" role="status">{ISSUE_LABELS[status.issue] ?? "发布状态异常，请检查配置。"}</p>}
            <div className="mrp-toggle"><div><strong>{status.enabled ? "正在按周期检查并发布" : "发布当前处于关闭状态"}</strong><p>停用仅停止后续发布；云端最近一次快照仍会保留，不会自动删除。</p></div><button className={`button ${status.enabled ? "" : "primary"}`} type="button" disabled={pending || (!status.enabled && (!canEnable || Boolean(error)))} onClick={() => void mutate(() => api!.mobileReadonlySetEnabled!({ enabled: !status.enabled }), status.enabled ? "已停用后续发布，云端最近一次快照仍保留。" : "已启用发布，后续结果会显示在这里。")}>{status.enabled ? "停用发布" : "启用发布"}</button></div>
            {!canEnable && !status.enabled && <p className="mrp-hint">需要完成配置且系统安全存储与凭证可用，才能启用。</p>}
            <div className="mrp-config-heading"><h3>目标与上传凭证</h3><button className="button" type="button" disabled={pending || status.enabled} aria-expanded={configurationOpen} onClick={() => { setConfigurationOpen(!configurationOpen); setToken(""); setTarget(""); }}>{configurationOpen ? "取消配置" : status.configured ? "重新配置" : "配置发布"}</button></div>
            {status.enabled && <p className="mrp-hint">如需更换目标或上传凭证，请先停用发布。</p>}
            {configurationOpen && <form className="mrp-config" aria-label="发布连接配置" onSubmit={configure}>
              <label htmlFor="mrp-target">HTTPS 服务地址<input id="mrp-target" type="url" autoComplete="off" spellCheck={false} placeholder="https://发布服务地址" value={target} disabled={pending || status.enabled} onChange={(event) => setTarget(event.target.value)} aria-describedby="mrp-target-help" /></label>
              <p id="mrp-target-help" className="mrp-hint">仅填写服务域名及可选端口，不含路径、账号或查询参数。</p>
              <label htmlFor="mrp-token">独立上传凭证<input id="mrp-token" type="password" autoComplete="new-password" spellCheck={false} value={token} disabled={pending || status.enabled} onChange={(event) => setToken(event.target.value)} aria-describedby="mrp-token-help" /></label>
              <p id="mrp-token-help" className="mrp-hint">只写不回显，不是手机查看密码。由系统安全存储保护密钥，凭证加密后保存在本机；安全存储不可用时不保存。</p>
              <div className="mrp-config-footer"><span>保存配置不会自动启用发布。</span><button className="button primary" type="submit" disabled={pending || status.enabled}>保存配置</button></div>
            </form>}
          </> : !pending && <p className="mrp-hint">尚未取得发布状态，不会推测为已配置或已启用。</p>}
        </>}
      </div>
    </section>
  </div>, document.body);
}

export interface MobileReadonlyControlProps {
  /** 宿主（数据管理菜单）控制开关：弹窗必须挂在折叠菜单之外，宿主折叠不影响它。 */
  open: boolean;
  onClose: () => void;
  /** 关闭后交还焦点的宿主触发器。 */
  returnFocus: HTMLButtonElement | null;
  api?: MobileReadonlyControlApi;
}

export function MobileReadonlyControl({ api: supplied, open, onClose, returnFocus }: MobileReadonlyControlProps) {
  const api = supplied ?? (window as unknown as { workbench?: WorkbenchApi }).workbench;
  if (!open) return null;
  return <PublicationPanel api={api} close={onClose} returnFocus={returnFocus} />;
}
