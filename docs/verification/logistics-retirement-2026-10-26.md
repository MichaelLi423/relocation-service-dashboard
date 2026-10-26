# 物流费用与运输批次登记下线验收

## 确认范围
- 下线整个登记功能，不改名为运输安排；移除详情标签、快速/就近登记、编辑、历史浏览及手机批次入口。
- 主进程拒绝旧 `batch`、`logistics`、`batch_edit` 写请求，拒绝不改变业务修订或历史数据。
- 公共报表、下钻和 Excel/PNG/PDF 不再提供月度物流费用、合同占比、待补/历史异常批次清单及运输公司筛选。
- 保留历史批次、费用、仪器关联及底层兼容模型；项目级计划运输日期仍可维护。手机详情默认展示仪器，不加载批次记录作为默认页。

## 最终验证
- `npm run typecheck` 通过；限定本次文件的 `git diff --check` 通过。
- 23 个定向 Vitest 文件：495 通过、2 失败。两个失败分别为 `app.test.tsx` 报表筛选后下钻与 `new-batch-behaviors.sqlite.test.ts` 正式进单状态断言；均在隔离的修改前 HEAD（9fc223a）复现，未跳过或削弱断言。
- macOS Electron 重新打包成功；`e2e/iteration-ui.spec.ts --workers=1`：1 通过，覆盖登记入口下线及上一轮二维码/快照功能。
- 移动只读构建成功；`playwright.mobile-readonly.config.ts` 的“手机只读专项”：360px、390px 共 2 通过，验证默认仪器页、无批次/到访入口及剩余四类记录翻页。
- 已核对真实合成数据截图 `out/e2e-screenshots/01-project-facts-no-visit.png`：四个详情标签与计划运输日期保留，物流登记标签和事实计数消失。
- `npm run verify:matrix`：738 场景、619 有效证据、119 既有缺口，退出码 1；本次新增 3 个场景均有证据，没有新增缺口。
- 未执行全量性能测试或 Windows 打包；未读取、修改客户真实 xlsx/pptx，未删除历史数据库内容。
