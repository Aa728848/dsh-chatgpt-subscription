import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '../src/host/common/llm-compat.ts'
import { flushCatalogSnapshots } from '../src/host/common/catalog-snapshot.ts'
import { COMPACTION_INSTRUCTION } from '../src/host/compaction-prompt.ts'
import { ClaudeApiAdapter } from '../src/host/claude-api/adapter.ts'
import { ClaudeApiCatalogManager } from '../src/host/claude-api/catalog-manager.ts'
import { ClaudeApiClientVersionResolver } from '../src/host/claude-api/client-version.ts'
import { ClaudeApiCompactionStore } from '../src/host/claude-api/compaction-store.ts'
import {
  CLAUDE_API_CAPABILITY_MEMORY_TTL_MS,
  ClaudeApiCapabilityMemory,
  parseClaudeApiCapabilityMemory,
} from '../src/host/claude-api/capability-memory.ts'
import { ClaudeApiSettingsStore, claudeApiCredentialFingerprint, type ClaudeApiCredentials } from '../src/host/claude-api/token-store.ts'
import type { ClaudeApiCredentialStore } from '../src/host/claude-api/token-store.ts'
import { CLAUDE_API_BETA_COMPACT, CLAUDE_API_BETA_FAST_MODE } from '../src/host/claude-api/types.ts'
import { CLAUDE_API_DEFAULT_BASE_URL, CLAUDE_API_PROVIDER_ID } from '../src/shared/claude-api-contracts.ts'

const MODEL = 'claude-haiku-5-5'
const UNKNOWN = 'claude-future-9'
const UNKNOWN2 = 'claude-future-8'
const KEY = 'sk-claude-test'
const SUMMARY = 'The user greeted the assistant and the assistant replied.'
const SCOPE = claudeApiCredentialFingerprint({ apiKey: KEY, authenticatedAt: 1 }, CLAUDE_API_DEFAULT_BASE_URL)
const BASE = CLAUDE_API_DEFAULT_BASE_URL
const COMP_REFUSAL = "'claude-haiku-5-5' does not support the 'compact_20260904' compaction strategy."
const SPEED_UNSUPPORTED = "'claude-haiku-5-5' does not support the \`speed\` parameter. This feature is only available on supported models."
const SPEED_NEEDS_BETA = "To use the \`speed\` parameter with 'claude-opus-5', send the \`anthropic-beta: fast-mode-2026-02-01\` header."

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
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
function textStream(text = 'ok'): Response {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { status: 200 })
}
function compactionStream(content: string): Response {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content, signature: 'sig-1' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'compaction' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), { status: 200 })
}
const refusal = (message: string) => Response.json({ error: { message, type: 'invalid_request_error' }, type: 'error' }, { status: 400 })

function harness(memory: ClaudeApiCapabilityMemory, generation?: (index: number) => Promise<Response>) {
  const credentials: ClaudeApiCredentials = { apiKey: KEY, authenticatedAt: 1 }
  const store = {
    read: async () => credentials,
    write: async () => undefined,
    delete: async () => undefined,
    path: () => 'memory',
  } as unknown as ClaudeApiCredentialStore
  const settingsStore = new ClaudeApiSettingsStore()
  const resolver = new ClaudeApiClientVersionResolver({ fetchFn: vi.fn(async () => Response.json({ version: '2.1.330' })) as unknown as typeof fetch, env: {} })
  const calls: Array<{ init?: RequestInit }> = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/v1/models')) return Response.json({ data: [{ id: MODEL }, { id: 'claude-sonnet-5' }] })
    calls.push({ init })
    return generation !== undefined ? generation(calls.length - 1) : textStream()
  }) as unknown as typeof fetch
  const catalog = new ClaudeApiCatalogManager(store, settingsStore, { version: resolver, fetchFn })
  const compactionStore = new ClaudeApiCompactionStore()
  const adapter = new ClaudeApiAdapter(store, settingsStore, catalog, { fetchFn, version: resolver, compactionStore, capabilityMemory: memory })
  return { adapter, calls, settingsStore, compactionStore }
}
const bodyOf = (call: { init?: RequestInit }): Record<string, any> => JSON.parse(String(call.init?.body))
const betaOf = (call: { init?: RequestInit }): string => new Headers(call.init?.headers).get('anthropic-beta') ?? ''

