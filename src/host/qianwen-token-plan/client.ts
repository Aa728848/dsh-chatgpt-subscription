import type { QianwenConnectionDto } from '../../shared/qianwen-token-plan-contracts.ts'
import type { QianwenCredentialStore } from './token-store.ts'
import { QIANWEN_CHAT_COMPLETIONS_URL, qianwenHeaders } from './types.ts'
import { classifyQianwenFailure } from './mapper.ts'
import { t } from '../common/i18n/index.ts'
import { PROVIDER_NAME } from './types.ts'

/** Explicit user-triggered connectivity check; status polling never calls this. */
export async function testQianwenConnection(store: QianwenCredentialStore, fetchFn: typeof fetch = fetch): Promise<QianwenConnectionDto> {
  const startedAt = Date.now()
  const model = 'qwen4-max'
  try {
    const credentials = await store.read()
    if (credentials === null) throw new Error(t('qwen.notConfigured'))
    const response = await fetchFn(QIANWEN_CHAT_COMPLETIONS_URL, {
      method: 'POST', headers: qianwenHeaders(credentials.apiKey),
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, enable_thinking: false, max_completion_tokens: 1 }),
    })
    if (!response.ok) throw classifyQianwenFailure(response.status, (await response.text().catch(() => '')).slice(0, 600))
    const payload = await response.json() as unknown
    if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { choices?: unknown }).choices)) throw new Error(t('qwen.responseMissingChoices'))
    return { connected: true, latencyMs: Date.now() - startedAt, model, checkedAt: Date.now() }
  } catch (error) {
    return { connected: false, latencyMs: Date.now() - startedAt, model, checkedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
  }
}
