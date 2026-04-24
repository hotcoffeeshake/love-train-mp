import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { getRemaining } from '../db/quota.js';
import { getOrCreateUser, updateProfile } from '../db/users.js';
import { todayBeijing } from '../utils/date.js';

export const authRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.get('/auth/me', async (req) => {
      const user = await getOrCreateUser(req.openid, req.unionid);
      const remainingUses = await getRemaining(req.openid, todayBeijing(), cfg.dailyQuota);

      return {
        openid: user.openid,
        nickname: user.nickname ?? '',
        avatarUrl: user.avatarUrl ?? '',
        remainingUses,
        totalUses: user.totalUses,
        isNewUser: user.isNewUser,
      };
    });

    app.post<{ Body: { nickname?: string; avatarUrl?: string } }>('/user/profile', async (req) => {
      await updateProfile(req.openid, req.body ?? {});
      return { ok: true };
    });
  };
