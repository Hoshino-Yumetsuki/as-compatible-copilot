import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto"
import type { AssistantContent, TextStreamPart, ToolSet } from "ai"
import type { ModelConfig } from "./core.js"

type ReasoningPart = Extract<AssistantContent[number], { type: "reasoning" }>

export interface ThinkingPartData {
  value: string | string[]
  id?: string
  metadata?: Readonly<Record<string, unknown>>
}

type ReasoningModel = Pick<ModelConfig, "id" | "model" | "provider" | "profileId" | "baseURL">

const replayKey = "asCompatibleCopilot.reasoning"
const envelopePrefix = "ascc-reasoning-v1."
const hash = (value: string) => createHash("sha256").update(value, "utf16le").digest("hex")

type Continuation = { signature: string; textHash: string } | { redactedData: string }

function envelopeKey(apiKey: string, iv: Buffer) {
  return Buffer.from(hkdfSync("sha256", apiKey, iv, envelopePrefix, 32))
}

function seal(continuation: Continuation, id: string, apiKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", envelopeKey(apiKey, iv), iv)
  cipher.setAAD(Buffer.from(envelopePrefix + id))
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(continuation), "utf8"),
    cipher.final()
  ])
  return envelopePrefix + Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64url")
}

function unseal(envelope: string, id: string, apiKey: string): unknown {
  const encoded = envelope.slice(envelopePrefix.length)
  const bytes = Buffer.from(encoded, "base64url")
  if (bytes.length <= 28 || bytes.toString("base64url") !== encoded) return
  const iv = bytes.subarray(0, 12)
  try {
    const decipher = createDecipheriv("aes-256-gcm", envelopeKey(apiKey, iv), iv)
    decipher.setAAD(Buffer.from(envelopePrefix + id))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const payload = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
    return JSON.parse(payload.toString("utf8")) as unknown
  } catch {
    return undefined
  }
}

function scope(model: ReasoningModel): string {
  // The scoped thinking ID is authenticated as AAD along with the envelope version.
  return `rs_ascc1_${hash(JSON.stringify([model.provider, model.id, model.model, model.profileId, model.baseURL]))}_`
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const str = field(value, key)
  return typeof str === "string" && str.length > 0 ? str : undefined
}

function openAIItemId(value: unknown): string | undefined {
  // The SDK uses itemId as a key in a plain object when combining summaries.
  return typeof value === "string" &&
    /^[\w-]{1,256}$/.test(value) &&
    !Object.hasOwn(Object.prototype, value)
    ? value
    : undefined
}

function encryptedContent(value: unknown): string | undefined {
  return stringField(value, "encrypted_content")
}

function openAIContinuation(content: string | undefined): string | undefined {
  // VS Code decodes its reserved prefix; our envelopes are never sent to OpenAI.
  return content?.startsWith("vscode-reasoning-metadata:") || content?.startsWith("ascc-reasoning-")
    ? undefined
    : content
}

