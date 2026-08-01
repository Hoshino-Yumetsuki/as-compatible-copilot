import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, formatUsage, toModelMessages } from '../src/core.js';

test('converts text and tool messages without adding instructions', () => {
  const result = toModelMessages([
    { role: 'system', content: [{ type: 'text', value: 'copilot instructions' }] },
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
  assert.deepEqual(result[0], { role: 'system', content: 'copilot instructions' });
  assert.deepEqual(result[1], { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  assert.deepEqual(result[2], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { q: 'x' } }
    ]
  });
  assert.equal(result[3].role, 'tool');
  if (result[3].role !== 'tool' || result[3].content[0].type !== 'tool-result') {
    assert.fail('expected tool result');
  }
  assert.equal(result[3].content[0].toolName, 'lookup');
});

test('estimates tokens and formats safe usage diagnostics', () => {
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
