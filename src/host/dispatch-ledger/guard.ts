/**
 * 「调度账本」的**执行期守卫**。
 *
 * ## 它站在哪儿
 *
 * 只用 `ctx.tools.guard(exec => string | undefined)` 这一条执行期接缝：
 * 工具声明面一个字节都不改，Kimi Code 的前缀缓存不会因为这个守卫重建一次。
 * 守卫在 pre-execute 之后、派发之前跑；拒绝会变成 `isError` 的工具结果，
 * 正文是 `Error: <reason>`。
 *
 * ## 拒绝文案格式（跨代次宿主可判定）
 *
 * 所有拒绝一律以 `DISPATCH_LEDGER_V2:<CODE>:` 开头。账本折叠靠**结果内容
 * 文本**识别"这次尝试是被守卫拒的"（原生走 tool/result 的 message.content，
 * PTC 走 tool/ptc-dispatch 的 content），所以这个前缀是跨代次宿主都能用的
 * 判据。
 *
 * ## 只拒能证明的违规
 *
 * - 没有头部 → **放行**（旧消息降级审计），不拦。
 * - 头部显式损坏 → 拒（解析不了就没有去重依据）。
 * - 读不出来的状态 → 放行 + 审计。宁可漏放，也不误伤。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/guard
 */

import {
  MANDATE_KIND_FIELDS,
  mandateNamespaceKey,
  mandateNamespaceKeyOf,
  parseMandateHeader,
  type MandateHeader,
} from './header.ts'
import {
  heldMandatesOfSession,
  parentSessionIdOfSession,
  sessionIdOf,
  type SessionLike,
} from './binding.ts'
import {
  briefIsBusy,
  foldDispatchLedger,
  initialDispatchLedgerState,
  runOf,
  DISPATCH_GUARD_DENIAL_PREFIX,
  MAX_BRIEFS_PER_SESSION,
  MAX_RUNS_PER_SESSION,
  type DispatchLedgerEventLike,
  type DispatchLedgerState,
  type LedgerRun,
} from './ledger.ts'
import {
  dispatchPolicyDescriptor,
  policyDescriptorsMatch,
  type DispatchPolicyDescriptor,
  type DispatchPolicyRoute,
} from './policy.ts'
import { auditedRoutesOf } from '../subagent-route-audit.ts'

/** 守卫的拒绝码。 */
export type DispatchDenialCode =
  | 'MANDATE_MALFORMED'
  | 'MANDATE_KIND'
  | 'MANDATE_DUPLICATE'
  | 'MANDATE_BRIEF_BUSY'
  | 'MANDATE_LINEAGE_REQUIRED'
  | 'MANDATE_LINEAGE'
  | 'MANDATE_POLICY_STALE'
  | 'MANDATE_VERSION'
  | 'MANDATE_NOT_PARENT'
  | 'MANDATE_NOT_CHILD'
  | 'MANDATE_GRANT_EXCEEDS'
  | 'MANDATE_NOT_HELD'
  | 'MANDATE_LEDGER_FULL'

/** 一次工具执行（守卫只读这些）。 */
export interface DispatchGuardExecution {
  /** 工具名。 */
  readonly name?: unknown
  /** 已解析的参数。 */
  readonly arguments?: unknown
  /** 调用方 agent。 */
  readonly agent?: unknown
  /** 本次调用的 id（宿主在守卫之前就把调用写进了日志）。 */
  readonly callId?: unknown
}

/** 守卫读到的会话视图。 */
export interface DispatchLedgerSessionLike extends SessionLike {
  /** 当前日志水位。 */
  readonly seq?: unknown
  /** 按序号读一条事件。 */
  eventAt?(seq: number): DispatchLedgerEventLike | undefined
}

/** 会话注册表（结构化；老宿主可能只有 get）。 */
export interface DispatchLedgerSessions {
  /** 按 id 取一个会话。 */
  get(id: string): DispatchLedgerSessionLike | undefined
  /** 列出全部会话（one-shot 候选的来源）。 */
  list?(): readonly DispatchLedgerSessionLike[]
}

