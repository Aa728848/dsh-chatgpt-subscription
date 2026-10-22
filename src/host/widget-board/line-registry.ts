/**
 * The line registry: one entry per subscription line, and the two halves of a
 * card answered from different authorities.
 *
 * WHY THE SPLIT
 *
 * - ACCOUNTS travel through the pools, in process. Every line's pool already
 *   speaks the same three methods (listAccounts / setPrimary / setStrategy) and
 *   hands back the same row DTO, so ONE generic adapter covers all of them — no
 *   HTTP, no per-line code, and no second implementation of eligibility,
 *   cooldowns or the rotation strategy. The line → pool mapping is injected by
 *   src/index.ts, where every pool is in scope; nothing here imports a concrete
 *   pool class, so a new line is a wiring change, not a change to this module.
 *
 * - QUOTA travels over LOOPBACK HTTP, through the line's own status route. Each
 *   line's route already normalizes its provider payload into its own DTO and
 *   owns the cache, the refresh flight and the error reporting for it. Reading
 *   the provider directly from here would be a second reader of the same
 *   upstream, free to drift from the one the settings card shows. The loopback
 *   call needs no credential: these are the very same GET /status requests this
 *   plugin's own settings page makes.
 *
 * A read is therefore two independent tasks in parallel, and NEITHER can take
 * the other down: a pool file that will not decrypt still leaves the card with
 * its quota, and a line whose route is unreachable still leaves it with its
 * accounts.
 *
 * - PER-ACCOUNT QUOTA is the third, OPTIONAL half, and the one neither of the
 *   other two can answer: a pool row carries a snapshot only for the account
 *   that was actually read, so on a two-account line the second row has nothing
 *   to draw. A line that opts in hands over a reader
 *   ({@link LINE_ACCOUNT_QUOTA_READERS}) which — given ONE account's credential —
 *   asks that line's own client for that account's own numbers. The reader is
 *   INJECTED, never imported: each one needs a concrete line client, and this
 *   module imports no line at all. A line with no reader behaves exactly as
 *   before, which is why every line that does not opt in is untouched.
 *
 *   The opt-in half is bounded FOUR ways, because it is the only part of a read
 *   that spends upstream requests per ACCOUNT: one budget for one account
 *   ({@link LINE_ACCOUNT_QUOTA_TIMEOUT_MS}), ONE budget for the whole per-account
 *   stage ({@link LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS}), a cache per (line,
 *   account) so a card polling every 60 s does not become a poll of the upstream
 *   ({@link LINE_ACCOUNT_QUOTA_CACHE_MS} — with a much shorter TTL for a failed
 *   entry, {@link LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS}, so a recovered account
 *   comes back on the next poll), a small concurrency gate
 *   ({@link LINE_ACCOUNT_QUOTA_CONCURRENCY}), and a cap on how many accounts one
 *   read spends a request on at all ({@link LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS}).
 *   Every failure is absorbed on the ONE row it belongs to: a reader that
 *   throws, times out or answers null leaves that row unread and touches nothing
 *   else — no other row, no other line, and never the card's error field.
 *
 * EVERY failure is bounded, and the bound does NOT grow with the account count:
 * the two halves a card reads are bounded by the HTTP budget (5 s,
 * {@link LINE_HTTP_TIMEOUT_MS}), and the per-account stage is bounded by ITS OWN
 * budget (6 s, {@link LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS}) rather than by
 * ceil(accounts / concurrency) × 5 s — so six accounts whose readers all hang
 * answer in 6 s instead of 15 s, and a board of such cards is not a board that
 * hangs. A row the whole stage did not reach is not a failure: it stays blank
 * and is tried again on the next read, because the cache is per account.
 */
import type { AccountRotationStrategy, PoolAccountSummaryDto } from '../../shared/account-pool-contracts.ts'
import type { LineCardAccount, LineCardData } from './line-contracts.ts'
import {
  LINE_QUOTA_NORMALIZERS,
  minimaxAccountQuotaReading,
  qoderAccountQuotaReading,
  type LineAccountQuotaReading,
  type LineQuotaFacts,
} from './line-quota.ts'

/**
 * How long one line's HTTP read may take, in milliseconds.
 *
 * A board data source is read while a card paints, so this is a ceiling rather
 * than a target: every one of these routes answers from a local cache in
 * milliseconds, and five seconds is the point at which "slow" has already
 * become "broken" for the user watching an empty card.
 */
export const LINE_HTTP_TIMEOUT_MS = 5_000

/**
 * How long ONE account's extra quota read may take, in milliseconds.
 *
 * Equal to the card's own HTTP budget rather than shorter. It was three seconds
 * first, on the theory that a warm route answers in milliseconds; MEASURED
 * against a live Qoder endpoint, the same read took 107 ms, 573 ms, 1254 ms —
 * and twice over three seconds on a cold process. With the failure cache below,
 * a budget that tight converts "the first card after a restart" into "a blank
 * row for the next quarter of a minute", which is a worse answer than waiting
 * two extra seconds once. Five seconds also cannot lengthen a card: the rows are
 * read two at a time, so a two-account line still answers inside one budget.
 *
 * The same budget covers the credential lookup and the upstream call together —
 * it is one deadline for one row, not one per step.
 */
export const LINE_ACCOUNT_QUOTA_TIMEOUT_MS = 5_000

/**
 * How long one SUCCESSFUL (line, account) reading is reused, in milliseconds.
 *
 * The board re-reads a card every 60 seconds, and there are two rows on the
 * lines this exists for. Without a cache every poll would be two upstream
 * requests per account — the quota endpoint is a personal, undocumented one, and
 * hammering it on a timer is how an account gets rate-limited by its own card.
 * Sixty seconds is therefore a FLOOR: a reading is never reused for less.
 */
export const LINE_ACCOUNT_QUOTA_CACHE_MS = 60_000

/**
 * How long a FAILED (line, account) reading is reused, in milliseconds.
 *
 * Deliberately NOT the same TTL as a success, because the two entries are
 * remembered for opposite reasons:
 *
 * - a success is cached to stop the board from polling the upstream, so its TTL
 *   is the poll interval;
 * - a failure is cached to stop a broken account from being retried on every
 *   tick — but every minute it lasts is also a minute of a row that HAS numbers
 *   available and is not showing them (a transient timeout, an upstream blip, a
 *   credential that just got renewed). Fifteen seconds bounds that cost: a
 *   failure is retried about four times a minute, which is far below anything
 *   the upstream would notice, and a recovered account is back on the card on
 *   the very next poll instead of the one after it.
 *
 * Both entries are remembered rather than dropped: forgetting a failure would
 * turn one dead account into one upstream request per card read.
 */
export const LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS = 15_000

/**
 * How many per-account quota reads one registry may have in flight at once.
 *
 * Two, so a single card read (one per row) is sequential at worst on the lines
 * that exist today, while a board showing two cards of the same line still
 * cannot fan out into a burst of upstream requests.
 */
