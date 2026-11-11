/**
 * 「调度执行守卫」——在**执行期**拦住两类越界调用，并把主控自己提问时的畸形
 * 载荷挡在弹窗之前。
 *
 * ## 为什么需要它
 *
 * 调度模式（dispatch preset）里主控与子代理跑在同一进程、同一套工具注册面上，
 * 于是有三件事会悄悄坏掉：
 *
 * 1. **子代理越权调用主控专用工具**。`ask_user_question`、`exit_plan_mode`、
 *    `create_goal` 这些是**主控的**决定口：让子代理自己问用户、自己进/出计划模式、
 *    自己建目标，都会把「一个决定」拆成两个决定——子代理问完，用户答了，主控却
 *    不知道问过什么。子代理本来就该把未决问题**带回**主控，而不是自己去问。
 * 2. **等待子代理期间空等**。子代理还在跑的时候，主控用 `sleep` 空转，既烧 token
 *    又错过通知到达的那一刻。正确做法是**结束这一轮**，让内置的子代理完成通知把
 *    它叫醒（R-W）。
 * 3. **主控自己的提问载荷畸形**。模型会把一次「给候选方案」写成同一道题问三遍、
 *    把选项整段 JSON 糊进键名（`"options [{"`）、把 `id` 写成 `":"` 或空串——
 *    用户在弹窗里点完，回答却对不回任何问题。这种载荷必须在**弹窗之前**就退回给
 *    模型，让它下一轮自己改对（见 {@link validateAskUserQuestionArgs}）。
 *
 * ## 零 Kimi Code 缓存漂移
 *
 * 守卫**只**用 `ctx.tools.guard(exec => …)` 这一条执行期接缝：
 *
 * - 不包 `tools.definitions`，不包 `tools.register`，不听
 *   `system-prompt/assemble`——工具声明面（`tools:sdk` 段与顶层工具 schema）
 *   保持逐字节恒定，Kimi Code 的前缀缓存不会因为这个守卫重建一次。
 * - 拦截发生在**调用执行时**，模型看到的工具表完全没变，所以「看得见」与
 *   「叫得动」仍然被拆开：工具照常出现在表里，只是越界的调用被拒。
 *
 * ## 判定从哪来
 *
 * 两条判定都走**结构探测**，不 import 任何 harness 代次专属的类型：
 *
 * - 「你是不是子代理」：先看**持久会话血缘**（`session.header.origin ===
 *   'subagent'`），再看宿主活着的**存活根**（`agents.roots()`）。两条都是
 *   读得着的既有事实，不新增任何状态。
 * - 「你还有没有在跑的子代理」：依次问 `subagents.list` 与 `agents.list`，
 *   看有没有 `status === 'running'` 的直接子代。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/dispatch-execution-guard
 */

/**
 * 子代理**不得**直接调用的主控专用工具。
 *
 * 这七个都是「决定口」或「交付口」，不是「干活口」：
 *
 * - `ask_user_question` / `exit_plan_mode` / `enter_plan_mode` /
 *   `leave_plan_mode`：计划与提问的决定权在主控；
 * - `create_goal` / `update_goal`：目标由主控持有；
 * - `present`：交付口由主控掌握。
 *
 * 子代理遇到需要决定的地方，正确动作是**把问题带回主控**，让主控去调这些工具。
 */
export const DEFAULT_DELEGATED_BLOCKED_TOOLS = Object.freeze([
  'ask_user_question',
  'exit_plan_mode',
  'enter_plan_mode',
  'leave_plan_mode',
  'create_goal',
  'update_goal',
  'present',
] as const)

/**
 * 承载「等待」语义的 shell 工具。
 *
 * 这三个是本包与宿主都会用到的 shell 入口：它们的 `command` 参数里可能藏着
 * `sleep`。空等只在**确实有在跑的子代理**时才是问题（有子代理时应当结束这一
 * 轮等通知），没有子代理时 `sleep 1` 只是普通命令，不该拦。
 */
export const DEFAULT_SHELL_TOOLS = Object.freeze([
  'bash',
  'pwsh',
  'win_bash',
] as const)

