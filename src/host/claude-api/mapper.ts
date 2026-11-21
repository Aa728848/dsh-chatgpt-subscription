/**
 * Pure wire mapping for the claude-api line: DSH GenerateOptions -> the body of
 * POST <baseUrl>/v1/messages?beta=true in the official Claude Code shape.
 *
 * SPEC: docs/claude-api-line-plan.md (request shape / beta rules / message mapping). Wire constants and
 * the identity/billing/fingerprint functions are frozen in ./types.ts; per-model
 * capabilities are frozen in ./model-catalog.ts. This module holds no credential,
 * performs no I/O and is deterministic: the same (options, images, context) always
 * produces the same body, byte for byte.
 *
 * Reference implementations read but NOT imported: relayone/mapper-anthropic.ts
 * (closest template; it drops system/developer messages, this line must not) and
 * claude/mapper.ts (system-in-place rule, tool changes, placeholder tool, cache
 * breakpoints, signed-thinking replay).
 */

import type { ContentBlock, GenerateOptions, Message } from '../common/llm-compat.ts'
import { stripMetaSchema } from '../common/tool-schema.ts'
import {
  buildClaudeCodeSystemBlocks,
  claudeCodeFirstPartyBetas,
  claudeCodeFirstUserText,
  mergeClaudeCodeBetas,
  type ClaudeCodeFirstPartyContext,
} from '../common/claude-code-first-party.ts'
import { cleanOrphanedToolCalls } from '../common/orphan-tool-calls.ts'
import {
  imageBlockToInline,
  unavailableImageText,
  attachmentLabel,
  type ResolvedRequestImages,
} from '../common/request-images.ts'
import type { ClaudeApiModelEntry } from './model-catalog.ts'
import type { ClaudeApiSettings } from './token-store.ts'
import {
  CLAUDE_API_BETA_CLEAR_AT,
  CLAUDE_API_ENTRYPOINT,
  CLAUDE_API_BETA_COMPACT,
  CLAUDE_API_BETA_FAST_MODE,
  CLAUDE_API_BETA_INLINE_TOOLS,
  CLAUDE_API_BETA_THINKING_BINDING,
  CLAUDE_API_IDENTITY_TEXT,
  CLAUDE_API_TURN_SCOPED_SOURCE_KINDS,
  claudeApiMetadataUserId,
} from './types.ts'
import { extractCheckpointSummary } from './compaction.ts'

/** Everything one request build needs beyond the options and the resolved images. */
export interface ClaudeApiRequestContext {
  entry: ClaudeApiModelEntry
  settings: ClaudeApiSettings
  /** The ONE version this request reports: billing block and fingerprint share it (the UA is the adapter's job). */
  version: string
  deviceId: string
  sessionUuid: string
  firstParty: ClaudeCodeFirstPartyContext
  /** Synchronous lookup of stored server-compaction blocks, keyed by summary text. */
  compactionBlocks?: { lookup(summary: string): { content: string; signature: string; toolChanges?: unknown } | undefined }
}

type Block = Record<string, unknown>
interface WireEntry { role: 'user' | 'assistant' | 'system'; content: Block[]; clear_at?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}
/** Strip what the wire cannot carry: NUL and unpaired surrogates (same rule as claude/mapper.ts sanitizeText). */
function sanitizeText(text: string): string {
  return text.replace(/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}
function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}

/** The role one message takes on the wire: developer and tool turns are user turns (claude/mapper.ts wireRoleOf). */
function wireRoleOf(message: Message): 'user' | 'assistant' | 'system' {
  if (message.role === 'system') return 'system'
  return message.role === 'assistant' ? 'assistant' : 'user'
}

/** The claude-api replay envelope of one assistant message, or null when it has none. */
function replayBlocksOf(message: Message): (Block | null)[] | null {
  if (message.source?.kind !== 'model' || !isRecord(message.source.replayState)) return null
  const state = message.source.replayState
  const response = isRecord(state.response) ? state.response : undefined
  if (response?.provider !== 'claude-api') return null
  const blocks = Array.isArray(state.blocks) ? state.blocks
    : response !== undefined && Array.isArray(response.blocks) ? response.blocks : null
  if (blocks === null) return null
  return blocks.map(block => isRecord(block) ? structuredClone(block) : null)
}

