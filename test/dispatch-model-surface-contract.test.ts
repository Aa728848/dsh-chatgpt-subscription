/**
 * Dispatch 模型面契约测试。
 *
 * 这份用例盯住的是**模型看得见的那一面**：preset 的两份副本（YAML 与运行时声明）、
 * persona 里点名的工具与词表、授权描述在 PTC 与 Native 两侧的写法、以及几处
 * 常驻字节的预算。
 *
 * ## 为什么要有这一份
 *
 * preset 同一份东西存在两处（`presets/dispatch/agent.cordis.yml` 与
 * `src/host/agent-preset.ts` 的 `DISPATCH_PRESET`），旧代 harness 拷 YAML、
 * 新代 harness 注册声明——**落进模型的词表因此有两个来源**。只对拍文本块不够：
 * 加一行工具、改一个 config 键、动一个 `disabled`，都可能只落一侧，于是两个代次
 * 的模型学到两套不同的调度纪律，而测试全绿。
 *
 * 所以这里按**行**对拍：id、name、disabled、isolate、config 逐项比，并让失败信息
 * 直接指出是哪一行、哪个字段、两侧各是什么。
 *
 * ## 纪律
 *
 * - 不连网络、不调真实模型、不读 `~/.dsh`：全部是静态装配。
 * - 不加依赖：YAML 由测试内一个最小解析器读，只认这份 preset 用到的语法
 *   （块标量、缩进映射、序列、`!!js` 表达式）。
 * - 不引入 UI。
 *
 * @module dsh-chatgpt-subscription/test/dispatch-model-surface-contract
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DISPATCH_PRESET,
  DISPATCH_PRESET_ID,
  type PresetRow,
} from '../src/host/agent-preset.ts'
import { bundledPresetsRoot } from '../src/host/preset-sync.ts'
import {
  DEFAULT_DELEGATED_BLOCKED_TOOLS,
  installDispatchExecutionGuard,
  isDelegatedCaller,
} from '../src/host/dispatch-execution-guard.ts'
import {
  DEFAULT_DELEGATION_TOOLS,
  DEFAULT_SUBAGENT_INHERIT_TOOLS,
  authorizedRoutesFor,
  resolveRootSessionAndMainRoute,
  rewriteAuthorizedPromptAssembly,
  type AllowedModelRoute,
} from '../src/host/subagent-model-authorization.ts'
import {
  DISPATCH_LEDGER_DESCRIPTION,
  DISPATCH_LEDGER_TOOL,
  createDispatchLedgerTool,
} from '../src/host/dispatch-ledger/tool.ts'
import {
  DISPATCH_MANDATE_PROTOCOL,
  DISPATCH_MANDATE_PROTOCOL_MAX_CHARS,
} from '../src/host/dispatch-ledger/protocol.ts'
import {
  MANDATE_FENCE_CLOSE,
  MANDATE_FENCE_OPEN,
  MANDATE_PROTOCOL_ID,
  parseMandateHeader,
} from '../src/host/dispatch-ledger/header.ts'
import {
  DEFAULT_GUARD_DISPATCH_TOOLS,
  dispatchDenial,
  type DispatchDenialCode,
} from '../src/host/dispatch-ledger/guard.ts'
import { DISPATCH_GUARD_DENIAL_PREFIX } from '../src/host/dispatch-ledger/ledger.ts'
import { parentSessionIdOfSession, sessionIdOf } from '../src/host/dispatch-ledger/binding.ts'
import { createDispatchLedgerCache, type DispatchLedgerSessionLike } from '../src/host/dispatch-ledger/guard.ts'

// ── 最小 YAML 解析（测试内，不加依赖）────────────────────────────────────

/** 一行记号。 */
interface Token {
  /** 缩进列数。 */
  indent: number
  /** 去掉缩进后的正文。 */
  text: string
  /** 块标量（`key: |`）展开后的正文。 */
  block?: string
  /** 是否是序列项。 */
  seq?: boolean
  /** 序列项所属序列的基准缩进。 */
  base?: number
}

/** 标量：字符串。 */
type Scalar = string
/** 映射。 */
interface Mapping { [key: string]: Value }
/** 序列。 */
type Sequence = Mapping[]
/** 解析出的值。 */
type Value = Scalar | Mapping | Sequence

/** 判断一个值是不是映射。 */
function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断一个值是不是序列。 */
function isSequence(value: unknown): value is Sequence {
  return Array.isArray(value)
}

/**
 * 去掉一层引号。
 * @param text - 原始标量文本。
 * @returns 引号剥掉后的文本；没有引号时原样返回。
 */
function unquote(text: string): string {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) return text.slice(1, -1)
  return text
}

/**
 * 把 YAML 文本切成记号。
 *
 * 块标量（`prefix: |`、`section: |`）按**首个非空行的缩进**整体取出——那才是
 * YAML 的块标量缩进规则，也是这两份 preset 里两个大文本块的实际缩进（6 与 14）。
 * 块标量内部的 `#` 不是注释，所以注释只在这一层之外剥。
 * @param yaml - 源文本。
 * @returns 记号表。
 */
