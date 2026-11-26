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
      model: 'claude-opus-4-6',
      reasoningEffort: 'high'
    }),
    { anthropic: { effort: 'high' } }
  );
  assert.deepEqual(
    reasoningProviderOptions({
      id: 'o',
      provider: 'openai-responses',
      model: 'o3',
      reasoningEffort: 'low'
    }),
    { openai: { reasoningEffort: 'low', reasoningSummary: 'auto' } }
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

void test('preserves mixed user content and multimodal tool results in order', () => {
  const image = new Uint8Array([1, 2, 3]);
  const result = toModelPrompt([
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', callId: 'a', name: 'first', input: {} },
        { type: 'tool-call', callId: 'b', name: 'second', input: {} }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'text', value: 'question' },
        {
          type: 'tool-result',
          callId: 'a',
          content: [
            { type: 'text', value: 'before' },
            { type: 'data', data: image, mimeType: 'image/png' },
            { type: 'text', value: 'after' }
          ]
        },
        { type: 'data', data: image, mimeType: 'image/png' }
      ]
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          callId: 'b',
          isError: true,
          content: [{ type: 'text', value: 'failed' }]
        },
        { type: 'text', value: 'more' }
      ]
    }
  ]);
  assert.deepEqual(result.messages.slice(1), [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'a',
          toolName: 'first',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'before' },
              { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
              { type: 'text', text: 'after' }
            ]
          }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'b',
          toolName: 'second',
          output: { type: 'error-text', value: 'failed' }
        }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'question' },
        { type: 'file', data: image, mediaType: 'image/png' }
      ]
    },
    { role: 'user', content: [{ type: 'text', text: 'more' }] }
  ]);
});

void test('keeps multiple plain tool results and detects nested disabled images', () => {
  const result = toModelPrompt([
    {
      role: 'user',
      content: [
        { type: 'tool-result', callId: '1', name: 'one', content: [{ type: 'text', value: 'ok' }] },
        {
          type: 'tool-result',
          callId: '2',
          name: 'two',
          content: [{ type: 'text', value: 'done' }]
        }
      ]
    }
  ]);
  assert.deepEqual(result.messages, [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: '1',
          toolName: 'one',
          output: { type: 'text', value: 'ok' }
        },
        {
          type: 'tool-result',
          toolCallId: '2',
          toolName: 'two',
          output: { type: 'text', value: 'done' }
        }
      ]
    }
  ]);
  assert.throws(
    () =>
      assertModelCapabilities(
        { id: 'm', provider: 'anthropic', model: 'm', imageInput: false },
        [
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                callId: '1',
                content: [{ type: 'data', data: new Uint8Array([1]), mimeType: 'image/png' }]
              }
            ]
          }
        ],
        false
      ),
    /Image input/
  );
});

void test('openai-compatible replays tool images as user images after all tool responses', async () => {
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const { generateText } = await import('ai');
  let request: any;
  const provider = createOpenAICompatible({
    name: 'test',
    baseURL: 'https://example.test/v1',
    fetch: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request');
      request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
  });
  const image = new Uint8Array([1, 2, 3]);
  const prompt = toModelPrompt(
    [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', callId: 'a', name: 'first', input: {} },
          { type: 'tool-call', callId: 'b', name: 'second', input: {} }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', value: 'question' },
          {
            type: 'tool-result',
            callId: 'a',
            isError: true,
            content: [
              { type: 'text', value: 'failed' },
              { type: 'data', data: image, mimeType: 'image/png' }
            ]
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            callId: 'b',
            content: [{ type: 'data', data: image, mimeType: 'image/png' }]
          }
        ]
      }
    ],
    { id: 'm', provider: 'openai-compatible', model: 'm' }
  );
  assert.equal(prompt.messages[1].role, 'tool');
  if (prompt.messages[1].role !== 'tool' || prompt.messages[1].content[0].type !== 'tool-result')
    assert.fail();
  assert.equal(prompt.messages[1].content[0].output.type, 'error-text');
  await generateText({ model: provider('m'), ...prompt });
  assert.deepEqual(
    request.messages.map((message: any) => message.role),
    ['assistant', 'tool', 'tool', 'user', 'user', 'user']
  );
  assert.equal(request.messages[1].tool_call_id, 'a');
  assert.match(request.messages[1].content, /failed.*\n.*"a"/);
  assert.equal(request.messages[2].tool_call_id, 'b');
  assert.match(request.messages[2].content, /"b"/);
  assert.match(request.messages[3].content[0].text, /"a"/);
  assert.equal(request.messages[3].content[1].image_url.url, 'data:image/png;base64,AQID');
  assert.equal(request.messages[4].content, 'question');
  assert.match(request.messages[5].content[0].text, /"b"/);
  assert.equal(request.messages[5].content[1].image_url.url, 'data:image/png;base64,AQID');
});

void test('native providers keep images in tool result content', () => {
  for (const provider of ['anthropic', 'google', 'openai-responses'] as const) {
    const { messages } = toModelPrompt(
      [
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              callId: 'id',
              content: [{ type: 'data', mimeType: 'image/png', data: new Uint8Array([1]) }]
            }
          ]
        }
      ],
      { id: 'm', model: 'm', provider }
    );
    assert.deepEqual(messages, [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'id',
            toolName: 'tool',
            output: {
              type: 'content',
              value: [
                {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'data', data: new Uint8Array([1]) }
                }
              ]
            }
          }
        ]
      }
    ]);
  }
});
