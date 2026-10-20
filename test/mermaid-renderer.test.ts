// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeSvg } from '../src/client/mermaid/sanitize.ts'
import { findMermaidCandidate } from '../src/client/mermaid/renderer.ts'

/** 主聊天区 banner 上真实显示的语言文案：mermaid 不在 highlighter 的语言表里，显示的是占位符。 */
const PLACEHOLDER_ZH = '代码块'
const PLACEHOLDER_EN = 'Code block'

/**
 * 平台主聊天区的代码块 DOM（ui-primitives 的 CodeBlock，toolbar 形态）：
 * `div.md-code-block > div.bannerWrap > div[data-code-block-banner] > div > span`。
 *
 * 注意 banner 里显示什么：mermaid 不在 `LANG_ALIASES`（ui-primitives 的 highlight.ts）里，
 * `CodeToolbar` 于是走 `supportsHighlighting(lang) ? lang : labels.codeLabel` 的 false 分支，
 * 显示 codeBlock.title 的占位文案「代码块」/「Code block」。**真实主聊天区不会出现
 * 「mermaid」这串文本**，所以默认参数用占位符，只有专门验证标签判据的用例才传 'mermaid'。
 *
 * 复制按钮和语言标签是兄弟节点，banner 的 textContent 因此是「代码块复制」；语言只在
 * [data-code-block-banner] 的第一个元素子节点里。
 *
 * @param shownLanguage - banner 上显示的语言文案。
 * @param code - 代码正文。
 */
function platformCodeBlock(shownLanguage: string, code: string): { host: HTMLElement; codeEl: HTMLElement } {
  const host = document.createElement('div')
  host.className = 'md-code-block'

  const bannerWrap = document.createElement('div')
  bannerWrap.className = 'bannerWrap'

  const banner = document.createElement('div')
  banner.setAttribute('data-code-block-banner', '')
  const heading = document.createElement('div')
  const languageSpan = document.createElement('span')
  languageSpan.textContent = shownLanguage
  heading.appendChild(languageSpan)
  const actions = document.createElement('div')
  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.textContent = '复制'
  actions.appendChild(copyButton)
  banner.append(heading, actions)

  bannerWrap.appendChild(banner)

  const content = document.createElement('div')
  content.setAttribute('data-code-block-content', '')
  const pre = document.createElement('pre')
  pre.className = 'shiki css-variables'
  const codeEl = document.createElement('code')
  codeEl.textContent = code
  pre.appendChild(codeEl)
  content.appendChild(pre)

  host.append(bannerWrap, content)
  return { host, codeEl }
}

/**
 * 平台的旧 banner 形态（toolbarLabels 缺省时走 CodeBlock 的 div.banner 分支）：
 * 这里 [data-code-block-banner] 的第一个元素子节点本身就是语言，没有 heading 包裹。
 *
 * @param shownLanguage - banner 上显示的语言文案。
 * @param code - 代码正文。
 */
function legacyCodeBlock(shownLanguage: string, code: string): { host: HTMLElement; codeEl: HTMLElement } {
  const host = document.createElement('div')
  host.className = 'md-code-block'

  const bannerWrap = document.createElement('div')
  bannerWrap.className = 'bannerWrap'
  const banner = document.createElement('div')
  banner.setAttribute('data-code-block-banner', '')
  const infostring = document.createElement('div')
  infostring.textContent = shownLanguage
  const action = document.createElement('div')
  const copyButton = document.createElement('button')
  copyButton.textContent = 'Copy'
  action.appendChild(copyButton)
  banner.append(infostring, action)
  bannerWrap.appendChild(banner)

  const content = document.createElement('div')
  content.setAttribute('data-code-block-content', '')
  const pre = document.createElement('pre')
  const codeEl = document.createElement('code')
  codeEl.textContent = code
  pre.appendChild(codeEl)
  content.appendChild(pre)

  host.append(bannerWrap, content)
  return { host, codeEl }
}

/**
 * 进展正文那种「pre 外面还套了一层 div」的代码块（MarkdownLite 的 data-dsh-part 形状）。
 *
 * @param shownLanguage - 语言标题；null 表示没有语言标签。
 * @param code - 代码正文。
 */
