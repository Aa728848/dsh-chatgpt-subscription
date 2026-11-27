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
 *
 * Only prose is cut. Every structural block — above all a `tool-call` — survives, because
 * a call that disappears here orphans the result that follows it, and a provider that
 * validates the pairing rejects the whole request rather than the excerpt ("tool_call_id
 * … is not found"). A call's argument is therefore never shortened either: half a JSON
 * body is not an excerpt the advisor can act on.
 */
function trimToBudget(message: Message, characters: number): Message {
  const structural = message.content.filter((block) => block.type !== 'text' && block.type !== 'reasoning')
  const prose = message.content
    .filter((block) => block.type === 'text' || block.type === 'reasoning')
    .map(blockText).join('\n')
  if (prose.length <= characters) return message
  const head = prose.slice(0, Math.min(TRIM_HEAD_CHARS, Math.floor(characters * 0.6)))
  const tail = prose.slice(prose.length - Math.min(TRIM_TAIL_CHARS, Math.floor(characters * 0.3)))
  const dropped = prose.length - head.length - tail.length
  const excerpt = `${head}\n…[${dropped} characters of this ${message.role} message were omitted to fit the advisor context window]…\n${tail}`
  const content: ContentBlock[] = [{ type: 'text', text: excerpt }, ...structural]
  return { ...message, content } as Message
}

/**
 * Preserve the original task and recent evidence while fitting a separate Advisor budget.
 *
 * Two invariants outrank the budget: calls and results travel as pairs — a `tool-call` is
 * never sent without a matching `tool` result, and a result is never sent whose call this
 * projection dropped (some providers reject either shape, and the ones that accept it show
 * the advisor a self-contradicting history) — and the newest evidence survives even when
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
  // The selection above already keeps the whole set inside the budget, so nothing is cut
  // here except a message larger than the entire budget. Excerpting everything above an
  // equal share spent half the budget to throw away evidence the advisor could have read.
  const budgetCharacters = Math.max(600, Math.floor(budget * 4))
  let messages = repaired.messages.map((message) => trimToBudget(message, budgetCharacters))
  // The original task and the newest message are kept whatever they cost, so that pair is
  // the only thing that can push the set past the budget: every other message was admitted
  // by the selection loop against it. Only then does the whole set fall back to an equal
  // share, which is the one case where it genuinely does not fit.
  if (estimate(first) + (latest === first ? 0 : estimate(latest)) > budget) {
    const share = Math.max(600, Math.floor(budgetCharacters / Math.max(1, messages.length)))
    messages = messages.map((message) => trimToBudget(message, share))
  }
  // Trimming is the only pass that rewrites a body, so the pairing invariant is re-checked
  // after it rather than trusted.
  const trimmed = repairToolPairs(messages)
  return {
    messages: trimmed.messages,
    sourceSystem,
    // Counted against the selection, not the final list: the placeholder results added for
    // unanswered calls are not messages this projection failed to fit.
    omittedMessages: projected.length - kept.length,
    orphanedToolCalls: repaired.orphaned + trimmed.orphaned,
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
