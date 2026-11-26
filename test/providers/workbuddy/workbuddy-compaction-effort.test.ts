/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and this line's catalog
 * default may differ from the level the session runs at. The effort is part of
 * what the upstream caches against, so a mismatch sends the whole conversation
 * cold. This proves the request body carries the main turn's level, not the
 * catalog default.
 */
import { gunzipSync } from 'node:zlib'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WorkBuddyAdapter } from '../../../src/host/providers/workbuddy/adapter.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../../../src/host/providers/workbuddy/token-store.ts'
import { createWorkBuddyStore } from '../../support/workbuddy-fixtures.ts'
import type { WorkBuddyModelEntry } from '../../../src/host/providers/workbuddy/model-catalog.ts'

// Catalog default is 'high'; the session below runs at 'max', so only the
// effort memory can make the second body say 'max'.
const CATALOG: WorkBuddyModelEntry[] = [
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxTokens: 48_000,
    regions: ['cn', 'intl'], supportsImage: true, reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high', canDisableThinking: true, description: '',
  },
]

const temporaryDirs: string[] = []

async function makeStore(): Promise<FileCredentialStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-effort-cred-'))
  temporaryDirs.push(dir)
  await fs.writeFile(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'uid-1', nickname: 'tester', uin: '100000000001', type: 'personal' },
    auth: { accessToken: 'token-abc', refreshToken: 'refresh-abc', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
  }), 'utf8')
  return createWorkBuddyStore(dir)
}

/** The JSON body of one stubbed chat request, decompressed when it went gzipped. */
function requestBody(init: { body?: BodyInit | null } | undefined): Record<string, unknown> {
  const body = init?.body
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>
  if (body instanceof Uint8Array) return JSON.parse(gunzipSync(body).toString('utf8')) as Record<string, unknown>
  if (body instanceof ArrayBuffer) return JSON.parse(gunzipSync(new Uint8Array(body)).toString('utf8')) as Record<string, unknown>
  throw new Error('unexpected request body shape')
}

function sseResponse(): Response {
  return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

async function buildAdapter(bodies: Array<Record<string, unknown>>): Promise<WorkBuddyAdapter> {
  return new WorkBuddyAdapter(
    await makeStore(),
    new FileModelSettingsStore(path.join(os.tmpdir(), `wb-models-${Date.now()}-${Math.random()}.json`)),
    undefined,
    {
      fetchFn: (async (url: any, init: any) => {
        if (String(url).includes('/v2/chat/completions')) bodies.push(requestBody(init))
        return sseResponse()
      }) as unknown as typeof fetch,
      loadCatalog: async () => CATALOG,
    },
  )
}

async function send(adapter: WorkBuddyAdapter, overrides: Record<string, unknown>): Promise<void> {
  const options = {
    provider: 'workbuddy',
    model: 'glm-5.3',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
    ...overrides,
  } as unknown as GenerateOptions
  for await (const _chunk of adapter.stream(options)) { /* drain */ }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of temporaryDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('WorkBuddy auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the catalog default', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'wb-sess', reasoningEffort: 'max' })
    await send(adapter, { sessionId: 'wb-sess', purpose: 'compaction' })

    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['max', 'max'])
  })

  it('falls back to the catalog default with no session main turn', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'wb-none', purpose: 'compaction' })
    expect(bodies[0]!.reasoning_effort).toBe('high')
  })
})
