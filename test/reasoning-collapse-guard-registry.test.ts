import { describe, expect, it } from 'vitest'
import { installReasoningCollapseGuard, type GuardChunk, type ReasoningCollapseContext, type GuardStreamListener } from '../src/host/reasoning-collapse-guard/index.ts'

/**
 * The Agent registry read, against the boundary a REAL host presents.
 *
 * The registry is provided by a sibling fiber (@deepseek-ai/dsh-agent), so a
 * plugin that does not declare `agents` in its `inject` list gets a THROW
 * from `ctx.agents` — Cordis raises `cannot get property "agents" without
 * inject`. `ctx.get('agents')` reads the service store directly and needs no
 * declaration.
 *
 * Two failure paths meet here. The guard also keeps an `agent/created` map as
 * a fallback, and that map covers the case where an Agent appears AFTER the
 * guard is installed. It does NOT cover the case where the Agent already
 * existed — a plugin HMR reload, or an activation that follows an established
 * session — and in that window the property read is the only other route. It
 * throws, so `resolveAgent` answers undefined, `breakOff` returns at its
 * first line, and the runaway is cut with no cancel and no resume: the turn
 * ends silently. The guard's own harness hands its fake context an `agents`
 * property directly, so every pre-existing test passed regardless. These tests
 * model the real boundary instead: the property throws, the reader answers.
 */

const COLLAPSED = 'Let me call. Go. Calling. Go. '.repeat(400)
const PARTS = COLLAPSED.match(/.{1,64}/g) ?? []

interface RecordingAgent {
  readonly id: string
  readonly cancels: unknown[]
  readonly steers: unknown[]
  cancel(cause: unknown): void
  steer(message: unknown): void
}

/**
 * A real method, not an arrow, and present from the start: `breakOff` reaches
 * the Agent through `agent.cancel?.()` / `agent.steer?.()`, so a fixture that
 * omitted either would silently record nothing and the assertion would look
 * like a product defect.
 */
function recordingAgent(id: string): RecordingAgent {
  const cancels: unknown[] = []
  const steers: unknown[] = []
  return {
    id,
    cancels,
    steers,
    cancel(cause: unknown) { cancels.push(cause) },
    steer(message: unknown) { steers.push(message) },
  }
}

/**
 * The context the production host presents: `agents` is a property this
 * plugin did NOT declare, so reaching for it throws; `ctx.get` answers from
 * the service store, as Cordis does for every provided service.
 */
function productionLikeContext(agent: RecordingAgent | undefined): {
  ctx: ReasoningCollapseContext
  listeners: GuardStreamListener[]
} {
  const listeners: GuardStreamListener[] = []
  const services: Record<string, unknown> = {
    agents: { get: (id: unknown) => (agent !== undefined && id === agent.id ? agent : undefined) },
  }
  const ctx = {
    on(event: string, listener: unknown) {
      if (event === 'llm/stream') listeners.push(listener as GuardStreamListener)
      return () => undefined
    },
    logger: { warn: () => undefined },
    get: (name: string) => services[name],
  } as unknown as ReasoningCollapseContext
  Object.defineProperty(ctx, 'agents', {
    get() { throw new Error('cannot get property "agents" without inject') },
  })
  return { ctx, listeners }
}

/** Feed one collapsed reasoning stream through the guard and count the output. */
async function drain(listeners: GuardStreamListener[]): Promise<number> {
  const source = async function* (): AsyncIterable<GuardChunk> {
    for (const part of PARTS) yield { type: 'reasoning-delta', text: part }
  }
  let produced = 0
  for (const listener of listeners) {
    const options = { model: 'm', sessionId: 'session-a', signal: new AbortController().signal }
    for await (const _ of listener(options, source)) produced++
  }
  return produced
}

describe('reasoning-collapse guard: the Agent registry read on a real boundary', () => {
  it('cancels and queues the resume when the Agent predates the guard and agents was never injected', async () => {
    const agent = recordingAgent('session-a')
    const { ctx, listeners } = productionLikeContext(agent)
    installReasoningCollapseGuard(ctx, { cooldownMs: 0, minWindowChars: 100, now: () => 0 })

    expect(listeners).toHaveLength(1)
    const produced = await drain(listeners)
    await new Promise(resolve => setTimeout(resolve, 10))

    // The break cut the runaway...
    expect(produced).toBeLessThan(PARTS.length)
    // ...AND reached the Agent. Reverting to the property-only read leaves both
    // of these empty: a truncated turn with nothing resumed and nothing said,
    // which is the shipped defect.
    expect(agent.cancels).toHaveLength(1)
    expect(agent.steers).toHaveLength(1)
  })

  it('still cuts the runaway when no registry can be reached at all', async () => {
    const { ctx, listeners } = productionLikeContext(undefined)
    delete (ctx as { get?: unknown }).get
    installReasoningCollapseGuard(ctx, { cooldownMs: 0, minWindowChars: 100, now: () => 0 })

    const produced = await drain(listeners)

    // Nothing to resume, but the runaway is still cut rather than left to burn
    // the whole output budget.
    expect(produced).toBeLessThan(PARTS.length)
  })
})
