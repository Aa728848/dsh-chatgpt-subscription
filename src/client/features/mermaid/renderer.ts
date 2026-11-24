import { sanitizeSvg } from './sanitize.ts'
import { installMermaidStyles } from './styles.ts'

interface MermaidAPI {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let mermaidSeq = 0
let mermaidPromise: Promise<MermaidAPI | null> | null = null
const processedHosts = new WeakSet<HTMLElement>()

function loadMermaid(): Promise<MermaidAPI | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  const existing = (window as unknown as { mermaid?: MermaidAPI }).mermaid
  if (existing) return Promise.resolve(existing)
  if (mermaidPromise) return mermaidPromise

  mermaidPromise = new Promise((resolve) => {
    const current = (window as unknown as { mermaid?: MermaidAPI }).mermaid
    if (current) {
      resolve(current)
      return
    }

    const script = document.createElement('script')
    script.src = '/api/dsh-chatgpt-subscription/mermaid.min.js'
    script.async = true
    script.onload = () => {
      resolve((window as unknown as { mermaid?: MermaidAPI }).mermaid || null)
    }
    script.onerror = () => {
      const cdn = document.createElement('script')
      cdn.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
      cdn.async = true
      cdn.onload = () => resolve((window as unknown as { mermaid?: MermaidAPI }).mermaid || null)
      cdn.onerror = () => resolve(null)
      document.head.appendChild(cdn)
    }
    document.head.appendChild(script)
  })

  return mermaidPromise
}

function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  return (
    root.classList.contains('dark') ||
    root.getAttribute('data-theme') === 'dark' ||
    root.getAttribute('data-color-mode') === 'dark' ||
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

async function initMermaidConfig(): Promise<MermaidAPI | null> {
  const m = await loadMermaid()
  if (!m) return null
  try {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: isDarkTheme() ? 'dark' : 'default',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    })
  } catch {
    // best-effort
  }
  return m
}

function openZoomModal(svgHtml: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'dsh-mermaid-modal-overlay'

  let scale = 1

  overlay.innerHTML = `
    <div class="dsh-mermaid-modal-toolbar">
      <button type="button" class="dsh-mermaid-modal-btn" data-action="zoom-out" title="缩小">− 缩小</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="zoom-in" title="放大">+ 放大</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="reset" title="重置">⟳ 重置</button>
      <button type="button" class="dsh-mermaid-modal-btn" data-action="close" title="关闭">关闭</button>
    </div>
    <div class="dsh-mermaid-modal-stage">
      <div class="dsh-mermaid-zoom-container">${svgHtml}</div>
    </div>
  `

  const stage = overlay.querySelector('.dsh-mermaid-zoom-container') as HTMLElement
  const updateTransform = () => {
    if (stage) stage.style.transform = `scale(${scale})`
  }

  overlay.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const action = target?.getAttribute('data-action')
    if (action === 'close' || target === overlay) {
      overlay.remove()
      document.removeEventListener('keydown', onKeyDown)
    } else if (action === 'zoom-in') {
      scale = Math.min(5, scale * 1.25)
      updateTransform()
    } else if (action === 'zoom-out') {
      scale = Math.max(0.2, scale / 1.25)
      updateTransform()
    } else if (action === 'reset') {
      scale = 1
      updateTransform()
    }
  })

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', onKeyDown)
    }
  }
  document.addEventListener('keydown', onKeyDown)

  document.body.appendChild(overlay)
}

/**
 * mermaid 11 的图型起始关键字 —— 只有出现在代码块开头的这些词，才算一张图。
 *
 * 来源：node_modules/mermaid/dist/mermaid.min.js 里各图型解析器的检测正则，形如
 * /^(?:\s*)?(?:\s*flowchart\b)/、/^(?:C4Context\b)/。这里取它们的并集，且只保留
 * 「能出现在图首」的词（participant、note、class 这类只在图内部出现的词不算）。
 *
 * 维护方式：升级 mermaid 后，把 dist 里所有 /^(?: 开头的检测正则抓出来（带 \b 的那批），
 * 取首个关键字做并集即可。这张表只会漏判、不会误判 —— 漏了的图还有 banner 语言标签兜底，
 * 所以宁缺毋滥。
 */
const MERMAID_DIAGRAM_KEYWORDS = [
  'flowchart', 'flowchart-elk', 'graph',
  'sequenceDiagram',
  'classDiagram', 'classDiagram-v2',
  'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'journey', 'gantt', 'pie', 'quadrantChart',
  'requirement', 'requirementDiagram', 'gitGraph', 'mindmap', 'timeline',
  'sankey', 'sankey-beta', 'xychart', 'xychart-beta',
  'block', 'block-beta', 'architecture', 'architecture-beta',
  'packet', 'packet-beta', 'radar-beta', 'kanban',
  'treemap', 'treemap-beta', 'cynefin-beta', 'ishikawa',
  'eventmodeling', 'venn-beta', 'wardley-beta', 'swimlane-beta',
  'treeView-beta', 'railroad-beta', 'railroad-abnf-beta', 'railroad-ebnf-beta',
  'railroad-peg-beta', 'info',
  'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
] as const

