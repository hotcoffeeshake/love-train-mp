import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { getRemaining } from '../db/quota.js';
import { getOrCreateUser, updateProfile } from '../db/users.js';
import { codeToSession } from '../services/wechat-session.js';
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

    app.post<{ Body: { code?: string } }>('/auth/jscode2session', async (req, reply) => {
      const code = req.body?.code?.trim();
      if (!code) {
        return reply.code(400).send({ error: 'MISSING_CODE', message: 'code is required' });
      }
      if (!cfg.wxAppId || !cfg.wxAppSecret) {
        return reply.code(500).send({
          error: 'WX_CREDENTIALS_NOT_CONFIGURED',
          message: 'WX_APPID / WX_APPSECRET env vars not set on server',
        });
      }
      let wxResp: { openid: string; unionid?: string };
      try {
        wxResp = await codeToSession(cfg, code);
      } catch (e) {
        if ((e as Error & { code?: string }).code === 'WX_LOGIN_FAILED') {
          return reply.code(401).send({
            error: 'WX_LOGIN_FAILED',
            message: (e as Error).message,
            errcode: (e as Error & { errcode?: number }).errcode,
          });
        }
        if ((e as Error).message === 'WX_CREDENTIALS_NOT_CONFIGURED') {
          return reply.code(500).send({
            error: 'WX_CREDENTIALS_NOT_CONFIGURED',
            message: 'WX_APPID / WX_APPSECRET env vars not set on server',
          });
        }
        return reply.code(502).send({
          error: 'WX_API_UNREACHABLE',
          message: (e as Error).message ?? 'failed to reach api.weixin.qq.com',
        });
      }
      return { openid: wxResp.openid, unionid: wxResp.unionid ?? null };
    });
  };
