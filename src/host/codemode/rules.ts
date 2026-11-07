/**
 * Code Mode 的遮蔽规则与恒定说明段。
 *
 * 这一层只回答三件事：
 *
 * 1. 一个工具名该不该出现在**模型看到的清单**里（{@link isMaskedName}）；
 * 2. 被遮蔽的工具有哪些（{@link summarizeHidden}，只给日志与 `code_debug` 用，
 *    **绝不出现在系统提示词里**）；
 * 3. `tools:sdk` 段写什么（{@link buildCodemodeSectionText}）。
 *
 * ## 为什么说明段里没有任何计数
 *
 * 系统提示是缓存前缀的第一段。参考实现在这一段里写「有 N 个工具被遮蔽，按
 * namespace 分布如下」，于是挂一个 MCP 服务端就改写系统提示，前缀缓存从那里起
 * 全部作废——在 kimi-code / minimax-code 这类按前缀缓存计费的线路上，一次 MCP
 * 增删就是几万 token 的全价重建。
 *
 * 本实现的说明段只依赖 `programFormat`（部署内恒定）与两个工具名（配置常量），
 * 因此同一部署下逐字节恒定。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/rules
 */

/** 本包自带的程序传输工具名。`run_code` 是内核保留名，注册会抛错。 */
export const DEFAULT_RUN_TOOL_NAME = 'code_run'

/** 发现工具名契约：`[list, search, describe, debug?]`。第一个同时用作 Code Mode 标记。 */
export const DEFAULT_META_TOOLS: readonly string[] = Object.freeze([
  'code_tools_list',
  'code_tools_search',
  'code_tools_describe',
  'code_debug',
])

/** 默认额外遮蔽的名字前缀。 */
export const DEFAULT_HIDDEN_PREFIXES: readonly string[] = Object.freeze(['mcp__'])

/**
 * 默认始终原生呈现的名字。
 *
 * 恒定系统提示词或子代理运行时契约里点名要求直接调用这些工具（大输出预览补读、调度账本查询、
 * 进展更新汇报、结构化子代理输出提交，以及 Windows 下替代被撤回 `pwsh` 的 `win_bash`）：
 * 遮蔽它们要么让提示词指向模型看不见的名字并触发整批 `UNKNOWN_TOOL` 重跑，要么让会话顶层
 * 失去唯一可用的 Shell。若某个工具当前未在宿主/子会话注册，保留在此集合中不会凭空暴露它。
 */
export const DEFAULT_NATIVE_TOOLS: readonly string[] = Object.freeze([
  'cache_warmup_result',
  'dispatch_ledger',
  'progress_update',
  'structured_output',
  'win_bash',
])

/** 校验后、脱离原对象并冻结的配置。 */
export interface CodemodeOptions {
  /** 是否遮蔽一切不是本预设自己注册的工具。 */
  readonly nativeScope: boolean
  /** 额外剥离的名字前缀。 */
  readonly hiddenPrefixes: readonly string[]
  /** 始终原生呈现的名字。 */
  readonly nativeTools: readonly string[]
  /** 始终遮蔽的名字。 */
  readonly hiddenTools: readonly string[]
  /** 发现工具名。 */
  readonly metaTools: readonly string[]
  /** 程序传输工具名。 */
  readonly runToolName: string
  /** 一个程序内可并发的只读子调用上限。 */
  readonly maxParallelSubCalls: number
  /** 一次程序最多允许的子调用次数（固定兜底下限）。 */
  readonly maxSubCalls: number
  /** 调用方是否显式指定了 `maxSubCalls`（显式指定时优先于按分钟折算）。 */
  readonly explicitMaxSubCalls: boolean
  /** 按解析后超时折算的每分钟子调用配额（对齐内核 PTC `maxSubCallsPerMinute`）。 */
  readonly maxSubCallsPerMinute: number
  /** 是否拒绝模型对被遮蔽工具的直接调用。 */
  readonly guard: boolean
  /** 是否注入 / 替换 Code Mode 说明段。 */
  readonly sdkSection: boolean
  /** 是否注册 `code_debug`。 */
  readonly debug: boolean
}

