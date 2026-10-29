/**
 * Outbound client identities this route can present.
 *
 * The subscription gateway gates on client identity, and it gates DIFFERENTLY
 * per surface: measured on this route, `CodeBuddyIDE` is rejected by
 * `/v3/config` with 400 `code 12403` ("check ua") and 401'd outright by the
 * international chat endpoint, which is why the CLI identity is what the line
 * ships and has always used.
 *
 * Two more identities exist on the same backend. Both were captured by sibling
 * gateways that reverse-engineered the real clients' requests; this file's
 * version block below names the exact source of every string it sends.
 *
 *   desktop   `WorkBuddy/<app> <appName>/<app> CLI/<cli>`, where `<app>` is
 *             the desktop build, `<appName>` is `WorkBuddy` (domestic) or
 *             `workbuddy-ai` (international) and `<cli>` is the CLI bundled
 *             inside that build
 *             + `X-IDE-Type/Name: WorkBuddy`, `X-IDE-Version`, `X-Agent-Intent: craft`
 *             + `X-Agent-Purpose: conversation`, `X-Agent-Type: main`,
 *             + `X-Agent-Runtime: local-agent` (the 5.9 client names where the
 *               agent runs; the header is absent in 5.8), trace headers
 *   vscode    `VSCode/<ide> WorkBuddy/<product>`
 *             + `X-IDE-Type/Name: VSCode`, `X-IDE-Version`, `X-Product-Version`, `X-Env-ID`
 *   cli       `CLI/2.63.2 CodeBuddy/2.63.2` + no overrides
 *
 * The `cli` literal is kept byte-identical to what this line has always sent,
 * but it is NO LONGER the default: upstream now refuses any agent that is not a
 * `WorkBuddy/<version>` one with error 10085, which is exactly what a bare
 * `CLI/...` agent is. `DEFAULT_OUTBOUND_SETTING` therefore names `workbuddy`,
 * and {@link migrateOutboundSettingDocument} moves a stored pre-marker document
 * across without overriding a choice the user has since made.
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

/**
 * Shipped default: the desktop identity.
 *
 * It used to be `cli`, because that literal is what this line measured working
 * first. That is no longer true — upstream refuses any agent that is not a
 * `WorkBuddy/<version>` one with error 10085, and a bare `CLI/...` agent is
 * exactly such a request (see the version block below, which cites the source
 * of both facts). The desktop identity is the shipped one because it is the
 * identity that presents a `WorkBuddy/<version>` agent.
 *
 * A document written while `cli` was the default is moved across ONCE by
 * {@link migrateOutboundSettingDocument}; a choice made after that is never
 * revisited.
 */
export const DEFAULT_OUTBOUND_SETTING: WorkBuddyOutboundProduct = 'workbuddy'

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

/**
 * Version numbers each build's own client presents.
 *
 * Every value below is transcribed, not guessed, from
 * `magpie-community/plugins` @ `1e7122e1`, `packages/workbuddy/index.mjs`:
 *
 *   L63-87    the domestic site: `app: "5.9.3"`, `cli: "2.165.0"`,
 *             `appName: "WorkBuddy"`, `runtime: "local-agent"` — read from
 *             build 5.9.3.42398134, the update feed's current build on 2026-10-28
 *   L88-109   the international site: the same `app`/`cli`, `appName:
 *             "workbuddy-ai"` — build 5.9.3.42398134 on 2026-10-29
 *   L344-351  `cliAgent(site)` = `WorkBuddy/<app> <appName>/<app> CLI/<cli>`
 *   L8-9      "a request whose User-Agent isn't WorkBuddy/<version> is refused
 *             (error 10085)"
 *   L353-380  `chatHeaders`: `X-Agent-Type`, `X-Agent-Runtime` and the OpenAI
 *             SDK's own `X-Stainless-*` fingerprint headers (SDK 6.25.0, Node
 *             v22.21.1, no retries, 1200s timeout)
 *   L358-359  the SDK's OS/arch spellings
 *
 * The VSCode identity's two numbers come from the other reference,
 * `ardeyouxipianyi/workbuddy2api-hub` @ `1ea7f61e`, `wb_identity.py`:
 * `VSCODE_IDE_VERSION = "1.119.0"` and
 * `VSCODE_PRODUCT_VERSION = "4.12.39997873"` (measured as the SaaS extension's
 * `productVersion`). That file agrees on the header family and on the v4-shaped
 * `X-Conversation-ID`, but its DESKTOP constants (5.8.4 / 5.8.3) and its CLI
 * constant (2.168.2) describe older or different builds, so the magpie values
 * are the ones this file follows for the desktop and CLI identities.
 *
 * These are constants rather than discoveries because the upstream gates on
 * their PRESENCE and plausibility: a stale one is what eventually gets refused.
 */
