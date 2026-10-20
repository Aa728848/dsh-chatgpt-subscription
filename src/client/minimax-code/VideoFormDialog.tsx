/**
 * `/video` 的参数面板：写一句描述，选好参数，再把它填进输入框。
 *
 * ## 形态：没有遮罩的浮层，而不是遮住整页的对话框
 *
 * 这里曾经盖一层半透明遮罩，整页随之变灰——用户看着像被弹窗劫持了。视频生成
 * 只是「给下一条消息配参数」，它不该把整个对话压暗。所以现在只有一块带阴影的
 * 浮层：点面板外仍然关闭（有边界检查），Escape 仍然关闭，但没有遮罩、没有
 * 背景变灰，对话内容照常可读。
 *
 * ## 布局：从「一排排表单」改成「先说画面，再说参数」
 *
 * 原先是 9 个同权重的字段竖着排下来，用户第一眼看到的是「模型 / 时长 / 分辨率」
 * 这些次要决定。现在分成三段，按用户真正的思考顺序：
 *
 * 1. **描述**——面板里最大的一块，也是唯一必填的东西；
 * 2. **档位胶囊 + 一行参数**——常见组合一键就能定，细调折叠在「更多参数」里；
 * 3. **参考媒体**——四类媒体块，支持浏览、拖拽、粘贴。
 *
 * ## 关键行为：它**不发送**，只把参数写进输入框
 *
 * 视频参数有联动规则（给了首帧→比例被强制改成 `adaptive`；纯文本→`adaptive`
 * 不可选），如果直接发起生成，用户永远看不到自己填的东西被改成了什么。所以这里
 * 只调用 `onSubmit`，把 {@link buildVideoDraftText} 拼出来的那段话放进输入框。
 *
 * ## 弹窗怎么落地
 *
 * 宿主有 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`，但**本插件不依赖那个
 * 包的运行时**（`progress-updates/markdown-lite.tsx:6` 记录了这个决定），所以这里
 * 自己 portal 到 `document.body`：无遮罩浮层 + `role="dialog"` + Escape 关闭 +
 * 点浮层外关闭。portal 到 body 是必须的——输入框所在的那片容器有 `overflow`，
 * 就地渲染会被裁掉。
 *
 * ## 键盘可达性
 *
 * 浮层带 `tabIndex={-1}` 并在打开时聚焦，Tab 因此从面板内部开始按 DOM 顺序走遍
 * 每个字段；Escape 关闭（`keydown` 捕获阶段处理，输入框里的 Escape 也生效）；
 * 关闭后焦点还给打开它的元素。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-form-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MINIMAX_VIDEO_MODELS,
  buildVideoDraftText,
  canSubmitVideoForm,
  defaultDuration,
  defaultResolution,
  durationChoices,
  mediaPresence,
  normalizeVideoDefaults,
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
import { presetIdOf, videoPresets } from './video-presets.ts'
import { MediaDropZone } from './video-media-dropzone.tsx'
import { mediaNameOf, needsDuration } from './video-media-input.ts'
import type { WorkspaceLister } from './video-workspace.ts'
import type { MinimaxCodeLocaleKey } from './locales.ts'

// 老调用方（以及文档）仍然可以从面板模块取这张表；定义已经搬进 video-presets.ts。
export { defaultPreset, videoPresets, type VideoPreset } from './video-presets.ts'

/** 翻译函数的座位：参数化的键允许带模板参数。 */
export type Translate = (key: MinimaxCodeLocaleKey, params?: Record<string, string | number>) => string

