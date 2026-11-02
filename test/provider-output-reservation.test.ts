import { afterEach, describe, expect, it, vi } from 'vitest'
import { outputReservation } from '../src/host/common/output-reservation.ts'
import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import { FALLBACK_MODELS as COMMAND, declaredMaxOutputTokens as commandCap } from '../src/host/command-code/types.ts'
import { COMMAND_CODE_MODELS } from '../src/host/command-code/model-catalog.ts'
import { ClaudeAdapter } from '../src/host/claude/adapter.ts'
import { CLAUDE_MODELS } from '../src/host/claude/model-catalog.ts'
import { GlmCodingPlanAdapter } from '../src/host/glm-coding-plan/adapter.ts'
import { GLM_MODEL_CATALOG as GLM } from '../src/host/glm-coding-plan/model-catalog.ts'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { MODELS as ANTIGRAVITY } from '../src/host/antigravity/types.ts'
import { OllamaAdapter } from '../src/host/ollama/adapter.ts'
import { resolveCodexModel } from '../src/host/model-catalog.ts'
import { CODEX_MODEL_CATALOG, codexModelMaxTokens } from '../src/shared/model-catalog.ts'
import { FileModelSettingsStore as AntigravitySettings } from '../src/host/antigravity/token-store.ts'

afterEach(() => vi.restoreAllMocks())

/**
 * One provider line's row in the table below.
 *
 * `cap` is the output cap the provider OFFICIALLY declares. `undefined` means
 * the provider declares none at all: that cap belongs to the provider, so the
 * host reserves nothing and publishes no default for such a model.
 */
interface ProviderRow {
  provider: string
  model: string
  window: number
  cap: number | undefined
}

function valid(window: number, cap: number) {
  const budget = window - cap
  return Math.floor(Math.min(window * 0.8, budget - 65_536)) > Math.floor(budget * 0.16)
    && budget > 65_536
}

/**
 * What one row publishes as its fixed output reservation.
 *
 * A row whose provider declares no cap reserves nothing - not even a default
 * the host made up - and a declared cap is published only while it still fits
 * DSH's compaction headroom.
 */
function reserved(row: ProviderRow): number | undefined {
  if (row.cap === undefined) return undefined
  return valid(row.window, row.cap) ? row.cap : undefined
}

const rows: ProviderRow[] = [
  ...COMMAND.map(m => ({ provider: 'command', model: m.id, window: m.contextWindow, cap: commandCap(m.id) })),
  ...CLAUDE_MODELS.map(m => ({ provider: 'claude', model: m.id, window: m.contextWindow, cap: m.maxTokens })),
  ...GLM.map(m => ({ provider: 'glm', model: m.id, window: m.defaultContextWindow, cap: m.defaultMaxTokens })),
  ...ANTIGRAVITY.map(m => ({ provider: 'antigravity', model: m.id, window: m.contextWindow, cap: m.maxTokens })),
  ...CODEX_MODEL_CATALOG.map(m => ({ provider: 'codex', model: m.id, window: m.contextWindow, cap: codexModelMaxTokens(m.id) })),
  ...[80_000, 128_000, 262_144].map(window => ({ provider: 'ollama', model: 'live-model', window, cap: 8192 })),
]

async function resolve(row: ProviderRow, window = row.window) {
  const settings = { enabled: true, enabledModelIds: [row.model], catalogModels: [],
    contextWindowOverrides: { [row.model]: window }, defaultReasoningEffort: null }
  if (row.provider === 'codex') return resolveCodexModel(row.model, { status: () => settings } as never)
  if (row.provider === 'antigravity') {
    const store = new AntigravitySettings()
    vi.spyOn(store, 'read').mockResolvedValue(settings)
    return new AntigravityAdapter(undefined, store).resolveModel('antigravity', row.model)
  }
  const adapter = row.provider === 'command' ? new CommandCodeAdapter()
    : row.provider === 'claude' ? new ClaudeAdapter()
      : row.provider === 'glm' ? new GlmCodingPlanAdapter() : new OllamaAdapter()
  // Isolate metadata resolution from disk, credentials and network. Real methods
  // under test are resolveModel/prepareCall, including every provider boundary.
  const seam = adapter as any
  if (row.provider !== 'ollama') vi.spyOn(seam, 'settings').mockResolvedValue(settings)
  if (row.provider === 'command') vi.spyOn(seam, 'catalog').mockResolvedValue(COMMAND)
  if (row.provider === 'claude') vi.spyOn(seam, 'primaryAccount').mockResolvedValue(null)
  if (row.provider === 'glm') vi.spyOn(seam, 'credentialFor').mockResolvedValue(null)
  if (row.provider === 'ollama') vi.spyOn(seam, 'catalog').mockResolvedValue([{ id: row.model, contextWindow: window }])
  return (await adapter.prepareCall(row.provider, row.model)).model
}

describe('all provider fixed output reservations', () => {
  it.each(rows)('$provider/$model keeps safe defaults and omits unsafe reservations', async row => {
    const info = await resolve(row)
    expect(info.context?.contextWindow).toBe(row.window)
    expect(info.defaultMaxTokens).toBe(reserved(row))
    if (valid(row.window, 0)) expect(valid(row.window, info.defaultMaxTokens ?? 0)).toBe(true)
  })

  it.each(['command', 'claude', 'glm', 'antigravity', 'codex', 'ollama'])(
    '%s handles a smaller effective window without inventing capacity', async provider => {
      const row = rows.find(r => r.provider === provider)!
      const window = 80_000
      const info = await resolve(row, window)
      expect(info.context?.contextWindow).toBe(window)
      expect(info).not.toHaveProperty('defaultMaxTokens')
      expect(valid(window, 0)).toBe(true)
    })

  it('checks retention as well as positive pressure, including the exact boundary', () => {
    expect(outputReservation(200_000, 128_000)).toEqual({})
    expect(outputReservation(262_144, 184_124)).toEqual({ defaultMaxTokens: 184_124 })
    expect(outputReservation(262_144, 184_125)).toEqual({})
    expect(outputReservation(384_000, 128_000)).toEqual({ defaultMaxTokens: 128_000 })
  })

  it('does not pretend omission can repair a window smaller than DSH headroom', () => {
    expect(outputReservation(65_536, 8192)).toEqual({})
    expect(valid(65_536, 0)).toBe(false)
  })
})

describe('command line output reservations', () => {
  // The official registry is the only authority for which models declare a
  // cap, so every entry it carries is checked here - including the ones the
  // picker hides - and a catalog refresh cannot quietly change the contract.
  const commandRows: ProviderRow[] = COMMAND_CODE_MODELS.flatMap(model =>
    model.contextWindow === null
      ? []
      : [{ provider: 'command', model: model.id, window: model.contextWindow, cap: commandCap(model.id) }],
  )

  it.each(commandRows)('$model reserves only the officially declared cap', async row => {
    const info = await resolve(row)
    expect(info.context?.contextWindow).toBe(row.window)
    if (row.cap === undefined) {
      // The registry declares no cap, so the provider decides it: the host
      // publishes no default at all instead of a number nobody published.
      expect(info.defaultMaxTokens).toBeUndefined()
      expect(info).not.toHaveProperty('defaultMaxTokens')
    } else {
      // A declared cap is published exactly as the shared reservation rule says.
      const expected = outputReservation(row.window, row.cap).defaultMaxTokens
      expect(info.defaultMaxTokens).toBe(expected)
      if (expected === undefined) expect(info).not.toHaveProperty('defaultMaxTokens')
    }
  })
})
