import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { bindInvite } from '../services/invite.js';

export const inviteRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: { code?: string } }>('/invite/bind', async (req, reply) => {
      const code = (req.body?.code ?? '').toString();
      const r = await bindInvite(cfg, req.openid, code);
      if (!r.ok) {
        reply.code(400);
        return r;
      }
      return r;
    });
  };
