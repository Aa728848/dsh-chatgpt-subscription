/**
 * Outbound client identities this route can present.
 *
 * The subscription gateway gates on client identity, and it gates DIFFERENTLY
 * per surface: measured on this route, `CodeBuddyIDE` is rejected by
 * `/v3/config` with 400 `code 12403` ("check ua") and 401'd outright by the
 * international chat endpoint, which is why the CLI identity is what the line
 * ships and has always used.
 *
 * Two more identities exist on the same backend, and workbuddy2api-hub has
 * captured what the real clients send (their `wb_identity.py`, measured
 * 2026-10-16 with mitmproxy against the international desktop build 5.8.4):
 *
 *   desktop   `WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`
 *             + `X-IDE-Type/Name: WorkBuddy`, `X-IDE-Version`, `X-Agent-Intent: craft`
 *             + `X-Agent-Purpose: conversation`, `X-Agent-Type: main`, trace headers
 *   vscode    `VSCode/1.119.0 WorkBuddy/4.9.29177644`
 *             + `X-IDE-Type/Name: VSCode`, `X-IDE-Version`, `X-Product-Version`, `X-Env-ID`
 *   cli       `CLI/<v> CodeBuddy/<v>` + `X-IDE-Type/Name: CLI`
 *
 * `cli` is deliberately kept byte-identical to what this line sends today
 * (including the `CodeBuddyIDE` IDE name, which is what was actually measured
 * to work here) so the default cannot regress; the other two are opt-in
 * attempts.
 *
 * Quota is NOT per identity: the subscription meters an account × model over a
 * 24h window (429 `code 6004`), so switching identity cannot create allowance.
 * What it can do is give each account a stable, plausible client — the same
 * reason the gateway projects one device per account.
 */

import { createHash } from 'node:crypto'
import type {
  WorkBuddyOutboundProduct,
  WorkBuddyOutboundSetting,
} from '../../shared/workbuddy-contracts.ts'

export type { WorkBuddyOutboundProduct, WorkBuddyOutboundSetting }

/** Everything the settings card may offer, in display order. */
export const OUTBOUND_PRODUCTS: readonly WorkBuddyOutboundProduct[] = ['cli', 'workbuddy', 'vscode']

/** Shipped default: the identity this line already ships and measured working. */
export const DEFAULT_OUTBOUND_SETTING: WorkBuddyOutboundSetting = 'cli'

/** Narrow a stored or patched value into a supported preference. */
export function normalizeOutboundSetting(value: unknown): WorkBuddyOutboundSetting {
  if (value === 'auto') return 'auto'
  return typeof value === 'string' && (OUTBOUND_PRODUCTS as readonly string[]).includes(value)
    ? value as WorkBuddyOutboundProduct
    : DEFAULT_OUTBOUND_SETTING
}

/**
 * Which identity one account uses.
 *
 * `auto` assigns by hashing the account key, so an account keeps the same
 * client for its whole life — the one property that matters for a device
 * fingerprint — while a pool as a whole spreads over the available clients.
 */
export function resolveOutboundProduct(
  setting: WorkBuddyOutboundSetting,
  accountKey: string,
): WorkBuddyOutboundProduct {
  if (setting !== 'auto') return setting
  const digest = createHash('sha256').update(accountKey).digest()
  const pick = (digest[0] ?? 0) % OUTBOUND_PRODUCTS.length
  return OUTBOUND_PRODUCTS[pick]!
}

// Versions as captured by the sibling gateway. They are constants rather than
// discoveries: the upstream gates on their PRESENCE and plausibility, and a
// stale one is what eventually gets refused.
const DESKTOP_VERSION_INTL = '5.8.4'
const DESKTOP_VERSION_CN = '5.5.6'
const DESKTOP_UA_INTL = `WorkBuddy/${DESKTOP_VERSION_INTL} workbuddy-ai/${DESKTOP_VERSION_INTL} CLI/2.161.0`
const DESKTOP_UA_CN = `WorkBuddy/${DESKTOP_VERSION_CN} WorkBuddy/${DESKTOP_VERSION_CN} CLI/2.137.1`
const VSCODE_IDE_VERSION = '1.119.0'
const VSCODE_PRODUCT_VERSION = '4.9.29177644'
const VSCODE_UA = `VSCode/${VSCODE_IDE_VERSION} WorkBuddy/${VSCODE_PRODUCT_VERSION}`

