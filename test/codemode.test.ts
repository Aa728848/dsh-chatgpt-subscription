// @vitest-environment node
/**
 * Code Mode 的规则、遮蔽与传输契约。
 *
 * 这里的重点不是覆盖面，而是三条**不能退化**的契约：
 *
 * 1. 说明段逐字节恒定（kimi-code / minimax-code 的前缀缓存靠它）；
 * 2. 归属判定只在能确认时遮蔽（读不到归属绝不能误遮蔽）；
 * 3. 程序内子调用放行、模型直呼被拒。
 *
 * @module test/codemode
 */

import { describe, expect, it } from 'vitest'

import {
  buildCodemodeSectionText,
  createRules,
  isMaskedName,
  normalizeConfig,
  summarizeHidden,
} from '../src/host/codemode/rules.ts'
import { DISABLED_VIEW, resolveCatalogView, resolveNameView } from '../src/host/codemode/scope.ts'
import { createCodemodeExecutor, isNestedCall, markNested } from '../src/host/codemode/executor.ts'
import { createTransportDefinition } from '../src/host/codemode/transport.ts'

describe('Code Mode 说明段', () => {
  it('同一部署下逐字节恒定，且不含任何遮蔽计数', () => {
    const rules = createRules({})
    const input = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools, programFormat: 'function-body' }
    const first = buildCodemodeSectionText(input)
    const second = buildCodemodeSectionText(input)
    expect(second).toBe(first)
    // MCP 挂载 / 卸载不会出现在这段正文里：没有计数，也没有 namespace 清单。
    expect(first).not.toMatch(/\\d+ tool/)
    expect(first).not.toContain('mcp__')
    expect(first).toContain(rules.options.runToolName)
  })

  it('常驻 REPL 与函数体两种形态各说各自合法的话法', () => {
    const rules = createRules({})
    const base = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools }
    const body = buildCodemodeSectionText({ ...base, programFormat: 'function-body' })
    const repl = buildCodemodeSectionText({ ...base, programFormat: 'repl' })
    expect(body).toContain('return rows.filter')
    expect(repl).toContain('rows.filter')
    expect(repl).not.toContain('return rows.filter')
  })
})

describe('遮蔽规则', () => {
  it('名字规则：前缀、显式例外、显式遮蔽', () => {
    const rules = createRules({ nativeTools: ['cache_warmup_result'], hiddenTools: ['team_comment'] })
    const view = DISABLED_VIEW
    expect(isMaskedName('mcp__okx__ticker', rules, view)).toBe(true)
    expect(isMaskedName('team_comment', rules, view)).toBe(true)
    expect(isMaskedName('cache_warmup_result', rules, view)).toBe(false)
    expect(isMaskedName('code_run', rules, view)).toBe(false)
    expect(isMaskedName('todo_write', rules, view)).toBe(false)
  })

  it('作用域规则：全局层遮蔽、预设层保留、两层都没有（agent 层）遮蔽', () => {
    const rules = createRules({})
    const view = {
      enabled: true,
      globalNames: new Set(['mcp__okx__ticker']),
      presetNames: new Set(['mcp__okx__ticker', 'todo_write']),
    }
    expect(isMaskedName('mcp__okx__ticker', rules, view)).toBe(true)
    expect(isMaskedName('todo_write', rules, view)).toBe(false)
    expect(isMaskedName('team_comment', rules, view)).toBe(true)
  })

  it('读不到归属时不误遮蔽任何工具', () => {
    const rules = createRules({})
    expect(isMaskedName('team_comment', rules, DISABLED_VIEW)).toBe(false)
    expect(isMaskedName('mcp__okx__ticker', rules, DISABLED_VIEW)).toBe(true)
  })

  it('汇总只给日志与 code_debug 用', () => {
    const summary = summarizeHidden(['mcp__okx__a', 'mcp__okx__b', 'team_comment'])
    expect(summary.total).toBe(3)
    expect(summary.namespaces.map(entry => entry.namespace + ':' + String(entry.count)))
      .toEqual(['okx:2', 'plugin:1'])
  })
})

