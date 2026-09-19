import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { toToolCallId } from '../common/brand-compat.ts'
import {
  ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
  ANTIGRAVITY_PROGRESS_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  GEMINI_ROLE,
  PROVIDER_ID,
  RUNTIME_MAX_OUTPUT_TOKENS,
  TOOL_CALLING_MODE,
  type AntigravityModelDef,
} from './types.ts'
import { toAntigravityToolSchema } from './tool-schema.ts'

let toolCallCounter = 0

function sanitizeText(text: string): string {
  return text.replace(/\0/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function sanitizeToolCallId(id: string, fallbackName: string): string {
  const cleaned = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const capped = cleaned.slice(0, 64)
  return capped || `${fallbackName || 'tool'}_${Date.now()}_${++toolCallCounter}`
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return (
    modelId.startsWith('claude-') ||
    modelId.startsWith('gpt-oss-') ||
    runtimeModel.startsWith('claude-') ||
    runtimeModel.startsWith('gpt-oss-')
  )
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (raw === undefined || raw === null || raw === '') return {}
  const parsed = typeof raw === 'string' ? safeJsonParse(raw) : raw
  return isRecord(parsed) ? parsed : {}
}

/** Attachment seam this route needs: verified bytes for one durable image. */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage'>

/** One durable user image resolved for an in-flight request, or proven unreadable. */
export type ResolvedRequestImage =
  | { readonly kind: 'inline'; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'unavailable' }

/** Resolved images keyed by durable attachment id; consumed by one request build. */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>

const NO_RESOLVED_IMAGES: ResolvedRequestImages = new Map()

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
    // Tool results nest their own content, and a screenshot or a read_image
    // result carries its pixels there. Stopping at the top level made every
    // tool-produced image unresolvable before it could reach the wire.
    if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

/**
 * Model-facing replacement for an image this route omits to stay inside its
 * request budget. The wording matches DSH's own placeholder, which this plugin
 * cannot import: that symbol moved inside the supported DSH range
 * (`OFFLOADED_IMAGE_TEXT` in 0.1.1-rc.2, the `offloadedImageText()` function in
 * 0.1.5-rc.1), `offloadRequestImages()` was removed in 0.1.5-rc.1, and
 * `offloadRequestImagesWithPolicy()` gained a required `placeholder` field.
 * Binding to either shape would break the plugin on some supported host exactly
 * the way the `CallId` export did; `host/common/brand-compat.ts` carries the
 * same lesson.
 */
const OMITTED_IMAGE_TEXT = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * Base64 image payload one Antigravity request may carry. Google caps a request
 * carrying inline data at 20 MB, and the same body also holds the system
 * instruction, the conversation text, and the tool declarations.
 */
export const MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** Request payload one inline image block occupies, when it can be measured. */
function requestImageBytes(block: Record<string, unknown>): number | undefined {
  const attachment = attachmentOf(block)
  if (attachment) return base64Length(attachment.bytes)
  const inline = asString(block.data) || asString(block.base64)
  return inline ? inline.length : undefined
}

function collectRequestImageBytes(content: unknown, lengths: number[]): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const bytes = requestImageBytes(block)
    if (bytes !== undefined) lengths.push(bytes)
  }
}

