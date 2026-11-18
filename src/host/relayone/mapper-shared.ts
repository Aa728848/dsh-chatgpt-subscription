import type { ContentBlock, GenerateOptions, Message } from '../common/llm-compat.ts'
import {
  attachmentLabel,
  imageBlockToInline,
  unavailableImageText,
  type ResolvedRequestImages,
} from '../common/request-images.ts'

export function isRelayOneRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export const relayOneString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
export const relayOneNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
export function relayOneArgsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try { return JSON.stringify(value) } catch { return '{}' }
}
export function relayOneSafeJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return undefined }
}
export function relayOneValidArguments(value: string): boolean {
  const parsed = relayOneSafeJson(value === '' ? '{}' : value)
  return isRelayOneRecord(parsed)
}
export function relayOneTextOf(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\0/g, '')
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!isRelayOneRecord(block)) return ''
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') return block.text.replace(/\0/g, '')
    if (block.type === 'tool-result') return relayOneTextOf(block.content)
    if (block.type === 'image') return '[image: ' + (attachmentLabel(block) ?? 'attached image') + ']'
    return ''
  }).filter(Boolean).join('\n')
}
export function relayOneToolResult(message: Message): ContentBlock & { type: 'tool-result' } | undefined {
  return message.content.find((block): block is ContentBlock & { type: 'tool-result' } => block.type === 'tool-result')
}
export function relayOneSystemText(options: GenerateOptions): string {
  const parts = [typeof options.system === 'string' ? options.system.trim() : '']
  for (const message of options.messages) {
    if (message.role !== 'system' && message.role !== 'developer') continue
    const text = relayOneTextOf(message.content.filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal')).trim()
    if (text !== '') parts.push(text)
  }
  return parts.filter(Boolean).join('\n\n')
}
export function relayOneReplayOutputItems(message: Message): Record<string, unknown>[] | null {
  if (message.source?.kind !== 'model') return null
  const replay = message.source.replayState
  if (!isRelayOneRecord(replay)) return null
  const response = isRelayOneRecord(replay.response) ? replay.response : undefined
  const items = Array.isArray(replay.outputItems) ? replay.outputItems
    : response !== undefined && Array.isArray(response.outputItems) ? response.outputItems : null
  if (items === null) return null
  return structuredClone(items.filter(isRelayOneRecord))
}
export function relayOneReplayBlocks(message: Message): (Record<string, unknown> | null)[] | null {
  if (message.source?.kind !== 'model' || !isRelayOneRecord(message.source.replayState)) return null
  const replay = message.source.replayState
  const response = isRelayOneRecord(replay.response) ? replay.response : undefined
  if (response?.provider !== 'relayone' || !Array.isArray(replay.blocks)) return null
  return replay.blocks.map(block => isRelayOneRecord(block) ? structuredClone(block) : null)
}
export function relayOneImageParts(
  content: readonly ContentBlock[],
  images: ResolvedRequestImages,
  accepted: boolean,
): Array<{ mediaType: string; data: string } | { unavailable: string }> {
  const result: Array<{ mediaType: string; data: string } | { unavailable: string }> = []
  for (const block of content) {
    if (block.type !== 'image') continue
    if (!accepted) {
      result.push({ unavailable: '[image omitted: the selected RelayOne model does not declare image input]' })
      continue
    }
    const inline = imageBlockToInline(block as unknown as Record<string, unknown>, images)
    result.push(inline ?? { unavailable: unavailableImageText(block as unknown as Record<string, unknown>) })
  }
  return result
}
export function relayOneEffort(
  options: GenerateOptions,
  configured: string | null,
  supported: readonly string[],
): string | undefined {
  const requested = typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim() !== ''
    ? options.reasoningEffort.trim() : configured
  return requested !== null && requested !== undefined && supported.includes(requested) ? requested : undefined
}
