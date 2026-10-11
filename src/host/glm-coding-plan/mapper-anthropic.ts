/**
 * GLM（ZCode 账号）线路的 **Anthropic Messages 面**映射。
 *
 * 端点形状（证据等级 A）：请求打 `{apiBaseForRegion(region)}{CHAT_PATH_ANTHROPIC}/v1/messages`，
 * 例如国际区 `https://api.z.ai/api/anthropic/v1/messages`，国区 `https://open.bigmodel.cn/api/anthropic/v1/messages`。
 * 两者逐字来自计划 `3.3 的模型面表（`zcode.z.ai/en/docs/qa` 第 6 条）与 `./types.ts` 的
 * `CHAT_PATH_ANTHROPIC`。
 *
 * 一、认证是**双头**，这是本文件第一个必须做对的事
 *
 * 官方源码注释逐字写着「Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization」
 * （`apps/zcode-cli/packages/adapters/src/model/model-execution.ts:425-437`，计划 `3.3）。
 * 同值各发一份，见 {@link glmAnthropicHeaders}。少发任何一个都会得到 401，而错误正文
 * 说的是「凭据没出现在头部里」（`ERROR_CODE.AUTH_MISSING` = 1001），排查方向会被带偏。
 *
 * 注意这与配额面**正好相反**：`/api/monitor/usage/quota/limit` 要的是裸 Key、
 * **不可**加 Bearer 前缀（`./types.ts` 的 `QUOTA_PATH` 注释）。两处不能互相抄。
 *
 * 二、思考档位必须**跨两套词汇表**收敛
 *
 * DSH 的档位词汇比上游宽（`minimal` / `medium` / `xhigh` 在别的线路上都存在），
 * 而 GLM-5.x 在 Coding Plan 上只接受 `low` / `high` / `max`，其余取值上游直接报错。
 * 因此每个值都要先落到**模型真实梯子**上，见 {@link glmEffortForLadder} 与
 * `./types.ts` 的 `convergeGlmEffort()`。
 *
 * 只排上游那三档会踩本仓库记录过的 bug：`minimal` 属于「未识别」，未识别一律落在中档，
 * 于是 `minimal` 被发成 `high`——模型想得比用户要求的长得多，**更慢而且多计费**。
 *
 * 三、本文件**不伪造模型名**
 *
 * `GenerateOptions.model` 是调用方（模型目录）给的 id，逐字下发。本线路两区模型 id
 * 不一致（计划 R8），任何按前缀猜测或「顺手换成官方名」的改写都会把请求打到上游
 * 不认识的 id 上（`ERROR_CODE.UNKNOWN_MODEL` = 1211）。
 *
 * 四、分块语义照兄弟线路的 Anthropic 面，不另发明
 *
 * 思考 / 文本 / 工具调用是三个独立的 DSH 块：思考文本走 `reasoning-delta`，正文走
 * `text-delta`，工具参数逐字拼接后交给 `tool-call` 块的 `arguments` 字符串
 * （DSH 协议义务：参数保持模型产出的原始 JSON 串）。
 * 参考实现是 `../minimax-code/mapper.ts`（同为 Anthropic 面）与 `../claude/mapper.ts`。
 *
 * 五、思考块的**回放**本文件不做
 *
 * Claude / minimax 两条线会把签名的 thinking 块原样存进 replayState 再回传。本线路
 * 没有这个需求的证据：GLM 的 Anthropic 兼容面是否要求回放签名块，没有任何实测样本。
 * 历史同族实现 `7e40fce` 的 `src/host/zhipu/mapper.ts` 选择「reasoning 块从不回放」。
 * 本文件沿用那一条并在 {@link anthropicAssistantContent} 注明；**未验证**：改成
 * 「回放」是否会被本面接受（需要一条真实多轮会话样本）。
 *
 * 未验证清单（本文件内逐条标注）：
 *
 * 1. `reasoning_effort` 出现在 Anthropic 面上。等级 A 的证据只覆盖 OpenAI 面的
 *    `/api/coding/paas/v4`；本面是同一平台的兼容网关，但它是否读顶层
 *    `reasoning_effort` 没有实测样本。用 `buildGlmAnthropicRequest` 的
 *    `sendReasoningEffort` 开关可整段关掉。
 * 2. `anthropic-version` 头网关是否强制要求。缺一条缺头的 4xx 样本。
 * 3. 网关在 Anthropic 面上发思考增量的词汇。本文件同时认 `thinking_delta` 与
 *    `reasoning_content`，两种都收。
 * 4. 历史里 reasoning 块不回放是否被本面接受（见第五节）。
 */
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
import { toToolCallId } from '../common/brand-compat.ts'
import { stripMetaSchema } from '../common/tool-schema.ts'
import { CONTEXT_OVERFLOW_CODE, isContextOverflow } from '../common/context-overflow.ts'
import {
  NO_RESOLVED_IMAGES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  imageBlockToInline,
  unavailableImageText,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import type { GlmReasoningEffort, GlmRegion } from '../../shared/glm-coding-plan-contracts.ts'
import {
  CHAT_PATH_ANTHROPIC,
  DEFAULT_MAX_TOKENS,
  ERROR_CODE,
  PROVIDER_NAME,
  USER_AGENT,
  apiBaseForRegion,
  convergeGlmEffort,
} from './types.ts'

/**
 * Anthropic Messages 协议版本头。
 *
 * 取值来自 Anthropic 公开协议常量，兄弟线路同值（`../kimi-code/client.ts:129` 的
 * `'anthropic-version': '2023-06-01'`）。本线路网关是否**强制**要求这个头没有任何实测
 * 样本（**未验证**，缺一条缺头的 4xx 样本），但发一个正确版本号的成本是零，所以照发。
 */
export const GLM_ANTHROPIC_VERSION = '2023-06-01'

/**
 * 本线路「这个选项在 Anthropic 面上送不出去」的稳定错误码。
 *
 * 语义与 harness 的 `HarnessError.code` 一致：稳定的机器可路由码，不要去解析 message。
 * 存在的理由是**不许静默忽略**——一个送不出去的选项如果被悄悄丢掉，用户看到的是一个
 * 「按默认设置跑」的回合，而不是一次能指认到具体选项的失败。
 * 这条码不在任何线路的重试集合里（各线路 `retryableCodes` 只含 RATE_LIMIT / SERVER /
 * TIMEOUT / TRANSPORT 等），所以抛出后不会被重试策略放大。
 */
export const UNSUPPORTED_OPTION_CODE = 'UNSUPPORTED_OPTION'

/** Anthropic 内容块在线上是普通 JSON 对象。 */
type AnthropicBlock = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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

// ---------------------------------------------------------------------------
// 端点与认证
// ---------------------------------------------------------------------------

/**
 * Anthropic 面的完整 URL：`{模型面 base}{CHAT_PATH_ANTHROPIC}/v1/messages`。
 *
 * base 取 `./types.ts` 的 `apiBaseForRegion`（国际区 `https://api.z.ai`、
 * 国区 `https://open.bigmodel.cn`，都受 `DSH_GLM_*_API_HOST` 覆盖），路径前缀取同文件
 * 的 `CHAT_PATH_ANTHROPIC`。区域是**凭据的属性**（计划 `1、`3.3），所以调用方必须把
 * 账号的区域传进来，而不是让这里去猜——猜错的代价是拿另一区的主机去验一把本区 Key，
 * 得到的是明确鉴权失败。
 *
 * @param region - 账号所属部署。
 * @param env - 环境变量表，默认 `process.env`（覆盖值在调用时读取，便于测试注入）。
 */
export function glmAnthropicUrl(region: GlmRegion, env: NodeJS.ProcessEnv = process.env): string {
  return apiBaseForRegion(region, env) + CHAT_PATH_ANTHROPIC + '/v1/messages'
}

/**
 * Anthropic 面请求头，认证是**双头**且同值。
 *
 * `x-api-key` 与 `Authorization: Bearer <key>` 各发一份：官方源码逐字写明这个兼容网关
 * 同时读取两者（`model/model-execution.ts:425-437`，计划 `3.3）。只发一个的后果是
 * 401 `AUTH_MISSING`(1001)，而那一条正文说的是「凭据没出现在头部里」，会把排查引向
 * 凭据存储而不是认证头。
 *
 * `extra` 覆盖不了认证三件套（两个认证头 + 协议版本头）：它们不是「调用方想改就改」的
 * 普通头，而是本面必须成对出现的协议事实，让一个 `extra` 把双头拆成不同值或只留一个，
 * 造出来的故障比不带 extra 更难查。
 *
 * @param apiKey - Coding Plan Key（兑换链拼出的 `{apiKey}.{secretKey}`）。空白即抛 AUTH。
 * @param extra - 追加请求头（调试、代理）。不能改写认证三件套。
 */
export function glmAnthropicHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const key = apiKey.trim()
  if (key === '') {
    throw new LlmError(
      PROVIDER_NAME + ' 的 Anthropic 面需要一把 Coding Plan API Key；空凭据不会变成一个能通过鉴权的请求。',
      'AUTH',
    )
  }
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': USER_AGENT,
    ...extra,
    'x-api-key': key,
    authorization: 'Bearer ' + key,
    'anthropic-version': GLM_ANTHROPIC_VERSION,
  }
}

