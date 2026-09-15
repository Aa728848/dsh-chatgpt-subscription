/**
 * Provider-wire mapping for the Kimi Code coding endpoints.
 *
 * Two surfaces serve the same models:
 *
 * - the OpenAI-compatible `/coding/v1/chat/completions`, which is what the
 *   official CLI configures for its managed provider and therefore the default
 *   here; and
 * - the Anthropic-compatible `/coding/v1/messages?beta=true`, which authenticates
 *   with `x-api-key` rather than a bearer token.
 *
 * Both are mapped here, and both streams are normalized into DSH's block/delta
 * vocabulary.
 *
 * Two Kimi-specific behaviours shape the request builders:
 *
 * 1. Thinking is selected with `reasoning_effort` and accepts only
 *    low/high/max; anything else the client sends is answered with HTTP 400, so
 *    a caller's broader effort vocabulary is narrowed here rather than passed
 *    through. Thinking off is expressed as `thinking: {type: "disabled"}`.
 * 2. When thinking is on, Kimi requires `reasoning_content` on an assistant
 *    message that also carries tool calls — the service answers 400
 *    "thinking is enabled but reasoning_content is missing" otherwise. Reasoning
 *    blocks are therefore replayed on the OpenAI wire, unlike the sibling routes
 *    which drop them.
 *
 * See https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
 */
