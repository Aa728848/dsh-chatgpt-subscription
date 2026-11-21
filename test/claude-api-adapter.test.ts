import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import { flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'
import { COMPACTION_INSTRUCTION } from '../src/host/compaction-prompt.ts'
import { ClaudeApiAdapter, isClaudeApiSpeedNeedsBeta, isClaudeApiSpeedUnsupported, isClaudeApiSystemRoleUnsupported } from '../src/host/claude-api/adapter.ts'
import { CLAUDE_API_CAPABILITY_MEMORY_TTL_MS, ClaudeApiCapabilityMemory } from '../src/host/claude-api/capability-memory.ts'
import { ClaudeApiCatalogManager } from '../src/host/claude-api/catalog-manager.ts'
import { ClaudeApiClientVersionResolver, claudeApiClientVersionPath, serializeClaudeApiClientVersion } from '../src/host/claude-api/client-version.ts'
import { ClaudeApiCompactionStore } from '../src/host/claude-api/compaction-store.ts'
import { ClaudeApiSettingsStore, claudeApiCredentialFingerprint, type ClaudeApiCredentials } from '../src/host/claude-api/token-store.ts'
import { promptCachePolicyOf } from '../src/host/common/prompt-cache-policy.ts'
import { promptCacheActivityStore } from '../src/host/common/cache-activity.ts'
import type { ClaudeApiCredentialStore } from '../src/host/claude-api/token-store.ts'
import { deriveClaudeApiBetas } from '../src/host/claude-api/mapper.ts'
import { isClaudeApiCompactionBlockInvalid, isClaudeApiCompactionUnsupported } from '../src/host/claude-api/compaction.ts'
import { resolveClaudeApiModel } from '../src/host/claude-api/model-catalog.ts'
import {
  CLAUDE_API_BETA_COMPACT,
  CLAUDE_API_BETA_FAST_MODE,
  CLAUDE_API_MESSAGES_PATH,
  CLAUDE_API_STAINLESS_HEADERS,
  claudeApiBillingBlock,
  claudeApiSessionUuid,
  claudeApiUrl,
  claudeApiUserAgent,
} from '../src/host/claude-api/types.ts'
import { CLAUDE_API_DEFAULT_BASE_URL, CLAUDE_API_PROVIDER_ID } from '../src/shared/claude-api-contracts.ts'

const MODEL = 'claude-haiku-5-5'
const KEY = 'sk-claude-test'
const SUMMARY = 'The user greeted the assistant and the assistant replied.'
const SCOPE = claudeApiCredentialFingerprint({ apiKey: KEY, authenticatedAt: 1 }, CLAUDE_API_DEFAULT_BASE_URL)

function options(extra: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: CLAUDE_API_PROVIDER_ID, model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...extra,
  } as GenerateOptions
}
function checkpoint(summary: string) {
  return {
    role: 'user', source: { kind: 'compact-checkpoint' },
    content: [{ type: 'text', text: 'Earlier conversation follows.\n\n<compacted-summary>' + summary + '</compacted-summary>' }],
  }
}
function compactionOptions(sessionId: string): GenerateOptions {
  return options({
    sessionId, purpose: 'compaction',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
    ],
  })
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
function sse(frames: unknown[]): Response {
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { status: 200 })
}
function textStream(text = 'ok'): Response {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
}
function compactionStream(content: string, signature = 'sig-1'): Response {
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content, signature } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'compaction' }, usage: { output_tokens: 0, iterations: [{ type: 'compaction', input_tokens: 50, output_tokens: 10 }] } },
    { type: 'message_stop' },
  ])
}
const LISTING = { data: [{ id: MODEL, display_name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }

function fakeCredentialStore(key: string | null = KEY) {
  let credentials: ClaudeApiCredentials | null = key === null ? null : { apiKey: key, authenticatedAt: 1 }
  return {
    read: async () => credentials,
    write: async (next: ClaudeApiCredentials) => { credentials = next },
    delete: async () => { credentials = null },
    path: () => 'memory',
  } as unknown as ClaudeApiCredentialStore
}

interface Setup {
  settingsStore: ClaudeApiSettingsStore
  resolver: ClaudeApiClientVersionResolver
  npmFetch: ReturnType<typeof vi.fn>
  catalog: ClaudeApiCatalogManager
  compactionStore: ClaudeApiCompactionStore
  adapter: ClaudeApiAdapter
  calls: Array<{ url: string; init?: RequestInit }>
  goLive: () => Promise<void>
}
function setup(generation?: (callIndex: number, url: string, init?: RequestInit) => Promise<Response>, key: string | null = KEY, now?: () => number, capabilityMemory?: ClaudeApiCapabilityMemory): Setup {
  const store = fakeCredentialStore(key)
  const settingsStore = new ClaudeApiSettingsStore()
  const npmFetch = vi.fn(async () => Response.json({ version: '2.1.330' }))
  const resolver = new ClaudeApiClientVersionResolver({ fetchFn: npmFetch as unknown as typeof fetch, env: {}, ...(now !== undefined ? { now } : {}) })
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/v1/models')) return Response.json(LISTING)
    calls.push({ url, init })
    return generation !== undefined ? generation(calls.length - 1, url, init) : textStream()
  }) as unknown as typeof fetch
  const catalog = new ClaudeApiCatalogManager(store, settingsStore, { version: resolver, fetchFn })
  const compactionStore = new ClaudeApiCompactionStore()
  const adapter = new ClaudeApiAdapter(store, settingsStore, catalog, { fetchFn, version: resolver, compactionStore, ...(capabilityMemory !== undefined ? { capabilityMemory } : {}) })
  return {
    settingsStore, resolver, npmFetch, catalog, compactionStore, adapter, calls,
    goLive: async () => { await resolver.refresh({ force: true }); await catalog.refresh(true) },
  }
}
const bodyOf = (call: { init?: RequestInit }): Record<string, any> => JSON.parse(String(call.init?.body))
const headersOf = (call: { init?: RequestInit }): Headers => new Headers(call.init?.headers)

