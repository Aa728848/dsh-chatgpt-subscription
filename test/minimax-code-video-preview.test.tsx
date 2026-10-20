// @vitest-environment jsdom
/**
 * 侧边栏视频渲染器：定义形状 + 16:9 视频台。
 *
 * 定义那一半是**契约**：`priority: 'extension'` 决定外部实现压过内置实现，
 * `binaryExtensions` 漏一个后缀，`register` 就会直接抛（它要求前者是
 * `extensions` 的子集）。所以这里逐项断言形状，而不是只断言「注册过」。
 *
 * 组件那一半只有两个会失败的地方：地址解析与字节的**来路**。字节由宿主读好
 * 再从 keyed 槽的 `content` 交下来（定义声明的是 `loading: 'bytes-complete'`），
 * 所以这里钉的是「消费宿主交下来的那一段」，而不是「自己去读一遍」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxVideoDocumentBody, sessionFileOf } from '../src/client/minimax-code/MinimaxVideoDocumentBody.tsx'
import { MINIMAX_VIDEO_EXTENSIONS, MINIMAX_VIDEO_PREVIEW_ID, minimaxVideoPreviewDefinition } from '../src/client/minimax-code/document-preview.ts'
import { zh } from '../src/client/minimax-code/locales.ts'
import { MINIMAX_VIDEO_TOOL_NAME } from '../src/client/minimax-code/video-contract.ts'

const ADDRESS = 'dsh-resource://file/session/session-1/clips/out.mp4'

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

  /**
   * 渲染一次。
   *
   * `content` 就是宿主交下来的那段内容：定义声明 `loading: 'bytes-complete'`，
   * 所以宿主替这个实现把整段文件读好，再从 keyed 槽的 `content` 交下来。
   * 正文**不再自己读**——自己读要把同一段字节在 RPC 上再传一次。
   */
  async function render(content?: { readonly kind?: string, readonly data?: Uint8Array }) {
    await act(async () => {
      root.render(createElement(MinimaxVideoDocumentBody, {
        resourceAddress: ADDRESS,
        content,
        t: (key: keyof typeof zh) => zh[key],
      }))
    })
  }

  it('renders the 16:9 stage with a controllable video element', async () => {
    await render({ kind: 'bytes', data: new Uint8Array([0, 1, 2, 3]) })
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

  it('reads no file of its own: the Host already delivered the bytes', async () => {
    // 曾经这里自己去读 `workspaceFiles.readBytes`，而那条远端把结果装成
    // { ok, value }：字节永远是 undefined，右侧栏于是放不出画面。
    await render({ kind: 'bytes', data: new Uint8Array([1]) })
    expect(container.querySelector('video')).not.toBeNull()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('shows the quiet reading line while the bytes are still on the way', async () => {
    // 宿主还没把字节交下来：视频台不能空着，也不能装作已经拿到了。
    await render(undefined)
    expect(container.querySelector('.dshm-video-placeholder')?.getAttribute('data-tone')).toBe('quiet')
    expect(container.textContent).toContain(zh.videoReading)
    expect(container.querySelector('.dshm-video-doc-meta')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })

  it('keeps the stage and says the bytes cannot be opened when the blob fails', async () => {
    URL.createObjectURL = vi.fn(() => { throw new Error('blob refused') })
    await render({ kind: 'bytes', data: new Uint8Array([1]) })
    expect(container.querySelector('video')).toBeNull()
    const stage = container.querySelector('.dshm-video-stage')
    expect(stage?.getAttribute('data-state')).toBe('empty')
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    expect(placeholder?.textContent).toBe(zh.videoUnplayable)
  })

  it('revokes the object URL when the tab closes', async () => {
    await render({ kind: 'bytes', data: new Uint8Array([9]) })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-preview')
    root = createRoot(container)
  })
})
