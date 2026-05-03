export type LLMProviderName =
  | 'cloudbase-hunyuan'
  | 'cloudbase-deepseek'
  | 'deepseek'
  | 'hunyuan'
  | 'claude';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  dailyQuota: number;
  wxAppId: string;
  cloudbaseEnvId: string;
  llm: {
    provider: LLMProviderName;
    apiKey: string;
    apiUrl: string;
    model: string;
  };
  invite: {
    rewardInviter: number;
    rewardInvitee: number;
    bindWindowDays: number;
  };
  dailyLimit: { free: number; paid: number };
}

const VALID_PROVIDERS: LLMProviderName[] = [
  'cloudbase-hunyuan',
  'cloudbase-deepseek',
  'deepseek',
  'hunyuan',
  'claude',
];

function required(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }

  return value;
}

export function loadConfig(): AppConfig {
  const provider = (process.env.LLM_PROVIDER ?? 'cloudbase-hunyuan') as LLMProviderName;
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(`Invalid LLM_PROVIDER: ${provider}`);
  }

  const defaults: Record<LLMProviderName, { url: string; model: string }> = {
    'cloudbase-hunyuan': { url: '', model: 'hunyuan-2.0-instruct-20251111' },
    'cloudbase-deepseek': { url: '', model: 'deepseek-v3.2' },
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    hunyuan: { url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-turbos-latest' },
    claude: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
  };

  const isCloudBase = provider.startsWith('cloudbase-');

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    dailyQuota: Number(process.env.DAILY_QUOTA ?? 10),
    wxAppId: process.env.WX_APPID ?? '',
    cloudbaseEnvId: process.env.CLOUDBASE_ENV_ID ?? '',
    llm: {
      provider,
      // CloudBase providers don't need apiKey (env-injected auth in cloud hosting)
      apiKey: isCloudBase ? (process.env.LLM_API_KEY ?? '') : required('LLM_API_KEY', process.env.LLM_API_KEY),
      apiUrl: process.env.LLM_API_URL ?? defaults[provider].url,
      model: process.env.LLM_MODEL ?? defaults[provider].model,
    },
    invite: {
      rewardInviter: Number(process.env.INVITE_REWARD_INVITER ?? 5),
      rewardInvitee: Number(process.env.INVITE_REWARD_INVITEE ?? 5),
      bindWindowDays: Number(process.env.INVITE_BIND_WINDOW_DAYS ?? 7),
    },
    dailyLimit: {
      free: Number(process.env.DAILY_LIMIT_FREE ?? process.env.DAILY_QUOTA ?? 10),
      paid: Number(process.env.DAILY_LIMIT_PAID ?? 30),
    },
  };
}