// ---------------------------------------------------------------------------
// 思考档位
// ---------------------------------------------------------------------------

/**
 * 把 DSH 的档位收敛到该模型真实接受的梯子上。
 *
 * 跨两套词汇表排名（`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 与上游的三档
 * 一起排）之后取最近一档，平手向上取——与本仓库其余各线路的收敛一致，宁可多想一点，
 * 也不要少想。排名表在 `./types.ts` 的 `convergeGlmEffort()` 内，本文件不复制一份。
 *
 * 三个返回值含义不同，都不是「猜」：
 *
 * - `ladder` 为空 → `null`：该模型不接受思考档位，调用方据此**不发**任何档位字段，
 *   而不是发一个模型不认的值。
 * - 调用方没指定档位 → `null`：模型的服务端默认生效，映射层不代它选。
 * - 其余 → 模型梯子上真实存在的那一档。
 *
 * @param ladder - 模型目录为该模型声明的真实梯子（`GlmModelOption.reasoningEfforts`）。
 * @param requested - 调用方给的档位（DSH 的 `ReasoningEffortId`，可为空）。
 */
export function glmEffortForLadder(
  ladder: readonly string[],
  requested: string | undefined | null,
): GlmReasoningEffort | null {
  if (ladder.length === 0) return null
  const value = (requested ?? '').trim()
  if (value === '') return null
  return convergeGlmEffort(value, ladder)
}

/** 一次请求的思考控制。 */
export interface GlmThinkingControl {
  /** 要写进请求体的字段；为空表示这条请求不带任何思考控制。 */
  fields: Record<string, unknown>
  /** 模型这次会不会思考。用于判断与思考互斥的选项（例如 temperature）。 */
  thinking: boolean
}

/**
 * 请求体里的思考控制字段。
 *
 * `thinking: { type: 'enabled' }` 是**恒常发出**的一半：历史同族实现逐字记过
 * 「`thinking` 的默认是 enabled，GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 把
 * `thinking.type: "disabled"` 当错误拒绝」（`7e40fce` 的 `src/host/zhipu/mapper.ts`
 * 头注释），所以本线路任何模型都不发关闭值。
 *
 * `reasoning_effort` 是选深度的一半，取 {@link glmEffortForLadder} 的收敛结果。
 *
 * **未验证**：`reasoning_effort` 落在 Anthropic 面上。等级 A 的证据（计划 `3.3、
 * `9ad8a53` 的 `CODING_EFFORTS`）只覆盖 OpenAI 面 `/api/coding/paas/v4`；本面是同一个
 * 平台的兼容网关，但它是否读顶层 `reasoning_effort` 没有实测样本，缺一次真实请求。
 * 之所以仍然默认发：另一个候选（Anthropic 原生的 `thinking.budget_tokens`）表达不了
 * 三档梯子，而 `sendReasoningEffort: false` 是一个出口而不是修复。
 *
 * @param ladder - 模型真实梯子。
 * @param requested - 调用方给的档位。
 * @param sendReasoningEffort - 是否把收敛后的档位发成顶层字段，默认 true。
 */
