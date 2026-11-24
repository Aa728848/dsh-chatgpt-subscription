/**
 * 视频字节 → `<video>` 的那一段：对象 URL 的生命周期，以及两个界面共用的
 * 「视频台」外框。
 *
 * ## 为什么对象 URL 必须由这里管
 *
 * `URL.createObjectURL` 生成的地址把整段字节钉在内存里，直到显式
 * `revokeObjectURL`。视频动辄几十 MB，漏一次就是一次长期泄漏；而 `<video>` 一旦
 * 拿到 `src` 又会自己缓存。所以生命周期只写在 `useObjectUrl` 里一处：
 * 字节变了就换新地址并撤旧的，组件卸载就撤当前的。
 *
 * ## 为什么两个界面共用一个外框
 *
 * 对话流卡片只有约 520px 宽，侧边栏是全尺寸，两者尺寸差一倍——但观众看到的应该
 * 是**同一个东西的两个尺寸**，不是两套设计。所以 16:9 的视频台只定义一次
 * （`.dshm-video-stage`），两处都渲染 {@link VideoStage}，差别只剩容器的宽度。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-media
 */

import { useEffect, useState } from 'react'

/**
 * 把一段字节变成一个可播放的对象 URL，并在字节变化或组件卸载时撤销它。
 *
 * 失败（浏览器不支持 Blob URL、或构造抛错）时返回 `failed`，由调用方把占位块
 * 的文字换成失败措辞——**不抛异常**：一块视频读不出来，不该把整段对话流带崩。
 *
 * @param data - 视频字节；`undefined` 表示还没拿到。
 * @param mediaType - Blob 的 MIME 类型，如 `video/mp4`。
 * @returns 就绪时的 `url`，或 `failed`，或两者皆无（仍在等字节）。
 */
export function useObjectUrl(data: Uint8Array | undefined, mediaType: string): { url: string | null, failed: boolean } {
  const [source, setSource] = useState<{ url: string | null, failed: boolean }>({ url: null, failed: false })
  useEffect(() => {
    if (data === undefined) {
      setSource({ url: null, failed: false })
      return
    }
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
    } catch {
      setSource({ url: null, failed: true })
      return
    }
    setSource({ url, failed: false })
    return () => {
      URL.revokeObjectURL(url as string)
    }
  }, [data, mediaType])
  return source
}

/** 占位态：给一段安静的说明，失败时才换成 danger 色。 */
export interface VideoStagePlaceholder {
  /** 占位块里的一行字（中文最多两句、结尾不加句号）。 */
  readonly text: string
  /** `quiet` 走三级墨色，`danger` 只在真的失败时用。 */
  readonly tone: 'quiet' | 'danger'
}

/** 两个界面共用的视频台外框。 */
export interface VideoStageProps {
  /** 就绪时的对象 URL；`null` 表示还在占位。 */
  readonly url: string | null
  /** 占位时显示什么；就绪时忽略。 */
  readonly placeholder: VideoStagePlaceholder
  /** `<video>` 的无障碍名。 */
  readonly label: string
}

/**
 * 16:9 的视频台：深色底、发丝线、letterbox。
 *
 * 就绪时是 `<video controls preload="metadata">`（`preload="metadata"` 让浏览器
 * 先拿时长与首帧，而不是立刻开始整段下载）；否则是同一个外框的虚线形态，
 * 里面一行 tertiary 说明。**失败时外框不变**——数据仍在屏幕上，只是它读不出来。
 *
 * @param props - 对象 URL、占位文案与无障碍名。
 * @returns 视频台。
 */
export function VideoStage({ url, placeholder, label }: VideoStageProps): React.JSX.Element {
  return (
    <div className="dshm-video-stage" data-state={url === null ? 'empty' : 'ready'}>
      {url === null
        ? <span className="dshm-video-placeholder" data-tone={placeholder.tone}>{placeholder.text}</span>
        : <video className="dshm-video-el" src={url} controls preload="metadata" aria-label={label} />}
    </div>
  )
}
