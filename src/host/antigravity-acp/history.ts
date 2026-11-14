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
import type { ContentBlock, GenerateOptions, Message, ToolResultBlock } from '../common/llm-compat.ts'
import type { ResolvedRequestImages } from '../common/request-images.ts'
import { imageBlockToInline, unavailableImageText } from '../common/request-images.ts'

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
  'Everything above this line is earlier conversation, replayed to you for context only.',
  'The current request is the LAST user message in that history.',
  'Do not re-run, re-answer or re-dispatch work an earlier message already asked for; completed requests are completed.',
  'A short reference such as "do that" or "go with A" points at the assistant message immediately before it.',
  'Model names, providers and routing mentioned in older turns describe the turn they ran on, not the one you are answering now.',
].join(' ')

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
  const blocks: AcpPromptBlock[] = []
  let inlineBytes = 0
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    appendMessage(blocks, message, images, (bytes) => {
      inlineBytes += bytes
      return inlineBytes <= ACP_MAX_INLINE_IMAGE_BYTES
    })
  }
  // A replay that carries earlier assistant turns is a transcript, not a task
  // list; the boundary sentence keeps the newest request from being read as one
  // more item in a queue.
  if (start === 0 && messages.some((message) => message.role === 'assistant')) {
    blocks.push({ type: 'text', text: REPLAY_ANCHOR_INSTRUCTION })
  }
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
  const text = textParts.join('\n').trim()
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
      return `image:${(block.attachment as { attachmentId?: string }).attachmentId ?? ''}`
    case 'file':
      return `file:${(block.attachment as { attachmentId?: string }).attachmentId ?? ''}`
    default:
      return block.type
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
