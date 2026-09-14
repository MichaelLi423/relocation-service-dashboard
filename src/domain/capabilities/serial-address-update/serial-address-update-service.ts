import { ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import {
  assertValidBusinessDate,
  SystemClock,
  toMonthKey,
  type BusinessDate,
  type Clock,
} from '../../core/time';
import type {
  SerialAddressUpdate,
  SerialAddressUpdateFilter,
  SerialAddressUpdateInput,
} from './serial-address-update';
import type {
  InstrumentAddressReader,
  SerialAddressUpdateRepository,
} from './serial-address-update-repositories';

/**
 * serial-address-update 领域服务（tasks 4.3）。
 *
 * - 逐台登记更新事实：客户名称、新址地址、序列号、Account ID 与更新时间均必填。
 * - 项目级新址仅作默认计划，不自动成为仪器实际关联新址；实际关联以最近一条
 *   更新事实为准；未登记更新事实的仪器不视为已关联新址。
 * - 更新事实不创建、修改或删除不可变 Ship-to 主数据。
 * - 更新时间必填、默认当前时间并可补录历史时间。
 * - 关联搬迁仪器（instrumentId 有值）时序列号须与登记仪器一致；
 *   独立保存（instrumentId 空）时不校验仪器，不引入未确认的序列号格式约束。
 * 手工登记绑定当前登录账号归属快照。
 */
export class SerialAddressUpdateService {
  constructor(
    private readonly updates: SerialAddressUpdateRepository,
    private readonly instruments: InstrumentAddressReader,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * 逐台登记一条序列号地址更新事实。
   * instrumentId 可空：不传（null/undefined/空串）时独立保存（不关联搬迁仪器）；
   * 传时保留「仪器存在 + 序列号与登记仪器一致」校验。
   */
  register(instrumentId: string | null | undefined, input: SerialAddressUpdateInput, actor: ActorSnapshot): SerialAddressUpdate {
    const normalizedInstrumentId = instrumentId === undefined || instrumentId === null || instrumentId.trim() === '' ? null : instrumentId.trim();
    let instrumentSerial: string | null = null;
    if (normalizedInstrumentId !== null) {
      const instrument = this.instruments.findById(normalizedInstrumentId);
      if (!instrument) {
        throw new ValidationError('INSTRUMENT_NOT_FOUND', `搬迁仪器不存在: ${normalizedInstrumentId}`);
      }
      instrumentSerial = instrument.serialNo;
    }
    const customerName = assertRequiredText(input.customerName, '客户名称');
    const newSiteAddress = assertRequiredText(input.newSiteAddress, '新址地址');
    const serialNo = assertRequiredText(input.serialNo, '序列号');
    const accountId = assertRequiredText(input.accountId, 'Account ID');
    // 关联仪器时：序列号必须与登记仪器一致（仪器无序列号占位时无法匹配，拒绝登记）。
    if (normalizedInstrumentId !== null) {
      if (instrumentSerial === null || instrumentSerial.trim() === '') {
        throw new ValidationError('INSTRUMENT_SERIAL_EMPTY', '该搬迁仪器尚无序列号，无法登记序列号地址更新');
      }
      // 与提交序列号采用同一归一化口径（assertRequiredText 去首尾空白）后比较。
      const normalizedInstrumentSerial = assertRequiredText(instrumentSerial, '序列号');
      if (serialNo !== normalizedInstrumentSerial) {
        throw new ValidationError(
          'SERIAL_NO_MISMATCH',
          `序列号「${serialNo}」与该搬迁仪器登记序列号「${normalizedInstrumentSerial}」不一致`,
        );
      }
    }
    const updatedAt = input.updatedAt ?? this.today();
    assertValidBusinessDate(updatedAt, '更新时间');
    const now = this.now();
    const update: SerialAddressUpdate = {
      id: newInternalId(),
      instrumentId: normalizedInstrumentId,
      customerName,
      newSiteAddress,
      serialNo,
      accountId,
      updatedAt,
      operatorAccountId: actor.accountId,
      operatorUsername: actor.username,
      createdAt: now,
    };
    this.updates.save(update);
    return update;
  }

  /**
   * 仪器实际关联新址：以最近一条更新事实为准（按更新时间，同时刻按登记先后，
   * 再按 id 稳定排序）。未登记更新事实返回 null（不视为已关联新址；项目级新址不替代）。
   */
  getActualAddress(instrumentId: string): SerialAddressUpdate | null {
    return this.latestByInstrument(instrumentId);
  }

  /**
   * 确认后删除一条序列号地址更新事实（5.2）。
   * - 只删除该事实记录，MUST NOT 删除/修改关联仪器、项目或 Account ID 对应的 Ship-to；
   * - 删除后该仪器实际关联新址以剩余最近更新事实为准（getActualAddress 读侧派生）。
   */
  delete(id: string): { ownedChildCount: number; instrumentId?: string } {
    const update = this.updates.findById(id);
    if (!update) {
      throw new ValidationError('SERIAL_ADDRESS_UPDATE_NOT_FOUND', `序列号地址更新记录不存在: ${id}`);
    }
    this.updates.deleteById(id);
    return { ownedChildCount: 0, instrumentId: update.instrumentId ?? undefined };
  }

  /** 更新事实列表与筛选：按客户、新址地址、序列号、Account ID 或更新时间。 */
  list(filter?: SerialAddressUpdateFilter): SerialAddressUpdate[] {
    let rows = this.updates.listAll();
    if (filter) {
      if (filter.customerName !== undefined) {
        rows = rows.filter((r) => r.customerName.includes(filter.customerName!.trim()));
      }
      if (filter.newSiteAddress !== undefined) {
        rows = rows.filter((r) => r.newSiteAddress.includes(filter.newSiteAddress!.trim()));
      }
      if (filter.serialNo !== undefined) {
        rows = rows.filter((r) => r.serialNo === filter.serialNo!.trim());
      }
      if (filter.accountId !== undefined) {
        rows = rows.filter((r) => r.accountId === filter.accountId!.trim());
      }
      if (filter.updatedAt !== undefined) {
        const key = filter.updatedAt.trim();
        rows = rows.filter((r) => r.updatedAt.startsWith(key));
      }
    }
    return rows;
  }

  /** 按更新时间所属月份计数（每条更新事实按更新日期归属）。 */
  countByMonth(): { month: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const row of this.updates.listAll()) {
      const month = toMonthKey(row.updatedAt);
      counts.set(month, (counts.get(month) ?? 0) + 1);
    }
    return [...counts.entries()].map(([month, count]) => ({ month, count }));
  }

  private latestByInstrument(instrumentId: string): SerialAddressUpdate | null {
    let latest: SerialAddressUpdate | null = null;
    for (const row of this.updates.listAll()) {
      if (row.instrumentId !== instrumentId) continue;
      if (latest === null || this.isNewerThan(row, latest)) {
        latest = row;
      }
    }
    return latest;
  }

  /** 同一仪器多条更新事实的稳定排序：更新日期 → createdAt → id。 */
  private isNewerThan(a: SerialAddressUpdate, b: SerialAddressUpdate): boolean {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
    return a.id > b.id;
  }

  private now(): string {
    return this.clock.nowIso();
  }

  /** 当前业务日期（yyyy-mm-dd）：业务时间字段默认值。 */
  private today(): BusinessDate {
    return this.clock.today();
  }
}