/** 弹窗的全部入参。 */
export interface VideoFormDialogProps {
  /** 是否显示。 */
  readonly open: boolean
  /** 关闭（Escape、点浮层外、取消按钮都走这里）。 */
  readonly onClose: () => void
  /**
   * 提交：把拼好的那段话交给调用方。
   *
   * **返回 false 表示没有填进去**（这个会话没有输入框），弹窗据此显示一句错误而
   * 不是假装成功。
   */
  readonly onSubmit: (text: string) => boolean
  /** 初始值：设置页里的默认参数。 */
  readonly defaults?: VideoDefaults
  /**
   * 打开时输入框里已有的文字。
   *
   * 有的话直接当成画面描述带进来——用户常常先写了一句话才想起要用面板，把那段
   * 话再抄一遍是最没必要的一次劳动。
   */
  readonly seedPrompt?: string
  /**
   * 列出工作区目录，供媒体块的 `@` 补全。
   *
   * 缺席时媒体块退化为「拖拽 / 粘贴 / 手填路径」，不报错。
   */
  readonly listWorkspace?: WorkspaceLister | undefined
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

/**
 * 参数面板。
 *
 * 受控到组件内部：`/video` 只负责开与关，表单状态活在这里，关闭即丢弃——一次
 * 生成填一次参数，没有「上次填到一半」的语义要维护。
 */
export function VideoFormDialog({
  open, onClose, onSubmit, defaults, seedPrompt, listWorkspace, t,
}: VideoFormDialogProps): React.JSX.Element | null {
  const seeded = useMemo(() => normalizeVideoDefaults(defaults ?? {}), [defaults])
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<MinimaxVideoModel>(seeded.model)
  const [ratio, setRatio] = useState<MinimaxVideoRatio | undefined>(seeded.ratio)
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(seeded.durationSeconds)
  const [resolution, setResolution] = useState<MinimaxVideoResolution | undefined>(defaultResolution(seeded.model))
  const [watermark, setWatermark] = useState(seeded.watermark)
  const [advanced, setAdvanced] = useState(false)
  const [seededPrompt, setSeededPrompt] = useState(false)
  const [inputImagePath, setInputImagePath] = useState<string[]>([])
  const [lastFrameImagePath, setLastFrameImagePath] = useState<string[]>([])
  const [referenceImages, setReferenceImages] = useState<string[]>([])
  const [referenceVideos, setReferenceVideos] = useState<string[]>([])
  const [referenceAudios, setReferenceAudios] = useState<string[]>([])
  // 远端参考视频读不到时长，只能由用户给：key 是路径，值是输入的原文。
  const [remoteDurations, setRemoteDurations] = useState<Record<string, string>>({})
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
  //    所以不重置的话，用户取消一次、再打开会看到上一轮的残留。
  // 2. 记住「是谁打开的」，关闭时把焦点还回去。
  // 3. 把焦点送进面板；输入框里已有的文字当成画面描述带进来。
  useEffect(() => {
    if (!open) return
    const seed = normalizeVideoDefaults(defaults ?? {})
    const carried = seedPrompt?.trim() ?? ''
    setPrompt(carried)
    setSeededPrompt(carried !== '')
    setModel(seed.model)
    setRatio(seed.ratio)
    setDurationSeconds(seed.durationSeconds)
    setResolution(defaultResolution(seed.model))
    setWatermark(seed.watermark)
    setAdvanced(false)
    setInputImagePath([])
    setLastFrameImagePath([])
    setReferenceImages([])
    setReferenceVideos([])
    setReferenceAudios([])
    setRemoteDurations({})
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

  const media = useMemo(() => {
    // 时长数组是**按位置**配对的（宿主 `prepareGenerationMedia` 里逐项对齐），
    // 所以要么给出与视频同样多的一整串，要么一个都不给——不能只给后半段。
    const durations = referenceVideos.map(path => Number(remoteDurations[path] ?? ''))
    const everyOne = referenceVideos.length > 0 && durations.every(value => Number.isFinite(value) && value > 0)
    return {
      ...(inputImagePath.length === 0 ? {} : { inputImagePath: inputImagePath[0] }),
      ...(lastFrameImagePath.length === 0 ? {} : { lastFrameImagePath: lastFrameImagePath[0] }),
      referenceImagePaths: referenceImages,
      referenceVideoPaths: referenceVideos,
      ...(everyOne ? { referenceVideoDurationSeconds: durations } : {}),
      referenceAudioPaths: referenceAudios,
    }
  }, [inputImagePath, lastFrameImagePath, referenceImages, referenceVideos, referenceAudios, remoteDurations])

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
  const presets = useMemo(() => videoPresets(t), [t])
  const activePreset = presetIdOf({ model, durationSeconds, resolution })

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

  const applyPreset = useCallback((preset: {
    readonly model: MinimaxVideoModel
    readonly ratio: MinimaxVideoRatio | undefined
    readonly durationSeconds: number
    readonly resolution: MinimaxVideoResolution
  }) => {
    setModel(preset.model)
    setRatio(preset.ratio)
    setDurationSeconds(preset.durationSeconds)
    setResolution(preset.resolution)
    setNotice(null)
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
  }, [onClose, onSubmit, submittable, t, values, resolution])

  if (!open) return null

  const referenceCapable = rule?.supportsReferenceMedia === true

  return createPortal((
    <div
      className="dshm-video-modal-root"
      role="presentation"
      onMouseDown={(event) => {
        // 没有遮罩了，所以「点外面关闭」靠边界检查：按下点落在浮层之外才算。
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="dshm-video-modal"
        role="dialog"
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

        <div className="dshm-video-modal-body">
          {/*
            两栏：左边只放「画面描述」，右边是参数与参考媒体。描述是唯一必填的东
            西，给它一整栏；参数是若干互不相干的选择，挤在一栏里反而更快扫完。
            窄屏（≤720px）时两栏摞回一栏，顺序仍是先描述、后参数。
          */}
          <div className="dshm-video-columns">
            <div className="dshm-video-col-main">
              <div className="dshm-video-field">
                <div className="dshm-video-prompt-head">
                  <label className="dshm-video-field-label" htmlFor={promptId}>{t('videoPromptLabel')}</label>
                  {seededPrompt && <span className="dshm-video-hint">{t('videoPromptFromComposer')}</span>}
                </div>
                <textarea
                  ref={promptRef}
                  id={promptId}
                  className="dshm-video-input dshm-video-prompt"
                  rows={8}
                  placeholder={t('videoPromptPlaceholder')}
                  value={prompt}
                  onChange={(event) => { setPrompt(event.currentTarget.value); setSeededPrompt(false); setNotice(null) }}
                />
              </div>
            </div>

            <div className="dshm-video-col-side">
          {/*
            档位胶囊：常见组合一键定下来。数量随模型表走（现在是 3 档），所以不
            做成「固定三个按钮」，而是从表里长出来——加一个模型只需要改那张表。
          */}
          <div className="dshm-video-field">
            <span className="dshm-video-field-label">{t('videoTierLabel')}</span>
            <div className="dshm-video-tiers" role="group" aria-label={t('videoTierLabel')}>
              {presets.map(({ preset, label, title }) => (
                <button
                  key={preset.id}
                  type="button"
                  className="dshm-video-tier"
                  aria-pressed={activePreset === preset.id}
                  title={title}
                  aria-label={title}
                  onClick={() => { applyPreset(preset) }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="dshm-video-field-row">
            <div className="dshm-video-field">
              <label className="dshm-video-field-label" htmlFor={modelId}>{t('videoModelLabel')}</label>
              <select
                id={modelId}
                className="dshm-video-input"
                value={model}
                onChange={(event) => { onModelChange(event.currentTarget.value as MinimaxVideoModel) }}
              >
                {MINIMAX_VIDEO_MODELS.map(entry => <option key={entry} value={entry}>{entry}</option>)}
              </select>
            </div>

            <div className="dshm-video-field">
              <label className="dshm-video-field-label" htmlFor={durationId}>{t('videoDurationLabel')}</label>
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
            </div>

            <div className="dshm-video-field">
              <label className="dshm-video-field-label" htmlFor={resolutionId}>{t('videoResolutionLabel')}</label>
              {/*
                分辨率这一栏只有模型自己的合法集：三个模型的集合两两不同，用一张
                并集去列会让 H3-Max 的用户选到 2K，然后被服务端在计费之后拒掉。
                H3 家族的省略值不是「不发」而是 2K（宿主 resolveVideoSubmissionResolution），
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
            </div>
          </div>

          {/*
            比例这一栏有两种形态，由 resolveVideoRatioChoice 决定：
            - 锁死（给了首帧）→ 只显示结果和一个理由，不给选；
            - 可选 → 给选择器，且纯文本时 adaptive 根本不在选项里。
            这一条就是「不给用户选一个会被改写的比例」的落点。
          */}
          <div className="dshm-video-field dshm-video-ratio">
            <label className="dshm-video-field-label" htmlFor={ratioId}>{t('videoRatioLabel')}</label>
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
          </div>

          {/*
            「更多参数」：水印与参考媒体。默认收起——它们都不是每次都要改的东西，
            竖着摊开会把唯一必填的「画面描述」挤到看不见。
          */}
          <button
            type="button"
            className="dshm-video-advanced"
            aria-expanded={advanced}
            onClick={() => { setAdvanced(current => !current) }}
          >
            <span className="dshm-video-advanced-caret" aria-hidden="true">{advanced ? '▾' : '▸'}</span>
            {t('videoAdvanced')}
            {(referenceImages.length + referenceVideos.length + referenceAudios.length
              + inputImagePath.length + lastFrameImagePath.length) > 0 && (
              <span className="dshm-video-advanced-count">
                {referenceImages.length + referenceVideos.length + referenceAudios.length
                  + inputImagePath.length + lastFrameImagePath.length}
              </span>
            )}
          </button>

          {advanced && (
            <div className="dshm-video-advanced-body">
              <div className="dshm-video-field dshm-video-watermark">
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

                <MediaDropZone
                  id="dshm-video-input-image"
                  label={t('videoInputImageLabel')}
                  accept="image/*"
                  multiple={false}
                  paths={inputImagePath}
                  onChange={(next) => { setInputImagePath(next.slice(0, 1)) }}
                  listWorkspace={listWorkspace}
                  t={t}
                />
                {referenceCapable && (
                  <MediaDropZone
                    id="dshm-video-last-frame"
                    label={t('videoLastFrameLabel')}
                    accept="image/*"
                    multiple={false}
                    paths={lastFrameImagePath}
                    onChange={(next) => { setLastFrameImagePath(next.slice(0, 1)) }}
                    listWorkspace={listWorkspace}
                    t={t}
                  />
                )}

                {referenceCapable && (
                  <>
                    <MediaDropZone
                      id="dshm-video-ref-images"
                      label={t('videoReferenceImagesLabel')}
                      accept="image/*"
                      paths={referenceImages}
                      onChange={(next) => { setReferenceImages([...next]) }}
                      listWorkspace={listWorkspace}
                      t={t}
                    />
                    <MediaDropZone
                      id="dshm-video-ref-videos"
                      label={t('videoReferenceVideosLabel')}
                      accept="video/*"
                      paths={referenceVideos}
                      listWorkspace={listWorkspace}
                      onChange={(next) => {
                        setReferenceVideos([...next])
                        // 移除一条就顺手丢掉它的时长，免得残留值配错下一段。
                        setRemoteDurations((current) => {
                          const kept: Record<string, string> = {}
                          for (const path of next) if (current[path] !== undefined) kept[path] = current[path]
                          return kept
                        })
                      }}
                      t={t}
                    />
                    {referenceVideos.filter(path => needsDuration(path)).length > 0 && (
                      <div className="dshm-video-durations">
                        {referenceVideos.filter(path => needsDuration(path)).map(path => (
                          <div className="dshm-video-duration-row" key={path}>
                            <label className="dshm-video-field-label" htmlFor={'dshm-video-duration-' + path}>
                              {t('videoReferenceVideoDurationOne', { name: mediaNameOf(path) })}
                            </label>
                            <input
                              id={'dshm-video-duration-' + path}
                              className="dshm-video-input"
                              type="number"
                              min={1}
                              max={15}
                              step={1}
                              placeholder={t('videoReferenceVideoDurationPlaceholder')}
                              value={remoteDurations[path] ?? ''}
                              onChange={(event) => {
                                const value = event.currentTarget.value
                                setRemoteDurations(current => ({ ...current, [path]: value }))
                              }}
                            />
                          </div>
                        ))}
                        <span className="dshm-video-hint">{t('videoReferenceVideoDurationWhy')}</span>
                      </div>
                    )}
                    <MediaDropZone
                      id="dshm-video-ref-audios"
                      label={t('videoReferenceAudiosLabel')}
                      accept="audio/*"
                      paths={referenceAudios}
                      onChange={(next) => { setReferenceAudios([...next]) }}
                      listWorkspace={listWorkspace}
                      t={t}
                    />
                  </>
                )}
              </div>
            </div>
          )}

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
          </div>
        </div>

        <div className="dshm-video-modal-foot">
          <span className="dshm-video-foot-hint">{t('videoDialogDesc')}</span>
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
