import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    openid: string;
    unionid?: string;
    appid?: string;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('openid', '');
  app.decorateRequest('unionid', undefined);
  app.decorateRequest('appid', undefined);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') {
      return;
    }

    const openid = (req.headers['x-wx-openid'] as string | undefined)?.trim();
    const unionid = (req.headers['x-wx-unionid'] as string | undefined)?.trim();
    const appid = (req.headers['x-wx-appid'] as string | undefined)?.trim();

    if (openid) {
      req.openid = openid;
      req.unionid = unionid;
      req.appid = appid;
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      req.openid = process.env.DEV_OPENID ?? 'dev-openid';
      return;
    }

    reply.code(401).send({ error: 'MISSING_OPENID', message: 'X-WX-OPENID header required' });
  });
};

export const openidPlugin = fp(plugin, { name: 'openid' });
