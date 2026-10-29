/**
 * 保守结构化投影：只有**可证明**的结构才换成预览，其余一律原样。
 *
 * 默认保守的四条线：
 *
 * - 小结果原样（不超过预算就不动），因为换来换去只会扰乱缓存前缀。
 * - 无法可靠解析的大文本原样；未知大文本原样；关键源码、接口/类型定义、子代理报告原样。
 * - 失败结果只允许换成「完整失败集」型预览（测试失败清单、shell 错误行），
 *   永远不会被压成一句计数 —— 计数看起来像结论，实际会把下一步的调试带偏。
 * - 预览必须自述完整度：带 ref、带省略字符数，读全文的路径写在预览里。
 *
 * 另一个不变量：本模块**不修改历史**。它返回一份新内容，调用方决定要不要写进新结果；
 * 已经进入历史的 preview 与其 refId 是常量，存储过期也不会回头改它。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/projection
 */

import {
  parseStructuredResultRows,
  type PreviewBudget,
  type ProjectionResult,
  type ProjectionStrategy,
  type ProjectToolResultInput,
  type StoredResultReference,
  type ToolResultBlock,
} from './contracts.ts'
import { cacheWarmupBudget } from './budget.ts'

/** 子代理报告：一律原样，摘要会丢掉调用方真正要的判断依据。 */
const TOOL_SUBAGENT = /(?:^|[-_/])(?:subagent|agent|task|delegate|ralph|teammate)(?:[-_/]|$)/i

/** 源码读取/写入类工具：一律原样。 */
const TOOL_SOURCE = /(?:^|[-_/])(?:read|view|cat|open|edit|write|patch|apply_patch|notebook|document|diff)(?:[-_/]|$)/i

/** 独立开关覆盖的检索工具；只有明确导航任务才允许进入新投影。 */
const TOOL_RETRIEVAL = /^(?:read|web_fetch|grep|glob)$/

/** 一行文本的裁剪（超长行才裁剪，并留下省略号）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 剥离终端 ANSI/CSI 转义序列（如 `\x1b[31mFAIL\x1b[0m`）与回车符 `\r`。
 *
 * JSON 解码后，原先源码/日志里的 `\u001b[31m` 会还原成控制字符 `\x1b`；
 * 如果不剥离，`^FAIL` 锚点匹配会被颜色码挡住，而再次 `JSON.stringify` 时每个
 * `\x1b` 又会膨胀成 6 个字符 `\u001b`。
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(/\r/g, '')
}

/**
 * 计算一行文本在最终输出里占用的精确字符宽度：
 * - 普通纯文本模式：`line.length + 1`（含换行符 `\n`）；
 * - JSON 字符串内嵌模式：`JSON.stringify(line).length`（去首尾引号后 `+ 2` 个字符的 `\\n` 换行转义，
 *   恰好等于 `JSON.stringify(line).length`，对 `"`、`\`、`\t`、`\u00xx` 的转义膨胀 100% 精确）。
 */
function lineCost(line: string, jsonEscaped: boolean): number {
  return jsonEscaped ? JSON.stringify(line).length : line.length + 1
}

/** 预览里的一个段落：`optional` 的段落整段装得下才放，绝不半截。 */
interface PreviewSection {
  lines: string[]
  optional?: boolean
}

/**
 * 按预算装配预览正文。
 *
 * 必需段落要么整段进来，要么整体装不下就返回 undefined（调用方据此保持原文）；
 * 可选段落逐段尝试，装不下就整段跳过。这样任何输出都不会出现「半截失败清单」。
 */
function fitSections(sections: readonly PreviewSection[], maxChars: number, jsonEscaped = false): string | undefined {
  const lines: string[] = []
  let used = 0
  const trailingNewlineAllowance = jsonEscaped ? 2 : 1
  for (const section of sections) {
    if (section.optional === true) continue
    for (const line of section.lines) {
      used += lineCost(line, jsonEscaped)
      lines.push(line)
    }
  }
  if (used > maxChars + trailingNewlineAllowance) return undefined
  for (const section of sections) {
    if (section.optional !== true) continue
    const size = section.lines.reduce((sum, line) => sum + lineCost(line, jsonEscaped), 0)
    if (used + size > maxChars + trailingNewlineAllowance) continue
    for (const line of section.lines) lines.push(line)
    used += size
  }
  return lines.join('\n')
}

/** 测试证据：完整失败清单 + 汇总行。 */
interface TestEvidence {
  summary: string[]
  failures: string[]
}

/** 从测试输出里抽取「完整失败集」与汇总行；抽不全就整体放弃。 */
function extractTestEvidence(text: string): TestEvidence | undefined {
  const summary: string[] = []
  const failures: string[] = []
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (
      /^(?:FAIL|FAILED|✗|✕|×)\s+\S/.test(trimmed) ||
      /^not ok \d+ - /.test(trimmed) ||
      /^●\s+\S/.test(trimmed) ||
      /^--- FAIL:\s/.test(trimmed)
    ) {
      failures.push(clip(trimmed, 240))
      continue
    }
    if (
      /^Test Files\s+\d/.test(trimmed) ||
      /^Tests\s+\d/.test(trimmed) ||
      /^Test Suites:\s/.test(trimmed) ||
      /^Snapshots:\s/.test(trimmed) ||
      /^Time:\s/.test(trimmed) ||
      /^={2,}.*\b\d+ (?:failed|passed|error)/.test(trimmed) ||
      /^\d+ (?:failed|passed), \d+ (?:passed|failed)/.test(trimmed)
    ) {
      summary.push(clip(trimmed, 200))
    }
  }
  if (summary.length === 0 && failures.length === 0) return undefined
  // 只有「失败行」而没有汇总行时，还要求正文里出现测试语汇，否则可能只是普通日志。
  if (summary.length === 0 && !/\b(?:test|tests|spec|suite|assert)\b/i.test(text.slice(0, 4000))) return undefined
  return { summary, failures }
}