/** One adapter per streamText invocation. Only opt in to opaque state when the host requests it. */
export function createReasoningStream(
  model: ReasoningModel,
  includePrivateState = false,
  apiKey?: string
) {
  const prefix = `${scope(model)}${randomUUID().replaceAll("-", "")}_`
  let nextId = 0
  const active = new Map<
    string,
    {
      id: string
      first: boolean
      text: string
      signature?: string
      redactedData?: string
      encrypted?: string
    }
  >()

  return (part: TextStreamPart<ToolSet>): ThinkingPartData | undefined => {
    if (
      part.type !== "reasoning-start" &&
      part.type !== "reasoning-delta" &&
      part.type !== "reasoning-end"
    ) {
      return
    }
    const provider = model.provider
    const metadata = field(
      part.providerMetadata,
      provider === "openai-responses" ? "openai" : provider
    )
    if (part.type === "reasoning-start") {
      const itemId = provider === "openai-responses" && openAIItemId(field(metadata, "itemId"))
      active.set(part.id, {
        // AgentHost's Responses proxy preserves IDs starting with `rs`.
        id: itemId ? `${prefix}item_${itemId}` : `${prefix}block_${nextId++}`,
        first: true,
        text: ""
      })
    }
    const block = active.get(part.id)
    if (!block) return

    if (provider === "anthropic") {
      // Redacted blocks arrive at start, Anthropic signatures on empty deltas.
      block.redactedData = stringField(metadata, "redactedData") ?? block.redactedData
      if (includePrivateState)
        block.signature = stringField(metadata, "signature") ?? block.signature
    } else if (provider === "google" && includePrivateState) {
      block.signature = stringField(metadata, "thoughtSignature") ?? block.signature
    } else if (provider === "openai-responses" && includePrivateState) {
      block.encrypted = stringField(metadata, "reasoningEncryptedContent") ?? block.encrypted
    }

    if (part.type === "reasoning-delta" && part.text && !block.redactedData) {
      if (includePrivateState && (provider === "anthropic" || provider === "google"))
        block.text += part.text
      // Same OpenAI item id, new summary: an array tells AgentHost to append a summary entry.
      const value = provider === "openai-responses" && block.first ? [part.text] : part.text
      block.first = false
      return { value, id: block.id }
    }
    if (part.type !== "reasoning-end") return
    active.delete(part.id)
    if (!includePrivateState) return

    let continuation: ThinkingPartData["metadata"]
    if (provider === "openai-responses") {
      const encrypted = openAIContinuation(block.encrypted)
      if (encrypted)
        continuation = { encrypted_content: encrypted, vscode_thinking_origin_api: "responses" }
    } else {
      const state = block.redactedData
        ? { redactedData: block.redactedData }
        : block.signature && { signature: block.signature, textHash: hash(block.text) }
      if (state) {
        // The Responses wire drops arbitrary metadata and preserves encrypted_content verbatim.
        continuation = apiKey
          ? { encrypted_content: seal(state, block.id, apiKey) }
          : { [replayKey]: state }
      }
    }
    // Don't mark vscode_reasoning_done: AgentHost discards those parts, including metadata.
    // Empty value updates continuation state without repeating the already streamed text.
    return continuation && { value: "", id: block.id, metadata: continuation }
  }
}

/** One assistant reasoning item: an AgentHost-merged part or adjacent chunks with the same id. */
export function toReasoningParts(
  input: ThinkingPartData | readonly ThinkingPartData[],
  model: ReasoningModel,
  apiKey?: string
): ReasoningPart[] {
  const parts: readonly ThinkingPartData[] = Array.isArray(input)
    ? input
    : [input as ThinkingPartData]
  const id = parts[0]?.id
  const prefix = scope(model)
  if (typeof id !== "string" || !id.startsWith(prefix)) return []
  const match = /^[a-f0-9]{32}_(?:block_\d+|item_([\w-]{1,256}))$/.exec(id.slice(prefix.length))
  if (!match) return []

  const summary: string[] = []
  let continuation: unknown
  let encrypted: string | undefined
  for (const part of parts) {
    if (part.id !== id) return []
    if (Array.isArray(part.value) && part.value.every((value) => typeof value === "string")) {
      for (const value of part.value) summary.push(value)
    } else if (typeof part.value === "string") {
      if (summary.length) summary[summary.length - 1] += part.value
      else summary.push(part.value)
    } else {
      return []
    }
    continuation = field(part.metadata, replayKey) ?? continuation
    encrypted = encryptedContent(part.metadata) ?? encrypted
  }

  if (model.provider === "openai-responses") {
    encrypted = openAIContinuation(encrypted)
    if (!encrypted) return [] // Stateless replay cannot use an item reference alone.
    const itemId = openAIItemId(match[1])
    const openai = { ...(itemId && { itemId }), reasoningEncryptedContent: encrypted }
    const summaries = summary.filter(Boolean)
    return (summaries.length ? summaries : [""]).map((text) => ({
      type: "reasoning",
      text,
      providerOptions: { openai }
    }))
  }

  const text = summary.join("")
  if (model.provider === "openai-compatible") return text ? [{ type: "reasoning", text }] : []

  if (apiKey || encrypted !== undefined) {
    // Do not fall back to plaintext metadata when an envelope cannot be authenticated.
    if (!apiKey || !encrypted?.startsWith(envelopePrefix)) return []
    continuation = unseal(encrypted, id, apiKey)
  }
  const redactedData = stringField(continuation, "redactedData")
  if (model.provider === "anthropic" && redactedData && !text) {
    return [{ type: "reasoning", text: "", providerOptions: { anthropic: { redactedData } } }]
  }
  const signature = stringField(continuation, "signature")
  if (!signature || stringField(continuation, "textHash") !== hash(text)) return []
  if (model.provider === "anthropic")
    return [{ type: "reasoning", text, providerOptions: { anthropic: { signature } } }]
  return text
    ? [{ type: "reasoning", text, providerOptions: { google: { thoughtSignature: signature } } }]
    : []
}
