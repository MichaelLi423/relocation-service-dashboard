# 移动只读云端服务

## Purpose

为移动只读发布提供最小化云端服务契约：单个轻量服务接收桌面端上传的完整只读快照，串行校验后按版本条件原子替换，并以 HTTPS 向仅本人手机浏览器提供有界搜索/筛选/分页读取；上传与查看使用互相隔离的凭证，服务不记录业务内容或密钥，不暴露整份快照文件给手机。

## Requirements

### Requirement: 轻量服务与文件信封快照存储

服务 SHALL 为无数据库、无 Redis、无消息队列的轻量进程，发布状态与业务快照 SHALL 以单一文件包络形式保存（`current.json` = `{ currentVersion, publicationId, publishedAt, snapshot }`，一次原子替换提交）；同一时刻 SHALL 仅保留该一份可读的当前包络与一份正在校验/写入的临时候选；服务端 SHALL 串行处理上传。进程启动 SHALL 读取 `current.json` 恢复 `currentVersion`/`publicationId`/`publishedAt`/`snapshot`，内存仅作缓存、不是权威；从未成功提交 SHALL 不存在该文件（无"文件版本 0"）。服务 SHALL NOT 保留多版本业务快照历史或历史 `publicationId` 库。

#### Scenario: 服务仅依赖文件快照

- **GIVEN** 云端服务已部署且已收到一次成功上传
- **WHEN** 检查服务运行依赖与存储形态
- **THEN** 服务不依赖数据库、Redis 或消息队列即可提供只读访问
- **AND** 当前可读数据为文件包络 `{currentVersion, publicationId, publishedAt, snapshot}` 形式的完整快照

#### Scenario: 启动从文件恢复发布状态

- **GIVEN** 服务此前已成功提交版本 8 并随后重启
- **WHEN** 服务启动并加载数据
- **THEN** 服务从 `current.json` 恢复 `currentVersion=8`、`publicationId` 与 `publishedAt`
- **AND** 内存缓存与文件一致，不以"版本 0"重新开始

#### Scenario: 从未提交则无文件无版本

- **GIVEN** 服务部署后从未收到成功上传
- **WHEN** 检查服务存储与元数据
- **THEN** 不存在 `current.json` 且服务如实报告"尚未发布"
- **AND** 不虚构版本 0 或空快照为已发布状态

### Requirement: 完整快照校验后原子替换

服务 SHALL 在接收上传时先完整校验**业务快照层（`snapshot`）**：JSON 结构与嵌套 key 均须在 `design.md` 封闭字段表内（含嵌套未知 key 拒绝）、金额与日期格式合法、快照携带捕获指纹与 `dataAsOf`；`protocol` 层（`publicationId`/`expectedCurrentVersion`）SHALL 按协议校验且 SHALL NOT 参与业务白名单 unknown-key 判定。校验通过后 SHALL 以一次原子替换写入新包络（含递增后的 `currentVersion`、新 `publicationId`、`publishedAt` 与业务 `snapshot`），替换失败或校验失败 SHALL 保留上一份完整包络继续可读并返回明确错误；校验完成前 SHALL NOT 暴露部分写入的候选为可读版本。未完成校验的临时文件（含进程重启遗留）SHALL NOT 成为可读包络。

#### Scenario: 有效快照原子替换当前版本

- **GIVEN** 服务当前持有包络 V1
- **WHEN** 桌面端上传校验通过的新包络 V2
- **THEN** 服务原子替换为 V2（含新版本、`publicationId` 与 `publishedAt`）
- **AND** 后续只读请求返回 V2 而非 V1 或部分内容

#### Scenario: 校验失败保留旧版本

- **GIVEN** 服务当前持有包络 V1
- **WHEN** 桌面端上传含未知 key、结构或格式非法的快照
- **THEN** 服务拒绝该候选并向上传方返回明确错误
- **AND** 当前可读包络仍为 V1，不出现半写状态

#### Scenario: 嵌套未知 key 被拒

- **GIVEN** 候选的业务快照项目记录内部含白名单之外的嵌套字段
- **WHEN** 服务校验该候选
- **THEN** 服务拒绝该候选并返回明确错误
- **AND** 当前可读包络保持不变

#### Scenario: 协议字段不触发业务白名单