/** 守卫选项。 */
export interface DispatchExecutionGuardOptions {
  /**
   * 当前是否启用拦截。**每次执行都重读**，所以设置保存后下一步就生效，
   * 不需要重挂任何一行。
   */
  readonly enabled?: () => boolean
  /**
   * 「这个调用方还有没有在跑的子代理」的**直接注入口**。
   *
   * 宿主探测（`subagents.list` / `agents.list`）在测试里不好复现，而这条
   * 判定决定了一条 sleep 命令会不会被拒——它必须能被单独测。给了这个回调就以
   * 它为准，不再走宿主探测。
   */
  readonly hasRunningChildren?: (agent: unknown) => boolean
}

/** 一次工具执行（只取守卫要读的三样东西）。 */
interface GuardExecution {
  /** 工具名。 */
  readonly name?: unknown
  /** 调用方 agent。 */
  readonly agent?: unknown
  /** 已解析的参数。 */
  readonly arguments?: unknown
}

/** 守卫注册面（只要 `guard` 这一条接缝）。 */
interface ToolsGuardLike {
  /** 注册一条单调拒绝守卫；返回注销器。 */
  guard?: (guard: (execution: GuardExecution) => string | undefined) => (() => void) | undefined
}

/** 一次执行里被判定为「纯等待」的命令形态。 */
const SLEEP_COMMAND_PATTERN = /^(?:sleep\s+\d+(?:\.\d+)?[smhd]?|Start-Sleep\s+(?:-(?:Seconds|Milliseconds|s|m)\s+)?\d+(?:\.\d+)?|timeout(?:\.exe)?\s+(?:\/t\s+)?\d+(?:\s+\/nobreak)?|ping(?:\.exe)?\s+-(?:n|c)\s+\d+\s+(?:127\.0\.0\.1|localhost)(?:\s+>|\s*$).*)$/i

/** 无害的空转语句（回显、真、冒号）。 */
const NOOP_COMMAND_PATTERN = /^(?:echo\b.*|Write-Host\b.*|Write-Output\b.*|true|:)$/

/** 注释行。 */
const COMMENT_COMMAND_PATTERN = /^#/

/**
 * 读宿主上下文上「直接注入」的 running-child 判定回调。
 *
 * 这一步必须**try/catch**：真实 Cordis 的上下文代理对任何没有 inject 的属性直读
 * 都当场抛 `cannot get property "..." without inject`，一次读失败不该让守卫在
 * 每次工具调用上抛错。
 *
 * @param ctx - 宿主上下文。
 * @returns 注入的回调；没有时为 undefined。
 */
function injectedHasRunningChildren(ctx: unknown): ((agent: unknown) => boolean) | undefined {
  if (!isRecord(ctx)) return undefined
  let injected: unknown
  try {
    injected = ctx['hasRunningChildren']
  } catch {
    return undefined
  }
  return typeof injected === 'function'
    ? injected as (agent: unknown) => boolean
    : undefined
}

/**
 * 判断一个值是不是可读的记录对象。
 *
 * @param value - 候选值。
 * @returns 是记录对象时为 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从宿主上下文里读一个**可选**服务。
 *
 * 一律走 `ctx.get()`：没写进 `inject` 的服务名不能当属性读，真实 Cordis 会当场
 * 抛 `cannot get property "..." without inject`，整个插件降级。读不到就是读不到，
 * 守卫据此放行，绝不因此让插件挂不上。
 *
 * @param ctx - 宿主上下文。
 * @param name - 服务名。
 * @returns 服务实例；不存在或读取抛错时为 undefined。
 */
function readService(ctx: unknown, name: string): unknown {
  const reader = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof reader !== 'function') return undefined
  try {
    return reader.call(ctx, name)
  } catch {
    return undefined
  }
}

/**
 * 读一个宿主上下文里的工具注册面。
 *
 * @param ctx - 宿主上下文。
 * @returns 带 `guard` 接缝的注册面；没有时为 undefined。
 */
