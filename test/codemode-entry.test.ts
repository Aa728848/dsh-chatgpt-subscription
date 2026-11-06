// @vitest-environment node
/**
 * Code Mode 入口的会话授权契约（回归：DSH 0.2.2 的 `run requires a resolved sandbox policy`）。
 *
 * 内核从 0.2.2 起把「解析」与「执行」拆开，`run()` 只接受 `resolve()` 的产物。传输层若直接
 * 把原始请求喂给 `run()`，dispatch 预设里每次 `code_run` 都会失败。这里用一条按同样契约校验
 * 的假运行时把这条边界钉住，并检查策略确实来自**会话**而不是部署默认值。
 *
 * @module test/codemode-entry
 */

import { describe, expect, it } from 'vitest'

import { apply } from '../src/entry-codemode.ts'

/** 一个按内核契约校验「必须先 resolve」的假运行时。 */
function kernelRuntime(seen: { spec?: Record<string, unknown>; policyRequest?: Record<string, unknown> }[], deployment = 'read-only') {
  return {
    language: 'typescript',
    programFormat: 'function-body',
    resolve(request: Record<string, unknown>) {
      // 内核兜底：请求里没带策略时用部署默认值（这正是会话策略被悄悄换掉的路径）。
      return {
        ...request,
        sandboxPolicy: request['sandboxPolicy'] ?? { mode: deployment, workspaceRoot: 'C:/deployment' },
        cwd: request['cwd'] ?? 'C:/deployment',
        timeoutMs: 120_000,
      }
    },
    async run(spec: Record<string, unknown>) {
      // 内核 0.2.2 的原始拒绝：策略没解析就不许跑。
      if (spec['sandboxPolicy'] === undefined) throw new Error('ptc-runtime-node: run requires a resolved sandbox policy')
      seen.push({ spec })
      return { value: 'ok', logs: [] }
    },
  }
}

/** 装一个只够跑通 `code_run` 的 host 上下文（暴露给需要观察订阅的用例）。 */
function createContext(options: {
  runtime: unknown
  sandboxPolicy?: unknown
  workingDirectory?: unknown
  approval?: unknown
  execute?: (input: unknown) => Promise<unknown>
  waterfall?: unknown
  exposeExecutor?: boolean
}) {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const listeners: { event: string; listener: (...args: unknown[]) => unknown; options?: unknown }[] = []
  const disposers: (() => void)[] = []
  const executorRef: { value?: unknown } = {}
  const services: Record<string, unknown> = { ptcRuntime: options.runtime }
  if (options.sandboxPolicy !== undefined) services['sandboxPolicy'] = options.sandboxPolicy
  if (options.workingDirectory !== undefined) services['workingDirectory'] = options.workingDirectory
  if (options.approval !== undefined) services['approval'] = options.approval
  const tools: Record<string, unknown> = {
    register(definition: { name: string }) {
      registered.push(definition as never)
      return () => undefined
    },
    get: () => undefined,
    execute: options.execute ?? (async () => ({ results: [] })),
  }
  if (options.exposeExecutor === true) {
    tools['setExecutor'] = (executor: unknown) => {
      executorRef.value = executor
      return () => undefined
    }
  }
  const ctx: Record<string, unknown> = {
    tools,
    get: (name: string) => services[name],
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    on(event: string, listener: (...args: unknown[]) => unknown, listenerOptions?: unknown) {
      listeners.push({ event, listener, options: listenerOptions })
      return () => undefined
    },
    effect(callback: () => unknown) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    },
  }
  if (options.waterfall !== undefined) ctx['waterfall'] = options.waterfall
  apply(ctx, {})
  return { ctx, registered, listeners, disposers, executor: executorRef.value }
}

