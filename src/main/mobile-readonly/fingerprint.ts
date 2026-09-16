import type { DatabaseSync } from 'node:sqlite';
import { readDatabaseIdentity } from '../../domain/capabilities/local-data-persistence/identity';
import type { MobileReadonlyFingerprint } from '../../shared/mobile-readonly';

/**
 * 变化检测指纹（design D2 / tasks 3.3-3.4）。
 *
 * - 指纹 = { contentGenerationId, businessRevision }，只做相等比较；
 * - 同代际 businessRevision 增长 → 有变化；contentGenerationId 轮换（恢复）→ 有变化
 *   （不论新库 businessRevision 高低，randomUUID 不可排序）；
 * - 上传成功保存的是**候选捕获时**指纹，绝不在上传完成后重读"最新修订"做指纹。
 */

/** 读取当前本地指纹（经由 db() 提供者，恢复换库后始终拿到当前库）。 */
export function readCurrentMobileReadonlyFingerprint(db: DatabaseSync): MobileReadonlyFingerprint {
  const identity = readDatabaseIdentity(db);
  return {
    contentGenerationId: identity.contentGenerationId,
    businessRevision: identity.businessRevision,
  };
}

/** 相等比较（指纹只在相等维度上比较，不做新旧排序）。 */
export function sameMobileReadonlyFingerprint(
  a: MobileReadonlyFingerprint | null | undefined,
  b: MobileReadonlyFingerprint | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.contentGenerationId === b.contentGenerationId && a.businessRevision === b.businessRevision;
}

/**
 * 是否有业务变化需要发布：无上次成功指纹 → 视为需要；指纹不等（代际轮换或
 * 同代际修订变化）→ 需要。仅相等时不发布。
 */
export function hasMobileReadonlyBusinessChange(
  previous: MobileReadonlyFingerprint | null | undefined,
  current: MobileReadonlyFingerprint,
): boolean {
  return !sameMobileReadonlyFingerprint(previous, current);
}