- **GIVEN** 上传请求携带 `protocol`（`publicationId`、`expectedCurrentVersion`）与 `snapshot` 两层
- **WHEN** 服务分别校验两层
- **THEN** `protocol` 字段按协议校验、不进业务白名单 unknown-key 判定
- **AND** `snapshot` 层任何表外或嵌套未知 key 仍被拒绝

#### Scenario: 首次发布使用初始逻辑版本

- **GIVEN** 服务从未成功提交且不存在 `current.json`
- **WHEN** 上传方读取版本元数据
- **THEN** 服务返回尚未发布、`currentVersion=0`、`publicationId=null`、`publishedAt=null`，不创建版本 0 文件
- **AND** 首份合法候选携带 `expectedCurrentVersion=0` 时可提交为版本 1，包括合法空集合快照

#### Scenario: 重启遗留临时文件不成为可读版本

- **GIVEN** 服务在写入临时候选时被重启
- **WHEN** 服务重新启动并加载
- **THEN** 未完成校验/替换的临时文件不作为可读包络
- **AND** 恢复为上次原子提交的 `current.json` 状态

### Requirement: 版本条件替换与幂等

服务 SHALL 维护单调递增的当前发布版本并随包络持久化；上传请求体 SHALL 分层提交 `protocol`（`publicationId`、`expectedCurrentVersion`）与 `snapshot`（业务白名单快照），协议字段与业务快照分开校验、互不触发 unknown-key。服务 SHALL 仅当候选 `expectedCurrentVersion` 等于当前版本时才提交替换（不比较指纹新旧、不做代际顺序推断），提交后以**一次原子替换**将新包络（`currentVersion+1`、新 `publicationId`、本次 `publishedAt` 与业务 `snapshot`）落盘；`publishedAt` 为服务端接收成功时刻，独立于快照头部 `dataAsOf`。幂等 SHALL 仅对**当前存储的 `publicationId`** 生效：重复提交相同 `publicationId` SHALL 返回成功且不递增版本、不修改 `publishedAt`、不重复替换；早于当前的其他 `publicationId`（含提交成功响应丢失后服务重启的场景判定）一律视为冲突，返回当前版本元数据，SHALL NOT 覆盖新快照。服务 SHALL NOT 保存历史 `publicationId` 库。

#### Scenario: 期望版本一致则提交

- **GIVEN** 服务当前版本为 7
- **WHEN** 桌面端上传携带 `expectedCurrentVersion=7` 的校验通过候选
- **THEN** 服务原子替换为候选内容并将当前版本推进到 8
- **AND** 新包络记录本次 `publicationId` 与 `publishedAt`

#### Scenario: 期望版本过期则拒绝并返回元数据

- **GIVEN** 服务当前版本已推进到 8
- **WHEN** 桌面端迟到上传携带 `expectedCurrentVersion=7` 的旧候选
- **THEN** 服务拒绝该候选并返回当前版本元数据
- **AND** 当前快照（版本 8）保持不变

#### Scenario: 重复当前候选幂等成功

- **GIVEN** 服务当前存储的包络 `publicationId=P` 且当前版本为 8
- **WHEN** 桌面端重试上传相同 `publicationId=P`
- **THEN** 服务返回成功且不重复替换快照
- **AND** 当前版本保持 8、`publishedAt` 不被修改

#### Scenario: 提交成功响应丢失且服务重启后同候选重试幂等

- **GIVEN** 服务已接受 `publicationId=P`（版本推进到 8、记录 `publishedAt`）后重启并从文件恢复
- **WHEN** 桌面端因响应丢失以相同 `publicationId=P` 重试
- **THEN** 服务按当前 `publicationId` 幂等返回成功
- **AND** 版本保持 8、`publishedAt` 不被修改、快照不重复替换

#### Scenario: 更早候选无历史按冲突处理

- **GIVEN** 服务当前包络 `publicationId=P2`（版本 9），无历史库
- **WHEN** 桌面端提交更早候选 `publicationId=P1`（`expectedCurrentVersion` 已过期）
- **THEN** 服务将该候选按冲突处理并返回当前版本元数据
- **AND** 当前快照（版本 9）保持不变

#### Scenario: 发布完成时刻独立记录