function toolsOf(ctx: unknown): ToolsGuardLike | undefined {
  if (!isRecord(ctx)) return undefined
  let tools: unknown
  try {
    tools = ctx['tools']
  } catch {
    // 这一代上下文没有 inject 这一项：属性直读会当场抛，转走 get()。
    tools = undefined
  }
  if (!isRecord(tools)) tools = readService(ctx, 'tools')
  return isRecord(tools) ? tools as ToolsGuardLike : undefined
}

/**
 * 读一条记录的 `id`。
 *
 * @param value - 候选记录。
 * @returns id 字符串；没有时为 undefined。
 */
function idOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  return typeof id === 'string' ? id : undefined
}

/**
 * 读一条会话记录头里的 `id`。
 *
 * @param agent - 候选 agent。
 * @returns 会话 id；没有时为 undefined。
 */
function sessionIdOf(agent: unknown): string | undefined {
  if (!isRecord(agent)) return undefined
  const session = agent['session']
  if (!isRecord(session)) return undefined
  const header = session['header']
  return idOf(header)
}

/**
 * 这个调用方是不是**子代理**。
 *
 * 判定分两级，先看能独立成立的持久事实，再看宿主当前活着的存活根：
 *
 * 1. **持久会话血缘**：`session.header.origin === 'subagent'`。这是子代理会话
 *    创建时就写下的血缘，跨宿主代次都在，不依赖任何服务是否挂载。
 * 2. **存活根判定**：宿主提供 `agents.roots()` 时，一个**不在**存活根集合里的
 *    agent 就是别人的孩子。先核对**存活**（`agents.get(id) === agent`）：不是
 *    那个 id 当前登记的存活 agent，说明这个调用方已经过期或已被顶替——判它是不是
 *    子代理没有意义，放行。
 *
 * 宿主没有 `agents` 服务（或老代没有 `roots`）时，判不了就**放行**：把一个
 * 读不出来的身份当成子代理去拦，会拦掉主控自己的正常调用。
 *
 * @param agent - 调用方 agent。
 * @param ctx - 宿主上下文（可选；用于读 `agents` 服务）。
 * @returns 是子代理时为 true。
 */
export function isDelegatedCaller(agent: unknown, ctx?: unknown): boolean {
  if (!isRecord(agent)) return false

  // 第一级：持久会话血缘。
  const session = agent['session']
  if (isRecord(session)) {
    const header = session['header']
    if (isRecord(header) && header['origin'] === 'subagent') return true
  }

  // 先核对是否为当前登记的存活 agent：已过期或被顶替的对象不按子代理拦。
  const agents = readService(ctx, 'agents')
  if (isRecord(agents)) {
    const id = idOf(agent)
    if (typeof id === 'string' && typeof agents['get'] === 'function') {
      let live: unknown
      try {
        live = (agents['get'] as (id: string) => unknown).call(agents, id)
      } catch {
        live = undefined
      }
      if (live !== agent) return false
    }
  }

  // 第二级（0.2.2-rc.2+）：subagents.rootOf(agent) 树根归属判定。
  const subagents = readService(ctx, 'subagents')
  if (isRecord(subagents) && typeof subagents['rootOf'] === 'function') {
    try {
      const root = (subagents['rootOf'] as (caller: unknown) => unknown).call(subagents, agent)
      if (root !== undefined && root !== agent) return true
    } catch (error: unknown) {
      if (isRecord(error) && error['code'] === 'UNAUTHORIZED') return true
    }
  }

  // 第三级（0.2.0 ~ 0.2.2-rc.1）：宿主存活根集合。
  if (!isRecord(agents)) return false
  const roots = rootsOf(agents)
  if (roots === undefined) return false
  return !roots.includes(agent)
}

/**
 * 读宿主存活根集合。
 *
 * @param agents - `agents` 服务。
 * @returns 存活根数组；服务没有 `roots` 或读取抛错时为 undefined。
 */
