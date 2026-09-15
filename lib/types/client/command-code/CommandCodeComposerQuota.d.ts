import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CommandCodeWebStatus } from '../../shared/command-code-contracts.ts';
import { NS_COMMAND_CODE } from './locales.ts';
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_COMMAND_CODE> & {
    directory: SnapshotStore<ModelDirectoryState>;
    loadModelDirectory: () => void;
};
interface BadgeFacts {
    text: string;
    tooltip: string;
    level: 'normal' | 'warning' | 'danger';
}
/**
 * Pick the most meaningful number for the badge.
 *
 * A bounded usage window is the number a user actually spends down, so it wins
 * over a credit balance; the balance shows only when no window is reported.
 */
export declare function selectBadgeFacts(status: CommandCodeWebStatus | null): BadgeFacts | null;
export declare function CommandCodeComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null;
export {};
//# sourceMappingURL=CommandCodeComposerQuota.d.ts.map