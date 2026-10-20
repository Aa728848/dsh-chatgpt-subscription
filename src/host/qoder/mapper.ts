/**
 * Qoder（订阅）线路对话端的 wire mapping。
 *
 * 这条线路的协议面**不是** OpenAI：它把一份 OpenAI 形状的对话包进 Qoder 自己的
 * \`RemoteChatAsk\` 信封，过一道自定义 body codec，再用 COSY 头签名（cosy.ts）。
 * 本文件只管「对话形状 ⇄ 信封里的 \`messages\`/\`parameters\`」与「信封 SSE ⇄ DSH chunks」；
 * 签名与编码在 cosy.ts，传输在 adapter.ts——三层各管一层，是因为每层都有独立的
 * fixture/测试锁定它（cosy 层有 frozen fixtures，本层有 mapper 测试）。
 *
 * 逐字来源（docs/qoder-line-plan.md §3.5/§3.6）：
 *
 * - 请求信封字段集：qodercli2api \`infer-user-no-org.json\` 的 \`body_raw\`（frozen fixture）；
 * - \`parameters\` 里的思考控制：pi-provider \`stream.ts\`（\`enable_thinking\` 布尔 +
 *   \`reasoning_effort\` 档位，仅当目录的 \`thinking_config.enabled.efforts\` 存在才发档位）；
 * - 响应信封：\`data:{headers, body, statusCodeValue}\`，\`body\` 再解析出 OpenAI chunk；
 *   \`[DONE]\` 两种形态（裸帧与信封 \`body:"[DONE]"\`）都结束读取；\`event:finish\` 是
 *   权威终止事件（qodercli2api §7）；
 * - usage 口径：\`prompt_tokens\` **含** \`cached_tokens\`，DSH 互斥计数所以减回去
 *   （pi-provider \`stream.ts\` 同一减法）。
 *
 * 与 step-code mapper 同源的辅助（消息投影、图片预算、tool_call 聚合）按同一套写，
 * 因为上游信封里装的确实是 OpenAI 形状的消息数组。
 *
 * @module dsh-chatgpt-subscription/qoder-mapper
 */

import { randomUUID, createHash } from 'node:crypto'
import type { QoderModelEntry } from './model-catalog.ts'
import { PROVIDER_NAME, convergeQoderEffort } from './types.ts'
import type { QoderReasoningEffort } from '../../shared/qoder-contracts.ts'
import { CONTEXT_OVERFLOW_CODE, isContextOverflow, isHttpContextOverflow } from '../common/context-overflow.ts'
import {
  LlmError,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type OutboundContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '../common/llm-compat.ts'
import { toToolCallId } from '../common/brand-compat.ts'
import { stripMetaSchema } from '../common/tool-schema.ts'
import {
  MAX_REQUEST_IMAGE_BYTES as SHARED_IMAGE_BUDGET,
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  attachmentLabel,
  imageBlockToInline,
  offloadOldestRequestImages as offloadOldestImagesWithinBudget,
  resolveRequestImages,
  unavailableImageText,
  type AttachmentImageReader,
  type ResolvedRequestImage,
  type ResolvedRequestImages,
} from '../common/request-images.ts'

export { resolveRequestImages }
export type { AttachmentImageReader, ResolvedRequestImage, ResolvedRequestImages }

// ---------------------------------------------------------------------------
// 小工具
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

/** 丢掉 NUL（多个网关都拒 prompt 里的 NUL）。 */
function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

/** 一个有限非负数字，或 undefined 让解析链跳过它。 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return optionalNumber(value) ?? fallback
}

/**
 * 读一条点路径（如 \`prompt_tokens_details.cached_tokens\`）。
 */
function numberAtPath(source: Record<string, unknown>, path: string): number | undefined {
  let cursor: unknown = source
  for (const key of path.split('.')) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return optionalNumber(cursor)
}

// ---------------------------------------------------------------------------
// 请求侧常量
// ---------------------------------------------------------------------------

/**
 * 一次请求允许携带的 Base64 图片总量。
 *
 * Qoder 没有公开的逐请求图片上限，所以这是防御性预算而不是文档化限制：
 * 与 step-code 取同一个 12 MB，让失控的对话降级成占位文本而不是拖垮传输。
 */
export const QODER_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

/** 共享图片预算，供想要插件保守上限的调用方使用。 */
export const QODER_SHARED_IMAGE_BUDGET = SHARED_IMAGE_BUDGET

/**
 * \`request_id\` 重复时上游报的业务错误码（逐字 qodercli2api §5：
 * 服务端对重复值返回 code 103）。它**不是**可安全自动重试的状态——
 * 重试必须用新的 request_id，而不是重发同一份。
 */
export const QODER_ERROR_DUPLICATE_REQUEST_ID = '103'

/** token 失效的业务错误码（CN 报「Login expired」，pi-provider oauth.ts 注释）。 */
export const QODER_ERROR_LOGIN_EXPIRED = '105'

/**
 * 响应侧「缓存读入量」的解析优先级，从先到后。
 *
 * 1. \`prompt_tokens_details.cached_tokens\` —— OpenAI 规范的字段（pi-provider 的主读法）；
 * 2. **顶层 \`cached_tokens\`** —— Qoder 网关可能直接平铺（step-code 线路的教训：
 *    官方文档只展示顶层字段时，它必须在自己那条分支上被认）；
 * 3. \`prompt_cache_hit_tokens\` —— DeepSeek 一族网关的命名（Qoder 的部分模型上游是它）；
 * 4. 0。
 *
 * 都不命中时取 0：0 表示「上游没报」，而不是「一定没命中」。
 */
export const QODER_CACHE_READ_FIELD_ORDER = [
  'prompt_tokens_details.cached_tokens',
  'cached_tokens',
  'prompt_cache_hit_tokens',
] as const

// ---------------------------------------------------------------------------
// 请求图片
// ---------------------------------------------------------------------------

/**
 * 一次请求超过 {@link QODER_MAX_REQUEST_IMAGE_BYTES} 时，把最旧的内联图片换成
 * 可见占位文本。持久历史不动，只有即将发出的这份请求变（与兄弟线路同一机制）。
 */
export function offloadOldestQoderRequestImages(
  options: GenerateOptions,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): GenerateOptions {
  return offloadOldestImagesWithinBudget(options, QODER_MAX_REQUEST_IMAGE_BYTES, images)
}

// ---------------------------------------------------------------------------
// 消息投影（DSH 词汇 → 信封里的 OpenAI 形状）
// ---------------------------------------------------------------------------

/** 信封里的消息形状（OpenAI Chat Completions 词汇）。 */
type QoderWireMessage = Record<string, unknown>

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
      // 工具结果里的图片只命名不内联：role:"tool" 的消息只能带文本。
      if (block.type === 'image') return '[image: ' + (attachmentLabel(block) ?? 'attached image') + ']'
      return ''
    })
    .join('')
}

