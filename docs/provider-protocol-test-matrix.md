# Provider protocol evidence matrix

This is a reproducible offline test index, not a claim that every upstream subscription feature was live-tested. Existing mechanisms are retained rather than counted as newly implemented. No fixture contains live credentials.

| Route | Text / tools / replay / usage | Request lifecycle / errors | Boundaries |
| --- | --- | --- | --- |
| Codex | [mapper](<../test/responses-mapper.test.ts>), [cache accounting](<../test/cache-accounting.test.ts>), [routing state](<../test/codex-turn-state.test.ts>) | [stream](<../test/responses-client.test.ts>), [account pool](<../test/codex-account-pool.test.ts>), [concurrency](<../test/codex-concurrency.test.ts>) | Human-turn continuity unavailable; request-local fallback only |
| Claude | [mapper](<../test/claude-mapper.test.ts>) | [adapter](<../test/claude-adapter.test.ts>) | Existing block binding/cache markers preserved; new server features unverified |
| Antigravity | [mapper](<../test/antigravity-mapper.test.ts>) | [adapter](<../test/antigravity-adapter.test.ts>) | Cloud Code gateway is not public Gemini API |
| Kimi | [mapper](<../test/kimi-code-mapper.test.ts>) | [adapter](<../test/kimi-code-adapter.test.ts>) | Existing preserved thinking/dynamic tools kept; no new Files entitlement claim |
| MiniMax | [mapper](<../test/minimax-code-mapper.test.ts>), [scoped replay](<../test/minimax-thinking-replay.test.ts>) | [review regressions](<../test/minimax-code-review-fixes.test.ts>), [credential rotation](<../test/minimax-code-token-contention.test.ts>) | Native replay structure tested offline; subscription acceptance/benefit needs authorization |
| Command Code | [mapper](<../test/command-code-mapper.test.ts>), [Responses](<../test/command-code-responses.test.ts>) | [adapter](<../test/command-code-adapter.test.ts>), [plugin](<../test/command-code-plugin.test.ts>) | Three wires remain distinct; reasoning replay not fabricated |
| WorkBuddy | [mapper](<../test/workbuddy-mapper.test.ts>), [cache accounting](<../test/cache-accounting.test.ts>) | [adapter](<../test/workbuddy-adapter.test.ts>) | Community error semantics are not treated as universal provider guarantees |
| Ollama | [projection](<../test/ollama-projection.test.ts>), [wire](<../test/ollama-client.test.ts>) | [pool](<../test/ollama-account-pool.test.ts>) | Cloud only; explicit known model controls, unknown visible downgrade |

## Cross-route gates

- [Model request limits](<../test/model-request-control.test.ts>): each of eight route wrappers; FIFO credential isolation, queued timeout/abort, active abort, body EOF/error/cancel, disabled passthrough and zero eager reads.
- [Compatibility seam](<../test/llm-compat.test.ts>): old/new message vocabulary normalized once.
- [Capability evidence](<../test/capabilities.test.ts>): explicit provider/wire/model/auth matching, fail-closed unverified features.
- [Diagnostics](<../test/request-diagnostics.test.ts>): exact zero/missing semantics, endpoint-aware usage, original abort reasons, bounded parser, privacy-safe metadata and tool-prefix changes.
- [Command Code ZDR](<../test/command-code-adapter.test.ts>): actual request headers on all three wires, privacy refusal, generic 422, permissions vs credential rotation.
- [Settings display](<../test/command-code-context-window.test.tsx>): cached catalog age/staleness and explicit ZDR requirement.
- [Plugin integration](<../test/command-code-plugin.test.ts>): registered adapter applies configured slots and emits only opt-in redacted records.

## Reference evidence

Reference fetches and reviewed contracts are recorded in [protocol repair evidence](<../.dsh/skills/dsh-harness-upgrade/references/provider-protocol-review.md>). Evidence date for this extension pass: 2026-10-03. Runtime approvals based on official contract/fixtures must identify that tier; none are relabelled live-validated.
