/**
 * Code Mode 的程序传输工具 `code_run`。
 *
 * 工具名不是 `run_code`：那个名字被内核保留（`tools.register()` 会抛错），所以本包
 * 用自己的名字注册同一件事——把模型写的一段程序交给 `ctx.ptcRuntime` 执行，程序里的每次
 * `tools.<name>(args)` 都是一次真实的工具调用。
 *
 * ## 与内核 PTC `run_code` 对齐的使用配置
 *
 * 1. **运行时感知 Schema**：按 `ptcRuntime` 的语言（TypeScript / Python）、程序形态
 *    （`function-body` / 常驻 REPL）、超时预算（`defaultMs` / `maxMs`）与沙箱支持动态投影
 *    描述和参数（含单次提权的 `sandbox_permissions` + `justification`）；同一部署下静态恒定，
 *    不会扰动前缀缓存。
 * 2. **完整子调用调度与上下文转发**：只读并发上限受 `maxParallelSubCalls` 约束，写类调用等待
 *    在飞调用排空后独占执行；程序结算时中止悬空请求并等待已启动子调用落盘；子调用产生的图片块、
 *    `additionalContexts` 与 `concludesTurn` 原样转交给外层步骤。
 * 3. **展示元数据与输出格式化**：声明 `presentCall` 与 `output.presentationMeta`（记录语言），
 *    深层 JSON 结果控制缩进上限，失败时保留已捕获输出与沙箱诊断信息。
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

/** 允许单次提权的目标沙箱模式（对齐 `@deepseek-ai/dsh-sandbox` 的 `ESCALATION_TARGETS`）。 */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access'] as const)
export type EscalationTargetMode = (typeof ESCALATION_TARGETS)[number]

/** 与内核 `run_code` 一致的 `description` 参数说明。 */
const DESCRIPTION_PARAM_DESCRIPTION =
  'Clear, concise description of what this program does in active voice, '
  + '5-10 words (shown in the UI). '
  + 'Examples: "Count TODO markers across packages"; '
  + '"Read failing test and its fixture"; "Rename config key in every cordis.yml".'

/** 程序里可调用的一个工具（结构描述，只读需要的字段）。 */
export interface CatalogEntry {
  /** 工具名。 */
  readonly name: string
  /** 面向模型的描述。 */
  readonly description: string
  /** 完整参数 JSON Schema。 */
  readonly parameters: unknown
  /** 工具声明的输出 JSON Schema（没有声明时省略）。 */
  readonly output?: unknown
  /** 并发分类（内核约定：只有 true 表示可并发）。 */
  readonly isConcurrencySafe?: (args: unknown) => boolean
}

/**
 * 一次运行拿到的会话级授权。
 *
 * 两项都取自**会话**而不是部署默认值：文件策略决定程序拿到的沙盒模式与写根，目录决定程序
 * 从哪里开始（`cd` 过的会话不会退回初始目录）。取不到就留空，交给内核兜底。
 */
export interface RunAuthority {
  /** 会话当前工作目录。 */
  readonly cwd?: string
  /** 会话级文件策略。 */
  readonly sandboxPolicy?: unknown
}

/** 单次程序沙箱提权的请求入参。 */
export interface SandboxEscalationInput {
  /** 目标沙箱模式。 */
  readonly requestedMode: EscalationTargetMode
  /** 模型给出的单句理由。 */
  readonly justification: string
  /** 会话当前的生效策略对象。 */
  readonly standingPolicy: unknown
  /** 调用方 agent。 */
  readonly agent: unknown
  /** 本次外层调用 id。 */
  readonly callId: string
  /** 传输工具名。 */
  readonly toolName: string
  /** 取消信号。 */
  readonly signal: AbortSignal
}

/** 一条子调用回放记录的内容投影（内核 `tools/ptc-dispatch-log` 瀑布的入参）。 */
export interface DispatchLogShape {
  /** 调用方 agent。 */
  readonly agent: unknown
  /** 子调用的工具名。 */
  readonly name: string
  /** 已规范化的子调用参数。 */
  readonly arguments: unknown
  /** 子调用是否失败。 */
  readonly isError: boolean
  /** 已裁剪的面向前模型内容块。 */
  readonly content: readonly unknown[]
}

