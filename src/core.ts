import type { AssistantContent, ModelMessage, ToolContent, UserContent } from 'ai';

export type ProviderKind = 'anthropic' | 'google' | 'openai-compatible' | 'openai-responses';

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_CONTEXT_LENGTH = 256000;

export interface ModelConfig {
  id: string;
  name?: string;
  provider: ProviderKind;
  model: string;
  baseURL?: string;
  profileId?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextLength?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface ExtensionSettings {
  reasoningEffort: ReasoningEffort;
  contextLength: number;
  modelOverrides: Record<string, ModelOverride>;
}

export interface ModelOverride {
  contextLength?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const overrides: Record<string, ModelOverride> = {};
  const storedOverrides = candidate.modelOverrides;
  if (storedOverrides && typeof storedOverrides === 'object' && !Array.isArray(storedOverrides)) {
    for (const [id, raw] of Object.entries(storedOverrides)) {
      if (!id || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue;
      }
      const source = raw as Record<string, unknown>;
      const override: ModelOverride = {};
      const contextLength = positiveInteger(source.contextLength);
      if (contextLength !== undefined) override.contextLength = contextLength;
      if (typeof source.toolCalling === 'boolean') override.toolCalling = source.toolCalling;
      if (typeof source.imageInput === 'boolean') override.imageInput = source.imageInput;
      if (Object.keys(override).length) overrides[id] = override;
    }
  }
  return {
    reasoningEffort: isReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : 'medium',
    contextLength: positiveInteger(candidate.contextLength) ?? DEFAULT_CONTEXT_LENGTH,
    modelOverrides: overrides
  };
}

export function reasoningProviderOptions(
  model: ModelConfig
): Record<string, Record<string, unknown>> | undefined {
  if (model.provider === 'anthropic') {
    return { anthropic: { effort: model.reasoningEffort } };
  }
  if (model.provider === 'openai-responses') {
    return { openai: { reasoningEffort: model.reasoningEffort } };
  }
  return undefined;
}

export function assertModelCapabilities(
  model: ModelConfig,
  messages: readonly InputMessage[],
  requiresTools: boolean
): void {
  if (model.toolCalling === false && requiresTools) {
    throw new Error(`Tool calling is disabled for ${model.id}.`);
  }
  if (
    model.imageInput === false &&
    messages.some((message) =>
      message.content.some((part) => part.type === 'data' && part.mimeType?.startsWith('image/'))
    )
  ) {
    throw new Error(`Image input is disabled for ${model.id}.`);
  }
}

export function effectiveModelConfig(model: ModelConfig, settings: ExtensionSettings): ModelConfig {
  const override = settings.modelOverrides[model.id];
  return {
    ...model,
    contextLength: override?.contextLength ?? model.contextLength ?? settings.contextLength,
    toolCalling: override?.toolCalling ?? model.toolCalling,
    imageInput: override?.imageInput ?? model.imageInput,
    reasoningEffort: model.reasoningEffort ?? settings.reasoningEffort
  };
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

export function toModelPrompt(messages: readonly InputMessage[]): {
  instructions?: Array<{ role: 'system'; content: string }>;
  messages: ModelMessage[];
} {
  const instructions: Array<{ role: 'system'; content: string }> = [];
  const modelMessages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push({ role: 'system', content: text(message.content) });
      continue;
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
      modelMessages.push({ role: 'assistant', content });
      continue;
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
      modelMessages.push({ role: 'tool', content: toolResults });
      continue;
    }

    const content: UserContent = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.value ?? '' });
      } else if (part.type === 'data' && part.data && part.mimeType?.startsWith('image/')) {
        content.push({ type: 'image', image: part.data, mediaType: part.mimeType });
      }
    }
    modelMessages.push({ role: 'user', content });
  }
  return {
    instructions: instructions.length ? instructions : undefined,
    messages: modelMessages
  };
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
