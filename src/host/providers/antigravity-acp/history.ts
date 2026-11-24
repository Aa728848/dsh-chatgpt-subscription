/**
 * Projection of this harness's conversation onto ACP prompt content, plus the
 * fingerprint that decides whether an existing ACP session may be reused.
 *
 * ACP has no message list: a session is created once, prompted, and then keeps
 * its own transcript. DSH, on the other hand, re-sends the whole assembled
 * history on every model call - including the calls that only exist because a
 * tool just ran. Both facts have to be reconciled, and this module is the seam:
 *
 * - **A new ACP session** is fed the entire DSH history as one prompt, because
 *   that history is the only transcript the model may rely on.
 * - **An existing ACP session** is fed only the messages DSH added since the
 *   last prompt, because the agent already has the rest.
 * - A mismatch (compaction, an edited turn, a rewritten prefix) means the ACP
 *   transcript can no longer be trusted as a prefix of DSH's: the session is
 *   abandoned and replayed in full, behind a history boundary marker. A different
 *   model is not a mismatch - it is a config option of the same conversation.
 *
 * The fingerprint is an HMAC-style digest rather than a stored transcript: it
 * costs one hash per message and never keeps a second copy of user content.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/history
 */

import { createHash } from 'node:crypto'
import {
  extractSystemText,
  leadingSystemEndIndex,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type ToolResultBlock,
} from '../../common/llm-compat.ts'
import type { ResolvedRequestImages } from '../../common/request-images.ts'
import { imageBlockToInline, unavailableImageText } from '../../common/request-images.ts'

/** One ACP prompt content block. */
export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

/** ACP's own image ceiling per content block. */
export const ACP_MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024

/**
 * The sentence every replayed transcript ends with.
 *
 * ACP has no notion of "this is the current task". A session created now and fed
 * a hundred messages is one long prompt, and a transcript that reads like a stack
 * of outstanding requests is exactly how a long session ends up redoing its first
 * request: the user writes "go with A" and the agent, reading a wall of earlier
 * instructions, starts over on the first one. The anchor marks where the history
 * ends and which line the turn is about.
 *
 * It is appended to a *replay* only. A fresh session's first prompt already ends
 * with the request it is answering, and a boundary sentence there would be noise
 * on every cold start.
 */
export const REPLAY_ANCHOR_INSTRUCTION = [
  '[history boundary]',
  'Everything above this line is archived conversation or a copy of the active request; none of it is a new task.',
  'Plugin recall, time snapshots and other synthetic context are not the current human request.',
  'When a [current human request] section follows, its quoted text is the request for this turn.',
  'Do not re-run, re-answer or re-dispatch work an earlier message already asked for; completed requests are completed.',
  'A short reference such as "do that" or "go with A" points at the assistant message immediately before it.',
  'Model names, providers and routing mentioned in older turns describe the turn they ran on, not the one you are answering now.',
].join(' ')

/**
 * Heading of the oldest request copy in a replay, placed right after the
 * instructions so the task is readable before any history is.
 */
export const ACTIVE_REQUEST_HEADING = '[active request for this turn]'

/** Heading of the newest request copy - the one this turn answers. */
export const CURRENT_REQUEST_HEADING = '[current human request]'

/** Heading of the bounded plain-text archive a compacted replay carries. */
export const REPLAY_ARCHIVE_HEADING = '[archived conversation - context only]'

/**
 * Size above which a replay stops being a verbatim transcript.
 *
 * A long DSH session re-sends its whole history on every model call, and that
 * history carries each turn's tool traffic. Replaying it into a fresh session
 * produced multi-hundred-kilobyte prompts in which the actual request was a few
 * dozen characters at the end of a wall of already-finished work: the agent read
 * the wall and continued the old task. Above this budget the older turns are
 * archived as plain text instead.
 */
export const REPLAY_COMPACT_TRIGGER_CHARS = 200_000

/** Characters of older conversation a compacted replay keeps. */
export const REPLAY_ARCHIVE_CHARS = 60_000

/** Per-message ceiling inside that archive. */
export const REPLAY_MESSAGE_CHARS = 12_000

