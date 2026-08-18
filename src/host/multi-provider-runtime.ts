import { homedir } from 'node:os'
import { join } from 'node:path'
import { attributionHeaders, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { DockyardRuntime, createDefaultProviderEntries } from '../../vendor/dockyard/packages/runtime/src/dockyard-runtime.mjs'
import { JsonStateStore } from '../../vendor/dockyard/packages/runtime/src/state-store.mjs'
import {
  createAntigravityCatalogLoader,
  createAntigravityCliExecutor,
  createAntigravityNativeExecutor,
  createAntigravityNativeQuotaReader,
} from '../../vendor/dockyard/modules/provider-antigravity/src/index.mjs'
import { createClaudeCatalogLoader, createClaudeNativeExecutor } from '../../vendor/dockyard/modules/provider-claude/src/index.mjs'
import { createCursorCatalogLoader, createCursorNativeExecutor } from '../../vendor/dockyard/modules/provider-cursor/src/index.mjs'
import { createGrokCatalogLoader, createGrokNativeExecutor } from '../../vendor/dockyard/modules/provider-grok/src/index.mjs'
import { runCliCommand } from '../../vendor/dockyard/packages/providers/src/cli-agent-transport.mjs'
import type { ProviderSecretStore } from './provider-secret-store.ts'
import { createDshAnthropicRegistryLoader } from './pi-ai-registry-loader.ts'

export const SUBSCRIPTION_PROVIDER_IDS = ['claude', 'grok', 'cursor', 'antigravity'] as const
export type SubscriptionProviderId = typeof SUBSCRIPTION_PROVIDER_IDS[number]

const PROVIDER_NAMES: Record<SubscriptionProviderId, string> = {
  claude: 'Claude（订阅 OAuth）',
  grok: 'Grok（订阅 OAuth）',
  cursor: 'Cursor（官方会话）',
  antigravity: 'Antigravity（Google OAuth）',
}

interface RuntimeProviderSnapshot {
  providerId: string
  manifest: { capabilities?: string[] }
  policy: string
  defaultAccountId?: string | null
  accounts: Array<Record<string, unknown>>
}

export interface MultiProviderSnapshot {
  generatedAt: string
  providers: RuntimeProviderSnapshot[]
}

interface InternalProviderRuntime {
  init(): Promise<void>
  snapshot(): MultiProviderSnapshot
  getCatalog(providerId: string): Promise<Record<string, unknown>>
  stream(providerId: string, request: unknown, context?: Record<string, unknown>): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  scan(providerId?: string | null): Promise<unknown>
  importCandidate(providerId: string, candidateId: string): Promise<unknown>
  startAuthorization(providerId: string): Promise<Record<string, unknown>>
  pollAuthorization(providerId: string, sessionId: string): Promise<Record<string, unknown>>
  submitAuthorizationCode(providerId: string, sessionId: string, code: string): Promise<Record<string, unknown>>
  cancelAuthorization(providerId: string, sessionId: string): Promise<Record<string, unknown>>
  refreshAll(providerId?: string | null): Promise<unknown>
  removeAccount(providerId: string, accountId: string): Promise<unknown>
  getActiveSession(providerId: string): Promise<unknown>
  dispose?(): Promise<void> | void
}
export interface MultiProviderRuntimeOptions {
  secretStore: ProviderSecretStore
  env?: NodeJS.ProcessEnv
  statePath?: string
  attachments?: unknown
}

export class MultiProviderRuntime {
  private readonly runtime: InternalProviderRuntime
  private readonly attachments: unknown
  private candidates = new Map<string, Array<Record<string, unknown>>>()

  constructor(options: MultiProviderRuntimeOptions) {
    this.attachments = options.attachments
    const env = sanitizeProviderEnvironment(options.env ?? process.env)
    const providerOptions: Record<string, unknown> = {
      antigravity: { env },
      claude: { env },
      cursor: { env },
      grok: { env },
    }
    const userAgent = attributionHeaders()['user-agent']
    const antigravityQuota = createAntigravityNativeQuotaReader({
      env,
      endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      userAgent,
    })
    providerOptions.antigravity = { ...providerOptions.antigravity as object, quotaReader: antigravityQuota }
    const catalogLoaders = {
      antigravity: createAntigravityCatalogLoader({ env }),
      claude: createClaudeCatalogLoader({ registryLoader: createDshAnthropicRegistryLoader() }),
      cursor: createCursorCatalogLoader({ env }),
      grok: createGrokCatalogLoader({ env, commandRunner: runCliCommand as never }),
    }
    const antigravityNativeExecutor = createAntigravityNativeExecutor({
      env,
      endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      userAgent,
    })
    const antigravityCliExecutor = createAntigravityCliExecutor({
      env,
      catalogLoader: catalogLoaders.antigravity,
    })
    const requestExecutors = {
      antigravity: createAntigravitySessionExecutor(antigravityNativeExecutor, antigravityCliExecutor),
      claude: createClaudeNativeExecutor({ env, endpoint: 'https://api.anthropic.com/v1/messages', userAgent }),
      cursor: createCursorNativeExecutor({ env, endpoint: 'https://api2.cursor.sh', timeoutMs: 120_000, userAgent }),
      grok: createGrokNativeExecutor({ env, endpoint: 'https://api.x.ai/v1/chat/completions', userAgent }),
    }
    const providers = createDefaultProviderEntries({
      ...providerOptions,
      catalogLoaders,
      requestExecutors,
    })
    this.runtime = new DockyardRuntime({
      providers,
      secretStore: options.secretStore,
      stateStore: new JsonStateStore({ filePath: options.statePath ?? defaultProviderStatePath(env) }),
    } as never) as unknown as InternalProviderRuntime
  }

  async init(): Promise<void> {
    await this.runtime.init()
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose?.()
  }

  providers(): readonly SubscriptionProviderId[] {
    return SUBSCRIPTION_PROVIDER_IDS
  }

  providerName(provider: string): string {
    return PROVIDER_NAMES[provider as SubscriptionProviderId] ?? provider
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    await this.runtime.init()
    const entry = this.runtime.snapshot().providers.find((value) => value.providerId === provider)
    if (!entry || entry.accounts.length === 0) return []
    const catalog = await this.runtime.getCatalog(provider)
    return catalogModels(provider, catalog)
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return (await this.listModels(provider)).find((entry) => entry.id === model) ?? {
      provider,
      id: model,
      name: model,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stream = await this.runtime.stream(options.provider, options, {
      sessionId: options.sessionId,
      attachments: this.attachments,
    })
    for await (const chunk of stream) yield chunk as StreamChunk
  }

  snapshot(): MultiProviderSnapshot {
    return this.runtime.snapshot()
  }

  async scan(provider?: string | null): Promise<unknown> {
    const result = await this.runtime.scan((provider ?? null) as never) as { providers?: Array<Record<string, unknown>> }
    for (const entry of result.providers ?? []) {
      if (typeof entry.providerId === 'string' && Array.isArray(entry.candidates)) {
        this.candidates.set(entry.providerId, entry.candidates as Array<Record<string, unknown>>)
      }
    }
    return result
  }

  discoveredCandidates(provider: string): Array<Record<string, unknown>> {
    return this.candidates.get(provider) ?? []
  }

  importCandidate(provider: string, candidateId: string): Promise<unknown> {
    return this.runtime.importCandidate(provider, candidateId)
  }

  startAuthorization(provider: string): Promise<Record<string, unknown>> {
    return this.runtime.startAuthorization(provider)
  }

  pollAuthorization(provider: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.runtime.pollAuthorization(provider, sessionId)
  }

  submitAuthorizationCode(provider: string, sessionId: string, code: string): Promise<Record<string, unknown>> {
    return this.runtime.submitAuthorizationCode(provider, sessionId, code)
  }

  cancelAuthorization(provider: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.runtime.cancelAuthorization(provider, sessionId)
  }

  refresh(provider?: string | null): Promise<unknown> {
    return this.runtime.refreshAll((provider ?? null) as never)
  }

  removeAccount(provider: string, accountId: string): Promise<unknown> {
    return this.runtime.removeAccount(provider, accountId)
  }

  activeSession(provider: string): Promise<unknown> {
    return this.runtime.getActiveSession(provider)
  }
}

export function createAntigravitySessionExecutor(
  nativeExecutor: (value: Record<string, unknown>) => unknown,
  cliExecutor: (value: Record<string, unknown>) => unknown,
): (value: Record<string, unknown>) => unknown {
  return (value) => {
    const invocation = value.invocation as { account?: { resources?: Record<string, unknown> } } | undefined
    const resources = invocation?.account?.resources
    const usesActiveCliSession = resources?.sessionSource === 'cli'
      && resources?.sessionPersistence === 'active'
    return usesActiveCliSession ? cliExecutor(value) : nativeExecutor(value)
  }
}

export function defaultProviderStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'dsh-chatgpt-subscription', 'providers.json')
}

function sanitizeProviderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  const blocked = new Set([
    'DOCKYARD_CLAUDE_AUTHORIZATION_URL',
    'DOCKYARD_CLAUDE_TOKEN_URL',
    'DOCKYARD_CLAUDE_CLIENT_ID',
    'DOCKYARD_CLAUDE_REDIRECT_URI',
    'DOCKYARD_CLAUDE_OAUTH_SCOPE',
    'DOCKYARD_GROK_AUTHORIZATION_URL',
    'DOCKYARD_GROK_TOKEN_URL',
    'DOCKYARD_GROK_CREDITS_URL',
    'DOCKYARD_GROK_CLIENT_ID',
    'DOCKYARD_GROK_OAUTH_SCOPE',
    'DOCKYARD_GROK_TOKEN_HEADER',
    'DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL',
    'DOCKYARD_ANTIGRAVITY_TOKEN_URL',
    'DOCKYARD_ANTIGRAVITY_USERINFO_URL',
    'CURSOR_WEBSITE_URL',
    'CURSOR_API_BASE_URL',
    'CURSOR_REFRESH_URL',
  ])
  for (const key of blocked) delete env[key]
  return env
}

function catalogModels(provider: string, catalog: Record<string, unknown>): LlmModelInfo[] {
  const models = Array.isArray(catalog.models) ? catalog.models : []
  return models.flatMap((value): LlmModelInfo[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const model = value as Record<string, unknown>
    if (typeof model.id !== 'string' || model.id === '') return []
    const modalities = provider === 'cursor'
      ? ['text'] as const
      : Array.isArray(model.inputModalities)
        ? model.inputModalities.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
        : undefined
    const reasoning = normalizeReasoning(model.reasoning)
    return [{
      provider,
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      ...(modalities?.length ? { inputModalities: modalities } : {}),
      ...(Number.isInteger(model.contextWindow) ? { context: { contextWindow: model.contextWindow as number } } : {}),
      ...(Number.isInteger(model.maxTokens) ? { defaultMaxTokens: model.maxTokens as number } : {}),
      ...(reasoning ? { reasoning } : {}),
    }]
  })
}

function normalizeReasoning(value: unknown): LlmResolvedModelInfo['reasoning'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.efforts)) return undefined
  const efforts = record.efforts.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const effort = entry as Record<string, unknown>
    if (typeof effort.id !== 'string' || effort.id === '') return []
    return [{
      id: ReasoningEffortId(effort.id),
      name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
    }]
  })
  if (efforts.length === 0) return undefined
  const defaultEffort = typeof record.defaultEffort === 'string'
    && efforts.some((effort) => effort.id === record.defaultEffort)
    ? ReasoningEffortId(record.defaultEffort)
    : undefined
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) }
}
