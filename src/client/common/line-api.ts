/**
 * One line's host routes, behind one reader.
 *
 * Ten copies of this reader had drifted into ten slightly different ones, and
 * the differences were all failure handling — the part nobody looks at until it
 * fires:
 *
 *   - nine of them read `json.error` as a string. That is the sibling lines'
 *     shape, but the ChatGPT routes answer `{ ok: false, error: { code, message } }`,
 *     so a structured refusal rendered as "[object Object]";
 *   - one of them tolerated an empty body and a non-JSON body, which is exactly
 *     what a stale host half produces (the browser reads client assets from disk
 *     on demand; the host loads them only at startup). The other nine turned it
 *     into a bare parse crash with no way to tell what happened.
 *
 * This is the union: both error shapes, both degenerate bodies, and the same
 * sentence for the same failure on every line.
 */
import type { PublicErrorDto } from '../../shared/contracts.ts'

export interface LineApi {
  /** Any route under the line's prefix, unwrapping whichever envelope arrives. */
  request<T>(path: string, init?: RequestInit): Promise<T>
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: object): Promise<T>
}

interface Envelope {
  ok?: unknown
  value?: unknown
  error?: unknown
}

/**
 * A route's error field is a plain string on some routes and a structured
 * `PublicErrorDto` on others; the card must not care which one arrived.
 */
function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object') {
    const message = (value as Partial<PublicErrorDto>).message
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback
}

export function createLineApi(prefix: string, label: string): LineApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${prefix}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })

    const raw = await response.text()
    if (raw.trim() === '') {
      throw new Error(
        `${label} settings route did not answer (HTTP ${response.status} ${response.statusText || 'no body'}). `
        + 'The plugin loaded in the browser may be newer than the one running in the host — '
        + 'restart DSH so both halves come from the same build.',
      )
    }

    let body: unknown = null
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      throw new Error(`${label} settings route returned a non-JSON body (HTTP ${response.status}): ${raw.slice(0, 200)}`)
    }

    const envelope = body as Envelope | null
    // A boolean `ok` is what declares the envelope — not the presence of
    // `value`: a refusal carries `error` and no `value` at all, and demanding
    // both made a 200-with-`ok:false` answer look like a successful payload.
    const isEnvelope = envelope !== null && typeof envelope === 'object' && typeof envelope.ok === 'boolean'
    if (isEnvelope) {
      if (!response.ok || envelope.ok === false) {
        throw new Error(errorMessage(envelope.error, `HTTP ${response.status}`))
      }
      return envelope.value as T
    }
    // Some routes document their payload directly instead of wrapping it.
    if (!response.ok) throw new Error(errorMessage(envelope?.error, `HTTP ${response.status}`))
    return body as T
  }

  return {
    request,
    get: <T>(path: string): Promise<T> => request<T>(path),
    post: <T>(path: string, body: object = {}): Promise<T> => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  }
}
