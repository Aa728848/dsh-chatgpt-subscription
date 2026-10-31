import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostToolDecision, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * 宿主半边接线：post-execute 的新结果投影、线路识别、开关的即时生效、提示词分节、
 * 工具注册，以及可选服务缺席时的降级。
 *
 * 核心半边（`../src/host/cache-warmup/index.ts`）在这里整个被替换成**替身**：本职
 * 只负责接线，投影策略与存储属于核心，混进来只会让一条断言同时受两处改动影响。
 * 替身也让这些用例在核心还没落地时就能写——契约由共享接口约定钉住。
 *
 * 假 ctx 做成**真实 Cordis 的形状**：可选服务只出现在 `get()` 后面。直接读属性在
 * 真宿主上会抛 `cannot get property "..." without inject`，一次就把整个插件打成
 * degraded，所以测试必须能复现那个边界。
 */

/** 核心替身的共享状态；`vi.hoisted` 让 mock 工厂够得着它。 */
const core = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = []
  const state = { throwOnProject: false, throwOnConstruct: false, changedOnProject: true }
  /** 预算与快照同形：核心约定这两者都描述 maxChars / warmup / 命中率。 */
  const budget = { maxChars: 4000, warmup: false, consecutiveHits: 2, hitRatio: 0.6 }
  /**
   * 回归样本：一段形如真实崩溃消息的异常正文。
   *
   * 三样都在里面——绝对路径、形似凭据的串、以及工具结果的原文——因为这三样正是
   * 评审指出的泄漏面：`error.message` 一旦拼进宿主日志，它们会一起进去。
   */
  const sensitive = {
    path: 'C:\\Users\\A\\Documents\\secret\\credentials.json',
    token: 'sk-live-SECRET-TOKEN',
    body: 'RAW-FULL-RESULT-BODY',
  }
  /** 完整消息：ENOENT + 绝对路径 + 形似凭据的串 + 结果原文，全在同一行。 */
  const sensitiveMessage =
    'ENOENT: no such file or directory, open ' + sensitive.path
    + ' (' + sensitive.token + ') while rendering ' + sensitive.body
  return { calls, state, budget, sensitive, sensitiveMessage }
})

vi.mock('../src/host/cache-warmup/index.ts', () => ({
  // 契约里的默认值：install 只用到 `consecutiveHitsRequired`（预热退出的判定阈值），
  // 但整份默认值都照契约给出来，免得替身比真实导出少一个键就炸在运行期。
  CACHE_WARMUP_DEFAULTS: {
    warmupMaxChars: 1200,
    steadyStateMaxChars: 8000,
    hitRatioThreshold: 0.97,
    consecutiveHitsRequired: 2,
    retainedPrefixMinCachedTokens: 1024,
    retainedPrefixMaxFreshTokens: 256,
    cacheTtlMs: 25 * 60 * 1000,
    maxResultBytes: 8 * 1024 * 1024,
    maxSessionBytes: 64 * 1024 * 1024,
    pageLimitDefault: 64,
    pageLimitMax: 512,
    pageMaxBytesDefault: 16 * 1024,
    pageMaxBytesMax: 64 * 1024,
    maxUsageSessions: 256,
    maxUsageReportsPerSession: 32,
  },
  FileResultReferenceStore: class {
    constructor() {
      // 模拟"这台主机上建不出引用存储"：消息里带着路径与原文，正好用来验证日志。
      if (core.state.throwOnConstruct) {
        throw Object.assign(new Error(core.sensitiveMessage), { code: 'EROOT' })
      }
    }
    async put(): Promise<string> { return 'ref://fake/0' }
    async page(): Promise<unknown> { return { complete: true } }
    async release(): Promise<boolean> { return true }
  },
  cacheWarmupBudget: () => core.budget,
  cacheWarmupSnapshot: () => core.budget,
  projectToolResult: async (input: Record<string, unknown>) => {
    core.calls.push(input)
    if (core.state.throwOnProject) throw new Error(core.sensitiveMessage)
    return {
      content: [{ type: 'text', text: 'PREVIEW' }],
      changed: core.state.changedOnProject,
      metrics: { inputChars: 100, outputChars: 8, omittedChars: 92, strategy: 'preview' },
    }
  },
}))

import {
  CACHE_WARMUP_GUIDANCE,
  CACHE_WARMUP_SECTION_NAME,
  cacheWarmupRouteOf,
  installCacheWarmup,
} from '../src/host/cache-warmup/install.ts'
import { CACHE_WARMUP_RESULT_TOOL } from '../src/host/cache-warmup/result-tool.ts'
import { cacheWarmupErrorLabel } from '../src/host/cache-warmup/logging.ts'