export const LINE_ACCOUNT_QUOTA_CONCURRENCY = 2

/**
 * How long the WHOLE per-account stage of ONE card read may take, in
 * milliseconds.
 *
 * Not about one account: this is the ceiling on everything a card waits for while
 * it asks each row's own upstream. The per-account budget above bounds one ROW,
 * and on its own it composes badly — rows are read two at a time, so N accounts
 * cost ceil(N / 2) × 5 s in the worst case, which is 15 s on six accounts and
 * grows without limit. That is the number this constant removes: six accounts
 * whose readers all hang now answer in six seconds rather than fifteen, and the
 * same six seconds covers sixty accounts.
 *
 * Why 6 s and not 5: one account must still be able to spend its FULL
 * per-account budget — the credential lookup and the upstream call share that
 * deadline, and a cold upstream has been measured over three seconds twice — so a
 * stage shorter than the row budget would silently turn every cold first read
 * into a blank row. The extra second is what lets the first pair of a
 * two-account line finish, failure path included, before the stage closes.
 *
 * Running out is NOT an error. Rows that answered before the deadline keep their
 * numbers; rows that did not stay UNREAD — `usedPercent: null`, no window list,
 * and no entry in the card's `error` field. The next read (the board's 60 s poll,
 * or a manual refresh) tries them again, which works because the cache is keyed
 * per account and a row that never answered was never cached.
 */
export const LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS = 6_000

/**
 * How many accounts ONE read may spend a per-account request on.
 *
 * The stage budget above bounds the TIME; this bounds the WORK. A line with three
 * hundred pooled accounts would otherwise open a hundred and fifty credential
 * lookups and upstream quota requests per card read — each one billed to a
 * personal, undocumented endpoint — and the rows past the first few could never be
 * reached before the budget expired anyway. Reading eight and leaving the rest
 * unread is the honest version of that: the extra rows stay blank instead of
 * queueing behind a deadline they cannot meet.
 *
 * WHICH eight, when there are more: primary first, then most recently used
 * ({@link PoolAccountSummaryDto.lastUsedAt} descending, pool order on ties), so
 * the cap spends the card's requests on the rows a reader is most likely looking
 * at. A rotation moves that window on the next read.
 */
export const LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS = 8

/** The three rotation strategies, in the pool's own vocabulary. */
const ROTATION_STRATEGIES: readonly AccountRotationStrategy[] = ['sequential', 'round-robin', 'sticky']

/**
 * One line, as this registry reads it.
 *
 * A definition carries no service: the pool arrives through the injected
 * mapping and the routes are addressed by path, which is what lets one module
 * describe eleven lines without importing eleven implementations.
 */
export interface LineDefinition {
  /** Line id a card names, e.g. `codex`. Also the pool mapping's key. */
  id: string
  /** Display name, e.g. `ChatGPT`. */
  label: string
  /** The line's own status route, e.g. `/claude/api/status`. */
  statusPath: string
  /**
   * The line's own quota-refresh route, POSTed before the status route is read
   * again. Null for a line whose status read is already authoritative.
   */
  refreshPath: string | null
  /** The line's payload → shape C's quota half. */
  normalize(status: unknown): LineQuotaFacts
}

/**
 * Every line this plugin can serve a card for.
 *
 * The routes are the lines' own, verbatim: this module is not allowed to invent
 * a prefix, because a prefix is what a line owns.
 */
export const LINE_DEFINITIONS: readonly LineDefinition[] = [
  {
    id: 'codex',
    label: 'ChatGPT',
    statusPath: '/api/dsh-chatgpt-subscription/status',
    // The ChatGPT line refreshes through its own action route rather than
    // through a POST on the quota object, unlike every other line.
    refreshPath: '/api/dsh-chatgpt-subscription/quota/refresh',
    normalize: LINE_QUOTA_NORMALIZERS.codex,
  },
  {
    id: 'claude',
    label: 'Claude',
    statusPath: '/claude/api/status',
    refreshPath: '/claude/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS.claude,
  },
  {
    id: 'glm-coding-plan',
    label: 'GLM Coding Plan',
    statusPath: '/glm-coding-plan/api/status',
    refreshPath: '/glm-coding-plan/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS['glm-coding-plan'],
  },
  {
    id: 'step-code',
    label: 'Step Code',
    statusPath: '/step-code/api/status',
    refreshPath: '/step-code/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS['step-code'],
  },
  {
    id: 'qoder',
    label: 'Qoder',
    statusPath: '/qoder/api/status',
    refreshPath: '/qoder/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS.qoder,
  },
  // The two API-key / wallet lines refresh a per-account reading rather than a
  // quota window, and both spell that route `usage`.
  {
    id: 'cline-pass',
    label: 'Cline Pass',
    statusPath: '/cline-pass/api/status',
    refreshPath: '/cline-pass/api/usage',
    normalize: LINE_QUOTA_NORMALIZERS['cline-pass'],
  },
  {
    id: 'opendesign',
    label: 'OpenDesign',
    statusPath: '/opendesign/api/status',
    refreshPath: '/opendesign/api/usage',
    normalize: LINE_QUOTA_NORMALIZERS.opendesign,
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    statusPath: '/kimi-code/api/status',
    refreshPath: '/kimi-code/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS['kimi-code'],
  },
  {
    id: 'minimax-code',
    label: 'MiniMax Code',
    statusPath: '/minimax-code/api/status',
    refreshPath: '/minimax-code/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS['minimax-code'],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    statusPath: '/antigravity/api/status',
    refreshPath: '/antigravity/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS.antigravity,
  },
  {
    id: 'command-code',
    label: 'Command Code',
    statusPath: '/command-code/api/status',
    refreshPath: '/command-code/api/quota',
    normalize: LINE_QUOTA_NORMALIZERS['command-code'],
  },
]

/**
 * What one line's client is handed to read ONE account's quota.
 *
 * @see LineAccountQuotaClient for why this is an object rather than a bare
 *   `fetch`: the account id is not bookkeeping, it is half of the question.
 */
export interface LineAccountQuotaContext {
  /**
   * The pool account this reading is for.
   *
   * Load-bearing, not decoration: a line remembers a quota snapshot against the
   * account it was read for, so a reader that cannot name the account has its
   * snapshot stored under no key at all — and the NEXT account's read is then
   * answered from the previous account's cache with the previous account's
   * numbers. That is exactly the failure this whole hook exists to fix.
   */
  accountId: string
  /**
   * The HTTP client for this one read.
   *
   * It already carries the row's deadline as its `signal`, so a client that
   * honours `signal` is cancelled by the budget rather than merely abandoned.
   * The reader must not replace it with a longer-lived one.
   */
  fetchFn: typeof fetch
}

