/**
 * Tests for the '/ollama/api' settings surface.
 *
 * WHAT THIS FILE PROVES, and why each one is here:
 *
 * 1. THE ROUTE NEVER ANSWERS WITH AN EMPTY BODY. This is issue #36. A handler
 *    that rejects gets no envelope at all: DSH's web server catches the rejection
 *    and replies with a bare 400 and no body, and the card's `response.json()`
 *    then throws the browser's own "Failed to execute 'json' on 'Response':
 *    Unexpected end of JSON input" — a sentence naming neither the status nor
 *    the cause. Every test below therefore asserts a PARSEABLE ENVELOPE, not
 *    just a status, and the load-bearing one makes the settings store reject
 *    mid-sync, which is the shape of failure the user hit.
 * 2. A FAILED SYNC SAYS WHICH OF THE FOUR THINGS WENT WRONG. A rejected key, an
 *    upstream refusal, an unreachable host and a non-JSON body each have a
 *    different remedy, so "Could not read the model list from Ollama" was never
 *    enough for a user to act on.
 * 3. THE ENVELOPE MATCHES THE SIBLING LINES: '{ok,value}' / '{ok,error}', 405 for
 *    a wrong method, 404 for an unknown path, 403 for a cross-origin mutation.
 *
 * WHAT THIS FILE DOES NOT PROVE: nothing here reaches Ollama or a browser. The
 * fetch seam is a double and the pool and settings stores are in-memory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { OLLAMA_KEYS_URL, registerOllamaRoutes } from '../src/host/ollama/routes.ts'
import { OllamaAccountPool } from '../src/host/ollama/account-pool.ts'
import {
  FileCredentialStore,
  FileModelSettingsStore,
  type OllamaCredentials,
} from '../src/host/ollama/token-store.ts'

/** What Ollama documents on /api/tags. */
const TAGS = { models: [{ name: 'gpt-oss:120b-cloud' }, { name: 'gemma4:31b' }] }

interface Captured {
  status: number
  /** Raw body as written, so 'was anything written at all' stays observable. */
  raw: string | null
  body: { ok: boolean; value?: Record<string, unknown>; error?: string }
}

/**
 * A response double that records the raw payload alongside the parsed one.
 *
 * The raw string is the point: the bug in #36 was an answer with NO body, and an
 * assertion against a parsed object would either pass on an empty default or
 * force the double to hide the very fact under test.
 */
function fakeExchange(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, raw: null, body: { ok: false } }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return response
    },
    end(raw?: string) {
      captured.raw = raw ?? null
      if (raw === undefined) return
      // Parsing here is a test bug when it throws, not a production path: the
      // production client is exercised separately for the unreadable case.
      captured.body = JSON.parse(raw) as Captured['body']
    },
  } as unknown as ServerResponse
  return { response, captured }
}

/** A request whose body is REPLAYED to whatever attaches a listener. */
function fakeRequest(input: {
  url: string
  method?: string
  body?: unknown
  origin?: string | null
}): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const headers: Record<string, string> = { host: '127.0.0.1:3000' }
  const origin = input.origin === undefined ? 'http://127.0.0.1:3000' : input.origin
  if (origin !== null) headers.origin = origin

  const hasBody = input.method === 'POST'
  const chunks: Buffer[] = hasBody && input.body !== undefined
    ? [Buffer.from(JSON.stringify(input.body))]
    : []
  let ended = hasBody

  const deliver = (event: string, listener: (value?: unknown) => void): void => {
    if (!ended) return
    if (event === 'data') {
      for (const chunk of chunks) listener(chunk)
      return
    }
    if (event === 'end') listener()
  }

  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers,
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      deliver(event, listener)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  return request
}

/** In-memory stand-in for the platform credential backends. */
class MemoryBackend {
  private data: unknown = null
  async load() {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data))
  }
  async save(data: unknown) {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear() {
    this.data = null
  }
}

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

const CREDENTIAL: OllamaCredentials = { apiKey: 'sk-test' }

