/**
 * GLM（ZCode 账号）线路的 **OpenAI 兼容面**（协议 B）线映射。
 *
 * 上游面是 Coding Plan 专用的 OpenAI Chat Completions 形状，地址为
 * `{apiBaseForRegion(region)}` + `CHAT_PATH_OPENAI`（= `/api/coding/paas/v4`），
 * 实际调用 `/api/coding/paas/v4/chat/completions` 与 `/api/coding/paas/v4/models`。
 *
 * **刻意不是 `/api/paas/v4`**：那是通用开放平台面，官方文档的 Common mistakes 段写明
 * 走那个面套餐额度不会正确生效（计划 §3.3，证据等级 A）。也就是说发错前缀不会报错，
 * 用户只会看到「明明买了套餐却在扣余额」，所以前缀由 `./types.ts` 的常量固定，不在此处拼。
 *
 * 本文件吸收的四处与 OpenAI 默认形状不同的地方，每一处都有来源：
 *
 * 1. **思考在 `delta.reasoning_content`**，不是 OpenAI 的 `reasoning_summary`，
 *    落到 DSH 的 reasoning block。逐字来源：本仓库历史提交 `9ad8a53` 的
 *    `src/host/zhipu/mapper.ts` 实测转录。
 * 2. **`reasoning_effort` 只接受模型自己的梯子**（GLM-5.x 为 `low`/`high`/`max`），
 *    别的取值上游直接报错（业务码 1214 INVALID_PARAM，见 `ERROR_CODE` 表）。
 *    DSH 的档位词汇更宽（`minimal`/`medium`/`xhigh` 在别的线路上都存在），
 *    因此每个取值先经 `convergeGlmEffort()` 落到梯子上再发。该函数跨两套词汇表排名，
 *    `none`/`minimal` 也有位置可落——只排三档会把 `minimal` 误升成 `high`，
 *    那正是本仓库历史记录过的 bug（见 `./types.ts` 的 `convergeGlmEffort` 注释）。
 * 3. **不发 `thinking.type`**。`thinking` 的默认是 enabled，而 GLM-5.3 /
 *    GLM-5.3-FLASH / GLM-4.7 把 `thinking.type: "disabled"` 当**错误**，
 *    所以本线路任何模型都不发关闭值，直接省略该字段（同上，历史 mapper 注释）。
 * 4. **不发 `stream_options`**。上游的流式文档里 usage 对象是随末帧到的，
 *    该字段也不在文档化的请求 schema 里；给这个 API 发一个未文档化的字段，
 *    代价可能只是一个毫无收益的 400（同上，历史 mapper 注释）。
 *
 * **未验证**：以上第 1-4 条全部来自 `9ad8a53` 的历史实测转录，本轮**没有实机账号**
 * （计划 D9、R1），因此没有一次 live 复核。缺的是一份真实 SSE 帧样本与一份真实 400 响应样本。
 * 结构性的部分（字段名、认证头形状）证据等级 A；行为性的部分（哪些取值会被拒）
 * 只到「历史实测记录」这一层。
 */

import {
  CONTEXT_OVERFLOW_CODE,
  isContextOverflow,
  isHttpContextOverflow,
} from '../common/context-overflow.ts'
import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type OutboundContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '../common/llm-compat.ts'
import type { GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { toToolCallId } from '../common/brand-compat.ts'
import { retryAfterMs } from '../wire-auth.ts'
import {
  CHAT_PATH_OPENAI,
  DEFAULT_MAX_TOKENS,
  ERROR_CODE,
  PROVIDER_NAME,
  USER_AGENT,
  apiBaseForRegion,
  convergeGlmEffort,
} from './types.ts'

/**
 * 本文件自己用的失败码：调用方要求了一件这个面做不到的事。
 *
 * 与上游那张业务码表不是一回事——`ERROR_CODE` 说的是上游说了什么，
 * 这一个说的是本线路在发请求之前就知道做不到。处置因此不同：后者不该重试，
 * 也不该让用户以为「上游出问题了」，而是换模型或换调用方式。
 *
 * 取值是 harness 的**通用码** `UNSUPPORTED_OPTION`，不是本线路自造的：harness 自己的
 * provider 就在用同一个串（`packages/llm/llm-pi-ai/src/adapter.ts:335` 抛的是
 * `new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')`），
 * 本线路的 Anthropic 面（`mapper-anthropic.ts`）也用同一个串。
 *
 * 所以两个面共用一个码：装配层要判断「这个面做不到这件事」时，只有一个词要认，
 * 而不是先问是哪个面。自造一个带线路前缀的码会让调用方多学一个词，
 * 也会让同一个线路的两面出现两个说法。
 */
export const UNSUPPORTED_OPTION_CODE = 'UNSUPPORTED_OPTION'

/** 上游 Chat Completions 路径，接在 `CHAT_PATH_OPENAI` 之后。 */
export const CHAT_COMPLETIONS_SEGMENT = '/chat/completions'

/** 上游模型清单路径，接在同一个 `CHAT_PATH_OPENAI` 之后。 */
export const MODELS_SEGMENT = '/models'

/** 本面一个完整请求的 URL：`{apiBase}{CHAT_PATH_OPENAI}/chat/completions`。 */
export function chatCompletionsUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  return apiBaseForRegion(region, env) + CHAT_PATH_OPENAI + CHAT_COMPLETIONS_SEGMENT
}

