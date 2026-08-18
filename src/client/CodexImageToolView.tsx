import { useEffect, useState } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

export type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>

type Props = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS> & {
  loadImage: ImageLoader
}

export function CodexImageToolView({ block, loadImage, t }: Props): React.JSX.Element {
  const settled = 'kind' in block
  const isError = settled ? block.isError : false
  const prompt = promptFromBlock(block)
  const images = settled && !isError ? imageBlocks(block.content) : []
  const label = isError ? t('imageToolFailed') : settled ? t('imageToolDone') : t('imageToolRunning')
  const summary = prompt ?? textSummary(settled ? block.content : [])
  return <div className="dsh-codex-image-tool" data-state={isError ? 'error' : settled ? 'done' : 'running'}>
    <div className="dsh-codex-image-tool-head">
      <span className="dsh-codex-image-dot" aria-hidden="true" />
      <span className="dsh-codex-image-title">{label}</span>
      {summary !== null ? <span className="dsh-codex-image-summary">{summary}</span> : null}
    </div>
    {images.length > 0 ? <div className="dsh-codex-image-grid">
      {images.map((attachment) => <GeneratedImage key={String(attachment.attachmentId)} attachment={attachment} load={loadImage} label={attachment.name ?? t('image')} t={t} />)}
    </div> : null}
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
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && typeof (value as { prompt?: unknown }).prompt === 'string'
      ? (value as { prompt: string }).prompt
      : null
  } catch {
    return null
  }
}

function imageBlocks(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  const result: ImageAttachmentRef[] = []
  for (const block of blocks) {
    if (block.type === 'image') result.push(block.attachment)
    if (block.type === 'tool-result') result.push(...imageBlocks(block.content))
  }
  return result
}

function textSummary(blocks: readonly ContentBlock[]): string | null {
  const text = blocks
    .map((block) => block.type === 'text' || block.type === 'reasoning' ? block.text : '')
    .filter(Boolean)
    .join(' ')
    .trim()
  return text === '' ? null : text
}
