# Qwen Token Plan live acceptance — 2026-11-17

Authorized by the user with a configured **personal** Token Plan API key. No key or ciphertext was printed. Two probe scripts used 28 generation calls in total; 27 assertions passed and the single rejected model was removed from the general chat catalog as described below.

## Reproducers

```sh
npx vitest run --config vitest.probe.config.ts scripts/probe-qianwen-token-plan.probe.ts
npx vitest run --config vitest.probe.config.ts scripts/probe-qianwen-token-plan-remaining.probe.ts
```

The first probe caps itself at 10 generation calls. The second caps direct calls and uses two additional adapter-stream calls. Re-running the second probe no longer calls decision-model-preview.

## Verified live

| Area | Evidence |
| --- | --- |
| Qwen4-Max connectivity | HTTP 200, answer OK, 2,070 ms |
| 5m explicit cache | Cold: prompt 2,082, write5m 2,075, cached 0. Warm: cached 2,075, write 0 |
| 1h explicit cache | Cold: write1h 1,605, cached 0. Warm: cached 1,605, write 0 |
| CoT summary + encrypted replay | Ciphertext present (171 bytes), summary 83 chars; replay with summary omitted answered 400 correctly |
| Actual QianwenTokenPlanAdapter | Two real SSE streams; encrypted replay observed; answers 42 then 43; second-turn usage included reasoning tokens |
| Function calling | get_current_weather emitted; tool result integrated into a 21°C answer |
| Inline vision | 32×32 red PNG with low detail and max_pixels answered Red; prompt 101 tokens |
| Personal chat catalog | All 16 usable personal chat IDs including the qwen4.0-max-preview alias returned HTTP 200 across the two probes |
| Auto | HTTP 200; no tool_choice or fixed reasoning ladder is injected by the line |
| Qwen4 Preview | qwen4-max-preview and qwen4.0-max-preview both answered OK |

## Excluded after the live probe

`decision-model-preview` was listed in the personal Token Plan and /models listing, but Chat Completions returned HTTP 400 `url error`. It is a dedicated decision-model integration, not a general chat model. It has been removed from QIANWEN_MODEL_CATALOG; the line now exposes 23 general chat/vision models. This was a real failed assertion, not a skipped or silently accepted case.

## Not tested / plan boundaries

- Team-only qwen3.6-plus, glm-5.1, glm-5, three Kimi K2 models and MiniMax-M2.5 were not called because the configured key is personal. They remain labelled team-only in the static catalog.
- Natural 5-minute expiry and 1-hour expiry were not waited out. Immediate creation/read, tier-specific usage fields and hit renewal were verified.
- Image/audio/video generation models use separate APIs and are not general Chat Completions entries; they were not called.
- Responses built-in tools, Batch and Prime remain outside this line's claims.
- The saved selection is explicitly the original three models at selectionVersion 2. The migration correctly preserves it. After loading the new Host, use Select All or choose individual models to see the expanded catalog.
