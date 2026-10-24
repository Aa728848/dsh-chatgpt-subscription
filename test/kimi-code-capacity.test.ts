/**
 * Two ceilings bound one Kimi Code request, and they answer to different owners:
 * the token window the model (or the user) declares, and the 2 MB body the
 * gateway in front of this route accepts.
 *
 * Two mechanisms are pinned here, and they are deliberately independent:
 *
 * 1. GUARANTEED. A request too large for the gateway is refused locally with
 *    CONTEXT_OVERFLOW_CODE, and the same code comes back when the gateway answers
 *    with its own byte sentence. DSH's overflow recovery compacts and retries the
 *    step on that code alone, so a long session recovers instead of dying. Always
 *    on: this is the safety net.
 * 2. OPT-IN. DSH_KIMI_CODE_BYTES_PER_TOKEN folds the PUBLISHED window against the
 *    byte ceiling, so the host's own compaction threshold lands before the wall
 *    instead of at it. Unset — the default — publishes the declared window
 *    untouched, because taking context away from a model, or from a window the
 *    user explicitly overrode, is a behaviour change rather than a fix.
 *
 * Why the knob exists at all: DSH prices text at a FIXED four characters per
 * token (`@deepseek-ai/dsh-token-meter`, CHARS_PER_TOKEN = 4) and never looks at
 * how many bytes those characters weigh, so one metered token covers about 4
 * bytes of ASCII, 8 of mixed prose-and-code and 12 of dense CJK. The host's
 * threshold is floor(min(0.8 x window, window - 65_536)) — compaction-basic's
 * resolveCompactSpec, with this route reserving no completion tokens — which on a
 * 1M window is 838_860 metered tokens: past the 2 MB wall of every density.
 * Turning folding on moves the threshold to the near side of the wall for the
 * densities the chosen setting covers.
 *
 * The official kimi-cli solves the same problem budget-first and always-on
 * (`src/kimi_cli/soul/compaction.py::should_auto_compact` compacts at 85% of the
 * window or with 50K tokens left, and never handles 2097152 itself); this route
 * guarantees the recovery instead, and makes the pre-emption a choice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  CONTEXT_HEADROOM_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  byteDerivedTokenCap,
  effectiveContextWindow,
  maxMessageBodyBytes,
  maxOutputTokensFor,
  wireBytesPerToken,
} from '../src/host/kimi-code/types.ts'
import { KIMI_CODE_MODELS } from '../src/host/kimi-code/model-catalog.ts'
import {
  KimiCodeAdapter,
  classifyKimiFailure,
  isKimiBodySizeRefusal,
} from '../src/host/kimi-code/adapter.ts'
import { assertRequestBodyFits, estimatedInputTokens } from '../src/host/kimi-code/mapper.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { CONTEXT_OVERFLOW_CODE } from '../src/host/common/context-overflow.ts'

/** A stand-in environment, so a developer's own override cannot leak in. */
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

/** A deployment that asked for early compaction at one metered density. */
const fold = (bytesPerToken: string) => env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: bytesPerToken })

const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3', name: 'K3', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'k3-256k', name: 'K3 (256K)', contextWindow: 262_144, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding', contextWindow: 1_048_576, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' },
]

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
}

function credentials(): KimiCodeCredentials {
  return {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    expiresIn: 86_400,
    region: 'mainland-cn',
    oauthHost: 'https://auth.kimi.com',
    baseUrl: 'https://api.kimi.com/coding',
  }
}

async function buildAdapter(options: {
  contextWindowOverrides?: Record<string, number>
  fetchFn?: typeof fetch
} = {}) {
  const store = new FileCredentialStore(tmp('kc-cap-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-cap-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: options.contextWindowOverrides ?? {},
    defaultReasoningEffort: null,
    cacheTtl: null,
  })
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    fetchFn: options.fetchFn,
    loadCatalog: async () => CATALOG,
  })
  return { adapter }
}

function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }))
}

/**
 * Options in the shape the harness delivers.
 *
 * Block content, not a bare string: `normalizeGenerateOptions` keeps only tagged
 * blocks, so a string body reaches the mapper as an empty message — and an empty
 * history is what makes `estimatedInputTokens` answer "unknown" and skip the
 * prompt-size clamp these tests are about.
 */
function generateOptions(model: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
    ...overrides,
  } as GenerateOptions
}