let testHome = ''
beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-adapter-'))
  vi.stubEnv('DSH_HOME', testHome)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  await fs.rm(testHome, { recursive: true, force: true })
})

describe('Claude API adapter wire shape', () => {
  it('sends the captured header set, one globally consistent version and body-derived betas', async () => {
    const s = setup()
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'wire-session', system: 'You are helpful.' })))
    expect(s.calls).toHaveLength(1)
    const call = s.calls[0]!
    expect(call.url).toBe(claudeApiUrl(CLAUDE_API_DEFAULT_BASE_URL, CLAUDE_API_MESSAGES_PATH))
    const headers = headersOf(call)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('x-claude-code-session-id')).toBe(claudeApiSessionUuid('wire-session'))
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(headers.get('x-api-key')).toBe(KEY)
    for (const [name, value] of Object.entries(CLAUDE_API_STAINLESS_HEADERS)) expect(headers.get(name)).toBe(value)
    const body = bodyOf(call)
    const version = headers.get('user-agent')!.match(/claude-cli\/(\d+\.\d+\.\d+)/)![1]
    expect(headers.get('user-agent')).toBe(claudeApiUserAgent(version))
    expect(body.system[0].text).toBe(claudeApiBillingBlock(version, 'hello'))
    expect(body.system).toHaveLength(3)
    expect(headers.get('anthropic-beta')).toBe(deriveClaudeApiBetas(body, resolveClaudeApiModel(MODEL)).join(','))
    expect(body.metadata.user_id).toContain(claudeApiSessionUuid('wire-session'))
  })
  it('two sessions send the same version, and a fetch during activity does not move the next request', async () => {
    const s = setup()
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'g-a' })))
    await collect(s.adapter.stream(options({ sessionId: 'g-b' })))
    s.npmFetch.mockImplementation(async () => Response.json({ version: '2.2.0' }))
    await s.resolver.refresh({ force: true })
    expect(s.resolver.current().pending).toBe('2.2.0')
    await collect(s.adapter.stream(options({ sessionId: 'g-b' })))
    const agents = s.calls.map(call => headersOf(call).get('user-agent'))
    expect(agents).toEqual([claudeApiUserAgent('2.1.330'), claudeApiUserAgent('2.1.330'), claudeApiUserAgent('2.1.330')])
    expect(bodyOf(s.calls[2]!).system[0].text).toContain('cc_version=2.1.330.')
  })
  it('after the idle window the next request of any session carries the new version', async () => {
    let clock = 1_000_000
    const s = setup(undefined, KEY, () => clock)
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'i-a' })))
    s.npmFetch.mockImplementation(async () => Response.json({ version: '2.2.0' }))
    await s.resolver.refresh({ force: true })
    await collect(s.adapter.stream(options({ sessionId: 'i-b' })))
    expect(headersOf(s.calls[1]!).get('user-agent')).toBe(claudeApiUserAgent('2.1.330'))
    clock += 5 * 60_000
    await collect(s.adapter.stream(options({ sessionId: 'i-a' })))
    expect(headersOf(s.calls[2]!).get('user-agent')).toBe(claudeApiUserAgent('2.2.0'))
    expect(bodyOf(s.calls[2]!).system[0].text).toContain('cc_version=2.2.0.')
    expect(s.resolver.current().pending).toBeNull()
  })
  it('keeps one version inside a call even when the resolver moves mid-flight', async () => {
    let bump: (() => Promise<void>) | undefined
    const s = setup(async index => {
      if (index === 1) {
        if (bump !== undefined) await bump()
        return Response.json({ error: { message: 'compaction parameter is not supported here' } }, { status: 400 })
      }
      return textStream(index === 2 ? 'in-flight-fallback' : 'ok')
    })
    await s.goLive()
    bump = async () => {
      s.npmFetch.mockImplementation(async () => Response.json({ version: '2.2.0' }))
      await s.resolver.refresh({ force: true })
    }
    await collect(s.adapter.stream(options({ sessionId: 'flight-s' })))
    await collect(s.adapter.stream(compactionOptions('flight-s')))
    await collect(s.adapter.stream(options({ sessionId: 'flight-s' })))
    expect(s.calls).toHaveLength(4)
    const compAgent = headersOf(s.calls[1]!).get('user-agent')
    expect(compAgent).toBe(claudeApiUserAgent('2.1.330'))
    expect(headersOf(s.calls[2]!).get('user-agent')).toBe(compAgent)
    expect(bodyOf(s.calls[2]!).system[0].text).toBe(claudeApiBillingBlock('2.1.330', 'hello'))
    expect(headersOf(s.calls[3]!).get('user-agent')).toBe(claudeApiUserAgent('2.1.330'))
    expect(s.resolver.current().pending).toBe('2.2.0')
  })
  it('never lets the API key reach an upstream error message', async () => {
    const s = setup(async () => Response.json({ error: { message: 'invalid key ' + KEY + ' supplied' } }, { status: 400 }))
    await s.goLive()
    let message = ''
    try { await collect(s.adapter.stream(options())) } catch (error) { message = (error as Error).message }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(KEY)
  })
})

