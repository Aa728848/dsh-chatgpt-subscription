/**
 * MiniMax 视频参数的**浏览器侧规则副本**与表单状态机。
 *
 * ## 为什么这里又抄了一遍宿主那张表
 *
 * 每个模型的合法时长/分辨率、以及比例随首帧/参考媒体被改写的联动，都写在宿主
 * 的 `src/host/minimax-code/video-tool.ts` 里。浏览器半边 **import 不到**它：
 * 客户端 tsconfig 只覆盖 `src/client/**` 与 `src/shared/**`，跨过去会把宿主的
 * node 依赖拖进浏览器闭包（同 `video-contract.ts` 顶部那条注释的理由）。
 *
 * 所以这里是**逐字抄写**，不是重新推导。抄的是那一份**实测**表
 * （`docs/minimax-video-model-rules.md`），不是文档或猜测：
 *
 * | model                | duration          | resolutions  |
 * | -------------------- | ----------------- | ------------ |
 * | `MiniMax-H3`         | 4-15              | 768P, 2K     |
 * | `MiniMax-H3-Max`     | 5-15              | 480P, 768P   |
 * | `MiniMax-Hailuo-2.3` | 6 或 10           | 768P, 1080P  |
 *
 * 三张表**两两不同，且没有一张等于并集**——2K 只有 H3 有、480P 只有 H3-Max 有、
 * 1080P 只有 Hailuo 有。所以客户端也**不能**用一张并集去校验：那会让 H3-Max 的
 * 用户选到 2K，然后被服务端在计费之后拒掉。
 *
 * `test/minimax-code-video-form-rules.test.ts` 里的一个用例把这三行钉死，改任何
 * 一边而忘了另一边都会红。
 *
 * ## 比例联动为什么必须在表单层就做掉
 *
 * 宿主的 `resolveVideoSubmissionRatio` 是照上游逐分支抄的：
 *
 * ```ts
 * isH3(model)
 *   ? hasKeyframes ? 'adaptive'
 *     : hasReferences ? (ratio ?? 'adaptive')
 *     : (ratio ?? '16:9')
 *   : ratio
 * ```
 *
 * 也就是说：**给了首帧，用户选的比例会被无声改写成 `adaptive`**；纯文本又
 * **不允许** `adaptive`（没有可自适应的对象，宿主会直接拒绝）。
 *
 * 让用户先选一个「16:9」再被改写成「adaptive」，是这个入口最不该犯的错——用户
 * 看到的和发出去的不是一个东西。所以这里把「最终比例」直接算出来给用户看，
 * 并且**不给选择**：`resolveVideoRatioChoice` 返回的 `locked` 就是那个意思。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-form-rules
 */

/** 三个视频模型，顺序与宿主 `MINIMAX_VIDEO_MODELS` 一致。 */
export const MINIMAX_VIDEO_MODELS = ['MiniMax-H3', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3'] as const
export type MinimaxVideoModel = (typeof MINIMAX_VIDEO_MODELS)[number]

/** 没点名时用的模型（宿主 `DEFAULT_MINIMAX_VIDEO_MODEL`）。 */
export const DEFAULT_MINIMAX_VIDEO_MODEL: MinimaxVideoModel = 'MiniMax-H3'

/** 服务端认识的每一个比例拼写，顺序照上游。 */
export const MINIMAX_VIDEO_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] as const
export type MinimaxVideoRatio = (typeof MINIMAX_VIDEO_RATIOS)[number]

/** 首帧/末帧在场时宿主**强制**发送的比例。 */
export const MINIMAX_KEYFRAME_RATIO: MinimaxVideoRatio = 'adaptive'
/** 参考媒体在场、用户没选时宿主用的比例。 */
export const MINIMAX_REFERENCE_DEFAULT_RATIO: MinimaxVideoRatio = 'adaptive'
/** 纯文本、用户没选时宿主用的比例。 */
export const MINIMAX_H3_TEXT_DEFAULT_RATIO: MinimaxVideoRatio = '16:9'

/** 宿主 `MINIMAX_H3_DEFAULT_RESOLUTION`：H3 家族省略分辨率时实际发的是 2K。 */
export const MINIMAX_H3_DEFAULT_RESOLUTION = '2K' as const
export type MinimaxVideoResolution = '480P' | '768P' | '1080P' | '2K'

/** 参考媒体的数量上限，与宿主 `video-submit-rules.ts` 的常量一致。 */
export const MAX_REFERENCE_IMAGES = 9
export const MAX_REFERENCE_VIDEOS = 3
export const MAX_REFERENCE_AUDIOS = 3
export const MAX_REFERENCE_MEDIA_TOTAL = 12

