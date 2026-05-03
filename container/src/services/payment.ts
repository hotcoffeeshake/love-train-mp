import type { AppConfig } from '../config.js';
import { getOrCreateUser, setPaidUntil } from '../db/users.js';
import {
  insertSubscription,
  findSubscriptionByTransactionId,
  type SubscriptionSource,
} from '../db/subscriptions.js';

export interface RecordPaymentInput {
  openid: string;
  amount: number;            // cents
  transaction_id: string;
  out_trade_no: string;
  source: SubscriptionSource;
  months?: number;           // default 1
}

export interface RecordPaymentResult {
  subscription_id: string;
  paid_until: Date;
  rebate_status: 'none' | 'pending' | 'paid';
  duplicate?: boolean;
}

export async function recordPayment(
  cfg: AppConfig,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  // Idempotency
  const existing = await findSubscriptionByTransactionId(input.transaction_id);
  if (existing) {
    return {
      subscription_id: existing._id,
      paid_until: existing.period_end,
      rebate_status: existing.rebate_status,
      duplicate: true,
    };
  }

  const user = await getOrCreateUser(input.openid);
  const months = input.months ?? 1;
  const periodMs = cfg.subscription.periodDays * 24 * 60 * 60 * 1000;
  const now = new Date();
  const start =
    user.paid_until && user.paid_until.getTime() > now.getTime() ? user.paid_until : now;
  const end = new Date(start.getTime() + months * periodMs);

  const rebateStatus = user.inviter_openid ? 'pending' : 'none';

  const subInput: Parameters<typeof insertSubscription>[0] = {
    openid: input.openid,
    amount: input.amount,
    paid_at: now,
    period_start: start,
    period_end: end,
    transaction_id: input.transaction_id,
    out_trade_no: input.out_trade_no,
    source: input.source,
    rebate_status: rebateStatus,
  };
  if (user.inviter_openid) {
    subInput.inviter_openid = user.inviter_openid;
  }
  const _id = await insertSubscription(subInput);

  await setPaidUntil(input.openid, end);

  return { subscription_id: _id, paid_until: end, rebate_status: rebateStatus };
}
