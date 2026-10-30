---
name: dsh-harness-upgrade
description: Use when the DSH harness this plugin supports moves to a new release (a new `@deepseek-ai/dsh*` version, an update to the local harness checkout, or a report that something broke on a newer harness), and whenever adding or changing one of this plugin's compatibility seams.
---

# Keeping this plugin working across DSH generations

This plugin ships **one code base for every supported harness generation**
(0.1.2-alpha.5 through 0.2.1-rc.3 today). Users are
spread across `latest` / `next` / `alpha`, so a new harness release never licenses
dropping an old one: every breaking change gets bridged at a boundary, and both
generations keep passing tests. This skill is the procedure, the seams, and the
traps. Per-release records live beside it in `references/`.

## 1. Establish the truth before reading code

Three different "versions" disagree, and the disagreements are where time is lost:

- **What npm publishes** — `npm view @deepseek-ai/dsh dist-tags` (`latest`, `next`,
  `alpha`). Most users run `latest`, and it is often several releases behind
  `alpha`. The plugin's peer range must cover every generation users run; the
  `devDependencies` pin names the one the suite is built and tested against.
- **What the local harness checkout is** — `git -C C:\Users\A\Documents\deepseek-harness tag --sort=-creatordate | head`
  and `git -C … log --oneline -1`. Release tags are `dsh-v<version>`; `git diff
  dsh-v<old>..dsh-v<new>` is the authoritative delta. Read files at a tag with
  `git show <tag>:<path>`; the checkout's working tree may hold other work.
- **What a machine actually executes** — `dsh --version`, and check whether the
  profile symlinks the harness source instead of installing it:
  `ls -la ~/.dsh/profiles/<name>/node_modules/@deepseek-ai/`. A symlinked package
  runs its **`lib/` build**, which is stale after a `git pull`, so a runtime
  report and the source at the tag can both be true. Verify a claim against the
  published artifact when it matters:
  `npm pack @deepseek-ai/<pkg>@<version>` then grep the extracted `lib/`.

## 2. The seams this plugin owns

Bridge at the narrowest boundary and leave the provider code alone; that is what
keeps generations comparable. Each seam has one file:

