/**
 * 进展正文的轻量 Markdown 渲染。
 *
 * ## 为什么不复用平台的 MarkdownText
 *
 * 平台的渲染器在 `@deepseek-ai/dsh-client-ui-primitives` 里，那个包的 `lib` 是
 * **浏览器构建产物**：顶层静态 `import css from './StateDot.module.css'`。Node 的 ESM
 * 加载器先于任何 vite 插件与 alias 生效，所以只要本包在测试里 import 它，整个测试
 * 文件就 `Unknown file extension ".css"`。那是「只被 shell 加载」的包，不该被别的包
 * 在 Node 里 require。
 *
 * ## 这个渲染器覆盖什么
 *
 * 这里做的是模型汇报时**实际会写**的那一小撮：
 *
 * - 段落（空行分隔，段内换行保留）
 * - `-` / `*` / `•` 开头的无序列表，以及 `1.` 开头的有序列表
 * - GFM 表格（表头行 + 分隔行 + 数据行，支持 `:---` / `:---:` / `---:` 对齐）
 * - 行内 `code`
 * - `**粗体**`
 * - `###` 标题（最多三级）
 *
 * 表格是**后补**的：早先版本把它当「超出契约」排除了，结果模型写出来的管道符表格
 * 整块落进段落分支、原样上屏（用户直接看到一堆竖线）。渲染一个表格的代价只是
 * 一次前瞻扫描，远小于它被读错造成的损失。
 *
 * 仍然刻意**不做**图片、链接、原始 HTML、脚注与围栏代码块：这些要么需要安全过滤，
 * 要么属于「进展汇报」这个场景不需要的重型排版。渲染结果全是 React 元素，不经过
 * `dangerouslySetInnerHTML`，因此没有注入面。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/markdown-lite
 */

import type { ReactNode } from 'react'

/** 行内标记：反引号代码与双星号粗体。两者可混排。 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)/g

/**
 * 渲染一段行内文本。
 * @param text - 原始行内文本。
 * @param keyPrefix - 生成 React key 的前缀。
 * @returns 由文本、code、strong 组成的节点数组。
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let index = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) nodes.push(text.slice(last, at))
    const whole = match[0]
    const key = keyPrefix + '-' + String(index)
    if (whole.startsWith('`')) {
      nodes.push(<code key={key} data-dsh-part="md-code">{whole.slice(1, -1)}</code>)
    } else {
      nodes.push(<strong key={key} data-dsh-part="md-strong">{whole.slice(2, -2)}</strong>)
    }
    last = at + whole.length
    index += 1
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 表格里一列的对齐方式；GFM 分隔行的 `:---` / `:---:` / `---:` 决定。 */
export type ColumnAlign = 'left' | 'center' | 'right'

/** 块级解析的一个中间行类型。 */
type Block =
  | { kind: 'p', lines: string[] }
  | { kind: 'ul', items: string[] }
  | { kind: 'ol', items: string[] }
  | { kind: 'h', level: number, text: string }
  | { kind: 'table', header: string[], aligns: ColumnAlign[], rows: string[][] }

/** GFM 分隔行：至少一个 `-` 的单元格，形如 `| --- | :--: | ---: |`。 */
const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

/**
 * 一行表格 → 单元格数组。
 *
 * 先按未转义的 `|` 切，再剥掉首尾因为 `| a | b |` 这种写法留下的空单元；
 * `\|` 是单元格里的字面量竖线，切之前先换成占位符，切完再换回来。
 * @param line - 表格的一行原文。
 * @returns 去掉两侧空白的单元格。
 */
