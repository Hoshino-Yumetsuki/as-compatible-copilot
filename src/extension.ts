import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { jsonSchema, streamText, tool, type LanguageModel } from 'ai';
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
import { ConfigView } from './views/configView';

const section = 'asCompatibleCopilot';
const vendor = 'as-compatible-copilot';
const extensionName = 'AS Provider for Copilot';

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
  const maxOutputTokens = configured.maxOutputTokens ?? 16384;
  const contextLength = configured.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  return {
    ...configured,
    name: configured.id,
    family: configured.provider,
    version: configured.model,
    maxInputTokens: Math.max(1, contextLength - maxOutputTokens),
    maxOutputTokens,
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
      `No API key for ${model.id}. Run "AS Provider for Copilot: Set API Key".`
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
    vscode.commands.registerCommand(`${section}.openConfiguration`, () =>
      ConfigView.open(context, storage, discovery, loadModels, modelsChanged)
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
