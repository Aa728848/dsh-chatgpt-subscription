import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { SearchProviderPreference } from '../shared/contracts.ts';
interface LoaderLike {
    entries(): Iterable<Entry>;
}
/** What one selection asks for on top of the settings preference. */
export interface WebProviderSelectionOptions {
    /**
     * Whether this plugin's fetch provider must serve the `web_fetch` tool.
     *
     * DSH's built-in provider resolves and pins every destination before it
     * connects and routes through a proxy only when the process environment names
     * one, so an OS-level proxy plus the fake-ip DNS that usually comes with it
     * fails every fetch with `WEB_BLOCKED_URL`. Selecting this plugin's provider
     * hands the origin's resolution to the configured proxy — the same
     * proxied-hop semantics DSH applies to a URL it routes through a proxy.
     */
    readonly pluginFetch?: boolean;
}
export declare class SearchProviderSwitcher {
    private readonly loader;
    private originalSearchProvider;
    private originalFetchProvider;
    private initialized;
    constructor(loader: LoaderLike);
    select(preference: SearchProviderPreference, options?: WebProviderSelectionOptions): Promise<void>;
    private findWebEntry;
}
export {};
//# sourceMappingURL=search-provider-switcher.d.ts.map