- **GIVEN** 快照候选头部的 `dataAsOf` 为 T1（数据库一致读取建立时刻）
- **WHEN** 服务在校验后于时刻 T2 原子提交该候选
- **THEN** 服务在包络记录 `publishedAt=T2` 供版本元数据返回
- **AND** `publishedAt` 独立于 `dataAsOf`，两者不被混为一谈

### Requirement: 上传与查看凭证互相隔离且存摘要

服务 SHALL 将上传端点与只读浏览端点分离：上传请求 SHALL 使用独立上传凭证（token），只读浏览 SHALL 使用独立的查看凭证（HTTPS Basic Auth 强密码）；上传凭证 SHALL 无法读取业务数据或浏览页面，但 SHALL 可读取**非业务版本元数据**（**当前 `publicationId`**、当前版本、发布状态、快照捕获指纹与 `dataAsOf`/`publishedAt` 等）以便桌面端恢复响应丢失或冲突；查看凭证 SHALL 无法执行上传替换。服务端 SHALL 持久化查看密码与上传凭证的**摘要**而非明文，并 SHALL 以恒定时间比较校验；HTTPS Basic Auth 可由反向代理终止，上传端点 SHALL 由服务自身校验上传凭证摘要，SHALL NOT 要求上传请求同时携带查看 Basic Auth（不做模糊的双层 Basic）。服务 SHALL NOT 在日志中记录业务内容或任何密钥。

#### Scenario: 上传凭证不能读取业务数据但可读当前 publicationId 与版本元数据

- **GIVEN** 服务已持有当前快照包络与配置的上传凭证
- **WHEN** 使用上传凭证请求只读业务端点或当前快照内容
- **THEN** 服务拒绝该请求，返回未授权，不返回任何业务内容
- **AND** 使用上传凭证请求版本元数据端点则返回当前 `publicationId`、当前版本、发布状态、指纹与时间等非业务信息

#### Scenario: 查看凭证不能上传

- **GIVEN** 服务已配置查看凭证
- **WHEN** 使用查看凭证请求上传端点
- **THEN** 服务拒绝该请求，返回未授权
- **AND** 当前快照不被替换

#### Scenario: 凭证以摘要持久化且日志不含密钥

- **GIVEN** 服务已配置查看密码与上传凭证
- **WHEN** 检查存储与日志
- **THEN** 服务端仅持久化两者的密码学摘要而非明文
- **AND** 运行日志不包含业务记录内容、上传凭证、Basic Auth 密码或凭证明文

### Requirement: 有界只读查询端点且全部响应携带版本

服务 SHALL 向手机提供有界查询端点（概览、项目搜索/筛选/分页、项目详情、按类分页的关联记录），在服务端执行搜索、筛选与分页，SHALL NOT 向手机直接返回整份快照 JSON；所有业务响应 SHALL 携带当前发布版本标识及非业务发布元数据（`dataAsOf` 与 `publishedAt`，供手机展示数据截至/发布完成语义）。项目详情及关联记录后续请求若发现当前版本与页面已加载版本不同，服务响应 SHALL 携带该版本，手机据此明确通知用户丢弃旧结果并重新加载；服务端 SHALL NOT 为此保留历史版本。

#### Scenario: 服务端执行有界搜索分页

- **GIVEN** 快照含多个搬迁项目与多类记录
- **WHEN** 手机请求带查询关键字与状态/区域筛选的项目列表
- **THEN** 服务在服务端执行搜索与筛选并返回有界分页结果
- **AND** 不向手机返回整份快照 JSON

#### Scenario: 业务响应携带版本与发布元数据

- **GIVEN** 服务当前版本为 8
- **WHEN** 手机发起概览、列表、详情或关联记录请求
- **THEN** 每个业务响应均携带当前版本 8 及非业务发布元数据（`dataAsOf`/`publishedAt`）

#### Scenario: 版本改变时通知重新加载

- **GIVEN** 手机已加载版本 8 的项目详情
- **WHEN** 手机在版本已推进到 9 后请求该项目的后续关联记录
- **THEN** 服务返回携带版本 9 的响应
- **AND** 手机明确提示丢弃旧详情结果并重新加载，服务端不保留版本 8 供回退

