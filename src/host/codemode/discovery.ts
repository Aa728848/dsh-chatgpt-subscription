/**
 * 程序内的工具发现 API：`code_tools_list` / `code_tools_search` / `code_tools_describe`。
 *
 * 三个都是注册表上的**普通工具**，因此只存在于本预设里，也必然被本包自己的名字规则遮蔽——
 * 模型只能在程序内部调用它们，这与「遮蔽的工具只能从程序里够到」是同一条规则。
 *
 * 它们走完整执行管线（参数校验、策略、审批、守卫、超时），不是旁路接口。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/codemode/discovery
 */

import type { CatalogEntry } from './transport.ts'
import type { CodemodeRules } from './rules.ts'

/** 一条公开的检索结果。 */
export interface ToolHit {
  /** 工具名。 */
  readonly name: string
  /** 描述。 */
  readonly description: string
  /** namespace（MCP 服务端名或 `plugin`）。 */
  readonly namespace: string
}

/**
 * 造三个发现工具（外加可选的 `code_debug`）。
 *
 * @param rules - 已归一化的规则。
 * @param catalog - 当前清单的读取函数。
 * @param debug - 调试信息读取函数（`code_debug` 用）。
 * @returns 原始工具定义数组。
 */
export function createDiscoveryDefinitions(
  rules: CodemodeRules,
  catalog: () => readonly CatalogEntry[],
  debug: () => unknown,
) {
  const [listTool, searchTool, describeTool, debugTool] = rules.options.metaTools
  const definitions: unknown[] = []
  if (listTool !== undefined) definitions.push(listDefinition(listTool, catalog))
  if (searchTool !== undefined) definitions.push(searchDefinition(searchTool, rules, catalog))
  if (describeTool !== undefined) definitions.push(describeDefinition(describeTool, catalog))
  if (rules.options.debug && debugTool !== undefined) {
    definitions.push(debugDefinition(debugTool, debug))
  }
  return definitions
}

/** `code_tools_list`：整份清单（含被遮蔽的）。 */
function listDefinition(name: string, catalog: () => readonly CatalogEntry[]) {
  return {
    name,
    description: 'List every tool this session can call from a program, including the ones hidden from the model list.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { namespace: { type: 'string', description: 'Only tools of this namespace (MCP server name, or "plugin").' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tools'],
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'namespace'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                namespace: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: { tools: readonly ToolHit[] }) => [{
        type: 'text',
        text: value.tools.map((hit) => hit.name + '  [' + hit.namespace + ']  ' + hit.description).join('\n'),
      }],
    },
    async execute(args: unknown): Promise<{ tools: ToolHit[] }> {
      const namespace = namespaceOf(args)
      const rows = catalog()
        .filter((entry) => namespace === undefined || namespaceOfName(entry.name) === namespace)
        .map((entry) => ({ name: entry.name, description: clip(entry.description), namespace: namespaceOfName(entry.name) }))
      return { tools: rows }
    },
  }
}

/** `code_tools_search`：按名字 / 描述排序检索，返回完整参数 schema。 */
function searchDefinition(name: string, rules: CodemodeRules, catalog: () => readonly CatalogEntry[]) {
  return {
    name,
    description: 'Rank callable tools against a free-text query and return their full parameter schemas. The intended first step before calling a hidden tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you need, in words.' },
        limit: { type: 'number', description: 'Maximum rows (default 8).' },
        namespace: { type: 'string', description: 'Only tools of this namespace.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tools'],
        properties: {
          fallback: { type: 'boolean', description: 'True when nothing matched and the rows are a namespace browse instead.' },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'parameters'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                parameters: {},
              },
            },
          },
        },
      },
      render: (_args: unknown, value: { tools: readonly { name: string; description: string; parameters: unknown }[]; fallback?: boolean }) => [{
        type: 'text',
        text: value.tools.length === 0
          ? 'No tool matched that query, and this session has no tools to browse.'
          : (value.fallback === true
            ? 'No exact match. These are the callable tools, grouped by namespace — call one by exact name, or refine the query:'
            : '')
            + value.tools.map((hit) => hit.name + '\n  ' + hit.description + '\n  parameters: ' + safeJson(hit.parameters)).join('\n\n'),
      }],
    },
    async execute(args: unknown) {
      const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const query = typeof record['query'] === 'string' ? record['query'] : ''
      const rawLimit = record['limit']
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.floor(rawLimit)
        : 8
      const namespace = namespaceOf(args)
      const candidates = catalog().filter((entry) => namespace === undefined || namespaceOfName(entry.name) === namespace)
      const terms = [...new Set(tokenize(query))]
      const { indexed, documentFrequency } = buildIndex(candidates)
      const scored: { indexed: IndexedEntry; score: number }[] = []
      for (const item of indexed) {
        const score = scoreOf(item, terms, documentFrequency, indexed.length, query)
        if (terms.length > 0 && score <= 0) continue
        scored.push({ indexed: item, score })
      }
      scored.sort((left, right) => right.score - left.score || left.indexed.entry.name.localeCompare(right.indexed.entry.name))
      const hits = scored.slice(0, limit)
      if (hits.length > 0) {
        return {
          tools: hits.map((row) => ({
            name: row.indexed.entry.name,
            description: clip(row.indexed.entry.description),
            parameters: row.indexed.entry.parameters,
          })),
        }
      }
      // 零命中不留空手而归：把清单按 namespace 分组给出来，模型可以直接照名字调。
      const browse = browseByNamespace(candidates, limit)
      return { tools: browse, fallback: true }
    },
  }
}

