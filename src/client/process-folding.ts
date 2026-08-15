const ROW_CLASS = 'dsh-codex-process-row'
const GROUP_HEAD_CLASS = 'dsh-codex-process-group-head'
const GROUP_COLLAPSED_CLASS = 'dsh-codex-process-group-collapsed'
const GROUP_HIDDEN_CLASS = 'dsh-codex-process-group-hidden'
const USER_TOGGLED_ATTR = 'data-dsh-codex-process-user-toggled'
const TITLE_ATTR = 'data-dsh-codex-process-title'
const TITLE = 'Click to expand or collapse process details'
const DEFAULT_AUTO_COLLAPSE_MS = 2500
const MAX_PROCESS_LABELS_PER_ROW = 3
const MAX_SCAN_ROOTS_PER_FRAME = 80
const MAX_TEXT_SAMPLE = 20_000
const PROCESS_CANDIDATE_SELECTOR = 'article,section,li,div,p,h1,h2,h3,h4,h5,h6,[role="listitem"]'
const PROCESS_PREFIX_PATTERN = '(?:上下文注入|Think|Search|Code|代码|Pwsh|PowerShell|Bash|Shell|Read|Glob|Grep|Web(?:\\s+Search)?|Tool|工具|思考)'
const COMMAND_PATTERN = /(?:Code|代码|Pwsh|PowerShell|Bash|Shell|Read|Glob|Grep|Tool|工具)/i
const SEARCH_PATTERN = /(?:Search|Web\s+Search|搜索)/i
const PROCESS_PREFIX_RE = new RegExp(`^\\s*(?:[•●◦▪▫·#-]\\s*)?${PROCESS_PREFIX_PATTERN}\\s*(?:[·:：-]|$)`, 'i')
const PROCESS_LINE_RE = new RegExp(`(?:^|\\n)\\s*(?:[•●◦▪▫·#-]\\s*)?${PROCESS_PREFIX_PATTERN}\\s*(?:[·:：-]|$)`, 'gi')

export interface ProcessFoldingOptions {
  autoCollapseMs?: number
}

interface GroupState {
  rows: HTMLElement[]
  click: (event: MouseEvent) => void
  keydown: (event: KeyboardEvent) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface PreviousGroupState {
  collapsed: boolean
  userToggled: boolean
}

export function installProcessFolding(options: ProcessFoldingOptions = {}): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.body === null) {
    let dispose: () => void = () => undefined
    let started = false
    const start = () => {
      if (started) return
      started = true
      dispose = installProcessFolding(options)
    }
    document.addEventListener('DOMContentLoaded', start, { once: true })
    return () => {
      document.removeEventListener('DOMContentLoaded', start)
      dispose()
    }
  }

  const autoCollapseMs = options.autoCollapseMs ?? DEFAULT_AUTO_COLLAPSE_MS
  const groups = new Map<HTMLElement, GroupState>()
  const pending = new Set<Element>()
  let frame: number | null = null

  const scheduleFlush = () => {
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      flush()
    })
  }

  const queue = (element: Element | null) => {
    if (element === null || !element.isConnected) return
    pending.add(element)
    scheduleFlush()
  }

  const scheduleAutoCollapse = (head: HTMLElement) => {
    const state = groups.get(head)
    if (state === undefined || head.hasAttribute(USER_TOGGLED_ATTR)) return
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      if (head.isConnected && !head.hasAttribute(USER_TOGGLED_ATTR)) setGroupCollapsed(head, true)
    }, autoCollapseMs)
  }

  const syncGroup = (rows: HTMLElement[], previous: PreviousGroupState | undefined) => {
    const head = rows[0]
    const title = titleForProcessRows(rows)
    const click = (event: MouseEvent) => {
      if (isInteractiveTarget(event.target)) return
      markUserToggled(head)
      setGroupCollapsed(head, !head.classList.contains(GROUP_COLLAPSED_CLASS))
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      markUserToggled(head)
      setGroupCollapsed(head, !head.classList.contains(GROUP_COLLAPSED_CLASS))
    }

    groups.set(head, { rows, click, keydown, timer: null })
    for (const row of rows) row.classList.add(ROW_CLASS)
    head.classList.add(GROUP_HEAD_CLASS)
    if (!head.hasAttribute('tabindex')) head.tabIndex = 0
    head.setAttribute('aria-expanded', String(!(previous?.collapsed ?? false)))
    head.setAttribute(TITLE_ATTR, title)
    head.title ||= TITLE
    if (previous?.userToggled === true) head.setAttribute(USER_TOGGLED_ATTR, 'true')
    head.addEventListener('click', click)
    head.addEventListener('keydown', keydown)
    setGroupCollapsed(head, previous?.collapsed ?? false)
    scheduleAutoCollapse(head)
  }

  const rebuildParentGroups = (parent: Element) => {
    const previous = new Map<HTMLElement, PreviousGroupState>()
    for (const [head, state] of groups) {
      if (head.parentElement !== parent) continue
      previous.set(head, {
        collapsed: head.classList.contains(GROUP_COLLAPSED_CLASS),
        userToggled: head.hasAttribute(USER_TOGGLED_ATTR),
      })
      cleanupGroup(head, state)
      groups.delete(head)
    }

    let rows: HTMLElement[] = []
    const flushRows = () => {
      if (rows.length > 0) syncGroup(rows, previous.get(rows[0]))
      rows = []
    }

    for (const child of Array.from(parent.children)) {
      if (child instanceof HTMLElement && isProcessRow(child)) {
        rows.push(child)
      } else {
        flushRows()
      }
    }
    flushRows()
  }

  const flush = () => {
    const parents = new Set<Element>()
    let scanned = 0
    for (const root of Array.from(pending)) {
      pending.delete(root)
      if (!root.isConnected) continue
      for (const row of findProcessRows(root)) {
        if (row.parentElement !== null) parents.add(row.parentElement)
      }
      const grouped = nearestGroupHead(root)
      if (grouped !== null && grouped.parentElement !== null) parents.add(grouped.parentElement)
      scanned++
      if (scanned >= MAX_SCAN_ROOTS_PER_FRAME && pending.size > 0) {
        scheduleFlush()
        break
      }
    }
    for (const parent of parents) rebuildParentGroups(parent)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        queue(nodeElement(mutation.target)?.closest(PROCESS_CANDIDATE_SELECTOR) ?? nodeElement(mutation.target))
        continue
      }
      for (const node of mutation.addedNodes) queue(nodeElement(node))
    }
  })
  observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  queue(document.body)

  return () => {
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
    pending.clear()
    for (const [head, state] of groups) cleanupGroup(head, state)
    groups.clear()
  }
}

