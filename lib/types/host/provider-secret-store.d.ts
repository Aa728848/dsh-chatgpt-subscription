import type { TokenStore } from './token-store.ts';
/**
 * Provider-neutral secret storage backed by the existing platform credential
 * store. One encrypted/private bundle contains namespaced provider payloads;
 * only opaque references are persisted in the public account-pool state.
 */
export interface ProviderSecretStore {
    read(ref: string): Promise<unknown | null>;
    write(ref: string, value: unknown): Promise<string>;
    delete(ref: string): Promise<void>;
}
export declare function createProviderCredentialRef(providerId: string, accountId: string): string;
export declare class PlatformProviderSecretStore implements ProviderSecretStore {
    private readonly store;
    private queue;
    constructor(store: TokenStore);
    read(ref: string): Promise<unknown | null>;
    write(ref: string, value: unknown): Promise<string>;
    delete(ref: string): Promise<void>;
    private loadBundle;
    private exclusive;
}
//# sourceMappingURL=provider-secret-store.d.ts.map