// @vitest-environment jsdom
/**
 * 客户端 `code_run` 语法高亮卡片与槽位注册验收测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { apply as applyClient } from '../src/client/index.tsx'
import { CodeRunToolView, flattenCodeRunOutput } from '../src/client/codemode/CodeRunToolView.tsx'
import { SHIKI_TOKEN_COLORS, tokenizeCodeLines } from '../src/client/codemode/highlight.ts'
import { CODE_RUN_TOOL_NAME } from '../src/client/codemode/tool-name.ts'
import { TRANSPORT_TOOL_NAME } from '../src/host/codemode/transport.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

describe('code_run 客户端语法高亮与槽位对齐', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('客户端工具名与宿主侧传输工具名严格一致，并在 tool.call.toolview 注册', () => {
    expect(CODE_RUN_TOOL_NAME).toBe(TRANSPORT_TOOL_NAME)
    const registrations: { name: string; key?: string; component: unknown }[] = []
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      get: () => undefined,
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
        subscribe: () => () => undefined,
      },
      modelDirectories: {
        directoryFor: () => ({ store: {}, load: async () => undefined }),
      },
      conversation: {},
      sessions: {},
      remote: {},
      slots: {
        inject: (_slot: string, cb: () => unknown) => { cb() },
        register: (spec: { name: string; key?: string }, component: unknown) => {
          registrations.push({ name: spec.name, key: spec.key, component })
          return () => undefined
        },
      },
    }
    applyClient(ctx as never)
    const match = registrations.find((entry) => entry.name === 'tool.call.toolview' && entry.key === 'code_run')
    expect(match).toBeDefined()
    expect(match?.component).toBe(CodeRunToolView)
  })

  it('语法高亮分词器：无损还原嵌套模板字符串与正则表达式，并赋予 --shiki-* 主题变量', () => {
    const sample = 'const patterns = [/catalogVersion:"([^"]+)"/g];\nconst r = await tools.win_bash({ command: `node -e \'${patterns.length}\'` }); return r;'
    const lines = tokenizeCodeLines(sample, 'typescript')
    const reconstructed = lines.map((line) => line.map((token) => token.text).join('')).join('\n')
    expect(reconstructed).toBe(sample)

    const flat = lines.flat()
    expect(flat.some((token) => token.text === 'const' && token.kind === 'keyword')).toBe(true)
    expect(flat.some((token) => token.text === 'await' && token.kind === 'keyword')).toBe(true)
    expect(flat.some((token) => token.text === 'win_bash' && token.kind === 'function')).toBe(true)
    expect(flat.some((token) => token.text.includes('/catalogVersion:') && token.kind === 'string-expression')).toBe(true)
    // 模板字符串插值 `${patterns.length}` 内部恢复为代码 token，而非整段吃进 string
    expect(flat.some((token) => token.text === 'patterns' && token.kind === 'plain')).toBe(true)
    expect(SHIKI_TOKEN_COLORS.keyword).toContain('var(--shiki-token-keyword')

    const pySample = '# comment\nasync def run():\n  return await tools.read({"file_path": "a.py"})'
    const pyLines = tokenizeCodeLines(pySample, 'python')
    expect(pyLines.map((line) => line.map((t) => t.text).join('')).join('\n')).toBe(pySample)
    expect(pyLines[0]?.[0]?.kind).toBe('comment')
    expect(pyLines[1]?.some((t) => t.text === 'async' && t.kind === 'keyword')).toBe(true)
  })

  it('CodeRunToolView：折叠行展示「代码 · description」，展开后展示高亮纯源码与独立输出区，不再暴露原始输入 JSON', () => {
    const code = 'const res = await tools.read({ file_path: "package.json" })\nreturn res'
    const argsRaw = JSON.stringify({
      code,
      description: '提取官方 catalogVersion',
      timeoutMs: 120000,
    })
    const inspect = vi.fn()

    act(() => {
      root.render(createElement(CodeRunToolView, {
        callId: 'call-1',
        toolName: 'code_run',
        phase: 'result',
        inspect,
        block: {
          callId: 'call-1',
          kind: 'tool-result',
          isError: false,
          call: { name: 'code_run', argsRaw },
          content: [{ type: 'text', text: 'b21583dbdf3e90f95560cf976a9d952223' }],
        },
      }))
    })

    // 折叠态：标题是「代码」，摘要是 description，不包含原始 JSON 键名 timeoutMs
    expect(container.textContent).toContain('代码')
    expect(container.textContent).toContain('提取官方 catalogVersion')
    expect(container.querySelector('.dshc-code-card')).toBeNull()

    // 点击标题行展开
    const row = container.querySelector('[data-disclosure-row]') as HTMLElement
    expect(row).not.toBeNull()
    act(() => {
      row.click()
    })

    const pre = container.querySelector('pre.shiki') as HTMLElement
    expect(pre).not.toBeNull()
    // 代码区只渲染剥离后的纯源码，不渲染外层 JSON 包装的 timeoutMs: 120000
    expect(pre.textContent).toBe(code)
    expect(pre.textContent).not.toContain('timeoutMs')
    // 关键字 span 带有 --shiki-token-keyword 颜色
    const spans = Array.from(pre.querySelectorAll('span'))
    expect(spans.some((el) => el.textContent === 'const' && el.getAttribute('style')?.includes('--shiki-token-keyword'))).toBe(true)

    // 独立输出区展示结果文本
    const outLabel = container.querySelector('.dshc-code-io-label')
    const outText = container.querySelector('.dshc-code-io-text')
    expect(outLabel?.textContent).toBe('输出')
    expect(outText?.textContent).toBe('b21583dbdf3e90f95560cf976a9d952223')

    // 换行按钮切换 data-code-wrap
    const card = container.querySelector('.dshc-code-card') as HTMLElement
    expect(card.getAttribute('data-code-wrap')).toBe('true')
    const wrapBtn = container.querySelector('.dshc-code-action') as HTMLButtonElement
    act(() => {
      wrapBtn.click()
    })
    expect(card.getAttribute('data-code-wrap')).toBe('false')

    // 轨迹检查按钮触发回调
    const inspectBtn = container.querySelector('.dshc-code-inspect-btn') as HTMLButtonElement
    act(() => {
      inspectBtn.click()
    })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('流式 preparing 阶段与错误状态正常渲染', () => {
    act(() => {
      root.render(createElement(CodeRunToolView, {
        callId: 'call-2',
        phase: 'preparing',
        block: {
          callId: 'call-2',
          phase: 'preparing',
          args: {
            text: (key: string) => (key === 'description' ? '流式生成摘要' : undefined),
          },
        },
      }))
    })
    expect(container.textContent).toContain('流式生成摘要')
    expect(container.querySelector('[data-expandable="true"]')).toBeNull()

    act(() => {
      root.render(createElement(CodeRunToolView, {
        callId: 'call-2',
        phase: 'result',
        block: {
          callId: 'call-2',
          kind: 'tool-result',
          isError: true,
          call: { name: 'code_run', argsRaw: JSON.stringify({ code: 'throw new Error("bad")', description: '原摘要' }) },
          content: [{ type: 'text', text: 'program failed (runtime): bad\nsecond line' }],
        },
      }))
    })
    const summary = container.querySelector('.dshc-code-summary')
    expect(summary?.getAttribute('data-state')).toBe('error')
    expect(summary?.textContent).toBe('program failed (runtime): bad')
  })

  it('flattenCodeRunOutput：对齐 DSH 0.2.2-rc.2 resultText，带末尾换行符的相邻块不产生双空行', () => {
    const out = flattenCodeRunOutput({
      kind: 'tool-result',
      content: [
        { type: 'text', text: 'first line\n' },
        { type: 'text', text: 'second line\n' },
      ],
    })
    expect(out).toBe('first line\nsecond line\n')
  })
})
