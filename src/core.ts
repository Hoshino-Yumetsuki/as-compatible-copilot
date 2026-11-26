import type { AssistantContent, ModelMessage, ToolContent, UserContent } from 'ai';
import { toReasoningParts, type ThinkingPartData } from './reasoning';

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
  maxContextWindowTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  reasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: readonly ReasoningEffort[];
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

export function reasoningEfforts(model: ModelConfig): readonly ReasoningEffort[] {
  if (model.provider !== 'anthropic' && model.provider !== 'openai-responses') return [];
  if (model.supportedReasoningEfforts) return model.supportedReasoningEfforts;
  // Discovery is authoritative. For manual models only offer known, compatible levels.
  const id = model.model;
  if (model.provider === 'anthropic') {
    if (/^claude-(?:opus-4-[78]|(?:opus|sonnet|haiku|fable)-5)/.test(id)) return REASONING_EFFORTS;
    if (/^claude-opus-4-6/.test(id)) return ['low', 'medium', 'high', 'max'];
    if (/^claude-(?:opus-4-5|sonnet-4-6)/.test(id)) return ['low', 'medium', 'high'];
  } else {
    if (/^gpt-\d+-chat|^o1-(?:preview|mini)/.test(id)) return [];
    if (/^gpt-6(?:[.-]|$)/.test(id)) return REASONING_EFFORTS;
    if (/^gpt-5(?:\.\d+)?-pro(?:-|$)|^o3-pro(?:-|$)/.test(id)) return ['high'];
    if (/^gpt-5\.[2-9](?:-|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
    if (/^(?:o[134]|gpt-5)(?:[.-]|$)/.test(id)) return ['low', 'medium', 'high'];
  }
  return [];
}

export function selectReasoningEffort(
  model: ModelConfig,
  requested?: unknown
): ReasoningEffort | undefined {
  const levels = reasoningEfforts(model);
  for (const value of [requested, model.reasoningEffort, 'medium']) {
    if (isReasoningEffort(value) && levels.includes(value)) return value;
  }
  return levels[0];
}

export function reasoningProviderOptions(
  model: ModelConfig,
  requested?: unknown,
  includePrivateState = false
): NonNullable<Parameters<typeof import('ai').streamText>[0]['providerOptions']> | undefined {
  const effort = selectReasoningEffort(model, requested);
  if (!effort) return undefined;
  if (model.provider === 'anthropic') return { anthropic: { effort } };
  return {
    openai: {
      reasoningEffort: effort,
      reasoningSummary: 'auto',
      ...(includePrivateState ? { store: false, include: ['reasoning.encrypted_content'] } : {})
    }
  };
}

export function tokenLimits(model: ModelConfig) {
  const window = Math.max(
    2,
    Math.min(
      positiveInteger(model.contextLength) ?? DEFAULT_CONTEXT_LENGTH,
      positiveInteger(model.maxContextWindowTokens) ?? Infinity
    )
  );
  const outputLimit = positiveInteger(model.maxOutputTokens) ?? 16384;
  // If the output ceiling alone fills the window, reserve room for the prompt too.
  const maxOutputTokens = outputLimit < window ? outputLimit : Math.floor(window / 2);
  const maxInputTokens = Math.min(
    positiveInteger(model.maxInputTokens) ?? Infinity,
    window - maxOutputTokens
  );
  return {
    maxInputTokens,
    maxOutputTokens,
    maxContextWindowTokens: maxInputTokens + maxOutputTokens
  };
}

export function assertModelCapabilities(
  model: ModelConfig,
  messages: readonly InputMessage[],
  requiresTools: boolean
): void {
  if (model.toolCalling === false && requiresTools) {
    throw new Error(`Tool calling is disabled for ${model.id}.`);
  }
  if (model.imageInput === false && messages.some((message) => hasImage(message.content))) {
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
  type: 'text' | 'tool-call' | 'tool-result' | 'data' | 'thinking';
  thinking?: ThinkingPartData;
  value?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  isError?: boolean;
  content?: readonly InputPart[];
  data?: Uint8Array;
  mimeType?: string;
}

export interface InputMessage {
  role: 'system' | 'user' | 'assistant';
  name?: string;
  content: readonly InputPart[];
}

function hasImage(parts: readonly InputPart[]): boolean {
  return parts.some(
    (part) =>
      (part.type === 'data' && part.mimeType?.startsWith('image/')) ||
      (part.content !== undefined && hasImage(part.content))
  );
}

type ToolOutput = Extract<ToolContent[number], { type: 'tool-result' }>['output'];
type ToolOutputContentPart = Extract<ToolOutput, { type: 'content' }>['value'][number];

function text(parts: readonly InputPart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.value ?? '')
    .join('');
}

export function toModelPrompt(
  messages: readonly InputMessage[],
  model?: ModelConfig,
  replayReasoning = true,
  replayKey?: string
): {
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
      for (let i = 0; i < message.content.length; i++) {
        const part = message.content[i];
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.value ?? '' });
        } else if (part.type === 'thinking' && part.thinking && model && replayReasoning) {
          const group = [part.thinking];
          while (part.thinking.id && message.content[i + 1]?.thinking?.id === part.thinking.id) {
            group.push(message.content[++i].thinking!);
          }
          content.push(...toReasoningParts(group, model, replayKey));
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
      if (content.length) modelMessages.push({ role: 'assistant', content });
      continue;
    }

    const toolResults: ToolContent = [];
    const toolImages: UserContent = [];
    const content: UserContent = [];
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.callId) {
        const result = part.content ?? [];
        const fallback = model?.provider === 'openai-compatible' && hasImage(result);
        if (fallback) {
          for (const item of result) {
            if (item.type === 'data' && item.data && item.mimeType?.startsWith('image/')) {
              toolImages.push(
                { type: 'text', text: `Image from tool result ${JSON.stringify(part.callId)}:` },
                { type: 'file', data: item.data, mediaType: item.mimeType }
              );
            }
          }
        }
        const output: ToolOutput =
          hasImage(result) && !fallback
            ? {
                type: 'content',
                value: result.flatMap<ToolOutputContentPart>((item) => {
                  if (item.type === 'text')
                    return [{ type: 'text' as const, text: item.value ?? '' }];
                  if (item.type === 'data' && item.data && item.mimeType?.startsWith('image/')) {
                    return [
                      {
                        type: 'file' as const,
                        mediaType: item.mimeType,
                        data: { type: 'data' as const, data: item.data }
                      }
                    ];
                  }
                  return [];
                })
              }
            : {
                type: part.isError ? 'error-text' : 'text',
                value:
                  text(result) +
                  (fallback
                    ? `\n[Images for tool result ${JSON.stringify(part.callId)} follow in a user message.]`
                    : '')
              };
        toolResults.push({
          type: 'tool-result',
          toolCallId: part.callId,
          toolName: toolNames.get(part.callId) ?? part.name ?? 'tool',
          output
        });
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.value ?? '' });
      } else if (part.type === 'data' && part.data && part.mimeType?.startsWith('image/')) {
        content.push({ type: 'file', data: part.data, mediaType: part.mimeType });
      }
    }
    if (toolResults.length) {
      let index = modelMessages.length;
      while (index > 0 && modelMessages[index - 1].role === 'user') index--;
      modelMessages.splice(index, 0, { role: 'tool', content: toolResults });
    }
    if (toolImages.length) modelMessages.push({ role: 'user', content: toolImages });
    if (content.length || !toolResults.length) modelMessages.push({ role: 'user', content });
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
            if (part.type === 'thinking') {
              const value = part.thinking?.value;
              return Array.isArray(value) ? value.join('') : (value ?? '');
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