/** 守卫选项。 */
export interface DispatchLedgerGuardOptions {
  /** 当前是否启用拦截（每次执行都重读）。 */
  readonly enabled?: () => boolean
  /** 会话注册表；缺席时只做能证明的校验。 */
  readonly sessions?: () => DispatchLedgerSessions | undefined
  /** 当前会话的策略描述符；缺席时跳过策略校验。 */
  readonly policyFor?: (session: DispatchLedgerSessionLike) => DispatchPolicyDescriptor | undefined
  /**
   * 当前环境的提示词修订号（由宿主注入）。
   *
   * 派发头的 §prompt_ref§ 必须与它一致：模型只允许从 self 结果里抄，不允许
   * 自拟。未注入时跳过这条校验（standalone 测试宿主）。
   */
  readonly promptRef?: string
  /** 视为"派发"的工具名。 */
  readonly dispatchTools?: readonly string[]
  /** 共享的折叠缓存。 */
  readonly cache?: DispatchLedgerCache
  /** 当前时刻（毫秒）；测试用它把预约推进到过期之后。 */
  readonly now?: () => number
}

/** 默认的派发工具名。 */
export const DEFAULT_GUARD_DISPATCH_TOOLS: readonly string[] = ['subagent', 'subagent_fork']

/**
 * 判断一个值是不是普通记录对象。
 * @param value - 候选值。
 * @returns 是记录对象时 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一个值里的非空字符串。
 * @param value - 候选值。
 * @returns 字符串；其它类型为 undefined。
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 造一条拒绝文案。
 * @param code - 拒绝码。
 * @param detail - 可执行的说明。
 * @returns 拒绝文案。
 */
export function dispatchDenial(code: DispatchDenialCode, detail: string): string {
  return DISPATCH_GUARD_DENIAL_PREFIX + ':' + code + ': ' + detail
}

/**
 * 读一个调用方的会话。
 * @param agent - 调用方 agent。
 * @returns 会话；没有时 undefined。
 */
function sessionOfAgent(agent: unknown): DispatchLedgerSessionLike | undefined {
  if (!isRecord(agent)) return undefined
  const session = agent['session']
  if (!isRecord(session)) return undefined
  return session as DispatchLedgerSessionLike
}

/**
 * 读一个会话的全部事件。
 * @param session - 会话。
 * @returns 事件数组；读不到时是空数组。
 */
function eventsOfSession(session: DispatchLedgerSessionLike): readonly DispatchLedgerEventLike[] {
  if (Array.isArray(session.events)) return session.events
  const snapshot = session.snapshotEvents
  if (typeof snapshot !== 'function') return []
  try {
    const listed = snapshot.call(session)
    return Array.isArray(listed) ? listed as readonly DispatchLedgerEventLike[] : []
  } catch {
    return []
  }
}

/** 折叠缓存的一条记录。 */
interface LedgerCacheEntry {
  /** 已折到的序号（含）。 */
  lastSeq: number
  /** 折叠出来的状态。 */
  state: DispatchLedgerState
}

/**
 * 进程内的折叠缓存。
 *
 * ## 缓存安全措施
 *
 * 1. **按会话 id 分键**：不同会话的折叠结果互不污染。
 * 2. **水位校验**：只折 seq 大于水位的��件；一旦发现水位不连续（缺口或
 *    倒序），立刻**整段重折**——日志被替换过的情况下宁可多算一次，也不把
 *    一份错的状态当成真的。
 * 3. **容量上限**：最多缓存 N 个会话，超出时淘汰最早写入的那个（Map 保持
 *    插入顺序），内存有界。
 * 4. **只存纯数据**：缓存里只有折叠状态与序号，不持有会话对象的引用，
 *    会话销毁后不会泄漏。
 */
export interface DispatchLedgerCache {
  /** 折出一个会话的账本状态。 */
  fold(session: DispatchLedgerSessionLike): DispatchLedgerState
  /** 丢弃一个会话的缓存条目。 */
  forget(sessionId: string): void
  /** 丢弃全部缓存条目。 */
  clear(): void
  /** 当前缓存的会话数。 */
  size(): number
}

/**
 * 造一个折叠缓存。
 * @param limit - 最多缓存多少个会话。
 * @returns 缓存。
 */
