import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import {
  findPaymentOrderByOutTradeNo,
  insertPaymentOrder,
  markPaymentOrderPaid,
} from '../db/payment-orders.js';
import { listSubscriptionsByOpenid } from '../db/subscriptions.js';
import { recordPayment } from '../services/payment.js';
import {
  notifyVirtualGoodsProvided,
  queryVirtualPaymentOrder,
} from '../services/virtual-payment-client.js';
import { codeToSession } from '../services/wechat-session.js';
import { createWxpayPrepayOrder, queryWxpayOrder } from '../services/wxpay-client.js';

function makeOutTradeNo(): string {
  // LT + yyyymmddhhmmss + 6 random alphanumeric
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `LT${ts}${rand}`;
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return '';
}

function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function verifyWechatMessageSignature(
  token: string,
  input: { signature?: string; timestamp?: string; nonce?: string },
): boolean {
  if (!token || !input.signature || !input.timestamp || !input.nonce) return false;
  const expected = sha1Hex([token, input.timestamp, input.nonce].sort().join(''));
  return expected === input.signature;
}

function isTrustedWechatMessageRequest(
  cfg: AppConfig,
  input: {
    headers: Record<string, unknown>;
    query: { signature?: string; timestamp?: string; nonce?: string };
  },
): boolean {
  if (input.headers['x-wx-sources']) return true;
  return verifyWechatMessageSignature(cfg.wechatMessage.token, input.query);
}

function validateVirtualPaymentConfig(cfg: AppConfig): string | null {
  if (!cfg.virtualPayment.offerId) return 'VIRTUAL_PAYMENT_OFFER_ID';
  if (!cfg.virtualPayment.appKey) return 'VIRTUAL_PAYMENT_APP_KEY';
  if (!cfg.virtualPayment.productId) return 'VIRTUAL_PAYMENT_PRODUCT_ID';
  if (!cfg.virtualPayment.goodsPrice) return 'VIRTUAL_PAYMENT_GOODS_PRICE_CENTS';
  return null;
}

function xmlTag(input: string, tag: string): string {
  const match = input.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

interface VirtualNotifyPayload {
  openid: string;
  outTradeNo: string;
  event: string;
  env?: number;
  productId?: string;
  actualPrice?: number;
  origPrice?: number;
  transactionId?: string;
}

function readVirtualNotifyPayload(body: unknown): VirtualNotifyPayload {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      return readVirtualNotifyPayload(JSON.parse(trimmed));
    }
    return {
      openid: xmlTag(trimmed, 'OpenId') || xmlTag(trimmed, 'openid'),
      outTradeNo:
        xmlTag(trimmed, 'OutTradeNo') ||
        xmlTag(trimmed, 'MchOrderId') ||
        xmlTag(trimmed, 'order_id'),
      event: xmlTag(trimmed, 'Event'),
      env: toNumber(xmlTag(trimmed, 'Env')),
      productId: xmlTag(trimmed, 'ProductId'),
      actualPrice: toNumber(xmlTag(trimmed, 'ActualPrice')),
      origPrice: toNumber(xmlTag(trimmed, 'OrigPrice')),
      transactionId: xmlTag(trimmed, 'TransactionId'),
    };
  }

  const data = (body ?? {}) as Record<string, unknown>;
  const goodsInfo = asRecord(data.GoodsInfo ?? data.goodsInfo);
  const wechatPayInfo = asRecord(data.WeChatPayInfo ?? data.wechatPayInfo);
  return {
    openid: String(data.OpenId ?? data.openid ?? ''),
    outTradeNo: String(data.OutTradeNo ?? data.MchOrderId ?? data.order_id ?? ''),
    event: String(data.Event ?? data.event ?? ''),
    env: toNumber(data.Env ?? data.env),
    productId: String(goodsInfo.ProductId ?? goodsInfo.productId ?? ''),
    actualPrice: toNumber(goodsInfo.ActualPrice ?? goodsInfo.actualPrice),
    origPrice: toNumber(goodsInfo.OrigPrice ?? goodsInfo.origPrice),
    transactionId: String(
      wechatPayInfo.TransactionId ??
        wechatPayInfo.transactionId ??
        wechatPayInfo.MchOrderNo ??
        wechatPayInfo.mchOrderNo ??
        '',
    ),
  };
}