/** 本面模型清单的 URL：`{apiBase}{CHAT_PATH_OPENAI}/models`。 */
export function modelsUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  return apiBaseForRegion(region, env) + CHAT_PATH_OPENAI + MODELS_SEGMENT
}

/**
 * OpenAI 兼容面的请求头。
 *
 * 认证是 `Authorization: Bearer {credential}`，credential 是兑换链换出来的
 * `{id}.{secret}` Coding Plan Key（计划 §3.2、§3.3）。
 *
 * **刻意不发 `x-api-key`**：双头是 **Anthropic 兼容面**的性质，官方源码注释逐字写着
 * 「Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization」
 * （`model/model-execution.ts:425-437`，计划 §3.3）。本面只读 Bearer，
 * 多发一个头不会更好，只会让日后复审误以为两面共用一套认证。
 *
 * 配额接口则**反过来**用裸 Key、不加 Bearer（见 `./types.ts` 的 `QUOTA_PATH` 注释），
 * 那是另一条路，不归本文件管。
 */
export function glmOpenAiHeaders(
  credential: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${credential}`,
    'user-agent': USER_AGENT,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// 读原始值的几个小助手
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

function unsupportedOption(detail: string): LlmError {
  return new LlmError(
    `${PROVIDER_NAME} 的 OpenAI 兼容面不支持这个调用方式：${detail}`,
    UNSUPPORTED_OPTION_CODE,
  )
}

// ---------------------------------------------------------------------------
// 逐模型能力声明
// ---------------------------------------------------------------------------

/**
 * 调用方（适配器）交给本映射的**逐模型**能力声明。
 *
 * 存在的原因是一条硬规则：**能力不得从模型名推断**（计划 §1、§7）——
 * 历史草案记录过 `glm-5.3-flash` 收图而 `glm-5.3` 不收、`glm-5.2` 两个档位而
 * `glm-5.3` 三个。所以本文件只读声明，绝不看 `options.model` 里的字符串。
 */
export interface GlmOpenAiModelRoute {
  /**
   * 该模型真实接受的思考档位梯子（目录逐行给出）。
   *
   * 空数组表示它不接受 `reasoning_effort`，此时本文件**不发**该字段：
   * `convergeGlmEffort` 对空梯子返回 null，调用方据此不发，而不是发一个模型不认的值。
   */
  readonly reasoningEfforts: readonly string[]
  /** 是否接受 image 输入。 */
  readonly supportsImages: boolean
  /**
   * 调用方未给 `maxTokens` 时本线路请求的输出上限。
   *
   * 缺省取 `DEFAULT_MAX_TOKENS`，那个常量在 `./types.ts` 里已标注**未验证**
   * （它不是任何 GLM-5.x 模型的官方上限，只是历史兜底值）。
   */
  readonly defaultMaxTokens?: number
}

/**
 * 目录尚未落地时使用的保守声明。
 *
 * 两项都取「什么都不发」的一侧：梯子为空 → 不发 `reasoning_effort`（让上游用自己的默认），
 * 不认图 → 请求里的图片按「读不出来」明说，而不是发一个上游会拒的 `image_url`。
 * 这不是对能力的判断，是「没有声明就不主张」。
 */
export const UNDECLARED_MODEL_ROUTE: GlmOpenAiModelRoute = {
  reasoningEfforts: [],
  supportsImages: false,
}

// ---------------------------------------------------------------------------
// Durable request images
// ---------------------------------------------------------------------------

/** 本面需要的附件接缝：一个持久图片的已验证字节。 */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage'>

/** 一个请求内已解析的持久图片，或「已证明读不出来」。 */
export type ResolvedRequestImage =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** 按持久附件 id 索引的图片；由一次请求构建消费。 */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>

const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

/**
 * 一次请求允许携带的 base64 图片上限：12 MB。
 *
 * 取本仓库其余 OpenAI 形状线路的同一个值（`workbuddy` / `zhipu` 的同名常量），
 * 理由是让图文与工具 schema 留在同一个 body 里。
 *
 * **未验证**：GLM Coding Plan 这个面对单请求图片字节的真实上限没有实测样本，
 * 缺一份超限请求的真实响应。W5 的客户端一旦拿到真实 413/1214 响应即可调整此值。
 */
export const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

const OMITTED_IMAGE_TEXT =
  '[image omitted to keep the request within its image limit; older images are omitted first. '
  + 'If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/** 本面接受的内联 base64 媒体类型。 */
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function attachmentOf(block: Record<string, unknown>): ImageAttachmentRef | undefined {
  const attachment = block.attachment
  if (!isRecord(attachment)) return undefined
  return typeof attachment.attachmentId === 'string' ? attachment as unknown as ImageAttachmentRef : undefined
}

function attachmentLabel(block: Record<string, unknown>): string | undefined {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) || asString(attachment?.attachmentId)
}

function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const attachment = attachmentOf(block)
      if (attachment) refs.set(attachment.attachmentId, attachment)
      continue
    }
    // 工具结果里嵌着自己的内容，那里面的截图同样要字节，所以继续往里走。
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function requestImageBytes(block: Record<string, unknown>): number | undefined {
  const attachment = attachmentOf(block)
  if (attachment) return base64Length(attachment.bytes)
  const inline = asString(block.data) || asString(block.base64)
  return inline ? inline.length : undefined
}

function collectRequestImageBytes(content: unknown, lengths: number[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block)) continue
    // 工具结果嵌着自己的内容，而工具产出的截图/读图结果就带在里面。
    // 只在顶层统计会让每张工具产出的图片绕过预算，而构建器照样把它们发了出去。
    if (block.type === 'tool-result') {
      collectRequestImageBytes(block.content, lengths)
      continue
    }
    if (block.type !== 'image') continue
    const bytes = requestImageBytes(block)
    if (bytes !== undefined) lengths.push(bytes)
  }
}

/**
 * 一次请求的图片字节超出 {@link MAX_REQUEST_IMAGE_BYTES} 时，把最老的内联图片换成占位文本。
 *
 * 持久历史不动，只改即将发出的那一份请求。
 */
export function offloadOldestRequestImages(options: GenerateOptions): GenerateOptions {
  const lengths: number[] = []
  for (const message of options.messages) collectRequestImageBytes(message.content, lengths)
  const excess = lengths.reduce((sum, bytes) => sum + bytes, 0) - MAX_REQUEST_IMAGE_BYTES
  if (excess <= 0) return options

  let omitted = 0
  let freed = 0
  for (const bytes of lengths) {
    if (freed >= excess) break
    freed += bytes
    omitted += 1
  }

  const remaining = { count: omitted }
  // 按与上面测量完全相同的形状、同样的顺序遍历：第 N 个必须对应被测量的第 N 个，
  // 否则这个计数会花在不相关的图片上，额度用在了错误的替换上。
  const replaceIn = (content: unknown): { content: unknown; replaced: boolean } => {
    if (!Array.isArray(content) || remaining.count === 0) return { content, replaced: false }
    let replaced = false
    const next = content.map((block) => {
      if (remaining.count === 0 || !isRecord(block)) return block
      if (block.type === 'image') {
        if (requestImageBytes(block) === undefined) return block
        remaining.count -= 1
        replaced = true
        return { type: 'text', text: OMITTED_IMAGE_TEXT } as ContentBlock
      }
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        const inner = replaceIn(block.content)
        if (!inner.replaced) return block
        replaced = true
        return { ...block, content: inner.content }
      }
      return block
    })
    return { content: next, replaced }
  }
  const messages = options.messages.map((message) => {
    const result = replaceIn(message.content)
    if (!result.replaced) return message
    return { ...message, content: result.content } as typeof message
  })
  return { ...options, messages }
}

/**
 * 读出一次请求携带的每一个 `{ type: 'image', attachment }` 块。
 *
 * 读不出来的图片解析成 `unavailable` 而不是凭空消失，这样模型被明确告知图没了，
 * 而不是对着空白作答。
 */
export async function resolveRequestImages(
  options: GenerateOptions,
  attachments: AttachmentImageReader | undefined,
  signal?: AbortSignal,
): Promise<ResolvedRequestImages> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return NO_RESOLVED_IMAGES

  const resolved = new Map<string, ResolvedRequestImage>()
  await Promise.all([...refs].map(async ([attachmentId, ref]) => {
    if (!attachments) {
      resolved.set(attachmentId, { kind: 'unavailable' })
      return
    }
    try {
      const stored = await attachments.readImage(ref, signal)
      resolved.set(attachmentId, {
        kind: 'inline',
        mediaType: stored.ref.mediaType,
        data: Buffer.from(stored.data).toString('base64'),
      })
    } catch (error) {
      if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
      resolved.set(attachmentId, { kind: 'unavailable' })
    }
  }))
  return resolved
}

function unavailableImageText(block: Record<string, unknown>): string {
  const label = attachmentLabel(block)
  const subject = label ? `${label} could not be read` : 'the image could not be read'
  return `[image unavailable: ${subject}; ask the user to attach it again if the image is needed]`
}

interface InlineImage {
  mediaType: string
  data: string
}

function imageBlockToInline(block: Record<string, unknown>, images: ResolvedRequestImages): InlineImage | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  let mediaType =
    asString(block.mimeType)
    || asString(block.mediaType)
    || (source ? asString(source.mimeType) || asString(source.mediaType) : undefined)
    || 'image/png'

  if (data?.startsWith('data:')) {
    const matched = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (matched) {
      mediaType = matched[1] || mediaType
      data = matched[2] || ''
    }
  }
  if (data) return { mediaType, data }

  const attachment = attachmentOf(block)
  const resolved = attachment ? images.get(attachment.attachmentId) : undefined
  // 媒体类型取自已验证的引用，不是块上写的那个。
  return resolved?.kind === 'inline' ? { mediaType: resolved.mediaType, data: resolved.data } : undefined
}

// ---------------------------------------------------------------------------
// 消息投影
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return sanitizeText(content)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(sanitizeText(block.text))
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
  }
  return parts.join('')
}

function toolResultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
      if (block.type === 'tool-result') return toolResultText(block.content)
      // 工具结果里的图只能被点名，不能内联：`role: "tool"` 那条消息只能带文本，
      // 所以它的像素另起一条 user 消息。
      if (block.type === 'image') return `[image: ${attachmentLabel(block) ?? 'attached image'}]`
      return ''
    })
    .join('')
}

/** 一个工具结果的 `image_url` 块；它们骑在一条 user 消息上。 */
function toolResultImageBlocks(blocks: unknown, images: ResolvedRequestImages): OpenAIMessage[] {
  if (!Array.isArray(blocks)) return []
  const out: OpenAIMessage[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        out.push({ type: 'text', text: unavailableImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...toolResultImageBlocks(block.content, images))
  }
  return out
}

/**
 * 工具实参，保持上游给的**原始 JSON 字符串**。
 *
 * 刻意不解析再序列化：参数里的大数、Unicode 转义、键序都是模型生成的证据，
 * 往返一次会悄悄改写它们，而执行侧是按字符串比对参数的。
 */
function toolCallArguments(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return '{}'
  try {
    return JSON.stringify(raw)
  } catch {
    return '{}'
  }
}

function isToolResultMessage(message: Message): boolean {
  // 手搭的一次性请求可能不带出处的消息；只有真的工具结果消息才有。
  return message.source?.kind === 'tool'
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

/** 把每一份系统贡献收成开头那一条 system 消息。 */
function leadingSystemText(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = textOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/** 去掉上游网关会拒或会忽略的 JSON-Schema 元关键字。 */
export function stripMetaSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} }
  const copy: Record<string, unknown> = { ...schema }
  delete copy.$schema
  return copy
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions 请求
// ---------------------------------------------------------------------------

type OpenAIMessage = Record<string, unknown>

function openAIUserContent(
  message: Message,
  images: ResolvedRequestImages,
  supportsImages: boolean,
): string | OpenAIMessage[] {
  if (!Array.isArray(message.content)) return ''
  const parts: OpenAIMessage[] = []
  let hasImage = false
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') parts.push({ type: 'text', text })
    } else if (block.type === 'image') {
      const inline = supportsImages ? imageBlockToInline(block, images) : undefined
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        hasImage = true
        parts.push({ type: 'image_url', image_url: { url: `data:${inline.mediaType};base64,${inline.data}` } })
      } else {
        // 模型不收图（目录声明过）或图读不出来：两种情况都明说，绝不静默丢像素。
        parts.push({ type: 'text', text: unavailableImageText(block) })
      }
    }
  }
  // 没有图时线上偏好纯字符串形式；块数组形式只在出现了非文本内容时才需要。
  if (!hasImage) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
  return parts
}

function openAIAssistantContent(message: Message): { content: string; toolCalls: OpenAIMessage[] } {
  const textParts: string[] = []
  const toolCalls: OpenAIMessage[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(sanitizeText(block.text))
    else if (block.type === 'tool-call' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_${toolCalls.length}`,
        type: 'function',
        function: { name: block.name, arguments: toolCallArguments(block.arguments) },
      })
    }
    // reasoning 块从不在回放里重发：这个端点不收没有签名的思考块
    // （历史 mapper 注释）。所以本线路的请求体永远不带思考。
  }
  return { content: textParts.join(''), toolCalls }
}

