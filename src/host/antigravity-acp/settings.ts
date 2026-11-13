/**
 * This line's own preferences: one small JSON document, written atomically.
 *
 * The document is deliberately the only state this line owns. Sign-in lives in
 * the official `agy` process, the model catalogue is the server's, and the
 * conversation is the harness's - so what is left is exactly what a user chose:
 * which models to show, which thinking level new turns start at, how permission
 * requests are answered, and where the executable came from.
 *
 * `enabledModelIds` is tri-state and the file carries a version marker for the
 * same reason the Ollama line does: `null` (no filter) and `[]` (every model
 * off) mean opposite things, and a schema default that folded one into the other
 * would silently switch a line off. A file without the marker predates this line
 * and cannot exist; the marker is here so the next change is a migration rather
 * than a reinterpretation.
 *
 * @module dsh-chatgpt-subscription/host/antigravity-acp/settings
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { dshHomeDir } from '../common/home.ts'
import type { AntigravityAcpPermissionPolicy } from '../../shared/antigravity-acp-contracts.ts'

/** Schema version of the settings document this module writes. */
export const SETTINGS_VERSION = 1

/** Everything this line stores about itself. */
export interface AntigravityAcpSettings {
  /** Whether the line serves requests at all. */
  enabled: boolean
  /** Model ids to offer; `null` means no filter. */
  enabledModelIds: string[] | null
  /** Thinking level new turns start at; `null` keeps the server's default. */
  defaultReasoningEffort: string | null
  /** How the agent's permission requests are answered. */
  permissionPolicy: AntigravityAcpPermissionPolicy
  /** Absolute executable path, or `null` for automatic resolution. */
  binaryPath: string | null
  /** Unix milliseconds of the last completed turn, if any. */
  lastTurnAt?: number
}

/** Where the settings document lives. */
export function antigravityAcpSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'antigravity-acp-settings.json')
}

/** The defaults a fresh install starts from. */
export function defaultAntigravityAcpSettings(): AntigravityAcpSettings {
  return {
    // ON by default, like every other line: the card is how a user reaches this
    // feature at all, and a line that ships dark is a line most people never find.
    //
    // The terms risk is disclosed where the decision is made instead of being
    // enforced as a gate: the card carries the Antigravity FAQ paragraph and the
    // README/providers docs carry it again. Google states that third-party access
    // to Antigravity violates its Terms of Service, while the same vendor documents
    // running `agy acp` inside editors - a grey area the user is told about, not
    // one this plugin decides for them. See docs/antigravity-acp-line-plan.md §4.1.
    enabled: true,
    enabledModelIds: null,
    defaultReasoningEffort: null,
    permissionPolicy: 'reject',
    binaryPath: null,
  }
}

/**
 * Parse one stored document.
 *
 * A field that is present but of the wrong type is treated as absent rather than
 * as its zero value: a corrupt `enabledModelIds` must not become "every model
 * off", and a corrupt `permissionPolicy` must not become "allow".
 *
 * @param value - Parsed JSON.
 * @returns The settings the document describes, with defaults for anything unreadable.
 */
export function parseAntigravityAcpSettings(value: unknown): AntigravityAcpSettings {
  const defaults = defaultAntigravityAcpSettings()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaults
  const record = value as Record<string, unknown>
  const enabledModelIds = record.enabledModelIds === null
    ? null
    : Array.isArray(record.enabledModelIds)
      ? record.enabledModelIds.filter((id): id is string => typeof id === 'string')
      : defaults.enabledModelIds
  return {
    // A flag that is present but unreadable is treated as OFF, never as the
    // default: a corrupt document must not silently switch a line on.
    enabled: typeof record.enabled === 'boolean' ? record.enabled : false,
    enabledModelIds,
    defaultReasoningEffort: typeof record.defaultReasoningEffort === 'string'
      ? record.defaultReasoningEffort
      : null,
    permissionPolicy: record.permissionPolicy === 'allow' ? 'allow' : 'reject',
    binaryPath: typeof record.binaryPath === 'string' && record.binaryPath !== '' ? record.binaryPath : null,
    ...(typeof record.lastTurnAt === 'number' && Number.isFinite(record.lastTurnAt)
      ? { lastTurnAt: record.lastTurnAt }
      : {}),
  }
}

/** The same settings document, mirrored in one process's memory. */
export class AntigravityAcpSettingsStore {
  private cached: AntigravityAcpSettings | null = null
  private loading: Promise<AntigravityAcpSettings> | null = null

  constructor(private readonly filePath = antigravityAcpSettingsPath()) {}

  /** Absolute path of the backing file, for the status card. */
  path(): string {
    return this.filePath
  }

  /** The last read value without touching disk. */
  status(): AntigravityAcpSettings {
    return this.cached ?? defaultAntigravityAcpSettings()
  }

  /** Read the document, caching the result until the next write. */
  async read(): Promise<AntigravityAcpSettings> {
    if (this.cached !== null) return this.cached
    if (this.loading !== null) return this.loading
    this.loading = this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async load(): Promise<AntigravityAcpSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      this.cached = parseAntigravityAcpSettings(JSON.parse(content))
    } catch {
      // No document yet, or one that cannot be parsed: the defaults are the
      // honest empty state, and the next write replaces the file wholesale.
      this.cached = defaultAntigravityAcpSettings()
    }
    return this.cached
  }

  /** Replace the whole document. */
  async write(settings: AntigravityAcpSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`
    const body = JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)
    await fs.writeFile(temp, body, 'utf8')
    await fs.rename(temp, this.filePath)
    this.cached = settings
  }

  /** Apply one patch, keeping every field the patch does not name. */
  async update(patch: Partial<AntigravityAcpSettings>): Promise<AntigravityAcpSettings> {
    const current = await this.read()
    const next: AntigravityAcpSettings = {
      ...current,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.enabledModelIds === undefined ? {} : { enabledModelIds: patch.enabledModelIds }),
      ...(patch.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: patch.defaultReasoningEffort }),
      ...(patch.permissionPolicy === undefined ? {} : { permissionPolicy: patch.permissionPolicy }),
      ...(patch.binaryPath === undefined ? {} : { binaryPath: patch.binaryPath }),
      ...(patch.lastTurnAt === undefined ? {} : { lastTurnAt: patch.lastTurnAt }),
    }
    await this.write(next)
    return next
  }
}