/**
 * One line's quota client, as the composition hands it over.
 *
 * The payload is the line's OWN DTO, `unknown` here on purpose: this module
 * reads no line's types, and the pure mapping from that DTO to
 * {@link LineAccountQuotaReading} lives beside the normalizers in
 * `line-quota.ts` ({@link LINE_ACCOUNT_QUOTA_READERS} names which one applies).
 *
 * @param credentials - This account's credential, from the pool kernel.
 * @param context - Which account, and the client to read it with.
 * @returns The line's raw quota payload; null when the line measured nothing.
 */
export type LineAccountQuotaClient = (
  credentials: unknown,
  context: { fetchFn: typeof fetch; accountId: string },
) => Promise<unknown>

/**
 * One line's per-account quota reader: credentials in, the row's two facts out.
 *
 * @param credentials - This account's credential, from the pool kernel. Never a
 *   credential this module chose a different account for: the row and the
 *   reading must describe the same account.
 * @param context - Which account, and the client to read it with.
 * @returns The reading, or null when this account's quota was not measurable.
 */
export type LineAccountQuotaReader = (
  credentials: unknown,
  context: LineAccountQuotaContext,
) => Promise<LineAccountQuotaReading | null>

/**
 * A line's reader, once its client is known.
 *
 * A factory rather than a plain function so the assembly of "which bucket /
 * which window" stays HERE while "how to reach that line's upstream" stays in
 * the composition: {@link createAccountQuotaReaders} hands the client in, and a
 * line whose client was not injected simply produces no reader at all.
 */
export type LineAccountQuotaReaderFactory = (
  client: LineAccountQuotaClient,
) => LineAccountQuotaReader

/**
 * THE per-account quota hook table: line id → how that line's readings are made.
 *
 * Keying it by line id is the whole point: a card names a line, a row names an
 * account, and a line with no entry here keeps EXACTLY the behaviour it had
 * before this table existed. That is not a fallback nobody exercised — it is the
 * default for nine of the eleven lines.
 *
 * Nothing in this table imports a line. Each entry needs that line's client and
 * receives it ({@link LineAccountQuotaClient}); a future line adds one entry
 * here plus one injected client, and no other module has to learn about it.
 *
 * What justified the two entries:
 *
 * - `qoder` — the line's `quota/usage` snapshot states absolute buckets, not a
 *   percentage; {@link qoderAccountQuotaReading} derives a share only when a
 *   bucket bounded it (total > 0) AND stated what was used. No bounded bucket,
 *   no bar.
 * - `minimax-code` — the Token Plan states a 5-hour (`interval`) and a weekly
 *   window; the row draws the 5-hour one, because that is the tightest limit the
 *   plan has ({@link minimaxAccountQuotaReading}). The weekly window is never
 *   substituted for it.
 */
export const LINE_ACCOUNT_QUOTA_READERS: Readonly<Record<string, LineAccountQuotaReaderFactory | undefined>> = {
  qoder: (client) => async (credentials, context) => (
    qoderAccountQuotaReading(await client(credentials, context))
  ),
  'minimax-code': (client) => async (credentials, context) => (
    minimaxAccountQuotaReading(await client(credentials, context))
  ),
}

/**
 * The readers in force, built from the clients the composition injected.
 *
 * A line whose client was not injected gets NO reader, which is what keeps the
 * hook optional in practice and not merely on paper: a composition that hands
 * over none of these reads every card exactly as it did before.
 *
 * @param clients - Line id → that line's quota client. Omitted or partial is the
 *   normal case, not an error.
 * @returns Line id → the reader for it; lines without both halves are absent.
 */
export function createAccountQuotaReaders(
  clients: Readonly<Record<string, LineAccountQuotaClient | undefined>> | undefined,
): Readonly<Record<string, LineAccountQuotaReader | undefined>> {
  const readers: Record<string, LineAccountQuotaReader | undefined> = {}
  if (clients === undefined) return readers
  for (const [line, factory] of Object.entries(LINE_ACCOUNT_QUOTA_READERS)) {
    const client = clients[line]
    if (client === undefined || factory === undefined) continue
    readers[line] = factory(client)
  }
  return readers
}

/**
 * The part of a pool this registry drives.
 *
 * All three methods are the shared pool kernel's own, which is why the pool
 * mapping can be one generic adapter instead of eleven: the row DTO is shared
 * and the three calls are shared.
 */
export interface LineAccountSource {
  listAccounts(): Promise<PoolAccountSummaryDto[]>
  setPrimary(accountId: string): Promise<void>
  setStrategy(strategy: AccountRotationStrategy): Promise<void>
  /**
   * The whole pool document, for the two facts a list of rows cannot state:
   * the ACTIVE account (a pool may have none yet) and the rotation strategy.
   *
   * Optional because not every line exposes it; when it is absent the strategy
   * is reported as the pool's own default and the active account is the primary
   * row, which is what a sequential pool resolves to anyway.
   */
  read?(): Promise<unknown>
  /**
   * One NAMED account's credential, renewed if it is about to expire.
   *
   * This is the shared pool kernel's own `getFreshCredential`, narrowed to what
   * a quota read needs. It is the right method rather than the routing one for
   * the reason the kernel already documents: reading a quota is not serving a
   * request, so it addresses an account by id, ignores cooldowns and the pin,
   * and writes no rotation bookkeeping — switching accounts, spending the
   * rotation state or promoting a row is explicitly NOT something a card may do
   * behind the user's back.
   *
   * Optional: absent on a source that cannot hand a credential over, and a line
   * whose source does not have it simply gets no per-account reading.
   *
   * A refresh here is the pool's own single-flight renewal, and it is the one
   * write this hook can cause — the same write the settings card's quota read
   * causes on the same method. This module writes no credential file of its own.
   */
  getFreshCredential?(accountId: string, fetchFn?: typeof fetch): Promise<unknown>
}

/** What {@link createLineRegistry} is handed. */
export interface LineRegistryOptions {
  /** This host's own origin, resolved lazily so a not-yet-bound port is not fatal at load. */
  origin(): string
  /** Line id → the pool to drive. A line with no entry is reported uninstalled. */
  pools: Readonly<Record<string, LineAccountSource | undefined>>
  /** Test seam: the HTTP client. Defaults to the global fetch. */
  fetchFn?: typeof fetch
  /** Test seam: the whole-read budget in milliseconds. */
  timeoutMs?: number
  /**
   * Line id → that line's quota client, for the lines that opt in to a
   * per-account reading.
   *
   * Injected rather than imported so this module stays free of every line's
   * implementation (and of the process-wide caches those modules keep): the
   * composition already holds all of them, because it is where the pools are
   * wired. A line with no client here — which is nine of eleven today — keeps
   * the behaviour it had before this option existed.
   */
  accountQuotaClients?: Readonly<Record<string, LineAccountQuotaClient | undefined>>
  /** Test seam: how long one SUCCESSFUL (line, account) reading is reused. */
  accountQuotaCacheMs?: number
  /** Test seam: how long a FAILED (line, account) reading is reused. */
  accountQuotaFailureCacheMs?: number
  /** Test seam: one account's own read budget in milliseconds. */
  accountQuotaTimeoutMs?: number
  /**
   * Test seam: the budget for the WHOLE per-account stage in milliseconds,
   * which is what bounds the card rather than any one row.
   */
  accountQuotaWholeBudgetMs?: number
  /** Test seam: how many accounts one read may spend a request on. */
  accountQuotaMaxAccounts?: number
  /** Test seam: the lines to serve. Defaults to {@link LINE_DEFINITIONS}. */
  definitions?: readonly LineDefinition[]
}

