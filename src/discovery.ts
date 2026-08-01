import { DEFAULT_CONTEXT_LENGTH, type ModelConfig, type ProviderKind } from './core';

export interface ProviderProfile {
  id: string;
  provider: ProviderKind;
  baseURL?: string;
  discover?: boolean;
}

export interface DiscoveryResult {
  models: ModelConfig[];
  expiresAt: number;
}

export const DEFAULT_DISCOVERY_MAX_INPUT = DEFAULT_CONTEXT_LENGTH;
export const DEFAULT_DISCOVERY_MAX_OUTPUT = 16384;

function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const valueTrimmed = value.trim();
  return valueTrimmed.startsWith('models/') ? valueTrimmed.slice('models/'.length) : valueTrimmed;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function inferenceBaseURL(profile: ProviderProfile): string | undefined {
  if (!profile.baseURL) {
    return undefined;
  }
  const base = profile.baseURL.replace(/\/+$/, '');
  if (profile.provider === 'anthropic') {
    return base.endsWith('/v1') ? base : `${base}/v1`;
  }
  if (profile.provider === 'google') {
    return base.endsWith('/v1beta') ? base : `${base}/v1beta`;
  }
  return base;
}

function asModel(profile: ProviderProfile, raw: Record<string, unknown>): ModelConfig | undefined {
  const id = modelId(raw.id ?? raw.name);
  if (!id) {
    return undefined;
  }
  const displayNameValue = raw.displayName ?? raw.display_name;
  const displayName =
    typeof displayNameValue === 'string' && displayNameValue.trim() ? displayNameValue : undefined;
  const input = numberValue(raw.inputTokenLimit ?? raw.max_input_tokens ?? raw.context_length);
  const output = numberValue(raw.outputTokenLimit ?? raw.max_output_tokens ?? raw.max_tokens);
  const modalities = raw.inputModalities;
  const capabilities =
    raw.capabilities && typeof raw.capabilities === 'object'
      ? (raw.capabilities as Record<string, unknown>)
      : undefined;
  const imageCapability = capabilities?.image_input;
  const imageSupported =
    imageCapability && typeof imageCapability === 'object'
      ? (imageCapability as { supported?: unknown }).supported
      : undefined;
  const imageInput =
    typeof imageSupported === 'boolean'
      ? imageSupported
      : Array.isArray(modalities)
        ? modalities.includes('image')
        : undefined;
  return {
    id: `${profile.id}/${id}`,
    name: displayName ?? id,
    provider: profile.provider,
    model: id,
    baseURL: inferenceBaseURL(profile),
    profileId: profile.id,
    maxInputTokens: input ?? DEFAULT_DISCOVERY_MAX_INPUT,
    maxOutputTokens: output ?? DEFAULT_DISCOVERY_MAX_OUTPUT,
    toolCalling: true,
    imageInput: imageInput ?? true
  };
}

export function normalizeModelResponse(profile: ProviderProfile, payload: unknown): ModelConfig[] {
  const entries =
    profile.provider === 'google'
      ? payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : []
      : payload &&
          typeof payload === 'object' &&
          Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : [];
  return entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => asModel(profile, entry))
    .filter((entry): entry is ModelConfig => !!entry);
}

function rootUrl(profile: ProviderProfile): string {
  const fallback =
    profile.provider === 'google'
      ? 'https://generativelanguage.googleapis.com'
      : profile.provider === 'anthropic'
        ? 'https://api.anthropic.com'
        : profile.provider === 'openai-responses'
          ? 'https://api.openai.com/v1'
          : '';
  const base = profile.baseURL ?? fallback;
  if (!base) {
    throw new Error(`baseURL is required for profile ${profile.id}.`);
  }
  return base.replace(/\/+$/, '');
}

export function discoveryRequest(
  profile: ProviderProfile,
  cursor?: string
): { url: string; headers: Record<string, string> } {
  const base = rootUrl(profile);
  if (profile.provider === 'google') {
    const query = cursor ? `?pageToken=${encodeURIComponent(cursor)}` : '';
    const url = base.endsWith('/v1beta') ? `${base}/models` : `${base}/v1beta/models`;
    return { url: `${url}${query}`, headers: {} };
  }
  if (profile.provider === 'anthropic') {
    const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    return {
      url: cursor ? `${url}?after_id=${encodeURIComponent(cursor)}` : url,
      headers: { 'anthropic-version': '2023-06-01' }
    };
  }
  return { url: `${base}/models`, headers: {} };
}