function tokenize(yaml: string): Token[] {
  const lines = yaml.split('\n')
  const tokens: Token[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    const text = line.trimStart()
    const block = /^([A-Za-z0-9_.-]+):\s*\|\s*$/.exec(text)
    if (block !== null) {
      const body: string[] = []
      let cursor = index + 1
      let base = -1
      while (cursor < lines.length) {
        const next = lines[cursor] ?? ''
        if (next.trim() === '') {
          body.push('')
          cursor += 1
          continue
        }
        const nextIndent = next.length - next.trimStart().length
        if (nextIndent <= indent) break
        if (base < 0) base = nextIndent
        body.push(next.slice(base))
        cursor += 1
      }
      tokens.push({ indent, text: `${block[1]}:`, block: body.join('\n').replace(/\n+$/, '') })
      index = cursor
      continue
    }
    tokens.push({ indent, text })
    index += 1
  }
  // 序列项 `- id: x` 展开成一项：条目自身的键落在 `-` 之后的列。
  return tokens.map(token => (
    token.text.startsWith('- ')
      ? { indent: token.indent + 2, text: token.text.slice(2).trim(), seq: true, base: token.indent }
      : token
  ))
}

/**
 * 解析一个映射块。
 * @param tokens - 记号表。
 * @param index - 起点。
 * @param indent - 该映射的缩进。
 * @returns 映射与下一个记号的位置。
 */
function parseMapping(tokens: Token[], index: number, indent: number, allowSeqHead = false): { value: Mapping; next: number } {
  const map: Mapping = {}
  let cursor = index
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (token.indent !== indent) break
    if (token.seq === true && !(allowSeqHead && cursor === index)) break
    const split = /^([^:]+):\s*(.*)$/.exec(token.text)
    if (split === null) break
    const key = split[1]!.trim()
    const inline = split[2]!.trim()
    if (token.block !== undefined) {
      map[key] = token.block
      cursor += 1
      continue
    }
    if (inline !== '') {
      map[key] = inline
      cursor += 1
      continue
    }
    // 嵌套块必须更深一层：更浅的记号属于外层映射，不能被这里吞掉。
    const next = tokens[cursor + 1]
    if (next === undefined || next.indent <= indent) {
      cursor += 1
      continue
    }
    const nested = parseValue(tokens, cursor + 1)
    map[key] = nested.value
    cursor = nested.next
  }
  return { value: map, next: cursor }
}

/**
 * 解析一个序列块。
 * @param tokens - 记号表。
 * @param index - 起点。
 * @param base - 序列的基准缩进。
 * @returns 序列与下一个记号的位置。
 */
function parseSequence(tokens: Token[], index: number, base: number): { value: Sequence; next: number } {
  const items: Sequence = []
  let cursor = index
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (token.seq !== true || token.base !== base) break
    const parsed = parseMapping(tokens, cursor, token.indent, true)
    items.push(parsed.value)
    cursor = parsed.next
  }
  return { value: items, next: cursor }
}

/**
 * 解析任意一个值（映射或序列）。
 * @param tokens - 记号表。
 * @param index - 起点。
 * @returns 值与下一个记号的位置。
 */
function parseValue(tokens: Token[], index: number): { value: Value; next: number } {
  const token = tokens[index]
  if (token === undefined) return { value: {}, next: index }
  if (token.seq === true) return parseSequence(tokens, index, token.base ?? token.indent)
  return parseMapping(tokens, index, token.indent)
}

/**
 * 解析一份 YAML 文档。
 * @param yaml - 源文本。
 * @returns 文档根节点。
 */
function parseDocument(yaml: string): Value {
  return parseValue(tokenize(yaml), 0).value
}

/** 一行 preset 的视图。 */
interface RowView {
  /** 行 id。 */
  id: string
  /** 行挂载的包。 */
  name: string
  /** `disabled:` 的原始文本（`!!js` 表达式或布尔字面量）。 */
  disabled?: string
  /** `group:` 的原始文本。 */
  group?: string
  /** `isolate:` 的服务名映射。 */
  isolate?: Mapping
  /** `config:` 的内容。 */
  config?: Value
}

/**
 * 把序列读成行视图。
 * @param sequence - 序列。
 * @returns 行视图表。
 */
function rowViews(sequence: Sequence): RowView[] {
  return sequence.map(item => ({
    id: unquote(String(item['id'] ?? '')),
    name: unquote(String(item['name'] ?? '')),
    ...(item['disabled'] === undefined ? {} : { disabled: String(item['disabled']) }),
    ...(item['group'] === undefined ? {} : { group: String(item['group']) }),
    ...(isMapping(item['isolate']) ? { isolate: item['isolate'] } : {}),
    ...(item['config'] === undefined ? {} : { config: item['config'] }),
  }))
}

/**
 * 递归找一行。
 * @param rows - 行表。
 * @param id - 行 id。
 * @returns 找到的行；没有时 undefined。
 */
