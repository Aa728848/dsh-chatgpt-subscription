/**
 * 保守结构化投影：只有可证明的结构才换成预览，其余原样。
 *
 * 这一组用例钉住「什么绝对不能动」：未知大文本、关键源码、契约/类型定义、
 * 子代理报告、非文本块、失败集装不进预算的大结果 —— 全部必须 `changed: false`，
 * 且内容与入参逐字相同。反过来，测试失败集、shell 错误集、grep/glob 计数、
 * 结构化行必须真的被结构化，并且保留一条能读回全文的 ref。
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewBudget, ToolResultBlock } from '../src/host/cache-warmup/contracts.ts'
import { projectToolResult } from '../src/host/cache-warmup/projection.ts'
import { FileResultReferenceStore } from '../src/host/cache-warmup/store.ts'

/** 本次测试创建的临时目录。 */
const roots: string[] = []

/** 建一个独立临时目录。 */
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cache-warmup-project-'))
  roots.push(root)
  return root
}

/** 逐条目清理（只删具体文件与空目录，不递归删树）。 */
async function removeEntries(directory: string): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    const stats = await fs.lstat(full).catch(() => undefined)
    if (stats === undefined || stats.isSymbolicLink()) {
      await fs.rm(full, { force: true }).catch(() => undefined)
      continue
    }
    if (stats.isDirectory()) await removeEntries(full)
    else await fs.rm(full, { force: true }).catch(() => undefined)
  }
  await fs.rmdir(directory).catch(() => undefined)
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await removeEntries(root)
  }
})

/** 预热期预算（1200 字符）。 */
const WARMUP: PreviewBudget = { maxChars: 1200, warmup: true, consecutiveHits: 0, hitRatio: 0 }
/** 稳态预算（8000 字符）：真实会话里构建日志走的就是这一档。 */
const STEADY: PreviewBudget = { maxChars: 8000, warmup: false, consecutiveHits: 2, hitRatio: 0.99 }

/**
 * 把存储里的原文按页读完并拼回来。
 * @param store - 引用存储。
 * @param sessionId - 会话 id。
 * @param refId - 引用。
 * @returns 拼起来的完整原文。
 */
async function readAllPages(
  store: FileResultReferenceStore,
  sessionId: string,
  refId: string,
): Promise<string> {
  let offset = 0
  let collected = ''
  for (;;) {
    const page = await store.page({ sessionId, refId, offset, limit: 512, maxBytes: 65_536 })
    collected += page.content
    if (page.complete) return collected
    expect(page.nextOffset).not.toBeNull()
    offset = page.nextOffset!
  }
}
/** 收紧到 700 字符的预算：够放下一份小失败集，但放不下长清单。 */
const TIGHT: PreviewBudget = { maxChars: 700, warmup: true, consecutiveHits: 0, hitRatio: 0 }
/** 极紧预算：任何完整失败集都装不下。 */
const STARVED: PreviewBudget = { maxChars: 300, warmup: true, consecutiveHits: 0, hitRatio: 0 }

/** 一份 vitest 风格的失败日志：60 行通过 + 4 个失败 + 汇总。 */
function failingTestLog(failures = 4): string {
  const lines = [' RUN  v4.1.8 C:/repo']
  for (let index = 0; index < 60; index += 1) lines.push(` ✓ test/case-${index}.test.ts > works ${index} (2ms)`)
  for (let index = 0; index < failures; index += 1) {
    lines.push(` FAIL  test/broken-${index}.test.ts > suite ${index} > case ${index}`)
  }
  lines.push(' AssertionError: expected 1 to be 2')
  lines.push('')
  lines.push(' Test Files  1 failed | 60 passed (61)')
  lines.push(`      Tests  ${failures} failed | 240 passed (244)`)
  return lines.join('\n')
}

/** 一份 shell 构建失败日志：大量普通输出 + 4 行错误 + 退出码。 */
function shellFailureLog(): string {
  const lines = ['$ npm run build']
  for (let index = 0; index < 60; index += 1) lines.push(`[build] compiled module ${index}`)
  lines.push('src/a.ts(12,3): error TS2322: Type string is not assignable to number')
  lines.push('src/b.ts(4,9): error TS1005: ; expected')
  lines.push('npm ERR! code ELIFECYCLE')
  lines.push('npm ERR! errno 1')
  lines.push('[exit code: 1]')
  return lines.join('\n')
}

/** 一份 grep 输出：12 个文件 × 5 条命中。 */
function grepLog(): string {
  const lines: string[] = []
  for (let file = 0; file < 12; file += 1) {
    for (let hit = 0; hit < 5; hit += 1) {
      lines.push(`src/host/mod-${file}.ts:${hit + 1}: export function hit${hit}()`)
    }
  }
  return lines.join('\n')
}

/** 一份 glob 输出：200 条路径。 */
function globLog(): string {
  const lines: string[] = []
  for (let index = 0; index < 200; index += 1) lines.push(`src/host/deep/mod-${index}.ts`)
  return lines.join('\n')
}

/** 一份 JSON Lines 结果：100 行、3 个字段。 */
function jsonLinesLog(): string {
  const lines: string[] = []
  for (let index = 0; index < 100; index += 1) {
    lines.push(JSON.stringify({ id: index, status: index % 3 === 0 ? 'failed' : 'ok', ms: index * 3 }))
  }
  return lines.join('\n')
}

