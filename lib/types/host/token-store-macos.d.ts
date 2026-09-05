import type { CredentialStore, TokenStore, StoredOAuthCredentials } from './token-store.ts';
/**
 * macOS credential storage backed by the login Keychain through the built-in
 * `security` command-line tool. The payload is encrypted at rest by the
 * Keychain, so this store reports itself as encrypted like Windows DPAPI.
 */
export declare class MacKeychainCredentialStore<T> implements CredentialStore<T> {
    private readonly service;
    private readonly account;
    private readonly parse;
    readonly storage: {
        readonly kind: "macos-keychain";
        readonly encrypted: true;
    };
    constructor(service: string, account: string, parse: (value: unknown) => T);
    load(): Promise<T | null>;
    save(value: T): Promise<void>;
    clear(): Promise<void>;
}
export declare class MacKeychainTokenStore extends MacKeychainCredentialStore<StoredOAuthCredentials> implements TokenStore {
    constructor(service?: string, account?: string);
}
//# sourceMappingURL=token-store-macos.d.ts.map