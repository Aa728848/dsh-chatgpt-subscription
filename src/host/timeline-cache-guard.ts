/**
 * 「Timeline 规划段前缀缓存守卫」—— 把实验性 Timeline 插件随 volatile 设置变化的
 * 那段 system prompt 冻结下来，变更改为尾部投递一次。
 *
 * ## 为什么需要它
 *
 * `@deepseek-ai/dsh-timeline` 用 `systemPrompt.section()` 注册 `timeline:planning`
 * 段，而那段正文的来源里包含**会话中途会变的值**：
 *
 * - `taskLanguageInstruction(config.language, config.uiLanguage)` —— 显示语言由
 *   Host 读 `settings` 的 locale 偏好，并且会被**任意已认证浏览器**通过 RPC
 *   `timeline/locale` 改写（timeline 的 `index.ts` 把 `browserLanguage` 记下来后
 *   交给 `liveConfig` 的读取器）。同一场对话换个语言的浏览器打开，系统提示就变。
 *
 * 本仓库的 Kimi Code 线路按内容前缀计费，而它**没有**声明
 * `systemPromptUpdate: 'in-history'`（system prompt 只能作为请求头送出）。因此
 * `SystemPromptProjection` 一旦看到渲染文本变化，走的就是 `replace` 节点 0——
 * 整段前缀作废，一次全价重建。参见 `packages/core/agent-loop/src/runtime-context.ts`。
 *
 * `timeline_tasks` 的工具描述同理：timeline 用 `Object.defineProperty` 把
 * `config.taskPrompt` 挂在 description 的 getter 上，改一次写作提示词就等于改工具
 * 表，`tools` 数组随之变化。这条线路虽然有 `toolUpdate: 'in-history'`，但那个模式
 * 只覆盖工具的**增删**，不覆盖既有工具的描述改写。
 *
 * ## 三条动作（与 `team-policy-cache-guard` / `plan-mode-cache-guard` 同一套）
 *
 * 1. `system-prompt/assemble` 瀑布：把首次出现的 `timeline:planning` 正文按 scope
 *    记下来，之后一律返回这份冻结副本。system 段从此逐字节恒定。
 * 2. 冻结值与当次装配到的正文不一致时，记一份「待投递」；下一步 `agent/pre-step`
 *    把它作为**尾部用户消息**投一次。末尾追加不改变已发前缀，指引没有丢，只是从
 *    最前面的 system 段搬到了末尾。
 * 3. `tools.definitions` 包装：把 `timeline_tasks` 的定义替换成首次见到的那份描述，
 *    工具表不随写作提示词变化。
 *
 * ## 冻结的是「首次见到的那一份」，不是抄来的副本
 *
 * 投递的正文永远是装配时从官方段里捕获到的原文，本包不落任何 timeline 的文案副
 * 本。harness 改措辞不会让这里过期。代价是它依赖段名 `timeline:planning`：启用后
 * 若从未观察到该段（没装 timeline、或 timeline 改了段名），守卫记一条 warn 点名，
 * 而不是安静地什么都不做。
 *
 * ## 默认开启，且只对按前缀计费的线路生效
 *
 * 与会话状态无关的纯旁路：不增加任何工具声明面，只在真正出现该段时才动手。开关由
 * `timelineCacheGuard` 控制，每次装配/每步重读活引用。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/timeline-cache-guard
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KIMI_CODE_PROVIDER, MINIMAX_CODE_PROVIDER, readScopeProvider } from './ptc-sdk-cache-guard.ts'

/** Timeline 的规划指引段名。 */
export const TIMELINE_SECTION = 'timeline:planning'

/** Timeline 的任务更新工具名；它的描述随 `taskPrompt` 变。 */
export const TIMELINE_TASK_TOOL = 'timeline_tasks'

/**
 * 默认受保护的 provider 名单。
 *
 * `kimi-code` 与 `minimax-code` 都按前缀缓存计费，而且都没有声明
 * `systemPromptUpdate: 'in-history'`：系统段一改就是整段重建。
 */
