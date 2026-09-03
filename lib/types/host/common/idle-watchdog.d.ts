export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
export declare const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/**
 * 为异步流包裹可复位的空闲超时看门狗。
 * 当流式 chunk 产出之间的间隔超过指定阈值时，主动终止并抛出带有 TIMEOUT 的 LlmError。
 */
export declare function wrapStreamWithWatchdog<T>(source: (signal: AbortSignal) => AsyncIterable<T>, upstreamSignal: AbortSignal | undefined, timeoutMs?: number, timeoutCode?: string, providerTag?: string): AsyncIterable<T>;
//# sourceMappingURL=idle-watchdog.d.ts.map