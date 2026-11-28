# Repository Guidelines

## Project Structure & Module Organization

This repository (`@eddyskywalker/dsh-chatgpt-subscription`) is a multi-provider subscription hub and agent runtime enhancement plugin for **DeepSeek Harness (DSH)**. It registers **17 provider lines** (`codex-chatgpt`, `claude-subscription`, `claude-api`, `kimi-code`, `minimax-code`, `command-code`, `glm-coding-plan`, `step-code`, `cline-pass`, `qoder`, `opendesign`, `workbuddy-subscription`, `qianwen-token-plan`, `relayone`, `ollama`, `antigravity-acp`, and `aws-quick`), bundled agent presets, multimodal tools, prefix-cache guards, and Web UI extensions.

Source lives in `src/`; generated package output lives in `lib/` (git-ignored) and must be refreshed via build rather than edited by hand.

- `src/index.ts`: core host plugin entry, `Config` schema (including `volatile()` settings), provider wiring, global guards, and tool registrations.
- `src/entries/`: sub-entry exports (`progress-updates`, `plan-mode-pipeline`, `plan-mode`, `tool-result-pruner`, `codemode`, `aws-quick-mcp`).
- `src/host/providers/`: all 17 provider lines (`codex-chatgpt/`, `claude/`, `claude-api/`, `kimi-code/`, etc.) plus `_claude-shared/`.
- `src/host/runtime/`: host runtime subsystems (`cache-warmup/`, `codemode/`, `dispatch-ledger/`, `progress-updates/`, `widget-board/`, `guards/`, `presets/`, model optimizations).
- `src/host/infra/`: shared host infrastructure (`storage/`, `network/`, `hub/`).
- `src/host/common/`: shared kernel — account pool, catalog snapshots, context-overflow / image-budget helpers, and 3-language (`zh` / `en` / `ru`) host i18n runtime.
- `src/client/`: Web GUI entry (`src/client/index.tsx`), `providers/` (per-line tabs & composer badges), `features/` (Mermaid, progress updates, subagent settings, codemode), `hub/`, `common/`, and `locales-ru/`.
- `src/shared/`: side-effect-free DTOs and shared wire contracts.
- `assets/`: package SVG icons (`icon.svg`, `progress-updates.svg`).
- `config/`: split TypeScript configs (`tsconfig.host.json`, `tsconfig.client.json`) referenced by root `tsconfig.json`.
- `presets/dispatch/`: bundled `dispatch` orchestrator agent preset.
- `widgets/line-flip/`: bundled `dsh-widget-board` quota & account-pool flip card.
- `test/`: offline Vitest suite grouped into `providers/<line>/`, `runtime/`, `client/`, and `infra/`.
- `docs/`: core reference docs (`README.md`, `providers.md`, `configuration.md`, `architecture.md`, `troubleshooting.md`, `CHANGELOG.md`) and historical engineering archives (`docs/archive/`).
- `scripts/`: maintenance utilities and live probes (`scripts/probes/`, `scripts/vitest.probe.config.ts`).
- `.dsh/skills/`: repository maintenance skills (`add-subscription-line`, `dsh-harness-upgrade`, `release-plugin`, `diagnose-windows-sandbox-acl`). Not published with the npm package.

## Harness Compatibility

One codebase supports every DSH harness generation from `0.1.2-alpha.5` through `0.2.3-alpha.3` (`peerDependencies` in `package.json`), because users are distributed across npm's `latest`, `next`, and `alpha` dist-tags. Never simplify an adapter, tool guard, or client slot by assuming only the newest generation's shape. Read `.dsh/skills/dsh-harness-upgrade/SKILL.md` before modifying version-sensitive boundaries, and `.dsh/skills/add-subscription-line/SKILL.md` when adding or extending a provider line.

## Build, Test, and Development Commands

```powershell
npm run typecheck
```
Runs TypeScript checks across host, client, `test/tsconfig.json`, and `scripts/tsconfig.json`. After changing shared types or harness versions, run `npx tsc -b --force` so stale `.tsbuildinfo` caches do not mask errors.

```powershell
npm test
```
Runs the offline Vitest suite with mocked OAuth, SSE streams, quota payloads, DPAPI/keyring stores, and jsdom client behavior.

```powershell
npm run build
```
Builds TypeScript declarations and bundles `lib/index.js`, sub-entries (`lib/progress-updates.js`, `lib/plan-mode-pipeline.js`, `lib/plan-mode.js`, `lib/tool-result-pruner.js`, `lib/codemode.js`, `lib/aws-quick-mcp.js`), and `lib/client.js`.

Use `npm pack --dry-run` when changing package metadata, exports, or published files.

## Releasing

`publishConfig` carries no `tag` on purpose: a stable release lands on `latest` immediately upon publish. Publish prereleases with an explicit `--tag alpha`.

`lib/` is incremental and retains stale `.d.ts` files from deleted sources if not cleaned first. Follow `.dsh/skills/release-plugin/SKILL.md` before publishing so the packed tarball matches a clean build and `src/compat.ts` (`PLUGIN_VERSION`) matches `package.json`. Release notes live in `docs/CHANGELOG.md`.

## Coding Style, Documentation & UI Copy Discipline

Use strict TypeScript and ESM imports. Keep changes small and consistent with nearby code: camelCase for functions/variables, PascalCase for React components/classes, and kebab-case for package/plugin/route identifiers.

- **Single source of truth for docs**: keep root `README.md` concise and user-facing. Never duplicate internal implementation details, probe logs, or workstream IDs across docs and code comments.
- **Concise code comments**: explain *why* a non-obvious invariant exists in 1–5 lines; do not write multi-page essays or changelog archaeology in source headers.
- **Scope-only UI copy**: settings descriptions and hints should state only the user-visible effect in plain language — never leak raw JSON field paths, internal protocol headers, upstream issue numbers, or defensive implementation explanations into the UI.
- **i18n**: client namespaces are strongly typed in `src/client/index.tsx` (`LocaleNamespaceMap`); update `zh`, `en`, and `src/client/locales-ru/`. Host-side user-visible messages live in `src/host/common/i18n/{zh,en,ru}.ts` (compile-time checked against `keyof typeof zh`).
- **BOM-free files**: never save files with a UTF-8 BOM (`test/infra/package-integrity.test.ts` enforces BOM-free files).

## Testing Guidelines

Tests live under `test/{providers,runtime,client,infra}/`; browser tests declare `// @vitest-environment jsdom`. Test behavior, contracts, and structural invariants rather than exact prose paragraphs, doc wording, or full prompt sentences. Tests must never require live credentials or external network access.

## Commit & Pull Request Guidelines

Use concise imperative commit messages with Conventional Commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore(release):`). Pull requests should include a problem statement, summary of changes, verification commands run, and screenshots when modifying client UI.

## Security & Configuration Invariants

Keep all credentials host-only. Never log raw tokens/keys, include secrets in web DTOs, weaken `isSameOriginMutation` (`Origin` + `Host`) checks on state-changing routes, or write/delete files belonging to external CLIs (`codex`, `claude`, `zcode`, `stepcode`, `qodercli`, `minimax`, `codebuddy`). Preserve Windows CurrentUser DPAPI, macOS Keychain, Linux Secret Service / `0600` owner-only permissions, and SSRF protections on local media and web fetching.
