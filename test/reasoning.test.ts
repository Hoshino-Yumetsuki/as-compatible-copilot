import assert from "node:assert/strict"
import test from "node:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, streamText, type LanguageModel, type TextStreamPart, type ToolSet } from "ai"
import type { ModelConfig } from "../src/core.js"
import { createReasoningStream, toReasoningParts, type ThinkingPartData } from "../src/reasoning.js"

type Event = Extract<TextStreamPart<ToolSet>, { type: `reasoning-${string}` }>
const anthropic = {
  id: "claude",
  provider: "anthropic",
  model: "claude-sonnet-4-6"
} satisfies ModelConfig
const google = {
  id: "gemini",
  provider: "google",
  model: "gemini-3.1-pro-preview"
} satisfies ModelConfig
const openai = { id: "gpt", provider: "openai-responses", model: "gpt-5" } satisfies ModelConfig
const compatible = {
  id: "deepseek",
  provider: "openai-compatible",
  model: "deepseek-reasoner",
  baseURL: "https://compatible.invalid/v1"
} satisfies ModelConfig

const apiKey = "test-api-key"

function stream(model: ModelConfig, events: Event[], include = true, key?: string) {
  const push = createReasoningStream(model, include, key)
  return events.map(push).filter((part) => part !== undefined)
}

// Mirrors the BYOK bridge's same-id array/string fold and reconstructs the host's history part.
function hostHistory(parts: ThinkingPartData[], dropCustom = false): ThinkingPartData {
  assert.ok(parts.length)
  const summary: string[] = []
  const metadata: Record<string, unknown> = {}
  const { id } = parts[0]
  for (const part of parts) {
    assert.equal(part.id, id)
    if (Array.isArray(part.value)) summary.push(...part.value)
    else if (summary.length) summary[summary.length - 1] += part.value
    else summary.push(part.value)
    if (dropCustom) {
      for (const key of ["encrypted_content", "signature", "_completeThinking", "redactedData"]) {
        if (part.metadata?.[key] !== undefined) metadata[key] = part.metadata[key]
      }
    } else Object.assign(metadata, part.metadata)
  }
  return { id: id?.startsWith("rs") ? id : "rs_byok_new", value: summary, metadata }
}

const start = (id = "0"): Event => ({ type: "reasoning-start", id })
const end = (id = "0"): Event => ({ type: "reasoning-end", id })
const delta = (text: string, id = "0"): Event => ({ type: "reasoning-delta", id, text })

void test("preserves Anthropic signed text exactly without duplicating it or surfacing the signature", () => {
  const events: Event[] = [
    start(),
    delta("  one\n"),
    delta("two  "),
    {
      ...delta(""),
      providerMetadata: { anthropic: { signature: "opaque-signature", other: "private" } }
    },
    end()
  ]
  const parts = stream(anthropic, events)
  assert.deepEqual(
    parts.map((part) => part.value),
    ["  one\n", "two  ", ""]
  )
  assert.equal(JSON.stringify(parts).includes("other"), false)
  assert.equal(parts[2].metadata?.signature, undefined)
  const history = hostHistory(parts)
  const expected = [
    {
      type: "reasoning",
      text: "  one\ntwo  ",
      providerOptions: { anthropic: { signature: "opaque-signature" } }
    }
  ]
  assert.deepEqual(toReasoningParts(parts, anthropic), expected)
  assert.deepEqual(toReasoningParts(history, anthropic), expected)
  assert.deepEqual(toReasoningParts({ ...history, value: ["one\ntwo"] }, anthropic), [])
  assert.deepEqual(toReasoningParts(hostHistory(parts, true), anthropic), [])
  const sealedParts = stream(anthropic, events, true, apiKey)
  const sealed = hostHistory(sealedParts, true)
  assert.deepEqual(sealed.value, history.value)
  assert.doesNotMatch(JSON.stringify(sealedParts), /opaque-signature|test-api-key/)
  assert.deepEqual(toReasoningParts(sealed, anthropic, apiKey), expected)
  assert.deepEqual(toReasoningParts({ ...sealed, value: ["changed"] }, anthropic, apiKey), [])
  assert.deepEqual(
    stream(anthropic, events, false, apiKey).map((part) => part.value),
    ["  one\n", "two  "]
  )
})

void test("keeps redacted thinking and empty signed Anthropic blocks opaque", () => {
  const parts = stream(
    anthropic,
    [
      { ...start(), providerMetadata: { anthropic: { redactedData: "opaque-redacted" } } },
      delta("never show a redacted block"),
      end()
    ],
    true,
    apiKey
  )
  assert.deepEqual(
    parts.map((part) => part.value),
    [""]
  )
  assert.doesNotMatch(JSON.stringify(parts), /opaque-redacted/)
  assert.deepEqual(toReasoningParts(hostHistory(parts, true), anthropic, apiKey), [
    {
      type: "reasoning",
      text: "",
      providerOptions: { anthropic: { redactedData: "opaque-redacted" } }
    }
  ])
  const signedEmpty = stream(anthropic, [
    start(),
    { ...end(), providerMetadata: { anthropic: { signature: "opaque" } } }
  ])
  assert.deepEqual(toReasoningParts(hostHistory(signedEmpty), anthropic), [
    { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "opaque" } } }
  ])
})

