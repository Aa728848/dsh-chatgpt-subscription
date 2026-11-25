import React, { useEffect, useState } from 'react'
import type { PoolAccountQuotaDto, PoolAccountQuotaWindowDto } from '../../../shared/account-pool-contracts.ts'
import { formatAccountDate } from '../../common/AccountPoolSection.tsx'
import { formatPercent } from '../../common/format.ts'
import type { OpenCodeGoDict } from './locales.ts'

interface Props {
  quota?: PoolAccountQuotaDto
  planName?: string | null
  lastUsedAt?: number
  labels: OpenCodeGoDict
}

function isMonthly(window: PoolAccountQuotaWindowDto): boolean { return (window.windowDurationMins ?? 0) >= 43_200 }
function isRolling(window: PoolAccountQuotaWindowDto): boolean { return window.windowDurationMins === 300 }
function isWeekly(window: PoolAccountQuotaWindowDto): boolean { return window.windowDurationMins === 10_080 }
function percent(value: number): string { return formatPercent(Math.max(0, Math.min(100, value))) + '%' }
function ago(t: OpenCodeGoDict, ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return t.kqJustNow
  if (minutes < 60) return t.kqMinutesAgo.replace('{n}', String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t.kqHoursAgo.replace('{n}', String(hours))
  return t.kqDaysAgo.replace('{n}', String(Math.floor(hours / 24)))
}

export function OpenCodeGoQuotaCard({ quota, planName, lastUsedAt, labels: t }: Props): React.JSX.Element {
  const [grown, setGrown] = useState(false)
  const now = Date.now()
  useEffect(() => { const frame = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(frame) }, [])
  if (quota === undefined) return <p className="dsha-muted dshoc-quota-empty">{t.quotaEmpty}</p>
  const windows = quota.windows ?? []
  const monthly = windows.find(isMonthly) ?? windows.find(isWeekly) ?? windows.find(isRolling)
  if (monthly === undefined) return <p className="dsha-muted dshoc-quota-empty">{t.quotaEmpty}</p>
  const rolling = windows.find(isRolling)
  const weekly = windows.find(isWeekly)
  const used = Math.max(0, Math.min(100, monthly.usedPercent))
  const resetAt = monthly.resetsAt
  return <div className="dsha-kq dshoc-quota">
    <div className="dsha-kq-head">
      <span className="dsha-kq-tier">{planName || t.planUnknown}</span>
      <span className="dsha-kq-staff" aria-hidden="true"><i /><i /><i /><i /><i />
        <svg className="dshoc-art" xmlns="http://www.w3.org/2000/svg" width="140" height="64" viewBox="0 0 140 64">
          <g fontFamily="Georgia,'Times New Roman',serif" fontSize="20" fontWeight="400">
            <text x="1" y="26" style={{ '--i': 0 } as React.CSSProperties}>O</text>
            <text x="19" y="26" style={{ '--i': 1 } as React.CSSProperties}>P</text>
            <text x="35" y="26" style={{ '--i': 2 } as React.CSSProperties}>E</text>
            <text x="51" y="26" style={{ '--i': 3 } as React.CSSProperties}>N</text>
            <text x="70" y="26" style={{ '--i': 4 } as React.CSSProperties}>C</text>
            <text x="87" y="26" style={{ '--i': 5 } as React.CSSProperties}>O</text>
            <text x="106" y="26" style={{ '--i': 6 } as React.CSSProperties}>D</text>
            <text x="124" y="26" style={{ '--i': 7 } as React.CSSProperties}>E</text>
          </g>
        </svg>
      </span>
    </div>
    <div className="dsha-kq-total">
      <div className="dsha-kq-row"><span className="dsha-kq-label">{t.kqTotal}</span><span className="dsha-kq-value">{percent(used)} {t.kqUsedSuffix}</span></div>
      <div className="dsha-kq-barwrap" tabIndex={0} aria-label={t.kqTotal + ' ' + percent(used)}>
        <div className="dsha-kq-meter dsha-kq-meter--total"><span className="dsha-kq-seg dsha-kq-seg--recent" style={{ width: grown ? `${used}%` : '0%' }} /></div>
        <span className="dsha-kq-tip" role="tooltip">{t.kqTip.replace('{pct}', percent(used))}</span>
      </div>
      <div className="dsha-kq-legend"><span className="dsha-kq-legend-item"><i className="dsha-kq-dot dsha-kq-dot--recent" />{t.kqUsed.replace('{pct}', percent(used))}</span><span className="dsha-kq-legend-item"><i className="dsha-kq-dot dsha-kq-dot--rest" />{t.kqRest.replace('{pct}', percent(100 - used))}</span>{resetAt !== null && <span className="dsha-kq-reset">{t.kqResetAfter.replace('{time}', formatAccountDate(resetAt))}</span>}</div>
    </div>
    <hr className="dsha-kq-sep" />
    {([rolling, weekly] as const).map((window, index) => window === undefined ? null : <div className="dsha-kq-window" key={index}>
      <div className="dsha-kq-row"><span className="dsha-kq-window-label">{index === 0 ? t.kqWindow5h : t.kqWindowWeekly}</span><span className="dsha-kq-window-pct">{percent(window.usedPercent)}</span></div>
      <div className="dsha-kq-meter"><span className={index === 0 ? 'dsha-kq-seg dsha-kq-seg--recent' : 'dsha-kq-seg dsha-kq-seg--cyan'} style={{ width: grown ? `${Math.max(0, Math.min(100, window.usedPercent))}%` : '0%' }} /></div>
      <div className="dsha-kq-window-meta"><span>{index === 0 ? t.kqRollingNote : t.kqWeeklyNote}</span><span>{window.resetsAt === null ? t.kqNoReset : t.kqResetAfter.replace('{time}', formatAccountDate(window.resetsAt))}</span></div>
    </div>)}
    <div className="dsha-kq-foot"><span>{lastUsedAt === undefined ? t.kqNoLastUsed : t.kqLastUsed.replace('{time}', formatAccountDate(lastUsedAt))}</span><span>{t.kqUpdated.replace('{time}', ago(t, quota.fetchedAt, now))}</span></div>
  </div>
}
