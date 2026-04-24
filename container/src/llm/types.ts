export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[]): Promise<string>;
}
