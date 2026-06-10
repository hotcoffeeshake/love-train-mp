import type { AppConfig } from '../config.js';

export interface WechatSession {
  openid: string;
  unionid?: string;
  session_key: string;
}

export async function codeToSession(cfg: AppConfig, code: string): Promise<WechatSession> {
  if (!cfg.wxAppId || !cfg.wxAppSecret) {
    throw new Error('WX_CREDENTIALS_NOT_CONFIGURED');
  }

  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${encodeURIComponent(cfg.wxAppId)}` +
    `&secret=${encodeURIComponent(cfg.wxAppSecret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const r = await fetch(url);
  const wxResp = (await r.json()) as {
    openid?: string;
    unionid?: string;
    session_key?: string;
    errcode?: number;
    errmsg?: string;
  };

  if (wxResp.errcode || !wxResp.openid || !wxResp.session_key) {
    const err = new Error(wxResp.errmsg ?? 'jscode2session returned no openid/session_key');
    (err as Error & { code?: string; errcode?: number }).code = 'WX_LOGIN_FAILED';
    (err as Error & { code?: string; errcode?: number }).errcode = wxResp.errcode;
    throw err;
  }

  return {
    openid: wxResp.openid,
    unionid: wxResp.unionid,
    session_key: wxResp.session_key,
  };
}
