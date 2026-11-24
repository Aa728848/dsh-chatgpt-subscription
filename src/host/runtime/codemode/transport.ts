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
import { HarnessError } from '@deepseek-ai/dsh-llm'

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

/** 进展汇报工具名：融合参数里救回来的简报用它补发。 */
const PROGRESS_UPDATE_TOOL = 'progress_update'

/** 允许单次提权的目标沙箱模式（对齐 `@deepseek-ai/dsh-sandbox` 的 `ESCALATION_TARGETS`）。 */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access'] as const)
export type EscalationTargetMode = (typeof ESCALATION_TARGETS)[number]

/**
 * 子调用配额耗尽时的宿主中止原因（对齐 `@deepseek-ai/dsh-tool-executor-ptc` 的 `ToolCallLimitExceededError`）。
 *
 * 超出的那一次调用不会派发；结算阶段识别此错误并保留完整诊断，防止常驻模式下的泛化取消文案吞掉真实原因。
 */
export class ToolCallLimitExceededError extends Error {
  constructor(limit: number, callNumber: number, callsPerMinute: number, runToolName = TRANSPORT_TOOL_NAME) {
    super(
      `${runToolName} exceeded its limit of ${String(limit)} tool calls (${String(callsPerMinute)} per minute of its timeout); `
      + `call ${String(callNumber)} was not dispatched. The ${runToolName} program may contain an infinite loop. `
      + `Check loop termination or split the work into smaller ${runToolName} calls.`,
    )
    this.name = 'ToolCallLimitExceededError'
  }
}

/**
 * 程序运行自身失败时抛出的结构化错误（对齐内核 `CodeRunFailedError`，`code: 'CODE_RUN_FAILED'`）。
 */
export class CodeRunFailedError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CODE_RUN_FAILED', options)
    this.name = 'CodeRunFailedError'
  }
}

/**
 * 常驻环境重置不支持或失败时抛出的结构化错误（对齐内核 `CodeResetFailedError`，`code: 'CODE_RESET_FAILED'`）。
 */
export class CodeResetFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RESET_FAILED')
    this.name = 'CodeResetFailedError'
  }
}

/**
 * Code Mode 参数校验失败（对齐 `@deepseek-ai/dsh-tools` 的 `ToolArgsError`，`code: 'INVALID_ARGS'`）。
 */
export class CodemodeArgsError extends HarnessError {
  readonly violations: readonly string[]

  constructor(message: string) {
    super(message, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = [message]
  }
}

/**
 * Code Mode 缺少必须宿主上下文时抛出的结构化错误（对齐 `@deepseek-ai/dsh-tools` 的 `ToolContextUnavailableError`）。
 */
export class CodemodeContextUnavailableError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'TOOL_CONTEXT_UNAVAILABLE', options)
    this.name = 'ToolContextUnavailableError'
  }
}

/** 沙箱提权结构化错误码（对齐 `@deepseek-ai/dsh-sandbox` 的 `SandboxEscalationErrorCode`）。 */
export type SandboxEscalationErrorCode =
  | 'SANDBOX_ESCALATION_INVALID_ARGUMENT'
  | 'SANDBOX_ESCALATION_UNAVAILABLE'
  | 'SANDBOX_ESCALATION_REJECTED'
  | 'SANDBOX_ESCALATION_CANCELLED'

/**
 * 单次沙箱提权未获准时抛出的结构化错误（对齐 `@deepseek-ai/dsh-sandbox` 的 `SandboxEscalationError`）。
 */
export class SandboxEscalationError extends HarnessError {
  override readonly code: SandboxEscalationErrorCode

  constructor(message: string, code: SandboxEscalationErrorCode) {
    super(message, code)
    this.name = 'SandboxEscalationError'
    this.code = code
  }
}

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

/** 一只在飞程序运行的登记信息：入口据此响应会话级沙箱策略变更并协调前序取消排空。 */
export interface ActiveRunHandle {
  /** 调用方 agent（入口用它定位会话）。 */
  readonly agent: unknown
  /** 这轮运行的取消入口：abort 会连同程序与已排队子调用一起停下。 */
  readonly controller: AbortController
  /** 融合了外层取消与本轮 controller 的信号，供前序排空判据读取。 */
  readonly signal?: AbortSignal
  /** 这轮运行生效的沙箱模式；`undefined` 表示运行时不接管沙箱模式。 */
  readonly mode?: string
}

/** 程序的运行环境句柄：由入口提供，传输层只调用。 */
export interface CodemodeHost {
  /** 当前可调用的工具清单（支持按调用方 agent 与步骤 toolSet 动态解析，含被遮蔽工具）。 */
  catalog(agent?: unknown, toolSet?: unknown): readonly CatalogEntry[]
  /** 执行一次子调用（内部走 `ctx.tools.execute()`）。 */
  callTool(request: CallToolRequest): Promise<CallToolOutcome>
  /** 读 PTC 运行时（结构探测）。 */
  runtime(): PtcRuntimeLike | undefined
  /** 常驻环境的 owner（缺省用调用方 agent 当 owner）。 */
  stateOwner(agent: unknown): object
  /** 程序结束时释放 owner 的常驻环境。 */
  releaseOwner(owner: object): Promise<void>
  /**
   * 新调用进入前等待同会话已取消的前序运行与进行中的环境重置排空（对齐 `PtcCalls.run`）。
   */
  awaitPredecessors?(agent: unknown, signal: AbortSignal): Promise<void>
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
   * 将图片附件包装成程序内可操作的一等公民 `PtcImage` 对象（DSH 0.2.2-rc.2+ TypeScript 运行时）。
   *
   * 返回 `undefined` 时保持工具原始返回值，并通过 `deferContext` 直接附带图片上下文。
   */
  programImage?(attachment: unknown, fallbackPath?: string): unknown
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

/** 运行时有序输出流中的单个输出块（DSH 0.2.2-rc.2+ `inspect` / `console` / `PtcImage`）。 */
export type PtcOutputBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: unknown }

/** 一次程序运行的结果（同时兼容旧代 `logs: string[]` 与新代 `output: PtcOutputBlock[]`）。 */
export interface PtcRunResultLike {
  /** 程序返回值。 */
  readonly value?: unknown
  /** 旧代（<= 0.2.2-rc.1）捕获的日志行。 */
  readonly logs?: readonly string[]
  /** 新代（0.2.2-rc.2+）有序图文混排输出块。 */
  readonly output?: readonly PtcOutputBlock[]
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

/** 与 `@deepseek-ai/dsh-ptc-runtime` 的 `PTC_IMAGE_TAG` 对齐的跨包协议符号。 */
export const PTC_IMAGE_TAG = Symbol.for('dsh.ptc.image')

/** 图片附件引用结构（对齐 `@deepseek-ai/dsh-llm` 的 `ImageAttachmentRef`）。 */
export interface PtcImageAttachmentRefLike {
  readonly kind: 'image-attachment'
  readonly attachmentId: string
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly byteLength: number
}

/**
 * 程序内一等公民图片句柄（协议兼容 `@deepseek-ai/dsh-ptc-runtime` 的 `PtcImage`）。
 *
 * `ptc-runtime-node` 的 `encodeWireValue` 通过 `Symbol.for('dsh.ptc.image') === true` + `path` + `attachment`
 * 判定图片句柄并在 worker 侧还原为 `PtcImage` 实例，使程序可读 `.path` / `.width` / `.height` 并传给 `inspect(img)`。
 */
export class PtcImageLike {
  readonly [PTC_IMAGE_TAG] = true
  readonly path: string
  readonly attachment: PtcImageAttachmentRefLike

