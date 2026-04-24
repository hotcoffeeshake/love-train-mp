import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { getRemaining, getUsage, incrementUsage } from '../../src/db/quota.js';

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
  await client.db('test').collection('daily_usage').deleteMany({});
});

describe('quota', () => {
  it('returns 0 for new openid', async () => {
    expect(await getUsage('oA', '2026-04-24')).toBe(0);
  });

  it('increments and reads', async () => {
    await incrementUsage('oA', '2026-04-24');
    await incrementUsage('oA', '2026-04-24');
    expect(await getUsage('oA', '2026-04-24')).toBe(2);
  });

  it('getRemaining subtracts from daily quota', async () => {
    await incrementUsage('oB', '2026-04-24');
    expect(await getRemaining('oB', '2026-04-24', 10)).toBe(9);
  });

  it('getRemaining clamps at 0', async () => {
    for (let i = 0; i < 12; i += 1) {
      await incrementUsage('oC', '2026-04-24');
    }
    expect(await getRemaining('oC', '2026-04-24', 10)).toBe(0);
  });

  it('different dates isolated', async () => {
    await incrementUsage('oD', '2026-04-24');
    expect(await getUsage('oD', '2026-04-25')).toBe(0);
  });
});
