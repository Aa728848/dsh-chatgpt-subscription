import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DISABLED_OUTPUT_TEXT,
  NOTIFY_USER_TOOL,
  PROGRESS_UPDATE_DESCRIPTION,
  createProgressUpdateTool,
} from '../src/host/progress-updates/tool.ts'
import type { ProgressUpdate } from '../src/host/progress-updates/store.ts'

/** 最小执行上下文：工具只读 agent，这里给一个空对象即可。 */
const exec = {} as ToolRunContext

/** 收集 push 进来的进展，模拟宿主侧接收端。 */
function sink() {
  const updates: ProgressUpdate[] = []
  return {
    updates,
    backend: { push: (update: ProgressUpdate) => { updates.push(update); return true } },
  }
}

/** 参数 schema 里本用例要读的两处：字段表与必填表。 */
interface ParameterShape {
  properties: Record<string, unknown>
  required?: string[]
}

describe('progress_update tool definition', () => {
  it('工具名就是契约里的常量', () => {
    const tool = createProgressUpdateTool({ isEnabled: () => true })
    expect(NOTIFY_USER_TOOL).toBe('progress_update')
    expect(tool.name).toBe('progress_update')
  })

  it('schema 声明的就是契约里的两个字段：message 必填，title 可选', () => {
    const tool = createProgressUpdateTool({ isEnabled: () => true })
    const parameters = tool.parameters as unknown as ParameterShape
    expect(Object.keys(parameters.properties).sort()).toEqual(['message', 'title'])
    expect(parameters.required).toEqual(['message'])
  })

  it('工具描述讲清什么时候用，并写明 subagent 的边界', () => {
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('Report progress to the user without ending your turn')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('state your plan near the beginning')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('meaningful conclusion')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('long wait')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('blocks you')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('run as a subagent')
    expect(PROGRESS_UPDATE_DESCRIPTION).toContain('not the same as finishing the overall task')
    expect(createProgressUpdateTool({ isEnabled: () => true }).description).toBe(PROGRESS_UPDATE_DESCRIPTION)
  })

  it('canonical output 只有 displayed 一个布尔字段', () => {
    const tool = createProgressUpdateTool({ isEnabled: () => true })
    expect(tool.output.schema).toMatchObject({
      type: 'object',
      properties: { displayed: { type: 'boolean' } },
    })
  })
})

describe('progress_update execute', () => {
  it('开关关闭时返回 displayed:false，且不抛错、不写接收端', async () => {
    const collector = sink()
    const tool = createProgressUpdateTool({ isEnabled: () => false, sink: () => collector.backend })
    const value = await tool.execute({ message: 'hello' }, exec)
    expect(value).toEqual({ displayed: false })
    expect(collector.updates).toHaveLength(0)
  })

  it('开关关闭时的 output 文本是契约里那句话', async () => {
    const tool = createProgressUpdateTool({ isEnabled: () => false })
    const value = await tool.execute({ message: 'hello' }, exec)
    const rendered = tool.output.render({ message: 'hello' }, value as never)
    expect(rendered).toEqual([{ type: 'text', text: 'Progress updates are disabled; the update was not displayed.' }])
    expect(DISABLED_OUTPUT_TEXT).toBe('Progress updates are disabled; the update was not displayed.')
  })

  it('开关打开时把进展交给接收端并返回 displayed:true', async () => {
    const collector = sink()
    const tool = createProgressUpdateTool({ isEnabled: () => true, sink: () => collector.backend })
    const value = await tool.execute({ title: '定位到根因', message: '正文' }, exec)
    expect(value).toEqual({ displayed: true })
    expect(collector.updates).toHaveLength(1)
    expect(collector.updates[0]).toMatchObject({ title: '定位到根因', message: '正文' })
    expect(typeof collector.updates[0]?.at).toBe('number')
  })

  it('开关状态每次调用重新求值', async () => {
    const collector = sink()
    let enabled = false
    const tool = createProgressUpdateTool({ isEnabled: () => enabled, sink: () => collector.backend })
    expect(await tool.execute({ message: 'a' }, exec)).toEqual({ displayed: false })
    enabled = true
    expect(await tool.execute({ message: 'b' }, exec)).toEqual({ displayed: true })
    expect(collector.updates).toHaveLength(1)
  })

  it('title 缺省或空白时按无标题处理，不写进 store', async () => {
    const collector = sink()
    const tool = createProgressUpdateTool({ isEnabled: () => true, sink: () => collector.backend })
    await tool.execute({ message: 'a' }, exec)
    await tool.execute({ title: '   ', message: 'b' }, exec)
    expect(collector.updates[0]?.title).toBeUndefined()
    expect(collector.updates[1]?.title).toBeUndefined()
  })

  it('接收端未接线时返回 displayed:false 而不是抛错', async () => {
    const tool = createProgressUpdateTool({ isEnabled: () => true })
    expect(await tool.execute({ message: 'a' }, exec)).toEqual({ displayed: false })
  })

  it('接收端拒绝展示时如实返回 displayed:false', async () => {
    const tool = createProgressUpdateTool({
      isEnabled: () => true,
      sink: () => ({ push: () => false }),
    })
    expect(await tool.execute({ message: 'a' }, exec)).toEqual({ displayed: false })
  })

  it('把来源会话写进 source 字段', async () => {
    const collector = sink()
    const tool = createProgressUpdateTool({
      isEnabled: () => true,
      sink: () => collector.backend,
      sourceOf: () => 'session-1',
    })
    await tool.execute({ message: 'a' }, exec)
    expect(collector.updates[0]?.source).toBe('session-1')
  })
})