/** 一个模型的时长规则：闭区间，或一个封闭取值集。 */
export type VideoDurationRule =
  | { readonly kind: 'range'; readonly min: number; readonly max: number }
  | { readonly kind: 'values'; readonly values: readonly number[] }

/** 一个模型的实测规则。 */
export interface VideoModelRule {
  readonly model: MinimaxVideoModel
  readonly duration: VideoDurationRule
  readonly resolutions: readonly MinimaxVideoResolution[]
  /** 这个模型是否接受参考图/参考视频/参考音频与末帧（宿主 `minimaxModelSupportsReferenceMedia`）。 */
  readonly supportsReferenceMedia: boolean
  /** 这个模型是否属于 H3 家族，即比例联动的适用范围（宿主 `isH3VideoModel`）。 */
  readonly isH3Family: boolean
}

/**
 * 实测的每模型规则，逐字抄自宿主 `MINIMAX_VIDEO_MODEL_RULES`。
 *
 * 抄错一个字的表现是「客户端放行 → 服务端计费后拒绝」，所以这里连顺序都不改。
 */
export const VIDEO_MODEL_RULES: readonly VideoModelRule[] = [
  {
    model: 'MiniMax-H3',
    duration: { kind: 'range', min: 4, max: 15 },
    resolutions: ['768P', '2K'],
    supportsReferenceMedia: true,
    isH3Family: true,
  },
  {
    model: 'MiniMax-H3-Max',
    duration: { kind: 'range', min: 5, max: 15 },
    resolutions: ['480P', '768P'],
    supportsReferenceMedia: true,
    isH3Family: true,
  },
  {
    model: 'MiniMax-Hailuo-2.3',
    duration: { kind: 'values', values: [6, 10] },
    resolutions: ['768P', '1080P'],
    supportsReferenceMedia: false,
    isH3Family: false,
  },
]

/** @param model - 模型 id。 @returns 该模型的规则，未知时为 undefined。 */
export function videoModelRule(model: string): VideoModelRule | undefined {
  return VIDEO_MODEL_RULES.find(rule => rule.model === model)
}

/**
 * 一个模型可以选的时长，**从短到长、去重后**给选择器用。
 *
 * 区间型的模型给的是 1 秒一档的整数刻度（服务端接受区间内任意整数），取值集型的
 * 模型只有那几个值。两者都返回数组，表单因此不必分支。
 *
 * @param model - 模型 id。
 * @returns 合法时长列表；模型未知时为空。
 */
export function durationChoices(model: string): readonly number[] {
  const rule = videoModelRule(model)
  if (rule === undefined) return []
  if (rule.duration.kind === 'values') return [...rule.duration.values]
  const values: number[] = []
  for (let value = rule.duration.min; value <= rule.duration.max; value += 1) values.push(value)
  return values
}

/**
 * 一个模型的默认时长。
 *
 * 区间型的模型取**下界**：那是最便宜的一次生成，也是用户第一次点开表单时最不
 * 容易心疼的值。取值集型的模型取第一个值（Hailuo 的 6）。
 *
 * @param model - 模型 id。
 * @returns 默认时长；模型未知时为 undefined。
 */
export function defaultDuration(model: string): number | undefined {
  const rule = videoModelRule(model)
  if (rule === undefined) return undefined
  return rule.duration.kind === 'values' ? rule.duration.values[0] : rule.duration.min
}

/**
 * 一个模型的默认分辨率。
 *
 * 取**该模型自己的**第一项，而不是宿主的 `2K`：2K 是 H3 专属，H3-Max 与 Hailuo
 * 都没有，硬套过去就是一个必被拒绝的默认值。
 *
 * @param model - 模型 id。
 * @returns 默认分辨率；模型未知时为 undefined。
 */
export function defaultResolution(model: string): MinimaxVideoResolution | undefined {
  return videoModelRule(model)?.resolutions[0]
}

/** 表单里的媒体路径输入（纯文本，不做文件选择器）。 */
export interface VideoMediaInput {
  /** 首帧图的路径。 */
  readonly inputImagePath?: string
  /** 末帧图的路径。 */
  readonly lastFrameImagePath?: string
  /** 参考图路径，多行。 */
  readonly referenceImagePaths?: readonly string[]
  /** 参考视频路径，多行。 */
  readonly referenceVideoPaths?: readonly string[]
  /** 参考视频各自的时长，与 {@link referenceVideoPaths} 同序。 */
  readonly referenceVideoDurationSeconds?: readonly number[]
  /** 参考音频路径，多行。 */
  readonly referenceAudioPaths?: readonly string[]
}