/** The code and message of a failure the guard or the stream raised. */
function capturedFailure(error: unknown): { message: string; code?: string } {
  const failure = error as { message?: unknown; code?: unknown }
  return {
    message: typeof failure.message === 'string' ? failure.message : String(error),
    code: typeof failure.code === 'string' ? failure.code : undefined,
  }
}

/** Drain one stream only to keep the error that ended it. */
async function streamFailure(stream: AsyncIterable<unknown>): Promise<{ message: string; code?: string }> {
  try {
    for await (const _chunk of stream) { /* the failure is the point; chunks are not */ }
  } catch (error) {
    return capturedFailure(error)
  }
  throw new Error('expected the stream to fail')
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/**
 * The host's pressure threshold for one published window.
 *
 * floor(min(ratio x window, window - reserved - headroom)), from
 * compaction-basic's resolveCompactSpec. reservedCompletionTokens is 0 here:
 * this adapter omits defaultMaxTokens on purpose (its completion budget is
 * computed per request), so the harness has nothing to reserve. Which term binds
 * depends on the window — the ratio below 327_680 tokens, the headroom above it.
 */
const THRESHOLD_RATIO = 0.8
const HEADROOM_TOKENS = 65_536
const pressureThreshold = (window: number): number => Math.min(
  Math.floor(window * THRESHOLD_RATIO),
  window - HEADROOM_TOKENS,
)

describe('window folding is opt-in', () => {
  it('publishes the declared window untouched when the knob is unset', () => {
    // The default, and the reason this is not a silent clamp: the vendor's
    // figure — and a window the user overrode by hand — are published as they
    // are. A session that outgrows the wire recovers at the wall instead.
    expect(wireBytesPerToken(env({}))).toBeUndefined()
    expect(byteDerivedTokenCap(env({}))).toBeUndefined()
    expect(effectiveContextWindow(1_048_576, env({}))).toBe(1_048_576)
    expect(effectiveContextWindow(262_144, env({}))).toBe(262_144)
    expect(effectiveContextWindow(65_536, env({}))).toBe(65_536)
  })

  it('folds to min(declared, cap) once a density is set', () => {
    expect(wireBytesPerToken(fold('4'))).toBe(4)
    expect(byteDerivedTokenCap(fold('4'))).toBe(524_288)
    expect(effectiveContextWindow(1_048_576, fold('4'))).toBe(524_288)
    // min() never enlarges: a 256K window stays where it is.
    expect(effectiveContextWindow(262_144, fold('4'))).toBe(262_144)
  })

  it('treats an empty, unparsable, zero or negative value as unset', () => {
    // The knob is a preference, not a guard, so a typo costs the pre-emption and
    // nothing else: the recovery code on an oversized refusal is still armed.
    for (const raw of ['', '   ', 'abc', '0', '-1', '-12', 'NaN', 'huge', 'Infinity']) {
      expect(wireBytesPerToken(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: raw })), raw).toBeUndefined()
      expect(byteDerivedTokenCap(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: raw })), raw).toBeUndefined()
      expect(
        effectiveContextWindow(1_048_576, env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: raw })),
        raw,
      ).toBe(1_048_576)
    }
    // Leading and trailing spaces are the likeliest typo, and are tolerated.
    expect(wireBytesPerToken(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: ' 12 ' }))).toBe(12)
    expect(wireBytesPerToken(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: '12.9' }))).toBe(12)
    // A fraction that floors to 0 would divide the ceiling by zero, so the floor
    // is 1 byte per token rather than 0.
    expect(wireBytesPerToken(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: '0.5' }))).toBe(1)
    expect(byteDerivedTokenCap(env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: '0.5' }))).toBe(2_097_152)
  })

  it('puts each setting at the window and threshold it implies', () => {
    const rows = [
      { density: '4 (code)', cap: 524_288, threshold: 419_430 },
      { density: '5', cap: 419_430, threshold: 335_544 },
      { density: '8 (mixed)', cap: 262_144, threshold: 196_608 },
      { density: '12 (dense CJK)', cap: 174_762, threshold: 109_226 },
    ]
    for (const row of rows) {
      const bytesPerToken = row.density.split(' ')[0]!
      const rowEnv = fold(bytesPerToken)
      expect(wireBytesPerToken(rowEnv), bytesPerToken).toBe(Number(bytesPerToken))
      expect(byteDerivedTokenCap(rowEnv), bytesPerToken).toBe(row.cap)
      expect(pressureThreshold(row.cap), bytesPerToken).toBe(row.threshold)
    }
  })

  it('follows a measured body ceiling when folding is on', () => {
    const wide = env({ DSH_KIMI_CODE_BYTES_PER_TOKEN: '4', DSH_KIMI_CODE_MAX_BODY_BYTES: '4194304' })
    expect(byteDerivedTokenCap(wide)).toBe(1_048_576)
    // The cap is a cap, not a window: a larger declared window is still folded.
    expect(effectiveContextWindow(8_388_608, wide)).toBe(1_048_576)
    expect(effectiveContextWindow(1_048_576, wide)).toBe(1_048_576)
  })

  it('does not trust a declared window that is missing, zero, negative or not finite', () => {
    for (const window of [0, -1, -262_144, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Without folding the fallback is the catalog default ...
      const unfolded = effectiveContextWindow(window, env({}))
      expect(Number.isFinite(unfolded), String(window)).toBe(true)
      expect(unfolded, String(window)).toBe(DEFAULT_CONTEXT_WINDOW)
      // ... and with folding it is the smaller of that and the cap.
      expect(effectiveContextWindow(window, fold('12')), String(window)).toBe(174_762)
    }
  })
})

