import { CLOUD_CONTAINER_SERVICE } from './consts';

export interface UserInfo {
  openid: string;
  nickname: string;
  avatarUrl: string;
  remainingUses: number;
  totalUses: number;
  isNewUser: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  fileIDs?: string[];
}

export interface ChatResponse {
  content: string;
  remainingUses: number;
}

export interface QuotaResponse {
  remainingUses: number;
  dailyLimit: number;
  resetAt: string;
}

export class BackendError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export async function callBackend<T>(
  path: string,
  method: 'GET' | 'POST',
  data?: unknown,
): Promise<T> {
  let res: ICloud.CallContainerResult;
  try {
    res = await wx.cloud.callContainer({
      path,
      method,
      header: {
        'X-WX-SERVICE': CLOUD_CONTAINER_SERVICE,
        'content-type': 'application/json',
      },
      data,
    });
  } catch (err) {
    throw new BackendError(0, 'NETWORK', (err as Error)?.message ?? 'network error');
  }

  const body = res.data as { error?: string; message?: string } | T;
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const b = body as { error?: string; message?: string };
    throw new BackendError(
      res.statusCode,
      b?.error ?? 'UNKNOWN',
      b?.message ?? `HTTP ${res.statusCode}`,
    );
  }
  return body as T;
}

// ── 流式聊天 ────────────────────────────────────────────────

export type ChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'done'; remainingUses: number }
  | { type: 'warning'; message: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' };

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onDone: (remainingUses: number) => void;
  onError: (code: string, message: string) => void;
  onWarning?: (message: string) => void;
}

