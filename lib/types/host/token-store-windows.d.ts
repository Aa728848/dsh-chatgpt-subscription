import type { TokenStore, StoredOAuthCredentials } from './token-store.ts';
export declare function defaultDpapiCredentialPath(namespace?: 'codex' | 'providers'): string;
export declare class WindowsDpapiTokenStore implements TokenStore {
    readonly storage: {
        readonly kind: "windows-dpapi";
        readonly encrypted: true;
    };
    private readonly path;
    constructor(path?: string | undefined, namespace?: 'codex' | 'providers');
    load(): Promise<StoredOAuthCredentials | null>;
    save(value: StoredOAuthCredentials): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=token-store-windows.d.ts.map