let home = ''
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-api-capmem-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  await flushCatalogSnapshots()
  vi.unstubAllEnvs()
  await fs.rm(home, { recursive: true, force: true })
})
const file = () => path.join(home, 'storages', 'cap.json')

describe('ClaudeApiCapabilityMemory codec and expiry', () => {
  it('round-trips what the production writer emits', async () => {
    const memory = new ClaudeApiCapabilityMemory(file(), () => 1000)
    await memory.setCompactionUnsupported(BASE, 'm1')
    await memory.setFastMode(BASE, 'm2', 'beta')
    const parsed = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(parsed[BASE + '\n' + 'm1']?.compaction).toEqual({ value: 'unsupported', expiresAt: 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS })
    expect(parsed[BASE + '\n' + 'm2']?.fastMode).toEqual({ value: 'beta', expiresAt: 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS })
    const restored = new ClaudeApiCapabilityMemory(file(), () => 1000)
    await restored.warm()
    expect(restored.get(BASE, 'm1')).toEqual({ compactionUnsupported: true, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
    expect(restored.get(BASE, 'm2')).toEqual({ compactionUnsupported: false, fastMode: 'beta', systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
  })
  it('drops expired fields on read and removes them on the next write', async () => {
    let clock = 1000
    const memory = new ClaudeApiCapabilityMemory(file(), () => clock)
    await memory.setCompactionUnsupported(BASE, 'm')
    await memory.setFastMode(BASE, 'm', 'beta')
    clock = 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS + 1
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
    await memory.setFastMode(BASE, 'other', 'unsupported')
    const parsed = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(parsed[BASE + '\n' + 'm']).toBeUndefined()
    expect(parsed[BASE + '\n' + 'other']?.fastMode?.value).toBe('unsupported')
  })
  it('keeps the three conclusions independent', async () => {
    const memory = new ClaudeApiCapabilityMemory(file(), () => 1000)
    await memory.setCompactionUnsupported(BASE, 'm')
    await memory.setFastMode(BASE, 'm', 'beta')
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: true, fastMode: 'beta', systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
    await memory.setFastMode(BASE, 'm', 'unsupported')
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: true, fastMode: 'unsupported', systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
  })
  it('treats a missing or damaged file as nothing remembered', async () => {
    const memory = new ClaudeApiCapabilityMemory(file())
    await memory.warm()
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), '{broken', 'utf8')
    const damaged = new ClaudeApiCapabilityMemory(file())
    await damaged.warm()
    expect(damaged.get(BASE, 'm').compactionUnsupported).toBe(false)
  })
  it('stores the system-role conclusion independently with its own expiry', async () => {
    let clock = 1000
    const memory = new ClaudeApiCapabilityMemory(file(), () => clock)
    await memory.setCompactionUnsupported(BASE, 'm')
    await memory.setSystemRoleUnsupported(BASE, 'm')
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: true, fastMode: undefined, systemRoleUnsupported: true, thinkingTokenCountUnsupported: false })
    const parsed = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(parsed[BASE + '\n' + 'm']?.systemRole).toEqual({ value: 'unsupported', expiresAt: 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS })
    clock = 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS + 1
    expect(memory.get(BASE, 'm')).toEqual({ compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: false })
    await memory.setFastMode(BASE, 'm', 'beta')
    const after = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(after[BASE + '\n' + 'm']?.systemRole).toBeUndefined()
    expect(after[BASE + '\n' + 'm']?.fastMode?.value).toBe('beta')
  })
  it('persists thinking-token-count refusal independently', async () => {
    const memory = new ClaudeApiCapabilityMemory(file(), () => 1000)
    await memory.setThinkingTokenCountUnsupported(BASE, 'm')
    expect(memory.get(BASE, 'm')).toEqual({
      compactionUnsupported: false, fastMode: undefined, systemRoleUnsupported: false, thinkingTokenCountUnsupported: true,
    })
    const restored = new ClaudeApiCapabilityMemory(file(), () => 1000)
    await restored.warm()
    expect(restored.get(BASE, 'm').thinkingTokenCountUnsupported).toBe(true)
    const parsed = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(parsed[BASE + '\n' + 'm']?.thinkingTokenCount).toEqual({ value: 'unsupported', expiresAt: 1000 + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS })
  })
})

