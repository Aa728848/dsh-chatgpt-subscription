---
name: add-subscription-line
description: Use when adding a new subscription line (a new provider id with its own sign-in, account pool, model catalog, quota card and settings page) to this plugin, or when extending an existing line to a second deployment/region. Covers the seam list, the freeze-then-parallel order, the shared-kernel reuse rules, the catalog snapshot codec, the whitelist/fallback id-vocabulary split, tri-state settings migrations, and the traps this repo has already paid for once.
---

# Adding a subscription line

This plugin is a collection of **independent subscription lines** that share one kernel.
A new line is not a feature branch of an existing one: it gets its own provider id, its own
credential store, its own routes, its own settings card, and its own tests. What it must
**reuse** is the kernel (`src/host/common/*`) and the shared client components — never a copy of
another line.

Two worked examples exist in-tree: `glm-coding-plan` (account OAuth → exchange chain → signed
requests) and `step-code` (cloud-polled sign-in → OpenAI-compatible chat + a non-public quota
endpoint). Their planning records are `docs/glm-zcode-line-plan.md` and `docs/step-code-line-plan.md`.

## 1. Non-negotiables

1. **Never touch another line.** A line's own directory is the only place its behaviour changes.
   Additions to shared files are limited to the registration points in §3, and each is a one-id
   or one-entry append — no logic edits, no reordering.
2. **Append, never insert.** New entries go at the **end** of every list (hub card order,
   composer slot order, `TAB_IDS`, the index.ts wiring blocks, the dispose list, the export tail).
   Inserting in the middle is behaviourally identical but makes the diff unreviewable and moves
   other lines' positions for no reason.
3. **Reuse before writing.** Model checklist, account-pool card, context-window editor, composer
   quota badge, line API reader, credential stores, catalog snapshot, concurrency gate, request
   diagnostics — all already exist. A line that re-implements one of them is a line that will
   drift from it.
4. **State facts you cannot verify as unverified.** Protocol constants get their source URL or
   file:line in a comment, and a value that was guessed gets marked as such. A wrong constant
   presented as fact costs the next person a debugging round.

## 2. Freeze the contract first, then work in parallel

The single biggest scheduling decision: **types and constants go first, alone, and get frozen**.
Everything else depends on their names. Get the names wrong and every parallel worker returns
conflict-ridden work.

```
Wave 1  src/shared/<line>-contracts.ts + src/host/<line>/{types,model-catalog,token-store}.ts
        -> the ONLY wave that runs alone. Freeze every export name here.
Wave 2  A: client/oauth/adopt/account-pool   B: mapper/cache-stats   C: client UI (**)
        -> three workers, disjoint file sets, all importing the frozen names.
Wave 3  adapter + routes + src/index.ts wiring + the shared registration points.
Wave 4  hub card / brand mark / client slots / existing count assertions / README / CHANGELOG.
Tests   contract guards and mapper/cache guards can run beside Wave 2; UI tests beside Wave 3.
```

(*) **File sets must be disjoint.** When a worker needs a constant another wave still owns, do not
let it copy the value — either wait, or let it import once the owner has landed. A duplicated
constant is two sources of truth for one upstream fact.

(**) **UI workers must not invent protocol.** They read the frozen DTOs. Capabilities are never
inferred from a model name — the host sends a `hint`/capability field and the card renders it.

## 3. The registration points (the complete list)

Miss one and the feature is silently absent — there is no error, just a line that does not work.

| File | What to add | If missed |
|---|---|---|
| `src/index.ts` | imports; store/pool construction; adapter + `claimProviderRoute` + `register<Line>Routes`; hub summary entry; dispose; export tail | the line does not exist at all |
| `src/host/common/model-request-control.ts` | one id in `CONTROLLED_PROVIDERS` | no concurrency gate / queueing |
| `src/host/common/request-diagnostics.ts` | one id in `DIAGNOSTIC_PROVIDERS` | no `[provider-diagnostics]` logs |
| `src/client/hub/providers.tsx` | one `HUB_PROVIDERS` entry | no card, no settings page |
| `src/client/hub/brand-icons.tsx` | `HubProviderId` union + `PROVIDER_BRANDS` entry carrying the vendor's **official** mark (§6.7) | blank/generic tile, or a monogram next to real vendor artwork |
| `src/client/index.tsx` | import, `LocaleNamespaceMap`, `locale.register`, style install, `conversation.input.right` slot | no badge, untyped locale keys |
| existing count assertions | append one item (`TAB_IDS`, card-name array, slot order, prefix poll list) | the suite goes red |

