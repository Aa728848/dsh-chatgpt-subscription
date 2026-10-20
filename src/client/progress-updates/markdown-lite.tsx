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
 * - 围栏代码块（三连及以上的反引号或波浪号：**不做语法高亮**，语言标签只当标题）
 * - 数学公式：行内 `$…$` / `\(…\)`，块级 `$$…$$` / `\[…\]`，交给 KaTeX
 *
 * 表格与围栏代码块都是**后补**的：早先版本把它们当「超出契约」排除了，结果模型写出来的
 * 管道符表格整块落进段落分支、原样上屏（用户直接看到一堆竖线），围栏代码块同样把三反
 * 引号露在正文里。渲染它们的代价只是一次前瞻扫描，远小于它被读错造成的损失。
 *
 * 数学走 KaTeX 而不是自己画：公式排版（分式、上下标、矩阵）不是几十行手写能覆盖的面。
 * KaTeX 只输出 HTML 串（`.katex` 那棵 span/MathML 树），本文件把它经 `DOMParser` 转成
 * React 元素，**不经过 `dangerouslySetInnerHTML`** —— 整份渲染结果因此仍然是「全是
 * React 元素」，没有注入面。KaTeX 的 CSS 与字体由平台 `ui-primitives` 随页面引入
 * （`katex.min.css`），本插件不打包样式，只负责出结构。
 *
 * 仍然刻意**不做**图片、链接、原始 HTML、脚注与语法高亮。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/markdown-lite
 */

import { createElement } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import katex from 'katex'

/**
 * 行内标记：反引号代码、`$…$`、`\(…\)`、双星号粗体。四者可混排。
 *
 * `$` 的两个环视是刻意的反误伤：开 `$` 后面不能紧跟空白（否则「价格 $ 5」被吞），
 * 闭 `$` 前面不能是空白、后面不能紧跟数字——「价格 $5 到 $10」里第一个 `$` 找不到
 * 合格闭合、第二个 `$` 后面紧跟数字，于是整串保持纯文本。体积内也排除 `$`，
 * 于是「第一个 `$` 配不上就去找更远那个」这种跨段吞并不会发生。
 *
 * 反引号与 `$` 同处一条交替式：谁先命中谁先消费，因此写在行内代码里的 `$x$` 仍旧
 * 留作代码，不会被拆成公式。
 */
