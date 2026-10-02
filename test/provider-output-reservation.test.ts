import { afterEach, describe, expect, it, vi } from 'vitest'
import { outputReservation } from '../src/host/common/output-reservation.ts'
import { CommandCodeAdapter } from '../src/host/command-code/adapter.ts'
import { FALLBACK_MODELS as COMMAND, maxOutputTokensFor as commandCap } from '../src/host/command-code/types.ts'
import { ClaudeAdapter } from '../src/host/claude/adapter.ts'
import { CLAUDE_MODELS } from '../src/host/claude/model-catalog.ts'
import { WorkBuddyAdapter } from '../src/host/workbuddy/adapter.ts'
import { FALLBACK_MODELS as WORKBUDDY } from '../src/host/workbuddy/model-catalog.ts'
import { AntigravityAdapter } from '../src/host/antigravity/adapter.ts'
import { MODELS as ANTIGRAVITY } from '../src/host/antigravity/types.ts'
import { OllamaAdapter } from '../src/host/ollama/adapter.ts'
import { resolveCodexModel } from '../src/host/model-catalog.ts'
import { CODEX_MODEL_CATALOG, codexModelMaxTokens } from '../src/shared/model-catalog.ts'
import { FileModelSettingsStore as AntigravitySettings } from '../src/host/antigravity/token-store.ts'

afterEach(() => vi.restoreAllMocks())

function valid(window: number, cap: number) {
  const budget = window - cap
  return Math.floor(Math.min(window * 0.8, budget - 65_536)) > Math.floor(budget * 0.16)
    && budget > 65_536
}

const rows = [
  ...COMMAND.map(m => ({ provider: 'command', model: m.id, window: m.contextWindow, cap: commandCap(m.id) })),
  ...CLAUDE_MODELS.map(m => ({ provider: 'claude', model: m.id, window: m.contextWindow, cap: m.maxTokens })),
  ...WORKBUDDY.map(m => ({ provider: 'workbuddy', model: m.id, window: m.contextWindow, cap: m.maxTokens })),
  ...ANTIGRAVITY.map(m => ({ provider: 'antigravity', model: m.id, window: m.contextWindow, cap: m.maxTokens })),
  ...CODEX_MODEL_CATALOG.map(m => ({ provider: 'codex', model: m.id, window: m.contextWindow, cap: codexModelMaxTokens(m.id) })),
  ...[80_000, 128_000, 262_144].map(window => ({ provider: 'ollama', model: 'live-model', window, cap: 8192 })),
]

async function resolve(row: typeof rows[number], window = row.window) {
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
      : row.provider === 'workbuddy' ? new WorkBuddyAdapter() : new OllamaAdapter()
  // Isolate metadata resolution from disk, credentials and network. Real methods
  // under test are resolveModel/prepareCall, including every provider boundary.
  const seam = adapter as any
  if (row.provider !== 'ollama') vi.spyOn(seam, 'settings').mockResolvedValue(settings)
  if (row.provider === 'command') vi.spyOn(seam, 'catalog').mockResolvedValue(COMMAND)
  if (row.provider === 'claude') vi.spyOn(seam, 'primaryAccount').mockResolvedValue(null)
  if (row.provider === 'workbuddy') vi.spyOn(seam, 'credentials').mockResolvedValue(null)
  if (row.provider === 'ollama') vi.spyOn(seam, 'catalog').mockResolvedValue([{ id: row.model, contextWindow: window }])
  return (await adapter.prepareCall(row.provider, row.model)).model
}

describe('all provider fixed output reservations', () => {
  it.each(rows)('$provider/$model keeps safe defaults and omits unsafe reservations', async row => {
    const info = await resolve(row)
    expect(info.context?.contextWindow).toBe(row.window)
    expect(info.defaultMaxTokens).toBe(valid(row.window, row.cap) ? row.cap : undefined)
    if (valid(row.window, 0)) expect(valid(row.window, info.defaultMaxTokens ?? 0)).toBe(true)
  })

  it.each(['command', 'claude', 'workbuddy', 'antigravity', 'codex', 'ollama'])(
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
