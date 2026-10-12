import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * The same budget under the name every provider adapter passes it by.
 *
 * Six provider `types.ts` files each declared their own
 * `STREAM_IDLE_TIMEOUT_MS = 300_000`, so one line ended up importing a sibling
 * line's copy just to name the same number. This alias is the single home: the
 * value is unchanged, and an adapter that took the constant from another line
 * can now take it from here without renaming its local usage.
 */
export const STREAM_IDLE_TIMEOUT_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS

/**
 * 传输层活动上报器。
 *
 * 计时以「收到传输层数据」为判据，而不是「解析器是否 yield 了可展示片段」：
 * 业务过滤、展示缓冲、摘要截断都只影响展示，不改变连接是否活着。
 */
export interface StreamActivity {
  /** 上报一次不产生消费端可见 chunk 的传输活动，用于重新计时。 */
  pulse(): void
}

/** 看门狗包裹的流工厂：第二个参数可选，旧的单参调用点仍然合法。 */
export type WatchdogSource<T> = (signal: AbortSignal, activity: StreamActivity) => AsyncIterable<T>

/**
 * 为异步流包裹可复位的空闲超时看门狗。
 * 当流式 chunk 产出之间的间隔超过指定阈值时，主动终止并抛出带有 TIMEOUT 的 LlmError。
 */
export async function* wrapStreamWithWatchdog<T>(
  source: WatchdogSource<T>,
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
  // 参数更少的函数可以赋值给参数更多的签名，所以历史单参调用点继续编译通过，
  // 而需要区分「传输有数据」与「有可展示 chunk」的线路可以接住 activity。
  const activity: StreamActivity = { pulse: () => { watchdog.pulse() } }
  const iterator = source(watchdog.signal, activity)[Symbol.asyncIterator]()

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
