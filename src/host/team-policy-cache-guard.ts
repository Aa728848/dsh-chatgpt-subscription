/**
 * 「Agent Teams 策略段前缀缓存守卫」—— 把内置 `team:policy` 段从 system 里摘掉，
 * 改为切开关时**尾部投递**一次。
 *
 * ## 为什么需要它
 *
 * 内置 `@deepseek-ai/dsh-tool-agent-team` 注册一个段 `team:policy`，正文是
 * `enabled(agent) ? TEAM_POLICY : ''`：团队开关一开，system prompt 里凭空多出整段
 * 指引，从那里起的前缀全部作废。这与计划模式当初那处重建同构，本仓库已经用
 * 「摘段 + 尾部投递」把它压平过（见 `plan-mode-cache-guard.ts`），这里复用同一套
 * 做法，只是触发器从 `enter_plan_mode` 换成客户端远程调用 `agentTeams.setEnabled`
 * ——那一步只往会话里追加 `team/mode` 事件，段正文在**装配时**才翻面，所以守卫只要
 * 盯着装配结果就够，不需要订阅任何 team 服务。
 *
 * ## 三条动作
 *
 * 1. `system-prompt/assemble` 瀑布：把 `team:policy` 段从呈现里摘掉，并记下它的
 *    正文。system 段从此在开关前后逐字节恒定。
 * 2. `agent/pre-step`：把记下的正文作为**尾部用户消息**投一次（每次激活一次）。
 *    末尾追加不改变已发前缀，指引没有丢，只是从最前面的 system 段搬到了末尾。
 * 3. 段正文回到空串 = 本次激活结束：复位投递状态，并在下一步投一条**撤销**通知，
 *    免得历史里那句「这里有一块共享任务板」在关闭后继续误导模型。
 *
 * ## 抓的是官方原文，不是抄的副本
 *
 * 投递的正文永远是装配时从官方段里捕获到的那一份，不落任何本包的副本。harness 改
 * 措辞（它已经改过三次）不会让这里过期。代价是它依赖段名 `team:policy`：启用后
 * 若从未观察到该段，守卫记一条 warn 点名，而不是安静地什么都不做。
 *
 * ## 默认开启
 *
 * 会话中途切开关才会付一次重建；开会话时就是目标状态则本来就零成本。守卫本身不
 * 增加任何工具声明面，所以默认开着没有代价，由 `teamPolicyCacheGuard` 关闭，
 * 每次装配/每步重读活引用。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/team-policy-cache-guard
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 官方 Agent Teams 的指引段名。 */
export const TEAM_POLICY_SECTION = 'team:policy'

/** 尾部撤销通知的来源 kind（本包自有，见下方 MessageSourceMap 增补）。 */
export const TEAM_BOARD_NOTICE_SOURCE_KIND = 'team-board-notice'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 本包在 agent/pre-step 末尾追加的团队任务板提示（不是新的用户回合）。 */
    'team-board-notice': { kind: 'team-board-notice' } & { form?: 'notice', summary?: string }
  }
}

/** 开关关掉时补投的那句话。 */
const BOARD_OFF_NOTICE = 'The shared team task board was turned off. Ignore earlier guidance describing an '
  + 'available board and coordinate through list_agents and send_message.'

/** 守卫交回的句柄。 */
export interface TeamPolicyCacheGuard {
  /** 摘掉本守卫挂上的全部东西（幂等）。 */
  dispose(): void
}

/** 守卫选项。 */
export interface TeamPolicyCacheGuardOptions {
  /** 是否启用；每次装配与每步都重读，所以设置保存后下一步就生效。默认开启。 */
  readonly enabled?: () => boolean
}

/**
 * 从插件配置里读开关。
 * @param config - 插件配置（结构化：只读一个键）。
 * @returns 是否启用本守卫；未声明时按开启处理（宿主 schema 的默认值）。
 */
export function resolveTeamPolicyCacheGuardEnabled(
  config: { teamPolicyCacheGuard?: unknown } | undefined,
): boolean {
  return config?.teamPolicyCacheGuard !== false
}

/** 一次团队开关激活的守卫状态，按 agent 分桶。 */
interface GuardState {
  /** 最近一次捕获到的策略正文。 */
  policy: string
  /** 待投递的正文（只在本次激活还没投过时存在）。 */
  pending: string | undefined
  /** 本次激活投过没有。 */
  delivered: boolean
  /** 下一步要补投「已关闭」通知。 */
  revoked: boolean
}

/** 装配期见过 `team:policy` 段没有（用来判断守卫是不是在空转）。 */
interface GuardStats {
  /** 是否至少见过一次该段。 */
  seen: boolean
  /** 是否已经为「从没见过」报过警。 */
  warned: boolean
}

