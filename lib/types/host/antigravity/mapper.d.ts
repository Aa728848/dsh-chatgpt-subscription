import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { type AntigravityModelDef } from './types.ts';
export declare function sanitizeToolCallId(id: string, fallbackName: string): string;
export declare function convertMessages(options: GenerateOptions, model: AntigravityModelDef, runtimeModel: string): Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
}>;
export declare function stripMetaSchema(schema: unknown): unknown;
export declare function convertTools(tools: GenerateOptions['tools']): Array<Record<string, unknown>> | undefined;
export declare function mapToolChoiceMode(toolChoice: unknown): string;
export declare function getMaxOutputTokens(modelId: string, runtimeModel: string): number;
export declare function buildRequest(options: GenerateOptions, model: AntigravityModelDef, projectId: string, runtimeModel: string, effort?: string): Record<string, unknown>;
export interface StreamState {
    blocks: ContentBlock[];
    replayBlocks: Array<Record<string, unknown>>;
    currentBlock: {
        type: 'text' | 'reasoning';
        text: string;
        thinkingSignature?: unknown;
        textSignature?: unknown;
    } | null;
    hasContent: boolean;
    hasToolCall: boolean;
}
export declare function createStreamState(): StreamState;
export declare function processStreamLine(line: string, state: StreamState): StreamChunk[];
export declare function closeStream(state: StreamState): StreamChunk[];
//# sourceMappingURL=mapper.d.ts.map