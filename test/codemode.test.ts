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

  it('作用域规则：全局层遮蔽（系统点名白名单除外）、预设层保留、发现工具默认遮蔽', () => {
    const rules = createRules({})
    const view = {
      enabled: true,
      globalNames: new Set(['mcp__okx__ticker', 'progress_update', 'win_bash']),
      presetNames: new Set(['mcp__okx__ticker', 'progress_update', 'win_bash', 'todo_write', 'code_tools_search']),
    }
    expect(isMaskedName('mcp__okx__ticker', rules, view)).toBe(true)
    expect(isMaskedName('todo_write', rules, view)).toBe(false)
    expect(isMaskedName('team_comment', rules, view)).toBe(true)
    // 系统提示或子代理契约强制直呼的工具默认保留在原生列表，避免触发整批 UNKNOWN_TOOL 重跑。
    expect(isMaskedName('progress_update', rules, view)).toBe(false)
    expect(isMaskedName('structured_output', rules, view)).toBe(false)
    expect(isMaskedName('win_bash', rules, view)).toBe(false)
    // 发现工具仅在 code_run 程序内部调用，不在顶层列表额外占用固定前缀。
    expect(isMaskedName('code_tools_search', rules, view)).toBe(true)
    expect(isMaskedName('code_tools_list', rules, view)).toBe(true)
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

  it('新代运行时：先取会话授权再 resolve()，run() 只收到已解析的 spec', async () => {
    const policy = { mode: 'workspace-write', workspaceRoot: 'C:/work', sessionId: 'session-1' }
    const seen: { request?: Record<string, unknown>; spec?: Record<string, unknown> } = {}
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'v' }),
      runAuthority: async () => ({ cwd: 'C:/work/sub', sandboxPolicy: policy }),
      runtime: () => ({
        resolve(request: Record<string, unknown>) {
          seen.request = request
          return { ...request, timeoutMs: 60_000 }
        },
        async run(spec: Record<string, unknown>) {
          seen.spec = spec
          return { value: 'ok', logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ result?: unknown }>)({
      code: 'return 1',
      description: 'policy check',
    }, { callId: 'outer', signal: new AbortController().signal, agent: {} })
    // 策略必须来自会话，不能是未解析的空请求：内核 run() 会因此拒绝执行。
    expect(seen.request?.['sandboxPolicy']).toBe(policy)
    expect(seen.request?.['cwd']).toBe('C:/work/sub')
    expect(seen.spec?.['timeoutMs']).toBe(60_000)
    expect(output.result).toBe('ok')
  })

  it('老代运行时：没有 resolve 时把原始请求直接交给 run()', async () => {
    const seen: { request?: Record<string, unknown> } = {}
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'v' }),
      runtime: () => ({
        async run(request: Record<string, unknown>) {
          seen.request = request
          return { value: 'legacy', logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ result?: unknown }>)({
      code: 'return 1',
      description: 'legacy runtime',
    }, { callId: 'outer', signal: new AbortController().signal })
    expect(seen.request?.['program']).toBe('return 1')
    expect(seen.request?.['sandboxPolicy']).toBeUndefined()
    expect(output.result).toBe('legacy')
  })

  it('常驻环境拒绝换策略时释放 owner 并按新策略重跑一次', async () => {
    let runs = 0
    let released = 0
    let owned = 0
    const policies = [
      { mode: 'read-only', workspaceRoot: 'C:/work', sessionId: 'session-1' },
      { mode: 'workspace-write', workspaceRoot: 'C:/work', sessionId: 'session-1' },
    ]
    const host = {
      catalog: () => catalog,
      stateOwner: () => { owned += 1; return {} },
      releaseOwner: async () => { released += 1 },
      callTool: async () => ({ value: 'v' }),
      runAuthority: () => ({ sandboxPolicy: policies[Math.min(runs, 1)] }),
      runtime: () => ({
        resolve: (request: unknown) => request,
        async run() {
          runs += 1
          if (runs === 1) throw new Error('persistent PTC: release the retained environment before changing its sandbox policy')
          return { value: 'retried', logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ result?: unknown }>)({
      code: 'return 1',
      description: 'policy change',
    }, { callId: 'outer', signal: new AbortController().signal, agent: {} })
    expect(released).toBe(1)
    // 重建的常驻环境必须重新登记，否则它没人释放。
    expect(owned).toBe(2)
    expect(runs).toBe(2)
    expect(output.result).toBe('retried')
  })

  it('其余失败只抛一次，不触发释放与重试', async () => {
    let runs = 0
    let released = 0
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => { released += 1 },
      callTool: async () => ({ value: 'v' }),
      runtime: () => ({
        resolve: (request: unknown) => request,
        async run() {
          runs += 1
          throw new Error('boom')
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const run = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    await expect(run({ code: 'return 1', description: 'fail once' }, { callId: 'outer', signal: new AbortController().signal }))
      .rejects.toThrow(/boom/)
    expect(runs).toBe(1)
    expect(released).toBe(0)
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
    const fallback = normalizeConfig({ maxSubCalls: -3, maxParallelSubCalls: 0, maxSubCallsPerMinute: -1 })
    expect(fallback.maxSubCalls).toBe(512)
    expect(fallback.explicitMaxSubCalls).toBe(false)
    expect(fallback.maxParallelSubCalls).toBe(10)
    expect(fallback.maxSubCallsPerMinute).toBe(1024)
    expect(normalizeConfig({ maxSubCalls: 64 }).explicitMaxSubCalls).toBe(true)
  })

  it('与内核 PTC run_code 对齐：动态投影运行时语言、超时说明与单次沙箱提权参数', () => {
    let currentRuntime: Record<string, unknown> | undefined = {
      language: 'typescript',
      programFormat: 'function-body',
      timeout: { defaultMs: 120_000, maxMs: 600_000 },
      sandboxMode: 'workspace-write',
    }
    const host = {
      catalog: () => catalog,
      runtime: () => currentRuntime,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
    }
    const definition = createTransportDefinition(host as never, rules)
    expect(definition.description).toContain('Execute a TypeScript program')
    expect(definition.description).toContain('sandbox escalation approves this complete program')
    const tsProps = (definition.parameters as { properties: Record<string, { description?: string; enum?: string[] }> }).properties
    expect(tsProps['timeoutMs']?.description).toContain('Default 120000; capped at 600000.')
    expect(tsProps['sandbox_permissions']?.enum).toEqual(['workspace-write', 'danger-full-access'])
    expect(tsProps['justification']).toBeDefined()
    expect(definition.presentCall({ code: 'return 1', description: 'Check status' })).toEqual({
      card: 'generic',
      title: 'Check status',
      kind: 'execute',
      rawInput: 'return 1',
    })
    expect(definition.output.presentationMeta()).toEqual({ language: 'typescript' })

    currentRuntime = { language: 'python', programFormat: 'repl' }
    expect(definition.description).toContain('Execute a Python program')
    const pyProps = (definition.parameters as { properties: Record<string, unknown> }).properties
    expect(pyProps['sandbox_permissions']).toBeUndefined()
    expect(definition.output.presentationMeta()).toEqual({ language: 'python' })
  })

  it('单次沙箱提权：校验参数配对、提权执行时不传 stateOwner，且失败保留已捕获输出', async () => {
    const standing = { mode: 'workspace-write', workspaceRoot: 'C:/work' }
    const seenRequests: Record<string, unknown>[] = []
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({ id: 'owner-1' }),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runAuthority: async () => ({ cwd: 'C:/work', sandboxPolicy: standing }),
      escalateSandbox: async (req: { requestedMode: string }) => ({ ...standing, mode: req.requestedMode }),
      runtime: () => ({
        sandboxMode: 'workspace-write',
        resolve: (request: Record<string, unknown>) => {
          seenRequests.push(request)
          return request
        },
        async run() {
          return {
            logs: ['step 1 done'],
            error: { kind: 'runtime', message: 'permission check failed' },
            sandbox: { mode: 'danger-full-access', denied: true, enforcement: 'partial' as const },
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const run = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    const exec = { callId: 'outer', signal: new AbortController().signal, agent: {} }

    await expect(run({ code: 'return 1', description: 'd', sandbox_permissions: 'danger-full-access' }, exec))
      .rejects.toThrow(/requires a justification/)
    await expect(run({ code: 'return 1', description: 'd', justification: 'need write' }, exec))
      .rejects.toThrow(/only valid together with sandbox_permissions/)

    await expect(run({
      code: 'return 1',
      description: 'escalated run',
      sandbox_permissions: 'danger-full-access',
      justification: 'write outside workspace',
    }, exec)).rejects.toThrow(/Captured output:\nstep 1 done[\s\S]*File sandbox: danger-full-access; enforcement: partial; operation denied\./)

    // 临时提权不得附带 stateOwner，避免把高权限固化进常驻 REPL。
    expect(seenRequests[0]?.['stateOwner']).toBeUndefined()
    expect(seenRequests[0]?.['sandboxPolicy']).toEqual({ mode: 'danger-full-access', workspaceRoot: 'C:/work' })
  })

  it('转发子调用产生的图片内容块、additionalContexts 与 concluded 标记，并遵守 maxParallelSubCalls 上限', async () => {
    const parallelRules = createRules({ maxParallelSubCalls: 2 })
    const parallelCatalog = [
      { name: 'read', description: 'read', parameters: {}, isConcurrencySafe: () => true },
      { name: 'shot', description: 'screenshot', parameters: {}, isConcurrencySafe: () => false },
    ]
    let active = 0
    let peak = 0
    const deferred: unknown[] = []
    let concluded = false
    const host = {
      catalog: () => parallelCatalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      createImageContext: (content: readonly unknown[]) => ({ kind: 'image-msg', content }),
      async callTool(req: { name: string }) {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        if (req.name === 'shot') {
          return {
            value: 'ok',
            content: [{ type: 'image', source: 'img' }],
            additionalContexts: [{ kind: 'nudge' }],
            concluded: true,
          }
        }
        return { value: 'txt' }
      },
      runtime: () => ({
        async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          const fn = request.bindings[0]!.functions
          await Promise.all([fn['read']!({}), fn['read']!({}), fn['read']!({}), fn['shot']!({})])
          return { value: 'done', logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, parallelRules)
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)(
      { code: 'return 1', description: 'parallel and context' },
      {
        callId: 'outer',
        signal: new AbortController().signal,
        deferContext: (msg: unknown) => { deferred.push(msg) },
        concludeTurn: () => { concluded = true },
      },
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(deferred).toEqual([
      { kind: 'image-msg', content: [{ type: 'image', source: 'img' }] },
      { kind: 'nudge' },
    ])
    expect(concluded).toBe(true)
  })
})

/**
 * 子调用回放：内核的 PTC 传输会为每条子调用写一对 `tool/ptc-dispatch-start` /
 * `tool/ptc-dispatch`，界面靠它把子调用画到父调用下面。本行的程序不走那条传输，
 * 所以要在这里把这一对补齐——而且必须补得**诚实**。
 */
describe('子调用回放', () => {
  const rules = createRules({})
  const catalog = [
    { name: 'read', description: 'read a file', parameters: {}, isConcurrencySafe: () => true },
    { name: 'edit', description: 'edit a file', parameters: {}, isConcurrencySafe: () => false },
  ]

  /** 收集 append 的假会话。 */
  function fakeSession() {
    const events: { type: string; data: Record<string, unknown> }[] = []
    return {
      events,
      append(type: string, data: Record<string, unknown>): void {
        events.push({ type, data })
      },
    }
  }

  /** 一个按脚本调用程序内工具的运行环境。 */
  function runtimeOf(script: (tools: Record<string, (args: unknown) => Promise<unknown>>) => Promise<unknown>) {
    return {
      language: 'typescript',
      programFormat: 'function-body',
      async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        const value = await script(request.bindings[0]!.functions)
        return { value, logs: [] }
      },
    }
  }

  /** 跑一段程序。 */
  async function run(
    runtime: unknown,
    callTool: (request: { name: string; args: unknown; callId: string }) => Promise<unknown>,
    agent: unknown,
  ): Promise<unknown> {
    const host = { catalog: () => catalog, runtime: () => runtime, stateOwner: () => ({}), releaseOwner: async () => undefined, callTool }
    const definition = createTransportDefinition(host as never, rules)
    return await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)(
      { code: 'return 1', description: 'probe' },
      { callId: 'outer-1', signal: new AbortController().signal, agent },
    )
  }

  it('成对写入，父 id / 子 id / 参数与内核逐字对齐', async () => {
    const session = fakeSession()
    const runtime = runtimeOf(async (tools) => {
      await tools['read']!({ file_path: 'a.ts' })
      return 'ok'
    })
    await run(runtime, async () => ({ value: 'body', content: [{ type: 'text', text: 'body' }] }), { session })

    expect(session.events.map((event) => event.type)).toEqual(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])
    const [start, settle] = session.events
    expect(start!.data).toMatchObject({
      rootCallId: 'outer-1',
      parentCallId: 'outer-1',
      subCallId: 'outer-1:ptc:1',
      name: 'read',
      arguments: { file_path: 'a.ts' },
    })
    expect(settle!.data).toMatchObject({ subCallId: 'outer-1:ptc:1', name: 'read', isError: false })
    // 内容块原样进回放：没有它，界面展开是一具空壳。
    expect(settle!.data['content']).toEqual([{ type: 'text', text: 'body' }])
  })

  it('失败也成对收尾，并带上错误身份', async () => {
    const session = fakeSession()
    const runtime = runtimeOf(async (tools) => {
      try {
        await tools['read']!({ file_path: 'a.ts' })
      } catch {
        // 程序自己接住：回放置于失败之外，不得因为失败就漏写 settle。
      }
      return 'caught'
    })
    await run(runtime, async () => ({
      error: 'boom',
      content: [{ type: 'text', text: 'boom' }],
      errorInfo: { name: 'ToolError', code: 'E_BOOM' },
    }), { session })

    expect(session.events).toHaveLength(2)
    expect(session.events[1]!.data).toMatchObject({
      isError: true,
      error: { name: 'ToolError', code: 'E_BOOM' },
      content: [{ type: 'text', text: 'boom' }],
    })
  })

  it('排队中的写调用不提前记 start（时序诚实）', async () => {
    const session = fakeSession()
    const runtime = runtimeOf(async (tools) => {
      await Promise.all([
        tools['edit']!({ file_path: 'a.ts' }),
        tools['edit']!({ file_path: 'b.ts' }),
      ])
      return 'ok'
    })
    await run(runtime, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { value: 'edited' }
    }, { session })

    // 两条写调用被互斥闸门串行化：start/settle 必须交替，不能两条 start 并排。
    expect(session.events.map((event) => event.type)).toEqual([
      'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
      'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
    ])
    expect(session.events.filter((event) => event.type === 'tool/ptc-dispatch-start').map((event) => event.data['subCallId']))
      .toEqual(['outer-1:ptc:1', 'outer-1:ptc:2'])
  })

  it('append 抛错不带崩程序：老代没有这两种事件时降级为「没有回放」', async () => {
    const runtime = runtimeOf(async (tools) => await tools['read']!({ file_path: 'a.ts' }))
    const throwing = {
      append(): void {
        throw new Error('unknown event type: tool/ptc-dispatch')
      },
    }
    const output = await run(runtime, async () => ({ value: 'body' }), { session: throwing }) as { result?: unknown }
    expect(output.result).toBe('body')
  })

  it('没有会话可写时一条都不写，程序照常返回', async () => {
    const runtime = runtimeOf(async (tools) => await tools['read']!({ file_path: 'a.ts' }))
    const output = await run(runtime, async () => ({ value: 'body' }), undefined) as { result?: unknown }
    expect(output.result).toBe('body')
  })
})