  constructor(path: string, attachment: PtcImageAttachmentRefLike) {
    this.path = path
    this.attachment = attachment
  }

  get attachmentId(): string {
    return this.attachment.attachmentId
  }

  get mediaType(): string {
    return this.attachment.mediaType
  }

  get width(): number {
    return this.attachment.width
  }

  get height(): number {
    return this.attachment.height
  }
}

/** 判定一个值是否为合法的 `ImageAttachmentRef`。 */
export function isImageAttachmentRefLike(value: unknown): value is PtcImageAttachmentRefLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate['kind'] === 'image-attachment'
    && typeof candidate['attachmentId'] === 'string' && candidate['attachmentId'].length > 0
    && typeof candidate['mediaType'] === 'string' && candidate['mediaType'].length > 0
    && typeof candidate['width'] === 'number' && Number.isInteger(candidate['width']) && candidate['width'] > 0
    && typeof candidate['height'] === 'number' && Number.isInteger(candidate['height']) && candidate['height'] > 0
    && typeof candidate['byteLength'] === 'number' && Number.isInteger(candidate['byteLength']) && candidate['byteLength'] > 0
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

export function isReplFormat(programFormat: string | undefined): boolean {
  return programFormat === 'repl' || programFormat === 'scoped-repl' || programFormat === 'script'
}

function resolveFlavor(runtime: PtcRuntimeLike | undefined): TransportFlavor {
  if (runtime?.language === 'python') return PYTHON_FLAVOR
  if (runtime?.language === 'typescript' && isReplFormat(runtime.programFormat)) return TYPESCRIPT_REPL_FLAVOR
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
  const inspections = new WeakMap<object, { readonly blocks: readonly unknown[]; readonly appendToError?: boolean }>()
  const structuredOutputs = new WeakMap<object, readonly PtcOutputBlock[]>()
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
        const structured = typeof value === 'object' && value !== null ? structuredOutputs.get(value) : undefined
        if (structured !== undefined) {
          return renderStructuredOutputBlocks(
            structured,
            value.result,
            value.sandbox,
            host.runtime()?.sandboxMode,
            runToolName,
          )
        }
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
    projectContent(exec: unknown, toolResult: unknown) {
      if (typeof exec !== 'object' || exec === null) return undefined
      const inspection = inspections.get(exec)
      if (inspection === undefined) return undefined
      inspections.delete(exec)
      if (inspection.appendToError === true) {
        const existing = typeof toolResult === 'object' && toolResult !== null && Array.isArray((toolResult as { content?: unknown }).content)
          ? ((toolResult as { content: readonly unknown[] }).content)
          : []
        return [...existing, ...inspection.blocks]
      }
      return [...inspection.blocks]
    },
    presentCall(args: unknown) {
      // 卡片标题走与执行同一条解析路径：融合参数、别名键、纯程序文本都能显示正确标题。
      try {
        const input = readArguments(args)
        return {
          card: 'generic' as const,
          title: input.description,
          kind: 'execute' as const,
          rawInput: input.code,
        }
      } catch {
        return undefined
      }
    },
    async execute(args: unknown, exec: TransportExecution): Promise<TransportOutput> {
      const input = readArguments(args)
      const runtime = host.runtime()
      if (runtime === undefined) {
        throw new CodemodeContextUnavailableError('codemode: no PTC runtime is mounted (ctx.ptcRuntime); the program transport is unavailable')
      }
      if (input.timeoutMs !== undefined && runtime.timeout !== undefined === false && isStrictTimeoutUnsupported(runtime)) {
        throw new CodemodeArgsError('timeoutMs is not available for this PTC runtime')
      }
      const hasRawEscalation = input.rawSandboxPermissions !== undefined || input.rawJustification !== undefined
      if (hasRawEscalation && isStrictSandboxUnsupported(runtime)) {
        throw new CodemodeArgsError('sandbox_permissions and justification are not available for this PTC runtime')
      }
      const prevalidatedEscalation = hasRawEscalation && runtime.sandboxMode !== undefined
        ? validateEscalationArgs(input.rawSandboxPermissions, input.rawJustification)
        : undefined
      await host.awaitPredecessors?.(exec.agent, exec.signal)
      const catalog = host.catalog(exec.agent, exec.toolSet)
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(exec.signal.reason) }
      if (exec.signal.aborted) runController.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onOuterAbort, { once: true })
      const nestedSignal = markNested(runController.signal) ?? runController.signal
      // 融合参数里救回来的简报先补发：模型本来就想「说完这段再跑这段」。
      if (input.narration !== undefined) await forwardNarration(host, input.narration, exec, nestedSignal)
      const owner = host.stateOwner(exec.agent)
      let maxSubCalls: number = rules.options.maxSubCalls
      let attempts = 0
      const deferredProgramImages: { readonly attachmentId?: string; readonly content: readonly unknown[] }[] = []
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
            const limitErr = new ToolCallLimitExceededError(
              maxSubCalls,
              n,
              rules.options.maxSubCallsPerMinute,
              runToolName,
            )
            runController.abort(limitErr)
            throw limitErr
          }
          const { dispatched: parsed, logged: loggedArgs } = normalizeSubCallArgsPair(definitions.get(entry.name), rawArgs)
          const callId = String(exec.callId) + NESTED_CALL_ID_MARKER + String(n)
          const dispatchLog = createDispatchLog(exec.agent, {
            rootCallId: rootCallIdOf(String(exec.callId)),
            parentCallId: String(exec.callId),
            subCallId: callId,
            name: entry.name,
            arguments: loggedArgs,
          })
          return lane.schedule({
            // 并发模式在队列头部真正启动时才求值（对齐内核 `ptc.ts:461` 惰性分类）。
            classify: () => (isConcurrencySafe(definitions.get(entry.name), parsed) ? 'parallel' : 'exclusive'),
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
             * 对齐内核 `ptc.ts:537-634`：延迟上下文（图片与 `additionalContexts`）与 `concludeTurn`
             * 按提交顺序同步生效后，**立刻**向程序返回子调用结果，避免慢速日志落盘监听器阻塞程序
             * 后续执行；`shapeDispatchLog` 与 `tool/ptc-dispatch` 事件通过带背压的有序 `logWork`
             * 队列异步结算，并在 `lane.drain()` 中完整排空。
             */
            commit(parked, enqueueLog): unknown {
              // body 抛错（提交被取消、approval 拒绝等）：成对收尾，否则界面留下一条永远
              // 不收尾的行。
              if (!parked.ok) {
                enqueueLog(async () => {
                  dispatchLog.settle({ error: messageOf(parked.error) })
                })
                throw parked.error
              }
              const outcome = parked.value
              const isError = outcome.error !== undefined
              let programImageValue: unknown
              if (
                !isError
                && (entry.name === 'read_image' || entry.name === 'cua')
                && runtime.language !== 'python'
                && typeof host.programImage === 'function'
                && Array.isArray(outcome.content)
              ) {
                const imageRef = firstImageAttachmentOf(outcome.content)
                if (imageRef !== undefined) {
                  const fallbackPath = isRecord(outcome.value) && typeof outcome.value['path'] === 'string'
                    ? outcome.value['path']
                    : (isRecord(parsed) && typeof parsed['file_path'] === 'string' ? parsed['file_path'] : undefined)
                  programImageValue = host.programImage(imageRef, fallbackPath)
                  if (programImageValue !== undefined) {
                    deferredProgramImages.push({
                      attachmentId: imageRef.attachmentId,
                      content: outcome.content,
                    })
                  }
                }
              }
              if (!isError && programImageValue === undefined && Array.isArray(outcome.content) && hasImageBlock(outcome.content)) {
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
              enqueueLog(async () => {
                const content = await shapeDispatchContent(host, {
                  agent: exec.agent,
                  name: entry.name,
                  arguments: loggedArgs,
                  isError,
                  content: clipContent(outcome.content),
                })
                dispatchLog.settle({ ...outcome, content })
              })
              if (runController.signal.aborted) {
                throw new Error(runToolName + ' run is over; ' + entry.name + ' result discarded')
              }
              if (outcome.error !== undefined) throw new Error(outcome.error)
              if (programImageValue !== undefined) return programImageValue
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
        /** 提前登记在飞调用，使目录解析与沙箱提权审批等待期也能响应 `reset()` 与 `sandbox/mode` 变更。 */
        let untrackRun: () => void = host.trackRun?.({
          agent: exec.agent,
          controller: runController,
          signal: nestedSignal,
        }) ?? (() => {})
        const sanitizedCode = sanitizeReplTopLevelReturn(input.code, runtime.programFormat, runtime.language)
        const attempt = async (): Promise<PtcRunResultLike> => {
          deferredProgramImages.length = 0
          const authority = await host.runAuthority?.(exec.agent, nestedSignal)
          const standingPolicy = authority?.sandboxPolicy
          const standingMode = modeOfPolicy(standingPolicy)
          if (standingMode !== undefined) {
            untrackRun = host.trackRun?.({
              agent: exec.agent,
              controller: runController,
              signal: nestedSignal,
              mode: standingMode,
            }) ?? untrackRun
          }
          let effectivePolicy = standingPolicy
          let escalated = false
          if (hasRawEscalation) {
            if (standingPolicy === undefined || typeof host.escalateSandbox !== 'function') {
              throw new CodemodeArgsError('sandbox_permissions and justification are not available for this PTC runtime')
            }
            const escalation = prevalidatedEscalation ?? validateEscalationArgs(input.rawSandboxPermissions, input.rawJustification)
            if (escalation.sandboxPermissions !== undefined && escalation.justification !== undefined) {
              if (approvedEscalatedMode === undefined) {
                const nextPolicy = await host.escalateSandbox({
                  requestedMode: escalation.sandboxPermissions,
                  justification: escalation.justification,
                  standingPolicy,
                  agent: exec.agent,
                  callId: String(exec.callId),
                  toolName: runToolName,
                  signal: nestedSignal,
                })
                effectivePolicy = nextPolicy
                approvedEscalatedMode = modeOfPolicy(nextPolicy) as EscalationTargetMode | undefined
              } else if (typeof standingPolicy === 'object' && standingPolicy !== null) {
                effectivePolicy = { ...(standingPolicy as Record<string, unknown>), mode: approvedEscalatedMode }
              }
              escalated = modeOfPolicy(effectivePolicy) !== modeOfPolicy(standingPolicy)
            }
          }
          const runMode = standingMode ?? modeOfPolicy(effectivePolicy)
          if (runMode !== undefined) {
            untrackRun = host.trackRun?.({
              agent: exec.agent,
              controller: runController,
              signal: nestedSignal,
              mode: runMode,
            }) ?? untrackRun
          }
          const request: PtcRunRequestLike = {
            program: sanitizedCode,
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
            if (!isRetainedPolicyChange(error)) {
              rethrowClassifiedRunError(error, exec.signal, runtime)
            }
            await host.releaseOwner(owner)
            // 重跑会重建常驻环境，owner 必须重新登记，否则新环境没人释放。
            host.stateOwner(exec.agent)
            try {
              result = await attempt()
            } catch (retryError: unknown) {
              rethrowClassifiedRunError(retryError, exec.signal, runtime)
            }
          }
        } finally {
          runController.abort(runToolName + ' settled')
          await lane.drain()
          untrackRun()
        }

        const hasStructuredOutput = Array.isArray(result.output)
        const outputBlocks: readonly PtcOutputBlock[] = hasStructuredOutput ? result.output! : []
        const hasImages = outputBlocks.some((block) => block.type === 'image')
        // 兜底未被 `inspect(img)` 显式消费的 `PtcImage`：自动通过 `deferContext` 补发，杜绝模型漏写 `inspect` 时丢图。
        if (deferredProgramImages.length > 0) {
          const inspectedIds = new Set<string>()
          for (const block of outputBlocks) {
            if (block.type === 'image' && isImageAttachmentRefLike(block.attachment)) {
              inspectedIds.add(block.attachment.attachmentId)
            }
          }
          for (const pending of deferredProgramImages) {
            if (pending.attachmentId !== undefined && inspectedIds.has(pending.attachmentId)) continue
            const imageMsg = host.createImageContext?.(pending.content)
            if (imageMsg !== undefined) exec.deferContext?.(imageMsg)
          }
        }

        if (result.error !== undefined) {
          const limitError = runController.signal.reason instanceof ToolCallLimitExceededError
            ? runController.signal.reason
            : undefined
          if (result.error.kind === 'abort' && exec.signal.aborted && limitError === undefined) {
            const message = runtime.retainsState ? `tool call aborted: ${result.error.message}` : 'tool call aborted'
            const abortError = new HarnessError(message, 'ABORTED')
            abortError.name = 'AbortError'
            throw abortError
          }
          if (hasImages && typeof exec === 'object' && exec !== null) {
            inspections.set(exec, {
              blocks: renderFailureOutputBlocks(outputBlocks),
              appendToError: true,
            })
          }
          const capturedLogs = extractCapturedErrorText(result, hasImages)
          const logsText = capturedLogs.length > 0
            ? '\nCaptured output:\n' + capturedLogs
            : ''
          const sandboxText = result.sandbox === undefined
            ? ''
            : '\nFile sandbox: ' + result.sandbox.mode
              + (result.sandbox.enforcement === undefined ? '' : '; enforcement: ' + result.sandbox.enforcement)
              + (result.sandbox.denied ? '; operation denied' : '') + '.'
          const hint = result.sandbox?.denied ? escalationGuidance(runtime.sandboxMode) : ''
          const failureText = limitError === undefined || limitError.message === result.error.message
            ? result.error.message
            : `${limitError.message}\n${result.error.message}`
          throw new CodeRunFailedError('program failed (' + result.error.kind + '): ' + failureText + logsText + sandboxText + hint)
        }
        const logs = extractLogsList(result)
        // 新代 scoped-repl 若已产生显式 output（inspect / stdout / 图片），不再回传末尾隐式完成值，
        // 避免末尾赋值语句（如状态缓存）重复输出或将巨型对象打入上下文；空 output 时保留完成值直出。
        const effectiveValue = hasStructuredOutput && hasExplicitOutputBlocks(outputBlocks)
          ? undefined
          : result.value
        const output: TransportOutput = {
          logs,
          ...(effectiveValue === undefined ? {} : { result: effectiveValue }),
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
        if (hasStructuredOutput) {
          structuredOutputs.set(output, outputBlocks)
          if (hasImages && typeof exec === 'object' && exec !== null) {
            inspections.set(exec, {
              blocks: renderStructuredOutputBlocks(
                outputBlocks,
                effectiveValue,
                output.sandbox,
                runtime.sandboxMode,
                runToolName,
              ),
            })
          }
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

/** 判断运行时是否显式不支持单次沙箱提权参数（Python 运行时或显式声明 `sandboxMode: undefined`）。 */
function isStrictSandboxUnsupported(runtime: PtcRuntimeLike): boolean {
  return runtime.language === 'python'
    || (Object.prototype.hasOwnProperty.call(runtime, 'sandboxMode') && runtime.sandboxMode === undefined)
}

/** 将 `attempt()` 阶段的底层运行异常按上游 `ptc.ts:668` 契约分类并抛出。 */
function rethrowClassifiedRunError(error: unknown, execSignal: AbortSignal, runtime: PtcRuntimeLike): never {
  if (error instanceof HarnessError) throw error
  if (execSignal.aborted) {
    const message = runtime.retainsState ? `tool call aborted: ${messageOf(error)}` : 'tool call aborted'
    const abortError = new HarnessError(message, 'ABORTED')
    abortError.name = 'AbortError'
    throw abortError
  }
  throw new CodeRunFailedError('code run failed: ' + messageOf(error), { cause: error })
}

/** 判定结构化 `result.output` 是否已经包含显式输出（图片或非空文本）。 */
function hasExplicitOutputBlocks(blocks: readonly PtcOutputBlock[]): boolean {
  return blocks.some((block) =>
    block.type === 'image' || (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0),
  )
}

function modeOfPolicy(policy: unknown): string | undefined {
  if (typeof policy !== 'object' || policy === null) return undefined
  const mode = (policy as { mode?: unknown }).mode
  return typeof mode === 'string' ? mode : undefined
}

function hasImageBlock(content: readonly unknown[]): boolean {
  return content.some((block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
}

function firstImageAttachmentOf(content: readonly unknown[]): PtcImageAttachmentRefLike | undefined {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { readonly type?: unknown; readonly attachment?: unknown }
    if (record.type === 'image' && isImageAttachmentRefLike(record.attachment)) {
      return record.attachment
    }
  }
  return undefined
}

/**
 * 从运行结果提取面向 `TransportOutput.logs` 的字符串数组（兼容旧代 `logs` 与新代 `output`）。
 */
function extractLogsList(result: PtcRunResultLike): string[] {
  if (Array.isArray(result.logs)) return [...result.logs]
  if (!Array.isArray(result.output)) return []
  const logs: string[] = []
  for (const block of result.output) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const trimmed = block.text.endsWith('\n') ? block.text.slice(0, -1) : block.text
    if (trimmed.length > 0) logs.push(trimmed)
  }
  return logs
}

/**
 * 提取运行失败时内联在 `CodeRunFailedError.message` 中的已捕获文本。
 *
 * 当新代 `result.output` 含有图片块时，报错前的文本与图片已通过 `projectContent` 按序附在
 * 错误内容块之后，错误消息本身不再重复拼接 `Captured output:`（对齐内核 `ptc.ts:783`）。
 */
function extractCapturedErrorText(result: PtcRunResultLike, hasImages: boolean): string {
  if (hasImages) return ''
  if (Array.isArray(result.logs) && result.logs.length > 0) {
    return result.logs.join('\n')
  }
  if (!Array.isArray(result.output) || result.output.length === 0) return ''
  const joined = result.output
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  return joined.endsWith('\n') ? joined.slice(0, -1) : joined
}

/**
 * 将新代 `result.output` 渲染为有序图文内容块列表（对齐内核 `ptc.ts` 的 `renderRunOutput`）。
 */
function renderStructuredOutputBlocks(
  blocks: readonly PtcOutputBlock[],
  resultValue: unknown,
  sandbox: PtcSandboxSummary | undefined,
  sandboxMode: unknown,
  runToolName: string,
): { readonly type: string; readonly [key: string]: unknown }[] {
  const out: { readonly type: string; readonly [key: string]: unknown }[] = []
  let pendingText = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      pendingText += block.text
    } else if (block.type === 'image' && block.attachment !== undefined) {
      if (pendingText.length > 0) {
        out.push({ type: 'text', text: pendingText })
        pendingText = ''
      }
      out.push({ type: 'image', attachment: block.attachment })
    }
  }
  const renderedValue = !hasExplicitOutputBlocks(blocks) && resultValue !== undefined
    ? renderProgramValue(resultValue)
    : ''
  if (renderedValue.length > 0) {
    pendingText = pendingText.length === 0
      ? renderedValue
      : (pendingText.endsWith('\n') ? pendingText + renderedValue : pendingText + '\n' + renderedValue)
  }
  const sandboxNotes: string[] = []
  if (sandbox?.enforcement === 'partial') {
    sandboxNotes.push('File sandbox enforcement is partial on this host.')
  }
  if (sandbox?.denied === true) {
    sandboxNotes.push('The ' + sandbox.mode + ' file sandbox denied an operation.' + escalationGuidance(sandboxMode))
  }
  if (sandboxNotes.length > 0) {
    const noteText = sandboxNotes.join('\n')
    pendingText = pendingText.length === 0
      ? noteText
      : (pendingText.endsWith('\n') ? pendingText + noteText : pendingText + '\n' + noteText)
  }
  if (out.length === 0 && pendingText.endsWith('\n')) {
    pendingText = pendingText.slice(0, -1)
  }
  if (pendingText.length > 0) {
    out.push({ type: 'text', text: pendingText })
  }
  if (out.length === 0) {
    return [{ type: 'text', text: '(' + runToolName + ' completed with no output)' }]
  }
  return out
}

/**
 * 将失败运行已捕获的图文输出块合并为追加在错误块之后的投影块（对齐内核 `ptc.ts`）。
 */
function renderFailureOutputBlocks(
  blocks: readonly PtcOutputBlock[],
): { readonly type: string; readonly [key: string]: unknown }[] {
  const out: { readonly type: string; readonly [key: string]: unknown }[] = []
  let pendingText = ''
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      pendingText += block.text
    } else if (block.type === 'image' && block.attachment !== undefined) {
      if (pendingText.length > 0) {
        out.push({ type: 'text', text: pendingText })
        pendingText = ''
      }
      out.push({ type: 'image', attachment: block.attachment })
    }
  }
  if (pendingText.length > 0) {
    out.push({ type: 'text', text: pendingText })
  }
  return out
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
    throw new SandboxEscalationError('invalid escalation: sandbox_permissions requires a justification', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new SandboxEscalationError('invalid escalation: justification is only valid together with sandbox_permissions', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  }
  if (sandboxPermissions === undefined && justification === undefined) {
    return {}
  }
  if (typeof sandboxPermissions !== 'string' || !(ESCALATION_TARGETS as readonly string[]).includes(sandboxPermissions)) {
    throw new SandboxEscalationError('invalid sandbox_permissions: expected "workspace-write" or "danger-full-access"', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  }
  if (typeof justification !== 'string' || justification.trim().length === 0) {
    throw new SandboxEscalationError('invalid justification: expected a non-empty sentence', 'SANDBOX_ESCALATION_INVALID_ARGUMENT')
  }
  return {
    sandboxPermissions: sandboxPermissions as EscalationTargetMode,
    justification,
  }
}

/** 程序源码可能出现的键名。模型偶尔把源码写进 `program` / `source` / `script`。 */
const CODE_KEYS: readonly string[] = Object.freeze([
  'code', 'program', 'source', 'script', 'code_run', 'codecode', 'program_source', 'programSource',
])

/** 模型把「先汇报再执行」写成一次调用时，简报落在 `progress_update` 的那两个键上。 */
const NARRATION_TITLE_KEY = 'title'

/** 见 {@link NARRATION_TITLE_KEY}。 */
const NARRATION_MESSAGE_KEY = 'message'

/** 回显原始参数时最多带多少字符。 */
const RAW_EXCERPT_LIMIT = 120

/** 模型在同一次调用里顺手写的进展简报。 */
interface Narration {
  /** 简报标题。 */
  readonly title: string
  /** 简报正文。 */
  readonly message: string
}

/** 参数是怎么读出来的：原生对象、字符串里的 JSON、两段拼接、从损坏负载里补读的字段、或只有一段纯程序。 */
type ArgumentsOrigin = 'object' | 'json' | 'fused' | 'spliced' | 'bare'

/** 一次参数解析的结果。 */
interface ParsedArguments {
  /** 已解析的参数对象。 */
  readonly record: Record<string, unknown>
  /** 从融合文本里救回来的进展简报。 */
  readonly narration?: Narration
  /** 参数的来源形态。 */
  readonly origin: ArgumentsOrigin
  /** 原始参数的文本形态，只用于错误回显。 */
  readonly raw: string
}

/** 校验并读出的工具入参。 */
interface TransportInput {
  /** 程序源码。 */
  code: string
  /** 一句话描述（缺失时从源码首行或简报标题兜底）。 */
  description: string
  /** 单次运行的时间预算。 */
  timeoutMs?: number
  /** 未经配对校验的原始 `sandbox_permissions` 入参。 */
  rawSandboxPermissions?: unknown
  /** 未经配对校验的原始 `justification` 入参。 */
  rawJustification?: unknown
  /** 需要补发的进展简报。 */
  narration?: Narration
}

/** 一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 尝试解析一段 JSON 文本。 */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * 切出一段文本里的顶层平衡 JSON 对象片段。
 *
 * 模型偶尔把两次调用的参数写进同一段文本（`{"title":…,"message":…}{"code":…}`），
 * 整段 `JSON.parse` 必然失败；按花括号配对切出来的每一段却都还能解析，程序因此可救。
 *
 * @param text - 待切分的原始参数文本。
 * @returns 按出现顺序排列的片段（字符串内的花括号不算）。
 */
function topLevelJsonObjects(text: string): string[] {
  const fragments: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (ch !== '}') continue
    if (depth === 0) continue
    depth -= 1
    if (depth === 0 && start >= 0) {
      fragments.push(text.slice(start, index + 1))
      start = -1
    }
  }
  return fragments
}

/** 从一个参数对象里读出程序源码。 */
function codeOf(record: Record<string, unknown>): string | undefined {
  for (const key of CODE_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** 从一个参数对象里读出进展简报（`title` / `message` 至少有一个）。 */
function narrationOf(record: Record<string, unknown>): Narration | undefined {
  const title = stringOf(record[NARRATION_TITLE_KEY])
  const message = stringOf(record[NARRATION_MESSAGE_KEY])
  if (title === undefined && message === undefined) return undefined
  const lead = title ?? message!.slice(0, 40)
  return { title: lead, message: message ?? title! }
}

/** 一个非空字符串（**不裁剪**内容，源码要原样送出）。 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** 错误回显里的一段原始文本。 */
function excerpt(text: string): string {
  const flat = text.replace(/[\r\n]+/g, '⏎').replace(/\s+/g, ' ').trim()
  return flat.length <= RAW_EXCERPT_LIMIT ? flat : flat.slice(0, RAW_EXCERPT_LIMIT) + '…'
}

/** 参数完全不成形时的错误。 */
function invalidArgumentsError(args: unknown, raw: string, keys?: readonly string[]): Error {
  const head = 'codemode: invalid arguments: expected an object with "code" and "description"'
  if (args === null) return new CodemodeArgsError(head + ' (received null)')
  if (typeof args !== 'string') return new CodemodeArgsError(head + ' (received ' + typeof args + ')')
  if (keys !== undefined && keys.length > 0) return new CodemodeArgsError(head + ' (received keys: ' + keys.join(', ') + ')')
  if (raw.trim().length === 0) return new CodemodeArgsError(head + ' (received an empty string)')
  return new CodemodeArgsError(head + ' (received a string that is not a JSON object: ' + excerpt(raw) + ')')
}

/** 参数里没有程序源码、又不是可救形态时的错误。 */
function missingCodeError(record: Record<string, unknown>, raw: string): Error {
  const keys = Object.keys(record)
  const note = keys.length === 0
    ? ''
    : ' (received keys: ' + keys.join(', ')
      + (raw.trim().length > 0 ? '; raw: ' + excerpt(raw) : '')
      + '; pass program source in "code")'
  return new CodemodeArgsError('codemode: invalid code: expected a non-empty string' + note)
}

/** 一段文本像不像程序源码（模型把源码直接发成字符串时判这个）。 */
function looksLikeProgram(text: string): boolean {
  return text.includes('\n') || /\b(await|return|const|let|function|import|console\.)\b/.test(text)
}

/**
 * 参数文本像不像一次**被切坏**的工具调用。
 *
 * 审计里量到的真实形态（`opendesign/deepseek-v4.1-flash-eco`）：
 * `{"code_badge_none">\n</｜｜DSML｜｜: "…", "code": "<完整程序>"}` —— 对象头被网关或模型的
 * DSML 残留污染，但 `"code"` 的值本身是好的。这种文本如果落到「纯程序文本」兜底，会被整段
 * 当源码编译，报一个与真实原因无关的语法错，还丢掉那段能跑的程序。
 *
 * 只认两种证据：以 `{"` 开头的对象形态（合法游离程序不会这样开头），或正文里带 DSML 残留。
 * 不用泛化的 `</` 判据——一段真程序里写 HTML 字符串是正常的。
 *
 * @param text - 已裁剪首尾空白的参数文本。
 * @returns 是否按「损坏负载」处理。
 */
function looksDamagedArguments(text: string): boolean {
  return text.startsWith('{"') || text.includes('DSML') || text.includes('\uff5c')
}

/**
 * 从一段不保证合法的文本里取出一个 JSON 字符串成员的值。
 *
 * 键名必须带引号（`"code": "…"`），值必须是**完整闭合**的 JSON 字符串字面量；扫描器按
 * JSON 的转义规则走，遇到未转义的 `"` 才收尾，再从该字面量 `JSON.parse` 解码，
 * 因此不会被值内部的引号或反斜杠骗到。
 *
 * @param text - 待扫描的文本。
 * @param key - 成员键名（不带引号）。
 * @returns 解码后的字符串，或找不到 / 解不开时为 `undefined`。
 */
function splicedMember(text: string, key: string): string | undefined {
  const needle = '"' + key + '"'
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return undefined
    from = at + needle.length
    let index = from
    while (index < text.length && /\s/.test(text.charAt(index))) index += 1
    if (text.charAt(index) !== ':') continue
    index += 1
    while (index < text.length && /\s/.test(text.charAt(index))) index += 1
    if (text.charAt(index) !== '"') continue
    const start = index
    index += 1
    let escaped = false
    while (index < text.length) {
      const ch = text.charAt(index)
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        const value = tryJson(text.slice(start, index + 1))
        if (typeof value === 'string') return value
        break
      }
      index += 1
    }
  }
}

/** 参数是「被切坏的 JSON」时的错误：说明形态，并把下一步写清楚。 */
function damagedArgumentsError(args: unknown, raw: string): Error {
  return new CodemodeArgsError(invalidArgumentsError(args, raw).message
    + '; the payload looks damaged (embedded tool-call markup or a truncated JSON object)'
    + ' — resend one complete call with "code" holding the program source')
}

/** 从源码首行兜底出一句描述。 */
function descriptionFromCode(code: string): string {
  const first = code.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const cleaned = first.replace(/^(\/\/|#)\s*/, '').slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'code program'
}

/**
 * 把工具收到的原始参数读成一个对象。
 *
 * ## 为什么要容错
 *
 * 模型有四种真实存在的发送形态，照搬内核 PTC 的严格 schema 会把它们全判死：
 *
 * 1. **原生对象**（正常）；
 * 2. **字符串里的 JSON**（执行器把解析失败的文本原样传下来）；
 * 3. **两段 JSON 拼接**——`{"title":…,"message":…}{"code":…}`，模型想在同一次调用里
 *    既汇报又执行，整段解析必失败，但按花括号切开后两段都合法（实测 7/7 可救）；
 * 4. **只有一段纯程序**（模型直接把源码当参数发）。
 *
 * @param args - 工具收到的原始参数。
 * @returns 参数对象、可选的简报与来源形态。
 */
function parseArguments(args: unknown): ParsedArguments {
  if (isRecord(args)) return { record: args, origin: 'object', raw: '' }
  if (typeof args !== 'string') throw invalidArgumentsError(args, '')
  const raw = args
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw invalidArgumentsError(args, raw)

  const parsed = tryJson(trimmed)
  if (isRecord(parsed)) {
    const narration = narrationOf(parsed)
    return { record: parsed, origin: 'json', raw, ...narration === undefined ? {} : { narration } }
  }
  if (Array.isArray(parsed)) {
    const hit = parsed.find((entry) => isRecord(entry) && codeOf(entry) !== undefined)
    if (isRecord(hit)) {
      const narration = narrationOf(hit)
      return { record: hit, origin: 'json', raw, ...narration === undefined ? {} : { narration } }
    }
  }

  // 融合形态：模型把两次调用的参数连写了。挑**最后一个**装了源码的对象，前面那段当简报。
  const fragments = topLevelJsonObjects(trimmed)
  let chosen: Record<string, unknown> | undefined
  let narration: Narration | undefined
  for (const fragment of fragments) {
    const value = tryJson(fragment)
    if (!isRecord(value)) continue
    if (codeOf(value) !== undefined) {
      chosen = value
      narration ??= narrationOf(value)
      continue
    }
    narration ??= narrationOf(value)
  }
  if (chosen !== undefined) {
    return {
      record: chosen,
      origin: fragments.length > 1 ? 'fused' : 'json',
      raw,
      ...narration === undefined ? {} : { narration },
    }
  }

  // 损坏负载：还没被上面任何一条救回来的 `{"…"` 形态。先按字段补读——对象头被切坏时，
  // `"code"` 的值常常仍是完整的（实测那条 878 字符程序可以直接编译）；补不出来就明确拒绝，
  // 绝不把整段污染文本送进求值器。
  if (looksDamagedArguments(trimmed)) {
    const code = splicedMember(trimmed, 'code')
    if (code !== undefined && code.trim().length > 0) {
      const description = stringOf(splicedMember(trimmed, 'description'))?.trim()
        ?? stringOf(splicedMember(trimmed, 'summary'))?.trim()
      return {
        record: { code, ...description === undefined ? {} : { description } },
        origin: 'spliced',
        raw,
      }
    }
    throw damagedArgumentsError(args, raw)
  }

  // 纯程序文本：比严格 schema 多救一种形态，比拒绝多给模型一次机会。
  if (looksLikeProgram(trimmed)) return { record: { code: raw }, origin: 'bare', raw }

  throw invalidArgumentsError(args, raw, keysOf(fragments))
}

/** 把若干 JSON 片段里出现过的键并起来（错误回显用）。 */
function keysOf(fragments: readonly string[]): string[] {
  const keys = new Set<string>()
  for (const fragment of fragments) {
    const value = tryJson(fragment)
    if (!isRecord(value)) continue
    for (const key of Object.keys(value)) keys.add(key)
  }
  return [...keys]
}

/** 校验并读出工具参数。 */
function readArguments(args: unknown): TransportInput {
  const parsed = parseArguments(args)
  const record = parsed.record
  const code = codeOf(record)
  if (code === undefined) throw missingCodeError(record, parsed.raw)
  // `description` 是界面卡片标题与回放的可读性来源；模型漏发时按「summary → 简报标题 →
  // 源码首行」兜底，而不是把整段程序退回去重写——回退的成本远高于自动兜底。
  const description = stringOf(record['description'])?.trim()
    ?? stringOf(record['desc'])?.trim()
    ?? stringOf(record['summary'])?.trim()
    ?? parsed.narration?.title
    ?? descriptionFromCode(code)
  const timeoutMs = record['timeoutMs']
  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CodemodeArgsError('codemode: invalid timeoutMs: expected a positive finite number')
    }
  }
  const rawSandboxPermissions = record['sandbox_permissions']
  const rawJustification = record['justification']
  return {
    code,
    description,
    ...timeoutMs === undefined ? {} : { timeoutMs },
    ...rawSandboxPermissions === undefined ? {} : { rawSandboxPermissions },
    ...rawJustification === undefined ? {} : { rawJustification },
    ...parsed.narration === undefined ? {} : { narration: parsed.narration },
  }
}

/**
 * 把救回来的进展简报补发成一次 `progress_update`。
 *
 * 简报只影响界面，因此这里的任何失败都被吞掉：发不出去（没有投影、没有服务端、外层已取消）
 * 绝不能连累这次程序。
 *
 * @param host - 运行环境句柄。
 * @param narration - 从融合参数里救回来的简报。
 * @param exec - 本次执行上下文。
 * @param signal - 已带嵌套标记的取消信号。
 */
async function forwardNarration(
  host: CodemodeHost,
  narration: Narration,
  exec: TransportExecution,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!host.catalog().some((entry) => entry.name === PROGRESS_UPDATE_TOOL)) return
    await host.callTool({
      name: PROGRESS_UPDATE_TOOL,
      args: { title: narration.title, message: narration.message },
      // `:ptc:0`：程序自己的子调用从 `:ptc:1` 起编号，两者不会撞车。
      callId: String(exec.callId) + NESTED_CALL_ID_MARKER + '0',
      signal,
      agent: exec.agent,
      toolSet: exec.toolSet,
    })
  } catch {
    // 见函数文档：简报是界面提示，不是运行结果。
  }
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

/**
 * 归一化子调用参数并生成两份独立深拷贝（`dispatched` 供工具执行，`logged` 供回放落盘），
 * 防止工具内部原地修改 `args` 对象污染 `tool/ptc-dispatch` 回放日志（对齐内核 `ptc.ts:864`）。
 */
function normalizeSubCallArgsPair(
  entry: CatalogEntry | undefined,
  rawArgs: unknown,
): { readonly dispatched: unknown; readonly logged: unknown } {
  const normalized = normalizeSubCallArgs(entry, losslessArgs(rawArgs))
  const serialized = JSON.stringify(normalized)
  return {
    dispatched: JSON.parse(serialized) as unknown,
    logged: JSON.parse(serialized) as unknown,
  }
}

/**
 * 在常驻 REPL（`repl` / `scoped-repl` / `script`）模式下自动剥离模型误写的末尾顶层 `return`。
 *
 * DSH 0.2.2-rc.2 起常驻模式默认使用 `scoped-repl`（直接作为顶层脚本求值，不再套外层 `async function`），
 * 顶层 `return` 会触发编译期 `SyntaxError: Return statement is not allowed here`。此函数仅在最后一条
 * 顶层语句（括号深度为 0）以 `return` 开头且其后无其他顶层语句时，将其安全改写为顶层末尾表达式（若以
 * `{` 开头则包裹 `(...)` 避免被解析为代码块），既保住顶层绑定跨调用存活，又保留末尾表达式的完成值。
 */
export function sanitizeReplTopLevelReturn(
  code: string,
  programFormat: string | undefined,
  language: string | undefined,
): string {
  if (language === 'python' || !isReplFormat(programFormat)) return code
  let depth = 0
  let lastTopReturn = -1
  let i = 0
  const len = code.length
  while (i < len) {
    const ch = code[i]!
    if (ch === '/' && code[i + 1] === '/') {
      i += 2
      while (i < len && code[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedLiteral(code, i)
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(code, i + 1)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth > 0) depth -= 1
      i += 1
      continue
    }
    if (depth === 0 && ch === 'r' && code.startsWith('return', i)) {
      const prev = i > 0 ? code[i - 1]! : ''
      const next = i + 6 < len ? code[i + 6]! : ''
      if (!isIdentOrDotChar(prev) && !isIdentChar(next)) {
        lastTopReturn = i
        i += 6
        continue
      }
    }
    i += 1
  }

  if (lastTopReturn < 0) return code
  const tail = analyzeTopLevelReturnTail(code, lastTopReturn + 6)
  if (tail === undefined) return code

  const expr = code.slice(tail.exprStart, tail.exprEnd).trim()
  const prefix = code.slice(0, lastTopReturn)
  const suffix = code.slice(tail.statementEnd)
  if (expr.length === 0) {
    return prefix + 'undefined' + suffix
  }
  if (expr.startsWith('{')) {
    return prefix + '(' + expr + ')' + suffix
  }
  return prefix + expr + suffix
}

function isIdentChar(ch: string): boolean {
  return ch.length > 0 && /[A-Za-z0-9_$]/.test(ch)
}

function isIdentOrDotChar(ch: string): boolean {
  return ch === '.' || isIdentChar(ch)
}

function skipQuotedLiteral(code: string, start: number): number {
  const quote = code[start]!
  let i = start + 1
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] === quote) return i + 1
    i += 1
  }
  return i
}

