import tcb from '@cloudbase/node-sdk';
import type { ChatMessage, LLMProvider } from './types.js';

export type CloudBaseProviderName = 'hunyuan-exp' | 'deepseek';

export interface CloudBaseConfig {
  envId: string;
  providerName: CloudBaseProviderName;
  model: string;
  secretId?: string;
  secretKey?: string;
}

export class CloudBaseProvider implements LLMProvider {
  readonly name: string;
  private model: ReturnType<ReturnType<typeof tcb.init>['ai']>['createModel'] extends (n: string) => infer M
    ? M
    : never;

  constructor(private readonly cfg: CloudBaseConfig) {
    this.name = `cloudbase-${cfg.providerName === 'hunyuan-exp' ? 'hunyuan' : cfg.providerName}`;
    const init: Parameters<typeof tcb.init>[0] = { env: cfg.envId };
    if (cfg.secretId && cfg.secretKey) {
      init.secretId = cfg.secretId;
      init.secretKey = cfg.secretKey;
    }
    const app = tcb.init(init);
    const ai = app.ai();
    this.model = ai.createModel(cfg.providerName);
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const result = await this.model.generateText({
      model: this.cfg.model,
      // ChatMessage shape matches cloudbase simple message types; assistant variants with tool_calls aren't used here
      messages: messages as never,
    });
    return result.text;
  }
}