/** 事件订阅面。 */
interface EventHostLike {
  /** 订阅一个事件。 */
  on?(name: string, listener: (...args: never[]) => unknown): (() => void) | undefined
}

/** 日志面。 */
interface LoggerLike {
  /** 警告级日志。 */
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
  agent?: { session?: unknown }
  /** 取消信号。 */
  signal?: { aborted?: boolean }
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
function createBoardNotice(text: string, summary: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: TEAM_BOARD_NOTICE_SOURCE_KIND, form: 'notice', summary },
  })
}

/**
 * 装一台「Agent Teams 策略段缓存守卫」。
 *
 * 幂等性留给调用方：同一个 ctx 装两次会得到两条监听器，宿主入口应当只装一次。
 * @param ctx - 宿主上下文（结构化：老代 ctx 也认）。
 * @param options - 开关读取器。
 * @returns 句柄，dispose 摘掉全部挂载。
 */
export function installTeamPolicyCacheGuard(
  ctx: unknown,
  options: TeamPolicyCacheGuardOptions = {},
): TeamPolicyCacheGuard {
  const states = new WeakMap<object, GuardState>()
  const stats: GuardStats = { seen: false, warned: false }
  const restores: (() => void)[] = []
  let closed = false

  const enabled = (): boolean => {
    try {
      return options.enabled?.() === true
    } catch {
      return false
    }
  }

  const stateOf = (key: object): GuardState => {
    let state = states.get(key)
    if (state === undefined) {
      state = { policy: '', pending: undefined, delivered: false, revoked: false }
      states.set(key, state)
    }
    return state
  }

  // ── 1. 摘掉 team:policy ───────────────────────────────────────────────────
  const onAssemble = async (
    _assembly: PresentationLike,
    context: AssembleContextLike,
    next: () => Promise<PresentationLike>,
  ): Promise<PresentationLike> => {
    const result = await next()
    if (closed || !enabled()) return result
    const sections = Array.isArray(result?.sections) ? result.sections : undefined
    if (sections === undefined) return result
    const kept: AssembledSectionLike[] = []
    let policy: string | undefined
    for (const section of sections) {
      if (section?.name === TEAM_POLICY_SECTION) {
        stats.seen = true
        policy = typeof section.text === 'string' ? section.text : ''
        continue
      }
      kept.push(section)
    }
    if (policy === undefined) {
      // 启用却一直没见过这个段：说明 harness 改了形态，本守卫在空转。只报一次。
      if (!stats.seen && !stats.warned) {
        stats.warned = true
        logWarn(ctx, `[dsh-chatgpt-subscription] team policy cache guard is enabled but no "${TEAM_POLICY_SECTION}" `
          + 'section has appeared; the guard is inert on this deployment')
      }
      return result
    }
    const state = stateOf(bucketOf(context?.scope ?? context?.agent))
    if (policy.trim() === '') {
      // 官方段在关闭时就是空串：上一次激活到此结束，下一步补一条撤销通知。
      if (state.delivered) state.revoked = true
      state.delivered = false
      state.pending = undefined
    } else {
      state.policy = policy
      // 板又回来了：上一步排队的「已关闭」通知作废，不再补投。
      state.revoked = false
      if (!state.delivered) state.pending = policy
    }
    if (kept.length === sections.length) return result
    return { ...result, sections: kept }
  }

  // ── 2. 一次激活投一次尾部消息 ─────────────────────────────────────────────
  const onPreStep = async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike | undefined>,
  ): Promise<PreStepDecisionLike | undefined> => {
    const decision = await next()
    if (closed || decision === undefined || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision
    if (!enabled()) return decision
    const state = states.get(bucketOf(payload?.agent ?? undefined))
    if (state === undefined) return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    if (!state.delivered) {
      const text = state.pending
      if (text !== undefined) {
        // 新一次激活的正文优先于「已关闭」通知：板已经回来，撤销就不必再提。
        state.pending = undefined
        state.delivered = true
        state.revoked = false
        return {
          ...decision,
          messages: [...messages, createBoardNotice(text, 'Team board guidance')],
        }
      }
    }
    if (state.revoked) {
      state.revoked = false
      return {
        ...decision,
        messages: [...messages, createBoardNotice(BOARD_OFF_NOTICE, 'Team board off')],
      }
    }
    return decision
  }

  const offAssemble = subscribe(ctx, 'system-prompt/assemble', onAssemble as unknown as (...args: never[]) => unknown)
  const offPreStep = subscribe(ctx, 'agent/pre-step', onPreStep as unknown as (...args: never[]) => unknown)
  if (offAssemble !== undefined) restores.push(() => { offAssemble() })
  if (offPreStep !== undefined) restores.push(() => { offPreStep() })

  return {
    dispose(): void {
      if (closed) return
      closed = true
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

export default installTeamPolicyCacheGuard