/** Whether an assistant turn ends in a server tool result (the alternative predecessor the vendor allows). */
function endsInServerToolResult(message: Message): boolean {
  if (message.role !== 'assistant') return false
  const replay = replayBlocksOf(message)
  if (replay === null) return false
  for (let index = replay.length - 1; index >= 0; index -= 1) {
    const block = replay[index]
    if (block === null) continue
    return typeof block.type === 'string' && block.type !== 'tool_result' && /_tool_result$/.test(block.type)
  }
  return false
}

/**
 * The vendor placement rule for a content-bearing system message: immediately after a
 * user turn (tool results included) or an assistant turn ending in a server tool result,
 * and either last or immediately before an assistant turn. Never first, never between a
 * tool_use and its tool_result (both already excluded by the predecessor rule).
 */
function legalSystemSlot(wire: readonly Message[], index: number): boolean {
  const previous = wire[index - 1]
  const next = wire[index + 1]
  const follows = previous !== undefined && (wireRoleOf(previous) === 'user' || endsInServerToolResult(previous))
  const precedes = next === undefined || wireRoleOf(next) === 'assistant'
  return follows && precedes
}

/**
 * Indices of system messages that KEEP their place. Adjacent system messages are judged
 * AS A GROUP (spec): the run is legal when its first member follows a user turn and its
 * last member precedes an assistant turn or ends the list. A model without
 * midConversationSystem folds every system message into the top-level system block.
 */
function systemMessagesInPlace(messages: readonly Message[], entry: ClaudeApiModelEntry): ReadonlySet<number> {
  const inPlace = new Set<number>()
  if (!entry.midConversationSystem) return inPlace
  let index = 0
  while (index < messages.length) {
    if (messages[index]?.role !== 'system') { index += 1; continue }
    let end = index
    while (end + 1 < messages.length && messages[end + 1]?.role === 'system') end += 1
    const previous = messages[index - 1]
    const next = messages[end + 1]
    const follows = previous !== undefined && (wireRoleOf(previous) === 'user' || endsInServerToolResult(previous))
    const precedes = next === undefined || wireRoleOf(next) === 'assistant'
    if (follows && precedes) for (let cursor = index; cursor <= end; cursor += 1) inPlace.add(cursor)
    index = end + 1
  }
  return inPlace
}

/** User turns whose source kind is turn-scoped and whose slot is legal become clear_at system messages. */
function turnScopedIndices(wire: readonly Message[], entry: ClaudeApiModelEntry): ReadonlySet<number> {
  const result = new Set<number>()
  if (!entry.midConversationSystem) return result
  for (let index = 0; index < wire.length; index += 1) {
    const message = wire[index]
    if (message === undefined || message.role !== 'user') continue
    const kind = message.source?.kind
    if (typeof kind !== 'string' || !CLAUDE_API_TURN_SCOPED_SOURCE_KINDS.includes(kind)) continue
    if (!message.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '')) continue
    // legalSystemSlot already excludes a directly following user turn (spec's extra clause).
    if (legalSystemSlot(wire, index)) result.add(index)
  }
  return result
}

function statesToolChange(message: Message): boolean {
  return message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')
}

/** Whether the history states a tool change (developer messages are the DSH carrier). */
function hasToolChanges(options: GenerateOptions): boolean {
  return options.messages.some(message => message.role === 'developer' && statesToolChange(message))
}