describe('归属视图', () => {
  it('用公开的 get(name) 与 get(name, key) 两次查询判定归属', () => {
    const registry = {
      get(name: string, scope?: object) {
        if (name === 'mcp__okx__ticker') return { name }
        if (name === 'todo_write' && scope === presetKey) return { name }
        return undefined
      },
    }
    const presetKey = {}
    const view = resolveCatalogView(registry, presetKey, ['mcp__okx__ticker', 'todo_write', 'team_comment'])
    expect(view.enabled).toBe(true)
    expect([...view.globalNames]).toEqual(['mcp__okx__ticker'])
    expect([...view.presetNames].sort()).toEqual(['mcp__okx__ticker', 'todo_write'])

    const single = resolveNameView(registry, presetKey, 'todo_write')
    expect([...single.presetNames]).toEqual(['todo_write'])
    expect([...single.globalNames]).toEqual([])
  })

  it('没有作用域 key 时整体降级', () => {
    const registry = { get: () => ({ name: 'x' }) }
    expect(resolveCatalogView(registry, undefined, ['x']).enabled).toBe(false)
  })
})

describe('执行器', () => {
  const definitions = [
    { name: 'todo_write', description: 'write todos', parameters: {} },
    { name: 'mcp__okx__ticker', description: 'ticker', parameters: {} },
    { name: 'code_run', description: 'program', parameters: {} },
  ]

  /** 一个只记录调用的委托执行器。 */
  function delegate() {
    const seen: string[][] = []
    return {
      seen,
      describe(tools: readonly unknown[]) {
        seen.push(tools.map(tool => (tool as { name: string }).name))
        return { schemas: tools }
      },
      async execute(input: { calls: readonly unknown[] }) {
        return {
          results: input.calls.map((call, index) => ({ callId: String(index), result: { isError: false, content: [] } })),
          additionalContexts: [],
          concluded: false,
        }
      },
    }
  }

  const rules = createRules({})
  const view = {
    enabled: true,
    globalNames: new Set(['mcp__okx__ticker']),
    presetNames: new Set(['mcp__okx__ticker', 'todo_write', 'code_run']),
  }

  it('describe 只把本预设的工具与传输交给委托方', () => {
    const target = delegate()
    const executor = createCodemodeExecutor({ get: () => undefined }, rules, {
      delegate: target,
      view: () => view,
      viewForName: () => view,
      sectionText: () => 'SECTION',
    })
    const input = executor.describe(definitions)
    expect(input.schemas.map(schema => (schema as { name: string }).name).sort()).toEqual(['code_run', 'todo_write'])
    expect(target.seen[0]).toEqual(['todo_write', 'code_run'])
  })

  it('说明段挂成 tools:sdk，且正文恒定', () => {
    const executor = createCodemodeExecutor({ get: () => undefined }, rules, {
      delegate: delegate(),
      view: () => view,
      viewForName: () => view,
      sectionText: () => 'SECTION',
    })
    expect(executor.sections.map(section => section.name)).toEqual(['tools:sdk'])
    expect(executor.sections[0]?.interpolate).toBe(false)
    expect((executor.sections[0]?.text as () => string)()).toBe('SECTION')
  })

  it('模型直呼被遮蔽的工具时整批拒绝，并给出发现指引', async () => {
    const target = delegate()
    const executor = createCodemodeExecutor({ get: () => undefined }, rules, {
      delegate: target,
      view: () => view,
      viewForName: () => view,
      sectionText: () => 'SECTION',
    })
    executor.describe(definitions)
    const batch = await executor.execute({
      calls: [{ id: 'call-1', name: 'mcp__okx__ticker', arguments: '{}' }],
      signal: new AbortController().signal,
    })
    expect(target.seen).toHaveLength(1) // 只有 describe 的那一次，execute 没有被委托
    const first = batch.results[0] as { result: { isError: boolean; error: { message: string } } }
    expect(first.result.isError).toBe(true)
    expect(first.result.error.message).toContain('code_tools_search')
  })

  it('程序内子调用放行（signal 标记与 :ptc: call id 各一条路径）', async () => {
    const target = delegate()
    const executor = createCodemodeExecutor({ get: () => undefined }, rules, {
      delegate: target,
      view: () => view,
      viewForName: () => view,
      sectionText: () => 'SECTION',
    })
    executor.describe(definitions)
    const marked = markNested(new AbortController().signal)
    const bySignal = await executor.execute({
      calls: [{ id: 'call-2', name: 'mcp__okx__ticker', arguments: '{}' }],
      signal: marked as AbortSignal,
    })
    expect((bySignal.results[0] as { result: { isError: boolean } }).result.isError).toBe(false)
    const byId = await executor.execute({
      calls: [{ id: 'call-3:ptc:1', name: 'mcp__okx__ticker', arguments: '{}' }],
      signal: new AbortController().signal,
    })
    expect((byId.results[0] as { result: { isError: boolean } }).result.isError).toBe(false)
    expect(isNestedCall({ id: 'x:ptc:2' }, undefined)).toBe(true)
  })
})