import { type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { KimiCodeReasoningEffort, KimiCodeWire } from '../../shared/kimi-code-contracts.ts';
/**
 * Kimi caps a tool-call id at 64 characters and rejects a longer one.
 *
 * DSH ids are usually short, but a provider that prefixes them with a session
 * or turn marker can exceed the bound, so a long id is truncated
 * deterministically rather than allowed to fail the whole request.
 */
export declare function clampToolCallId(id: string): string;
/**
 * Service limits on the request shape, from the official error reference.
 *
 * Both were documented as hard 400s, so exceeding them costs the whole turn
 * rather than degrading gracefully — which is why the request is trimmed to fit
 * instead of being sent and rejected.
 */
export declare const MAX_STOP_SEQUENCES = 5;
export declare const MAX_STOP_SEQUENCE_BYTES = 32;
/**
 * Whether one request asks the service to keep reasoning across turns.
 *
 * Kimi's models reason by default and the official CLI ships Preserved Thinking
 * ON (`[thinking] keep = "all"`), which is what its own error reference assumes
 * when it demands `reasoning_content` on every assistant message. An
 * environment opt-out exists for a deployment that would rather not pay for the
 * replayed reasoning tokens.
 */
export declare function preserveThinkingEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Trim stop sequences to what the service accepts.
 *
 * At most five entries, each at most 32 bytes; a longer sequence is dropped
 * rather than truncated, because a shortened stop string would halt generation
 * at the wrong place — silently changing the answer is worse than not stopping.
 */
export declare function stopSequences(stop: readonly string[] | undefined): string[];
/**
 * Narrow a caller's effort onto the levels Kimi accepts.
 *
 * DSH exposes low/high/max/none for these models, but a conversation can hold
 * an effort chosen for a different provider, so the broader vocabulary the rest
 * of the plugin uses is mapped rather than rejected: an unknown value would be
 * answered with HTTP 400 and fail the turn.
 */
export declare function mapReasoningEffort(effort: string | undefined | null): KimiCodeReasoningEffort | undefined;
/**
 * Thinking-token budget one Anthropic-route level asks for.
 *
 * Kimi's Anthropic surface takes the standard `thinking` block, so the budget is
 * derived from the same three levels the OpenAI surface uses.
 */
export declare function thinkingBudgetFor(effort: KimiCodeReasoningEffort | undefined, maxTokens: number): number | undefined;
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
 * Kimi rejects a request whose total message size exceeds 2 MB with a 400, and
 * the image bytes share that budget with the conversation text, tool schemas,
 * and system prompt — so the bound is deliberately the smaller of the two
 * documented limits rather than the largest body the transport would accept.
 */
export declare const MAX_REQUEST_IMAGE_BYTES = 1500000;
/** Message-body ceiling the service documents for one request. */
export declare const MAX_MESSAGE_BODY_BYTES = 2097152;
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
/**
 * Rough prompt size for one request, in tokens.
 *
 * Derived from the serialized text with the usual ~4 characters per token
 * heuristic. It is deliberately an estimate: the purpose is only to keep
 * `max_tokens` from making a request the service will reject outright, and the
 * service's own count remains authoritative. Undefined is returned for an empty
 * request so the caller leaves the cap alone rather than clamping against zero.
 */
export declare function estimatedInputTokens(options: GenerateOptions): number | undefined;
/** Build one `/chat/completions` body. */
export declare function buildOpenAIRequest(options: GenerateOptions, images?: ResolvedRequestImages, preserveThinking?: boolean): Record<string, unknown>;
/**
 * Stable identifier for the conversation this request belongs to.
 *
 * Derived from the first user turn rather than a fresh value per request, so it
 * stays identical across the steps of one session and changes when a new
 * conversation starts.
 */
export declare function promptCacheKey(options: GenerateOptions): string | undefined;
/** Build one `/v1/messages` body. */
export declare function buildAnthropicRequest(options: GenerateOptions, images?: ResolvedRequestImages): Record<string, unknown>;
/** Build the body for whichever endpoint serves `wire`. */
export declare function buildRequest(options: GenerateOptions, wire: KimiCodeWire, images?: ResolvedRequestImages, preserveThinking?: boolean): Record<string, unknown>;
/**
 * Reject a request the service would answer with its 2 MB body 400.
 *
 * This is the most frequently reported 400 on the coding endpoint, and it is
 * worth catching locally for two reasons: the message can name the actual
 * remedy (DSH's compaction), and a request that cannot succeed should not be
 * sent at all. The measured size is the real serialized body, so it accounts
 * for tool schemas and inlined images the caller cannot easily estimate.
 */
export declare function assertRequestBodyFits(body: Record<string, unknown>): void;
/** One tool call accumulating across `chat/completions` deltas. */
interface PendingToolCall {
    blockIndex: number;
    id: string;
    name: string;
    arguments: string;
    started: boolean;
}
export interface KimiCodeStreamState {
    wire: KimiCodeWire;
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
export declare function createStreamState(wire: KimiCodeWire): KimiCodeStreamState;
/** Feed one SSE `data:` payload from `/chat/completions`. */
export declare function processOpenAIStreamLine(line: string, state: KimiCodeStreamState): StreamChunk[];
/** Feed one SSE `data:` payload from `/v1/messages`. */
export declare function processAnthropicStreamLine(line: string, state: KimiCodeStreamState): StreamChunk[];
/**
 * Rolling per-process view of how well the prefix cache is working.
 *
 * Kimi's cache is automatic and content-hash based, so the only way to know
 * whether a session is actually benefiting is to watch the read ratio. It is a
 * diagnostic: nothing here changes a request.
 */
export interface KimiCodeCacheStats {
    /** Requests that reported usage. */
    requests: number;
    /** Prompt tokens that were served from cache. */
    cachedTokens: number;
    /** Prompt tokens that had to be processed fresh. */
    freshTokens: number;
    /** Output tokens, which reasoning is billed against. */
    outputTokens: number;
    /** Prompt tokens the provider counted as cache writes (always 0 on this route). */
    cacheWriteTokens: number;
}
/** Record one request's usage into the rolling totals. */
export declare function recordCacheStats(state: KimiCodeStreamState): void;
/** Current rolling totals, plus the derived hit ratio. */
export declare function getCacheStats(): KimiCodeCacheStats & {
    hitRatio: number | null;
};
/** Test seam and an explicit reset for a new session. */
export declare function resetCacheStats(): void;
/** Flush every open block, then emit usage and the terminal finish. */
export declare function closeStream(state: KimiCodeStreamState): StreamChunk[];
/** Model families whose stream never carried a terminal event. */
export declare function assertStreamComplete(state: KimiCodeStreamState): void;
export {};
//# sourceMappingURL=mapper.d.ts.map