/** 一份 TSV 表格：表头 + 90 行。 */
function tsvLog(): string {
  const lines = ['path\tbytes\tlevel']
  for (let index = 0; index < 90; index += 1) lines.push(`src/host/file-${index}.ts\t${100 + index}\terror`)
  return lines.join('\n')
}

/** 一份无结构的大文本。 */
function unknownLog(): string {
  const lines: string[] = []
  for (let index = 0; index < 120; index += 1) {
    lines.push(`alpha beta gamma delta epsilon ${index} zeta eta theta iota kappa`)
  }
  return lines.join('\n')
}

/** 一份源码（没有 interface/type 声明，避免被契约判定先吃掉）。 */
function sourceLog(): string {
  const lines = ['import fs from node:fs']
  for (let index = 0; index < 60; index += 1) {
    lines.push(`const value${index} = readSomething(${index})`)
    lines.push(`  return value${index} + 1`)
  }
  lines.push('}')
  return lines.join('\n')
}

describe('projectToolResult 保持原样的判定', () => {
  it('小结果原样：不超过预算就不动', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = 'short result: everything fine'
    const result = await projectToolResult({ toolName: 'bash', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(content)
    expect(result.metrics.strategy).toBe('verbatim-small')
    expect(result.refId).toBeUndefined()
    expect(result.preview).toBeUndefined()
  })

  it('未知大文本原样，且不写入存储', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = unknownLog()
    const result = await projectToolResult({ toolName: 'mystery', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(content)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
    await expect(fs.readdir(path.join(store.rootDir(), 's'))).rejects.toThrow()
  })

  it('关键源码原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = sourceLog()
    const result = await projectToolResult({ toolName: 'mystery', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-source-code')
    expect(result.content).toBe(content)
  })

  it('读取类工具即使是结构化内容也原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = jsonLinesLog()
    const result = await projectToolResult({ toolName: 'read', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-source-code')
  })

  it('契约/类型定义原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = [
      'export interface ResultPageQuery {',
      '  sessionId: string',
      '  refId: string',
      '}',
      'export type ResultPageMode = "text" | "structured"',
      ...Array.from({ length: 80 }, (_, index) => `// filler line ${index} padding padding padding`),
    ].join('\n')
    const result = await projectToolResult({ toolName: 'grep', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-contract')
  })

  it('子代理报告原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = unknownLog()
    const result = await projectToolResult({
      toolName: 'subagent',
      sessionId: 's',
      content,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-subagent-report')
    expect(result.content).toBe(content)
  })

  it('非文本块逐字保留：混合块数组整体不动', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const imageBlock: ToolResultBlock = { type: 'image', mediaType: 'image/png', data: 'AAAA' }
    const blocks: ToolResultBlock[] = [{ type: 'text', text: failingTestLog() }, imageBlock]
    const result = await projectToolResult({ toolName: 'bash', sessionId: 's', content: blocks, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-non-text')
    expect(result.content).toBe(blocks)
    expect((result.content as readonly ToolResultBlock[])[1]).toBe(imageBlock)
    expect(result.metrics.inputChars).toBe(failingTestLog().length)
  })

  it('JSON 文档里的批量源码与错误字符串不会被误判为 shell 或 glob', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const source = Array.from({ length: 80 }, (_, index) => `const value${index} = "cannot find module ${index}"`).join('\n')
    const content = JSON.stringify({ providers: source, status: { stdout: 'error TS1005', exitCode: 1 } }, null, 2)
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
    expect(result.content).toBe(content)
    await expect(fs.readdir(path.join(store.rootDir(), 's'))).rejects.toThrow()
  })

  it('被宿主截断的 JSON 混合证据同样保持原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const source = Array.from({ length: 80 }, (_, index) => `const value${index} = "cannot find module ${index}"`).join('\n')
    const content = '{\n  "providers": ' + JSON.stringify(source) + ',\n  "status": { "exitCode": 1 }'
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
    expect(result.content).toBe(content)
  })

  it('源码中的 cannot/error 字符串不会被误判为 shell 日志', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = sourceLog() + '\nconst failure = "cannot find module"'
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-source-code')
    expect(result.content).toBe(content)
  })

  it('run_code 内调用 tools.read 打印的带行号（1: / 1\\t / 1|）源码切片与 git diff 补丁保持原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const numberedTsx = Array.from(
      { length: 80 },
      (_, idx) => `${idx + 1}: <p className="dsh-notice--error">{failure ?? "line-${idx}"}</p>`,
    ).join('\n')
    const res1 = await projectToolResult({ toolName: 'run_code', sessionId: 's', content: numberedTsx, budget: WARMUP, store })
    expect(res1.changed).toBe(false)
    expect(res1.metrics.strategy).toBe('verbatim-source-code')

    const pipeNumbered = Array.from(
      { length: 60 },
      (_, idx) => `${idx + 1}|   if (!ok) throw new Error("missing item ${idx}")`,
    ).join('\n')
    const res2 = await projectToolResult({ toolName: 'run_code', sessionId: 's', content: pipeNumbered, budget: WARMUP, store })
    expect(res2.changed).toBe(false)
    expect(res2.metrics.strategy).toBe('verbatim-source-code')

    const gitDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 30a03a1..87b0704 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,6 +10,20 @@ const COPY = {',
      ...Array.from({ length: 60 }, (_, idx) => `+  lastError${idx}: { zh: "错误 ${idx}", en: "Error ${idx}" },`),
    ].join('\n')
    const res3 = await projectToolResult({ toolName: 'run_code', sessionId: 's', content: gitDiff, budget: WARMUP, store })
    expect(res3.changed).toBe(false)
    expect(res3.metrics.strategy).toBe('verbatim-source-code')
  })

  it('没有存储就不投影：拿不到 ref 的预览等于丢原文', async () => {
    const content = failingTestLog()
    const result = await projectToolResult({ toolName: 'bash', sessionId: 's', content, budget: WARMUP })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('store-unavailable')
    expect(result.content).toBe(content)
  })
})

describe('projectToolResult 结构化投影', () => {
  it('测试失败集完整提取，preview 带 ref 且能读回全文', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = failingTestLog(4)
    const result = await projectToolResult({
      toolName: 'bash',
      sessionId: 'session-p',
      content,
      budget: TIGHT,
      store,
    })

    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    expect(result.refId).toMatch(/^ref:\/\/session-p\/[0-9a-f]{64}$/)
    const preview = result.preview!
    expect(preview).toContain(result.refId!)
    expect(preview).toContain('failures: 4 (complete set)')
    for (let index = 0; index < 4; index += 1) expect(preview).toContain(`test/broken-${index}.test.ts`)
    expect(preview).toContain('4 failed | 240 passed')

    // 度量自洽：输入 - 输出 = 省略。
    expect(result.metrics.inputChars).toBe(content.length)
    expect(result.metrics.outputChars).toBe(preview.length)
    expect(result.metrics.omittedChars).toBe(content.length - preview.length)

    const page = await store.page({ sessionId: 'session-p', refId: result.refId!, limit: 512, maxBytes: 65_536 })
    expect(page.complete).toBe(true)
    expect(page.content).toBe(content)
  })

  it('shell 失败：退出码与全部错误行都在预览里', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = shellFailureLog()
    const result = await projectToolResult({
      toolName: 'bash',
      sessionId: 's',
      content,
      budget: TIGHT,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    expect(result.preview).toContain('exit code: 1')
    expect(result.preview).toContain('errors: 4 (complete set)')
    expect(result.preview).toContain('error TS2322')
    expect(result.preview).toContain('error TS1005')
    expect(result.preview).toContain('ELIFECYCLE')
  })

  it('npm notice 文件清单不会把 stream-error.d.ts 误计为构建错误', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const lines = ['$ npm pack --dry-run']
    for (let index = 0; index < 60; index += 1) lines.push(`npm notice ${index + 1}kB lib/types/host/mod-${index}.d.ts`)
    lines.push('npm notice 5.2kB lib/types/host/common/stream-error.d.ts')
    lines.push('npm notice 917B lib/types/host/common/stream-error.d.ts.map')
    lines.push('[exit code: 0]')
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content: lines.join('\n'), budget: WARMUP, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    expect(result.preview).toContain('exit code: 0')
    expect(result.preview).toContain('errors: 0 (complete set)')
    expect(result.preview).not.toContain('errors: 2 (complete set)')
  })

  it('TypeScript 多行诊断块：保留紧随其后的缩进类型差异详情，且错误计数按诊断块而非缩进行数累加', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const lines = ['$ npm run typecheck']
    for (let index = 0; index < 60; index += 1) lines.push(`[tsc] checking module ${index}.ts`)
    lines.push('src/host/foo.ts(18,5): error TS2322: Type "{ a: string }" is not assignable to type "{ a: number }".')
    lines.push('  Types of property "a" are incompatible.')
    lines.push('    Type "string" is not assignable to type "number".')
    lines.push('[exit code: 2]')
    const content = lines.join('\n')
    const result = await projectToolResult({
      toolName: 'win_bash',
      sessionId: 's',
      content,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    expect(result.preview).toContain('exit code: 2')
    expect(result.preview).toContain('errors: 1 (complete set)')
    expect(result.preview).toContain('error TS2322')
    expect(result.preview).toContain('Types of property "a" are incompatible.')
    expect(result.preview).toContain('Type "string" is not assignable to type "number".')
  })

  it('PTC run_code JSON envelope：只替换白名单日志字段（stdout/stderr/output），保留其余轻量字段并能读回完整 JSON 原文', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const rawEnvelope = JSON.stringify({
      exitCode: 1,
      command: 'vitest run',
      stdout: failingTestLog(3),
    })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'session-env',
      content: rawEnvelope,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    const parsed = JSON.parse(result.preview!) as { exitCode: number; command: string; stdout: string }
    expect(parsed.exitCode).toBe(1)
    expect(parsed.command).toBe('vitest run')
    expect(parsed.stdout).toContain('failures: 3 (complete set)')
    expect(parsed.stdout).toContain(result.refId!)

    const page = await store.page({ sessionId: 'session-env', refId: result.refId!, limit: 512, maxBytes: 65_536 })
    expect(page.complete).toBe(true)
    expect(page.content).toBe(rawEnvelope)
  })

  it('含 ANSI 颜色码、Windows 路径反斜杠、双引号及双重 JSON 序列化的日志能被精确识别与预算装配', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const ansiLog = [
      '\x1b[32m RUN \x1b[0m v4.1.8 C:\\Users\\A\\repo',
      ...Array.from({ length: 50 }, (_, index) => `\x1b[32m ✓\x1b[0m test\\case-${index}.test.ts > "works" ${index}\r`),
      '\x1b[31m FAIL \x1b[0m test\\broken-quote.test.ts > "quoted \\"suite\\"" > case 1\r',
      ' Test Files  1 failed | 50 passed (51)',
      '      Tests  1 failed | 50 passed (51)',
    ].join('\n')

    // 场景 A：双重 JSON 序列化字符串 JSON.stringify(JSON.stringify({ stdout: ansiLog }))
    const doubleStringified = JSON.stringify(JSON.stringify({ exitCode: 1, stdout: ansiLog }))
    const resA = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'session-ansi',
      content: doubleStringified,
      budget: WARMUP,
      store,
    })
    expect(resA.changed).toBe(true)
    expect(resA.metrics.strategy).toBe('test-failure')
    expect(resA.preview!.length).toBeLessThanOrEqual(WARMUP.maxChars)
    const parsedA = JSON.parse(resA.preview!) as { exitCode: number; stdout: string }
    expect(parsedA.exitCode).toBe(1)
    expect(parsedA.stdout).toContain('failures: 1 (complete set)')
    expect(parsedA.stdout).toContain('test\\broken-quote.test.ts > "quoted \\"suite\\"" > case 1')
    // ANSI 控制字符已被清理，不会在 JSON 里变成 \u001b
    expect(resA.preview).not.toContain('\\u001b')

    // 场景 B：顶层直接是 JSON.stringify(ansiLog) 字符串
    const singleStringified = JSON.stringify(ansiLog)
    const resB = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'session-ansi',
      content: singleStringified,
      budget: WARMUP,
      store,
    })
    expect(resB.changed).toBe(true)
    expect(resB.metrics.strategy).toBe('test-failure')
    expect(resB.preview).toContain('failures: 1 (complete set)')
  })

  it('grep 结果按文件计数，总数与文件数都对得上', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = grepLog()
    const result = await projectToolResult({ toolName: 'grep', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('grep-results')
    expect(result.preview).toContain('matches: 60 across 12 files')
    expect(result.preview).toContain('src/host/mod-0.ts: 5')
  })

  it('glob 结果给出总数与扩展名分布', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = globLog()
    const result = await projectToolResult({ toolName: 'glob', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('glob-results')
    expect(result.preview).toContain('paths: 200')
    expect(result.preview).toContain('.ts: 200')
  })

  it('JSON Lines 投影成行数与字段', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = jsonLinesLog()
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('structured-rows')
    expect(result.preview).toContain('rows: 100')
    expect(result.preview).toContain('fields: id, status, ms')
  })

  it('TSV 表格同样被可靠识别', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = tsvLog()
    const result = await projectToolResult({ toolName: 'run_code', sessionId: 's', content, budget: WARMUP, store })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('structured-rows')
    expect(result.preview).toContain('rows: 90')
    expect(result.preview).toContain('path, bytes, level')
  })

  it('单个文本块数组只改正文，块的其他字段逐字保留', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const block: ToolResultBlock = { type: 'text', text: failingTestLog(), title: 'build log' }
    const result = await projectToolResult({ toolName: 'bash', sessionId: 's', content: [block], budget: TIGHT, store })
    expect(result.changed).toBe(true)
    const rebuilt = (result.content as readonly ToolResultBlock[])[0]!
    expect(rebuilt.type).toBe('text')
    expect(rebuilt.title).toBe('build log')
    expect(rebuilt.text).toBe(result.preview)
  })
})

