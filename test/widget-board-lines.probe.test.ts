/**
 * The end-to-end probe for shape C, against a RUNNING host.
 *
 * Skipped by default: it needs this plugin loaded in a host that answers on
 * loopback, and the whole suite must stay free of network and credentials.
 * Run it with:
 *
 *   LINE_CARD_PROBE=1 npx vitest run test/widget-board-lines.probe.test.ts
 *
 * It reads the real card for every line through the same registry the board
 * uses, prints one row per line (windows, credits, accounts, error) and asserts
 * only the invariants that must hold against ANY host state — a line that is
 * signed out or upstream-broken is a legitimate answer, a throw is not.
 *
 * WHAT IT CANNOT SHOW: the ACCOUNT half. This suite's setup file points DSH_HOME
 * at a private temp directory, so every pool reads an empty document here and
 * each row reports `pool=0`. That isolation is deliberate (it is what keeps a
 * test run from touching real credentials), so the live account half was
 * verified outside vitest, with the same registry and the real pools:
 *
 *   node --experimental-transform-types <probe>.mts
 *
 * which reported the real rows for all eleven lines (1-2 accounts each, active
 * account and strategy included). The same standalone run is what printed the
 * per-account `windows` lists this file cannot see: MiniMax Code answered two
 * accounts, each with its own 5-hour + weekly pair and its own numbers. The account mapping itself is covered here by
 * `widget-board-lines.test.ts`, whose pool fixtures are real captured rows.
 */
import { describe, expect, it } from 'vitest'
import { CodexAccountPool } from '../src/host/codex-account-pool.ts'
import { createPlatformTokenStore } from '../src/host/platform-token-store.ts'
import { LINE_DEFINITIONS, createLineRegistry, type LineAccountSource } from '../src/host/widget-board/line-registry.ts'
import type { LineCardData } from '../src/host/widget-board/line-contracts.ts'

const ENABLED = process.env.LINE_CARD_PROBE === '1'
const ORIGIN = process.env.LINE_CARD_ORIGIN ?? 'http://127.0.0.1:3080'

/**
 * The pool mapping, as far as a probe can build it.
 *
 * Only the ChatGPT pool is constructible here: it is the one whose store this
 * package owns without a signed-in credential for another line. The other ten
 * lines are read through their STATUS routes, which is the quota half; their
 * account half is covered by the unit tests' fake pools.
 */
function probePools(): Readonly<Record<string, LineAccountSource | undefined>> {
  try {
    return { codex: new CodexAccountPool({ store: createPlatformTokenStore() }) }
  } catch {
    return {}
  }
}

/**
 * One card as a table row.
 *
 * @param card - Shape C.
 * @returns The row.
 */
function row(card: LineCardData): string {
  const windows = card.quota === null
    ? 'quota=null'
    : card.quota.windows.length === 0
      ? 'quota.windows=[]'
      : card.quota.windows
        .map((window) => window.label + ' ' + window.usedPercent.toFixed(1) + '%/' + (window.windowMinutes ?? '?') + 'm')
        .join(', ')
  const credits = card.quota?.credits === null || card.quota?.credits === undefined
    ? '-'
    : (card.quota.credits.unlimited ? 'unlimited' : card.quota.credits.balance ?? 'null')
  // How many windows each account row states, in row order. '-' means the row
  // omits the key, which is the honest answer for a line with no per-account hook.
  const accountWindows = card.accounts
    .map((account) => ('windows' in account ? String((account.windows ?? []).length) : '-'))
    .join('/')
  return [
    card.line.padEnd(16),
    'signedIn=' + String(card.signedIn).padEnd(5),
    'plan=' + String(card.planLabel ?? '-').padEnd(18),
    'acct=' + String(card.accountLabel ?? '-').padEnd(22),
    'pool=' + String(card.accounts.length) + '/' + String(card.activeAccountId ?? '-').padEnd(18),
    'acctWindows=' + accountWindows.padEnd(5),
    'credits=' + String(credits).padEnd(10),
    windows,
    card.error === null ? '' : 'ERROR ' + card.error,
  ].join(' ')
}

describe.skipIf(!ENABLED)('line card probe (live host)', () => {
  it('reads every line through the registry', async () => {
    const registry = createLineRegistry({ origin: () => ORIGIN, pools: probePools() })
    const cards: LineCardData[] = []
    for (const definition of LINE_DEFINITIONS) {
      cards.push(await registry.read(definition.id))
    }
    const rows = cards.map(row)
    // Printed as one block so the run output can be pasted into a report.
    console.log('\n' + ['line             | the rest', ...rows].join('\n'))
    expect(cards).toHaveLength(LINE_DEFINITIONS.length)
    for (const card of cards) {
      expect(card.line.length).toBeGreaterThan(0)
      expect(card.label.length).toBeGreaterThan(0)
      // A card always carries a decision, never a throw: an error is allowed,
      // a missing strategy or a non-array account list is not.
      expect(['sequential', 'round-robin', 'sticky']).toContain(card.strategy)
      expect(Array.isArray(card.accounts)).toBe(true)
      if (card.quota !== null) expect(Array.isArray(card.quota.windows)).toBe(true)
      // A row that states a window list states an ARRAY — never a placeholder.
      for (const account of card.accounts) {
        if (!('windows' in account)) continue
        expect(Array.isArray(account.windows)).toBe(true)
      }
    }
  })
})
