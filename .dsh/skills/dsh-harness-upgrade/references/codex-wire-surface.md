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
| ~~`max_output_tokens` always sent~~ — **reverted, do not restore** | `responses-mapper.ts` | This row was wrong in the direction that matters. Sending the field was argued from "the catalog declared a ceiling, so declare it on the wire", and the claim that the Responses endpoint accepts it ``the way `/alpha/search` does not`` came from the same round that hit the search 400 (issue #28). Issue #29 disproves it: the subscription Responses endpoint answers `400 {"detail":"Unsupported parameter: max_output_tokens"}` on at least `gpt-6-sol` / `gpt-6.1-sol` on a plus plan, and removing only this field restored conversation. The official client never sends it — `ResponsesApiRequest` in `codex-rs/codex-api/src/common.rs` has no such field, and `codex-rs/core/src/client.rs` never assigns one — so the field was this plugin's own invention, never a wire requirement. See the note below. |

## 3b. The output cap is local-only (issue #29, corrects the row above)

`max_output_tokens` must NOT be sent on the Responses path. It is a natural
thing to reach for — the catalog knows each model's ceiling, and `/alpha/search`
looked like the only endpoint that rejected it — but it is not this client's
field to send:

- The subscription endpoint returns
  `400 {"detail":"Unsupported parameter: max_output_tokens"}` on at least
  `gpt-6-sol` and `gpt-6.1-sol` on a plus plan (issue #29). The report's control
  was exact: same account, model, and proxy; deleting only this field restored
  conversation.
- The official CLI does not send it. `codex-rs/codex-api/src/common.rs`
  declares `ResponsesApiRequest` with no such field, and
  `codex-rs/core/src/client.rs` builds the request without one. The same 400 is
  reported for `@ai-sdk/openai` against custom Responses gateways
  (openai/codex#31181) — so the field is a client-side assumption that some
  backends reject, not a parameter the Responses contract requires.
- The error strings tell the two endpoints apart, which is how the first report
  was misrouted: the chat path produces `Codex request failed (400): …` from
  `responses-client.ts`, while `/alpha/search` produces
  `Codex subscription search failed (400).`

What replaces it:

- **Nothing on the wire.** The service applies its own default and the turn's
  real length is whatever the model produces.
- **`defaultMaxTokens` stays**, on the adapter's model info only. DSH reads it
  as a *local* completion reservation when compaction plans a fold
  (`compaction-basic`'s `reservedCompletionTokens`); it never becomes a request
  field. `codexModelMaxTokens()` in `shared/model-catalog.ts` is now documented
  as that local number, not a request cap.
- **Truncation is still reportable.** The backend ends a capped turn with
  `response.incomplete`, which `parseResponsesStream` maps to the `max-tokens`
  finish reason — that mapping is what surfaces the cutoff, not the request
  field.

Trade-off accepted: a caller's `maxTokens` no longer reaches the provider. That
matches the official CLI and is the only way to stop the 400 on affected
accounts; clamping to the model ceiling does not help, because the field itself
is what is rejected.

The lesson to carry to the next field: "the catalog knows this value" is not
evidence that the wire accepts it. Verify against the official client's request
struct, and assert the WHOLE body in a test — `codex-search.test.ts` and
`codex-output-cap.test.ts` both do this now, so the next invented field fails
loudly instead of as a 400.

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

## 5b. Cross-line capability audit (why the other lines need nothing)

Seven lines were compared on capability, not just connectivity. Only the output
cap above was a real gap. The rest is protocol difference, and "fixing" it would
mean sending fields the other wires do not have:

- **Codex is the ONLY line with `service_tier: 'priority'`, `text.verbosity`,
  `reasoning.summary` and `include: reasoning.encrypted_content`.** Those are
  Responses-API fields. The other lines speak Anthropic Messages or
  chat-completions and have no equivalent. Do not port them.
- **Caching is two different protocols, both now satisfied.** Claude and minimax
  emit `cache_control` breakpoints because Anthropic does NOT cache unless a
  breakpoint is declared (an undeclared request bills at full price). OpenAI-
  style lines use automatic prefix caching, which needs only a stable
  `prompt_cache_key` — codex and kimi both send one now. Neither side is missing
  anything.
- **Server-side extras are Codex-only and are its moat:** image generation
  (`gpt-image-2`), web search (`/alpha/search`), and rate-limit reset credits.
  No other line's backend offers equivalents.
- **minimax's static catalog is deliberate, not an omission.** Its
  `model-catalog.ts` records that `/v1/models` answers `503
  direct_route_not_configured` for subscription traffic and explicitly forbids
  probing it. Do not "fix" this one.
- **minimax leads on account features**: it already has device-code sign-in and
  daily check-in, which codex still lacks.
## 6. Verification

- Forced typecheck (`tsc -b --force`, the only meaningful form) and the test
  tsconfig: 0 errors. `npm run build` clean.
- Full suite: **1837 passed**, 7 skipped. The 6 failures
  (`claude-model-catalog` 5, `antigravity-callback-port` 1) reproduce on a
  clean tree with this work stashed — pre-existing, unrelated.
- Old generation (clean room, 0.1.5-rc.1 pinned): host `tsc -b` clean; the one
  test file that cannot load is `subagent-model-authorization-ptc.test.ts`
  (`@deepseek-ai/dsh-ptc-runtime` does not exist before 0.1.7) — the known
  dev-only limitation from the skill's traps list.

## 7. Cache TTL across lines (added after the Codex round)

Three lines cache prompts, and the three protocols spell the request
differently. This is the map — it is the part most easily got wrong twice.

| Line | Protocol | How the tier is requested | Beta needed |
| --- | --- | --- | --- |
| `claude-subscription` | Anthropic Messages | `cache_control: { type: 'ephemeral', ttl }` on up to 3 breakpoints | **`extended-cache-ttl-2025-04-11`** for `1h` |
| `kimi-code` (openai wire) | Chat Completions | `prompt_cache_options: { mode: 'implicit', ttl }` | none |
| `kimi-code` (anthropic wire) | Anthropic Messages | **top-level** `cache_control` | none |
| `codex-chatgpt` | Responses | `prompt_cache_key` only — no TTL surface | — |

Load-bearing details that cost a round to establish:

- **Anthropic's `1h` is a licensed capability.** A body carrying
  `ttl: '1h'` WITHOUT the beta is refused, exactly as `block_binding` is. The
  header must therefore be derived from the built body (the adapter reads the
  tier it just wrote), never from the setting a second time.
- **The official subscription client uses `1h` for its main conversation**
  while the plan is drawing on included usage, and drops to `5m` once requests
  bill against usage credits. That is the default this plugin now uses, so a
  user comparing it with Claude Code sees the same cache lifetime. The 1h
  write costs more, so the setting can override it.
- **Kimi's `cache_control` only works at the request TOP LEVEL** — a marker
  inside a message is explicitly ignored by the service. Do not "fix" this by
  pushing the marker onto the last system or message block.
- **Kimi locks the tier on first write.** A later request cannot move an
  existing entry to the other TTL; entries only expire. Unset means the field is
  not sent at all, which keeps the pre-setting request byte-identical.
- **Cache IDENTITY and cache TTL are different mechanisms.** Kimi's own
  measurements (pi-provider-kimi-code, 14 controlled suites) show the identity
  is the content prefix hash and that neither `prompt_cache_key` nor
  `cache_control` influences it. That is NOT a reason to omit the TTL field —
  the TTL controls how long a write lives. Conflating the two made this look
  unsupported when it was merely unexposed by the official CLI.
- **Deliberately NOT adopted**: `context_management` / `clear_tool_uses`
  (Anthropic's server-side context editing). The official Claude Code CLI has
  open feature requests for it (issues #44521, #26215), so it is not yet
  something the official client relies on either.
- **Not verified end-to-end against a live subscription account.** The new
  headers, the listing endpoint and turn-state replay are asserted against
  mocked responses only. First check on a real machine: sign in, send two turns
  in one conversation, and confirm a second request carries
  `x-codex-turn-state` and a non-empty `prompt_cache_key`.

## 8. The request body has a size ceiling that nothing documented (issue #50)

This line had **no request-level image bound at all**, which is the one place it
differed from the other six image-capable routes. Every turn re-inlines every
image still in history, so the body grew with the number of images ever read.
Past roughly 4 MB the transport itself refuses the request:

| Body | Result |
| --- | --- |
| ≤ 3 MB | always passed |
| 3–4 MB | 18/18 passed (field logs) |
| 4–5 MB | 3/10 passed (field logs) |
| ≥ 4 MB | 0% (synthetic probe) |

The failure arrives as `ERR_HTTP2_STREAM_ERROR` /
`NGHTTP2_ENHANCE_YOUR_CALM` or `NGHTTP2_INTERNAL_ERROR`, not as an HTTP
status — so it is raised by the transport, before any response exists.

Three things to keep straight, because each was a wrong turn:

- **It is a probability, not a cliff.** The reporter measured 4.6 MB requests
  that succeeded, and attributed the failures to the size band *plus* general
  egress jitter. Fix the absence of a bound, not a threshold.
- **The threshold is a property of the deployment**, not an upstream constant
  (5 MB succeeded to httpbin through the same proxy that refused it to the
  Codex edge). Hence `DSH_CODEX_MAX_IMAGE_BYTES`.
- **The bound is applied to the BUILT payload**, in
  `offloadOldestInputImages` (`responses-mapper.ts`), not to
  `options.messages`. Two image forms reach this wire and only one is a message
  block: a pasted attachment is `{ type: 'image', attachment }`, but a tool-read
  image is a local markdown link (`![](/describe-image/raw/sha256:…)`) that
  `mapUserText` fetches and inlines while building. A message-level pass cannot
  see the second form, and the shared `offloadOldestRequestImages` additionally
  does not recurse into `tool-result` content. Measuring after the build is the
  only point where every form has become an `input_image` item.

Related: `request()` reported every transport failure as the same
information-free sentence. DSH persists only `{message, code}`, so the cause
chain has to live in the message — the same treatment `streamFailure()` already
gives a mid-body death. Without it, this issue was un-self-diagnosable.