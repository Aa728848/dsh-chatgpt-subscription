// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProgressDashboard } from '../../src/client/features/progress-updates/dashboard.tsx'
import { createHostProgressSource } from '../../src/client/features/progress-updates/host-source.ts'
import type { ProgressTask, ProgressUpdate } from '../../src/client/features/progress-updates/contracts.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const updates: ProgressUpdate[] = [
  { id: 'one', title: '定位问题', message: '找到 **计数器** 根因', at: Date.parse('2026-11-26T13:00:00Z'), source: 'root' },
  { id: 'two', title: '完成修复', message: '补充回归测试', at: Date.parse('2026-11-26T13:20:00Z'), source: 'child' },
]
const tasks: ProgressTask[] = [
  { id: 'task-1', content: '检查旧面板', status: 'completed' },
  { id: 'task-2', content: '实现工作脉络', activeForm: '正在实现工作脉络', status: 'in_progress' },
]

let root: Root | undefined
let container: HTMLDivElement | undefined

async function render(element: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(element) })
}

async function click(selector: string) {
  const element = container?.querySelector(selector)
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
})

describe('进展工作脉络', () => {
  it('任务页使用只读 Todo 计数，归档页按本地时间桶分组', async () => {
    await render(<ProgressDashboard updates={updates} tasks={tasks} />)
    await click('[data-dsh-part="tab-tasks"]')
    expect(container?.textContent).toContain('已完成 1 / 2 项任务')
    expect(container?.textContent).toContain('正在实现工作脉络')
    await click('[data-dsh-part="tab-archive"]')
    expect(container?.querySelectorAll('details')).toHaveLength(1)
    expect(container?.textContent).toContain('2 条进展')
  })

  it('搜索过滤列表，复制与导出只操作浏览器数据', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const createObjectURL = vi.fn(() => 'blob:progress')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await render(<ProgressDashboard updates={updates} />)
    const input = container?.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, '修复')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container?.querySelectorAll('[data-dsh-part="update"]')).toHaveLength(1)
    await click('[data-dsh-part="update-copy"]')
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('完成修复'))
    await click('[data-dsh-part="export-updates"]')
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('进展和任务共享一次宿主响应，旧响应缺 tasks 时保持空列表', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      json: async () => ({ updates, tasks }),
    }))
    const source = createHostProgressSource('session-a', {
      fetch: fetchImpl as never,
      timers: {
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: handle => { globalThis.clearTimeout(handle as never) },
      },
    })
    const stop = source.subscribe(() => {})
    await vi.waitFor(() => { expect(source.getSnapshot()).toHaveLength(2) })
    expect(source.getTasksSnapshot()).toEqual(tasks)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('api/dsh-progress-updates/updates?session=session-a')
    stop()
    source.stop()
  })
})