/** The registry a card reads through. */
export interface LineRegistry {
  /** Every line this registry serves, in display order. */
  readonly definitions: readonly LineDefinition[]
  /** The ids {@link LineRegistry.read} accepts. */
  ids(): string[]
  /** Read one line's card. Throws for an unknown line. */
  read(line: string, signal?: AbortSignal): Promise<LineCardData>
  /** POST the line's own refresh route, then read its card. */
  refresh(line: string, signal?: AbortSignal): Promise<LineCardData>
  /** Pin one of the line's pooled accounts, then read its card. */
  switchAccount(line: string, accountId: string, signal?: AbortSignal): Promise<LineCardData>
  /** Change the line's rotation strategy, then read its card. */
  changeStrategy(line: string, strategy: string, signal?: AbortSignal): Promise<LineCardData>
}

/** A JSON object, as this module reads one. */
type JsonRecord = Record<string, unknown>

/**
 * The payload as a JSON object, or null.
 *
 * @param value - Candidate.
 * @returns The object, or null.
 */
function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null
}

/**
 * A trimmed non-empty string, or null.
 *
 * @param value - Candidate.
 * @returns The trimmed text, or null.
 */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A rotation strategy, with the pool kernel's own fallback.
 *
 * @param value - Candidate.
 * @returns The strategy, defaulting to `sequential`.
 */
function normalizeStrategy(value: unknown): AccountRotationStrategy {
  return value === 'round-robin' || value === 'sticky' ? value : 'sequential'
}

/**
 * A consumed share, clamped into the bar it is drawn as.
 *
 * @param value - Share in percent.
 * @returns The share between 0 and 100.
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * One error as the sentence a card can show.
 *
 * @param error - The caught value.
 * @param label - The line it happened on.
 * @param timeoutMs - The budget that may have expired.
 * @returns A short, user-facing reason.
 */
function reasonOf(error: unknown, label: string, timeoutMs: number): string {
  const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  if (timedOut) return label + ' 的接口在 ' + timeoutMs + ' 毫秒内没有响应。 (Timed out.)'
  return error instanceof Error ? error.message : String(error)
}

/** One abort budget: a deadline, plus the caller's own cancellation. */
interface Budget {
  signal: AbortSignal
  dispose(): void
}

/**
 * A deadline, combined with the caller's cancellation when one was passed.
 *
 * @param timeoutMs - The budget in milliseconds.
 * @param caller - The capability's own signal, when it has one.
 * @returns The signal to hand to fetch, and the disposer that clears the timer.
 */
function budgetOf(timeoutMs: number, caller?: AbortSignal): Budget {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  const timerHandle = timer as unknown as { unref?: () => void }
  timerHandle.unref?.()
  const forward = (): void => {
    controller.abort(caller?.reason)
  }
  if (caller !== undefined) {
    if (caller.aborted) forward()
    else caller.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', forward)
    },
  }
}

/**
 * A promise that rejects once the budget expires.
 *
 * Applied to the LOCAL pool read as well as to HTTP: a credential store that
 * hangs (a stuck keychain, a locked file) must not hold the card either.
 *
 * @param promise - The work.
 * @param timeoutMs - The budget.
 * @param label - The line it belongs to.
 * @returns The work's value.
 */
function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label + ' 的本地读取超过 ' + timeoutMs + ' 毫秒。 (Local read timed out.)'))
    }, timeoutMs)
    const timerHandle = timer as unknown as { unref?: () => void }
    timerHandle.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * The reason a failed response states, when it states one.
 *
 * The routes answer their own failures in the same envelope
 * (`{ ok: false, error: '…' }`), and that sentence is what tells a user what to
 * do ("every account is disabled", "not signed in"). Reporting only the status
 * code would throw it away.
 *
 * @param response - The failed response.
 * @returns The stated reason, or null when the body states none.
 */
async function failureDetail(response: Response): Promise<string | null> {
  try {
    const body = asRecord(await response.json() as unknown)
    const detail = body?.error
    if (typeof detail === 'string' && detail.trim() !== '') return detail.trim()
    const message = body?.message
    return typeof message === 'string' && message.trim() !== '' ? message.trim() : null
  } catch {
    return null
  }
}

/**
 * One line's status payload, or the reason there is none.
 *
 * The route answers the { ok, value } envelope every settings route of this
 * plugin uses, so `ok` is checked here once and the caller never has to know
 * about the envelope.
 */
type StatusRead = { value: unknown } | { error: string }

/**
 * Read one line's status route over loopback.
 *
 * @param definition - The line.
 * @param options - Where to reach the host and with what.
 * @param timeoutMs - The budget.
 * @param signal - The caller's cancellation.
 * @returns The payload, or the reason it could not be read.
 */
async function readStatus(
  definition: LineDefinition,
  options: LineRegistryOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StatusRead> {
  const budget = budgetOf(timeoutMs, signal)
  const client = options.fetchFn ?? fetch
  try {
    const url = originOf(options) + definition.statusPath
    const response = await client(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: budget.signal,
    })
    if (!response.ok) {
      const detail = await failureDetail(response)
      return {
        error: definition.label + ' 的 status 路由返回 HTTP ' + response.status
          + (detail === null ? '。' : '：' + detail + '。')
          + ' (Status route failed.)',
      }
    }
    const body = asRecord(await response.json() as unknown)
    if (body === null) {
      return { error: definition.label + ' 的 status 响应不是 JSON 对象。 (Status payload is not an object.)' }
    }
    if (body.ok !== true) {
      const detail = nonEmpty(typeof body.error === 'string' ? body.error : null)
      return { error: definition.label + ' 的 status 路由报告失败：' + (detail ?? 'ok 不是 true') + '。 (Status route reported a failure.)' }
    }
    return { value: body.value }
  } catch (error) {
    return { error: reasonOf(error, definition.label, timeoutMs) }
  } finally {
    budget.dispose()
  }
}

/**
 * The origin, resolved at call time.
 *
 * Lazy on purpose: the web server may not have bound a port when this provider
 * registers, and an origin resolved then would be a guess that outlives the
 * fact. A failure here is reported per card, not thrown at load.
 *
 * @param options - The registry options.
 * @returns The origin, without a trailing slash.
 */
