// @vitest-environment jsdom
/**
 * MiniMax 视频工具卡片（`tool.call.toolview` 的 `minimax_generate_video`）。
 *
 * 卡片本身只有一个会失败的地方：字节从**另一个运行时**（宿主的工作区远端）来，
 * 可能读不到、可能还没拿到、也可能根本没有 meta。所以这里逐个钉住四个结论：
 *
 * 1. meta 完整时视频台里是 `<video>`，`src` 是对象 URL，且**卸载后它被撤销**；
 * 2. meta 缺失时不崩，视频台退回占位块；
 * 3. 失败态保留占位块，只把文字换成 danger 色（数据仍在屏幕上）；
 * 4. 路径片点击时交出去的是**绝对路径**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MinimaxVideoToolView, type MinimaxVideoBlock } from '../src/client/minimax-code/MinimaxVideoToolView.tsx'
import { zh } from '../src/client/minimax-code/locales.ts'
import {
  MINIMAX_VIDEO_TOOL_NAME, WORKSPACE_FILE_TOO_LARGE, absoluteVideoPath, formatBytes, formatDuration, readVideoMeta,
  unwrapVideoBytes, videoReadFailureOf, videoReadLimitOf, videoTooLargeText, type MinimaxVideoPresentationMeta,
} from '../src/client/minimax-code/video-contract.ts'

const CWD = 'C:/work/ws'
const VIDEO = 'clips/out.mp4'

/**
 * 远端失败的形状：`{ code, details }`。与宿主 `RemoteError` 一致（它就是个带
 * `code` / `details` 的 `Error`），但这里刻意**不** instanceof——判定方只看字段。
 */
function remoteFailure(code: string, details: Record<string, unknown> = {}): Error & { code: string, details: Record<string, unknown> } {
  return Object.assign(new Error(code), { code, details })
}

/** 一份完整的 meta：字段名与宿主 `MinimaxVideoPresentationMeta` 逐字一致。 */
const META: MinimaxVideoPresentationMeta = {
  videoPath: VIDEO,
  mediaType: 'video/mp4',
  bytes: 2_516_582,
  model: 'MiniMax-H3',
  durationSeconds: 7,
  taskId: 'task_abc123',
}

describe('video meta contract', () => {
  it('reads a complete meta object field by field', () => {
    expect(readVideoMeta({ ...META })).toEqual(META)
  })

  it('accepts a meta without a duration', () => {
    const { durationSeconds: _omitted, ...rest } = META
    expect(readVideoMeta(rest)).toEqual(rest)
  })

  it('refuses anything that is not this tool\'s meta', () => {
    expect(readVideoMeta(undefined)).toBeUndefined()
    expect(readVideoMeta(null)).toBeUndefined()
    expect(readVideoMeta('clips/out.mp4')).toBeUndefined()
    expect(readVideoMeta([META])).toBeUndefined()
    // One wrong field is enough: a half-written meta must not half-render.
    expect(readVideoMeta({ ...META, videoPath: '' })).toBeUndefined()
    expect(readVideoMeta({ ...META, mediaType: 'image/png' })).toBeUndefined()
    expect(readVideoMeta({ ...META, bytes: -1 })).toBeUndefined()
    expect(readVideoMeta({ ...META, model: undefined })).toBeUndefined()
    expect(readVideoMeta({ ...META, taskId: 42 })).toBeUndefined()
    expect(readVideoMeta({ ...META, durationSeconds: 0 })).toBeUndefined()
  })

  it('joins the workspace-relative path onto the session cwd', () => {
    expect(absoluteVideoPath(CWD, VIDEO)).toBe('C:/work/ws/clips/out.mp4')
    expect(absoluteVideoPath(CWD, 'clips\\out.mp4')).toBe('C:/work/ws/clips/out.mp4')
    expect(absoluteVideoPath('C:/work/ws/', VIDEO)).toBe('C:/work/ws/clips/out.mp4')
    // An already-absolute path is not joined twice.
    expect(absoluteVideoPath(CWD, 'D:/other/out.mp4')).toBe('D:/other/out.mp4')
    // Without a cwd the relative path is left as it is: it still addresses the
    // file inside this session, only not absolutely.
    expect(absoluteVideoPath(undefined, VIDEO)).toBe(VIDEO)
    expect(absoluteVideoPath('', VIDEO)).toBe(VIDEO)
  })

  it('formats size and duration for an 11px slot', () => {
    expect(formatBytes(986)).toBe('986 B')
    expect(formatBytes(2_516_582)).toBe('2.4 MB')
    expect(formatBytes(12_400_000)).toBe('11.8 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.4 GB')
    expect(formatDuration(7)).toBe('0:07')
    expect(formatDuration(67)).toBe('1:07')
    expect(formatDuration(3_723)).toBe('1:02:03')
  })

  it('names the tool key the slot dispatches on', () => {
    expect(MINIMAX_VIDEO_TOOL_NAME).toBe('minimax_generate_video')
  })
})


