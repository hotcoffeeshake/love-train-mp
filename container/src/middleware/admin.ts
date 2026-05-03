import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

interface Options { token: string; uiPathSegment: string }

const plugin: FastifyPluginAsync<Options> = async (app, opts) => {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    // Exempt the static UI sub-path so the HTML page can load before token entry
    if (req.url.startsWith(`/admin/${opts.uiPathSegment}/`)) return;
    if (!opts.token) {
      reply.code(503).send({ error: 'ADMIN_DISABLED', message: 'ADMIN_TOKEN not configured' });
      return;
    }
    const got = (req.headers['x-admin-token'] as string | undefined)?.trim();
    if (got !== opts.token) {
      reply.code(403).send({ error: 'FORBIDDEN' });
      return;
    }
  });
};

export const adminAuthPlugin = fp(plugin, { name: 'admin-auth' });
