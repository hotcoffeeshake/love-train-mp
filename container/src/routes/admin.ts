import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { findUserByInviteCode, getOrCreateUser } from '../db/users.js';
import {
  findRebatesByStatus,
  listAllSubscriptions,
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
  };
