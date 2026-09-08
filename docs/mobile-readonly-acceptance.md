# 移动只读 E2E 验收说明（tasks 6.5 / 8.1–8.3）

本文档说明 `add-mobile-readonly-publication` change 的移动只读 E2E 验收路径：合成数据
规模、可控时钟语义、5 分钟可见预算口径、测试证书信任方式、构建与执行命令。与
`src/main/mobile-readonly/e2e-clock.ts`、`design.md` D8「5 分钟可见预算」一致。

## 1. 运行前置与命令

```bash
# 1) 手机静态 web 构建（服务 webRoot = dist/mobile-readonly/web）
npm run build:mobile-readonly
# 2) 真实打包 Electron（macOS 开发机；out/搬迁服务工作台-darwin-arm64/…）
npm run e2e:build
# 3) 运行移动只读 E2E（独立配置，workers=1；不混入旧 electron-smoke 项目）
npx playwright test --config playwright.mobile-readonly.config.ts --workers=1
# 或等价 npm 脚本
npm run test:e2e:mobile-readonly
```

产物缺失时用例**明确失败而非跳过**（顶层构建断言给出缺失文件与修复命令）。旧的
`playwright.config.ts`（electron-smoke 项目）已用 `testIgnore` 排除两条 mobile spec，
防止默认 `npm run test:e2e` 重复执行移动只读验收。

## 2. 用例与验收映射

| 验收 | spec / test | 说明 |
|---|---|---|
| 6.5 360px 与 390px | `e2e/mobile-readonly-view.spec.ts`「360px…」与「390px…」 | 概览、客户/ECC/临时编号搜索、状态与区域筛选、末页分页、项目详情与六类关联记录第 2 页；每步断言 `scrollWidth <= innerWidth` 无页面级横向溢出（含超长文本）。全部经服务端有界查询端点（真实 Basic Auth）。 |
| 6.4 状态区分/断网 | `mobile-readonly-view.spec.ts`「尚未发布与已发布空快照…」与「完整刷新且服务不可达…」 | 未发布 `尚未发布数据`；已发布空集合 `已发布 · V1 + 已发布，暂无项目`；两者明确区分。服务关闭后完整刷新 → 浏览器页面不可用（no-store，无离线缓存），不断言恢复旧内容。 |
| 8.1 桌面发布 | `mobile-readonly-publish.spec.ts` P1 与 P2 | P1：默认关闭/未配置断言 → 一次性配置 → 启用 → 空库首发 → 真实 UI 建档/改名 → 自动周期上传 → 本地状态（configured/成功/最近成功时间）→ 桌面主操作流不受影响。P2：断服 → 规范化失败码（META_READ_FAILED）不阻断本地 → 恢复服务自动成功；真实 UI 删除批次记录后新快照全量替换、不含该记录。 |
| 8.2 云端收件 | `mobile-readonly-publish.spec.ts` P3（真实 HTTP 协议级） | current.json 信封原子整文件落盘、同版本/publicationId/publishedAt；重复当前 publicationId 幂等（版本/时间/文件字节不变）；过期期望版本 409 拒绝；服务重启后同候选重试幂等且版本 8、publishedAt 不变；删除记录后的新快照不含该记录。P3 为 Node 级真实 HTTP 证据，不替代 P1/P2 桌面路径。 |
| 8.3 手机可见 | `mobile-readonly-publish.spec.ts` P1 | 桌面改名后依赖自动周期（120s）与手机前台周期（60s）**自动触发**，在手机 DOM 断言出现新值（不手动刷新页面/不按检查按钮/不切换前后台），并测量真实墙钟分段。 |

## 3. 合成数据与声明规模

- 数据生成：`scripts/mobile-readonly-synthetic.cjs`（只含脱敏合成快照，封闭白名单
  schemaVersion=1；浏览器端 fixture 以 require 类型包装复用）。
- 浏览器可见规模（6.5 view spec）：45 个项目，首个项目每类关联记录 25 条；另注入
  一条超长客户名用于无横向溢出断言。手机控制器固定 `limit=20`，因此 45 项目分 3 页，
  25 条记录分 2 页。
- 桌面端规模（8.x publish spec）如实声明：通过真实 UI 只建立 1～2 个项目与 1～3 条
  批次记录（不假装覆盖 45 项目规模）；该规模为「正常网络 + 支持数据规模」声明下的
  桌面发布/手机可见验收，P3 协议用例同样使用 1 项目小快照。
- 任何 E2E 都不读取/写入 `docs/` 真实客户文件与真实 userData；服务数据与凭证摘要均
  位于 `os.tmpdir()` 下的测试临时目录，用例结束清理。

## 4. 时钟语义（可控，非真实等待）

- 桌面：仅当 `WORKBENCH_E2E_MOBILE_READONLY` 与指向 OS 临时目录的
  `WORKBENCH_E2E_USER_DATA_DIR` 两个闸门同时满足，主进程 wiring 才会创建并暴露
  `__workbenchMobileReadonlyE2EClock` 全局。E2E 只调用 `advance(ms)`（自然触发到期
  周期，跑真实引擎调度），**不调用 checkNow**；正常启动不创建任何全局、renderer 无
  任何时钟控制 IPC。
