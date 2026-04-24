import type { AppConfig } from '../config.js';
import { DeepSeekProvider } from './deepseek.js';
import type { LLMProvider } from './types.js';

export function createProvider(cfg: AppConfig): LLMProvider {
  switch (cfg.llm.provider) {
    case 'deepseek':
      return new DeepSeekProvider(cfg.llm);
    case 'hunyuan':
    case 'claude':
      throw new Error(`Provider '${cfg.llm.provider}' not implemented in M1 (see M4)`);
  }
}