const DESKTOP_VERSION = '5.9.3'
/** The CLI bundled inside that desktop build (`@genie/agent-cli`'s version). */
const DESKTOP_CLI_VERSION = '2.165.0'
const DESKTOP_APP_NAME_CN = 'WorkBuddy'
const DESKTOP_APP_NAME_INTL = 'workbuddy-ai'
const DESKTOP_UA_CN = `WorkBuddy/${DESKTOP_VERSION} ${DESKTOP_APP_NAME_CN}/${DESKTOP_VERSION} CLI/${DESKTOP_CLI_VERSION}`
const DESKTOP_UA_INTL = `WorkBuddy/${DESKTOP_VERSION} ${DESKTOP_APP_NAME_INTL}/${DESKTOP_VERSION} CLI/${DESKTOP_CLI_VERSION}`
/** Where the 5.9 desktop client says its agent runs (absent from 5.8). */
const DESKTOP_AGENT_RUNTIME = 'local-agent'
/**
 * VSCode extension build numbers.
 *
 * Source: `ardeyouxipianyi/workbuddy2api-hub` @ `1ea7f61e`, `wb_identity.py`
 * (`VSCODE_IDE_VERSION` / `VSCODE_PRODUCT_VERSION`). The IDE half is the host
 * editor's own version, which the extension reads at run time; `1.119.0` is the
 * captured default.
 */
const VSCODE_IDE_VERSION = '1.119.0'
const VSCODE_PRODUCT_VERSION = '4.12.39997873'
const VSCODE_UA = `VSCode/${VSCODE_IDE_VERSION} WorkBuddy/${VSCODE_PRODUCT_VERSION}`

/** The OpenAI SDK build the desktop CLI's chats go out through (L356-357). */
const DESKTOP_OPENAI_SDK_VERSION = '6.25.0'
/** The Node build that SDK runs on inside the desktop's Electron (L357). */
const DESKTOP_NODE_VERSION = 'v22.21.1'
/** SDK OS/arch spellings, transcribed from L358-359. */
const SDK_OS: Readonly<Record<string, string>> = {
  darwin: 'MacOS',
  win32: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  android: 'Android',
}
const SDK_ARCH: Readonly<Record<string, string>> = {
  x64: 'x64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: 'x32',
  x32: 'x32',
}

/**
 * The CLI identity this line has always presented.
 *
 * Kept as a literal rather than rebuilt. It is NOT the default any more: a bare
 * `CLI/...` agent is one upstream now refuses with 10085 (see the version
 * block), so it is only reachable by a deployment that pins `cli` on purpose.
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
    const version = DESKTOP_VERSION
    return {
      product,
      userAgent: region === 'cn' ? DESKTOP_UA_CN : DESKTOP_UA_INTL,
      headers: (conversation) => ({
        'X-Agent-Intent': 'craft',
        'X-Agent-Purpose': 'conversation',
        'X-Agent-Type': 'main',
        // The 5.9 client's own answer to "where does this agent run"; absent
        // from 5.8, which is why it is a constant here and not a guess.
        'X-Agent-Runtime': DESKTOP_AGENT_RUNTIME,
        'X-IDE-Name': 'WorkBuddy',
        'X-IDE-Type': 'WorkBuddy',
        'X-IDE-Version': version,
        'X-Private-Data': 'true',
        'X-Machine-ID': deriveMachineId(uid),
        // The OpenAI SDK's fingerprint, exactly as the bundled CLI's fetch
        // passes it on. Not decoration: an agent that claims the CLI's
        // User-Agent but none of the SDK headers it always sends is the kind
        // of mismatch that gets a build refused.
        'X-Stainless-Lang': 'js',
        'X-Stainless-Package-Version': DESKTOP_OPENAI_SDK_VERSION,
        'X-Stainless-Runtime': 'node',
        'X-Stainless-Runtime-Version': DESKTOP_NODE_VERSION,
        'X-Stainless-Retry-Count': '0',
        'X-Stainless-Timeout': '1200',
        'X-Stainless-OS': SDK_OS[process.platform] ?? `Other:${process.platform}`,
        'X-Stainless-Arch': SDK_ARCH[process.arch] ?? `other:${process.arch}`,
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
  // cli: no overrides. Byte-for-byte the identity this line has always sent,
  // kept as an opt-in escape hatch rather than as the default (see
  // DEFAULT_OUTBOUND_SETTING for why the default moved).
  return { product: 'cli', userAgent: CLI_UA, headers: () => ({}) }
}

/**
 * Version of the outbound-identity semantics one settings document carries.
 *
 * 1 (never written as a number) = the era whose shipped default was `cli`. That
 *   era wrote `cli` into a document as soon as it normalised an unset
 *   preference, so a stored `cli` from it cannot be told apart from "untouched".
 * 2 = the desktop default.
 *
 * A document with no marker is version 1 — that direction is load-bearing. A
 * register-backed scope whose schema defaulted the marker to the CURRENT version
 * would declare every stale document already migrated, which is the same
 * upgrade-breaks-everyone bug reached through the other storage path.
 */