describe('Claude API adapter model listing', () => {
  it('gates on enabled and key, honours explicit none, and never filters the fallback table', async () => {
    const s = setup()
    await s.settingsStore.update({ enabledModelIds: [MODEL] })
    const fallbackIds = (await s.adapter.listModels()).map(model => model.id)
    expect(fallbackIds.length).toBeGreaterThan(1)
    expect(fallbackIds).toContain('claude-opus-5-5')
    await s.settingsStore.update({ enabledModelIds: [] })
    expect(await s.adapter.listModels()).toEqual([])
    await s.settingsStore.update({ enabled: false })
    expect(await s.adapter.listModels()).toEqual([])
    const keyless = setup(undefined, null)
    expect(await keyless.adapter.listModels()).toEqual([])
  })
  it('filters a live catalog by the explicit list and declares toolUpdate only for mid-conversation system models', async () => {
    const s = setup()
    await s.goLive()
    await s.settingsStore.update({ enabledModelIds: [MODEL] })
    const models = await s.adapter.listModels()
    expect(models.map(model => model.id)).toEqual([MODEL])
    expect(models[0]!.toolUpdate).toBe('in-history')
    expect(models[0]!.context).toEqual({ contextWindow: 1_000_000 })
    expect(models[0]!.inputModalities).toEqual(['text', 'image'])
    await s.settingsStore.update({ enabledModelIds: [MODEL, 'claude-sonnet-5'] })
    const both = await s.adapter.listModels()
    expect(both.find(model => model.id === 'claude-sonnet-5')!.toolUpdate).toBeUndefined()
    const resolved = await s.adapter.resolveModel(CLAUDE_API_PROVIDER_ID, MODEL)
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('Claude API adapter server compaction', () => {
  it('strips the directive, stores the block and replays it with the compact beta on the next main turn', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'comp-s' })))
    const chunks = await collect(s.adapter.stream(compactionOptions('comp-s')))
    expect(JSON.stringify(chunks)).toContain(SUMMARY)
    expect(s.calls).toHaveLength(2)
    const compBody = bodyOf(s.calls[1]!)
    expect(compBody.compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    expect(compBody.max_tokens).toBeGreaterThanOrEqual(8192)
    expect(compBody).not.toHaveProperty('context_management')
    expect(compBody.messages).toHaveLength(2)
    expect(headersOf(s.calls[1]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_COMPACT)
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toMatchObject({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
    await collect(s.adapter.stream(options({
      sessionId: 'comp-s',
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'continue' }] }],
    })))
    const next = bodyOf(s.calls[2]!)
    expect(next.messages[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: SUMMARY, signature: 'sig-1' }] })
    expect(headersOf(s.calls[2]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_COMPACT)
  })
  it('sends a compaction routed from another line to the server path and stores its block', async () => {
    const s = setup(async index => index === 0 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    // Fresh adapter: no earlier main turn, no session id, no output cap (the route drops it).
    const routed = options({
      purpose: 'compaction',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
      ],
    })
    const chunks = await collect(s.adapter.stream(routed))
    expect(JSON.stringify(chunks)).toContain(SUMMARY)
    expect(s.calls).toHaveLength(1)
    const body = bodyOf(s.calls[0]!)
    expect(body.compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192)
    expect(body.messages).toHaveLength(2)
    expect(headersOf(s.calls[0]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_COMPACT)
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toMatchObject({ content: SUMMARY, model: MODEL })
  })
  it('falls back inside the same call on an unsupported 400 and skips the server path afterwards', async () => {
    const s = setup(async index => {
      if (index === 1) return Response.json({ error: { message: 'compaction parameter is not supported here' } }, { status: 400 })
      if (index === 2) return textStream('client-side')
      if (index === 3) return textStream('client-side-2')
      return textStream()
    })
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'u-s' })))
    const chunks = await collect(s.adapter.stream(compactionOptions('u-s')))
    expect(JSON.stringify(chunks)).toContain('client-side')
    expect(s.calls).toHaveLength(3)
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('compaction')
    await collect(s.adapter.stream(compactionOptions('u-s')))
    expect(s.calls).toHaveLength(4)
    expect(bodyOf(s.calls[3]!)).not.toHaveProperty('compaction')
  })
  it('falls back inside the same call on an empty summary and skips the server path afterwards', async () => {
    const s = setup(async index => {
      if (index === 1) return compactionStream('')
      if (index === 2) return textStream('fallback-empty')
      return textStream('later')
    })
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'e-s' })))
    const chunks = await collect(s.adapter.stream(compactionOptions('e-s')))
    expect(JSON.stringify(chunks)).toContain('fallback-empty')
    expect(s.calls).toHaveLength(3)
    expect(s.compactionStore.lookup('', SCOPE)).toBeUndefined()
    await collect(s.adapter.stream(compactionOptions('e-s')))
    expect(s.calls).toHaveLength(4)
    expect(bodyOf(s.calls[3]!)).not.toHaveProperty('compaction')
  })
  it('forgets a stale stored block and retries the main turn once in text form', async () => {
    const s = setup(async index => index === 0
      ? Response.json({ error: { message: 'compaction block signature mismatch' } }, { status: 400 })
      : textStream('retry-ok'))
    await s.goLive()
    await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-old', model: MODEL, scope: SCOPE })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'stale-s',
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })))
    expect(JSON.stringify(chunks)).toContain('retry-ok')
    expect(s.calls).toHaveLength(2)
    const retried = bodyOf(s.calls[1]!)
    expect(retried.messages[0].content[0].type).toBe('text')
    expect(headersOf(s.calls[1]!).get('anthropic-beta')).not.toContain(CLAUDE_API_BETA_COMPACT)
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toBeUndefined()
  })
})

