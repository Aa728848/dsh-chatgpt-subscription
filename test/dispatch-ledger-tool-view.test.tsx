// @vitest-environment jsdom
/**
 * 派发卡片的验收：**头部被拆成结构、结果与拒绝码不被吞掉、原始参数仍拿得回来**。
 *
 * 这张卡占用了 `tool.call.toolview` 的 `subagent` / `subagent_fork` 两个 key，
 * 而「占用即替换整行」——所以本文件钉住的是：换掉通用行之后，信息一条都没少。
 *
 * 与仓库其余 UI 测试一致：createRoot + act 手搓，不引入 @testing-library。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, type FunctionComponent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  MandateToolView,
  parseDispatchPrompt,
  type MandateToolViewProps,
} from '../src/client/dispatch-ledger/MandateToolView.tsx'
import { zh } from '../src/client/dispatch-ledger/locales.ts'

const PROMPT = '\`\`\`dsh-mandate-v2\n'
  + JSON.stringify({
    v: 2,
    kind: 'dispatch',
    brief_id: 'b-46-fields',
    run_id: 'r-f-1',
    idem: 'i-f-1',
    mandate_version: 1,
    prompt_ref: 'p-527aefc3ca10c4a6',
    policy: { id: 'dsh-dispatch-ledger', version: '1', sha256: '5'.repeat(64) },
    task: ['task://fields-coverage'],
    boundary: ['src/host/**'],
    followup: ['ctx://plan-v3'],
    parent_mandate: null,
  }, null, 2)
  + '\n\`\`\`\n补齐 19 目录字段覆盖。'

const ARGS = JSON.stringify({
  description: '补齐 19 目录字段覆盖',
  name: 'fields-coverage',
  provider: 'opendesign',
  model: 'deepseek-v4.1-flash-eco',
  reasoning_effort: 'high',
  prompt: PROMPT,
})

function expandedDisclosure() {
  return { expanded: true, toggle: () => undefined }
}

let root: Root | undefined
let container: HTMLElement | undefined
const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
  container = undefined
})

function render(props: MandateToolViewProps): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const View = MandateToolView as unknown as FunctionComponent<MandateToolViewProps>
  act(() => { root?.render(createElement(View, props)) })
  return container
}

function dispatched(resultText: string, isError: boolean, toolName = 'subagent'): MandateToolViewProps {
  return {
    toolName,
    phase: 'result',
    useDisclosure: expandedDisclosure,
    block: {
      kind: 'result',
      isError,
      content: [{ type: 'text', text: resultText }],
      argsRaw: ARGS,
    },
  }
}

describe('派发卡片：把头部拆成结构', () => {
  it('brief / run / idem / 路由 与三类条目都看得见', () => {
    const view = render(dispatched('started subagent fields-coverage', false))
    const text = view.textContent ?? ''
    expect(text).toContain(zh.mandateTitle)
    expect(text).toContain('b-46-fields')
    expect(text).toContain('r-f-1')
    expect(text).toContain('i-f-1')
    expect(text).toContain('opendesign/deepseek-v4.1-flash-eco')
    expect(text).toContain('high')
    expect(text).toContain('task://fields-coverage')
    expect(text).toContain('src/host/**')
    expect(text).toContain('ctx://plan-v3')
    expect(text).toContain('补齐 19 目录字段覆盖。')
    expect(text).toContain('started subagent fields-coverage')
  })

  it('结果区独立呈现：被拒时把 MANDATE_* 摆在明面上并标红', () => {
    const denial = 'Error: DISPATCH_LEDGER_V2:MANDATE_DUPLICATE: the namespace ... is already claimed'
    const view = render(dispatched(denial, true))
    const result = view.querySelector('p.dshc-mandate-result')
    expect(result?.textContent).toBe(denial)
    expect((result as HTMLElement | null)?.dataset.error).toBe('true')
    expect(view.querySelector('.dshc-mandate-root')?.getAttribute('data-state')).toBe('error')
    expect(view.textContent).toContain(zh.mandateFailed)
  })

  it('原始参数仍然拿得回来（换呈现不等于丢证据）', () => {
    const view = render(dispatched('started subagent', false))
    expect(view.querySelector('[data-role="raw-text"]')).toBeNull()
    const button = view.querySelector('[data-role="raw-toggle"]') as HTMLElement
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const raw = view.querySelector('[data-role="raw-text"]')
    expect(raw?.textContent).toBe(PROMPT)
  })

  it('没有 mandate 头时说明「仅审计」，正文照常显示', () => {
    const view = render({
      toolName: 'subagent',
      phase: 'result',
      useDisclosure: expandedDisclosure,
      block: {
        kind: 'result',
        isError: false,
        content: [{ type: 'text', text: 'started subagent x' }],
        argsRaw: JSON.stringify({ description: 'x', prompt: 'just a task' }),
      },
    })
    const text = view.textContent ?? ''
    expect(text).toContain(zh.mandateNoHeader)
    expect(text).toContain('just a task')
  })

  it('fork 的标题与普通派发区分开', () => {
    const view = render(dispatched('started subagent fields-coverage', false, 'subagent_fork'))
    expect(view.textContent).toContain(zh.mandateTitleFork)
  })
})

describe('派发卡片：头部解析', () => {
  it('围栏在最前面时拆出头部与正文', () => {
    const parsed = parseDispatchPrompt(PROMPT)
    expect(parsed.header?.['brief_id']).toBe('b-46-fields')
    expect(parsed.body).toBe('补齐 19 目录字段覆盖。')
    expect(parsed.rawPrompt).toBe(PROMPT)
  })

  it('没有围栏、围栏未闭合、或 JSON 坏掉时退回原文', () => {
    expect(parseDispatchPrompt('just a task').header).toBeNull()
    expect(parseDispatchPrompt('\`\`\`dsh-mandate-v2\n{"v":2').header).toBeNull()
    expect(parseDispatchPrompt('\`\`\`dsh-mandate-v2\n{bad}\n\`\`\`\nbody').header).toBeNull()
  })
})
