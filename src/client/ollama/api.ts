import type { OllamaWebStatus } from '../../shared/ollama-contracts.ts'

const API = '/ollama/api'

/**
 * The Ollama settings API, as the card uses it.
 *
 * Deliberately the same envelope and the same fetch shape every other provider
 * section uses, so the shared account-pool card and this helper read alike.
 */
export class OllamaApi {
  status(): Promise<OllamaWebStatus> {
    return request<OllamaWebStatus>(`${API}/status`)
  }

  /**
   * One pool action, returning the refreshed status.
   *
   * The host answers with the same envelope the status route uses, so the card
   * never has to guess what the pool looks like after a change.
   */
  accountAction(
    action: 'add' | 'set-primary' | 'set-alias' | 'delete' | 'clear-cooldown' | 'strategy',
    body: { accountId?: string; alias?: string; strategy?: string; apiKey?: string } = {},
  ): Promise<OllamaWebStatus> {
    return post<OllamaWebStatus>(`${API}/accounts`, { action, ...body })
  }

  refreshCatalog(): Promise<{ models: unknown[] }> {
    return post(`${API}/catalog/refresh`, {})
  }

  /**
   * Replace the enabled-model selection.
   *
   * The whole list is sent rather than a single id's new state, because the card
   * offers bulk select and unselect and would otherwise have to read the current
   * selection before it could answer 'turn this one off'.
   */
  setEnabledModels(enabledModelIds: string[]): Promise<{ enabledModelIds: string[] }> {
    return post(`${API}/models`, { enabledModelIds })
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
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.error || `HTTP ${response.status}`)
  }
  return envelope.value as T
}

/**
 * Read the {ok,value,error} envelope, or say why there was not one.
 *
 * `response.json()` is not a way to report an error. A body that is empty —
 * which is what DSH's web server sends for a route handler that rejected, and
 * what a proxy sends for a blocked request — throws the browser's own
 * "Failed to execute 'json' on 'Response': Unexpected end of JSON input" (issue
 * #36), a sentence that names neither the status nor the request. Reading the
 * text first costs one string and turns every unreadable answer into a message
 * that says what the Host actually replied.
 *
 * The body is never echoed back: it can be an HTML page of arbitrary size, and
 * its content-type alone is what identifies the failure.
 */
async function readEnvelope<T>(
  response: Response,
): Promise<{ ok: boolean; value?: T; error?: string }> {
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(unreadable(response))
  }
  const envelope = parsed as { ok: boolean; value?: T; error?: string }
  if (typeof envelope.error !== 'string') delete envelope.error
  return envelope
}

/** The one sentence every unreadable answer turns into. */
function unreadable(response: Response, cause?: unknown): string {
  const kind = response.headers.get('content-type') ?? 'no content-type'
  return `The Ollama settings API answered with ${response.status} and no JSON body (${kind})`
    + (cause instanceof Error ? `: ${cause.message}` : '')
    + '. The Host log holds the underlying error.'
}