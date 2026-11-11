import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * How long one stream may go without a single byte before it is called stalled.
 *
 * Strictly INSIDE the transport's own deadline on purpose. undici answers a
 * stalled HTTP/2 stream at exactly 300 s, so the 300 s every line used to carry
 * never decided anything: the watchdog and the transport expired together, the
 * transport error won the race, and the turn paid the full five minutes of
 * silence before DSH could retry — reported as a severed connection rather than
 * as a stalled one. Two minutes is measured rather than guessed: over the 104
 * requests of the session that prompted this value, the longest wait from a step
 * starting to its first chunk was 65 s (a 210k-token prompt), and the longest
 * silence once chunks were flowing was 6.4 s across 6,539 measured gaps. The
 * adapters also pulse the watchdog when the response headers arrive, so a slow
 * prefill is budgeted apart from in-stream silence instead of being read as a
 * dead stream.
 *
 * `ollama/types.ts` deliberately keeps a longer budget: local inference is
 * compute-bound, and a large prompt can legitimately take minutes to answer.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * The same budget under the name every provider adapter passes it by.
 *
 * Six provider `types.ts` files each declare their own
 * `STREAM_IDLE_TIMEOUT_MS`, so one line ended up importing a sibling line's copy
 * just to name the same number. This alias is the single home: an adapter that
 * took the constant from another line can take it from here without renaming its
 * local usage, and a line whose budget is its own (ollama) says so in its own
 * `types.ts`.
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

/** 看门狗的一段窗口；两段之间的分界是「消费者拿到第一个值」。 */
interface WatchdogPhase {
  readonly watchdog: ReturnType<typeof idleWatchdog>
  readonly budgetMs: number
  /** 这段预算只管第一个值之前，超时文案要说清是「还没出首帧」。 */
  readonly beforeFirstValue: boolean
}

/**
 * 超时的说法。
 *
 * 两段窗口必须能从错误文案里分辨出来：同一句「stream idle timeout」既可能是
 * 模型还在思考（首帧之前），也可能是流已经开始却卡住了，前者该放宽、后者该重试，
 * 而修完之后下一次复发只靠这句话定位。
 */
function idleTimeoutError(providerTag: string, phase: WatchdogPhase, cause?: unknown): LlmError {
  const message = phase.beforeFirstValue
    ? `${providerTag} stream idle timeout after ${phase.budgetMs}ms before the first chunk`
    : `${providerTag} stream idle timeout after ${phase.budgetMs}ms`
  return cause === undefined
    ? new LlmError(message, 'TIMEOUT')
    : new LlmError(message, 'TIMEOUT', { cause })
}

/**
 * 为异步流包裹可复位的空闲超时看门狗。
 *
 * 当流式 chunk 产出之间的间隔超过 `timeoutMs` 时，主动终止并抛出带有 TIMEOUT 的
 * LlmError。
 *
 * 可选的 `firstValueTimeoutMs` 给「第一个值之前」换一个窗口：响应头回到、首个
 * chunk 尚未产出的那段静默，是模型在预填充或思考，长度随模型与上下文变化，与
 * 「流已经开始却卡住」不是同一件事。首个 chunk 一出去就切回 `timeoutMs`，所以
 * 放宽首帧窗口不会让真正卡住的流多等。省略该参数（或传入与 `timeoutMs` 相等的
 * 值）时只有一段窗口，行为与此前完全一致。
 */
export async function* wrapStreamWithWatchdog<T>(
  source: WatchdogSource<T>,
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  timeoutCode: string = STREAM_IDLE_TIMEOUT_CODE,
  providerTag: string = 'llm',
  firstValueTimeoutMs?: number,
): AsyncIterable<T> {
  const consumer = new AbortController()
  const upstream = upstreamSignal === undefined
    ? consumer.signal
    : AbortSignal.any([upstreamSignal, consumer.signal])
  const phases: WatchdogPhase[] = firstValueTimeoutMs === undefined || firstValueTimeoutMs === timeoutMs
    ? [{ watchdog: idleWatchdog(upstream, timeoutMs, timeoutCode), budgetMs: timeoutMs, beforeFirstValue: false }]
    : [
      {
        watchdog: idleWatchdog(upstream, firstValueTimeoutMs, timeoutCode),
        budgetMs: firstValueTimeoutMs,
        beforeFirstValue: true,
      },
      { watchdog: idleWatchdog(upstream, timeoutMs, timeoutCode), budgetMs: timeoutMs, beforeFirstValue: false },
    ]
  // 两段的信号都要进传输层：不管哪一段到点，连接都必须被中止。信号在 source
  // 构造时就定型了，所以两段一起建、一起融合，而不是切换时重建一个 source。
  const signal = phases.length === 1
    ? phases[0]!.watchdog.signal
    : AbortSignal.any([upstream, ...phases.map((phase) => phase.watchdog.signal)])
  let active = 0
  // 参数更少的函数可以赋值给参数更多的签名，所以历史单参调用点继续编译通过，
  // 而需要区分「传输有数据」与「有可展示 chunk」的线路可以接住 activity。
  const activity: StreamActivity = { pulse: () => { phases[active]!.watchdog.pulse() } }
  const iterator = source(signal, activity)[Symbol.asyncIterator]()
  /** 到点的那一段。两段都查：到点不一定是不在等待的那一段。 */
  const expired = (): WatchdogPhase | undefined =>
    phases.find((phase) => timeoutOf(phase.watchdog.signal, timeoutCode) !== undefined)

  let exhausted = false
  try {
    while (true) {
      const result = await phases[active]!.watchdog.next(iterator)
      const stalled = expired()
      if (stalled !== undefined) throw idleTimeoutError(providerTag, stalled)
      if (result.done) {
        exhausted = true
        return
      }
      if (active === 0 && phases.length > 1) {
        // 首帧到了：这一段窗口的使命结束，之后按 chunk 之间的预算计时。
        phases[0]!.watchdog[Symbol.dispose]()
        active = 1
      }
      yield result.value
    }
  } catch (error) {
    const stalled = expired()
    if (stalled !== undefined) throw idleTimeoutError(providerTag, stalled, error)
    if (upstreamSignal?.aborted) {
      throw new LlmError(`${providerTag} request aborted by caller`, 'ABORTED', { cause: error })
    }
    throw error
  } finally {
    consumer.abort(`${providerTag} stream consumer stopped`)
    if (!exhausted) {
      // An abandoned demand can stay pending forever; awaiting the generator's
      // queued return would re-hang the outcome that the deadline just settled.
      void iterator.return?.(undefined).catch(() => {})
    }
    for (const phase of phases) phase.watchdog[Symbol.dispose]()
  }
}
