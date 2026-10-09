/**
 * One-shot probe: diff the live WorkBuddy catalog (read from `\`/v3/config\``
 * with this machine's own stored credentials) against the shipped fallback
 * table, so the transcription can be refreshed from a real read rather than a
 * guess.
 *
 * It also answers the question the published list cannot: `/v3/config` is not
 * the set of models the gateway serves. Measured 2026-10-09, `gpt-6-sol`,
 * `gpt-6-luna` and `gemini-3.8-flash` answer a normal streaming completion
 * with 200 while being absent from it, which is why model-catalog.ts carries
 * them as UNPUBLISHED_MODELS and merges them into a live catalog.
 *
 * Read-only with respect to the repository and the credential files. Every
 * value printed is a model capability \u2014 never a token.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-catalog.probe.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { clearCachedCatalog, loadConfigCatalog, refreshCredentials } from '../src/host/workbuddy/client.ts'
import { FALLBACK_MODELS, modelsForRegion } from '../src/host/workbuddy/model-catalog.ts'
import type { WorkBuddyRegion } from '../src/shared/workbuddy-contracts.ts'

const FIELDS = [
  'name', 'contextWindow', 'maxContextWindow', 'maxTokens', 'supportsImage',
  'reasoningEfforts', 'defaultReasoningEffort', 'canDisableThinking', 'description',
] as const

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

test('diff the live workbuddy catalog against the shipped table', async () => {
  const pool = new WorkBuddyAccountPool()
  const data = await pool.read()
  const seen = new Set<WorkBuddyRegion>()
  const report: Record<string, string[]> = {}
  const liveAll: Record<string, unknown[]> = {}

  for (const account of data.accounts) {
    let credentials = account.credentials
    if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60_000) {
      credentials = await refreshCredentials(credentials, { fetchFn }).catch(() => credentials)
    }
    if (seen.has(credentials.region)) continue
    seen.add(credentials.region)
    clearCachedCatalog()
    const models = await loadConfigCatalog(credentials, { fetchFn, force: true })
    liveAll[credentials.region] = models

    const rows: string[] = []
    for (const model of models) {
      const shipped = FALLBACK_MODELS.find((entry) => entry.id === model.id)
      if (shipped === undefined) {
        rows.push(`+ ${model.id} (not shipped) regions=${model.regions.join('/')}`)
        continue
      }
      const diffs = FIELDS
        .filter((field) => JSON.stringify(shipped[field]) !== JSON.stringify(model[field]))
        .map((field) => `${field}: shipped=${JSON.stringify(shipped[field])} live=${JSON.stringify(model[field])}`)
      const shippedRegions = shipped.regions.join('/')
      if (diffs.length > 0 || shippedRegions !== model.regions.join('/')) {
        rows.push(`~ ${model.id} [shipped regions: ${shippedRegions}]` + (diffs.length ? `\n    ${diffs.join('\n    ')}` : ''))
      }
    }
    const gone = FALLBACK_MODELS.filter((entry) =>
      entry.regions.includes(credentials.region) && !models.some((m) => m.id === entry.id))
    for (const entry of gone) rows.push(`- ${entry.id} (shipped for ${credentials.region}, no longer served)`)
    const offered = modelsForRegion(credentials.region, models).length
    rows.unshift(`offered to ${credentials.region}: ${offered} models`)
    report[credentials.region] = rows
  }

  const dir = path.join(os.tmpdir(), 'dsh-workbuddy-catalog')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'live.json'), JSON.stringify(liveAll, null, 2), 'utf8')
  console.log(Object.entries(report)
    .map(([region, rows]) => `===== ${region} =====\n${rows.join('\n')}`)
    .join('\n\n'))
  proxy.dispose()
})
