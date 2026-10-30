/**
 * Kimi Code 前缀缓存守卫的单元测试。
 *
 * 覆盖两个模块：
 *
 * - `ptc-sdk-cache-guard`：把 `tools:sdk` 段按会话冻结，同时保留执行期的步骤准入。
 * - `compaction-policy-guard`：把 `compaction-basic` 的预算换成 Kimi Code 口径，
 *   并在摘要器接缝上原生替换压缩指令。
 *
 * 两个守卫都只做结构探测，因此这里用假的服务对象代替真实的 harness 服务。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  KIMI_CODE_PROVIDER,
  PTC_SDK_SECTION_NAME,
  installPtcSdkCacheGuard,
  readScopeProvider,
} from '../src/host/ptc-sdk-cache-guard.ts'
import { installPlanModeCacheGuard } from '../src/host/plan-mode-cache-guard.ts'
import {
  COMPACTION_SERVICE_NAME,
  KIMI_CODE_MODELS,
  KIMI_COMPACTION_POLICY_DEFAULTS,
  KIMI_COMPACTION_PROVIDER,
  installCompactionPolicyGuard,
} from '../src/host/compaction-policy-guard.ts'
import {
  COMPACTION_INSTRUCTION,
  SHIPPED_INSTRUCTION_OPENING,
} from '../src/host/compaction-prompt.ts'

/** 一个假工具。 */
interface FakeTool {
  name: string
}

/** 一个步骤准入集。 */
interface FakeToolSet {
  admitted: readonly string[]
}

/**
 * 假工具注册表：`definitions` 与 `executable` 都尊重步骤准入，
 * 与真实工具层的形状一致。
 */
class FakeTools {
  /** 已注册的工具。 */
  readonly entries: FakeTool[]

  /**
   * @param entries - 初始工具表。
   */
  constructor(entries: FakeTool[]) {
    this.entries = entries
  }

  /**
   * @param _scope - 视图片段。
   * @param toolSet - 步骤准入集。
   * @returns 可见定义。
   */
  definitions(_scope?: unknown, toolSet?: unknown): readonly FakeTool[] {
    if (toolSet === undefined) return [...this.entries]
    const admitted = (toolSet as FakeToolSet).admitted
    return this.entries.filter(entry => admitted.includes(entry.name))
  }

  /**
   * @param name - 工具名。
   * @param _scope - 视图片段。
   * @param toolSet - 步骤准入集。
   * @returns 可执行定义。
   */
  executable(name: string, _scope?: unknown, toolSet?: unknown): FakeTool | undefined {
    if (toolSet === undefined) return this.entries.find(entry => entry.name === name)
    const admitted = (toolSet as FakeToolSet).admitted
    return this.entries.find(entry => entry.name === name && admitted.includes(entry.name))
  }
}

/**
 * 造一个装配 scope。
 *
 * @param provider - provider id。
 * @param model - 模型 id。
 * @param options - 是否附带 agent 选项。
 * @returns scope 对象。
 */
function createScope(
  provider: string,
  model = 'kimi-for-coding',
  options: { readonly withOptions?: boolean } = {},
): Record<string, unknown> {
  const scope: Record<string, unknown> = {
    session: {
      requestHeader: () => ({ config: { provider, model } }),
    },
  }
  if (options.withOptions !== false) {
    scope['options'] = { provider, model }
  }
  return scope
}

/** 宿主事件监听器。 */
type HostListener = (...args: any[]) => any

/**
 * 造一个假宿主上下文。
 *
 * @param tools - `ctx.get('tools')` 要返回的工具层。
 * @returns 上下文与监听器表。
 */
function createHost(tools: unknown): {
  ctx: Record<string, unknown>
  listeners: Map<string, HostListener>
} {
  const listeners = new Map<string, HostListener>()
  const ctx: Record<string, unknown> = {
    get(name: string): unknown {
      return name === 'tools' ? tools : undefined
    },
    on(event: string, listener: HostListener): () => void {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
      }
    },
    inject(): void {
      // 假上下文不注入。
    },
  }
  return { ctx, listeners }
}

/**
 * 跑一次 `system-prompt/assemble` 瀑布。
 *
 * @param listeners - 监听器表。
 * @param scope - 装配 scope。
 * @param next - 产出装配结果的下一棒。
 * @returns 装配结果。
 */
