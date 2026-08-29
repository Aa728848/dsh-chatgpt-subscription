import type { Context } from '@deepseek-ai/cordis';
import { OAuthService } from './oauth-service.ts';
import { type SubscriptionPreferenceStore } from './preferences.ts';
import type { ProxyManager } from './proxy-manager.ts';
import { UsageService } from './usage-service.ts';
export declare function registerRoutes(ctx: Context, oauth: OAuthService, usage: UsageService, preferences: SubscriptionPreferenceStore, proxyManager?: ProxyManager): () => void;
//# sourceMappingURL=routes.d.ts.map