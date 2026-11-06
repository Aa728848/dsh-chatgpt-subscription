/**
 * 「已结算后台任务跨回合幂等守卫」——消除子代理/会话中断重唤醒后的假性 `unknown job` 报错。
 *
 * ## 为什么会出现 `unknown job win-bash-...`
 *
 * DSH 内核 `jobs-local` 在 `Agent` 实例卸载（例如主代理调用 `interrupt_agent` 中断可续接
 * 子代理的当前回合）时运行 `disposeOwned(owner)`：
 *
 * 1. 自动终止该 `Agent` 名下的后台进程；
 * 2. 在所属 `session` 日志中落盘一条持久化的 `job/settled` 事件（`status: 'killed'`、
 *    `cause: 'teardown'`）；
 * 3. 调用 `drop()` 将该任务从内存表 `this.store` 中彻底删除。
 *
 * 随后当主代理用 `send_message` 唤醒该可续接会话进入下一回合、模型按规矩调用
 * `job_kill({ job_id })` 或 `job_output({ job_id })` 回收自己之前启动的后台任务时，
 * 内存表已经找不到这个 `job_id`，于是直接抛 `Error: unknown job <id>`——而在未触发
 * `drop()` 的同一生命周期内，`jobs.kill()` 对已终止任务的正常契约原本是返回幂等的
 * `'already-finished'`。
 *
 * ## 做什么、不做什么
 *
 * - 包装 `ctx.jobs` 的 `kill`、`get`、`read`、`wait` 四个按 `job_id` 查询的方法（沿原型链
 *   定位未绑定实现，保留 Cordis `Service` 代理的作用域 `this`）。
 * - 原方法成功时原样返回，快路径零开销；
 * - **仅当**原方法抛出 `unknown job <id>` 且传入了非空 `caller` 会话 id 时，反查该 `caller`
 *   自己的持久会话日志（`snapshotEvents()`）里是否已有同 `jobId` 且归属同一 `caller` 的
 *   `job/settled` 事件：
 *   - 命中则重建只读终态 `JobView`：`kill` 返回 `'already-finished'`，`get`/`wait` 返回该视图，
 *     `read` 返回空增量与该终态视图；
 *   - 未命中或归属其他会话时，原样重抛原错误（不破坏跨会话隔离围栏）。
 * - **不碰** `list`、**不碰**任何工具定义或 `systemPrompt` 段，Kimi Code 前缀缓存零漂移。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/settled-job-guard
 */

/** 守卫句柄。 */
export interface SettledJobGuard {
  /** 还原被包装的 `jobs` 方法（幂等）。 */
  dispose(): void
}

/** 终态后台任务状态集合。 */
type TerminalJobStatus = 'completed' | 'failed' | 'killed'

/** 重建的最小 `JobView` 结构（对齐 `@deepseek-ai/dsh-jobs` 的只读投影契约）。 */
export interface RecoveredJobView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly owner: string
  readonly status: TerminalJobStatus
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly output: {
    readonly total: number
    readonly earliest: number
  }
}

/** 重建的最小 `JobRead` 结构。 */
export interface RecoveredJobRead {
  readonly chunks: readonly never[]
  readonly lossy: false
  readonly job: RecoveredJobView
}

/** `ctx.jobs` 上本守卫包装的四个方法签名。 */
interface JobsServiceLike {
  kill?(id: unknown, caller?: unknown, reason?: unknown): unknown
  get?(id: unknown, caller?: unknown): unknown
  read?(id: unknown, caller?: unknown): unknown
  wait?(id: unknown, timeoutMs: unknown, caller?: unknown, signal?: unknown): Promise<unknown>
}

/** 注入面（老代宿主未必有 `ctx.inject`）。 */
interface InjectHostLike {
  inject?(deps: string[], callback: (scope: unknown) => void): unknown
}

/** 一个未绑定的方法（`this` 由调用点决定）。 */
type UnboundMethod = (this: unknown, ...args: unknown[]) => unknown

