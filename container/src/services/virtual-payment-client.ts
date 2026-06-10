import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { getWechatAccessToken } from './wechat-access-token.js';

export interface VirtualPaymentOrder {
  order_id: string;
  status: number;
  order_fee?: number;
  paid_fee?: number;
  paid_time?: number;
  provide_time?: number;
  order_type?: number;
  wx_order_id?: string;
  channel_order_id?: string;
  wxpay_order_id?: string;
}

export interface VirtualPaymentQueryResult {
  paid: boolean;
  order: VirtualPaymentOrder | null;
}

function hmacSha256Hex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}

async function postXpay<T>(
  cfg: AppConfig,
  uri: '/xpay/query_order' | '/xpay/notify_provide_goods',
  body: Record<string, unknown>,
  withPaySig: boolean,
): Promise<T> {
  const accessToken = await getWechatAccessToken(cfg);
  const bodyJson = JSON.stringify(body);
  const url = new URL(`https://api.weixin.qq.com${uri}`);
  url.searchParams.set('access_token', accessToken);
  if (withPaySig) {
    url.searchParams.set('pay_sig', hmacSha256Hex(cfg.virtualPayment.appKey, `${uri}&${bodyJson}`));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyJson,
  });
  const data = (await res.json()) as T & { errcode?: number; errmsg?: string };
  if (data.errcode) {
    const err = new Error(data.errmsg ?? `xpay api failed: ${uri}`);
    (err as Error & { errcode?: number; response?: unknown }).errcode = data.errcode;
    (err as Error & { errcode?: number; response?: unknown }).response = data;
    throw err;
  }
  return data;
}

export async function queryVirtualPaymentOrder(
  cfg: AppConfig,
  input: { openid: string; outTradeNo: string },
): Promise<VirtualPaymentQueryResult> {
  let data: { order?: VirtualPaymentOrder };
  try {
    data = await postXpay<{ order?: VirtualPaymentOrder }>(
      cfg,
      '/xpay/query_order',
      {
        openid: input.openid,
        env: cfg.virtualPayment.env,
        order_id: input.outTradeNo,
      },
      true,
    );
  } catch (err) {
    const e = err as Error & { errcode?: number };
    if (e.errcode === 268490002 && e.message.includes('数据不存在')) {
      return { paid: false, order: null };
    }
    throw err;
  }
  const order = data.order ?? null;
  return {
    order,
    // 2=已支付待发货, 3=发货中, 4=已发货
    paid: order ? [2, 3, 4].includes(order.status) : false,
  };
}

export async function notifyVirtualGoodsProvided(
  cfg: AppConfig,
  outTradeNo: string,
): Promise<void> {
  await postXpay(
    cfg,
    '/xpay/notify_provide_goods',
    {
      order_id: outTradeNo,
      env: cfg.virtualPayment.env,
    },
    true,
  );
}
