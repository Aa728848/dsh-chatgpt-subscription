/**
 * `/video` 的参数弹窗：把「有哪些参数」和「哪些组合合法」一次讲清楚。
 *
 * ## 为什么是一个自建弹窗，而不是宿主的 popupSelect
 *
 * 宿主的 popupSelect 只有 `options()` 与 `onSelect()`（`ui-commands/src/client/
 * contract.ts:64-75`），**单选**，装不下「提示词 + 模型 + 比例 + 时长 + 分辨率 +
 * 四类参考文件 + 水印」。而 `ActionSpec.run(session)` 的契约明写它「不提交任何
 * 东西」，所以命令自己也发不出去。`/video` 因此是两级：popupSelect 给预设档
 * （见 `video-command.ts`），「自定义…」这一档打开本组件。
 *
 * ## 关键行为：它**不发送**，只把参数写进输入框
 *
 * 这是这次入口的核心价值。视频参数有联动规则（给了首帧→比例被强制改成
 * `adaptive`；纯文本→`adaptive` 不可选），如果直接发起生成，用户永远看不到
 * 自己填的东西被改成了什么。所以这里只调用 `setDraft`，把
 * {@link buildVideoDraftText} 拼出来的那段话放进输入框，剩下的交给用户。
 *
 * ## 弹窗怎么落地
 *
 * 宿主有 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（`Modal.tsx:48`，
 * 内部 `createPortal(..., document.body)` 在 `:57-90`）。**本插件不依赖那个包的
 * 运行时**（`progress-updates/markdown-lite.tsx:6` 记录了这个决定：它的 `lib`
 * 是宿主装配产物，插件装不到），所以这里按同一形状自己 portal 到 `document.body`：
 * 遮罩 + 居中卡片 + `role="dialog"` + `aria-modal` + Escape 关闭 + 点遮罩关闭。
 * portal 到 body 是必须的——输入框所在的那片容器有 `overflow`，就地渲染会被裁掉。
 *
 * ## 键盘可达性
 *
 * 卡片带 `tabIndex={-1}` 并在打开时聚焦，Tab 因此从卡片内部开始按 DOM 顺序走遍
 * 每个字段；Escape 关闭（在 `keydown` 捕获阶段处理，输入框里的 Escape 也生效）；
 * 关闭后焦点还给打开它的元素，见 {@link VideoFormDialog} 里的 `restoreFocus`。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-form-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_MINIMAX_VIDEO_MODEL,
  MINIMAX_VIDEO_MODELS,
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
  type MinimaxVideoModel,
  type MinimaxVideoRatio,
  type MinimaxVideoResolution,
  type VideoDefaults,
  type VideoFormIssue,
  type VideoFormValues,
} from './video-form-rules.ts'
import type { MinimaxCodeLocaleKey } from './locales.ts'

/** 翻译函数的座位：参数化的键允许带模板参数。 */
export type Translate = (key: MinimaxCodeLocaleKey, params?: Record<string, string | number>) => string

/** 弹窗的全部入参。 */
export interface VideoFormDialogProps {
  /** 是否显示。 */
  readonly open: boolean
  /** 关闭（Escape、点遮罩、取消按钮都走这里）。 */
  readonly onClose: () => void
  /**
   * 提交：把拼好的那段话交给调用方。
   *
   * **返回 false 表示没有填进去**（这个会话没有输入框），弹窗据此显示一句错误而
   * 不是假装成功。弹窗自己不碰 session —— 它不知道 `setDraft` 怎么调。
   */
  readonly onSubmit: (text: string) => boolean
  /** 初始值：设置页里的默认参数。 */
  readonly defaults?: VideoDefaults
  /** 翻译函数。 */
  readonly t: Translate
}

/** 把校验问题翻成一句话。中文最多两句、结尾不加句号。 */
function issueText(issue: VideoFormIssue, t: Translate): string {
  const params = issue.params ?? {}
  switch (issue.code) {
    case 'prompt-empty': return t('videoPromptRequired')
    case 'reference-unsupported': return t('videoMediaUnsupported', params)
    case 'last-frame-unsupported': return t('videoLastFrameUnsupported', params)
    case 'too-many-images': return t('videoTooManyImages', params)
    case 'too-many-videos': return t('videoTooManyVideos', params)
    case 'too-many-audios': return t('videoTooManyAudios', params)
    case 'too-many-total': return t('videoTooManyTotal', params)
    case 'duration-invalid': return t('videoDurationInvalid', params)
    default: return t('unknown')
  }
}

