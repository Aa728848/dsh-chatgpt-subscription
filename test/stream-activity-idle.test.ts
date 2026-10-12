/**
 * Transport-level idle activity (issue #52).
 *
 * The idle watchdog used to be reset only by a parsed StreamChunk, so an
 * upstream that kept the connection alive with heartbeats - ": ping",
 * ": keep-alive", status frames a mapper discards - was judged silent and the
 * turn died with TIMEOUT even though bytes were still arriving. The judgement
 * belongs to the transport, not to the presentation layer.
 *
 * Each line therefore reports every transport event into the watchdog, and each
 * test below is the same experiment on one line: a body that sends comment-only
 * frames for far longer than one idle window and never produces a consumer-visible
 * chunk. With the fix the turn completes; without it, TIMEOUT.
 *
 * The clock is faked rather than shortened through a seam the adapters do not
 * have, and the watchdog itself is NOT mocked - the whole point is to observe the
 * real one declining to fire.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import {
  FileCredentialStore as AntigravityCredentialStore,
  FileModelSettingsStore as AntigravityModelSettings,
} from '../src/host/antigravity/token-store.ts'
import { ClaudeAdapter } from '../src/host/claude/adapter.ts'
import {
  FileCredentialStore as ClaudeCredentialStore,
  FileModelSettingsStore as ClaudeModelSettings,
  type ClaudeCredentialDocument,
} from '../src/host/claude/token-store.ts'
import { FALLBACK_MODELS as CLAUDE_FALLBACK_MODELS } from '../src/host/claude/model-catalog.ts'
import { PROVIDER_ID as CLAUDE_PROVIDER_ID } from '../src/host/claude/types.ts'
import type { CredentialStore } from '../src/host/token-store.ts'
import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import { OllamaAdapter } from '../src/host/ollama/adapter.ts'
import { clearCachedCatalog } from '../src/host/command-code/client.ts'

/** What every line's adapter passes to the watchdog; mirrored, never imported, so a silent change here fails the tests below. */
const IDLE_TIMEOUT_MS = 300_000
/** Fake milliseconds between two heartbeats - comfortably inside one idle window. */
const STEP_MS = 60_000
/** Idle windows the connection outlives while producing nothing at all. */
const ROUNDS = 12

interface ControllableBody {
  readonly stream: ReadableStream<Uint8Array>
  /** How many times the consumer has drained the body; see awaitDrain. */
  readonly pulls: number
  send(text: string): void
  end(): void
}

/** A response body the test feeds by hand, so "how long" is the test's choice. */
function controllableBody(): ControllableBody {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let pulls = 0
  return {
    get pulls() { return pulls },
    stream: new ReadableStream<Uint8Array>({
      start(c) { controller = c },
      // Fires once per drained read, which is the only observation the test can
      // make about a frame that deliberately produces no chunk.
      pull() { pulls++ },
    }),
    // A terminal event completes the stream, after which the adapter closes the
    // body on its own way out; writing past that point is expected here and says
    // nothing about the assertions below.
    send(text) { try { controller!.enqueue(encoder.encode(text)) } catch { /* already finished */ } },
    end() { try { controller!.close() } catch { /* already finished */ } },
  }
}

function fetchReturning(body: ControllableBody): typeof fetch {
  return (async () => new Response(body.stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch
}

/**
 * Keep the connection busy for ROUNDS idle windows without producing one chunk.
 *
 * Each round is one comment-only SSE frame - the shape a real keep-alive takes -
 * followed by a slice of fake time. Nothing here is a chunk, so a watchdog that
 * only counts parsed output never sees a reason to stay patient.
 */
async function pumpHeartbeats(body: ControllableBody, tail: string): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    const before = body.pulls
    body.send(': ping\n\n')
    await awaitDrain(body, before)
    await vi.advanceTimersByTimeAsync(STEP_MS)
  }
  const beforeTail = body.pulls
  body.send(tail)
  await awaitDrain(body, beforeTail)
  await vi.advanceTimersByTimeAsync(STEP_MS)
  body.end()
  await flushRealIo(5)
  await vi.advanceTimersByTimeAsync(STEP_MS)
}

/** Let a genuinely silent connection run past one whole idle window. */
async function pumpSilence(body: ControllableBody): Promise<void> {
  await flushRealIo()
  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1_000)
  body.end()
  await flushRealIo()
  await vi.advanceTimersByTimeAsync(STEP_MS)
}

/**
 * Await a stream that is expected to fail, with the handler attached NOW.
 *
 * The rejection lands during the fake-clock pump, long before the assertion
 * line runs; attaching later leaves vitest an unhandled rejection to report.
 */