### Requirement: 公网 HTTPS 入口、loopback 后端与 no-store / 未发布语义

公网移动浏览器入口 SHALL 为 HTTPS：TLS SHALL 由受控反向代理（如本项目生产使用的 OpenResty vhost + acme 证书）终止，SHALL NOT 以明文 HTTP 面向公网。后端服务 SHALL 仅监听 loopback（如 `127.0.0.1:8082`）或受控内部网络，SHALL NOT 直接绑定公网地址或对公网暴露明文 HTTP；反向代理到后端 SHALL 为受控内部/loopback 通道。服务 SHALL 向业务响应提供 `no-store` 缓存控制，SHALL NOT 指示浏览器缓存业务数据供离线复用。服务 SHALL 区分两种状态：**尚未发布**（从未成功接收快照）与**已发布但快照为空集合**（合法空快照，如首次发布空库、数据清空或恢复空库后发布的空集合）。尚未发布时 SHALL 返回明确"尚未发布"状态；已发布但快照为空集合 SHALL 按正常发布返回（概览/列表为空），两者 SHALL NOT 被混淆。

#### Scenario: 公网仅经 HTTPS 入口且后端不对公网直绑

- **GIVEN** 生产拓扑为受控反向代理终止 TLS、后端服务仅监听 loopback
- **WHEN** 检查公网入口与后端绑定
- **THEN** 公网浏览器入口为 HTTPS（TLS 在反向代理终止），后端服务未直接对公网绑定或暴露明文 HTTP
- **AND** 反向代理到后端仅经 loopback/受控内部通道，业务响应仍带 `no-store`

#### Scenario: 尚未发布时明确提示

- **GIVEN** 云端服务已部署但从未收到成功上传
- **WHEN** 本人手机浏览器经 HTTPS 请求查看
- **THEN** 服务返回明确的"尚未发布数据"状态
- **AND** 不将空数据渲染为正常业务数据

#### Scenario: 已发布空快照与尚未发布区分

- **GIVEN** 服务已成功接收一份内容为空集合的快照
- **WHEN** 本人手机浏览器请求查看
- **THEN** 服务按已发布状态返回（概览/列表为空但不提示"尚未发布"）
- **AND** 该响应区别于从未发布的状态

#### Scenario: 浏览器不缓存业务响应

- **GIVEN** 手机浏览器已通过 HTTPS 成功读取一次快照页面
- **WHEN** 检查该响应的缓存语义
- **THEN** 业务响应携带 `no-store`
- **AND** 浏览器不在本地缓存业务数据供离线复用

### Requirement: 请求体限制、上传超时与中断防护

服务 SHALL 限制上传请求体与只读请求负载大小，超限请求 SHALL 被拒绝并返回明确错误；上传请求 SHALL 在有限超时内完成，桌面端上传超时 SHALL 由桌面侧记录并重试；上传中断而未完成校验的快照 SHALL NOT 成为可读版本，服务端对随后的完整重试按既有规则处理（`expectedCurrentVersion` 未变则正常条件提交；`publicationId` 已等于当前存储值则幂等成功；版本已前进则按冲突返回当前元数据）。

#### Scenario: 超大上传被拒

- **GIVEN** 服务配置了请求体大小上限
- **WHEN** 桌面端上传超过上限的请求体
- **THEN** 服务拒绝该请求并返回明确错误
- **AND** 当前可读快照保持不变

#### Scenario: 上传超时后按版本元数据收敛

- **GIVEN** 桌面端上传在有限超时内未完成（可能已提交也可能未提交）
- **WHEN** 桌面端读取版本元数据并按三分支收敛
- **THEN** 元数据 `publicationId` 等于候选则确认成功；版本仍等于 `expectedCurrentVersion` 则原样重传；版本已前进且 `publicationId` 不同则重新生成候选
- **AND** 服务端在任何分支下都不产生半写内容

#### Scenario: 中断上传不产生可读版本

- **GIVEN** 桌面端开始上传完整快照
- **WHEN** 上传中途网络中断，服务未完成校验
- **THEN** 服务不暴露任何部分内容为可读版本
- **AND** 上传方在下一周期重传时按既有规则处理：`expectedCurrentVersion` 未变则正常条件提交，不因中断产生半写状态
