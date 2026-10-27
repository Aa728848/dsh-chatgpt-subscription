/**
 * Kimi Code 账号卡片里的额度区。
 *
 * 这张卡与其余线路的账号卡是同一张壳（别名、徽标、操作按钮都在 `AccountPoolSection` 里），
 * 换掉的只是额度那一块：档位名用 Georgia 字标，右侧压一条五线谱，音符按档位换成对应的插图。
 *
 * 只有一条进度条，按 Kimi 自己的额度结构折算：7 天额度是 5 个 5 小时额度，月额度是 25 个，
 * 所以「近 5 小时用掉多少」折进大窗口之后是 `5小时% ÷ 5`（月额度则 ÷ 25）。条子上蓝色那一截
 * 就是这段最近的消耗，深色那一截是除此之外的已用，底槽是剩下的。
 *
 * 大窗口的取法：有月额度就用月额度，否则用 7 天；只有 5 小时一条线的账号就直接以它为准。
 * 接口给的是「已用比例」，各窗口各自算各自的，不能相加。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { PoolAccountQuotaDto, PoolAccountQuotaWindowDto } from '../../shared/account-pool-contracts.ts'
import { formatPercent } from '../common/format.ts'
import { STAFF_ART, TIER_ART, type StaffArtKey } from './staff-art.ts'
import type { KimiCodeDict } from './locales.ts'

export interface KimiQuotaCardProps {
  /** 这个账号自己最近一次的额度快照；从未读过时没有。 */
  quota?: PoolAccountQuotaDto
  /** 服务端给的档位名（Adagio … Vivace），决定字标与五线谱。 */
  planName?: string | null
  /** Unix 毫秒：这个账号最后一次真的发过请求。 */
  lastUsedAt?: number
  /** Unix 毫秒：这个账号的令牌到期时间。 */
  expiresAt?: number
  /** 渲染时刻，用来算「N 分钟前更新」。 */
  now: number
  labels: KimiCodeDict
}

/** 5 小时窗口在 7 天窗口里的份数。 */
const SHORT_PER_WEEK = 5
/** 5 小时窗口在月额度里的份数。 */
const SHORT_PER_MONTH = 25
/** 提示条箭头离气泡两端的最小距离，免得圆角把三角切掉。 */
const ARROW_INSET = 12

/** 百分比，最多两位小数；非有限数不画。舍入规则放在共享的 `formatPercent`。 */
function percentText(value: number): string {
  if (!Number.isFinite(value)) return '0%'
  return `${formatPercent(value)}%`
}

