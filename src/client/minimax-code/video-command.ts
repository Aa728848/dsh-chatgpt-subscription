/**
 * `/video` 命令：一个入口，直接打开参数面板。
 *
 * ## 形态：action，而不是 popupSelect
 *
 * 这里曾经是两级——popupSelect 列几条预设档，选中后把一段模板写进输入框，
 * 「自定义…」那一行才打开面板。两个问题：
 *
 * 1. **模板会占用输入框**。用户点了「H3 · 4 秒 · 768P」，输入框里立刻出现一整段
 *    `用 minimax_generate_video 生成视频：prompt=（在这里写画面描述）…`，他还得
 *    回到那段话里找哪一处该改。命令的职责是**帮他配参数**，不是替他起草消息。
 * 2. **档位在面板里本来就有**。面板顶部现在就是一排档位胶囊，先弹一次列表等于
 *    让同一件事发生两遍。
 *
 * 所以现在只有一个动作：打开面板。面板自己负责档位、参数与描述，用户点「填入
 * 输入框」之后才产生文本——而且那段文本是把描述与参数压成一条请求的**成品**，
 * 不是留了占位符的模板。
 *
 * ## 为什么不是「/video 后面直接写描述」
 *
 * 宿主的命令解析只在**裸命令**时把一行交给客户端贡献：`/video 描述…` 这一行
 * 已经带了参数，`ui-commands` 会把它当成普通消息（`service.ts` 的
 * `matchEnter`：`if (!bare) return undefined`）。所以「像 skill 一样接续输入」
 * 在这个宿主版本里做不到；面板把这件事补上：**输入框里已有的文字会被当成画面
 * 描述带进来**，效果接近「先写一句话，再叫面板」。
 *
 * ## `available` 怎么判「这条会话在 minimax-code 上」
 *
 * `ClientSessionContext` 只有 `sessionId`，没有 provider。路由要从 `ctx.sessions`
 * 上按 id 取投影。**任何一步拿不到就返回 false，绝不抛错**：`available` 在每次
 * 打开斜杠菜单时都会被调用，它抛一次就会让整个菜单塌掉。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-command
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 宿主命令契约：**只取类型**，运行时靠 `ctx.commandUi`。见 ./commands-contract.ts。
import type { CommandContribution } from './commands-contract.ts'
import type { CommandSessionContext } from './commands-contract.ts'
import { normalizeVideoDefaults, type VideoDefaults } from './video-form-rules.ts'
import { VideoCommandIcon } from './video-command-icon.tsx'
import { zh, type MinimaxCodeLocaleKey } from './locales.ts'

/** 本线路的 provider id（宿主 `PROVIDER_ID` 的同值副本）。 */
export const MINIMAX_CODE_PROVIDER = 'minimax-code'

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

/** 会话作用域的输入门面（宿主 `SessionInput` 的最小形状）。 */
interface SessionInputFacade {
  setDraft?: (value: string) => void
  readonly state?: { getSnapshot?: () => unknown }
}

/** 取某个会话的输入门面；拿不到就是 undefined。 */
function inputFacadeOf(ctx: ClientContext, sessionId: string): SessionInputFacade | undefined {
  try {
    const sessions = (ctx as unknown as {
      sessions?: { binding?: (id: SessionId) => { ctx?: unknown } | undefined }
    }).sessions
    const actx = sessions?.binding?.(sessionId as SessionId)?.ctx
    if (actx === undefined) return undefined
    const conversation = (ctx as unknown as {
      conversation?: { input?: { for?: (scope: unknown) => SessionInputFacade } }
    }).conversation
    return conversation?.input?.for?.(actx)
  } catch {
    return undefined
  }
}

/**
 * 去掉输入框文字开头那一截命令 token。
 *
 * 从菜单里点命令时，token 由宿主消费，输入框里通常已经干净；但用户也可能是
 * 先把 `/video` 打出来、再从菜单里点一次，此时草稿里还留着那个 token。把
 * `/video` 当成画面描述带进面板显然不对，所以在这里剥掉**开头任意一截**命令
 * token——只剥开头，正文里的斜杠是用户自己的内容。
 *
 * @param draft - 输入框里的文字。
 * @returns 去掉前导命令 token 与首尾空白后的文字。
 */