/** The user-side fallback statement of a tool change at an illegal position (claude/mapper.ts wording). */
function toolChangeNote(message: Message): string {
  const added: string[] = []
  const removed: string[] = []
  for (const block of message.content) {
    if (block.type !== 'tool-addition' && block.type !== 'tool-removal') continue
    const name = typeof block.toolName === 'string' ? block.toolName.trim() : ''
    if (name === '') continue
    if (block.type === 'tool-addition') added.push(name)
    else removed.push(name)
  }
  const notes: string[] = []
  if (added.length > 0) notes.push('[The tool(s) ' + added.map(name => '"' + name + '"').join(', ') + ' are now available.]')
  if (removed.length > 0) {
    notes.push('[The tool(s) ' + removed.map(name => '"' + name + '"').join(', ') + ' are no longer available. Do not call them again: any call will fail.]')
  }
  return notes.join('\n')
}

/** Concatenated text of one message (text blocks and nested tool-result text). */
function textOf(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(sanitizeText(block.text))
    else if (block.type === 'tool-result') parts.push(textOf(block.content))
  }
  return parts.join('')
}

/**
 * The user's OWN first prompt text: the first non-reminder text block of the first user
 * turn that carries one. Tool-result turns are skipped, and so are <system-reminder>
 * blocks placed ahead of the user's text (the capture shows both in the first turn).
 * CHOICE: a reminder-only user turn is skipped entirely and the scan continues, because
 * DSH appends reminder-only records that contain no user text at all.
 */
export function claudeApiFirstUserText(options: GenerateOptions): string {
  return claudeCodeFirstUserText(options.messages)
}

function imageBlockFor(block: Record<string, unknown>, images: ResolvedRequestImages, entry: ClaudeApiModelEntry): Block {
  if (!entry.supportsImages) {
    return { type: 'text', text: '[image omitted: the selected Claude API model does not declare image input]' }
  }
  const inline = imageBlockToInline(block, images)
  if (inline === undefined) return { type: 'text', text: unavailableImageText(block) }
  return { type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } }
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(sanitizeText(block.text))
    else if (block.type === 'tool-result') parts.push(toolResultText(block.content))
    else if (block.type === 'image') {
      const label = attachmentLabel(block as unknown as Record<string, unknown>)
      parts.push(label ? '[image: ' + label + ']' : '[image]')
    }
  }
  return parts.join('')
}

/** Block-array form of a tool result, or undefined when it holds no image (text-only stays a plain string). */
function toolResultContent(blocks: readonly ContentBlock[], images: ResolvedRequestImages, entry: ClaudeApiModelEntry): Block[] | undefined {
  const out: Block[] = []
  let hasImage = false
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') out.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      out.push(imageBlockFor(block as unknown as Record<string, unknown>, images, entry))
      continue
    }
    if (block.type === 'tool-result') {
      const nested = toolResultContent(block.content, images, entry)
      if (nested !== undefined) { hasImage = true; out.push(...nested) }
    }
  }
  if (!hasImage) return undefined
  // An image-only result must still lead with non-empty text (upstream rejects text: '').
  if (out[0]?.type !== 'text') out.unshift({ type: 'text', text: '(see attached image)' })
  return out
}

function userContent(message: Message, images: ResolvedRequestImages, entry: ClaudeApiModelEntry): Block[] {
  const blocks: Block[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      blocks.push(imageBlockFor(block as unknown as Record<string, unknown>, images, entry))
      continue
    }
    if (block.type === 'tool-result') {
      const rich = toolResultContent(block.content, images, entry)
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: rich ?? toolResultText(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
      })
    }
  }
  return blocks
}

/** One system-role turn: text, images, and tool_addition / tool_removal blocks (claude/mapper.ts shape). */
function systemContent(message: Message, images: ResolvedRequestImages, entry: ClaudeApiModelEntry): Block[] {
  const blocks: Block[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      blocks.push(imageBlockFor(block as unknown as Record<string, unknown>, images, entry))
      continue
    }
    if (block.type === 'tool-addition' || block.type === 'tool-removal') {
      const name = typeof block.toolName === 'string' ? block.toolName.trim() : ''
      if (name === '') continue
      blocks.push({
        type: block.type === 'tool-addition' ? 'tool_addition' : 'tool_removal',
        tool: { type: 'tool_reference', name },
      })
    }
  }
  return blocks
}

