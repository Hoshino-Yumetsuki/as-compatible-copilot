import type { AssistantContent, ModelMessage, ToolContent, UserContent } from 'ai';

export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible' | 'openai-responses';

export interface ModelConfig {
  id: string;
  name?: string;
  provider: ProviderKind;
  model: string;
  baseURL?: string;
  profileId?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
}

export interface InputPart {
  type: 'text' | 'tool-call' | 'tool-result' | 'data';
  value?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  content?: readonly InputPart[];
  data?: Uint8Array;
  mimeType?: string;
}

export interface InputMessage {
  role: 'system' | 'user' | 'assistant';
  name?: string;
  content: readonly InputPart[];
}

function text(parts: readonly InputPart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.value ?? '')
    .join('');
}

export function toModelMessages(messages: readonly InputMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    if (message.role === 'system') {
      return { role: 'system', content: text(message.content) };
    }
    if (message.role === 'assistant') {
      const content: AssistantContent = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.value ?? '' });
        } else if (part.type === 'tool-call' && part.callId && part.name) {
          toolNames.set(part.callId, part.name);
          content.push({
            type: 'tool-call',
            toolCallId: part.callId,
            toolName: part.name,
            input: part.input ?? {}
          });
        }
      }
      return { role: 'assistant', content };
    }

    const toolResults: ToolContent = [];
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.callId) {
        toolResults.push({
          type: 'tool-result',
          toolCallId: part.callId,
          toolName: toolNames.get(part.callId) ?? part.name ?? 'tool',
          output: { type: 'text', value: text(part.content ?? []) }
        });
      }
    }
    if (toolResults.length) {
      return { role: 'tool', content: toolResults };
    }

    const content: UserContent = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.value ?? '' });
      } else if (part.type === 'data' && part.data && part.mimeType?.startsWith('image/')) {
        content.push({ type: 'image', image: part.data, mediaType: part.mimeType });
      }
    }
    return { role: 'user', content };
  });
}

export function estimateTokens(value: string | InputMessage): number {
  const source =
    typeof value === 'string'
      ? value
      : value.content
          .map((part) => {
            if (part.type === 'text') {
              return part.value ?? '';
            }
            if (part.type === 'data') {
              return part.data ? 'x'.repeat(Math.ceil(part.data.byteLength / 3)) : '';
            }
            return JSON.stringify(part.input ?? part.content ?? '');
          })
          .join('');
  return Math.max(1, Math.ceil(Buffer.byteLength(source, 'utf8') / 4));
}

export function formatUsage(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
): string | undefined {
  if (!usage) {
    return undefined;
  }
  const values = [
    usage.inputTokens === undefined ? undefined : `input=${usage.inputTokens}`,
    usage.outputTokens === undefined ? undefined : `output=${usage.outputTokens}`,
    usage.totalTokens === undefined ? undefined : `total=${usage.totalTokens}`
  ].filter(Boolean);
  return values.length ? `usage ${values.join(' ')}` : undefined;
}
