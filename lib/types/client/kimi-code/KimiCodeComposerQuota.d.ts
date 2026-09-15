import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { KimiCodeWebStatus } from '../../shared/kimi-code-contracts.ts';
import { NS_KIMI_CODE } from './locales.ts';
type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<typeof NS_KIMI_CODE> & {
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
 * The shortest window is the one a user spends down first and the one that
 * blocks work soonest, so it wins over the longer pools; the 7-day allowance
 * shows only when no 5-hour window is reported.
 */
export declare function selectBadgeFacts(status: KimiCodeWebStatus | null): BadgeFacts | null;
export declare function KimiCodeComposerQuota({ directory, loadModelDirectory }: Props): React.JSX.Element | null;
export {};
//# sourceMappingURL=KimiCodeComposerQuota.d.ts.map