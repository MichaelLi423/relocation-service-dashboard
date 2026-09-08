# Staging 基础验证

Change：`add-remote-readonly-access`。本记录仅覆盖 3.1 的基础组件，不代表完整 staging 流程已验收。

## 已实现

- `staging-contract.ts`：256 MiB 总内容字节预算；固定 manifest、projection、build 文件名及各自 64 KiB、64 MiB、128 MiB 上限。
- `staging-writer.ts`：写入前检查额度，复制稳定字节后执行 I/O，处理部分写入、零进展与 ENOSPC；按实际成功写入字节记账，共享预算不允许并发写入排队；I/O 失败后禁止继续写入，close 等待在途写入且不返还额度。
- `staging-root.ts`：固定私有根及带格式标识的 marker；已有陌生目录不认领、不改权限；创建前检查保护路径双向重叠，保留符号链接后接 `..` 的真实语义，并复查保护别名的重定向。
- 根目录状态检查识别 `active/` 中三种固定用途文件，核对普通文件、链接数、权限、单文件及总字节上限；不读取 payload 内容。异常仅报告需要恢复，不自动修复或删除；`occupied` 不是投影已验证或持有进程仍存活的证明。
- `staging-lease.ts`：以 `active/` 原子 mkdir 跨进程独占；不根据 PID、mtime 或 TTL 自动抢占。核对根、active 和 owner 文件身份，错误及状态不暴露路径或 token。

## 实际验证

- `npm run typecheck`：通过。
- `npx vitest run tests/remote-readonly/staging-root.test.ts tests/remote-readonly/staging-lease.test.ts tests/remote-readonly/staging-writer.test.ts`：**3 个文件、85 个用例通过**。
- root：40 个用例，包括陌生目录零修改、保护路径、符号/硬链接、初始化竞争、原路径复查及固定 payload 文件检查。
- lease：21 个用例，包括真实 Node 子进程竞争、持有者被终止后仍保持 BUSY、owner 替换、未知文件不删除及清理失败保留锁。
- writer：24 个用例，包含真实临时文件的 64/128/256 MiB 边界、部分写、stat/close 故障、并发拒绝与稳定副本。

用例仅使用合成数据和临时目录。本机 Darwin 上全部执行；root 套件的 Windows 排除条件未触发。`120000` 是部分用例的超时上限，不是实测运行时间。

## 尚未完成

- 租约当前仅管理 `owner.json`，尚无固定 payload 文件打开、句柄登记及统一关闭能力。
- root 已能检查三种 payload 文件，但写入器仍由测试直接提供文件句柄；尚未由租约统一打开和管理。
- 尚未串联 root acquire → 固定文件写入 → `validateProjectionStream` → build → cleanup。
- 3.1 保持未勾选；失败保留 last good、真实 builder 生命周期和完整接收流程仍待集成验证。
- 配额证据针对受控文件内容字节，不等于操作系统物理磁盘硬配额；未验证 Windows ACL、实际容器资源预算、HTTP/认证或部署。

后续文件仍放在固定 `active/` 内。只有关闭全部在途资源并安全清理后才能删除 active 释放占用；不得先释放锁再清理，亦不自动回收崩溃占用。
