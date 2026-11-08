/**
 * Stable bootstrap-prefix ordering for providers that reuse content prefixes.
 * Dynamic mid-conversation updates stay at their original history position;
 * only the initial harness bootstrap run is normalised ahead of the user task.
 */
import type { GenerateOptions, Message } from './llm-compat.ts'
import { promptCachePolicyOf, type PromptCacheOverride } from './prompt-cache-policy.ts'
import { isAuxiliaryRequest } from './prefix-request-coordinator.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstTextOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
    if (block.type === 'tool-result') {
      const nested = firstTextOf(block.content)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function isToolResultMessage(message: Message | undefined): boolean {
  return message?.source?.kind === 'tool'
}

/** Stability tier for an initial bootstrap reminder; null means dynamic/history-bound. */
export function classifyBootstrapUserMessage(message: Message): 1 | 2 | 3 | 4 | null {
  if (message.role !== 'user' || isToolResultMessage(message)) return null
  const source = isRecord(message.source) ? message.source : undefined
  const kind = source !== undefined && typeof source.kind === 'string' ? source.kind : undefined
  const text = firstTextOf(message.content)?.trimStart() ?? ''
  if (kind === 'progress-updates-language' || text.startsWith('Progress update output language override:')) return 1
  if (text.startsWith('<system-reminder>\nThe following workspace instructions') || (
    kind === 'agent-instructions'
    && !text.startsWith('<system-reminder>\nUpdated instructions')
    && !text.startsWith('<system-reminder>\nAdditional instructions')
    && !text.startsWith('<system-reminder>\nInstructions removed')
  )) return 2
  if (text.startsWith('<system-reminder>\nA skill is a reusable set of task-specific instructions.') || (
    kind === 'skill-catalog' && !text.startsWith('<system-reminder>\nThe available skill catalog changed.')
  )) return 3
  if (kind === 'runtime-context' || text.startsWith('Current runtime context. This snapshot supersedes')) return 4
  return null
}

function isCompactCheckpointMessage(message: Message | undefined): boolean {
  if (message === undefined || message.role !== 'user' || isToolResultMessage(message)) return false
  const source = isRecord(message.source) ? message.source : undefined
  if (source !== undefined && source.kind === 'compact-checkpoint') return true
  return firstTextOf(message.content)?.trimStart().startsWith('This is an automatically generated checkpoint condensing') === true
}

/** Global instructions precede workspace instructions without reordering equals. */
function normalizeAgentInstructionsMessage(message: Message): Message {
  if (!Array.isArray(message.content) || message.content.length !== 1) return message
  const first = message.content[0]
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') return message
  const raw = first.text
  const marker = '\n\nInstructions from: '
  const firstIdx = raw.indexOf(marker)
  if (firstIdx < 0) return message
  const closeTag = '\n</system-reminder>'
  const closeIdx = raw.lastIndexOf(closeTag)
  if (closeIdx <= firstIdx) return message
  const header = raw.slice(0, firstIdx)
  const body = raw.slice(firstIdx + 2, closeIdx)
  const tail = raw.slice(closeIdx)
  const sections = body.split('\n\nInstructions from: ')
  if (sections.length < 2) return message
  const tagged = sections.map((sec, idx) => {
    const firstLineEnd = sec.indexOf('\n')
    const sourcePath = (firstLineEnd < 0 ? sec : sec.slice(0, firstLineEnd)).trim()
    const global = sourcePath.startsWith('~/') || sourcePath.startsWith('~\\') || sourcePath.includes('/.dsh/') || sourcePath.includes('\\.dsh\\')
    return { sec, idx, rank: global ? 0 : 1 }
  })
  if (!tagged.some((item, i) => i > 0 && item.rank < tagged[i - 1]!.rank)) return message
  tagged.sort((a, b) => a.rank - b.rank || a.idx - b.idx)
  const rebuilt = `${header}\n\nInstructions from: ${tagged.map(item => item.sec).join('\n\nInstructions from: ')}${tail}`
  return { ...message, content: [{ ...first, text: rebuilt }] as unknown as Message['content'] }
}

/** Normalise the initial bootstrap run, including the post-compaction shape. */
export function orderStaticPrefixMessages(messages: readonly Message[]): Message[] {
  try {
    if (messages.length <= 1) return [...messages]
    let leadEnd = 0
    while (leadEnd < messages.length && messages[leadEnd]!.role === 'user' && !isToolResultMessage(messages[leadEnd])) leadEnd += 1

    if (leadEnd > 0 && isCompactCheckpointMessage(messages[0])) {
      const seenInLead = new Set<number>()
      for (let i = 0; i < leadEnd; i++) {
        const tier = classifyBootstrapUserMessage(messages[i]!)
        if (tier !== null) seenInLead.add(tier)
      }
      if (!seenInLead.has(1) && !seenInLead.has(2)) {
        const hoistedByTier = new Map<1 | 2 | 3, { index: number; message: Message }>()
        for (let i = leadEnd; i < messages.length; i++) {
          const msg = messages[i]!
          const tier = classifyBootstrapUserMessage(msg)
          if ((tier === 1 || tier === 2 || tier === 3) && !hoistedByTier.has(tier)) {
            hoistedByTier.set(tier, { index: i, message: tier === 2 ? normalizeAgentInstructionsMessage(msg) : msg })
          }
        }
        if (hoistedByTier.size > 0) {
          const indices = new Set<number>()
          const prefix: Message[] = []
          for (const tier of [1, 2, 3] as const) {
            const entry = hoistedByTier.get(tier)
            if (entry !== undefined) {
              indices.add(entry.index)
              prefix.push(entry.message)
            }
          }
          return [...prefix, ...messages.filter((_, index) => !indices.has(index))]
        }
      }
    }

    if (leadEnd <= 1) return [...messages]
    const seen = new Set<number>()
    const tagged: Array<{ message: Message; rank: number; index: number }> = []
    let hasBootstrap = false
    for (let i = 0; i < leadEnd; i++) {
      const raw = messages[i]!
      const tier = classifyBootstrapUserMessage(raw)
      if (tier !== null && !seen.has(tier)) {
        seen.add(tier)
        hasBootstrap = true
        tagged.push({ message: tier === 2 ? normalizeAgentInstructionsMessage(raw) : raw, rank: tier, index: i })
      } else tagged.push({ message: raw, rank: 5, index: i })
    }
    if (!hasBootstrap) return [...messages]
    const needsReorder = tagged.some((item, i) => (i > 0 && item.rank < tagged[i - 1]!.rank) || item.message !== messages[i])
    if (!needsReorder) return [...messages]
    tagged.sort((a, b) => a.rank - b.rank || a.index - b.index)
    return [...tagged.map(item => item.message), ...messages.slice(leadEnd)]
  } catch {
    return [...messages]
  }
}

/** Apply the policy at an adapter boundary; disabled providers keep object identity. */
export function withStaticPrefixOrdering<T extends GenerateOptions>(
  provider: string,
  options: T,
  override?: PromptCacheOverride,
): T {
  if (!promptCachePolicyOf(provider, override).staticPrefix) return options
  const messages = orderStaticPrefixMessages(options.messages)
  const changed = messages.some((message, index) => message !== options.messages[index])
  return changed ? { ...options, messages } : options
}

function allTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!isRecord(block)) return ''
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    if (block.type === 'tool-result') return allTextOf(block.content)
    return ''
  }).join('')
}

function prefixFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Provider-neutral identity for requests that may share one cold prefix. */
export function sharedPrefixGroupKey(
  provider: string,
  options: GenerateOptions,
  namespace: string,
  accountScope: string,
): string | undefined {
  if (isAuxiliaryRequest(options)) return undefined
  const systemParts: string[] = []
  if (typeof options.system === 'string' && options.system.trim() !== '') systemParts.push(options.system)
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = allTextOf(message.content)
      if (text !== '') systemParts.push(text)
    }
  }
  if (systemParts.length === 0) return undefined
  const systemHash = prefixFingerprint(systemParts.join('\n\n'))
  const tools = options.tools ?? []
  const toolsHash = tools.length === 0
    ? 'none'
    : prefixFingerprint(JSON.stringify(tools.map(tool => [tool.name, tool.description ?? '', tool.parameters ?? {}])))
  const staticParts: string[] = []
  for (const message of orderStaticPrefixMessages(options.messages)) {
    const tier = classifyBootstrapUserMessage(message)
    if (tier !== 1 && tier !== 2 && tier !== 3) break
    staticParts.push(allTextOf(message.content))
  }
  const staticHash = staticParts.length === 0 ? 'none' : prefixFingerprint(staticParts.join('\n\n'))
  return [provider, namespace, options.model, systemHash, toolsHash, staticHash, accountScope].join(':')
}

export interface SharedPrefixSnapshot {
  readonly systemPromptHash: string | null
  readonly toolsHash: string | null
  readonly cacheKey: string | null
}

export type SharedPrefixDriftCause = 'first-request' | 'stable' | 'system-prompt' | 'tools' | 'cache-key' | 'cold-key'

/** Pure prefix-diff policy shared by provider-specific telemetry stores. */
export function classifyPrefixDrift(
  previous: SharedPrefixSnapshot | undefined,
  current: SharedPrefixSnapshot,
): SharedPrefixDriftCause {
  if (previous === undefined || (previous.systemPromptHash === null && previous.toolsHash === null && previous.cacheKey === null)) return 'first-request'
  if (current.cacheKey === null) return 'cold-key'
  if (previous.cacheKey !== current.cacheKey) return 'cache-key'
  if (previous.systemPromptHash !== current.systemPromptHash) return 'system-prompt'
  if (previous.toolsHash !== current.toolsHash) return 'tools'
  return 'stable'
}
