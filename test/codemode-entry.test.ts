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

/** 装一个只够跑通 `code_run` 的 host 上下文。 */
function mount(options: {
  runtime: unknown
  sandboxPolicy?: unknown
  workingDirectory?: unknown
  approval?: unknown
}) {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
  const services: Record<string, unknown> = { ptcRuntime: options.runtime }
  if (options.sandboxPolicy !== undefined) services['sandboxPolicy'] = options.sandboxPolicy
  if (options.workingDirectory !== undefined) services['workingDirectory'] = options.workingDirectory
  if (options.approval !== undefined) services['approval'] = options.approval
  const ctx = {
    tools: {
      register(definition: { name: string }) {
        registered.push(definition as never)
        return () => undefined
      },
      get: () => undefined,
      execute: async () => ({ results: [] }),
    },
    get: (name: string) => services[name],
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
  }
  apply(ctx, {})
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
})