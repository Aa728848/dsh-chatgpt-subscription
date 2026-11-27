import path from 'node:path'
import type z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { FilePreferencesStore } from '../../common/file-preferences.ts'
import { dshHomeDir } from '../../common/home.ts'
import type { AdvisorLimits, AdvisorRoute, AdvisorStateDto, AdvisorUsage } from '../../../shared/advisor-contracts.ts'

const ROUTE_SCHEMA = zod.object({
  provider: zod.string(),
  model: zod.string(),
  reasoningEffort: zod.string().optional(),
})
const USAGE_SCHEMA = zod.object({
  inputTokens: zod.number().default(0),
  outputTokens: zod.number().default(0),
  cacheReadTokens: zod.number().default(0),
  cacheWriteTokens: zod.number().default(0),
  calls: zod.number().default(0),
})
const SESSION_SCHEMA = zod.object({
  // Absent means "inherit the user-level default"; present (including false) is an explicit choice.
  enabled: zod.boolean().optional(),
  route: ROUTE_SCHEMA.optional(),
  usage: USAGE_SCHEMA.default({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }),
  updatedAt: zod.number().default(0),
})
const DOCUMENT_SCHEMA = zod.object({
  defaults: zod.object({
    enabled: zod.boolean().optional(),
    route: ROUTE_SCHEMA.optional(),
  }).default({}),
  sessions: zod.record(zod.string(), SESSION_SCHEMA).default({}),
})
const validateDocument = ((input: unknown) => DOCUMENT_SCHEMA.parse(input) as AdvisorDocument) as z<AdvisorDocument>

interface SessionDocument {
  enabled?: boolean
  route?: AdvisorRoute
  usage: AdvisorUsage
  updatedAt: number
}
interface AdvisorDocument {
  defaults: { enabled?: boolean; route?: AdvisorRoute }
  sessions: Record<string, SessionDocument>
}

export interface AdvisorDefaults extends AdvisorLimits {
  enabled: boolean
  selection: AdvisorRoute | null
}

const ZERO_USAGE: AdvisorUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }

/**
 * Per-session Advisor choices plus the user-level default and the cumulative
 * advisor spend. The JSON document contains routes, booleans and token counts
 * only: never credentials and never transcript content.
 */
export class AdvisorSelectionStore {
  private readonly store: FilePreferencesStore<AdvisorDocument>
  constructor(private readonly defaults: () => AdvisorDefaults, filePath?: string) {
    this.store = new FilePreferencesStore(validateDocument, filePath ?? path.join(dshHomeDir(), 'storages', 'dsh-chatgpt-subscription-advisor.json'))
  }

  /** The user-level default: an explicit saved choice, else the configured seed. */
  private base(fallback: AdvisorDefaults): { enabled: boolean; route: AdvisorRoute | null } {
    const saved = this.store.get().defaults
    return { enabled: saved.enabled ?? fallback.enabled, route: saved.route ?? fallback.selection }
  }

  async state(sessionId: string): Promise<AdvisorStateDto> {
    await this.store.hydrate()
    const fallback = this.defaults()
    const userDefault = this.base(fallback)
    const saved = this.store.get().sessions[sessionId]
    return {
      sessionId,
      enabled: saved?.enabled ?? userDefault.enabled,
      selection: saved?.route ?? userDefault.route,
      defaultEnabled: userDefault.enabled,
      defaultSelection: userDefault.route,
      inherited: saved?.enabled === undefined && saved?.route === undefined,
      limits: {
        maxTokens: fallback.maxTokens, timeoutMs: fallback.timeoutMs,
        maxRetries: fallback.maxRetries, contextTokenBudget: fallback.contextTokenBudget,
        sessionTokenBudget: fallback.sessionTokenBudget,
      },
      usage: saved?.usage ?? { ...ZERO_USAGE },
    }
  }

  /** Write one session's override. `null` reverts that field to the user-level default. */
  async update(sessionId: string, patch: { enabled?: boolean | null; selection?: AdvisorRoute | null }): Promise<AdvisorStateDto> {
    await this.store.hydrate()
    const sessions = { ...this.store.get().sessions }
    const previous: SessionDocument = sessions[sessionId] ?? {
      usage: { ...ZERO_USAGE }, updatedAt: 0,
    }
    const next: SessionDocument = {
      ...previous,
      usage: previous.usage,
      updatedAt: Date.now(),
    }
    if (patch.enabled !== undefined) {
      if (patch.enabled === null) delete next.enabled
      else next.enabled = patch.enabled
    }
    if (patch.selection !== undefined) {
      if (patch.selection === null) delete next.route
      else next.route = patch.selection
    }
    sessions[sessionId] = next
    await this.commit(sessions)
    return this.state(sessionId)
  }

  /** Move the user-level default; a later session that never overrode it follows this. */
  async setDefault(route: AdvisorRoute | null, enabled?: boolean): Promise<void> {
    await this.store.hydrate()
    const defaults: AdvisorDocument['defaults'] = { ...this.store.get().defaults }
    if (route === null) delete defaults.route
    else defaults.route = route
    if (enabled !== undefined) defaults.enabled = enabled
    await this.store.update({ defaults })
  }

  /** Add one consultation's spend and return the new running total. */
  async addUsage(sessionId: string, usage: AdvisorUsage): Promise<AdvisorUsage> {
    const state = await this.state(sessionId)
    const merged: AdvisorUsage = {
      inputTokens: state.usage.inputTokens + usage.inputTokens,
      outputTokens: state.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: state.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: state.usage.cacheWriteTokens + usage.cacheWriteTokens,
      calls: state.usage.calls + usage.calls,
    }
    const sessions = { ...this.store.get().sessions }
    const previous: SessionDocument = sessions[sessionId] ?? { usage: { ...ZERO_USAGE }, updatedAt: 0 }
    sessions[sessionId] = { ...previous, usage: merged, updatedAt: Date.now() }
    await this.commit(sessions)
    return merged
  }

  /** Bounded map: the 512 most recently touched sessions survive. */
  private async commit(sessions: Record<string, SessionDocument>): Promise<void> {
    const retained = Object.entries(sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 512)
    await this.store.update({ sessions: Object.fromEntries(retained) })
  }
}