/** post-execute 监听器的签名（只用得到这三样）。 */
type PostExecuteListener = (
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  next: () => Promise<PostToolDecision>,
) => Promise<PostToolDecision>

/** 一个用例里收集的 disposer，用完统一释放。 */
let disposers: Array<() => void> = []

/** 当前设置；对象本身可变，用来模拟 volatile 活引用在会话中途被改写。 */
let settings: { enabled: boolean, retrievalEnabled?: boolean }

/** 断言"投影没有被调用"用的计数。 */
const projectionCalls = (): number => core.calls.length

/** 一次成功工具结果的形状。 */
const fullResult = (): Readonly<ToolExecutionResult> => ({
  isError: false,
  content: [{ type: 'text', text: 'FULL-RESULT-BODY' }],
  value: { rows: [1, 2, 3] },
} as unknown as Readonly<ToolExecutionResult>)

/**
 * 造一次 `run_code` 执行。
 * @param provider - 会话被告知的线路。
 * @param sessionId - 会话 id；传 `undefined` 模拟拿不到会话。
 * @returns post-execute 需要的执行字段子集。
 */
const runCodeExec = (provider = 'kimi-code', sessionId: string | undefined = 'sess-1'): ToolExecution => ({
  name: 'run_code',
  arguments: {},
  agent: {
    ...(sessionId === undefined ? {} : { id: sessionId }),
    session: {
      ...(sessionId === undefined ? {} : { header: { id: sessionId } }),
      requestHeader: () => ({ config: { provider } }),
    },
    options: { provider },
  },
} as unknown as ToolExecution)

/** 造一次带最新用户意图的直接检索执行。 */
const retrievalExec = (name: string, userText: string): ToolExecution => ({
  name,
  arguments: {},
  agent: {
    id: 'sess-1',
    session: {
      header: { id: 'sess-1' },
      requestHeader: () => ({ config: { provider: 'kimi-code' } }),
      events: [{ type: 'user/message', data: { content: [{ type: 'text', text: userText }] } }],
    },
    options: { provider: 'kimi-code' },
  },
} as unknown as ToolExecution)

/** 假存储：本文件的所有断言都走注入的那一个。 */
const fakeStore = {
  put: () => Promise.resolve('ref://fake/0'),
  page: () => Promise.resolve({ complete: true }),
  release: () => Promise.resolve(true),
}

/** 假宿主上下文。 */
interface FakeHost {
  /** 交给 ctx.get 的服务表。 */
  services: Map<string, unknown>
  /** 注册上来的工具。 */
  tools: Map<string, ToolDefinition>
  /** 注册上来的提示词分节。 */
  sections: Map<string, { name: string, order: number, text: () => string }>
  /** 注册上来的 post-execute 监听器。 */
  listeners: Map<string, PostExecuteListener>
  /** logger.info 收到的行。 */
  info: string[]
  /** logger.warn 收到的行。 */
  warnings: string[]
}

/**
 * 造一个假宿主上下文。
 * @param options - 想提供哪些可选服务。
 * @returns 上下文与断言用的探针。
 */
function makeHost(options: { tools?: boolean, systemPrompt?: boolean } = {}): { ctx: unknown, host: FakeHost } {
  const host: FakeHost = {
    services: new Map<string, unknown>(),
    tools: new Map<string, ToolDefinition>(),
    sections: new Map<string, { name: string, order: number, text: () => string }>(),
    listeners: new Map<string, PostExecuteListener>(),
    info: [],
    warnings: [],
  }
  if (options.tools !== false) {
    host.services.set('tools', {
      register: (tool: ToolDefinition) => {
        host.tools.set(tool.name, tool)
        return () => { host.tools.delete(tool.name) }
      },
    })
  }
  if (options.systemPrompt !== false) {
    host.services.set('systemPrompt', {
      section: (section: { name: string, order: number, text: () => string }) => {
        host.sections.set(section.name, section)
        return () => { host.sections.delete(section.name) }
      },
    })
  }
  const ctx = {
    effect: (fn: () => unknown) => {
      const disposer = fn()
      disposers.push(disposer as () => void)
      return disposer
    },
    on: (event: string, listener: PostExecuteListener) => {
      host.listeners.set(event, listener)
      return () => { host.listeners.delete(event) }
    },
    get: (key: string) => host.services.get(key),
    logger: {
      info: (message: string) => { host.info.push(message) },
      warn: (message: string) => { host.warnings.push(message) },
    },
  }
  return { ctx, host }
}

