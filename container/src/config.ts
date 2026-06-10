export type LLMProviderName =
  | 'cloudbase-hunyuan'
  | 'cloudbase-deepseek'
  | 'cloudbase-deepseek-custom'
  | 'deepseek'
  | 'hunyuan'
  | 'claude';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  dailyQuota: number;
  wxAppId: string;
  wxAppSecret: string;
  cloudbaseEnvId: string;
  llm: {
    provider: LLMProviderName;
    apiKey: string;
    apiUrl: string;
    model: string;
    timeoutMs: number;
  };
  invite: {
    rewardInviter: number;
    rewardInvitee: number;
    bindWindowDays: number;
  };
  dailyLimit: { free: number; paid: number };
  subscription: { amountCents: number; periodDays: number };
  wxpay: {
    mode: 'mock' | 'real';
    appid: string;
    mchid: string;
    apiV3Key: string;
    certSerial: string;
    privateKeyPath: string;
    privateKey: string;
    notifyUrl: string;
  };
  virtualPayment: {
    mode: 'mock' | 'real';
    offerId: string;
    appKey: string;
    env: 0 | 1;
    currencyType: 'CNY';
    productId: string;
    goodsPrice: number;
  };
  wechatMessage: {
    token: string;
  };
  admin: { token: string; uiPathSegment: string };
}

const VALID_PROVIDERS: LLMProviderName[] = [
  'cloudbase-hunyuan',
  'cloudbase-deepseek',
  'cloudbase-deepseek-custom',
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
    'cloudbase-deepseek-custom': { url: '', model: 'deepseek-chat' },
    deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    hunyuan: { url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-turbos-latest' },
    claude: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
  };

  const isCloudBase = provider.startsWith('cloudbase-');

  const wxpayMode = (process.env.WXPAY_MODE ?? 'mock') as 'mock' | 'real';
  const virtualPaymentMode = (process.env.VIRTUAL_PAYMENT_MODE ?? 'mock') as 'mock' | 'real';
  if (wxpayMode === 'real') {
    for (const k of ['WXPAY_APPID','WXPAY_MCHID','WXPAY_API_V3_KEY','WXPAY_CERT_SERIAL','WXPAY_NOTIFY_URL']) {
      if (!process.env[k]) throw new Error(`WXPAY_MODE=real but missing env: ${k}`);
    }
    if (!process.env.WXPAY_PRIVATE_KEY && !process.env.WXPAY_PRIVATE_KEY_BASE64 && !process.env.WXPAY_PRIVATE_KEY_PATH) {
      throw new Error('WXPAY_MODE=real but missing env: WXPAY_PRIVATE_KEY or WXPAY_PRIVATE_KEY_BASE64 or WXPAY_PRIVATE_KEY_PATH');
    }
  }
  if (!['mock', 'real'].includes(virtualPaymentMode)) {
    throw new Error(`Invalid VIRTUAL_PAYMENT_MODE: ${virtualPaymentMode}`);
  }

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    dailyQuota: Number(process.env.DAILY_QUOTA ?? 10),
    wxAppId: process.env.WX_APPID ?? '',
    wxAppSecret: process.env.WX_APPSECRET ?? '',
    cloudbaseEnvId: process.env.CLOUDBASE_ENV_ID ?? '',
    llm: {
      provider,
      // CloudBase providers don't need apiKey (env-injected auth in cloud hosting)
      apiKey: isCloudBase ? (process.env.LLM_API_KEY ?? '') : required('LLM_API_KEY', process.env.LLM_API_KEY),
      apiUrl: process.env.LLM_API_URL ?? defaults[provider].url,
      model: process.env.LLM_MODEL ?? defaults[provider].model,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 90000),
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
    subscription: {
      amountCents: Number(process.env.SUBSCRIPTION_AMOUNT_CENTS ?? 2000),
      periodDays: Number(process.env.SUBSCRIPTION_PERIOD_DAYS ?? 30),
    },
    wxpay: {
      mode: wxpayMode,
      appid: process.env.WXPAY_APPID ?? '',
      mchid: process.env.WXPAY_MCHID ?? '',
      apiV3Key: process.env.WXPAY_API_V3_KEY ?? '',
      certSerial: process.env.WXPAY_CERT_SERIAL ?? '',
      privateKeyPath: process.env.WXPAY_PRIVATE_KEY_PATH ?? '',
      privateKey: process.env.WXPAY_PRIVATE_KEY_BASE64
        ? Buffer.from(process.env.WXPAY_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
        : (process.env.WXPAY_PRIVATE_KEY ?? ''),
      notifyUrl: process.env.WXPAY_NOTIFY_URL ?? '',
    },
    virtualPayment: {
      mode: virtualPaymentMode,
      offerId: process.env.VIRTUAL_PAYMENT_OFFER_ID ?? '',
      appKey: process.env.VIRTUAL_PAYMENT_APP_KEY ?? '',
      env: Number(process.env.VIRTUAL_PAYMENT_ENV ?? 0) === 1 ? 1 : 0,
      currencyType: 'CNY',
      productId: process.env.VIRTUAL_PAYMENT_PRODUCT_ID ?? '',
      goodsPrice: Number(process.env.VIRTUAL_PAYMENT_GOODS_PRICE_CENTS ?? process.env.SUBSCRIPTION_AMOUNT_CENTS ?? 2000),
    },
    wechatMessage: {
      token: process.env.WECHAT_MESSAGE_TOKEN ?? '',
    },
    admin: {
      token: process.env.ADMIN_TOKEN ?? '',
      uiPathSegment: process.env.ADMIN_UI_PATH_SEGMENT ?? 'ui-x9k2',
    },
  };
}