export const OUTBOUND_IDENTITY_VERSION = 2
/** What an absent marker means. Deliberately not the current version. */
export const LEGACY_OUTBOUND_IDENTITY_VERSION = 1

/** One stored preference, as {@link migrateOutboundSettingDocument} reads it. */
export interface OutboundSettingDocument {
  /** The stored preference, in whatever shape the document holds it. */
  outboundIdentity?: unknown
  /** The marker; absent on a pre-marker document. */
  outboundIdentityVersion?: unknown
}

/** What a caller must use, and whether it must write the document back. */
export interface MigratedOutboundSetting {
  /** The identity this host is to present. */
  outboundIdentity: WorkBuddyOutboundSetting
  /** Marker the document carries after this read. */
  outboundIdentityVersion: number
  /** Whether the caller must persist the document (marker and/or new value). */
  migrated: boolean
}

/**
 * Read one stored outbound preference, migrating the pre-marker default once.
 *
 * The rule, and the reason for each half:
 *
 * - `marker >= 2`: this document has been through the migration. Whatever it
 *   holds is a choice now — `cli` included, which a deployment may pin on
 *   purpose — so the value is returned untouched and nothing is written.
 * - no marker and a stored `cli`: the era's default, indistinguishable from a
 *   deliberate one, and a value upstream now refuses (10085). It becomes
 *   {@link DEFAULT_OUTBOUND_SETTING} and the marker is stamped. The stamp is
 *   what makes this idempotent AND what stops a genuine `cli` pinned AFTER the
 *   migration from being flipped on the next read.
 * - no marker and any other value (`auto`/`workbuddy`/`vscode`): a real user
 *   setting, kept as-is; only the marker is stamped, so a later upgrade never
 *   re-decides it.
 *
 * An unparseable stored value normalises to the shipped default, exactly as an
 * absent one does, and is stamped: garbage is not a preference.
 */
export function migrateOutboundSettingDocument(
  document: OutboundSettingDocument,
): MigratedOutboundSetting {
  const raw = document.outboundIdentityVersion
  const version = typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : LEGACY_OUTBOUND_IDENTITY_VERSION
  if (version >= OUTBOUND_IDENTITY_VERSION) {
    return {
      outboundIdentity: normalizeOutboundSetting(document.outboundIdentity),
      outboundIdentityVersion: OUTBOUND_IDENTITY_VERSION,
      migrated: false,
    }
  }
  const stored = normalizeOutboundSetting(document.outboundIdentity)
  // `normalizeOutboundSetting` maps anything unrecognised onto the CURRENT
  // default, so the legacy default has to be named here instead of read from it.
  const outboundIdentity = stored === 'cli' ? DEFAULT_OUTBOUND_SETTING : stored
  return {
    outboundIdentity,
    outboundIdentityVersion: OUTBOUND_IDENTITY_VERSION,
    migrated: true,
  }
}
