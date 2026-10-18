/**
 * Local quota guardrails for the WorkBuddy line.
 *
 * The subscription meters an account × model over a 24h window (429 `code
 * 6004`), but it only says so AFTER the window is gone — and on the shared
 * account that window is minutes of a large model or a day of a small one. These
 * guardrails stop serving BEFORE that happens, so an exhausted window never has
 * to be discovered by a user staring at a 429.
 *
 * Three of the four guardrails workbuddy2api-hub ships are reproduced here, and
 * all three are EXACT — they read numbers this plugin already has:
 *
 *   reserveCredits    stop the account when its remaining credits fall below N
 *                     (the billing snapshot already reports the remainder)
 *   dailyTokens       stop the account for the rest of the local day at N tokens
 *   modelDailyTokens  stop ONE model for the rest of the local day at N tokens
 *
 * The fourth one there — a daily CREDITS budget — is deliberately NOT
 * reproduced: a request's credit cost is not on the wire this route reads, and
 * deriving it from the catalog multiplier × tokens would invent a number that
 * silently diverges from the bill. A guardrail that lies is worse than none.
 *
 * `0` means OFF for every field, and the default is all-off: an install that
 * never opens this setting behaves exactly as before.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import type { WorkBuddyGuardrailsDto } from '../../shared/workbuddy-contracts.ts'

/**
 * The three exact guardrails.
 *
 * The shape has ONE definition — the shared wire contract — so the card and the
 * enforcement can never disagree about a field name.
 */
export type WorkBuddyGuardrails = WorkBuddyGuardrailsDto

/** Shipped default: every guardrail off. */
export const DEFAULT_GUARDRAILS: WorkBuddyGuardrails = {
  reserveCredits: 0,
  dailyTokens: 0,
  modelDailyTokens: 0,
}

function positiveOrZero(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * Keep only well-formed model ids per account, trimmed and deduplicated.
 *
 * An empty list is the same instruction as no entry, so it is dropped: "cleared"
 * and "never set" must not need two code paths.
 */
export function normalizeDisabledModels(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string[]> = {}
  for (const [accountId, models] of Object.entries(value as Record<string, unknown>)) {
    if (accountId === '' || !Array.isArray(models)) continue
    const unique = [...new Set(models
      .filter((model): model is string => typeof model === 'string')
      .map((model) => model.trim())
      .filter((model) => model !== ''))]
    if (unique.length > 0) out[accountId] = unique
  }
  return out
}

/** Narrow a stored or patched value into guardrails; anything unusable means off. */
export function normalizeGuardrails(value: unknown): WorkBuddyGuardrails {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_GUARDRAILS }
  const record = value as Record<string, unknown>
  return {
    reserveCredits: positiveOrZero(record.reserveCredits),
    dailyTokens: positiveOrZero(record.dailyTokens),
    modelDailyTokens: positiveOrZero(record.modelDailyTokens),
  }
}

/** Whether any guardrail is armed; a no-op check must stay cheap. */
export function guardrailsArmed(guardrails: WorkBuddyGuardrails): boolean {
  return guardrails.reserveCredits > 0 || guardrails.dailyTokens > 0 || guardrails.modelDailyTokens > 0
}

/**
 * The local calendar day a counter belongs to.
 *
 * Local, not UTC, because the reset the user reasons about is their own
 * midnight — the same choice this line makes for the CN check-in day.
 */
export function localDayKey(now = Date.now()): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Per-account counters for one day. */
export interface UsageLedgerEntry {
  tokens: number
  perModel: Record<string, number>
}

interface LedgerDocument {
  version: 1
  day: string
  accounts: Record<string, UsageLedgerEntry>
}

/** Where the local usage counters live. */
export function usageLedgerPath(): string {
  return path.join(dshHomeDir(), 'storages', 'workbuddy-usage.json')
}

/**
 * Token counters per account per local day.
 *
 * Deliberately a small persisted document rather than an accounting system: it
 * exists to answer one question ("has this account / model used its day?") and a
 * restart must not forget it, or a guardrail would reset by restarting DSH.
 */
