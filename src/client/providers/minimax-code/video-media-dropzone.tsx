/**
 * 参考媒体的**输入区**：浏览、拖拽、粘贴三个入口共用一个落脚点。
 *
 * ## 为什么是一个自建组件而不是三个输入框
 *
 * 参数面板里四类参考媒体（首帧、末帧、参考图/视频/音频）此前是四排纯文本框，
 * 用户要自己去资源管理器里复制路径。现在每一类都变成一块「媒体块」：一条条已收下
 * 的路径显示成可移除的标签，右上角是「浏览…」，整块可以拖入文件，也可以直接
 * 粘贴路径或链接。
 *
 * ## 「浏览」为什么用 `<input type="file">`
 *
 * 桌面端没有向网页暴露「选文件」的原生对话框 IPC（只有目录选择器）。而浏览器
 * 自带的 `<input type="file">` 在桌面端同样能拿到文件对象——本机路径由宿主桥
 * `__DSH_HOST_PATHS__.pathFor` 还原。网页端拿不到路径时如实提示，而不是让用户
 * 以为已经加上了。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-media-dropzone
 */

import { useCallback, useRef, useState } from 'react'
import {
  EMPTY_INTAKE,
  intakeFromFiles,
  intakeFromText,
  mediaNameOf,
  mergeIntake,
  type MediaIntake,
} from './video-media-input.ts'
import type { WorkspaceEntry, WorkspaceLister } from './video-workspace.ts'
import { joinWorkspacePath } from './video-workspace.ts'
import type { MinimaxCodeLocaleKey } from './locales.ts'

/** 翻译座位（与 VideoFormDialog 同一形状）。 */
type Translate = (key: MinimaxCodeLocaleKey, params?: Record<string, string | number>) => string

/** 媒体块的入参。 */
export interface MediaDropZoneProps {
  /** 区块标题。 */
  readonly label: string
  /** 已收下的路径，按顺序。 */
  readonly paths: readonly string[]
  /** 路径整组变化（拖入、粘贴、浏览、移除都走这里）。 */
  readonly onChange: (paths: readonly string[]) => void
  /** 浏览按钮接受的类型，如 `image/*`。 */
  readonly accept: string
  /** 输入元素的 id，用于标签关联。 */
  readonly id: string
  /** 翻译。 */
  readonly t: Translate
  /** 额外的一行说明（可选）。 */
  readonly hint?: string
  /** 是否允许多选；首帧/末帧只有一格，所以那里传 false。 */
  readonly multiple?: boolean
  /**
   * 列出某个工作区目录的子项，供 `@` 补全。
   *
   * 缺席（宿主没装 remote、或还没挂载）时就只是没有候选列表：输入照样能填路径。
   */
  readonly listWorkspace?: WorkspaceLister | undefined
}

/**
 * 一块媒体输入：已收下的条目 + 浏览按钮 + 拖拽与粘贴。
 *
 * @param props - 标题、当前路径、变更回调、接受的类型。
 * @returns 媒体块。
 */
