import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '../../common/llm-compat.ts'
import { LlmError } from '../../common/llm-compat.ts'
import { attachmentLabel, imageBlockToInline, unavailableImageText, type ResolvedRequestImages } from '../../common/request-images.ts'
import type { OpenCodeGoProtocol } from '../../../shared/opencode-go-contracts.ts'
import { assertOpenCodeGoStreamComplete, closeOpenCodeGoStream, createOpenCodeGoChatStreamState, processOpenCodeGoStreamLine } from './mapper.ts'

export function isOpenCodeGoRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function openCodeGoString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
export function openCodeGoNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }

export function openCodeGoImageParts(content: readonly ContentBlock[], images: ResolvedRequestImages, accepted: boolean): Array<{ mediaType: string; data: string } | { unavailable: string }> {
  const result: Array<{ mediaType: string; data: string } | { unavailable: string }> = []
  for (const block of content) {
    if (block.type !== 'image') continue
    if (!accepted) { result.push({ unavailable: '[image omitted: the selected OpenCode Go model does not declare image input]' }); continue }
    const inline = imageBlockToInline(block as unknown as Record<string, unknown>, images)
    result.push(inline ?? { unavailable: unavailableImageText(block as unknown as Record<string, unknown>) })
  }
  return result
}

export interface OpenCodeGoUsageMetadata { billingSource: string | null; allowance: number | null }
export function readOpenCodeGoUsageMetadata(raw: unknown): OpenCodeGoUsageMetadata | null {
  if (!isOpenCodeGoRecord(raw) || !isOpenCodeGoRecord(raw.opencode)) return null
  return {
    billingSource: openCodeGoString(raw.opencode.billing_source) ?? null,
    allowance: openCodeGoNumber(raw.opencode.allowance) ?? null,
  }
}

export function openCodeGoReplayBlocks(message: Message): (Record<string, unknown> | null)[] | null {
  if (message.source?.kind !== 'model' || !isOpenCodeGoRecord(message.source.replayState)) return null
  const replay = message.source.replayState
  const response = isOpenCodeGoRecord(replay.response) ? replay.response : undefined
  if (response?.provider !== 'opencode-go' || !Array.isArray(replay.blocks)) return null
  return replay.blocks.map(block => isOpenCodeGoRecord(block) ? structuredClone(block) : null)
}

export function openCodeGoFinishMetadata(chunks: StreamChunk[], protocol: OpenCodeGoProtocol, metadata: OpenCodeGoUsageMetadata | null): StreamChunk[] {
  return chunks.map(chunk => {
    if (chunk.type !== 'finish') return chunk
    const replay: Record<string, unknown> = isOpenCodeGoRecord(chunk.replayState) ? chunk.replayState : {}
    const response = isOpenCodeGoRecord(replay.response) ? replay.response : {}
    return {
      ...chunk,
      replayState: {
        ...replay,
        response: {
          ...response, provider: 'opencode-go', protocol,
          ...(metadata?.billingSource == null ? {} : { billingSource: metadata.billingSource }),
          ...(metadata?.allowance == null ? {} : { allowance: metadata.allowance }),
        },
      },
    } as StreamChunk
  })
}

export function openCodeGoProtocolError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const message = error.message.replace(/RelayOne|Codex|ChatGPT/g, 'OpenCode Go')
  if (error instanceof LlmError) return new LlmError(message, error.code, { cause: error })
  return new Error(message)
}

export interface OpenCodeGoLineDriver {
  finished(): boolean
  allowance(): number | null
  billingSource(): string | null
  process(line: string): StreamChunk[]
  assertComplete(): void
  close(): StreamChunk[]
}

export function createOpenCodeGoChatDriver(): OpenCodeGoLineDriver {
  const state = createOpenCodeGoChatStreamState()
  return {
    finished: () => state.finished,
    allowance: () => state.allowance,
    billingSource: () => state.billingSource,
    process: line => processOpenCodeGoStreamLine(line, state),
    assertComplete: () => assertOpenCodeGoStreamComplete(state),
    close: () => closeOpenCodeGoStream(state),
  }
}

export type OpenCodeGoNativeOptions = GenerateOptions