/** 测试预览：失败集必须完整，汇总行紧随其后。 */
function buildTestSections(evidence: TestEvidence): PreviewSection[] {
  const sections: PreviewSection[] = [
    { lines: [`failures: ${evidence.failures.length} (complete set)`] },
  ]
  if (evidence.failures.length > 0) sections.push({ lines: evidence.failures.map((line) => `  ${line}`) })
  if (evidence.summary.length > 0) {
    sections.push({ lines: ['summary:', ...evidence.summary.map((line) => `  ${line}`)] })
  }
  return sections
}

/** 一行 shell 错误。用于「完整错误集」，所以匹配宁可宽一点。 */
const SHELL_ERROR_LINE =
  /(?:error|fatal|panic|traceback|exception|EACCES|EPERM|ENOENT|EEXIST|ELIFECYCLE|ERR!|FAILED|permission denied|cannot |could not |not found)/i

/** TypeScript 编译器报错首行：`path(line,col): error TSxxxx:` 或 `path:line:col - error TSxxxx:`。 */
const TS_DIAGNOSTIC_HEADER = /^(?:.+?\(\d+,\d+\):\s+error\s+TS\d+:|.+?:\d+:\d+\s+-\s+error\s+TS\d+:)/

/**
 * 紧跟在 TypeScript 诊断首行后面的续行（缩进的类型比对、代码高亮行、波浪线指示行），
 * 最多连带收集 6 行，使模型无需补读就能看全 `Type A is not assignable to Type B` 的完整原因。
 */
function isTsDiagnosticDetailLine(raw: string): boolean {
  if (/^\s{2,}\S/.test(raw)) return true
  if (/^\d+\s+\|/.test(raw.trimStart())) return true
  if (/^~+$/.test(raw.trim())) return true
  return false
}

/** 一行 glob 结果的判定：无空白、像文件路径（至少 80% 含路径分隔符或文件扩展名，不含引号/括号/冒号行号）。 */
function looksLikeGlobResult(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 10) return false
  let paths = 0
  let pathWithSepOrExt = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.length > 400) return false
    if (GREP_LINE.test(trimmed)) return false
    if (/^===.*===$/.test(trimmed)) return false
    if (/['"[\]{}()]/.test(trimmed)) return false
    if (/\s/.test(trimmed)) continue
    if (/^[-*+]$/.test(trimmed)) continue
    paths += 1
    if (/[\\/]/.test(trimmed) || /\.[A-Za-z0-9]{1,8}$/.test(trimmed)) pathWithSepOrExt += 1
  }
  return paths / lines.length >= 0.9 && pathWithSepOrExt / lines.length >= 0.8
}

