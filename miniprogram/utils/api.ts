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

export const api = {
  me: () => callBackend<UserInfo>('/auth/me', 'GET'),
  updateProfile: (d: { nickname?: string; avatarUrl?: string }) =>
    callBackend<{ ok: true }>('/user/profile', 'POST', d),
  quota: () => callBackend<QuotaResponse>('/user/quota', 'GET'),
  chat: (messages: ChatMessage[]) =>
    callBackend<ChatResponse>('/chat', 'POST', { messages, stream: false }),
};