/** 行首可选空白 + 关键字 + 词边界；带连字符的关键字（C4 系列、*-beta）靠 \b 收尾即可。 */
const MERMAID_GRAMMAR = new RegExp(`^\\s*(?:${MERMAID_DIAGRAM_KEYWORDS.join('|')})\\b`, 'i')

/** frontmatter 的围栏（必须是行首三个横线，正文里的 --- 分隔线不算）。 */
const FRONTMATTER_FENCE = /^---\s*$/

/**
 * 剥掉正文开头那些「图还没开始」的东西，再交给 {@link MERMAID_GRAMMAR} 判断。
 *
 * 为什么需要它：mermaid 允许在一张图前面写 frontmatter、%% 注释和 %%{init}%% 指令，
 * 平台又把这类块的 banner 显示成占位文案（见 {@link readCodeBlockLanguage}），于是判断
 * 只能落在正文上。若直接拿原始正文匹配 ^关键字，%%{init: …}%% 起手的图 —— mermaid 里极
 * 常见的写法 —— 就永远识别不到。
 *
 * 跳过规则：
 *   - 空行、%% 注释行（含 %%{init}%% 指令）；
 *   - 开头的一个 frontmatter 块：首行是 --- 时，跳到下一个 --- 之后继续（没闭合就只跳首行）。
 *
 * 跳过之后仍要求以关键字开头，所以「标了别的语言」的块不受影响（那条在调用方就被否掉了），
 * 而标了 mermaid / 无标签的块不会被前置噪音挡在门外。
 *
 * @param codeText - 已经 trim 过的正文。
 * @returns 去掉前置噪音后的正文。
 */
function stripMermaidPreamble(codeText: string): string {
  const lines = codeText.split('\n')
  let index = 0

  // frontmatter 只可能出现在最开头，且只跳一个块
  if (lines.length > 0 && FRONTMATTER_FENCE.test(lines[0] ?? '')) {
    let end = 1
    while (end < lines.length && !FRONTMATTER_FENCE.test(lines[end] ?? '')) end += 1
    index = end < lines.length ? end + 1 : 1
  }

  while (index < lines.length) {
    const line = (lines[index] ?? '').trim()
    if (line === '' || line.startsWith('%%')) {
      index += 1
      continue
    }
    break
  }

  return lines.slice(index).join('\n')
}

/**
 * 读平台代码块 banner 上的语言标签。
 *
 * 为什么不再看 host.firstElementChild：主聊天区的 .md-code-block（toolbar 形态）把 banner
 * 包在 div.bannerWrap 里，firstElementChild 的 textContent 是「mermaid复制」这种「语言 +
 * 复制按钮文案」，既不 === 'mermaid' 也不 startsWith('mermaid ')，于是这条判据在主聊天区
 * 一次都没命中过。
 *
 * data-code-block-banner 是平台注释里写明的稳定语义钩子；它的第一个元素子节点只承载语言
 * —— toolbar 形态是 div.heading（内部 span.language），旧形态是 div.infostring ——
 * 复制按钮在兄弟节点里，污染不到这里的 textContent。
 *
 * @param host - 代码块宿主容器。
 * @returns 小写语言标签；读不到、或是平台占位文案时返回 null，调用方据此退回关键字判据。
 */
