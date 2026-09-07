/**
 * projection-validator（tasks 3.2：同类型重复 ID / 引用 / 计数 / 粘性失败切片）。
 *
 * - 输入为 manifest 文本 + JSONL 记录行。manifest 经 parseManifestText（先 strict-json
 *   重复键/语法检测，再做闭集 manifest 严格解析）；每一行记录经 strict-json 严格解析后
 *   由既有 shared 严格解析器收束 schema：
 *   * project → parseRemoteProjectRecord（强制携带 detail 分组，且 detail.id===row.id）；
 *   * 五个分区 → parseRemoteSectionRow（按行类型严格 allowlist/枚举/金额/日期校验）。
 * - 跨行状态只保存有界元数据：同类型实体 ID 集合、分区行所属 projectId、
 *   instrument.batchId / damage.instrumentId 引用、damage 的「未关闭」布尔、
 *   各类型计数、项目声明 counts/nonBlocking 与按项目累计的实际子记录计数；
 *   不保留任何业务字段值。
 * - 同类型内重复实体 ID、超过 PROJECTION_MAX_RECORDS 条记录、row/detail 的
 *   counts/nonBlocking 冲突（按实际类型逐字段相等比较）→ 接受时拒绝。
 * - 引用允许前向（被引用实体可稍后出现），直到 finish() 才整体验证：
 *   * 精确匹配 manifest.entityCounts（projects/batches/instruments/orders/invoices/
 *     damageItems 六类）；
 *   * 每个分区记录引用的 projectId 必须是已存在项目；
 *   * instrument.batchId 非 null 时，该 batch 必须存在且属于同一项目；
 *   * damage.instrumentId 必须存在且属于同一项目；
 *   * 每个项目的声明 counts/nonBlocking（row 与 detail 已逐字段一致）必须等于其
 *     实际子记录数（口径同 workbench-read-repository）：
 *     - batches/instruments/orders/invoices：计所有引用该项目的对应行
 *       （invoices 含撤销历史，不按 active 过滤）；
 *     - counts.repairs：计该项目全部 damage_items 行（含已关闭）；
 *     - nonBlocking.repairs：只计 issue_status 非 repaired/closed_unrepaired 的行。
 * - 失败粘性：任一记录被拒绝、或 finish() 校验失败后，本实例进入 failed 态：
 *   之后不再接受记录且 finish() 必抛 STICKY_FAILED，永不回退为成功。
 * - finish() 成功后进入 finished 态（seal）：重复 finish() 幂等成功；
 *   但 accept() 必抛固定 FINISHED 错误，且不再改动任何计数/元数据。
 * - 构造时对传入 manifest 重新做闭集严格解析并持有其副本：非法 manifest（含
 *   typed cast 假对象）在构造期拒绝；构造后调用方对原 manifest 对象的外部变更
 *   （如 entityCounts）不会影响本实例的校验。
 * - 所有错误为固定模板（不携带原始键/值/cause），底层 strict-json/shared 解析
 *   错误原样上抛（本身已是 metadata-only）。
 *
 * 边界声明（不虚构覆盖）：
 * - 本文件不做 raw-byte checksum 证明（manifest.checksum.hex 与 JSONL 精确字节的交叉
 *   验证属后续 stream coordinator）；不实现 disk/HTTP/auth/worker。
 * - 单行 64 KiB / 深度等语法硬限制由 strict-json 负责；总记录上限在 accept 入口检查。
 */
import {
  ContractMismatchRejection,
  InvalidValueRejection,
  UnknownFieldRejection,
  rejectionField,
} from '../../shared/remote-readonly/rejection';
import {
  parseRemoteProjectRecord,
  parseRemoteSectionRow,
  type RemoteProjectRecord,
  type RemoteSectionKind,
  type RemoteSectionRow,
} from '../../shared/remote-readonly/projection';
import {
  parseRemoteProjectionManifest,
  PROJECTION_ENTITY_TYPES,
  type ProjectionEntityCounts,
  type RemoteProjectionManifest,
} from '../../shared/remote-readonly/manifest';
import { parseStrictJsonLine } from './strict-json';

/** 单次接收允许的最大实体记录总数（超过即拒绝，不截断）。 */
export const PROJECTION_MAX_RECORDS = 100_000;

