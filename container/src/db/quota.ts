import { getDb } from './mongo.js';

const COLLECTION = 'daily_usage';

export async function getUsage(openid: string, date: string): Promise<number> {
  const doc = await getDb().collection(COLLECTION).findOne({ openid, date });
  return (doc?.count as number | undefined) ?? 0;
}

export async function incrementUsage(openid: string, date: string): Promise<void> {
  const expireAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await getDb().collection(COLLECTION).updateOne(
    { openid, date },
    {
      $inc: { count: 1 },
      $setOnInsert: { openid, date, expireAt },
    },
    { upsert: true },
  );
}

export async function getRemaining(openid: string, date: string, dailyQuota: number): Promise<number> {
  const used = await getUsage(openid, date);
  return Math.max(0, dailyQuota - used);
}
