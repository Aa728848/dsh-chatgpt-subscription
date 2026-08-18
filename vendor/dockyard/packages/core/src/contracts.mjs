import { ValidationError } from "./errors.mjs";

export const ACCOUNT_HEALTH = Object.freeze({
  UNKNOWN: "unknown",
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  COOLDOWN: "cooldown",
  EXPIRED: "expired",
  EXHAUSTED: "exhausted",
});

export const ACCOUNT_SELECTION_POLICY = Object.freeze({
  MANUAL: "manual",
  STICKY_SESSION: "sticky_session",
  ROUND_ROBIN: "round_robin",
  FAILOVER: "failover",
});

export const PROVIDER_CAPABILITIES = Object.freeze([
  "oauth_discovery",
  "oauth_import",
  "oauth_authorization",
  "oauth_refresh",
  "quota",
  "catalog",
  "invoke",
  "stream",
]);

function isoOrNull(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Invalid ISO timestamp for ${fieldName}`, { fieldName, value });
  }
  return date.toISOString();
}

function numberOrNull(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`Expected a finite number for ${fieldName}`, { fieldName, value });
  }
  return value;
}

function stringOrNull(value) {
  return value === undefined || value === null || value === "" ? null : String(value);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
}

function createQuotaWindow(input = {}, now = new Date()) {
  return {
    id: stringOrNull(input.id),
    name: stringOrNull(input.name),
    remaining: numberOrNull(input.remaining, "quota.windows.remaining"),
    limit: numberOrNull(input.limit, "quota.windows.limit"),
    unit: stringOrNull(input.unit),
    resetAt: isoOrNull(input.resetAt, "quota.windows.resetAt"),
    updatedAt: isoOrNull(input.updatedAt, "quota.windows.updatedAt") ?? now.toISOString(),
    source: stringOrNull(input.source) ?? "unknown",
  };
}

export function createQuotaSnapshot(input = {}, now = new Date()) {
  return {
    remaining: numberOrNull(input.remaining, "quota.remaining"),
    limit: numberOrNull(input.limit, "quota.limit"),
    unit: stringOrNull(input.unit),
    resetAt: isoOrNull(input.resetAt, "quota.resetAt"),
    updatedAt: isoOrNull(input.updatedAt, "quota.updatedAt") ?? now.toISOString(),
    source: stringOrNull(input.source) ?? "unknown",
    windows: Array.isArray(input.windows)
      ? input.windows.map((window) => createQuotaWindow(window, now))
      : [],
  };
}

export function createRefreshState(input = {}) {
  return {
    accessTokenExpiresAt: isoOrNull(input.accessTokenExpiresAt, "refresh.accessTokenExpiresAt"),
    nextRefreshAt: isoOrNull(input.nextRefreshAt, "refresh.nextRefreshAt"),
    lastRefreshedAt: isoOrNull(input.lastRefreshedAt, "refresh.lastRefreshedAt"),
    refreshable: input.refreshable === undefined ? null : Boolean(input.refreshable),
  };
}

export function createAccountRecord(input, now = new Date()) {
  if (!input || typeof input !== "object") throw new ValidationError("Account input is required");
  if (!input.providerId) throw new ValidationError("Account providerId is required");
  if (!input.accountId) throw new ValidationError("Account accountId is required");
  const credentialRef = input.credentialRef ?? input.auth?.credentialRef;
  if (!credentialRef) throw new ValidationError("Account credentialRef is required");

  const health = input.health ?? {};
  const createdAt = isoOrNull(input.createdAt, "createdAt") ?? now.toISOString();
  const updatedAt = isoOrNull(input.updatedAt, "updatedAt") ?? now.toISOString();

  return {
    providerId: String(input.providerId),
    accountId: String(input.accountId),
    displayName: stringOrNull(input.displayName),
    email: stringOrNull(input.email),
    auth: {
      kind: stringOrNull(input.auth?.kind) ?? "oauth",
      credentialRef: String(credentialRef),
      scopes: Array.isArray(input.auth?.scopes) ? [...input.auth.scopes] : [],
    },
    subscription: {
      plan: stringOrNull(input.subscription?.plan),
      status: stringOrNull(input.subscription?.status),
      expiresAt: isoOrNull(input.subscription?.expiresAt, "subscription.expiresAt"),
    },
    quota: createQuotaSnapshot(input.quota ?? {}, now),
    refresh: createRefreshState(input.refresh ?? {}),
    resources: objectOrEmpty(input.resources),
    health: {
      status: health.status ?? ACCOUNT_HEALTH.UNKNOWN,
      lastCheckedAt: isoOrNull(health.lastCheckedAt, "health.lastCheckedAt"),
      cooldownUntil: isoOrNull(health.cooldownUntil, "health.cooldownUntil"),
      lastError: stringOrNull(health.lastError),
    },
    lastUsedAt: isoOrNull(input.lastUsedAt, "lastUsedAt"),
    createdAt,
    updatedAt,
  };
}

export function accountSummary(account) {
  return {
    providerId: account.providerId,
    accountId: account.accountId,
    displayName: account.displayName,
    email: account.email,
    subscription: { ...account.subscription },
    quota: { ...account.quota },
    refresh: { ...account.refresh },
    resources: structuredClone(account.resources ?? {}),
    health: { ...account.health },
    lastUsedAt: account.lastUsedAt,
  };
}

export function accountStorageRecord(account) {
  return {
    ...accountSummary(account),
    auth: {
      kind: account.auth.kind,
      credentialRef: account.auth.credentialRef,
      scopes: [...account.auth.scopes],
    },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