/**
 * What each density setting actually protects, and where the 2 MB wall falls.
 *
 * DSH prices four characters per token whatever they weigh, so the wall sits at
 * ceil(2 MB / (4 x bytes-per-character)) metered tokens and the host's threshold
 * at floor(min(0.8 x window, window - 65_536)). A density 'is protected' when its
 * wall is reached no earlier than the threshold — the same statement as 'the
 * compiler compacts while compaction can still help'.
 */
describe('what each density setting protects, when folding is on', () => {
  /** Fixed text density the host prices with (dsh-token-meter estimate.ts). */
  const CHARS_PER_TOKEN = 4

  const DENSITIES = [
    { name: 'ASCII', bytesPerCharacter: 1, wallTokens: 524_288 },
    { name: 'mixed CJK prose with English code and JSON tool results', bytesPerCharacter: 2, wallTokens: 262_144 },
    { name: 'dense CJK', bytesPerCharacter: 3, wallTokens: 174_763 },
  ] as const

  it('puts the 2 MB wall where each density puts it', () => {
    const wall = maxMessageBodyBytes(env({}))
    for (const density of DENSITIES) {
      // ceil, because a partial token still costs a token.
      expect(Math.ceil(wall / (CHARS_PER_TOKEN * density.bytesPerCharacter)), density.name)
        .toBe(density.wallTokens)
    }
    // The same three figures as bytes per metered token, which is the knob's own
    // unit: 4, 8 and 12 — none of which is a default, they are the three settings
    // a deployment picks from.
    expect(CHARS_PER_TOKEN * 1).toBe(4)
    expect(CHARS_PER_TOKEN * 2).toBe(8)
    expect(CHARS_PER_TOKEN * 3).toBe(12)
  })

  it('protects nothing by default, and does not need to', () => {
    // This is the accepted trade, not a defect: on the published 1M window every
    // density reaches the gateway before the threshold, so nothing is summarized
    // early — and the refusal that ends the wait carries CONTEXT_OVERFLOW_CODE, so
    // the host compacts there and retries the step (pinned in the guard suite
    // below) instead of ending the turn.
    const published = effectiveContextWindow(1_048_576, env({}))
    expect(published).toBe(1_048_576)
    const threshold = pressureThreshold(published)
    expect(threshold).toBe(838_860)
    for (const density of DENSITIES) {
      expect(density.wallTokens, density.name).toBeLessThan(threshold)
    }
  })

  it('protects code-dominated traffic at 4', () => {
    const published = effectiveContextWindow(1_048_576, fold('4'))
    expect(published).toBe(524_288)
    const threshold = pressureThreshold(published)
    // The ratio term binds here: 0.8 x 524_288 is 419_430, under the 458_752 the
    // headroom would allow.
    expect(threshold).toBe(419_430)
    const ascii = DENSITIES[0]
    expect(ascii.wallTokens).toBeGreaterThan(threshold)
    expect(ascii.wallTokens - threshold).toBe(104_858)
    // The prose-heavy densities still meet the wall first, and recover there.
    expect(DENSITIES[1].wallTokens).toBeLessThan(threshold)
    expect(DENSITIES[2].wallTokens).toBeLessThan(threshold)
  })

  it('protects mixed text as well at 8', () => {
    const published = effectiveContextWindow(1_048_576, fold('8'))
    expect(published).toBe(262_144)
    // Here the headroom binds instead: 0.8 x 262_144 would be 209_715.
    const threshold = pressureThreshold(published)
    expect(threshold).toBe(196_608)
    expect(DENSITIES[0].wallTokens).toBeGreaterThan(threshold)
    expect(DENSITIES[1].wallTokens).toBeGreaterThan(threshold)
    // Even this setting cannot protect dense CJK.
    expect(DENSITIES[2].wallTokens).toBeLessThan(threshold)
  })

  it('protects all three at 12', () => {
    const published = effectiveContextWindow(1_048_576, fold('12'))
    expect(published).toBe(174_762)
    const threshold = pressureThreshold(published)
    expect(threshold).toBe(109_226)
    for (const density of DENSITIES) {
      expect(density.wallTokens, density.name).toBeGreaterThan(threshold)
    }
  })

  it('buys nothing below 4, where the window outgrows what the wire can fill', () => {
    // 2 publishes the whole 1M and 3 publishes 699_050: both put the threshold
    // above even the ASCII wall, so no density can ever compact in time. This is
    // why the knob's floor is the ASCII density, not 'smaller is safer'.
    for (const bytesPerToken of ['2', '3']) {
      const threshold = pressureThreshold(effectiveContextWindow(1_048_576, fold(bytesPerToken)))
      expect(DENSITIES[0].wallTokens, bytesPerToken).toBeLessThan(threshold)
    }
    expect(pressureThreshold(effectiveContextWindow(1_048_576, fold('2')))).toBe(838_860)
    expect(pressureThreshold(effectiveContextWindow(1_048_576, fold('3')))).toBe(559_240)
  })
})