/** 图片发不出去时的占位文本。 */
function visionRefusalText(block: Record<string, unknown>, supportsImages: boolean): string {
  if (!supportsImages) {
    const label = attachmentLabel(block)
    const subject = label ? label : 'the attached image'
    return '[image omitted: ' + subject + ' — the selected Qoder model does not declare image input (is_vl).]'
  }
  return unavailableImageText(block)
}

/** 一条工具结果里的 \`image_url\` 块；它们搭后面那条 user 消息的车。 */
function toolResultImageBlocks(
  blocks: unknown,
  images: ResolvedRequestImages,
  supportsImages: boolean,
): QoderWireMessage[] {
  if (!Array.isArray(blocks)) return []
  const out: QoderWireMessage[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      const inline = supportsImages ? imageBlockToInline(block, images) : undefined
      if (inline && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image_url', image_url: { url: 'data:' + inline.mediaType + ';base64,' + inline.data } })
      } else {
        out.push({ type: 'text', text: visionRefusalText(block, supportsImages) })
      }
      continue
    }
    if (block.type === 'tool-result') out.push(...toolResultImageBlocks(block.content, images, supportsImages))
  }
  return out
}

/**
 * 工具参数保留模型自己产出的 JSON 文本（不 parse 再串行化：大数、unicode 转义与
 * 键序都是模型产出的证据，而执行侧按字符串比对参数）。
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

/**
 * 收窄一个 tool_call id 到 Qoder 接受的形状（\`^[a-zA-Z0-9_-]{1,64}$\`，
 * 逐字 pi-provider transform.ts 的注释）。线上重写，映射不回内部——
 * DSH 自己的 id 本来就在这个形状里，这只是对上游边界的防守。
 */
export function qoderWireToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '-')
  const trimmed = sanitized.replace(/^-+|-+$/g, '')
  const safe = trimmed === '' ? 'call' : trimmed
  return safe.length <= 64 ? safe : safe.slice(0, 64)
}