function cleanupGroup(head: HTMLElement, state: GroupState): void {
  if (state.timer !== null) clearTimeout(state.timer)
  head.removeEventListener('click', state.click)
  head.removeEventListener('keydown', state.keydown)
  for (const row of state.rows) row.classList.remove(ROW_CLASS, GROUP_HIDDEN_CLASS)
  head.classList.remove(GROUP_HEAD_CLASS, GROUP_COLLAPSED_CLASS)
  head.removeAttribute('aria-expanded')
  head.removeAttribute(USER_TOGGLED_ATTR)
  head.removeAttribute(TITLE_ATTR)
  if (head.title === TITLE) head.removeAttribute('title')
}

function findProcessRows(root: Element): HTMLElement[] {
  const rows: HTMLElement[] = []
  if (root instanceof HTMLElement && isProcessRow(root)) rows.push(root)
  for (const element of root.querySelectorAll(PROCESS_CANDIDATE_SELECTOR)) {
    if (element instanceof HTMLElement && isProcessRow(element)) rows.push(element)
  }
  return rows
}

function isProcessRow(element: HTMLElement): boolean {
  if (element.closest('.dsh-codex-page') !== null || shouldIgnore(element)) return false
  const raw = (element.textContent ?? '').slice(0, MAX_TEXT_SAMPLE)
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!PROCESS_PREFIX_RE.test(normalized)) return false
  const stats = processTextStats(raw)
  if (stats.processLabels === 0 || stats.processLabels > MAX_PROCESS_LABELS_PER_ROW) return false
  return !(element.children.length > 0 && stats.hasNonProcessLine)
}

function processTextStats(text: string): { processLabels: number; hasNonProcessLine: boolean } {
  PROCESS_LINE_RE.lastIndex = 0
  let processLabels = 0
  while (PROCESS_LINE_RE.exec(text) !== null) processLabels++
  const hasNonProcessLine = text.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .some((line) => line !== '' && !PROCESS_PREFIX_RE.test(line))
  return { processLabels, hasNonProcessLine }
}

function setGroupCollapsed(head: HTMLElement, collapsed: boolean): void {
  const state = findCurrentGroupState(head)
  if (state === null) return
  head.classList.toggle(GROUP_COLLAPSED_CLASS, collapsed)
  head.setAttribute('aria-expanded', String(!collapsed))
  for (const row of state.rows.slice(1)) row.classList.toggle(GROUP_HIDDEN_CLASS, collapsed)
}

function findCurrentGroupState(head: HTMLElement): { rows: HTMLElement[] } | null {
  const rows: HTMLElement[] = [head]
  let sibling = head.nextElementSibling
  while (sibling instanceof HTMLElement && isProcessRow(sibling)) {
    rows.push(sibling)
    sibling = sibling.nextElementSibling
  }
  return rows.length > 0 ? { rows } : null
}

function markUserToggled(head: HTMLElement): void {
  head.setAttribute(USER_TOGGLED_ATTR, 'true')
}

function nearestGroupHead(element: Element): HTMLElement | null {
  const decorated = element.closest(`.${GROUP_HEAD_CLASS}`)
  return decorated instanceof HTMLElement ? decorated : null
}

function titleForProcessRows(rows: HTMLElement[]): string {
  const text = rows.map((row) => row.textContent ?? '').join('\n')
  if (COMMAND_PATTERN.test(text)) return '运行了命令'
  if (SEARCH_PATTERN.test(text)) return '进行了搜索'
  return '思考过程'
}

function nodeElement(node: Node): Element | null {
  if (node instanceof Element) return node
  return node.parentElement
}

function shouldIgnore(element: HTMLElement): boolean {
  return element.closest('textarea,input,select,button,a,[contenteditable="true"],script,style') !== null
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]') !== null
}
