# Codex subscription wire surface (upstream follow-up, not a harness round)

Not a harness upgrade: the DSH baseline is unchanged (0.2.0-rc.2), and no
harness seam moved. This file exists because the changes below alter the
compatibility seam the skill's "Provenance and names" table points at
(`src/host/codex-images.ts`), and because the next person to look at the Codex
line needs to know these values are reverse-engineered, not documented.

Harness checkout: `C:\Users\A\Documents\deepseek-harness` (unmodified this
round).

## 1. What upstream actually guarantees

OpenAI's Codex lead states the subscription is meant to be usable from third-
party agents — "in the app, in the terminal, but also in JetBrains, Xcode,
OpenCode, Pi, and now Claude Code" — and Codex CLI / app server are open
source. So this line is on the supported path, not a grey area. The wire
values below are still private and may change without notice.

Cross-checked against: the Codex CLI sources (`codex-rs/login`, `codex-rs/
backend-client`, `codex-rs/codex-api`), plus three independent reverse-
engineering write-ups (lunavod/codex-open-client internals, 10/chatgpt-codex-
proxy CODEX_API_DOCS.md, 7shi/codex-oauth).

## 2. What was already correct (do not "fix" these)

- `client_id` `app_EMoamEEZ73f0CkXaXp7hrann` — the CLI's own, reused by
  OpenCode; no third-party allocation mechanism exists.
- `scope` = identity scopes only. API scopes (`model.request` etc.) are
  REJECTED by the auth server; permissions are implicit from client id.
- redirect `http://localhost:1455/auth/callback`.
- authorize params `id_token_add_organizations` + `codex_cli_simplified_flow`.
- payload `stream:true` + `store:false` + `include:[reasoning.encrypted_content]`.
- account id read from the JWT `chatgpt_account_id` claim (no signature check
  needed).

## 3. Gaps closed this round

| Change | File | Why |
|---|---|---|
| `openai-beta: responses=experimental` | `wire-auth.ts` | The subscription backend is beta-gated; the official CLI always sends this and reverse-engineering docs list it as required. Its absence works today only because the backend is currently lenient — this is the line that becomes a 400/403 on the next tightening. |
| one `CODEX_ORIGINATOR` | `compat.ts`, `codex-images.ts`, `codex-search.ts` | Three values were in use (`opencode` for chat+OAuth, `pi` for image and search) — an archaeological record of when each endpoint was reverse-engineered. The backend keys behaviour off this value, so one account had three unrelated failure signatures. `OAUTH_ORIGINATOR` now aliases the same constant, so sign-in and request cannot disagree. |
| live model listing | new `codex-catalog.ts` | The subscription's whole advantage is a fresher model surface than the API key path, and this line hardcoded it — a new model needed a code change and a release. Now reads `GET /backend-api/codex/models?client_version=…`, cached 15 min per account, single-flighted, persisted through the existing `catalog-snapshot` module and scoped by account id. |
| `prompt_cache_key` + `x-codex-turn-state` | `responses-mapper.ts`, `responses-client.ts` | Both are the backend's own continuation mechanisms; without them every turn re-sent the whole history. |

## 4. Design notes worth keeping

- **The shipped `shared/model-catalog.ts` table is the floor, not the ceiling.**
  A failed listing widens the picker instead of emptying it, and a failed call
  never overwrites a good snapshot with the fallback. This mirrors the Claude
  line's `catalog()` contract.
- **An unknown model id is served, with conservative capabilities.** The listing
  is the authority on what the account may call, so a model this table has
  never heard of still appears — but unstated modalities fall back to text
  only, and unstated reasoning levels fall back to the family profile. Never
  widen from silence.
- **Reasoning levels are filtered through `isCodexReasoningEffort`** before
  reaching the picker, and the default effort is taken from the levels that
  survived — otherwise a dropped level would be sent as the default.
- **Turn state is an optimization with no correctness role.** It is cleared the
  moment the backend stops sending it rather than replayed stale, and the map is
  capped at 200 sessions with oldest-first eviction: a long-lived host serves
  many sessions and nothing signals that one ended.
- **`store:false` also means reasoning items must be filtered out of replayed
  input** (they carry server-side ids that cannot be referenced). Already the
  case before this round; do not reintroduce `previous_response_id`.

## 5. Deliberately NOT adopted

- **WebSocket transport** (`wss://…/backend-api/codex/responses`): still behind
  the `ResponsesWebsockets` feature flag upstream, with a known 403-on-handshake
  report on Windows. REST+SSE is the stable path today. Revisit if the flag
  ships.
- **Device-code login** (`--device-auth`): real upstream support, and worth
  adding for headless hosts, but it is a login-flow change rather than a wire
  fix, and the callback-server seam is what currently works.
- **`originator: codex_cli_rs`** (what the official CLI sends): `opencode` is
  equally accepted and is what the OAuth flow has always presented. Changing
  the sign-in originator is a different risk from changing the request one.

## 6. Verification

- Forced typecheck (`tsc -b --force`, the only meaningful form) and the test
  tsconfig: 0 errors. `npm run build` clean.
- Full suite: **1831 passed**, 7 skipped. The 6 failures
  (`claude-model-catalog` 5, `antigravity-callback-port` 1) reproduce on a
  clean tree with this work stashed — pre-existing, unrelated.
- Old generation (clean room, 0.1.5-rc.1 pinned): host `tsc -b` clean; the one
  test file that cannot load is `subagent-model-authorization-ptc.test.ts`
  (`@deepseek-ai/dsh-ptc-runtime` does not exist before 0.1.7) — the known
  dev-only limitation from the skill's traps list.
- **Not verified end-to-end against a live subscription account.** The new
  headers, the listing endpoint and turn-state replay are asserted against
  mocked responses only. First check on a real machine: sign in, send two turns
  in one conversation, and confirm a second request carries
  `x-codex-turn-state` and a non-empty `prompt_cache_key`.