describe('程序传输', () => {
  const rules = createRules({})
  const catalog = [{ name: 'read', description: 'read a file', parameters: {} }]

  /** 一个只在程序里跑一次 tools.read 的运行时。 */
  function runtime(calls: unknown[]) {
    return {
      language: 'typescript',
      programFormat: 'function-body',
      async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        const tools = request.bindings[0]!.functions
        const value = await tools['read']!({ file_path: 'a.ts' })
        calls.push(value)
        return { value, logs: ['log'] }
      },
    }
  }

  it('把程序里的 tools.<name>() 变成一次真实的 tools.execute()', async () => {
    const calls: unknown[] = []
    const executed: { id: string; name: string; arguments: string }[] = []
    const host = {
      catalog: () => catalog,
      runtime: () => runtime(calls),
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      async callTool(request: { name: string; args: unknown; callId: string; signal: AbortSignal }) {
        executed.push({ id: request.callId, name: request.name, arguments: JSON.stringify(request.args) })
        return { value: 'file body' }
      },
    }
    const definition = createTransportDefinition(host as never, rules)
    const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ logs: string[]; result?: unknown }>)({
      code: 'return 1',
      description: 'read one file',
    }, { callId: 'outer', signal: new AbortController().signal })
    expect(executed).toHaveLength(1)
    expect(executed[0]!.name).toBe('read')
    expect(executed[0]!.id.startsWith('outer:ptc:')).toBe(true)
    expect(output.logs).toEqual(['log'])
    expect(output.result).toBe('file body')
  })

it('程序内的清单快照与绑定一致：运行中改执行器级清单不影响检索源', async () => {
    const { currentCatalogSnapshot } = await import('../src/host/codemode/transport.ts')
    const calls: unknown[] = []
    let insideSnapshot: readonly { name: string }[] | undefined
    let outsideSnapshot: readonly { name: string }[] | undefined
    const host = {
      catalog: () => [{ name: 'read', description: 'read', parameters: {} }, { name: 'search_later', description: 'x', parameters: {} }],
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'v' }),
      runtime: () => ({
        async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          insideSnapshot = currentCatalogSnapshot()
          // 运行期间执行器级清单被另一个会话改写：快照必须不受影响。
          host.catalog = () => [{ name: 'other', description: 'other', parameters: {} }]
          const value = await request.bindings[0]!.functions['read']!({})
          calls.push(value)
          return { value, logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)({
      code: 'return 1',
      description: 'snapshot check',
    }, { callId: 'outer', signal: new AbortController().signal })
    outsideSnapshot = currentCatalogSnapshot()
    expect((insideSnapshot ?? []).map(entry => entry.name)).toEqual(['read', 'search_later'])
    expect(outsideSnapshot).toBeUndefined()
    expect(calls).toEqual(['v'])
  })

  it('拒绝空程序与非法超时', async () => {
    const host = {
      catalog: () => catalog,
      runtime: () => undefined,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({}),
    }
    const definition = createTransportDefinition(host as never, rules)
    const run = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    const exec = { callId: 'outer', signal: new AbortController().signal }
    await expect(run({ code: '  ', description: 'x' }, exec)).rejects.toThrow(/invalid code/)
    await expect(run({ code: 'x', description: '' }, exec)).rejects.toThrow(/invalid description/)
    await expect(run({ code: 'x', description: 'd', timeoutMs: -1 }, exec)).rejects.toThrow(/invalid timeoutMs/)
    await expect(run({ code: 'x', description: 'd' }, exec)).rejects.toThrow(/no PTC runtime/)
  })

  it('配置校验：发现工具不得与传输工具同名，非法值退回缺省', () => {
    expect(normalizeConfig({ runToolName: 'code_run' }).runToolName).toBe('code_run')
    expect(() => normalizeConfig({ runToolName: 'same', metaTools: ['same'] })).toThrow(/must not repeat/)
    const fallback = normalizeConfig({ maxSubCalls: -3, maxParallelSubCalls: 0 })
    expect(fallback.maxSubCalls).toBe(512)
    expect(fallback.maxParallelSubCalls).toBe(10)
  })
})
