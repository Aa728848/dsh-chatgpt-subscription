/**
 * Provider-owned prompt-cache semantics, separated from reusable mechanisms.
 *
 * A cache read counter is not proof that a deployment supports cache keys,
 * account affinity, or keepalive traffic. This registry is therefore the single
 * place where those assumptions become explicit. Missing evidence disables the
 * corresponding behaviour; a deployment override may enable it only when its
 * required facts are present too.
 */

export type PromptCacheMode = 'automatic' | 'explicit' | 'none'
export type PromptCacheScope = 'account' | 'shared' | 'unknown'
export type ColdStartMode = 'off' | 'in-flight' | 'warm'

export interface PromptCachePolicy {
  readonly mode: PromptCacheMode
  readonly scope: PromptCacheScope
  readonly ttlMs?: number
  readonly staticPrefix: boolean
  readonly coldStart: ColdStartMode
  readonly stickyImages: boolean
  readonly affinity: boolean
  readonly waitWarmup: boolean
  readonly hint: boolean
}

export type PromptCacheOverride = Partial<Omit<PromptCachePolicy, 'ttlMs'>> & { ttlMs?: number }
export type PromptCacheOverrides = Readonly<Record<string, PromptCacheOverride>>

const MINUTE_MS = 60_000
const MAX_CACHE_TTL_MS = 30 * 24 * 60 * MINUTE_MS

const DISABLED: PromptCachePolicy = Object.freeze({
  mode: 'none',
  scope: 'unknown',
  staticPrefix: false,
  coldStart: 'off',
  stickyImages: false,
  affinity: false,
  waitWarmup: false,
  hint: false,
})

function policy(input: PromptCachePolicy): PromptCachePolicy {
  return Object.freeze(input)
}

/** Built-in facts already represented by a line's mapper, adapter, or official client. */
export const PROMPT_CACHE_POLICIES: Readonly<Record<string, PromptCachePolicy>> = Object.freeze({
  'kimi-code': policy({
    mode: 'automatic', scope: 'account', ttlMs: 25 * MINUTE_MS,
    staticPrefix: true, coldStart: 'warm', stickyImages: true,
    affinity: true, waitWarmup: true, hint: true,
  }),
  'codex-chatgpt': policy({
    mode: 'automatic', scope: 'unknown', staticPrefix: true, coldStart: 'in-flight',
    stickyImages: false, affinity: false, waitWarmup: false, hint: false,
  }),
  antigravity: policy({
    mode: 'automatic', scope: 'unknown', staticPrefix: true, coldStart: 'in-flight',
    stickyImages: false, affinity: false, waitWarmup: false, hint: false,
  }),
  'step-code': policy({
    mode: 'automatic', scope: 'unknown', ttlMs: 5 * MINUTE_MS,
    staticPrefix: true, coldStart: 'in-flight', stickyImages: false,
    affinity: false, waitWarmup: false, hint: true,
  }),
  claude: policy({
    mode: 'explicit', scope: 'unknown', staticPrefix: true, coldStart: 'in-flight',
    stickyImages: true, affinity: false, waitWarmup: false, hint: false,
  }),
  'minimax-code': policy({
    mode: 'explicit', scope: 'unknown', staticPrefix: true, coldStart: 'in-flight',
    stickyImages: true, affinity: false, waitWarmup: false, hint: false,
  }),
  'glm-coding-plan': policy({ ...DISABLED, mode: 'automatic' }),
  'command-code': policy({ ...DISABLED, mode: 'automatic' }),
  'cline-pass': policy({ ...DISABLED, mode: 'automatic' }),
  qoder: policy({ ...DISABLED, mode: 'automatic' }),
  opendesign: policy({ ...DISABLED, mode: 'automatic' }),
  'workbuddy-subscription': policy({ ...DISABLED, mode: 'automatic' }),
  ollama: DISABLED,
})

