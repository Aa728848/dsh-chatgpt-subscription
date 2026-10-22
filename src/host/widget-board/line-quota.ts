/**
 * One normalizer per subscription line: that line's own `GET /status` payload
 * folded into shape C's `quota` half.
 *
 * Every function here takes `unknown` on purpose. The input is a loopback HTTP
 * response — read from a route this plugin owns but not necessarily at the same
 * version it was written against — so the mapper cannot lean on a DTO type that
 * the running host might not satisfy. A field that is missing, null, a string
 * where a number was expected, or an array where an object was expected must
 * degrade to "nothing measured", never to a thrown error: one line's odd
 * payload must not be able to take the card down.
 *
 * THE THREE THINGS EACH ONE EXISTS TO GET RIGHT
 *
 * 1. Units. The lines disagree: codex states Unix SECONDS (resetsAt),
 *    antigravity and cline-pass state ISO 8601 strings, kimi / minimax / qoder /
 *    glm / step / command-code state milliseconds. Each normalizer knows which
 *    family it holds and converts exactly once — nothing here guesses a unit
 *    from a magnitude.
 * 2. Percentages. Some lines state used percent, some a used fraction in
 *    [0, 1], some only the remaining share. All of them leave here as used
 *    percent in [0, 100].
 * 3. Absence. Null is not zero. A window without a measurement is dropped
 *    rather than drawn as a full bar, and a line that answered nothing leaves
 *    `quota` null with the reason carried beside it.
 *
 * Windows are ordered shortest first, unstated lengths last — the order a card
 * relies on to draw the tightest limit at the top. The sort is stable, so equal
 * lengths keep the order the line listed them in.
 */
import type {
  LineCardCredits,
  LineCardQuota,
  LineCardResetCredits,
  LineCardWindow,
} from './line-contracts.ts'

/** What one line's status payload says about its quota, accounts aside. */
export interface LineQuotaFacts {
  /** The normalized quota, or null when the payload carried nothing usable. */
  quota: LineCardQuota | null
  /** Plan the line is metered on, when the payload states one. */
  planLabel: string | null
  /**
   * Account identity the payload itself states (usually a masked email).
   *
   * Null when the payload names no account, which is the caller's cue to fall
   * back to the pool's own primary row.
   */
  accountLabel: string | null
  /** Whether the payload says a credential exists; null when it never said. */
  signedIn: boolean | null
  /** The line's own reason its numbers are missing, when it reported one. */
  error: string | null
}

/** A JSON object, as this module reads one. */
type JsonRecord = Record<string, unknown>

/**
 * Anything past this instant is treated as "no reset stated".
 *
 * The lines are inconsistent about sentinels, not about arithmetic: qoder
 * reports `expiresAt: 253402214400000`, which is 9999-12-31 and means "never",
 * and a card that rendered it would print a reset date eight thousand years
 * out. No real window reopens after 2100, so that is the ceiling — applied when
 * a window is built, so every line inherits it rather than each one having to
 * remember.
 */
const SANE_TIMESTAMP_CEILING_MS = 4_102_444_800_000

/**
 * The payload as a JSON object, or null.
 *
 * @param value - Candidate.
 * @returns The object, or null for anything else (arrays included).
 */
function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null
}

/**
 * The payload as a list of JSON objects, dropping anything that is not one.
 *
 * @param value - Candidate.
 * @returns The objects; empty for a non-array.
 */
