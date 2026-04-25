// 图片选择 + 压缩 + 上传到云存储

const MAX_IMAGES = 5;
// 注意：聊天截图内的文字若被过度压缩，OCR 识别率会暴跌。
// chooseMedia({ sizeType: ['compressed'] }) 已经做了一轮系统级压缩，
// 我们这里只在体积仍然过大时再轻度压一轮，质量保留 80。
const COMPRESS_THRESHOLD_KB = 1500; // 1.5MB 以下保持原图
const COMPRESS_QUALITY = 80;

export interface PickedImage {
  tempPath: string;
  size: number; // bytes
}

export async function pickImages(currentCount: number): Promise<PickedImage[]> {
  const remaining = MAX_IMAGES - currentCount;
  if (remaining <= 0) {
    wx.showToast({ title: '最多 5 张', icon: 'none' });
    return [];
  }
  const res = await wx.chooseMedia({
    count: remaining,
    mediaType: ['image'],
    sourceType: ['album', 'camera'],
    sizeType: ['compressed'],
  });
  return res.tempFiles.map((f) => ({ tempPath: f.tempFilePath, size: f.size }));
}

function getFileSize(path: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const fs = wx.getFileSystemManager();
      fs.getFileInfo({
        filePath: path,
        success: (r: { size: number }) => resolve(r.size),
        fail: () => resolve(0),
      });
    } catch {
      resolve(0);
    }
  });
}

async function compressOnce(src: string, quality: number): Promise<string> {
  try {
    const r = await wx.compressImage({ src, quality });
    return r.tempFilePath;
  } catch {
    return src;
  }
}

async function maybeCompress(img: PickedImage): Promise<string> {
  if (img.size < COMPRESS_THRESHOLD_KB * 1024) return img.tempPath;
  return compressOnce(img.tempPath, COMPRESS_QUALITY);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function todayPath(): string {
  const d = new Date();
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${beijing.getUTCFullYear()}-${pad2(beijing.getUTCMonth() + 1)}-${pad2(beijing.getUTCDate())}`;
}

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function uploadOne(img: PickedImage, openid: string): Promise<string> {
  const compressed = await maybeCompress(img);
  const cloudPath = `chat-images/${todayPath()}/${openid.slice(0, 8)}-${Date.now()}-${randSuffix()}.jpg`;
  const r = await wx.cloud.uploadFile({ cloudPath, filePath: compressed });
  return r.fileID;
}

/** 一次选多张 + 并行上传，返回 fileID 数组（顺序与选图顺序一致） */
export async function pickAndUpload(currentCount: number, openid: string): Promise<string[]> {
  const picked = await pickImages(currentCount);
  if (!picked.length) return [];
  const results = await Promise.all(picked.map((p) => uploadOne(p, openid).catch(() => '')));
  return results.filter((f) => !!f);
}