/** Ceiling for one copy of the request the replay answers. */
export const REPLAY_REQUEST_CHARS = 30_000

/** Content handed to `session/prompt` for one generation. */
export interface AcpPrompt {
  blocks: AcpPromptBlock[]
  /** Number of DSH messages this prompt covers, counted from the start of the history. */
  coveredMessages: number
  /** Digest over the covered messages, used to recognise a matching prefix later. */
  fingerprint: string
}

/**
 * Build the prompt for one generation.
 *
 * @param options - Normalized request options.
 * @param images - Images resolved for this request, keyed by attachment id.
 * @param fromMessage - Index of the first DSH message this prompt must carry; 0 replays everything.
 * @returns The blocks to send, plus what they cover.
 */
export function buildPrompt(
  options: GenerateOptions,
  images: ResolvedRequestImages,
  fromMessage: number,
): AcpPrompt {
  const messages = options.messages
  const start = Math.max(0, Math.min(fromMessage, messages.length))
  // A replay carries earlier assistant turns, so it is a transcript the agent has
  // to pick one request out of. An increment is just the newest turn on a live
  // session and needs no framing at all.
  const replayed = start === 0 && messages.some((message) => message.role === 'assistant')
  const blocks = replayed
    ? replayBlocks(messages, images)
    : renderMessages(messages, messageRange(messages.length, start), images)
  return {
    blocks,
    coveredMessages: messages.length,
    fingerprint: fingerprintMessages(messages, 0, messages.length),
  }
}

/**
 * Digest over a message range.
 *
 * Only the parts the model can see take part: role, block type and payload. Ids
 * and sources are deliberately excluded, because DSH re-stamps them between
 * generations and a fingerprint that changed on every turn would force a cold
 * replay every time.
 *
 * @param messages - Normalized history.
 * @param from - First index covered.
 * @param to - One past the last index covered.
 * @returns Hex digest.
 */
export function fingerprintMessages(messages: readonly Message[], from: number, to: number): string {
  const hash = createHash('sha256')
  for (let index = from; index < to; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    hash.update(message.role)
    hash.update('\u0000')
    for (const block of message.content) hash.update(canonicalBlock(block))
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/**
 * Digest over the tool catalogue an ACP session's bridge exposes.
 *
 * The catalogue is fixed when the session is created: the agent listed it once,
 * and the bridge answers `listChanged: false`, so a session resumed after the
 * harness's tool set changed would keep offering the old schemas to the agent. The
 * digest is therefore part of "may this session be reused", and a changed
 * catalogue forces a fresh session.
 *
 * @param tools - The tool schemas of one request.
 * @returns Hex digest; one catalogue always produces one value.
 */
export function fingerprintTools(tools: GenerateOptions['tools']): string {
  const hash = createHash('sha256')
  const entries = (tools ?? [])
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: JSON.stringify(tool.parameters ?? {}),
    }))
    .sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
  for (const entry of entries) {
    hash.update(entry.name)
    hash.update('\u0000')
    hash.update(entry.description)
    hash.update('\u0000')
    hash.update(entry.parameters)
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/**
 * Whether `messages` still begins with everything a live ACP session has seen.
 *
 * @param messages - The history about to be sent.
 * @param covered - How many messages the session was last told about.
 * @param fingerprint - Digest that covered range produced at the time.
 * @returns whether the prefix is unchanged and at least one new message follows.
 */
export function canContinue(
  messages: readonly Message[],
  covered: number,
  fingerprint: string,
): boolean {
  if (covered <= 0 || covered >= messages.length) return false
  return fingerprintMessages(messages, 0, covered) === fingerprint
}

/* ------------------------------------------------------------------------- *
 * Replay framing
 *
 * A replay is the one prompt in this line that is not obviously a task: it is a
 * whole conversation handed to an agent that has never seen it, and two things
 * go wrong with it.
 *
 * 1. The harness appends synthetic `user` messages after the human turn it is
 *    answering - plugin recall, time snapshots, progress reminders. An anchor
 *    that says "the current request is the LAST user message" therefore points at
 *    a synthetic message, and the agent answers that instead of the human.
 * 2. The history keeps the full instructions of every earlier turn plus every
 *    tool call and its result. Verbatim, one reproported 183-message session was
 *    11 instruction copies and ~1.45 M characters, in which the newest request
 *    was a few dozen characters at the end of a wall of finished work.
 *
 * So a replay quotes the request verbatim instead of describing it, quotes it
 * twice (after the instructions and after the history boundary), keeps one copy
 * of each instruction role, and above a size budget replaces the older tool
 * traffic with a bounded plain-text archive.
 * ------------------------------------------------------------------------- */

/** Whether a system message carries DSH 0.2.3+ section attribution (incremental deltas). */
function hasSectionedSystemSource(message: Message | undefined): boolean {
  return message?.role === 'system'
    && message.source?.kind === 'system-prompt'
    && Array.isArray(message.source.sections)
}

/** Indices of the messages a replay carries, with superseded legacy snapshots dropped. */
function keptIndices(messages: readonly Message[]): number[] {
  const leadingEnd = leadingSystemEndIndex(messages)
  let newestDeveloper = -1
  let hasSectionedSystem = false
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'developer') newestDeveloper = index
    if (hasSectionedSystemSource(message)) hasSectionedSystem = true
  }
  // Legacy DSH (<=0.2.2) stacked full system snapshots at the head without
  // section attribution; keep only the newest leading snapshot there while
  // preserving every mid-conversation incremental system delta (DSH 0.2.3+).
  const newestLeadingSystem = leadingEnd - 1
  const kept: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const role = messages[index]?.role
    if (role === 'system' && !hasSectionedSystem && index < leadingEnd && index !== newestLeadingSystem) continue
    if (role === 'developer' && index !== newestDeveloper) continue
    kept.push(index)
  }
  return kept
}

