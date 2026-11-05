/**
 * Code Mode 的程序传输工具 `code_run`。
 *
 * 工具名不是 `run_code`：那个名字被内核保留（`tools.register()` 会抛错），所以本包
 * 用自己的名字注册同一件事——把模型写的一段程序交给 `ctx.ptcRuntime` 执行，程序里的每次
 * `tools.<name>(args)` 都是一次真实的工具调用。
 *
 * ## 为什么执行委托给注册表而不是自己跑管线
 *
 * 子调用走公开的 `ctx.tools.execute()`，因此落到**注册表选中的执行器**上：在本预设里就是
 * 原生 executor 的完整管线（pre-policy、审批、around-dispatch、post-execute 一个不少）。
 * 手写这条管线是插件静默丢策略的典型方式，所以这里一行都不抄。
 *
 * ## 子调度的取舍
 *
 * 程序自己用 `Promise.all` 决定并发。本模块只做一件额外的事：把 `isConcurrencySafe` 不为
 * `true` 的调用串行化成互斥段，只读调用放行到 `maxParallelSubCalls` 个并发。与内核的
 * 差别是「只排序同一程序内的子调用」，不与同一模型步的其它调用互相排序。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/transport
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { NESTED_CALL_ID_MARKER, markNested } from './executor.ts'
import type { CodemodeRules } from './rules.ts'

/**
 * 本次程序运行看到的工具清单快照。
 *
 * 绑定函数在程序开始那一刻按当时的清单建好，此后程序内**只能**调这份清单里的名字。检索却
 * 读的是执行器级的“最新清单”：同一预设下主代理与子代理并发时，另一个会话的一次装配就会把
 * 它覆盖掉，于是程序可能搜到一个自己调不到的名字（`tools.xxx is not a function`）。
 *
 * 用 AsyncLocalStorage 把快照挂到这次运行上，程序内的检索与绑定因此读同一份清单：搜得到
 * 就调得动，调不到就搜不到。
 */
const catalogScope = new AsyncLocalStorage<readonly CatalogEntry[]>()

/**
 * 读当前程序运行的清单快照。
 *
 * @returns 程序运行期间是这次运行的快照；程序之外为 `undefined`。
 */
export function currentCatalogSnapshot(): readonly CatalogEntry[] | undefined {
  return catalogScope.getStore()
}

/** 传输工具名（与 {@link DEFAULT_RUN_TOOL_NAME} 一致，导出方便测试引用）。 */
export const TRANSPORT_TOOL_NAME = 'code_run'

/** 程序里可调用的一个工具（结构描述，只读需要的字段）。 */
export interface CatalogEntry {
  /** 工具名。 */
  readonly name: string
  /** 面向模型的描述。 */
  readonly description: string
  /** 完整参数 JSON Schema。 */
  readonly parameters: unknown
  /** 并发分类（内核约定：只有 true 表示可并发）。 */
  readonly isConcurrencySafe?: (args: unknown) => boolean
}

/** 程序的运行环境句柄：由入口提供，传输层只调用。 */
export interface CodemodeHost {
  /** 当前可调用的工具清单（含被遮蔽的）。 */
  catalog(): readonly CatalogEntry[]
  /** 执行一次子调用（内部走 `ctx.tools.execute()`）。 */
  callTool(request: CallToolRequest): Promise<CallToolOutcome>
  /** 读 PTC 运行时（结构探测）。 */
  runtime(): PtcRuntimeLike | undefined
  /** 常驻环境的 owner（缺省用调用方 agent 当 owner）。 */
  stateOwner(agent: unknown): object
  /** 程序结束时释放 owner 的常驻环境。 */
  releaseOwner(owner: object): Promise<void>
}

/** 一次子调用请求。 */
export interface CallToolRequest {
  /** 工具名。 */
  readonly name: string
  /** 已校验的参数对象。 */
  readonly args: unknown
  /** 子调用 id（`<outer>:ptc:<n>`）。 */
  readonly callId: string
  /** 取消信号（已带嵌套标记）。 */
  readonly signal: AbortSignal
  /** 调用方 agent。 */
  readonly agent: unknown
  /** 步骤准入集合。 */
  readonly toolSet: unknown
}