function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  const records: JsonRecord[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * A trimmed non-empty string, or null.
 *
 * @param value - Candidate.
 * @returns The trimmed text, or null.
 */
function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A finite number, or null.
 *
 * @param value - Candidate.
 * @returns The number, or null.
 */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A boolean as stated, or null when the payload said something else.
 *
 * @param value - Candidate.
 * @returns The boolean, or null.
 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * A Unix MILLISECONDS instant, when the payload already states one.
 *
 * @param value - Candidate.
 * @returns Milliseconds rounded to a whole number, or null.
 */
function asMs(value: unknown): number | null {
  const number = asNumber(value)
  if (number === null || number <= 0) return null
  return Math.round(number)
}

/**
 * A Unix SECONDS instant as milliseconds.
 *
 * @param value - Candidate.
 * @returns Milliseconds, or null when nothing usable was stated.
 */
function asSecondsToMs(value: unknown): number | null {
  const number = asNumber(value)
  if (number === null || number <= 0) return null
  return Math.round(number * 1000)
}

/**
 * An ISO 8601 instant as Unix milliseconds.
 *
 * @param value - Candidate.
 * @returns Milliseconds, or null for an absent or unparseable string.
 */
function asIsoToMs(value: unknown): number | null {
  const text = asText(value)
  if (text === null) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * A reset instant, with the sentinel ceiling applied.
 *
 * @param value - Milliseconds, or null.
 * @returns The instant, or null when absent or implausible.
 */
function asResetAt(value: number | null): number | null {
  if (value === null || value <= 0) return null
  return value > SANE_TIMESTAMP_CEILING_MS ? null : value
}

/**
 * A share in percent, clamped into the bar it is drawn as.
 *
 * @param value - Candidate.
 * @returns The share between 0 and 100, or null when there was none.
 */
function asPercent(value: unknown): number | null {
  const number = asNumber(value)
  if (number === null) return null
  return Math.min(100, Math.max(0, number))
}

/**
 * A fraction in [0, 1] as percent.
 *
 * @param value - Candidate.
 * @returns Percent, or null when there was none.
 */
function asFractionPercent(value: unknown): number | null {
  const number = asNumber(value)
  if (number === null) return null
  return Math.min(100, Math.max(0, number * 100))
}

/**
 * A percent still available, inverted into the used share.
 *
 * @param value - Candidate.
 * @returns The used share, or null when there was none.
 */
function remainingPercentToUsed(value: unknown): number | null {
  const remaining = asPercent(value)
  return remaining === null ? null : 100 - remaining
}

/**
 * A remaining fraction in [0, 1] inverted into percent used.
 *
 * @param value - Candidate.
 * @returns The used share, or null when there was none.
 */
function remainingFractionToUsed(value: unknown): number | null {
  const remaining = asFractionPercent(value)
  return remaining === null ? null : 100 - remaining
}

/**
 * The conventional name of a window length.
 *
 * Used when the line itself states no label (minimax keys its windows as
 * `interval` / `weekly`, deliberately leaving the wording to the client) and as
 * a fallback under a label the line left blank. Only lengths that are
 * unambiguous get a name; anything else stays unnamed rather than mislabelled.
 *
 * @param minutes - Nominal window length.
 * @returns The label, or null when the length is not a conventional one.
 */
function standardWindowLabel(minutes: number | null): string | null {
  switch (minutes) {
    case 300: return '5 小时'
    case 1_440: return '每日'
    case 10_080: return '每周'
    case 43_200: return '每月'
    default: return null
  }
}

/** The window length each named window of the lines that name one stands for. */
const NAMED_WINDOW_MINUTES: Readonly<Record<string, number>> = {
  '5h': 300,
  five_hour: 300,
  'five-hour': 300,
  interval: 300,
  daily: 1_440,
  monthly: 43_200,
  week: 10_080,
  weekly: 10_080,
  seven_day: 10_080,
  '7d': 10_080,
}

/**
 * The window length a line's own window key stands for.
 *
 * @param key - The line's key (`5h`, `five-hour`, `weekly`, …).
 * @returns Minutes, or null when the key is not one this module knows.
 */
function namedWindowMinutes(key: unknown): number | null {
  const text = asText(key)
  if (text === null) return null
  return NAMED_WINDOW_MINUTES[text.toLowerCase()] ?? null
}

/** One window, before the absence rules are applied. */
interface WindowSeed {
  label?: string | null
  usedPercent?: number | null
  windowMinutes?: number | null
  resetsAt?: number | null
}

/**
 * One window, or null when nothing measured its consumption.
 *
 * A window with no used share is dropped rather than drawn as a full bar: the
 * lines say null for "the source told us nothing", and painting that as 100%
 * would report a limit nobody measured.
 *
 * @param seed - The mapped fields.
 * @returns The window, or null.
 */
function windowOf(seed: WindowSeed): LineCardWindow | null {
  const usedPercent = seed.usedPercent === null || seed.usedPercent === undefined
    ? null
    : Math.min(100, Math.max(0, seed.usedPercent))
  if (usedPercent === null) return null
  const windowMinutes = seed.windowMinutes === null || seed.windowMinutes === undefined
    ? null
    : seed.windowMinutes
  return {
    label: asText(seed.label) ?? standardWindowLabel(windowMinutes) ?? '',
    usedPercent,
    windowMinutes,
    resetsAt: asResetAt(seed.resetsAt ?? null),
  }
}

/**
 * Every window the seeds offered, dropping the ones that measured nothing.
 *
 * @param seeds - Candidate windows.
 * @returns The windows that survived.
 */
function windowsFrom(seeds: readonly WindowSeed[]): LineCardWindow[] {
  const windows: LineCardWindow[] = []
  for (const seed of seeds) {
    const window = windowOf(seed)
    if (window !== null) windows.push(window)
  }
  return windows
}

/**
 * Shortest window first, unstated lengths last.
 *
 * @param left - First window.
 * @param right - Second window.
 * @returns The comparator result.
 */
function byWindowLength(left: LineCardWindow, right: LineCardWindow): number {
  if (left.windowMinutes === right.windowMinutes) return 0
  if (left.windowMinutes === null) return 1
  if (right.windowMinutes === null) return -1
  return left.windowMinutes - right.windowMinutes
}

/** One quota, before the "is there anything to show" decision. */
interface QuotaSeed {
  windows?: readonly LineCardWindow[]
  credits?: LineCardCredits | null
  resetCredits?: LineCardResetCredits | null
  fetchedAt?: number | null
  refreshing?: boolean
  error?: string | null
}

/**
 * A quota, or null when the line answered nothing a card could draw.
 *
 * "Nothing to draw" is exactly: no window, no credit figure, no reset credit,
 * and no fetch instant. A payload in that state is reported as `quota: null`
 * so a card shows its placeholder instead of an empty frame that looks like a
 * measured zero.
 *
 * @param seed - The mapped fields.
 * @returns The quota, or null.
 */
function quotaOf(seed: QuotaSeed): LineCardQuota | null {
  const windows = [...(seed.windows ?? [])].sort(byWindowLength)
  const credits = seed.credits ?? null
  const resetCredits = seed.resetCredits ?? null
  const fetchedAt = asMs(seed.fetchedAt ?? null)
  if (windows.length === 0 && credits === null && resetCredits === null && fetchedAt === null) return null
  return {
    windows,
    credits,
    resetCredits,
    fetchedAt,
    refreshing: seed.refreshing === true,
    error: asText(seed.error),
  }
}

/** One facts object, before the "quota or card-level error" split. */
interface FactsSeed extends QuotaSeed {
  planLabel?: unknown
  accountLabel?: unknown
  signedIn?: unknown
}

/**
 * The facts one payload yields.
 *
 * A line's own failure message lands in `quota.error` when there IS a quota to
 * annotate, and in the card-level `error` when there is not — the same sentence
 * either way, placed where the card can actually render it.
 *
 * @param seed - The mapped fields.
 * @returns The facts.
 */
function factsOf(seed: FactsSeed): LineQuotaFacts {
  const error = asText(seed.error)
  const quota = quotaOf(seed)
  return {
    quota: quota === null ? null : { ...quota, error },
    planLabel: asText(seed.planLabel),
    accountLabel: asText(seed.accountLabel),
    signedIn: asBoolean(seed.signedIn),
    error: quota === null ? error : null,
  }
}

/**
 * The facts of a payload that could not be read at all.
 *
 * @param error - Why the payload was unusable.
 * @returns The facts, with nothing measured.
 */
function unavailableFacts(error: string | null): LineQuotaFacts {
  return { quota: null, planLabel: null, accountLabel: null, signedIn: null, error }
}

/**
 * The first non-null text of a candidate list.
 *
 * @param values - Candidates, most specific first.
 * @returns The first text that was stated, or null.
 */
function firstText(values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = asText(value)
    if (text !== null) return text
  }
  return null
}

/**
 * A balance as a string, keeping its unit.
 *
 * @param balance - The line's own figure.
 * @param unit - Unit to append, when the line states one.
 * @returns The balance, or null when there was none.
 */
function balanceOf(balance: unknown, unit?: string | null): string | null {
  const number = asNumber(balance)
  const suffix = unit === null || unit === undefined ? '' : ' ' + unit
  if (number === null) {
    const text = asText(balance)
    return text === null ? null : text + suffix
  }
  return String(number) + suffix
}

/**
 * The display name of one Qoder allowance.
 *
 * @param kind - The line's bucket kind.
 * @returns The label, or null when the kind is not one this module knows.
 */
function bucketLabel(kind: unknown): string | null {
  switch (asText(kind)) {
    case 'personal': return '个人额度'
    case 'add-on': return '加购额度'
    case 'org': return '组织额度'
    default: return null
  }
}

/**
 * The ChatGPT line's quota, as `GET /status` answers it.
 *
 * Units: `QuotaWindowDto.resetsAt`, `resetCredits.expiresAt` and
 * `quota.fetchedAt` are Unix SECONDS here (that line's own quota service
 * multiplies them by 1000 further out), while everything else on the payload is
 * already milliseconds. The bucket list also carries an older
 * `primary`/`secondary` pair that some payload generations state instead of
 * `windows`; both are read, so the card shows the same bars the settings card
 * does.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeCodexQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const account = asRecord(root.account)
  const buckets = asRecords(quotaBody?.buckets)
  const seeds: WindowSeed[] = []
  for (const bucket of buckets) {
    const stated = asRecords(bucket.windows)
    const source = stated.length > 0
      ? stated
      : [asRecord(bucket.primary), asRecord(bucket.secondary)]
    for (const window of source) {
      if (window === null) continue
      seeds.push({
        label: asText(window.label),
        usedPercent: asPercent(window.usedPercent),
        windowMinutes: asNumber(window.windowDurationMins),
        resetsAt: asSecondsToMs(window.resetsAt),
      })
    }
  }
  const creditsBody = asRecord(quotaBody?.credits)
  const credits: LineCardCredits | null = creditsBody === null
    ? null
    : { unlimited: creditsBody.unlimited === true, balance: asText(creditsBody.balance) }
  const resetBody = asRecord(quotaBody?.resetCredits)
  const resetCredits: LineCardResetCredits | null = resetBody === null
    ? null
    : {
      available: Math.max(0, Math.trunc(asNumber(resetBody.availableCount) ?? 0)),
      expiresAt: asResetAt(asSecondsToMs(resetBody.expiresAt)),
    }
  const planLabel = firstText([
    ...buckets.map((bucket) => bucket.planType),
    account?.planType,
  ])
  const state = asText(quotaBody?.state)
  return factsOf({
    windows: windowsFrom(seeds),
    credits,
    resetCredits,
    fetchedAt: asSecondsToMs(quotaBody?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([asRecord(quotaBody?.error)?.message]),
    planLabel,
    accountLabel: account?.email,
    // A quota answer is only "signed out" when the payload says there was no
    // credential to read; every other state means this line did have one.
    signedIn: asBoolean(root.authenticated) ?? (state === null ? null : state !== 'signed-out'),
  })
}

/**
 * The Kimi Code line's quota.
 *
 * Units: `resetsAt` and `fetchedAt` are already milliseconds. The fallback
 * wallet (`extraUsage`) is stated in the currency's minor unit, so it is
 * divided once and kept with its currency: a bare "75.00" would be read as
 * provider credits by every other card on the board.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeKimiCodeQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const account = asRecord(root.account)
  const extra = asRecord(quotaBody?.extraUsage)
  const balanceCents = asNumber(extra?.balanceCents)
  const currency = asText(extra?.currency)
  const credits: LineCardCredits | null = balanceCents === null
    ? null
    : { unlimited: false, balance: (balanceCents / 100).toFixed(2) + (currency === null ? '' : ' ' + currency) }
  return factsOf({
    windows: windowsFrom(asRecords(quotaBody?.windows).map((window) => ({
      label: asText(window.label),
      usedPercent: asPercent(window.usedPercent),
      windowMinutes: asNumber(window.windowDurationMins),
      resetsAt: asMs(window.resetsAt),
    }))),
    credits,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    // The line reports a failed read beside the snapshot it still holds; the
    // snapshot is worth showing, so the message annotates it.
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.planName, account?.planName]),
    accountLabel: firstText([account?.email, account?.nickname]),
    signedIn: root.authenticated,
  })
}

/**
 * The MiniMax Code line's quota.
 *
 * Units: milliseconds throughout (`resetsAtMs`, `fetchedAtMs`). The windows are
 * keyed (`interval` / `weekly`) rather than labelled — the line leaves the
 * wording to the client — and carry a REMAINING percent, sometimes only a
 * remaining one; both are inverted into the used share here.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeMinimaxCodeQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const seeds: WindowSeed[] = asRecords(quotaBody?.windows).map((window) => ({
    // No label: the key is a machine token, and the given length names it.
    label: null,
    usedPercent: asPercent(window.usedPercent) ?? remainingPercentToUsed(window.remainingPercent),
    windowMinutes: namedWindowMinutes(window.key),
    resetsAt: asMs(window.resetsAtMs),
  }))
  // A payload that states only one headline number still has a window worth
  // drawing; that line's headline is the rolling 5-hour one.
  if (seeds.length === 0) {
    const headline = asPercent(quotaBody?.usedPercent)
    if (headline !== null) {
      seeds.push({ label: null, usedPercent: headline, windowMinutes: 300, resetsAt: asMs(quotaBody?.resetsAtMs) })
    }
  }
  const accounts = asRecords(root.accounts)
  const activeId = asText(root.activeAccountId)
  const active = accounts.find((account) => asText(account.id) === activeId)
    ?? accounts.find((account) => asText(account.email) !== null)
  return factsOf({
    windows: windowsFrom(seeds),
    credits: null,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAtMs),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.label]),
    accountLabel: firstText([active?.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The Antigravity line's quota.
 *
 * Units: the harder one of the set. Each allowance is stated as
 * `remainingFraction` in [0, 1] (null when the service measured nothing, and
 * NOT zero), named windows arrive as `window: '5h' | 'weekly'`, and reset
 * instants as ISO 8601. Windows are grouped (Gemini models, third-party
 * models); each bucket's label is prefixed with its group once there is more
 * than one group, because "Weekly" twice on one card says nothing about which
 * allowance it is.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeAntigravityQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const groups = asRecords(quotaBody?.groups)
  const seeds: WindowSeed[] = []
  for (const group of groups) {
    const groupName = groups.length > 1 ? asText(group.displayName) : null
    for (const bucket of asRecords(group.buckets)) {
      const minutes = namedWindowMinutes(bucket.window)
      const windowName = standardWindowLabel(minutes) ?? asText(bucket.displayName)
      seeds.push({
        label: groupName === null || windowName === null ? windowName : groupName + ' · ' + windowName,
        usedPercent: remainingFractionToUsed(bucket.remainingFraction),
        windowMinutes: minutes,
        resetsAt: asIsoToMs(bucket.resetTime),
      })
    }
  }
  const paidTier = asRecord(quotaBody?.paidTier)
  const productTier = asRecord(quotaBody?.productTier)
  return factsOf({
    windows: windowsFrom(seeds),
    credits: null,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt) ?? asMs(root.lastFetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.planLabel, paidTier?.name, productTier?.name]),
    accountLabel: firstText([root.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The Command Code line's quota.
 *
 * Units: two different meter shapes, and both are needed. `windows[]` is
 * already normalized (`usedPercent`, `windowDurationMins`, milliseconds);
 * `meters[]` states a used FRACTION that is null whenever the service reports a
 * spend meter instead of a bounded allowance, and only the ones that did state
 * a fraction become bars. The credit balance is that line's own string, kept
 * verbatim.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeCommandCodeQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const windows = windowsFrom(asRecords(quotaBody?.windows).map((window) => ({
    label: asText(window.label),
    usedPercent: asPercent(window.usedPercent),
    windowMinutes: asNumber(window.windowDurationMins),
    resetsAt: asMs(window.resetsAt),
  })))
  if (windows.length === 0) {
    for (const meter of asRecords(quotaBody?.meters)) {
      windows.push(...windowsFrom([{
        label: asText(meter.label),
        usedPercent: asFractionPercent(meter.usedFraction),
        windowMinutes: null,
        resetsAt: asMs(meter.resetsAt),
      }]))
    }
  }
  const account = asRecord(root.account) ?? asRecord(quotaBody?.account)
  const credits: LineCardCredits | null = quotaBody === null
    ? null
    : { unlimited: quotaBody.unlimited === true, balance: asText(quotaBody.creditBalance) }
  return factsOf({
    windows,
    credits,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt) ?? asMs(root.lastFetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.planName, account?.planLabel]),
    accountLabel: firstText([account?.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The Claude line's quota.
 *
 * Units: millisecond `fetchedAt` / `observedAt`, ISO 8601 `resetsAt`, and a
 * used share that may be stated as percent or as a fraction in [0, 1] — the
 * three numeric fields are null together when the source said nothing, so the
 * fraction is only consulted when the percent is absent.
 *
 * The line answers `quota: null` on a first read and only fills it after its
 * own `POST /quota`; that is what the refresh capability exists for, so an
 * empty first read is reported as-is rather than as an error.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeClaudeQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const account = asRecord(root.account)
  return factsOf({
    windows: windowsFrom(asRecords(quotaBody?.windows).map((window) => {
      const minutes = asNumber(window.windowMinutes) ?? namedWindowMinutes(window.id)
      return {
        label: asText(window.label) ?? standardWindowLabel(minutes),
        usedPercent: asPercent(window.usedPercent) ?? asFractionPercent(window.usedFraction),
        windowMinutes: minutes,
        resetsAt: asIsoToMs(window.resetsAt),
      }
    })),
    credits: null,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt) ?? asMs(quotaBody?.observedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([account?.subscriptionType]),
    accountLabel: firstText([account?.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The GLM Coding Plan line's quota.
 *
 * Units: milliseconds (`resetsAt`, `fetchedAt`). Windows are keyed
 * (`five-hour` / `weekly` / `monthly`) and their used percent is null when the
 * upstream reported no bounded allowance — an unlimited plan states no
 * fraction, and drawing that as 0% used would invent a measurement.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeGlmCodingPlanQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  return factsOf({
    windows: windowsFrom(asRecords(quotaBody?.windows).map((window) => {
      const minutes = namedWindowMinutes(window.key)
      return {
        label: standardWindowLabel(minutes),
        usedPercent: asPercent(window.usedPercent),
        windowMinutes: minutes,
        resetsAt: asMs(window.resetsAt),
      }
    })),
    credits: null,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.planName, quotaBody?.planLevel]),
    signedIn: root.authenticated,
  })
}

/**
 * The Step Code line's quota.
 *
 * Units: milliseconds. Two payload generations share one snapshot: an older
 * account has 5-hour and weekly windows, a newer one has `creditBuckets` — an
 * absolute amount per bucket, with no percentage at all. The buckets become the
 * card's credit figure (their remaining amounts summed) rather than being
 * squeezed into a progress bar nobody measured; the `credit` window key, which
 * names the same thing, is deliberately left without a bar for the same reason.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeStepCodeQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  let remaining = 0
  let hasRemaining = false
  for (const bucket of asRecords(quotaBody?.creditBuckets)) {
    const amount = asNumber(bucket.remaining)
    if (amount === null) continue
    remaining += amount
    hasRemaining = true
  }
  const credits: LineCardCredits | null = hasRemaining
    ? { unlimited: false, balance: String(Math.round(remaining * 100) / 100) }
    : null
  const account = asRecord(root.account) ?? asRecord(asRecord(root.quotaCredential)?.account)
  return factsOf({
    windows: windowsFrom(asRecords(quotaBody?.windows).map((window) => {
      const minutes = window.key === 'credit' ? null : namedWindowMinutes(window.key)
      return {
        label: standardWindowLabel(minutes) ?? (window.key === 'credit' ? 'Credits' : null),
        usedPercent: asPercent(window.usedPercent),
        windowMinutes: minutes,
        resetsAt: asMs(window.resetsAt),
      }
    })),
    credits,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: firstText([quotaBody?.planName]),
    accountLabel: firstText([account?.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The Qoder line's quota.
 *
 * Units: milliseconds, with one sentinel: the account period ends at
 * `253402214400000` (year 9999) for a subscription that never expires, and a
 * card would print that as a real date, so the shared ceiling drops it.
 *
 * Qoder states ABSOLUTE amounts (total / used / remaining + unit), not windows.
 * A ratio is derived only when both total and used are stated AND total is
 * positive; anything else is reported as a credit balance instead of a bar.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeQoderQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const quotaBody = asRecord(root.quota)
  const expiresAt = asResetAt(asMs(quotaBody?.expiresAt))
  const seeds: WindowSeed[] = []
  let credits: LineCardCredits | null = null
  for (const bucket of asRecords(quotaBody?.buckets)) {
    const total = asNumber(bucket.total)
    const remaining = asNumber(bucket.remaining)
    const used = asNumber(bucket.used) ?? (total !== null && remaining !== null ? total - remaining : null)
    // The two statements are independent: a bucket can state a bounded
    // allowance (a real share) AND a remaining amount worth naming, and a
    // bucket with no total at all still states what is left.
    if (total !== null && total > 0 && used !== null) {
      seeds.push({
        label: bucketLabel(bucket.kind),
        usedPercent: (used / total) * 100,
        windowMinutes: null,
        resetsAt: expiresAt,
      })
    }
    if (credits === null && remaining !== null) {
      credits = { unlimited: false, balance: balanceOf(remaining, asText(bucket.unit)) }
    }
  }
  const account = asRecord(root.account)
  return factsOf({
    windows: windowsFrom(seeds),
    credits,
    resetCredits: null,
    fetchedAt: asMs(quotaBody?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError]),
    planLabel: null,
    accountLabel: firstText([account?.email]),
    signedIn: root.authenticated,
  })
}

/**
 * The Cline Pass line's quota.
 *
 * Units: `percentUsed` is a percent, `resetsAt` is an ISO 8601 string, and the
 * window's length is only stated as a gateway token (`five_hour` / `weekly` /
 * `monthly`). The payload carries one reading PER ACCOUNT, so the row shown is
 * the pool's active account when it has a reading, else the first account that
 * did read something. An account that failed states its own reason, which is
 * what the card shows instead of an empty frame.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeClinePassQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const usage = asRecord(root.usage)
  const readings = asRecords(usage?.accounts)
  const activeId = asText(asRecord(root.pool)?.activeAccountId)
  const reading = readings.find((entry) => asText(entry.accountId) === activeId)
    ?? readings.find((entry) => asRecords(entry.windows).length > 0)
    ?? readings[0]
  return factsOf({
    windows: windowsFrom(asRecords(reading?.windows).map((window) => {
      const minutes = namedWindowMinutes(window.type)
      return {
        label: asText(window.label) ?? standardWindowLabel(minutes),
        usedPercent: asPercent(window.percentUsed),
        windowMinutes: minutes,
        resetsAt: asIsoToMs(window.resetsAt),
      }
    })),
    credits: null,
    resetCredits: null,
    fetchedAt: asMs(reading?.fetchedAt) ?? asMs(usage?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError, reading?.error]),
    planLabel: null,
    accountLabel: null,
    signedIn: root.authenticated,
  })
}

/**
 * The OpenDesign line's quota.
 *
 * Units: the odd one out — this line has NO percentage windows at all. Its
 * `usage` is a wallet reading per account: a USD balance string plus the
 * billing tier. So the card gets `windows: []` and a credit figure, and the
 * plan label comes from billing when the service named a tier.
 *
 * @param status - The route's `value`.
 * @returns The facts.
 */
export function normalizeOpenDesignQuota(status: unknown): LineQuotaFacts {
  const root = asRecord(status)
  if (root === null) return unavailableFacts(null)
  const usage = asRecord(root.usage)
  const readings = asRecords(usage?.accounts)
  const activeId = asText(asRecord(root.pool)?.activeAccountId)
  const reading = readings.find((entry) => asText(entry.accountId) === activeId)
    ?? readings.find((entry) => asText(entry.balanceUsd) !== null)
    ?? readings[0]
  const balance = asText(reading?.balanceUsd)
  const credits: LineCardCredits | null = balance === null
    ? null
    : { unlimited: false, balance: balance + ' USD' }
  return factsOf({
    windows: [],
    credits,
    resetCredits: null,
    fetchedAt: asMs(reading?.fetchedAt) ?? asMs(usage?.fetchedAt),
    refreshing: root.quotaRefreshing === true,
    error: firstText([root.quotaError, reading?.error]),
    planLabel: firstText([asRecord(reading?.billing)?.plan]),
    accountLabel: null,
    signedIn: root.authenticated,
  })
}

/**
 * One pooled account's own quota, as a card row draws it.
 *
 * A row states a bar, the instant it reopens, and — since this reading is the
 * only place any line computes an account's windows — the WHOLE list behind that
 * bar. Never a plan, a label or an error: those belong to the pool's row.
 *
 * `null` in either scalar keeps the contract's own meaning — nobody measured that
 * fact — and is what makes a half-known reading useless rather than half-true
 * (see the two readers below). `windows` is then `[]` rather than a padded
 * placeholder: a line that measured nothing has no window to show, and a 0 % bar
 * would report a limit nobody observed.
 */
export interface LineAccountQuotaReading {
  /** Share of the account's shortest window consumed, 0-100, or null. */
  usedPercent: number | null
  /** Unix MILLISECONDS that window reopens, or null when nobody said. */
  resetsAt: number | null
  /**
   * Every window this account's quota stated, shortest first.
   *
   * Empty — never absent — when the line has no window vocabulary of its own
   * (Qoder states absolute amounts, not percentages) or measured nothing.
   */
  windows: LineCardWindow[]
}

/**
 * The Qoder account's own reading, from one `quota/usage` snapshot.
 *
 * Qoder states ABSOLUTE amounts per bucket (total / used / remaining), never a
 * percentage, so a share is derived here only under the same rule
 * {@link normalizeQoderQuota} already applies to the line-level card: BOTH a
 * total (positive) and a used figure must be stated. A bucket that states
 * amounts without a bounded allowance — a top-up balance, an org cap nobody
 * measured — is not turned into a bar, and a snapshot with no such bucket
 * answers null rather than a made-up zero.
 *
 * No window list accompanies it: this line has no percentage windows at all
 * (its buckets are absolute amounts, and its only instant is the snapshot's own
 * expiry), so `windows` is `[]` — the honest answer rather than a manufactured
 * one-window list nobody measured.
 *
 * @param snapshot - The account's quota snapshot (`{ buckets, expiresAt }`).
 * @returns The reading, or null when nothing bounded was measured.
 */
export function qoderAccountQuotaReading(snapshot: unknown): LineAccountQuotaReading | null {
  const root = asRecord(snapshot)
  if (root === null) return null
  const resetsAt = asResetAt(asMs(root.expiresAt))
  for (const bucket of asRecords(root.buckets)) {
    const total = asNumber(bucket.total)
    const remaining = asNumber(bucket.remaining)
    const used = asNumber(bucket.used) ?? (total !== null && remaining !== null ? total - remaining : null)
    if (total === null || total <= 0 || used === null) continue
    return { usedPercent: asPercent((used / total) * 100), resetsAt, windows: [] }
  }
  return null
}

/**
 * The MiniMax Code account's own reading, from one Token Plan snapshot.
 *
 * The window the row's BAR draws is the rolling 5-hour one — the line's own
 * headline, and the tightest limit the plan has: its machine key is `interval`,
 * and a payload that named no key is placed by its nominal length instead. The
 * weekly window is deliberately NOT substituted (a row saying 5% while the
 * 5-hour window is spent is worse than a row saying nothing), and an `unlimited`
 * window states no share at all, so nothing becomes a bar.
 *
 * `windows` carries the WHOLE list all the same: this line states it — `interval`
 * and `weekly`, each with a share and a reset instant — so an account can be
 * opened up and show both of its limits instead of only the bar.
 *
 * @param quota - The parsed `MinimaxCodeQuota`.
 * @returns The reading, or null when the 5-hour window measured nothing.
 */
export function minimaxAccountQuotaReading(quota: unknown): LineAccountQuotaReading | null {
  const root = asRecord(quota)
  if (root === null) return null
  const stated = asRecords(root.windows)
  const fiveHour = stated.find((window) => asText(window.key) === 'interval')
    ?? stated.find((window) => namedWindowMinutes(window.key) === 300)
  const fromWindow = fiveHour === undefined
    ? null
    : asPercent(fiveHour.usedPercent) ?? remainingPercentToUsed(fiveHour.remainingPercent)
  // A snapshot with no window detail states its one headline number, which this
  // line's own normalizer already treats as the 5-hour window's.
  const usedPercent = fromWindow ?? asPercent(root.usedPercent)
  if (usedPercent === null) return null
  const resetsAtMs = fiveHour === undefined ? asMs(root.resetsAtMs) : asMs(fiveHour.resetsAtMs)
  return {
    usedPercent,
    resetsAt: asResetAt(resetsAtMs),
    windows: minimaxWindowList(stated, usedPercent, resetsAtMs),
  }
}

/**
 * Every window one Token Plan snapshot stated, in the card's own vocabulary.
 *
 * Mapped exactly the way `normalizeMinimaxCodeQuota` maps the line-level list, so
 * the per-account list and the line list can never disagree about what a window
 * is called: the key is a machine token that stands for a length, and the length
 * names the window (`interval` → 300 → 「5 小时」, `weekly` → 10080 → 「每周」).
 * One derived rule, not a second one beside it.
 *
 * @param stated - The payload's own `windows`.
 * @param headlineUsedPercent - The share the row's bar draws.
 * @param headlineResetsAtMs - The reset instant that goes with it.
 * @returns The windows, shortest first; one derived from the headline when the
 *   payload stated no window at all, `[]` only when it said nothing usable.
 */
function minimaxWindowList(
  stated: readonly JsonRecord[],
  headlineUsedPercent: number,
  headlineResetsAtMs: number | null,
): LineCardWindow[] {
  const windows = windowsFrom(stated.map((window) => ({
    // No label of its own, exactly like the line-level normalizer: the key is a
    // machine token, and the given length is what names the window.
    label: null,
    usedPercent: asPercent(window.usedPercent) ?? remainingPercentToUsed(window.remainingPercent),
    windowMinutes: namedWindowMinutes(window.key),
    resetsAt: asMs(window.resetsAtMs),
  }))).sort(byWindowLength)
  if (windows.length > 0) return windows
  // A payload that stated only the headline number still describes ONE window —
  // the same rolling 5-hour one the line-level normalizer derives from it — so
  // the row's bar and the list behind it cannot contradict each other.
  return windowsFrom([{
    label: null,
    usedPercent: headlineUsedPercent,
    windowMinutes: 300,
    resetsAt: headlineResetsAtMs,
  }])
}

/**
 * Every normalizer, keyed by the line id a card names.
 *
 * The registry looks a line up here; a line that is registered but has no entry
 * falls back to nothing measured, so adding a pool without a normalizer
 * degrades to "no quota window" instead of to a thrown error.
 */
export const LINE_QUOTA_NORMALIZERS: Readonly<Record<string, (status: unknown) => LineQuotaFacts>> = {
  codex: normalizeCodexQuota,
  claude: normalizeClaudeQuota,
  'glm-coding-plan': normalizeGlmCodingPlanQuota,
  'step-code': normalizeStepCodeQuota,
  qoder: normalizeQoderQuota,
  'cline-pass': normalizeClinePassQuota,
  opendesign: normalizeOpenDesignQuota,
  'kimi-code': normalizeKimiCodeQuota,
  'minimax-code': normalizeMinimaxCodeQuota,
  antigravity: normalizeAntigravityQuota,
  'command-code': normalizeCommandCodeQuota,
}