function rootsOf(agents: Record<string, unknown>): unknown[] | undefined {
  const roots = agents['roots']
  if (typeof roots !== 'function') return undefined
  try {
    const listed = (roots as () => unknown).call(agents)
    return Array.isArray(listed) ? listed : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断一条命令是不是**纯等待**。
 *
 * 判据：整条命令**按分隔符切开后**，至少有一条是 sleep/wait，而**每一条**都是
 * sleep/wait 或者无害的空转（回显、真、冒号、注释）。只要有一条在做真事
 * （`sleep 1 && npm test`、`git status`、`node …`），整条命令就不是纯等待——
 * 这类命令**必须放行**，否则守卫会拦掉正当的后台工作。
 *
 * @param command - 候选命令。
 * @returns 是纯等待时为 true。
 */
export function isPureSleepCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  const statements = trimmed
    .split(/;|&&|\n/)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0)
  if (statements.length === 0) return false
  let sawWait = false
  for (const statement of statements) {
    if (SLEEP_COMMAND_PATTERN.test(statement)) {
      sawWait = true
      continue
    }
    if (!isNoopStatement(statement)) return false
  }
  return sawWait
}

/**
 * 判断一条语句是不是无害的空转。
 *
 * @param statement - 候选语句。
 * @returns 是空转时为 true。
 */
function isNoopStatement(statement: string): boolean {
  return NOOP_COMMAND_PATTERN.test(statement) || COMMENT_COMMAND_PATTERN.test(statement)
}

/**
 * 这个调用方当前**还有没有在跑的子代理**。
 *
 * 两条宿主探测，任何一条给出答案就算数：
 *
 * 1. `subagents.list(agent, 'children')`（老代退化成 `subagents.list(agent)`）：
 *    直接子代里有没有 `status === 'running'` 的。
 * 2. `agents.list()`：活着且 `status === 'running'`、并且 `parent` 就是这个
 *    调用方的那些 agent。
 *
 * 宿主提供 `hasRunningChildren` 回调时以它为准（直接注入口，见
 * {@link DispatchExecutionGuardOptions.hasRunningChildren}）。
 *
 * @param agent - 调用方 agent。
 * @param ctx - 宿主上下文（可选；用于读 `subagents` / `agents` 服务）。
 * @returns 有在跑的子代理时为 true。
 */
export function hasRunningChildSubagent(agent: unknown, ctx?: unknown): boolean {
  if (!isRecord(agent)) return false

  const injected = injectedHasRunningChildren(ctx)
  if (injected !== undefined) {
    try {
      return injected(agent) === true
    } catch {
      return false
    }
  }

  const subagents = readService(ctx, 'subagents')
  if (isRecord(subagents) && typeof subagents['list'] === 'function') {
    const listed = callList(subagents['list'], subagents, agent)
    if (entriesOf(listed).some(entry => entry['status'] === 'running')) return true
  }

  const agents = readService(ctx, 'agents')
  if (isRecord(agents) && typeof agents['list'] === 'function') {
    const listed = callList(agents['list'], agents, agent, false)
    const parentIds = new Set<string>()
    const ownId = idOf(agent)
    if (ownId !== undefined) parentIds.add(ownId)
    const headerId = sessionIdOf(agent)
    if (headerId !== undefined) parentIds.add(headerId)
    const rootOfFn = isRecord(subagents) && typeof subagents['rootOf'] === 'function'
      ? (subagents['rootOf'] as (caller: unknown) => unknown)
      : undefined
    const isOwnedByFn = typeof agents['isOwnedBy'] === 'function'
      ? (agents['isOwnedBy'] as (id: string, owner: unknown) => unknown)
      : undefined
    const running = entriesOf(listed).some((entry) => {
      if (entry === agent || entry['status'] !== 'running') return false
      if (typeof entry['parent'] === 'string' && parentIds.has(entry['parent'])) return true
      const session = entry['session']
      const header = isRecord(session) ? session['header'] : undefined
      if (isRecord(header)
        && typeof header['parentSession'] === 'string'
        && parentIds.has(header['parentSession'])
        && (header['origin'] === 'subagent' || header['isSeeded'] !== true)) {
        return true
      }
      if (rootOfFn !== undefined) {
        try {
          if (rootOfFn.call(subagents, entry) === agent) return true
        } catch {
          // 候选者不在同一棵子代理树或无活动根时忽略。
        }
      }
      if (isOwnedByFn !== undefined) {
        const entryId = idOf(entry)
        if (entryId !== undefined) {
          try {
            if (isOwnedByFn.call(agents, entryId, agent) === true) return true
          } catch {
            // 老代归属查询失败时忽略。
          }
        }
      }
      return false
    })
    if (running) return true
  }

  return false
}

