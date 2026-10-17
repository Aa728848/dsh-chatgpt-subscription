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

describe('adapter image request targets', () => {
  for (const [provider, model, adapter] of [
    ['antigravity', 'gemini-3.7-flash', new AntigravityAdapter()],
    ['kimi-code', 'k3', new KimiCodeAdapter()],
    ['minimax-code', 'MiniMax-M3.1-Flash-Preview', new MinimaxCodeAdapter()],
    ['step-code', 'step-3.5-flash', new StepCodeAdapter()],
  ] as const) {
    it(`${provider} reports the same downscaled target its mapper sends`, () => {
      expect(adapter.imageRequestTarget(provider, model, large)).toEqual({
        width: 1024, height: 512, maxPixels: 524_288, maxBytes: 256 * 1024,
      })
    })

    it(`${provider} preserves an image that already fits`, () => {
      expect(adapter.imageRequestTarget(provider, model, small)).toEqual({
        width: 800, height: 600, maxBytes: 100_000,
      })
    })
  }
})
