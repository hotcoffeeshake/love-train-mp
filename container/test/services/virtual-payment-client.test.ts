import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyVirtualGoodsProvided } from '../../src/services/virtual-payment-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notifyVirtualGoodsProvided', () => {
  it('sends pay_sig for xpay goods delivery confirmation', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/cgi-bin/token')) {
          return { json: async () => ({ access_token: 'access-token', expires_in: 7200 }) };
        }
        return { json: async () => ({ errcode: 0, errmsg: 'ok' }) };
      }),
    );

    const cfg = {
      wxAppId: 'appid',
      wxAppSecret: 'secret',
      virtualPayment: {
        appKey: 'virtual-app-key',
        env: 0,
      },
    } as any;

    await notifyVirtualGoodsProvided(cfg, 'LT202605180325442B81FD');

    const xpayUrl = calls.find((url) => url.includes('/xpay/notify_provide_goods'));
    expect(xpayUrl).toBeDefined();
    const parsed = new URL(xpayUrl!);
    const bodyJson = JSON.stringify({
      order_id: 'LT202605180325442B81FD',
      env: 0,
    });
    const expectedSig = createHmac('sha256', 'virtual-app-key')
      .update(`/xpay/notify_provide_goods&${bodyJson}`)
      .digest('hex');
    expect(parsed.searchParams.get('pay_sig')).toBe(expectedSig);
  });
});