export function createDispatchLedgerCache(limit = 64): DispatchLedgerCache {
  const entries = new Map<string, LedgerCacheEntry>()
  const cap = Math.max(1, limit)
  const remember = (id: string, entry: LedgerCacheEntry): void => {
    entries.delete(id)
    entries.set(id, entry)
    while (entries.size > cap) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }
  return {
    fold(session: DispatchLedgerSessionLike): DispatchLedgerState {
      const id = sessionIdOf(session) ?? ''
      const events = eventsOfSession(session)
      const entry = entries.get(id)
      if (entry !== undefined) {
        const tail = events.filter(event => typeof event.seq === 'number' && event.seq > entry.lastSeq)
        const firstSeq = tail.length === 0 ? entry.lastSeq + 1 : tail[0]?.seq
        // 水位必须连续：缺口或倒序都说明日志被换过，整段重折。
        if (firstSeq === entry.lastSeq + 1) {
          let state = entry.state
          let lastSeq = entry.lastSeq
          for (const event of tail) {
            state = foldDispatchLedger(state, event)
            if (typeof event.seq === 'number') lastSeq = event.seq
          }
          remember(id, { lastSeq, state })
          return state
        }
      }
      let state = initialDispatchLedgerState()
      let lastSeq = -1
      for (const event of events) {
        state = foldDispatchLedger(state, event)
        if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
      }
      remember(id, { lastSeq, state })
      return state
    },
    forget(sessionId: string): void {
      entries.delete(sessionId)
    },
    clear(): void {
      entries.clear()
    },
    size(): number {
      return entries.size
    },
  }
}

/**
 * 读一个会话的允许路由。
 *
 * 会话自己记过就用自己的；没记过就沿 `header.parentSession` 往上找（深度
 * 上限 8，与插件既有的祖先查找同一条路）。找不到就是空清单。
 * @param session - 会话。
 * @param sessions - 会话注册表。
 * @returns 路由清单。
 */
export function routesForSession(
  session: DispatchLedgerSessionLike | undefined,
  sessions: DispatchLedgerSessions | undefined,
): DispatchPolicyRoute[] {
  let current = session
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    const audited = auditedRoutesOf(current)
    if (audited !== undefined) {
      return audited.map(route => ({ provider: route.provider, model: route.model }))
    }
    const parentId = parentSessionIdOfSession(current)
    if (parentId === undefined) return []
    current = sessions?.get(parentId)
  }
  return []
}

/**
 * 算出一个会话的策略描述符。
 * @param session - 会话。
 * @param sessions - 会话注册表。
 * @param dispatchTools - 派发工具名。
 * @returns 策略描述符。
 */
export function policyForSession(
  session: DispatchLedgerSessionLike | undefined,
  sessions: DispatchLedgerSessions | undefined,
  dispatchTools: readonly string[] = DEFAULT_GUARD_DISPATCH_TOOLS,
): DispatchPolicyDescriptor {
  return dispatchPolicyDescriptor({ tools: dispatchTools, routes: routesForSession(session, sessions) })
}

/**
 * 读一个工作项里**不是**某个命名空间的最新运行。
 * @param state - 账本状态。
 * @param brief_id - 工作项 id。
 * @param excludeNs - 排除的命名空间（一般是本次调用自己的）。
 * @returns 最新运行；没有时 undefined。
 */
function latestOtherRunOfBrief(
  state: DispatchLedgerState,
  brief_id: string,
  excludeNs: string,
): LedgerRun | undefined {
  let best: LedgerRun | undefined
  for (const run of Object.values(state.runs)) {
    if (run.brief_id !== brief_id || run.ns === excludeNs) continue
    if (best === undefined || run.seq > best.seq) best = run
  }
  return best
}

/**
 * 读一个会话持有的、最后一次的派发 Mandate。
 * @param session - 会话。
 * @returns 头部；没有时 undefined。
 */
export function ownMandateOf(session: DispatchLedgerSessionLike | undefined): MandateHeader | undefined {
  if (session === undefined) return undefined
  let found: MandateHeader | undefined
  for (const header of heldMandatesOfSession(session)) {
    if (header.kind !== 'dispatch') continue
    found = header
  }
  return found
}

/**
 * 预约的存活时间：30 分钟。
 *
 * 预约是**兜底**，不是权威：权威是持久账本。预约只用来覆盖"老代没有
 * ptc-start、当前调用还没入账"的那一小段窗口——那段窗口里账本看不见本次
 * 并行调用，防重会漏。窗口一过（TTL 到期），防重只剩账本。
 */
export const DISPATCH_RESERVATION_TTL_MS = 30 * 60 * 1000

/** 预约表最多保留多少条。 */
export const MAX_DISPATCH_RESERVATIONS = 256

/** 一条预约。 */
export interface DispatchLedgerReservation {
  /** 签发方（发起派发的会话 id）。 */
  readonly issuer: string
  /** 命名空间键。 */
  readonly ns: string
  /** 预约者的调用 id。 */
  readonly callId: string
  /** 预约时刻（Unix 毫秒）。 */
  readonly at: number
}

