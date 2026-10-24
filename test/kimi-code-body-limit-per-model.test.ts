/**
 * Why the Kimi Code request-body ceiling is graded by model, and what each tier is.
 *
 * One 2,097,152-byte ceiling used to cover every model on this line. That figure
 * comes from the gateway's generic error example and was never measured against a
 * 1M window; the official kimi-cli ships no byte guard at all, so the ceiling is
 * this plugin's own safety net rather than something the endpoint requires. On the
 * 1M tier it was actively harmful: a 3-4 MB Chinese session was refused locally,
 * and the compaction meant to rescue it could not fit either.
 *
 * So the text/image tier is now graded: 1M models get 8 MiB, the 256K models keep
 * 2 MiB where the window and the ceiling line up. 8 MiB is sized so bytes never
 * become the binding limit for a 1M session — that window's body is roughly 4 MB
 * of English or 4.5 MB of dense Chinese — which leaves the model's own token
 * window as what actually stops a session (see
 * {@link LONG_CONTEXT_MESSAGE_BODY_BYTES}).
 *
 * DSH_KIMI_CODE_MAX_BODY_BYTES stays a GLOBAL override and outranks every tier, and
 * a value that is not a positive number falls through to the model's own default
 * instead of switching the guard off. The video tier (64 MiB) is untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_MAX_MESSAGE_BODY_BYTES,
  LONG_CONTEXT_MESSAGE_BODY_BYTES,
  maxMessageBodyBytes,
  maxRequestBodyBytesFor,
} from '../src/host/kimi-code/types.ts'
import { KIMI_CODE_MODELS, kimiCodeModelDef } from '../src/host/kimi-code/model-catalog.ts'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { assertRequestBodyFits } from '../src/host/kimi-code/mapper.ts'
import { clearCachedCatalog } from '../src/host/kimi-code/client.ts'
import { FileCredentialStore, FileModelSettingsStore } from '../src/host/kimi-code/token-store.ts'
import type { KimiCodeCatalogModel, KimiCodeCredentials } from '../src/host/kimi-code/token-store.ts'
import { CONTEXT_OVERFLOW_CODE } from '../src/host/common/context-overflow.ts'
import { MAX_MESSAGE_BODY_BYTES, MAX_VIDEO_MESSAGE_BODY_BYTES } from '../src/host/common/request-images.ts'

const MIB = 1024 * 1024

/** A stand-in environment, so a developer's own override cannot leak in. */
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

/**
 * The live catalog shape the adapter actually holds.
 *
 * Deliberately WITHOUT `maxRequestBodyBytes`: /v1/models reports capabilities and
 * never a deployment's byte headroom, so the tier has to be resolved from the model
 * id. A catalog row that carried the field would let a broken resolver pass.
 */
const CATALOG: KimiCodeCatalogModel[] = [
  { id: 'k3.1-pro', name: 'K3.1 Pro', contextWindow: 262_144 },
  { id: 'k3-256k', name: 'K3 (256K)', contextWindow: 262_144 },
]

/** 3.5 MB: over the old ceiling, well under the raised one, and what a 1M session costs. */
const THREE_AND_A_HALF_MB = Math.ceil(3.5 * MIB)

/** 4.5 MB: the dense-Chinese body a full 1M window produces. */
const FOUR_AND_A_HALF_MB = Math.ceil(4.5 * MIB)

/** 8.5 MB: past the raised ceiling, so the guard (not the window) is what answers. */
const EIGHT_AND_A_HALF_MB = Math.ceil(8.5 * MIB)

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

async function buildAdapter(options: { fetchFn?: typeof fetch; videoBytes?: number } = {}) {
  const store = new FileCredentialStore(tmp('kc-tier-cred'))
  vi.spyOn(store, 'read').mockResolvedValue(credentials())
  vi.spyOn(store, 'write').mockResolvedValue(undefined)
  const modelSettings = new FileModelSettingsStore(tmp('kc-tier-models'))
  vi.spyOn(modelSettings, 'read').mockResolvedValue({
    enabled: true,
    enabledModelIds: CATALOG.map((model) => model.id),
    catalogModels: [],
    contextWindowOverrides: {},
    defaultReasoningEffort: null,
    cacheTtl: null,
  })
  const videoBytes = options.videoBytes
  const videos = videoBytes === undefined
    ? undefined
    : { readVideo: async () => ({ data: new Uint8Array(videoBytes), mediaType: 'video/mp4' }) }
  const adapter = new KimiCodeAdapter(store, modelSettings, undefined, {
    fetchFn: options.fetchFn,
    videos,
    loadCatalog: async () => CATALOG,
  })
  return { adapter }
}