Route mounting is **unconditional** even when the line loses the route claim: the card is how a user
signs in the first time, so gating it on winning the route leaves a contested id unconfigurable.

## 4. Reuse map: what to take, not rebuild

| Need | Use | Do not |
|---|---|---|
| Account pool, rotation, cooldown | `AccountPoolCore` via a thin per-line wrapper | re-implement rotation |
| Credential storage | the per-platform store (`DPAPI` / Keychain / Secret Service) | write plaintext |
| Model list UI | `common/ModelChecklist.tsx` | hand-roll rows |
| Account card + quota bars | `common/AccountPoolSection.tsx` (+ `renderLoginActions`, `renderDetails`, `renderAccountActions`) | fork the card |
| Composer badge | `common/ComposerQuotaBadge.tsx` + a testable `selectBadgeFacts` | add a bespoke badge |
| Route reader (client) | `common/line-api.ts` `createLineApi` | hand-roll envelope handling |
| Directory disk snapshot | `common/catalog-snapshot.ts` | invent a cache file |
| Context window editor | `common/ContextWindowEditor.tsx` | custom inputs |

Client and host each keep a **hand-written route table**, mirrored by comment. They must be checked
against each other at the end of the integration wave: a mismatch surfaces as a 404 at runtime.

## 5. Traps this repo has already paid for

### 5.1 A sign-in opens the authorization page exactly once

The settings card calls `window.open` on the authorize URL. If the host also opens it from
`/login/start`, every sign-in shows two identical pages. **The host must answer the URL and launch
nothing** (default the route's `openBrowser` to a no-op; keep a named exported opener for
deployments that want the host to launch). `test/login-opens-browser-once.test.ts` pins this for
Claude, Command Code and GLM — add your line to it rather than repeating the bug.

### 5.2 "Process has not started a flow" is not "not signed in"

A flow state machine is process-local: after a host restart it is `idle` while the pool still holds
accounts. Rendering "no sign-in started yet" next to a populated account list is a lie the user
sees immediately. Render **three states**: `idle` + accounts → "the pool already holds N";
`idle` + empty pool → "not signed in yet"; everything else unchanged. Never fabricate `complete`.

### 5.3 A 200 response can still carry no credential

Check the **shape**, not just the status. One upstream answered
`{"accessToken":{"raw":"…"},"refreshToken":{"raw":"…"}}` while the reader only accepted a string,
so a perfectly good HTTP 200 was reported as "no token". Read nested objects, and when a token is a
pair, note which half carries the claim you need to echo back in a header.

### 5.4 Discriminate on payload shape, not on a version field

When an endpoint serves two generations of payload, decide from what the payload **contains**. A
version/`plan_family`-style field can lag the shape change, and trusting it renders the wrong UI
(e.g. a window-based meter for an account that is actually on a credit pool).

### 5.5 Zero is not "unknown"

Absent means "not known yet"; a transmitted `0` means "measured as zero". A hit rate whose
denominator is 0 must render a placeholder, never `0%`. The same rule applies to a cost column on a
line whose upstream publishes no prices: show tokens, or show nothing — never a fabricated amount.

### 5.6 Schema defaults can erase a tri-state

If a settings schema normalizes a missing array to `[]`, "unset" and "empty" become the same value.
A multi-select list wants **three** states — unset, empty, explicit — and `z.array()` can only hold
two. Declare the third explicitly (`z.union([z.array(z.string()), z.const(null)]).default(null)`)
rather than writing a comment that the runtime does not honour.

