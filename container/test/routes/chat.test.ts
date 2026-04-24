import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
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
  __setDbForTest(client.db('test'));
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
  app.register(chatRoutes({ dailyQuota: 10 } as any, llm));
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
      payload: { messages: [{ role: 'user', content: '她不回我' }] },
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
      payload: { messages: [{ role: 'user', content: 'hi' }] },
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
      payload: { messages: [{ role: 'user', content: 'hi' }] },
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
      payload: { messages: [{ role: 'user', content: 'hi' }] },
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