describe('Ollama settings routes', () => {
  let handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  let pool: OllamaAccountPool
  let modelSettingsFile: string
  let respond: (init: {
    endpoint: string
    method?: string
    body?: unknown
    origin?: string | null
  }) => Promise<Captured>
  /** The reply the double fetcher gives to /api/tags. */
  let tags: () => Promise<Response>

  const setup = async (options: { modelSettings?: FileModelSettingsStore } = {}) => {
    const store = new FileCredentialStore(tmpFile('ollama-cred'), new MemoryBackend() as never)
    pool = new OllamaAccountPool({ store, backend: new MemoryBackend() as never })
    modelSettingsFile = tmpFile('ollama-models')
    const routes: Array<{
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
    }> = []
    const ctx = {
      webServer: {
        register(route: {
          path: string
          handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
        }) {
          routes.push(route)
          return () => undefined
        },
      },
      emit: () => undefined,
    } as unknown as Context
    registerOllamaRoutes(ctx, {
      accountPool: pool,
      modelSettings: options.modelSettings ?? new FileModelSettingsStore(modelSettingsFile),
      fetchFn: (async () => tags()) as unknown as typeof fetch,
    })
    handler = routes[0]!.handler
    respond = async (init) => {
      const { response, captured } = fakeExchange()
      await handler(
        fakeRequest({
          url: `/ollama/api${init.endpoint}`,
          method: init.method ?? 'GET',
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.origin === undefined ? {} : { origin: init.origin }),
        }),
        response,
      )
      return captured
    }
  }

  beforeEach(async () => {
    tags = async () => Response.json(TAGS)
    await setup()
  })

  afterEach(async () => {
    await fs.rm(modelSettingsFile, { force: true }).catch(() => undefined)
  })

  /** Every answer this surface produces must be a JSON envelope with a body. */
  function expectEnvelope(captured: Captured, status: number): void {
    expect(captured.raw, 'the route wrote no body at all').not.toBeNull()
    expect(captured.status).toBe(status)
    expect(typeof captured.body.ok).toBe('boolean')
  }

  // -------------------------------------------------------------------------
  // 1. The route never answers with an empty body (issue #36)
  // -------------------------------------------------------------------------

  it('answers a readable envelope when the catalog write fails, not an empty body', async () => {
    // The one await on the sync path that used to be unguarded. A settings
    // directory that cannot be written to is enough to reach it.
    const broken = {
      read: async () => ({
        enabled: true, enabledModelIds: [], catalogModels: [], defaultReasoningEffort: null,
      }),
      update: async () => {
        throw new Error('unused')
      },
      storeCatalog: async () => {
        throw new Error('EPERM: operation not permitted, rename')
      },
    } as unknown as FileModelSettingsStore
    await setup({ modelSettings: broken })
    await pool.addAccount(CREDENTIAL, 'primary')

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    // Before the fix this rejected out of the handler, DSH's web server answered
    // a bare 400 with no body, and the card reported a JSON parse error instead.
    expectEnvelope(captured, 500)
    expect(captured.body.error).toContain('EPERM')
  })

  it('answers a readable envelope when an unguarded read throws', async () => {
    // '/status' deliberately swallows this one and renders the empty state, which
    // is right for a card that must still draw. '/models' does not, so it is the
    // route that shows what the wrapper is for.
    const exploding = {
      read: async () => {
        throw new Error('ollama-models.json is a directory')
      },
    } as unknown as FileModelSettingsStore
    await setup({ modelSettings: exploding })

    const captured = await respond({ endpoint: '/models' })

    expectEnvelope(captured, 500)
    expect(captured.body.error).toContain('is a directory')
  })

  it('answers 404 for an unknown path rather than leaving the request unanswered', async () => {
    const captured = await respond({ endpoint: '/nope' })
    expectEnvelope(captured, 404)
    expect(captured.body.error).toBe('not-found')
  })

  // -------------------------------------------------------------------------
  // 2. A failed sync names which of the four things went wrong
  // -------------------------------------------------------------------------

  it('tells the user their key was rejected, and where to make a new one', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')
    tags = async () => new Response('unauthorized', { status: 401 })

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    expectEnvelope(captured, 502)
    expect(captured.body.error).toContain('401')
    expect(captured.body.error).toContain(OLLAMA_KEYS_URL)
  })

  it('reports a non-JSON reply as such, instead of a bare parse crash', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')
    // A 200 carrying an HTML interstitial is what a captive portal or a
    // rewriting proxy produces, and it is the shape that used to throw.
    tags = async () => new Response('<html><body>Sign in</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    expectEnvelope(captured, 502)
    expect(captured.body.error).toContain('not a /api/tags document')
  })

  it('reports an unreachable service as a network problem, not as a bad key', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')
    tags = async () => {
      throw new TypeError('fetch failed')
    }

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    expectEnvelope(captured, 502)
    expect(captured.body.error).toContain('Could not reach Ollama Cloud')
  })

  it('names the upstream status when Ollama refuses for another reason', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')
    tags = async () => new Response('rate limited', { status: 429 })

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    expectEnvelope(captured, 502)
    expect(captured.body.error).toContain('429')
  })

  it('says the key is missing when there is none, and not that the pool is busy', async () => {
    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    expectEnvelope(captured, 400)
    expect(captured.body.error).toBe('Add an API key before syncing models.')
  })

  it('says to wait when every key is cooling down, rather than asking for another one', async () => {
    const account = await pool.addAccount(CREDENTIAL, 'primary')
    await pool.markCooldown(account.id, 15 * 60_000, '429')

    const captured = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })

    // Telling this user to add a key would send them to a page that changes
    // nothing: the key they have is parked, not wrong.
    expectEnvelope(captured, 400)
    expect(captured.body.error).toContain('cooling down')
  })

  it('syncs the documented list and keeps it for the next status call', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')

    const synced = await respond({ endpoint: '/catalog/refresh', method: 'POST', body: {} })
    expectEnvelope(synced, 200)
    expect((synced.body.value as { models: Array<{ id: string }> }).models.map(m => m.id))
      .toEqual(['gpt-oss:120b-cloud', 'gemma4:31b'])

    const status = await respond({ endpoint: '/status' })
    expectEnvelope(status, 200)
    const models = (status.body.value as { models: Array<{ id: string }> }).models
    expect(models.map(m => m.id)).toEqual(['gpt-oss:120b-cloud', 'gemma4:31b'])
    expect((status.body.value as { catalogSynced: boolean }).catalogSynced).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 3. The envelope matches the sibling lines
  // -------------------------------------------------------------------------

  it('rejects a cross-origin catalog sync', async () => {
    await pool.addAccount(CREDENTIAL, 'primary')
    const captured = await respond({
      endpoint: '/catalog/refresh',
      method: 'POST',
      body: {},
      origin: 'https://example.invalid',
    })

    expectEnvelope(captured, 403)
    expect(captured.body.error).toBe('Cross-origin request rejected.')
  })

  it('answers 405 for a catalog sync that is not a POST', async () => {
    const captured = await respond({ endpoint: '/catalog/refresh' })
    expectEnvelope(captured, 405)
  })
})
