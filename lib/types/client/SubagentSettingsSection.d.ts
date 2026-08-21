import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>;
export declare function SubagentSettingsSection({ t }: Props): React.JSX.Element;
export declare function parseNonNegativeInteger(value: string): number | null;
export declare function parsePositiveInteger(value: string): number | null;
export declare function parseCapacity(value: string): number | null;
export {};
//# sourceMappingURL=SubagentSettingsSection.d.ts.map