# Provider protocol review — current repair pass

## Scope

No host version upgrade or dependency changes in the main workspace. Current development baseline is DSH 0.2.0-rc.2. The provider adapters continue to normalize harness request messages once at their boundary into the canonical legacy vocabulary.

## Reproduced failures

- Responses output_item.added carries item.id, not a top-level item_id; old fixture concealed lost function arguments.
- Pending tool blocks did not reserve their output positions and collided with subsequent text.
- Ollama native image and tool argument serialization incorrectly reused OpenAI strings.
- Concurrency lowering incorrectly clamped to occupancy; fractional limits could become zero; queued abort listeners leaked; cancellation immediately after grant leaked ownership.
- Ordinary HTTP 429 cannot identify a concurrency ceiling.

## Upstream contract evidence

Fetched during this repair pass (2026-10-02); floating references are protocol evidence, not subscription-gateway live validation:

- [OpenAI output-item-added schema](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_output_item_added_event.py): item, output_index, sequence_number, type; no top-level item_id.
- [OpenAI input image schema](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_input_image_param.py): input_image, string image_url.
- [Ollama API types](https://github.com/ollama/ollama/blob/main/api/types.go): ImageData is []byte (JSON base64), ToolCallFunctionArguments is a structured object.

## Baselines

- Current baseline (0.2.0-rc.2): forced host/client declarations and test types pass; final full suite 2218 passed / 7 skipped (143 passed files / 1 skipped). Build, npm pack --dry-run --json, git diff --check, npm ci --dry-run --ignore-scripts consistency pass.
- Initial old-baseline forced source check (before protocol repairs) reproduced 4 type errors: Command Code direct role=tool comparison and Ollama direct tool/toolCallId/developer assumptions. Final forced rerun passes after canonical-boundary repairs.
- Old baseline: isolated room pinned to DSH 0.1.5-rc.1, Cordis 4.0.2, loader 1.0.3, include 1.0.7. Matching transitive agent/brand/scope/session/invariants/code-runtime/system-prompt/user-approval/util-values/typert-protocol/session-projection packages pinned to 0.1.5-rc.1 to avoid npm selecting incompatible rc.3 peers. No --legacy-peer-deps or --force. Dependency installation succeeded. Final forced declarations pass; final old suite 2215 passed / 7 skipped (142 passed files / 1 skipped), excluding the single newer-host-only PTC fixture discussed below.

## Old-suite baseline limitation

The current PTC authorization integration fixture statically imports `@deepseek-ai/dsh-ptc-runtime`, a package not published at 0.1.5-rc.1 (npm registry returned E404). This fixture cannot run on that old release. The old-baseline full run reports this import failure explicitly; subsequent old regression suite excludes only this newer-host-only fixture, while the current-baseline full suite retains it. Do not describe this as an unconditional old-baseline full pass.

## Verification boundaries

Offline fixtures/mock credentials only. No live subscription traffic, latency/cost A/B, or deployment reload. Codex turn routing remains a conservative no-cross-request-reuse fallback because a reliable host human-turn identity is not available through the consumed GenerateOptions contract. This is partial W1 completion, not equivalent to official turn continuity.

Original work-package completion is tracked in [the plan](<../../../../docs/plan-provider-agent-optimizations.md>).