/** Minimal OpenAI-compatible stream: one token, then the stop frame. */
function sseResponse(frames: unknown[]): Response {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) controller.enqueue(bytes.slice(offset, offset + 5))
      controller.close()
    },
  }))
}

function generateOptions(
  model: string,
  size: { textBytes?: number; videoBytes?: number },
): GenerateOptions {
  const content: Record<string, unknown>[] = []
  if (size.textBytes !== undefined) {
    content.push({ type: 'text', text: 'x'.repeat(size.textBytes) })
  }
  if (size.videoBytes !== undefined) {
    content.push({
      type: 'video',
      attachment: { attachmentId: 'v1', mediaType: 'video/mp4', bytes: size.videoBytes, name: 'demo.mp4' },
    })
  }
  return { model, messages: [{ role: 'user', content } as never] } as unknown as GenerateOptions
}

interface TurnResult {
  readonly failure?: { message: string; code?: string }
  readonly fetchMock: ReturnType<typeof vi.fn>
  /** Serialized size of every body that reached fetch, in send order. */
  readonly sentBytes: number[]
}

/**
 * Run one whole turn through the adapter with a mocking fetch.
 *
 * The failure is RETURNED rather than thrown so a test can assert on the code and
 * the message, which is where this route states the ceiling it applied.
 */
async function runTurn(
  model: string,
  size: { textBytes?: number; videoBytes?: number; env?: Record<string, string> },
): Promise<TurnResult> {
  for (const [name, value] of Object.entries(size.env ?? {})) vi.stubEnv(name, value)
  const sentBytes: number[] = []
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    sentBytes.push(Buffer.byteLength(String(init?.body ?? ''), 'utf8'))
    return sseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
  })
  const { adapter } = await buildAdapter({ fetchFn: fetchMock, videoBytes: size.videoBytes })
  const request = generateOptions(model, size)
  try {
    for await (const _chunk of adapter.stream(request)) { /* the verdict is the point */ }
    return { fetchMock, sentBytes }
  } catch (error) {
    const failure = error as { message?: unknown; code?: unknown }
    return {
      failure: {
        message: typeof failure.message === 'string' ? failure.message : String(error),
        code: typeof failure.code === 'string' ? failure.code : undefined,
      },
      fetchMock,
      sentBytes,
    }
  }
}

