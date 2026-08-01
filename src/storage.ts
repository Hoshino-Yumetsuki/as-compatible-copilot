import type { Memento } from 'vscode';
import type { ModelConfig } from './core';
import type { ProviderProfile } from './discovery';

const storageKey = 'asCompatibleCopilot.configuration';

interface StoredConfiguration {
  version: 1;
  profiles: ProviderProfile[];
  models: ModelConfig[];
}

export class ConfigurationStorage {
  constructor(private readonly state: Memento) {}

  get profiles(): ProviderProfile[] {
    return this.configuration.profiles;
  }

  get models(): ModelConfig[] {
    return this.configuration.models;
  }

  async updateProfiles(profiles: ProviderProfile[]): Promise<void> {
    await this.update(profiles, this.models);
  }

  async updateModels(models: ModelConfig[]): Promise<void> {
    await this.update(this.profiles, models);
  }

  async update(profiles: ProviderProfile[], models: ModelConfig[]): Promise<void> {
    await this.state.update(storageKey, {
      version: 1,
      profiles,
      models
    } satisfies StoredConfiguration);
  }

  private get configuration(): StoredConfiguration {
    const stored = this.state.get<Partial<StoredConfiguration>>(storageKey);
    return {
      version: 1,
      profiles: Array.isArray(stored?.profiles) ? stored.profiles : [],
      models: Array.isArray(stored?.models) ? stored.models : []
    };
  }
}
