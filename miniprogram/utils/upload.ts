// 图片选择 + 压缩 + 上传到云存储

const MAX_IMAGES = 5;
const COMPRESS_THRESHOLD_KB = 200; // 大于 200KB 就压缩
const COMPRESS_QUALITY = 50; // 质量 50，文件小很多但视觉 OK
const RECOMPRESS_QUALITY = 30; // 还是太大就再压一轮
const HARD_TARGET_KB = 500; // 单图目标 ≤ 500KB

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
  let path = await compressOnce(img.tempPath, COMPRESS_QUALITY);
  let size = await getFileSize(path);
  if (size > HARD_TARGET_KB * 1024) {
    path = await compressOnce(path, RECOMPRESS_QUALITY);
  }
  return path;
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