/**
 * Replace the oldest inline images with a text placeholder once one request
 * would carry more than {@link MAX_REQUEST_IMAGE_BYTES} of base64 image data.
 *
 * Without this bound an image-heavy session keeps growing the request body until
 * Google rejects it, and the images that made it fail are the ones the model
 * needed least. The oldest occurrences go first, exactly as DSH's own providers
 * order them, and the placeholder tells the model the image is missing instead
 * of letting it answer as though the picture were simply blank.
 *
 * @param options - the request about to be built; durable history stays untouched.
 * @returns the original options when they already fit, otherwise shallow copies.
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
  const messages = options.messages.map((message) => {
    if (remaining.count === 0 || !Array.isArray(message.content)) return message
    let replaced = false
    const content = message.content.map((block) => {
      if (remaining.count === 0 || !isRecord(block) || block.type !== 'image') return block
      if (requestImageBytes(block) === undefined) return block
      remaining.count -= 1
      replaced = true
      return { type: 'text', text: OMITTED_IMAGE_TEXT } as ContentBlock
    })
    return replaced ? { ...message, content } : message
  })
  return { ...options, messages }
}

/**
 * Read every durable `{ type: 'image', attachment }` block one request carries.
 *
 * This provider declares image input, so DSH hands those blocks to the adapter
 * unchanged instead of projecting them to text, and Gemini can only receive them
 * as `inlineData` bytes. An image that cannot be read resolves to
 * `unavailable` rather than disappearing: `contentToUserParts` then leaves the
 * model a text marker, because a turn that silently loses its image is far
 * harder to diagnose than one that says so.
 *
 * @param options - the exact request about to be built.
 * @param attachments - durable attachment store; absent when the host wired none.
 * @param signal - cancellation, forwarded to every attachment read.
 * @returns one resolution per distinct attachment id, empty when there is no image.
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
      // Cancellation is the caller's own decision and must not become model text.
      if (isAbort(error, signal)) throw error
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

function imageBlockToPart(
  block: Record<string, unknown>,
  images: ResolvedRequestImages,
): { inlineData: { mimeType: string; data: string } } | undefined {
  let data = asString(block.data) || asString(block.base64)
  const source = isRecord(block.source) ? block.source : undefined
  if (!data && source) data = asString(source.data) || asString(source.base64)
  let mimeType =
    asString(block.mimeType) ||
    asString(block.mediaType) ||
    (source ? asString(source.mimeType) || asString(source.mediaType) : undefined) ||
    'image/png'

  if (data?.startsWith('data:')) {
    const match = data.match(/^data:([^;,]+);base64,(.*)$/s)
    if (match) {
      mimeType = match[1] || mimeType
      data = match[2] || ''
    }
  }
  if (data) return { inlineData: { mimeType, data } }

  const attachment = attachmentOf(block)
  const resolved = attachment ? images.get(attachment.attachmentId) : undefined
  // The media type comes from the verified reference, not from the block.
  return resolved?.kind === 'inline'
    ? { inlineData: { mimeType: resolved.mediaType, data: resolved.data } }
    : undefined
}

function contentToUserParts(content: unknown, images: ResolvedRequestImages): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ text: sanitizeText(content) }]
  if (!Array.isArray(content)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push({ text: sanitizeText(block.text) })
    } else if (isRecord(block) && block.type === 'image') {
      const img = imageBlockToPart(block, images)
      // An image part is never dropped silently.
      parts.push(img ?? { text: unavailableImageText(block) })
    }
  }
  return parts
}

/**
 * Image parts for one tool result, flattened the same way so a nested
 * `tool-result` cannot hide one. Gemini's `functionResponse` has nowhere to put
 * an image, so these become `inlineData` siblings on the same user content.
 */
function toolResultImageParts(
  blocks: unknown,
  images: ResolvedRequestImages,
): Array<Record<string, unknown>> {
  if (!Array.isArray(blocks)) return []
  const parts: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'image') {
      // Never dropped silently: an unreadable image says so.
      parts.push(imageBlockToPart(block, images) ?? { text: unavailableImageText(block) })
      continue
    }
    if (block.type === 'tool-result') parts.push(...toolResultImageParts(block.content, images))
  }
  return parts
}

function toolResultText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      if (!isRecord(block)) return ''
      if (block.type === 'text' && typeof block.text === 'string') return sanitizeText(block.text)
      if (block.type === 'tool-result') return toolResultText(block.content)
      // A tool-result image is named, not inlined. DSH's own multi-provider
      // adapter flattens a tool result to text and drops non-text blocks outright
      // (llm-pi-ai context.ts), so naming the image already keeps more of the loss
      // visible than the reference route does; sending it as
      // functionResponse.parts would be inventing wire support this endpoint
      // cannot be verified against locally.
      if (block.type === 'image') {
        const label = attachmentLabel(block)
        return label ? `[image: ${label}]` : '[image]'
      }
      return ''
    })
    .join('')
}

function replayBlockFor(message: Message, index: number): Record<string, unknown> | undefined {
  const source = message.source
  if (!source || source.kind !== 'model' || source.provider !== PROVIDER_ID) return undefined
  const state = source.replayState
  if (!isRecord(state)) return undefined
  if (Array.isArray(state.blocks)) return state.blocks[index] as Record<string, unknown>
  const resp = isRecord(state.response) ? (state.response as Record<string, unknown>) : undefined
  if (resp) {
    if (Array.isArray(resp.outputItems)) return resp.outputItems[index] as Record<string, unknown>
    if (Array.isArray(resp.blocks)) return resp.blocks[index] as Record<string, unknown>
  }
  return undefined
}

function thoughtSignature(part: Record<string, unknown> | undefined): string | undefined {
  return asString(part?.thoughtSignature) || asString(part?.thought_signature) ||
    asString(part?.thinkingSignature) || asString(part?.textSignature)
}

