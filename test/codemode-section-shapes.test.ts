// @vitest-environment node
/**
 * 说明段的「结果形状索引」：只从静态表来，不读活 catalog。
 *
 * 审计（`docs/codemode-code-run-error-audit.md`）里 11 条 `TypeError: X.map is not a function`
 * 全部是「把信封当裸值」。修法不是给信封挂假数组，而是让索引覆盖到实际会被误用的工具——
 * 同时**必须保持逐字节恒定**：按 catalog 生成会让挂一个 MCP 服务端就改写系统提示词首段，
 * 把一个部署的前缀缓存整段作废。
 *
 * @module test/codemode-section-shapes
 */

import { describe, expect, it } from 'vitest'

import { buildCodemodeSectionText, createRules } from '../src/host/codemode/rules.ts'

const rules = createRules({})
const base = { runToolName: rules.options.runToolName, metaTools: rules.options.metaTools } as const

/** 生成一段说明（默认函数体、TypeScript）。 */
function section(language?: string): string {
  return buildCodemodeSectionText({ ...base, language, programFormat: 'function-body' })
}

describe('结果形状索引', () => {
  it('覆盖到真实会被误用的信封：glob / grep / read / edit / write / win_bash', () => {
    const text = section()
    expect(text).toContain('named-field objects, never bare strings')
    expect(text).toContain('`glob` → `{ root, paths }`')
    expect(text).toContain('`grep` → `{ matches: [{ path, lineNumber, line }] }`')
    expect(text).toContain('`read` → `{ path, offset, lines: [{ number, text }], totalLines }`')
    expect(text).toContain('`edit` → `{ path, before, after }`')
    expect(text).toContain('`write` → `{ path, operation, before, after }`')
    expect(text).toContain('`win_bash` → `{ stdout, stderr, exitCode }`')
    // 两个「顶层就是数组」的工具必须点名，否则模型会照旧 `list.map(...)`。
    expect(text).toContain('`job_list` and `list_agents` are the only bare arrays')
  })

  it('清单外的一律指向 describe，而不是让模型猜', () => {
    const text = section()
    expect(text).toContain('Anything not listed above (MCP tools, hidden plugin tools)')
    expect(text).toContain('`code_tools_describe({ name })`')
  })

  it('逐字节恒定，且不含遮蔽计数', () => {
    const first = section()
    const second = section()
    expect(second).toBe(first)
    expect(first).not.toMatch(/\d+ tool/)
    expect(first).not.toContain('mcp__')
  })
})

describe('程序文本陷阱（仅 TypeScript 形态）', () => {
  it('Windows 路径与正则反斜杠有专门一行', () => {
    const text = section()
    expect(text).toContain('Paths and regexes')
    expect(text).toContain('String.raw')
    expect(text).toContain('Expected unicode escape')
  })

  it('程序不是模块：点名 import .ts 与 import vscode', () => {
    const text = section()
    expect(text).toContain("import('./src/x.ts')")
    expect(text).toContain("import('vscode')")
  })

  it('Python 形态换成自己的读法，且不出现 TS 专属条目', () => {
    const py = section('python')
    expect(py).toContain('page["lines"]')
    expect(py).not.toContain('r.lines.map')
    expect(py).not.toContain('String.raw')
    expect(py).not.toContain("import('./src/x.ts')")
    // 形状表本身与语言无关，Python 也该看到。
    expect(py).toContain('`glob` → `{ root, paths }`')
  })
})