async function settleVirtualPaymentOrder(
  cfg: AppConfig,
  input: { openid: string; outTradeNo: string; notifyProvided: boolean },
) {
  const order = await findPaymentOrderByOutTradeNo(input.outTradeNo);
  if (!order) {
    const err = new Error('ORDER_NOT_FOUND');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }
  if (order.openid !== input.openid) {
    const err = new Error('ORDER_OPENID_MISMATCH');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }

  let transactionId = `virtual-${order.out_trade_no}`;
  if (cfg.virtualPayment.mode === 'real') {
    const wxOrder = await queryVirtualPaymentOrder(cfg, {
      openid: input.openid,
      outTradeNo: order.out_trade_no,
    });

    if (!wxOrder.paid || !wxOrder.order) {
      return {
        ok: true,
        is_paid: false,
        status: wxOrder.order?.status ?? null,
      };
    }

    const paidAmount = wxOrder.order.paid_fee ?? wxOrder.order.order_fee;
    if (typeof paidAmount === 'number' && paidAmount < order.amount) {
      const err = new Error('VIRTUAL_PAYMENT_AMOUNT_MISMATCH');
      (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).statusCode = 409;
      (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).paidAmount = paidAmount;
      (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).expectedAmount = order.amount;
      throw err;
    }

    transactionId =
      wxOrder.order.wxpay_order_id ||
      wxOrder.order.wx_order_id ||
      wxOrder.order.channel_order_id ||
      transactionId;
  }

  const r = await recordPayment(cfg, {
    openid: input.openid,
    amount: order.amount,
    transaction_id: transactionId,
    out_trade_no: order.out_trade_no,
    source: 'virtual',
    months: order.months,
  });
  await markPaymentOrderPaid(order.out_trade_no);
  if (cfg.virtualPayment.mode === 'real' && input.notifyProvided) {
    await notifyVirtualGoodsProvided(cfg, order.out_trade_no);
  }
  return {
    ok: true,
    is_paid: true,
    paid_until: r.paid_until.toISOString(),
    duplicate: !!r.duplicate,
  };
}