/**
 * 调用一个「列出子代」的宿主方法。
 *
 * 先试带 scope 的形态（`list(agent, 'children')`），老代只认 `list(agent)`，
 * 再老一代的 `agents.list()` 不接参数——三种都试，谁先成功用谁。
 *
 * @param fn - 宿主方法。
 * @param self - 调用宿主。
 * @param agent - 调用方 agent。
 * @param scoped - 是否先试带 scope 的形态。
 * @returns 宿主返回值；全部失败时为 undefined。
 */
function callList(
  fn: unknown,
  self: unknown,
  agent: unknown,
  scoped = true,
): unknown {
  if (typeof fn !== 'function') return undefined
  const call = fn as (...args: unknown[]) => unknown
  const attempts: unknown[][] = scoped
    ? [[agent, 'children'], [agent], []]
    : [[], [agent], [agent, 'children']]
  for (const args of attempts) {
    try {
      const listed = call.apply(self, args)
      // 宿主可能忽略多余参数并返回全量；返回 undefined 说明这个形态不被认。
      if (listed !== undefined) return listed
    } catch {
      // 老代不认这个形态，退回下一个。
    }
  }
  return undefined
}

/**
 * 从宿主返回值里取出「条目数组」。
 *
 * 宿主可能直接给数组，也可能给一个包着数组的记录（`children` / `agents`）。
 *
 * @param listed - 宿主返回值。
 * @returns 条目数组；取不到时是空数组。
 */
function entriesOf(listed: unknown): Record<string, unknown>[] {
  // 宿主直接给数组：数组里的一条就是一条条目。
  if (Array.isArray(listed)) {
    return listed.filter(isRecord)
  }
  // 宿主给的是一个包着数组的记录：挑出里面的数组。
  if (!isRecord(listed)) return []
  const entries: Record<string, unknown>[] = []
  for (const key of ['children', 'agents', 'entries', 'list']) {
    const candidate = listed[key]
    if (!Array.isArray(candidate)) continue
    for (const entry of candidate) {
      if (isRecord(entry)) entries.push(entry)
    }
  }
  return entries
}

/**
 * 解析「调度执行守卫」当前是否启用。
 *
 * 沿 volatile 活引用取当前值，所以设置保存后立刻生效。缺省、非法值、读取抛错都
 * 按**开启**处理：守卫是保护，不是功能开关，读失败不该把保护关掉。
 *
 * @param config - 插件配置（活引用或普通值）。
 * @returns 是否启用。
 */
export function resolveDispatchExecutionGuardEnabled(
  config?: { dispatchExecutionGuard?: { get(): boolean | undefined } | boolean },
): boolean {
  const field = config?.dispatchExecutionGuard
  if (field === undefined || field === null) return true
  if (typeof field === 'object' && typeof (field as { get(): boolean | undefined }).get === 'function') {
    try {
      return (field as { get(): boolean | undefined }).get() !== false
    } catch {
      return true
    }
  }
  return field !== false
}

/**
 * 子代理越权调用时的拒绝文案。
 *
 * 文案要**可执行**：光说「不许调」模型只会换个花样再试一次，所以这里写清楚
 * 它该做什么——把未决问题带回主控，并带上报告状态。
 *
 * @param toolName - 被拦下的工具名。
 * @returns 拒绝理由。
 */
function delegatedDenial(toolName: string): string {
  return `DELEGATED_CALLER: "${toolName}" is a dispatch-level tool and a delegated subagent must not call it directly. `
    + 'Report back to the dispatcher instead: include status: "hand_back" or status: "blocked" '
    + 'and the unresolved question or decision in your report, and let the dispatcher act on it.'
}

/**
 * 子代理还在跑时用 sleep 空等的拒绝文案。
 *
 * @returns 拒绝理由。
 */
