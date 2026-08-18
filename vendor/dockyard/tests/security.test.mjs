import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserOAuthAuthorizer } from "../packages/oauth/src/browser-oauth-authorizer.mjs";
import { createAntigravityDriver } from "../modules/provider-antigravity/src/index.mjs";
import { createClaudeDriver } from "../modules/provider-claude/src/index.mjs";
import { createCursorCatalogLoader, createCursorDriver, createCursorNativeExecutor, readCursorDesktopSession } from "../modules/provider-cursor/src/index.mjs";
import { createGrokDriver } from "../modules/provider-grok/src/index.mjs";
import { createDefaultSecretStore, UnavailableSecretStore } from "../packages/vault/src/index.mjs";

test("invalid-state loopback callbacks do not cancel an active OAuth session", async () => {
  let callbackRequest;
  const authorizer = createBrowserOAuthAuthorizer({
    providerId: "test-state-provider",
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    authorizationUrlBuilder: async (value) => { callbackRequest = value; return "https://example.test/authorize"; },
    exchangeCode: async ({ code }) => ({ access: code }),
    importCredentials: async () => [{ providerId: "test-state-provider", accountId: "valid-account" }],
  });
  const started = await authorizer.begin();
  const invalid = new URL(callbackRequest.redirectUri);
  invalid.searchParams.set("code", "attacker-code");
  invalid.searchParams.set("state", "wrong-state");
  assert.equal((await fetch(invalid)).status, 400);
  assert.equal((await authorizer.poll(started.sessionId)).status, "pending");
  const valid = new URL(callbackRequest.redirectUri);
  valid.searchParams.set("code", "valid-code");
  valid.searchParams.set("state", callbackRequest.state);
  assert.equal((await fetch(valid)).status, 200);
  assert.equal((await authorizer.poll(started.sessionId)).status, "completed");
});

test("browser OAuth polling errors fail the session visibly", async () => {
  const authorizer = createBrowserOAuthAuthorizer({
    providerId: "cursor",
    authorizationUrlBuilder: async () => ({ url: "https://cursor.com/loginDeepControl" }),
    pollSession: async () => { throw new Error("terminal polling failure"); },
    importCredentials: async () => [],
  });
  const started = await authorizer.begin();
  const result = await authorizer.poll(started.sessionId);
  assert.equal(result.status, "failed");
  assert.match(result.diagnostic, /terminal polling failure/);
  assert.equal((await authorizer.poll(started.sessionId)).status, "missing");
});

test("Claude, Grok, and Antigravity reject credential-bearing endpoint overrides", () => {
  assert.throws(() => createClaudeDriver({ tokenUrl: "https://evil.example/token" }), /allowlisted HTTPS origin/);
  assert.throws(() => createClaudeDriver({ authorizationUrl: "http://claude.com/oauth" }), /allowlisted HTTPS origin/);
  assert.throws(() => createGrokDriver({ tokenUrl: "https://evil.example/token" }), /allowlisted HTTPS origin/);
  assert.throws(() => createGrokDriver({ creditsUrl: "https://evil.example/billing" }), /allowlisted HTTPS origin/);
  assert.throws(() => createAntigravityDriver({ tokenUrl: "https://evil.example/token" }), /allowlisted HTTPS origin/);
  assert.throws(() => createAntigravityDriver({ userInfoUrl: "https://evil.example/userinfo" }), /allowlisted HTTPS origin/);
  assert.throws(() => createAntigravityDriver({ redirectUri: "https://evil.example/callback" }), /loopback HTTP/);
});

test("Cursor rejects non-allowlisted website, API, refresh, and native credential targets", () => {
  for (const options of [
    { websiteUrl: "http://cursor.com" },
    { websiteUrl: "https://evil.example" },
    { apiBaseUrl: "http://api2.cursor.sh" },
    { apiBaseUrl: "https://evil.example" },
    { refreshUrl: "https://evil.example/auth/refresh" },
  ]) assert.throws(() => createCursorDriver(options), /allowlisted official HTTPS origin|match the official API origin/);
  assert.throws(() => createCursorCatalogLoader({ apiBaseUrl: "https://evil.example" }), /allowlisted official HTTPS origin/);
  assert.throws(() => createCursorNativeExecutor({ endpoint: "http://evil.example" }), /must use HTTPS/);
});

test("Cursor desktop raw credential extraction is disabled without explicit consent", () => {
  assert.equal(readCursorDesktopSession({ allowDesktopSession: false }), null);
  assert.equal(readCursorDesktopSession({ env: { CURSOR_API_KEY: "secret", DOCKYARD_CURSOR_ACCESS_TOKEN: "secret" } }), null);
});

test("Cursor login challenge and poll verifier stay only in the provider authorization URL", async () => {
  const driver = createCursorDriver({
    commandRunner: async () => { throw new Error("CLI must not run"); },
    fetchImpl: async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
  });
  const started = await driver.startAuthorization();
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin, "https://cursor.com");
  assert.ok(url.searchParams.get("challenge"));
  assert.ok(url.searchParams.get("uuid"));
  assert.equal(JSON.stringify(started).includes("verifier"), false);
  await driver.cancelAuthorization(started.sessionId);
});

test("non-macOS defaults fail closed instead of keeping provider secrets in memory", async () => {
  const store = createDefaultSecretStore({ platform: "linux" });
  assert.equal(store instanceof UnavailableSecretStore, true);
  assert.equal(await store.read("keychain://missing"), null);
  await assert.rejects(
    () => store.write("keychain://new", { access: "secret" }),
    /Secure credential storage is unavailable/,
  );
});
