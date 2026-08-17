# Repository Guidelines

## Project Structure & Module Organization

This repository is a DeepSeek Harness(DSH) plugin that exposes ChatGPT subscription-backed GPT models through the `codex-chatgpt` provider. Source lives in `src/`; generated package output lives in `lib/` and should be refreshed with the build rather than edited by hand.

- `src/index.ts`: host plugin entry and service wiring.
- `src/host/`: adapter, OAuth, token storage, quota routes, Responses mapping, and streaming.
- `src/client/`: web settings UI, client API helpers, and styles.
- `src/shared/`: shared DTO/contracts.
- `test/`: Vitest unit and jsdom tests.

## Build, Test, and Development Commands

```powershell
npm run typecheck
```
Runs TypeScript project checks for host and client declarations.

```powershell
npm test
```
Runs the Vitest suite with mocked OAuth, Responses SSE, quota, and browser behavior.

```powershell
npm run build
```
Builds declarations and bundles `lib/index.js` plus `lib/client.js`.

Use `npm pack --dry-run` when changing package metadata, exports, or published files.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM imports. Keep changes small and consistent with nearby code. Prefer descriptive camelCase for functions and variables, PascalCase for React components and classes, and kebab-style names only for package/plugin identifiers. There is no separate lint command; `tsc` and tests are the main enforcement tools.

## Testing Guidelines

Tests are named `*.test.ts`; browser-oriented tests use `// @vitest-environment jsdom`. Add focused tests beside the behavior you change, especially for `responses-mapper`, `responses-client`, OAuth routes, and client DOM compatibility code. Do not require live ChatGPT credentials or network access in tests.

## Commit & Pull Request Guidelines

Recent history uses short imperative commits, sometimes with Conventional Commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, and `chore(release):`. Prefer concise messages such as `fix: map raw image links to multimodal input`.

Pull requests should include a short problem statement, implementation summary, verification commands, and screenshots for visible client UI changes.

## Security & Configuration Tips

Keep OAuth tokens host-only. Do not log raw credentials, expose endpoint overrides, or weaken same-origin POST checks. Preserve Windows CurrentUser DPAPI storage, Linux owner-only credential permissions, and loopback-only local image fetching.
