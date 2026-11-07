/**
 * 常驻执行环境的生命周期与会话级调用协调（对齐内核 `ptc.ts` 与 `PtcCalls`）。
 *
 * 部署把 `@deepseek-ai/dsh-ptc-runtime-node` 配成 `executionMode: persistent-in-memory` 时，
 * 同一个 agent 的多次 `code_run` 会共用一个常驻 REPL：顶层变量、函数与 `import` 的模块
 * 跨调用存活。可以不去用，但**不能只注册不释放**——常驻环境没有空闲过期，忘了释放会让子进程
 * 活到进程结束。
 *
 * 所以这里把「传了 owner」与「注册了释放」写进同一个动作：结构性无法表达「传了却没释放」。
 * 清理有三条路，覆盖所有生命周期终点与显式重置：
 *
 * 1. 挂在 **agent.ctx** 上的释放（对齐 `ptc.ts` 的 `stateOwners`）：展开 Cordis 包装链后按原初
 *    runtime provider 去重登记 `agent.ctx.effect`，即使本包早已卸载，agent 销毁也会释放它的环境；
 * 2. 挂在**插件**上的 teardown：卸载或热重载本包时先中止并排空在飞调用，再释放所有遗留环境；
 * 3. 会话级 `PtcCalls` 协调：新调用进入前等待同会话已取消的前序调用与进行中的 `reset` 彻底排空，
 *    避免前一次取消的收尾清理撞上后一次调用的 `assertIdle()`。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/retention
 */

import { CodeRunFailedError, type ActiveRunHandle, type PtcRuntimeLike } from './transport.ts'

/** Cordis 服务包装链指向原初实现的符号描述。 */
const CORDIS_ORIGINAL_DESCRIPTION = 'cordis.original'

/** 常驻环境管理与会话调用协调句柄。 */
export interface CodemodeRetention {
  /** 取一个 agent 的 owner（缺省用 agent 本身，并在 `agent.ctx` 上登记一次释放 effect）。 */
  owner(agent: unknown): object
  /** 释放一个 owner 的常驻环境（默认吞异常幂等；`strict: true` 供 `reset()` 原样上抛失败）。 */
  release(owner: object, options?: { readonly strict?: boolean }): Promise<void>
  /** 新调用进入前等待同会话已 abort 的前序调用及进行中的 reset 排空（对齐 `PtcCalls.run`）。 */
  awaitPredecessors(agent: unknown, signal: AbortSignal): Promise<void>
  /** 登记一只在飞运行；返回的 disposer 必须在 `lane.drain()` 完成后调用以唤醒后续等待者。 */
  trackRun(run: ActiveRunHandle): () => void
  /** 会话的 `sandbox/mode` 事件监听器：中止生效模式已不匹配的在飞运行。 */
  cancelOnModeChange(session: unknown, event: unknown): void
  /** 重置指定会话的常驻环境（对齐 `PtcCalls.reset`）；失败时阻塞该会话后续运行直至重试成功。 */
  reset(agent: unknown, notify?: () => void): Promise<void>
  /** 中止并排空所有在飞调用与重置，释放所有遗留环境（插件卸载时调用）。 */
  dispose(): Promise<void>
}

/** 会话里一只在飞程序：取消入口、生效沙箱模式与完整收尾 Promise。 */
interface TrackedCall {
  readonly controller: AbortController
  readonly signal: AbortSignal
  mode?: string
  readonly done: Promise<void>
  readonly resolveDone: () => void
}

/** 会话级一次环境重置的状态。 */
interface TrackedReset {
  readonly done: Promise<void>
  settled: boolean
}

/**
 * 造一个常驻环境与会话调用协调管理器。
 *
 * @param runtimeOf - 读当前运行时的函数（每次调用重读，运行时可能晚于本插件挂载）。
 * @returns 管理句柄。
 */