/**
 * 构造一份 `/api/coding/paas/v4/chat/completions` 的 body。
 *
 * `reasoning_effort` 先经 `convergeGlmEffort()` 收敛到目录声明的梯子上：
 * DSH 的词汇比上游宽，而上游收到不认识的档位会直接报 1214。
 * 梯子为空时**不发**该字段，而不是发一个模型不认的值。
 *
 * `thinking` 与 `stream_options` 一律**不发**，理由见文件头第 3、4 条。
 */
export function buildChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
  route: GlmOpenAiModelRoute = UNDECLARED_MODEL_ROUTE,
): Record<string, unknown> {
  // 会话折叠的工具历史需要一套「中途增删工具」的协议，本面没有。
  if (options.toolHistory !== undefined) {
    throw unsupportedOption('本线路每次请求都发完整的工具声明，不支持会话折叠的工具增删历史。')
  }

  const messages: OpenAIMessage[] = []
  const system = leadingSystemText(options)
  // 这个端点上 system 轮是可选的，所以没有提示词就省略，而不是塞一句中性的。
  if (system !== undefined) messages.push({ role: 'system', content: system })

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    if (isToolResultMessage(message)) {
      // 并行工具调用会连着发好几条 tool 消息，中间楔一条 user 会打断这一串。
      // 所以整串一起扫，图收集齐了，在后面补一条 user 消息。
      const imageBlocks: OpenAIMessage[] = []
      while (index < conversation.length && isToolResultMessage(conversation[index]!)) {
        const current = conversation[index]!
        const block = current.content[0]
        const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: callId, content: toolResultText(current.content) })
        imageBlocks.push(...toolResultImageBlocks(current.content, images))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) messages.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls } = openAIAssistantContent(message)
      const entry: OpenAIMessage = { role: 'assistant', content }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      // 既无文本也无调用的 assistant 轮在这里什么都不带。
      if (content !== '' || toolCalls.length > 0) messages.push(entry)
      continue
    }
    const content = openAIUserContent(message, images, route.supportsImages)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  // 档位收敛跨两套词汇表排名：`minimal` 会落到 `low` 而不是被误升成 `high`
  // （只排上游那三档时，未识别一律落中档，那正是本仓库历史记录过的 bug）。
  //
  // `none`（DSH 词汇表里「关思考」）同样被发成 `low`，这是**本面无法表达关思考的后果**，
  // 不是映射出错：这个面唯一的关思考拼法是 `thinking.type`，而本线路任何模型都不发它
  // （见文件头第 3 条——GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 把那个值当错误）。
  // 换句话说：用户要求关、模型关不掉，这里给出的是梯子最低档，
  // 与 minimax 线的 forced-thinking 先例同一形状。
  const requested = options.reasoningEffort === undefined ? '' : String(options.reasoningEffort).trim()
  const effort = requested === '' ? null : convergeGlmEffort(requested, route.reasoningEfforts)

  return {
    model: options.model,
    messages,
    // 本线路只走流式：没有一条同步分支去处理非流式响应。
    stream: true,
    max_tokens: options.maxTokens ?? route.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => {
            // 延迟加载是 Anthropic 面的术语，这个面没有对应字段；原样发过去等于撒谎。
            if (tool.deferLoading === true) {
              throw unsupportedOption(`工具 ${tool.name} 声明了 deferLoading，OpenAI 兼容面没有延迟加载。`)
            }
            return {
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) },
            }
          }),
          tool_choice: 'auto',
        }
      : {}),
    ...(effort === null ? {} : { reasoning_effort: effort }),
  }
}

