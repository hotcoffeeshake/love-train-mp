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

export interface DownloadedImage {
  fileID: string;
  base64: string;
  mimeType: string;
}

function guessMimeFromFileID(fileID: string): string {
  const lower = fileID.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function downloadFileAsBase64(envId: string, fileID: string): Promise<DownloadedImage> {
  const a = getApp(envId);
  const result = await a.downloadFile({ fileID });
  const buf = result.fileContent as Buffer;
  return {
    fileID,
    base64: buf.toString('base64'),
    mimeType: guessMimeFromFileID(fileID),
  };
}
