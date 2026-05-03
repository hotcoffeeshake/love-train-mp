// 微信内容安全：通过 CloudBase openapi 调 security.msgSecCheck / imgSecCheck
// 需要在云托管启用"开通微信调用能力"开关，wx-server-sdk / @cloudbase/node-sdk 才能调微信 OpenAPI。

import tcb from '@cloudbase/node-sdk';

let app: ReturnType<typeof tcb.init> | null = null;
function getApp(envId: string) {
  if (app) return app;
  const init: Parameters<typeof tcb.init>[0] = { env: envId };
  if (process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) {
    init.secretId = process.env.TENCENT_SECRET_ID;
    init.secretKey = process.env.TENCENT_SECRET_KEY;
  }
  app = tcb.init(init);
  return app;
}

export interface SecurityCheckResult {
  ok: boolean;
  reason?: string;
}

// 只在第一次报 INVALID_WX_ACCESS_TOKEN 时打完整堆栈，后续仅一行 warn，避免日志刷屏
let warnedInvalidToken = false;
function logSecurityFailure(api: string, err: unknown) {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (msg.includes('INVALID_WX_ACCESS_TOKEN')) {
    if (!warnedInvalidToken) {
      warnedInvalidToken = true;
      console.error(
        `[security] ${api} 拿不到微信 access_token：请在 CloudBase 控制台 → 云托管服务 ${process.env.CLOUDBASE_SERVICE_NAME ?? 'love-train-mp3'} → 服务设置 → 开启「微信调用能力」并绑定小程序 AppID。当前先降级放行，但等于跳过内容安全审核。`,
      );
    } else {
      console.warn(`[security] ${api} skipped (no wx access_token)`);
    }
  } else {
    console.error(`[security] ${api} failed (degrading to allow):`, err);
  }
}

/**
 * 文本内容安全。失败（比如未启用微信调用能力）时返回 ok=true 并打 log，避免阻塞主链路。
 */
export async function checkText(envId: string, openid: string, text: string): Promise<SecurityCheckResult> {
  if (!text || text.length < 2) return { ok: true };
  if (!envId) return { ok: true };
  try {
    const a = getApp(envId);
    const wxOpenApi: any = (a as any).callWxOpenApi ?? (a as any).openapi;
    const res = await (a as any).callWxOpenApi({
      apiName: 'security.msgSecCheck',
      requestData: {
        version: 2,
        scene: 1, // 资料场景
        openid,
        content: text.slice(0, 2500), // 微信限制 2500 字
      },
    });
    const data = (res?.result?.data ?? res?.data) as { result?: { suggest?: string; label?: number } };
    const suggest = data?.result?.suggest;
    if (suggest === 'risky' || suggest === 'review') {
      return { ok: false, reason: `label=${data?.result?.label}` };
    }
    return { ok: true };
  } catch (err) {
    logSecurityFailure('msgSecCheck', err);
    return { ok: true };
  }
}

export async function checkImage(envId: string, openid: string, imageBase64: string): Promise<SecurityCheckResult> {
  if (!envId) return { ok: true };
  try {
    const a = getApp(envId);
    const buf = Buffer.from(imageBase64, 'base64');
    const res = await (a as any).callWxOpenApi({
      apiName: 'security.imgSecCheck',
      requestData: {},
      requestPayload: {
        media: {
          contentType: 'image/jpeg',
          value: buf,
        },
      },
    });
    const errcode = res?.errcode ?? res?.result?.errcode;
    if (errcode && errcode !== 0) {
      return { ok: false, reason: `errcode=${errcode}` };
    }
    return { ok: true };
  } catch (err) {
    logSecurityFailure('imgSecCheck', err);
    return { ok: true };
  }
}