/** 本模块自有稳定错误码（值即规范 code；底层 shared/strict-json 错误码原样保留）。 */
export const PROJECTION_ERROR_CODES = {
  DUPLICATE_ENTITY_ID: 'DUPLICATE_ENTITY_ID',
  RECORD_LIMIT_EXCEEDED: 'RECORD_LIMIT_EXCEEDED',
  ROW_DETAIL_COUNTS_MISMATCH: 'ROW_DETAIL_COUNTS_MISMATCH',
  ENTITY_COUNT_MISMATCH: 'ENTITY_COUNT_MISMATCH',
  ORPHAN_SECTION_PROJECT: 'ORPHAN_SECTION_PROJECT',
  INSTRUMENT_BATCH_NOT_FOUND: 'INSTRUMENT_BATCH_NOT_FOUND',
  INSTRUMENT_BATCH_PROJECT_MISMATCH: 'INSTRUMENT_BATCH_PROJECT_MISMATCH',
  DAMAGE_INSTRUMENT_NOT_FOUND: 'DAMAGE_INSTRUMENT_NOT_FOUND',
  DAMAGE_INSTRUMENT_PROJECT_MISMATCH: 'DAMAGE_INSTRUMENT_PROJECT_MISMATCH',
  PROJECT_COUNTS_MISMATCH: 'PROJECT_COUNTS_MISMATCH',
  PROJECTION_STICKY_FAILED: 'PROJECTION_STICKY_FAILED',
  PROJECTION_FINISHED: 'PROJECTION_FINISHED',
} as const;

export type ProjectionErrorCode = (typeof PROJECTION_ERROR_CODES)[keyof typeof PROJECTION_ERROR_CODES];

const SECTION_KINDS = new Set<unknown>(['batches', 'instruments', 'orders', 'invoices', 'damage_items']);

