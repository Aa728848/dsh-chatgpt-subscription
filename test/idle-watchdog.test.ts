import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { wrapStreamWithWatchdog, type StreamActivity } from '../src/host/common/idle-watchdog.ts'

const require = createRequire(import.meta.url)
const timeoutVersion = (require('@deepseek-ai/dsh-timeout/package.json') as { version: string }).version
const [timeoutMajor = 0, timeoutMinor = 0, timeoutPatch = 0] = timeoutVersion.split('.').map((part) => Number.parseInt(part, 10))
const supportsDeadlineRace = timeoutMajor > 0
  || timeoutMajor === 0 && (timeoutMinor > 2 || timeoutMinor === 2 && timeoutPatch >= 1)
const itDeadlineRace = supportsDeadlineRace ? it : it.skip

describe('idle-watchdog', () => {
  it('yields all values when stream emits within idle interval', async () => {
    async function* fastStream(): AsyncIterable<string> {
      yield 'hello'
      await new Promise((r) => setTimeout(r, 10))
      yield 'world'
    }

    const collected: string[] = []
    for await (const chunk of wrapStreamWithWatchdog(() => fastStream(), undefined, 200, 'TEST_TIMEOUT', 'test')) {
      collected.push(chunk)
    }

    expect(collected).toEqual(['hello', 'world'])
  })

  it('throws timeout LlmError when chunk delay exceeds idle timeout', async () => {
    async function* slowStream(signal: AbortSignal): AsyncIterable<string> {
      yield 'first'
      // 模拟上游卡死挂起，等待很久
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        })
      })
      yield 'second'
    }

    const collected: string[] = []
    let caught: unknown

    try {
      for await (const chunk of wrapStreamWithWatchdog((sig) => slowStream(sig), undefined, 50, 'TEST_TIMEOUT', 'test')) {
        collected.push(chunk)
      }
    } catch (err) {
      caught = err
    }

    expect(collected).toEqual(['first'])
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('TIMEOUT')
    expect((caught as LlmError).message).toContain('stream idle timeout after 50ms')
  })

  it('handles external cancellation correctly', async () => {
    const controller = new AbortController()

    async function* cancellableStream(signal: AbortSignal): AsyncIterable<string> {
      yield 'chunk1'
      if (signal.aborted) throw signal.reason
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        const timer = setTimeout(resolve, 500)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        })
      })
      yield 'chunk2'
    }

    const collected: string[] = []
    let caught: unknown

    try {
      for await (const chunk of wrapStreamWithWatchdog((sig) => cancellableStream(sig), controller.signal, 1000, 'TEST_TIMEOUT', 'test')) {
        collected.push(chunk)
        controller.abort(new Error('User cancelled'))
      }
    } catch (err) {
      caught = err
    }

    expect(collected).toEqual(['chunk1'])
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('ABORTED')
  })
  it('rearms on transport pulses while the source yields nothing, then times out once they stop', async () => {
    // 上游持续发数据，但解析器什么都不产出（状态帧、被截断的摘要都属于这一类）。
    // 计时必须按「传输层收到数据」复位，否则一条活着的连接会被误判成静默。
    const idleMs = 80
    const pulseWindowMs = 250
    let abortReason: unknown
    let pulses = 0
    let pulseWindowEndedAt: number | undefined
    let abortedAt: number | undefined
    const silentSource = async function* (
      signal: AbortSignal,
      activity: StreamActivity,
    ): AsyncIterable<string> {
      signal.addEventListener('abort', () => {
        abortReason = signal.reason
        abortedAt = Date.now()
      })
      const pulse = setInterval(() => {
        pulses += 1
        activity.pulse()
      }, 25)
      try {
        // 远超阈值：只靠 pulse 才撑得过去。
        await new Promise((resolve) => setTimeout(resolve, pulseWindowMs))
      } finally {
        clearInterval(pulse)
        pulseWindowEndedAt = Date.now()
      }
      // 停止上报后彻底静默，看门狗必须按 timeoutCode 报错。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(signal.reason)
        })
      })
      yield 'never'
    }

    const collected: string[] = []
    let caught: unknown
    try {
      for await (const chunk of wrapStreamWithWatchdog(silentSource, undefined, idleMs, 'TEST_TIMEOUT', 'test')) {
        collected.push(chunk)
      }
    } catch (err) {
      caught = err
    }

    // 脉冲真的被送到了看门狗，并且第一阶段一次都没有误超时。
    expect(pulses).toBeGreaterThan(4)
    expect(abortedAt).toBeDefined()
    // 关键断言：超时只发生在停止 pulse 之后。若 pulse 不复位计时，看门狗会在
    // 第一个 idleMs 到点时就中止 signal，这条断言随之失败。
    expect(abortedAt!).toBeGreaterThanOrEqual(pulseWindowEndedAt!)
    expect(collected).toEqual([])
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('TIMEOUT')
    expect((caught as LlmError).message).toContain(`stream idle timeout after ${idleMs}ms`)
    // 传给看门狗的 timeoutCode 才是这次超时的身份，source 侧看到的正是它。
    expect(abortReason).toMatchObject({ code: 'TEST_TIMEOUT', timeoutMs: idleMs })
  })

  async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<'CLEANUP_HUNG'>((resolve) => {
      timer = setTimeout(() => { resolve('CLEANUP_HUNG') }, ms)
    })
    try {
      return await Promise.race([promise, guard])
    } finally {
      clearTimeout(timer)
    }
  }

  it('does not await a stuck iterator return after a source failure', async () => {
    let returnCalled = false
    const iterator: AsyncIterator<string> = {
      next: () => Promise.reject(new Error('source failed')),
      return: () => {
        returnCalled = true
        return new Promise<IteratorResult<string>>(() => {})
      },
    }
    const source = (): AsyncIterable<string> => ({
      [Symbol.asyncIterator]: () => iterator,
    })
    const run = (async () => {
      try {
        for await (const _chunk of wrapStreamWithWatchdog(source, undefined, 1_000, 'TEST_TIMEOUT', 'test')) {
          // The source rejects before producing a chunk.
        }
      } catch (error) {
        return error
      }
    })()

    const outcome = await settleWithin(run, 100)
    expect(returnCalled).toBe(true)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('source failed')
  })

  itDeadlineRace('settles an abandoned demand without awaiting its queued cleanup', async () => {
    async function* abandoned(_signal: AbortSignal): AsyncIterable<string> {
      yield 'first'
      await new Promise(() => {})
    }
    const collected: string[] = []
    const run = (async () => {
      try {
        for await (const chunk of wrapStreamWithWatchdog(abandoned, undefined, 30, 'TEST_TIMEOUT', 'test')) {
          collected.push(chunk)
        }
      } catch (error) {
        return error
      }
    })()

    const outcome = await settleWithin(run, 250)
    expect(collected).toEqual(['first'])
    expect(outcome).toBeInstanceOf(LlmError)
    expect((outcome as LlmError).code).toBe('TIMEOUT')
  })
})
