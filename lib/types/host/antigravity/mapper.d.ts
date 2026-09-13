import { type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { type AntigravityModelDef } from './types.ts';
export declare function sanitizeToolCallId(id: string, fallbackName: string): string;
/** Attachment seam this route needs: verified bytes for one durable image. */
export type AttachmentImageReader = Pick<AttachmentStore, 'readImage'>;
/** One durable user image resolved for an in-flight request, or proven unreadable. */
export type ResolvedRequestImage = {
    readonly kind: 'inline';
    readonly mediaType: string;
    readonly data: string;
} | {
    readonly kind: 'unavailable';
};
/** Resolved images keyed by durable attachment id; consumed by one request build. */
export type ResolvedRequestImages = ReadonlyMap<string, ResolvedRequestImage>;
/**
 * Read every durable `{ type: 'image', attachment }` block one request carries.
 *
 * This provider declares image input, so DSH hands those blocks to the adapter
 * unchanged instead of projecting them to text, and Gemini can only receive them
 * as `inlineData` bytes. An image that cannot be read resolves to
 * `unavailable` rather than disappearing: `contentToUserParts` then leaves the
 * model a text marker, because a turn that silently loses its image is far
 * harder to diagnose than one that says so.
 *
 * @param options - the exact request about to be built.
 * @param attachments - durable attachment store; absent when the host wired none.
 * @param signal - cancellation, forwarded to every attachment read.
 * @returns one resolution per distinct attachment id, empty when there is no image.
 */
export declare function resolveRequestImages(options: GenerateOptions, attachments: AttachmentImageReader | undefined, signal?: AbortSignal): Promise<ResolvedRequestImages>;
export declare function convertMessages(options: GenerateOptions, model: AntigravityModelDef, runtimeModel: string, images?: ResolvedRequestImages): Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
}>;
export declare function stripMetaSchema(schema: unknown): unknown;
export declare function convertTools(tools: GenerateOptions['tools']): Array<Record<string, unknown>> | undefined;
export declare function mapToolChoiceMode(toolChoice: unknown): string;
export declare function getMaxOutputTokens(modelId: string, runtimeModel: string): number;
export declare function buildRequest(options: GenerateOptions, model: AntigravityModelDef, projectId: string, runtimeModel: string, effort?: string, images?: ResolvedRequestImages): Record<string, unknown>;
export interface StreamState {
    blocks: ContentBlock[];
    replayBlocks: Array<{
        parts: Array<Record<string, unknown>>;
    }>;
    currentBlock: {
        index: number;
        type: 'text' | 'reasoning';
        text: string;
    } | null;
    hasContent: boolean;
    hasToolCall: boolean;
    usageMetadata: Record<string, number> | null;
    finishReason?: string;
    done: boolean;
    finished: boolean;
}
export declare function createStreamState(): StreamState;
export declare function processStreamLine(line: string, state: StreamState): StreamChunk[];
export declare function closeStream(state: StreamState): StreamChunk[];
//# sourceMappingURL=mapper.d.ts.map