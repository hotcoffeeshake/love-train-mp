import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { paymentRoutes } from '../../src/routes/payment.js';
import { getOrCreateUser } from '../../src/db/users.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); await client.db('test').collection('subscriptions').deleteMany({}); });

const mockCfg = { subscription: { amountCents: 2000, periodDays: 30 }, wxpay: { mode: 'mock' } } as any;

function build(cfg: any) {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(paymentRoutes(cfg));
  return app;
}

describe('POST /payment/create-order (mock mode)', () => {
  it('returns mode=mock + subscription_id + paid_until', async () => {
    await getOrCreateUser('oA');
    const app = build(mockCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('mock');
    expect(body.subscription_id).toBeDefined();
    expect(body.paid_until).toBeDefined();
  });
});