function readCodeBlockLanguage(host: HTMLElement): string | null {
  // 宿主可能是 .md-code-block 本身，也可能是它内部的 <pre>（调用方优先取容器，取不到才退到 pre）
  const scope = host.closest('.md-code-block, [data-dsh-part="md-code-block"]') ?? host
  // 平台代码块：banner 的第一个元素子节点只承载语言；进展正文的代码块没有 banner，
  // 语言写在 pre 上方的标题里（另一个模块拥有那块 DOM，这里只做防御性读取，
  // 属性被改名时自然读不到，退回关键字判据，不会误伤）。
  const bannerLabel = scope.querySelector('[data-code-block-banner]')?.firstElementChild?.textContent
  const captionLabel = bannerLabel ?? scope.querySelector('[data-dsh-part="md-code-lang"]')?.textContent
  const label = (captionLabel ?? '').trim().toLowerCase()
  if (label === '') return null
  // 语言标签是「一票通过」：等于 mermaid 就直接认。
  if (label === 'mermaid') return label
  // 具体语言（ts / typescript / text …）是一票否决的主体：标了别的语言就不是 mermaid，
  // 调用方据此 return null，绝不落到关键字判据上 —— 这正是「标了 ts 且正文含 graph 不被
  // 误判」的保证。
  if (/^[a-z][a-z0-9+#._-]*$/.test(label)) return label
  // 剩下的是「不是语言 id」的标签。平台的主聊天区落在这里：mermaid 不在 highlighter 的
  // LANG_ALIASES 里（ui-primitives 的 highlight.ts 没有这个别名），CodeToolbar 于是显示
  // codeBlock.title 的占位文案「代码块」/「Code block」。占位符不是作者意图的证据，
  // 按「无标签」处理，把判断交还给关键字 —— 否则标了 mermaid 的块一旦正文不以关键字开头
  // （%%{init}%%、%% 注释、frontmatter）就永远识别不到。
  return null
}

/**
 * `<code>` 自身或祖先是否带 mermaid 类。
 *
 * 保留原有行为（看 `<code>` 自己的类），同时扩展到祖先：有些 markdown 渲染器把语言类
 * 挂在 `<pre>` 上。查到代码块宿主为止，再往上就是消息正文，不该把别的卡片算进来。
 */
function hasMermaidClass(codeEl: HTMLElement, host: HTMLElement): boolean {
  for (let el: HTMLElement | null = codeEl; el !== null; el = el.parentElement) {
    if ([...el.classList].some((c) => c.toLowerCase().includes('mermaid'))) return true
    if (el === host) break
  }
  return false
}

/**
 * 判断一个 `<code>` 是不是要渲染的 mermaid 代码块。
 *
 * 判据按优先级排列，命中即返回：
 *   1. `<code>` 自身或祖先带 mermaid 类；
 *   2. 平台代码块 banner 上的语言标签等于 mermaid（一票通过）；
 *   3. banner 上是别的具体语言（ts、json …）时直接否掉，绝不看正文（一票否决）；
 *   4. 语言标签读不到、或只是平台占位文案（「代码块」/「Code block」）时，退回正文判断：
 *      剥掉 %%{init}%% / %% 注释 / frontmatter 这类前置噪音后，以 mermaid 图型关键字开头即命中。
 *
 * 第 4 条只在「拿不到具体语言」时启用：一个标了 ts、正文里出现 graph 字样的块不该被当成
 * mermaid —— 它在第 3 条就被否掉了。占位符之所以等同于「没标签」，是因为 mermaid 不在
 * highlighter 的语言表里，主聊天区显示的就是占位文案，而不是 "mermaid"。
 * 不用 mermaid.detectType 做判据 —— 实测它在未加载的图型上会抛 UnknownDiagramError，连
 * flowchart 都抛，靠不住。
 *
 * @param codeEl - 待判定的 `<code>` 元素。
 * @returns 需要渲染时的宿主容器与源码；不是 mermaid 代码块时返回 null。
 */
export function findMermaidCandidate(codeEl: HTMLElement): { host: HTMLElement; code: string } | null {
  // 1. 绝对忽略我们自己渲染容器内的任何子元素
  if (codeEl.closest('.dsh-mermaid-wrapper')) return null

  // 2. 找到唯一的代码块宿主容器：优先平台代码块 .md-code-block，其次进展正文的卡片
  //    [data-dsh-part="md-code-block"]（它的 pre 外面还套了一层 div，取 pre 会把图表插到卡片里面
  //    而那层 div 自带间距），最后退到 pre / 自身
  const host =
    (codeEl.closest('.md-code-block') as HTMLElement) ||
    (codeEl.closest('[data-dsh-part="md-code-block"]') as HTMLElement) ||
    codeEl.closest('pre') ||
    codeEl
  if (processedHosts.has(host) || host.getAttribute('data-dsh-mermaid-status')) return null
  if (host.previousElementSibling?.classList.contains('dsh-mermaid-wrapper')) return null

  const codeText = (codeEl.textContent || '').trim()
  if (!codeText || codeText.length < 5) return null

  // 3. 判据 1：类标记
  if (hasMermaidClass(codeEl, host)) return { host, code: codeText }

  // 4. 判据 2 / 3：语言标签负责「一票通过」和「一票否决」，占位符等于无标签 → 交还关键字
  const language = readCodeBlockLanguage(host)
  if (language === 'mermaid') return { host, code: codeText }
  if (language !== null) return null
  return MERMAID_GRAMMAR.test(stripMermaidPreamble(codeText)) ? { host, code: codeText } : null
}

async function renderMermaidHost(host: HTMLElement, code: string): Promise<void> {
  // 同步立即锁死该宿主，杜绝并发与重入
  processedHosts.add(host)
  host.setAttribute('data-dsh-mermaid-status', 'processing')

  const m = await initMermaidConfig()
  if (!m) {
    processedHosts.delete(host)
    host.removeAttribute('data-dsh-mermaid-status')
    return
  }

  const renderId = `dsh-mermaid-${++mermaidSeq}`

  try {
    const { svg } = await m.render(renderId, code)
    const cleanSvg = sanitizeSvg(svg)
    if (!cleanSvg) {
      processedHosts.delete(host)
      host.removeAttribute('data-dsh-mermaid-status')
      return
    }

    // 再次双重检查：防止在异步等待期间被其他流程插入
    if (host.previousElementSibling?.classList.contains('dsh-mermaid-wrapper')) {
      host.setAttribute('data-dsh-mermaid-status', 'done')
      host.style.display = 'none'
      return
    }

    const wrapper = document.createElement('div')
    wrapper.className = 'dsh-mermaid-wrapper'

    let showSource = false

    wrapper.innerHTML = `
      <div class="dsh-mermaid-header">
        <span class="dsh-mermaid-title">Mermaid 图表</span>
        <div class="dsh-mermaid-controls">
          <button type="button" class="dsh-mermaid-btn" data-btn="toggle-source">源码</button>
          <button type="button" class="dsh-mermaid-btn" data-btn="copy">复制</button>
          <button type="button" class="dsh-mermaid-btn" data-btn="zoom" title="放大查看">放大 ↗</button>
        </div>
      </div>
      <div class="dsh-mermaid-chart" title="点击放大">${cleanSvg}</div>
      <div class="dsh-mermaid-source"><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></div>
    `

    const sourceEl = wrapper.querySelector('.dsh-mermaid-source') as HTMLElement
    const toggleBtn = wrapper.querySelector('[data-btn="toggle-source"]') as HTMLButtonElement
    const copyBtn = wrapper.querySelector('[data-btn="copy"]') as HTMLButtonElement
    const chartEl = wrapper.querySelector('.dsh-mermaid-chart') as HTMLElement

    toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      showSource = !showSource
      if (showSource) {
        sourceEl.classList.add('is-visible')
        toggleBtn.textContent = '图表'
      } else {
        sourceEl.classList.remove('is-visible')
        toggleBtn.textContent = '源码'
      }
    })

    copyBtn?.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(code)
        copyBtn.textContent = '已复制'
        setTimeout(() => {
          copyBtn.textContent = '复制'
        }, 1500)
      } catch {
        // fallback
      }
    })

    const handleZoom = (e: Event) => {
      e.stopPropagation()
      openZoomModal(cleanSvg)
    }

    wrapper.querySelector('[data-btn="zoom"]')?.addEventListener('click', handleZoom)
    chartEl?.addEventListener('click', handleZoom)

    // 隐藏宿主并插入图表
    host.style.display = 'none'
    host.parentNode?.insertBefore(wrapper, host)
    host.setAttribute('data-dsh-mermaid-status', 'done')
  } catch {
    // 语法错误或流式未完成时释放锁，允许后续更新后重试
    processedHosts.delete(host)
    host.removeAttribute('data-dsh-mermaid-status')
    const errContainer = document.getElementById(renderId)
    if (errContainer) errContainer.remove()
  }
}

