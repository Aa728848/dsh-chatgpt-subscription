/**
 * Shape C: everything ONE card needs about ONE subscription line.
 *
 * A card is identified by \`props.line\`, so the whole answer is produced per
 * line: the line's own quota windows, plus the account rows of that line's
 * pool. The two halves come from different authorities and are merged here:
 *
 *  - the account half reads this plugin's own pool objects through ONE generic
 *    adapter (every line's pool speaks \`listAccounts\` / \`setPrimary\` /
 *    \`setStrategy\`), never over HTTP;
 *  - the quota half reads the line's OWN \`/status\` route over loopback HTTP,
 *    because each line already normalizes its upstream payload into its own
 *    DTO and duplicating those readers here would be a second implementation
 *    of the same thing, free to drift.
 *
 * The mix is deliberate: an account list is a local document read (no upstream
 * call, no credential needed), while a quota answer travels through the line's
 * route, which owns its cache, its refresh flight and its error reporting.
 *
 * Two conventions this file fixes once, because a card must not have to know:
 *
 *  - EVERY instant here is Unix MILLISECONDS. The lines disagree on the wire
 *    (codex states seconds, antigravity and cline-pass state ISO strings,
 *    kimi/minimax/qoder/glm/step state milliseconds); the normalizers convert,
 *    so a card never guesses a unit from a magnitude.
 *  - \`null\` means "nobody measured this", and is never 0. A window that was
 *    never read, a plan nobody named, a balance that could not be fetched —
 *    all null, all rendered as a placeholder rather than as a zero.
 */
