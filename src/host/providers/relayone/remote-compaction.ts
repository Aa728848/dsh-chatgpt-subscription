import type { Message, StreamChunk } from '../../common/llm-compat.ts'
import {
  checkpointFromMetadata,
  checkpointFromOutputItems,
  codexRemoteCompactionThreshold,
  estimateCodexPayloadTokens,
  projectFreshCodexCompaction,
  withCodexCompactionTrigger,
  type CodexRemoteCompactionCheckpoint,
} from '../codex-chatgpt/codex-remote-compaction.ts'

/** A RelayOne encrypted checkpoint is valid only for the key that minted it. */
export interface RelayOneRemoteCompactionCheckpoint extends CodexRemoteCompactionCheckpoint {
  readonly scope: string
}

/** Sessions whose current upstream cannot take remote compaction fall back to DSH. */
const disabledSessions = new Set<string>()

export function relayOneRemoteCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.DSH_RELAYONE_REMOTE_COMPACTION ?? '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off', 'none'].includes(raw)
}

/** Keep the guard and adapter on the same model vocabulary. */
export function relayOneRemoteCompactionModel(model: string): boolean {
  return /^(?:gpt-|o[134](?:-|$)|codex)/i.test(model)
}

function sessionKey(sessionId: string, model: string): string {
  return sessionId.trim() + '\0' + model
}

/** Whether ordinary pressure compaction should be left to the RelayOne native path. */
export function relayOneRemoteCompactionOwns(
  sessionId: string | undefined,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return sessionId !== undefined && sessionId.trim() !== ''
    && relayOneRemoteCompactionEnabled(env) && relayOneRemoteCompactionModel(model)
    && !disabledSessions.has(sessionKey(sessionId, model))
}

/** A definite protocol failure re-enables DSH pressure compaction for this session. */
export function noteRelayOneRemoteCompactionResult(sessionId: string | undefined, model: string, supported: boolean): void {
  if (sessionId === undefined || sessionId.trim() === '') return
  const key = sessionKey(sessionId, model)
  if (supported) disabledSessions.delete(key)
  else disabledSessions.add(key)
}

/** Test seam; production state changes only through request outcomes. */
export function resetRelayOneRemoteCompaction(): void {
  disabledSessions.clear()
}

export function shouldCompactRelayOnePayload(
  payload: Record<string, unknown>,
  contextWindow: number,
  sessionId: string | undefined,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!relayOneRemoteCompactionOwns(sessionId, model, env)) return false
  const threshold = codexRemoteCompactionThreshold({ contextWindow })
  return threshold !== null && estimateCodexPayloadTokens(payload) >= threshold
}

export function withRelayOneCompactionTrigger(payload: Record<string, unknown>): Record<string, unknown> {
  return withCodexCompactionTrigger(payload)
}

export function projectFreshRelayOneCompaction<T extends Record<string, unknown>>(
  payload: T,
  checkpoint: RelayOneRemoteCompactionCheckpoint,
): T {
  return projectFreshCodexCompaction(payload, checkpoint)
}

export function relayOneCheckpointFromOutputItems(
  items: readonly unknown[],
  model: string,
  scope: string,
): RelayOneRemoteCompactionCheckpoint | null {
  const checkpoint = checkpointFromOutputItems(items, model, null)
  return checkpoint === null ? null : { ...checkpoint, scope }
}

/** Latest compatible checkpoint in the durable DSH transcript. */
export function latestRelayOneCompaction(
  messages: readonly Message[],
  model: string,
  scope: string,
): { index: number; checkpoint: RelayOneRemoteCompactionCheckpoint } | null {
  if (!relayOneRemoteCompactionEnabled()) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || message.source?.kind !== 'model') continue
    const replay = record(message.source.replayState)
    const response = record(replay?.response)
    const metadata = record(response?.nativeCompaction)
    if (metadata?.scope !== scope) continue
    const checkpoint = checkpointFromMetadata(metadata, model, null)
    if (checkpoint !== null) return { index, checkpoint: { ...checkpoint, scope } }
  }
  return null
}

export function relayOneCompactionReplayMetadata(checkpoint: RelayOneRemoteCompactionCheckpoint): Record<string, unknown> {
  return { model: checkpoint.model, scope: checkpoint.scope, item: structuredClone(checkpoint.item) }
}

/** Preserve the key scope that the Codex parser's own metadata does not know about. */
export function withRelayOneCompactionMetadata(
  chunk: StreamChunk,
  checkpoint: RelayOneRemoteCompactionCheckpoint,
): StreamChunk {
  if (chunk.type !== 'finish') return chunk
  const replay = record(chunk.replayState)
  const response = record(replay?.response)
  return {
    ...chunk,
    replayState: {
      ...replay,
      response: { ...response, nativeCompaction: relayOneCompactionReplayMetadata(checkpoint) },
    },
  }
}

/** Only a definite protocol refusal disables remote attempts; transport failures stay retryable. */
export function isDefiniteRelayOneCompactionFailure(error: unknown): boolean {
  const value = record(error)
  const status = typeof value?.status === 'number' ? value.status
    : typeof value?.relayOneStatus === 'number' ? value.relayOneStatus : undefined
  return value?.code === 'PROTOCOL_ERROR' || (status !== undefined && [400, 404, 405, 422].includes(status))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}