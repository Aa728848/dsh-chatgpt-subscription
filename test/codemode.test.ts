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
import { createRetention } from '../src/host/codemode/retention.ts'
import {
  CodemodeArgsError,
  CodemodeContextUnavailableError,
  CodeResetFailedError,
  CodeRunFailedError,
  PTC_IMAGE_TAG,
  PtcImageLike,
  SandboxEscalationError,
  ToolCallLimitExceededError,
  createTransportDefinition,
  normalizeSubCallArgs,
  sanitizeReplTopLevelReturn,
} from '../src/host/codemode/transport.ts'
import { apply as applyCodemode } from '../src/entry-codemode.ts'

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
    expect(body).toContain('return pages.flatMap')
    expect(repl).toContain('pages.flatMap')
    expect(repl).not.toContain('return pages.flatMap')
  })

  it('示例读 glob 结果的 paths 字段，而不是把整个信封当数组', () => {
    const rules = createRules({})
    const base = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools }
    // 回归：typed tool output 之后 `glob` 回 `{ root, paths }`。示例若写 `files.map(...)`，
    // 照抄的程序会以 `files.map is not a function` 整段失败（曾让每次新会话的启动探测崩掉）。
    const js = buildCodemodeSectionText({ ...base, programFormat: 'function-body' })
    expect(js).toContain('const { paths } = await tools.glob')
    expect(js).not.toContain('files.map')
    expect(js).toContain('named-field object')
    const py = buildCodemodeSectionText({ ...base, language: 'python', programFormat: 'function-body' })
    expect(py).toContain('found["paths"]')
    expect(py).not.toContain('for f in files')
  })

  it('示例读 read 结果的 lines[].text，而不是把信封当字符串', () => {
    const rules = createRules({})
    const base = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools }
    // 回归：`tools.read` 回 `{ path, offset, lines: [{ number, text }], totalLines }`。
    // 照抄 `r.includes(...)` / `r.split(...)` / `r.splitlines()` 的程序 100% 抛
    // `includes is not a function`，所以示例与说明段都不许出现这些写法。
    const js = buildCodemodeSectionText({ ...base, programFormat: 'function-body' })
    expect(js).toContain('const pages = await Promise.all(paths.map((p) => tools.read({ file_path: p })))')
    expect(js).toContain('return pages.flatMap((r) => r.lines.filter((l) => l.text.includes("TODO")).map((l) => l.text))')
    expect(js).not.toContain('r.includes(')
    expect(js).not.toContain('r.split(')
    const py = buildCodemodeSectionText({ ...base, language: 'python', programFormat: 'function-body' })
    expect(py).toContain('pages = await asyncio.gather(*(tools.read({"file_path": p}) for p in found["paths"]))')
    expect(py).toContain('l["text"] for page in pages for l in page["lines"]')
    // 只看示例块本身：正文里提到 `splitlines` 是在说「不要这么写」。
    const pyExample = py.slice(py.indexOf('```py'), py.indexOf('```', py.indexOf('```py') + '```py'.length))
    expect(pyExample).not.toContain('splitlines')
  })

  it('说明段公开内置与发现工具的信封形状，以及无损 JSON 规则', () => {
    const rules = createRules({})
    const input = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools, programFormat: 'function-body' }
    const text = buildCodemodeSectionText(input)
    // 信封：模型最常搞错的就是把 read / grep 的结果当字符串或数组。
    expect(text).toContain('`glob` → `{ root, paths }`')
    expect(text).toContain('`grep` → `{ matches: [{ path, lineNumber, line }] }`')
    expect(text).toContain('`read` → `{ path, offset, lines: [{ number, text }], totalLines }`')
    expect(text).toContain('`win_bash` → `{ stdout, stderr, exitCode }`')
    // 发现工具：list / search / describe 的返回形状连同 output 字段一起点名。
    const [listTool, searchTool, describeTool] = rules.options.metaTools
    expect(text).toContain('`' + String(listTool) + '` answers `{ tools: [{ name, description, namespace }] }`')
    expect(text).toContain('`' + String(searchTool) + '` answers `{ tools: [{ name, namespace, description, parameters, output? }], fallback? }`')
    expect(text).toContain('`' + String(describeTool) + '` answers `{ found, name?, namespace?, description?, parameters?, output? }`')
    // 内核 PTC 的无损 JSON 规则：属性值不能是 undefined。
    expect(text).toContain('never leave `undefined` in an object property value')
    expect(text).toContain('x.opt ?? null')
  })

  it('白名单说明把全局工具名映射到程序内，默认说明保持原样', () => {
    const rules = createRules({})
    const base = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools, programFormat: 'function-body' }
    const legacy = buildCodemodeSectionText(base)
    expect(legacy).toContain('The tools in your tool list are called directly, exactly as usual')

    const dispatchRules = createRules({
      nativeToolsOnly: true,
      nativeTools: ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output'],
    })
    const input = {
      ...base,
      nativeToolsOnly: dispatchRules.options.nativeToolsOnly,
      nativeTools: dispatchRules.options.nativeTools,
    }
    const text = buildCodemodeSectionText(input)
    expect(buildCodemodeSectionText(input)).toBe(text)
    expect(text).toContain('Code Mode with a native whitelist')
    expect(text).toContain('`read` → `tools.read`')
    expect(text).toContain('`ask_user_question` → `tools.ask_user_question`')
    expect(text).toContain('`win_bash` → `tools.win_bash`')
    expect(text).toContain('never a top-level call')
    expect(text).not.toContain('The tools in your tool list are called directly, exactly as usual')

    const genericRules = createRules({ nativeToolsOnly: true })
    const generic = buildCodemodeSectionText({
      ...base,
      nativeToolsOnly: true,
      nativeTools: genericRules.options.nativeTools,
    })
    expect(generic).not.toContain('`win_bash` → `tools.win_bash`')

    const allCommonNative = buildCodemodeSectionText({
      ...base,
      nativeToolsOnly: true,
      nativeTools: ['read', 'glob', 'grep', 'edit', 'write', 'read_image', 'ask_user_question', 'subagent', 'win_bash'],
    })
    expect(allCommonNative).not.toContain('Common mappings: .')
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

  it('nativeToolsOnly 只保留最小白名单，其他预设工具也全部程序内化', () => {
    expect(createRules({}).options.nativeToolsOnly).toBe(false)
    const rules = createRules({ nativeToolsOnly: true })
    const view = {
      enabled: true,
      globalNames: new Set<string>(),
      presetNames: new Set([
        'ask_user_question', 'read', 'subagent', 'exit_plan_mode',
        'cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output', 'win_bash', 'code_run',
      ]),
    }
    for (const name of ['ask_user_question', 'read', 'subagent', 'exit_plan_mode']) {
      expect(isMaskedName(name, rules, view), name).toBe(true)
    }
    for (const name of ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output', 'win_bash', 'code_run']) {
      expect(isMaskedName(name, rules, view), name).toBe(false)
    }
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

  it('最小白名单模式下提问与其他非白名单工具直呼被拒、嵌套调用放行', async () => {
    const target = delegate()
    const execute = target.execute
    let executions = 0
    target.execute = async (input) => {
      executions += 1
      return execute(input)
    }
    const whitelistRules = createRules({ nativeToolsOnly: true })
    const whitelistView = {
      enabled: true,
      globalNames: new Set<string>(),
      presetNames: new Set(['ask_user_question', 'read', 'code_run', 'progress_update', 'win_bash']),
    }
    const executor = createCodemodeExecutor({ get: () => undefined }, whitelistRules, {
      delegate: target,
      view: () => whitelistView,
      viewForName: () => whitelistView,
      sectionText: () => 'SECTION',
    })
    const described = executor.describe([
      { name: 'ask_user_question', description: 'ask', parameters: {} },
      { name: 'read', description: 'read', parameters: {} },
      { name: 'progress_update', description: 'progress', parameters: {} },
      { name: 'win_bash', description: 'shell', parameters: {} },
      { name: 'code_run', description: 'program', parameters: {} },
    ])
    expect(described.schemas.map(schema => (schema as { name: string }).name).sort())
      .toEqual(['code_run', 'progress_update', 'win_bash'])

    const direct = await executor.execute({
      calls: [{ id: 'ask-native', name: 'ask_user_question', arguments: '{"questions":[]}' }],
      signal: new AbortController().signal,
    })
    const denied = direct.results[0] as { result: { isError: boolean; error: { code: string } } }
    expect(denied.result.isError).toBe(true)
    expect(denied.result.error.code).toBe('UNKNOWN_TOOL')
    expect(executions).toBe(0)

    const nested = await executor.execute({
      calls: [{ id: 'ask-nested:ptc:1', name: 'ask_user_question', arguments: '{"questions":[]}' }],
      signal: new AbortController().signal,
    })
    expect((nested.results[0] as { result: { isError: boolean } }).result.isError).toBe(false)
    expect(executions).toBe(1)
  })

  it('dispatch 显式白名单拒绝顶层 Shell，但放行嵌套 tools.win_bash', async () => {
    const target = delegate()
    const execute = target.execute
    let executions = 0
    target.execute = async (input) => {
      executions += 1
      return execute(input)
    }
    const dispatchRules = createRules({
      nativeToolsOnly: true,
      nativeTools: ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output'],
    })
    const dispatchView = {
      enabled: true,
      globalNames: new Set<string>(),
      presetNames: new Set(['code_run', 'progress_update', 'win_bash']),
    }
    const executor = createCodemodeExecutor({ get: () => undefined }, dispatchRules, {
      delegate: target,
      view: () => dispatchView,
      viewForName: () => dispatchView,
      sectionText: () => 'SECTION',
    })
    const described = executor.describe([
      { name: 'progress_update', description: 'progress', parameters: {} },
      { name: 'win_bash', description: 'shell', parameters: {} },
      { name: 'code_run', description: 'program', parameters: {} },
    ])
    expect(described.schemas.map(schema => (schema as { name: string }).name).sort())
      .toEqual(['code_run', 'progress_update'])

    const direct = await executor.execute({
      calls: [{ id: 'shell-native', name: 'win_bash', arguments: '{"command":"git status --short"}' }],
      signal: new AbortController().signal,
    })
    const denied = direct.results[0] as { result: { isError: boolean; error: { code: string } } }
    expect(denied.result.isError).toBe(true)
    expect(denied.result.error.code).toBe('UNKNOWN_TOOL')
    expect(executions).toBe(0)

    const nested = await executor.execute({
      calls: [{ id: 'shell-nested:ptc:1', name: 'win_bash', arguments: '{"command":"git status --short"}' }],
      signal: new AbortController().signal,
    })
    expect((nested.results[0] as { result: { isError: boolean } }).result.isError).toBe(false)
    expect(executions).toBe(1)
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
    // description 现在可以兜底（summary → 简报标题 → 源码首行）：空串不再整段拒绝，
    // 执行一路走到「没有运行时」这一步。
    await expect(run({ code: 'x', description: '' }, exec)).rejects.toThrow(/no PTC runtime/)
    await expect(run({ code: 'x', description: 'd', timeoutMs: -1 }, exec)).rejects.toThrow(/invalid timeoutMs/)
    await expect(run({ code: 'x', description: 'd' }, exec)).rejects.toThrow(/no PTC runtime/)
  })

  it('源码放错字段时：认识的别名键直接执行，不认识的键回显出来', async () => {
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
    // `program` 是认识的别名：不再报错，直接走到执行（这里只有「没有运行时」拦路）。
    await expect(run({ program: 'return 1', description: 'x' }, exec)).rejects.toThrow(/no PTC runtime/)
    // 完全陌生的键才回显，让模型知道该改哪个字段。
    await expect(run({ scratch: 'return 1', description: 'x' }, exec)).rejects
      .toThrow(/invalid code: expected a non-empty string \(received keys: scratch, description; pass program source in "code"\)/)
  })

  it('并发子调用按提交顺序提交：先提交的先落盘，先跑完不算数', async () => {
    const committed: string[] = []
    const deferred: unknown[] = []
    const laneCatalog = [
      { name: 'slow', description: 'slow', parameters: {}, isConcurrencySafe: () => true },
      { name: 'fast', description: 'fast', parameters: {}, isConcurrencySafe: () => true },
    ]
    const host = {
      catalog: () => laneCatalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      /** 提交阶段的第一步（内核的 `tools/ptc-dispatch-log` 瀑布）。 */
      shapeDispatchLog: async (dispatch: { name: string; content: readonly unknown[] }) => {
        committed.push(dispatch.name)
        return dispatch.content
      },
      async callTool(req: { name: string }) {
        // 后提交的先跑完：落盘顺序必须仍然是提交顺序。
        await new Promise((resolve) => setTimeout(resolve, req.name === 'slow' ? 25 : 1))
        return { value: req.name, content: [{ type: 'text', text: req.name }], additionalContexts: [{ kind: req.name }] }
      },
      runtime: () => ({
        async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          const fn = request.bindings[0]!.functions
          await Promise.all([fn['slow']!({}), fn['fast']!({})])
          return { value: 'done', logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)(
      { code: 'return 1', description: 'commit order' },
      { callId: 'outer', signal: new AbortController().signal, deferContext: (msg: unknown) => { deferred.push(msg) } },
    )
    expect(committed).toEqual(['slow', 'fast'])
    // 延迟上下文也跟着提交顺序，而不是完成顺序。
    expect(deferred).toEqual([{ kind: 'slow' }, { kind: 'fast' }])
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

describe('DSH 内核 PTC 机制对齐与宿主层入参别名容错', () => {
  const rules = createRules({ maxSubCalls: 2 })
  const catalog = [{ name: 'read', description: 'read', parameters: {}, isConcurrencySafe: () => true }]

  it('宿主层入参别名容错：read/edit/write/read_image/glob/grep/win_bash/job_output 自动映射常见错键', () => {
    expect(normalizeSubCallArgs({ name: 'read', description: '', parameters: {} }, { path: 'src/a.ts', offset: 1, limit: 50 }))
      .toEqual({ file_path: 'src/a.ts', offset: 1, limit: 50 })
    expect(normalizeSubCallArgs({ name: 'read_image', description: '', parameters: {} }, { filePath: 'shot.png' }))
      .toEqual({ file_path: 'shot.png' })
    expect(normalizeSubCallArgs({ name: 'glob', description: '', parameters: {} }, { pattern: '**/*.ts', file_path: 'src' }))
      .toEqual({ pattern: '**/*.ts', path: 'src' })
    expect(normalizeSubCallArgs({ name: 'edit', description: '', parameters: {} }, {
      path: 'src/a.ts',
      oldString: 'old',
      newString: 'new',
      replaceAll: true,
    })).toEqual({
      file_path: 'src/a.ts',
      old_string: 'old',
      new_string: 'new',
      replace_all: true,
    })
    expect(normalizeSubCallArgs({ name: 'win_bash', description: '', parameters: {} }, {
      command: 'pwd',
      cwd: 'C:/work',
      timeout_ms: 5000,
      runInBackground: false,
    })).toEqual({
      command: 'pwd',
      workdir: 'C:/work',
      timeoutMs: 5000,
      run_in_background: false,
    })
    expect(normalizeSubCallArgs({ name: 'job_output', description: '', parameters: {} }, {
      jobId: 'job-1',
      timeoutMs: 3000,
    })).toEqual({
      job_id: 'job-1',
      timeout_ms: 3000,
    })
    // 已提供规范键时不覆盖
    expect(normalizeSubCallArgs({ name: 'read', description: '', parameters: {} }, {
      file_path: 'canonical.ts',
      path: 'ignored.ts',
    })).toEqual({
      file_path: 'canonical.ts',
      path: 'ignored.ts',
    })
  })

  it('子调用配额超限：抛 ToolCallLimitExceededError 并在常驻模式覆盖 abort 文本时保留真实超限原因', async () => {
    const catalog = [{ name: 'read', description: 'read', parameters: {}, isConcurrencySafe: () => true }]
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runtime: () => ({
        retainsState: true,
        async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          const fn = request.bindings[0]!.functions['read']!
          await fn({ file_path: '1.ts' })
          await fn({ file_path: '2.ts' })
          try {
            await fn({ file_path: '3.ts' })
          } catch (error) {
            expect(error).toBeInstanceOf(ToolCallLimitExceededError)
          }
          // 模拟 ptc-runtime-node 常驻进程被 abort 后返回泛化的 execution canceled 消息
          return {
            logs: [],
            error: { kind: 'abort', message: 'execution canceled; retained variables were preserved' },
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const execute = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    let caught: unknown
    try {
      await execute({ code: 'return 1', description: 'exceed limit' }, { callId: 'outer', signal: new AbortController().signal })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeRunFailedError)
    expect((caught as CodeRunFailedError).code).toBe('CODE_RUN_FAILED')
    expect((caught as Error).message).toContain('code_run exceeded its limit of 2 tool calls')
    expect((caught as Error).message).toContain('call 3 was not dispatched')
    expect((caught as Error).message).toContain('execution canceled; retained variables were preserved')
  })

  it('外层调用方主动取消：映射为 AbortError (code: ABORTED) 并保留常驻状态说明', async () => {
    const outer = new AbortController()
    const host = {
      catalog: () => [{ name: 'read', description: 'read', parameters: {} }],
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runtime: () => ({
        retainsState: true,
        async run() {
          outer.abort(new Error('user cancelled'))
          return {
            logs: [],
            error: { kind: 'abort', message: 'execution canceled; retained variables were preserved' },
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const execute = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>
    await expect(execute({ code: 'return 1', description: 'abort check' }, { callId: 'outer', signal: outer.signal }))
      .rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORTED',
        message: 'tool call aborted: execution canceled; retained variables were preserved',
      })
  })

  it('Commit Lane：程序立即拿到子调用返回值而不被慢速 shapeDispatchLog 阻塞，且 drain 保证落盘完成', async () => {
    let logSettled = false
    let programSawLogSettled = true
    const host = {
      catalog: () => [{ name: 'read', description: 'read', parameters: {}, isConcurrencySafe: () => true }],
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      shapeDispatchLog: async (dispatch: { content: readonly unknown[] }) => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        logSettled = true
        return dispatch.content
      },
      callTool: async () => ({ value: 'fast-value', content: [{ type: 'text', text: 'fast-value' }] }),
      runtime: () => ({
        async run(request: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          const val = await request.bindings[0]!.functions['read']!({ path: 'src/index.ts' })
          programSawLogSettled = logSettled
          return { value: val, logs: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, createRules({}))
    const output = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ result?: unknown }>)(
      { code: 'return 1', description: 'non-blocking log' },
      { callId: 'outer', signal: new AbortController().signal, agent: { session: { append() {} } } },
    )
    expect(output.result).toBe('fast-value')
    // 程序拿到返回值时，慢速日志落盘尚未完成；但整个 code_run 返回时 drain 已将其排空。
    expect(programSawLogSettled).toBe(false)
    expect(logSettled).toBe(true)
  })

  it('retention：挂载 agent.ctx.effect（展开 cordis.original 去重）、等待已取消前序调用排空并支持 reset()', async () => {
    const releasedOwners: unknown[] = []
    let failRelease = false
    const rawProvider = {
      retainsState: true,
      async release(owner: object) {
        if (failRelease) throw new Error('process kill timeout')
        releasedOwners.push(owner)
      },
      async run() {
        return { logs: [] }
      },
    }
    const origSym = Symbol('cordis.original')
    const wrappedRuntime = Object.create(rawProvider, {
      [origSym]: { value: rawProvider, enumerable: false },
    }) as typeof rawProvider

    const retention = createRetention(() => wrappedRuntime)
    const agentDisposers: (() => Promise<void>)[] = []
    const injected: unknown[] = []
    const agent = {
      session: { id: 'sess-retention' },
      ctx: {
        effect(cb: () => () => Promise<void>) {
          agentDisposers.push(cb())
        },
      },
      inject(msg: unknown) {
        injected.push(msg)
      },
    }

    // 多次获取 owner 只在原初 provider 上登记一次 agent.ctx.effect
    retention.owner(agent)
    retention.owner(agent)
    expect(agentDisposers).toHaveLength(1)

    // 前序已 abort 的在飞调用排空前，新调用在 awaitPredecessors 等待
    const c1 = new AbortController()
    const untrack1 = retention.trackRun({ agent, controller: c1, signal: c1.signal, mode: 'workspace-write' })
    c1.abort(new Error('cancelled'))
    let secondAdmitted = false
    const waitPromise = retention.awaitPredecessors(agent, new AbortController().signal).then(() => {
      secondAdmitted = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(secondAdmitted).toBe(false)
    untrack1()
    await waitPromise
    expect(secondAdmitted).toBe(true)

    // reset 失败时阻塞后续调用，重试成功后恢复并注入通知
    failRelease = true
    await expect(retention.reset(agent, () => injected.push('notified'))).rejects.toThrow(/process kill timeout/)
    await expect(retention.awaitPredecessors(agent, new AbortController().signal))
      .rejects.toThrow(/Program environment unavailable: process kill timeout/)

    failRelease = false
    await retention.reset(agent, () => injected.push('notified'))
    expect(releasedOwners).toEqual([agent])
    expect(injected).toEqual(['notified'])
    await expect(retention.awaitPredecessors(agent, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('entry-codemode：按调用方 agent+toolSet 动态枚举工具清单，并暴露 executor.reset(agent)', async () => {
    const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    let capturedExecutor: { reset?: (agent: unknown) => Promise<void> } | undefined
    const seenToolNames: string[][] = []
    const runtime = {
      language: 'typescript',
      programFormat: 'function-body',
      retainsState: true,
      resolve: (req: Record<string, unknown>) => ({ ...req, sandboxPolicy: { mode: 'read-only' } }),
      async release() {},
      async run(spec: { bindings: readonly { functions: Record<string, unknown> }[] }) {
        seenToolNames.push(Object.keys(spec.bindings[0]!.functions))
        return { value: 'ok', logs: [] }
      },
    }
    const ctx = {
      tools: {
        register(def: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) {
          registered.push(def)
          return () => undefined
        },
        setExecutor(exec: { reset?: (agent: unknown) => Promise<void> }) {
          capturedExecutor = exec
          return () => undefined
        },
        get: () => undefined,
        definitions(scope?: { id?: string }) {
          if (scope?.id === 'agent-sub') {
            return [{ name: 'read', description: 'r', parameters: {} }]
          }
          return [
            { name: 'read', description: 'r', parameters: {} },
            { name: 'subagent', description: 's', parameters: {} },
          ]
        },
        execute: async () => ({ results: [] }),
      },
      get: (name: string) => (name === 'ptcRuntime' ? runtime : undefined),
    }
    applyCodemode(ctx, {})
    const codeRun = registered.find((d) => d.name === 'code_run')!
    await codeRun.execute(
      { code: 'return 1', description: 'lead run' },
      { callId: 'c-lead', signal: new AbortController().signal, agent: { id: 'agent-lead', session: { id: 's1' } } },
    )
    await codeRun.execute(
      { code: 'return 1', description: 'sub run' },
      { callId: 'c-sub', signal: new AbortController().signal, agent: { id: 'agent-sub', session: { id: 's2' } } },
    )
    expect(seenToolNames).toEqual([['read', 'subagent'], ['read']])

    const injected: unknown[] = []
    await capturedExecutor!.reset!({
      session: { id: 's1' },
      inject(msg: unknown) { injected.push(msg) },
    })
    expect(injected).toHaveLength(1)

    runtime.retainsState = false
    await expect(capturedExecutor!.reset!({ session: { id: 's1' } })).rejects.toBeInstanceOf(CodeResetFailedError)
  })

  it('DSH 0.2.2-rc.2 scoped-repl：说明段采用 REPL 形态，且传输层自动剥离末尾顶层 return', async () => {
    const section = buildCodemodeSectionText({
      runToolName: 'code_run',
      metaTools: ['code_tools_list', 'code_tools_search', 'code_tools_describe'],
      language: 'typescript',
      programFormat: 'scoped-repl',
    })
    expect(section).toContain('retained TypeScript REPL')
    expect(section).not.toContain('return pages.flatMap')
    expect(section).toContain('pages.flatMap')
    expect(section).toContain('inspect(...values)')

    expect(sanitizeReplTopLevelReturn('const x = 1;\nreturn x + 2;', 'scoped-repl', 'typescript'))
      .toBe('const x = 1;\nx + 2')
    expect(sanitizeReplTopLevelReturn('const a = 1;\nreturn { a, b: 2 };\n', 'scoped-repl', 'typescript'))
      .toBe('const a = 1;\n({ a, b: 2 })\n')
    expect(sanitizeReplTopLevelReturn('const a = 1;\nreturn;\n', 'repl', 'typescript'))
      .toBe('const a = 1;\nundefined\n')
    // 函数内部的 return 不受影响
    const withInnerFn = 'const fn = () => { return { ok: true } };\nfn()'
    expect(sanitizeReplTopLevelReturn(withInnerFn, 'scoped-repl', 'typescript')).toBe(withInnerFn)
    // function-body 或 python 不改写
    expect(sanitizeReplTopLevelReturn('return 42', 'function-body', 'typescript')).toBe('return 42')
    expect(sanitizeReplTopLevelReturn('return 42', 'scoped-repl', 'python')).toBe('return 42')

    const seenPrograms: string[] = []
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runtime: () => ({
        language: 'typescript',
        programFormat: 'scoped-repl',
        async run(req: { program: string }) {
          seenPrograms.push(req.program)
          return { output: [{ type: 'text' as const, text: 'done\n' }], value: 'done' }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const out = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ logs: string[]; result?: unknown }>)({
      code: 'const v = await tools.read({ file_path: "a.ts" });\nreturn { v };',
      description: 'scoped-repl return recovery',
    }, { callId: 'c-repl', signal: new AbortController().signal })
    expect(seenPrograms).toEqual(['const v = await tools.read({ file_path: "a.ts" });\n({ v })'])
    expect(out.logs).toEqual(['done'])
    // output 文本与 result 文本一致时不重复渲染两遍
    const rendered = definition.output.render({}, out)
    expect(rendered).toEqual([{ type: 'text', text: 'done' }])
  })

  it('DSH 0.2.2-rc.2 有序图文流 result.output 与 projectContent（成功与报错现场保留图片）', async () => {
    const imgRef = {
      kind: 'image-attachment' as const,
      attachmentId: 'img_1',
      mediaType: 'image/png',
      width: 100,
      height: 80,
      byteLength: 512,
    }
    let shouldFail = false
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runtime: () => ({
        language: 'typescript',
        programFormat: 'scoped-repl',
        async run() {
          if (shouldFail) {
            return {
              output: [
                { type: 'text' as const, text: 'before crash\n' },
                { type: 'image' as const, attachment: imgRef },
              ],
              error: { kind: 'exception', message: 'AssertionError: bad' },
            }
          }
          return {
            output: [
              { type: 'text' as const, text: 'step 1\n' },
              { type: 'text' as const, text: 'step 2\n' },
              { type: 'image' as const, attachment: imgRef },
              { type: 'text' as const, text: 'after image\n' },
            ],
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    const execOk = { callId: 'c-img-ok', signal: new AbortController().signal }
    const out = await (definition.execute as (args: unknown, exec: unknown) => Promise<{ logs: string[] }>)({
      code: 'inspect("step 1"); inspect("step 2"); inspect(img); inspect("after image")',
      description: 'interleaved output',
    }, execOk)
    expect(out.logs).toEqual(['step 1', 'step 2', 'after image'])
    const projectedOk = definition.projectContent(execOk, { isError: false, content: [] })
    expect(projectedOk).toEqual([
      { type: 'text', text: 'step 1\nstep 2\n' },
      { type: 'image', attachment: imgRef },
      { type: 'text', text: 'after image\n' },
    ])
    // 消费一次后即清理 WeakMap
    expect(definition.projectContent(execOk, { isError: false, content: [] })).toBeUndefined()

    shouldFail = true
    const execFail = { callId: 'c-img-fail', signal: new AbortController().signal }
    let caught: unknown
    try {
      await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)({
        code: 'inspect("before crash"); inspect(img); throw new Error("bad")',
        description: 'failing with image',
      }, execFail)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CodeRunFailedError)
    // 含有图片块时错误文本不重复拼接 Captured output:，交由 projectContent 按序附在错误块后
    expect((caught as Error).message).toBe('program failed (exception): AssertionError: bad')
    const projectedFail = definition.projectContent(execFail, {
      isError: true,
      content: [{ type: 'text', text: (caught as Error).message }],
    })
    expect(projectedFail).toEqual([
      { type: 'text', text: 'program failed (exception): AssertionError: bad' },
      { type: 'text', text: 'before crash\n' },
      { type: 'image', attachment: imgRef },
    ])
  })

  it('PtcImage 一等公民绑定与未 inspect 图片自动 deferContext 零丢图兜底', async () => {
    const img1 = {
      kind: 'image-attachment' as const,
      attachmentId: 'img_inspected',
      mediaType: 'image/png',
      width: 64,
      height: 64,
      byteLength: 256,
    }
    const img2 = {
      kind: 'image-attachment' as const,
      attachmentId: 'img_forgotten',
      mediaType: 'image/jpeg',
      width: 120,
      height: 90,
      byteLength: 1024,
    }
    const deferred: unknown[] = []
    const receivedByProgram: unknown[] = []
    const host = {
      catalog: () => [
        ...catalog,
        { name: 'read_image', description: 'read image', parameters: {}, isConcurrencySafe: () => true },
      ],
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      programImage: (attachment: unknown, fallbackPath?: string) =>
        new PtcImageLike(fallbackPath ?? '/tmp/img.png', attachment as typeof img1),
      createImageContext: (content: readonly unknown[]) => ({ kind: 'deferred-image', content }),
      async callTool(req: { name: string; args: { file_path?: string } }) {
        const isFirst = req.args.file_path === 'a.png'
        const ref = isFirst ? img1 : img2
        return {
          value: { path: req.args.file_path, attachmentId: ref.attachmentId },
          content: [{ type: 'image', attachment: ref }],
        }
      },
      runtime: () => ({
        language: 'typescript',
        programFormat: 'scoped-repl',
        async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          const readImage = spec.bindings[0]!.functions['read_image']!
          const first = await readImage({ file_path: 'a.png' })
          const second = await readImage({ file_path: 'b.jpg' })
          receivedByProgram.push(first, second)
          // 程序只显式 inspect 了第一张图，漏掉了第二张图
          return {
            output: [{ type: 'image' as const, attachment: img1 }],
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)({
      code: 'const a = await tools.read_image({ file_path: "a.png" }); inspect(a)',
      description: 'ptc image fallback',
    }, {
      callId: 'c-ptc-img',
      signal: new AbortController().signal,
      deferContext: (msg: unknown) => { deferred.push(msg) },
    })
    expect(receivedByProgram).toHaveLength(2)
    expect((receivedByProgram[0] as Record<symbol, unknown>)[PTC_IMAGE_TAG]).toBe(true)
    expect((receivedByProgram[0] as PtcImageLike).path).toBe('a.png')
    expect((receivedByProgram[0] as PtcImageLike).width).toBe(64)
    // 第一张图已被 inspect，不走 deferContext；第二张图未被 inspect，自动由 deferContext 兜底补发
    expect(deferred).toEqual([
      { kind: 'deferred-image', content: [{ type: 'image', attachment: img2 }] },
    ])
  })

  it('子调用参数双快照隔离（工具原地修改 args 不污染回放日志）且审批等待期响应取消', async () => {
    const loggedEvents: { type: string; data: unknown }[] = []
    const agent = {
      session: {
        id: 'sess-iso',
        append(type: string, data: unknown) {
          loggedEvents.push({ type, data })
        },
      },
    }
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      async callTool(req: { args: Record<string, unknown> }) {
        // 模拟工具实现原地篡改入参对象
        req.args['file_path'] = 'MUTATED_BY_TOOL'
        req.args['injected'] = 'bad'
        return { value: 'ok', content: [{ type: 'text', text: 'ok' }] }
      },
      runtime: () => ({
        async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          await spec.bindings[0]!.functions['read']!({ path: 'original.ts' })
          return { output: [] }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, rules)
    await (definition.execute as (args: unknown, exec: unknown) => Promise<unknown>)({
      code: 'await tools.read({ path: "original.ts" })',
      description: 'arg isolation',
    }, { callId: 'c-iso', signal: new AbortController().signal, agent })
    const settled = loggedEvents.find((e) => e.type === 'tool/ptc-dispatch')?.data as { arguments: unknown }
    expect(settled.arguments).toEqual({ file_path: 'original.ts' })
  })

  it('scoped-repl 显式 inspect/output 存在时抑制末尾隐式完成值防刷屏，空 output 时保留完成值直出', async () => {
    const modeRef = { explicit: true }
    const host = {
      catalog: () => catalog,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
      runtime: () => ({
        language: 'typescript',
        programFormat: 'scoped-repl',
        async run() {
          if (modeRef.explicit) {
            return {
              output: [{ type: 'text' as const, text: 'summary: 2 items\n' }],
              // 模拟模型最后一行写了 state.cached = hugePayload 产生了巨大隐式完成值
              value: { hugeCache: ['a', 'b', 'c'] },
            }
          }
          return {
            output: [],
            value: { soleFinal: 42 },
          }
        },
      }),
    }
    const definition = createTransportDefinition(host as never, createRules({}))
    const execute = definition.execute as (args: unknown, exec: unknown) => Promise<{ logs: string[]; result?: unknown }>

    const explicitOut = await execute(
      { code: 'inspect("summary: 2 items"); cached = { hugeCache: ["a", "b", "c"] }', description: 'inspect suppresses completion' },
      { callId: 'c-sup-1', signal: new AbortController().signal },
    )
    expect(explicitOut.logs).toEqual(['summary: 2 items'])
    expect(explicitOut.result).toBeUndefined()
    expect(definition.output.render({}, explicitOut)).toEqual([{ type: 'text', text: 'summary: 2 items' }])

    modeRef.explicit = false
    const implicitOut = await execute(
      { code: '({ soleFinal: 42 })', description: 'empty output keeps completion' },
      { callId: 'c-sup-2', signal: new AbortController().signal },
    )
    expect(implicitOut.logs).toEqual([])
    expect(implicitOut.result).toEqual({ soleFinal: 42 })
    expect(definition.output.render({}, implicitOut)).toEqual([{ type: 'text', text: '{\n  "soleFinal": 42\n}' }])
  })

  it('未开放沙箱参数前置校验（#7869）与结构化错误身份（INVALID_ARGS / TOOL_CONTEXT_UNAVAILABLE）', async () => {
    const makeHost = (runtimeValue: unknown) => ({
      catalog: () => catalog,
      runtime: () => runtimeValue,
      stateOwner: () => ({}),
      releaseOwner: async () => undefined,
      callTool: async () => ({ value: 'ok' }),
    })

    // 1. 运行时缺失 -> CodemodeContextUnavailableError (TOOL_CONTEXT_UNAVAILABLE)
    const noRuntimeDef = createTransportDefinition(makeHost(undefined) as never, createRules({}))
    const runNoRuntime = noRuntimeDef.execute as (args: unknown, exec: unknown) => Promise<unknown>
    await expect(runNoRuntime({ code: '1', description: 'd' }, { callId: 'c1', signal: new AbortController().signal }))
      .rejects.toSatisfy((err: unknown) =>
        err instanceof CodemodeContextUnavailableError
        && err.name === 'ToolContextUnavailableError'
        && err.code === 'TOOL_CONTEXT_UNAVAILABLE')

    // 2. 参数不合法 -> CodemodeArgsError (INVALID_ARGS)
    await expect(runNoRuntime(null, { callId: 'c2', signal: new AbortController().signal }))
      .rejects.toSatisfy((err: unknown) =>
        err instanceof CodemodeArgsError && err.name === 'ToolArgsError' && err.code === 'INVALID_ARGS')
    await expect(runNoRuntime({ code: '1', description: 'd', timeoutMs: 0 }, { callId: 'c3', signal: new AbortController().signal }))
      .rejects.toSatisfy((err: unknown) =>
        err instanceof CodemodeArgsError && err.code === 'INVALID_ARGS')

    // 3. sandboxMode 为 undefined 时，即使仅单传 sandbox_permissions 也不先追问 justification，直接拒绝不可用
    const noSandboxDef = createTransportDefinition(makeHost({
      language: 'typescript',
      programFormat: 'scoped-repl',
      sandboxMode: undefined,
    }) as never, createRules({}))
    const runNoSandbox = noSandboxDef.execute as (args: unknown, exec: unknown) => Promise<unknown>
    await expect(runNoSandbox({
      code: '1',
      description: 'unpaired when unsupported',
      sandbox_permissions: 'workspace-write',
    }, { callId: 'c4', signal: new AbortController().signal }))
      .rejects.toSatisfy((err: unknown) =>
        err instanceof CodemodeArgsError
        && err.code === 'INVALID_ARGS'
        && err.message.includes('sandbox_permissions and justification are not available for this PTC runtime'))

    // 4. 支持 sandboxMode 时先走配对校验并抛出 SandboxEscalationError
    const withSandboxDef = createTransportDefinition(makeHost({
      language: 'typescript',
      programFormat: 'scoped-repl',
      sandboxMode: 'read-only',
    }) as never, createRules({}))
    const runWithSandbox = withSandboxDef.execute as (args: unknown, exec: unknown) => Promise<unknown>
    await expect(runWithSandbox({
      code: '1',
      description: 'unpaired when supported',
      sandbox_permissions: 'workspace-write',
    }, { callId: 'c5', signal: new AbortController().signal }))
      .rejects.toSatisfy((err: unknown) =>
        err instanceof SandboxEscalationError && err.code === 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  })
})