describe('ClaudeApiCapabilityMemory across adapter restarts', () => {
  it('a second adapter over the same file does not retry what the first learned', async () => {
    const a = harness(new ClaudeApiCapabilityMemory(file()), async index => {
      if (index === 0) return refusal(COMP_REFUSAL)
      if (index === 2) return refusal(SPEED_UNSUPPORTED)
      if (index === 4) return refusal(SPEED_NEEDS_BETA)
      if (index === 6) return refusal('compaction parameter is not supported here')
      return textStream('learned')
    })
    await a.compactionStore.remember({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
    await collect(a.adapter.stream(options({ sessionId: 'r-a', messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }] })))
    await a.settingsStore.update({ fastMode: true })
    await collect(a.adapter.stream(options({ sessionId: 'r-a', model: UNKNOWN })))
    await collect(a.adapter.stream(options({ sessionId: 'r-a', model: UNKNOWN2 })))
    await collect(a.adapter.stream(options({ sessionId: 'r-a', model: 'claude-sonnet-5', messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }] })))
    expect(a.calls).toHaveLength(8)
    const parsed = parseClaudeApiCapabilityMemory(JSON.parse(await fs.readFile(file(), 'utf8')))
    expect(parsed[BASE + '\n' + MODEL]?.compaction?.value).toBe('unsupported')
    expect(parsed[BASE + '\n' + UNKNOWN]?.fastMode?.value).toBe('unsupported')
    expect(parsed[BASE + '\n' + UNKNOWN2]?.fastMode?.value).toBe('beta')
    // The endpoint-level 30-minute marker is NOT persisted.
    expect(parsed[BASE + '\n' + 'claude-sonnet-5']).toBeUndefined()

    const b = harness(new ClaudeApiCapabilityMemory(file()))
    await b.settingsStore.update({ fastMode: true })
    await collect(b.adapter.stream(options({ sessionId: 'r-b', messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }] })))
    expect(b.calls).toHaveLength(1)
    expect(bodyOf(b.calls[0]!).messages[0].content[0].type).toBe('text')
    expect(betaOf(b.calls[0]!)).not.toContain(CLAUDE_API_BETA_COMPACT)
    await collect(b.adapter.stream(options({
      sessionId: 'r-b', purpose: 'compaction',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
      ],
    })))
    expect(b.calls).toHaveLength(2)
    expect(bodyOf(b.calls[1]!)).not.toHaveProperty('compaction')
    await collect(b.adapter.stream(options({ sessionId: 'r-b', model: UNKNOWN })))
    expect(bodyOf(b.calls[2]!)).not.toHaveProperty('speed')
    await collect(b.adapter.stream(options({ sessionId: 'r-b', model: UNKNOWN2 })))
    expect(bodyOf(b.calls[3]!).speed).toBe('fast')
    expect(betaOf(b.calls[3]!)).toContain(CLAUDE_API_BETA_FAST_MODE)
  })
  it('after the TTL the optimistic attempt happens again', async () => {
    const a = harness(new ClaudeApiCapabilityMemory(file()), async index => {
      if (index === 0) return refusal(SPEED_UNSUPPORTED)
      if (index === 2) return refusal(COMP_REFUSAL)
      return textStream('learned')
    })
    await a.settingsStore.update({ fastMode: true })
    await collect(a.adapter.stream(options({ sessionId: 't-a', model: UNKNOWN })))
    await a.compactionStore.remember({ content: SUMMARY, signature: 'sig-1', model: MODEL, scope: SCOPE })
    await collect(a.adapter.stream(options({ sessionId: 't-a', messages: [checkpoint(SUMMARY), { role: 'user', content: [{ type: 'text', text: 'go' }] }] })))
    const clock = Date.now() + CLAUDE_API_CAPABILITY_MEMORY_TTL_MS + 1000
    const c = harness(new ClaudeApiCapabilityMemory(file(), () => clock), async index => index === 0 ? compactionStream(SUMMARY) : textStream('optimistic'))
    await c.settingsStore.update({ fastMode: true })
    await collect(c.adapter.stream(options({
      sessionId: 't-c', purpose: 'compaction',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
      ],
    })))
    expect(bodyOf(c.calls[0]!).compaction).toEqual({ type: 'summarize', instructions: COMPACTION_INSTRUCTION })
    await collect(c.adapter.stream(options({ sessionId: 't-c', model: UNKNOWN })))
    expect(bodyOf(c.calls[1]!).speed).toBe('fast')
  })
})