const first = "rs_example:0"
const second = "rs_example:1"
const item = { openai: { itemId: "rs_example" } }
const encryptedItem = {
  openai: { itemId: "rs_example", reasoningEncryptedContent: "provider-ciphertext" }
}
const openAIEvents: Event[] = [
  { ...start(first), providerMetadata: item },
  delta("one", first),
  delta(" two", first),
  { ...end(first), providerMetadata: item },
  { ...start(second), providerMetadata: item },
  delta("three", second),
  { ...end(second), providerMetadata: encryptedItem }
]

void test("preserves OpenAI Responses item id, summary boundaries and late ciphertext after bridge metadata loss", () => {
  const parts = stream(openai, openAIEvents)
  assert.deepEqual(
    parts.map((part) => part.value),
    [["one"], " two", ["three"], ""]
  )
  const history = hostHistory(parts, true)
  assert.deepEqual(history.value, ["one two", "three"])
  const expected = ["one two", "three"].map((text) => ({
    type: "reasoning",
    text,
    providerOptions: encryptedItem
  }))
  assert.deepEqual(toReasoningParts(history, openai), expected)
  assert.deepEqual(toReasoningParts(parts, openai), expected)
  assert.deepEqual(toReasoningParts(hostHistory(parts.slice(0, -1)), openai), [])
  assert.deepEqual(
    toReasoningParts(
      hostHistory(
        stream(openai, [
          { ...start(first), providerMetadata: item },
          { ...end(first), providerMetadata: encryptedItem }
        ])
      ),
      openai
    ),
    [{ type: "reasoning", text: "", providerOptions: encryptedItem }]
  )
})

void test("fails closed for unscoped, foreign-model, foreign-provider or changed-endpoint reasoning", () => {
  const history = hostHistory(stream(openai, openAIEvents))
  assert.deepEqual(toReasoningParts({ ...history, id: "rs_example" }, openai), [])
  for (const target of [
    anthropic,
    google,
    { ...openai, provider: "openai-compatible" as const },
    { ...openai, model: "different-model" },
    { ...openai, id: "other-config" },
    { ...openai, profileId: "other-account" },
    { ...openai, baseURL: "https://different.invalid/v1" }
  ])
    assert.deepEqual(toReasoningParts(history, target), [])
  const malformed = { ...history, metadata: { encrypted_content: "vscode-reasoning-metadata:{}" } }
  assert.deepEqual(toReasoningParts(malformed, openai), [])
})

void test("Google reasoning keeps a thought signature in providerOptions, not as display text", () => {
  const events: Event[] = [
    start(),
    delta("first "),
    {
      ...delta("second"),
      providerMetadata: {
        google: { thoughtSignature: "google-signed" },
        anthropic: { signature: "unrelated" }
      }
    },
    end()
  ]
  const parts = stream(google, events, true, apiKey)
  assert.deepEqual(
    parts.map((part) => part.value),
    ["first ", "second", ""]
  )
  assert.doesNotMatch(JSON.stringify(parts), /google-signed|unrelated/)
  assert.deepEqual(toReasoningParts(hostHistory(parts, true), google, apiKey), [
    {
      type: "reasoning",
      text: "first second",
      providerOptions: { google: { thoughtSignature: "google-signed" } }
    }
  ])
  assert.deepEqual(toReasoningParts(hostHistory(parts, true), google), [])
  assert.deepEqual(toReasoningParts(hostHistory(stream(google, events, false)), google), [])
})

void test("rejects tampered, moved or wrong-account envelopes without falling back to raw state", () => {
  const events: Event[] = [
    start(),
    delta("thought"),
    {
      ...end(),
      providerMetadata: { anthropic: { signature: "signed-opaque" } }
    }
  ]
  const history = hostHistory(stream(anthropic, events, true, apiKey), true)
  const ciphertext = history.metadata?.encrypted_content
  assert.equal(typeof ciphertext, "string")
  if (typeof ciphertext !== "string") assert.fail("missing envelope")
  assert.notEqual(
    ciphertext,
    hostHistory(stream(anthropic, events, true, apiKey), true).metadata?.encrypted_content
  )
  const tampered =
    ciphertext.slice(0, -2) + (ciphertext.at(-2) === "A" ? "B" : "A") + ciphertext.at(-1)
  assert.deepEqual(toReasoningParts(history, anthropic, "different-account-key"), [])
  assert.deepEqual(toReasoningParts(history, anthropic), [])
  for (const changed of [
    { ...anthropic, profileId: "different-profile" },
    { ...anthropic, baseURL: "https://different.invalid" },
    google,
    openai
  ]) {
    assert.deepEqual(toReasoningParts(history, changed, apiKey), [])
    const fresh = hostHistory(stream(changed, [start(), delta("thought"), end()]), true)
    assert.deepEqual(toReasoningParts({ ...history, id: fresh.id }, changed, apiKey), [])
  }
  const fresh = hostHistory(stream(anthropic, events, true, apiKey), true)
  assert.deepEqual(toReasoningParts({ ...history, id: fresh.id }, anthropic, apiKey), [])
  const raw = hostHistory(stream(anthropic, events))
  assert.deepEqual(toReasoningParts(raw, anthropic, apiKey), [])
  assert.deepEqual(
    toReasoningParts(
      { ...history, metadata: { ...raw.metadata, encrypted_content: tampered } },
      anthropic,
      apiKey
    ),
    []
  )
})

