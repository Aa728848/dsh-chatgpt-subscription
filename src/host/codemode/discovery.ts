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
      render: (_args: unknown, value: { tools: readonly { name: string; description: string; parameters: unknown }[] }) => [{
        type: 'text',
        text: value.tools.length === 0
          ? 'No tool matched that query.'
          : value.tools.map((hit) => hit.name + '\n  ' + hit.description + '\n  parameters: ' + safeJson(hit.parameters)).join('\n\n'),
      }],
    },
    async execute(args: unknown) {
      const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const query = typeof record['query'] === 'string' ? record['query'] : ''
      const limit = typeof record['limit'] === 'number' && Number.isFinite(record['limit']) && record['limit'] > 0
        ? Math.floor(record['limit'])
        : 8
      const namespace = namespaceOf(args)
      const terms = [...new Set(tokenize(query))]
      const scored: { entry: CatalogEntry; score: number }[] = []
      for (const entry of catalog()) {
        if (namespace !== undefined && namespaceOfName(entry.name) !== namespace) continue
        const score = scoreOf(entry, terms)
        if (terms.length > 0 && score <= 0) continue
        scored.push({ entry, score })
      }
      scored.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
      return {
        tools: scored.slice(0, limit).map((row) => ({
          name: row.entry.name,
          description: clip(row.entry.description),
          parameters: row.entry.parameters,
        })),
      }
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

/** 一个工具名所属的 namespace。 */
export function namespaceOfName(name: string): string {
  if (!name.startsWith('mcp__')) return 'plugin'
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  return cut < 0 ? rest : rest.slice(0, cut)
}

/** 分词：英文按词，中日韩按单字与二元组（中文查询因此也能命中）。 */
function tokenize(text: string): string[] {
  const value = String(text ?? '').toLowerCase()
  const tokens: string[] = []
  for (const word of value.match(/[a-z0-9]+/g) ?? []) tokens.push(word)
  for (const run of value.match(/[\\u3400-\\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/** 一个工具的命中分数：名字命中权重大于描述命中。 */
function scoreOf(entry: CatalogEntry, terms: readonly string[]): number {
  if (terms.length === 0) return 1
  const name = entry.name.toLowerCase()
  const description = String(entry.description ?? '').toLowerCase()
  const nameTokens = tokenize(name)
  const descriptionTokens = tokenize(description)
  let score = 0
  for (const term of terms) {
    const inName = nameTokens.filter((token) => token === term).length
    const inDescription = descriptionTokens.filter((token) => token === term).length
    if (inName > 0) score += 6 + inName
    if (inDescription > 0) score += 1 + Math.min(inDescription, 3) * 0.5
  }
  if (name.includes(terms.join(' '))) score += 12
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
