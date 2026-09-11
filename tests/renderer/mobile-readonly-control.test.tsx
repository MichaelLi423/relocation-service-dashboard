// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MobileReadonlyControl, PUBLICATION_STATUS_POLL_MS, type MobileReadonlyControlApi } from "../../src/renderer/components/mobile-readonly-control";
import type { MobileReadonlyStatusDto } from "../../src/shared/ipc";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(overrides: Partial<MobileReadonlyStatusDto> = {}): MobileReadonlyStatusDto {
  return { configured: false, enabled: false, target: null, lastSuccessfulAt: null,
    lastFailedCode: null, lastFailedAt: null, issue: "not_configured", ...overrides };
}
function bridge(initial = fixture()) {
  let status = initial;
  const api = {
    mobileReadonlyStatus: vi.fn(async () => status),
    mobileReadonlyConfigure: vi.fn(async (input: { target: string; token: string }) => {
      status = { ...status, configured: true, target: input.target, issue: null }; return status;
    }),
    mobileReadonlySetEnabled: vi.fn(async (input: { enabled: boolean }) => {
      status = { ...status, enabled: input.enabled }; return status;
    }),
  } satisfies MobileReadonlyControlApi;
  return api;
}
/** 宿主形态与桌面一致：入口按钮在折叠菜单里，弹窗由宿主状态持有（组件不渲染自己的入口）。 */
function Host({ api, itemVisibleByDefault = true }: { api: MobileReadonlyControlApi; itemVisibleByDefault?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(itemVisibleByDefault);
  const [panelOpen, setPanelOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" onClick={() => setMenuOpen((open) => !open)}>数据管理</button>
    {menuOpen && <button type="button" onClick={() => { setMenuOpen(false); setPanelOpen(true); }}>发布云端</button>}
    <MobileReadonlyControl api={api} open={panelOpen} onClose={() => setPanelOpen(false)} returnFocus={trigger.current} />
  </>;
}
async function open(api: MobileReadonlyControlApi) {
  render(<Host api={api} />);
  fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
  await screen.findByText("配置情况");
  return within(screen.getByRole("dialog", { name: "发布云端" }));
}
function enterConfiguration() {
  fireEvent.click(screen.getByRole("button", { name: "配置发布" }));
  fireEvent.change(screen.getByLabelText("HTTPS 服务地址"), { target: { value: "https://synthetic.invalid/" } });
  fireEvent.change(screen.getByLabelText("独立上传凭证"), { target: { value: "synthetic-upload-secret" } });
}

describe("桌面发布云端控制", () => {
  it("默认不读取后台状态；入口在折叠菜单内，未配置/停用明确且没有业务写入表单", async () => {
    const api = bridge();
    render(<Host api={api} itemVisibleByDefault={false} />);
    expect(api.mobileReadonlyStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "发布云端" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "数据管理" }));
    fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
    await screen.findByText("未配置");
    expect(screen.getByText("已停用")).toBeTruthy();
    expect((screen.getByRole("button", { name: "启用发布" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/默认关闭/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /新建项目|修改项目|删除项目|导出|备份|恢复|登录/ })).toBeNull();
    expect(api.mobileReadonlySetEnabled).not.toHaveBeenCalled();
  });
  it("入口随宿主菜单折叠消失，但弹窗保持挂载可用", async () => {
    const api = bridge(); await open(api);
    expect(screen.queryByRole("button", { name: "发布云端" })).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "发布云端" });
    expect(within(dialog).getByText("配置情况")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "配置发布" })).toBeEnabled();
  });
  it("仅通过 bridge 保存 HTTPS 配置；密码只写、成功清空且不会隐式启用", async () => {
    const api = bridge(); await open(api); enterConfiguration();
    const password = screen.getByLabelText("独立上传凭证") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.value).toBe("synthetic-upload-secret");
    expect(screen.getByRole("dialog").textContent).not.toContain("synthetic-upload-secret");
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("已配置");
    expect(api.mobileReadonlyConfigure).toHaveBeenCalledWith({ target: "https://synthetic.invalid", token: "synthetic-upload-secret" });
    expect(api.mobileReadonlySetEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.queryByLabelText("独立上传凭证")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toContain("synthetic-upload-secret");
    fireEvent.click(screen.getByRole("button", { name: "重新配置" }));
    expect((screen.getByLabelText("独立上传凭证") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "取消配置" }));
    fireEvent.click(screen.getByRole("button", { name: "启用发布" }));
    await screen.findByText("已启用");
    expect(api.mobileReadonlySetEnabled).toHaveBeenLastCalledWith({ enabled: true });
    fireEvent.click(screen.getByRole("button", { name: "停用发布" }));
    await screen.findByText("已停用");
    expect(api.mobileReadonlySetEnabled).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByText(/停用仅停止后续发布/)).toBeTruthy();
  });
  it("关闭清除未保存 token、Escape 关闭并把焦点交还宿主入口，Tab 留在弹窗", async () => {
    const api = bridge(); await open(api); enterConfiguration();
    const close = screen.getByRole("button", { name: "关闭发布云端" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "保存配置" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "数据管理" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "数据管理" }));
    fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
    await screen.findByText("未配置");
    fireEvent.click(screen.getByRole("button", { name: "配置发布" }));
    expect((screen.getByLabelText("独立上传凭证") as HTMLInputElement).value).toBe("");
    expect(api.mobileReadonlyConfigure).not.toHaveBeenCalled();
  });
  it("展示成功、规范化失败和持久化警告，不把已启用误报停用", async () => {
    const api = bridge(fixture({ configured: true, enabled: true, target: "https://synthetic.invalid", issue: "state_unwritable",
      lastSuccessfulAt: "2026-08-08T01:02:03Z", lastFailedAt: "2026-08-08T02:03:04Z", lastFailedCode: "TIMEOUT" }));
    const dialog = await open(api);
    expect(dialog.getByText("已启用")).toBeTruthy();
    expect(dialog.getByText(/发布结果无法持久保存/)).toBeTruthy();
    expect(dialog.getByText(/发布请求超时.*TIMEOUT/)).toBeTruthy();
    const success = dialog.getByText("最近成功发布", { selector: "dt" }).nextElementSibling;
    expect(success?.textContent).not.toBe("尚无记录");
    expect(dialog.getByText("失败时间", { selector: "dt" }).nextElementSibling?.textContent).not.toBe("尚无记录");
    expect((dialog.getByRole("button", { name: "重新配置" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("LOCAL_PUBLICATION_FAILED 显示固定兜底文案且仅一次代码后缀", async () => {
    const api = bridge(fixture({ configured: true, enabled: true, target: "https://synthetic.invalid", issue: null,
      lastFailedCode: "LOCAL_PUBLICATION_FAILED" }));
    const dialog = await open(api);
    const line = dialog.getByText(/发布过程发生异常，将在下一周期重试/);
    expect(line.textContent).toBe("发布过程发生异常，将在下一周期重试（LOCAL_PUBLICATION_FAILED）");
    expect(line.textContent?.match(/LOCAL_PUBLICATION_FAILED/g)?.length).toBe(1);
  });
  it.each(["credential_unavailable", "config_corrupt", "runtime_unavailable"] as const)("%s 不允许启用", async (issue) => {
    await open(bridge(fixture({ configured: true, issue })));
    expect((screen.getByRole("button", { name: "启用发布" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("配置失败只显示白名单代码文案，不回显异常消息或 secret", async () => {
    const api = bridge();
    api.mobileReadonlyConfigure.mockRejectedValue(Object.assign(new Error("synthetic-upload-secret: private service response"), { code: "SAFE_STORAGE_UNAVAILABLE" }));
    await open(api); enterConfiguration();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("系统安全存储不可用");
    expect(alert.textContent).toContain("SAFE_STORAGE_UNAVAILABLE");
    expect(screen.getByRole("dialog").textContent).not.toContain("synthetic-upload-secret");
    expect(screen.getByRole("dialog").textContent).not.toContain("private service response");
    expect(api.mobileReadonlySetEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("未配置")).toBeTruthy();
  });
  it("未知失败码和启停异常不输出原始内容、不伪造成功状态", async () => {
    const api = bridge(fixture({ configured: true, issue: null, lastFailedCode: "private-status-secret" }));
    api.mobileReadonlySetEnabled.mockRejectedValue(new Error("private-exception-secret"));
    await open(api);
    expect(screen.getByRole("dialog").textContent).not.toContain("private-status-secret");
    fireEvent.click(screen.getByRole("button", { name: "启用发布" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog").textContent).not.toContain("private-exception-secret");
    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.queryByText("已启用")).toBeNull();
  });
  it.each(["http://synthetic.invalid", "https://synthetic.invalid/path", "https://user:private@synthetic.invalid"])("拒绝非固定 HTTPS origin：%s", async (target) => {
    const api = bridge(); await open(api); enterConfiguration();
    fireEvent.change(screen.getByLabelText("HTTPS 服务地址"), { target: { value: target } });
    fireEvent.submit(screen.getByRole("form", { name: "发布连接配置" }));
    expect(screen.getByRole("alert").textContent).toContain("INVALID_TARGET");
    expect(api.mobileReadonlyConfigure).not.toHaveBeenCalled();
  });
  it("旧版 bridge 方法缺失明确不可用，不假设配置成功", async () => {
    const partial = { mobileReadonlyStatus: vi.fn(async () => fixture({ configured: true })) };
    render(<Host api={partial} />);
    fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
    expect(screen.getByRole("status").textContent).toContain("当前版本未提供发布接口");
    expect(screen.queryByText("已配置")).toBeNull();
    expect(screen.queryByRole("button", { name: "启用发布" })).toBeNull();
    expect(partial.mobileReadonlyStatus).not.toHaveBeenCalled();
  });
  it("初次状态读取失败可重试且不显示虚构的默认状态", async () => {
    const api = bridge(); api.mobileReadonlyStatus.mockRejectedValueOnce(new Error("private-read-secret"));
    render(<Host api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog").textContent).not.toContain("private-read-secret");
    expect(screen.queryByText("已停用")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await screen.findByText("未配置");
    expect(api.mobileReadonlyStatus).toHaveBeenCalledTimes(2);
  });
  it("仅在弹窗打开且前台可见时轮询，关闭清理计时器", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = bridge(); render(<Host api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "发布云端" }));
    await act(async () => { await Promise.resolve(); });
    expect(api.mobileReadonlyStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(PUBLICATION_STATUS_POLL_MS); });
    expect(api.mobileReadonlyStatus).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(PUBLICATION_STATUS_POLL_MS * 2); });
    expect(api.mobileReadonlyStatus).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    fireEvent.click(screen.getByRole("button", { name: "关闭发布云端" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(PUBLICATION_STATUS_POLL_MS * 2); });
    expect(api.mobileReadonlyStatus).toHaveBeenCalledTimes(2);
  });
  it("保存期间关闭后迟到的结果不重开弹窗或泄漏凭证", async () => {
    const api = bridge(); let resolve!: (value: MobileReadonlyStatusDto) => void;
    api.mobileReadonlyConfigure.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await open(api); enterConfiguration();
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(api.mobileReadonlyConfigure).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "关闭发布云端" }));
    await act(async () => resolve(fixture({ configured: true, issue: null })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("synthetic-upload-secret");
  });
});
