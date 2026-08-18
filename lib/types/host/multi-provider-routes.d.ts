import type { Context } from '@deepseek-ai/cordis';
import type { CredentialStorageDto } from '../shared/contracts.ts';
import { MultiProviderRuntime } from './multi-provider-runtime.ts';
export declare function registerMultiProviderRoutes(ctx: Context, runtime: MultiProviderRuntime, storage: Omit<CredentialStorageDto, 'available'>): () => void;
//# sourceMappingURL=multi-provider-routes.d.ts.map