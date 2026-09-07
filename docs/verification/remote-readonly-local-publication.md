# 本地远程发布控制与凭据工具验证

日期：2026-09-07。Change：`add-remote-readonly-access`。

## 已实现的本地切片

- `consent.ts`：规范同意描述符、publisher/epoch/lineage 绑定及三项明确确认；显式 disabled/enabled/localStopped 状态。配置变化使旧同意失效，改回原配置也不恢复授权。
- `control-store.ts`：业务库外的独立 SQLite，严格校验持久状态和队列元数据；状态变更与队列校验采用事务和 revision 检查。既有损坏库不自动重建。
- `control-paths.ts`：固定私有叶目录，创建前检查业务库与备份保护路径（含尚不存在的路径）；拒绝危险链接和陌生目录。只对本次创建的 DB 初始化，截断的既有库保留现场并报错。
- `credential-vault.ts`：通过固定版本 `@napi-rs/keyring@2.0.0` 访问系统凭据库；CLI 与主进程共用凭据键定义。缺失凭据与后端不可用分别处理，无明文或环境变量回退。
- `configure-remote-publisher.cjs`：受控本地隐藏输入工具；不接受 secret 参数或管道输入，不从环境变量取 secret。恢复终端、监听器与一次性监听语义后才写 vault；错误不回显凭据或原始后端消息。

工具调用方式：

```bash
node scripts/configure-remote-publisher.cjs --publisher-id <publisher-id>
```

只在受控交互终端使用；secret 在提示后隐藏输入。**登记凭据不等于启用发布，也不授予云端 epoch 或部署权限。** 此次验证没有执行真实凭据登记。

## 实际证据

- `npm run typecheck`：通过。
- `npx vitest run tests/remote-readonly/`：**19 个文件、389 个用例通过**（最终全目录结果）。
- 本批 focused 文件：`publication-consent.test.ts`（25）、`control-store.test.ts`（21）、`control-paths.test.ts`（20）、`credential-vault.test.ts`（16）、`credential-enrollment.test.ts`（25）。快照/发布工件相关 focused 数字见 [remote-readonly-snapshot.md](remote-readonly-snapshot.md)。
- `openspec validate add-remote-readonly-access --strict`：通过。
- `git diff --check`：通过；提交前检查暂存的新增文件（新增未跟踪文件需 staged 后再核 diff）。
- 真实 Node 子进程：CLI `--help` 退出 0，未知参数退出 1，非 TTY 登记请求退出 1；均在 5 秒超时内退出。
- 原生模块只加载验证：本机 Node 可加载 `AsyncEntry`；Electron 43.3.0（Node 24.18.1、arm64、`ELECTRON_RUN_AS_NODE=1`）同样可加载。没有构造凭据条目或调用系统凭据读写。
- 文件系统测试使用临时合成文件，覆盖符号链接、硬链接、未来保护路径及截断库；拒绝用例核对业务测试文件内容和权限无变化。
- vault 与隐藏输入测试使用 fake 后端；覆盖 secret 不回显、既有监听器不接收输入、UTF-8 分块、长度边界、取消、终端恢复及后端失败。

## 未完成与阻塞

- **2.1、2.3 尚未整体验收。** 已补充仅负责状态读取、配置、确认启用、本地停止与失效的 `PublisherController`；新增 7 个控制器测试及独立类型检查通过。异步发布编排的 `publication-action` 模块（阶段推进与 stale guard 逻辑）已完成 focused 验证（12 个用例通过），但它仍是注入适配器的纯编排模块——**真实 publisher 适配器、主进程入口与设置 UI 尚未接线**，不能据局部模块测试声称已具备可用的远程发布功能。
- 控制器初次实施两次异常后，已通过拆小任务恢复状态控制切片；没有提供假的发布适配器或伪报发布成功。
- 未验证真实 Keychain/Credential Manager 读写、Windows ACL/junction、Electron 打包后的原生模块加载或 Windows 交付产物。
- HTTPS origin 仅做语法校验，未证明证书、WireGuard、网络 ACL 或部署合规。
- 未外发客户数据、未部署服务器、未执行浏览器/Electron E2E 或全量 `npm test`。没有运行 `verify:matrix` 或改写正式规格验证矩阵。
- 路径安全依赖受控应用私有父目录，不声称能够抵御同 OS 用户恶意并发替换文件。
- JavaScript 字符串不能可靠零化；清除引用不等于内存取证擦除。后端写入失败时工具明确表示无法确认写入结果。

## 相关记录

- 本地快照发布工件（2.2）的构造/输出边界验证见 [remote-readonly-snapshot.md](remote-readonly-snapshot.md)。

## 依赖依据

- [已发布 npm 元数据](https://registry.npmjs.org/@napi-rs%2fkeyring/2.0.0)
- [2.0.0 API 类型定义](https://unpkg.com/@napi-rs/keyring@2.0.0/index.d.ts)
- [上游源码](https://github.com/Brooooooklyn/keyring-node)

依赖平台声明不替代本项目的原生操作、打包和交付验证。
