import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider } from '../../src/llm/deepseek.js';

describe('DeepSeekProvider', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('calls DeepSeek API and returns content', async () => {
    (global.fetch as typeof fetch & { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '兄弟你稳住' } }] }),
    } as Response);

    const provider = new DeepSeekProvider({
      apiKey: 'k',
      apiUrl: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
    });
    const out = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('兄弟你稳住');

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toContain('deepseek.com');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('throws on non-OK response', async () => {
    (global.fetch as typeof fetch & { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    } as Response);

    const provider = new DeepSeekProvider({ apiKey: 'k', apiUrl: 'u', model: 'm' });
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/);
  });
});
