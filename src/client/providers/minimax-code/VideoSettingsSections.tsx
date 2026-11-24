/**
 * 设置页里的两个视频分区：**默认参数**与**生成历史**。
 *
 * 视觉语言逐条照抄 `MinimaxCodeSection.tsx` 的既有分区（`.dsha-group` /
 * `.dsha-grouphead` / `.dsha-row` / `.dsha-muted` / `.dsha-btn`），不新增任何
 * 颜色、字号刻度或字重。
 *
 * ## 一次加载只用一个加载态
 *
 * 历史是**列表**，所以它的加载态是骨架（`.dshm-video-skeleton` 三条灰条）；
 * 默认参数不是列表，它直接从 localStorage 同步读出来，根本没有加载态。这条是
 * `dsh-client-ui-ux` 的硬约束：列表用骨架、其他用裸 spinner，且**不写 loading 文案**。
 *
 * ## 破坏性操作保留数据
 *
 * 读历史失败时**不清空已经拿到的行**：上一次成功的列表留在屏幕上，只在上方加一句
 * 提示（`videoHistoryUnavailable`）。清空会让一次网络抖动看起来像「历史被删了」。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/VideoSettingsSections
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatDuration } from './video-contract.ts'
import {
  MINIMAX_VIDEO_MODELS,
  MINIMAX_VIDEO_RATIOS,
  durationChoices,
  defaultResolution,
  normalizeVideoDefaults,
  videoModelRule,
  type MinimaxVideoModel,
  type MinimaxVideoRatio,
  type VideoDefaults,
} from './video-form-rules.ts'
import { get, messageOf } from './api.ts'
import type { MinimaxCodeLocaleKey } from './locales.ts'

/** 翻译函数座位。 */
export type SectionTranslate = (key: MinimaxCodeLocaleKey, params?: Record<string, string | number>) => string

/** 宿主 `GET /minimax-code/api/video-history` 的载荷。 */
export interface VideoHistoryDto {
  readonly entries: readonly VideoHistoryEntryDto[]
  readonly storagePath: string
  readonly encryptedAtRest: boolean
}

/** 一行生成记录。 */
export interface VideoHistoryEntryDto {
  readonly createdAtMs: number
  readonly model: string
  readonly ratio?: string
  readonly durationSeconds?: number
  readonly videoPath: string
  readonly bytes: number
  readonly taskId: string
}

/**
 * 校验一份历史载荷。
 *
 * 宿主那一半可能比浏览器这一半旧（同样的「两半不同版本」问题 `line-api.ts` 开头
 * 那一大段注释在讲），所以每一行都逐字段过一遍，坏行**丢掉**而不是让整个列表渲染成
 * 一堆 `undefined`。
 *
 * @param value - 路由的 `value`。
 * @returns 规范化后的载荷。
 */
export function parseVideoHistoryDto(value: unknown): VideoHistoryDto {
  if (typeof value !== 'object' || value === null) {
    return { entries: [], storagePath: '', encryptedAtRest: false }
  }
  const record = value as Record<string, unknown>
  const entries: VideoHistoryEntryDto[] = []
  if (Array.isArray(record.entries)) {
    for (const raw of record.entries) {
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      if (typeof row.createdAtMs !== 'number' || !Number.isFinite(row.createdAtMs)) continue
      if (typeof row.model !== 'string' || row.model === '') continue
      if (typeof row.videoPath !== 'string' || row.videoPath === '') continue
      if (typeof row.bytes !== 'number' || !Number.isFinite(row.bytes)) continue
      if (typeof row.taskId !== 'string') continue
      entries.push({
        createdAtMs: row.createdAtMs,
        model: row.model,
        videoPath: row.videoPath,
        bytes: row.bytes,
        taskId: row.taskId,
        ...(typeof row.ratio === 'string' && row.ratio !== '' ? { ratio: row.ratio } : {}),
        ...(typeof row.durationSeconds === 'number' && Number.isFinite(row.durationSeconds)
          ? { durationSeconds: row.durationSeconds }
          : {}),
      })
    }
  }
  return {
    entries,
    storagePath: typeof record.storagePath === 'string' ? record.storagePath : '',
    encryptedAtRest: record.encryptedAtRest === true,
  }
}

/**
 * 生成历史分区。
 *
 * 数据只来自宿主路由：浏览器侧没有任何事件能知道「刚刚生成了一段视频」——那次调用发
 * 生在宿主的工具执行里。所以这份列表是**主动去读**的，第一次挂载读一次，用户可以
 * 手动刷新。
 */
