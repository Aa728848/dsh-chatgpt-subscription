// @vitest-environment node
/**
 * Tests for the MiniMax Code video generation history (host side).
 *
 * WHY THIS FILE EXISTS SEPARATELY from `minimax-code-video-tool.test.ts`: the
 * ledger has its own contract (what is stored, how it is written, how a broken
 * file degrades, how a route serves it) and pinning it beside the tool's
 * transport assertions would bury it. The generation half below still drives the
 * REAL tool through a mock fetch, because the one thing a store-only test cannot
 * prove is that a successful generation actually lands a row.
 *
 * NO REQUEST LEAVES THIS PROCESS: every generation answer is planned up front.
 */
import fs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryVideoHistoryStore,
  MAX_VIDEO_HISTORY_ENTRIES,
  MinimaxVideoHistoryStore,
  appendHistoryEntry,
  lastMinimaxVideoHistoryFailure,
  parseHistoryDocument,
  recordMinimaxVideoGeneration,
  resetMinimaxVideoHistoryFailure,
  setMinimaxVideoHistoryStore,
  videoHistoryPath,
  type MinimaxVideoHistoryPort,
} from '../src/host/minimax-code/video-history.ts'
import { registerMinimaxCodeRoutes, subPathOf } from '../src/host/minimax-code/routes.ts'
import { MINIMAX_CODE_ROUTE_PREFIX } from '../src/shared/minimax-code-contracts.ts'
import { MinimaxCodeCredentialStore } from '../src/host/minimax-code/token-store.ts'
import { createMinimaxGenerateVideoTool } from '../src/host/minimax-code/video-tool.ts'

/** A clip with a real ISO BMFF header, so the container sniff accepts it. */
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
])

/** One planned mock answer. */
type PlannedAnswer = { status: number; body: unknown; headers?: Record<string, string> }

