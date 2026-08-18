import {
  ACCOUNT_HEALTH,
  ACCOUNT_SELECTION_POLICY,
  accountSummary,
  createAccountRecord,
  createQuotaSnapshot,
  createRefreshState,
  accountStorageRecord,
} from "../../core/src/contracts.mjs";
import { AccountSelectionError, ValidationError } from "../../core/src/errors.mjs";

function defaultClock() {
  return new Date();
}

export class AccountPool {
  #accounts = new Map();
  #sessionAssignments = new Map();
  #cursor = 0;
  #defaultAccountId = null;

  constructor({ providerId, policy = ACCOUNT_SELECTION_POLICY.ROUND_ROBIN, clock = defaultClock } = {}) {
    if (!providerId) throw new ValidationError("AccountPool providerId is required");
    if (!Object.values(ACCOUNT_SELECTION_POLICY).includes(policy)) {
      throw new ValidationError(`Unknown account selection policy: ${policy}`, { policy });
    }
    this.providerId = providerId;
    this.policy = policy;
    this.clock = clock;
  }

  upsert(input, { resetHealth = false } = {}) {
    if (input.providerId && input.providerId !== this.providerId) {
      throw new ValidationError("Account provider does not match this pool", {
        expected: this.providerId,
        received: input.providerId,
      });
    }
    const current = this.#accounts.get(input.accountId);
    const account = createAccountRecord(
      {
        ...current,
        ...input,
        credentialRef: input.credentialRef ?? current?.auth?.credentialRef,
        providerId: this.providerId,
        auth: { ...current?.auth, ...input.auth },
        subscription: { ...current?.subscription, ...input.subscription },
        quota: { ...current?.quota, ...input.quota },
        refresh: { ...current?.refresh, ...input.refresh },
        resources: { ...current?.resources, ...input.resources },
        health: resetHealth
          ? {
            ...input.health,
            status: input.health?.status === ACCOUNT_HEALTH.EXPIRED
              ? ACCOUNT_HEALTH.UNKNOWN
              : input.health?.status ?? ACCOUNT_HEALTH.UNKNOWN,
            cooldownUntil: null,
            lastError: null,
          }
          : { ...current?.health, ...input.health },
        createdAt: current?.createdAt ?? input.createdAt,
      },
      this.clock(),
    );
    this.#accounts.set(account.accountId, account);
    this.#ensureSingleAccountDefault();
    return accountSummary(account);
  }

