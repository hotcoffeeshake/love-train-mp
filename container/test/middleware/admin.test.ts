import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminAuthPlugin } from '../../src/middleware/admin.js';

function build(token: string, uiPathSegment = 'ui-x9k2') {
  const app = Fastify();
  app.register(adminAuthPlugin, { token, uiPathSegment });
  app.get('/admin/anything', async () => ({ ok: true }));
  app.get('/admin/ui-x9k2/admin.html', async () => ({ ok: true }));
  app.get('/public', async () => ({ ok: true }));
  return app;
}

describe('adminAuthPlugin', () => {
  it('allows requests with matching X-Admin-Token to /admin/*', async () => {
    const res = await build('s3cret').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 's3cret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /admin/* without token', async () => {
    const res = await build('s3cret').inject({ url: '/admin/anything' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects /admin/* with wrong token', async () => {
    const res = await build('s3cret').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not interfere with non-/admin routes', async () => {
    const res = await build('s3cret').inject({ url: '/public' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 if no admin token configured', async () => {
    const res = await build('').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 'anything' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('exempts the static UI path segment', async () => {
    const res = await build('s3cret').inject({ url: '/admin/ui-x9k2/admin.html' });
    expect(res.statusCode).toBe(200);
  });
});
