import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { findUserByInviteCode, getOrCreateUser, setPaidUntil } from '../db/users.js';
import {
  findRebatesByStatus,
  findSubscriptionByOutTradeNo,
  listAllSubscriptions,
  listSubscriptionsByOpenid,
  markRebatePaid,
  type RebateStatus,
} from '../db/subscriptions.js';
import { getDb } from '../db/mongo.js';
import { recordPayment } from '../services/payment.js';

export const adminRoutes =
  (_cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { status?: RebateStatus } }>(
      '/admin/rebates',
      async (req) => {
        const status = (req.query.status ?? 'pending') as RebateStatus;
        const list = await findRebatesByStatus(status);
        const out = await Promise.all(
          list.map(async (s) => {
            const paidUser = await getOrCreateUser(s.openid);
            const inviter = s.inviter_openid ? await getOrCreateUser(s.inviter_openid) : null;
            return {
              subscription_id: s._id,
              paid_user: { openid: paidUser.openid, invite_code: paidUser.invite_code, paid_at: s.paid_at },
              inviter: inviter ? { openid: inviter.openid, invite_code: inviter.invite_code } : null,
              amount: s.amount,
              source: s.source,
              rebate_status: s.rebate_status,
              rebate_paid_at: s.rebate_paid_at ?? null,
              rebate_note: s.rebate_note ?? null,
            };
          }),
        );
        return out;
      },
    );

    app.post<{ Params: { id: string }; Body: { rebate_note?: string } }>(
      '/admin/rebates/:id/mark-paid',
      async (req, reply) => {
        try {
          await markRebatePaid(req.params.id, req.body?.rebate_note ?? '');
          return { ok: true };
        } catch (err) {
          reply.code(400);
          return { ok: false, error: (err as Error).message };
        }
      },
    );

    app.get<{ Querystring: { limit?: string; offset?: string } }>(
      '/admin/subscriptions',
      async (req) => {
        const limit = Math.min(200, Number(req.query.limit ?? 50));
        const offset = Math.max(0, Number(req.query.offset ?? 0));
        return listAllSubscriptions(limit, offset);
      },
    );

    app.get<{ Querystring: { invite_code?: string; openid?: string } }>(
      '/admin/users',
      async (req, reply) => {
        let user = null;
        if (req.query.invite_code) user = await findUserByInviteCode(req.query.invite_code);
        else if (req.query.openid) user = await getOrCreateUser(req.query.openid);
        if (!user) { reply.code(404); return { error: 'NOT_FOUND' }; }
        // referrals = anyone whose inviter_openid == user.openid
        const referralDocs = await getDb()
          .collection('users')
          .find({ inviter_openid: user.openid });
        return {
          user: { openid: user.openid, invite_code: user.invite_code, paid_until: user.paid_until ?? null, bonus_balance: user.bonus_balance },
          referrals: referralDocs.map((d) => ({ openid: d.openid, invited_at: d.invited_at })),
        };
      },
    );

    app.get('/admin/health', async () => ({
      ok: true,
      now: new Date().toISOString(),
    }));

    app.get('/admin/config-snapshot', async () => {
      const desc = (v: string | undefined | null) =>
        v ? { set: true, len: v.length, head: v.slice(0, 4), tail: v.slice(-4) } : { set: false };
      return {
        nodeEnv: _cfg.nodeEnv,
        wx: { appid: desc(_cfg.wxAppId), appSecret: desc(_cfg.wxAppSecret) },
        cloudbaseEnvId: desc(_cfg.cloudbaseEnvId),
        subscription: _cfg.subscription,
        wxpay: { mode: _cfg.wxpay.mode, appid: desc(_cfg.wxpay.appid), notifyUrl: _cfg.wxpay.notifyUrl },
        virtualPayment: {
          mode: _cfg.virtualPayment.mode,
          env: _cfg.virtualPayment.env,
          currencyType: _cfg.virtualPayment.currencyType,
          goodsPrice: _cfg.virtualPayment.goodsPrice,
          offerId: desc(_cfg.virtualPayment.offerId),
          appKey: desc(_cfg.virtualPayment.appKey),
          productId: desc(_cfg.virtualPayment.productId),
        },
        wechatMessage: { token: desc(_cfg.wechatMessage.token) },
        admin: { uiPathSegment: _cfg.admin.uiPathSegment, tokenSet: !!_cfg.admin.token },
      };
    });

    /**
     * 手动开通付费（运营线下收款后调用）
     * body: { invite_code: 'A8K2P9' }  或  { openid: 'oXxx' }
     *       + months?: number (默认 1)
     *       + amount?: number (单位分，默认 cfg.subscription.amountCents)
     *       + payment_ref?: string (微信转账备注，用于审计)
     */
    app.post<{
      Body: {
        invite_code?: string;
        openid?: string;
        months?: number;
        amount?: number;
        payment_ref?: string;
      };
    }>('/admin/grant-paid', async (req, reply) => {
      const body = req.body ?? {};
      let user = null;
      if (body.invite_code) user = await findUserByInviteCode(body.invite_code);
      else if (body.openid) user = await getOrCreateUser(body.openid);
      if (!user) {
        reply.code(404);
        return { ok: false, error: 'USER_NOT_FOUND' };
      }
      const months = Math.max(1, Math.min(12, body.months ?? 1));
      const amount = body.amount ?? _cfg.subscription.amountCents;
      const txnId = `manual-${randomUUID().slice(0, 12)}`;
      const r = await recordPayment(_cfg, {
        openid: user.openid,
        amount,
        transaction_id: txnId,
        out_trade_no: txnId,
        source: 'manual',
        months,
      });
      return {
        ok: true,
        subscription_id: r.subscription_id,
        paid_until: r.paid_until.toISOString(),
        rebate_status: r.rebate_status,
        opened_for: { openid: user.openid, invite_code: user.invite_code },
        payment_ref: body.payment_ref ?? null,
      };
    });

    /**
     * 撤销某笔订阅，并重算用户 paid_until。
     * 删除 subscriptions 中 out_trade_no 对应那条；
     * 重新基于该用户剩余订阅的最大 period_end 写回 user.paid_until，
     * 若无剩余订阅则置为 epoch（视为非会员）。
     * payment_orders 那行保留作审计，不动。
     * body: { out_trade_no: 'LT...' }
     */
    app.post<{ Body: { out_trade_no?: string } }>(
      '/admin/revoke-subscription',
      async (req, reply) => {
        const outTradeNo = req.body?.out_trade_no?.trim();
        if (!outTradeNo) {
          reply.code(400);
          return { ok: false, error: 'MISSING_OUT_TRADE_NO' };
        }
        const sub = await findSubscriptionByOutTradeNo(outTradeNo);
        if (!sub) {
          reply.code(404);
          return { ok: false, error: 'SUBSCRIPTION_NOT_FOUND' };
        }
        const openid = sub.openid;
        const before = await getOrCreateUser(openid);

        await getDb().collection('subscriptions').deleteMany({ _id: sub._id });

        const remaining = await listSubscriptionsByOpenid(openid, 500, 0);
        const maxEnd = remaining.reduce<Date | null>(
          (acc, s) =>
            !acc || s.period_end.getTime() > acc.getTime() ? s.period_end : acc,
          null,
        );
        const newPaidUntil = maxEnd ?? new Date(0);
        await setPaidUntil(openid, newPaidUntil);

        req.log.warn(
          {
            out_trade_no: outTradeNo,
            openid: openid.slice(0, 8),
            old_paid_until: before.paid_until?.toISOString() ?? null,
            new_paid_until: newPaidUntil.toISOString(),
            removed_period_end: sub.period_end.toISOString(),
            remaining_subscriptions: remaining.length,
            source: sub.source,
          },
          'admin revoked subscription',
        );

        return {
          ok: true,
          removed_subscription_id: sub._id,
          openid_prefix: openid.slice(0, 8),
          old_paid_until: before.paid_until?.toISOString() ?? null,
          new_paid_until: maxEnd ? maxEnd.toISOString() : null,
          remaining_subscriptions: remaining.length,
          removed_source: sub.source,
        };
      },
    );
  };