/** 一只在飞程序运行的登记信息：入口据此响应会话级沙箱策略变更。 */
export interface ActiveRunHandle {
  /** 调用方 agent（入口用它定位会话）。 */
  readonly agent: unknown
  /** 这轮运行的取消入口：abort 会连同程序与已排队子调用一起停下。 */
  readonly controller: AbortController
  /** 这轮运行生效的沙箱模式；`undefined` 表示运行时不接管沙箱模式。 */
  readonly mode?: string
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
  /**
   * 取这次运行的会话级授权（目录 + 文件策略）。
   *
   * 老代 harness 没有 `sandboxPolicy` / `workingDirectory` 服务，此时返回 `undefined`，
   * 由 `runtime.resolve()` 或运行时自身兜底即可。
   */
  runAuthority?(agent: unknown, signal: AbortSignal): Promise<RunAuthority | undefined> | RunAuthority | undefined
  /**
   * 审批并应用单次沙箱提权（返回替换了 `mode` 的新策略对象）。
   */
  escalateSandbox?(input: SandboxEscalationInput): Promise<unknown>
  /**
   * 将携带图片块的子调用内容包装成可投递给 `exec.deferContext` 的合法用户消息。
   */
  createImageContext?(content: readonly unknown[]): unknown
  /**
   * 重写一条子调用回放记录的内容块（内核 `tools/ptc-dispatch-log` 瀑布）。
   *
   * 实现**必须**自己吞掉监听器的失败并回落到原始内容（内核 `ptc.ts` 同此）：这里决定的
   * 只是日志长什么样，落盘失败不许影响程序结果。
   */
  shapeDispatchLog?(dispatch: DispatchLogShape): Promise<readonly unknown[]>
  /**
   * 登记一只在飞的运行，返回的 disposer 在运行结算时调用。
   *
   * 入口靠它拿到「这一轮跑在哪个会话、生效模式是什么、怎么取消」，从而在会话的
   * `sandbox/mode` 事件与这轮运行不一致时取消它。
   */
  trackRun?(run: ActiveRunHandle): () => void
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
  /**
   * 面向前模型的内容块，原样进回放事件。
   *
   * 程序拿的是 `value` / `text`，这两条是给**界面**与**图片附件传递**的。
   */
  readonly content?: readonly unknown[]
  /** 工具自带的展示元数据，原样进回放事件。 */
  readonly meta?: unknown
  /** 失败身份（名称 / 业务码 / 原始细节），原样进回放事件。 */
  readonly errorInfo?: { readonly name: string; readonly code: string; readonly reason?: string }
  /** 子调用产生的延迟上下文（如催促消息），转交给外层步骤。 */
  readonly additionalContexts?: readonly unknown[]
  /** 子调用是否要求结束当前回合（如用户撤回审批）。 */
  readonly concluded?: boolean
}