export function createRetention(runtimeOf: () => PtcRuntimeLike | undefined): CodemodeRetention {
  const live = new Set<object>()
  const released = new WeakSet<object>()
  const stateOwners = new WeakMap<object, WeakSet<object>>()
  const calls = new Map<unknown, Set<TrackedCall>>()
  const resets = new Map<unknown, TrackedReset>()
  let disposed = false

  const release = async (owner: object, options?: { readonly strict?: boolean }): Promise<void> => {
    const strict = options?.strict === true
    if (!strict && released.has(owner)) return
    released.add(owner)
    live.delete(owner)
    const runtime = runtimeOf()
    if (runtime?.release === undefined) return
    try {
      await runtime.release(owner)
    } catch (error: unknown) {
      if (strict) {
        // 严格重置失败时保留可重试状态，后续 reset 重试仍能再次调用 runtime.release。
        released.delete(owner)
        live.add(owner)
        throw error
      }
      // 普通释放失败不该让调用方看到异常：环境已经标记为 released，重试没有意义。
    }
  }

  /** 在 `agent.ctx` 上按原初 runtime provider 去重挂一次释放钩子（对齐 `ptc.ts:669-684`）。 */
  const bindAgentLifecycle = (owner: object): void => {
    const runtime = runtimeOf()
    if (runtime === undefined || typeof runtime !== 'object' || runtime === null) return
    const ctx = (owner as { readonly ctx?: { readonly effect?: (cb: () => () => unknown, label?: string) => unknown } }).ctx
    if (typeof ctx?.effect !== 'function') return
    let runtimes = stateOwners.get(owner)
    if (runtimes === undefined) {
      runtimes = new WeakSet<object>()
      stateOwners.set(owner, runtimes)
    }
    const provider = unwrapOriginalProvider(runtime)
    if (runtimes.has(provider)) return
    try {
      ctx.effect(() => () => release(owner), 'PTC retained environment')
      runtimes.add(provider)
    } catch {
      // 假对象或已销毁上下文不支持 effect 时静默退回插件级 dispose。
    }
  }

  return {
    owner(agent: unknown): object {
      const owner = typeof agent === 'object' && agent !== null ? agent : fallbackOwner
      // 释放过又回来的 owner（例如策略变更后重建常驻环境）必须重新可释放，
      // 否则它的新环境会活到进程结束。
      released.delete(owner)
      live.add(owner)
      if (owner !== fallbackOwner) bindAgentLifecycle(owner)
      return owner
    },
    release,
    async awaitPredecessors(agent: unknown, signal: AbortSignal): Promise<void> {
      const key = sessionKeyOf(agent)
      if (key !== undefined) {
        for (;;) {
          const reset = resets.get(key)
          if (reset !== undefined) {
            try {
              await reset.done
            } catch (error: unknown) {
              throw new CodeRunFailedError(
                'Program environment unavailable: ' + messageOf(error) + '. Ask the host to reset it before running more code.',
              )
            }
            continue
          }
          const pending = [...(calls.get(key) ?? [])].filter((call) => call.signal.aborted)
          if (pending.length === 0) break
          await Promise.all(pending.map((call) => call.done))
        }
      }
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'tool call aborted'))
      }
      if (disposed) throw new Error('PTC tool executor disposed')
    },
    trackRun(run: ActiveRunHandle): () => void {
      const key = sessionKeyOf(run.agent)
      if (key === undefined) return () => undefined
      let bucket = calls.get(key)
      if (bucket === undefined) {
        bucket = new Set()
        calls.set(key, bucket)
      }
      // 若同一次外层运行（同一个 controller）因常驻环境换策略重跑，原位更新生效 mode 即可，
      // 保持同一个 done Promise 直至外层 finally 彻底排空后再结算。
      for (const existing of bucket) {
        if (existing.controller === run.controller) {
          existing.mode = run.mode
          return () => {
            const current = calls.get(key)
            if (current !== undefined) {
              current.delete(existing)
              if (current.size === 0) calls.delete(key)
            }
            existing.resolveDone()
          }
        }
      }
      let resolveDone: () => void = () => undefined
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const record: TrackedCall = {
        controller: run.controller,
        signal: run.signal ?? run.controller.signal,
        ...(run.mode === undefined ? {} : { mode: run.mode }),
        done,
        resolveDone,
      }
      bucket.add(record)
      return () => {
        const current = calls.get(key)
        if (current !== undefined) {
          current.delete(record)
          if (current.size === 0) calls.delete(key)
        }
        record.resolveDone()
      }
    },
    cancelOnModeChange(session: unknown, event: unknown): void {
      if (typeof event !== 'object' || event === null) return
      const record = event as { readonly type?: unknown; readonly data?: unknown }
      if (record.type !== 'sandbox/mode') return
      const data = typeof record.data === 'object' && record.data !== null
        ? (record.data as { readonly mode?: unknown })
        : undefined
      const mode = data?.mode
      if (typeof mode !== 'string') return
      const key = sessionKeyOf(session)
      if (key === undefined) return
      for (const call of calls.get(key) ?? []) {
        if (call.mode !== undefined && call.mode !== mode) {
          call.controller.abort(new Error('sandbox mode changed'))
        }
      }
    },
    reset(agent: unknown, notify?: () => void): Promise<void> {
      if (disposed) return Promise.reject(new Error('PTC tool executor disposed'))
      const key = sessionKeyOf(agent) ?? fallbackOwner
      const previous = resets.get(key)
      if (previous !== undefined && !previous.settled) return previous.done
      let resolveDone: () => void = () => undefined
      let rejectDone: (reason: unknown) => void = () => undefined
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })
      // 防止调用方尚未 attach catch 时触发 unhandledRejection。
      done.catch(() => undefined)
      const resetRecord: TrackedReset = { done, settled: false }
      resets.set(key, resetRecord)
      const active = [...(calls.get(key) ?? [])]
      for (const call of active) {
        call.controller.abort(new Error('PTC environment reset'))
      }
      const owner = typeof agent === 'object' && agent !== null ? agent : fallbackOwner
      void Promise.allSettled([
        Promise.resolve().then(() => release(owner, { strict: true })),
        ...active.map((call) => call.done),
      ]).then((results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure !== undefined && failure.status === 'rejected') throw failure.reason
        notify?.()
      }).then(() => {
        resetRecord.settled = true
        resets.delete(key)
        resolveDone()
      }, (error: unknown) => {
        resetRecord.settled = true
        rejectDone(error)
      })
      return done
    },
    async dispose(): Promise<void> {
      disposed = true
      const activeCalls = [...calls.values()].flatMap((bucket) => [...bucket])
      for (const call of activeCalls) {
        call.controller.abort(new Error('PTC tool executor disposed'))
      }
      await Promise.allSettled([
        ...activeCalls.map((call) => call.done),
        ...[...resets.values()].map((reset) => reset.done),
      ])
      const owners = [...live]
      await Promise.all(owners.map((owner) => release(owner)))
    },
  }
}

/**
 * 展开 Cordis 服务代理上的 `[symbols.original]` 链，定位原初 provider 对象。
 */
function unwrapOriginalProvider(runtime: object): object {
  let current: object = runtime
  for (let depth = 0; depth < 8; depth += 1) {
    let next: unknown
    for (const sym of Object.getOwnPropertySymbols(current)) {
      if (sym.description === CORDIS_ORIGINAL_DESCRIPTION) {
        next = (current as Record<symbol, unknown>)[sym]
        break
      }
    }
    if (typeof next !== 'object' || next === null || next === current) break
    current = next
  }
  return current
}

/**
 * 一个会话的身份键（优先用 `session.id`，无 id 时退回会话对象本身）。
 */
export function sessionKeyOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  const nested = (value as { readonly session?: unknown }).session
  const session = typeof nested === 'object' && nested !== null ? nested : value
  const id = (session as { readonly id?: unknown }).id
  if (typeof id === 'string' && id.length > 0) return id
  return session
}

/** 一个抛出值的消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 没有 agent 的调用（例如服务级直调）共用的 owner。 */
const fallbackOwner: object = Object.freeze({ kind: 'codemode-sessionless' })
