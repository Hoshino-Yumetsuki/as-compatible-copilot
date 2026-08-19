import * as vscode from 'vscode';
import { isReasoningEffort, normalizeSettings, type ExtensionSettings, type ModelConfig, type ProviderKind } from '../core';
import { ModelDiscovery, type ProviderProfile } from '../discovery';
import { ConfigurationStorage } from '../storage';

type Message =
  | { type: 'refresh'; force?: boolean }
  | { type: 'saveSettings'; settings: unknown }
  | { type: 'saveProfile'; profile: unknown; originalId?: unknown; apiKey?: unknown }
  | { type: 'deleteProfile'; id: unknown }
  | { type: 'saveModel'; model: unknown; originalId?: unknown }
  | { type: 'deleteModel'; id: unknown }
  | { type: 'exportConfig' }
  | { type: 'importConfig'; config: unknown };

const providers: ProviderKind[] = ['anthropic', 'google', 'openai-compatible', 'openai-responses'];
const profileKey = (id: string) => `asCompatibleCopilot.apiKey.profile.${id}`;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

function parseMessage(value: unknown): Message | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  switch (value.type) {
    case 'refresh': return { type: 'refresh', force: value.force === true };
    case 'saveSettings': return { type: 'saveSettings', settings: value.settings };
    case 'saveProfile': return { type: 'saveProfile', profile: value.profile, originalId: value.originalId, apiKey: value.apiKey };
    case 'deleteProfile': return { type: 'deleteProfile', id: value.id };
    case 'saveModel': return { type: 'saveModel', model: value.model, originalId: value.originalId };
    case 'deleteModel': return { type: 'deleteModel', id: value.id };
    case 'exportConfig': return { type: 'exportConfig' };
    case 'importConfig': return { type: 'importConfig', config: value.config };
    default: return undefined;
  }
}

function validateSettings(value: unknown): ExtensionSettings {
  if (!isRecord(value) || !isReasoningEffort(value.reasoningEffort)) throw new Error('Choose a valid reasoning effort.');
  const settings = normalizeSettings(value);
  if (!positive(value.contextLength)) throw new Error('Context length must be a positive integer.');
  return settings;
}

function validateProfile(value: unknown): ProviderProfile {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || !providers.includes(value.provider as ProviderKind)) {
    throw new Error('Provider ID and provider type are required.');
  }
  let baseURL: string | undefined;
  if (value.baseURL !== undefined && value.baseURL !== '') {
    if (typeof value.baseURL !== 'string') throw new Error('Base URL must be text.');
    try {
      const url = new URL(value.baseURL.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      baseURL = url.toString().replace(/\/$/, '');
    } catch { throw new Error('Base URL must be an http(s) URL.'); }
  }
  if (value.provider === 'openai-compatible' && !baseURL) throw new Error('OpenAI-compatible providers require a base URL.');
  return { id: value.id.trim(), provider: value.provider as ProviderKind, ...(baseURL ? { baseURL } : {}), discover: value.discover !== false };
}

function validateModel(value: unknown, profiles: readonly ProviderProfile[]): ModelConfig {
  if (!isRecord(value)) throw new Error('Model configuration must be an object.');
  const profileId = typeof value.profileId === 'string' ? value.profileId.trim() : '';
  const modelName = typeof value.model === 'string' ? value.model.trim() : '';
  if (!profileId || !modelName) throw new Error('Model name and provider profile are required.');
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Choose an existing provider profile.');
  return {
    id: `${profile.id}/${modelName}`,
    model: modelName,
    profileId: profile.id,
    provider: profile.provider,
    ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
    ...(positive(value.contextLength) ? { contextLength: positive(value.contextLength) } : {}),
    ...(positive(value.maxInputTokens) ? { maxInputTokens: positive(value.maxInputTokens) } : {}),
    ...(positive(value.maxOutputTokens) ? { maxOutputTokens: positive(value.maxOutputTokens) } : {}),
    ...(typeof value.toolCalling === 'boolean' ? { toolCalling: value.toolCalling } : {}),
    ...(typeof value.imageInput === 'boolean' ? { imageInput: value.imageInput } : {}),
    ...(isReasoningEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {})
  };
}