/** 判断一行是否只是单纯的文件路径（含可选引号/逗号，如 `"test\\stream-error.test.ts",`），而非报错消息。 */
function isBareFilePathLine(trimmed: string): boolean {
  const unquoted = trimmed.replace(/^['"]|['"],?$/g, '').trim()
  if (unquoted.length === 0 || unquoted.length > 300 || /\s/.test(unquoted)) return false
  return /[\\/]/.test(unquoted) && /\.[A-Za-z0-9]{1,8}$/.test(unquoted) && !/:(\d+)/.test(unquoted)
}

/**
 * 判断文本是否为混合证据（如包含已投影的 `[cache-warmup preview]`、内嵌大型 JSON 对象行、
 * 多行 pretty-printed JSON 块、`util.inspect` 字符串拼接对象、分节头等）。
 */
function isMixedEvidenceOutput(text: string): boolean {
  if (text.includes('[cache-warmup preview]')) return true
  if (/^(?:===|---)\s+.+?(?:\s+(?:===|---))?$/m.test(text) || /^###\s+\S/m.test(text) || /^--\s+.+\s+--$/m.test(text)) {
    return true
  }
  const lines = text.split('\n')
  let inspectStringConcat = 0
  let jsonPropertyLines = 0
  for (const raw of lines.slice(0, 200)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    // 内嵌单行 JSON 对象/数组（如 console.log(JSON.stringify(r)) 与其它日志混打）：
    if (
      trimmed.length > 80 &&
      ((trimmed.startsWith('{"') && (trimmed.endsWith('}') || trimmed.includes('":'))) ||
        (trimmed.startsWith('[{"') && trimmed.includes('":')))
    ) {
      return true
    }
    // 多行 pretty-printed JSON 属性行（如 `"path": "..."`, `"root": "."`）：
    if (/^"[A-Za-z0-9_$-]+"\s*:/.test(trimmed)) {
      jsonPropertyLines += 1
      if (jsonPropertyLines >= 2) return true
    }
    // util.inspect 打印长字符串属性时的 `'...\n' +` 拼接行：
    if (/^['"].*\\n['"]\s*\+$/.test(trimmed)) {
      inspectStringConcat += 1
      if (inspectStringConcat >= 2) return true
    }
  }
  return false
}

/**
 * shell 输出判定：
 * - 排除混合证据输出（内嵌 JSON 行、`[cache-warmup preview]`、分节头、`util.inspect` 对象）；
 * - 有明确的退出码标记（`[exit code: N]`、`exit code: N`、`EXIT=N`）；
 * - 有 Python `Traceback (most recent call last):` 或 JS 异常头 + 堆栈行（`^\s+at\s+`）；
 * - 若没有任何退出码或堆栈，只有纯文本行时，要求不存在 grep 行，且错误行不是单纯的文件名。
 */
function looksLikeShellOutput(text: string): boolean {
  if (isMixedEvidenceOutput(text)) return false
  if (/(?:exit code|exited with code|process exited with code)[:=\s]+-?\d+/i.test(text)) return true
  if (/\[exit code: -?\d+\]/i.test(text)) return true
  if (/^EXIT=-?\d+$/m.test(text)) return true
  if (/^Traceback \(most recent call last\):/m.test(text)) return true
  if (/^(?:[A-Za-z]*Error|Exception): /m.test(text) && /^\s+at\s+\S/m.test(text)) return true
  const lines = text.split('\n')
  let grepLikes = 0
  let errors = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    // npm pack 的文件清单只是元数据；stream-error.d.ts 之类文件名不是构建错误。
    if (/^npm notice\s/.test(trimmed)) continue
    if (/^(?:PASS\b|[✓✔]|ok\s+\d+\b)/.test(trimmed)) continue
    if (/^stdout\s+\|\s+/.test(trimmed)) continue
    if (/^\(node:\d+\)\s+\[\w+\]\s+Warning:/.test(trimmed)) continue
    if (isBareFilePathLine(trimmed)) continue
    if (GREP_LINE.test(trimmed) && !TS_DIAGNOSTIC_HEADER.test(trimmed)) {
      grepLikes += 1
      if (grepLikes >= 2) return false
    }
    if (/^\s*(?:0|no)\s+(?:errors?|failures?|failed)\b/i.test(trimmed)) continue
    if (SHELL_ERROR_LINE.test(line)) errors += 1
  }
  return errors >= 1
}

/** shell 预览：退出码 + 完整错误集（必需，含 TS 多行诊断上下文），首尾片段（可选）。 */
function buildShellSections(text: string): PreviewSection[] | undefined {
  const lines = text.split('\n')
  const errors: string[] = []
  let errorCount = 0
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (/^npm notice\s/.test(trimmed)) continue
    if (/^\[exit code: -?\d+\]/i.test(trimmed)) continue
    if (/^\s*(?:0|no)\s+(?:errors?|failures?|failed)\b/i.test(trimmed)) continue
    if (/^(?:PASS\b|[✓✔]|ok\s+\d+\b)/.test(trimmed)) continue
    if (/^stdout\s+\|\s+/.test(trimmed)) continue
    if (/^\(node:\d+\)\s+\[\w+\]\s+Warning:/.test(trimmed)) continue
    if (isBareFilePathLine(trimmed)) continue
    if (TS_DIAGNOSTIC_HEADER.test(trimmed)) {
      errorCount += 1
      errors.push(`  ${clip(trimmed, 240)}`)
      let details = 0
      while (index + 1 < lines.length && details < 6) {
        const nextRaw = lines[index + 1]!
        const nextTrimmed = nextRaw.trim()
        if (nextTrimmed === '' || TS_DIAGNOSTIC_HEADER.test(nextTrimmed) || /^\[exit code: -?\d+\]/i.test(nextTrimmed)) {
          break
        }
        if (!isTsDiagnosticDetailLine(nextRaw)) break
        errors.push(`    ${clip(nextTrimmed, 240)}`)
        index += 1
        details += 1
      }
      continue
    }
    if (SHELL_ERROR_LINE.test(trimmed)) {
      errorCount += 1
      errors.push(`  ${clip(trimmed, 360)}`)
    }
  }
  // 错误集本身装不进一次预览时，宁可整段原样：半截错误清单比没有更危险。
  if (errorCount > 300 || errors.length > 600) return undefined
  const exitMatch =
    /(?:exit code|exited with code|process exited with code)[:=\s]+(-?\d+)/i.exec(text) ??
    /\[exit code: (-?\d+)\]/i.exec(text)
  const sections: PreviewSection[] = []
  if (exitMatch !== null) sections.push({ lines: [`exit code: ${exitMatch[1]}`] })
  sections.push({ lines: [`errors: ${errorCount} (complete set)`] })
  if (errors.length > 0) sections.push({ lines: errors })
  const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  const head = nonEmpty.slice(0, 5).map((line) => `  ${clip(line.trim(), 160)}`)
  const tail = nonEmpty.slice(-5).map((line) => `  ${clip(line.trim(), 160)}`)
  if (head.length > 0) sections.push({ lines: ['head:', ...head], optional: true })
  if (tail.length > 0) sections.push({ lines: ['tail:', ...tail], optional: true })
  return sections
}

/** grep 证据：每文件命中数 + 首条命中。 */
interface GrepEvidence {
  files: Map<string, { count: number; first: string }>
  total: number
}

/** 一行 grep 结果：`<path>:<line>[:<column>]:<text>` 或 `<path>:<line>(?:\t|\||\s{2,})<text>`。 */
const GREP_LINE = /^(.+?):(\d+)(?::(?:\d+:)?|\t|\|\s?|\s{2,})(.*)$/

/** 抽取 grep 证据；命中线占比不到 80% 就当它不是 grep 输出。 */
function extractGrepEvidence(text: string): GrepEvidence | undefined {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 10) return undefined
  const files = new Map<string, { count: number; first: string }>()
  let matched = 0
  for (const line of lines) {
    const match = GREP_LINE.exec(line)
    if (match === null) continue
    const file = match[1]!
    if (!/[\\/.]/.test(file) || file.length > 400) continue
    matched += 1
    const entry = files.get(file)
    if (entry === undefined) files.set(file, { count: 1, first: match[3]! })
    else entry.count += 1
  }
  if (matched < 10 || matched / lines.length < 0.8) return undefined
  return { files, total: matched }
}