/**
 * One assistant turn. A claude-api replay envelope is replayed VERBATIM (it carries the
 * signed thinking blocks, server_tool_use and its result blocks exactly as the wire sent
 * them). Without an envelope, reasoning blocks replay only when they carry a signature;
 * unsigned thinking is dropped rather than sent unsigned (a 400 upstream).
 */
function assistantContent(message: Message): Block[] {
  const replay = replayBlocksOf(message)
  if (replay !== null) return replay.filter((block): block is Block => block !== null)
  const blocks: Block[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = sanitizeText(block.text)
      if (text !== '') blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'tool-call') {
      const parsed = safeJson(argumentsText(block.arguments))
      blocks.push({ type: 'tool_use', id: String(block.id), name: block.name, input: isRecord(parsed) ? parsed : {} })
      continue
    }
    if (block.type === 'reasoning') {
      const record = block as unknown as Record<string, unknown>
      const signature = asString(record.signature)
      const data = asString(record.data) ?? asString(record.redacted_data)
      if (data !== undefined) {
        blocks.push({ type: 'redacted_thinking', data, ...(signature !== undefined ? { signature } : {}) })
        continue
      }
      if (signature !== undefined) blocks.push({ type: 'thinking', thinking: asString(record.text) ?? '', signature })
    }
  }
  return blocks
}

/**
 * Merge neighbouring same-role turns. System turns never merge (each is its own
 * instruction), a clear_at turn stays standalone, and the leading compaction block
 * stays its own assistant message (the vendor requires exactly that shape).
 */
function mergeEntries(entries: WireEntry[]): WireEntry[] {
  const merged: WireEntry[] = []
  for (const entry of entries) {
    if (entry.content.length === 0) continue
    const last = merged[merged.length - 1]
    const standalone = entry.role === 'system' || entry.clear_at !== undefined || entry.content[0]?.type === 'compaction'
    const lastStandalone = last !== undefined && (last.role === 'system' || last.clear_at !== undefined || last.content[0]?.type === 'compaction')
    if (!standalone && !lastStandalone && last !== undefined && last.role === entry.role) {
      last.content = [...last.content, ...entry.content]
      continue
    }
    merged.push({ role: entry.role, content: [...entry.content], ...(entry.clear_at !== undefined ? { clear_at: entry.clear_at } : {}) })
  }
  return merged
}

/**
 * The stand-in declaration when every real tool is deferred and the history states a
 * tool change: the vendor refuses a tool change with no active declaration. Shape
 * transcribed from claude/mapper.ts CLAUDE_TOOL_UPDATE_PLACEHOLDER (read, not imported).
 */
const TOOL_UPDATE_PLACEHOLDER: { name: string; description: string; parameters: Record<string, unknown>; deferLoading?: true } = {
  name: 'tool_update_placeholder',
  description: 'Reserved. Keeps one tool declaration active so a mid-conversation tool change stays in the history. Never call it.',
  parameters: { type: 'object', properties: {} },
}

/** Tools send exactly name / description / input_schema / defer_loading; no name case normalization. */
function wireTools(options: GenerateOptions): Block[] {
  const tools = options.tools ?? []
  const needsPlaceholder = tools.length > 0 && tools.every(tool => tool.deferLoading === true) && hasToolChanges(options)
  const all = needsPlaceholder ? [TOOL_UPDATE_PLACEHOLDER, ...tools] : tools
  return all.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: stripMetaSchema(tool.parameters),
    ...(tool.deferLoading === true ? { defer_loading: true } : {}),
  }))
}

/** Thinking budgets per level, transcribed from claude/mapper.ts DEFAULT_THINKING_BUDGETS. */
const THINKING_BUDGETS: Readonly<Record<string, number>> = Object.freeze({ low: 2048, medium: 8192, high: 16384 })
const OFF_EFFORTS = new Set(['none', 'off', 'disabled'])

