/**
 * Static facts about the OpenDesign subscription API.
 *
 * The upstream is the OpenDesign link gateway, an OpenAI-compatible endpoint
 * fronting the models a plan's credits can spend. Authentication is a static
 * API key in `Authorization: Bearer`, created in the OpenDesign Cloud console
 * (workspace → API keys): there is no OAuth flow here and nothing expires.
 *
 * Evidence for every constant is in docs/opendesign-line-plan.md; the short
 * version: the gateway host and its `/v1` OpenAI spelling come from the Cloud
 * console's quick-setup bundle (it composes `{link}/v1` for OpenAI clients and
 * recommends Chat Completions for DeepSeek Harness), and each protocol endpoint
 * was probed unauthenticated and answered the expected 401 envelope.
 *
 * The model table below is transcribed from the public, unauthenticated price
 * list — id spellings, display names where the pricing page publishes them, and
 * USD-per-1M-token prices. It carries NO context windows: the gateway does not
 * publish them to an API key, so a model's window is the line default until the
 * user overrides it or a live catalog entry states one. The table is a fallback,
 * not a ceiling: a model the live catalog discovers is adopted with what that
 * listing published rather than hidden.
 */

export const PROVIDER_ID = 'opendesign'
export const PROVIDER_NAME = 'OpenDesign'

/**
 * Default gateway base URL, OpenAI protocol spelling (the `/v1` suffix is part
 * of it; the Anthropic spelling is the bare host and is not what this line
 * speaks). Overridable per deployment and per account.
 */
export const DEFAULT_BASE_URL = 'https://amr-link.open-design.ai/v1'

/** Public, unauthenticated price list; the shipped table's source. */
export const MODEL_PRICES_URL = 'https://amr-api.open-design.ai/api/v1/public/model-prices'

/**
 * The AMR control-plane base: device authorization and the wallet balance live
 * under it. The device flow's contract is probed live (2026-10-21) and pinned
 * by test/opendesign-oauth.test.ts; the wallet read's shape comes from the
 * open-source daemon's reader (apps/daemon/src/integrations/vela-wallet.ts,
 * nexu-io/open-design) plus issue #8870's field report.
 */
export const AMR_API_BASE = 'https://amr-api.open-design.ai/api/v1'

/** Device-authorization endpoints under {@link AMR_API_BASE}. */
export const DEVICE_AUTHORIZATIONS_PATH = '/cli/device-authorizations'
export const WALLET_BALANCE_PATH = '/wallet/balance'
/**
 * The account's plan + credits summary.
 *
 * The only endpoint that states the paid tier: `/me` carries a `plan` field, but
 * it answers `free` for a subscribed account (probed 2026-10-21 against a Go
 * account whose billing period was active), so it is a rough profile flag and
 * never the tier. This one reports `membershipTier` plus the credit buckets the
 * plan grants, the amounts consumed, and the current billing period.
 */
export const BILLING_SUMMARY_PATH = '/billing/summary'

/**
 * The workspace the signed-in account is CURRENTLY on.
 *
 * This is what the console itself reads to pick "the active workspace": its
 * response object carries `activeWorkspaceId` beside `workspaceType` and `role`.
 * It is the first place the coding-plan read looks for an id, because it answers
 * "where is this account right now" rather than "where could it go".
 */
export const CURRENT_WORKSPACE_PATH = '/workspaces/current'

/**
 * The workspace list: the FALLBACK source of that id.
 *
 * `GET {amr}/workspaces` with the same control key answers every workspace the
 * account can see. It is only consulted when {@link CURRENT_WORKSPACE_PATH} does
 * not state an id — a listing describes what the account could switch to, while
 * the coding-plan read needs the one workspace it is on. The device flow returns
 * neither, so these two reads are the only way to learn an id at all.
 */
export const WORKSPACES_PATH = '/workspaces'

