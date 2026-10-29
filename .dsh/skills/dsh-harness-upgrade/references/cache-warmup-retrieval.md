# Cache warmup and retrieval projection (not a harness round)

The Harness baseline remains **0.2.1-rc.3**. This round did not change a DSH
version or add a peer range. It added result projection and retrieval projection
on top of DSH's tool/session contracts, so the next upgrade must re-check those
contracts rather than treating the feature as provider-only logic.

Harness evidence read locally:
- `packages/core/tools/src/contracts.ts` (`ToolExecutionResult` and
  `PostToolDecision`): accepted `content` and accepted `value` are mutually
  exclusive projections.
- `packages/fs/tool-fs/src/read.ts` and `read-render.ts`: Read has its own
  line-window metadata and cannot be handled as an anonymous text blob.
- Real session artifacts under `~/.dsh/sessions`: PTC calls nested tools through
  `run_code`, and `user/message` includes reminder-only records.

## 1. Scope and defaults

- `cacheWarmup` defaults to **on** and covers the original log/command path.
- `cacheWarmupRetrieval` now also defaults to **on** for Kimi Code. A missing
  field means on; only an explicit `false` disables it. The UI uses the same
  default, so an old profile and the host resolver cannot disagree.
- **Only `provider === 'kimi-code'` is admitted.** Other providers are unchanged.
  Enabling them requires separate cache/billing semantics and A/B evidence.
- There is **no proactive warmup API request**. The first real Kimi request
  creates the cache; projection only reduces new tool-result suffixes.
- Retrieval projection is conservative: explicit navigation only. Editing,
  review, verification, full audits, and unknown intent keep the original result.

## 2. DSH seams and invariants

| DSH contract | Plugin invariant |
| --- | --- |
| `PostToolDecision` content/value union | Original log path never rewrites `value`. Direct retrieval/PTC may convert `value` to preview content **only after** a preview is actually produced; otherwise the original decision object is returned. Never emit both `content` and `value`. |
| PTC `run_code` wrapper | Nested `read` is not an independent post-execute event. Handle `run_code` and its rendered Read result, not just direct `read`. A value-carrying PTC result is admitted only for explicit navigation. |
| Read JSON Envelope | Accept only a complete object with `path`, `offset`, and `lines: [{ number, text }]`. Line numbers must be strictly increasing and cover at least five lines. Arbitrary JSON, mixed output, and truncated documents stay verbatim. |
| Session user events | Read `session.events` or `snapshotEvents()` through a guarded fallback. Skip reminder-only records and runtime-context blocks, then walk backward to the latest real user text. Do not stop at an empty reminder-only event. |
| Tool registration | `cache_warmup_result` is always registered, even when projection is disabled. Changing the tool list would invalidate the prompt-cache prefix. |
| Reference storage | Original text is stored before preview emission, addressed by session and digest. Session mismatch is refused before filesystem access. Existing previews and ref ids are never rewritten. |
| Config schema and volatile fields | Fields stay in the core `Config` because profile patch replacement is row-scoped. Readers dereference volatile values on every result. Moving fields to the second loader row would erase or default user configuration. |
| Client settings | The Progress Updates page binds the core row through `configForms` and the `progressUpdates` key. It shows six rows with consistent switch/disabled/error states. Host schema changes need a Host reload; client bundle changes need rebuild and page refresh. |

## 3. Projection behavior that must not be simplified

- **File outline**: only top-level declarations with original line numbers. Local
  `const`/`let`/`var` declarations inside functions are excluded, both for
  relevance and budget. Contracts and type-heavy evidence stay verbatim.
- **Absolute path**: optional metadata. A long path may be omitted by the budget
  fitter; the complete declaration set must never be truncated to make room.
- **Web outline**: complete `title` and h1-h3/Markdown headings only. Unstructured
  pages and ordinary fact extraction stay verbatim; there is no relevance-summary
  guesswork.