export function glmThinkingControl(
  ladder: readonly string[],
  requested: string | undefined | null,
  sendReasoningEffort: boolean = true,
): GlmThinkingControl {
  if (ladder.length === 0) return { fields: {}, thinking: false }
  const effort = glmEffortForLadder(ladder, requested)
  const fields: Record<string, unknown> = { thinking: { type: 'enabled' } }
  if (effort !== null && sendReasoningEffort) fields.reasoning_effort = effort
  return { fields, thinking: true }
}

// ---------------------------------------------------------------------------
// 请求体投影
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

function blockLabel(block: Record<string, unknown>): string {
  const attachment = isRecord(block.attachment) ? block.attachment : undefined
  return asString(attachment?.name) ?? asString(attachment?.attachmentId) ?? 'attached image'
}

function toolResultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => {
    if (!isRecord(block)) return ''
    if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
    if (block.type === 'tool-result') return toolResultText(block.content)
    // 结果图只被点名、不内联：请求体有上限，把每张结果图都内联进去不是丰富请求而是撑爆它。
    if (block.type === 'image') return '[image: ' + blockLabel(block) + ']'
    return ''
  }).join('')
}

/**
 * 一个工具结果的 `content`：纯文本走字符串，**带图**才走块数组。
 *
 * 返回 undefined 表示没有任何可内联的图，于是调用方发字节相同的纯文本字符串——
 * 一个普通工具结果在网上的形态不因为本文件而改变。
 */
function toolResultWireContent(
  blocks: unknown,
  images: ResolvedRequestImages,
): AnthropicBlock[] | undefined {
  if (!Array.isArray(blocks)) return undefined
  const out: AnthropicBlock[] = []
  let hasImage = false
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: sanitizeText(block.text) })
      continue
    }
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      if (inline !== undefined && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)) {
        out.push({ type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
        hasImage = true
        continue
      }
      out.push({ type: 'text', text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      const nested = toolResultWireContent(block.content, images)
      if (nested !== undefined) {
        hasImage = true
        out.push(...nested)
      }
    }
  }
  if (!hasImage) return undefined
  // Messages 线要求至少一个块，所以第一块不是文本时补一块空文本。
  if (out[0]?.type !== 'text') out.unshift({ type: 'text', text: '' })
  return out
}

function anthropicUserContent(message: Message, images: ResolvedRequestImages): AnthropicBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: AnthropicBlock[] = []
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      const inline = imageBlockToInline(block, images)
      blocks.push(inline !== undefined && SUPPORTED_IMAGE_MEDIA_TYPES.has(inline.mediaType)
        ? { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
        : { type: 'text', text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') {
      const withImages = toolResultWireContent(block.content, images)
      blocks.push({
        type: 'tool_result',
        tool_use_id: asString(block.toolCallId) ?? '',
        content: withImages ?? toolResultText(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
      })
    }
  }
  return blocks
}

/**
 * 一个 assistant 轮要回放的内容块。
 *
 * **reasoning 块不回放**：历史同族实现 `7e40fce` 逐字写明「Reasoning blocks are never
 * replayed: the endpoint does not accept a thinking block without the signature that
 * produced it」，而本线路的思考块是否带签名、是否必须回放都没有实测样本（**未验证**，
 * 见文件头第五节）。这里选与同族实现相同的「不回放」，并在注释里点名它是一个待验证决定。
 *
 * tool-call 的 `input` 是**解析后**的对象：Messages 线上它就是 JSON 对象；
 * DSH 那边保持原始串（协议义务在响应侧），回放侧这里只需要对象。
 */
function anthropicAssistantContent(message: Message): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = []
  if (!Array.isArray(message.content)) return blocks
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'tool-call' && typeof block.name === 'string') {
      const raw = typeof block.arguments === 'string' ? block.arguments : safeStringify(block.arguments)
      const parsed = safeJsonParse(raw)
      blocks.push({
        type: 'tool_use',
        id: asString(block.id) ?? 'toolu_' + String(blocks.length),
        name: block.name,
        input: isRecord(parsed) ? parsed : {},
      })
    }
  }
  return blocks
}

/** 工具参数不是字符串时按 JSON 序列化；无法序列化就退回 `{}` 而不是抛错中断整轮。 */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '{}'
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}

/**
 * 相邻同角色轮合并。
 *
 * DSH 历史里可能连续两条 user（注入的上下文提示 + 真正的用户轮），而工具结果本身就是
 * user 角色消息；Messages 线要的是一个 user 轮，所以同角色的连续轮按顺序折叠。
 */
function mergeAnthropicMessages(
  entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }>,
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const merged: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const entry of entries) {
    if (entry.content.length === 0) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === entry.role) {
      last.content = [...last.content, ...entry.content]
      continue
    }
    merged.push({ role: entry.role, content: [...entry.content] })
  }
  return merged
}

/**
 * 收集全部 system 贡献为开头的一条 system 文本。
 *
 * `options.system` 在前、历史里的 system 消息按序在后，是一个与轮次无关的稳定折叠：
 * 提示词是服务端要缓存的前缀，任何一处每轮变化都会让整个缓存前缀失效。
 */
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

/** 只有真实工具结果消息才带 `source.kind === 'tool'`（手工拼的请求可能一条来源都没有）。 */
function isToolResultMessage(message: Message): boolean {
  return message.source?.kind === 'tool'
}

function nonSystemMessages(options: GenerateOptions): Message[] {
  return options.messages.filter((message) => message.role !== 'system')
}

/** 本面送不出去的选项，报 `UNSUPPORTED_OPTION` 而不是丢掉。 */
function unsupported(detail: string): LlmError {
  return new LlmError(PROVIDER_NAME + ' 的 Anthropic 面不支持该选项：' + detail, UNSUPPORTED_OPTION_CODE)
}

/**
 * 历史里的 `tool-addition` / `tool-removal` 块检查。
 *
 * 这两种块是 DSH 对「会话中途增减工具声明」的表达，而 Messages 线每轮都发完整工具表，
 * 没有对应的字段。静默丢掉的后果是：模型看不见那次增减，而请求看起来完全正常——
 * 所以这里拒绝，把决定交回给装配层（W6）而不是在这里猜。
 */
