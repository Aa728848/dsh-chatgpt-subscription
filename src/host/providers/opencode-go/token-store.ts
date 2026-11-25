import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { dshHomeDir } from '../../common/home.ts'
import { mergeContextWindowOverrides, type ContextWindowOverridePatch } from '../../common/context-window-overrides.ts'
import { isOpenCodeGoReasoningEffort, type OpenCodeGoReasoningEffort, type OpenCodeGoSettingsUpdateDto } from '../../../shared/opencode-go-contracts.ts'
import type { OpenCodeGoCredentials } from './types.ts'

export interface OpenCodeGoSettings {
  enabled: boolean
  enabledModelIds: string[] | null
  contextWindowOverrides: Record<string, number>
  defaultReasoningEffort: OpenCodeGoReasoningEffort | null
  selectedAccountId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOpenCodeGoCredentials(value: unknown): OpenCodeGoCredentials {
  if (!isRecord(value)) throw new Error('OpenCode Go credential payload is invalid')
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
  if (apiKey === '') throw new Error('OpenCode Go API key is required')
  return {
    apiKey,
    authenticatedAt: typeof value.authenticatedAt === 'number' && Number.isFinite(value.authenticatedAt) ? value.authenticatedAt : Date.now(),
  }
}

export function defaultOpenCodeGoSettings(): OpenCodeGoSettings {
  return { enabled: true, enabledModelIds: null, contextWindowOverrides: {}, defaultReasoningEffort: null, selectedAccountId: null }
}

export function parseOpenCodeGoSettings(value: unknown): OpenCodeGoSettings {
  const fallback = defaultOpenCodeGoSettings()
  if (!isRecord(value)) return fallback
  const overrides: Record<string, number> = {}
  if (isRecord(value.contextWindowOverrides)) {
    for (const [id, raw] of Object.entries(value.contextWindowOverrides)) {
      if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) overrides[id] = raw
    }
  }
  return {
    enabled: value.enabled !== false,
    enabledModelIds: Array.isArray(value.enabledModelIds)
      ? [...new Set(value.enabledModelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map(id => id.trim()))]
      : null,
    contextWindowOverrides: overrides,
    defaultReasoningEffort: isOpenCodeGoReasoningEffort(value.defaultReasoningEffort) ? value.defaultReasoningEffort : null,
    selectedAccountId: typeof value.selectedAccountId === 'string' && value.selectedAccountId !== '' ? value.selectedAccountId : null,
  }
}

export function mergeOpenCodeGoSettings(current: OpenCodeGoSettings, patch: OpenCodeGoSettingsUpdateDto & { contextWindowOverrides?: ContextWindowOverridePatch }): OpenCodeGoSettings {
  return parseOpenCodeGoSettings({
    ...current,
    ...patch,
    contextWindowOverrides: patch.contextWindowOverrides === undefined ? current.contextWindowOverrides : mergeContextWindowOverrides(current.contextWindowOverrides, patch.contextWindowOverrides),
    enabledModelIds: patch.enabledModelIds === undefined ? current.enabledModelIds : patch.enabledModelIds,
    defaultReasoningEffort: patch.defaultReasoningEffort === undefined ? current.defaultReasoningEffort : patch.defaultReasoningEffort,
    selectedAccountId: patch.selectedAccountId === undefined ? current.selectedAccountId : patch.selectedAccountId,
  })
}

export function openCodeGoSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'opencode-go-settings.json')
}

export class OpenCodeGoSettingsStore {
  private sequence = 0
  private readonly filePath: string
  constructor(filePath: string = openCodeGoSettingsPath()) { this.filePath = filePath }
  path(): string { return this.filePath }
  async read(): Promise<OpenCodeGoSettings> {
    try { return parseOpenCodeGoSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown) }
    catch { return defaultOpenCodeGoSettings() }
  }
  async write(settings: OpenCodeGoSettings): Promise<void> {
    const normalized = parseOpenCodeGoSettings(settings)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = this.filePath + '.tmp.' + process.pid + '.' + (++this.sequence)
    try {
      await fs.writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, this.filePath)
      const restored = parseOpenCodeGoSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown)
      if (!isDeepStrictEqual(restored, normalized)) throw new Error('OpenCode Go settings verification failed')
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
  async update(patch: OpenCodeGoSettingsUpdateDto & { contextWindowOverrides?: ContextWindowOverridePatch }): Promise<OpenCodeGoSettings> {
    const next = mergeOpenCodeGoSettings(await this.read(), patch)
    await this.write(next)
    return next
  }
}