import type { AccountAuthStatus, AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'

/**
 * Provider name this plugin registers under: the BARE package id, without the
 * `@eddyskywalker/` scope.
 *
 * A manifest names a data source or a capability as `<provider>:<id>`, and that
 * whole string has to match the board's id regular expression
 * `^[a-z][a-z0-9.-]{1,39}(?::[a-z][a-z0-9.-]{1,39})?$` — which accepts neither
 * `@` nor `/`. A scoped provider name would therefore be registrable on the host
 * and unreachable from every manifest, so the registration and the manifests
 * must agree on this literal.
 */
export const WIDGET_BOARD_PROVIDER = 'dsh-chatgpt-subscription'

/**
 * The name a widget manifest writes to reach one of this provider's
 * registrations, e.g. `dsh-chatgpt-subscription:line-card`.
 *
 * @param id - One of the four registration ids below.
 * @returns The `<provider>:<id>` spelling, which is the only one the board resolves.
 */
export function widgetFullName(id: string): string {
  return WIDGET_BOARD_PROVIDER + ':' + id
}

/** Data source: shape C for the line named by \`props.line\`. */
export const LINE_CARD_DATA_SOURCE_ID = 'line-card'
/** Capability: refresh one line's quota, then answer shape C. */
export const LINE_REFRESH_CAPABILITY_ID = 'line-refresh'
/** Capability: pin one pooled account of one line, then answer shape C. */
export const LINE_ACCOUNT_SWITCH_CAPABILITY_ID = 'line-account-switch'
/** Capability: change one line's rotation strategy, then answer shape C. */
export const LINE_ACCOUNT_STRATEGY_CAPABILITY_ID = 'line-account-strategy'

/** One quota window of a line, already normalized for the card. */
export interface LineCardWindow {
  /**
   * Display name, e.g. \`5 小时\`.
   *
   * Filled by the line's normalizer whenever the source states it or the
   * window's nominal length makes it inferable; empty when nobody said, in
   * which case the card falls back to its own wording.
   */
  label: string
  /** Share of the window consumed, clamped to 0-100. */
  usedPercent: number
  /** Nominal window length in minutes, when the source stated one. */
  windowMinutes: number | null
  /** Unix MILLISECONDS the window reopens, when the source stated one. */
  resetsAt: number | null
}

/** Credit balance a line reports beside its windows. */
export interface LineCardCredits {
  unlimited: boolean
  /**
   * Balance as the line strings it, unit included when the line has one
   * (\`"10.00"\` for provider credits, \`"12.34 USD"\` for a wallet).
   *
   * A string rather than a number on purpose: the units differ per line and a
   * single numeric field would silently invite arithmetic across them.
   */
  balance: string | null
}

/** Reset credits available to reopen a spent window. */
export interface LineCardResetCredits {
  available: number
  /** Unix MILLISECONDS the earliest credit expires, when stated. */
  expiresAt: number | null
}

/**
 * One line's quota.
 *
 * \`null\` on the card means "this line answered nothing usable" — which is a
 * different statement from "this line has no windows", and the reason the whole
 * object is nullable rather than an empty one.
 */
export interface LineCardQuota {
  windows: LineCardWindow[]
  credits: LineCardCredits | null
  resetCredits: LineCardResetCredits | null
  /** Unix MILLISECONDS the snapshot was taken, when the line stated one. */
  fetchedAt: number | null
  /** Whether THIS line's own refresh is running behind the answer. */
  refreshing: boolean
  /** Why these numbers are missing or old, when the line said so. */
  error: string | null
}

/** One pooled account of this line, as the card renders it. */
export interface LineCardAccount {
  id: string
  /** Alias when one is set, then the email, then the id. Never blank. */
  label: string
  email: string | null
  primary: boolean
  /** Plan label the account's own credential states, when it states one. */
  plan: string | null
  /** Unix MILLISECONDS a 429 cooldown lifts, when one is running. */
  cooldownUntil: number | null
  authStatus: AccountAuthStatus | null
  /**
   * Share of THIS account's own newest snapshot, shortest window.
   *
   * Absent together with \`resetsAt\` when the account was never read — a
   * different statement from "nothing used".
   */
  usedPercent: number | null
  resetsAt: number | null
  /**
   * Every window THIS account's own reading stated, shortest first.
   *
   * ABSENT, not empty, on a line with no per-account quota hook: there is
   * nothing per-account to say there, and an empty list would claim "we asked
   * this account and it has no windows". `[]` on a hooked line means exactly
   * that — the read was made and measured nothing — which is why the list is
   * never padded with a 0 % placeholder to look like data.
   *
   * It sits BESIDE `usedPercent` rather than replacing it: that field stays the
   * headline (shortest) window's share, which the card's back face draws as one
   * small bar, while this list is what the account's own detail view opens up.
   */
  windows?: LineCardWindow[]
}

/** Shape C: what \`line-card\` and the three line capabilities answer. */
export interface LineCardData {
  /** Line id this card reads, e.g. \`codex\`. */
  line: string
  /** Display name of the line, e.g. \`ChatGPT\`. */
  label: string
  /** Whether the line holds any credential that could serve a request. */
  signedIn: boolean
  /** Whether this plugin's pool for the line is installed at all. */
  installed: boolean
  /** Plan the line is metered on (e.g. \`free\`), when stated. */
  planLabel: string | null
  /** Signed-in account label, when known. */
  accountLabel: string | null
  /** Accounts in this line's pool; empty when it has none. */
  accounts: LineCardAccount[]
  activeAccountId: string | null
  strategy: AccountRotationStrategy
  quota: LineCardQuota | null
  /**
   * Why this card cannot show its numbers: the line's interface is
   * unreachable, OR the line reached its upstream and reported a failure.
   *
   * Both cases leave the card with nothing to draw, and both need the same
   * thing from the user (a reason), so they share one field instead of one of
   * them being dropped — a \`quota: null\` alone would say "no data" and lose the
   * sentence that explains it.
   */
  error: string | null
}

/**
 * One normalized quota window, as `quota.windows` and `accounts[].windows` both
 * state it.
 *
 * Declared once and referenced twice on purpose: the card draws both lists with
 * the same code, so a field added to one must not leave the other rejecting it.
 */
const LINE_CARD_WINDOW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'usedPercent', 'windowMinutes', 'resetsAt'],
  properties: {
    label: { type: 'string' },
    usedPercent: { type: 'number', minimum: 0, maximum: 100 },
    windowMinutes: { type: ['number', 'null'] },
    resetsAt: { type: ['number', 'null'] },
  },
}

