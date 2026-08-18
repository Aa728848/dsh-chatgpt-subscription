import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from './locales.ts';
export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;
type Props = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS> & {
    loadImage: ImageLoader;
};
export declare function CodexImageToolView({ block, loadImage, t }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=CodexImageToolView.d.ts.map