describe('projectToolResult 预算与保守边界', () => {
  it('同一内容，预算决定是否投影：宽预算原样，紧预算才投影', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = failingTestLog()
    const wide = await projectToolResult({
      toolName: 'bash',
      sessionId: 's',
      content,
      budget: { maxChars: 4000, warmup: true, consecutiveHits: 0, hitRatio: 0 },
      store,
    })
    expect(wide.changed).toBe(false)
    expect(wide.metrics.strategy).toBe('verbatim-small')

    const tight = await projectToolResult({ toolName: 'bash', sessionId: 's', content, budget: TIGHT, store })
    expect(tight.changed).toBe(true)
    expect(tight.preview!.length).toBeLessThanOrEqual(TIGHT.maxChars)
  })

  it('完整失败集装不进预算时保持原样，不输出半截清单', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = failingTestLog(40)
    const result = await projectToolResult({
      toolName: 'bash',
      sessionId: 's',
      content,
      budget: STARVED,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-budget')
    expect(result.content).toBe(content)
  })

  it('失败结果不会被压成计数型摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = jsonLinesLog()
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 's',
      content,
      isError: true,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
  })

  it('不写任何日志（原文不进日志）', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      await projectToolResult({ toolName: 'bash', sessionId: 's', content: failingTestLog(), budget: TIGHT, store })
      await projectToolResult({ toolName: 'bash', sessionId: 's', content: unknownLog(), budget: TIGHT, store })
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('存储写入失败时降级为原样，不抛出', async () => {
    const failingStore = {
      put: async () => {
        throw new Error('disk full')
      },
      page: async () => {
        throw new Error('unused')
      },
      release: async () => false,
    }
    const content = failingTestLog()
    const result = await projectToolResult({
      toolName: 'bash',
      sessionId: 's',
      content,
      budget: TIGHT,
      store: failingStore,
    })
    expect(result.changed).toBe(false)
    expect(result.metrics.strategy).toBe('store-unavailable')
    expect(result.content).toBe(content)
  })

  it('不修改入参内容', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = failingTestLog()
    const original = content
    await projectToolResult({ toolName: 'bash', sessionId: 's', content, budget: TIGHT, store })
    expect(content).toBe(original)
  })
})