export function MediaDropZone({
  label, paths, onChange, accept, id, t, hint, multiple = true, listWorkspace,
}: MediaDropZoneProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [manual, setManual] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<readonly WorkspaceEntry[]>([])
  const input = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const apply = useCallback((intake: MediaIntake) => {
    if (intake.paths.length > 0) {
      const next: string[] = [...paths]
      for (const path of intake.paths) if (!next.includes(path)) next.push(path)
      onChange(next)
    }
    if (intake.rejectedUrls.length > 0) setNotice(t('videoMediaUrlRejected'))
    else if (intake.withoutPath > 0) setNotice(t('videoMediaNoPath'))
    else if (intake.paths.length > 0) setNotice(null)
  }, [onChange, paths, t])

  /**
   * 输入变化时刷新 `@` 候选。
   *
   * 规则只有一条：**光标所在的这一行**以 `@` 开头才算引用；`@` 后面到行尾就是
   * 目录片段。没有 lister（宿主没装 remote）时直接清空候选——输入框本身照常可用。
   */
  const refreshSuggestions = useCallback((value: string) => {
    const at = value.lastIndexOf('@')
    if (at === -1 || (at > 0 && !/\s/.test(value.charAt(at - 1)))) { setSuggestions([]); return }
    const fragment = value.slice(at + 1)
    // 片段里出现空白就不是在选文件了，别拿它去列目录。
    if (/\s/.test(fragment)) { setSuggestions([]); return }
    const slash = fragment.lastIndexOf('/')
    const directory = slash === -1 ? '' : fragment.slice(0, slash)
    const needle = (slash === -1 ? fragment : fragment.slice(slash + 1)).toLowerCase()
    if (listWorkspace === undefined) { setSuggestions([]); return }
    let cancelled = false
    void listWorkspace(directory).then((entries) => {
      if (cancelled) return
      setSuggestions(entries
        .filter(entry => entry.name.toLowerCase().includes(needle))
        .slice(0, 8))
    })
    return () => { cancelled = true }
  }, [listWorkspace])

  /** 把一条候选写回输入框，替换掉行内的 `@片段`。 */
  const acceptSuggestion = useCallback((entry: WorkspaceEntry) => {
    const at = manual.lastIndexOf('@')
    const head = at === -1 ? manual : manual.slice(0, at)
    setManual(head + '@' + entry.path + (entry.directory ? '/' : ''))
    setSuggestions([])
    if (!entry.directory) {
      apply(intakeFromText(head + '@' + entry.path))
      setManual('')
    }
    input.current?.focus()
  }, [manual, apply])

  const remove = useCallback((path: string) => {
    onChange(paths.filter(entry => entry !== path))
    setNotice(null)
  }, [onChange, paths])

  return (
    <div className="dshm-media-block" id={id}>
      <div className="dshm-media-head">
        <span className="dshm-media-label">{label}</span>
        <button
          type="button"
          className="dshm-media-browse"
          onClick={() => { input.current?.click() }}
        >
          {t('videoMediaBrowse')}
        </button>
        <input
          ref={input}
          className="dshm-media-file"
          type="file"
          accept={accept}
          multiple={multiple}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = event.currentTarget.files
            if (files !== null && files.length > 0) apply(mergeIntake(EMPTY_INTAKE, intakeFromFiles([...files])))
            // 同一个文件连选两次也要能触发 change。
            event.currentTarget.value = ''
          }}
        />
      </div>

      {/*
        拖拽区与输入栏是**同一个框**：已收下的标签在上，输入行贴在框底。分开时
        用户得先判断「这次该用哪一处」，而它们本来就收同一种东西。
      */}
      <div
        className="dshm-media-well"
        data-dragging={dragging ? 'true' : 'false'}
        data-empty={paths.length === 0 ? 'true' : 'false'}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('text/plain')) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('text/plain')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          const files = [...event.dataTransfer.files]
          const intake = files.length > 0
            ? intakeFromFiles(files)
            : intakeFromText(event.dataTransfer.getData('text/plain'))
          apply(intake)
        }}
        role="group"
        aria-label={label}
      >
        {paths.length > 0 && (
          <ul className="dshm-media-items">
            {paths.map(path => (
              <li className="dshm-media-item" key={path}>
                <span className="dshm-media-item-name" title={path}>{mediaNameOf(path)}</span>
                <button
                  type="button"
                  className="dshm-media-remove"
                  aria-label={t('videoMediaRemove', { name: mediaNameOf(path) })}
                  onClick={() => { remove(path) }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="dshm-media-entry"
          onSubmit={(event) => {
            event.preventDefault()
            const typed = manual.trim()
            if (typed === '') return
            apply(intakeFromText(typed))
            setManual('')
            setSuggestions([])
          }}
        >
          <input
            ref={input}
            className="dshm-media-entry-input"
            type="text"
            value={manual}
            placeholder={dragging
              ? t('videoMediaDragActive')
              : (paths.length === 0 ? t('videoMediaManualPlaceholder') : t('videoMediaAddMore'))}
            aria-label={label}
            onChange={(event) => {
              const value = event.currentTarget.value
              setManual(value)
              setNotice(null)
              refreshSuggestions(value)
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text/plain')
              if (text.trim() === '') return
              event.preventDefault()
              apply(intakeFromText(text))
              setManual('')
              setSuggestions([])
            }}
            onBlur={() => {
              // 候选项用 mousedown 抢在 blur 之前落地，这里稍等一拍再收。
              window.setTimeout(() => { setSuggestions([]) }, 120)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // 先收候选，再谈关闭面板：正在选文件时按 Escape 不该把面板关掉。
                if (suggestions.length > 0) {
                  event.stopPropagation()
                  setSuggestions([])
                }
                return
              }
              if (event.key === 'Tab' && suggestions.length > 0) {
                event.preventDefault()
                acceptSuggestion(suggestions[0])
              }
            }}
          />
          <button
            type="submit"
            className="dshm-media-add"
            aria-label={t('videoMediaAdd')}
            disabled={manual.trim() === ''}
          >
            {t('videoMediaAdd')}
          </button>
        </form>

        {suggestions.length > 0 && (
          <ul className="dshm-media-suggest" role="listbox" aria-label={t('videoMediaSuggestLabel')}>
            {suggestions.map(entry => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="dshm-media-suggest-item"
                  role="option"
                  aria-selected="false"
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { acceptSuggestion(entry) }}
                >
                  <span className="dshm-media-suggest-name">{entry.name}{entry.directory ? '/' : ''}</span>
                  {entry.directory && <span className="dshm-media-suggest-kind">{t('videoMediaSuggestFolder')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {hint !== undefined && <span className="dshm-video-hint">{hint}</span>}
      {notice !== null && <span className="dshm-video-hint" data-tone="danger" role="status">{notice}</span>}
    </div>
  )
}
