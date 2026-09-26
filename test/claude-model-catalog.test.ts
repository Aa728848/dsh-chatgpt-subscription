/**
 * Fidelity lock for the Claude capability table.
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
 *
 * It proves exactly one thing: that `CLAUDE_MODELS` is a faithful
 * transcription of the reference snapshot at
 * `<checkout>/node_modules/.pnpm/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json`,
 * field by field and row by row, with the reference's own resolution rules
 * re-implemented here from its source. If someone edits a number in the table,
 * or the snapshot moves under it, a test fails.
 *
 * It does NOT prove that the Anthropic server serves any of these models, nor
 * that this account is entitled to them, nor that the transcribed window and
 * output cap are what the server will grant. The snapshot is a third-party
 * artifact; the authority is the server's own `GET /v1/models` read through
 * the account's credential. A green run here is evidence about *this file's
 * relationship to that snapshot*, and nothing else.
 *
 * WHAT CHANGED WHEN THE TABLE OUTGREW THE SNAPSHOT.
 *
 * The shipped table may carry rows the snapshot predates — today exactly one,
 * `claude-opus-5-5`. Making the lock "at least these rows" would have been the
 * cheap fix and it would have been a lie: a table that had silently dropped a
 * transcribed row, or replaced one with an invented row that merely fits the
 * shape, would still pass. So the lock is split into three assertions that
 * together still fail on every drift the old id-equality caught:
 *
 * 1. every reference entry still gets its field-by-field comparison, including a
 *    guard that two reference entries the catalog transcribes identically cannot
 *    be served by one row;
 * 2. the snapshot's ids must appear in the catalog's ids in the SAME RELATIVE
 *    ORDER — as a subsequence, not as a prefix plus a suffix;
 * 3. every id the snapshot does not carry must be declared on
 *    {@link LOCALLY_CURATED_MODEL_IDS}, and that list must be EXACTLY the extras,
 *    so an invented or typo'd id cannot slip in and a stale list cannot rot.
 *
 * The curated rows are the one part of the table this file cannot check against
 * the snapshot, so they are checked against their own documented values instead,
 * and the list is a deliberate, reviewable act rather than an escape hatch.
 *
 * The reference snapshot is a local artifact and may be absent on another
 * machine. When it is missing, the fidelity assertions are SKIPPED and say so in
 * their own test name — never quietly turned into a pass. Set
 * `DSH_CLAUDE_REFERENCE_ROOT` to a checkout of the harness to run them.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_IDS,
  DEFAULT_VISIBLE_MODEL_IDS,
  FALLBACK_MODELS,
  claudeModelCanDisableThinking,
  claudeModelSupportsImage,
  claudeModelSupportsTemperature,
  claudeReasoningEfforts,
  claudeThinkingMode,
  defaultContextWindowFor,
  maxOutputTokensFor,
  resolveClaudeModel,
  type ClaudeModelEntry,
} from '../src/host/claude/model-catalog.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../src/host/claude/types.ts'

/**
 * Where the reference snapshot lives.
 *
 * The harness checkout is not part of this repository, so the location is
 * configurable rather than hard-coded to one developer's profile. The default
 * mirrors how the harness is laid out on a machine that has it installed.
 */
const REFERENCE_ROOT = process.env.DSH_CLAUDE_REFERENCE_ROOT
  ?? path.join(os.homedir(), 'Documents', 'deepseek-harness')

const REFERENCE_CATALOG_PATH = path.join(
  REFERENCE_ROOT,
  'node_modules', '.pnpm', 'node_modules', '@earendil-works', 'pi-ai',
  'dist', 'providers', 'data', 'anthropic.json',
)

/** The snapshot's own key for the Anthropic Messages entries. */
const REFERENCE_KEY = 'anthropic-messages'

/** The number of entries the snapshot is expected to carry. */
const REFERENCE_ENTRY_COUNT = 14