- 手机：以浏览器 `page.clock` 安装后推进 60s，驱动前台周期自动版本检查。
- 真实引擎仍做真实 HTTPS 上传/查询；`advance` 返回后再通过真实 HTTP `/api/meta` 或
  发布面板（IPC 状态只读，不是 checkNow）轮询结果。

## 5. 5 分钟可见预算（design D8）

`本地变化检查 ≤120s`（桌面周期 120_000ms）+ `手机前台相邻触发 ≤60s`
（`CHECK_INTERVAL_MS = 60_000`）+ `其余环节（快照生成/上传/取数/渲染）合计 ≤120s`，
总 ≤ 5 分钟。P1 在「改名保存 → 手机 DOM 出现新名」之间按真实墙钟记录并断言：

- `desktopLocalCheckWallMs ≤ DESKTOP_PERIODIC_MS (120s)`
- `phoneCheckWallMs ≤ MOBILE_CHECK_INTERVAL_MS (60s)`
- `endToEndWallMs ≤ TOTAL_VISIBLE_BUDGET_MS (300s)`
- `endToEndWallMs ≤ REMAINING_BUDGET_MS (120s)`（虚拟时钟已推进等待间隔，墙钟测量覆盖其余处理环节）

实际本地合成数据与回环网络下各分段通常远小于预算；断言防的是配置/实现回退导致
「推进一个周期仍不发布/不更新」的情况。P1 报告逐条打印以上实测分段与配置值。

### 本地执行证据（2026-09-08）

真实打包 Electron、OS 安全存储及本地 HTTPS 服务下，P1 已通过。规模为 1 个合成项目、0 条关联记录；桌面经真实 UI 改名后，分别推进桌面 120 秒与手机 60 秒的可控时钟，由自动调度触发上传和查询，手机 DOM 出现新名且旧名消失，没有手动刷新或切换前后台。

| 处理环节 | 实测墙钟耗时 |
|---|---:|
| 桌面快照生成及上传落盘 | 248ms |
| 手机取数及渲染 | 80ms |
| 合计 | 328ms |

等待间隔由可控时钟推进，不包含在上述墙钟耗时中。该结果验证声明规模及本地正常网络下的预算路径，不证明公网生产延迟或更大规模性能。360/390px 浏览器用例另以 45 个项目及每类 25 条关联记录验证搜索、分页与无横向溢出，不将该规模混作 P1 的发布性能证据。

同日，手机浏览器 4 项 E2E 与发布 P1/P2/P3 均通过（分别运行，无跳过）。P2 验证停服期间本地改名、补录正常，按同一 origin 重启服务后自动发布恢复，并通过真实 UI 删除批次后确认新快照排除该记录。P3 验证原子信封、当前候选幂等、过期期望版本拒绝及版本 8 重启恢复。类型检查、207 项聚焦测试及 120 项既有桌面/IPC 回归通过；Electron 打包、独立 Web/服务构建和本地 Docker 构建通过。生产 DNS、证书、安全组、凭证及部署未执行，不属于这些本地验收证据。

## 6. 证书信任方式（不绕过校验）

- 服务：`startMobileReadonlyService`（真实服务源码）+ `tests/server/fixtures/tls`
  自签 localhost/127.0.0.1 测试证书，以 HTTPS 直连运行。
- 桌面发布主进程：在真实打包 Electron 主进程内以
  `process.getBuiltinModule('node:https')` 把测试 CA 注入 node:https 全局 agent ——
  **保持默认证书校验**（主机名/有效期/链），只是自定义信任锚；不使用
  `rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED` / `ignoreHTTPSErrors`。
- Chromium（手机页面）：`playwright.mobile-readonly.config.ts` 计算测试证书公钥 SPKI
  （sha256 base64），仅经 `--ignore-certificate-errors-spki-list=<SPKI>` 精确放行该
  夹具证书，不使用全局 `ignoreHTTPSErrors`；SPKI 随 fixture 证书变化自动重算。
- 测试进程内的服务查询（meta/查询/上传）同样注入同一 CA 作为信任锚。
- 若未来证书/信任方式需要换成「弱化校验」，将按验收要求直接报告阻塞，不做静默弱化。

## 7. 约束与诚实边界

- 除 `e2e/`、两个 playwright 配置、`package.json` 脚本、`tsconfig.json` include 与本
  文档外，不修改 `src/main|server|mobile|shared` 与既有测试（并发 lane 负责实现）。
- safeStorage 使用真实 OS 后端，不提供明文 mock；凭证只写摘要（服务端）或密文
  （桌面 token 文件），UI/IPC 不回显任何 secret。
- 无真机/真实网络依赖；云端协议断言在本地真实 HTTPS 服务上进行。
