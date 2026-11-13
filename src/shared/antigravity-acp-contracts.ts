/**
 * Wire contracts for the Antigravity (ACP) line.
 *
 * This line speaks Google's **official** Agent Client Protocol server (`agy acp`)
 * over stdio JSON-RPC. It is deliberately not built on Cloud Code Assist's
 * `streamGenerateContent` endpoint: that protocol is undocumented, the previous
 * provider line implementing it was removed in v0.70.0, and ACP makes the official
 * `agy` process own model networking, OAuth, thinking signatures and prompt cache.
 *
 * Everything here is a display/DTO shape. No credential, token, raw protocol frame
 * or upstream identifier ever crosses this boundary: the official process holds
 * its own sign-in state and the plugin never reads or copies it.
 *
 * @module dsh-chatgpt-subscription/shared/antigravity-acp-contracts
 */

/** Route prefix every host route of this line is mounted under. */
export const ANTIGRAVITY_ACP_ROUTE_PREFIX = '/antigravity-acp/api'

/** Settings path, equivalent spelling of {@link ANTIGRAVITY_ACP_SETTINGS_PATH}. */
export const ANTIGRAVITY_ACP_MODELS_PATH = '/antigravity-acp/api/models'

/** Settings path: read or update the line's own preferences. */
export const ANTIGRAVITY_ACP_SETTINGS_PATH = '/antigravity-acp/api/settings'

/** How the line obtained the `agy` executable it runs. */
export type AntigravityAcpBinaryKind = 'local-cli' | 'configured' | 'downloaded' | 'missing'

/** One resolved executable, as the settings card reports it. */
export interface AntigravityAcpBinaryDto {
  kind: AntigravityAcpBinaryKind
  /** Absolute path when `kind` is not `missing`. */
  path?: string
  /** `agy --version` output when the binary answered. */
  version?: string
  /** Why the binary is unavailable or unusable; present only for a failure. */
  error?: string
}

/** Sign-in state, as far as the official process exposes it. */
export interface AntigravityAcpAuthDto {
  authenticated: boolean
  /**
   * The ACP auth method that produced the current state, when known. One of the
   * ids the server advertises in `initialize` (`oauth-personal`,
   * `oauth-business`, `gemini-api-key`, `agent-platform`).
   */
  method?: string
  /** Subscription tier the server reports for this account, when it reports one. */
  tier?: { id: string; name: string }
}

/** One selectable model, already collapsed across its thinking tiers. */
export interface AntigravityAcpModelDto {
  id: string
  name: string
  /** Thinking levels this exact model accepts, least to greatest. Empty means none are published. */
  efforts: string[]
  /** Server-published context window, when the server publishes one. */
  contextWindow?: number
}

/** Token counts of the last completed turn, for the composer badge. */
export interface AntigravityAcpUsageDto {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  /** Wall-clock milliseconds of the last completed turn. */
  durationMs?: number
  /** Unix milliseconds the turn settled. */
  at: number
}

/** Everything the settings card renders for this line. */
export interface AntigravityAcpStatusDto {
  /** Whether the line serves its route at all; false only because the user switched it off. */
  enabled: boolean
  binary: AntigravityAcpBinaryDto
  auth: AntigravityAcpAuthDto
  models: AntigravityAcpModelDto[]
  /**
   * Which models the user switched on; `null` is "no filter" — every model the
   * live catalog currently lists. An explicit array is a selection and an empty
   * array switches every model off. The three states are distinct on purpose:
   * a model the upstream adds later must not be silently hidden by a selection
   * made before it existed.
   */
  enabledModelIds: string[] | null
  /** Which effort new turns use when the caller states none; `null` keeps the server's own default. */
  defaultReasoningEffort: string | null
  /**
   * How a permission request from the agent is answered. `reject` refuses every
   * request (the safe default); `allow` accepts the first `allow_once` option.
   */
  permissionPolicy: AntigravityAcpPermissionPolicy
  /** What happens when the agent bypasses the bridge and uses its own tool. */
  nativeToolPolicy: AntigravityAcpNativeToolPolicy
  /** False until at least one live catalog read has succeeded. */
  catalogSynced: boolean
  usage?: AntigravityAcpUsageDto
  /**
   * How full the live context window is, when the server reports it.
   *
   * Kept separate from {@link usage}: occupancy is `used/size` of the window, not
   * a billable token count, and a card that merged them would show a cost the
   * upstream never measured.
   */
  occupancy?: { used: number; size: number; at: number }
  /** Set when another adapter owns the route, with the reason the harness gave. */
  routeConflict?: string
  /** Human-readable paragraph for a state the card must explain; localized per language. */
  notice?: string
}

/** How one permission request from the agent is answered. */
export type AntigravityAcpPermissionPolicy = 'reject' | 'allow'

/**
 * What happens when the agent uses one of its *own* tools instead of the bridge.
 *
 * ACP has no way to unload the agent's built-in tools, so a model that decides to
 * run `run_command` will do so whatever this client says. `allow` (the default)
 * records the call in the transcript and lets the turn continue; `cancel` keeps
 * the older, stricter behaviour of failing the whole turn at the first such call.
 */
export type AntigravityAcpNativeToolPolicy = 'allow' | 'cancel'

/** The settings body the card submits. Every field is optional; omitted fields keep their value. */
export interface AntigravityAcpSettingsUpdateDto {
  enabled?: boolean
  enabledModelIds?: string[] | null
  defaultReasoningEffort?: string | null
  permissionPolicy?: AntigravityAcpPermissionPolicy
  nativeToolPolicy?: AntigravityAcpNativeToolPolicy
  /** Absolute path to an `agy` executable; `null` returns to auto-resolution. */
  binaryPath?: string | null
}

/** One reasoning level a model accepts, in the order the server publishes them. */
export interface AntigravityAcpEffortDto {
  id: string
  name: string
}

/** Result of one explicit connection test. */
export interface AntigravityAcpProbeDto {
  ok: boolean
  /** Human-readable outcome; never carries a token or a raw protocol frame. */
  detail: string
}
