import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { recordPayment } from '../services/payment.js';
import { verifyAndDecryptNotify } from '../services/wxpay-client.js';

export const wxpayRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post('/wxpay/notify', async (req, reply) => {
      const headers = req.headers as Record<string, string>;
      // The server.ts content-type parser delivers the raw string for this URL.
      const bodyText =
        typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body ?? {});

      let payload: {
        out_trade_no: string;
        transaction_id: string;
        openid: string;
        amount_cents: number;
      };
      try {
        payload = await verifyAndDecryptNotify(cfg, headers, bodyText);
      } catch (err) {
        req.log.warn({ err }, 'wxpay notify verification failed');
        reply.code(401);
        return { code: 'FAIL', message: 'verification failed' };
      }

      try {
        await recordPayment(cfg, {
          openid: payload.openid,
          amount: payload.amount_cents,
          transaction_id: payload.transaction_id,
          out_trade_no: payload.out_trade_no,
          source: 'wxpay',
        });
      } catch (err) {
        req.log.error({ err }, 'wxpay notify processing failed');
        reply.code(500);
        return { code: 'FAIL', message: 'processing failed' };
      }

      return { code: 'SUCCESS', message: 'OK' };
    });
  };
