import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { getOrCreateUser, incrementTotalUses, updateProfile } from '../../src/db/users.js';
import {
  findUserByInviteCode,
  bindInviter,
  decrementBonusAtomic,
  setPaidUntil,
} from '../../src/db/users.js';

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
});

describe('users', () => {
  it('creates new user on first call with isNewUser=true', async () => {
    const user = await getOrCreateUser('oA');
    expect(user.openid).toBe('oA');
    expect(user.totalUses).toBe(0);
    expect(user.isNewUser).toBe(true);
  });

  it('returns existing user with isNewUser=false', async () => {
    await getOrCreateUser('oA');
    const user = await getOrCreateUser('oA');
    expect(user.isNewUser).toBe(false);
  });

  it('updateProfile sets nickname and avatarUrl', async () => {
    await getOrCreateUser('oA');
    await updateProfile('oA', { nickname: '张三', avatarUrl: 'http://x.jpg' });
    const user = await getOrCreateUser('oA');
    expect(user.nickname).toBe('张三');
    expect(user.avatarUrl).toBe('http://x.jpg');
  });

  it('incrementTotalUses +1 each call', async () => {
    await getOrCreateUser('oA');
    await incrementTotalUses('oA');
    await incrementTotalUses('oA');
    const user = await getOrCreateUser('oA');
    expect(user.totalUses).toBe(2);
  });
});

describe('invite-code on user creation', () => {
  it('assigns a unique invite_code to new users', async () => {
    const u = await getOrCreateUser('oNew1');
    expect(u.invite_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(u.bonus_balance).toBe(0);
    expect(u.inviter_openid).toBeUndefined();
    expect(u.paid_until).toBeUndefined();
  });

  it('does not overwrite invite_code on subsequent calls', async () => {
    const a = await getOrCreateUser('oNew2');
    const b = await getOrCreateUser('oNew2');
    expect(b.invite_code).toBe(a.invite_code);
  });
});

describe('findUserByInviteCode', () => {
  it('returns user when code matches', async () => {
    const a = await getOrCreateUser('oA');
    const found = await findUserByInviteCode(a.invite_code);
    expect(found?.openid).toBe('oA');
  });

  it('returns null when no match', async () => {
    expect(await findUserByInviteCode('ZZZZZZ')).toBeNull();
  });
});

describe('bindInviter', () => {
  it('binds and rewards both parties on first call', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oV');
    const r = await bindInviter({
      inviteeOpenid: 'oV',
      inviterOpenid: 'oI',
      inviteeReward: 5,
      inviterReward: 5,
    });
    expect(r.ok).toBe(true);
    const v2 = await getOrCreateUser('oV');
    expect(v2.inviter_openid).toBe('oI');
    expect(v2.bonus_balance).toBe(5);
    const i2 = await getOrCreateUser('oI');
    expect(i2.bonus_balance).toBe(5);
  });

  it('refuses to re-bind a user who already has an inviter', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oI2');
    await getOrCreateUser('oV');
    await bindInviter({ inviteeOpenid: 'oV', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const r = await bindInviter({ inviteeOpenid: 'oV', inviterOpenid: 'oI2', inviteeReward: 5, inviterReward: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ALREADY_BOUND');
  });
});

describe('decrementBonusAtomic', () => {
  it('returns true and decrements when balance > 0', async () => {
    await getOrCreateUser('oI3');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI3', inviteeReward: 3, inviterReward: 0 });
    expect(await decrementBonusAtomic('oA')).toBe(true);
    const u = await getOrCreateUser('oA');
    expect(u.bonus_balance).toBe(2);
  });

  it('returns false when balance is 0', async () => {
    await getOrCreateUser('oZero');
    expect(await decrementBonusAtomic('oZero')).toBe(false);
  });
});

describe('setPaidUntil', () => {
  it('writes the timestamp', async () => {
    await getOrCreateUser('oP');
    const until = new Date('2026-06-03T00:00:00Z');
    await setPaidUntil('oP', until);
    const u = await getOrCreateUser('oP');
    expect(u.paid_until?.toISOString()).toBe(until.toISOString());
  });
});
