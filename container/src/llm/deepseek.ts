import type { ChatMessage, LLMProvider } from './types.js';

export interface DeepSeekConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
}

export class DeepSeekProvider implements LLMProvider {
  name = 'deepseek';

  constructor(private readonly cfg: DeepSeekConfig) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const res = await fetch(this.cfg.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DeepSeek ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }
}
