# 搬迁服务工作台宣传说明（2026-09-23）

本文档为朋友圈宣传文案与素材提供事实核对依据及使用说明。

## 1. 材料检索与草稿错项修正

经排查，Git 仓库所有分支及本地会话范围未检索到此前的朋友圈文案稿或截图。未跟踪目录保留了旧架构草稿 [architecture.json](../2026-09-23/architecture/architecture.json)，其中包含若干技术与业务错项，本次已核实修正：

- **前端框架版本**：草稿误记为 React 19，实际源码为 React 18（见 [package.json](../../../package.json)）。
- **IPC 暴露通道**：草稿误记为 `window.electronAPI`，实际通过 contextBridge 暴露为 `window.workbench`（见 [src/preload/index.ts](../../../src/preload/index.ts)）。
- **发布字段范围**：草稿标注“手机端仅消费脱敏数据”，实际快照白名单为满足现场查阅保留了客户名称、ECC 与金额等核心标识字段（见 [snapshot.ts](../../../src/main/mobile-readonly/snapshot.ts)）。

## 2. 核心业务能力对照表

| 业务模块 | 实际能力与代码证据 | 宣传表述口径 |
| :--- | :--- | :--- |
| **业务全流程** | 覆盖进单、执行批次、开单到验收掉票（[relocation-project-lifecycle](../../../src/domain/capabilities/relocation-project-lifecycle/)） | 突出业务闭环，不虚构量化指标 |
| **项目提醒与台账** | 手工维护项目提醒，支持批次、仪器等关联记录检索（[src/preload/index.ts](../../../src/preload/index.ts)） | 明确手工提醒，不称自动待办 |
| **报表与历史导入** | 支持月度区间报表导出（Excel/PNG/PDF）与向导导入预检（[operational-reporting](../../../src/domain/capabilities/operational-reporting/)） | 强调日常导出与历史迁移实用性 |
| **本地数据管理** | 本地 SQLite 权威写入，支持每日首启自动备份与手动恢复（[local-data-persistence](../../../src/domain/capabilities/local-data-persistence/)） | 强调本地离线可用，非云端多人协作 |
| **手机只读发布** | 默认关闭，手动配置后单向推送快照供现场查阅（[src/main/mobile-readonly](../../../src/main/mobile-readonly/)） | 明确启用后只读查阅，手机端不提供编辑 |

## 3. 配图规划与素材规范

朋友圈配图建议按 **01 看板 → 02 详情或 03 台账 → 04 移动端 → 可选架构图** 动线发布：

- **主看板**：[screenshots/01-workbench-overview.png](screenshots/01-workbench-overview.png)（工作台项目队列与提醒）
- **业务详情**：[screenshots/02-project-detail.png](screenshots/02-project-detail.png)（项目执行进展与基本信息）
- **关联台账**：[screenshots/03-records-ledger.png](screenshots/03-records-ledger.png)（搬迁批次与仪器记录）
- **移动只读**：[screenshots/04-mobile-readonly.png](screenshots/04-mobile-readonly.png)（手机端只读列表与详情）
- **架构图（可选）**：[architecture/architecture.share.png](architecture/architecture.share.png)（交互版见 [architecture.html](architecture/architecture.html)）

### 素材验证与环境说明
1. **生成与审阅状态**：截图脚本经 `npm run e2e:build` + `npm run build:mobile-readonly` + Node 截图流程实跑（退出码 0），四张截图均已通过主代理审阅；架构图 showcase 规则校验 0 错误 0 警告并通过多视口审阅。
2. **数据与环境界限**：全量素材均基于全新虚构演示数据拍摄；当前为 macOS 源码实拍，不代表 Windows 环境验证。本次工作无业务代码改动，未执行全量回归测试。
3. **文案提取**：直接选用 [moments-copy.md](moments-copy.md) 中的主推版或短版文案。