/**
 * 装一次，并把 post-execute 监听器取出来。
 * @param options - 想提供哪些可选服务，以及存储是否缺席。
 * @returns 假宿主与监听器。
 */
function install(options: {
  tools?: boolean,
  systemPrompt?: boolean,
  /**
   * 存储来源：`injected`（默认，可用替身）、`absent`（注入返回 undefined）、
   * `throwing`（注入直接抛异常）、`default`（不注入，交给 install 自己构造）。
   */
  store?: 'injected' | 'absent' | 'throwing' | 'default',
} = {}): {
  host: FakeHost,
  listener: PostExecuteListener,
} {
  const { ctx, host } = makeHost(options)
  const mode = options.store ?? 'injected'
  const dispose = installCacheWarmup(ctx as never, {
    settings: () => settings,
    ...(mode === 'default' ? {} : {
      store: () => {
        if (mode === 'throwing') {
          throw Object.assign(new Error(core.sensitiveMessage), { code: 'EACCES' })
        }
        return mode === 'absent' ? undefined : fakeStore as never
      },
    }),
  })
  disposers.push(dispose)
  const listener = host.listeners.get('tools/post-execute')
  if (listener === undefined) throw new Error('post-execute listener was not registered')
  return { host, listener }
}

/** `next()` 交回同一个决策对象：用来断言"原样返回"。 */
const acceptAll = (decision: PostToolDecision) => () => Promise.resolve(decision)

beforeEach(() => {
  disposers = []
  settings = { enabled: true, retrievalEnabled: false }
  core.calls.length = 0
  core.state.throwOnProject = false
  core.state.throwOnConstruct = false
  core.state.changedOnProject = true
  core.budget.warmup = false
})

afterEach(() => {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      // 卸载失败与断言无关，吞掉即可。
    }
  }
  disposers = []
})

