import { randomBytes } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, streamText, tool, type LanguageModel } from 'ai';
import * as vscode from 'vscode';
import {
  effectiveModelConfig,
  estimateTokens,
  formatUsage,
  reasoningProviderOptions,
  assertModelCapabilities,
  toModelPrompt,
  type InputMessage,
  type InputPart,
  type ModelConfig,
  DEFAULT_CONTEXT_LENGTH
} from './core';
import { mergeModels, ModelDiscovery, type ProviderProfile } from './discovery';
import { ConfigurationStorage } from './storage';

const section = 'asCompatibleCopilot';
const vendor = 'ai-sdk';
const extensionName = 'AS Compatible Provider for Copilot';

function secretName(model: ModelConfig): string {
  return model.profileId ? profileSecretName(model.profileId) : `${section}.apiKey.${model.id}`;
}

function profileSecretName(profileId: string): string {
  return `${section}.apiKey.profile.${profileId}`;
}

const providerLabels: Record<ProviderProfile['provider'], string> = {
  anthropic: 'Anthropic Messages',
  google: 'Google Gemini',
  'openai-compatible': 'OpenAI-compatible Chat Completions',
  'openai-responses': 'OpenAI Responses'
};

function panelHtml(
  webview: vscode.Webview,
  settings: import('./core').ExtensionSettings,
  models: ModelConfig[]
): string {
  const nonce = randomBytes(16).toString('base64');
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
    );
  const modelRows = models
    .map((model) => {
      const override = settings.modelOverrides[model.id] ?? {};
      return `<fieldset><legend>${escape(model.name ?? model.id)}</legend><small>${escape(model.id)}</small><label>Context <input data-id="${escape(model.id)}" data-field="contextLength" type="number" value="${override.contextLength ?? ''}" placeholder="${settings.contextLength}"></label><label>Tools <select data-id="${escape(model.id)}" data-field="toolCalling"><option value="inherit" ${override.toolCalling === undefined ? 'selected' : ''}>Inherit</option><option value="true" ${override.toolCalling === true ? 'selected' : ''}>On</option><option value="false" ${override.toolCalling === false ? 'selected' : ''}>Off</option></select></label><label>Images <select data-id="${escape(model.id)}" data-field="imageInput"><option value="inherit" ${override.imageInput === undefined ? 'selected' : ''}>Inherit</option><option value="true" ${override.imageInput === true ? 'selected' : ''}>On</option><option value="false" ${override.imageInput === false ? 'selected' : ''}>Off</option></select></label><button type="button" data-reset="${escape(model.id)}">Reset</button></fieldset>`;
    })
    .join('');
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:1rem}label{display:block;margin:.5rem 0}fieldset{margin:1rem 0}input{max-width:12rem}</style></head><body><h2>AS Compatible Copilot</h2><label>Reasoning effort <select id="reasoning">${['low', 'medium', 'high', 'xhigh', 'max'].map((value) => `<option ${value === settings.reasoningEffort ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Context length <input id="context" type="number" value="${settings.contextLength}"></label><h3>Models</h3>${modelRows || '<p>No configured models.</p>'}<button id="save">Save</button><script nonce="${nonce}">const vscode=acquireVsCodeApi();const collect=()=>{const modelOverrides={};document.querySelectorAll('[data-id]').forEach((element)=>{const id=element.dataset.id;const field=element.dataset.field;const value=element.value;if(!modelOverrides[id])modelOverrides[id]={};if(field==='contextLength'&&value)modelOverrides[id][field]=Number(value);if(field!=='contextLength'&&value!=='inherit')modelOverrides[id][field]=value==='true';});return modelOverrides;};document.querySelectorAll('[data-reset]').forEach((button)=>button.onclick=()=>{document.querySelectorAll('[data-id="'+button.dataset.reset+'"]').forEach((element)=>element.value=element.dataset.field==='contextLength'?'':'inherit');});document.getElementById('save').onclick=()=>vscode.postMessage({type:'save',reasoningEffort:document.getElementById('reasoning').value,contextLength:Number(document.getElementById('context').value),modelOverrides:collect()});</script></body></html>`;
}

async function openConfiguration(
  context: vscode.ExtensionContext,
  storage: ConfigurationStorage,
  modelsChanged: vscode.EventEmitter<void>,
  models: ModelConfig[]
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'asCompatibleCopilot.configuration',
    'AS Compatible Copilot',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  panel.webview.html = panelHtml(panel.webview, storage.settings, models);
  panel.webview.onDidReceiveMessage(
    async (message: {
      type?: string;
      reasoningEffort?: string;
      contextLength?: number;
      modelOverrides?: unknown;
    }) => {
      if (message.type !== 'save') return;
      const settings = {
        reasoningEffort: message.reasoningEffort,
        contextLength: message.contextLength,
        modelOverrides: message.modelOverrides
      };
      await storage.updateSettings(settings as import('./core').ExtensionSettings);
      modelsChanged.fire();
      void vscode.window.showInformationMessage('Configuration saved.');
    },
    undefined,
    context.subscriptions
  );
}

async function generateCommitMessage(
  context: vscode.ExtensionContext,
  storage: ConfigurationStorage,
  loadModels: () => Promise<ModelConfig[]>
): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    void vscode.window.showErrorMessage('Open a workspace before generating a commit message.');
    return;
  }
  const diff = await new Promise<string>((resolve, reject) => {
    const child = require('node:child_process').spawn('git', ['diff', '--cached'], {
      cwd: workspace.uri.fsPath
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code: number) =>
      code === 0 ? resolve(output) : reject(new Error(error || `git diff failed (${code})`))
    );
  });
  if (!diff.trim()) {
    void vscode.window.showInformationMessage('No staged changes found.');
    return;
  }
  const models = await loadModels();
  if (!models.length) {
    void vscode.window.showErrorMessage('Configure a provider model first.');
    return;
  }
  const selected =
    models.length === 1
      ? models[0]
      : await vscode.window
          .showQuickPick(
            models.map((model) => ({ label: model.name ?? model.id, model })),
            { placeHolder: 'Select a model for the commit message' }
          )
          .then((value) => value?.model);
  if (!selected) return;
  const configured = effectiveModelConfig(selected, storage.settings);
  const result = await generateText({
    model: await languageModel(configured, context.secrets),
    system:
      'Write one concise conventional commit message for the staged diff. Return only the message subject.',
    prompt: diff,
    maxOutputTokens: 100,
    providerOptions: reasoningProviderOptions(configured) as never
  });
  const document = await vscode.workspace.openTextDocument({
    content: result.text.trim(),
    language: 'git-commit'
  });
  await vscode.window.showTextDocument(document);
}

