import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { inviteRoutes } from '../../src/routes/invite.js';
import { getOrCreateUser } from '../../src/db/users.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); });

const cfg = { invite: { rewardInviter: 5, rewardInvitee: 5, bindWindowDays: 7 } } as any;

function buildApp() {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(inviteRoutes(cfg));
  return app;
}

describe('POST /invite/bind', () => {
  it('returns ok and bonus on success', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oV');
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/invite/bind',
      headers: { 'x-wx-openid': 'oV' },
      payload: { code: i.invite_code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, bonus_added: 5 });
  });

  it('returns 400 with error code on invalid', async () => {
    await getOrCreateUser('oA');
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/invite/bind',
      headers: { 'x-wx-openid': 'oA' },
      payload: { code: 'lower' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'INVALID_CODE_FORMAT' });
  });
});