export function splitRow(line: string): string[] {
  const PH = '\u0000'
  const cells = line.replaceAll('\\|', PH).split('|').map((cell) => cell.replaceAll(PH, '|').trim())
  if (cells.length > 0 && cells[0] === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  return cells
}

/**
 * 分隔行的每个单元格 → 对齐方式。
 * @param line - 分隔行原文。
 * @returns 与列一一对应的对齐方式；缺省 left。
 */
export function alignmentsOf(line: string): ColumnAlign[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * 判断某一行是不是表格的分隔行（表格识别的前瞻条件之一）。
 * @param line - 待判定的行（已 trim）。
 * @returns 是分隔行则为 true。
 */
function isSeparator(line: string): boolean {
  return line.includes('-') && TABLE_SEPARATOR.test(line)
}

/**
 * 把正文切成块。
 * @param source - Markdown 原文。
 * @returns 按出现顺序排列的块。
 */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'p', lines: paragraph })
      paragraph = []
    }
  }
  const lastBlock = (): Block | undefined => blocks[blocks.length - 1]
  const rows = source.replaceAll('\r\n', '\n').split('\n')

  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index].trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
    }

    /**
     * 表格必须**在当前行前瞻两行**才认：本行是表头、下一行是分隔行、两侧管道符
     * 数目对得上。只凭「这行有 |」不行——普通正文里一个竖线不该把后文变成表格。
     */
    const next = index + 1 < rows.length ? rows[index + 1].trim() : ''
    if (trimmed.includes('|') && isSeparator(next)) {
      const header = splitRow(trimmed)
      const aligns = alignmentsOf(next)
      if (header.length > 0) {
        flushParagraph()
        const body: string[][] = []
        index += 2
        while (index < rows.length) {
          const rowLine = rows[index].trim()
          if (rowLine === '' || !rowLine.includes('|')) break
          body.push(splitRow(rowLine))
          index += 1
        }
        // 上面的 while 退出时 index 停在首条非表格行上，外层 for 的 index += 1 会跳过它
        index -= 1
        blocks.push({ kind: 'table', header, aligns, rows: body })
        continue
      }
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] })
      continue
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (ordered !== null) {
      flushParagraph()
      const previous = lastBlock()
      if (previous?.kind === 'ol') previous.items.push(ordered[1])
      else blocks.push({ kind: 'ol', items: [ordered[1]] })
      continue
    }

    const unordered = /^[-*\u2022]\s+(.*)$/.exec(trimmed)
    if (unordered !== null) {
      flushParagraph()
      const previous = lastBlock()
      if (previous?.kind === 'ul') previous.items.push(unordered[1])
      else blocks.push({ kind: 'ul', items: [unordered[1]] })
      continue
    }

    paragraph.push(line)
  }
  flushParagraph()
  return blocks
}

/**
 * 把一条进展的正文渲染成 React 元素。
 * @param props - 正文原文。
 * @returns 块级元素；空正文渲染空片段。
 */
export function MarkdownLite({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((block, blockIndex) => {
        const key = 'b' + String(blockIndex)
        if (block.kind === 'h') {
          const size = block.level === 1 ? '15px' : block.level === 2 ? '14px' : '13px'
          return <p key={key} data-dsh-part="md-h" style={{ margin: '8px 0 3px', fontSize: size, fontWeight: 600 }}>{renderInline(block.text, key)}</p>
        }
        if (block.kind === 'table') {
          /** 单元格：行内标记照常解析，对齐落到 style 上（表格里没有 class 可挂）。 */
          const cellStyle = (column: number): { textAlign: ColumnAlign, padding: string, verticalAlign: 'top' } => ({
            textAlign: block.aligns[column] ?? 'left',
            padding: '3px 8px',
            verticalAlign: 'top',
          })
          return (
            <div key={key} data-dsh-part="md-table-wrap" style={{ overflowX: 'auto', margin: '6px 0' }}>
              <table data-dsh-part="md-table" style={{ borderCollapse: 'collapse', fontSize: '12px', lineHeight: '1.5' }}>
                <thead>
                  <tr>
                    {block.header.map((cell, column) => (
                      <th
                        key={key + '-h' + String(column)}
                        data-dsh-part="md-th"
                        style={{ ...cellStyle(column), borderBottom: '1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 15%))', fontWeight: 600 }}
                      >
                        {renderInline(cell, key + '-h' + String(column))}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={key + '-r' + String(rowIndex)}>
                      {/* 数据行可能比表头短（Markdown 允许），缺的格子用空单元补齐，列数才对齐 */}
                      {block.header.map((_, column) => (
                        <td
                          key={key + '-r' + String(rowIndex) + '-' + String(column)}
                          data-dsh-part="md-td"
                          style={{ ...cellStyle(column), borderBottom: '1px solid var(--dsw-alias-border-l3, rgb(0 0 0 / 7%))' }}
                        >
                          {renderInline(row[column] ?? '', key + '-r' + String(rowIndex) + '-' + String(column))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        if (block.kind === 'ul' || block.kind === 'ol') {
          const items = block.items.map((item, itemIndex) => {
            const itemKey = key + '-' + String(itemIndex)
            return <li key={itemKey} style={{ margin: '2px 0' }}>{renderInline(item, itemKey)}</li>
          })
          return block.kind === 'ul'
            ? <ul key={key} data-dsh-part="md-ul" style={{ margin: '5px 0', paddingLeft: '18px' }}>{items}</ul>
            : <ol key={key} data-dsh-part="md-ol" style={{ margin: '5px 0', paddingLeft: '18px' }}>{items}</ol>
        }
        return (
          <p key={key} data-dsh-part="md-p" style={{ margin: '0 0 7px', whiteSpace: 'pre-wrap' }}>
            {renderInline(block.lines.join('\n'), key)}
          </p>
        )
      })}
    </>
  )
}