const OVERRIDE_KEYS = new Set([
  'mode', 'scope', 'ttlMs', 'staticPrefix', 'coldStart', 'stickyImages',
  'affinity', 'waitWarmup', 'hint',
])
const BOOLEAN_KEYS = ['staticPrefix', 'stickyImages', 'affinity', 'waitWarmup', 'hint'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one provider override without silently dropping unknown keys. */
export function parsePromptCacheOverride(provider: string, value: unknown): PromptCacheOverride {
  if (!isRecord(value)) throw new Error(`prompt cache policy for "${provider}" must be an object`)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!OVERRIDE_KEYS.has(key)) throw new Error(`prompt cache policy for "${provider}" has unknown field "${key}"`)
    if (entry === undefined) continue
    if (key === 'mode') {
      if (entry !== 'automatic' && entry !== 'explicit' && entry !== 'none') throw new Error(`invalid prompt cache mode for "${provider}"`)
    } else if (key === 'scope') {
      if (entry !== 'account' && entry !== 'shared' && entry !== 'unknown') throw new Error(`invalid prompt cache scope for "${provider}"`)
    } else if (key === 'coldStart') {
      if (entry !== 'off' && entry !== 'in-flight' && entry !== 'warm') throw new Error(`invalid cold-start mode for "${provider}"`)
    } else if (key === 'ttlMs') {
      if (!Number.isSafeInteger(entry) || (entry as number) <= 0 || (entry as number) > MAX_CACHE_TTL_MS) {
        throw new Error(`prompt cache ttlMs for "${provider}" must be a positive safe integer no greater than ${MAX_CACHE_TTL_MS}`)
      }
    } else if ((BOOLEAN_KEYS as readonly string[]).includes(key) && typeof entry !== 'boolean') {
      throw new Error(`prompt cache ${key} for "${provider}" must be boolean`)
    }
    out[key] = entry
  }
  return out as PromptCacheOverride
}

/** Validate a whole config-owned map. Undefined means no overrides. */
export function parsePromptCacheOverrides(value: unknown): PromptCacheOverrides {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('promptCacheOverrides must be an object keyed by provider id')
  const out: Record<string, PromptCacheOverride> = {}
  for (const [provider, override] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new Error(`invalid prompt cache provider id "${provider}"`)
    out[provider] = parsePromptCacheOverride(provider, override)
  }
  return Object.freeze(out)
}

function validateResolved(provider: string, value: PromptCachePolicy): PromptCachePolicy {
  if (value.mode === 'none') return policy({ ...DISABLED })
  const requiresTtl = value.coldStart === 'warm' || value.waitWarmup || value.hint
  if (requiresTtl && value.ttlMs === undefined) {
    throw new Error(`prompt cache policy for "${provider}" needs a measured ttlMs for warm/waitWarmup/hint`)
  }
  if (value.affinity && value.scope !== 'account') {
    throw new Error(`prompt cache affinity for "${provider}" needs scope:"account"`)
  }
  return policy(value)
}

/** Resolve one line, applying an already-validated or config-shaped override. */
export function promptCachePolicyOf(provider: string, override?: PromptCacheOverride): PromptCachePolicy {
  const base = PROMPT_CACHE_POLICIES[provider] ?? DISABLED
  const parsed = override === undefined ? undefined : parsePromptCacheOverride(provider, override)
  return validateResolved(provider, { ...base, ...parsed })
}

/** Resolve the built-in matrix plus optional deployment overrides. */
export function resolvePromptCachePolicies(overrides?: unknown): Readonly<Record<string, PromptCachePolicy>> {
  const parsed = parsePromptCacheOverrides(overrides)
  const providers = new Set([...Object.keys(PROMPT_CACHE_POLICIES), ...Object.keys(parsed)])
  const out: Record<string, PromptCachePolicy> = {}
  for (const provider of providers) out[provider] = promptCachePolicyOf(provider, parsed[provider])
  return Object.freeze(out)
}

/** A volatile config field or an ordinary value, matching the host's loader seam. */
export type PromptCacheConfigField<T> = T | { get(): T | undefined } | undefined

export function readPromptCacheConfigField<T>(field: PromptCacheConfigField<T>): T | undefined {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get(): T | undefined }).get()
  }
  return field as T | undefined
}
