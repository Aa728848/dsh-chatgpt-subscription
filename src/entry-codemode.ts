/**
 * Code Mode 预设行 —— 本包自己的「原生工具 + 程序传输」呈现方式。
 *
 * 这一行挂在 `dispatch` 预设里（见 presets/dispatch/agent.cordis.yml 与 src/host/agent-preset.ts），
 * 因此它注册的工具、它选中的 executor、它提供的提示词段都属于**这个预设的会话**，其它预设
 * 完全不受影响。
 *
 * ## 它替掉了什么
 *
 * 内核的 `ptc` 呈现方式只把 `run_code` 交给模型，其余工具一律硬拒（UNKNOWN_TOOL），
 * `standard` 又完全没有程序传输——「原生工具 + 程序」这个组合在内核里表达不出来。本行用
 * `standard` 的原生工具面 + 自己的 `code_run` 把这个组合重建，再把预设清单以外的工具
 * 挡在上下文之外，只留程序内可达。
 *
 * ## 四件事
 *
 * 1. 注册发现工具（list / search / describe / debug）；
 * 2. 注册程序传输工具 `code_run`；
 * 3. 选一个执行器：`describe()` 丢掉预设清单以外的名字，`execute()` 派发前拒绝模型直呼，
 *    其余整批委托给内核原生执行器（完整策略 / 审批 / post-execute 管线）；
 * 4. 提供**恒定**的 Code Mode 说明段，替换内核那份 SDK 声明段。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/codemode
 */

import * as dshLlm from '@deepseek-ai/dsh-llm'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'

import { PLUGIN_MESSAGE_SOURCE_KIND } from './host/common/llm-compat.ts'
import { createDiscoveryDefinitions } from './host/codemode/discovery.ts'
import { createCodemodeExecutor } from './host/codemode/executor.ts'
import { createRetention } from './host/codemode/retention.ts'
import {
  buildCodemodeSectionText,
  createRules,
  summarizeHidden,
  type CodemodeConfig,
  type CodemodeView,
} from './host/codemode/rules.ts'
import { findScopeKey, resolveCatalogView, resolveNameView } from './host/codemode/scope.ts'
import {
  CodeResetFailedError,
  createTransportDefinition,
  currentCatalogSnapshot,
  isImageAttachmentRefLike,
  PtcImageLike,
  type CallToolOutcome,
  type CallToolRequest,
  type CatalogEntry,
  type CodemodeHost,
  type DispatchLogShape,
  type EscalationTargetMode,
  type PtcRuntimeLike,
  type RunAuthority,
  type SandboxEscalationInput,
} from './host/codemode/transport.ts'

/** Cordis 插件名。 */
export const name = 'codemode'

/** 依赖的服务。 */
export const inject = ['tools', 'systemPrompt']

/** 决策环长度：只留给 `code_debug`。 */
const DEBUG_RING = 50

/** 本行会读到的服务（结构探测，不 import 内核类型）。 */
interface ToolsServiceLike {
  /** 注册一个工具定义。 */
  register(definition: unknown): () => void
  /** 选中本作用域的执行器。 */
  setExecutor(executor: unknown): () => void
  /** 执行一整批调用。 */
  execute(input: unknown): Promise<ToolBatchResultLike>
  /** 按名字解析定义。 */
  get(name: string, scope?: object): unknown
  /** 按调用方作用域与步骤准入枚举可见定义（DSH 0.2.2+）。 */
  definitions?(scope?: unknown, toolSet?: unknown): readonly unknown[]
}

/** 一次批量执行的结果（只读需要的字段）。 */
interface ToolBatchResultLike {
  /** 与入参一一对应的结果。 */
  readonly results: readonly { readonly callId: string; readonly result: ToolResultLike }[]
  /** 需要转发给下一步的附加上下文。 */
  readonly additionalContexts?: readonly unknown[]
  /** 是否有子调用要求结束回合。 */
  readonly concluded?: boolean
}