**Never take "unset means no filter, so the shipped default is `[]`" as the easy way out.** That
advice reads fine until someone wants "none selected" to mean none, at which point the same `[]`
means the opposite and §5.11 becomes mandatory.

The client half of this is easy to miss: the shared checklist's "clear all" used to disable itself
once the count reached zero, which is exactly the state a broken tri-state produces — the button
looked inert rather than wrong, and the bug stayed invisible. A control that disables itself in a
suspicious state hides that state.

### 5.7 Do not restructure the DOM a test selects through

See §6.6 — it is stated once, with the UI rules it belongs to. Moving a control out of its container
to make a row prettier breaks the tests, and the fix is the markup, not the test.

### 5.8 The shared kernel is append-only

`model-request-control.ts` owns a single-line literal array; `request-diagnostics.ts` a union list.
Appending an id rewrites that one line — that is not "editing someone else's logic". Anything beyond
an append means the change belongs in your own directory instead.

### 5.9 A catalog snapshot must be written and read by the same codec

`common/catalog-snapshot.ts` persists whatever you hand it and parses it back with the function you
hand it. Those two are the whole contract, and nothing checks that they are inverses. Qoder's snapshot
wrote raw upstream records (`{ key, display_name, context_config }`) and read them back with the
parser for the **live listing envelope** (`{ chat: [...] }`), so every snapshot parsed to `[]`, was
judged "no usable snapshot", and was discarded. The file was always present and always correct; the
rehydration path had simply never once succeeded, which made every cold start begin from the bundled
table.

Write the pair together and test them as a pair. `persistedQoderModelRecord` /
`parsePersistedQoderModelEntries` in `host/qoder/model-catalog.ts` is the shape to copy.

**Write the test with the production serializer, never with hand-written JSON.** A hand-built fixture
proves that the fixture round-trips; it cannot prove that what the writer emits is what the reader
accepts. The hand-written version passed while the real path was broken.

### 5.10 A whitelist and a fallback table are not the same id vocabulary

The user's checked-model list is captured against the **live catalog** (ids derived from upstream
`display_name`). The shipped fallback table mirrors a vendor's static list. For the same model the two
can disagree, and nothing makes them agree:

| live catalog (what the user ticked) | bundled fallback |
|---|---|
| `DeepSeek-Flash` | `DeepSeek-V4-Flash` |
| `Qwen3.8-Flash` | `Qwen3.8-Max` / `Qwen3.7-Plus` |

So **never filter the fallback table through the whitelist.** On a cold start there is no live catalog,
the intersection is empty, `listModels` returns zero models, and the harness drops the entire provider
group — the line vanishes from the model picker with no error anywhere. Filter only when the catalog is
live; treat the fallback as an unfiltered placeholder. An explicit "everything off" (`[]`) still wins
in both phases, because that intent does not depend on a vocabulary.

Grep for it before you ship: `listModels`, the settings-card enabled flags, and the hub model counts
must all read one shared rule (`convergeQoderSelection`), not three private ones.

### 5.11 Changing a default that is already on disk is a migration, not an edit

If the old shipped default was `[]` and you change `[]` to mean "all off", every existing install
reads its stored default as a deliberate choice and ends up with **zero models**. The old Qoder
`defaultQoderModelSettings()` returned `[...DEFAULT_VISIBLE_MODEL_IDS]` and that constant was `[]`, so
this was true for literally every user.

Ship a version marker in the same document (`selectionVersion`), treat "no marker" as the old
semantics, rewrite once, and write the marker back. Three rules:

1. **The migration must be idempotent.** The marker is what stops a genuine all-off from being flipped
   back on the next read.
2. **The marker's schema default must be the OLD version, not the current one.** A register-backed
   backend that defaults it to the current version declares stale documents as already-migrated —
   the same upgrade-breaks-everyone bug, just on the other storage path.
3. **Both backends must share one parser.** Qoder had a file store and a `settings.register` scope
   with separate value-shaping code; fixing one left the other broken.

The decision is worth an explicit note in `CHANGELOG.md`: users need to know their previous selection
was reinterpreted, not lost.

