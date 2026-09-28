# Tasks

## 1. 开单范围持久化

- [x] 1.1 在 v21 后追加 v22 `service_orders` 工作范围迁移与注册，保留已有索引/约束/导入来源信息，存量行默认“其他/既有”；用 `tests/persistence/migration-v22.test.ts` 验证 v21 升级、新库迁移、旧无项目记录不误判、唯一性及原字段保持，执行 `npx vitest run tests/persistence/migration-v22.test.ts`。
- [x] 1.2 更新开单领域模型及 SQLite 仓储的工作范围读写，未显式指定来源保持其他/既有，保证补录/删除不改范围；在 `tests/integration/service-order-recording.sqlite.test.ts` 覆盖保存、回读、后补及删除，执行该文件的 focused Vitest。

## 2. 领域规则与主进程动作

- [x] 2.1 为开单登记增加显式工作范围校验：中大型四类必须无项目，其他/既有搬迁必须关联真实项目，非搬迁既有项目归档不变，未知范围拒绝；在 `tests/domain/service-order-recording.test.ts` 覆盖四类独立保存、非法组合、必填客户单位、单号跨范围唯一、工程师空值及日期默认，执行该文件的 focused Vitest。
- [x] 2.2 将独立入口开单请求通过共享 IPC 与 facade 传递显式工作范围及客户单位，避免注入当前选中项目，保留项目内四类开单原有客户派生；在 `tests/integration/workbench-facade.sqlite.test.ts` 与 `tests/main/workbench-v2-ipc.test.ts` 覆盖独立提交、项目内提交、越过界面提交非法关联及失败零写入，执行这两个文件的 focused Vitest。

## 3. 月度开单报表

- [x] 3.1 扩展共享报表筛选契约和开单明细事实的工作范围，默认汇总全部，仅开单指标按工作范围过滤；保持原四类分组及服务单号计数，区域/项目标签筛选排除无项目记录；在 `tests/domain/operational-reporting.test.ts` 与 `tests/integration/operational-reporting.sqlite.test.ts` 覆盖月份、工程师、组合筛选和历史记录口径，执行两个文件的 focused Vitest。
- [x] 3.2 让开单下钻显示工作范围和客户单位，现有 Excel/PNG/PDF 汇总导出应用与当前报表相同筛选，不新增逐条导出；在报表导出相关测试中覆盖三种格式的统计一致性与无项目记录排除，执行对应 focused Vitest。

## 4. 工作台入口与可见反馈

- [x] 4.1 在顶部“二维码申请”后加入不依赖选中项目的“中大型项目开单”入口；表单复用四类类型、服务单号、开单日期、可空工程师并新增必填客户单位，保留必填提示、键盘焦点、错误反馈与保存 Toast；在工作台渲染测试及 `e2e/workbench-v2-layout.spec.ts` 的相关场景验证入口顺序、四类提交和项目队列/阶段数不变。
- [x] 4.2 跨项目历史展示“中大型”与“其他/既有”范围并保留工程师补录/清空与删除入口；在 `tests/integration/workbench-read-v2.sqlite.test.ts`、`tests/renderer/service-order-engineer.test.tsx` 覆盖历史回读、既有无项目记录和补录操作，执行两个文件的 focused Vitest。
- [x] 4.3 报表界面加入全部/其他或既有/中大型工作范围筛选，并在选区域/项目标签时解释独立开单不适用；在报表界面测试与 `e2e/workbench-v2-terminal-export.spec.ts` 的相关场景验证筛选、下钻及导出沿用同一口径。

## 5. 跨层验收

- [x] 5.1 对新旧开单流程执行 `npm run typecheck`、相关 focused Vitest，并在运行新增 E2E 前先执行 `npm run e2e:build`，再以 `npm run test:e2e -- e2e/workbench-v2-layout.spec.ts e2e/workbench-v2-terminal-export.spec.ts --workers=1` 运行相关 E2E；确认无项目中大型开单计入总量但不生成项目。
- [x] 5.2 执行 `openspec validate add-independent-large-project-orders --strict`，核对规格场景、工作范围命名和回归证据，并检查最终 diff 只含本变更实现与必要测试/文档。
