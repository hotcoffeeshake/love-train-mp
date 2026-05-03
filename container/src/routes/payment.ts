import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { recordPayment } from '../services/payment.js';
import { createWxpayPrepayOrder } from '../services/wxpay-client.js';

function makeOutTradeNo(): string {
  // LT + yyyymmddhhmmss + 6 random alphanumeric
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `LT${ts}${rand}`;
}

export const paymentRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: { months?: number } }>(
      '/payment/create-order',
      async (req, reply) => {
        const months = Math.max(1, Math.min(12, req.body?.months ?? 1));
        const out_trade_no = makeOutTradeNo();
        const amount = cfg.subscription.amountCents * months;

        if (cfg.wxpay.mode === 'mock') {
          const r = await recordPayment(cfg, {
            openid: req.openid,
            amount,
            transaction_id: `mock-${out_trade_no}`,
            out_trade_no,
            source: 'mock',
            months,
          });
          return {
            mode: 'mock' as const,
            subscription_id: r.subscription_id,
            paid_until: r.paid_until.toISOString(),
          };
        }

        // real mode
        try {
          const wx = await createWxpayPrepayOrder(cfg, {
            openid: req.openid,
            out_trade_no,
            amount,
            description: `love-train 付费会员（${months} 个月）`,
          });
          return { mode: 'real' as const, wx_payment: wx };
        } catch (err) {
          req.log.error({ err }, 'wxpay create-order failed');
          reply.code(502);
          return { ok: false, error: 'INTERNAL_WXPAY_FAILED' };
        }
      },
    );
  };
