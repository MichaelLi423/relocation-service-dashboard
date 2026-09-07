# 远程只读本地快照发布工件验证

日期：2026-09-07。Change：`add-remote-readonly-access`。

## 验收范围

本记录覆盖 **2.2 的本地工件构造与输出边界**（`buildPublicationArtifact` 及其支撑切片
`snapshot-source`/`snapshot-records`/`snapshot-finance`/`publication-action` 的单元证据），
以及 2.2 既有的 `snapshot-artifact` 最终边界。2.2 完整管线（真实发送、云端接收、
激活/调度、2.5 及后续）**不在本记录**；见「尚未验收」一节。

## 实际实现与证据（仅真实执行过的 focused 结果）

- 快照：对活源库执行真实 `node:sqlite` online backup，得到一致只读快照；`database_metadata`
  身份/业务修订从**快照备份库**读取（绝不读活源库）。`snapshot-source.test.ts` **13 个用例通过**。
- 枚举：快照上以无 UI 筛选的 keyset 分页枚举全部项目（含 pre-entry/completed/cancelled）及
  每项目五分区子记录；逐行严格投影并序列化。`snapshot-records.test.ts` **12 个用例通过**。
- 财务：快照待掉票金额资格与 BigInt 精确（排除孤立/已取消/已撤销/无 final，`>MAX_SAFE_INTEGER`
  分整数往返不失精度）。`snapshot-finance.test.ts` **9 个用例通过**。
- 工件组装：真实 bootstrap 库 + 实际 schema 播种验证 manifest/JSONL/metrics/checksum/身份一致、
  空库 `''` 规范摘要、活跃未提交事务排除、错误边界收口与关联预检。`snapshot-artifact.test.ts`
  **13 个用例通过**。
- 动作编排（异步 stale guard）：`publication-action.test.ts` **12 个用例通过**。

以上 focused 数字经文件核查，为各文件真实用例数。最终实际验收（2026-09-07 执行）：

- `npm run typecheck`：通过。
- `npx vitest run tests/remote-readonly/`：**19 个文件、389 个用例全部通过**。
- `openspec validate add-remote-readonly-access --strict`：通过。
- `git diff --check`：通过（新增未跟踪文件在提交前做 staged 后复核）。

## 工件内容要点

- 每个项目输出 `{kind:'project', row, detail}` 完整记录 JSONL（detail 与 row 来自同一项目，
  未经行级旧诊断形状发布）；五分区行仅含已批准字段；每行 UTF-8 ≤ 64 KiB、实体总数 ≤ 100000、
  JSONL 累计 ≤ 64 MiB（append 前拒绝）。
- 计数取自实际枚举行；`manifest.checksum.hex` = 精确 JSONL UTF-8 字节的 sha256（空快照 =
  sha256(`''`) 规范值）；`approvedSettingsDigest` = canonical empty digest。
- metrics 复用已批准 `RemoteOverviewMetrics` 五键，其中进行中项目用 `activeProjects`
  （status 非 completed/cancelled）；`pendingAmount` 来自快照 finance。
- 错误边界：无论内部抛的是哪种错误（含带 canary 的 `ValidationError`/`PersistenceError`），
  最终工件边界一律重建为固定 metadata-only `SnapshotArtifactError`（仅按已知受控 code 保留
  TOO_LARGE/ASSOCIATION_INVALID/CLEANUP_FAILED 区分，其余 BUILD_FAILED），不穿透原始
  message/cause；返回对象与错误不含 DB 路径/SQL/原生文件/canary。
- 枚举前做同项目关联预检：damage↔instrument、instrument↔非空 batch 必须同项目且非悬空，
  否则整工件拒绝（固定 code，无 id/值），不自动修复、不写业务库。

## 并发一致性证明边界

- 已证明：第二连接持有**活跃未提交**写事务（写身份与业务行）期间执行快照 → 快照 = 上一
  已提交一致状态；事务随后提交不影响已产出工件（source/artifact 均有测试）。
- 未声称：SQLite backup 可能重跑步骤，本实现与测试**不宣称“精确到备份开始瞬间”的时间点
  语义**，也没有在 backup 进行到一半时并发 COMMIT 的测试。

## 尚未验收

- 2.2 完成的是 **LOCAL 工件构造与输出边界**：无真实发送、无服务器/激活/2.5、无主进程入口、
  无桌面 UI；未触真实 Keychain/系统凭据库、Windows ACL/junction。
- 上限（100000 实体/64 KiB 行/64 MiB 累计）已实现为代码守卫，但**未全部做压力/极限验证**。
- finance 助手会忽略被 SQL 资格排除的畸形事实（孤立/已取消/已撤销/无 final），这不代表整个
  工件能容忍**参与记录的非法字段**——参与行非法金额仍会 metadata-only 拒绝（有测试）。
- 未外发客户数据、未部署、未跑 Electron E2E；`verify:matrix` 与正式规格矩阵未改动。
