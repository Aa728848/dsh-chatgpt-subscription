/**
 * Provider-wire mapping for the two Command Code provider endpoints.
 *
 * The API serves Anthropic-format models on `/messages` and everything else on
 * `/chat/completions`; it validates the split and rejects a model sent to the
 * wrong endpoint. Both wires are mapped here so one adapter can serve the whole
 * catalog, and both streams are normalized into DSH's block/delta vocabulary.
 *
 * https://commandcode.ai/blog/command-code-provider-api
 */
import { type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { CommandCodeWire } from '../../shared/command-code-contracts.ts';
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
 * Base64 image payload one request may carry.
 *
 * Both Command Code endpoints are proxies: the body is forwarded to whichever
 * upstream serves the model, so the bound has to hold for the strictest of
 * them. 12 MB matches what this plugin already allows its Gemini route and
 * keeps the conversation text, tool schemas, and system prompt inside the same
 * body.
 */
export declare const MAX_REQUEST_IMAGE_BYTES: number;
/**
 * Replace the oldest inline images with a text placeholder once one request
 * would carry more than {@link MAX_REQUEST_IMAGE_BYTES} of base64 image data.
 * Durable history is untouched; only the request about to be sent changes.
 */
export declare function offloadOldestRequestImages(options: GenerateOptions): GenerateOptions;
/**
 * Read every durable `{ type: 'image', attachment }` block one request carries.
 * An unreadable image resolves to `unavailable` rather than disappearing, so
 * the model is told the picture is missing instead of answering about a blank.
 */
export declare function resolveRequestImages(options: GenerateOptions, attachments: AttachmentImageReader | undefined, signal?: AbortSignal): Promise<ResolvedRequestImages>;
/** Drop the JSON-Schema keywords provider gateways reject or ignore. */
export declare function stripMetaSchema(schema: unknown): Record<string, unknown>;
/** Build one `/chat/completions` body. */
export declare function buildOpenAIRequest(options: GenerateOptions, images?: ResolvedRequestImages): Record<string, unknown>;
/** Reasoning budget a thinking-enabled request may spend, given its output cap. */
export declare function thinkingBudgetFor(effort: string | undefined, maxTokens: number): number | undefined;
/** Build one `/messages` body. */
export declare function buildAnthropicRequest(options: GenerateOptions, images?: ResolvedRequestImages): Record<string, unknown>;
/** Build the body for whichever endpoint serves `modelId`. */
export declare function buildRequest(options: GenerateOptions, wire: CommandCodeWire, images?: ResolvedRequestImages): Record<string, unknown>;
/** One tool call accumulating across `chat/completions` deltas. */
interface PendingToolCall {
    blockIndex: number;
    id: string;
    name: string;
    arguments: string;
    started: boolean;
}
export interface CommandCodeStreamState {
    wire: CommandCodeWire;
    blocks: ContentBlock[];
    current: {
        index: number;
        type: 'text' | 'reasoning';
        text: string;
    } | null;
    /** wire tool index -> accumulating call (OpenAI route). */
    toolCalls: Map<number, PendingToolCall>;
    /** anthropic content-block index -> our block index. */
    contentIndexes: Map<number, number>;
    /** anthropic content index of the block currently open. */
    openContentIndex: number | null;
    hasContent: boolean;
    hasToolCall: boolean;
    finishReason: string | null;
    done: boolean;
    finished: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    sawUsage: boolean;
}
export declare function createStreamState(wire: CommandCodeWire): CommandCodeStreamState;
/** Feed one SSE `data:` payload from `/chat/completions`. */
export declare function processOpenAIStreamLine(line: string, state: CommandCodeStreamState): StreamChunk[];
/** Feed one SSE `data:` payload from `/messages`. */
export declare function processAnthropicStreamLine(line: string, state: CommandCodeStreamState): StreamChunk[];
/** Flush every open block, then emit usage and the terminal finish. */
export declare function closeStream(state: CommandCodeStreamState): StreamChunk[];
/** Model families whose stream never carried a terminal event. */
export declare function assertStreamComplete(state: CommandCodeStreamState): void;
export {};
//# sourceMappingURL=mapper.d.ts.map