const assert = require("node:assert/strict")
const test = require("node:test")
const Module = require("node:module")

class Text {
  constructor(value) {
    this.value = value
  }
}
class Data {
  constructor(data, mimeType) {
    Object.assign(this, { data, mimeType })
  }
}
class Call {
  constructor(callId, name, input) {
    Object.assign(this, { callId, name, input })
  }
}
class Result {
  constructor(callId, content) {
    Object.assign(this, { callId, content })
  }
}
class Thinking {
  constructor(value, id, metadata) {
    Object.assign(this, { value, id, metadata })
  }
}
const tool = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "screenshot",
  arguments: "{}"
}
const item = (stage, value, output_index = 0) => ({
  type: `response.output_item.${stage}`,
  output_index,
  item: value
})
const complete = {
  type: "response.completed",
  response: {
    usage: { input_tokens: 12, output_tokens: 6, output_tokens_details: { reasoning_tokens: 3 } }
  }
}

for (const extended of [true, false])
  void test(`registered provider with optional thinking API ${extended ? "present" : "absent"}`, async (t) => {
    let provider
    const host = {
      LanguageModelChatMessageRole: { User: 1, Assistant: 2, ...(extended && { System: 3 }) },
      LanguageModelChatToolMode: { Required: 2 },
      LanguageModelTextPart: Text,
      LanguageModelDataPart: Data,
      LanguageModelToolCallPart: Call,
      LanguageModelToolResultPart: Result,
      ...(extended && { LanguageModelThinkingPart: Thinking }),
      EventEmitter: class {},
      window: { createOutputChannel: () => ({ appendLine() {} }) },
      commands: { registerCommand() {} },
      lm: {
        registerLanguageModelChatProvider: (_, impl) => {
          provider = impl
        }
      }
    }
    const original = Module._load
    const mock = t.mock.method(Module, "_load", function (id, ...args) {
      return id === "vscode" ? host : original.call(this, id, ...args)
    })
    const entry = require.resolve("../dist/test/extension.js")
    delete require.cache[entry]
    const { activate } = require(entry)
    mock.mock.restore()
    const model = {
      id: "p/o3",
      model: "o3",
      provider: "openai-responses",
      baseURL: "https://fixture.invalid/v1",
      maxInputTokens: 8192,
      maxOutputTokens: 1024,
      reasoningEffort: "low"
    }
    await activate({
      subscriptions: [],
      globalState: { get: () => ({ models: [model], profiles: [] }) },
      secrets: { get: async () => "fixture" }
    })
    const [info] = await provider.provideLanguageModelChatInformation()
    assert.equal(info.maxInputTokens, 8192)
    assert.deepEqual(info.configurationSchema.properties.reasoningEffort.enum, [
      "low",
      "medium",
      "high"
    ])
    const requests = []
    t.mock.method(globalThis, "fetch", async (_, init) => {
      requests.push(JSON.parse(init.body))
      const rs = { type: "reasoning", id: "rs_1" },
        msg = { type: "message", id: "msg_1" }
      const events =
        requests.length === 1
          ? [
              item("added", rs),
              { type: "response.reasoning_summary_part.added", item_id: rs.id, summary_index: 0 },
              {
                type: "response.reasoning_summary_text.delta",
                item_id: rs.id,
                summary_index: 0,
                delta: "Inspect the screen."
              },
              item("done", { ...rs, encrypted_content: "opaque" }),
              item("added", tool, 1),
              item("done", { ...tool, status: "completed" }, 1),
              complete
            ]
          : [
              item("added", msg),
              { type: "response.output_text.delta", item_id: msg.id, delta: "OK" },
              item("done", msg),
              complete
            ]
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" }
      })
    })
    const run = async (messages) => {
      const parts = []
      await provider.provideLanguageModelChatResponse(
        info,
        messages,
        {
          tools: [
            {
              name: tool.name,
              description: "test",
              inputSchema: { type: "object", properties: {} }
            }
          ],
          toolMode: 1,
          ...(extended && {
            modelConfiguration: { reasoningEffort: "high" },
            includeEncryptedThinking: true
          })
        },
        { report: (p) => parts.push(p) },
        { onCancellationRequested: () => ({ dispose() {} }) }
      )
      return parts
    }
    const history = [
      ...(extended ? [{ role: 3, content: [new Text("system")] }] : []),
      { role: 1, content: [new Text("inspect")] }
    ]
    const parts = await run(history)
    assert.equal(requests[0].reasoning.effort, extended ? "high" : "low")
    if (extended) assert.equal(requests[0].input[0].role, "developer")
    assert.equal(requests[0].max_output_tokens, 1024)
    assert.equal(
      parts
        .filter((p) => p instanceof Thinking)
        .flatMap((p) => p.value)
        .join(""),
      extended ? "Inspect the screen." : ""
    )
    const call = parts.find((p) => p instanceof Call)
    assert.equal(call?.callId, tool.call_id)
    const usage = parts.find((p) => p instanceof Data && p.mimeType === "usage")
    assert.deepEqual(JSON.parse(Buffer.from(usage.data)), {
      prompt_tokens: 12,
      completion_tokens: 6,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 3 }
    })
    const response = await run([
      ...history,
      { role: 2, content: parts.filter((p) => !(p instanceof Data)) },
      {
        role: 1,
        content: [
          new Result(call.callId, [new Data(Buffer.from([1, 2, 3]), "image/png")]),
          new Text("What is visible?")
        ]
      }
    ])
    const input = requests[1].input
    const replay = input.find((p) => p.type === "reasoning")
    assert.equal(replay?.encrypted_content, extended ? "opaque" : undefined)
    const output = input.find((p) => p.type === "function_call_output")
    assert.equal(output.call_id, tool.call_id)
    assert.equal(output.output[0].image_url, "data:image/png;base64,AQID")
    assert.match(JSON.stringify(input.at(-1)), /What is visible\?/)
    assert.equal(response.find((p) => p instanceof Text)?.value, "OK")
  })
