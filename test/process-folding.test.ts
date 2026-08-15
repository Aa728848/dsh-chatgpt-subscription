// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProcessFolding } from '../src/client/process-folding.ts'

describe('process folding', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => Number(setTimeout(() => callback(performance.now()), 0)))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('auto-collapses a whole contiguous process group and lets users expand it again', async () => {
    const dispose = installProcessFolding({ autoCollapseMs: 10 })
    document.body.innerHTML = `
      <main>
        <div id="think">Think · Planning a very long operation</div>
        <div id="cmd">Pwsh · Get-Content src/client/index.tsx</div>
        <p id="answer">Here is the final answer.</p>
      </main>
    `

    await vi.runOnlyPendingTimersAsync()
    const think = document.getElementById('think')
    const cmd = document.getElementById('cmd')
    const answer = document.getElementById('answer')
    expect(think?.classList.contains('dsh-codex-process-group-head')).toBe(true)
    expect(cmd?.classList.contains('dsh-codex-process-row')).toBe(true)

    await vi.advanceTimersByTimeAsync(10)
    expect(think?.classList.contains('dsh-codex-process-group-collapsed')).toBe(true)
    expect(think?.getAttribute('data-dsh-codex-process-title')).toBe('运行了命令')
    expect(cmd?.classList.contains('dsh-codex-process-group-hidden')).toBe(true)
    expect(answer?.classList.contains('dsh-codex-process-group-hidden')).toBe(false)

    think?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(think?.classList.contains('dsh-codex-process-group-collapsed')).toBe(false)
    expect(cmd?.classList.contains('dsh-codex-process-group-hidden')).toBe(false)

    dispose()
  })
})