// ---------------------------------------------------------------------------
// 业务错误码分类
// ---------------------------------------------------------------------------

/**
 * 从一份响应正文里读出平台自己的数字业务码。
 *
 * 分类**不能停在状态行**：同一个 429 覆盖了已用尽的窗口、失效的套餐和
 * 单模型授权缺口（见 `./types.ts` 的 `ERROR_CODE` 表注释），它们要不同的处置。
 */
export function readGlmErrorCode(detail: string): number | null {
  const matched = /"code"\s*:\s*(\d+)/.exec(detail)
  if (matched === null) return null
  const parsed = Number(matched[1])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 把一次失败的 HTTP 响应映射成一个 DSH 失败。
 *
 * 「可重试」一列照 `./types.ts` 的 `ERROR_CODE` 表读：只有 `RATE_LIMITED` 与
 * `OVERLOADED` 值得退避重试；`USAGE_LIMIT` / `PLAN_LIMIT` 带着重置时刻，
 * 立即重试只会在已用尽的窗口上继续失败。
 *
 * **这张码表与 Anthropic 面（`mapper-anthropic.ts`）必须逐行对齐**：同一个上游业务码
 * 在两个面上要报同一个 LlmError code，否则装配层要判断「这是要重登」「这是额度用尽」
 * 「这是模型不存在」时就得先问是哪个面。所以**改这里必须同时改那里**，反之亦然。
 *
 * 三个键的选择理由（不是随手挑的）：
 *
 * - `AUTH`：共享号池 `src/host/common/account-pool.ts` 的鉴权失败出口一律用这个串
 *   （:635 / :710 / :715 / :749 / :839 / :845），W6 复用那份池，所以它就是
 *   「这个账号要重登」的判断键。
 * - `QUOTA`：harness 导出的规范码，语义就是「账号额度或余额已耗尽」；
 *   它不在任何线路的 retryableCodes 里，所以额度类「不可重试」这条要求自动成立。
 * - `NOT_FOUND`：语义是「资源不存在」，与其余线路一致（404 也报这个）。
 *
 * `INVALID_ARGS` 同样是 harness 的通用码：参数被拒不是 provider 故障，
 * 不该退化成通用错误——那条路会让装配层以为该找上游，而它要找的是本地的请求构造。
 */
/**
 * `ERROR_CODE` 表里三个鉴权码。
 *
 * 单独列出来是为了下面那个「业务码优先于状态行」的判断：只有这三个码说的话
 * 与 401/403 的含义一致。
 */
const AUTH_BUSINESS_CODES = new Set<number>([
  ERROR_CODE.AUTH_MISSING,
  ERROR_CODE.AUTH_INVALID,
  ERROR_CODE.AUTH_EXPIRED,
])

/**
 * `ERROR_CODE` 表里除三个鉴权码以外的全部业务码——它们各自映射到**非鉴权**的结论。
 *
 * 这张集合的用处是让状态行不再压过业务码：`NO_PERMISSION`(1220) 的文档状态**就是 403**，
 * 可它说的不是「凭据坏了」，是「套餐没开这个 API」。按状态行读会把一个套餐权限问题
 * 报成鉴权失败，装配层随后把这个账号踢去重新登录，而重新登录根本解决不了套餐问题。
 *
 * 这正是冻结 `ERROR_CODE` 表那句「分类不能停在状态行」的字面意思，也是 Anthropic 面
 * 已经做对的事（它先查业务码，只在没有业务码时才让状态行兜底）。
 */
const NON_AUTH_BUSINESS_CODES = new Set<number>(
  Object.values(ERROR_CODE).filter((value) => !AUTH_BUSINESS_CODES.has(value)),
)

export function classifyGlmOpenAiFailure(
  status: number,
  detail: string,
  headers?: Headers,
): LlmError {
  const code = readGlmErrorCode(detail)
  const suffix = detail ? ` ${detail}` : ''

  // 鉴权失败报 `AUTH`：共享号池的鉴权出口用的就是它，装配层靠这一个键判断
  // 「这个账号要重新登录」，换成一个同义但不同的码会让号池认不出来。
  //
  // 判据是「业务码说了算，状态行只在业务码不认识时兜底」：带着 1220（套餐没开这个 API）
  // 的 403 不是凭据问题，若按状态行读就会把它报成 AUTH，然后号池把这个账号送去重登，
  // 而重登解决不了套餐问题——用户看到的会是「明明套餐在，却一直要重新登录」。
  const isAuthCode = code !== null && AUTH_BUSINESS_CODES.has(code)
  const statusSaysAuth = (status === 401 || status === 403)
    && (code === null || !NON_AUTH_BUSINESS_CODES.has(code))
  if (isAuthCode || statusSaysAuth) {
    return new LlmError(
      `${PROVIDER_NAME} 拒绝了当前 Coding Plan Key（${status}）。请重新登录该账号。${suffix}`,
      'AUTH',
      { status },
    )
  }

  // 单模型授权缺口在这个平台上是 429，但不是瞬时的：套餐就是不含这个模型，
  // 重试没有用，唯一的办法是换一个模型。
  if (code === ERROR_CODE.MODEL_NOT_IN_PLAN) {
    return new LlmError(
      `${PROVIDER_NAME} 当前套餐不包含这个模型。请在设置里换一个模型。${suffix}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // 套餐失效同样不是瞬时的：要的是续费。
  if (code === ERROR_CODE.PLAN_EXPIRED) {
    return new LlmError(
      `${PROVIDER_NAME} 套餐已失效，暂不可用。续费后恢复。${suffix}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // 未知模型 id 报 `NOT_FOUND`：它就是「这个资源不存在」，与其余线路的 404 同一个说法。
  // 本地目录不该发出这种 id（出现即目录错了），所以提示是刷新目录。
  if (code === ERROR_CODE.UNKNOWN_MODEL) {
    return new LlmError(
      `${PROVIDER_NAME} 不提供这个模型 id。刷新目录后重新选一个。${suffix}`,
      'NOT_FOUND',
      { status },
    )
  }

  // 「该模型不提供这个调用方式」不同：模型是在的，缺的是这个入口——正是逐模型声明
  // 协议的用处，所以提示指向目录里的协议声明而不是「找不到」。
  if (code === ERROR_CODE.WRONG_METHOD) {
    return new LlmError(
      `${PROVIDER_NAME} 不为这个模型提供这个调用方式。检查目录里该模型声明的协议面。${suffix}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  if (code === ERROR_CODE.PROMPT_TOO_LONG || isHttpContextOverflow(status, detail)) {
    return new LlmError(
      `${PROVIDER_NAME} 拒绝了请求：提示词超出模型上下文窗口。请压缩会话或调低上下文窗口覆盖值。${suffix}`,
      CONTEXT_OVERFLOW_CODE,
      { status },
    )
  }

  // 参数被拒报 `INVALID_ARGS`：这是本地的请求构造有问题（不支持的思考档位、缺必填项），
  // 不是 provider 故障。报成通用错误会让装配层以为该找上游，而它该找的是本地构造。
  if (code === ERROR_CODE.INVALID_PARAM || code === ERROR_CODE.MISSING_PARAM) {
    return new LlmError(
      `${PROVIDER_NAME} 拒绝了请求参数（${code}）。可能是不支持的思考档位。${suffix}`,
      'INVALID_ARGS',
      { status },
    )
  }

  // 账号权限不足与内容过滤：都是账号/输入侧的条件，重试无用，保持通用错误码。
  if (code === ERROR_CODE.NO_PERMISSION || code === ERROR_CODE.CONTENT_FILTERED) {
    return new LlmError(
      `${PROVIDER_NAME} 拒绝了这次请求（${code}）。账号权限不足，或输入被上游内容过滤拒绝。${suffix}`,
      'PROVIDER_ERROR',
      { status },
    )
  }

  // 窗口用尽、套餐额度用尽、余额为空：正文都带着重置时刻，正确处置是等重置或提示用户。
  //
  // 这一段**必须排在下面那个 429 分支之前**：这三个码上游都用 429 报，
  // 一旦让状态行先命中，已用尽的窗口就会被判成可重试，然后在一个不会再成功的窗口上
  // 反复退避重试——正是 ERROR_CODE 表注释里点名的那一类错误。
  if (code === ERROR_CODE.USAGE_LIMIT || code === ERROR_CODE.PLAN_LIMIT || code === ERROR_CODE.NO_BALANCE) {
    return new LlmError(
      `${PROVIDER_NAME} 的用量窗口或套餐额度已用尽，请等窗口重置。${suffix}`,
      // `QUOTA` 是 harness 导出的规范码，语义就是「账号额度或余额已耗尽」；
      // 它不在任何线路的 retryableCodes 里，所以「额度类不可重试」这条冻结表要求
      // 由这个码自动成立，不靠额外判断。
      'QUOTA',
      { status },
    )
  }

  // 瞬时过载报 `SERVER`：上游过载是服务端状况，不是限流。码要说清真实原因——
  // 两边都可重试，但把过载混进 RATE_LIMIT 会让号池按限流去冷却账号，而过载根本不是
  // 某个账号的错。可重试性由 `SERVER` 在 retryableCodes 里自动成立。
  if (code === ERROR_CODE.OVERLOADED) {
    const after = headers ? retryAfterMs(headers) : undefined
    return new LlmError(
      `${PROVIDER_NAME} 瞬时过载，请退避后重试。${suffix}`,
      'SERVER',
      { status, ...(after === undefined ? {} : { providerRetryAfterMs: after }) },
    )
  }

  // 频率限制（1302）：唯一一种「退避后可能成功」的限流，**需要正文里的业务码才这么判**。
  if (code === ERROR_CODE.RATE_LIMITED) {
    const after = headers ? retryAfterMs(headers) : undefined
    return new LlmError(
      `${PROVIDER_NAME} 触发了频率限制。${suffix}`,
      'RATE_LIMIT',
      {
        status: status === 429 ? 429 : undefined,
        ...(after === undefined ? {} : { providerRetryAfterMs: after }),
      },
    )
  }

  // 裸 429（正文没给业务码）判**不可重试**。
  //
  // 先验是 5:2：冻结 `ERROR_CODE` 表里 429 共 7 条，只有 2 条可重试
  // （`RATE_LIMITED` 1302 / `OVERLOADED` 1305），其余 5 条全是额度类
  // （`NO_BALANCE` / `USAGE_LIMIT` / `PLAN_EXPIRED` / `PLAN_LIMIT` / `MODEL_NOT_IN_PLAN`）。
  // 表的注释也逐字写着「`USAGE_LIMIT` / `PLAN_LIMIT` 带重置时刻，正确处置是等窗口重置
  // 或提示用户，立即重试只会在已用尽的窗口上继续失败」。
  //
  // 所以缺少业务码时，默认应当是**不可重试**：把真实原因报给用户，而不是赌它是限流
  // 然后进入自动退避重试——赌错的后果是在一个已经用尽的窗口上反复失败，
  // 还会多烧一次额度。
  //
  // `retry-after` 在这里仍然读取并下发：它是一个真实存在的响应头，上游常拿它当重置提示，
  // 界面上「N 秒后再试」比「未知错误」有用得多。它不改变本次的不可重试判定。
  //
  // **与 Anthropic 面（`mapper-anthropic.ts`）一致，改一处必须同时改另一处。**
  if (status === 429) {
    const after = headers ? retryAfterMs(headers) : undefined
    return new LlmError(
      `${PROVIDER_NAME} 拒绝了这次请求（429，正文没有说明原因）。`
      + `本线路的 429 大多是额度用尽，请查看配额卡片或稍后再试。${suffix}`,
      'PROVIDER_ERROR',
      { status: 429, ...(after === undefined ? {} : { providerRetryAfterMs: after }) },
    )
  }

  if (status >= 500) {
    return new LlmError(`${PROVIDER_NAME} 上游服务错误（${status}）:${suffix || '无响应正文'}`, 'SERVER', { status })
  }

  return new LlmError(`${PROVIDER_NAME} 接口错误（${status}）:${suffix || '无响应正文'}`, 'PROVIDER_ERROR', { status })
}

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
  started: boolean
}

/** 一次流式响应的累积状态。 */
export interface GlmOpenAiStreamState {
  blocks: OutboundContentBlock[]
  current: { index: number; type: 'text' | 'reasoning'; text: string } | null
  /** 线上工具下标 -> 累积中的调用。 */
  toolCalls: Map<number, PendingToolCall>
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  /** `[DONE]` 哨兵到了。 */
  done: boolean
  /** 终止块已经发出过。 */
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  sawUsage: boolean
}

export function createStreamState(): GlmOpenAiStreamState {
  return {
    blocks: [],
    current: null,
    toolCalls: new Map(),
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    done: false,
    finished: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    sawUsage: false,
  }
}

function closeCurrent(state: GlmOpenAiStreamState): StreamChunk[] {
  if (state.current === null) return []
  const { index, type, text } = state.current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: GlmOpenAiStreamState): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const [wireIndex, call] of [...state.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    const block: OutboundContentBlock = {
      type: 'tool-call',
      id: toToolCallId(call.id),
      name: call.name,
      arguments: call.arguments === '' ? '{}' : call.arguments,
    }
    state.blocks[call.blockIndex] = block
    out.push({ type: 'block-end', index: call.blockIndex, block })
    state.toolCalls.delete(wireIndex)
  }
  return out
}

function openTextBlock(state: GlmOpenAiStreamState, type: 'text' | 'reasoning'): StreamChunk[] {
  const out = closeCurrent(state)
  const index = state.blocks.length
  state.current = { index, type, text: '' }
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return out
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 喂进来一条 `/chat/completions` 的 SSE 行。 */
export function processStreamLine(line: string, state: GlmOpenAiStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished || !trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') {
    state.done = true
    return closeStream(state)
  }
  if (payload === '') return []

  const chunk = safeJsonParse(payload)
  if (!isRecord(chunk)) return []
  const out: StreamChunk[] = []

  // 失败也可能以 SSE 帧而不是 HTTP 状态到达；不接住它，被切断的回复会被当成干净收尾冲出去。
  // 平台的业务码与消息并排写在帧里，所以有码就带上。
  const errorPayload = isRecord(chunk.error) ? chunk.error : undefined
  if (errorPayload !== undefined) {
    const message = asString(errorPayload.message) ?? 'unknown error'
    const code = readGlmErrorCode(JSON.stringify(errorPayload))
    throw new LlmError(
      `${PROVIDER_NAME} 流内错误${code === null ? '' : `（业务码 ${code}）`}: ${message}`,
      isContextOverflow(errorPayload) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  // usage 先落账再处理 delta：上游把 usage 放在末帧上，而那一帧可能同时带着
  // finish_reason，读取顺序必须让 usage 不被后面任何分支跳过。
  const usage = isRecord(chunk.usage) ? chunk.usage : undefined
  if (usage) {
    state.sawUsage = true
    const prompt = numberOr(usage.prompt_tokens, 0)
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
    const cached = details ? numberOr(details.cached_tokens, 0) : 0
    // DSH 的计数是互斥的：缓存输入单独报，所以要从上游那个聚合的 prompt 数里减掉。
    state.inputTokens = Math.max(0, prompt - cached)
    state.cacheReadTokens = cached
    state.outputTokens = numberOr(usage.completion_tokens, state.outputTokens)
    if (isRecord(usage.completion_tokens_details)) {
      state.reasoningTokens = numberOr(usage.completion_tokens_details.reasoning_tokens, state.reasoningTokens)
    }
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = choice && isRecord(choice.delta) ? choice.delta as Record<string, unknown> : undefined

  if (delta) {
    // GLM 的思考在 reasoning_content 上，不是 OpenAI 的 reasoning_summary。
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') {
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'reasoning') out.push(...openTextBlock(state, 'reasoning'))
      state.current!.text += sanitizeText(reasoning)
      state.hasContent = true
      out.push({ type: 'reasoning-delta', index: state.current!.index, text: sanitizeText(reasoning) })
    }

    const content = asString(delta.content)
    if (content !== undefined && content !== '') {
      out.push(...closeToolCalls(state))
      if (state.current === null || state.current.type !== 'text') out.push(...openTextBlock(state, 'text'))
      state.current!.text += sanitizeText(content)
      state.hasContent = true
      out.push({ type: 'text-delta', index: state.current!.index, text: sanitizeText(content) })
    }

    const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of toolDeltas) {
      if (!isRecord(entry)) continue
      out.push(...applyToolDelta(entry, state))
    }
  }

  const finish = asString(choice?.finish_reason)
  if (finish !== undefined && finish !== '') {
    state.finishReason = finish
    // 这里只封块，不发 usage 也不发 finish：终局块一律由 closeStream 在 [DONE] 时统一发，
    // 这样 usage 必然排在 finish 之前。
    out.push(...closeCurrent(state))
    out.push(...closeToolCalls(state))
  }

  return out
}

function applyToolDelta(entry: Record<string, unknown>, state: GlmOpenAiStreamState): StreamChunk[] {
  const wireIndex = typeof entry.index === 'number' ? entry.index : 0
  const fn = isRecord(entry.function) ? entry.function : {}
  const out: StreamChunk[] = []

  let call = state.toolCalls.get(wireIndex)
  if (call === undefined) {
    out.push(...closeCurrent(state))
    const blockIndex = state.blocks.length
    call = {
      blockIndex,
      id: asString(entry.id) ?? `call_${wireIndex}`,
      name: asString(fn.name) ?? '',
      arguments: '',
      started: false,
    }
    state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' })
    state.toolCalls.set(wireIndex, call)
  } else {
    if (call.id === `call_${wireIndex}`) {
      const id = asString(entry.id)
      if (id !== undefined) call.id = id
    }
    const name = asString(fn.name)
    if (name !== undefined && name !== '') call.name = name
  }

  // 参数片段按原样累加，从不解析再序列化：分片边界与转义都属于模型给的原文。
  const argsDelta = asString(fn.arguments) ?? ''
  if (argsDelta !== '') call.arguments += argsDelta

  // 这一轮是工具调用，从调用**开始**那一刻就是了，不是等参数到了才算：
  // 一个无参工具否则会让 hasToolCall 停在 false，最后按普通收尾结算，
  // 于是执行器永远看不到它。名字和 id 也必须在开场那一帧就送到。
  if (!call.started) {
    call.started = true
    state.hasToolCall = true
    state.hasContent = true
    out.push({ type: 'block-start', index: call.blockIndex, blockType: 'tool-call' })
  }
  if (argsDelta !== '' || out.length > 0) {
    out.push({
      type: 'tool-call-delta',
      index: call.blockIndex,
      id: toToolCallId(call.id),
      ...(call.name === '' ? {} : { name: call.name }),
      argumentsDelta: argsDelta,
    })
  }
  return out
}

function tokenUsage(state: GlmOpenAiStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: GlmOpenAiStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'sensitive' || reason === 'content_filter') return { kind: 'stop' }
  return { kind: 'stop' }
}

/**
 * 冲掉所有打开的块，然后**先发 usage、再发 finish**。
 *
 * 顺序是硬要求：DSH 的执行器按 finish 结算一次调用，usage 排在它后面就来不及入账。
 */
export function closeStream(state: GlmOpenAiStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/**
 * 一条流在没有终局事件的情况下结束，那是**被截断**，不是答完了。
 *
 * 这个端点总是以 `finish_reason` 或 `[DONE]` 收尾，所以两者都没有意味着
 * 连接在答案中途断了，半截文本不能当成完成的回复呈现。
 */
export function assertStreamComplete(state: GlmOpenAiStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError(`${PROVIDER_NAME} 的流在终局事件之前就结束了`, 'PROVIDER_ERROR')
  }
}