export const DEFAULT_TIMELINE_CACHE_PROVIDERS: readonly string[] = Object.freeze([
  KIMI_CODE_PROVIDER,
  MINIMAX_CODE_PROVIDER,
])

/** 尾部通知的来源 kind（本包自有）。 */
export const TIMELINE_NOTICE_SOURCE_KIND = 'timeline-cache-notice'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包在 agent/pre-step 末尾追加的 Timeline 规划指引更新（不是新的用户回合）。 */
    'timeline-cache-notice': { kind: 'timeline-cache-notice' } & { form?: 'notice', summary?: string }
  }
}

/** 守卫交回的句柄。 */
export interface TimelineCacheGuard {
  /** 摘掉本守卫挂上的全部东西（幂等）。 */
  dispose(): void
}

/** 守卫选项。 */
export interface TimelineCacheGuardOptions {
  /** 是否启用；每次装配与每步都重读，所以设置保存后下一步就生效。默认开启。 */
  readonly enabled?: () => boolean
  /** 命中即冻结的 provider 名单；省略时用 {@link DEFAULT_TIMELINE_CACHE_PROVIDERS}。 */
  readonly providers?: readonly string[]
}

/**
 * 从插件配置里读开关。
 * @param config - 插件配置（结构化：只读一个键）。
 * @returns 是否启用本守卫；未声明时按开启处理（宿主 schema 的默认值）。
 */
export function resolveTimelineCacheGuardEnabled(
  config: { timelineCacheGuard?: unknown } | undefined,
): boolean {
  return config?.timelineCacheGuard !== false
}

/** 一个 scope 的冻结状态。 */
interface GuardState {
  /** 首次装配到的正文；之后一律回放这一份。 */
  frozen: string
  /** 冻结之后出现过的、还没投递的新正文。 */
  pending: string | undefined
}

/** 装配期见过 `timeline:planning` 段没有（用来判断守卫是不是在空转）。 */
interface GuardStats {
  /** 是否至少见过一次该段。 */
  seen: boolean
  /** 是否已经为「从没见过」报过警。 */
  warned: boolean
  /** 是否已经为「没有工具层」报过警。 */
  warnedTools: boolean
}

/** 事件订阅面。 */
interface EventHostLike {
  on?(name: string, listener: (...args: never[]) => unknown): (() => void) | undefined
}

/** 日志面。 */
interface LoggerLike {
  warn(message: string, ...rest: unknown[]): void
}

/** 系统段（只读名字与正文）。 */
interface AssembledSectionLike {
  /** 段名。 */
  name?: unknown
  /** 段正文。 */
  text?: unknown
}

/** 一次装配的呈现面。 */
interface PresentationLike {
  /** 已解析的段。 */
  sections?: AssembledSectionLike[]
}

/** 装配上下文里本守卫会读的部分。 */
interface AssembleContextLike {
  /** 本次装配的 scope（会话装配时就是 agent）。 */
  scope?: unknown
  /** 装配发起方 agent（部分宿主直接给 agent）。 */
  agent?: unknown
}

/** 一条 pre-step 决策。 */
interface PreStepDecisionLike {
  /** enter / reject。 */
  kind?: string
  /** 本步输入消息。 */
  messages?: unknown[]
}

/** pre-step 载荷。 */
interface PreStepPayloadLike {
  /** 本步 agent。 */
  agent?: unknown
  /** 取消信号。 */
  signal?: { aborted?: boolean }
}

/** 被包装的 `definitions` 原签名。 */
type DefinitionsMethod = (this: unknown, scope?: unknown, toolSet?: unknown) => readonly unknown[]

/** 工具定义（只读描述）。 */
interface ToolDefinitionLike {
  /** 工具名。 */
  name?: unknown
  /** 工具描述（timeline 用 getter 实现，所以必须自己先读一次再替换）。 */
  description?: unknown
}

/** 没有 scope 的装配（会话标题之类）用的桶键。 */
const GLOBAL_KEY = Object.freeze({})

/**
 * 桶键：agent 对象本身，或全局桶。
 * @param value - scope / agent。
 * @returns WeakMap 键。
 */
function bucketOf(value: unknown): object {
  return typeof value === 'object' && value !== null ? value as object : GLOBAL_KEY
}

