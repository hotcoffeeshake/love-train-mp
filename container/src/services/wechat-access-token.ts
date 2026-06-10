import type { AppConfig } from '../config.js';

interface TokenCache {
  token: string;
  expiresAt: number;
}

let cache: TokenCache | null = null;

export async function getWechatAccessToken(cfg: AppConfig): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 60_000) {
    return cache.token;
  }
  if (!cfg.wxAppId || !cfg.wxAppSecret) {
    throw new Error('WX_CREDENTIALS_NOT_CONFIGURED');
  }

  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(cfg.wxAppId)}` +
    `&secret=${encodeURIComponent(cfg.wxAppSecret)}`;
  const res = await fetch(url);
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };

  if (!body.access_token) {
    const err = new Error(body.errmsg ?? 'failed to get access_token');
    (err as Error & { errcode?: number }).errcode = body.errcode;
    throw err;
  }

  cache = {
    token: body.access_token,
    expiresAt: now + Math.max(60, body.expires_in ?? 7200) * 1000,
  };
  return cache.token;
}

