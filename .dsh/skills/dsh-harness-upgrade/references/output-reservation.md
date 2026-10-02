# Output reservations versus wire caps (#30 / #31)

## Boundary and evidence

DSH 0.2.0-rc.2 (local checkout 639ed01539) materializes optional model

defaultMaxTokens into config only when it exists (llm/src/index.ts:896).
compaction-basic/src/index.ts:65 uses configured maxTokens ?? defaultMaxTokens ?? 0.
Its config.ts:172-202 subtracts output reservation and 65536 headroom, floors
min(window * .8, remaining), and requires floor(messageBudget * .16) < threshold.
No new DSH API, monkey patch, or host modification is needed.

Kimi/MiniMax omit their dynamic wire default. Their existing request-time
fallback and prompt clamp remain unchanged. Other providers retain safe defaults
and omit unsafe ones through common/output-reservation.ts. That helper models
only the stock policy, not user policy: constants must be reviewed on upgrades.
Wire defaults remain provider-owned, not reduced to make compaction pass.
Claude and WorkBuddy retain catalog-derived caps on the request path; Antigravity
retains the model cap before runtime-model clamping. Codex sends no output cap.
Ollama retains its 8192 wire fallback.

## Audit

Additional failing shipped defaults: Command Code moonshotai/Kimi-K2.6,
xai/grok-4.5, xai/grok-4.6; WorkBuddy deepseek-v3-2-volc.
WorkBuddy default (56000 context) is intrinsically too small for stock headroom,
even without output reservation. Do not increase the advertised window to hide
that error; configure a smaller compaction headroom/summary budget or use a
larger supported model. Custom policy and explicit caps remain caller-owned.
Claude, Antigravity and Codex shipped defaults fit; smaller overrides/live
windows are guarded too. Ollama's catalog is live, so tests use synthetic windows.
At W=262144 the exact stock integer retention boundary is R=184124, not the
183296 reported in issue discussion.

## Compatibility and verification

The implementation uses the existing optional defaultMaxTokens contract only;
no generation-specific imports were added to production. New regression tests
use the installed real DSH LLM runtime (0.2.0-rc.2); compaction arithmetic is an
explicit versioned contract fixture, not an optional runtime dependency.
The actual compaction compiled resolver was probed during analysis and compared
against the new helper across 144 window/reservation pairs; all agreed.
Forced source and test TypeScript checks, npm run build, and the full Vitest
suite passed on 0.2.0-rc.2. New coverage: 20 dynamic-budget cases, 178 all-provider
metadata/boundary cases, and four live-catalog wire cases. git diff --check passed;
the DSH checkout remained unmodified.
Older-generation clean-room verification and live-account end-to-end compression
are not yet performed for this change. Do not interpret mocked wire tests as
proof of upstream acceptance or exact prompt token estimation.

Existing active sessions should re-resolve defaults after host/plugin restart.
Newer DSH requestProposal drops marked defaults; older persisted explicit
values may need clearing. No durable session history is rewritten by the plugin.
