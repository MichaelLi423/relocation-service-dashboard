# 远程只读运行时最小 smoke 验证（tasks 1.1）

> 记录日期：2026-09-07。`add-remote-readonly-access` tasks 1.1 的运行时兼容性与内存预算 smoke 证据。
> 本文件只记录本项 smoke；不替代 6.2（scrypt 认证实现验证）、3.x（64 MiB／100000 实体容量边界）与 8.5（生产 ECS 容量／SLO 测量）等后续闸门。

## 1. 验证目标

- `node:sqlite`：`DatabaseSync`、`StatementSync.setReadBigInts`；
- 规定 scrypt 参数：N=2^17、r=8、p=1、salt≥16 bytes、maxmem 192 MiB；
- 记录 API 512 MiB／worker 256 MiB 内存预算下的实测结果。

## 2. 环境与镜像身份

| 项 | 值 |
| --- | --- |
| 镜像 | `node:24.15.0-bookworm-slim`（linux/amd64） |
| 宿主机 | macOS arm64（OrbStack），linux/amd64 模拟执行 |
| RepoDigest | `node@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` |
| imageId | `sha256:3880cf501a3b54bacc5e53dc327478ba723084863fa252cceb43f75aadcab12b` |
| 执行日期 | 2026-09-07 |

Node 24.15.0 是**已验证候选版本**，不作为最低 Node 版本声明（design：精确版本在 smoke 验证后固定，不声明最低 Node 版本）。

## 3. 运行边界

两个进程使用相同的最小权限／隔离参数：

```
--rm --platform linux/amd64 --network none --read-only --cap-drop ALL \
--security-opt no-new-privileges --user node --pids-limit 64
```

- 无挂载、无端口、无网络。API 另加 `--memory 512m --memory-swap 512m`（两 flag 间为正常空格）；worker 另加 `--memory 256m --memory-swap 256m`；memory 与 memory-swap 相等即关闭 swap，超限会被 OOM 终止。
- 进程只与**内存 synthetic SQLite**（`:memory:`）交互（含写入与查询），另只读 `/sys/fs/cgroup` 内存文件与自身 `resourceUsage`；stdout 仅一行 JSON。无客户数据、无持久文件写入、无对远程或共享环境的任何变更。
- 任一断言失败即抛错并以非零码退出；仅断言全部通过才打印 stdout。

## 4. 记录的实际结果

原始执行以一次性 `node -e`（CommonJS）方式运行、用 `Date.now` 计时；第 5 节程序是等效复现形态（ESM、经 stdin、用 `process.hrtime` 计时），断言与运行边界相同，**命令与原始执行并非逐字相同**。峰值／耗时逐次有正常波动，以下为记录值。

### 4.1 API 进程（512 MiB 预算，含单次 scrypt；exit 0）

```json
{"node":"v24.15.0","arch":"x64","sqliteBigInt":true,"scrypt":true,"memoryMax":"536870912","memoryPeak":"209063936","maxRSSKiB":227008,"elapsedMs":1792}
```

`memoryMax` 536870912 = 配置的 512 MiB；实测 cgroup `memory.peak` 209063936（约 199 MiB）低于上限。scrypt 同参数两次输出逐字节一致（确定性）。断言通过，未观察 OOM。

### 4.2 Worker 进程（256 MiB 预算；exit 0）

```json
{"node":"v24.15.0","arch":"x64","rows":100000,"sqliteBigInt":true,"memoryMax":"268435456","memoryPeak":"178667520","maxRSSKiB":124084,"elapsedMs":345}
```

`memoryMax` 268435456 = 配置的 256 MiB；实测 `memory.peak` 178667520（约 170 MiB）低于上限。单事务写入 100000 行 amount=`9007199254740993n`（= Number.MAX_SAFE_INTEGER+2；MAX_SAFE_INTEGER = 9007199254740991），经 `setReadBigInts` 读回 `COUNT(*) = 100000n`、`MIN(amount)` 与写入值精确一致。断言通过，未观察 OOM。

## 5. 复现程序与命令

将程序分别保存为 `api-smoke.mjs`、`worker-smoke.mjs`，经 stdin 传入容器（保持无挂载形态）：

```bash
# API（512 MiB 预算）
docker run --rm -i --platform linux/amd64 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user node --pids-limit 64 \
  --memory 512m --memory-swap 512m node:24.15.0-bookworm-slim node < api-smoke.mjs

# Worker（256 MiB 预算）
docker run --rm -i --platform linux/amd64 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --user node --pids-limit 64 \
  --memory 256m --memory-swap 256m node:24.15.0-bookworm-slim node < worker-smoke.mjs
```