const INLINE = /(`[^`]+`)|(\$(?![\s$])[^$\n]*[^\s$\n]\$(?![\d$]))|(\\\([^\n]+?\\\))|(\*\*[^*]+\*\*)/g

/** 围栏代码块与语言标签共用的等宽字体栈：只用系统自带字体，不引外部字体。 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/**
 * 一条 `style` 属性串 → React 的 style 对象。
 *
 * KaTeX 只会写出「连字符命名 + 普通声明」的样式，不会出现自定义属性或无名声明，
 * 因此把连字符转驼峰就是全部映射。
 * @param css - `style` 属性的原文。
 * @returns 可直接挂到元素上的样式对象。
 */
function styleObject(css: string): CSSProperties {
  const style: Record<string, string> = {}
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const name = declaration.slice(0, colon).trim()
    const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    style[key] = declaration.slice(colon + 1).trim()
  }
  return style
}

/**
 * 一个 DOM 节点 → React 节点（文本节点原样透传）。
 *
 * 节点种类用数字常量而不是 `Node.TEXT_NODE` 这类全局：本模块在只实现了部分 DOM 的
 * 环境里也要能加载，少依赖一个全局少一处惊吓。
 * @param node - KaTeX 输出解析出来的节点。
 * @param key - 同级节点的序号，作为 React key。
 * @returns 对应的 React 节点。
 */
function domToReact(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === 3) return node.textContent
  if (node.nodeType !== 1) return null
  const element = node as Element
  const props: Record<string, unknown> = { key }
  for (const attribute of element.attributes) {
    if (attribute.name === 'class') props['className'] = attribute.value
    else if (attribute.name === 'style') props['style'] = styleObject(attribute.value)
    else props[attribute.name] = attribute.value
  }
  const children = [...element.childNodes].map(domToReact)
  return children.length === 0
    ? createElement(element.localName, props)
    : createElement(element.localName, props, ...children)
}

/**
 * TeX 源码 → React 元素（KaTeX 渲染）。
 *
 * 三段式降级与平台 `ui-primitives` 的 `renderTexToReact` 一致：先严格渲染（语法错就抛），
 * 抛了再以 `strict:'ignore'` 渲染一次（这一趟 KaTeX 自己把错误画成红字），两趟都没成
 * （只有 KaTeX 内部错误能走到这里）才由本函数给一个 `katex-error` 的 span 兜底——**永远不把
 * 异常抛给调用方**：流式输出里一条还没闭合的公式不该炸掉整条进展。
 *
 * @param tex - TeX 源码。
 * @param displayMode - 块级（独占一行居中）还是行内。
 * @returns 元素树；渲染失败时是带原文的错误 span。
 */
function renderTexToReact(tex: string, displayMode: boolean): ReactNode {
  let html: string
  try {
    html = katex.renderToString(tex, { displayMode, throwOnError: true })
  } catch (error) {
    try {
      html = katex.renderToString(tex, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      return (
        <span className="katex-error" data-dsh-part="md-math-error" style={{ color: '#cc0000' }} title={String(error)}>
          {tex}
        </span>
      )
    }
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return [...parsed.body.childNodes].map(domToReact)
}

/**
 * 渲染一段行内文本。
 * @param text - 原始行内文本。
 * @param keyPrefix - 生成 React key 的前缀。
 * @returns 由文本、code、公式、strong 组成的节点数组。
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
    if (match[1] !== undefined) {
      nodes.push(<code key={key} data-dsh-part="md-code">{whole.slice(1, -1)}</code>)
    } else if (match[2] !== undefined) {
      // $…$：剥掉两侧各一个 $
      nodes.push(<span key={key} data-dsh-part="md-math">{renderTexToReact(whole.slice(1, -1), false)}</span>)
    } else if (match[3] !== undefined) {
      // \(…\)：剥掉两侧各两个字符
      nodes.push(<span key={key} data-dsh-part="md-math">{renderTexToReact(whole.slice(2, -2), false)}</span>)
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
  | { kind: 'code', lang: string, code: string }
  | { kind: 'math', tex: string }

/** 围栏代码块的开标记：三个及以上的反引号或波浪号，后面是语言标签（可空）。 */
const FENCE_OPEN = /^(`{3,}|~{3,})\s*(.*)$/

