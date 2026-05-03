import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { getOrCreateUser } from '../../src/db/users.js';
import { bindInvite } from '../../src/services/invite.js';

let mongod: MongoMemoryServer;
let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); });

const cfg = { invite: { rewardInviter: 5, rewardInvitee: 5, bindWindowDays: 7 } } as any;

describe('bindInvite service', () => {
  it('rejects invalid format', async () => {
    await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', 'lower')).toEqual({ ok: false, error: 'INVALID_CODE_FORMAT' });
  });

  it('rejects when code does not exist', async () => {
    await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', 'ZZZZZZ')).toEqual({ ok: false, error: 'CODE_NOT_FOUND' });
  });

  it('rejects self-invite', async () => {
    const a = await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', a.invite_code)).toEqual({ ok: false, error: 'SELF_INVITE' });
  });

  it('rejects when invitee already bound', async () => {
    const i = await getOrCreateUser('oI');
    const i2 = await getOrCreateUser('oI2');
    await getOrCreateUser('oV');
    await bindInvite(cfg, 'oV', i.invite_code);
    expect(await bindInvite(cfg, 'oV', i2.invite_code)).toEqual({ ok: false, error: 'ALREADY_BOUND' });
  });

  it('rejects when registered > windowDays ago', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await client.db('test').collection('users').insertOne({
      openid: 'oOld',
      createdAt: tenDaysAgo,
      lastActiveAt: tenDaysAgo,
      totalUses: 0,
      bonus_balance: 0,
      invite_code: 'OLDCDE',
    });
    const i = await getOrCreateUser('oI');
    expect(await bindInvite(cfg, 'oOld', i.invite_code)).toEqual({ ok: false, error: 'WINDOW_EXPIRED' });
  });

  it('rejects when invitee already paid', async () => {
    await getOrCreateUser('oV');
    await client.db('test').collection('users').updateOne({ openid: 'oV' }, { $set: { paid_until: new Date(Date.now() + 86400_000) } });
    const i = await getOrCreateUser('oI');
    expect(await bindInvite(cfg, 'oV', i.invite_code)).toEqual({ ok: false, error: 'WINDOW_EXPIRED' });
  });

  it('binds and rewards both parties', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oV');
    const r = await bindInvite(cfg, 'oV', i.invite_code);
    expect(r).toEqual({ ok: true, bonus_added: 5 });
    const v2 = await getOrCreateUser('oV');
    const i2 = await getOrCreateUser('oI');
    expect(v2.bonus_balance).toBe(5);
    expect(i2.bonus_balance).toBe(5);
    expect(v2.inviter_openid).toBe('oI');
  });
});
