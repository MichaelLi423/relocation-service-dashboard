# 客户功能迭代验收（2026-10-26）

## 本次交付
- 二维码申请页及报表增加申请人、申请月份、类型工作量统计；条数按记录计算，工作量按每条去重类型数计算，页面统计覆盖全部筛选结果。
- 下线桌面及手机端到访入口、禁用新增 visit；历史活动、工作事实、维修依赖及计划上门日期保留。
- 在“更正进单/合同资料”中单独开启进单金额快照更正，回溯原进单月份统计，不联动当前合同金额。
- 月度掉票按月份、区域汇总金额、次数及去重项目数；撤销不计，Excel/PDF/PNG 导出同步。

## 已执行检查
- `npm run typecheck`：通过。
- 定向 Vitest：10 文件、255 用例通过，覆盖财务、统计、SQLite、删除兼容、界面及报表筛选；未执行含大规模性能用例的全量测试。
- `npm run e2e:build`、`npm run build:mobile-readonly`：通过。
- `npx playwright test e2e/iteration-ui.spec.ts --workers=1`：1 通过；真实 macOS Electron 包验证快照回溯、二维码统计和到访下线。
- 手机专项（`playwright.mobile-readonly.config.ts`，`-g '手机只读专项'`）：360px、390px 共 2 通过，验证其余五类记录翻页及含历史活动快照兼容。
- 已查看本次合成数据截图（`out/e2e-screenshots/`，未提交构建产物）；未读取或修改客户真实文件，未验证 Windows 包。

## 既有失败与验收边界
- `tests/interface/layout.test.ts`：2 个旧断言失败，引用已不在 HEAD 实现中的 `.data-menu summary:hover` 与 `detail-tag-entry`；未改无关样式或削弱断言。
- `e2e/electron-smoke.spec.ts`：2 失败、1 跳过，阻塞于旧首页标题；本次独立桌面 E2E 通过。
- 手机全文件：4 通过、2 失败；旧测试按 8 个状态推算客户编号，夹具实际为 9 个状态，已完成项目不包含客户 38，失败发生在到访入口验证之前；本次独立专项通过。
- `npm run verify:matrix`：735 场景、616 有效证据、119 缺口，退出码 1。用隔离目录的 HEAD 重新生成得到 726/607/119；本次新增 9 场景均有证据，没有新增缺口。仓库原已跟踪矩阵过期，本次如实更新。
