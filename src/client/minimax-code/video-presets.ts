/**
 * 预设档：一张**实测合法**的「模型 × 比例 × 时长 × 分辨率」表。
 *
 * ## 为什么从 VideoFormDialog 里搬出来
 *
 * 这张表有两个消费者：`/video` 命令（决定默认档位）和参数面板（顶部那一排档位
 * 胶囊）。它曾经和面板组件写在同一个文件里，于是命令层为了读一张常量表去 import
 * 一个 `.tsx`——那条依赖除了把组件拖进命令模块的闭包，没有任何好处。搬成纯模块
 * 之后，两边都只是读表。
 *
 * ## 每一档都必须是真能发出去的组合
 *
 * - H3：4-15 秒、768P/2K；H3-Max：5-15 秒、480P/768P；Hailuo：6 或 10 秒、768P/1080P；
 * - 比例是纯文本分支，所以 `adaptive` 一律不出现（那是首帧/参考媒体的分支才会有的值）。
 *
 * 时长都取各模型的下界，理由与 `defaultDuration` 相同：第一档应当是最便宜的
 * 一次生成。更细的组合在面板的「更多参数」里调。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-presets
 */

import {
  DEFAULT_MINIMAX_VIDEO_MODEL,
  VIDEO_MODEL_RULES,
  defaultDuration,
  defaultResolution,
  videoModelRule,
  type MinimaxVideoModel,
  type MinimaxVideoRatio,
  type MinimaxVideoResolution,
} from './video-form-rules.ts'

/** 预设档。 */
export interface VideoPreset {
  readonly id: string
  readonly model: MinimaxVideoModel
  readonly ratio: MinimaxVideoRatio | undefined
  readonly durationSeconds: number
  readonly resolution: MinimaxVideoResolution
}

/** 翻译函数的最小形状：档位标签要拼「秒」。 */
type Translate = (key: 'videoDurationUnit') => string

/**
 * 预设档表。
 *
 * ## 标签为什么分成两截
 *
 * `label` 是**胶囊上**那行字：只留区分三档所需的最少信息（模型 + 时长），因为
 * 三个全名并排放在 600px 宽的面板里必然换行，换行后胶囊高低不齐，比省掉几个字
 * 难看得多。`title` 是完整参数，挂在 `title` 与 `aria-label` 上——想确认分辨率
 * 与比例的人仍然看得到。
 *
 * @param t - 翻译函数（只需要时长单位）。
 * @returns 每一档、它的短标签与完整说明。
 */
export function videoPresets(t: Translate): readonly {
  readonly preset: VideoPreset
  readonly label: string
  readonly title: string
}[] {
  const rows: { preset: VideoPreset; label: string; title: string }[] = []
  for (const rule of VIDEO_MODEL_RULES) {
    const duration = defaultDuration(rule.model)
    const resolution = defaultResolution(rule.model)
    if (duration === undefined || resolution === undefined) continue
    // 纯文本比例：H3 家族默认 16:9，Hailuo 不给（服务端用它自己的默认）。这里
    // 统一按「16:9 会真的发出去」与否决定写不写进完整说明。
    const ratio: MinimaxVideoRatio | undefined = rule.isH3Family ? '16:9' : undefined
    const seconds = String(duration) + t('videoDurationUnit')
    rows.push({
      preset: { id: rule.model + ':' + String(duration) + ':' + resolution, model: rule.model, ratio, durationSeconds: duration, resolution },
      // 三个模型都以 MiniMax- 开头，胶囊上省掉它只丢冗余、不丢区分度。
      label: rule.model.replace(/^MiniMax-/, '') + ' · ' + seconds,
      title: rule.model + ' · ' + seconds + ' · ' + resolution + (ratio === undefined ? '' : ' · ' + ratio),
    })
  }
  return rows
}

/** 默认的一档：H3 的合法下界，也就是 `DEFAULT_MINIMAX_VIDEO_MODEL` 自己的默认值。 */
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

/**
 * 当前这组参数落在哪一档上；没有一档完全吻合时返回 undefined。
 *
 * 面板据此高亮胶囊：用户改过时长之后，那一档就不再是「当前档」了——继续高亮会
 * 让胶囊和它下面的选择器互相矛盾。
 *
 * @param values - 当前模型、时长、分辨率。
 * @returns 命中的档位 id，或 undefined。
 */
export function presetIdOf(values: {
  readonly model: MinimaxVideoModel
  readonly durationSeconds?: number | undefined
  readonly resolution?: MinimaxVideoResolution | undefined
}): string | undefined {
  if (values.durationSeconds === undefined) return undefined
  const match = videoPresets(() => '').find(({ preset }) =>
    preset.model === values.model
    && preset.durationSeconds === values.durationSeconds
    && preset.resolution === values.resolution)
  return match?.preset.id
}
