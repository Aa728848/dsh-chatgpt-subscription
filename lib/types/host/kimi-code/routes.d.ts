import type { Context } from '@deepseek-ai/cordis';
import { PROVIDER_ID, PROVIDER_NAME } from './types.ts';
import { FileCredentialStore, FileModelSettingsStore, type KimiCodeCatalogModel, type KimiCodePreferenceStore } from './token-store.ts';
import { type KimiCodeWebStatus } from '../../shared/kimi-code-contracts.ts';
/**
 * The selection the card should show.
 *
 * A stored list that still equals the shipped default has never been edited, so
 * it cannot know about models the live catalog has since added; treating it as
 * "everything currently offered" keeps a first run from hiding the whole
 * catalog behind an unedited default. Any explicit edit is honoured exactly.
 */
export declare function resolveEnabledModelIds(stored: readonly string[], catalog: readonly KimiCodeCatalogModel[]): string[];
export interface KimiCodeStatusOptions {
    fetchFn?: typeof fetch;
    /** Whether this plugin currently owns the provider route; re-read on every status. */
    serving?: boolean | (() => boolean);
    /** Diagnostic when another plugin owns the provider route; re-read on every status. */
    conflict?: string | null | (() => string | null);
}
/** Everything the settings card renders: account, quota, and the model catalog. */
export declare function getKimiCodeWebStatus(store: FileCredentialStore, modelSettings: FileModelSettingsStore, preferences?: KimiCodePreferenceStore, options?: KimiCodeStatusOptions): Promise<KimiCodeWebStatus>;
/** Register the Kimi Code settings routes under `/kimi-code/api`. */
export declare function registerKimiCodeRoutes(ctx: Context, store: FileCredentialStore, modelSettings: FileModelSettingsStore, preferences?: KimiCodePreferenceStore, options?: KimiCodeStatusOptions): () => void;
export { PROVIDER_ID, PROVIDER_NAME };
//# sourceMappingURL=routes.d.ts.map