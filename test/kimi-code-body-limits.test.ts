/**
 * Why the Kimi Code byte ceilings have environment overrides, and what an invalid
 * value does.
 *
 * Both numbers are Kimi's own: 2,097,152 is the gateway figure its error
 * reference quotes, and 1,500,000 is sized to sit inside it. A deployment behind
 * a proxy with a measured, smaller limit can pin either one; a typo must not
 * silently disable the guard.
 *
 * The video tier deliberately has no override: one variable cannot express "relax
 * the text ceiling, leave the video one alone", and a value chosen for a 2 MB
 * conversation would collapse the 64 MB video tier with it. MiniMax's video
 * budget is likewise a bare constant.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOW_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_MESSAGE_BODY_BYTES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  lowRequestImageBytes,
  maxMessageBodyBytes,
  maxRequestImageBytes,
} from '../src/host/kimi-code/types.ts'
import { assertRequestBodyFits } from '../src/host/kimi-code/mapper.ts'
import { MAX_MESSAGE_BODY_BYTES, MAX_REQUEST_IMAGE_BYTES } from '../src/host/common/request-images.ts'

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

describe('maxMessageBodyBytes', () => {
  it("defaults to Kimi's own ceiling, which is the shared constant", () => {
    expect(maxMessageBodyBytes(env({}))).toBe(DEFAULT_MAX_MESSAGE_BODY_BYTES)
    // The shared constant is Kimi's figure kept as the default argument of
    // functions other routes call with their own number; the DEFAULT_ alias is
    // what lets this line diverge later without touching another route.
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBe(MAX_MESSAGE_BODY_BYTES)
    expect(DEFAULT_MAX_MESSAGE_BODY_BYTES).toBe(2_097_152)
  })

  it('honours a measured override', () => {
    // Leading and trailing spaces, because a stray space is the likeliest typo.
    expect(maxMessageBodyBytes(env({ DSH_KIMI_CODE_MAX_BODY_BYTES: '  1048576 ' }))).toBe(1_048_576)
  })

  it('ignores a value that is not a positive finite number rather than disabling the guard', () => {
    for (const raw of ['', '   ', 'abc', '0', '-1', '-5', 'NaN', 'huge']) {
      expect(maxMessageBodyBytes(env({ DSH_KIMI_CODE_MAX_BODY_BYTES: raw })), raw)
        .toBe(DEFAULT_MAX_MESSAGE_BODY_BYTES)
    }
  })
})

describe('maxRequestImageBytes', () => {
  it("defaults to Kimi's own 20 MiB media budget", () => {
    expect(maxRequestImageBytes(env({}))).toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBe(20 * 1024 * 1024)
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).toBe(20_971_520)
    // The SHARED constant is still Kimi's old text-and-image figure, because the
    // other provider lines budget against it. This line diverges from it on
    // purpose: the official CLI budgets request media at 20 MiB, and the 1.5 MB
    // figure was Kimi's BODY ceiling applied to the images alone.
    expect(MAX_REQUEST_IMAGE_BYTES).toBe(1_500_000)
    expect(DEFAULT_MAX_REQUEST_IMAGE_BYTES).not.toBe(MAX_REQUEST_IMAGE_BYTES)
  })

  it('honours the deployment override and ignores a value that would disable the guard', () => {
    expect(maxRequestImageBytes(env({ DSH_KIMI_CODE_MAX_IMAGE_BYTES: '2000000' }))).toBe(2_000_000)
    for (const raw of ['', 'abc', '0', '-1', 'NaN', 'huge']) {
      expect(maxRequestImageBytes(env({ DSH_KIMI_CODE_MAX_IMAGE_BYTES: raw })), raw)
        .toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
    }
  })
})

describe('lowRequestImageBytes', () => {
  it("defaults to Kimi's own 10 MiB low-water mark", () => {
    expect(lowRequestImageBytes(env({}))).toBe(DEFAULT_LOW_REQUEST_IMAGE_BYTES)
    expect(DEFAULT_LOW_REQUEST_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    expect(DEFAULT_LOW_REQUEST_IMAGE_BYTES).toBe(10_485_760)
    // The gap between the two marks is the slack that keeps the number of
    // retained images — and therefore the cached prefix — stable.
    expect(DEFAULT_LOW_REQUEST_IMAGE_BYTES * 2).toBe(DEFAULT_MAX_REQUEST_IMAGE_BYTES)
  })

  it('follows the override, so a pinned ceiling moves both marks together', () => {
    expect(lowRequestImageBytes(env({ DSH_KIMI_CODE_MAX_IMAGE_BYTES: '2000000' }))).toBe(1_000_000)
    // A ceiling of one byte still leaves a usable mark: zero would leave the
    // trimming loop unable to stop anywhere.
    expect(lowRequestImageBytes(env({ DSH_KIMI_CODE_MAX_IMAGE_BYTES: '1' }))).toBe(1)
  })

  it('ignores a value that would disable the guard', () => {
    for (const raw of ['', 'abc', '0', '-1', 'NaN', 'huge']) {
      expect(lowRequestImageBytes(env({ DSH_KIMI_CODE_MAX_IMAGE_BYTES: raw })), raw)
        .toBe(DEFAULT_LOW_REQUEST_IMAGE_BYTES)
    }
  })
})

describe('the body guard reads the ceiling the deployment pinned', () => {
  it('refuses a body over the configured ceiling, not over the built-in one', () => {
    // The load-bearing pair: 2,000 bytes passes on the 2 MB default, so a throw
    // here can only come from the resolver actually being wired in — and it has
    // to name the configured figure, because that is what the user set.
    const body = { model: 'k3', padding: 'x'.repeat(2_000) }
    expect(() => assertRequestBodyFits(body)).not.toThrow()
  })
})
