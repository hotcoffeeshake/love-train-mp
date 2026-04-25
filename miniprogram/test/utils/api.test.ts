import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('callBackend', () => {
  beforeEach(() => {
    (globalThis as any).wx.cloud.callContainer = vi.fn();
  });

  it('passes path/method/data to wx.cloud.callContainer', async () => {
    (globalThis as any).wx.cloud.callContainer.mockResolvedValue({
      statusCode: 200,
      data: { ok: true },
    });
    const { callBackend } = await import('../../utils/api');
    const res = await callBackend('/health', 'GET');
    expect(res).toEqual({ ok: true });

    const call = (globalThis as any).wx.cloud.callContainer.mock.calls[0][0];
    expect(call.path).toBe('/health');
    expect(call.method).toBe('GET');
    expect(call.header['X-WX-SERVICE']).toBe('love-train-mp3');
  });

  it('throws BackendError with code on non-200', async () => {
    (globalThis as any).wx.cloud.callContainer.mockResolvedValue({
      statusCode: 429,
      data: { error: 'RATE_LIMIT', message: '额度耗尽', remainingUses: 0 },
    });
    const { callBackend, BackendError } = await import('../../utils/api');
    try {
      await callBackend('/chat', 'POST');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BackendError);
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe('RATE_LIMIT');
    }
  });

  it('throws BackendError NETWORK when callContainer rejects', async () => {
    (globalThis as any).wx.cloud.callContainer.mockRejectedValue(new Error('offline'));
    const { callBackend, BackendError } = await import('../../utils/api');
    try {
      await callBackend('/health', 'GET');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BackendError);
      expect(err.code).toBe('NETWORK');
    }
  });
});