async function createProfile(storage: ConfigurationStorage): Promise<ProviderProfile | undefined> {
  const provider = await vscode.window.showQuickPick(
    (Object.keys(providerLabels) as ProviderProfile['provider'][]).map((value) => ({
      label: providerLabels[value],
      value
    })),
    { placeHolder: 'Select an API provider' }
  );
  if (!provider) {
    return undefined;
  }

  const id = await vscode.window.showInputBox({
    prompt: 'A short unique name for this provider profile',
    placeHolder: 'e.g. work-openai or personal-gemini',
    validateInput: (value) => (value.trim() ? undefined : 'Profile name is required.')
  });
  if (!id) {
    return undefined;
  }
  if (storage.profiles.some((profile) => profile.id === id.trim())) {
    vscode.window.showErrorMessage(`A provider profile named "${id.trim()}" already exists.`);
    return undefined;
  }

  const defaultBaseURL =
    provider.value === 'anthropic'
      ? 'https://api.anthropic.com'
      : provider.value === 'google'
        ? 'https://generativelanguage.googleapis.com'
        : provider.value === 'openai-responses'
          ? 'https://api.openai.com/v1'
          : undefined;
  const baseURL = await vscode.window.showInputBox({
    prompt: 'Provider API base URL',
    value: defaultBaseURL,
    placeHolder: provider.value === 'openai-compatible' ? 'https://example.com/v1' : defaultBaseURL,
    validateInput: (value) => {
      if (provider.value === 'openai-compatible' && !value.trim()) {
        return 'Base URL is required for OpenAI-compatible providers.';
      }
      if (value.trim()) {
        try {
          const url = new URL(value.trim());
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return 'Use an http:// or https:// URL.';
          }
        } catch {
          return 'Enter a valid URL.';
        }
      }
      return undefined;
    }
  });
  if (baseURL === undefined) {
    return undefined;
  }
  return {
    id: id.trim(),
    provider: provider.value,
    baseURL: baseURL.trim() || undefined,
    discover: true
  };
}