async function failureOf(run: Promise<void>): Promise<unknown> {
  const settled = run.then(() => undefined, (error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  return settled
}

function collect(chunks: StreamChunk[]): (stream: AsyncIterable<StreamChunk>) => Promise<void> {
  return async (stream) => {
    for await (const chunk of stream) chunks.push(chunk)
  }
}

function textOf(chunks: StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

const temporaryDirs: string[] = []

/**
 * Real event-loop turns, so adapter work that is NOT a timer (file reads, catalog
 * loads) can finish without spending a millisecond of the faked clock.
 *
 * `advanceTimersByTimeAsync` alone only yields microtasks, so a request whose
 * credential lives on disk would still be mid-setup when the fake idle window
 * runs out - an artefact of the harness that has nothing to do with the stream
 * under test. The natives are captured BEFORE the fake clock is installed.
 */
const realSetImmediate = globalThis.setImmediate
async function flushRealIo(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => { realSetImmediate(resolve) })
  }
}

/**
 * Wait until the adapter has taken everything the test wrote, without moving the
 * fake clock.
 *
 * The loop is unbounded on purpose and the clock does not advance inside it: a
 * heartbeat that has not been READ yet has not pulsed yet, and letting idle time
 * run on regardless would let the watchdog fire for a reason that belongs to the
 * harness rather than to the line under test.
 */
async function awaitDrain(body: ControllableBody, previousPulls: number): Promise<void> {
  for (let turn = 0; turn < 5_000 && body.pulls <= previousPulls; turn++) {
    await new Promise<void>((resolve) => { realSetImmediate(resolve) })
  }
  // The parse and the pulse happen in the microtasks that follow the read.
  await flushRealIo(5)
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  clearCachedCatalog()
  await Promise.all(temporaryDirs.splice(0).map((dir) =>
    fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

async function scratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-activity-'))
  temporaryDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

const ANTIGRAVITY_TAIL = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1}}}\n\n'

function antigravityAdapter(fetchFn: typeof fetch): AntigravityAdapter {
  const store = new AntigravityCredentialStore()
  vi.spyOn(store, 'read').mockResolvedValue({ access: 'test-token', expires: Date.now() + 3_600_000 })
  const modelSettings = new AntigravityModelSettings()
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabledModelIds: ['gemini-3.7-flash'], catalogModels: [], defaultReasoningEffort: null,
  })
  return new AntigravityAdapter(store, modelSettings, undefined, { fetchFn })
}