async function runAssemble(
  listeners: Map<string, HostListener>,
  scope: unknown,
  next: () => Promise<unknown>,
): Promise<{ sections: { name?: unknown; text?: unknown }[] }> {
  const listener = listeners.get('system-prompt/assemble')
  expect(listener).toBeDefined()
  const result = await listener!({}, { scope }, next)
  return result as { sections: { name?: unknown; text?: unknown }[] }
}

/**
 * 取装配结果里 `tools:sdk` 段的正文。
 *
 * @param assembly - 装配结果。
 * @returns 段正文。
 */
function sdkTextOf(assembly: { sections: { name?: unknown; text?: unknown }[] }): string {
  const section = assembly.sections.find(entry => entry.name === PTC_SDK_SECTION_NAME)
  return typeof section?.text === 'string' ? section.text : ''
}

describe('readScopeProvider', () => {
  it('reads the provider from the request header snapshot', () => {
    expect(readScopeProvider(createScope('kimi-code'))).toBe('kimi-code')
  })

  it('falls back to the agent options when there is no session', () => {
    expect(readScopeProvider({ options: { provider: 'codex-chatgpt' } })).toBe('codex-chatgpt')
  })

  it('falls back to a bare provider field', () => {
    expect(readScopeProvider({ provider: 'kimi-code' })).toBe('kimi-code')
  })

  it('returns undefined for junk and for a throwing request header', () => {
    expect(readScopeProvider(undefined)).toBeUndefined()
    expect(readScopeProvider('kimi-code')).toBeUndefined()
    expect(readScopeProvider({ session: { requestHeader: () => { throw new Error('no header') } } }))
      .toBeUndefined()
    expect(readScopeProvider({ options: { provider: '' } })).toBeUndefined()
  })
})

describe('installPtcSdkCacheGuard — tools.definitions', () => {
  it('ignores the step tool set for a protected provider', () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const guard = installPtcSdkCacheGuard(createHost(tools).ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)
    const definitions = tools.definitions.bind(tools)
    expect(definitions(scope, { admitted: ['a'] }).map(entry => entry.name)).toEqual(['a', 'b'])
    guard.dispose()
  })

  it('passes the step tool set through for an unprotected provider', () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const guard = installPtcSdkCacheGuard(createHost(tools).ctx)
    const scope = createScope('codex-chatgpt')
    const definitions = tools.definitions.bind(tools)
    expect(definitions(scope, { admitted: ['a'] }).map(entry => entry.name)).toEqual(['a'])
    guard.dispose()
  })

  it('leaves tools.executable enforcing the step admission', () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const guard = installPtcSdkCacheGuard(createHost(tools).ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)
    const executable = tools.executable.bind(tools)
    expect(executable('b', scope, { admitted: ['a'] })).toBeUndefined()
    expect(executable('b', scope, { admitted: ['b'] })?.name).toBe('b')
    guard.dispose()
  })

  it('refuses a service that has no definitions method', () => {
    const guard = installPtcSdkCacheGuard(createHost(undefined).ctx)
    expect(guard.wrapToolsService(undefined)).toBe(false)
    expect(guard.wrapToolsService({})).toBe(false)
    expect(guard.wrapToolsService(new FakeTools([]))).toBe(true)
    guard.dispose()
  })

  it('restores the original definitions method on dispose', () => {
    const tools = new FakeTools([{ name: 'a' }])
    const original = tools.definitions
    const guard = installPtcSdkCacheGuard(createHost(tools).ctx)
    expect(tools.definitions).not.toBe(original)
    guard.dispose()
    expect(tools.definitions).toBe(original)
  })

  it('is idempotent for the same tools service', () => {
    const tools = new FakeTools([{ name: 'a' }])
    const guard = installPtcSdkCacheGuard(createHost(tools).ctx)
    expect(guard.wrapToolsService(tools)).toBe(false)
    guard.dispose()
  })
})

