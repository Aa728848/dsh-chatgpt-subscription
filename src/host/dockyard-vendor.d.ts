declare module '*vendor/dockyard/packages/runtime/src/dockyard-runtime.mjs' {
  export interface DockyardRuntimeOptions {
    providers?: unknown[]
    stateStore?: unknown
    secretStore?: unknown
    requestExecutors?: Record<string, unknown>
    catalogLoaders?: Record<string, unknown>
    antigravity?: Record<string, unknown>
    claude?: Record<string, unknown>
    cursor?: Record<string, unknown>
    grok?: Record<string, unknown>
  }

  export class DockyardRuntime {
    constructor(options?: DockyardRuntimeOptions)
    init(): Promise<this>
    listProviderIds(): string[]
    listProviderManifests(): Array<{ id: string; displayName?: string; capabilities?: string[] }>
    scan(providerId?: string | null): Promise<unknown>
    importCandidate(providerId: string, candidateId: string): Promise<unknown>
    startAuthorization(providerId: string): Promise<Record<string, unknown>>
    pollAuthorization(providerId: string, sessionId: string): Promise<Record<string, unknown>>
    submitAuthorizationCode(providerId: string, sessionId: string, code: string): Promise<Record<string, unknown>>
    cancelAuthorization(providerId: string, sessionId: string): Promise<Record<string, unknown>>
    refreshAll(providerId?: string | null): Promise<unknown>
    removeAccount(providerId: string, accountId: string): Promise<unknown>
    getCatalog(providerId: string): Promise<Record<string, unknown>>
    stream(providerId: string, request: unknown, context?: Record<string, unknown>): Promise<AsyncIterable<unknown>>
    snapshot(): MultiProviderSnapshot
  }

  export function createDefaultProviderEntries(options?: Record<string, unknown>): unknown[]
  export interface MultiProviderSnapshot {
    generatedAt: string
    providers: Array<{
      providerId: string
      manifest: { id: string; displayName?: string; capabilities?: string[] }
      policy: string
      defaultAccountId?: string | null
      accounts: Array<Record<string, unknown>>
    }>
    routes: string[]
  }
}

declare module '*vendor/dockyard/packages/runtime/src/state-store.mjs' {
  export class JsonStateStore {
    constructor(options?: { filePath?: string; home?: string; env?: NodeJS.ProcessEnv })
  }
}

declare module '*vendor/dockyard/modules/provider-antigravity/src/index.mjs' {
  export function createAntigravityCatalogLoader(options?: Record<string, unknown>): (context?: unknown) => Promise<unknown>
  export function createAntigravityCliExecutor(options?: Record<string, unknown>): (envelope: unknown) => Promise<unknown>
  export function createAntigravityNativeExecutor(options?: Record<string, unknown>): (envelope: unknown) => Promise<unknown>
  export function createAntigravityNativeQuotaReader(options?: Record<string, unknown>): (context: unknown) => Promise<unknown>
}

declare module '*vendor/dockyard/modules/provider-claude/src/index.mjs' {
  export function createClaudeCatalogLoader(options?: Record<string, unknown>): (context?: unknown) => Promise<unknown>
  export function createClaudeNativeExecutor(options?: Record<string, unknown>): (envelope: unknown) => Promise<unknown>
}

declare module '*vendor/dockyard/modules/provider-cursor/src/index.mjs' {
  export function createCursorCatalogLoader(options?: Record<string, unknown>): (context?: unknown) => Promise<unknown>
  export function createCursorNativeExecutor(options?: Record<string, unknown>): (envelope: unknown) => Promise<unknown>
}

declare module '*vendor/dockyard/modules/provider-grok/src/index.mjs' {
  export function createGrokCatalogLoader(options?: Record<string, unknown>): (context?: unknown) => Promise<unknown>
  export function createGrokNativeExecutor(options?: Record<string, unknown>): (envelope: unknown) => Promise<unknown>
}

declare module '*vendor/dockyard/packages/providers/src/cli-agent-transport.mjs' {
  export function runCliCommand(...args: unknown[]): Promise<unknown>
}
