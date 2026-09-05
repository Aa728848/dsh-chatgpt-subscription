import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { CredentialStore } from '../token-store.ts';
export declare const ANTIGRAVITY_PREFERENCES_NAMESPACE = "dsh-antigravity";
export interface AntigravityCredentials {
    access?: string;
    access_token?: string;
    refresh?: string;
    refresh_token?: string;
    expires?: number;
    expires_at?: number;
    email?: string;
    projectId?: string;
}
export interface AntigravityCatalogModel {
    id: string;
    name?: string;
    description?: string;
}
export interface AntigravityModelSettings {
    enabledModelIds: string[];
    catalogModels: AntigravityCatalogModel[];
    contextWindowOverrides?: Record<string, number>;
    defaultReasoningEffort?: 'low' | 'medium' | 'high' | null;
}
export interface AntigravityPreferenceStore {
    status(): AntigravityModelSettings;
    update(patch: {
        enabledModelIds?: string[];
        contextWindowOverrides?: Record<string, number>;
        defaultReasoningEffort?: 'low' | 'medium' | 'high' | null;
    }): Promise<AntigravityModelSettings>;
}
export declare function registerAntigravityPreferenceStore(settings?: SettingsProvider, fallbackStore?: FileModelSettingsStore): AntigravityPreferenceStore;
export declare function dshHomeDir(): string;
export declare function credentialPath(): string;
export declare function modelSettingsPath(): string;
export declare function parseAntigravityCredentials(value: unknown): AntigravityCredentials;
/** Keeps the public API; filePath identifies the legacy JSON that is migrated on first use. */
export declare class FileCredentialStore {
    private readonly filePath;
    private readonly backend;
    constructor(filePath?: string, backend?: CredentialStore<AntigravityCredentials>);
    path(): string;
    private serialize;
    private removeLegacy;
    private saveVerified;
    read(): Promise<AntigravityCredentials | null>;
    write(credentials: AntigravityCredentials): Promise<void>;
    delete(): Promise<void>;
}
export declare class FileModelSettingsStore {
    private readonly filePath;
    constructor(filePath?: string);
    path(): string;
    read(): Promise<AntigravityModelSettings>;
    write(settings: AntigravityModelSettings): Promise<void>;
    updateSettings(patch: {
        enabledModelIds?: string[];
        contextWindowOverrides?: Record<string, number>;
        defaultReasoningEffort?: 'low' | 'medium' | 'high' | null;
    }): Promise<AntigravityModelSettings>;
    setEnabledModelIds(enabledModelIds: string[]): Promise<AntigravityModelSettings>;
    setCatalogModels(catalogModels: AntigravityCatalogModel[], options?: {
        enabledModelIds?: string[];
    }): Promise<AntigravityModelSettings>;
}
//# sourceMappingURL=token-store.d.ts.map