function originOf(options: LineRegistryOptions): string {
  const origin = options.origin()
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/**
 * What a failed refresh reported.
 *
 * `stillRunning` separates the two failures that need different words: a route
 * that REFUSED (no account to read, not signed in) is done and wrong, while the
 * route that simply outlived our budget is usually still working — several of
 * these lines hold the POST open until their upstream answer lands.
 */
interface RefreshOutcome {
  message: string
  stillRunning: boolean
}

/**
 * POST one line's own refresh route.
 *
 * The body is an empty JSON object rather than nothing: several of these routes
 * parse a JSON body before dispatching, and a request stating `content-length:
 * 0` is one they would refuse. The `origin` header is what the routes'
 * same-origin check compares against the `Host` they were addressed to — this
 * call is the host asking itself, so the two agree.
 *
 * @param definition - The line.
 * @param options - Where to reach the host and with what.
 * @param timeoutMs - The budget.
 * @param signal - The caller's cancellation.
 * @returns The outcome when the refresh failed, or null when it landed.
 */
async function postRefresh(
  definition: LineDefinition,
  options: LineRegistryOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RefreshOutcome | null> {
  const path = definition.refreshPath
  if (path === null) return null
  const budget = budgetOf(timeoutMs, signal)
  const client = options.fetchFn ?? fetch
  let origin: string
  try {
    origin = originOf(options)
  } catch (error) {
    budget.dispose()
    return { message: reasonOf(error, definition.label, timeoutMs), stillRunning: false }
  }
  try {
    const response = await client(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: '{}',
      signal: budget.signal,
    })
    if (!response.ok) {
      const detail = await failureDetail(response)
      return {
        message: definition.label + ' 的刷新路由返回 HTTP ' + response.status
          + (detail === null ? '。' : '：' + detail + '。')
          + ' (Refresh route failed.)',
        stillRunning: false,
      }
    }
    // The response body is not read: the refresh already wrote whatever it
    // learned, and the status read that follows is the authority on it.
    return null
  } catch (error) {
    // Our own deadline, rather than the caller's cancellation: the line is very
    // likely still reading upstream (several of these routes hold the POST open
    // until their quota answer lands), so the card that follows shows the
    // previous snapshot with `refreshing: true` rather than a bare timeout.
    if (budget.signal.aborted && !(signal?.aborted ?? false)) {
      return {
        message: definition.label + ' 的刷新在 ' + timeoutMs + ' 毫秒内没有返回；线路仍在刷新，卡片读到的是它上一次的快照。'
          + ' (The refresh did not answer within the budget; the line is still refreshing.)',
        stillRunning: true,
      }
    }
    return { message: reasonOf(error, definition.label, timeoutMs), stillRunning: false }
  } finally {
    budget.dispose()
  }
}

/**
 * One deadline applied to every request a fetch makes.
 *
 * The per-account readers are handed a client, not a signal, so the budget has
 * to travel inside the client: a reader that keeps the `fetch` it was given is
 * then cancelled at the deadline instead of merely being ignored while its
 * socket stays open. A caller's own signal is respected when it already carries
 * one — this ADDS a deadline, it never loosens one.
 *
 * @param fetchFn - The client to wrap.
 * @param signal - The deadline to attach.
 * @returns A client whose requests carry it.
 */
function withDeadline(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  type Input = Parameters<typeof fetch>[0]
  const boundedFetch = async (input: Input, init?: RequestInit): Promise<Response> =>
    await fetchFn(input, init === undefined ? { signal } : { ...init, signal: init.signal ?? signal })
  return boundedFetch as typeof fetch
}

/** A function that runs `work` while holding one of `limit` slots. */
type Gate = <T>(work: () => Promise<T>) => Promise<T>

/**
 * A counting gate: at most `limit` callers run `work` at the same time.
 *
 * The slot is handed straight to the next waiter rather than released and
 * re-taken, so `active` can never exceed the limit by one in the window between
 * two arrivals — the reason a naive decrement-then-increment leaks.
 *
 * @param limit - How many may run at once.
 * @returns The gated runner.
 */
function gateOf(limit: number): Gate {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active < limit) active += 1
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next === undefined) active -= 1
      else next()
    }
  }
}

/** One cached per-account reading. */
interface CachedAccountQuota {
  /** When it was made, for the TTL. */
  at: number
  /** What it said; null is a remembered FAILURE, not a missing entry. */
  reading: LineAccountQuotaReading | null
}

/**
 * How long one cached entry stays fresh.
 *
 * The two tiers are the point: a good reading waits out the poll interval, a
 * failed one is retried soon (see the two TTL constants).
 *
 * @param entry - The cached entry.
 * @param runtime - Where the two TTLs live.
 * @returns Its lifetime in milliseconds.
 */
function lifetimeOf(entry: CachedAccountQuota, runtime: AccountQuotaRuntime): number {
  return entry.reading === null ? runtime.failureCacheMs : runtime.cacheMs
}

/**
 * The state one registry keeps for the per-account hook.
 *
 * Per registry rather than per module so nothing here outlives the provider that
 * built it: unloading the plugin drops the cache with the registry, and two
 * instances in one test process cannot see each other's readings.
 */
interface AccountQuotaRuntime {
  /** Line id → reader, already filtered to the lines that opted in. */
  readonly readers: Readonly<Record<string, LineAccountQuotaReader | undefined>>
  /** (line, account) → the reading, failed ones included. */
  readonly cache: Map<string, CachedAccountQuota>
  /** (line, account) → the read already in flight for it, so two cards share one. */
  readonly pending: Map<string, Promise<LineAccountQuotaReading | null>>
  /** The concurrency gate every read passes through. */
  readonly gate: Gate
  /** How long a SUCCESSFUL reading is reused. */
  readonly cacheMs: number
  /** How long a FAILED reading is reused — shorter, so a recovery shows up fast. */
  readonly failureCacheMs: number
  /** How long one account's read may take. */
  readonly timeoutMs: number
  /** How long the WHOLE per-account stage may take — the card's real ceiling. */
  readonly wholeBudgetMs: number
  /** How many accounts one stage may spend a request on. */
  readonly maxAccounts: number
}

/**
 * Read ONE account's own quota, absorbing every failure.
 *
 * The two steps — the credential, then the upstream answer — share one budget,
 * because the row is one question: a credential that took two of the five
 * seconds must not buy the read a second full allowance.
 *
 * @param definition - The line, for the label a diagnostic would state.
 * @param accountId - The account being read.
 * @param credentialFor - The pool's per-account credential resolver.
 * @param reader - The line's reader.
 * @param fetchFn - The client to read through.
 * @param runtime - The budgets, and the caller's cancellation.
 * @param signal - The card's own cancellation, when it has one.
 * @returns The reading, or null for "nothing measured, one way or another".
 */
