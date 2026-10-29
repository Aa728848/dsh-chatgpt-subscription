import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  REFUSED_SYSTEM_MEMORY_LIMIT,
  WorkBuddyAdapter,
  clearRefusedSystemKeys,
  refusedSystemKeyCount,
  refusedSystemKeyKnown,
  rememberRefusedSystemKey,
} from '../src/host/workbuddy/adapter.ts'
import {
  chatSystemKey,
  isChannelRefusal11128,
  relocateSystemToInstructions,
} from '../src/host/workbuddy/mapper.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/workbuddy/token-store.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
]

const temporaryDirs: string[] = []

async function makeStore(): Promise<FileCredentialStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-refusal-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 3_600_000,
      domain: 'copilot.tencent.com',
    },
  }), 'utf8')
  return createWorkBuddyStore(dir)
}

function makeAdapter(store: FileCredentialStore, fetchFn: typeof fetch): WorkBuddyAdapter {
  const preferences = {
    status: () => ({
      enabled: true,
      enabledModelIds: CATALOG.map((model) => model.id),
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    }),
    update: async () => { throw new Error('not used in this test') },
  }
  return new WorkBuddyAdapter(
    store,
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    preferences as any,
    { fetchFn, loadCatalog: async () => CATALOG },
  )
}

/** The JSON body of one stubbed request, decompressed when it went gzipped. */
function requestBody(init: { body?: BodyInit | null } | undefined): any {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) return JSON.parse(gunzipSync(body).toString('utf8'))
  throw new Error('unexpected request body shape: ' + Object.prototype.toString.call(body))
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function refusal(msg: string): Response {
  return new Response(JSON.stringify({ code: 11128, msg }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}

function chatOk(): Response {
  return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
}

/**
 * The DSH opening line AFTER the chat path's WAF rewrite.
 *
 * `sanitizeText` runs while the body is built, so the text the gateway sees —
 * and the text the refusal memory keys on — is the rewritten line, not the one
 * the harness handed over.
 */
const SANITIZED_OPENING = 'You are an AI assistant powered by DeepSeek Harness.'

function options(system: string, user = 'hello'): GenerateOptions {
  return {
    provider: 'workbuddy-subscription',
    model: 'glm-5.3',
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  } as GenerateOptions
}

async function drain(adapter: WorkBuddyAdapter, input: GenerateOptions): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  return chunks
}

beforeEach(() => {
  clearRefusedSystemKeys()
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('11128 classification', () => {
  it('repairs only the channel refusal, not the other 11128 readings', () => {
    // The code is overloaded upstream, and only one of its readings is a
    // message-shape problem this route can fix by moving the system prompt.
    expect(isChannelRefusal11128('Illegal API invocation from an unapproved channel')).toBe(true)
    expect(isChannelRefusal11128('unapproved channel')).toBe(true)
    expect(isChannelRefusal11128('{"code":11128,"msg":"conversation id missing"}')).toBe(false)
    expect(isChannelRefusal11128('{"code":11128,"msg":"first message is not system prompt"}')).toBe(false)
  })
})

describe('system relocation', () => {
  it('reads a chat by the text of its system prompt', () => {
    const body = JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'system', content: 'You are an AI assistant powered by DeepSeek Harness.' }, { role: 'user', content: 'hi' }],
    })
    expect(chatSystemKey(body)).toBe('You are an AI assistant powered by DeepSeek Harness.')
    // The neutral default has nothing to move, so it keys as empty.
    expect(chatSystemKey(JSON.stringify({ messages: [{ role: 'system', content: 'You are a helpful assistant.' }] }))).toBe('')
    expect(chatSystemKey('not json')).toBe('')
  })

  it('moves the leading system prompt into the first user turn, in instructions tags', () => {
    const body = JSON.stringify({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'You are an AI assistant powered by DeepSeek Harness.' },
        { role: 'user', content: 'hello' },
      ],
    })
    const moved = relocateSystemToInstructions(body)
    expect(moved).not.toBeNull()
    const parsed = JSON.parse(moved!)
    // The neutral default stands in the leading system position: leaving none
    // would answer "first message is not system prompt" instead.
    expect(parsed.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(parsed.messages[1].role).toBe('user')
    expect(parsed.messages[1].content).toBe(
      '<instructions>\nYou are an AI assistant powered by DeepSeek Harness.\n</instructions>\n\nhello',
    )
  })

  it('keeps image and tool parts exactly where they were', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'secret agent line' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'user', content: 'later system in place' },
        { role: 'system', content: 'a second system turn' },
      ],
    })
    const parsed = JSON.parse(relocateSystemToInstructions(body)!)
    expect(parsed.messages[1].content[0]).toEqual({
      type: 'text',
      text: '<instructions>\nsecret agent line\n</instructions>',
    })
    // The parts that were already there keep their order after the new first
    // block: the original text, then the image, byte for byte.
    expect(parsed.messages[1].content[1]).toEqual({ type: 'text', text: 'look' })
    expect(parsed.messages[1].content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
    // A system turn AFTER the opening becomes the user's where it stands.
    expect(parsed.messages[4]).toEqual({ role: 'user', content: 'a second system turn' })
  })

  it('answers null when there is nothing to move, so no retry is spent', () => {
    expect(relocateSystemToInstructions(JSON.stringify({
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'hi' }],
    }))).toBeNull()
    expect(relocateSystemToInstructions(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    }))).toBeNull()
    expect(relocateSystemToInstructions('not json')).toBeNull()
  })
})