/** 一次子调用的结果。 */
export interface CallToolOutcome {
  /** 失败时的错误文本。 */
  readonly error?: string
  /** 成功时的值。 */
  readonly value?: unknown
  /** 成功时的文本内容（没有 value 时用它）。 */
  readonly text?: string
}

/** PTC 运行时里本模块会读到的那部分（结构契约）。 */
export interface PtcRuntimeLike {
  /** 源码语言。 */
  readonly language?: string
  /** 程序形态。 */
  readonly programFormat?: string
  /** 超时预算。 */
  readonly timeout?: { readonly defaultMs: number; readonly maxMs: number }
  /** 常驻状态释放。 */
  release?(owner: object): Promise<void>
  /** 执行一段程序。 */
  run(request: {
    readonly program: string
    readonly bindings: readonly unknown[]
    readonly stateOwner?: object
    readonly timeoutMs?: number | null
    readonly signal?: AbortSignal
  }): Promise<PtcRunResultLike>
}

/** 一次程序运行的结果。 */
export interface PtcRunResultLike {
  /** 程序返回值。 */
  readonly value?: unknown
  /** 捕获的输出。 */
  readonly logs: readonly string[]
  /** 失败信息。 */
  readonly error?: { readonly kind: string; readonly message: string }
  /** 文件策略与观察到的拒绝。 */
  readonly sandbox?: { readonly mode: string; readonly denied: boolean }
}

/** 一次传输调用的规范化结果。 */
export interface TransportOutput {
  /** 程序捕获的输出。 */
  readonly logs: readonly string[]
  /** 程序返回值。 */
  readonly result?: unknown
  /** 文件沙箱观察。 */
  readonly sandbox?: { readonly mode: string; readonly denied: boolean }
}

/**
 * 造 `code_run` 的工具定义。
 *
 * @param host - 运行环境句柄。
 * @param rules - 已归一化的规则。
 * @returns 可直接交给 `ctx.tools.register()` 的原始定义。
 */
