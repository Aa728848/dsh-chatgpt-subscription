import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { WorkBuddyAdapter, type WorkBuddyAccountPool } from '../src/host/workbuddy/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore, type WorkBuddyCredentials } from '../src/host/workbuddy/token-store.ts'
import { backendForDomain, isIntlDomain } from '../src/host/workbuddy/types.ts'
import type { WorkBuddyModelEntry } from '../src/host/workbuddy/model-catalog.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A catalog with one Claude model only the China deployment serves, and one chat
 * model both deployments serve.
 *
 * The Claude entry deliberately declares a ladder WITHOUT `max`: the Messages
 * surface takes the level verbatim in `output_config.effort`, so a level the
 * chat ladder would discard is exactly what this file has to prove is kept.
 */
const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200_000, maxContextWindow: 200_000,
    maxTokens: 32_000, regions: ['cn'], supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high',
    canDisableThinking: true, description: '',
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
]

const temporaryDirs: string[] = []

interface DesktopFileOptions {
  uid?: string
  domain?: string
  accessToken?: string
}

async function makeStore(options: DesktopFileOptions = {}): Promise<{ store: FileCredentialStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-messages-'))
  temporaryDirs.push(dir)
  await writeDesktopFile(dir, options)
  return { store: createWorkBuddyStore(dir), dir }
}

async function writeDesktopFile(dir: string, options: DesktopFileOptions = {}): Promise<void> {
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: options.uid ?? 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: {
      accessToken: options.accessToken ?? 'token-abc',
      refreshToken: 'refresh-abc',
      expiresAt: Date.now() + 3_600_000,
      domain: options.domain ?? 'copilot.tencent.com',
    },
  }), 'utf8')
}

function makeAdapter(store: FileCredentialStore, fetchFn: typeof fetch, accountPool?: WorkBuddyAccountPool): WorkBuddyAdapter {
  return new WorkBuddyAdapter(
    store,
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    undefined,
    { fetchFn, loadCatalog: async () => CATALOG, ...(accountPool === undefined ? {} : { accountPool }) },
  )
}

function requestBody(init: { body?: BodyInit | null } | undefined): any {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof Uint8Array) return JSON.parse(gunzipSync(body).toString('utf8'))
  throw new Error('unexpected request body shape: ' + Object.prototype.toString.call(body))
}

