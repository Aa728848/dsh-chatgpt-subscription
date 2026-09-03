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
      <button type="button" class="dsh-mermaid-modal-btn" data-action="close" title="关闭">✕ 关闭</button>
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

function findMermaidCandidate(codeEl: HTMLElement): { host: HTMLElement; code: string } | null {
  // 1. 绝对忽略我们自己渲染容器内的任何子元素
  if (codeEl.closest('.dsh-mermaid-wrapper')) return null

  // 2. 找到唯一的代码块宿主容器（优先 .md-code-block，其次 pre，最后自身）
  const host = (codeEl.closest('.md-code-block') as HTMLElement) || codeEl.closest('pre') || codeEl
  if (processedHosts.has(host) || host.getAttribute('data-dsh-mermaid-status')) return null
  if (host.previousElementSibling?.classList.contains('dsh-mermaid-wrapper')) return null

  const codeText = (codeEl.textContent || '').trim()
  if (!codeText || codeText.length < 5) return null

  // 3. 判断是否为 mermaid 语法或标记
  const hasMermaidClass = [...codeEl.classList].some((c) => c.toLowerCase().includes('mermaid'))
  const topText = host.firstElementChild?.textContent?.trim().toLowerCase()
  const isHeaderMermaid = topText === 'mermaid' || topText?.startsWith('mermaid ')

  const isGrammarStart = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline)\b/i.test(codeText)

  if (hasMermaidClass || isHeaderMermaid || isGrammarStart) {
    return { host, code: codeText }
  }

  return null
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