export async function discoverModels(
  profile: ProviderProfile,
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<ModelConfig[]> {
  const models: ModelConfig[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const request = discoveryRequest(profile, cursor);
    const headers = {
      ...request.headers,
      ...(profile.provider === 'google'
        ? { 'x-goog-api-key': apiKey }
        : profile.provider === 'anthropic'
          ? { 'x-api-key': apiKey }
          : { Authorization: `Bearer ${apiKey}` })
    };
    const response = await fetcher(request.url, { headers });
    if (!response.ok) {
      throw new Error(`Model discovery failed (${response.status}) for ${profile.id}.`);
    }
    const payload = (await response.json()) as unknown;
    models.push(...normalizeModelResponse(profile, payload));
    if (!payload || typeof payload !== 'object') {
      break;
    }
    if (profile.provider === 'google') {
      const next = (payload as { nextPageToken?: unknown }).nextPageToken;
      if (typeof next !== 'string' || !next) {
        break;
      }
      cursor = next;
      continue;
    }
    if (profile.provider === 'anthropic' && (payload as { has_more?: unknown }).has_more === true) {
      const next = (payload as { last_id?: unknown }).last_id;
      if (typeof next !== 'string' || !next) {
        break;
      }
      cursor = next;
      continue;
    }
    break;
  }
  return models;
}

export function mergeModels(manual: ModelConfig[], discovered: ModelConfig[]): ModelConfig[] {
  const result = [...manual];
  const ids = new Set(manual.map((model) => model.id));
  for (const model of discovered) {
    if (!ids.has(model.id)) {
      result.push(model);
      ids.add(model.id);
    }
  }
  return result;
}

export class ModelDiscovery {
  private readonly cache = new Map<string, DiscoveryResult>();
  private readonly pending = new Map<string, Promise<ModelConfig[]>>();
  private readonly generations = new Map<string, number>();
  private globalGeneration = 0;

  constructor(
    private readonly secrets: { get(key: string): Thenable<string | undefined> },
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = () => Date.now()
  ) {}

  private fingerprint(profile: ProviderProfile): string {
    return `${profile.id}|${JSON.stringify([profile.provider, profile.baseURL ?? '', profile.discover ?? true])}`;
  }

  private generation(profileId: string): number {
    return this.generations.get(profileId) ?? 0;
  }

  clear(profileId?: string): void {
    if (profileId) {
      this.generations.set(profileId, this.generation(profileId) + 1);
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${profileId}|`)) {
          this.cache.delete(key);
        }
      }
      return;
    }
    this.globalGeneration++;
    this.cache.clear();
  }

  getCached(profile: ProviderProfile | string): ModelConfig[] | undefined {
    if (typeof profile !== 'string') {
      return this.cache.get(this.fingerprint(profile))?.models;
    }
    for (const [key, result] of this.cache) {
      if (key.startsWith(`${profile}|`)) {
        return result.models;
      }
    }
    return undefined;
  }

  async discover(profile: ProviderProfile, force = false): Promise<ModelConfig[]> {
    const key = this.fingerprint(profile);
    if (!force) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.now()) {
        return cached.models;
      }
    }
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }
    const generation = this.generation(profile.id);
    const globalGeneration = this.globalGeneration;
    const request = (async () => {
      const apiKey = await this.secrets.get(`asCompatibleCopilot.apiKey.profile.${profile.id}`);
      if (!apiKey) {
        throw new Error(`No API key for profile ${profile.id}.`);
      }
      const models = await discoverModels(profile, apiKey, this.fetcher);
      if (
        this.globalGeneration === globalGeneration &&
        this.generation(profile.id) === generation
      ) {
        this.cache.set(key, { models, expiresAt: this.now() + 15 * 60 * 1000 });
      }
      return models;
    })();
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
}
