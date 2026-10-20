/**
 * `/video` 命令：让用户**看见**视频工具有哪些参数，再把选好的参数填进输入框。
 *
 * ## 形态：popupSelect 作为入口，自建弹窗作为表单
 *
 * 视频工具（`minimax_generate_video` / `minimax_understand_video`）是**模型自主
 * 调用**的，用户唯一的入口是自然语言。这带来两个问题：用户不知道有哪些参数，
 * 而且这些参数有联动规则（首帧→比例被强制成 `adaptive`、纯文本→`adaptive` 不
 * 可用）。
 *
 * 宿主给了两种命令 UI（`packages/client/ui-commands/src/client/contract.ts`）：
 *
 * - `PopupSelectSpec`（`:64-75`）：只有 `options()` + `onSelect()`，**单选**；
 * - `ActionSpec`（`:82-89`）：`run(session)`，契约明写它「不提交任何东西」。
 *
 * 单选的 popupSelect 装不下「提示词 + 模型 + 比例 + 时长 + 分辨率 + 四类参考
 * 文件 + 水印」，所以这里是**两级**：popupSelect 列出几条预设档，「自定义…」那
 * 一行打开 `VideoFormDialog`。预设档没有覆盖的定制组合因此仍然可达，而最常见
 * 的几种是一键的。
 *
 * ## 填进输入框，而不是直接发送
 *
 * `ActionSpec` 不能提交，这是宿主的限制；但即使能提交，**直接发起一次计费生成
 * 也仍然是错的**：用户看不到自己填的参数被联动规则改写成了什么。所以走
 * `SessionInput.setDraft`，把参数拼成一句话放进输入框，用户看一眼再发送。
 *
 * ## `available` 怎么判「这条会话在 minimax-code 上」
 *
 * `ClientSessionContext` 只有 `sessionId`（`ui-input-trigger/src/types.ts:29`），
 * 没有 provider。路由要从 `ctx.sessions` 上按 id 取：
 *
 * ```ts
 * ctx.sessions.binding(id)?.session.projections.faceOf('modelSelection').getSnapshot()
 * ```
 *
 * 这是宿主自己读当前模型的方式（`ui-conversation/src/client/input/hub.ts:104-113`
 * 的 `submissionState`），投影值形如 `{ next?, lastUsed? }`，每项带
 * `{ provider, model, reasoningEffort? }`。
 *
 * **任何一步拿不到就返回 false，绝不抛错**：`available` 在每次打开斜杠菜单时都
 * 会被调用，它抛一次就会让整个菜单塌掉；而一个刚建好的会话、或宿主还没回落
 * 投影时，这些读取本来就会是空的。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-command
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 宿主命令契约：**只取类型**，运行时靠 `ctx.commandUi`。见 ./commands-contract.ts。
import type { CommandContribution, SelectOption } from './commands-contract.ts'
import type { CommandSessionContext } from './commands-contract.ts'
import {
  buildVideoDraftText,
  normalizeVideoDefaults,
  type VideoDefaults,
  type VideoFormValues,
} from './video-form-rules.ts'
import { videoPresets, type VideoPreset } from './VideoFormDialog.tsx'
import { zh, type MinimaxCodeLocaleKey } from './locales.ts'

/** 本线路的 provider id（宿主 `PROVIDER_ID` 的同值副本）。 */
export const MINIMAX_CODE_PROVIDER = 'minimax-code'

/** `/video` 里「自定义…」那一行的 id。 */
export const CUSTOM_OPTION_ID = 'custom'

/** 本模块登记的命令名。 */
export const VIDEO_COMMAND_NAME = 'video'

/** 翻译函数座位。 */
export type VideoCommandTranslate = (key: MinimaxCodeLocaleKey, params?: Record<string, string | number>) => string

/** 一条会话路由。 */
export interface SessionRoute {
  readonly provider: string
  readonly model: string
}

/**
 * 这条会话的模型路由，读不到就是 undefined。
 *
 * 路径与宿主 `submissionState` 一致：投影 → `next` 优先、`lastUsed` 兜底 →
 * provider。**全程可选链**：投影没注册、快照是 undefined、字段缺失，都在这里
 * 变成 undefined，而不是一次异常。
 *
 * @param ctx - 浏览器根上下文（或注入了 `sessions` 的 scope）。
 * @param sessionId - 会话 id。
 * @returns 形如 `{ provider, model }` 的路由，或 undefined。
 */
export function sessionRouteOf(ctx: ClientContext, sessionId: string): SessionRoute | undefined {
  try {
    const sessions = (ctx as unknown as { sessions?: { binding?: (id: SessionId) => unknown } }).sessions
    const binding = sessions?.binding?.(sessionId as SessionId) as
      | { session?: { projections?: { faceOf?: (key: string) => { getSnapshot?: () => unknown } } } }
      | undefined
    const face = binding?.session?.projections?.faceOf?.('modelSelection')
    const snapshot = face?.getSnapshot?.()
    if (typeof snapshot !== 'object' || snapshot === null) return undefined
    const record = snapshot as { next?: unknown; lastUsed?: unknown }
    const pick = (value: unknown): SessionRoute | undefined => {
      if (typeof value !== 'object' || value === null) return undefined
      const candidate = value as { provider?: unknown; model?: unknown }
      if (typeof candidate.provider !== 'string' || candidate.provider === '') return undefined
      if (typeof candidate.model !== 'string' || candidate.model === '') return undefined
      return { provider: candidate.provider, model: candidate.model }
    }
    return pick(record.next) ?? pick(record.lastUsed)
  } catch {
    // 一个刚建的会话、或宿主还没回落投影时，这些读取本来就是空的；`available`
    // 在每个菜单打开时都跑，抛一次就会让整个斜杠菜单塌掉。
    return undefined
  }
}