function activeChildSleepDenial(): string {
  return 'ACTIVE_CHILD_SLEEP_FORBIDDEN: a child subagent is still running, so sleeping to wait for it is not allowed. '
    + 'End your turn now and let the built-in subagent completion notification wake you.'
}

/**
 * 主控可以向用户提问的那一个工具名。
 */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/**
 * 一个问题条目上可以出现的键。
 *
 * 这份清单只用在**修正指引**里：错位键被拦下时把它抄给模型，模型才知道该
 * 把字段放回哪里。清单本身不做白名单校验——宿主往后加字段不该被守卫拦掉。
 */
const ASK_QUESTION_KEYS = Object.freeze([
  'id',
  'question',
  'header',
  'options',
  'multi_select',
  'multiSelect',
  'detail',
  'intent',
  'timeout',
] as const)

/**
 * 合法 `id` 至少要含一个字母或数字（含 CJK）。
 *
 * 光有标点或空白的 id 不是 id：生产里见过 `""`、`":"`、`"---"`，用户看到的
 * 回答回执全变成同一个无名标签，主控也没法把回答对回问题。
 */
const READABLE_ID_PATTERN = /[\p{L}\p{N}]/u

/**
 * 判断一个键名是不是 `options` 系列。
 *
 * 生产里的畸形载荷把 options 整段 JSON 糊进了键名：`"options [{"`、`"options："`
 * 、`"options:"`。它们的共同特征是**去掉首尾空白、转小写后以 `options` 开头**，
 * 所以判据就取这个前缀——`options` 本身也落在其中，调用方另行放过。
 *
 * @param key - 候选键名。
 * @returns 是 options 系列键时为 true。
 */
function isOptionsKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('options')
}

/**
 * 找出问题条目上**本该嵌在 `options` 里**的错位键。
 *
 * 两类错位都见过：
 *
 * - `label` / `description` 直接摊在问题对象上（选项字段漏了一层嵌套）；
 * - 键名本身是 options 的碎片（`"options [{"`、`"options："`），值往往是空串。
 *
 * @param question - 候选问题条目。
 * @returns 第一个错位键名；没有时为 undefined。
 */
function misplacedQuestionKey(question: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(question)) {
    if (key === 'options') continue
    if (key === 'label' || key === 'description') return key
    if (isOptionsKey(key)) return key
  }
  return undefined
}

/**
 * 找出选项条目上的错位键。
 *
 * 一个选项只该有 `label` / `description`；出现 `question` 说明调用方把整道题
 * 又抄进了选项里，出现 `options*` 说明嵌套被摊平过了。
 *
 * @param option - 候选选项条目。
 * @returns 第一个错位键名；没有时为 undefined。
 */
function misplacedOptionKey(option: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(option)) {
    if (key === 'question' || isOptionsKey(key)) return key
  }
  return undefined
}

/**
 * 一段供拒绝文案引用的短摘录。
 *
 * @param value - 原始文本。
 * @param limit - 最多保留多少个字符。
 * @returns 单行摘录。
 */
function excerpt(value: string, limit = 60): string {
  const collapsed = value.trim().replace(/\s+/g, ' ')
  return JSON.stringify(collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed)
}

/**
 * 生成一条「提问载荷畸形」的拒绝文案。
 *
 * @param detail - 具体坏在哪里、该怎么改。
 * @returns 带 `INVALID_USER_QUESTION:` 前缀的拒绝理由。
 */
function invalidAskUserQuestion(detail: string): string {
  return `INVALID_USER_QUESTION: ${detail}`
}

