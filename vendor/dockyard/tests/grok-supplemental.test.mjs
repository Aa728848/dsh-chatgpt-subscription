import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGrokCatalogLoader,
  createGrokDriver,
  parseGrokCreditsConfig,
  parseGrokAuth,
} from "../modules/provider-grok/src/index.mjs";
import { MemorySecretStore } from "../packages/vault/src/index.mjs";

test("Grok discovery marks expired OAuth degraded and active session imports nothing when absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "grok-discovery-"));
  const authPath = join(home, "auth.json");
  await (await import("node:fs/promises")).writeFile(authPath, JSON.stringify({ expired: {
    key: "expired-access", refresh_token: "refresh", user_id: "expired", expires_at: "2020-01-01T00:00:00.000Z",
  } }), { mode: 0o600 });
  const driver = createGrokDriver({ authFilePath: authPath });
  const discovered = await driver.discover({ now: new Date("2030-01-01T00:00:00.000Z") });
  assert.equal(discovered.candidates[0].status, "degraded");
  assert.match(discovered.candidates[0].diagnostic, /已过期/);
  const empty = createGrokDriver({ authFilePath: join(home, "missing.json") });
  assert.equal(await empty.getActiveSession({ secretStore: new MemorySecretStore() }), null);
});

test("Grok refresh delegates rotation to grok models through an isolated 0600 profile", async () => {
  const secretStore = new MemorySecretStore();
  const ref = "test://grok/refresh";
  await secretStore.write(ref, {
    access: "old-access",
    refresh: "old-refresh",
    accountId: "account-1",
    expiresAt: "2025-01-01T00:00:00.000Z",
  });
  let profileDir;
  const driver = createGrokDriver({
    grokHome: await mkdtemp(join(tmpdir(), "grok-source-")),
    commandRunner: async (command, args, options) => {
      assert.equal(command, "grok");
      assert.deepEqual(args, ["models"]);
      profileDir = options.env.GROK_HOME;
      const authPath = join(profileDir, "auth.json");
      const before = JSON.parse(await readFile(authPath, "utf8"));
      assert.equal(before["account-1"].key, "old-access");
      // Windows does not apply POSIX modes. The Linux storage suite verifies 0600;
      // this branch verifies the isolated profile and rotation lifecycle.
      if (process.platform !== "win32") {
        const mode = (await import("node:fs/promises")).stat(authPath).then((value) => value.mode & 0o777);
        assert.equal(await mode, 0o600);
      }
      await (await import("node:fs/promises")).writeFile(authPath, JSON.stringify({
        "account-1": { key: "new-access", refresh_token: "new-refresh", user_id: "account-1", expires_at: "2030-01-01T00:00:00.000Z" },
      }), { mode: 0o600 });
      return { output: "models refreshed" };
    },
  });
  const result = await driver.refreshAccount({
    providerId: "grok",
    accountId: "account-1",
    auth: { kind: "oauth", credentialRef: ref },
    refresh: {},
  }, { secretStore, now: new Date("2026-01-01T00:00:00.000Z") });
  assert.equal((await secretStore.read(ref)).access, "new-access");
  assert.equal(result.refresh.accessTokenExpiresAt, "2030-01-01T00:00:00.000Z");
  await assert.rejects(() => readFile(join(profileDir, "auth.json"), "utf8"), /ENOENT/);
});

test("Grok refresh cleans the temporary profile when CLI rotation fails", async () => {
  const secretStore = new MemorySecretStore();
  const ref = "test://grok/failing-refresh";
  await secretStore.write(ref, { access: "old-access", refresh: "old-refresh", accountId: "account-2" });
  let profileDir;
  const driver = createGrokDriver({
    commandRunner: async (_command, _args, options) => {
      profileDir = options.env.GROK_HOME;
      const error = new Error("CLI rotation failed");
      error.code = 401;
      throw error;
    },
  });
  await assert.rejects(
    () => driver.refreshAccount({ providerId: "grok", accountId: "account-2", auth: { credentialRef: ref }, refresh: {} }, { secretStore }),
    (error) => error.authExpired === true,
  );
  await assert.rejects(() => readFile(join(profileDir, "auth.json"), "utf8"), /ENOENT/);
});

test("Grok catalog coalesces concurrent loads, supports force, and falls back to cache on error", async () => {
  let reads = 0;
  let commands = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = createGrokCatalogLoader({
    grokHome: "/test/grok",
    cacheTtlMs: 60_000,
    readJson: async () => { reads += 1; return { models: { "cached-model": { info: { model: "cached-model" } } } }; },
    commandRunner: async () => { commands += 1; await gate; return { output: JSON.stringify({ models: { "live-model": { info: { model: "live-model" } } } }) }; },
  });
  const first = loader();
  const second = loader();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(reads, 1);
  assert.equal(commands, 1);
  await loader({ force: true });
  assert.equal(commands, 2);

  const fallback = createGrokCatalogLoader({
    grokHome: "/test/grok",
    readJson: async () => ({ models: { "cached-model": { info: { model: "cached-model" } } } }),
    commandRunner: async () => { throw new Error("catalog unavailable"); },
  });
  const result = await fallback();
  assert.equal(result.source, "official_grok_local_cache");
  assert.equal(result.models[0].id, "cached-model");
  assert.match(result.diagnostics[0], /catalog unavailable/);
});

test("Grok credits parser handles monthly money, malformed values, and missing periods", () => {
  const monthly = parseGrokCreditsConfig({
    subscriptionTier: "pro",
    config: { monthlyLimit: 2500, used: 725, currentPeriod: { type: "MONTHLY", end: "2030-02-01T00:00:00Z" } },
  }, { now: new Date("2030-01-01T00:00:00Z") });
  assert.equal(monthly.quota.remaining, 1775);
  assert.equal(monthly.quota.limit, 2500);
  assert.equal(monthly.quota.unit, "USD cents");
  assert.match(monthly.quota.windows[0].name, /月/);
  const malformed = parseGrokCreditsConfig({ config: { creditUsagePercent: -1, monthlyLimit: "bad", used: {} } });
  assert.equal(malformed.quota.remaining, null);
  assert.deepEqual(malformed.quota.windows, []);
  assert.match(malformed.resources.quotaDiagnostic, /未返回/);
});

test("Grok auth parser rejects malformed records and accepts alternate OAuth token keys", () => {
  assert.deepEqual(parseGrokAuth({ broken: { refresh_token: "refresh-only" } }), []);
  const parsed = parseGrokAuth({ alt: {
    accessToken: "access",
    refreshToken: "refresh",
    userId: "account-alt",
    scope: "openid offline_access",
  } });
  assert.equal(parsed[0].access, "access");
  assert.equal(parsed[0].refresh, "refresh");
  assert.deepEqual(parsed[0].scopes, ["openid", "offline_access"]);
});