/** 原始配置（全部可选）。 */
export interface CodemodeConfig {
  /** 见 {@link CodemodeOptions.nativeScope}。 */
  nativeScope?: boolean
  /** 见 {@link CodemodeOptions.hiddenPrefixes}。 */
  hiddenPrefixes?: readonly string[]
  /** 见 {@link CodemodeOptions.nativeTools}。 */
  nativeTools?: readonly string[]
  /** 见 {@link CodemodeOptions.hiddenTools}。 */
  hiddenTools?: readonly string[]
  /** 见 {@link CodemodeOptions.metaTools}。 */
  metaTools?: readonly string[]
  /** 见 {@link CodemodeOptions.runToolName}。 */
  runToolName?: string
  /** 见 {@link CodemodeOptions.maxParallelSubCalls}。 */
  maxParallelSubCalls?: number
  /** 见 {@link CodemodeOptions.maxSubCalls}。 */
  maxSubCalls?: number
  /** 见 {@link CodemodeOptions.maxSubCallsPerMinute}。 */
  maxSubCallsPerMinute?: number
  /** 见 {@link CodemodeOptions.guard}。 */
  guard?: boolean
  /** 见 {@link CodemodeOptions.sdkSection}。 */
  sdkSection?: boolean
  /** 见 {@link CodemodeOptions.debug}。 */
  debug?: boolean
}

/** 名字集合与已归一化配置：判定遮蔽所需的全部输入。 */
export interface CodemodeRules {
  /** 归一化后的配置。 */
  readonly options: CodemodeOptions
  /** `hiddenTools` + 发现工具的集合形态（只留给程序内部调用）。 */
  readonly hidden: ReadonlySet<string>
  /** `nativeTools` + 传输工具的集合形态。 */
  readonly native: ReadonlySet<string>
}

/**
 * 把原始配置归一化。
 *
 * @param config - 行配置；`null` / 省略表示默认值。
 * @returns 冻结的配置与集合。
 */
export function createRules(config?: CodemodeConfig | null): CodemodeRules {
  const options = normalizeConfig(config)
  return {
    options,
    hidden: new Set([...options.hiddenTools, ...options.metaTools]),
    native: new Set([...options.nativeTools, options.runToolName]),
  }
}

/**
 * 校验并冻结一份配置。
 *
 * @param config - 原始配置。
 * @returns 规范化后的只读配置。
 */
export function normalizeConfig(config?: CodemodeConfig | null): CodemodeOptions {
  const source = config ?? {}
  const runToolName = nonEmptyString(source.runToolName) ?? DEFAULT_RUN_TOOL_NAME
  const metaTools = stringList(source.metaTools, DEFAULT_META_TOOLS)
  if (metaTools.length === 0) throw new TypeError('codemode: metaTools must list at least one tool name')
  if (metaTools.includes(runToolName)) {
    throw new TypeError('codemode: metaTools must not repeat the transport name')
  }
  return Object.freeze({
    nativeScope: source.nativeScope !== false,
    hiddenPrefixes: Object.freeze(stringList(source.hiddenPrefixes, DEFAULT_HIDDEN_PREFIXES)),
    nativeTools: Object.freeze(stringList(source.nativeTools, DEFAULT_NATIVE_TOOLS)),
    hiddenTools: Object.freeze(stringList(source.hiddenTools, [])),
    metaTools: Object.freeze(metaTools),
    runToolName,
    maxParallelSubCalls: positiveInteger(source.maxParallelSubCalls, 10),
    maxSubCalls: positiveInteger(source.maxSubCalls, 512),
    explicitMaxSubCalls: typeof source.maxSubCalls === 'number' && Number.isInteger(source.maxSubCalls) && source.maxSubCalls > 0,
    maxSubCallsPerMinute: positiveInteger(source.maxSubCallsPerMinute, 1024),
    guard: source.guard !== false,
    sdkSection: source.sdkSection !== false,
    debug: source.debug !== false,
  })
}

