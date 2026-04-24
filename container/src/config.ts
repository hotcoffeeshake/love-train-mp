export type LLMProviderName = 'deepseek' | 'hunyuan' | 'claude';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  dailyQuota: number;
  wxAppId: string;
  llm: {
    provider: LLMProviderName;
    apiKey: string;
    apiUrl: string;
    model: string;
  };
}

function required(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }

  return value;
}

export function loadConfig(): AppConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'deepseek') as LLMProviderName;
  if (!['deepseek', 'hunyuan', 'claude'].includes(provider)) {
    throw new Error(`Invalid LLM_PROVIDER: ${provider}`);
  }

  const defaults: Record<LLMProviderName, { url: string; model: string }> = {
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    hunyuan: { url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-turbos-latest' },
    claude: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
  };

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    dailyQuota: Number(process.env.DAILY_QUOTA ?? 10),
    wxAppId: process.env.WX_APPID ?? '',
    llm: {
      provider,
      apiKey: required('LLM_API_KEY', process.env.LLM_API_KEY),
      apiUrl: process.env.LLM_API_URL ?? defaults[provider].url,
      model: process.env.LLM_MODEL ?? defaults[provider].model,
    },
  };
}
