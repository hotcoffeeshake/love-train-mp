import type { AppConfig } from '../config.js';
import { CloudBaseProvider } from './cloudbase.js';
import { DeepSeekProvider } from './deepseek.js';
import type { LLMProvider } from './types.js';

export function createProvider(cfg: AppConfig): LLMProvider {
  switch (cfg.llm.provider) {
    case 'cloudbase-hunyuan':
      if (!cfg.cloudbaseEnvId) {
        throw new Error('CLOUDBASE_ENV_ID required for cloudbase-hunyuan');
      }
      return new CloudBaseProvider({
        envId: cfg.cloudbaseEnvId,
        providerName: 'hunyuan-exp',
        model: cfg.llm.model,
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      });
    case 'cloudbase-deepseek':
      if (!cfg.cloudbaseEnvId) {
        throw new Error('CLOUDBASE_ENV_ID required for cloudbase-deepseek');
      }
      return new CloudBaseProvider({
        envId: cfg.cloudbaseEnvId,
        providerName: 'deepseek',
        model: cfg.llm.model,
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      });
    case 'cloudbase-deepseek-custom':
      if (!cfg.cloudbaseEnvId) {
        throw new Error('CLOUDBASE_ENV_ID required for cloudbase-deepseek-custom');
      }
      return new CloudBaseProvider({
        envId: cfg.cloudbaseEnvId,
        // 用户在 CloudBase 控制台自建的模型厂商，名字必须和控制台里一致
        providerName: 'deepseek-open-custom',
        model: cfg.llm.model,
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      });
    case 'deepseek':
      return new DeepSeekProvider(cfg.llm);
    case 'hunyuan':
    case 'claude':
      throw new Error(`Provider '${cfg.llm.provider}' not implemented in M1 (see M4)`);
  }
}
