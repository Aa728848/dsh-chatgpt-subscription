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

import { apply, resolveHostPtcRuntimeClasses } from '../../src/entries/codemode.ts'
import { PTC_IMAGE_TAG, PtcImageLike, SandboxEscalationError } from '../../src/host/runtime/codemode/transport.ts'

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
  attachments?: unknown
  fs?: unknown
  execute?: (input: unknown) => Promise<unknown>
  waterfall?: unknown
  exposeExecutor?: boolean
}) {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const listeners: { event: string; listener: (...args: unknown[]) => unknown; options?: unknown }[] = []
  const disposers: (() => void)[] = []
  const executorRef: { value?: unknown } = {}
  let seededCatalog: readonly unknown[] = []
  const services: Record<string, unknown> = { ptcRuntime: options.runtime }
  if (options.sandboxPolicy !== undefined) services['sandboxPolicy'] = options.sandboxPolicy
  if (options.workingDirectory !== undefined) services['workingDirectory'] = options.workingDirectory
  if (options.approval !== undefined) services['approval'] = options.approval
  if (options.attachments !== undefined) services['attachments'] = options.attachments
  if (options.fs !== undefined) services['fs'] = options.fs
  const tools: Record<string, unknown> = {
    register(definition: { name: string }) {
      registered.push(definition as never)
      return () => undefined
    },
    get: () => undefined,
    execute: options.execute ?? (async () => ({ results: [] })),
  }
  if (options.exposeExecutor === true) {
    tools['setRoot'] = (registry: { include?(source: unknown): () => void; getAll?(scope?: unknown): readonly unknown[] }) => {
      registry.include?.({
        get: (name: string) => seededCatalog.find((entry) => (entry as { name?: unknown })?.name === name),
        getAll: () => seededCatalog,
      })
      executorRef.value = {
        describe(defs: readonly unknown[]) {
          seededCatalog = defs
          return registry.getAll?.()
        },
        registry,
      }
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
  attachments?: unknown
  fs?: unknown
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

  it('cua 截图（无路径字段）通过 3 参数 resolveImageAttachmentAccess(attachments, mapHostPath, ref) 构造 PtcImageLike', async () => {
    const imgRef = {
      kind: 'image-attachment' as const,
      attachmentId: 'sha256:cua_shot_1',
      mediaType: 'image/png' as const,
      width: 1280,
      height: 720,
      byteLength: 4096,
    }
    const receivedImages: unknown[] = []
    let inspectOutput = true
    const hostSeenPaths: string[] = []
    const runtime = {
      language: 'typescript',
      programFormat: 'scoped-repl',
      executionInstructions: 'Use inspect(...values) to display output. Do not use console.',
      resolve: (request: Record<string, unknown>) => ({
        ...request,
        sandboxPolicy: request['sandboxPolicy'] ?? { mode: 'read-only' },
      }),
      async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        const cua = spec.bindings[0]!.functions['cua']!
        const img = await cua({ action: 'screenshot' })
        receivedImages.push(img)
        return inspectOutput
          ? { output: [{ type: 'image' as const, attachment: imgRef }] }
          : { output: [] }
      },
    }
    const { registered, executor } = createContext({
      runtime,
      exposeExecutor: true,
      attachments: {
        imageHostPath: (ref: { attachmentId: string }) => {
          hostSeenPaths.push(ref.attachmentId)
          return 'C:/dsh-home/attachments/cua_shot_1.png'
        },
      },
      fs: {
        processPathFromHostPath: (hostPath: string) =>
          hostPath.replace('C:/dsh-home/attachments', '/sandbox/attachments'),
      },
      execute: async () => ({
        results: [{
          callId: 'sub-1',
          // cua 返回没有 path 字段，也没有 file_path 入参
          result: { isError: false, value: { ok: true }, content: [{ type: 'image', attachment: imgRef }] },
        }],
      }),
    })
    const describe = (executor as { describe(tools: readonly unknown[]): unknown }).describe.bind(executor)
    describe([{ name: 'cua', description: 'computer use', parameters: {} }])
    const codeRun = registered.find((entry) => entry.name === 'code_run')!
    const deferred: unknown[] = []

    await codeRun.execute(
      { code: 'const shot = await tools.cua({ action: "screenshot" }); inspect(shot)', description: 'cua image' },
      { callId: 'c-cua-1', signal: new AbortController().signal, agent: { session }, deferContext: (msg: unknown) => deferred.push(msg) },
    )
    expect(hostSeenPaths).toEqual(['sha256:cua_shot_1'])
    expect(receivedImages).toHaveLength(1)
    const ptcRuntime = await import('@deepseek-ai/dsh-ptc-runtime').catch(() => undefined)
    const HostPtcImage = (ptcRuntime as { PtcImage?: new (...args: unknown[]) => unknown } | undefined)?.PtcImage
    const imageHandle = receivedImages[0] as { path: string; attachment: { width: number; height: number } }
    if (typeof HostPtcImage === 'function') {
      expect(imageHandle).toBeInstanceOf(HostPtcImage)
    } else {
      expect(imageHandle).toBeInstanceOf(PtcImageLike)
      expect((imageHandle as unknown as Record<symbol, unknown>)[PTC_IMAGE_TAG]).toBe(true)
    }
    expect(imageHandle.path).toBe('/sandbox/attachments/cua_shot_1.png')
    expect(imageHandle.attachment.width).toBe(1280)
    expect(imageHandle.attachment.height).toBe(720)
    // 已被 inspect 显式输出的图片不再通过 deferContext 重复注入
    expect(deferred).toEqual([])

    inspectOutput = false
    await codeRun.execute(
      { code: 'await tools.cua({ action: "screenshot" })', description: 'cua forgot inspect' },
      { callId: 'c-cua-2', signal: new AbortController().signal, agent: { session }, deferContext: (msg: unknown) => deferred.push(msg) },
    )
    // 程序拿到了一等公民 PtcImageLike 但漏了 inspect，兜底通过 deferContext 补发给下一轮
    expect(deferred).toHaveLength(1)
  })

  it('escalateSandbox 抛出对齐上游的 SandboxEscalationError 结构化错误码', async () => {
    let decision: 'rejected' | 'cancelled' | 'unavailable' = 'rejected'
    const standing = { mode: 'workspace-write', workspaceRoot: 'C:/work' }
    const makeRuntime = () => ({
      language: 'typescript',
      programFormat: 'scoped-repl',
      sandboxMode: 'workspace-write',
      resolve: (request: Record<string, unknown>) => ({ ...request, sandboxPolicy: request['sandboxPolicy'] ?? standing }),
      async run() { return { output: [] } },
    })

    // 1. 缺 approval 服务 -> SANDBOX_ESCALATION_UNAVAILABLE
    const noApproval = mount({
      runtime: makeRuntime(),
      sandboxPolicy: { resolve: () => standing },
    })
    await expect(noApproval.execute({
      code: '1',
      description: 'no approval',
      sandbox_permissions: 'danger-full-access',
      justification: 'need write',
    }, exec())).rejects.toMatchObject({
      name: 'SandboxEscalationError',
      code: 'SANDBOX_ESCALATION_UNAVAILABLE',
    })

    // 2. 非严格加宽 -> SANDBOX_ESCALATION_INVALID_ARGUMENT
    const withApproval = mount({
      runtime: makeRuntime(),
      sandboxPolicy: { resolve: () => standing },
      approval: { async request() { return decision } },
    })
    await expect(withApproval.execute({
      code: '1',
      description: 'not wider',
      sandbox_permissions: 'workspace-write',
      justification: 'need write',
    }, { callId: 'call-same', signal: new AbortController().signal, agent: { session } })).resolves.toMatchObject({ logs: [] })

    // read-only 下允许提权，workspace-write 下传未知目标由 validateEscalationArgs 拒绝
    await expect(withApproval.execute({
      code: '1',
      description: 'bad mode',
      sandbox_permissions: 'read-only',
      justification: 'downgrade',
    }, exec())).rejects.toSatisfy((err: unknown) =>
      err instanceof SandboxEscalationError && err.code === 'SANDBOX_ESCALATION_INVALID_ARGUMENT')

    // 3. rejected / cancelled / unavailable -> 各自精确错误码
    decision = 'rejected'
    await expect(withApproval.execute({
      code: '1',
      description: 'rejected',
      sandbox_permissions: 'danger-full-access',
      justification: 'need full',
    }, exec())).rejects.toMatchObject({ name: 'SandboxEscalationError', code: 'SANDBOX_ESCALATION_REJECTED' })

    decision = 'cancelled'
    await expect(withApproval.execute({
      code: '1',
      description: 'cancelled',
      sandbox_permissions: 'danger-full-access',
      justification: 'need full',
    }, exec())).rejects.toMatchObject({ name: 'SandboxEscalationError', code: 'SANDBOX_ESCALATION_CANCELLED' })

    decision = 'unavailable'
    await expect(withApproval.execute({
      code: '1',
      description: 'unavailable',
      sandbox_permissions: 'danger-full-access',
      justification: 'need full',
    }, exec())).rejects.toMatchObject({ name: 'SandboxEscalationError', code: 'SANDBOX_ESCALATION_UNAVAILABLE' })
  })

  it('0.2.3: entry-codemode 使用宿主真实 PtcInspectableValue 与嵌套 PtcImage 实例', async () => {
    const imgRef = {
      attachmentId: 'sha256:nested_shot',
      mediaType: 'image/png',
      width: 800,
      height: 600,
      bytes: 12345,
    }
    const received: Record<string, unknown> = {}
    const runtime = {
      language: 'typescript',
      programFormat: 'scoped-repl',
      executionInstructions: 'Call inspect(value) to show output or images.',
      resolve: (request: Record<string, unknown>) => ({
        ...request,
        sandboxPolicy: request['sandboxPolicy'] ?? { mode: 'read-only' },
      }),
      async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        received['summary'] = await spec.bindings[0]!.functions['get_summary']!({})
        received['gallery'] = await spec.bindings[0]!.functions['get_gallery']!({})
        return { output: [] }
      },
    }
    const { registered, executor } = createContext({
      runtime,
      exposeExecutor: true,
      attachments: {
        imageHostPath: () => 'C:/dsh-home/attachments/nested_shot.png',
      },
      fs: {
        processPathFromHostPath: (hostPath: string) =>
          hostPath.replace('C:/dsh-home/attachments', '/sandbox/attachments'),
      },
      execute: async (input: unknown) => {
        const request = input as { calls: Array<{ callId: string; name: string }> }
        return {
          results: request.calls.map((call) => {
            if (call.name === 'get_summary') {
              return {
                callId: call.callId,
                result: {
                  isError: false,
                  value: { files: 4, ok: true },
                  content: [{ type: 'text', text: '4 files ok' }],
                },
              }
            }
            return {
              callId: call.callId,
              result: {
                isError: false,
                value: { items: [{ type: 'image', attachment: imgRef }] },
                content: [{ type: 'image', attachment: imgRef }],
              },
            }
          }),
        }
      },
    })
    const describe = (executor as { describe(tools: readonly unknown[]): unknown }).describe.bind(executor)
    describe([
      { name: 'get_summary', description: 'summary', parameters: {} },
      { name: 'get_gallery', description: 'gallery', parameters: {} },
    ])
    const codeRun = registered.find((entry) => entry.name === 'code_run')!
    const deferred: unknown[] = []
    await codeRun.execute(
      { code: 'await tools.get_summary({}); await tools.get_gallery({})', description: 'real ptc classes' },
      { callId: 'c-real-ptc', signal: new AbortController().signal, agent: { session }, deferContext: (m: unknown) => deferred.push(m) },
    )

    const ptcRuntime = await import('@deepseek-ai/dsh-ptc-runtime').catch(() => undefined) as {
      PtcImage?: new (...args: unknown[]) => unknown
      PtcInspectableValue?: new (...args: unknown[]) => unknown
    } | undefined

    if (typeof ptcRuntime?.PtcInspectableValue === 'function') {
      expect(received['summary']).toBeInstanceOf(ptcRuntime.PtcInspectableValue)
      expect((received['summary'] as { value: unknown; text: string }).value).toEqual({ files: 4, ok: true })
      expect((received['summary'] as { value: unknown; text: string }).text).toBe('4 files ok')
    } else {
      expect(received['summary']).toEqual({ files: 4, ok: true })
    }

    const galleryItem = (received['gallery'] as { items: unknown[] }).items[0]
    if (typeof ptcRuntime?.PtcImage === 'function') {
      expect(galleryItem).toBeInstanceOf(ptcRuntime.PtcImage)
    } else {
      expect(galleryItem).toBeInstanceOf(PtcImageLike)
    }
    expect((galleryItem as { path: string }).path).toBe('/sandbox/attachments/nested_shot.png')
    // 嵌套图片未被 inspect，自动通过 deferContext 兜底补发
    expect(deferred).toHaveLength(1)
  })

  it('0.2.3 回归：异源 PtcRuntime 副本绝不注入插件自有 PtcInspectableValue/PtcImage（杜绝 binding resolution must be lossless JSON）', async () => {
    // 模拟真实宿主从独立目录加载了另一份 PtcRuntime（如 Junction 链接插件时插件与宿主各有副本）
    class PtcRuntime {}
    class ForeignNodePtcRuntime extends PtcRuntime {
      readonly language = 'typescript'
      readonly programFormat = 'scoped-repl'
      readonly executionInstructions = 'Call inspect(value) to show output or images.'
      resolve(request: Record<string, unknown>) {
        return { ...request, sandboxPolicy: request['sandboxPolicy'] ?? { mode: 'read-only' } }
      }
      async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
        // 严格模拟 ptc-runtime-node/src/bindings.ts 的 lossless JSON 校验：拒绝所有非 plain object 类实例
        const assertLossless = (val: unknown): void => {
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            const proto = Object.getPrototypeOf(val)
            if (proto !== Object.prototype && proto !== null) {
              throw new Error('binding resolution must be lossless JSON')
            }
          }
        }
        const summary = await spec.bindings[0]!.functions['win_bash']!({})
        assertLossless(summary)
        const shot = await spec.bindings[0]!.functions['read_image']!({ file_path: 'a.png' })
        assertLossless(shot)
        return { output: [{ type: 'text' as const, text: JSON.stringify(summary) }] }
      }
    }

    const foreignRuntime = new ForeignNodePtcRuntime()
    // 1. 铁闸校验必须拒绝异源副本，返回 hostMatched: false 且不暴露异源类
    const classes = await resolveHostPtcRuntimeClasses(foreignRuntime)
    expect(classes.hostMatched).toBe(false)
    expect(classes.PtcInspectableValue).toBeUndefined()
    expect(classes.PtcImage).toBeUndefined()

    // 2. 端到端运行：工具返回对象+纯文本时不包装异源 PtcInspectableValue；图片工具安全退回 deferContext
    const imgRef = {
      attachmentId: 'sha256:foreign_shot',
      mediaType: 'image/png',
      width: 640,
      height: 480,
      bytes: 4096,
    }
    const { registered, executor } = createContext({
      runtime: foreignRuntime,
      exposeExecutor: true,
      attachments: { imageHostPath: () => 'C:/dsh-home/attachments/foreign_shot.png' },
      fs: { processPathFromHostPath: (p: string) => p.replace('C:/dsh-home/attachments', '/sandbox/attachments') },
      execute: async (input: unknown) => {
        const req = input as { calls: Array<{ callId: string; name: string }> }
        return {
          results: req.calls.map((call) => call.name === 'win_bash'
            ? { callId: call.callId, result: { isError: false, value: { exitCode: 0, stdout: 'ok' }, content: [{ type: 'text', text: 'ok' }] } }
            : { callId: call.callId, result: { isError: false, value: { path: 'a.png' }, content: [{ type: 'image', attachment: imgRef }] } }),
        }
      },
    })
    const describe = (executor as { describe(tools: readonly unknown[]): unknown }).describe.bind(executor)
    describe([
      { name: 'win_bash', description: 'shell', parameters: {} },
      { name: 'read_image', description: 'image', parameters: {} },
    ])
    const codeRun = registered.find((entry) => entry.name === 'code_run')!
    const deferred: unknown[] = []
    const out = await codeRun.execute(
      { code: 'await tools.win_bash({}); await tools.read_image({ file_path: "a.png" })', description: 'foreign runtime' },
      { callId: 'c-foreign', signal: new AbortController().signal, agent: { session }, deferContext: (m: unknown) => deferred.push(m) },
    ) as { logs: string[] }
    expect(out.logs).toEqual(['{"exitCode":0,"stdout":"ok"}'])
    // 异源运行时下图片未转成异源 PtcImageLike，而是通过 deferContext 零丢图兜底
    expect(deferred).toHaveLength(1)

    // 3. 当 runtime 确实继承自宿主同源 PtcRuntime（且经 Cordis 代理包装）时，通过 instanceof 铁闸返回同源类
    const ptcMod = await import('@deepseek-ai/dsh-ptc-runtime').catch(() => undefined) as {
      PtcRuntime?: new (...args: unknown[]) => object
      PtcImage?: unknown
      PtcInspectableValue?: unknown
    } | undefined
    if (typeof ptcMod?.PtcRuntime === 'function') {
      const sameOrigin = Object.create(ptcMod.PtcRuntime.prototype) as object
      const proxied = { [Symbol('cordis.original')]: sameOrigin }
      const matched = await resolveHostPtcRuntimeClasses(proxied)
      expect(matched.hostMatched).toBe(true)
      expect(matched.PtcImage).toBe(ptcMod.PtcImage)
      expect(matched.PtcInspectableValue).toBe(ptcMod.PtcInspectableValue)
    }
  })

  it('0.2.3-alpha.3 真实 Cordis + ToolsService setRoot：遮蔽直呼由内核拒绝、程序内子调用走完整策略管线、tools:sdk 按 toolStep 渲染', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const SystemPromptMod = await import('@deepseek-ai/dsh-system-prompt')
    const SystemPrompt = SystemPromptMod.default ?? SystemPromptMod.SystemPrompt
    const toolsMod = await import('@deepseek-ai/dsh-tools')
    const ToolRuntime = toolsMod.default ?? toolsMod.ToolRuntime
    const defineTool = toolsMod.defineTool

    const ctx = new Context()
    try {
      try {
        const sessionProjectionPkg = '@deepseek-ai/dsh-session-projection'
        const projections = (await import(sessionProjectionPkg)) as {
          default?: unknown
          SessionProjections?: unknown
        }
        const SessionProjections = projections.default ?? projections.SessionProjections ?? projections
        if (SessionProjections) await (ctx.plugin as (plugin: unknown) => unknown)(SessionProjections)
      } catch {
        // 旧代 harness 无独立 session-projection 包。
      }
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const toolsService = ctx.tools as unknown as {
        setRoot?: unknown
        setExecutor?: unknown
        getAll?(scope?: unknown): readonly { name: string }[]
        execute(input: unknown): Promise<{ results: readonly { callId: string; result: { isError: boolean; value?: unknown; error?: { info?: { code?: unknown } } } }[] }>
        guard(fn: (exec: { name: string; arguments: Record<string, unknown> }) => string | undefined): () => void
        register(def: unknown): () => void
      }
      if (typeof toolsService.setRoot !== 'function') return

      const maskedCalls: unknown[] = []
      const preExecuteSeen: string[] = []
      toolsService.register(defineTool({
        name: 'read',
        description: 'Read a file.',
        parameters: { path: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute(args: { path: string }) {
          maskedCalls.push(args)
          return Promise.resolve(`content:${args.path}`)
        },
      }))
      toolsService.register(defineTool({
        name: 'progress_update',
        description: 'Report progress.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: () => Promise.resolve('ok'),
      }))

      let runtimeCallResult: unknown
      let guardDeniedMessage: string | undefined
      const fakeRuntime = {
        language: 'typescript',
        programFormat: 'function-body',
        resolve: (req: Record<string, unknown>) => ({ ...req, sandboxPolicy: { mode: 'read-only' }, timeoutMs: 60_000 }),
        async run(spec: { bindings: readonly { functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) {
          runtimeCallResult = await spec.bindings[0]!.functions['read']!({ path: 'ok.ts' })
          try {
            await spec.bindings[0]!.functions['read']!({ path: 'secret.env' })
          } catch (error) {
            guardDeniedMessage = error instanceof Error ? error.message : String(error)
          }
          return { value: runtimeCallResult, logs: [] }
        },
      }
      ctx.provide('ptcRuntime' as never, fakeRuntime as never)

      // 挂一条宿主策略与一条单调守卫，确认程序内子调用完整经过 ToolExecutionPipeline
      ctx.on('tools/pre-execute' as never, (async (exec: { name: string }, next: () => Promise<unknown>) => {
        preExecuteSeen.push(exec.name)
        return next()
      }) as never)
      toolsService.guard((exec) =>
        exec.name === 'read' && exec.arguments['path'] === 'secret.env' ? 'blocked secret file' : undefined)

      apply(ctx, { nativeToolsOnly: true, nativeTools: ['progress_update'] })

      const fakeAgent = { id: 'agent-1', ctx, session: { id: 'sess-1', append: () => undefined } }
      // 1. 仅原生白名单与 code_run 暴露在模型工具表，read 与发现工具被遮蔽（且绝不抛 ToolCompositionError）
      const visibleNames = toolsService.getAll!(fakeAgent).map((d) => d.name)
      expect(visibleNames).toContain('code_run')
      expect(visibleNames).toContain('progress_update')
      expect(visibleNames).not.toContain('read')
      expect(visibleNames).not.toContain('code_tools_search')

      const pipelinePkg = '@deepseek-ai/dsh-tools/pipeline'
      const pipelineMod = (await import(pipelinePkg)) as {
        ToolStep: { capture(tools: unknown, agent: unknown): unknown }
      }
      const step = pipelineMod.ToolStep.capture(toolsService, fakeAgent)

      // 2. 系统提示词在声明了 code_run 的 toolStep 下输出 tools:sdk 段
      const assembled = await ctx.systemPrompt.assemble({ scope: fakeAgent as never, toolStep: step as never } as never)
      const sdk = assembled.sections.find((s) => s.name === 'tools:sdk')
      expect(sdk?.text).toContain('code_run')

      // 3. 模型直呼被遮蔽工具 read：内核在 pre-execute 之前直接以 UNKNOWN_TOOL 拒绝
      const directDenied = await toolsService.execute({
        calls: [{ type: 'tool-call', id: 'c-direct', name: 'read', arguments: JSON.stringify({ path: 'ok.ts' }) }],
        signal: new AbortController().signal,
        agent: fakeAgent,
        toolStep: step,
      })
      expect(directDenied.results[0]?.result.isError).toBe(true)
      expect(directDenied.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
      expect(maskedCalls).toEqual([])

      // 4. 通过 code_run 程序内调用 read：走真实 ToolExecutionPipeline，放行 ok.ts 且守卫拦截 secret.env
      const nested = await toolsService.execute({
        calls: [{
          type: 'tool-call',
          id: 'c-code',
          name: 'code_run',
          arguments: JSON.stringify({ code: 'return await tools.read({ path: "ok.ts" })', description: 'read inside code' }),
        }],
        signal: new AbortController().signal,
        agent: fakeAgent,
        toolStep: step,
      })
      expect(nested.results[0]?.result.isError).toBe(false)
      expect(runtimeCallResult).toBe('content:ok.ts')
      expect(maskedCalls).toEqual([{ path: 'ok.ts' }])
      expect(preExecuteSeen).toContain('read')
      expect(guardDeniedMessage).toContain('blocked secret file')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})