describe('installPtcSdkCacheGuard — system-prompt/assemble', () => {
  it('keeps the tools:sdk text byte-identical across steps', async () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const { ctx, listeners } = createHost(tools)
    const guard = installPtcSdkCacheGuard(ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)

    const first = await runAssemble(listeners, scope, async () => ({
      sections: [{
        name: PTC_SDK_SECTION_NAME,
        text: tools.definitions(scope, { admitted: ['a'] }).map(entry => entry.name).join(','),
      }],
    }))
    const second = await runAssemble(listeners, scope, async () => ({
      sections: [{
        name: PTC_SDK_SECTION_NAME,
        text: tools.definitions(scope, { admitted: ['b'] }).map(entry => entry.name).join(','),
      }],
    }))

    expect(sdkTextOf(first)).toBe('a,b')
    expect(sdkTextOf(second)).toBe('a,b')
    guard.dispose()
  })

  it('substitutes the cached text when the assembly fluctuates', async () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const { ctx, listeners } = createHost(tools)
    const guard = installPtcSdkCacheGuard(ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)

    await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V1' }],
    }))
    const second = await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V2' }],
    }))

    expect(sdkTextOf(second)).toBe('SDK-V1')
    guard.dispose()
  })

  it('invalidates the cache when the unfiltered tool set changes', async () => {
    const tools = new FakeTools([{ name: 'a' }])
    const { ctx, listeners } = createHost(tools)
    const guard = installPtcSdkCacheGuard(ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)

    await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V1' }],
    }))
    tools.entries.push({ name: 'b' })
    const second = await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V2' }],
    }))

    expect(sdkTextOf(second)).toBe('SDK-V2')
    guard.dispose()
  })

  it('does not cache an empty tools:sdk text', async () => {
    const tools = new FakeTools([{ name: 'a' }])
    const { ctx, listeners } = createHost(tools)
    const guard = installPtcSdkCacheGuard(ctx)
    const scope = createScope(KIMI_CODE_PROVIDER)

    await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: '' }],
    }))
    const second = await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V2' }],
    }))

    expect(sdkTextOf(second)).toBe('SDK-V2')
    guard.dispose()
  })

  it('leaves an unprotected provider alone', async () => {
    const tools = new FakeTools([{ name: 'a' }, { name: 'b' }])
    const { ctx, listeners } = createHost(tools)
    const guard = installPtcSdkCacheGuard(ctx)
    const scope = createScope('codex-chatgpt')

    await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V1' }],
    }))
    const second = await runAssemble(listeners, scope, async () => ({
      sections: [{ name: PTC_SDK_SECTION_NAME, text: 'SDK-V2' }],
    }))

    expect(sdkTextOf(second)).toBe('SDK-V2')
    guard.dispose()
  })
})

/** 一条压缩策略。 */
interface Policy {
  provider: string
  model: string
  thresholdRatio?: number
  headroomTokens?: number
  retainRatio?: number
  retainTokens?: number
  maxTokens?: number
}

/**
 * 复刻 DSH `resolveTargetPolicy` 的判定，只为断言用。
 *
 * @param config - 被改写后的配置。
 * @param target - 目标 provider/model。
 * @returns 命中的策略与最终保留形态。
 */
function resolveTargetPolicy(
  config: { modelPolicies: readonly Policy[]; retainTokens?: number; retainRatio?: number },
  target: { provider: string; model: string },
): { override: Policy | undefined; retention: { retainTokens?: number; retainRatio?: number } } {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inherited = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  const retention = override?.retainTokens !== undefined
    ? { retainTokens: override.retainTokens }
    : override?.retainRatio !== undefined
      ? { retainRatio: override.retainRatio }
      : inherited
  return { override, retention }
}

/** 一个假压缩引擎。 */
class FakeEngine {
  /** 引擎配置。 */
  config: {
    thresholdRatio: number
    headroomTokens: number
    retainRatio: number
    retainTokens?: number
    modelPolicies: Policy[]
  }

  /** 摘要器收到的输入。 */
  summarized: { messages?: readonly { role?: string; content?: readonly { type?: string; text?: string }[] }[] } | undefined

  /**
   * @param modelPolicies - 显式策略表。
   */
  constructor(modelPolicies: Policy[] = []) {
    this.config = {
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      modelPolicies,
    }
  }

  /**
   * @param agent - 本次压缩的 agent。
   * @param _trigger - 触发原因。
   * @returns 恒为 null 的压缩结果。
   */
  async compactIfNeeded(agent: unknown, _trigger?: unknown): Promise<null> {
    void agent
    return null
  }