function findRow(rows: readonly RowView[], id: string): RowView | undefined {
  for (const row of rows) {
    if (row.id === id) return row
    if (isSequence(row.config)) {
      const nested = findRow(rowViews(row.config), id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 声明侧递归找一行。
 * @param rows - 行表。
 * @param id - 行 id。
 * @returns 找到的行；没有时 undefined。
 */
function declaredRow(rows: readonly PresetRow[], id: string): PresetRow | undefined {
  for (const row of rows) {
    if (row.id === id) return row
    if (Array.isArray(row.config)) {
      const nested = declaredRow(row.config as PresetRow[], id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * 两侧**故意**不同的包名。
 *
 * 只有一处：`workflow-worker-thread` 行在 YAML 里写的是 0.1.6 之前的拼法，在声明里
 * 写的是 0.1.7 之后的拼法——preset-sync 在部署时按安装的 harness 重写 YAML
 * （`src/host/preset-sync.ts` 的 `RENAMED_PACKAGES`）。所以这一行两侧本来就不同，
 * 而且必须**仍然是这两个拼法**：换成第三个拼法，sync 就再也认不出来了。
 */
const RENAMED_PACKAGE_ROWS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  'workflow-worker-thread': [
    '@deepseek-ai/dsh-workflow-worker-thread',
    '@deepseek-ai/dsh-workflow-ptc',
  ],
})

/**
 * 这一行的包名差异是不是那处"故意的差异"。
 * @param id - 行 id。
 * @param yamlName - YAML 侧的包名。
 * @param declName - 声明侧的包名。
 * @returns 是那处差异时为 true。
 */
function renamedPackageRow(id: string, yamlName: string, declName: string): boolean {
  const pair = RENAMED_PACKAGE_ROWS[id]
  if (pair === undefined) return false
  return (yamlName === pair[0] && declName === pair[1]) || (yamlName === pair[1] && declName === pair[0])
}

/**
 * 求值 preset 里的 `disabled:` 表达式。
 * @param text - 表达式文本。
 * @returns 该行在此平台上是否停用。
 */
function disabledValue(text: string): boolean {
  if (text === 'true') return true
  if (text === 'false') return false
  const expression = /^!!js\s+process\.platform\s*(===|!==)\s*'win32'$/.exec(text)
  if (expression === null) throw new Error(`the preset carries an unknown disabled expression: ${text}`)
  return expression[1] === '===' ? process.platform === 'win32' : process.platform !== 'win32'
}

/**
 * 把一个值缩成一句可读的说明。
 * @param value - 候选值。
 * @returns 简短文本。
 */
function brief(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80
      ? `«${value.length} 字符» ${JSON.stringify(value.slice(0, 60))}…`
      : JSON.stringify(value)
  }
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 120 ? `«${text.length} 字符» ${text.slice(0, 100)}…` : text
}

/**
 * 对拍两侧的 `config`。
 * @param yaml - YAML 侧的 config。
 * @param decl - 声明侧的 config。
 * @param where - 出错时用的定位前缀。
 * @returns 不一致的说明；空表表示一致。
 */
function diffConfig(yaml: Value | undefined, decl: unknown, where: string): string[] {
  const problems: string[] = []
  if (Array.isArray(decl)) {
    if (!isSequence(yaml)) {
      problems.push(`${where}.config: 形状不同 —— YAML ${brief(yaml)}，声明是嵌套行数组`)
      return problems
    }
    problems.push(...diffRows(rowViews(yaml), decl as PresetRow[], where))
    return problems
  }
  if (decl === undefined) {
    if (yaml !== undefined) problems.push(`${where}.config: 声明没有 config，YAML 有 ${brief(yaml)}`)
    return problems
  }
  if (!isMapping(decl)) {
    problems.push(`${where}.config: 声明的 config 不是映射`)
    return problems
  }
  if (!isMapping(yaml)) {
    problems.push(`${where}.config: 形状不同 —— YAML ${brief(yaml)}，声明是映射`)
    return problems
  }
  const yamlKeys = Object.keys(yaml).sort()
  const declKeys = Object.keys(decl).sort()
  if (yamlKeys.join(',') !== declKeys.join(',')) {
    problems.push(`${where}.config: 键不同 —— YAML [${yamlKeys.join(', ')}]，声明 [${declKeys.join(', ')}]`)
    return problems
  }
  for (const key of yamlKeys) {
    const yamlValue = yaml[key]
    if (typeof yamlValue !== 'string') {
      problems.push(`${where}.config.${key}: YAML 侧不是标量（${brief(yamlValue)}）`)
      continue
    }
    const declValue = decl[key]
    // 尾部换行是模板字面量的书写痕迹，不是内容：两侧一律按"去掉尾部换行"再比。
    const left = unquote(yamlValue).replace(/\n+$/, '')
    const right = String(declValue).replace(/\n+$/, '')
    if (left !== right) {
      problems.push(`${where}.config.${key}: 值不同 —— YAML ${brief(left)}，声明 ${brief(right)}`)
    }
  }
  return problems
}

/**
 * 对拍两侧的行表。
 * @param yaml - YAML 侧的行。
 * @param decl - 声明侧的行。
 * @param trail - 出错时用的定位前缀。
 * @returns 不一致的说明；空表表示一致。
 */
function diffRows(yaml: readonly RowView[], decl: readonly PresetRow[], trail: string): string[] {
  const problems: string[] = []
  if (yaml.length !== decl.length) {
    problems.push(
      `${trail}: 行数不同 —— YAML ${yaml.length} 行（${yaml.map(row => row.id).join(', ')}），`
      + `声明 ${decl.length} 行（${decl.map(row => row.id).join(', ')}）`,
    )
    return problems
  }
  yaml.forEach((row, index) => {
    const other = decl[index]!
    const where = `${trail}/${row.id || `#${index}`}`
    if (row.id !== other.id) {
      problems.push(`${where}: 行 id 不同 —— YAML "${row.id}"，声明 "${other.id}"（两边的行顺序必须一致）`)
    }
    if (row.name !== other.name && !renamedPackageRow(row.id, row.name, other.name)) {
      problems.push(`${where}: 挂载的包不同 —— YAML "${row.name}"，声明 "${other.name}"`)
    }
    const yamlDisabled = row.disabled === undefined ? false : disabledValue(row.disabled)
    if (yamlDisabled !== (other.disabled === true)) {
      problems.push(
        `${where}: disabled 不同 —— YAML ${brief(row.disabled)}（求值为 ${yamlDisabled}），`
        + `声明 ${brief(other.disabled)}`,
      )
    }
    const yamlGroup = row.group === undefined ? false : row.group === 'true'
    if (yamlGroup !== (other.group === true)) {
      problems.push(`${where}: group 不同 —— YAML ${brief(row.group)}，声明 ${brief(other.group)}`)
    }
    const yamlIsolate = row.isolate ?? {}
    const declIsolate = other.isolate ?? {}
    const yamlKeys = Object.keys(yamlIsolate).sort()
    const declKeys = Object.keys(declIsolate).sort()
    if (yamlKeys.join(',') !== declKeys.join(',')) {
      problems.push(`${where}: isolate 的服务名不同 —— YAML [${yamlKeys.join(', ')}]，声明 [${declKeys.join(', ')}]`)
    } else {
      for (const key of yamlKeys) {
        const yamlValue = unquote(String(yamlIsolate[key] ?? ''))
        const declValue = declIsolate[key]
        if (yamlValue !== String(declValue)) {
          problems.push(`${where}: isolate.${key} 不同 —— YAML ${brief(yamlValue)}，声明 ${brief(declValue)}`)
        }
      }
    }
    problems.push(...diffConfig(row.config, other.config, where))
  })
  return problems
}

// ── 这份 preset 的两份副本 ────────────────────────────────────────────────

const presetRoot = bundledPresetsRoot()
const agentYmlPath = join(presetRoot, DISPATCH_PRESET_ID, 'agent.cordis.yml')
const metaYmlPath = join(presetRoot, DISPATCH_PRESET_ID, 'preset.yml')
const agentYml = readFileSync(agentYmlPath, 'utf8')
const metaYml = readFileSync(metaYmlPath, 'utf8')

const yamlDocument = parseDocument(agentYml)
if (!isSequence(yamlDocument)) throw new Error('agent.cordis.yml is not a row sequence')
const yamlRows = rowViews(yamlDocument)

const metaDocument = parseDocument(metaYml)
if (!isMapping(metaDocument)) throw new Error('preset.yml is not a mapping')

/** 声明侧的 persona 前缀。 */
function declaredPersona(): string {
  const row = declaredRow(DISPATCH_PRESET.plugins, 'persona')
  const config = row?.config as { prefix?: unknown } | undefined
  if (typeof config?.prefix !== 'string') throw new Error('the declaration carries no persona prefix')
  // 尾部换行按仓库既有约定去掉：YAML 块标量天然不带，声明的模板字面量带。
  return config.prefix.replace(/\n+$/, '')
}

/** YAML 侧的 persona 前缀。 */
function yamlPersona(): string {
  const row = findRow(yamlRows, 'persona')
  const config = row?.config
  if (!isMapping(config)) throw new Error('agent.cordis.yml carries no persona config')
  const prefix = config['prefix']
  if (typeof prefix !== 'string') throw new Error('agent.cordis.yml carries no persona prefix')
  return prefix
}

/** 声明侧的 plan-mode section。 */
function declaredSection(): string {
  const row = declaredRow(DISPATCH_PRESET.plugins, 'plan-mode')
  const config = row?.config as { section?: unknown } | undefined
  if (typeof config?.section !== 'string') throw new Error('the declaration carries no plan-mode section')
  return config.section.replace(/\n+$/, '')
}

/** YAML 侧的 plan-mode section。 */
function yamlSection(): string {
  const row = findRow(yamlRows, 'plan-mode')
  const config = row?.config
  if (!isMapping(config)) throw new Error('agent.cordis.yml carries no plan-mode config')
  const section = config['section']
  if (typeof section !== 'string') throw new Error('agent.cordis.yml carries no plan-mode section')
  return section
}

/**
 * persona 里的一行。
 * @param persona - persona 正文。
 * @param marker - 行内标记。
 * @returns 那一行。
 */
function personaLine(persona: string, marker: string): string {
  const line = persona.split('\n').find(candidate => candidate.includes(marker))
  if (line === undefined) throw new Error(`the persona carries no "${marker}" line`)
  return line
}

/**
 * 报出两段文本的第一个差异位置。
 * @param left - 左文本。
 * @param right - 右文本。
 * @returns 差异说明；一致时 undefined。
 */
function firstDifference(left: string, right: string): string | undefined {
  if (left === right) return undefined
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  const window = (text: string): string => text.slice(Math.max(0, index - 40), index + 60)
  return `第 ${index} 个字符起不同 —— YAML 长度 ${left.length}，声明长度 ${right.length}；`
    + `YAML: …${window(left)}…；声明: …${window(right)}…`
}

// ── 1. 两份副本 ───────────────────────────────────────────────────────────

describe('the two shipped copies of the dispatch preset', () => {
  it('keeps every row in step, field by field', () => {
    // 旧代 harness 拷 YAML，新代 harness 注册声明。模型学到哪一份，取决于它跑在
    // 哪一代上——所以两份必须逐行相同，而不是"大体相同"。
    const problems = diffRows(yamlRows, DISPATCH_PRESET.plugins, 'preset')
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('keeps the identity fields in step with preset.yml', () => {
    const problems: string[] = []
    const name = String(metaDocument['name'] ?? '')
    const description = String(metaDocument['description'] ?? '')
    const order = String(metaDocument['order'] ?? '')
    if (name !== DISPATCH_PRESET.name) {
      problems.push(`name 不同 —— YAML "${name}"，声明 "${DISPATCH_PRESET.name}"`)
    }
    if (description !== DISPATCH_PRESET.description) {
      problems.push(`description 不同 —— YAML ${brief(description)}，声明 ${brief(DISPATCH_PRESET.description)}`)
    }
    if (order !== String(DISPATCH_PRESET.order)) {
      problems.push(`order 不同 —— YAML "${order}"，声明 "${String(DISPATCH_PRESET.order)}"`)
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('keeps the persona prefix and the plan-mode section byte-identical', () => {
    // persona 是子代理自判身份的依据，section 是手动 /plan 路径上唯一的护栏。
    // 两者都在两份副本里各写一遍，所以必须逐字节相同。
    const prefixDifference = firstDifference(yamlPersona(), declaredPersona())
    expect(prefixDifference, `persona prefix 两份不一致：${prefixDifference}`).toBeUndefined()
    const sectionDifference = firstDifference(yamlSection(), declaredSection())
    expect(sectionDifference, `plan-mode section 两份不一致：${sectionDifference}`).toBeUndefined()
  })
})

// ── 2. 词表：工具名与状态词 ───────────────────────────────────────────────

describe('the vocabulary the model reads', () => {
  it('lists exactly the coordinator-only tools the execution guard blocks', () => {
    // persona 告诉子代理哪些工具不能碰，守卫真的把它们拦下。两边必须同一份名单：
    // 名单漏一个，子代理就会以为那个工具归自己；多一个，模型会白白回避它。
    const line = personaLine(declaredPersona(), '[Coordinator-Only Tools]')
    const match = /\[Coordinator-Only Tools\] (.*?) are coordinator-only/.exec(line)
    expect(match, 'the persona carries no coordinator-only list').not.toBeNull()
    const listed = (match![1] ?? '')
      .split(',')
      .map(entry => entry.trim().replace(/^and\s+/, ''))
      .filter(entry => entry.length > 0)
    expect(new Set(listed), 'persona 的主控专用工具名单与守卫的禁用名单不一致')
      .toEqual(new Set(DEFAULT_DELEGATED_BLOCKED_TOOLS))
  })

  it('uses the report status vocabulary the mandate schema accepts', () => {
    // 状态词要同时满足三方：persona 的报告协议、守卫的拒绝文案、Mandate v2 的
    // 头部 schema。三者不一致时，模型写出的 status 会当场被判"头部损坏"。
    const line = personaLine(declaredPersona(), '[Subagent Report Protocol]')
    const match = /status: ([a-z_ |]+)/.exec(line)
    expect(match, 'the persona carries no report status vocabulary').not.toBeNull()
    const statuses = (match![1] ?? '').split('|').map(entry => entry.trim()).filter(entry => entry.length > 0)
    expect(statuses.length).toBeGreaterThan(0)

    // 逐个送进真实的头部 schema：认得的是词表里的，认不得的就不是。
    for (const status of statuses) {
      const parsed = parseMandateHeader(reportHeader(status))
      expect(parsed.state, `persona 的状态词 "${status}" 不被 Mandate v2 的头部 schema 接受`).toBe('ok')
    }
    const bogus = parseMandateHeader(reportHeader('dropped_v2'))
    expect(bogus.state, '头部 schema 收下了一个词表外的状态词').toBe('invalid')

    // 守卫的拒绝文案点名的状态词也必须在词表里。
    const denial = delegatedDenial('ask_user_question')
    expect(denial, '子代理调用主控专用工具时守卫没有拒绝').toBeTypeOf('string')
    const named = [...(denial ?? '').matchAll(/status: "([a-z_]+)"/g)].map(entry => entry[1]!)
    for (const status of named) {
      expect(statuses, `守卫的拒绝文案点名了词表外的状态 "${status}"`).toContain(status)
    }
  })

  it('names the ledger tool once, and keeps it out of the preset rows', () => {
    // dispatch_ledger 是宿主在**根**注册面上一次性注册的全局静态工具：它不进
    // preset 的行表，所以两个 preset 之间的工具表不因它而变，Kimi 的前缀缓存
    // 也就不会因此重建。有人手滑加一行 preset 工具行，这条会当场变红。
    expect(DISPATCH_LEDGER_TOOL).toBe('dispatch_ledger')
    const persona = declaredPersona()
    const mentions = persona.split('\n').filter(line => line.includes(DISPATCH_LEDGER_TOOL))
    expect(mentions.length, `persona 里 ${DISPATCH_LEDGER_TOOL} 出现了 ${mentions.length} 次（应为一行短引导）`)
      .toBe(1)
    expect(mentions[0]).toContain('{action:"self"}')

    for (const row of yamlRows) {
      expect(row.name, `preset 行 "${row.id}" 挂载了 ${DISPATCH_LEDGER_TOOL}`).not.toContain(DISPATCH_LEDGER_TOOL)
      expect(brief(row.config), `preset 行 "${row.id}" 的 config 里出现了 ${DISPATCH_LEDGER_TOOL}`)
        .not.toContain(DISPATCH_LEDGER_TOOL)
    }
    for (const row of DISPATCH_PRESET.plugins) {
      expect(row.name, `声明行 "${row.id}" 挂载了 ${DISPATCH_LEDGER_TOOL}`).not.toContain(DISPATCH_LEDGER_TOOL)
    }
  })

  it('keeps the delegation tool names the ledger watches in step with the preset', () => {
    // 账本守卫盯着 subagent / subagent_fork 两种派发；preset 挂的正是这两个。
    // 对不上时，一次带头的派发要么不被校验，要么把别的工具当成派发。
    const declared = findRow(yamlRows, 'tool-subagent')
    expect(declared, 'preset 里没有 tool-subagent 行').toBeDefined()
    const fork = findRow(yamlRows, 'tool-subagent-fork')
    expect(fork, 'preset 里没有 tool-subagent-fork 行').toBeDefined()
    // preset 声明给这两个工具的模型侧名字。
    const toolNames = [declared!, fork!].map(row => {
      const config = row.config
      if (!isMapping(config)) throw new Error(`preset 行 "${row.id}" 没有 config`)
      return String(config['toolName'] ?? '')
    })
    expect(toolNames).toEqual(['subagent', 'subagent_fork'])
    for (const name of DEFAULT_GUARD_DISPATCH_TOOLS) {
      expect(toolNames, `账本守卫盯着 "${name}"，但 preset 没有声明这个工具名`).toContain(name)
    }
    expect(new Set(DEFAULT_DELEGATION_TOOLS)).toContain('subagent')
    expect(new Set(DEFAULT_SUBAGENT_INHERIT_TOOLS)).toContain('subagent_fork')
  })
})

// ── 3. Mandate v2 协议 ───────────────────────────────────────────────────

describe('the mandate protocol', () => {
  it('states every rejection code the guard can produce', () => {
    // 协议里列的拒绝码与守卫真的能抛的码必须同一份：少一个，模型被拒时读不到
    // 它的含义；多一个，模型会去等一个永远不会发生的拒绝。
    const expected = [
      'MANDATE_MALFORMED',
      'MANDATE_KIND',
      'MANDATE_DUPLICATE',
      'MANDATE_BRIEF_BUSY',
      'MANDATE_LINEAGE_REQUIRED',
      'MANDATE_LINEAGE',
      'MANDATE_POLICY_STALE',
      'MANDATE_VERSION',
      'MANDATE_NOT_PARENT',
      'MANDATE_NOT_CHILD',
      'MANDATE_GRANT_EXCEEDS',
      'MANDATE_NOT_HELD',
      'MANDATE_LEDGER_FULL',
    ] as const
    const inProtocol = [...new Set(DISPATCH_MANDATE_PROTOCOL.match(/MANDATE_[A-Z_]+/g) ?? [])].sort()
    expect(inProtocol, '协议正文里的拒绝码与守卫的拒绝码不一致')
      .toEqual([...expected].sort())
    // 编译期再钉一次：守卫的码联合与这里列的必须**完全**相同。
    type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    const sameUnion: SameUnion<typeof expected[number], DispatchDenialCode> = true
    expect(sameUnion, '守卫的拒绝码联合与协议列出的码不一致').toBe(true)
  })

  it('prefixes every denial with the code the ledger folds on', () => {
    const denial = dispatchDenial('MANDATE_DUPLICATE', 'the namespace is already claimed')
    expect(denial.startsWith(`${DISPATCH_GUARD_DENIAL_PREFIX}:MANDATE_DUPLICATE: `)).toBe(true)
  })

  it('keeps the protocol body out of the persona', () => {
    // 协议正文有 4KB 上下，persona 的预算只有 18500 字符，已经用掉大半。它只出现在
    // 工具结果的**尾部**——末尾追加不破坏前缀缓存。
    const persona = declaredPersona()
    expect(persona).not.toContain(MANDATE_PROTOCOL_ID)
    expect(persona).not.toContain('Mandate protocol')
    expect(persona).not.toMatch(/MANDATE_[A-Z_]+/)
    expect(DISPATCH_MANDATE_PROTOCOL.length).toBeLessThanOrEqual(DISPATCH_MANDATE_PROTOCOL_MAX_CHARS)
  })

  it('prints the protocol at the tail of the self result, and publishes prompt_ref', async () => {
    // 模型读到的最后一块必须就是协议：它先读头部的字段说明，再读协议正文。
    // prompt_ref 同理——模型不能自拟，它必须从 self 的结果里原样抄进头部。
    const session = fakeSession('session-1')
    const tool = createDispatchLedgerTool({
      cache: createDispatchLedgerCache(),
      policyFor: () => undefined,
      promptRef: 'plan-v3',
    })
    const value = await tool.execute({ action: 'self' } as never, { agent: { session } } as never)
    const record = value as unknown as Record<string, unknown>
    expect(record['prompt_ref']).toBe('plan-v3')
    expect(Object.keys(record).at(-1)).toBe('protocol')
    const output = tool.output as unknown as {
      render?: (args: unknown, value: unknown) => { type: string; text?: string }[]
    }
    const text = (output.render?.({ action: 'self' }, value) ?? []).map(block => block.text ?? '').join('')
    expect(text.endsWith(DISPATCH_MANDATE_PROTOCOL), '协议正文不在 self 结果的尾部').toBe(true)
    expect(text).toContain('prompt_ref (copy into a dispatch header): plan-v3')
    expect(DISPATCH_MANDATE_PROTOCOL).toContain('prompt_ref')
  })
})

// ── 4. 授权描述：PTC 与 Native 两侧 ───────────────────────────────────────

describe('the authorized subagent descriptions', () => {
  it('leaves no advisory or optional wording on either tool surface', () => {
    // 上游的工具描述写着"目录成员仅供参考""选择子模型是可选的"——在有白名单的
    // 会话里这两句都是假的，而且会把调度者带偏（省略路由，或去翻本地配置）。
    // 插件在 system-prompt/assemble 上原位重写 PTC 的 tools:sdk 段与 Native 的
    // 工具 schema，两侧都要干净。
    const upstreamCatalog = 'Discover LLM routes for subagents without changing the current Agent. '
      + 'Catalog membership is advisory: an adapter may accept an unlisted model id.'
    const upstreamSubagent = 'Delegate a self-contained task. '
      + 'Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent.'
    const allowed: AllowedModelRoute[] = [{ provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' }]
    const assembly = {
      sections: [{ name: 'tools:sdk', text: `${upstreamCatalog}\n${upstreamSubagent}` }],
      tools: [
        { name: 'list_subagent_models', description: upstreamCatalog, parameters: { type: 'object', properties: {} } },
        {
          name: 'subagent',
          description: upstreamSubagent,
          parameters: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                description: 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
              },
              model: {
                type: 'string',
                description: 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
              },
            },
          },
        },
      ],
    }
    const rewritten = rewriteAuthorizedPromptAssembly(assembly, allowed)
    const properties = (rewritten.tools[1]!.parameters as { properties: Record<string, { description: string }> }).properties
    const surfaces: [string, string, string[]][] = [
      [
        'PTC tools:sdk 段',
        rewritten.sections[0]!.text,
        ['Output is already filtered to this Session', 'Child LLM selection is required in this Session'],
      ],
      [
        'Native list_subagent_models.description',
        rewritten.tools[0]!.description,
        ['Output is already filtered to this Session'],
      ],
      [
        'Native subagent.description',
        rewritten.tools[1]!.description,
        ['Child LLM selection is required in this Session'],
      ],
      [
        'Native subagent.parameters.provider.description',
        properties['provider']!.description,
        ['Required in this Session'],
      ],
      [
        'Native subagent.parameters.model.description',
        properties['model']!.description,
        ['Required in this Session'],
      ],
    ]
    const residues = ['Catalog membership is advisory', 'Child LLM selection is optional', 'omit both to use configured child defaults']
    for (const [name, text, required] of surfaces) {
      for (const residue of residues) {
        expect(text, `${name} 还留着 "${residue}"`).not.toContain(residue)
      }
      // 每个面都要把"本会话必须显式路由"说清楚；model 参数说明的是"模型 id 不带
      // provider 前缀"，路由清单在 provider 参数与两处工具描述里。
      for (const phrase of required) {
        expect(text, `${name} 没有说清"${phrase}"`).toContain(phrase)
      }
    }
    for (const [name, text] of surfaces.slice(0, 4)) {
      expect(text, `${name} 没有点名已授权的路由`).toContain('minimax-code/MiniMax-M3.1-Flash')
    }
  })
})

// ── 5. 血缘：三个读取者看同一份头部 ───────────────────────────────────────

describe('the lineage the three readers share', () => {
  it('reads the same lineage fields for a delegated child', () => {
    // 授权、守卫、账本三处都靠 `session.header` 里的 origin 与 parentSession 判断
    // "这是谁派出来的"。三处读的不是同一处，血缘就会在某一处断掉。
    const root = {
      id: 'root-1',
      header: { origin: 'root' },
      eventAt: (seq: number) => (seq === 0
        ? {
            type: 'subagent/model-selection-policy',
            data: { allowedModels: [{ provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' }] },
          }
        : undefined),
      requestHeader: () => ({ config: { provider: 'codex-chatgpt', model: 'gpt-6-astra' } }),
    }
    const child = {
      id: 'child-1',
      header: { origin: 'subagent', parentSession: 'root-1' },
      eventAt: () => undefined,
      requestHeader: () => ({ config: { provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' } }),
    }
    const sessions = { get: (id: string) => (id === 'root-1' ? root : undefined) }

    // 守卫：持久血缘写着 origin=subagent 就是子代理。
    expect(isDelegatedCaller({ session: child })).toBe(true)
    expect(isDelegatedCaller({ session: root })).toBe(false)

    // 账本：parentSession 指回谁。
    expect(sessionIdOf(child)).toBe('child-1')
    expect(parentSessionIdOfSession(child)).toBe('root-1')

    // 授权：子代理沿 parentSession 继承根会话的白名单，主模型取的是**根**的。
    expect(authorizedRoutesFor({ session: child }, sessions))
      .toEqual([{ provider: 'minimax-code', model: 'MiniMax-M3.1-Flash' }])
    const resolved = resolveRootSessionAndMainRoute({ session: child }, sessions)
    expect(resolved.rootSession).toBe(root)
    expect(resolved.mainRoute).toEqual({ provider: 'codex-chatgpt', model: 'gpt-6-astra' })
  })
})

// ── 6. 常驻预算 ───────────────────────────────────────────────────────────

describe('the resident character budgets', () => {
  it('keeps the persona prefix and the guide line inside their budgets', () => {
    // persona 是每一步都重发的常驻字节：system 段或工具表一变，Kimi 的整个前缀
    // 缓存就归零。所以它的长度是被测出来的，不是估出来的。R0.5 闸门删除后，任务板契约
    // 改由 [Agent Teams Board] 段承载（board is bookkeeping, ledger stays
    // authoritative），预算保持 19000 作为余量；天花板仍负责挡住无界增长。
    const budget = 19000
    for (const [name, persona] of [['YAML', yamlPersona()], ['声明', declaredPersona()]] as const) {
      expect(persona.length, `${name} 侧 persona 超出 ${budget} 字符预算（还差 ${persona.length - budget}）`)
        .toBeLessThan(budget)
    }
    const guide = personaLine(declaredPersona(), '[Dispatch Ledger]')
    expect(guide.length, `引导行有 ${guide.length} 字符，超出 320 的预算`).toBeLessThanOrEqual(320)
    expect(DISPATCH_LEDGER_DESCRIPTION.length, 'dispatch_ledger 的工具描述超出 240 字符')
      .toBeLessThanOrEqual(240)
  })
})

// ── 测试内的替身 ──────────────────────────────────────────────────────────

/**
 * 造一份最小的会话记录。
 * @param id - 会话 id。
 * @returns 会话记录。
 */
function fakeSession(id: string): DispatchLedgerSessionLike {
  return { id, header: {}, events: [], snapshotEvents: () => [] }
}

/**
 * 造一份带 status 的报告头文本。
 * @param status - 报告状态。
 * @returns 头部文本。
 */
function reportHeader(status: string): string {
  const fields = {
    v: 2,
    kind: 'report',
    brief_id: 'b-7f',
    run_id: 'r-1',
    idem: 'i-1',
    mandate_version: 1,
    prompt_ref: 'plan-v3',
    policy: { id: 'dsh-dispatch-ledger', version: '1', sha256: '0123456789ab' },
    status,
  }
  return MANDATE_FENCE_OPEN + '\n' + JSON.stringify(fields) + '\n' + MANDATE_FENCE_CLOSE + '\nbody'
}

/**
 * 问一次执行期守卫：子代理调用主控专用工具时它说什么。
 * @param toolName - 被调用的工具名。
 * @returns 拒绝文案；放行时 undefined。
 */
function delegatedDenial(toolName: string): string | undefined {
  let registered: ((execution: unknown) => string | undefined) | undefined
  const tools = {
    guard: (guard: (execution: unknown) => string | undefined) => {
      registered = guard
      return () => undefined
    },
  }
  const ctx = { get: (name: string) => (name === 'tools' ? tools : undefined) }
  installDispatchExecutionGuard(ctx, { hasRunningChildren: () => false })
  return registered?.({
    name: toolName,
    agent: { session: { header: { origin: 'subagent' } } },
    arguments: {},
  })
}
