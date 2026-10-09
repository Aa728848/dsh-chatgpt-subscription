/**
 * One-shot probe: the model list the settings picker renders for an account,
 * in the order it renders it.
 *
 * Reads the live catalog the way the card does, then prints the offered rows
 * with their vendor, because the ordering is the thing worth eyeballing:
 * whether a family's models sit together and whether the gateway's own ranking
 * survived inside each family.
 *
 * Run: npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-picker.probe.ts
 */
import { test } from 'vitest'
import { ProxyManager } from '../src/host/proxy-manager.ts'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'
import { clearCachedCatalog, loadConfigCatalog } from '../src/host/workbuddy/client.ts'
import { FALLBACK_MODELS, modelsForRegion, workBuddyModelVendor } from '../src/host/workbuddy/model-catalog.ts'

const proxy = new ProxyManager({ getPreferences: () => ({ proxyMode: 'auto', customProxyUrl: null }) })
const fetchFn = proxy.createFetch()

test('print the picker order for each region', async () => {
  const pool = new WorkBuddyAccountPool()
  const data = await pool.read()
  const seen = new Set<string>()
  for (const account of data.accounts) {
    const region = account.credentials.region
    if (seen.has(region)) continue
    seen.add(region)
    clearCachedCatalog()
    let live = []
    try {
      live = await loadConfigCatalog(account.credentials, { fetchFn, force: true })
    } catch {
      live = []
    }
    // Same fallback the card applies when the gateway cannot be reached.
    const catalog = live.length > 0 ? live : FALLBACK_MODELS
    const source = live.length > 0 ? 'live /v3/config' : 'shipped fallback'
    const offered = modelsForRegion(region, catalog)
    console.log(`\n===== ${region} (${offered.length}, from ${source}) =====`)
    for (const model of offered) {
      console.log(`${workBuddyModelVendor(model.id).padEnd(12)} ${model.id.padEnd(24)} ${model.contextWindow}`)
    }
  }
  proxy.dispose()
})
