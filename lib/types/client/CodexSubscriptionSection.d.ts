import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { CredentialStorageDto, QuotaWindowDto } from '../shared/contracts.ts';
import { NS } from './locales.ts';
type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>;
type Translate = Props['t'];
export declare function CodexSubscriptionSection({ t }: Props): React.JSX.Element;
export declare function storageLabel(storage: CredentialStorageDto | undefined, t: Translate): string;
export declare function storageNotice(storage: CredentialStorageDto | undefined, t: Translate): string;
export declare function QuotaBar({ label, window, t }: {
    label: string;
    window: QuotaWindowDto;
    t: Translate;
}): React.JSX.Element;
export declare function windowLabel(minutes: number | null, t: Translate): string;
export declare function parseCapacity(value: string): number | null;
export declare function formatReset(seconds: number): string;
export {};
//# sourceMappingURL=CodexSubscriptionSection.d.ts.map