import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../utils/api';

describe('storage', () => {
  let store: Record<string, unknown> = {};

  beforeEach(() => {
    store = {};
    (globalThis as any).wx.getStorageSync = vi.fn((k: string) => store[k] ?? '');
    (globalThis as any).wx.setStorageSync = vi.fn((k: string, v: unknown) => {
      store[k] = v;
    });
    (globalThis as any).wx.removeStorageSync = vi.fn((k: string) => {
      delete store[k];
    });
  });

  it('loadHistory returns empty array for new openid', async () => {
    const { loadHistory } = await import('../../utils/storage');
    expect(loadHistory('oA')).toEqual([]);
  });

  it('appendHistory stores and retrieves', async () => {
    const { loadHistory, appendHistory } = await import('../../utils/storage');
    const msg: ChatMessage = { role: 'user', content: 'hi' };
    appendHistory('oA', msg);
    expect(loadHistory('oA')).toHaveLength(1);
  });

  it('appendHistory caps at MAX_LOCAL_HISTORY (keeps tail)', async () => {
    const { appendHistory, loadHistory } = await import('../../utils/storage');
    for (let i = 0; i < 60; i++) {
      appendHistory('oA', { role: 'user', content: `m${i}` });
    }
    const h = loadHistory('oA');
    expect(h).toHaveLength(50);
    expect(h[0].content).toBe('m10');
    expect(h[49].content).toBe('m59');
  });

  it('isolates history per openid', async () => {
    const { appendHistory, loadHistory } = await import('../../utils/storage');
    appendHistory('oA', { role: 'user', content: 'a' });
    appendHistory('oB', { role: 'user', content: 'b' });
    expect(loadHistory('oA')[0].content).toBe('a');
    expect(loadHistory('oB')[0].content).toBe('b');
  });

  it('clearHistory removes by openid', async () => {
    const { appendHistory, clearHistory, loadHistory } = await import('../../utils/storage');
    appendHistory('oA', { role: 'user', content: 'x' });
    clearHistory('oA');
    expect(loadHistory('oA')).toEqual([]);
  });
});
