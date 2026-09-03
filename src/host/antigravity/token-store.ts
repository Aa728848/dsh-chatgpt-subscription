import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import * as SettingsModule from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { MODELS } from './types.ts'

export const ANTIGRAVITY_PREFERENCES_NAMESPACE = 'dsh-antigravity'

export interface AntigravityCredentials {
  access?: string
  access_token?: string
  refresh?: string
  refresh_token?: string
  expires?: number
  expires_at?: number
  email?: string
  projectId?: string
}

export interface AntigravityCatalogModel {
  id: string
  name?: string
  description?: string
}

export interface AntigravityModelSettings {
  enabledModelIds: string[]
  catalogModels: AntigravityCatalogModel[]
  contextWindowOverrides?: Record<string, number>
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
}

export interface AntigravityPreferenceStore {
  status(): AntigravityModelSettings
  update(patch: {
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
  }): Promise<AntigravityModelSettings>
}

export function registerAntigravityPreferenceStore(
  settings?: SettingsProvider,
  fallbackStore = new FileModelSettingsStore(),
): AntigravityPreferenceStore {
  if (!settings) {
    return {
      status: () => ({
        enabledModelIds: MODELS.map((m) => m.id),
        catalogModels: [],
        contextWindowOverrides: {},
        defaultReasoningEffort: null,
      }),
      update: async (patch) => fallbackStore.updateSettings(patch),
    }
  }

  const ns = ((SettingsModule as unknown as Record<string, unknown>).settingsNamespace
    ? ((SettingsModule as unknown as Record<string, Function>).settingsNamespace)(ANTIGRAVITY_PREFERENCES_NAMESPACE)
    : ANTIGRAVITY_PREFERENCES_NAMESPACE) as unknown

  const scope = (settings.register as Function).call(settings, ns, z.object({
    enabledModelIds: z.array(z.string()).default(MODELS.map((m) => m.id)),
    contextWindowOverrides: z.dict(z.number()).default({}),
    defaultReasoningEffort: z.union([z.const('low'), z.const('medium'), z.const('high'), z.const(null)]).default(null),
  })) as SettingsScope<{
    enabledModelIds: string[]
    contextWindowOverrides: Record<string, number>
    defaultReasoningEffort: 'low' | 'medium' | 'high' | null
  }>

  return {
    status: () => {
      const val = scope.get()
      return {
        enabledModelIds: val.enabledModelIds,
        catalogModels: [],
        contextWindowOverrides: val.contextWindowOverrides,
        defaultReasoningEffort: val.defaultReasoningEffort,
      }
    },
    update: async (patch) => {
      const current = scope.get()
      const normalized = {
        enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
        contextWindowOverrides: patch.contextWindowOverrides
          ? { ...current.contextWindowOverrides, ...patch.contextWindowOverrides }
          : current.contextWindowOverrides,
        defaultReasoningEffort:
          patch.defaultReasoningEffort !== undefined
            ? patch.defaultReasoningEffort
            : current.defaultReasoningEffort,
      }
      await scope.update(normalized)
      void fallbackStore.updateSettings(patch).catch(() => undefined)
      return {
        ...normalized,
        catalogModels: [],
      }
    },
  }
}

export function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'antigravity-oauth.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'antigravity-models.json')
}

export class FileCredentialStore {
  constructor(private readonly filePath = credentialPath()) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<AntigravityCredentials | null> {
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null && ('access_token' in parsed || 'access' in parsed)) {
        return parsed as AntigravityCredentials
      }
      return null
    } catch {
      return null
    }
  }

  async write(credentials: AntigravityCredentials): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fsPromises.writeFile(tmp, JSON.stringify(credentials, null, 2), 'utf8')
    await fsPromises.rename(tmp, this.filePath)
  }

  async delete(): Promise<void> {
    try {
      await fsPromises.unlink(this.filePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

export class FileModelSettingsStore {
  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<AntigravityModelSettings> {
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModelIds = Array.isArray(record.enabledModelIds)
          ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
          : MODELS.map((m) => m.id)
        const catalogModels = Array.isArray(record.catalogModels)
          ? (record.catalogModels as AntigravityCatalogModel[])
          : []
        const contextWindowOverrides =
          typeof record.contextWindowOverrides === 'object' && record.contextWindowOverrides !== null
            ? (record.contextWindowOverrides as Record<string, number>)
            : {}
        const defaultReasoningEffort =
          record.defaultReasoningEffort === 'low' ||
          record.defaultReasoningEffort === 'medium' ||
          record.defaultReasoningEffort === 'high'
            ? record.defaultReasoningEffort
            : null

        return {
          enabledModelIds,
          catalogModels,
          contextWindowOverrides,
          defaultReasoningEffort,
        }
      }
    } catch {
      // ignore
    }
    return {
      enabledModelIds: MODELS.map((m) => m.id),
      catalogModels: [],
      contextWindowOverrides: {},
      defaultReasoningEffort: null,
    }
  }

  async write(settings: AntigravityModelSettings): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    await fsPromises.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await fsPromises.rename(tmp, this.filePath)
  }

  async updateSettings(patch: {
    enabledModelIds?: string[]
    contextWindowOverrides?: Record<string, number>
    defaultReasoningEffort?: 'low' | 'medium' | 'high' | null
  }): Promise<AntigravityModelSettings> {
    const current = await this.read()
    const next: AntigravityModelSettings = {
      ...current,
      ...(patch.enabledModelIds !== undefined ? { enabledModelIds: patch.enabledModelIds } : {}),
      ...(patch.contextWindowOverrides !== undefined
        ? {
            contextWindowOverrides: {
              ...(current.contextWindowOverrides || {}),
              ...patch.contextWindowOverrides,
            },
          }
        : {}),
      ...(patch.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: patch.defaultReasoningEffort }
        : {}),
    }
    await this.write(next)
    return next
  }

  async setEnabledModelIds(enabledModelIds: string[]): Promise<AntigravityModelSettings> {
    return this.updateSettings({ enabledModelIds })
  }

  async setCatalogModels(
    catalogModels: AntigravityCatalogModel[],
    options?: { enabledModelIds?: string[] },
  ): Promise<AntigravityModelSettings> {
    const current = await this.read()
    const next: AntigravityModelSettings = {
      ...current,
      enabledModelIds: options?.enabledModelIds ?? current.enabledModelIds,
      catalogModels,
    }
    await this.write(next)
    return next
  }
}
