import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { SearchProviderPreference } from '../shared/contracts.ts';
interface LoaderLike {
    entries(): Iterable<Entry>;
}
export interface WebProviderSelectionOptions {
    readonly pluginFetch?: boolean;
}
/** Configuration diagnostics, not proof that an in-flight tool uses this service. */
export interface SearchProviderSwitcherStatus {
    readonly state: 'idle' | 'applying' | 'applied' | 'missing' | 'failed';
    readonly configuredSearchProvider: string | null;
    readonly configuredFetchProvider: string | null;
}
export declare class SearchProviderSwitcher {
    private readonly loader;
    private originalSearchProvider;
    private originalFetchProvider;
    private initialized;
    private state;
    constructor(loader: LoaderLike);
    status(): SearchProviderSwitcherStatus;
    select(preference: SearchProviderPreference, options?: WebProviderSelectionOptions): Promise<void>;
    private findWebEntry;
}
export {};
//# sourceMappingURL=search-provider-switcher.d.ts.map