describe('Claude API adapter history order and version warm-up', () => {
  it('declares no static-prefix ordering for this line', () => {
    expect(promptCachePolicyOf(CLAUDE_API_PROVIDER_ID).staticPrefix).toBe(false)
  })

  it('keeps a post-compaction history append-only: block first, reminders after the retained tail', async () => {
    const s = setup()
    await s.goLive()
    await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
    const reminder = (kind: string, text: string) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
    const texts = [
      '<system-reminder>\nProgress update language\n</system-reminder>',
      '<system-reminder>\nAGENTS instructions\n</system-reminder>',
      '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
      '<system-reminder>\nCurrent runtime context\n</system-reminder>',
    ]
    await collect(s.adapter.stream(options({
      sessionId: 'order-s',
      messages: [
        checkpoint(SUMMARY),
        { role: 'user', content: [{ type: 'text', text: 'retained question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'retained answer' }] },
        reminder('progress-updates-language', texts[0]!),
        reminder('agent-instructions', texts[1]!),
        reminder('skill-catalog', texts[2]!),
        reminder('runtime-context', texts[3]!),
      ],
    })))
    const body = bodyOf(s.calls[0]!)
    expect(body.messages[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: SUMMARY, signature: 'sig-1' }] })
    expect(headersOf(s.calls[0]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_COMPACT)
    expect(body.messages[1].content[0].text).toBe('retained question')
    expect(body.messages[2].content[0].text).toBe('retained answer')
    expect(body.messages).toHaveLength(4)
    expect(body.messages[3].role).toBe('user')
    expect(body.messages[3].content.map((block: { text: string }) => block.text)).toEqual(texts)
  })

  it('warms the version resolver before the first request, so a disk-cached value beats the shipped default', async () => {
    const s = setup()
    await fs.mkdir(path.dirname(claudeApiClientVersionPath()), { recursive: true })
    await fs.writeFile(claudeApiClientVersionPath(), serializeClaudeApiClientVersion({ version: '2.2.0', fetchedAt: 1 }), 'utf8')
    await collect(s.adapter.stream(options({ sessionId: 'warm-s' })))
    expect(bodyOf(s.calls[0]!).system[0].text).toContain('cc_version=2.2.0.')
    expect(headersOf(s.calls[0]!).get('user-agent')).toBe(claudeApiUserAgent('2.2.0'))
  })
})

describe('Claude API adapter compaction gates and retries', () => {
  it('keeps the client-side request when settings.serverCompaction is off', async () => {
    const s = setup()
    await s.goLive()
    await s.settingsStore.update({ serverCompaction: false })
    await collect(s.adapter.stream(options({ sessionId: 'gate-off' })))
    await collect(s.adapter.stream(compactionOptions('gate-off')))
    expect(s.calls).toHaveLength(2)
    const body = bodyOf(s.calls[1]!)
    expect(body).not.toHaveProperty('compaction')
    expect(body.messages.at(-1).content[0].text).toBe(COMPACTION_INSTRUCTION)
  })

  it('keeps the client-side request for a model whose entry has serverCompaction false', async () => {
    const s = setup()
    await s.goLive()
    const legacyModel = 'claude-sonnet-4-5-20250929'
    await collect(s.adapter.stream(options({ sessionId: 'gate-model', model: legacyModel })))
    await collect(s.adapter.stream(options({
      sessionId: 'gate-model', model: legacyModel, purpose: 'compaction',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
      ],
    })))
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('compaction')
  })

  it('builds compaction system and tools byte-identical to the preceding main turn of the same session', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]
    const tools = [{ name: 'Bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
    await collect(s.adapter.stream(options({ sessionId: 'idem-s', system: 'You are helpful.', tools, messages: history })))
    await collect(s.adapter.stream(options({
      sessionId: 'idem-s', purpose: 'compaction', system: 'You are helpful.', tools,
      messages: [...history, { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] }],
    })))
    const main = bodyOf(s.calls[0]!)
    const comp = bodyOf(s.calls[1]!)
    expect(comp.compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    expect(JSON.stringify(comp.system)).toBe(JSON.stringify(main.system))
    expect(JSON.stringify(comp.tools)).toBe(JSON.stringify(main.tools))
  })

  it('forgets a stale head block and retries the re-compaction once without marking unsupported', async () => {
    const s = setup(async index => {
      if (index === 1) return Response.json({ error: { message: 'compaction block content does not match its signature' } }, { status: 400 })
      if (index === 2) return compactionStream('fresh summary', 'sig-2')
      if (index === 3) return compactionStream('third summary', 'sig-3')
      return textStream()
    })
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'recomp-s' })))
    await s.compactionStore.remember({ content: 'old summary', signature: 'sig-old', model: MODEL, scope: SCOPE })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'recomp-s', purpose: 'compaction',
      messages: [
        checkpoint('old summary'),
        { role: 'user', content: [{ type: 'text', text: 'more work' }] },
        { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
      ],
    })))
    expect(JSON.stringify(chunks)).toContain('fresh summary')
    expect(s.calls).toHaveLength(3)
    // The first attempt replayed the stored block at the head.
    expect(bodyOf(s.calls[1]!).messages[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: 'old summary', signature: 'sig-old' }] })
    // The retry is still a compaction request, now with the checkpoint in text form.
    const retry = bodyOf(s.calls[2]!)
    expect(retry.compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    expect(retry.messages[0].content[0].type).toBe('text')
    expect(s.compactionStore.lookup('old summary', SCOPE)).toBeUndefined()
    expect(s.compactionStore.lookup('fresh summary', SCOPE)?.signature).toBe('sig-2')
    // The pair was NOT marked unsupported: the next compaction still takes the server path.
    await collect(s.adapter.stream(compactionOptions('recomp-s')))
    expect(s.calls).toHaveLength(4)
    expect(bodyOf(s.calls[3]!).compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
  })

  it('retries a stale head block on a non-main request too', async () => {
    const s = setup(async index => index === 0
      ? Response.json({ error: { message: 'compaction block signature mismatch' } }, { status: 400 })
      : textStream('aux-retry'))
    await s.goLive()
    await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-old', model: MODEL, scope: SCOPE })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'aux-s', purpose: 'title',
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })))
    expect(JSON.stringify(chunks)).toContain('aux-retry')
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[1]!).messages[0].content[0].type).toBe('text')
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toBeUndefined()
  })
})