function isToolResultMessage(message: Message): boolean {
  return message.source?.kind === 'tool'
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

/** 收集全部 system 贡献到一条领头的 system 文本。 */
function leadingSystemText(options: GenerateOptions): string | undefined {
  const parts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system' && message.role !== 'developer') continue
    const text = textOf(message.content)
    if (text !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function qoderUserContent(
  message: Message,
  images: ResolvedRequestImages,
  supportsImages: boolean,
): string | QoderWireMessage[] {
  if (!Array.isArray(message.content)) return ''
  const parts: QoderWireMessage[] = []
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
        parts.push({ type: 'image_url', image_url: { url: 'data:' + inline.mediaType + ';base64,' + inline.data } })
      } else {
        parts.push({ type: 'text', text: visionRefusalText(block, supportsImages) })
      }
    }
  }
  // 没有图时用裸字符串形态；块数组形态只在有非文本内容时才需要。
  if (!hasImage) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('')
  return parts
}

function qoderAssistantContent(message: Message): { content: string; toolCalls: QoderWireMessage[]; reasoning: string } {
  const textParts: string[] = []
  const toolCalls: QoderWireMessage[] = []
  const reasoningParts: string[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') textParts.push(sanitizeText(block.text))
    else if (block.type === 'reasoning' && typeof block.text === 'string') {
      // 推理回放在带外字段：Qoder 用 reasoning_content 返回它，放进可见 content
      // 会污染后续轮次（pi-provider transform.ts 同一决定）。
      reasoningParts.push(sanitizeText(block.text))
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      const id = typeof block.id === 'string' && block.id !== '' ? block.id : 'call_' + toolCalls.length
      toolCalls.push({
        id: qoderWireToolCallId(id),
        type: 'function',
        function: { name: block.name, arguments: toolCallArguments(block.arguments) },
      })
    }
  }
  return { content: textParts.join(''), toolCalls, reasoning: reasoningParts.join('') }
}

// ---------------------------------------------------------------------------
// 请求 envelope
// ---------------------------------------------------------------------------

/** 线上请求需要的、而对话本身不携带的旋钮。 */
export interface QoderWireRequestOptions {
  /** 所选模型是否声明图片输入（\`is_vl\`）。 */
  supportsImages?: boolean
  /** 调用方没给输出上限时用的上限；通常取目录行的 \`defaultMaxTokens\`。 */
  defaultMaxTokens?: number
  /** 该模型是否推理模型（不是推理模型就一个思考字段都不发）。 */
  reasoning?: boolean
  /** 该模型声明的真实档位梯子；空 = 没有 effort 字段（toggle 形态或不推理）。 */
  reasoningEfforts?: readonly string[]
  /** 思考能否关闭（目录 \`thinking_config.disabled\`）。 */
  thinkingDisableable?: boolean
}

/** 出厂默认：不认图、不发思考字段、没有梯子。 */
export const DEFAULT_QODER_WIRE_REQUEST_OPTIONS: QoderWireRequestOptions = {
  supportsImages: false,
  reasoning: false,
  reasoningEfforts: [],
}

/**
 * 一行目录的线上旋钮（字段逐列复制只住在这一处；adapter 只加它自己的覆盖）。
 */
export function qoderRequestOptionsFor(
  entry: QoderModelEntry | undefined,
  overrides: { defaultMaxTokens?: number } = {},
): QoderWireRequestOptions {
  const base: QoderWireRequestOptions = entry === undefined
    ? { ...DEFAULT_QODER_WIRE_REQUEST_OPTIONS }
    : {
        supportsImages: entry.supportsImages,
        defaultMaxTokens: entry.defaultMaxTokens,
        reasoning: entry.reasoning,
        reasoningEfforts: entry.reasoningEfforts,
        thinkingDisableable: entry.thinkingDisableable,
      }
  return {
    ...base,
    ...(overrides.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: overrides.defaultMaxTokens }),
  }
}

/**
 * 发到线上的思考控制（\`parameters\` 里的两个字段），或两个都不发。
 *
 * 逐字 pi-provider \`stream.ts\` 的语义（来源 \`@qoder-ai/qodercli\`）：
 *
 * - 模型不是推理模型 → 一个字段都不发；
 * - 推理模型但调用方没选档位 → \`enable_thinking: false\`（不默认让它想——
 *   想了更慢更费额度，用户没要求）；
 * - 调用方选了档位：收敛到模型真实梯子（types.ts 的 convergeQoderEffort）；
 *   梯子是 effort 形态才发 \`reasoning_effort\`，toggle 形态只发开关；
 *   收敛到 \`none\`（或模型说思考可关而调用方要关）→ \`enable_thinking: false\`。
 */
