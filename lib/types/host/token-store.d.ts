import type { CredentialStorageDto } from '../shared/contracts.ts';
export interface StoredOAuthCredentials {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
    accountId?: string;
    email?: string;
    planType?: string;
}
export interface CredentialStore<T> {
    load(): Promise<T | null>;
    save(value: T): Promise<void>;
    clear(): Promise<void>;
}
export interface TokenStore extends CredentialStore<StoredOAuthCredentials> {
    readonly storage: Omit<CredentialStorageDto, 'available'>;
}
/** Test seam and non-persistent development store. Never used by apply(). */
export declare class MemoryTokenStore implements TokenStore {
    readonly storage: {
        readonly kind: "memory";
        readonly encrypted: false;
    };
    private value;
    load(): Promise<StoredOAuthCredentials | null>;
    save(value: StoredOAuthCredentials): Promise<void>;
    clear(): Promise<void>;
}
export declare function parseStoredCredentials(value: unknown): StoredOAuthCredentials;
//# sourceMappingURL=token-store.d.ts.map