/**
 * 常驻执行环境的生命周期。
 *
 * 部署把 `@deepseek-ai/dsh-ptc-runtime-node` 配成 `executionMode: persistent-in-memory` 时，
 * 同一个 agent 的多次 `code_run` 会共用一个常驻 REPL：顶层变量、函数与 `import` 的模块
 * 跨调用存活。可以不去用，但**不能只注册不释放**——常驻环境没有空闲过期，忘了释放会让子进程
 * 活到进程结束。
 *
 * 所以这里把「传了 owner」与「注册了释放」写进同一个动作：结构性无法表达「传了却没释放」。
 * 清理有两条路，覆盖两种死亡：
 *
 * 1. 挂在 **agent** 上的释放：即使本包早已卸载，agent 销毁也会释放它的环境；
 * 2. 挂在**插件**上的 teardown：卸载或热重载本包时释放所有遗留环境。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/retention
 */

import type { PtcRuntimeLike } from './transport.ts'

/** 常驻环境管理句柄。 */
export interface CodemodeRetention {
  /** 取一个 agent 的 owner（缺省用 agent 本身，保证同一 agent 复用一个环境）。 */
  owner(agent: unknown): object
  /** 释放一个 owner 的常驻环境（幂等）。 */
  release(owner: object): Promise<void>
  /** 释放所有遗留环境（插件卸载时调用）。 */
  dispose(): Promise<void>
}

/**
 * 造一个常驻环境管理器。
 *
 * @param runtimeOf - 读当前运行时的函数（每次调用重读，运行时可能晚于本插件挂载）。
 * @returns 管理句柄。
 */
export function createRetention(runtimeOf: () => PtcRuntimeLike | undefined): CodemodeRetention {
  const live = new Set<object>()
  const released = new WeakSet<object>()

  const release = async (owner: object): Promise<void> => {
    if (released.has(owner)) return
    released.add(owner)
    live.delete(owner)
    const runtime = runtimeOf()
    if (runtime?.release === undefined) return
    try {
      await runtime.release(owner)
    } catch {
      // 释放失败不该让调用方看到异常：环境已经标记为 released，重试没有意义。
    }
  }

  return {
    owner(agent: unknown): object {
      const owner = typeof agent === 'object' && agent !== null ? agent : fallbackOwner
      // 释放过又回来的 owner（例如策略变更后重建常驻环境）必须重新可释放，
      // 否则它的新环境会活到进程结束。
      released.delete(owner)
      live.add(owner)
      return owner
    },
    release,
    async dispose(): Promise<void> {
      const owners = [...live]
      await Promise.all(owners.map((owner) => release(owner)))
    },
  }
}

/** 没有 agent 的调用（例如服务级直调）共用的 owner。 */
const fallbackOwner: object = Object.freeze({ kind: 'codemode-sessionless' })