describe('Claude API adapter compaction block model gate', () => {
  const LEGACY = 'claude-sonnet-4-5-20250929'
  const REFUSAL = "'claude-haiku-5-5' does not support the 'compact_20260904' compaction strategy."
  it('recognises the verified model-refusal 400 as unsupported, not block-invalid', () => {
    const body = JSON.stringify({ error: { message: REFUSAL } })
    expect(isClaudeApiCompactionUnsupported(400, body)).toBe(true)
    expect(isClaudeApiCompactionBlockInvalid(400, body)).toBe(false)
  })
  it('sends the checkpoint as text on a model without server compaction and keeps the block for supporting models', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'x-s' })))
    await collect(s.adapter.stream(compactionOptions('x-s')))
    await collect(s.adapter.stream(options({
      sessionId: 'x-s', model: LEGACY,
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })))
    const legacyBody = bodyOf(s.calls[2]!)
    expect(legacyBody.messages[0].content[0].type).toBe('text')
    expect(headersOf(s.calls[2]!).get('anthropic-beta')).not.toContain(CLAUDE_API_BETA_COMPACT)
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toMatchObject({ content: SUMMARY })
    await collect(s.adapter.stream(options({
      sessionId: 'x-s',
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'back' }] }],
    })))
    expect(bodyOf(s.calls[3]!).messages[0]).toEqual({ role: 'assistant', content: [{ type: 'compaction', content: SUMMARY, signature: 'sig-1' }] })
    expect(headersOf(s.calls[3]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_COMPACT)
  })
  it('marks the pair on the quoted refusal, retries once in text form and keeps the block', async () => {
    const s = setup(async index => {
      if (index === 0) return Response.json({ error: { message: REFUSAL } }, { status: 400 })
      if (index === 1) return textStream('text-retry')
      return textStream('client-side')
    })
    await s.goLive()
    await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'ref-s',
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })))
    expect(JSON.stringify(chunks)).toContain('text-retry')
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[1]!).messages[0].content[0].type).toBe('text')
    expect(headersOf(s.calls[1]!).get('anthropic-beta')).not.toContain(CLAUDE_API_BETA_COMPACT)
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toMatchObject({ content: SUMMARY })
    await collect(s.adapter.stream(compactionOptions('ref-s')))
    expect(s.calls).toHaveLength(3)
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('compaction')
  })
})

describe('Claude API adapter unsupported-pair lifetimes', () => {
  const REFUSAL = "'claude-haiku-5-5' does not support the 'compact_20260904' compaction strategy."
  it('keeps a model-refused pair marked past 30 minutes while an endpoint-refused pair recovers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      const s = setup(async index => {
        if (index === 0) return Response.json({ error: { message: REFUSAL } }, { status: 400 })
        if (index === 2) return Response.json({ error: { message: 'compaction parameter is not supported here' } }, { status: 400 })
        return textStream('life-' + index)
      })
      await s.goLive()
      await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
      await collect(s.adapter.stream(options({
        sessionId: 'life-m',
        messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
      })))
      await collect(s.adapter.stream(options({
        sessionId: 'life-e', model: 'claude-sonnet-5',
        messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
      })))
      expect(s.calls).toHaveLength(4)
      vi.setSystemTime(base + 31 * 60_000)
      await collect(s.adapter.stream(compactionOptions('life-m')))
      expect(s.calls).toHaveLength(5)
      expect(bodyOf(s.calls[4]!)).not.toHaveProperty('compaction')
      await collect(s.adapter.stream(options({
        sessionId: 'life-e', model: 'claude-sonnet-5', purpose: 'compaction',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
          { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
        ],
      })))
      expect(s.calls).toHaveLength(7)
      expect(bodyOf(s.calls[5]!).compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Claude API adapter optimistic fast mode for unknown models', () => {
  const UNKNOWN = 'claude-future-9'
  const SPEED_UNSUPPORTED = "'claude-haiku-5-5' does not support the `speed` parameter. This feature is only available on supported models."
  const SPEED_NEEDS_BETA = "To use the `speed` parameter with 'claude-opus-5', send the `anthropic-beta: fast-mode-2026-02-01` header."
  it('sends speed without the beta for an unknown claude model when fast mode is on', async () => {
    const s = setup()
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    await collect(s.adapter.stream(options({ sessionId: 'f-1', model: UNKNOWN })))
    expect(bodyOf(s.calls[0]!).speed).toBe('fast')
    expect(headersOf(s.calls[0]!).get('anthropic-beta')).not.toContain(CLAUDE_API_BETA_FAST_MODE)
  })
  it('corrects a speed refusal once to no speed and remembers it for the pair', async () => {
    const s = setup(async index => index === 0
      ? Response.json({ type: 'error', error: { message: SPEED_UNSUPPORTED, type: 'invalid_request_error' } }, { status: 400 })
      : textStream('no-speed'))
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    const chunks = await collect(s.adapter.stream(options({ sessionId: 'f-2', model: UNKNOWN })))
    expect(JSON.stringify(chunks)).toContain('no-speed')
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[0]!).speed).toBe('fast')
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('speed')
    await collect(s.adapter.stream(options({ sessionId: 'f-2', model: UNKNOWN })))
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('speed')
  })
  it('corrects a beta demand once to the beta and sends it directly next call', async () => {
    const s = setup(async index => index === 0
      ? Response.json({ error: { message: SPEED_NEEDS_BETA, type: 'invalid_request_error' }, type: 'error' }, { status: 400 })
      : textStream('with-beta'))
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    await collect(s.adapter.stream(options({ sessionId: 'f-3', model: UNKNOWN })))
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[1]!).speed).toBe('fast')
    expect(headersOf(s.calls[1]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_FAST_MODE)
    await collect(s.adapter.stream(options({ sessionId: 'f-3', model: UNKNOWN })))
    expect(bodyOf(s.calls[2]!).speed).toBe('fast')
    expect(headersOf(s.calls[2]!).get('anthropic-beta')).toContain(CLAUDE_API_BETA_FAST_MODE)
  })
  it('never sends speed for known null-fast models, unknown non-claude ids, or fast mode off', async () => {
    const s = setup()
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    await collect(s.adapter.stream(options({ sessionId: 'f-4', model: 'claude-sonnet-5-5' })))
    await collect(s.adapter.stream(options({ sessionId: 'f-4', model: 'gateway-only-x' })))
    expect(bodyOf(s.calls[0]!)).not.toHaveProperty('speed')
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('speed')
    await s.settingsStore.update({ fastMode: false })
    await collect(s.adapter.stream(options({ sessionId: 'f-4', model: UNKNOWN })))
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('speed')
  })
  it('surfaces a 429 on a fast-mode request unchanged, without downgrade', async () => {
    const s = setup(async () => Response.json({ error: { message: 'rate limited for fast mode' } }, { status: 429 }))
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    await expect(collect(s.adapter.stream(options({ sessionId: 'f-5', model: UNKNOWN })))).rejects.toThrow(/rate limit/i)
    expect(s.calls).toHaveLength(1)
    expect(bodyOf(s.calls[0]!).speed).toBe('fast')
  })
  it('composes the speed correction with the stale-block forget and retry', async () => {
    const s = setup(async index => {
      if (index === 0) return Response.json({ error: { message: SPEED_UNSUPPORTED } }, { status: 400 })
      if (index === 1) return Response.json({ error: { message: 'compaction block signature mismatch' } }, { status: 400 })
      return textStream('composed')
    })
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    await s.compactionStore.remember({ content: SUMMARY, signature: 'sig-old', model: UNKNOWN, scope: SCOPE })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'f-6', model: UNKNOWN,
      messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })))
    expect(JSON.stringify(chunks)).toContain('composed')
    expect(s.calls).toHaveLength(3)
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('speed')
    expect(bodyOf(s.calls[1]!).messages[0].content[0].type).toBe('compaction')
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('speed')
    expect(bodyOf(s.calls[2]!).messages[0].content[0].type).toBe('text')
    expect(s.compactionStore.lookup(SUMMARY, SCOPE)).toBeUndefined()
  })
})