/**
 * 把一段文本写进该会话的输入框。
 *
 * 走宿主的 `SessionInput.setDraft`（`ui-conversation/src/client/contract/input.ts:186`），
 * 不是 `prompt`：后者会绕过输入框直接把一条用户消息发出去，用户就看不见自己填了
 * 什么。`for(actx)` 要求一个**会话作用域的 Context**，正是
 * `ctx.sessions.binding(id).ctx`（见 `session-controller/src/client/sessions/service.ts:101-108`）。
 *
 * @param ctx - 浏览器根上下文。
 * @param sessionId - 目标会话。
 * @param text - 要填入的文本。
 * @returns 是否真的填进去了。
 */
export function fillComposer(ctx: ClientContext, sessionId: string, text: string): boolean {
  try {
    const sessions = (ctx as unknown as {
      sessions?: { binding?: (id: SessionId) => { ctx?: unknown } | undefined }
    }).sessions
    const binding = sessions?.binding?.(sessionId as SessionId)
    const actx = binding?.ctx
    if (actx === undefined) return false
    const conversation = (ctx as unknown as {
      conversation?: { input?: { for?: (scope: unknown) => { setDraft?: (value: string) => void } } }
    }).conversation
    const input = conversation?.input?.for?.(actx)
    if (typeof input?.setDraft !== 'function') return false
    input.setDraft(text)
    return true
  } catch {
    return false
  }
}

/** `/video` 命令需要外部给的两件事。 */
export interface VideoCommandOptions {
  /** 打开参数弹窗。「自定义…」这一行调它。 */
  readonly openForm: (sessionId: string, defaults: VideoDefaults) => void
  /**
   * 预设档直接填输入框时用的通道。
   *
   * 缺省是 `fillComposer`，测试注入一个假的来断言「填进去的那段话是什么」。
   */
  readonly fill?: (sessionId: string, text: string) => boolean
  /** 设置页里的默认参数。每次打开菜单时现取。 */
  readonly defaults?: () => VideoDefaults
  /** 翻译；缺省走本线路的中文兜底。 */
  readonly translate?: VideoCommandTranslate
}

/** 兜底翻译：只在没有 locale 服务时用到（测试、以及菜单渲染早于字典注册）。 */
function fallbackTranslate(key: MinimaxCodeLocaleKey, params?: Record<string, string | number>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params[name] ?? ''))
}

/**
 * 把一条预设档拼成填进输入框的那段话。
 *
 * 提示词留一条**待填的占位**，而不是随便编一句：用户选了「H3 · 4秒 · 768P」之后，
 * 真正缺的只有画面描述，那一条应当由他来写。
 *
 * @param preset - 选中的预设档。
 * @returns 填进输入框的文本。
 */
export function presetDraftText(preset: VideoPreset): string {
  const values: VideoFormValues = {
    prompt: '（在这里写画面描述）',
    model: preset.model,
    ...(preset.ratio === undefined ? {} : { ratio: preset.ratio }),
    durationSeconds: preset.durationSeconds,
    resolution: preset.resolution,
    media: {},
  }
  return buildVideoDraftText(values)
}

/**
 * 构造 `/video` 的 `CommandContribution`。
 *
 * 注册在插件的 `ctx.inject(['commandUi'], scope => …)` 里，与宿主
 * `ui-message-feedback` 的 `/feedback` 装饰同一种接线方式。
 *
 * @param ctx - 浏览器根上下文。
 * @param options - 打开弹窗与填输入框的通道。
 * @returns 一份可直接交给 `commandUi.register` 的贡献。
 */
export function createVideoCommand(ctx: ClientContext, options: VideoCommandOptions): CommandContribution {
  const t = options.translate ?? fallbackTranslate
  const fill = options.fill ?? ((sessionId: string, text: string) => fillComposer(ctx, sessionId, text))
  const defaultsOf = options.defaults ?? ((): VideoDefaults => normalizeVideoDefaults({}))

  return {
    name: VIDEO_COMMAND_NAME,
    label: () => t('videoCommandLabel'),
    description: () => t('videoCommandDesc'),
    available: (session: CommandSessionContext) =>
      sessionRouteOf(ctx, session.sessionId)?.provider === MINIMAX_CODE_PROVIDER,
    ui: {
      kind: 'popupSelect',
      options: async (): Promise<readonly SelectOption[]> => {
        const rows: SelectOption[] = videoPresets(t).map(({ preset, label }) => ({
          id: preset.id,
          label,
          group: { name: 'preset', label: t('videoPresetGroup') },
        }))
        rows.push({
          id: CUSTOM_OPTION_ID,
          label: t('videoPresetCustom'),
          detail: t('videoPresetCustomDesc'),
          group: { name: 'custom', label: t('videoPresetCustom') },
        })
        return rows
      },
      onSelect: async (option: SelectOption, session: CommandSessionContext) => {
        const defaults = defaultsOf()
        if (option.id === CUSTOM_OPTION_ID) {
          options.openForm(session.sessionId, defaults)
          return
        }
        const preset = videoPresets(t).find(row => row.preset.id === option.id)?.preset
        // 认不出的 id 不动输入框：宁可不填，也不要把一段猜出来的参数塞给用户。
        if (preset === undefined) return
        fill(session.sessionId, presetDraftText(preset))
      },
    },
  }
}