describe('the window the adapter publishes', () => {
  it('publishes the declared 1M window untouched by default', async () => {
    const { adapter } = await buildAdapter()
    expect((await adapter.resolveModel('kimi-code', 'kimi-for-coding')).context)
      .toEqual({ contextWindow: 1_048_576 })
  })

  it('publishes a user override of 1M untouched, which is the whole point', async () => {
    // The reported case: k3 overridden to 1_048_576 in the settings store. The
    // window the user chose is what the dashboard shows and what the host
    // budgets against; folding it here is exactly what this default avoids.
    const { adapter } = await buildAdapter({ contextWindowOverrides: { k3: 1_048_576 } })
    expect((await adapter.resolveModel('kimi-code', 'k3')).context)
      .toEqual({ contextWindow: 1_048_576 })
  })

  it('leaves the 256K models where the catalog puts them', async () => {
    const { adapter } = await buildAdapter()
    for (const modelId of ['k3', 'k3-256k']) {
      expect((await adapter.resolveModel('kimi-code', modelId)).context, modelId)
        .toEqual({ contextWindow: 262_144 })
    }
    expect(DEFAULT_CONTEXT_WINDOW).toBe(262_144)
  })

  it('folds both the declared and the overridden window when asked to', async () => {
    vi.stubEnv('DSH_KIMI_CODE_BYTES_PER_TOKEN', '4')
    const { adapter } = await buildAdapter({ contextWindowOverrides: { k3: 1_048_576 } })
    expect((await adapter.resolveModel('kimi-code', 'kimi-for-coding')).context)
      .toEqual({ contextWindow: 524_288 })
    // An override is folded like any other declared window once the deployment
    // opted in — min() cannot lift it above the cap either.
    expect((await adapter.resolveModel('kimi-code', 'k3')).context)
      .toEqual({ contextWindow: 524_288 })
    const absurd = await buildAdapter({ contextWindowOverrides: { k3: 4_194_304 } })
    expect((await absurd.adapter.resolveModel('kimi-code', 'k3')).context)
      .toEqual({ contextWindow: 524_288 })
    // min() never enlarges a window below the cap.
    expect((await adapter.resolveModel('kimi-code', 'k3-256k')).context)
      .toEqual({ contextWindow: 262_144 })
  })

  it('folds at the density a CJK-first deployment sets', async () => {
    vi.stubEnv('DSH_KIMI_CODE_BYTES_PER_TOKEN', '12')
    const { adapter } = await buildAdapter()
    expect((await adapter.resolveModel('kimi-code', 'kimi-for-coding')).context)
      .toEqual({ contextWindow: 174_762 })
    expect((await adapter.resolveModel('kimi-code', 'k3-256k')).context)
      .toEqual({ contextWindow: 174_762 })
  })

  it('sizes the completion budget from the window it publishes', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }))
    const { adapter } = await buildAdapter()
    const options = generateOptions('kimi-for-coding')
    for await (const _chunk of adapter.stream(options)) { /* drain one turn */ }

    // The arithmetic the builder runs: the cap tracks the published window and
    // the prompt estimate is subtracted from it. Unfolded, that window is the
    // declared 1M — the number the dashboard shows.
    const window = effectiveContextWindow(1_048_576, env({}))
    const requested = maxOutputTokensFor('kimi-for-coding', window)
    const expected = Math.min(
      requested,
      window - (estimatedInputTokens(options as never) ?? 0) - CONTEXT_HEADROOM_TOKENS,
    )
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.max_completion_tokens).toBe(expected)
    expect(requested).toBe(window - CONTEXT_HEADROOM_TOKENS)
  })

  it('sizes it from the folded window when folding is on', async () => {
    vi.stubEnv('DSH_KIMI_CODE_BYTES_PER_TOKEN', '4')
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      return sseResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }))
    const { adapter } = await buildAdapter()
    const options = generateOptions('kimi-for-coding')
    for await (const _chunk of adapter.stream(options)) { /* drain one turn */ }

    const window = effectiveContextWindow(1_048_576, fold('4'))
    expect(window).toBe(524_288)
    expect(bodies[0]!.max_completion_tokens)
      .toBeLessThan(window)
    expect(bodies[0]!.max_completion_tokens)
      .toBe(Math.min(
        maxOutputTokensFor('kimi-for-coding', window),
        window - (estimatedInputTokens(options as never) ?? 0) - CONTEXT_HEADROOM_TOKENS,
      ))
  })

  it('agrees with the shipped catalog rows, folded or not', () => {
    // The static registry is what a deployment with no live listing falls back
    // on, so every row has to satisfy the same rule the adapter applies.
    for (const model of KIMI_CODE_MODELS) {
      expect(effectiveContextWindow(model.contextWindow, env({})), model.id)
        .toBe(model.contextWindow)
      expect(effectiveContextWindow(model.contextWindow, fold('4')), model.id)
        .toBe(Math.min(model.contextWindow, 524_288))
    }
  })
})

