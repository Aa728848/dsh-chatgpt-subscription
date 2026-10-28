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

/** 一行文本的裁剪（超长行才裁剪，并留下省略号）。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
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
function fitSections(sections: readonly PreviewSection[], maxChars: number): string | undefined {
  const lines: string[] = []
  let used = 0
  for (const section of sections) {
    if (section.optional === true) continue
    for (const line of section.lines) {
      used += line.length + 1
      lines.push(line)
    }
  }
  if (used > maxChars + 1) return undefined
  for (const section of sections) {
    if (section.optional !== true) continue
    const size = section.lines.reduce((sum, line) => sum + line.length + 1, 0)
    if (used + size > maxChars + 1) continue
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

/** 一行 glob 结果的判定：无空白、像路径。 */
function looksLikeGlobResult(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 10) return false
  let paths = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.length > 400) continue
    if (/\s/.test(trimmed)) continue
    if (/^[-*+]$/.test(trimmed)) continue
    paths += 1
  }
  return paths / lines.length >= 0.9
}

/** shell 输出判定：有退出码标记，或至少一行错误。 */
function looksLikeShellOutput(text: string): boolean {
  if (/(?:exit code|exited with code|process exited with code)[:=\s]+-?\d+/i.test(text)) return true
  if (/\[exit code: -?\d+\]/i.test(text)) return true
  if (/^Traceback \(most recent call last\):/m.test(text)) return true
  const lines = text.split('\n')
  let errors = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    if (/^\s*(?:0|no)\s+(?:errors?|failures?|failed)\b/i.test(line.trim())) continue
    if (SHELL_ERROR_LINE.test(line)) errors += 1
    if (errors >= 1) return true
  }
  return false
}

/** shell 预览：退出码 + 完整错误集（必需），首尾片段（可选）。 */
function buildShellSections(text: string): PreviewSection[] | undefined {
  const lines = text.split('\n')
  const errors: string[] = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (/^\[exit code: -?\d+\]/i.test(trimmed)) continue
    if (/^\s*(?:0|no)\s+(?:errors?|failures?|failed)\b/i.test(trimmed)) continue
    if (SHELL_ERROR_LINE.test(trimmed)) errors.push(`  ${clip(trimmed, 240)}`)
  }
  // 错误集本身装不进一次预览时，宁可整段原样：半截错误清单比没有更危险。
  if (errors.length > 300) return undefined
  const exitMatch =
    /(?:exit code|exited with code|process exited with code)[:=\s]+(-?\d+)/i.exec(text) ??
    /\[exit code: (-?\d+)\]/i.exec(text)
  const sections: PreviewSection[] = []
  if (exitMatch !== null) sections.push({ lines: [`exit code: ${exitMatch[1]}`] })
  sections.push({ lines: [`errors: ${errors.length} (complete set)`] })
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

/** 一行 grep 结果：`<path>:<line>[:<column>]:<text>`。 */
const GREP_LINE = /^(.+?):(\d+):(?:\d+:)?(.*)$/

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

/** 契约/类型定义：命中两行以上声明就当它是契约，保持原样。 */
function looksLikeContract(text: string): boolean {
  let declarations = 0
  for (const line of text.split('\n').slice(0, 800)) {
    if (/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+[A-Za-z_$][\w$]*/.test(line)) declarations += 1
    if (declarations >= 2) return true
  }
  return false
}

/** 源码判定：代码行占比过半（或含多处 markdown 代码围栏）。 */
function looksLikeSourceCode(text: string): boolean {
  let fences = 0
  for (const line of text.split('\n').slice(0, 600)) {
    if (line.trim().startsWith('```')) fences += 1
  }
  if (fences >= 4) return true
  let code = 0
  let nonEmpty = 0
  for (const raw of text.split('\n').slice(0, 600)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    nonEmpty += 1
    if (
      /^(?:import|export|from|const|let|var|function|class|interface|type|enum|async|await|return|if|for|while|switch|case|break|continue|try|catch|finally|throw|new|public|private|protected|static|readonly|def|using|namespace|package|#include|#pragma)\b/.test(
        trimmed,
      ) ||
      /^[})\];]/.test(trimmed) ||
      /^(?:\/\/|\/\*|\*)/.test(trimmed)
    ) {
      code += 1
    }
  }
  return nonEmpty >= 10 && code / nonEmpty >= 0.45
}

/** 完整 JSON 文档或被截断的 JSON 对象：可能是批量源码/混合证据，不按裸日志猜测。 */
function isJsonDocument(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
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

/** 投影计划：要么给一段预览，要么明确为什么保持原样。 */
type ProjectionPlan =
  | { kind: 'preview'; strategy: ProjectionStrategy; sections: PreviewSection[] }
  | { kind: 'verbatim'; strategy: ProjectionStrategy }

/**
 * 决定这一段文本该怎么处理。
 *
 * 顺序就是「可证明性」的顺序：子代理报告/源码工具/契约先被判成原样，
 * 然后是测试失败集、grep、结构化、glob、shell 这些有明确形状的，
 * 最后落到「无法解析 → 原样」。
 */
function planProjection(text: string, toolName: string): ProjectionPlan {
  if (TOOL_SUBAGENT.test(toolName)) return { kind: 'verbatim', strategy: 'verbatim-subagent-report' }
  if (TOOL_SOURCE.test(toolName)) return { kind: 'verbatim', strategy: 'verbatim-source-code' }
  if (looksLikeContract(text)) return { kind: 'verbatim', strategy: 'verbatim-contract' }
  // run_code 常返回 JSON envelope，里面可能同时装多份源码和日志。先识别完整文档，
  // 绝不让字符串里的 error/cannot/path 把整批证据误当成一份 shell 或 glob 输出。
  if (isJsonDocument(text)) return { kind: 'verbatim', strategy: 'verbatim-unparsed' }
  // 源码中的错误字符串同样不是 shell 证据；源码保护必须早于所有日志分类器。
  if (looksLikeSourceCode(text)) return { kind: 'verbatim', strategy: 'verbatim-source-code' }

  const test = extractTestEvidence(text)
  if (test !== undefined) return { kind: 'preview', strategy: 'test-failure', sections: buildTestSections(test) }

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

  const plan = planProjection(text, input.toolName)
  if (plan.kind === 'verbatim') return { reason: plan.strategy }

  // 失败结果只允许「完整失败集」型预览，计数型摘要一律不换。
  if (input.isError === true && plan.strategy !== 'test-failure' && plan.strategy !== 'shell-output') {
    return { reason: 'verbatim-unparsed' }
  }

  const header = `[cache-warmup preview] strategy=${plan.strategy} input=${text.length}ch`
  const footerBudget = footerFor(`ref://${input.sessionId}/${'0'.repeat(64)}`).length
  const bodyBudget = budget.maxChars - header.length - footerBudget - 2
  if (bodyBudget <= 0) return { reason: 'verbatim-budget' }
  const body = fitSections(plan.sections, bodyBudget)
  if (body === undefined) return { reason: 'verbatim-budget' }

  const store = input.store
  if (store === undefined) return { reason: 'store-unavailable' }
  let reference: StoredResultReference
  try {
    reference = await store.put({ sessionId: input.sessionId, content: text, toolName: input.toolName, at: args.at })
  } catch {
    return { reason: 'store-unavailable' }
  }
  const preview = `${header}\n${body}\n${footerFor(reference.refId)}`
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