/** The four answers one successful generation consumes. */
function successPlan(): PlannedAnswer[] {
  return [
    { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-42' } },
    { status: 200, body: { base_resp: { status_code: 0 }, status: 'running' } },
    { status: 200, body: { base_resp: { status_code: 0 }, status: 'succeeded', video_url: 'https://cdn.example.com/out.mp4', duration: 6 } },
    { status: 200, body: MP4, headers: { 'content-type': 'video/mp4' } },
  ]
}

/** A queue-driven mock fetch: each call consumes the next planned answer. */
function queuedFetch(plan: PlannedAnswer[]): { fetchFn: typeof fetch } {
  const queue = [...plan]
  const fetchFn = (async (url: unknown) => {
    const next = queue.shift()
    if (next === undefined) throw new Error('mock fetch ran out of planned answers for ' + String(url))
    const payload: BodyInit = next.body instanceof Uint8Array
      ? next.body
      : typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return new Response(payload, {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as unknown as typeof fetch
  return { fetchFn }
}

let work: string
let historyDir: string
let originalHome: string | undefined

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'minimax-history-workspace-'))
  historyDir = await mkdtemp(path.join(tmpdir(), 'minimax-history-store-'))
  originalHome = process.env.DSH_HOME
  process.env.DSH_HOME = historyDir
  setMinimaxVideoHistoryStore(undefined)
  resetMinimaxVideoHistoryFailure()
})

afterEach(async () => {
  setMinimaxVideoHistoryStore(undefined)
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
  await rm(historyDir, { recursive: true, force: true }).catch(() => undefined)
})

/** A plaintext store at an explicit path, so no platform backend is composed. */
function plaintextStore(file = path.join(historyDir, 'storages', 'minimax-code-video-history.json')) {
  // The second argument is passed EXPLICITLY as undefined: "no backend, plaintext"
  // is what this store is meant to be, and on Windows a defaulted constructor would
  // compose the DPAPI backend instead.
  return { store: new MinimaxVideoHistoryStore(file, undefined), file }
}

/** One record, with the shape the tool writes. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    model: 'MiniMax-H3',
    videoPath: 'minimax-videos/minimax-1-task-42.mp4',
    bytes: 4096,
    taskId: 'task-42',
    ratio: '16:9',
    durationSeconds: 6,
    ...overrides,
  }
}

describe('videoHistoryPath', () => {
  it('lives under storages in DSH_HOME, beside the pool file', () => {
    expect(videoHistoryPath()).toBe(path.join(historyDir, 'storages', 'minimax-code-video-history.json'))
  })
})

describe('MinimaxVideoHistoryStore', () => {
  it('round-trips one record, newest first, with the timestamp stamped by the store', async () => {
    const { store } = plaintextStore()
    await store.record(record({ taskId: 'task-a' }), 1_700_000_000_000)
    await store.record(record({ taskId: 'task-b' }), 1_700_000_001_000)
    const entries = await store.list()
    expect(entries.map((entry) => entry.taskId)).toEqual(['task-b', 'task-a'])
    expect(entries[0]).toMatchObject({
      createdAtMs: 1_700_000_001_000,
      model: 'MiniMax-H3',
      ratio: '16:9',
      durationSeconds: 6,
      bytes: 4096,
    })
    // The path stored is WORKSPACE-RELATIVE, never absolute: the workspace moves.
    expect(path.isAbsolute(String(entries[0]?.videoPath))).toBe(false)
  })

  it('stores no video content, only facts about it', async () => {
    const { store, file } = plaintextStore()
    await store.record(record(), 1_700_000_000_000)
    const raw = await readFile(file, 'utf8')
    // The bytes live in the workspace; the ledger carries a path and a length.
    expect(raw).not.toContain('ftyp')
    expect(JSON.parse(raw)).toMatchObject({ version: 1 })
  })

  it('reads an empty history when the file does not exist', async () => {
    const { store } = plaintextStore(path.join(historyDir, 'storages', 'never-written.json'))
    await expect(store.list()).resolves.toEqual([])
    await expect(store.read()).resolves.toEqual({ version: 1, entries: [] })
  })

  it('reads an empty history for corrupt JSON instead of throwing', async () => {
    const { store, file } = plaintextStore()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{ this is not json', 'utf8')
    await expect(store.list()).resolves.toEqual([])
  })

  it('drops rows it cannot render rather than inventing their fields', async () => {
    const { store, file } = plaintextStore()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({
      version: 1,
      entries: [
        { createdAtMs: 2, model: 'MiniMax-H3', videoPath: 'a.mp4', bytes: 1, taskId: 'good' },
        { createdAtMs: 1, model: 'MiniMax-H3', bytes: 1, taskId: 'no-path' },
        'not a row',
      ],
    }), 'utf8')
    const entries = await store.list()
    expect(entries.map((entry) => entry.taskId)).toEqual(['good'])
  })

  it('keeps the newest rows when the ledger overflows, dropping the oldest', async () => {
    const { store } = plaintextStore()
    for (let index = 0; index < MAX_VIDEO_HISTORY_ENTRIES + 5; index += 1) {
      await store.record(record({ taskId: 'task-' + index }), 1_700_000_000_000 + index)
    }
    const entries = await store.list()
    expect(entries).toHaveLength(MAX_VIDEO_HISTORY_ENTRIES)
    // Newest first, and the five oldest fell off the tail.
    expect(entries[0]?.taskId).toBe('task-' + (MAX_VIDEO_HISTORY_ENTRIES + 4))
    expect(entries.at(-1)?.taskId).toBe('task-5')
    expect(entries.some((entry) => entry.taskId === 'task-0')).toBe(false)
  })

  it('leaves no temporary file behind after a write', async () => {
    const { store, file } = plaintextStore()
    await store.record(record({ taskId: 'task-1' }), 1_700_000_000_000)
    await store.record(record({ taskId: 'task-2' }), 1_700_000_001_000)
    const names = await readdir(path.dirname(file))
    // The atomic write goes through a sibling temp file and renames it into place;
    // a leftover would mean the rename never happened.
    expect(names.filter((name) => name.includes('.dsh-tmp-'))).toEqual([])
    expect(names).toContain(path.basename(file))
  })

  it('writes the file with owner-only permissions', async () => {
    const { store, file } = plaintextStore()
    await store.record(record(), 1_700_000_000_000)
    if (process.platform === 'win32') return
    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('replaces the row for a task id that already exists, rather than counting it twice', async () => {
    const { store } = plaintextStore()
    await store.record(record({ taskId: 'task-same', bytes: 10 }), 1_700_000_000_000)
    await store.record(record({ taskId: 'task-same', bytes: 20 }), 1_700_000_001_000)
    const entries = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.bytes).toBe(20)
  })

  it('serializes concurrent records instead of losing one', async () => {
    const { store } = plaintextStore()
    await Promise.all([
      store.record(record({ taskId: 'task-1' }), 1_700_000_000_000),
      store.record(record({ taskId: 'task-2' }), 1_700_000_001_000),
      store.record(record({ taskId: 'task-3' }), 1_700_000_002_000),
    ])
    await expect(store.list()).resolves.toHaveLength(3)
  })
})

describe('parseHistoryDocument / appendHistoryEntry', () => {
  it('normalizes anything unrecognisable to an empty document', () => {
    expect(parseHistoryDocument(null)).toEqual({ version: 1, entries: [] })
    expect(parseHistoryDocument({ entries: 'nope' })).toEqual({ version: 1, entries: [] })
  })

  it('prepends, so the newest row is first without the reader sorting', () => {
    const first = appendHistoryEntry({ version: 1, entries: [] }, record({ taskId: 'a' }), 1)
    const second = appendHistoryEntry(first, record({ taskId: 'b' }), 2)
    expect(second.entries.map((entry) => entry.taskId)).toEqual(['b', 'a'])
  })
})

/** A fake response object capturing the JSON body a route wrote. */
function fakeExchange(): { response: ServerResponse; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {}
  const response = {
    writeHead(status: number) { captured.status = status; return response },
    end(raw?: string) { captured.body = raw === undefined ? undefined : JSON.parse(raw) },
  } as unknown as ServerResponse
  return { response, captured }
}

/** A GET request arriving under the line's own prefix. */
function fakeRequest(input: { url: string; method?: string }): IncomingMessage {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const request = {
    url: input.url,
    method: input.method ?? 'GET',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    on(event: string, listener: (value?: unknown) => void) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return request
    },
    destroy() {},
  } as unknown as IncomingMessage
  return request
}

