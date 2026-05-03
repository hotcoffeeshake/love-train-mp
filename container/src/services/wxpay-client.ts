import { readFileSync } from 'node:fs';
import WxPay from 'wechatpay-node-v3';
import type { AppConfig } from '../config.js';

export interface WxRequestPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

let _client: WxPay | null = null;

function getClient(cfg: AppConfig): WxPay {
  if (_client) return _client;
  if (cfg.wxpay.mode !== 'real') {
    throw new Error('wxpay client unavailable in mock mode');
  }
  const privateKey = readFileSync(cfg.wxpay.privateKeyPath);
  // The SDK requires a publicKey Buffer in its constructor; for v3 notifications
  // platform certs are fetched lazily via get_certificates(apiSecret) when needed
  // for outbound API verification. We pass an empty buffer placeholder here —
  // verifySign() takes the apiSecret + serial directly and works without it.
  _client = new WxPay({
    appid: cfg.wxpay.appid,
    mchid: cfg.wxpay.mchid,
    serial_no: cfg.wxpay.certSerial,
    publicKey: Buffer.from(''),
    privateKey,
    key: cfg.wxpay.apiV3Key,
  });
  return _client;
}

export async function createWxpayPrepayOrder(
  cfg: AppConfig,
  input: { openid: string; out_trade_no: string; amount: number; description: string },
): Promise<WxRequestPayParams> {
  const client = getClient(cfg);
  // SDK enriches the result.data with the wx.requestPayment payload on success
  // (appId, timeStamp, nonceStr, package="prepay_id=...", signType:'RSA', paySign).
  const result = await client.transactions_jsapi({
    appid: cfg.wxpay.appid,
    mchid: cfg.wxpay.mchid,
    description: input.description,
    out_trade_no: input.out_trade_no,
    notify_url: cfg.wxpay.notifyUrl,
    amount: { total: input.amount },
    payer: { openid: input.openid },
  });
  if (result.status !== 200 || !result.data) {
    throw new Error(
      `wxpay transactions_jsapi failed: status=${result.status} error=${JSON.stringify(
        result.error ?? result.errRaw ?? null,
      )}`,
    );
  }
  const d = result.data as {
    timeStamp: string;
    nonceStr: string;
    package: string;
    paySign: string;
  };
  return {
    timeStamp: String(d.timeStamp),
    nonceStr: String(d.nonceStr),
    package: String(d.package),
    signType: 'RSA',
    paySign: String(d.paySign),
  };
}

interface DecryptedNotify {
  out_trade_no: string;
  transaction_id: string;
  openid: string;
  amount_cents: number;
}

export async function verifyAndDecryptNotify(
  cfg: AppConfig,
  headers: Record<string, string>,
  bodyText: string,
): Promise<DecryptedNotify> {
  const client = getClient(cfg);

  // 1) Verify the WeChat Pay v3 signature against raw body bytes.
  const ok = await client.verifySign({
    timestamp: headers['wechatpay-timestamp'],
    nonce: headers['wechatpay-nonce'],
    serial: headers['wechatpay-serial'],
    signature: headers['wechatpay-signature'],
    body: bodyText,
    apiSecret: cfg.wxpay.apiV3Key,
  });
  if (!ok) throw new Error('signature verification failed');

  // 2) Decrypt resource.ciphertext (AEAD_AES_256_GCM).
  const env = JSON.parse(bodyText) as {
    resource: { ciphertext: string; associated_data: string; nonce: string };
  };
  const decrypted = client.decipher_gcm<
    | string
    | {
        out_trade_no: string;
        transaction_id: string;
        trade_state: string;
        payer?: { openid: string };
        amount?: { total?: number; payer_total?: number };
      }
  >(
    env.resource.ciphertext,
    env.resource.associated_data,
    env.resource.nonce,
    cfg.wxpay.apiV3Key,
  );
  const data =
    typeof decrypted === 'string'
      ? (JSON.parse(decrypted) as {
          out_trade_no: string;
          transaction_id: string;
          trade_state: string;
          payer?: { openid: string };
          amount?: { total?: number; payer_total?: number };
        })
      : decrypted;

  if (data.trade_state !== 'SUCCESS') {
    throw new Error(`unexpected trade_state: ${data.trade_state}`);
  }

  const openid = data.payer?.openid;
  if (!openid) throw new Error('decrypted notify missing payer.openid');

  const amount_cents = data.amount?.payer_total ?? data.amount?.total;
  if (typeof amount_cents !== 'number') {
    throw new Error('decrypted notify missing amount');
  }

  return {
    out_trade_no: data.out_trade_no,
    transaction_id: data.transaction_id,
    openid,
    amount_cents,
  };
}