- **Search**: grep/glob reuse complete counts and distributions with a ref to all
  matches. Full audits still require the complete match set.
- **Logs**: test failures and shell errors require the complete failure set.
  `npm notice` file lists are metadata, so names such as `stream-error.d.ts`
  do not become fake build errors; actual `npm ERR!` and compiler errors remain.
- **Safety fallback**: small results, source code, contracts, subagent reports,
  mixed evidence, non-text blocks, and unknown large text stay verbatim.
- **Budget**: warmup `1200` chars, steady state `8000` chars. Required sections
  must fit whole or the result stays verbatim.

## 4. Warmup state machine (not an extra request protocol)

- The controller reads real usage; it does not send requests, rewrite messages, or
  rebuild sessions.
- Hit ratio is `cacheReadTokens / (inputTokens + cacheReadTokens)`.
- Steady state requires two consecutive qualifying reports: either hit ratio >=97%,
  or >=1024 cached tokens, no prefix shrinkage, and <=256 fresh input tokens with no
  real drift. Real drift resets the streak; `stable` and `first-request` are
  normal lifecycle states, not drift.
- Idle TTL is **25 minutes**. Expired state returns to the warmup budget. Durable
  `warmupConsecutiveHits` may restore a non-expired steady state after restart.
- Projection is not itself cache creation. It reduces the uncached suffix appended
  by later tool results, which is why fewer fresh tokens does not require an extra
  warmup call.

## 5. Upgrade traps to preserve

1. **Do not remove the `value` gate globally.** Log paths still reject it;
   only explicit navigation retrieval/PTC may pass, and an unchanged result still
   returns the original decision.
2. **Do not classify only the last event.** DSH appends reminder-only
   `user/message` records after the real request. Strip them and continue backward.
3. **Do not outline every declaration.** Indented locals caused 27 entries and a
   `verbatim-budget` fallback on the real probe. Top-level filtering is required.
4. **Do not assume line-numbered text.** PTC may carry the Read result as canonical
   JSON with a structured `value` instead of plain text.
5. **Do not enable other providers by deleting the provider check.** Their cache,
   replay, and billing behavior is unverified.
6. **Do not “optimize” with proactive warmup requests.** They add cost and cannot
   cache tool results that have not happened yet.
7. **Do not move config to the second loader row for convenience.** The core row is
   the compatibility anchor; the Progress Updates page is only a presentation seam.
8. **Rebuild before runtime claims.** Linked profiles execute `lib/index.js`, not
   the TypeScript source. A green unit test against new source cannot prove an old
   loaded bundle is fixed.

## 6. Verification evidence

- Three-project TypeScript checks: passed.
- Final full Vitest: **310 files passed / 2 skipped; 5166 passed / 9 skipped**.
- `npm run build`, `npm pack --dry-run`, and `git diff --check`: passed.
- Default-on follow-up: **112 focused tests** covering missing-field default-on,
  explicit-false-off, host parsing, and UI state passed.
- Four-request real Kimi A/B smoke (no retry):
  - raw continuation: **512 cached + 1251 fresh** tokens;
  - outline continuation: **512 cached + 317 fresh** tokens.
  This is a controlled-sample reduction (~74.7% fresh suffix), not a claim about
  every task.
- Actual PTC runtime acceptance on `dsh-chatgpt-subscription` / `k3.1-pro`:
  `strategy=file-outline` with eight top-level declarations and a ref. After a
  review-only request, `outlinesAfterReview: 0` and both reads remained raw JSON.

## 7. Left unverified

- No clean-room runtime claim is made for pre-0.2.1 Harness generations. Run the
  skill's exact-closure rooms before changing the support statement; structural
  fallbacks alone are not evidence.
- Other providers, mixed real-world task accuracy, and whole-task cost are not
  certified. Measure completed-task total fresh input, output tokens, tool rounds,
  latency, and correctness before enabling another route.
- Large documents whose required complete outline cannot fit the budget correctly
  remain verbatim by design; they are not partial-preview success cases.