const antigravityOptions = {
  provider: 'antigravity',
  model: 'gemini-3.7-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as never

describe('antigravity transport activity keeps the stream alive', () => {
  it('completes a heartbeat-only stream instead of timing out, and still times out when silent', async () => {
    {
      const body = controllableBody()
      const chunks: StreamChunk[] = []
      const consume = collect(chunks)
      vi.useFakeTimers()
      const run = consume(antigravityAdapter(fetchReturning(body)).stream(antigravityOptions))
      await pumpHeartbeats(body, ANTIGRAVITY_TAIL)
      await run
      expect(textOf(chunks)).toBe('done')
      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
    }
    {
      const body = controllableBody()
      vi.useFakeTimers()
      const run = collect([])(antigravityAdapter(fetchReturning(body)).stream(antigravityOptions))
      const outcome = failureOf(run)
      await pumpSilence(body)
      expect(await outcome).toMatchObject({ code: 'TIMEOUT' })
    }
  })
})

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const CLAUDE_TAIL = [
  'data: {"type":"message_stop"}',
  '',
].join('\n')

function memoryBackend<T>(): CredentialStore<T> {
  let value: T | null = null
  return {
    async load() { return value },
    async save(next) { value = next },
    async clear() { value = null },
  }
}

async function claudeAdapter(fetchFn: typeof fetch): Promise<ClaudeAdapter> {
  const dir = await scratchDir()
  const store = new ClaudeCredentialStore(path.join(dir, 'credentials.json'), memoryBackend<ClaudeCredentialDocument>())
  await store.saveAccount({
    accessToken: 'ACCESS-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    scopes: ['user:inference', 'user:profile'],
    account: { uuid: 'uuid-1' },
  })
  return new ClaudeAdapter(store, new ClaudeModelSettings(path.join(dir, 'models.json')), undefined, {
    fetchFn,
    loadCatalog: async () => CLAUDE_FALLBACK_MODELS as never[],
  })
}

const claudeOptions = {
  provider: CLAUDE_PROVIDER_ID,
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as never

const CLAUDE_ANSWER = [
  'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7}}}',
  '',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
  '',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

describe('claude transport activity keeps the stream alive', () => {
  it('completes a heartbeat-only stream instead of timing out, and still times out when silent', async () => {
    {
      const body = controllableBody()
      const adapter = await claudeAdapter(fetchReturning(body))
      const chunks: StreamChunk[] = []
      vi.useFakeTimers()
      const run = collect(chunks)(adapter.stream(claudeOptions))
      await pumpHeartbeats(body, CLAUDE_ANSWER)
      await run
      expect(textOf(chunks)).toBe('done')
      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
    }
    {
      const body = controllableBody()
      const adapter = await claudeAdapter(fetchReturning(body))
      vi.useFakeTimers()
      const run = collect([])(adapter.stream(claudeOptions))
      const outcome = failureOf(run)
      await pumpSilence(body)
      expect(await outcome).toMatchObject({ code: 'TIMEOUT' })
    }
  })
})

// ---------------------------------------------------------------------------
// Command Code
// ---------------------------------------------------------------------------

const COMMAND_CODE_TAIL = [
  'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
  '',
].join('\n')

function commandCodeAdapter(fetchFn: typeof fetch): CommandCodeAdapter {
  const store = { read: vi.fn(async () => ({ apiKey: 'cmd_key' })) }
  const settings = { enabledModelIds: ['deepseek/deepseek-v4.1-flash'], catalogModels: [], defaultReasoningEffort: null }
  const modelSettings = {
    read: vi.fn(async () => settings),
    status: vi.fn(() => settings),
    update: vi.fn(async () => settings),
    storeCatalog: vi.fn(async () => settings),
  }
  return new CommandCodeAdapter(
    store as never,
    modelSettings as never,
    undefined,
    { fetchFn, loadCatalog: async () => [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000 }] },
  )
}

const commandCodeOptions = {
  provider: 'command-code',
  model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as never

describe('command-code transport activity keeps the stream alive', () => {
  it('completes a heartbeat-only stream instead of timing out, and still times out when silent', async () => {
    {
      const body = controllableBody()
      const chunks: StreamChunk[] = []
      vi.useFakeTimers()
      const run = collect(chunks)(commandCodeAdapter(fetchReturning(body)).stream(commandCodeOptions))
      await pumpHeartbeats(body, COMMAND_CODE_TAIL)
      await run
      expect(textOf(chunks)).toBe('done')
      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
    }
    {
      const body = controllableBody()
      vi.useFakeTimers()
      const run = collect([])(commandCodeAdapter(fetchReturning(body)).stream(commandCodeOptions))
      const outcome = failureOf(run)
      await pumpSilence(body)
      expect(await outcome).toMatchObject({ code: 'TIMEOUT' })
    }
  })
})

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

const OLLAMA_TAIL = [
  'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
  '',
].join('\n')

function ollamaAdapter(fetchFn: typeof fetch): OllamaAdapter {
  const store = { read: vi.fn(async () => ({ apiKey: 'sk-test' })) }
  const settings = { enabled: true, enabledModelIds: [], catalogModels: [{ id: 'gpt-oss:120b' }], defaultReasoningEffort: null }
  const modelSettings = {
    read: vi.fn(async () => settings),
    status: vi.fn(() => settings),
    update: vi.fn(async () => settings),
    storeCatalog: vi.fn(async () => settings),
  }
  return new OllamaAdapter(store as never, modelSettings as never, {
    fetchFn,
    loadCatalog: async () => [{ id: 'gpt-oss:120b' }],
  })
}

const ollamaOptions = {
  provider: 'ollama',
  model: 'gpt-oss:120b',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
} as never

describe('ollama transport activity keeps the stream alive', () => {
  it('completes a heartbeat-only stream instead of timing out, and still times out when silent', async () => {
    {
      const body = controllableBody()
      const chunks: StreamChunk[] = []
      vi.useFakeTimers()
      const run = collect(chunks)(ollamaAdapter(fetchReturning(body)).stream(ollamaOptions))
      await pumpHeartbeats(body, OLLAMA_TAIL)
      await run
      expect(textOf(chunks)).toBe('done')
      expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true)
    }
    {
      const body = controllableBody()
      vi.useFakeTimers()
      const run = collect([])(ollamaAdapter(fetchReturning(body)).stream(ollamaOptions))
      const outcome = failureOf(run)
      await pumpSilence(body)
      expect(await outcome).toMatchObject({ code: 'TIMEOUT' })
    }
  })
})
