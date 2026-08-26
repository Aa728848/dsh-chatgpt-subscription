import { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { OAuthService } from './oauth-service.ts';
import { type LocalRawImageOptions } from './responses-mapper.ts';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CodexOutputVerbosity } from '../shared/contracts.ts';
type FetchLike = typeof fetch;
export interface ResponsesClientOptions {
    fetchFn?: FetchLike;
    localRawImages?: LocalRawImageOptions;
    onGenerationFinished?: () => void;
    outputVerbosity?: () => CodexOutputVerbosity | null;
}
export declare class ResponsesClient {
    private readonly oauth;
    private readonly attachments;
    private readonly fetchFn;
    private readonly onGenerationFinished;
    private readonly outputVerbosity;
    constructor(oauth: OAuthService, attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>, options?: ResponsesClientOptions);
    private readonly localRawImages;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private send;
    private request;
}
export declare function parseResponsesStream(response: Response, signal?: AbortSignal, hiddenSandboxControls?: ReadonlySet<string>): AsyncIterable<StreamChunk>;
export {};
//# sourceMappingURL=responses-client.d.ts.map