/** `YYYY-MM-DD HH:mm`，本地时区；令牌到期用它，年份不能省。 */
function dateText(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `MM-DD HH:mm`，本地时区。 */
function clockText(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function minutesOf(window: PoolAccountQuotaWindowDto): number | null {
  return typeof window.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins)
    ? window.windowDurationMins
    : null
}

/** 5 小时窗口：标签或名义长度任一命中即可。 */
function isShortWindow(window: PoolAccountQuotaWindowDto): boolean {
  if (/^5[- ]?hour/i.test(window.label)) return true
  return minutesOf(window) === 300
}

/** 7 天窗口。 */
function isWeekWindow(window: PoolAccountQuotaWindowDto): boolean {
  if (/weekly|7[- ]?day/i.test(window.label)) return true
  return minutesOf(window) === 10_080
}

/** 月度池——两个独立月额度靠它认出来。 */
function isMonthlyPool(window: PoolAccountQuotaWindowDto): boolean {
  if (/month/i.test(window.label)) return true
  const minutes = minutesOf(window)
  return minutes !== null && minutes >= 43_200
}

/** 档位名 → 插图；认不出来按 Allegretto 那一档。 */
function artKeyFor(planName: string | null | undefined): StaffArtKey {
  const key = (planName ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(TIER_ART, key) ? TIER_ART[key] : 'intermediate'
}

/** 距离重置还有多久：不足一小时只说分钟，整小时不带「0 分钟」。 */
function durationText(labels: KimiCodeDict, remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(remainingMs / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const hourText = labels.kqDurationHour.replace('{n}', String(hours))
  const minuteText = labels.kqDurationMinute.replace('{n}', String(minutes))
  if (hours === 0) return minuteText
  if (minutes === 0) return hourText
  return `${hourText} ${minuteText}`
}

/** 「3 分钟前」这类相对距离，用当前语言的说法拼出来。 */
function agoLabel(labels: KimiCodeDict, ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return labels.kqJustNow
  if (minutes < 60) return labels.kqMinutesAgo.replace('{n}', String(minutes))
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return labels.kqHoursAgo.replace('{n}', String(hours))
  return labels.kqDaysAgo.replace('{n}', String(Math.floor(hours / 24)))
}

export function KimiQuotaCard(props: KimiQuotaCardProps): React.ReactElement {
  const t = props.labels
  const quota = props.quota
  const windows = quota?.windows ?? []

  const planName = (props.planName ?? '').trim()
  const art = STAFF_ART[artKeyFor(planName)]

  const used = (window: PoolAccountQuotaWindowDto | null): number =>
    window !== null && Number.isFinite(window.usedPercent) ? window.usedPercent : 0

  const shortWindow = windows.find(isShortWindow) ?? null
  const monthlyWindow = windows.find(isMonthlyPool) ?? null
  const weekWindow = windows.find(isWeekWindow) ?? null

  // 大窗口：月额度优先，其次 7 天，最后只能拿 5 小时自己当基准。
  const carrier = monthlyWindow ?? weekWindow ?? shortWindow
  const factor = monthlyWindow !== null
    ? SHORT_PER_MONTH
    : weekWindow !== null ? SHORT_PER_WEEK : 1

  // 条子画的是哪一个窗口，标题就照那个窗口说：老套餐只有 7 天，写成「总使用量」会
  // 让人以为看到了整个周期；有月额度时，它才真的是这个周期的总量。
  const headline = monthlyWindow !== null
    ? t.kqTotal
    : weekWindow !== null ? t.kqWindow7d : t.kqWindow5h

  const totalPercent = Math.min(100, used(carrier))
  // 近 5 小时的消耗折进大窗口；它不会超过大窗口已用的部分（5 小时本来就包含在 7 天里）。
  // 两截都收到两位小数，否则 18 − 17.8 会以 0.1999999999999993 的形式量进宽度里。
  const recentPercent = Math.round(Math.min(totalPercent, used(shortWindow) / factor) * 100) / 100
  const restPercent = Math.round(Math.max(0, totalPercent - recentPercent) * 100) / 100

  const resetAt = carrier !== null && typeof carrier.resetsAt === 'number' && Number.isFinite(carrier.resetsAt)
    ? carrier.resetsAt
    : null

  const lastUsed = props.lastUsedAt
  const expires = props.expiresAt

  const shortReset = shortWindow !== null && typeof shortWindow.resetsAt === 'number' &&
    Number.isFinite(shortWindow.resetsAt)
    ? shortWindow.resetsAt
    : null

  // 这个倒计时按分钟说话，而外层传进来的 `now` 只在有冷却时才走表——不自己滴答，
  // 数字会停在打开页面那一刻。30 秒一跳足够，且只在窗口还没重置时转。
  // 条子从 0 长出来。先渲染 0 宽，effect 里再换成目标宽度，浏览器才会补出那段过渡；
  // 只在挂载时走一次，之后每 60 秒的刷新直接落位，不会闪。
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    // 先让浏览器把 0 宽那一帧画出来，再换成目标宽度，过渡才有起点。
    const frame = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const [clock, setClock] = useState(() => props.now)
  useEffect(() => {
    if (shortReset === null) return undefined
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [shortReset])

  // 提示条挂在这条进度条上，而不是挂在卡片边上：它说的是这条条子的数字，
  // 所以压在「已用」那一段的末端——原先固定右对齐，箭头落在 41% 满的条子的
  // 92% 处，指向哪里都不对。靠近两端时半截气泡会跑出卡片，于是按气泡宽度
  // 往回收；箭头不跟着回，它单独挪到「已用段末端」在气泡里的位置，所以哪怕
  // 气泡被推回来，指的还是那个数字所在的地方。
  const tipPercent = Math.max(0, Math.min(100, totalPercent))
  const barRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const [tipPlacement, setTipPlacement] = useState({ shift: 0, arrowPx: null as number | null })
  useEffect(() => {
    const wrap = barRef.current
    const tip = tipRef.current
    if (wrap === null || tip === null) return undefined
    const place = (): void => {
      const width = wrap.clientWidth
      const bubble = tip.offsetWidth
      // 布局还没发生（首帧、jsdom）时不做推断：0 位移就是「压在末端」，箭头走
      // CSS 里的 50% 兜底，也就是气泡正中。
      if (width <= 0 || bubble <= 0) {
        setTipPlacement({ shift: 0, arrowPx: null })
        return
      }
      const half = bubble / 2
      const anchor = (width * tipPercent) / 100
      const clamped = Math.min(Math.max(anchor, half), Math.max(half, width - half))
      // 箭头离气泡两端至少留 ARROW_INSET，否则圆角会把三角切掉。
      const arrow = Math.min(Math.max(anchor - (clamped - half), ARROW_INSET), bubble - ARROW_INSET)
      // 十位小数取整：亚像素抖动会让 effect 反复触发，视觉上却毫无差别。
      setTipPlacement({
        shift: Math.round((clamped - anchor) * 10) / 10,
        arrowPx: Math.round(arrow * 10) / 10,
      })
    }
    place()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(place)
    observer.observe(wrap)
    observer.observe(tip)
    return () => observer.disconnect()
  }, [tipPercent])

  return (
    <div className="dsha-kq">
      <div className="dsha-kq-head">
        <span className="dsha-kq-tier">{planName || t.planUnknown}</span>
        <span className="dsha-kq-staff" aria-hidden="true">
          <i /><i /><i /><i /><i />
          <svg className="dsha-kq-art" xmlns="http://www.w3.org/2000/svg" width="120" height="64" fill="none">
            {art.map((stroke, index) => (
              <path
                key={index}
                fill="currentColor"
                {...(stroke.opacity === undefined ? {} : { fillOpacity: stroke.opacity })}
                style={{ '--i': index } as React.CSSProperties}
                d={stroke.d}
              />
            ))}
          </svg>
        </span>
      </div>

      {carrier === null ? (
        <p className="dsha-muted dsha-kq-blank">{t.quotaNone}</p>
      ) : (
        <div className="dsha-kq-total">
          <div className="dsha-kq-row">
            <span className="dsha-kq-label">{headline}</span>
            <span className="dsha-kq-value">{percentText(totalPercent)}</span>
          </div>
          <div
            className="dsha-kq-barwrap"
            ref={barRef}
            style={{ '--kq-tip-x': `${tipPercent}%` } as React.CSSProperties}
          >
            <div className="dsha-kq-meter dsha-kq-meter--total">
              <span
                className="dsha-kq-seg dsha-kq-seg--recent"
                data-target={Math.max(0, Math.min(100, recentPercent))}
                style={{ width: `${grown ? Math.max(0, Math.min(100, recentPercent)) : 0}%` }}
              />
              <span
                className="dsha-kq-seg dsha-kq-seg--rest"
                data-target={Math.max(0, Math.min(100, restPercent))}
                style={{ width: `${grown ? Math.max(0, Math.min(100, restPercent)) : 0}%` }}
              />
            </div>
            <span
              className="dsha-kq-tip"
              role="tooltip"
              ref={tipRef}
              style={{
                '--kq-tip-shift': `${tipPlacement.shift}px`,
                ...(tipPlacement.arrowPx === null ? {} : { '--kq-tip-arrow': `${tipPlacement.arrowPx}px` }),
              } as React.CSSProperties}
            >
              {t.kqTip.replace('{pct}', percentText(totalPercent))}
            </span>
          </div>
          <div className="dsha-kq-legend">
            {shortWindow !== null && (
              <span className="dsha-kq-legend-item">
                <i className="dsha-kq-dot dsha-kq-dot--recent" />
                {t.kqShortWindow.replace('{pct}', percentText(used(shortWindow)))}
                {shortReset !== null && (
                  <span className="dsha-kq-legend-note">
                    {shortReset > clock
                      ? t.kqResetIn.replace('{time}', durationText(t, shortReset - clock))
                      : t.kqResetSoon}
                  </span>
                )}
              </span>
            )}
            <span className="dsha-kq-legend-item">
              <i className="dsha-kq-dot dsha-kq-dot--rest" />
              {t.kqRestUsed}
            </span>
            {resetAt !== null && (
              <span className="dsha-kq-reset">{t.kqResetAfter.replace('{time}', clockText(resetAt))}</span>
            )}
          </div>
        </div>
      )}

      <div className="dsha-kq-foot">
        <span className="dsha-kq-foot-left">
          {lastUsed !== undefined && Number.isFinite(lastUsed) && lastUsed > 0 && (
            <span>{t.kqLastUsed.replace('{time}', clockText(lastUsed))}</span>
          )}
          {quota !== undefined && (
            <span>{t.kqAgo.replace('{time}', agoLabel(t, quota.fetchedAt, props.now))}</span>
          )}
        </span>
        {expires !== undefined && Number.isFinite(expires) && expires > 0 && (
          <span className="dsha-kq-expires">{t.kqExpires.replace('{time}', dateText(expires))}</span>
        )}
      </div>
    </div>
  )
}
