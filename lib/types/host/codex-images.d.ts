import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { OAuthService } from './oauth-service.ts';
type FetchLike = typeof fetch;
export interface CodexImageToolOptions {
    fetchFn?: FetchLike;
}
export declare function createCodexImageTool(oauth: OAuthService, attachments: AttachmentStore, options?: CodexImageToolOptions): import("@deepseek-ai/dsh-tools").ToolDefinition;
export {};
//# sourceMappingURL=codex-images.d.ts.map