// @vitest-environment jsdom
/**
 * 侧边栏视频渲染器：定义形状 + 16:9 视频台。
 *
 * 定义那一半是**契约**：`priority: 'extension'` 决定外部实现压过内置实现，
 * `binaryExtensions` 漏一个后缀，`register` 就会直接抛（它要求前者是
 * `extensions` 的子集）。所以这里逐项断言形状，而不是只断言「注册过」。
 *
 * 组件那一半只有两个会失败的地方：地址解析与字节通道。两者都钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxVideoDocumentBody, sessionFileOf } from '../src/client/minimax-code/MinimaxVideoDocumentBody.tsx'
import { MINIMAX_VIDEO_EXTENSIONS, MINIMAX_VIDEO_PREVIEW_ID, minimaxVideoPreviewDefinition } from '../src/client/minimax-code/document-preview.ts'
import { zh } from '../src/client/minimax-code/locales.ts'
import { MINIMAX_VIDEO_TOOL_NAME, WORKSPACE_FILE_TOO_LARGE } from '../src/client/minimax-code/video-contract.ts'

const ADDRESS = 'dsh-resource://file/session/session-1/clips/out.mp4'

/**
 * 远端失败的形状：`{ code, details }`，与宿主 `RemoteError` 一致（它就是个带
 * `code` / `details` 的 `Error`）。判定方只看字段，所以这里也用字段拼。
 *
 * @param code - 远端码。
 * @param details - 该码的结构化载荷。
 * @returns 一次失败的替身。
 */
function remoteFailure(code: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, details })
}

describe('minimax video document preview definition', () => {
  it('declares the four suffixes and the external-priority band', () => {
    const definition = minimaxVideoPreviewDefinition(() => 'Video')
    expect(definition.id).toBe('@eddyskywalker/dsh-chatgpt-subscription/video')
    expect(definition.extensions).toEqual(['mp4', 'webm', 'mov', 'm4v'])
    expect(definition.priority).toBe('extension')
  })

  it('reads its bytes as a complete file and never as text', () => {
    const definition = minimaxVideoPreviewDefinition(() => 'Video')
    expect(definition.loading).toBe('bytes-complete')
    expect(definition.wrap).toBe(false)
  })

  it('declares every suffix binary, since none of them is readable text', () => {
    const definition = minimaxVideoPreviewDefinition(() => 'Video')
    // `register` rejects a binary suffix outside `extensions`; this is the
    // superset check that would otherwise throw at load.
    expect([...definition.binaryExtensions].sort()).toEqual([...definition.extensions].sort())
    expect(definition.binaryExtensions).toHaveLength(MINIMAX_VIDEO_EXTENSIONS.length)
  })

  it('keeps the title lazy, so switching language needs no re-registration', () => {
    let current = 'Video'
    const definition = minimaxVideoPreviewDefinition(() => current)
    expect(definition.title()).toBe('Video')
    current = '视频'
    expect(definition.title()).toBe('视频')
  })

  it('uses one identity for the definition and the keyed body slot', () => {
    expect(minimaxVideoPreviewDefinition(() => 'Video').id).toBe(MINIMAX_VIDEO_PREVIEW_ID)
    // The card and the sidebar are two faces of the same tool.
    expect(MINIMAX_VIDEO_TOOL_NAME).toBe('minimax_generate_video')
  })
})

describe('sessionFileOf', () => {
  it('reads the session and the path out of a session file address', () => {
    expect(sessionFileOf(ADDRESS)).toEqual({ sessionId: 'session-1', path: 'clips/out.mp4' })
  })

  it('decodes encoded segments and keeps a drive letter literal', () => {
    expect(sessionFileOf('dsh-resource://file/session/s%201/C%3A/clip%20one.mp4'))
      .toEqual({ sessionId: 's 1', path: 'C:/clip one.mp4' })
  })

  it('refuses an address that carries no session', () => {
    expect(sessionFileOf('dsh-resource://file/absolute/C:/clip.mp4')).toBeUndefined()
    expect(sessionFileOf(undefined)).toBeUndefined()
    expect(sessionFileOf('https://example.com/a.mp4')).toBeUndefined()
    expect(sessionFileOf('dsh-resource://file/session/session-1')).toBeUndefined()
  })
})

