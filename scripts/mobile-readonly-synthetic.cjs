'use strict';

/**
 * 移动只读本地开发/验证合成数据（CommonJS；供 scripts/dev-mobile-readonly.cjs 与后续 E2E 复用）。
 *
 * - 只产生脱敏合成快照（封闭白名单 schemaVersion=1），绝不读取/触碰 docs/ 真实客户文件；
 * - 规模默认：45 个项目，首个项目每类关联记录 ≥25（便于有界分页验证），其余项目为空记录；
 * - 凭证：本地演示明文常量仅供本地 dev（非生产 secret），落盘只写 scrypt 摘要文件，
 *   格式与 src/server/mobile-readonly/credentials.ts 完全一致（scrypt$N$r$p$keyLen$salt$hash）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCRYPT_DEFAULT = { N: 16384, r: 8, p: 1, keyLen: 64 };
const SALT_BYTES = 16;

const SYNTHETIC = Object.freeze({
  viewerUsername: 'viewer',
  viewerPassword: 'mobile-demo-viewer-2026',
  uploadToken: 'mobile-demo-upload-2026',
  publicationId: 'synthetic-dev-pub-0001',
  dataAsOf: '2026-08-08T09:00:00Z',
  contentGenerationId: 'synthetic-generation-dev-0001',
});

const PROJECT_STATUSES = Object.freeze([
  'pending_entry',
  'pending_execution',
  'executing',
  'under_repair',
  'pending_acceptance',
  'pending_invoice',
  'completed',
  'cancelled',
]);

const STAGE_STATUSES = Object.freeze([
  'pending_entry',
  'pending_execution',
  'executing',
  'under_repair',
  'pending_acceptance',
  'pending_invoice',
  'completed',
]);

const ORDER_TYPES = Object.freeze(['relocation', 'certification', 'parts_by_mail', 'pm']);
const REGIONS = Object.freeze(['East', 'South', 'West', 'Central', 'North']);

/** 整数分 → 主单位两位小数字符串（不经浮点）。 */
function centsToMoney(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${units}.${frac}`;
}

/** 确定性日期：2026-08-01..08-31 循环（真实日历日期）。 */
function businessDate(index) {
  const day = (index % 31) + 1;
  return `2026-08-${String(day).padStart(2, '0')}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** scrypt 摘要（与 server credentials.ts 同格式；随机盐）。 */
function deriveScryptDigest(secret) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT_DEFAULT.keyLen, {
    N: SCRYPT_DEFAULT.N,
    r: SCRYPT_DEFAULT.r,
    p: SCRYPT_DEFAULT.p,
  });
  return `scrypt$${SCRYPT_DEFAULT.N}$${SCRYPT_DEFAULT.r}$${SCRYPT_DEFAULT.p}$${SCRYPT_DEFAULT.keyLen}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** 本地演示凭证摘要文件对象（不含明文）。 */
function createCredentialsFile(overrides = {}) {
  const viewerPassword = overrides.viewerPassword ?? SYNTHETIC.viewerPassword;
  const uploadToken = overrides.uploadToken ?? SYNTHETIC.uploadToken;
  const username = overrides.viewerUsername ?? SYNTHETIC.viewerUsername;
  if (typeof viewerPassword !== 'string' || viewerPassword.length === 0) throw new Error('本地演示查看密码不能为空');
  if (typeof uploadToken !== 'string' || uploadToken.length === 0) throw new Error('本地演示上传 token 不能为空');
  return {
    viewer: { username, digest: deriveScryptDigest(viewerPassword) },
    upload: { digest: deriveScryptDigest(uploadToken) },
  };
}

/** 把摘要凭证写入文件。 */
function writeCredentialsFileSync(filePath, overrides = {}) {
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(createCredentialsFile(overrides), null, 2)}\n`, 'utf8');
  return filePath;
}