describe('Claude API adapter speed refusal recognisers', () => {
  const U = "'claude-haiku-5-5' does not support the `speed` parameter. This feature is only available on supported models."
  const B = "To use the `speed` parameter with 'claude-opus-5', send the `anthropic-beta: fast-mode-2026-02-01` header."
  it('recognises both verified wordings in both error envelopes', () => {
    for (const body of [
      JSON.stringify({ type: 'error', error: { message: U, type: 'invalid_request_error' }, request_id: 'r' }),
      JSON.stringify({ error: { message: U, type: 'invalid_request_error' }, type: 'error' }),
    ]) {
      expect(isClaudeApiSpeedUnsupported(body)).toBe(true)
      expect(isClaudeApiSpeedNeedsBeta(body)).toBe(false)
    }
    for (const body of [
      JSON.stringify({ type: 'error', error: { message: B } }),
      JSON.stringify({ error: { message: B, type: 'invalid_request_error' }, type: 'error' }),
    ]) {
      expect(isClaudeApiSpeedNeedsBeta(body)).toBe(true)
      expect(isClaudeApiSpeedUnsupported(body)).toBe(false)
    }
    expect(isClaudeApiSpeedUnsupported(JSON.stringify({ error: { message: 'compaction block signature mismatch' } }))).toBe(false)
    expect(isClaudeApiSpeedNeedsBeta(JSON.stringify({ error: { message: 'rate limited' } }))).toBe(false)
  })
  it('recognises the system-role refusal but not a placement error', () => {
    const U = "role 'system' is not supported on this model"
    for (const body of [
      JSON.stringify({ type: 'error', error: { message: U, type: 'invalid_request_error' }, request_id: 'r' }),
      JSON.stringify({ error: { message: U, type: 'invalid_request_error' }, type: 'error' }),
    ]) expect(isClaudeApiSystemRoleUnsupported(body)).toBe(true)
    expect(isClaudeApiSystemRoleUnsupported(JSON.stringify({ error: { message: "role 'system' must follow a 'user' message or an assistant turn ending in a server tool result" } }))).toBe(false)
    expect(isClaudeApiSystemRoleUnsupported(JSON.stringify({ error: { message: 'compaction block signature mismatch' } }))).toBe(false)
  })
})