function replayPart(part: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...part }
  const signature = thoughtSignature(part)
  delete copy.thought_signature
  delete copy.thinkingSignature
  if (signature) copy.thoughtSignature = signature
  if (typeof copy.text === 'string') copy.text = sanitizeText(copy.text)
  return copy
}

interface ToolCallReference {
  name: string
  id?: string
}

function assistantParts(
  message: Message,
  model: AntigravityModelDef,
  runtimeModel: string,
  toolCalls: Map<string, ToolCallReference>,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  if (!Array.isArray(message.content)) return parts

  for (let index = 0; index < message.content.length; index++) {
    const block = (message.content[index] as unknown) as Record<string, unknown>
    if (!isRecord(block)) continue
    const replay = replayBlockFor(message, index)
    const originalParts = Array.isArray(replay?.parts) ? replay.parts.filter(isRecord) : []
    // Preserve signed part boundaries, including empty signature-only parts.
    if ((block.type === 'text' || block.type === 'reasoning') && originalParts.length > 0 &&
      originalParts.every((part) => !part.functionCall) &&
      originalParts.map((part) => asString(part.text) || '').join('') === sanitizeText(String(block.text || ''))) {
      parts.push(...originalParts.map(replayPart))
      continue
    }
    if (block.type === 'text' && String(block.text || '').trim()) {
      const sig = thoughtSignature(replay) || thoughtSignature(block)
      parts.push({ text: sanitizeText(String(block.text)), ...(sig ? { thoughtSignature: sig } : {}) })
    } else if (block.type === 'reasoning' && String(block.text || '').trim()) {
      const sig = thoughtSignature(replay) || thoughtSignature(block)
      parts.push({
        thought: true,
        text: sanitizeText(String(block.text)),
        ...(sig ? { thoughtSignature: sig } : {}),
      })
    } else if (block.type === 'tool-call') {
      const toolId = String(block.id || '')
      const toolName = String(block.name || '')

      // 提取 thought_signature，若历史缺失则自动回退至 Google 官方 bypass 标记
      const originalCall = originalParts.find((part) => isRecord(part.functionCall))
      const originalFunctionCall = isRecord(originalCall?.functionCall) ? originalCall.functionCall : undefined
      // Wire IDs are opaque. Old sessions may have a sanitized DSH ID, so keep
      // the original ID separately and use it for both the call and its result.
      const wireId = asString(originalFunctionCall?.id) || (toolCallIdNeeded(model.id, runtimeModel)
        ? sanitizeToolCallId(toolId, toolName)
        : originalCall ? undefined : toolId || undefined)
      toolCalls.set(toolId, { name: toolName, id: wireId })
      const sig = thoughtSignature(originalCall) || thoughtSignature(replay) || thoughtSignature(block)
      // Native parallel calls may be unsigned. Only legacy/imported history needs the bypass.
      const effectiveSignature = sig || (originalCall ? undefined : 'skip_thought_signature_validator')

      parts.push({
        functionCall: {
          name: toolName,
          args: parseArguments(block.arguments),
          ...(wireId ? { id: wireId } : {}),
        },
        ...(effectiveSignature ? { thoughtSignature: effectiveSignature } : {}),
      })
      parts.push(...originalParts.filter((part) => !part.functionCall).map(replayPart))
    }
  }
  return parts
}

function pushToolResult(
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  result: Record<string, unknown>,
  toolCalls: Map<string, ToolCallReference>,
  model: AntigravityModelDef,
  runtimeModel: string,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): void {
  const toolCallId = String(result.toolCallId || '')
  const call = toolCalls.get(toolCallId)
  const toolName = call?.name || 'unknown'
  const wireId = call?.id || (toolCallIdNeeded(model.id, runtimeModel)
    ? sanitizeToolCallId(toolCallId, toolName)
    : undefined)
  const responseText = toolResultText(result.content) || (result.isError ? 'Tool failed' : '')
  const part = {
    functionResponse: {
      name: toolName,
      response: result.isError ? { error: responseText } : { output: responseText },
      ...(wireId ? { id: wireId } : {}),
    },
  }

  // Gemini allows one user content to mix `functionResponse` and `inlineData`
  // parts, which is the only place a tool-produced image can travel on this
  // wire. With no images the parts array is byte-for-byte what it was before.
  const extraParts = toolResultImageParts(result.content, images)
  const last = contents[contents.length - 1]
  if (last?.role === GEMINI_ROLE.user && last.parts.some((entry) => 'functionResponse' in entry)) {
    last.parts.push(part, ...extraParts)
  } else {
    contents.push({ role: GEMINI_ROLE.user, parts: [part, ...extraParts] })
  }
}

