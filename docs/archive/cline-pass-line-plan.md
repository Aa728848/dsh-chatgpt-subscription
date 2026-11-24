# Cline Pass line — integration plan and evidence

Status: current architecture uses automatic gateway routing only. Client-side upstream pinning, channel probing and per-channel validation were removed after Cline rejected client-supplied `providerOptions`; see §10. Sign-in uses Cline's WorkOS device authorization.

## 1. What was ported and what was not

The source is the MIT-licensed plugin [`dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass) (read at `798637a`, 2026-10-20). Its feature set is reproduced as an independent line in this plugin:

| Source feature | Ported as | Notes |
| --- | --- | --- |
| Single provider route with API-key accounts | `ClinePassAccountPool` + `ClinePassAdapter` | Reuses `AccountPoolCore`, so rotation, cooldowns, auth markers and encrypted storage are shared with the other lines; API keys remain a compatibility fallback |
| Cline account sign-in (not in the standalone plugin) | `oauth.ts` + `/login/*` routes + card panel | WorkOS device authorization → `auth/register` → pooled OAuth session; `Bearer workos:<access>`; rotating refresh before expiry |
| Streaming chat completions, tools, images, reasoning, idle timeout | `client.ts` + `mapper.ts` + `adapter.ts` | `stream_options.include_usage`, `reasoning_effort`, image parts as `image_url` data URLs |
| Response routing observation | `protocol.ts` | Reads the actual channel and pipeline without sending client routing preferences |
| Account failover / ordinary model test | `engine.ts` | No upstream pin chain; account rotation and ordinary automatic requests remain |
| Official catalog refresh | `routes.ts` + `client.ts` | `recommended-models`, models.dev, and the upstream gateway's own catalog; additive only |
| Official quota windows (5h / week / month) | `routes.ts` + composer badge | Read per account, cached in the observation store; never blocks a request |
| In-process request history | `store.ts` + `GET /history` | Includes attempts, actual channel, latency, token counts and error |
| 5 management tools | `tools.ts` | Registered only when `exposeTools` is stored; read at startup (the original plugin's rule) |
| Web setup panel (vanilla DOM in the source) | `ClinePassSection.tsx` | Rebuilt on the shared `.dsha-*` components and the hub card; no source HTML/CSS was copied |

Not ported, deliberately:

- The source's `/api/cline-pass` RPC channel (this plugin's lines use `/<line>/api` routes).
- The source's `apiKeyEnv` credential-reference indirection (this plugin's pool stores the key encrypted per account instead).
- The source's `accountMode: single|roundrobin` switch (the shared pool's `sequential|round-robin|sticky` strategy is the equivalent, and it is what the shared card renders).

## 2. Upstream constants and their source

| Constant | Value | Source |
| --- | --- | --- |
| Gateway base | `https://api.cline.bot/api/v1` | `dsh-cline-pass/lib/index.js` config default; the source's README states the same |
| Chat path | `/chat/completions` | `lib/cline.js` `chatURL` |
| Gateway catalog | `GET /models` | `lib/cline.js` `fetchGatewayCatalog` |
| Quota | `GET /users/me/plan/usage-limits` | `lib/cline.js` `USAGE_LIMITS_PATH` |
| Official model list | `GET https://api.cline.bot/api/v1/ai/cline/recommended-models` | `lib/cline.js` `RECOMMENDED_MODELS_URL` |
| Community registry | `GET https://models.dev/api.json` | `lib/cline.js` `MODELS_DEV_URL` |
| Upstream gateway catalog | `GET https://ai-gateway.vercel.sh/v1/models` | `lib/cline.js` `VERCEL_MODELS_URL` |
| Reasoner effort vocabulary | `none, minimal, low, medium, high, xhigh, max` | `lib/catalog.js` `REASONING_EFFORTS` |
| Spent-window detection | status 402, or window name + exhaustion wording | `lib/adapter.js` `streamErrorCode` |
| WorkOS client id | `client_01K3A541FN8TA3EPPHTD2325AR` | Cline repo `sdk/packages/shared/src/runtime/cline-environment.ts` (production entry) |
| WorkOS device authorize | `POST https://api.workos.com/user_management/authorize/device` | Cline repo `sdk/packages/core/src/auth/cline.ts` |
| WorkOS device poll | `POST https://api.workos.com/user_management/authenticate` | same |
| Cline token register | `POST https://api.cline.bot/api/v1/auth/register` `{accessToken, refreshToken}` | same |
| Cline token refresh | `POST https://api.cline.bot/api/v1/auth/refresh` `{refreshToken, grantType:'refresh_token'}` | same |
| OAuth bearer | `workos:<accessToken>` | Cline repo `sdk/packages/core/src/auth/provider-auth-registry.ts` `formatClineApiKey`; sent as `Bearer` by `sdk/packages/llms/src/providers/vendors/cline.ts` |
| Hub card mark | Official Cline glyph, `viewBox="0 0 113 113"`, `#343B42` tile | Cline repo `assets/branding/logos/cline-icon-white.svg` and `assets/branding/cline-app-icon.svg` (commit `ca7402c`, 2026-10-20); the white variant's single fill is `currentColor` |

The model table in `src/host/cline-pass/types.ts` is a literal transcription of `lib/catalog.js` `MODEL_CATALOG` (15 entries, with per-model context window, output ceiling, modalities and effort ladder). No number was guessed during the port; a model the table does not know is adopted from the live scan with conservative metadata.

## 3. Decisions

1. **Account pool semantics come from the kernel, not from the source.** The source's cooldown map stood an account down for 15 minutes on `QUOTA` and 30 minutes on auth failure. This line stores `authStatus: invalid` on AUTH (a revoked key needs replacement, not waiting) and a 15-minute cooldown on QUOTA. A plain 429 is treated as channel-level and does **not** stand the account down — the source made the same distinction.
2. **Routing belongs to Cline.** Requests never include `provider` or `providerOptions`; legacy pin values are ignored.
3. **Response routing is observational only.** The adapter records the channel named by the response without treating it as a configurable preference.
4. **Quota is per account.** The badge shows the most-consumed window across accounts the host has already read; refreshing is an explicit action that costs one request per usable account.
5. **Tools are off by default**, matching the source's shipped default. The setting is read when the line starts; the card says a restart is required because a registered tool cannot be withdrawn from a live conversation.
6. **Sign-in is OAuth, not a pasted key.** The Cline clients use WorkOS device authorization for `cline` / `cline-pass`; this line follows that flow and stores the rotating refresh token in the pool, so a session survives a host restart and refreshes before expiry. The standalone plugin's static key remains a secondary, documented fallback. Polling is card-driven and host-throttled to WorkOS's advertised interval; a cancelled flow can never persist late-arriving credentials.
7. **Refresh failures are classified, not collapsed.** `invalid_grant` (and 400/401/403 with invalid-token wording) marks the account `invalid` and asks for a new sign-in; a network or 5xx failure is wrapped as `TRANSPORT` and leaves the account in the pool. This is the same distinction Cline's own `getValidClineCredentials` makes.
8. **A pre-request transport failure is retried twice.** Host-to-gateway TLS handshakes can fail intermittently on a path where curl succeeds; the request body has not left the host, so replaying is safe. The retry is deliberately limited to connect/handshake errors; a mid-stream reset is never replayed.
9. **No sibling line was edited.** Shared additions are appends only: one id in `CONTROLLED_PROVIDERS`, one in `DIAGNOSTIC_PROVIDERS`, one hub entry, one brand entry, one locale/style/slot registration, and one item in each existing count assertion.

## 4. Verification

- `npm run typecheck`: host + client + tests, 0 errors.
- `npx vitest run`: 267 files / 4390 passed, 9 skipped (rebased onto upstream 0.31.0; this line adds 8 test files / 68 cases).
- `npm run build` and `npm pack --dry-run`: `lib/types/host/cline-pass/*` present in the tarball.
- New tests:
  - `test/cline-pass-protocol.test.ts` — response routing, anonymous-route and fingerprint observation, authentication classification.
  - `test/cline-pass-mapper.test.ts` — tool-group serialization, image parts, body construction, SSE translation, usage, finish/error codes.
  - `test/cline-pass-routes.test.ts` — status envelope, account add without leaking the key, removed pin routes, visibility, settings validation, same-origin guard, history.
  - `test/cline-pass-adapter.test.ts` — no legacy routing fields in streams, account rotation on 401, transport retry and empty-response replay.
  - `test/cline-pass-section.test.tsx` — shared account card, ordinary model-test payload, anonymous-route observation, quota rendering, no key in the DOM.
  - `test/cline-pass-oauth.test.ts` — device authorization, poll interval, pending/denied outcomes, token registration/refresh bodies, invalid-grant classification and both credential generations.
  - `test/cline-pass-account-refresh.test.ts` — expired OAuth session refreshes and persists the rotated pair; a rejected grant marks the account invalid; a static key never triggers a refresh.
  - `test/cline-pass-routes.test.ts` also covers `/login/start`, interval-throttled `/login/status`, and the account landing in the pool.

## 5. Risks and left-unverified

- **No live subscription was used.** Every wire shape came from the source plugin's captured behaviour, the Cline repository above, and the public catalogs. In particular the WorkOS device flow and `auth/register` have only been exercised against mocks; the first real use should complete one browser sign-in, then probe + test the target model.
- **The gateway is not a public contract.** Channel names, whether `provider.only` is honored, and error wording can change without notice. The line deliberately reads the serving channel back instead of promising that a pin works.
- **Quota endpoint shape unverified on this line.** The reader accepts both `{ data: { limits } }` and a bare `{ limits }`, and reports any refusal; it does not fabricate zeroes when the endpoint changes.
- **Catalog drift.** The shipped table is a snapshot. A model published after this release is adopted from the live scan; if every source is unreachable, it is simply absent rather than invented.
- **No migration from the standalone plugin.** Its settings section (`cline-pass`) and credential references are not read; a user re-adds the key in this card. `CLINE_PASS_API_KEY` is projected as the primary account while the pool is empty, which covers the environment-variable workflow but not a multi-account settings document.
- **Concurrency separation**: `src/index.ts` passes `proxyFetch` for routes, OAuth, quota reads and catalog sync, and `modelFetch['cline-pass']` (`streamFetchFn`) only for live adapter chat streams, matching the sibling lines.

## 6. Historical gateway behaviour measured with pins (2026-10-23)

The pin mechanism discussed here was later removed; it is retained only as historical evidence, not current architecture.

Cross-checked against the MIT-licensed observer plugin [`dsh-clinepass-deepseek`](https://github.com/BreakFree003/dsh-clinepass-deepseek) and re-measured live on two accounts:

- **Pin honoring is decided per model id and flips over time.** On 2026-10-23 the gateway redirected `cline-pass/deepseek-v4.1-flash-1017` onto the VMC contributor fallback: `only: [deepseek]` was silently ignored (even a nonexistent channel answered 200), and the plan line read `Routed via VMC 'deepseek-v4p1-flash-1017-contributor-fallbacks' → private/deepseek-v4p1-flash-1017-contributor`. At the same moment `cline-pass/deepseek-v4-pro` honored `only: [deepseek]` (`Provider set restricted to: deepseek`). Neither account choice nor quota moved this. The line therefore treats adherence as a per-id, per-moment reading, never a property of the mechanism.
- **The anonymous contributor route reports itself as `openai-compatible-private`** and resolves to a `private/…-contributor` slug. Answers from it may be used for training and carry no ZDR guarantee; the line now flags it on the channel chips, in pin warnings, in test results and in request history instead of rendering it as a channel like any other.
- **Only `provider_metadata.deepseek.systemFingerprint` proves a first-party DeepSeek answer.** The top-level `system_fingerprint` is minted by the gateway per request. The fingerprint is read off both `message` and `delta` metadata and recorded per model and per request.
- **Streaming frames carry the routing block on `choices[].delta.provider_metadata` in a terminal frame after the content.** Earlier this line read only `message.provider_metadata`, so every streamed request recorded `adherence: unresolved`. `parseRouting` now reads `delta` too and hunts the routing block recursively (depth-capped), matching the observer plugin's `collectRouting` behaviour. Because the frame trails the content, an ignored strict pin cannot be failed over mid-stream; it is recorded and surfaced instead.
- **The dated snapshot id `cline-pass/deepseek-v4.1-flash-1017` is a first-class catalog entry** (921600/384000, transcribed from the observer plugin's measured card), so the pinnable id does not depend on a live scan adopting it.

## 7. Historical capability-filter experiment (measured 2026-10-24)

This experiment is not current behavior. Cline later rejected client-supplied `providerOptions`, and the pin/capability-filter path was removed.

A pin on 1017 needs more than `only`. Live A/B on the same model and account, repeated twice: `providerOptions.gateway.only:[deepseek]` alone answered through `openai-compatible-private` with no first-party fingerprint; adding `has:[vision,implicit-caching]` answered through `deepseek` with `provider_metadata.deepseek.systemFingerprint`. With the same `has`, an impossible `only` once again fails and names the available providers instead of silently returning the anonymous route.

The line therefore stores `has` beside each pin and sends it only as `providerOptions.gateway.has` (never as an OpenRouter `provider` field). Live streams, Test, Validate and Probe's `__probe__` harvest share the same value. The 1017 catalog entry declares the measured default; a legacy pin that predates the field inherits it, an explicitly saved empty array means the user cleared it, and every other model stays unchanged. An engine-level live run against the existing settings discovered 18 channels and returned `adopted` with the first-party fingerprint. The reproducible, credential-redacting probe is `scripts/probe-cline-pass-has.probe.ts`.

## 8. Compact model list with search-to-add (2026-10-24)

The gateway's full model list is a search index, not a settings page. Earlier `catalog/refresh` merged that list into `catalogModels` whenever the legacy `exposeCatalog` flag was on, which made the card and the model picker hundreds of rows long. Refresh now adopts only official subscription entries into settings and keeps the complete gateway list solely in `store.catalog()`.

Catalog rows carry `origin: official | custom | gateway`; a legacy row without an origin is listed only when its id starts with `cline-pass/`. The same `listedClinePassCatalogModels()` filter feeds the settings card, adapter advertisement and visibility tools, so a hidden gateway row cannot reappear in the picker. Enabled/hidden selections and metadata remain in the file. Legacy pin keys are used only as an in-use catalog migration clue; their routing values are ignored. On the live settings at the time of the change, 492 stored rows became 20 listed rows (472 legacy gateway rows folded away), plus the bundled table.

`GET /catalog/search?q=` returns at most 30 matches and never an unfiltered dump; `POST /catalog/add` marks the chosen row `origin: custom`, unhides it and appends it to an explicit enabled-id selection. Both the HTTP refresh and the management-tool refresh preserve the gateway search index.

## 9. Official 1017 id versus stale bundled metadata (2026-10-24)

The 1017 id is real, not a probe-created alias: the official `recommended-models` response includes `cline-pass/deepseek-v4.1-flash-1017`, and a live pinned request returns `canonicalSlug=deepseek/deepseek-v4.1-flash-1017` with the first-party fingerprint. The stale part was the bundled metadata introduced in §6. The reference card said `DeepSeek V4.1 Flash (1017)` / 921600; the current Vercel model catalog says `DeepSeek V4.1 Flash 1017` / 1048576. Because the shipped table outranks synced metadata, the stale values hid the correct official ones. The bundled name and context window now follow the current official catalog; routing remains automatic.

## 10. Removal of client-side upstream pinning

Cline rejects client-supplied `providerOptions` model routing. Instead of maintaining a retry compatibility path, the line now removes the whole opt-in surface: pin settings and editors, pin/probe/validate HTTP routes, `cline_pass_pin`, `cline_pass_probe`, `cline_pass_validate`, request injection, per-channel verdict storage, and their public DTO/export surface.

Ordinary chat, account rotation, model catalog management, OAuth, quotas, request history and response-route observation are unchanged. Both ordinary model tests and live streams have regression assertions that the request body contains neither `provider` nor `providerOptions`, including when legacy settings contain pin data.