/** grep 预览：命中总数与每文件计数（最多列 30 个文件，其余显式说明）。 */
function buildGrepSections(evidence: GrepEvidence): PreviewSection[] {
  const ranked = [...evidence.files.entries()].sort((left, right) => right[1].count - left[1].count)
  const shown = ranked.slice(0, 30)
  const sections: PreviewSection[] = [
    { lines: [`matches: ${evidence.total} across ${ranked.length} files`] },
    { lines: ['by file:', ...shown.map(([file, entry]) => `  ${clip(file, 120)}: ${entry.count}`)] },
  ]
  if (ranked.length > shown.length) {
    sections.push({ lines: [`  … ${ranked.length - shown.length} more files (full list via ref)`] })
  }
  sections.push({
    lines: ['first matches:', ...shown.slice(0, 8).map(([file, entry]) => `  ${clip(file, 80)}: ${clip(entry.first, 120)}`)],
    optional: true,
  })
  return sections
}

/** glob 预览：总数 + 扩展名分布（必需），样本路径（可选）。 */
function buildGlobSections(text: string): PreviewSection[] {
  const paths = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const byExtension = new Map<string, number>()
  for (const entry of paths) {
    const dot = entry.lastIndexOf('.')
    const slash = Math.max(entry.lastIndexOf('/'), entry.lastIndexOf('\\'))
    const extension = dot > slash ? entry.slice(dot).toLowerCase() : '(none)'
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1)
  }
  const top = [...byExtension.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6)
  const sample = paths.slice(0, 10).map((entry) => `  ${clip(entry, 140)}`)
  if (paths.length > 10) sample.push(`  … ${paths.length - 10} more`)
  return [
    { lines: [`paths: ${paths.length}`] },
    { lines: ['by extension:', ...top.map(([extension, count]) => `  ${extension}: ${count}`)] },
    { lines: ['sample:', ...sample], optional: true },
  ]
}

/** 结构化预览：行数与字段（必需），样本行（可选）。 */
function buildStructuredSections(text: string): PreviewSection[] | undefined {
  const parsed = parseStructuredResultRows(text)
  if (parsed === undefined) return undefined
  const sample = parsed.rows.slice(0, 3).map((row) => `  ${clip(JSON.stringify(row), 240)}`)
  return [
    { lines: [`rows: ${parsed.rows.length}`, `fields: ${parsed.fields.join(', ')}`] },
    { lines: ['sample:', ...sample], optional: true },
  ]
}

/** 剥离 `read` 工具或 `grep -C` 常见的行号前缀（如 `1: `、`1-  `、`1\t`、`1| `、`  12→`）。 */
const LINE_NUMBER_PREFIX = /^\s*\d+(?::(?:\s|$)|-\s{2,}|\t|\|(?:\s|$)|→\s?)/

function stripLineNumberPrefix(line: string): string {
  return line.replace(LINE_NUMBER_PREFIX, '')
}

/* 读取工具的带行号正文：捕获原始行号与声明文本。 */
const READ_NUMBERED_LINE = /^\s*(\d+)(?::(?:\s|$)|\t|\|(?:\s|$)|→\s?)(.*)$/

/* 可在导航大纲里可靠识别的声明；不猜方法体、调用关系或符号语义。 */
const OUTLINE_DECLARATION = /^(?:(?:export|default|declare|async|public|private|protected|static|readonly|abstract)\s+)*(?:function|class|interface|type|enum|const|let|var|def)\s+[A-Za-z_$][\w$]*/

/* 文件导航大纲：只列可识别声明的完整集合；结构不足时交给原文回退。 */
function buildFileOutlineSections(text: string): PreviewSection[] | undefined {
  const declarations: string[] = []
  let numberedLines = 0
  let previousLine = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const matched = READ_NUMBERED_LINE.exec(raw)
    // PTC 混合输出、命令行、分节头与多文件拼接都不是单一 read 结果。
    if (matched === null) return undefined
    const lineNumber = Number(matched[1])
    if (!Number.isSafeInteger(lineNumber) || lineNumber <= previousLine) return undefined
    previousLine = lineNumber
    numberedLines += 1
    // 只要顶层声明；函数体里的局部 const/let/var 既不是导航符号，也会撑爆预算。
    if (/^\s/.test(matched[2]!)) continue
    const code = matched[2]!.trim()
    if (!OUTLINE_DECLARATION.test(code)) continue
    declarations.push('  L' + matched[1] + ' ' + clip(code, 180))
    if (declarations.length > 200) return undefined
  }
  if (numberedLines < 5 || declarations.length === 0) return undefined
  return [
    { lines: ['declarations: ' + declarations.length + ' (recognized set; complete)'] },
    { lines: declarations },
  ]
}