function progressCodeBlock(shownLanguage: string | null, code: string): { host: HTMLElement; codeEl: HTMLElement } {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-part', 'md-code-block')

  if (shownLanguage !== null) {
    const caption = document.createElement('div')
    caption.setAttribute('data-dsh-part', 'md-code-lang')
    caption.textContent = shownLanguage
    host.appendChild(caption)
  }

  const pre = document.createElement('pre')
  pre.setAttribute('data-dsh-part', 'md-pre')
  const codeEl = document.createElement('code')
  codeEl.setAttribute('data-dsh-part', 'md-code-fence')
  codeEl.textContent = code
  pre.appendChild(codeEl)
  host.appendChild(pre)
  return { host, codeEl }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('findMermaidCandidate — 真实主聊天区形状（banner 显示占位文案）', () => {
  // 这两个 placeholder 都不是合法的语言 id：中文不以 a-z 开头，英文含空格。
  // 它们读不成语言标签，于是判断回落到正文关键字 —— 这正是 mermaid 块在主聊天区实际走的路径。
  for (const placeholder of [PLACEHOLDER_ZH, PLACEHOLDER_EN]) {
    describe(`banner 显示「${placeholder}」`, () => {
      const cases = [
        ['%%{init: …}%% 指令起手', '%%{init: {"theme": "base"}}%%\nflowchart LR\n  A-->B'],
        ['%% 注释起手', '%% 这是注释，下面才是图\nflowchart LR\n  A-->B'],
        ['frontmatter 三横线起手', '---\ntitle: 部署流程\n---\nflowchart LR\n  A-->B'],
        ['flowchart 起手', 'flowchart LR\n  A-->B'],
        ['journey 起手（旧关键字表漏掉的图型）', 'journey\n  title My working day'],
        ['C4Context 起手（旧关键字表漏掉的图型）', 'C4Context\n  Person(admin, "Admin")'],
        ['xychart-beta 起手（旧关键字表漏掉的图型）', 'xychart-beta\n  bar [1, 2, 3]'],
      ]

      for (const [name, code] of cases) {
        it(`识别：${name}`, () => {
          const { host, codeEl } = platformCodeBlock(placeholder, code)
          document.body.appendChild(host)
          const candidate = findMermaidCandidate(codeEl)
          expect(candidate).not.toBeNull()
          expect(candidate?.host).toBe(host)
          expect(candidate?.code).toBe(code.trim())
        })
      }

      it('不识别：标了 ts 且正文含 graph 字样', () => {
        const { host, codeEl } = platformCodeBlock('ts', 'graph.addEdge(a, b)\n  export default graph')
        document.body.appendChild(host)
        expect(findMermaidCandidate(codeEl)).toBeNull()
      })

      it('不识别：标了 ts、正文以 %% 注释起手后出现 graph 字样', () => {
        const { host, codeEl } = platformCodeBlock('ts', '%% 不是 mermaid\ngraph.addEdge(a, b)')
        document.body.appendChild(host)
        expect(findMermaidCandidate(codeEl)).toBeNull()
      })
    })
  }

  it('断言 banner 的真实文本形态：占位符 + 复制按钮，且不等于 mermaid', () => {
    const { host } = platformCodeBlock(PLACEHOLDER_ZH, 'flowchart LR\n  A-->B')
    document.body.appendChild(host)
    const banner = host.querySelector('[data-code-block-banner]') as HTMLElement
    expect(banner.firstElementChild?.textContent).toBe(PLACEHOLDER_ZH)
    expect(banner.textContent).toContain('复制')
    expect(host.firstElementChild?.textContent).not.toBe('mermaid')
  })
})

describe('findMermaidCandidate — 语言标签判据', () => {
  it('标签为 mermaid 时一票通过：正文不以任何关键字开头也识别', () => {
    // 理论上存在、平台实际不产生此文本（mermaid 不在 highlighter 语言表里，显示的是占位符）。
    // 保留它是为了守住「万一将来平台支持 mermaid 高亮」这条路径。
    const { host, codeEl } = platformCodeBlock('mermaid', '  "A" --> "B"')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)?.host).toBe(host)
  })

  it('标签大小写不敏感、允许尾部空白', () => {
    const { host, codeEl } = platformCodeBlock('  MERMAID  ', 'flowchart TD')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)?.host).toBe(host)
  })

  it('旧 banner 形态（第一个元素子节点就是语言）同样按占位符回落', () => {
    const { host, codeEl } = legacyCodeBlock(PLACEHOLDER_EN, 'sequenceDiagram\n  A->>B: hi')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)?.host).toBe(host)
  })

  it('标了具体语言时，任何关键字都不触发识别', () => {
    for (const language of ['typescript', 'text', 'markdown', 'json']) {
      const { host, codeEl } = platformCodeBlock(language, 'journey\n  title not a diagram here')
      document.body.appendChild(host)
      expect(findMermaidCandidate(codeEl), language).toBeNull()
    }
  })
})

