import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { CodexOutputVerbosity } from '../shared/contracts.ts';
export interface ResponsesPayload extends Record<string, unknown> {
    model: string;
    input: Array<Record<string, unknown>>;
    stream: true;
    store: false;
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface LocalRawImageOptions {
    baseUrl?: string;
    fetchFn?: FetchLike;
}
export declare function hiddenSandboxControlToolNames(options: GenerateOptions): Set<string>;
export declare function buildResponsesPayload(options: GenerateOptions, attachments: Pick<AttachmentStore, 'readImage'> & Partial<Pick<AttachmentStore, 'imageLimits'>>, localRawImages?: LocalRawImageOptions, outputVerbosity?: CodexOutputVerbosity | null): Promise<ResponsesPayload>;
//# sourceMappingURL=responses-mapper.d.ts.map