function asInputPart(part: unknown): InputPart | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', value: part.value };
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'tool-call', callId: part.callId, name: part.name, input: part.input };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return {
      type: 'tool-result',
      callId: part.callId,
      content: part.content.map(asInputPart).filter((value): value is InputPart => !!value)
    };
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return { type: 'data', data: part.data, mimeType: part.mimeType };
  }
  return undefined;
}

function asInputMessage(message: vscode.LanguageModelChatRequestMessage): InputMessage {
  return {
    role:
      message.role === vscode.LanguageModelChatMessageRole.System
        ? 'system'
        : message.role === vscode.LanguageModelChatMessageRole.Assistant
          ? 'assistant'
          : 'user',
    name: message.name,
    content: message.content.map(asInputPart).filter((value): value is InputPart => !!value)
  };
}

function information(
  model: ModelConfig,
  settings: import('./core').ExtensionSettings
): vscode.LanguageModelChatInformation & ModelConfig {
  const configured = effectiveModelConfig(model, settings);
  return {
    ...configured,
    name: configured.name ?? configured.model,
    family: configured.provider,
    version: configured.model,
    maxInputTokens: configured.contextLength ?? configured.maxInputTokens ?? DEFAULT_CONTEXT_LENGTH,
    maxOutputTokens: configured.maxOutputTokens ?? 16384,
    capabilities: {
      toolCalling: configured.toolCalling ?? true,
      imageInput: configured.imageInput ?? true
    }
  };
}