async function readOneAccountQuota(
  definition: LineDefinition,
  accountId: string,
  credentialFor: (accountId: string, fetchFn: typeof fetch) => Promise<unknown>,
  reader: LineAccountQuotaReader,
  fetchFn: typeof fetch,
  runtime: AccountQuotaRuntime,
  signal?: AbortSignal,
): Promise<LineAccountQuotaReading | null> {
  const budget = budgetOf(runtime.timeoutMs, signal)
  const client = withDeadline(fetchFn, budget.signal)
  try {
    return await bounded((async (): Promise<LineAccountQuotaReading | null> => {
      const credentials = await credentialFor(accountId, client)
      const reading = await reader(credentials, { accountId, fetchFn: client })
      // A reading that states no share is not a reading: the contract's null
      // means "nobody measured this", and a row with a reset but no bar would
      // be a half-known fact drawn as if it were whole.
      if (reading === null || reading.usedPercent === null || !Number.isFinite(reading.usedPercent)) return null
      const resetsAt = reading.resetsAt !== null && Number.isFinite(reading.resetsAt) ? reading.resetsAt : null
      return {
        usedPercent: clampPercent(reading.usedPercent),
        resetsAt,
        // Carried through rather than rebuilt from the bar: the list is the
        // line's own answer about this account, and dropping it here would be
        // the one place a read window list silently became an empty one.
        windows: Array.isArray(reading.windows) ? reading.windows : [],
      }
    })(), runtime.timeoutMs, definition.label)
  } catch {
    // The row keeps the pool's own snapshot, the card keeps its error field
    // empty, and every other row is untouched: a per-account reading is
    // decoration on a row that is already complete without it.
    return null
  } finally {
    budget.dispose()
  }
}

/** The per-account half of one card, as the hook produced it. */
interface AccountQuotaFacts {
  /**
   * Whether a per-account read is in force for this line AT ALL.
   *
   * This is what decides whether a row carries `windows` at all: a hooked line
   * reports the list it managed to read (`[]` included), while a line with no
   * hook reports nothing rather than claiming it was asked and found empty.
   */
  hooked: boolean
  /** Account id → its reading (null included). */
  readings: Map<string, LineAccountQuotaReading | null>
}

/**
 * The accounts one read spends its requests on, in the order it spends them.
 *
 * Primary first, then most recently used, because a cap has to drop SOMETHING and
 * the rows it drops should be the ones a reader is least likely to be looking at.
 * The sort is stable on purpose: rows that tie on both keys keep the pool's own
 * order, so two reads of an unchanged pool pick the same eight and the window
 * does not flicker between polls.
 *
 * @param accounts - Every pooled account, as the pool stated them.
 * @param limit - How many may be read at most; zero or less means no cap.
 * @returns The accounts to read, in the order their requests should start.
 */
function accountsForReading(
  accounts: readonly PoolAccountSummaryDto[],
  limit: number,
): PoolAccountSummaryDto[] {
  const ordered = [...accounts].sort((left, right) => {
    const primary = (right.isPrimary ? 1 : 0) - (left.isPrimary ? 1 : 0)
    if (primary !== 0) return primary
    // Newest first; an account that was never used sorts last.
    return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
  })
  return limit > 0 ? ordered.slice(0, limit) : ordered
}

/**
 * The value a per-account read settles to when the stage budget expired first.
 *
 * A sentinel rather than `null` on purpose: `null` means "this account WAS asked
 * and measured nothing", which the row draws as an empty window list and the cache
 * remembers as a failure. A row the stage budget never reached was never asked, so
 * remembering it would be wrong — and not remembering it is exactly what keeps the
 * promise that the next read tries it again.
 */
const STAGE_BUDGET_SPENT = Symbol('per-account stage budget spent')

/**
 * A promise that settles the moment `signal` aborts, and never rejects.
 *
 * Racing a read against this is how the stage budget cuts a row off: the row stops
 * being awaited, while the read itself is cancelled through the same signal it was
 * handed ({@link readOneAccountQuota}), so no gate slot is held afterwards.
 *
 * @param signal - The stage's own deadline.
 * @returns The sentinel, once the deadline passes.
 */
function whenSpent(signal: AbortSignal): Promise<typeof STAGE_BUDGET_SPENT> {
  return new Promise<typeof STAGE_BUDGET_SPENT>((resolve) => {
    if (signal.aborted) {
      resolve(STAGE_BUDGET_SPENT)
      return
    }
    signal.addEventListener('abort', () => resolve(STAGE_BUDGET_SPENT), { once: true })
  })
}

/**
 * Every account's own reading this card can afford.
 *
 * Two bounds decide "can afford", and they answer different questions: HOW MANY
 * rows are worth a request ({@link LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS}, primary and
 * most-recently-used first) and HOW LONG the stage may hold the card
 * ({@link LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS}). Neither replaces the per-account
 * budget, which still stops one hanging row from spending the stage's whole
 * allowance alone.
 *
 * @param definition - The line.
 * @param pool - The account half, already read.
 * @param source - The line's pool, for its per-account credential resolver.
 * @param runtime - Readers, cache, gate and budgets.
 * @param fetchFn - The client the pool and the readers use.
 * @param signal - The card's own cancellation.
 * @returns The readings per account id (null included, so a remembered failure
 *   is distinguishable from an absent entry), and whether the line is hooked;
 *   both empty/false for a line that did not opt in, in which case every row
 *   keeps the pool's own snapshot and states no window list.
 */