/** The selected effort: the request's own first, then the settings default; 'none' means off. */
function selectedEffort(options: GenerateOptions, settings: ClaudeApiSettings, entry: ClaudeApiModelEntry): string | undefined {
  const raw = typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim() !== ''
    ? options.reasoningEffort.trim()
    : settings.defaultReasoningEffort
  if (raw === null || raw === undefined) return undefined
  if (OFF_EFFORTS.has(raw)) return 'none'
  return (entry.reasoningEfforts as readonly string[]).includes(raw) ? raw : undefined
}

interface ThinkingFields { thinking?: Block; outputConfig?: Block; enabled: boolean; budget: number }

/**
 * The thinking form per the catalog: adaptive / budget / none. block_binding drop_block
 * is sent ONLY on the adaptive form of preservedThinking models: a live request answered
 * 400 "thinking.disabled.block_binding: Extra inputs are not permitted", so the disabled
 * and budget forms never carry it. A disable request is sent only where canDisableThinking
 * allows it; otherwise the model's own form is used.
 */
function thinkingFields(options: GenerateOptions, settings: ClaudeApiSettings, entry: ClaudeApiModelEntry): ThinkingFields {
  const effort = selectedEffort(options, settings, entry)
  const binding = entry.preservedThinking ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } } : {}
  if (effort === 'none' && entry.canDisableThinking && entry.thinkingMode !== 'none') {
    return { thinking: { type: 'disabled' }, enabled: false, budget: 0 }
  }
  if (entry.thinkingMode === 'adaptive') {
    return {
      thinking: { type: 'adaptive', display: 'summarized', ...binding },
      ...(effort !== undefined && effort !== 'none' ? { outputConfig: { effort } } : {}),
      enabled: true,
      budget: 0,
    }
  }
  if (entry.thinkingMode === 'budget') {
    const level = effort !== undefined && effort !== 'none' ? effort : 'medium'
    return { enabled: true, budget: THINKING_BUDGETS[level] ?? 8192, thinking: { type: 'enabled', ...binding } }
  }
  return { enabled: false, budget: 0 }
}

function cacheMarker(settings: ClaudeApiSettings): Block {
  return settings.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

const CACHE_MARKABLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image', 'tool_result'])

/**
 * Cache breakpoints on the FINISHED body: the identity block, the system-prompt block,
 * the last block of the last user turn, and the last non-deferred tool - at most four.
 * '5m' writes { type: 'ephemeral' } with NO ttl field; deferred tools and clear_at
 * messages never carry a marker.
 */
function markCacheBreakpoints(body: Record<string, unknown>, settings: ClaudeApiSettings): void {
  const marker = cacheMarker(settings)
  const system = body.system
  if (Array.isArray(system)) {
    for (const block of system.slice(2)) {
      if (isRecord(block)) {
        const scope = isRecord(block.cache_control) && block.cache_control.scope === 'global' ? 'global' : undefined
        block.cache_control = { ...marker, ...(scope === undefined ? {} : { scope }) }
      }
    }
  }
  const messages = body.messages
  if (Array.isArray(messages)) {
    // The last USER-role entry keeps the history breakpoint even when a turn-scoped or
    // in-place system message ends the list; a clear_at message is never marked.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (!isRecord(entry) || entry.role !== 'user') continue
      if (entry.clear_at === undefined && Array.isArray(entry.content)) {
        const block = entry.content[entry.content.length - 1]
        if (isRecord(block) && CACHE_MARKABLE_BLOCK_TYPES.has(String(block.type))) block.cache_control = { ...marker }
      }
      break
    }
  }
  const tools = body.tools
  if (Array.isArray(tools)) {
    const last = [...tools].reverse().find(tool => isRecord(tool) && tool.defer_loading !== true)
    if (isRecord(last)) last.cache_control = { ...marker }
  }
}