### 5.12 A refresh that changes the catalog must announce it, and a cold start must not wait

Two halves of one user-visible symptom ("the line is missing / stale until I open the settings page"):

- **Announce.** Updating the in-process catalog does nothing for a picker that has already read a
  snapshot. Emit `llm/adapters-updated` — but **only when the catalog actually changed**. Emitting on
  every 60-second status poll rebuilds the picker continuously. Compare an id-sequence fingerprint
  before and after; compare the array by content, because a cache hit returns the *same array* and a
  reference comparison never sees a change.
- **Warm.** Do not let the first read wait on the network. Rehydrate the persisted snapshot at startup
  (a local read, milliseconds) and let the upstream refresh run behind it. `void warm...().catch(() => undefined)`
  — never `await` it in plugin setup, and never let its failure bubble into plugin loading.

Put the automatic refresh **behind** the status answer (`QuotaRefresh.start`, not `run`) and call it
with `force: false` so the catalog TTL and in-flight deduplication still apply. A status route that
awaits a network catalog read turns a 60-second poll into a load test.

One more thing worth copying: have the warm-up **return the post-rehydration fingerprint**. If the
caller computes its own baseline first, it gets the pre-rehydration (empty) catalog, concludes the
catalog always changed, and emits unconditionally on every start.

## 6. UI coherence: a new line must look like it belongs to the set

A line whose card has its own layout language reads as a different product bolted on. Every card in
this plugin is the **same shape**: a title row (heading + action buttons), one quiet line, the
content, then an optional collapsed "more" block. Match it; do not invent a second one.

### 6.1 The card skeleton

| Part | Rule |
|---|---|
| Section container | `<section className="dsha-group">` with a `<div className="dsha-grouphead">` holding `<h3>` + actions. Never a bespoke wrapper. |
| Actions in the heading | At most **two** buttons. `.dsha-grouphead` is `justify-content:space-between`; a third wraps and breaks the row. If you need more entry points, demote one to a preference (a `<select>` in a `.dsha-pref-row`) or move it into the content. |
| Login entries | Live in the **account card's heading row**, through `AccountPoolSection`'s `renderLoginActions`. There is **no separate "Sign-in" section** — a second section for the same job is the single most common way a new card looks heavier than the rest. |
| Sign-in progress | Temporary content: render the `pending` / `complete` / `error` block **only when it exists**. At `idle` it must contribute zero height, so the resting card is just "heading + list". |
| Empty state | One `.dsha-empty` line. |
| Extra explanation | `<details className="dsh-...-details">` collapsed under the content, never a fourth grey paragraph under the heading. |

### 6.2 Typography and density

- **One quiet line under a heading at most.** If two or three sentences are needed, one stays and the
  rest move into the collapsed block or beside the control they explain. "Shorter" and "collapsed"
  are allowed; "deleted" is not — these sentences usually say *why a number is missing*.
- **A row value never wraps.** `.dsha-value` is single-line. If it would wrap, the sentence does not
  belong in that row — move it out rather than shrinking the font.
- **Test before adding a sentence**: does it change what the user should do, believe, or expect? If
  not, it belongs in the collapsed block, not on the card.
- Amounts that the upstream does not publish are **never fabricated**: show tokens, or show nothing.
  A `0` produced by an unpublished price is worse than an empty cell.

### 6.3 Reuse the shared visual vocabulary

Model rows (`common/ModelChecklist.tsx`), account cards and their quota bars
(`common/AccountPoolSection.tsx` + `common/styles.ts`), the composer badge
(`common/ComposerQuotaBadge.tsx`), the context-window editor, and the `.dsha-*` primitives are
already themed. A new line adds **only** its own prefixed classes (`.dsh<abbrev>-*`) for what nothing
else has, and declares no shared class twice.

### 6.4 Do not duplicate one fact in two places

If the checked-model list already shows a model's capabilities, do not render a second capability
block underneath. A duplicated fact costs height, drifts apart, and reads as two features. Keep the
single most useful presentation and delete the other.