function headersOf(init: { headers?: HeadersInit } | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function chatOk(): Response {
  return sseResponse('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
}

function event(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** One complete Messages stream: thinking, text, a tool call, then usage. */
function messagesStream(): string {
  return [
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        usage: { input_tokens: 120, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 1 },
      },
    }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
    event('ping', { type: 'ping' }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join('')
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'workbuddy-subscription',
    model: 'claude-sonnet-4-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  } as GenerateOptions
}

async function drain(adapter: WorkBuddyAdapter, input: GenerateOptions): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  return chunks
}

/** A pool whose accounts are served in order, with every decision recorded. */
function makePool(accounts: Array<{ id: string; credentials: WorkBuddyCredentials }>) {
  const calls = {
    restriction: [] as Array<{ id: string; restriction: any }>,
    cooldown: [] as Array<{ id: string; ms: number }>,
    modelCooldown: [] as Array<{ id: string; model: string; until: number }>,
    renew: [] as string[],
  }
  const pool = {
    listAccounts: async () => accounts.map((account) => ({ id: account.id })),
    getEffectiveCredential: async (tried: ReadonlySet<string>) => {
      const next = accounts.find((account) => !tried.has(account.id))
      if (next === undefined) throw new LlmError('no account left', 'MISSING_CREDENTIAL')
      return { account: { id: next.id }, credentials: next.credentials }
    },
    renewCredential: async (id: string, _fetchFn: typeof fetch, current: WorkBuddyCredentials) => {
      calls.renew.push(id)
      return { ...current, accessToken: 'refreshed-token' }
    },
    hasAnotherAvailableAccount: async (tried: ReadonlySet<string>) => accounts.some((account) => !tried.has(account.id)),
    hasAnotherAvailableAccountFor: async (tried: ReadonlySet<string>) => accounts.some((account) => !tried.has(account.id)),
    markCooldown: async (id: string, ms: number) => { calls.cooldown.push({ id, ms }) },
    markModelCooldown: (id: string, model: string, until: number) => { calls.modelCooldown.push({ id, model, until }) },
    markAccountRestriction: async (id: string, restriction: any) => { calls.restriction.push({ id, restriction }) },
  }
  return { pool, calls }
}

async function credentialsFor(store: FileCredentialStore, uid: string, domain = 'copilot.tencent.com'): Promise<WorkBuddyCredentials> {
  const base = await store.read({ accountId: null, hiddenAccountIds: [] })
  if (base === null) throw new Error('no credential in the test store')
  return {
    ...base,
    uid,
    domain,
    region: isIntlDomain(domain) ? 'intl' : 'cn',
    backend: backendForDomain(domain),
    accessToken: `token-${uid}`,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('domestic Claude models go to /v1/messages', () => {
  it('posts an Anthropic request and keeps the level verbatim in output_config', async () => {
    const { store } = await makeStore()
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: headersOf(init), body: requestBody(init) })
      return sseResponse(messagesStream())
    }
    const adapter = makeAdapter(store, fetchFn)
    // 'max' is NOT in this model's declared ladder: the chat endpoint would drop
    // it, and the Messages surface must still carry it.
    await drain(adapter, options({ reasoningEffort: 'max' as any, maxTokens: 4096 }))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://copilot.tencent.com/v1/messages')
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
    // No static API key: the account's bearer is the only credential.
    expect(calls[0]!.headers['x-api-key']).toBeUndefined()
    expect(calls[0]!.headers.authorization).toBe('Bearer token-abc')

    const body = calls[0]!.body
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(4096)
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'max' })
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('keeps the chat endpoint for an international account', async () => {
    const { store } = await makeStore({ domain: 'www.workbuddy.ai' })
    const urls: string[] = []
    const fetchFn: typeof fetch = async (url) => {
      urls.push(String(url))
      return chatOk()
    }
    const adapter = makeAdapter(store, fetchFn)
    await drain(adapter, options())
    // Only the China deployment serves Messages; a Claude model on the
    // international one stays on chat completions.
    expect(urls).toEqual(['https://www.workbuddy.ai/v2/chat/completions'])
  })

  it('maps thinking, text, tool calls and usage off the Messages stream', async () => {
    const { store } = await makeStore()
    const adapter = makeAdapter(store, async () => sseResponse(messagesStream()))
    const chunks = await drain(adapter, options())

    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('')
    expect(reasoning).toBe('pondering')
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    expect(text).toBe('hi')

    const toolBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(toolBlock.block).toMatchObject({ type: 'tool-call', name: 'read_file', arguments: '{"path":"a.ts"}' })

    const usage = chunks.find((chunk) => chunk.type === 'usage')
    // The counts are disjoint: the cached 20 is reported apart, not inside input.
    expect(usage.usage).toMatchObject({ inputTokens: 100, outputTokens: 42, cacheReadTokens: 20 })

    const finish = chunks.find((chunk) => chunk.type === 'finish')
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
  })

  it('treats a stream without message_stop as truncated', async () => {
    const { store } = await makeStore()
    const truncated = [
      event('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }),
    ].join('')
    const adapter = makeAdapter(store, async () => sseResponse(truncated))
    await expect(drain(adapter, options())).rejects.toThrow(/message_stop/)
  })
})

describe('Messages history projection', () => {
  it('replays a tool batch as tool_use / tool_result blocks', async () => {
    const { store } = await makeStore()
    const bodies: any[] = []
    const adapter = makeAdapter(store, async (_url, init) => {
      bodies.push(requestBody(init))
      return sseResponse(messagesStream())
    })
    await drain(adapter, options({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'read a.ts' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [{ type: 'tool-call', id: ToolCallId('call_1'), name: 'read_file', arguments: '{"path":"a.ts"}' }],
          source: { provider: 'workbuddy-subscription', model: 'claude-sonnet-4-5' },
        }),
        createToolResultMessage({ callId: ToolCallId('call_1'), content: [{ type: 'text', text: 'contents' }], isError: false }),
      ],
    }))

    const messages = bodies[0].messages
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }],
    })
  })

  it('drops an unsigned thinking block and replays a signed one as it came', async () => {
    const { store } = await makeStore()
    const bodies: any[] = []
    const adapter = makeAdapter(store, async (_url, init) => {
      bodies.push(requestBody(init))
      return sseResponse(messagesStream())
    })
    await drain(adapter, options({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
        createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'unsigned thinking' },
            { type: 'reasoning', text: 'signed thinking', signature: 'sig-9' } as any,
            { type: 'text', text: 'answer' },
          ],
          source: { provider: 'workbuddy-subscription', model: 'claude-sonnet-4-5' },
        }),
      ],
    }))

    const assistant = bodies[0].messages[1]
    // The unverifiable block is gone (it would answer 11159); the signed one is
    // replayed with its signature, exactly as Anthropic asks.
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'signed thinking', signature: 'sig-9' },
      { type: 'text', text: 'answer' },
    ])
  })
})

