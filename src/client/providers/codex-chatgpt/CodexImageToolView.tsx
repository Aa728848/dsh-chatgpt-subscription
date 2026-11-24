import { useEffect, useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

type Props = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS> & {
  loadImage: ImageLoader
}

/**
 * Aspect ratios recognized when sizing an image tool's placeholder.
 *
 * The value only affects local presentation and is never sent upstream; an
 * unrecognized ratio falls back to the default square.
 */
const IMAGE_ASPECT_RATIOS: ReadonlySet<string> = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  // The extreme strips: banners, headers, phone wallpapers.
  '1:4', '4:1', '1:8', '8:1',
])

/** The model picks its own shape when the call names no ratio; the card guesses square. */
const DEFAULT_IMAGE_ASPECT_RATIO = '1:1'

/** The tray's short side, in px: a hint of the frame, not a billboard. */
const PLACEHOLDER_SHORT_SIDE = 112

export function CodexImageToolView({ block, loadImage, t }: Props): React.JSX.Element {
  const settled = 'kind' in block
  const isError = settled ? block.isError : false
  const images = settled && !isError ? imageBlocks(block.content) : []
  const label = isError ? t('imageToolFailed') : settled ? t('imageToolDone') : t('imageToolRunning')
  const summary = promptFromBlock(block) ?? textSummary(settled ? block.content : [])
  // A running call reserves the tray its image will land in, so the card does
  // not jump from one text row to a full picture when the result arrives. A
  // settled card shows the real images (or nothing, when it failed) instead.
  const tray = settled ? null : placeholderTray(aspectRatioFromBlock(block))
  return <div className="dsh-codex-image-tool" data-state={isError ? 'error' : settled ? 'done' : 'running'}>
    {/* One line, always: the dot and the label keep their size and the prompt
        gives up the width it cannot have. A label that wraps instead turns into
        a vertical stack of single characters in a narrow column. */}
    <div className="dsh-codex-image-tool-head">
      <span className="dsh-codex-image-dot" aria-hidden="true" />
      <span className="dsh-codex-image-title" role="status" aria-live="polite">{label}</span>
      {summary === null ? null : <span className="dsh-codex-image-summary" title={summary}>{summary}</span>}
    </div>
    {images.length > 0 ? <div className="dsh-codex-image-grid">
      {images.map((attachment) => <GeneratedImage key={String(attachment.attachmentId)} attachment={attachment} load={loadImage} label={attachment.name ?? t('image')} t={t} />)}
    </div> : tray === null ? null : <div className="dsh-codex-image-grid">
      <span
        className="dsh-codex-image-placeholder"
        data-ratio={tray.ratio}
        data-short-side={tray.axis}
        style={{ aspectRatio: tray.ratio.replace(':', ' / '), ...tray.size }}
        aria-hidden="true"
      />
    </div>}
  </div>
}

function GeneratedImage({ attachment, load, label, t }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  label: string
  t: Props['t']
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    setSrc(null)
    setFailed(false)
    load(attachment).then((url) => {
      if (!disposed) setSrc(url)
    }, () => {
      if (!disposed) setFailed(true)
    })
    return () => {
      disposed = true
    }
  }, [attachment, load])
  if (failed) return <span className="dsh-codex-image-failed">{t('imageLoadFailed')}</span>
  if (src === null) return <span className="dsh-codex-image-loading">{t('imageLoading')}</span>
  return <img className="dsh-codex-image-preview" src={src} alt={label} />
}

function promptFromBlock(block: Props['block']): string | null {
  return argumentFromBlock(block, 'prompt')
}

/** The tray a running call reserves, and the one dimension it fixes. */
interface Tray {
  /** Which dimension is the fixed short side; the ratio derives the other. */
  readonly axis: 'width' | 'height'
  readonly ratio: string
  readonly size: { width: string } | { height: number }
}

/**
 * Size the tray from one short side and let the ratio derive the other.
 *
 * A portrait frame fixes its height, and its width then stays narrow on its own.
 * A landscape frame — and the 4:1 / 8:1 strips are exactly the case that forced
 * this — fixes its width instead: deriving an 8:1 width from a 112px height
 * would be 896px, which `max-width` would then clamp into a near-square box and
 * the strip would stop looking like a strip. `min(…, 100%)` hands a narrow
 * column back to the card and the height shrinks with it, so the shape survives
 * the clamp.
 */
function placeholderTray(ratio: string): Tray {
  const [w, h] = ratio.split(':').map(Number)
  const landscape = w !== undefined && h !== undefined && w >= h
  // A parse that cannot happen (the ratio came from the whitelist) falls back to
  // the portrait branch rather than inventing a width.
  return landscape
    ? { axis: 'width', ratio, size: { width: `min(${Math.round(PLACEHOLDER_SHORT_SIDE * ((w as number) / (h as number)))}px, 100%)` } }
    : { axis: 'height', ratio, size: { height: PLACEHOLDER_SHORT_SIDE } }
}

/** The placeholder's shape: the call's own ratio when it is one the tool accepts. */
function aspectRatioFromBlock(block: Props['block']): string {
  const ratio = argumentFromBlock(block, 'aspectRatio')?.trim()
  return ratio !== undefined && IMAGE_ASPECT_RATIOS.has(ratio) ? ratio : DEFAULT_IMAGE_ASPECT_RATIO
}

/**
 * One string argument, read from whichever shape the current stage carries.
 *
 * While the arguments are still streaming, the harness hands over a lazy view
 * instead of the JSON, so `args.text(key)` is tried first; once they are
 * complete the same argument comes back as `argsRaw`.
 */
function argumentFromBlock(block: Props['block'], key: string): string | null {
  const partial = partialArgumentFromBlock(block, key)
  if (partial !== null) return partial
  const raw = 'kind' in block ? block.call?.argsRaw : dispatchedArgsRaw(block)
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const found = (value as Record<string, unknown>)[key]
    return typeof found === 'string' ? found : null
  } catch {
    return null
  }
}

function partialArgumentFromBlock(block: Props['block'], key: string): string | null {
  if (!('args' in block)) return null
  const args = block.args as { text?: unknown } | undefined
  if (typeof args?.text !== 'function') return null
  try {
    const value = (args.text as (name: string) => unknown).call(args, key)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * Arguments of a dispatched call that has no result yet.
 *
 * Harness 0.1.7-rc.1 dispatches a view as soon as its call starts *preparing*,
 * before the arguments exist, so the preparing shape carries no `argsRaw` at
 * all. Older generations only ever sent the dispatched shape.
 */
function dispatchedArgsRaw(block: Props['block']): string | undefined {
  return 'argsRaw' in block ? block.argsRaw : undefined
}

/** Pre-0.1.7 tool-result block: a harness that still carries one nests its content here. */
interface LegacyToolResultBlock {
  type: 'tool-result'
  content: readonly ContentBlock[]
}

type ToolViewBlock = ContentBlock | LegacyToolResultBlock

function imageBlocks(blocks: readonly ToolViewBlock[]): ImageAttachmentRef[] {
  const result: ImageAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'image') result.push(block.attachment)
    if (block.type === 'tool-result') result.push(...imageBlocks(block.content))
  }
  return result
}

function textSummary(blocks: readonly ToolViewBlock[]): string | null {
  const text = blocks
    .map((block) => block.type === 'text' || block.type === 'reasoning' ? block.text : '')
    .filter(Boolean)
    .join(' ')
    .trim()
  return text === '' ? null : text
}
