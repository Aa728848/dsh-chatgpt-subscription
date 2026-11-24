import type { Message } from '../../common/llm-compat.ts'

/** Model/catalog facts that govern Codex Responses remote compaction v2. */
export interface CodexRemoteCompactionCapabilities {
  contextWindow?: number | null
  autoCompactTokenLimit?: number | null
  compHash?: string | null
}

/** An opaque server checkpoint plus the model configuration that minted it. */
export interface CodexRemoteCompactionCheckpoint {
  item: Record<string, unknown>
  model: string
  compHash?: string
}

let rejected = false

/** Whether the Codex line currently owns compaction instead of DSH. */
export function codexRemoteCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (rejected) return false
  const raw = (env.DSH_CODEX_REMOTE_COMPACTION ?? '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off', 'none'].includes(raw)
}

/** A definite protocol refusal disables remote compaction until restart. */
export function noteCodexRemoteCompactionFailure(error: unknown): boolean {
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const failure = isRecord(value.failure) ? value.failure : undefined
  const status = typeof value.status === 'number'
    ? value.status
    : typeof failure?.status === 'number' ? failure.status : undefined
  if (status !== 400 && status !== 404 && value.code !== 'NOT_FOUND') return false
  rejected = true
  return true
}

/** Test seam; production resets only by restarting the host. */
export function resetCodexRemoteCompaction(): void {
  rejected = false
}

/** Official catalog thresholds win; otherwise Codex derives 90% of the window. */
export function codexRemoteCompactionThreshold(
  capabilities: CodexRemoteCompactionCapabilities,
): number | null {
  const window = positive(capabilities.contextWindow)
  const automatic = positive(capabilities.autoCompactTokenLimit)
  if (automatic !== null) {
    return Math.max(1, Math.floor(window === null ? automatic : Math.min(automatic, window * 0.9)))
  }
  return window === null ? null : Math.max(1, Math.floor(window * 0.9))
}

/** Conservative, transport-independent estimate used only to schedule compaction. */
export function estimateCodexPayloadTokens(payload: Record<string, unknown>): number {
  const text = JSON.stringify([payload.instructions, payload.input, payload.tools]) ?? ''
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

export function shouldCompactCodexPayload(
  payload: Record<string, unknown>,
  capabilities: CodexRemoteCompactionCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!codexRemoteCompactionEnabled(env)) return false
  const threshold = codexRemoteCompactionThreshold(capabilities)
  return threshold !== null && estimateCodexPayloadTokens(payload) >= threshold
}

/** Official Codex remote-v2 uses an input item, not public /responses/compact. */
export function withCodexCompactionTrigger(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const input = Array.isArray(payload.input) ? payload.input : []
  return { ...payload, input: [...input, { type: 'compaction_trigger' }] }
}

/** Keep the static head and the latest user turn around a fresh checkpoint. */
export function projectFreshCodexCompaction<T extends Record<string, unknown>>(
  payload: T,
  checkpoint: CodexRemoteCompactionCheckpoint,
): T {
  const input = Array.isArray(payload.input)
    ? payload.input.filter((item): item is Record<string, unknown> => isRecord(item))
    : []
  let firstUser = -1
  let latestUser = -1
  for (let index = 0; index < input.length; index += 1) {
    if (!isUserItem(input[index]!)) continue
    if (firstUser < 0) firstUser = index
    latestUser = index
  }
  const head = firstUser < 0 ? [] : input.slice(0, firstUser)
  const tail = latestUser < 0 ? [] : input.slice(latestUser)
  return { ...payload, input: [...head, structuredClone(checkpoint.item), ...tail] } as T
}

/** Latest valid checkpoint in the persisted DSH transcript, if one exists. */
export function latestCodexCompaction(
  messages: readonly Message[],
  model: string,
  compHash: string | null | undefined,
): { index: number; checkpoint: CodexRemoteCompactionCheckpoint } | null {
  if (!codexRemoteCompactionEnabled()) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || message.source?.kind !== 'model') continue
    const replay = record(message.source.replayState)
    const response = record(replay?.response)
    const metadata = record(response?.nativeCompaction)
    const checkpoint = checkpointFromMetadata(metadata, model, compHash)
    if (checkpoint !== null) return { index, checkpoint }
  }
  return null
}

/** Read a checkpoint only when its model configuration remains compatible. */
export function checkpointFromMetadata(
  metadata: Record<string, unknown> | null,
  model: string,
  compHash: string | null | undefined,
): CodexRemoteCompactionCheckpoint | null {
  if (metadata === null || metadata.model !== model || !isCompactionItem(metadata.item)) return null
  const mintedHash = typeof metadata.compHash === 'string' ? metadata.compHash : undefined
  if (mintedHash !== undefined && compHash != null && mintedHash !== compHash) return null
  return {
    item: structuredClone(metadata.item),
    model,
    ...(mintedHash === undefined ? {} : { compHash: mintedHash }),
  }
}

/** Extract exactly one opaque compaction item from a completed remote-v2 stream. */
export function checkpointFromOutputItems(
  items: readonly unknown[],
  model: string,
  compHash: string | null | undefined,
): CodexRemoteCompactionCheckpoint | null {
  const found = items.filter(isCompactionItem)
  if (found.length !== 1) return null
  return {
    item: structuredClone(found[0]!),
    model,
    ...(compHash == null ? {} : { compHash }),
  }
}

/** Finish-chunk metadata persisted on the ordinary assistant answer. */
export function codexCompactionReplayMetadata(
  checkpoint: CodexRemoteCompactionCheckpoint,
): Record<string, unknown> {
  return {
    model: checkpoint.model,
    ...(checkpoint.compHash === undefined ? {} : { compHash: checkpoint.compHash }),
    item: structuredClone(checkpoint.item),
  }
}

export function isCompactionItem(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.type === 'compaction'
    && typeof value.encrypted_content === 'string'
    && value.encrypted_content.length > 0
}

function isUserItem(item: Record<string, unknown>): boolean {
  return item.role === 'user' && (item.type === undefined || item.type === 'message')
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