  /**
   * @param input - 摘要输入。
   * @param _agent - 本次压缩的 agent。
   * @returns 恒为 null 的摘要结果。
   */
  async summarize(input: unknown, _agent?: unknown): Promise<null> {
    this.summarized = input as FakeEngine['summarized']
    return null
  }
}

describe('installCompactionPolicyGuard', () => {
  it('replaces the engine config with a frozen copy carrying the custom find', () => {
    const engine = new FakeEngine()
    const originalConfig = engine.config
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    expect(guard.patchEngine(engine)).toBe(true)
    expect(engine.config).not.toBe(originalConfig)
    expect(Object.isFrozen(engine.config)).toBe(true)
    expect(Object.isFrozen(engine.config.modelPolicies)).toBe(true)
    guard.dispose()
  })

  it('narrows a seeded Kimi model to the Kimi retention budget', () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    const { override, retention } = resolveTargetPolicy(engine.config, {
      provider: KIMI_COMPACTION_PROVIDER,
      model: 'kimi-for-coding',
    })
    expect(override).toBeDefined()
    expect(retention).toEqual({ retainTokens: KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens })
    expect(override?.thresholdRatio).toBe(KIMI_COMPACTION_POLICY_DEFAULTS.thresholdRatio)
    expect(override?.headroomTokens).toBe(KIMI_COMPACTION_POLICY_DEFAULTS.headroomTokens)
    expect(override?.maxTokens).toBe(KIMI_COMPACTION_POLICY_DEFAULTS.maxTokens)
    expect(override?.retainRatio).toBeUndefined()
    guard.dispose()
  })

  it('covers every pre-seeded Kimi model', () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    for (const model of KIMI_CODE_MODELS) {
      const { retention } = resolveTargetPolicy(engine.config, {
        provider: KIMI_COMPACTION_PROVIDER,
        model,
      })
      expect(retention).toEqual({ retainTokens: KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens })
    }
    guard.dispose()
  })

  it('lets an explicit user policy win over the Kimi default', () => {
    const engine = new FakeEngine([
      { provider: KIMI_COMPACTION_PROVIDER, model: 'kimi-for-coding', retainTokens: 999 },
    ])
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    const { override, retention } = resolveTargetPolicy(engine.config, {
      provider: KIMI_COMPACTION_PROVIDER,
      model: 'kimi-for-coding',
    })
    expect(override?.retainTokens).toBe(999)
    expect(retention).toEqual({ retainTokens: 999 })
    guard.dispose()
  })

  it('registers a dynamically observed Kimi model', async () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    const scope = createScope(KIMI_COMPACTION_PROVIDER, 'kimi-k2-preview')
    await engine.compactIfNeeded(scope)
    const { override, retention } = resolveTargetPolicy(engine.config, {
      provider: KIMI_COMPACTION_PROVIDER,
      model: 'kimi-k2-preview',
    })
    expect(override).toBeDefined()
    expect(retention).toEqual({ retainTokens: KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens })
    guard.dispose()
  })

  it('does not touch a non-Kimi provider', () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    const { override, retention } = resolveTargetPolicy(engine.config, {
      provider: 'codex-chatgpt',
      model: 'gpt-5',
    })
    expect(override).toBeUndefined()
    expect(retention).toEqual({ retainRatio: 0.16 })
    guard.dispose()
  })

  it('replaces the shipped compaction instruction at the summarizer seam', async () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    await engine.summarize({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'earlier context' }] },
        { role: 'user', content: [{ type: 'text', text: `${SHIPPED_INSTRUCTION_OPENING} Do the thing.` }] },
      ],
    }, createScope(KIMI_COMPACTION_PROVIDER))
    const messages = engine.summarized?.messages ?? []
    const last = messages[messages.length - 1]
    expect(last?.content?.[0]?.text).toBe(COMPACTION_INSTRUCTION)
    expect(messages[0]?.content?.[0]?.text).toBe('earlier context')
    guard.dispose()
  })

  it('is idempotent per engine', () => {
    const engine = new FakeEngine()
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    expect(guard.patchEngine(engine)).toBe(true)
    const patchedConfig = engine.config
    expect(guard.patchEngine(engine)).toBe(false)
    expect(engine.config).toBe(patchedConfig)
    guard.dispose()
  })

  it('restores the engine config and methods on dispose', () => {
    const engine = new FakeEngine()
    const originalConfig = engine.config
    const originalSummarize = engine.summarize
    const guard = installCompactionPolicyGuard(createHost(undefined).ctx)
    guard.patchEngine(engine)
    guard.dispose()
    expect(engine.config).toBe(originalConfig)
    expect(engine.summarize).toBe(originalSummarize)
  })

  it('finds the engine through the reflect store', () => {
    const engine = new FakeEngine()
    const { ctx } = createHost(undefined)
    const store: Record<symbol, unknown> = {}
    store[Symbol('compaction')] = { name: COMPACTION_SERVICE_NAME, value: engine }
    ctx['reflect'] = { store }
    const guard = installCompactionPolicyGuard(ctx)
    expect(engine.config).not.toBeUndefined()
    const { retention } = resolveTargetPolicy(engine.config, {
      provider: KIMI_COMPACTION_PROVIDER,
      model: 'k3',
    })
    expect(retention).toEqual({ retainTokens: KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens })
    guard.dispose()
  })

  it('subscribes to the agent events and rescans the reflect store', () => {
    const engine = new FakeEngine()
    const { ctx, listeners } = createHost(undefined)
    const store: Record<symbol, unknown> = {}
    ctx['reflect'] = { store }
    const guard = installCompactionPolicyGuard(ctx)
    expect(listeners.has('agent/pre-step')).toBe(true)
    expect(listeners.has('agent/request')).toBe(true)
    expect(listeners.has('agent/request-error')).toBe(true)
    store[Symbol('compaction')] = { name: COMPACTION_SERVICE_NAME, value: engine }
    listeners.get('agent/pre-step')!({ agent: createScope(KIMI_COMPACTION_PROVIDER) })
    const { retention } = resolveTargetPolicy(engine.config, {
      provider: KIMI_COMPACTION_PROVIDER,
      model: 'k3',
    })
    expect(retention).toEqual({ retainTokens: KIMI_COMPACTION_POLICY_DEFAULTS.retainTokens })
    guard.dispose()
  })
})

