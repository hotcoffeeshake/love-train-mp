import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import {
  insertSubscription,
  findSubscriptionByTransactionId,
  findRebatesByStatus,
  markRebatePaid,
  listAllSubscriptions,
} from '../../src/db/subscriptions.js';

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  __setDbForTest(new MongoAdapter(client.db('test')));
});
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('subscriptions').deleteMany({}); });

describe('subscriptions', () => {
  it('insertSubscription writes all fields and returns id', async () => {
    const id = await insertSubscription({
      openid: 'oA',
      inviter_openid: 'oI',
      amount: 2000,
      paid_at: new Date('2026-05-03T00:00:00Z'),
      period_start: new Date('2026-05-03T00:00:00Z'),
      period_end: new Date('2026-06-03T00:00:00Z'),
      transaction_id: 'wx-tx-123',
      out_trade_no: 'LT20260503-AAAAAA',
      source: 'mock',
      rebate_status: 'pending',
    });
    expect(typeof id).toBe('string');
    const all = await listAllSubscriptions(50, 0);
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe('mock');
    expect(all[0].rebate_status).toBe('pending');
  });

  it('findSubscriptionByTransactionId returns the row for idempotency', async () => {
    await insertSubscription({
      openid: 'oA', amount: 2000,
      paid_at: new Date(), period_start: new Date(), period_end: new Date(),
      transaction_id: 'wx-tx-X', out_trade_no: 'LT-1',
      source: 'wxpay', rebate_status: 'none',
    });
    const found = await findSubscriptionByTransactionId('wx-tx-X');
    expect(found?.openid).toBe('oA');
    expect(await findSubscriptionByTransactionId('not-here')).toBeNull();
  });

  it('findRebatesByStatus filters correctly', async () => {
    await insertSubscription({ openid: 'oA', inviter_openid: 'oI', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't1', out_trade_no: 'L1', source: 'mock', rebate_status: 'pending' });
    await insertSubscription({ openid: 'oB', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't2', out_trade_no: 'L2', source: 'mock', rebate_status: 'none' });
    const pending = await findRebatesByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].openid).toBe('oA');
    const none = await findRebatesByStatus('none');
    expect(none).toHaveLength(1);
    expect(none[0].openid).toBe('oB');
  });

  it('markRebatePaid writes status, paid_at, note', async () => {
    const id = await insertSubscription({ openid: 'oA', inviter_openid: 'oI', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't3', out_trade_no: 'L3', source: 'mock', rebate_status: 'pending' });
    await markRebatePaid(id, '¥6.6 微信转账 5月10日');
    const paid = await findRebatesByStatus('paid');
    expect(paid).toHaveLength(1);
    expect(paid[0].rebate_note).toBe('¥6.6 微信转账 5月10日');
    expect(paid[0].rebate_paid_at).toBeInstanceOf(Date);
  });

  it('markRebatePaid throws if status was not pending', async () => {
    const id = await insertSubscription({ openid: 'oA', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't4', out_trade_no: 'L4', source: 'mock', rebate_status: 'none' });
    await expect(markRebatePaid(id, 'note')).rejects.toThrow(/not pending/i);
  });
});
