import type { Context } from '@deepseek-ai/cordis'

/**
 * DSH_COMPAT_REMOVE(persistent-bash-prompt-mismatch)
 *
 * Temporary compatibility shim for DSH 0.1.0-rc.6. The persistent bash tool
 * (`@deepseek-ai/dsh-tool-bash-persistent`) configures the bash shell PS1 to
 * `__DSH_PERSISTENT_BASH_PROMPT__ `, while the underlying PTY backend
 * (`@deepseek-ai/dsh-terminal-bash`) only checks for a hardcoded `dsh> `
 * prompt with a 6-character truncation limit.
 *
 * When the prompt does not match, `promptTextSeen` remains false and the PTY
 * session falls back to the 3.5s idle silence timeout (`idleSilenceMs: 3000ms`
 * + `handoffGraceMs: 500ms`) on every command execution.
 *
 * This compatibility module patches the PTY session `onData` handler so that
 * both `dsh> ` and `__DSH_PERSISTENT_BASH_PROMPT__ ` (and its trimmed variants)
 * satisfy `promptTextSeen`, restoring instant 50ms readiness settling.
 *
 * Remove this module, its installation in `src/index.ts`, and its focused test
 * once upstream aligns `CONTROLLED_PROMPT` with persistent bash tools.
 */
export const DSH_BASH_PROMPT_COMPAT_MARKER =
  '__dshChatgptSubscriptionBashPromptCompatV1' as const

export const KNOWN_CONTROLLED_PROMPTS = [
  'dsh> ',
  'dsh>',
  '__DSH_PERSISTENT_BASH_PROMPT__ ',
  '__DSH_PERSISTENT_BASH_PROMPT__',
] as const

const MAX_PROMPT_BUFFER_LENGTH = 64

export function isKnownControlledPrompt(tail: string): boolean {
  if (!tail) return false
  const cleaned = tail.replaceAll(/[\x00-\x1f\x7f]/g, '').trim()
  for (const known of KNOWN_CONTROLLED_PROMPTS) {
    const cleanedKnown = known.replaceAll(/[\x00-\x1f\x7f]/g, '').trim()
    if (cleaned === cleanedKnown) return true
  }
  return false
}

interface SanitizerResult {
  text: string
  prompt?: boolean
  promptTail?: string
}

interface SanitizerLike {
  push(data: string): SanitizerResult
}

export interface PtySessionLike {
  sanitizer: SanitizerLike
  promptSeen: boolean
  promptTextSeen: boolean
  promptTail: string
  lastOutputAt: number
  appendOutput(text: string): void
  onData(data: string): void
}

interface SharedPatchRecord {
  originalOnData: (data: string) => void
  owners: number
}

type MarkedOnData = ((data: string) => void) & {
  [DSH_BASH_PROMPT_COMPAT_MARKER]?: SharedPatchRecord
}

export function patchSessionOnData(target: { prototype?: PtySessionLike } | PtySessionLike): () => void {
  const obj = (target as { prototype?: PtySessionLike }).prototype ?? (target as PtySessionLike)
  if (!obj || typeof obj.onData !== 'function') {
    return () => {}
  }

  const existing = (obj.onData as MarkedOnData)[DSH_BASH_PROMPT_COMPAT_MARKER]
  if (existing) {
    existing.owners += 1
    return () => {
      existing.owners -= 1
      if (existing.owners <= 0 && (obj.onData as MarkedOnData)[DSH_BASH_PROMPT_COMPAT_MARKER] === existing) {
        obj.onData = existing.originalOnData
      }
    }
  }

  const originalOnData = obj.onData
  const record: SharedPatchRecord = {
    originalOnData,
    owners: 1,
  }

  function wrapper(this: PtySessionLike, data: string): void {
    const sanitized = this.sanitizer.push(data)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, MAX_PROMPT_BUFFER_LENGTH - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) {
        this.promptTail = `${this.promptTail}\0`
      }
      this.promptTextSeen = isKnownControlledPrompt(this.promptTail)
    }
  }

  Object.defineProperty(wrapper, DSH_BASH_PROMPT_COMPAT_MARKER, { value: record })
  obj.onData = wrapper

  return () => {
    record.owners -= 1
    if (record.owners <= 0 && obj.onData === wrapper) {
      obj.onData = originalOnData
    }
  }
}

interface BackendLike {
  type?: string
  createSession?: (terminal: unknown, config: unknown) => PtySessionLike
  spawn?: (spec: unknown) => Promise<PtySessionLike>
}

interface TerminalsServiceLike {
  backends?: Map<string, BackendLike>
  registerBackend?: (backend: BackendLike) => () => void
}

/**
 * Installs the persistent bash prompt compatibility patch onto registered and
 * future PTY backends via Cordis scoped injection.
 */
export function installBashPromptCompat(ctx: Context): () => void {
  // Use Cordis scoped inject to safely declare the 'terminals' dependency
  // without failing when 'terminals' is absent in the host context.
  const fiber = ctx.inject(['terminals'], (subCtx: Context) => {
    const terminals = (subCtx as unknown as { terminals?: TerminalsServiceLike }).terminals
    if (!terminals) return

    const disposers: Array<() => void> = []

    const patchBackend = (backend: BackendLike | undefined): void => {
      if (!backend) return
      if (typeof backend.createSession === 'function') {
        const originalCreate = backend.createSession
        backend.createSession = function (terminal: unknown, config: unknown) {
          const session = originalCreate.call(this, terminal, config)
          if (session) {
            patchSessionOnData(session)
          }
          return session
        }
        disposers.push(() => {
          if (backend.createSession) {
            backend.createSession = originalCreate
          }
        })
      }
    }

    if (terminals.backends) {
      for (const backend of terminals.backends.values()) {
        patchBackend(backend)
      }
    }

    if (typeof terminals.registerBackend === 'function') {
      const originalRegister = terminals.registerBackend
      terminals.registerBackend = function (backend: BackendLike) {
        patchBackend(backend)
        return originalRegister.call(this, backend)
      }
      disposers.push(() => {
        if (terminals.registerBackend) {
          terminals.registerBackend = originalRegister
        }
      })
    }

    subCtx.effect(() => () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch (error) {
          subCtx.logger?.warn?.(
            '[dsh-chatgpt-subscription] Could not remove bash prompt compatibility: ' +
              (error instanceof Error ? error.message : String(error)),
          )
        }
      }
    }, 'dsh-chatgpt-subscription: bash prompt compatibility cleanup')
  })

  return () => {
    try {
      fiber?.dispose?.()
    } catch {
      // Best-effort cleanup
    }
  }
}
