import type { CredentialStore, TokenStore, StoredOAuthCredentials } from './token-store.ts';
export declare function defaultDpapiCredentialPath(): string;
export declare class WindowsDpapiCredentialStore<T> implements CredentialStore<T> {
    private readonly path;
    private readonly parse;
    readonly storage: {
        readonly kind: "windows-dpapi";
        readonly encrypted: true;
    };
    constructor(path: string, parse: (value: unknown) => T);
    load(): Promise<T | null>;
    save(value: T): Promise<void>;
    clear(): Promise<void>;
}
export declare class WindowsDpapiTokenStore extends WindowsDpapiCredentialStore<StoredOAuthCredentials> implements TokenStore {
    constructor(path?: string);
}
//# sourceMappingURL=token-store-windows.d.ts.map