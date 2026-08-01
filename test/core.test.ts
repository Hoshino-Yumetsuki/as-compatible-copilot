import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertModelCapabilities,
  effectiveModelConfig,
  estimateTokens,
  formatUsage,
  reasoningProviderOptions,
  toModelPrompt
} from '../src/core.js';

void test('applies global settings and per-model overrides', () => {
  const model = effectiveModelConfig(
    { id: 'm', provider: 'anthropic', model: 'm', toolCalling: true },
    {
      reasoningEffort: 'high',
      contextLength: 256000,
      modelOverrides: { m: { contextLength: 512000, toolCalling: false } }
    }
  );
  assert.equal(model.contextLength, 512000);
  assert.equal(model.toolCalling, false);
  assert.equal(model.reasoningEffort, 'high');
});
void test('applies provider options and capability policy', () => {
  assert.deepEqual(
    reasoningProviderOptions({
      id: 'a',
      provider: 'anthropic',
      model: 'a',
      reasoningEffort: 'high'
    }),
    { anthropic: { effort: 'high' } }
  );
  assert.deepEqual(
    reasoningProviderOptions({
      id: 'o',
      provider: 'openai-responses',
      model: 'o',
      reasoningEffort: 'low'
    }),
    { openai: { reasoningEffort: 'low' } }
  );
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, value: 'x' }] }];
  assert.throws(
    () =>
      assertModelCapabilities(
        { id: 'm', provider: 'anthropic', model: 'm', toolCalling: false },
        messages,
        true
      ),
    /Tool calling/
  );
  assert.throws(
    () =>
      assertModelCapabilities(
        { id: 'm', provider: 'anthropic', model: 'm', imageInput: false },
        [
          {
            role: 'user',
            content: [{ type: 'data', data: new Uint8Array(1), mimeType: 'image/png' }]
          }
        ],
        false
      ),
    /Image input/
  );
});

void test('converts text and tool messages while separating instructions', () => {
  const result = toModelPrompt([
    { role: 'system', content: [{ type: 'text', value: 'first instruction' }] },
    { role: 'system', content: [{ type: 'text', value: 'second instruction' }] },
    { role: 'user', content: [{ type: 'text', value: 'hello' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', value: 'hi' },
        { type: 'tool-call', callId: 'c1', name: 'lookup', input: { q: 'x' } }
      ]
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', value: 'done' }] }]
    }
  ]);
  assert.deepEqual(result.instructions, [
    { role: 'system', content: 'first instruction' },
    { role: 'system', content: 'second instruction' }
  ]);
  assert.deepEqual(result.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'hello' }]
  });
  assert.deepEqual(result.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { q: 'x' } }
    ]
  });
  assert.equal(result.messages[2].role, 'tool');
  if (result.messages[2].role !== 'tool' || result.messages[2].content[0].type !== 'tool-result') {
    assert.fail('expected tool result');
  }
  assert.equal(result.messages[2].content[0].toolName, 'lookup');
});

void test('omits instructions when there are no system messages', () => {
  const result = toModelPrompt([{ role: 'user', content: [{ type: 'text', value: 'hello' }] }]);
  assert.equal(result.instructions, undefined);
  assert.equal(result.messages.length, 1);
});

void test('estimates tokens and formats safe usage diagnostics', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(
    estimateTokens({
      role: 'user',
      content: [{ type: 'data', data: new Uint8Array(12), mimeType: 'image/png' }]
    }),
    1
  );
  assert.equal(
    estimateTokens({
      role: 'assistant',
      content: [{ type: 'tool-call', callId: 'c', name: 'tool', input: { value: 'abcdef' } }]
    }),
    5
  );
  assert.equal(
    formatUsage({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }),
    'usage input=2 output=3 total=5'
  );
  assert.equal(formatUsage({ inputTokens: 2 }), 'usage input=2');
  assert.equal(formatUsage({}), undefined);
  assert.equal(formatUsage(undefined), undefined);
});