/**
 * The CLI identity this line has always presented.
 *
 * Kept as a literal rather than rebuilt, because it is the one string measured
 * to be accepted by chat, `/v3/config` and billing on both regions.
 */
const CLI_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * A stable pseudo-device id for one account.
 *
 * Same derivation as the measured clients (`derive_id`: md5 of `salt:uid`
 * reshaped into a UUID), so the value is a well-formed v4-shaped machine id
 * that never changes for an account and never collides between accounts. A
 * per-PROCESS id would be worse than none here: it would present every account
 * in the pool as the same machine.
 */
export function deriveMachineId(uid: string): string {
  const digest = createHash('md5').update(`machine:${uid.trim() === '' ? 'anonymous' : uid}`).digest('hex')
  const shaped = `${digest.slice(0, 12)}4${digest.slice(13, 16)}a${digest.slice(17)}`
  return [shaped.slice(0, 8), shaped.slice(8, 12), shaped.slice(12, 16), shaped.slice(16, 20), shaped.slice(20, 32)].join('-')
}

function hexId(): string {
  return createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 32)
}

/** One conversation request's trace chain, as the desktop client emits it. */
function traceHeaders(): Record<string, string> {
  const trace = hexId()
  const span = hexId().slice(0, 16)
  return {
    'X-Trace-ID': trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    'X-B3-TraceId': trace,
    'X-B3-SpanId': span,
    'X-B3-Sampled': '1',
  }
}

/** Identity-specific headers and user agent for one request. */
export interface OutboundIdentity {
  product: WorkBuddyOutboundProduct
  userAgent: string
  /** Extra or overriding headers; `conversation` supplies the ids already minted. */
  headers(conversation: Readonly<Record<string, string>>): Record<string, string>
}

/** Resolve the identity block for one product on one region. */
export function outboundIdentity(
  product: WorkBuddyOutboundProduct,
  region: 'cn' | 'intl',
  uid: string,
): OutboundIdentity {
  if (product === 'workbuddy') {
    const version = region === 'cn' ? DESKTOP_VERSION_CN : DESKTOP_VERSION_INTL
    return {
      product,
      userAgent: region === 'cn' ? DESKTOP_UA_CN : DESKTOP_UA_INTL,
      headers: (conversation) => ({
        'X-Agent-Intent': 'craft',
        'X-Agent-Purpose': 'conversation',
        'X-Agent-Type': 'main',
        'X-IDE-Name': 'WorkBuddy',
        'X-IDE-Type': 'WorkBuddy',
        'X-IDE-Version': version,
        'X-Private-Data': 'true',
        'X-Machine-ID': deriveMachineId(uid),
        // The desktop client sends the root request id alongside the
        // conversation request id; both name the same user send.
        ...(conversation['X-Conversation-Request-ID'] === undefined
          ? {}
          : { 'X-Root-Request-ID': conversation['X-Conversation-Request-ID']! }),
        ...traceHeaders(),
      }),
    }
  }
  if (product === 'vscode') {
    return {
      product,
      userAgent: VSCODE_UA,
      headers: (conversation) => ({
        'X-Agent-Intent': 'craft',
        'X-IDE-Name': 'VSCode',
        'X-IDE-Type': 'VSCode',
        'X-IDE-Version': VSCODE_IDE_VERSION,
        'X-Product-Version': VSCODE_PRODUCT_VERSION,
        'X-Env-ID': 'production',
        'X-Machine-ID': deriveMachineId(uid),
        ...(conversation['X-Conversation-Request-ID'] === undefined
          ? {}
          : { 'X-Root-Request-ID': conversation['X-Conversation-Request-ID']! }),
      }),
    }
  }
  // cli: no overrides. This is byte-for-byte what the line sends today.
  return { product: 'cli', userAgent: CLI_UA, headers: () => ({}) }
}
