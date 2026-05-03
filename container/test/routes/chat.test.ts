import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import type { LLMProvider } from '../../src/llm/types.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { chatRoutes } from '../../src/routes/chat.js';

class FakeLLM implements LLMProvider {
  name = 'fake';
  lastMessages: any[] = [];
  mockReply = 'default reply';

  async chat(messages: any[]) {
    this.lastMessages = messages;
    return this.mockReply;
  }
}

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
  const db = client.db('test');
  await db.collection('users').deleteMany({});
  await db.collection('daily_usage').deleteMany({});
});

function buildApp(llm: FakeLLM) {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(
    chatRoutes(
      {
        dailyQuota: 10, // legacy, still read in some places
        dailyLimit: { free: 10, paid: 30 },
      } as any,
      llm,
    ),
  );
  return app;
}

describe('POST /chat', () => {
  it('returns LLM reply and remainingUses', async () => {
    const llm = new FakeLLM();
    llm.mockReply = '兄弟你稳住';
    const app = buildApp(llm);
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [{ role: 'user', content: '她不回我' }], stream: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: '兄弟你稳住', remainingUses: 9 });
  });

  it('prepends system prompt', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    expect(llm.lastMessages[0].role).toBe('system');
  });

  it('returns 429 when quota exceeded', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    const { incrementUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');

    for (let i = 0; i < 10; i += 1) {
      await incrementUsage('oA', todayBeijing());
    }

    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    expect(res.statusCode).toBe(429);
  });

  it('does NOT increment on LLM failure', async () => {
    const llm = new FakeLLM();
    llm.chat = async () => {
      throw new Error('boom');
    };
    const app = buildApp(llm);
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    expect(res.statusCode).toBe(500);

    const { getUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    expect(await getUsage('oA', todayBeijing())).toBe(0);
  });

  it('rejects empty messages', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

import { bindInviter, getOrCreateUser } from '../../src/db/users.js';

describe('POST /chat with bonus_balance', () => {
  it('consumes bonus_balance before daily quota', async () => {
    const llm = new FakeLLM();
    llm.mockReply = 'ok';
    const app = buildApp(llm);
    // Seed user with bonus_balance=2 via bind
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({
      inviteeOpenid: 'oA',
      inviterOpenid: 'oI',
      inviteeReward: 2,
      inviterReward: 0,
    });
    // First call should consume bonus, daily_usage stays 0
    await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oA' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    const { getUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    expect(await getUsage('oA', todayBeijing())).toBe(0);
    const u = await getOrCreateUser('oA');
    expect(u.bonus_balance).toBe(1); // 2 - 1
  });

  it('falls back to daily_usage after bonus exhausted', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    // user with no bonus
    await getOrCreateUser('oNoB');
    await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oNoB' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    const { getUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    expect(await getUsage('oNoB', todayBeijing())).toBe(1);
  });

  it('uses paid daily limit when paid_until > now', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    await getOrCreateUser('oP');
    const { setPaidUntil } = await import('../../src/db/users.js');
    await setPaidUntil('oP', new Date(Date.now() + 86400_000));
    // Pre-fill 10 daily usage; should still be allowed because limit=30
    const { incrementUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    for (let i = 0; i < 10; i += 1) await incrementUsage('oP', todayBeijing());
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      headers: { 'x-wx-openid': 'oP' },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    expect(res.statusCode).toBe(200);
  });
});