/** 一个待包装的方法定位信息。 */
interface MethodTarget {
  readonly holder: object
  readonly name: string
  readonly original: UnboundMethod
  readonly descriptor: PropertyDescriptor | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  const get = (ctx as { get?: (service: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

function isTerminalStatus(value: unknown): value is TerminalJobStatus {
  return value === 'completed' || value === 'failed' || value === 'killed'
}

function isUnknownJobError(error: unknown, id: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message === `unknown job ${id}`
}

/**
 * 通过 `agents` 或 `sessions` 服务定位 `caller` 对应的会话对象。
 */
function resolveCallerSession(ctx: unknown, caller: string): unknown {
  const agents = serviceOf<{ get?(id: string): unknown }>(ctx, 'agents')
  if (typeof agents?.get === 'function') {
    try {
      const agent = agents.get(caller) as { session?: unknown } | undefined
      if (agent?.session !== undefined && agent.session !== null) return agent.session
    } catch {
      // 落到 sessions 服务兜底。
    }
  }
  const sessions = serviceOf<{ get?(id: string): unknown }>(ctx, 'sessions')
  if (typeof sessions?.get === 'function') {
    try {
      const session = sessions.get(caller)
      if (session !== undefined && session !== null) return session
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 从调用方自己的持久会话日志里倒序查找已落盘的 `job/settled` 记录。
 *
 * 严格校验 `owner === caller`：无主或归属其它会话的任务绝不跨会话恢复。
 */
export function findSettledJobInSession(
  session: unknown,
  jobId: string,
  caller: string,
): RecoveredJobView | undefined {
  if (!isRecord(session)) return undefined
  const snapshot = session['snapshotEvents']
  if (typeof snapshot !== 'function') return undefined
  let events: unknown
  try {
    events = snapshot.call(session)
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!isRecord(event) || event['type'] !== 'job/settled') continue
    const data = event['data']
    if (!isRecord(data)) continue
    if (data['jobId'] !== jobId) continue
    // 隔离围栏：只恢复明确登记在当前 caller 名下的已结算任务。
    if (data['owner'] !== caller) return undefined

    const kind = typeof data['kind'] === 'string' && data['kind'].length > 0 ? data['kind'] : 'job'
    const label = typeof data['label'] === 'string' && data['label'].length > 0 ? data['label'] : jobId
    const status: TerminalJobStatus = isTerminalStatus(data['status']) ? data['status'] : 'killed'
    const detail = typeof data['detail'] === 'string' && data['detail'].length > 0 ? data['detail'] : undefined
    const startedAt = typeof data['startedAt'] === 'number' && Number.isFinite(data['startedAt'])
      ? data['startedAt']
      : 0
    const finishedAt = typeof data['finishedAt'] === 'number' && Number.isFinite(data['finishedAt'])
      ? data['finishedAt']
      : undefined

    return {
      id: jobId,
      kind,
      label,
      owner: caller,
      status,
      ...(detail === undefined ? {} : { detail }),
      startedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      output: { total: 0, earliest: 0 },
    }
  }
  return undefined
}

function resolveMethodTarget(service: unknown, name: string): MethodTarget | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const own = service as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(own, name)) {
    const original = own[name]
    if (typeof original !== 'function') return undefined
    return {
      holder: own,
      name,
      original: original as UnboundMethod,
      descriptor: Object.getOwnPropertyDescriptor(own, name),
    }
  }
  const proto = Object.getPrototypeOf(service) as object | null
  if (proto === null || proto === Object.prototype || proto === Function.prototype) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(proto, name)
  if (descriptor === undefined || typeof descriptor.value !== 'function') return undefined
  return {
    holder: proto,
    name,
    original: descriptor.value as UnboundMethod,
    descriptor,
  }
}

function installMethod(target: MethodTarget, replacement: UnboundMethod): boolean {
  try {
    Object.defineProperty(target.holder, target.name, {
      configurable: target.descriptor?.configurable ?? true,
      enumerable: target.descriptor?.enumerable ?? false,
      writable: target.descriptor?.writable ?? true,
      value: replacement,
    })
    return true
  } catch {
    return false
  }
}

function restoreMethod(target: MethodTarget): void {
  try {
    if (target.descriptor !== undefined) {
      Object.defineProperty(target.holder, target.name, target.descriptor)
    } else {
      delete (target.holder as Record<string, unknown>)[target.name]
    }
  } catch {
    // 卸载期单点还原失败不影响其余清理。
  }
}

function alreadyPatched(patched: WeakMap<object, Set<string>>, holder: object, name: string): boolean {
  return patched.get(holder)?.has(name) === true
}

function markPatched(patched: WeakMap<object, Set<string>>, holder: object, name: string): void {
  let set = patched.get(holder)
  if (set === undefined) {
    set = new Set<string>()
    patched.set(holder, set)
  }
  set.add(name)
}

/**
 * 安装「已结算后台任务跨回合幂等守卫」。
 *
 * @param ctx - 宿主上下文。
 * @returns 守卫句柄。
 */
export function installSettledJobGuard(ctx: unknown): SettledJobGuard {
  const restores: (() => void)[] = []
  const patchedMethods = new WeakMap<object, Set<string>>()
  let closed = false

  const recoverForCaller = (rawId: unknown, rawCaller: unknown): RecoveredJobView | undefined => {
    if (closed) return undefined
    if (typeof rawId !== 'string' || rawId.length === 0) return undefined
    if (typeof rawCaller !== 'string' || rawCaller.length === 0) return undefined
    const session = resolveCallerSession(ctx, rawCaller)
    return findSettledJobInSession(session, rawId, rawCaller)
  }

  const patchSync = (
    jobs: JobsServiceLike,
    methodName: 'kill' | 'get' | 'read',
    onRecovered: (view: RecoveredJobView) => unknown,
  ): void => {
    const target = resolveMethodTarget(jobs, methodName)
    if (target === undefined || alreadyPatched(patchedMethods, target.holder, target.name)) return
    const original = target.original
    const wrapped: UnboundMethod = function (this: unknown, ...args: unknown[]): unknown {
      const receiver = this ?? jobs
      try {
        return original.call(receiver, ...args)
      } catch (error: unknown) {
        const id = typeof args[0] === 'string' ? args[0] : ''
        if (id !== '' && isUnknownJobError(error, id)) {
          const recovered = recoverForCaller(id, args[1])
          if (recovered !== undefined) return onRecovered(recovered)
        }
        throw error
      }
    }
    if (!installMethod(target, wrapped)) return
    markPatched(patchedMethods, target.holder, target.name)
    restores.push(() => { restoreMethod(target) })
  }

  const patchWait = (jobs: JobsServiceLike): void => {
    const target = resolveMethodTarget(jobs, 'wait')
    if (target === undefined || alreadyPatched(patchedMethods, target.holder, target.name)) return
    const original = target.original
    const wrapped: UnboundMethod = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const receiver = this ?? jobs
      try {
        return await (original.call(receiver, ...args) as Promise<unknown>)
      } catch (error: unknown) {
        const id = typeof args[0] === 'string' ? args[0] : ''
        if (id !== '' && isUnknownJobError(error, id)) {
          const recovered = recoverForCaller(id, args[2])
          if (recovered !== undefined) return recovered
        }
        throw error
      }
    }
    if (!installMethod(target, wrapped)) return
    markPatched(patchedMethods, target.holder, target.name)
    restores.push(() => { restoreMethod(target) })
  }

  const wrap = (jobs: JobsServiceLike | undefined): void => {
    if (jobs === undefined) return
    patchSync(jobs, 'kill', () => 'already-finished')
    patchSync(jobs, 'get', (view) => view)
    patchSync(jobs, 'read', (view): RecoveredJobRead => ({ chunks: [], lossy: false, job: view }))
    patchWait(jobs)
  }

  const immediate = serviceOf<JobsServiceLike>(ctx, 'jobs')
  if (immediate !== undefined) {
    wrap(immediate)
  } else {
    const inject = (ctx as InjectHostLike | undefined)?.inject
    if (typeof inject === 'function') {
      let wrapped = false
      try {
        inject.call(ctx, ['jobs'], (scope: unknown) => {
          if (wrapped || closed) return
          wrapped = true
          wrap(serviceOf<JobsServiceLike>(scope, 'jobs'))
        })
      } catch {
        // 老代无 jobs 注入面：安静跳过。
      }
    }
  }

  return {
    dispose(): void {
      if (closed) return
      closed = true
      for (const restore of restores.splice(0)) {
        try {
          restore()
        } catch {
          // 忽略单点卸载异常。
        }
      }
    },
  }
}