function assertNoUnsupportedHistory(options: GenerateOptions): void {
  for (const message of options.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool-addition') {
        throw unsupported('会话中途新增工具（tool-addition）只能由装配层在请求里展开成完整工具表。')
      }
      if (block.type === 'tool-removal') {
        throw unsupported('会话中途移除工具（tool-removal）只能由装配层在请求里展开成完整工具表。')
      }
    }
  }
}

/** 本面这一次请求的构建选项。 */
export interface GlmAnthropicRequestOptions {
  /** 模型目录为该模型声明的真实思考梯子。空数组 = 该模型不接受思考档位。 */
  ladder?: readonly string[]
  /** 这次请求读到的图片（`resolveRequestImages` 的产物）。 */
  images?: ResolvedRequestImages
  /** 是否把收敛后的档位发成顶层 `reasoning_effort`，默认 true。见 {@link glmThinkingControl}。 */
  sendReasoningEffort?: boolean
  /** 调用方不指定输出上限时用的值，默认 `./types.ts` 的 `DEFAULT_MAX_TOKENS`。 */
  defaultMaxTokens?: number
}

/**
 * 构造一个 Anthropic Messages 请求体。
 *
 * 字段顺序对服务端无意义，只是读起来顺。
 *
 * @param options - harness 归一化后的会话（`normalizeGenerateOptions` 的产物）。
 * @param request - 该模型的档位梯子与已读图片。
 */
export function buildGlmAnthropicRequest(
  options: GenerateOptions,
  request: GlmAnthropicRequestOptions = {},
): Record<string, unknown> {
  assertNoUnsupportedHistory(options)

  const ladder = request.ladder ?? []
  const images = request.images ?? NO_RESOLVED_IMAGES
  const control = glmThinkingControl(
    ladder,
    options.reasoningEffort === undefined || options.reasoningEffort === null
      ? null
      : String(options.reasoningEffort),
    request.sendReasoningEffort ?? true,
  )

  // 思考开启时 temperature 与之互斥（Anthropic 公开契约里 thinking 开启的请求不接受
  // temperature）。这里选择**报错**而不是丢掉它：丢掉之后用户拿到的是「按默认值跑」的
  // 回合，而请求本身完全看不出少了什么。
  if (control.thinking && options.temperature !== undefined) {
    throw unsupported('模型思考开启时不能同时指定 temperature（thinking 与 temperature 在本协议里互斥）。')
  }

  const tools = options.tools ?? []
  for (const tool of tools) {
    if (tool.deferLoading === true) {
      throw unsupported('工具 ' + tool.name + ' 声明了 deferLoading，本面每轮都发完整工具表，没有延迟加载的对应字段。')
    }
  }

  const entries: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const message of nonSystemMessages(options)) {
    if (isToolResultMessage(message) || message.role !== 'assistant') {
      entries.push({ role: 'user', content: anthropicUserContent(message, images) })
      continue
    }
    entries.push({ role: 'assistant', content: anthropicAssistantContent(message) })
  }

  const system = leadingSystemText(options)
  const maxTokens = options.maxTokens ?? request.defaultMaxTokens ?? DEFAULT_MAX_TOKENS

  return {
    // 模型 id 逐字下发：本线路两区 id 不一致（计划 R8），映射层没有资格替调用方换一个。
    model: options.model,
    max_tokens: maxTokens,
    // 必须为 true。适配器把每个响应体当 SSE 读，不带这个字段端点回的是一次性 JSON，
    // 那份响应没有 data: 行、没有 message_stop、没有 stop_reason。
    stream: true,
    messages: mergeAnthropicMessages(entries),
    ...(system === undefined ? {} : { system }),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: stripMetaSchema(tool.parameters),
          })),
        }
      : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: [...options.stop] } : {}),
    // toolHistory 是会话折叠出来的工具声明轨迹，而本面每轮发完整工具表——它在这里是冗余
    // 而不是丢失，所以不报错（DSH 对它的默认语义就是「不带即发完整声明」）。
    ...control.fields,
  }
}

// ---------------------------------------------------------------------------
// 流式响应
// ---------------------------------------------------------------------------

/** 一个跨多个 content-block 增量累积的工具调用。 */
interface PendingToolCall {
  /** 这个调用占的 DSH 块下标。 */
  index: number
  id: string
  name: string
  /** 逐字拼接的 partial_json 片段。 */
  arguments: string
}

/** 一个正在接收增量的思考块。 */
interface PendingThinking {
  index: number
  kind: 'thinking' | 'redacted_thinking'
  text: string
  signature: string
  data: string
}

/** 一个 Messages 响应的累积状态。 */
export interface GlmAnthropicStreamState {
  /** 按 DSH 下标排列的已发块；块一开就占位。 */
  blocks: OutboundContentBlock[]
  /** wire content index -> 正在接收文本的那个块。 */
  openText: Map<number, { index: number; text: string }>
  /** wire content index -> 累积中的工具调用。 */
  toolCalls: Map<number, PendingToolCall>
  /** wire content index -> 打开着的思考块。 */
  pending: Map<number, PendingThinking>
  hasContent: boolean
  hasToolCall: boolean
  /** wire 的 `stop_reason`，逐字保留。 */
  finishReason: string | null
  /** 带内 `error` 事件的原始对象，记下来供适配层判断此刻还能不能安全重试。 */
  streamError?: Record<string, unknown>
  sawMessageStart: boolean
  sawMessageStop: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 结束之前是否真的见过 usage；没见过就不发 usage 块（零值 usage 是谎报）。 */
  sawUsage: boolean
  finished: boolean
}

/** 新的一次响应的流状态。 */
export function createGlmAnthropicStreamState(): GlmAnthropicStreamState {
  return {
    blocks: [],
    openText: new Map(),
    toolCalls: new Map(),
    pending: new Map(),
    hasContent: false,
    hasToolCall: false,
    finishReason: null,
    sawMessageStart: false,
    sawMessageStop: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sawUsage: false,
    finished: false,
  }
}

