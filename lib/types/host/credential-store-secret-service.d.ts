import type { CredentialStore } from './token-store.ts';
/** Secrets travel over stdin/stdout; command arguments contain only lookup attributes. */
export declare class SecretServiceCredentialStore<T> implements CredentialStore<T> {
    private readonly service;
    private readonly account;
    private readonly parse;
    constructor(service: string, account: string, parse: (value: unknown) => T);
    private attributes;
    load(): Promise<T | null>;
    save(value: T): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=credential-store-secret-service.d.ts.map