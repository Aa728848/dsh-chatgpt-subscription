// @vitest-environment node
/**
 * `code_run` 的参数容错：那 16 条 `codemode: invalid …` 报错里，一半是可以救回来的。
 *
 * 审计（`docs/codemode-code-run-error-audit.md`）里量到两种真实形态：
 *
 * 1. **两段 JSON 拼接**——模型想在一次调用里既汇报又执行，
 *    参数变成 `{"title":…,"message":…}{"code":…}`，整段解析必失败（实测 7/7 可救）；
 * 2. **别名键 / 纯程序文本**——源码被写进 `program` / `source`，或干脆只有一段源码。
 *
 * 这里钉住三件事：程序必须跑起来、简报要补发、拒绝时错误文本要带原始片段。
 *
 * @module test/codemode-argument-recovery
 */

import { describe, expect, it } from 'vitest'

import { createRules } from '../src/host/codemode/rules.ts'
import { createTransportDefinition } from '../src/host/codemode/transport.ts'

const rules = createRules({})

/** 一次调用看到的入参，测试用它断言「程序跑了什么、简报发了什么」。 */
interface Probe {
  readonly programs: string[]
  readonly progress: unknown[]
  readonly titles: (string | undefined)[]
}

/**
 * 造一个最小运行环境并跑一次程序传输。
 *
 * @param args - 工具收到的原始参数。
 * @param options - 工具清单与运行时行为。
 * @returns 传输输出与探针。
 */
async function runTransport(
  args: unknown,
  options: { catalog?: readonly { name: string }[]; failProgress?: boolean } = {},
): Promise<{ output: { result?: unknown; logs: string[] }; probe: Probe }> {
  const probe: Probe = { programs: [], progress: [], titles: [] }
  const host = {
    catalog: () => options.catalog ?? [{ name: 'progress_update', description: 'progress' }, { name: 'read' }],
    runtime: () => ({
      language: 'typescript',
      programFormat: 'function-body',
      async run(request: { program: string }) {
        probe.programs.push(request.program)
        return { value: 'ok', logs: [] }
      },
    }),
    stateOwner: () => ({}),
    releaseOwner: async () => undefined,
    async callTool(request: { name: string; args: unknown }) {
      if (request.name !== 'progress_update') return { value: 'tool' }
      if (options.failProgress === true) throw new Error('progress service unavailable')
      probe.progress.push(request.args)
      return { value: 'Progress update displayed.' }
    },
  }
  const definition = createTransportDefinition(host as never, rules)
  probe.titles.push((definition as { presentCall?: (value: unknown) => { title?: string } | undefined })
    .presentCall?.(args)?.title)
  const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ result?: unknown; logs: string[] }>)(
    args,
    { callId: 'outer', signal: new AbortController().signal },
  )
  return { output, probe }
}

describe('参数容错：两段拼接', () => {
  it('救回第二段的程序，并把第一段当简报补发', async () => {
    const fused = JSON.stringify({ title: '已定位：竞态在 apply 时', message: '现在改 session-faces' })
      + JSON.stringify({ code: 'return 1', description: 'fix the race' })
    const { output, probe } = await runTransport(fused)
    expect(probe.programs).toEqual(['return 1'])
    expect(probe.progress).toEqual([{ title: '已定位：竞态在 apply 时', message: '现在改 session-faces' }])
    expect(probe.titles[0]).toBe('fix the race')
    expect(output.result).toBe('ok')
  })

  it('先执行顺序不受影响：简报先发，程序后跑', async () => {
    const order: string[] = []
    const host = {
      catalog: () => [{ name: 'progress_update' }, { name: 'read' }],
      runtime: () => ({
        language: 'typescript',
        programFormat: 'function-body',
        async run() {
          order.push('program')
          return { value: 'ok', logs: [] }
        },
      }),
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      async callTool() {
        order.push('narration')
        return { value: 'Progress update displayed.' }
      },
    }
    const definition = createTransportDefinition(host as never, rules)
    const fused = JSON.stringify({ title: 't', message: 'm' }) + JSON.stringify({ code: 'return 1', description: 'd' })
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)(fused, {
      callId: 'outer', signal: new AbortController().signal,
    })
    expect(order).toEqual(['narration', 'program'])
  })

  it('简报发不出去时绝不影响程序', async () => {
    const fused = JSON.stringify({ title: 't', message: 'm' }) + JSON.stringify({ code: 'return 1', description: 'd' })
    const { output, probe } = await runTransport(fused, { failProgress: true })
    expect(probe.programs).toEqual(['return 1'])
    expect(output.result).toBe('ok')
  })

  it('清单里没有 progress_update 时静默跳过补发', async () => {
    const fused = JSON.stringify({ title: 't', message: 'm' }) + JSON.stringify({ code: 'return 1', description: 'd' })
    const { output, probe } = await runTransport(fused, { catalog: [{ name: 'read' }] })
    expect(probe.programs).toEqual(['return 1'])
    expect(probe.progress).toEqual([])
    expect(output.result).toBe('ok')
  })
})

describe('参数容错：别名与纯文本', () => {
  it('源码写在 program / source 等别名键上时照常执行', async () => {
    const { output, probe } = await runTransport({ program: 'return 1', description: 'alias key' })
    expect(probe.programs).toEqual(['return 1'])
    expect(output.result).toBe('ok')
  })

  it('只有一段纯程序文本时当源码执行，标题从首行兜底', async () => {
    const program = '// count TODO markers\nconst r = await tools.read({ file_path: "a.ts" })\nreturn r.lines.length'
    const { output, probe } = await runTransport(program)
    expect(probe.programs).toEqual([program])
    expect(probe.titles[0]).toBe('count TODO markers')
    expect(output.result).toBe('ok')
  })

  it('漏发 description 时从 summary / 简报标题 / 首行三级兜底', async () => {
    const { probe } = await runTransport({ summary: 'from summary', code: 'return 1' })
    expect(probe.titles[0]).toBe('from summary')
    const bare = await runTransport({ code: '// from first line\nreturn 1' })
    expect(bare.probe.titles[0]).toBe('from first line')
  })
})

describe('参数容错：拒绝时给回显', () => {
  const fail = async (args: unknown): Promise<string> => {
    const host = {
      catalog: () => [{ name: 'read' }],
      runtime: () => ({ language: 'typescript', programFormat: 'function-body', async run() { return { value: 'ok', logs: [] } } }),
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'x' }),
    }
    const definition = createTransportDefinition(host as never, rules)
    try {
      await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)(args, {
        callId: 'outer', signal: new AbortController().signal,
      })
    } catch (error) {
      return (error as Error).message
    }
    return ''
  }

  it('只有 description 时回显收到的键', async () => {
    const message = await fail({ description: '检查 proxy-manager 现状' })
    expect(message).toContain('codemode: invalid code')
    expect(message).toContain('received keys: description')
    expect(message).toContain('pass program source in "code"')
  })

  it('完全不成形的字符串带原始片段', async () => {
    const message = await fail('{"description": "only a description"')
    expect(message).toContain('not a JSON object')
    expect(message).toContain('{"description"')
  })

  it('null 与数字各说各的', async () => {
    expect(await fail(null)).toContain('received null')
    expect(await fail(42)).toContain('received number')
  })
})