export function stripLeadingCommandToken(draft: string): string {
  return draft.replace(/^\s*\/[A-Za-z0-9_-]+[ \t]*/, '').trim()
}

/**
 * 这条会话输入框里**已经有的文字**。
 *
 * 走宿主的 `SessionInput.state`（`ui-conversation/src/client/contract/input.ts`
 * 的 `InputState.draft`）：那是编辑器内容的投影，不是一次发送。读不到就返回空串
 * ——面板会以空描述打开，而不是报错。
 *
 * @param ctx - 浏览器根上下文。
 * @param sessionId - 目标会话。
 * @returns 输入框里的文字。
 */
export function composerDraftOf(ctx: ClientContext, sessionId: string): string {
  try {
    const snapshot = inputFacadeOf(ctx, sessionId)?.state?.getSnapshot?.()
    if (typeof snapshot !== 'object' || snapshot === null) return ''
    const draft = (snapshot as { draft?: unknown }).draft
    return typeof draft === 'string' ? stripLeadingCommandToken(draft) : ''
  } catch {
    return ''
  }
}

/**
 * 把一段文本写进该会话的输入框。
 *
 * 走宿主的 `SessionInput.setDraft`，不是 `prompt`：后者会绕过输入框直接把一条
 * 用户消息发出去，用户就看不见自己填了什么。
 *
 * @param ctx - 浏览器根上下文。
 * @param sessionId - 目标会话。
 * @param text - 要填入的文本。
 * @returns 是否真的填进去了。
 */
export function fillComposer(ctx: ClientContext, sessionId: string, text: string): boolean {
  try {
    const input = inputFacadeOf(ctx, sessionId)
    if (typeof input?.setDraft !== 'function') return false
    input.setDraft(text)
    return true
  } catch {
    return false
  }
}

/** `/video` 命令需要外部给的东西。 */
export interface VideoCommandOptions {
  /** 打开参数面板。 */
  readonly openForm: (sessionId: string, defaults: VideoDefaults) => void
  /** 设置页里的默认参数。每次打开时现取。 */
  readonly defaults?: () => VideoDefaults
  /** 翻译；缺省走本线路的中文兜底。 */
  readonly translate?: VideoCommandTranslate
}

/** 兜底翻译：只在没有 locale 服务时用到（测试、以及菜单渲染早于字典注册）。 */
export function fallbackTranslate(key: MinimaxCodeLocaleKey, params?: Record<string, string | number>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params[name] ?? ''))
}

/**
 * 构造 `/video` 的 `CommandContribution`。
 *
 * 注册在插件的 `ctx.inject(['commandUi'], scope => …)` 里，与宿主
 * `ui-message-feedback` 的 `/feedback` 装饰同一种接线方式。
 *
 * @param ctx - 浏览器根上下文。
 * @param options - 打开面板的通道。
 * @returns 一份可直接交给 `commandUi.register` 的贡献。
 */
export function createVideoCommand(ctx: ClientContext, options: VideoCommandOptions): CommandContribution {
  const t = options.translate ?? fallbackTranslate
  const defaultsOf = options.defaults ?? ((): VideoDefaults => normalizeVideoDefaults({}))

  return {
    name: VIDEO_COMMAND_NAME,
    label: () => t('videoCommandLabel'),
    description: () => t('videoCommandDesc'),
    // 菜单行的字形。宿主按 `IconProps`（只有 size / className）渲染它，所以这里
    // 给自己的同形组件，而不是挂一个形状对不上的外来 SVG。
    icon: VideoCommandIcon,
    available: (session: CommandSessionContext) =>
      sessionRouteOf(ctx, session.sessionId)?.provider === MINIMAX_CODE_PROVIDER,
    ui: {
      kind: 'action',
      run: (session: CommandSessionContext) => {
        options.openForm(session.sessionId, defaultsOf())
      },
    },
  }
}