export function VideoHistorySection({ t }: { readonly t: SectionTranslate }): React.JSX.Element {
  const [data, setData] = useState<VideoHistoryDto | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 卸载后不再 setState：一次慢请求在组件走后落地是最常见的 React 警告来源。
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const value = await get<VideoHistoryDto>('/video-history')
      if (!alive.current) return
      setData(parseVideoHistoryDto(value))
      setFailure(null)
    } catch (error) {
      if (!alive.current) return
      // 不清空 data：上一次成功的列表留着，只在上面加一句提示。
      setFailure(messageOf(error))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const rows = useMemo(() => data?.entries ?? [], [data])

  return (
    <section className="dsha-group">
      <div className="dsha-grouphead">
        <h3>{t('videoHistorySection')}</h3>
        <button className="dsha-btn" disabled={loading} onClick={() => { setLoading(true); void load() }}>
          {loading ? t('videoHistoryRefreshing') : t('videoHistoryRefresh')}
        </button>
      </div>
      <p className="dsha-muted">{t('videoHistoryHint')}</p>

      {failure !== null && <p className="dsha-notice">{t('videoHistoryUnavailable')}</p>}

      {loading && data === null
        ? (
          // 列表的加载态：骨架，不是 loading 文案。
          <div className="dshm-video-skeleton" aria-hidden="true">
            <span /><span /><span />
          </div>
        )
        : rows.length === 0
          ? <div className="dsha-empty">{t('videoHistoryEmpty')}</div>
          : (
            <div className="dshm-video-history">
              {rows.map(entry => (
                <div className="dsha-row" key={entry.taskId + ':' + String(entry.createdAtMs)}>
                  <span className="dshm-video-history-path dshm-mono" title={entry.videoPath}>
                    {entry.videoPath}
                  </span>
                  <span className="dsha-value dshm-video-history-meta">
                    {t('videoHistoryMeta', {
                      model: entry.model,
                      ratio: entry.ratio ?? t('videoHistoryNoRatio'),
                      duration: entry.durationSeconds === undefined ? t('unknown') : formatDuration(entry.durationSeconds),
                      size: formatBytes(entry.bytes),
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}

      {data !== null && data.storagePath !== '' && (
        <>
          <p className="dsha-muted dshm-quota-note">{t('videoHistoryStorage', { path: data.storagePath })}</p>
          <p className="dsha-muted">
            {data.encryptedAtRest ? t('videoHistoryEncrypted') : t('videoHistoryPlain')}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * 默认参数分区。
 *
 * 改动立即写回，不设保存按钮：这四项都只是 `/video` 表单的起手值，没有「暂存」与
 * 「已生效」的区别要表达；一个保存按钮反而会让用户以为不点就不生效。
 */
export function VideoDefaultsSection({ t, initial, onSave }: {
  readonly t: SectionTranslate
  readonly initial: VideoDefaults
  readonly onSave: (next: VideoDefaults) => boolean
}): React.JSX.Element {
  const [defaults, setDefaults] = useState<VideoDefaults>(() => normalizeVideoDefaults(initial))
  const [notice, setNotice] = useState<string | null>(null)

  const apply = useCallback((next: VideoDefaults) => {
    // 模型换了就把时长/分辨率拉回该模型自己的合法集，理由与弹窗里那次一致。
    const normalized = normalizeVideoDefaults(next)
    setDefaults(normalized)
    setNotice(onSave(normalized) ? t('videoDefaultsSaved') : null)
  }, [onSave, t])

  const rule = videoModelRule(defaults.model)
  const durations = durationChoices(defaults.model)
  // 纯文本分支：`adaptive` 不可选，与弹窗里的比例栏同一条规则。
  const ratios = MINIMAX_VIDEO_RATIOS.filter(entry => entry !== 'adaptive')

  return (
    <section className="dsha-group">
      <div className="dsha-grouphead">
        <h3>{t('videoDefaultsSection')}</h3>
      </div>
      <p className="dsha-muted">{t('videoDefaultsHint')}</p>

      <div className="dsha-row">
        <span className="dsha-label">{t('videoModelLabel')}</span>
        <select
          className="dsha-select"
          aria-label={t('videoModelLabel')}
          value={defaults.model}
          onChange={(event) => {
            const model = event.currentTarget.value as MinimaxVideoModel
            apply({
              ...defaults,
              model,
              // `normalizeVideoDefaults` 会把不合法的时长换掉，所以这里原样带过去。
            })
          }}
        >
          {MINIMAX_VIDEO_MODELS.map(entry => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </div>

      <div className="dsha-row">
        <span className="dsha-label">{t('videoDurationLabel')}</span>
        <select
          className="dsha-select"
          aria-label={t('videoDurationLabel')}
          value={defaults.durationSeconds === undefined ? '' : String(defaults.durationSeconds)}
          onChange={(event) => {
            const value = Number(event.currentTarget.value)
            apply({ ...defaults, durationSeconds: Number.isFinite(value) ? value : undefined })
          }}
        >
          {durations.map(value => (
            <option key={value} value={String(value)}>{value} {t('videoDurationUnit')}</option>
          ))}
        </select>
      </div>

      <div className="dsha-row">
        <span className="dsha-label">{t('videoRatioLabel')}</span>
        <select
          className="dsha-select"
          aria-label={t('videoRatioLabel')}
          value={defaults.ratio ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value
            const ratio = ratios.find(entry => entry === value) as MinimaxVideoRatio | undefined
            apply({ ...defaults, ratio })
          }}
        >
          {ratios.map(entry => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </div>

      <div className="dsha-row">
        <label className="dsha-label" htmlFor="dshm-video-default-watermark">{t('videoWatermarkLabel')}</label>
        <input
          id="dshm-video-default-watermark"
          type="checkbox"
          checked={defaults.watermark}
          onChange={(event) => { apply({ ...defaults, watermark: event.currentTarget.checked }) }}
        />
      </div>

      {rule !== undefined && (
        <p className="dsha-muted dshm-quota-note">
          {t('videoResolutionLabel')}: {defaultResolution(defaults.model) ?? t('unknown')}
        </p>
      )}
      {notice !== null && <p className="dsha-muted" role="status">{notice}</p>}
    </section>
  )
}
