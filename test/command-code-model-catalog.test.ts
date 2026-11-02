import { describe, expect, it } from 'vitest'
import officialCatalog from './fixtures/command-code/official-model-catalog.json'
import { COMMAND_CODE_MODELS, commandCodeModelDef } from '../src/host/command-code/model-catalog.ts'
import {
  FALLBACK_MODELS,
  declaredMaxOutputTokens,
  inputModalitiesFor,
  reasoningEffortsFor,
} from '../src/host/command-code/types.ts'

interface OfficialModel {
  id: string
  name: string
  inputModalities: string[]
  reasoningEfforts: string[] | null
  contextWindow: number | null
  maxOutputTokens: number | null
  hidden: boolean
}

interface OfficialFixture {
  source: {
    package: string
    version: string
    artifact: string
    catalogVersion: string
  }
  redaction: string
  models: OfficialModel[]
}

const fixture = officialCatalog as unknown as OfficialFixture

describe('Command Code model catalog against the official registry', () => {
  it('pins the official baseline this table was transcribed from', () => {
    // The fixture is the redacted snapshot of the registry the official CLI
    // embeds. It is the independent half of the parity check: the table in
    // src/ is a transcription, and this is what it has to match.
    expect(fixture.source.package).toBe('command-code')
    expect(fixture.source.version).toBe('1.88.2')
    expect(fixture.source.artifact).toBe('dist/cli.mjs')
    expect(fixture.source.catalogVersion).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.models.length).toBeGreaterThan(0)
  })

  it('carries every model the official registry declares, in registry order', () => {
    expect(COMMAND_CODE_MODELS.map((model) => model.id)).toEqual(fixture.models.map((model) => model.id))
  })

  it('matches the official registry field by field', () => {
    for (const official of fixture.models) {
      const entry = commandCodeModelDef(official.id)
      expect(entry, `the table is missing ${official.id}`).toBeDefined()
      expect(entry?.name).toBe(official.name)
      expect(entry?.inputModalities).toEqual(official.inputModalities)
      expect(entry?.reasoningEfforts).toEqual(official.reasoningEfforts ?? [])
      expect(entry?.contextWindow).toBe(official.contextWindow)
      expect(entry?.maxTokens).toBe(official.maxOutputTokens)
      expect(entry?.hidden).toBe(official.hidden)
    }
  })

  it('names every model once', () => {
    const ids = COMMAND_CODE_MODELS.map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares an output cap exactly where the official registry declares one', () => {
    const declared = COMMAND_CODE_MODELS.filter((model) => model.maxTokens !== null)
    expect(declared.map((model) => model.id)).toEqual(
      fixture.models.filter((model) => model.maxOutputTokens !== null).map((model) => model.id),
    )
    // Ten of the registry's models carry a cap; the rest say the provider
    // decides, and the plugin must not invent one for them.
    expect(declared.length).toBe(10)
    for (const model of declared) {
      expect(declaredMaxOutputTokens(model.id)).toBe(model.maxTokens)
    }
  })

  it('covers the models the previous table omitted', () => {
    // Regression: the table this one replaces left these out, so each of them
    // fell back to text-only with no reasoning ladder.
    for (const id of [
      'claude-haiku-5-5',
      'gpt-6.1-terra',
      'moonshotai/Kimi-K3.1-Pro',
      'minimax/minimax-m3.1-flash',
      'ornith/ornith-1.5-122b',
      'Qwen/Qwen3.8-Max-Prime',
      'google/gemini-4-argon',
      'nvidia/nemotron-3.5-super-vl',
      'stealth/glyph-cluster:free',
      'reflection/beam:free',
      'inclusionai/ling-3.1-flash',
      'meta/muse-spark-open',
      'meta/muse-wonder-1.0',
      'mistral/mistral-large-4',
    ]) {
      expect(commandCodeModelDef(id), `${id} is missing`).toBeDefined()
    }
  })

  it('drops the models the official registry no longer lists', () => {
    expect(commandCodeModelDef('inclusionai/ling-3.0-flash-sante:free')).toBeUndefined()
  })

  it('keeps the registry spelling of the disabled level and translates it at the boundary', () => {
    // The table stays a faithful transcription: Command Code spells the level
    // `off`, DSH spells it `none`.
    expect(commandCodeModelDef('deepseek/deepseek-v4.1-flash')?.reasoningEfforts).toEqual(['off', 'low', 'high', 'max'])
    expect(reasoningEffortsFor('deepseek/deepseek-v4.1-flash')).toEqual(['none', 'low', 'high', 'max'])
  })

  it('narrows the registry file modality away at the harness boundary', () => {
    // The registry declares `file` for one model. DSH's modality vocabulary has
    // no counterpart for it and this route sends no file parts.
    expect(commandCodeModelDef('meta/muse-wonder-1.0')?.inputModalities).toEqual(['text', 'image', 'file'])
    expect(inputModalitiesFor('meta/muse-wonder-1.0')).toEqual(['text', 'image'])
  })

  it('does not offer a hidden model in the offline fallback', () => {
    // A model the official catalog hides is not in the live listing either.
    const hidden = fixture.models.filter((model) => model.hidden).map((model) => model.id)
    expect(hidden.length).toBeGreaterThan(0)
    for (const id of hidden) {
      expect(FALLBACK_MODELS.some((model) => model.id === id), `${id} is offered`).toBe(false)
    }
  })

  it('offers every visible model in the offline fallback', () => {
    const visible = fixture.models.filter((model) => !model.hidden).map((model) => model.id)
    expect(FALLBACK_MODELS.map((model) => model.id)).toEqual(visible)
  })
})
