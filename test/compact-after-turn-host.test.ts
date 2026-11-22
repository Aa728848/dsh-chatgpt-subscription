import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  CompactAfterTurnController,
  createCompactAfterTurnHandler,
  installCompactAfterTurn,
  type CompactNow,
} from '../src/host/compact-after-turn/index.ts'
import { COMPACT_AFTER_TURN_PATH } from '../src/shared/compact-after-turn.ts'

const SESSION = { id: 's1' }
const AGENT = { session: SESSION }

function turnEnd(kind: string) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind } } }
}

/** `null` stands for a Host without a compaction engine. */
function setup(compactNow: CompactNow | null = vi.fn(async () => ({ id: 'c1' }))) {
  const tasks: Array<() => void> = []
  const controller = new CompactAfterTurnController({
    compactor: () => compactNow ?? undefined,
    now: () => 1000,
    defer: (task) => { tasks.push(task) },
  })
  const flush = async () => {
    for (const task of tasks.splice(0)) task()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { controller, compactNow, flush }
}

describe('CompactAfterTurnController', () => {
  it('compacts once when an armed turn ends, then turns itself off', async () => {
    const { controller, compactNow, flush } = setup()
    controller.setArmed('s1', true)
    controller.onStatus(AGENT, 'running')
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    expect(controller.state('s1').phase).toBe('compacting')
    await flush()
    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(compactNow!).mock.calls[0]![0]).toBe(AGENT)
    expect(controller.state('s1')).toEqual({ sessionId: 's1', phase: 'off', available: true, last: { kind: 'compacted', at: 1000 } })
    // One-shot: the next turn end does nothing.
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(compactNow).toHaveBeenCalledTimes(1)
  })

  it('waits for a turn to end when armed while already idle', async () => {
    const { controller, compactNow, flush } = setup()
    controller.setArmed('s1', true)
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(compactNow).not.toHaveBeenCalled()
    expect(controller.state('s1').phase).toBe('armed')
  })

  it('stays armed across a turn the user stopped', async () => {
    const { controller, compactNow, flush } = setup()
    controller.setArmed('s1', true)
    controller.observe(SESSION, turnEnd('aborted'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(compactNow).not.toHaveBeenCalled()
    expect(controller.state('s1').phase).toBe('armed')
    controller.observe(SESSION, turnEnd('error'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(compactNow).toHaveBeenCalledTimes(1)
  })

  it('reports "nothing" when the engine finds no range, and failures with their detail', async () => {
    const nothing = setup(vi.fn(async () => null))
    nothing.controller.setArmed('s1', true)
    nothing.controller.observe(SESSION, turnEnd('completed'))
    nothing.controller.onStatus(AGENT, 'idle')
    await nothing.flush()
    expect(nothing.controller.state('s1').last).toEqual({ kind: 'nothing', at: 1000 })

    const failing = setup(vi.fn(async () => { throw Object.assign(new Error('summary failed'), { code: 'summary' }) }))
    failing.controller.setArmed('s1', true)
    failing.controller.observe(SESSION, turnEnd('completed'))
    failing.controller.onStatus(AGENT, 'idle')
    await failing.flush()
    expect(failing.controller.state('s1')).toMatchObject({ phase: 'off', last: { kind: 'failed', detail: 'summary failed' } })
  })

  it('keeps the switch armed when the session reopened before the engine ran', async () => {
    const compactNow = vi.fn<CompactNow>()
      .mockRejectedValueOnce(Object.assign(new Error('open turn'), { code: 'busy' }))
      .mockResolvedValueOnce({ id: 'c2' })
    const { controller, flush } = setup(compactNow)
    controller.setArmed('s1', true)
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(controller.state('s1')).toMatchObject({ phase: 'armed', last: null })
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(controller.state('s1')).toMatchObject({ phase: 'off', last: { kind: 'compacted' } })
  })

  it('locks the switch only while compacting, and refuses to arm without an engine', async () => {
    let release: (value: unknown) => void = () => undefined
    const { controller, flush } = setup(vi.fn(() => new Promise((resolve) => { release = resolve })))
    controller.setArmed('s1', true)
    expect(controller.setArmed('s1', false).phase).toBe('off')
    controller.setArmed('s1', true)
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    expect(() => controller.setArmed('s1', false)).toThrow(expect.objectContaining({ code: 'busy' }))
    release({ id: 'c1' })
    await flush()
    expect(controller.setArmed('s1', true).phase).toBe('armed')

    const none = setup(null)
    expect(none.controller.state('s1').available).toBe(false)
    expect(() => none.controller.setArmed('s1', true)).toThrow(expect.objectContaining({ code: 'unavailable' }))
  })

  it('aborts a running compaction when its agent is disposed', async () => {
    let seen: AbortSignal | undefined
    const { controller, flush } = setup(vi.fn((_agent, signal: AbortSignal) => {
      seen = signal
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)) })
    }))
    controller.setArmed('s1', true)
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    controller.onDisposed(AGENT)
    await flush()
    expect(seen?.aborted).toBe(true)
    expect(controller.state('s1')).toMatchObject({ phase: 'off', last: { kind: 'failed' } })
  })
})

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }) {
  const req = Object.assign(new EventEmitter(), { method, url, headers }) as unknown as IncomingMessage
  ;(req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  }
  return req
}