describe('video read failure vocabulary', () => {
  it('classifies a failure by its code, never by its message', () => {
    expect(videoReadFailureOf(remoteFailure(WORKSPACE_FILE_TOO_LARGE, { limit: 1 }))).toBe('too-large')
    expect(videoReadFailureOf(remoteFailure('workspace-file/not-found'))).toBe('unreadable')
    expect(videoReadFailureOf(new Error('workspace-file/too-large'))).toBe('unreadable')
    expect(videoReadFailureOf(undefined)).toBe('unreadable')
    expect(videoReadFailureOf(null)).toBe('unreadable')
    expect(videoReadFailureOf('workspace-file/too-large')).toBe('unreadable')
    expect(videoReadFailureOf({})).toBe('unreadable')
  })

  it('reads the cap out of details and refuses anything that is not one', () => {
    expect(videoReadLimitOf(remoteFailure(WORKSPACE_FILE_TOO_LARGE, { limit: 33_554_432 }))).toBe(33_554_432)
    // Absent, malformed, or impossible caps are not invented.
    expect(videoReadLimitOf(remoteFailure(WORKSPACE_FILE_TOO_LARGE))).toBeUndefined()
    expect(videoReadLimitOf(remoteFailure(WORKSPACE_FILE_TOO_LARGE, { limit: '32 MB' }))).toBeUndefined()
    expect(videoReadLimitOf(remoteFailure(WORKSPACE_FILE_TOO_LARGE, { limit: 0 }))).toBeUndefined()
    expect(videoReadLimitOf(new Error('nope'))).toBeUndefined()
    expect(videoReadLimitOf(undefined)).toBeUndefined()
  })

  it('writes the cap into the sentence with the same formatter as the card', () => {
    const t = (key: 'videoTooLarge') => zh[key]
    expect(videoTooLargeText(t, 33_554_432)).toBe(zh.videoTooLarge.replace('{limit}', '32 MB'))
    // A missing cap leaves the dash formatBytes already uses for nonsense input.
    expect(videoTooLargeText(t, undefined)).toBe(zh.videoTooLarge.replace('{limit}', '—'))
  })
})

describe('remote byte result', () => {
  it('takes the bytes out of a successful result', () => {
    const data = new Uint8Array([1, 2, 3])
    expect(unwrapVideoBytes({ ok: true, value: { data } })).toBe(data)
  })

  it('throws the failure the Host declared, keeping its code and cap', () => {
    // 远端调用**不抛异常**：它把结果装成 { ok, value } 或 { ok, error }。
    // 字节在 value.data，直接读 (await call()).data 拿到的是 undefined——
    // 卡片于是永远停在「正在读取视频」。失败那一支必须变成真正的异常，
    // 卡片才能按 code 与 details.limit 区分「太大」和「读不到」。
    const failure = remoteFailure(WORKSPACE_FILE_TOO_LARGE, { path: VIDEO, limit: 32 * 1024 * 1024 })
    expect(() => unwrapVideoBytes({ ok: false, error: failure })).toThrow(failure)
    try {
      unwrapVideoBytes({ ok: false, error: failure })
      expect.unreachable('the declared failure must be thrown')
    } catch (error) {
      expect(videoReadFailureOf(error)).toBe('too-large')
      expect(videoReadLimitOf(error)).toBe(32 * 1024 * 1024)
    }
  })

  it('refuses a successful result that carries no bytes', () => {
    expect(() => unwrapVideoBytes({ ok: true, value: { data: undefined as unknown as Uint8Array } })).toThrow()
  })

  it('decodes the base64 payload the older harness generation sends', () => {
    // ≤0.1.6 的宿主把字节编成 base64 字符串（宿主自己的预览也是用 atob 解的）。
    // 不认这一支，旧世代拿到的就是一串 base64 而不是字节。
    const bytes = new Uint8Array([1, 2, 3, 250])
    const base64 = Buffer.from(bytes).toString('base64')
    expect(unwrapVideoBytes({ ok: true, value: { data: base64 } })).toEqual(bytes)
  })

  it('refuses a payload that is neither bytes nor decodable base64', () => {
    expect(() => unwrapVideoBytes({ ok: true, value: { data: 'not base64!!' } })).toThrow()
  })
})

