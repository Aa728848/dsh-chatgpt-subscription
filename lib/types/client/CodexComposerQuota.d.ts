import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { SubscriptionApi } from './api.ts';
import { NS } from './locales.ts';
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS> & {
    api: SubscriptionApi;
    directory: SnapshotStore<ModelDirectoryState>;
    loadModelDirectory: () => void;
};
export declare function CodexComposerQuota({ api, directory, loadModelDirectory, t }: Props): React.JSX.Element | null;
export {};
//# sourceMappingURL=CodexComposerQuota.d.ts.map