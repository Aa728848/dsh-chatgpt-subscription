import type { AntigravityAcpStatusDto, AntigravityAcpSettingsUpdateDto } from '../../shared/antigravity-acp-contracts.ts'

const API = '/antigravity-acp/api'

/**
 * The Antigravity (ACP) settings API, as the card uses it.
 *
 * Same envelope and fetch shape as every other provider section, so the shared
 * components read alike.
 */
export class AntigravityAcpApi {
  status(): Promise<AntigravityAcpStatusDto> {
    return request<AntigravityAcpStatusDto>(`${API}/status`)
  }

  /** Submit one settings patch and receive the refreshed status. */
  update(patch: AntigravityAcpSettingsUpdateDto): Promise<AntigravityAcpStatusDto> {
    return post<AntigravityAcpStatusDto>(`${API}/settings`, patch)
  }

  /** Force a live catalogue read. */
  refresh(): Promise<AntigravityAcpStatusDto> {
    return post<AntigravityAcpStatusDto>(`${API}/refresh`, {})
  }

  /** Run the line's self-check and return its one-line-per-stage report. */
  doctor(): Promise<{ ok: boolean; steps: { id: string; ok: boolean; detail: string }[] }> {
    return post(`${API}/doctor`, {})
  }

  /**
   * Start the official sign-in.
   *
   * The browser is opened by `agy` itself; this call only asks the host to
   * spawn it. Nothing here opens a window, which is what keeps one click from
   * producing two Google pages.
   */
  startLogin(): Promise<{ started: boolean }> {
    return post<{ started: boolean }>(`${API}/login/start`, {})
  }

  /** Re-read the auth state after a sign-in attempt. */
  loginStatus(): Promise<AntigravityAcpStatusDto['auth']> {
    return request<AntigravityAcpStatusDto['auth']>(`${API}/login/status`)
  }
}

async function post<T>(url: string, body: object): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' })
  const envelope = await readEnvelope<T>(response)
  if (!response.ok || !envelope.ok) throw new Error(envelope.error || `HTTP ${response.status}`)
  return envelope.value as T
}

/**
 * Read the {ok,value,error} envelope, or say why there was not one.
 *
 * Reading the text first turns an empty or non-JSON answer into a sentence that
 * names the status instead of the browser's own JSON parse error.
 */
async function readEnvelope<T>(response: Response): Promise<{ ok: boolean; value?: T; error?: string }> {
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new Error(unreadable(response, cause))
  }
  if (text.trim() === '') throw new Error(unreadable(response))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(unreadable(response))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(unreadable(response))
  const envelope = parsed as { ok: boolean; value?: T; error?: string }
  if (typeof envelope.error !== 'string') delete envelope.error
  return envelope
}

function unreadable(response: Response, cause?: unknown): string {
  const kind = response.headers.get('content-type') ?? 'no content-type'
  return `The Antigravity settings API answered with ${response.status} and no JSON body (${kind})`
    + (cause instanceof Error ? `: ${cause.message}` : '')
    + '. The Host log holds the underlying error.'
}
