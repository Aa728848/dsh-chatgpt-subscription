# Provider runtime controls

## Deployment configuration

Restart the plugin/host after changing environment variables. Defaults preserve existing behavior. Limits are operator policy, never inferred subscription entitlements.

```powershell
$env:DSH_PROVIDER_CONCURRENCY = '{"default":2,"codex-chatgpt":1,"ollama":2,"queueTimeoutMs":120000}'
$env:DSH_PROVIDER_DIAGNOSTICS = '1'
$env:DSH_COMMAND_CODE_ZDR = '1'
```

### Concurrency

`DSH_PROVIDER_CONCURRENCY` accepts a JSON object with `default`, `queueTimeoutMs`, and any of: `codex-chatgpt`, `claude`, `antigravity`, `kimi-code`, `minimax-code`, `command-code`, `workbuddy`, `ollama`. Values are nonnegative integers. A zero/missing limit disables limiting; a zero queue timeout disables that timeout. Unknown keys and invalid values fail configuration validation.

Limits apply per provider and credential fingerprint to generation POST requests, across models using the same credential. Slots remain held until response EOF, cancellation, abort, or error. Auth/token refresh/catalog/quota requests bypass the gate. Credentials are not logged; token rotation creates a new scope, so this is deliberately credential-scoped, not a guaranteed account-wide ceiling across refreshed tokens or separate host processes.

The queue is FIFO and cancellation-aware. No main-agent priority or whole-agent-tree budget is claimed: the HTTP boundary lacks trustworthy agent-tree identity. Host-side tree budgets remain a separate integration prerequisite.

### Diagnostics

Diagnostics are opt-in. Implementation and exact safe record schema are defined in [request diagnostics](<../src/host/common/request-diagnostics.ts>). Records must never include raw credentials, prompts, session IDs, raw URLs or untrusted server error bodies. No API price is used to claim subscription savings. Streaming measurement observes the consumer read lifecycle, not provider-internal compute timing. Logs use `firstByteMs`; `ttftMs` is explicitly null because the first transport chunk need not contain a generated token. Timing excludes time queued in the outer concurrency gate. Token counts are parsed from bounded complete protocol records; oversized/unrecognized records are omitted, not guessed. Anthropic input is already disjoint, unlike Responses/Chat totals. Retry count appears only with explicit correlation; unknown session/tree/compaction events are not inferred. Tool order, schemas and explicit removal affect ephemeral hashes. Logs are emitted through the host logger as `[provider-diagnostics]` records; opt-in hashes are not a cross-process identity store.

### Command Code privacy

An explicit adapter `zeroDataRetention` option takes precedence; otherwise `DSH_COMMAND_CODE_ZDR` takes precedence over the official CLI-compatible `CMD_ZDR` fallback. When enabled, generation requests must carry `x-cmd-zdr: 1` and a `cmd_zdr_no_providers` refusal must fail closed. No retry may silently remove the privacy header. See [Command Code adapter](<../src/host/command-code/adapter.ts>) and protocol tests for exact behavior. The [official extension source](https://github.com/CommandCodeAI/pi-commandcode-provider/blob/main/index.ts) documents the header and 422 fail-closed behavior (reviewed 2026-10-03). The gateway honouring retention is the provider's commitment, not something this plugin can guarantee: a correctly sent header is what the client can do, and a refusal is surfaced rather than bypassed.

## Declined features (decision, not backlog)

These are closed decisions. Each entry states why the feature is not implemented, so a later reader does not mistake the gap for pending work.

- Codex turn-state reuse: consumed host GenerateOptions has no reliable human-turn lifecycle identity. Continue request-local conservative fallback, not content heuristics.
- Codex WebSocket / previous_response_id: subscription handshake and resumability require authorized gateway fixtures, with tool side-effect deduplication before any replay.
- New provider server-side tool search, compaction, cache configuration, server multi-agent: public API support does not establish subscription gateway acceptance or host permission ownership. Keep unknown gates closed.
- Kimi Files / MiniMax and Antigravity native video: require entitlement and endpoint/TTL/delete/account-scope evidence. Existing video tools are not counted as new Files API delivery.
- Ollama Local: separate trusted endpoint/SSRF/auth/VRAM scheduling scope; no arbitrary user-controlled outbound base URL is introduced.
- Main-agent reserved capacity / whole-tree budget: requires host-provided root/agent identity and cancellation/budget hooks, not prompt or header guessing.
- Live A/B latency, quota or cost claims: no authorization for paid/limited calls has been assumed.