async function readAccountQuotas(
  definition: LineDefinition,
  pool: PoolFacts,
  source: LineAccountSource | undefined,
  runtime: AccountQuotaRuntime,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<AccountQuotaFacts> {
  const readings = new Map<string, LineAccountQuotaReading | null>()
  const reader = runtime.readers[definition.id]
  const credentialFor = source?.getFreshCredential
  const hooked = reader !== undefined && credentialFor !== undefined
  if (reader === undefined || credentialFor === undefined || pool.accounts.length === 0) return { hooked, readings }
  const now = Date.now()
  for (const [key, entry] of runtime.cache) {
    if (now - entry.at >= lifetimeOf(entry, runtime)) runtime.cache.delete(key)
  }
  // Read the cheap rows and skip the rest: a line with hundreds of accounts would
  // otherwise open one credential lookup and one upstream request per row on every
  // poll, and the rows past the first few could never be reached before the stage
  // budget closed anyway. The cap is applied to the ORDERING, not to the answer:
  // every account still gets a row, it just keeps its blank instead of queueing.
  const selected = accountsForReading(pool.accounts, runtime.maxAccounts)
  // ONE deadline for the whole stage. The per-account budget below still bounds a
  // single row; this bounds the SUM, so the card costs 6 s rather than
  // ceil(accounts / concurrency) × 5 s however many accounts the pool holds.
  const stage = runtime.wholeBudgetMs > 0 ? budgetOf(runtime.wholeBudgetMs, signal) : null
  const spent = stage === null ? null : whenSpent(stage.signal)
  // Bound to the pool it came from, once: the resolver is the kernel's method, and
  // a detached call would lose the `this` its own pool state lives on.
  const credentialed = credentialFor.bind(source)
  try {
    await Promise.all(selected.map(async (account) => {
      const key = definition.id + '\u0000' + account.id
      const cached = runtime.cache.get(key)
      if (cached !== undefined && now - cached.at < lifetimeOf(cached, runtime)) {
        readings.set(account.id, cached.reading)
        return
      }
      let flight = runtime.pending.get(key)
      if (flight === undefined) {
        // The row's own budget, but handed the STAGE's signal as its caller — so a
        // read the stage abandoned is cancelled rather than left holding a slot.
        flight = runtime.gate(async () => await readOneAccountQuota(
          definition, account.id, credentialed, reader, fetchFn, runtime, stage?.signal ?? signal,
        ))
        runtime.pending.set(key, flight)
        const settle = (): void => {
          if (runtime.pending.get(key) === flight) runtime.pending.delete(key)
        }
        void flight.then(settle, settle)
      }
      const reading = spent === null ? await flight : await Promise.race([flight, spent])
      // The stage closed under this row. It is NOT a failure and must not be
      // remembered as one: leaving the cache untouched is what makes the next read
      // (or a manual refresh) try this account again, while the row itself keeps
      // its blank — `usedPercent: null`, no window list, no card error.
      if (reading === STAGE_BUDGET_SPENT) return
      runtime.cache.set(key, { at: Date.now(), reading })
      readings.set(account.id, reading)
    }))
  } finally {
    stage?.dispose()
  }
  return { hooked, readings }
}

/** The account half of a card, as the pool states it. */
interface PoolFacts {
  installed: boolean
  accounts: PoolAccountSummaryDto[]
  activeAccountId: string | null
  strategy: AccountRotationStrategy
  error: string | null
}

/**
 * The account half of a card, from the pool itself.
 *
 * Both calls are attempted even when one fails: listAccounts and read read the
 * same document through different paths, and a pool that answers rows but not
 * its document (or the reverse) still describes most of itself.
 *
 * @param pool - The line's pool, if it has one.
 * @param definition - The line.
 * @param timeoutMs - The budget.
 * @returns The facts.
 */
async function readPool(
  pool: LineAccountSource | undefined,
  definition: LineDefinition,
  timeoutMs: number,
): Promise<PoolFacts> {
  if (pool === undefined) {
    return { installed: false, accounts: [], activeAccountId: null, strategy: 'sequential', error: null }
  }
  const listTask = bounded(pool.listAccounts(), timeoutMs, definition.label)
  const documentTask = pool.read === undefined
    ? Promise.resolve(undefined as unknown)
    : bounded(pool.read(), timeoutMs, definition.label)
  const [list, document] = await Promise.allSettled([listTask, documentTask])
  const accounts = list.status === 'fulfilled' ? list.value : []
  const failure = list.status === 'rejected'
    ? reasonOf(list.reason, definition.label, timeoutMs)
    : document.status === 'rejected' ? reasonOf(document.reason, definition.label, timeoutMs) : null
  const record = document.status === 'fulfilled' ? asRecord(document.value) : null
  const primary = accounts.find((account) => account.isPrimary === true)
  const statedActive = nonEmpty(typeof record?.activeAccountId === 'string' ? record.activeAccountId : null)
  return {
    installed: true,
    accounts,
    // A pool that never promoted an account (a single-credential install
    // projected as a row) still resolves to its primary row.
    activeAccountId: statedActive ?? primary?.id ?? null,
    strategy: normalizeStrategy(record?.rotationStrategy),
    error: failure,
  }
}

/**
 * One pooled account as the card renders it.
 *
 * @param account - The pool's own summary.
 * @param reading - This account's own newest reading, when the line produced
 *   one; null/absent means the line has no hook, the read failed, or it measured
 *   nothing — and all three leave the pool's own snapshot standing.
 * @param hooked - Whether a per-account read is in force for this line at all,
 *   which is what decides whether the row states a window list. Defaults to
 *   false so a caller with no hook knowledge omits it rather than inventing an
 *   empty list.
 * @returns The row.
 */
function accountRow(
  account: PoolAccountSummaryDto,
  reading?: LineAccountQuotaReading | null,
  hooked = false,
): LineCardAccount {
  const window = account.quota?.windows[0]
  // The hook's reading wins when it stated a share: it was made FOR this
  // account within the last minute, while the pool's snapshot describes the
  // single account that happened to be read. Its reset is preferred, but the
  // pool's is kept when the reader stated none — same account, same window, and
  // a bar with a known reset is more use than a bar with a gap beside it.
  const own = reading === null || reading === undefined ? null : reading
  const ownUsed = own === null || own.usedPercent === null ? null : clampPercent(own.usedPercent)
  return {
    id: account.id,
    // Never blank: a row without a name is unclickable in a list.
    label: nonEmpty(account.alias) ?? nonEmpty(account.email) ?? account.id,
    email: account.email ?? null,
    primary: account.isPrimary === true,
    plan: account.planLabel ?? null,
    cooldownUntil: account.cooldownUntil ?? null,
    authStatus: account.authStatus ?? null,
    // The account's own newest reading, not the line-level one: quota follows
    // the account, and a row showing another account's meter answers a
    // question nobody asked.
    usedPercent: ownUsed ?? (window === undefined ? null : clampPercent(window.usedPercent)),
    resetsAt: ownUsed === null ? window?.resetsAt ?? null : own?.resetsAt ?? window?.resetsAt ?? null,
    // Present ONLY where a per-account read is in force. `[]` there is a
    // measurement ("asked, found nothing"), while omitting the key is the honest
    // statement about a line that is never asked — and a card that drew both the
    // same way would report a read nobody made.
    ...(hooked ? { windows: own?.windows ?? [] } : {}),
  }
}

/**
 * One line's whole card: the halves read and merged.
 *
 * The quota half starts first because the per-account readings need the account
 * rows to know which accounts exist; both then run while it answers, so the card
 * still costs one budget rather than two.
 *
 * @param definition - The line.
 * @param options - The registry options.
 * @param quota - The per-account hook state (readers, cache, gate, budgets).
 * @param timeoutMs - The budget.
 * @param signal - The caller's cancellation.
 * @returns Shape C.
 */
async function readCard(
  definition: LineDefinition,
  options: LineRegistryOptions,
  quota: AccountQuotaRuntime,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LineCardData> {
  const source = options.pools[definition.id]
  const statusTask = readStatus(definition, options, timeoutMs, signal)
  // The account half first: the per-account reads need the rows to know which
  // accounts exist, and both of the other two run while it answers, so the card
  // still costs one budget rather than two.
  const pool = await readPool(source, definition, timeoutMs)
  const [status, accountQuotas] = await Promise.all([
    statusTask,
    readAccountQuotas(definition, pool, source, quota, options.fetchFn ?? fetch, signal),
  ])
  const facts: LineQuotaFacts | null = 'error' in status ? null : definition.normalize(status.value)
  const transportError = 'error' in status ? status.error : null
  const primary = pool.accounts.find((account) => account.id === pool.activeAccountId)
    ?? pool.accounts.find((account) => account.isPrimary === true)
    ?? pool.accounts[0]
  return {
    line: definition.id,
    label: definition.label,
    // Either authority saying "a credential exists" is enough. The line's own
    // verdict describes the credential that served its LAST upstream call
    // (one that just got a 401 reads as signed out), while a pool row that is
    // not marked unusable describes whether the line CAN serve at all — and a
    // line with a routable account has not signed out, it failed once.
    signedIn: facts?.signedIn === true
      || pool.accounts.some((account) => account.authStatus === undefined || account.authStatus === 'ok'),
    installed: pool.installed,
    planLabel: facts?.planLabel ?? null,
    // The line's own label first: it is the one place a masked address is
    // stated, and a card then shows exactly what the settings page shows.
    accountLabel: facts?.accountLabel ?? nonEmpty(primary?.email) ?? null,
    accounts: pool.accounts.map((account) => accountRow(
      account,
      accountQuotas.readings.get(account.id),
      accountQuotas.hooked,
    )),
    activeAccountId: pool.activeAccountId ?? primary?.id ?? null,
    strategy: pool.strategy,
    quota: facts?.quota ?? null,
    error: transportError ?? facts?.error ?? pool.error,
  }
}

/**
 * Build a registry over the injected line → pool mapping.
 *
 * @param options - The mapping, the origin and the seams.
 * @returns The registry.
 */
export function createLineRegistry(options: LineRegistryOptions): LineRegistry {
  const definitions = options.definitions ?? LINE_DEFINITIONS
  const timeoutMs = options.timeoutMs ?? LINE_HTTP_TIMEOUT_MS
  // Built once, here: the readers, the cache and the gate belong to ONE registry
  // instance, so dropping the provider that built it drops all three.
  const accountQuota: AccountQuotaRuntime = {
    readers: createAccountQuotaReaders(options.accountQuotaClients),
    cache: new Map<string, CachedAccountQuota>(),
    pending: new Map<string, Promise<LineAccountQuotaReading | null>>(),
    gate: gateOf(LINE_ACCOUNT_QUOTA_CONCURRENCY),
    cacheMs: options.accountQuotaCacheMs ?? LINE_ACCOUNT_QUOTA_CACHE_MS,
    failureCacheMs: options.accountQuotaFailureCacheMs ?? LINE_ACCOUNT_QUOTA_FAILURE_CACHE_MS,
    timeoutMs: options.accountQuotaTimeoutMs ?? LINE_ACCOUNT_QUOTA_TIMEOUT_MS,
    wholeBudgetMs: options.accountQuotaWholeBudgetMs ?? LINE_ACCOUNT_QUOTA_WHOLE_BUDGET_MS,
    maxAccounts: options.accountQuotaMaxAccounts ?? LINE_ACCOUNT_QUOTA_MAX_ACCOUNTS,
  }
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  const definitionOf = (line: string): LineDefinition => {
    const found = byId.get(line)
    if (found !== undefined) return found
    throw new Error(
      '未知线路「' + line + '」：这个注册表里没有它。'
      + ' (Unknown line "' + line + '"; known lines: ' + definitions.map((entry) => entry.id).join(', ') + '.)',
    )
  }
  const poolOf = (definition: LineDefinition): LineAccountSource | undefined => options.pools[definition.id]
  return {
    definitions,
    ids: () => definitions.map((definition) => definition.id),
    read: async (line, signal) => await readCard(definitionOf(line), options, accountQuota, timeoutMs, signal),
    refresh: async (line, signal) => {
      const definition = definitionOf(line)
      const outcome = await postRefresh(definition, options, timeoutMs, signal)
      const card = await readCard(definition, options, accountQuota, timeoutMs, signal)
      // A refresh that failed but left a readable snapshot keeps the snapshot:
      // what the card shows is still true, it is just not newer. Only a card
      // with nothing to draw and no other reason gets the refresh failure.
      if (outcome === null) return card
      if (outcome.stillRunning && card.quota !== null) {
        // Our budget expired, not the line's work: say so, because the snapshot
        // is the previous one and a card that claimed otherwise would be wrong.
        return { ...card, quota: { ...card.quota, refreshing: true } }
      }
      return card.quota !== null || card.error !== null ? card : { ...card, error: outcome.message }
    },
    switchAccount: async (line, accountId, signal) => {
      const definition = definitionOf(line)
      const pool = poolOf(definition)
      if (pool === undefined) {
        throw new Error('「' + definition.label + '」的账号池未安装，没有可切换的账号。 (This line has no account pool.)')
      }
      // setPrimary writes nothing for an unknown id, which would report a
      // switch that never happened; refuse here instead of silently doing
      // nothing.
      const accounts = await pool.listAccounts()
      if (!accounts.some((account) => account.id === accountId)) {
        throw new Error('未知账号「' + accountId + '」：「' + definition.label + '」的号池里没有这个 id。 (Unknown account.)')
      }
      await pool.setPrimary(accountId)
      // Quota follows the account, so the card is re-read whole rather than
      // patched: the windows now belong to a different credential.
      return await readCard(definition, options, accountQuota, timeoutMs, signal)
    },
    changeStrategy: async (line, strategy, signal) => {
      const definition = definitionOf(line)
      const pool = poolOf(definition)
      if (pool === undefined) {
        throw new Error('「' + definition.label + '」的账号池未安装，没有可调整的轮换策略。 (This line has no account pool.)')
      }
      const match = ROTATION_STRATEGIES.find((candidate) => candidate === strategy)
      if (match === undefined) {
        throw new Error(
          '轮换策略只能是 ' + ROTATION_STRATEGIES.join(' / ') + ' 之一，收到的不是其中之一。'
          + ' (The rotation strategy must be one of ' + ROTATION_STRATEGIES.join(', ') + '.)',
        )
      }
      await pool.setStrategy(match)
      return await readCard(definition, options, accountQuota, timeoutMs, signal)
    },
  }
}

/**
 * The line a card names, from its props.
 *
 * @param props - The card's props.
 * @returns The line id.
 */
export function lineOfProps(props: unknown): string {
  const record = asRecord(props)
  const line = nonEmpty(typeof record?.line === 'string' ? record.line : null)
  if (line === null) {
    throw new Error(
      '这张卡片没有 line 属性：line-card 数据源需要 props.line 指明读哪条线路。'
      + ' (This card states no "line" prop; the line-card data source needs one.)',
    )
  }
  return line
}
