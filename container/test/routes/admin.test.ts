import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { adminRoutes } from '../../src/routes/admin.js';
import { adminAuthPlugin } from '../../src/middleware/admin.js';
import { getOrCreateUser, bindInviter } from '../../src/db/users.js';
import { recordPayment } from '../../src/services/payment.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
});

const cfg = {
  admin: { token: 'tok', uiPathSegment: 'ui-x9k2' },
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: { mode: 'mock' },
} as any;

function build() {
  const app = Fastify();
  app.register(adminAuthPlugin, { token: cfg.admin.token, uiPathSegment: cfg.admin.uiPathSegment });
  app.register(adminRoutes(cfg));
  return app;
}

const tok = { 'x-admin-token': 'tok' };

describe('admin routes', () => {
  it('GET /admin/rebates lists pending', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx1', out_trade_no: 'L1', source: 'mock' });
    const res = await build().inject({ url: '/admin/rebates?status=pending', headers: tok });
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].paid_user.invite_code).toBeDefined();
    expect(body[0].inviter.invite_code).toBeDefined();
    expect(body[0].amount).toBe(2000);
  });

  it('POST /admin/rebates/:id/mark-paid moves to paid', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const r = await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx2', out_trade_no: 'L2', source: 'mock' });
    const app = build();
    const m = await app.inject({
      method: 'POST', url: `/admin/rebates/${r.subscription_id}/mark-paid`,
      headers: { ...tok, 'content-type': 'application/json' },
      payload: { rebate_note: '¥6.6 微信转账' },
    });
    expect(m.statusCode).toBe(200);
    const after = await app.inject({ url: '/admin/rebates?status=paid', headers: tok });
    expect(after.json()[0].rebate_note).toBe('¥6.6 微信转账');
  });

  it('GET /admin/subscriptions lists newest first', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx3', out_trade_no: 'L3', source: 'mock' });
    const res = await build().inject({ url: '/admin/subscriptions', headers: tok });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].source).toBe('mock');
  });

  it('GET /admin/users?invite_code= returns user + referrals', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oA'); await getOrCreateUser('oB');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await bindInviter({ inviteeOpenid: 'oB', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const res = await build().inject({ url: `/admin/users?invite_code=${i.invite_code}`, headers: tok });
    const body = res.json();
    expect(body.user.openid).toBe('oI');
    expect(body.referrals).toHaveLength(2);
  });
});