/** 一份 50KB 级的构建日志：足够触发 DSH 的输出上限，但行数仍少于分页上限。 */
function hugeBuildLog(): string {
  const lines: string[] = []
  for (let index = 0; index < 420; index += 1) {
    lines.push(`[build] compiling module ${index} of the very large package graph with many transitive dependencies and type declarations`)
    if (index === 4) lines.push(' FAIL  test/broken.test.ts > suite > case')
  }
  lines.push(' Test Files  1 failed | 420 passed (421)')
  lines.push('      Tests  1 failed | 420 passed (421)')
  return lines.join('\n')
}

/** DSH 的 spill 提示尾部。 */
function spillNotice(filePath: string, omitted: number): string {
  return `\n\n(Omitted ${omitted} bytes. Full formatted result stored at: ${filePath}. Use read with offset/limit, or grep this path to search within it.)`
}

/** 一份规范 grep 命中表。 */
function canonicalMatches(): Array<{ path: string; lineNumber: number; line: string }> {
  const matches: Array<{ path: string; lineNumber: number; line: string }> = []
  for (let file = 0; file < 12; file += 1) {
    for (let hit = 0; hit < 5; hit += 1) {
      matches.push({
        path: `src/host/mod-${file}.ts`,
        lineNumber: hit + 1,
        line: `export function hit${hit}() { return ${hit} }`,
      })
    }
  }
  return matches
}