### 6.5 Pin the shape with an assertion

A screenshot is not a guard. Assert the structural facts your card depends on — e.g. that the removed
section is gone (`expect(node.textContent).not.toContain(<heading>)`), that the heading row holds
exactly two buttons, that a `0`-denominator rate renders the placeholder and not `0%`. Without an
assertion the next person adds the section back.

### 6.6 Changing a card the tests select through

UI tests here locate controls by class and container (`x.querySelector('.dshglm-paste button[aria-expanded]')`).
Restructuring the markup to "look tidier" can break them, and the correct response is to **fix the
markup** (keep the control inside the container the test names) rather than relax the test. Read that
line's test file before restyling its card.

### 6.7 Use the vendor's official mark, not a letter

Every card in this set carries the vendor's real artwork; a monogram tile reads as an unfinished
placeholder next to them. Fetch the vendor's own icon (usually the `<link rel="icon">` target on their
home page), inline it as a data URI on `ProviderBrand.image` with `fit`, and record the provenance in
the entry: the URL, the fetch date, the byte count and the sha256.

Three rules, learned the hard way:

1. **Never infer the icon from a URL's response size.** Qoder's `/favIcon.svg` answered with the whole
   HTML page (73 KB), and an earlier note concluded "the icon is 73 KB, too large to inline". A size
   that large for an SVG is a symptom of the request returning something that is not the icon: check
   the `Content-Type` / the first bytes, and follow the `<link rel="icon">` the page actually uses.
2. **Delete the old monogram, do not keep it as a fallback.** A leftover `monogram` string in the entry
   makes it ambiguous which one is the brand, and a future reader will "restore" it.
3. **Pin it with an assertion**, e.g. the card renders a data URI and no longer contains
   `dsh-hub-brand-mono`. A screenshot cannot stop the next person from reverting to a letter.

If the vendor really ships no usable mark, say so in a comment with what you looked at — that is a
different statement from "a letter looks fine here".

## 7. Verification

The line is done when all of these pass, and the recorded baseline is unchanged except for your
line's own additions:

```bash
npx tsc -b --pretty false                        # host + client
npx tsc -p test/tsconfig.json --pretty false     # tests
npx vitest run                                   # full suite
npm run build && npm pack --dry-run              # the line ships, and its types are in the tarball
git diff --numstat src/host/common/ src/client/common/   # must show only append-only hunks
```

Record the **baseline counts** before starting (`test files / tests passed`) and compare after; a
line that adds features while dropping tests is a regression that looks like progress.

Three verification habits this repo paid for the hard way:

- **Prove the guard can fail.** Flip the implementation back to the broken version and watch the new
  test go red before you accept it as green. A regression test that passes against both versions is
  decoration. (`expected 0 to be greater than 0` was the Qoder cold-start guard failing correctly.)
- **Run the real artifact, not a reconstruction.** Where a file someone else wrote is involved (a
  persisted snapshot, a credentials file, a settings document), test against a real one or one written
  by the production writer. Hand-built fixtures pass while the real path is broken.
- **Re-read the response, do not just start the process.** After fixing a host-side bug, restart the
  host and check the actual payload (`curl` the route, read the JSON) for a field only the new code
  emits. A rebuilt bundle is not a loaded bundle, and "it works now" without that check is a guess.

For a visual change, the durable guard is an assertion, not a screenshot: assert that the removed
section is gone (`expect(node.textContent).not.toContain(<heading>)`), so the next person cannot
reintroduce it silently.

## 8. What to write down

- `docs/<line>-line-plan.md` — the evidence for every upstream constant (URL or `file:line`), the
  decisions taken, and a **risks / left-unverified** section.
- `README.md` — a line in the overview table, a section stating what the line can and cannot do,
  and any licensing or non-public-endpoint risk in plain language.
- `CHANGELOG.md` — one entry under `## Unreleased`.
- `docs/provider-protocol-test-matrix.md` — a row for the line.
- The plan's "left unverified" list is the first thing the next person should read. Keep it honest.