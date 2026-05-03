import { randomUUID } from 'node:crypto';
import { getDb } from './mongo.js';

const COLLECTION = 'subscriptions';

export type RebateStatus = 'none' | 'pending' | 'paid';
export type SubscriptionSource = 'wxpay' | 'mock';

export interface SubscriptionInput {
  openid: string;
  inviter_openid?: string;
  amount: number;            // cents
  paid_at: Date;
  period_start: Date;
  period_end: Date;
  transaction_id: string;
  out_trade_no: string;
  source: SubscriptionSource;
  rebate_status: RebateStatus;
}

export interface SubscriptionDoc extends SubscriptionInput {
  _id: string;
  rebate_paid_at?: Date;
  rebate_note?: string;
}

function fromDb(doc: Record<string, unknown>): SubscriptionDoc {
  return {
    _id: doc._id as string,
    openid: doc.openid as string,
    inviter_openid: doc.inviter_openid as string | undefined,
    amount: doc.amount as number,
    paid_at: doc.paid_at as Date,
    period_start: doc.period_start as Date,
    period_end: doc.period_end as Date,
    transaction_id: doc.transaction_id as string,
    out_trade_no: doc.out_trade_no as string,
    source: doc.source as SubscriptionSource,
    rebate_status: doc.rebate_status as RebateStatus,
    rebate_paid_at: doc.rebate_paid_at as Date | undefined,
    rebate_note: doc.rebate_note as string | undefined,
  };
}

export async function insertSubscription(input: SubscriptionInput): Promise<string> {
  const _id = randomUUID();
  await getDb().collection(COLLECTION).insertOne({ _id, ...input });
  return _id;
}

export async function findSubscriptionByTransactionId(
  transaction_id: string,
): Promise<SubscriptionDoc | null> {
  const doc = await getDb().collection(COLLECTION).findOne({ transaction_id });
  return doc ? fromDb(doc) : null;
}

export async function findRebatesByStatus(status: RebateStatus): Promise<SubscriptionDoc[]> {
  const docs = await getDb()
    .collection(COLLECTION)
    .find({ rebate_status: status }, { sortBy: 'paid_at', sortDir: 'desc' });
  return docs.map(fromDb);
}

export async function listAllSubscriptions(limit: number, offset: number): Promise<SubscriptionDoc[]> {
  const docs = await getDb()
    .collection(COLLECTION)
    .find({}, { limit, offset, sortBy: 'paid_at', sortDir: 'desc' });
  return docs.map(fromDb);
}

export async function markRebatePaid(_id: string, rebate_note: string): Promise<void> {
  const col = getDb().collection(COLLECTION);
  const existing = await col.findOne({ _id });
  if (!existing) throw new Error(`subscription ${_id} not found`);
  if (existing.rebate_status !== 'pending') {
    throw new Error(`subscription ${_id} rebate_status is not pending (was ${existing.rebate_status})`);
  }
  await col.updateOne(
    { _id },
    { $set: { rebate_status: 'paid', rebate_paid_at: new Date(), rebate_note } },
  );
}