describe('projectToolResult 的 JSON 信封扩展', () => {
  it('job_output 的 { text, job } 信封：只替换 text，job 元数据原样保留', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({
      text: failingTestLog(3),
      job: { id: 'job-1', kind: 'final-output', status: 'completed' },
    })
    const result = await projectToolResult({
      toolName: 'job_output',
      sessionId: 'job-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    const parsed = JSON.parse(result.preview!) as { text: string; job: Record<string, unknown> }
    expect(parsed.job).toEqual({ id: 'job-1', kind: 'final-output', status: 'completed' })
    expect(parsed.text).toContain('failures: 3 (complete set)')
    expect(parsed.text).toContain(result.refId!)
  })

  it('1 层嵌套的日志信封（{ testOutput: { text, job } }）：内层 text 被替换，外层与内层元数据都保留', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({
      testOutput: {
        text: failingTestLog(2),
        job: { id: 'job-2', status: 'completed' },
      },
      kind: 'run',
    })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'nested-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    const parsed = JSON.parse(result.preview!) as {
      kind: string
      testOutput: { text: string; job: Record<string, unknown> }
    }
    expect(parsed.kind).toBe('run')
    expect(parsed.testOutput.job).toEqual({ id: 'job-2', status: 'completed' })
    expect(parsed.testOutput.text).toContain('failures: 2 (complete set)')
    expect(parsed.testOutput.text).toContain(result.refId!)
  })

  it('PTC 的 grep 信封（{ matches: [...] }）投影成 grep-results，并按行分页存回原文', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({ matches: canonicalMatches() })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'grep-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('grep-results')
    const parsed = JSON.parse(result.preview!) as { matches: string }
    expect(parsed.matches).toContain('matches: 60 across 12 files')
    expect(parsed.matches).toContain('src/host/mod-0.ts: 5')
    // 存回去的是缩进 JSON：每行一个字段，store.page 翻页干净。
    const page = await store.page({ sessionId: 'grep-1', refId: result.refId!, limit: 512, maxBytes: 65_536 })
    expect(page.complete).toBe(true)
    expect(page.content).toContain('"lineNumber": 1')
    expect(page.content).toContain('"path": "src/host/mod-0.ts"')
  })

  it('PTC 的 grep 信封 1 层嵌套（{ batch: { matches } }）同样被投影', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({ batch: { matches: canonicalMatches() }, note: 'grep done' })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'grep-2',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('grep-results')
    const parsed = JSON.parse(result.preview!) as { batch: { matches: string }; note: string }
    expect(parsed.note).toBe('grep done')
    expect(parsed.batch.matches).toContain('matches: 60 across 12 files')
  })

  it('PTC 的 glob 信封（{ root, paths }）投影成 glob-results', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const paths = Array.from({ length: 200 }, (_, index) => `src/host/deep/mod-${index}.ts`)
    const raw = JSON.stringify({ root: 'src/host', paths })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'glob-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('glob-results')
    const parsed = JSON.parse(result.preview!) as { root: string; paths: string }
    expect(parsed.root).toBe('src/host')
    expect(parsed.paths).toContain('paths: 200')
    expect(parsed.paths).toContain('.ts: 200')
  })
})