/** 一个带标签的表单行。标签与控件用 `useId` 关联，屏幕阅读器读得到。 */
function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dshm-video-field">
      <label className="dshm-video-field-label" htmlFor={id}>{label}</label>
      {children}
    </div>
  )
}

/**
 * 参数弹窗。
 *
 * 受控到组件内部：`/video` 只负责开与关，表单状态活在这里，关闭即丢弃——一次
 * 生成填一次参数，没有「上次填到一半」的语义要维护。
 */
export function VideoFormDialog({ open, onClose, onSubmit, defaults, t }: VideoFormDialogProps): React.JSX.Element | null {
  const seeded = useMemo(() => normalizeVideoDefaults(defaults ?? {}), [defaults])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<MinimaxVideoModel>(seeded.model)
  const [ratio, setRatio] = useState<MinimaxVideoRatio | undefined>(seeded.ratio)
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(seeded.durationSeconds)
  const [resolution, setResolution] = useState<MinimaxVideoResolution | undefined>(defaultResolution(seeded.model))
  const [watermark, setWatermark] = useState(seeded.watermark)
  const [inputImagePath, setInputImagePath] = useState('')
  const [lastFrameImagePath, setLastFrameImagePath] = useState('')
  const [referenceImages, setReferenceImages] = useState('')
  const [referenceVideos, setReferenceVideos] = useState('')
  const [referenceVideoDurations, setReferenceVideoDurations] = useState('')
  const [referenceAudios, setReferenceAudios] = useState('')
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const promptId = 'dshm-video-prompt'
  const modelId = 'dshm-video-model'
  const ratioId = 'dshm-video-ratio'
  const durationId = 'dshm-video-duration'
  const resolutionId = 'dshm-video-resolution'

  // 打开时做三件事，**顺序即语义**：
  //
  // 1. **把上一次的输入清掉**。组件是常驻的（命令回调没有第二次渲染去创建它），
  //    所以不重置的话，用户取消一次、再打开会看到上一轮的残留——那不是「上次填到
  //    一半」，是一次全新的生成。重置成 defaults 而不是空串：那才是「起手值」。
  // 2. 记住「是谁打开的」，关闭时把焦点还回去。
  // 3. 把焦点送进弹窗，Tab 因此从这个对话框内部开始走。
  useEffect(() => {
    if (!open) return
    const seed = normalizeVideoDefaults(defaults ?? {})
    setPrompt('')
    setModel(seed.model)
    setRatio(seed.ratio)
    setDurationSeconds(seed.durationSeconds)
    setResolution(defaultResolution(seed.model))
    setWatermark(seed.watermark)
    setInputImagePath('')
    setLastFrameImagePath('')
    setReferenceImages('')
    setReferenceVideos('')
    setReferenceVideoDurations('')
    setReferenceAudios('')
    setNotice(null)
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => { promptRef.current?.focus() })
    return () => {
      cancelAnimationFrame(frame)
      restoreFocus.current?.focus()
    }
  }, [open])

  // Escape 关闭。捕获阶段处理，输入框里的 Escape 也算数。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [open, onClose])

  const media = useMemo(() => ({
    ...(inputImagePath.trim() === '' ? {} : { inputImagePath }),
    ...(lastFrameImagePath.trim() === '' ? {} : { lastFrameImagePath }),
    referenceImagePaths: parsePathLines(referenceImages),
    referenceVideoPaths: parsePathLines(referenceVideos),
    referenceVideoDurationSeconds: parsePathLines(referenceVideoDurations)
      .map(line => Number(line))
      .filter(value => Number.isFinite(value) && value > 0),
    referenceAudioPaths: parsePathLines(referenceAudios),
  }), [inputImagePath, lastFrameImagePath, referenceImages, referenceVideos, referenceVideoDurations, referenceAudios])

  const presence = useMemo(() => mediaPresence(media), [media])
  const ratioChoice = useMemo(
    () => resolveVideoRatioChoice({
      model,
      ...(ratio === undefined ? {} : { requested: ratio }),
      hasKeyframes: presence.hasKeyframes,
      hasReferences: presence.hasReferences,
    }),
    [model, ratio, presence.hasKeyframes, presence.hasReferences],
  )

  const values: VideoFormValues = useMemo(() => ({
    prompt,
    model,
    ...(ratioChoice.ratio === undefined ? {} : { ratio: ratioChoice.ratio }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(resolution === undefined ? {} : { resolution }),
    watermark,
    media,
  }), [prompt, model, ratioChoice.ratio, durationSeconds, resolution, watermark, media])

  const issues = useMemo(() => validateVideoForm(values), [values])
  const submittable = canSubmitVideoForm(values)
  const rule = videoModelRule(model)
  const durations = durationChoices(model)
  const ratios = ratioChoice.options

  // 换模型时把时长/分辨率拉回该模型自己的合法集：不这么做，用户会看到一条
  // 「这个模型不支持 8 秒」的错误，而那个 8 秒是他根本没改过的上一手残留。
  const onModelChange = useCallback((next: MinimaxVideoModel) => {
    setModel(next)
    const allowedDurations = durationChoices(next)
    setDurationSeconds(current => (current !== undefined && allowedDurations.includes(current))
      ? current
      : defaultDuration(next))
    const allowedResolutions = videoModelRule(next)?.resolutions ?? []
    setResolution(current => (current !== undefined && allowedResolutions.includes(current))
      ? current
      : defaultResolution(next))
    setRatio(undefined)
  }, [])

  const submit = useCallback(() => {
    if (!submittable) {
      setNotice({ tone: 'danger', text: t('videoPromptRequired') })
      return
    }
    // The resolution ALWAYS travels: H3 applies its own default (2K) when the
    // field is omitted, so leaving it out of the text would describe a request
    // that differs from the one the dropdown is showing.
    const drafted: VideoFormValues = {
      ...values,
      ...(resolution === undefined ? {} : { resolution }),
    }
    const filled = onSubmit(buildVideoDraftText(drafted))
    if (!filled) {
      setNotice({ tone: 'danger', text: t('videoDraftFailed') })
      return
    }
    onClose()
  }, [onClose, onSubmit, submittable, t, values])

  if (!open) return null

  return createPortal((
    <div className="dshm-video-modal-root" role="presentation">
      <div className="dshm-video-modal-mask" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialog}
        className="dshm-video-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('videoDialogTitle')}
        tabIndex={-1}
      >
        <div className="dshm-video-modal-head">
          <h2 className="dshm-video-modal-title">{t('videoDialogTitle')}</h2>
          <button
            type="button"
            className="dshm-video-modal-close"
            aria-label={t('videoClose')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="dshm-video-modal-desc">{t('videoDialogDesc')}</p>

        <div className="dshm-video-modal-body">
          <Field label={t('videoPromptLabel')} id={promptId}>
            <textarea
              ref={promptRef}
              id={promptId}
              className="dshm-video-input dshm-video-textarea"
              rows={3}
              placeholder={t('videoPromptPlaceholder')}
              value={prompt}
              onChange={(event) => { setPrompt(event.currentTarget.value); setNotice(null) }}
            />
          </Field>

          <div className="dshm-video-field-row">
            <Field label={t('videoModelLabel')} id={modelId}>
              <select
                id={modelId}
                className="dshm-video-input"
                value={model}
                onChange={(event) => { onModelChange(event.currentTarget.value as MinimaxVideoModel) }}
              >
                {MINIMAX_VIDEO_MODELS.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </Field>

            <Field label={t('videoDurationLabel')} id={durationId}>
              <select
                id={durationId}
                className="dshm-video-input"
                value={durationSeconds === undefined ? '' : String(durationSeconds)}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value)
                  setDurationSeconds(Number.isFinite(next) ? next : undefined)
                }}
              >
                {durations.map(value => (
                  <option key={value} value={String(value)}>{value} {t('videoDurationUnit')}</option>
                ))}
              </select>
            </Field>

            <Field label={t('videoResolutionLabel')} id={resolutionId}>
              {/*
                分辨率这一栏只有模型自己的合法集：三个模型的集合两两不同，用一张
                并集去列会让 H3-Max 的用户选到 2K，然后被服务端在计费之后拒掉。
                H3 家族的省略值不是「不发」而是 2K（宿主 `resolveVideoSubmissionResolution`），
                所以这里永远带上一个值，用户看到的就是真正会发出去的那个。
              */}
              <select
                id={resolutionId}
                className="dshm-video-input"
                value={resolution ?? defaultResolution(model) ?? ''}
                onChange={(event) => {
                  const next = event.currentTarget.value as MinimaxVideoResolution
                  setResolution(rule?.resolutions.includes(next) === true ? next : undefined)
                }}
              >
                {(rule?.resolutions ?? []).map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </Field>
          </div>

          {/*
            比例这一栏有两种形态，由 resolveVideoRatioChoice 决定：
            - 锁死（给了首帧）→ 只显示结果和一个理由，不给选；
            - 可选 → 给选择器，且纯文本时 adaptive 根本不在选项里。
            这一条就是「不给用户选一个会被改写的比例」的落点。
          */}
          <Field label={t('videoRatioLabel')} id={ratioId}>
            {ratioChoice.selectable
              ? (
                <select
                  id={ratioId}
                  className="dshm-video-input"
                  value={ratioChoice.ratio ?? ''}
                  onChange={(event) => {
                    const next = event.currentTarget.value as MinimaxVideoRatio
                    setRatio(ratios.includes(next) ? next : undefined)
                  }}
                >
                  {ratios.map(entry => <option key={entry} value={entry}>{entry}</option>)}
                </select>
              )
              : (
                <div className="dshm-video-ratio-locked" id={ratioId}>
                  <code className="dshm-mono">{ratioChoice.ratio ?? t('unknown')}</code>
                  <span className="dshm-video-hint">{t('videoRatioLockedKeyframes')}</span>
                </div>
              )}
            {ratioChoice.selectable && ratioChoice.lockedReason === 'text-only' && (
              <span className="dshm-video-hint">{t('videoRatioLockedTextOnly')}</span>
            )}
          </Field>

          <div className="dshm-video-field-row dshm-video-watermark">
            <label className="dshm-video-field-label" htmlFor="dshm-video-watermark">
              {t('videoWatermarkLabel')}
            </label>
            <input
              id="dshm-video-watermark"
              type="checkbox"
              checked={watermark}
              onChange={(event) => { setWatermark(event.currentTarget.checked) }}
            />
          </div>

          <div className="dshm-video-media">
            <h3 className="dshm-video-media-title">{t('videoMediaSection')}</h3>
            <p className="dshm-video-hint">{t('videoMediaHint')}</p>

            <Field label={t('videoInputImageLabel')} id="dshm-video-input-image">
              <input
                id="dshm-video-input-image"
                className="dshm-video-input"
                type="text"
                value={inputImagePath}
                onChange={(event) => { setInputImagePath(event.currentTarget.value) }}
              />
            </Field>
            {rule?.supportsReferenceMedia === true && (
              <Field label={t('videoLastFrameLabel')} id="dshm-video-last-frame">
                <input
                  id="dshm-video-last-frame"
                  className="dshm-video-input"
                  type="text"
                  value={lastFrameImagePath}
                  onChange={(event) => { setLastFrameImagePath(event.currentTarget.value) }}
                />
              </Field>
            )}

            {rule?.supportsReferenceMedia === true && (
              <>
                <Field label={t('videoReferenceImagesLabel')} id="dshm-video-ref-images">
                  <textarea
                    id="dshm-video-ref-images"
                    className="dshm-video-input dshm-video-textarea"
                    rows={2}
                    value={referenceImages}
                    onChange={(event) => { setReferenceImages(event.currentTarget.value) }}
                  />
                </Field>
                <Field label={t('videoReferenceVideosLabel')} id="dshm-video-ref-videos">
                  <textarea
                    id="dshm-video-ref-videos"
                    className="dshm-video-input dshm-video-textarea"
                    rows={2}
                    value={referenceVideos}
                    onChange={(event) => { setReferenceVideos(event.currentTarget.value) }}
                  />
                </Field>
                <Field label={t('videoReferenceVideoDurationsLabel')} id="dshm-video-ref-video-durations">
                  <textarea
                    id="dshm-video-ref-video-durations"
                    className="dshm-video-input dshm-video-textarea"
                    rows={2}
                    value={referenceVideoDurations}
                    onChange={(event) => { setReferenceVideoDurations(event.currentTarget.value) }}
                  />
                </Field>
                <Field label={t('videoReferenceAudiosLabel')} id="dshm-video-ref-audios">
                  <textarea
                    id="dshm-video-ref-audios"
                    className="dshm-video-input dshm-video-textarea"
                    rows={2}
                    value={referenceAudios}
                    onChange={(event) => { setReferenceAudios(event.currentTarget.value) }}
                  />
                </Field>
              </>
            )}
          </div>

          {/*
            校验问题只列**本地能确定会被拒**的那几条。提示词为空单列，因为它是
            唯一挡住提交的理由（按钮本身也是靠它置灰的）。
          */}
          {issues.filter(issue => issue.code !== 'prompt-empty').map(issue => (
            <p className="dshm-video-issue" data-tone="danger" key={issue.code}>{issueText(issue, t)}</p>
          ))}
          {notice !== null && (
            <p className="dshm-video-issue" data-tone={notice.tone} role="status">{notice.text}</p>
          )}
        </div>

        <div className="dshm-video-modal-foot">
          <button type="button" className="dsha-btn" onClick={onClose}>{t('videoCancel')}</button>
          <button
            type="button"
            className="dsha-btn dsha-btn-primary"
            disabled={!submittable}
            onClick={submit}
          >
            {t('videoSubmit')}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}

/** 预设档：popupSelect 的每一行，都是**实测合法**的组合。 */
export interface VideoPreset {
  readonly id: string
  readonly model: MinimaxVideoModel
  readonly ratio: MinimaxVideoRatio | undefined
  readonly durationSeconds: number
  readonly resolution: MinimaxVideoResolution
}

/**
 * 预设档表。
 *
 * 每一行都是「模型 × 比例 × 时长 × 分辨率」的一个**实测合法**组合：
 *
 * - H3：4-15 秒、768P/2K；H3-Max：5-15 秒、480P/768P；Hailuo：6 或 10 秒、768P/1080P；
 * - 比例是纯文本分支，所以 `adaptive` 一律不出现（那是首帧/参考媒体的分支才会有的值）。
 *
 * 时长都取各模型的下界，理由与 {@link defaultDuration} 相同：第一档应当是最便宜的
 * 一次生成。用户要别的组合，走「自定义…」。
 */
export function videoPresets(t: Translate): readonly { readonly preset: VideoPreset; readonly label: string }[] {
  const rows: { preset: VideoPreset; label: string }[] = []
  for (const rule of VIDEO_MODEL_RULES) {
    const duration = defaultDuration(rule.model)
    const resolution = defaultResolution(rule.model)
    if (duration === undefined || resolution === undefined) continue
    // 纯文本比例：H3 家族默认 16:9，Hailuo 不给（服务端用它自己的默认）。这里
    // 统一按「16:9 会真的发出去」与否决定写不写进标签。
    const ratio: MinimaxVideoRatio | undefined = rule.isH3Family ? '16:9' : undefined
    rows.push({
      preset: { id: rule.model + ':' + String(duration) + ':' + resolution, model: rule.model, ratio, durationSeconds: duration, resolution },
      label: rule.model + ' · ' + String(duration) + t('videoDurationUnit') + ' · ' + resolution
        + (ratio === undefined ? '' : ' · ' + ratio),
    })
  }
  return rows
}

/** 默认的一档：H3 的合法下界，也就是 {@link DEFAULT_MINIMAX_VIDEO_MODEL} 自己的默认值。 */
export function defaultPreset(): VideoPreset | undefined {
  const rule = videoModelRule(DEFAULT_MINIMAX_VIDEO_MODEL)
  const duration = defaultDuration(DEFAULT_MINIMAX_VIDEO_MODEL)
  const resolution = defaultResolution(DEFAULT_MINIMAX_VIDEO_MODEL)
  if (rule === undefined || duration === undefined || resolution === undefined) return undefined
  return {
    id: DEFAULT_MINIMAX_VIDEO_MODEL + ':' + String(duration) + ':' + resolution,
    model: DEFAULT_MINIMAX_VIDEO_MODEL,
    ratio: rule.isH3Family ? '16:9' : undefined,
    durationSeconds: duration,
    resolution,
  }
}