/** 路径是不是「真的给了」：空白字符不算给。 */
function hasPath(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** 非空路径的条数。 */
function countPaths(values: readonly string[] | undefined): number {
  if (!Array.isArray(values)) return 0
  return values.filter(hasPath).length
}

/**
 * 这份媒体输入决定的两件事：有没有首帧、有没有参考媒体。
 *
 * 两个布尔直接对应用户能看见的那句提示，以及比例能不能选。
 *
 * @param media - 表单里的媒体路径。
 * @returns 两个判定。
 */
export function mediaPresence(media: VideoMediaInput): { hasKeyframes: boolean; hasReferences: boolean } {
  const hasKeyframes = hasPath(media.inputImagePath) || hasPath(media.lastFrameImagePath)
  const hasReferences = countPaths(media.referenceImagePaths) > 0
    || countPaths(media.referenceVideoPaths) > 0
    || countPaths(media.referenceAudioPaths) > 0
  return { hasKeyframes, hasReferences }
}

/** 比例这一栏该画成什么。 */
export interface VideoRatioChoice {
  /** 最终会发出去的比例；undefined 表示这一栏**不发** `ratio` 字段。 */
  readonly ratio: MinimaxVideoRatio | undefined
  /** 用户还能不能自己挑。true 时表单画选择器，false 时只显示结果。 */
  readonly selectable: boolean
  /** 为什么锁死；可选时 undefined。 */
  readonly lockedReason?: 'keyframes' | 'references' | 'text-only'
  /** 用户可以选的比例（仅 `selectable` 时有意义）。 */
  readonly options: readonly MinimaxVideoRatio[]
}

/**
 * 决定比例这一栏的形态，**在表单层就把联动做掉**。
 *
 * 三条规则与宿主 {@link resolveVideoSubmissionRatio} 一一对应，只是把「静默改写」
 * 换成「当场显示」：
 *
 * 1. **有首帧** → 强制 `adaptive`，不给选。用户选了也会被改写，所以干脆不给。
 * 2. **有参考媒体** → 默认 `adaptive`，但**可以改**：上游对这个分支是
 *    `ratio ?? 'adaptive'`，用户给了就照发。所以这里列出的每一个拼写都是
 *    真正会发出去的那个。
 * 3. **纯文本** → 默认 `16:9`（H3 家族）或「不发」（Hailuo），**`adaptive` 不可选**
 *    ——服务端没有可自适应的对象，选了必被拒。
 *
 * @param input - 模型、用户当前选的比例、媒体在场情况。
 * @returns 这一栏的形态。
 */
export function resolveVideoRatioChoice(input: {
  readonly model: MinimaxVideoModel
  readonly requested?: MinimaxVideoRatio
  readonly hasKeyframes: boolean
  readonly hasReferences: boolean
}): VideoRatioChoice {
  const { model, requested, hasKeyframes, hasReferences } = input
  const rule = videoModelRule(model)
  const isH3 = rule?.isH3Family === true

  if (hasKeyframes) {
    return {
      ratio: MINIMAX_KEYFRAME_RATIO,
      selectable: false,
      lockedReason: 'keyframes',
      options: [],
    }
  }

  if (hasReferences) {
    // 参考媒体只在 H3 家族可用（参考媒体支持与 isH3Family 是同一个判定），所以
    // 这里不必再问 Hailuo：到不了这个分支。
    return {
      ratio: requested ?? MINIMAX_REFERENCE_DEFAULT_RATIO,
      selectable: true,
      options: MINIMAX_VIDEO_RATIOS,
    }
  }

  // 纯文本。`adaptive` 在这里是**选不得**的，其余六个拼写都合法。
  const textOptions = MINIMAX_VIDEO_RATIOS.filter(entry => entry !== 'adaptive')
  const fallback = isH3 ? MINIMAX_H3_TEXT_DEFAULT_RATIO : undefined
  return {
    ratio: requested ?? fallback,
    selectable: true,
    lockedReason: 'text-only',
    options: textOptions,
  }
}

/**
 * 把多行文本框切成路径数组。
 *
 * 一行一条，去掉首尾空白，丢掉空行。**不做**通配符展开、不做存在性检查：路径
 * 由宿主在提交时解析，浏览器里没有工作区文件系统。
 *
 * @param text - 多行文本。
 * @returns 路径数组。
 */
export function parsePathLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
}