/** How many cache_control markers one built body carries (walks the bytes, not the marking calls). */
export function countClaudeApiCacheBreakpoints(body: unknown): number {
  let count = 0
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return }
    if (!isRecord(value)) return
    if (value.cache_control !== undefined) count += 1
    for (const entry of Object.values(value)) visit(entry)
  }
  visit(body)
  return count
}

/**
 * Build one main-turn Messages request body. Pure: no clock, no randomness, no I/O.
 * The leading compact-checkpoint message is replaced by the stored compaction block
 * when the context's lookup finds it; otherwise it keeps its text form.
 */
export function buildClaudeApiRequest(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  context: ClaudeApiRequestContext,
): Record<string, unknown> {
  const entry = context.entry
  const settings = context.settings
  const firstUserText = claudeApiFirstUserText(options)

  // Decide the head replacement FIRST. On the wire the checkpoint becomes an ASSISTANT
  // message holding the compaction block, so every placement rule (in-place system,
  // turn-scoped, tool-change slot) is judged against that wire role, not the checkpoint's
  // user role: a system message directly after the block is not in a legal slot.
  // Leading system messages always fold (no predecessor), so the first non-system message
  // is the first wire entry.
  const headIndex = options.messages.findIndex(message => message.role !== 'system')
  const headMessage = headIndex >= 0 ? options.messages[headIndex] : undefined
  let headStored: { content: string; signature: string; toolChanges?: unknown } | undefined
  if (headMessage !== undefined && headMessage.source?.kind === 'compact-checkpoint' && context.compactionBlocks !== undefined) {
    const summary = extractCheckpointSummary(textOf(headMessage.content))
    headStored = summary === null ? undefined : context.compactionBlocks.lookup(summary)
  }
  const placementMessages: Message[] = headStored !== undefined
    ? options.messages.map((message, index): Message => index === headIndex ? { role: 'assistant', content: [] } : message)
    : options.messages
  const inPlace = systemMessagesInPlace(placementMessages, entry)
  const foldedSystemTexts: string[] = []
  options.messages.forEach((message, index) => {
    if (message.role !== 'system' || inPlace.has(index)) return
    const text = textOf(message.content)
    if (text !== '') foldedSystemTexts.push(text)
  })
  const wire = placementMessages.filter((message, index) => message.role !== 'system' || inPlace.has(index))
  const turnScoped = turnScopedIndices(wire, entry)

  const entries: WireEntry[] = []
  for (let index = 0; index < wire.length; index += 1) {
    const message = wire[index] as Message
    if (index === 0 && headStored !== undefined) {
      entries.push({
        role: 'assistant',
        content: [{
          type: 'compaction',
          content: headStored.content,
          signature: headStored.signature,
          ...(headStored.toolChanges !== undefined ? { tool_changes: headStored.toolChanges } : {}),
        }],
      })
      continue
    }
    if (message.role === 'system') {
      entries.push({ role: 'system', content: systemContent(message, images, entry) })
      continue
    }
    if (message.role === 'developer' && statesToolChange(message)) {
      if (legalSystemSlot(wire, index)) {
        entries.push({ role: 'system', content: systemContent(message, images, entry) })
      } else {
        const note = toolChangeNote(message)
        if (note !== '') entries.push({ role: 'user', content: [{ type: 'text', text: note }] })
      }
      continue
    }
    if (turnScoped.has(index)) {
      const content: Block[] = []
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = sanitizeText(block.text)
          if (text !== '') content.push({ type: 'text', text })
        }
      }
      entries.push({ role: 'system', content, clear_at: 'next_user_message' })
      continue
    }
    if (message.role === 'assistant') {
      entries.push({ role: 'assistant', content: assistantContent(message) })
      continue
    }
    entries.push({ role: 'user', content: userContent(message, images, entry) })
  }

  const systemText = foldedSystemTexts.join('\n\n')
  const system = buildClaudeCodeSystemBlocks({
    version: context.version,
    entrypoint: CLAUDE_API_ENTRYPOINT,
    firstUserText,
    context: context.firstParty,
    identityText: CLAUDE_API_IDENTITY_TEXT,
    ...(typeof options.system === 'string' && options.system.trim() !== '' ? { staticText: options.system } : {}),
    ...(systemText === '' ? {} : { dynamicText: systemText }),
    cacheTtl: settings.cacheTtl,
  })

  const fields = thinkingFields(options, settings, entry)
  const baseMax = options.maxTokens ?? Math.min(entry.maxOutputTokens, 16_384)
  let maxTokens = Math.min(entry.maxOutputTokens, Math.max(1, baseMax))
  let thinking = fields.thinking
  if (entry.thinkingMode === 'budget' && fields.enabled && fields.budget > 0) {
    // The budget form spends part of the response ceiling: inflate the cap to fit the
    // budget plus answer room, then clamp the budget so an answer always fits.
    maxTokens = Math.max(1024, Math.min(entry.maxOutputTokens, Math.max(baseMax, fields.budget + 4096)))
    const budget = Math.min(fields.budget, maxTokens - 1024)
    thinking = budget >= 1024 ? { type: 'enabled', budget_tokens: budget } : undefined
  }
  const thinkingEnabled = thinking !== undefined && thinking.type !== 'disabled'
  const tools = wireTools(options)

  const messages = cleanOrphanedToolCalls(mergeEntries(entries), mergeEntries)
  if (messages[messages.length - 1]?.role === 'assistant') {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] })
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    system,
    ...(tools.length > 0 ? { tools } : {}),
    metadata: { user_id: claudeApiMetadataUserId(context.deviceId, context.sessionUuid) },
    max_tokens: maxTokens,
    ...(thinking === undefined ? {} : { thinking }),
    ...(thinkingEnabled && entry.contextEditing ? { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } } : {}),
    ...(fields.outputConfig === undefined ? {} : { output_config: fields.outputConfig }),
    ...(settings.fastMode && entry.fastMode !== null ? { speed: 'fast' } : {}),
    ...(entry.supportsTemperature && !thinkingEnabled && options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: [...options.stop] } : {}),
    diagnostics: { previous_message_id: null },
    stream: true,
  }
  markCacheBreakpoints(body, settings)
  return body
}

