import { HarnessError } from '@deepseek-ai/dsh-llm'

export const MAX_REFERENCE_IMAGES = 9
export const MAX_REFERENCE_VIDEOS = 3
export const MAX_REFERENCE_AUDIOS = 3
export const MAX_REFERENCE_MEDIA_TOTAL = 12

export function minimaxModelSupportsReferenceMedia(model: string): boolean {
  return model === 'MiniMax-H3' || model === 'MiniMax-H3-Max'
}

export interface MinimaxGenerationMediaInput {
  readonly inputImagePath?: string
  readonly lastFrameImagePath?: string
  readonly referenceType?: string
  readonly referenceImagePaths?: readonly string[]
  readonly referenceVideoPaths?: readonly string[]
  readonly referenceVideoDurationSeconds?: readonly number[]
  readonly referenceAudioPaths?: readonly string[]
}

function countList(value: readonly string[] | undefined): number {
  if (!Array.isArray(value)) return 0
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').length
}

function assertCollectionSize(field: string, label: string, count: number, limit: number): void {
  if (count <= limit) return
  throw new HarnessError(
    'this generation carries ' + count + ' ' + label + ', and at most ' + limit + ' are accepted'
      + ' (in ' + field + '). Remove some of them and try again.',
    'MINIMAX_VIDEO_REFERENCE_LIMIT',
  )
}

export function assertGenerationMediaLimits(
  input: MinimaxGenerationMediaInput,
  model: string,
): void {
  const images = countList(input.referenceImagePaths)
  const videos = countList(input.referenceVideoPaths)
  const audios = countList(input.referenceAudioPaths)
  const hasLastFrame = typeof input.lastFrameImagePath === 'string' && input.lastFrameImagePath.trim() !== ''
  const hasReferences = images + videos + audios > 0
  if (!minimaxModelSupportsReferenceMedia(model)) {
    if (hasReferences) {
      throw new HarnessError(
        model + ' does not accept reference images, reference videos or reference audio. Remove'
          + ' referenceImagePaths / referenceVideoPaths / referenceAudioPaths, or switch to MiniMax-H3.',
        'MINIMAX_VIDEO_REFERENCES_UNSUPPORTED',
      )
    }
    if (hasLastFrame) {
      throw new HarnessError(
        model + ' does not accept a last frame image: it supports first_frame (or the legacy subject'
          + ' reference type) only. Remove lastFrameImagePath, or switch to MiniMax-H3 and pass both'
          + ' frames there.',
        'MINIMAX_VIDEO_LAST_FRAME_UNSUPPORTED',
      )
    }
  }
  assertCollectionSize('referenceImagePaths', 'reference image(s)', images, MAX_REFERENCE_IMAGES)
  assertCollectionSize('referenceVideoPaths', 'reference video(s)', videos, MAX_REFERENCE_VIDEOS)
  assertCollectionSize('referenceAudioPaths', 'reference audio(s)', audios, MAX_REFERENCE_AUDIOS)
  assertCollectionSize(
    'referenceImagePaths / referenceVideoPaths / referenceAudioPaths',
    'reference media file(s) in total',
    images + videos + audios,
    MAX_REFERENCE_MEDIA_TOTAL,
  )
}

/**
 * The task id of an attempt that has not produced one yet.
 *
 * A plain `undefined` would NOT work as the stored value: `Map.get` returns
 * `undefined` both for a missing key and for a key whose value IS undefined, so
 * an attempt remembered before the service answered would be indistinguishable
 * from one that was never made. The sentinel is what tells them apart.
 */
const PENDING_TASK_ID = ''

const attemptedSubmissions = new Map<string, string>()

export function stableJsonKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableJsonKey).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJsonKey(record[key])).join(',') + '}'
}

export function videoSubmissionKey(
  sessionId: string | undefined,
  turn: string | number | undefined,
  body: unknown,
): string {
  return JSON.stringify([sessionId ?? '', turn ?? '', stableJsonKey(body)])
}

/**
 * Whether a submission key is precise enough to REFUSE a repeat on.
 *
 * The key is only meaningful WITHIN one session and turn. When the runtime
 * exposes neither, the key degrades to the request body alone - and then two
 * genuinely different requests in the same process would carry the same key,
 * so the guard would refuse a generation the user actually asked for.
 *
 * A false refusal is worse than a missed duplicate: a missed duplicate costs
 * one extra generation, while a false refusal blocks the request outright. The
 * guard therefore stays INACTIVE without a session identity, and the caller's
 * own retry discipline carries that case.
 *
 * @param sessionId - the session the call belongs to, when known.
 * @param turn - the turn within it, when known.
 * @returns true when the key identifies one request in one session turn.
 */
export function isPreciseSubmissionKey(
  sessionId: string | undefined,
  turn: string | number | undefined,
): boolean {
  return sessionId !== undefined && sessionId !== '' && turn !== undefined
}

export function attemptedVideoSubmissionFor(key: string): string | undefined {
  const recorded = attemptedSubmissions.get(key)
  return recorded === undefined ? undefined : recorded
}

export function recordVideoSubmissionAttempt(key: string, taskId?: string): void {
  attemptedSubmissions.set(key, taskId ?? PENDING_TASK_ID)
}

export function attemptedVideoSubmissionCount(): number {
  return attemptedSubmissions.size
}

export function resetVideoSubmissionGuard(): void {
  attemptedSubmissions.clear()
}