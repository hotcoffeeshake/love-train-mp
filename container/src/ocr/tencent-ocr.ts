import { ocr } from 'tencentcloud-sdk-nodejs-ocr';

type OcrClient = InstanceType<typeof ocr.v20181119.Client>;

let cached: OcrClient | null = null;

function getClient(): OcrClient | null {
  if (cached) return cached;
  // 容器里 API key 注入会写入 TENCENTCLOUD_SECRETID/SECRETKEY
  // 同时也支持 TENCENT_SECRET_ID/KEY（与 cloudbase-adapter 一致）
  const secretId =
    process.env.TENCENTCLOUD_SECRETID ?? process.env.TENCENT_SECRET_ID;
  const secretKey =
    process.env.TENCENTCLOUD_SECRETKEY ?? process.env.TENCENT_SECRET_KEY;
  const sessionToken =
    process.env.TENCENTCLOUD_SESSIONTOKEN ?? process.env.TENCENT_SESSION_TOKEN;
  if (!secretId || !secretKey) {
    return null;
  }
  cached = new ocr.v20181119.Client({
    credential: { secretId, secretKey, token: sessionToken },
    region: 'ap-shanghai',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com', reqTimeout: 15 } },
  });
  return cached;
}

export interface OcrDebugResult {
  text: string;
  accurateRaw: unknown;
  basicRaw: unknown;
  error: string | null;
  hasClient: boolean;
}

/**
 * 调试用：返回 raw responses 而不只是 text
 */
export async function ocrDebug(base64: string): Promise<OcrDebugResult> {
  const client = getClient();
  if (!client) return { text: '', accurateRaw: null, basicRaw: null, error: 'no credentials', hasClient: false };
  let accurateRaw: unknown = null;
  let basicRaw: unknown = null;
  let text = '';
  try {
    try {
      basicRaw = await client.GeneralBasicOCR({ ImageBase64: base64, LanguageType: 'zh' });
      const items = (basicRaw as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
      text = items.map((it) => (it.DetectedText ?? '').trim()).filter(Boolean).join('\n');
    } catch (e) {
      basicRaw = { errorMessage: (e as Error)?.message };
    }
    if (!text) {
      try {
        accurateRaw = await client.GeneralAccurateOCR({ ImageBase64: base64 });
        const items = (accurateRaw as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
        text = items.map((it) => (it.DetectedText ?? '').trim()).filter(Boolean).join('\n');
      } catch (e) {
        accurateRaw = { errorMessage: (e as Error)?.message };
      }
    }
    return { text, accurateRaw, basicRaw, error: null, hasClient: true };
  } catch (err) {
    return {
      text,
      accurateRaw,
      basicRaw,
      error: (err as Error)?.message ?? String(err),
      hasClient: true,
    };
  }
}

/**
 * 通用印刷体识别：图片 base64 → 提取文字
 * 失败时返回空字符串（不阻塞主链路）
 */
export async function ocrImageBase64(base64: string): Promise<string> {
  const client = getClient();
  if (!client) {
    console.warn('[ocr] no credentials, skipping');
    return '';
  }
  // 先试 Basic（多数账号默认就开免费额度）；返回空再试 Accurate（要单独开通）。
  // 任一调用抛错也不阻塞主链路。
  try {
    const basic = await client.GeneralBasicOCR({
      ImageBase64: base64,
      LanguageType: 'zh',
    });
    const items = (basic as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
    const lines = items.map((it) => (it.DetectedText ?? '').trim()).filter(Boolean);
    if (lines.length > 0) return lines.join('\n');
  } catch (err) {
    console.warn('[ocr] basic failed, trying accurate:', (err as Error)?.message);
  }

  try {
    const accurate = await client.GeneralAccurateOCR({ ImageBase64: base64 });
    const items = (accurate as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
    return items.map((it) => (it.DetectedText ?? '').trim()).filter(Boolean).join('\n');
  } catch (err) {
    console.error('[ocr] accurate failed:', (err as Error)?.message);
    return '';
  }
}
