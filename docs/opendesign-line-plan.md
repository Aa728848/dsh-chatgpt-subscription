# OpenDesign line — integration plan and evidence

Status: implemented, mock-verified. The device-authorization contract was **probed live** (2026-10-21, quoted below); the approval frame's field names are cross-checked against upstream issue [nexu-io/open-design#8870](https://github.com/nexu-io/open-design/issues/8870). No human approved a probe authorization, so the approved frame itself is inferred from the pending frame's shape plus that issue — the reader keys on key presence, never on a status string, which is exactly what makes that inference safe to ship. No chat call against a real key was made.

## 1. What the line is

OpenDesign ([open-design.ai](https://open-design.ai/), open source at [nexu-io/open-design](https://github.com/nexu-io/open-design)) sells subscription plans (Go/Plus/Pro/Max) whose model credits third-party tools spend through the "OpenDesign API". The official pricing FAQ names the consumers verbatim: "Use an OpenDesign API Key with Codex, Claude Code, DSH, OpenCode, or Hermes."

This plugin's line:

| Feature | Implementation | Notes |
| --- | --- | --- |
| Provider route `opendesign` | `OpenDesignAdapter` + `claimProviderRoute` | OpenAI Chat Completions, streaming, tools, images, reasoning passthrough |
| **Browser device-authorization sign-in** | `oauth.ts` + `/login/*` routes | The official `vela login` flow reimplemented over its public HTTP contract. Issues a `vela_ctrl_…` + `sk-amr-…` pair plus the account identity (email / name / plan) |
| Pasted API key (fallback) | account pool, same card | The console-issued path the FAQ documents; chat only |
| Account pool | `OpenDesignAccountPool` | Reuses `AccountPoolCore`: rotation, cooldowns, auth markers, encrypted storage. No refresh hooks: neither key kind expires |
| Live model catalog | `GET {gateway}/models` | Synced on explicit refresh, behind a key add, and behind a completed sign-in; synced entries persist in the settings document (restart = local read) |
| Bundled fallback table | `src/host/opendesign/types.ts` | 37 chat models with id, display name, USD/1M-token price, plus per-model **context window, output cap, input modalities and reasoning ladder** transcribed from this repository's already-sourced sibling tables (see §2). Two models no sibling documents keep the line defaults |
| Wallet balance | `GET {amr}/wallet/balance` with the control key | OAuth accounts only; an explicit refresh, one upstream call per readable account; never blocks a request |
| Public price list | `GET /api/v1/public/model-prices` | Unauthenticated, 200, 37 chat models with USD/1M-token prices (fetched 2026-10-21). Source of the table's ids, names and prices |
| Per-model metadata (shipped) | windows / output caps / modalities / ladders | **No OpenDesign endpoint publishes these to an API key**, so the table transcribes the same vendor models from this repository's sourced tables: `command-code/model-catalog.ts` (official CLI registry transcription: windows, `inputModalities`, `reasoningEfforts`, some caps), `cline-pass/types.ts` (DSH-spelled ladders and caps; wins where the two disagree), `claude/model-catalog.ts` (Claude rows), `antigravity/types.ts` (Gemini 4 Argon). The registry's `off` level is translated to DSH's `none` |
| Per-model metadata (live) | `GET {amr}/models` with the CONTROL key | The AMR control-plane catalog (the open-source daemon reads it as `vela model list --all --format json`): items carry `metadata.contextWindowTokens`, and the reader also accepts `contextWindowTokens` / `context_window_tokens` / `contextLength` / `context_length` per `apps/daemon/src/runtimes/defs/amr.ts`. Ids arrive as `public_model_deepseek_v4_1_flash` and are normalized onto the wire ids by comparing alphanumerics only. Requires a control key (OAuth account); the gateway listing remains the source for a pasted key |
| Composer badge | balance of the primary readable account | Shows nothing for a pasted-key-only pool; danger-red only at exactly $0 |

## 2. Upstream constants and their source

| Constant | Value | Source |
| --- | --- | --- |
| Gateway base (OpenAI spelling) | `https://amr-link.open-design.ai/v1` | Cloud console quick-setup bundle (`of()` composes `{link}/v1` for OpenAI clients from `services.link`; the host literal is baked into the same bundle), 2026-10-21. Probed: `/v1/models`, `/v1/chat/completions`, `/v1/responses` answer 401 `{"error":{"code":"missing_api_key"…}}`; `/v1/messages` answers 401 in the Anthropic envelope |
| Protocol spoken | OpenAI Chat Completions | The console quick-setup labels it "Recommended for DeepSeek Harness, OpenCode, and Hermes Agent" |
| AMR control plane | `https://amr-api.open-design.ai/api/v1` | Console bundle `services.api` + the open-source daemon (`apps/daemon/src/integrations/vela.ts` `DEFAULT_AMR_API_URL`) |
| Device authorization create | `POST {amr}/cli/device-authorizations` `{host, profile, cliVersion}` → 201 | **Probed live 2026-10-21.** Answer (secrets redacted): `{"deviceId":"umk6ij…","userCode":"EG935Z","status":"pending","cliVersion":"0.0.0","host":"dsh-probe","profile":"prod","expiresAt":"2026-10-21T05:09:56.409Z","deviceSecret":"SJxJ…","activationUrl":"https://open-design.ai/cloud/cli/activate?deviceId=…&userCode=…","pollIntervalSeconds":2}` |
| Device poll | `POST {amr}/cli/device-authorizations/{deviceId}/token` `{deviceSecret}` | **Probed live**: pending answers 200 with `status:"pending"` and `controlKey:null, runtimeKey:null, user:null`. Approved frame: keys + user populated, per #8870 (see Status note above) |
| Issued key kinds | `vela_ctrl_…` control key + `sk-amr-…` runtime key | #8870 verbatim; the control key "can read workspace, billing summary, wallet balance and billing preflight data" |
| Wallet balance | `GET {amr}/wallet/balance`, `Bearer <controlKey>` → `{balanceUsd: "12.34", updatedAt: "…"}` | The open-source daemon's reader (`apps/daemon/src/integrations/vela-wallet.ts`): balanceUsd is a STRING matching `/^\d+(\.\d+)?$/`; billing 401/403 is display-only upstream (OPEND-3553) and must never mark the account |
| Key refusal on the gateway | a pasted key rides `Bearer`; bad keys answer `invalid_api_key` / "api key not found" | Probed 2026-10-21 |
| Console URL for key creation | `https://open-design.ai/cloud` (workspace → API Keys) | Console is a SPA; the card links the workspace root and says "API Keys" in words |
| Concurrency entitlement | 10 concurrent tasks (cheapest plan) | https://open-design.ai/pricing/ plan cards (10/20/30 by tier) |
| Card brand mark | Official logo-mark, `viewBox="9 9 82 82"`, fill #202020 | https://open-design.ai/cloud/assets/logo-mark-nav-Cmeb7g0L.svg — 2026-10-21, HTTP 200, 1,022 bytes, sha256 439141e0…0c67. Tile tint #EFF8E9 is the highlight surface from open-design.ai's own stylesheet |

## 3. Decisions

1. **Two sign-in paths, one pool.** Device authorization is the primary (it also yields identity + balance reads); a pasted console key remains as the documented fallback. The card's account heading holds exactly the two entries (the shared card's two-button rule).
2. **The host never opens a browser.** `/login/start` answers the activation URL and launches nothing; the card `window.open`s it (pinned in `test/login-opens-browser-once.test.ts`).
3. **Completion is read from the payload's shape.** `runtimeKey`/`controlKey` present = approved; a non-pending status with no keys = refusal, reported in the service's words. A 200 with null keys is pending, never a credential. A cancelled flow never persists a late-arriving approval.
4. **Quota is a balance, not a window.** The wallet answers one current dollar figure, so the account row shows it as a detail line ("$12.34 · read at …") and the composer badge carries the primary readable account's figure. No percentage is invented against an unstated total; the badge turns red only at exactly $0 (a spent balance is a fact; a threshold is not).
5. **Billing failures never mark an account.** Upstream maps billing refusals to 403 (OPEND-3553 in the open-source repo), so a wallet 401/403 is rendered as "unavailable" data and the chat credential keeps serving.
6. **A catalog sync announces only a real change** (id-sequence fingerprint compare before/after), and runs behind a sign-in or key add rather than on a poll loop.
7. **The fallback table and the whitelist share one id vocabulary** (the gateway's wire ids), so a cold-start filter cannot empty the picker; `[]` still wins in both phases. Synced catalog entries persist in the settings document — the warm path is a local read.
8. **The reasoning ladder is per model and sourced like the windows**: each row publishes its own ladder (e.g. `none/low/high/max` for DeepSeek, `low/medium/high/xhigh/max` for the Claude and GPT-6 families), the command-code registry's `off` is translated to DSH's `none`, and a model no source documents keeps the OpenAI trio as a *default* rather than being declared a non-reasoner. Rows whose source publishes no ladder at all (MiMo V2.6) are marked `reasoning: false` — the absence is a fact, not an omission.
9. **No sibling line was edited.** Shared additions are appends only: one id in `CONTROLLED_PROVIDERS`, one in `DIAGNOSTIC_PROVIDERS`, one hub entry, one brand entry, one locale/style/slot registration (badge at order 46), and one item in each existing count assertion.

## 4. Verification

- `npm run typecheck`: host + client + tests, 0 errors.
- `npx vitest run`: full suite green; this line adds 8 test files.
- New tests:
  - `test/opendesign-oauth.test.ts` — create body/answer, pending-vs-approved by shape, refusal vocabulary, full flow into the pool (both keys, alias from user), cancelled flow never persists, expiry fails, transient poll failure keeps polling, second begin() retires the first, bearer split.
  - `test/opendesign-routes.test.ts` — plus: /login/start answers the URL without the deviceSecret, poll-to-complete with no keys in any payload, cross-origin guards, wallet reads for OAuth accounts only (pasted keys skipped), refusal wording when none exist.
  - `test/opendesign-section.test.tsx` — plus: the two sign-in entries in the heading, the pending block's code+link, idle-with-accounts vs idle-empty text, the OAuth row's plan/balance rendering.
  - `test/login-opens-browser-once.test.ts` — the line added to the pin.
  - adapter: an OAuth account chats with its runtime key, never the control key.
- The tri-state guard was proven red-first (broken parser → two red cases → revert → green).

## 5. Risks and left-unverified

- **The approved poll frame was never observed** (probing cannot approve itself). Mitigation: completion keys on `runtimeKey`/`controlKey` presence; the pending frame's null-key shape was probed live; the field names come from #8870. First real sign-in should confirm the account lands with email/plan populated.
- **The denied/expired poll vocabulary is unobserved** (a denial needs a browser). The reader treats any non-pending keyless frame as a refusal with the service's text, and 404/410 as terminal.
- **No chat call against a real key** — the mapping is pinned against the OpenAI shape and the gateway's probed 401 envelopes only.
- **The shipped windows are vendor facts, not this gateway's clamp.** They come from sibling tables of the same vendor models; a gateway may serve a smaller window, and an overstated one shows up as a context-length 400 on a very long conversation. Mitigations: the control-plane catalog (OAuth accounts) overrides them at sync time, the per-model editor corrects any row, and both beat the table. The one in-repo conflict (`gpt-6`/`gpt-5.6` family: 1.05M here vs 272k/384k in the ChatGPT-subscription catalog) is resolved toward the API-tier figure; OpenDesign's own price list prices a long-context tier **above** 272k input tokens, which independently shows the window exceeds 272k.
- **Two models no sibling table documents** — `minimax-m3.1-flash` and `muse-wonder` — keep the line defaults (128k, trio) until a live catalog or the user fills them; they are listed rather than guessed.
- **`POST /api/v1/oauth/token` (RFC 8628 device_code grant) appears in the open-source repo's tests but answered 404 live** — the current flow uses `{deviceId}/token` instead; the old path is recorded here so nobody "fixes" the new one into it.
- **Device-issued keys never expire** (per #8870, no expiry published or observed) and the console cannot yet list/revoke them — sign-out here is a local delete until upstream grows revocation.
- **Wrong-`deviceSecret` and post-expiry poll responses timed out during probing** (edge rate limiting, not observed verdicts).
