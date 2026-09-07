# 远程只读基础切片验证

日期：2026-09-07。Change：`add-remote-readonly-access`。

## 验收范围

- **1.2**：独立 `mobile-read-v1` 请求/响应契约、固定快照上下文、manifest、完整项目与五类分区 JSONL、发布控制类型。没有公开整个 `WorkbenchApi` 或 Electron IPC。
- **1.4**：仅合成数据的字段白名单及财务边界测试。实际输入包含取消项目、完成项目余额、未进单项目、孤立合同/掉票、撤销掉票、重复身份、空数据、null/zero 与超安全整数金额。
- **1.1** 的容器证据见 [运行时 smoke](remote-readonly-runtime-smoke.md)。

完整项目发布必须使用 `projectRecordToJsonl`，携带必填详情并校验项目关联。保留的行级 API 仅用于诊断，不是完整发布入口。

内容 checksum 唯一定义为实际 JSONL 文本的 UTF-8 字节摘要：包含实际换行，排除 manifest；空快照为 `''`。共享实现为 `sha256JsonlContent`，测试使用独立 `createHash` 复算。

## 实际验证

- `npm run typecheck`：基础整合时通过；最终提交前再次执行。
- `npx vitest run tests/remote-readonly/`：最终 checksum 修正后 **8 个文件、216 个用例通过**。
- `openspec validate add-remote-readonly-access --strict`：通过。
- 不运行 `verify:matrix`，不修改正式规格的验证矩阵。

| 测试文件 | 用例数 | 主要证据 |
| --- | ---: | --- |
| `projection-contract.test.ts` | 50 | 白名单、严格标量、独立协议、财务行边界 |
| `contract-scalars.test.ts` | 16 | 未知键/值脱敏、日期金额、Unicode、manifest |
| `jsonl-output.test.ts` | 31 | 序列化前拒绝污染、完整详情、关联 fixture、checksum |
| `financial-facts.test.ts` | 17 | 实际事实关联、取消/孤立/撤销排除、重复拒绝、精确金额 |
| `mobile-contract.test.ts` | 19 | 固定快照、受限查询、字符与字节上限 |
| `ingest-validation.test.ts` | 28 | 严格 JSON 语法、重复解码键、单行与嵌套上限 |
| `freshness.test.ts` | 28 | 来源指纹、设置摘要、上海业务日期、无变化比较 |
| `source-report.test.ts` | 27 | 一次性 challenge、确认时间、时钟闸门、独立状态 |

## 尚未验收的边界

- **1.3** 只完成 source/DTO/JSONL 的部分白名单边界；没有云端索引、实际响应和日志链路验收。
- **3.x** 只有单行严格 JSON 解析；尚无 streaming ingress、跨行引用/计数验证、隔离 builder、完整资源限制或查询服务。
- **5.x** 是纯指纹与状态转换；调用方仍须实现原子持久化、真实来源采样与调度。没有跨重启防重放或实际 TOTP/MFA 接线证据。
- 发布控制仅有协议类型；未实现持久化 CAS、作业排序、幂等、撤回和 GC。移除了会给出错误授权结论的不完整辅助函数。
- 未接入桌面发布、系统凭据库、业务 SQLite 快照、认证服务或手机界面；未外发真实数据，未操作远程服务器。
- 源数据缺失必填仪器名称/备件号时当前拒绝发布，不编造值；真实源兼容性尚未验证。
- 未执行 Electron E2E、手机浏览器验证或部署验收。全量 `npm test` 未运行；本次按项目约定采用 focused 验证。

这些子模块的测试通过不表示对应的跨系统任务已整体完成；任务勾选仅限实际验收项。