/** Ascending indices of one message range. */
function messageRange(length: number, from: number): number[] {
  const indices: number[] = []
  for (let index = from; index < length; index += 1) indices.push(index)
  return indices
}

/** Render the given messages as prompt blocks, sharing one inline-image budget. */
function renderMessages(
  messages: readonly Message[],
  indices: readonly number[],
  images: ResolvedRequestImages,
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  let inlineBytes = 0
  const admitImage = (bytes: number): boolean => {
    inlineBytes += bytes
    return inlineBytes <= ACP_MAX_INLINE_IMAGE_BYTES
  }
  for (const index of indices) {
    const message = messages[index]
    if (message === undefined) continue
    appendMessage(blocks, message, images, admitImage)
  }
  return blocks
}

/**
 * Whether this `user` message was injected by something other than a human.
 *
 * A message without a source kind is treated as human: older harness generations
 * do not stamp one, and mistaking the real request for synthetic context is worse
 * than the reverse.
 */
function isSyntheticUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false
  const kind = message.source?.kind
  return typeof kind === 'string' && kind !== 'user'
}

/** Index of the newest message a human actually wrote. */
function lastHumanRequestIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'user') continue
    if (isSyntheticUserMessage(message)) continue
    return index
  }
  return undefined
}

/** The text one message contributes to a request quote or to the archive. */
function plainTextOf(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.trim() !== '') parts.push(block.text)
      continue
    }
    if (block.type === 'file') {
      const name = (block.attachment as { name?: string }).name ?? 'attachment'
      parts.push(`[file attached: ${name}]`)
    }
  }
  return parts.join('\n').trim()
}

/** Rough rendered size of a message set; only used to pick the replay shape. */
function estimateReplayChars(messages: readonly Message[], indices: readonly number[]): number {
  let total = 0
  for (const index of indices) {
    const message = messages[index]
    if (message === undefined) continue
    for (const block of message.content) {
      if (block.type === 'text') total += block.text.length
      else if (block.type === 'tool-call') total += block.name.length + Math.min(block.arguments.length, 4096) + 16
      else if (block.type === 'tool-result') {
        const body = (block as ToolResultBlock).content.map(renderResultBlock).join('\n')
        total += Math.min(body.length, 8192) + 24
      } else if (block.type === 'image') total += 256
      else if (block.type === 'file') total += 64
    }
    total += 8
  }
  return total
}

