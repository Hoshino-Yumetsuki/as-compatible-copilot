import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverModels,
  discoveryRequest,
  mergeModels,
  ModelDiscovery,
  type ProviderProfile
} from '../src/discovery.js';

const openai: ProviderProfile = {
  id: 'local',
  provider: 'openai-compatible',
  baseURL: 'https://example.test/v1'
};

test('discovers OpenAI-compatible models with bearer authentication', async () => {
  let request: { url: string; authorization?: string } | undefined;
  const models = await discoverModels(openai, 'secret', async (input, init) => {
    request = {
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization') ?? undefined
    };
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }, {}, { id: '' }] }), {
      status: 200
    });
  });
  assert.deepEqual(request, {
    url: 'https://example.test/v1/models',
    authorization: 'Bearer secret'
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'local/model-a');
  assert.equal(models[0].maxInputTokens, 128000);
});

test('discovers paginated Gemini models and normalizes names', async () => {
  const profile: ProviderProfile = {
    id: 'gemini',
    provider: 'google',
    baseURL: 'https://generativelanguage.googleapis.com'
  };
  const requests: string[] = [];
  const models = await discoverModels(profile, 'key', async (input, init) => {
    requests.push(`${String(input)}:${new Headers(init?.headers).get('x-goog-api-key')}`);
    return requests.length === 1
      ? new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini Pro',
                inputTokenLimit: 100,
                outputTokenLimit: 20
              }
            ],
            nextPageToken: 'next'
          })
        )
      : new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
  });
  assert.deepEqual(requests, [
    'https://generativelanguage.googleapis.com/v1beta/models:key',
    'https://generativelanguage.googleapis.com/v1beta/models?pageToken=next:key'
  ]);
  assert.equal(models[0].model, 'gemini-2.5-pro');
  assert.equal(models[0].maxInputTokens, 100);
  assert.equal(models[0].maxOutputTokens, 20);
  assert.equal(models[1].model, 'gemini-2.5-flash');
});

test('builds and paginates Anthropic model endpoint and metadata', async () => {
  assert.deepEqual(
    discoveryRequest({ id: 'a', provider: 'anthropic', baseURL: 'https://api.anthropic.com/v1' }),
    {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'anthropic-version': '2023-06-01' }
    }
  );
  const requests: Array<{ url: string; key: string | null; version: string | null }> = [];
  const models = await discoverModels(
    { id: 'a', provider: 'anthropic', baseURL: 'https://proxy.test' },
    'key',
    async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        key: headers.get('x-api-key'),
        version: headers.get('anthropic-version')
      });
      return requests.length === 1
        ? new Response(
            JSON.stringify({
              data: [
                {
                  id: 'claude-a',
                  display_name: 'Claude A',
                  max_input_tokens: 200000,
                  max_tokens: 32000,
                  capabilities: { image_input: { supported: false } }
                }
              ],
              has_more: true,
              last_id: 'claude-a'
            })
          )
        : new Response(JSON.stringify({ data: [{ id: 'claude-b' }], has_more: false }));
    }
  );
  assert.deepEqual(requests, [
    { url: 'https://proxy.test/v1/models', key: 'key', version: '2023-06-01' },
    { url: 'https://proxy.test/v1/models?after_id=claude-a', key: 'key', version: '2023-06-01' }
  ]);
  assert.equal(models[0].name, 'Claude A');
  assert.equal(models[0].maxInputTokens, 200000);
  assert.equal(models[0].maxOutputTokens, 32000);
  assert.equal(models[0].imageInput, false);
  assert.equal(models[0].baseURL, 'https://proxy.test/v1');
  assert.equal(models[1].model, 'claude-b');
});

test('manual models win and discovery cache supports expiry force and clear', async () => {
  const manual = { id: 'local/model-a', provider: 'anthropic' as const, model: 'manual' };
  const remote = { id: 'local/model-a', provider: 'anthropic' as const, model: 'remote' };
  assert.equal(mergeModels([manual], [remote])[0].model, 'manual');
  let calls = 0;
  let now = 0;
  const discovery = new ModelDiscovery(
    { get: async () => 'key' },
    async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ data: [{ id: `m-${calls}` }] }));
    },
    () => now
  );
  const [a, b] = await Promise.all([discovery.discover(openai), discovery.discover(openai)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(await discovery.discover(openai), a);
  assert.equal(calls, 1);
  await discovery.discover(openai, true);
  assert.equal(calls, 2);
  now = 15 * 60 * 1000 + 1;
  await discovery.discover(openai);
  assert.equal(calls, 3);
  discovery.clear(openai.id);
  await discovery.discover(openai);
  assert.equal(calls, 4);
});

test('missing discovery key fails without issuing a request', async () => {
  let calls = 0;
  const discovery = new ModelDiscovery({ get: async () => undefined }, async () => {
    calls++;
    return new Response();
  });
  await assert.rejects(() => discovery.discover(openai), /No API key for profile local/);
  assert.equal(calls, 0);
});

test('discovery errors do not expose API keys', async () => {
  await assert.rejects(
    () => discoverModels(openai, 'top-secret', async () => new Response('', { status: 500 })),
    (error) => {
      assert.equal(String(error).includes('top-secret'), false);
      return true;
    }
  );
});
