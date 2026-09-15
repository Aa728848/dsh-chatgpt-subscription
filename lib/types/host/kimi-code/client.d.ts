import { PROVIDER_NAME } from './types.ts';
import { FileCredentialStore, type KimiCodeCatalogModel, type KimiCodeCredentials } from './token-store.ts';
import type { KimiCodeAccount, KimiCodeAccountQuota, KimiCodeExtraUsage, KimiCodeModelOption, KimiCodeRegion, KimiCodeUsageWindow, KimiCodeWire } from '../../shared/kimi-code-contracts.ts';
/** Endpoint suffixes on the coding API base. */
export declare const MODELS_PATH = "/models";
export declare const USAGES_PATH = "/usages";
export declare const ME_PATH = "/me";
/** Parse an ISO string, Unix seconds, or Unix milliseconds into Unix milliseconds. */
export declare function parseTimestamp(value: unknown): number | null;
/**
 * Headers for a managed coding API request.
 *
 * The OpenAI-compatible surface authenticates with a bearer token. On the
 * Anthropic-compatible surface the Anthropic SDK sends the token as
 * `x-api-key` instead and deliberately omits `authorization`, so both are
 * emitted — the service documents each surface and only reads its own field.
 */
export declare function kimiCodeHeaders(accessToken: string, wire?: KimiCodeWire, extra?: Record<string, string>): Promise<Record<string, string>>;
/**
 * Headers for one model call.
 *
 * The managed service attributes usage to the installation, so the same
 * \`X-Msh-*\` device identity the account endpoints require is sent here too.
 * The product token stays this plugin's own: the service documents third-party
 * clients against this endpoint, and claiming to be the official CLI is both
 * dishonest and, per its own terms, grounds for suspending the subscription.
 * The cost of that honesty is that a non-whitelisted user agent can be routed to
 * a deprioritized pool, which answers with a transient 429 — the retry policy in
 * the adapter is what absorbs it.
 */
export declare function modelRequestHeaders(accessToken: string, wire: KimiCodeWire): Promise<Record<string, string>>;
/** Test seam: resolve the URL one request goes to. */
export declare function requestUrl(wire: KimiCodeWire, region: KimiCodeRegion): string;
export declare function clearCachedCatalog(): void;
export declare function getCachedCatalog(): KimiCodeCatalogModel[];
/**
 * Fetch the models the signed-in subscription can use.
 *
 * The live listing is authoritative — it is what tells the plugin which models
 * the account's tier actually unlocks — so it is cached for half an hour and
 * re-read on demand from the settings card.
 */
export declare function loadProviderModels(options?: {
    fetchFn?: typeof fetch;
    store?: FileCredentialStore;
    accessToken?: string;
    region?: KimiCodeRegion;
    signal?: AbortSignal;
    force?: boolean;
}): Promise<KimiCodeCatalogModel[]>;
/** Choose the wire dialect for one model, from the live catalog when it says. */
export declare function wireForCatalogEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): KimiCodeWire;
/** Thinking levels for one model, from the catalog when it declares them. */
export declare function reasoningEffortsForEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): string[];
/** Input modalities for one model, from the catalog when it declares them. */
export declare function inputModalitiesForEntry(modelId: string, catalog: readonly KimiCodeCatalogModel[]): Array<'text' | 'image'>;
/** Build the picker entries the settings card renders. */
export declare function buildModelOptions(catalog: readonly KimiCodeCatalogModel[], enabledModelIds: readonly string[], contextWindowOverrides: Record<string, number>): KimiCodeModelOption[];
export declare function getCachedQuota(): KimiCodeAccountQuota | null;
export declare function clearCachedQuota(): void;
/**
 * Read the windowed quota block.
 *
 * The service's own shape nests one entry per window under `usages`; a
 * community-documented alternative reports a top-level `usage` plus a
 * `limits[]` array. Both are read so a service-side change of shape does not
 * silently blank the card, and an unrecognized payload yields no windows rather
 * than a fabricated 0%.
 */