function skipTemplateLiteral(code: string, startAfterBacktick: number): number {
  let i = startAfterBacktick
  const len = code.length
  while (i < len) {
    const ch = code[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') return i + 1
    if (ch === '$' && code[i + 1] === '{') {
      i += 2
      let braceDepth = 1
      while (i < len && braceDepth > 0) {
        const inner = code[i]!
        if (inner === "'" || inner === '"') {
          i = skipQuotedLiteral(code, i)
          continue
        }
        if (inner === '`') {
          i = skipTemplateLiteral(code, i + 1)
          continue
        }
        if (inner === '{') braceDepth += 1
        else if (inner === '}') braceDepth -= 1
        i += 1
      }
      continue
    }
    i += 1
  }
  return i
}

function analyzeTopLevelReturnTail(
  code: string,
  afterReturn: number,
): { readonly exprStart: number; readonly exprEnd: number; readonly statementEnd: number } | undefined {
  const len = code.length
  let i = afterReturn
  while (i < len && (code[i] === ' ' || code[i] === '\t')) i += 1
  const exprStart = i
  let depth = 0
  let semiPos = -1
  while (i < len) {
    const ch = code[i]!
    if (ch === '/' && code[i + 1] === '/') {
      i += 2
      while (i < len && code[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      i += 2
      while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedLiteral(code, i)
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(code, i + 1)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      i += 1
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return undefined
      depth -= 1
      i += 1
      continue
    }
    if (depth === 0 && ch === ';') {
      semiPos = i
      i += 1
      break
    }
    i += 1
  }
  if (depth !== 0) return undefined
  if (semiPos >= 0) {
    // 顶层分号之后只允许空白与注释；若还有其他语句，说明该 return 不是末尾唯一语句。
    while (i < len) {
      const ch = code[i]!
      if (/\s/.test(ch)) {
        i += 1
        continue
      }
      if (ch === '/' && code[i + 1] === '/') {
        i += 2
        while (i < len && code[i] !== '\n') i += 1
        continue
      }
      if (ch === '/' && code[i + 1] === '*') {
        i += 2
        while (i < len && !(code[i] === '*' && code[i + 1] === '/')) i += 1
        i += 2
        continue
      }
      return undefined
    }
    return { exprStart, exprEnd: semiPos, statementEnd: semiPos + 1 }
  }
  return { exprStart, exprEnd: len, statementEnd: len }
}

/** 内置按单文件 `file_path` 寻址的工具名。 */
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'read_image'])

/** 内置按目录/目标 `path` 寻址的检索工具名。 */
const SEARCH_PATH_TOOLS: ReadonlySet<string> = new Set(['glob', 'grep'])

/**
 * 宿主层子调用入参别名容错：把模型在 `code_run` 内高频写错的参数键名映射到工具真实声明的键名。
 *
 * 审计证据（`session-e190c243` seq 171-182 等）：模型在 `Promise.all` 里容易把 `tools.read` 的
 * `file_path` 写成 `glob`/`grep` 的 `path`（或反过来），或者把 snake_case 写成 camelCase，导致整段
 * 程序因单个属性名不匹配而抛 `ToolCallError: invalid arguments: missing required property "file_path"`。
 *
 * 规则：仅当目标规范键尚未提供（`=== undefined`）、别名键存在且类型匹配、且别名键本身不是该工具声明的
 * 独立参数时，才把值搬运到规范键并删掉多余别名键（防止 `additionalProperties: false` 拒收）。
 *
 * @param entry - 工具清单条目（含参数 schema）。
 * @param value - 已脱离引用的 JSON 参数值。
 * @returns 归一化后的参数值。
 */
export function normalizeSubCallArgs(entry: CatalogEntry | undefined, value: unknown): unknown {
  if (!isRecord(value)) return value
  const name = entry?.name ?? ''
  const schemaProps = isRecord(entry?.parameters) && isRecord((entry.parameters as { properties?: unknown }).properties)
    ? ((entry.parameters as { properties: Record<string, unknown> }).properties)
    : undefined
  const declares = (key: string): boolean => schemaProps !== undefined && Object.prototype.hasOwnProperty.call(schemaProps, key)

  const out: Record<string, unknown> = { ...value }
  const remap = (target: string, aliases: readonly string[], predicate: (v: unknown) => boolean): void => {
    if (out[target] !== undefined) return
    for (const alias of aliases) {
      if (declares(alias)) continue
      const candidate = out[alias]
      if (predicate(candidate)) {
        out[target] = candidate
        delete out[alias]
        return
      }
    }
  }

  const isString = (v: unknown): boolean => typeof v === 'string'
  const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  const isBoolean = (v: unknown): boolean => typeof v === 'boolean'

  if (FILE_PATH_TOOLS.has(name) || (declares('file_path') && !declares('path'))) {
    remap('file_path', ['path', 'filePath'], isString)
  } else if (SEARCH_PATH_TOOLS.has(name) || (declares('path') && !declares('file_path'))) {
    remap('path', ['file_path', 'filePath'], isString)
  }

  if (name === 'edit' || declares('old_string') || declares('new_string')) {
    remap('old_string', ['oldString'], isString)
    remap('new_string', ['newString'], isString)
    remap('replace_all', ['replaceAll'], isBoolean)
  }

  if (name === 'win_bash' || declares('workdir')) {
    remap('workdir', ['cwd', 'workingDirectory', 'working_directory'], isString)
    remap('timeoutMs', ['timeout_ms'], isNumber)
    remap('run_in_background', ['runInBackground'], isBoolean)
  }

  if (name === 'job_output' || name === 'job_kill' || declares('job_id')) {
    remap('job_id', ['jobId'], isString)
    if (name === 'job_output' || declares('timeout_ms')) {
      remap('timeout_ms', ['timeoutMs'], isNumber)
    }
  }

  return out
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
 * 子调用的并发、提交顺序与互斥屏障（对齐内核 `ptc.ts` 的 ordered commit lane + `logWork` 背压）。
 *
 * - `classify()` 在队列头部真正出队启动时惰性求值，保证前序调用产生的状态变更可被观察；
 * - `start()`（记 start 事件 + 启动 body）在 lane 里按提交顺序执行：`parallel` body 之间
 *   可以并发重叠，最多 `maxParallel` 个同时在飞；
 * - `commit()`（转发图片/附加上下文 + `concludeTurn` + 放行互斥屏障）按**提交顺序**逐条执行，
 *   并在同步完成上下文挂载后**立刻**将结果返回给程序；`shapeDispatchLog` 与 settle 事件作为
 *   有序后台 `logWork` 执行，超出 `maxParallel` 时在提交车道施加背压；
 * - `exclusive` 调用等所有在飞 body 结算后独占运行，并独占到自己 commit 完成才放行后续；
 * - 排队期间若外层运行已中止，直接放弃且不启动任务（未启动调用零 `start` 事件）；
 * - `drain()` 等到 lane 彻底静止且所有后台 `logWork` 落盘完成才返回。
 *
 * @param maxParallel - 同时在飞的上限（同时作为 `logWork` 背压上限）。
 * @param isAborted - 外层运行是否已中止。
 * @returns 调度入口与排空。
 */
function createCommitLane(maxParallel: number, isAborted: () => boolean) {
  /** body 的结局：成功值或抛出的错误。 */
  type Parked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  /** 入队一条按提交顺序串行化落盘的异步日志任务。 */
  type EnqueueLog = (work: () => Promise<void>) => void
  interface Task<T, R> {
    /** 启动前惰性判定并发模式（默认按入参决定）。 */
    classify?(): 'parallel' | 'exclusive'
    /** 有序预执行：记 start 事件。 */
    start(): void
    /** 并发执行的 body：真正调用工具。 */
    body(): Promise<T>
    /** 有序提交：转发上下文、登记后台回放落盘、并立即给出程序拿到的值。 */
    commit(parked: Parked<T>, enqueueLog: EnqueueLog): R | Promise<R>
    /** 排队中被放弃（运行已结束）时抛出的错误。 */
    abandon(): never
  }
  interface Entry {
    mode: 'parallel' | 'exclusive'
    classify(): 'parallel' | 'exclusive'
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
  const logWork = new Set<Promise<void>>()
  let logTail: Promise<void> = Promise.resolve()
  let exclusiveActive = false
  let driving = false
  let driverRun: Promise<void> = Promise.resolve()
  let wake: (() => void) | undefined
  const wakeup = (): void => {
    const release = wake
    wake = undefined
    release?.()
  }

  const enqueueLog: EnqueueLog = (work) => {
    const next = logTail.then(work, work)
    logTail = next.catch(() => undefined)
    const tracked: Promise<void> = logTail.finally(() => {
      logWork.delete(tracked)
    })
    logWork.add(tracked)
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
            const mode = head.classify()
            const capacity = !exclusiveActive
              && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < cap)
            if (capacity) {
              head.mode = mode
              if (mode === 'exclusive') exclusiveActive = true
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
    schedule<T, R>(task: Task<T, R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        let parked: Parked<T> | undefined
        const entry: Entry = {
          mode: 'exclusive',
          classify() {
            try {
              return task.classify ? task.classify() : 'exclusive'
            } catch {
              return 'exclusive'
            }
          },
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
              // 程序在此刻立刻拿到子调用返回值（不等待后台 logWork 落盘）。
              resolve(await task.commit(result, enqueueLog))
            } catch (error: unknown) {
              reject(error)
            }
            // 对齐内核 `ptc.ts:633`：当待落盘日志任务超过并发上限时施加背压。
            while (logWork.size > cap) {
              await Promise.race(logWork)
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
      while (logWork.size > 0) {
        await Promise.allSettled([...logWork])
      }
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