/** 严格加宽阶梯（对齐 `@deepseek-ai/dsh-sandbox` 的 `WIDER_MODES`）。 */
const WIDER_SANDBOX_MODES: Record<string, readonly EscalationTargetMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/** 宿主审批服务的结构契约。 */
interface ApprovalServiceLike {
  request(req: {
    agent: unknown
    toolName: string
    callId: string
    reason: string
    displayReason?: { readonly en: string; readonly zh?: string }
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** 一条执行结果（只读需要的字段）。 */
interface ToolResultLike {
  /** 是否失败。 */
  readonly isError: boolean
  /** 失败时的结构化错误。 */
  readonly error?: {
    /** 给人看的一句话。 */
    readonly message?: string
    /** 失败身份（名称 / 业务码 / 原始细节），回放事件原样带走。 */
    readonly info?: { readonly name?: unknown; readonly code?: unknown; readonly reason?: unknown }
  }
  /** 成功时的规范值。 */
  readonly value?: unknown
  /** 面向前模型的内容块。 */
  readonly content?: readonly unknown[]
  /** 工具自带的展示元数据，回放事件原样带走。 */
  readonly meta?: unknown
}

/**
 * 装配本行。
 *
 * @param ctx - 预设作用域上的行上下文。
 * @param config - 行配置（{@link CodemodeConfig}）。
 */
export function apply(ctx: unknown, config: CodemodeConfig = {}): void {
  const context = ctx as {
    tools: ToolsServiceLike
    get?: (name: string) => unknown
    logger?: { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void }
    on?: (event: string, listener: (...args: never[]) => unknown, options?: unknown) => unknown
    effect?: (callback: () => unknown, label?: string) => void
    waterfall?: (receiver: unknown, event: string, ...args: unknown[]) => unknown
  }
  const log = (level: 'info' | 'warn' | 'debug', message: string): void => {
    try {
      context.logger?.[level]?.(message)
    } catch {
      // 日志永远不能让一轮对话失败。
    }
  }
  const tools = context.tools
  const runtimeOf = (): PtcRuntimeLike | undefined => {
    try {
      return context.get?.('ptcRuntime') as PtcRuntimeLike | undefined
    } catch {
      return undefined
    }
  }

  /** 读一个内核服务（缺失或未挂载时为 undefined）。 */
  const serviceOf = (name: string): unknown => {
    try {
      return context.get?.(name)
    } catch {
      return undefined
    }
  }

  /**
   * 取会话级运行授权：目录与文件策略都读内核服务，本行只转交、不自己造。
   *
   * `ptcRuntime.run()` 在 DSH 0.2.2 起要求已解析的策略与目录；缺了这两项，程序会带着部署
   * 默认值（通常是 read-only 与部署根目录）执行，或者干脆被运行时拒绝。老代 harness 没有这两个
   * 服务，返回 undefined 让它照旧兜底。
   */
  const runAuthority = async (agent: unknown, signal: AbortSignal): Promise<RunAuthority | undefined> => {
    const authority: { cwd?: string; sandboxPolicy?: unknown } = {}
    const session = typeof agent === 'object' && agent !== null
      ? (agent as { session?: unknown }).session
      : undefined
    const policy = serviceOf('sandboxPolicy') as { resolve?: (request?: { session?: unknown }) => unknown } | undefined
    if (typeof policy?.resolve === 'function') {
      try {
        const resolved = policy.resolve(session === undefined ? {} : { session })
        if (resolved !== undefined) authority.sandboxPolicy = resolved
      } catch {
        // 解析失败不该让 code_run 直接失败：运行时会退回它自己的缺省策略。
      }
    }
    const directories = serviceOf('workingDirectory') as
      | { ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string> }
      | undefined
    if (agent !== undefined && typeof directories?.ensure === 'function') {
      try {
        authority.cwd = await directories.ensure(agent, signal)
      } catch {
        // 目录取不到时让策略里的工作根当起点。
      }
    }
    return authority
  }

  const rules = createRules(config)
  const retention = createRetention(runtimeOf)
  if (typeof context.effect === 'function') {
    context.effect(() => () => { void retention.dispose() }, 'codemode retained environments')
  }

  if (typeof context.on === 'function') {
    try {
      const off = context.on('session/event', retention.cancelOnModeChange as never, { global: true })
      if (typeof context.effect === 'function') {
        context.effect(() => () => {
          if (typeof off === 'function') (off as () => void)()
        }, 'codemode sandbox mode cancellation')
      }
    } catch (error: unknown) {
      log('warn', '[codemode] could not subscribe to session/event; an in-flight code_run keeps running after the session sandbox mode changes: '
        + messageOf(error))
    }
  }

  /**
   * 把一条子调用回放记录交给 `tools/ptc-dispatch-log` 瀑布（内核 `ptc.ts` 的同名钩子）。
   *
   * 监听器的失败必须在这里吞掉：它决定的只是日志副本长什么样，不是程序拿到的结果。内核
   * 用 `scopeTarget(tools, agent)` 当接收方；本包不依赖 `@deepseek-ai/dsh-scope`，直接以
   * `tools` 为接收方——作用域过滤由宿主自己的监听器完成。
   */
  const shapeDispatchLog = async (dispatch: DispatchLogShape): Promise<readonly unknown[]> => {
    const waterfall = context.waterfall
    if (typeof waterfall !== 'function') return dispatch.content
    try {
      const shaped = await waterfall.call(
        context,
        tools,
        'tools/ptc-dispatch-log',
        dispatch,
        () => Promise.resolve(dispatch.content),
      )
      return Array.isArray(shaped) ? shaped : dispatch.content
    } catch (error: unknown) {
      log('warn', 'tools: ptc-dispatch-log listener failed for ' + dispatch.name + ': '
        + messageOf(error) + '; logging the original settled content')
      return dispatch.content
    }
  }

  const scopeKey = findScopeKey(ctx)
  if (rules.options.nativeScope && scopeKey === undefined) {
    log('warn', '[codemode] no registry scope tag on this context: masking falls back to name rules only ('
      + rules.options.hiddenPrefixes.join(', ') + '). Mount this row inside an agent preset to hide every tool the preset does not own.')
  }

  /** 最近一次 describe 收到的完整定义集（含被遮蔽的），作为无 `tools.definitions` 时的回退快照。 */
  let catalog: CatalogEntry[] = []
  const debugRing: unknown[] = []
  let firstDescribeLogged = false

  /**
   * 解析当前调用方 agent 与步骤准入下的工具清单（对齐内核 `ptc.ts:662`）。
   *
   * 优先通过 `ctx.tools.definitions(agent, toolSet)` 实时读取调用方自己的可见集合（含
   * `agent.ctx` 专属工具与 `tools.restrict` 过滤），避免多会话并发时被另一个会话的
   * `describe()` 覆盖；测试替身未提供 `definitions` 时回退到最近一次 `catalog`。
   */
  const resolveCatalog = (agent?: unknown, toolSet?: unknown): readonly CatalogEntry[] => {
    if (agent !== undefined && typeof tools.definitions === 'function') {
      try {
        const defs = tools.definitions(agent, toolSet)
        if (Array.isArray(defs) && defs.length > 0) {
          const entries = defs.map(toCatalogEntry).filter((entry): entry is CatalogEntry => entry !== undefined)
          if (entries.length > 0) return entries
        }
      } catch {
        // 回退到执行器级最近一次清单。
      }
    }
    return catalog
  }

  const escalateSandbox = async (input: SandboxEscalationInput): Promise<unknown> => {
    const record = typeof input.standingPolicy === 'object' && input.standingPolicy !== null
      ? (input.standingPolicy as Record<string, unknown>)
      : undefined
    const effectiveMode = typeof record?.['mode'] === 'string' ? record['mode'] : undefined
    if (record === undefined || effectiveMode === undefined) {
      throw new Error('sandbox_permissions is not available for this PTC runtime')
    }
    if (input.requestedMode === effectiveMode) return input.standingPolicy
    if (!(WIDER_SANDBOX_MODES[effectiveMode] ?? []).includes(input.requestedMode)) {
      throw new Error(`sandbox escalation to "${input.requestedMode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
    }
    const approver = serviceOf('approval') as ApprovalServiceLike | undefined
    if (typeof approver?.request !== 'function') {
      throw new Error(`sandbox escalation to "${input.requestedMode}" requires approval, but no approval service is composed`)
    }
    if (input.agent === undefined) {
      throw new Error(`sandbox escalation to "${input.requestedMode}" requires approval, but the call has no agent to route it through`)
    }
    const outcome = await approver.request({
      agent: input.agent,
      toolName: input.toolName,
      callId: input.callId,
      reason: `escalate sandbox to ${input.requestedMode}: ${input.justification}`,
      displayReason: {
        en: `Allow this program to run once with ${input.requestedMode} access: ${input.justification}`,
        zh: `允许本次程序以 ${input.requestedMode} 权限单次运行：${input.justification}`,
      },
      signal: input.signal,
    })
    switch (outcome) {
      case 'allowed-once':
        return { ...record, mode: input.requestedMode }
      case 'rejected':
        throw new Error(`the user rejected escalating this program to "${input.requestedMode}"; it stays denied, so stop and explain instead of working around it`)
      case 'cancelled':
        throw new Error(`approval for escalating to "${input.requestedMode}" was cancelled`)
      case 'unavailable':
        throw new Error(`sandbox escalation to "${input.requestedMode}" requires approval, but no approval channel is available`)
      default:
        throw new Error(`unexpected approval outcome: ${String(outcome)}`)
    }
  }

  const host: CodemodeHost = {
    catalog: (agent?: unknown, toolSet?: unknown) => resolveCatalog(agent, toolSet),
    runtime: runtimeOf,
    stateOwner: (agent) => retention.owner(agent),
    releaseOwner: (owner) => retention.release(owner),
    awaitPredecessors: (agent, signal) => retention.awaitPredecessors(agent, signal),
    runAuthority,
    escalateSandbox,
    createImageContext(content: readonly unknown[]): unknown {
      return createUserMessage({
        content: content as ContentBlock[],
        source: { kind: PLUGIN_MESSAGE_SOURCE_KIND },
      })
    },
    programImage(attachment: unknown, fallbackPath?: string): unknown {
      const runtime = runtimeOf()
      if (runtime === undefined || runtime.language === 'python') return undefined
      if (typeof runtime.executionInstructions !== 'string' || !runtime.executionInstructions.includes('inspect')) {
        return undefined
      }
      if (!isImageAttachmentRefLike(attachment)) return undefined
      const resolveAccess = (dshLlm as Record<string, unknown>)['resolveImageAttachmentAccess']
      if (typeof resolveAccess === 'function') {
        try {
          const access = (resolveAccess as (ref: unknown) => { readonly readonlyPath?: unknown } | undefined)(attachment)
          if (typeof access?.readonlyPath === 'string' && access.readonlyPath.length > 0) {
            return new PtcImageLike(access.readonlyPath, attachment)
          }
        } catch {
          // 回退到工具自身的路径字段。
        }
      }
      if (typeof fallbackPath === 'string' && fallbackPath.length > 0) {
        return new PtcImageLike(fallbackPath, attachment)
      }
      return undefined
    },
    trackRun: (run) => retention.trackRun(run),
    shapeDispatchLog,
    async callTool(request: CallToolRequest): Promise<CallToolOutcome> {
      const call = {
        type: 'tool-call',
        id: request.callId,
        name: request.name,
        arguments: stringifyArguments(request.args),
      }
      let batch: ToolBatchResultLike
      try {
        batch = await tools.execute({
          calls: [call],
          signal: request.signal,
          ...request.agent === undefined ? {} : { agent: request.agent },
          ...request.toolSet === undefined ? {} : { toolSet: request.toolSet },
        })
      } catch (error: unknown) {
        return { error: messageOf(error) }
      }
      const result = batch.results?.[0]?.result
      if (result === undefined) return { error: 'sub-call produced no result' }
      // 内容块与展示元数据只给回放事件用；程序拿的仍是 value / text。
      const content = result.content ?? []
      const additionalContexts = Array.isArray(batch.additionalContexts) && batch.additionalContexts.length > 0
        ? batch.additionalContexts
        : undefined
      if (result.isError === true) {
        return {
          error: errorTextOf(result),
          content,
          ...errorInfoOf(result),
          ...(additionalContexts === undefined ? {} : { additionalContexts }),
        }
      }
      const meta = result.meta
      return {
        ...result.value !== undefined ? { value: result.value } : { text: textOf(result.content) },
        content,
        ...(meta === undefined ? {} : { meta }),
        ...(additionalContexts === undefined ? {} : { additionalContexts }),
        ...(batch.concluded === true ? { concluded: true } : {}),
      }
    },
  }

  // 1. 发现工具（普通工具，因此会按同一套名字规则被遮蔽，只能程序内调）。
  // 程序内检索读这次运行的清单快照；快照之外（理论上不会发生，遮蔽工具只能程序内调）退回执行器级清单。
  for (const definition of createDiscoveryDefinitions(
    rules,
    () => currentCatalogSnapshot() ?? catalog,
    () => debugRing,
  )) {
    tools.register(definition)
  }
  // 2. 程序传输。
  tools.register(createTransportDefinition(host, rules))

  // 3. + 4. 执行器与恒定说明段。
  if (typeof tools.setExecutor !== 'function') {
    log('warn', '[codemode] this DSH build has no ctx.tools.setExecutor(); Code Mode requires DSH 0.2.2 or later. '
      + 'Switch this session to the built-in ptc preset.')
    return
  }
  const delegate = new NativeToolExecutor(ctx as never)
  const view = (): CodemodeView => resolveCatalogView(tools, scopeKey, catalog.map((entry) => entry.name))
  const executor = createCodemodeExecutor(ctx, rules, {
    delegate: delegate as never,
    view,
    viewForName: (toolName) => resolveNameView(tools, scopeKey, toolName),
    sectionText: () => {
      const runtime = runtimeOf()
      return buildCodemodeSectionText({
        runToolName: rules.options.runToolName,
        metaTools: rules.options.metaTools,
        language: runtime?.language,
        programFormat: runtime?.programFormat,
        nativeToolsOnly: rules.options.nativeToolsOnly,
        nativeTools: rules.options.nativeTools,
      })
    },
    onCatalog: (definitions) => {
      catalog = definitions.map(toCatalogEntry).filter((entry): entry is CatalogEntry => entry !== undefined)
    },
    async reset(agent: unknown): Promise<void> {
      const runtime = runtimeOf()
      if (runtime === undefined) {
        throw new Error('codemode: no PTC runtime is mounted (ctx.ptcRuntime); the program transport is unavailable')
      }
      if (!runtime.retainsState) {
        throw new CodeResetFailedError('The PTC runtime does not retain an environment')
      }
      try {
        await retention.reset(agent, () => {
          const inject = typeof agent === 'object' && agent !== null
            ? (agent as { readonly inject?: (message: unknown) => void }).inject
            : undefined
          if (typeof inject === 'function') {
            inject.call(agent, createUserMessage({
              content: [{ type: 'text', text: 'Program environment reset; retained variables cleared. Completed tool effects remain.' }],
              source: { kind: PLUGIN_MESSAGE_SOURCE_KIND },
            }))
          }
        })
      } catch (error: unknown) {
        throw new CodeResetFailedError(
          'Program environment reset failed: ' + messageOf(error) + '. State may not be cleared; retry the host reset before running more code.',
        )
      }
    },
    onDescribe: (decision) => {
      const hidden = summarizeHidden(decision.masked)
      debugRing.push({ at: new Date().toISOString(), visible: decision.visible, hidden })
      while (debugRing.length > DEBUG_RING) debugRing.shift()
      const namespaces = hidden.namespaces.map((entry) => entry.namespace + '=' + String(entry.count)).join(', ')
      const line = '[codemode] masked ' + String(hidden.total) + ' non-standard tool(s)'
        + (namespaces === '' ? '' : ' (' + namespaces + ')')
        + '; request tools: ' + decision.visible.join(', ')
      if (!firstDescribeLogged) {
        firstDescribeLogged = true
        log('info', line)
      } else {
        log('debug', line)
      }
    },
  })
  tools.setExecutor(executor)
  const scopeNote = scopeKey === undefined ? '' : ', everything outside this preset scope'
  log('info', '[codemode] active: transport [' + rules.options.runToolName + '], discovery ['
    + rules.options.metaTools.join(', ') + '], hiding [' + rules.options.hiddenPrefixes.join(', ') + ']' + scopeNote)
}

/** 把一个工具定义投影成程序清单条目。 */
function toCatalogEntry(definition: unknown): CatalogEntry | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined
  const record = definition as Record<string, unknown>
  const toolName = record['name']
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined
  const description = typeof record['description'] === 'string' ? record['description'] : ''
  const safe = record['isConcurrencySafe']
  const declaredOutput = record['output']
  // `output` 是 `{ schema, render, presentationMeta }`；只有 `schema` 对程序内的模型有用，
  // 而它是「这个工具回什么形状」的唯一权威来源（`read` 回 `{ lines }` 就是从这里知道的）。
  const output = typeof declaredOutput === 'object' && declaredOutput !== null
    ? (declaredOutput as { readonly schema?: unknown }).schema
    : undefined
  const entry: CatalogEntry = {
    name: toolName,
    description,
    parameters: record['parameters'],
    ...output === undefined ? {} : { output },
    ...typeof safe === 'function' ? { isConcurrencySafe: safe as (args: unknown) => boolean } : {},
  }
  return entry
}

/** 参数序列化成线上形状（`ToolCallBlock.arguments` 是字符串）。 */
function stringifyArguments(args: unknown): string {
  if (args === undefined) return '{}'
  try {
    return JSON.stringify(args)
  } catch {
    return '{}'
  }
}

/** 一条失败结果的面向前模型文本。 */
function errorTextOf(result: ToolResultLike): string {
  const message = typeof result.error?.message === 'string' ? result.error.message : undefined
  if (message !== undefined && message.length > 0) return message
  const text = textOf(result.content)
  return text.length > 0 ? text : 'tool call failed'
}

/**
 * 读出结构化失败身份。
 *
 * 内核把 `result.error.info` 原样放进回放事件的 `error` 字段；缺任一必填项时给空
 * 对象，让调用方可以无条件展开。
 *
 * @param result - 一条失败结果。
 * @returns 带 `errorInfo` 的对象，或空对象。
 */
function errorInfoOf(result: ToolResultLike): {
  errorInfo?: { readonly name: string; readonly code: string; readonly reason?: string }
} {
  const info = result.error?.info
  if (info === undefined || info === null) return {}
  const name = nonEmptyString(info.name)
  const code = nonEmptyString(info.code)
  if (name === undefined || code === undefined) return {}
  const reason = nonEmptyString(info.reason)
  return { errorInfo: { name, code, ...reason === undefined ? {} : { reason } } }
}

/** 非空字符串，或 `undefined`。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 把内容块里的文本拼起来。 */
function textOf(content: readonly unknown[] | undefined): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('\n')
}

/** 一个抛出值的消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
