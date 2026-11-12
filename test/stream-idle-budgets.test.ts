import { describe, expect, it } from 'vitest'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../src/host/common/idle-watchdog.ts'
import { STREAM_IDLE_TIMEOUT_MS as CLAUDE } from '../src/host/claude/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as COMMAND_CODE } from '../src/host/command-code/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as GLM } from '../src/host/glm-coding-plan/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as KIMI } from '../src/host/kimi-code/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as MINIMAX } from '../src/host/minimax-code/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as OLLAMA } from '../src/host/ollama/types.ts'
import { STREAM_IDLE_TIMEOUT_MS as WORKBUDDY } from '../src/host/workbuddy/types.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS as CLINE_PASS } from '../src/host/cline-pass/types.ts'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS as OPENDESIGN } from '../src/host/opendesign/types.ts'

/**
 * The transport's own deadline for a silent HTTP/2 stream.
 *
 * undici answers a stalled stream at exactly 300 s. Every route used to carry
 * that same 300 s as its application-level idle budget, so both timers expired
 * together and — because the transport's rejection landed first — the route's
 * own TIMEOUT verdict never decided anything: a dead stream cost the full five
 * minutes of silence before DSH could retry, reported as a severed connection.
 *
 * These cases exist so that tie cannot come back: the budget has to sit
 * STRICTLY inside the transport deadline, and every route has to keep using the
 * one number that does.
 */
const TRANSPORT_STREAM_TIMEOUT_MS = 300_000

/**
 * The routes whose silence budget is the shared one.
 *
 * `qoder` and `step-code` import `STREAM_IDLE_TIMEOUT_MS` straight from
 * `host/common/idle-watchdog.ts`, so they cannot disagree with it and have no
 * value of their own to assert here.
 */
const SHARED_BUDGET_LINES: ReadonlyArray<readonly [string, number]> = [
  ['claude', CLAUDE],
  ['cline-pass', CLINE_PASS],
  ['command-code', COMMAND_CODE],
  ['glm-coding-plan', GLM],
  ['kimi-code', KIMI],
  ['minimax-code', MINIMAX],
  ['opendesign', OPENDESIGN],
  ['workbuddy', WORKBUDDY],
]

describe('every route fails a silent stream before the transport does', () => {
  it('keeps the shared idle budget strictly inside the transport stream timeout', () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBeLessThan(TRANSPORT_STREAM_TIMEOUT_MS)
  })

  it('leaves enough room for the slowest first byte measured on a real session', () => {
    // 65 s from a step starting to its first chunk (a 210k-token prompt); the
    // header pulse gives the streaming phase its own window on top of that.
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000)
  })

  it.each(SHARED_BUDGET_LINES)('keeps the %s budget on the shared value', (_line, value) => {
    expect(value).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  })

  it('keeps ollama longer than the shared budget, on purpose', () => {
    // Local inference is compute-bound: prompt evaluation on a large context can
    // produce no bytes for minutes while the machine works. This line is the one
    // documented exception, so it must stay above the shared value rather than
    // silently following it.
    expect(OLLAMA).toBeGreaterThan(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  })
})
