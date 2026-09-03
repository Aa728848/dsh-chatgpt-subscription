import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { type LocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'dsh-chatgpt-subscription': LocaleKey;
        'dsh-antigravity': any;
    }
}
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map