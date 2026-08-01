import * as vscode from 'vscode';
import { isReasoningEffort, normalizeSettings, type ModelConfig } from '../core';
import { ModelDiscovery, type ProviderProfile } from '../discovery';
import { ConfigurationStorage } from '../storage';

type Message =
  | { type: 'refresh' }
  | { type: 'saveSettings'; settings: unknown }
  | { type: 'saveProfile'; profile: unknown; apiKey?: unknown }
  | { type: 'deleteProfile'; id: unknown }
  | { type: 'saveModel'; model: unknown; originalId?: unknown }
  | { type: 'deleteModel'; id: unknown };

const providers: ProviderProfile['provider'][] = ['anthropic', 'google', 'openai-compatible', 'openai-responses'];
const profileKey = (id: string) => `asCompatibleCopilot.apiKey.profile.${id}`;

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function message(value: unknown): Message | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'refresh') return { type: 'refresh' };
  if (value.type === 'saveSettings') return { type: 'saveSettings', settings: value.settings };
  if (value.type === 'saveProfile') return { type: 'saveProfile', profile: value.profile, apiKey: value.apiKey };
  if (value.type === 'deleteProfile') return { type: 'deleteProfile', id: value.id };
  if (value.type === 'saveModel') return { type: 'saveModel', model: value.model, originalId: value.originalId };
  if (value.type === 'deleteModel') return { type: 'deleteModel', id: value.id };
  return undefined;
}

export class ConfigView {
  private static current: ConfigView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static open(
    context: vscode.ExtensionContext,
    storage: ConfigurationStorage,
    discovery: ModelDiscovery,
    loadModels: (force?: boolean) => Promise<ModelConfig[]>,
    changed: vscode.EventEmitter<void>
  ): void {
    if (this.current) return this.current.panel.reveal();
    const panel = vscode.window.createWebviewPanel('asCompatibleCopilot.configuration', 'AS Compatible Copilot', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'static', 'assets', 'configView')]
    });
    this.current = new ConfigView(panel, context, storage, discovery, loadModels, changed);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly storage: ConfigurationStorage,
    private readonly discovery: ModelDiscovery,
    private readonly loadModels: (force?: boolean) => Promise<ModelConfig[]>,
    private readonly changed: vscode.EventEmitter<void>
  ) {
    this.panel.webview.onDidReceiveMessage((raw) => this.handle(message(raw)), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    void this.render();
  }

  private async render(): Promise<void> {
    const webview = this.panel.webview;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'static', 'assets', 'configView');
    const html = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'index.html'))).toString('utf8');
    const token = nonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${token}'`;
    this.panel.webview.html = html.replaceAll('{{csp}}', csp)
      .replaceAll('{{css}}', webview.asWebviewUri(vscode.Uri.joinPath(root, 'configView.css')).toString())
      .replaceAll('{{js}}', webview.asWebviewUri(vscode.Uri.joinPath(root, 'configView.js')).toString())
      .replaceAll('{{nonce}}', token);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const models = await this.loadModels();
    const keys: Record<string, boolean> = {};
    for (const profile of this.storage.profiles) keys[profile.id] = !!(await this.context.secrets.get(profileKey(profile.id)));
    await this.panel.webview.postMessage({ type: 'state', profiles: this.storage.profiles, models, manualModelIds: this.storage.models.map((model) => model.id), settings: this.storage.settings, keys });
  }

  private async handle(input: Message | undefined): Promise<void> {
    if (!input) return;
    try {
      if (input.type === 'refresh') return await this.refresh();
      if (input.type === 'saveSettings') {
        if (!isRecord(input.settings) || !isReasoningEffort(input.settings.reasoningEffort)) throw new Error('Invalid settings.');
        await this.storage.updateSettings(normalizeSettings(input.settings));
      } else if (input.type === 'saveProfile') {
        if (!isRecord(input.profile) || typeof input.profile.id !== 'string' || !input.profile.id.trim() || !providers.includes(input.profile.provider as ProviderProfile['provider'])) throw new Error('Invalid provider profile.');
        const profile = { id: input.profile.id.trim(), provider: input.profile.provider as ProviderProfile['provider'], baseURL: typeof input.profile.baseURL === 'string' && input.profile.baseURL.trim() ? input.profile.baseURL.trim() : undefined, discover: input.profile.discover !== false };
        const profiles = this.storage.profiles.filter((value) => value.id !== profile.id);
        await this.storage.updateProfiles([...profiles, profile]);
        if (typeof input.apiKey === 'string' && input.apiKey.trim()) await this.context.secrets.store(profileKey(profile.id), input.apiKey.trim());
      } else if (input.type === 'deleteProfile') {
        if (typeof input.id !== 'string') throw new Error('Invalid profile id.');
        await this.storage.update(this.storage.profiles.filter((profile) => profile.id !== input.id), this.storage.models.filter((model) => model.profileId !== input.id));
        await this.context.secrets.delete(profileKey(input.id)); this.discovery.clear(input.id);
      } else if (input.type === 'saveModel') {
        if (!isRecord(input.model) || typeof input.model.id !== 'string' || typeof input.model.model !== 'string' || !providers.includes(input.model.provider as ProviderProfile['provider'])) throw new Error('Invalid model.');
        const sourceModels = await this.loadModels();
        const originalId = typeof input.originalId === 'string' ? input.originalId : undefined;
        const existing = [...this.storage.models, ...sourceModels].find((value) => value.id === (originalId ?? (isRecord(input.model) ? input.model.id : undefined)));
        const model = { ...existing, ...(input.model as object) } as ModelConfig;
        await this.storage.updateModels([...this.storage.models.filter((value) => value.id !== (existing?.id ?? model.id)), model]);
      } else if (input.type === 'deleteModel') {
        if (typeof input.id !== 'string') throw new Error('Invalid model id.');
        await this.storage.updateModels(this.storage.models.filter((model) => model.id !== input.id));
      }
      this.changed.fire(); await this.refresh();
    } catch (error) {
      await this.panel.webview.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private dispose(): void {
    ConfigView.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
