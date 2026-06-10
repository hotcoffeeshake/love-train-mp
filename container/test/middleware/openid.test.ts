import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { openidPlugin } from '../../src/middleware/openid.js';

describe('openidPlugin', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  it('extracts openid from X-WX-OPENID header in prod', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify();
    await app.register(openidPlugin);
    app.get('/t', async (req) => ({ openid: req.openid }));
    const res = await app.inject({ method: 'GET', url: '/t', headers: { 'x-wx-openid': 'oABC' } });
    expect(res.json()).toEqual({ openid: 'oABC' });
    process.env = originalEnv;
  });

  it('returns 401 in prod without header', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify();
    await app.register(openidPlugin);
    app.get('/t', async (req) => ({ openid: req.openid }));
    const res = await app.inject({ method: 'GET', url: '/t' });
    expect(res.statusCode).toBe(401);
    process.env = originalEnv;
  });

  it('allows wxpay notify without openid header in prod', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify();
    await app.register(openidPlugin);
    app.post('/wxpay/notify', async () => ({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/wxpay/notify' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    process.env = originalEnv;
  });

  it('uses dev-openid in development', async () => {
    process.env.NODE_ENV = 'development';
    const app = Fastify();
    await app.register(openidPlugin);
    app.get('/t', async (req) => ({ openid: req.openid }));
    const res = await app.inject({ method: 'GET', url: '/t' });
    expect(res.json()).toEqual({ openid: 'dev-openid' });
    process.env = originalEnv;
  });
});