async function settleVirtualPaymentNotify(cfg: AppConfig, input: VirtualNotifyPayload) {
  const order = await findPaymentOrderByOutTradeNo(input.outTradeNo);
  if (!order) {
    const err = new Error('ORDER_NOT_FOUND');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }
  // In virtual payment goods delivery notifications, the OpenId field is not a
  // reliable buyer identity. Trust the locally-created order's openid after the
  // message source and order id have been verified.
  if (input.event && input.event !== 'xpay_goods_deliver_notify') {
    const err = new Error('UNSUPPORTED_VIRTUAL_NOTIFY_EVENT');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (typeof input.env === 'number' && input.env !== cfg.virtualPayment.env) {
    const err = new Error('VIRTUAL_PAYMENT_ENV_MISMATCH');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }
  if (input.productId && input.productId !== cfg.virtualPayment.productId) {
    const err = new Error('VIRTUAL_PAYMENT_PRODUCT_MISMATCH');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  const paidAmount = input.actualPrice ?? input.origPrice;
  if (typeof paidAmount === 'number' && paidAmount < order.amount) {
    const err = new Error('VIRTUAL_PAYMENT_AMOUNT_MISMATCH');
    (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).statusCode = 409;
    (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).paidAmount = paidAmount;
    (err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number }).expectedAmount = order.amount;
    throw err;
  }

  const r = await recordPayment(cfg, {
    openid: order.openid,
    amount: order.amount,
    transaction_id: input.transactionId || `virtual-${order.out_trade_no}`,
    out_trade_no: order.out_trade_no,
    source: 'virtual',
    months: order.months,
  });
  await markPaymentOrderPaid(order.out_trade_no);

  return {
    ok: true,
    is_paid: true,
    paid_until: r.paid_until.toISOString(),
    duplicate: !!r.duplicate,
  };
}

export const paymentRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.get('/payment/orders', async (req) => {
      const orders = await listSubscriptionsByOpenid(req.openid, 50, 0);
      return {
        orders: orders.map((o) => ({
          id: o._id,
          title: '练爱导师付费会员',
          status: 'paid' as const,
          amount: o.amount,
          paid_at: toIsoString(o.paid_at),
          period_start: toIsoString(o.period_start),
          period_end: toIsoString(o.period_end),
          out_trade_no: o.out_trade_no,
          source: o.source,
        })),
      };
    });

    app.post<{ Body: { months?: number } }>(
      '/payment/create-order',
      async (req, reply) => {
        const months = Math.max(1, Math.min(12, req.body?.months ?? 1));
        const out_trade_no = makeOutTradeNo();
        const amount = cfg.subscription.amountCents * months;

        if (cfg.wxpay.mode === 'mock') {
          if (cfg.nodeEnv === 'production') {
            reply.code(503);
            return { ok: false, error: 'PAYMENT_NOT_CONFIGURED' };
          }
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
          return { mode: 'real' as const, out_trade_no, wx_payment: wx };
        } catch (err) {
          req.log.error({ err }, 'wxpay create-order failed');
          reply.code(502);
          return { ok: false, error: 'INTERNAL_WXPAY_FAILED' };
        }
      },
    );

    app.post<{ Body: { months?: number; code?: string } }>(
      '/payment/create-virtual-order',
      async (req, reply) => {
        const months = Math.max(1, Math.min(12, req.body?.months ?? 1));
        const out_trade_no = makeOutTradeNo();
        const amount = cfg.subscription.amountCents * months;

        if (cfg.virtualPayment.mode === 'mock') {
          if (cfg.nodeEnv === 'production') {
            reply.code(503);
            return { ok: false, error: 'VIRTUAL_PAYMENT_NOT_CONFIGURED' };
          }
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

        const missing = validateVirtualPaymentConfig(cfg);
        if (missing) {
          reply.code(503);
          return { ok: false, error: 'VIRTUAL_PAYMENT_NOT_CONFIGURED', missing };
        }

        const code = req.body?.code?.trim();
        if (!code) {
          reply.code(400);
          return { ok: false, error: 'MISSING_LOGIN_CODE' };
        }

        let session;
        try {
          session = await codeToSession(cfg, code);
        } catch (err) {
          req.log.warn({ err }, 'virtual payment jscode2session failed');
          reply.code(401);
          return { ok: false, error: 'WX_LOGIN_FAILED', message: (err as Error).message };
        }

        if (session.openid !== req.openid) {
          req.log.warn(
            {
              requestOpenid: req.openid.slice(0, 8),
              codeOpenid: session.openid.slice(0, 8),
            },
            'virtual payment login openid mismatch',
          );
          reply.code(403);
          return { ok: false, error: 'ORDER_OPENID_MISMATCH' };
        }

        await insertPaymentOrder({
          openid: req.openid,
          amount,
          months,
          out_trade_no,
          source: 'virtual',
        });

        const signData = {
          offerId: cfg.virtualPayment.offerId,
          buyQuantity: months,
          env: cfg.virtualPayment.env,
          currencyType: cfg.virtualPayment.currencyType,
          productId: cfg.virtualPayment.productId,
          goodsPrice: cfg.virtualPayment.goodsPrice,
          outTradeNo: out_trade_no,
          attach: JSON.stringify({ type: 'subscription', months }),
        };
        const signDataJson = JSON.stringify(signData);
        return {
          mode: 'real' as const,
          out_trade_no,
          wx_virtual_payment: {
            mode: 'short_series_goods' as const,
            signData: signDataJson,
            paySig: hmacSha256Hex(
              cfg.virtualPayment.appKey,
              `requestVirtualPayment&${signDataJson}`,
            ),
            signature: hmacSha256Hex(session.session_key, signDataJson),
          },
        };
      },
    );

    app.post<{ Body: Record<string, unknown> }>(
      '/payment/debug-report',
      async (req) => {
        req.log.warn(
          {
            openid_prefix: req.openid.slice(0, 8),
            payload: req.body ?? {},
          },
          '[virtual-payment-debug] client reported',
        );
        return { ok: true };
      },
    );

    app.post<{ Body: { out_trade_no?: string } }>(
      '/payment/sync-virtual-order',
      async (req, reply) => {
        const outTradeNo = req.body?.out_trade_no?.trim();
        if (!outTradeNo) {
          return reply.code(400).send({ ok: false, error: 'MISSING_OUT_TRADE_NO' });
        }

        try {
          return await settleVirtualPaymentOrder(cfg, {
            openid: req.openid,
            outTradeNo,
            notifyProvided: true,
          });
        } catch (err) {
          const e = err as Error & { statusCode?: number; paidAmount?: number; expectedAmount?: number };
          if (e.message === 'VIRTUAL_PAYMENT_AMOUNT_MISMATCH') {
            req.log.warn(
              { out_trade_no: outTradeNo, paidAmount: e.paidAmount, expectedAmount: e.expectedAmount },
              'virtual payment amount mismatch',
            );
            return reply.code(409).send({ ok: false, error: e.message });
          }
          if (e.message === 'ORDER_NOT_FOUND' || e.message === 'ORDER_OPENID_MISMATCH') {
            return reply.code(e.statusCode ?? 400).send({ ok: false, error: e.message });
          }
          req.log.error({ err, out_trade_no: outTradeNo }, 'virtual payment query failed');
          return reply.code(502).send({ ok: false, error: 'INTERNAL_VIRTUAL_PAYMENT_QUERY_FAILED' });
        }
      },
    );

    app.post<{
      Body: unknown;
      Querystring: { signature?: string; timestamp?: string; nonce?: string };
    }>('/payment/virtual-notify', async (req, reply) => {
      if (!isTrustedWechatMessageRequest(cfg, { headers: req.headers, query: req.query })) {
        req.log.warn(
          {
            hasWxSources: !!req.headers['x-wx-sources'],
            hasSignature: !!req.query.signature,
            hasToken: !!cfg.wechatMessage.token,
          },
          'untrusted virtual payment notify rejected',
        );
        return reply.code(403).send({ ErrCode: 1, ErrMsg: 'forbidden' });
      }

      let payload;
      try {
        payload = readVirtualNotifyPayload(req.body);
      } catch (err) {
        req.log.warn({ err }, 'virtual payment notify parse failed');
        return reply.code(400).send({ ErrCode: 1, ErrMsg: 'bad request' });
      }

      if (!payload.openid || !payload.outTradeNo) {
        req.log.warn({ payload }, 'virtual payment notify missing fields');
        return reply.code(400).send({ ErrCode: 1, ErrMsg: 'missing OpenId or OutTradeNo' });
      }

      try {
        const result = await settleVirtualPaymentNotify(cfg, payload);
        req.log.info(
          {
            event: payload.event,
            out_trade_no: payload.outTradeNo,
            is_paid: result.is_paid,
            duplicate: result.duplicate,
          },
          'virtual payment notify processed',
        );
        return { ErrCode: 0, ErrMsg: 'ok' };
      } catch (err) {
        req.log.error({ err, payload }, 'virtual payment notify processing failed');
        return reply.code(500).send({ ErrCode: 1, ErrMsg: 'process failed' });
      }
    });

    app.get<{
      Querystring: { signature?: string; timestamp?: string; nonce?: string; echostr?: string };
    }>('/payment/virtual-notify', async (req, reply) => {
      const ok = verifyWechatMessageSignature(cfg.wechatMessage.token, req.query);
      if (!ok) {
        req.log.warn(
          {
            hasToken: !!cfg.wechatMessage.token,
            hasSignature: !!req.query.signature,
            hasTimestamp: !!req.query.timestamp,
            hasNonce: !!req.query.nonce,
          },
          'wechat message token verification failed',
        );
        return reply.code(403).send('forbidden');
      }
      return reply.type('text/plain').send(req.query.echostr ?? '');
    });

    app.post<{ Body: { out_trade_no?: string } }>(
      '/payment/sync-order',
      async (req, reply) => {
        const outTradeNo = req.body?.out_trade_no?.trim();
        if (!outTradeNo) {
          return reply.code(400).send({ ok: false, error: 'MISSING_OUT_TRADE_NO' });
        }
        if (cfg.wxpay.mode !== 'real') {
          return reply.code(400).send({ ok: false, error: 'WXPAY_NOT_REAL_MODE' });
        }

        let order;
        try {
          order = await queryWxpayOrder(cfg, outTradeNo);
        } catch (err) {
          req.log.error({ err, out_trade_no: outTradeNo }, 'wxpay query failed');
          return reply.code(502).send({ ok: false, error: 'INTERNAL_WXPAY_QUERY_FAILED' });
        }

        if (order.openid !== req.openid) {
          req.log.warn(
            {
              out_trade_no: outTradeNo,
              queryOpenid: order.openid.slice(0, 8),
              requestOpenid: req.openid.slice(0, 8),
            },
            'wxpay order openid mismatch',
          );
          return reply.code(403).send({ ok: false, error: 'ORDER_OPENID_MISMATCH' });
        }

        if (order.trade_state !== 'SUCCESS') {
          return { ok: true, is_paid: false, trade_state: order.trade_state };
        }

        const months = Math.max(1, Math.round(order.amount_cents / cfg.subscription.amountCents));
        const r = await recordPayment(cfg, {
          openid: req.openid,
          amount: order.amount_cents,
          transaction_id: order.transaction_id,
          out_trade_no: order.out_trade_no,
          source: 'wxpay',
          months,
        });
        req.log.info(
          { out_trade_no: order.out_trade_no, openid: req.openid.slice(0, 8) },
          'wxpay order synced',
        );
        return {
          ok: true,
          is_paid: true,
          paid_until: r.paid_until.toISOString(),
          duplicate: !!r.duplicate,
        };
      },
    );
  };