| Seam | File | Invariant |
|---|---|---|
| Conversation model | `src/host/common/llm-compat.ts` | The harness request is normalized **once** at the adapter boundary (`responses-client.stream`, each provider's `offloadOldestRequest*` call). Mappers, tests, and fixtures read the canonical vocabulary — the pre-0.1.7 spelling — so mapper logic never forks per generation. |
| Settings | `src/host/common/settings-compat.ts`, `file-preferences.ts`, `legacy-preferences.ts`, `src/host/preferences.ts` | `settings.register` when the harness still offers it (≤0.1.6); otherwise a plugin-owned JSON document under `$DSH_HOME/storages`, seeded once from the section earlier releases wrote into the harness settings document. Provider stores hydrate from their own model files. |
| Agent presets | `src/host/agent-preset.ts`, `src/host/preset-sync.ts` | Runtime registration when the harness ships the declaration-row package (`@deepseek-ai/dsh-agent-preset`) and an `agentPresets` service; the `$DSH_HOME/.agent-presets` copy below that. On ≥0.2.1 (when `@deepseek-ai/dsh-working-directory` resolves), `resolveDispatchPreset` strips `persona.config.suffix` (`Your working directory is {{cwd}}.`) because the `cwd` prompt variable was replaced by the `working-directory` section. When `@deepseek-ai/dsh-tool-subagent-control/list-agents` no longer resolves, `resolveDispatchPreset` omits that standalone row because the main control entry registers the tool; older exports keep it. **Never** a static declaration row in `cordis.patch.yml` (see traps). |
| Web search provider | `src/host/search-provider-switcher.ts` | Unwraps `fiber.config.searchProvider` whether it is a plain string (≤0.2.1-rc.1) or a Cordis `Volatile<string>` wrapper (≥0.2.1-rc.2), preventing unnecessary forced fiber reloads on hot updates. |
| Client services | `src/client/index.tsx` (`export const inject`), `package.json` `dsh.client.inject` | Cordis resolves a service method's own `this.ctx` through a shadow that points back at the **service's** fiber, so a caller declares only what *it* reads — not what the callee reads. Check `packages/client/*/src/client/index.ts` in the harness for the current first-party spelling. |
| Provenance and names | `src/host/codex-images.ts`, `src/host/kimi-code/video-tool.ts`, `src/host/preset-sync.ts` | Message source kinds are merge-extensible: declare your own (`declare module '@deepseek-ai/dsh-llm'` → `MessageSourceMap`, kind `dsh-chatgpt-subscription`) instead of relying on a catch-all. Package renames are reconciled by probing resolution (`import.meta.resolve`), never by hard-coding a harness version. |
| Host transport | `src/host/common/webserver-compat.ts`, `src/host/common/idle-watchdog.ts` | Use the running WebServer's origin API when present, preserve the legacy loopback fallback otherwise, and never await an abandoned stream generator's queued cleanup after its deadline has already settled. |
| Cache warmup and retrieval projection | `src/host/cache-warmup/install.ts`, `projection.ts`, `retrieval-intent.ts` | Only `kimi-code` is admitted. `PostToolDecision` content/value is a mutually exclusive union: original log paths never rewrite `value`; retrieval/PTC may replace it only after a preview actually exists, otherwise return the original decision. PTC wraps Read in `run_code` with a canonical JSON envelope, so handle both that shape and `run_code` itself. Skip reminder-only `user/message` records and runtime context before classifying the latest real user intent. Never rewrite history or issue proactive warmup requests. See `references/cache-warmup-retrieval.md`. |
| Request metadata | `src/host/common/reasoning-efforts.ts`, `src/host/common/request-images.ts` | Resolved reasoning ladders are least-to-greatest without changing default-effort selection or settings display order; adapter image targets equal the mapper's actual request projection and retain the old store's `maxPixels` alongside newer dimensions. |
| Wire and OAuth constants | `src/compat.ts` | Every backend and OAuth value that is not a public third-party contract lives here, so the whole wire surface is reviewable and rollbackable in one file. `CODEX_ORIGINATOR` and `OAUTH_ORIGINATOR` are deliberately ONE identity: the backend keys behaviour off it, and splitting it per endpoint gave a single account three unrelated failure signatures. Each subscription line's provider id and route prefix are re-exported from its frozen shared contract rather than restated here, and `PLUGIN_VERSION` is what `wire-auth.ts` sends as `user-agent`, so it must equal `package.json`'s version (a test asserts it). |
| Credential record seam | `src/host/common/credentials-compat.ts` | The record half of DSH's `ctx.credentials` is written as a local structural shape instead of a type-only import of `@deepseek-ai/dsh-credentials`, because that seam exists only from harness 0.2 while this one code base still installs on 0.1.2-alpha.5. A host carrying the seam satisfies the shape structurally and a host without it falls through to the next backend, so the three methods must keep the seam's own names and argument types, and `KEY_SEGMENT_PATTERN` is copied from the shipped builder rather than invented — a key the seam rejects fails the provider's activation on the next start. |
| Tool-call id brand | `src/host/common/brand-compat.ts` | `toToolCallId` reads the `ToolCallId` brander (or the older `CallId`) off the live `@deepseek-ai/dsh-llm` namespace at call time and falls back to identity, so every mapper still compiles and runs on a generation that ships no brander. The lookup must stay inside the function: a module-level read would freeze whichever generation loaded first and defeat the compatibility it exists for. |
| Forked preset services & cache guards | `src/entry-plan-mode.ts`, `src/entry-tool-result-pruner.ts`, `src/host/plan-mode-cache-guard.ts`, `src/host/tool-result-pruner-guard.ts`, `src/host/ptc-sdk-cache-guard.ts`, `src/host/compaction-policy-guard.ts` | The `dispatch` preset mounts **this package's** services (`@eddyskywalker/dsh-chatgpt-subscription/plan-mode`, `…/tool-result-pruner`), not the harness ones, because both harness services rebuild the provider's content-prefix cache. Each fork ships as its own subpath export (`./plan-mode`, `./tool-result-pruner`: `package.json` `exports` + `tsdown.config.ts` + `tsconfig.host.json`), so a preset row can name it on every supported generation without a harness package. The plan fork keeps the official behaviour and drops the rebuild: it registers **no** dynamic `plan:policy` system section and registers `exit_plan_mode` **unconditionally** (no `{ when }`), so neither the system prefix nor the tool table changes when Plan Mode is entered or left; the deployment's `section` goes out as a trailing user message instead. The pruner fork is byte-compatible with the official pruner (same marker, same `compaction/prune` shadow-price event, same `surfaceOp: { op: 'replace', startSeq, endSeq }` + `sourceEventSeqs`) except that it skips a provider list (default `['kimi-code']`) whole-session, because rewriting a historical tool result invalidates the provider's content-prefix cache from that point to the end of the conversation. The host-side guards extend both to the presets this package does **not** own and must never become a second implementation: each flattens a seam in place and restores exactly what it wrapped on `dispose()`. The plan-mode guard must be installed **before** the official plan-mode row registers its tool (the tool layer has no "edit one registered entry" API), so a late install may only warn; the pruner guard must find the instance in **both** `ctx.reflect.store` and `agent.ctx.get('toolResultPruner')`, because the preset isolates the pruner into its own realm and the host store does not see it. Two of the four guard seams are **not** extensions of those two forks: the PTC SDK cache guard freezes the `tools:sdk` system section (it wraps `tools.definitions(scope, toolSet)` so the step-level `toolSet` is ignored under the protected providers, and reuses the first non-empty `tools:sdk` text per session until the unfiltered tool set changes), and the compaction policy guard rewrites the compaction engine's `config.modelPolicies` (an explicit user policy still wins; then a frozen Kimi Code policy — `retainTokens: 8192`, `thresholdRatio: 0.85`, `headroomTokens: 32768`, `maxTokens: 32768` — and it replaces the compaction instruction natively inside `summarize`). All four are installed **exactly once** on the host plane: `src/index.ts` gives each guard its own `ctx.effect` and disposes it when the plugin unloads, because a guard's idempotency is per install, not per context. The forked rows are `OPTIONALLY_ABSENT_PACKAGES` in `src/host/preset-sync.ts`, and every forked row must exist in **both** copies of the preset (`src/host/agent-preset.ts` and `presets/dispatch/agent.cordis.yml`) — one edit, two files, or the two sides teach different presets. |

## 3. Procedure for a new harness release

1. `git -C <harness> fetch --tags` and list the tags; pick the previous baseline
   (the version `devDependencies` pins) and the new target.
2. Enumerate what this plugin imports and diff only that surface:
   `grep -rhoE "from '@deepseek-ai/[^']+'" src | sort -u`, then
   `git diff dsh-v<old>..dsh-v<new> -- packages/<area>` per package, and read the
   changed declarations with `git show <tag>:<path>`.
3. Classify every finding: **type-only**, **behavioural** (the plugin keeps
   compiling but produces the wrong wire), or **fatal at boot** (the harness
   refuses to start — treat those as blockers and re-read them twice).
4. Bump the ranges: add the new prerelease **explicitly** to the peer union
   (`|| ^0.1.7-alpha.1` — caret ranges do not cross prerelease tuples), and point
   `devDependencies` at the new baseline.
5. Implement each bridge in its seam file, with the older generation's behaviour
   preserved by construction rather than by a version check.
6. Verify (section 4), record (section 5), then commit and push.

### 3a. The forked preset services and the cache guards

The dispatch preset no longer mounts the harness's plan-mode and tool-result-pruner
services, so **the harness delta that matters is not only in what this plugin
imports** — it is in what the forks copy. Every harness round must diff these four
upstream packages against the last baseline and answer one question per package:
did the official behaviour change in a way the fork has to copy, or in a way the
fork has to stop copying?

```bash
git -C <harness> diff dsh-v<old>..dsh-v<new> -- \
  packages/plan/plan-mode \
  packages/compaction/compaction-tool-result-pruner \
  packages/compaction/compaction-basic \
  packages/core/tools
```

| Upstream package | What the fork copies from it | What to check in the diff |
|---|---|---|
| `packages/plan/plan-mode` | the tool name `exit_plan_mode`, the plan projection key and state machine, the `plan:policy` section name, the `enter_plan_mode` tool result | A **new** dynamic `systemPrompt.section(...)` in the official service is a new prefix rebuild: the fork must not register it, and the plan-mode cache guard must strip it. A **new** `{ when }` on a tool is a second tool-table rebuild: the fork keeps registering `exit_plan_mode` unconditionally and the guard strips the conditional. A change to the plan projection's `stateVersion` is fatal at registration — `sessionProjections.register` refuses a mismatched version, so the fork registers 4 and retries once with the version the "already registered at stateVersion N" error names. |
| `packages/compaction/compaction-tool-result-pruner` | the prune marker, the config keys and their validation, the `compaction/prune` shadow-price event, the `surfaceOp: { op: 'replace', startSeq, endSeq }` replacement and `sourceEventSeqs` | The fork is byte-compatible on purpose, so a change to the marker text, to the `thresholdChars` / `headChars` / `tailChars` validation, to the event name, or to the `surfaceOp` shape must be mirrored in `src/entry-tool-result-pruner.ts` **and** in `test/tool-result-pruner.test.ts` — that test is the spec comparison, not a convenience. A new key must stay optional: an unknown key must still be rejected. |
| `packages/compaction/compaction-basic` | the way it reaches the pruner, and the budget keys the compaction policy guard rewrites | `compaction-basic` resolves the pruner with `ctx.get('toolResultPruner')` and treats a missing one as "skip the model-free pass" (`if (prune !== undefined)`, `?.`). If the lookup key, the call sites, or that fallback change, the preset's `isolate` list must follow: the pruner instance has to sit in the same realm as the compaction service, and a missing pruner must stay non-fatal. The compaction policy guard rewrites `config.modelPolicies` of that same service, so a change to the budget keys (`retainRatio`, `thresholdRatio`, `headroomTokens`, `retainTokens`, `maxTokens`), to the `modelPolicies` shape, or to the `compactIfNeeded` / `compactPressure` / `compact` / `summarize` entry points is a change the guard has to follow — an explicit user policy still has to win over the guard's frozen one. |
| `packages/core/tools` | the `ToolDefinition` contract the guards patch, and the `definitions(scope, toolSet)` signature the PTC SDK cache guard wraps | `when?: (context) => boolean \| Promise<boolean>` is what the plan-mode cache guard removes from `exit_plan_mode`. A change to the tool-registration signature, to the `when` contract, or to how the tool table is published invalidates that seam: the guard must keep finding the registration point, and a late install must warn instead of pretending to have flattened it. The PTC SDK cache guard needs the same package to keep `definitions(scope, toolSet)`: it ignores the step-level `toolSet` under the protected providers and caches the assembled `tools:sdk` section per session, so a rename or a signature change there is a rebuild the guard has to answer. |

The host-side guards (`src/host/plan-mode-cache-guard.ts`,
`src/host/tool-result-pruner-guard.ts`, `src/host/ptc-sdk-cache-guard.ts`,
`src/host/compaction-policy-guard.ts`) are the last line of defence, **not** the
implementation. Each one's own header is the authority on what it flattens, and
after every harness bump each must still satisfy three properties: it **changes
nothing** in the harness service it guards beyond the one seam it is responsible
for, it **restores exactly** what it wrapped (`dispose()`), and it is **idempotent
within one install** — a repeated scan or a repeated event must not stack a second
wrapper. Idempotency is *per install*, not *per context*: every guard keeps its own
`WeakSet`/`WeakMap`, so installing the same guard twice on one `ctx` **would**
stack a second wrapper (the plan-mode guard says so in its own header and leaves
the single-install rule to the caller). The host entry therefore installs each
guard **exactly once** — `src/index.ts` gives all four their own `ctx.effect` and
disposes them when the plugin unloads. A guard that starts re-implementing the
service it guards is a second implementation and a second place to drift.

The seam each guard owns, and what a harness bump has to keep answering:

| Guard | The one seam it flattens | What a bump must keep answering |
|---|---|---|
| `plan-mode-cache-guard.ts` | the dynamic `plan:policy` system section and the `{ when }` on `exit_plan_mode` | does the official service still register a dynamic section, and is `when` still the conditional-admission key? |
| `tool-result-pruner-guard.ts` | the pruner instance's `pruneSession` | is the service still called `toolResultPruner`, and is it still reachable from `ctx.reflect.store` **and** from `agent.ctx.get('toolResultPruner')`? |
| `ptc-sdk-cache-guard.ts` | `tools.definitions(scope, toolSet)` and the `tools:sdk` system section | does the tool layer still expose `definitions` in that shape, and is the PTC section still named `tools:sdk`? The guard deliberately leaves `tools.executable` alone: the tool stays *visible* for cache stability while the step admission still gates the *call*. |
| `compaction-policy-guard.ts` | the compaction engine's `config.modelPolicies` and the `summarize` entry point | do the budget keys (`retainRatio`, `thresholdRatio`, `headroomTokens`, `retainTokens`, `maxTokens`) still exist, and is `modelPolicies` still resolved by a `find` over `provider`/`model`? |

The compaction policy guard is the one guard that deliberately **rewrites** the
guarded service instead of only flattening a rebuild: it replaces the engine's
`config` with a frozen copy whose `modelPolicies` carries a custom `find` (an
explicit user policy wins, then a frozen Kimi Code policy, then a probe over the
last observed model), and it wraps `compactIfNeeded` / `compactPressure` /
`compact` / `summarize` to observe the live provider/model and to replace the
compaction instruction natively. `dispose()` restores the original `config`
descriptor and the original methods.

The forked rows are the plugin's **own subpath exports**, so they belong to
`OPTIONALLY_ABSENT_PACKAGES` in `src/host/preset-sync.ts`: a synced preset tree
outlives the plugin version that wrote it, and a stale row naming an export nothing
provides marks the whole preset broken — unselectable and uncopyable — instead of
losing one row. When a forked row is added or renamed, add it to that set in the
same change, and make the edit in **both** copies of the preset.

## 4. Verification recipe

New baseline, in the repo:

```bash
npx tsc -b --force --pretty false && npx tsc -p test/tsconfig.json --pretty false
npm run build && npx vitest run && npm ci --dry-run && npm pack --dry-run
```

`tsc -b` alone is not a check: it replays `lib/*.tsbuildinfo` and returns in
seconds on a stale build (3.2s on this repo, rc.2 round). **`--force` is the only
meaningful typecheck**, and it has to cover the shipped host + client code
(`-b`) and the test tree (`-p test/tsconfig.json`) separately.

`npm ci --dry-run` proves `package.json` and `package-lock.json` are in sync, which
is what CI's `npm ci` needs. `npm pack --dry-run` proves the published file set is
still intact. Moving a baseline usually needs the lockfile **regenerated**, not
incrementally updated — an rc.2-era `dsh-attachment` pins a sibling
`@deepseek-ai/dsh-brand` peer exactly, and `npm install` then dies with
`ERESOLVE` rather than moving that sibling.

Old generation, in a **clean room** — a downgraded tree does not reproduce a
generation's dependency closure and produces fake failures:

```bash
ROOM=/tmp/plugin-old && rm -rf $ROOM && mkdir -p $ROOM
cd <repo> && cp -r src test presets bin lib widgets cordis.patch.yml package.json \
  tsconfig.json tsconfig.client.json tsconfig.host.json vitest.config.ts \
  icon.svg README.md CHANGELOG.md LICENSE $ROOM/
cd $ROOM
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));\
for(const k of Object.keys(p.devDependencies)){if(k.startsWith('@deepseek-ai/dsh-')){\
p.devDependencies[k]='0.1.5-rc.1';p.peerDependencies[k]+=' || 0.1.5-rc.1'}}\
fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
npm install --no-audit --no-fund      # never --legacy-peer-deps here
npx tsc -b --force --pretty false     # the shipped host + client code
npx vitest run
```

Keep the room outside the repository: Node resolution from a room under the repo can
silently fall through to the root `node_modules` and turn a missing old package into a
mixed-generation false positive. Pin every **reachable transitive DSH sibling** exactly
through `overrides` as well as the direct dependencies; npm's package metadata can
recursively enumerate that closure. Direct pins alone let later prereleases drift in
through caret peers. For 0.1.5-rc.1, the verified vendor closure is `cordis@4.0.2` and
`cordis-plugin-loader@1.0.3`; keep the room's dev/peer invariant when pinning vendors.
If the full run's only failure is a documented generation-bound import (currently the
PTC authorization test on 0.1.5), rerun with exactly that file excluded and record both
results rather than hiding the initial failure or contorting the test.