/** One headed copy of the request, or nothing when the request has no text. */
function requestBlock(heading: string, text: string): AcpPromptBlock | undefined {
  return text === '' ? undefined : { type: 'text', text: `${heading}\n${text}` }
}

/** Whether a message belongs in the compacted archive. */
function isArchivable(message: Message | undefined): boolean {
  if (message === undefined) return false
  if (message.role !== 'user' && message.role !== 'assistant') return false
  if (isSyntheticUserMessage(message)) return false
  return plainTextOf(message) !== ''
}

/**
 * Plain-text archive entries, newest first until the budget is spent.
 *
 * Tool calls, tool results, reasoning and images stay out: they are what made the
 * replay unreadable, and an agent that needs their detail can read the workspace.
 */
function boundedArchive(messages: readonly Message[], indices: readonly number[]): { entries: string[]; omitted: number } {
  const entries: string[] = []
  let budget = REPLAY_ARCHIVE_CHARS
  let omitted = 0
  for (let position = indices.length - 1; position >= 0; position -= 1) {
    const message = messages[indices[position] ?? -1]
    if (message === undefined) continue
    const text = truncate(plainTextOf(message), REPLAY_MESSAGE_CHARS)
    if (text.length > budget) {
      omitted += 1
      continue
    }
    budget -= text.length
    entries.push(`[${message.role}]\n${text}`)
  }
  return { entries: entries.reverse(), omitted }
}

/** The request's own images and files, which the archive does not carry. */
function requestAttachments(message: Message, images: ResolvedRequestImages): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  let inlineBytes = 0
  const admitImage = (bytes: number): boolean => {
    inlineBytes += bytes
    return inlineBytes <= ACP_MAX_INLINE_IMAGE_BYTES
  }
  for (const block of message.content) {
    if (block.type !== 'image' && block.type !== 'file') continue
    const rendered = renderBlock(block, images, admitImage)
    if (rendered === undefined) continue
    blocks.push(typeof rendered === 'string' ? { type: 'text', text: rendered } : rendered)
  }
  return blocks
}

/** Blocks for a replay of the whole history. */
function replayBlocks(messages: readonly Message[], images: ResolvedRequestImages): AcpPromptBlock[] {
  const kept = keptIndices(messages)
  const requestIndex = lastHumanRequestIndex(messages)
  const requestMessage = requestIndex === undefined ? undefined : messages[requestIndex]
  const request = requestMessage === undefined ? '' : truncate(plainTextOf(requestMessage), REPLAY_REQUEST_CHARS)
  if (estimateReplayChars(messages, kept) <= REPLAY_COMPACT_TRIGGER_CHARS) {
    const blocks = renderMessages(messages, kept, images)
    blocks.push({ type: 'text', text: REPLAY_ANCHOR_INSTRUCTION })
    const current = requestBlock(CURRENT_REQUEST_HEADING, request)
    if (current !== undefined) blocks.push(current)
    return blocks
  }
  return compactReplayBlocks(messages, kept, requestIndex, requestMessage, request, images)
}

/** Blocks for a replay too large to send verbatim. */
function compactReplayBlocks(
  messages: readonly Message[],
  kept: readonly number[],
  requestIndex: number | undefined,
  requestMessage: Message | undefined,
  request: string,
  images: ResolvedRequestImages,
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = []
  const instructions = kept.filter((index) => {
    const role = messages[index]?.role
    return role === 'system' || role === 'developer'
  })
  blocks.push(...renderMessages(messages, instructions, images))
  const active = requestBlock(ACTIVE_REQUEST_HEADING, request)
  if (active !== undefined) blocks.push(active)

  const history = kept.filter((index) => (requestIndex === undefined || index < requestIndex) && isArchivable(messages[index]))
  const archive = boundedArchive(messages, history)
  blocks.push({
    type: 'text',
    text: [
      REPLAY_ARCHIVE_HEADING,
      `${archive.entries.length} earlier messages kept, ${archive.omitted} dropped for length.`,
      'Earlier tool calls, tool results, images and synthetic context are not replayed; re-read the workspace if an older turn needs their detail.',
    ].join('\n'),
  })
  for (const entry of archive.entries) blocks.push({ type: 'text', text: entry })

  blocks.push({ type: 'text', text: REPLAY_ANCHOR_INSTRUCTION })
  const current = requestBlock(CURRENT_REQUEST_HEADING, request)
  if (current !== undefined) blocks.push(current)
  if (requestMessage !== undefined) blocks.push(...requestAttachments(requestMessage, images))
  return blocks
}