function utf8Decode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // 微信小程序基础库 ≥ 2.7.0 提供 TextDecoder 全局
  const TD = (globalThis as { TextDecoder?: new (label?: string) => { decode(b: Uint8Array): string } }).TextDecoder;
  if (TD) {
    return new TD('utf-8').decode(bytes);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

/**
 * 流式调用 /chat。基础库 ≥ 2.20 支持 enableChunked + onChunkReceived。
 * 后端按 NDJSON（每行一个 ChatChunk）逐块输出。
 */
export function chatStream(
  messages: ChatMessage[],
  cb: StreamCallbacks,
): { abort: () => void } {
  // 版本标记 —— 在 console 里能看到 API_VER=v4 说明跑的是最新代码（关闭 enableChunked）
  console.log('[lt] chatStream API_VER=v4-no-chunked');
  let buffer = '';
  let aborted = false;
  // 标记是否已经走过 chunk 路径。用来避免 onChunkReceived 已经处理完之后，
  // success 回调再用 fallback 解析空 / 残缺的 res.data，重复触发 onDone(0)。
  let chunkPathActive = false;
  let doneFired = false;

  const handleChunk = (jsonLine: string) => {
    const trimmed = jsonLine.trim();
    if (!trimmed) return;
    let obj: ChatChunk;
    try {
      obj = JSON.parse(trimmed) as ChatChunk;
    } catch {
      return;
    }
    if (obj.type === 'delta') cb.onDelta(obj.text);
    else if (obj.type === 'done') {
      doneFired = true;
      cb.onDone(obj.remainingUses);
    }
    else if (obj.type === 'warning') cb.onWarning?.(obj.message);
    else if (obj.type === 'error') cb.onError(obj.code, obj.message);
    // 'ping' 心跳忽略
  };

  const task = wx.cloud.callContainer({
    path: '/chat',
    method: 'POST',
    header: {
      'X-WX-SERVICE': CLOUD_CONTAINER_SERVICE,
      'content-type': 'application/json',
    },
    data: { messages, stream: true },
    // 注：wx.cloud.callContainer 在当前基础库（3.15.x）下，enableChunked + onChunkReceived
    // 实测不工作：success 收到空字符串，chunks 全丢。所以关掉，让微信汇总后一次性给 string，
    // 走 fallback 解析 NDJSON。代价是无真流式（一次性出整段），但保证能收到回复。
    // 102002 网关空闲超时风险：单请求都是 < 30s，单实例不超时；后端仍写 ndjson 但 WX 会 buffer。
    timeout: 90000,
    success: (res: ICloud.CallContainerResult) => {
      const dataPreview =
        typeof res.data === 'string'
          ? `len=${(res.data as string).length} head=${(res.data as string).slice(0, 200)}`
          : res.data instanceof ArrayBuffer
            ? `arrayBuffer byteLen=${(res.data as ArrayBuffer).byteLength}`
            : JSON.stringify(res.data).slice(0, 200);
      console.log('[lt] success fired chunkPathActive=', chunkPathActive, 'doneFired=', doneFired, 'statusCode=', res.statusCode, 'dataType=', typeof res.data, 'preview:', dataPreview);
      if (aborted) return;
      if (res.statusCode >= 400) {
        const data = (res.data as { error?: string; message?: string }) || {};
        cb.onError(data.error ?? `HTTP_${res.statusCode}`, data.message ?? '请求失败');
        return;
      }

      // 关键：只要 chunk 路径激活过，就由 chunk 路径独占处理。
      // 否则 success 回调会用一个空 / 残缺的 res.data 二次调用 onDone(0)，把配额清零。
      // （即使 doneFired 还没触发也跳过——'done' 行马上会从最后一个 chunk 里来。）
      if (chunkPathActive) {
        // 兜底：万一 chunk 路径漏了 'done'，给个超时清 sending 状态
        if (!doneFired) {
          setTimeout(() => {
            if (!doneFired && !aborted) cb.onDone(-1);
          }, 2000);
        }
        return;
      }

      // 兜底：当基础库不真正走 chunked，data 会是完整字符串（NDJSON）或对象。
      // 把所有 delta 合并成一次回调，避免连续 setData 卡死渲染。
      const raw = res.data as unknown;
      if (typeof raw === 'string') {
        let merged = '';
        let remaining = 0;
        let errorCode: string | null = null;
        let errorMsg = '';
        const lines = raw.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const o = JSON.parse(trimmed) as ChatChunk;
            if (o.type === 'delta') merged += o.text;
            else if (o.type === 'done') remaining = o.remainingUses;
            else if (o.type === 'warning') cb.onWarning?.(o.message);
            else if (o.type === 'error') { errorCode = o.code; errorMsg = o.message; }
          } catch { /* ignore */ }
        }
        if (errorCode) {
          cb.onError(errorCode, errorMsg);
          return;
        }
        if (merged) cb.onDelta(merged);
        cb.onDone(remaining);
        return;
      }
      if (raw && typeof raw === 'object') {
        const obj = raw as { type?: string; content?: string; remainingUses?: number; error?: string; code?: string; message?: string };
        // 微信把单行 NDJSON（如 {"type":"error",...}）当成 JSON object 解析时走这里
        if (obj.type === 'error') {
          cb.onError(obj.code ?? 'UNKNOWN', obj.message ?? '未知错误');
          return;
        }
        if (typeof obj.content === 'string') {
          cb.onDelta(obj.content);
          cb.onDone(typeof obj.remainingUses === 'number' ? obj.remainingUses : 0);
          return;
        }
        if (obj.error) {
          cb.onError(obj.error, obj.message ?? 'unknown error');
          return;
        }
        // 啥都没匹配上，至少别静默挂死
        cb.onError('BAD_RESPONSE', '后端返回格式不识别');
      }
    },
    fail: (err: { errMsg?: string }) => {
      if (aborted) return;
      cb.onError('NETWORK', err?.errMsg ?? '网络错误');
    },
  } as unknown as ICloud.CallContainerParam) as unknown as WechatMiniprogram.RequestTask;

  // chunked 数据流入
  if (task && typeof (task as any).onChunkReceived === 'function') {
    console.log('[lt] onChunkReceived hook installed');
    (task as any).onChunkReceived((res: { data: ArrayBuffer }) => {
      if (aborted) return;
      if (!chunkPathActive) console.log('[lt] FIRST chunk received, byteLen=', (res.data as ArrayBuffer).byteLength);
      chunkPathActive = true;
      buffer += utf8Decode(res.data);
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleChunk(line);
        nl = buffer.indexOf('\n');
      }
    });
  }

  return {
    abort: () => {
      aborted = true;
      try { (task as any)?.abort?.(); } catch {}
    },
  };
}

export const api = {
  me: () => callBackend<UserInfo>('/auth/me', 'GET'),
  updateProfile: (d: { nickname?: string; avatarUrl?: string }) =>
    callBackend<{ ok: true }>('/user/profile', 'POST', d),
  quota: () => callBackend<QuotaResponse>('/user/quota', 'GET'),
  chat: (messages: ChatMessage[]) =>
    callBackend<ChatResponse>('/chat', 'POST', { messages, stream: false }),
  chatStream,
};
