# 工作台访问与角色边界（delta）

## MODIFIED Requirements

### Requirement: 无应用内访问门槛，启动直接进入工作台

工作台 SHALL NOT 提供初始化、登录、密码、恢复码或账号切换等访问门槛；负责人启动应用后 SHALL 直接进入任务指挥台，无需任何认证步骤。本限制约束本地 Windows 工作台入口；本 change 引入的 `mobile-readonly-service` 的 HTTPS Basic Auth 独立只读通道 SHALL 视为本地工作台之外的独立访问边界，不改变本地工作台直接进入的行为，也不构成本地工作台的应用内访问门槛。

#### Scenario: 启动直接进入工作台

- **GIVEN** 工作台已安装为本地桌面应用
- **WHEN** 负责人启动应用
- **THEN** 系统直接进入任务指挥台
- **AND** 不展示初始化、登录或恢复码相关界面

#### Scenario: 无初始化、登录与恢复码入口

- **GIVEN** 工作台运行中
- **WHEN** 使用者查找访问门槛功能
- **THEN** 系统不提供创建账号、登录、忘记密码或恢复码入口
- **AND** 不要求用户名与密码即可使用

#### Scenario: 远程只读认证不改变本地直接进入

- **GIVEN** 已为 `mobile-readonly-service` 配置独立的 HTTPS Basic Auth 查看凭证
- **WHEN** 负责人启动本地工作台
- **THEN** 本地工作台仍直接进入任务指挥台
- **AND** 不要求输入远程查看凭证或密码

### Requirement: 不集成外部系统

首版工作台 SHALL NOT 集成合同/ECC、服务单、Ship-to、客户或供应商等外部系统，默认 SHALL NOT 接入远程数据库或云同步；相关数据 SHALL 由负责人手工维护或经存量迁移导入。当负责人对 `mobile-readonly-publication` 显式启用时，工作台 SHALL 可向本 change 定义的 `mobile-readonly-service` 上传必要字段白名单只读快照；该例外 SHALL NOT 引入外部业务系统作为数据来源或写入方，远程副本 SHALL NOT 成为业务权威，本机 SQLite 仍是唯一业务事实来源与唯一写入方。

#### Scenario: 无外部数据同步

- **GIVEN** 外部系统存在合同、服务单、Ship-to 或客户数据
- **WHEN** 工作台运行
- **THEN** 系统不自动读取、同步或校验这些外部数据

#### Scenario: 显式启用后仅向自有只读服务发布白名单快照

- **GIVEN** 负责人已显式启用 `mobile-readonly-publication` 并配置目标服务
- **WHEN** 工作台执行移动只读发布
- **THEN** 系统仅向该自有只读服务上传必要字段白名单只读快照
- **AND** 不集成外部业务系统、不建立外部业务系统数据来源或写入方
- **AND** 远程副本不作为业务权威，本机 SQLite 仍为唯一业务事实来源与唯一写入方