describe('projectToolResult 的 spill 恢复', () => {
  it('DSH 的 spill 提示：读回临时文件全文，按全文投影，并把全文入库', async () => {
    const spillPath = path.join(await makeRoot(), 'da010ab69f2b-run_code.txt')
    const full = hugeBuildLog()
    await fs.writeFile(spillPath, full, 'utf8')
    const visible = full.slice(0, 2000)
    const content = visible + spillNotice(spillPath, full.length - visible.length)

    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'spill-1',
      content,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    // 度量按全文算：省略的是没进预览的那部分**全文**。
    expect(result.metrics.inputChars).toBe(full.length)
    // 入库的是全文，翻页能读回未被截断的输出。
    const page = await store.page({ sessionId: 'spill-1', refId: result.refId!, limit: 512, maxBytes: 65_536 })
    expect(page.complete).toBe(true)
    expect(page.content).toBe(full)
  })

  it('spill 读回的多读 JSON 信封：即使全文不足 20_000 字符也投影成 file-outline', async () => {
    // 「超长**或**被 spill 截断」里的第二种情形：全文不到 20_000 字符，
    // 但它是被截断过的，模型看不到后半段，所以值得换成摘要。
    const spillPath = path.join(await makeRoot(), 'multi-read-run_code.txt')
    const lines = Array.from(
      { length: 120 },
      (_, index) => ({ number: index + 1, text: `const value${index} = readSomething(${index})` }),
    )
    const full = JSON.stringify({
      first: { path: 'src/a.ts', offset: 1, lines },
      second: { path: 'src/b.ts', offset: 1, lines: lines.slice(0, 60) },
    })
    expect(full.length).toBeLessThan(20_000)
    await fs.writeFile(spillPath, full, 'utf8')
    const visible = full.slice(0, 400)
    const content = visible + spillNotice(spillPath, full.length - visible.length)

    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'spill-3',
      content,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('reads: 2 (complete set)')
    expect(result.preview).toContain('first: src/a.ts lines 1-120 (120)')
    // 入库的是读回来的**完整** JSON，不是被截断的那一段。
    // 复合信封按设计存缩进 JSON（每行一个字段，翻页干净），所以翻页读完再按语义比较。
    const collected = await readAllPages(store, 'spill-3', result.refId!)
    expect(JSON.parse(collected)).toEqual(JSON.parse(full))
  })

  it('spill 文件读不到时：剥掉提示尾部，按可得的正文投影并入库', async () => {
    const missing = path.join(await makeRoot(), 'does-not-exist.txt')
    const body = hugeBuildLog()
    const visible = body.slice(0, 2000)
    const content = visible + spillNotice(missing, body.length - visible.length)

    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'spill-2',
      content,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('test-failure')
    expect(result.metrics.inputChars).toBe(visible.length)
    const page = await store.page({ sessionId: 'spill-2', refId: result.refId!, limit: 512, maxBytes: 65_536 })
    expect(page.content).toBe(visible)
    expect(page.content).not.toContain('Omitted')
  })

  it('识别带图片省略段和未知字节数的真实 DSH spill 提示', async () => {
    const full = hugeBuildLog()
    const visible = full.slice(0, 2000)
    for (const [sessionId, notice] of [
      ['spill-images', (filePath: string) => `\n\n(Omitted ${full.length - visible.length} bytes. Omitted 2 images. Full formatted result stored at: ${filePath}. Use read with offset/limit, or grep this path to search within it.)`],
      ['spill-unknown', (filePath: string) => `\n\n(More bytes were omitted. Full formatted result stored at: ${filePath}. Use read with offset/limit, or grep this path to search within it.)`],
    ] as const) {
      const spillPath = path.join(await makeRoot(), `${sessionId}.txt`)
      await fs.writeFile(spillPath, full, 'utf8')
      const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
      const result = await projectToolResult({
        toolName: 'run_code',
        sessionId,
        content: visible + notice(spillPath),
        budget: WARMUP,
        store,
      })
      expect(result.changed).toBe(true)
      expect(result.metrics.inputChars).toBe(full.length)
      const collected = await readAllPages(store, sessionId, result.refId!)
      expect(collected).toBe(full)
    }
  })
})

