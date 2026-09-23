---
name: dsh-harness-upgrade
description: Use when the DSH harness this plugin supports moves to a new release (a new `@deepseek-ai/dsh*` version, an update to the local harness checkout, or a report that something broke on a newer harness), and whenever adding or changing one of this plugin's compatibility seams.
---

# Keeping this plugin working across DSH generations

This plugin ships **one code base for every 0.1.x harness generation**. Users are
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
| Agent presets | `src/host/agent-preset.ts`, `src/host/preset-sync.ts` | Runtime registration when the harness ships the declaration-row package (`@deepseek-ai/dsh-agent-preset`) and an `agentPresets` service; the `$DSH_HOME/.agent-presets` copy below that. **Never** a static declaration row in `cordis.patch.yml` (see traps). |
| Client services | `src/client/index.tsx` (`export const inject`), `package.json` `dsh.client.inject` | Cordis resolves a service method's own `this.ctx` through a shadow that points back at the **service's** fiber, so a caller declares only what *it* reads — not what the callee reads. Check `packages/client/*/src/client/index.ts` in the harness for the current first-party spelling. |
| Provenance and names | `src/host/codex-images.ts`, `src/host/kimi-code/video-tool.ts`, `src/host/preset-sync.ts` | Message source kinds are merge-extensible: declare your own (`declare module '@deepseek-ai/dsh-llm'` → `MessageSourceMap`, kind `dsh-chatgpt-subscription`) instead of relying on a catch-all. Package renames are reconciled by probing resolution (`import.meta.resolve`), never by hard-coding a harness version. |

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

## 4. Verification recipe

New baseline, in the repo:

```bash
npm run typecheck && npm run build && npx vitest run && npm ci --dry-run && npm pack --dry-run
```

`npm ci --dry-run` proves `package.json` and `package-lock.json` are in sync, which
is what CI's `npm ci` needs. `npm pack --dry-run` proves the published file set is
still intact.

Old generation, in a **clean room** — a downgraded tree does not reproduce a
generation's dependency closure and produces fake failures:

```bash
ROOM=/tmp/plugin-old && rm -rf $ROOM && mkdir -p $ROOM
cd <repo> && cp -r src test presets bin lib cordis.patch.yml package.json \
  tsconfig.json tsconfig.client.json tsconfig.host.json vitest.config.ts $ROOM/
cd $ROOM
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));\
for(const k of Object.keys(p.devDependencies)){if(k.startsWith('@deepseek-ai/dsh-'))p.devDependencies[k]='^0.1.5-rc.1'}\
fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
npm install --no-audit --no-fund      # never --legacy-peer-deps here
npx tsc -b --pretty false             # the shipped host + client code
npx vitest run
```

Record the numbers from both runs in the CHANGELOG entry.

## 5. Recording a round

Add the user-facing story to `CHANGELOG.md` under `## Unreleased` (what changed in
the harness, what the plugin now does, how it behaves on the old generation, and
the verification numbers), then copy `references/_template.md` to
`references/<harness-version>.md` and fill it in: the harness evidence (file paths
at the tag), the plugin files that bridge it, and anything left unverified. The
next upgrade starts by reading the newest file in `references/`.

## 6. Traps learned the hard way

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
- **Old generations are the requirement, not the fallback.** Anyone reading a diff
  that "simplifies" a mapper by assuming the new shape has broken the plugin for
  most users.

## 7. Current state

- Tested baseline: **0.1.7-rc.1** (`devDependencies`); peer support 0.1.2-alpha.5
  onwards. Latest recorded run: forced typecheck + build clean, **1256 tests passed**
  (96 files passed, 1 skipped file, 7 skipped tests); old generation (clean-room
  0.1.5-rc.3): source typecheck clean, **1253 tests passed, 0 failures**, one
  generation-bound test file unable to load (`@deepseek-ai/dsh-ptc-runtime`).
- What 0.1.7 changed, and how each was bridged: `references/0.1.7-alpha.1.md` — the
  two fatal-at-boot rewrites (conversation model, settings API). `references/0.1.7-rc.1.md`
  covers the rc.1 delta: **no behavioural change was needed**, the only seam touched
  is `tool.call.toolview`'s new stage union, and that file also records the
  `dsh-client-ui-chat` type blind spot that hides this seam from `tsc`.
- Harness checkout used for every claim above: `C:\Users\A\Documents\deepseek-harness`.
