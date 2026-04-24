import { MAX_LOCAL_HISTORY } from './consts';
import type { ChatMessage } from './api';

const keyFor = (openid: string) => `chat:history:${openid}`;
const DRAFT_KEY = 'chat:draft';

export function loadHistory(openid: string): ChatMessage[] {
  const raw = wx.getStorageSync(keyFor(openid));
  if (!raw) return [];
  try {
    const arr = raw as ChatMessage[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function appendHistory(openid: string, msg: ChatMessage): void {
  const current = loadHistory(openid);
  current.push(msg);
  const trimmed =
    current.length > MAX_LOCAL_HISTORY
      ? current.slice(current.length - MAX_LOCAL_HISTORY)
      : current;
  wx.setStorageSync(keyFor(openid), trimmed);
}

export function clearHistory(openid: string): void {
  wx.removeStorageSync(keyFor(openid));
}

export function loadDraft(): string {
  return (wx.getStorageSync(DRAFT_KEY) as string) || '';
}

export function saveDraft(text: string): void {
  wx.setStorageSync(DRAFT_KEY, text);
}

export function clearDraft(): void {
  wx.removeStorageSync(DRAFT_KEY);
}