export function convertMessages(
  options: GenerateOptions,
  model: AntigravityModelDef,
  runtimeModel: string,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = []
  const toolCalls = new Map<string, ToolCallReference>()

  for (const message of options.messages) {
    const role = (message as unknown as { role?: string }).role || (message.source?.kind === 'model' ? 'assistant' : 'user')
    if (role === 'assistant' || message.source?.kind === 'model') {
      const parts = assistantParts(message, model, runtimeModel, toolCalls)
      if (parts.length) contents.push({ role: GEMINI_ROLE.model, parts })
      continue
    }

    const content = Array.isArray(message.content) ? message.content : []
    const nonResult = content.filter((b) => !isRecord(b) || b.type !== 'tool-result')
    const userParts = contentToUserParts(nonResult, images)
    if (role === 'system') {
      if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts })
      continue
    }
    if (userParts.length) contents.push({ role: GEMINI_ROLE.user, parts: userParts })
    for (const b of content) {
      if (isRecord(b) && b.type === 'tool-result') {
        pushToolResult(contents, b, toolCalls, model, runtimeModel, images)
      }
    }
  }
  return contents
}

export function stripMetaSchema(schema: unknown): unknown {
  return toAntigravityToolSchema(schema)
}

export function convertTools(
  tools: GenerateOptions['tools'],
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined
  const declarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: stripMetaSchema(tool.parameters) || { type: 'object', properties: {} },
  }))
  return [{ functionDeclarations: declarations }]
}

export function mapToolChoiceMode(toolChoice: unknown): string {
  if (toolChoice === 'none') return TOOL_CALLING_MODE.none
  if (toolChoice === 'any' || toolChoice === 'required') return TOOL_CALLING_MODE.any
  return TOOL_CALLING_MODE.auto
}

export function getMaxOutputTokens(modelId: string, runtimeModel: string): number {
  return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] || RUNTIME_MAX_OUTPUT_TOKENS[modelId] || 65536
}

export function progressExplanationInstruction(tools: GenerateOptions['tools']): string | undefined {
  if (!tools?.length) return undefined
  return ANTIGRAVITY_PROGRESS_INSTRUCTION
}

