import type { SubscriptionPreferencesDto } from '../shared/contracts.ts';
export type FetchLike = typeof fetch;
export declare function normalizeProxyUrl(rawUrl: string): string;
export declare function parseWindowsProxyRegistry(stdout: string): string | null;
export declare function parseMacOsScutilProxy(stdout: string): string | null;
export interface ParseEnvProxyOptions {
    /**
     * `$DSH_HOME/.env` consulted after the process environment; `null` disables
     * the file fallback so a caller (or a test) never reads configuration behind
     * the injected environment's back.
     */
    envFile?: string | null;
}
export declare function parseEnvProxy(env?: Record<string, string | undefined>, options?: ParseEnvProxyOptions): string | null;
export declare function detectSystemProxy(platform?: NodeJS.Platform, env?: Record<string, string | undefined>): string | null;
/** Called with the proxy URL the first time detection reports one after a `null`. */
export type SystemProxyListener = (proxyUrl: string) => void;
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
    private detected;
    private readonly proxyListeners;
    private readonly agents;
    constructor(options: ProxyFetchOptions);
    getSystemProxy(force?: boolean): string | null;
    /**
     * Observe the system proxy becoming known.
     *
     * A proxy that appears after startup — or a first detection that failed — otherwise leaves every
     * consumer on the decision it made at load, because `null` reads the same for "no proxy" and for
     * "detection failed".
     *
     * @param listener - called with the detected proxy URL; a throw from it is ignored.
     * @returns the disposer that stops observing.
     */
    onSystemProxyDetected(listener: SystemProxyListener): () => void;
    resolveActiveProxyUrl(): string | null;
    private getOrCreateAgent;
    createFetch(): FetchLike;
    dispose(): void;
}
//# sourceMappingURL=proxy-manager.d.ts.map