import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { OAuthService } from './oauth-service.ts';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
type FetchLike = typeof fetch;
export interface ResponsesClientOptions {
    fetchFn?: FetchLike;
    onGenerationFinished?: () => void;
}
export declare class ResponsesClient {
    private readonly oauth;
    private readonly attachments;
    private readonly fetchFn;
    private readonly onGenerationFinished;
    constructor(oauth: OAuthService, attachments: Pick<AttachmentStore, 'readImage'>, options?: ResponsesClientOptions);
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private send;
    private request;
}
export declare function parseResponsesStream(response: Response, signal?: AbortSignal, hiddenSandboxControls?: ReadonlySet<string>): AsyncIterable<StreamChunk>;
export {};
//# sourceMappingURL=responses-client.d.ts.map