/**
 * src/shared/remote-readonly：远程只读能力共享契约（tasks 1.2/1.3）。
 *
 * 边界：
 * - 只读投影契约 / 线协议 / 发布控制逻辑契约，供后续桌面 publisher、云端
 *   ingest/build/read/control 独立实现复用；不公开整个 src/shared/ipc.ts、
 *   不依赖 WorkbenchApi / Electron / renderer / 本机 DB。
 * - 本目录不实现真实 SQLite 读取、streaming ingress、HTTP、认证或持久化；
 *   这些是后续任务（2.x/3.x/5.x/6.x）依赖。JSONL 重复 key 检测需全量 streaming
 *   parser，本层 JSON.parse 不覆盖。
 *
 * 规范白名单唯一来源：openspec/changes/add-remote-readonly-access/specs/
 * mobile-readonly-workbench/spec.md 的字段表。
 */
export * from './rejection';
export * from './values';
export * from './projection';
export * from './manifest';
export * from './jsonl';
export * from './mobile-read-v1';
export * from './publication-control';
