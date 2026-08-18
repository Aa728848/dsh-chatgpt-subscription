import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import { CODEX_IMAGE_GENERATION_URL, CODEX_IMAGE_MODEL, CODEX_IMAGE_TOOL_NAME } from '../src/compat.ts'
import { createCodexImageTool } from '../src/host/codex-images.ts'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

describe('Codex image tool', () => {
  it('requests a PNG, saves it as an attachment, and renders an image block', async () => {
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-id',
    })
    const oauth = new OAuthService(store)
    const fetchFn = vi.fn(async () => Response.json({ data: [{ b64_json: PNG_1X1 }] }))
    const saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
      attachmentId: 'image-1' as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 1,
      height: 1,
      name: input.name,
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 1_000_000,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 1_000_000,
        maxImagePixels: 4_000_000,
        mediaTypes: ['image/png'],
      },
      saveImage,
    } as unknown as AttachmentStore
    const tool = createCodexImageTool(oauth, attachments, { fetchFn: fetchFn as typeof fetch })
    const signal = new AbortController().signal

    const value = await tool.execute({ prompt: 'draw a small blue square' }, {
      callId: CallId('call-image'),
      rootCallId: CallId('call-image'),
      name: CODEX_IMAGE_TOOL_NAME,
      arguments: { prompt: 'draw a small blue square' },
      signal,
      token: Symbol('tool') as never,
      deferContext: vi.fn(),
      concludeTurn: vi.fn(),
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(CODEX_IMAGE_GENERATION_URL)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: 'draw a small blue square',
      model: CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    })
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'image/png',
      name: 'codex-generated-image.png',
    }))
    expect(value).toMatchObject({
      prompt: 'draw a small blue square',
      model: CODEX_IMAGE_MODEL,
      image: { attachmentId: 'image-1', mediaType: 'image/png', width: 1, height: 1 },
    })
    expect(tool.output.render({ prompt: 'draw a small blue square' }, value as never)).toContainEqual({
      type: 'image',
      attachment: expect.objectContaining({ attachmentId: 'image-1' }),
    })
    oauth.dispose()
  })
})