describe('a body the gateway refuses for its size', () => {
  /** The gateway's own wording for the 2 MB refusal, numbers included. */
  const GATEWAY_REFUSAL = 'Invalid request: total message size 5943865 exceeds limit 2097152'

  it('is recognized in the wording the gateway actually sends', () => {
    expect(isKimiBodySizeRefusal('total message size 5943865 exceeds limit 2097152')).toBe(true)
    expect(isKimiBodySizeRefusal(GATEWAY_REFUSAL)).toBe(true)
    // Case is not a contract the service keeps.
    expect(isKimiBodySizeRefusal('TOTAL MESSAGE SIZE 5943865 EXCEEDS LIMIT 2097152')).toBe(true)
  })

  it('is not confused with the token window or with an unrelated 400', () => {
    // The two refusals are different sentences, and only the numeric limit
    // distinguishes them from a format error.
    expect(isKimiBodySizeRefusal('invalid params, context window exceeds limit (2013)')).toBe(false)
    expect(isKimiBodySizeRefusal("This model's maximum context length is 1048576 tokens.")).toBe(false)
    expect(isKimiBodySizeRefusal('unsupported value for messages[0].role')).toBe(false)
    expect(isKimiBodySizeRefusal('')).toBe(false)
  })

  it('becomes a context overflow the host can recover from, and is still not retried', () => {
    const failure = classifyKimiFailure(400, JSON.stringify({ error: { message: GATEWAY_REFUSAL } }))
    expect(failure.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // A blind backoff would resend the identical bytes; the recovery is the
    // compaction-then-retry the host performs for this code.
    expect(failure.retryable).toBe(false)
    expect(failure.accountScoped).toBe(false)
    expect(failure.upstreamOverload).toBe(false)
    // The message has to name what actually happened: these are bytes, and the
    // model's token window may be nowhere near full.
    expect(failure.message).toMatch(/byte ceiling/)
    expect(failure.message).not.toMatch(/context window exceeded/i)
    expect(failure.message).toContain('5943865')
    expect(failure.message).toMatch(/compact the conversation|start a new session/i)
  })

  it('leaves an unrelated 400 a plain provider error', () => {
    const failure = classifyKimiFailure(400, JSON.stringify({
      error: { message: 'Invalid request: unsupported value for messages[0].role' },
    }))
    expect(failure.code).toBe('PROVIDER_ERROR')
    expect(failure.retryable).toBe(false)
  })

  it('keeps the over-window wordings on the code they already had', () => {
    // Nothing about the existing classification moved: only the byte sentence
    // was added to the same bucket.
    const realOverflow = classifyKimiFailure(400, JSON.stringify({
      error: { message: 'invalid params, context window exceeds limit (2013)' },
    }))
    expect(realOverflow.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(realOverflow.retryable).toBe(false)

    const maximumLength = classifyKimiFailure(400, JSON.stringify({
      error: { message: "This model's maximum context length is 1048576 tokens. However, you requested 1059229 tokens." },
    }))
    expect(maximumLength.code).toBe(CONTEXT_OVERFLOW_CODE)
  })
})

describe('the local body guard refuses in the code the host acts on', () => {
  /** ~2.1 MB of conversation, the size the reported session actually carried. */
  const textDominated = { messages: [{ role: 'user', content: 'x'.repeat(2_107_355) }], tools: [] }
  /** The same overflow, carried by one base64 image instead of prose. */
  const imageDominated = {
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2_100_000)}` } }],
    }],
    tools: [],
  }

  it('refuses a text-dominated body as CONTEXT_WINDOW_EXCEEDED', () => {
    let failure: { message: string; code?: string } | undefined
    try {
      assertRequestBodyFits(textDominated)
    } catch (error) {
      failure = capturedFailure(error)
    }
    expect(failure).toBeDefined()
    expect(failure!.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(failure!.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    // The composition and the prescription are the part the user reads, and they
    // are unchanged by the code moving.
    expect(failure!.message).toMatch(/serialized body is \d+ bytes/)
    expect(failure!.message).toMatch(/images 0 bytes, tool schemas \d+ bytes/)
    expect(failure!.message).toMatch(/compact the conversation/i)
  })

  it('refuses an image-dominated body under the same code', () => {
    let failure: { message: string; code?: string } | undefined
    try {
      assertRequestBodyFits(imageDominated)
    } catch (error) {
      failure = capturedFailure(error)
    }
    expect(failure!.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(failure!.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(failure!.message).toMatch(/Older images are omitted first/)
  })

  it('refuses the 2.1 MB request before it is ever sent, with that code', async () => {
    // The end-to-end shape of the reported failure: the adapter measures the
    // body, refuses locally, and DSH sees a code it can compact for. Before the
    // change this surfaced as PROVIDER_ERROR and ended the turn.
    //
    // Run on the 256K tier on purpose: 2.1 MB is over that tier's 2 MB ceiling,
    // while the 1M tier raised its own ceiling to 12 MiB, where this body fits
    // (see kimi-code-body-limit-per-model.test.ts). The behaviour under test —
    // refuse locally, with the recovery code, before fetch — is unchanged.
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('the guard must refuse before any request is sent')
    })
    const { adapter } = await buildAdapter({ fetchFn: fetchMock })
    const failure = await streamFailure(adapter.stream(generateOptions('k3-256k', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_107_355) }] } as never],
    })))
    expect(failure.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(failure.message).toMatch(/Kimi Code rejected the request before sending/)
    expect(failure.message).toMatch(/compact the conversation/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still accepts a body inside the ceiling', () => {
    const small = { messages: [{ role: 'user', content: 'hello' }], tools: [] }
    expect(() => assertRequestBodyFits(small)).not.toThrow()
    // The default window this line publishes is the one the constant is made of,
    // so the two cannot drift apart unnoticed.
    expect(DEFAULT_CONTEXT_WINDOW).toBe(262_144)
  })
})
