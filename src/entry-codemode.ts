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

import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'

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
  createTransportDefinition,
  currentCatalogSnapshot,
  type CallToolOutcome,
  type CallToolRequest,
  type CatalogEntry,
  type CodemodeHost,
  type PtcRuntimeLike,
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
}

/** 一次批量执行的结果（只读需要的字段）。 */
interface ToolBatchResultLike {
  /** 与入参一一对应的结果。 */
  readonly results: readonly { readonly callId: string; readonly result: ToolResultLike }[]
}

/** 一条执行结果（只读需要的字段）。 */
interface ToolResultLike {
  /** 是否失败。 */
  readonly isError: boolean
  /** 失败时的结构化错误。 */
  readonly error?: { readonly message?: string }
  /** 成功时的规范值。 */
  readonly value?: unknown
  /** 面向前模型的内容块。 */
  readonly content?: readonly unknown[]
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

  const rules = createRules(config)
  const retention = createRetention(runtimeOf)
  if (typeof context.effect === 'function') {
    context.effect(() => () => { void retention.dispose() }, 'codemode retained environments')
  }

  const scopeKey = findScopeKey(ctx)
  if (rules.options.nativeScope && scopeKey === undefined) {
    log('warn', '[codemode] no registry scope tag on this context: masking falls back to name rules only ('
      + rules.options.hiddenPrefixes.join(', ') + '). Mount this row inside an agent preset to hide every tool the preset does not own.')
  }

  /** 最近一次 describe 收到的完整定义集（含被遮蔽的）。 */
  let catalog: CatalogEntry[] = []
  const debugRing: unknown[] = []
  let firstDescribeLogged = false

  const host: CodemodeHost = {
    catalog: () => catalog,
    runtime: runtimeOf,
    stateOwner: (agent) => retention.owner(agent),
    releaseOwner: (owner) => retention.release(owner),
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
      if (result.isError === true) return { error: errorTextOf(result) }
      if (result.value !== undefined) return { value: result.value }
      return { text: textOf(result.content) }
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
    sectionText: () => buildCodemodeSectionText({
      runToolName: rules.options.runToolName,
      metaTools: rules.options.metaTools,
      programFormat: runtimeOf()?.programFormat,
    }),
    onCatalog: (definitions) => {
      catalog = definitions.map(toCatalogEntry).filter((entry): entry is CatalogEntry => entry !== undefined)
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
  const entry: CatalogEntry = {
    name: toolName,
    description,
    parameters: record['parameters'],
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
