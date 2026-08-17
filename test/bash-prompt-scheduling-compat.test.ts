import { describe, expect, it, vi } from 'vitest'
import {
  DSH_BASH_PROMPT_COMPAT_MARKER,
  installBashPromptCompat,
  isKnownControlledPrompt,
  patchSessionOnData,
  type PtySessionLike,
} from '../src/host/bash-prompt-scheduling-compat.ts'

function createMockSession() {
  const outputs: string[] = []
  const session: PtySessionLike = {
    sanitizer: {
      push: vi.fn((data: string) => {
        if (data.includes('133;D;')) {
          const match = data.match(/133;D;.*?(?:\x07|\x1b\\)(.*)/s)
          const tail = match ? match[1] : data.split('133;D;')[1] ?? ''
          return { text: data, prompt: true, promptTail: tail }
        }
        return { text: data }
      }),
    },
    promptSeen: false,
    promptTextSeen: false,
    promptTail: '',
    lastOutputAt: 0,
    appendOutput: vi.fn((text: string) => outputs.push(text)),
    onData(data: string) {
      // Simulating original unpatched behavior with hardcoded 6-char limit and 'dsh> '
      const sanitized = this.sanitizer.push(data)
      this.appendOutput(sanitized.text)
      if (sanitized.prompt) {
        this.promptSeen = true
        this.promptTail = ''
        this.lastOutputAt = Date.now()
      }
      if (this.promptSeen && sanitized.promptTail !== undefined) {
        const remaining = Math.max(0, 6 - this.promptTail.length)
        this.promptTail += sanitized.promptTail.slice(0, remaining)
        if (sanitized.promptTail.length > remaining) {
          this.promptTail = 'dsh> \0'
        }
        this.promptTextSeen = this.promptTail === 'dsh> '
      }
    },
  }
  return { session, outputs }
}

describe('DSH persistent bash prompt mismatch compatibility', () => {
  describe('isKnownControlledPrompt', () => {
    it('matches default dsh prompt and trimmed variant', () => {
      expect(isKnownControlledPrompt('dsh> ')).toBe(true)
      expect(isKnownControlledPrompt('dsh>')).toBe(true)
    })

    it('matches persistent bash prompt and trimmed variant', () => {
      expect(isKnownControlledPrompt('__DSH_PERSISTENT_BASH_PROMPT__ ')).toBe(true)
      expect(isKnownControlledPrompt('__DSH_PERSISTENT_BASH_PROMPT__')).toBe(true)
    })

    it('rejects unknown or invalid prompts', () => {
      expect(isKnownControlledPrompt('')).toBe(false)
      expect(isKnownControlledPrompt('bash-5.1$ ')).toBe(false)
      expect(isKnownControlledPrompt('root@sandbox:/# ')).toBe(false)
    })
  })

  describe('patchSessionOnData', () => {
    it('identifies __DSH_PERSISTENT_BASH_PROMPT__ without 6-char truncation', () => {
      const { session } = createMockSession()
      const dispose = patchSessionOnData(session)

      session.onData('\x1b]133;D;0\x07__DSH_PERSISTENT_BASH_PROMPT__ ')

      expect(session.promptSeen).toBe(true)
      expect(session.promptTextSeen).toBe(true)
      expect(session.promptTail).toBe('__DSH_PERSISTENT_BASH_PROMPT__ ')

      dispose()
    })

    it('still matches default dsh> prompt', () => {
      const { session } = createMockSession()
      const dispose = patchSessionOnData(session)

      session.onData('\x1b]133;D;0\x07dsh> ')

      expect(session.promptSeen).toBe(true)
      expect(session.promptTextSeen).toBe(true)
      expect(session.promptTail).toBe('dsh> ')

      dispose()
    })

    it('handles chunked promptTail data delivery', () => {
      const { session } = createMockSession()
      const dispose = patchSessionOnData(session)

      // First chunk: prompt marker with part of prompt tail
      session.sanitizer.push = vi.fn()
        .mockReturnValueOnce({ text: '', prompt: true, promptTail: '__DSH_PERSISTENT_' })
        .mockReturnValueOnce({ text: '', promptTail: 'BASH_PROMPT__ ' })

      session.onData('chunk-1')
      expect(session.promptSeen).toBe(true)
      expect(session.promptTextSeen).toBe(false)

      session.onData('chunk-2')
      expect(session.promptTextSeen).toBe(true)
      expect(session.promptTail).toBe('__DSH_PERSISTENT_BASH_PROMPT__ ')

      dispose()
    })

    it('restores original onData implementation when disposed', () => {
      const { session } = createMockSession()
      const originalOnData = session.onData
      const dispose = patchSessionOnData(session)

      expect(session.onData).not.toBe(originalOnData)
      expect((session.onData as never)[DSH_BASH_PROMPT_COMPAT_MARKER]).toBeDefined()

      dispose()
      expect(session.onData).toBe(originalOnData)

      // Verify unpatched behavior fails for long persistent prompt
      session.onData('\x1b]133;D;0\x07__DSH_PERSISTENT_BASH_PROMPT__ ')
      expect(session.promptTextSeen).toBe(false)
    })
  })

  describe('installBashPromptCompat', () => {
    it('patches existing and newly registered backends in ctx.terminals via scoped inject', () => {
      const session1 = createMockSession().session
      const session2 = createMockSession().session

      const existingBackend = {
        type: 'shell',
        createSession: vi.fn((_terminal?: unknown, _config?: unknown) => session1),
      }

      const backendsMap = new Map([['shell', existingBackend]])
      const registerBackend = vi.fn((b) => {
        backendsMap.set(b.type, b)
        return () => backendsMap.delete(b.type)
      })

      const cleanupCallbacks: Array<() => void> = []
      const mockSubCtx = {
        logger: { warn: vi.fn() },
        terminals: {
          backends: backendsMap,
          registerBackend,
        },
        effect: vi.fn((factory) => {
          const disposer = factory()
          if (typeof disposer === 'function') cleanupCallbacks.push(disposer)
        }),
      }

      const fiberDispose = vi.fn(() => {
        while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.()
      })

      const mockCtx = {
        inject: vi.fn((_deps, cb) => {
          cb(mockSubCtx)
          return { dispose: fiberDispose }
        }),
      }

      const dispose = installBashPromptCompat(mockCtx as never)

      // Check existing backend creates patched sessions
      const created1 = existingBackend.createSession({}, {})
      created1.onData('\x1b]133;D;0\x07__DSH_PERSISTENT_BASH_PROMPT__ ')
      expect(created1.promptTextSeen).toBe(true)

      // Register new backend and verify it also creates patched sessions
      const newBackend = {
        type: 'custom-shell',
        createSession: vi.fn((_terminal?: unknown, _config?: unknown) => session2),
      }
      mockSubCtx.terminals.registerBackend(newBackend)

      const created2 = newBackend.createSession({}, {})
      created2.onData('\x1b]133;D;0\x07__DSH_PERSISTENT_BASH_PROMPT__ ')
      expect(created2.promptTextSeen).toBe(true)

      dispose()
      expect(fiberDispose).toHaveBeenCalled()
    })

    it('does not crash when terminals service is not loaded in host context', () => {
      const mockCtx = {
        inject: vi.fn((_deps, _cb) => {
          // terminals not available in this profile, callback is not called
          return { dispose: vi.fn() }
        }),
      }

      expect(() => {
        const dispose = installBashPromptCompat(mockCtx as never)
        dispose()
      }).not.toThrow()
    })
  })
})