describe('projectToolResult 的复合 JSON 信封', () => {
  it('grep 与 read 混在一份信封里：逐个成员摘要，不再退回 verbatim-budget', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const lines = Array.from(
      { length: 400 },
      (_, index) => ({ number: index + 1, text: `const value${index} = readSomething(${index})` }),
    )
    const raw = JSON.stringify({
      batch: { matches: canonicalMatches() },
      note: { path: 'src/a.ts', offset: 1, lines },
    })
    expect(raw.length).toBeGreaterThanOrEqual(20_000)
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'composite-1',
      content: raw,
      budget: STEADY,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('results: 2 (complete set)')
    expect(result.preview).toContain('batch: grep matches=60 across 12 files')
    expect(result.preview).toContain('note: src/a.ts lines 1-400 (400)')
    expect(result.preview).toContain('const value0 = readSomething(0)')
    expect(result.preview!.length).toBeLessThanOrEqual(STEADY.maxChars)
  })

  it('单键 grep 信封旁边压着一个超重字段：外壳闸门挡住单键路，改走复合摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({ matches: canonicalMatches(), payload: 'x'.repeat(25_000) })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'composite-2',
      content: raw,
      budget: STEADY,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('results: 1 (complete set)')
    expect(result.preview).toContain('grep matches=60 across 12 files')
    expect(result.preview!.length).toBeLessThanOrEqual(STEADY.maxChars)
  })

  it('复合信封中的源码仍逐字保留，不退化为日志摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({ stdout: sourceLog() })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'composite-source',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(raw)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
  })

  it('复合信封中的契约仍逐字保留，不退化为日志摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const contract = [
      'export interface First { id: string }',
      'export type Second = First',
      ...Array.from({ length: 100 }, (_, index) => `// filler line ${index} padding padding padding`),
    ].join('\n')
    const raw = JSON.stringify({ stdout: contract })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'composite-contract',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(raw)
    expect(result.metrics.strategy).toBe('verbatim-unparsed')
  })
})

describe('projectToolResult 的多节输出不再被契约判定挡住', () => {
  /** 一份超长的多节输出：分节头 + 大量正文 + 两行 interface 声明。 */
  function oversizedSectionsWithContract(): string {
    const rules = Array.from(
      { length: 600 },
      (_, index) => `${index + 1}: rule ${index} about how the package must be laid out`,
    )
    const extension = Array.from(
      { length: 600 },
      (_, index) => `${index + 1}: extension detail line ${index} with quite a lot of text to make it long`,
    )
    return [
      'PACKAGE RULES',
      ...rules,
      '',
      'EXTENSION REST',
      '300: export interface First { id: string }',
      '301: export interface Second { name: string }',
      ...extension,
    ].join('\n')
  }

  it('超长的多节输出先于契约判定：分节摘要生效，不再是 verbatim-contract', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = oversizedSectionsWithContract()
    expect(raw.length).toBeGreaterThanOrEqual(20_000)
    // 两行 interface 声明足以触发契约判定：契约必须让位给多节摘要。
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'sections-1',
      content: raw,
      budget: STEADY,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('structured-rows')
    expect(result.metrics.strategy).not.toBe('verbatim-contract')
    expect(result.preview).toContain('sections: 2 (complete set)')
    expect(result.preview).toContain('PACKAGE RULES: 600 lines')
    expect(result.preview).toContain('EXTENSION REST:')
  })
})

describe('projectToolResult 的 job_output 退出码在元数据里', () => {
  /** 一份中文构建日志：正文里没有任何英文错误词，也不会被当成 shell 输出。 */
  function chineseBuildLog(): string {
    const lines: string[] = []
    for (let index = 0; index < 60; index += 1) {
      lines.push(`  Shared -> C:/repo/build/out${index}.dll`)
      lines.push('  72 个警告')
      lines.push('  0 个错误')
      lines.push('  已用时间 12 秒')
    }
    return lines.join('\n')
  }

  it('退出码在 job.detail 里：按 shell 输出投影，并把退出码补进预览', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({
      text: chineseBuildLog(),
      job: { id: 'win-bash-1', status: 'completed', detail: 'exit code: 1' },
    })
    const result = await projectToolResult({
      toolName: 'job_output',
      sessionId: 'job-shell-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    const parsed = JSON.parse(result.preview!) as { text: string; job: Record<string, unknown> }
    expect(parsed.text).toContain('exit code: 1')
    expect(parsed.text).toContain('status: completed')
    expect(parsed.job).toEqual({ id: 'win-bash-1', status: 'completed', detail: 'exit code: 1' })
  })

  it('1 层嵌套的 job_output 信封同样按 shell 输出投影', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = JSON.stringify({
      testOutput: {
        text: chineseBuildLog(),
        job: { id: 'win-bash-2', status: 'completed', detail: 'exit code: 1' },
      },
    })
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'job-shell-2',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    const parsed = JSON.parse(result.preview!) as { testOutput: { text: string; job: Record<string, unknown> } }
    expect(parsed.testOutput.text).toContain('exit code: 1')
    expect(parsed.testOutput.job).toEqual({ id: 'win-bash-2', status: 'completed', detail: 'exit code: 1' })
  })
})