/**
 * 真实 Cordis 服务上的多作用域回归。
 *
 * Cordis 的 `Service` 代理在读属性时会把方法**绑定到读取它的那一层作用域**。守卫若把
 * 那份绑定版原样传下去（`original.call(tools, …)`），调用方的作用域就丢了：两个子
 * 作用域注册同一个工具名会一起落进根作用域的全局层，撞上 "already registered"。
 *
 * 这里用真实的 `Context` / `Service` 钉住那条规则：包装必须取**原型上那份未绑定的
 * 实现**，并把**调用方自己的 receiver** 传下去。
 */

/** 作用域标签：子上下文用自有属性标出自己的作用域。 */
const SCOPE_KEY = Symbol('dsh-chatgpt-subscription.test.scope')

/** 一次工具注册留下的痕迹。 */
interface ScopeRegistration {
  /** 工具名。 */
  name: string
  /** register 里的 this.ctx —— 必须是调用方那一层作用域。 */
  ctx: unknown
  /** this.ctx 上的作用域标签。 */
  scope: unknown
}

/** 一次 definitions 调用留下的痕迹。 */
interface ScopeDefinitionCall {
  /** definitions 里的 this.ctx。 */
  ctx: unknown
  /** this.ctx 上的作用域标签。 */
  scope: unknown
}

/**
 * 一个真实 Cordis 服务：工具按作用域分桶，同名工具只在同一层撞车。
 */
class ScopedCordisToolsService extends Service {
  /** 每次注册留下的痕迹。 */
  readonly registrations: ScopeRegistration[] = []
  /** 每次 definitions 留下的痕迹。 */
  readonly definitionCalls: ScopeDefinitionCall[] = []
  /** 全局层已注册的工具名。 */
  readonly globalNames = new Set<string>()
  /** 每个作用域已注册的工具名。 */
  readonly scopedNames = new Map<unknown, Set<string>>()

  /**
   * @param ctx - 宿主上下文。
   * @param name - 服务名。
   */
  constructor(ctx: Context, name: string) {
    super(ctx, name)
  }