/**
 * 订阅一个事件。
 * @param ctx - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 监听器。
 * @returns 解绑函数或 undefined。
 */
function subscribe(
  ctx: unknown,
  event: string,
  listener: (...args: never[]) => unknown,
): (() => void) | undefined {
  const on = (ctx as EventHostLike | undefined)?.on
  if (typeof on !== 'function') return undefined
  try {
    return on.call(ctx, event, listener)
  } catch {
    return undefined
  }
}

/**
 * 记一条警告。
 * @param ctx - 宿主上下文。
 * @param message - 正文。
 */
function logWarn(ctx: unknown, message: string): void {
  try {
    (ctx as { logger?: LoggerLike } | undefined)?.logger?.warn(message)
  } catch {
    // 日志失败不影响守卫。
  }
}

/**
 * 造一条尾部通知消息。
 * @param text - 正文。
 * @param summary - 卡片上显示的一句摘要。
 * @returns 用户角色的通知消息。
 */
function createNotice(text: string, summary: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: TIMELINE_NOTICE_SOURCE_KIND, form: 'notice', summary },
  })
}

/**
 * 新正文的尾部投递正文。
 *
 * 完整重放一遍段文本，而不是只投一条「语言变了」：模型需要的是新的写作要求本身，
 * 而它已经在**旧**要求下工作了很久，只说一句「变了」等于让它自己猜变了什么。
 * @param text - 冻结之后出现的新段文本。
 * @returns 通知正文。
 */
export function timelineGuidanceUpdateText(text: string): string {
  return 'Timeline planning guidance was updated. It replaces any earlier Timeline planning instruction '
    + 'you were given; follow this version from now on.\n\n' + text
}

/**
 * 装一台「Timeline 规划段前缀缓存守卫」。
 *
 * 幂等性留给调用方：同一个 ctx 装两次会得到两条监听器，宿主入口应当只装一次。
 * @param ctx - 宿主上下文（结构化：老代 ctx 也认）。
 * @param options - 开关与线路名单。
 * @returns 句柄，dispose 摘掉全部挂载。
 */