function makeRecordList(kind, projectIndex, count, baseId) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${baseId}-${kind}-${i}`;
    switch (kind) {
      case 'batches':
        rows.push({
          id,
          planTransportDate: i % 3 === 0 ? null : businessDate(i + projectIndex),
          transportCompany: i % 2 === 0 ? `合成承运商-${i}` : null,
          startedAt: i % 4 === 0 ? null : businessDate(i + 2),
          appliedAt: i % 2 === 0 ? businessDate(i + 3) : null,
        });
        break;
      case 'instruments':
        rows.push({
          id,
          name: `合成仪器-${projectIndex}-${i}`,
          model: i % 3 === 0 ? null : `型号-${i}`,
          serialNo: i % 5 === 0 ? null : `SN-SYN-${pad2(projectIndex)}-${pad2(i)}`,
          ups: i % 2 === 0,
        });
        break;
      case 'activities':
        rows.push({
          id,
          visitAt: i % 4 === 0 ? null : businessDate(i + 4),
          engineers: i % 2 === 0 ? `合成工程师-${i}、合成工程师-${i + 1}` : `合成工程师-${i}`,
        });
        break;
      case 'orders':
        rows.push({
          id,
          orderType: ORDER_TYPES[i % ORDER_TYPES.length],
          serviceOrderNo: i % 3 === 0 ? null : `SON-SYN-${projectIndex}-${i}`,
          orderedAt: businessDate(i + 5),
          engineer: i % 3 === 0 ? null : `合成工程师-${i}`,
        });
        break;
      case 'invoices':
        rows.push({
          id,
          amount: centsToMoney((i % 2 === 0 ? 1 : 7) * 123456),
          invoicedAt: businessDate(i + 6),
          active: i % 5 !== 1,
          revokedAt: i % 5 === 1 ? businessDate(i + 7) : null,
        });
        break;
      case 'damage_items':
        rows.push({
          id,
          instrumentName: `合成仪器-${projectIndex}-${i % count}`,
          serialNo: i % 3 === 0 ? null : `SN-DMG-${pad2(projectIndex)}-${pad2(i)}`,
          issueStatus: i % 2 === 0 ? 'processing' : 'repaired',
          partNumber: `PN-${pad2(projectIndex)}-${pad2(i)}`,
          partQuantity: i % 3 === 0 ? 0 : 1 + (i % 5),
          partAmount: centsToMoney(i % 2 === 0 ? 250000 : 0),
          partCurrency: i % 4 === 0 ? null : i % 2 === 0 ? 'USD' : 'RMB',
          registeredAt: businessDate(i + 8),
        });
        break;
      default:
        throw new Error(`未知记录 kind: ${kind}`);
    }
  }
  return rows;
}

function emptyRecords() {
  return { batches: [], instruments: [], activities: [], orders: [], invoices: [], damage_items: [] };
}

function makeProject(index, recordCounts) {
  const firstProjectRecordKinds = ['batches', 'instruments', 'activities', 'orders', 'invoices', 'damage_items'];
  const records = emptyRecords();
  if (index === 0 && recordCounts > 0) {
    for (const kind of firstProjectRecordKinds) {
      records[kind] = makeRecordList(kind, index, recordCounts, `p${index}`);
    }
  } else if (index === 1) {
    // 少量记录示例（多项目校验用）。
    records.batches = makeRecordList('batches', index, 2, `p${index}`);
    records.invoices = makeRecordList('invoices', index, 2, `p${index}`);
  }
  const status = PROJECT_STATUSES[index % PROJECT_STATUSES.length];
  const region = index % 7 === 6 ? null : REGIONS[index % REGIONS.length];
  const entered = status !== 'pending_entry' && status !== 'cancelled';
  return {
    id: `synthetic-project-${pad2(index)}`,
    tempNo: `TP-SYN-${pad2(index)}`,
    ecc: entered ? `ECC-SYN-${pad2(index)}` : null,
    customerName: `合成客户-${pad2(index)}`,
    status,
    region,
    regionNeedsAdjustment: false,
    entryAt: entered ? businessDate(index) : null,
    planVisitAt: entered ? businessDate(index + 9) : null,
    finalAmount: entered ? centsToMoney(5000000 + index * 250000) : null,
    invoicedAmount: centsToMoney(0),
    contractAmount: entered ? centsToMoney(5000000 + index * 250000) : null,
    formallyEntered: entered,
    preEntryExecution: status === 'pending_entry' && index % 3 === 0,
    records,
  };
}

function makeOverview(projectCount) {
  const counts = {};
  for (let index = 0; index < projectCount; index += 1) {
    const status = PROJECT_STATUSES[index % PROJECT_STATUSES.length];
    if (status === 'cancelled') continue; // 阶段分布不含取消
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return {
    metrics: {
      totalProjects: projectCount,
      activeProjects: Math.max(0, projectCount - 1),
      pendingAmount: centsToMoney(123456),
      pendingAcceptance: projectCount >= 2 ? 2 : 0,
      pendingInvoice: projectCount >= 3 ? 1 : 0,
    },
    stages: STAGE_STATUSES.map((status) => ({
      status,
      count: counts[status] ?? 0,
      averageDays: status === 'executing' ? 3.5 : 0,
    })),
  };
}

/**
 * 生成符合封闭白名单的合成快照。
 * @param {object} [options]
 * @param {number} [options.projectCount=45]
 * @param {number} [options.firstProjectRecords=25]
 */
function buildSyntheticSnapshot(options = {}) {
  const projectCount = options.projectCount ?? 45;
  const firstProjectRecords = options.firstProjectRecords ?? 25;
  if (!Number.isInteger(projectCount) || projectCount <= 0) throw new Error('projectCount 必须为正整数');
  const projects = [];
  for (let index = 0; index < projectCount; index += 1) {
    projects.push(makeProject(index, firstProjectRecords));
  }
  return {
    schemaVersion: 1,
    contentGenerationId: SYNTHETIC.contentGenerationId,
    businessRevision: projectCount * 2 + 3,
    dataAsOf: SYNTHETIC.dataAsOf,
    overview: makeOverview(projectCount),
    projects,
  };
}

/** 默认上传请求体（protocol 与业务快照分层）。 */
function buildSyntheticUploadBody(options = {}) {
  return {
    protocol: {
      publicationId: options.publicationId ?? SYNTHETIC.publicationId,
      expectedCurrentVersion: options.expectedCurrentVersion ?? 0,
    },
    snapshot: buildSyntheticSnapshot(options),
  };
}

module.exports = {
  SYNTHETIC,
  SCRYPT_DEFAULT,
  PROJECT_STATUSES,
  STAGE_STATUSES,
  ORDER_TYPES,
  REGIONS,
  deriveScryptDigest,
  createCredentialsFile,
  writeCredentialsFileSync,
  buildSyntheticSnapshot,
  buildSyntheticUploadBody,
};