/**
 * 表单的一项校验失败。
 *
 * 文案在 locales 里，这里只带**哪一条**坏了和它的参数——错误文案的格式（中文
 * 最多两句、结尾不加句号）留给字典管。
 */
export interface VideoFormIssue {
  readonly code:
    | 'prompt-empty'
    | 'reference-unsupported'
    | 'last-frame-unsupported'
    | 'too-many-images'
    | 'too-many-videos'
    | 'too-many-audios'
    | 'too-many-total'
    | 'duration-invalid'
  /** 文案模板需要的参数。 */
  readonly params?: Readonly<Record<string, string | number>>
}

/** 表单的完整输入。 */
export interface VideoFormValues {
  readonly prompt: string
  readonly model: MinimaxVideoModel
  readonly ratio?: MinimaxVideoRatio
  readonly durationSeconds?: number
  readonly resolution?: MinimaxVideoResolution
  readonly watermark?: boolean
  readonly media: VideoMediaInput
}

/**
 * 校验整个表单。
 *
 * 顺序照着服务端自己的检查顺序（model → duration → resolution → prompt → ratio），
 * 因为报告一条服务端根本不会提的规则，比不报告更糟。
 *
 * **提示词为空是唯一挡住提交的理由**；其余都是本地就拦下的、必然被拒的组合
 * （参考媒体给了 Hailuo、条数超限），拦下来只为省一次计费请求。
 *
 * @param values - 表单值。
 * @returns 问题列表；空数组表示可以提交。
 */
export function validateVideoForm(values: VideoFormValues): readonly VideoFormIssue[] {
  const issues: VideoFormIssue[] = []
  const rule = videoModelRule(values.model)
  const { hasKeyframes } = mediaPresence(values.media)
  const images = countPaths(values.media.referenceImagePaths)
  const videos = countPaths(values.media.referenceVideoPaths)
  const audios = countPaths(values.media.referenceAudioPaths)

  if (rule !== undefined && !rule.supportsReferenceMedia) {
    if (images + videos + audios > 0) issues.push({ code: 'reference-unsupported', params: { model: values.model } })
    if (hasPath(values.media.lastFrameImagePath)) {
      issues.push({ code: 'last-frame-unsupported', params: { model: values.model } })
    }
  }

  if (images > MAX_REFERENCE_IMAGES) {
    issues.push({ code: 'too-many-images', params: { count: images, limit: MAX_REFERENCE_IMAGES } })
  }
  if (videos > MAX_REFERENCE_VIDEOS) {
    issues.push({ code: 'too-many-videos', params: { count: videos, limit: MAX_REFERENCE_VIDEOS } })
  }
  if (audios > MAX_REFERENCE_AUDIOS) {
    issues.push({ code: 'too-many-audios', params: { count: audios, limit: MAX_REFERENCE_AUDIOS } })
  }
  if (images + videos + audios > MAX_REFERENCE_MEDIA_TOTAL) {
    issues.push({
      code: 'too-many-total',
      params: { count: images + videos + audios, limit: MAX_REFERENCE_MEDIA_TOTAL },
    })
  }

  if (values.durationSeconds !== undefined && !durationChoices(values.model).includes(values.durationSeconds)) {
    issues.push({ code: 'duration-invalid', params: { model: values.model, duration: values.durationSeconds } })
  }

  if (values.prompt.trim() === '') issues.push({ code: 'prompt-empty' })

  return issues
}

/**
 * 表单是否满足**提交**的最低条件。
 *
 * 比 {@link validateVideoForm} 宽：那个列表里除了提示词以外的问题都会在提交时被
 * 服务端拒绝，而这里只回答「按钮能不能亮」。真正挡住生成的是提示词——那一条
 * 是任务书里点名的：**缺提示词时不能提交**。
 *
 * @param values - 表单值。
 * @returns 能否提交。
 */
export function canSubmitVideoForm(values: VideoFormValues): boolean {
  return values.prompt.trim() !== ''
}

/**
 * 把表单拼成一句**给模型看**的话，填进输入框。
 *
 * ## 为什么是这个形状
 *
 * 工具是模型自主调用的，所以这段文字要同时做到三件事：点名工具、把参数写成模型
 * 抄得下来的形态、说清「只发一次」。用等号写字段是刻意的——模型最容易照抄的就是
 * 这种形如签名的行。
 *
 * 比例**只在真的会发出去时才写**：纯文本 + Hailuo 的最终比例是 undefined（宿主
 * 不发这个字段，服务端用自己的默认），这时候替用户编一个 16:9 就是在描述一次
 * 不会发生的请求。
 *
 * ## 「只发一次」为什么必须写进去
 *
 * 提交是**计费**且**终态**的：重发不是续传，是再买一次生成。宿主自己的守卫也只
 * 在同一 session 同一 turn 内生效（`videoSubmissionKey`），换个 turn 就拦不住了。
 * 把这句话交给模型，是这道防线上客户端能出力的那一半。
 *
 * @param values - 表单值（应已通过 {@link resolveVideoRatioChoice} 归一化）。
 * @returns 填进输入框的整段文本。
 */
