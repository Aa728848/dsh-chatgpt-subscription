/**
 * One-shot probe: read the \`credits\` multiplier every model in the live
 * \`/v3/config\` catalog declares, per region, in the exact shape
 * \`FALLBACK_MODELS\` transcribes it.
 *
 * The consumption multiplier is published only on the wire: the shipped
 * fallback table copies it verbatim, and a price change upstream makes that
 * copy stale. This prints the table to transcribe again, plus the two facts the
 * transcription cannot guess — which ids only one region serves, and which ids
 * the two regions rate DIFFERENTLY (measured 2026-10-09:
 * \`deepseek-v4.1-flash\` is 0.11 on cn against 0.00 on intl, so a single scalar
 * per id would be wrong for every account in one of the two regions).
 *
 * Read-only with respect to the repository and the credential files. Prints
 * model ids and their published multipliers — never a credential.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-credits.probe.ts
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { refreshCredentials, workBuddyHeaders } from '../src/host/workbuddy/client.ts'
import { CONFIG_PATH } from '../src/host/workbuddy/types.ts'
import { parseWorkBuddyCreditMultiplier } from '../src/shared/workbuddy-contracts.ts'
import type { WorkBuddyRegion } from '../src/shared/workbuddy-contracts.ts'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

test('read the live workbuddy per-model credit multipliers', async () => {
  const pool = new WorkBuddyAccountPool()
  const data = await pool.read()
  const seen = new Set<WorkBuddyRegion>()
  const byRegion = new Map<WorkBuddyRegion, Map<string, string | null>>()

  for (const account of data.accounts) {
    let credentials = account.credentials
    if (seen.has(credentials.region)) continue
    seen.add(credentials.region)
    if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60_000) {
      credentials = await refreshCredentials(credentials, { fetchFn }).catch(() => credentials)
    }
    const response = await fetchFn(credentials.backend + CONFIG_PATH, { headers: workBuddyHeaders(credentials) })
    const payload = await response.json() as { data?: { models?: Record<string, unknown>[] } }
    const rates = new Map<string, string | null>()
    for (const model of payload.data?.models ?? []) {
      const id = typeof model.id === 'string' ? model.id : null
      if (id === null) continue
      // Image models carry no multiplier; they are not chat models either and
      // \`parseConfigModels\` skips them the same way.
      if (Array.isArray(model.tags) && model.tags.some((tag) => String(tag).includes('image'))) continue
      rates.set(id, parseWorkBuddyCreditMultiplier(model.credits))
    }
    byRegion.set(credentials.region, rates)
    console.log('===== ' + credentials.region + ' (http ' + response.status + ', ' + rates.size + ' models) =====')
    for (const [id, value] of rates) console.log('  ' + id.padEnd(24) + ' ' + JSON.stringify(value))
  }

  const [cn, intl] = [byRegion.get('cn'), byRegion.get('intl')]
  if (cn !== undefined && intl !== undefined) {
    const shared = [...cn.keys()].filter((id) => intl.has(id))
    const split = shared.filter((id) => cn.get(id) !== intl.get(id))
    console.log('===== regions =====')
    console.log('both regions, same rate: ' + (shared.length - split.length) + ' of ' + shared.length)
    console.log('RATED DIFFERENTLY (needs both keys): ' + (split.join(', ') || '(none)'))
    console.log('cn only: ' + [...cn.keys()].filter((id) => !intl.has(id)).join(', '))
    console.log('intl only: ' + [...intl.keys()].filter((id) => !cn.has(id)).join(', '))
    console.log('no rate published: ' + shared.filter((id) => cn.get(id) === null || intl.get(id) === null).join(', '))
  }
  proxy.dispose()
})
