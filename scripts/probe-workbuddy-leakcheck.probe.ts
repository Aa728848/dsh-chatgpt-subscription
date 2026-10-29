/**
 * WS-6 companion: scan every WS-6 artifact for a credential, using the
 * credentials DECRYPTED by the plugin's own token store (the on-disk pool file
 * is encrypted, so a raw regex over it finds nothing and proves nothing).
 *
 * Zero requests. Run after the other probes:
 *   npx vitest run --config vitest.probe.config.ts scripts/probe-workbuddy-leakcheck.probe.ts
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { test } from 'vitest'
import { WorkBuddyAccountPool } from '../src/host/workbuddy/account-pool.ts'

test('no pooled credential appears in any WS-6 artifact', async () => {
  const pool = new WorkBuddyAccountPool()
  const data = await pool.read()
  const values: string[] = []
  for (const account of data.accounts as any[]) {
    const c = account?.credentials
    if (typeof c?.accessToken === 'string' && c.accessToken.length > 8) values.push(c.accessToken)
    if (typeof c?.refreshToken === 'string' && c.refreshToken.length > 8) values.push(c.refreshToken)
    if (typeof c?.cookie === 'string' && c.cookie.length > 8) values.push(c.cookie)
  }
  console.log('[leak] decrypted credentials under test: ' + values.length)

  const dir = os.tmpdir()
  const names = (await readdir(dir)).filter((name) => name.startsWith('ws6-'))
  let scanned = 0
  let leaks = 0
  for (const name of names) {
    const text = await readFile(path.join(dir, name), 'utf8')
    scanned += 1
    for (const value of values) {
      if (text.includes(value)) {
        leaks += 1
        console.error('[leak] LEAK: a credential appears in ' + name)
      }
    }
    console.log('[leak] ' + name + ' (' + Buffer.byteLength(text) + ' bytes) clean')
  }
  console.log('[leak] RESULT artifacts=' + scanned + ' credentials=' + values.length + ' leaks=' + leaks)
  if (leaks > 0 || values.length === 0 || scanned === 0) throw new Error('leakcheck did not pass cleanly')
}, 120_000)
