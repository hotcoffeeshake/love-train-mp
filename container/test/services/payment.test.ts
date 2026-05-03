import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { getOrCreateUser, bindInviter } from '../../src/db/users.js';
import { recordPayment } from '../../src/services/payment.js';
import { findRebatesByStatus, listAllSubscriptions } from '../../src/db/subscriptions.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
});

const cfg = { subscription: { amountCents: 2000, periodDays: 30 }, wxpay: { mode: 'mock' } } as any;

describe('recordPayment', () => {
  it('writes subscription with rebate_status=none when no inviter', async () => {
    await getOrCreateUser('oA');
    const r = await recordPayment(cfg, {
      openid: 'oA', amount: 2000, transaction_id: 'mock-1', out_trade_no: 'LT-1', source: 'mock',
    });
    expect(r.subscription_id).toBeDefined();
    expect(r.paid_until).toBeInstanceOf(Date);
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].rebate_status).toBe('none');
    expect(subs[0].inviter_openid).toBeUndefined();
  });

  it('writes subscription with rebate_status=pending and inviter snapshot', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await recordPayment(cfg, {
      openid: 'oA', amount: 2000, transaction_id: 'mock-2', out_trade_no: 'LT-2', source: 'mock',
    });
    const pending = await findRebatesByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].inviter_openid).toBe('oI');
  });

  it('updates user.paid_until forward', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'mock-3', out_trade_no: 'LT-3', source: 'mock' });
    const u = await getOrCreateUser('oA');
    expect(u.paid_until).toBeInstanceOf(Date);
    expect(u.paid_until!.getTime()).toBeGreaterThan(Date.now() + 25 * 86400_000);
  });

  it('extends from current paid_until when stacking', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 't1', out_trade_no: 'L1', source: 'mock' });
    const u1 = await getOrCreateUser('oA');
    const first = u1.paid_until!.getTime();
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 't2', out_trade_no: 'L2', source: 'mock' });
    const u2 = await getOrCreateUser('oA');
    expect(u2.paid_until!.getTime()).toBeGreaterThan(first + 25 * 86400_000);
  });

  it('is idempotent on transaction_id', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx', out_trade_no: 'L1', source: 'wxpay' });
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx', out_trade_no: 'L1', source: 'wxpay' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
  });
});
