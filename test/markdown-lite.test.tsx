// @vitest-environment jsdom
/**
 * 「进展正文」渲染器的验收：围栏代码块与数学公式真的变成了元素。
 *
 * 这一组钉住两件事：
 *
 * A. **解析**（`parseBlocks`）—— 围栏代码块与块级公式各自成块，未闭合的围栏被整段
 *    吞掉（流式输出会先给开标记），代码体不被当成别的块；
 * B. **渲染**（`MarkdownLite`）—— 围栏出来的是 pre + code 加一行语言标签，公式出来的
 *    是 KaTeX 的元素树，而「价格 $5 到 $10」这种普通文本不会被误判成公式。
 *
 * 为什么用 `@@vitest-environment jsdom`：KaTeX 只吐 HTML 串，本插件用 `DOMParser`
 * 把它转成 React 元素，没有 DOM 这一步就无从谈起；而仓库默认环境是 node。
 *
 * 为什么手搓 createRoot + act 而不用 @testing-library：与本仓库其余 UI 测试
 * （`progress-updates-client.test.tsx`）保持一致，不为一个测试新增依赖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownLite, parseBlocks } from '../src/client/progress-updates/markdown-lite.tsx'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/** 渲染宿主。 */
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined
})

/**
 * 渲染一段正文，返回挂载容器供断言查询。
 * @param text - 进展正文原文。
 * @returns 挂载容器。
 */
async function renderMarkdown(text: string): Promise<HTMLDivElement> {
  await act(async () => {
    root.render(createElement(MarkdownLite as never, { text }))
  })
  return container
}

/**
 * 取渲染结果里某个 data-dsh-part 的第一个元素。
 * @param host - 挂载容器。
 * @param name - data-dsh-part 的取值。
 * @returns 命中的元素，没有则为 null。
 */
function part(host: HTMLElement, name: string): Element | null {
  return host.querySelector('[data-dsh-part="' + name + '"]')
}