describe('request identity on the wire', () => {
  it('gzips a chat body and decompresses to the same JSON', async () => {
    const { store } = await makeStore()
    let raw: Uint8Array | undefined
    let encoding: string | undefined
    const adapter = makeAdapter(store, async (_url, init) => {
      raw = init?.body as Uint8Array
      encoding = headersOf(init)['content-encoding']
      return chatOk()
    })
    await drain(adapter, options({ model: 'glm-5.3' }))
    expect(encoding).toBe('gzip')
    // A real deflate stream, not a label: the bytes decompress to the JSON.
    const decoded = JSON.parse(gunzipSync(raw!).toString('utf8'))
    expect(decoded.model).toBe('glm-5.3')
    expect(decoded.cache_retention).toBe('long')
  })

  it('keeps one request id across the tool steps of a turn and changes it on the next turn', async () => {
    const { store } = await makeStore()
    const ids: string[] = []
    const adapter = makeAdapter(store, async (_url, init) => {
      ids.push(headersOf(init)['x-conversation-request-id']!)
      return chatOk()
    })
    const first = { role: 'user', content: [{ type: 'text', text: 'one' }] } as any
    const toolCall = { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }] } as any
    const toolResult = {
      role: 'user',
      source: { kind: 'tool' },
      content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'r' }] }],
    } as any

    await drain(adapter, options({ model: 'glm-5.3', sessionId: 'session-1', messages: [first] } as any))
    await drain(adapter, options({ model: 'glm-5.3', sessionId: 'session-1', messages: [first, toolCall, toolResult] } as any))
    await drain(adapter, options({
      model: 'glm-5.3',
      sessionId: 'session-1',
      messages: [first, toolCall, toolResult, { role: 'user', content: [{ type: 'text', text: 'two' }] }],
    } as any))

    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('never lets two accounts share a conversation id', async () => {
    const { store } = await makeStore()
    const seen: Array<Record<string, string>> = []
    const adapter = makeAdapter(store, async (_url, init) => {
      seen.push(headersOf(init))
      return chatOk()
    })
    await drain(adapter, options({ model: 'glm-5.3', sessionId: 'session-1' } as any))

    const other = await credentialsFor(store, 'uid-2')
    const poolAdapter = makeAdapter(store, async (_url, init) => {
      seen.push(headersOf(init))
      return chatOk()
    }, makePool([{ id: 'acct-2', credentials: other }]).pool)
    await drain(poolAdapter, options({ model: 'glm-5.3', sessionId: 'session-1' } as any))

    expect(seen).toHaveLength(2)
    expect(seen[0]!['x-conversation-id']).not.toBe(seen[1]!['x-conversation-id'])
    expect(seen[0]!['x-conversation-request-id']).not.toBe(seen[1]!['x-conversation-request-id'])
  })
})