/** 预约表。 */
export interface DispatchLedgerReservations {
  /**
   * 这个命名空间是否已被**别的**调用预约。
   * @param issuer - 签发方会话 id。
   * @param ns - 命名空间键。
   * @param callId - 本次调用 id（自己的预约不算冲突）。
   * @returns 是否冲突。
   */
  conflicts(issuer: string, ns: string, callId: string): boolean
  /**
   * 这个命名空间当前由哪一次调用预约（没有时 undefined）。
   *
   * 守卫用它判定「这条预约是不是来自一个从未派发出去的调用」——那种预约
   * 只可能属于一次被派发前拒绝的尝试，不能挡住修正后的重试。
   * @param issuer - 签发方会话 id。
   * @param ns - 命名空间键。
   * @returns 预约者的调用 id；没有预约（或已过期）时 undefined。
   */
  holder(issuer: string, ns: string): string | undefined
  /**
   * 预约一个命名空间（**只有所有校验通过之后**才调用）。
   * @param issuer - 签发方会话 id。
   * @param ns - 命名空间键。
   * @param callId - 本次调用 id。
   */
  reserve(issuer: string, ns: string, callId: string): void
  /** 当前保留的预约数（过期条目会被顺手清掉）。 */
  size(): number
  /** 清空预约表。 */
  clear(): void
}

/**
 * 造一张预约表。
 *
 * 键是 (issuer, ns)：同一个签发方下的同一个命名空间只能被预约一次。
 * 过期条目在每次读写前被顺手清掉；表满时淘汰最早写入的一条。
 * @param options - 容量、TTL 与时钟。
 * @returns 预约表。
 */