/** `code_tools_describe`：一个工具的完整描述与参数 schema。 */
function describeDefinition(name: string, catalog: () => readonly CatalogEntry[]) {
  return {
    name,
    description: 'Describe one callable tool by exact name: its description and complete parameter schema.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', description: 'Exact tool name.' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: {},
        },
      },
      render: (_args: unknown, value: { found: boolean; name?: string; description?: string; parameters?: unknown }) => [{
        type: 'text',
        text: value.found !== true
          ? 'No tool named that is callable from this session.'
          : String(value.name) + '\n' + String(value.description) + '\nparameters: ' + safeJson(value.parameters),
      }],
    },
    async execute(args: unknown) {
      const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const wanted = typeof record['name'] === 'string' ? record['name'] : ''
      const entry = catalog().find((row) => row.name === wanted)
      if (entry === undefined) return { found: false }
      return { found: true, name: entry.name, description: clip(entry.description), parameters: entry.parameters }
    },
  }
}

/** `code_debug`：最近若干次 describe 决策（只在程序内可见）。 */
function debugDefinition(name: string, debug: () => unknown) {
  return {
    name,
    description: 'Read the last few catalog decisions of this preset (visible vs hidden tool names). Diagnostics only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', description: 'Maximum entries (default 5).' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['entries'],
        properties: { entries: { type: 'array', items: {} } },
      },
      render: (_args: unknown, value: { entries: readonly unknown[] }) => [{ type: 'text', text: safeJson(value.entries) }],
    },
    async execute(args: unknown) {
      const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const limit = typeof record['limit'] === 'number' && record['limit'] > 0 ? Math.floor(record['limit']) : 5
      const all = debug()
      const entries = Array.isArray(all) ? all.slice(-limit) : [all]
      return { entries }
    },
  }
}

/** 读一个可选 namespace 参数。 */
function namespaceOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)['namespace']
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * 零命中时的兜底浏览：按 namespace 分组，每组给出若干名字。
 *
 * 一次失败的检索不该让模型空手而归——它多半只会换词再搜一次，或者干脆瞎猜名字。
 * 这里直接给出分好组的清单，等于把「再搜」换成「挑一个」。
 *
 * @param entries - 当前清单。
 * @param limit - 总行数上限。
 * @returns 与命中同形的行。
 */
function browseByNamespace(
  entries: readonly CatalogEntry[],
  limit: number,
): { name: string; description: string; parameters: unknown }[] {
  const groups = new Map<string, CatalogEntry[]>()
  for (const entry of entries) {
    const namespace = namespaceOfName(entry.name)
    const bucket = groups.get(namespace)
    if (bucket === undefined) groups.set(namespace, [entry])
    else bucket.push(entry)
  }
  const ordered = [...groups.entries()].sort((left, right) => right[1].length - left[1].length
    || left[0].localeCompare(right[0]))
  const rows: { name: string; description: string; parameters: unknown }[] = []
  for (const [namespace, bucket] of ordered) {
    for (const entry of bucket.slice(0, 2)) {
      if (rows.length >= limit) return rows
      rows.push({ name: entry.name, description: clip(namespace + ': ' + entry.description), parameters: entry.parameters })
    }
  }
  return rows
}

