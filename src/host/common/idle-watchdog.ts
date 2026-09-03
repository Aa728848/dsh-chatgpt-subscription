import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * 为异步流包裹可复位的空闲超时看门狗。
 * 当流式 chunk 产出之间的间隔超过指定阈值时，主动终止并抛出带有 TIMEOUT 的 LlmError。
 */
export async function* wrapStreamWithWatchdog<T>(
  source: (signal: AbortSignal) => AsyncIterable<T>,
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  timeoutCode: string = STREAM_IDLE_TIMEOUT_CODE,
  providerTag: string = 'llm',
): AsyncIterable<T> {
  const consumer = new AbortController()
  const upstream = upstreamSignal === undefined
    ? consumer.signal
    : AbortSignal.any([upstreamSignal, consumer.signal])
  const watchdog = idleWatchdog(upstream, timeoutMs, timeoutCode)
  const iterator = source(watchdog.signal)[Symbol.asyncIterator]()

  let exhausted = false
  try {
    while (true) {
      const result = await watchdog.next(iterator)
      if (timeoutOf(watchdog.signal, timeoutCode) !== undefined) {
        throw new LlmError(`${providerTag} stream idle timeout after ${timeoutMs}ms`, 'TIMEOUT')
      }
      if (result.done) {
        exhausted = true
        return
      }
      yield result.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, timeoutCode) !== undefined) {
      throw new LlmError(`${providerTag} stream idle timeout after ${timeoutMs}ms`, 'TIMEOUT', { cause: error })
    }
    if (upstreamSignal?.aborted) {
      throw new LlmError(`${providerTag} request aborted by caller`, 'ABORTED', { cause: error })
    }
    throw error
  } finally {
    consumer.abort(`${providerTag} stream consumer stopped`)
    if (!exhausted) {
      try {
        await iterator.return?.(undefined)
      } catch {
        // 忽略迭代器清理时的异常
      }
    }
    watchdog[Symbol.dispose]()
  }
}