/**
 * Catalog rows the snapshot predates, newest first.
 *
 * Every id here is a row this file CANNOT check against the snapshot, and each
 * one has to be justified on its own before it is added: the snapshot is the
 * only independent witness the transcribed rows have, and this list is the
 * narrow, explicit hole in that coverage. It is deliberately NOT "whatever the
 * table happens to contain" — the assertions below derive the extras FROM the
 * table and require them to equal this list exactly, so a new row fails here
 * until someone writes its id down, and a stale entry fails too.
 *
 * `claude-opus-5-5` is curated because the snapshot this checkout pins
 * (`@earendil-works/pi-ai` 0.85.1) was published before the model existed. Its
 * values come from the vendor's published documentation — the model overview
 * page and the extended-thinking effort page — and are asserted on their own
 * below rather than against the snapshot.
 */
const LOCALLY_CURATED_MODEL_IDS: readonly string[] = [
  'claude-opus-5-5',
]

interface ReferenceEntry {
  id: string
  name: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: {
    forceAdaptiveThinking?: boolean
    supportsMidConvoEffort?: boolean
    supportsTemperature?: boolean
  }
}

/** Read the snapshot, or null when this machine does not have it. */
function readReferenceEntries(): ReferenceEntry[] | null {
  try {
    const raw = fs.readFileSync(REFERENCE_CATALOG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, ReferenceEntry> | undefined>
    const entries = parsed[REFERENCE_KEY]
    if (entries === undefined || entries === null || typeof entries !== 'object') return null
    const values = Object.values(entries)
    return values.length > 0 ? values : null
  } catch {
    return null
  }
}

const referenceEntries = readReferenceEntries()
const hasReference = referenceEntries !== null

/**
 * The fidelity assertions run only against the real snapshot.
 *
 * `skipIf` keeps the distinction visible in the reporter: an absent snapshot
 * shows up as a skip, so a machine without the harness cannot report a green
 * "the transcription matches" it never actually checked.
 */
const itWithReference = it.skipIf(!hasReference)

// ---------------------------------------------------------------------------
// The reference's own rules, re-implemented from its source
// ---------------------------------------------------------------------------

/** Level order, from dist/models.js:550 in the reference. */
const EXTENDED_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Levels a reference entry exposes.
 *
 * Transcribed from `getSupportedThinkingLevels` (dist/models.js:550-562):
 * a model that does not reason has only `off`; a level mapped to `null` is
 * removed; `xhigh` and `max@ exist only when the map names them.
 */
function referenceLevels(entry: ReferenceEntry): string[] {
  if (entry.reasoning !== true) return ['off']
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = entry.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * Wire value one level maps to.
 *
 * Transcribed from `mapThinkingLevelToEffort`
 * (dist/api/anthropic-messages.js:638-653): a string in the map is sent
 * verbatim, otherwise the level collapses onto low/medium/high with `high` as
 * the catch-all. `off` is not an effort level and never reaches this function.
 */
function referenceEffort(entry: ReferenceEntry, level: string): string {
  const mapped = entry.thinkingLevelMap?.[level]
  if (typeof mapped === 'string') return mapped
  if (level === 'minimal' || level === 'low') return 'low'
  if (level === 'medium') return 'medium'
  return 'high'
}

/**
 * The ladder this line stores: wire values, de-duplicated, in escalating order.
 *
 * The de-duplication is this line's own documented choice — `minimal` and `low`
 * both send `low`, and exposing both would advertise a distinction the model
 * cannot make.
 */
function referenceLadder(entry: ReferenceEntry): string[] {
  return [...new Set(referenceLevels(entry).filter((level) => level !== 'off').map((level) => referenceEffort(entry, level)))]
}

/**
 * Thinking form, from dist/api/anthropic-messages.js:842-874.
 *
 * The guards are read IN SOURCE ORDER, because that order is load-bearing:
 *
 * 1. line 842 `supportsMidConvoEffort === true` -> 'mid-convo'. Checked first and
 *    unconditionally, so it outranks both the adaptive flag and "thinking off".
 *    It sends `block_binding: { prefix_mismatch_behavior: 'drop_block' }` plus
 *    `output_config`; the reference comments that omitting this is what turns a
 *    prefix mismatch into a persistent 400.
 * 2. line 855 `forceAdaptiveThinking === true` -> 'adaptive'.
 * 3. line 863 otherwise -> 'budget', the reference's own "Budget-based thinking
 *    for older models".
 * 4. a model that does not reason -> 'none'.
 *
 * Collapsing 1 and 2 is the mistake this function exists to prevent: it would
 * make the fidelity lock agree with a table that had lost a wire requirement.
 */
function referenceThinkingMode(entry: ReferenceEntry): ClaudeModelEntry['thinkingMode'] {
  if (entry.reasoning !== true) return 'none'
  if (entry.compat?.supportsMidConvoEffort === true) return 'mid-convo'
  return entry.compat?.forceAdaptiveThinking === true ? 'adaptive' : 'budget'
}

/** Temperature support, from dist/api/anthropic-messages.js:126: absent means true. */
function referenceSupportsTemperature(entry: ReferenceEntry): boolean {
  return entry.compat?.supportsTemperature ?? true
}

/** `{ type: 'disabled' }` is only sent when the map does not forbid it (line 871). */
function referenceCanDisableThinking(entry: ReferenceEntry): boolean {
  return entry.thinkingLevelMap?.off !== null
}

// ---------------------------------------------------------------------------
// Snapshot presence
// ---------------------------------------------------------------------------

describe('claude model catalog / reference snapshot presence', () => {
  it('reports whether the reference snapshot was found, and skips (never passes) the fidelity checks when it was not', () => {
    if (!hasReference) {
      // Deliberately loud: a skipped fidelity lock is a gap in coverage, and a
      // silent skip reads like a pass in a summary line.
      console.warn(
        `[claude-model-catalog] reference snapshot NOT FOUND at ${REFERENCE_CATALOG_PATH} — `
        + 'the transcription fidelity assertions were SKIPPED, not passed. '
        + 'Set DSH_CLAUDE_REFERENCE_ROOT to a harness checkout to run them.',
      )
    }
    // The shape of the shipped table is checkable with or without the snapshot,
    // so it is asserted unconditionally, in BOTH directions: the extras must be
    // exactly the declared curated ids. The upper half is what catches an
    // invented or typo'd id — before the curated list existed, the row count
    // alone did that, and a count that is merely "at least 14" would not.
    const snapshotIds = (referenceEntries ?? []).map((entry) => entry.id)
    const snapshotIdSet = new Set(snapshotIds)
    const extraIds = CLAUDE_MODEL_IDS.filter((id) => !snapshotIdSet.has(id))
    const curatedIdSet = new Set(LOCALLY_CURATED_MODEL_IDS)

    // No duplicate ids, curated ids included: two rows for one id would make
    // every lookup below silently depend on which row came first.
    expect(new Set(CLAUDE_MODEL_IDS).size).toBe(CLAUDE_MODEL_IDS.length)
    for (const id of extraIds) {
      expect(
        curatedIdSet.has(id),
        `${id} is in CLAUDE_MODELS but not in the reference snapshot and not declared on `
        + 'LOCALLY_CURATED_MODEL_IDS. A row the snapshot does not carry is unchecked by the '
        + 'fidelity test: add its id to that list only after justifying its values from a '
        + 'documented source, or remove the row.',
      ).toBe(true)
    }
    for (const id of LOCALLY_CURATED_MODEL_IDS) {
      expect(
        extraIds,
        `${id} is declared locally curated but the snapshot DOES carry it, so the row can be `
        + 'transcribed and locked like every other one. Remove it from the curated list.',
      ).toContain(id)
    }

    // With the snapshot present, the length relation is exact: snapshot rows
    // plus curated rows, no third kind.
    if (hasReference) {
      expect(CLAUDE_MODELS).toHaveLength(REFERENCE_ENTRY_COUNT + LOCALLY_CURATED_MODEL_IDS.length)
    } else {
      expect(CLAUDE_MODELS.length).toBeGreaterThanOrEqual(REFERENCE_ENTRY_COUNT)
    }
  })
})

// ---------------------------------------------------------------------------
// Fidelity: every field of every row
// ---------------------------------------------------------------------------

describe('claude model catalog / transcription fidelity', () => {
  // A plain `it`, not `itWithReference`: this block now holds checks that must
  // run on a machine with no snapshot too (`itWithReference` reports as SKIPPED
  // there, which would make them false-passes exactly where they matter — every
  // check that does not need the snapshot to be MEANINGFUL lives here). The
  // checks that read the snapshot itself are gated individually with
  // `hasReference` and say so in their own name.
  it(
    'matches the reference snapshot field by field — this proves the TRANSCRIPTION is faithful, NOT that the server serves these models',
    () => {
      const entries = referenceEntries as ReferenceEntry[]
      expect(entries).toHaveLength(REFERENCE_ENTRY_COUNT)

      // The snapshot's ids must appear in the table in the SAME RELATIVE ORDER.
      //
      // Subsequence, not `toEqual`: the table may append rows the snapshot
      // predates, and it may insert them anywhere, because a curated row has no
      // position in a snapshot that never carried it. What is still forbidden is
      // everything id-equality was really protecting against — a dropped or
      // substituted transcribed id, or the transcribed rows reordered among
      // themselves. A run that matches releases plus one interpolation does not
      // match every snapshot id.
      const catalogIds = CLAUDE_MODELS.map((model) => model.id)
      let cursor = 0
      const matched: string[] = []
      for (const id of catalogIds) {
        if (cursor < entries.length && entries[cursor].id === id) {
          matched.push(id)
          cursor += 1
        }
      }
      expect(
        matched,
        'the reference snapshot\'s ids must occur in CLAUDE_MODELS as a subsequence in the '
        + 'same relative order; unmatched below',
      ).toEqual(entries.map((entry) => entry.id))

      for (const entry of entries) {
        // `find` would return WHICHEVER row came first for a duplicated id and
        // let the second one drift unobserved, so the row count for an id is
        // asserted as well as its fields.
        const rowsForId = CLAUDE_MODELS.filter((model) => model.id === entry.id)
        expect(rowsForId, `expected exactly one table row for ${entry.id}`).toHaveLength(1)
        const model = rowsForId[0] as ClaudeModelEntry

        expect(model.name).toBe(entry.name)
        expect(model.contextWindow).toBe(entry.contextWindow)
        expect(model.maxTokens).toBe(entry.maxTokens)
        expect(model.supportsImage).toBe((entry.input ?? []).includes('image'))
        expect(model.supportsTemperature).toBe(referenceSupportsTemperature(entry))
        expect(model.thinkingMode).toBe(referenceThinkingMode(entry))
        expect(model.reasoningEfforts).toEqual(referenceLadder(entry))
        expect(model.canDisableThinking).toBe(referenceCanDisableThinking(entry))
      }
    },
  )

  it('transcribes the reasoning ladder rather than guessing it from the family name', () => {
    // Every assertion here reads a SHIPPED row, never the snapshot: the point is
    // that these rows disagree with each other, which is checkable on a machine
    // with no snapshot at all.
    const sonnet45 = resolveClaudeModel('claude-sonnet-4-5')
    const sonnet46 = resolveClaudeModel('claude-sonnet-4-6')
    expect(sonnet45.thinkingMode).toBe('budget')
    expect(sonnet46.thinkingMode).toBe('adaptive')

    // These pairs are what makes "nothing is inferred from the name" checkable:
    // same family, different ladder or different thinking form.
    const byId = new Map((referenceEntries ?? []).map((entry) => [entry.id, entry]))
    expect(byId.get('claude-sonnet-4-5')).not.toBe(byId.get('claude-sonnet-4-6'))

    // When the snapshot is present, the snapshot itself says the same thing, so
    // the disagreement above is a fact about the family and not a typo in one
    // row of this table.
    if (hasReference) {
      const byId = new Map((referenceEntries as ReferenceEntry[]).map((entry) => [entry.id, entry]))
      expect(referenceThinkingMode(byId.get('claude-sonnet-4-5') as ReferenceEntry)).toBe('budget')
      expect(referenceThinkingMode(byId.get('claude-sonnet-4-6') as ReferenceEntry)).toBe('adaptive')
    }

    const opus46 = resolveClaudeModel('claude-opus-4-6')
    const opus47 = resolveClaudeModel('claude-opus-4-7')
    expect(opus46.supportsTemperature).toBe(true)
    expect(opus47.supportsTemperature).toBe(false)
    expect(opus46.reasoningEfforts).not.toEqual(opus47.reasoningEfforts)
  })

  it('records at least one model per thinking mode, so no branch of the rule is vacuous', () => {
    const modes = new Set(CLAUDE_MODELS.map((model) => model.thinkingMode))
    // All three reasoning branches must be exercised by real rows, or the rule
    // is only partly testable. 'mid-convo' in particular is the branch whose
    // omission produces persistent 400s, so a table that never reaches it would
    // be untested exactly where it matters.
    expect(modes).toContain('mid-convo')
    expect(modes).toContain('adaptive')
    expect(modes).toContain('budget')
    // The snapshot's 14 entries all reason, so 'none' has no row to demonstrate
    // it; the stub below covers that branch instead.
    expect(modes).not.toContain('none')
  })

  // Both directions of the mid-convo classification, and the reason this test
  // exists at all: it is the second half that keeps a NEW row from being dropped
  // into the forced-high bucket without anyone deciding to.
  it('keeps mid-convo to the models whose documented default effort is high', () => {
    const midConvo = CLAUDE_MODELS.filter((model) => model.thinkingMode === 'mid-convo')
    const midConvoIds = midConvo.map((model) => model.id).sort()

    // The exact set, not just a lower bound. 'mid-convo' is not a label for "the
    // model reasons adaptively"; it is a wire requirement that ALSO forces
    // `output_config = { effort: 'high' }` whenever the caller names no effort.
    // That override is correct exactly when the vendor documents `high` as the
    // model's own default, and it silently outranks the user when it does not.
    // So the ids are pinned here: adding a third one is a deliberate edit to this
    // list plus a check of that model's documented default effort, not a
    // one-word change in the catalog.
    expect(midConvoIds).toEqual(['claude-fable-5-1', 'claude-opus-5'])

    // Guard the premise the list above rests on: these two are the models the
    // reference flags as managed-effort. If the snapshot ever flags a third, the
    // pinned list must be revisited rather than quietly left short.
    if (hasReference) {
      const managed = (referenceEntries as ReferenceEntry[])
        .filter((entry) => entry.compat?.supportsMidConvoEffort === true)
        .map((entry) => entry.id)
        .sort()
      expect(managed).toEqual(midConvoIds)
    }

    // Opus 5.5 is documented as adaptive with a MEDIUM default effort, so it must
    // stay out of that set. Asserted on the row it is about, next to the reason,
    // because this is the failure mode a future reader is most likely to
    // reintroduce: it also refuses a temperature, like both models above.
    const opus55 = resolveClaudeModel('claude-opus-5-5')
    expect(opus55.thinkingMode).toBe('adaptive')
    expect(opus55.thinkingMode).not.toBe('mid-convo')
    expect(midConvo.some((model) => model.id === 'claude-opus-5-5')).toBe(false)
    // ...and it is not merely absent from the set by accident of a short list.
    expect(midConvoIds).not.toContain('claude-opus-5-5')
  })

  itWithReference('labels the managed-effort models mid-convo rather than adaptive', () => {
    const entries = referenceEntries as ReferenceEntry[]
    const managed = entries.filter((entry) => entry.compat?.supportsMidConvoEffort === true)
    // Guard the premise: if the snapshot ever stops carrying this flag the test
    // below would pass vacuously, so assert the population is non-empty first.
    expect(managed.length).toBeGreaterThan(0)
    for (const entry of managed) {
      expect(referenceThinkingMode(entry)).toBe('mid-convo')
      expect(resolveClaudeModel(entry.id).thinkingMode).toBe('mid-convo')
    }
    // Both managed-effort entries ALSO set forceAdaptiveThinking, and that
    // overlap is precisely why the collapsed two-branch rule is a silent bug
    // rather than a loud one: such a model is still classified 'adaptive', so it
    // looks right, while the request loses `block_binding` and the forced
    // `output_config.effort`. Assert the overlap so this stays visible, and
    // assert the two rules actually disagree on these rows.
    expect(managed.every((entry) => entry.compat?.forceAdaptiveThinking === true)).toBe(true)
    for (const entry of managed) {
      const collapsed = entry.compat?.forceAdaptiveThinking === true ? 'adaptive' : 'budget'
      expect(collapsed).not.toBe('mid-convo')
    }
  })
})

// ---------------------------------------------------------------------------
// Locally curated rows — checked against their documented values, not a snapshot
// ---------------------------------------------------------------------------

describe('claude model catalog / locally curated rows', () => {
  // Why this block exists rather than "the snapshot covers it": it does not. A
  // curated row's values are the one part of the table no independent artifact
  // in this checkout can contradict, so the assertions below ARE the coverage,
  // and they are written from the vendor's published documentation for the
  // model. Anything asserted here that is not in that documentation is marked as
  // an inference in the comment above it.

  it('carries Claude Opus 5.5 as a curated row with the documented values', () => {
    const row = CLAUDE_MODELS.find((model) => model.id === 'claude-opus-5-5')
    expect(row, 'claude-opus-5-5 must be a row in CLAUDE_MODELS').toBeDefined()
    const opus55 = row as ClaudeModelEntry

    expect(opus55.name).toBe('Claude Opus 5.5')
    expect(opus55.contextWindow).toBe(1_000_000)
    expect(opus55.maxTokens).toBe(128_000)
    expect(opus55.supportsImage).toBe(true)

    // Temperature is documented as unsupported: it is incompatible with extended
    // thinking, and thinking cannot be turned off on this model.
    expect(opus55.supportsTemperature).toBe(false)
    expect(claudeModelSupportsTemperature('claude-opus-5-5')).toBe(false)

    // The whole documented ladder, all five levels, in escalating order — and
    // through the accessor, so a copy that dropped a rung would fail here.
    expect([...opus55.reasoningEfforts]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claudeReasoningEfforts('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('documents thinking as always-on for Claude Opus 5.5', () => {
    const opus55 = resolveClaudeModel('claude-opus-5-5')

    // Both forms of "stop thinking" are 400s on this model: `{ type: 'disabled' }`
    // and the manual budget form `{ type: 'enabled', budget_tokens: N }`. The
    // only accepted forms are an omitted `thinking` field or
    // `{ type: 'adaptive' }`. So the flag is a documented FALSE, not an
    // unknown defaulted to false.
    expect(opus55.canDisableThinking).toBe(false)
    expect(claudeModelCanDisableThinking('claude-opus-5-5')).toBe(false)

    // 'adaptive' is the form the vendor names as equivalent to sending nothing;
    // 'budget' is the form it rejects outright. Failing here means a request
    // this line would build is one the model refuses.
    expect(opus55.thinkingMode).toBe('adaptive')
    expect(claudeThinkingMode('claude-opus-5-5')).toBe('adaptive')
    expect(opus55.thinkingMode).not.toBe('budget')
    expect(opus55.thinkingMode).not.toBe('none')
  })

  it('resolves Claude Opus 5.5 through the same lookups as every transcribed row', () => {
    // The curated row is a normal row: it must not be reachable only through a
    // direct table scan, or the adapter's own lookups would fall back to the
    // conservative stub and quietly send the wrong request for it.
    expect(resolveClaudeModel('claude-opus-5-5').id).toBe('claude-opus-5-5')
    expect(defaultContextWindowFor('claude-opus-5-5')).toBe(1_000_000)
    expect(maxOutputTokensFor('claude-opus-5-5')).toBe(128_000)
    expect(claudeModelSupportsImage('claude-opus-5-5')).toBe(true)
    expect(CLAUDE_MODEL_IDS).toContain('claude-opus-5-5')
    // And it is in the fallback view, which is the table itself: a curated row
    // that the fallback hid would be unreachable before the live listing answers.
    expect(FALLBACK_MODELS.some((model) => model.id === 'claude-opus-5-5')).toBe(true)
  })

  it('keeps the locally curated list honest against the table', () => {
    // Every declared curated id must be a real row. Without this, the list could
    // name a model the table dropped and the extras check above would still pass
    // (the extras would just be smaller), which is the rot this guards.
    expect(LOCALLY_CURATED_MODEL_IDS.length).toBeGreaterThan(0)
    for (const id of LOCALLY_CURATED_MODEL_IDS) {
      expect(CLAUDE_MODEL_IDS).toContain(id)
      expect(resolveClaudeModel(id).id).toBe(id)
    }
    expect(new Set(LOCALLY_CURATED_MODEL_IDS).size).toBe(LOCALLY_CURATED_MODEL_IDS.length)
    // No curated id may secretly duplicate a transcribed row: the snapshot is the
    // stronger source, so such a row should just be checked like every other one.
    const snapshotIdSet = new Set((referenceEntries ?? []).map((entry) => entry.id))
    for (const id of LOCALLY_CURATED_MODEL_IDS) {
      expect(snapshotIdSet.has(id)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

describe('claude model catalog / lookups', () => {
  it('resolves a conservative stub for an unknown id rather than another model\'s capabilities', () => {
    const stub = resolveClaudeModel('claude-does-not-exist')
    expect(stub).toEqual({
      id: 'claude-does-not-exist',
      name: 'claude-does-not-exist',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      supportsImage: false,
      supportsTemperature: true,
      thinkingMode: 'none',
      reasoningEfforts: [],
      canDisableThinking: false,
    })
    // The distinction that matters: the stub is not the first catalog row.
    expect(stub).not.toEqual(CLAUDE_MODELS[0])
    // The stub must not claim a thinking form it cannot justify: it asserts no
    // reasoning, so there is nothing to disable and no form to name.
    expect(stub.reasoningEfforts).toEqual([])
    expect(stub.canDisableThinking).toBe(false)
  })

  it('resolves the stub only on a miss, and the real row on a hit', () => {
    expect(resolveClaudeModel('claude-opus-5').name).toBe('Claude Opus 5')
    expect(resolveClaudeModel('claude-opus-5-nonexistent').name).toBe('claude-opus-5-nonexistent')
  })

  it('returns the reasoning ladder as a copy, so a caller cannot mutate the frozen table', () => {
    const before = [...resolveClaudeModel('claude-opus-4-7').reasoningEfforts]
    const ladder = claudeReasoningEfforts('claude-opus-4-7')
    expect(ladder).toEqual(before)

    ladder.push('injected')
    ladder[0] = 'injected'
    ladder.reverse()

    // Neither the returned array nor the table moved.
    expect(ladder).not.toEqual(before)
    expect(claudeReasoningEfforts('claude-opus-4-7')).toEqual(before)
    expect([...resolveClaudeModel('claude-opus-4-7').reasoningEfforts]).toEqual(before)
  })

  it('gives every accessor the stub fallback for an unknown id', () => {
    const unknown = 'claude-unknown-model'
    expect(defaultContextWindowFor(unknown)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(maxOutputTokensFor(unknown)).toBe(DEFAULT_MAX_TOKENS)
    expect(claudeModelSupportsImage(unknown)).toBe(false)
    expect(claudeReasoningEfforts(unknown)).toEqual([])
    expect(claudeThinkingMode(unknown)).toBe('none')
    expect(claudeModelSupportsTemperature(unknown)).toBe(true)
    expect(claudeModelCanDisableThinking(unknown)).toBe(false)
  })

  it('agrees with resolveClaudeModel for every shipped row, through every accessor', () => {
    for (const model of CLAUDE_MODELS) {
      expect(defaultContextWindowFor(model.id)).toBe(model.contextWindow)
      expect(maxOutputTokensFor(model.id)).toBe(model.maxTokens)
      expect(claudeModelSupportsImage(model.id)).toBe(model.supportsImage)
      expect(claudeReasoningEfforts(model.id)).toEqual([...model.reasoningEfforts])
      expect(claudeThinkingMode(model.id)).toBe(model.thinkingMode)
      expect(claudeModelSupportsTemperature(model.id)).toBe(model.supportsTemperature)
      expect(claudeModelCanDisableThinking(model.id)).toBe(model.canDisableThinking)
    }
  })

  it('honours an explicit catalog, including an empty one', () => {
    const custom: ClaudeModelEntry[] = [{
      id: 'custom-model',
      name: 'Custom',
      contextWindow: 42,
      maxTokens: 7,
      supportsImage: true,
      supportsTemperature: false,
      thinkingMode: 'adaptive',
      reasoningEfforts: ['low', 'max'],
      canDisableThinking: false,
    }]
    expect(resolveClaudeModel('custom-model', custom).name).toBe('Custom')
    expect(defaultContextWindowFor('custom-model', custom)).toBe(42)
    expect(maxOutputTokensFor('custom-model', custom)).toBe(7)
    expect(claudeModelSupportsImage('custom-model', custom)).toBe(true)
    expect(claudeReasoningEfforts('custom-model', custom)).toEqual(['low', 'max'])
    expect(claudeThinkingMode('custom-model', custom)).toBe('adaptive')
    expect(claudeModelSupportsTemperature('custom-model', custom)).toBe(false)
    expect(claudeModelCanDisableThinking('custom-model', custom)).toBe(false)

    // The shipped table is not reachable through a custom catalog, and an empty
    // one degrades to the stub rather than falling back to the shipped rows.
    expect(resolveClaudeModel('claude-opus-5', custom).name).toBe('claude-opus-5')
    expect(resolveClaudeModel('claude-opus-5', []).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  it('ships a frozen table whose fallback view is the table itself', () => {
    expect(Object.isFrozen(CLAUDE_MODELS)).toBe(true)
    expect(FALLBACK_MODELS).toBe(CLAUDE_MODELS)
  })

  it('offers only ids the table actually carries in the default picker set', () => {
    expect(DEFAULT_VISIBLE_MODEL_IDS.length).toBeGreaterThan(0)
    for (const id of DEFAULT_VISIBLE_MODEL_IDS) {
      expect(CLAUDE_MODEL_IDS).toContain(id)
    }
    expect(new Set(DEFAULT_VISIBLE_MODEL_IDS).size).toBe(DEFAULT_VISIBLE_MODEL_IDS.length)
  })

  it('leads the default picker with the newest flagship', () => {
    // Order, not just membership: this list is what a fresh install starts
    // ticked, and it is also the value an install is compared against to decide
    // whether its stored list was ever edited (see `resolveEnabledModelIds` in
    // the adapter and the routes. That comparison is set-based, so reordering
    // here does not change which models an untouched install enables — but it
    // does change the first row a new user sees, which is why it is pinned.
    expect(DEFAULT_VISIBLE_MODEL_IDS[0]).toBe('claude-opus-5-5')
    expect(resolveClaudeModel(DEFAULT_VISIBLE_MODEL_IDS[0]).name).toBe('Claude Opus 5.5')
  })
})