  remove(accountId) {
    this.#sessionAssignments.forEach((assignedId, key) => {
      if (assignedId === accountId) this.#sessionAssignments.delete(key);
    });
    const removed = this.#accounts.delete(accountId);
    if (removed && this.#defaultAccountId === accountId) this.#defaultAccountId = null;
    this.#ensureSingleAccountDefault();
    return removed;
  }

  get(accountId) {
    const account = this.#accounts.get(accountId);
    return account ? accountSummary(account) : null;
  }

  list() {
    return [...this.#accounts.values()].map(accountSummary);
  }

  listForStorage() {
    return [...this.#accounts.values()].map(accountStorageRecord);
  }

  getDefaultAccountId() {
    return this.#defaultAccountId;
  }

  setPolicy(policy) {
    if (!Object.values(ACCOUNT_SELECTION_POLICY).includes(policy)) {
      throw new ValidationError(`Unknown account selection policy: ${policy}`, { policy });
    }
    this.policy = policy;
    this.#sessionAssignments.clear();
    this.#ensureSingleAccountDefault();
  }

  setDefaultAccount(accountId) {
    if (accountId !== null && !this.#accounts.has(accountId)) {
      throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    }
    this.#defaultAccountId = accountId;
  }

  select(context = {}) {
    const eligible = this.#eligibleAccounts();
    if (eligible.length === 0) {
      throw new AccountSelectionError(`No eligible accounts for provider ${this.providerId}`, {
        providerId: this.providerId,
      });
    }

    let account;
    if (this.policy === ACCOUNT_SELECTION_POLICY.MANUAL) {
      const requestedId = context.accountId ?? this.#defaultAccountId ?? (
        eligible.length === 1 ? eligible[0].accountId : null
      );
      if (!requestedId) throw new AccountSelectionError("Manual policy requires accountId");
      account = eligible.find((candidate) => candidate.accountId === requestedId);
      if (!account) throw new AccountSelectionError(`Account is not eligible: ${requestedId}`, { accountId: requestedId });
    } else {
      const sticky = this.policy === ACCOUNT_SELECTION_POLICY.STICKY_SESSION;
      const assignmentKey = sticky ? context.sessionId ?? context.requestId ?? null : null;
      const excludedIds = new Set(context.excludeAccountIds ?? []);
      const assignedId = assignmentKey ? this.#sessionAssignments.get(assignmentKey) : null;
      account = assignedId && !excludedIds.has(assignedId)
        ? eligible.find((candidate) => candidate.accountId === assignedId)
        : null;
      if (!account) {
        account = this.policy === ACCOUNT_SELECTION_POLICY.FAILOVER
          ? eligible.find((candidate) => !excludedIds.has(candidate.accountId))
          : this.#next(eligible);
        if (!account) {
          throw new AccountSelectionError("No eligible account remains after failover exclusions", {
            providerId: this.providerId,
            excludeAccountIds: [...excludedIds],
          });
        }
        if (assignmentKey) this.#sessionAssignments.set(assignmentKey, account.accountId);
      }
    }

    const updated = {
      ...account,
      lastUsedAt: this.clock().toISOString(),
      updatedAt: this.clock().toISOString(),
    };
    this.#accounts.set(updated.accountId, updated);
    return accountSummary(updated);
  }

  resolve(accountId) {
    const account = this.#accounts.get(accountId);
    if (!account) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    return {
      providerId: account.providerId,
      accountId: account.accountId,
      credentialRef: account.auth.credentialRef,
      authKind: account.auth.kind,
      scopes: [...account.auth.scopes],
    };
  }

  updateQuota(accountId, input) {
    const current = this.#accounts.get(accountId);
    if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    return this.#patch(accountId, {
      quota: createQuotaSnapshot({ ...current.quota, ...input }, this.clock()),
    });
  }

  updateRefresh(accountId, input) {
    const current = this.#accounts.get(accountId);
    if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    return this.#patch(accountId, {
      refresh: createRefreshState({ ...current.refresh, ...input }),
    });
  }

  updateResources(accountId, input = {}) {
    const current = this.#accounts.get(accountId);
    if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    return this.#patch(accountId, { resources: { ...current.resources, ...input } });
  }

  report(accountId, result = {}) {
    const account = this.#accounts.get(accountId);
    if (!account) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });

    const now = this.clock().toISOString();
    const patch = { updatedAt: now, health: { ...account.health, lastCheckedAt: now } };
    if (result.quota) patch.quota = createQuotaSnapshot({ ...account.quota, ...result.quota }, this.clock());
    if (result.refresh) patch.refresh = createRefreshState({ ...account.refresh, ...result.refresh });

    switch (result.status) {
      case "success":
        patch.health = { ...patch.health, status: ACCOUNT_HEALTH.HEALTHY, cooldownUntil: null, lastError: null };
        break;
      case "rate_limited":
        patch.health = {
          ...patch.health,
          status: result.cooldownUntil ? ACCOUNT_HEALTH.COOLDOWN : ACCOUNT_HEALTH.DEGRADED,
          cooldownUntil: result.cooldownUntil ?? null,
          lastError: result.message ?? null,
        };
        break;
      case "quota_exhausted":
        patch.health = {
          ...patch.health,
          status: ACCOUNT_HEALTH.EXHAUSTED,
          cooldownUntil: result.cooldownUntil ?? null,
          lastError: result.message ?? null,
        };
        break;
      case "auth_expired":
        patch.health = { ...patch.health, status: ACCOUNT_HEALTH.EXPIRED, lastError: result.message ?? null };
        break;
      case "error":
        patch.health = { ...patch.health, status: ACCOUNT_HEALTH.DEGRADED, lastError: result.message ?? null };
        break;
      default:
        break;
    }
    return this.#patch(accountId, patch);
  }

  #patch(accountId, patch) {
    const current = this.#accounts.get(accountId);
    if (!current) throw new AccountSelectionError(`Account does not exist: ${accountId}`, { accountId });
    const next = {
      ...current,
      ...patch,
      quota: patch.quota ? { ...current.quota, ...patch.quota } : current.quota,
      refresh: patch.refresh ? { ...current.refresh, ...patch.refresh } : current.refresh,
      resources: patch.resources ? { ...current.resources, ...patch.resources } : current.resources,
      health: patch.health ? { ...current.health, ...patch.health } : current.health,
    };
    this.#accounts.set(accountId, next);
    return accountSummary(next);
  }

  #eligibleAccounts() {
    const now = this.clock();
    return [...this.#accounts.values()].filter((account) => {
      if (account.health.status === ACCOUNT_HEALTH.EXPIRED) return false;
      if (account.health.status === ACCOUNT_HEALTH.EXHAUSTED && !account.health.cooldownUntil) return false;
      if (!account.health.cooldownUntil) return true;
      return new Date(account.health.cooldownUntil).getTime() <= now.getTime();
    });
  }

  #next(accounts) {
    const account = accounts[this.#cursor % accounts.length];
    this.#cursor = (this.#cursor + 1) % accounts.length;
    return account;
  }

  #ensureSingleAccountDefault() {
    if (this.policy !== ACCOUNT_SELECTION_POLICY.MANUAL || this.#defaultAccountId || this.#accounts.size !== 1) return;
    this.#defaultAccountId = this.#accounts.keys().next().value ?? null;
  }
}