/* 宿主 read 的规范 JSON：只有完整 lines 数组、连续行号和文本字段才可识别。 */
function buildJsonReadOutlineSections(text: string): PreviewSection[] | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const lines = record.lines
  if (!Array.isArray(lines) || lines.length < 5) return undefined
  const numbered: string[] = []
  let previousLine = 0
  for (const entry of lines) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const item = entry as Record<string, unknown>
    if (!Number.isSafeInteger(item.number) || typeof item.text !== 'string') return undefined
    const number = item.number as number
    if (number <= previousLine) return undefined
    previousLine = number
    numbered.push(String(number) + ': ' + item.text)
  }
  const reconstructed = numbered.join('\n')
  if (looksLikeContract(reconstructed)) return undefined
  const sections = buildFileOutlineSections(reconstructed)
  if (sections === undefined) return undefined
  if (typeof record.path !== 'string' || record.path.trim() === '') return sections
  return [
    // 路径是可选元数据；绝对路径装不下时省略它，不能因此丢掉完整声明集合。
    { lines: ['path: ' + clip(record.path, 180)], optional: true },
    ...sections,
  ]
}

/* 解码 heading 内常见的 HTML 实体；无法识别的实体原样保留。 */
function decodeOutlineEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/gi, (whole, decimal, hex) => {
    if (decimal !== undefined || hex !== undefined) {
      const point = Number.parseInt(decimal ?? hex, decimal !== undefined ? 10 : 16)
      if (Number.isSafeInteger(point) && point >= 0 && point <= 0x10FFFF) {
        try { return String.fromCodePoint(point) } catch { return whole }
      }
      return whole
    }
    const key = whole.slice(1, -1).toLowerCase()
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[key] ?? whole
  })
}

/* 清理 heading 内联标签，不处理正文，也不对网页内容做相关性摘要。 */
function cleanOutlineHeading(text: string): string {
  return decodeOutlineEntities(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/* 网页导航大纲：完整 title 与 h1-h3 / Markdown heading 集合；没有完整结构就放弃。 */
function buildWebOutlineSections(text: string): PreviewSection[] | undefined {
  let title = ''
  const headings: Array<{ level: number, text: string }> = []
  if (/<(?:html|head|body|h[1-3])(?:\s|>)/i.test(text)) {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)
    if (titleMatch !== null) title = cleanOutlineHeading(titleMatch[1]!)
    const pattern = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const heading = cleanOutlineHeading(match[2]!)
      if (heading !== '') headings.push({ level: Number(match[1]), text: heading })
      if (headings.length > 100) return undefined
    }
  } else {
    const pattern = /^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/gm
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const heading = match[2]!.trim()
      if (heading !== '') headings.push({ level: match[1]!.length, text: clip(heading, 180) })
      if (headings.length > 100) return undefined
    }
  }
  if (title === '' && headings.length === 0) return undefined
  const lines = ['headings: ' + headings.length + ' (complete set)']
  if (title !== '') lines.push('title: ' + clip(title, 180))
  return [
    { lines },
    { lines: headings.map((heading) => '  H' + heading.level + ' ' + clip(heading.text, 180)) },
  ]
}

/* 直接文件/网页读取的大纲入口；grep/glob 由已有的完整计数策略处理。 */
function planRetrievalOutline(text: string, toolName: string): Extract<ProjectionPlan, { kind: 'preview' }> | undefined {
  if (toolName === 'read') {
    const sections = buildJsonReadOutlineSections(text) ?? buildFileOutlineSections(text)
    return sections === undefined ? undefined : { kind: 'preview', strategy: 'file-outline', sections }
  }
  if (toolName === 'web_fetch') {
    const sections = buildWebOutlineSections(text)
    return sections === undefined ? undefined : { kind: 'preview', strategy: 'web-outline', sections }
  }
  return undefined
}

/** 契约/类型定义：命中两行以上声明就当它是契约，保持原样。 */
function looksLikeContract(text: string): boolean {
  let declarations = 0
  for (const raw of text.split('\n').slice(0, 800)) {
    const line = stripLineNumberPrefix(raw)
    if (/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/.test(line)) declarations += 1
    if (declarations >= 2) return true
  }
  return false
}

/**
 * 源码或混合证据判定：
 * - 含多处 markdown 代码围栏；
 * - 含 `git diff` 补丁块（`diff --git` / `@@ -x,y +x,y @@`）；
 * - 含至少 5 行带行号的源码切片（`1: ...` 或 `1\t...`），说明是单文件或多文件混合读取输出；
 * - 代码行占比 >= 45%。
 */
function looksLikeSourceCode(text: string): boolean {
  if (/^diff --git\s+/m.test(text) || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) return true
  let fences = 0
  for (const line of text.split('\n').slice(0, 600)) {
    if (stripLineNumberPrefix(line).trim().startsWith('```')) fences += 1
  }
  if (fences >= 4) return true
  let code = 0
  let numbered = 0
  let nonEmpty = 0
  for (const raw of text.split('\n').slice(0, 600)) {
    if (raw.trim() === '') continue
    if (LINE_NUMBER_PREFIX.test(raw)) numbered += 1
    const trimmed = stripLineNumberPrefix(raw).trim()
    if (trimmed === '') continue
    nonEmpty += 1
    if (
      /^(?:import|export|from|const|let|var|function|class|interface|type|enum|async|await|return|if|for|while|switch|case|break|continue|try|catch|finally|throw|new|public|private|protected|static|readonly|def|using|namespace|package|#include|#pragma)\b/.test(
        trimmed,
      ) ||
      /^[})\];]/.test(trimmed) ||
      /^(?:\/\/|\/\*|\*)/.test(trimmed) ||
      /^<\/?[A-Za-z][\w.-]*/.test(trimmed)
    ) {
      code += 1
    }
  }
  if (numbered >= 5) return true
  return nonEmpty >= 10 && code / nonEmpty >= 0.45
}

