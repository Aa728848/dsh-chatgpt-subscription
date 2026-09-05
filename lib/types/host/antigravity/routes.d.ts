import type { Context } from '@deepseek-ai/cordis';
import { FileCredentialStore, FileModelSettingsStore, type AntigravityPreferenceStore } from './token-store.ts';
import type { AntigravityWebStatus } from '../../shared/antigravity-contracts.ts';
export declare function getAntigravityWebStatus(store: FileCredentialStore, modelSettings: FileModelSettingsStore, preferences?: AntigravityPreferenceStore): Promise<AntigravityWebStatus>;
export declare function registerAntigravityRoutes(ctx: Context, store: FileCredentialStore, modelSettings: FileModelSettingsStore, preferences?: AntigravityPreferenceStore, fetchFn?: typeof fetch): () => void;
//# sourceMappingURL=routes.d.ts.map