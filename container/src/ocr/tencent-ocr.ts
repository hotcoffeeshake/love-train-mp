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
  try {
    // GeneralAccurateOCR 高精度版本：对深色背景、复杂排版（如聊天截图）识别更稳。
    const res = await client.GeneralAccurateOCR({
      ImageBase64: base64,
    });
    const items = (res as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
    const lines = items
      .map((it) => (it.DetectedText ?? '').trim())
      .filter((s) => s.length > 0);
    if (lines.length > 0) return lines.join('\n');

    // 兜底：高精度返回空时再尝试一次基础版（成本低，宽松）
    const fallback = await client.GeneralBasicOCR({
      ImageBase64: base64,
      LanguageType: 'zh',
    });
    const items2 = (fallback as { TextDetections?: { DetectedText?: string }[] }).TextDetections ?? [];
    return items2.map((it) => (it.DetectedText ?? '').trim()).filter(Boolean).join('\n');
  } catch (err) {
    console.error('[ocr] OCR failed:', err);
    return '';
  }
}