/** 完整 JSON 文档（对象、数组、JSON 字符串）或被截断的 JSON 对象：不按裸日志猜测。 */
function isJsonDocument(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (first === '"' && last === '"') {
    try {
      return typeof JSON.parse(trimmed) === 'string'
    } catch {
      return false
    }
  }
  if (first !== '{' && first !== '[') return false
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      const value: unknown = JSON.parse(trimmed)
      return typeof value === 'object' && value !== null
    } catch {
      // 落入下方的截断对象判定。
    }
  }
  // DSH 的 50K 输出上限可能正好截断一个 JSON 对象。此时没有完整可解析文档，
  // 但前几个字段已经足以证明它是 envelope，而不是一份裸 shell/glob 日志。
  if (first === '{') {
    let fields = 0
    for (const line of trimmed.split('\n').slice(0, 24)) {
      if (/^\s*"[^"]+"\s*:/.test(line)) fields += 1
    }
    return fields >= 2
  }
  return false
}

/** PTC `run_code` JSON envelope 中允许独立投影日志的字段白名单。 */
const JSON_ENVELOPE_LOG_KEYS = ['stdout', 'stderr', 'output', 'logs', 'log'] as const

/** JSON envelope 其余字段允许占用的最大序列化字符数（防止把含批量源码的混合 envelope 压掉）。 */
const JSON_ENVELOPE_MAX_OTHER_CHARS = 800

/**
 * 解开一层或两层 JSON 包装（支持顶层 JSON 字符串 `"..."` 或双重序列化的 `"{...}"`）。
 */
function parseJsonCandidate(text: string):
  | { kind: 'string'; decoded: string }
  | { kind: 'object'; record: Record<string, unknown>; wrappedInString: boolean }
  | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 2) return undefined
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (first === '"' && last === '"') {
    try {
      const inner: unknown = JSON.parse(trimmed)
      if (typeof inner !== 'string') return undefined
      const innerTrimmed = inner.trim()
      if (innerTrimmed.startsWith('{') && innerTrimmed.endsWith('}')) {
        try {
          const innerObj: unknown = JSON.parse(innerTrimmed)
          if (innerObj !== null && typeof innerObj === 'object' && !Array.isArray(innerObj)) {
            return { kind: 'object', record: innerObj as Record<string, unknown>, wrappedInString: true }
          }
        } catch {
          // 内部不是 JSON 对象，按普通序列化字符串处理。
        }
      }
      return { kind: 'string', decoded: inner }
    } catch {
      return undefined
    }
  }
  if (first === '{' && last === '}') {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { kind: 'object', record: parsed as Record<string, unknown>, wrappedInString: false }
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 尝试从完整 JSON（顶层 JSON 字符串或对象 envelope）中解出可结构化投影的日志正文。
 *
 * 规则刻意保守：
 * - 截断 JSON、数组一律返回 undefined；
 * - 对象 envelope 除白名单字段外，其余字段序列化后的总长度不超过 `JSON_ENVELOPE_MAX_OTHER_CHARS`；
 * - 解码并剥离 ANSI 后的日志文本自身必须能通过非源码/非契约的结构化日志投影计划；
 * - 返回的 `storeContent` 把解码后的多行日志直接展开（对象 envelope 还会把其余元数据缩进在头部），
 *   彻底避免单行 minified JSON 因没有真实 `\n` 导致 `store.page` 的按行分页失效。
 */
function extractJsonEnvelopeLogField(
  text: string,
  toolName: string,
): {
  envelope?: { record: Record<string, unknown>; key: string }
  plan: Extract<ProjectionPlan, { kind: 'preview' }>
} | undefined {
  const candidate = parseJsonCandidate(text)
  if (candidate === undefined) return undefined

  if (candidate.kind === 'string') {
    const clean = stripAnsi(candidate.decoded)
    if (isJsonDocument(clean) || isMixedEvidenceOutput(clean)) return undefined
    const plan = planPlainTextProjection(clean, toolName)
    if (plan.kind !== 'preview') return undefined
    return { plan }
  }

  const { record } = candidate
  let candidateKey: string | undefined
  let candidateText = ''
  for (const key of JSON_ENVELOPE_LOG_KEYS) {
    const val = record[key]
    if (typeof val === 'string' && val.length > candidateText.length) {
      candidateKey = key
      candidateText = val
    }
  }
  if (candidateKey === undefined || candidateText.length === 0) return undefined

  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === candidateKey) continue
    // 其余字段若包含长段源码或契约，视为混合证据，整体保持原样。
    if (typeof value === 'string' && (value.length > 400 || looksLikeSourceCode(value) || looksLikeContract(value))) {
      return undefined
    }
    rest[key] = value
  }
  const restJson = JSON.stringify(rest)
  if (restJson.length > JSON_ENVELOPE_MAX_OTHER_CHARS) return undefined

  const cleanField = stripAnsi(candidateText)
  if (isJsonDocument(cleanField) || isMixedEvidenceOutput(cleanField)) return undefined
  const plan = planPlainTextProjection(cleanField, toolName)
  if (plan.kind !== 'preview') return undefined
  return {
    envelope: { record, key: candidateKey },
    plan,
  }
}