/**
 * The anthropic-beta list derived from the FINAL BODY (never from settings): the base
 * set first, then the conditional betas in the spec table's order. A gateway silently
 * strips unlicensed fields, so the header must follow the bytes.
 */
export function deriveClaudeApiBetas(
  body: Record<string, unknown>,
  entry: ClaudeApiModelEntry,
  thinkingTokenCount = true,
): string[] {
  const betas = claudeCodeFirstPartyBetas({
    auth: 'api-key',
    model: typeof body.model === 'string' ? body.model : entry.id,
    thinkingTokenCount,
  })
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
  const contentBlocks = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(isRecord) : [])
  const hasCompactionBlock = contentBlocks.some(block => block.type === 'compaction')
  const hasTopCompaction = body.compaction !== undefined
  const hasToolChangeBlocks = contentBlocks.some(block => block.type === 'tool_addition' || block.type === 'tool_removal')
  const hasInlineToolDefinition = contentBlocks.some(block => block.type === 'tool_addition' && isRecord(block.tool) && block.tool.type === 'tool_definition')
  if (isRecord(body.thinking) && body.thinking.block_binding !== undefined) betas.push(CLAUDE_API_BETA_THINKING_BINDING)
  if (hasTopCompaction || hasCompactionBlock) betas.push(CLAUDE_API_BETA_COMPACT)
  if (hasInlineToolDefinition || (hasTopCompaction && hasToolChangeBlocks)) betas.push(CLAUDE_API_BETA_INLINE_TOOLS)
  if (messages.some(message => message.clear_at !== undefined)) betas.push(CLAUDE_API_BETA_CLEAR_AT)
  if (body.speed !== undefined && entry.fastMode === 'beta') betas.push(CLAUDE_API_BETA_FAST_MODE)
  return mergeClaudeCodeBetas(betas)
}
