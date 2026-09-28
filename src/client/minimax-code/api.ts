/**
 * The MiniMax Code routes the settings card consumes, in one place.
 *
 * Every path is prefixed with the frozen shared constant, so the client cannot
 * drift from the host's mount point. Answers are read tolerantly: the sibling
 * lines reply with an `{ ok, value }` envelope while this line's route table
 * documents the payload itself, and a card must not care which one arrived.
 */
import { MINIMAX_CODE_ROUTE_PREFIX } from '../../shared/minimax-code-contracts.ts'

interface Envelope {
  ok?: unknown
  value?: unknown
  error?: unknown
}

/** A route's error field is a plain string on some routes and an object on others. */
function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MINIMAX_CODE_ROUTE_PREFIX}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const raw = await res.text()
  let body: unknown = null
  try {
    body = raw === '' ? null : (JSON.parse(raw) as unknown)
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }

  const envelope = body as Envelope | null
  if (envelope !== null && typeof envelope === 'object' && typeof envelope.ok === 'boolean' && 'value' in envelope) {
    if (!res.ok || envelope.ok === false) throw new Error(errorMessage(envelope.error, `HTTP ${res.status}`))
    return envelope.value as T
  }
  if (!res.ok) throw new Error(errorMessage((body as Envelope | null)?.error, `HTTP ${res.status}`))
  return body as T
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function post<T>(path: string, body: object = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