/** 分区行外层允许键（{ kind, row }；project 行由 shared 解析器 enforce 含 detail）。 */
const SECTION_LINE_ALLOWED_KEYS: readonly string[] = ['kind', 'row'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isSectionKind(kind: unknown): kind is RemoteSectionKind {
  return SECTION_KINDS.has(kind);
}

/**
 * 严格解析 manifest 文本：
 * 1) strict-json 全量解析（重复 JSON 键 / 语法 / 深度 / 行大小在解析前拒绝）；
 * 2) 闭集 manifest 解析（未知键/枚举/计数/日期/ISO/checksum 格式严格校验）。
 * 本函数不验证 checksum.hex 与正文的关系（raw-byte 交叉校验属后续 stream coordinator）。
 */
export function parseManifestText(text: string): RemoteProjectionManifest {
  const { value } = parseStrictJsonLine(text);
  return parseRemoteProjectionManifest(value);
}

/**
 * 项目实体声明的 counts/nonBlocking 元数据（来自项目记录 row；row/detail 已逐字段一致）。
 */
interface DeclaredProjectCounts {
  batches: number;
  instruments: number;
  orders: number;
  invoices: number;
  /** counts.repairs：该项目全部 damage_items 行数（含已关闭）。 */
  repairs: number;
  /** nonBlocking.repairs：该项目「未关闭」damage_items 行数。 */
  nonBlockingRepairs: number;
}

/** 按项目累计的实际子记录数（finish 时与声明计数逐字段比较）。 */
interface ActualProjectCounts {
  batches: number;
  instruments: number;
  orders: number;
  invoices: number;
  /** 全部 damage_items（repairs 总口径）。 */
  damage: number;
  /** 未关闭 damage_items（nonBlocking.repairs 口径）。 */
  openDamage: number;
}

const ZERO_ACTUAL_PROJECT_COUNTS: ActualProjectCounts = {
  batches: 0,
  instruments: 0,
  orders: 0,
  invoices: 0,
  damage: 0,
  openDamage: 0,
};

type ActualProjectCountKey = keyof ActualProjectCounts;

/** damage 未关闭口径：issue_status 非 repaired/closed_unrepaired 视为待修。 */
function isOpenDamageItem(issueStatus: string): boolean {
  return issueStatus !== 'repaired' && issueStatus !== 'closed_unrepaired';
}

/**
 * 跨行投影校验器：只保留有界元数据，不持有业务值。
 * 构造时对传入 manifest 重新做闭集严格解析并持有副本（非法对象在构造期拒绝）。
 */
export class ProjectionValidator {
  /** 生命周期：active（接收中）→ finished（finish 成功，seal）或 failed（任一错误，粘性）。 */
  private state: 'active' | 'failed' | 'finished' = 'active';
  /** 已接受的项目实体 ID（同类型内唯一）。 */
  private readonly projectIds = new Set<string>();
  /** batch id → 所属 projectId。 */
  private readonly batchProjects = new Map<string, string>();
  /** instrument id → { projectId, batchId }。 */
  private readonly instrumentRefs = new Map<string, { projectId: string; batchId: string | null }>();
  /** order id → 所属 projectId。 */
  private readonly orderProjects = new Map<string, string>();
  /** invoice id → 所属 projectId。 */
  private readonly invoiceProjects = new Map<string, string>();
  /** damage_items id → { projectId, instrumentId, open }（open=未关闭待修）。 */
  private readonly damageRefs = new Map<string, { projectId: string; instrumentId: string; open: boolean }>();
  /** 项目 id → 声明 counts/nonBlocking（来自项目记录 row）。 */
  private readonly projectDeclaredCounts = new Map<string, DeclaredProjectCounts>();
  /** 项目 id → 实际子记录累计计数（由各分区行 projectId 累加）。 */
  private readonly projectActualCounts = new Map<string, ActualProjectCounts>();
  /** 已接受记录总数（project 每条计 1；五个分区各计 1）。 */
  private totalRecords = 0;
  /** 校验用 manifest 副本（parseRemoteProjectionManifest 全新构造，不引用调用方对象）。 */
  private readonly manifest: RemoteProjectionManifest;

  constructor(manifest: RemoteProjectionManifest) {
    // 闭集严格解析 + 复制：typed cast 传入的非法对象在此被拒绝；
    // 之后调用方对原 manifest 的 mutation 不影响本实例。
    this.manifest = parseRemoteProjectionManifest(manifest);
  }

  /** 接受一条 JSONL 记录文本（完整 project 记录或五个分区记录）；拒绝时抛固定错误并粘性失败。 */
  accept(line: string): void {
    this.guardAccept();
    try {
      this.acceptLine(line);
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  /**
   * 收尾校验：精确 manifest 计数、分区项目存在性、batch/instrument 同项目引用、
   * damage/instrument 同项目引用、项目声明计数与实际子记录一致。
   * 任一校验失败 → failed 态（粘性）；全部通过 → finished 态（seal），此后
   * 重复 finish() 幂等成功，accept() 抛固定 FINISHED 错误。
   */
  finish(): void {
    if (this.state === 'failed') {
      throw this.stickyError();
    }
    if (this.state === 'finished') {
      return;
    }
    try {
      this.assertManifestCounts();
      this.assertSectionProjectsExist();
      this.assertInstrumentBatchReferences();
      this.assertDamageInstrumentReferences();
      this.assertProjectCounts();
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
    this.state = 'finished';
  }

  /** 已接受记录总数（仅作诊断读取；不参与校验）。 */
  get acceptedRecords(): number {
    return this.totalRecords;
  }

  private guardAccept(): void {
    if (this.state === 'failed') {
      throw this.stickyError();
    }
    if (this.state === 'finished') {
      throw new InvalidValueRejection(
        PROJECTION_ERROR_CODES.PROJECTION_FINISHED,
        '投影已收尾成功，不再接受记录',
      );
    }
  }

  private stickyError(): InvalidValueRejection {
    return new InvalidValueRejection(
      PROJECTION_ERROR_CODES.PROJECTION_STICKY_FAILED,
      '已拒绝记录后投影不再有效，不接受后续记录',
    );
  }

  private acceptLine(line: string): void {
    if (this.totalRecords >= PROJECTION_MAX_RECORDS) {
      throw new InvalidValueRejection(PROJECTION_ERROR_CODES.RECORD_LIMIT_EXCEEDED, '实体记录总数超过上限');
    }
    // 语法/结构层：strict-json 全量检测重复 JSON 键、非法语法、深度与行大小。
    const { value } = parseStrictJsonLine(line);
    if (!isPlainObject(value)) {
      throw new InvalidValueRejection('INVALID_RECORD', 'JSONL 行必须是对象');
    }
    const kind = value['kind'];
    if (kind === 'project') {
      // schema 层：闭集允许键 kind/row/detail；detail 必填；detail.id===row.id；
      // 未知键/非法标量/重复 JSON 键一律拒绝。
      const record = parseRemoteProjectRecord(value);
      this.assertRowDetailConsistent(record);
      if (this.projectIds.has(record.row.id)) {
        throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
      }
      this.projectIds.add(record.row.id);
      this.projectDeclaredCounts.set(record.row.id, {
        batches: record.row.counts.batches,
        instruments: record.row.counts.instruments,
        orders: record.row.counts.orders,
        invoices: record.row.counts.invoices,
        repairs: record.row.counts.repairs,
        nonBlockingRepairs: record.row.nonBlocking.repairs,
      });
      this.totalRecords += 1;
      return;
    }
    if (!isSectionKind(kind)) {
      throw new InvalidValueRejection('INVALID_JSONL_KIND', 'JSONL 行类型不允许');
    }
    // 分区行外层只允许 kind/row（project 行才允许 detail）。
    for (const key of Object.keys(value)) {
      if (!(SECTION_LINE_ALLOWED_KEYS as readonly string[]).includes(key)) {
        throw new UnknownFieldRejection(rejectionField('jsonl', key));
      }
    }
    const rowRaw = value['row'];
    if (!isPlainObject(rowRaw)) {
      throw new InvalidValueRejection('INVALID_RECORD', 'JSONL 行 row 必须是对象');
    }
    // schema 层：分区严格 allowlist/枚举/金额/日期/标识符；row.kind 必须等于外层 kind。
    const row = parseRemoteSectionRow(rowRaw, kind);
    this.registerSection(row);
    this.totalRecords += 1;
  }

  /** row/detail 的 counts 与 nonBlocking 必须按实际类型逐字段相等（同一实体不得自相矛盾）。 */
  private assertRowDetailConsistent(record: RemoteProjectRecord): void {
    const { row, detail } = record;
    if (
      row.counts.batches !== detail.counts.batches ||
      row.counts.instruments !== detail.counts.instruments ||
      row.counts.orders !== detail.counts.orders ||
      row.counts.repairs !== detail.counts.repairs ||
      row.counts.invoices !== detail.counts.invoices ||
      row.nonBlocking.repairs !== detail.nonBlocking.repairs
    ) {
      throw new ContractMismatchRejection(
        PROJECTION_ERROR_CODES.ROW_DETAIL_COUNTS_MISMATCH,
        'row 与 detail 的关联计数/非阻塞计数不一致',
      );
    }
  }

  /** 注册分区行元数据（同类型重复 ID 在此拒绝；引用是否可解析留到 finish）。 */
  private registerSection(row: RemoteSectionRow): void {
    switch (row.kind) {
      case 'batches':
        if (this.batchProjects.has(row.id)) {
          throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
        }
        this.batchProjects.set(row.id, row.projectId);
        this.bumpActualCount(row.projectId, 'batches');
        return;
      case 'instruments':
        if (this.instrumentRefs.has(row.id)) {
          throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
        }
        this.instrumentRefs.set(row.id, { projectId: row.projectId, batchId: row.batchId });
        this.bumpActualCount(row.projectId, 'instruments');
        return;
      case 'orders':
        if (this.orderProjects.has(row.id)) {
          throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
        }
        this.orderProjects.set(row.id, row.projectId);
        this.bumpActualCount(row.projectId, 'orders');
        return;
      case 'invoices':
        if (this.invoiceProjects.has(row.id)) {
          throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
        }
        this.invoiceProjects.set(row.id, row.projectId);
        // invoices 计数含撤销历史：所有掉票行均计入，不按 active 过滤。
        this.bumpActualCount(row.projectId, 'invoices');
        return;
      case 'damage_items': {
        if (this.damageRefs.has(row.id)) {
          throw this.mismatch(PROJECTION_ERROR_CODES.DUPLICATE_ENTITY_ID, '同类型实体标识符重复');
        }
        const open = isOpenDamageItem(row.issueStatus);
        this.damageRefs.set(row.id, { projectId: row.projectId, instrumentId: row.instrumentId, open });
        this.bumpActualCount(row.projectId, 'damage');
        if (open) {
          this.bumpActualCount(row.projectId, 'openDamage');
        }
        return;
      }
    }
  }

  /** 按 projectId 累计某类实际子记录数（懒创建条目，只存计数不存业务值）。 */
  private bumpActualCount(projectId: string, key: ActualProjectCountKey): void {
    let entry = this.projectActualCounts.get(projectId);
    if (entry === undefined) {
      entry = { ...ZERO_ACTUAL_PROJECT_COUNTS };
      this.projectActualCounts.set(projectId, entry);
    }
    entry[key] += 1;
  }

  private actualCounts(): ProjectionEntityCounts {
    return {
      projects: this.projectIds.size,
      batches: this.batchProjects.size,
      instruments: this.instrumentRefs.size,
      orders: this.orderProjects.size,
      invoices: this.invoiceProjects.size,
      damageItems: this.damageRefs.size,
    };
  }

  private assertManifestCounts(): void {
    const actual = this.actualCounts();
    for (const type of PROJECTION_ENTITY_TYPES) {
      if (actual[type] !== this.manifest.entityCounts[type]) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.ENTITY_COUNT_MISMATCH,
          '接收实体计数与 manifest.entityCounts 不一致',
        );
      }
    }
  }

  /** 每个分区记录必须引用已存在的项目（前向引用在 finish 时统一解析）。 */
  private assertSectionProjectsExist(): void {
    for (const projectId of this.batchProjects.values()) {
      if (!this.projectIds.has(projectId)) {
        throw new ContractMismatchRejection(PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT, '分区记录引用了不存在的项目');
      }
    }
    for (const { projectId } of this.instrumentRefs.values()) {
      if (!this.projectIds.has(projectId)) {
        throw new ContractMismatchRejection(PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT, '分区记录引用了不存在的项目');
      }
    }
    for (const projectId of this.orderProjects.values()) {
      if (!this.projectIds.has(projectId)) {
        throw new ContractMismatchRejection(PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT, '分区记录引用了不存在的项目');
      }
    }
    for (const projectId of this.invoiceProjects.values()) {
      if (!this.projectIds.has(projectId)) {
        throw new ContractMismatchRejection(PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT, '分区记录引用了不存在的项目');
      }
    }
    for (const { projectId } of this.damageRefs.values()) {
      if (!this.projectIds.has(projectId)) {
        throw new ContractMismatchRejection(PROJECTION_ERROR_CODES.ORPHAN_SECTION_PROJECT, '分区记录引用了不存在的项目');
      }
    }
  }

  /** instrument.batchId（非 null）必须存在，且 batch 与 instrument 属于同一项目。 */
  private assertInstrumentBatchReferences(): void {
    for (const { projectId, batchId } of this.instrumentRefs.values()) {
      if (batchId === null) continue;
      const batchProjectId = this.batchProjects.get(batchId);
      if (batchProjectId === undefined) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.INSTRUMENT_BATCH_NOT_FOUND,
          '仪器引用了不存在的批次',
        );
      }
      if (batchProjectId !== projectId) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.INSTRUMENT_BATCH_PROJECT_MISMATCH,
          '仪器与其批次不属于同一项目',
        );
      }
    }
  }

  /** damage.instrumentId 必须存在，且 instrument 与 damage 属于同一项目。 */
  private assertDamageInstrumentReferences(): void {
    for (const { projectId, instrumentId } of this.damageRefs.values()) {
      const instrument = this.instrumentRefs.get(instrumentId);
      if (instrument === undefined) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.DAMAGE_INSTRUMENT_NOT_FOUND,
          '维修事项引用了不存在的仪器',
        );
      }
      if (instrument.projectId !== projectId) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.DAMAGE_INSTRUMENT_PROJECT_MISMATCH,
          '维修事项与其仪器不属于同一项目',
        );
      }
    }
  }

  /**
   * 项目声明计数与实际子记录一致性：
   * - batches/instruments/orders/invoices = 引用该项目的对应行数（invoices 含撤销历史）；
   * - counts.repairs = 该项目全部 damage_items 行数；
   * - nonBlocking.repairs = 其中「未关闭」（非 repaired/closed_unrepaired）行数。
   * 任一不符抛固定 PROJECT_COUNTS_MISMATCH（不含项目 ID / 数值）。
   */
  private assertProjectCounts(): void {
    for (const [projectId, declared] of this.projectDeclaredCounts) {
      const actual = this.projectActualCounts.get(projectId) ?? ZERO_ACTUAL_PROJECT_COUNTS;
      if (
        declared.batches !== actual.batches ||
        declared.instruments !== actual.instruments ||
        declared.orders !== actual.orders ||
        declared.invoices !== actual.invoices ||
        declared.repairs !== actual.damage ||
        declared.nonBlockingRepairs !== actual.openDamage
      ) {
        throw new ContractMismatchRejection(
          PROJECTION_ERROR_CODES.PROJECT_COUNTS_MISMATCH,
          '项目关联计数/待修计数与声明不一致',
        );
      }
    }
  }

  /** 固定模板错误工厂：message 只含受控文本，不插值任何调用方键/值。 */
  private mismatch(code: string, message: string): ContractMismatchRejection {
    return new ContractMismatchRejection(code, message);
  }
}
