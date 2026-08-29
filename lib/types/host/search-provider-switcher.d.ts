import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
interface LoaderLike {
    entries(): Iterable<Entry>;
}
export declare function restoreDefaultWebProviders(loader: LoaderLike): Promise<void>;
export {};
//# sourceMappingURL=search-provider-switcher.d.ts.map