import type { AppConfig } from '../config.js';

export interface WxRequestPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export async function createWxpayPrepayOrder(
  _cfg: AppConfig,
  _input: { openid: string; out_trade_no: string; amount: number; description: string },
): Promise<WxRequestPayParams> {
  throw new Error('wxpay real-mode client not implemented yet (Task 7)');
}

export async function verifyAndDecryptNotify(
  _cfg: AppConfig,
  _headers: Record<string, string>,
  _bodyText: string,
): Promise<{ out_trade_no: string; transaction_id: string; openid: string; amount_cents: number }> {
  throw new Error('wxpay notify verifier not implemented yet (Task 7)');
}
