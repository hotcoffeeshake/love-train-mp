import { randomUUID } from 'node:crypto';
import { getDb } from './mongo.js';

const COLLECTION = 'payment_orders';

export type PaymentOrderSource = 'virtual';
export type PaymentOrderStatus = 'pending' | 'paid';

export interface PaymentOrderInput {
  openid: string;
  amount: number;
  months: number;
  out_trade_no: string;
  source: PaymentOrderSource;
}

export interface PaymentOrderDoc extends PaymentOrderInput {
  _id: string;
  status: PaymentOrderStatus;
  created_at: Date;
  paid_at?: Date;
}

function fromDb(doc: Record<string, unknown>): PaymentOrderDoc {
  return {
    _id: doc._id as string,
    openid: doc.openid as string,
    amount: doc.amount as number,
    months: doc.months as number,
    out_trade_no: doc.out_trade_no as string,
    source: doc.source as PaymentOrderSource,
    status: doc.status as PaymentOrderStatus,
    created_at: doc.created_at as Date,
    paid_at: doc.paid_at as Date | undefined,
  };
}

export async function insertPaymentOrder(input: PaymentOrderInput): Promise<string> {
  const _id = randomUUID();
  await getDb().collection(COLLECTION).insertOne({
    _id,
    ...input,
    status: 'pending',
    created_at: new Date(),
  });
  return _id;
}

export async function findPaymentOrderByOutTradeNo(
  out_trade_no: string,
): Promise<PaymentOrderDoc | null> {
  const doc = await getDb().collection(COLLECTION).findOne({ out_trade_no });
  return doc ? fromDb(doc) : null;
}

export async function markPaymentOrderPaid(out_trade_no: string): Promise<void> {
  await getDb()
    .collection(COLLECTION)
    .updateOne({ out_trade_no }, { $set: { status: 'paid', paid_at: new Date() } });
}
