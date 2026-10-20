// @vitest-environment jsdom
/**
 * Tests for `/video`: the command's availability gate, the preset rows, the draft
 * text that reaches the composer, the form-level parameter linkage, and the
 * defaults store.
 *
 * WHY THE LINKAGE IS TESTED HERE RATHER THAN ONLY IN THE HOST: the host already
 * has its own tests for `resolveVideoSubmissionRatio` and the per-model rule
 * table. What those cannot prove is that the CLIENT applies the same rules BEFORE
 * the user sees a control — a client that lets someone pick a ratio the host will
 * silently rewrite is the exact failure this entry point exists to prevent.
 *
 * NO REQUEST LEAVES THIS PROCESS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MINIMAX_H3_TEXT_DEFAULT_RATIO,
  MINIMAX_KEYFRAME_RATIO,
  MINIMAX_REFERENCE_DEFAULT_RATIO,
  MINIMAX_VIDEO_MODELS,
  MINIMAX_VIDEO_RATIOS,
  VIDEO_MODEL_RULES,
  buildVideoDraftText,
  canSubmitVideoForm,
  defaultDuration,
  defaultResolution,
  durationChoices,
  mediaPresence,
  normalizeVideoDefaults,
  parsePathLines,
  resolveVideoRatioChoice,
  validateVideoForm,
  videoModelRule,
  type VideoFormValues,
} from '../src/client/minimax-code/video-form-rules.ts'
import {
  CUSTOM_OPTION_ID,
  MINIMAX_CODE_PROVIDER,
  VIDEO_COMMAND_NAME,
  createVideoCommand,
  fillComposer,
  presetDraftText,
  sessionRouteOf,
} from '../src/client/minimax-code/video-command.ts'
import { videoPresets } from '../src/client/minimax-code/VideoFormDialog.tsx'
import {
  VIDEO_DEFAULTS_STORAGE_KEY,
  readVideoDefaults,
  writeVideoDefaults,
  type KeyValueStorage,
} from '../src/client/minimax-code/video-defaults-store.ts'

/** A command contribution, read structurally: the popup half has no other shape. */
interface PopupCommand {
  readonly name: string
  readonly available: (session: { readonly sessionId: string }) => boolean
  readonly ui: {
    readonly kind: 'popupSelect'
    readonly options: (
      session: { readonly sessionId: string },
      signal: AbortSignal,
    ) => Promise<readonly { readonly id: string; readonly label: string }[]>
    readonly onSelect: (
      option: { readonly id: string; readonly label: string },
      session: { readonly sessionId: string },
    ) => void | Promise<void>
  }
}

/**
 * A client context shaped like the real one for the two reads this plugin makes.
 *
 * `route` is what `faceOf('modelSelection')` answers, or undefined to model a
 * session whose projection has not landed yet.
 */
function contextWith(input: {
  route?: { provider: string; model: string }
  draft?: ((text: string) => void) | undefined
}): { ctx: never } {
  const binding = input.route === undefined
    ? { ctx: { scoped: true } }
    : {
      ctx: { scoped: true },
      session: {
        projections: {
          faceOf: () => ({ getSnapshot: () => ({ next: input.route }) }),
        },
      },
    }
  const ctx = {
    sessions: {
      binding: (id: string) => (id === 's1' ? binding : undefined),
    },
    conversation: {
      input: {
        for: () => ({ setDraft: input.draft ?? (() => {}) }),
      },
    },
  }
  return { ctx: ctx as never }
}

/** The t a real render would supply; the fallback dictionary is the same source. */
function translate(key: string): string {
  return key
}

