import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

export interface AdvisorTranscriptProjection {
  messages: Message[]
  sourceSystem: string
  omittedMessages: number
}

function textOf(message: Message): string {
  return message.content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'tool-call') return `${block.name} ${block.arguments}`
    if (block.type === 'image') return '[image]'
    if (block.type === 'file') return '[file]'
    return ''
  }).join('\n')
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

/** Preserve the original task and recent evidence while fitting a separate Advisor budget. */
export function projectAdvisorTranscript(
  input: readonly Message[],
  options: { contextTokenBudget: number; maxTokens: number; includeImages: boolean },
): AdvisorTranscriptProjection {
  const sourceSystem = input.filter((message) => message.role === 'system').map(textOf).filter(Boolean).join('\n\n')
  const candidates = input.filter((message) => message.role !== 'system')
  const projected = options.includeImages ? [...candidates] : withoutImages(candidates)
  const firstTaskIndex = projected.findIndex((message) => message.role === 'user' && textOf(message).trim() !== '')
  if (firstTaskIndex < 0) return { messages: projected, sourceSystem, omittedMessages: 0 }
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
  const messages = projected.filter((message) => selected.has(message))
  return { messages, sourceSystem, omittedMessages: projected.length - messages.length }
}