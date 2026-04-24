import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads LLM_PROVIDER with default deepseek', async () => {
    delete process.env.LLM_PROVIDER;
    process.env.LLM_API_KEY = 'k';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().llm.provider).toBe('deepseek');
  });

  it('throws when LLM_API_KEY missing', async () => {
    delete process.env.LLM_API_KEY;
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/LLM_API_KEY/);
  });

  it('DAILY_QUOTA default 10', async () => {
    delete process.env.DAILY_QUOTA;
    process.env.LLM_API_KEY = 'k';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().dailyQuota).toBe(10);
  });
});