/** 投影计划：要么给一段预览，要么明确为什么保持原样。 */
type ProjectionPlan =
  | {
      kind: 'preview'
      strategy: ProjectionStrategy
      sections: PreviewSection[]
      envelope?: { record: Record<string, unknown>; key: string }
    }
  | { kind: 'verbatim'; strategy: ProjectionStrategy }

/** 对一段纯文本（非 JSON 文档）做投影计划判定。 */
function planPlainTextProjection(rawText: string, toolName: string): ProjectionPlan {
  const text = stripAnsi(rawText)
  if (looksLikeContract(text)) return { kind: 'verbatim', strategy: 'verbatim-contract' }
  if (looksLikeSourceCode(text)) return { kind: 'verbatim', strategy: 'verbatim-source-code' }

  const test = extractTestEvidence(text)
  if (test !== undefined && test.failures.length > 0) {
    return { kind: 'preview', strategy: 'test-failure', sections: buildTestSections(test) }
  }

  const grep = extractGrepEvidence(text)
  if (grep !== undefined) return { kind: 'preview', strategy: 'grep-results', sections: buildGrepSections(grep) }

  const structured = buildStructuredSections(text)
  if (structured !== undefined) return { kind: 'preview', strategy: 'structured-rows', sections: structured }

  if (looksLikeGlobResult(text)) return { kind: 'preview', strategy: 'glob-results', sections: buildGlobSections(text) }

  if (looksLikeShellOutput(text)) {
    const sections = buildShellSections(text)
    if (sections === undefined) return { kind: 'verbatim', strategy: 'verbatim-unparsed' }
    return { kind: 'preview', strategy: 'shell-output', sections }
  }

  return { kind: 'verbatim', strategy: 'verbatim-unparsed' }
}

/**
 * 决定这一段文本该怎么处理。
 *
 * 顺序就是「可证明性」的顺序：子代理报告/源码工具/契约先被判成原样，
 * 然后是 JSON envelope（只允许纯日志字段投影，混合证据一律原样），
 * 接着是测试失败集、grep、结构化、glob、shell 这些有明确形状的，
 * 最后落到「无法解析 → 原样」。
 */
function planProjection(text: string, toolName: string, navigation?: boolean, retrievalOnly?: boolean): ProjectionPlan {
  if (TOOL_SUBAGENT.test(toolName)) return { kind: 'verbatim', strategy: 'verbatim-subagent-report' }
  const retrieval = TOOL_RETRIEVAL.test(toolName)
  // 宿主明确给出 false 才按新意图门控回退；核心旧调用不传该字段时保留原策略。
  if (retrieval && navigation === false) return { kind: 'verbatim', strategy: 'verbatim-intent' }
  if (TOOL_SOURCE.test(toolName) && navigation !== true) return { kind: 'verbatim', strategy: 'verbatim-source-code' }
  if (looksLikeContract(text)) return { kind: 'verbatim', strategy: 'verbatim-contract' }
  // PTC 把 read 包在 run_code 里：只接受严格单一行号文件，混合输出继续原样/原日志策略。
  if (toolName === 'run_code' && navigation === true) {
    const outline = planRetrievalOutline(text, 'read')
    if (outline !== undefined) return outline
    if (retrievalOnly === true) return { kind: 'verbatim', strategy: 'verbatim-intent' }
  }
  if (retrieval) {
    const outline = planRetrievalOutline(text, toolName)
    if (outline !== undefined) return outline
  }
  // run_code 常返回 JSON envelope 或 JSON 序列化字符串：若只是轻量状态配一个超长日志字段
  // （stdout/stderr/output/logs）或纯日志字符串，只替换日志部分；若含多份源码或被截断，则整份保持原样。
  if (isJsonDocument(text)) {
    const extracted = extractJsonEnvelopeLogField(text, toolName)
    if (extracted !== undefined) {
      return {
        kind: 'preview',
        strategy: extracted.plan.strategy,
        sections: extracted.plan.sections,
        ...(extracted.envelope === undefined ? {} : { envelope: extracted.envelope }),
      }
    }
    return { kind: 'verbatim', strategy: 'verbatim-unparsed' }
  }
  return planPlainTextProjection(text, toolName)
}

/** 预览尾部：把「怎么读全文」写死在预览里，模型不用猜。 */
function footerFor(refId: string): string {
  return `[full result: ${refId} · page with offset/limit(default 64 lines)/maxBytes(default 16384 bytes)]`
}

/** 一次投影的最终判定：要么换成预览，要么给出保持原样的原因。 */
type Decision =
  | { preview: string; refId: string; strategy: ProjectionStrategy }
  | { reason: ProjectionStrategy }

/**
 * 核心决策：预算 → 计划 → 装配 → 入库。
 *
 * 入库放在最后：预览装不进预算就不写文件，也不会留下一条没人引用的引用。
 * 入库失败一律降级为「保持原样」—— 没有 ref 的预览等于把原文丢了。
 */