export function createDispatchLedgerReservations(options: {
  readonly limit?: number
  readonly ttlMs?: number
  readonly now?: () => number
} = {}): DispatchLedgerReservations {
  const limit = Math.max(1, options.limit ?? MAX_DISPATCH_RESERVATIONS)
  const ttlMs = Math.max(0, options.ttlMs ?? DISPATCH_RESERVATION_TTL_MS)
  const now = options.now ?? (() => Date.now())
  const entries = new Map<string, DispatchLedgerReservation>()
  const keyOf = (issuer: string, ns: string): string => issuer + '\u0000' + ns
  const prune = (): void => {
    const stamp = now()
    for (const [key, entry] of entries) {
      if (stamp - entry.at >= ttlMs) entries.delete(key)
    }
  }
  return {
    conflicts(issuer: string, ns: string, callId: string): boolean {
      prune()
      const entry = entries.get(keyOf(issuer, ns))
      if (entry === undefined) return false
      return entry.callId !== callId
    },
    holder(issuer: string, ns: string): string | undefined {
      prune()
      return entries.get(keyOf(issuer, ns))?.callId
    },
    reserve(issuer: string, ns: string, callId: string): void {
      prune()
      const key = keyOf(issuer, ns)
      entries.delete(key)
      entries.set(key, { issuer, ns, callId, at: now() })
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
    size(): number {
      prune()
      return entries.size
    },
    clear(): void {
      entries.clear()
    },
  }
}

/**
 * 排除**本次调用自己**之后的容量判定。
 *
 * ## 为什么必须排除自己
 *
 * 宿主在守卫执行**之前**就把这次调用写进了日志（原生 §tool/call§、PTC
 * §tool/ptc-dispatch-start§），所以账本里已经有本次调用建出来的那条 run。
 * 直接拿账本的条数判容量，会把"第 256 条"当成"已经有 256 条"而误拒。
 *
 * 所以这里先把**本次调用自己建的那条 run**（ns 相同且 §createdByCallId§ 是
 * 本次调用）排除掉再数：剩下的条数才是"本次派发之前"的水位。于是恰好第
 * 256 条 run、第 64 个 brief 都放行；**原先**就有 256 run / 64 brief 时才真
 * 判满。
 *
 * 本函数**不改账本**：账本必须忠实保留全部幂等事实，容量判定是读侧的事。
 *
 * @param state - 账本状态。
 * @param brief_id - 本次派发要用的工作项 id。
 * @param currentNs - 本次派发的命名空间键。
 * @param callId - 本次调用的 id。
 * @returns 排除本次调用之后的容量判定。
 */
export function dispatchCapacityExcluding(
  state: DispatchLedgerState,
  brief_id: string,
  currentNs: string,
  callId: string | undefined,
): {
  readonly runs: number
  readonly briefs: number
  readonly isNewBrief: boolean
  readonly runsFull: boolean
  readonly briefsFull: boolean
  readonly full: boolean
} {
  const remaining = Object.values(state.runs).filter(run =>
    !(run.ns === currentNs && run.createdByCallId === callId))
  const runs = remaining.length
  const briefIds = new Set(remaining.map(run => run.brief_id))
  const isNewBrief = !briefIds.has(brief_id)
  const briefs = briefIds.size
  const runsFull = runs >= MAX_RUNS_PER_SESSION
  const briefsFull = briefs >= MAX_BRIEFS_PER_SESSION
  return {
    runs,
    briefs,
    isNewBrief,
    runsFull,
    briefsFull,
    // 只有**新建**工作项才占工作项名额；同一个工作项再开一次运行不占。
    full: runsFull || (isNewBrief && briefsFull),
  }
}

/**
 * 这条运行除「本次调用自己那条待结算 attempt」以外，是否有过真实的派发尝试。
 *
 * 判定只读 `attemptTotals`：它是权威计数，而展示用的 `attempts` 会被截断。
 * `succeeded` / `toolError` 都证明那次调用真的执行过；`unknown` 还包含「结局
 * 丢失但其实派出去了」——这些都必须继续占住命名空间。只有「本次调用自己的
 * 那条」要减掉，因为宿主在守卫之前就把它写进了日志。
 * @param run - 运行记录。
 * @param ownPending - 本次调用自己的那条 attempt 是否仍在待结算表里。
 * @returns 除本次调用外是否有过真实派发。
 */
function runClaimedByDispatch(run: LedgerRun, ownPending: boolean): boolean {
  const totals = run.attemptTotals
  const unknownOthers = totals.unknown - (ownPending ? 1 : 0)
  return totals.succeeded > 0 || totals.toolError > 0 || unknownOthers > 0
}

/**
 * 校验一次**派发**调用。
 * @param header - 派发头。
 * @param state - 调用方会话的账本状态。
 * @param callId - 本次调用的 id。
 * @param policy - 调用方的策略描述符。
 * @returns 拒绝文案；放行时 undefined。
 */
export function checkDispatchMandate(
  header: MandateHeader,
  state: DispatchLedgerState,
  callId: string | undefined,
  policy: DispatchPolicyDescriptor | undefined,
  promptRef?: string,
  reserved?: (ns: string) => boolean,
): string | undefined {
  if (policy !== undefined && !policyDescriptorsMatch(policy, header.policy)) {
    return dispatchDenial(
      'MANDATE_POLICY_STALE',
      'the policy block in the header is not the current one (expected id "'
      + policy.id + '" version "' + policy.version + '" sha256 ' + policy.sha256.slice(0, 12)
      + '). Read dispatch_ledger {action:"self"} again and copy the policy block verbatim.',
    )
  }
  if (promptRef !== undefined && header.prompt_ref !== promptRef) {
    return dispatchDenial(
      'MANDATE_VERSION',
      'the header carries prompt_ref "' + header.prompt_ref + '" but this host runs prompt_ref "'
      + promptRef + '". Copy it verbatim from dispatch_ledger {action:"self"}.',
    )
  }
  const ns = mandateNamespaceKey(header)
  // 重复判定先于容量判定：重复的命名空间是最具体的那个错，先说它。
  //
  // `denied` 的运行**不占用**命名空间：它的尝试全部被守卫在派发前拒掉，
  // 没有一次真的派发出去，所以同一套 id 允许接收修正后的重试。真正派发过的
  // 运行（booked / released / completed / blocked）照旧永不可复用。
  const existing = runOf(state, ns)
  // 「本次调用自己那条待结算 attempt」必须排除：宿主先把 tool/call 写进日志，
  // 这条 attempt 会把一条 denied 的运行重新算成 booked，只看 state 就会把
  // 修正后的重试重新判成重复——现场 session-9e27d9f1 的第 2 次尝试正是这样被挡回去的。
  const ownPending = callId !== undefined && state.pending[callId] === ns
  if (
    existing !== undefined
    && existing.createdByCallId !== callId
    && runClaimedByDispatch(existing, ownPending)
  ) {
    return dispatchDenial(
      'MANDATE_DUPLICATE',
      'the namespace (brief_id "' + header.brief_id + '", run_id "' + header.run_id
      + '", idem "' + header.idem + '") is already claimed by call ' + existing.createdByCallId
      + '. A namespace is never reusable: use a NEW run_id AND a NEW idem, and set parent_mandate.',
    )
  }
  // 预约兜底：老代没有 ptc-start 时，本次调用可能还没进账本，账本看不见它。
  if (reserved?.(ns) === true) {
    return dispatchDenial(
      'MANDATE_DUPLICATE',
      'the namespace (brief_id "' + header.brief_id + '", run_id "' + header.run_id
      + '", idem "' + header.idem + '") is reserved by another call in flight.',
    )
  }
  // 容量判定必须**排除本次调用自己**：它已经在日志里了。
  const capacity = dispatchCapacityExcluding(state, header.brief_id, ns, callId)
  if (capacity.full) {
    return dispatchDenial(
      'MANDATE_LEDGER_FULL',
      'the ledger already holds ' + capacity.runs + ' runs and ' + capacity.briefs
      + ' briefs (limits ' + '256' + '/' + '64' + '). Report it instead of reusing an old namespace.',
    )
  }
  if (briefIsBusy(state, header.brief_id, ns)) {
    return dispatchDenial(
      'MANDATE_BRIEF_BUSY',
      'another run of the brief "' + header.brief_id + '" is still booked. Wait for it, or use a new brief_id.',
    )
  }
  const previous = latestOtherRunOfBrief(state, header.brief_id, ns)
  const parent = header.parent_mandate
  if (previous === undefined) {
    if (parent !== undefined && parent !== null) {
      return dispatchDenial(
        'MANDATE_LINEAGE',
        'the brief "' + header.brief_id + '" has no earlier run, so parent_mandate must be null.',
      )
    }
    return undefined
  }
  if (parent === undefined || parent === null) {
    return dispatchDenial(
      'MANDATE_LINEAGE_REQUIRED',
      'the brief "' + header.brief_id + '" already has run "' + previous.ns.replace(/\u0000/g, '/')
      + '". Set parent_mandate to that run.',
    )
  }
  const pointed = mandateNamespaceKeyOf(parent.brief_id, parent.run_id, parent.idem)
  if (pointed !== previous.ns) {
    return dispatchDenial(
      'MANDATE_LINEAGE',
      'parent_mandate points at "' + pointed.replace(/\u0000/g, '/') + '" but the latest run of the brief is "'
      + previous.ns.replace(/\u0000/g, '/') + '".',
    )
  }
  if (previous.state === 'booked' || previous.state === 'blocked') {
    return dispatchDenial(
      'MANDATE_LINEAGE',
      'the run parent_mandate points at is still ' + previous.state + '; wait for it to settle.',
    )
  }
  return undefined
}

/**
 * 校验一次**报告**（子 → 父）。
 * @param header - 报告头。
 * @param senderSession - 发件方的会话。
 * @param targetId - 收件方（父）的会话 id。
 * @param targetState - 收件方的账本状态（读不到时 undefined）。
 * @returns 拒绝文案；放行时 undefined。
 */
export function checkReportMandate(
  header: MandateHeader,
  senderSession: DispatchLedgerSessionLike | undefined,
  targetId: string,
  targetState: DispatchLedgerState | undefined,
): string | undefined {
  const senderParent = senderSession === undefined ? undefined : parentSessionIdOfSession(senderSession)
  if (senderParent !== targetId) {
    return dispatchDenial(
      'MANDATE_NOT_PARENT',
      'the agent you are reporting to is not your durable parent session (your parentSession is "'
      + (senderParent ?? 'none') + '").',
    )
  }
  const ns = mandateNamespaceKey(header)
  const held = senderSession === undefined ? [] : heldMandatesOfSession(senderSession)
  if (held.length > 0 && !held.some(entry => mandateNamespaceKey(entry) === ns)) {
    return dispatchDenial(
      'MANDATE_NOT_HELD',
      'this session holds other mandates but not (brief_id "' + header.brief_id + '", run_id "'
      + header.run_id + '", idem "' + header.idem + '").',
    )
  }
  if (targetState !== undefined) {
    const run = runOf(targetState, ns)
    if (run !== undefined) {
      if (run.mandate_version !== header.mandate_version) {
        return dispatchDenial(
          'MANDATE_VERSION',
          'the recorded run has mandate_version ' + run.mandate_version + ' but the report says '
          + header.mandate_version + '.',
        )
      }
      if (run.prompt_ref !== header.prompt_ref) {
        return dispatchDenial(
          'MANDATE_VERSION',
          'the recorded run has prompt_ref "' + run.prompt_ref + '" but the report says "'
          + header.prompt_ref + '".',
        )
      }
    }
  }
  return undefined
}

/**
 * 校验一次**续派**（父 → 子）。
 * @param header - 续派头。
 * @param senderSession - 发件方（owner）的会话。
 * @param targetId - 收件方（子）的会话 id。
 * @param targetSession - 收件方的会话（读不到时 undefined）。
 * @param senderState - 发件方的账本状态。
 * @returns 拒绝文案；放行时 undefined。
 */
export function checkSteerMandate(
  header: MandateHeader,
  senderSession: DispatchLedgerSessionLike | undefined,
  targetId: string,
  targetSession: DispatchLedgerSessionLike | undefined,
  senderState: DispatchLedgerState,
): string | undefined {
  const senderId = senderSession === undefined ? undefined : sessionIdOf(senderSession)
  if (targetSession === undefined) {
    // 读不到收件方 ⇒ 证明不了越权 ⇒ 放行（审计）。
    return undefined
  }
  if (parentSessionIdOfSession(targetSession) !== senderId) {
    return dispatchDenial(
      'MANDATE_NOT_CHILD',
      'the agent "' + targetId + '" is not a direct child of this session.',
    )
  }
  const ns = mandateNamespaceKey(header)
  const run = runOf(senderState, ns)
  if (run === undefined) {
    return dispatchDenial(
      'MANDATE_NOT_HELD',
      'this session holds no run (brief_id "' + header.brief_id + '", run_id "' + header.run_id
      + '", idem "' + header.idem + '").',
    )
  }
  if (run.mandate_version !== header.mandate_version) {
    return dispatchDenial(
      'MANDATE_VERSION',
      'the recorded run has mandate_version ' + run.mandate_version + ' but the message says '
      + header.mandate_version + '.',
    )
  }
  if (run.prompt_ref !== header.prompt_ref) {
    return dispatchDenial(
      'MANDATE_VERSION',
      'the recorded run has prompt_ref "' + run.prompt_ref + '" but the message says "'
      + header.prompt_ref + '".',
    )
  }
  if (run.state !== 'booked' && run.state !== 'blocked') {
    return dispatchDenial(
      'MANDATE_NOT_HELD',
      'the run is ' + run.state + '; it cannot be steered any more.',
    )
  }
  const grant = header.grant
  if (grant !== undefined && grant !== null) {
    for (const item of grant.context) {
      if (!run.followup.includes(item)) {
        return dispatchDenial(
          'MANDATE_GRANT_EXCEEDS',
          'grant.context asks for "' + item + '", which is not in the followup this run was granted ('
          + (run.followup.length === 0 ? 'empty' : run.followup.join(', ')) + ').',
        )
      }
    }
  }
  const held = heldMandatesOfSession(targetSession)
  if (held.length > 0 && !held.some(entry => mandateNamespaceKey(entry) === ns)) {
    return dispatchDenial(
      'MANDATE_NOT_HELD',
      'the target session holds other mandates but not (brief_id "' + header.brief_id + '", run_id "'
      + header.run_id + '", idem "' + header.idem + '").',
    )
  }
  return undefined
}

/**
 * 造一台调度账本守卫。
 * @param options - 守卫选项。
 * @returns 守卫函数。
 */
export function createDispatchLedgerGuard(
  options: DispatchLedgerGuardOptions,
): (execution: DispatchGuardExecution) => string | undefined {
  const dispatchTools = options.dispatchTools ?? DEFAULT_GUARD_DISPATCH_TOOLS
  const cache = options.cache ?? createDispatchLedgerCache()
  const enabled = options.enabled ?? (() => true)
  const sessionsOf = options.sessions ?? (() => undefined)
  const now = options.now ?? (() => Date.now())
  const reservations = createDispatchLedgerReservations({ now })

  return (execution: DispatchGuardExecution): string | undefined => {
    if (typeof enabled === 'function') {
      try {
        if (enabled() === false) return undefined
      } catch {
        // 开关读失败按**开启**处理：保护不该因为一次读失败而失效。
      }
    }
    const toolName = asString(execution?.name)
    if (toolName === undefined) return undefined
    const isDispatch = dispatchTools.includes(toolName)
    const isMessage = toolName === 'send_message'
    if (!isDispatch && !isMessage) return undefined
    const args = isRecord(execution?.arguments) ? execution.arguments : undefined
    if (args === undefined) return undefined
    const text = isDispatch ? asString(args['prompt']) : asString(args['message'])
    if (text === undefined) return undefined
    const parsed = parseMandateHeader(text)
    if (parsed.state === 'none') return undefined
    if (parsed.state === 'invalid' || parsed.header === undefined) {
      return dispatchDenial(
        'MANDATE_MALFORMED',
        'the mandate header could not be parsed (' + (parsed.reason ?? 'unknown reason') + ').',
      )
    }
    const header = parsed.header
    if (isDispatch) {
      if (header.kind !== 'dispatch') {
        return dispatchDenial(
          'MANDATE_KIND',
          'a dispatch call must carry a kind "dispatch" header. A dispatch header carries exactly: '
          + MANDATE_KIND_FIELDS.dispatch + ' (copy the ready-to-send block from dispatch_ledger {action:"self"}).',
        )
      }
      const session = sessionOfAgent(execution?.agent)
      const state = session === undefined ? initialDispatchLedgerState() : cache.fold(session)
      const policy = options.policyFor?.(session ?? { id: '' })
      const callId = asString(execution?.callId)
      const issuer = session === undefined ? undefined : sessionIdOf(session)
      const ns = mandateNamespaceKey(header)
      const denial = checkDispatchMandate(
        header,
        state,
        callId,
        policy,
        options.promptRef,
        issuer === undefined ? undefined : (key: string) => {
          if (!reservations.conflicts(issuer, key, callId ?? '')) return false
          // 预约来自一次已被派发前拒绝的调用：它从未落地，只留下这条预约。
          // 不能让这条预约挡住修正后的重试（TTL 是 30 分钟，足以重演整轮失败）。
          const holder = reservations.holder(issuer, key)
          const heldRun = runOf(state, key)
          const ownPendingForHeld = callId !== undefined && state.pending[callId] === key
          if (holder !== undefined && heldRun !== undefined && heldRun.createdByCallId === holder
            && !runClaimedByDispatch(heldRun, ownPendingForHeld)) {
            return false
          }
          return true
        },
      )
      // **只有所有校验都通过**才预约：被拒的调用不占预约。
      if (denial === undefined && issuer !== undefined && callId !== undefined) {
        reservations.reserve(issuer, ns, callId)
      }
      return denial
    }
    if (header.kind === 'dispatch') {
      return dispatchDenial(
        'MANDATE_KIND',
        'a dispatch header belongs to the delegation tool, not send_message. A report header carries exactly: '
        + MANDATE_KIND_FIELDS.report + '; a steer header exactly: ' + MANDATE_KIND_FIELDS.steer + '.',
      )
    }
    const targetId = asString(args['agent_id'])
    if (targetId === undefined) return undefined
    const sessions = sessionsOf()
    const senderSession = sessionOfAgent(execution?.agent)
    if (header.kind === 'report') {
      const target = sessions?.get(targetId)
      const targetState = target === undefined ? undefined : cache.fold(target)
      return checkReportMandate(header, senderSession, targetId, targetState)
    }
    const target = sessions?.get(targetId)
    const senderState = senderSession === undefined
      ? initialDispatchLedgerState()
      : cache.fold(senderSession)
    return checkSteerMandate(header, senderSession, targetId, target, senderState)
  }
}

/**
 * 读宿主上下文里的工具注册面。
 * @param ctx - 宿主上下文。
 * @returns 带 guard 接缝的注册面；没有时 undefined。
 */
function toolsOf(ctx: unknown): { guard?: (guard: (execution: DispatchGuardExecution) => string | undefined) => (() => void) | undefined } | undefined {
  if (!isRecord(ctx)) return undefined
  let tools: unknown
  try {
    tools = ctx['tools']
  } catch {
    tools = undefined
  }
  if (!isRecord(tools)) {
    const reader = (ctx as { get?: (name: string) => unknown }).get
    if (typeof reader !== 'function') return undefined
    try {
      tools = reader.call(ctx, 'tools')
    } catch {
      return undefined
    }
  }
  return isRecord(tools) ? tools as { guard?: (guard: (execution: DispatchGuardExecution) => string | undefined) => (() => void) | undefined } : undefined
}

/**
 * 装一台调度账本守卫。
 *
 * 只用 `ctx.tools.guard()`：工具声明面一个字节都不改。
 * @param ctx - 宿主上下文。
 * @param options - 守卫选项。
 * @returns 注销守卫的函数；宿主没有 guard 接缝时是一个空操作。
 */
export function installDispatchLedgerGuard(
  ctx: unknown,
  options: DispatchLedgerGuardOptions = {},
): () => void {
  const tools = toolsOf(ctx)
  const register = tools?.guard
  if (typeof register !== 'function') return () => undefined
  const guard = createDispatchLedgerGuard(options)
  const dispose = register.call(tools, guard)
  return typeof dispose === 'function' ? dispose : () => undefined
}
