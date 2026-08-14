import type { TokenStore, StoredOAuthCredentials } from './token-store.ts';
export declare function defaultDpapiCredentialPath(): string;
export declare class WindowsDpapiTokenStore implements TokenStore {
    private readonly path;
    constructor(path?: string);
    load(): Promise<StoredOAuthCredentials | null>;
    save(value: StoredOAuthCredentials): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=token-store-windows.d.ts.map