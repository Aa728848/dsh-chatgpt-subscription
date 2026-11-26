import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { MarkdownLite } from './markdown-lite.tsx'
import type { ProgressTask, ProgressUpdate } from './contracts.ts'
import { zh, type ProgressUpdatesLocaleKey } from './locales.ts'

export interface DashboardCopySeat {
  t?: (key: ProgressUpdatesLocaleKey) => string
}

export interface ProgressDashboardProps extends DashboardCopySeat {
  updates: readonly ProgressUpdate[]
  tasks?: readonly ProgressTask[]
}

const PANEL_CSS = [
  '.pg-dashboard { container-type: inline-size; }',
  '.pg-dashboard button, .pg-dashboard input, .pg-dashboard select { font: inherit; }',
  '.pg-dashboard button:focus-visible, .pg-dashboard input:focus-visible, .pg-dashboard select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #7c8cff); outline-offset: 2px; }',
  '.pg-quiet-button { transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }',
  '.pg-quiet-button:hover { background: var(--dsw-alias-fill-hover, rgb(127 127 127 / 12%)) !important; }',
  '.pg-update-card { transition: border-color 140ms ease, background 140ms ease; }',
  '.pg-update-card:hover { border-color: var(--dsw-alias-border-l1, rgb(127 127 127 / 28%)) !important; }',
  '.pg-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l1, #555) transparent; }',
  '@container (max-width: 390px) { .pg-overview-meta { display: none !important; } .pg-toolbar { grid-template-columns: 1fr !important; } .pg-source-filter { display: none !important; } }',
  '@media (prefers-reduced-motion: reduce) { .pg-dashboard * { transition: none !important; } }',
].join('\n')

const colors = {
  primary: 'var(--dsw-alias-label-primary, #e7e9ee)',
  secondary: 'var(--dsw-alias-label-secondary, #a4a9b5)',
  tertiary: 'var(--dsw-alias-label-tertiary, #777e8c)',
  brand: 'var(--dsw-alias-brand-primary, #8b9dff)',
  success: 'var(--dsw-alias-success-primary, #62c99b)',
  warning: 'var(--dsw-alias-warning-primary, #e6b86a)',
  border: 'var(--dsw-alias-border-l2, rgb(127 127 127 / 18%))',
  surface: 'var(--dsw-alias-bg-layer-1, rgb(127 127 127 / 5%))',
  raised: 'var(--dsw-alias-bg-layer-2, rgb(127 127 127 / 8%))',
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  let text = template
  for (const [key, value] of Object.entries(params)) text = text.replaceAll(`{${key}}`, String(value))
  return text
}

function translator(t: DashboardCopySeat['t']) {
  return (key: ProgressUpdatesLocaleKey, params?: Record<string, unknown>): string => {
    const template = t === undefined ? (zh[key] ?? key) : t(key)
    return interpolate(template, params)
  }
}

function titleOf(update: ProgressUpdate): string {
  if (update.title !== undefined && update.title.trim() !== '') return update.title
  return update.message.split('\n').find(line => line.trim() !== '') ?? ''
}

function clockOf(at: number): string {
  if (!Number.isFinite(at)) return ''
  try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

function dayOf(at: number): string {
  try { return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', weekday: 'short' }) } catch { return '' }
}

function dateTimeOf(at: number): string {
  try { return new Date(at).toISOString() } catch { return '' }
}

function Icon({ name, size = 14 }: { name: 'arrow' | 'copy' | 'download' | 'search' | 'task' | 'pulse' | 'archive', size?: number }): ReactNode {
  const paths: Record<typeof name, ReactNode> = {
    arrow: <path d='m6 4 4 4-4 4' />,
    copy: <><rect x='5' y='5' width='7' height='8' rx='1.5' /><path d='M3 10V4a1 1 0 0 1 1-1h5' /></>,
    download: <><path d='M8 2v8m0 0 3-3m-3 3L5 7' /><path d='M3 12v2h10v-2' /></>,
    search: <><circle cx='7' cy='7' r='4' /><path d='m10 10 3 3' /></>,
    task: <><rect x='3' y='2.5' width='10' height='11' rx='2' /><path d='m5.5 6 1.5 1.5 3-3M5.5 11h5' /></>,
    pulse: <><path d='M2 8h3l1.5-4 3 8 1.5-4h3' /></>,
    archive: <><rect x='2.5' y='3' width='11' height='3' rx='1' /><path d='M4 6v6h8V6M6.5 9h3' /></>,
  }
  return <svg viewBox='0 0 16 16' width={size} height={size} fill='none' stroke='currentColor' strokeWidth='1.35' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>{paths[name]}</svg>
}

function QuietButton({ label, onClick, children, active = false, part }: { label: string, onClick: () => void, children: ReactNode, active?: boolean, part?: string }): ReactNode {
  return <button type='button' className='pg-quiet-button' data-dsh-part={part} aria-label={label} title={label} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', minHeight: '28px', padding: '4px 8px', border: `1px solid ${active ? colors.brand : colors.border}`, borderRadius: '7px', background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 12%, transparent)' : 'transparent', color: active ? colors.brand : colors.secondary, cursor: 'pointer', fontSize: '11px' }}>{children}</button>
}

