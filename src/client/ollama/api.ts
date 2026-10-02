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
  const envelope = await response.json() as { ok: boolean; value?: T; error?: string }
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.error || `HTTP ${response.status}`)
  }
  return envelope.value as T
}