import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// Two shapes, two names: the adapter speaks the harness type, while the request
// builder takes the normalised one this plugin hands it.
import type { GenerateOptions as AdapterOptions } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions as MapperOptions } from '../src/host/common/llm-compat.ts'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import { WorkBuddyAccountPool, parseWorkBuddyPoolData } from '../src/host/workbuddy/account-pool.ts'
import { WorkBuddyCheckinService, CHECKIN_JITTER_MIN_MS } from '../src/host/workbuddy/checkin.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type WorkBuddyCredentials,
} from '../src/host/workbuddy/token-store.ts'
import { WorkBuddyUsageLedger } from '../src/host/workbuddy/guardrails.ts'
import { buildChatRequest } from '../src/host/workbuddy/mapper.ts'
import { createWorkBuddyStore } from './support/workbuddy-fixtures.ts'

const temporaryDirs: string[] = []

afterEach(async () => {
  for (const dir of temporaryDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

/** Mirrors the platform backends: JSON in memory, parse hook on read. */
class PoolBackend {
  private data: unknown = null
  constructor(private readonly parse: (value: unknown) => unknown) {}
  async load() { return this.data === null ? null : this.parse(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

function credentialsFor(uid: string, domain = 'copilot.tencent.com'): WorkBuddyCredentials {
  return {
    accessToken: `at-${uid}`,
    refreshToken: `rt-${uid}`,
    expiresAt: Date.now() + 3_600_000,
    region: domain.includes('workbuddy') ? 'intl' : 'cn',
    domain,
    backend: domain.includes('workbuddy') ? 'https://www.workbuddy.ai' : 'https://copilot.tencent.com',
    uid,
    nickname: uid,
    sourceFile: '',
    sourceMtimeMs: 0,
    source: 'managed',
  }
}

const CATALOG = [{
  id: 'glm-5.3', name: 'GLM', contextWindow: 100_000, maxContextWindow: 100_000, maxTokens: 10_000,
  regions: ['cn', 'intl'] as const, supportsImage: false, reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'high', canDisableThinking: false, description: '',
}]

interface Harness {
  adapter: WorkBuddyAdapter
  pool: WorkBuddyAccountPool
  store: FileCredentialStore
  seen: string[]
}

async function harness(
  uids: readonly string[],
  options: { fetchFn?: typeof fetch } = {},
): Promise<Harness> {
  const dir = await tempDir('wb-safety-')
  const store = createWorkBuddyStore(dir) as FileCredentialStore
  const backend = new PoolBackend(parseWorkBuddyPoolData)
  const pool = new WorkBuddyAccountPool({ store, backend: backend as never })
  for (const uid of uids) {
    await store.addManaged(credentialsFor(uid))
    await pool.addAccount(credentialsFor(uid))
  }
  const settings = new FileModelSettingsStore(path.join(dir, 'models.json'))
  const ledger = new WorkBuddyUsageLedger(path.join(dir, 'usage.json'))
  await ledger.load()

  const seen: string[] = []
  const sse = (): Response => {
    const body = [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n\n')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const fetchFn = options.fetchFn ?? ((async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push(headers['x-user-id'] ?? '')
    return sse()
  }) as unknown as typeof fetch)

  const adapter = new WorkBuddyAdapter(store, settings, undefined, {
    fetchFn,
    loadCatalog: async () => CATALOG,
    accountPool: pool,
    usageLedger: ledger,
  })
  return { adapter, pool, store, seen }
}

function options(model = 'glm-5.3'): AdapterOptions {
  return {
    provider: 'workbuddy-subscription',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as unknown as AdapterOptions
}

describe('output floor', () => {
  it('raises a GPT-family request to the 16-token minimum and leaves others alone', () => {
    const base = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
    const body = (overrides: Record<string, unknown>): Record<string, unknown> =>
      buildChatRequest({ ...base, ...overrides } as unknown as MapperOptions)
    expect(body({ model: 'gpt-6-astra', maxTokens: 1 }).max_tokens).toBe(16)
    expect(body({ model: 'gpt-6-astra', maxTokens: 900 }).max_tokens).toBe(900)
    expect(body({ model: 'glm-5.3', maxTokens: 1 }).max_tokens).toBe(1)
  })
})

describe('check-in spacing', () => {
  it('pauses between accounts, and only between them', async () => {
    const dir = await tempDir('wb-checkin-')
    const pauses: number[] = []
    const accounts = [credentialsFor('u1'), credentialsFor('u2'), credentialsFor('u3')]
    const service = new WorkBuddyCheckinService(
      { list: async () => accounts, ensureFresh: async (value: WorkBuddyCredentials) => value } as unknown as FileCredentialStore,
      {
        statePath: path.join(dir, 'checkin.json'),
        settings: () => ({ enabled: true }),
        now: () => Date.parse('2026-10-18T10:00:00'),
        pause: async (ms: number) => { pauses.push(ms) },
        random: () => 0,
        fetchFn: (async () => new Response(JSON.stringify({ code: 0, data: { today_checked_in: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      },
    )
    await service.tick(true)
    // Three accounts, three sign-ins, two waits — never one before the first.
    expect(pauses).toEqual([CHECKIN_JITTER_MIN_MS, CHECKIN_JITTER_MIN_MS])
  })
})

describe('account safety on the wire', () => {
  it('never parks an account for a transport failure', async () => {
    const { adapter, pool } = await harness(['uid-a'], {
      fetchFn: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    await expect((async () => {
      for await (const _chunk of adapter.stream(options())) { /* drain */ }
    })()).rejects.toMatchObject({ code: 'TRANSPORT' })

    const data = await pool.read()
    const account = data.accounts[0]!
    // The account was never at fault: no cooldown, no auth verdict.
    expect(account.cooldownUntil).toBeUndefined()
    expect(account.authStatus).toBeUndefined()
  })
})