export class ConfigView {
  private static current: ConfigView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static open(context: vscode.ExtensionContext, storage: ConfigurationStorage, discovery: ModelDiscovery, loadModels: (force?: boolean) => Promise<ModelConfig[]>, changed: vscode.EventEmitter<void>): void {
    if (this.current) return this.current.panel.reveal();
    const panel = vscode.window.createWebviewPanel('asCompatibleCopilot.configuration', 'AS Compatible Copilot', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'static', 'assets', 'configView')]
    });
    this.current = new ConfigView(panel, context, storage, discovery, loadModels, changed);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly storage: ConfigurationStorage, private readonly discovery: ModelDiscovery, private readonly loadModels: (force?: boolean) => Promise<ModelConfig[]>, private readonly changed: vscode.EventEmitter<void>) {
    this.panel.webview.onDidReceiveMessage((raw) => this.handle(parseMessage(raw)), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    void this.render();
  }

  private async render(): Promise<void> {
    const webview = this.panel.webview;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'static', 'assets', 'configView');
    const html = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'index.html'))).toString('utf8');
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}`;
    this.panel.webview.html = html
      .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace('./configView.css', webview.asWebviewUri(vscode.Uri.joinPath(root, 'configView.css')).toString())
      .replace('./configView.js', webview.asWebviewUri(vscode.Uri.joinPath(root, 'configView.js')).toString());
    await this.refresh();
  }

  private async refresh(force = false): Promise<void> {
    await this.panel.webview.postMessage({ type: 'operation', operation: 'Refreshing models' });
    const models = await this.loadModels(force);
    const keys: Record<string, boolean> = {};
    for (const profile of this.storage.profiles) keys[profile.id] = !!(await this.context.secrets.get(profileKey(profile.id)));
    await this.panel.webview.postMessage({ type: 'state', profiles: this.storage.profiles, models, manualModelIds: this.storage.models.map((model) => model.id), settings: this.storage.settings, keys });
  }

  private async handle(input: Message | undefined): Promise<void> {
    if (!input) return;
    try {
      await this.panel.webview.postMessage({ type: 'operation', operation: 'Saving configuration' });
      switch (input.type) {
        case 'refresh': await this.refresh(input.force); break;
        case 'saveSettings': await this.storage.updateSettings(validateSettings(input.settings)); break;
        case 'saveProfile': {
          const profile = validateProfile(input.profile);
          const originalId = typeof input.originalId === 'string' && input.originalId.trim() ? input.originalId.trim() : profile.id;
          if (originalId !== profile.id && this.storage.profiles.some((value) => value.id === profile.id)) throw new Error(`Provider ${profile.id} already exists.`);
          const profiles = this.storage.profiles.filter((value) => value.id !== originalId && value.id !== profile.id);
          const models = this.storage.models.map((model) =>
            model.profileId === originalId
              ? validateModel({ ...model, profileId: profile.id }, [...profiles, profile])
              : model
          );
          await this.storage.update([...profiles, profile], models);
          if (typeof input.apiKey === 'string' && input.apiKey.trim()) await this.context.secrets.store(profileKey(profile.id), input.apiKey.trim());
          if (originalId !== profile.id) {
            const oldKey = await this.context.secrets.get(profileKey(originalId));
            if (oldKey && !(typeof input.apiKey === 'string' && input.apiKey.trim())) await this.context.secrets.store(profileKey(profile.id), oldKey);
            await this.context.secrets.delete(profileKey(originalId));
            this.discovery.clear(originalId);
          }
          this.discovery.clear(profile.id);
          break;
        }
        case 'deleteProfile': {
          if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Invalid provider ID.');
          const id = input.id.trim();
          const profile = this.storage.profiles.find((value) => value.id === id);
          if (!profile) throw new Error('Provider profile no longer exists.');
          const modelCount = this.storage.models.filter((model) => model.profileId === id).length;
          const detail = modelCount ? ` Its ${modelCount} configured model${modelCount === 1 ? '' : 's'} will also be removed.` : '';
          if ((await vscode.window.showWarningMessage(`Delete provider profile "${id}"?${detail}`, { modal: true }, 'Delete')) !== 'Delete') return;
          await this.storage.update(this.storage.profiles.filter((value) => value.id !== id), this.storage.models.filter((model) => model.profileId !== id));
          await this.context.secrets.delete(profileKey(id));
          this.discovery.clear(id);
          break;
        }
        case 'saveModel': {
          const model = validateModel(input.model, this.storage.profiles);
          const originalId = typeof input.originalId === 'string' && input.originalId.trim() ? input.originalId.trim() : undefined;
          const existing = originalId ? this.storage.models.find((value) => value.id === originalId) : undefined;
          if (originalId && !existing) throw new Error('Discovered-only models cannot be saved as manual models.');
          if (this.storage.models.some((value) => value.id === model.id && value.id !== originalId)) throw new Error(`Model ${model.id} already exists.`);
          await this.storage.updateModels([...this.storage.models.filter((value) => value.id !== originalId), model]);
          break;
        }
        case 'deleteModel': {
          if (typeof input.id !== 'string' || !this.storage.models.some((model) => model.id === input.id)) throw new Error('Only manually configured models can be deleted.');
          await this.storage.updateModels(this.storage.models.filter((model) => model.id !== input.id));
          break;
        }
        case 'exportConfig': {
          const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export configuration' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ version: 1, profiles: this.storage.profiles, models: this.storage.models, settings: this.storage.settings }, null, 2)));
          break;
        }
        case 'importConfig': {
          if (!isRecord(input.config) || !Array.isArray(input.config.profiles) || !Array.isArray(input.config.models)) throw new Error('Invalid configuration file.');
          const profiles = input.config.profiles.map(validateProfile);
          const models = input.config.models.map((model) => validateModel(model, profiles));
          const settings = validateSettings(input.config.settings);
          if ((await vscode.window.showWarningMessage('Replace all provider profiles and manual models?', { modal: true }, 'Replace')) !== 'Replace') return;
          const importedProfileIds = new Set(profiles.map((profile) => profile.id));
          for (const profile of this.storage.profiles) {
            if (!importedProfileIds.has(profile.id)) await this.context.secrets.delete(profileKey(profile.id));
          }
          await this.storage.update(profiles, models, settings);
          break;
        }
      }
      this.changed.fire();
      await this.refresh();
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private dispose(): void {
    ConfigView.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