`memory.max`／`memory.peak` 经 `fs` 读取 cgroup 原始文本（字符串）；`maxRSSKiB` 来自 `process.resourceUsage()`；`elapsedMs` 为进程自计墙钟（hrtime）。

### 5.1 api-smoke.mjs

```js
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resourceUsage } from 'node:process';

const t0 = process.hrtime.bigint();
const db = new DatabaseSync(':memory:');
const s = db.prepare('SELECT ? AS value');
if (typeof s.setReadBigInts !== 'function') throw new Error('setReadBigInts 不是 StatementSync 上的函数');
s.setReadBigInts(true);
const big = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2（MAX_SAFE_INTEGER = 9007199254740991）
if (s.get(big).value !== big) throw new Error('BigInt 往返不一致');

const salt = randomBytes(16);
const opts = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const a = scryptSync('synthetic-smoke-password', salt, 64, opts);
const b = scryptSync('synthetic-smoke-password', salt, 64, opts);
if (Buffer.compare(a, b) !== 0) throw new Error('scrypt 同参数输出不一致');

const out = {
  node: process.version,
  arch: process.arch,
  sqliteBigInt: true,
  scrypt: true,
  memoryMax: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  memoryPeak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
  maxRSSKiB: resourceUsage().maxRSS,
  elapsedMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
};
db.close();
console.log(JSON.stringify(out));
```

### 5.2 worker-smoke.mjs

```js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resourceUsage } from 'node:process';

const t0 = process.hrtime.bigint();
const AMOUNT = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2（MAX_SAFE_INTEGER = 9007199254740991）
const N = 100000;
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE synthetic (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)');
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO synthetic (id, amount) VALUES (?, ?)');
for (let i = 0; i < N; i++) ins.run(i, AMOUNT);
db.exec('COMMIT');

const s = db.prepare('SELECT COUNT(*) AS count, MIN(amount) AS amount FROM synthetic');
s.setReadBigInts(true);
const row = s.get();
if (row.count !== 100000n || row.amount !== AMOUNT) throw new Error('COUNT/MIN 读回不一致');

const out = {
  node: process.version,
  arch: process.arch,
  rows: N,
  sqliteBigInt: true,
  memoryMax: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  memoryPeak: readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim(),
  maxRSSKiB: resourceUsage().maxRSS,
  elapsedMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
};
db.close();
console.log(JSON.stringify(out));
```

## 6. 结论

1. 该镜像可运行 `node:sqlite`（`DatabaseSync`、`:memory:`）、`StatementSync.setReadBigInts` 与规定 scrypt 参数（N=2^17/r=8/p=1/salt 16B/maxmem 192 MiB）。
2. 精确大整数语义正确：`9007199254740993n`（Number.MAX_SAFE_INTEGER+2）经 SQLite 往返无损，COUNT/MIN 以 BigInt 精确读回。
3. 实测 cgroup 峰值（API 约 199 MiB、worker 约 170 MiB）均低于各自配置上限（512/256 MiB）；断言通过、未观察 OOM。
4. 本验证为 **1.1 最小运行时 smoke**；6.2 认证实现的并发/限流、3.3 构建 worker 固定 DDL 等仍需各自实现与测试验证。

## 7. 边界与限制

- 仅验证 `node:24.15.0-bookworm-slim` 单个已打标签镜像；候选版本不等于最低 Node 版本。
- 非全服务验证：未验证完整 service、64 MiB payload、API+builder 并发运行、生产 ECS 并存容器或 5 分钟 SLO（属 3.x 与 8.5 部署前闸门）。
- linux/amd64 在 arm64 宿主上模拟执行；`elapsedMs` 与内存峰值仅供该环境参考，不构成容量或性能承诺。
- cgroup `memory.peak`（容器级记账）与进程 `maxRSS`（`ru_maxrss`，进程自身记账）是不同层级的记账口径，数值不可直接混用或换算。
- 峰值／RSS／耗时逐次存在正常波动；判据为断言全部通过、实测峰值低于配置上限、无 OOM。
- 数据全部 synthetic（含密码串 `synthetic-smoke-password` 与行数据）；仅内存数据库写入，无客户数据、无持久文件、无网络、无远程/共享环境变更。