/**
 * 校验主控 `ask_user_question` 的调用载荷。
 *
 * 这是**执行期**的结构校验：工具声明面一个字节不动（前缀缓存零漂移），但畸形
 * 的载荷在真正弹给用户之前就被挡回给模型，让模型下一步就能自己改对。
 *
 * 三类畸形各自能被模型自助修好：
 *
 * 1. **选项嵌套被摊平**——`"options [{"`、`"options："` 这类键名，或者把
 *    `label` / `description` 摊在问题对象上。指引它写成
 *    `{"id": …, "question": …, "options": [{"label": …, "description": …}]}`。
 * 2. **`id` / `question` 退化**——空串、`":"`、`"---"`、纯空白，或者在同一个
 *    批次里重复。重复的问题文本要并成**一道题多个选项**，而不是问两遍。
 * 3. **选项内部坏掉**——不是对象、缺 `label`、同一题里 `label` 重复。
 *
 * **开放题必须继续放行**：`options` 缺省就是一道开放题，`options: []`（适配层
 * 的空数组兜底）同样放行；只有数组里真有条目时才逐条校验。
 *
 * 非对象载荷、缺 `questions`、`questions` 不是数组或为空时一律返回 undefined：
 * 那几种形态归底层工具自己的 schema 与空检查管，守卫不重复判、也不抢它的文案。
 *
 * @param args - 已解析的工具参数。
 * @returns 合法时为 undefined；畸形时是 `INVALID_USER_QUESTION: …` 文案。
 */
export function validateAskUserQuestionArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const questions = args['questions']
  if (!Array.isArray(questions) || questions.length === 0) return undefined

  const seenIds = new Set<string>()
  const seenQuestions = new Set<string>()

  for (let index = 0; index < questions.length; index += 1) {
    const question: unknown = questions[index]
    const at = `questions[${index}]`
    if (!isRecord(question)) {
      return invalidAskUserQuestion(
        `${at} must be a question object. Known question keys: ${ASK_QUESTION_KEYS.join(', ')}.`,
      )
    }

    const misplaced = misplacedQuestionKey(question)
    if (misplaced !== undefined) {
      if (misplaced !== 'options' && misplaced.trim() === 'options') {
        return invalidAskUserQuestion(
          `${at} has an options property whose key contains surrounding whitespace. `
          + 'Do not copy that malformed key or retry with another variant. Rebuild ONE fresh call with the exact, '
          + 'case-sensitive key "options" (no spaces, annotations, or underscores), and nest its choices inside it: '
          + '{"questions":[{"id":"choice","question":"Which choice?","options":[{"label":"A","description":"…"}]}]}. '
          + 'The complete top-level object must contain the questions array.',
        )
      }
      return invalidAskUserQuestion(
        `${at} carries the misplaced key ${JSON.stringify(misplaced)}: option fields collapsed into the `
        + 'question object. Build ONE question object and nest its choices inside it: '
        + '{"id": "palette", "question": "Which palette?", "options": [{"label": "Warm", "description": "…"}]}. '
        + `Known question keys: ${ASK_QUESTION_KEYS.join(', ')}.`,
      )
    }

    const id: unknown = question['id']
    if (typeof id !== 'string' || id.trim().length === 0 || !READABLE_ID_PATTERN.test(id)) {
      return invalidAskUserQuestion(
        `${at} needs "id" to be a non-empty string with at least one letter or digit. `
        + 'A blank string, whitespace, ":" or "---" is not a usable id: the answer is echoed back '
        + 'against that id, so use a stable slug such as "palette-choice".',
      )
    }
    const trimmedId = id.trim()
    if (seenIds.has(trimmedId)) {
      return invalidAskUserQuestion(
        `${at}.id ${JSON.stringify(trimmedId)} is already used by an earlier question in this batch. `
        + 'Every question needs a distinct stable id so each answer maps back to one question.',
      )
    }
    seenIds.add(trimmedId)

    const text: unknown = question['question']
    if (typeof text !== 'string' || text.trim().length === 0) {
      return invalidAskUserQuestion(
        `${at} needs "question" to be a non-empty string with the text the user reads.`,
      )
    }
    const normalizedText = text.trim().replace(/\s+/g, ' ')
    if (seenQuestions.has(normalizedText)) {
      return invalidAskUserQuestion(
        `${at} repeats the question text ${excerpt(text)} already asked earlier in this batch. `
        + 'To offer several candidate choices, put them into ONE question\'s "options" array '
        + 'instead of asking the same question again.',
      )
    }
    seenQuestions.add(normalizedText)

    const options: unknown = question['options']
    // 开放题：缺省 options 与空数组兜底都必须继续放行。
    if (options === undefined) continue
    if (!Array.isArray(options)) {
      return invalidAskUserQuestion(
        `${at}.options must be an array of {"label": "…", "description": "…"} objects. `
        + 'Omit "options" entirely when the question is open-ended.',
      )
    }
    if (options.length === 0) continue

    const seenLabels = new Set<string>()
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option: unknown = options[optionIndex]
      const optionAt = `${at}.options[${optionIndex}]`
      if (!isRecord(option)) {
        return invalidAskUserQuestion(
          `${optionAt} must be an object like {"label": "…", "description": "…"}.`,
        )
      }
      const optionMisplaced = misplacedOptionKey(option)
      if (optionMisplaced !== undefined) {
        return invalidAskUserQuestion(
          `${optionAt} carries the misplaced key ${JSON.stringify(optionMisplaced)}: an option object holds only `
          + `"label" and "description", while "question" and "options" belong to the question object.`,
        )
      }
      const label: unknown = option['label']
      if (typeof label !== 'string' || label.trim().length === 0) {
        return invalidAskUserQuestion(
          `${optionAt} needs a non-empty "label" string: the label is what the user clicks.`,
        )
      }
      const trimmedLabel = label.trim()
      if (seenLabels.has(trimmedLabel)) {
        return invalidAskUserQuestion(
          `${optionAt}.label ${JSON.stringify(trimmedLabel)} repeats inside ${at}. `
          + 'Every option of one question needs a distinct label.',
        )
      }
      seenLabels.add(trimmedLabel)
    }
  }

  return undefined
}