/** 一个工具名所属的 namespace。 */
export function namespaceOfName(name: string): string {
  if (!name.startsWith('mcp__')) return 'plugin'
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  return cut < 0 ? rest : rest.slice(0, cut)
}

/** 中日韩统一表意文字范围。用 fromCharCode 拼，避免源码里的转义写错一层就静默失效。 */
const CJK_RUN = new RegExp('[' + String.fromCharCode(0x3400) + '-' + String.fromCharCode(0x9fff) + ']+', 'g')

/** 英文 / 数字词。 */
const WORD_RUN = /[a-z0-9]+/g

/**
 * 内置口语同义词表：中文查询里的常用词 → 英文工具描述里真实出现的词。
 *
 * MCP 工具的描述几乎全是英文，而用户的说法是中文（「查币价」「看余额」「挪文件」）。
 * 纯词法检索在这种跨语言落差上必然零命中，所以这里做一张小而准的映射表，只覆盖
 * 代理 / 交易 / 协作 / 存储这几类高频语境；命中即把英文词一并加入查询词。
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  币价: ['price', 'ticker', 'quote'],
  价格: ['price', 'quote'],
  行情: ['ticker', 'quote', 'market'],
  k线: ['candle', 'ohlc', 'kline', 'candlestick'],
  涨跌: ['ticker', 'price'],
  余额: ['balance'],
  结余: ['balance'],
  下单: ['order'],
  买入: ['buy', 'order'],
  卖出: ['sell', 'order'],
  订单: ['order'],
  撤单: ['cancel', 'order'],
  文件: ['file'],
  目录: ['directory', 'folder'],
  文件夹: ['directory', 'folder'],
  消息: ['message'],
  频道: ['channel'],
  群组: ['channel', 'group'],
  联系人: ['contact'],
  客户: ['contact', 'customer', 'lead'],
  线索: ['lead'],
  数据库: ['sql', 'db', 'query'],
  查询: ['query', 'search'],
  搜索: ['search', 'query'],
  页面: ['page'],
  文档: ['page', 'document'],
  合并: ['merge', 'pull'],
  提交: ['commit', 'pull', 'push'],
  分支: ['branch'],
  列出: ['list'],
  新建: ['create'],
  创建: ['create'],
  删除: ['delete', 'remove'],
  更新: ['update'],
})

/**
 * 分词：英文按词，中日韩按单字与二元组，并展开同义词。
 *
 * @param text - 任意文本（工具名、描述、参数名或查询）。
 * @returns 查询词（可能含同义词展开，调用方负责去重）。
 */
function tokenize(text: string): string[] {
  const raw = String(text ?? '').toLowerCase()
  // 中文口语常带空格（「K 线」「用 数据库 查」），先去掉空白再按包含关系展开同义词，
  // 否则「数据库」「联系人」这种三字以上整词永远匹配不到（二元组切不出整词）。
  const value = raw.replace(/\s+/g, '')
  const tokens: string[] = []
  for (const word of raw.match(WORD_RUN) ?? []) tokens.push(word)
  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    if (value.includes(key)) tokens.push(...synonyms)
  }
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length === 1) tokens.push(run)
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      tokens.push(bigram)
      for (const synonym of SYNONYMS[bigram] ?? []) tokens.push(synonym)
    }
    for (const synonym of SYNONYMS[run] ?? []) tokens.push(synonym)
  }
  return tokens
}

/**
 * 参数名也是强信号：`instId`、`sql`、`channel` 这类词往往只出现在参数里，而它恰恰是
 * 用户或模型用来定位工具的那个词。
 *
 * @param parameters - 工具的参数 JSON Schema。
 * @returns 参数名分词。
 */
function parameterTokens(parameters: unknown): string[] {
  const tokens: string[] = []
  for (const key of propertiesOf(parameters)) tokens.push(...tokenize(key))
  return tokens
}

/**
 * 读出一个工具参数 schema 的属性名。
 *
 * @param parameters - 参数 JSON Schema。
 * @returns 属性名数组（没有时为 `[]`）。
 */