Run a **third** room for the previous baseline when the round claims "no
behavioural change": pinning the previous generation on the same source and
getting identical file/test counts is direct evidence, where "the suite passed"
alone is not. Pin it **exactly** — `^0.1.7-rc.1` still installs `0.1.7-rc.2`, so a
caret range silently duplicates the baseline room. Any manifest edit in a room
must keep the dev/peer invariant `test/package-integrity.test.ts` enforces
(§6), and the room must keep every real runtime dependency: the clean-room copy
carries `lib/`, so pruning something like `mermaid` "because only a renderer test
uses it" makes `test/routes.test.ts` fail with a 404 that says nothing about the
plugin.

Record the numbers from all three runs in the CHANGELOG entry.

## 5. Recording a round

Add the user-facing story to `CHANGELOG.md` under `## Unreleased` (what changed in
the harness, what the plugin now does, how it behaves on the old generation, and
the verification numbers), then copy `references/_template.md` to
`references/<harness-version>.md` and fill it in: the harness evidence (file paths
at the tag), the plugin files that bridge it, and anything left unverified. The
next upgrade starts by reading the newest file in `references/`.

## 6. Traps learned the hard way

- **`PostToolDecision` is a discriminated content/value union, not two optional fields.** Do not return both. Legacy cache-warmup paths reject every value-carrying decision; only explicit navigation retrieval/PTC may proceed, and if no preview is produced the original decision object must survive.
- **PTC hides nested tools inside `run_code`.** A Read result can be canonical JSON `{ path, offset, lines: [{ number, text }] }` with a structured `value`, not numbered plain text. Validate the complete envelope and increasing line numbers, and keep mixed JSON/source evidence verbatim.
- **The latest `user/message` is not necessarily the user's request.** DSH appends reminder-only records and runtime context. Skip those records and continue backward to the latest real text; returning false at the first empty reminder disables every projection.
- **Projection is not proactive cache creation.** Do not add an extra model request: it spends quota and cannot cache tool results that have not happened. The first real request creates the prefix; projection reduces only later suffixes.
- **Budget fixes must not erase required evidence.** File outlines keep only top-level declarations, paths are optional, and contracts/mixed evidence remain verbatim. Indented locals once produced 27 declarations and a guaranteed `verbatim-budget` fallback.
- **Linked runtime artifacts need their own verification.** A linked profile runs `lib/index.js`, so a new unit test does not prove the running Host loaded it. Rebuild, reload Host for schema/host changes, and refresh the client for bundle changes.
- **A static preset declaration row is fatal.** Harness ≤0.1.6 has no
  `@deepseek-ai/dsh-agent-preset`, and `assertEntriesLoaded`
  (`packages/boot/app-boot/src/index.ts`) throws when any non-disabled entry has no
  fiber — the harness would refuse to start for most users. YAML cannot be made
  conditional on the running generation, so registration is runtime work.
