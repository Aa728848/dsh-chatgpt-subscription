# Cline Pass line — integration plan and evidence

Status: implemented in this branch, mock-verified, **not live-verified against a real Cline Pass subscription**.

## 1. What was ported and what was not

The source is the MIT-licensed plugin [`dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass) (read at `798637a`, 2026-10-20). Its feature set is reproduced as an independent line in this plugin:

| Source feature | Ported as | Notes |
| --- | --- | --- |
| Single provider route with API-key accounts | `ClinePassAccountPool` + `ClinePassAdapter` | Reuses `AccountPoolCore`, so rotation, cooldowns, auth markers and encrypted storage are shared with the other lines |
| Streaming chat completions, tools, images, reasoning, idle timeout | `client.ts` + `mapper.ts` + `adapter.ts` | `stream_options.include_usage`, `reasoning_effort`, image parts as `image_url` data URLs |
| Pipeline detection and dual-spelling pins | `protocol.ts` | `provider.only/order/sort` (direct) **and** `providerOptions.gateway.*` (planner) by default |
| Channel probe / validate / pin / exclude / failover | `engine.ts` | Failover only before the first delivered chunk; success is judged by the channel the response reports |
| Official catalog refresh | `routes.ts` + `client.ts` | `recommended-models`, models.dev, and the upstream gateway's own catalog; additive only |
| Official quota windows (5h / week / month) | `routes.ts` + composer badge | Read per account, cached in the observation store; never blocks a request |
| In-process request history | `store.ts` + `GET /history` | Includes attempts, actual channel, latency, token counts and error |
| 8 management tools | `tools.ts` | Registered only when `exposeTools` is stored; read at startup (the original plugin's rule) |
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
| OpenRouter public API | `https://openrouter.ai/api/v1` | `lib/cline.js` `OPENROUTER_API` |
| Reasoner effort vocabulary | `none, minimal, low, medium, high, xhigh, max` | `lib/catalog.js` `REASONING_EFFORTS` |
| Pinned channel alias | `zai` (planner) ↔ `z-ai` (direct) | `lib/protocol.js` `CHANNEL_ALIASES` |
| Upstream list cap | 64 | `lib/protocol.js` `MAX_UPSTREAMS` |
| Spent-window detection | status 402, or window name + exhaustion wording | `lib/adapter.js` `streamErrorCode` |

The model table in `src/host/cline-pass/types.ts` is a literal transcription of `lib/catalog.js` `MODEL_CATALOG` (15 entries, with per-model context window, output ceiling, modalities and effort ladder). No number was guessed during the port; a model the table does not know is adopted from the live scan with conservative metadata.

## 3. Decisions

1. **Account pool semantics come from the kernel, not from the source.** The source's cooldown map stood an account down for 15 minutes on `QUOTA` and 30 minutes on auth failure. This line stores `authStatus: invalid` on AUTH (a revoked key needs replacement, not waiting) and a 15-minute cooldown on QUOTA. A plain 429 is treated as channel-level and does **not** stand the account down — the source made the same distinction.
2. **Both pin spellings are written by default.** The gateway can route a model through either pipeline between calls. `pinSpelling: 'detected'` restores the source's single-spelling behaviour for deployments that want it.
3. **Pin success is read back, never assumed.** A 200 is not evidence that an `only` list was honored; the adapter records the channel named by the response, and marks the channel available only when the pin was actually adopted.
4. **Quota is per account.** The badge shows the most-consumed window across accounts the host has already read; refreshing is an explicit action that costs one request per usable account.
5. **Tools are off by default**, matching the source's shipped default. The setting is read when the line starts; the card says a restart is required because a registered tool cannot be withdrawn from a live conversation.
6. **No sibling line was edited.** Shared additions are appends only: one id in `CONTROLLED_PROVIDERS`, one in `DIAGNOSTIC_PROVIDERS`, one hub entry, one brand entry, one locale/style/slot registration, and one item in each existing count assertion.

## 4. Verification

- `npm run typecheck`: host + client + tests, 0 errors.
- `npx vitest run`: 259 files / 4129 passed, 9 skipped (baseline before this line: 253 / 4074).
- `npm run build` and `npm pack --dry-run`: `lib/types/host/cline-pass/*` present in the tarball.
- New tests:
  - `test/cline-pass-protocol.test.ts` — attempt expansion, both spellings, aliases, adherence, exclusions, channel recovery.
  - `test/cline-pass-mapper.test.ts` — tool-group serialization, image parts, body construction, SSE translation, usage, finish/error codes.
  - `test/cline-pass-routes.test.ts` — status envelope, account add without leaking the key, pin/visibility persistence, settings validation, same-origin guard, history.
  - `test/cline-pass-adapter.test.ts` — channel failover before the first chunk and account rotation on 401.
  - `test/cline-pass-section.test.tsx` — shared account card, channel chips and their verdicts, local pin editing and save, quota rendering, no key in the DOM.

## 5. Risks and left-unverified

- **No live subscription was used.** Every wire shape came from the source plugin's captured behaviour and the public catalogs above. The first real use should start with a probe + test on the target model, exactly as the card says.
- **The gateway is not a public contract.** Channel names, whether `provider.only` is honored, and error wording can change without notice. The line deliberately reads the serving channel back instead of promising that a pin works.
- **Quota endpoint shape unverified on this line.** The reader accepts both `{ data: { limits } }` and a bare `{ limits }`, and reports any refusal; it does not fabricate zeroes when the endpoint changes.
- **Catalog drift.** The shipped table is a snapshot. A model published after this release is adopted from the live scan; if every source is unreachable, it is simply absent rather than invented.
- **No migration from the standalone plugin.** Its settings section (`cline-pass`) and credential references are not read; a user re-adds the key in this card. `CLINE_PASS_API_KEY` is projected as the primary account while the pool is empty, which covers the environment-variable workflow but not a multi-account settings document.
- **Concurrency is doubled when `DSH_PROVIDER_CONCURRENCY` is set**: the shared diagnostic/controlled fetch applies the deployment cap, and the line's own per-account gate applies the card's setting. Both caps are legitimate; the tighter one wins, and there is no cyclic wait because the line gate is acquired before the fetch.
