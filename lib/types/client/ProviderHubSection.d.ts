import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
    onModelChange?: () => void;
};
/**
 * Single settings page that hosts every subscription provider behind tabs,
 * so the settings sidebar shows one entry instead of one per provider. Only
 * the active tab is mounted, mirroring the shell's previous behavior of
 * mounting just the selected settings page (each provider section refetches
 * its status on mount).
 */
export declare function ProviderHubSection({ t, onModelChange, ...runtime }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=ProviderHubSection.d.ts.map