export declare function parseUsageWindows(payload: unknown): KimiCodeUsageWindow[];
/**
 * Convert the fixed-point money field the service uses into cents.
 *
 * Amounts arrive as 1e-6 cents; a positive amount that would round to zero is
 * reported as one cent, because "you have something left" is closer to the
 * truth than "you have nothing".
 */
export declare function fixedPointToCents(value: unknown): number | null;
/**
 * Read the booster wallet (the pay-as-you-go top-up pool).
 *
 * The wallet only counts when its balance is a real booster balance; anything
 * else is reported as absent so the card does not advertise credit the account
 * cannot spend.
 */
export declare function parseExtraUsage(payload: unknown): KimiCodeExtraUsage | null;
/** Human name for one machine level code, or the code itself when unknown. */
export declare function membershipLevelName(level: string | null | undefined): string | null;
/**
 * Subscription tier the payload names, from any documented shape.
 *
 * Prefers the display name when the service still sends one, then the machine
 * level (mapped to its marketing name), so a payload that dropped
 * `user_level_name` still yields a readable tier instead of a raw enum.
 */
export declare function parsePlanName(payload: unknown): string | null;
/** Machine tier level when the service reports one. */
export declare function parsePlanLevel(payload: unknown): string | null;
/**
 * Turn a `/me` payload into the public account DTO.
 *
 * The endpoint answers with snake_case fields while the card consumes
 * camelCase, and either profile source may be the one that answered, so both
 * spellings are accepted.
 */
export declare function parseUserInfo(payload: unknown, fallback?: Partial<KimiCodeAccount>): KimiCodeAccount;
export interface QuotaFetchOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** Bypass the local cache and read the service again. */
    force?: boolean;
}
/**
 * Fetch and cache the account's quota snapshot.
 *
 * A 401 is surfaced as a rejection so the caller can invalidate the stored
 * credential; every other failure leaves the previous snapshot in place rather
 * than blanking the card, because a transient outage says nothing about the
 * account's real usage.
 */
export declare function fetchAccountQuota(store: FileCredentialStore, options?: QuotaFetchOptions): Promise<KimiCodeAccountQuota | null>;
/**
 * Build the account view for one credential.
 *
 * There is no account-profile endpoint on the coding API: the signed-in
 * identity lives in the token's own claims, so the account is assembled from
 * the stored credential (which the login and every refresh keep populated) and
 * enriched by whatever the usage payload reports about the tier.
 */
export declare function accountFromCredentials(credentials: KimiCodeCredentials, payload?: unknown, profile?: unknown): KimiCodeAccount;
/**
 * Read the plan profile from `/me`.
 *
 * The endpoint exists and is the only remaining source of the plan's display
 * name: `/usages` used to carry `user_level_name` and stopped. It is called
 * with the OAuth access token only (never a pasted plan key) and is treated as
 * enrichment — a failure returns null so the card still renders the identity it
 * already has from the token.
 */
export declare function fetchProfile(store: FileCredentialStore, options?: QuotaFetchOptions): Promise<unknown | null>;
/**
 * Read the account identity for a stored credential.
 *
 * Combines the token's own claims (the identity) with `/me` (the plan name) and
 * persists what it learns, so a later call needs no network work. It never
 * throws for a missing profile: the identity is derived locally.
 */
export declare function fetchUserInfo(store: FileCredentialStore, options?: QuotaFetchOptions): Promise<KimiCodeAccount | null>;
/**
 * Prove the stored credential still authenticates, and report how long that took.
 *
 * The probe is the real usage call rather than a profile lookup, because there
 * is no profile endpoint: a 200 from `/usages` is what shows the token is
 * accepted, and it doubles as a quota refresh for the card.
 */
export declare function testConnection(store: FileCredentialStore, options?: QuotaFetchOptions): Promise<{
    account: KimiCodeAccount | null;
    latencyMs: number;
}>;
export { PROVIDER_NAME };
//# sourceMappingURL=client.d.ts.map