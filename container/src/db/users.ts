import { getDb } from './mongo.js';

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
}

export async function getOrCreateUser(openid: string, unionid?: string): Promise<UserDoc> {
  const col = getDb().collection(COLLECTION);
  const now = new Date();
  const existing = await col.findOne({ openid });

  if (existing) {
    await col.updateOne({ openid }, { $set: { lastActiveAt: now } });
    return {
      openid: existing.openid as string,
      unionid: existing.unionid as string | undefined,
      nickname: existing.nickname as string | undefined,
      avatarUrl: existing.avatarUrl as string | undefined,
      totalUses: (existing.totalUses as number | undefined) ?? 0,
      createdAt: (existing.createdAt as Date | undefined) ?? now,
      lastActiveAt: now,
      isNewUser: false,
    };
  }

  await col.insertOne({
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
  });

  return {
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
    isNewUser: true,
  };
}

export async function updateProfile(
  openid: string,
  data: { nickname?: string; avatarUrl?: string },
): Promise<void> {
  const set: Record<string, unknown> = {};

  if (data.nickname !== undefined) {
    set.nickname = data.nickname;
  }
  if (data.avatarUrl !== undefined) {
    set.avatarUrl = data.avatarUrl;
  }
  if (Object.keys(set).length === 0) {
    return;
  }

  await getDb().collection(COLLECTION).updateOne({ openid }, { $set: set });
}

export async function incrementTotalUses(openid: string): Promise<void> {
  await getDb().collection(COLLECTION).updateOne({ openid }, { $inc: { totalUses: 1 } });
}
