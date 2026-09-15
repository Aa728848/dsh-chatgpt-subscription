import { FileCredentialStore, type KimiCodeCredentials } from './token-store.ts';
import type { KimiCodeLoginFlowStatus, KimiCodeRegion } from '../../shared/kimi-code-contracts.ts';
/** Raised when the stored refresh token was rejected and a new login is required. */
export declare class KimiCodeUnauthorizedError extends Error {
    constructor(message: string);
}
/** Raised when a transient failure outlived its retry budget. */
export declare class KimiCodeRetryableError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
/** Raised when the user denied the device authorization request. */
export declare class KimiCodeAccessDeniedError extends Error {
    constructor(message: string);
}
/** Test seam: forget every remembered rejection. */
export declare function resetRefreshRejections(): void;
/**
 * Whether the given refresh token was recently rejected by the service.
 *
 * The settings card uses this to say "sign in again" instead of showing an
 * account that merely looks signed in while every call is failing.
 */
export declare function isRefreshTokenRejected(refreshToken: string): boolean;
/**
 * Read the stable device id, creating it exactly once.
 *
 * The managed service treats this as the installation's identity. It is not a
 * secret; it only has to stay stable, so a failed write degrades to a
 * per-process value instead of failing the login.
 */
export declare function getDeviceId(): Promise<string>;
/** Identity headers every Kimi Code OAuth and account request carries. */
export declare function kimiIdentityHeaders(extra?: Record<string, string>): Promise<Record<string, string>>;
/** Parsed device authorization response. */
export interface DeviceAuthorization {
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
}
/**
 * Start a device authorization (RFC 8628 section 3.1).
 *
 * A public client sends only its `client_id`; no scope, no PKCE.
 */
export declare function requestDeviceAuthorization(options?: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    region?: KimiCodeRegion;
}): Promise<{
    authorization: DeviceAuthorization;
    host: string;
}>;
/** Identity claims a Kimi token carries about the signed-in account. */
export interface KimiTokenIdentity {
    userId?: string;
    email?: string;
}
/**
 * Decode one JWT payload without verifying it.
 *
 * Kimi's access and refresh tokens are JWTs whose payload names the account,
 * and there is NO account-profile endpoint on the coding API — the identity
 * exists only inside the token. The claims are read for display only and the
 * token itself is what authenticates, so no signature check applies here.
 */
export declare function decodeJwtPayload(token: string): Record<string, unknown> | undefined;
/**
 * Account identity carried by a token pair.
 *
 * `user_id` is preferred across BOTH tokens before `sub` is considered: the two
 * claims share an issuer namespace but `sub` is the weaker one, so a refresh
 * token's `user_id` must beat an access token's `sub`.
 */
export declare function identityFromTokens(accessToken: string, refreshToken?: string): KimiTokenIdentity;
/** OAuth token response, in the shape the rest of the plugin stores. */
export interface OAuthToken {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    expiresIn: number;
    scope: string;
    tokenType: string;
}
/** How long before expiry a token must be replaced, from its own lifetime. */
export declare function refreshThresholdMs(expiresIn: number): number;
/**
 * Refresh an access token, with the official client's bounded retry.
 *
 * Only a transient status or a transport failure is retried; a 401/403 (or an
 * `invalid_grant` body) is a verdict that the refresh token is dead and stops
 * immediately, because retrying it can never succeed.
 */
export declare function refreshAccessToken(refreshToken: string, options?: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    host?: string;
    region?: KimiCodeRegion;
}): Promise<OAuthToken>;
export interface EnsureTokenOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** Refresh even when the current token is not near expiry. */
    force?: boolean;
}
/**
 * Return a usable access token, refreshing and persisting when needed.
 *
 * Concurrent callers share one refresh request: a subscription is rate limited,
 * and a burst of tool calls at token expiry would otherwise each try to rotate
 * the same refresh token.
 */
export declare function ensureAccessToken(store: FileCredentialStore, options?: EnsureTokenOptions): Promise<KimiCodeCredentials>;
export declare function getWebLoginStatus(): KimiCodeLoginFlowStatus;
/** Reset the flow so a cancelled attempt cannot keep a later one from starting. */
export declare function resetWebLogin(): void;
export declare function openBrowser(url: string): void;
/**
 * Start the browser sign-in.
 *
 * Resolves immediately with the flow state the settings card polls; the device
 * code is fetched, opened, and polled in the background so the HTTP request
 * behind the button never has to stay open for the whole authorization.
 */
export declare function beginWebLogin(store: FileCredentialStore, options?: {
    fetchFn?: typeof fetch;
    openBrowser?: (url: string) => void;
    region?: KimiCodeRegion;
}): Promise<KimiCodeLoginFlowStatus>;
//# sourceMappingURL=oauth.d.ts.map