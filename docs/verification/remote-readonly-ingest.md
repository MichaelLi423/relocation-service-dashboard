# 远程只读流式投影校验

Change：`add-remote-readonly-access`。

## 本批验收范围

- **3.2 完成**：`validateProjectionStream` 将严格 manifest、JSONL 语法/字段、跨记录关联、计数与原始字节 checksum 校验串为一次完整验证；任一环节失败都不返回成功结果。
- **3.1 部分完成**：原始正文上限 64 MiB、单行内容上限 64 KiB（不含 LF）、非空行上限 100000；字段长度复用共享闭集校验。256 MiB staging 和单一 upload/build 尚未实现。

## 实际实现

- `stream-lines.ts` 使用固定行缓冲和 fatal UTF-8 解码，支持跨 chunk 码点，保留 CR、BOM 与空白，不归一化输入；拒绝空记录。空流有效，末行可以不带 LF。
- `projection-validator.ts` 使用既有严格 JSON 与字段解析器，拒绝重复 JSON 键、未知字段、不合法标量、同类型重复 ID、缺失详情和不一致的 row/detail 计数。
- `finish()` 核对 manifest 实体计数、所有分区的项目引用、仪器/批次与维修/仪器的同项目关系，以及项目声明的子记录计数。掉票计数包含撤销历史；维修总数包含已结束事项，待修数排除 `repaired` 与 `closed_unrepaired`。
- 校验器复制并严格解析 manifest，外部修改不影响验证；失败不可恢复为成功，成功后不再接受记录，前向引用允许在收尾时统一校验。
- `validate-stream.ts` 在读取正文前拒绝不合法或声明数量超限的 manifest；在 hash 更新前检查 chunk 类型和总字节数。SHA-256 覆盖原始正文字节，包括实际 LF/CR，不包含 manifest。
- 上游异常、非法 chunk、超限均以异常中止，不将未完成尾行当作正常 EOF 冲刷。返回结果只有已解析 manifest、字节数与记录数，不包含业务记录。
- 错误重建为固定代码和消息，不透传原始输入、message 或 cause。

## 验证证据

- `npm run typecheck`：通过。
- `npx vitest run tests/remote-readonly/ingest-stream.test.ts tests/remote-readonly/ingest-associations.test.ts tests/remote-readonly/ingest-pipeline.test.ts`：**3 个文件、66 个用例通过**。
  - 分帧 19 个：含精确/超出 64 MiB、64 KiB、100000 行，拆分 UTF-8、BOM、取消、早期终止和伪造错误脱敏。
  - 关联 33 个：含前向引用、重复 ID、跨项目引用、计数矛盾、manifest 复制与生命周期封闭。
  - 协调 14 个：含完整与碎片输入、空快照、精确字节摘要、不合法尾部、故障前缀不被接收，以及声明超限时零正文读取。
- `npx vitest run tests/remote-readonly/`：**22 个文件、455 个用例通过**。
- 全部用例仅使用合成数据；没有读取客户业务文件。

## 未验收边界

- 本批不包含磁盘 staging、HTTP 路由、发布者认证、隔离 builder、只读查询、云端激活或真实网络部署。
- 验证函数不访问或修改 current/last-good 指针；完整服务在失败时保留 last good 的行为仍须在后续集成中验证。
- 行数及正文限额测试不是 API/worker 内存预算或生产容量证明。
- 未运行全量 `npm test`、Electron/手机 E2E 或 `verify:matrix`，未修改正式规格验证矩阵。
