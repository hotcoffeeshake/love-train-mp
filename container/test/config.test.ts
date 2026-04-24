import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('default provider is cloudbase-hunyuan (no api key needed)', async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    process.env.CLOUDBASE_ENV_ID = 'env-xxx';
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig();
    expect(cfg.llm.provider).toBe('cloudbase-hunyuan');
    expect(cfg.llm.model).toBe('hunyuan-2.0-instruct-20251111');
  });

  it('cloudbase-deepseek provider uses deepseek-v3.2 default model', async () => {
    process.env.LLM_PROVIDER = 'cloudbase-deepseek';
    delete process.env.LLM_API_KEY;
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().llm.model).toBe('deepseek-v3.2');
  });

  it('external deepseek still requires LLM_API_KEY', async () => {
    process.env.LLM_PROVIDER = 'deepseek';
    delete process.env.LLM_API_KEY;
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/LLM_API_KEY/);
  });

  it('rejects invalid provider', async () => {
    process.env.LLM_PROVIDER = 'bogus';
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow(/Invalid LLM_PROVIDER/);
  });

  it('DAILY_QUOTA default 10', async () => {
    delete process.env.DAILY_QUOTA;
    delete process.env.LLM_API_KEY;
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().dailyQuota).toBe(10);
  });

  it('reads CLOUDBASE_ENV_ID', async () => {
    process.env.CLOUDBASE_ENV_ID = 'love-train-mp-abc';
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig().cloudbaseEnvId).toBe('love-train-mp-abc');
  });
});