describe('projectToolResult 的错误集不再撑爆预算', () => {
  /** 一份有 50 条错误行的构建日志：错误集本身就装不进稳态预算。 */
  function manyErrorBuildLog(): string {
    const lines = ['$ npm run build']
    for (let index = 0; index < 50; index += 1) {
      lines.push(
        `src/host/mod-${index}.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number' in property field${index} of the very long descriptive type name used in this particular declaration`,
      )
    }
    lines.push('[exit code: 2]')
    return lines.join('\n')
  }

  it('50 条错误行：错误集被截断并写明余量，预览不再退回 verbatim-budget', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const content = manyErrorBuildLog()
    const result = await projectToolResult({
      toolName: 'win_bash',
      sessionId: 'shell-1',
      content,
      budget: STEADY,
      store,
    })
    expect(result.changed, JSON.stringify(result.metrics)).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    expect(result.metrics.strategy).not.toBe('verbatim-budget')
    expect(result.preview).toContain('exit code: 2')
    expect(result.preview).toContain('errors: 50 (first 25 shown; full set via ref)')
    expect(result.preview).toContain('more error lines (full list via ref)')
    expect(result.preview!.length).toBeLessThanOrEqual(STEADY.maxChars)
  })

  it('错误行不多时仍然是完整错误集', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const lines = ['$ npm run build']
    // 大量普通输出把日志顶过稳态预算，错误行仍然只有 4 条。
    for (let index = 0; index < 150; index += 1) {
      lines.push(`[build] compiled module ${index} of the package graph with many transitive dependencies`)
    }
    for (let index = 0; index < 4; index += 1) {
      lines.push(`src/host/mod-${index}.ts(12,3): error TS2322: Type A is not assignable to type B`)
    }
    lines.push('[exit code: 2]')
    const result = await projectToolResult({
      toolName: 'win_bash',
      sessionId: 'shell-2',
      content: lines.join('\n'),
      budget: STEADY,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('shell-output')
    expect(result.preview).toContain('errors: 4 (complete set)')
    for (let index = 0; index < 4; index += 1) {
      expect(result.preview).toContain(`src/host/mod-${index}.ts(12,3): error TS2322`)
    }
    expect(result.preview).not.toContain('more error lines')
  })
})

describe('projectToolResult 的超长多读/多节输出', () => {
  /** 一份多读 JSON 信封：顶层两个键，各是一份 { path, offset, lines }。 */
  function multiReadEnvelope(): string {
    const lines = Array.from(
      { length: 400 },
      (_, index) => ({ number: index + 1, text: `const value${index} = readSomething(${index})` }),
    )
    return JSON.stringify({
      first: { path: 'src/a.ts', offset: 1, lines },
      second: { path: 'src/b.ts', offset: 1, lines: lines.slice(0, 200) },
    })
  }

  it('超过 20_000 字符的多读 JSON 信封投影成 file-outline 摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const raw = multiReadEnvelope()
    expect(raw.length).toBeGreaterThanOrEqual(20_000)
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'multi-1',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('file-outline')
    expect(result.preview).toContain('reads: 2 (complete set)')
    expect(result.preview).toContain('first: src/a.ts lines 1-400 (400)')
    expect(result.preview).toContain('second: src/b.ts lines 1-200 (200)')
    expect(result.preview).toContain('const value0 = readSomething(0)')
  })

  it('不到 20_000 字符的读取结果逐字保留：源码原样、契约原样', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const source = Array.from({ length: 80 }, (_, index) => `${index + 1}: const value${index} = readSomething(${index})`).join('\n')
    expect(source.length).toBeLessThan(20_000)
    const readResult = await projectToolResult({
      toolName: 'read',
      sessionId: 'small-1',
      content: source,
      budget: WARMUP,
      store,
    })
    expect(readResult.changed).toBe(false)
    expect(readResult.metrics.strategy).toBe('verbatim-source-code')
    expect(readResult.content).toBe(source)

    const contract = [
      'export interface First { id: string }',
      'export type Second = First',
      ...Array.from({ length: 80 }, (_, index) => `// filler line ${index} padding padding padding`),
    ].join('\n')
    expect(contract.length).toBeLessThan(20_000)
    const contractResult = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'small-2',
      content: contract,
      budget: WARMUP,
      store,
    })
    expect(contractResult.changed).toBe(false)
    expect(contractResult.metrics.strategy).toBe('verbatim-contract')
    expect(contractResult.content).toBe(contract)
  })

  it('不到 20_000 字符的读取 JSON 信封也逐字保留', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const lines = Array.from(
      { length: 20 },
      (_, index) => ({ number: index + 1, text: `const value${index} = readSomething(${index})` }),
    )
    const raw = JSON.stringify({ path: 'src/a.ts', offset: 1, lines })
    expect(raw.length).toBeLessThan(20_000)
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'small-3',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(false)
    expect(result.content).toBe(raw)
  })

  it('超长的多节输出（PACKAGE FILES / PACKAGE RULES）投影成分节摘要', async () => {
    const store = new FileResultReferenceStore({ rootDir: await makeRoot() })
    const files = Array.from({ length: 500 }, (_, index) => `src/host/deep/module-${index}.ts`)
    const rules = Array.from(
      { length: 500 },
      (_, index) => `${index + 1}: rule ${index} about how the package must be laid out`,
    )
    const raw = ['PACKAGE FILES', ...files, '', 'PACKAGE RULES', ...rules].join('\n')
    expect(raw.length).toBeGreaterThanOrEqual(20_000)
    const result = await projectToolResult({
      toolName: 'run_code',
      sessionId: 'multi-2',
      content: raw,
      budget: WARMUP,
      store,
    })
    expect(result.changed).toBe(true)
    expect(result.metrics.strategy).toBe('structured-rows')
    expect(result.preview).toContain('sections: 2 (complete set)')
    expect(result.preview).toContain('PACKAGE FILES: 500 lines')
    expect(result.preview).toContain('PACKAGE RULES: 500 lines (1-500)')
  })
})