/** A list of those windows. */
const LINE_CARD_WINDOWS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  items: LINE_CARD_WINDOW_SCHEMA,
}

/**
 * The JSON Schema a capability's return value is validated against.
 *
 * Capability outputs only, like the two older shapes: the DATA SOURCE's answer
 * is validated against the \`data\` schema of the card that reads it, which
 * lives in \`widgets/<id>/widget.json\` and is therefore a second declaration of
 * this shape (kept aligned by a test that compares their key sets literally).
 */
export const LINE_CARD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'line', 'label', 'signedIn', 'installed', 'planLabel', 'accountLabel',
    'accounts', 'activeAccountId', 'strategy', 'quota', 'error',
  ],
  properties: {
    line: { type: 'string', minLength: 1 },
    label: { type: 'string' },
    signedIn: { type: 'boolean' },
    installed: { type: 'boolean' },
    planLabel: { type: ['string', 'null'] },
    accountLabel: { type: ['string', 'null'] },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'label', 'email', 'primary', 'plan',
          'cooldownUntil', 'authStatus', 'usedPercent', 'resetsAt',
        ],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          email: { type: ['string', 'null'] },
          primary: { type: 'boolean' },
          plan: { type: ['string', 'null'] },
          cooldownUntil: { type: ['number', 'null'] },
          authStatus: { enum: ['ok', 'expired', 'invalid', null] },
          usedPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
          resetsAt: { type: ['number', 'null'] },
          // Optional, and NOT in this item's `required`: a line with no
          // per-account hook omits it entirely, so requiring it would reject the
          // nine lines that never opted in.
          windows: LINE_CARD_WINDOWS_SCHEMA,
        },
      },
    },
    activeAccountId: { type: ['string', 'null'] },
    strategy: { enum: ['sequential', 'round-robin', 'sticky'] },
    quota: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['windows', 'credits', 'resetCredits', 'fetchedAt', 'refreshing', 'error'],
          properties: {
            windows: LINE_CARD_WINDOWS_SCHEMA,
            credits: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['unlimited', 'balance'],
                  properties: {
                    unlimited: { type: 'boolean' },
                    balance: { type: ['string', 'null'] },
                  },
                },
                { type: 'null' },
              ],
            },
            resetCredits: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['available', 'expiresAt'],
                  properties: {
                    available: { type: 'integer', minimum: 0 },
                    expiresAt: { type: ['number', 'null'] },
                  },
                },
                { type: 'null' },
              ],
            },
            fetchedAt: { type: ['number', 'null'] },
            refreshing: { type: 'boolean' },
            error: { type: ['string', 'null'] },
          },
        },
        { type: 'null' },
      ],
    },
    error: { type: ['string', 'null'] },
  },
}

/** The \`line\` argument every line capability takes. */
const LINE_ARGUMENT_PROPERTIES: Record<string, unknown> = {
  line: { type: 'string', minLength: 1 },
}

/** Arguments of the quota-refresh capability. */
export const LINE_REFRESH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['line'],
  properties: LINE_ARGUMENT_PROPERTIES,
}

/** Arguments of the account-switch capability. */
export const LINE_ACCOUNT_SWITCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'accountId'],
  properties: {
    ...LINE_ARGUMENT_PROPERTIES,
    accountId: { type: 'string', minLength: 1 },
  },
}

/** Arguments of the account-strategy capability. */
export const LINE_ACCOUNT_STRATEGY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'strategy'],
  properties: {
    ...LINE_ARGUMENT_PROPERTIES,
    strategy: { enum: ['sequential', 'round-robin', 'sticky'] },
  },
}