/** 块级公式的开标记：`$$` 或 `\[`，同一行后面可能已经跟着公式体。 */
const MATH_OPEN = /^(\$\$|\\\[)([\s\S]*)$/

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
 * 判断某一行是不是围栏代码块的闭合行。
 *
 * 规则照 CommonMark：同一种字符、不短于开标记、整行没有别的内容——所以四反引号块里的
 * 三反引号行不算闭合，而 ``` 后面跟着语言词的那行也不算，否则正文里紧挨着的下一个
 * 代码块会被前一块的头吞掉。
 * @param line - 待判定的行（已 trim）。
 * @param char - 开标记用的字符（反引号或波浪号）。
 * @param minLength - 开标记的长度。
 * @returns 是闭合行则为 true。
 */
function isFenceClose(line: string, char: string, minLength: number): boolean {
  if (line.length < minLength) return false
  for (const each of line) if (each !== char) return false
  return true
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
     * 围栏代码块排在段落与表格之前认：开标记就是行首的三连（及以上）反引号或波浪号。
     * 流式输出会先给出一个**没有闭合**的开标记，所以扫到末尾也没配到闭合行时，把剩下
     * 的全部吞进代码体——让三反引号露在正文里，比少显示几行代码更糟。
     */
    const fence = FENCE_OPEN.exec(trimmed)
    if (fence !== null) {
      flushParagraph()
      const marker = fence[1]
      const fenceChar = marker.slice(0, 1)
      const info = fence[2].trim()
      // 语言标签只取信息串的第一个词：后面跟的 title="…" 之类不是这里要表达的东西
      const lang = info === '' ? '' : info.split(/\s+/)[0]
      const body: string[] = []
      index += 1
      while (index < rows.length && !isFenceClose(rows[index].trim(), fenceChar, marker.length)) {
        // 代码体逐字保留（含行尾空白与缩进）：代码里的一致性比「看起来整齐」重要
        body.push(rows[index])
        index += 1
      }
      // 闭合行交给外层 for 的 index += 1 跳过；没闭合时 index 已经是 rows.length
      blocks.push({ kind: 'code', lang, code: body.join('\n') })
      continue
    }

    /**
     * 块级公式：`$$` 与 `\[`。三种写法都要吃下——单行写全、开标记独占一行、开标记后面
     * 直接跟公式体；同样要接住还没闭合的流式中途态。
     */
    const math = MATH_OPEN.exec(trimmed)
    if (math !== null) {
      flushParagraph()
      const closer = math[1] === '$$' ? '$$' : '\\]'
      const rest = math[2]
      const inlineClose = rest.indexOf(closer)
      if (inlineClose !== -1) {
        blocks.push({ kind: 'math', tex: rest.slice(0, inlineClose).trim() })
        continue
      }
      const body: string[] = []
      if (rest.trim() !== '') body.push(rest)
      index += 1
      while (index < rows.length) {
        const closeAt = rows[index].indexOf(closer)
        if (closeAt !== -1) {
          body.push(rows[index].slice(0, closeAt))
          break
        }
        body.push(rows[index])
        index += 1
      }
      blocks.push({ kind: 'math', tex: body.join('\n').trim() })
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
        if (block.kind === 'code') {
          return (
            /* 横向滚动挂在外层容器、而不只挂在 pre 上：Flex/Grid 项目的隐式最小尺寸是内容
               宽度，而两个正文容器（progress-row 与侧栏面板）都带 overflowWrap，一行很长的
               代码会把整列撑宽。这一层先把宽度钉在可用宽度内，pre 里的长行才滚得起来。 */
            <div key={key} data-dsh-part="md-code-block" style={{ margin: '6px 0', maxWidth: '100%', minWidth: 0, overflowX: 'auto' }}>
              {/* 语言标签只是标题：不做语法高亮，用户已明确不引入 shiki */}
              {block.lang !== '' && (
                <div
                  data-dsh-part="md-code-lang"
                  style={{ color: 'var(--dsw-alias-label-tertiary, #8f8d84)', fontFamily: MONO, fontSize: '11px', lineHeight: '1.4', margin: '0 0 2px 2px' }}
                >
                  {block.lang}
                </div>
              )}
              <pre
                data-dsh-part="md-pre"
                style={{
                  background: 'var(--dsw-alias-bg-layer-2, #f2f1ea)',
                  border: '0.5px solid var(--dsw-alias-border-l2, #e3e1d5)',
                  borderRadius: '8px',
                  boxSizing: 'border-box',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  margin: 0,
                  overflowX: 'auto',
                  padding: '8px 10px',
                }}
              >
                {/* 代码体不解析行内标记与公式：原文怎么写就怎么显示 */}
                <code data-dsh-part="md-code-fence" style={{ fontFamily: MONO, whiteSpace: 'pre' }}>{block.code}</code>
              </pre>
            </div>
          )
        }
        if (block.kind === 'math') {
          return (
            <div key={key} data-dsh-part="md-math-block" style={{ margin: '8px 0', overflowX: 'auto', overflowY: 'hidden' }}>
              {renderTexToReact(block.tex, true)}
            </div>
          )
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
