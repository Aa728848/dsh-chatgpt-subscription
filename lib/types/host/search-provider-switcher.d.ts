import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type { SearchProviderPreference } from '../shared/contracts.ts';
interface LoaderLike {
    entries(): Iterable<Entry>;
}
export declare class SearchProviderSwitcher {
    private readonly loader;
    private originalProvider;
    private initialized;
    constructor(loader: LoaderLike);
    select(preference: SearchProviderPreference): Promise<void>;
    private findWebEntry;
}
export {};
//# sourceMappingURL=search-provider-switcher.d.ts.map