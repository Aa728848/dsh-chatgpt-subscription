# Antigravity Claude cache continuity audit

## Evidence and limits

Target: the user's task-board design session, Claude Opus 5.5. Only metadata,
usage counts and replay shapes were inspected; no conversation text, signature
values or credentials are included here. No live generation requests were made.

| Assistant event before miss | Unsigned text SSE parts | Following cache read | Uncached input | Request start gap |
| --- | ---: | ---: | ---: | ---: |
| 63 | 385 | 1,325 | 62,589 | 90.866 s |
| 824 | 365 | 1,325 | 229,054 | 284.579 s |
| 860 | 20 plus tool call | 1,325 | 234,017 | 14.243 s |

Across all 75 assistant messages inspected, all three text replies with at least
20 unsigned fragments and an observed successor were followed by the 1325-token
cache floor. The final reply had 150 fragments and no observed successor.

The code retained every SSE delta in replayState.parts and replayed those
transport fragments as individual content parts. Claude direct instead builds
one text block from the assembled message text. The 14-second miss rules out
ordinary five-minute expiry as the sole explanation. The observed structure
is consistent with exceeding Claude's 20-position cache lookback, but the
Antigravity server's translated Anthropic request was not captured: causal
cache improvement remains to be verified live.

## Implemented fix

Claude-only replay now joins adjacent pure unsigned text parts. Signed parts,
tool calls and opaque metadata keep their boundaries. Gemini replay remains
unchanged. Replay metadata is not mutated and no historical session is rewritten.
Offline reconstruction of the real messages above produces 1 text part for each,
with identical text. Existing thinking-signature reconstruction is retained.
Rebuilding all 75 stored assistant messages retained all 46 signed thinking
segments, with zero unsigned thinking parts and zero empty thinking parts. This
validates saved replay shapes, not server acceptance of their signatures.
Switching an existing session to the normalized shape may incur one cold prefix.

## Other reviewed factors

- The screenshot's cumulative hit ratio is correct: 618063 / (618063 + 279701)
  = 68.84%. The initial call had 36140 uncached input tokens.
- Current account listing contained one account; observed model and recorded
  configuration/tool header hashes were unchanged across resume.
- Antigravity passes options.sessionId rather than generating a per-request
  random session ID. Envelope requestId is separately unique per request.
  Actual on-wire session affinity still needs transport diagnostics if misses persist.
- Signature-error recovery removes thinking/signature replay for one retry only.
  It is a fallback, not a guarantee of preserved-thinking cache continuity.
  No attempt-level transport record proves how often it fired in this session.
- Direct Claude subscription defaults to explicit one-hour cache markers.
  Antigravity uses Google streamGenerateContent and has no verified client TTL
  control. Do not inject Anthropic cache_control into that schema on speculation.
- Existing generic diagnostic fingerprints inspect top-level tools/system/messages,
  not Antigravity nested request.tools/systemInstruction/contents, and skip JSON
  bodies above 512KB. They cannot establish long-context wire-prefix stability
  for this incident. No inference of unchanged wire content is made from their
  absence. This independent observability gap is not changed by the replay fix.
- Provider-side cache eviction, routing and exact TTL remain unobservable from
  the session usage ledger. This audit does not claim they never occur.

## Sources

- [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  20-position lookback; default 5-minute TTL refreshed from request start;
  Opus 5.5 preserves readable thinking across normal user messages; dropping
  thinking changes the cached prefix from that position onward.
- [Anthropic maintained cache guidance](https://raw.githubusercontent.com/anthropics/skills/main/skills/claude-api/shared/prompt-caching.md).
- [Community Antigravity capture report](https://github.com/cortexkit/antigravity-auth/issues/1):
  session identity and cache-field observations, not a normative protocol spec.

## Verification

Regression cases reproduce 385 deltas as 385 request parts before the patch,
and one text part afterwards. Tests preserve signed/tool boundaries and the
Gemini path. Forced source/test typechecks and build passed; the full suite
reported 2307 passed and 7 skipped. The new cases were first run against the old
implementation and failed as expected (5 failures), then passed with the fix.
Live before/after hit-rate verification is still pending; neither
the host nor the user's running task was restarted by this audit.
