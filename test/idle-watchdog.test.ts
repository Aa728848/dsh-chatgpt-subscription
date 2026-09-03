import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { wrapStreamWithWatchdog } from '../src/host/common/idle-watchdog.ts'

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
})