describe('MinimaxVideoToolView', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    URL.createObjectURL = vi.fn(() => 'blob:mock-video')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  })

  /** 结算成功的结果块。 */
  function settled(meta: unknown, extra: Partial<MinimaxVideoBlock> = {}): MinimaxVideoBlock {
    return { kind: 'tool-result', isError: false, meta, content: [], ...extra }
  }

  /** 渲染一次并把取字节的 Promise 跑完。 */
  async function render(block: MinimaxVideoBlock, options: {
    cwd?: string | undefined
    readVideo?: (sessionId: string, path: string, signal?: AbortSignal) => Promise<Uint8Array>
    openFile?: (path: string, options?: { line?: number }) => void
  } = {}) {
    const readVideo = options.readVideo ?? (async () => new Uint8Array([1, 2, 3]))
    const openFile = options.openFile ?? vi.fn()
    await act(async () => {
      root.render(createElement(MinimaxVideoToolView, {
        block,
        cwd: 'cwd' in options ? options.cwd : CWD,
        openFile,
        readVideo,
        sessionId: 'session-1',
        t: (key: keyof typeof zh) => zh[key],
      }))
    })
    return { openFile }
  }

  it('renders a <video> whose src is the object URL, and revokes it on unmount', async () => {
    await render(settled({ ...META }))
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe('blob:mock-video')
    expect(video?.getAttribute('preload')).toBe('metadata')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    // The stage is a fixed 16:9 box whatever the container width is.
    expect(container.querySelector('.dshm-video-stage')?.getAttribute('data-state')).toBe('ready')
    // The metadata row carries the size and the duration.
    expect(container.textContent).toContain('2.4 MB')
    expect(container.textContent).toContain('0:07')
    expect(container.textContent).toContain(VIDEO)

    await act(async () => root.unmount())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-video')
    // Remount for the shared afterEach, which unmounts once more.
    root = createRoot(container)
  })

  it('does not crash on a missing meta and keeps the stage as a placeholder', async () => {
    await render(settled(undefined))
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('.dshm-video-stage')?.getAttribute('data-state')).toBe('empty')
    // The card itself still renders its head, so the call is not invisible.
    expect(container.textContent).toContain(zh.videoNoMeta)
    expect(container.textContent).toContain(zh.videoToolDone)
    // Nothing was fetched: a card without meta has no path to read.
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps the placeholder and turns it danger-coloured when the call failed', async () => {
    const readVideo = vi.fn(async () => new Uint8Array([1]))
    await render({ kind: 'tool-result', isError: true, content: [], meta: { ...META } }, { readVideo })
    const stage = container.querySelector('.dshm-video-stage')
    expect(stage?.getAttribute('data-state')).toBe('empty')
    expect(container.querySelector('video')).toBeNull()
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    expect(placeholder?.textContent).toBe(zh.videoFailed)
    // The status dot follows the card, and the failure never reads as success.
    expect(container.querySelector('.dshm-video-tool')?.getAttribute('data-state')).toBe('error')
    expect(container.textContent).not.toContain(zh.videoToolDone)
    expect(readVideo).not.toHaveBeenCalled()
  })

  it('keeps the placeholder when the bytes cannot be read', async () => {
    await render(settled({ ...META }), { readVideo: async () => { throw new Error('workspace-file/not-found') } })
    expect(container.querySelector('video')).toBeNull()
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    expect(placeholder?.textContent).toBe(zh.videoUnreadable)
    // The path chip survives the failure: the file is still worth opening.
    expect(container.querySelector('.dshm-video-path')?.textContent).toBe(VIDEO)
  })

  it('never sits on the reading line once the channel has settled', async () => {
    // 曾经正是这一支让卡片永远停在「正在读取视频」：远端把结果装成
    // { ok, value }，读 .data 拿到的是 undefined，而状态却已经是「拿到了」。
    await render(settled({ ...META }), { readVideo: async () => undefined as unknown as Uint8Array })
    expect(container.querySelector('video')).toBeNull()
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    expect(placeholder?.textContent).toBe(zh.videoUnreadable)
    expect(container.textContent).not.toContain(zh.videoReading)
  })

  it('shows the quiet reading line while the bytes are still on the way', async () => {
    await render(settled({ ...META }), { readVideo: () => new Promise<Uint8Array>(() => {}) })
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('quiet')
    expect(container.textContent).toContain(zh.videoReading)
  })


  it('separates "too large" from "missing" when the read fails', async () => {
    // The one thing this card used to get wrong: a 40 MB file the Host refuses to
    // hand over is NOT a file that was moved or deleted.
    await render(settled({ ...META }), {
      readVideo: async () => { throw remoteFailure(WORKSPACE_FILE_TOO_LARGE, { path: VIDEO, limit: 32 * 1024 * 1024 }) },
    })
    const placeholder = container.querySelector('.dshm-video-placeholder')
    expect(placeholder?.getAttribute('data-tone')).toBe('danger')
    // The cap travels into the line: 32 MB is what the Host said, not a guess.
    expect(placeholder?.textContent).toBe(zh.videoTooLarge.replace('{limit}', '32 MB'))
    expect(placeholder?.textContent).toContain('32 MB')
    // And it must not accuse the file of being gone, nor offer a retry.
    expect(container.textContent).not.toContain(zh.videoUnreadable)
    expect(container.textContent).not.toMatch(/moved or deleted|移动或删除/)
    expect(container.querySelector('video')).toBeNull()
  })

  it('keeps the path chip clickable when the file is too large', async () => {
    // The Host’s own recourse for too-large is 'open', not 'retry': reading it
    // again is still too large, but a system player reads the file directly.
    const { openFile } = await render(settled({ ...META }), {
      readVideo: async () => { throw remoteFailure(WORKSPACE_FILE_TOO_LARGE, { path: VIDEO, limit: 32 * 1024 * 1024 }) },
    })
    const chip = container.querySelector('.dshm-video-path') as HTMLButtonElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toBe(VIDEO)
    expect(chip.disabled).toBe(false)
    await act(async () => chip.click())
    expect(openFile).toHaveBeenCalledWith(`${CWD}/${VIDEO}`, { line: 1 })
  })

  it('keeps the "moved or deleted" line for every other failure code', async () => {
    for (const code of ['workspace-file/not-found', 'workspace-file/not-regular-file', 'gateway/internal']) {
      await act(async () => root.unmount())
      root = createRoot(container)
      await render(settled({ ...META }), { readVideo: async () => { throw remoteFailure(code) } })
      expect(container.querySelector('.dshm-video-placeholder')?.textContent).toBe(zh.videoUnreadable)
    }
  })

  it('falls back to the "moved or deleted" line when the throw carries no code', async () => {
    // A channel that is not mounted rejects a plain Error; that is unreadable, not
    // oversized, and an unrecognised shape must never be reclassified.
    await render(settled({ ...META }), { readVideo: async () => { throw new TypeError('fetch failed') } })
    expect(container.querySelector('.dshm-video-placeholder')?.textContent).toBe(zh.videoUnreadable)
    expect(container.textContent).not.toContain('32 MB')
  })
  it('opens the absolute path when the path chip is clicked', async () => {
    const { openFile } = await render(settled({ ...META }))
    const chip = container.querySelector('.dshm-video-path') as HTMLButtonElement
    await act(async () => chip.click())
    expect(openFile).toHaveBeenCalledWith(`${CWD}/${VIDEO}`, { line: 1 })
  })

  it('falls back to the workspace-relative path when the session has no cwd', async () => {
    const { openFile } = await render(settled({ ...META }), { cwd: undefined })
    const chip = container.querySelector('.dshm-video-path') as HTMLButtonElement
    await act(async () => chip.click())
    expect(openFile).toHaveBeenCalledWith(VIDEO, { line: 1 })
  })

  it('draws the running stage with an empty stage and the prompt as summary', async () => {
    await render({ argsRaw: JSON.stringify({ prompt: 'a paper boat on a river' }) })
    expect(container.querySelector('.dshm-video-tool')?.getAttribute('data-state')).toBe('running')
    expect(container.textContent).toContain(zh.videoToolRunning)
    expect(container.textContent).toContain('a paper boat on a river')
    expect(container.querySelector('.dshm-video-stage')?.getAttribute('data-state')).toBe('empty')
    expect(container.textContent).toContain(zh.videoGenerating)
    expect(container.querySelector('.dshm-video-path')).toBeNull()
  })

  it('reads the streaming prompt prefix while the arguments are still arriving', async () => {
    await render({ args: { text: () => 'a paper boat' } })
    expect(container.textContent).toContain('a paper boat')
    expect(container.textContent).toContain(zh.videoToolRunning)
  })

  it('says the channel is off when no byte reader was injected', async () => {
    await act(async () => {
      root.render(createElement(MinimaxVideoToolView, {
        block: settled({ ...META }), cwd: CWD, sessionId: 'session-1', t: (key: keyof typeof zh) => zh[key],
      }))
    })
    expect(container.querySelector('video')).toBeNull()
    expect(container.textContent).toContain(zh.videoChannelOff)
  })
})
