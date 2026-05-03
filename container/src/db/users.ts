import { getDb } from './mongo.js';
import { generateInviteCode } from '../utils/invite-code.js';

const COLLECTION = 'users';

export interface UserDoc {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
  totalUses: number;
  createdAt: Date;
  lastActiveAt: Date;
  isNewUser: boolean;
  // ── new fields (Invite + Subscription) ────────────
  invite_code: string;
  inviter_openid?: string;
  invited_at?: Date;
  bonus_balance: number;
  paid_until?: Date;
}

export type BindFailure = 'ALREADY_BOUND';

export interface BindResult {
  ok: boolean;
  reason?: BindFailure;
}

async function generateUniqueInviteCode(maxRetries = 5): Promise<string> {
  const col = getDb().collection(COLLECTION);
  for (let i = 0; i < maxRetries; i += 1) {
    const code = generateInviteCode();
    const existing = await col.findOne({ invite_code: code });
    if (!existing) return code;
  }
  throw new Error('invite_code generation collision');
}

export async function getOrCreateUser(openid: string, unionid?: string): Promise<UserDoc> {
  const col = getDb().collection(COLLECTION);
  const now = new Date();
  const existing = await col.findOne({ openid });

  if (existing) {
    // Backfill: 老用户在 T2 之前注册，DB 里没有 invite_code，按需生成一个
    let inviteCode = existing.invite_code as string | undefined;
    const set: Record<string, unknown> = { lastActiveAt: now };
    if (!inviteCode) {
      inviteCode = await generateUniqueInviteCode();
      set.invite_code = inviteCode;
    }
    await col.updateOne({ openid }, { $set: set });
    return {
      openid: existing.openid as string,
      unionid: existing.unionid as string | undefined,
      nickname: existing.nickname as string | undefined,
      avatarUrl: existing.avatarUrl as string | undefined,
      totalUses: (existing.totalUses as number | undefined) ?? 0,
      createdAt: (existing.createdAt as Date | undefined) ?? now,
      lastActiveAt: now,
      isNewUser: false,
      invite_code: inviteCode,
      inviter_openid: existing.inviter_openid as string | undefined,
      invited_at: existing.invited_at as Date | undefined,
      bonus_balance: (existing.bonus_balance as number | undefined) ?? 0,
      paid_until: existing.paid_until as Date | undefined,
    };
  }

  const inviteCode = await generateUniqueInviteCode();
  await col.insertOne({
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
    invite_code: inviteCode,
    bonus_balance: 0,
  });

  return {
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
    isNewUser: true,
    invite_code: inviteCode,
    bonus_balance: 0,
  };
}

export async function updateProfile(
  openid: string,
  data: { nickname?: string; avatarUrl?: string },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (data.nickname !== undefined) set.nickname = data.nickname;
  if (data.avatarUrl !== undefined) set.avatarUrl = data.avatarUrl;
  if (Object.keys(set).length === 0) return;
  await getDb().collection(COLLECTION).updateOne({ openid }, { $set: set });
}

export async function incrementTotalUses(openid: string): Promise<void> {
  await getDb().collection(COLLECTION).updateOne({ openid }, { $inc: { totalUses: 1 } });
}

export async function findUserByInviteCode(code: string): Promise<UserDoc | null> {
  const doc = await getDb().collection(COLLECTION).findOne({ invite_code: code });
  if (!doc) return null;
  return {
    openid: doc.openid as string,
    unionid: doc.unionid as string | undefined,
    nickname: doc.nickname as string | undefined,
    avatarUrl: doc.avatarUrl as string | undefined,
    totalUses: (doc.totalUses as number | undefined) ?? 0,
    createdAt: doc.createdAt as Date,
    lastActiveAt: doc.lastActiveAt as Date,
    isNewUser: false,
    invite_code: doc.invite_code as string,
    inviter_openid: doc.inviter_openid as string | undefined,
    invited_at: doc.invited_at as Date | undefined,
    bonus_balance: (doc.bonus_balance as number | undefined) ?? 0,
    paid_until: doc.paid_until as Date | undefined,
  };
}

export interface BindParams {
  inviteeOpenid: string;
  inviterOpenid: string;
  inviteeReward: number;
  inviterReward: number;
}

/**
 * Two-step bind:
 *  1) Read-then-conditionally-update the invitee where inviter_openid is missing.
 *  2) If step 1 succeeded, $inc inviter's bonus_balance.
 */
export async function bindInviter(p: BindParams): Promise<BindResult> {
  const col = getDb().collection(COLLECTION);
  const now = new Date();

  const before = await col.findOne({ openid: p.inviteeOpenid });
  if (!before) return { ok: false, reason: 'ALREADY_BOUND' };
  if (before.inviter_openid) return { ok: false, reason: 'ALREADY_BOUND' };

  await col.updateOne(
    { openid: p.inviteeOpenid, inviter_openid: { $exists: false } as unknown as string },
    {
      $set: { inviter_openid: p.inviterOpenid, invited_at: now },
      $inc: { bonus_balance: p.inviteeReward },
    },
  );

  await col.updateOne(
    { openid: p.inviterOpenid },
    { $inc: { bonus_balance: p.inviterReward } },
  );

  return { ok: true };
}

/**
 * Read-then-conditional decrement. Returns true if a bonus point was consumed.
 * Acceptable race window for v1: at scale ≤ 50 users a worst-case extra free
 * message is negligible.
 */
export async function decrementBonusAtomic(openid: string): Promise<boolean> {
  const col = getDb().collection(COLLECTION);
  const u = await col.findOne({ openid });
  const balance = (u?.bonus_balance as number | undefined) ?? 0;
  if (balance <= 0) return false;
  await col.updateOne({ openid }, { $inc: { bonus_balance: -1 } });
  return true;
}

export async function setPaidUntil(openid: string, until: Date): Promise<void> {
  await getDb().collection(COLLECTION).updateOne({ openid }, { $set: { paid_until: until } });
}