describe('account-scoped refusals', () => {
  it('freezes the account on 11140 and serves the request from another one', async () => {
    const { store } = await makeStore()
    const accounts = [
      { id: 'acct-1', credentials: await credentialsFor(store, 'uid-1') },
      { id: 'acct-2', credentials: await credentialsFor(store, 'uid-2') },
    ]
    const { pool, calls } = makePool(accounts)
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      seen.push(headersOf(init).authorization!)
      if (seen.length === 1) {
        return new Response(JSON.stringify({ code: 11140, msg: 'account has been restricted' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return chatOk()
    }
    const adapter = makeAdapter(store, fetchFn, pool)
    await drain(adapter, options({ model: 'glm-5.3' }))

    // The pool's frozen restriction seam is what records it: an account verdict,
    // not a model park and not a usage window.
    expect(calls.restriction).toHaveLength(1)
    expect(calls.restriction[0]!.id).toBe('acct-1')
    expect(calls.restriction[0]!.restriction.code).toBe(11140)
    expect(seen[1]).toBe('Bearer token-uid-2')
  })

  it('waits for restriction persistence before rotating to another account', async () => {
    const { store } = await makeStore()
    const accounts = [
      { id: 'acct-1', credentials: await credentialsFor(store, 'uid-1') },
      { id: 'acct-2', credentials: await credentialsFor(store, 'uid-2') },
    ]
    const { pool, calls } = makePool(accounts)
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    pool.markAccountRestriction = async (id, restriction) => {
      calls.restriction.push({ id, restriction })
      await persisted
    }
    const seen: string[] = []
    const adapter = makeAdapter(store, async (_url, init) => {
      seen.push(headersOf(init).authorization!)
      return seen.length === 1
        ? new Response(JSON.stringify({ code: 11140, msg: 'restricted' }), { status: 400 })
        : chatOk()
    }, pool)

    const pending = drain(adapter, options({ model: 'glm-5.3' }))
    try {
      await vi.waitFor(() => expect(calls.restriction).toHaveLength(1))
      // The write is still pending: a second upstream request must not start.
      expect(seen).toHaveLength(1)
    } finally {
      release()
    }
    await pending
    expect(seen[1]).toBe('Bearer token-uid-2')
  })

  it('presents a whole-pool pause as it is, without rotating or retrying', async () => {
    const { store } = await makeStore()
    const paused = Object.assign(new Error('the whole pool is paused'), { name: 'WorkBuddyPoolPausedError' })
    const pool = {
      listAccounts: async () => [],
      getEffectiveCredential: async () => { throw paused },
      renewCredential: async () => { throw new Error('not used') },
      hasAnotherAvailableAccount: async () => false,
      hasAnotherAvailableAccountFor: async () => false,
      markCooldown: async () => undefined,
      markModelCooldown: () => undefined,
      markAccountRestriction: async () => undefined,
    }
    let fetched = 0
    const adapter = makeAdapter(store, async () => { fetched += 1; return chatOk() }, pool)
    await expect(drain(adapter, options({ model: 'glm-5.3' }))).rejects.toBe(paused)
    // Nothing was sent: the pool's verdict is the answer.
    expect(fetched).toBe(0)
  })
})

describe('401 is renewed once and replayed once', () => {
  it('adopts a token another process wrote instead of refreshing over it', async () => {
    const { store, dir } = await makeStore()
    const auth: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      auth.push(headersOf(init).authorization!)
      if (auth.length === 1) {
        // The desktop app (or a sibling plugin) signed in while this request was
        // in flight: its token is already on disk and is the newest one.
        await writeDesktopFile(dir, { accessToken: 'token-from-desktop-app' })
        return new Response('{"code":401,"msg":"unauthorized"}', { status: 401 })
      }
      return chatOk()
    }
    const accounts = [{ id: 'cn:uid-1', credentials: await credentialsFor(store, 'uid-1') }]
    const { pool, calls } = makePool(accounts)
    const adapter = makeAdapter(store, fetchFn, pool)
    await drain(adapter, options({ model: 'glm-5.3' }))

    expect(auth).toHaveLength(2)
    expect(auth[1]).toBe('Bearer token-from-desktop-app')
    // No refresh was spent: refreshing would rotate the token out from under the
    // process that just signed in.
    expect(calls.renew).toEqual([])
  })

  it('renews once and replays the same body', async () => {
    const { store } = await makeStore()
    const auth: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      auth.push(headersOf(init).authorization!)
      return auth.length === 1 ? new Response('{}', { status: 401 }) : chatOk()
    }
    const accounts = [{
      id: 'cn:uid-1',
      // The stored credential has not changed, so the retry must spend the
      // pool's refresh path rather than adopting a different on-disk token.
      credentials: { ...(await credentialsFor(store, 'uid-1')), accessToken: 'token-abc' },
    }]
    const { pool, calls } = makePool(accounts)
    const adapter = makeAdapter(store, fetchFn, pool)
    await drain(adapter, options({ model: 'glm-5.3' }))

    expect(calls.renew).toEqual(['cn:uid-1'])
    expect(auth).toHaveLength(2)
    expect(auth[1]).toBe('Bearer refreshed-token')
  })

  it('renews and replays once on the single-credential path too', async () => {
    const { store } = await makeStore()
    const auth: string[] = []
    let refreshes = 0
    const adapter = makeAdapter(store, async (url, init) => {
      if (String(url).endsWith('/v2/plugin/auth/token/refresh')) {
        refreshes += 1
        return new Response(JSON.stringify({
          code: 0,
          data: { accessToken: 'renewed-single', refreshToken: 'refresh-single', expiresAt: Date.now() + 3_600_000 },
        }), { status: 200 })
      }
      auth.push(headersOf(init).authorization!)
      return auth.length === 1 ? new Response('{}', { status: 401 }) : chatOk()
    })

    await drain(adapter, options({ model: 'glm-5.3' }))
    expect(refreshes).toBe(1)
    expect(auth).toEqual(['Bearer token-abc', 'Bearer renewed-single'])
    expect((await store.read({ force: true }))?.accessToken).toBe('renewed-single')
  })

  it('does not write an account dead when even the renewed token is refused', async () => {
    const { store } = await makeStore()
    const accounts = [{ id: 'cn:uid-1', credentials: await credentialsFor(store, 'uid-1') }]
    const { pool, calls } = makePool(accounts)
    const fetchFn: typeof fetch = async () => new Response('{"code":401}', { status: 401 })
    const adapter = makeAdapter(store, fetchFn, pool)

    // A bare 401 is a statement about one presentation of the credential, so it
    // is reported without a credential verdict and without a cooldown.
    await expect(drain(adapter, options({ model: 'glm-5.3' })))
      .rejects.toThrow(/NOT marked invalid/)
    expect(calls.cooldown).toEqual([])
    expect(calls.restriction).toEqual([])
  })
})