/** 轮询等待某个条件成立（避免用固定时长的 sleep 猜时序）。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('timed out waiting for the expected state')
}

/** 装一个只够跑通 `code_run` 的 host 上下文。 */
function mount(options: {
  runtime: unknown
  sandboxPolicy?: unknown
  workingDirectory?: unknown
  approval?: unknown
}) {
  const { registered } = createContext(options)
  const definition = registered.find((entry) => entry.name === 'code_run')
  if (definition === undefined) throw new Error('code_run was not registered')
  return definition
}

/** 一次调用要用的执行上下文（会话 + 信号）。 */
const session = { id: 'session-1', header: { cwd: 'C:/work' } }
function exec() {
  return { callId: 'call-1', signal: new AbortController().signal, agent: { session } }
}

describe('Code Mode 入口的会话授权', () => {
  it('把会话策略与工作目录解析进 spec，run() 不再收到未解析请求', async () => {
    const seen: { spec?: Record<string, unknown> }[] = []
    const policyRequests: unknown[] = []
    const definition = mount({
      runtime: kernelRuntime(seen),
      sandboxPolicy: {
        resolve(request: unknown) {
          policyRequests.push(request)
          return { mode: 'workspace-write', workspaceRoot: 'C:/work', sessionId: 'session-1' }
        },
      },
      workingDirectory: { ensure: async () => 'C:/work/sub' },
    })
    const output = await definition.execute({ code: 'return 1', description: 'policy check' }, exec())
    expect(output).toMatchObject({ result: 'ok' })
    // 策略必须按会话解析：部署默认值 read-only 不能顶替会话的 workspace-write。
    expect(policyRequests).toEqual([{ session }])
    expect(seen[0]!.spec!['sandboxPolicy']).toMatchObject({ mode: 'workspace-write', sessionId: 'session-1' })
    expect(seen[0]!.spec!['cwd']).toBe('C:/work/sub')
  })

  it('内核服务缺失时退回运行时兜底，不因取不到授权而失败', async () => {
    const seen: { spec?: Record<string, unknown> }[] = []
    const definition = mount({ runtime: kernelRuntime(seen) })
    const output = await definition.execute({ code: 'return 1', description: 'fallback' }, exec())
    expect(output).toMatchObject({ result: 'ok' })
    // 旧部署的兜底仍是部署默认值，但程序跑得起来。
    expect(seen[0]!.spec!['sandboxPolicy']).toMatchObject({ mode: 'read-only' })
  })

  it('单次沙箱提权经过宿主 approval 审批，拒绝时阻止程序运行', async () => {
    const seen: { spec?: Record<string, unknown> }[] = []
    const asked: Record<string, unknown>[] = []
    let decision: 'allowed-once' | 'rejected' = 'allowed-once'
    const definition = mount({
      runtime: kernelRuntime(seen),
      sandboxPolicy: {
        resolve: () => ({ mode: 'read-only', workspaceRoot: 'C:/work', sessionId: 'session-1' }),
      },
      approval: {
        async request(req: Record<string, unknown>) {
          asked.push(req)
          return decision
        },
      },
    })

    const output = await definition.execute({
      code: 'return 1',
      description: 'escalate check',
      sandbox_permissions: 'workspace-write',
      justification: 'write generated artifact',
    }, exec())
    expect(output).toMatchObject({ result: 'ok' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      toolName: 'code_run',
      reason: 'escalate sandbox to workspace-write: write generated artifact',
    })
    expect(seen[0]!.spec!['sandboxPolicy']).toMatchObject({ mode: 'workspace-write', sessionId: 'session-1' })

    decision = 'rejected'
    await expect(definition.execute({
      code: 'return 1',
      description: 'escalate denied',
      sandbox_permissions: 'danger-full-access',
      justification: 'inspect host root',
    }, exec())).rejects.toThrow(/rejected escalating this program/)
  })

  it('会话切沙箱模式时取消生效模式已不匹配的在飞运行', async () => {
    let started = false
    // 一轮「永远不会自己结束」的运行：只有取消才能让它停。
    const hangingRuntime = {
      language: 'typescript',
      programFormat: 'function-body',
      resolve: (request: Record<string, unknown>) => ({
        ...request,
        sandboxPolicy: request['sandboxPolicy'] ?? { mode: 'read-only' },
      }),
      run(spec: Record<string, unknown>) {
        started = true
        const signal = spec['signal'] as AbortSignal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted: ' + String(signal.reason))), { once: true })
        })
      },
    }
    const { registered, listeners } = createContext({
      runtime: hangingRuntime,
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    })
    const definition = registered.find((entry) => entry.name === 'code_run')
    if (definition === undefined) throw new Error('code_run was not registered')
    const pending = definition.execute({ code: 'return 1', description: 'mode change' }, exec())
    await waitFor(() => started)
    // 前台会话事件：必须带 global，否则别的会话切模式时这里收不到。
    const subscribed = listeners.find((entry) => entry.event === 'session/event')
    expect(subscribed).toBeDefined()
    expect(subscribed!.options).toMatchObject({ global: true })
    subscribed!.listener(session, { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    await expect(pending).rejects.toThrow(/sandbox mode changed/)
  })

  it('tools/ptc-dispatch-log 瀑布改写回放内容；监听器失败时回落到原始内容', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = []
    const appendSession = {
      id: 'session-1',
      append(type: string, data: Record<string, unknown>) { events.push({ type, data }) },
    }
    const calls: { event: string; dispatch: unknown }[] = []
    let mode: 'shape' | 'throw' = 'shape'
    const waterfall = async (_receiver: unknown, event: string, dispatch: unknown) => {
      calls.push({ event, dispatch })
      if (mode === 'throw') throw new Error('spill backend down')
      return [{ type: 'text', text: 'preview: a.ts' }]
    }
    const runtime = {
      language: 'typescript',
      programFormat: 'function-body',
      resolve: (request: Record<string, unknown>) => ({
        ...request,
        sandboxPolicy: request['sandboxPolicy'] ?? { mode: 'read-only' },
      }),
      async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        const value = await spec.bindings[0]!.functions['read']!({ file_path: 'a.ts' })
        return { value, logs: [] }
      },
    }
    const { registered, executor } = createContext({
      runtime,
      exposeExecutor: true,
      waterfall,
      execute: async (input: unknown) => {
        const batch = input as { calls: readonly { id: string }[] }
        return {
          results: batch.calls.map((call) => ({
            callId: call.id,
            result: { isError: false, value: 'body', content: [{ type: 'text', text: 'body' }] },
          })),
        }
      },
    })
    const describe = (executor as { describe(tools: readonly unknown[]): unknown }).describe.bind(executor)
    describe([{ name: 'read', description: 'read a file', parameters: {}, isConcurrencySafe: () => true }])
    const definition = registered.find((entry) => entry.name === 'code_run')
    if (definition === undefined) throw new Error('code_run was not registered')
    const runExec = (callId: string) => ({ callId, signal: new AbortController().signal, agent: { session: appendSession } })

    expect(await definition.execute({ code: 'return 1', description: 'waterfall' }, runExec('call-1')))
      .toMatchObject({ result: 'body' })
    expect(calls[0]!.event).toBe('tools/ptc-dispatch-log')
    expect(calls[0]!.dispatch).toMatchObject({ name: 'read', isError: false, arguments: { file_path: 'a.ts' } })
    const settle = events.filter((event) => event.type === 'tool/ptc-dispatch')
    expect(settle).toHaveLength(1)
    // 日志副本被换成了监听器给的内容；程序拿到的值不受影响。
    expect(settle[0]!.data['content']).toEqual([{ type: 'text', text: 'preview: a.ts' }])

    events.length = 0
    mode = 'throw'
    expect(await definition.execute({ code: 'return 1', description: 'waterfall fallback' }, runExec('call-2')))
      .toMatchObject({ result: 'body' })
    const fallback = events.filter((event) => event.type === 'tool/ptc-dispatch')
    expect(fallback).toHaveLength(1)
    expect(fallback[0]!.data['content']).toEqual([{ type: 'text', text: 'body' }])
  })
})