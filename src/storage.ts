import type { Memento } from 'vscode';
import {
  DEFAULT_CONTEXT_LENGTH,
  normalizeSettings,
  type ExtensionSettings,
  type ModelConfig
} from './core';
import type { ProviderProfile } from './discovery';

const storageKey = 'asCompatibleCopilot.configuration';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  reasoningEffort: 'medium',
  contextLength: DEFAULT_CONTEXT_LENGTH,
  modelOverrides: {}
};

interface StoredConfiguration {
  version: 2;
  profiles: ProviderProfile[];
  models: ModelConfig[];
  settings: ExtensionSettings;
}

export class ConfigurationStorage {
  constructor(private readonly state: Memento) {}

  get profiles(): ProviderProfile[] {
    return this.configuration.profiles;
  }

  get models(): ModelConfig[] {
    return this.configuration.models;
  }

  get settings(): ExtensionSettings {
    return this.configuration.settings;
  }

  async updateProfiles(profiles: ProviderProfile[]): Promise<void> {
    await this.update(profiles, this.models, this.settings);
  }

  async updateModels(models: ModelConfig[]): Promise<void> {
    await this.update(this.profiles, models, this.settings);
  }

  async updateSettings(settings: ExtensionSettings): Promise<void> {
    await this.update(this.profiles, this.models, settings);
  }

  async update(
    profiles: ProviderProfile[],
    models: ModelConfig[],
    settings = this.settings
  ): Promise<void> {
    await this.state.update(storageKey, {
      version: 2,
      profiles,
      models,
      settings
    } satisfies StoredConfiguration);
  }

  private get configuration(): StoredConfiguration {
    const stored = this.state.get<Partial<StoredConfiguration>>(storageKey);
    return {
      version: 2,
      profiles: Array.isArray(stored?.profiles) ? stored.profiles : [],
      models: Array.isArray(stored?.models) ? stored.models : [],
      settings: normalizeSettings(stored?.settings)
    };
  }
}