void test("stream scopes are unique, SDK block ids can be reused, and incomplete blocks do not replay", () => {
  const push = createReasoningStream(anthropic, true)
  assert.equal(push({ type: "text-delta", id: "0", text: "not reasoning" }), undefined)
  assert.equal(push(delta("orphan")), undefined)
  assert.equal(push(start()), undefined)
  const first = push(delta("a"))
  assert.ok(first)
  assert.equal(push(end()), undefined)
  push(start())
  const second = push(delta("b"))
  assert.ok(second)
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.id, stream(anthropic, [start(), delta("a")])[0].id)
  assert.deepEqual(toReasoningParts(second, anthropic), [])
})

void test("Anthropic SSE yields a signature on an empty fullStream delta and preserves redacted blocks", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "thought" }
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed" }
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "redacted" }
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" }
  ]
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } }
    )
  const push = createReasoningStream(anthropic, true, apiKey)
  const result = streamText({
    model: createAnthropic({ apiKey: "test", fetch })(anthropic.model),
    prompt: "start"
  })
  const parts: ThinkingPartData[] = []
  for await (const event of result.fullStream) {
    assert.notEqual(event.type, "error")
    const part = push(event)
    if (part) parts.push(part)
  }
  assert.deepEqual(
    parts.map((part) => part.value),
    ["thought", "", ""]
  )
  assert.deepEqual(toReasoningParts(hostHistory(parts.slice(0, 2), true), anthropic, apiKey), [
    { type: "reasoning", text: "thought", providerOptions: { anthropic: { signature: "signed" } } }
  ])
  assert.deepEqual(toReasoningParts(hostHistory(parts.slice(2), true), anthropic, apiKey), [
    { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "redacted" } } }
  ])
})

void test("replayed SDK ReasoningParts serialize to the appropriate provider request bodies", async () => {
  for (const model of [anthropic, google, openai, compatible]) {
    const sent: Record<string, unknown>[] = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const body = init?.body
      assert.equal(typeof body, "string")
      sent.push(JSON.parse(body as string))
      return new Response("mock: stop after recording request", { status: 400 })
    }
    const config = { apiKey: "test", fetch }
    let adapter: LanguageModel
    let events: Event[]
    if (model.provider === "anthropic") {
      adapter = createAnthropic(config)(model.model)
      events = [
        start(),
        delta("thought"),
        { ...end(), providerMetadata: { anthropic: { signature: "a" } } }
      ]
    } else if (model.provider === "google") {
      adapter = createGoogleGenerativeAI(config)(model.model)
      events = [
        start(),
        delta("thought"),
        { ...end(), providerMetadata: { google: { thoughtSignature: "g" } } }
      ]
    } else if (model.provider === "openai-compatible") {
      adapter = createOpenAICompatible({ ...config, name: model.id, baseURL: model.baseURL })(
        model.model
      )
      events = [start(), delta("thought"), end()]
    } else {
      adapter = createOpenAI(config).responses(model.model)
      events = openAIEvents
    }
    await assert.rejects(
      generateText({
        model: adapter,
        providerOptions:
          model.provider === "openai-responses" ? { openai: { store: false } } : undefined,
        messages: [
          { role: "user", content: "start" },
          {
            role: "assistant",
            content: [
              ...toReasoningParts(
                hostHistory(
                  stream(model, events, model.provider !== "openai-compatible", apiKey),
                  true
                ),
                model,
                apiKey
              ),
              { type: "text", text: "answer" }
            ]
          },
          { role: "user", content: "continue" }
        ]
      })
    )
    assert.equal(sent.length, 1)
    const serialized = JSON.stringify(sent[0])
    if (model.provider === "anthropic")
      assert.ok(serialized.includes('{"type":"thinking","thinking":"thought","signature":"a"}'))
    else if (model.provider === "google")
      assert.ok(serialized.includes('{"text":"thought","thought":true,"thoughtSignature":"g"}'))
    else if (model.provider === "openai-compatible")
      assert.ok(serialized.includes('"reasoning_content":"thought"'))
    else
      assert.ok(
        serialized.includes(
          '{"type":"reasoning","id":"rs_example","encrypted_content":"provider-ciphertext","summary":[{"type":"summary_text","text":"one two"},{"type":"summary_text","text":"three"}]}'
        )
      )
  }
})
