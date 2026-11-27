import path from 'node:path'
import type z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { FilePreferencesStore } from '../../common/file-preferences.ts'
import { dshHomeDir } from '../../common/home.ts'
import type { AdvisorLimits, AdvisorRoute, AdvisorStateDto } from '../../../shared/advisor-contracts.ts'

const ROUTE_SCHEMA = zod.object({
  provider: zod.string(),
  model: zod.string(),
  reasoningEffort: zod.string().optional(),
})
const DOCUMENT_SCHEMA = zod.object({
  sessions: zod.record(zod.string(), zod.object({
    enabled: zod.boolean(),
    route: zod.union([ROUTE_SCHEMA, zod.null()]).default(null),
    updatedAt: zod.number(),
  })).default({}),
})
const validateDocument = ((input: unknown) => DOCUMENT_SCHEMA.parse(input) as AdvisorDocument) as z<AdvisorDocument>

interface AdvisorDocument {
  sessions: Record<string, { enabled: boolean; route: AdvisorRoute | null; updatedAt: number }>
}
export interface AdvisorDefaults extends AdvisorLimits {
  enabled: boolean
  selection: AdvisorRoute | null
}

/** Per-session Advisor choices; the JSON document contains routes only, never credentials. */
export class AdvisorSelectionStore {
  private readonly store: FilePreferencesStore<AdvisorDocument>
  constructor(private readonly defaults: () => AdvisorDefaults, filePath?: string) {
    this.store = new FilePreferencesStore(validateDocument, filePath ?? path.join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-advisor.json'))
  }

  async state(sessionId: string): Promise<AdvisorStateDto> {
    await this.store.hydrate()
    const fallback = this.defaults()
    const saved = this.store.get().sessions[sessionId]
    return {
      sessionId,
      enabled: saved?.enabled ?? fallback.enabled,
      selection: saved?.route ?? fallback.selection,
      defaultEnabled: fallback.enabled,
      defaultSelection: fallback.selection,
      limits: {
        maxTokens: fallback.maxTokens, timeoutMs: fallback.timeoutMs,
        maxRetries: fallback.maxRetries, contextTokenBudget: fallback.contextTokenBudget,
      },
    }
  }

  async update(sessionId: string, patch: { enabled?: boolean; selection?: AdvisorRoute | null }): Promise<AdvisorStateDto> {
    const current = await this.state(sessionId)
    const sessions = { ...this.store.get().sessions }
    sessions[sessionId] = {
      enabled: patch.enabled ?? current.enabled,
      route: patch.selection === undefined ? current.selection : patch.selection,
      updatedAt: Date.now(),
    }
    const retained = Object.entries(sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 512)
    await this.store.update({ sessions: Object.fromEntries(retained) })
    return this.state(sessionId)
  }
}