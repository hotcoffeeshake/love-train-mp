import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { paymentRoutes } from '../../src/routes/payment.js';
import { getOrCreateUser } from '../../src/db/users.js';
import { listAllSubscriptions } from '../../src/db/subscriptions.js';

vi.mock('../../src/services/wxpay-client.js', async () => {
  return {
    createWxpayPrepayOrder: vi.fn(),
    queryWxpayOrder: vi.fn(),
  };
});
vi.mock('../../src/services/virtual-payment-client.js', async () => {
  return {
    queryVirtualPaymentOrder: vi.fn(),
    notifyVirtualGoodsProvided: vi.fn(),
  };
});
import { createWxpayPrepayOrder, queryWxpayOrder } from '../../src/services/wxpay-client.js';
import {
  notifyVirtualGoodsProvided,
  queryVirtualPaymentOrder,
} from '../../src/services/virtual-payment-client.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
  await client.db('test').collection('payment_orders').deleteMany({});
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mockCfg = {
  nodeEnv: 'development',
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: { mode: 'mock' },
  virtualPayment: { mode: 'mock' },
} as any;
const realCfg = {
  wxAppId: 'appid',
  wxAppSecret: 'secret',
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: { mode: 'real' },
  virtualPayment: {
    mode: 'real',
    offerId: 'offer-1',
    appKey: 'virtual-app-key',
    env: 1,
    currencyType: 'CNY',
    productId: 'monthly-member',
    goodsPrice: 2000,
  },
  wechatMessage: {
    token: 'message-token',
  },
} as any;

function build(cfg: any) {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(paymentRoutes(cfg));
  return app;
}