function closeTextBlock(state: GlmAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const open = state.openText.get(contentIndex)
  if (open === undefined) return []
  state.openText.delete(contentIndex)
  const block: OutboundContentBlock = { type: 'text', text: open.text }
  state.blocks[open.index] = block
  state.hasContent = true
  return [{ type: 'block-end', index: open.index, block }]
}

/** 在指定 wire 下标上打开（或复用）一个文本块。 */
function openTextAt(
  state: GlmAnthropicStreamState,
  contentIndex: number,
): { chunks: StreamChunk[]; block: { index: number; text: string } } {
  const existing = state.openText.get(contentIndex)
  if (existing !== undefined) return { chunks: [], block: existing }
  const index = state.blocks.length
  state.blocks.push({ type: 'text', text: '' })
  const block = { index, text: '' }
  state.openText.set(contentIndex, block)
  return { chunks: [{ type: 'block-start', index, blockType: 'text' }], block }
}

/**
 * 关闭一个工具调用：**拼接后不再重新序列化**。
 *
 * 片段按到达顺序逐字拼接，块里的 `arguments` 就是模型产出的那段 JSON 字符串——这是
 * DSH 的协议义务。空参数串按 `'{}'` 记（一个零参数工具确实产出 `{}`），解析失败**不**
 * 改写：解析失败要交给 DSH 自己的派发变成一条错误工具结果，悄悄替换成 `'{}'`
 * 等于把一次畸形调用变成一次无参调用。
 */
function closeToolCall(state: GlmAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const pending = state.toolCalls.get(contentIndex)
  if (pending === undefined) return []
  state.toolCalls.delete(contentIndex)
  const block: OutboundContentBlock = {
    type: 'tool-call',
    id: toToolCallId(pending.id),
    name: pending.name,
    arguments: pending.arguments === '' ? '{}' : pending.arguments,
  }
  state.blocks[pending.index] = block
  state.hasToolCall = true
  state.hasContent = true
  return [{ type: 'block-end', index: pending.index, block }]
}

/**
 * 打开一个思考块，并把 content_block_start 已带的思考文本立刻发出去。
 *
 * 边流边发，不等到 content_block_stop：DSH 用首个非空增量起算首 token 时间，
 * 而它除的那个 usage 把每个思考 token 都算在内；等块结束才发会让计时在思考做完之后才开始。
 */
function openThinkingBlock(
  state: GlmAnthropicStreamState,
  contentIndex: number,
  block: Record<string, unknown>,
  kind: PendingThinking['kind'],
): StreamChunk[] {
  const index = state.blocks.length
  state.blocks.push({ type: 'reasoning', text: '' })
  const seed = kind === 'thinking' ? (asString(block.thinking) ?? '') : ''
  state.pending.set(contentIndex, {
    index,
    kind,
    text: seed,
    signature: asString(block.signature) ?? '',
    data: asString(block.data) ?? '',
  })
  const out: StreamChunk[] = [{ type: 'block-start', index, blockType: 'reasoning' }]
  if (seed !== '') out.push({ type: 'reasoning-delta', index, text: seed })
  return out
}

function closeThinkingBlock(state: GlmAnthropicStreamState, contentIndex: number): StreamChunk[] {
  const pending = state.pending.get(contentIndex)
  if (pending === undefined) return []
  state.pending.delete(contentIndex)
  // redacted_thinking 没有可见文本，绝不把它还原成「可见的思考」。
  const text = pending.kind === 'thinking' ? pending.text : ''
  const block: OutboundContentBlock = { type: 'reasoning', text }
  state.blocks[pending.index] = block
  state.hasContent = true
  return [{ type: 'block-end', index: pending.index, block }]
}

/** 按 DSH 下标顺序冲掉所有还开着的块。 */
function flushOpenBlocks(state: GlmAnthropicStreamState): StreamChunk[] {
  const closers: Array<{ index: number; close: () => StreamChunk[] }> = []
  for (const [contentIndex, open] of state.openText) {
    closers.push({ index: open.index, close: () => closeTextBlock(state, contentIndex) })
  }
  for (const [contentIndex, pending] of state.toolCalls) {
    closers.push({ index: pending.index, close: () => closeToolCall(state, contentIndex) })
  }
  for (const [contentIndex, pending] of state.pending) {
    closers.push({ index: pending.index, close: () => closeThinkingBlock(state, contentIndex) })
  }
  closers.sort((left, right) => left.index - right.index)
  const out: StreamChunk[] = []
  for (const closer of closers) out.push(...closer.close())
  return out
}

/**
 * usage 的映射。
 *
 * 三个计数与 DSH 的文档一样是**不相交**的：`input_tokens` 只算未命中缓存的部分，
 * `cache_read_input_tokens` / `cache_creation_input_tokens` 各自单列。
 * 把缓存命中加进 inputTokens 会让每个被缓存的轮次都算两遍。
 */
function tokenUsage(state: GlmAnthropicStreamState): TokenUsage {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(state.cacheReadTokens > 0 ? { cacheReadTokens: state.cacheReadTokens } : {}),
    ...(state.cacheWriteTokens > 0 ? { cacheWriteTokens: state.cacheWriteTokens } : {}),
  }
}

