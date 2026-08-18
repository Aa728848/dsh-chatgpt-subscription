import type { TokenStore, StoredOAuthCredentials } from './token-store.ts';
export declare function defaultLinuxCredentialPath(namespace?: 'codex' | 'providers'): string;
/**
 * Linux credential storage protected by owner-only filesystem permissions.
 * The payload is not encrypted at rest, so callers must report that distinction
 * instead of presenting this store as equivalent to Windows DPAPI.
 */
export declare class LinuxFileTokenStore implements TokenStore {
    readonly storage: {
        readonly kind: "linux-file";
        readonly encrypted: false;
    };
    private readonly noFollow;
    private readonly path;
    constructor(path?: string | undefined, namespace?: 'codex' | 'providers');
    load(): Promise<StoredOAuthCredentials | null>;
    save(value: StoredOAuthCredentials): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=token-store-linux.d.ts.map