export function buildRequest(
  options: GenerateOptions,
  model: AntigravityModelDef,
  projectId: string,
  runtimeModel: string,
  effort?: string,
  images: ResolvedRequestImages = NO_RESOLVED_IMAGES,
): Record<string, unknown> {
  const progressInstruction = progressExplanationInstruction(options.tools)
  const request: Record<string, unknown> = {
    contents: convertMessages(options, model, runtimeModel, images),
    systemInstruction: {
      role: GEMINI_ROLE.user,
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(options.system ? [{ text: sanitizeText(options.system) }] : []),
        // Last part on purpose: the progress rule must outweigh the huge caller
        // system prompt, which Gemini otherwise follows into a thought-only reply.
        ...(progressInstruction ? [{ text: progressInstruction }] : []),
      ],
    },
  }

  const generationConfig: Record<string, unknown> = {}
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature

  // Gemini 只在 thinkingConfig.includeThoughts 为 true 时才返回 thought 部分，否则模型照常思考
  // （usageMetadata.thoughtsTokenCount 照常计入）但流里没有可渲染的思维链。
  // 1. tiered 运行时：思考档位由 effort 决定，同时必须请求返回思考内容 includeThoughts。
  // 2. 带档位后缀、agent 别名及 Gemini 3 运行时：补 includeThoughts，保留路由选择的档位。
  // 3. Gemini 2.5 系列：采用 thinkingBudget 控制思考预算与 includeThoughts。
  // 4. Claude 运行时依赖 anthropic-beta interleaved-thinking 头，非思考模型均不发送 thinkingConfig。
  const isTiered = runtimeModel === 'gemini-3.8-flash-tiered' || runtimeModel === 'gemini-3.7-flash-tiered'
  const isSuffixed = /^gemini-.+(?:-(?:extra-)?low|-medium|-high|-xhigh)$/.test(runtimeModel)
  const isGemini25 = runtimeModel.startsWith('gemini-2.5-') || model.id.startsWith('gemini-2.5-')
  const isGemini3 = /^gemini-3[.-]/.test(runtimeModel) && !runtimeModel.includes('image')
  const isGeminiAgent = runtimeModel === 'gemini-pro-agent' || runtimeModel === 'gemini-3-flash-agent'

  if (isTiered) {
    const selected = (effort || 'medium').toLowerCase()
    const isOff = selected === 'off' || selected === 'none'
    // Gemini 3.7/3.8 support LOW, MEDIUM and HIGH, but cannot disable thinking.
    // Legacy off/none requests use LOW and suppress the thought summary.
    generationConfig.thinkingConfig = {
      thinkingLevel: selected === 'high' || selected === 'xhigh'
        ? 'HIGH'
        : selected === 'medium'
          ? 'MEDIUM'
          : 'LOW',
      includeThoughts: !isOff,
    }
  } else if (isSuffixed || isGemini3 || isGeminiAgent) {
    const selected = (effort || 'medium').toLowerCase()
    const isOff = selected === 'off' || selected === 'none'
    generationConfig.thinkingConfig = {
      includeThoughts: !isOff,
    }
  } else if (isGemini25) {
    const selected = (effort || 'medium').toLowerCase()
    const isOff = selected === 'off' || selected === 'none'
    const budget = isOff
      ? 0
      : selected === 'high' || selected === 'xhigh'
        ? 32768
        : selected === 'medium'
          ? 16384
          : 4096
    generationConfig.thinkingConfig = {
      thinkingBudget: budget,
      includeThoughts: !isOff,
    }
  }
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel)
  generationConfig.maxOutputTokens =
    options.maxTokens !== undefined ? Math.min(options.maxTokens, maxAllowed) : maxAllowed

  request.generationConfig = generationConfig

  const toolChoice = (options as unknown as { toolChoice?: unknown }).toolChoice
  const tools = convertTools(options.tools)
  if (tools) {
    request.tools = tools
    if (toolChoice) {
      request.toolConfig = { functionCallingConfig: { mode: mapToolChoiceMode(toolChoice) } }
    }
  }

  if (options.sessionId) request.sessionId = String(options.sessionId)

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  }
}

export interface StreamState {
  blocks: ContentBlock[]
  replayBlocks: Array<{ parts: Array<Record<string, unknown>> }>
  currentBlock: { index: number; type: 'text' | 'reasoning'; text: string } | null
  hasContent: boolean
  hasToolCall: boolean
  usageMetadata: Record<string, number> | null
  finishReason?: string
  done: boolean
  finished: boolean
}

export function createStreamState(): StreamState {
  return {
    blocks: [],
    replayBlocks: [],
    currentBlock: null,
    hasContent: false,
    hasToolCall: false,
    usageMetadata: null,
    done: false,
    finished: false,
  }
}

function closeCurrentBlock(state: StreamState): StreamChunk[] {
  if (!state.currentBlock) return []
  const { index, type, text } = state.currentBlock
  const block: ContentBlock = { type, text }
  state.blocks[index] = block
  state.currentBlock = null
  return [{ type: 'block-end', index, block }]
}

const USAGE_FIELDS = [
  'promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount',
] as const