describe('findMermaidCandidate — 关键字判据的边界', () => {
  it('剥离前置噪音后仍要求以关键字开头，普通散文不被误判', () => {
    const { host, codeEl } = platformCodeBlock(PLACEHOLDER_ZH, '%% 注释\n这里讲的是 graph 数据结构，不是图')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)).toBeNull()
  })

  it('frontmatter 只跳一个块，后面不以关键字开头就不识别', () => {
    const { host, codeEl } = platformCodeBlock(PLACEHOLDER_ZH, '---\ntitle: x\n---\nconst a = 1')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)).toBeNull()
  })

  it('未闭合的 frontmatter 不会吞掉整段正文', () => {
    const { host, codeEl } = platformCodeBlock(PLACEHOLDER_ZH, '---\ntitle: x\nflowchart LR')
    document.body.appendChild(host)
    // 没有第二个 --- 收尾时只跳首行，下一行 title: 不是关键字，因此不识别
    expect(findMermaidCandidate(codeEl)).toBeNull()
  })

  it('识别旧关键字表漏掉的其余图型', () => {
    for (const snippet of [
      'quadrantChart\n  x-axis Low --> High',
      'sankey-beta\n\nA,B,10',
      'radar-beta\n  axis a, b, c',
      'railroad-ebnf-beta\n  rule = "x"',
    ]) {
      const { host, codeEl } = platformCodeBlock(PLACEHOLDER_EN, snippet)
      document.body.appendChild(host)
      expect(findMermaidCandidate(codeEl)?.host, snippet).toBe(host)
    }
  })
})

describe('findMermaidCandidate — 类标记、进展正文与幂等', () => {
  it('保留既有行为：<code> 自带 mermaid 类即识别', () => {
    const { host, codeEl } = platformCodeBlock('text', 'anything at all here')
    codeEl.className = 'language-mermaid'
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)?.host).toBe(host)
  })

  it('进展正文的代码块：语言标题为 mermaid 时识别', () => {
    const { host, codeEl } = progressCodeBlock('mermaid', '%%{init: {"theme": "dark"}}%%\nflowchart LR\n A-->B')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)?.host).toBe(host)
  })

  it('进展正文的代码块：没有语言标题时按关键字识别，标了 ts 则不识别', () => {
    const bare = progressCodeBlock(null, 'journey\n  title My working day')
    document.body.appendChild(bare.host)
    expect(findMermaidCandidate(bare.codeEl)?.host).toBe(bare.host)

    const typed = progressCodeBlock('ts', 'journey\n  title not a diagram here')
    document.body.appendChild(typed.host)
    expect(findMermaidCandidate(typed.codeEl)).toBeNull()
  })

  it('已经在处理或已渲染过的宿主不会被二次识别', () => {
    const { host, codeEl } = platformCodeBlock(PLACEHOLDER_ZH, 'flowchart LR\n  A-->B')
    document.body.appendChild(host)
    host.setAttribute('data-dsh-mermaid-status', 'processing')
    expect(findMermaidCandidate(codeEl)).toBeNull()

    host.removeAttribute('data-dsh-mermaid-status')
    const wrapper = document.createElement('div')
    wrapper.className = 'dsh-mermaid-wrapper'
    document.body.insertBefore(wrapper, host)
    expect(findMermaidCandidate(codeEl)).toBeNull()
  })

  it('过短的正文不参与识别', () => {
    const { host, codeEl } = platformCodeBlock(PLACEHOLDER_ZH, 'ab')
    document.body.appendChild(host)
    expect(findMermaidCandidate(codeEl)).toBeNull()
  })
})

describe('Mermaid renderer & sanitizer', () => {
  it('strips foreignObject, script and on* handlers from SVG', () => {
    const rawSvg = `
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <foreignObject width="100" height="100">
          <div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div>
        </foreignObject>
        <g id="node1" onclick="alert(2)" data-val="123">
          <text x="10" y="20">Hello World</text>
        </g>
        <script>alert(3)</script>
      </svg>
    `
    const cleaned = sanitizeSvg(rawSvg)
    expect(cleaned).toContain('<text x="10" y="20">Hello World</text>')
    expect(cleaned).not.toContain('foreignObject')
    expect(cleaned).not.toContain('foreignobject')
    expect(cleaned).not.toContain('script')
    expect(cleaned).not.toContain('onclick')
    expect(cleaned).not.toContain('alert')
  })

  it('handles invalid xml gracefully without throwing', () => {
    const invalid = '<svg><unclosed>'
    const cleaned = sanitizeSvg(invalid)
    expect(cleaned).toBe('')
  })
})