/**
 * 归属视图：哪些名字在全局层、哪些在本预设层。
 *
 * `enabled === false` 表示作用域探测失败（本包被挂在了 host 层而不是预设里），
 * 此时作用域规则整体失效，只保留名字规则——绝不因为读不到归属就误遮蔽。
 */
export interface CodemodeView {
  /** 作用域规则是否可用。 */
  readonly enabled: boolean
  /** 全局层（MCP 服务端、profile 级 bundle）能解析到的名字。 */
  readonly globalNames: ReadonlySet<string>
  /** 本预设层能解析到的名字（含祖先层，因此包含全局层）。 */
  readonly presetNames: ReadonlySet<string>
}

/** 作用域不可用时的空视图。 */
export const DISABLED_VIEW: CodemodeView = Object.freeze({
  enabled: false,
  globalNames: new Set<string>(),
  presetNames: new Set<string>(),
}) as CodemodeView

/**
 * 判定一个名字是否要从模型清单里剥离。
 *
 * 顺序：显式例外（`nativeTools` / 传输工具 / 发现工具）→ 显式遮蔽
 * （`hiddenTools`）→ 名字前缀 → 作用域归属。
 *
 * 作用域归属只在能确认归属时遮蔽：
 *
 * - 在全局视图里解析得到 → 全局层注册的，遮蔽；
 * - 只在预设视图里解析得到 → 本预设自己注册的，保持原生；
 * - 两处都解析不到 → 只可能注册在本预设之下（agent 层），遮蔽。
 *
 * @param name - 工具名。
 * @param rules - 已归一化的规则。
 * @param view - 归属视图。
 * @returns 要遮蔽时为 `true`。
 */
export function isMaskedName(name: string | undefined, rules: CodemodeRules, view: CodemodeView): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  if (rules.native.has(name)) return false
  if (rules.hidden.has(name)) return true
  for (const prefix of rules.options.hiddenPrefixes) {
    if (prefix.length > 0 && name.startsWith(prefix)) return true
  }
  if (!rules.options.nativeScope || !view.enabled) return false
  if (view.globalNames.has(name)) return true
  if (view.presetNames.has(name)) return false
  return true
}

/** 被遮蔽工具的汇总：只用于日志与 `code_debug`。 */
export interface HiddenSummary {
  /** 被遮蔽的工具总数。 */
  readonly total: number
  /** 按 namespace 分组的计数。 */
  readonly namespaces: readonly { readonly namespace: string; readonly kind: 'mcp' | 'plugin'; readonly count: number }[]
}

/**
 * 汇总被遮蔽的工具。
 *
 * @param names - 被遮蔽的名字。
 * @returns 计数与分组。
 */
export function summarizeHidden(names: readonly string[]): HiddenSummary {
  const groups = new Map<string, { namespace: string; kind: 'mcp' | 'plugin'; count: number }>()
  for (const name of names) {
    const mcp = name.startsWith('mcp__') ? name.split('__')[1] : undefined
    const namespace = mcp !== undefined && mcp.length > 0 ? mcp : 'plugin'
    const kind: 'mcp' | 'plugin' = mcp !== undefined && mcp.length > 0 ? 'mcp' : 'plugin'
    const key = kind + ':' + namespace
    const entry = groups.get(key)
    if (entry === undefined) groups.set(key, { namespace, kind, count: 1 })
    else entry.count += 1
  }
  const namespaces = [...groups.values()].sort((left, right) => right.count - left.count
    || left.namespace.localeCompare(right.namespace))
  return { total: names.length, namespaces }
}