afterEach(() => {
  clearCachedCatalog()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('each catalog row states its own request-body ceiling', () => {
  it('gives the 1M tier 8 MiB and leaves the 256K tier on 2 MiB', () => {
    const expected = new Map<string, number>([
      ['k3', 8_388_608],
      ['k3.1-pro', 8_388_608],
      ['k3.1-pro-highspeed', 8_388_608],
      ['kimi-for-coding', 8_388_608],
      ['k3-256k', 2_097_152],
      ['kimi-for-coding-highspeed', 2_097_152],
    ])
    // Every shipped row is covered, so a model added later cannot silently inherit
    // whichever tier the resolver falls back to.
    expect(KIMI_CODE_MODELS.map((model) => model.id).sort()).toEqual([...expected.keys()].sort())
    for (const model of KIMI_CODE_MODELS) {
      expect(model.maxRequestBodyBytes, model.id).toBe(expected.get(model.id))
    }
    // The 1M figure is the named constant, not a literal that could drift from it.
    expect(LONG_CONTEXT_MESSAGE_BODY_BYTES).toBe(8 * MIB)
    expect(LONG_CONTEXT_MESSAGE_BODY_BYTES).toBe(8_388_608)
  })

  it('leaves headroom over both 1M body densities, so bytes are not the binding limit', () => {
    // A full 1M window is roughly 4 MB of English or 4.5 MB of dense Chinese. Both
    // fit under 8 MiB with room to spare, which is the whole point of the number:
    // what stops a 1M session is the model's token window (the service answers
    // "Your request exceeded model token limit", normalized to the same recovery
    // code), not this byte guard.
    const englishBytes = 4 * MIB
    const denseChineseBytes = FOUR_AND_A_HALF_MB
    expect(englishBytes).toBeLessThan(LONG_CONTEXT_MESSAGE_BODY_BYTES)
    expect(denseChineseBytes).toBeLessThan(LONG_CONTEXT_MESSAGE_BODY_BYTES)
    // ... and the old 2 MB ceiling was under BOTH, which is why a 1M session met it.
    expect(englishBytes).toBeGreaterThan(2 * MIB)
    expect(denseChineseBytes).toBeGreaterThan(2 * MIB)
  })
})

describe('maxRequestBodyBytesFor resolves env, then the model, then the shared floor', () => {
  it('reads the tier off the model row', () => {
    expect(maxRequestBodyBytesFor(kimiCodeModelDef('k3.1-pro'), env({}))).toBe(8_388_608)
    expect(maxRequestBodyBytesFor(kimiCodeModelDef('k3'), env({}))).toBe(8_388_608)
    expect(maxRequestBodyBytesFor(kimiCodeModelDef('k3-256k'), env({}))).toBe(2_097_152)
    expect(maxRequestBodyBytesFor(kimiCodeModelDef('kimi-for-coding-highspeed'), env({}))).toBe(2_097_152)
  })

  it('keeps the model-less contract on the shared 2 MiB constant', () => {
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBe(MAX_MESSAGE_BODY_BYTES)
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBe(2_097_152)
    // An id the registry does not know inherits the conservative floor rather than
    // a long-context allowance nothing has vouched for.
    expect(maxRequestBodyBytesFor(undefined, env({}))).toBe(2_097_152)
    expect(maxRequestBodyBytesFor(kimiCodeModelDef('k3.5-unreleased'), env({}))).toBe(2_097_152)
    // The pre-existing resolver is untouched, because other paths read it.
    expect(maxMessageBodyBytes(env({}))).toBe(2_097_152)
  })

  it('lets the deployment override outrank every tier, in both directions', () => {
    const wide = kimiCodeModelDef('k3.1-pro')
    const narrow = kimiCodeModelDef('k3-256k')
    expect(maxRequestBodyBytesFor(wide, env({ DSH_KIMI_CODE_MAX_BODY_BYTES: '2097152' }))).toBe(2_097_152)
    expect(maxRequestBodyBytesFor(narrow, env({ DSH_KIMI_CODE_MAX_BODY_BYTES: '16777216' }))).toBe(16_777_216)
    // Whitespace is tolerated and a fraction is floored, like the sibling resolvers.
    expect(maxRequestBodyBytesFor(wide, env({ DSH_KIMI_CODE_MAX_BODY_BYTES: ' 4194304 ' }))).toBe(4_194_304)
    expect(maxRequestBodyBytesFor(wide, env({ DSH_KIMI_CODE_MAX_BODY_BYTES: '4194304.9' }))).toBe(4_194_304)
  })

  it('falls through to the model default for a value that would disable the guard', () => {
    for (const raw of ['', '   ', 'abc', '0', '-1', '-2097152', 'NaN', 'huge']) {
      expect(
        maxRequestBodyBytesFor(kimiCodeModelDef('k3.1-pro'), env({ DSH_KIMI_CODE_MAX_BODY_BYTES: raw })),
        raw,
      ).toBe(8_388_608)
      expect(
        maxRequestBodyBytesFor(kimiCodeModelDef('k3-256k'), env({ DSH_KIMI_CODE_MAX_BODY_BYTES: raw })),
        raw,
      ).toBe(2_097_152)
    }
  })
})

describe('a 3.5 MB session is sent on the 1M tier and refused on the 256K tier', () => {
  it('sends it on k3.1-pro', async () => {
    const turn = await runTurn('k3.1-pro', { textBytes: THREE_AND_A_HALF_MB })
    expect(turn.failure).toBeUndefined()
    expect(turn.fetchMock).toHaveBeenCalledTimes(1)
    // The body really is over the old ceiling: this is the raised tier at work,
    // not a request that would have fit anyway.
    expect(turn.sentBytes[0]).toBeGreaterThan(2_097_152)
  })

  it('refuses it on k3-256k before any request is sent', async () => {
    const turn = await runTurn('k3-256k', { textBytes: THREE_AND_A_HALF_MB })
    expect(turn.fetchMock).not.toHaveBeenCalled()
    expect(turn.failure?.code).toBe(CONTEXT_OVERFLOW_CODE)
    // The refusal quotes the ceiling it applied, and that ceiling is the 2 MB one.
    expect(turn.failure?.message).toContain('2097152')
    expect(turn.failure?.message).toContain('Kimi Code rejected the request before sending')
  })
})

describe('the 8 MiB ceiling covers a full 1M body and refuses what is past it', () => {
  it('sends a 4.5 MB body on k3.1-pro', async () => {
    const turn = await runTurn('k3.1-pro', { textBytes: FOUR_AND_A_HALF_MB })
    expect(turn.failure).toBeUndefined()
    expect(turn.fetchMock).toHaveBeenCalledTimes(1)
    // A full dense-Chinese 1M body goes out, well past the old 2 MB ceiling.
    expect(turn.sentBytes[0]).toBeGreaterThan(2 * MIB)
  })

  it('refuses an 8.5 MB body on k3.1-pro and names the new ceiling', async () => {
    const turn = await runTurn('k3.1-pro', { textBytes: EIGHT_AND_A_HALF_MB })
    expect(turn.fetchMock).not.toHaveBeenCalled()
    expect(turn.failure?.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(turn.failure?.message).toContain('8388608')
  })
})

describe('the deployment override still wins end to end', () => {
  it('puts the 1M tier back on 2 MiB when the deployment pins its own measured figure', async () => {
    const turn = await runTurn('k3.1-pro', {
      textBytes: THREE_AND_A_HALF_MB,
      env: { DSH_KIMI_CODE_MAX_BODY_BYTES: '2097152' },
    })
    expect(turn.fetchMock).not.toHaveBeenCalled()
    expect(turn.failure?.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(turn.failure?.message).toContain('2097152')
  })

  it('still refuses an over-limit body when the override is a typo', async () => {
    // The one failure this variable must never cause: a bad value turning the
    // guard off. It falls through to the model's own tier instead.
    const turn = await runTurn('k3.1-pro', {
      textBytes: EIGHT_AND_A_HALF_MB,
      env: { DSH_KIMI_CODE_MAX_BODY_BYTES: 'abc' },
    })
    expect(turn.fetchMock).not.toHaveBeenCalled()
    expect(turn.failure?.code).toBe(CONTEXT_OVERFLOW_CODE)
    expect(turn.failure?.message).toContain('8388608')
  })
})

describe('a video request keeps its own 64 MiB tier', () => {
  it('sends a 13 MB clip on the 1M tier, which the text ceiling would refuse', async () => {
    const turn = await runTurn('k3.1-pro', { videoBytes: 13 * MIB })
    expect(turn.failure).toBeUndefined()
    expect(turn.fetchMock).toHaveBeenCalledTimes(1)
    // Base64 inflates by 4/3, so the serialized body is far past BOTH text tiers:
    // only the video budget can have accepted it.
    expect(turn.sentBytes[0]).toBeGreaterThan(8 * MIB)
    expect(MAX_VIDEO_MESSAGE_BODY_BYTES).toBe(64 * MIB)
  })

  it('leaves the text tier alone for the same bytes without video', () => {
    // The tier choice is stated by the caller and never sniffed from the body, so
    // the same body passes as video and is refused as text under the 2 MB default.
    const body = { model: 'k3.1-pro', messages: [{ role: 'user', content: 'x'.repeat(13 * MIB) }] }
    expect(() => assertRequestBodyFits(body, true)).not.toThrow()
    expect(() => assertRequestBodyFits(body, false)).toThrow(/2097152-byte limit/)
  })
})

describe('the guard contract is unchanged for callers that pass no limit', () => {
  it('still measures against 2 MiB with no arguments', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(THREE_AND_A_HALF_MB) }] }
    // 3.5 MB fits on both model tiers, so the model-less default is the only
    // ceiling that can refuse it — and it must stay at 2 MB.
    expect(() => assertRequestBodyFits(body)).toThrow(/2097152-byte limit/)
    expect(() => assertRequestBodyFits({ messages: [] })).not.toThrow()
  })

  it('honours an explicitly passed limit, and names it in the refusal', () => {
    const body = { messages: [{ role: 'user', content: 'x'.repeat(MIB) }] }
    expect(() => assertRequestBodyFits(body, false, undefined, 1_048_576)).toThrow(/1048576-byte limit/)
    expect(() => assertRequestBodyFits(body, false, undefined, 8_388_608)).not.toThrow()
  })
})
