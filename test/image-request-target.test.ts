import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { KimiCodeAdapter } from '../src/host/kimi-code/adapter.ts'
import { MinimaxCodeAdapter } from '../src/host/minimax-code/adapter.ts'
import { StepCodeAdapter } from '../src/host/step-code/adapter.ts'

const large = {
  attachmentId: 'large', mediaType: 'image/png', bytes: 5_000_000, width: 2048, height: 1024,
} as ImageAttachmentRef
const small = {
  attachmentId: 'small', mediaType: 'image/png', bytes: 100_000, width: 800, height: 600,
} as ImageAttachmentRef

/**
 * The shared 1024 px long edge every route but kimi-code asks for.
 *
 * kimi-code mirrors its own CLI's 2000 px default, so it is the one row whose
 * dimensions differ; the 256 KiB encoded-byte target stays shared, which is why
 * the per-image budget and the body-fit guard are unaffected.
 */
const SHARED_LARGE_TARGET = { width: 1024, height: 512, maxPixels: 524_288, maxBytes: 256 * 1024 }
const KIMI_LARGE_TARGET = { width: 2000, height: 1000, maxPixels: 2_000_000, maxBytes: 256 * 1024 }

describe('adapter image request targets', () => {
  for (const [provider, model, adapter, largeTarget] of [
    ['antigravity', 'gemini-3.7-flash', new AntigravityAdapter(), SHARED_LARGE_TARGET],
    ['kimi-code', 'k3', new KimiCodeAdapter(), KIMI_LARGE_TARGET],
    ['minimax-code', 'MiniMax-M3.1-Flash', new MinimaxCodeAdapter(), SHARED_LARGE_TARGET],
    ['step-code', 'step-3.5-flash', new StepCodeAdapter(), SHARED_LARGE_TARGET],
  ] as const) {
    it(`${provider} reports the same downscaled target its mapper sends`, () => {
      expect(adapter.imageRequestTarget(provider, model, large)).toEqual(largeTarget)
    })

    it(`${provider} preserves an image that already fits`, () => {
      expect(adapter.imageRequestTarget(provider, model, small)).toEqual({
        width: 800, height: 600, maxBytes: 100_000,
      })
    })
  }
})