export class WorkBuddyUsageLedger {
  private document: LedgerDocument = { version: 1, day: localDayKey(), accounts: {} }
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath = usageLedgerPath(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the counters once; a missing or unreadable file starts a fresh day. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown
      if (typeof raw !== 'object' || raw === null) return
      const record = raw as Record<string, unknown>
      const accounts = typeof record.accounts === 'object' && record.accounts !== null
        ? record.accounts as Record<string, unknown>
        : {}
      const entries: Record<string, UsageLedgerEntry> = {}
      for (const [accountId, value] of Object.entries(accounts)) {
        if (typeof value !== 'object' || value === null) continue
        const entry = value as Record<string, unknown>
        const perModel: Record<string, number> = {}
        if (typeof entry.perModel === 'object' && entry.perModel !== null) {
          for (const [model, tokens] of Object.entries(entry.perModel as Record<string, unknown>)) {
            if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) perModel[model] = tokens
          }
        }
        entries[accountId] = {
          tokens: typeof entry.tokens === 'number' && Number.isFinite(entry.tokens) ? entry.tokens : 0,
          perModel,
        }
      }
      this.document = {
        version: 1,
        day: typeof record.day === 'string' ? record.day : localDayKey(this.now()),
        accounts: entries,
      }
      this.rollIfNewDay()
    } catch {
      // No counters yet, or an unreadable file: start the day empty rather than
      // refusing to serve.
    }
  }

  /** Drop yesterday's counters the moment a read notices the day changed. */
  private rollIfNewDay(): void {
    const today = localDayKey(this.now())
    if (this.document.day === today) return
    this.document = { version: 1, day: today, accounts: {} }
  }

  /** Tokens one account has used today, across models. */
  tokensToday(accountId: string): number {
    this.rollIfNewDay()
    return this.document.accounts[accountId]?.tokens ?? 0
  }

  /** Tokens one account has used today on one model. */
  modelTokensToday(accountId: string, model: string): number {
    this.rollIfNewDay()
    return this.document.accounts[accountId]?.perModel[model] ?? 0
  }

  /** Today's counters, for the settings card and for tests. */
  snapshot(): Readonly<Record<string, UsageLedgerEntry>> {
    this.rollIfNewDay()
    return this.document.accounts
  }

  /**
   * Add one request's tokens.
   *
   * Serialized through a promise chain: two concurrent requests on different
   * accounts would otherwise read the same document, add their own counts and
   * write, losing one of them.
   */
  async record(accountId: string, model: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    this.rollIfNewDay()
    const entry = this.document.accounts[accountId] ?? { tokens: 0, perModel: {} }
    entry.tokens += Math.floor(tokens)
    entry.perModel[model] = (entry.perModel[model] ?? 0) + Math.floor(tokens)
    this.document.accounts[accountId] = entry
    const write = this.writing.then(() => this.persist())
    this.writing = write.catch(() => undefined)
    await write.catch(() => undefined)
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(this.document, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}

/** Why an account may not serve a request. */
export type GuardrailReason = 'reserve-credits' | 'daily-tokens' | 'model-daily-tokens'

/** The verdict for one account on one model. */
export type GuardrailVerdict =
  | { allowed: true }
  | { allowed: false; reason: GuardrailReason; detail: string }

/**
 * Decide whether one account may serve one model right now.
 *
 * Pure on purpose: every number it reads is passed in, so the decision can be
 * tested without a pool, a clock or a network.
 */
export function evaluateGuardrails(input: {
  guardrails: WorkBuddyGuardrails
  tokensToday: number
  modelTokensToday: number
  /** Remaining credits from the billing snapshot; null when never read. */
  remainingCredits: number | null | undefined
}): GuardrailVerdict {
  const { guardrails, tokensToday, modelTokensToday, remainingCredits } = input

  // A snapshot that was never read is not evidence of a low balance: an account
  // that has not been refreshed yet must not be refused for it.
  if (guardrails.reserveCredits > 0 && typeof remainingCredits === 'number'
    && Number.isFinite(remainingCredits) && remainingCredits < guardrails.reserveCredits) {
    return {
      allowed: false,
      reason: 'reserve-credits',
      detail: `${remainingCredits.toFixed(2)} credits left, below the reserved ${guardrails.reserveCredits}`,
    }
  }
  if (guardrails.dailyTokens > 0 && tokensToday >= guardrails.dailyTokens) {
    return {
      allowed: false,
      reason: 'daily-tokens',
      detail: `${tokensToday} tokens today, at the ${guardrails.dailyTokens} daily cap`,
    }
  }
  if (guardrails.modelDailyTokens > 0 && modelTokensToday >= guardrails.modelDailyTokens) {
    return {
      allowed: false,
      reason: 'model-daily-tokens',
      detail: `${modelTokensToday} tokens today on this model, at the ${guardrails.modelDailyTokens} cap`,
    }
  }
  return { allowed: true }
}
