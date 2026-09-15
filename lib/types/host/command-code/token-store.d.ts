import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { CommandCodeApiEnv, CommandCodeReasoningEffort } from '../../shared/command-code-contracts.ts';
import type { CredentialStore } from '../token-store.ts';
export declare const COMMAND_CODE_PREFERENCES_NAMESPACE = "dsh-command-code";
export type { CommandCodeReasoningEffort };
/**
 * One stored Command Code credential.
 *
 * The provider API authenticates with a bearer API key rather than the rotating
 * OAuth pair the other routes in this plugin store, so there is no refresh
 * token and nothing expires. The browser sign-in returns the same key a user
 * can paste by hand, which is why both paths converge on this shape.
 */
export interface CommandCodeCredentials {
    /** Bearer key issued by Command Code Studio. Host-only; never sent to a browser. */
    apiKey: string;
    userId?: string;
    userName?: string;
    email?: string;
    keyName?: string;
    organizationName?: string;
    planLabel?: string;
    planId?: string;
    /** Unix milliseconds the key was obtained. */
    authenticatedAt?: number;
    /** Which API deployment the key belongs to. */
    apiEnv?: CommandCodeApiEnv;
}
export interface CommandCodeCatalogModel {
    id: string;
    name?: string;
    contextWindow?: number;
}
export interface CommandCodeModelSettings {
    enabledModelIds: string[];
    catalogModels: CommandCodeCatalogModel[];
    contextWindowOverrides: Record<string, number>;
    defaultReasoningEffort: CommandCodeReasoningEffort | null;
}
export interface CommandCodePreferenceStore {
    status(): CommandCodeModelSettings;
    update(patch: {
        enabledModelIds?: string[];
        contextWindowOverrides?: Record<string, number>;
        defaultReasoningEffort?: CommandCodeReasoningEffort | null;
    }): Promise<CommandCodeModelSettings>;
}
/**
 * Bind the model selection to the DSH settings document, which is what the
 * settings service can persist durably; the JSON file beside it remains the
 * store used when the plugin runs without a settings provider (headless tests).
 */
export declare function registerCommandCodePreferenceStore(settings?: SettingsProvider, fallbackStore?: FileModelSettingsStore): CommandCodePreferenceStore;
export declare function credentialPath(): string;
export declare function modelSettingsPath(): string;
export declare function parseCommandCodeCredentials(value: unknown): CommandCodeCredentials;
/** Encrypted credential store; the plaintext JSON is only a migration source. */
export declare class FileCredentialStore {
    private readonly filePath;
    private readonly backend;
    constructor(filePath?: string, backend?: CredentialStore<CommandCodeCredentials>);
    path(): string;
    private serialize;
    private removeLegacy;
    private saveVerified;
    read(): Promise<CommandCodeCredentials | null>;
    write(credentials: CommandCodeCredentials): Promise<void>;
    delete(): Promise<void>;
}
/** Plain-JSON model settings used when the settings service is unavailable. */
export declare class FileModelSettingsStore {
    private readonly filePath;
    constructor(filePath?: string);
    path(): string;
    read(): Promise<CommandCodeModelSettings>;
    write(settings: CommandCodeModelSettings): Promise<void>;
    updateSettings(patch: {
        enabledModelIds?: string[];
        contextWindowOverrides?: Record<string, number>;
        defaultReasoningEffort?: CommandCodeReasoningEffort | null;
    }): Promise<CommandCodeModelSettings>;
    setCatalogModels(catalogModels: CommandCodeCatalogModel[], options?: {
        enabledModelIds?: string[];
    }): Promise<CommandCodeModelSettings>;
}
/** Environment the credential was last used against; defaults to the current one. */
export declare function credentialApiEnv(credentials: CommandCodeCredentials | null): CommandCodeApiEnv;
//# sourceMappingURL=token-store.d.ts.map