/**
 * The Design Plan's real allowance, per workspace: the 5-hour and 7-day windows
 * the console draws.
 *
 * Appended to `{WORKSPACES_PATH}/{workspaceId}`. It is the only surface of this
 * line that states a bounded window — `/billing/summary` states credits and the
 * tier but never a rolling allowance — and it authenticates with the control key
 * as a Bearer token plus `x-vela-workspace-id`, exactly like the wallet read.
 * The console itself calls it with a browser session, so a control-key Bearer is
 * unverified: a refusal is reported as data, never as a reason to guess.
 */
export const CODING_PLAN_USAGE_SUFFIX = '/billing/coding-plan-usage'

/**
 * What the create call says about this client. The service stores host /
 * profile / cliVersion per authorization (its console lists devices by them);
 * the profile vocabulary is 'prod' | 'test' | 'feature-test' | 'local' per the
 * open-source daemon, and this line only ever speaks to prod.
 */
export const DEVICE_CLIENT_PROFILE = 'prod'
export const DEVICE_CLIENT_NAME = 'dsh-chatgpt-subscription'

/** Conservative context capacity for a model no catalog describes. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Per-request output budget when the caller states none.
 *
 * A budget, not a ceiling: the harness reserves it as completion room before it
 * compacts, so this decides how much of the window stays available. 64k keeps
 * the reserve far below the compaction ratio while leaving room for a
 * tool-calling agent's longest turn.
 */
export const DEFAULT_MAX_TOKENS = 64_000

/**
 * Streams one account may keep open at once; `0` lifts the cap.
 *
 * The cheapest published plan states "10 concurrent tasks"
 * (https://open-design.ai/pricing/, 2026-10-21), so 10 is the one entitlement
 * every paid key definitely has; a deployment that knows its plan may raise it.
 */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 10

/** Idle budget for one OpenDesign stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** How long a quota refusal keeps one account out of rotation. */
export const POOL_COOLDOWN_MS = 15 * 60_000

/**
 * One published model entry.
 *
 * `contextWindow` and `maxTokens` are the VENDOR's published figures, not a
 * promise about this gateway's clamp: no OpenDesign endpoint publishes a window
 * to an API key (the control-plane catalog does, and the live sync prefers it).
 * They are transcribed from this repository's already-sourced tables of the same
 * vendor models — the command-code registry transcription
 * (src/host/command-code/model-catalog.ts), the cline-pass table
 * (src/host/cline-pass/types.ts), the Claude catalog
 * (src/host/claude/model-catalog.ts) and the antigravity catalog
 * (src/host/antigravity/types.ts) — because this line's fallback must not be a
 * flat 128k for every model while those facts sit in the same repository.
 * Per-model conflict resolution prefers the cline-pass table where the two
 * disagree, since it is the OpenAI-chat gateway closest to this one. A live
 * catalog entry and a user override both beat this table, so a clamp this
 * transcription gets wrong costs one correction in the editor, not a permanent
 * ceiling.
 *
 * `efforts` is the selectable reasoning ladder in DSH spelling (`none` is DSH's
 * "do not think"; the command-code registry spells the same level `off` and it
 * is translated here). An empty ladder with `reasoning: false` means no source
 * publishes one for that model; a model with no row data at all keeps the
 * line's default trio rather than being declared a non-reasoner.
 */
export interface OpenDesignModelMeta {
  name: string
  /**
   * USD per 1M tokens from the public price list. Shown, never fabricated: a
   * model the price list does not carry simply has no figure.
   */
  pricing?: { input: number; output: number }
  /** The vendor's published context window; absent when no source documents one. */
  contextWindow?: number
  /** The vendor's published output ceiling; absent when no source documents one. */
  maxTokens?: number
  /**
   * Selectable reasoning levels, least to greatest, in DSH spelling. Absent
   * means "use the line default"; an empty array means the model exposes none.
   */
  efforts?: readonly string[]
  /** Default reasoning level; omitted leaves the host's own default in place. */
  defaultEffort?: string
  /**
   * Whether the model takes an effort knob at all. Absent means yes; `false`
   * marks the rows whose source publishes no ladder.
   */
  reasoning?: boolean
  /** Accepted input modalities, as the source table declares them. */
  input: readonly string[]
}