- **Prerelease ranges do not cross tuples.** `^0.1.6-alpha.1` covers `0.1.6-*` but
  not `0.1.7-alpha.1`; every new prerelease family needs its own `||` clause.
- **`npm install` will not move the baseline** while the installed version still
  satisfies the union range. Pin `devDependencies` to the new generation, or the
  suite silently keeps testing the old one.
- **`--legacy-peer-deps` skips peer dependencies**, which shows up later as a
  "Cannot find package" crash inside a *harness* package (`@deepseek-ai/dsh-scope`
  from `dsh-tools`). Never use it in a clean room.
- **Test fixtures built with harness factories are generation-bound.**
  `createToolResultMessage` returns the 0.1.7 `role: "tool"` message on 0.1.7 but
  the legacy `tool-result` block on 0.1.5, so a bridge test that uses it passes on
  one generation and fails on the other. Write the wire shape literally in bridge
  tests.
- **A generation-bound test file is acceptable; a broken seam is not.** One test
  imports a package that only exists from 0.1.7 (`dsh-ptc-runtime`) and cannot load
  in an old clean room — that is a dev-only limitation worth naming, not a reason to
  contort the test.
- **Trust a fix only after reproducing its cause.** A community PR claimed a
  client `inject` root cause; a probe with the real Cordis (sibling fibers, the
  service's own `static inject`) showed callers need only what they read, so the
  patch was harmless but was not the fix. Probe rather than reason from the stack
  trace, and say which of the two the change actually is.
- **`tsc -b` without `--force` is not a check.** It replays `lib/*.tsbuildinfo`
  and returns in seconds on a build made against the previous generation, so a
  baseline bump can look green without ever compiling against the new types. The
  rc.2 round hit this: `npm run typecheck` finished in 3.2s, and the forced run
  was the only real one.
- **The dev/peer invariant is machine-enforced, not a convention.**
  `test/package-integrity.test.ts` splits each peer range on `||` and asserts
  every `devDependencies` range appears in it **verbatim**. Bumping
  `devDependencies` without adding the matching `||` clause to the peer union
  fails the suite — so that clause is required, even when the previous clause
  already covers the new version semantically.
- **A clean room must pin exactly and must not prune runtime dependencies.**
  `^0.1.7-rc.1` installs `0.1.7-rc.2`, so a "previous baseline" room built from a
  caret range is a duplicate of the baseline room and its agreeing numbers prove
  nothing. And since the room carries `lib/`, deleting a real runtime dependency
  (e.g. `mermaid`) to speed the install makes `test/routes.test.ts` fail with a
  404 — a script artifact that reads exactly like a plugin regression.
- **Old generations are the requirement, not the fallback.** Anyone reading a diff
  that "simplifies" a mapper by assuming the new shape has broken the plugin for
  most users.
- **A hand-written message literal is a latent session bug, not a compat shortcut.**
  DSH validates every admitted message in `session.append` via
  `assertMessageEventShape` (`packages/core/session/src/index.ts`): a missing
  `id` throws `lacks an identified message`, a missing `source` throws
  `has invalid source`, and a wrong role throws. A literal
  `{ role: 'user', content }` therefore fails at the first steer. The guard
  shipped that literal behind a comment claiming it avoided a generation-bound
  factory — but `createUserMessage` has existed since 0.1.2-alpha.5, so the
  constraint was misread: the factory is the only thing that satisfies BOTH
  requirements at once. Always build messages with the factory plus this
  package's own `PLUGIN_MESSAGE_SOURCE_KIND`.
  Two traps make this expensive when it happens: (1) the throw is synchronous
  inside `session.append`, so a steer issued after a `cancel` aborts the turn
  the user is already waiting on, and (2) a shape-only assertion passes
  forever. Assert against the real boundary (`adoptSessionEvent`) — and verify
  the new test **fails** when the fix is reverted, or it is not a regression test.

## 7. Current state

- Tested baseline: **0.2.1-rc.3** (`^0.2.1-rc.3` in `devDependencies` and `peerDependencies`); peer support 0.1.2-alpha.5
  onwards. Latest recorded full rc.3 run: forced three-project typecheck + build, **4651 tests passed / 8 skipped / 0 failed**
  (282 files passed, 2 skipped). The original exact-rc.2 clean room had identical counts (282 files, 4649 tests, 8 skipped).
  The 0.1.5-rc.1 clean room passes its supported suite with **4644 tests passed / 9 skipped / 0 failed** (281 files passed,
  2 skipped); its one generation-bound PTC file that cannot load is identified in `references/0.2.1-rc.3.md`.
- What 0.1.7 changed, and how each was bridged: `references/0.1.7-alpha.1.md` — the
  two fatal-at-boot rewrites (conversation model, settings API). `references/0.1.7-rc.1.md`
  covers the rc.1 delta: **no behavioural change was needed**, the only seam touched
  is `tool.call.toolview`'s new stage union, and that file also records the
  `dsh-client-ui-chat` type blind spot that hides this seam from `tsc`.
  `references/0.1.7-rc.2.md` covers rc.2: again **no behavioural change needed**, and
  this time with the identical-outcome rc.1 room as evidence. Its live items are two
  changes that are deliberately **not** bridged — the harness now projects new
  `tool-addition`/`tool-removal` blocks per route (`projectToolUpdates` strips them
  for a route that declares no `toolUpdate`, which is every route here), and GUI
  model selection now requires catalog membership (`modelAvailable` in
  `session-controller`, which makes an offline model change fail on the three routes
  whose catalog is remote). Two new capabilities exist and are unadopted:
  `toolUpdate` and the `shell.quota-notice` / `ACCOUNT_QUOTA` surface.
  `references/0.2.0-rc.1.md` covers 0.2.0-rc.1: **no behavioural change needed**
  despite the major-looking version — every imported package is a version bump or an
  internal/additive delta, both slot contracts are byte-identical across the tags,
  and the identical-outcome rc.2 room is the evidence.
  `references/0.2.0-rc.2.md` covers 0.2.0-rc.2: **no behavioural change needed** —
  additive `ask_user_question` timed mode and question row/record types,
  `ui-model-selection` fuzzy search and provider ordering, and internal performance
  memoizations; the identical-outcome 0.2.0-rc.1 clean room is the evidence.
  `references/0.2.1-alpha.5.md` covers 0.2.1-alpha.5: WebServer origin and
  optional-port bridging, detached idle cleanup, least-to-greatest reasoning
  metadata, exact adapter image targets (including old-store `maxPixels`), lazy
  tool arguments, and the PTC test-fixture requirements. It also records the
  stable-vendor peer-closure choice, the old-generation GLM type bridge, and the
  capabilities deliberately left unadopted.
  `references/0.2.1-rc.2.md` covers 0.2.1-rc.1 and 0.2.1-rc.2: `resolveDispatchPreset`
  strips `persona.config.suffix` (`Your working directory is {{cwd}}.`) on ≥0.2.1
  where `@deepseek-ai/dsh-working-directory` replaces the `cwd` template variable,
  `SearchProviderSwitcher` unwraps `Volatile<string>` on `fiber.config.searchProvider`
  introduced in 0.2.1-rc.2, and the Claude model catalog aligns with `pi-ai@1.1.0`.
  `references/0.2.1-rc.3.md` covers rc.3: Conversation View and right-guide pin/More
  customization is additive and needs no runtime bridge. It also records the old-generation
  structural type fixes for volatile config, command contributions, and config forms, the
  exact transitive clean-room closure, and the real npm-rc.3 host/client smoke. A follow-up
  bridges the removed `dsh-tool-subagent-control/list-agents` export in `resolveDispatchPreset`,
  with two failing-first regression cases and a real dispatch-session creation. A final
  evidence review also resolves the `pi-ai@1.3.0` Claude baseline: Opus 5 accepts disabled
  thinking at high or below, Sonnet 4.5 uses its standard 200k window, and the final full
  suite is **4651 passed / 8 skipped / 0 failed**.
  `references/cache-warmup-retrieval.md` is likewise not a harness round: it freezes the cache-warmup state machine, default-on retrieval behavior, PTC/Read JSON and PostToolDecision seams, reminder-only user-event handling, and the runtime/four-request evidence. Latest full run for that work: **310 files passed / 2 skipped; 5166 passed / 9 skipped**, plus **112 focused default-on tests**.
  `references/codex-wire-surface.md` is not a harness round but belongs in this
  list because it rewrites a compatibility seam: the Codex subscription line now
  sends the `openai-beta` gate the backend requires, presents ONE `originator`
  (three divergent values were in use), reads the live `/backend-api/codex/models`
  listing instead of a hardcoded table, and replays `prompt_cache_key` /
  `x-codex-turn-state` for multi-turn continuation. It records which wire values
  are reverse-engineered, so the next round does not "fix" the ones that are
  already correct.
- Harness checkout used for every claim above: `C:\Users\A\Documents\deepseek-harness`.