function response() {
  const res = { status: 0, body: '' as string, writeHead(status: number) { res.status = status }, setHeader() {}, end(text: string) { res.body = text } }
  return res as typeof res & ServerResponse
}

describe('compact-after-turn route', () => {
  it('reads state, arms same-origin writes, and refuses cross-origin ones', async () => {
    const { controller } = setup()
    const handler = createCompactAfterTurnHandler(controller)

    const read = response()
    await handler(request('GET', `${COMPACT_AFTER_TURN_PATH}?session=s1`), read)
    expect(JSON.parse(read.body)).toEqual({ ok: true, value: { sessionId: 's1', phase: 'off', available: true, last: null } })

    const foreign = response()
    await handler(request('POST', COMPACT_AFTER_TURN_PATH, { sessionId: 's1', armed: true }, { host: '127.0.0.1:3080', origin: 'http://evil.example' }), foreign)
    expect(foreign.status).toBe(403)
    expect(controller.state('s1').phase).toBe('off')

    const write = response()
    await handler(request('POST', COMPACT_AFTER_TURN_PATH, { sessionId: 's1', armed: true }), write)
    expect(write.status).toBe(200)
    expect(controller.state('s1').phase).toBe('armed')

    const bad = response()
    await handler(request('POST', COMPACT_AFTER_TURN_PATH, { sessionId: 's1', armed: 'yes' }), bad)
    expect(bad.status).toBe(400)
  })

  it('answers 409 while the compaction runs', async () => {
    const { controller, flush } = setup(vi.fn(() => new Promise(() => undefined)))
    controller.setArmed('s1', true)
    controller.observe(SESSION, turnEnd('completed'))
    controller.onStatus(AGENT, 'idle')
    await flush()
    const res = response()
    await createCompactAfterTurnHandler(controller)(request('POST', COMPACT_AFTER_TURN_PATH, { sessionId: 's1', armed: false }), res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body).error.code).toBe('busy')
  })
})

describe('installCompactAfterTurn', () => {
  it('prefers the engine the caller tracks over a plain lookup', async () => {
    const compactNow = vi.fn(async () => ({ id: 'c1' }))
    const listeners = new Map<string, (...args: any[]) => void>()
    let route: { handler: (req: IncomingMessage, res: ServerResponse) => unknown } | undefined
    installCompactAfterTurn({
      on: (event, listener) => { listeners.set(event, listener); return () => undefined },
      get: () => undefined,
      webServer: { register: (entry) => { route = entry; return () => undefined } },
    }, { engine: () => ({ compactNow }) })
    const read = response()
    await route!.handler(request('GET', `${COMPACT_AFTER_TURN_PATH}?session=s1`), read)
    expect(JSON.parse(read.body).value.available).toBe(true)
  })

  it('stays inert on a Host without an event bus', () => {
    expect(installCompactAfterTurn({})).toBeUndefined()
  })

  it('wires the Host events, the engine and the route, and releases them on dispose', async () => {
    const listeners = new Map<string, (...args: any[]) => void>()
    const released: string[] = []
    const compactNow = vi.fn(async () => ({ id: 'c1' }))
    let route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown } | undefined
    const dispose = installCompactAfterTurn({
      on: (event, listener) => { listeners.set(event, listener); return () => released.push(event) },
      get: (name) => name === 'compaction' ? { compactNow } : undefined,
      webServer: { register: (entry) => { route = entry; return () => released.push('route') } },
    })!
    expect(route?.path).toBe(COMPACT_AFTER_TURN_PATH)
    await route!.handler(request('POST', COMPACT_AFTER_TURN_PATH, { sessionId: 's1', armed: true }), response())
    listeners.get('session/event')!(SESSION, turnEnd('completed'))
    listeners.get('agent/status')!({ agent: AGENT, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(compactNow).toHaveBeenCalledTimes(1)
    dispose()
    expect(released.sort()).toEqual(['agent/disposed', 'agent/status', 'route', 'session/event'])
  })
})