describe('cache warmup host integration', () => {
  it('leaves a non-Kimi session untouched', async () => {
    const { host } = install()
    const decision: PostToolDecision = { kind: 'accept' }
    const listener = host.listeners.get('tools/post-execute') as PostExecuteListener
    const returned = await listener(runCodeExec('openai'), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('projects a value-carrying decision: the canonical value is no longer a gate', async () => {
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { ok: true } }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    // 核心真的换了内容：换成带预览的 accept 决策。
    expect(projectionCalls()).toBe(1)
    expect(JSON.stringify(returned)).toContain('PREVIEW')
    expect(returned.kind === 'accept' ? returned.value : undefined).toBeUndefined()
  })

  it('keeps decision.value when the core leaves the content alone', async () => {
    // 核心没生成预览：原决策对象原样交回，value 一点不丢。
    core.state.changedOnProject = false
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { ok: true } }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(projectionCalls()).toBe(1)
    expect(returned).toBe(decision)
    expect(returned.kind === 'accept' ? returned.value : undefined).toEqual({ ok: true })
  })

  it('keeps direct retrieval values untouched while the independent switch is off', async () => {
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { path: 'src/a.ts', lines: [] } }
    const returned = await listener(retrievalExec('read', '请定位相关函数'), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('projects a value-carrying retrieval result only for explicit navigation', async () => {
    settings = { enabled: true, retrievalEnabled: true }
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { path: 'src/a.ts', lines: [] } }
    const returned = await listener(retrievalExec('read', '请定位相关函数'), fullResult(), acceptAll(decision))
    expect(JSON.stringify(returned)).toContain('PREVIEW')
    expect(returned.kind === 'accept' ? returned.value : undefined).toBeUndefined()
    expect(core.calls[0]?.navigation).toBe(true)
    const editing = await listener(retrievalExec('read', '请查找并修复这个函数'), fullResult(), acceptAll(decision))
    expect(editing).toBe(decision)
    expect(projectionCalls()).toBe(1)
  })

  it('keeps retrieval projection independent from the legacy log switch', async () => {
    settings = { enabled: false, retrievalEnabled: true }
    const { listener } = install()
    const returned = await listener(retrievalExec('web_fetch', 'list the page sections'), fullResult(), acceptAll({ kind: 'accept', value: { body: {} } }))
    expect(JSON.stringify(returned)).toContain('PREVIEW')
    expect(projectionCalls()).toBe(1)
  })

  it('allows PTC outlines independently and rejects PTC editing intent', async () => {
    settings = { enabled: false, retrievalEnabled: true }
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: 'NUMBERED-FILE' }] }
    const projected = await listener(retrievalExec('run_code', '请定位并列出函数'), fullResult(), acceptAll(decision))
    expect(JSON.stringify(projected)).toContain('PREVIEW')
    expect(core.calls[0]?.navigation).toBe(true)
    expect(core.calls[0]?.retrievalOnly).toBe(true)
    const editing = await listener(retrievalExec('run_code', '请读取并修复这个文件'), fullResult(), acceptAll(decision))
    expect(editing).toBe(decision)
    expect(projectionCalls()).toBe(1)
  })

  it('admits a value-carrying PTC read for navigation', async () => {
    settings = { enabled: true, retrievalEnabled: true }
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { path: 'src/a.ts', lines: [] } }
    const projected = await listener(retrievalExec('run_code', '请定位并列出函数'), fullResult(), acceptAll(decision))
    expect(JSON.stringify(projected)).toContain('PREVIEW')
    expect(core.calls[0]?.navigation).toBe(true)
    expect(projectionCalls()).toBe(1)
  })

  it('projects a value-carrying run_code even when navigation is false', async () => {
    // 日志开关开着时，意图是编辑（navigation === false）也不挡：
    // value 不再是门，核心没换内容时 value 才原样保留。
    settings = { enabled: true, retrievalEnabled: true }
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { path: 'src/a.ts', lines: [] } }
    const returned = await listener(retrievalExec('run_code', '请读取并修复这个文件'), fullResult(), acceptAll(decision))
    expect(projectionCalls()).toBe(1)
    expect(core.calls[0]?.navigation).toBe(false)
    expect(JSON.stringify(returned)).toContain('PREVIEW')
  })

  it('still rejects a value-carrying PTC read with editing intent on the retrieval path alone', async () => {
    // 只开检索开关时，编辑意图仍然挡住 PTC 检索投影 —— 旧的日志开关关闭，
    // value 不再是门，但意图仍然是门。
    settings = { enabled: false, retrievalEnabled: true }
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept', value: { path: 'src/a.ts', lines: [] } }
    const editing = await listener(retrievalExec('run_code', '请读取并修复这个文件'), fullResult(), acceptAll(decision))
    expect(editing).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('leaves a blocked decision untouched', async () => {
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('leaves a tool other than run_code/shell untouched', async () => {
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept' }
    const exec = { ...runCodeExec(), name: 'read' } as ToolExecution
    const returned = await listener(exec, fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('projects standalone shell and job_output tools on Kimi line', async () => {
    const { listener } = install()
    for (const toolName of ['win_bash', 'bash', 'pwsh', 'job_output']) {
      const exec = { ...runCodeExec(), name: toolName } as ToolExecution
      const returned = await listener(exec, fullResult(), acceptAll({ kind: 'accept' }))
      expect(returned.kind).toBe('accept')
      expect(JSON.stringify(returned)).toContain('PREVIEW')
    }
    expect(projectionCalls()).toBe(4)
  })

  it('projects a Kimi run_code result by replacing content only', async () => {
    const { listener } = install()
    const contexts = [{ role: 'user' }] as never
    const original: PostToolDecision = {
      kind: 'accept',
      content: [{ type: 'text', text: 'ORIGINAL' }],
      additionalContexts: contexts,
    }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(original))

    expect(returned.kind).toBe('accept')
    expect(projectionCalls()).toBe(1)
    // 只替换 content：value 不存在，additionalContexts 是**同一个引用**。
    expect(returned.kind === 'accept' ? returned.value : undefined).toBeUndefined()
    expect(returned.kind === 'accept' ? returned.additionalContexts : undefined).toBe(contexts)
    expect(JSON.stringify(returned)).toContain('PREVIEW')
    expect(JSON.stringify(returned)).not.toContain('ORIGINAL')
    // 交给核心的是未被替换的原始内容与这条线路的名字。
    const input = core.calls[0] as { toolName?: string, provider?: string, sessionId?: string, isError?: boolean }
    expect(input.toolName).toBe('run_code')
    expect(input.provider).toBe('kimi-code')
    expect(input.sessionId).toBe('sess-1')
    expect(input.isError).toBe(false)
    expect(JSON.stringify(input)).toContain('ORIGINAL')
  })

  it('falls back to the original content when the decision carries none', async () => {
    const { listener } = install()
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    const input = core.calls[0] as { content?: Array<{ text?: string }> }
    expect(JSON.stringify(input.content)).toContain('FULL-RESULT-BODY')
  })

  it('keeps the original decision when the session cannot be resolved', async () => {
    const { listener } = install()
    const decision: PostToolDecision = { kind: 'accept' }
    // 没有 session.header.id，也没有 agent.id：会话拿不到就不投影。
    const exec = {
      name: 'run_code',
      arguments: {},
      agent: { session: { requestHeader: () => ({ config: { provider: 'kimi-code' } }) } },
    } as unknown as ToolExecution
    const returned = await listener(exec, fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('keeps the original decision when no store is available', async () => {
    const { listener } = install({ store: 'absent' })
    const decision: PostToolDecision = { kind: 'accept' }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(projectionCalls()).toBe(0)
  })

  it('re-reads the setting so disabling only affects later results', async () => {
    const { listener } = install()
    const first: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: 'ORIGINAL-1' }] }
    const projected = await listener(runCodeExec(), fullResult(), acceptAll(first))
    expect(projectionCalls()).toBe(1)
    expect(JSON.stringify(projected)).toContain('PREVIEW')

    settings = { enabled: false }
    const second: PostToolDecision = { kind: 'accept', content: [{ type: 'text', text: 'ORIGINAL-2' }] }
    const untouched = await listener(runCodeExec(), fullResult(), acceptAll(second))
    // 关闭之后：新结果原样，投影一次都没多调。
    expect(untouched).toBe(second)
    expect(projectionCalls()).toBe(1)
    // 已经投影过的那个结果仍然是它当时的形状（历史不随开关改变）。
    expect(JSON.stringify(projected)).toContain('PREVIEW')

    settings = { enabled: true }
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    expect(projectionCalls()).toBe(2)
  })

  it('survives a throwing projection and keeps the successful result successful', async () => {
    const { host, listener } = install()
    core.state.throwOnProject = true
    const decision: PostToolDecision = { kind: 'accept' }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    expect(host.warnings.some(line => line.includes('cache warmup projection skipped'))).toBe(true)
  })

  it('never writes an exception message into the host log', async () => {
    const { host, listener } = install()
    core.state.throwOnProject = true
    const decision: PostToolDecision = { kind: 'accept' }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    // 降级行为不变：原样返回，不把错误重新抛出去。
    expect(returned).toBe(decision)
    const line = host.warnings.find(entry => entry.includes('cache warmup projection skipped'))
    expect(line).toBeDefined()
    // 只留稳定身份。
    expect(line).toContain('Error')
    // 绝对路径、形似凭据的串、结果原文，连系统调用的名字都不许进日志。
    expect(line).not.toContain(core.sensitive.path)
    expect(line).not.toContain(core.sensitive.token)
    expect(line).not.toContain(core.sensitive.body)
    expect(line).not.toContain('ENOENT')
  })

  it('logs a stable code instead of the message when the injected store throws', async () => {
    const { host, listener } = install({ store: 'throwing' })
    const decision: PostToolDecision = { kind: 'accept' }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    const line = host.warnings.find(entry => entry.includes('cache warmup store injection failed'))
    expect(line).toBeDefined()
    expect(line).toContain('Error/EACCES')
    expect(line).not.toContain(core.sensitive.path)
    expect(line).not.toContain(core.sensitive.body)
  })

  it('logs a stable code when the store cannot be constructed', async () => {
    core.state.throwOnConstruct = true
    const { host, listener } = install({ store: 'default' })
    const decision: PostToolDecision = { kind: 'accept' }
    const returned = await listener(runCodeExec(), fullResult(), acceptAll(decision))
    expect(returned).toBe(decision)
    const line = host.warnings.find(entry => entry.includes('cache warmup store unavailable'))
    expect(line).toBeDefined()
    expect(line).toContain('Error/EROOT')
    expect(line).not.toContain(core.sensitive.path)
    expect(line).not.toContain(core.sensitive.token)
  })

  it('labels an error by name and code, never by its message', () => {
    expect(cacheWarmupErrorLabel(new Error(core.sensitiveMessage))).toBe('Error')
    expect(cacheWarmupErrorLabel(Object.assign(new Error(core.sensitiveMessage), { code: 'SESSION_MISMATCH' })))
      .toBe('Error/SESSION_MISMATCH')
    expect(cacheWarmupErrorLabel(new RangeError('x'))).toBe('RangeError')
    // 非对象抛出物没有稳定身份：只报 Error，绝不复述那个值本身。
    expect(cacheWarmupErrorLabel(core.sensitiveMessage)).toBe('Error')
    expect(cacheWarmupErrorLabel(undefined)).toBe('Error')
    expect(cacheWarmupErrorLabel({ name: '', code: '' })).toBe('Error')
  })

  it('logs metrics without the raw result text', async () => {
    const { host, listener } = install()
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    const line = host.info.find(entry => entry.includes('[cache-warmup]'))
    expect(line).toBeDefined()
    expect(line).toContain('"event":"projection"')
    expect(line).toContain('"strategy":"preview"')
    expect(line).toContain('"inputChars":100')
    // 原文一个字都不许进日志。
    expect(line).not.toContain('FULL-RESULT-BODY')
    expect(line).not.toContain('PREVIEW')
  })

  it('logs the warmup exit once when the window closes', async () => {
    const { host, listener } = install()
    core.budget.warmup = true
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    core.budget.warmup = false
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    const exits = host.info.filter(line => line.includes('"event":"warmup-exit"'))
    expect(exits).toHaveLength(1)
    // 连续命中 2 条 = 核心契约的 consecutiveHitsRequired，算"稳住了"。
    expect(exits[0]).toContain('"reason":"settled"')
    // 已经退出之后再投影不会再发第二条。
    await listener(runCodeExec(), fullResult(), acceptAll({ kind: 'accept' }))
    expect(host.info.filter(line => line.includes('"event":"warmup-exit"'))).toHaveLength(1)
  })

  it('registers the result tool and a static prompt section', async () => {
    const { host } = install()
    expect(host.tools.has(CACHE_WARMUP_RESULT_TOOL)).toBe(true)
    const section = host.sections.get(CACHE_WARMUP_SECTION_NAME)
    expect(section).toBeDefined()
    // 文本恒定：开关怎么改都是同一段（系统提示是缓存前缀，不能中途变字）。
    const text = section?.text() ?? ''
    expect(text).toBe(CACHE_WARMUP_GUIDANCE)
    settings = { enabled: false }
    expect(section?.text()).toBe(text)
    expect(text).toContain('cache_warmup_result')
  })

  it('prefers the request header route over the agent options', () => {
    const route = cacheWarmupRouteOf({
      id: 'agent-1',
      session: { header: { id: 'sess-1' }, requestHeader: () => ({ config: { provider: 'kimi-code' } }) },
      options: { provider: 'openai' },
    })
    expect(route.provider).toBe('kimi-code')
    expect(route.sessionId).toBe('sess-1')
  })

  it('falls back to the agent options when the request header is unusable', () => {
    const noHeader = cacheWarmupRouteOf({
      session: { header: { id: 'sess-1' }, requestHeader: () => undefined },
      options: { provider: 'kimi-code' },
    })
    expect(noHeader.provider).toBe('kimi-code')
    // requestHeader 抛错（会话正在拆除）同样退回 options，而不是把监听器炸掉。
    const throwing = cacheWarmupRouteOf({
      session: { header: { id: 'sess-2' }, requestHeader: () => { throw new Error('torn down') } },
      options: { provider: 'kimi-code' },
    })
    expect(throwing.provider).toBe('kimi-code')
    expect(throwing.sessionId).toBe('sess-2')
    // 两处都没有 provider 时返回空对象，调用方据此放手。
    expect(cacheWarmupRouteOf({}).provider).toBeUndefined()
  })

  it('starts quietly when the optional services are absent', async () => {
    const { host } = install({ tools: false, systemPrompt: false })
    // 没有 tools / systemPrompt：什么也不注册，但挂载本身不抛。
    expect(host.tools.size).toBe(0)
    expect(host.sections.size).toBe(0)
    expect(host.listeners.has('tools/post-execute')).toBe(true)
  })

  it('degrades quietly when ctx.get throws for an unknown service', async () => {
    const { ctx } = makeHost({ tools: false, systemPrompt: false })
    const throwing = {
      ...(ctx as Record<string, unknown>),
      get: () => { throw new Error('cannot get property without inject') },
    }
    const dispose = installCacheWarmup(throwing as never, {
      settings: () => settings,
      store: () => fakeStore as never,
    })
    // 挂载本身不抛，交回来的仍然是一个可用的卸载函数。
    expect(typeof dispose).toBe('function')
    disposers.push(dispose)
  })
})