export function scanAndRenderMermaid(): void {
  if (typeof document === 'undefined') return

  // 只以 code 标签为唯一的判定入口，彻底避免 querySelector 多级命中同一代码块
  const codeElements = document.querySelectorAll<HTMLElement>('pre code, .md-code-block code')

  for (const codeEl of codeElements) {
    const candidate = findMermaidCandidate(codeEl)
    if (candidate) {
      void renderMermaidHost(candidate.host, candidate.code)
    }
  }
}

export function setupMermaidObserver(): () => void {
  if (typeof document === 'undefined') return () => {}

  installMermaidStyles()

  let timer: number | undefined
  const debouncedScan = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      scanAndRenderMermaid()
    }, 250)
  }

  debouncedScan()

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false
    for (const m of mutations) {
      // 只要 mutation 是我们自己的 wrapper 产生的变动，直接忽略
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          const el = node as HTMLElement
          if (el.classList?.contains('dsh-mermaid-wrapper') || el.closest?.('.dsh-mermaid-wrapper')) {
            continue
          }
          shouldScan = true
          break
        }
      }
      if (shouldScan) break
    }
    if (shouldScan) debouncedScan()
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  })

  const themeObserver = new MutationObserver(() => {
    void initMermaidConfig()
    for (const el of document.querySelectorAll<HTMLElement>('[data-dsh-mermaid-status="done"]')) {
      processedHosts.delete(el)
      el.removeAttribute('data-dsh-mermaid-status')
      const prevWrapper = el.previousElementSibling
      if (prevWrapper && prevWrapper.classList.contains('dsh-mermaid-wrapper')) {
        prevWrapper.remove()
      }
      el.style.display = ''
    }
    debouncedScan()
  })

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'data-color-mode'],
  })

  return () => {
    observer.disconnect()
    themeObserver.disconnect()
    window.clearTimeout(timer)
  }
}