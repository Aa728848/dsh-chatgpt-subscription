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
 * `progress_update` 的契约把正文限定为「一段正文 + 少量 bullet，轻 Markdown」，
 * 所以这里只做契约允许的那一小撮：
 *
 * - 段落（空行分隔，段内换行保留）
 * - `-` / `*` / `•` 开头的无序列表，以及 `1.` 开头的有序列表
 * - 行内 `code`
 * - `**粗体**`
 * - `###` 标题（最多三级）
 *
 * 刻意**不做**表格、图片、链接、HTML、脚注：那些超出契约，而完整实现的代价（一个
 * 解析器 + 一套安全过滤）远大于本面板的收益。渲染结果全是 React 元素，不经过
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

/** 块级解析的一个中间行类型。 */
type Block =
  | { kind: 'p', lines: string[] }
  | { kind: 'ul', items: string[] }
  | { kind: 'ol', items: string[] }
  | { kind: 'h', level: number, text: string }

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

  for (const rawLine of source.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
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