describe('围栏代码块', () => {
  it('带语言标签的围栏：渲染 pre+code，语言标签显示在顶上', async () => {
    // Given 一段模型最爱写的 ts 代码块
    const source = ['先看这段：', '', '```ts', 'const a: number = 1', 'console.log(a)', '```'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 语言标签与代码体各就各位
    expect(part(host, 'md-code-lang')?.textContent).toBe('ts')
    const code = part(host, 'md-code-fence')!
    expect(code.tagName).toBe('CODE')
    expect(code.textContent).toBe('const a: number = 1\nconsole.log(a)')
    expect(code.parentElement?.tagName).toBe('PRE')
    // And 三反引号本身一个都不剩
    expect(host.textContent).not.toContain('```')
  })

  it('无语言标签的围栏：不渲染语言标签那一行', async () => {
    // Given 一个裸围栏
    const source = ['```', 'plain text', '```'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 代码在、标签不在
    expect(part(host, 'md-code-lang')).toBeNull()
    expect(part(host, 'md-code-fence')?.textContent).toBe('plain text')
  })

  it('波浪号围栏与四反引号围栏都认，四反引号块里可以放三反引号', async () => {
    // Given 用 ~~~ 包的块，和用四个反引号包住三反引号行的块
    const source = ['~~~sh', 'npm test', '~~~', '', '````md', '```js', '```', '````'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 是两块，而不是一块或三块
    const blocks = host.querySelectorAll('[data-dsh-part="md-code-block"]')
    expect(blocks.length).toBe(2)
    expect(blocks[0].querySelector('[data-dsh-part="md-code-lang"]')?.textContent).toBe('sh')
    expect(blocks[0].querySelector('[data-dsh-part="md-code-fence"]')?.textContent).toBe('npm test')
    expect(blocks[1].querySelector('[data-dsh-part="md-code-fence"]')?.textContent).toBe('```js\n```')
  })

  it('未闭合的围栏（流式输出中途态）把剩余内容整段吞进代码块', async () => {
    // Given 只有开标记、还没等到闭合行的正文
    const source = ['跑完了：', '```ts', 'const a = 1', 'console.log(a)'].join('\n')
    // When 解析
    const blocks = parseBlocks(source)
    // Then 三反引号没有留在正文里，剩下的行都在代码体里
    expect(blocks).toEqual([
      { kind: 'p', lines: ['跑完了：'] },
      { kind: 'code', lang: 'ts', code: 'const a = 1\nconsole.log(a)' },
    ])
  })

  it('代码块里的粗体、行内 code 与公式都原样保留，不当标记解析', async () => {
    // Given 一段代码块，里面的内容长得像 Markdown 语法
    const source = ['```md', '**不是粗体**', '`inner`', '$x^2$', '```'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 原文逐字上屏，且没有任何 strong / 公式 / 行内 code 元素混进来
    const code = part(host, 'md-code-fence')!
    expect(code.textContent).toBe('**不是粗体**\n`inner`\n$x^2$')
    expect(code.querySelector('strong')).toBeNull()
    expect(code.querySelector('span[data-dsh-part="md-math"]')).toBeNull()
    expect(host.querySelector('.katex')).toBeNull()
  })

  it('围栏代码块会打断段落，闭合之后的行重新成段', () => {
    // Given 段落 + 代码块 + 段落
    const source = ['前文', '```', 'code', '```', '后文'].join('\n')
    // When 解析
    const blocks = parseBlocks(source)
    // Then 三块各自独立，后文没有被吞进代码块
    expect(blocks.map((block) => block.kind)).toEqual(['p', 'code', 'p'])
  })
})

describe('数学公式', () => {
  it('行内 $…$ 用 KaTeX 渲染成元素树', async () => {
    // Given 一句带行内公式的话
    const host = await renderMarkdown('质量与能量满足 $E=mc^2$ 的关系。')
    // Then 公式位置是 md-math 里的 .katex，而不是原始 $ 符号
    const math = part(host, 'md-math')!
    expect(math.querySelector('.katex')).not.toBeNull()
    // And 前后文字都还在，$ 符号没有上屏
    expect(host.textContent).toContain('质量与能量满足')
    expect(host.textContent).toContain('的关系。')
    expect(host.textContent).not.toContain('$')
  })

  it('行内反斜杠括号写法同样按公式渲染', async () => {
    // Given \(…\) 写法的行内公式
    const host = await renderMarkdown('令 \\(\\alpha + \\beta\\) 为常数。')
    // Then 也是 KaTeX 出来的
    expect(part(host, 'md-math')?.querySelector('.katex')).not.toBeNull()
    expect(host.textContent).not.toContain('\\(')
  })

  it('块级 $$…$$ 独占一块并带上 katex-display', async () => {
    // Given 独占一行的块级公式（多行写法）
    const source = ['$$', 'a^2 + b^2 = c^2', '$$'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 外面是块级容器，里面是 display 模式的 KaTeX
    const block = part(host, 'md-math-block')!
    expect(block.querySelector('.katex-display')).not.toBeNull()
    expect(block.querySelector('.katex')).not.toBeNull()
    // And 块级公式不挂在段落里
    expect(host.querySelector('[data-dsh-part="md-p"]')).toBeNull()
  })

  it('单行 $$…$$ 与方括号写法都认', async () => {
    // Given 两种一行写完的块级公式
    const host = await renderMarkdown(['$$x=1$$', '', '\\[y=2\\]'].join('\n'))
    // Then 两块都是块级公式
    expect(host.querySelectorAll('[data-dsh-part="md-math-block"]').length).toBe(2)
    expect(host.querySelectorAll('.katex-display').length).toBe(2)
  })

  it('价格 $5 到 $10 不会被误判成公式', async () => {
    // Given 一句带美元价格的话
    const host = await renderMarkdown('价格 $5 到 $10')
    // Then 没有公式元素，原文连 $ 一起保留
    expect(host.querySelector('.katex')).toBeNull()
    expect(part(host, 'md-math')).toBeNull()
    expect(part(host, 'md-p')?.textContent).toBe('价格 $5 到 $10')
  })

  it('一边的 $ 找不到合格闭合时整行保持纯文本', async () => {
    // Given 只有一个 $ 且它后面跟着空格
    const host = await renderMarkdown('预算 $ 12 元')
    // Then 不渲染公式
    expect(host.querySelector('.katex')).toBeNull()
    expect(part(host, 'md-p')?.textContent).toBe('预算 $ 12 元')
  })

  it('写坏的 TeX 不抛异常，降级成 katex-error', async () => {
    // Given 一条 KaTeX 认不出的公式
    const host = await renderMarkdown('这里 $x^{$ 会失败')
    // Then 渲染照常完成，位置上是 KaTeX 自己的错误样式
    const error = host.querySelector('.katex-error')
    expect(error).not.toBeNull()
    // KaTeX 自己的降级形态：katex-error 的文本就是那段没解析出来的源码
    expect(error?.textContent).toBe('x^{')
    expect(host.textContent).toContain('这里')
  })

  it('解析器把块级公式切成独立的 math 块', () => {
    // Given 段落 + 块级公式 + 段落
    const source = ['前文', '$$', 'x^2', '$$', '后文'].join('\n')
    // When 解析
    const blocks = parseBlocks(source)
    // Then 形状固定：p / math / p，公式体不含分隔符
    expect(blocks).toEqual([
      { kind: 'p', lines: ['前文'] },
      { kind: 'math', tex: 'x^2' },
      { kind: 'p', lines: ['后文'] },
    ])
  })
})

describe('既有行为不回归', () => {
  it('GFM 表格仍然渲染成 table，对齐与单元格照旧', async () => {
    // Given 一张带对齐的表格
    const source = ['| 项 | 值 |', '| --- | ---: |', '| a | 1 |', '| b | 2 |'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 表头、数据行、右对齐都在
    expect(host.querySelectorAll('[data-dsh-part="md-th"]').length).toBe(2)
    expect(host.querySelectorAll('[data-dsh-part="md-td"]').length).toBe(4)
    const firstCell = host.querySelectorAll('[data-dsh-part="md-td"]')[1] as HTMLElement
    expect(firstCell.style.textAlign).toBe('right')
    expect(firstCell.textContent).toBe('1')
  })

  it('无序列表与有序列表仍然渲染成 ul / ol', async () => {
    // Given 两种列表
    const source = ['- 甲', '- 乙', '', '1. 一', '2. 二'].join('\n')
    // When 渲染
    const host = await renderMarkdown(source)
    // Then 类型与条目数都对
    expect(host.querySelectorAll('[data-dsh-part="md-ul"] > li').length).toBe(2)
    expect(host.querySelectorAll('[data-dsh-part="md-ol"] > li').length).toBe(2)
  })

  it('标题仍然渲染成 md-h，行内 code 与粗体仍然生效', async () => {
    // Given 三级标题 + 一段带行内标记的正文
    const host = await renderMarkdown(['### 结论', '', '用 `npm run typecheck` 确认 **通过**'].join('\n'))
    // Then 标题层级、行内 code、粗体三样都在
    const heading = part(host, 'md-h')!
    expect(heading.textContent).toBe('结论')
    expect((heading as HTMLElement).style.fontSize).toBe('13px')
    expect(part(host, 'md-code')?.textContent).toBe('npm run typecheck')
    expect(part(host, 'md-strong')?.textContent).toBe('通过')
  })

  it('段落保留换行（whiteSpace 是 pre-wrap）', async () => {
    // Given 一段内部有换行的正文
    const host = await renderMarkdown(['第一行', '第二行'].join('\n'))
    // Then 还是一段，文本里有换行
    const paragraph = part(host, 'md-p') as HTMLElement
    expect(host.querySelectorAll('[data-dsh-part="md-p"]').length).toBe(1)
    expect(paragraph.textContent).toBe('第一行\n第二行')
    expect(paragraph.style.whiteSpace).toBe('pre-wrap')
  })

  it('空正文渲染空片段，不炸', async () => {
    // Given 空字符串
    const host = await renderMarkdown('')
    // Then 什么都不渲染
    expect(host.textContent).toBe('')
  })
})
