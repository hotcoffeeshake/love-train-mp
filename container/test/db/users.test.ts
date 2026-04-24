import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { getOrCreateUser, incrementTotalUses, updateProfile } from '../../src/db/users.js';

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  __setDbForTest(client.db('test'));
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
