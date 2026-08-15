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

  it('recognizes screenshot-style Code rows without hiding the final answer', async () => {
    const dispose = installProcessFolding({ autoCollapseMs: 10 })
    document.body.innerHTML = `
      <main>
        <p id="ctx">上下文注入 · AGENTS.md, CLAUDE.md</p>
        <p id="think">Think · **Planning initial codebase inspection**</p>
        <div id="code"># Code · Read project README overview
          <div id="read">Read · README.md</div>
        </div>
        <div id="code2"># Code · Check project location and working tree
          <div id="pwsh">Pwsh · Check project location and working tree</div>
        </div>
        <section id="answer"><h2>项目概览</h2><p>正式回答内容。</p></section>
      </main>
    `

    await vi.runOnlyPendingTimersAsync()
    const ctx = document.getElementById('ctx')
    const think = document.getElementById('think')
    const code = document.getElementById('code')
    const answer = document.getElementById('answer')

    expect(ctx?.classList.contains('dsh-codex-process-group-head')).toBe(true)
    expect(code?.classList.contains('dsh-codex-process-row')).toBe(true)

    await vi.advanceTimersByTimeAsync(10)
    expect(ctx?.classList.contains('dsh-codex-process-group-collapsed')).toBe(true)
    expect(ctx?.getAttribute('data-dsh-codex-process-title')).toBe('运行了命令')
    expect(think?.classList.contains('dsh-codex-process-group-hidden')).toBe(true)
    expect(code?.classList.contains('dsh-codex-process-group-hidden')).toBe(true)
    expect(answer?.classList.contains('dsh-codex-process-row')).toBe(false)
    expect(answer?.classList.contains('dsh-codex-process-group-hidden')).toBe(false)

    dispose()
  })

  it('folds process rows rendered as disclosure buttons', async () => {
    const dispose = installProcessFolding({ autoCollapseMs: 10 })
    document.body.innerHTML = `
      <main>
        <button id="think" type="button"><span>Think · Planning project inspection steps</span></button>
        <button id="code" type="button"><span># Code · Read project package metadata</span></button>
        <button id="read" type="button"><span>Read · package.json</span></button>
        <section id="answer"><h2>项目概览</h2></section>
      </main>
    `

    await vi.runOnlyPendingTimersAsync()
    const think = document.getElementById('think')
    const code = document.getElementById('code')

    expect(think?.classList.contains('dsh-codex-process-group-head')).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(think?.classList.contains('dsh-codex-process-group-collapsed')).toBe(true)
    expect(code?.classList.contains('dsh-codex-process-group-hidden')).toBe(true)

    think?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(think?.classList.contains('dsh-codex-process-group-collapsed')).toBe(false)

    dispose()
  })
})