function finishReasonFor(state: GlmAnthropicStreamState): FinishReason {
  const reason = state.finishReason ?? ''
  // max-tokens 排在 tool-calls 前面：装配器只有在被告知截断时才会丢掉被截断的工具调用。
  if (reason === 'max_tokens' || reason === 'length') return { kind: 'max-tokens' }
  if (state.hasToolCall || reason === 'tool_use' || reason === 'tool_calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * 冲掉所有打开的块，然后发 usage，最后发终止的 finish。
 *
 * 顺序是协议义务：**usage 必须在 finish 之前，finish 之后不得再有任何块**
 * （DSH 的 `StreamChunk` 文档逐字这么写）。所以本函数把 usage 排在 finish 前一行，
 * 而 {@link processGlmAnthropicStreamLine} 一旦 `finished` 为真就返回空数组——
 * 迟到的增量不会变成 finish 之后的块。
 *
 * 幂等：`message_stop` 已经关过流，适配层在响应体结束后再调一次是空操作而不是第二个 finish。
 * 本函数**不**判断流是否完整，那是 {@link assertGlmStreamComplete} 的事。
 */
export function closeGlmAnthropicStream(state: GlmAnthropicStreamState): StreamChunk[] {
  if (state.finished) return []
  state.finished = true
  const out = flushOpenBlocks(state)
  if (state.sawUsage) out.push({ type: 'usage', usage: tokenUsage(state) })
  out.push({ type: 'finish', reason: finishReasonFor(state) })
  return out
}

/**
 * 流没有走到终止事件 = 被截断的回复，不是完整答案。
 *
 * 已经发出的内容只是模型没说完那句话的前缀，把它冲成一个干净 stop 就是把一次截断
 * 报成一次成功——这正是这条检查存在的理由。
 */
export function assertGlmStreamComplete(state: GlmAnthropicStreamState): void {
  if (!state.sawMessageStop && state.finishReason === null) {
    throw new LlmError(PROVIDER_NAME + ' 的 Anthropic 面流在终止事件之前结束', 'PROVIDER_ERROR')
  }
}

/** 这一路流有没有带出任何内容。 */
export function glmStreamHasContent(state: GlmAnthropicStreamState): boolean {
  return state.hasContent
}

/** 把 usage 字段读进状态。`cumulativeOutput` 区分「累计」与「增量」两种语义。 */
function applyUsage(
  state: GlmAnthropicStreamState,
  usage: Record<string, unknown>,
  cumulativeOutput: boolean,
): void {
  state.sawUsage = true
  state.inputTokens = numberOr(usage.input_tokens, state.inputTokens)
  state.cacheReadTokens = numberOr(usage.cache_read_input_tokens, state.cacheReadTokens)
  state.cacheWriteTokens = numberOr(usage.cache_creation_input_tokens, state.cacheWriteTokens)
  // message_delta 给的是累计值，替换而不是累加（累加会把长回答的输出算成二次的）；
  // message_start 给的是一个零值桩，所以那里按「增量」处理。
  state.outputTokens = cumulativeOutput
    ? numberOr(usage.output_tokens, state.outputTokens)
    : state.outputTokens + numberOr(usage.output_tokens, 0)
}

/**
 * 把一条 Messages SSE 行喂进状态，返回这一行该发出的 DSH 块。
 *
 * 忽略不携带内容的行：SSE 注释（心跳）、`event:` 名字行（载荷自带的 `type` 才是权威）、
 * 空行与本构建不认识的事件类型。`error` 事件**抛错**：回复已经结束，
 * 继续把它冲成一个干净 stop 等于把错误答案报成成功答案。
 *
 * @param line - 一行 SSE 文本（不要求带换行）。
 * @param state - 本次响应的累积状态。
 */
export function processGlmAnthropicStreamLine(
  line: string,
  state: GlmAnthropicStreamState,
): StreamChunk[] {
  const trimmed = line.trim()
  // finished 之后任何输入都返回空：finish 之后不得再有块。
  if (state.finished || trimmed === '') return []
  if (trimmed.startsWith(':')) return []
  if (trimmed.startsWith('event:')) return []
  if (!trimmed.startsWith('data:')) return []
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return []

  const event = safeJsonParse(payload)
  if (!isRecord(event)) return []
  const type = asString(event.type)
  const out: StreamChunk[] = []

  if (type === 'message_start') {
    state.sawMessageStart = true
    const message = isRecord(event.message) ? event.message : undefined
    const usage = message !== undefined && isRecord(message.usage) ? message.usage : undefined
    if (usage !== undefined) applyUsage(state, usage, false)
    const stop = message === undefined ? undefined : asString(message.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    return out
  }

  if (type === 'content_block_start') {
    const contentIndex = numberOr(event.index, -1)
    const block = isRecord(event.content_block) ? event.content_block : {}
    const blockType = asString(block.type)

    if (blockType === 'tool_use') {
      // 同一 content 下标上再开一次工具调用是上游异常，但旧调用必须先关掉，
      // 否则它的参数会永远停在半截。
      out.push(...closeToolCall(state, contentIndex))
      const index = state.blocks.length
      const id = asString(block.id) ?? 'toolu_' + String(index)
      const name = asString(block.name) ?? ''
      // start 块可能自带完整（或部分）input；从它取种子，
      // 否则一条 input 永远不来片段的流会拼出 '{}'。
      const seed = isRecord(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ''
      state.toolCalls.set(contentIndex, { index, id, name, arguments: seed })
      state.blocks.push({ type: 'tool-call', id: toToolCallId(id), name, arguments: seed })
      state.hasToolCall = true
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: toToolCallId(id), name, argumentsDelta: seed })
      return out
    }

    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      out.push(...closeThinkingBlock(state, contentIndex))
      out.push(...openThinkingBlock(state, contentIndex, block, blockType))
      return out
    }

    // 文本，以及本构建不认识的块型：未知块的增量交给下面的 delta 分支判断到底是什么，
    // 而不是在这里被悄悄丢掉。
    out.push(...openTextAt(state, contentIndex).chunks)
    return out
  }

  if (type === 'content_block_delta') {
    const contentIndex = numberOr(event.index, -1)
    const delta = isRecord(event.delta) ? event.delta : {}
    const deltaType = asString(delta.type)

    if (deltaType === 'input_json_delta') {
      const pending = state.toolCalls.get(contentIndex)
      const partial = asString(delta.partial_json) ?? ''
      if (pending !== undefined && partial !== '') {
        // 逐字拼接，只在 stop 时定稿一次。
        pending.arguments += partial
        out.push({
          type: 'tool-call-delta',
          index: pending.index,
          id: toToolCallId(pending.id),
          name: pending.name,
          argumentsDelta: partial,
        })
      }
      return out
    }

    if (deltaType === 'signature_delta') {
      const pending = state.pending.get(contentIndex)
      const signature = asString(delta.signature) ?? ''
      if (pending !== undefined && signature !== '') pending.signature += signature
      return out
    }

    if (deltaType === 'thinking_delta' || deltaType === 'reasoning_delta') {
      const pending = state.pending.get(contentIndex)
      const text = sanitizeText(asString(delta.thinking) ?? asString(delta.text) ?? '')
      if (pending === undefined || pending.kind !== 'thinking' || text === '') return out
      pending.text += text
      out.push({ type: 'reasoning-delta', index: pending.index, text })
      return out
    }

    // GLM 家族在兼容网关上可能用 `reasoning_content` 而不是 thinking 块
    // （同族两条线的 OpenAI 面都走这个字段，见 `../workbuddy/mapper.ts:627`）。
    // 本面到底发哪一种没有实测样本（**未验证**），所以两种都认：
    // 认错方向的代价是把思考文本当正文显示。
    const reasoningField = asString(delta.reasoning_content) ?? asString(delta.reasoning)
    if (reasoningField !== undefined && reasoningField !== '' && deltaType !== 'text_delta') {
      const pending = state.pending.get(contentIndex)
      if (pending !== undefined && pending.kind === 'thinking') {
        const clean = sanitizeText(reasoningField)
        pending.text += clean
        out.push({ type: 'reasoning-delta', index: pending.index, text: clean })
        return out
      }
      // 没有对应的 thinking 块（例如网关只发增量）：惰性开一个思考块，
      // 绝不把思考文本并进正在接收的文本块。
      out.push(...closeTextBlock(state, contentIndex))
      const index = state.blocks.length
      const clean = sanitizeText(reasoningField)
      state.blocks.push({ type: 'reasoning', text: clean })
      state.hasContent = true
      out.push({ type: 'block-start', index, blockType: 'reasoning' })
      out.push({ type: 'reasoning-delta', index, text: clean })
      return out
    }

    // text_delta，以及任何长得像它的东西。文本增量可以不带 content_block_start
    // （只发增量的代理），所以它属于哪个块在这里惰性打开，而不是被丢掉。
    const text = asString(delta.text)
    if (text === undefined || text === '') return out
    const opened = openTextAt(state, contentIndex)
    out.push(...opened.chunks)
    const clean = sanitizeText(text)
    opened.block.text += clean
    state.hasContent = true
    out.push({ type: 'text-delta', index: opened.block.index, text: clean })
    return out
  }

  if (type === 'content_block_stop') {
    const contentIndex = numberOr(event.index, -1)
    if (state.toolCalls.has(contentIndex)) return closeToolCall(state, contentIndex)
    if (state.pending.has(contentIndex)) return closeThinkingBlock(state, contentIndex)
    return closeTextBlock(state, contentIndex)
  }

  if (type === 'message_delta') {
    const delta = isRecord(event.delta) ? event.delta : undefined
    const stop = delta === undefined ? undefined : asString(delta.stop_reason)
    if (stop !== undefined && stop !== '') state.finishReason = stop
    const usage = isRecord(event.usage) ? event.usage : undefined
    // Anthropic 公开形态：message_start 给一个零值 usage 桩，真正的计数在终止增量里。
    if (usage !== undefined) applyUsage(state, usage, true)
    return out
  }

  if (type === 'message_stop') {
    state.sawMessageStop = true
    return closeGlmAnthropicStream(state)
  }

  if (type === 'error') {
    const error = isRecord(event.error) ? event.error : {}
    const verdict = classifyGlmUpstreamError({ body: error })
    // 记下原始 error 对象：此刻可能已经有内容到了调用方，适配层据此判断还能不能安全重试。
    state.streamError = error
    const code = verdict.businessCode === null && isContextOverflow(error) ? CONTEXT_OVERFLOW_CODE : verdict.llmCode
    throw new LlmError(
      PROVIDER_NAME + ' 流错误'
      + (verdict.businessCode === null ? '' : '（业务码 ' + String(verdict.businessCode) + '）')
      + '：' + (asString(error.message) ?? '未知错误'),
      code,
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// 业务错误码分类
// ---------------------------------------------------------------------------

/** 一次上游失败的机器可读判读结果。 */
export interface GlmUpstreamErrorVerdict {
  /** 该转成哪一个 `LlmError.code`（重试策略按它判读）。 */
  llmCode: string
  /**
   * 这一类失败值不值得重试。
   *
   * 判据来自 `./types.ts` 的 `ERROR_CODE` 注释：可重试的只有 `RATE_LIMITED`（退避后重试，
   * 号池可换账号）与 `OVERLOADED`（瞬时过载）；其余全部不可重试——重试一次确定的失败
   * 只会把它拖成多次，并在额度类错误上多烧一次额度。
   * `USAGE_LIMIT` / `PLAN_LIMIT` 带重置时刻，正确处置是等窗口重置而不是立刻重试。
   */
  retryable: boolean
  /** 正文给出的业务码；没有则是 null。 */
  businessCode: number | null
  /** HTTP 状态；调用方没给则是 null。 */
  status: number | null;
  /** 面向人的处置说明。 */
  disposition: string;
}

/** 从上游错误正文里取出业务码（平台信封是 `{code, message}`，内层 `{error:{code}}` 也见过）。 */
function businessCodeOf(body: unknown): number | null {
  if (typeof body === 'number' && Number.isFinite(body)) return body
  if (!isRecord(body)) return null
  for (const key of ['code', 'error_code', 'errorCode']) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  }
  const nested = isRecord(body.error) ? body.error : undefined
  if (nested !== undefined && nested !== body) return businessCodeOf(nested)
  return null
}

/** 业务码 → 重试判读。取值逐条来自 `./types.ts` 的 `ERROR_CODE`（实测转录，等级 A）。 */
const VERDICT_BY_CODE: ReadonlyMap<number, { llmCode: string; retryable: boolean; disposition: string }> = new Map([
  // 401 三条：处置是重新登录或提前刷新业务 JWT，重试同一个请求没有意义。
  [ERROR_CODE.AUTH_MISSING, { llmCode: 'AUTH', retryable: false, disposition: '凭据没有出现在请求头里：检查请求头构造或凭据存储。' }],
  [ERROR_CODE.AUTH_INVALID, { llmCode: 'AUTH', retryable: false, disposition: '凭据无效：重新登录本线路。' }],
  [ERROR_CODE.AUTH_EXPIRED, { llmCode: 'AUTH', retryable: false, disposition: '凭据已过期：业务 JWT 可提前 120 秒自取，access_token 只能重新登录。' }],
  // 429 里的额度类：立即重试只会继续失败并多烧一次额度。
  [ERROR_CODE.NO_BALANCE, { llmCode: 'QUOTA', retryable: false, disposition: '没有余额也没有可用资源包。' }],
  [ERROR_CODE.USAGE_LIMIT, { llmCode: 'QUOTA', retryable: false, disposition: '具名用量窗口已用尽：等窗口重置（正文带重置时刻）。' }],
  [ERROR_CODE.PLAN_LIMIT, { llmCode: 'QUOTA', retryable: false, disposition: '周度或月度额度已用尽：等窗口重置。' }],
  [ERROR_CODE.PLAN_EXPIRED, { llmCode: 'PROVIDER_ERROR', retryable: false, disposition: 'Coding Plan 套餐已失效：续费后才能继续。' }],
  [ERROR_CODE.MODEL_NOT_IN_PLAN, { llmCode: 'PROVIDER_ERROR', retryable: false, disposition: '当前套餐不包含这个模型：在模型目录里关掉它。' }],
  // 400 / 403：请求本身错了，重试是同一次错误再来一遍。
  [ERROR_CODE.UNKNOWN_MODEL, { llmCode: 'NOT_FOUND', retryable: false, disposition: '未知模型 id：本地目录不该发出这种 id，出现即目录错了。' }],
  [ERROR_CODE.WRONG_METHOD, { llmCode: 'PROVIDER_ERROR', retryable: false, disposition: '该模型不提供这个调用方式：检查目录声明的协议面。' }],
  [ERROR_CODE.MISSING_PARAM, { llmCode: 'INVALID_ARGS', retryable: false, disposition: '缺必填参数：请求体构造有缺口。' }],
  [ERROR_CODE.INVALID_PARAM, { llmCode: 'INVALID_ARGS', retryable: false, disposition: '参数取值被拒（例如不支持的思考档位）：检查档位收敛结果。' }],
  [ERROR_CODE.NO_PERMISSION, { llmCode: 'PROVIDER_ERROR', retryable: false, disposition: '账号的套餐不包含这个 API。' }],
  [ERROR_CODE.PROMPT_TOO_LONG, { llmCode: CONTEXT_OVERFLOW_CODE, retryable: false, disposition: '提示词超出模型窗口：先压缩再请求。' }],
  [ERROR_CODE.CONTENT_FILTERED, { llmCode: 'PROVIDER_ERROR', retryable: false, disposition: '上游内容过滤拒绝了这次输入：改写输入，不要重试。' }],
  // 429 里唯二可重试的两条。
  [ERROR_CODE.RATE_LIMITED, { llmCode: 'RATE_LIMIT', retryable: true, disposition: '请求频率限制：退避后重试，号池可换一个账号。' }],
  [ERROR_CODE.OVERLOADED, { llmCode: 'SERVER', retryable: true, disposition: '瞬时服务过载：退避后重试。' }],
])

/**
 * 把一次上游失败判读成机器可路由的结论。
 *
 * 分类**不能停在状态行**：多个真实条件共用同一个 HTTP 状态（表里 429 有六条，
 * 401 有三条），所以正文里的业务码才是判据，状态行只在本面没给出业务码时兜底。
 *
 * 两个兜底方向都是有意选的：
 *
 * - 未知 5xx → 可重试（传输面故障，语义上与 OVERLOADED 同族）。
 * - 未知 429 → **不可重试**。本表里六条 429 里有五条是额度类，立即重试只会继续失败，
 *   还会多烧一次额度；宁可让调用方等一下也不要把它变成重试风暴。
 *
 * @param input - HTTP 状态（可选）与上游正文（可选）。
 */
export function classifyGlmUpstreamError(
  input: { status?: number | undefined; body?: unknown },
): GlmUpstreamErrorVerdict {
  const status = typeof input.status === 'number' && Number.isFinite(input.status) ? input.status : null
  const businessCode = businessCodeOf(input.body)
  const hit = businessCode === null ? undefined : VERDICT_BY_CODE.get(businessCode)
  if (hit !== undefined) {
    return { llmCode: hit.llmCode, retryable: hit.retryable, businessCode, status, disposition: hit.disposition }
  }
  if (status !== null && status >= 500) {
    return { llmCode: 'SERVER', retryable: true, businessCode, status, disposition: '上游 5xx：退避后重试。' }
  }
  if (status !== null && status === 429) {
    return {
      llmCode: 'PROVIDER_ERROR',
      retryable: false,
      businessCode,
      status,
      disposition: '未识别的 429：本线路大多数 429 是额度类，等一下或看正文再试。',
    }
  }
  if (status === 401 || status === 403) {
    return { llmCode: 'AUTH', retryable: false, businessCode, status, disposition: '鉴权失败：重新登录。' }
  }
  return {
    llmCode: 'PROVIDER_ERROR',
    retryable: false,
    businessCode,
    status,
    disposition: '未识别的上游失败。',
  }
}

/**
 * 构造一次上游失败（不抛，交给调用方决定抛点）。
 *
 * 让调用方（适配层）既拿到 `LlmError` 的稳定 code，又拿到「这次到底该不该重试」的
 * 判读结果——两者不是一回事：code 决定路由，retryable 决定重试策略。
 *
 * @param input - HTTP 状态（可选）与上游正文（可选）。
 */
export function glmUpstreamError(input: { status?: number | undefined; body?: unknown }): LlmError {
  const verdict = classifyGlmUpstreamError(input)
  const detail = isRecord(input.body)
    ? (asString(input.body.message) ?? (isRecord(input.body.error) ? asString(input.body.error.message) : undefined))
    : undefined
  return new LlmError(
    PROVIDER_NAME + ' 请求失败'
    + (verdict.businessCode === null ? '' : '（业务码 ' + String(verdict.businessCode) + '）')
    + (verdict.status === null ? '' : '（HTTP ' + String(verdict.status) + '）')
    + '：' + (detail ?? '未知失败')
    + ' ' + verdict.disposition,
    verdict.llmCode,
    verdict.status === null ? undefined : { status: verdict.status },
  )
}

export type { ContentBlock }