/**
 * 装一台「调度执行守卫」。
 *
 * 只用 `ctx.tools.guard()` 这一条执行期接缝：工具声明面（`tools:sdk` 段与顶层
 * 工具 schema）一个字节都不改，Kimi Code 的前缀缓存不会因为这个守卫重建。
 *
 * @param ctx - 宿主上下文。
 * @param options - 守卫选项。
 * @returns 注销守卫的函数；宿主没有 `guard` 接缝时是一个空操作。
 */
export function installDispatchExecutionGuard(
  ctx: unknown,
  options: DispatchExecutionGuardOptions = {},
): () => void {
  const tools = toolsOf(ctx)
  const register = tools?.guard
  if (typeof register !== 'function') return () => undefined

  const enabled = options.enabled ?? (() => true)
  const delegatedBlocked = new Set<string>(DEFAULT_DELEGATED_BLOCKED_TOOLS)
  const shellTools = new Set<string>(DEFAULT_SHELL_TOOLS)
  const hasRunningChildren = options.hasRunningChildren

  const guard = (execution: GuardExecution): string | undefined => {
    if (!isEnabled(enabled)) return undefined
    const toolName = typeof execution?.name === 'string' ? execution.name : undefined
    if (toolName === undefined) return undefined
    const agent = execution?.agent

    if (delegatedBlocked.has(toolName) && isDelegatedCaller(agent, ctx)) {
      return delegatedDenial(toolName)
    }

    // 主控自己的提问载荷：越权判定之后才校验，子代理始终先拿到 DELEGATED_CALLER。
    if (toolName === ASK_USER_QUESTION_TOOL) {
      const malformed = validateAskUserQuestionArgs(execution?.arguments)
      if (malformed !== undefined) return malformed
    }

    if (shellTools.has(toolName)) {
      const args = isRecord(execution?.arguments) ? execution.arguments : undefined
      const background = args?.['run_in_background'] === true
      if (!background && isPureSleepCommand(args?.['command'])) {
        const running = hasRunningChildren !== undefined
          ? hasRunningChildren(agent) === true
          : hasRunningChildSubagent(agent, ctx)
        if (running) return activeChildSleepDenial()
      }
    }

    return undefined
  }

  const dispose = register.call(tools, guard)
  return typeof dispose === 'function' ? dispose : () => undefined
}

/**
 * 读一次开关。读失败按**开启**处理：保护不该因为一次读失败而失效。
 *
 * @param enabled - 开关读取函数。
 * @returns 是否启用。
 */
function isEnabled(enabled: () => boolean): boolean {
  try {
    return enabled() !== false
  } catch {
    return true
  }
}