/** 一次运行请求（也覆盖 {@link PtcRuntimeLike.resolve} 的产物）。 */
export interface PtcRunRequestLike {
  /** 程序源码。 */
  readonly program: string
  /** 程序里可见的绑定命名空间。 */
  readonly bindings: readonly unknown[]
  /** 常驻环境的 owner。 */
  readonly stateOwner?: object
  /** 程序起点目录。 */
  readonly cwd?: string
  /** 已解析的文件策略（DSH 0.2.2 起 `run()` 只接受 resolve() 的产物）。 */
  readonly sandboxPolicy?: unknown
  /** 超时预算；`null` 表示不限。 */
  readonly timeoutMs?: number | null
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** PTC 运行时里本模块会读到的那部分（结构契约）。 */
export interface PtcRuntimeLike {
  /** 源码语言（`typescript` / `python`）。 */
  readonly language?: string
  /** 程序形态（`function-body` / `repl`）。 */
  readonly programFormat?: string
  /** 运行时附加的执行说明文本。 */
  readonly executionInstructions?: string
  /** 运行时是否执行沙箱隔离（非 `undefined` 表示启用）。 */
  readonly sandboxMode?: unknown
  /** 运行时是否保留跨次执行状态。 */
  readonly retainsState?: boolean
  /** 超时预算。 */
  readonly timeout?: { readonly defaultMs: number; readonly maxMs: number }
  /** 常驻状态释放。 */
  release?(owner: object): Promise<void>
  /**
   * 解析目录、超时与文件策略。
   *
   * DSH 0.2.2 起内核把「解析」与「执行」拆开：`run()` 只接受这一步的产物，直接喂原始请求
   * 会抛 `ptc-runtime-node: run requires a resolved sandbox policy`。老代运行时没有这个方法，
   * 那时 `run()` 自己兜底。
   */
  resolve?(request: PtcRunRequestLike): PtcRunRequestLike
  /** 执行一段程序。 */
  run(request: PtcRunRequestLike): Promise<PtcRunResultLike>
}

/** 沙箱执行状态摘要。 */
export interface PtcSandboxSummary {
  readonly mode: string
  readonly denied: boolean
  readonly enforcement?: 'full' | 'partial'
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
  readonly sandbox?: PtcSandboxSummary
}

/** 一次传输调用的规范化结果。 */
export interface TransportOutput {
  /** 程序捕获的输出。 */
  readonly logs: readonly string[]
  /** 程序返回值。 */
  readonly result?: unknown
  /** 文件沙箱观察。 */
  readonly sandbox?: PtcSandboxSummary
}

/** 语言相关的工具描述与 `code` 参数描述（对齐内核 `ptc.ts`）。 */
interface TransportFlavor {
  readonly description: string
  readonly codeDescription: string
}

function buildFlavor(
  languageName: string,
  execution: {
    programDescription: string
    outputInstruction: string
    codeDescription: string
  },
): TransportFlavor {
  return {
    description: `Execute a ${languageName} program against the available tools. Takes two required arguments: `
      + `\`code\`, ${execution.programDescription}, and \`description\`, a short summary of what the program does. `
      + 'Call tools as `await tools.name(args)`. '
      + `${execution.outputInstruction} Image-bearing subtool results are attached after the run.`,
    codeDescription: execution.codeDescription,
  }
}

const TYPESCRIPT_REPL_FLAVOR = buildFlavor('TypeScript', {
  programDescription: 'the program to execute',
  outputInstruction: 'Curate the program output.',
  codeDescription: "The TypeScript program to execute, following this tool's execution instructions.",
})

const TYPESCRIPT_FUNCTION_FLAVOR = buildFlavor('TypeScript', {
  programDescription: 'the BODY of an async function (erasable syntax only; top-level `await` and `return` work)',
  outputInstruction: 'Only what you print or return is program output — curate it.',
  codeDescription: 'The program: the body of an async TypeScript function.',
})

const PYTHON_FLAVOR = buildFlavor('Python', {
  programDescription: 'the program to execute',
  outputInstruction: 'Curate the program output.',
  codeDescription: "The Python program to execute, following this tool's execution instructions.",
})

function resolveFlavor(runtime: PtcRuntimeLike | undefined): TransportFlavor {
  if (runtime?.language === 'python') return PYTHON_FLAVOR
  if (runtime?.language === 'typescript' && runtime.programFormat === 'repl') return TYPESCRIPT_REPL_FLAVOR
  return TYPESCRIPT_FUNCTION_FLAVOR
}

function escalationGuidance(sandboxMode: unknown): string {
  return sandboxMode === undefined
    ? ''
    : ' A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.'
}

function buildTransportDescription(runtime: PtcRuntimeLike | undefined): string {
  const flavor = resolveFlavor(runtime)
  const instructions = typeof runtime?.executionInstructions === 'string' && runtime.executionInstructions.length > 0
    ? ` ${runtime.executionInstructions}`
    : ''
  return flavor.description
    + instructions
    + " Each program starts in the Session's current directory. Running programs keep their initial directory."
    + escalationGuidance(runtime?.sandboxMode)
}

function buildTransportParameters(runtime: PtcRuntimeLike | undefined): Record<string, unknown> {
  const flavor = resolveFlavor(runtime)
  const timeoutDescription = runtime?.timeout !== undefined
    ? `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${String(runtime.timeout.defaultMs)}; capped at ${String(runtime.timeout.maxMs)}. Zero does not disable the deadline.`
    : 'Positive elapsed-time budget in milliseconds, capped by the runtime maximum.'
  const properties: Record<string, unknown> = {
    code: { type: 'string', description: flavor.codeDescription },
    description: { type: 'string', description: DESCRIPTION_PARAM_DESCRIPTION },
    timeoutMs: { type: 'number', description: timeoutDescription },
  }
  if (runtime?.sandboxMode !== undefined) {
    properties['sandbox_permissions'] = {
      type: 'string',
      enum: [...ESCALATION_TARGETS],
      description: 'Wider sandbox mode for this complete program execution; requires justification and approval.',
    }
    properties['justification'] = {
      type: 'string',
      description: 'Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request.',
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'description'],
    properties,
  }
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
  const definition = {
    name: runToolName,
    description: buildTransportDescription(undefined),
    parameters: buildTransportParameters(undefined),
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
            properties: {
              mode: { type: 'string' },
              denied: { type: 'boolean' },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args: unknown, value: TransportOutput) => {
        const logs = (value.logs ?? []).join('\n')
        const rendered = value.result === undefined ? '' : renderProgramValue(value.result)
        const parts = [logs, rendered].filter((part) => part.length > 0)
        if (value.sandbox?.enforcement === 'partial') {
          parts.push('File sandbox enforcement is partial on this host.')
        }
        if (value.sandbox?.denied === true) {
          parts.push('The ' + value.sandbox.mode + ' file sandbox denied an operation.'
            + escalationGuidance(host.runtime()?.sandboxMode))
        }
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(' + runToolName + ' completed with no output)' }]
      },
      presentationMeta: () => {
        const language = host.runtime()?.language === 'python' ? 'python' : 'typescript'
        return { language }
      },
    },
    presentCall(args: unknown) {
      if (typeof args !== 'object' || args === null) return undefined
      const record = args as Record<string, unknown>
      const code = record['code']
      const description = record['description']
      if (typeof code !== 'string' || typeof description !== 'string' || description.trim().length === 0) {
        return undefined
      }
      return {
        card: 'generic' as const,
        title: description,
        kind: 'execute' as const,
        rawInput: code,
      }
    },
    async execute(args: unknown, exec: TransportExecution): Promise<TransportOutput> {
      const input = readArguments(args)
      const runtime = host.runtime()
      if (runtime === undefined) {
        throw new Error('codemode: no PTC runtime is mounted (ctx.ptcRuntime); the program transport is unavailable')
      }
      if (input.timeoutMs !== undefined && runtime.timeout !== undefined === false && isStrictTimeoutUnsupported(runtime)) {
        throw new Error('timeoutMs is not available for this PTC runtime')
      }
      const catalog = host.catalog()
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(exec.signal.reason) }
      if (exec.signal.aborted) runController.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onOuterAbort, { once: true })
      const nestedSignal = markNested(runController.signal) ?? runController.signal
      const owner = host.stateOwner(exec.agent)
      let maxSubCalls: number = rules.options.maxSubCalls
      let attempts = 0
      const lane = createCommitLane(rules.options.maxParallelSubCalls, () => runController.signal.aborted)
      const definitions = new Map<string, CatalogEntry>()
      for (const entry of catalog) definitions.set(entry.name, entry)
      const functions = Object.create(null) as Record<string, (rawArgs: unknown) => Promise<unknown>>
      for (const entry of catalog) {
        if (entry.name === runToolName) continue
        const invoke = async (rawArgs: unknown): Promise<unknown> => {
          if (runController.signal.aborted) {
            throw new Error(runToolName + ' run is over; ' + entry.name + ' not dispatched')
          }
          const n = ++attempts
          if (n > maxSubCalls) {
            const limitErr = new Error('program sub-call limit exceeded: ' + String(maxSubCalls) + ' calls')
            runController.abort(limitErr)
            throw limitErr
          }
          const parsed = losslessArgs(rawArgs)
          const loggedArgs = losslessArgs(parsed)
          const callId = String(exec.callId) + NESTED_CALL_ID_MARKER + String(n)
          const dispatchLog = createDispatchLog(exec.agent, {
            rootCallId: rootCallIdOf(String(exec.callId)),
            parentCallId: String(exec.callId),
            subCallId: callId,
            name: entry.name,
            arguments: loggedArgs,
          })
          const mode = isConcurrencySafe(definitions.get(entry.name), parsed) ? 'parallel' : 'exclusive'
          return lane.schedule(mode, {
            // start 记在 lane 里而不是提交时：排队中被放弃的调用一条都不写（内核同此）。
            start() {
              dispatchLog.start()
            },
            body: async (): Promise<CallToolOutcome> => await host.callTool({
              name: entry.name,
              args: parsed,
              callId,
              signal: nestedSignal,
              agent: exec.agent,
              toolSet: exec.toolSet,
            }),
            /**
             * 提交阶段：按**提交顺序**逐条执行，落在会话里的副作用因此与提交顺序一致。
             *
             * 内核把这几步全部放在同一条有序 lane 里（`ptc.ts` 的 commit 游标）：回放内容
             * 投影、settle 事件、图片与附加上下文、`concludeTurn`、放行互斥屏障。并发的
             * body 谁先跑完都不影响这一串的顺序——否则界面里的子调用记录会错位，延迟上下文
             * 也会插到错误的位置。
             */
            async commit(parked): Promise<unknown> {
              // body 抛错（提交被取消、approval 拒绝等）：成对收尾，否则界面留下一条永远
              // 不收尾的行。
              if (!parked.ok) {
                dispatchLog.settle({ error: messageOf(parked.error) })
                throw parked.error
              }
              const outcome = parked.value
              const isError = outcome.error !== undefined
              const content = await shapeDispatchContent(host, {
                agent: exec.agent,
                name: entry.name,
                arguments: loggedArgs,
                isError,
                content: clipContent(outcome.content),
              })
              dispatchLog.settle({ ...outcome, content })
              if (!isError && Array.isArray(outcome.content) && hasImageBlock(outcome.content)) {
                const imageMsg = host.createImageContext?.(outcome.content)
                if (imageMsg !== undefined) exec.deferContext?.(imageMsg)
              }
              if (Array.isArray(outcome.additionalContexts)) {
                for (const contextMsg of outcome.additionalContexts) {
                  exec.deferContext?.(contextMsg)
                }
              }
              if (!isError && outcome.concluded === true) {
                exec.concludeTurn?.()
              }
              if (runController.signal.aborted) {
                throw new Error(runToolName + ' run is over; ' + entry.name + ' result discarded')
              }
              if (outcome.error !== undefined) throw new Error(outcome.error)
              return outcome.value !== undefined ? outcome.value : outcome.text ?? null
            },
            abandon(): never {
              throw new Error(runToolName + ' run is over; ' + entry.name + ' tool call abandoned')
            },
          })
        }
        Object.defineProperty(functions, entry.name, {
          enumerable: true,
          configurable: true,
          writable: true,
          value: invoke,
        })
      }