describe('Claude API adapter system-role correction', () => {
  const REFUSAL = "role 'system' is not supported on this model"
  const turn = (sessionId: string) => options({
    sessionId,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'extra rule' }] },
    ],
  })
  it('folds system messages after the quoted refusal and remembers the conclusion', async () => {
    const s = setup(async index => index === 0
      ? Response.json({ type: 'error', error: { message: REFUSAL, type: 'invalid_request_error' } }, { status: 400 })
      : textStream('folded'))
    await s.goLive()
    const chunks = await collect(s.adapter.stream(turn('sys-a')))
    expect(JSON.stringify(chunks)).toContain('folded')
    expect(s.calls).toHaveLength(2)
    expect(bodyOf(s.calls[0]!).messages.some((m: { role: string }) => m.role === 'system')).toBe(true)
    const retried = bodyOf(s.calls[1]!)
    expect(retried.messages.some((m: { role: string }) => m.role === 'system')).toBe(false)
    expect(retried.system[2].text).toContain('extra rule')
    const memory = new ClaudeApiCapabilityMemory()
    await memory.warm()
    expect(memory.get(CLAUDE_API_DEFAULT_BASE_URL, MODEL).systemRoleUnsupported).toBe(true)
  })
  it('a second adapter folds directly and stops declaring toolUpdate for that model', async () => {
    const s = setup(async index => index === 0 ? Response.json({ error: { message: REFUSAL } }, { status: 400 }) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(turn('sys-b')))
    const s2 = setup()
    await collect(s2.adapter.stream(turn('sys-b')))
    expect(s2.calls).toHaveLength(1)
    expect(bodyOf(s2.calls[0]!).messages.some((m: { role: string }) => m.role === 'system')).toBe(false)
    expect((await s2.adapter.resolveModel(CLAUDE_API_PROVIDER_ID, MODEL)).toolUpdate).toBeUndefined()
    expect((await s2.adapter.listModels()).find(m => m.id === MODEL)?.toolUpdate).toBeUndefined()
    expect((await s2.adapter.resolveModel(CLAUDE_API_PROVIDER_ID, 'claude-opus-5-5')).toolUpdate).toBe('in-history')
  })
  it('after the TTL the in-place form is tried again', async () => {
    const s = setup(async index => index === 0 ? Response.json({ error: { message: REFUSAL } }, { status: 400 }) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(turn('sys-c')))
    const expired = new ClaudeApiCapabilityMemory(path.join(testHome, 'storages', 'claude-api-capability-memory.json'), () => Date.now() + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS + 1)
    const s3 = setup(undefined, KEY, undefined, expired)
    await collect(s3.adapter.stream(turn('sys-c')))
    expect(s3.calls).toHaveLength(1)
    expect(bodyOf(s3.calls[0]!).messages.some((m: { role: string }) => m.role === 'system')).toBe(true)
  })
  it('surfaces a placement error unchanged and remembers nothing', async () => {
    const s = setup(async () => Response.json({ error: { message: "role 'system' must follow a 'user' message or an assistant turn ending in a server tool result" } }, { status: 400 }))
    await s.goLive()
    await expect(collect(s.adapter.stream(turn('sys-d')))).rejects.toThrow(/must follow/)
    expect(s.calls).toHaveLength(1)
    const memory = new ClaudeApiCapabilityMemory()
    await memory.warm()
    expect(memory.get(CLAUDE_API_DEFAULT_BASE_URL, MODEL).systemRoleUnsupported).toBe(false)
  })
  it('composes the system-role correction with a fast-mode correction in one call', async () => {
    const s = setup(async index => {
      if (index === 0) return Response.json({ error: { message: "'claude-future-9' does not support the `speed` parameter. This feature is only available on supported models." } }, { status: 400 })
      if (index === 1) return Response.json({ error: { message: REFUSAL } }, { status: 400 })
      return textStream('composed-sys')
    })
    await s.goLive()
    await s.settingsStore.update({ fastMode: true })
    const chunks = await collect(s.adapter.stream(options({
      sessionId: 'sys-e', model: 'claude-future-9',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'system', content: [{ type: 'text', text: 'extra rule' }] },
      ],
    })))
    expect(JSON.stringify(chunks)).toContain('composed-sys')
    expect(s.calls).toHaveLength(3)
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('speed')
    expect(bodyOf(s.calls[1]!).messages.some((m: { role: string }) => m.role === 'system')).toBe(true)
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('speed')
    expect(bodyOf(s.calls[2]!).messages.some((m: { role: string }) => m.role === 'system')).toBe(false)
    expect(bodyOf(s.calls[2]!).system[2].text).toContain('extra rule')
  })
})

describe('Claude API adapter session effort memory', () => {
  it('compaction follows the session current effort, not the settings default', async () => {
    const s = setup(async index => index === 2 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(options({ sessionId: 'eff-s', reasoningEffort: 'high' })))
    await collect(s.adapter.stream(options({ sessionId: 'eff-s', reasoningEffort: 'medium' })))
    await collect(s.adapter.stream(compactionOptions('eff-s')))
    expect(bodyOf(s.calls[0]!).output_config).toEqual({ effort: 'high' })
    expect(bodyOf(s.calls[1]!).output_config).toEqual({ effort: 'medium' })
    expect(bodyOf(s.calls[2]!).output_config).toEqual({ effort: 'medium' })
    expect(bodyOf(s.calls[2]!).compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
  })

  it('remembers "no effort sent" and keeps it even after a settings default appears', async () => {
    const s = setup(async index => index >= 2 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'noeff-s' })))
    await collect(s.adapter.stream(options({ sessionId: 'noeff-s' })))
    await collect(s.adapter.stream(compactionOptions('noeff-s')))
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('output_config')
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(compactionOptions('noeff-s')))
    expect(bodyOf(s.calls[3]!)).not.toHaveProperty('output_config')
  })

  it('a remembered none disables thinking on the compaction request like a main turn', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'none-s', reasoningEffort: 'none' })))
    expect(bodyOf(s.calls[0]!).thinking).toEqual({ type: 'disabled' })
    await collect(s.adapter.stream(compactionOptions('none-s')))
    expect(bodyOf(s.calls[1]!).thinking).toEqual({ type: 'disabled' })
    expect(bodyOf(s.calls[1]!)).not.toHaveProperty('output_config')
  })

  it('with nothing remembered the settings default still applies', async () => {
    const s = setup(async () => compactionStream(SUMMARY))
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(compactionOptions('fresh-s')))
    expect(bodyOf(s.calls[0]!).output_config).toEqual({ effort: 'high' })
  })

  it('a compaction request that names its own effort keeps it', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'own-s', reasoningEffort: 'medium' })))
    await collect(s.adapter.stream(options({ ...compactionOptions('own-s'), reasoningEffort: 'low' })))
    expect(bodyOf(s.calls[1]!).output_config).toEqual({ effort: 'low' })
  })

  it('the client-side fallback in the same call carries the same effort as the server attempt', async () => {
    const s = setup(async index => {
      if (index === 1) return Response.json({ error: { message: 'compaction: Extra inputs are not permitted' } }, { status: 400 })
      return textStream(index === 2 ? 'fallback' : 'ok')
    })
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(options({ sessionId: 'fb-s', reasoningEffort: 'medium' })))
    const chunks = await collect(s.adapter.stream(compactionOptions('fb-s')))
    expect(JSON.stringify(chunks)).toContain('fallback')
    expect(s.calls).toHaveLength(3)
    expect(bodyOf(s.calls[1]!).output_config).toEqual({ effort: 'medium' })
    expect(bodyOf(s.calls[2]!).output_config).toEqual({ effort: 'medium' })
    expect(bodyOf(s.calls[2]!)).not.toHaveProperty('compaction')
  })

  it('a title-purpose request is unaffected by the remembered effort', async () => {
    const s = setup()
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(options({ sessionId: 'title-s', reasoningEffort: 'medium' })))
    await collect(s.adapter.stream(options({ sessionId: 'title-s', purpose: 'title' })))
    expect(bodyOf(s.calls[1]!).output_config).toEqual({ effort: 'high' })
  })

  it('a remembered effort the current model does not offer falls back to the settings default', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    await collect(s.adapter.stream(options({ sessionId: 'ladder-s', reasoningEffort: 'xhigh' })))
    await collect(s.adapter.stream(options({ ...compactionOptions('ladder-s'), model: 'claude-opus-4-6' })))
    expect(bodyOf(s.calls[1]!).output_config).toEqual({ effort: 'high' })
  })

  it('bounds the memory at 500 sessions, dropping the oldest first', async () => {
    const s = setup(async index => index >= 501 ? compactionStream(SUMMARY) : textStream())
    await s.goLive()
    await s.settingsStore.update({ defaultReasoningEffort: 'high' })
    for (let index = 0; index < 501; index += 1) {
      await collect(s.adapter.stream(options({ sessionId: 'cap-' + index, reasoningEffort: 'medium' })))
    }
    await collect(s.adapter.stream(compactionOptions('cap-0')))
    expect(bodyOf(s.calls[501]!).output_config).toEqual({ effort: 'high' })
    await collect(s.adapter.stream(compactionOptions('cap-500')))
    expect(bodyOf(s.calls[502]!).output_config).toEqual({ effort: 'medium' })
  })
})