  /**
   * @param definition - 工具定义。
   * @returns 注销动作。
   */
  register(definition: { name: string }): () => void {
    const scope = (this.ctx as unknown as Record<symbol, unknown>)[SCOPE_KEY]
    this.registrations.push({ name: definition.name, ctx: this.ctx, scope })
    const names = scope === undefined ? this.globalNames : this.scopedNamesOf(scope)
    if (names.has(definition.name)) {
      throw new Error(scope === undefined
        ? `tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`
        : `tool "${definition.name}" is already registered in this scope`)
    }
    names.add(definition.name)
    return () => { names.delete(definition.name) }
  }

  /**
   * @param _scope - 视图片段。
   * @param toolSet - 步骤准入集。
   * @returns 可见定义。
   */
  definitions(_scope?: unknown, toolSet?: unknown): readonly { name: string }[] {
    this.definitionCalls.push({
      ctx: this.ctx,
      scope: (this.ctx as unknown as Record<symbol, unknown>)[SCOPE_KEY],
    })
    const all = [{ name: 'list_subagent_models' }, { name: 'other_tool' }]
    if (toolSet === undefined) return all
    const admitted = (toolSet as { admitted?: readonly string[] }).admitted ?? []
    return all.filter(entry => admitted.includes(entry.name))
  }

  /**
   * @param scope - 作用域键。
   * @returns 该作用域已注册的工具名。
   */
  private scopedNamesOf(scope: unknown): Set<string> {
    let names = this.scopedNames.get(scope)
    if (names === undefined) {
      names = new Set<string>()
      this.scopedNames.set(scope, names)
    }
    return names
  }
}

/**
 * 从一个上下文里读出工具服务。
 *
 * cordis 的 `ctx.get` 是运行期 mixin，类型声明上没有，所以这里显式收窄。
 * @param ctx - 上下文。
 * @returns 工具服务。
 */
function cordisToolsOf(ctx: Context): {
  register(definition: { name: string }): unknown
  definitions(scope?: unknown, toolSet?: unknown): readonly { name: string }[]
} {
  return (ctx as unknown as { get(name: string): unknown }).get('tools') as never
}

describe('the cache guards on a real Cordis service', () => {
  it('keeps the calling scope, so two child scopes can register the same tool', () => {
    const root = new Context()
    const tools = new ScopedCordisToolsService(root, 'tools')
    const childA = root.extend({ [SCOPE_KEY]: 'A' })
    const childB = root.extend({ [SCOPE_KEY]: 'B' })

    const planGuard = installPlanModeCacheGuard(root)
    const sdkGuard = installPtcSdkCacheGuard(root)
    try {
      cordisToolsOf(childA).register({ name: 'list_subagent_models' })
      cordisToolsOf(childB).register({ name: 'list_subagent_models' })

      expect(tools.registrations).toHaveLength(2)
      expect(tools.registrations[0].scope).toBe('A')
      expect(tools.registrations[1].scope).toBe('B')
      // this.ctx 是调用方那一层作用域的影子（它的原型就是那个子上下文）。
      expect(Object.getPrototypeOf(tools.registrations[0].ctx)).toBe(childA)
      expect(Object.getPrototypeOf(tools.registrations[1].ctx)).toBe(childB)
      // 全局层始终是空的：两次注册没有落到根作用域上去撞车。
      expect(tools.globalNames.size).toBe(0)
    } finally {
      planGuard.dispose()
      sdkGuard.dispose()
    }
  })

  it('keeps the scope on tools.definitions and still ignores the step tool set', () => {
    const root = new Context()
    const tools = new ScopedCordisToolsService(root, 'tools')
    const childA = root.extend({ [SCOPE_KEY]: 'A' })

    const planGuard = installPlanModeCacheGuard(root)
    const sdkGuard = installPtcSdkCacheGuard(root)
    try {
      const scope = createScope(KIMI_CODE_PROVIDER)
      const definitions = cordisToolsOf(childA).definitions(scope, { admitted: ['other_tool'] })

      // 受保护线路：步骤级 toolSet 被忽略，工具表逐步恒定。
      expect(definitions.map(entry => entry.name)).toEqual(['list_subagent_models', 'other_tool'])
      // 作用域没丢：this.ctx 仍在调用方那一层。
      expect(tools.definitionCalls).toHaveLength(1)
      expect(tools.definitionCalls[0].scope).toBe('A')
      expect(Object.getPrototypeOf(tools.definitionCalls[0].ctx)).toBe(childA)
    } finally {
      planGuard.dispose()
      sdkGuard.dispose()
    }
  })
})