export function createTransportDefinition(host: CodemodeHost, rules: CodemodeRules) {
  const runToolName = rules.options.runToolName
  return {
    name: runToolName,
    description: 'Execute a TypeScript program against the available tools. Takes two required arguments: '
      + '`code`, the body of an async function (erasable syntax only; top-level await and return work), and '
      + '`description`, a short summary of what the program does. Call tools as `await tools.name(args)`. Only what you print or return is program output.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'description'],
      properties: {
        code: { type: 'string', description: 'The program: the body of an async TypeScript function.' },
        description: { type: 'string', description: 'Clear, concise description of what this program does in active voice, 5-10 words.' },
        timeoutMs: { type: 'number', description: 'Positive elapsed-time budget in milliseconds, capped by the runtime maximum.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['logs'],
        properties: {
          logs: { type: 'array', items: { type: 'string' } },
          result: {},
          sandbox: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'denied'],
            properties: { mode: { type: 'string' }, denied: { type: 'boolean' } },
          },
        },
      },
      render: (_args: unknown, value: TransportOutput) => {
        const parts: string[] = []
        for (const line of value.logs ?? []) if (line.length > 0) parts.push(line)
        if (value.result !== undefined) {
          try {
            parts.push(typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2))
          } catch {
            parts.push(String(value.result))
          }
        }
        if (value.sandbox?.denied === true) {
          parts.push('The ' + value.sandbox.mode + ' file sandbox denied an operation.')
        }
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(' + runToolName + ' completed with no output)' }]
      },
    },
    async execute(args: unknown, exec: TransportExecution): Promise<TransportOutput> {
      const input = readArguments(args)
      const runtime = host.runtime()
      if (runtime === undefined) {
        throw new Error('codemode: no PTC runtime is mounted (ctx.ptcRuntime); the program transport is unavailable')
      }
      const catalog = host.catalog()
      const runSignal = AbortSignal.any([exec.signal, new AbortController().signal])
      const nestedSignal = markNested(runSignal) ?? runSignal
      const owner = host.stateOwner(exec.agent)
      const limit = rules.options.maxSubCalls
      let attempts = 0
      const exclusive = createMutex()
      const definitions = new Map<string, CatalogEntry>()
      for (const entry of catalog) definitions.set(entry.name, entry)
      const functions: Record<string, (rawArgs: unknown) => Promise<unknown>> = {}
      for (const entry of catalog) {
        if (entry.name === runToolName) continue
        functions[entry.name] = async (rawArgs: unknown): Promise<unknown> => {
          const n = ++attempts
          if (n > limit) throw new Error('program sub-call limit exceeded: ' + String(limit) + ' calls')
          const parsed = losslessArgs(rawArgs)
          const callId = String(exec.callId) + NESTED_CALL_ID_MARKER + String(n)
          const run = async (): Promise<unknown> => {
            const outcome = await host.callTool({
              name: entry.name,
              args: parsed,
              callId,
              signal: nestedSignal,
              agent: exec.agent,
              toolSet: exec.toolSet,
            })
            if (outcome.error !== undefined) throw new Error(outcome.error)
            return outcome.value !== undefined ? outcome.value : outcome.text ?? null
          }
          return isConcurrencySafe(definitions.get(entry.name), parsed) ? run() : exclusive.run(run)
        }
      }
      const request = {
        program: input.code,
        bindings: [{ global: 'tools', functions }],
        stateOwner: owner,
        ...input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
        signal: nestedSignal,
      }
      let result: PtcRunResultLike
      try {
        // 快照只在这一段里可见：程序内的检索与绑定读同一份清单。
        result = await catalogScope.run(catalog, () => runtime.run(request))
      } finally {
        // 常驻环境不在每次调用后释放：它按 owner 存活到 agent 销毁或插件卸载。
      }
      if (result.error !== undefined) {
        throw new Error('program failed (' + result.error.kind + '): ' + result.error.message)
      }
      const output: TransportOutput = {
        logs: [...(result.logs ?? [])],
        ...result.value === undefined ? {} : { result: result.value },
        ...result.sandbox === undefined ? {} : { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied } },
      }
      return output
    },
  }
}

/** 一次传输调用的执行上下文（结构描述）。 */
export interface TransportExecution {
  /** 本次调用的 id。 */
  readonly callId: string
  /** 取消信号。 */
  readonly signal: AbortSignal
  /** 调用方 agent。 */
  readonly agent?: unknown
  /** 步骤准入集合。 */
  readonly toolSet?: unknown
}

/** 校验并读出工具参数。 */
function readArguments(args: unknown): { code: string; description: string; timeoutMs?: number } {
  if (typeof args !== 'object' || args === null) throw new Error('codemode: expected an arguments object')
  const record = args as Record<string, unknown>
  const code = record['code']
  const description = record['description']
  if (typeof code !== 'string' || code.trim().length === 0) throw new Error('codemode: invalid code: expected a non-empty string')
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('codemode: invalid description: expected a non-empty string')
  }
  const timeoutMs = record['timeoutMs']
  if (timeoutMs === undefined) return { code, description }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('codemode: invalid timeoutMs: expected a positive finite number')
  }
  return { code, description, timeoutMs }
}

/** 子调用参数必须是可无损 JSON 化的值。 */
function losslessArgs(value: unknown): unknown {
  if (value === undefined) return {}
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error('codemode: tool arguments must be lossless JSON')
  }
}

/** 一个工具的调用是否可以与兄弟调用重叠（只有明确 true 才算）。 */
function isConcurrencySafe(entry: CatalogEntry | undefined, args: unknown): boolean {
  if (entry === undefined || typeof entry.isConcurrencySafe !== 'function') return false
  try {
    return entry.isConcurrencySafe(args) === true
  } catch {
    return false
  }
}

/** 一个 FIFO 互斥段：写类调用串行执行。 */
function createMutex(): { run<T>(task: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task)
      tail = next.catch(() => undefined)
      return next
    },
  }
}
