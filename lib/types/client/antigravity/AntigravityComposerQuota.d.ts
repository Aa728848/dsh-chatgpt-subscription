import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS_ANTIGRAVITY } from './locales.ts';
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_ANTIGRAVITY> & {
    directory: SnapshotStore<ModelDirectoryState>;
    loadModelDirectory: () => void;
};
export declare function AntigravityComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null;
export {};
//# sourceMappingURL=AntigravityComposerQuota.d.ts.map