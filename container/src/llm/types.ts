export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type StreamChunkHandler = (delta: string) => void;

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[]): Promise<string>;
  chatStream?(messages: ChatMessage[], onDelta: StreamChunkHandler): Promise<string>;
}
