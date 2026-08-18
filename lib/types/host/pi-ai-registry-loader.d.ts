/**
 * Load Claude's catalog from the pi-ai installation shipped with the active
 * DSH CLI. The plugin does not take a package dependency on pi-ai, because DSH
 * owns and upgrades that live provider registry.
 */
export declare function createDshAnthropicRegistryLoader(moduleAnchor?: string): () => Promise<Record<string, unknown>[]>;
//# sourceMappingURL=pi-ai-registry-loader.d.ts.map