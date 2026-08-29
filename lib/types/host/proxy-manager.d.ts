import type { SubscriptionPreferencesDto } from '../shared/contracts.ts';
export type FetchLike = typeof fetch;
export declare function normalizeProxyUrl(rawUrl: string): string;
export declare function parseWindowsProxyRegistry(stdout: string): string | null;
export declare function parseMacOsScutilProxy(stdout: string): string | null;
export declare function parseEnvProxy(env?: Record<string, string | undefined>): string | null;
export declare function detectSystemProxy(platform?: NodeJS.Platform, env?: Record<string, string | undefined>): string | null;
export interface ProxyFetchOptions {
    getPreferences: () => Pick<SubscriptionPreferencesDto, 'proxyMode' | 'customProxyUrl'>;
    baseFetch?: FetchLike;
    systemProxyDetector?: () => string | null;
    logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}
export declare class ProxyManager {
    private readonly getPreferences;
    private readonly baseFetch;
    private readonly systemProxyDetector;
    private readonly logger?;
    private cachedSystemProxy;
    private lastSystemProxyCheck;
    private readonly agents;
    constructor(options: ProxyFetchOptions);
    getSystemProxy(force?: boolean): string | null;
    resolveActiveProxyUrl(): string | null;
    private getOrCreateAgent;
    createFetch(): FetchLike;
    dispose(): void;
}
//# sourceMappingURL=proxy-manager.d.ts.map