function taskCounts(tasks: readonly ProgressTask[]) {
  return {
    completed: tasks.filter(task => task.status === 'completed').length,
    active: tasks.filter(task => task.status === 'in_progress').length,
    pending: tasks.filter(task => task.status === 'pending').length,
  }
}

function TaskOverview({ tasks, t }: { tasks: readonly ProgressTask[], t: ReturnType<typeof translator> }): ReactNode {
  const counts = taskCounts(tasks)
  const progress = tasks.length === 0 ? 0 : Math.round(counts.completed / tasks.length * 100)
  const radius = 25
  const circumference = 2 * Math.PI * radius
  if (tasks.length === 0) return <div data-dsh-part='tasks-empty' style={{ padding: '28px 10px', textAlign: 'center', color: colors.tertiary }}><Icon name='task' size={22} /><div style={{ marginTop: '8px' }}>{t('tasksEmpty')}</div></div>
  return <section data-dsh-part='tasks-view' style={{ padding: '4px 2px 18px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '12px', marginBottom: '12px', borderRadius: '12px', background: 'linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 10%, transparent), transparent)' }}>
      <div style={{ position: 'relative', width: '62px', height: '62px', flex: '0 0 auto' }}>
        <svg viewBox='0 0 62 62' width='62' height='62' aria-label={t('tasksProgress', { n: progress })}>
          <circle cx='31' cy='31' r={radius} fill='none' stroke={colors.border} strokeWidth='5' />
          <circle cx='31' cy='31' r={radius} fill='none' stroke={colors.brand} strokeWidth='5' strokeLinecap='round' strokeDasharray={circumference} strokeDashoffset={circumference * (1 - progress / 100)} transform='rotate(-90 31 31)' />
        </svg>
        <span style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', fontSize: '13px', fontWeight: 650, color: colors.primary }}>{progress}%</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: colors.primary, fontSize: '14px', fontWeight: 600 }}>{t('tasksSummary', { done: counts.completed, total: tasks.length })}</div>
        <div style={{ color: colors.secondary, fontSize: '11px', marginTop: '5px' }}>{t('tasksBreakdown', { active: counts.active, pending: counts.pending })}</div>
      </div>
    </div>
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '6px' }}>
      {tasks.map(task => {
        const done = task.status === 'completed'
        const active = task.status === 'in_progress'
        return <li key={task.id} data-task-status={task.status} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '9px 10px', borderRadius: '9px', background: active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 9%, transparent)' : 'transparent', border: `1px solid ${active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 25%, transparent)' : 'transparent'}` }}>
          <span aria-hidden='true' style={{ flex: '0 0 auto', width: '15px', height: '15px', marginTop: '2px', borderRadius: '50%', display: 'grid', placeItems: 'center', border: `1.5px solid ${done ? colors.success : active ? colors.brand : colors.tertiary}`, background: done ? colors.success : 'transparent', color: '#fff', fontSize: '10px' }}>{done ? '✓' : active ? '•' : ''}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: done ? colors.tertiary : colors.primary, textDecoration: done ? 'line-through' : 'none', fontSize: '12px', lineHeight: 1.55, overflowWrap: 'anywhere' }}>{task.content}</div>
            {active && task.activeForm !== undefined && <div style={{ color: colors.brand, fontSize: '11px', marginTop: '3px' }}>{task.activeForm}</div>}
          </div>
        </li>
      })}
    </ol>
  </section>
}

type ArchiveScale = 900_000 | 3_600_000 | 14_400_000

function ArchiveView({ updates, t }: { updates: readonly ProgressUpdate[], t: ReturnType<typeof translator> }): ReactNode {
  const [scale, setScale] = useState<ArchiveScale>(3_600_000)
  const groups = useMemo(() => {
    const buckets = new Map<number, ProgressUpdate[]>()
    for (const update of updates) {
      const start = Math.floor(update.at / scale) * scale
      const bucket = buckets.get(start)
      if (bucket === undefined) buckets.set(start, [update])
      else bucket.push(update)
    }
    return [...buckets.entries()].sort((a, b) => b[0] - a[0])
  }, [updates, scale])
  const max = Math.max(1, ...groups.map(([, items]) => items.length))
  return <section data-dsh-part='archive-view'>
    <div style={{ display: 'flex', gap: '5px', marginBottom: '12px' }}>
      {([900_000, 3_600_000, 14_400_000] as const).map(value => <QuietButton key={value} label={t('archiveScale', { n: value === 15 * 60_000 ? '15m' : value === 60 * 60_000 ? '1h' : '4h' })} active={scale === value} onClick={() => { setScale(value) }}>{value === 15 * 60_000 ? '15m' : value === 60 * 60_000 ? '1h' : '4h'}</QuietButton>)}
    </div>
    {groups.length === 0 ? <div style={{ padding: '24px 8px', textAlign: 'center', color: colors.tertiary }}>{t('archiveEmpty')}</div> : null}
    <div style={{ display: 'grid', gap: '9px' }}>
      {groups.map(([start, items]) => <details key={start} style={{ borderRadius: '10px', background: colors.surface, border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
        <summary style={{ cursor: 'pointer', padding: '10px 11px', listStyle: 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', color: colors.secondary, fontSize: '11px' }}><span>{dayOf(start)} · {clockOf(start)}</span><span>{t('archiveCount', { n: items.length })}</span></div>
          <div style={{ height: '3px', marginTop: '9px', borderRadius: '2px', background: colors.border, overflow: 'hidden' }}><div style={{ width: `${items.length / max * 100}%`, height: '100%', background: colors.brand }} /></div>
        </summary>
        <ol style={{ listStyle: 'none', margin: 0, padding: '0 11px 10px', display: 'grid', gap: '6px' }}>
          {items.map(item => <li key={item.id} style={{ fontSize: '11px', color: colors.secondary, overflowWrap: 'anywhere' }}><time style={{ color: colors.tertiary, marginRight: '7px' }}>{clockOf(item.at)}</time>{titleOf(item)}</li>)}
        </ol>
      </details>)}
    </div>
  </section>
}

function updateMarkdown(update: ProgressUpdate): string {
  return `### ${titleOf(update)}\n\n${update.message}\n\n— ${dateTimeOf(update.at)}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { return false }
  return false
}