function propertiesOf(parameters: unknown): string[] {
  if (typeof parameters !== 'object' || parameters === null) return []
  const properties = (parameters as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return []
  return Object.keys(properties)
}

/**
 * 参数名里是否存在与查询词**完全相同**的键。
 *
 * 索引只留了参数名的分词，丢掉了「原始键名」，所以这里在索引项上多存一份原始键名集合，
 * 只用于给完全匹配再加一点权重。
 *
 * @param indexed - 索引项。
 * @param term - 查询词。
 * @returns 命中时 1，否则 0。
 */
function rawParameterHit(indexed: IndexedEntry, term: string): number {
  return indexed.parameterNames.has(term) ? 1 : 0
}

/** 一份工具的检索索引：名字、描述、参数名各自的词频。 */
interface IndexedEntry {
  /** 原始条目。 */
  readonly entry: CatalogEntry
  /** 名字词频。 */
  readonly name: ReadonlyMap<string, number>
  /** 描述词频。 */
  readonly description: ReadonlyMap<string, number>
  /** 参数名集合（分词后）。 */
  readonly parameters: ReadonlySet<string>
  /** 参数原始键名（小写），用于完全匹配加权。 */
  readonly parameterNames: ReadonlySet<string>
}

/**
 * 把一份清单建成检索索引，并给出每个词的文档频率（用于降噪加权）。
 *
 * @param entries - 当前清单。
 * @returns 索引项与词 → 出现次数。
 */
function buildIndex(entries: readonly CatalogEntry[]): {
  readonly indexed: readonly IndexedEntry[]
  readonly documentFrequency: ReadonlyMap<string, number>
} {
  const documentFrequency = new Map<string, number>()
  const indexed: IndexedEntry[] = []
  for (const entry of entries) {
    const name = countOf(tokenize(entry.name))
    const description = countOf(tokenize(entry.description))
    const parameters = new Set(parameterTokens(entry.parameters))
    const parameterNames = new Set(propertiesOf(entry.parameters).map((key) => key.toLowerCase()))
    indexed.push({ entry, name, description, parameters, parameterNames })
    const seen = new Set([...name.keys(), ...description.keys(), ...parameters])
    for (const token of seen) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  return { indexed, documentFrequency }
}

/** 统计词频。 */
function countOf(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/**
 * 一个工具的命中分数。
 *
 * 三处命中权重递减：名字 > 参数名 > 描述。每个词再乘一个 idf 权重，让 `ticker`、
 * `candle` 这类稀有词压过 `get`、`list`、`create` 这类几乎每个工具都有的泛词——否则
 * 「看一下 K 线」会被 `get_balance` 抢走（两者都命中 `get`）。
 *
 * @param indexed - 索引项。
 * @param terms - 去重后的查询词。
 * @param documentFrequency - 词 → 文档频率。
 * @param total - 清单规模。
 * @param query - 原始查询（用于整串子串加分）。
 * @returns 分数；0 表示不相关。
 */
function scoreOf(
  indexed: IndexedEntry,
  terms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  total: number,
  query: string,
): number {
  if (terms.length === 0) return 1
  let score = 0
  for (const term of terms) {
    const inName = indexed.name.get(term) ?? 0
    const inDescription = indexed.description.get(term) ?? 0
    const inParameters = indexed.parameters.has(term) ? 1 : 0
    // 参数名与查询词完全相等时再加一点：`instId` 这类词在多个工具里都是参数，
    // 只有「参数就叫这个」才说明这是用户要的那一个。
    const exactParameter = Math.max(0, rawParameterHit(indexed, term))
    if (inName === 0 && inDescription === 0 && inParameters === 0) continue
    const df = documentFrequency.get(term) ?? 1
    const weight = Math.log(1 + total / (1 + df))
    score += weight * (inName > 0 ? 6 + Math.min(inName, 3) : 0)
    score += weight * (inParameters === 1 ? 3 + exactParameter : 0)
    score += weight * (inDescription > 0 ? 1 + Math.min(inDescription, 2) * 0.5 : 0)
  }
  const name = indexed.entry.name.toLowerCase()
  const compact = query.trim().toLowerCase().replace(/\s+/g, '')
  if (compact.length > 1 && name.replace(/[^a-z0-9]/g, '').includes(compact.replace(/[^a-z0-9]/g, ''))) score += 12
  return score
}

/** 截断描述，避免清单输出过长。 */
function clip(text: string, max = 240): string {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

/** 安全 JSON 化。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
