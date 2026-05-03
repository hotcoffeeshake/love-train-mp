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
      const todayLimit =
        user.paid_until && user.paid_until.getTime() > Date.now()
          ? cfg.dailyLimit.paid
          : cfg.dailyLimit.free;
      const remainingUses = await getRemaining(req.openid, todayBeijing(), todayLimit);

      let inviter: { invite_code: string } | null = null;
      if (user.inviter_openid) {
        const inv = await getOrCreateUser(user.inviter_openid);
        inviter = { invite_code: inv.invite_code };
      }

      return {
        openid: user.openid,
        nickname: user.nickname ?? '',
        avatarUrl: user.avatarUrl ?? '',
        remainingUses,
        today_limit: todayLimit,
        totalUses: user.totalUses,
        isNewUser: user.isNewUser,
        is_paid: !!(user.paid_until && user.paid_until.getTime() > Date.now()),
        paid_until: user.paid_until?.toISOString() ?? null,
        invite_code: user.invite_code,
        inviter,
        bonus_balance: user.bonus_balance,
      };
    });

    app.post<{ Body: { nickname?: string; avatarUrl?: string } }>('/user/profile', async (req) => {
      await updateProfile(req.openid, req.body ?? {});
      return { ok: true };
    });
  };