function exportUpdates(updates: readonly ProgressUpdate[]): void {
  try {
    const blob = new Blob([updates.map(updateMarkdown).join('\n\n---\n\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'progress-updates.md'
    anchor.click()
    setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  } catch {
    // 下载能力受宿主限制时保持面板可用。
  }
}

export function ProgressDashboard({ updates, tasks = [], t: copy }: ProgressDashboardProps): ReactNode {
  const t = translator(copy)
  const [tab, setTab] = useState<'updates' | 'tasks' | 'archive'>('updates')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [copiedId, setCopiedId] = useState<string>()
  const latestId = updates.length > 0 ? updates[updates.length - 1].id : undefined
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set(latestId === undefined ? [] : [latestId]))
  useEffect(() => {
    if (latestId === undefined) return
    setExpandedIds(current => current.has(latestId) ? current : new Set([...current, latestId]))
  }, [latestId])
  const sources = useMemo(() => [...new Set(updates.map(item => item.source).filter((value): value is string => value !== undefined && value !== ''))], [updates])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return updates.filter(item => {
      if (source !== '' && item.source !== source) return false
      if (needle === '') return true
      return (titleOf(item) + '\n' + item.message).toLocaleLowerCase().includes(needle)
    })
  }, [updates, query, source])
  const counts = taskCounts(tasks)
  const latest = updates[updates.length - 1]
  const tabs = [
    { id: 'updates' as const, label: t('tabUpdates'), icon: 'pulse' as const, count: updates.length },
    { id: 'tasks' as const, label: t('tabTasks'), icon: 'task' as const, count: tasks.length },
    { id: 'archive' as const, label: t('tabArchive'), icon: 'archive' as const, count: undefined },
  ]
  return <div className='pg-dashboard pg-scroll' data-dsh-plugin='progress-updates' data-dsh-part='updates' style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: '12px 12px 20px', color: colors.primary, fontSize: '12px' }}>
    <style>{PANEL_CSS}</style>
    <header style={{ padding: '2px 2px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: colors.brand }}><Icon name='pulse' size={16} /><strong style={{ fontSize: '13px', letterSpacing: '.02em' }}>{t('workspaceTitle')}</strong></div>
        <span className='pg-overview-meta' data-dsh-part='updates-count' style={{ color: colors.tertiary, fontSize: '10px' }}>{t('progressCount', { n: updates.length })}</span>
      </div>
      <div style={{ marginTop: '9px', color: latest === undefined ? colors.tertiary : colors.secondary, fontSize: '12px', lineHeight: 1.55, overflowWrap: 'anywhere' }}>{latest === undefined ? t('progressEmptyHint') : titleOf(latest)}</div>
      {tasks.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
        <div style={{ flex: 1, height: '3px', borderRadius: '2px', overflow: 'hidden', background: colors.border }}><div style={{ width: `${counts.completed / tasks.length * 100}%`, height: '100%', background: `linear-gradient(90deg, ${colors.brand}, ${colors.success})` }} /></div>
        <span style={{ color: colors.tertiary, fontSize: '10px', whiteSpace: 'nowrap' }}>{counts.completed}/{tasks.length}</span>
      </div>}
    </header>
    <nav aria-label={t('workspaceTitle')} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', padding: '3px', borderRadius: '10px', background: colors.surface, position: 'sticky', top: '-12px', zIndex: 2, backdropFilter: 'blur(12px)' }}>
      {tabs.map(item => <button key={item.id} type='button' data-dsh-part={`tab-${item.id}`} aria-pressed={tab === item.id} onClick={() => { setTab(item.id) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '7px 4px', border: '0', borderRadius: '8px', cursor: 'pointer', background: tab === item.id ? colors.raised : 'transparent', color: tab === item.id ? colors.brand : colors.tertiary, boxShadow: tab === item.id ? `inset 0 0 0 1px ${colors.border}` : 'none', fontSize: '11px' }}><Icon name={item.icon} /><span>{item.label}</span>{item.count !== undefined && <span style={{ opacity: .7 }}>{item.count}</span>}</button>)}
    </nav>
    {tab === 'updates' && <>
      <div className='pg-toolbar' style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px', margin: '10px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, padding: '0 8px', border: `1px solid ${colors.border}`, borderRadius: '8px', color: colors.tertiary, background: colors.surface }}><Icon name='search' /><input aria-label={t('filterPlaceholder')} value={query} onChange={event => { setQuery(event.target.value) }} placeholder={t('filterPlaceholder')} style={{ width: '100%', minWidth: 0, height: '30px', border: 0, outline: 0, background: 'transparent', color: colors.primary, fontSize: '11px' }} /></label>
        {sources.length > 0 && <select className='pg-source-filter' aria-label={t('sourceFilter')} value={source} onChange={event => { setSource(event.target.value) }} style={{ maxWidth: '92px', border: `1px solid ${colors.border}`, borderRadius: '8px', background: colors.surface, color: colors.secondary, fontSize: '11px', padding: '0 4px' }}><option value=''>{t('sourceAll')}</option>{sources.map(value => <option key={value} value={value}>{value}</option>)}</select>}
        <QuietButton part='export-updates' label={t('exportMarkdown')} onClick={() => { exportUpdates(filtered) }}><Icon name='download' /></QuietButton>
      </div>
      {filtered.length === 0 ? <div data-dsh-part='updates-empty' style={{ padding: '28px 8px', textAlign: 'center', color: colors.tertiary }}><strong style={{ display: 'block', color: colors.secondary, fontWeight: 500, marginBottom: '5px' }}>{updates.length === 0 ? t('progressEmptyTitle') : t('filterEmpty')}</strong><span>{updates.length === 0 ? t('progressEmptyHint') : t('filterEmptyHint')}</span></div> : <ol data-dsh-part='updates-list' style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {filtered.map((update, index) => {
          const expanded = expandedIds.has(update.id)
          const latestRow = update.id === latestId
          const bodyId = `pg-body-${index}`
          const previous = filtered[index - 1]
          const newDay = previous === undefined || dayOf(previous.at) !== dayOf(update.at)
          return <li key={update.id} data-dsh-part='update' data-update-id={update.id} style={{ position: 'relative', paddingLeft: '24px', paddingBottom: '10px' }}>
            {newDay && <div style={{ margin: '4px 0 8px -24px', paddingLeft: '24px', color: colors.tertiary, fontSize: '10px', letterSpacing: '.03em' }}>{dayOf(update.at)}</div>}
            <span aria-hidden='true' style={{ position: 'absolute', left: '6px', top: newDay ? '31px' : '7px', bottom: '-5px', width: '1px', background: colors.border }} />
            <span aria-hidden='true' style={{ position: 'absolute', left: '2px', top: newDay ? '35px' : '11px', width: '9px', height: '9px', borderRadius: '50%', background: latestRow ? colors.brand : colors.raised, border: `2px solid ${latestRow ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 35%, transparent)' : colors.tertiary}`, boxShadow: latestRow ? `0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 10%, transparent)` : 'none' }} />
            <article className='pg-update-card' style={{ border: `1px solid ${latestRow ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 26%, transparent)' : colors.border}`, borderRadius: '11px', background: latestRow ? 'linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-brand-primary, #8b9dff) 7%, transparent), transparent)' : colors.surface, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                <button type='button' data-dsh-part='update-header' aria-expanded={expanded} aria-controls={bodyId} aria-label={t(expanded ? 'progressCollapse' : 'progressExpand')} onClick={() => { setExpandedIds(current => { const next = new Set(current); if (next.has(update.id)) next.delete(update.id); else next.add(update.id); return next }) }} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '7px', padding: '10px 4px 10px 10px', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                  <span style={{ marginTop: '3px', color: colors.tertiary, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}><Icon name='arrow' size={11} /></span>
                  <span data-dsh-part='update-title' style={{ flex: 1, minWidth: 0, fontWeight: latestRow ? 600 : 500, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{titleOf(update)}</span>
                  {latestRow && <span data-dsh-part='update-badge' style={{ color: colors.brand, fontSize: '9px', whiteSpace: 'nowrap' }}>{t('progressLatest')}</span>}
                  <time dateTime={dateTimeOf(update.at)} style={{ color: colors.tertiary, fontSize: '10px', whiteSpace: 'nowrap' }}>{clockOf(update.at)}</time>
                </button>
                <button type='button' className='pg-quiet-button' data-dsh-part='update-copy' aria-label={t('copyUpdate')} title={t('copyUpdate')} onClick={() => { void copyText(updateMarkdown(update)).then(ok => { if (!ok) return; setCopiedId(update.id); setTimeout(() => { setCopiedId(current => current === update.id ? undefined : current) }, 1200) }) }} style={{ alignSelf: 'center', marginRight: '5px', padding: '5px', border: 0, borderRadius: '6px', background: 'transparent', color: copiedId === update.id ? colors.success : colors.tertiary, cursor: 'pointer' }}>{copiedId === update.id ? <span style={{ fontSize: '10px' }}>{t('copied')}</span> : <Icon name='copy' size={12} />}</button>
              </div>
              {expanded && <div id={bodyId} data-dsh-part='update-message' style={{ padding: '0 12px 11px 30px', color: colors.secondary, fontSize: '12px', lineHeight: 1.65, overflowWrap: 'anywhere' }}><MarkdownLite text={update.message} /></div>}
            </article>
          </li>
        })}
      </ol>}
    </>}
    {tab === 'tasks' && <div style={{ marginTop: '10px' }}><TaskOverview tasks={tasks} t={t} /></div>}
    {tab === 'archive' && <div style={{ marginTop: '10px' }}><ArchiveView updates={updates} t={t} /></div>}
  </div>
}