/**
 * The subscription's models at release time, keyed by wire id.
 *
 * Id spellings and prices are transcribed from MODEL_PRICES_URL (fetched
 * 2026-10-21, 37 entries, all chat models — the plan's image models are priced
 * per call and are not in it). Display names use the pricing page's spelling
 * where that page lists the model (https://open-design.ai/pricing/) and are
 * derived from the id otherwise; the live catalog's own name wins once one is
 * read. Windows, output caps, modalities and ladders come from the sibling
 * tables named on {@link OpenDesignModelMeta}; the live control-plane catalog
 * (which does publish `metadata.contextWindowTokens`) overrides them when read.
 */
export const MODEL_CATALOG: Readonly<Record<string, OpenDesignModelMeta>> = Object.freeze({
  'claude-fable-5': { name: 'Claude Fable 5', pricing: { input: 10, output: 50 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-fable-5.1': { name: 'Claude Fable 5.1', pricing: { input: 10, output: 50 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-haiku-5.5': { name: 'Claude Haiku 5.5', pricing: { input: 0.1, output: 0.5 }, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-opus-4.8': { name: 'Claude Opus 4.8', pricing: { input: 5, output: 25 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-opus-5': { name: 'Claude Opus 5', pricing: { input: 5, output: 25 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-opus-5.5': { name: 'Claude Opus 5.5', pricing: { input: 4, output: 20 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-sonnet-5': { name: 'Claude Sonnet 5', pricing: { input: 2, output: 10 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'claude-sonnet-5.5': { name: 'Claude Sonnet 5.5', pricing: { input: 2, output: 10 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'deepseek-v4.1-flash': { name: 'DeepSeek V4.1 Flash', pricing: { input: 0.3, output: 1.2 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text', 'image'], efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', pricing: { input: 0.44, output: 1.32 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'high' },
  'deepseek-v4-flash-vision-exp': { name: 'DeepSeek V4 Flash Vision Exp', pricing: { input: 0.44, output: 1.32 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['none', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', pricing: { input: 1.32, output: 3.96 }, contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'], efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
  'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', pricing: { input: 0.75, output: 3.75 }, contextWindow: 1_048_576, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', pricing: { input: 0.75, output: 3.75 }, contextWindow: 1_000_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
  'gemini-4-argon': { name: 'Gemini 4 Argon', pricing: { input: 2, output: 10 }, contextWindow: 1_048_576, maxTokens: 65_536, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
  'glm-5.2': { name: 'GLM-5.2', pricing: { input: 1.4, output: 4.4 }, contextWindow: 1_000_000, maxTokens: 131_072, input: ['text'], efforts: ['none', 'high', 'max'] },
  'glm-5.3-flash': { name: 'GLM-5.3 Flash', pricing: { input: 0.075, output: 0.25 }, contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
  'glm-5.3-flashx': { name: 'GLM-5.3 Flash-X', pricing: { input: 0.37, output: 1.25 }, contextWindow: 1_000_000, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
  'gpt-5.6-luna': { name: 'GPT-5.6 Luna', pricing: { input: 0.2, output: 1.2 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-5.6-sol': { name: 'GPT-5.6 Sol', pricing: { input: 4, output: 20 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-5.6-terra': { name: 'GPT-5.6 Terra', pricing: { input: 2, output: 12 }, contextWindow: 1_050_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', pricing: { input: 2, output: 10 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6-astra': { name: 'GPT-6 Astra', pricing: { input: 10, output: 50 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6-luna': { name: 'GPT-6 Luna', pricing: { input: 0.1, output: 0.5 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6-sol': { name: 'GPT-6 Sol', pricing: { input: 2, output: 10 }, contextWindow: 1_050_000, maxTokens: 128_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'grok-4.5': { name: 'Grok 4.5', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high'] },
  'grok-4.6': { name: 'Grok 4.6', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh'] },
  'grok-4.7': { name: 'Grok 4.7', pricing: { input: 2, output: 6 }, contextWindow: 500_000, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh'] },
  'hy4-preview': { name: 'Hunyuan H4 Preview', pricing: { input: 0.834, output: 2.501 }, contextWindow: 1_048_576, input: ['text'], efforts: ['low', 'medium', 'high'] },
  'kimi-k2.7-code': { name: 'Kimi K2.7 Code', pricing: { input: 0.95, output: 4 }, contextWindow: 262_144, maxTokens: 262_144, input: ['text', 'image'], efforts: ['none', 'low', 'medium', 'high'] },
  'kimi-k3': { name: 'Kimi K3', pricing: { input: 3, output: 15 }, contextWindow: 1_048_576, maxTokens: 131_072, input: ['text', 'image'], efforts: ['low', 'high', 'max'] },
  'mimo-v2.6-flash': { name: 'MiMo V2.6 Flash', pricing: { input: 0.14, output: 0.28 }, contextWindow: 1_048_576, input: ['text', 'image'], reasoning: false },
  'mimo-v2.6-pro': { name: 'MiMo V2.6 Pro', pricing: { input: 0.435, output: 0.87 }, contextWindow: 1_048_576, input: ['text', 'image'], reasoning: false },
  // No sibling table documents this model: its window, output cap and ladder
  // stay unset and the line's defaults apply (the editor can override).
  'minimax-m3.1-flash': { name: 'MiniMax M3.1 Flash', pricing: { input: 0.15, output: 0.6 }, reasoning: true, input: ['text'] },
  'muse-spark-1.3': { name: 'Muse Spark 1.3', pricing: { input: 1.25, output: 4.25 }, contextWindow: 1_048_576, input: ['text', 'image'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // No sibling table documents this model: its window, output cap and ladder
  // stay unset and the line's defaults apply (the editor can override).
  'muse-wonder': { name: 'Muse Wonder', pricing: { input: 4, output: 20 }, reasoning: true, input: ['text'] },
  'qwen3.7-max': { name: 'Qwen3.7 Max', pricing: { input: 2.5, output: 7.5 }, contextWindow: 1_000_000, maxTokens: 65_536, input: ['text'], reasoning: false },
})

/** Subscription models current at release time; the live catalog extends this. */
export const DEFAULT_MODELS: readonly string[] = Object.freeze(Object.keys(MODEL_CATALOG))

/**
 * The effort ladder a model with no published ladder is advertised with.
 *
 * The OpenAI trio every compatible gateway accepts; an input outside it is a
 * 400 on some gateways, so the default stays deliberately small. A model whose
 * own row publishes a ladder uses that instead.
 */
export const DEFAULT_EFFORTS: readonly string[] = Object.freeze(['low', 'medium', 'high'])

/** Published entry for one model id, if the shipped table knows it. */
export function catalogEntry(model: string): OpenDesignModelMeta | undefined {
  return MODEL_CATALOG[model]
}

/**
 * One model as the live catalog describes it, after merging the shipped table,
 * the last gateway listing and any per-model override.
 */
export interface OpenDesignModelInfo {
  id: string
  displayName: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  /** Selectable effort ladder; empty when the model exposes none. */
  efforts: readonly string[]
  /** Default level, present only when it belongs to the effective ladder. */
  defaultEffort?: string
  input: readonly string[]
  pricing?: { input: number; output: number }
}

/** One model's metadata as the last gateway listing published it. */
export interface OpenDesignDiscoveredModel {
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  reasoning?: boolean
  /** Selectable effort levels, when the listing publishes them. */
  efforts?: string[]
}