/** 生成说明段所需的最小输入。 */
export interface SectionInput {
  /** 程序传输工具名。 */
  readonly runToolName: string
  /** 发现工具名。 */
  readonly metaTools: readonly string[]
  /** 运行时的源码语言（默认 `typescript`）。 */
  readonly language?: string
  /** 运行时的程序形态；`repl` 表示常驻 REPL。 */
  readonly programFormat?: string
}

/**
 * 生成 `tools:sdk` 段的正文。
 *
 * ## 恒定契约
 *
 * 这段正文**只**依赖入参里的两个工具名与部署级的 `language` / `programFormat`。它刻意不含遮蔽
 * 工具的数量、namespace 分布、会话 id 或时间，因此同一部署下逐字节恒定：挂载或卸载
 * MCP 服务端不会改写它，前缀缓存不会因为它失效。
 *
 * 结果形状索引（`read` / `glob` / `grep` … 的顶层字段）也**必须是静态的**：它照抄自各工具
 * 声明过的 output schema，不读活 catalog。按 catalog 生成会让「挂一个 MCP 服务端」改写系统
 * 提示词首段，正好毁掉这一层要保住的前缀缓存。
 *
 * @param input - 传输工具名、发现工具名与程序形态。
 * @returns 说明段正文。
 */
export function buildCodemodeSectionText(input: SectionInput): string {
  const python = input.language === 'python'
  const retained = input.programFormat === 'repl'
  const listTool = input.metaTools[0] ?? 'code_tools_list'
  const searchTool = input.metaTools[1] ?? 'code_tools_search'
  const describeTool = input.metaTools[2] ?? 'code_tools_describe'
  const run = input.runToolName
  // 示例必须能照抄运行：`tools.read` 回的是 `{ path, offset, lines, totalLines }` 信封，
  // 不是文件正文。在信封上写 `r.includes(...)` / `r.split(...)` / `r.splitlines()` 是
  // 每一条照抄示例的程序都会踩的陷阱，所以这里只示范读 `lines[].text`。
  const example = python
    ? [
        '```py',
        '# standard tools and hidden tools alike',
        'import asyncio',
        'found = await tools.glob({"pattern": "src/**/*.ts"})',
        'pages = await asyncio.gather(*(tools.read({"file_path": p}) for p in found["paths"]))',
        '[l["text"] for page in pages for l in page["lines"] if "TODO" in l["text"]]',
        '```',
      ]
    : [
        '```js',
        '// standard tools and hidden tools alike',
        'const { paths } = await tools.glob({ pattern: "src/**/*.ts" })',
        'const pages = await Promise.all(paths.map((p) => tools.read({ file_path: p })))',
        retained
          ? 'pages.flatMap((r) => r.lines.filter((l) => l.text.includes("TODO")).map((l) => l.text))'
          : 'return pages.flatMap((r) => r.lines.filter((l) => l.text.includes("TODO")).map((l) => l.text))',
        '```',
      ]
  const lines = [
    '## Code Mode',
    '',
    'This session runs in Code Mode. The tools in your tool list are called directly, exactly as usual. A second, larger set of tools is deliberately **not** in your context: every MCP tool, and every tool contributed by a plugin outside this preset. Reach them from inside ' + run + '.',
    '',
    '### Calling tools from a program',
    '',
    ...example,
    '',
    python
      ? (retained
        ? '- A retained Python REPL: top-level await and a final expression. Its variables and imported modules survive into your later programs in this session.'
        : '- Async Python program: top-level await works; print or evaluate a final expression to produce output.')
      : (retained
        ? '- A retained TypeScript REPL: top-level declarations, await, and a final expression. Its variables and imported modules survive into your later programs in this session.'
        : '- Erasable TypeScript, run as the body of an async function: top-level await and return work.'),
    '- Only what you return or console.log reaches the conversation; every intermediate result stays in the program, so filter and aggregate there instead of returning raw payloads.',
    '- File, search, and shell tool results are named-field objects, never bare strings — read the field, not the envelope (`job_list` and `list_agents` are the only bare arrays):',
    '  `read` → `{ path, offset, lines: [{ number, text }], totalLines }` · `glob` → `{ root, paths }` · `grep` → `{ matches: [{ path, lineNumber, line }] }` · `edit` → `{ path, before, after }` · `write` → `{ path, operation, before, after }` · `win_bash` → `{ stdout, stderr, exitCode }` · `web_fetch` → `{ url, statusCode, body, truncated }` · `job_output` → `{ text, job }` · `read_image` → `{ path, image }` · `skill` → `{ name, content }`.',
    python
      ? '- Read the field: `page["lines"]`, `match["text"]`. Calling `.split()`, `.splitlines()` or `in` on the envelope itself is always wrong.'
      : '- Read the field: `r.lines.map((l) => l.text)`. Calling `.map`, `.filter`, `.split` or `in` on the envelope itself is always wrong.',
    '- Anything not listed above (MCP tools, hidden plugin tools) answers with its **declared output schema**: call `' + describeTool + '({ name })` and read the top-level keys before picking a field. One discovery call is far cheaper than the `TypeError` that loses the whole program.',
    '- Discovery returns whole objects too: `' + listTool + '` answers `{ tools: [{ name, description, namespace }] }`, `' + searchTool + '` answers `{ tools: [{ name, namespace, description, parameters, output? }], fallback? }`, and `' + describeTool + '` answers `{ found, name?, namespace?, description?, parameters?, output? }`.',
    '- Tool argument objects and `return` values must be lossless JSON: **never leave `undefined` in an object property value** — `{ a: x.opt }` fails the call when `x.opt === undefined`. Omit the key, write `x.opt ?? null`, or print it with `console.log`.',
    // 程序文本本身的两类陷阱：写错了连求值都进不去，报错还没有行号。措辞只描述事实，不给自动改写。
    ...(python ? [] : [
      '- Paths and regexes: write a Windows path with forward slashes (`C:/Users/...`) or wrap it in `String.raw`; a literal `C:\\Users` inside an ordinary string is read as the escape `\\U` and the program never starts (`Expected unicode escape`). Regex backslashes (`\\d`, `\\.`) have the same trap — double them or use `String.raw`.',
      '- A program is not a module: `import(\'./src/x.ts\')` and `import(\'vscode\')` cannot resolve — the program runs in a fresh process with no module graph. Read files with `tools.read`; `await import(\'node:fs\')` works only for Node built-ins.',
    ]),
    '- Prefer batching multi-step read/search chains inside one ' + run + ' program instead of issuing many sequential single-tool turns.',
    '- Independent read-only calls may overlap under Promise.all; mutating calls run alone, in submission order.',
    '- A failed sub-call rejects; try/catch or Promise.allSettled it to keep the calls that succeeded. Completed calls are real side effects and are not rolled back.',
    '',
    '### Discovery API (callable from inside a program)',
    '',
    '- tools.' + listTool + '({ namespace? }) - every callable tool as { name, description, namespace }, hidden ones included.',
    '- tools.' + searchTool + '({ query, limit?, namespace? }) - ranked matches with their full parameter schemas and output schema when the tool declares one; the intended first step. Query with the English keywords the tool is likely named and described with (tool names and descriptions are English); a phrase in another language is only matched literally.',
    '- tools.' + describeTool + '({ name }) - one tool description, its complete parameter schema, and its output schema when declared.',
    '',
    'If a hidden tool name is called directly instead of from a program, the call is refused and the refusal names the discovery call to make.',
  ]
  return lines.join('\n')
}

/** 一个非空字符串，或 `undefined`。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 名字列表：省略时用缺省值，拒绝非字符串项与重复项。 */
function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value)) throw new TypeError('codemode: expected an array of tool names')
  const out: string[] = []
  for (const entry of value) {
    const name = nonEmptyString(entry)
    if (name === undefined) throw new TypeError('codemode: tool names must be non-empty strings')
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** 正整数，越界或非法时用缺省值。 */
function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return fallback
  return value
}