describe('MinimaxVideoDocumentBody', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  async function render(readVideo: (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>) {
    await act(async () => {
      root.render(createElement(MinimaxVideoDocumentBody, {
        resourceAddress: ADDRESS,
        readVideo,
        t: (key: keyof typeof zh) => zh[key],
      }))
    })
  }

  it('renders the 16:9 stage with a controllable video element', async () => {
    await render(async () => new Uint8Array([0, 1, 2, 3]))
    const stage = container.querySelector('.dshm-video-stage')
    expect(stage?.getAttribute('data-state')).toBe('ready')
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe('blob:mock-preview')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(video?.getAttribute('preload')).toBe('metadata')
    // The quiet metadata row names the file and its size.
    expect(container.querySelector('.dshm-video-doc-name')?.textContent).toBe('out.mp4')
    expect(container.querySelector('.dshm-video-doc-size')?.textContent).toBe('4 B')
  })

  it('reads through the session and path the address names', async () => {
    const readVideo = vi.fn(async () => new Uint8Array([1]))
    await render(readVideo)
    expect(readVideo).toHaveBeenCalledWith('session-1', 'clips/out.mp4', expect.anything())
  })

  it('keeps the stage and shows the failure when the bytes cannot be read', async () => {
    await render(async () => { throw new Error('workspace-file/not-found') })
    expect(container.querySelector('video')).toBeNull()
    const stage = container.querySelector('.dshm-video-stage')
    expect(stage?.getAttribute('data-state')).toBe('empty')
    expect(container.querySelector('.dshm-video-placeholder')?.getAttribute('data-tone')).toBe('danger')
    expect(container.textContent).toContain(zh.videoUnreadable)
  })


  it('says the video is too large, with the cap, instead of "missing"', async () => {
    // The sidebar used to print the exact same line for a 40 MB file as for a
    // deleted one: the read failed, so the file must have moved. It had not.
    await render(async () => { throw remoteFailure(WORKSPACE_FILE_TOO_LARGE, { path: 'clips/out.mp4', limit: 33_554_432 }) })
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    expect(placeholder?.textContent).toBe(zh.videoTooLarge.replace('{limit}', '32 MB'))
    expect(placeholder?.textContent).toContain('32 MB')
    expect(container.textContent).not.toContain(zh.videoUnreadable)
    expect(container.textContent).not.toMatch(/moved or deleted|移动或删除/)
    // The stage survives either way; only the line changes.
    expect(container.querySelector('.dshm-video-stage')?.getAttribute('data-state')).toBe('empty')
  })

  it('keeps the "moved or deleted" line for every other failure code', async () => {
    for (const code of ['workspace-file/not-found', 'workspace-file/not-regular-file', 'gateway/internal']) {
      await act(async () => root.unmount())
      root = createRoot(container)
      await render(async () => { throw remoteFailure(code) })
      expect(container.querySelector('.dshm-video-placeholder')?.textContent).toBe(zh.videoUnreadable)
    }
  })

  it('shows a dash rather than a wrong cap when the failure omits the limit', async () => {
    // A malformed failure must never be reclassified, and above all must not
    // print an invented number where the Host’s cap belongs.
    await render(async () => { throw remoteFailure(WORKSPACE_FILE_TOO_LARGE) })
    expect(container.querySelector('.dshm-video-placeholder')?.textContent)
      .toBe(zh.videoTooLarge.replace('{limit}', '—'))
  })
  it('shows the quiet reading line while the bytes are still on the way', async () => {
    // A reader that never settles: the stage must not sit blank or spin.
    await render(() => new Promise<Uint8Array>(() => {}))
    expect(container.querySelector('.dshm-video-placeholder')?.getAttribute('data-tone')).toBe('quiet')
    expect(container.textContent).toContain(zh.videoReading)
    expect(container.querySelector('.dshm-video-doc-meta')).toBeNull()
  })

  it('revokes the object URL when the tab closes', async () => {
    await render(async () => new Uint8Array([9]))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview')
    root = createRoot(container)
  })
})
