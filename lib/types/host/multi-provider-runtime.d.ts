import { type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ProviderSecretStore } from './provider-secret-store.ts';
export declare const SUBSCRIPTION_PROVIDER_IDS: readonly ["claude", "grok", "cursor", "antigravity"];
export type SubscriptionProviderId = typeof SUBSCRIPTION_PROVIDER_IDS[number];
interface RuntimeProviderSnapshot {
    providerId: string;
    manifest: {
        capabilities?: string[];
    };
    policy: string;
    defaultAccountId?: string | null;
    accounts: Array<Record<string, unknown>>;
}
export interface MultiProviderSnapshot {
    generatedAt: string;
    providers: RuntimeProviderSnapshot[];
}
export interface MultiProviderRuntimeOptions {
    secretStore: ProviderSecretStore;
    env?: NodeJS.ProcessEnv;
    statePath?: string;
    attachments?: unknown;
}
export declare class MultiProviderRuntime {
    private readonly runtime;
    private readonly attachments;
    private candidates;
    constructor(options: MultiProviderRuntimeOptions);
    init(): Promise<void>;
    dispose(): Promise<void>;
    providers(): readonly SubscriptionProviderId[];
    providerName(provider: string): string;
    listModels(provider: string): Promise<LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    snapshot(): MultiProviderSnapshot;
    scan(provider?: string | null): Promise<unknown>;
    discoveredCandidates(provider: string): Array<Record<string, unknown>>;
    importCandidate(provider: string, candidateId: string): Promise<unknown>;
    startAuthorization(provider: string): Promise<Record<string, unknown>>;
    pollAuthorization(provider: string, sessionId: string): Promise<Record<string, unknown>>;
    submitAuthorizationCode(provider: string, sessionId: string, code: string): Promise<Record<string, unknown>>;
    cancelAuthorization(provider: string, sessionId: string): Promise<Record<string, unknown>>;
    refresh(provider?: string | null): Promise<unknown>;
    removeAccount(provider: string, accountId: string): Promise<unknown>;
    activeSession(provider: string): Promise<unknown>;
}
export declare function createAntigravitySessionExecutor(nativeExecutor: (value: Record<string, unknown>) => unknown, cliExecutor: (value: Record<string, unknown>) => unknown): (value: Record<string, unknown>) => unknown;
export declare function defaultProviderStatePath(env?: NodeJS.ProcessEnv): string;
export {};
//# sourceMappingURL=multi-provider-runtime.d.ts.map