export function resolveQoderThinking(
  requested: unknown,
  request: QoderWireRequestOptions,
): { enable_thinking: boolean; reasoning_effort?: string } | undefined {
  if (request.reasoning !== true) return undefined
  const requestedEffort = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined
  if (requestedEffort === undefined) return { enable_thinking: false }
  const ladder = request.reasoningEfforts ?? []
  if (ladder.length === 0) {
    // toggle 形态：没有 effort 字段可发，只有开/关。
    return { enable_thinking: requestedEffort !== 'none' }
  }
  const converged = convergeQoderEffort(requestedEffort, ladder)
  if (converged === null) return { enable_thinking: false }
  if (converged === 'none') return { enable_thinking: false }
  return { enable_thinking: true, reasoning_effort: converged }
}

/**
 * 会话与请求的稳定 id（缓存亲和）。
 *
 * 逐字 pi-provider \`stream.ts\` 的设计：\`session_id\` 的稳定段来自账号+模型的哈希，
 * 会话段来自宿主给的 sessionId（没有才现造一个）；\`request_set_id\` 是会话内容的
 * 稳定哈希（重试同一份请求时不变，服务端去重靠它配合 \`request_id\` 的分工：
 * \`request_id\` 每次请求唯一，重复报 code 103）。
 */
export function qoderSessionId(uid: string, modelKey: string, sessionId: string | undefined): string {
  const stablePart = createHash('sha256').update('qoder-session').update('\0' + uid).update('\0' + modelKey).digest('hex').slice(0, 16)
  return stablePart + '-' + (sessionId === undefined || sessionId.trim() === '' ? randomUUID() : sessionId.trim())
}

/** 会话内容的稳定哈希（\`request_set_id\` / \`chat_record_id\`）。 */
export function qoderChatRecordId(modelKey: string, messages: readonly QoderWireMessage[], tools: unknown, maxTokens: number): string {
  const hash = createHash('sha256')
  hash.update('qoder-record')
  hash.update('\0' + modelKey)
  for (const message of messages) {
    hash.update('\0' + String(message.role ?? ''))
    const content = message.content
    hash.update('\0' + (typeof content === 'string' ? content : JSON.stringify(content)))
  }
  if (tools !== undefined) hash.update('\0' + JSON.stringify(tools))
  hash.update('\0mt=' + maxTokens)
  return hash.digest('hex').slice(0, 16)
}

/** 装配一份 RemoteChatAsk 的调用方材料。 */
export interface QoderChatRequestContext {
  /** 上行模型 key（\`X-Model-Key\` / \`model_config.key\`）。 */
  modelKey: string
  /** 目录行（\`model_config\` 的其余字段从这里还原成上游形状）。 */
  entry: QoderModelEntry | undefined
  /** 当前生效的 COSY 版本（\`business.version\` 填它，与官方 CLI 一致）。 */
  cosyVersion: string
  /** DSH 会话 id（缓存亲和的稳定段之外的那一段）。 */
  sessionId?: string
}

/**
 * 拼一份 RemoteChatAsk 请求体（**未编码**的 JSON 对象）。
 *
 * 字段集与取值逐字按 frozen fixture 的 \`body_raw\`（docs/qoder-line-plan.md §3.5）；
 * 顶层 \`system\` 与领头的 \`role:system\` 消息**都填**（官方 CLI 两处都填——
 * fixture 锁定；pi-provider 实测顶层字段被服务端忽略，填两份是无害的冗余）。
 *
 * 返回对象之后，调用方（adapter）**必须**用 \`JSON.stringify\` 串行化一次、
 * 拿那一份字节去编码+签名+发送：签名覆盖的是字节，任何中间的一道
 * parse/re-marshal 都会让签名的字节与发送的字节漂移。
 */
