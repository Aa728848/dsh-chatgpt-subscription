# Repository Guidelines

## Project Structure & Module Organization

This repository (`@eddyskywalker/dsh-chatgpt-subscription`) is a multi-provider subscription hub and agent runtime enhancement plugin for **DeepSeek Harness (DSH)**. It registers **13 provider lines** (`codex-chatgpt`, `claude-subscription`, `antigravity`, `kimi-code`, `minimax-code`, `command-code`, `glm-coding-plan`, `step-code`, `cline-pass`, `qoder`, `opendesign`, `workbuddy-subscription`, and `ollama`), bundled agent presets, multimodal tools, prefix-cache guards, and Web UI extensions.

Source lives in `src/`; generated package output lives in `lib/` (git-ignored) and must be refreshed via build rather than edited by hand.

- `src/index.ts`: core host plugin entry, `Config` schema (including `volatile()` settings), 13-provider wiring, global guards, and tool registrations.
- `src/entry-*.ts`: sub-entry exports (`progress-updates`, `plan-mode-pipeline`, `plan-mode`, `tool-result-pruner`).
- `src/host/common/`: shared kernel — multi-account pool, `poolStorage` (`keyring` / `credentials`), catalog snapshots, proxy manager, 120s two-phase stream idle watchdog, context-overflow / image-budget helpers, and 3-language (`zh` / `en` / `ru`) host i18n runtime.
- `src/host/<line>/`: per-provider adapter, OAuth/auth flows, token/settings stores, mapper, streaming client, quota reader, and HTTP routes.
- `src/host/{cache-warmup,dispatch-ledger,progress-updates,compaction-route,no-answer-resume,reasoning-collapse-guard,widget-board}/`: host runtime subsystems.
- `src/client/`: Web GUI settings hub (`src/client/hub/`), per-line tabs & composer quota badges, shared pool UI (`src/client/common/`), Russian language pack (`src/client/locales-ru/`), Mermaid renderer, and image/video tool views.
- `src/shared/`: side-effect-free DTOs and shared wire contracts.
- `presets/dispatch/`: bundled `dispatch` orchestrator agent preset.
- `widgets/line-flip/`: bundled `dsh-widget-board` quota & account-pool flip card.
- `docs/`: user/maintainer reference guides (`README.md`, `providers.md`, `configuration.md`, `architecture.md`, `troubleshooting.md`) and engineering/probe archives.
- `.dsh/skills/`: repository maintenance skills (`add-subscription-line`, `dsh-harness-upgrade`, `release-plugin`, `diagnose-windows-sandbox-acl`). Not published with the npm package.

## Harness Compatibility

One codebase supports every DSH harness generation from `0.1.2-alpha.5` through `0.2.2-rc.1` (`peerDependencies` in `package.json`), because users are distributed across npm's `latest`, `next`, and `alpha` dist-tags. Never simplify an adapter, tool guard, or client slot by assuming only the newest generation's shape. Read `.dsh/skills/dsh-harness-upgrade/SKILL.md` before modifying version-sensitive boundaries, and `.dsh/skills/add-subscription-line/SKILL.md` when adding or extending a provider line.

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
Builds TypeScript declarations and bundles `lib/index.js`, sub-entries (`lib/progress-updates.js`, `lib/plan-mode-pipeline.js`, `lib/plan-mode.js`, `lib/tool-result-pruner.js`), and `lib/client.js`.

Use `npm pack --dry-run` when changing package metadata, exports, or published files.

## Releasing

`publishConfig` carries no `tag` on purpose: a stable release lands on `latest` immediately upon publish. Publish prereleases with an explicit `--tag alpha`.

`lib/` is incremental and retains stale `.d.ts` files from deleted sources if not cleaned first. Follow `.dsh/skills/release-plugin/SKILL.md` before publishing so the packed tarball matches a clean build and `src/compat.ts` (`PLUGIN_VERSION`) matches `package.json`.

## Coding Style, i18n & Naming Conventions

Use strict TypeScript and ESM imports. Keep changes small and consistent with nearby code: camelCase for functions/variables, PascalCase for React components/classes, and kebab-case for package/plugin/route identifiers.

When adding user-facing strings:
- Client namespaces are strongly typed in `src/client/index.tsx` (`LocaleNamespaceMap`); update `zh`, `en`, and `src/client/locales-ru/`.
- Host-side user-visible messages live in `src/host/common/i18n/{zh,en,ru}.ts`, where `en` and `ru` are compile-time checked against `keyof typeof zh`.
- Never save files with a UTF-8 BOM (`test/package-integrity.test.ts` enforces BOM-free files).

## Testing Guidelines

Tests live in `test/*.test.ts` (or `.tsx`); browser tests declare `// @vitest-environment jsdom`. Add focused unit/integration tests alongside behavior changes, especially for protocol mappers, streaming clients, OAuth/account-pool state machines, cache guards, and cross-generation compatibility code. Tests must never require live credentials or external network access.

## Commit & Pull Request Guidelines

Use concise imperative commit messages with Conventional Commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore(release):`). Pull requests should include a problem statement, summary of changes, verification commands run, and screenshots when modifying client UI.

## Security & Configuration Invariants

Keep all credentials host-only. Never log raw tokens/keys, include secrets in web DTOs, weaken `isSameOriginMutation` (`Origin` + `Host`) checks on state-changing routes, or write/delete files belonging to external CLIs (`codex`, `claude`, `zcode`, `stepcode`, `qodercli`, `minimax`, `codebuddy`). Preserve Windows CurrentUser DPAPI, macOS Keychain, Linux Secret Service / `0600` owner-only permissions, and SSRF protections on local media and web fetching.