      try {
        /**
         * 跑一次程序：每次重取会话授权，因为重试发生在策略变更之后。
         *
         * 单次沙箱提权（`sandbox_permissions`）只在第一次进入前审批一次，且提权后的单次执行不传
         * `stateOwner`，避免把单次授权固化到常驻环境中（对齐内核 `ptc.ts`）。
         */
        let approvedEscalatedMode: EscalationTargetMode | undefined
        /** 这次运行在入口那边的登记；结算时释放（重跑会重新登记一次）。 */
        let untrackRun: () => void = () => {}
        const attempt = async (): Promise<PtcRunResultLike> => {
          const authority = await host.runAuthority?.(exec.agent, nestedSignal)
          const standingPolicy = authority?.sandboxPolicy
          let effectivePolicy = standingPolicy
          let escalated = false
          if (input.sandboxPermissions !== undefined && input.justification !== undefined) {
            if (standingPolicy === undefined || typeof host.escalateSandbox !== 'function') {
              throw new Error('sandbox_permissions is not available for this PTC runtime')
            }
            if (approvedEscalatedMode === undefined) {
              const nextPolicy = await host.escalateSandbox({
                requestedMode: input.sandboxPermissions,
                justification: input.justification,
                standingPolicy,
                agent: exec.agent,
                callId: String(exec.callId),
                toolName: runToolName,
                signal: exec.signal,
              })
              effectivePolicy = nextPolicy
              approvedEscalatedMode = modeOfPolicy(nextPolicy) as EscalationTargetMode | undefined
            } else if (typeof standingPolicy === 'object' && standingPolicy !== null) {
              effectivePolicy = { ...(standingPolicy as Record<string, unknown>), mode: approvedEscalatedMode }
            }
            escalated = modeOfPolicy(effectivePolicy) !== modeOfPolicy(standingPolicy)
          }
          // 会话的 `sandbox/mode` 事件靠这条登记取消在飞运行；重跑时用同一个 controller
          // 重新登记，所以先释放上一次。
          untrackRun()
          const runMode = modeOfPolicy(effectivePolicy)
          untrackRun = host.trackRun?.({
            agent: exec.agent,
            controller: runController,
            ...runMode === undefined ? {} : { mode: runMode },
          }) ?? (() => {})
          const request: PtcRunRequestLike = {
            program: input.code,
            bindings: [{
              global: 'tools',
              functions,
              errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
            }],
            ...(escalated ? {} : { stateOwner: owner }),
            ...(authority?.cwd === undefined ? {} : { cwd: authority.cwd }),
            ...(effectivePolicy === undefined ? {} : { sandboxPolicy: effectivePolicy }),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            signal: nestedSignal,
          }
          const spec = typeof runtime.resolve === 'function' ? runtime.resolve(request) : request
          maxSubCalls = resolveSubCallBudget(spec, rules)
          // 快照只在这一段里可见：程序内的检索与绑定读同一份清单。
          return await catalogScope.run(catalog, () => runtime.run(spec))
        }

        let result: PtcRunResultLike
        try {
          try {
            result = await attempt()
          } catch (error: unknown) {
            // 常驻环境拒绝换策略时（会话切了沙盒模式），释放后按新策略重跑一次。
            if (!isRetainedPolicyChange(error)) throw error
            await host.releaseOwner(owner)
            // 重跑会重建常驻环境，owner 必须重新登记，否则新环境没人释放。
            host.stateOwner(exec.agent)
            result = await attempt()
          }
        } finally {
          runController.abort(runToolName + ' settled')
          await lane.drain()
          untrackRun()
        }

        if (result.error !== undefined) {
          const logsText = Array.isArray(result.logs) && result.logs.length > 0
            ? '\nCaptured output:\n' + result.logs.join('\n')
            : ''
          const sandboxText = result.sandbox === undefined
            ? ''
            : '\nFile sandbox: ' + result.sandbox.mode
              + (result.sandbox.enforcement === undefined ? '' : '; enforcement: ' + result.sandbox.enforcement)
              + (result.sandbox.denied ? '; operation denied' : '') + '.'
          const hint = result.sandbox?.denied ? escalationGuidance(runtime.sandboxMode) : ''
          throw new Error('program failed (' + result.error.kind + '): ' + result.error.message + logsText + sandboxText + hint)
        }
        const output: TransportOutput = {
          logs: [...(result.logs ?? [])],
          ...(result.value === undefined ? {} : { result: result.value }),
          ...(result.sandbox === undefined
            ? {}
            : {
                sandbox: {
                  mode: result.sandbox.mode,
                  denied: result.sandbox.denied,
                  ...(result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement }),
                },
              }),
        }
        return output
      } finally {
        exec.signal.removeEventListener('abort', onOuterAbort)
      }
    },
  }

  Object.defineProperty(definition, 'description', {
    enumerable: true,
    configurable: true,
    get: () => buildTransportDescription(safeRuntime(host)),
  })
  Object.defineProperty(definition, 'parameters', {
    enumerable: true,
    configurable: true,
    get: () => buildTransportParameters(safeRuntime(host)),
  })

  return definition
}