describe('POST /payment/create-order (mock mode)', () => {
  it('returns mode=mock + subscription_id + paid_until', async () => {
    await getOrCreateUser('oA');
    const app = build(mockCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('mock');
    expect(body.subscription_id).toBeDefined();
    expect(body.paid_until).toBeDefined();
  });
});

describe('POST /payment/create-order (real mode)', () => {
  it('returns out_trade_no for client-side sync', async () => {
    (createWxpayPrepayOrder as any).mockResolvedValue({
      timeStamp: '1',
      nonceStr: 'n',
      package: 'prepay_id=p',
      signType: 'RSA',
      paySign: 's',
    });
    const app = build(realCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('real');
    expect(body.out_trade_no).toMatch(/^LT/);
  });
});

describe('POST /payment/sync-order', () => {
  it('queries paid wxpay order and writes subscription', async () => {
    await getOrCreateUser('oA');
    (queryWxpayOrder as any).mockResolvedValue({
      out_trade_no: 'LT-1',
      transaction_id: 'wx-tx-1',
      trade_state: 'SUCCESS',
      openid: 'oA',
      amount_cents: 2000,
    });
    const app = build(realCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/sync-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: 'LT-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_paid).toBe(true);
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].source).toBe('wxpay');
  });

  it('rejects syncing another user order', async () => {
    (queryWxpayOrder as any).mockResolvedValue({
      out_trade_no: 'LT-1',
      transaction_id: 'wx-tx-1',
      trade_state: 'SUCCESS',
      openid: 'oB',
      amount_cents: 2000,
    });
    const app = build(realCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/sync-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: 'LT-1' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /payment/create-virtual-order', () => {
  it('returns requestVirtualPayment params in real mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('real');
    expect(body.out_trade_no).toMatch(/^LT/);
    expect(body.wx_virtual_payment).toMatchObject({
      mode: 'short_series_goods',
      paySig: expect.any(String),
      signature: expect.any(String),
    });
    const signData = JSON.parse(body.wx_virtual_payment.signData);
    expect(signData).toMatchObject({
      offerId: 'offer-1',
      productId: 'monthly-member',
      goodsPrice: 2000,
      outTradeNo: body.out_trade_no,
    });
  });
});

describe('POST /payment/sync-virtual-order', () => {
  it('records a paid virtual order for the current user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;
    (queryVirtualPaymentOrder as any).mockResolvedValue({
      paid: true,
      order: {
        order_id: outTradeNo,
        status: 2,
        paid_fee: 2000,
        wxpay_order_id: 'wxpay-virtual-1',
      },
    });

    const res = await app.inject({
      method: 'POST', url: '/payment/sync-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: outTradeNo },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_paid).toBe(true);
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].source).toBe('virtual');
    expect(queryVirtualPaymentOrder).toHaveBeenCalledWith(realCfg, {
      openid: 'oA',
      outTradeNo,
    });
    expect(notifyVirtualGoodsProvided).toHaveBeenCalledWith(realCfg, outTradeNo);
  });

  it('does not grant membership until WeChat reports the virtual order as paid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;
    (queryVirtualPaymentOrder as any).mockResolvedValue({
      paid: false,
      order: { order_id: outTradeNo, status: 1 },
    });

    const res = await app.inject({
      method: 'POST', url: '/payment/sync-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: outTradeNo },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, is_paid: false, status: 1 });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(0);
  });

  it('returns 502 when WeChat order query fails unexpectedly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    (queryVirtualPaymentOrder as any).mockRejectedValue(new Error('query failed'));

    const res = await app.inject({
      method: 'POST', url: '/payment/sync-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: created.json().out_trade_no },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, error: 'INTERNAL_VIRTUAL_PAYMENT_QUERY_FAILED' });
  });
});

describe('POST /payment/virtual-notify', () => {
  it('responds with echostr for WeChat message push token verification', async () => {
    const app = build(realCfg);
    const timestamp = '1779042200';
    const nonce = 'nonce-1';
    const signature = createHash('sha1')
      .update(['message-token', timestamp, nonce].sort().join(''))
      .digest('hex');

    const res = await app.inject({
      method: 'GET',
      url: `/payment/virtual-notify?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello-wechat`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello-wechat');
  });

  it('rejects invalid WeChat message push token verification', async () => {
    const app = build(realCfg);

    const res = await app.inject({
      method: 'GET',
      url: '/payment/virtual-notify?signature=bad&timestamp=1779042200&nonce=nonce-1&echostr=hello-wechat',
    });

    expect(res.statusCode).toBe(403);
  });

  it('records a paid virtual order from WeChat goods delivery notify without an openid header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;
    const res = await app.inject({
      method: 'POST',
      url: '/payment/virtual-notify',
      headers: { 'x-wx-sources': 'message-push' },
      payload: {
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'oA',
        OutTradeNo: outTradeNo,
        Env: 1,
        GoodsInfo: {
          ProductId: 'monthly-member',
          ActualPrice: 2000,
          OrigPrice: 2000,
        },
        WeChatPayInfo: {
          TransactionId: 'wxpay-virtual-notify-1',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ErrCode: 0, ErrMsg: 'ok' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      openid: 'oA',
      out_trade_no: outTradeNo,
      transaction_id: 'wxpay-virtual-notify-1',
      source: 'virtual',
    });
    expect(queryVirtualPaymentOrder).not.toHaveBeenCalled();
    expect(notifyVirtualGoodsProvided).not.toHaveBeenCalled();
  });

  it('uses the local order openid when WeChat goods delivery notify OpenId is not the buyer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'buyer-openid', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'buyer-openid' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;

    const res = await app.inject({
      method: 'POST',
      url: '/payment/virtual-notify',
      headers: { 'x-wx-sources': 'message-push' },
      payload: {
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'wechat-official-openid',
        OutTradeNo: outTradeNo,
        Env: 1,
        GoodsInfo: {
          ProductId: 'monthly-member',
          ActualPrice: 2000,
          OrigPrice: 2000,
        },
        WeChatPayInfo: {
          TransactionId: 'wxpay-virtual-notify-official-openid',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ErrCode: 0, ErrMsg: 'ok' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      openid: 'buyer-openid',
      out_trade_no: outTradeNo,
      transaction_id: 'wxpay-virtual-notify-official-openid',
      source: 'virtual',
    });
  });

  it('keeps virtual payment settlement idempotent by out_trade_no', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;
    (queryVirtualPaymentOrder as any).mockResolvedValueOnce({
      paid: true,
      order: {
        order_id: outTradeNo,
        status: 4,
        paid_fee: 2000,
        wxpay_order_id: 'wxpay-virtual-notify-2-later',
      },
    });

    await app.inject({
      method: 'POST',
      url: '/payment/virtual-notify',
      headers: { 'x-wx-sources': 'message-push' },
      payload: {
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'oA',
        OutTradeNo: outTradeNo,
        Env: 1,
        GoodsInfo: {
          ProductId: 'monthly-member',
          ActualPrice: 2000,
        },
        WeChatPayInfo: {
          TransactionId: 'wxpay-virtual-notify-2',
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/payment/sync-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { out_trade_no: outTradeNo },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
  });

  it('rejects a goods delivery notify when product id or amount is inconsistent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ openid: 'oA', session_key: 'session-key' }),
      })),
    );
    const app = build(realCfg);
    const created = await app.inject({
      method: 'POST', url: '/payment/create-virtual-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1, code: 'wx-code' },
    });
    const outTradeNo = created.json().out_trade_no;

    const res = await app.inject({
      method: 'POST',
      url: '/payment/virtual-notify',
      headers: { 'x-wx-sources': 'message-push' },
      payload: {
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'oA',
        OutTradeNo: outTradeNo,
        Env: 1,
        GoodsInfo: {
          ProductId: 'wrong-product',
          ActualPrice: 2000,
        },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ ErrCode: 1, ErrMsg: 'process failed' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(0);
  });

  it('rejects unsigned public virtual payment notify requests', async () => {
    const app = build(realCfg);

    const res = await app.inject({
      method: 'POST',
      url: '/payment/virtual-notify',
      payload: {
        Event: 'xpay_goods_deliver_notify',
        OpenId: 'oA',
        OutTradeNo: 'LT-unsigned',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ErrCode: 1, ErrMsg: 'forbidden' });
  });
});

describe('GET /payment/orders', () => {
  it('returns only subscriptions for the current openid', async () => {
    await getOrCreateUser('oA');
    await getOrCreateUser('oB');
    const app = build(mockCfg);

    await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1 },
    });
    await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oB' },
      payload: { months: 1 },
    });

    const res = await app.inject({
      method: 'GET', url: '/payment/orders',
      headers: { 'x-wx-openid': 'oA' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({
      title: '练爱导师付费会员',
      status: 'paid',
      amount: 2000,
      source: 'mock',
    });
    expect(body.orders[0].out_trade_no).toMatch(/^LT/);
  });
});
