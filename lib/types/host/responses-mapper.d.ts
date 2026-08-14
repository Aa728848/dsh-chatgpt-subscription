import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
export interface ResponsesPayload extends Record<string, unknown> {
    model: string;
    input: Array<Record<string, unknown>>;
    stream: true;
    store: false;
}
export declare function buildResponsesPayload(options: GenerateOptions, attachments: Pick<AttachmentStore, 'readImage'>): Promise<ResponsesPayload>;
//# sourceMappingURL=responses-mapper.d.ts.map