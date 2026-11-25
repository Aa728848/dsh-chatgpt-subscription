import type { CredentialStore } from '../../../src/host/infra/storage/token-store.ts'
import type { OpenCodeGoPoolAccount } from '../../../src/host/providers/opencode-go/account-pool.ts'
import type { PoolData } from '../../../src/host/common/account-pool.ts'
import type { OpenCodeGoModelEntry } from '../../../src/host/providers/opencode-go/model-catalog.ts'
import type { OpenCodeGoSettings } from '../../../src/host/providers/opencode-go/token-store.ts'
import type { OpenCodeGoWebStatus } from '../../../src/shared/opencode-go-contracts.ts'

export function credential(apiKey = 'oc_sk_test'): { apiKey: string; authenticatedAt: number } { return { apiKey, authenticatedAt: 1_700_000_000_000 } }
export function modelEntry(overrides: Partial<OpenCodeGoModelEntry> = {}): OpenCodeGoModelEntry {
  return { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: null, canonicalId: 'deepseek/deepseek-v4.1-flash-1017', contextWindow: 1_000_000, maxOutputTokens: 384_000, reasoningEfforts: ['low', 'high', 'max'], supportsTools: true, supportsImages: true, training: false, zdr: true, limitedRegions: false, ...overrides }
}
export function settings(overrides: Partial<OpenCodeGoSettings> = {}): OpenCodeGoSettings {
  return { enabled: true, enabledModelIds: null, contextWindowOverrides: {}, defaultReasoningEffort: null, selectedAccountId: null, ...overrides }
}
export function memoryBackend(initial?: PoolData<OpenCodeGoPoolAccount>): CredentialStore<PoolData<OpenCodeGoPoolAccount>> & { data: PoolData<OpenCodeGoPoolAccount> | null } {
  const holder: { data: PoolData<OpenCodeGoPoolAccount> | null } = { data: initial ?? null }
  return {
    data: holder.data,
    async load() { return holder.data },
    async save(value) { holder.data = structuredClone(value); (this as { data: PoolData<OpenCodeGoPoolAccount> | null }).data = holder.data },
    async clear() { (this as { data: PoolData<OpenCodeGoPoolAccount> | null }).data = null },
  }
}
export function sse(lines: readonly string[]): Response {
  return new Response(lines.map(line => 'data: ' + line + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
export function jsonResponse(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }

export function webStatus(): OpenCodeGoWebStatus {
  const windows = [{ label: '5 小时窗口', usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000_000 }, { label: '每周窗口', usedPercent: 24, windowDurationMins: 10_080, resetsAt: 1_800_000_000_000 }, { label: '月度共享额度', usedPercent: 38, windowDurationMins: 43_200, resetsAt: 1_800_000_000_000 }]
  return {
    enabled: true, providerId: 'opencode-go', serving: true, conflict: null, authenticated: true,
    accounts: [{ id: 'acc_1', alias: '主账号', isPrimary: true, authKind: 'api-key', planName: 'Go Plus', quota: { fetchedAt: 1_700_000_000_000, windows } }],
    activeAccountId: 'acc_1', rotationStrategy: 'sticky', selectedAccountId: null,
    models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', hint: '1M · text+image', enabled: true, defaultContextWindow: 1_000_000, contextWindow: 1_000_000, defaultMaxTokens: 384_000, reasoningEfforts: ['low', 'high', 'max'], supportsTools: true, supportsImages: true, description: null, canonicalId: 'deepseek/deepseek-v4.1-flash-1017', training: false, zdr: true, limitedRegions: false }],
    contextWindowOverrides: {}, defaultReasoningEffort: null, catalogSynced: true, catalogCount: 1, quotaError: null, connection: null,
  }
}