describe('GET /video-history', () => {
  /** Register the line's routes against a throwaway web server and return the handler. */
  function register(): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
    const ctx = {
      webServer: {
        register(route: { path: string; handler: any }) {
          handler = route.handler
          return () => undefined
        },
      },
      logger: { warn() {}, info() {} },
    } as unknown as Context
    registerMinimaxCodeRoutes(ctx, new MinimaxCodeCredentialStore(), {})
    if (handler === undefined) throw new Error('the routes did not register a handler')
    return handler
  }

  it('mounts under /minimax-code/api and answers the line envelope with { entries }', async () => {
    const { store, file } = plaintextStore()
    setMinimaxVideoHistoryStore(store)
    await store.record(record({ taskId: 'task-route' }), 1_700_000_000_000)
    const { response, captured } = fakeExchange()
    await register()(fakeRequest({ url: '/minimax-code/api/video-history' }), response)
    expect(captured.status).toBe(200)
    // The line's envelope is `{ ok, value }` on every route; the history route keeps
    // it rather than inventing a bare body, and adds the two facts the card renders
    // beside the rows: where the ledger lives, and whether that file is encrypted.
    expect(captured.body.ok).toBe(true)
    expect(captured.body.value).toMatchObject({ encryptedAtRest: false, storagePath: file })
    expect(captured.body.value.entries).toHaveLength(1)
    expect(captured.body.value.entries[0].taskId).toBe('task-route')
  })

  it('is mounted under the line prefix, so the URL a client calls is never bare', () => {
    // The handler is registered once, on the prefix, and dispatches on the SUB-path.
    // A client that called a bare '/video-history' would not reach this server at
    // all, which is why the route is named 'video-history' here, not '/video-history'.
    const mounted: string[] = []
    const ctx = {
      webServer: {
        register(route: { path: string; handler: any }) { mounted.push(route.path); return () => undefined },
      },
      logger: { warn() {}, info() {} },
    } as unknown as Context
    registerMinimaxCodeRoutes(ctx, new MinimaxCodeCredentialStore(), {})
    expect(mounted).toEqual([MINIMAX_CODE_ROUTE_PREFIX])
    expect(MINIMAX_CODE_ROUTE_PREFIX).toBe('/minimax-code/api')
    expect(subPathOf('/minimax-code/api/video-history')).toBe('video-history')
  })

  it('answers an empty list when nothing was ever generated', async () => {
    setMinimaxVideoHistoryStore(plaintextStore().store)
    const { response, captured } = fakeExchange()
    await register()(fakeRequest({ url: '/minimax-code/api/video-history' }), response)
    expect(captured.status).toBe(200)
    expect(captured.body.value.entries).toEqual([])
  })

  it('is read-only: a POST is refused', async () => {
    setMinimaxVideoHistoryStore(plaintextStore().store)
    const { response, captured } = fakeExchange()
    await register()(fakeRequest({ url: '/minimax-code/api/video-history', method: 'POST' }), response)
    expect(captured.status).toBe(405)
  })
})