describe('/video command', () => {
  it('is available only in a minimax-code session', () => {
    const minimax = contextWith({ route: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' } })
    const other = contextWith({ route: { provider: 'codex-chatgpt', model: 'gpt-5' } })
    const commandOf = (ctx: never): PopupCommand => createVideoCommand(ctx, {
      openForm: () => {},
      translate: translate as never,
    }) as unknown as PopupCommand

    expect(commandOf(minimax.ctx).available({ sessionId: 's1' })).toBe(true)
    expect(commandOf(other.ctx).available({ sessionId: 's1' })).toBe(false)
  })

  it('answers false instead of throwing when the session has no projection yet', () => {
    // A session that was just created, or one whose projection has not landed.
    const empty = contextWith({})
    const command = createVideoCommand(empty.ctx, {
      openForm: () => {},
      translate: translate as never,
    }) as unknown as PopupCommand
    expect(command.available({ sessionId: 's1' })).toBe(false)
    expect(command.available({ sessionId: 'unknown-session' })).toBe(false)
    // And a context with no `sessions` service at all must not throw either: the
    // slash menu calls this on every open, so one throw takes the whole menu down.
    const bare = createVideoCommand({} as never, {
      openForm: () => {},
      translate: translate as never,
    }) as unknown as PopupCommand
    expect(bare.available({ sessionId: 's1' })).toBe(false)
  })

  it('offers one preset row per model plus the custom row, all of them legal', async () => {
    const { ctx } = contextWith({ route: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' } })
    const command = createVideoCommand(ctx, {
      openForm: () => {},
      translate: translate as never,
    }) as unknown as PopupCommand
    const rows = await command.ui.options({ sessionId: 's1' }, new AbortController().signal)

    expect(rows.filter(row => row.id === CUSTOM_OPTION_ID)).toHaveLength(1)
    expect(rows.filter(row => row.id !== CUSTOM_OPTION_ID)).toHaveLength(MINIMAX_VIDEO_MODELS.length)

    // Every preset must name a duration its OWN model accepts, and a resolution
    // its own model accepts. This is the assertion that would have caught a
    // preset built from the union instead of from the per-model table.
    for (const { preset } of videoPresets(translate as never)) {
      const rule = videoModelRule(preset.model)
      expect(rule).toBeDefined()
      expect(durationChoices(preset.model)).toContain(preset.durationSeconds)
      expect(rule?.resolutions).toContain(preset.resolution)
      // A preset is a text-only row, so it must never carry `adaptive`.
      expect(preset.ratio).not.toBe('adaptive')
    }
  })

  it('fills the composer with a legal preset and opens the form for the custom row', async () => {
    const filled: { sessionId: string; text: string }[] = []
    const opened: { sessionId: string; model: string }[] = []
    const { ctx } = contextWith({ route: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' } })
    const command = createVideoCommand(ctx, {
      openForm: (sessionId, defaults) => { opened.push({ sessionId, model: defaults.model }) },
      fill: (sessionId, text) => { filled.push({ sessionId, text }); return true },
      translate: translate as never,
      defaults: () => normalizeVideoDefaults({ model: 'MiniMax-H3-Max' }),
    }) as unknown as PopupCommand
    const rows = await command.ui.options({ sessionId: 's1' }, new AbortController().signal)

    const custom = rows.find(row => row.id === CUSTOM_OPTION_ID)
    expect(custom).toBeDefined()
    await command.ui.onSelect(custom!, { sessionId: 's1' })
    expect(opened).toEqual([{ sessionId: 's1', model: 'MiniMax-H3-Max' }])
    expect(filled).toHaveLength(0)

    const presetRow = rows.find(row => row.id !== CUSTOM_OPTION_ID)!
    await command.ui.onSelect(presetRow, { sessionId: 's1' })
    expect(filled).toHaveLength(1)
    expect(filled[0].text).toContain('minimax_generate_video')
  })

  it('names the tool and every argument in the text it puts in the composer', () => {
    const text = buildVideoDraftText({
      prompt: '海边日落',
      model: 'MiniMax-H3',
      ratio: '16:9',
      durationSeconds: 6,
      resolution: '2K',
      watermark: true,
      media: {},
    })
    expect(text).toContain('minimax_generate_video')
    expect(text).toContain('prompt=海边日落')
    expect(text).toContain('model=MiniMax-H3')
    expect(text).toContain('ratio=16:9')
    expect(text).toContain('durationSeconds=6')
    expect(text).toContain('resolution=2K')
    expect(text).toContain('aigc_watermark=true')
    // The one-submit contract must travel WITH the request: the host's own guard
    // only covers one session turn, so the model is the other half of it.
    expect(text).toContain('只调用一次')
  })

  it('carries every reference collection, in the order the host expects', () => {
    const text = buildVideoDraftText({
      prompt: 'p',
      model: 'MiniMax-H3',
      durationSeconds: 6,
      media: {
        inputImagePath: '/ws/first.png',
        lastFrameImagePath: '/ws/last.png',
        referenceImagePaths: ['/ws/a.png', '/ws/b.png'],
        referenceVideoPaths: ['/ws/v1.mp4'],
        referenceVideoDurationSeconds: [5],
        referenceAudioPaths: ['/ws/a.mp3'],
      },
    })
    expect(text).toContain('inputImagePath=/ws/first.png')
    expect(text).toContain('lastFrameImagePath=/ws/last.png')
    expect(text).toContain('referenceImagePaths=/ws/a.png,/ws/b.png')
    expect(text).toContain('referenceVideoPaths=/ws/v1.mp4')
    expect(text).toContain('referenceVideoDurationSeconds=5')
    expect(text).toContain('referenceAudioPaths=/ws/a.mp3')
    // A keyframe submit is forced to adaptive by the host, so the text must say so
    // rather than repeat a ratio the service is about to overwrite.
    expect(text).toContain('ratio=adaptive')
    expect(text).not.toContain('ratio=16:9')
  })

  it('never sends `adaptive` for a text-only generation', () => {
    const text = buildVideoDraftText({ prompt: 'p', model: 'MiniMax-H3', media: {} })
    // The linkage supplies the H3 text default, which is what will really be sent.
    expect(text).toContain('ratio=' + MINIMAX_H3_TEXT_DEFAULT_RATIO)
    expect(text).not.toContain('ratio=adaptive')
  })

  it('omits the ratio entirely for a Hailuo text-only submit', () => {
    // Hailuo is outside the H3 linkage, so no ratio field is sent at all. Writing
    // one here would describe a request that is not the one being made.
    const text = buildVideoDraftText({ prompt: 'p', model: 'MiniMax-Hailuo-2.3', media: {} })
    expect(text).not.toContain('ratio=')
  })
})

describe('sessionRouteOf and fillComposer', () => {
  it('reads the provider from the modelSelection projection', () => {
    const { ctx } = contextWith({ route: { provider: 'minimax-code', model: 'MiniMax-M3' } })
    expect(sessionRouteOf(ctx, 's1')).toEqual({ provider: 'minimax-code', model: 'MiniMax-M3' })
    expect(sessionRouteOf(ctx, 'other')).toBeUndefined()
  })

  it('writes the draft through the session input facade', () => {
    const drafts: string[] = []
    const { ctx } = contextWith({
      route: { provider: 'minimax-code', model: 'MiniMax-M3' },
      draft: text => drafts.push(text),
    })
    expect(fillComposer(ctx, 's1', 'hello')).toBe(true)
    expect(drafts).toEqual(['hello'])
    // A session with no binding cannot be filled, and says so instead of throwing.
    expect(fillComposer(ctx, 'gone', 'hello')).toBe(false)
    expect(fillComposer({} as never, 's1', 'hello')).toBe(false)
  })
})

describe('form-level parameter linkage', () => {
  it('locks the ratio to adaptive as soon as a first frame is set', () => {
    const choice = resolveVideoRatioChoice({
      model: 'MiniMax-H3',
      requested: '16:9',
      hasKeyframes: true,
      hasReferences: false,
    })
    expect(choice.ratio).toBe(MINIMAX_KEYFRAME_RATIO)
    expect(choice.selectable).toBe(false)
    expect(choice.lockedReason).toBe('keyframes')
    // No options at all: there is nothing for the user to pick, which is the
    // point — the host would overwrite whatever they picked.
    expect(choice.options).toHaveLength(0)
  })

  it('lets reference media keep the caller choice but defaults to adaptive', () => {
    const chosen = resolveVideoRatioChoice({
      model: 'MiniMax-H3',
      requested: '9:16',
      hasKeyframes: false,
      hasReferences: true,
    })
    expect(chosen.ratio).toBe('9:16')
    expect(chosen.selectable).toBe(true)
    const fallback = resolveVideoRatioChoice({
      model: 'MiniMax-H3',
      hasKeyframes: false,
      hasReferences: true,
    })
    expect(fallback.ratio).toBe(MINIMAX_REFERENCE_DEFAULT_RATIO)
  })

  it('offers every concrete ratio for a text-only H3 submit and hides adaptive', () => {
    const choice = resolveVideoRatioChoice({
      model: 'MiniMax-H3',
      hasKeyframes: false,
      hasReferences: false,
    })
    expect(choice.selectable).toBe(true)
    expect(choice.options).not.toContain('adaptive')
    expect(choice.options).toEqual(MINIMAX_VIDEO_RATIOS.filter(entry => entry !== 'adaptive'))
    expect(choice.ratio).toBe(MINIMAX_H3_TEXT_DEFAULT_RATIO)
  })

  it('treats whitespace-only paths as absent', () => {
    expect(mediaPresence({ inputImagePath: '   ', referenceImagePaths: ['  '] }))
      .toEqual({ hasKeyframes: false, hasReferences: false })
    expect(mediaPresence({ inputImagePath: '/a.png' })).toEqual({ hasKeyframes: true, hasReferences: false })
    expect(parsePathLines(' /a.png \n\n  \n/b.png \n')).toEqual(['/a.png', '/b.png'])
  })
})

describe('form validation', () => {
  const base: VideoFormValues = { prompt: 'p', model: 'MiniMax-H3', media: {} }

  it('refuses to submit without a prompt', () => {
    expect(canSubmitVideoForm({ ...base, prompt: '' })).toBe(false)
    expect(canSubmitVideoForm({ ...base, prompt: '   ' })).toBe(false)
    expect(canSubmitVideoForm(base)).toBe(true)
    expect(validateVideoForm({ ...base, prompt: '' }).map(issue => issue.code)).toContain('prompt-empty')
  })

  it('narrows durations and resolutions per model instead of offering the union', () => {
    expect(durationChoices('MiniMax-H3')).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    expect(durationChoices('MiniMax-H3-Max'))
      .toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    // A CLOSED set, not a window: 7 seconds is refused by this model.
    expect(durationChoices('MiniMax-Hailuo-2.3')).toEqual([6, 10])

    expect(videoModelRule('MiniMax-H3')?.resolutions).toEqual(['768P', '2K'])
    expect(videoModelRule('MiniMax-H3-Max')?.resolutions).toEqual(['480P', '768P'])
    expect(videoModelRule('MiniMax-Hailuo-2.3')?.resolutions).toEqual(['768P', '1080P'])
    // The default resolution must be one the model actually accepts: 2K is H3's
    // alone, so a shared default would make every H3-Max submit illegal.
    for (const rule of VIDEO_MODEL_RULES) {
      expect(rule.resolutions).toContain(defaultResolution(rule.model))
      expect(durationChoices(rule.model)).toContain(defaultDuration(rule.model))
    }
  })

  it('reports reference media the model cannot take', () => {
    const issues = validateVideoForm({
      prompt: 'p',
      model: 'MiniMax-Hailuo-2.3',
      media: { referenceImagePaths: ['/a.png'] },
    })
    expect(issues.map(issue => issue.code)).toContain('reference-unsupported')
    // A first frame alone is legal for Hailuo; a last frame is not.
    expect(validateVideoForm({
      prompt: 'p',
      model: 'MiniMax-Hailuo-2.3',
      media: { inputImagePath: '/a.png' },
    })).toEqual([])
    expect(validateVideoForm({
      prompt: 'p',
      model: 'MiniMax-Hailuo-2.3',
      media: { lastFrameImagePath: '/b.png' },
    }).map(issue => issue.code)).toContain('last-frame-unsupported')
  })

  it('reports a duration the chosen model does not accept', () => {
    const issues = validateVideoForm({ ...base, model: 'MiniMax-Hailuo-2.3', durationSeconds: 7 })
    expect(issues.map(issue => issue.code)).toContain('duration-invalid')
    expect(validateVideoForm({ ...base, model: 'MiniMax-Hailuo-2.3', durationSeconds: 10 })).toEqual([])
  })

  it('reports the reference collection limits', () => {
    const tooManyImages = Array.from({ length: 10 }, (_, index) => '/img' + String(index) + '.png')
    expect(validateVideoForm({ ...base, media: { referenceImagePaths: tooManyImages } })
      .map(issue => issue.code)).toContain('too-many-images')
    const tooManyVideos = Array.from({ length: 4 }, (_, index) => '/vid' + String(index) + '.mp4')
    expect(validateVideoForm({ ...base, media: { referenceVideoPaths: tooManyVideos } })
      .map(issue => issue.code)).toContain('too-many-videos')
    const tooManyAudios = Array.from({ length: 4 }, (_, index) => '/aud' + String(index) + '.mp3')
    expect(validateVideoForm({ ...base, media: { referenceAudioPaths: tooManyAudios } })
      .map(issue => issue.code)).toContain('too-many-audios')
  })
})

describe('defaults store', () => {
  // One case writes through the ambient localStorage on purpose; leave it clean
  // so a later suite in the same worker cannot observe this suite's defaults.
  afterEach(() => {
    try {
      globalThis.localStorage?.removeItem(VIDEO_DEFAULTS_STORAGE_KEY)
    } catch {
      // No ambient storage in this environment: nothing to clean.
    }
  })

  /** A storage that behaves like localStorage; `broken` makes writes throw. */
  function fakeStorage(options: { broken?: boolean } = {}): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.broken === true) throw new Error('quota exceeded')
        data.set(key, value)
      },
      removeItem: (key: string) => { data.delete(key) },
    }
  }

  it('round-trips a saved default and falls back to shipped values when absent', () => {
    const storage = fakeStorage()
    expect(readVideoDefaults(storage)).toEqual({
      model: 'MiniMax-H3',
      durationSeconds: 4,
      watermark: false,
    })

    expect(writeVideoDefaults({ model: 'MiniMax-H3-Max', ratio: '16:9', durationSeconds: 9, watermark: true }, storage))
      .toBe(true)
    expect(storage.data.has(VIDEO_DEFAULTS_STORAGE_KEY)).toBe(true)
    expect(readVideoDefaults(storage)).toEqual({
      model: 'MiniMax-H3-Max',
      ratio: '16:9',
      durationSeconds: 9,
      watermark: true,
    })
  })

  it('repairs a duration the saved model cannot take', () => {
    // The user changed the default model after setting a duration: 8 s is合法for
    // H3 but Hailuo accepts only 6 or 10, so the value is replaced rather than
    // carried into a form that would immediately show an error.
    const storage = fakeStorage()
    storage.setItem(VIDEO_DEFAULTS_STORAGE_KEY, JSON.stringify({ model: 'MiniMax-Hailuo-2.3', durationSeconds: 8 }))
    expect(readVideoDefaults(storage).durationSeconds).toBe(6)
  })

  it('degrades to shipped values on a corrupt document and never throws', () => {
    const storage = fakeStorage()
    storage.setItem(VIDEO_DEFAULTS_STORAGE_KEY, '{not json')
    expect(readVideoDefaults(storage).model).toBe('MiniMax-H3')
    // An unusable store (private mode, quota) must not take the settings page down.
    expect(readVideoDefaults(fakeStorage({ broken: true }))).toEqual(normalizeVideoDefaults({}))
    expect(writeVideoDefaults({ model: 'MiniMax-H3', watermark: false }, fakeStorage({ broken: true }))).toBe(false)
    // No override argument at all means "use this browser's localStorage", which
    // jsdom provides, so the write SUCCEEDS here. What must not happen is a
    // throw: the settings card calls this from an onChange handler.
    expect(() => writeVideoDefaults({ model: 'MiniMax-H3', watermark: false })).not.toThrow()
    expect(() => readVideoDefaults()).not.toThrow()
  })
})

describe('presetDraftText', () => {
  it('leaves the prompt as an explicit placeholder the user fills in', () => {
    const text = presetDraftText({
      id: 'x',
      model: 'MiniMax-H3',
      ratio: '16:9',
      durationSeconds: 4,
      resolution: '768P',
    })
    expect(text).toContain('minimax_generate_video')
    // A preset never invents a scene description on the user's behalf.
    expect(text).toContain('prompt=（在这里写画面描述）')
    expect(text).toContain('model=MiniMax-H3')
    expect(text).toContain('durationSeconds=4')
    expect(text).toContain('resolution=768P')
  })
})

describe('command name', () => {
  it('is the bare name the slash menu merges on', () => {
    expect(VIDEO_COMMAND_NAME).toBe('video')
  })

  it('does not touch the composer for an unknown option id', async () => {
    const fill = vi.fn(() => true)
    const { ctx } = contextWith({ route: { provider: MINIMAX_CODE_PROVIDER, model: 'MiniMax-M3' } })
    const command = createVideoCommand(ctx, {
      openForm: () => {},
      fill,
      translate: translate as never,
    }) as unknown as PopupCommand
    await command.ui.onSelect({ id: 'not-a-preset', label: '?' }, { sessionId: 's1' })
    expect(fill).not.toHaveBeenCalled()
  })
})
