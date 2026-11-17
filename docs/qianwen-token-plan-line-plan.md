# Qwen Token Plan line implementation record

Evidence date: 2026-11-17. The regression suite is offline; an authorized personal-plan key was also exercised live on 2026-11-17.

## Frozen upstream facts

| Fact | Source |
| --- | --- |
| Provider id `qianwen-token-plan`, OpenAI Chat Completions, Token Plan base URL `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1` | [Official DSH guide](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/deepseek-harness) |
| `qwen4-max` 1M context; non-thinking output 131,072; thinking + answer 262,144 | [Qwen4-Max model](https://platform.qianwenai.com/docs/developer-guides/getting-started/latest-model) |
| `qwen4-max-preview` and alias `qwen4.0-max-preview`; preview announced for 2026-11-11 through 2026-11-25 24:00 UTC+8 | [Personal plan](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview) |
| Preview `maxTokens` conservative 131,072 | Official DSH guide above; the general model table has a different figure, so the line does not adopt it |
| Reasoning values `none/minimal/low/medium/high/xhigh/max`; per-call values pass through unchanged; no local convergence and no `thinking_budget` | [Chat Completions API](https://platform.qianwenai.com/docs/api-reference/chat/openai-chat) |
| `max_completion_tokens` includes reasoning + answer | Chat Completions API above |
| Explicit cache: minimum prefix 1,024 tokens, automatic and manual breakpoints, at most four breakpoints, 20-block lookback, TTL `5m` / `1h` | [Qwen4 explicit cache](https://platform.qianwenai.com/docs/developer-guides/run-and-scale/explicit-cache-qwen4) |
| Usage split: `cached_tokens`, `cache_write_tokens`, 5m/1h creation details; `cache_creation_input_tokens` aliases the write count and is not added twice | Qwen4 explicit cache above |
| CoT summary: `thinking_display=summarized`, summary in `reasoning_content`, complete opaque ciphertext in an independent `encrypted_content` frame; same assistant message replay; summary may be omitted | [CoT summary](https://platform.qianwenai.com/docs/developer-guides/text-generation/cot-summary) |
| Qwen4-Max image `detail`, explicit `max_pixels`, 32x32 pixels per visual token | [Vision](https://platform.qianwenai.com/docs/developer-guides/multimodal/vision) |
| Credits are not Tokens; remaining balance is shown in the console, not through a reviewed public key-based API | [Usage & quota](https://platform.qianwenai.com/docs/token-plan/token-plan-usage-quota) |

## Decisions

- One encrypted API key and one settings document. No OAuth, account pool, rotation, account affinity or wait-time keepalive.
- Main wire is OpenAI Chat Completions. DSH owns local history; Responses server-side conversations and Qwen built-in tools are not mounted by this line.
- Static 23-model personal/team text and vision catalog: Qwen4, Qwen3, DeepSeek V4, GLM, team-only Kimi/MiniMax and Auto. Generation-only image/audio/video models are excluded. A versioned migration expands only the unedited initial three-model default; explicit user selections and all-off remain unchanged. Status polling performs no upstream request. The explicit connection button sends a minimal non-thinking request.
- All seven reasoning values are user-controlled. A per-call selection wins over the card default; null omits the field. The adapter never sends reasoning_effort and thinking_budget together.
- Cache is on by default with user-selectable 5m/1h TTL. Automatic explicit caching is combined with at most three deterministic manual prompt_cache_breakpoint markers; cache_control is never mixed in.
- CoT summary is on by default for qwen4-max only. Ciphertext is captured as a complete value, stored in lossless-JSON replayState, and replayed only for the same provider/model. Missing or ambiguous ciphertext degrades without substituting summary text.
- Visual input uses user-selected low/auto/high detail and an optional documented max_pixels range. Inline request bytes use a 48 MiB defensive ceiling below the documented 64 MiB request envelope.
- PTC SDK, Timeline and historical tool-result pruning protections include this line. Cache-warmup result projection receives observed usage with dynamic TTL; Qwen uses the ratio track only, not Kimi's 256-token continuation heuristic.
- No fabricated Credits, balance, price or 0% denominator. Composer appears only when a real cache ratio exists.
- Batch and Prime are not Qwen4 capabilities in the reviewed official support tables and are not exposed.

## Host/client route table

`GET /status`; `PUT|POST /credentials`; `DELETE /credentials`; `GET|POST|PATCH /settings`; `POST /connection` (alias `/connection/test`); `POST /cache/reset`, all under `/qianwen-token-plan/api`. Every mutation is same-origin checked. No response contains the API key or ciphertext.

## Verification

- `test/qianwen-token-plan-mapper.test.ts`: exact efforts, cache TTL and breakpoints, visual budget, ciphertext-only frames, same-model replay/cross-model stripping, parallel tools, disjoint usage.
- `test/qianwen-token-plan-adapter.test.ts`: real adapter stream over mock SSE, missing credentials, explicit empty selection, truncated transport, same-origin route writes.
- `test/qianwen-token-plan-store.test.ts`: production settings writer round trip, memory encrypted credential backend, secret-free status, dynamic-TTL warmup.
- `test/qianwen-token-plan-section.test.tsx`: single-key card, all options, request patches, explicit empty selection, zero-denominator placeholder, official brand.
- Existing registration, hub, proxy migration, Russian locale, Timeline, PTC and pruner assertions append the new line.
- Authorized live acceptance used 28 generation calls: all 16 personal general-chat IDs, 5m/1h cache reads, actual adapter ciphertext replay, tools and vision passed; decision-model-preview was rejected by Chat Completions and removed. See docs/qianwen-token-plan-live-acceptance.md.

## Risks / left unverified

1. Team-only models were not called with the personal key; they remain labelled team-only.
2. Natural 5-minute and 1-hour cache expiry was not waited out. Immediate writes, reads and usage fields were verified live.
3. Preview retirement/replacement after 2026-11-25 is upstream-controlled; remove it from the static catalog when the service confirms retirement.
4. No remaining-Credits endpoint is claimed. The card links to the official console and reports local token dimensions only.
5. Responses built-in tools, file search and upstream MCP are deliberately not mounted; the main route preserves DSH local tool/history ownership.