function collectUsage(value: unknown, state: StreamState): void {
  if (!isRecord(value)) return
  for (const key of USAGE_FIELDS) {
    const count = value[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue
    state.usageMetadata ??= {}
    // SSE frames contain cumulative snapshots, sometimes with only changed fields.
    state.usageMetadata[key] = count
  }
}

function tokenUsage(u: Record<string, number>): TokenUsage {
  const prompt = u.promptTokenCount ?? 0
  const cache = Math.min(prompt, u.cachedContentTokenCount ?? 0)
  const thoughts = u.thoughtsTokenCount ?? 0
  const explicitOutput = (u.candidatesTokenCount ?? 0) + thoughts
  const totalOutput = u.totalTokenCount !== undefined && u.promptTokenCount !== undefined
    ? Math.max(0, u.totalTokenCount - prompt)
    : 0
  return {
    // DSH counts cached and uncached input separately; output includes reasoning.
    inputTokens: prompt - cache,
    outputTokens: Math.max(explicitOutput, totalOutput),
    ...(cache > 0 ? { cacheReadTokens: cache } : {}),
    ...(u.thoughtsTokenCount !== undefined ? { reasoningTokens: thoughts } : {}),
  }
}

export function processStreamLine(line: string, state: StreamState): StreamChunk[] {
  if (state.finished || !line.startsWith('data:')) return []
  const json = line.slice(5).trim()
  if (json === '[DONE]') {
    state.done = true
    return closeStream(state)
  }
  if (!json) return []
  const chunk = safeJsonParse(json)
  if (!isRecord(chunk)) return []

  const responseData = isRecord(chunk.response) ? (chunk.response as Record<string, unknown>) : chunk
  const candidates = Array.isArray(responseData.candidates) ? responseData.candidates : []
  const candidate = isRecord(candidates[0]) ? candidates[0] : undefined
  const content = isRecord(candidate?.content) ? (candidate!.content as Record<string, unknown>) : undefined
  const parts = Array.isArray(content?.parts) ? content!.parts : []
  const out: StreamChunk[] = []

  for (const part of parts) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string' && part.text !== '') {
      const isThinking = Boolean(part.thought)
      const blockType = isThinking ? 'reasoning' : 'text'
      if (!state.currentBlock || state.currentBlock.type !== blockType) {
        out.push(...closeCurrentBlock(state))
        const index = state.blocks.length
        state.currentBlock = { index, type: blockType, text: '' }
        state.blocks.push({ type: blockType, text: '' })
        state.replayBlocks.push({ parts: [] })
        out.push({ type: 'block-start', index, blockType })
      }

      const delta = sanitizeText(part.text)
      state.currentBlock.text += delta
      state.hasContent = true
      state.replayBlocks[state.currentBlock.index].parts.push(replayPart(part))

      out.push({
        type: isThinking ? 'reasoning-delta' : 'text-delta',
        index: state.currentBlock.index,
        text: delta,
      })
    } else if (!isRecord(part.functionCall) && thoughtSignature(part)) {
      // A signature can arrive on its own after the visible text, including after STOP.
      // Keep it as its own wire part instead of moving it onto a different signed part.
      if (state.replayBlocks.length === 0) {
        const type = part.thought ? 'reasoning' : 'text'
        state.blocks.push({ type, text: '' })
        state.replayBlocks.push({ parts: [] })
        out.push({ type: 'block-start', index: 0, blockType: type })
        out.push({ type: 'block-end', index: 0, block: { type, text: '' } })
      }
      state.replayBlocks[state.replayBlocks.length - 1].parts.push(replayPart(part))
    }

    if (isRecord(part.functionCall)) {
      out.push(...closeCurrentBlock(state))
      const fc = part.functionCall as Record<string, unknown>
      const toolName = asString(fc.name) || ''
      const toolId = asString(fc.id) || sanitizeToolCallId('', toolName)
      const argsText = JSON.stringify(isRecord(fc.args) ? fc.args : {})
      const index = state.blocks.length

      const block: ContentBlock = {
        type: 'tool-call',
        id: toToolCallId(toolId),
        name: toolName,
        arguments: argsText,
      }
      state.blocks.push(block)
      const sig = thoughtSignature(part) || thoughtSignature(fc)
      state.replayBlocks.push({ parts: [{ ...replayPart(part), ...(sig ? { thoughtSignature: sig } : {}) }] })
      state.hasContent = true
      state.hasToolCall = true
      out.push({ type: 'block-start', index, blockType: 'tool-call' })
      out.push({ type: 'tool-call-delta', index, id: toToolCallId(toolId), name: toolName, argumentsDelta: argsText })
      out.push({ type: 'block-end', index, block })
    }
  }

  collectUsage(chunk.usageMetadata, state)
  if (responseData !== chunk) collectUsage(responseData.usageMetadata, state)

  const finishReason = asString(candidate?.finishReason) || asString(responseData.finishReason)
  if (finishReason) {
    state.finishReason = finishReason
    out.push(...closeCurrentBlock(state))
  }

  return out
}

export function closeStream(state: StreamState): StreamChunk[] {
  if (state.finished) return []
  if (!state.finishReason && !state.done) {
    throw new LlmError('Antigravity stream ended before its terminal response', 'PROVIDER_ERROR')
  }
  state.finished = true
  const out = closeCurrentBlock(state)
  if (state.usageMetadata) out.push({ type: 'usage', usage: tokenUsage(state.usageMetadata) })
  const reason: FinishReason = state.finishReason === 'MAX_TOKENS'
    ? { kind: 'max-tokens' }
    : state.hasToolCall
      ? { kind: 'tool-calls' }
      : { kind: 'stop' }
  out.push({
    type: 'finish',
    reason,
    replayState: { response: { provider: PROVIDER_ID }, blocks: state.replayBlocks },
  })
  return out
}
