/**
 * local-data-persistence 能力统一入口。
 *
 * 本模块拥有本地数据存储、备份与恢复（design D17/D18；tasks 1.9~1.13）。
 * 只供主进程 / node 环境（测试）使用；渲染层不导入本模块。
 */
export * from './connection';
export * from './schema';
export * from './schema-v2';
export * from './schema-v3';
export * from './schema-v4';
export * from './schema-v5';
export * from './schema-v6';
export * from './schema-v7';
export * from './schema-v8';
export * from './schema-v9';
export * from './schema-v10';
export * from './schema-v11';
export * from './schema-v12';
export * from './schema-v14';
export * from './schema-v20';
export * from './identity';
export * from './migration';
export * from './backup';
export * from './restore';
export * from './bootstrap';
export * from './repositories';
export * from './execution-repositories';
export * from './service-order-repositories';
export * from './ship-to-repositories';
export * from './serial-address-update-repositories';
export * from './damage-repair-repositories';
export * from './qr-request-repositories';
export * from './reminder-settings-repositories';
export * from './reporting-fact-reader';
export * from './workbench-read-repository';
export * from './project-tag-repository';
export * from './financial-repositories';
export * from './data-cleanup';
export * from './due-plan-visit-advancer';
export * from './financial-integrity';
export * from './fs-utils';
