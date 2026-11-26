/**
 * A compaction summary follows the session's own effort.
 *
 * The harness names no effort on a compaction request, and this line's default is
 * "say nothing" (null), so without the effort memory a compaction body would omit
 * `output_config.effort` while the main turn carried one. The effort is part of
 * what the upstream caches against, so that mismatch sends the conversation cold.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MinimaxCodeAdapter } from '../../../src/host/providers/minimax-code/adapter.ts'
import { MinimaxCodeCredentialStore } from '../../../src/host/providers/minimax-code/token-store.ts'
import { resetRefreshRejections } from '../../../src/host/providers/minimax-code/oauth.ts'

let home = ''
const originalMinimaxHome = process.env.MINIMAX_HOME
const originalDshHome = process.env.DSH_HOME

const FRAMES = [
  'data: ' + JSON.stringify({ type: 'message_start', message: { model: 'MiniMax-M3.1-Flash', usage: { input_tokens: 3, output_tokens: 0 } } }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + '\n\n',
  'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
].join('')

function sseResponse(): Response {
  return new Response(FRAMES, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

beforeEach(async () => {
  resetRefreshRejections()
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minimax-effort-'))
  process.env.MINIMAX_HOME = home
  process.env.DSH_HOME = home
})

afterEach(async () => {
  resetRefreshRejections()
  if (originalMinimaxHome === undefined) delete process.env.MINIMAX_HOME
  else process.env.MINIMAX_HOME = originalMinimaxHome
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
})

/** An adapter recording every request body, whose configured default is null. */
async function buildAdapter(bodies: Array<Record<string, unknown>>): Promise<MinimaxCodeAdapter> {
  const store = new MinimaxCodeCredentialStore('cn')
  await store.write({
    accessToken: 'ACCESS', refreshToken: 'r-own', tokenType: 'Bearer', clientId: 'mcode-public',
    scopes: [], audience: '', expiresAtMs: Date.now() + 3_600_000, generation: 1, loginEpoch: 'e',
    buildEnv: 'prod', region: 'cn', recordKey: null, source: 'file',
  })
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return sseResponse()
  }) as unknown as typeof fetch
  return new MinimaxCodeAdapter(store, { fetchFn })
}

async function send(adapter: MinimaxCodeAdapter, overrides: Record<string, unknown>): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: 'minimax-code',
    model: 'MiniMax-M3.1-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  } as never)) { /* drain */ }
}

describe('MiniMax Code auxiliary request effort', () => {
  it('sends a compaction at the session main-turn effort, not the (null) default', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'mm-sess', reasoningEffort: 'high' })
    await send(adapter, { sessionId: 'mm-sess', purpose: 'compaction' })

    expect(bodies.map((body) => (body.output_config as { effort?: string } | undefined)?.effort))
      .toEqual(['high', 'high'])
  })

  it('sends no effort with no session main turn', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const adapter = await buildAdapter(bodies)
    await send(adapter, { sessionId: 'mm-none', purpose: 'compaction' })
    expect(bodies[0]!.output_config).toBeUndefined()
  })
})
