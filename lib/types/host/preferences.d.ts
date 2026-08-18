import { type SettingsProvider } from '@deepseek-ai/dsh-settings';
import type { SubscriptionPreferencesDto, SubscriptionPreferencesUpdateDto } from '../shared/contracts.ts';
export interface SubscriptionPreferenceStore {
    status(): SubscriptionPreferencesDto;
    update(patch: SubscriptionPreferencesUpdateDto): Promise<SubscriptionPreferencesDto>;
    watch(callback: (next: SubscriptionPreferencesDto, prev: SubscriptionPreferencesDto) => void | Promise<void>): () => void;
}
export declare function registerPreferenceStore(settings: SettingsProvider): SubscriptionPreferenceStore;
export declare class PreferenceError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=preferences.d.ts.map