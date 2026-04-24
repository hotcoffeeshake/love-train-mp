import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { getRemaining } from '../db/quota.js';
import { todayBeijing } from '../utils/date.js';

export const userRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.get('/user/quota', async (req) => {
      const remainingUses = await getRemaining(req.openid, todayBeijing(), cfg.dailyQuota);

      const now = new Date();
      const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      beijing.setUTCHours(0, 0, 0, 0);
      beijing.setUTCDate(beijing.getUTCDate() + 1);
      const resetAt = new Date(beijing.getTime() - 8 * 60 * 60 * 1000).toISOString();

      return {
        remainingUses,
        dailyLimit: cfg.dailyQuota,
        resetAt,
      };
    });
  };