export function buildQoderChatRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  request: QoderWireRequestOptions,
  context: QoderChatRequestContext,
): Record<string, unknown> {
  const supportsImages = request.supportsImages === true
  const messages: QoderWireMessage[] = []
  // 领头的 system 消息（顶层 system 字段服务端忽略，见文件头）。
  const system = leadingSystemText(options)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  const conversation = nonSystemMessages(options)
  for (let index = 0; index < conversation.length; index++) {
    const message = conversation[index]!
    if (isToolResultMessage(message)) {
      // 并行工具调用会连着发好几条 tool 消息，中间夹一个 user 会断开这一串。
      // 整串扫完，图片收集起来，串后追加一条 user（pi-provider transform.ts 同一形状）。
      const imageBlocks: QoderWireMessage[] = []
      while (index < conversation.length && isToolResultMessage(conversation[index]!)) {
        const current = conversation[index]!
        const block = current.content[0]
        const callId = isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : ''
        messages.push({ role: 'tool', tool_call_id: qoderWireToolCallId(callId), content: toolResultText(current.content) })
        imageBlocks.push(...toolResultImageBlocks(current.content, images, supportsImages))
        index += 1
      }
      index -= 1
      if (imageBlocks.length > 0) messages.push({ role: 'user', content: imageBlocks })
      continue
    }
    if (message.role === 'assistant') {
      const { content, toolCalls, reasoning } = qoderAssistantContent(message)
      // 上游会丢掉 content 为 null 的 assistant 消息（pi-provider 注释逐字），
      // 于是后面的 tool 结果变成孤儿。有调用或推理但没可见文本时注入一个空格占位。
      const entry: QoderWireMessage = {
        role: 'assistant',
        content: content !== '' ? content : (toolCalls.length > 0 || reasoning !== '' ? ' ' : null),
      }
      if (reasoning !== '') entry.reasoning_content = reasoning
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      if (entry.content !== null) messages.push(entry)
      continue
    }
    const content = qoderUserContent(message, images, supportsImages)
    if (typeof content === 'string' && content === '') continue
    messages.push({ role: 'user', content })
  }

  const entry = context.entry
  const modelKey = context.modelKey
  const maxTokens = options.maxTokens ?? request.defaultMaxTokens ?? entry?.defaultMaxTokens ?? 131_072
  const tools = options.tools && options.tools.length > 0
    ? options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: stripMetaSchema(tool.parameters) },
      }))
    : []
  const recordId = qoderChatRecordId(modelKey, messages, tools.length > 0 ? tools : undefined, maxTokens)

  const thinking = resolveQoderThinking(options.reasoningEffort, request)
  const parameters: Record<string, unknown> = { max_tokens: maxTokens }
  if (options.temperature !== undefined) parameters.temperature = options.temperature
  // DSH 的 GenerateOptions 没有 top_p，这里不发（fixture 里的 top_p 是合成构造器自己的输入）。
  if (thinking !== undefined) {
    parameters.enable_thinking = thinking.enable_thinking
    if (thinking.reasoning_effort !== undefined) parameters.reasoning_effort = thinking.reasoning_effort
  }

  let lastUserText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      const content = messages[i]!.content
      lastUserText = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
          : ''
      break
    }
  }

  // 字段顺序按 fixture 的 lexical 序（它是签名覆盖的字节的一部分；顺序本身
  // 不影响服务端，但固定顺序让 fixture 对照与排障可读）。
  return {
    agent_id: 'agent_common',
    aliyun_user_type: '',
    business: {
      begin_at: Date.now(),
      id: randomUUID(),
      name: lastUserText.substring(0, 30),
      product: 'cli',
      stage: 'start',
      type: 'agent',
      version: context.cosyVersion,
    },
    // 官方 fixture 的 chat_context 是 {}（infer-user-no-org.json）；pi-provider 填了
    // extra.modelConfig。按 fixture 发最小形态（计划 §9 风险 10）。
    chat_context: {},
    chat_record_id: recordId,
    chat_task: 'FREE_INPUT',
    custom_model: null,
    is_reply: true,
    is_retry: false,
    messages,
    // model_config 还原成上游形状（fixture 的 model_config 字段集）。
    model_config: {
      key: modelKey,
      format: 'openai',
      source: entry?.source ?? 'system',
      enable: true,
      display_name: entry?.name ?? modelKey,
      is_vl: entry?.supportsImages === true,
      is_reasoning: entry?.reasoning === true,
      max_input_tokens: entry?.defaultContextWindow ?? 0,
    },
    parameters,
    request_id: randomUUID(),
    request_set_id: recordId,
    session_id: qoderSessionId('', modelKey, context.sessionId),
    session_type: 'qodercli',
    source: 1,
    stream: true,
    system: system ?? '',
    task_id: 'common',
    tools,
    version: '3',
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** 一帧 usage 读下来的归一化结果。 */
export interface QoderParsedUsage {
  /** 端点的聚合 prompt 计数（缓存拆分前）。 */
  promptTokens: number
  /** 未命中输入，与两个缓存桶互斥。 */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** 一帧 usage 的缓存读入量，按 {@link QODER_CACHE_READ_FIELD_ORDER} 逐条走。 */
export function readQoderCacheReadTokens(usage: Record<string, unknown>): number {
  for (const path of QODER_CACHE_READ_FIELD_ORDER) {
    const value = numberAtPath(usage, path)
    if (value !== undefined) return value
  }
  return 0
}

/**
 * 归一化一帧 \`usage\` 到 DSH 的互斥计数。
 *
 * Qoder 遵循 OpenAI 语义：\`prompt_tokens\` **含** \`cached_tokens\`，所以缓存两桶
 * 从聚合里减回去（pi-provider \`stream.ts\` 的同一减法）。\`cacheable_tokens\` 是容量
 * 指标而不是写入计数（首轮写入时它也是 0），**不**映射到 cacheWrite。
 *
 * \`usage.credits\` / \`billable\`（Qoder 的计费字段）不进 DSH 的 TokenUsage——
 * 它没有对应的格子，而订阅单价未公开，折成金额是编造（计划 §5）。
 */
export function parseQoderUsage(raw: unknown): QoderParsedUsage | undefined {
  if (!isRecord(raw)) return undefined
  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const promptTokens = numberOr(raw.prompt_tokens, 0)
  const cacheRead = readQoderCacheReadTokens(raw)
  const cacheWrite = optionalNumber(details?.cache_write_tokens) ?? 0
  const outputDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined
  return {
    promptTokens,
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens: numberOr(raw.completion_tokens, 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: numberOr(outputDetails?.reasoning_tokens, 0),
  }
}

// ---------------------------------------------------------------------------
// 信封 SSE 解析
// ---------------------------------------------------------------------------

interface PendingToolCall {
  blockIndex: number
  id: string
  name: string
  arguments: string
  started: boolean
}

/** 一条 Qoder 流式响应的累计状态。 */
export interface QoderStreamState {
  blocks: OutboundContentBlock[]
  current: OpenTextBlock | null
  /** wire tool index -> 累计中的调用。 */
  toolCalls: Map<number, PendingToolCall>
  hasContent: boolean
  hasToolCall: boolean
  finishReason: string | null
  /** 终止依据到了（\`[DONE]\` 任一形态或 \`event:finish\`）。 */
  done: boolean
  /** 终止 chunks 已经发出过。 */
  finished: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  sawUsage: boolean
}

interface OpenTextBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

export function createQoderStreamState(): QoderStreamState {
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
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    sawUsage: false,
  }
}

function closeCurrent(state: QoderStreamState): StreamChunk[] {
  const current = state.current
  if (current === null) return []
  const { index, type, text } = current
  const block: OutboundContentBlock = { type, text }
  state.blocks[index] = block
  state.current = null
  return [{ type: 'block-end', index, block }]
}

function closeToolCalls(state: QoderStreamState): StreamChunk[] {
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

function openTextBlock(
  state: QoderStreamState,
  type: 'text' | 'reasoning',
): { chunks: StreamChunk[]; block: OpenTextBlock } {
  const out = closeCurrent(state)
  const index = state.blocks.length
  const block: OpenTextBlock = { index, type, text: '' }
  state.current = block
  state.blocks.push({ type, text: '' })
  out.push({ type: 'block-start', index, blockType: type })
  return { chunks: out, block }
}

function appendTextDelta(
  state: QoderStreamState,
  type: 'text' | 'reasoning',
  text: string,
): StreamChunk[] {
  const out: StreamChunk[] = [...closeToolCalls(state)]
  let block = state.current
  if (block === null || block.type !== type) {
    const opened = openTextBlock(state, type)
    out.push(...opened.chunks)
    block = opened.block
  }
  block.text += text
  state.hasContent = true
  out.push(
    type === 'reasoning'
      ? { type: 'reasoning-delta', index: block.index, text }
      : { type: 'text-delta', index: block.index, text },
  )
  return out
}

function openToolCall(
  state: QoderStreamState,
  entry: Record<string, unknown>,
  wireIndex: number,
): { chunks: StreamChunk[]; call: PendingToolCall } {
  const out = closeCurrent(state)
  const blockIndex = state.blocks.length
  const fn = isRecord(entry.function) ? entry.function : undefined
  const call: PendingToolCall = {
    blockIndex,
    id: asString(entry.id) ?? 'call_' + wireIndex,
    name: asString(fn?.name) ?? '',
    arguments: '',
    started: false,
  }
  state.blocks.push({ type: 'tool-call', id: toToolCallId(call.id), name: call.name, arguments: '' })
  state.toolCalls.set(wireIndex, call)
  return { chunks: out, call }
}

function applyToolDelta(entry: Record<string, unknown>, state: QoderStreamState): StreamChunk[] {
  const wireIndex = typeof entry.index === 'number' ? entry.index : 0
  const fn = isRecord(entry.function) ? entry.function : undefined
  const out: StreamChunk[] = []

  let call = state.toolCalls.get(wireIndex)
  if (call === undefined) {
    const opened = openToolCall(state, entry, wireIndex)
    out.push(...opened.chunks)
    call = opened.call
  } else {
    if (call.id === 'call_' + wireIndex) {
      const id = asString(entry.id)
      if (id !== undefined) call.id = id
    }
    const name = asString(fn?.name)
    if (name !== undefined && name !== '') call.name = name
  }

  // 参数碎片逐字拼接，调用完整后才解析一次（模型产出的证据不在中途改写）。
  const argsDelta = asString(fn?.arguments) ?? ''
  if (argsDelta !== '') call.arguments += argsDelta

  // 调用一可辨识就算开始（无参数工具不会等到第一个参数字节）。
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

/**
 * 喂一行 SSE。
 *
 * 信封形状（qodercli2api §7，pi-provider \`stream.ts\` 同一读法）：
 *
 * - \`data:{"headers":{…},"body":"<inner JSON string>","statusCodeValue":200}\`：
 *   \`body\` 再解析一次得到 OpenAI \`chat.completion.chunk\`；
 * - \`statusCodeValue != 200\` 是**错误信封**，转成 LlmError 抛出；
 * - \`[DONE]\` 两种形态都结束：裸 \`data:[DONE]\` 与信封 \`body:"[DONE]"\`；
 * - \`event:finish\` 是权威终止事件（它自己的 data 里是耗时统计，不是内容）；
 * - 心跳与其它 \`event:\` 帧不产生任何 chunk（调用方在字节层喂看门狗）。
 */
export function processQoderStreamLine(line: string, state: QoderStreamState): StreamChunk[] {
  const trimmed = line.trim()
  if (state.finished) return []
  if (trimmed === 'event:finish' || trimmed.startsWith('event:finish ')) {
    state.done = true
    return closeQoderStream(state)
  }
  if (!trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '[DONE]') {
    state.done = true
    return closeQoderStream(state)
  }
  if (payload === '') return []

  const envelope = safeJsonParse(payload)
  if (!isRecord(envelope)) return []

  // 错误信封：状态非 200 的外层。body 里的 code/message 如实上浮。
  const statusCode = optionalNumber(envelope.statusCodeValue)
  if (statusCode !== undefined && statusCode !== 200) {
    const bodyText = asString(envelope.body) ?? ''
    throw classifyQoderFailure(statusCode, bodyText)
  }

  const innerStr = asString(envelope.body)
  // 信封包着的 [DONE]（qodercli2api §7 明确它有这一形态）。
  if (innerStr === '[DONE]') {
    state.done = true
    return closeQoderStream(state)
  }
  if (innerStr === undefined || innerStr === '') return []
  const inner = safeJsonParse(innerStr)
  if (!isRecord(inner)) return []

  const out: StreamChunk[] = []

  // 内层也可能直接带一个 error 对象（失败以帧的形态到达）。
  const errorPayload = isRecord(inner.error) ? inner.error : undefined
  if (errorPayload !== undefined) {
    throw new LlmError(
      PROVIDER_NAME + ' stream error: ' + (asString(errorPayload.message) ?? 'unknown error'),
      isContextOverflow(errorPayload) ? CONTEXT_OVERFLOW_CODE : 'PROVIDER_ERROR',
    )
  }

  // usage 先记账：端点把它放在最后一帧，而那帧可能同时带 finish_reason。
  const usage = parseQoderUsage(inner.usage)
  if (usage !== undefined) {
    state.sawUsage = true
    state.inputTokens = usage.inputTokens
    state.cacheReadTokens = usage.cacheReadTokens
    state.cacheWriteTokens = usage.cacheWriteTokens
    state.outputTokens = usage.outputTokens
    state.reasoningTokens = usage.reasoningTokens
  }

  const choices: unknown[] = Array.isArray(inner.choices) ? inner.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined

  if (delta !== undefined) {
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoning !== undefined && reasoning !== '') {
      out.push(...appendTextDelta(state, 'reasoning', sanitizeText(reasoning)))
    }
    const content = asString(delta.content)
    if (content !== undefined && content !== '') {
      out.push(...appendTextDelta(state, 'text', sanitizeText(content)))
    }
    const toolDeltas: unknown[] = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const entry of toolDeltas) {
      if (!isRecord(entry)) continue
      out.push(...applyToolDelta(entry, state))
    }
  }

  const finish = choice === undefined ? undefined : asString(choice.finish_reason)
  if (finish !== undefined && finish !== '') {
    state.finishReason = finish
    // 块在这里收；usage 与 finish 由 closeQoderStream 各发一次，usage 永远在 finish 前。
    out.push(...closeCurrent(state))
    out.push(...closeToolCalls(state))
  }

  return out
}

/** 一次应答的 DSH 记账（缓存字段为 0 时省略）。 */
export function qoderStreamTokenUsage(state: QoderStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
    ...(state.reasoningTokens > 0 ? { reasoningTokens: state.reasoningTokens } : {}),
  }
}

function finishReasonFor(state: QoderStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * 冲刷所有打开的块，然后发 usage 与终止 finish。
 *
 * 顺序是硬要求：DSH 在 \`finish\` 上结算一次调用，之后到达的 usage 永远入不了账。
 */
export function closeQoderStream(state: QoderStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = [...closeCurrent(state), ...closeToolCalls(state)]
  if (state.sawUsage) out.push({ type: 'usage', usage: qoderStreamTokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/**
 * 没有终止事件的流是被截断的回复，不是一份完整答案。
 */
export function assertQoderStreamComplete(state: QoderStreamState): void {
  if (!state.done && state.finishReason === null) {
    throw new LlmError(PROVIDER_NAME + ' stream ended before its terminal event', 'PROVIDER_ERROR')
  }
}

// ---------------------------------------------------------------------------
// 失败分类
// ---------------------------------------------------------------------------

/** 错误体里引用回消息的最大长度。 */
const MAX_FAILURE_DETAIL_LENGTH = 600

/** 从错误体里尽量读一个业务错误码（字符串 \`code\`，顶层或 \`error\` 里）。 */
function qoderErrorCode(detail: string): string | undefined {
  const parsed = safeJsonParse(detail)
  if (!isRecord(parsed)) return undefined
  const code = parsed.code ?? (isRecord(parsed.error) ? parsed.error.code : undefined)
  return typeof code === 'string' && code !== '' ? code
    : typeof code === 'number' ? String(code)
    : undefined
}

/**
 * 把一次失败（非 2xx 响应，或信封里的错误状态）分类成 DSH failure。
 *
 * 错误码是 harness 的共享词汇而不是本线路自己的：号池认得 \`AUTH\`
 * （「这个账号必须重新登录」），而重试集合不会捡起一次套餐拒绝。
 * Qoder 的两个业务码有自己的归处：\`103\`（重复 request_id）不是可安全
 * 自动重试的状态（qodercli2api §8 原话）；\`105\`（Login expired）归为 AUTH。
 */
export function classifyQoderFailure(status: number, detail: string): LlmError {
  const trimmed = detail.trim().slice(0, MAX_FAILURE_DETAIL_LENGTH)
  const suffix = trimmed === '' ? '' : ': ' + trimmed
  const code = qoderErrorCode(trimmed)

  if (status === 401 || status === 403 || code === QODER_ERROR_LOGIN_EXPIRED) {
    return new LlmError(
      PROVIDER_NAME + ' rejected the credential (' + status + (code === undefined ? '' : ', code ' + code) + '). Sign the account in again.' + suffix,
      'AUTH',
      { status },
    )
  }
  if (code === QODER_ERROR_DUPLICATE_REQUEST_ID) {
    return new LlmError(
      PROVIDER_NAME + ' rejected a duplicated request id (code 103).' + suffix,
      'PROVIDER_ERROR',
      { status },
    )
  }
  if (status === 429) {
    return new LlmError(PROVIDER_NAME + ' rate limit or plan limit (' + status + ').' + suffix, 'RATE_LIMIT', { status })
  }
  if (isHttpContextOverflow(status, detail)) {
    return new LlmError(
      PROVIDER_NAME + ' says the conversation no longer fits the model window.' + suffix,
      CONTEXT_OVERFLOW_CODE,
      { status },
    )
  }
  if (status === 404) {
    return new LlmError(
      PROVIDER_NAME + ' does not know this model or route (' + status + ').' + suffix,
      'NOT_FOUND',
      { status },
    )
  }
  if (status >= 500) {
    return new LlmError(PROVIDER_NAME + ' upstream error (' + status + ').' + suffix, 'SERVER', { status })
  }
  return new LlmError(PROVIDER_NAME + ' request failed (' + status + ').' + suffix, 'PROVIDER_ERROR', { status })
}