/** Render one message into prompt blocks. */
function appendMessage(
  blocks: AcpPromptBlock[],
  message: Message,
  images: ResolvedRequestImages,
  admitImage: (bytes: number) => boolean,
): void {
  const textParts: string[] = []
  const trailing: AcpPromptBlock[] = []
  for (const block of message.content) {
    const rendered = renderBlock(block, images, admitImage)
    if (rendered === undefined) continue
    if (typeof rendered === 'string') textParts.push(rendered)
    else trailing.push(rendered)
  }
  const text = message.role === 'system'
    ? extractSystemText(message.content)
    : textParts.join('\n').trim()
  if (text !== '') blocks.push({ type: 'text', text: decorate(message, text) })
  blocks.push(...trailing)
}

/**
 * Render one block.
 *
 * @returns text for anything textual, an image block for an admitted image, or
 * undefined for a block the prompt must not carry.
 */
function renderBlock(
  block: ContentBlock,
  images: ResolvedRequestImages,
  admitImage: (bytes: number) => boolean,
): string | AcpPromptBlock | undefined {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      // Reasoning stays out of the prompt: the agent produces its own, and
      // replaying another model's trace into this one is content invention.
      return undefined
    case 'image': {
      const inline = imageBlockToInline(block as unknown as Record<string, unknown>, images)
      if (inline === undefined) return unavailableImageText(block as unknown as Record<string, unknown>)
      const bytes = Math.ceil(inline.data.length * 0.75)
      if (!admitImage(bytes)) {
        return '[image omitted: this turn already carries the maximum inline image payload the agent accepts]'
      }
      return { type: 'image', mimeType: inline.mediaType, data: inline.data }
    }
    case 'file': {
      const name = (block.attachment as { name?: string }).name ?? 'attachment'
      return `[file attached: ${name}]`
    }
    case 'tool-call':
      return `[tool call] ${block.name}(${truncate(block.arguments, 4096)})`
    case 'tool-result': {
      const result = block as ToolResultBlock
      const body = result.content.map(renderResultBlock).join('\n')
      return `[tool result${result.isError === true ? ' (error)' : ''}] ${truncate(body, 8192)}`
    }
    case 'tool-addition':
    case 'tool-removal':
      return undefined
    default:
      return undefined
  }
}

function renderResultBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'image') return '[image]'
  if (block.type === 'file') return '[file]'
  return ''
}

/** Prefix a message with the role marker the agent needs to tell turns apart. */
function decorate(message: Message, text: string): string {
  if (message.role === 'system') return `[system]\n${text}`
  if (message.role === 'developer') return `[developer]\n${text}`
  if (message.role === 'assistant') return `[assistant]\n${text}`
  return text
}

/** Durable id of the attachment behind one block, or an empty string. */
function attachmentIdOf(block: ContentBlock): string {
  const attachment = (block as { attachment?: { attachmentId?: unknown } }).attachment
  return typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : ''
}

/** Canonical text for one block, used only for the fingerprint. */
function canonicalBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `text:${block.text}`
    case 'reasoning':
      return `reasoning:${block.text}`
    case 'tool-call':
      return `call:${block.name}:${block.arguments}`
    case 'tool-result':
      return `result:${(block as ToolResultBlock).toolCallId}:${(block as ToolResultBlock).isError === true ? '1' : '0'}`
    case 'image':
      // An inline image may arrive without an attachment reference; a digest that
      // threw on one would fail the whole prompt build for a message it can still
      // send.
      return `image:${attachmentIdOf(block)}`
    case 'file':
      return `file:${attachmentIdOf(block)}`
    default:
      return block.type
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