async function decide(args: {
  text: string
  input: ProjectToolResultInput
  budget: PreviewBudget
  at: number
}): Promise<Decision> {
  const { text, input, budget } = args
  if (text.length <= budget.maxChars) return { reason: 'verbatim-small' }

  const plan = planProjection(text, input.toolName, input.navigation, input.retrievalOnly)
  if (plan.kind === 'verbatim') return { reason: plan.strategy }

  // 失败结果只允许「完整失败集」型预览，计数型摘要一律不换。
  if (input.isError === true && plan.strategy !== 'test-failure' && plan.strategy !== 'shell-output') {
    return { reason: 'verbatim-unparsed' }
  }

  const header = `[cache-warmup preview] strategy=${plan.strategy} input=${text.length}ch`
  const footerBudget = footerFor(`ref://${input.sessionId}/${'0'.repeat(64)}`).length
  const jsonEscaped = plan.envelope !== undefined
  // JSON envelope 投影时，除日志字段外的壳以及 header/footer 的转义换行（2 个 \\n 各多 1 字符）精确扣除。
  const envelopeShellLength = plan.envelope === undefined
    ? 0
    : JSON.stringify({ ...plan.envelope.record, [plan.envelope.key]: '' }).length
  const bodyBudget = budget.maxChars - header.length - footerBudget - envelopeShellLength - (jsonEscaped ? 4 : 2)
  if (bodyBudget <= 0) return { reason: 'verbatim-budget' }
  const body = fitSections(plan.sections, bodyBudget, jsonEscaped)
  if (body === undefined) return { reason: 'verbatim-budget' }

  const store = input.store
  if (store === undefined) return { reason: 'store-unavailable' }
  const placeholderFooter = footerFor(`ref://${input.sessionId}/${'0'.repeat(64)}`)
  const placeholderInner = `${header}\n${body}\n${placeholderFooter}`
  const placeholderPreview = plan.envelope === undefined
    ? placeholderInner
    : JSON.stringify({ ...plan.envelope.record, [plan.envelope.key]: placeholderInner })
  if (placeholderPreview.length > budget.maxChars) return { reason: 'verbatim-budget' }

  let reference: StoredResultReference
  try {
    reference = await store.put({ sessionId: input.sessionId, content: text, toolName: input.toolName, at: args.at })
  } catch {
    return { reason: 'store-unavailable' }
  }
  const innerPreview = `${header}\n${body}\n${footerFor(reference.refId)}`
  const preview = plan.envelope === undefined
    ? innerPreview
    : JSON.stringify({ ...plan.envelope.record, [plan.envelope.key]: innerPreview })
  if (preview.length > budget.maxChars) return { reason: 'verbatim-budget' }
  return { preview, refId: reference.refId, strategy: plan.strategy }
}

/** 块数组里文本字符数的合计。 */
function textCharsOf(blocks: readonly ToolResultBlock[]): number {
  let total = 0
  for (const block of blocks) if (typeof block.text === 'string') total += block.text.length
  return total
}

/**
 * 投影一条工具结果。
 *
 * 纯函数式语义：不改入参、不写日志、不碰历史；返回新内容 + 度量。
 * 只有 `changed: true` 时才有 `refId`/`preview`。
 * @param input - 工具结果与预算。
 * @returns 投影结果。
 */
export async function projectToolResult(input: ProjectToolResultInput): Promise<ProjectionResult> {
  const at = input.at ?? Date.now()
  const budget = input.budget ?? cacheWarmupBudget(input.sessionId)
  const base = {
    toolName: input.toolName,
    sessionId: input.sessionId,
    provider: input.provider,
    at,
  }

  if (typeof input.content === 'string') {
    const text = input.content
    const decision = await decide({ text, input, budget, at })
    if ('reason' in decision) {
      return {
        ...base,
        content: input.content,
        changed: false,
        metrics: { inputChars: text.length, outputChars: text.length, omittedChars: 0, strategy: decision.reason },
      }
    }
    return {
      ...base,
      content: decision.preview,
      changed: true,
      refId: decision.refId,
      preview: decision.preview,
      metrics: {
        inputChars: text.length,
        outputChars: decision.preview.length,
        omittedChars: Math.max(0, text.length - decision.preview.length),
        strategy: decision.strategy,
      },
    }
  }

  const blocks = input.content as readonly ToolResultBlock[]
  const singleTextBlock =
    blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0]?.text === 'string'
  if (!singleTextBlock) {
    const chars = textCharsOf(blocks)
    const hasNonText = blocks.some((block) => block.type !== 'text')
    return {
      ...base,
      content: input.content,
      changed: false,
      metrics: {
        inputChars: chars,
        outputChars: chars,
        omittedChars: 0,
        strategy: hasNonText ? 'verbatim-non-text' : 'verbatim-unparsed',
      },
    }
  }

  const text = blocks[0]!.text as string
  const decision = await decide({ text, input, budget, at })
  if ('reason' in decision) {
    return {
      ...base,
      content: input.content,
      changed: false,
      metrics: { inputChars: text.length, outputChars: text.length, omittedChars: 0, strategy: decision.reason },
    }
  }
  // 只有文本块的正文被替换，块的其他字段逐字保留。
  const rebuilt: ToolResultBlock = { ...blocks[0]!, text: decision.preview }
  return {
    ...base,
    content: [rebuilt],
    changed: true,
    refId: decision.refId,
    preview: decision.preview,
    metrics: {
      inputChars: text.length,
      outputChars: decision.preview.length,
      omittedChars: Math.max(0, text.length - decision.preview.length),
      strategy: decision.strategy,
    },
  }
}

/** 便于测试/统计：当前生效的默认预览预算（不传会话）。 */
export function defaultPreviewBudget(): PreviewBudget {
  return cacheWarmupBudget()
}