async function languageModel(
  model: ModelConfig,
  secrets: vscode.SecretStorage
): Promise<LanguageModel> {
  const apiKey = await secrets.get(secretName(model));
  if (!apiKey) {
    throw new Error(
      `No API key for ${model.id}. Run "AS Compatible Provider for Copilot: Set API Key".`
    );
  }
  switch (model.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: model.baseURL })(model.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: model.baseURL })(model.model);
    case 'openai-responses':
      return createOpenAI({ apiKey, baseURL: model.baseURL }).responses(model.model);
    case 'openai-compatible':
      if (!model.baseURL) {
        throw new Error(`baseURL is required for ${model.id}.`);
      }
      return createOpenAICompatible({ name: model.id, apiKey, baseURL: model.baseURL })(
        model.model
      );
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const storage = new ConfigurationStorage(context.globalState);
  const output = vscode.window.createOutputChannel(extensionName, { log: true });
  const discovery = new ModelDiscovery(context.secrets);
  const modelsChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(modelsChanged);
  const loadModels = async (force = false): Promise<ModelConfig[]> => {
    const manual = storage.models;
    const discovered: ModelConfig[] = [];
    for (const profile of storage.profiles.filter((profile) => profile.discover !== false)) {
      const hasManual = manual.some((model) => model.profileId === profile.id);
      if (hasManual) {
        continue;
      }
      try {
        discovered.push(...(await discovery.discover(profile, force)));
      } catch (error) {
        discovered.push(...(discovery.getCached(profile.id) ?? []));
        output.warn(
          `Model discovery failed for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return mergeModels(manual, discovered);
  };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand(`${section}.setApiKey`, async () => {
      const profiles = storage.profiles;
      const models = storage.models;
      const entries = [
        ...profiles.map((profile) => ({
          label: profile.id,
          description: providerLabels[profile.provider],
          profile
        })),
        ...models.map((model) => ({
          label: model.name ?? model.id,
          description: model.provider,
          model
        })),
        {
          label: '$(add) Add provider profile',
          description: 'Configure an API endpoint and discover its models'
        }
      ];
      const picked = await vscode.window.showQuickPick(entries, {
        placeHolder: 'Select a provider profile or model'
      });
      if (!picked) {
        return;
      }

      let profile = 'profile' in picked ? picked.profile : undefined;
      const model = 'model' in picked ? picked.model : undefined;
      if (!profile && !model) {
        profile = await createProfile(storage);
        if (!profile) {
          return;
        }
      }

      const apiKey = await vscode.window.showInputBox({
        prompt: `API key for ${profile?.id ?? model!.id}`,
        password: true,
        ignoreFocusOut: true
      });
      if (apiKey === undefined || !apiKey.trim()) {
        return;
      }
      if (profile && !profiles.some((value) => value.id === profile!.id)) {
        await storage.updateProfiles([...profiles, profile]);
      }
      await context.secrets.store(
        profile ? profileSecretName(profile.id) : secretName(model!),
        apiKey.trim()
      );
      modelsChanged.fire();
      if (profile) {
        try {
          const found = await discovery.discover(profile, true);
          modelsChanged.fire();
          vscode.window.showInformationMessage(
            `${extensionName}: discovered ${found.length} model(s) for ${profile.id}.`
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `${extensionName}: model discovery failed for ${profile.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(`${section}.openConfiguration`, async () =>
      openConfiguration(context, storage, modelsChanged, await loadModels())
    ),
    vscode.commands.registerCommand(`${section}.generateCommitMessage`, () =>
      generateCommitMessage(context, storage, loadModels)
    ),
    vscode.commands.registerCommand(`${section}.deleteConfigured`, async () => {
      const profiles = storage.profiles;
      const models = storage.models;
      const entries = [
        ...profiles.map((profile) => ({
          label: profile.id,
          description: `${providerLabels[profile.provider]} provider profile`,
          profile
        })),
        ...models.map((model) => ({
          label: model.name ?? model.id,
          description: `${model.provider} model`,
          model
        }))
      ];
      const picked = await vscode.window.showQuickPick(entries, {
        placeHolder: 'Select a provider profile or model to delete'
      });
      if (!picked) {
        return;
      }
      const profile = 'profile' in picked ? picked.profile : undefined;
      const model = 'model' in picked ? picked.model : undefined;
      const label = profile ? `provider profile "${profile.id}"` : `model "${model!.id}"`;
      if (
        (await vscode.window.showWarningMessage(`Delete ${label}?`, { modal: true }, 'Delete')) !==
        'Delete'
      ) {
        return;
      }
      if (profile) {
        await storage.update(
          profiles.filter((value) => value.id !== profile.id),
          models.filter((value) => value.profileId !== profile.id)
        );
        await context.secrets.delete(profileSecretName(profile.id));
        discovery.clear(profile.id);
      } else {
        await storage.updateModels(models.filter((value) => value.id !== model!.id));
        if (!model!.profileId) {
          await context.secrets.delete(secretName(model!));
        }
        discovery.clear(model!.profileId);
      }
      modelsChanged.fire();
      vscode.window.showInformationMessage(`Deleted ${label}.`);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(`${section}.refreshModels`, async () => {
      const models = await loadModels(true);
      modelsChanged.fire();
      vscode.window.showInformationMessage(`${extensionName}: found ${models.length} model(s).`);
    })
  );

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(vendor, {
      onDidChangeLanguageModelChatInformation: modelsChanged.event,
      provideLanguageModelChatInformation: () =>
        loadModels().then((models) => models.map((model) => information(model, storage.settings))),
      async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const configured = effectiveModelConfig(
          model as vscode.LanguageModelChatInformation & ModelConfig,
          storage.settings
        );
        const inputMessages = messages.map(asInputMessage);
        assertModelCapabilities(
          configured,
          inputMessages,
          options.toolMode === vscode.LanguageModelChatToolMode.Required
        );
        const tools =
          configured.toolCalling === false
            ? undefined
            : Object.fromEntries(
                (options.tools ?? []).map((value) => [
                  value.name,
                  tool({
                    description: value.description,
                    inputSchema: jsonSchema(value.inputSchema ?? { type: 'object', properties: {} })
                  })
                ])
              );
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          const result = streamText({
            model: await languageModel(configured, context.secrets),
            ...toModelPrompt(inputMessages),
            maxOutputTokens: configured.maxOutputTokens,
            providerOptions: reasoningProviderOptions(configured) as never,
            ...(tools ? { tools } : {}),
            ...(tools && options.toolMode === vscode.LanguageModelChatToolMode.Required
              ? { toolChoice: 'required' as const }
              : {}),
            abortSignal: controller.signal
          });
          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              progress.report(new vscode.LanguageModelTextPart(part.text));
            } else if (part.type === 'tool-call') {
              progress.report(
                new vscode.LanguageModelToolCallPart(
                  part.toolCallId,
                  part.toolName,
                  part.input as object
                )
              );
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'finish') {
              const line = formatUsage(part.totalUsage);
              if (line) {
                output.appendLine(`[${configured.id}] ${line}`);
              }
            }
          }
        } finally {
          cancellation.dispose();
        }
      },
      async provideTokenCount(_model, value) {
        return estimateTokens(typeof value === 'string' ? value : asInputMessage(value));
      }
    })
  );
}

export function deactivate(): void {}
