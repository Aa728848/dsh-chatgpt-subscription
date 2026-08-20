import type { TokenStore, StoredOAuthCredentials } from './token-store.ts';
/**
 * macOS credential storage backed by the login Keychain through the built-in
 * `security` command-line tool. The payload is encrypted at rest by the
 * Keychain, so this store reports itself as encrypted like Windows DPAPI.
 */
export declare class MacKeychainTokenStore implements TokenStore {
    private readonly service;
    private readonly account;
    readonly storage: {
        readonly kind: "macos-keychain";
        readonly encrypted: true;
    };
    constructor(service?: string, account?: string);
    load(): Promise<StoredOAuthCredentials | null>;
    save(value: StoredOAuthCredentials): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=token-store-macos.d.ts.map