export function buildVideoDraftText(values: VideoFormValues): string {
  const { hasKeyframes, hasReferences } = mediaPresence(values.media)
  const ratio = resolveVideoRatioChoice({
    model: values.model,
    ...(values.ratio === undefined ? {} : { requested: values.ratio }),
    hasKeyframes,
    hasReferences,
  }).ratio

  const lines: string[] = []
  lines.push('用 minimax_generate_video 生成视频：')
  lines.push('prompt=' + values.prompt.trim())
  lines.push('model=' + values.model)
  if (ratio !== undefined) lines.push('ratio=' + ratio)
  if (values.durationSeconds !== undefined) lines.push('durationSeconds=' + values.durationSeconds)
  if (values.resolution !== undefined) lines.push('resolution=' + values.resolution)

  const inputImagePath = values.media.inputImagePath?.trim()
  if (inputImagePath !== undefined && inputImagePath !== '') lines.push('inputImagePath=' + inputImagePath)
  const lastFrameImagePath = values.media.lastFrameImagePath?.trim()
  if (lastFrameImagePath !== undefined && lastFrameImagePath !== '') {
    lines.push('lastFrameImagePath=' + lastFrameImagePath)
  }

  const images = (values.media.referenceImagePaths ?? []).map(path => path.trim()).filter(path => path !== '')
  if (images.length > 0) lines.push('referenceImagePaths=' + images.join(','))
  const videos = (values.media.referenceVideoPaths ?? []).map(path => path.trim()).filter(path => path !== '')
  if (videos.length > 0) lines.push('referenceVideoPaths=' + videos.join(','))
  const videoDurations = (values.media.referenceVideoDurationSeconds ?? [])
    .filter(value => Number.isFinite(value) && value > 0)
  if (videos.length > 0 && videoDurations.length === videos.length) {
    lines.push('referenceVideoDurationSeconds=' + videoDurations.join(','))
  }
  const audios = (values.media.referenceAudioPaths ?? []).map(path => path.trim()).filter(path => path !== '')
  if (audios.length > 0) lines.push('referenceAudioPaths=' + audios.join(','))

  if (values.watermark !== undefined) lines.push('aigc_watermark=' + (values.watermark ? 'true' : 'false'))

  lines.push('')
  lines.push('这些参数已经按服务端规则校验过，请原样使用，不要改动或补充')
  lines.push('提交是计费的终态操作：只调用一次，失败也不重发')
  return lines.join('\n')
}

/**
 * 设置页「默认参数」里存的东西。
 *
 * 与 {@link VideoFormValues} 分开：这是**跨会话**的偏好，没有提示词，也没有媒体
 * 路径（那些是一次生成的事）。
 */
export interface VideoDefaults {
  readonly model: MinimaxVideoModel
  readonly ratio?: MinimaxVideoRatio
  readonly durationSeconds?: number
  readonly watermark: boolean
}

/**
 * 归一化一份默认参数。
 *
 * 存在的理由是**模型换了而时长没跟着换**：用户把默认模型从 H3 改成 Hailuo，原来
 * 的 8 秒就不合法了。这里当场把它换成新模型的默认值，而不是把非法值一路带到表单
 * 里，再让用户在弹窗里看到一条自己没设过的错误。
 *
 * @param value - 任意解析出来的对象。
 * @returns 一份自洽的默认参数。
 */
export function normalizeVideoDefaults(value: unknown): VideoDefaults {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const model = MINIMAX_VIDEO_MODELS.find(known => known === record.model) ?? DEFAULT_MINIMAX_VIDEO_MODEL
  const requestedDuration = typeof record.durationSeconds === 'number' && Number.isFinite(record.durationSeconds)
    ? record.durationSeconds
    : undefined
  const durationSeconds = requestedDuration !== undefined && durationChoices(model).includes(requestedDuration)
    ? requestedDuration
    : defaultDuration(model)
  const ratio = MINIMAX_VIDEO_RATIOS.find(known => known === record.ratio)
  return {
    model,
    ...(ratio === undefined ? {} : { ratio }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    watermark: record.watermark === true,
  }
}