describe('the generation tool writes the ledger', () => {
  /** A context whose working-directory service answers the temp workspace. */
  function context(): { get: (name: string) => unknown } {
    return { get: (name: string) => (name === 'workingDirectory' ? { ensure: async () => work } : undefined) }
  }

  /** One execution, routed to the MiniMax Code provider. */
  function execution(): unknown {
    return {
      signal: undefined,
      callId: 'call-1',
      agent: {
        session: { requestHeader: () => ({ config: { provider: 'minimax-code', model: 'MiniMax-M3' } }) },
        options: {},
      },
    }
  }

  function generateTool(fetchFn: typeof fetch) {
    return createMinimaxGenerateVideoTool(context() as never, {
      fetchFn,
      pool: { getFreshCredential: vi.fn(async () => ({ accessToken: 'tok-abc', region: 'cn' as const })) },
      pollIntervalMs: 1,
      generationBudgetMs: 60_000,
      retryBackoffMs: 0,
      now: () => 1_700_000_000_000,
    }) as never as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> }
  }

  it('records one row after a clip is written, pointing at the file on disk', async () => {
    const { store } = plaintextStore()
    setMinimaxVideoHistoryStore(store)
    const { fetchFn } = queuedFetch(successPlan())
    const result = await generateTool(fetchFn).execute({ prompt: 'a cat on a piano' }, execution())
    const entries = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      model: 'MiniMax-H3',
      taskId: 'task-42',
      bytes: MP4.byteLength,
      videoPath: result.videoPath,
    })
    // The recorded path really addresses the clip in the workspace.
    await expect(readFile(path.join(work, String(entries[0]?.videoPath)))).resolves.toBeDefined()
  })

  it('records NOTHING when the generation fails', async () => {
    const { store } = plaintextStore()
    setMinimaxVideoHistoryStore(store)
    const { fetchFn } = queuedFetch([
      { status: 200, body: { base_resp: { status_code: 0 }, task_id: 'task-42' } },
      { status: 200, body: { base_resp: { status_code: 0 }, status: 'failed' } },
    ])
    await expect(generateTool(fetchFn).execute({ prompt: 'a cat' }, execution())).rejects.toThrow()
    await expect(store.list()).resolves.toEqual([])
  })

  it('does not turn a history write failure into a generation failure', async () => {
    // A path that cannot be a directory: mkdir fails, so the record throws, and the
    // clip is on disk and paid for either way.
    const blocked = path.join(historyDir, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')
    setMinimaxVideoHistoryStore(new MinimaxVideoHistoryStore(path.join(blocked, 'history.json'), undefined))
    const { fetchFn } = queuedFetch(successPlan())
    const result = await generateTool(fetchFn).execute({ prompt: 'a cat' }, execution())
    expect(result.taskId).toBe('task-42')
    await expect(readFile(path.join(work, String(result.videoPath)))).resolves.toBeDefined()
  })

  it('recordMinimaxVideoGeneration never throws, even when the store does', async () => {
    const broken = { record: async () => { throw new Error('disk full') } } as unknown as MinimaxVideoHistoryPort
    setMinimaxVideoHistoryStore(broken)
    // `false` rather than a throw: the caller cannot do anything about a failed
    // record, and the generation it describes has already succeeded.
    await expect(recordMinimaxVideoGeneration(record())).resolves.toBe(false)
    // The reason is remembered rather than thrown, so the settings card can show it
    // beside an empty ledger instead of the row simply going missing.
    expect(lastMinimaxVideoHistoryFailure()).toBe('disk full')
  })

  it('forgets the previous failure once a record succeeds again', async () => {
    setMinimaxVideoHistoryStore({ record: async () => { throw new Error('disk full') } } as unknown as MinimaxVideoHistoryPort)
    await expect(recordMinimaxVideoGeneration(record())).resolves.toBe(false)
    setMinimaxVideoHistoryStore(new InMemoryVideoHistoryStore())
    await expect(recordMinimaxVideoGeneration(record())).resolves.toBe(true)
  })
})
