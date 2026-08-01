import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento } from 'vscode';
import { ConfigurationStorage } from '../src/storage.js';

function memento(initial?: unknown): Memento {
  let value = initial;
  return {
    keys: () => (value === undefined ? [] : ['asCompatibleCopilot.configuration']),
    get: (_key: string, defaultValue?: unknown) => value ?? defaultValue,
    update: async (_key: string, next: unknown) => {
      value = next;
    }
  } as Memento;
}

void test('stores profiles and models in one versioned global state object', async () => {
  const storage = new ConfigurationStorage(memento());
  await storage.updateProfiles([{ id: 'profile', provider: 'anthropic' }]);
  await storage.updateModels([{ id: 'model', provider: 'anthropic', model: 'claude' }]);
  assert.deepEqual(storage.profiles, [{ id: 'profile', provider: 'anthropic' }]);
  assert.deepEqual(storage.models, [{ id: 'model', provider: 'anthropic', model: 'claude' }]);
  assert.deepEqual(storage.settings, {
    reasoningEffort: 'medium',
    contextLength: 256000,
    modelOverrides: {}
  });
});

void test('normalizes malformed settings and overrides', () => {
  const storage = new ConfigurationStorage(
    memento({
      settings: {
        reasoningEffort: 'medium',
        contextLength: 0,
        modelOverrides: {
          good: { contextLength: 512, toolCalling: false, imageInput: true, ignored: 'x' },
          bad: [],
          empty: { contextLength: -1 }
        }
      }
    })
  );
  assert.deepEqual(storage.settings, {
    reasoningEffort: 'medium',
    contextLength: 256000,
    modelOverrides: { good: { contextLength: 512, toolCalling: false, imageInput: true } }
  });
});

void test('defaults malformed stored arrays to empty arrays', () => {
  const storage = new ConfigurationStorage(memento({ version: 1, profiles: null, models: {} }));
  assert.deepEqual(storage.profiles, []);
  assert.deepEqual(storage.models, []);
});
