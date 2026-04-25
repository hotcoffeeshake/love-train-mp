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
  | { type: 'error'; code: string; message: string };

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
  let buffer = '';
  let aborted = false;

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
    else if (obj.type === 'done') cb.onDone(obj.remainingUses);
    else if (obj.type === 'warning') cb.onWarning?.(obj.message);
    else if (obj.type === 'error') cb.onError(obj.code, obj.message);
  };

  const task = wx.cloud.callContainer({
    path: '/chat',
    method: 'POST',
    header: {
      'X-WX-SERVICE': CLOUD_CONTAINER_SERVICE,
      'content-type': 'application/json',
    },
    data: { messages, stream: true },
    enableChunked: true,
    success: (res: ICloud.CallContainerResult) => {
      if (aborted) return;
      if (res.statusCode >= 400) {
        const data = (res.data as { error?: string; message?: string }) || {};
        cb.onError(data.error ?? `HTTP_${res.statusCode}`, data.message ?? '请求失败');
        return;
      }

      // 兜底：当基础库不真正走 chunked，data 会是完整字符串（NDJSON）或对象
      const raw = res.data as unknown;
      if (typeof raw === 'string') {
        // 整段 NDJSON：按行解析
        const lines = raw.split('\n');
        for (const line of lines) handleChunk(line);
        return;
      }
      if (raw && typeof raw === 'object') {
        const obj = raw as { content?: string; remainingUses?: number; error?: string; message?: string };
        if (typeof obj.content === 'string') {
          cb.onDelta(obj.content);
          cb.onDone(typeof obj.remainingUses === 'number' ? obj.remainingUses : 0);
          return;
        }
        if (obj.error) {
          cb.onError(obj.error, obj.message ?? 'unknown error');
        }
      }
    },
    fail: (err: { errMsg?: string }) => {
      if (aborted) return;
      cb.onError('NETWORK', err?.errMsg ?? '网络错误');
    },
  } as unknown as ICloud.CallContainerParam) as unknown as WechatMiniprogram.RequestTask;

  // chunked 数据流入
  if (task && typeof (task as any).onChunkReceived === 'function') {
    (task as any).onChunkReceived((res: { data: ArrayBuffer }) => {
      if (aborted) return;
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