export function installTimelineCacheGuard(
  ctx: unknown,
  options: TimelineCacheGuardOptions = {},
): TimelineCacheGuard {
  const providers = new Set<string>(options.providers ?? DEFAULT_TIMELINE_CACHE_PROVIDERS)
  const states = new WeakMap<object, GuardState>()
  const stats: GuardStats = { seen: false, warned: false, warnedTools: false }
  const restores: (() => void)[] = []
  const alreadyWrapped = new WeakSet<object>()
  const patchedMethods = new WeakMap<object, Set<string>>()
  let disposed = false

  // 缺省即开启：调用方只传线路名单时，守卫仍然工作；只有显式给出读取器且返回 false
  // 才关闭。读取器抛错按关闭处理——一个坏掉的设置读取不该在每步装配里反复抛。
  const enabled = (): boolean => {
    const read = options.enabled
    if (read === undefined) return true
    try {
      return read() === true
    } catch {
      return false
    }
  }

  const stateOf = (key: object): GuardState => {
    let state = states.get(key)
    if (state === undefined) {
      state = { frozen: '', pending: undefined }
      states.set(key, state)
    }
    return state
  }

  // ── 1. 冻结 timeline:planning ─────────────────────────────────────────────
  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    if (disposed || !enabled()) return result
    const scope = context?.scope ?? context?.agent
    const provider = readScopeProvider(scope)
    if (provider === undefined || !providers.has(provider)) return result
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    const index = sections.findIndex(section => section?.name === TIMELINE_SECTION)
    if (index < 0) {
      // 启用却一直没见过这个段：说明 timeline 没装，或它改了段名，本守卫在空转。
      if (!stats.seen && !stats.warned) {
        stats.warned = true
        logWarn(
          ctx,
          '[dsh-chatgpt-subscription] timeline cache guard is enabled but no "'
          + TIMELINE_SECTION + '" section has appeared; the guard is inert on this deployment',
        )
      }
      return result
    }
    stats.seen = true
    const current = sections[index]
    const text = typeof current?.text === 'string' ? current.text : ''
    if (text === '') return result
    const state = stateOf(bucketOf(scope))
    if (state.frozen === '') {
      // 首次见到：这一份就是本会话的基线，原样放行。
      state.frozen = text
      state.pending = undefined
      return result
    }
    if (text !== state.frozen) {
      // 变了：记下待投递的新正文，但**继续回放冻结副本**，系统段逐字节恒定。
      state.pending = text
    }
    if (text === state.frozen) return result
    const frozenSections = sections.map((section, position) =>
      position === index ? { ...section, text: state.frozen } : section)
    return { ...result, sections: frozenSections }
  }

  // ── 2. 一次变更投一次尾部消息 ─────────────────────────────────────────────
  const onPreStep = async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike | undefined>,
  ): Promise<PreStepDecisionLike | undefined> => {
    const decision = await next()
    if (disposed || decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision
    if (!enabled()) return decision
    const state = states.get(bucketOf(payload?.agent))
    const text = state?.pending
    if (state === undefined || text === undefined) return decision
    state.pending = undefined
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    return {
      ...decision,
      messages: [...messages, createNotice(timelineGuidanceUpdateText(text), 'Timeline guidance updated')],
    }
  }

  // ── 3. 冻结 timeline_tasks 的描述 ─────────────────────────────────────────
  /**
   * 冻结下来的工具描述，**按装配 scope 分桶**。
   *
   * 只记「每个 scope 第一次见到的那个值」：timeline 的 description 是 getter，每次
   * 读都反映当时的 `taskPrompt`，所以比较基准必须是字符串快照，不能是函数引用。
   *
   * 按 scope 而不是按进程：同一个宿主可以同时跑两个部署（npm 拷贝与仓库 link），
   * 两者的 taskPrompt 合法地不同；进程级单例会让后一个部署拿到前一个的文案，
   * 表现成「换了提示词却没生效」而不是任何可诊断的错误。
   */
  const frozenToolDescriptions = new WeakMap<object, Map<string, string>>()

  /** 取一个 scope 的描述快照表，按需创建。 */
  const descriptionsOf = (scope: unknown): Map<string, string> => {
    const bucket = bucketOf(scope)
    let table = frozenToolDescriptions.get(bucket)
    if (table === undefined) {
      table = new Map<string, string>()
      frozenToolDescriptions.set(bucket, table)
    }
    return table
  }

  const freezeDefinitions = (scope: unknown, list: readonly unknown[]): readonly unknown[] => {
    const table = descriptionsOf(scope)
    let changed = false
    const frozen = list.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry
      const definition = entry as ToolDefinitionLike
      if (definition.name !== TIMELINE_TASK_TOOL) return entry
      // getter 在这里被求值一次；之后只用快照比较，不再重复读。
      const description = definition.description
      if (typeof description !== 'string') return entry
      const seen = table.get(TIMELINE_TASK_TOOL)
      if (seen === undefined) {
        table.set(TIMELINE_TASK_TOOL, description)
        return entry
      }
      if (seen === description) return entry
      changed = true
      // 换成一份新对象，绝不就地改注册表里的定义。
      return { ...(entry as Record<string, unknown>), description: seen }
    })
    return changed ? frozen : list
  }

  /**
   * 方法的真实宿主：Cordis 的 `Service` 代理读属性时会把方法**绑定到读取它的那一层
   * 作用域**，所以 `const original = tools.definitions` 拿到的是已经绑好的函数，
   * 再 `original.call(tools, …)` 会把根作用域塞回每一个子作用域。真正要包的是原型上
   * 那份未绑定的实现（与 `ptc-sdk-cache-guard.ts` 同一套处理）。
   * @param service - 候选服务实例。
   * @returns 目标；方法不存在时 undefined。
   */
  const resolveMethodTarget = (
    service: unknown,
  ): { holder: object; name: string; original: DefinitionsMethod; descriptor?: PropertyDescriptor } | undefined => {
    if (typeof service !== 'object' || service === null) return undefined
    const own = service as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(own, 'definitions')) {
      const original = own['definitions']
      if (typeof original !== 'function') return undefined
      return {
        holder: own,
        name: 'definitions',
        original: original as DefinitionsMethod,
        descriptor: Object.getOwnPropertyDescriptor(own, 'definitions'),
      }
    }
    const proto = Object.getPrototypeOf(service) as object | null
    if (proto === null || proto === (Object.prototype as object) || proto === (Function.prototype as object)) {
      return undefined
    }
    const original = (proto as Record<string, unknown>)['definitions']
    if (typeof original !== 'function') return undefined
    return {
      holder: proto,
      name: 'definitions',
      original: original as DefinitionsMethod,
      descriptor: Object.getOwnPropertyDescriptor(proto, 'definitions'),
    }
  }

  const wrapToolsService = (tools: unknown): boolean => {
    if (disposed || typeof tools !== 'object' || tools === null) return false
    if (alreadyWrapped.has(tools)) return false
    const target = resolveMethodTarget(tools)
    if (target === undefined) {
      if (!stats.warnedTools) {
        stats.warnedTools = true
        logWarn(
          ctx,
          '[dsh-chatgpt-subscription] timeline cache guard cannot freeze the task tool description: '
          + 'this tool registry exposes no definitions()',
        )
      }
      return false
    }
    const patchedIn = patchedMethods.get(target.holder)
    if (patchedIn?.has(target.name) === true) {
      alreadyWrapped.add(tools)
      return false
    }
    const original = target.original
    const replacement = function (this: unknown, scope?: unknown, toolSet?: unknown): readonly unknown[] {
      // receiver 用**调用方**的 this：服务里的 this.ctx 留在调用方那一层作用域。
      const receiver = this ?? tools
      const list = original.call(receiver, scope, toolSet)
      if (!Array.isArray(list) || disposed || !enabled()) return list
      const provider = readScopeProvider(scope)
      if (provider === undefined || !providers.has(provider)) return list
      return freezeDefinitions(scope, list)
    }
    try {
      Object.defineProperty(target.holder, target.name, {
        value: replacement,
        configurable: true,
        writable: true,
        enumerable: target.descriptor?.enumerable ?? false,
      })
    } catch {
      return false
    }
    const names = patchedMethods.get(target.holder) ?? new Set<string>()
    names.add(target.name)
    patchedMethods.set(target.holder, names)
    alreadyWrapped.add(tools)
    restores.push(() => {
      try {
        if (target.descriptor === undefined) Reflect.deleteProperty(target.holder, target.name)
        else Object.defineProperty(target.holder, target.name, target.descriptor)
      } catch {
        // 卸载期的单点失败不影响其余卸载。
      }
    })
    return true
  }

  const wrapServiceFrom = (target: unknown): boolean => {
    if (typeof target !== 'object' || target === null) return false
    const get = (target as { get?: unknown }).get
    if (typeof get !== 'function') return false
    try {
      return wrapToolsService(get.call(target, 'tools'))
    } catch {
      return false
    }
  }

  wrapServiceFrom(ctx)
  // 工具服务可能在本守卫挂载之后才出现（Cordis 的注入面）：等它来。
  const inject = (ctx as { inject?: unknown } | undefined)?.inject
  if (typeof inject === 'function') {
    try {
      ;(inject as (services: string[], callback: (scope: unknown) => void) => unknown).call(
        ctx,
        ['tools'],
        (scope: unknown) => {
          if (disposed) return
          wrapServiceFrom(scope)
        },
      )
    } catch {
      // 没有注入面：只能靠上面那次直接探测。
    }
  }

  const offAssemble = subscribe(ctx, 'system-prompt/assemble', onAssemble as unknown as (...args: never[]) => unknown)
  const offPreStep = subscribe(ctx, 'agent/pre-step', onPreStep as unknown as (...args: never[]) => unknown)
  if (offAssemble !== undefined) restores.push(() => { offAssemble() })
  if (offPreStep !== undefined) restores.push(() => { offPreStep() })

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const restore of restores.splice(0)) {
        try {
          restore()
        } catch {
          // 卸载期的单点失败不影响其余卸载。
        }
      }
    },
  }
}

export default installTimelineCacheGuard