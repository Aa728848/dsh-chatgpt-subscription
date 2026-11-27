import { createToolResultMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm'

export interface AdvisorTranscriptProjection {
  messages: Message[]
  sourceSystem: string
  omittedMessages: number
  /** Tool calls whose real result fell outside the budget and got a placeholder instead. */
  orphanedToolCalls: number
}

/** Head/tail excerpt sizes for one message that alone is larger than the budget. */
const TRIM_HEAD_CHARS = 4_000
const TRIM_TAIL_CHARS = 2_000

function blockText(block: ContentBlock): string {
  if (block.type === 'text' || block.type === 'reasoning') return block.text
  if (block.type === 'tool-call') return `[tool call ${block.name}] ${block.arguments}`
  if (block.type === 'image') return '[image]'
  if (block.type === 'file') return '[file]'
  return ''
}

function textOf(message: Message): string {
  return message.content.map(blockText).join('\n')
}

function estimate(message: Message): number {
  return Math.max(8, Math.ceil(textOf(message).length / 4) + message.content.reduce((sum, block) => sum + (block.type === 'image' ? 1024 : 0), 0))
}

function withoutImages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block): ContentBlock => block.type === 'image'
      ? { type: 'text', text: '[An image appears here; the selected advisor accepts text only.]' }
      : block),
  })) as Message[]
}

/**
 * Collapse a message that alone exceeds the budget into a head/tail excerpt. Without
 * this an oversized tool output either evicts every recent message or arrives as an
 * unexplained truncation, and the advisor reviews evidence it cannot see the end of.
 */
function trimToBudget(message: Message, characters: number): Message {
  const text = textOf(message)
  if (text.length <= characters) return message
  const head = text.slice(0, Math.min(TRIM_HEAD_CHARS, Math.floor(characters * 0.6)))
  const tail = text.slice(text.length - Math.min(TRIM_TAIL_CHARS, Math.floor(characters * 0.3)))
  const dropped = text.length - head.length - tail.length
  const excerpt = `${head}\n…[${dropped} characters of this ${message.role} message were omitted to fit the advisor context window]…\n${tail}`
  return { ...message, content: [{ type: 'text', text: excerpt }] } as Message
}

/**
 * Preserve the original task and recent evidence while fitting a separate Advisor budget.
 *
 * Two invariants outrank the budget: a `tool-call` is never sent without a matching
 * `tool` result (some providers reject such a request, and the ones that accept it show
 * the advisor a self-contradicting history), and the newest evidence survives even when
 * that message alone is larger than the whole budget.
 */
export function projectAdvisorTranscript(
  input: readonly Message[],
  options: { contextTokenBudget: number; maxTokens: number; includeImages: boolean },
): AdvisorTranscriptProjection {
  const sourceSystem = input.filter((message) => message.role === 'system').map(textOf).filter(Boolean).join('\n\n')
  const candidates = input.filter((message) => message.role !== 'system')
  const projected = options.includeImages ? [...candidates] : withoutImages(candidates)
  const firstTaskIndex = projected.findIndex((message) => message.role === 'user' && textOf(message).trim() !== '')
  if (firstTaskIndex < 0) return { messages: projected, sourceSystem, omittedMessages: 0, orphanedToolCalls: 0 }
  const budget = Math.max(1_000, options.contextTokenBudget - options.maxTokens - Math.ceil(sourceSystem.length / 4))
  const first = projected[firstTaskIndex]!
  const latest = projected[projected.length - 1]!
  const selected = new Set<Message>([first, latest])
  let spent = estimate(first) + (latest === first ? 0 : estimate(latest))
  for (let index = projected.length - 2; index > firstTaskIndex; index--) {
    const message = projected[index]!
    const cost = estimate(message)
    if (spent + cost > budget) continue
    selected.add(message)
    spent += cost
  }
  const kept = projected.filter((message) => selected.has(message))
  const repaired = repairToolPairs(kept)
  // Only messages that already fit get trimmed: an oversized survivor is treated as
  // the unit of newest evidence and is never cut down to nothing.
  const perMessage = Math.max(600, Math.floor((budget * 4) / Math.max(1, repaired.messages.length)))
  const messages = repaired.messages.map((message) => trimToBudget(message, perMessage))
  return {
    messages,
    sourceSystem,
    omittedMessages: projected.length - messages.length,
    orphanedToolCalls: repaired.orphaned,
  }
}

/**
 * Drop tool results whose call is gone, and answer every call whose result is gone
 * with an explicit placeholder result. One forward pass, so cost stays linear.
 */
function repairToolPairs(messages: readonly Message[]): { messages: Message[]; orphaned: number } {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool-call') callIds.add(block.id)
    if (message.role === 'tool') resultIds.add(String(message.toolCallId))
  }
  const out: Message[] = []
  let orphaned = 0
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'tool') {
      if (callIds.has(String(message.toolCallId))) out.push(message)
      continue
    }
    out.push(message)
    const calls = message.content.filter((block) => block.type === 'tool-call')
    if (calls.length === 0) continue
    // Placeholders go right after the call; the main loop emits any real results
    // that survived the budget on its next iterations.
    for (const block of calls) {
      if (block.type !== 'tool-call' || resultIds.has(block.id)) continue
      orphaned += 1
      out.push(createToolResultMessage({
        callId: block.id as never,
        content: [{ type: 'text', text: '[This tool result fell outside the advisor context window and is unavailable.]' }],
        isError: true,
      }))
    }
  }
  return { messages: out, orphaned }
}