function safeRuntime(host: CodemodeHost): PtcRuntimeLike | undefined {
  try {
    return host.runtime()
  } catch {
    return undefined
  }
}

/** 只有明确声明了 `timeout: undefined` 自身属性（而非测试假对象省略字段）才视作不支持 `timeoutMs`。 */
function isStrictTimeoutUnsupported(runtime: PtcRuntimeLike): boolean {
  return Object.prototype.hasOwnProperty.call(runtime, 'timeout') && runtime.timeout === undefined
}

function modeOfPolicy(policy: unknown): string | undefined {
  if (typeof policy !== 'object' || policy === null) return undefined
  const mode = (policy as { mode?: unknown }).mode
  return typeof mode === 'string' ? mode : undefined
}

function hasImageBlock(content: readonly unknown[]): boolean {
  return content.some((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
}

function resolveSubCallBudget(spec: PtcRunRequestLike, rules: CodemodeRules): number {
  if (rules.options.explicitMaxSubCalls) return rules.options.maxSubCalls
  if (spec.timeoutMs === null) return Infinity
  if (typeof spec.timeoutMs === 'number' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
    return Math.max(1, Math.floor((spec.timeoutMs / 60_000) * rules.options.maxSubCallsPerMinute))
  }
  return rules.options.maxSubCalls
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
  /** 附加延迟上下文（图片块、催促通知等）。 */
  deferContext?(message: unknown): void
  /** 请求在当前批结算后结束回合。 */
  concludeTurn?(): void
}

/** 一条子调用在会话里的回放记录。 */
interface DispatchLog {
  /** 子调用进入执行 lane。 */
  start(): void
  /** 子调用结算（成功或失败，恰好一次）。 */
  settle(outcome: CallToolOutcome): void
}

/** 没有会话可写时的空记录。 */
const NO_DISPATCH_LOG: DispatchLog = Object.freeze({ start() {}, settle() {} })

/**
 * 一条子调用的回放记录正文。
 *
 * 字段与内核自己那两条事件逐字对齐：界面靠 `parentCallId` 把它挂到父调用下面，靠
 * `subCallId` 把 start 与 settle 配成一条。
 */
interface DispatchLogEntry {
  /** 调用树的根 id。 */
  readonly rootCallId: string
  /** 父调用（`code_run` 自己）的 id。 */
  readonly parentCallId: string
  /** 子调用 id（`<父>:ptc:<n>`）。 */
  readonly subCallId: string
  /** 工具名。 */
  readonly name: string
  /** 已规范化的参数。 */
  readonly arguments: unknown
}

/** 回放里单个文本块的上限：日志要有界，程序拿到的值不受影响。 */
const DISPATCH_LOG_TEXT_LIMIT = 8000

/**
 * 造一条子调用的回放记录。
 */
function createDispatchLog(agent: unknown, entry: DispatchLogEntry): DispatchLog {
  const session = typeof agent === 'object' && agent !== null
    ? (agent as { session?: { append?: (type: string, data: unknown) => void } }).session
    : undefined
  const append = session?.append
  if (typeof append !== 'function') return NO_DISPATCH_LOG
  const base = {
    rootCallId: entry.rootCallId,
    parentCallId: entry.parentCallId,
    subCallId: entry.subCallId,
    name: entry.name,
    arguments: entry.arguments,
  }
  const write = (type: string, data: unknown): void => {
    try {
      append.call(session, type, data)
    } catch {
      // 老代没有这两种事件类型：静默降级为「没有回放」。
    }
  }
  return {
    start() {
      write('tool/ptc-dispatch-start', { ...base })
    },
    settle(outcome) {
      write('tool/ptc-dispatch', {
        ...base,
        isError: outcome.error !== undefined,
        // 内容块由提交车道先裁剪、再过 `tools/ptc-dispatch-log` 瀑布，这里写的就是最终那份。
        content: Array.isArray(outcome.content) ? outcome.content : [],
        ...(outcome.meta === undefined ? {} : { meta: outcome.meta }),
        ...(outcome.errorInfo === undefined ? {} : { error: outcome.errorInfo }),
      })
    },
  }
}

/**
 * 把内容块裁到日志能承受的长度。
 */
function clipContent(content: readonly unknown[] | undefined): readonly unknown[] {
  if (content === undefined) return []
  return content.map((block) => {
    if (typeof block !== 'object' || block === null) return block
    const record = block as Record<string, unknown>
    const text = record['text']
    if (typeof text !== 'string' || text.length <= DISPATCH_LOG_TEXT_LIMIT) return block
    return { ...record, text: text.slice(0, DISPATCH_LOG_TEXT_LIMIT) + '…[truncated in dispatch log]' }
  })
}

/**
 * 一条调用所属调用树的根 id。
 */
function rootCallIdOf(callId: string): string {
  const at = callId.indexOf(NESTED_CALL_ID_MARKER)
  return at > 0 ? callId.slice(0, at) : callId
}

/** 内核在常驻环境遇到策略变更时的拒绝文本；其余异常一律原样上抛。 */
function isRetainedPolicyChange(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('release the retained environment before changing its sandbox policy')
}

/** 校验单次沙箱提权参数配对（对齐 `@deepseek-ai/dsh-sandbox` 的 `validateEscalationArgs`）。 */
export function validateEscalationArgs(
  sandboxPermissions: unknown,
  justification: unknown,
): { sandboxPermissions?: EscalationTargetMode; justification?: string } {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (sandboxPermissions === undefined && justification === undefined) {
    return {}
  }
  if (typeof sandboxPermissions !== 'string' || !(ESCALATION_TARGETS as readonly string[]).includes(sandboxPermissions)) {
    throw new Error('invalid sandbox_permissions: expected "workspace-write" or "danger-full-access"')
  }
  if (typeof justification !== 'string' || justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
  return {
    sandboxPermissions: sandboxPermissions as EscalationTargetMode,
    justification,
  }
}

/** 校验并读出工具参数。 */
function readArguments(args: unknown): {
  code: string
  description: string
  timeoutMs?: number
  sandboxPermissions?: EscalationTargetMode
  justification?: string
} {
  if (typeof args !== 'object' || args === null) throw new Error('codemode: expected an arguments object')
  const record = args as Record<string, unknown>
  const code = record['code']
  const description = record['description']
  if (typeof code !== 'string' || code.trim().length === 0) {
    // 回显收到的键：模型常常把源码放进 `program` / `source` / `script`，只回一句
    // 「expected a non-empty string」它下一轮还会照原来那样再发一次。
    const received = Object.keys(record)
    throw new Error('codemode: invalid code: expected a non-empty string'
      + (received.length === 0 ? '' : ' (received keys: ' + received.join(', ') + '; pass program source in "code")'))
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('codemode: invalid description: expected a non-empty string')
  }
  const escalation = validateEscalationArgs(record['sandbox_permissions'], record['justification'])
  const timeoutMs = record['timeoutMs']
  if (timeoutMs === undefined) return { code, description, ...escalation }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('codemode: invalid timeoutMs: expected a positive finite number')
  }
  return { code, description, timeoutMs, ...escalation }
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

/**
 * 子调用的并发、提交顺序与互斥屏障（对齐内核 `ptc.ts` 的 ordered commit lane）。
 *
 * - `start()`（记 start 事件 + 启动 body）在 lane 里按提交顺序执行：`parallel` body 之间
 *   可以并发重叠，最多 `maxParallel` 个同时在飞；
 * - `commit()`（记 settle 事件 + 转发图片/附加上下文 + `concludeTurn` + 放行互斥屏障）
 *   按**提交顺序**逐条执行：前一条没提交完，后一条的结果不会先落到会话里；
 * - `exclusive` 调用等所有在飞 body 结算后独占运行，并独占到自己 commit 完成才放行后续；
 * - 排队期间若外层运行已中止，直接放弃且不启动任务（未启动调用零 `start` 事件）；
 * - `drain()` 等到 lane 彻底静止（所有 body 结算、所有 commit 完成）才返回。
 *
 * 程序拿到的值在 commit 里结算（与内核同）：body 结束不保证顺序，提交才是顺序。
 *
 * @param maxParallel - 同时在飞的上限。
 * @param isAborted - 外层运行是否已中止。
 * @returns 调度入口与排空。
 */
function createCommitLane(maxParallel: number, isAborted: () => boolean) {
  /** body 的结局：成功值或抛出的错误。 */
  type Parked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  interface Task<T, R> {
    /** 有序预执行：记 start 事件。 */
    start(): void
    /** 并发执行的 body：真正调用工具。 */
    body(): Promise<T>
    /** 有序提交：写回放、转发上下文、屏障放行，并给出程序拿到的值。 */
    commit(parked: Parked<T>): R | Promise<R>
    /** 排队中被放弃（运行已结束）时抛出的错误。 */
    abandon(): never
  }
  interface Entry {
    readonly mode: 'parallel' | 'exclusive'
    settled: boolean
    flight: Promise<void>
    start(): void
    commit(): Promise<void>
    abandon(): void
  }
  const cap = Math.max(1, maxParallel)
  const queue: Entry[] = []
  const commitQueue: Entry[] = []
  const inFlight = new Set<Promise<void>>()
  let exclusiveActive = false
  let driving = false
  let driverRun: Promise<void> = Promise.resolve()
  let wake: (() => void) | undefined
  const wakeup = (): void => {
    const release = wake
    wake = undefined
    release?.()
  }

  /**
   * 唯一的有序车道：每一轮先提交队首已结算的调用，再在有空位时启动下一个排队调用，
   * 否则睡到「有 body 结算或有新提交」为止。三条队列全空即静止。
   */
  const drive = (): Promise<void> => {
    if (driving) return driverRun
    driving = true
    driverRun = (async () => {
      try {
        for (;;) {
          // 先建唤醒 promise 再查状态：两者之间到达的结算或提交不会丢。
          const signal = new Promise<void>((resolve) => { wake = resolve })
          const commitHead = commitQueue[0]
          if (commitHead !== undefined && commitHead.settled) {
            commitQueue.shift()
            await commitHead.commit()
            if (commitHead.mode === 'exclusive') exclusiveActive = false
            continue
          }
          const head = queue[0]
          if (head !== undefined) {
            if (isAborted()) {
              queue.shift()
              head.abandon()
              continue
            }
            const capacity = !exclusiveActive
              && (head.mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < cap)
            if (capacity) {
              if (head.mode === 'exclusive') exclusiveActive = true
              queue.shift()
              // 先入提交队列再启动：提交游标看到的永远是提交顺序。
              commitQueue.push(head)
              head.start()
              const flight: Promise<void> = head.flight.finally(() => {
                inFlight.delete(flight)
                wakeup()
              })
              inFlight.add(flight)
              continue
            }
          }
          if (queue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
          await signal
        }
      } finally {
        driving = false
        wake = undefined
      }
    })()
    return driverRun
  }

  return {
    schedule<T, R>(mode: 'parallel' | 'exclusive', task: Task<T, R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        let parked: Parked<T> | undefined
        const entry: Entry = {
          mode,
          settled: false,
          flight: Promise.resolve(),
          start() {
            task.start()
            entry.flight = (async () => {
              try {
                parked = { ok: true, value: await task.body() }
              } catch (error: unknown) {
                parked = { ok: false, error }
              }
              entry.settled = true
              wakeup()
            })()
          },
          async commit() {
            const result = parked
            if (result === undefined) return
            try {
              resolve(await task.commit(result))
            } catch (error: unknown) {
              reject(error)
            }
          },
          abandon() {
            try {
              task.abandon()
            } catch (error: unknown) {
              reject(error)
            }
          },
        }
        queue.push(entry)
        wakeup()
        void drive()
      })
    },
    async drain(): Promise<void> {
      await drive()
    },
  }
}

/**
 * 回放内容的投影：先按日志上限裁剪，再交给入口的 `tools/ptc-dispatch-log` 瀑布。
 *
 * 瀑布失败**不**影响这条记录：回落裁剪后的原始内容（内核 `ptc.ts` 同此）。
 */
async function shapeDispatchContent(host: CodemodeHost, dispatch: DispatchLogShape): Promise<readonly unknown[]> {
  if (typeof host.shapeDispatchLog !== 'function') return dispatch.content
  try {
    const shaped = await host.shapeDispatchLog(dispatch)
    return Array.isArray(shaped) ? shaped : dispatch.content
  } catch {
    return dispatch.content
  }
}

/** 一个抛出值的消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const JSON_INDENT = '  '
const MAX_JSON_INDENT_CHARS = 10

/** 迭代式 JSON 渲染：与内核 `ptc.ts` 一致，深于 5 层后自动紧凑化，防止深层缩进膨胀。 */
function renderProgramValue(value: unknown): string {
  if (typeof value === 'string') return value
  let normalized: unknown
  try {
    normalized = JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
  if (typeof normalized === 'string') return normalized
  if (normalized === undefined) return ''

  type Task =
    | { kind: 'text'; text: string }
    | { kind: 'value'; value: unknown; depth: number; compact: boolean }

  const chunks: string[] = []
  const tasks: Task[] = [{ kind: 'value', value: normalized, depth: 0, compact: false }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }
    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }
    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      chunks.push('[')
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      for (let index = current.length - 1; index >= 0; index -= 1) {
        tasks.push({ kind: 'value', value: current[index], depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? (index === 0 ? '' : ',')
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      const keys = Object.keys(record)
      chunks.push('{')
      if (keys.length === 0) {
        chunks.push('}')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!
        tasks.push({ kind: 'value', value: record[key], depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
        })
      }
    }
  }
  return chunks.join('')
}