describe('Claude API wait-time cache activity', () => {
  const activityStore = promptCacheActivityStore(CLAUDE_API_PROVIDER_ID)
  function usageStream(): Response {
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ])
  }

  it('records the 1h tier at issuance and again when the main stream ends', async () => {
    let atIssuance: ReturnType<typeof activityStore.read>
    const s = setup(async () => { atIssuance = activityStore.read('act-1h'); return usageStream() })
    await s.goLive()
    await s.settingsStore.update({ cacheTtl: '1h' })
    await collect(s.adapter.stream(options({ sessionId: 'act-1h' })))
    expect(promptCachePolicyOf(CLAUDE_API_PROVIDER_ID).ttlMs).toBe(3_600_000)
    expect(atIssuance).toMatchObject({ ttlMs: 3_600_000 })
    expect(atIssuance!.lastActiveAt).toBeGreaterThan(0)
    expect(activityStore.read('act-1h')).toMatchObject({ ttlMs: 3_600_000, totalTokens: 112 })
  })

  it('records the 5m tier for a session that writes 5m', async () => {
    const s = setup(async () => usageStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'act-5m' })))
    expect(activityStore.read('act-5m')).toMatchObject({ ttlMs: 300_000, totalTokens: 112 })
  })

  it('records nothing for title or compaction requests', async () => {
    const s = setup(async index => index === 1 ? compactionStream(SUMMARY) : usageStream())
    await s.goLive()
    await collect(s.adapter.stream(options({ sessionId: 'act-aux', purpose: 'title' })))
    expect(activityStore.read('act-aux')).toBeUndefined()
    await collect(s.adapter.stream(compactionOptions('act-aux')))
    expect(activityStore.read('act-aux')).toBeUndefined()
  })

  it('records nothing for a request without a session id', async () => {
    const s = setup(async () => usageStream())
    await s.goLive()
    const before = activityStore.read(undefined)
    await collect(s.adapter.stream(options()))
    expect(activityStore.read(undefined)).toEqual(before)
  })

  it('keeps the request issue time as lastActiveAt when the stream ends later', async () => {
    // Newer than every real record in this shared store, so the bounded document keeps it.
    const issuedAt = Date.now() + 60_000_000
    let clock = issuedAt
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const s = setup(async () => usageStream())
      await s.goLive()
      await s.settingsStore.update({ cacheTtl: '1h' })
      clock = issuedAt
      const chunks: StreamChunk[] = []
      for await (const chunk of s.adapter.stream(options({ sessionId: 'act-issue-time' }))) {
        chunks.push(chunk)
        clock += 60_000
      }
      expect(chunks.length).toBeGreaterThan(0)
      expect(clock).toBeGreaterThan(issuedAt)
      expect(activityStore.read('act-issue-time')).toMatchObject({
        lastActiveAt: issuedAt, ttlMs: 3_600_000, totalTokens: 112,
      })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('re-records on the next main turn, which is what re-arms the wait timer', async () => {
    const s = setup(async () => usageStream())
    await s.goLive()
    await s.settingsStore.update({ cacheTtl: '1h' })
    await collect(s.adapter.stream(options({ sessionId: 'act-rearm' })))
    const first = activityStore.read('act-rearm')!
    await collect(s.adapter.stream(options({ sessionId: 'act-rearm' })))
    const second = activityStore.read('act-rearm')!
    expect(second.lastActiveAt).toBeGreaterThanOrEqual(first.lastActiveAt)
    expect(second).toMatchObject({ ttlMs: 3_600_000, totalTokens: 112 })
  })
})
