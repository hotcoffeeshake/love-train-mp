import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { wxpayRoutes } from '../../src/routes/wxpay.js';
import { getOrCreateUser } from '../../src/db/users.js';
import { listAllSubscriptions } from '../../src/db/subscriptions.js';

vi.mock('../../src/services/wxpay-client.js', async () => {
  return {
    verifyAndDecryptNotify: vi.fn(),
    createWxpayPrepayOrder: vi.fn(),
  };
});
import { verifyAndDecryptNotify } from '../../src/services/wxpay-client.js';

let mongod: MongoMemoryServer;
let client: MongoClient;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  __setDbForTest(new MongoAdapter(client.db('test')));
});
afterAll(async () => {
  await client.close();
  await mongod.stop();
  __resetDbForTest();
});
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
  vi.clearAllMocks();
});

const cfg = {
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: {
    mode: 'real',
    appid: 'wx',
    mchid: 'm',
    apiV3Key: 'k',
    certSerial: 's',
    privateKeyPath: '/tmp/k.pem',
    notifyUrl: 'https://x/notify',
  },
} as any;

function build() {
  const app = Fastify();
  // CRITICAL: register a JSON content-type parser that returns the raw string for /wxpay/notify
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url === '/wxpay/notify') {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.register(wxpayRoutes(cfg));
  return app;
}

describe('POST /wxpay/notify', () => {
  it('returns 401 when verification fails', async () => {
    (verifyAndDecryptNotify as any).mockRejectedValue(new Error('bad sig'));
    const res = await build().inject({
      method: 'POST',
      url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x', 'content-type': 'application/json' },
      payload: '{"any":"thing"}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('writes subscription and returns SUCCESS on valid notify', async () => {
    await getOrCreateUser('oA');
    (verifyAndDecryptNotify as any).mockResolvedValue({
      out_trade_no: 'LT-1',
      transaction_id: 'wx-tx-1',
      openid: 'oA',
      amount_cents: 2000,
    });
    const res = await build().inject({
      method: 'POST',
      url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x', 'content-type': 'application/json' },
      payload: '{"any":"thing"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 'SUCCESS', message: 'OK' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].source).toBe('wxpay');
  });

  it('is idempotent on duplicate notify', async () => {
    await getOrCreateUser('oA');
    (verifyAndDecryptNotify as any).mockResolvedValue({
      out_trade_no: 'LT-1',
      transaction_id: 'wx-tx-1',
      openid: 'oA',
      amount_cents: 2000,
    });
    const app = build();
    await app.inject({
      method: 'POST',
      url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x', 'content-type': 'application/json' },
      payload: '{}',
    });
    await app.inject({
      method: 'POST',
      url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x', 'content-type': 'application/json' },
      payload: '{}',
    });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
  });
});