describe('the adapter repairs a channel refusal once', () => {
  it('relocates the system prompt and replays the SAME body once', async () => {
    const store = await makeStore()
    const bodies: any[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(requestBody(init))
      return bodies.length === 1 ? refusal('Illegal API invocation from an unapproved channel') : chatOk()
    }
    const adapter = makeAdapter(store, fetchFn)
    const chunks = await drain(adapter, options('You are an AI assistant powered by DeepSeek Harness.'))

    expect(bodies).toHaveLength(2)
    // The first attempt is the ordinary shape: one leading system turn.
    expect(bodies[0].messages[0].role).toBe('system')
    expect(bodies[0].messages[0].content).toBe('You are an AI assistant powered by DeepSeek Harness.')
    // The replay is the moved shape.
    expect(bodies[1].messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(String(bodies[1].messages[1].content)).toContain('<instructions>')
    expect(String(bodies[1].messages[1].content)).toContain('You are an AI assistant powered by DeepSeek Harness.')
    // Nothing else about the request changed: same model, same tools contract.
    expect(bodies[1].model).toBe(bodies[0].model)
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    // And the refusal is remembered for the next conversation.
    expect(refusedSystemKeyKnown('You are an AI assistant powered by DeepSeek Harness.')).toBe(true)
  })

  it('sends a known-refused system prompt as the user words at once', async () => {
    const store = await makeStore()
    rememberRefusedSystemKey('You are an AI assistant powered by DeepSeek Harness.')
    const bodies: any[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(requestBody(init))
      return chatOk()
    }
    const adapter = makeAdapter(store, fetchFn)
    await drain(adapter, options('You are an AI assistant powered by DeepSeek Harness.'))

    // ONE request, already moved: the previous conversation paid the refusal.
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(String(bodies[0].messages[1].content)).toContain('<instructions>')
  })

  it('does not move anything for a conversation-id 11128', async () => {
    const store = await makeStore()
    const bodies: any[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(requestBody(init))
      return refusal('conversation id missing')
    }
    const adapter = makeAdapter(store, fetchFn)
    await expect(drain(adapter, options('You are an AI assistant powered by DeepSeek Harness.')))
      .rejects.toThrow(/blocked the request at its channel check/)
    // No replay: the header group the message names is a client-side fix, and a
    // moved system prompt cannot repair it.
    expect(bodies).toHaveLength(1)
    expect(refusedSystemKeyCount()).toBe(0)
  })

  it('does not move anything for the first-message 11128', async () => {
    const store = await makeStore()
    const bodies: any[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(requestBody(init))
      return refusal('first message is not system prompt')
    }
    const adapter = makeAdapter(store, fetchFn)
    await expect(drain(adapter, options('You are an AI assistant powered by DeepSeek Harness.')))
      .rejects.toThrow(/message history/)
    expect(bodies).toHaveLength(1)
    expect(refusedSystemKeyCount()).toBe(0)
  })
})

describe('the refusal memory is bounded', () => {
  it('remembers at most 256 system texts, evicting the oldest', () => {
    for (let index = 0; index < REFUSED_SYSTEM_MEMORY_LIMIT + 10; index += 1) {
      rememberRefusedSystemKey(`system-${index}`)
    }
    expect(refusedSystemKeyCount()).toBe(REFUSED_SYSTEM_MEMORY_LIMIT)
    // The first ten are gone; the newest are kept.
    expect(refusedSystemKeyKnown('system-0')).toBe(false)
    expect(refusedSystemKeyKnown(`system-${REFUSED_SYSTEM_MEMORY_LIMIT + 9}`)).toBe(true)
  })

  it('ignores an empty key, which is what a neutral prompt keys as', () => {
    rememberRefusedSystemKey('')
    expect(refusedSystemKeyCount()).toBe(0)
  })
})
