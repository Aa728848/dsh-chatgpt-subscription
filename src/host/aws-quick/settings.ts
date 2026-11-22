import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import type { AwsQuickAccountProvider, AwsQuickEffort, AwsQuickMode } from '../../shared/aws-quick-contracts.ts'
import { AWS_QUICK_EFFORTS, AWS_QUICK_MODES } from '../../shared/aws-quick-contracts.ts'

export const SETTINGS_VERSION = 1
export interface AwsQuickSettings {
  enabled: boolean
  enabledModelIds: string[] | null
  binaryPath: string | null
  accountProvider: AwsQuickAccountProvider
  region: string | null
  defaultMode: AwsQuickMode
  defaultReasoningEffort: AwsQuickEffort | null
  lastTurnAt?: number
}
export function awsQuickSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'aws-quick-settings.json')
}
export function defaultAwsQuickSettings(): AwsQuickSettings {
  return { enabled: true, enabledModelIds: null, binaryPath: null, accountProvider: 'social', region: null, defaultMode: 'balanced', defaultReasoningEffort: null }
}
export function parseAwsQuickSettings(value: unknown): AwsQuickSettings {
  const defaults = defaultAwsQuickSettings()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaults
  const r = value as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : r.enabled === undefined ? defaults.enabled : false,
    enabledModelIds: r.enabledModelIds === null ? null : Array.isArray(r.enabledModelIds) ? r.enabledModelIds.filter((x): x is string => typeof x === 'string') : null,
    binaryPath: typeof r.binaryPath === 'string' && r.binaryPath.trim() ? r.binaryPath : null,
    accountProvider: r.accountProvider === 'enterprise' ? 'enterprise' : 'social',
    region: typeof r.region === 'string' && r.region.trim() ? r.region.trim() : null,
    defaultMode: AWS_QUICK_MODES.includes(r.defaultMode as AwsQuickMode) ? r.defaultMode as AwsQuickMode : defaults.defaultMode,
    defaultReasoningEffort: AWS_QUICK_EFFORTS.includes(r.defaultReasoningEffort as AwsQuickEffort) ? r.defaultReasoningEffort as AwsQuickEffort : null,
    ...(typeof r.lastTurnAt === 'number' && Number.isFinite(r.lastTurnAt) ? { lastTurnAt: r.lastTurnAt } : {}),
  }
}
export class AwsQuickSettingsStore {
  private cached: AwsQuickSettings | null = null
  private loading: Promise<AwsQuickSettings> | null = null
  constructor(private readonly filePath = awsQuickSettingsPath()) {}
  async read(): Promise<AwsQuickSettings> {
    if (this.cached) return this.cached
    if (this.loading) return this.loading
    this.loading = fs.readFile(this.filePath, 'utf8')
      .then((body) => parseAwsQuickSettings(JSON.parse(body)))
      .catch(() => defaultAwsQuickSettings())
      .then((value) => { this.cached = value; return value })
      .finally(() => { this.loading = null })
    return this.loading
  }
  async update(patch: Partial<AwsQuickSettings>): Promise<AwsQuickSettings> {
    const next = { ...(await this.read()), ...patch }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(temp, JSON.stringify({ version: SETTINGS_VERSION, ...next }, null, 2), 'utf8')
    await fs.rename(temp, this.filePath)
    this.cached = next
    return next
  }
}
